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
    fs.writeFileSync(file, (typeof(files[rel]) === 'string' || Buffer.isBuffer(files[rel])) ? files[rel] : JSON.stringify(files[rel]));
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
    assert.deepStrictEqual(checkTree(d), {problems: [], warnings: [], dirLinks: [], brokenLinks: [], manifestLinks: [], outsideMains: [], duplicateKeys: [], escapedKeys: [], notUtf8: []});
  });

  it('a dependency whose package.json is a directory has none, as for Node (the high review of #452)', () => {
    const d = mk({'package.json': {name: 'm', dependencies: {x: '1'}}, 'node_modules/x/index.js': '', 'node_modules/x/package.json/keep.txt': ''});
    assert.deepStrictEqual(checkTree(d).problems.filter((p) => /package\.json/.test(p)), []);
  });

  it('reads a package.json past a BOM, as Node does: its dependencies checked too', () => {
    const d = mk({'package.json': {name: 'm', dependencies: {x: '1'}}, 'node_modules/x/index.js': '',
      'node_modules/x/package.json': '\uFEFF{"name": "x", "dependencies": {"y": "1"}}'});
    assert.match(checkTree(d).problems.join('\n'), /dependency "y" \(needed by .*x.*\) is not installed inside the module/);
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

  // (the high review of #465, round 3: a package.json writing one of
  // Node's resolution keys twice is reported -- refused under enforce --
  // since JSON.parse keeps the last copy and Node's reader may keep another)
  it('reports a package.json that writes "imports", "exports", "name", "main" or "type" twice', () => {
    const d = mk({'package.json': '{"name":"m","version":"1.0.0"}',
      'lib/p/package.json': '{"name":"p","imports":{"#b":"./b.js"},"imports":null}',
      'lib/q/package.json': '{"name":"q","exports":"./a.js","type":"module","exports":"./b.js","type":"commonjs"}',
      'lib/r/package.json': '{"name":"r","nested":{"imports":1,"imports":2}}'});
    assert.deepStrictEqual(checkTree(d).duplicateKeys.sort(), ['lib/p/package.json\'s "imports"', 'lib/q/package.json\'s "exports"', 'lib/q/package.json\'s "type"'].sort());
  });

  // (and one written with an escape: JSON.parse decodes it, Node's reader
  // matches the key as written -- the medium review of 9685cb1f)
  it('reports a package.json that writes one of those keys with an escape', () => {
    const d = mk({'package.json': '{"name":"m","version":"1.0.0"}',
      'lib/p/package.json': '{"name":"p","\\u0069mports":{"#a":"./a.js"}}',
      'lib/q/package.json': '{"name":"q","\\u0074ype":"module"}'});
    const t = checkTree(d);
    assert.deepStrictEqual(t.escapedKeys.sort(), ['lib/p/package.json\'s "imports"', 'lib/q/package.json\'s "type"'].sort());
    assert.deepStrictEqual(t.duplicateKeys, []);
  });

  // (ruled K2 after #465's round 3: what JSON.parse and Node's reader could
  // read differently is refused at load -- a backslash escape in the string
  // value of "name", "main" or "type" (a lone surrogate, say), and bytes
  // that aren't UTF-8, which a 'utf8' read turns into U+FFFD where Node's
  // reader throws ERR_INVALID_PACKAGE_CONFIG)
  it('reports an escape in the value of "name", "main" or "type", and a package.json that is not UTF-8', () => {
    const d = mk({'package.json': '{"name":"m","version":"1.0.0"}',
      'lib/p/package.json': '{"name":"p","main":"./\\ud800.js"}',
      'lib/q/package.json': '{"name":"q\\u0071","type":"module","exports":{"\\u002e":"./a.js"}}',
      'lib/r/package.json': Buffer.from('{"name":"r","x\xff":1,"exports":"./e.js"}', 'latin1'),
      'lib/s/package.json': '\ufeff{"name":"s","main":"./\u00e9.js"}',
      'lib/t/package.json': '{"name":"t","type":"modul\\u0065"}'});
    const t = checkTree(d);
    assert.deepStrictEqual(t.escapedKeys.sort(), ['lib/p/package.json\'s "main" value', 'lib/q/package.json\'s "name" value', 'lib/t/package.json\'s "type" value'].sort());
    assert.deepStrictEqual(t.notUtf8, ['lib/r/package.json']);
    assert.deepStrictEqual(t.duplicateKeys, []);
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
    assert.deepStrictEqual(checkTree(d), {problems: [], warnings: [], dirLinks: ['alias'], brokenLinks: ['dangling'], manifestLinks: [], outsideMains: [], duplicateKeys: [], escapedKeys: [], notUtf8: []});
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
    it('a package.json linked to one that can\'t be parsed: said, its dependencies unchecked otherwise (the high review of #452)', function() {
      if (process.platform === 'win32') return this.skip();
      const d = mk({'package.json': {name: 'm', dependencies: {foo: '1'}}, 'node_modules/foo/index.js': '', 'real/foo.json': '{not json'});
      fs.symlinkSync(path.join('..', '..', 'real', 'foo.json'), path.join(d, 'node_modules', 'foo', 'package.json'));
      assert.match(checkTree(d).problems.join('\n'), /node_modules[\\/]foo[\\/]package\.json cannot be parsed/);
    });
    it('a package.json linked outside: that problem alone, said once', function() {
      if (process.platform === 'win32') return this.skip();
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-tree-out-'));
      made.push(outsideDir);
      fs.writeFileSync(path.join(outsideDir, 'p.json'), JSON.stringify({main: './index.js'}));
      const d = mk({'package.json': {name: 'm'}, 'node_modules/foo/index.js': ''});
      fs.symlinkSync(path.join(outsideDir, 'p.json'), path.join(d, 'node_modules', 'foo', 'package.json'));
      const r = checkTree(d);
      assert.strictEqual(r.problems.filter((p) => /node_modules[\\/]foo[\\/]package\.json is a symlink to .*, outside the module/.test(p)).length, 1);
      assert.deepStrictEqual(r.manifestLinks, []);
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
    it('one that names the root itself, in any spelling (Node tries <root>.js beside it)', () => {
      refused(mk({'package.json': {name: 'm', main: '.'}, 'index.js': ''}), 'package.json');
      refused(mk({'package.json': {name: 'm', main: './'}, 'index.js': ''}), 'package.json');
      refused(mk({'package.json': {name: 'm'}, 'lib/x/package.json': {main: '../..'}}), 'lib/x/package.json');
      refused(mk({'package.json': {name: 'm'}, 'lib/x/package.json': {main: '../../'}}), 'lib/x/package.json');
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
      // (beyond the BMP, as Linux casefold skips them; and NFKC, as ZFS
      // compares: Fable's pass on #452, F4)
      for (const name of ['pack\u{E0041}age.json', 'pack\u{E0001}age.json', 'pack\u{1BCA0}age.json', 'pack\u{1D173}age.json', '\uFF50ackage.json', 'package\uFF0Ejson']) {
        refused(mk({'package.json': {name: 'm'}, [`node_modules/t/${name}`]: {name: 't', main: '../../../outside.js'}}), `node_modules/t/${name}`);
      }
    });
    it('judges the very file matched, a case variant\'s, and refuses one that can\'t be parsed by its own name, on every platform', () => {
      const d = mk({'package.json': {name: 'm'}, 'node_modules/p/PACKAGE.JSON': '{not json'});
      assert.match(checkTree(d).problems.join('\n'), /node_modules[\\/]p[\\/]PACKAGE\.JSON cannot be parsed/);
      // (Node's own reader takes a "main" past a value JSON.parse rejects;
      // Fable's pass on #452, F3)
      const f = mk({'package.json': {name: 'm'}, 'node_modules/f/Package.json': '{"a": ], "main": "../../x"}'});
      assert.match(checkTree(f).problems.join('\n'), /node_modules[\\/]f[\\/]Package\.json cannot be parsed/);
      // (and its "main" judged whether JSON.parse takes it or not: a BOM, a
      // Linux mount that folds case)
      const b = mk({'package.json': {name: 'm'}, 'node_modules/q/PACKAGE.JSON': '\uFEFF{"name": "q", "main": "../../../outside.js"}'});
      refused(b, 'node_modules/q/PACKAGE.JSON');
      const e = mk({'package.json': {name: 'm'}, 'node_modules/p/package.json': '{not json'});
      assert.match(checkTree(e).problems.join('\n'), /node_modules[\\/]p[\\/]package\.json cannot be parsed/);
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
