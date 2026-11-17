'use strict';
// R1 Task 5, the Reviewer's peer-channel ruling: the runtime never opens a
// direct peer channel to a per-session module, under any profile. A
// caller's channels are keyed by device alone, so one opened under session
// B's call would carry session A's hop into B's worker. On the shared
// runtime peer channels are off anyway (the single-identity profile); this
// holds the guarantee in place without that rule, in-process (the pattern
// of sessions 16):
// - the broker answers a request for one with a grant-less route: 'main',
//   after the access check;
// - the caller's worker then sends every call for that device, the queued
//   ones and every later one, on the main-thread route, each with its own
//   token (where DeviceManager.workerFor picks the session's worker);
// - a backstop: an announcement on a channel to a session's worker by a
//   call of another session is refused.
const assert = require('assert');
const {methods} = require('../../lib/peer-worker');
const callTokens = require('../../lib/call-tokens');
const {SessionModuleRecord} = require('../../lib/session-module-record');
const PeerChannelBroker = require('../../lib/peer-channel-broker');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('sessions 32: no direct peer channel to a per-session module (R1 Task 5)', () => {
  const issued = [];
  const issue = (o) => { const t = callTokens.issue(o); issued.push(t); return t; };
  afterEach(() => { for (const t of issued.splice(0)) callTokens.drop(t); });
  before(() => require('../../lib/logger').createLogger());

  it('the broker: a request for a per-session module is answered route: main, after the access check, with no grant', async () => {
    const told = [];
    const requester = {workerId: 41, sendPeerChannelDenyToChild: (m) => told.push(['deny', m]), sendPeerChannelGrantToChild: (m) => told.push(['grant', m]),
      bindings: {'d-caller': {identity: null, module: 'caller', targets: new Set(['d-ps|svc|touch'])}}};
    const record = new SessionModuleRecord({name: 'ps', version: '1.0.0', modulePath: '/m', moduleSpec: null});
    const b = new PeerChannelBroker({deviceMap: {'d-ps': record}, missingDeviceErrorForHop: () => { throw new Error('not missing'); }});
    const token = issue({billingKey: 'k', workerId: 41, deviceID: 'd-caller', session: A});
    const options = require('../../lib/cli-options');
    const savedDebug = options.debug;
    options.debug = true;   // the access check passes: what is looked at is what comes after it
    try {
      b.handleRequest({targetDeviceID: 'd-ps', token}, requester);
      await sleep(30);
    } finally {
      options.debug = savedDebug;
    }
    assert.strictEqual(told.length, 1, JSON.stringify(told));
    assert.strictEqual(told[0][0], 'deny');
    assert.strictEqual(told[0][1].route, 'main');
    assert.strictEqual(Object.keys(b.channelRegistry || {}).length, 0, 'no channel');
  });

  // the review of #367 (3b): the route is told only after the access check.
  // The broker holds user-auth from its load, so a broker loaded afresh
  // over one that refuses.
  it('the broker: a caller the access check refuses gets the access error, never route: main', async () => {
    const authPath = require.resolve('../../lib/user-auth');
    const brokerPath = require.resolve('../../lib/peer-channel-broker');
    const savedAuth = require.cache[authPath];
    const savedBroker = require.cache[brokerPath];
    const CountinghouseError = require('../../lib/countinghouse-error').CountinghouseError;
    require.cache[authPath] = {id: authPath, filename: authPath, loaded: true, exports: (a, b, c, d, e, f, g, cb) => cb(new CountinghouseError('DENY_DEVICE_ACCESS'))};
    delete require.cache[brokerPath];
    const told = [];
    try {
      const Refusing = require('../../lib/peer-channel-broker');
      const requester = {workerId: 43, sendPeerChannelDenyToChild: (m) => told.push(['deny', m]), sendPeerChannelGrantToChild: (m) => told.push(['grant', m]),
        bindings: {'d-caller': {identity: null, module: 'caller', targets: new Set(['d-ps|svc|touch'])}}};
      const record = new SessionModuleRecord({name: 'ps', version: '1.0.0', modulePath: '/m', moduleSpec: null});
      const b = new Refusing({deviceMap: {'d-ps': record}, missingDeviceErrorForHop: () => { throw new Error('not missing'); }});
      b.handleRequest({targetDeviceID: 'd-ps', token: issue({billingKey: 'k', workerId: 43, deviceID: 'd-caller', session: A})}, requester);
      await sleep(30);
    } finally {
      if (savedAuth != null) require.cache[authPath] = savedAuth; else delete require.cache[authPath];
      require.cache[brokerPath] = savedBroker;
    }
    assert.strictEqual(told.length, 1, JSON.stringify(told));
    assert.strictEqual(told[0][0], 'deny');
    assert.strictEqual(told[0][1].errCode, 'DENY_DEVICE_ACCESS', JSON.stringify(told[0][1]));
    assert.strictEqual(told[0][1].route, undefined, 'no route before the access check');
  });

  // a caller worker's peer state, as sessions 16 builds it
  function worker() {
    const viaMain = [];
    const asked = [];
    const w = {pendingPeerInvokes: {}, peerChannels: {}, peerDeviceWorkerMap: {}};
    for (const name of Object.keys(methods)) w[name] = (...a) => methods[name].apply(w, a);
    w.requestPeerChannel = (m) => asked.push(m.token);
    const call = (token) => w.invokeActionViaPeerChannel('d-ps', 'svc', 'touch', {token, input: {}}, () => {}, () => viaMain.push(token));
    return {w, viaMain, asked, call};
  }

  it('the worker: route: main sends every queued call on the main route, each with its own token, and every later one too', () => {
    const {w, viaMain, asked, call} = worker();
    call('tA1');
    call('tB1');   // queued behind A's request
    call('tA2');
    assert.deepStrictEqual(asked, ['tA1'], 'one request, with the first call\'s token');
    w.onPeerChannelDeny({targetDeviceID: 'd-ps', route: 'main', errMsg: 'routed', errCode: 'PEER_CHANNEL_DENIED'});
    assert.deepStrictEqual(viaMain, ['tA1', 'tB1', 'tA2'], 'each queued call, in order, with its own token');
    assert.strictEqual(w.pendingPeerInvokes['d-ps'], undefined);
    call('tB2');
    assert.deepStrictEqual(viaMain, ['tA1', 'tB1', 'tA2', 'tB2'], 'a later call goes straight to the main route');
    assert.deepStrictEqual(asked, ['tA1'], 'and asks for no channel again');
  });

  it('the queued race: calls arriving while the request is out, and right after the answer, each go on the main route with their own token', async () => {
    const {w, viaMain, asked, call} = worker();
    call('tA1');
    const racing = [sleep(0).then(() => call('tB1')), sleep(1).then(() => call('tA2'))];
    await sleep(5);
    w.onPeerChannelDeny({targetDeviceID: 'd-ps', route: 'main', errMsg: 'routed', errCode: 'PEER_CHANNEL_DENIED'});
    racing.push(Promise.resolve().then(() => call('tB2')));
    await Promise.all(racing);
    assert.deepStrictEqual(viaMain.slice().sort(), ['tA1', 'tA2', 'tB1', 'tB2']);
    assert.strictEqual(new Set(viaMain).size, 4, 'each once');
    assert.deepStrictEqual(asked, ['tA1']);
  });

  it('a backstop: an announcement on a channel to session A\'s worker by session B\'s call is refused', () => {
    const refused = [];
    const callerWM = {workerId: 51, sendPeerAnnounceRefusedToChild: (m) => refused.push(m.errCode),
      bindings: {'d-caller': {identity: null, module: 'caller', targets: new Set(['d-ps|svc|touch'])}}};
    const calleeWM = {workerId: 52, hostSession: A};
    const b = new PeerChannelBroker({deviceMap: {'d-ps': calleeWM}});
    b.channelRegistry = {ch1: {callerWM, calleeWM}};
    const token = issue({billingKey: 'k', workerId: 51, deviceID: 'd-caller', session: B});
    b.handleAnnouncement({channel: 'ch1', invokeId: 1, token, deviceID: 'd-ps', serviceID: 'svc', actionName: 'touch', epoch: 'e', input: new Uint8Array(2)}, callerWM);
    assert.deepStrictEqual(refused, ['PEER_NOT_GRANTED']);
  });
});
