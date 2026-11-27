'use strict';
const {CountinghouseError, readGuarded, answerError} = require('./countinghouse-error');
const options       = require('./cli-options');
const Timer         = require('./timer');
const threadInfo    = require('./thread-info');
// the logger only on an error line (in a worker, the worker's: lib/logger.js)
const log           = require('./lazy-require').lazy('./logger');
const once          = require('once');
// lib/thread-info.js, not worker_threads: loaded on first use in a lean worker
const isMainThread  = require('./thread-info').isMainThread;

// required on first use, then kept (lib/lazy-require.js, which a worker's
// hop already loads; test/sandbox/43): no require() on the call path
const callLimitsLib = require('./lazy-require').lazy('./call-limits');

// apiRemainCount kept as a positional parameter -- still passed by every
// call site -- but no longer stored: it was only ever read by the retired
// realPrice/NOT_ENOUGH_USER_BALANCE gate (docs/design-decisions.md's
// AuthProvider section). Same for userDevices/realPrice below.
function Session(req, res, username, appKey, balance, deviceID, apiRemainCount, localCallback) {
  this.req            = req;
  this.res            = res;
  this.username       = username;           // user's name
  this.appKey         = appKey;             // user's appKey
  this.balance        = balance;            // user's balance
  this.deviceID       = deviceID;
  this.timer          = null;
  this.device         = null;               // this field is set by setDeviceTimer call below
  // the call's own override of the cap and timeout (lib/call-limits.js),
  // or null: the global ones, read at each check (a hop takes its caller's;
  // the shared runtime will set a session's)
  this.limits         = null;
  // the client session the call came from (the shared runtime, B1): its
  // opaque id, or null (HTTP, a job, a call from no session). Main thread
  // only: it goes into the call's token, never to a worker.
  this.sessionId      = null;

  this.localCallback  = localCallback;      // a local callback from other services in the same countinghouse instance, only available in service-client

  //NOTICE: below two fields are set by user auth code for external http call, or by service-client code for internal service call
  //only successful api call would set these two fields for api logging
  //under debug mode these stays null so under debug mode we cannot do api logging to redis
  this.serviceID  = null;
  this.actionName = null;

  this.localInput = null;    // to be filled by the session obj created by service-client

  // Opt-in per-call metering for HTTP-originated action invocations (S3).
  // Set by lib/routes/invoke-action.js to the MeteringProvider `tool`
  // identifier for this call; left null by every other session (get-spec,
  // schema, ...), none of which are
  // billable events. Explicitly opt-in rather than "meter every session
  // that reaches response()" so that adding a new non-action route can't
  // accidentally start charging for it.
  this.meteredTool = null;

  this.redirect         = this.redirect.bind(this);
  this.callback         = once(this.callback.bind(this));
  this.setDeviceTimer   = this.setDeviceTimer.bind(this);
  this.clearDeviceTimer = this.clearDeviceTimer.bind(this);

  this.startTime = Date.now();
};

Session.prototype.redirect = function(url) {
  this.res.redirect(url);
};

// platformMetering (D5, docs/composite-tools.md's "billing authority"
// principle) is an optional 3rd arg, only ever populated on the
// main-thread-routed cross-worker call path (see
// DeviceManager.prototype.sendInvokeActionMessageToWorker) -- passed
// through to localCallback (a module's own ServiceClient.invoke()
// callback) as-is, never merged into `data`, since `data` is the callee
// action's own already-schema-validated return value and some caller-side
// modules pass it straight through as their own action's output.
Session.prototype.callback = function(err, data, platformMetering) {
  // timer has been cleared and this could be the second time the callback is invoked from device module
  if (this.timer == null) return;

  if (this.localCallback == null) this.res.setHeader('Content-Type', 'application/json');

  if (this.timer.expired === true) {
    this.timer = null;
    if (this.localCallback != null) {
      this.logAPICall(err, this.localInput, data, false);
      // the timer's own error, code and all, as the HTTP branch below
      // answers it (high review of #37: a composing module lost the code)
      return this.localCallback(err, null);
    }
    this.logAPICall(err, this.req.body, data, true);
    return answerError(this.res, err);
  }
  this.clearDeviceTimer();
  if (this.localCallback != null) {
    this.logAPICall(err, this.localInput, data, false);
    return this.localCallback(err, data, platformMetering);
  }
  this.logAPICall(err, this.req.body, data, true);
  return this.response(err, data);
};

Session.prototype.callbackWithoutTimer = function(err, data) {
  if (this.localCallback != null) {
    this.logAPICall(err, this.localInput, data, false);
    return this.localCallback(err, data);
  }
  this.logAPICall(err, this.req.body, data, true);
  this.res.setHeader('Content-Type', 'application/json');
  this.response(err, data);
};

// Records the call against MeteringProvider for an HTTP-originated action
// invocation, on success only -- the same condition, the same
// CdifInterface.prototype.recordCall, the same options.mcpToolCallCost, and
// the same fire-and-forget style lib/mcp/gateway.js's tools/call path
// already uses, so the two entry paths produce identical metering records
// for the same action.
//
// This exists because the HTTP path's original metering hook
// (Session.prototype.updateRedisUserRecord) was retired during the
// AuthProvider refactor and nothing replaced it: docs/cross-cutting-matrix.md
// still claimed this path was metered, while in practice
// POST /devices/:deviceID/invoke-action charged nothing at all -- a complete
// billing bypass via the pre-MCP HTTP API.
//
// CHUtil is required lazily: lib/countinghouse-util.js -> countinghouse-device.js
// -> session.js is a require cycle, so a top-level require here would see a
// half-initialized module. Same inline-require technique
// lib/device-manager.js and lib/service-client.js already use for user-auth.
Session.prototype.recordMeteredCall = function() {
  if (this.meteredTool == null || this.appKey == null) return;

  // (the main thread's: a worker's CHUtil has no ci, so it never loads the
  // util here, after its lockdown, #194's PR 1)
  if (threadInfo.isMainThread !== true) return;
  const CHUtil = require('./countinghouse-util');
  if (CHUtil.ci == null || typeof(CHUtil.ci.recordCall) !== 'function') return;

  const tool = this.meteredTool;
  this.meteredTool = null; // never bill the same session twice

  const appKey = this.appKey;
  CHUtil.ci.recordCall(appKey, tool, options.mcpToolCallCost, (err) => {
    // (lost after the call ran: said by the key's fingerprint, the tool and the amount)
    if (err) CHUtil.ci.logLostCharge(tool, appKey, options.mcpToolCallCost, err);
  });
};

// An error's answer (post-rel caller 400): the status the catalogue gives
// its code (statusOf: a caller's 4xx, a module's or the runtime's 5xx), and
// a body naming code, message and kind (caller | module | runtime |
// operator), with the module's fault data when it gave some.
Session.prototype.response = function(err, data) {
  if (err) {
    answerError(this.res, err, data);
  } else {
    // success only -- a failed action isn't a billable call, matching
    // gateway.js's `if (result.isError !== true)` guard on the MCP path.
    this.recordMeteredCall();
    this.res.status(200).json(data);
  }
};

// A failed call's code, logged under --debug (main thread only). The
// retired --apiMonitor's Redis API log, which nothing read, is gone.
Session.prototype.logAPICall = function(err, input, data, isHTTPCall) {
  if (isMainThread !== true) return;

  if (err != null) {
    // The error's code only: the caller's input may carry a key, and the
    // message and fault are the module's text (review of c15 on #37; the
    // brief: no key, user name or secret in a log line). A module's code is
    // logged as the module's answer, never as a runtime event, even when it
    // spells a catalogue name (d2b).
    if (options.debug === true) {
      const raw = readGuarded(err, 'code');
      const code = (raw == null || typeof(raw) === 'string') ? raw : null;
      const whose = (readGuarded(err, 'origin') === 'module') ? 'the module\'s answer' : 'the runtime\'s';
      log().E(new CountinghouseError('DEVICE_ACCESS_ERROR', (code != null) ? `${code} (${whose})` : 'an error with no code'));
    }
  }

};

Session.prototype.setDeviceTimer = function(device, callback) {
  this.device = device; // set device instance so we can log its error and set lastDeviceError, see the logger's DE

  // TODO: configurable max no. of parallel ops, it can be done by counting numbers of alive timers
  this.installTimer((err, timer) => {
    if (err) {
      return callback(err, device, null);
    }
    callback(null, device, timer);
  });
};

// Calls under way, by their session (B2 Task 2), so a tightening can
// re-arm their timers; a call is in it from installTimer to its timer's end.
const inFlight = new Map();   // session id -> Set(Session)
const track = (s) => {
  if (typeof(s.sessionId) !== 'string') return;
  if (!inFlight.has(s.sessionId)) inFlight.set(s.sessionId, new Set());
  inFlight.get(s.sessionId).add(s);
};
const untrack = (s) => {
  const set = typeof(s.sessionId) === 'string' ? inFlight.get(s.sessionId) : null;
  if (set == null) return;
  set.delete(s);
  if (set.size === 0) inFlight.delete(s.sessionId);
};
const everyCall = new Set();   // every call under way, for a terminal tightening

Session.prototype.installTimer = function(callback) {
  const ms = callLimitsLib().of(this).requestTimeout;
  const timer  = new Timer(ms);
  this.timer = timer;
  this.timerStart = Date.now();
  this.deadline = this.timerStart + (Number.isFinite(ms) ? ms : options.requestTimeout);
  track(this);
  everyCall.add(this);
  timer.once('expired', (timer) => {
    clearTimeout(timer.timeout);
    untrack(this);
    everyCall.delete(this);
    return this.callback(new CountinghouseError('DEVICE_NOT_RESPONDING'), null);
  });
  callback(null, timer);
};

// The call's timer again, at its start plus its timeout as it is now (a
// tightening's): fires at once when that moment has passed. Its deadline
// only ever moves earlier: a tightening, a raise and a smaller tightening
// within one call keep the first (#271's review, 2).
Session.prototype.rearm = function() {
  const timer = this.timer;
  if (timer == null || timer.expired === true) return;
  const ms = callLimitsLib().of(this).requestTimeout;
  const start = this.timerStart || Date.now();
  const deadline = Math.min(Number.isFinite(this.deadline) ? this.deadline : Infinity, start + ms);
  if (deadline === this.deadline) return;
  this.deadline = deadline;
  const left = Math.max(0, deadline - Date.now());
  clearTimeout(timer.timeout);
  timer.timeout = setTimeout(timer.expire.bind(timer), Math.min(left, 2147483647));
};

// A hop's call, held to its caller's: the token entry's override and its
// session, main-side, so a tightening re-arms the hop's timer too and every
// check takes the session's values now (#271's review, 1). A function of the
// call's object, whatever user-auth handed over.
Session.holdTo = (call, tokenEntry) => {
  call.limits = (tokenEntry != null && tokenEntry.limits) || null;
  call.sessionId = (tokenEntry != null && typeof(tokenEntry.session) === 'string') ? tokenEntry.session : null;
};

Session.prototype.clearDeviceTimer = function() {
  if (this.timer != null) {
    clearTimeout(this.timer.timeout);
    this.timer = null;
  }
  untrack(this);
  everyCall.delete(this);
};

// a session's tightening: its calls under way; a terminal one: every call
Session.rearmSession = (id) => { for (const s of [...(inFlight.get(id) || [])]) s.rearm(); };
Session.rearmAll = () => { for (const s of [...everyCall]) s.rearm(); };
Session.inFlightCount = (id) => (inFlight.get(id) || new Set()).size;


module.exports = Session;
