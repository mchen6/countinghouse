'use strict';
// Shared runtime R1, Task 3 (design #236 section 4a), server-free: a
// per-session module's partitions. Store keys go under
// ms:<encoded name>:<session id>:, never inside m:<name>:, and no prefix
// starts another. Files go under <data>/<name>/sessions/<session id>/
// {data,tmp}, private. remove takes one partition and nothing else; list
// finds every partition present, in the files and in the store; sweep keeps
// the restored ids and removes the rest. On the local store and on a Redis
// stand-in.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ns = require('../../lib/redis-namespace');
const moduleData = require('../../lib/module-data');
const partition = require('../../lib/session-partition');
const LocalKv = require('../../lib/local-kv');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = '0123456789abcdef0123456789abcdef';

// node_redis's scan and del, paging five keys at a time (as local-kv 04's)
function fakeRedis(keys) {
  const store = new Set(keys);
  let snapshot = [];
  const globToRegExp = (g) => new RegExp(`^${g.replace(/\\(.)|([.+^${}()|])|(\*)|(\?)/g, (m, esc, special, star) => {
    if (esc != null) return esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (special != null) return `\\${special}`;
    return star != null ? '.*' : '.';
  })}$`);
  return {
    keys: () => [...store].sort(),
    scan(cursor, ...args) {
      const cb = args.pop();
      const pattern = args[args.indexOf('MATCH') + 1];
      if (String(cursor) === '0') snapshot = [...store].sort();
      const at = Number(cursor);
      const page = snapshot.slice(at, at + 5).filter((k) => globToRegExp(pattern).test(k));
      process.nextTick(cb, null, [at + 5 >= snapshot.length ? '0' : String(at + 5), page]);
    },
    del(list, cb) {
      let n = 0;
      for (const k of list) if (store.delete(k)) n += 1;
      process.nextTick(cb, null, n);
    }
  };
}
const setKv = (kv, k) => new Promise((resolve, reject) => kv.set(k, '1', (e) => (e ? reject(e) : resolve())));
const sorted = (ps) => ps.map((p) => `${p.name}/${p.sessionId.slice(0, 1)}`).sort();

describe('local-kv 05: a per-session module\'s partitions (R1)', () => {
  describe('the names', () => {
    it('ms:<encoded name>:<session id>:, a 32-hex id only, never inside m:', () => {
      assert.strictEqual(ns.sessionPrefixFor('foo', A), `ms:foo:${A}:`);
      assert.strictEqual(ns.sessionPrefixFor('@s/x:y', A), `ms:%40s%2Fx%3Ay:${A}:`, 'encoded as prefixFor encodes');
      for (const bad of [A.toUpperCase(), A.slice(1), `${A}0`, 'g'.repeat(32), '', null, `../${A.slice(3)}`]) {
        assert.strictEqual(ns.sessionPrefixFor('foo', bad), null, String(bad));
      }
      assert.strictEqual(ns.sessionPrefixFor('', A), null);
      assert.strictEqual(ns.sessionsPrefixFor('foo'), 'ms:foo:');
      assert.ok(!`ms:foobar:${A}:k`.startsWith(ns.sessionsPrefixFor('foo')), 'ms:foo: never reaches ms:foobar:');
      assert.ok(!ns.sessionPrefixFor('foo', A).startsWith(ns.prefixFor('foo')) && !ns.prefixFor('s').startsWith('ms:'), 'm: and ms: never nest');
      assert.deepStrictEqual(ns.partitionOfKey(`ms:%40s%2Fx:${B}:counter`), {name: '@s/x', sessionId: B});
      for (const k of ['m:foo:k', `ms:foo:${A}`, 'ms:foo:short:k', `ms:%E0:${A}:k`]) assert.strictEqual(ns.partitionOfKey(k), null, k);
    });

    it('an error\'s text loses a session prefix as it loses m:<name>:', () => {
      const p = ns.sessionPrefixFor('foo', A);
      assert.strictEqual(ns.unprefixError(`WRONGTYPE ${p}counter`, p), 'WRONGTYPE counter');
    });

    it('files: <data>/<name>/sessions/<id>/{data,tmp}, an id of 32 hex only', () => {
      const d = moduleData.sessionDirsFor('/srv/data', '@s/m', A);
      assert.strictEqual(d.data, path.join('/srv/data', '@s', 'm', 'sessions', A, 'data'));
      assert.strictEqual(d.tmp, path.join('/srv/data', '@s', 'm', 'sessions', A, 'tmp'));
      assert.throws(() => moduleData.sessionDirsFor('/srv/data', 'm', '..'), /32 lowercase hex/);
      assert.throws(() => moduleData.sessionDirsFor('/srv/data', '../m', A));
    });
  });

  describe('on the local store', () => {
    let dir;
    let data;
    let kv;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-kv-part-'));
      data = path.join(dir, 'data');
      fs.mkdirSync(data);
      kv = new LocalKv({storePath: path.join(dir, 'store')});
    });
    afterEach(() => {
      if (kv != null && typeof(kv.close) === 'function') kv.close();
      fs.rmSync(dir, {recursive: true, force: true});
    });

    it('ensure makes private directories; remove takes one partition, its keys and files, and nothing else; again is a no-op', async () => {
      const a = await partition.ensure(data, 'mod', A);
      const b = await partition.ensure(data, 'mod', B);
      fs.writeFileSync(path.join(a.data, 'x'), '1');
      fs.writeFileSync(path.join(b.data, 'x'), '1');
      if (process.platform !== 'win32') assert.strictEqual(fs.statSync(a.data).mode & 0o777, 0o700);
      for (const k of [`${ns.sessionPrefixFor('mod', A)}k`, `${ns.sessionPrefixFor('mod', B)}k`, 'm:mod:k', `${ns.sessionPrefixFor('mod2', A)}k`]) await setKv(kv, k);
      const r = await partition.remove(data, kv, 'mod', A);
      assert.deepStrictEqual(r, {keys: 1, dirs: true});
      assert.ok(!fs.existsSync(path.join(data, 'mod', 'sessions', A)));
      assert.ok(fs.existsSync(path.join(b.data, 'x')), 'the other session\'s files stay');
      assert.deepStrictEqual(kv.keysWithPrefix('').sort(), ['m:mod:k', `${ns.sessionPrefixFor('mod', B)}k`, `${ns.sessionPrefixFor('mod2', A)}k`].sort());
      assert.deepStrictEqual(await partition.remove(data, kv, 'mod', A), {keys: 0, dirs: false}, 'idempotent');
      await partition.remove(data, kv, 'mod', B);
      assert.ok(!fs.existsSync(path.join(data, 'mod', 'sessions')), 'sessions/ goes once empty');
      assert.ok(fs.existsSync(path.join(data, 'mod')), 'the module\'s own directory stays');
    });

    it('list finds every partition once, from its files or its keys; sweep keeps the restored ids and removes the rest', async () => {
      await partition.ensure(data, 'mod', A);                       // files and keys
      await setKv(kv, `${ns.sessionPrefixFor('mod', A)}k`);
      await partition.ensure(data, '@scope/pkg', B);                // files only, scoped
      await setKv(kv, `${ns.sessionPrefixFor('other', C)}k`);        // keys only
      fs.mkdirSync(path.join(data, '.validate', 'sessions', A), {recursive: true});   // no module's
      fs.mkdirSync(path.join(data, 'mod', 'sessions', 'not-an-id'), {recursive: true});
      assert.deepStrictEqual(sorted(await partition.list(data, kv)), ['@scope/pkg/b', 'mod/a', 'other/0']);
      const removed = await partition.sweep(data, kv, new Set([A]));
      assert.deepStrictEqual(sorted(removed), ['@scope/pkg/b', 'other/0']);
      assert.deepStrictEqual(sorted(await partition.list(data, kv)), ['mod/a'], 'the restored one kept');
      assert.ok(fs.existsSync(path.join(data, '.validate', 'sessions', A)), 'a dot-led directory is no module\'s: untouched');
      assert.deepStrictEqual(sorted(await partition.sweep(data, kv, new Set())), ['mod/a'], 'nothing restored: all swept');
    });

    it('a sessions/<id> that is a link is unlinked, never walked', async function() {
      if (process.platform === 'win32') return this.skip();
      const outside = path.join(dir, 'outside');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'keep'), '1');
      fs.mkdirSync(path.join(data, 'mod', 'sessions'), {recursive: true});
      fs.symlinkSync(outside, path.join(data, 'mod', 'sessions', A));
      assert.deepStrictEqual(sorted(await partition.list(data, kv)), ['mod/a']);
      await partition.sweep(data, kv, new Set());
      assert.ok(!fs.existsSync(path.join(data, 'mod', 'sessions', A)), 'the link is gone');
      assert.ok(fs.existsSync(path.join(outside, 'keep')), 'what it led to is untouched');
    });
  });

  describe('on Redis (a stand-in)', () => {
    it('keysUnder pages through SCAN, and list and remove use it', async () => {
      const keys = [];
      for (let i = 0; i < 9; i++) keys.push(`${ns.sessionPrefixFor('mod', A)}k${i}`);
      keys.push(`${ns.sessionPrefixFor('mod', B)}k`, 'm:mod:k', 'jobinfo:1');
      const r = fakeRedis(keys);
      const seen = [];
      await ns.keysUnder(r, 'ms:', (k) => seen.push(k));
      assert.strictEqual(seen.length, 10);
      const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-kv-part-r-'));
      try {
        assert.deepStrictEqual(sorted(await partition.list(data, r)), ['mod/a', 'mod/b']);
        assert.deepStrictEqual(await partition.remove(data, r, 'mod', A), {keys: 9, dirs: false});
        assert.deepStrictEqual(r.keys(), ['jobinfo:1', 'm:mod:k', `${ns.sessionPrefixFor('mod', B)}k`]);
      } finally {
        fs.rmSync(data, {recursive: true, force: true});
      }
    });
  });
});
