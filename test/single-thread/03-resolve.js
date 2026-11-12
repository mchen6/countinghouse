// Single-thread mode's path facade (lib/single-thread-facade.js) maps a
// module's /app paths to its own files through a resolve hook. Below Node
// 24.15 require.resolve and createRequire().resolve skip resolve hooks, so
// the facade registers through the resolve shim (lib/resolve-shim.js) and
// a module's require.resolve('/app/...') answers its own file on every
// version (the floor-shim PR's code review).
const assert = require('assert');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {mkdtemp} = require('../helpers/test-tmp');
const {toolOutput} = require('../helpers/tool-result');

const PORT = 9727;
const KEY = 'k';
const PROBE = path.join(ROOT, 'test', 'fixtures', 'sandbox-probe');

describe('single-thread 03: require.resolve of an /app path', function() {
  this.timeout(120000);
  let server = null;
  before(async () => {
    server = await startServer(PORT, ['--no-workerThread', '--debug', '--debugKey', KEY, '--moduleDataPath', path.join(mkdtemp('st-resolve-'), 'store'),
      '--loadModule', PROBE]);
  });
  after(() => stopServer(server));

  const resolve = (what) => mcpCall(PORT, KEY, 'sandbox_probe_probeservice_resolve', {what: what, arg: '/app/handlers/probeService/attempt.js'}).then(toolOutput);

  it('require.resolve answers the module\'s own file', async () => {
    assert.deepStrictEqual(await resolve('resolveAbsolute'),
      {outcome: 'allowed', code: null, result: path.join(PROBE, 'handlers', 'probeService', 'attempt.js')});
  });

  // The facade does not map an /app path for createRequire(__filename)
  // (measured on 24.21 with Node's own hook): the same answer on every
  // version, so not a gap the shim leaves.
  it('createRequire().resolve gives the same answer on every version', async () => {
    assert.deepStrictEqual(await resolve('createRequireResolve'), {outcome: 'allowed', code: 'MODULE_NOT_FOUND', result: null});
  });
});
