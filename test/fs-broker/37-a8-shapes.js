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
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  const namespace = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
  await namespace.prepare();
  const broker = new FsBroker({name: 'm', mode, namespace, cwd: '/', report: () => {}});
  return {base, dirs, broker, done: () => broker.closeAll()};
}

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
      } finally { await t.done(); }
    });

    it(`${mode}: lstat of a link with a trailing separator is the directory it leads to`, async function() {
      const t = await setup(mode);
      try {
        fs.mkdirSync(path.join(t.dirs.data, 'dir'));
        try {
          fs.symlinkSync(path.join(t.dirs.data, 'dir'), path.join(t.dirs.data, 'link'), 'dir');
        } catch (e) {
          if (e.code === 'EPERM') return this.skip();
          throw e;
        }
        const isLink = (st) => (Number(st.fields.mode) & 0o170000) === 0o120000;
        const isDir = (st) => (Number(st.fields.mode) & 0o170000) === 0o040000;
        assert.ok(isLink(await t.broker.handle('lstat', ['/data/link', {}])), 'as named: the link');
        assert.ok(isDir(await t.broker.handle('lstat', ['/data/link/', {}])), 'with the separator: the directory');
        assert.ok(fs.lstatSync(`${path.join(t.dirs.data, 'link')}${path.sep}`).isDirectory(), 'as Node answers');
        // (a file, or a link to one, with the separator: ENOTDIR, as Node's, said as lstat's)
        fs.writeFileSync(path.join(t.dirs.data, 'f'), 'x');
        fs.symlinkSync(path.join(t.dirs.data, 'f'), path.join(t.dirs.data, 'flink'));
        for (const p of ['/data/f/', '/data/flink/']) {
          await assert.rejects(t.broker.handle('lstat', [p, {}]), (e) => e.code === 'ENOTDIR' && e.syscall === 'lstat', p);
        }
        assert.throws(() => fs.lstatSync(`${path.join(t.dirs.data, 'flink')}${path.sep}`), (e) => e.code === 'ENOTDIR');
        await assert.rejects(t.broker.handle('lstat', ['/data/missing/', {}]), (e) => e.code === 'ENOENT' && e.syscall === 'lstat');
      } finally { await t.done(); }
    });
  }

  // (the stores below are made in the install itself: removed after, even
  // on failure)
  const stores = [];
  after(() => { for (const p of stores) fs.rmSync(p, {recursive: true, force: true}); });
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
