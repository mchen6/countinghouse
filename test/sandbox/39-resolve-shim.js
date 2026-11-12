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

// Under enforce a path outside the namespace is invisible: Node's resolver
// answers MODULE_NOT_FOUND (lib/fs-broker/identity.js hides it), and nothing
// is recorded, since a recorded refusal would say it exists. That is what
// Node 24.15 and later do with their own hook (measured on 24.21); the shim
// gives Node 22 the same answer (the floor-shim spec's aim is parity).
function assertNotFound(a) {
  const refused = (a.out.outcome === 'blocked') || (a.out.outcome === 'allowed' && a.out.code === 'MODULE_NOT_FOUND');
  assert.ok(refused, `not refused: ${a.raw}`);
  assert.strictEqual(a.out.result, null, a.raw);
}

function assertNoHostPath(a) {
  assert.ok(!a.raw.includes(ROOT), `a host path came back: ${a.raw}`);
}

describe('sandbox 39: the routes to the module resolver', function() {
  this.timeout(120000);

  describe('enforce', () => {
    let server = null;
    before(async () => { server = await startServer(9724, serverArgs('enforce')); });
    after(() => stopServer(server));

    [
      ['resolveAbsolute', '/etc/passwd'],
      ['resolveClimb', CLIMB],
      ['createRequireResolve', '/etc/passwd'],
      ['builtinCreateRequire', '/etc/passwd'],
      ['capturedResolve', '/etc/passwd'],
      ['createRequireResolve', CLIMB]
    ].forEach(([what, arg]) => {
      it(`${what}(${arg}) finds nothing and returns no host path`, async () => {
        const a = await attempt(server, 9724, what, arg);
        assertNotFound(a);
        assertNoHostPath(a);
      });
    });

    it('Module._resolveFilename called directly finds nothing and returns no host path', async () => {
      const a = await attempt(server, 9724, 'directResolveFilename', '/etc/passwd');
      assertNotFound(a);
      assertNoHostPath(a);
    });

    // Node appends its global lookup directories (<prefix>/lib/node, and
    // $HOME's when set) to the module's own, on every version: a host path
    // that names the install and the home directory. Under enforce a module
    // sees only its virtual lookup paths.
    it('require.resolve.paths returns only virtual paths', async () => {
      const a = await attempt(server, 9724, 'resolvePaths', 'anything');
      assert.ok(Array.isArray(a.out.result) && a.out.result.length > 0, a.raw);
      assert.ok(a.out.result.every((p) => p === '/node_modules' || p.startsWith('/app/')), a.raw);
    });

    it('a module\'s own file resolves to its virtual path, by require.resolve and createRequire on its directory', async () => {
      for (const what of ['ownFile', 'ownFileDir']) {
        const a = await attempt(server, 9724, what);
        assert.strictEqual(a.out.outcome, 'allowed', a.raw);
        assert.strictEqual(a.out.result, OWN_FILE, a.raw);
      }
    });

    it('a module cannot replace Module._resolveFilename', async () => {
      const a = await attempt(server, 9724, 'replaceResolveFilename');
      assert.strictEqual(a.out.result, OWN_FILE, a.raw);
    });
  });

  describe('audit', () => {
    let server = null;
    before(async () => { server = await startServer(9725, serverArgs('audit')); });
    after(() => stopServer(server));

    it('records require.resolve and the real createRequire().resolve outside the namespace', async () => {
      for (const what of ['resolveAbsolute', 'createRequireResolve']) {
        const a = await attempt(server, 9725, what, '/etc/passwd');
        assert.strictEqual(a.out.outcome, 'allowed', a.raw);
        assert.ok(a.added >= 1, `${what}: no violation recorded: ${server.output.slice(-1500)}`);
      }
    });

    // Below 24.15 the shim locks Module._resolveFilename in every mode; on
    // 24.15 and later nothing is installed or locked under audit, as before
    // the shim (the spec's non-goal: nothing changes there).
    it('a module cannot replace Module._resolveFilename where the shim is installed', async function() {
      if (!require('../../lib/node-version').NEEDS_RESOLVE_SHIM) this.skip();
      const a = await attempt(server, 9725, 'replaceResolveFilename');
      assert.strictEqual(a.out.result, OWN_FILE, a.raw);
    });
  });
});
