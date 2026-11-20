'use strict';
// #482's high, round 2: a runtime-issued error that LEAVES A MODULE HANDLER
// is the module's answer (kind module, 500), whatever its code's row says,
// except the settings gate's claims (SETTING_REQUIRED, SETTING_NOT_READY),
// which a handler passes through as the end caller's. True by construction
// at the one boundary every case crosses (CountinghouseError.answerable, the
// copy handler-answer makes), so it holds for every refusal a composer gets
// from ctx.call and ctx.serviceClient, before the invoke or from the part.
// Tested through a real buildCtx, its ctx.call and ctx.serviceClient, and
// the real handler-answer path (Service.doActionCall), with only the
// main-thread service client stubbed. Also: the retry hint is the limiters'
// alone, private and clamped; the mark crosses a reply, a task's failure
// record and a job's public record; a crash fallback drops it.
const assert = require('assert');
require('../../lib/cli-options').setOptions({workerThread: false});
const {CountinghouseError, statusOf, kindOf, setRetryAfter, retryAfterOf, fromHandler} = require('../../lib/countinghouse-error');
const {CODES} = require('../../lib/error-catalogue');
const {buildCtx} = require('../../lib/handler-ctx');
const Service = require('../../lib/service');

const CALLEE = 'compose-callee/calleeService.double';
// (single-thread mode checks the hop's target among the composition's
// declared targets: deviceID|serviceID|action)
const TARGET = `${require('../../lib/call-address').deviceIDForName('compose-callee')}|urn:countinghouse-test:serviceID:calleeService|double`;
const boundDevice = () => ({_compositionSettled: true, _composition: {identity: '(bound)', allowed: {[CALLEE]: true}, targets: [TARGET]}});

// a handler's answer, through the real path (handler-answer's fail)
function answer(invoke) {
  const stubDevice = {deviceID: 'stub', resolveSchemaFromPath: function() {}};
  const service = new Service(stubDevice, 'urn:test:serviceID:svc', {actionList: []});
  const action = {name: 'act', invoke: invoke, input: null, output: null};
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer')), 2000);
    service.doActionCall(action, {}, (err, data) => { clearTimeout(timer); resolve({err: err, data: data}); });
  });
}
// the main thread's device query and service client, stubbed: the part's
// spec query refusing (before the invoke), the client refusing, or a client
// whose invoke the part refuses
const PART_SPEC = {device: {serviceList: {'urn:countinghouse-test:serviceID:calleeService': {actionList: [{name: 'double'}]}}}};
function withServiceClient(behave, fn) {
  const impl = require('../../lib/countinghouse-util');
  const saved = {createServiceClient: impl.createServiceClient, queryDeviceSpec: impl.queryDeviceSpec};
  impl.queryDeviceSpec = behave.query || ((id, cb) => cb(null, PART_SPEC));
  impl.createServiceClient = behave.client || ((o, cb) => cb(null, {deviceID: o.deviceID, serviceID: o.serviceID, invoke: (req, done) => done(null, {})}));
  return Promise.resolve().then(fn).finally(() => Object.assign(impl, saved));
}
const queryRefuses = (code) => ({query: (id, cb) => cb(new CountinghouseError(code, id))});
const refusedBefore = (code) => ({client: (o, cb) => cb(new CountinghouseError(code, o.deviceID))});
const partRefuses = (err) => ({client: (o, cb) => cb(null, {deviceID: o.deviceID, serviceID: o.serviceID, invoke: (req, done) => done(err, null)})});
const callRefusal = async () => {
  try { await buildCtx(boundDevice(), {ctx: {appKey: 'k'}}, {}).call(CALLEE, {}); } catch (e) { return e; }
  throw new Error('ctx.call did not reject');
};
const shape = (e) => [e.code, statusOf(e), kindOf(e)];

describe('validation 34: what leaves a module handler is the module\'s answer (#482\'s high, round 2)', () => {
  it('ctx.call: a refusal before the invoke (the part\'s device query, DEVICE_NOT_FOUND), passed on by the composer, answers 500, kind module', () =>
    withServiceClient(queryRefuses('DEVICE_NOT_FOUND'), async () => {
      const refusal = await callRefusal();
      assert.deepStrictEqual(shape(refusal), ['DEVICE_NOT_FOUND', 404, 'caller'], 'premise: as the composer holds it');
      const a = await answer(() => { throw refusal; });
      assert.deepStrictEqual(shape(a.err), ['DEVICE_NOT_FOUND', 500, 'module']);
    }));

  it('ctx.call: the part\'s own refusal of the composer\'s input (INPUT_DATA_VALIDATION_FAIL), rethrown or called back, answers 500, kind module', () =>
    withServiceClient(partRefuses(new CountinghouseError('INPUT_DATA_VALIDATION_FAIL')), async () => {
      const refusal = await callRefusal();
      const thrown = await answer(() => { throw refusal; });
      const calledBack = await answer((args, cb) => cb(refusal));
      const returned = await answer(async() => refusal);
      for (const a of [thrown, calledBack, returned]) assert.deepStrictEqual(shape(a.err), ['INPUT_DATA_VALIDATION_FAIL', 500, 'module']);
    }));

  it('ctx.serviceClient: SERVICE_NOT_FOUND before the invoke, passed on, answers 500, kind module', () =>
    withServiceClient(refusedBefore('SERVICE_NOT_FOUND'), async () => {
      const refusal = await new Promise((resolve) => buildCtx(boundDevice(), {}, {}).serviceClient({deviceID: 'd', serviceID: 'bad'}, (e) => resolve(e)));
      const a = await answer(() => refusal);
      assert.deepStrictEqual(shape(a.err), ['SERVICE_NOT_FOUND', 500, 'module']);
    }));

  it('a hop\'s RATE_LIMIT_EXCEEDED (the binding identity\'s budget, single-thread) is the composer\'s: 500, no retry hint', () =>
    withServiceClient(partRefuses(setRetryAfter(new CountinghouseError('RATE_LIMIT_EXCEEDED'), 900)), async () => {
      const a = await answer(async() => { throw await callRefusal(); });
      assert.deepStrictEqual(shape(a.err), ['RATE_LIMIT_EXCEEDED', 500, 'module']);
      assert.strictEqual(retryAfterOf(a.err), undefined);
    }));

  it('the settings gate\'s claims pass through as the end caller\'s: SETTING_REQUIRED keeps its row', () =>
    withServiceClient(partRefuses(new CountinghouseError('SETTING_REQUIRED')), async () => {
      const a = await answer(async() => { throw await callRefusal(); });
      assert.deepStrictEqual(shape(a.err), ['SETTING_REQUIRED', CODES.SETTING_REQUIRED.httpStatus, 'caller']);
    }));

  it('the mark crosses a reply, a task\'s failure record and a job\'s public record', async () => {
    const a = await withServiceClient(queryRefuses('DEVICE_NOT_FOUND'), async () => answer(async() => { throw await callRefusal(); }));
    assert.strictEqual(fromHandler(a.err), true);
    const fields = CountinghouseError.replyFields(a.err);
    assert.strictEqual(fields.errFromHandler, true);
    const crossed = CountinghouseError.fromReplyFields(fields);
    assert.deepStrictEqual(shape(crossed), ['DEVICE_NOT_FOUND', 500, 'module'], 'across a reply');
    assert.deepStrictEqual([statusOf(CountinghouseError.fromReply(crossed)), kindOf(CountinghouseError.fromReply(crossed))], [500, 'module'], 'a copy of it');
    const common = require('../../lib/job-control-common');
    const text = common.failureText(a.err, {era: 'modern'});
    const task = require('../../lib/mcp/gateway').taskFailureFor({job: {failedReason: text}});
    assert.deepStrictEqual(shape(task), ['DEVICE_NOT_FOUND', 500, 'module'], 'a task\'s failure');
    const record = common.publicRecord({job: {failedReason: common.failureText(a.err)}});
    assert.strictEqual(record.job.failedKind, 'module');
    assert.ok(!record.job.failedReason.includes('\u001f'), 'no runner mark in the public record');
  });

  it('a crash fallback carries no mark of the error it replaces', () => {
    const sent = [];
    let first = true;
    CountinghouseError.postReply((env) => { if (first) { first = false; throw new Error('cannot clone'); } sent.push(env); },
      {id: 1, errMsg: 'x', errCode: 'DEVICE_NOT_FOUND', errFromHandler: true, data: {f: () => 0}});
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].errFromHandler, undefined);
  });

  // #482's high, round 2, 3: the hint is the limiters' alone
  it('the retry hint is held privately, written only by a limiter, clamped to its window, never read from properties', () => {
    const e = setRetryAfter(new CountinghouseError('RATE_LIMIT_EXCEEDED'), 1e30);
    assert.strictEqual(retryAfterOf(e), 1, 'clamped to the 1 s window');
    const forged = new CountinghouseError('RATE_LIMIT_EXCEEDED');
    Object.defineProperty(forged, 'retryAfterMs', {value: 1e30, enumerable: true});
    const saved = Object.getOwnPropertyDescriptor(Error.prototype, 'retryAfterMs');
    Object.defineProperty(Error.prototype, 'retryAfterMs', {value: 5000, configurable: true});
    try {
      assert.strictEqual(retryAfterOf(forged), undefined);
    } finally {
      if (saved != null) Object.defineProperty(Error.prototype, 'retryAfterMs', saved); else delete Error.prototype.retryAfterMs;
    }
    assert.strictEqual(setRetryAfter(new CountinghouseError('RUNTIME_BUSY'), 2500, 3000) && retryAfterOf(setRetryAfter(new CountinghouseError('RUNTIME_BUSY'), 2500, 3000)), 3);
  });

  // #482's high, round 2, 7: one shape everywhere
  it('every rate-limited route\'s 429 carries Retry-After: the gate passes the limiter\'s refusal', async () => {
    const gate = require('../../lib/rate-limit-gate');
    const cdif = {rateLimit: (k, cb) => cb(null, {limited: true, timeLeft: 600})};
    const got = await new Promise((resolve) => gate.check(cdif, 'k', (limited, refusal) => resolve({limited, refusal})));
    assert.strictEqual(got.limited, true);
    assert.deepStrictEqual([got.refusal.code, retryAfterOf(got.refusal)], ['RATE_LIMIT_EXCEEDED', 1]);
    const headers = {};
    const res = {setHeader: (k, v) => { headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }};
    gate.guard(cdif, {appKey: 'k'}, res, () => { throw new Error('let through'); });
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual([res.code, headers['Retry-After'], res.body.code], [429, '1', 'RATE_LIMIT_EXCEEDED']);
  });

  // #482's high, round 2, 6: a job's run with no session, as a sessionless call
  it('a job\'s run of a per-session module with no session is the one answer, not retried', async () => {
    const DeviceManager = require('../../lib/device-manager');
    const {SessionModuleRecord} = require('../../lib/session-module-record');
    const {notRetried} = require('../../lib/job-control-common');
    const visibility = require('../../lib/module-visibility');
    const saved = visibility.configure({moduleOf: () => 'session-mod', isGone: () => true, changed: () => {}});
    try {
      const rec = Object.assign(Object.create(SessionModuleRecord.prototype), {packageInfo: {name: 'session-mod', countinghouse: {}}});
      const dm = {deviceMap: {d: rec}, moduleManager: {unlisted: new Set()}, workerFor() { throw new Error('reached workerFor'); }, discoveredTag: (e) => e};
      const err = await new Promise((resolve) => DeviceManager.prototype.invokeJobsNow.call(dm, 'd', 's', 'a', {}, 'j', resolve, null, {}));
      assert.strictEqual(err && err.code, 'MODULE_NOT_LISTED');
      assert.strictEqual(notRetried(err.code, err), true);
    } finally {
      visibility.configure(saved);
    }
  });
});
