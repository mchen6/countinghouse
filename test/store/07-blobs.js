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
    const open = (limits = LIMITS, root = null, extra = {}) => {
      let dir = root;
      if (kind === 'local' && dir == null) {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-blobs-'));
        roots.push(dir);
      }
      const client = kind === 'redis' ? require('redis').createClient(redisUrlFor(), {db: BLOBS_DB, detect_buffers: true}) : null;
      const b = createBlobs({kind, storePath: dir, moduleDataPath: dir != null ? path.join(dir, 'module_data') : null,
        client, prefix, limits, now, prune: extra.prune});
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
      assert.strictEqual(await fullOf(b.put(item(OWNER_A, LIMITS.itemBytes + 1))), 'maxOutputBytes');
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

    it('a missing source field is null, never the string "undefined"', async () => {
      const b = open();
      const {id} = await b.put(item(OWNER_A, 1, {source: {module: 'm', tool: 't'}}));
      assert.deepStrictEqual((await b.get(id, {owner: OWNER_A, session: null})).meta.source, {module: 'm', tool: 't', field: null});
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
      it('a put prunes the caller\'s own expired items first, so it is never refused on them', async () => {
        const b = open(Object.assign({}, LIMITS, {quotaItems: 1}), null, {prune: 2});
        for (const o of ['G', 'H', 'I']) await b.put(item(`u_${o.repeat(22)}`, 10));
        t += 1;
        const x = `u_${'X'.repeat(22)}`;
        await b.put(item(x, 10));
        t += LIMITS.retentionMs + 1;
        assert.strictEqual(await fullOf(b.put(item(x, 10))), null, 'its own expired item is pruned, though three older ones are first in line');
      });

      it('an owner\'s byte counter goes when its last item does', async () => {
        const b = open();
        const owner = `u_${'J'.repeat(22)}`;
        const {id} = await b.put(item(owner, 10));
        await b.remove(id);
        assert.deepStrictEqual((await b.keys()).filter((k) => k.includes(owner)), []);
      });

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
      const dirOf = () => path.join(roots[roots.length - 1], 'resources');
      const otherOwner = (c) => `u_${c.repeat(22)}`;

      it('owner-only files under <storePath>/resources, named by id beside the index; a restart reads them', async () => {
        const b = open();
        const {id} = await b.put(item(OWNER_A, 10));
        const dir = dirOf();
        if (process.platform !== 'win32') {
          assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
          // (every file owner-only; the lock's own folder, owner-only too)
          for (const f of fs.readdirSync(dir)) assert.strictEqual(fs.statSync(path.join(dir, f)).mode & 0o777, f === '.lockdir' ? 0o700 : 0o600, f);
        }
        // both sides in plain code-unit order: the id is random, so it may
        // sort before or after index.json
        assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f !== '.lockdir').sort(), [`${id}.bin`, `${id}.json`, 'index.json'].sort());
        await b.close();
        const again = open(LIMITS, roots[roots.length - 1]);
        assert.notStrictEqual(await again.get(id, {owner: OWNER_A, session: null}), null);
        assert.deepStrictEqual(await again.usage(OWNER_A), {bytes: 10, items: 1});
      });

      it('two processes\' stores on one storePath: each reads the other\'s items, and the limits are the store\'s', async () => {
        const a = open(Object.assign({}, LIMITS, {quotaItems: 2}));
        const b = open(Object.assign({}, LIMITS, {quotaItems: 2}), roots[roots.length - 1]);
        const {id} = await a.put(item(OWNER_A, 10));
        assert.notStrictEqual(await b.get(id, {owner: OWNER_A, session: null}), null, 'b reads a\'s item');
        await b.put(item(OWNER_A, 10));
        assert.strictEqual(await fullOf(a.put(item(OWNER_A, 10))), 'resourceQuotaItems', 'a counts b\'s item too');
      });

      it('two concurrent puts on two stores of one storePath that fit alone but not together: exactly one is stored', async () => {
        const lim = Object.assign({}, LIMITS, {quotaBytes: 20 * KIB});
        const a = open(lim);
        const b = open(lim, roots[roots.length - 1]);
        const owner = otherOwner('K');
        const r = await Promise.allSettled([a.put(item(owner, 12 * KIB)), b.put(item(owner, 12 * KIB))]);
        assert.deepStrictEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
        assert.strictEqual(r.find((x) => x.status === 'rejected').reason.fields.limit, 'resourceQuotaBytes');
        assert.strictEqual(fs.readdirSync(dirOf()).filter((f) => f.endsWith('.bin')).length, 1, 'the refused put left no bytes');
      });

      it('a stray is swept only once its own mtime is 10 minutes old: another process\'s put in progress is never touched', async () => {
        const b = open();
        await b.ready;
        const dir = dirOf();
        const young = crypto.randomBytes(32).toString('base64url');
        const old = crypto.randomBytes(32).toString('base64url');
        fs.writeFileSync(path.join(dir, `${young}.bin`), 'x', {mode: 0o600});
        fs.writeFileSync(path.join(dir, `${old}.bin`), 'x', {mode: 0o600});
        fs.writeFileSync(path.join(dir, `.tmp-${old}.json`), '{}', {mode: 0o600});
        const hourAgo = new Date(Date.now() - 3600 * 1000);
        fs.utimesSync(path.join(dir, `${old}.bin`), hourAgo, hourAgo);
        fs.utimesSync(path.join(dir, `.tmp-${old}.json`), hourAgo, hourAgo);
        const other = open(LIMITS, roots[roots.length - 1]);
        await other.ready;
        assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f !== 'index.json' && f !== '.lockdir').sort(), [`${young}.bin`]);
      });

      it('the sweep never takes the lock\'s own folder for a stray; an old lock file left among the items ages out', async () => {
        const b = open();
        await b.ready;
        const dir = dirOf();
        assert.ok(fs.existsSync(path.join(dir, '.lockdir')), 'the lock is not in its own folder');
        const hourAgo = new Date(Date.now() - 3600 * 1000);
        fs.utimesSync(path.join(dir, '.lockdir'), hourAgo, hourAgo);
        // (a lock file of an earlier version's, among the items: nothing reads it any more)
        fs.writeFileSync(path.join(dir, '.lock.takeover'), '', {mode: 0o600});
        fs.utimesSync(path.join(dir, '.lock.takeover'), hourAgo, hourAgo);
        const other = open(LIMITS, roots[roots.length - 1]);
        await other.ready;
        assert.ok(fs.existsSync(path.join(dir, '.lockdir')), 'the sweep removed the lock\'s folder');
        assert.ok(!fs.existsSync(path.join(dir, '.lock.takeover')), 'an old lock file among the items stayed');
      });

      it('a lock held by a live process is never taken over, however old (a holder awaits inside its hold); one whose holder is gone is', async function() {
        this.timeout(20000);
        const b = open();
        await b.ready;
        const lock = path.join(dirOf(), '.lockdir', '.lock');
        const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {stdio: 'ignore'});
        try {
          for (const age of [0, 3600 * 1000]) {
            fs.writeFileSync(lock, JSON.stringify({pid: child.pid, at: Date.now() - age}), {mode: 0o600});
            await assert.rejects(b.put(item(OWNER_A, 10)), /held by a live process/, `a live holder's lock ${age} ms old was taken over`);
          }
        } finally {
          child.kill('SIGKILL');
        }
        await new Promise((r) => child.once('exit', r));
        assert.notStrictEqual((await b.put(item(OWNER_A, 10))).id, null, 'its holder gone, the lock is taken over');
      });

      it('an id that is not the 43-character form, or a planted link, is not found, and nothing outside is read', async () => {
        const b = open();
        await b.ready;
        const dir = dirOf();
        const secret = path.join(roots[roots.length - 1], 'secret.txt');
        fs.writeFileSync(secret, 'outside', {mode: 0o600});
        for (const id of ['../secret', `../${'a'.repeat(40)}`, '..%2f..%2fsecret', `${'a'.repeat(42)}/`, 'a'.repeat(44), '']) {
          assert.strictEqual(await b.get(id, {owner: OWNER_A, session: null}), null, id);
          await b.remove(id);
        }
        assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'outside');
        if (process.platform !== 'win32') {
          const planted = crypto.randomBytes(32).toString('base64url');
          const meta = {id: planted, owner: OWNER_A, session: null, mimeType: 'text/plain', bytes: 7, sha256: 'x', createdAt: t, expiresAt: t + 60000, source: {}};
          const metaFile = path.join(roots[roots.length - 1], 'meta.json');
          fs.writeFileSync(metaFile, JSON.stringify(meta), {mode: 0o600});
          fs.symlinkSync(metaFile, path.join(dir, `${planted}.json`));
          fs.symlinkSync(secret, path.join(dir, `${planted}.bin`));
          assert.strictEqual(await b.get(planted, {owner: OWNER_A, session: null}), null, 'a link is never followed');
        }
      });

      it('a write that fails leaves nothing behind', async () => {
        const b = open();
        await b.ready;
        const dir = dirOf();
        const before = fs.readdirSync(dir).sort();
        await assert.rejects(b.put(item(OWNER_A, LIMITS.itemBytes + 1)));
        await assert.rejects(b.put(Object.assign(item(OWNER_A, 10), {owner: 'nope'})));
        const lim = open(Object.assign({}, LIMITS, {quotaItems: 1}), roots[roots.length - 1]);
        await lim.put(item(otherOwner('L'), 1));
        await assert.rejects(lim.put(item(otherOwner('L'), 1)));
        assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => !before.includes(f) && f.endsWith('.bin')).length, 1, 'only the stored item\'s bytes');
        assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.startsWith('.tmp-')), []);
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
