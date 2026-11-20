'use strict';
// unauth-limit (release-1 hardening): requests whose API key doesn't resolve
// are limited per client address (lib/unauth-limit.js), counted at
// lib/user-auth.js, where every key is looked up: a lookup holds a place
// while in flight and keeps it unless the key resolved. Over budget: 429
// UNAUTH_RATE_LIMITED with Retry-After, before any provider lookup, the same
// for every unresolvable key and every route or tool named; no lookup once
// over budget inside a request either (a legacy batch); a key that resolved
// lately still passes (and still goes to the provider).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const unauthLimit = require('../../lib/unauth-limit');
const {createLimiter, addressKeyOf, keyResolvedBy, WINDOW_MS} = unauthLimit;
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

  it('the process as a whole is limited at ten times an address\'s budget (a spray from many addresses), never an address with nothing in its window', () => {
    const l = createLimiter({perMinute: 2, now: clock});
    for (let i = 0; i < 20; i++) l.refused(`spray-${i}`);
    assert.ok(l.retryAfterMs('spray-0') > 0, 'an address with a refusal waits once the process cap is reached');
    assert.strictEqual(l.retryAfterMs('fresh'), 0, 'a new client still has its first lookup (a key that resolves is then remembered)');
    l.refused('fresh');
    assert.ok(l.retryAfterMs('fresh') > 0);
  });

  it('a counted lookup taken back (its key resolved) frees its place', () => {
    const l = createLimiter({perMinute: 2, now: clock});
    const a = l.count('a');
    l.count('a');
    assert.ok(l.retryAfterMs('a') > 0);
    l.uncount('a', a);
    assert.strictEqual(l.retryAfterMs('a'), 0);
    assert.strictEqual(l.sizes().refusals, 1);
  });

  it('only an answer or a known key without the device is a key that resolved; anything else counts (fails closed)', () => {
    const coded = (code) => ({ok: false, err: Object.assign(new Error(code), {code})});
    assert.strictEqual(keyResolvedBy(null, {ok: true}), true);
    assert.strictEqual(keyResolvedBy(null, coded('USER_HAS_NO_DEVICE')), true);
    assert.strictEqual(keyResolvedBy(null, coded('SYSTEM_ERROR_UNKNOWN_USER')), false);
    assert.strictEqual(keyResolvedBy(null, coded('SOME_PROVIDER_CODE')), false);
    assert.strictEqual(keyResolvedBy(null, {ok: false}), false);
    assert.strictEqual(keyResolvedBy(new Error('down'), null), false);
    assert.strictEqual(keyResolvedBy(null, null), false);
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

describe('auth 59: a lookup holds its place while in flight (beforeLookup)', () => {
  const scope = require('../helpers/options-scope');
  const options = require('../../lib/cli-options');
  let kept = null;
  before(() => { kept = scope.snapshot(); options.unauthRateLimit = 2; unauthLimit.resetForTests(); });
  after(() => { scope.restore(kept); unauthLimit.resetForTests(); });
  // a lookup of key inside a request from `ip`, as a route makes one; null
  // when the middleware answers 429 itself (it sees lookups in flight too)
  const inRequest = (ip, key) => {
    let out = null;
    const res = {set() { return res; }, status(code) { res.code = code; return res; }, json() { return res; }};
    unauthLimit.middleware()({ip, headers: {'x-ch-key': key}, socket: {}}, res, () => { out = unauthLimit.beforeLookup(key); });
    if (res.code != null) assert.strictEqual(res.code, 429);
    return out;
  };

  it('lookups begun at once take the budget before any answers; one whose key resolves gives its place back; outside a request nothing is limited', () => {
    const a = inRequest('192.0.2.1', 'k-one');
    const b = inRequest('192.0.2.1', 'k-two');
    assert.ok(a != null && b != null);
    assert.strictEqual(inRequest('192.0.2.1', 'k-three'), null, 'two in flight fill a budget of two');
    a.resolved();
    const c = inRequest('192.0.2.1', 'k-three');
    assert.ok(c != null, 'a resolved key frees its place');
    b.refused();
    c.refused();
    assert.strictEqual(inRequest('192.0.2.1', 'k-four'), null);
    assert.ok(inRequest('192.0.2.1', 'k-one') != null, 'a key that resolved lately passes');
    assert.ok(unauthLimit.beforeLookup('k-five') != null, 'not in an HTTP request: no limit');
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
    // a forged X-Forwarded-For is not believed without --trustProxy
    const forged = await mcp(port, {'X-CH-Key': 'unknown-xff', 'X-Forwarded-For': '203.0.113.9'});
    assert.strictEqual(forged.status, 429, 'a forged X-Forwarded-For does not escape the limit');
  });

  // behind a trusted proxy (loopback): each case a client of its own, by
  // X-Forwarded-For, so each has its own budget (the process cap, 30, is not
  // reached by all of them together)
  describe('behind a trusted proxy', () => {
    let port = null;
    before(async () => { port = testPort(9679); await start(port, ['--trustProxy', 'loopback']); });
    const as = (ip, headers = {}) => Object.assign({'X-Forwarded-For': ip}, headers);

    it('X-Forwarded-For names the client: another client behind the proxy has its own budget', async () => {
      for (let i = 0; i < 3; i++) await mcp(port, as('203.0.113.9', {'X-CH-Key': `unknown-${i}`}));
      assert.strictEqual((await mcp(port, as('203.0.113.9', {'X-CH-Key': 'unknown-3'}))).status, 429);
      const other = await mcp(port, as('198.51.100.20', {'X-CH-Key': 'unknown-4'}));
      assert.notStrictEqual(other.status, 429, 'another client behind the trusted proxy has its own budget');
    });

    it('requests sent at once cost no more lookups than the budget', async () => {
      const before = providerCalls();
      const answers = await Promise.all(Array.from({length: 12}, (_, i) => mcp(port, as('198.51.100.30', {'X-CH-Key': `at-once-${i}`}))));
      assert.ok(providerCalls() - before <= 3, `${providerCalls() - before} lookups for 12 requests at once`);
      assert.ok(answers.some((a) => a.status === 429 || a.body.includes('UNAUTH_RATE_LIMITED') || a.body.includes('Too many requests')), JSON.stringify(answers.map((a) => a.status)));
    });

    it('a legacy batch of 32 calls under one unknown key costs no more lookups than the budget', async () => {
      const before = providerCalls();
      const batch = Array.from({length: 32}, (_, i) => ({jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: {name: 'echo_device_echoservice_echo', arguments: {}}}));
      const r = await send(port, '/mcp', batch, as('198.51.100.40', {'X-CH-Key': 'batch-unknown'}));
      assert.strictEqual(r.status, 200, r.body);
      assert.ok(providerCalls() - before <= 3, `${providerCalls() - before} lookups for a batch of 32`);
      const answers = JSON.parse(r.body);
      assert.ok(answers[31].error != null && /Too many requests/.test(answers[31].error.message), JSON.stringify(answers[31]));
    });

    it('/device-list resolves its key first: an unknown key sees no device, is counted, and is limited', async () => {
      const get = (headers) => new Promise((resolve, reject) => {
        http.get({host: '127.0.0.1', port, path: '/device-list', headers}, (r) => {
          let t = '';
          r.on('data', (c) => { t += c; });
          r.on('end', () => resolve({status: r.statusCode, retryAfter: r.headers['retry-after'], body: t}));
        }).on('error', reject);
      });
      // the valid key first, from this client: it resolves (remembered)
      const first = await get(as('198.51.100.50', {'X-CH-Key': KEY}));
      assert.strictEqual(first.status, 200, first.body);
      const before = providerCalls();
      for (let i = 0; i < 3; i++) {
        const r = await get(as('198.51.100.50', {'X-CH-Key': `dl-unknown-${i}`}));
        assert.deepStrictEqual([r.status, r.body], [200, '[]']);
      }
      const limited = await get(as('198.51.100.50', {'X-CH-Key': 'dl-unknown-3'}));
      assert.strictEqual(limited.status, 429, limited.body);
      assert.ok(Number(limited.retryAfter) >= 1);
      assert.strictEqual(providerCalls() - before, 3, 'one lookup each, none once limited');
      const mine = await get(as('198.51.100.50', {'X-CH-Key': KEY}));
      assert.strictEqual(mine.status, 200, 'a key that resolved lately still lists, over its address\'s budget');
      assert.ok(JSON.parse(mine.body).length > 0, mine.body);
    });
  });

  it('a start with a bad --unauthRateLimit or --trustProxy is refused (exit 2)', async () => {
    for (const [flag, value] of [['--unauthRateLimit', '-1'], ['--unauthRateLimit', 'x'], ['--trustProxy', 'true'], ['--trustProxy', '10.0.0.1/40'],
      ['--trustProxy', '0.0.0.0/0'], ['--trustProxy', '::/0'], ['--trustProxy', '11']]) {
      const s = await startServer(testPort(9701), ['--workerThread', flag, value], {expectExit: true});
      assert.strictEqual(s.exitCode, 2, `${flag} ${value}: ${s.output.slice(-400)}`);
      assert.ok(s.output.includes(flag), s.output.slice(-400));
    }
  });

  tmp.hooks();
});
