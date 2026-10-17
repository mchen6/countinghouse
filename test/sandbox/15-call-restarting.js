// A cross-module call to a module that is restarting or suspended gets
// MODULE_RESTARTING / MODULE_SUSPENDED, on both hop paths, like a client
// call does. A device nobody knows keeps its old answer.
const assert = require('assert');
const path = require('path');
require('../../lib/cli-options').setOptions({});
const CHError = require('../../lib/countinghouse-error').CHError;

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

  it('routed path: an unknown device is answered as before', () => {
    const wm = callerWM();
    fakeDm(false).sendInvokeActionMessageToWorker('k', 'k', 'dev-x', 'svc', 'act', {}, 5, wm);
    assert.deepStrictEqual(wm.sent, [{msgID: 5, errMsg: 'device not found in map', data: null}]);
  });

  it('direct peer channels: the request is denied with MODULE_RESTARTING', () => {
    const wm = callerWM();
    const broker = Object.create(PeerChannelBroker.prototype);
    broker.dm = fakeDm(true);
    broker.handleRequest({targetDeviceID: 'dev-b', appKey: 'owner'}, wm);
    assert.strictEqual(wm.sent[0].errCode, 'MODULE_RESTARTING', JSON.stringify(wm.sent));
  });

  it('direct peer channels: an unknown device is still DEVICE_NOT_FOUND', () => {
    const wm = callerWM();
    const broker = Object.create(PeerChannelBroker.prototype);
    broker.dm = fakeDm(false);
    broker.handleRequest({targetDeviceID: 'dev-x', appKey: 'k'}, wm);
    assert.strictEqual(wm.sent[0].errCode, new CHError('DEVICE_NOT_FOUND').code);
  });
});
