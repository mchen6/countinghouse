'use strict';
// ch-local's home is no module's (#253, the reviewer's ruling). The home is
// the directory of --settingsFile; in ch-local it holds the daemon's session
// secret (run/), the launcher (bin/), every module's code (modules/) and
// data (module_data/), the pack records and the settings protocol. Under
// audit and under enforce:
//   - a declaration of the home, of anything in it or above it, is refused
//     (protectedPaths), and the module loads without it;
//   - every path in the home is EACCES to reads and writes, however the
//     module names it (directly, '/data/..', a symlink in its /tmp), but its
//     own namespace roots: its code (/app) and its own /data and /tmp, which
//     here live in the home as in ch-local (the broker's deniedHome);
//   - the settings file is also known by inode: a hard link in a declared
//     directory is EACCES, before and after the settings tool's rename;
//   - the home and the directories above it can't be renamed or removed.
// Off decides nothing; it is not run here.
//
// In the single-identity profile, over stdio, as ch-local runs it:
// --settingsFile is refused anywhere else (framework.js), so the module is a
// scenario (the profile lists scenarios only, by their bare action names).
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, waitFor} = require('../helpers/sandbox-server');
const {startStdio, INITIALIZE} = require('../helpers/stdio-client');
const {toolOutput} = require('../helpers/tool-result');

const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'deny-probe');
const NAME    = 'deny-probe';
// a scenario's tools are listed under their bare action names
const tool    = (a) => a;

// a home laid out as ch-local lays it out (ch-local's lib/home.js)
function world(tag) {
  const base = fs.mkdtempSync(path.join(os.homedir(), `.ch-home-denied-${tag}-`));
  const home = path.join(base, 'home');
  const at = (...p) => path.join(home, ...p);
  const w = {base, home, rw: path.join(base, 'rw'),
    settings: at('settings.json'), history: at('history.jsonl'), lock: at('settings.lock'), temp: at('settings.json.123.abcd.tmp'),
    secret: at('run', 'daemon', 'secret'), launcher: at('bin', 'ch-local.js'), packs: at('packs.json'),
    // the tokens ch-local credentials add stores (ch-local's credential store)
    credentials: at('credentials', 'credentials.json'),
    otherCode: at('modules', 'other', 'index.js'), otherData: at('module_data', 'other', 'data', 'x.txt'),
    modules: at('modules'), moduleData: at('module_data')};
  for (const f of [w.secret, w.launcher, w.otherCode, w.otherData, w.credentials]) fs.mkdirSync(path.dirname(f), {recursive: true});
  fs.mkdirSync(w.rw);
  // a second declared directory, under a parent the module may rename under
  // audit (the root swap of #253's security review, F1)
  w.proj = path.join(base, 'proj');
  w.work = path.join(w.proj, 'work');
  fs.mkdirSync(w.work, {recursive: true});
  w.settingsBytes = `${JSON.stringify({version: 1, values: {maxOutputBytes: 1000}})}\n`;
  fs.writeFileSync(w.settings, w.settingsBytes);
  fs.writeFileSync(w.history, '{"setting":"maxOutputBytes"}\n');
  for (const f of [w.lock, w.temp, w.secret, w.launcher, w.packs, w.otherCode, w.otherData, w.credentials]) fs.writeFileSync(f, 'x');
  w.launcherBytes = 'x';
  fs.writeFileSync(path.join(w.rw, 'ok.txt'), 'declared');
  // a hard link to the settings file in the directory the module may declare
  w.hard = path.join(w.rw, 'settings-hard');
  fs.linkSync(w.settings, w.hard);
  w.policy = path.join(base, 'policy.json');
  fs.writeFileSync(w.policy, JSON.stringify({modules: {[NAME]: {approve: 'as-declared'}}}));
  // the module installed in the home, as ch-local installs a pack
  w.fixture = at('modules', NAME);
  fs.cpSync(FIXTURE, w.fixture, {recursive: true});
  const pkgPath = path.join(w.fixture, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.countinghouse.permissions.fs = [{path: home, access: 'rw'}, {path: w.rw, access: 'rw'}, {path: w.work, access: 'rw'}];
  pkg.countinghouse.role = 'scenario';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  w.moduleTmp = path.join(w.moduleData, NAME, 'tmp');
  return w;
}

describe('sandbox 58: ch-local\'s home is no module\'s', function() {
  this.timeout(180000);
  if (process.platform === 'win32') return;   // symlinks and hard links as on POSIX

  ['audit', 'enforce'].forEach((mode) => {
    describe(mode, () => {
      let w = null;
      let io = null;
      let id = 1;
      // a module tool's call over stdio -> its output
      const call = async (action, args) => {
        const r = await io.request({jsonrpc: '2.0', id: ++id, method: 'tools/call', params: {name: tool(action), arguments: args || {}}}, 30000);
        if (r.error != null) throw new Error(`${action}: ${JSON.stringify(r.error)}`);
        return toolOutput(r.result);
      };
      const untouched = () => {
        assert.strictEqual(fs.readFileSync(w.settings, 'utf8'), w.settingsBytes, 'the settings file is untouched');
        assert.strictEqual(fs.readFileSync(w.launcher, 'utf8'), w.launcherBytes, 'the launcher is untouched');
      };
      before(async () => {
        w = world(mode);
        io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(w.base, 'store'), '--modulePath', w.modules, '--moduleDataPath', w.moduleData,
          '--moduleSandbox', mode, '--modulePolicy', w.policy, '--settingsFile', w.settings, '--loadModule', w.fixture]);
        const init = await io.request(INITIALIZE, 60000);
        assert.ok(init.result != null, `${JSON.stringify(init)}: ${io.err.slice(-1500)}`);
      });
      after(async () => {
        // a child already ended (by a signal too) has nothing to wait for
        if (io != null && io.child.exitCode == null && io.child.signalCode == null) { io.child.kill('SIGKILL'); await new Promise((r) => io.child.once('exit', r)); }
        if (w != null) fs.rmSync(w.base, {recursive: true, force: true});
      });

      it('the home\'s declaration is refused and the module loads without it; the one beside it is kept', async () => {
        await waitFor(() => io.err.includes(`${w.home} (overlaps countinghouse's`), 5000, 'the refusal', () => io.err.slice(-1500));
        assert.deepStrictEqual(await call('read', {path: path.join(w.rw, 'ok.txt')}), {content: 'declared', code: null});
      });

      it('the module\'s own roots in the home still work: its code, its /data and its /tmp', async () => {
        assert.strictEqual((await call('read', {path: '/app/package.json'})).code, null);
        assert.deepStrictEqual(await call('write', {path: '/data/mine.txt', content: 'mine'}), {ok: true, code: null});
        assert.deepStrictEqual(await call('read', {path: '/data/mine.txt'}), {content: 'mine', code: null});
        assert.deepStrictEqual(await call('write', {path: '/tmp/mine.txt', content: 'mine'}), {ok: true, code: null});
      });

      it('everything else in the home is EACCES to read and to write, by its own path', async () => {
        for (const p of [w.settings, w.history, w.lock, w.temp, w.secret, w.launcher, w.packs, w.otherCode, w.otherData, w.credentials]) {
          assert.deepStrictEqual(await call('read', {path: p}), {content: null, code: 'EACCES'}, `read ${p}`);
          assert.deepStrictEqual(await call('write', {path: p, content: 'planted'}), {ok: false, code: 'EACCES'}, `write ${p}`);
        }
        const fresh = `${w.settings}.999.beef.tmp`;
        assert.deepStrictEqual(await call('write', {path: fresh, content: '{}'}), {ok: false, code: 'EACCES'}, 'a new file in the home');
        assert.ok(!fs.existsSync(fresh));
        untouched();
      });

      it('EACCES through \'/data/..\' (the dots reach the broker) and through a symlink in its own /tmp', async () => {
        for (const [p, tag] of [[w.secret, 'secret'], [w.launcher, 'bin'], [w.packs, 'packs'], [w.otherCode, 'code'], [w.otherData, 'data'], [w.settings, 'settings'], [w.credentials, 'credentials']]) {
          const dotted = `/data/..${p}`;   // a string, not path.join: the broker resolves the '..'
          assert.deepStrictEqual(await call('read', {path: dotted}), {content: null, code: 'EACCES'}, dotted);
          fs.symlinkSync(p, path.join(w.moduleTmp, `${tag}-link`));
          assert.deepStrictEqual(await call('read', {path: `/tmp/${tag}-link`}), {content: null, code: 'EACCES'}, `symlink ${p}`);
          assert.deepStrictEqual(await call('write', {path: `/tmp/${tag}-link`, content: 'planted'}), {ok: false, code: 'EACCES'}, `symlink write ${p}`);
        }
        untouched();
      });

      // named on its own, so a later narrowing of the home rule can't
      // silently expose it: the stored tokens (ch-local credentials add)
      it('the stored credentials file is EACCES to read and to write, directly and through /data/.., and nothing can be written beside it', async () => {
        assert.deepStrictEqual(await call('read', {path: w.credentials}), {content: null, code: 'EACCES'});
        assert.deepStrictEqual(await call('read', {path: `/data/..${w.credentials}`}), {content: null, code: 'EACCES'});
        assert.deepStrictEqual(await call('write', {path: w.credentials, content: 'planted'}), {ok: false, code: 'EACCES'});
        assert.deepStrictEqual(await call('write', {path: path.join(path.dirname(w.credentials), 'beside.json'), content: 'planted'}), {ok: false, code: 'EACCES'});
        assert.strictEqual(fs.readFileSync(w.credentials, 'utf8'), 'x', 'untouched');
        assert.deepStrictEqual(fs.readdirSync(path.dirname(w.credentials)), ['credentials.json']);
      });

      it('a hard link to the settings file in a declared directory is EACCES, before and after the file is replaced by a rename', async () => {
        assert.deepStrictEqual(await call('read', {path: w.hard}), {content: null, code: 'EACCES'});
        assert.deepStrictEqual(await call('write', {path: w.hard, content: '{}'}), {ok: false, code: 'EACCES'});
        const tmp = path.join(w.base, 'settings.json.new');
        const before = fs.statSync(w.settings).ino;
        fs.writeFileSync(tmp, w.settingsBytes);
        fs.renameSync(tmp, w.settings);
        assert.notStrictEqual(fs.statSync(w.settings).ino, before, 'premise: a new inode');
        assert.strictEqual(fs.statSync(w.hard).ino, before, 'premise: the hard link holds the old one');
        assert.deepStrictEqual(await call('read', {path: w.hard}), {content: null, code: 'EACCES'}, 'the old inode, by its hard link');
        assert.deepStrictEqual(await call('write', {path: w.hard, content: '{}'}), {ok: false, code: 'EACCES'});
      });

      it('the home and the directory above it can\'t be renamed or removed (no swapping in a planted home)', async () => {
        assert.deepStrictEqual(await call('rename', {from: w.home, to: `${w.home}.old`}), {ok: false, code: 'EACCES'});
        // above the module's roots, enforce answers a write EROFS before the
        // guard; either way it is refused
        const above = await call('rename', {from: w.base, to: `${w.base}.old`});
        assert.ok(above.ok === false && ['EACCES', 'EROFS'].includes(above.code), JSON.stringify(above));
        assert.deepStrictEqual(await call('remove', {path: w.home}), {ok: false, code: 'EACCES'});
        assert.ok(fs.existsSync(w.settings) && fs.existsSync(w.secret) && !fs.existsSync(`${w.base}.old`));
        untouched();
      });

      it('a declared root that later resolves into the home doesn\'t make the home the module\'s own (F1)', async () => {
        // the state #253's security review reached: after load, the declared
        // root's path leads into the home (set up here on the host)
        fs.renameSync(w.proj, `${w.proj}.old`);
        fs.mkdirSync(w.proj);
        fs.symlinkSync(w.home, w.work);
        await new Promise((r) => setTimeout(r, 1500));   // past any once-a-second re-read of a root
        const through = path.join(w.work, 'run', 'daemon', 'secret');
        const r = await call('read', {path: through});
        assert.deepStrictEqual(r, {content: null, code: 'EACCES'}, `the secret, through the declared root: ${JSON.stringify(r)}`);
        assert.deepStrictEqual(await call('write', {path: through, content: 'planted'}), {ok: false, code: 'EACCES'});
        assert.strictEqual(fs.readFileSync(w.secret, 'utf8'), 'x', 'the secret is untouched');
        const other = await call('read', {path: path.join(w.work, 'module_data', 'other', 'data', 'x.txt')});
        assert.deepStrictEqual(other, {content: null, code: 'EACCES'}, 'another module\'s data, through the declared root');
      });

      it('a recursive listing from above the home shows nothing in it (F2)', async () => {
        const r = await call('list', {path: w.base});
        const names = r.names || [];
        assert.deepStrictEqual(names.filter((n) => n === 'home' || n.startsWith('home/') || n.includes('/home/')), [], JSON.stringify(names));
      });

      it('a recursive listing through a symlink to the home\'s parent shows nothing in the home (F2)', async () => {
        // the module makes the link itself where it may (under audit an
        // outside symlink is allowed); else the host makes it, the same state
        const link = path.join(w.base, 'up');
        const made = await call('symlink', {path: link, target: w.base});
        if (made.ok !== true) fs.symlinkSync(w.base, link);
        const r = await call('list', {path: link});
        const names = r.names || [];
        assert.deepStrictEqual(names.filter((n) => n === 'home' || n.startsWith('home/') || n.includes('/home/')), [], JSON.stringify(names));
      });

      it('a recursive listing that meets a symlinked subdirectory into the home shows nothing in it (F2)', async () => {
        const deep = path.join(w.base, 'deep');
        fs.mkdirSync(deep);
        fs.symlinkSync(w.home, path.join(deep, 'into-home'));
        fs.symlinkSync(w.base, path.join(deep, 'up-again'));
        const r = await call('list', {path: deep});
        const names = r.names || [];
        assert.deepStrictEqual(names.filter((n) => /(^|\/)(run|module_data|bin|settings\.json|history\.jsonl)(\/|$)/.test(n) || n.includes('into-home')), [], JSON.stringify(names));
      });

      it('a history deleted on the host can\'t be created by the module', async () => {
        fs.rmSync(w.history);
        assert.deepStrictEqual(await call('write', {path: w.history, content: 'planted'}), {ok: false, code: 'EACCES'});
        assert.ok(!fs.existsSync(w.history));
      });

      it('each denial is recorded', async () => {
        await waitFor(() => io.err.includes(`module sandbox: ${NAME} file denied ${w.secret}`), 5000, 'the secret\'s denial line',
          () => io.err.split('\n').filter((l) => l.includes('module sandbox')).slice(-8));
      });
    });
  });
});
