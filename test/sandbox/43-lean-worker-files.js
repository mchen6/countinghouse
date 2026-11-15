// Lean worker, step 3 (docs/superpowers/specs/2026-11-13-lean-worker-design.md
// section 2): a lean worker loads only the sandbox prelude, the message
// channel, the dispatcher, handler-ctx with the CHUtil facade, and
// call-address. This lists every file a worker has required after its first
// invoke, for a module that requires nothing itself, and fails on anything
// outside the allowed list. It is what keeps the worker lean as the code
// changes: a new entry needs the reviewer's yes.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');
const {testPort} = require('../helpers/test-env');

const PORT = testPort(9750);

// Relative to the countinghouse root. A directory entry (ending in /) allows
// every file under it.
const ALLOWED = [
  'lib/lean-worker.js',
  'lib/lean-dispatcher.js',
  'lib/handler-answer.js',
  // a hop's input as bytes (#185), a result as bytes (lean worker step 2)
  'lib/hop-input.js',
  'lib/serialized-result.js',
  // every message to the main thread as an envelope, each dispatch in its own
  // scope (#186); module stdout and stderr bounded, at the lockdown (#190)
  'lib/message-envelope.js',
  'lib/port-scope.js',
  'lib/worker-stdio.js',
  'lib/output-lines.js',
  'lib/output-limits.js',
  'lib/thread-info.js',
  'lib/peer-worker.js',
  'lib/peer-channel.js',
  'lib/handler-map.js',
  'lib/handler-ctx.js',
  'lib/chutil-facade.js',
  'lib/worker-message.js',
  'lib/countinghouse-error.js',
  'lib/error-catalogue.js',
  'lib/cli-options.js',
  // a call's own cap and timeout, held by its token while it runs (#233):
  // tiny, and requires nothing but cli-options, already above
  'lib/call-limits.js',
  'lib/call-address.js',
  'lib/resolve-shim.js',
  'lib/node-version.js',
  'lib/fs-broker/identity.js',
  'lib/fs-broker/patch.js',
  'lib/fs-broker/client.js',
  'lib/fs-broker/roots.js',
  'lib/module-lockdown.js',
  'lib/module-permissions.js',
  'lib/loopback-names.js',
  'node_modules/uuid-1345/'
];

// What one routed ctx.call may add to the above: the hop's own path, and
// nothing of the device model, the validator or its schema tooling (ajv,
// json-schema-ref-parser, js-yaml), which the main thread holds. Loaded on a
// worker's first hop, they cost it most of a second under that request's
// timer (composition 18's #138-8).
const ALLOWED_AFTER_CALL = ALLOWED.concat([
  // countinghouse-util, attached to the worker on its first use (chutil-facade
  // runtime()), and the routed hop's device query and client
  'lib/countinghouse-util.js',
  'lib/lazy-require.js',
  'node_modules/json-stringify-safe/',
  'lib/query-device.js',
  'lib/service-client.js',
  'lib/session.js',
  'node_modules/once/',
  'node_modules/wrappy/',
  'lib/timer.js',
  'lib/store.js'
]);

const allowedIn = (list) => (rel) => list.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a));
const allowed = allowedIn(ALLOWED);
const allowedAfterCall = allowedIn(ALLOWED_AFTER_CALL);

// The runtime's own files among a worker's require cache keys: under its
// root, not the module's (/app).
// node_modules is read through its real path too: a worktree's may be a
// link to another checkout's, which would otherwise read as outside the root.
function runtimeFiles(files) {
  const root = fs.realpathSync(ROOT);
  const modules = fs.realpathSync(path.join(ROOT, 'node_modules'));
  return files.filter((f) => !f.startsWith('/app/'))
    .map((f) => (f.startsWith(modules + path.sep) ? path.join('node_modules', path.relative(modules, f))
      : path.relative(f.startsWith(root) ? root : ROOT, f)))
    .filter((rel) => !rel.startsWith('..') && !path.isAbsolute(rel));
}

// One server per path, in turn on the same port: direct peer channels (the
// default) and routed (--no-directPeerChannels).
[['direct peer channels', []], ['routed', ['--no-directPeerChannels']]].forEach(([label, flags]) => {
  describe(`sandbox 43: a lean worker loads only what it needs (lean worker step 3), ${label}`, function() {
    this.timeout(120000);
    let base = null;
    let server = null;
    before(async () => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-lean-43-'));
      server = await startServer(PORT, ['--workerThread', '--debug', '--debugKey', 'k', '--moduleSandbox', 'audit'].concat(flags, [
        '--moduleDataPath', path.join(base, 'store'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'lean-probe'),
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'token-callee'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'lean-probe-caller')]));
    });
    after(() => {
      stopServer(server);
      if (base != null) fs.rmSync(base, {recursive: true, force: true});
    });

    it('after its first invoke, has required nothing of the runtime outside the allowed list', async () => {
      const out = toolOutput(await mcpCall(PORT, 'k', 'lean_probe_probeservice_files', {}));
      const runtime = runtimeFiles(out.files);
      assert.ok(runtime.length > 0, `no runtime file seen: ${JSON.stringify(out.files).slice(0, 300)}`);
      const extra = runtime.filter((rel) => !allowed(rel)).sort();
      assert.deepStrictEqual(extra, [], `required outside the allowed list (${extra.length}):\n  ${extra.join('\n  ')}`);
    });

    it(`after one ctx.call (${label}), has required nothing outside the hop's list (no validator, no device model, no logger)`, async () => {
      const out = toolOutput(await mcpCall(PORT, 'k', 'lean_probe_caller_probecallerservice_filesaftercall', {}));
      assert.match(out.called, /^ok \d+$/, `the hop did not answer: ${out.called}`);
      const runtime = runtimeFiles(out.files);
      const extra = runtime.filter((rel) => !allowedAfterCall(rel)).sort();
      assert.deepStrictEqual(extra, [], `required outside the hop's list (${extra.length}):\n  ${extra.join('\n  ')}`);
    });
  });
});
