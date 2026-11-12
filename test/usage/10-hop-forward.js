// Step 3c at the main thread's entry points (reviewer, 2026-11-11; the review
// of 3c): a call is granted to the worker it is actually sent to (the
// gateway's invokeAction, a task's invokeJobs); invokeforeignaction checks a
// hop's usageCall only once user-auth has let the hop through (so a refusal
// reveals nothing about devices the caller may not use), grants the callee's
// worker just before the send and releases it when the hop answers; a direct
// peer hop gives the callee only {input}. Driven directly: fake workers and a
// user-auth stub, restored after.
const assert = require('assert');
const path = require('path');
const {MessageChannel} = require('worker_threads');

const LIB = path.join(__dirname, '..', '..', 'lib');
const authPath = require.resolve(path.join(LIB, 'user-auth'));
let auth = 'allow';
let savedAuth;
let lastSession = null;
let duringAuth = null; // runs between the auth call and its answer (a reload)

describe('usage: the main thread grants and checks usage call ids where calls are sent', () => {
  let DeviceManager, usage, CountinghouseError;
  before(() => {
    require(path.join(LIB, 'cli-options')).setOptions({redisUrl: 'redis://127.0.0.1:9749', workerThread: true});
    require(path.join(LIB, 'logger')).createLogger(false);
    ({CountinghouseError} = require(path.join(LIB, 'countinghouse-error')));
    savedAuth = require.cache[authPath];
    require.cache[authPath] = {id: authPath, filename: authPath, loaded: true,
      exports: (req, res, deviceID, appKey, serviceID, actionName, localCB, cb) => {
        if (duringAuth != null) { const f = duringAuth; duringAuth = null; f(); }
        if (auth !== 'allow') return cb(new CountinghouseError('DEVICE_ACCESS_DENIED'));
        // As the real session: its callback is localCB (also what its timer
        // calls when it fires), and the timer's callback is bound to the session.
        lastSession = {callback: localCB, setDeviceTimer(wm, fn) { fn(null, wm, null); }};
        return cb(null, lastSession);
      }};
    DeviceManager = require(path.join(LIB, 'device-manager'));
    ({usage} = require(path.join(LIB, 'usage', 'runtime')));
  });
  const begun = [];
  after(() => {
    if (savedAuth != null) require.cache[authPath] = savedAuth; else delete require.cache[authPath];
    auth = 'allow';
    duringAuth = null;
    // Leave no open call in the runtime's recorder, and no options of this file's.
    for (const call of begun) { try { usage().recordOut(call, {tool: 't', bytes: 0, lines: 0, ms: 0, outcome: 'ok'}); } catch (e) { /* already finished */ } }
    require(path.join(LIB, 'cli-options')).setOptions({});
  });

  function workers() {
    const sent = [];
    const replies = [];
    const callee = {workerId: 2, sendInvokeActionMessage: (m, cb) => sent.push({m, cb})};
    const caller = {workerId: 1, sendActionInvokeReplyToChild: (m) => replies.push(m)};
    return {sent, replies, callee, caller, dm: {deviceMap: {d2: callee}}};
  }
  const forward = (w, args) => DeviceManager.prototype.sendInvokeActionMessageToWorker.call(w.dm, 'k', 'k', 'd2', 'svc', 'act', args, 'm1', w.caller);
  const begin = () => { const c = usage().beginCall({pack: 'p', module: 'p', tool: 't', caller: 'u_a'}); begun.push(c); return c; };

  it('the gateway\'s call is granted to the worker invokeAction sends it to', () => {
    const call = begin();
    const device = {workerId: 41, sendInvokeActionMessage: () => {}};
    const session = {setDeviceTimer: (d, fn) => fn.call({callback: () => {}}, null, d, null)};
    DeviceManager.prototype.invokeAction.call({}, device, 'd1', 'svc', 'act', {input: {}, usageCall: call}, session);
    assert.deepStrictEqual([usage().ownsCall(call, 41), usage().ownsCall(call, 42)], [true, false]);
  });

  it('a task run\'s call is granted to the worker invokeJobs sends it to', () => {
    const call = begin();
    const device = {workerId: 43, sendInvokeActionMessage: () => {}};
    DeviceManager.prototype.invokeJobs.call({}, device, 'd1', 'svc', 'act', {}, 'j1', () => {}, {usageCall: call});
    assert.strictEqual(usage().ownsCall(call, 43), true);
  });

  it('a forged usageCall is refused USAGE_CALL_FOREIGN once auth lets the hop through, and nothing is sent or granted', () => {
    const call = begin();
    usage().grantCall(call, 9); // someone else's
    for (const forged of [call, 424242]) {
      const w = workers();
      forward(w, {input: {}, usageCall: forged});
      assert.deepStrictEqual([w.sent.length, w.replies.length], [0, 1]);
      assert.strictEqual(w.replies[0].errCode, 'USAGE_CALL_FOREIGN', JSON.stringify(w.replies[0]));
    }
    assert.strictEqual(usage().ownsCall(call, 2), false);
  });

  it('a hop auth refuses gets the access error whatever its usageCall: nothing about the device is told', () => {
    auth = 'deny';
    try {
      const w = workers();
      forward(w, {input: {}, usageCall: 424242});
      assert.deepStrictEqual([w.sent.length, w.replies.length], [0, 1]);
      assert.strictEqual(w.replies[0].errCode, 'DEVICE_ACCESS_DENIED');
    } finally { auth = 'allow'; }
  });

  it('an owned usageCall is forwarded unchanged, the callee owns it while the hop runs, and not after it answers', () => {
    const call = begin();
    usage().grantCall(call, 1);
    const w = workers();
    forward(w, {input: {v: 1}, usageCall: call});
    assert.strictEqual(w.sent.length, 1);
    assert.deepStrictEqual(w.sent[0].m.args, {input: {v: 1}, usageCall: call});
    assert.strictEqual(usage().ownsCall(call, 2), true, 'the part may call on under it');
    w.sent[0].cb(null, {output: {}});
    assert.strictEqual(usage().ownsCall(call, 2), false, 'released when the hop answers');
    assert.strictEqual(usage().ownsCall(call, 1), true, 'the caller keeps its own');
  });

  it('a hop whose timer fires keeps the callee\'s grant until the callee answers: its next hop under the open call is forwarded (review of #90, 1)', () => {
    const call = begin();
    usage().grantCall(call, 1);
    const w = workers();
    forward(w, {input: {}, usageCall: call});
    lastSession.callback(new CountinghouseError('DEVICE_TIMEOUT')); // the hop's timer fires
    assert.strictEqual(usage().ownsCall(call, 2), true, 'the callee is still running under the open call');
    const w2 = workers();
    w2.dm.deviceMap = {d2: {workerId: 3, sendInvokeActionMessage: (m, cb) => w2.sent.push({m, cb})}};
    const fromCallee = {workerId: 2, sendActionInvokeReplyToChild: (m) => w2.replies.push(m)};
    DeviceManager.prototype.sendInvokeActionMessageToWorker.call(w2.dm, 'k', 'k', 'd2', 'svc', 'act', {input: {}, usageCall: call}, 'm2', fromCallee);
    assert.deepStrictEqual([w2.sent.length, w2.replies.length], [1, 0], JSON.stringify(w2.replies));
    w.sent[0].cb(null, {output: {}}); // the first callee answers at last
    assert.strictEqual(usage().ownsCall(call, 2), false);
  });

  it('a callee replaced while auth runs gets the hop and the grant, not the stale worker; a callee gone gets the missing-device answer (review of #90, 2)', () => {
    const call = begin();
    usage().grantCall(call, 1);
    const w = workers();
    const fresh = {workerId: 5, sendInvokeActionMessage: (m, cb) => w.sent.push({to: 5, m, cb})};
    duringAuth = () => { w.dm.deviceMap.d2 = fresh; };
    forward(w, {input: {}, usageCall: call});
    assert.deepStrictEqual(w.sent.map((s) => s.to), [5]);
    assert.deepStrictEqual([usage().ownsCall(call, 5), usage().ownsCall(call, 2)], [true, false]);
    const w2 = workers();
    w2.dm.missingDeviceErrorForHop = () => new CountinghouseError('DEVICE_NOT_FOUND');
    duringAuth = () => { delete w2.dm.deviceMap.d2; };
    forward(w2, {input: {}, usageCall: call});
    assert.deepStrictEqual([w2.sent.length, w2.replies.length], [0, 1]);
    assert.strictEqual(w2.replies[0].errCode, 'DEVICE_NOT_FOUND');
  });

  it('a hop stating a call that has finished goes on without the id, so nothing is recorded under it', () => {
    const call = begin();
    usage().grantCall(call, 1);
    usage().recordOut(call, {tool: 't', bytes: 1, lines: 1, ms: 1, outcome: 'ok'});
    const w = workers();
    forward(w, {input: {}, usageCall: call});
    assert.deepStrictEqual([w.sent.length, w.replies.length], [1, 0]);
    assert.deepStrictEqual(w.sent[0].m.args, {input: {}});
  });

  it('a hop with no usageCall is forwarded as it always was', () => {
    const w = workers();
    forward(w, {input: {}});
    assert.deepStrictEqual([w.sent.length, w.replies.length], [1, 0]);
  });

  let peerRestore = null;
  afterEach(() => { if (peerRestore != null) { peerRestore(); peerRestore = null; } });

  it('a direct peer hop gives the callee only {input}: no usageCall crosses it', (done) => {
    const CHUtil = require(path.join(LIB, 'countinghouse-util'));
    const ci = CHUtil.ci;
    const seen = [];
    CHUtil.ci = {invokeDeviceAction: (d, s, a, args) => { seen.push(args); finish(); }};
    const ch = new MessageChannel();
    peerRestore = () => { CHUtil.ci = ci; ch.port1.close(); };
    const self = {peerChannels: {}, workerMessage: {sendPeerMeteringRequestToParent: () => {}}};
    DeviceManager.prototype.onPeerChannelOpen.call(self, {callerWorkerId: 1, appKey: 'k', targetDeviceID: 'd2', port: ch.port2});
    ch.port1.postMessage({id: 1, command: 'peer-invoke', deviceID: 'd2', serviceID: 'svc', actionName: 'act', input: {v: 1}, billingKey: 'k', usageCall: 5});
    function finish() {
      try {
        assert.deepStrictEqual(seen, [{input: {v: 1}}]);
        done();
      } catch (e) { done(e); }
    }
  });
});
