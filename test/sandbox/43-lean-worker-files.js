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
  'lib/peer-worker.js',
  'lib/peer-channel.js',
  'lib/handler-map.js',
  'lib/handler-ctx.js',
  'lib/chutil-facade.js',
  'lib/worker-message.js',
  'lib/countinghouse-error.js',
  'lib/error-catalogue.js',
  'lib/cli-options.js',
  'lib/call-address.js',
  'lib/resolve-shim.js',
  'lib/fs-broker/identity.js',
  'lib/fs-broker/patch.js',
  'lib/fs-broker/client.js',
  'lib/module-lockdown.js',
  'lib/module-permissions.js',
  'lib/loopback-names.js',
  'node_modules/uuid-1345/'
];

const allowed = (rel) => ALLOWED.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a));

// Skipped until step 3's Task 4 switches every module to the lean worker.
describe.skip('sandbox 43: a lean worker loads only what it needs (lean worker step 3)', function() {
  this.timeout(120000);
  let base = null;
  let server = null;
  before(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-lean-43-'));
    server = await startServer(PORT, ['--workerThread', '--debug', '--debugKey', 'k', '--moduleSandbox', 'audit',
      '--moduleDataPath', path.join(base, 'store'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'lean-probe')]);
  });
  after(() => {
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  it('after its first invoke, has required nothing of the runtime outside the allowed list', async () => {
    const out = toolOutput(await mcpCall(PORT, 'k', 'lean_probe_probeservice_files', {}));
    const root = fs.realpathSync(ROOT);
    // the runtime's own files: under its root, not the module's (/app)
    const runtime = out.files.filter((f) => !f.startsWith('/app/'))
      .map((f) => path.relative(f.startsWith(root) ? root : ROOT, f))
      .filter((rel) => !rel.startsWith('..') && !path.isAbsolute(rel));
    assert.ok(runtime.length > 0, `no runtime file seen: ${JSON.stringify(out.files).slice(0, 300)}`);
    const extra = runtime.filter((rel) => !allowed(rel)).sort();
    assert.deepStrictEqual(extra, [], `required outside the allowed list (${extra.length}):\n  ${extra.join('\n  ')}`);
  });
});
