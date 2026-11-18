// sandbox 66 (#194's PR 1): after a worker's lockdown the runtime loads
// nothing of its own. Every file it needs is loaded at boot, so no
// require of countinghouse's (a lazy library, a logger, a re-require) is
// made where module code could stand between it and Node's loader: a
// planted require.cache entry, a poisoned relative-resolve key, a replaced
// handler all find no runtime load to take. Recorded by a test-only probe
// the main thread turns on (CH_TEST_LATE_LOADS=1, lib/lean-worker.js).
const assert = require('assert');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');

const KEY = 'aabbcc';
const PROBE = path.join(ROOT, 'test', 'fixtures', 'late-load-probe');
const TOOL = 'late_load_probe_probeservice_exercise';
const STEPS = ['request', 'redis', 'hostIp', 'loadFile', 'readLines', 'libName', 'ownLoaders', 'error'];

describe('sandbox 66: no runtime load after the lockdown', function() {
  this.timeout(120000);
  let saved;
  before(() => { saved = process.env.CH_TEST_LATE_LOADS; });
  after(() => { if (saved === undefined) delete process.env.CH_TEST_LATE_LOADS; else process.env.CH_TEST_LATE_LOADS = saved; });

  ['enforce', 'audit'].forEach((mode, i) => describe(mode, () => {
    let server = null;
    const port = testPort(9775 + i);
    before(async () => {
      process.env.CH_TEST_LATE_LOADS = '1';
      server = await startServer(port, ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', mode, '--loadModule', PROBE]);
    });
    after(() => { stopServer(server); delete process.env.CH_TEST_LATE_LOADS; });
    const late = () => server.output.split('\n').filter((l) => l.includes('late runtime '));

    // a module validated in a worker of its own, after that worker's lockdown
    it('validate-module: nothing of the runtime\'s is loaded or resolved', async () => {
      const r = await mcpCall(port, KEY, 'countinghouse_validate_module', {path: PROBE});
      assert.ok(r.structuredContent != null, JSON.stringify(r).slice(0, 500));
      await new Promise((res) => setTimeout(res, 200));
      assert.deepStrictEqual(late(), [], late().join('\n'));
    });
    for (const step of STEPS) {
      it(`${step}: nothing of the runtime's is loaded or resolved`, async () => {
        await mcpCall(port, KEY, TOOL, {step});
        await new Promise((r) => setTimeout(r, 200));
        assert.deepStrictEqual(late(), [], late().join('\n'));
      });
    }
    // last: the probe's positive control, so the steps above can't pass with
    // a probe that never installed or never locked
    it('the probe records a load after the lockdown with a runtime parent (its control)', async () => {
      await mcpCall(port, KEY, TOOL, {step: 'control'});
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(late().some((l) => /late runtime load: path from .*[\\/]lib[\\/]logger\.js/.test(l)), server.output.slice(-2000));
    });
  }));

  // the runtime's loads of module files (the dispatcher's, CHUtil.loadFile's)
  // have the module's own anchor as parent, and the fixture's files carry the
  // CLI idiom (`if (!module.parent) throw`), so they load at all only with one
  ['enforce', 'audit'].forEach((mode, i) => it(`${mode}: CHUtil.request's options as handed on; a module file's parent is the module's anchor`, async () => {
    delete process.env.CH_TEST_LATE_LOADS;
    const port = testPort(9775 + i);
    const server = await startServer(port, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', mode, '--loadModule', PROBE]);
    try {
      const r = await mcpCall(port, KEY, TOOL, {step: 'httpSignature'});
      assert.strictEqual(r.isError, false, JSON.stringify(r).slice(0, 800));
      const outcomes = JSON.parse(r.structuredContent.outcomes);
      if (mode === 'audit') {
        // nothing refused; an inherited proxy is reported, as sent
        for (const form of ['signed', 'inheritedProxy']) assert.ok(!/^refused/.test(outcomes[form]), `${form}: ${outcomes[form]}`);
        const deadline = Date.now() + 5000;
        while (!/late-load-probe violation net proxy/.test(server.output) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
        assert.match(server.output, /late-load-probe violation net proxy/);
      } else {
        // the options pass (only own keys are handed on); this start
        // approves no net, so each is refused for its host
        assert.deepStrictEqual(outcomes, {signed: 'refused: late-load.example.invalid:80', inheritedProxy: 'refused: late-load.example.invalid:80'});
      }
      const p = await mcpCall(port, KEY, TOOL, {step: 'parents'});
      assert.ok(p.structuredContent != null, JSON.stringify(p).slice(0, 800));
      // the module's own anchor, inside its root (/app, as module code sees it)
      assert.deepStrictEqual([p.structuredContent.handlerParent, p.structuredContent.loadedParent],
        ['/app/.countinghouse-entry', '/app/.countinghouse-entry']);
    } finally {
      stopServer(server);
    }
  }));

  it('a normal start has no probe', async () => {
    delete process.env.CH_TEST_LATE_LOADS;
    const port = testPort(9775);
    const server = await startServer(port, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', 'enforce', '--loadModule', PROBE]);
    try {
      await mcpCall(port, KEY, TOOL, {step: 'hostIp'});
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(!server.output.includes('late runtime '), server.output.slice(-2000));
    } finally {
      stopServer(server);
    }
  });
});
