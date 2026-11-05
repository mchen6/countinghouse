const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const md = require('../../lib/module-data');

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
    assert.deepStrictEqual(d, {root: '/srv/data/@acme/x', data: '/srv/data/@acme/x/data', tmp: '/srv/data/@acme/x/tmp'});
    assert.strictEqual(md.dirsFor('/srv/data', 'x').root, '/srv/data/x');
  });

  it('leaves an existing --moduleDataPath\'s mode alone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-md-'));
    try {
      const store = path.join(root, 'store');
      fs.mkdirSync(store);
      fs.chmodSync(store, 0o750);
      const d = await md.ensureDirs(store, 'x');
      assert.strictEqual(fs.statSync(store).mode & 0o777, 0o750);
      assert.strictEqual(fs.statSync(d.root).mode & 0o777, 0o700);
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });

  it('creates the directories with mode 0700', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-md-'));
    try {
      const d = await md.ensureDirs(path.join(root, 'store'), '@acme/x');
      for (const p of [path.join(root, 'store'), path.join(root, 'store', '@acme'), d.root, d.data, d.tmp]) {
        assert.strictEqual(fs.statSync(p).mode & 0o777, 0o700, p);
      }
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });

  it('--hardened grants read and write on --moduleDataPath', () => {
    const {permissionFlags} = require('../../lib/hardened-launch');
    const flags = permissionFlags({modulePath: '/m', moduleDataPath: '/d', debug: true, localModulePath: '/m/x'}, '/install', '/');
    assert.ok(flags.includes('--allow-fs-read=/d'), flags.join(' '));
    assert.ok(flags.includes('--allow-fs-write=/d'), flags.join(' '));
  });

  // Node grants a subtree only for a directory that exists when it starts, so
  // --hardened creates --moduleDataPath before relaunching under --permission.
  it('--hardened creates a missing --moduleDataPath (0700) before the relaunch, and leaves an existing one alone', () => {
    const {prepareGrants} = require('../../lib/hardened-launch');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-md-'));
    try {
      const missing = path.join(root, 'a', 'store');
      prepareGrants({moduleDataPath: missing}, '/');
      assert.strictEqual(fs.statSync(missing).mode & 0o777, 0o700);
      const existing = path.join(root, 'existing');
      fs.mkdirSync(existing);
      fs.chmodSync(existing, 0o750);
      prepareGrants({moduleDataPath: existing}, '/');
      assert.strictEqual(fs.statSync(existing).mode & 0o777, 0o750);
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
      [path.join(home, '.countinghouse'), store].forEach((d) => assert.strictEqual(fs.statSync(d).mode & 0o777, 0o700, d));
      const home2 = path.join(home, 'second');
      fs.mkdirSync(path.join(home2, '.countinghouse'), {recursive: true});
      fs.chmodSync(path.join(home2, '.countinghouse'), 0o750);
      await md.ensureDirs(path.join(home2, '.countinghouse', 'module_data'), 'm');
      assert.strictEqual(fs.statSync(path.join(home2, '.countinghouse')).mode & 0o777, 0o750);
      assert.strictEqual(fs.statSync(path.join(home2, '.countinghouse', 'module_data')).mode & 0o777, 0o700);
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  });

  it('throws for an unsafe name', () => {
    assert.throws(() => md.dirsFor('/srv/data', '../etc'), /cannot be used as a data directory name/);
  });
});
