'use strict';
// ch-local's settings protocol is no module's (#253; #252's review). The
// home is the directory of --settingsFile, and in ch-local it also holds the
// runtime's own module and data directories, so the guard names the
// protocol, not the whole home. Under audit and under enforce:
//   - a declaration of the home, of anything in it or above it, is refused
//     (protectedPaths), and the module loads without it;
//   - the settings file, its history, the lock and the settings tool's temp
//     files are EACCES to reads and writes, however the module names them:
//     directly, through '/data/..', through a symlink in its /tmp (the lock
//     and the temp files by name: lib/fs-broker/denied.js DeniedNames);
//   - the settings file and the history are also in the always-denied set,
//     known by inode: a hard link in a declared directory is EACCES, before
//     and after the settings tool replaces the file by a rename;
//   - the home and the directories above it cannot be renamed or removed
//     (the ancestor guard), so it cannot be swapped for a planted one.
// Off decides nothing; it is not run here (sandbox 34 shows off's reads).
//
// Ports 9794 (audit) and 9795 (enforce), in B's block (test/ports.md).
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall, waitFor} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {toolOutput} = require('../helpers/tool-result');

const ADMIN   = 'settings-denied-admin-key';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'deny-probe');
const NAME    = 'deny-probe';
const tool    = (a) => `deny_probe_probeservice_${a.toLowerCase()}`;

function world(tag) {
  const base = fs.mkdtempSync(path.join(os.homedir(), `.ch-settings-denied-${tag}-`));
  const w = {base, home: path.join(base, 'home'), rw: path.join(base, 'rw'), authPath: path.join(base, 'auth.json'), store: path.join(base, 'store')};
  fs.mkdirSync(w.home);
  fs.mkdirSync(w.rw);
  w.settings = path.join(w.home, 'settings.json');
  w.history = path.join(w.home, 'history.jsonl');
  w.lock = path.join(w.home, 'settings.lock');
  w.temp = path.join(w.home, 'settings.json.123.abcd.tmp');
  w.other = path.join(w.home, 'other.txt');
  w.settingsBytes = `${JSON.stringify({version: 1, values: {maxOutputBytes: 1000}})}\n`;
  fs.writeFileSync(w.settings, w.settingsBytes);
  fs.writeFileSync(w.history, `${JSON.stringify({at: '2026-11-15T00:00:00.000Z', by: 'terminal', setting: 'maxOutputBytes', old: 2000, new: 1000})}\n`);
  fs.writeFileSync(w.lock, '');
  fs.writeFileSync(w.temp, '{}');
  fs.writeFileSync(w.other, 'other');
  fs.writeFileSync(path.join(w.rw, 'ok.txt'), 'declared');
  // a hard link to the settings file, made before the module runs, in the
  // directory it may declare: refused by inode, never by its path
  w.hard = path.join(w.rw, 'settings-hard');
  fs.linkSync(w.settings, w.hard);
  fs.writeFileSync(w.authPath, JSON.stringify({[ADMIN]: {userName: 'admin', devices: ['*'], admin: true}}));
  w.policy = path.join(base, 'policy.json');
  fs.writeFileSync(w.policy, JSON.stringify({modules: {[NAME]: {approve: 'as-declared'}}}));
  const dir = path.join(base, NAME);
  fs.cpSync(FIXTURE, dir, {recursive: true});
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  // it declares the home itself (refused) and a directory beside it (kept)
  pkg.countinghouse.permissions.fs = [{path: w.home, access: 'rw'}, {path: w.rw, access: 'rw'}];
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  w.fixture = dir;
  w.moduleTmp = path.join(w.store, NAME, 'tmp');
  return w;
}

describe('sandbox 58: ch-local\'s home is no module\'s', function() {
  this.timeout(180000);
  if (process.platform === 'win32') return;   // symlinks and hard links as on POSIX

  [['audit', testPort(9794)], ['enforce', testPort(9795)]].forEach(([mode, port]) => {
    describe(mode, () => {
      let w = null;
      let server = null;
      const call = (action, args) => mcpCall(port, ADMIN, tool(action), args).then(toolOutput);
      const unchanged = () => assert.strictEqual(fs.readFileSync(w.settings, 'utf8'), w.settingsBytes, 'the settings file is untouched');
      before(async () => {
        w = world(mode);
        server = await startServer(port, ['--workerThread', '--authConfigPath', w.authPath, '--moduleDataPath', w.store,
          '--moduleSandbox', mode, '--modulePolicy', w.policy, '--settingsFile', w.settings, '--loadModule', w.fixture]);
      });
      after(() => {
        stopServer(server);
        if (w != null) fs.rmSync(w.base, {recursive: true, force: true});
      });

      it('the home\'s declaration is refused and the module loads without it; the one beside it is kept', async () => {
        await waitFor(() => server.output.includes(`${w.home} (overlaps countinghouse's ${w.home})`), 5000, 'the refusal', () => server.output.slice(-1500));
        assert.deepStrictEqual(await call('read', {path: path.join(w.rw, 'ok.txt')}), {content: 'declared', code: null});
      });

      it('the settings file, its history, the lock and a temp file are EACCES to read and to write by their own paths', async () => {
        for (const p of [w.settings, w.history, w.lock, w.temp]) {
          assert.deepStrictEqual(await call('read', {path: p}), {content: null, code: 'EACCES'}, `read ${p}`);
          assert.deepStrictEqual(await call('write', {path: p, content: '{}'}), {ok: false, code: 'EACCES'}, `write ${p}`);
        }
        // a new temp file, as the settings tool names its own, cannot be made
        const fresh = `${w.settings}.999.beef.tmp`;
        assert.deepStrictEqual(await call('write', {path: fresh, content: '{}'}), {ok: false, code: 'EACCES'});
        assert.ok(!fs.existsSync(fresh));
        unchanged();
      });

      it('the guard is by name: another file in the home is as any outside path is (audit reads it; enforce: not there)', async () => {
        const r = await call('read', {path: w.other});
        assert.deepStrictEqual(r, mode === 'audit' ? {content: 'other', code: null} : {content: null, code: 'ENOENT'});
      });

      it('EACCES through \'/data/..\' (the dots reach the broker) and through a symlink in /tmp', async () => {
        for (const [p, tag] of [[w.settings, 's'], [w.history, 'h'], [w.lock, 'l']]) {
          const dotted = `/data/..${p}`;   // a string, not path.join: the broker resolves the '..'
          assert.deepStrictEqual(await call('read', {path: dotted}), {content: null, code: 'EACCES'}, dotted);
          fs.symlinkSync(p, path.join(w.moduleTmp, `${tag}-link`));
          assert.deepStrictEqual(await call('read', {path: `/tmp/${tag}-link`}), {content: null, code: 'EACCES'}, `symlink ${p}`);
          assert.deepStrictEqual(await call('write', {path: `/tmp/${tag}-link`, content: 'x'}), {ok: false, code: 'EACCES'}, `symlink write ${p}`);
        }
        unchanged();
      });

      it('a hard link to the settings file in a declared directory is EACCES, read and write, before and after the file is replaced by a rename', async () => {
        assert.deepStrictEqual(await call('read', {path: w.hard}), {content: null, code: 'EACCES'});
        assert.deepStrictEqual(await call('write', {path: w.hard, content: '{}'}), {ok: false, code: 'EACCES'});
        // replaced as the settings tool writes it: a new inode at the path;
        // the hard link now holds the old one
        const tmp = path.join(w.base, 'settings.json.new');
        const before = fs.statSync(w.settings).ino;
        fs.writeFileSync(tmp, w.settingsBytes);
        fs.renameSync(tmp, w.settings);
        assert.notStrictEqual(fs.statSync(w.settings).ino, before, 'premise: a new inode');
        assert.strictEqual(fs.statSync(w.hard).ino, before, 'premise: the hard link holds the old one');
        assert.deepStrictEqual(await call('read', {path: w.hard}), {content: null, code: 'EACCES'}, 'the old inode, by its hard link');
        assert.deepStrictEqual(await call('write', {path: w.hard, content: '{}'}), {ok: false, code: 'EACCES'});
        assert.deepStrictEqual(await call('read', {path: w.settings}), {content: null, code: 'EACCES'}, 'the new inode');
      });

      it('the home and the directory above it cannot be renamed or removed (no swapping in a planted home)', async () => {
        assert.deepStrictEqual(await call('rename', {from: w.home, to: `${w.home}.old`}), {ok: false, code: 'EACCES'});
        // above a declared directory, enforce answers a write EROFS before the
        // guard (an ancestor of a root); either way it is refused
        const above = await call('rename', {from: w.base, to: `${w.base}.old`});
        assert.ok(above.ok === false && ['EACCES', 'EROFS'].includes(above.code), JSON.stringify(above));
        assert.ok(fs.existsSync(w.base) && !fs.existsSync(`${w.base}.old`));
        assert.deepStrictEqual(await call('remove', {path: w.home}), {ok: false, code: 'EACCES'});
        assert.ok(fs.existsSync(w.settings) && fs.existsSync(w.history));
        unchanged();
      });

      it('a history deleted on the host cannot be created by the module', async () => {
        fs.rmSync(w.history);
        assert.deepStrictEqual(await call('write', {path: w.history, content: 'planted'}), {ok: false, code: 'EACCES'});
        assert.ok(!fs.existsSync(w.history));
      });
    });
  });
});
