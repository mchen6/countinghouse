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
      assert.deepStrictEqual([res.code, headers['Retry-After'], res.body.code], [503, '2', 'RUNTIME_BUSY']);
      assert.strictEqual(CODES.DENY_DEVICE_ACCESS, undefined, 'raised nowhere now: its row is gone');
    });

    // #482's high, 2: a part's runtime caller-kind refusal is the composer's
    it('a runtime caller-kind code across a hop is the composer\'s: module, 500, across a reply too, never the one answer, retried in a job', () => {
      const ce = require('../../lib/countinghouse-error');
      const {oneActionAnswer} = require('../../lib/listing-scope');
      const {notRetried} = require('../../lib/job-control-common');
      for (const code of ['INPUT_DATA_VALIDATION_FAIL', 'ACTION_NOT_FOUND', 'SERVICE_NOT_FOUND', 'DEVICE_NOT_FOUND', 'PEER_NOT_GRANTED', 'INPUT_NOT_FOUND']) {
        const direct = new CountinghouseError(code, 'x');
        assert.strictEqual(kindOf(direct), 'caller', `premise: ${code} is the caller's`);
        const hop = ce.hopError(direct);
        assert.deepStrictEqual([hop.code, statusOf(hop), kindOf(hop), hop.kind, hop.httpStatus], [code, 500, 'module', 'module', 500], code);
        const fields = CountinghouseError.replyFields(hop);
        assert.strictEqual(fields.errHop, true, code);
        const crossed = CountinghouseError.fromReplyFields(fields);
        assert.deepStrictEqual([crossed.code, statusOf(crossed), kindOf(crossed)], [code, 500, 'module'], `${code} across a reply`);
        const copied = CountinghouseError.fromReply(crossed);
        assert.deepStrictEqual([statusOf(copied), kindOf(copied)], [500, 'module'], `${code} copied`);
        assert.strictEqual(oneActionAnswer(crossed), crossed, `${code}: never folded into the caller's one answer`);
        // (the usual path: the composer rethrows it, and the handler's answer
        // copies it, answerable: the medium on round 1, 1)
        const answered = CountinghouseError.answerable(hop);
        assert.deepStrictEqual([answered.code, statusOf(answered), kindOf(answered)], [code, 500, 'module'], `${code} rethrown by the composer`);
        assert.deepStrictEqual([statusOf(CountinghouseError.answerable(crossed)), kindOf(CountinghouseError.answerable(crossed))], [500, 'module'], `${code} rethrown after a reply`);
      }
      // retried: only a hop's refusal of a name a reload may have replaced
      for (const code of ['ACTION_NOT_FOUND', 'SERVICE_NOT_FOUND', 'DEVICE_NOT_FOUND']) assert.strictEqual(notRetried(code, ce.hopError(new CountinghouseError(code))), false, code);
    });

    // the medium on round 1, 2 and 3: the end caller's own state stays theirs
    it('a hop leaves the end caller\'s own refusals theirs: their budget, their settings, their key; and the rule for retrying them', () => {
      const ce = require('../../lib/countinghouse-error');
      const {notRetried} = require('../../lib/job-control-common');
      for (const code of ['RATE_LIMIT_EXCEEDED', 'SETTING_REQUIRED', 'SYSTEM_ERROR_UNKNOWN_USER', 'USER_HAS_NO_DEVICE']) {
        const hop = ce.hopError(new CountinghouseError(code));
        assert.strictEqual(ce.hopped(hop), false, code);
        assert.strictEqual(kindOf(hop), CODES[code].kind, code);
        assert.strictEqual(statusOf(hop), CODES[code].httpStatus, code);
      }
      assert.strictEqual(notRetried('SETTING_REQUIRED', ce.hopError(new CountinghouseError('SETTING_REQUIRED'))), true, 'a hop\'s missing setting is not retried');
    });

    // the medium on round 1, 4 and 5: when to retry, on every path
    it('when to retry crosses every copy and reply, and the per-key limiter says it too; a throwing getter never breaks an answer', () => {
      const ce = require('../../lib/countinghouse-error');
      const busy = new CountinghouseError('RUNTIME_BUSY');
      Object.defineProperty(busy, 'retryAfterMs', {value: 2500, enumerable: false, writable: true, configurable: true});
      const hop = ce.hopError(busy);
      assert.strictEqual(ce.retryAfterOf(hop), 2500, 'a hop\'s copy');
      const fields = CountinghouseError.replyFields(hop);
      assert.strictEqual(fields.errRetryAfterMs, 2500);
      assert.strictEqual(ce.retryAfterOf(CountinghouseError.fromReplyFields(fields)), 2500, 'across a reply');
      assert.strictEqual(ce.retryAfterOf(CountinghouseError.answerable(hop)), 2500, 'rethrown by a composer');
      const CdifInterface = require('../../lib/countinghouse-interface');
      const told = [];
      CdifInterface.prototype.invokeDeviceAction.call({rateLimiter: (k, cb) => cb(null, 0), rateLimit: (k, cb) => cb(null, {limited: true, timeLeft: 4200}), deviceManager: {emit() {}}},
        LISTED, SERVICE, 'act', null, {appKey: 'k', callbackWithoutTimer: (err) => told.push(err)});
      assert.deepStrictEqual([told[0].code, ce.retryAfterOf(told[0])], ['RATE_LIMIT_EXCEEDED', 4200]);
      const odd = new CountinghouseError('RATE_LIMIT_EXCEEDED');
      Object.defineProperty(odd, 'retryAfterMs', {get() { throw new Error('no'); }});
      const res = {setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }};
      ce.answerError(res, odd);
      assert.strictEqual(res.code, 429);
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
      deviceMap: {[LISTED]: device('listed-mod', null), [PART]: device('part-mod', 'part'), [GONE_LATE]: device('gone-mod', null), [PER_SESSION]: device('session-mod', null)},
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
        // (what workerFor answers a call with no session: below)
        if (deviceID === PER_SESSION) return session.callbackWithoutTimer(new CountinghouseError('MODULE_NOT_LISTED'));
        // a listed device still loading (shared mode's startup): its own answer
        if (actionName === 'still-loading') return session.callbackWithoutTimer(new CountinghouseError('DEVICE_NOT_FOUND', deviceID));
        // a composer whose part refused it: the composer's own fault, passed on
        if (actionName === 'hop-refused') return session.callbackWithoutTimer(require('../../lib/countinghouse-error').hopError(new CountinghouseError('ACTION_NOT_FOUND', 'part-act')));
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

    it('a per-session device in shared mode (listed; REST has no session to reach it) is the one answer; a listed device still loading keeps its own', async () => {
      const want = JSON.stringify({status: 404, body: {code: 'MODULE_NOT_LISTED', message: CODES.MODULE_NOT_LISTED.en, kind: 'caller'}});
      assert.strictEqual(await call(ROUTES[0], PER_SESSION), want, 'invoke-action');
      const loading = JSON.parse(await call(ROUTES[0], LISTED, {serviceID: SERVICE, actionName: 'still-loading', input: {}}));
      assert.deepStrictEqual([loading.status, loading.body.code], [404, 'DEVICE_NOT_FOUND'], 'the medium on round 1, 6: not folded into "not listed to you"');
    });

    it('invoke-action: a composer passing on its part\'s refusal answers 500, the module\'s, never the caller\'s 404', async () => {
      const res = await call(ROUTES[0], LISTED, {serviceID: SERVICE, actionName: 'hop-refused', input: {}});
      const parsed = JSON.parse(res);
      assert.deepStrictEqual([parsed.status, parsed.body.code, parsed.body.kind], [500, 'ACTION_NOT_FOUND', 'module'], res);
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
