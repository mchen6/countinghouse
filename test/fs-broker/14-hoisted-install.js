// countinghouse installed the way the README documents (npm install
// countinghouse): npm hoists its dependencies into the project's
// node_modules, beside node_modules/countinghouse, not inside it. Workers
// must still boot and load modules (review, plan 3). The repo checkout every
// other test runs from has all dependencies inside, so only this test sees it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {mkdtemp} = require('../helpers/test-tmp');
const {toolOutput} = require('../helpers/tool-result');

describe('fs-broker 14: a hoisted npm install', function() {
  this.timeout(180000);
  let project = null;
  let installed = null;
  let server = null;

  before(() => {
    project = mkdtemp('hoisted-');
    const nm = path.join(project, 'node_modules');
    installed = path.join(nm, 'countinghouse');
    fs.mkdirSync(installed, {recursive: true});
    // The published files (package.json "files"), not the repo's node_modules.
    ['framework.js', 'package.json', 'bin', 'lib', 'spec'].forEach((p) => fs.cpSync(path.join(ROOT, p), path.join(installed, p), {recursive: true}));
    // The dependencies, hoisted beside it, as npm lays them out.
    for (const entry of fs.readdirSync(path.join(ROOT, 'node_modules'))) {
      fs.cpSync(path.join(ROOT, 'node_modules', entry), path.join(nm, entry), {recursive: true, verbatimSymlinks: true});
    }
    assert.strictEqual(fs.existsSync(path.join(installed, 'node_modules')), false);
    // Another module, installed from npm into the same node_modules.
    const other = path.join(nm, 'other-module');
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'fs-probe'), other, {recursive: true});
    fs.writeFileSync(path.join(other, 'package.json'), '{"name": "other-module", "version": "1.0.0"}');
    fs.writeFileSync(path.join(other, 'secret.json'), '{"secret": true}');
    fs.mkdirSync(path.join(other, 'lib'));
    fs.writeFileSync(path.join(other, 'lib', 'secret.js'), 'module.exports = {secret: true};\n');
  });
  after(() => { if (project) fs.rmSync(project, {recursive: true, force: true}); });
  afterEach(() => { stopServer(server); server = null; });

  ['off', 'enforce'].forEach((mode) => {
    it(`${mode}: a worker boots and its module works`, async () => {
      server = await startServer(9633, ['--workerThread', '--debug', '--debugKey', 'k', '--moduleSandbox', mode,
        '--moduleDataPath', path.join(project, 'store'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'fs-probe')], {root: installed});
      const w = await mcpCall(9633, 'k', 'fs_probe_probeservice_write', {path: '/data/x', content: 'hoisted'});
      assert.deepStrictEqual(toolOutput(w), {ok: true, code: null}, server.output.slice(-3000));
    });
  });

  // Modules are npm packages too, installed into the same node_modules as
  // countinghouse's dependencies: that directory is not countinghouse code, so
  // one module cannot borrow countinghouse's require to reach another's files
  // (spec: "cannot use files to reach ... other modules' code and data").
  ['secret.json', path.join('lib', 'secret.js')].forEach((file) => {
    it(`enforce: a module cannot require another npm-installed module's ${file}`, async () => {
      server = await startServer(9633, ['--workerThread', '--debug', '--debugKey', 'k', '--moduleSandbox', 'enforce',
        '--moduleDataPath', path.join(project, 'store'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'route-probe')], {root: installed});
      const target = path.join(project, 'node_modules', 'other-module', file);
      const r = await mcpCall(9633, 'k', 'route_probe_probeservice_attempt', {what: 'parentRequire', target: target});
      const out = toolOutput(r);
      assert.strictEqual(out.outcome, 'refused', JSON.stringify(r));
    });
  });

  // --hardened grants read access to the hoisted dependencies too.
  it('--hardened (enforce): a worker boots and its module works', async () => {
    const modules = path.join(project, 'modules');
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'fs-probe'), path.join(modules, 'fs-probe'), {recursive: true});
    server = await startServer(9633, ['--workerThread', '--hardened', '--debug', '--debugKey', 'k', '--moduleSandbox', 'enforce',
      '--modulePath', modules, '--moduleDataPath', `${fs.realpathSync(installed)}_data`, '--loadModule', path.join(modules, 'fs-probe')], {root: installed});
    const w = await mcpCall(9633, 'k', 'fs_probe_probeservice_write', {path: '/data/x', content: 'hoisted'});
    assert.deepStrictEqual(toolOutput(w), {ok: true, code: null}, server.output.slice(-3000));
  });
});

// Installs whose dependencies are symlinks: pnpm links each package into
// node_modules/.pnpm/<name>@<version>/node_modules/<name> and links its
// dependencies beside it there, and a checkout may symlink node_modules
// whole. Node looks a dependency up by the link's name before it resolves
// it, so the code roots must hold that spelling as well as the real one
// (review, plan 5).
describe('fs-broker 14: dependencies installed as symlinks', function() {
  this.timeout(180000);
  let project = null;
  let server = null;
  const packages = () => {
    const names = [];
    for (const entry of fs.readdirSync(path.join(ROOT, 'node_modules'))) {
      if (entry.startsWith('.')) continue;
      if (entry.startsWith('@')) fs.readdirSync(path.join(ROOT, 'node_modules', entry)).forEach((n) => names.push(`${entry}/${n}`));
      else names.push(entry);
    }
    return names;
  };
  const store = (nm, name) => path.join(nm, '.pnpm', `${name.replace('/', '+')}@0.0.0`, 'node_modules', name);
  const link = (target, at) => { fs.mkdirSync(path.dirname(at), {recursive: true}); fs.symlinkSync(target, at); };
  const deps = (dir) => {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (e) { pkg = {}; }
    return [].concat(...['dependencies', 'optionalDependencies', 'peerDependencies'].map((k) => Object.keys(pkg[k] || {})));
  };

  // pnpm's layout: every package real only in the store, each one's
  // dependencies linked beside it, countinghouse run from its real path.
  function pnpmInstall() {
    const nm = path.join(project, 'node_modules');
    const names = packages();
    for (const name of names) fs.cpSync(path.join(ROOT, 'node_modules', name), store(nm, name), {recursive: true, verbatimSymlinks: true});
    for (const name of names) {
      for (const dep of deps(store(nm, name))) {
        if (names.includes(dep) && !fs.existsSync(path.join(path.dirname(store(nm, name)), dep))) link(store(nm, dep), path.join(store(nm, name), '..', dep));
      }
    }
    const installed = store(nm, 'countinghouse');
    fs.mkdirSync(installed, {recursive: true});
    ['framework.js', 'package.json', 'bin', 'lib', 'spec'].forEach((p) => fs.cpSync(path.join(ROOT, p), path.join(installed, p), {recursive: true}));
    for (const dep of deps(installed)) link(store(nm, dep), path.join(installed, '..', dep));
    link(installed, path.join(nm, 'countinghouse'));
    assert.strictEqual(fs.lstatSync(path.join(installed, '..', 'bunyan')).isSymbolicLink(), true);
    return installed;
  }

  // A checkout whose node_modules is one symlink to another tree's.
  function linkedNodeModules() {
    const installed = path.join(project, 'checkout');
    fs.mkdirSync(installed);
    ['framework.js', 'package.json', 'bin', 'lib', 'spec'].forEach((p) => fs.cpSync(path.join(ROOT, p), path.join(installed, p), {recursive: true}));
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(installed, 'node_modules'));
    return installed;
  }

  beforeEach(() => { project = mkdtemp('symlinked-'); });
  afterEach(() => {
    stopServer(server);
    server = null;
    fs.rmSync(project, {recursive: true, force: true});
  });

  [['pnpm', pnpmInstall], ['a symlinked node_modules', linkedNodeModules]].forEach(([label, make]) => {
    ['off', 'enforce'].forEach((mode) => {
      it(`${label}, ${mode}: a worker boots and its module works`, async () => {
        const installed = make();
        server = await startServer(9633, ['--workerThread', '--debug', '--debugKey', 'k', '--moduleSandbox', mode,
          '--moduleDataPath', path.join(project, 'store'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'fs-probe')], {root: installed});
        const w = await mcpCall(9633, 'k', 'fs_probe_probeservice_write', {path: '/data/x', content: 'linked'}, {allowUnknownTool: true});
        assert.deepStrictEqual(toolOutput(w), {ok: true, code: null}, server.output.slice(-3000));
      });
    });
  });

  // Not pnpm: Node's permission model refuses a granted symlink when another
  // grant extends its name (redis beside redis-commands), a form of
  // nodejs/node#66812 (plan 5 ledger).
  it('a symlinked node_modules, --hardened (enforce): a worker boots and its module works', async () => {
    const installed = linkedNodeModules();
    const modules = path.join(project, 'modules');
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'fs-probe'), path.join(modules, 'fs-probe'), {recursive: true});
    server = await startServer(9633, ['--workerThread', '--hardened', '--debug', '--debugKey', 'k', '--moduleSandbox', 'enforce',
      '--modulePath', modules, '--moduleDataPath', `${installed}_data`, '--loadModule', path.join(modules, 'fs-probe')], {root: installed});
    const w = await mcpCall(9633, 'k', 'fs_probe_probeservice_write', {path: '/data/x', content: 'linked'}, {allowUnknownTool: true});
    assert.deepStrictEqual(toolOutput(w), {ok: true, code: null}, server.output.slice(-3000));
  });
});
