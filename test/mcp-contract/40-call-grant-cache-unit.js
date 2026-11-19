'use strict';
// The grants a tools/call is answered by (the reviewer's ruling on #457's
// probe, B-uniform): no key or an unknown key is refused as such, whatever
// the name; a known key's tool it can't see -- outside its grants, an
// unlisted part outside them, or a name never registered -- gets one answer,
// decided before anything module-specific runs, from the key's grant set
// kept here so a call adds no provider read. The set only chooses the
// answer; authorisation stays userAuth's fresh read on every call.
// - kept by a digest of the key (lib/key-fingerprint.js meterId), never the key;
// - 5 s at most (GRANT_TTL_MS), refreshed by every list's read
//   (grantedDevices), cleared by any successful reload of the auth config;
// - at most 1024 keys (GRANT_CACHE_MAX), the oldest out first.
const assert = require('assert');
const options = require('../../lib/cli-options');
options.setOptions({redisUrl: 'redis://127.0.0.1:1'});
require('../../lib/logger').createLogger();
const registry = require('../../lib/mcp/tool-registry');

describe('mcp-contract 40: the grant set a tools/call is answered by (unit)', () => {
  let t;
  let reads;
  let ids;
  let grants;
  const UNKNOWN = Object.assign(new Error('Unknown user'), {code: 'SYSTEM_ERROR_UNKNOWN_USER'});
  const savedDebug = options.debug;
  const asked = (fn, key) => new Promise((resolve, reject) => fn(key, (err, g) => (err ? reject(err) : resolve(g))));
  beforeEach(() => {
    options.debug = false;
    t = 1000;
    reads = [];
    ids = [];
    grants = {'key-a': ['d1'], 'key-all': ['*']};
    registry.resetGrantsForTests({now: () => t, read: (key, cb) => { reads.push(key); setImmediate(cb, null, {devices: grants[key] || []}); },
      identify: (key, cb) => { ids.push(key); setImmediate(cb, (typeof(key) === 'string' && key.startsWith('key-')) ? null : UNKNOWN); }});
  });
  afterEach(() => { options.debug = savedDebug; registry.resetGrantsForTests(); });

  it('a call resolves the key and reads its grants once, then answers from the set until it is 5 s old', async () => {
    assert.deepStrictEqual([...await asked(registry.grantsForCall, 'key-a')], ['d1']);
    assert.deepStrictEqual([...await asked(registry.grantsForCall, 'key-a')], ['d1']);
    assert.strictEqual(reads.length, 1);
    assert.deepStrictEqual(ids, ['key-a']);
    t += registry.GRANT_TTL_MS - 1;
    await asked(registry.grantsForCall, 'key-a');
    assert.strictEqual(reads.length, 1, 'still fresh');
    t += 1;
    grants['key-a'] = ['d2'];
    assert.deepStrictEqual([...await asked(registry.grantsForCall, 'key-a')], ['d2'], 'read again at 5 s');
    assert.strictEqual(reads.length, 2);
    assert.strictEqual(registry.GRANT_TTL_MS, 5000);
  });

  it('every list\'s read refreshes a known key\'s set; a wildcard is kept as every device', async () => {
    assert.strictEqual(await asked(registry.grantsForCall, 'key-all'), null);
    assert.strictEqual(reads.length, 1);
    t += 4000;
    await asked(registry.grantedDevices, 'key-all');
    t += 4000;
    assert.strictEqual(await asked(registry.grantsForCall, 'key-all'), null);
    assert.strictEqual(reads.length, 2, 'the list\'s read refreshed it: no read of its own');
    assert.deepStrictEqual(ids, ['key-all']);
  });

  it('a list\'s read alone makes no key known: the first call still resolves it', async () => {
    await asked(registry.grantedDevices, 'key-a');
    await asked(registry.grantsForCall, 'key-a');
    assert.deepStrictEqual(ids, ['key-a']);
  });

  it('no key and an unknown key: the auth refusal, every time, nothing kept, no grants read', async () => {
    for (const key of [null, 'not-a-key', 'not-a-key']) {
      await assert.rejects(asked(registry.grantsForCall, key), (e) => e === UNKNOWN);
    }
    assert.deepStrictEqual(ids, [null, 'not-a-key', 'not-a-key']);
    assert.deepStrictEqual(reads, []);
    assert.deepStrictEqual(registry.grantKeysForTests(), []);
  });

  it('a reload of the auth config clears every key\'s', async () => {
    await asked(registry.grantsForCall, 'key-a');
    registry.forgetGrants();
    grants['key-a'] = [];
    assert.deepStrictEqual([...await asked(registry.grantsForCall, 'key-a')], []);
    assert.strictEqual(reads.length, 2);
  });

  it('kept by a digest of the key, never the key; at most 1024 keys, the oldest out first', async () => {
    for (let i = 0; i < registry.GRANT_CACHE_MAX + 1; i++) await asked(registry.grantsForCall, `key-${i}`);
    const kept = registry.grantKeysForTests();
    assert.strictEqual(kept.length, registry.GRANT_CACHE_MAX);
    assert.strictEqual(registry.GRANT_CACHE_MAX, 1024);
    assert.ok(kept.every((k) => /^sha256:[0-9a-f]{64}$/.test(k)), kept[0]);
    assert.ok(!kept.some((k) => k.includes('key-')));
    reads = [];
    await asked(registry.grantsForCall, 'key-0');
    assert.deepStrictEqual(reads, ['key-0'], 'the oldest went first');
    await asked(registry.grantsForCall, `key-${registry.GRANT_CACHE_MAX}`);
    assert.deepStrictEqual(reads, ['key-0'], 'the newest stayed');
  });

  it('--debug: every device, nothing read; a provider failure is not kept', async () => {
    options.debug = true;
    assert.strictEqual(await asked(registry.grantsForCall, 'key-a'), null);
    options.debug = false;
    assert.deepStrictEqual(reads, []);
    assert.deepStrictEqual(ids, []);
    registry.resetGrantsForTests({now: () => t, identify: (key, cb) => cb(null),
      read: (key, cb) => { reads.push(key); setImmediate(cb, Object.assign(new Error('down'), {code: 'SYSTEM_ERROR_USERDB_NA'})); }});
    await assert.rejects(asked(registry.grantsForCall, 'key-a'), (e) => e.code === 'SYSTEM_ERROR_USERDB_NA');
    await assert.rejects(asked(registry.grantsForCall, 'key-a'));
    assert.strictEqual(reads.length, 2, 'read again');
  });
});
