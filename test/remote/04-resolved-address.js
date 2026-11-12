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

  it('answers in the form the caller asked for', async () => {
    const one = await new Promise((resolve) => guardedLookup(resolverFor({h: '140.82.112.21'}), {debug: false, port: 443})(
      'h', {}, (err, address, family) => resolve([err, address, family])));
    assert.deepStrictEqual(one, [null, '140.82.112.21', 4]);
  });
});
