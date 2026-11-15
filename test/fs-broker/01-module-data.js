const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const md = require('../../lib/module-data');

// Windows has no mode bits (every directory reports 0666 there; its ACLs are
// another matter): the mode cases check the directories exist, nothing more.
const WIN = process.platform === 'win32';
const modeIs = (p, mode, msg) => (WIN ? assert.ok(fs.statSync(p).isDirectory(), p) : assert.strictEqual(fs.statSync(p).mode & 0o777, mode, msg));

describe('fs-broker 01: module data directories', () => {
  it('accepts npm-style names, scoped or not', () => {
    ['weather', 'sandbox-probe', '@acme/x', 'a.b_c~d', 'Legacy-Name'].forEach((n) => assert.strictEqual(md.safeName(n), true, n));
  });

  it('refuses names that could leave the data directory or collide', () => {
    ['', '.', '..', '../x', 'a/b', '@acme', '@/x', '@acme/../x', '@acme/.x', '.hidden', 'a\\b', 'a\0b', '@a/@b', 'x'.repeat(215)]
      .forEach((n) => assert.strictEqual(md.safeName(n), false, JSON.stringify(n)));
  });

  it('lays scoped names out as node_modules does', () => {
    const d = md.dirsFor('/srv/data', '@acme/x');
    // the host's form of the path (D:\srv\data\... on Windows)
    const at = (...p) => path.join(path.resolve('/srv/data'), ...p);
    assert.deepStrictEqual(d, {root: at('@acme', 'x'), data: at('@acme', 'x', 'data'), tmp: at('@acme', 'x', 'tmp')});
    assert.strictEqual(md.dirsFor('/srv/data', 'x').root, at('x'));
  });

  it('leaves an existing --moduleDataPath\'s mode alone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-md-'));
    try {
      const store = path.join(root, 'store');
      fs.mkdirSync(store);
      fs.chmodSync(store, 0o750);
      const d = await md.ensureDirs(store, 'x');
      modeIs(store, 0o750);
      modeIs(d.root, 0o700);
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });

  it('creates the directories with mode 0700', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-md-'));
    try {
      const d = await md.ensureDirs(path.join(root, 'store'), '@acme/x');
      for (const p of [path.join(root, 'store'), path.join(root, 'store', '@acme'), d.root, d.data, d.tmp]) {
        modeIs(p, 0o700, p);
      }
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });

  it('--hardened grants read and write on --moduleDataPath', () => {
    const {permissionFlags} = require('../../lib/hardened-launch');
    const flags = permissionFlags({modulePath: '/m', moduleDataPath: '/d', debug: true, localModulePath: '/m/x'}, '/install', '/');
    assert.ok(flags.includes(`--allow-fs-read=${path.resolve('/d')}`), flags.join(' '));
    assert.ok(flags.includes(`--allow-fs-write=${path.resolve('/d')}`), flags.join(' '));
  });

  // Node grants a subtree only for a directory that exists when it starts, so
  // --hardened creates --moduleDataPath before relaunching under --permission;
  // and the module folder, so the grant probe sees it as the child will (H1).
  it('--hardened creates a missing --moduleDataPath (0700) and module folder before the relaunch, and leaves an existing one alone', () => {
    const {prepareGrants} = require('../../lib/hardened-launch');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-md-'));
    try {
      const missing = path.join(root, 'a', 'store');
      const modules = path.join(root, 'm', 'modules');
      prepareGrants({modulePath: modules, moduleDataPath: missing}, '/');
      modeIs(missing, 0o700);
      assert.ok(fs.statSync(modules).isDirectory(), 'the module folder is created too');
      const existing = path.join(root, 'existing');
      fs.mkdirSync(existing);
      fs.chmodSync(existing, 0o750);
      prepareGrants({modulePath: modules, moduleDataPath: existing}, '/');
      modeIs(existing, 0o750);
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });

  // The default since 8.0.0 (user decision, 2026-11-04): a name that does not
  // extend a likely install directory ($HOME/countinghouse), which Node's
  // permission model mishandles under --hardened (nodejs/node#66812).
  it('defaults to $HOME/.countinghouse/module_data', () => {
    const options = Object.create(require('../../lib/cli-options'));
    options.setOptions({});
    assert.strictEqual(options.moduleDataPath, path.join(os.homedir(), '.countinghouse', 'module_data'));
  });

  it('a fresh home gets .countinghouse and module_data both 0700; an existing .countinghouse keeps its mode', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-home-'));
    try {
      const store = path.join(home, '.countinghouse', 'module_data');
      await md.ensureDirs(store, 'm');
      [path.join(home, '.countinghouse'), store].forEach((d) => modeIs(d, 0o700, d));
      const home2 = path.join(home, 'second');
      fs.mkdirSync(path.join(home2, '.countinghouse'), {recursive: true});
      fs.chmodSync(path.join(home2, '.countinghouse'), 0o750);
      await md.ensureDirs(path.join(home2, '.countinghouse', 'module_data'), 'm');
      modeIs(path.join(home2, '.countinghouse'), 0o750);
      modeIs(path.join(home2, '.countinghouse', 'module_data'), 0o700);
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  });

  it('throws for an unsafe name', () => {
    assert.throws(() => md.dirsFor('/srv/data', '../etc'), /cannot be used as a data directory name/);
  });
});
