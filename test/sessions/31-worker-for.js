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
  let realAccess;
  let live;
  let dm;
  let record;
  before(() => {
    require('../../lib/logger').createLogger(false);
    realGet = sessions.get;
    sessions.get = (id) => (live.has(id) ? {id} : null);
    realAccess = DeviceManager.prototype.replyAfterQueryAccessCheck;
    // the access check granted: what is under test is what comes after it
    DeviceManager.prototype.replyAfterQueryAccessCheck = function(wm, msgID, deviceID, identity, onGranted) { return onGranted(); };
  });
  after(() => {
    sessions.get = realGet;
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
    assert.strictEqual((await workerFor(null)).err.code, 'DEVICE_NOT_FOUND');
    assert.ok((await workerFor(null)).err.message.includes(D), 'a client\'s call names the device it asked for, as for one unknown');
  });

  it('workerFor: a module closing starts no worker; busy and suspended pass through', async () => {
    record.closing = true;
    assert.strictEqual((await workerFor(A)).err.code, 'DEVICE_NOT_FOUND');
    record.closing = false;
    dm.moduleManager.sessionWorkers.get = (n, s, cb) => cb(Object.assign(new Error('busy'), {code: 'SESSION_WORKERS_BUSY'}));
    assert.strictEqual((await workerFor(A)).err.code, 'SESSION_WORKERS_BUSY');
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
});
