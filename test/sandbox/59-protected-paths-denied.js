'use strict';
// countinghouse's protected paths are no module's, in a deployment of
// countinghouse alone (no ch-local, no --settingsFile; #253's follow-up,
// #260's review): under audit and under enforce every path in each of
// protectedPaths() and every module root -- --modulePath and each
// --loadModule (every module's code), --moduleDataPath (every module's
// data), the local store, the auth configuration, the device configuration,
// the module policy, the --remoteCredentials file (where each credential may
// be sent: a module that rewrote it could send one to an origin of its own)
// -- is EACCES to reads and writes, however the module
// names it, but its own base roots (its code at /app, its /data and /tmp), by
// their real paths at load; also while a module is being validated, whose
// spawn swaps --moduleDataPath for a throwaway. The install directory stays
// readable but for its top-level dot entries (.git, .env*, .npmrc, .claude,
// any other) and a top-level auth.json. A recursive listing from above shows
// none of the protected paths.
//
// Ports 9796 (audit), 9797 (enforce) and 9798 (a validation under audit), in
// B's block (test/ports.md).
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {toolOutput} = require('../helpers/tool-result');

const ADMIN   = 'protected-denied-admin-key';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'deny-probe');
const SIBLING = path.join(ROOT, 'test', 'fixtures', 'handler-map-module');
const NAME    = 'deny-probe';
const tool    = (a) => `deny_probe_probeservice_${a.toLowerCase()}`;
// the install's names refused to every module, existing or not
const INSTALL_SECRETS = ['.git', path.join('.git', 'config'), '.env', '.env.local', '.npmrc', path.join('.claude', 'settings.json'), 'auth.json', '.anything'];

function world(tag) {
  const base = fs.mkdtempSync(path.join(os.homedir(), `.ch-protected-${tag}-`));
  const at = (...p) => path.join(base, ...p);
  const w = {base, modules: at('modules'), moduleData: at('module_data'), store: at('store'), devices: at('config', 'devices'),
    authPath: at('auth.json'), policy: at('policy.json'), rw: at('rw'), credentials: at('conf', 'remote-credentials.json')};
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
  fs.mkdirSync(path.dirname(w.credentials));
  fs.writeFileSync(w.credentials, JSON.stringify({'https://api.example.com': ['EXAMPLE_TOKEN']}));
  // the module and a sibling, each loaded from its own directory (--loadModule)
  w.fixture = at('srv', 'a');
  w.sibling = at('srv', 'b');
  fs.cpSync(FIXTURE, w.fixture, {recursive: true});
  fs.cpSync(SIBLING, w.sibling, {recursive: true});
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
          '--store', 'local', '--storePath', w.store, '--deviceConfigPath', w.devices, '--remoteCredentials', w.credentials,
          '--moduleSandbox', mode, '--modulePolicy', w.policy, '--loadModule', w.fixture, '--loadModule', w.sibling]);
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

      it('another module\'s code and data, the store, the device config, the policy, the remote credentials file: EACCES to read and to write', async () => {
        for (const p of [w.otherCode, w.otherData, w.kv, w.device, w.policy, w.credentials]) {
          assert.deepStrictEqual(await call('read', {path: p}), {content: null, code: 'EACCES'}, `read ${p}`);
          assert.deepStrictEqual(await call('write', {path: p, content: 'planted'}), {ok: false, code: 'EACCES'}, `write ${p}`);
        }
        assert.strictEqual(fs.readFileSync(w.kv, 'utf8'), '{}', 'the store is untouched');
        assert.strictEqual(fs.readFileSync(w.credentials, 'utf8'), JSON.stringify({'https://api.example.com': ['EXAMPLE_TOKEN']}), 'the credentials file is untouched');
        // nor made anew beside it, or replaced: its directory is no module's to write under either mode
        assert.strictEqual((await call('write', {path: `${w.credentials}.new`, content: '{}'})).ok, false);
      });

      it('a sibling loaded with --loadModule from its own directory: its code is EACCES to read and to write (G2)', async () => {
        const p = path.join(w.sibling, 'package.json');
        assert.deepStrictEqual(await call('read', {path: p}), {content: null, code: 'EACCES'});
        assert.deepStrictEqual(await call('write', {path: path.join(w.sibling, 'actions.js'), content: 'planted'}), {ok: false, code: 'EACCES'});
      });

      it('the install\'s top-level dot entries and auth.json are EACCES to read and to write; the rest of it is as any outside path', async () => {
        for (const name of INSTALL_SECRETS) {
          const p = path.join(ROOT, name);
          assert.deepStrictEqual(await call('read', {path: p}), {content: null, code: 'EACCES'}, `read ${name}`);
          assert.deepStrictEqual(await call('write', {path: p, content: 'planted'}), {ok: false, code: 'EACCES'}, `write ${name}`);
        }
        const plain = await call('read', {path: path.join(ROOT, 'package.json')});
        assert.ok(mode === 'audit' ? plain.code === null : plain.code === 'ENOENT', JSON.stringify(plain).slice(0, 200));
      });

      it('and through a symlink in its own /tmp', async () => {
        for (const [p, tag] of [[w.otherData, 'data'], [w.kv, 'kv'], [w.otherCode, 'code'], [path.join(w.sibling, 'package.json'), 'sibling']]) {
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
          assert.deepStrictEqual(names.filter((n) => /(^|\/)(other|kv\.json|device\.json|b)(\/|$)/.test(n)), [], `${from}: ${JSON.stringify(names)}`);
        }
      });
    });
  });

  // A validation's spawn swaps --moduleDataPath for a throwaway under
  // <moduleDataPath>/.validate: the real one stays protected while the
  // validated code runs (G1). The probe reads a live module's /data file
  // when the validator requires it, and throws what it got.
  describe('a module being validated (audit)', () => {
    const port = testPort(9798);
    let w = null;
    let server = null;
    before(async () => {
      w = world('validate');
      w.secret = path.join(w.moduleData, NAME, 'data', 'secret.txt');
      fs.mkdirSync(path.dirname(w.secret), {recursive: true});
      fs.writeFileSync(w.secret, 'live module data');
      w.probe = path.join(w.base, 'probe');
      fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'validate-probe'), w.probe, {recursive: true});
      fs.writeFileSync(path.join(w.probe, 'handlers', 'probeService', 'probe.js'),
        `const seen = {};\nseen.other = (() => { try { return 'read:' + require('fs').readFileSync(${JSON.stringify(w.secret)}, 'utf8'); } catch (e) { return e.code; } })();\n` +
        'throw new Error(`VALIDATE-PROBE ${JSON.stringify(seen)}`);\n');
      server = await startServer(port, ['--workerThread', '--debug', '--debugKey', 'k', '--authoringTools', '--moduleSandbox', 'audit',
        '--moduleDataPath', w.moduleData, '--modulePolicy', w.policy, '--loadModule', w.fixture]);
    });
    after(() => {
      stopServer(server);
      if (w != null) fs.rmSync(w.base, {recursive: true, force: true});
    });

    it('can\'t read another module\'s /data (G1)', async () => {
      const r = await mcpCall(port, 'k', 'countinghouse_validate_module', {path: w.probe});
      const text = JSON.stringify(r.structuredContent != null ? r.structuredContent : r).replace(/\\"/g, '"');
      const m = /VALIDATE-PROBE (\{[^}]*\})/.exec(text);
      assert.ok(m != null, text.slice(0, 600));
      assert.deepStrictEqual(JSON.parse(m[1]), {other: 'EACCES'}, text.slice(0, 600));
    });
  });
});
