// MCP completeness M5, spec section 2: the store's blobs part, where M6 keeps
// stored results. One suite, run against both implementations: --store redis
// (db 13, its own; one Lua script per put prunes, checks, charges and writes
// with the expiry) and --store local (owner-only files under
// <storePath>/resources/, data before meta, quotas under one mutex). Nothing
// is evicted early; get() answers null alike for unknown, expired and
// foreign; names carry the item id and the opaque owner id only.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createBlobs, BLOBS_DB} = require('../../lib/store/blobs');
const {redisUrlFor} = require('../helpers/test-env');

const OWNER_A = `u_${'A'.repeat(22)}`;
const OWNER_B = `u_${'B'.repeat(22)}`;
const KIB = 1024;
const LIMITS = {retentionMs: 60000, storeBytes: 64 * KIB, quotaBytes: 32 * KIB, quotaItems: 4, itemBytes: 16 * KIB};

function item(owner, n, extra = {}) {
  return Object.assign({owner, session: null, mimeType: 'application/pdf', bytes: crypto.randomBytes(n),
    source: {module: 'm', tool: 't', field: '/doc'}}, extra);
}
const fullOf = async (p) => {
  try { await p; } catch (e) { return e.code === 'RESULT_STORE_FULL' ? e.fields.limit : `other: ${e.code} ${e.message}`; }
  return null;
};

for (const kind of ['local', 'redis']) {
  describe(`store 07: blobs, --store ${kind}`, function() {
    this.timeout(30000);
    let t = Date.parse('2026-11-16T00:00:00Z');
    const now = () => t;
    const made = [];
    const roots = [];
    const prefix = `blobtest:${process.pid}:${crypto.randomBytes(4).toString('hex')}:`;
    const open = (limits = LIMITS, root = null) => {
      let dir = root;
      if (kind === 'local' && dir == null) {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-blobs-'));
        roots.push(dir);
      }
      const b = createBlobs({kind, storePath: dir, moduleDataPath: dir != null ? path.join(dir, 'module_data') : null,
        redisUrl: redisUrlFor(), prefix, limits, now});
      made.push(b);
      return b;
    };
    afterEach(async () => {
      const list = made.splice(0);
      for (const b of list) await b.clear().catch(() => {});
      for (const b of list) await b.close();
    });
    after(() => { for (const r of roots) fs.rmSync(r, {recursive: true, force: true}); });

    it('put then get: the bytes and the meta as stored, with a sha256 and the expiry', async () => {
      const b = open();
      const it0 = item(OWNER_A, 1000, {session: 's-1'});
      const {id, expiresAt} = await b.put(it0);
      assert.match(id, /^[A-Za-z0-9_-]{43}$/);
      assert.strictEqual(expiresAt, t + LIMITS.retentionMs);
      const got = await b.get(id, {owner: OWNER_A, session: 's-1'});
      assert.ok(got.bytes.equals(it0.bytes));
      assert.deepStrictEqual(got.meta, {id, owner: OWNER_A, session: 's-1', mimeType: 'application/pdf', bytes: 1000,
        sha256: crypto.createHash('sha256').update(it0.bytes).digest('hex'), createdAt: t, expiresAt, source: {module: 'm', tool: 't', field: '/doc'}});
    });

    it('get is null alike for unknown, malformed, foreign owner, foreign session and expired', async () => {
      const b = open();
      const {id} = await b.put(item(OWNER_A, 10, {session: 's-1'}));
      assert.strictEqual(await b.get(crypto.randomBytes(32).toString('base64url'), {owner: OWNER_A, session: 's-1'}), null);
      assert.strictEqual(await b.get('../../etc/passwd', {owner: OWNER_A, session: 's-1'}), null);
      assert.strictEqual(await b.get(id, {owner: OWNER_B, session: 's-1'}), null);
      assert.strictEqual(await b.get(id, {owner: OWNER_A, session: 's-2'}), null);
      assert.strictEqual(await b.get(id, {owner: OWNER_A, session: null}), null);
      t += LIMITS.retentionMs;
      assert.strictEqual(await b.get(id, {owner: OWNER_A, session: 's-1'}), null, 'expired at its expiresAt');
    });

    it('an item with no session is the owner\'s from any session', async () => {
      const b = open();
      const {id} = await b.put(item(OWNER_A, 10));
      assert.notStrictEqual(await b.get(id, {owner: OWNER_A, session: 's-9'}), null);
      assert.notStrictEqual(await b.get(id, {owner: OWNER_A, session: null}), null);
    });

    it('the owner must be an opaque caller id: a key or a user name is refused at put', async () => {
      const b = open();
      for (const owner of ['aabbcc', 'alice', 'u_short', null, `u_${'A'.repeat(22)}/x`]) {
        await assert.rejects(b.put(item(owner, 10)), (e) => e instanceof TypeError, String(owner));
      }
    });

    it('one item over its cap is refused, naming the limit', async () => {
      const b = open();
      assert.strictEqual(await fullOf(b.put(item(OWNER_A, LIMITS.itemBytes + 1))), 'item');
    });

    it('an owner\'s bytes: refused past them; nothing is evicted to make room', async () => {
      const b = open();
      const first = await b.put(item(OWNER_A, 15 * KIB));
      await b.put(item(OWNER_A, 15 * KIB));
      assert.strictEqual(await fullOf(b.put(item(OWNER_A, 3 * KIB))), 'resourceQuotaBytes');
      assert.notStrictEqual(await b.get(first.id, {owner: OWNER_A, session: null}), null, 'the oldest is still there');
    });

    it('all owners\' bytes: refused past --resourceStoreBytes, whoever asks', async () => {
      const b = open(Object.assign({}, LIMITS, {storeBytes: 20 * KIB}));
      await b.put(item(OWNER_A, 12 * KIB));
      assert.strictEqual(await fullOf(b.put(item(OWNER_B, 12 * KIB))), 'resourceStoreBytes');
    });

    it('an owner\'s items: refused past --resourceQuotaItems', async () => {
      const b = open(Object.assign({}, LIMITS, {quotaItems: 2}));
      await b.put(item(OWNER_A, 1));
      await b.put(item(OWNER_A, 1));
      assert.strictEqual(await fullOf(b.put(item(OWNER_A, 1))), 'resourceQuotaItems');
      assert.strictEqual(await fullOf(b.put(item(OWNER_B, 1))), null, 'another owner\'s items are their own');
    });

    it('two puts that each fit alone but not together: exactly one is stored', async () => {
      const b = open(Object.assign({}, LIMITS, {quotaBytes: 20 * KIB}));
      const owner = `u_${'D'.repeat(22)}`;
      const r = await Promise.allSettled([b.put(item(owner, 12 * KIB)), b.put(item(owner, 12 * KIB))]);
      assert.deepStrictEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
      assert.strictEqual(r.find((x) => x.status === 'rejected').reason.fields.limit, 'resourceQuotaBytes');
    });

    it('expiry frees the quota (the sweep, and a put that prunes)', async () => {
      const b = open(Object.assign({}, LIMITS, {quotaItems: 1}));
      const owner = `u_${'E'.repeat(22)}`;
      await b.put(item(owner, 10));
      assert.strictEqual(await fullOf(b.put(item(owner, 10))), 'resourceQuotaItems');
      t += LIMITS.retentionMs + 1;
      assert.strictEqual(await fullOf(b.put(item(owner, 10))), null, 'the expired item no longer counts');
      t += LIMITS.retentionMs + 1;
      assert.ok(await b.sweep() >= 1);
      assert.deepStrictEqual((await b.usage(owner)), {bytes: 0, items: 0});
    });

    it('remove frees its quota at once', async () => {
      const b = open(Object.assign({}, LIMITS, {quotaItems: 1}));
      const owner = `u_${'F'.repeat(22)}`;
      const {id} = await b.put(item(owner, 10));
      await b.remove(id);
      assert.strictEqual(await b.get(id, {owner, session: null}), null);
      assert.strictEqual(await fullOf(b.put(item(owner, 10))), null);
    });

    if (kind === 'redis') {
      it('db 13, its own; the expiry is set with the write; names carry the id and the owner id only', async () => {
        assert.strictEqual(BLOBS_DB, 13);
        const b = open();
        const {id} = await b.put(item(OWNER_A, 10));
        const keys = await b.keys();
        assert.ok(keys.length > 0);
        for (const k of keys) assert.ok(/^[A-Za-z0-9_:-]+$/.test(k) && !/aabbcc|alice/.test(k), k);
        for (const k of keys.filter((x) => x.includes(id))) assert.ok(await b.pttl(k) > 0, `${k} has its expiry`);
      });
    } else {
      it('owner-only files under <storePath>/resources, named by id; the index survives a restart', async () => {
        const b = open();
        const {id} = await b.put(item(OWNER_A, 10));
        const dir = path.join(roots[roots.length - 1], 'resources');
        if (process.platform !== 'win32') {
          assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
          for (const f of fs.readdirSync(dir)) assert.strictEqual(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
        }
        assert.deepStrictEqual(fs.readdirSync(dir).sort(), [`${id}.bin`, `${id}.json`]);
        await b.close();
        const again = open(LIMITS, roots[roots.length - 1]);
        assert.notStrictEqual(await again.get(id, {owner: OWNER_A, session: null}), null);
        assert.deepStrictEqual(await again.usage(OWNER_A), {bytes: 10, items: 1});
      });

      it('a crash between the files leaves no meta without its data: a stray .bin or temp file is swept at open', async () => {
        const b = open();
        const root = roots[roots.length - 1];
        await b.close();
        const dir = path.join(root, 'resources');
        const stray = crypto.randomBytes(32).toString('base64url');
        fs.writeFileSync(path.join(dir, `${stray}.bin`), 'x', {mode: 0o600});
        fs.writeFileSync(path.join(dir, `.tmp-${stray}.json`), '{}', {mode: 0o600});
        open(LIMITS, root);
        await new Promise((r) => setTimeout(r, 50));
        assert.deepStrictEqual(fs.readdirSync(dir), []);
      });

      it('is refused under a module\'s data path', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-blobs-'));
        roots.push(root);
        assert.throws(() => createBlobs({kind: 'local', storePath: path.join(root, 'module_data', 'x'), moduleDataPath: path.join(root, 'module_data'), limits: LIMITS, now}),
          /under the module data path/);
      });
    }
  });
}
