'use strict';
// post-rel caller 400: an error's HTTP status and kind come from one rule
// (lib/countinghouse-error.js statusOf, kindOf: the catalogue, and a
// module's own error 400 when its module said the caller is at fault), and a
// REST route gives ONE answer, status and body byte-identical, for every name
// the caller can't use, whatever the reason (CLAUDE.md's invariants: no
// probing which modules exist). In process: the real routes, mounted on an
// express app over a stub device manager, the key check (lib/user-auth.js)
// stubbed where a case needs it. No server, no Redis.
const assert = require('assert');
const path = require('path');
const express = require('express');
const request = require('supertest');
const {CountinghouseError, statusOf, kindOf, errorBody} = require('../../lib/countinghouse-error');
const {CODES} = require('../../lib/error-catalogue');
const visibility = require('../../lib/module-visibility');
const verdict = require('../../lib/hidden-text-verdict');
const Session = require('../../lib/session');

const LISTED = 'bbbbbbbb-0000-5000-8000-000000000001';
const PART = 'bbbbbbbb-0000-5000-8000-000000000002';
const NOWHERE = 'bbbbbbbb-0000-5000-8000-000000000003';
const GONE_LATE = 'bbbbbbbb-0000-5000-8000-000000000004';
// a per-session device in shared mode: listed, but REST has no session to
// reach it with (workerFor answers DEVICE_NOT_FOUND), #482's high, 3
const PER_SESSION = 'bbbbbbbb-0000-5000-8000-000000000005';
const SERVICE = 'urn:x:service';
const device = (name, role) => ({packageInfo: {name, countinghouse: role != null ? {role} : {}}});
const MODULE_OF = {[LISTED]: 'listed-mod', [PART]: 'part-mod', [GONE_LATE]: 'gone-mod', [PER_SESSION]: 'session-mod'};

describe('validation 33: one status rule; one answer for a name the caller can\'t use (post-rel caller 400)', () => {
  describe('statusOf and kindOf', () => {
    it('a catalogue code answers its row\'s status and kind', () => {
      assert.deepStrictEqual([statusOf(new CountinghouseError('ACTION_NOT_FOUND')), kindOf(new CountinghouseError('ACTION_NOT_FOUND'))], [404, 'caller']);
      assert.deepStrictEqual([statusOf(new CountinghouseError('ADMIN_REQUIRED')), kindOf(new CountinghouseError('ADMIN_REQUIRED'))], [403, 'caller']);
      assert.deepStrictEqual([statusOf(new CountinghouseError('SYSTEM_ERROR_UNKNOWN_USER'))], [401]);
      assert.deepStrictEqual([statusOf(new CountinghouseError('SERVICEID_NOT_AVAILABLE'))], [400]);
      assert.deepStrictEqual([statusOf(new CountinghouseError('RATE_LIMIT_EXCEEDED'))], [429]);
      const runtime = Object.keys(CODES).find((c) => CODES[c].kind === 'runtime' && CODES[c].httpStatus === 503);
      assert.strictEqual(statusOf(new CountinghouseError(runtime)), 503, runtime);
    });

    it('a module\'s own error: 400 and caller when its module said so, else 500 and module', () => {
      // (as ctx.error makes them: CountinghouseError.moduleOwn)
      const callers = CountinghouseError.moduleOwn('MY_BAD_INPUT', 'the input was wrong', null, 'probe', {kind: 'caller'});
      const own = CountinghouseError.moduleOwn('MY_FAULT', 'it broke', null, 'probe');
      assert.deepStrictEqual([statusOf(callers), kindOf(callers), callers.httpStatus], [400, 'caller', 400]);
      assert.deepStrictEqual([statusOf(own), kindOf(own), own.httpStatus], [500, 'module', 500]);
    });

    it('anything else is 500, runtime; a getter that throws is 500, never a throw', () => {
      assert.deepStrictEqual([statusOf(new Error('x')), kindOf(new Error('x'))], [500, 'runtime']);
      assert.deepStrictEqual([statusOf('a string'), kindOf(null)], [500, 'runtime']);
      const odd = new CountinghouseError('ACTION_NOT_FOUND');
      Object.defineProperty(odd, 'httpStatus', {get() { throw new Error('no'); }});
      Object.defineProperty(odd, 'kind', {get() { throw new Error('no'); }});
      assert.deepStrictEqual([statusOf(odd), kindOf(odd)], [500, 'runtime']);
      assert.deepStrictEqual(errorBody(new CountinghouseError('ACTION_NOT_FOUND'), {why: 1}),
        {code: 'ACTION_NOT_FOUND', message: CODES.ACTION_NOT_FOUND.en, kind: 'caller', fault: {why: 1}});
    });

    // the medium on caller 400, 1: a worker's or a validator's reply is
    // decoded as a plain Error carrying its code
    it('a plain Error carrying a catalogue code takes its row, whatever the thread mode; one marked a module\'s never does', () => {
      const decoded = Object.assign(new Error('Input data validation failed'), {code: 'INPUT_DATA_VALIDATION_FAIL'});
      assert.deepStrictEqual([statusOf(decoded), kindOf(decoded)], [400, 'caller']);
      const service = Object.assign(new Error('x'), {code: 'SERVICE_NOT_FOUND'});
      assert.deepStrictEqual([statusOf(service), kindOf(service)], [404, 'caller']);
      const moduleOwn = Object.assign(new Error('x'), {code: 'INPUT_DATA_VALIDATION_FAIL', origin: 'module'});
      assert.deepStrictEqual([statusOf(moduleOwn), kindOf(moduleOwn)], [500, 'runtime']);
      const notOurs = Object.assign(new Error('x'), {code: 'ENOENT'});
      assert.deepStrictEqual([statusOf(notOurs), kindOf(notOurs)], [500, 'runtime']);
    });

    it('a run refused for a missing or hidden action is never retried (ACTION_NOT_FOUND), nor a malformed job request\'s', () => {
      const {notRetried} = require('../../lib/job-control-common');
      assert.strictEqual(notRetried('ACTION_NOT_FOUND'), true);
      assert.strictEqual(notRetried('MODULE_NOT_LISTED'), true);
      assert.deepStrictEqual([CODES.JOB_OPTS_INVALID.kind, CODES.JOB_OPTS_INVALID.httpStatus], ['caller', 400]);
    });

    it('a job\'s run refuses a part a scenario took in (a scheduler made while it was listed), as add-job does', async () => {
      const DeviceManager = require('../../lib/device-manager');
      const dm = {deviceMap: {[PART]: device('part-mod', 'part')}, moduleManager: {unlisted: new Set(['part-mod'])},
        ensureDeviceState: () => { throw new Error('dispatched'); }, discoveredTag: (e) => e};
      const savedVis = visibility.configure({moduleOf: () => 'part-mod', isGone: () => true, changed: () => {}});
      try {
        const err = await new Promise((resolve) => DeviceManager.prototype.invokeJobsNow.call(dm, PART, SERVICE, 'act', {}, 'j1', resolve));
        assert.strictEqual(err && err.code, 'MODULE_NOT_LISTED');
      } finally {
        visibility.configure(savedVis);
      }
    });

    // #482's high, 1: the limiters say what they are
    it('invoke-action\'s limiters: a key over its budget is RATE_LIMIT_EXCEEDED 429; the runtime at its limit is RUNTIME_BUSY 503 with Retry-After', () => {
      const CdifInterface = require('../../lib/countinghouse-interface');
      const told = [];
      const session = {appKey: 'k', callbackWithoutTimer: (err) => told.push(err)};
      const over = {rateLimiter: (k, cb) => cb(null, 0), rateLimit: (k, cb) => cb(null, {limited: true}), deviceManager: {emit() { throw new Error('dispatched'); }}};
      const busy = {rateLimiter: (k, cb) => cb(null, 1500), rateLimit: () => { throw new Error('per-key asked'); }, deviceManager: {emit() { throw new Error('dispatched'); }}};
      CdifInterface.prototype.invokeDeviceAction.call(over, LISTED, SERVICE, 'act', null, session);
      CdifInterface.prototype.invokeDeviceAction.call(busy, LISTED, SERVICE, 'act', null, session);
      assert.deepStrictEqual(told.map((e) => [e.code, statusOf(e), kindOf(e)]), [['RATE_LIMIT_EXCEEDED', 429, 'caller'], ['RUNTIME_BUSY', 503, 'runtime']]);
      const headers = {};
      const res = {setHeader: (k, v) => { headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }};
      require('../../lib/countinghouse-error').answerError(res, told[1]);
      assert.deepStrictEqual([res.code, headers['Retry-After'], res.body.code], [503, '1', 'RUNTIME_BUSY'], 'whole seconds, at most the limiter\'s 1 s window');
      assert.strictEqual(CODES.DENY_DEVICE_ACCESS, undefined, 'raised nowhere now: its row is gone');
    });




    // #482's high, 3, at its source: a per-session device has no session to
    // be reached by over REST
    it('workerFor: no session at all (REST) is the one answer at the source; a hop with none is still not found', () => {
      const DeviceManager = require('../../lib/device-manager');
      const {SessionModuleRecord} = require('../../lib/session-module-record');
      const dm = {deviceMap: {[PER_SESSION]: Object.create(SessionModuleRecord.prototype)}, moduleManager: {}};
      let got = null;
      DeviceManager.prototype.workerFor.call(dm, PER_SESSION, null, (err) => { got = err; });
      assert.strictEqual(got && got.code, 'MODULE_NOT_LISTED');
      DeviceManager.prototype.workerFor.call(dm, PER_SESSION, null, (err) => { got = err; }, {hop: true});
      assert.strictEqual(got && got.code, 'DEVICE_NOT_FOUND');
    });

    // #482's high, 4
    it('a runtime error with no catalogue code is the runtime\'s, not a module\'s', () => {
      const e = new CountinghouseError('NOT_A_CATALOGUE_CODE');
      assert.deepStrictEqual([e.origin, e.kind, kindOf(e), statusOf(e)], ['runtime', 'runtime', 'runtime', 500]);
      const replied = CountinghouseError.fromReply({message: 'a worker ended'});
      assert.strictEqual(kindOf(replied), 'runtime');
      const own = CountinghouseError.moduleOwn('MY_FAULT', 'it broke', null, 'probe');
      assert.strictEqual(kindOf(own), 'module');
    });

    it('every caller-kind catalogue row answers a 4xx; JOB_ACCESS_DENIED is gone, JOB_NOT_FOUND and SCHEMA_PATH_NOT_FOUND are 404', () => {
      for (const [code, e] of Object.entries(CODES)) {
        if (e.kind === 'caller') assert.ok(e.httpStatus >= 400 && e.httpStatus < 500, `${code}: ${e.httpStatus}`);
      }
      assert.strictEqual(CODES.JOB_ACCESS_DENIED, undefined);
      assert.deepStrictEqual([CODES.JOB_NOT_FOUND.kind, CODES.JOB_NOT_FOUND.httpStatus], ['caller', 404]);
      assert.deepStrictEqual([CODES.SCHEMA_PATH_NOT_FOUND.kind, CODES.SCHEMA_PATH_NOT_FOUND.httpStatus], ['caller', 404]);
      assert.deepStrictEqual([CODES.POINTER_DEREF_ERROR.kind], ['module'], 'the module\'s document failing stays the module\'s');
    });
  });

  describe('the REST routes', () => {
    let savedDeps = null;
    let savedUserAuth = null;
    let authAnswer = null;
    let invoked = [];
    let app = null;
    const userAuthId = require.resolve('../../lib/user-auth');
    const userRouteId = require.resolve('../../lib/routes/user');
    const dm = {
      deviceMap: {[LISTED]: device('listed-mod', null), [PART]: device('part-mod', 'part'), [GONE_LATE]: device('gone-mod', null),
        // a per-session module's record (shared mode)
        [PER_SESSION]: Object.assign(Object.create(require('../../lib/session-module-record').SessionModuleRecord.prototype), device('session-mod', null))},
      moduleOfDevice: () => null,
      packageOfModule: () => null,
      moduleManager: {unlisted: new Set(['part-mod']), modules: {}},
      schemaPartsOf: () => ({spec: null, schemaDoc: null})
    };
    const cdif = {
      deviceManager: dm,
      // a missing action, answered as the paths that dispatch it answer
      // (one in this thread names it; a worker's crosses as its code alone);
      // a device gone between the route's check and the dispatch
      invokeDeviceAction(deviceID, serviceID, actionName, args, session) {
        invoked.push([deviceID, serviceID, actionName]);
        // a listed device still loading (shared mode's startup): its own answer
        if (actionName === 'still-loading') return session.callbackWithoutTimer(new CountinghouseError('DEVICE_NOT_FOUND', deviceID));
        if (deviceID === GONE_LATE) {
          delete dm.deviceMap[GONE_LATE];
          return session.callbackWithoutTimer(new CountinghouseError('DEVICE_NOT_FOUND', deviceID));
        }
        if (actionName === 'named-missing') return session.callbackWithoutTimer(new CountinghouseError('ACTION_NOT_FOUND', actionName));
        if (actionName === 'crossed-missing') return session.callbackWithoutTimer(new CountinghouseError('ACTION_NOT_FOUND'));
        // a missing service (named, as countinghouse-device raises it)
        if (serviceID === 'urn:x:no-such-service') return session.callbackWithoutTimer(new CountinghouseError('SERVICE_NOT_FOUND', serviceID));
        return session.callbackWithoutTimer(null, {ok: true});
      },
      getDeviceSpec: (deviceID, session) => session.callbackWithoutTimer(null, {device: {serviceList: {}}}),
      getDeviceSchema: (deviceID, p, session) => session.callbackWithoutTimer(null, {}),
      getDevicePackageInfo: (deviceID, cb) => cb(null, {name: 'x', version: '1.0.0'})
    };

    before(() => {
      savedDeps = visibility.configure({moduleOf: (id) => MODULE_OF[id] || null, isGone: () => true, changed: () => {}});
      // the key check: a granted key passes (a session for the request), an
      // ungranted one is refused as lib/user-auth.js refuses it
      savedUserAuth = require.cache[userAuthId];
      require.cache[userAuthId] = {id: userAuthId, filename: userAuthId, loaded: true, exports: (req, res, deviceID, appKey, s, a, n, cb) => {
        if (authAnswer != null) return cb(authAnswer);
        return cb(null, new Session(req, res, 'u', appKey, 0, deviceID, null, null));
      }};
      delete require.cache[userRouteId];
      const rateLimitGate = require('../../lib/rate-limit-gate');
      const savedGuard = rateLimitGate.guard;
      rateLimitGate.guard = (c, session, res, next) => next();
      rateLimitGate.restore = () => { rateLimitGate.guard = savedGuard; };
      const user = require('../../lib/routes/user');
      app = express();
      app.use(express.json());
      const devices = express.Router({mergeParams: true});
      app.use('/devices/:deviceID', user, devices);
      devices.use('/invoke-action', require('../../lib/routes/invoke-action')(null, cdif));
      devices.use('/get-spec', require('../../lib/routes/get-spec')(null, cdif));
      devices.use('/schema', require('../../lib/routes/schema')(null, cdif));
      devices.use('/package-info', require('../../lib/routes/get-device-package-info')(null, cdif));
      devices.use('/add-job', require('../../lib/routes/add-job')(cdif));
    });
    after(() => {
      visibility.configure(savedDeps);
      if (savedUserAuth != null) require.cache[userAuthId] = savedUserAuth; else delete require.cache[userAuthId];
      delete require.cache[userRouteId];
      require('../../lib/rate-limit-gate').restore();
      verdict.forget(LISTED);
    });
    afterEach(() => { authAnswer = null; visibility.show(Object.values(MODULE_OF)); dm.deviceMap[GONE_LATE] = device('gone-mod', null); });

    const answerOf = (res) => JSON.stringify({status: res.status, body: res.body});
    const call = (route, deviceID, body = {serviceID: SERVICE, actionName: 'act', input: {}}) => {
      const r = request(app)[route.method](`/devices/${deviceID}/${route.path}`).set('X-CH-Key', 'k');
      return (route.method === 'post' ? r.send(body) : r).then(answerOf);
    };
    const ROUTES = [
      {name: 'invoke-action', method: 'post', path: 'invoke-action'},
      {name: 'get-spec', method: 'get', path: 'get-spec'},
      {name: 'schema', method: 'get', path: 'schema/'},
      {name: 'package-info', method: 'get', path: 'package-info'},
      {name: 'add-job', method: 'post', path: 'add-job'}
    ];

    for (const route of ROUTES) {
      it(`${route.name}: missing, not listed, hidden and not granted are one answer, byte for byte: MODULE_NOT_LISTED 404`, async () => {
        invoked = [];
        const missing = await call(route, NOWHERE);
        const unlisted = await call(route, PART);
        visibility.hide(['listed-mod']);
        const hidden = await call(route, LISTED);
        visibility.show(['listed-mod']);
        authAnswer = new CountinghouseError('USER_HAS_NO_DEVICE');
        const ungranted = await call(route, LISTED);
        authAnswer = null;
        const expected = JSON.stringify({status: 404, body: {code: 'MODULE_NOT_LISTED', message: CODES.MODULE_NOT_LISTED.en, kind: 'caller'}});
        assert.deepStrictEqual({missing, unlisted, hidden, ungranted}, {missing: expected, unlisted: expected, hidden: expected, ungranted: expected});
        assert.deepStrictEqual(invoked, [], 'nothing dispatched');
      });
    }

    // #482's high, round 2, 6: decided at the route, before any limiter
    it('a per-session device in shared mode (listed; REST has no session to reach it) is the one answer before any dispatch; a listed device still loading keeps its own', async () => {
      const want = JSON.stringify({status: 404, body: {code: 'MODULE_NOT_LISTED', message: CODES.MODULE_NOT_LISTED.en, kind: 'caller'}});
      invoked = [];
      assert.strictEqual(await call(ROUTES[0], PER_SESSION), want, 'invoke-action');
      assert.strictEqual(await call(ROUTES[4], PER_SESSION), want, 'add-job');
      assert.deepStrictEqual(invoked, [], 'refused before the dispatch, so before the limiters');
      const loading = JSON.parse(await call(ROUTES[0], LISTED, {serviceID: SERVICE, actionName: 'still-loading', input: {}}));
      assert.deepStrictEqual([loading.status, loading.body.code], [404, 'DEVICE_NOT_FOUND'], 'the medium on round 1, 6: not folded into "not listed to you"');
    });


    it('invoke-action: a device gone between the check and the dispatch answers the same one answer', async () => {
      const late = await call(ROUTES[0], GONE_LATE);
      assert.strictEqual(late, JSON.stringify({status: 404, body: {code: 'MODULE_NOT_LISTED', message: CODES.MODULE_NOT_LISTED.en, kind: 'caller'}}));
    });

    it('invoke-action: an action its declared text leaves unusable answers as a missing one, byte for byte, however the missing one was raised', async () => {
      verdict.set(LISTED, [[SERVICE, 'hidden-act']]);
      invoked = [];
      const hidden = await call(ROUTES[0], LISTED, {serviceID: SERVICE, actionName: 'hidden-act', input: {}});
      assert.deepStrictEqual(invoked, [], 'the unusable action is never dispatched');
      const named = await call(ROUTES[0], LISTED, {serviceID: SERVICE, actionName: 'named-missing', input: {}});
      const crossed = await call(ROUTES[0], LISTED, {serviceID: SERVICE, actionName: 'crossed-missing', input: {}});
      // (a missing service too: one whose actions are all hidden is not
      // shown either; the medium on caller 400, 5)
      const service = await call(ROUTES[0], LISTED, {serviceID: 'urn:x:no-such-service', actionName: 'act', input: {}});
      const expected = JSON.stringify({status: 404, body: {code: 'ACTION_NOT_FOUND', message: CODES.ACTION_NOT_FOUND.en, kind: 'caller'}});
      assert.deepStrictEqual({hidden, named, crossed, service}, {hidden: expected, named: expected, crossed: expected, service: expected});
    });

    it('an unknown key is 401, with WWW-Authenticate', async () => {
      authAnswer = new CountinghouseError('SYSTEM_ERROR_UNKNOWN_USER');
      const res = await request(app).get(`/devices/${LISTED}/get-spec`).set('X-CH-Key', 'k');
      assert.deepStrictEqual([res.status, res.headers['www-authenticate'], res.body.code, res.body.kind], [401, 'X-CH-Key', 'SYSTEM_ERROR_UNKNOWN_USER', 'caller']);
    });

    it('a request-shape error is 400, kind caller (was 500)', async () => {
      const res = await call(ROUTES[0], LISTED, {actionName: 'act', input: {}});
      assert.strictEqual(res, JSON.stringify({status: 400, body: {code: 'SERVICEID_NOT_AVAILABLE', message: CODES.SERVICEID_NOT_AVAILABLE.en, kind: 'caller'}}));
    });
  });
});
