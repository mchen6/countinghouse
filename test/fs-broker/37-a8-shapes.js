// The final pass on the sandbox, A8's rest (functional):
// - an ancestor directory's stat with {bigint: true} answers bigints, as
//   any stat does;
// - lstat of a path ending in a separator follows a link there, as Node's
//   does (the trailing slash asks for the directory);
// - a --moduleDataPath under one of the install's top-level dot
//   directories (whose files are never a module's) is refused at the spawn,
//   saying so, instead of every /data operation failing EACCES unexplained.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const tmp = require('../helpers/test-tmp').forFile(['broker-a8-']);

const WIN = process.platform === 'win32';
const INSTALL = path.join(__dirname, '..', '..');

async function setup(mode) {
  const base = tmp.mkdtemp('broker-a8-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp'), outside: path.join(base, 'outside')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  const namespace = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
  await namespace.prepare();
  // (what the broker reports, collected: an escape it judges is seen)
  const reports = [];
  const broker = new FsBroker({name: 'm', mode, namespace, cwd: '/', report: (rule, target) => reports.push(`${rule} ${target}`)});
  return {base, dirs, broker, reports, done: () => broker.closeAll()};
}
// what an answer is: a directory, a link, a file, or the error's code; the
// broker's and Node's own on the host, compared (Node's differs by platform)
const kindOf = (st) => {
  const m = Number(st.fields != null ? st.fields.mode : st.mode) & 0o170000;
  return m === 0o040000 ? 'dir' : m === 0o120000 ? 'link' : 'file';
};
const nodeSays = (fn) => { try { return kindOf(fn()); } catch (e) { return e.code; } };
const brokerSays = async (t, op, p) => { try { return kindOf(await t.broker.handle(op, [p, {}])); } catch (e) { return e.code; } };
const linkOrSkip = (ctx, target, at, type) => {
  try { fs.symlinkSync(target, at, type); return true; } catch (e) { if (e.code === 'EPERM') { ctx.skip(); return false; } throw e; }
};

describe('fs-broker 37: A8\'s rest (the final pass, functional)', function() {
  this.timeout(60000);

  for (const mode of ['audit', 'enforce']) {
    it(`${mode}: an ancestor's stat with bigint answers bigints`, async () => {
      const t = await setup(mode);
      try {
        const st = await t.broker.handle('stat', ['/', {bigint: true}]);
        assert.strictEqual(st.bigint, true);
        for (const k of ['dev', 'ino', 'mode', 'size', 'atimeMs', 'mtimeNs']) assert.strictEqual(typeof st.fields[k], 'bigint', k);
        const lst = await t.broker.handle('lstat', ['/', {bigint: true}]);
        assert.strictEqual(typeof lst.fields.mode, 'bigint');
        const plain = await t.broker.handle('stat', ['/', {}]);
        assert.strictEqual(typeof plain.fields.mode, 'number');
        // (under enforce the ancestor is the namespace's own: no host's
        // inode -- audit answers the host's, as master did)
        if (mode === 'enforce') assert.strictEqual(st.fields.ino, 0n);
      } finally { await t.done(); }
    });

    it(`${mode}: lstat with a trailing separator answers as Node's does (POSIX: the directory a link there leads to)`, async function() {
      const t = await setup(mode);
      try {
        fs.mkdirSync(path.join(t.dirs.data, 'dir'));
        if (!linkOrSkip(this, path.join(t.dirs.data, 'dir'), path.join(t.dirs.data, 'link'), 'dir')) return;
        fs.writeFileSync(path.join(t.dirs.data, 'f'), 'x');
        fs.symlinkSync(path.join(t.dirs.data, 'f'), path.join(t.dirs.data, 'flink'));
        const host = (n) => `${path.join(t.dirs.data, n)}${path.sep}`;
        assert.strictEqual(await brokerSays(t, 'lstat', '/data/link'), 'link', 'as named: the link');
        for (const n of ['link', 'f', 'flink', 'missing']) {
          assert.strictEqual(await brokerSays(t, 'lstat', `/data/${n}/`), nodeSays(() => fs.lstatSync(host(n))), `${n}/ as Node answers`);
        }
        if (!WIN) {
          // (POSIX: the separator asks for the directory a link leads to; a
          // file, or a link to one, is ENOTDIR, said as lstat's)
          assert.strictEqual(await brokerSays(t, 'lstat', '/data/link/'), 'dir');
          for (const [p, code] of [['/data/f/', 'ENOTDIR'], ['/data/flink/', 'ENOTDIR'], ['/data/missing/', 'ENOENT']]) {
            await assert.rejects(t.broker.handle('lstat', [p, {}]), (e) => e.code === code && e.syscall === 'lstat', p);
          }
          // (the separator as the path's own, after a file URL is a path: a
          // fragment is not part of it, a query is not either)
          assert.strictEqual(await brokerSays(t, 'lstat', 'file:///data/link#/'), 'link', 'a fragment: the link');
          assert.strictEqual(await brokerSays(t, 'lstat', 'file:///data/link/?x'), 'dir', 'a query after the separator: the directory');
        }
      } finally { await t.done(); }
    });

    it(`${mode}: lstat with a separator of a link leading out of its root is judged where it leads (POSIX, where it is followed)`, async function() {
      if (WIN) return this.skip();
      const t = await setup(mode);
      try {
        fs.writeFileSync(path.join(t.dirs.outside, 'file'), 'x');
        if (!linkOrSkip(this, t.dirs.outside, path.join(t.dirs.data, 'out'), 'dir')) return;
        fs.symlinkSync(path.join(t.dirs.outside, 'file'), path.join(t.dirs.data, 'outf'));
        if (mode === 'enforce') {
          for (const p of ['/data/out/', '/data/outf/']) await assert.rejects(t.broker.handle('lstat', [p, {}]), (e) => e.code === 'ENOENT', p);
        } else {
          const st = await t.broker.handle('lstat', ['/data/out/', {}]);
          assert.strictEqual(Number(st.fields.mode) & 0o170000, 0o040000, 'out/: the directory it leads to');
          await assert.rejects(t.broker.handle('lstat', ['/data/outf/', {}]), (e) => e.code === 'ENOTDIR');
        }
        assert.ok(t.reports.includes('escape /data/out'), t.reports.join('\n'));
        assert.ok(t.reports.includes('escape /data/outf'), t.reports.join('\n'));
      } finally { await t.done(); }
    });

    it(`${mode}: stat with a trailing separator answers as Node's does (POSIX: a file is ENOTDIR)`, async () => {
      const t = await setup(mode);
      try {
        fs.writeFileSync(path.join(t.dirs.data, 'f'), 'x');
        fs.mkdirSync(path.join(t.dirs.data, 'd'));
        for (const n of ['f', 'd']) {
          assert.strictEqual(await brokerSays(t, 'stat', `/data/${n}/`), nodeSays(() => fs.statSync(`${path.join(t.dirs.data, n)}${path.sep}`)), `${n}/ as Node answers`);
        }
        if (!WIN) await assert.rejects(t.broker.handle('stat', ['/data/f/', {}]), (e) => e.code === 'ENOTDIR' && e.syscall === 'stat');
      } finally { await t.done(); }
    });

    it(`${mode}: readlink and statfs of an ancestor answer as Node's do for a directory`, async () => {
      const t = await setup(mode);
      try {
        await assert.rejects(t.broker.handle('readlink', ['/', {}]), (e) => e.code === 'EINVAL' && e.syscall === 'readlink');
        const sf = await t.broker.handle('statfs', ['/', {}]);
        // (under enforce, the filesystem its /data is on; audit answers the
        // host's own /)
        const want = fs.statfsSync(mode === 'enforce' ? t.dirs.data : '/');
        assert.deepStrictEqual([sf.type, sf.bsize, sf.blocks], [want.type, want.bsize, want.blocks]);
      } finally { await t.done(); }
    });
  }

  // (the stores below are made in the install itself: removed after, even
  // on failure)
  const stores = [];
  after(() => { for (const p of stores) tmp.remove(p); });
  const spawnIn = async (mode, name) => {
    const {createForWorker} = require('../../lib/fs-broker');
    const base = tmp.mkdtemp('broker-a8-');
    const mod = path.join(base, 'mod');
    fs.mkdirSync(mod);
    fs.writeFileSync(path.join(mod, 'package.json'), '{"name": "m"}');
    const store = path.join(INSTALL, `${name}-${process.pid}-${mode}`);
    stores.push(store);
    const said = [];
    const run = createForWorker({name: 'm', mode, modulePath: mod, declared: [], options: {moduleDataPath: store, modulePath: base}, report: (rule, text) => said.push([rule, text])});
    return {run, said, store};
  };
  for (const name of ['.c-a8-store', '..c-a8-store']) {
    it(`enforce: a --moduleDataPath under the install's ${name}: refused at the spawn, saying so, before anything is made`, async () => {
      const {run, store} = await spawnIn('enforce', name);
      await assert.rejects(run, (e) => e.code === 'MODULE_SANDBOX_REFUSED' && /the module's data directory .* is under countinghouse's install, in \.+c-a8-store/.test(e.message) && /--moduleDataPath/.test(e.message));
      assert.strictEqual(fs.existsSync(path.join(store, 'm')), false, 'nothing made there');
    });
  }
  it('audit: the same spawn loads and says so, once', async () => {
    const {run, said} = await spawnIn('audit', '.c-a8-store');
    const fsb = await run;
    await fsb.bridge.close();
    assert.strictEqual(said.filter(([rule]) => rule === 'install-secret').length, 1, JSON.stringify(said));
  });

  tmp.hooks();
});
