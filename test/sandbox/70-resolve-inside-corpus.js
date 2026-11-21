'use strict';
// sandbox 70 (C-bare): lib/fs-broker/resolve-inside.js resolves a bare or
// '#' request as Node's own ES resolver does. Every "exports" map in the
// corpus (test/fixtures/resolve-corpus/maps.json: maps copied as data from
// published package.json files, no package code), every "imports" map, and
// a synthetic shape for each rule, laid out on disk; each request, under
// each set of conditions, resolved by the sandbox's resolver and by Node's
// own (packageResolve and packageImportsResolve, from
// lib/internal/modules/esm/resolve.js, in a child of this very Node binary
// with --expose-internals): the answers must be the same file URL, or the
// same refusal. The only difference allowed is the sandbox refusing a bare
// request Node answers with a file outside the package it names (by
// design: Node would then stat outside the module's root) -- for the
// cases that name their package's directory (pkgDir), judged from it --
// and the cases marked stricter below. The packages sit at their real names (scoped ones too), at more
// than one node_modules level, with a self-reference, a decoy and odd
// "main"s; findPackageJSON's package for a bare name is compared too.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const url = require('url');
const {spawnSync} = require('child_process');
const Module = require('module');
const {createResolver} = require('../../lib/fs-broker/resolve-inside');
const {mkdtemp, remove} = require('../helpers/test-tmp');
const CORPUS = require('../fixtures/resolve-corpus/maps.json');

// [name, set of conditions]
const CONDITIONS = [
  ['import', ['node', 'import']],
  ['require', ['node', 'require']],
  ['import+module-sync', ['node', 'import', 'module-sync', 'node-addons']],
  ['require+module-sync', ['node', 'require', 'module-sync', 'node-addons']],
  ['import+development', ['node', 'import', 'development']],
  ['browser', ['browser', 'import']]
];

// Synthetic "exports" shapes, one for each rule of Node's.
const SYNTH_EXPORTS = [
  './main.js',
  ['./a.js', './b.js'],
  {import: './m.mjs', require: './c.cjs'},
  {'.': {node: {import: './n.mjs', default: './n.js'}, default: './d.js'}, './feature': './f.js', './feature/*': './f/*.js',
    './feature/*.js': './fx/*.js', './x/*': null, './x/allowed': './ok.js'},
  {'./*': './dist/*.js', './internal/*': null, './a/*/b': './p/*/q.js'},
  {'./bad1': '../out.js', './bad2': './node_modules/x.js', './bad3': '/abs.js', './bad4': 'https://x.invalid/a.js',
    './bad5': ['https://x.invalid/a.js', './good.js'], './bad6': [], './bad7': {browser: './b.js'}, './bad8': './.././x.js',
    './bad9': './%2e%2e/x.js', './bad10': './a/../b.js', './ok': './ok.js'},
  {'.': './a.js', import: './b.js'},
  {'.': {0: './a.js', default: './b.js'}},
  {'./*': './.%2*/.%2*/x.js'},
  {'./dir/': './dir/'},
  {'./*': './*'},
  // (a ten-digit key past 2 ** 32 - 2 is a condition name, not an index)
  {'.': {4294967295: './a.js', default: './b.js'}},
  {'.': {4294967294: './a.js', default: './b.js'}}
];
// Synthetic "imports" maps.
const SYNTH_IMPORTS = [
  {'#a': './a.js', '#b/*': './b/*.js', '#c': {node: './c-node.js', default: './c.js'}, '#d': 'crypto', '#e': 'node:crypto',
    '#f': ['https://x.invalid/a.js', './f.js'], '#g': null, '#h/*.js': './h/*.js', '#i': '../out.js', '#j': 'dep-inside/x',
    '#k': {browser: './k.js'}, '#l': [], '#m/*': './m/.%2*/*', '#n/*': ['./n/*', 'dep-inside/*']},
  // (a '#/' name: Node 22 refuses one, 24 and later take it)
  {'#/*': './lib/*.js'}
];
// Packages with no "exports": a "main" and its fallbacks, on disk.
const LEGACY = [
  [{main: 'lib/main.js'}, ['lib/main.js']],
  [{main: 'lib/main'}, ['lib/main.js']],
  [{main: 'lib'}, ['lib/index.js']],
  [{}, ['index.js']],
  [{main: 'missing.js'}, ['index.json']],
  [{main: 'missing.js'}, []],
  [{main: './lib/../lib/main.js'}, ['lib/main.js']],
  // ("main" joined as a path, as Node joins it: a literal '%20', a
  // backslash, a '?' are file name characters)
  [{main: 'lib/a%20b.js'}, ['lib/a%20b.js', 'index.js']],
  [{main: 'lib\\main.js'}, ['lib/main.js', 'index.js']],
  [{main: 'lib/q.js?x'}, ['lib/q.js', 'index.js']],
  // ("main" resolved first, then each extension appended, as Node's
  // legacyMainResolve: '' is the package's own directory, so its index.js;
  // 'lib/' tries lib.js before lib/index.js; the high review of #465, 3)
  [{main: ''}, ['index.js']],
  [{main: 'lib/'}, ['lib.js', 'lib/index.js']],
  [{main: 'lib/'}, ['lib/index.js']],
  // (a "main" leaving the root: refused, never passed over for index.js,
  // which Node answers after statting outside -- stricter)
  [{main: '../../../../../../../../../../../../ch-no-such-outside.js'}, ['index.js'], true]
];

// the subpaths asked of an "exports" map: '.', each plain key, each
// pattern with a few substitutions, and one that names nothing
const subpathsOf = (exports) => {
  const out = new Set(['.', './no-such-entry']);
  if (exports != null && typeof(exports) === 'object' && !Array.isArray(exports)) {
    for (const k of Object.keys(exports)) {
      if (!k.startsWith('.')) continue;
      if (!k.includes('*')) { if (!k.endsWith('/')) out.add(k); continue; }
      for (const sub of ['x', 'a/b', 'x.js', 'e']) out.add(k.replace('*', sub));
    }
  }
  return [...out];
};
const namesOf = (imports) => {
  const out = new Set(['#no-such']);
  for (const k of Object.keys(imports)) {
    if (!k.startsWith('#')) { out.add(`#${k}`); continue; }
    if (!k.includes('*')) out.add(k);
    else for (const sub of ['x', 'a/b', 'e']) out.add(k.replace('*', sub));
  }
  return [...out];
};

describe('sandbox 70: the in-root resolver against Node\'s own, over a corpus of real and synthetic maps (C-bare)', function() {
  this.timeout(180000);
  let root = null;
  const cases = [];   // {id, spec, parent, pkgDir?, stricter?}
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, text); };

  before(() => {
    root = mkdtemp('resolve-corpus-');
    write(path.join(root, 'package.json'), JSON.stringify({name: 'app'}));
    write(path.join(root, 'index.js'), '');
    const parent = path.join(root, 'index.js');
    // (a package an "imports" bare target names)
    write(path.join(root, 'node_modules', 'dep-inside', 'package.json'), JSON.stringify({name: 'dep-inside', exports: {'./x': './x.js'}}));
    const exportsMaps = CORPUS.exports.map((e) => [`${e.name}@${e.version}`, e.exports, e.name]).concat(SYNTH_EXPORTS.map((e, i) => [`synthetic exports ${i}`, e, `p${i}`]));
    exportsMaps.forEach(([label, exports, name]) => {
      write(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({name, exports}));
      const pkgDir = path.join(root, 'node_modules', ...name.split('/'));
      for (const sub of subpathsOf(exports)) cases.push({id: `${label} ${sub}`, spec: sub === '.' ? name : `${name}/${sub.slice(2)}`, parent, pkgDir});
    });
    const importsMaps = CORPUS.imports.map((e) => [`${e.name}@${e.version}`, e.imports]).concat(SYNTH_IMPORTS.map((e, i) => [`synthetic imports ${i}`, e]));
    importsMaps.forEach(([label, imports], i) => {
      const dir = path.join(root, `imp${i}`);
      write(path.join(dir, 'package.json'), JSON.stringify({name: `imp${i}`, imports}));
      write(path.join(dir, 'index.js'), '');
      for (const name of namesOf(imports)) cases.push({id: `${label} ${name}`, spec: name, parent: path.join(dir, 'index.js')});
    });
    LEGACY.forEach(([pkg, files, stricter], i) => {
      const name = `lm${i}`;
      const pkgDir = path.join(root, 'node_modules', name);
      write(path.join(pkgDir, 'package.json'), JSON.stringify(Object.assign({name}, pkg)));
      for (const f of files) write(path.join(pkgDir, f), '');
      cases.push({id: `legacy ${i} .`, spec: name, parent, pkgDir, stricter: stricter === true});
      cases.push({id: `legacy ${i} ./sub/file.js`, spec: `${name}/sub/file.js`, parent, pkgDir});
    });
    // (a subpath with no "exports" that climbs into another package: Node
    // answers it, the sandbox refuses it -- the F2 shape)
    cases.push({id: 'legacy climbing subpath', spec: 'lm0/../lm1/lib/main.js', parent, stricter: true});
    // (nested node_modules: the nearer level wins, a deeper parent walks up,
    // a scoped package at each level)
    for (const [dir, tag] of [[path.join(root, 'sub'), 'near'], [root, 'far']]) {
      write(path.join(dir, 'node_modules', 'nest', 'package.json'), JSON.stringify({name: 'nest', exports: {'.': `./${tag}.js`, './x': `./x-${tag}.js`}}));
      write(path.join(dir, 'node_modules', '@sc', 'nest', 'package.json'), JSON.stringify({name: '@sc/nest', exports: {'./*': `./${tag}/*.js`}}));
    }
    write(path.join(root, 'node_modules', 'onlyfar', 'package.json'), JSON.stringify({name: 'onlyfar', exports: './only.js'}));
    const deep = path.join(root, 'sub', 'deep', 'er', 'x.js');
    write(deep, '');
    for (const spec of ['nest', 'nest/x', '@sc/nest/a', '@sc/nest/a/b', 'onlyfar', 'nest/missing']) {
      cases.push({id: `nested from deep ${spec}`, spec, parent: deep});
      cases.push({id: `nested from root ${spec}`, spec, parent});
    }
    // (a self-reference: a package's own name from inside it, through its
    // "exports")
    const selfDir = path.join(root, 'selfpkg');
    write(path.join(selfDir, 'package.json'), JSON.stringify({name: 'selfpkg', exports: {'.': './main.js', './feature/*': './f/*.js'}}));
    write(path.join(selfDir, 'lib', 'x.js'), '');
    for (const spec of ['selfpkg', 'selfpkg/feature/a', 'selfpkg/nope']) cases.push({id: `self ${spec}`, spec, parent: path.join(selfDir, 'lib', 'x.js')});
    // (a package in node_modules/node_modules too: resolved as Node walks,
    // every directory up, one named node_modules included -- from the root
    // the real one; from a parent inside node_modules/foo the nearer
    // node_modules/node_modules one. findPackageJSON, whose base the sandbox
    // rebases to the package's level, refuses a package with one: there
    // Node's own walk would look in it first -- stricter for that alone)
    write(path.join(root, 'node_modules', 'decoyed', 'package.json'), JSON.stringify({name: 'decoyed', exports: './real.js'}));
    write(path.join(root, 'node_modules', 'node_modules', 'decoyed', 'package.json'), JSON.stringify({name: 'decoyed', exports: './decoy.js'}));
    write(path.join(root, 'node_modules', 'foo', 'x.js'), '');
    cases.push({id: 'decoy from the root', spec: 'decoyed', parent, fpjStricter: true});
    cases.push({id: 'node_modules/node_modules from inside node_modules/foo', spec: 'decoyed', parent: path.join(root, 'node_modules', 'foo', 'x.js'), fpjStricter: true});
    // (a name with a ':' the URL parser rejects: bare to Node, POSIX only)
    if (process.platform !== 'win32') {
      write(path.join(root, 'node_modules', 'co_lon:pkg', 'package.json'), JSON.stringify({name: 'co_lon:pkg', exports: {'.': './i.js', './x': './x.js'}}));
      for (const spec of ['co_lon:pkg', 'co_lon:pkg/x', 'co_lon:pkg/nope']) cases.push({id: `colon ${spec}`, spec, parent, pkgDir: path.join(root, 'node_modules', 'co_lon:pkg')});
    }
    // (package.json texts JSON.stringify can't write -- a key twice, an
    // "exports" that is a string beginning with '{' or '[' -- read by the
    // resolver as Node reads them; #465's Fable pass, F4)
    for (const [name, text, files] of [
      ['dupkeys', '{"name":"dupkeys","exports":"./first.js","exports":"./second.js"}', ['first.js', 'second.js']],
      ['strobj', '{"name":"strobj","exports":"{\\"./x\\":\\"./y.js\\"}"}', ['y.js']],
      ['strarr', '{"name":"strarr","exports":"[\\"./a.js\\"]"}', ['a.js']]
    ]) {
      write(path.join(root, 'node_modules', name, 'package.json'), text);
      for (const f of files) write(path.join(root, 'node_modules', name, f), '');
      for (const spec of [name, `${name}/x`]) cases.push({id: `raw ${name} ${spec}`, spec, parent, pkgDir: path.join(root, 'node_modules', name)});
    }
    // (and an "imports" that is a string spelling an object)
    {
      const dir = path.join(root, 'strimp');
      write(path.join(dir, 'package.json'), '{"name":"strimp","imports":"{\\"#s\\":\\"./s.js\\"}"}');
      write(path.join(dir, 's.js'), '');
      write(path.join(dir, 'index.js'), '');
      cases.push({id: 'raw strimp #s', spec: '#s', parent: path.join(dir, 'index.js')});
    }
    // (a parent in a directory whose name only ends in node_modules: Node's
    // scope walk goes past it, to the root's package.json and its
    // "imports"; the high review of #465, round 3, item 4)
    {
      const dir = path.join(root, 'xscope');
      write(path.join(dir, 'package.json'), JSON.stringify({name: 'xscope', imports: {'#xs': './xs.js'}}));
      write(path.join(dir, 'xs.js'), '');
      write(path.join(dir, 'x_node_modules', 'a.js'), '');
      cases.push({id: 'x_node_modules #xs', spec: '#xs', parent: path.join(dir, 'x_node_modules', 'a.js')});
    }
    // (a scope with an empty, '.' or '..' name part)
    for (const spec of ['@sc/..', '@sc/.', '@sc/']) cases.push({id: `scope part ${spec}`, spec, parent, stricter: true});
  });
  after(() => { if (root != null) remove(root); });

  const nodeAnswers = (conditions) => {
    const script = `
      const {packageResolve, packageImportsResolve} = require('internal/modules/esm/resolve');
      const {pathToFileURL} = require('url');
      const cases = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      const conditions = new Set(JSON.parse(process.argv[2]));
      const fpj = require('module').findPackageJSON;
      const out = cases.map((c) => {
        let answer;
        try {
          const base = pathToFileURL(c.parent);
          const u = c.spec.startsWith('#') ? packageImportsResolve(c.spec, base, conditions) : packageResolve(c.spec, base, conditions);
          answer = String(u.href || u);
        } catch (e) { answer = 'THROW ' + (e && e.code); }
        let pj = null;
        let pjBase = null;
        if (!c.spec.startsWith('#') && typeof(fpj) === 'function') {
          try { pj = fpj(c.spec, pathToFileURL(c.parent).href) || null; } catch (e) { pj = 'THROW'; }
          // (from the base the sandbox hands Node in its stead)
          if (c.base != null) { try { pjBase = fpj(c.spec, pathToFileURL(c.base).href) || null; } catch (e) { pjBase = 'THROW'; } }
        }
        return [answer, pj, pjBase];
      });
      process.stdout.write(JSON.stringify(out));`;
    const casesFile = path.join(root, '.cases.json');
    const r0 = resolver();
    fs.writeFileSync(casesFile, JSON.stringify(cases.map((c) => {
      const found = c.spec.startsWith('#') ? null : r0.packageDir(c.spec, c.parent);
      return {spec: c.spec, parent: c.parent, base: found == null ? null : found.base};
    })));
    const r = spawnSync(process.execPath, ['--expose-internals', '--no-warnings', '-e', script, casesFile, JSON.stringify(conditions)], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    assert.strictEqual(r.status, 0, r.stderr);
    // (on Windows Node answers a package's self-reference findPackageJSON in
    // its long form, \\?\D:\...; the sandbox answers the plain form by
    // design, fs-broker 26: compared as the plain form)
    const plain = (p) => ((typeof(p) === 'string' && p.startsWith('\\\\?\\')) ? p.slice(4) : p);
    return JSON.parse(r.stdout).map(([answer, pj, pjBase]) => [answer, plain(pj), plain(pjBase)]);
  };
  const resolver = () => createResolver({
    root,
    insideRoot: (p) => p === root || p.startsWith(`${root}${path.sep}`),
    stat: (p) => { try { return fs.statSync(p).isDirectory() ? 1 : 0; } catch (e) { return -2; } },
    readText: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } },
    isBuiltin: Module.isBuiltin
  });

  it('a scope with an empty, \'.\' or \'..\' name part names no package, and no findPackageJSON base above the root', () => {
    const r = resolver();
    const parent = path.join(root, 'index.js');
    fs.mkdirSync(path.join(root, 'node_modules', '@types'), {recursive: true});
    for (const spec of ['@x/..', '@types/.', '@types/..', '@x/', '@x/../y']) {
      assert.strictEqual(r.packageDir(spec, parent), null, spec);
      assert.strictEqual(r.resolve(spec, parent, () => true).refuse, true, spec);
    }
  });

  it('a "main" leaving the root is refused, never passed over for the package\'s index.js', () => {
    const r = resolver();
    const i = LEGACY.findIndex((l) => l[2] === true);
    assert.ok(i >= 0);
    assert.strictEqual(r.resolve(`lm${i}`, path.join(root, 'index.js'), () => true).refuse, true);
  });

  // (createResolver runs at first use, after module code could replace
  // Object.freeze: the one it calls is the one taken at load, and what it
  // returns is frozen; the high review of #465, round 3, item 2)
  it('a resolver built after Object.freeze is replaced never calls it, and is frozen', () => {
    const realFreeze = Object.freeze;
    let called = 0;
    Object.freeze = function(o) { called++; return o; };
    let r;
    try { r = createResolver({root, insideRoot: () => true, stat: () => -2, readText: () => null, isBuiltin: Module.isBuiltin}); } finally { Object.freeze = realFreeze; }
    assert.strictEqual(called, 0);
    assert.strictEqual(Object.isFrozen(r), true);
  });

  // (a package.json read that fails -- the stat said a file -- is none for
  // now, asked again, never kept as none, even where misses are kept)
  it('a package.json read that failed is asked again, not kept as none', () => {
    let fail = true;
    const r = createResolver({root, insideRoot: (p) => p === root || p.startsWith(`${root}${path.sep}`),
      stat: (p) => { try { return fs.statSync(p).isDirectory() ? 1 : 0; } catch (e) { return -2; } },
      readText: (p) => { if (fail && p.endsWith(`lm0${path.sep}package.json`)) return null; try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } },
      isBuiltin: Module.isBuiltin, keepMisses: () => true});
    const parent = path.join(root, 'index.js');
    assert.strictEqual(r.resolve('lm0', parent, () => true).refuse, true, 'refused while its read fails');
    fail = false;
    assert.ok(typeof(r.resolve('lm0', parent, () => true).url) === 'string', 'resolved once it reads');
  });

  for (const [label, conditions] of CONDITIONS) {
    it(`every case answers as Node does, conditions ${label}`, () => {
      const node = nodeAnswers(conditions);
      const r = resolver();
      const has = (c) => conditions.includes(c);
      const mismatches = [];
      cases.forEach((c, i) => {
        const a = r.resolve(c.spec, c.parent, has);
        const mine = a.refuse === true ? 'REFUSE' : (typeof(a.builtin) === 'string' ? `node:${a.builtin.replace(/^node:/, '')}` : a.url);
        // (Node's answer as its resolve finishes it: a file URL that names no
        // path -- an invalid escape -- is Node's own throw, in
        // finalizeResolution's fileURLToPath)
        let theirs = node[i][0];
        if (theirs.startsWith('file:')) { try { url.fileURLToPath(theirs); } catch (e) { theirs = `THROW ${e.code}`; } }
        if (theirs.startsWith('THROW ') ? mine === 'REFUSE' : mine === theirs) return;
        // (the one direction allowed: the sandbox refusing what Node
        // answers outside the package, which it would then stat outside)
        if (mine === 'REFUSE' && c.stricter === true) return;
        if (mine === 'REFUSE' && !theirs.startsWith('THROW ') && typeof(c.pkgDir) === 'string') {
          let outside = false;
          try { const p = url.fileURLToPath(theirs); outside = !(p === c.pkgDir || p.startsWith(`${c.pkgDir}${path.sep}`)); } catch (e) { outside = false; }
          if (outside) return;
        }
        mismatches.push(`${c.id} (${c.spec}): Node ${theirs.replace(url.pathToFileURL(root).href, '<root>')}, sandbox ${String(mine).replace(url.pathToFileURL(root).href, '<root>')}`);
      });
      assert.deepStrictEqual(mismatches, [], `${mismatches.length} of ${cases.length} cases differ`);
      assert.ok(cases.length > 400, `${cases.length} cases`);
      // (findPackageJSON: the package the sandbox finds for a bare name is
      // the one Node's findPackageJSON names, where Node names one inside
      // the root; the sandbox never answers one Node doesn't)
      const fpjMismatches = [];
      cases.forEach((c, i) => {
        if (c.spec.startsWith('#') || c.stricter === true || c.fpjStricter === true) return;
        const theirsPj = node[i][1];
        const mine = r.packageDir(c.spec, c.parent);
        const minePj = mine == null ? null : path.join(mine.pkgDir, 'package.json');
        const inRoot = typeof(theirsPj) === 'string' && theirsPj !== 'THROW' && (theirsPj.startsWith(`${root}${path.sep}`));
        if (minePj == null ? inRoot : minePj !== theirsPj) fpjMismatches.push(`${c.id}: Node ${theirsPj}, sandbox ${minePj}`);
        // (and Node's own findPackageJSON, from the base the sandbox hands
        // it, names that package, inside the root)
        if (mine != null && node[i][2] !== minePj) fpjMismatches.push(`${c.id}: from the base ${mine.base}, Node ${node[i][2]}, sandbox ${minePj}`);
      });
      assert.deepStrictEqual(fpjMismatches, []);
    });
  }
});
