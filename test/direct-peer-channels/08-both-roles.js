// A worker can be a peer's caller and its callee at once: A calls B's device,
// then B calls A's. Each role keeps its own channel to the other worker. Before,
// one map held both, keyed by the peer's worker id, so B's channel back to A
// (A's callee role) replaced A's caller channel to B, and A's next call to B
// went to a channel with no announce (the final pass's gateway part, A1).
// Pure logic: two peer states in one thread, wired with real MessageChannels
// the way PeerChannelBroker.grant() hands them out.
const assert = require('assert');
const {MessageChannel} = require('worker_threads');

describe('direct peer channels 08: a worker is a caller and a callee of one peer at once', function() {
  this.timeout(20000);
  const options = require('../../lib/cli-options');
  const peerWorker = require('../../lib/peer-worker');
  const saved = {};
  const ports = [];
  const states = [];
  before(() => {
    saved.requestTimeout = options.requestTimeout;
    saved.maxOutputBytes = options.maxOutputBytes;
    options.requestTimeout = 2000;
    options.maxOutputBytes = 1048576;
  });
  after(() => {
    for (const s of states) {
      for (const map of [s.peerChannels, s.peerCalleeChannels]) {
        for (const k of Object.keys(map || {})) { try { map[k].invalidate(); } catch (e) { /* closed */ } }
      }
    }
    for (const p of ports) { try { p.close(); } catch (e) { /* closed */ } }
    options.requestTimeout = saved.requestTimeout;
    options.maxOutputBytes = saved.maxOutputBytes;
  });

  // a peer state as the lean worker makes one, its maps on the state (mapsOf
  // falls back to the state itself), recording what it sends the main thread
  function state(name) {
    const log = [];
    const s = {
      name,
      peerChannels: {__proto__: null}, peerCalleeChannels: {__proto__: null}, peerDeviceWorkerMap: {__proto__: null}, pendingPeerInvokes: {__proto__: null},
      workerMessage: {
        sendPeerChannelRequestToParent(d) { log.push(['request', d.targetDeviceID]); },
        sendPeerAnnounceToParent(d) { log.push(['announce', d.channel, d.deviceID]); },
        sendPeerMeteringRequestToParent() { log.push(['metering-request']); },
        sendSandboxViolationToParent() {}
      },
      log
    };
    for (const k of Object.keys(peerWorker.methods)) s[k] = peerWorker.methods[k].bind(s);
    states.push(s);
    return s;
  }
  const channel = () => { const c = new MessageChannel(); ports.push(c.port1, c.port2); return c; };

  it('B opening its channel back to A leaves A\'s channel to B a caller\'s: A\'s next call announces', async () => {
    const A = state('A');
    const B = state('B');
    const results = [];
    const call = (from, deviceID, label) => from.invokeActionViaPeerChannel(deviceID, 'svc', 'act', {input: {}, token: 't'},
      (err) => { results.push(`${label}: ${err ? err.code : 'ok'}`); });

    // A calls B's device: brokered, pair 1:2 (the callee B gets port2, the caller A port1)
    call(A, 'devB', 'A->B #1');
    const c12 = channel();
    B.onPeerChannelOpen({callerWorkerId: 1, targetDeviceID: 'devB', actions: ['svc|act'], port: c12.port2});
    A.onPeerChannelGrant({targetDeviceID: 'devB', targetWorkerId: 2, port: c12.port1});
    const toB = A.peerChannels[2];
    assert.ok(toB != null && typeof toB.announce === 'function', 'A holds a caller channel to B');

    // B calls A's device: brokered, pair 2:1 (the callee A gets port2, the caller B port1)
    call(B, 'devA', 'B->A #1');
    const c21 = channel();
    A.onPeerChannelOpen({callerWorkerId: 2, targetDeviceID: 'devA', actions: ['svc|act'], port: c21.port2});
    B.onPeerChannelGrant({targetDeviceID: 'devA', targetWorkerId: 1, port: c21.port1});

    assert.ok(A.peerChannels[2] === toB, 'A\'s caller channel to B is the one it had');
    assert.ok(typeof B.peerChannels[1].announce === 'function', 'B holds a caller channel to A');
    assert.ok(A.peerCalleeChannels[2] != null && A.peerCalleeChannels[2] !== toB, 'A serves B on a channel of its own');

    // A calls B again, over the channel it already holds: announced as a caller's
    const before = A.log.filter((e) => e[0] === 'announce').length;
    call(A, 'devB', 'A->B #2');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(A.log.filter((e) => e[0] === 'announce').length, before + 1, JSON.stringify(A.log));
    assert.strictEqual(A.log.filter((e) => e[0] === 'request').length, 1, 'no second channel request: the channel held is used');
  });

  it('an invalidate for a peer ends both of this worker\'s channels to it', () => {
    const A = state('A2');
    const c12 = channel();
    const c21 = channel();
    A.onPeerChannelGrant({targetDeviceID: 'devB', targetWorkerId: 2, port: c12.port1});
    A.onPeerChannelOpen({callerWorkerId: 2, targetDeviceID: 'devA', actions: ['svc|act'], port: c21.port2});
    const caller = A.peerChannels[2];
    const callee = A.peerCalleeChannels[2];
    assert.ok(caller != null && callee != null && caller !== callee);
    A.onPeerInvalidate({workerId: 2});
    assert.ok(caller.closed === true && callee.closed === true, `caller closed ${caller.closed}, callee closed ${callee.closed}`);
  });
});
