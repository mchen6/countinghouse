// Node's permission model refuses operations on a granted directory itself
// when another grant extends its name (/x/countinghouse and
// /x/countinghouse_module_data); paths inside it are unaffected
// (nodejs/node#66812). Up to Node 24.21 a sync realpath was spared, which
// realDir relied on (plan 2b, Task 5); from 24.22 it is refused too, so under
// --hardened the unrestricted parent resolves these directories and the
// child's realDir answers from that (lib/hardened-realpaths.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync, spawn} = require('child_process');

const ROOT = fs.realpathSync(path.join(__dirname, '..', '..'));

describe('fs-broker 10: permission grants that share a prefix', function() {
  this.timeout(30000);
  let base = null;
  afterEach(() => { if (base) fs.rmSync(base, {recursive: true, force: true}); });

  function underPermission(dir, code) {
    return execFileSync(process.execPath, ['--permission', `--allow-fs-read=${ROOT}`, `--allow-fs-read=${dir}`, `--allow-fs-read=${dir}_data`, '-e', code],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
  }

  // The quirk is Node's, and not every supported version has it: 24.0.0
  // allows the directory itself (the floor-shim PR's 24.0.0 CI leg), while
  // 22.23 and 24.14 refuse it. Where it is absent the case is skipped and
  // says so; the workaround stays, and the realDir case below holds either
  // way.
  it('reproduces the refusal on the directory itself (the assumption this works around)', function() {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.ch-perm-')));
    const dir = path.join(base, 'ch');
    fs.mkdirSync(dir);
    fs.mkdirSync(`${dir}_data`);
    const out = underPermission(dir, `require('fs/promises').realpath(${JSON.stringify(dir)}).then(() => console.log('ok'), (e) => console.log(e.code))`);
    if (out === 'ok') {
      this.test.title += ` -- skipped: Node ${process.version} allows the directory itself`;
      this.skip();
    }
    assert.strictEqual(out, 'ERR_ACCESS_DENIED');
  });

  it('realDir resolves the directory itself under the same grants, given the parent\'s real paths', async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.ch-perm-')));
    const dir = path.join(base, 'ch');
    fs.mkdirSync(dir);
    fs.mkdirSync(`${dir}_data`);
    const realpaths = require('../../lib/hardened-realpaths');
    const code = `require(${JSON.stringify(path.join(ROOT, 'lib', 'hardened-realpaths'))}).receive();
      try { console.log(require(${JSON.stringify(path.join(ROOT, 'lib', 'fs-broker'))}).realDir(${JSON.stringify(dir)})); } catch (e) { console.log(e.code); }`;
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${ROOT}`, `--allow-fs-read=${dir}`, `--allow-fs-read=${dir}_data`, '-e', code],
        {env: Object.assign({}, process.env, realpaths.childEnv()), stdio: ['ignore', 'pipe', 'ignore', 'pipe']});
      let text = '';
      child.stdout.on('data', (c) => { text += c; });
      child.on('exit', () => resolve(text.trim()));
      realpaths.send(child, {[dir]: dir});
    });
    assert.strictEqual(out, dir);
  });

  // A module must not choose its own /app: a package.json that is a symlink
  // into another directory leaves the module's own directory as its root.
  it('a module whose package.json is a symlink keeps its own directory as /app', async () => {
    const {createForWorker} = require('../../lib/fs-broker');
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.ch-perm-')));
    const mod = path.join(base, 'mod');
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(mod);
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'package.json'), '{"name": "m"}');
    fs.symlinkSync(path.join(elsewhere, 'package.json'), path.join(mod, 'package.json'));
    const fsb = await createForWorker({name: 'm', mode: 'audit', modulePath: mod, declared: [],
      options: {moduleDataPath: path.join(base, 'store'), modulePath: base}, report: () => {}});
    try {
      assert.strictEqual(fsb.namespace.roots.find((r) => r.name === 'app').host, mod);
      assert.strictEqual(fsb.moduleRoot, mod);
    } finally {
      await fsb.bridge.close();
    }
  });

  // The high review of #451: under enforce a module's /data or /tmp that
  // overlaps its own code refuses the spawn, and that is judged before
  // anything is made or emptied there, so the module's files survive.
  it('under enforce, a /tmp inside the module\'s own code refuses the spawn first: nothing there is emptied', async () => {
    const {createForWorker} = require('../../lib/fs-broker');
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-fsb10-own-')));
    const mod = path.join(base, 'mod');
    const tmpInside = path.join(mod, 'store', 'm', 'tmp');
    fs.mkdirSync(tmpInside, {recursive: true});
    fs.writeFileSync(path.join(mod, 'package.json'), '{"name": "m"}');
    fs.writeFileSync(path.join(tmpInside, 'keep.js'), 'module.exports = 1;');
    let code = null;
    try {
      const fsb = await createForWorker({name: 'm', mode: 'enforce', modulePath: mod, declared: [],
        options: {moduleDataPath: path.join(mod, 'store'), modulePath: base}, report: () => {}});
      await fsb.bridge.close();
    } catch (e) { code = e.code; }
    assert.strictEqual(code, 'MODULE_SANDBOX_REFUSED');
    assert.ok(fs.existsSync(path.join(tmpInside, 'keep.js')), 'the module\'s own file was emptied before the refusal');
  });

  // (under audit the same overlap is said, and the /tmp never emptied: it
  // holds the module's own files; the high review of #452)
  it('under audit, a /tmp inside the module\'s own code is said and never emptied', async () => {
    const {createForWorker} = require('../../lib/fs-broker');
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-fsb10-own-a-')));
    const mod = path.join(base, 'mod');
    const tmpInside = path.join(mod, 'store', 'm', 'tmp');
    fs.mkdirSync(tmpInside, {recursive: true});
    fs.writeFileSync(path.join(mod, 'package.json'), '{"name": "m"}');
    fs.writeFileSync(path.join(tmpInside, 'keep.js'), 'module.exports = 1;');
    const said = [];
    let emptied = false;
    const fsb = await createForWorker({name: 'm', mode: 'audit', modulePath: mod, declared: [],
      options: {moduleDataPath: path.join(mod, 'store'), modulePath: base}, report: (rule, target) => said.push([rule, target]),
      emptyTmp: async () => { emptied = true; }});
    await fsb.bridge.close();
    assert.ok(fs.existsSync(path.join(tmpInside, 'keep.js')), 'the module\'s own file was emptied');
    // (and a session's emptying, which would give its share back, is never
    // called: the files are still there, so the share stays counted)
    assert.strictEqual(emptied, false);
    assert.deepStrictEqual(said.filter(([rule]) => rule === 'overlap').map(([, t]) => t.replace(/ \(.*?\)/, '')).sort(),
      ['the module\'s /data and its own code overlap -- set --moduleDataPath apart from the module',
        'the module\'s /tmp and its own code overlap -- set --moduleDataPath apart from the module']);
  });

  // (another module's code: a /data or /tmp over any module root is the
  // same overlap; the high review of #452)
  it('under enforce, a /tmp inside another module\'s code refuses the spawn first: nothing there is emptied', async () => {
    const {createForWorker} = require('../../lib/fs-broker');
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-fsb10-other-')));
    const modules = path.join(base, 'modules');
    const mod = path.join(modules, 'm');
    const other = path.join(modules, 'other');
    const tmpInside = path.join(other, 'store', 'm', 'tmp');
    fs.mkdirSync(mod, {recursive: true});
    fs.mkdirSync(tmpInside, {recursive: true});
    fs.writeFileSync(path.join(mod, 'package.json'), '{"name": "m"}');
    fs.writeFileSync(path.join(other, 'package.json'), '{"name": "other"}');
    fs.writeFileSync(path.join(tmpInside, 'keep.js'), 'module.exports = 1;');
    let code = null;
    try {
      const fsb = await createForWorker({name: 'm', mode: 'enforce', modulePath: mod, declared: [],
        options: {moduleDataPath: path.join(other, 'store'), modulePath: modules}, knownRoots: [other], report: () => {}});
      await fsb.bridge.close();
    } catch (e) { code = e.code; }
    assert.strictEqual(code, 'MODULE_SANDBOX_REFUSED');
    assert.ok(fs.existsSync(path.join(tmpInside, 'keep.js')), 'the other module\'s file was emptied');
  });

  // (a --loadModule directory is another module's code whole; and a scoped
  // module in --modulePath, @scope/name, is code too)
  it('under enforce, a /data in another --loadModule directory, or in a scoped module in --modulePath, refuses the spawn', async () => {
    const {createForWorker} = require('../../lib/fs-broker');
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-fsb10-loaded-')));
    const mod = path.join(base, 'a');
    const loaded = path.join(base, 'b');
    const modules = path.join(base, 'modules');
    fs.mkdirSync(mod, {recursive: true});
    fs.mkdirSync(path.join(loaded, 'lib'), {recursive: true});
    fs.mkdirSync(path.join(modules, '@acme', 'b'), {recursive: true});
    fs.writeFileSync(path.join(mod, 'package.json'), '{"name": "m"}');
    fs.writeFileSync(path.join(loaded, 'package.json'), '{"name": "b"}');
    fs.writeFileSync(path.join(modules, '@acme', 'b', 'package.json'), '{"name": "@acme/b"}');
    const tryWith = async (moduleDataPath) => {
      try {
        const fsb = await createForWorker({name: 'm', mode: 'enforce', modulePath: mod, declared: [],
          options: {moduleDataPath, modulePath: modules, localModulePath: [mod, loaded]}, knownRoots: [path.join(modules, '@acme', 'b')], report: () => {}});
        await fsb.bridge.close();
        return null;
      } catch (e) { return e.code; }
    };
    assert.strictEqual(await tryWith(path.join(loaded, 'lib')), 'MODULE_SANDBOX_REFUSED');
    assert.strictEqual(await tryWith(path.join(modules, '@acme', 'b')), 'MODULE_SANDBOX_REFUSED');
  });

  // (a --moduleDataPath above the modules folder is no overlap; a link
  // under --moduleDataPath into another module's code, or above a root not
  // made yet into one, is: the review of 039d4888)
  it('under enforce, a --moduleDataPath holding the modules folder spawns; a link into another module, under or above it, refuses', async function() {
    if (process.platform === 'win32') return this.skip();
    const {createForWorker} = require('../../lib/fs-broker');
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-fsb10-links-')));
    const modules = path.join(base, 'modules');
    const mod = path.join(modules, 'm');
    const other = path.join(modules, 'other');
    fs.mkdirSync(mod, {recursive: true});
    fs.mkdirSync(path.join(other, 'state'), {recursive: true});
    fs.mkdirSync(path.join(other, 'sub'), {recursive: true});
    fs.writeFileSync(path.join(mod, 'package.json'), '{"name": "m"}');
    fs.writeFileSync(path.join(other, 'package.json'), '{"name": "other"}');
    const tryWith = async (moduleDataPath) => {
      try {
        const fsb = await createForWorker({name: 'm', mode: 'enforce', modulePath: mod, declared: [],
          options: {moduleDataPath, modulePath: modules}, knownRoots: [mod, other], report: () => {}});
        await fsb.bridge.close();
        return null;
      } catch (e) { return e.code; }
    };
    assert.strictEqual(await tryWith(base), null);
    fs.mkdirSync(path.join(base, 'data'));
    fs.symlinkSync(path.join(other, 'state'), path.join(base, 'data', 'm'));
    assert.strictEqual(await tryWith(path.join(base, 'data')), 'MODULE_SANDBOX_REFUSED');
    fs.symlinkSync(path.join(other, 'sub'), path.join(modules, 'link'));
    assert.strictEqual(await tryWith(path.join(modules, 'link', 'store')), 'MODULE_SANDBOX_REFUSED');
    assert.ok(!fs.existsSync(path.join(other, 'sub', 'store')), 'made inside the other module first');
  });

  // (a /data or /tmp that IS another module's root: by its place in the
  // folder, or through a link; the review of 2d84f98b)
  it('under enforce, a /tmp that is another module\'s root, by its place or through a link, refuses the spawn', async function() {
    if (process.platform === 'win32') return this.skip();
    const {createForWorker} = require('../../lib/fs-broker');
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-fsb10-slot-')));
    const modules = path.join(base, 'modules');
    const mod = path.join(base, 'own', 'modules');
    fs.mkdirSync(mod, {recursive: true});
    fs.mkdirSync(path.join(modules, 'tmp'), {recursive: true});
    fs.mkdirSync(path.join(modules, 'bar'), {recursive: true});
    fs.writeFileSync(path.join(mod, 'package.json'), '{"name": "modules"}');
    fs.writeFileSync(path.join(modules, 'tmp', 'package.json'), '{"name": "tmp"}');
    fs.writeFileSync(path.join(modules, 'tmp', 'keep.js'), '');
    fs.writeFileSync(path.join(modules, 'bar', 'package.json'), '{"name": "bar"}');
    const tryWith = async (name, modulePathOwn, moduleDataPath) => {
      try {
        const fsb = await createForWorker({name, mode: 'enforce', modulePath: modulePathOwn, declared: [],
          options: {moduleDataPath, modulePath: modules}, knownRoots: [path.join(modules, 'tmp'), path.join(modules, 'bar'), path.join(modules, '@acme', 'baz')], report: () => {}});
        await fsb.bridge.close();
        return null;
      } catch (e) { return e.code; }
    };
    // (--moduleDataPath the folder's parent, the module named as the folder:
    // its /tmp is the folder's module "tmp")
    assert.strictEqual(await tryWith('modules', mod, base), 'MODULE_SANDBOX_REFUSED');
    assert.ok(fs.existsSync(path.join(modules, 'tmp', 'keep.js')), 'the other module\'s file was emptied');
    // (an operator's link at /data into another module's root)
    const store = path.join(base, 'store');
    fs.mkdirSync(path.join(store, 'foo'), {recursive: true});
    fs.symlinkSync(path.join(modules, 'bar'), path.join(store, 'foo', 'data'));
    assert.strictEqual(await tryWith('foo', mod, store), 'MODULE_SANDBOX_REFUSED');
    // (and one at /data into a scope directory, which holds modules but no
    // package.json of its own)
    fs.mkdirSync(path.join(modules, '@acme', 'baz'), {recursive: true});
    fs.writeFileSync(path.join(modules, '@acme', 'baz', 'package.json'), '{"name": "@acme/baz"}');
    fs.mkdirSync(path.join(store, 'qux'), {recursive: true});
    fs.symlinkSync(path.join(modules, '@acme'), path.join(store, 'qux', 'data'));
    assert.strictEqual(await tryWith('qux', mod, store), 'MODULE_SANDBOX_REFUSED');
  });

  // (but a --moduleDataPath beside the modules in --modulePath is in no
  // module's code: it spawns)
  it('under enforce, a --moduleDataPath beside the modules in --modulePath spawns', async () => {
    const {createForWorker} = require('../../lib/fs-broker');
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-fsb10-beside-')));
    const mod = path.join(base, 'm');
    fs.mkdirSync(mod, {recursive: true});
    fs.writeFileSync(path.join(mod, 'package.json'), '{"name": "m"}');
    const fsb = await createForWorker({name: 'm', mode: 'enforce', modulePath: mod, declared: [],
      options: {moduleDataPath: path.join(base, 'data'), modulePath: base}, report: () => {}});
    await fsb.bridge.close();
    assert.ok(fs.existsSync(path.join(base, 'data', 'm')));
    // (and a package.json the module itself writes in its /data or /tmp
    // decides nothing: it spawns again)
    fs.writeFileSync(path.join(base, 'data', 'm', 'data', 'package.json'), '{"name": "mine"}');
    fs.writeFileSync(path.join(base, 'data', 'm', 'tmp', 'package.json'), '{"name": "mine"}');
    const again = await createForWorker({name: 'm', mode: 'enforce', modulePath: mod, declared: [],
      options: {moduleDataPath: path.join(base, 'data'), modulePath: base}, report: () => {}});
    await again.bridge.close();
  });

  // (the other way round, at every spawn: a module loaded from inside a
  // known module's data is refused under enforce, said under audit; the
  // high review of #452, 1)
  it('a module whose own code is inside a known module\'s data: refused under enforce, said under audit', async () => {
    const {createForWorker} = require('../../lib/fs-broker');
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-fsb10-hosted-')));
    const store = path.join(base, 'store');
    const a = path.join(base, 'a');
    fs.mkdirSync(a, {recursive: true});
    fs.writeFileSync(path.join(a, 'package.json'), '{"name": "a"}');
    const fsa = await createForWorker({name: 'a', mode: 'enforce', modulePath: a, declared: [], options: {moduleDataPath: store, modulePath: base}, report: () => {}});
    await fsa.bridge.close();
    const b = path.join(store, 'a', 'data', 'b');
    fs.mkdirSync(b, {recursive: true});
    fs.writeFileSync(path.join(b, 'package.json'), '{"name": "b"}');
    const tryWith = async (mode, said) => {
      try {
        const fsb = await createForWorker({name: 'b', mode, modulePath: b, declared: [], options: {moduleDataPath: store, modulePath: base},
          knownModules: [{name: 'a', root: a}, {name: 'b', root: b}], report: (rule, target) => said.push([rule, target])});
        await fsb.bridge.close();
        return null;
      } catch (e) { return e.code; }
    };
    assert.strictEqual(await tryWith('enforce', []), 'MODULE_SANDBOX_REFUSED');
    const said = [];
    assert.strictEqual(await tryWith('audit', said), null);
    assert.ok(said.some(([rule, t]) => rule === 'overlap' && /a's data overlap/.test(t)), JSON.stringify(said));
  });

  // (a --moduleDataPath not made yet, reached through a link above it into
  // the module's own code: refused before anything is made there)
  it('under enforce, a --moduleDataPath through a link into the module\'s own code refuses before anything is made', async function() {
    if (process.platform === 'win32') return this.skip();
    const {createForWorker} = require('../../lib/fs-broker');
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-fsb10-link-')));
    const mod = path.join(base, 'mod');
    fs.mkdirSync(mod, {recursive: true});
    fs.writeFileSync(path.join(mod, 'package.json'), '{"name": "m"}');
    fs.symlinkSync(mod, path.join(base, 'link'));
    let code = null;
    try {
      const fsb = await createForWorker({name: 'm', mode: 'enforce', modulePath: mod, declared: [],
        options: {moduleDataPath: path.join(base, 'link', 'store'), modulePath: base}, report: () => {}});
      await fsb.bridge.close();
    } catch (e) { code = e.code; }
    assert.strictEqual(code, 'MODULE_SANDBOX_REFUSED');
    assert.ok(!fs.existsSync(path.join(mod, 'store')), 'directories were made inside the module\'s own code before the refusal');
  });

  // (and a data directory it can't resolve -- a read denied on the way --
  // refuses, never is compared unresolved)
  it('under enforce, a data directory that can\'t be resolved refuses the spawn', async function() {
    if (process.platform === 'win32' || process.getuid() === 0) return this.skip();
    const {createForWorker} = require('../../lib/fs-broker');
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-fsb10-unres-')));
    const mod = path.join(base, 'mod');
    const store = path.join(base, 'store');
    fs.mkdirSync(mod, {recursive: true});
    fs.mkdirSync(path.join(store, 'm'), {recursive: true});
    fs.writeFileSync(path.join(mod, 'package.json'), '{"name": "m"}');
    fs.chmodSync(store, 0o000);
    let err = null;
    try {
      const fsb = await createForWorker({name: 'm', mode: 'enforce', modulePath: mod, declared: [],
        options: {moduleDataPath: store, modulePath: base}, report: () => {}});
      await fsb.bridge.close();
    } catch (e) { err = e; } finally { fs.chmodSync(store, 0o700); }
    assert.strictEqual(err && err.code, 'MODULE_SANDBOX_REFUSED', String(err && err.message));
    assert.match(err.message, /cannot resolve the module's data directory/);
  });
});
