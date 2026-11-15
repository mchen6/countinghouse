'use strict';
// countinghouse's protected paths are no module's, in a deployment of
// countinghouse alone (no ch-local, no --settingsFile; #253's follow-up):
// under audit and under enforce every path in each of protectedPaths() but
// the install (public code, and in a checkout the repository itself) --
// --modulePath (every module's code), --moduleDataPath (every module's
// data), the local store, the auth configuration, the device configuration,
// the module policy -- is EACCES to reads and writes, however
// the module names it, but its own base roots (its code at /app, its /data
// and /tmp), by their real paths at load. A recursive listing from above
// shows none of it.
//
// Ports 9796 (audit) and 9797 (enforce), in B's block (test/ports.md).
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {toolOutput} = require('../helpers/tool-result');

const ADMIN   = 'protected-denied-admin-key';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'deny-probe');
const NAME    = 'deny-probe';
const tool    = (a) => `deny_probe_probeservice_${a.toLowerCase()}`;

function world(tag) {
  const base = fs.mkdtempSync(path.join(os.homedir(), `.ch-protected-${tag}-`));
  const at = (...p) => path.join(base, ...p);
  const w = {base, modules: at('modules'), moduleData: at('module_data'), store: at('store'), devices: at('config', 'devices'),
    authPath: at('auth.json'), policy: at('policy.json'), rw: at('rw')};
  w.otherCode = path.join(w.modules, 'other', 'index.js');
  w.otherData = path.join(w.moduleData, 'other', 'data', 'x.txt');
  w.kv = path.join(w.store, 'kv.json');
  w.device = path.join(w.devices, 'device.json');
  for (const f of [w.otherCode, w.otherData, w.kv, w.device]) fs.mkdirSync(path.dirname(f), {recursive: true});
  fs.mkdirSync(w.rw);
  for (const f of [w.otherCode, w.otherData, w.device]) fs.writeFileSync(f, 'x');
  fs.writeFileSync(w.kv, '{}');
  fs.writeFileSync(path.join(w.rw, 'ok.txt'), 'declared');
  fs.writeFileSync(w.authPath, JSON.stringify({[ADMIN]: {userName: 'admin', devices: ['*'], admin: true}}));
  fs.writeFileSync(w.policy, JSON.stringify({modules: {[NAME]: {approve: 'as-declared'}}}));
  w.fixture = path.join(w.modules, NAME);
  fs.cpSync(FIXTURE, w.fixture, {recursive: true});
  const pkgPath = path.join(w.fixture, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.countinghouse.permissions.fs = [{path: w.rw, access: 'rw'}];
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  w.moduleTmp = path.join(w.moduleData, NAME, 'tmp');
  return w;
}

describe('sandbox 59: countinghouse\'s protected paths are no module\'s', function() {
  this.timeout(180000);
  if (process.platform === 'win32') return;   // symlinks as on POSIX

  [['audit', testPort(9796)], ['enforce', testPort(9797)]].forEach(([mode, port]) => {
    describe(mode, () => {
      let w = null;
      let server = null;
      const call = (action, args) => mcpCall(port, ADMIN, tool(action), args).then(toolOutput);
      before(async () => {
        w = world(mode);
        server = await startServer(port, ['--workerThread', '--authConfigPath', w.authPath, '--modulePath', w.modules, '--moduleDataPath', w.moduleData,
          '--store', 'local', '--storePath', w.store, '--deviceConfigPath', w.devices,
          '--moduleSandbox', mode, '--modulePolicy', w.policy, '--loadModule', w.fixture]);
      });
      after(() => {
        stopServer(server);
        if (w != null) fs.rmSync(w.base, {recursive: true, force: true});
      });

      it('the module\'s own roots work, and its declared directory', async () => {
        assert.strictEqual((await call('read', {path: '/app/package.json'})).code, null);
        assert.deepStrictEqual(await call('write', {path: '/data/mine.txt', content: 'mine'}), {ok: true, code: null});
        assert.deepStrictEqual(await call('read', {path: '/data/mine.txt'}), {content: 'mine', code: null});
        assert.deepStrictEqual(await call('read', {path: path.join(w.rw, 'ok.txt')}), {content: 'declared', code: null});
      });

      it('another module\'s code and data, the store, the device config, the policy: EACCES to read and to write', async () => {
        for (const p of [w.otherCode, w.otherData, w.kv, w.device, w.policy]) {
          assert.deepStrictEqual(await call('read', {path: p}), {content: null, code: 'EACCES'}, `read ${p}`);
          assert.deepStrictEqual(await call('write', {path: p, content: 'planted'}), {ok: false, code: 'EACCES'}, `write ${p}`);
        }
        assert.strictEqual(fs.readFileSync(w.kv, 'utf8'), '{}', 'the store is untouched');
      });

      it('and through a symlink in its own /tmp', async () => {
        for (const [p, tag] of [[w.otherData, 'data'], [w.kv, 'kv'], [w.otherCode, 'code']]) {
          fs.symlinkSync(p, path.join(w.moduleTmp, `${tag}-link`));
          assert.deepStrictEqual(await call('read', {path: `/tmp/${tag}-link`}), {content: null, code: 'EACCES'}, `symlink ${p}`);
        }
      });

      it('a dangling link in its own /data is still listed, as the link it is', async () => {
        fs.symlinkSync(path.join(w.base, 'no-such-target'), path.join(w.moduleData, NAME, 'data', 'dangling'));
        const names = (await call('list', {path: '/data'})).names || [];
        assert.ok(names.includes('dangling'), JSON.stringify(names));
      });

      it('a recursive listing from above shows none of them, even through a symlink', async () => {
        const link = path.join(w.base, 'up');
        fs.symlinkSync(w.base, link);
        for (const from of [w.base, link]) {
          const names = (await call('list', {path: from})).names || [];
          assert.deepStrictEqual(names.filter((n) => /(^|\/)(other|kv\.json|device\.json)(\/|$)/.test(n)), [], `${from}: ${JSON.stringify(names)}`);
        }
      });
    });
  });
});
