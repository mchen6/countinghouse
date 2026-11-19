'use strict';
// The grants a tools/call is answered by (the reviewer's ruling on #457's
// probe, B-uniform): a tool the caller can't see -- outside its grants, an
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
  let grants;
  const savedDebug = options.debug;
  const asked = (fn, key) => new Promise((resolve, reject) => fn(key, (err, g) => (err ? reject(err) : resolve(g))));
  beforeEach(() => {
    options.debug = false;
    t = 1000;
    reads = [];
    grants = {'key-a': ['d1'], 'key-all': ['*']};
    registry.resetGrantsForTests({now: () => t, read: (key, cb) => { reads.push(key); setImmediate(cb, null, {devices: grants[key] || []}); }});
  });
  afterEach(() => { options.debug = savedDebug; registry.resetGrantsForTests(); });

  it('a call reads the provider once, then answers from the set until it is 5 s old', async () => {
    assert.deepStrictEqual([...await asked(registry.grantsForCall, 'key-a')], ['d1']);
    assert.deepStrictEqual([...await asked(registry.grantsForCall, 'key-a')], ['d1']);
    assert.strictEqual(reads.length, 1);
    t += registry.GRANT_TTL_MS - 1;
    await asked(registry.grantsForCall, 'key-a');
    assert.strictEqual(reads.length, 1, 'still fresh');
    t += 1;
    grants['key-a'] = ['d2'];
    assert.deepStrictEqual([...await asked(registry.grantsForCall, 'key-a')], ['d2'], 'read again at 5 s');
    assert.strictEqual(reads.length, 2);
    assert.strictEqual(registry.GRANT_TTL_MS, 5000);
  });

  it('every list\'s read refreshes it; a wildcard is kept as every device', async () => {
    await asked(registry.grantedDevices, 'key-all');
    t += 4000;
    assert.strictEqual(await asked(registry.grantsForCall, 'key-all'), null);
    assert.strictEqual(reads.length, 1, 'from the list\'s read');
    t += 4000;
    await asked(registry.grantedDevices, 'key-all');
    t += 4000;
    await asked(registry.grantsForCall, 'key-all');
    assert.strictEqual(reads.length, 2, 'the second list read refreshed it');
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

  it('no key: no device, no read; --debug: every device, no read; a provider failure is not kept', async () => {
    assert.deepStrictEqual([...await asked(registry.grantsForCall, null)], []);
    options.debug = true;
    assert.strictEqual(await asked(registry.grantsForCall, 'key-a'), null);
    options.debug = false;
    assert.deepStrictEqual(reads, []);
    registry.resetGrantsForTests({now: () => t, read: (key, cb) => { reads.push(key); setImmediate(cb, Object.assign(new Error('down'), {code: 'SYSTEM_ERROR_USERDB_NA'})); }});
    await assert.rejects(asked(registry.grantsForCall, 'key-a'), (e) => e.code === 'SYSTEM_ERROR_USERDB_NA');
    await assert.rejects(asked(registry.grantsForCall, 'key-a'));
    assert.strictEqual(reads.length, 2, 'read again');
  });
});
