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

  // the process cap (ten times an address's budget) applies only while the
  // address table is full -- a spray over more addresses than it keeps --
  // and then to every address, an unseen one too; otherwise an address
  // under its own budget is never refused (the high review of #483, 1+3)
  it('a spray cycling over more addresses than the table keeps is held to the process cap, and an address over budget does not come back under', () => {
    const l = createLimiter({perMinute: 2, now: clock, maxAddresses: 5});
    l.refused('over');
    l.refused('over');
    assert.ok(l.retryAfterMs('over') > 0);
    let taken = 0;
    for (let i = 0; i < 500; i++) {
      const a = `cycle-${i}`;
      if (l.retryAfterMs(a) === 0) { l.refused(a); taken++; }
    }
    assert.ok(taken <= 2 * 10, `${taken} lookups taken by a spray over 500 addresses (cap 20)`);
    assert.ok(l.retryAfterMs('over') > 0, 'an address over its budget is still refused after the spray pushed it out of the table');
    assert.ok(l.retryAfterMs('never-seen') > 0, 'while the table is full and the cap reached, an unseen address waits too');
  });

  it('below a full table, a full process cap refuses no address under its own budget (valid keys do not share it)', () => {
    const l = createLimiter({perMinute: 2, now: clock});
    for (let i = 0; i < 10; i++) { l.refused(`bad-${i}`); l.refused(`bad-${i}`); }
    assert.strictEqual(l.sizes().refusals, 20, 'the process cap is reached');
    assert.strictEqual(l.retryAfterMs('fresh'), 0, 'a new client');
    l.count('in-flight');
    assert.strictEqual(l.retryAfterMs('in-flight'), 0, 'an address with one lookup in flight');
    assert.ok(l.retryAfterMs('bad-0') > 0, 'an address over its own budget still waits');
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

  it('every spelling of one address lands in one bucket: case, the hex mapped form, a port, brackets, a zone (the high review of #483, 9)', () => {
    const v4 = addressKeyOf('127.0.0.1');
    for (const spelling of ['::ffff:7f00:1', '::FFFF:7F00:0001', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '127.0.0.1:8080', '[::ffff:127.0.0.1]:443', ' 127.0.0.1 ']) {
      assert.strictEqual(addressKeyOf(spelling), v4, spelling);
    }
    const v6 = addressKeyOf('2001:db8:1:2::1');
    for (const spelling of ['2001:DB8:1:2::1', '[2001:db8:1:2::1]', '[2001:db8:1:2::1]:443', '2001:0db8:0001:0002:0:0:0:1', 'fe80::1%eth0'.replace('fe80::1', '2001:db8:1:2::1')]) {
      assert.strictEqual(addressKeyOf(spelling), v6, spelling);
    }
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
  const {EventEmitter} = require('events');
  // a request from `ip` carrying `key`: a fake res (an emitter, as express's
  // is), run through the middleware; fn runs inside it
  const request = (ip, key, fn) => {
    const res = Object.assign(new EventEmitter(), {set() { return res; }, status(code) { res.code = code; return res; }, json() { return res; }});
    let out = null;
    unauthLimit.middleware()({ip, headers: key != null ? {'x-ch-key': key} : {}, socket: {}}, res, () => { out = fn(); });
    if (res.code != null) assert.strictEqual(res.code, 429);
    return {out, res, end: () => res.emit('finish')};
  };
  // a lookup of key inside a request from `ip`, as a route makes one; null
  // when the middleware answers 429 itself (it sees lookups in flight too)
  const inRequest = (ip, key) => request(ip, key, () => unauthLimit.beforeLookup(key)).out;

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

  it('a key refused now leaves the set of keys that resolved: a revoked key is counted again (the high review of #483, 2)', () => {
    const ip = '192.0.2.2';
    inRequest(ip, 'k-revoked').resolved();
    for (let i = 0; i < 2; i++) {
      const l = inRequest(ip, 'k-revoked');
      assert.ok(l != null, `lookup ${i + 1} of the revoked key`);
      l.refused();
    }
    assert.strictEqual(inRequest(ip, 'k-revoked'), null, 'after two refusals (the budget) the revoked key is limited like any other');
  });

  // (the high review of #483, 4) the address is the request's own: a lookup
  // after its request has ended (a worker it spawned, a listener it set up),
  // or of another key than the request's (a change notice's re-listing for
  // another subscriber), is not counted against it
  it('a lookup made after its request ended, or of a key the request did not carry, is not counted against the request\'s address', () => {
    const ip = '192.0.2.3';
    const later = [];
    const r = request(ip, 'k-own', () => { later.push(() => unauthLimit.beforeLookup('k-own')); return null; });
    for (let i = 0; i < 3; i++) {
      const other = request(ip, 'k-own', () => unauthLimit.beforeLookup('another-tenants-key')).out;
      assert.ok(other != null);
      other.refused();
    }
    r.end();
    for (let i = 0; i < 3; i++) {
      const l = later[0]();
      assert.ok(l != null);
      l.refused();
    }
    assert.ok(inRequest(ip, 'k-own') != null, 'none of those six refusals counted against the address');
  });

  it('a worker spawned while a request is served carries no address: its later messages are not counted against it', async () => {
    const {Worker} = require('worker_threads');
    const ip = '192.0.2.4';
    let worker = null;
    const r = request(ip, 'k-spawner', () => {
      worker = unauthLimit.outsideRequest(() => new Worker('const {parentPort} = require("worker_threads"); parentPort.postMessage("hop"); parentPort.postMessage("hop"); parentPort.postMessage("hop");', {eval: true}));
      return null;
    });
    let seen = 0;
    await new Promise((resolve) => worker.on('message', () => {
      // a module's hop, made with the spawning request's own key
      const l = unauthLimit.beforeLookup('k-spawner');
      assert.ok(l != null);
      l.refused();
      if (++seen === 3) resolve();
    }));
    await worker.terminate();
    r.end();
    assert.ok(inRequest(ip, 'k-spawner') != null, 'the worker\'s three refusals were not counted against the spawner\'s address');
  });
});

// (the high review of #483, 8) --trustProxy never trusts a range wider than
// an IPv4 /8 or an IPv6 /32, however it is spelled -- an IPv4-mapped form, or
// several entries whose union is wider. The named ranges are Express's own
// private ones (no public client's socket address is in them) and stand.
describe('auth 59: --trustProxy refuses a range wider than a /8 (IPv4) or a /32 (IPv6), in any spelling', () => {
  const scope = require('../helpers/options-scope');
  const options = require('../../lib/cli-options');
  let kept = null;
  before(() => { kept = scope.snapshot(); });
  after(() => { scope.restore(kept); });
  const parsed = (value) => { options.setOptions({trustProxy: value}); return {trust: options.trustProxy, invalid: options.trustProxyInvalid}; };

  it('refuses each wide form', () => {
    for (const v of ['0.0.0.0/0', '::/0', '::ffff:0.0.0.0/96', '::ffff:0:0/96', '0.0.0.0/1,128.0.0.0/1', '10.0.0.0/7', '10.0.0.0/8,11.0.0.0/8',
      '10.0.0.0/8,192.168.0.0/16', '::ffff:10.0.0.0/103', '2001:db8::/31', '2001:db8::/32,2001:db9::/32', 11, true, '']) {
      const r = parsed(v);
      assert.ok(r.trust == null && r.invalid != null, `${JSON.stringify(v)} was taken: ${JSON.stringify(r)}`);
    }
  });

  it('takes a /8 or narrower, overlapping entries counted once, and the named ranges', () => {
    for (const v of ['10.0.0.0/8', '203.0.113.7', '::ffff:10.0.0.0/104', '10.0.0.0/9,10.128.0.0/9', '10.0.0.0/8,10.1.0.0/16', '2001:db8::/32',
      'loopback', 'loopback,linklocal,uniquelocal', 3]) {
      const r = parsed(v);
      assert.ok(r.trust != null && r.invalid == null, `${JSON.stringify(v)} was refused: ${JSON.stringify(r.invalid)}`);
    }
  });
});

// (the high review of #483, 6 and 7) a lookup refused for its address while
// the request is under way answers as the middleware does, on every route:
// 429, Retry-After, the code; on /mcp the JSON-RPC error -32000 with the code
// in data (a single request 429, a batch's message in its 200).
describe('auth 59: a refusal met under way answers one shape on every route', function() {
  this.timeout(30000);
  it('REST routes: 429, Retry-After, {code}; /mcp: -32000 with data.code, 429 for a single request', () => {
    const {spawnSync} = require('child_process');
    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'fixtures', 'unauth-limited-routes.js')], {encoding: 'utf8', timeout: 25000});
    assert.strictEqual(run.status, 0, run.stderr);
    const answers = JSON.parse(run.stdout);
    for (const a of answers.slice(0, 4)) {
      assert.deepStrictEqual([a.path, a.status, JSON.parse(a.body).code], [a.path, 429, 'UNAUTH_RATE_LIMITED'], a.body);
      assert.ok(Number(a.retryAfter) >= 1, `${a.path}: Retry-After ${a.retryAfter}`);
    }
    const single = answers[4];
    assert.strictEqual(single.status, 429, single.body);
    assert.ok(Number(single.retryAfter) >= 1, String(single.retryAfter));
    const one = JSON.parse(single.body);
    assert.deepStrictEqual([one.id, one.error.code, one.error.data.code], [7, -32000, 'UNAUTH_RATE_LIMITED'], single.body);
    const batched = answers[5];
    assert.strictEqual(batched.status, 200, batched.body);
    const [m] = JSON.parse(batched.body);
    assert.deepStrictEqual([m.id, m.error.code, m.error.data.code], [8, -32000, 'UNAUTH_RATE_LIMITED'], batched.body);
    assert.strictEqual(m.error.message, one.error.message);
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
  // the provider's authenticate calls alone (the preload writes 'a' for one)
  const authenticateCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l === 'a').length : 0);
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

  // (the high review of #483, 5) with --authoringTools a tools/list looks
  // its key up once: a keyless one not at all, an unknown key once
  it('--authoringTools: a keyless tools/list is not looked up or counted; an unknown key is looked up and counted once per list', async () => {
    const port = testPort(9702);
    await start(port, ['--authoringTools', '--trustProxy', 'loopback']);
    const list = (headers) => send(port, '/mcp', {jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}}, headers);
    const before = authenticateCalls();
    for (let i = 0; i < 5; i++) {
      const r = await list({'X-Forwarded-For': '198.51.100.60'});
      assert.strictEqual(r.status, 200, r.body);
    }
    assert.strictEqual(authenticateCalls(), before, 'a keyless tools/list looks no key up');
    for (let i = 0; i < 3; i++) {
      const at = authenticateCalls();
      const r = await list({'X-Forwarded-For': '198.51.100.61', 'X-CH-Key': `list-unknown-${i}`});
      assert.strictEqual(r.status, 200, `list ${i + 1}: ${r.body}`);
      assert.ok(!r.body.includes('Too many requests'), `list ${i + 1}: ${r.body}`);
      assert.strictEqual(authenticateCalls() - at, 1, `list ${i + 1}: one lookup`);
    }
    assert.strictEqual((await list({'X-Forwarded-For': '198.51.100.61', 'X-CH-Key': 'list-unknown-3'})).status, 429, 'three lists spent a budget of three');
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
