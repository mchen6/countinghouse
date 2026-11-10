// The builtin allowlist (lib/module-lockdown.js) refuses child_process,
// worker_threads, vm and the rest to module code. require.cache is reachable
// from module code (R2-1 §10), and its entries are countinghouse's Module
// objects. Does a countinghouse Module's require, called from module code,
// count as module code? The allowlist must hold either way: each refused
// builtin required through require.cache[<a lib/ file>].require must have
// exactly the outcome a direct require has, in enforce and in audit, and the
// worker's file-bridge transport (workerData.fsBridge) must not be reachable
// that way.
const assert = require('assert');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');

const KEY   = 'm44key';
const PORT  = 9653;
const PROBE = path.join(ROOT, 'test', 'fixtures', 'cache-require-probe');
const TOOL  = 'cache_require_probe_probeservice_attempt';
const BUILTINS = ['child_process', 'worker_threads', 'vm'];

// The allowlist itself, so a change in either direction shows up, not only a
// difference between the two routes. vm is allowlisted
// (lib/module-lockdown.js ALLOWED_BUILTINS); child_process and worker_threads
// are not. Audit allows every builtin and logs it.
const DIRECT = {
  enforce: {child_process: {outcome: 'refused', code: 'MODULE_NOT_FOUND'}, worker_threads: {outcome: 'refused', code: 'MODULE_NOT_FOUND'},
    vm: {outcome: 'loaded', code: null}},
  audit: {child_process: {outcome: 'loaded', code: null}, worker_threads: {outcome: 'loaded', code: null}, vm: {outcome: 'loaded', code: null}}
};

['enforce', 'audit'].forEach((mode) => {
  describe(`auth 44: refused builtins through require.cache, ${mode}`, function() {
    this.timeout(60000);
    let server = null;
    before(async () => {
      server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', mode, '--loadModule', PROBE]);
    });
    after(() => stopServer(server));

    BUILTINS.forEach((name) => {
      it(`${name}: the require.cache route has the direct route's outcome`, async () => {
        const direct = toolOutput(await mcpCall(PORT, KEY, TOOL, {what: name, via: 'direct'}));
        assert.deepStrictEqual({outcome: direct.outcome, code: direct.code}, DIRECT[mode][name],
          `${mode} ${name}: the allowlist itself changed: direct ${JSON.stringify(direct)}`);
        const viaCache = toolOutput(await mcpCall(PORT, KEY, TOOL, {what: name, via: 'cache'}));
        assert.strictEqual(viaCache.owner, 'lib/cli-options.js', `no lib/ entry found in require.cache: ${JSON.stringify(viaCache)}`);
        assert.deepStrictEqual({outcome: viaCache.outcome, code: viaCache.code}, {outcome: direct.outcome, code: direct.code},
          `${mode} ${name}: direct ${JSON.stringify(direct)}, via require.cache ${JSON.stringify(viaCache)}`);
      });
    });

    if (mode === 'enforce') {
      it('the file-bridge transport is not reachable through require.cache', async () => {
        const viaCache = toolOutput(await mcpCall(PORT, KEY, TOOL, {what: 'worker_threads', via: 'cache'}));
        assert.notStrictEqual(viaCache.fsBridge, true, JSON.stringify(viaCache));
      });
    }
  });
});
