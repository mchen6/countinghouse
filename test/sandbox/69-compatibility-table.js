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
// - resolve-from, import-fresh: they hand Node's resolver a parent made from
//   the module's own directory, which is virtual (/app/...) in every mode,
//   single-thread included; it reaches Node in its host form (the file
//   broker's mapping in a worker, the single-thread facade's by the calling
//   module there), and under enforce the reduced `module` has confined
//   _nodeModulePaths and _resolveFilename, so they work in every mode;
// - module-alias: in a worker a module's requires are resolved by the file
//   broker with Node's own resolver, so its replaced _resolveFilename is
//   never asked (F4-1): use relative requires;
// - source-map-support's hookRequire, require-in-the-middle, module-alias:
//   they replace the loader's statics, held in both modes (S, F7), or
//   process.getBuiltinModule (held); module-alias's alias is never asked in
//   a worker, whose resolution is the file broker's own (F4-1); under
//   enforce the reduced `module` has no prototype or statics to replace.
// (resolve-from and import-fresh: a module's virtual parent reaches Node in
// its host form, confined to the module's root, in every mode -- C-compat;
// in single-thread mode module-alias's alias works too: an absolute /app
// path, mapped by the facade, as on Windows, where the module's own
// directory is <V>:\app\..., a drive no host path is on, #195)
const TABLE = [
  ['resolve-from', 'works', 'works', 'works', 'works'],
  ['import-fresh', 'works', 'works', 'works', 'works'],
  // (Node's own entry points with a relative request from a module's own
  // file, asked directly: C-compat, items 4 and 5)
  // (under enforce the reduced module has no findPackageJSON)
  ['findPackageJSON relative', 'works', 'works', 'works', 'not in module'],
  ['findPackageJSON directory base', 'works', 'works', 'works', 'not in module'],
  ['import-fresh absolute', 'works', 'works', 'works', 'works'],
  // (single-thread mode answers host paths, development mode; a worker
  // never names a host path to module code)
  ['resolve-from absolute', 'works (host path)', 'works', 'works', 'works'],
  ['resolve-from absolute, missing', 'threw MODULE_NOT_FOUND, named otherwise', 'threw MODULE_NOT_FOUND, as asked', 'threw MODULE_NOT_FOUND, as asked', 'threw MODULE_NOT_FOUND, as asked'],
  // (enforce only: none of the module's own files named by its host path
  // in any part of the error, by any route; the other modes have no
  // isolation, and Node's own stack and message name host files there, by
  // version)
  ['absolute request, every path in its error virtual', null, null, null, 'clean'],
  ['_resolveFilename relative', 'works', 'works', 'works', 'works'],
  ['source-map-support', 'works', 'works', 'works', 'works'],
  ['source-map-support hookRequire', 'works', 'works', 'no hook', 'threw TypeError'],
  // (single-thread: its alias, an absolute /app path, is mapped through
  // the calling module's root by the facade -- C-compat -- as it already
  // was on Windows)
  ['module-alias', 'works', 'no alias (threw MODULE_NOT_FOUND)', 'no alias (threw MODULE_NOT_FOUND)', 'threw TypeError'],
  // (under enforce the reduced module's confined _resolveFilename (C-compat)
  // takes it past its own abort, onto a Module.prototype there is none of:
  // it throws at new Hook(), as under audit -- ruled R1)
  ['require-in-the-middle', 'works', 'works', 'threw TypeError', 'threw TypeError'],
  // (a module's own code and the process-wide warning and error switches:
  // under enforce what Node's walk reads is held, #451)
  ['emitWarning assigned', 'works', 'works', 'works', 'works'],
  ['emitWarning = null', 'threw TypeError', 'threw TypeError', 'threw TypeError', 'warnings off'],
  ['emitWarning redefined', 'works', 'works', 'works', 'threw TypeError'],
  ['Error.stackTraceLimit redefined', 'works', 'works', 'works', 'threw TypeError'],
  ['Error.stackTraceLimit assigned', 'works', 'works', 'works', 'works'],
  ['process.noDeprecation getter', 'works', 'works', 'works', 'threw TypeError'],
  // (an assignment that doesn't take: silent in sloppy code, a TypeError in
  // strict code)
  ['process.env replaced', 'works', 'works', 'works', 'not replaced'],
  ['process.send set', 'works', 'works', 'works', 'not set']
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
    // (a library the table names is the version the repo pins exactly: the
    // table measures that one; the second round on #440)
    if (under === moduleDir && names.includes(name)) {
      const pinned = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).devDependencies[name];
      assert.strictEqual(pkg.version, pinned, `${name} is ${pkg.version}, the repo pins ${pinned}`);
    }
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
    // (a null cell: not asserted in that column)
    for (const row of TABLE.filter((r) => r[column + 1] !== null)) {
      it(`${row[0]}: ${row[column + 1]}`, async () => {
        const r = await mcpCall(testPort(9777), KEY, TOOL, {name: row[0]});
        const outcome = r != null && r.structuredContent != null ? r.structuredContent.outcome : JSON.stringify(r).slice(0, 300);
        assert.strictEqual(outcome, row[column + 1], JSON.stringify(r).slice(0, 500));
      });
    }
  }));
});
