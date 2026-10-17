// The main thread's message bounds, which must not rely on anything the
// worker enforces: module code can reach the worker's WorkerMessage
// (CHUtil.ci.deviceManager.workerMessage, require.cache) and send any
// command itself.
const assert = require('assert');
require('../../lib/cli-options').setOptions({});
const WorkerMessage = require('../../lib/worker-message');
const DeviceManager = require('../../lib/device-manager');

function exhausted() {
  const posted = [];
  const wm = new WorkerMessage({on() {}, postMessage: (m) => posted.push(m)});
  wm.messageRate = 1;
  wm.rateTokens = 0;
  wm.rateRefillAt = Date.now();
  return {wm, posted};
}

describe('sandbox 14: main-thread message bounds', () => {
  it('delivers sandbox-violation and peer-self-invalidate with the bucket empty', () => {
    ['sandbox-violation', 'peer-self-invalidate'].forEach((command) => {
      const {wm, posted} = exhausted();
      let seen = false;
      wm.on(command, () => { seen = true; });
      wm.onWorkerMessage({id: 1, category: 'child', command: command, data: {}});
      assert.strictEqual(seen, true, command);
      assert.deepStrictEqual(posted, [], command);
    });
  });

  it('still refuses a message that has a callback', () => {
    const {wm, posted} = exhausted();
    wm.onWorkerMessage({id: 7, category: 'child', command: 'rediscommand', data: {}});
    assert.deepStrictEqual(posted, [{command: 'rate-limited-reply', msgID: 7}]);
  });

  it('answers a refused peer-channel-request with a RATE_LIMITED deny', () => {
    const {wm, posted} = exhausted();
    let seen = false;
    wm.on('peer-channel-request', () => { seen = true; });
    wm.onWorkerMessage({id: 3, category: 'child', command: 'peer-channel-request', data: {targetDeviceID: 'dev-b'}});
    assert.strictEqual(seen, false);
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].command, 'peer-channel-deny');
    assert.strictEqual(posted[0].targetDeviceID, 'dev-b');
    assert.strictEqual(posted[0].errCode, 'RATE_LIMITED');
  });

  it('processes one peer-self-invalidate per event-loop turn', async () => {
    const {wm} = exhausted();
    let count = 0;
    wm.on('peer-self-invalidate', () => { count++; });
    for (let i = 0; i < 50; i++) wm.onWorkerMessage({id: i, category: 'child', command: 'peer-self-invalidate'});
    assert.strictEqual(count, 1);
    await new Promise((resolve) => setImmediate(resolve));
    wm.onWorkerMessage({id: 99, category: 'child', command: 'peer-self-invalidate'});
    assert.strictEqual(count, 2);
  });

  // Every report counts, whatever its rule, so a forged 'suppressed' or
  // 'uses' cannot get past the cap either.
  it('passes at most 100 sandbox-violation reports per worker, then one suppressed', () => {
    const {wm} = exhausted();
    const rules = [];
    wm.on('sandbox-violation', (d) => rules.push(d.rule));
    for (let i = 0; i < 300; i++) {
      wm.onWorkerMessage({id: i, category: 'child', command: 'sandbox-violation', data: {rule: i % 2 ? 'suppressed' : 'require', target: String(i)}});
    }
    assert.strictEqual(rules.length, 101);
    assert.strictEqual(rules[100], 'suppressed');
  });

  it('a worker whose peer-channel-request was refused fails the queued calls and asks again on the next call', () => {
    const requests = [];
    const dm = Object.create(DeviceManager.prototype);
    Object.assign(dm, {peerDeviceWorkerMap: {}, peerChannels: {}, pendingPeerInvokes: {},
      workerMessage: {sendPeerChannelRequestToParent: (d) => requests.push(d)}});
    const results = [];
    const call = () => dm.invokeActionViaPeerChannel('k', 'k', 'dev-b', 'svc', 'act', {input: {}}, (err) => results.push(err));
    call();
    call();
    assert.strictEqual(requests.length, 1);
    dm.onPeerChannelDeny({targetDeviceID: 'dev-b', errCode: 'RATE_LIMITED', errMsg: 'too many messages'});
    assert.deepStrictEqual(results.map((e) => e.code), ['RATE_LIMITED', 'RATE_LIMITED']);
    call();
    assert.strictEqual(requests.length, 2);
  });
});
