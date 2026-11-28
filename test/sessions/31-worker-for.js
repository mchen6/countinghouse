'use strict';
// R1 Task 5: the two places a hop into a per-session module meets its
// session, each on its own (in the spawned test, session-runtime 10, either
// one alone stops a hop of a session that has left, so neither shows there
// by itself): DeviceManager.prototype.workerFor, which every dispatch site
// asks for the worker, and the device query a worker's ctx.call makes first,
// which a record answers from its own spec. Server-free: a device manager
// with a per-session module's record, fake session workers, real call tokens.
const assert = require('assert');
const DeviceManager = require('../../lib/device-manager');
const {SessionModuleRecord} = require('../../lib/session-module-record');
const callTokens = require('../../lib/call-tokens');
const callAddress = require('../../lib/call-address');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const D = callAddress.deviceIDForName('per-session-module');
const CALLER = callAddress.deviceIDForName('ps-caller');
const SVC = 'urn:countinghouse-test:serviceID:stateService';

describe('sessions 31: a per-session module\'s worker is its call\'s session\'s (R1 Task 5)', () => {
  const sessions = require('../../lib/sessions');
  let realGet;
  let realLive;
  let realAccess;
  let live;
  let dm;
  let record;
  before(() => {
    require('../../lib/logger').createLogger();
    // nothing hidden: whatever a file before this one in the same process
    // configured, every device is listed here, so what's tested is the
    // record's own path (run in one process, as CI runs a folder)
    require('../../lib/module-visibility').resetForTests();
    realGet = sessions.get;
    realLive = sessions.live;
    sessions.get = (id) => (live.has(id) ? {id} : null);
    sessions.live = (id) => live.has(id);
    realAccess = DeviceManager.prototype.replyAfterQueryAccessCheck;
    // the access check granted: what is under test is what comes after it
    DeviceManager.prototype.replyAfterQueryAccessCheck = function(wm, msgID, deviceID, identity, onGranted) { return onGranted(); };
  });
  after(() => {
    sessions.get = realGet;
    sessions.live = realLive;
    DeviceManager.prototype.replyAfterQueryAccessCheck = realAccess;
  });
  beforeEach(() => {
    live = new Set([A, B]);
    record = new SessionModuleRecord({name: 'per-session-module', version: '1.0.0', modulePath: '/m', moduleSpec: null});
    record.deviceList[D] = {device: {friendlyName: 'per-session-module'}};
    dm = Object.create(DeviceManager.prototype);
    dm.deviceMap = {[D]: record};
    dm.moduleManager = {endedStateForDevice: () => null,
      sessionWorkers: {get: (name, sid, cb) => cb(null, {name, sid})}};
  });
  const workerFor = (sid, opts) => new Promise((resolve) => dm.workerFor(D, sid, (err, wm) => resolve({err, wm}), opts));

  it('workerFor: each session its own worker; a session that has left, or none, is a device not hosted (a hop\'s without the ID)', async () => {
    assert.deepStrictEqual((await workerFor(A)).wm, {name: 'per-session-module', sid: A});
    assert.deepStrictEqual((await workerFor(B, {hop: true})).wm, {name: 'per-session-module', sid: B});
    live.delete(A);
    const gone = await workerFor(A, {hop: true});
    assert.strictEqual(gone.err.code, 'DEVICE_NOT_FOUND');
    assert.ok(!gone.err.message.includes(D), gone.err.message);
    // (no session at all: a REST call, which only a session's MCP calls can
    // stand in for; REST's one answer for a device it can't use, naming
    // nothing: #482's high, 3)
    assert.strictEqual((await workerFor(null)).err.code, 'MODULE_NOT_LISTED');
    assert.ok(!(await workerFor(null)).err.message.includes(D), 'the one answer names no device');
  });

  // the review of #367's /code-review: a spawn given up on because the
  // session ended says MODULE_UNLOADED, as an unload's does; the session gone,
  // the answer is a device not hosted, never the module's state
  it('workerFor: a spawn given up on (MODULE_UNLOADED) is the module\'s state while the session is live; a device not hosted once it has ended', async () => {
    dm.moduleManager.endedStateForDevice = () => ({code: 'MODULE_RESTARTING', name: 'per-session-module'});
    const givenUp = () => Object.assign(new Error('given up'), {code: 'MODULE_UNLOADED'});
    dm.moduleManager.sessionWorkers.get = (n, s, cb) => cb(givenUp());
    assert.strictEqual((await workerFor(A)).err.code, 'MODULE_RESTARTING', 'live: the device\'s ended state');
    dm.moduleManager.sessionWorkers.get = (n, s, cb) => { live.delete(s); cb(givenUp()); };
    const ended = await workerFor(A, {hop: true});
    assert.strictEqual(ended.err.code, 'DEVICE_NOT_FOUND', JSON.stringify(ended.err));
    assert.ok(!ended.err.message.includes(D), ended.err.message);
    assert.strictEqual((await workerFor(B)).err.code, 'DEVICE_NOT_FOUND', 'a client\'s call too');
  });

  // the reviewer's high review of #398: the pool's refusal of a session that
  // ended meanwhile answers byte for byte as an unknown device does
  it('workerFor: the pool refusing an ended session is exactly an unknown device: with the ID for a call, without for a hop', async () => {
    dm.moduleManager.sessionWorkers.get = (n, s, cb) => cb(Object.assign(new Error('ended'), {code: 'DEVICE_NOT_FOUND'}));
    const call = await workerFor(A);
    const asUnknown = new (require('../../lib/countinghouse-error').CountinghouseError)('DEVICE_NOT_FOUND', D);
    assert.deepStrictEqual([call.err.code, call.err.message], [asUnknown.code, asUnknown.message]);
    const hop = await workerFor(A, {hop: true});
    assert.strictEqual(hop.err.code, 'DEVICE_NOT_FOUND');
    assert.ok(!hop.err.message.includes(D), hop.err.message);
  });

  it('workerFor: a module closing starts no worker; busy and suspended pass through', async () => {
    record.closing = true;
    assert.strictEqual((await workerFor(A)).err.code, 'DEVICE_NOT_FOUND');
    record.closing = false;
    dm.moduleManager.sessionWorkers.get = (n, s, cb) => cb(Object.assign(new Error('busy'), {code: 'SESSION_WORKERS_BUSY'}));
    assert.strictEqual((await workerFor(A)).err.code, 'SESSION_WORKERS_BUSY');
  });

  // the review of #367 (1): a start's own error can name the session and
  // its partition's path, and a hop's error goes to the calling module, a
  // job's into its history
  it('workerFor: a worker that could not start is logged, and answered with a fixed text naming no session and no path', async () => {
    const LOG = require('../../lib/logger');
    const logged = [];
    const realE = LOG.E;
    LOG.E = (e) => logged.push(e);
    const path = `/h/module_data/per-session-module/sessions/${A}/data`;
    dm.moduleManager.sessionWorkers.get = (n, s, cb) => cb(Object.assign(new Error(`Module load failed: per-session-module file broker: ENOSPC: mkdir '${path}'`), {code: 'LOAD_MODULE_FAIL'}));
    try {
      for (const opts of [undefined, {hop: true}]) {
        const {err} = await workerFor(A, opts);
        assert.strictEqual(err.code, 'SESSION_WORKER_NOT_STARTED');
        assert.ok(!err.message.includes(A) && !err.message.includes('/h/'), err.message);
      }
    } finally {
      LOG.E = realE;
    }
    assert.strictEqual(logged.length, 2);
    assert.ok(String(logged[0].message).includes(path), 'the log has the reason');
    // busy, suspended, a device not hosted: as they are
    for (const code of ['SESSION_WORKERS_BUSY', 'MODULE_SESSION_PAUSED', 'DEVICE_NOT_FOUND']) {
      dm.moduleManager.sessionWorkers.get = (n, s, cb) => cb(Object.assign(new Error(code), {code}));
      assert.strictEqual((await workerFor(A)).err.code, code);
    }
  });

  // the review of #367 (2): as the B3 check's refusal is, so a job whose
  // session has ended (or has none) is not retried in shared mode
  // (a run with no session at all: the one answer a sessionless call gets,
  // MODULE_NOT_LISTED, not retried; #482's high, round 2, 6)
  it('a job\'s run whose session has ended is a device not hosted, tagged after discovery; one with none is the one answer; neither retried', async () => {
    dm.allDevicesLoaded = true;
    const {notRetried} = require('../../lib/job-control-common');
    const realShared = sessions.shared;
    sessions.shared = () => true;
    try {
      live.delete(A);
      const ended = await new Promise((resolve) => dm.invokeJobsNow(D, SVC, 'touch', {}, 'j1', (e) => resolve(e), () => false, {session: A}));
      assert.strictEqual(ended.code, 'DEVICE_NOT_FOUND');
      assert.strictEqual(ended.afterDiscovery, true);
      assert.strictEqual(notRetried(ended.code, ended), true);
      const none = await new Promise((resolve) => dm.invokeJobsNow(D, SVC, 'touch', {}, 'j1', (e) => resolve(e), () => false, {}));
      assert.strictEqual(none.code, 'MODULE_NOT_LISTED');
      assert.strictEqual(notRetried(none.code, none), true);
    } finally {
      sessions.shared = realShared;
    }
  });

  // the review of #367 (3a): the hop site itself, after a granted access
  // check: workerFor with the hop token's session and {hop: true}
  it('the hop: after the access check, a session that has left gets DEVICE_NOT_FOUND with no ID; a failed start, no session id', () => {
    const authPath = require.resolve('../../lib/user-auth');
    const saved = require.cache[authPath];
    require.cache[authPath] = {id: authPath, filename: authPath, loaded: true, exports: (a, b, c, d, e, f, g, cb) => cb(null, {})};
    // (the record's composition verdict decided, as every device's is once startup's verifications are: a hop into one with none
    // waits for it, before any session worker is picked)
    record.bindings[D] = {identity: null, module: 'per-session-module', targets: new Set()};
    const replies = [];
    const caller = {workerId: 42, sendActionInvokeReplyToChild: (m) => replies.push(m),
      bindings: {[CALLER]: {identity: 'i', module: 'ps-caller', targets: new Set([`${D}|${SVC}|touch`])}}};
    const asked = [];
    dm.moduleManager.sessionWorkers.get = (n, s, cb) => { asked.push(s); cb(Object.assign(new Error(`mkdir '/h/sessions/${s}'`), {code: 'EACCES'})); };
    const hop = (session, msgID) => dm.sendInvokeActionMessageToWorker(null, null, D, SVC, 'touch', {}, msgID,
      caller, callTokens.issue({billingKey: 'k', workerId: 42, deviceID: CALLER, session}));
    const LOG = require('../../lib/logger');
    const realE = LOG.E;
    LOG.E = () => {};
    try {
      live.delete(B);
      hop(B, 1);
      const gone = replies.pop();
      assert.strictEqual(gone.errCode, 'DEVICE_NOT_FOUND', JSON.stringify(gone));
      assert.ok(!String(gone.errMsg).includes(D), gone.errMsg);
      assert.deepStrictEqual(asked, [], 'no worker asked for a session that has left');
      hop(A, 2);
      const failed = replies.pop();
      assert.deepStrictEqual(asked, [A], 'the hop token\'s own session');
      assert.strictEqual(failed.errCode, 'SESSION_WORKER_NOT_STARTED', JSON.stringify(failed));
      assert.ok(!String(failed.errMsg).includes(A) && !String(failed.errMsg).includes('/h/'), failed.errMsg);
    } finally {
      LOG.E = realE;
      if (saved != null) require.cache[authPath] = saved; else delete require.cache[authPath];
    }
  });

  it('the device query: a live session\'s call gets the record\'s spec, starting no worker; one that has left gets DEVICE_NOT_FOUND, no ID', () => {
    const replies = [];
    const caller = {workerId: 41, sendDeviceQueryReplyToChild: (m) => replies.push(m),
      bindings: {[CALLER]: {identity: 'i', module: 'ps-caller', targets: new Set([`${D}|${SVC}|touch`])}}};
    let started = 0;
    dm.moduleManager.sessionWorkers.get = (n, s, cb) => { started++; cb(null, {}); };
    const tokenOf = (session) => callTokens.issue({billingKey: 'k', workerId: 41, deviceID: CALLER, session});
    dm.queryDeviceForChild(D, 1, caller, {token: tokenOf(A)});
    assert.deepStrictEqual(replies.pop(), {msgID: 1, errMsg: null, spec: record.deviceList[D]});
    live.delete(B);
    dm.queryDeviceForChild(D, 2, caller, {token: tokenOf(B)});
    const refused = replies.pop();
    assert.strictEqual(refused.errCode, 'DEVICE_NOT_FOUND', JSON.stringify(refused));
    assert.strictEqual(refused.spec, null);
    assert.ok(!String(refused.errMsg).includes(D), refused.errMsg);
    assert.strictEqual(started, 0, 'a query starts no worker');
  });

  it('the device query: a session that ends, or a record unloaded, during the access check gets no spec', () => {
    const replies = [];
    const caller = {workerId: 41, sendDeviceQueryReplyToChild: (m) => replies.push(m),
      bindings: {[CALLER]: {identity: 'i', module: 'ps-caller', targets: new Set([`${D}|${SVC}|touch`])}}};
    const tokenOf = (session) => callTokens.issue({billingKey: 'k', workerId: 41, deviceID: CALLER, session});
    let granted = null;
    // held, not answered at once (before()'s stand-in): the gap a round trip makes
    const grantedAtOnce = DeviceManager.prototype.replyAfterQueryAccessCheck;
    DeviceManager.prototype.replyAfterQueryAccessCheck = function(wm, msgID, deviceID, identity, onGranted) { granted = onGranted; };
    try {
      dm.queryDeviceForChild(D, 3, caller, {token: tokenOf(A)});
      live.delete(A);
      granted();
      assert.strictEqual(replies.pop().errCode, 'DEVICE_NOT_FOUND', 'the session ended meanwhile');
      dm.queryDeviceForChild(D, 4, caller, {token: tokenOf(B)});
      delete dm.deviceMap[D];
      granted();
      const gone = replies.pop();
      assert.strictEqual(gone.spec, null, JSON.stringify(gone));
      assert.ok(gone.errCode != null, JSON.stringify(gone));
    } finally {
      DeviceManager.prototype.replyAfterQueryAccessCheck = grantedAtOnce;
    }
  });
});
