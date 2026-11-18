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

  // revision 6, item 3: refused in both modes; item 8: the runtime's loads
  // of module files (the dispatcher's, CHUtil.loadFile's) pass no parent
  ['enforce', 'audit'].forEach((mode, i) => it(`${mode}: the httpSignature request option is refused; a module file's parent is null`, async () => {
    delete process.env.CH_TEST_LATE_LOADS;
    const port = testPort(9775 + i);
    const server = await startServer(port, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', mode, '--loadModule', PROBE]);
    try {
      const r = await mcpCall(port, KEY, TOOL, {step: 'httpSignature'});
      assert.strictEqual(r.isError, false, JSON.stringify(r).slice(0, 800));
      const outcomes = JSON.parse(r.structuredContent.outcomes);
      if (mode === 'audit') {
        // audit hands on postman-request's own copy: the option is found
        // however it is put
        assert.deepStrictEqual(outcomes, {plain: 'refused: httpSignature', behindProxy: 'refused: httpSignature',
          onPrototype: 'refused: httpSignature', getter: 'refused: httpSignature'});
      } else {
        // enforce hands on only its checked own keys, each read once: the
        // option is refused as the only extra one, refused with the other,
        // and otherwise never reaches postman-request. (This start approves
        // no net, so every request that gets past the options is refused
        // for its host.)
        assert.deepStrictEqual([outcomes.plain, outcomes.behindProxy], ['refused: httpSignature', 'refused: proxy']);
        for (const form of ['onPrototype', 'getter']) assert.strictEqual(outcomes[form], 'refused: late-load.example.invalid:80', form);
      }
      const p = await mcpCall(port, KEY, TOOL, {step: 'parents'});
      assert.ok(p.structuredContent != null, JSON.stringify(p).slice(0, 800));
      assert.deepStrictEqual([p.structuredContent.handlerParent, p.structuredContent.loadedParent], ['null', 'null']);
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
