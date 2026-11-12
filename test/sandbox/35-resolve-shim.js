// Every route from module code to the module resolver, under enforce and
// audit: the require boundary refuses and records what it refuses, and no
// host path comes back. Below Node 24.15 the resolve hooks do not see
// require.resolve or createRequire().resolve, so these are the routes the
// resolve shim brings under the sandbox's hooks (lib/resolve-shim.js;
// docs/superpowers/specs/2026-11-11-node-floor-shim-design.md, section 3).
// On 24.15 and later Node's own hook covers them, and the same tests hold.
const assert = require('assert');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');

const KEY   = 'aabbcc';
const PROBE = path.join(ROOT, 'test', 'fixtures', 'sandbox-probe');
const TOOL  = 'sandbox_probe_probeservice_resolve';
const VIOLATION = 'module sandbox: sandbox-probe violation';
// From the probe's handler directory, five levels up is countinghouse's
// own root: a relative climb into its lib/.
const CLIMB = '../../../../../lib/sandbox';
const OWN_FILE = '/app/handlers/probeService/attempt.js';

function serverArgs(mode) {
  return ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', mode, '--loadModule', PROBE];
}

function violations(server) {
  return server.output.split(VIOLATION).length - 1;
}

// One route, and how many violations it added (the line is written by the
// main thread when the worker reports it, so it may trail the answer).
async function attempt(server, port, what, arg) {
  const before = violations(server);
  const r = await mcpCall(port, KEY, TOOL, arg != null ? {what: what, arg: arg} : {what: what});
  assert.strictEqual(r.isError, false, JSON.stringify(r));
  const deadline = Date.now() + 2000;
  while (violations(server) === before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  return {out: toolOutput(r), added: violations(server) - before, raw: JSON.stringify(r)};
}

function assertNoHostPath(a) {
  assert.ok(!a.raw.includes(ROOT), `a host path came back: ${a.raw}`);
}

describe('sandbox 35: the routes to the module resolver', function() {
  this.timeout(120000);

  describe('enforce', () => {
    let server = null;
    before(async () => { server = await startServer(9691, serverArgs('enforce')); });
    after(() => stopServer(server));

    [
      ['resolveAbsolute', '/etc/passwd'],
      ['resolveClimb', CLIMB],
      ['createRequireResolve', '/etc/passwd'],
      ['builtinCreateRequire', '/etc/passwd'],
      ['capturedResolve', '/etc/passwd'],
      ['createRequireResolve', CLIMB]
    ].forEach(([what, arg]) => {
      it(`refuses ${what}(${arg}), records it, and returns no host path`, async () => {
        const a = await attempt(server, 9691, what, arg);
        assert.strictEqual(a.out.outcome, 'blocked', a.raw);
        assert.strictEqual(a.out.result, null, a.raw);
        assert.ok(a.added >= 1, `no violation recorded: ${server.output.slice(-1500)}`);
        assertNoHostPath(a);
      });
    });

    it('refuses Module._resolveFilename called directly, and returns no host path', async () => {
      const a = await attempt(server, 9691, 'directResolveFilename', '/etc/passwd');
      assert.strictEqual(a.out.outcome, 'blocked', a.raw);
      assert.strictEqual(a.out.result, null, a.raw);
      assertNoHostPath(a);
    });

    it('require.resolve.paths returns no host path', async () => {
      const a = await attempt(server, 9691, 'resolvePaths', 'anything');
      assertNoHostPath(a);
    });

    it('a module\'s own file resolves to its virtual path, by require.resolve and createRequire on its directory', async () => {
      for (const what of ['ownFile', 'ownFileDir']) {
        const a = await attempt(server, 9691, what);
        assert.strictEqual(a.out.outcome, 'allowed', a.raw);
        assert.strictEqual(a.out.result, OWN_FILE, a.raw);
      }
    });

    it('a module cannot replace Module._resolveFilename', async () => {
      const a = await attempt(server, 9691, 'replaceResolveFilename');
      assert.strictEqual(a.out.result, OWN_FILE, a.raw);
    });
  });

  describe('audit', () => {
    let server = null;
    before(async () => { server = await startServer(9692, serverArgs('audit')); });
    after(() => stopServer(server));

    it('records require.resolve and the real createRequire().resolve outside the namespace', async () => {
      for (const what of ['resolveAbsolute', 'createRequireResolve']) {
        const a = await attempt(server, 9692, what, '/etc/passwd');
        assert.strictEqual(a.out.outcome, 'allowed', a.raw);
        assert.ok(a.added >= 1, `${what}: no violation recorded: ${server.output.slice(-1500)}`);
      }
    });

    it('a module cannot replace Module._resolveFilename', async () => {
      const a = await attempt(server, 9692, 'replaceResolveFilename');
      assert.strictEqual(a.out.result, OWN_FILE, a.raw);
    });
  });
});
