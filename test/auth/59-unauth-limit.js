'use strict';
// unauth-limit (release-1 hardening): requests whose API key doesn't resolve
// are limited per client address (lib/unauth-limit.js), counted at
// lib/user-auth.js's one refusal site. Over budget: 429 UNAUTH_RATE_LIMITED
// with Retry-After, before any provider lookup, the same for every
// unresolvable key and every route or tool named; a key that resolved
// lately still passes (and still goes to the provider).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const {createLimiter, addressKeyOf, WINDOW_MS} = require('../../lib/unauth-limit');
const {deviceIDForName} = require('../../lib/call-address');
const {testPort} = require('../helpers/test-env');

describe('auth 59: the limiter (lib/unauth-limit.js)', () => {
  let t = 1000000;
  const clock = () => t;

  it('an address is limited after perMinute refusals in a minute, for as long as Retry-After says; another is not', () => {
    const l = createLimiter({perMinute: 3, now: clock});
    for (let i = 0; i < 3; i++) { assert.strictEqual(l.retryAfterMs('a'), 0); l.refused('a'); t += 1000; }
    const wait = l.retryAfterMs('a');
    assert.ok(wait > 0 && wait <= WINDOW_MS, String(wait));
    assert.strictEqual(l.retryAfterMs('b'), 0);
    t += wait;
    assert.strictEqual(l.retryAfterMs('a'), 0, 'the oldest refusal has left the window');
  });

  it('the process as a whole is limited at ten times an address\'s budget (a spray from many addresses)', () => {
    const l = createLimiter({perMinute: 2, now: clock});
    for (let i = 0; i < 20; i++) l.refused(`spray-${i}`);
    assert.ok(l.retryAfterMs('fresh') > 0, 'a fresh address waits once the process cap is reached');
  });

  it('the address table is bounded: past its cap the least recently refused address goes; each holds at most perMinute times', () => {
    const l = createLimiter({perMinute: 2, now: clock, maxAddresses: 5});
    for (let i = 0; i < 12; i++) l.refused(`addr-${i}`);
    for (let i = 0; i < 9; i++) l.refused('busy');
    assert.strictEqual(l.sizes().addresses, 5);
    assert.ok(l.retryAfterMs('busy') > 0);
  });

  it('a key that resolved lately passes the limiter: its hash kept, bounded, for ten minutes; never the key itself', () => {
    const l = createLimiter({perMinute: 1, now: clock, maxRecent: 3});
    l.resolved('the-secret-key-0123456789');
    assert.strictEqual(l.resolvedLately('the-secret-key-0123456789'), true);
    assert.strictEqual(l.resolvedLately('another-key'), false);
    for (let i = 0; i < 5; i++) l.resolved(`k${i}`);
    assert.strictEqual(l.sizes().recent, 3);
    assert.strictEqual(l.resolvedLately('the-secret-key-0123456789'), false, 'the least recent went at the cap');
    l.resolved('later-key');
    t += 10 * 60 * 1000 + 1;
    assert.strictEqual(l.resolvedLately('later-key'), false, 'past ten minutes');
  });

  it('an IPv6 address is grouped by its /64; an IPv4-mapped one is its IPv4 address', () => {
    assert.strictEqual(addressKeyOf('2001:db8:1:2:aaaa::1'), addressKeyOf('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    assert.notStrictEqual(addressKeyOf('2001:db8:1:2::1'), addressKeyOf('2001:db8:1:3::1'));
    assert.strictEqual(addressKeyOf('::ffff:10.0.0.7'), '10.0.0.7');
    assert.strictEqual(addressKeyOf('10.0.0.7'), '10.0.0.7');
  });

  it('perMinute 0 turns it off', () => {
    const l = createLimiter({perMinute: 0, now: clock});
    for (let i = 0; i < 100; i++) l.refused('a');
    assert.strictEqual(l.retryAfterMs('a'), 0);
  });
});

// On running servers: an auth file with one key and the echo module.
describe('auth 59: on a running server', function() {
  this.timeout(60000);
  const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
  const tmp = require('../helpers/test-tmp').forFile(['ch-auth-59-']);
  const KEY = `k${require('crypto').randomBytes(12).toString('hex')}`;
  const ECHO = deviceIDForName('echo-device');
  const servers = [];
  let calls = null;
  const providerCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0);
  after(() => { for (const s of servers) stopServer(s); });

  const start = async (port, extra = []) => {
    const dir = tmp.mkdtemp('ch-auth-59-');
    const auth = path.join(dir, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'u', devices: ['*']}}));
    calls = path.join(dir, 'auth-calls');
    const s = await startServer(port, ['--workerThread', '--authProvider', 'file', '--authConfigPath', auth, '--unauthRateLimit', '3',
      '--moduleDataPath', path.join(dir, 'data'), '--loadModule', path.join(ROOT, 'pre-installed-packages', 'echo-device-module'), ...extra],
    {nodeArgs: ['--require', path.join(ROOT, 'test', 'fixtures', 'auth-calls-preload.js')], env: {CH_TEST_AUTH_CALLS: calls}});
    servers.push(s);
    return s;
  };
  // a request with exactly these headers (a missing key: no header at all)
  const send = (port, pathName, body, headers = {}) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const rq = http.request({host: '127.0.0.1', port, path: pathName, method: 'POST',
      headers: Object.assign({'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data)}, headers)}, (r) => {
      let t = '';
      r.on('data', (c) => { t += c; });
      r.on('end', () => resolve({status: r.statusCode, retryAfter: r.headers['retry-after'], body: t}));
    });
    rq.on('error', reject);
    rq.end(data);
  });
  const mcp = (port, headers, name = 'echo_device_echoservice_echo') => send(port, '/mcp', {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: {}}}, headers);
  const rest = (port, headers) => send(port, `/devices/${ECHO}/invoke-action`, {serviceID: 'urn:countinghouse-com:serviceID:echoService', actionName: 'echo', input: {foo: [], bar: 'x'}}, headers);

  it('the fourth unresolvable key from an address is 429 with Retry-After, on /mcp and on the REST routes, with no provider lookup; the same body whatever the key or the name', async () => {
    const port = testPort(9678);
    await start(port);
    // a valid key resolves first: it is remembered (its hash)
    const ok = await mcp(port, {'X-CH-Key': KEY});
    assert.strictEqual(ok.status, 200, ok.body);
    for (let i = 0; i < 3; i++) {
      const r = await mcp(port, {'X-CH-Key': `unknown-${i}`});
      assert.notStrictEqual(r.status, 429, `refusal ${i + 1} is the usual one: ${r.body}`);
    }
    const before = providerCalls();
    const answers = [
      await mcp(port, {'X-CH-Key': 'unknown-again'}),
      await mcp(port, {'X-CH-Key': 'unknown-again'}, 'no_such_tool'),
      await mcp(port, {'X-CH-Key': 'é\u0001 malformed'.replace(/[^\x20-\x7e]/g, '?')}),
      await mcp(port, {}),
      await mcp(port, {'X-CH-Key': 'x'.repeat(4000)})
    ];
    for (const a of answers) {
      assert.strictEqual(a.status, 429, a.body);
      assert.ok(Number(a.retryAfter) >= 1 && Number(a.retryAfter) <= 60, String(a.retryAfter));
      assert.strictEqual(a.body, answers[0].body, 'one body whatever the key or the tool named');
    }
    const body = JSON.parse(answers[0].body);
    assert.deepStrictEqual([body.id, body.error.data.code], [null, 'UNAUTH_RATE_LIMITED']);
    assert.ok(!answers[0].body.includes('unknown-again'));
    const r = await rest(port, {'X-CH-Key': 'unknown-again'});
    assert.strictEqual(r.status, 429, r.body);
    assert.strictEqual(JSON.parse(r.body).code, 'UNAUTH_RATE_LIMITED');
    assert.strictEqual(providerCalls(), before, 'no provider lookup for a limited request');
    // the key that resolved lately still passes, and is still looked up
    const again = await mcp(port, {'X-CH-Key': KEY});
    assert.strictEqual(again.status, 200, again.body);
    assert.ok(!JSON.parse(again.body).error, again.body);
    assert.ok(providerCalls() > before, 'a key let past the limiter still goes to the provider');
  });

  it('X-Forwarded-For is ignored without --trustProxy, and names the client with it', async () => {
    const plain = testPort(9678);   // the server above: its address is over budget
    const r = await mcp(plain, {'X-CH-Key': 'unknown-xff', 'X-Forwarded-For': '203.0.113.9'});
    assert.strictEqual(r.status, 429, 'a forged X-Forwarded-For does not escape the limit');
    const port = testPort(9679);
    await start(port, ['--trustProxy', 'loopback']);
    for (let i = 0; i < 3; i++) await mcp(port, {'X-CH-Key': `unknown-${i}`, 'X-Forwarded-For': '203.0.113.9'});
    assert.strictEqual((await mcp(port, {'X-CH-Key': 'unknown-3', 'X-Forwarded-For': '203.0.113.9'})).status, 429);
    const other = await mcp(port, {'X-CH-Key': 'unknown-4', 'X-Forwarded-For': '198.51.100.20'});
    assert.notStrictEqual(other.status, 429, 'another client behind the trusted proxy has its own budget');
  });

  it('a start with a bad --unauthRateLimit or --trustProxy is refused (exit 2)', async () => {
    for (const [flag, value] of [['--unauthRateLimit', '-1'], ['--unauthRateLimit', 'x'], ['--trustProxy', 'true'], ['--trustProxy', '10.0.0.1/40']]) {
      const s = await startServer(testPort(9701), ['--workerThread', flag, value], {expectExit: true});
      assert.strictEqual(s.exitCode, 2, `${flag} ${value}: ${s.output.slice(-400)}`);
      assert.ok(s.output.includes(flag), s.output.slice(-400));
    }
  });

  tmp.hooks();
});
