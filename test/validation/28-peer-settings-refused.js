'use strict';
// A direct peer channel's match, when the callee module's required setting is
// unset (the module-level configuration design, section 4.6): no handler
// runs, the match is refused SETTING_REQUIRED (lib/peer-channel-broker.js
// serveMatched), as the routed path refuses it before it sends
// (lib/device-manager.js sendCounted). Server-free. What a match carries
// when it is served (the settings, as a routed call carries them:
// lib/settings-gate.js carried) is validation 26's.
const assert = require('assert');
const options = require('../../lib/cli-options');
const callTokens = require('../../lib/call-tokens');
const ms = require('../../lib/module-settings');

describe('validation 28: a peer match to a module whose required setting is unset runs no handler', () => {
  const inputBytes = () => { const u = Buffer.from(JSON.stringify({input: {}})); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); };
  let saved = null;
  before(() => {
    saved = {debug: options.debug, singleIdentity: options.singleIdentity, redisUrl: options.redisUrl};
    options.setOptions({redisUrl: 'redis://127.0.0.1:1'});   // port 1: nothing listens there
    require('../../lib/logger').createLogger();
    options.debug = true;
    options.singleIdentity = true;
  });
  after(() => { Object.assign(options, saved); });

  it('refused SETTING_REQUIRED, the setting named; nothing held for billing', () => {
    const PeerChannelBroker = require('../../lib/peer-channel-broker');
    const decl = ms.parseDeclaration({name: 'callee', countinghouse: {settings: {region: {type: 'string', required: true}}}}).settings;
    const replies = [];
    const callee = Object.assign(Object.create(require('../../lib/worker-message').prototype), {workerId: 86, hostModuleName: 'callee',
      settings: {settings: decl, values: ms.effective(decl, {}, {net: []}).values, version: 1},
      // (its composition verdict decided, as every device's is once startup's verifications are: one without is answered not ready
      // before its settings are read)
      bindings: {'d-callee': {identity: null, module: 'callee', targets: new Set()}},
      sendPeerMeteringReplyToChild: (m) => replies.push(m)});
    const caller = {workerId: 85, bindings: {'d-caller': {identity: null, module: 'caller', targets: new Set(['d-callee|svc|act'])}}};
    const b = new PeerChannelBroker({deviceMap: {'d-callee': callee}});
    b.channelRegistry['ch'] = {callerWM: caller, calleeWM: callee, grants: {}};
    const token = callTokens.issue({billingKey: 'k', identityKey: 'id-k', workerId: 85, deviceID: 'd-caller'});
    const now = Date.now();
    b.announced.set('ch/1', {token, workerId: 85, channel: 'ch', at: now, deadline: now + 60000, epoch: 'e', invokeId: 1, bytes: 2, limits: null,
      session: null, target: {deviceID: 'd-callee', serviceID: 'svc', actionName: 'act'}, inputBytes: inputBytes()});
    b.serveMatched({channel: 'ch', invokeId: 1}, 'm1', callee, 'ch/1');
    callTokens.drop(token);
    assert.strictEqual(replies.length, 1, JSON.stringify(replies));
    // as the claim (the setting's name), for the calling module to pass on:
    // its outer call answers in the runtime's words
    assert.strictEqual(replies[0].errCode, 'SETTING_REQUIRED', JSON.stringify(replies[0]));
    assert.strictEqual(replies[0].errMsg, 'region');
    assert.strictEqual(b.unbilled.size, 0, 'no match held for a bill');
  });

  // a peer hop's error as the callee posts it (lib/peer-worker.js): its fields and data, as bytes
  const errorBytesOf = (code, message) => require('../../lib/serialized-result').serialize({fields: {errMsg: message, errCode: code}, data: null});
  const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  function billWith(code, message) {
    const PeerChannelBroker = require('../../lib/peer-channel-broker');
    const decl = ms.parseDeclaration({name: 'callee', countinghouse: {settings: {region: {type: 'string'}, units: {type: 'enum', values: ['a'], default: 'a'}}}}).settings;
    const callee = Object.assign(Object.create(require('../../lib/worker-message').prototype), {workerId: 86, hostModuleName: 'callee',
      settings: {settings: decl, values: ms.effective(decl, {}, {net: []}).values, version: 1}, sendPeerMeteringReplyToChild: () => {}});
    const results = [];
    const callerWM = {sendPeerResultToChild: (m) => results.push(m)};
    const b = new PeerChannelBroker({deviceMap: {'d-callee': callee}});
    b.unbilled.set('tok', {wm: callee, workerId: 86, channel: 'ch', invokeId: 1, epoch: 'e', callerWM, deviceID: 'd-callee', settingsState: callee.settings,
      calleeName: 'callee', actionName: 'act', limits: null, at: Date.now(), deadline: Date.now() + 60000});
    b.unbilledPerChannel.set('ch', 1);
    const bytes = errorBytesOf(code, message);
    b.handleBillRequest({token: 'tok', channel: 'ch', invokeId: 1, served: false, errorBytes: (bytes instanceof ArrayBuffer) ? bytes : toAB(bytes)}, 'm2', callee);
    return results;
  }

  it('a callee\'s ctx.settingRequired for a declared setting unset goes on to its caller as the claim', () => {
    const results = billWith('SETTING_REQUIRED', 'region');
    assert.strictEqual(results.length, 1);
    assert.deepStrictEqual([results[0].errCode, results[0].errMsg], ['SETTING_REQUIRED', 'region']);
  });

  it('one for a setting that is set, or not declared, is a module fault, as on a routed hop', () => {
    for (const name of ['units', 'nope']) {
      const results = billWith('SETTING_REQUIRED', name);
      assert.strictEqual(results[0].errCode, 'DEVICE_INVOKE_EXCEPTION', name);
    }
  });

  it('a SETTING_NOT_READY a callee makes up, with no module that declares settings behind it, is a module fault, as on a routed hop', () => {
    const results = billWith('SETTING_NOT_READY', 'not ready');
    assert.strictEqual(results[0].errCode, 'DEVICE_INVOKE_EXCEPTION', JSON.stringify(results[0]));
  });

  it('a settings claim is checked whatever the callee\'s worker says of it: decoded on the main thread, never by its flag', () => {
    // no flag, a claim for a setting not declared: a module fault all the same
    const results = billWith('SETTING_REQUIRED', 'nope');
    assert.strictEqual(results[0].errCode, 'DEVICE_INVOKE_EXCEPTION', JSON.stringify(results[0]));
    const forged = billWith('SETTING_NOT_READY', 'not ready');
    assert.strictEqual(forged[0].errCode, 'DEVICE_INVOKE_EXCEPTION', JSON.stringify(forged[0]));
  });

  it('any other error goes on as the callee\'s own bytes', () => {
    const results = billWith('SOME_MODULE_CODE', 'its own');
    assert.ok(results[0].errorBuffer instanceof ArrayBuffer);
  });
});
