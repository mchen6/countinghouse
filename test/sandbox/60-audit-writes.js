'use strict';
// Under --moduleSandbox audit a module reads outside its namespace (allowed,
// logged) but writes nothing there (maintainer's decision, 2026-11-15:
// audit means "watch what it reads, never let it change the user's files"). Every write-class
// operation whose target is outside the module's own area -- its /data, its
// /tmp and what it declared rw -- is EACCES and recorded as a denial: a write,
// a create, mkdir, rm, rename or link with either end outside, a symlink made
// outside (one made inside that points out is refused EPERM, in every mode,
// as before), chmod, truncate, a copy to an outside destination, and a write
// to /app or to a path declared r. Enforce and off are unchanged.
//
// Port 9799, in B's block (test/ports.md): the three modes run one after another.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall, waitFor} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {toolOutput} = require('../helpers/tool-result');

const ADMIN   = 'audit-writes-admin-key';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'deny-probe');
const NAME    = 'deny-probe';
const tool    = (a) => `deny_probe_probeservice_${a.toLowerCase()}`;
const PORT    = testPort(9799);

function world(tag) {
  const base = fs.mkdtempSync(path.join(os.homedir(), `.ch-audit-writes-${tag}-`));
  const at = (...p) => path.join(base, ...p);
  const w = {base, rw: at('rw'), ro: at('ro'), outside: at('outside'), store: at('store'), authPath: at('auth.json'), policy: at('policy.json')};
  for (const d of [w.rw, w.ro, w.outside]) fs.mkdirSync(d);
  w.file = path.join(w.outside, 'user-file.txt');
  fs.writeFileSync(w.file, 'the user\'s');
  fs.writeFileSync(path.join(w.ro, 'ro.txt'), 'read only');
  fs.writeFileSync(path.join(w.rw, 'mine.txt'), 'mine');
  fs.writeFileSync(w.authPath, JSON.stringify({[ADMIN]: {userName: 'admin', devices: ['*'], admin: true}}));
  fs.writeFileSync(w.policy, JSON.stringify({modules: {[NAME]: {approve: 'as-declared'}}}));
  w.fixture = at(NAME);
  fs.cpSync(FIXTURE, w.fixture, {recursive: true});
  const pkgPath = path.join(w.fixture, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.countinghouse.permissions.fs = [{path: w.rw, access: 'rw'}, {path: w.ro, access: 'r'}];
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  return w;
}

describe('sandbox 60: under audit, no write leaves the module\'s own area', function() {
  this.timeout(180000);
  if (process.platform === 'win32') return;   // links and modes as on POSIX
  let w = null;
  let server = null;
  const call = (action, args) => mcpCall(PORT, ADMIN, tool(action), args).then(toolOutput);
  const start = async (mode) => {
    w = world(mode);
    server = await startServer(PORT, ['--workerThread', '--authConfigPath', w.authPath, '--moduleDataPath', w.store,
      '--moduleSandbox', mode, '--modulePolicy', w.policy, '--loadModule', w.fixture]);
  };
  const stop = () => {
    stopServer(server);
    server = null;
    if (w != null) fs.rmSync(w.base, {recursive: true, force: true});
    w = null;
  };
  const untouched = () => assert.strictEqual(fs.readFileSync(w.file, 'utf8'), 'the user\'s', 'the user\'s file is untouched');

  describe('audit', () => {
    before(() => start('audit'));
    after(stop);

    it('a read outside works and is logged', async () => {
      assert.deepStrictEqual(await call('read', {path: w.file}), {content: 'the user\'s', code: null});
      await waitFor(() => server.output.includes(`module sandbox: ${NAME} file outside ${w.file}`), 5000, 'the read\'s line',
        () => server.output.split('\n').filter((l) => l.includes('module sandbox')).slice(-6));
    });

    it('a write, a create and a truncate outside are EACCES, recorded, and the file is unchanged', async () => {
      assert.deepStrictEqual(await call('write', {path: w.file, content: 'changed'}), {ok: false, code: 'EACCES'});
      assert.deepStrictEqual(await call('write', {path: path.join(w.outside, 'new.txt'), content: 'x'}), {ok: false, code: 'EACCES'});
      assert.deepStrictEqual(await call('truncate', {path: w.file}), {ok: false, code: 'EACCES'});
      assert.ok(!fs.existsSync(path.join(w.outside, 'new.txt')));
      untouched();
      await waitFor(() => server.output.includes(`module sandbox: ${NAME} file denied ${w.file}`), 5000, 'the denial line',
        () => server.output.split('\n').filter((l) => l.includes('module sandbox')).slice(-6));
    });

    it('mkdir, rm, chmod outside are EACCES', async () => {
      assert.deepStrictEqual(await call('mkdir', {path: path.join(w.outside, 'd')}), {ok: false, code: 'EACCES'});
      assert.deepStrictEqual(await call('remove', {path: w.file}), {ok: false, code: 'EACCES'});
      assert.deepStrictEqual(await call('chmod', {path: w.file}), {ok: false, code: 'EACCES'});
      assert.strictEqual(fs.statSync(w.file).mode & 0o777, fs.statSync(path.join(w.rw, 'mine.txt')).mode & 0o777, 'its mode unchanged');
      untouched();
    });

    it('rename and link with either end outside are EACCES', async () => {
      const mine = path.join(w.rw, 'mine.txt');
      assert.deepStrictEqual(await call('rename', {from: mine, to: path.join(w.outside, 'moved.txt')}), {ok: false, code: 'EACCES'}, 'own -> outside');
      assert.deepStrictEqual(await call('rename', {from: w.file, to: path.join(w.rw, 'taken.txt')}), {ok: false, code: 'EACCES'}, 'outside -> own');
      assert.deepStrictEqual(await call('link', {from: w.file, to: path.join(w.rw, 'second-name')}), {ok: false, code: 'EACCES'}, 'a second name in its own area for an outside file');
      assert.deepStrictEqual(await call('link', {from: mine, to: path.join(w.outside, 'linked')}), {ok: false, code: 'EACCES'}, 'own -> outside');
      assert.ok(fs.existsSync(mine) && !fs.existsSync(path.join(w.rw, 'second-name')));
      untouched();
    });

    it('a copy to an outside destination is EACCES; from outside into its own area it works (a read)', async () => {
      assert.deepStrictEqual(await call('copy', {from: path.join(w.rw, 'mine.txt'), to: path.join(w.outside, 'copied.txt')}), {ok: false, code: 'EACCES'});
      assert.ok(!fs.existsSync(path.join(w.outside, 'copied.txt')));
      assert.deepStrictEqual(await call('copy', {from: w.file, to: path.join(w.rw, 'copy-of-user-file.txt')}), {ok: true, code: null});
    });

    it('a symlink made outside is EACCES; one made inside pointing out is EPERM, as in every mode', async () => {
      assert.deepStrictEqual(await call('symlink', {path: path.join(w.outside, 'ln'), target: w.rw}), {ok: false, code: 'EACCES'});
      assert.deepStrictEqual(await call('symlink', {path: path.join(w.rw, 'out-link'), target: w.file}), {ok: false, code: 'EPERM'});
    });

    it('a descriptor opened read-only on an outside file changes nothing: fchmod, fchown, futimes, ftruncate, write are EACCES (W1)', async () => {
      fs.chmodSync(w.file, 0o600);
      const before = fs.statSync(w.file);
      const r = await call('fdmeta', {path: w.file});
      assert.deepStrictEqual(r, {open: 'ok', fchmod: 'EACCES', fchown: 'EACCES', futimes: 'EACCES', ftruncate: 'EACCES', write: 'EACCES'});
      const after = fs.statSync(w.file);
      assert.strictEqual(after.mode & 0o777, 0o600, 'its mode unchanged');
      assert.strictEqual(after.mtimeMs, before.mtimeMs, 'its times unchanged');
      untouched();
    });

    it('a write to /app or to a directory declared r is EACCES; its /data, /tmp and declared rw are writable', async () => {
      assert.deepStrictEqual(await call('write', {path: '/app/planted.js', content: 'x'}), {ok: false, code: 'EACCES'});
      assert.deepStrictEqual(await call('write', {path: path.join(w.ro, 'ro.txt'), content: 'x'}), {ok: false, code: 'EACCES'});
      assert.strictEqual(fs.readFileSync(path.join(w.ro, 'ro.txt'), 'utf8'), 'read only');
      for (const p of ['/data/a.txt', '/tmp/b.txt', path.join(w.rw, 'c.txt')]) {
        assert.deepStrictEqual(await call('write', {path: p, content: 'ok'}), {ok: true, code: null}, p);
      }
    });
  });

  describe('enforce (unchanged)', () => {
    before(() => start('enforce'));
    after(stop);

    it('an outside path is not there; a directory declared r is read-only', async () => {
      assert.deepStrictEqual(await call('write', {path: w.file, content: 'changed'}), {ok: false, code: 'ENOENT'});
      assert.deepStrictEqual(await call('write', {path: path.join(w.ro, 'ro.txt'), content: 'x'}), {ok: false, code: 'EROFS'});
      untouched();
    });

    it('a read-only descriptor of its own /app manifest or of an r file changes nothing: EROFS (W1)', async () => {
      const manifest = path.join(w.fixture, 'package.json');
      for (const [p, host] of [['/app/package.json', manifest], [path.join(w.ro, 'ro.txt'), path.join(w.ro, 'ro.txt')]]) {
        const before = fs.statSync(host);
        const r = await call('fdmeta', {path: p});
        assert.deepStrictEqual(r, {open: 'ok', fchmod: 'EROFS', fchown: 'EROFS', futimes: 'EROFS', ftruncate: 'EROFS', write: 'EROFS'}, p);
        const after = fs.statSync(host);
        assert.strictEqual(after.mode, before.mode, `${p}: its mode unchanged`);
        assert.strictEqual(after.mtimeMs, before.mtimeMs, `${p}: its times unchanged`);
      }
    });
  });

  describe('off (unchanged: decides nothing)', () => {
    before(() => start('off'));
    after(stop);

    it('a write outside goes through', async () => {
      assert.deepStrictEqual(await call('write', {path: w.file, content: 'changed under off'}), {ok: true, code: null});
      assert.strictEqual(fs.readFileSync(w.file, 'utf8'), 'changed under off');
    });
  });
});
