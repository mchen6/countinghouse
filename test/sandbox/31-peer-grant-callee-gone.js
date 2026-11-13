// The peer-channel broker decides which worker gets a channel only after the
// caller's access check, which is asynchronous: the callee read before it may
// have ended or been replaced by then. A port transferred to a worker that
// has already exited is dropped without an error and its other end never
// closes (Node 24.21.0: still open after 10 s), so a caller granted that
// channel kept a dead port, and every call over it waited out the peer
// timeout. The broker now looks the device up again after the check: a
// going callee (ended, unloading, or gone from the device map) is answered
// as a missing device, a replaced one is granted on its new worker, and a
// caller that ended meanwhile gets nothing.
//
// A unit test of PeerChannelBroker with a stub access check, run in a child
// process: the broker's requires open Redis clients.
const assert = require('assert');
const path   = require('path');
const {spawnSync} = require('child_process');
const {ROOT} = require('../helpers/sandbox-server');

const LIB = path.join(ROOT, 'lib');

// during: what happens to the device map while the access check is pending.
function run(scenario) {
  const script = `
    require(${JSON.stringify(path.join(LIB, 'cli-options'))}).setOptions({workerThread: true, peerChannelAuthRecheckSeconds: 0});
    require(${JSON.stringify(path.join(LIB, 'logger'))}).createLogger(false);
    let during = () => {};
    const authPath = require.resolve(${JSON.stringify(path.join(LIB, 'user-auth'))});
    require.cache[authPath] = {id: authPath, filename: authPath, loaded: true,
      exports: (a, b, deviceID, appKey, c, d, localCB, cb) => setImmediate(() => { during(); cb(null); })};
    const Broker = require(${JSON.stringify(path.join(LIB, 'peer-channel-broker'))});
    const sent = [];
    const wm = (id) => ({workerId: id, ended: null, unloading: false,
      sendPeerChannelDenyToChild: (d) => sent.push({to: id, deny: d.errCode}),
      sendPeerChannelGrantToChild: (d) => sent.push({to: id, grant: d.targetWorkerId}),
      sendPeerChannelOpenToChild: (d) => sent.push({to: id, open: d.callerWorkerId}),
      sendPeerChannelAllowToChild: (d, cb) => cb(null)});
    const caller = wm(1), callee = wm(2), replacement = wm(3);
    const unloaded = () => ({code: 'MODULE_UNLOADED', message: 'unloaded'});
    const dm = {deviceMap: {D: callee}, missingDeviceError: unloaded, missingDeviceErrorForHop: unloaded};
    const broker = new Broker(dm);
    const scenario = ${JSON.stringify(scenario)};
    if (scenario === 'ended') during = () => { delete dm.deviceMap.D; callee.ended = {code: 'MODULE_UNLOADED'}; };
    if (scenario === 'unloading') callee.unloading = true;
    if (scenario === 'replaced') during = () => { dm.deviceMap.D = replacement; };
    if (scenario === 'caller-ended') during = () => { caller.ended = {code: 'MODULE_UNLOADED'}; };
    // the open takes the call's token (the review of #138, 5a)
    const token = require(${JSON.stringify(path.join(LIB, 'call-tokens'))}).issue({billingKey: 'k', workerId: caller.workerId});
    broker.handleRequest({targetDeviceID: 'D', appKey: 'k', token: token}, caller);
    setTimeout(() => { process.stdout.write('SENT ' + JSON.stringify(sent) + '\\n'); process.exit(0); }, 100);`;
  const r = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 20000});
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('SENT '));
  assert.ok(line != null, `no output: ${r.stdout} ${r.stderr}`);
  return JSON.parse(line.slice('SENT '.length));
}

describe('sandbox 31: a peer channel is granted only to a callee that is still there', function() {
  this.timeout(60000);

  it('nothing changes during the check: the callee gets the channel', () => {
    assert.deepStrictEqual(run('none'), [{to: 2, open: 1}, {to: 1, grant: 2}]);
  });

  it('the callee ends during the check: refused as a missing device, no port sent', () => {
    assert.deepStrictEqual(run('ended'), [{to: 1, deny: 'MODULE_UNLOADED'}]);
  });

  it('the callee is being unloaded: refused as a missing device, no port sent', () => {
    assert.deepStrictEqual(run('unloading'), [{to: 1, deny: 'MODULE_UNLOADED'}]);
  });

  it('the callee is replaced during the check: the new worker gets the channel', () => {
    assert.deepStrictEqual(run('replaced'), [{to: 3, open: 1}, {to: 1, grant: 3}]);
  });

  it('the caller ends during the check: nothing is sent', () => {
    assert.deepStrictEqual(run('caller-ended'), []);
  });
});
