// The broker authorises one (appKey, device) per grant, but a channel joins
// two workers, and module code can post on its own end of the channel, so a
// caller granted one device could ask the callee for another (review R2-2).
// The callee serves only the devices granted on that channel. Before the one
// module format, the other device was a sibling in the same worker (a
// dynamic-discovery module with two devices); a module is now one device in
// its own worker, so the other device is one the channel was never granted:
// a device of another worker, granted to the key or not.
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
  const dev1 = deviceIDForName('peer-callee-1');
  const dev2 = deviceIDForName('peer-callee-2');
  before(async () => {
    base = mkdtemp('peer-grants-');
    const authPath = path.join(base, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({
      forger: {userName: 'forger', devices: [deviceIDForName('peer-forge'), dev1]},
      both:   {userName: 'both', devices: [deviceIDForName('peer-forge'), dev1, dev2]}
    }));
    server = await startServer(9668, ['--workerThread', '--authConfigPath', authPath, '--moduleDataPath', path.join(base, 'store'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'peer-callee-1'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'peer-callee-2'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'peer-forge')]);
  });
  after(() => { stopServer(server); if (base) fs.rmSync(base, {recursive: true, force: true}); });

  it('a granted device is served; a device the channel was not granted is refused', async () => {
    const r = await mcpCall(9668, 'forger', 'peer_forge_forgeservice_forge', {appKey: 'forger', granted: dev1, other: dev2});
    const out = toolOutput(r);
    assert.ok(/^ok: .*peer-callee-1/.test(String(out.granted)), JSON.stringify(r) + server.output.slice(-1500));
    assert.strictEqual(out.other, 'error: PEER_NOT_GRANTED', JSON.stringify(out));
  });

  // The same channel, now with a key granted both devices: the broker's
  // later grant on the open channel reaches the callee before the caller
  // uses it, and the other device, granted to the key but hosted by another
  // worker, is still not served on this channel.
  it('a key granted later on the open channel is served; its other device is not served on this channel', async () => {
    const r = await mcpCall(9668, 'both', 'peer_forge_forgeservice_forge', {appKey: 'both', granted: dev1, other: dev2});
    const out = toolOutput(r);
    assert.ok(/^ok: .*peer-callee-1/.test(String(out.granted)), JSON.stringify(r));
    assert.strictEqual(out.other, 'error: PEER_NOT_GRANTED', JSON.stringify(out));
  });
});
