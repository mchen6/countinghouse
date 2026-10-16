// Every route the lockdown controls, under enforce (blocked, logged) and audit
// (allowed, logged once). Plus Review Focus 2: a full composition scenario
// under enforce, so countinghouse's own worker code is proven not to trip the
// built-in block.
const assert = require('assert');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');

const KEY   = 'aabbcc';
const PROBE = path.join(ROOT, 'test', 'fixtures', 'sandbox-probe');
const TOOL  = 'sandbox_probe_probeservice_attempt';
const OUTSIDE_FILE = path.join(ROOT, 'lib', 'cli-options.js');

const ROUTES = [
  ['dlopen'], ['binding'], ['kill'], ['getBuiltinModule'], ['child_process'], ['worker_threads'],
  ['v8'], ['registerHooks'], ['nodePath'], ['loadFileOutside', OUTSIDE_FILE], ['request', 'http://127.0.0.1:1/'],
  ['_kill'], ['dataImport', OUTSIDE_FILE], ['reducedCreateRequire'], ['requestUri'], ['requestBaseUrl']
];

function serverArgs(mode) {
  return ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', mode, '--loadModule', PROBE];
}

describe('sandbox 05: worker lockdown', function() {
  this.timeout(120000);

  describe('enforce', () => {
    let server = null;
    before(async () => { server = await startServer(9608, serverArgs('enforce')); });
    after(() => stopServer(server));

    ROUTES.forEach(([what, arg]) => {
      it(`blocks ${what} and logs it`, async () => {
        const r = await mcpCall(9608, KEY, TOOL, arg != null ? {what: what, arg: arg} : {what: what});
        assert.strictEqual(r.isError, false, JSON.stringify(r));
        assert.strictEqual(r.structuredContent.output.outcome, 'blocked', `${what}: ${JSON.stringify(r.structuredContent)}`);
        assert.ok(server.output.includes('module sandbox: sandbox-probe violation'), server.output.slice(-2000));
      });
    });

    it('uses Node\'s own error codes', async () => {
      const notFound = await mcpCall(9608, KEY, TOOL, {what: 'child_process'});
      assert.strictEqual(notFound.structuredContent.output.code, 'MODULE_NOT_FOUND');
      const denied = await mcpCall(9608, KEY, TOOL, {what: 'kill'});
      assert.strictEqual(denied.structuredContent.output.code, 'ERR_ACCESS_DENIED');
    });
  });

  describe('audit', () => {
    let server = null;
    before(async () => { server = await startServer(9609, serverArgs('audit')); });
    after(() => stopServer(server));

    ROUTES.forEach(([what, arg]) => {
      it(`allows ${what} and logs it`, async () => {
        const r = await mcpCall(9609, KEY, TOOL, arg != null ? {what: what, arg: arg} : {what: what});
        assert.strictEqual(r.structuredContent.output.outcome, 'allowed', `${what}: ${JSON.stringify(r.structuredContent)}`);
      });
    });

    it('logs a repeated violation once', async () => {
      await mcpCall(9609, KEY, TOOL, {what: 'v8'});
      await mcpCall(9609, KEY, TOOL, {what: 'v8'});
      const lines = server.output.split('\n').filter((l) => l.includes('module sandbox: sandbox-probe violation builtin v8'));
      assert.strictEqual(lines.length, 1, lines.join('\n'));
    });
  });

  // Review Focus 2.
  describe('composition under enforce', () => {
    let server = null;
    // Same server as test/composition/02-ctx-call.js (no --debug, its own
    // auth config and key), plus --moduleSandbox enforce. Direct peer
    // channels are at their default, on.
    before(async () => {
      server = await startServer(9610, ['--workerThread', '--moduleSandbox', 'enforce',
        '--authConfigPath', path.join(ROOT, 'test', 'composition', 'fixtures-auth.json'),
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'compose-callee'),
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'compose-caller')]);
    });
    after(() => stopServer(server));

    it('a ctx.call between two modules works, with no violation from countinghouse\'s own code', async () => {
      const r = await mcpCall(9610, 'composition-test-key', 'compose_caller_callerservice_viacall', {n: 21});
      assert.strictEqual(r.isError, false, JSON.stringify(r));
      assert.strictEqual(r.structuredContent.output.n, 42, JSON.stringify(r));
      assert.ok(!/violation builtin/.test(server.output), server.output.slice(-3000));
    });
  });
});
