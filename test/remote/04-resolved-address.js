// RC1-min plan step 2b (spec, Security, round 2): a name that resolves to a
// loopback, private or Redis-endpoint address is refused by the client's own
// lookup, before the socket opens. The literal check at load (01) cannot see
// it: the URL names a host, and only resolution says where it is.
const assert = require('assert');
const net    = require('net');
const {parseRemotes} = require('../../lib/remote/declaration');
const {createRemoteClient} = require('../../lib/remote/client');
const {guardedLookup} = require('../../lib/remote/fetch');

const PORT = 9687;
// A hosts-style name, resolved by an injected resolver as /etc/hosts would.
const resolverFor = (map) => (hostname, options, cb) => {
  const address = map[hostname];
  if (address == null) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {code: 'ENOTFOUND'}));
  const entry = {address: address, family: net.isIPv6(address) ? 6 : 4};
  return (options != null && options.all) ? cb(null, [entry]) : cb(null, entry.address, entry.family);
};
const remoteAt = (url, debug) => {
  const r = parseRemotes({countinghouse: {remotes: [{name: 'probe', transport: 'streamable-http', url: url}]}},
    {debug: debug, redisEndpoint: {host: '127.0.0.1', port: 6379}});
  assert.deepStrictEqual(r.problems, []);
  return r.remotes[0];
};

describe('remote 04: the resolved-address check', function() {
  this.timeout(30000);

  it('a name that resolves to 127.0.0.1 is refused before the socket opens, with debug off', async () => {
    let reached = 0;
    const listener = net.createServer((s) => { reached += 1; s.destroy(); });
    await new Promise((resolve) => listener.listen(PORT, '127.0.0.1', resolve));
    const c = createRemoteClient(remoteAt(`https://remote.test:${PORT}/mcp`, false), null,
      {timeoutMs: 5000, maxBytes: 1024, debug: false, redisEndpoint: {host: '127.0.0.1', port: 6379},
        resolve: resolverFor({'remote.test': '127.0.0.1'})});
    try {
      const e = await c.call('echo_text', {}).then(() => null, (err) => err);
      assert.strictEqual(e && e.code, 'REMOTE_ADDRESS_REFUSED', e && e.message);
      assert.ok(e.message.includes('remote.test') && e.message.includes('127.0.0.1'), e.message);
      assert.strictEqual(reached, 0);
    } finally {
      await c.close();
      await new Promise((resolve) => listener.close(resolve));
    }
  });

  const lookupWith = (address, opts) => new Promise((resolve) => guardedLookup(resolverFor({'remote.test': address}), opts)(
    'remote.test', {all: true}, (err, addresses) => resolve(err != null ? err.remoteCode : addresses.map((a) => a.address))));

  it('refuses private, mapped and link-local answers, and passes a public one', async () => {
    const off = {debug: false, port: 443, redisEndpoint: {host: '127.0.0.1', port: 6379}};
    for (const address of ['10.0.0.5', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fd00::1', '169.254.169.254', '100.100.100.200']) {
      assert.strictEqual(await lookupWith(address, off), 'REMOTE_ADDRESS_REFUSED', address);
    }
    assert.deepStrictEqual(await lookupWith('140.82.112.21', off), ['140.82.112.21']);
  });

  it('the Redis endpoint is refused by address, even under debug', async () => {
    const debug = {debug: true, port: 6379, redisEndpoint: {host: '127.0.0.1', port: 6379}};
    assert.strictEqual(await lookupWith('127.0.0.1', debug), 'REMOTE_ADDRESS_REFUSED');
    assert.deepStrictEqual(await lookupWith('127.0.0.1', Object.assign({}, debug, {port: 9688})), ['127.0.0.1']);
  });

  // Code review of step 2b.
  it('a Redis endpoint configured by name is matched by its addresses', async () => {
    const byName = {debug: true, port: 6379, redisEndpoint: {host: 'redis', port: 6379}};
    const resolve = resolverFor({'remote.test': '172.18.0.3', 'redis': '172.18.0.3'});
    const code = await new Promise((done) => guardedLookup(resolve, byName)('remote.test', {all: true}, (err) => done(err && err.remoteCode)));
    assert.strictEqual(code, 'REMOTE_ADDRESS_REFUSED');
  });

  it('loopback on the Redis port is refused even when Redis is configured by another address', async () => {
    const other = {debug: true, port: 6379, redisEndpoint: {host: '10.0.0.5', port: 6379}};
    assert.strictEqual(await lookupWith('127.0.0.1', other), 'REMOTE_ADDRESS_REFUSED');
  });

  it('refuses the IPv6 forms that embed or reach local IPv4 space', async () => {
    const off = {debug: false, port: 443, redisEndpoint: {host: '127.0.0.1', port: 6379}};
    for (const address of ['2002:7f00:1::', '2002:c0a8:101::1', 'fec0::1', '::ffff:0:7f00:1', '64:ff9b:1::a00:1']) {
      assert.strictEqual(await lookupWith(address, off), 'REMOTE_ADDRESS_REFUSED', address);
    }
    assert.deepStrictEqual(await lookupWith('2002:8c52:7015::1', off), ['2002:8c52:7015::1']);   // 6to4 of a public address
  });

  it('an empty answer is ENOTFOUND, not a crash', async () => {
    const empty = (hostname, options, cb) => cb(null, []);
    const err = await new Promise((done) => guardedLookup(empty, {debug: false, port: 443})('h', {}, (e) => done(e)));
    assert.strictEqual(err && err.code, 'ENOTFOUND');
  });

  it('without redisEndpoint the client takes the configured Redis, and fails closed', async () => {
    require('../../lib/cli-options').setOptions({workerThread: false, redisUrl: 'redis://127.0.0.1:6380'});
    const c = createRemoteClient(remoteAt('https://remote.test:6380/mcp', false), null,
      {timeoutMs: 5000, maxBytes: 1024, debug: true, resolve: resolverFor({'remote.test': '127.0.0.1'})});
    try {
      const e = await c.call('echo_text', {}).then(() => null, (err) => err);
      assert.strictEqual(e && e.code, 'REMOTE_ADDRESS_REFUSED', e && e.message);
    } finally {
      await c.close();
      require('../../lib/cli-options').setOptions({workerThread: false});
    }
  });

  it('an allowed answer connects through the guarded lookup, end to end', async () => {
    const {startRemoteServer} = require('../helpers/remote-mcp-server');
    const server = await startRemoteServer(PORT);
    const c = createRemoteClient(remoteAt(`http://localhost:${PORT}/mcp`, true), null,
      {timeoutMs: 5000, maxBytes: 1024 * 1024, debug: true, redisEndpoint: {host: '127.0.0.1', port: 6379},
        resolve: resolverFor({localhost: '127.0.0.1'})});
    try {
      assert.deepStrictEqual(await c.call('echo_text', {e: 1}), {content: [{type: 'text', text: '{"e":1}'}]});
    } finally {
      await c.close();
      await server.close();
    }
  });

  it('answers in the form the caller asked for', async () => {
    const one = await new Promise((resolve) => guardedLookup(resolverFor({h: '140.82.112.21'}), {debug: false, port: 443})(
      'h', {}, (err, address, family) => resolve([err, address, family])));
    assert.deepStrictEqual(one, [null, '140.82.112.21', 4]);
  });
});
