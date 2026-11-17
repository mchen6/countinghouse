// The broker authorises one (appKey, device) per grant, but a channel joins
// two workers, and module code can post on its own end of the channel, so a
// caller granted one device could ask the callee for another (review R2-2).
// The callee serves only the devices granted on that channel. Before the one
// module format, the other device was a sibling in the same worker (a
// dynamic-discovery module with two devices); a module is now one device in
// its own worker, so the other device is one the channel was never granted:
// a device of another worker, granted to the key or not. Since lean worker
// step 4 (the review of #202) a port invoke names no target at all: the
// caller's announcement to the main thread does, so one posted on the port
// alone is refused at the callee's match (CALL_TOKEN_INVALID).
// Since PR-c module code cannot reach a peer channel's port at all: the
// runtime posts on it with methods taken at boot, so a hook a module puts on
// MessagePort.prototype never sees it, and the forge has no channel to post
// on. That refusal at the callee's match stays covered server-free
// (composition 18, "a metering request with no announcement is held, then
// refused"); here the other device is asked for the proper way too, by a hop
// of its own, authorized as the identity that runs the module (its
// runsModules) under a grant of its own.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {mkdtemp} = require('../helpers/test-tmp');
const {deviceIDForName} = require('../../lib/call-address');
const {toolOutput} = require('../helpers/tool-result');

// a part of test/test8.js, against its server: alone, skipped (#234)
(global.COUNTINGHOUSE_TEST8_PARTS === true ? describe : describe.skip)('direct peer channels 07: the callee serves only granted devices (a part of test/test8.js: run it, not this file alone)', function() {
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
      // peer-forge declares its calls (R2-1 Task 4), resolved under 'both'
      both:   {userName: 'both', devices: [deviceIDForName('peer-forge'), dev1, dev2], runsModules: ['peer-forge']}
    }));
    server = await startServer(testPort(9668), ['--workerThread', '--authConfigPath', authPath, '--moduleDataPath', path.join(base, 'store'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'peer-callee-1'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'peer-callee-2'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'peer-forge')]);
  });
  after(() => { stopServer(server); if (base) fs.rmSync(base, {recursive: true, force: true}); });

  it('a granted device is served; module code has no channel to post on, and the other device is served only by a hop of its own', async () => {
    const r = await mcpCall(testPort(9668), 'forger', 'peer_forge_forgeservice_forge', {appKey: 'forger', granted: dev1, other: dev2});
    const out = toolOutput(r);
    assert.ok(/^ok: .*peer-callee-1/.test(String(out.granted)), JSON.stringify(r) + server.output.slice(-1500));
    // the module's hook was installed, and never saw the channel's port
    assert.strictEqual(out.hooked, true, JSON.stringify(out));
    assert.strictEqual(out.other, 'no channel', JSON.stringify(out));
    // the other device asked for the proper way, a hop of its own: authorized
    // as the identity that runs peer-forge ('both', its runsModules), under a
    // grant of its own, never through the forger's channel
    assert.match(String(out.otherByHop), /^ok: .*peer-callee-2/, JSON.stringify(out));
  });

  // The same channel, now with a key granted both devices: the broker's
  // later grant on the open channel reaches the callee before the caller
  // uses it, and the other device, granted to the key but hosted by another
  // worker, is still not served on this channel.
  it('a key granted later on the open channel is served; its other device is served by a hop of its own, never through this channel', async () => {
    const r = await mcpCall(testPort(9668), 'both', 'peer_forge_forgeservice_forge', {appKey: 'both', granted: dev1, other: dev2});
    const out = toolOutput(r);
    assert.ok(/^ok: .*peer-callee-1/.test(String(out.granted)), JSON.stringify(r));
    assert.strictEqual(out.hooked, true, JSON.stringify(out));
    assert.strictEqual(out.other, 'no channel', JSON.stringify(out));
    // granted to this key, the other device is served by a hop of its own
    assert.match(String(out.otherByHop), /^ok: .*peer-callee-2/, JSON.stringify(out));
  });
});
