// FB3: Node's JS fs.realpathSync resolves x -> "." / y -> "x/.." to the
// directory itself; the kernel, fs.realpathSync.native and fs.promises
// resolve y to its PARENT. Every realpath whose answer feeds a sandbox
// decision now uses the native form, so the decision is about what the
// kernel will open: the module tree check, the module root, the --hardened
// fallback, and the worker's fs.realpathSync under the loader's grant.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {checkTree} = require('../../lib/module-tree-check');
const sandboxConfig = require('../../lib/module-sandbox-config');
const hardenedRealpaths = require('../../lib/hardened-realpaths');
const {runBrokered} = require('../helpers/brokered-worker');
const {mkdtemp} = require('../helpers/test-tmp');

// <base>/m is a module whose tree holds x -> "." and y -> "x/..": y really
// leads to <base>, outside the module.
function layout() {
  const base = fs.realpathSync.native(mkdtemp('fb3-'));
  const m = path.join(base, 'm');
  fs.mkdirSync(m);
  fs.writeFileSync(path.join(m, 'package.json'), JSON.stringify({name: 'm'}));
  fs.writeFileSync(path.join(base, 'outside.js'), 'module.exports = "outside";');
  fs.symlinkSync('.', path.join(m, 'x'));
  fs.symlinkSync('x/..', path.join(m, 'y'));
  return {base, m};
}

describe('fs-broker 22: decisions use the native realpath (FB3)', function() {
  this.timeout(60000);
  const made = [];
  after(() => made.forEach((d) => fs.rmSync(d, {recursive: true, force: true})));
  const mk = () => { const l = layout(); made.push(l.base); return l; };

  it('premise: JS realpathSync and the kernel disagree on y', () => {
    const {base, m} = mk();
    assert.strictEqual(fs.realpathSync(path.join(m, 'y')), m);
    assert.strictEqual(fs.realpathSync.native(path.join(m, 'y')), base);
  });

  it('the tree check reports y as a symlink outside the module', () => {
    const {base, m} = mk();
    const r = checkTree(m);
    assert.ok(r.problems.includes(`y is a symlink to ${base}, outside the module`), JSON.stringify(r));
  });

  it('the tree check reports a dependency reached through y as outside the module, instead of throwing', () => {
    const {base, m} = mk();
    fs.writeFileSync(path.join(m, 'package.json'), JSON.stringify({name: 'm', dependencies: {a: '1'}}));
    fs.mkdirSync(path.join(base, 'a'));
    fs.writeFileSync(path.join(base, 'a', 'package.json'), JSON.stringify({name: 'a'}));
    fs.mkdirSync(path.join(m, 'node_modules'));
    fs.symlinkSync('../y/a', path.join(m, 'node_modules', 'a'));
    const r = checkTree(m);
    assert.ok(r.problems.includes(`dependency "a" (needed by the module) resolves outside the module, to ${path.join(base, 'a')}`),
      JSON.stringify(r));
  });

  it('the module root is the one the kernel gives', () => {
    const {base, m} = mk();
    const built = sandboxConfig.build(path.join(m, 'y'), 'm', {mode: 'enforce', modulePolicy: null, serverEnv: {}});
    assert.strictEqual(built.lockdown.moduleRoot, base);
  });

  it('the --hardened fallback for a path the parent did not resolve is the native one', () => {
    const {base, m} = mk();
    assert.strictEqual(hardenedRealpaths.has(path.join(m, 'y')), false);
    assert.strictEqual(hardenedRealpaths.realpathSync(path.join(m, 'y')), base);
  });

  it('in a module worker, fs.realpathSync under the loader\'s resolve grant answers what the kernel opens', async () => {
    const {base, m} = mk();
    const r = await runBrokered(path.join(__dirname, 'scripts', 'native-realpath.js'), {mode: 'enforce', extra: {dir: m}});
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.r, {realpathSync: base, realpathSyncNative: base});
  });
});
