'use strict';
// Shared runtime B3, Task 4 (server-free part), as M5a leaves it
// (module-level configuration, #413 rev 3, sections 5.4 and 5.5): the
// listing check at every hop. No session has a view of its own: a callee
// whose module is going on or off (lib/module-visibility.js) is answered as
// a device never hosted, after the access check, whatever the call's
// session: on the routed hop, the device query, the peer channel's request
// (before the "replacing" check), its announcement and its match, and a
// job's run (not retried). In shared mode a hop to an unloaded module is
// DEVICE_NOT_FOUND, never MODULE_UNLOADED.
//
// The device manager and the broker run on stand-ins (as composition 18
// does); sessions are real shared ones; the visibility set is configured
// with a stand-in device map: module m-hidden on device d-hidden, hidden
// (going on or off) unless a case shows it, and m-loose on d-loose, listed.
const assert = require('assert');
const EventEmitter = require('events');
const options = require('../../lib/cli-options');
// (the options are set in each describe's before(), the process's put back
// in its after(): never at load, which every file of a folder run would
// see -- B-loadopts-2)
const {snapshot: optionsNow, restore: restoreOptions} = require('../helpers/options-scope');
require('../../lib/logger').createLogger();
const callTokens = require('../../lib/call-tokens');
const sessions = require('../../lib/sessions');
const visibility = require('../../lib/module-visibility');
const {CountinghouseError} = require('../../lib/countinghouse-error');

describe('sessions 17: the listing check at every hop (shared runtime B3, Task 4, server-free; M5a)', () => {
  let keptOptions = null;
  before(() => { keptOptions = optionsNow(); options.setOptions({redisUrl: 'redis://127.0.0.1:1'}); });
  after(() => { restoreOptions(keptOptions); });
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const MODULES = {'d-hidden': 'm-hidden', 'd-loose': 'm-loose'};
  let open;
  let issued;
  let saved;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // a hop's input crosses as bytes (lib/hop-input.js)
  const inputBytes = () => { const u = Buffer.from(JSON.stringify({input: {}})); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); };
  const token = (session, workerId, deviceID = 'd-caller') => {
    const t = callTokens.issue({billingKey: 'k', identityKey: 'id-k', workerId: workerId, deviceID: deviceID, session: session});
    issued.push(t);
    return t;
  };
  // the calling worker hosts d-caller, whose module declared svc/act on every device here
  const DECLARED = new Set(['d-hidden|svc|act', 'd-never|svc|act', 'd-loose|svc|act']);
  const callerOf = (workerId, extra = {}) => Object.assign({workerId: workerId, bindings: {'d-caller': {identity: null, module: 'caller', targets: DECLARED}}}, extra);

  beforeEach(() => {
    saved = {debug: options.debug, workerThread: options.workerThread};
    options.debug = true;   // every access check passes: what is looked at is the listing
    issued = [];
    sessions.resetForTests();
    visibility.resetForTests();
    const reg = new EventEmitter();
    sessions.attach(reg);
    open = new Map();
    for (const id of [A, B]) { const s = new EventEmitter(); s.id = id; s.client = {status: 'ok', conditions: 'yes', repo: null}; s.notify = () => {}; s.connected = true; s.record = () => {}; s.forget = () => {}; open.set(id, s); reg.emit('session', s); }
    visibility.configure({moduleOf: (deviceID) => (MODULES[deviceID] || null), isGone: () => false});
    visibility.hide(['m-hidden']);
  });
  afterEach(() => {
    Object.assign(options, saved);
    for (const t of issued.splice(0)) callTokens.drop(t);
    sessions.resetForTests();
    visibility.resetForTests();
  });

  it('every session lists alike: a hidden module\'s device is listed to none, any other to every session', () => {
    assert.deepStrictEqual([visibility.listsDevice('d-hidden'), visibility.listsDevice('d-loose'), visibility.listsDevice('d-never')], [false, true, true]);
    visibility.show(['m-hidden']);
    assert.strictEqual(visibility.listsDevice('d-hidden'), true);
  });

  describe('the routed hop and the device query (lib/device-manager.js)', () => {
    const DeviceManager = require('../../lib/device-manager');
    const manager = (extra = {}) => Object.assign(Object.create(DeviceManager.prototype), {deviceMap: {}, notifyDeviceLoad: {}, allDevicesLoaded: true, moduleManager: null}, extra);
    const hop = (dm, caller, deviceID, t, msgID) => DeviceManager.prototype.sendInvokeActionMessageToWorker.call(dm, null, null, deviceID, 'svc', 'act', {inputBytes: inputBytes()}, msgID, caller, t);
    const fields = (r) => JSON.stringify({errMsg: r.errMsg, errCode: r.errCode, fault: r.fault, data: r.data});

    it('a hop to a hidden module is answered as one never hosted, from every session alike', async () => {
      const replies = [];
      const caller = callerOf(71, {sendActionInvokeReplyToChild: (m) => replies.push(m)});
      const dm = manager({deviceMap: {'d-hidden': {workerId: 72, hostModuleName: 'm-hidden'}}});
      hop(dm, caller, 'd-hidden', token(B, 71), 'h1');
      hop(dm, caller, 'd-never', token(B, 71), 'h2');
      hop(dm, caller, 'd-hidden', token(A, 71), 'h3');
      await sleep(50);
      const byId = (id) => replies.find((r) => r.msgID === id);
      assert.strictEqual(byId('h1').errCode, 'DEVICE_NOT_FOUND', JSON.stringify(replies));
      assert.strictEqual(fields(byId('h1')), fields(byId('h2')));
      assert.strictEqual(fields(byId('h3')), fields(byId('h2')), 'A\'s alike');
    });

    // a billed hop runs only while its charge can be recorded (the owner's
    // decision, 11-27): asked after the access check, before the callee runs
    it('a hop whose charge can\'t be recorded now is refused with the ledger\'s code, after its access check, before the callee is asked', async () => {
      const CHUtil = require('../../lib/countinghouse-util');
      const savedCi = CHUtil.ci;
      const asked = [];
      CHUtil.ci = {chargeable: (key, cb) => { asked.push(key); setImmediate(cb, new CountinghouseError('LEDGER_UNREACHABLE')); }, recordCall: () => {}};
      try {
        const replies = [];
        const caller = callerOf(73, {sendActionInvokeReplyToChild: (m) => replies.push(m)});
        const sent = [];
        const dm = manager({deviceMap: {'d-loose': {workerId: 74, hostModuleName: 'm-loose', sendActionInvokeMessageToChild: (m) => sent.push(m)}}});
        hop(dm, caller, 'd-loose', token(A, 73), 'h9');
        const end = Date.now() + 5000;
        while (!replies.some((r) => r.msgID === 'h9') && Date.now() < end) await sleep(10);
        const r = replies.find((x) => x.msgID === 'h9');
        assert.ok(r != null && r.errCode === 'LEDGER_UNREACHABLE', JSON.stringify(replies));
        assert.deepStrictEqual(asked, ['k'], 'asked for the token\'s billing key');
        assert.deepStrictEqual(sent, [], 'the callee was never asked');
      } finally {
        CHUtil.ci = savedCi;
      }
    });

    it('in shared mode a hop to an unloaded module is DEVICE_NOT_FOUND, never MODULE_UNLOADED; outside it, MODULE_UNLOADED as before', () => {
      const dm = manager({moduleManager: {endedStateForDevice: () => ({code: 'MODULE_UNLOADED', name: 'm-hidden'})}});
      assert.strictEqual(dm.missingDeviceErrorForHop('d-hidden').code, 'DEVICE_NOT_FOUND');
      sessions.resetForTests();
      assert.strictEqual(dm.missingDeviceErrorForHop('d-hidden').code, 'MODULE_UNLOADED');
    });

    it('a device query for a hidden module equals one for a device never hosted; shown, it is answered', async () => {
      const replies = [];
      const wm = callerOf(73, {sendDeviceQueryReplyToChild: (m) => replies.push(m)});
      const dm = manager({deviceMap: {'d-hidden': {workerId: 75}}, ensureDeviceState: (d, cb) => (d === 'd-hidden' ? cb(null, {deviceList: {[d]: {device: {friendlyName: d}}}}) : cb(new Error('missing'), null))});
      DeviceManager.prototype.queryDeviceForChild.call(dm, 'd-hidden', 'q1', wm, {token: token(B, 73)});
      DeviceManager.prototype.queryDeviceForChild.call(dm, 'd-never', 'q2', wm, {token: token(B, 73)});
      DeviceManager.prototype.queryDeviceForChild.call(dm, 'd-hidden', 'q3', wm, {token: token(A, 73)});
      await sleep(50);
      const byId = (id) => replies.find((r) => r.msgID === id);
      assert.strictEqual(byId('q1').errCode, 'DEVICE_NOT_FOUND', JSON.stringify(replies));
      assert.strictEqual(JSON.stringify(Object.assign({}, byId('q1'), {msgID: null})), JSON.stringify(Object.assign({}, byId('q2'), {msgID: null})));
      assert.strictEqual(JSON.stringify(Object.assign({}, byId('q3'), {msgID: null})), JSON.stringify(Object.assign({}, byId('q2'), {msgID: null})), 'A\'s alike');
      visibility.show(['m-hidden']);
      DeviceManager.prototype.queryDeviceForChild.call(dm, 'd-hidden', 'q4', wm, {token: token(A, 73)});
      await sleep(50);
      assert.ok(byId('q4').spec != null, 'shown, it is answered');
    });

    it('a job\'s run into a hidden module fails as a missing device, and is not retried; shown, it runs', () => {
      const got = [];
      let ran = 0;
      const dm = manager({deviceMap: {'d-hidden': {workerId: 74}},
        ensureDeviceState: (d, cb) => (d === 'd-hidden' ? cb(null, dm.deviceMap[d]) : cb(dm.missingDeviceError(d))),
        invokeJobs: () => { ran += 1; }});
      DeviceManager.prototype.invokeJobsNow.call(dm, 'd-hidden', 'svc', 'act', {}, 'j1', (err) => got.push(err), null, {session: B});
      DeviceManager.prototype.invokeJobsNow.call(dm, 'd-never', 'svc', 'act', {}, 'j2', (err) => got.push(err), null, {session: B});
      assert.strictEqual(ran, 0);
      visibility.show(['m-hidden']);
      DeviceManager.prototype.invokeJobsNow.call(dm, 'd-hidden', 'svc', 'act', {}, 'j3', (err) => got.push(err), null, {session: A});
      assert.strictEqual(ran, 1, 'the run once shown only');
      visibility.hide(['m-hidden']);
      assert.deepStrictEqual(got.map((e) => [e.code, e.message.replace('d-never', 'd-hidden')]), [['DEVICE_NOT_FOUND', got[0].message], ['DEVICE_NOT_FOUND', got[0].message]]);
      // the reviewer's ruling (6)(b) on #341: after discovery neither retries; before it, both retry alike
      const {notRetried} = require('../../lib/job-control-common');
      const seen = (e) => JSON.stringify({code: e.code, message: e.message.replace('d-never', 'd-hidden')});
      assert.deepStrictEqual([notRetried(got[0].code, got[0]), notRetried(got[1].code, got[1])], [true, true], 'after discovery, in shared mode');
      assert.strictEqual(seen(got[0]), seen(got[1]));
      const early = [];
      dm.allDevicesLoaded = false;
      DeviceManager.prototype.invokeJobsNow.call(dm, 'd-hidden', 'svc', 'act', {}, 'j4', (err) => early.push(err), null, {session: B});
      DeviceManager.prototype.invokeJobsNow.call(dm, 'd-never', 'svc', 'act', {}, 'j5', (err) => early.push(err), null, {session: B});
      assert.deepStrictEqual([notRetried(early[0].code, early[0]), notRetried(early[1].code, early[1])], [false, false], 'before discovery: both retried');
      assert.strictEqual(seen(early[0]), seen(early[1]));
      assert.strictEqual(JSON.stringify(early[0]), JSON.stringify(got[0]), 'the tag (true and false here) is not serialized');
      sessions.resetForTests();
      assert.strictEqual(notRetried('DEVICE_NOT_FOUND', got[0]), false, 'outside shared mode, as before');
    });
  });

  describe('the peer channel (lib/peer-channel-broker.js)', () => {
    const PeerChannelBroker = require('../../lib/peer-channel-broker');

    it('a request for a hidden target that is replacing is denied DEVICE_NOT_FOUND, headOnly, as a never-hosted target is', async () => {
      const denied = [];
      const caller = callerOf(81, {sendPeerChannelDenyToChild: (m) => denied.push(m)});
      const b = new PeerChannelBroker({deviceMap: {'d-hidden': {workerId: 82, replacing: true, hostModuleName: 'm-hidden'}},
        missingDeviceErrorForHop: () => new CountinghouseError('DEVICE_NOT_FOUND')});
      b.handleRequest({targetDeviceID: 'd-hidden', token: token(B, 81)}, caller);
      b.handleRequest({targetDeviceID: 'd-never', token: token(B, 81)}, caller);
      await sleep(50);
      const strip = (m) => JSON.stringify({errMsg: m.errMsg, errCode: m.errCode, headOnly: m.headOnly});
      assert.strictEqual(denied.length, 2, JSON.stringify(denied));
      assert.deepStrictEqual([denied[0].errCode, denied[0].headOnly], ['DEVICE_NOT_FOUND', true]);
      assert.strictEqual(strip(denied[0]), strip(denied[1]));
    });

    it('an announcement on an open channel for a hidden target is refused DEVICE_NOT_FOUND and holds nothing, from any session; shown, it is held', () => {
      const refused = [];
      const caller = callerOf(83, {sendPeerAnnounceRefusedToChild: (m) => refused.push(m)});
      const callee = {workerId: 84};
      const b = new PeerChannelBroker({deviceMap: {'d-hidden': callee}});
      b.channelRegistry['ch'] = {callerWM: caller, calleeWM: callee, grants: {}};
      const announce = (t, invokeId) => b.handleAnnouncement({channel: 'ch', invokeId: invokeId, token: t, deviceID: 'd-hidden', serviceID: 'svc', actionName: 'act', epoch: 'e', inputBytes: inputBytes()}, caller);
      announce(token(B, 83), 1);
      assert.deepStrictEqual([refused.length, refused[0] && refused[0].errCode, b.announced.size], [1, 'DEVICE_NOT_FOUND', 0], JSON.stringify(refused));
      announce(token(A, 83), 2);
      assert.deepStrictEqual([refused.length, refused[1] && refused[1].errCode, b.announced.size], [2, 'DEVICE_NOT_FOUND', 0], JSON.stringify(refused));
      visibility.show(['m-hidden']);
      announce(token(A, 83), 3);
      assert.deepStrictEqual([refused.length, b.announced.size], [2, 1], JSON.stringify(refused));
    });

    it('the two deny kinds a caller can meet for a hidden device serialize as a never-hosted device\'s deny', async () => {
      const {methods} = require('../../lib/peer-worker');
      const got = [];
      const w = callerOf(89, {peerChannels: {90: {epoch: 'e', fail: (id, err) => got.push(err)}},
        pendingPeerInvokes: {'d-never': [{serviceID: 'svc', actionName: 'act', args: {token: 'x', input: {}}, callback: (err) => got.push(err)}]}});
      for (const name of Object.keys(methods)) w[name] = (...a) => methods[name].apply(w, a);
      w.requestPeerChannel = () => {};
      const b = new PeerChannelBroker({deviceMap: {'d-hidden': {workerId: 90}}, missingDeviceErrorForHop: () => new CountinghouseError('DEVICE_NOT_FOUND')});
      b.channelRegistry['89:90'] = {callerWM: w, calleeWM: {workerId: 90}, grants: {}};
      w.sendPeerChannelDenyToChild = (m) => w.onPeerChannelDeny(m);
      w.sendPeerAnnounceRefusedToChild = (m) => w.onPeerAnnounceRefused(m);
      b.handleRequest({targetDeviceID: 'd-never', token: token(B, 89)}, w);     // never hosted: the request's deny
      await sleep(50);
      b.handleAnnouncement({channel: '89:90', invokeId: 1, token: token(B, 89), deviceID: 'd-hidden', serviceID: 'svc', actionName: 'act', epoch: 'e', inputBytes: inputBytes()}, w);
      const seen = (e) => JSON.stringify(CountinghouseError.replyFields(e));
      assert.strictEqual(got.length, 2, JSON.stringify(got));
      assert.strictEqual(seen(got[1]), seen(got[0]));
      assert.strictEqual(got[0].code, 'DEVICE_NOT_FOUND');
    });

    it('a match whose target\'s module began to go on or off since its announcement runs no handler: refused DEVICE_NOT_FOUND', () => {
      visibility.show(['m-hidden']);
      const replies = [];
      const caller = callerOf(85);
      const callee = {workerId: 86, sendPeerMeteringReplyToChild: (m) => replies.push(m)};
      const b = new PeerChannelBroker({deviceMap: {'d-hidden': callee}});
      b.channelRegistry['ch'] = {callerWM: caller, calleeWM: callee, grants: {}};
      const now = Date.now();
      b.announced.set('ch/1', {token: token(A, 85), workerId: 85, channel: 'ch', at: now, deadline: now + 60000, epoch: 'e', invokeId: 1, bytes: 2, limits: null,
        session: A, target: {deviceID: 'd-hidden', serviceID: 'svc', actionName: 'act'}, inputBytes: inputBytes()});
      visibility.hide(['m-hidden']);
      b.serveMatched({channel: 'ch', invokeId: 1}, 'm1', callee, 'ch/1');
      assert.deepStrictEqual([replies.length, replies[0] && replies[0].errCode], [1, 'DEVICE_NOT_FOUND'], JSON.stringify(replies));
    });
  });
});
