// #164 follow-up: an uninstalled module's ctx.redis keys go with it, so a
// later module of the same name does not inherit them. lib/redis-namespace.js
// purgeNamespace deletes every key under a module's prefix: SCAN MATCH and
// DEL in batches on Redis, LocalKv.deletePrefix on the local store. Nothing
// outside the prefix is touched. Server-free.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {purgeNamespace, prefixFor} = require('../../lib/redis-namespace');
const LocalKv = require('../../lib/local-kv');

// A stand-in for node_redis's scan and del: scan pages through `keys` five at a
// time, matching a glob the way Redis does for the patterns used here.
function fakeRedis(keys) {
  const store = new Set(keys);
  const calls = {scan: [], del: []};
  let snapshot = [];
  const globToRegExp = (g) => new RegExp(`^${g.replace(/\\(.)|([.+^${}()|])|(\*)|(\?)/g, (m, esc, special, star, q) => {
    if (esc != null) return esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (special != null) return `\\${special}`;
    return star != null ? '.*' : '.';
  })}$`);
  return {
    calls,
    keys: () => [...store].sort(),
    scan(cursor, ...args) {
      const cb = args.pop();
      calls.scan.push([cursor, ...args]);
      const pattern = args[args.indexOf('MATCH') + 1];
      // a scan pages over the keys there when it started, as Redis's returns
      // every key present the whole time, whatever is deleted between pages
      if (String(cursor) === '0') snapshot = [...store].sort();
      const all = snapshot;
      const at = Number(cursor);
      const page = all.slice(at, at + 5).filter((k) => globToRegExp(pattern).test(k));
      const next = at + 5 >= all.length ? '0' : String(at + 5);
      process.nextTick(cb, null, [next, page]);
    },
    del(list, cb) {
      calls.del.push(list.slice());
      let n = 0;
      for (const k of list) if (store.delete(k)) n += 1;
      process.nextTick(cb, null, n);
    }
  };
}

describe('local-kv 04: an uninstalled module\'s keys are purged', () => {
  it('Redis: every key under the prefix, in batches; nothing else', async () => {
    const keys = [];
    for (let i = 0; i < 12; i++) keys.push(`m:mod-a:k${i}`);
    keys.push('m:mod-ab:k', 'm:mod-b:k', 'jobinfo:1', 'mod-a:k');
    const r = fakeRedis(keys);
    assert.strictEqual(await purgeNamespace(r, prefixFor('mod-a')), 12);
    assert.deepStrictEqual(r.keys(), ['jobinfo:1', 'm:mod-ab:k', 'm:mod-b:k', 'mod-a:k']);
    assert.ok(r.calls.scan.length > 1, 'more than one page');
    assert.ok(r.calls.scan.every((c) => c.includes('COUNT')));
  });

  it('Redis: a name\'s glob characters are escaped in MATCH', async () => {
    const r = fakeRedis(['m:a*b:k', 'm:axxb:k', 'm:a?:k', 'm:ab:k']);
    // encodeURIComponent leaves * and ? as they are
    assert.strictEqual(prefixFor('a*b'), 'm:a*b:');
    assert.strictEqual(await purgeNamespace(r, prefixFor('a*b')), 1);
    assert.deepStrictEqual(r.keys(), ['m:a?:k', 'm:ab:k', 'm:axxb:k']);
    assert.strictEqual(r.calls.scan[0][r.calls.scan[0].indexOf('MATCH') + 1], 'm:a\\*b:*');
  });

  it('the local store: every key under the prefix, nothing else, and kv.json says so', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-kv-purge-'));
    const kv = new LocalKv({storePath: dir});
    try {
      const set = (k) => new Promise((resolve, reject) => kv.set(k, '1', (e) => (e ? reject(e) : resolve())));
      for (const k of ['m:mod-a:x', 'm:mod-a:y', 'm:mod-ab:x', 'm:mod-b:x', 'jobinfo:1']) await set(k);
      assert.strictEqual(await purgeNamespace(kv, prefixFor('mod-a')), 2);
      kv.file.flush();
      const onDisk = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'kv.json'), 'utf8'))).sort();
      assert.deepStrictEqual(onDisk, ['jobinfo:1', 'm:mod-ab:x', 'm:mod-b:x']);
    } finally {
      kv.close();
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('Redis: UNLINK where the client has it; a store that does not answer fails the purge', async () => {
    const r = fakeRedis(['m:mod-a:k', 'm:mod-a:j']);
    const unlinked = [];
    r.unlink = (list, cb) => { unlinked.push(list.slice()); return r.del(list, cb); };
    assert.strictEqual(await purgeNamespace(r, prefixFor('mod-a')), 2);
    assert.deepStrictEqual(unlinked.flat().sort(), ['m:mod-a:j', 'm:mod-a:k']);
    const silent = {scan: () => {}, del: () => {}};
    await assert.rejects(purgeNamespace(silent, prefixFor('mod-a'), {timeoutMs: 50}), /did not answer within/);
  });

  it('the local store counts only live keys: an expired one is dropped, uncounted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-kv-purge-'));
    let now = 1000;
    const kv = new LocalKv({storePath: dir, now: () => now});
    try {
      await new Promise((resolve) => kv.set('m:mod-a:live', '1', resolve));
      await new Promise((resolve) => kv.set('m:mod-a:gone', '1', resolve));
      await new Promise((resolve) => kv.pexpire('m:mod-a:gone', 10, resolve));
      now += 1000;
      assert.strictEqual(await purgeNamespace(kv, prefixFor('mod-a')), 1);
    } finally {
      kv.close();
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('no prefix: refused, nothing deleted', async () => {
    const r = fakeRedis(['m:x:k']);
    await assert.rejects(purgeNamespace(r, null), /no namespace/);
    assert.deepStrictEqual(r.keys(), ['m:x:k']);
  });
});
