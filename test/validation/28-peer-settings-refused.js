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
options.setOptions({redisUrl: 'redis://127.0.0.1:1'});
require('../../lib/logger').createLogger();
const callTokens = require('../../lib/call-tokens');
const ms = require('../../lib/module-settings');

describe('validation 28: a peer match to a module whose required setting is unset runs no handler', () => {
  const inputBytes = () => { const u = Buffer.from(JSON.stringify({input: {}})); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); };
  let saved = null;
  before(() => { saved = {debug: options.debug, singleIdentity: options.singleIdentity}; options.debug = true; options.singleIdentity = true; });
  after(() => { Object.assign(options, saved); });

  it('refused SETTING_REQUIRED, the setting named; nothing held for billing', () => {
    const PeerChannelBroker = require('../../lib/peer-channel-broker');
    const decl = ms.parseDeclaration({name: 'callee', countinghouse: {settings: {region: {type: 'string', required: true}}}}).settings;
    const replies = [];
    const callee = {workerId: 86, hostModuleName: 'callee', settings: {settings: decl, values: ms.effective(decl, {}, {net: []}).values, version: 1},
      sendPeerMeteringReplyToChild: (m) => replies.push(m)};
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
    assert.strictEqual(replies[0].errCode, 'SETTING_REQUIRED', JSON.stringify(replies[0]));
    assert.match(replies[0].errMsg, /callee needs a setting: region/);
    assert.strictEqual(b.unbilled.size, 0, 'no match held for a bill');
  });
});
