'use strict';
// The grants a tools/call is answered by (the reviewer's rulings on #457's
// probe, B-uniform): no key or an unknown key is refused as such, whatever
// the name; a known key's tool it can't see -- outside its grants, an
// unlisted part outside them, or a name never registered -- gets one
// answer, decided before anything module-specific runs, from the key's
// grant set kept here so a call adds no provider read. The set only
// chooses the answer; authorisation stays userAuth's fresh read on every
// call.
// - kept only for a key a call has resolved, by a digest of the key
//   (lib/key-fingerprint.js meterId), never the key; known for 5 s from
//   that resolution, which only a call renews;
// - the set 5 s at most (GRANT_TTL_MS), refreshed by every list's read of a
//   kept key, which adds no key;
// - cleared by any successful reload of the auth config, and a read begun
//   before it is not kept after it;
// - at most 1024 keys (GRANT_CACHE_MAX), the oldest out first.
const assert = require('assert');
const options = require('../../lib/cli-options');

describe('mcp-contract 40: the grant set a tools/call is answered by (unit)', () => {
  // (set in before() and put back in after(): nothing at load; the registry
  // required once Redis points at port 1, where nothing listens)
  let registry;
  let savedOptions;
  const {snapshot: optionsNow, restore: restoreOptions} = require('../helpers/options-scope');
  before(() => {
    // every option kept and put back (a setOptions of a few would reset the
    // rest to their defaults for the files after this one: B-loadopts)
    savedOptions = optionsNow();
    options.setOptions({redisUrl: 'redis://127.0.0.1:1'});
    require('../../lib/logger').createLogger();
    registry = require('../../lib/mcp/tool-registry');
  });
  after(() => { restoreOptions(savedOptions); });
  let t;
  let reads;
  let ids;
  let grants;
  let knownKeys;
  let held;      // a provider read held back by a test, or null
  const UNKNOWN = Object.assign(new Error('Unknown user'), {code: 'SYSTEM_ERROR_UNKNOWN_USER'});
  const identify = (key, cb) => { ids.push(key); setImmediate(cb, knownKeys.has(key) ? null : UNKNOWN); };
  const call = (key) => new Promise((resolve, reject) => registry.grantsForCall(key, identify, (err, g) => (err ? reject(err) : resolve(g))));
  const list = (key) => new Promise((resolve, reject) => registry.grantedDevices(key, (err, g) => (err ? reject(err) : resolve(g))));
  beforeEach(() => {
    options.debug = false;
    t = 1000;
    reads = [];
    ids = [];
    held = null;
    grants = {'key-a': ['d1'], 'key-all': ['*']};
    knownKeys = new Set(['key-a', 'key-all']);
    registry.resetGrantsForTests({now: () => t, read: (key, cb) => {
      reads.push(key);
      const answer = () => cb(null, {devices: grants[key] || []});
      if (held === 'hold') held = answer; else setImmediate(answer);
    }});
  });
  afterEach(() => { options.debug = savedOptions.debug; registry.resetGrantsForTests(); });

  it('a call resolves the key and reads its grants once, then answers from the set until it is 5 s old', async () => {
    assert.deepStrictEqual([...await call('key-a')], ['d1']);
    assert.deepStrictEqual([...await call('key-a')], ['d1']);
    assert.deepStrictEqual([reads, ids], [['key-a'], ['key-a']]);
    t += registry.GRANT_TTL_MS - 1;
    await call('key-a');
    assert.strictEqual(reads.length, 1, 'still fresh');
    t += 1;
    grants['key-a'] = ['d2'];
    assert.deepStrictEqual([...await call('key-a')], ['d2'], 'read again at 5 s');
    assert.deepStrictEqual([reads.length, ids.length], [2, 2]);
    assert.strictEqual(registry.GRANT_TTL_MS, 5000);
  });

  it('a list\'s read refreshes a kept key\'s set, never that it is known: a call resolves the key again 5 s after the last resolution', async () => {
    assert.strictEqual(await call('key-all'), null);
    t += 4000;
    await list('key-all');
    t += 2000;
    // the set is fresh (2 s), the resolution is not (6 s): resolved again, not read again
    assert.strictEqual(await call('key-all'), null);
    assert.deepStrictEqual([reads.length, ids.length], [2, 2]);
  });

  it('a key removed outside a reload, though lists keep its set fresh, is refused once its resolution is 5 s old', async () => {
    await call('key-a');
    knownKeys.delete('key-a');
    for (let i = 0; i < 3; i++) { t += 2000; await list('key-a'); }
    await assert.rejects(call('key-a'), (e) => e === UNKNOWN);
  });

  it('a list\'s read keeps nothing for a key no call has resolved: an unknown key, or a known one', async () => {
    for (let i = 0; i < 5; i++) await list(`random-${i}`);
    await list('key-a');
    assert.deepStrictEqual(registry.grantKeysForTests(), []);
  });

  it('no key and an unknown key: the auth refusal, every time, nothing kept', async () => {
    for (const key of [null, 'not-a-key', 'not-a-key']) await assert.rejects(call(key), (e) => e === UNKNOWN);
    assert.deepStrictEqual(ids, [null, 'not-a-key', 'not-a-key']);
    assert.deepStrictEqual(registry.grantKeysForTests(), []);
  });

  it('a reload clears every key\'s, and a read begun before it is not kept after it', async () => {
    await call('key-a');
    registry.forgetGrants();
    assert.deepStrictEqual(registry.grantKeysForTests(), []);
    held = 'hold';
    const pending = call('key-a');
    while (typeof(held) !== 'function') await new Promise((r) => setImmediate(r));
    registry.forgetGrants();
    held();
    assert.deepStrictEqual([...await pending], ['d1'], 'answered with what it read');
    assert.deepStrictEqual(registry.grantKeysForTests(), [], 'but not kept');
  });

  it('kept by a digest of the key, never the key; at most 1024 keys, the oldest out first', async () => {
    for (let i = 0; i < registry.GRANT_CACHE_MAX + 1; i++) knownKeys.add(`key-${i}`);
    for (let i = 0; i < registry.GRANT_CACHE_MAX + 1; i++) await call(`key-${i}`);
    const kept = registry.grantKeysForTests();
    assert.strictEqual(kept.length, registry.GRANT_CACHE_MAX);
    assert.strictEqual(registry.GRANT_CACHE_MAX, 1024);
    assert.ok(kept.every((k) => /^sha256:[0-9a-f]{64}$/.test(k)), kept[0]);
    assert.ok(!kept.some((k) => k.includes('key-')));
    reads = [];
    await call('key-0');
    assert.deepStrictEqual(reads, ['key-0'], 'the oldest went first');
    await call(`key-${registry.GRANT_CACHE_MAX}`);
    assert.deepStrictEqual(reads, ['key-0'], 'the newest stayed');
  });

  it('--debug: the key is still resolved (as --debugKey would have it), every device, nothing read or kept', async () => {
    options.debug = true;
    assert.strictEqual(await call('key-a'), null);
    await assert.rejects(call('not-a-key'), (e) => e === UNKNOWN);
    assert.deepStrictEqual(ids, ['key-a', 'not-a-key']);
    assert.deepStrictEqual(reads, []);
    assert.deepStrictEqual(registry.grantKeysForTests(), []);
  });

  it('a key never seen is resolved first and its grants read only if it resolves; a lapsed key\'s two reads run side by side', async () => {
    const order = [];
    const slowIdentify = (key, cb) => { order.push(`identify ${key}`); setImmediate(() => { order.push(`identified ${key}`); cb(knownKeys.has(key) ? null : UNKNOWN); }); };
    registry.resetGrantsForTests({now: () => t, read: (key, cb) => { order.push(`read ${key}`); setImmediate(cb, null, {devices: grants[key] || []}); }});
    const callWith = (key) => new Promise((resolve, reject) => registry.grantsForCall(key, slowIdentify, (err, g) => (err ? reject(err) : resolve(g))));
    await callWith('key-a');
    assert.deepStrictEqual(order, ['identify key-a', 'identified key-a', 'read key-a'], 'never seen: the key first');
    order.length = 0;
    t += registry.GRANT_TTL_MS;
    await callWith('key-a');
    assert.deepStrictEqual(order.slice(0, 2).sort(), ['identify key-a', 'read key-a'], 'lapsed: both begun before either answers');
    order.length = 0;
    await assert.rejects(callWith('never-seen'), (e) => e === UNKNOWN);
    assert.deepStrictEqual(order, ['identify never-seen', 'identified never-seen'], 'an unknown key costs one read');
    assert.strictEqual(registry.grantKeysForTests().length, 1, 'and is not kept');
  });

  it('a call\'s resolution renews that the key is known even when a later list read kept the set (#458\'s high review, 4)', async () => {
    await call('key-a');
    t += registry.GRANT_TTL_MS;
    // the call's read held back; a list's read, begun after it, lands first
    const answers = [];
    registry.resetGrantsForTests({now: () => t, read: (key, cb) => answers.push(cb)});
    knownKeys.add('key-a');
    const first = call('key-a');
    while (answers.length < 1) await new Promise((res) => setImmediate(res));
    answers[0](null, {devices: ['d1']});
    await first;
    t += registry.GRANT_TTL_MS;
    const lapsed = call('key-a');
    while (answers.length < 2) await new Promise((res) => setImmediate(res));
    t += 1;
    const listed = list('key-a');
    while (answers.length < 3) await new Promise((res) => setImmediate(res));
    answers[2](null, {devices: ['d1']});
    await listed;
    answers[1](null, {devices: ['d1']});
    await lapsed;
    ids.length = 0;
    await call('key-a');
    assert.deepStrictEqual(ids, [], 'known from the call\'s resolution: not resolved again');
  });

  it('of two reads in flight, the older answer never overwrites the newer', async () => {
    await call('key-a');
    t += registry.GRANT_TTL_MS;
    const answers = [];
    registry.resetGrantsForTests({now: () => t, read: (key, cb) => answers.push(cb)});
    // the reset forgot key-a: make it known again, then let its set lapse
    knownKeys.add('key-a');
    const first = call('key-a');
    while (answers.length < 1) await new Promise((r) => setImmediate(r));
    answers[0](null, {devices: ['old']});
    await first;
    t += registry.GRANT_TTL_MS;
    const older = call('key-a');
    while (answers.length < 2) await new Promise((r) => setImmediate(r));
    t += 1;
    const newer = call('key-a');
    while (answers.length < 3) await new Promise((r) => setImmediate(r));
    answers[2](null, {devices: ['new']});
    await newer;
    answers[1](null, {devices: ['old']});
    await older;
    assert.deepStrictEqual([...await call('key-a')], ['new']);
  });

  it('whether the key is an admin\'s comes with the set, as it resolved, and is kept with its resolution', async () => {
    const asAdmin = (key, cb) => { ids.push(key); setImmediate(cb, null, {isAdmin: key === 'key-all'}); };
    const who = (key) => new Promise((resolve, reject) => registry.grantsForCall(key, asAdmin, (err, g, unread, w) => (err ? reject(err) : resolve(w))));
    assert.deepStrictEqual(await who('key-all'), {isAdmin: true});
    assert.deepStrictEqual(await who('key-a'), {isAdmin: false});
    assert.deepStrictEqual(await who('key-all'), {isAdmin: true}, 'kept: no resolution');
    assert.deepStrictEqual(ids, ['key-all', 'key-a']);
  });

  it('grants the provider could not read: the key resolved, no set, said apart from an auth refusal, and not kept', async () => {
    const down = Object.assign(new Error('down'), {code: 'SYSTEM_ERROR_USERDB_NA'});
    registry.resetGrantsForTests({now: () => t, read: (key, cb) => { reads.push(key); setImmediate(cb, down); }});
    const both = (key) => new Promise((resolve) => registry.grantsForCall(key, identify, (err, granted, unread) => resolve({err, granted, unread})));
    assert.deepStrictEqual(await both('key-a'), {err: null, granted: undefined, unread: down});
    assert.deepStrictEqual(await both('key-a'), {err: null, granted: undefined, unread: down});
    assert.strictEqual(reads.length, 2, 'read again');
    assert.deepStrictEqual(registry.grantKeysForTests(), []);
    // an unknown key is still its auth refusal, not the provider's failure
    assert.strictEqual((await both('not-a-key')).err, UNKNOWN);
  });

  it('no key reads no grants; a lapsed resolution whose entry went meanwhile keeps nothing and throws nothing', async () => {
    await assert.rejects(call(null), (e) => e === UNKNOWN);
    assert.deepStrictEqual(reads, []);
    await call('key-a');
    t += registry.GRANT_TTL_MS;
    // the set refreshed by a list (fresh), the resolution lapsed: only identify runs
    await list('key-a');
    let release;
    const held = new Promise((r) => { release = r; });
    const pending = new Promise((resolve, reject) => registry.grantsForCall('key-a', (key, cb) => held.then(() => cb(null)), (err, g) => (err ? reject(err) : resolve(g))));
    // the entry pushed out by the bound while identify is in flight (the
    // generation unchanged, so the call goes on to keep)
    for (let i = 0; i < registry.GRANT_CACHE_MAX; i++) { knownKeys.add(`other-${i}`); await call(`other-${i}`); }
    assert.ok(!registry.grantKeysForTests().includes(require('../../lib/key-fingerprint').meterId('key-a')));
    release();
    assert.deepStrictEqual([...await pending], ['d1']);
    assert.ok(!registry.grantKeysForTests().includes(require('../../lib/key-fingerprint').meterId('key-a')), 'nothing renewed');
  });
});
