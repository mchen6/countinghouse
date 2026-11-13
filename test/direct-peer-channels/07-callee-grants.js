// The broker authorises one (appKey, device) per grant, but a channel joins
// two workers, and the callee served any device its worker hosts. Module code
// can post on its own end of the channel, so a caller granted one device
// could invoke another on the same worker without any check (review R2-2).
// The callee now serves only the devices granted on that channel.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {mkdtemp} = require('../helpers/test-tmp');
const {deviceIDForName} = require('../../lib/call-address');
const {toolOutput} = require('../helpers/tool-result');

describe('direct peer channels 07: the callee serves only granted devices', function() {
  this.timeout(120000);
  let server = null;
  let base = null;
  const dev1 = deviceIDForName('dynamic-device-1');
  const dev2 = deviceIDForName('dynamic-device-2');
  before(async () => {
    base = mkdtemp('peer-grants-');
    const authPath = path.join(base, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({
      forger: {userName: 'forger', devices: [deviceIDForName('peer-forge'), dev1]},
      // peer-forge declares its calls (R2-1 Task 4), resolved under 'both'
      both:   {userName: 'both', devices: [deviceIDForName('peer-forge'), dev1, dev2], runsModules: ['peer-forge']}
    }));
    server = await startServer(9668, ['--workerThread', '--authConfigPath', authPath, '--moduleDataPath', path.join(base, 'store'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'dynamic-discovery-module'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'peer-forge')]);
  });
  after(() => { stopServer(server); if (base) fs.rmSync(base, {recursive: true, force: true}); });

  it('a granted device is served; another device on the same worker is refused', async () => {
    const r = await mcpCall(9668, 'forger', 'peer_forge_forgeservice_forge', {appKey: 'forger', granted: dev1, other: dev2});
    const out = toolOutput(r);
    assert.ok(/^ok: .*dynamic-device-1/.test(String(out.granted)), JSON.stringify(r) + server.output.slice(-1500));
    assert.strictEqual(out.other, 'error: PEER_NOT_GRANTED', JSON.stringify(out));
  });

  // The same worker pair, now with a key granted both: the broker's later
  // grant on the open channel reaches the callee before the caller uses it.
  it('a device granted later on the open channel is served', async () => {
    const r = await mcpCall(9668, 'both', 'peer_forge_forgeservice_forge', {appKey: 'both', granted: dev2, other: dev1});
    const out = toolOutput(r);
    assert.ok(/^ok: .*dynamic-device-2/.test(String(out.granted)), JSON.stringify(r));
    assert.ok(/^ok: .*dynamic-device-1/.test(String(out.other)), JSON.stringify(out));
  });
});
