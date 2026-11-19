'use strict';
// sandbox 69 (#194's PR 3): the compatibility table. Loader-related
// libraries a module's dependencies use, each used by a fixture module as
// its dependents use it, under off, audit and enforce: what works and what
// needs --moduleSandbox off is documented (docs/security-model.md, the
// table), not discovered. Each library is a devDependency of the repo,
// pinned exactly; the test copies it, with its own dependencies, into the
// fixture module's node_modules (module code requires only what is inside
// its root), never vendored in the repo.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');

const KEY = 'aabbcc';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'compat-probe');
const TOOL = 'compat_probe_probeservice_library';
const LIBRARIES = ['resolve-from', 'import-fresh', 'source-map-support', 'module-alias', 'require-in-the-middle'];

// [the use, its outcome in single-thread mode, then in a worker under off,
// audit, enforce]. Why each fails is in docs/security-model.md's table:
// - resolve-from, import-fresh, module-alias: they hand Node's resolver a
//   path made from the module's own directory, which is virtual (/app/...)
//   in every mode, single-thread included, and Node reads that name as the
//   host's own /app; under enforce the reduced `module` has no
//   _nodeModulePaths or statics either;
// - source-map-support's hookRequire, require-in-the-middle, module-alias:
//   they replace the loader's statics, held in both modes (S, F7), or
//   process.getBuiltinModule (held); module-alias's alias is never asked in
//   a worker, whose resolution is the file broker's own (F4-1); under
//   enforce the reduced `module` has no prototype or statics to replace.
const TABLE = [
  ['resolve-from', 'threw MODULE_NOT_FOUND', 'threw MODULE_NOT_FOUND', 'threw MODULE_NOT_FOUND', 'threw TypeError'],
  ['import-fresh', 'threw MODULE_NOT_FOUND', 'threw MODULE_NOT_FOUND', 'threw MODULE_NOT_FOUND', 'threw TypeError'],
  ['source-map-support', 'works', 'works', 'works', 'works'],
  ['source-map-support hookRequire', 'works', 'works', 'no hook', 'threw TypeError'],
  ['module-alias', 'no alias (threw MODULE_NOT_FOUND)', 'no alias (threw MODULE_NOT_FOUND)', 'no alias (threw MODULE_NOT_FOUND)', 'threw TypeError'],
  ['require-in-the-middle', 'works', 'works', 'threw TypeError', 'no hook']
];
// [the column's name, its start flags]
const MODES = [['single-thread', ['--no-workerThread']], ['off', ['--workerThread', '--moduleSandbox', 'off']],
  ['audit', ['--workerThread', '--moduleSandbox', 'audit']], ['enforce', ['--workerThread', '--moduleSandbox', 'enforce']]];

// A package and what it depends on, from where Node finds it for the
// repo, copied under dest's node_modules: at the top where the name is
// free, else nested under the package that needs that copy.
function copyClosure(names, moduleDir) {
  const placed = new Map();   // name -> source dir at the top level
  const queue = names.map((name) => ({name, from: ROOT, under: moduleDir}));
  while (queue.length > 0) {
    const {name, from, under} = queue.shift();
    // (by Node's lookup directories: an "exports" map may hide package.json)
    const src = Module._nodeModulePaths(from).map((nm) => path.join(nm, name)).find((d) => fs.existsSync(path.join(d, 'package.json')));
    if (src == null) continue;   // an optional one not installed
    let dest;
    if (!placed.has(name)) {
      placed.set(name, src);
      dest = path.join(moduleDir, 'node_modules', name);
    } else if (placed.get(name) === src) {
      continue;
    } else {
      dest = path.join(under, 'node_modules', name);
      if (fs.existsSync(dest)) continue;
    }
    fs.cpSync(src, dest, {recursive: true, dereference: true});
    const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies || {})) queue.push({name: dep, from: src, under: dest});
  }
}

describe('sandbox 69: the compatibility table (loader-related libraries, per --moduleSandbox)', function() {
  this.timeout(120000);
  let home;
  let probe;
  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sb-69-'));
    probe = path.join(home, 'compat-probe');
    fs.cpSync(FIXTURE, probe, {recursive: true});
    copyClosure(LIBRARIES, probe);
  });
  after(() => fs.rmSync(home, {recursive: true, force: true}));

  MODES.forEach(([mode, flags], column) => describe(mode, () => {
    let server = null;
    before(async () => {
      server = await startServer(testPort(9777), ['--debug', '--debugKey', KEY, ...flags, '--loadModule', probe]);
    });
    after(() => { stopServer(server); server = null; });
    for (const row of TABLE) {
      it(`${row[0]}: ${row[column + 1]}`, async () => {
        const r = await mcpCall(testPort(9777), KEY, TOOL, {name: row[0]});
        const outcome = r != null && r.structuredContent != null ? r.structuredContent.outcome : JSON.stringify(r).slice(0, 300);
        assert.strictEqual(outcome, row[column + 1], JSON.stringify(r).slice(0, 500));
      });
    }
  }));
});
