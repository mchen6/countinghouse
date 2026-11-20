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
const {createLimiter, addressKeyOf, prefixKeyOf, keyResolvedBy, WINDOW_MS, PREFIX_FACTOR, GLOBAL_FACTOR} = unauthLimit;
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

  // (the high review of #483, round 2, 2-4) three windows, each always
  // applied: the address (IPv6 /64, IPv4 address), its prefix (IPv6 /48,
  // IPv4 /24) at ten times, the process at a hundred times; no table-state
  // switch, so no cliff below a full table, no lockout past it, and the
  // table's eviction opens no hole
  const v6 = (prefix48, i) => `${prefix48}:${(i % 65536).toString(16)}::1`;
  const sprayed = (l, addresses) => {
    let taken = 0;
    for (const raw of addresses) {
      const a = addressKeyOf(raw);
      if (l.retryAfterMs(a) === 0) { l.refused(a); taken++; }
    }
    return taken;
  };

  it('a spray over many /64s of one /48 is held to the prefix limit, below any table limit (no cliff)', () => {
    const l = createLimiter({perMinute: 2, now: clock});
    const taken = sprayed(l, Array.from({length: 10 * 1000 - 1}, (_, i) => v6('2001:db8:aa', i)));
    assert.ok(taken <= 2 * PREFIX_FACTOR, `${taken} lookups over 9,999 /64s of one /48 (limit ${2 * PREFIX_FACTOR})`);
    assert.strictEqual(sprayed(l, ['10.9.9.9']), 1, 'another client, elsewhere, is not refused');
  });

  it('a spray over many prefixes is held to the process limit; it is the one cost, and a key that resolved passes all three', () => {
    const l = createLimiter({perMinute: 2, now: clock, maxAddresses: 50, maxPrefixes: 50});
    const taken = sprayed(l, Array.from({length: 2000}, (_, i) => v6(`2001:db8:${(i + 1).toString(16)}`, 1)));
    assert.ok(taken <= 2 * GLOBAL_FACTOR, `${taken} lookups over 2,000 /48s (limit ${2 * GLOBAL_FACTOR})`);
    assert.ok(l.retryAfterMs(addressKeyOf('10.9.9.8')) > 0, 'the accepted cost: under a spray that fills the process limit, an unremembered client waits');
    l.resolved('a-valid-key');
    assert.strictEqual(l.resolvedLately('a-valid-key'), true, 'a key that resolved lately is let past every window (beforeLookup)');
  });

  it('below the process limit, a valid new client past a full table is not refused: the table is for memory only', () => {
    const l = createLimiter({perMinute: 2, now: clock, maxAddresses: 20, maxPrefixes: 20});
    // 40 prefixes, one lookup each: the tables are full, the process limit (200) is not
    sprayed(l, Array.from({length: 40}, (_, i) => `10.${i + 20}.0.1`));
    assert.strictEqual(l.sizes().addresses, 20);
    for (let i = 0; i < 50; i++) assert.strictEqual(l.retryAfterMs(addressKeyOf(`172.16.${i}.1`)), 0, `never-seen client ${i}`);
  });

  it('an address pushed out of the table opens no hole: its prefix still holds what it held', () => {
    const l = createLimiter({perMinute: 2, now: clock, maxAddresses: 3});
    const taken = sprayed(l, Array.from({length: 600}, (_, i) => `10.200.0.${i % 250}`).concat(Array.from({length: 600}, (_, i) => `10.200.0.${i % 250}`)));
    assert.ok(taken <= 2 * PREFIX_FACTOR, `${taken} lookups cycling over 250 addresses of one /24 with a table of 3 (limit ${2 * PREFIX_FACTOR})`);
  });

  it('emptied windows leave the table, in no reliance on its order', () => {
    const l = createLimiter({perMinute: 2, now: clock, maxAddresses: 5});
    for (let i = 0; i < 5; i++) l.refused(`10.${i + 50}.0.1`);
    // the oldest is counted again: the Map's first is now a younger one
    t += 5000;
    l.refused('10.50.0.1');
    // every window but 10.50.0.1's has emptied; a new address sweeps them
    t += WINDOW_MS - 4000;
    l.refused('10.99.0.1');
    assert.strictEqual(l.sizes().addresses, 2, JSON.stringify(l.sizes()));
  });

  it('the prefixes: an IPv4 address\'s /24, an IPv6 /64\'s /48', () => {
    assert.strictEqual(prefixKeyOf(addressKeyOf('10.1.2.3')), '10.1.2.0/24');
    assert.strictEqual(prefixKeyOf(addressKeyOf('::ffff:10.1.2.3')), '10.1.2.0/24');
    assert.strictEqual(prefixKeyOf(addressKeyOf('2001:db8:1:2::5')), '2001:db8:1::/48');
    assert.strictEqual(prefixKeyOf('not-an-address'), 'not-an-address');
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
  // (a closure kept for later runs in the request's own async context, as a
  // worker's message or a listener set up in it would)
  const {AsyncResource} = require('async_hooks');
  // a request from `ip` carrying `key`: a fake res (an emitter, as express's
  // is), run through the middleware; fn runs inside it
  const request = (ip, key, fn) => {
    const res = Object.assign(new EventEmitter(), {headers: {}, set(name, value) { res.headers[name] = value; return res; }, status(code) { res.code = code; return res; }, json() { return res; }});
    let out = null;
    unauthLimit.middleware()({ip, headers: key != null ? {'x-ch-key': key} : {}, socket: {}}, res, () => { out = fn(); });
    if (res.code != null) assert.strictEqual(res.code, 429);
    return {out, res, end: () => res.emit('finish')};
  };
  // a lookup of key inside a request from `ip`, as a route makes one; null
  // when the middleware answers 429 itself (it sees lookups in flight too)
  const inRequest = (ip, key) => request(ip, key, () => unauthLimit.beforeLookup(key)).out;

  it('lookups begun at once take the budget before any answers; one whose key resolves gives its place back; outside a request nothing is limited', () => {
    const a = inRequest('10.1.0.1', 'k-one');
    const b = inRequest('10.1.0.1', 'k-two');
    assert.ok(a != null && b != null);
    assert.strictEqual(inRequest('10.1.0.1', 'k-three'), null, 'two in flight fill a budget of two');
    a.resolved();
    const c = inRequest('10.1.0.1', 'k-three');
    assert.ok(c != null, 'a resolved key frees its place');
    b.refused();
    c.refused();
    assert.strictEqual(inRequest('10.1.0.1', 'k-four'), null);
    assert.ok(inRequest('10.1.0.1', 'k-one') != null, 'a key that resolved lately passes');
    assert.ok(unauthLimit.beforeLookup('k-five') != null, 'not in an HTTP request: no limit');
  });

  it('a key refused now leaves the set of keys that resolved: a revoked key is counted again (the high review of #483, 2)', () => {
    const ip = '10.2.0.1';
    inRequest(ip, 'k-revoked').resolved();
    for (let i = 0; i < 2; i++) {
      const l = inRequest(ip, 'k-revoked');
      assert.ok(l != null, `lookup ${i + 1} of the revoked key`);
      l.refused();
    }
    assert.strictEqual(inRequest(ip, 'k-revoked'), null, 'after two refusals (the budget) the revoked key is limited like any other');
  });

  // (the medium on round 1, 2) a provider that failed is not an answer: the
  // lookup counts, but a key that resolved is not forgotten for it
  it('a provider failure counts, but does not drop a valid key from those that resolved', () => {
    const ip = '10.5.0.1';
    inRequest(ip, 'k-flaky').resolved();
    for (let i = 0; i < 3; i++) {
      const l = inRequest(ip, 'k-flaky');
      assert.ok(l != null);
      l.refused(false);
    }
    assert.ok(inRequest(ip, 'k-flaky') != null, 'still a key that resolved lately, over its address\'s budget');
    assert.strictEqual(inRequest(ip, 'k-other-unknown'), null, 'the failures counted');
  });

  // (the medium on round 1, 3 and 4) the request's store holds digests, not
  // keys; a key that resolved lately passes the gate in any header a route reads
  it('the request\'s store holds no raw key, and a resolved key in X-App-Key passes the gate behind a junk X-CH-Key', () => {
    const ip = '10.6.0.1';
    const secret = 'k-raw-secret-0123456789';
    let seen = null;
    request(ip, secret, () => { seen = JSON.stringify(unauthLimit.requestStoreForTests()); return null; });
    assert.ok(seen != null && !seen.includes(secret), seen);
    inRequest(ip, secret).resolved();
    for (let i = 0; i < 2; i++) inRequest(ip, `junk-${i}`).refused();
    let passed = false;
    const res = Object.assign(new (require('events').EventEmitter)(), {set() { return res; }, status(code) { res.code = code; return res; }, json() { return res; }});
    unauthLimit.middleware()({ip, headers: {'x-ch-key': 'junk-first', 'x-app-key': secret}, socket: {}}, res, () => { passed = true; });
    assert.strictEqual(passed, true, `the gate answered ${res.code}`);
  });

  // (the high review of #483, round 2, 1) a client that resets its socket
  // after sending a batch: the rest of it still counts
  it('a request whose connection closes before its answer is still counted', () => {
    const ip = '10.7.0.1';
    const later = [];
    const r = request(ip, 'k-reset', () => { later.push(AsyncResource.bind(() => unauthLimit.beforeLookup('k-reset'))); return null; });
    r.res.emit('close');
    for (let i = 0; i < 2; i++) { const l = later[0](); assert.ok(l != null); l.refused(); }
    assert.strictEqual(inRequest(ip, 'k-reset-2'), null, 'the batch\'s lookups after the reset counted');
  });

  // (the medium on round 2, 1) a request whose answer was destroyed, never
  // finished: counted for one more window after its close, then no more
  it('a closed, never-finished request counts its own lookups for one window, then none', () => {
    const ip = '10.9.0.1';
    const later = [];
    const r = request(ip, 'k-gone', () => { later.push(AsyncResource.bind(() => unauthLimit.beforeLookup('k-gone'))); later.push(AsyncResource.bind(() => unauthLimit.requestStoreForTests())); return null; });
    r.res.emit('close');
    const own = later[1]();
    assert.ok(own != null && own.closedAt != null, 'the close is noted');
    own.closedAt = Date.now() - WINDOW_MS - 1;   // a window past it
    for (let i = 0; i < 3; i++) { const l = later[0](); assert.ok(l != null); l.refused(); }
    assert.ok(inRequest(ip, 'k-other') != null, 'nothing counted a window after the close');
  });

  // (the medium on round 2, 2) a window full only because lookups are in
  // flight asks the caller back in a second, not a minute
  it('Retry-After is a second while the window is full of lookups in flight', () => {
    const ip = '10.11.0.1';
    inRequest(ip, 'k-flight-1');
    inRequest(ip, 'k-flight-2');
    const r = request(ip, 'k-flight-3', () => 'passed');
    assert.strictEqual(r.out, null);
    assert.strictEqual(r.res.code, 429);
    assert.strictEqual(r.res.headers['Retry-After'], '1');
  });

  // (the medium on round 2, 4) --debug's own key is remembered as resolved
  it('a key resolved without a lookup (--debug\'s debugKey) passes its address\'s limit as any resolved key', () => {
    const ip = '10.12.0.1';
    request(ip, 'k-debug', () => unauthLimit.keyResolved('k-debug'));
    for (let i = 0; i < 2; i++) inRequest(ip, `junk-${i}`).refused();
    assert.ok(inRequest(ip, 'k-debug') != null);
  });

  // (the medium on round 2, 3) a job a request queues runs outside it
  it('a local job queued in a request runs with no request\'s address', async () => {
    const {createRunner} = require('../../lib/job-control-local');
    const runner = createRunner({jobTimeoutMs: 0});
    runner.authorizeRun = () => Promise.resolve();
    let seen;
    const ran = new Promise((resolve) => runner.initJobProcess({recordCall: (k, t, c, cb) => cb && cb(null),
      invokeJobs: (d, sv, a, input, id, cb) => { seen = unauthLimit.requestStoreForTests(); resolve(); cb(null, {}); }}));
    const wt = options.workerThread;
    options.workerThread = true;
    try {
      request('10.13.0.1', 'k-queue', () => { runner.addJob({appKey: 'k-queue', isAdmin: false}, {name: 'n'}, 'd', 's', 'a', {}, () => undefined); return null; });
      await ran;
      assert.strictEqual(seen, undefined, 'the job ran in the queuing request\'s store');
    } finally {
      options.workerThread = wt;
      runner.close();
    }
  });

  // (round 2, 8) a lookup with no key is the route reading none, whatever
  // headers came: an empty X-CH-Key, a header /mcp does not read
  it('a lookup with no key counts, though the request carried headers the route did not read', () => {
    const ip = '10.8.0.1';
    const {EventEmitter} = require('events');
    for (let i = 0; i < 2; i++) {
      const res = Object.assign(new EventEmitter(), {set() { return res; }, status(code) { res.code = code; return res; }, json() { return res; }});
      unauthLimit.middleware()({ip, headers: {'x-app-key': 'not-read-by-mcp', 'x-ch-key': ''}, socket: {}}, res, () => {
        // (lib/user-auth.js: no key is refused with no lookup)
        unauthLimit.keyRefused(null);
      });
    }
    assert.strictEqual(inRequest(ip, 'k-after'), null, 'both key-less lookups counted');
  });

  // (the high review of #483, 4) the address is the request's own: a lookup
  // after its request has ended (a worker it spawned, a listener it set up),
  // or of another key than the request's (a change notice's re-listing for
  // another subscriber), is not counted against it
  it('a lookup made after its request ended, or of a key the request did not carry, is not counted against the request\'s address', () => {
    const ip = '10.3.0.1';
    const later = [];
    const r = request(ip, 'k-own', () => { later.push(AsyncResource.bind(() => unauthLimit.beforeLookup('k-own'))); return null; });
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
    const ip = '10.4.0.1';
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

  it('a hop count outside 1 to 10, or not whole, is refused as that', () => {
    for (const v of [0, 1.5, 11, '0']) {
      const r = parsed(v);
      assert.ok(r.trust == null && r.invalid != null && /whole number of hops from 1 to 10/.test(r.invalid.why), `${JSON.stringify(v)}: ${JSON.stringify(r.invalid)}`);
    }
  });

  it('refuses each wide form', () => {
    for (const v of ['0.0.0.0/0', '::/0', '::ffff:0.0.0.0/96', '::ffff:0:0/96', '0.0.0.0/1,128.0.0.0/1', '10.0.0.0/7', '11.0.0.0/8,12.0.0.0/8',
      '11.0.0.0/8,192.0.2.0/24', '::ffff:10.0.0.0/103', '2001:db8::/31', '2001:db8::/32,2001:db9::/32', 11, true, '']) {
      const r = parsed(v);
      assert.ok(r.trust == null && r.invalid != null, `${JSON.stringify(v)} was taken: ${JSON.stringify(r)}`);
    }
  });

  it('takes a /8 or narrower, overlapping entries counted once, and the named ranges', () => {
    for (const v of ['2', ['10.0.0.1', '10.0.0.2'], '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16', 'fc00::/7', '10.0.0.0/8', '203.0.113.7', '::ffff:10.0.0.0/104', '10.0.0.0/9,10.128.0.0/9', '10.0.0.0/8,10.1.0.0/16', '2001:db8::/32',
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
    // (the medium on round 1, 5) a job's owner check met by the limit is retried, never failed for good
    const job = spawnSync(process.execPath, ['-e', `
      const path = require('path');
      const ROOT = ${JSON.stringify(path.resolve(__dirname, '..', '..'))};
      const {CountinghouseError} = require(path.join(ROOT, 'lib/countinghouse-error'));
      require.cache[require.resolve(path.join(ROOT, 'lib/user-auth'))] = {id: 'stub', loaded: true,
        exports: (req, res, d, k, s, a, cb, callback) => callback(new CountinghouseError('UNAUTH_RATE_LIMITED'))};
      require(path.join(ROOT, 'lib/job-control-common')).authorizeOwner({apiKey: 'k', deviceID: 'd', serviceID: 's', actionName: 'a'}, 'j', 5000)
        .then(() => console.log('resolved'), (e) => console.log(JSON.stringify({final: e.final})));
    `], {encoding: 'utf8', timeout: 20000});
    assert.strictEqual(job.stdout.trim(), '{"final":false}', job.stderr);
    const batched = answers[5];
    assert.strictEqual(batched.status, 200, batched.body);
    assert.ok(Number(batched.retryAfter) >= 1, `a batch with a limited message carries Retry-After: ${batched.retryAfter}`);
    const [m] = JSON.parse(batched.body);
    assert.deepStrictEqual([m.id, m.error.code, m.error.data.code], [8, -32000, 'UNAUTH_RATE_LIMITED'], batched.body);
    assert.strictEqual(m.error.message, one.error.message);
  });
});

// (the high review of #483, round 2, 7) every error the gateway answers by
// its own message goes through identityRefusal, so the limit, wherever it
// is met, answers in the one shape (rpcLimited)
describe('auth 59: the gateway answers an error by one path', () => {
  it('no JSON-RPC error is made from an error\'s message but by identityRefusal', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'mcp', 'gateway.js'), 'utf8');
    const direct = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /JSONRPC_INTERNAL_ERROR, *[A-Za-z]+\.message \|\|/.test(l));
    assert.deepStrictEqual(direct.map(([n]) => n), [], direct.map(([n, l]) => `${n}: ${l.trim()}`).join('\n'));
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
  // its listDevices calls ('l')
  const listDevicesCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l === 'l').length : 0);
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
      const other = await mcp(port, as('10.120.0.1', {'X-CH-Key': 'unknown-4'}));
      assert.notStrictEqual(other.status, 429, 'another client behind the trusted proxy has its own budget');
    });

    it('requests sent at once cost no more lookups than the budget', async () => {
      const before = providerCalls();
      const answers = await Promise.all(Array.from({length: 12}, (_, i) => mcp(port, as('10.130.0.1', {'X-CH-Key': `at-once-${i}`}))));
      assert.ok(providerCalls() - before <= 3, `${providerCalls() - before} lookups for 12 requests at once`);
      assert.ok(answers.some((a) => a.status === 429 || a.body.includes('UNAUTH_RATE_LIMITED') || a.body.includes('Too many requests')), JSON.stringify(answers.map((a) => a.status)));
    });

    it('a legacy batch of 32 calls under one unknown key costs no more lookups than the budget', async () => {
      const before = providerCalls();
      const batch = Array.from({length: 32}, (_, i) => ({jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: {name: 'echo_device_echoservice_echo', arguments: {}}}));
      const r = await send(port, '/mcp', batch, as('10.140.0.1', {'X-CH-Key': 'batch-unknown'}));
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
      const first = await get(as('10.150.0.1', {'X-CH-Key': KEY}));
      assert.strictEqual(first.status, 200, first.body);
      const before = providerCalls();
      for (let i = 0; i < 3; i++) {
        const r = await get(as('10.150.0.1', {'X-CH-Key': `dl-unknown-${i}`}));
        assert.deepStrictEqual([r.status, r.body], [200, '[]']);
      }
      const limited = await get(as('10.150.0.1', {'X-CH-Key': 'dl-unknown-3'}));
      assert.strictEqual(limited.status, 429, limited.body);
      assert.ok(Number(limited.retryAfter) >= 1);
      assert.strictEqual(providerCalls() - before, 3, 'one lookup each, none once limited');
      const mine = await get(as('10.150.0.1', {'X-CH-Key': KEY}));
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
      const r = await list({'X-Forwarded-For': '10.160.0.1'});
      assert.strictEqual(r.status, 200, r.body);
    }
    assert.strictEqual(authenticateCalls(), before, 'a keyless tools/list looks no key up');
    for (let i = 0; i < 3; i++) {
      const at = authenticateCalls();
      const read = listDevicesCalls();
      const r = await list({'X-Forwarded-For': '10.161.0.1', 'X-CH-Key': `list-unknown-${i}`});
      assert.strictEqual(r.status, 200, `list ${i + 1}: ${r.body}`);
      assert.ok(!r.body.includes('Too many requests'), `list ${i + 1}: ${r.body}`);
      assert.strictEqual(authenticateCalls() - at, 1, `list ${i + 1}: one lookup`);
      // (round 2, 5) and no grants read for a key that did not resolve
      assert.strictEqual(listDevicesCalls() - read, 0, `list ${i + 1}: the grants of a key that did not resolve were read`);
    }
    assert.strictEqual((await list({'X-Forwarded-For': '10.161.0.1', 'X-CH-Key': 'list-unknown-3'})).status, 429, 'three lists spent a budget of three');
  });

  it('a start with a bad --unauthRateLimit or --trustProxy is refused (exit 2)', async () => {
    for (const [flag, value] of [['--unauthRateLimit', '-1'], ['--unauthRateLimit', 'x'], ['--trustProxy', 'true'], ['--trustProxy', '10.0.0.1/40'],
      ['--trustProxy', '0.0.0.0/0'], ['--trustProxy', '::/0'], ['--trustProxy', '11'],
      // (round 2, 6) one the parse takes and Express cannot compile: exit 2 with the refusal, never a stack trace
      ['--trustProxy', '::1.2.3.4/96']]) {
      const s = await startServer(testPort(9701), ['--workerThread', flag, value], {expectExit: true});
      assert.strictEqual(s.exitCode, 2, `${flag} ${value}: ${s.output.slice(-400)}`);
      assert.ok(s.output.includes(flag), s.output.slice(-400));
      assert.ok(!/\n\s+at /.test(s.output), `a stack trace: ${s.output.slice(-400)}`);
    }
  });

  tmp.hooks();
});
