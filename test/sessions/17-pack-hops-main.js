'use strict';
// Shared runtime B3, Task 4 (server-free part): the session check at every
// hop. A callee whose pack the call's session doesn't list is answered as a
// device never hosted, after the access check: on the routed hop, the device
// query, the peer channel's request (before the "replacing" check), its
// announcement and its match, and a job's run (not retried). In shared mode a
// hop to an unloaded module is DEVICE_NOT_FOUND, never MODULE_UNLOADED. An
// ended session's run lists the global packs minus the ones it had turned
// off (lib/job-sessions.js keeps them); one whose "off"s are not kept lists
// no pack (fail closed).
//
// The device manager and the broker run on stand-ins (as composition 18
// does); sessions are real shared ones; lib/session-packs.js is configured
// with stand-ins: a pack `hidden` (module m-hidden, on device d-hidden) that
// A has on and B doesn't, and a global pack `glob` (m-glob, d-glob) that B
// turned off.
const assert = require('assert');
const EventEmitter = require('events');
const options = require('../../lib/cli-options');
options.setOptions({redisUrl: 'redis://127.0.0.1:1'});   // port 1: nothing listens there, a private Redis included
require('../../lib/logger').createLogger(false);
const callTokens = require('../../lib/call-tokens');
const sessions = require('../../lib/sessions');
const sessionPacks = require('../../lib/session-packs');
const jobSessions = require('../../lib/job-sessions');
const {CountinghouseError} = require('../../lib/countinghouse-error');

describe('sessions 17: the session check at every hop (shared runtime B3, Task 4, server-free)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const ENDED = 'e'.repeat(32);
  const MODULES = {'d-hidden': 'm-hidden', 'd-glob': 'm-glob', 'd-loose': 'm-loose'};
  let overrides;
  let open;
  let hear;
  let issued;
  let saved;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // a hop's input crosses as bytes (lib/hop-input.js)
  const inputBytes = () => { const u = Buffer.from(JSON.stringify({input: {}})); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); };
  const override = (id, pack, value) => {
    if (!overrides.has(id)) overrides.set(id, new Map());
    if (value === undefined) overrides.get(id).delete(pack); else overrides.get(id).set(pack, value);
    hear(id);
  };
  const token = (session, workerId, deviceID = 'd-caller') => {
    const t = callTokens.issue({billingKey: 'k', identityKey: 'id-k', workerId: workerId, deviceID: deviceID, session: session});
    issued.push(t);
    return t;
  };
  // the calling worker hosts d-caller, whose module declared svc/act on every device here
  const DECLARED = new Set(['d-hidden|svc|act', 'd-glob|svc|act', 'd-never|svc|act', 'd-loose|svc|act']);
  const callerOf = (workerId, extra = {}) => Object.assign({workerId: workerId, bindings: {'d-caller': {identity: null, module: 'caller', targets: DECLARED}}}, extra);

  beforeEach(() => {
    saved = {debug: options.debug, workerThread: options.workerThread};
    options.debug = true;   // every access check passes: what is looked at is the session
    issued = [];
    sessions.resetForTests();
    sessionPacks.resetForTests();
    jobSessions.resetForTests();
    const reg = new EventEmitter();
    sessions.attach(reg);
    open = new Map();
    for (const id of [A, B]) { const s = new EventEmitter(); s.id = id; s.client = {status: 'ok', conditions: 'yes', repo: null}; s.notify = () => {}; s.connected = true; s.record = () => {}; s.forget = () => {}; open.set(id, s); reg.emit('session', s); }
    overrides = new Map();
    sessionPacks.configure({
      records: () => [{pack: 'hidden', modules: ['m-hidden']}, {pack: 'glob', modules: ['m-glob']}],
      moduleOf: (deviceID) => (MODULES[deviceID] || null),
      overridesOf: (id) => new Map(overrides.get(id) || []),
      onOverrideChange: (fn) => { hear = fn; },
      openSessions: () => [...open.keys()],
      isOpen: (id) => open.has(id),
      endedPacksOff: (id) => jobSessions.packsOffFor(id),
      allowsOn: () => true,
      shared: () => sessions.shared()
    });
    sessionPacks.setGlobal('glob', true);
    override(A, 'hidden', true);
    override(B, 'glob', false);
  });
  afterEach(() => {
    Object.assign(options, saved);
    for (const t of issued.splice(0)) callTokens.drop(t);
    sessions.resetForTests();
    sessionPacks.resetForTests();
    jobSessions.resetForTests();
  });

  describe('which devices a hop\'s session lists', () => {
    it('a live session: its own view; no session: the global packs; an ended one: the global packs minus its "off"s, or no pack when they are not kept', () => {
      const of = (session, d) => sessionPacks.listsDeviceOfSession(session, d);
      assert.deepStrictEqual([of(A, 'd-hidden'), of(A, 'd-glob'), of(B, 'd-hidden'), of(B, 'd-glob'), of(B, 'd-loose')], [true, true, false, false, true]);
      assert.deepStrictEqual([of(null, 'd-hidden'), of(null, 'd-glob')], [false, true]);
      assert.deepStrictEqual([of(ENDED, 'd-glob'), of(ENDED, 'd-loose')], [false, true], 'not kept: no pack, a module no pack owns still');
      jobSessions.remember('job-1', ENDED);
      jobSessions.sessionEnded(ENDED, null, {packsOff: ['glob']});
      assert.strictEqual(of(ENDED, 'd-glob'), false);
      jobSessions.sessionEnded(ENDED, null, {packsOff: []});
      assert.strictEqual(of(ENDED, 'd-glob'), true);
      assert.strictEqual(of(ENDED, 'd-hidden'), false, 'no this-session pack');
    });

    it('a session\'s end hands its "off"s to its jobs, kept as long as they are', () => {
      jobSessions.remember('job-b', B);
      open.get(B).emit('end');
      open.delete(B);
      assert.deepStrictEqual(jobSessions.packsOffFor(B), ['glob']);
      assert.strictEqual(sessionPacks.listsDeviceOfSession(B, 'd-glob'), false, 'still off for its jobs');
      jobSessions.forget('job-b');
      assert.strictEqual(jobSessions.packsOffFor(B), null);
    });
  });

  describe('the routed hop and the device query (lib/device-manager.js)', () => {
    const DeviceManager = require('../../lib/device-manager');
    const manager = (extra = {}) => Object.assign(Object.create(DeviceManager.prototype), {deviceMap: {}, notifyDeviceLoad: {}, allDevicesLoaded: true, moduleManager: null}, extra);
    const hop = (dm, caller, deviceID, t, msgID) => DeviceManager.prototype.sendInvokeActionMessageToWorker.call(dm, null, null, deviceID, 'svc', 'act', {inputBytes: inputBytes()}, msgID, caller, t);
    const fields = (r) => JSON.stringify({errMsg: r.errMsg, errCode: r.errCode, fault: r.fault, data: r.data});

    it('B\'s hop to the pack it doesn\'t list is answered as one never hosted; A\'s goes past', async () => {
      const replies = [];
      const caller = callerOf(71, {sendActionInvokeReplyToChild: (m) => replies.push(m)});
      const dm = manager({deviceMap: {'d-hidden': {workerId: 72, hostModuleName: 'm-hidden'}}});
      hop(dm, caller, 'd-hidden', token(B, 71), 'h1');
      hop(dm, caller, 'd-never', token(B, 71), 'h2');
      await sleep(50);
      const byId = (id) => replies.find((r) => r.msgID === id);
      assert.strictEqual(byId('h1').errCode, 'DEVICE_NOT_FOUND', JSON.stringify(replies));
      assert.strictEqual(fields(byId('h1')), fields(byId('h2')));
    });

    it('in shared mode a hop to an unloaded module is DEVICE_NOT_FOUND, never MODULE_UNLOADED; outside it, MODULE_UNLOADED as before', () => {
      const dm = manager({moduleManager: {endedStateForDevice: () => ({code: 'MODULE_UNLOADED', name: 'm-hidden'})}});
      assert.strictEqual(dm.missingDeviceErrorForHop('d-hidden').code, 'DEVICE_NOT_FOUND');
      sessions.resetForTests();
      assert.strictEqual(dm.missingDeviceErrorForHop('d-hidden').code, 'MODULE_UNLOADED');
    });

    it('B\'s device query for the pack it doesn\'t list equals one for a device never hosted', async () => {
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
      assert.ok(byId('q3').spec != null, 'A\'s is answered');
    });

    it('a job\'s run into a pack its session doesn\'t list fails as a missing device, and is not retried', () => {
      const got = [];
      let ran = 0;
      const dm = manager({deviceMap: {'d-hidden': {workerId: 74}},
        ensureDeviceState: (d, cb) => (d === 'd-hidden' ? cb(null, dm.deviceMap[d]) : cb(dm.missingDeviceError(d))),
        invokeJobs: () => { ran += 1; }});
      DeviceManager.prototype.invokeJobsNow.call(dm, 'd-hidden', 'svc', 'act', {}, 'j1', (err) => got.push(err), null, {session: B});
      DeviceManager.prototype.invokeJobsNow.call(dm, 'd-never', 'svc', 'act', {}, 'j2', (err) => got.push(err), null, {session: B});
      DeviceManager.prototype.invokeJobsNow.call(dm, 'd-hidden', 'svc', 'act', {}, 'j3', (err) => got.push(err), null, {session: A});
      assert.strictEqual(ran, 1, 'A\'s run only');
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

    it('an announcement on an open channel from B\'s token is refused DEVICE_NOT_FOUND and holds nothing; A\'s is held', () => {
      const refused = [];
      const caller = callerOf(83, {sendPeerAnnounceRefusedToChild: (m) => refused.push(m)});
      const callee = {workerId: 84};
      const b = new PeerChannelBroker({deviceMap: {'d-hidden': callee}});
      b.channelRegistry['ch'] = {callerWM: caller, calleeWM: callee, grants: {}};
      const announce = (t, invokeId) => b.handleAnnouncement({channel: 'ch', invokeId: invokeId, token: t, deviceID: 'd-hidden', serviceID: 'svc', actionName: 'act', epoch: 'e', inputBytes: inputBytes()}, caller);
      announce(token(B, 83), 1);
      assert.deepStrictEqual([refused.length, refused[0] && refused[0].errCode, b.announced.size], [1, 'DEVICE_NOT_FOUND', 0], JSON.stringify(refused));
      announce(token(A, 83), 2);
      assert.deepStrictEqual([refused.length, b.announced.size], [1, 1], JSON.stringify(refused));
    });

    // the reviewer's #340 review, obligation 2: a grant flushes every call queued for the device over the channel,
    // another session's included. Queued B1, A1, B2 for d-hidden (A's pack): B1's request is denied for B1 only,
    // A1 asks again and is granted, the flush sends A1 and B2, and B2's invoke is refused at its announcement
    it('B1, A1, B2 queued: B1 denied alone, A1 granted and held, B2 refused at its announcement; each by its own session', async () => {
      const {methods} = require('../../lib/peer-worker');
      const denied = [];
      const refusedMsgs = [];
      const results = {};
      const b1 = token(B, 87);
      const a1 = token(A, 87);
      const b2 = token(B, 87);
      const callee = {workerId: 88};
      // the calling worker: its peer methods (lib/peer-worker.js) on a stand-in, with the broker's answers wired back
      const w = callerOf(87, {pendingPeerInvokes: {'d-hidden': [b1, a1, b2].map((tk) => ({serviceID: 'svc', actionName: 'act', args: {token: tk, input: {}},
        callback: (err) => { results[tk] = err != null ? err.code : 'ok'; }}))}, peerChannels: {}});
      for (const name of Object.keys(methods)) w[name] = (...a) => methods[name].apply(w, a);
      const b = new PeerChannelBroker({deviceMap: {'d-hidden': callee}, missingDeviceErrorForHop: () => new CountinghouseError('DEVICE_NOT_FOUND')});
      const asked = [];
      w.requestPeerChannel = (m) => asked.push(m.token);
      w.sendPeerChannelDenyToChild = (m) => { denied.push(m); w.onPeerChannelDeny(m); };
      b.handleRequest({targetDeviceID: 'd-hidden', token: b1}, w);
      await sleep(50);
      assert.deepStrictEqual([results[b1], asked], ['DEVICE_NOT_FOUND', [a1]], JSON.stringify(denied));
      // A1's request is granted (the grant itself is composition 18's): the channel, and the flush
      const invokes = new Map();
      let next = 0;
      w.peerChannels[88] = {epoch: 'e', invoke: (deviceID, serviceID, actionName, input, timeoutMs, cb, tk) => {
        const invokeId = next++;
        invokes.set(invokeId, {cb, tk});
        b.handleAnnouncement({channel: '87:88', invokeId: invokeId, token: tk, deviceID: deviceID, serviceID: serviceID, actionName: actionName, epoch: 'e', inputBytes: inputBytes()}, w);
      }, fail: (invokeId, err) => invokes.get(invokeId).cb(err)};
      b.channelRegistry['87:88'] = {callerWM: w, calleeWM: callee, grants: {}};
      w.sendPeerAnnounceRefusedToChild = (m) => { refusedMsgs.push(m); w.onPeerAnnounceRefused(m); };
      w.flushPendingPeerInvokes('d-hidden', 88, null);
      assert.deepStrictEqual([...invokes.values()].map((v) => v.tk), [a1, b2], 'both sent over the channel, each with its own token');
      assert.deepStrictEqual([results[b2], results[a1], b.announced.size], ['DEVICE_NOT_FOUND', undefined, 1], JSON.stringify(refusedMsgs));
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

    it('a match whose session left the pack since its announcement runs no handler: refused DEVICE_NOT_FOUND', () => {
      const replies = [];
      const caller = callerOf(85);
      const callee = {workerId: 86, sendPeerMeteringReplyToChild: (m) => replies.push(m)};
      const b = new PeerChannelBroker({deviceMap: {'d-hidden': callee}});
      b.channelRegistry['ch'] = {callerWM: caller, calleeWM: callee, grants: {}};
      const now = Date.now();
      b.announced.set('ch/1', {token: token(A, 85), workerId: 85, channel: 'ch', at: now, deadline: now + 60000, epoch: 'e', invokeId: 1, bytes: 2, limits: null,
        session: A, target: {deviceID: 'd-hidden', serviceID: 'svc', actionName: 'act'}, inputBytes: inputBytes()});
      override(A, 'hidden', false);
      b.serveMatched({channel: 'ch', invokeId: 1}, 'm1', callee, 'ch/1');
      assert.deepStrictEqual([replies.length, replies[0] && replies[0].errCode], [1, 'DEVICE_NOT_FOUND'], JSON.stringify(replies));
    });
  });
});
