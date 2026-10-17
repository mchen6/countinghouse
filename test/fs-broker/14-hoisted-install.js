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
  });
  after(() => { if (project) fs.rmSync(project, {recursive: true, force: true}); });
  afterEach(() => { stopServer(server); server = null; });

  ['off', 'enforce'].forEach((mode) => {
    it(`${mode}: a worker boots and its module works`, async () => {
      server = await startServer(9633, ['--workerThread', '--debug', '--debugKey', 'k', '--moduleSandbox', mode,
        '--moduleDataPath', path.join(project, 'store'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'fs-probe')], {root: installed});
      const w = await mcpCall(9633, 'k', 'fs_probe_probeservice_write', {path: '/data/x', content: 'hoisted'});
      assert.deepStrictEqual(w.structuredContent != null ? w.structuredContent.output : w, {ok: true, code: null}, server.output.slice(-3000));
    });
  });

  // --hardened grants read access to the hoisted dependencies too.
  it('--hardened (enforce): a worker boots and its module works', async () => {
    const modules = path.join(project, 'modules');
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'fs-probe'), path.join(modules, 'fs-probe'), {recursive: true});
    server = await startServer(9633, ['--workerThread', '--hardened', '--debug', '--debugKey', 'k', '--moduleSandbox', 'enforce',
      '--modulePath', modules, '--moduleDataPath', `${fs.realpathSync(installed)}_data`, '--loadModule', path.join(modules, 'fs-probe')], {root: installed});
    const w = await mcpCall(9633, 'k', 'fs_probe_probeservice_write', {path: '/data/x', content: 'hoisted'});
    assert.deepStrictEqual(w.structuredContent != null ? w.structuredContent.output : w, {ok: true, code: null}, server.output.slice(-3000));
  });
});
