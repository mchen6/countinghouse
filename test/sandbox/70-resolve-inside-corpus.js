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
// same refusal. The only differences allowed are the sandbox refusing what
// Node answers outside the package (by design: Node would then stat outside
// the module's root), listed below by case.
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
  {'./*': './*'}
];
// Synthetic "imports" maps.
const SYNTH_IMPORTS = [
  {'#a': './a.js', '#b/*': './b/*.js', '#c': {node: './c-node.js', default: './c.js'}, '#d': 'crypto', '#e': 'node:crypto',
    '#f': ['https://x.invalid/a.js', './f.js'], '#g': null, '#h/*.js': './h/*.js', '#i': '../out.js', '#j': 'dep-inside/x',
    '#k': {browser: './k.js'}, '#l': [], '#m/*': './m/.%2*/*'}
];
// Packages with no "exports": a "main" and its fallbacks, on disk.
const LEGACY = [
  [{main: 'lib/main.js'}, ['lib/main.js']],
  [{main: 'lib/main'}, ['lib/main.js']],
  [{main: 'lib'}, ['lib/index.js']],
  [{}, ['index.js']],
  [{main: 'missing.js'}, ['index.json']],
  [{main: 'missing.js'}, []],
  [{main: './lib/../lib/main.js'}, ['lib/main.js']]
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
  const cases = [];   // {id, spec, parent, stricter?}
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, text); };

  before(() => {
    root = mkdtemp('resolve-corpus-');
    write(path.join(root, 'package.json'), JSON.stringify({name: 'app'}));
    write(path.join(root, 'index.js'), '');
    const parent = path.join(root, 'index.js');
    // (a package an "imports" bare target names)
    write(path.join(root, 'node_modules', 'dep-inside', 'package.json'), JSON.stringify({name: 'dep-inside', exports: {'./x': './x.js'}}));
    const exportsMaps = CORPUS.exports.map((e) => [`${e.name}@${e.version}`, e.exports]).concat(SYNTH_EXPORTS.map((e, i) => [`synthetic exports ${i}`, e]));
    exportsMaps.forEach(([label, exports], i) => {
      const name = `p${i}`;
      write(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({name, exports}));
      for (const sub of subpathsOf(exports)) cases.push({id: `${label} ${sub}`, spec: sub === '.' ? name : `${name}/${sub.slice(2)}`, parent});
    });
    const importsMaps = CORPUS.imports.map((e) => [`${e.name}@${e.version}`, e.imports]).concat(SYNTH_IMPORTS.map((e, i) => [`synthetic imports ${i}`, e]));
    importsMaps.forEach(([label, imports], i) => {
      const dir = path.join(root, `imp${i}`);
      write(path.join(dir, 'package.json'), JSON.stringify({name: `imp${i}`, imports}));
      write(path.join(dir, 'index.js'), '');
      for (const name of namesOf(imports)) cases.push({id: `${label} ${name}`, spec: name, parent: path.join(dir, 'index.js')});
    });
    LEGACY.forEach(([pkg, files], i) => {
      const name = `lm${i}`;
      write(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify(Object.assign({name}, pkg)));
      for (const f of files) write(path.join(root, 'node_modules', name, f), '');
      cases.push({id: `legacy ${i} .`, spec: name, parent});
      cases.push({id: `legacy ${i} ./sub/file.js`, spec: `${name}/sub/file.js`, parent});
    });
    // (a subpath with no "exports" that climbs into another package: Node
    // answers it, the sandbox refuses it -- the F2 shape)
    cases.push({id: 'legacy climbing subpath', spec: 'lm0/../lm1/lib/main.js', parent, stricter: true});
  });
  after(() => { if (root != null) remove(root); });

  const nodeAnswers = (conditions) => {
    const script = `
      const {packageResolve, packageImportsResolve} = require('internal/modules/esm/resolve');
      const {pathToFileURL} = require('url');
      const cases = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      const conditions = new Set(JSON.parse(process.argv[2]));
      const out = cases.map((c) => {
        try {
          const base = pathToFileURL(c.parent);
          const u = c.spec.startsWith('#') ? packageImportsResolve(c.spec, base, conditions) : packageResolve(c.spec, base, conditions);
          return String(u.href || u);
        } catch (e) { return 'THROW ' + (e && e.code); }
      });
      process.stdout.write(JSON.stringify(out));`;
    const casesFile = path.join(root, '.cases.json');
    fs.writeFileSync(casesFile, JSON.stringify(cases.map((c) => ({spec: c.spec, parent: c.parent}))));
    const r = spawnSync(process.execPath, ['--expose-internals', '--no-warnings', '-e', script, casesFile, JSON.stringify(conditions)], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const resolver = () => createResolver({
    root,
    insideRoot: (p) => p === root || p.startsWith(`${root}${path.sep}`),
    stat: (p) => { try { return fs.statSync(p).isDirectory() ? 1 : 0; } catch (e) { return -2; } },
    readText: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } },
    isBuiltin: Module.isBuiltin
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
        let theirs = node[i];
        if (theirs.startsWith('file:')) { try { url.fileURLToPath(theirs); } catch (e) { theirs = `THROW ${e.code}`; } }
        if (theirs.startsWith('THROW ') ? mine === 'REFUSE' : mine === theirs) return;
        // (the one direction allowed: the sandbox refusing what Node
        // answers outside the package, which it would then stat outside)
        if (mine === 'REFUSE' && !theirs.startsWith('THROW ')) {
          const pkgDir = path.join(root, 'node_modules', c.spec.split('/')[0]);
          let outside = false;
          try { const p = url.fileURLToPath(theirs); outside = !(p === pkgDir || p.startsWith(`${pkgDir}${path.sep}`)); } catch (e) { outside = false; }
          if (c.stricter === true || outside) return;
        }
        mismatches.push(`${c.id} (${c.spec}): Node ${theirs.replace(url.pathToFileURL(root).href, '<root>')}, sandbox ${String(mine).replace(url.pathToFileURL(root).href, '<root>')}`);
      });
      assert.deepStrictEqual(mismatches, [], `${mismatches.length} of ${cases.length} cases differ`);
      assert.ok(cases.length > 400, `${cases.length} cases`);
    });
  }
});
