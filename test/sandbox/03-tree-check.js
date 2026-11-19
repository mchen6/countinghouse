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
    assert.deepStrictEqual(checkTree(d), {problems: [], warnings: [], dirLinks: [], brokenLinks: [], manifestLinks: [], outsideMains: []});
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
    assert.match(r.warnings[0], /node_modules[\\/]s.*postinstall/);
  });

  it('reports a directory symlink that leaves the module', () => {
    const d = mk({'package.json': {name: 'm'}});
    const outside = mk({'x.node': 'bin'});
    fs.symlinkSync(outside, path.join(d, 'vendor'));
    assert.match(checkTree(d).problems.join('\n'), /vendor is a symlink to .*, outside the module/);
  });

  it('reports a file symlink that leaves the module', () => {
    const d = mk({'package.json': {name: 'm'}, 'lib/keep': ''});
    const outside = mk({'x.node': 'bin'});
    fs.symlinkSync(path.join(outside, 'x.node'), path.join(d, 'lib', 'x.node'));
    assert.match(checkTree(d).problems.join('\n'), /lib[\\/]x\.node is a symlink to .*, outside the module/);
  });

  it('accepts a symlink that stays inside the module, and lists one to a directory or a dangling one', () => {
    const d = mk({'package.json': {name: 'm'}, 'lib/a.js': ''});
    fs.symlinkSync('./lib', path.join(d, 'alias'), 'junction');
    fs.symlinkSync('./nowhere', path.join(d, 'dangling'));
    // (inside: no problem of its own; a link to a directory is listed, for
    // the refusal under enforce below)
    assert.deepStrictEqual(checkTree(d), {problems: [], warnings: [], dirLinks: ['alias'], brokenLinks: ['dangling'], manifestLinks: [], outsideMains: []});
  });

  // The _stat PR (the reviewer's ruling): Node's ES resolver reads a
  // package's "main" against a link's own path, past every check, so under
  // --moduleSandbox enforce a module root holds no directory link at all:
  // refused at load, said under audit. A file link (node_modules/.bin's) is
  // no such base and is unaffected.
  describe('a directory link inside the root, under enforce', () => {
    const sandboxConfig = require('../../lib/module-sandbox-config');
    const refusalOf = (d, mode) => sandboxConfig.build(d, 'm', {mode, modulePolicy: null, serverEnv: {}}).refusal;
    const linkTo = (target, link) => fs.symlinkSync(process.platform === 'win32' ? path.resolve(path.dirname(link), target) : target, link, 'junction');
    it('a package linked shallower than its target (node_modules/foo -> ../packages/grp/foo): refused', () => {
      const d = mk({'package.json': {name: 'm'}, 'packages/grp/foo/package.json': {name: 'foo', main: '../../../x'}, 'packages/grp/foo/index.js': ''});
      fs.mkdirSync(path.join(d, 'node_modules'));
      linkTo('../packages/grp/foo', path.join(d, 'node_modules', 'foo'));
      assert.match(String(refusalOf(d, 'enforce')), /m holds a directory link at node_modules[\\/]foo; links aren't allowed under --moduleSandbox enforce/);
    });
    it('a link to the root itself (node_modules/self -> ..): refused', () => {
      const d = mk({'package.json': {name: 'm', main: '../../secret'}, 'index.js': ''});
      fs.mkdirSync(path.join(d, 'node_modules'));
      linkTo('..', path.join(d, 'node_modules', 'self'));
      assert.match(String(refusalOf(d, 'enforce')), /m holds a directory link at node_modules[\\/]self; links aren't allowed under --moduleSandbox enforce/);
    });
    it('a link whose target can\'t be resolved (dangling): refused, as it could become a directory link', () => {
      const d = mk({'package.json': {name: 'm'}});
      fs.symlinkSync('./nowhere', path.join(d, 'later'));
      assert.match(String(refusalOf(d, 'enforce')), /m holds a link at later that doesn't resolve, which could become a directory link; not allowed under --moduleSandbox enforce/);
    });
    it('a package.json that is a link, to a file inside the root: refused (Node reads its "main" against the link\'s directory)', function() {
      if (process.platform === 'win32') return this.skip();
      const d = mk({'package.json': {name: 'm'}, 'cfg/foo.json': {main: '../../../x'}, 'node_modules/foo/index.js': ''});
      fs.symlinkSync('../../cfg/foo.json', path.join(d, 'node_modules', 'foo', 'package.json'));
      assert.match(String(refusalOf(d, 'enforce')), /m holds a linked package\.json at node_modules[\\/]foo[\\/]package\.json; not allowed under --moduleSandbox enforce/);
    });
    it('a file link (node_modules/.bin): unaffected', function() {
      if (process.platform === 'win32') return this.skip();
      const d = mk({'package.json': {name: 'm'}, 'node_modules/tool/cli.js': ''});
      fs.mkdirSync(path.join(d, 'node_modules', '.bin'));
      fs.symlinkSync('../tool/cli.js', path.join(d, 'node_modules', '.bin', 'tool'));
      assert.strictEqual(refusalOf(d, 'enforce'), null);
      assert.deepStrictEqual(checkTree(d).dirLinks, []);
    });
  });

  // The _stat PR (the reviewer's ruling): Node's ES resolver picks a
  // package's "main" in native code and falls back to its index where it
  // names nothing, so a "main" leading outside the root would say whether a
  // host file exists. The root is read-only under enforce, so the tree is
  // judged at load: every package.json in it, the root's own, a nested
  // one, one in node_modules (a bare name's, or a '#' import's target).
  describe('a package.json "main" leading outside the root, under enforce', () => {
    const sandboxConfig = require('../../lib/module-sandbox-config');
    const refusalOf = (d) => sandboxConfig.build(d, 'm', {mode: 'enforce', modulePolicy: null, serverEnv: {}}).refusal;
    const refused = (d, rel) => assert.match(String(refusalOf(d)), new RegExp(`m: ${rel.replace(/[/]/g, '[\\\\/]').replace(/[.]/g, '\\.')}'s "main" leads outside the module; not allowed under --moduleSandbox enforce`));
    it('the root\'s own', () => refused(mk({'package.json': {name: 'm', main: '../outside.js'}}), 'package.json'));
    it('passes one that names the root by "." or ".." (Node tries ./<main>.js inside it); refuses one that names it by its name (<name>.js beside it)', () => {
      assert.strictEqual(refusalOf(mk({'package.json': {name: 'm', main: '.'}, 'index.js': ''})), null);
      assert.strictEqual(refusalOf(mk({'package.json': {name: 'm'}, 'lib/x/package.json': {main: '../..'}})), null);
      assert.strictEqual(refusalOf(mk({'package.json': {name: 'm'}, 'lib/x/package.json': {main: '../../'}})), null);
      const d = mk({'package.json': {name: 'm'}});
      fs.mkdirSync(path.join(d, 'lib', 'x'), {recursive: true});
      fs.writeFileSync(path.join(d, 'lib', 'x', 'package.json'), JSON.stringify({main: `../../../${path.basename(fs.realpathSync(d))}`}));
      refused(d, 'lib/x/package.json');
    });
    it('a nested package\'s', () => refused(mk({'package.json': {name: 'm'}, 'lib/x/package.json': {main: '../../../outside.js'}}), 'lib/x/package.json'));
    it('a node_modules package\'s (a bare name, or the target of an "imports" mapping)', () => {
      refused(mk({'package.json': {name: 'm', imports: {'#x': 'p'}}, 'node_modules/p/package.json': {name: 'p', main: '../../../outside.js'}}), 'node_modules/p/package.json');
    });
    it('a duplicate "main" (any written counts), one spelt with backslashes, and one with escapes', () => {
      const dup = mk({'package.json': {name: 'm'}});
      fs.mkdirSync(path.join(dup, 'lib', 'x'), {recursive: true});
      fs.writeFileSync(path.join(dup, 'lib', 'x', 'package.json'), '{"main": "../../../outside.js", "main": "./index.js"}');
      refused(dup, 'lib/x/package.json');
      refused(mk({'package.json': {name: 'm'}, 'lib/x/package.json': {main: '..\\..\\..\\outside.js'}}), 'lib/x/package.json');
      refused(mk({'package.json': {name: 'm'}, 'lib/x/package.json': {main: '%2e%2e/%2e%2e/%2e%2e/outside.js'}}), 'lib/x/package.json');
    });
    it('an absolute "main", and one with a \'#\' before climbing segments (Node\'s ES resolver resolves a "main" as a path too)', () => {
      refused(mk({'package.json': {name: 'm'}, 'node_modules/a/package.json': {name: 'a', main: '/any/host/path.js'}}), 'node_modules/a/package.json');
      refused(mk({'package.json': {name: 'm'}, 'node_modules/b/package.json': {name: 'b', main: 'x#/../../../../outside/t.js'}}), 'node_modules/b/package.json');
      refused(mk({'package.json': {name: 'm'}, 'node_modules/c/package.json': {name: 'c', main: 'x?/../../../../outside/t.js'}}), 'node_modules/c/package.json');
    });
    it('a PACKAGE.JSON in another case, or with a long s, which a file system folding case opens as package.json', () => {
      refused(mk({'package.json': {name: 'm'}, 'node_modules/p/PACKAGE.JSON': {name: 'p', main: '../../../outside.js'}}), 'node_modules/p/PACKAGE.JSON');
      refused(mk({'package.json': {name: 'm'}, 'node_modules/q/package.j\u017Fon': {name: 'q', main: '../../../outside.js'}}), 'node_modules/q/package.j\u017Fon');
      refused(mk({'package.json': {name: 'm'}, 'node_modules/r/pack\u200Dage.json': {name: 'r', main: '../../../outside.js'}}), 'node_modules/r/pack\u200Dage.json');
    });
    it('passes a "main" inside, and a nested key that is no package\'s "main"', () => {
      const d = mk({'package.json': {name: 'm', main: './lib/index.js'}, 'lib/index.js': '', 'lib/y/package.json': {main: './index.js', config: {main: '../../../outside.js'}}});
      assert.strictEqual(refusalOf(d), null);
      assert.deepStrictEqual(checkTree(d).outsideMains, []);
    });
  });

  it('reports a directory it cannot read', function() {
    if (process.getuid && process.getuid() === 0) return this.skip();
    const d = mk({'package.json': {name: 'm'}, 'locked/f': ''});
    const locked = path.join(d, 'locked');
    // a mode does not stop a read on Windows: a rule denying Everyone does
    const WIN = process.platform === 'win32';
    const icacls = (...a) => require('child_process').execFileSync('icacls', [locked, ...a], {stdio: 'ignore'});
    if (WIN) icacls('/deny', '*S-1-1-0:(RX)'); else fs.chmodSync(locked, 0);
    try {
      // premise: this process cannot read it now (an elevated Windows runner
      // reads through a deny rule, with its backup privilege)
      let readable = true;
      try { fs.readdirSync(locked); } catch (e) { readable = false; }
      if (readable) return this.skip();
      assert.match(checkTree(d).problems.join('\n'), WIN ? /cannot read locked: E(ACCES|PERM)/ : /cannot read locked: EACCES/);
    } finally {
      if (WIN) icacls('/remove:d', '*S-1-1-0'); else fs.chmodSync(locked, 0o755);
    }
  });

  it('reports a dependency whose package.json cannot be parsed', () => {
    const d = mk({
      'package.json': {name: 'm', dependencies: {bad: '1'}},
      'node_modules/bad/package.json': '{not json'
    });
    const r = checkTree(d);
    assert.strictEqual(r.problems.length, 1, r.problems.join('\n'));
    assert.match(r.problems[0], /node_modules[\\/]bad[\\/]package\.json cannot be parsed/);
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
