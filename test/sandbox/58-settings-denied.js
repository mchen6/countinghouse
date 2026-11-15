'use strict';
// ch-local's settings file and its history in the always-denied set
// (lib/fs-broker/denied.js; #252's review): under audit and under enforce a
// module cannot read or write the --settingsFile or the history.jsonl
// beside it, however it names them -- directly, through `..`, through a
// symlink in its /tmp, or through a hard link in a declared rw directory --
// even when its declared rw directory is the very directory they live in. A
// module that rewrote the settings file would loosen the next start; the
// history names sessions and every change. Under off nothing is decided.
//
// Ports 9794 (audit) and 9795 (enforce), in B's block (test/ports.md).
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {toolOutput} = require('../helpers/tool-result');

const ADMIN   = 'settings-denied-admin-key';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'deny-probe');
const NAME    = 'deny-probe';
const tool    = (a) => `deny_probe_probeservice_${a.toLowerCase()}`;

// the settings home is the module's own declared rw directory: the denial
// is by file, not by what the module may otherwise reach
function world(tag) {
  const base = fs.mkdtempSync(path.join(os.homedir(), `.ch-settings-denied-${tag}-`));
  const w = {base, home: path.join(base, 'home'), authPath: path.join(base, 'auth.json'), store: path.join(base, 'store')};
  fs.mkdirSync(w.home);
  w.settings = path.join(w.home, 'settings.json');
  w.history = path.join(w.home, 'history.jsonl');
  w.settingsBytes = `${JSON.stringify({version: 1, values: {maxOutputBytes: 1000}})}\n`;
  fs.writeFileSync(w.settings, w.settingsBytes);
  fs.writeFileSync(w.history, `${JSON.stringify({at: '2026-11-15T00:00:00.000Z', by: 'terminal', setting: 'maxOutputBytes', old: 2000, new: 1000})}\n`);
  fs.writeFileSync(path.join(w.home, 'ok.txt'), 'declared');
  fs.writeFileSync(w.authPath, JSON.stringify({[ADMIN]: {userName: 'admin', devices: ['*'], admin: true}}));
  w.policy = path.join(base, 'policy.json');
  fs.writeFileSync(w.policy, JSON.stringify({modules: {[NAME]: {approve: 'as-declared'}}}));
  const dir = path.join(base, NAME);
  fs.cpSync(FIXTURE, dir, {recursive: true});
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.countinghouse.permissions.fs = [{path: w.home, access: 'rw'}];
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  w.fixture = dir;
  w.moduleTmp = path.join(w.store, NAME, 'tmp');
  return w;
}

describe('sandbox 58: the settings file and its history are always denied', function() {
  this.timeout(180000);
  if (process.platform === 'win32') return;   // symlinks and hard links as on POSIX; Windows' own runs in stdio 08/09

  [['audit', testPort(9794)], ['enforce', testPort(9795)]].forEach(([mode, port]) => {
    describe(mode, () => {
      let w = null;
      let server = null;
      const call = (action, args) => mcpCall(port, ADMIN, tool(action), args).then(toolOutput);
      before(async () => {
        w = world(mode);
        server = await startServer(port, ['--workerThread', '--authConfigPath', w.authPath, '--moduleDataPath', w.store,
          '--moduleSandbox', mode, '--modulePolicy', w.policy, '--settingsFile', w.settings, '--loadModule', w.fixture]);
      });
      after(() => {
        stopServer(server);
        if (w != null) fs.rmSync(w.base, {recursive: true, force: true});
      });

      it('another file in the same declared directory is readable: the denial is by file', async () => {
        assert.deepStrictEqual(await call('read', {path: path.join(w.home, 'ok.txt')}), {content: 'declared', code: null});
      });

      it('both are EACCES to read and to write by their own paths, and the settings file is unchanged', async () => {
        for (const p of [w.settings, w.history]) {
          assert.deepStrictEqual(await call('read', {path: p}), {content: null, code: 'EACCES'}, p);
          assert.deepStrictEqual(await call('write', {path: p, content: '{}'}), {ok: false, code: 'EACCES'}, p);
        }
        assert.strictEqual(fs.readFileSync(w.settings, 'utf8'), w.settingsBytes);
      });

      it('both are EACCES through `..`, a symlink in /tmp and a hard link in the declared directory', async () => {
        for (const [p, tag] of [[w.settings, 's'], [w.history, 'h']]) {
          assert.deepStrictEqual(await call('read', {path: path.posix.join('/data', '..', p)}), {content: null, code: 'EACCES'}, `.. ${p}`);
          fs.symlinkSync(p, path.join(w.moduleTmp, `${tag}-link`));
          assert.deepStrictEqual(await call('read', {path: `/tmp/${tag}-link`}), {content: null, code: 'EACCES'}, `symlink ${p}`);
          assert.deepStrictEqual(await call('write', {path: `/tmp/${tag}-link`, content: 'x'}), {ok: false, code: 'EACCES'}, `symlink write ${p}`);
          fs.linkSync(p, path.join(w.home, `${tag}-hard`));
          assert.deepStrictEqual(await call('read', {path: path.join(w.home, `${tag}-hard`)}), {content: null, code: 'EACCES'}, `hard link ${p}`);
        }
        assert.strictEqual(fs.readFileSync(w.settings, 'utf8'), w.settingsBytes);
      });

      it('still EACCES after the settings file is replaced by a rename (as the settings tool writes it: a new inode)', async () => {
        const tmp = `${w.settings}.new`;
        fs.writeFileSync(tmp, w.settingsBytes);
        fs.renameSync(tmp, w.settings);
        assert.deepStrictEqual(await call('read', {path: w.settings}), {content: null, code: 'EACCES'});
        assert.deepStrictEqual(await call('read', {path: '/tmp/s-link'}), {content: null, code: 'EACCES'});
      });
    });
  });
});
