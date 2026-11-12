// A cross-module call to a module that is restarting or suspended gets
// MODULE_RESTARTING / MODULE_SUSPENDED, on both hop paths, like a client
// call does. A device nobody knows keeps its old answer.
const assert = require('assert');
const path = require('path');
require('../../lib/cli-options').setOptions({workerThread: false});
const CountinghouseError = require('../../lib/countinghouse-error').CountinghouseError;

const DeviceManager = require('../../lib/device-manager');

// userAuth stand-in: the key 'owner' may call dev-b, anything else may not.
// Installed only while these tests run. The broker binds userAuth when it is
// loaded, and another test file may have loaded it already, so a fresh copy
// is loaded with the stub in place; both are restored afterwards.
const LIB = path.join(__dirname, '..', '..', 'lib');
const userAuthFile = path.join(LIB, 'user-auth.js');
const brokerFile = path.join(LIB, 'peer-channel-broker.js');
function stubUserAuth(deviceID, appKey, cb) {
  if (appKey === 'owner') return cb(null, {});
  const err = new Error('not your device'); err.code = 'DEVICE_ACCESS_DENIED';
  return cb(err);
}
let PeerChannelBroker = null;
let saved = null;

function fakeDm(restarting) {
  const dm = Object.create(DeviceManager.prototype);
  dm.deviceMap = {};
  dm.moduleManager = {supervisor: {errorForDevice: (id) => (restarting && id === 'dev-b'
    ? {code: 'MODULE_RESTARTING', module: 'b', reason: 'exit code 3', retryAt: Date.now() + 1000} : null)}};
  return dm;
}

function callerWM() {
  const sent = [];
  return {sent, sendActionInvokeReplyToChild: (m) => sent.push(m), sendPeerChannelDenyToChild: (m) => sent.push(m)};
}

describe('sandbox 15: calls to a restarting module', () => {
  before(() => {
    saved = {userAuth: require.cache[userAuthFile], broker: require.cache[brokerFile]};
    require.cache[userAuthFile] = {id: userAuthFile, filename: userAuthFile, loaded: true,
      exports: (req, res, deviceID, appKey, serviceID, actionName, localCB, cb) => stubUserAuth(deviceID, appKey, cb)};
    delete require.cache[brokerFile];
    PeerChannelBroker = require(brokerFile);
  });
  after(() => {
    ['userAuth', 'broker'].forEach((k) => {
      const file = (k === 'userAuth') ? userAuthFile : brokerFile;
      if (saved[k] != null) require.cache[file] = saved[k];
      else delete require.cache[file];
    });
  });

  it('routed path: answers MODULE_RESTARTING', () => {
    const wm = callerWM();
    fakeDm(true).sendInvokeActionMessageToWorker('owner', 'owner', 'dev-b', 'svc', 'act', {}, 5, wm);
    assert.strictEqual(wm.sent[0].errCode, 'MODULE_RESTARTING', JSON.stringify(wm.sent));
    assert.strictEqual(wm.sent[0].msgID, 5);
  });

  // Only a caller allowed to call the device learns it is restarting, and
  // why: the reason can be a crash message.
  it('routed path: a caller without access gets the access error, not the restart', () => {
    const wm = callerWM();
    fakeDm(true).sendInvokeActionMessageToWorker('stranger', 'stranger', 'dev-b', 'svc', 'act', {}, 5, wm);
    assert.strictEqual(wm.sent[0].errCode, 'DEVICE_ACCESS_DENIED', JSON.stringify(wm.sent));
    assert.ok(!/exit code 3/.test(JSON.stringify(wm.sent)));
  });

  it('direct peer channels: a caller without access gets the access error, not the restart', () => {
    const wm = callerWM();
    const broker = Object.create(PeerChannelBroker.prototype);
    broker.dm = fakeDm(true);
    broker.handleRequest({targetDeviceID: 'dev-b', appKey: 'stranger'}, wm);
    assert.strictEqual(wm.sent[0].errCode, 'DEVICE_ACCESS_DENIED', JSON.stringify(wm.sent));
  });

  // /code-review medium on c8: with its code, as every other missing-device
  // reason (it used to carry only the text 'device not found in map', so the
  // composing module's rejection had no code).
  it('routed path: an unknown device is DEVICE_NOT_FOUND, to a caller with access', () => {
    const wm = callerWM();
    fakeDm(false).sendInvokeActionMessageToWorker('owner', 'owner', 'dev-x', 'svc', 'act', {}, 5, wm);
    assert.strictEqual(wm.sent.length, 1, JSON.stringify(wm.sent));
    assert.strictEqual(wm.sent[0].msgID, 5);
    assert.strictEqual(wm.sent[0].errCode, 'DEVICE_NOT_FOUND', JSON.stringify(wm.sent));
    assert.strictEqual(wm.sent[0].data, null);
    // the same text as over a direct peer channel: no device ID (review of c9)
    assert.strictEqual(wm.sent[0].errMsg, new CountinghouseError('DEVICE_NOT_FOUND').message, JSON.stringify(wm.sent));
  });

  // Whether a device is missing, and why, is answered only after the access
  // check, so a caller without access cannot tell a device that was hosted
  // here from one that never was.
  it('routed path: an unknown device gives a caller without access the access error', () => {
    const wm = callerWM();
    fakeDm(false).sendInvokeActionMessageToWorker('k', 'k', 'dev-x', 'svc', 'act', {}, 5, wm);
    assert.strictEqual(wm.sent[0].errCode, 'DEVICE_ACCESS_DENIED', JSON.stringify(wm.sent));
  });

  it('direct peer channels: the request is denied with MODULE_RESTARTING', () => {
    const wm = callerWM();
    const broker = Object.create(PeerChannelBroker.prototype);
    broker.dm = fakeDm(true);
    broker.handleRequest({targetDeviceID: 'dev-b', appKey: 'owner'}, wm);
    assert.strictEqual(wm.sent[0].errCode, 'MODULE_RESTARTING', JSON.stringify(wm.sent));
  });

  it('direct peer channels: an unknown device is still DEVICE_NOT_FOUND, to a caller with access', () => {
    const wm = callerWM();
    const broker = Object.create(PeerChannelBroker.prototype);
    broker.dm = fakeDm(false);
    broker.handleRequest({targetDeviceID: 'dev-x', appKey: 'owner'}, wm);
    assert.strictEqual(wm.sent[0].errCode, new CountinghouseError('DEVICE_NOT_FOUND').code);
  });

  // The composing worker's side of that denial reads the same answer as the
  // routed path: the code and the catalogue's text once (high review of #37:
  // it rendered the text twice, "Device not found: Device not found").
  it('direct peer channels: the composing worker decodes the denial as the routed path answers it', () => {
    const wm = callerWM();
    const broker = Object.create(PeerChannelBroker.prototype);
    broker.dm = fakeDm(false);
    broker.handleRequest({targetDeviceID: 'dev-x', appKey: 'owner'}, wm);
    let got = null;
    DeviceManager.prototype.onPeerChannelDeny.call({flushPendingPeerInvokes: (deviceID, workerId, err) => { got = err; }}, wm.sent[0]);
    assert.strictEqual(got.code, 'DEVICE_NOT_FOUND');
    assert.strictEqual(got.message, new CountinghouseError('DEVICE_NOT_FOUND').message);
  });

  it('direct peer channels: a denial with no code is PEER_CHANNEL_DENIED', () => {
    let got = null;
    DeviceManager.prototype.onPeerChannelDeny.call({flushPendingPeerInvokes: (deviceID, workerId, err) => { got = err; }},
      {targetDeviceID: 'dev-x', errMsg: 'refused', errCode: null});
    assert.strictEqual(got.code, 'PEER_CHANNEL_DENIED');
  });

  it('direct peer channels: an unknown device gives a caller without access the access error', () => {
    const wm = callerWM();
    const broker = Object.create(PeerChannelBroker.prototype);
    broker.dm = fakeDm(false);
    broker.handleRequest({targetDeviceID: 'dev-x', appKey: 'k'}, wm);
    assert.strictEqual(wm.sent[0].errCode, 'DEVICE_ACCESS_DENIED', JSON.stringify(wm.sent));
  });
});
