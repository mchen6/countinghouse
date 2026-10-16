// Self-contained, native-code and install-script checks over a module's
// directory, and the validator reporting them. Each case builds its own tree
// in a temp directory.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {checkTree} = require('../../lib/module-tree-check');
const validator   = require('../../lib/module-validator');

const ROOT = path.join(__dirname, '..', '..');

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-tree-'));
  Object.keys(files).forEach((rel) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, typeof(files[rel]) === 'string' ? files[rel] : JSON.stringify(files[rel]));
  });
  return dir;
}

describe('sandbox 03: tree checks', () => {
  const made = [];
  const mk = (files) => { const d = tree(files); made.push(d); return d; };
  after(() => made.forEach((d) => fs.rmSync(d, {recursive: true, force: true})));

  it('passes a module whose dependencies are all inside it, nested or hoisted', () => {
    const d = mk({
      'package.json': {name: 'm', dependencies: {a: '1', b: '1'}},
      'node_modules/a/package.json': {name: 'a', dependencies: {c: '1'}},
      'node_modules/a/node_modules/c/package.json': {name: 'c'},
      'node_modules/b/package.json': {name: 'b', dependencies: {a: '1'}}
    });
    assert.deepStrictEqual(checkTree(d), {problems: [], warnings: []});
  });

  it('reports a dependency that is not installed inside the module', () => {
    const d = mk({'package.json': {name: 'm', dependencies: {lodash: '4'}}});
    const r = checkTree(d);
    assert.strictEqual(r.problems.length, 1);
    assert.match(r.problems[0], /"lodash".*not installed inside the module/);
  });

  it('reports a dependency symlinked to outside the module', () => {
    const d = mk({'package.json': {name: 'm', dependencies: {ext: '1'}}});
    const outside = mk({'package.json': {name: 'ext'}});
    fs.mkdirSync(path.join(d, 'node_modules'));
    fs.symlinkSync(outside, path.join(d, 'node_modules', 'ext'));
    assert.match(checkTree(d).problems.join('\n'), /"ext".*outside the module/);
  });

  it('reports native code: .node files, binding.gyp, gypfile', () => {
    const d = mk({
      'package.json': {name: 'm', dependencies: {n: '1', g: '1'}},
      'build/Release/x.node': 'bin',
      'node_modules/n/package.json': {name: 'n'},
      'node_modules/n/binding.gyp': '{}',
      'node_modules/g/package.json': {name: 'g', gypfile: true}
    });
    assert.strictEqual(checkTree(d).problems.length, 3, checkTree(d).problems.join('\n'));
  });

  it('warns about install scripts without failing', () => {
    const d = mk({
      'package.json': {name: 'm', dependencies: {s: '1'}},
      'node_modules/s/package.json': {name: 's', scripts: {postinstall: 'node x.js'}}
    });
    const r = checkTree(d);
    assert.deepStrictEqual(r.problems, []);
    assert.match(r.warnings[0], /node_modules\/s.*postinstall/);
  });
});

describe('sandbox 03: the validator reports them', () => {
  it('adds permission, tree and warning results to an otherwise valid module', (done) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-tree-'));
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'handler-map-convention'), d, {recursive: true});
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
      name: 'handler-map-convention', version: '1.0.0', dependencies: {missing: '1'},
      countinghouse: {permissions: {env: ['bad-name']}}
    }));
    validator.validateModule(d, (err, result) => {
      fs.rmSync(d, {recursive: true, force: true});
      assert.ifError(err);
      const stages = result.problems.map((p) => p.stage).sort();
      assert.deepStrictEqual(stages, ['checkTree', 'countinghouse.permissions']);
      assert.ok(Array.isArray(result.warnings));
      assert.strictEqual(result.ok, false);
      done();
    });
  });

  it('keeps ok true and warnings empty for a clean module', (done) => {
    validator.validateModule(path.join(ROOT, 'test', 'fixtures', 'handler-map-convention'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, true, JSON.stringify(result.problems));
      assert.deepStrictEqual(result.warnings, []);
      done();
    });
  });
});
