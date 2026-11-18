// sandbox 68 (#194's PR 2): what module code can see of the runtime after its
// worker's lockdown, under audit and enforce alike.
// - A: require.cache (one object: module.constructor._cache is it) holds the
//   module's own files only; the runtime's entries were moved out at the
//   lockdown, so util.inspect, which reads past any view, names none, and no
//   runtime Module reaches an inspect.custom (Revision 6, blocking 1).
// - C: no main module (require.main, process.mainModule).
// - S: every loader static stays as the lockdown left it (those it leaves
//   audit to report as accessors aside), and Node's path cache reads empty
//   whatever is planted in it.
const assert = require('assert');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');

const KEY = 'aabbcc';
const PROBE = path.join(ROOT, 'test', 'fixtures', 'isolation-probe');
const PEER = path.join(ROOT, 'test', 'fixtures', 'isolation-peer');
const TOOL = 'isolation_probe_probeservice_inspect';
const detail = (r) => (r != null && r.structuredContent != null ? r.structuredContent.detail : JSON.stringify(r).slice(0, 300));
const EXPECTED = {
  cacheFiles: 'module files only',
  sameCache: 'same',
  inspect: 'none named, no runtime Module',
  main: 'no require.main, no mainModule',
  statics: 'none replaced',
  pathCache: 'empty'
};

const waitFor = async (server, re) => {
  const deadline = Date.now() + 5000;
  while (!re.test(server.output) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  return re.test(server.output);
};

describe('sandbox 68: the runtime isolated from module code after the lockdown', function() {
  this.timeout(120000);
  // (the test's probe on, for its hand-over of a runtime Module: module code
  // reaches none, A)
  let savedProbe;
  before(() => { savedProbe = process.env.CH_TEST_LATE_LOADS; process.env.CH_TEST_LATE_LOADS = '1'; });
  after(() => { if (savedProbe === undefined) delete process.env.CH_TEST_LATE_LOADS; else process.env.CH_TEST_LATE_LOADS = savedProbe; });
  ['enforce', 'audit'].forEach((mode) => describe(mode, () => {
    let server = null;
    before(async () => {
      server = await startServer(testPort(9759), ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', mode, '--loadModule', PROBE, '--loadModule', PEER]);
    });
    after(() => { stopServer(server); server = null; });
    for (const [step, expected] of Object.entries(EXPECTED)) {
      it(`${step}: ${expected}`, async () => {
        const r = await mcpCall(testPort(9759), KEY, TOOL, {step});
        assert.strictEqual(detail(r), expected, JSON.stringify(r).slice(0, 500));
      });
    }
    // P alone and the net: a load with a runtime Module as its parent, by
    // _load, its require, and new Module().load; and one with no parent:
    // refused under enforce, with the net's line in both modes
    for (const step of ['netLoad', 'netRequire', 'noParent']) {
      it(`${step}: ${mode === 'enforce' ? 'refused' : 'allowed'}, and said`, async () => {
        const r = await mcpCall(testPort(9759), KEY, TOOL, {step});
        if (mode === 'enforce') assert.match(detail(r), /^(MODULE_NOT_FOUND|ERR_ACCESS_DENIED)$/, JSON.stringify(r).slice(0, 500));
        else assert.strictEqual(detail(r), 'loaded', JSON.stringify(r).slice(0, 500));
        const line = step === 'noParent' ? /violation require [^\n]*settings-tool\.js/ : /violation require \.\/settings-tool\.js \(a load by the runtime after the lockdown\)/;
        assert.ok(await waitFor(server, line), server.output.slice(-1500));
      });
    }
    it(`netModuleLoad: a runtime file loaded by a Module of its own is ${mode === 'enforce' ? 'refused' : 'read, and reported'}`, async () => {
      const r = await mcpCall(testPort(9759), KEY, TOOL, {step: 'netModuleLoad'});
      if (mode === 'enforce') assert.notStrictEqual(detail(r), 'loaded', JSON.stringify(r).slice(0, 500));
      else assert.strictEqual(detail(r), 'loaded', JSON.stringify(r).slice(0, 500));
    });
    it('interop: the module\'s own files by import(), require(esm), createRequire and require.resolve', async () => {
      const r = await mcpCall(testPort(9759), KEY, TOOL, {step: 'interop'});
      assert.strictEqual(detail(r), 'cjs esm json resolved', JSON.stringify(r).slice(0, 500));
    });
    it(`BroadcastChannel: ${mode === 'enforce' ? 'gone by either route' : 'a message crosses to another module\'s worker, and is reported'}`, async () => {
      const listening = mcpCall(testPort(9759), KEY, 'isolation_peer_peerservice_listen', {});
      await new Promise((res) => setTimeout(res, 300));
      const r = await mcpCall(testPort(9759), KEY, TOOL, {step: 'broadcast'});
      const heard = await listening;
      if (mode === 'enforce') {
        assert.match(detail(r), /^undefined (MODULE_NOT_FOUND|ERR_ACCESS_DENIED)$/, JSON.stringify(r).slice(0, 500));
        assert.strictEqual(detail(heard), 'no BroadcastChannel');
      } else {
        // (worker_threads, refused under enforce, is allowed and reported under audit)
        assert.match(detail(r), /^function (function|undefined)$/, JSON.stringify(r).slice(0, 500));
        assert.strictEqual(detail(heard), 'received hello');
        assert.ok(await waitFor(server, /isolation-probe uses BroadcastChannel/), server.output.slice(-1500));
      }
    });
  }));
});
