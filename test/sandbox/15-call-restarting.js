// A cross-module call to a module that is restarting or suspended gets
// MODULE_RESTARTING / MODULE_SUSPENDED, on both hop paths, like a client
// call does. A device nobody knows keeps its old answer.
const assert = require('assert');
require('../../lib/cli-options').setOptions({});
const CHError = require('../../lib/countinghouse-error').CHError;
const DeviceManager = require('../../lib/device-manager');
const PeerChannelBroker = require('../../lib/peer-channel-broker');

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
  it('routed path: answers MODULE_RESTARTING', () => {
    const wm = callerWM();
    fakeDm(true).sendInvokeActionMessageToWorker('k', 'k', 'dev-b', 'svc', 'act', {}, 5, wm);
    assert.strictEqual(wm.sent[0].errCode, 'MODULE_RESTARTING', JSON.stringify(wm.sent));
    assert.strictEqual(wm.sent[0].msgID, 5);
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
    broker.handleRequest({targetDeviceID: 'dev-b', appKey: 'k'}, wm);
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
