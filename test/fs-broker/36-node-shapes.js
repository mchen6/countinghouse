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
const tmp = require('../helpers/test-tmp').forFile(['broker-shapes-']);

const SCRIPT = path.join(__dirname, 'scripts', 'node-shapes.js');

async function setup(mode, {guarded = true} = {}) {
  const base = tmp.mkdtemp('broker-shapes-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp'), log: path.join(base, 'log')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  fs.writeFileSync(path.join(dirs.data, 'f'), 'own');
  const namespace = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [{path: dirs.log, access: 'rw'}], protectedPaths: []});
  await namespace.prepare();
  const reports = [];
  const broker = new FsBroker({name: 'm', mode, namespace, cwd: '/', report: (rule, target) => reports.push(`${rule} ${target}`),
    ...(guarded ? {installSecrets: path.join(base, 'no-install'), deniedTrees: []} : {})});
  return {base, dirs, broker, reports, done: () => broker.closeAll()};
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
    });

    it(`${mode}: readdir and opendir of a missing directory answer ENOENT, unreported (A1)`, async () => {
      const t = await setup(mode);
      try {
        fs.symlinkSync(path.join(t.dirs.data, 'gone'), path.join(t.dirs.data, 'dangling'));
        await assert.rejects(t.broker.handle('readdir', ['/data/no-such-dir', {}]), code('ENOENT'));
        await assert.rejects(t.broker.handle('readdir', ['/data/dangling', {}]), code('ENOENT'));
        await assert.rejects(t.broker.handle('readdir', ['/data/f/x', {}]), code('ENOTDIR'));
        assert.deepStrictEqual(t.reports, []);
        assert.deepStrictEqual(await t.broker.handle('readdir', ['/data', {}]), ['dangling', 'f']);
      } finally { await t.done(); }
    });

    it(`${mode}: mkdtemp with a trailing separator makes the directory inside; a root's own name is refused (A2)`, async () => {
      const t = await setup(mode);
      try {
        for (const [prefix, host] of [['/tmp/', t.dirs.tmp], ['/data/', t.dirs.data], [`${t.dirs.log}/`, t.dirs.log]]) {
          const made = await t.broker.handle('mkdtemp', [prefix]);
          assert.ok(made.startsWith(prefix) && /^[A-Za-z0-9]{6}$/.test(made.slice(prefix.length)), `${prefix}: ${made}`);
          assert.ok(fs.statSync(path.join(host, path.posix.basename(made))).isDirectory(), prefix);
        }
        const before = fs.readdirSync(t.base).sort();
        for (const prefix of ['/tmp', '/data', t.dirs.log]) {
          await assert.rejects(t.broker.handle('mkdtemp', [prefix]), code(mode === 'enforce' ? 'EROFS' : 'EACCES'), prefix);
        }
        assert.deepStrictEqual(fs.readdirSync(t.base).sort(), before, 'nothing made beside a root');
        // (a prefix inside a root, as before)
        assert.match(await t.broker.handle('mkdtemp', ['/data/pre-']), /^\/data\/pre-[A-Za-z0-9]{6}$/);
      } finally { await t.done(); }
    });
  }

  tmp.hooks();
});
