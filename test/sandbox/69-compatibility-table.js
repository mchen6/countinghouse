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
//   the module's own directory, which is virtual on POSIX in every mode
//   (/app/...), single-thread included, and in a Windows worker
//   (<V>:\app\...); on POSIX it reaches Node in its host form (the file
//   broker's mapping in a worker, the single-thread facade's by the calling
//   module there), and under enforce the reduced `module` has confined
//   _nodeModulePaths and _resolveFilename, so they work in every mode on
//   POSIX; a Windows worker answers as on master (not found, below); in
//   single-thread mode on Windows a module's __dirname is its host path (no
//   virtual directory there), so they work as in plain Node;
// - module-alias: in a worker a module's requires are resolved by the file
//   broker with Node's own resolver, so its replaced _resolveFilename is
//   never asked (F4-1): use relative requires;
// - source-map-support's hookRequire, require-in-the-middle, module-alias:
//   they replace the loader's statics, held in both modes (S, F7), or
//   process.getBuiltinModule (held); module-alias's alias is never asked in
//   a worker, whose resolution is the file broker's own (F4-1); under
//   enforce the reduced `module` has no prototype or statics to replace.
// (resolve-from and import-fresh: a module's virtual parent reaches Node in
// its host form, confined to the module's root, in every mode on POSIX --
// C-compat; not yet in a Windows worker;
// in single-thread mode module-alias's alias works too: on POSIX an
// absolute /app path, mapped by the facade; on Windows a host path, as a
// module's __dirname is there)
// (a direct Module._resolveFilename with an absolute /app request is not
// mapped in a worker, as on master (ruled: cut from C-compat; the mapping
// that shares the hook's own code is a later row): below Node 24.15 the
// resolve shim runs identity's hook for the call, which maps it; from 24.15
// on Node reads the literal /app)
// (Windows, ruled: items 1-3 work on POSIX; a Windows worker answers as
// on master -- resolve-from and import-fresh from __dirname not found --
// pinned as master's, not as working (Windows module-path compatibility is
// its own later row). In single-thread mode on Windows a module's
// __dirname is its host path -- no virtual directory there -- so its
// answers are host paths (findPackageJSON's in a spelling of its own,
// below). Below
// Node 24.15 in a Windows worker, unverified: not asserted.)
const WIN = process.platform === 'win32';
const {NEEDS_RESOLVE_SHIM} = require('../../lib/node-version');
const ABSOLUTE = NEEDS_RESOLVE_SHIM ? (WIN ? null : 'works') : 'threw MODULE_NOT_FOUND';
const WIN_WORKER = WIN ? 'threw MODULE_NOT_FOUND' : 'works';
const TABLE = [
  ['resolve-from', 'works', WIN_WORKER, WIN_WORKER, WIN_WORKER],
  ['import-fresh', 'works', WIN_WORKER, WIN_WORKER, WIN_WORKER],
  // (Node's own entry points with a relative request from a module's own
  // file, asked directly: C-compat, items 4 and 5)
  // (under enforce the reduced module has no findPackageJSON)
  // (single-thread answers a host path, on Windows too, where the answer's
  // spelling differs from the one joined from __dirname. Under off and
  // audit in a Windows worker these two rows aren't asserted: the subset
  // run answered nothing for either -- Windows module-path compatibility
  // is its own later row, ruled; enforce's cell stays asserted)
  ['findPackageJSON relative', 'works (host path)', WIN ? null : 'works', WIN ? null : 'works', 'not in module'],
  ['findPackageJSON directory base', 'works', WIN ? null : 'works', WIN ? null : 'works', 'not in module'],
  ['import-fresh absolute', 'works', ABSOLUTE, ABSOLUTE, ABSOLUTE],
  // (#480's high, round 1: no host path of the module's in what a worker
  // answers or throws, in a worker in every mode (single-thread mode,
  // which answers host paths, unasserted for the missing request; a
  // base climbing out of /app names no host path in single-thread, off and
  // audit -- enforce's module has no findPackageJSON); a lookup path
  // climbing out of /app reaches
  // nothing outside in single-thread mode, where it is mapped; the
  // trailing separator under enforce; a locked Error.stackTraceLimit in
  // single-thread mode)
  ['resolve-from missing, every path in its error virtual', null, 'clean', 'clean', 'clean'],
  ['findPackageJSON, a base climbing out of /app', 'clean', 'clean', 'clean', 'not in module'],
  // (single-thread only: in a worker an answer outside the module is not
  // found whatever the lookup paths, so those cells would assert nothing)
  ['a lookup path climbing out of /app', 'threw MODULE_NOT_FOUND', null, null, null],
  // (enforce only: elsewhere the module's `module` is Node's own, whose list
  // is never empty, so the cell would assert nothing)
  ['_nodeModulePaths, a trailing separator', null, null, null, 'works'],
  // (single-thread only: no worker code reads either on this path, and
  // enforce refuses to redefine them)
  ['resolve-from, stackTraceLimit not writable', 'works', null, null, null],
  // (single-thread: no caller found, nothing mapped, the literal /app not
  // found on POSIX; on Windows __dirname is a host path, found)
  ['resolve-from, prepareStackTrace not writable', WIN ? 'works' : 'threw MODULE_NOT_FOUND', null, null, null],
  // (single-thread on Windows: __dirname is a host path, plain Node, not
  // asserted)
  ['findPackageJSON, the root as its base', WIN ? null : 'clean', 'clean', 'clean', 'not in module'],
  // (off and audit, ruled: a mapped call's answer outside the module is
  // nothing; single-thread mode answers host paths, development mode)
  ['findPackageJSON, a bare name found beside the module', null, 'clean', 'clean', 'not in module'],
  ['a direct request climbing out of the module', null, 'threw MODULE_NOT_FOUND', 'threw MODULE_NOT_FOUND', 'threw MODULE_NOT_FOUND'],
  // (single-thread mode answers host paths, development mode -- on Windows
  // the very path joined from __dirname, a host path there, so 'works'; a
  // worker never names a host path to module code)
  ['resolve-from absolute', WIN ? 'works' : 'works (host path)', ABSOLUTE, ABSOLUTE, ABSOLUTE],
  ['resolve-from absolute, missing', WIN ? 'threw MODULE_NOT_FOUND, as asked' : 'threw MODULE_NOT_FOUND, named otherwise', 'threw MODULE_NOT_FOUND, as asked', 'threw MODULE_NOT_FOUND, as asked', 'threw MODULE_NOT_FOUND, as asked'],
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
    // (a package beside the module's directory, outside it: no lookup path
    // of the module's may reach it)
    fs.mkdirSync(path.join(home, 'node_modules', 'outside-compat-dep'), {recursive: true});
    fs.writeFileSync(path.join(home, 'node_modules', 'outside-compat-dep', 'index.js'), 'module.exports = 1;\n');
    // (a package.json beside it: a findPackageJSON base climbing out of
    // /app must never find it)
    fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify({name: 'outside-compat-home'}));
  });
  after(() => fs.rmSync(home, {recursive: true, force: true}));

  MODES.forEach(([mode, flags], column) => describe(mode, () => {
    let server = null;
    before(async () => {
      server = await startServer(testPort(9777), ['--debug', '--debugKey', KEY, ...flags, '--loadModule', probe]);
    });
    after(() => { stopServer(server); server = null; });
    it('DIAG', async () => {
      const r = await mcpCall(testPort(9777), KEY, TOOL, {name: 'win-diag'});
      console.log(`DIAG ${mode}: ${r != null && r.structuredContent != null ? r.structuredContent.outcome : JSON.stringify(r).slice(0, 2000)}`);
    });
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
