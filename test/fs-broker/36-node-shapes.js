// The final pass on the sandbox (functional): what a module's libraries
// expect of Node's own fs, through the broker under audit and enforce, as
// Node itself answers it (a plain worker over the same tree).
// - A1: readdir/opendir of a missing directory answers ENOENT (not EACCES
//   with a "denied" report); ENOTDIR and ELOOP likewise, unreported.
// - A2: mkdtemp with a prefix ending in a separator makes the directory
//   inside it ('/tmp/', '/data/', a declared root's '<root>/'); a
//   prefix naming a root itself is refused (its directory would be a
//   sibling outside the root); a made directory is never answered as the
//   prefix's own path.
// - A3: the locked fs.exists, read, write, readv and writev keep
//   util.promisify's shapes.
// - A4: appendFile with a falsy flag appends (and writeFile truncates).
// - A5: copyFile onto itself or its own hard link changes nothing.
// - A6: rmdir with {recursive: true} removes a tree, as Node 22 and 24 do.
// - A7: cp of a file makes the destination's parent.
// - A8: statSync's throwIfNoEntry: false covers ENOTDIR.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {runBrokered} = require('../helpers/brokered-worker');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const {Quota} = require('../../lib/fs-broker/quota');
const tmp = require('../helpers/test-tmp').forFile(['broker-shapes-']);

const SCRIPT = path.join(__dirname, 'scripts', 'node-shapes.js');
const WIN = process.platform === 'win32';

async function setup(mode, {guarded = true, quota = null} = {}) {
  const base = tmp.mkdtemp('broker-shapes-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp'), log: path.join(base, 'log')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  fs.writeFileSync(path.join(dirs.data, 'f'), 'own');
  const namespace = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [{path: dirs.log, access: 'rw'}], protectedPaths: []});
  await namespace.prepare();
  const reports = [];
  const report = (rule, target) => reports.push(`${rule} ${target}`);
  // (a quota as createForWorker gives one: the walk's counts, enforce's own)
  const q = quota != null ? new Quota(Object.assign({}, quota, {enforce: mode === 'enforce', report})) : null;
  const broker = new FsBroker({name: 'm', mode, namespace, cwd: '/', report, quota: q,
    ...(guarded ? {installSecrets: path.join(base, 'no-install'), deniedTrees: []} : {})});
  return {base, dirs, broker, reports, quota: q, done: () => broker.closeAll()};
}
const code = (c) => (e) => e.code === c;

describe('fs-broker 36: Node\'s own answers, through the broker (the final pass, functional)', function() {
  this.timeout(60000);

  for (const mode of ['audit', 'enforce']) {
    it(`${mode}: patched fs answers as Node does (promisify, appendFile's flag, copyFile onto itself, rmdir recursive, cp's parent, throwIfNoEntry, mkdtemp's separator)`, async () => {
      const real = await runBrokered(SCRIPT, {patch: false});
      const brokered = await runBrokered(SCRIPT, {patch: true, mode});
      assert.strictEqual(real.ok, true, JSON.stringify(real));
      assert.strictEqual(brokered.ok, true, JSON.stringify(brokered));
      for (let i = 0; i < Math.max(real.r.length, brokered.r.length); i++) assert.deepStrictEqual(brokered.r[i], real.r[i], `step ${JSON.stringify(real.r[i] && real.r[i][0])}`);
      // (Node's own answers, pinned: a compare of two failures alike would
      // pass without the paths running -- the high on this change)
      const node = Object.fromEntries(real.r);
      assert.deepStrictEqual(node['appendFile with a falsy flag'], ['one\ntwo\nthree\nfour\n', 'x']);
      assert.deepStrictEqual(node['copyFile onto itself'], ['hello', 'hello']);
      assert.deepStrictEqual(node['rmdir recursive'], [false, false, false]);
      assert.strictEqual(node['rmdir recursive, missing'], 'throws ENOENT');
      assert.strictEqual(node['rmdir recursive, a file'], WIN ? 'throws ENOENT' : 'throws ENOTDIR');
      assert.deepStrictEqual(node['cp into a missing parent'], ['hello', 'hello']);
      assert.strictEqual(node['statSync throwIfNoEntry, ENOTDIR'], undefined);
      assert.deepStrictEqual(node['mkdtemp(dir + sep)'], [true, true, true, true]);
      assert.strictEqual(node['promisify(exists)'], true);
    });

    it(`${mode}: readdir and opendir of a missing directory answer ENOENT, unreported (A1)`, async () => {
      const t = await setup(mode);
      try {
        let linked = true;
        try {
          fs.symlinkSync(path.join(t.dirs.data, 'gone'), path.join(t.dirs.data, 'dangling'));
        } catch (e) {
          if (e.code !== 'EPERM') throw e;
          linked = false; // (Windows without the symlink privilege)
        }
        await assert.rejects(t.broker.handle('readdir', ['/data/no-such-dir', {}]), code('ENOENT'));
        if (linked) await assert.rejects(t.broker.handle('readdir', ['/data/dangling', {}]), code('ENOENT'));
        await assert.rejects(t.broker.handle('readdir', ['/data/f/x', {}]), code(WIN ? 'ENOENT' : 'ENOTDIR'));
        assert.deepStrictEqual(t.reports, []);
        assert.deepStrictEqual(await t.broker.handle('readdir', ['/data', {}]), linked ? ['dangling', 'f'] : ['f']);
        // (enforce: a link out answers the same whether what it leads to
        // exists or not -- nothing about outside is told)
        if (linked && mode === 'enforce') {
          const out = path.join(t.base, 'outside');
          fs.mkdirSync(path.join(out, 'there'), {recursive: true});
          fs.symlinkSync(path.join(out, 'there'), path.join(t.dirs.data, 'out-there'));
          fs.symlinkSync(path.join(out, 'missing'), path.join(t.dirs.data, 'out-missing'));
          const answer = (p) => t.broker.handle('readdir', [p, {}]).then(() => 'ok', (e) => e.code);
          assert.deepStrictEqual([await answer('/data/out-there'), await answer('/data/out-missing')], ['ENOENT', 'ENOENT']);
        }
      } finally { await t.done(); }
    });

    it(`${mode}: mkdtemp with a trailing separator makes the directory inside; a root's own name is refused (A2)`, async () => {
      const t = await setup(mode);
      try {
        // (a declared root is named by its host path: POSIX's here)
        const declared = WIN ? [] : [[`${t.dirs.log}/`, t.dirs.log]];
        for (const [prefix, host] of [['/tmp/', t.dirs.tmp], ['/data/', t.dirs.data], ...declared]) {
          const made = await t.broker.handle('mkdtemp', [prefix]);
          assert.ok(made.startsWith(prefix) && /^[A-Za-z0-9]{6}$/.test(made.slice(prefix.length)), `${prefix}: ${made}`);
          assert.ok(fs.statSync(path.join(host, path.posix.basename(made))).isDirectory(), prefix);
        }
        const before = fs.readdirSync(t.base).sort();
        for (const prefix of ['/tmp', '/data', ...(WIN ? [] : [t.dirs.log])]) {
          await assert.rejects(t.broker.handle('mkdtemp', [prefix]), code(mode === 'enforce' ? 'EROFS' : 'EACCES'), prefix);
        }
        assert.deepStrictEqual(fs.readdirSync(t.base).sort(), before, 'nothing made beside a root');
        // (a root reached by another name than its real one -- macOS's /var,
        // a symlinked home: a plain prefix is made, as Node makes it)
        // (a prefix inside a root, as before)
        assert.match(await t.broker.handle('mkdtemp', ['/data/pre-']), /^\/data\/pre-[A-Za-z0-9]{6}$/);
        // (the prefix's directory a link: judged by where it leads -- one out
        // is refused and nothing is made there; the medium on this PR, 1)
        const out = path.join(t.base, 'outside');
        fs.mkdirSync(out);
        let linked = true;
        try {
          fs.symlinkSync(out, path.join(t.dirs.data, 'to-out'), 'dir');
          fs.symlinkSync(path.join(t.dirs.tmp), path.join(t.dirs.data, 'to-tmp'), 'dir');
        } catch (e) {
          if (e.code !== 'EPERM') throw e;
          linked = false;
        }
        if (linked) {
          t.reports.length = 0;
          await assert.rejects(t.broker.handle('mkdtemp', ['/data/to-out/']), code(mode === 'enforce' ? 'ENOENT' : 'EACCES'));
          assert.deepStrictEqual(t.reports, mode === 'enforce' ? ['escape /data/to-out'] : ['escape /data/to-out', 'denied /data/to-out']);
          assert.deepStrictEqual(fs.readdirSync(out), [], 'nothing made outside');
          // (made where the link leads, answered in the module's own spelling)
          const made = await t.broker.handle('mkdtemp', ['/data/to-tmp/']);
          assert.match(made, /^\/data\/to-tmp\/[A-Za-z0-9]{6}$/);
          assert.ok(fs.statSync(path.join(t.dirs.tmp, path.posix.basename(made))).isDirectory(), made);
        }
      } finally { await t.done(); }
    });
  }

  it('a root whose host path is not its real path: mkdtemp makes a plain prefix; off refuses a root\'s own name too (round 2)', async function() {
    const base = tmp.mkdtemp('broker-shapes-');
    const realTmp = path.join(base, 'real-tmp');
    fs.mkdirSync(realTmp);
    try {
      fs.symlinkSync(realTmp, path.join(base, 'tmp'), 'dir');
    } catch (e) {
      if (e.code === 'EPERM') return this.skip();
      throw e;
    }
    const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data')};
    Object.values(dirs).forEach((d) => fs.mkdirSync(d));
    for (const mode of ['off', 'audit', 'enforce']) {
      const namespace = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: path.join(base, 'tmp'), declared: [], protectedPaths: []});
      await namespace.prepare();
      const broker = new FsBroker({name: 'm', mode, namespace, cwd: '/', report: () => {}});
      try {
        assert.match(await broker.handle('mkdtemp', ['/tmp/x-']), /^\/tmp\/x-[A-Za-z0-9]{6}$/, mode);
        assert.match(await broker.handle('mkdtemp', ['/tmp/']), /^\/tmp\/[A-Za-z0-9]{6}$/, mode);
        const before = fs.readdirSync(base).sort();
        await assert.rejects(broker.handle('mkdtemp', ['/data']), code(mode === 'enforce' ? 'EROFS' : 'EACCES'), mode);
        assert.deepStrictEqual(fs.readdirSync(base).sort(), before, `${mode}: nothing beside /data`);
      } finally { await broker.closeAll(); }
    }
  });

  for (const mode of ['audit', 'enforce']) {
    it(`${mode}: rmdir recursive: a root is EBUSY, its contents kept; a link is not followed; the quota gives back a tree's entries; mkdtemp counts one, '/tmp/' too`, async () => {
      const t = await setup(mode, {quota: {maxBytes: 1e6, maxEntries: 100, entries: 10}});
      try {
        fs.mkdirSync(path.join(t.dirs.data, 'tree', 'a'), {recursive: true});
        fs.writeFileSync(path.join(t.dirs.data, 'tree', 'a', 'x'), 'xyz');
        fs.mkdirSync(path.join(t.dirs.data, 'target'));
        fs.writeFileSync(path.join(t.dirs.data, 'target', 'keep'), '1');
        await assert.rejects(t.broker.handle('rmdir', ['/data', {recursive: true}]), code('EBUSY'));
        assert.ok(fs.existsSync(path.join(t.dirs.data, 'tree', 'a', 'x')), 'contents kept');
        if (!WIN) {
          fs.symlinkSync(path.join(t.dirs.data, 'target'), path.join(t.dirs.data, 'lnk'));
          await assert.rejects(t.broker.handle('rmdir', ['/data/lnk', {recursive: true}]), code('ENOTDIR'));
          assert.ok(fs.existsSync(path.join(t.dirs.data, 'target', 'keep')), 'the link\'s target is kept');
        }
        assert.strictEqual(t.quota.entries, 10);
        await t.broker.handle('mkdtemp', ['/tmp/']);
        await t.broker.handle('mkdtemp', ['/data/pre-']);
        assert.strictEqual(t.quota.entries, 12, 'each mkdtemp counted once');
        await t.broker.handle('rmdir', ['/data/tree', {recursive: true}]);
        assert.strictEqual(fs.existsSync(path.join(t.dirs.data, 'tree')), false);
        assert.strictEqual(t.quota.entries, 9, 'the tree\'s three entries given back');
      } finally { await t.done(); }
    });
  }

  for (const mode of ['audit', 'enforce']) {
    it(`${mode}: cp onto a declared rw root not made yet copies, making no parent (the high's F3)`, async function() {
      if (WIN) return this.skip(); // (a declared root is named by its host path: POSIX's here)
      const declared = (base) => {
        fs.mkdirSync(path.join(base, 'decl'));
        return [{path: path.join(base, 'decl', 'one.txt'), access: 'rw'}, {path: path.join(base, 'decl', 'two.txt'), access: 'rw'}];
      };
      const m = await runBrokered(path.join(__dirname, 'scripts', 'cp-root.js'), {patch: true, mode, declared});
      assert.strictEqual(m.ok, true, JSON.stringify(m));
      assert.deepStrictEqual(m.r, {sync: 'hello', promise: 'hello'});
    });
  }

  it('POSIX: a backslash at a prefix\'s end is a name\'s character, as Node reads it', async function() {
    if (WIN) return this.skip();
    const t = await setup('enforce');
    try {
      const made = await t.broker.handle('mkdtemp', ['/data/foo\\']);
      assert.ok(made.startsWith('/data/foo\\') && made.length === '/data/foo\\'.length + 6, made);
      assert.ok(fs.statSync(path.join(t.dirs.data, path.posix.basename(made))).isDirectory());
    } finally { await t.done(); }
  });

  tmp.hooks();
});
