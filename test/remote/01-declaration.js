// RC1-min (docs/superpowers/specs/2026-11-11-rc1-min-remote-mcp-design.md,
// section 1): package.json's countinghouse.remotes, parsed and refused at
// load with the declaration's position and field.
const assert = require('assert');
const {parseRemotes} = require('../../lib/remote/declaration');

// The first pack's declaration, as @countinghouse/ch-access-github writes it.
const GITHUB = {
  name: 'github',
  transport: 'streamable-http',
  url: 'https://api.githubcopilot.com/mcp/',
  headers: {'X-MCP-Toolsets': 'actions,repos'},
  credential: {env: 'COUNTINGHOUSE_GITHUB_TOKEN', fallbackEnv: 'GITHUB_TOKEN', header: 'Authorization', scheme: 'Bearer'}
};
const REDIS = {host: '127.0.0.1', port: 6379};
const pkgWith = (remotes) => ({name: 'm', countinghouse: {role: 'part', remotes: remotes}});
const one = (fields) => pkgWith([Object.assign({}, GITHUB, fields)]);
const parse = (pkg, opts) => parseRemotes(pkg, Object.assign({debug: false, redisEndpoint: REDIS}, opts));

describe('remote 01: the remotes declaration', () => {
  it('accepts the first pack\'s declaration as written', () => {
    const r = parse(pkgWith([GITHUB]));
    assert.deepStrictEqual(r.problems, []);
    assert.strictEqual(r.remotes.length, 1);
    const g = r.remotes[0];
    assert.strictEqual(g.name, 'github');
    assert.strictEqual(g.origin, 'https://api.githubcopilot.com');
    assert.strictEqual(g.url.href, 'https://api.githubcopilot.com/mcp/');
    assert.deepStrictEqual(g.headers, {'X-MCP-Toolsets': 'actions,repos'});
    assert.deepStrictEqual(g.credential, {env: 'COUNTINGHOUSE_GITHUB_TOKEN', fallbackEnv: 'GITHUB_TOKEN',
      header: 'Authorization', scheme: 'Bearer'});
  });

  it('gives the credential its defaults and allows no credential at all', () => {
    const d = parse(one({credential: {env: 'TOKEN'}})).remotes[0];
    assert.deepStrictEqual(d.credential, {env: 'TOKEN', fallbackEnv: null, header: 'Authorization', scheme: 'Bearer'});
    const none = Object.assign({}, GITHUB);
    delete none.credential;
    assert.strictEqual(parse(pkgWith([none])).remotes[0].credential, null);
  });

  it('a module with no remotes has none, and no problem', () => {
    assert.deepStrictEqual(parse({name: 'm'}), {remotes: [], problems: []});
    assert.deepStrictEqual(parse({name: 'm', countinghouse: {calls: []}}), {remotes: [], problems: []});
  });

  // Each row: [label, package, the field the problem names].
  const REFUSED = [
    ['not an array', pkgWith({github: GITHUB}), 'remotes'],
    ['two entries', pkgWith([GITHUB, Object.assign({}, GITHUB, {name: 'other'})]), 'remotes[1]'],
    ['an unknown field', one({foo: 1}), 'remotes[0].foo'],
    ['a name with a capital', one({name: 'GitHub'}), 'remotes[0].name'],
    ['an unknown transport', one({transport: 'stdio'}), 'remotes[0].transport'],
    ['http without debug', one({url: 'http://example.com/mcp'}), 'remotes[0].url'],
    ['user info in the url', one({url: 'https://u:p@example.com/mcp'}), 'remotes[0].url'],
    ['a fragment in the url', one({url: 'https://example.com/mcp#x'}), 'remotes[0].url'],
    ['a relative url', one({url: '/mcp'}), 'remotes[0].url'],
    ['a header name that is not a token', one({headers: {'Bad Name': 'x'}}), 'remotes[0].headers'],
    ['a header value with CR LF', one({headers: {'X-A': 'a\r\nX-B: b'}}), 'remotes[0].headers'],
    ['a header value that is not a string', one({headers: {'X-A': 1}}), 'remotes[0].headers'],
    ['Authorization with no credential block', (() => { const r = Object.assign({}, GITHUB, {headers: {authorization: 'x'}}); delete r.credential; return pkgWith([r]); })(), 'remotes[0].headers'],
    ['the credential\'s own header', one({headers: {Authorization: 'x'}}), 'remotes[0].headers'],
    ['a hop-by-hop header', one({headers: {Connection: 'close'}}), 'remotes[0].headers'],
    ['a header Connection names', one({headers: {'Keep-Alive': 'x'}}), 'remotes[0].headers'],
    ['the transport\'s Host', one({headers: {Host: 'x'}}), 'remotes[0].headers'],
    ['the transport\'s session id', one({headers: {'mcp-session-id': 'x'}}), 'remotes[0].headers'],
    ['a grant credential', one({credential: {grant: 'refresh-token'}}), 'remotes[0].credential'],
    ['a credential with no env', one({credential: {header: 'Authorization'}}), 'remotes[0].credential.env'],
    ['a private IPv4 address', one({url: 'https://10.1.2.3/mcp'}), 'remotes[0].url'],
    ['a short-form private address', one({url: 'https://10.5/mcp'}), 'remotes[0].url'],
    ['an IPv6 loopback', one({url: 'https://[::1]/mcp'}), 'remotes[0].url'],
    ['an IPv4-mapped private address', one({url: 'https://[::ffff:192.168.1.1]/mcp'}), 'remotes[0].url'],
    ['localhost', one({url: 'https://localhost/mcp'}), 'remotes[0].url'],
    ['a RHEL loopback name', one({url: 'https://localhost4/mcp'}), 'remotes[0].url']
  ];
  REFUSED.forEach(([label, pkg, field]) => {
    it(`refuses ${label}, naming ${field}`, () => {
      const r = parse(pkg);
      assert.deepStrictEqual(r.remotes, [], label);
      assert.ok(r.problems.length > 0 && r.problems.some((p) => p.includes(field)), `${label}: ${JSON.stringify(r.problems)}`);
    });
  });

  it('refuses a duplicate name', () => {
    const r = parseRemotes(pkgWith([GITHUB, GITHUB]), {debug: false, redisEndpoint: REDIS, maxRemotes: 2});
    assert.ok(r.problems.some((p) => p.includes('remotes[1].name')), JSON.stringify(r.problems));
  });

  it('refuses the Redis endpoint, even under debug', () => {
    for (const debug of [false, true]) {
      const r = parse(one({url: 'http://127.0.0.1:6379/'}), {debug: debug});
      assert.ok(r.problems.some((p) => p.includes('remotes[0].url')), `debug ${debug}: ${JSON.stringify(r.problems)}`);
    }
  });

  // Review Focus 3: the set of headers sent is never ambiguous.
  it('header names are compared case-insensitively', () => {
    assert.ok(parse(one({headers: {'X-A': '1', 'x-a': '2'}})).problems.some((p) => p.includes('remotes[0].headers')));
    assert.ok(parse(one({headers: {AUTHORIZATION: 'x'}})).problems.some((p) => p.includes('remotes[0].headers')));
  });

  it('http to a loopback host is accepted only under debug', () => {
    const local = one({url: 'http://127.0.0.1:9688/mcp'});
    assert.deepStrictEqual(parse(local, {debug: true}).problems, []);
    assert.strictEqual(parse(local, {debug: true}).remotes[0].origin, 'http://127.0.0.1:9688');
    assert.ok(parse(local, {debug: false}).problems.length > 0);
    assert.ok(parse(one({url: 'http://example.com/mcp'}), {debug: true}).problems.length > 0, 'http elsewhere stays refused under debug');
  });
});

// The literal check, which Task 2b reuses on resolved addresses (code
// review of Task 1).
describe('remote 01: refusedAddress', () => {
  const {refusedAddress} = require('../../lib/remote/declaration');
  const refused = (host) => refusedAddress(host, 443, {debug: false, redisEndpoint: REDIS});

  it('reads every IPv4-embedding IPv6 form, hex or dotted, as its IPv4 address', () => {
    for (const host of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.1.1', '::127.0.0.1', '::7f00:1',
      '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '[::ffff:10.0.0.1]']) {
      assert.notStrictEqual(refused(host), null, host);
    }
  });

  it('refuses the non-public IPv4 ranges', () => {
    for (const host of ['100.64.0.1', '100.100.100.200', '100.127.255.254', '198.18.0.1', '192.0.0.8', '224.0.0.1',
      '255.255.255.255', '0.1.2.3', '169.254.169.254']) {
      assert.notStrictEqual(refused(host), null, host);
    }
  });

  it('refuses unique-local, link-local and multicast IPv6, and only those', () => {
    for (const host of ['fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1']) assert.notStrictEqual(refused(host), null, host);
    for (const host of ['fc::1', 'fe8::1', '2001:db8::1', '2606:4700::1111']) assert.strictEqual(refused(host), null, host);
  });

  it('leaves public addresses and names alone', () => {
    for (const host of ['140.82.112.21', '100.63.255.255', '100.128.0.1', '198.20.0.1', 'api.githubcopilot.com']) {
      assert.strictEqual(refused(host), null, host);
    }
  });
});

describe('remote 01: header values', () => {
  it('refuses a value Node\'s http would refuse at request time', () => {
    for (const v of ['café\u0001', 'a\u007fb', 'Ā', 'x y']) {
      assert.ok(parse(one({headers: {'X-A': v}})).problems.some((p) => p.includes('remotes[0].headers')), JSON.stringify(v));
    }
    assert.deepStrictEqual(parse(one({headers: {'X-A': 'café \tok'}})).problems, []);
  });
});
