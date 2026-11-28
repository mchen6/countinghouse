'use strict';
// What both job runners share (lib/job-control.js over BullMQ, and
// lib/job-control-local.js for --store local, LM1): the bounds on what one
// add-job may ask for, the job-ownership checks, and the scheduler ids.
// Pure functions and constants, no queue.
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const {CODES} = require('./error-catalogue');

// The longest delay setTimeout honours.
const MAX_TIMER_MS = 2147483647;

// Job failures bullmq must not retry (see the processor's reject path): the
// module is gone until an operator acts.
// SETTING_REQUIRED (module settings, section 4.6): a run refused for a
// setting the user has not set repeats until they set it.
// (MODULE_NOT_LISTED: a device not listed to the caller; ACTION_NOT_FOUND:
// an action missing, or one the load found unusable, #400, answered alike
// since post-rel caller 400; another attempt finds either the same)
const SETTING_NAME = require('./module-settings').NAME;
const NOT_RETRIED = new Set(['MODULE_UNLOADED', 'MODULE_SUSPENDED', 'SYSTEM_ERROR_UNKNOWN_USER', 'SETTING_REQUIRED', 'MODULE_NOT_LISTED', 'ACTION_NOT_FOUND']);
// A run's error that a retry could only repeat. In shared mode also
// DEVICE_NOT_FOUND (B3 Task 4) once startup discovery has finished (the
// reviewer's ruling (6)(b) on #341): a run into a pack its session doesn't
// list is answered so, and a device never hosted the same way, retries and
// all; before discovery both are retried alike, so a job that races the
// start isn't lost. err: the run's error, tagged by the device manager.
function notRetried(code, err = null) {
  if (NOT_RETRIED.has(code)) return true;
  // an error that left a module handler is the module's answer, whatever its
  // code: not retryable (countinghouse-error HANDLER_ROW), so not retried
  // (#482's high, round 3, 1)
  if (require('./countinghouse-error').fromHandler(err)) return true;
  // a module's error its module said is the caller's: the same input fails
  // the same way, so a retry would only count it again (the medium on the
  // kind-caller PR, 5)
  try { if (err != null && err.origin === 'module' && err.kind === 'caller') return true; } catch (e) { /* a getter that throws: retried as before */ }
  return code === 'DEVICE_NOT_FOUND' && require('./sessions').shared() === true && err != null && err.afterDiscovery === true;
}

// A failed run's text as the runner stores it (BullMQ keeps a failure only
// as a string): "CODE: message", decoded by lib/mcp/gateway.js taskFailure.
// A 2026-07-28 task's status mirrors how the same tools/call is answered
// inline (ext-tasks, tasks.md l.157-158 and l.835-837: `failed` only for a
// request that fails with a JSON-RPC error, never for a tool result with
// isError, which is `completed`). Every run that reaches here was answered
// by the call -- the handler's own error, a crash, a validation refusal, the
// module unloaded, reloaded or suspended under it: inline, each is an
// isError result (lib/mcp/gateway.js toolCallResult) -- so a modern task's
// is marked CALL_ANSWERED, and tasks/get reports it completed with that
// result. What stays failed never reaches the call's answer: the runner's
// timeout, a refused auth re-check (authorizeRun, outside this). The mark
// is lower case, so it is never a code, and only the runner writes it.
const CALL_ANSWERED = 'call-answered: ';

// How long a task's question holds its job: the gateway's ask hooks' own
// length (askHooks.holdMs), else two hours. The one default both runners
// read.
const HOLD_DEFAULT_MS = 2 * 3600 * 1000;
function holdMsOf(hooks) {
  return (hooks != null && typeof(hooks.holdMs) === 'function') ? hooks.holdMs() : HOLD_DEFAULT_MS;
}

// A pass's usage call, closed once (F2-2; ruled M1 on #487): the one helper
// both runners keep a pass's call with. open() opens one by the start hook
// (its errors logged: the pass then has no call, never an earlier pass's);
// close(outcome) closes it by the end hook, once; closedByAsk() counts the
// gateway's asked hook's own close (it closed the call when it wrote the
// question); cancel(jobId) ends it at shutdown by the cancel hook, if
// still open; failure() is the call a failure is recorded on -- the pass's
// if still open, else one of its own, opened for it (never in the pass's
// place: extra() stays the pass's) -- closed by the completion hook the
// runner then calls. Never a failure with no call, never a call closed
// twice.
//   runner     {startHook, endHook, cancelHook}, read at each use
//   data       the job's data
//   session    -> the run's session, read at each open
//   log        (e) for an error a hook threw
function passCall(runner, data, session, log) {
  // (a logger that throws -- none set up yet -- never breaks a pass)
  const logged = (e) => { try { log(e); } catch (x) { /* no logger */ } };
  let extra = null;
  let open = false;
  const started = () => {
    if (typeof(runner.startHook) !== 'function') return null;
    try { return runner.startHook(data, session()); } catch (e) { logged(e); return null; }
  };
  const opened = () => {
    open = true;
    extra = started();
    return extra;
  };
  return {
    open: opened,
    extra: () => extra,
    isOpen: () => open,
    closedByAsk: () => { open = false; },
    close: (outcome) => {
      if (!open) return;
      open = false;
      if (typeof(runner.endHook) === 'function') {
        try { runner.endHook(data, {extra}, outcome); } catch (e) { logged(e); }
      }
    },
    failure: () => {
      if (!open) return started();
      open = false;
      return extra;
    },
    // at shutdown (the runner's close(), B-shutdown-usage): the pass's call,
    // if still open, ended as cancelled by the cancel hook, synchronously
    cancel: (jobId) => {
      if (!open) return;
      open = false;
      if (typeof(runner.cancelHook) === 'function') {
        try { runner.cancelHook(data, {extra, jobId}); } catch (e) { logged(e); }
      }
    }
  };
}

// A run's time limit: its job's own timeout (validated where it comes in;
// one stored otherwise, an older record's, counts as none), else the
// default (--jobTimeout); clamped to setTimeout's maximum; null for none.
// The one rule both runners bound a run by (F2-2's medium).
function runLimitMs(jobOpts, defaultMs) {
  const own = (jobOpts != null && Number.isInteger(jobOpts.timeout) && jobOpts.timeout > 0) ? jobOpts.timeout : null;
  const wanted = (own != null) ? own : (defaultMs > 0 ? defaultMs : null);
  return (wanted != null) ? Math.min(wanted, MAX_TIMER_MS) : null;
}
// A run past its timeout (both runners): the catalogued JOB_TIMEOUT as the
// job's failedReason, "JOB_TIMEOUT: <text>" (a runner stores only the
// message), so taskFailure decodes its code. Never CALL_ANSWERED: no answer
// ever existed, so a 2026-07-28 task's run fails (the Reviewer's ruling).
function timeoutError(ms) {
  const seconds = String(Number((Number(ms) / 1000).toFixed(3)));
  const text = CountinghouseError.withFields('JOB_TIMEOUT', {seconds: seconds}).message;
  return Object.assign(new Error(`JOB_TIMEOUT: ${text}`), {code: 'JOB_TIMEOUT'});
}
// A SETTING_REQUIRED's setting names ride after MISSING_SETTINGS (each a
// declared setting name, [a-z][a-zA-Z0-9_]*), so the task's result names
// them as the call's does (lib/mcp/gateway.js taskFailure).
const MISSING_SETTINGS = '\u001fmissingSettings=';
// An error that left a module handler (lib/countinghouse-error.js
// fromHandler) rides as this mark after its text, so a task's answer and a
// job's record say it as the inline answer does: kind module, 500 (#482's
// high, round 2, 5)
const FROM_HANDLER_MARK = '\u001ffromHandler';
function failureText(err, data) {
  // the separator never in the error's own text, so only this line writes it
  let coded = ((err.code != null) ? `${err.code}: ${err.message}` : String(err.message)).replace(/\u001f/g, ' ');
  if (require('./countinghouse-error').fromHandler(err)) coded += FROM_HANDLER_MARK;
  const missing = (err.code === 'SETTING_REQUIRED' && err.fields != null && Array.isArray(err.fields.missingSettings)) ? err.fields.missingSettings : null;
  if (missing != null && missing.every((n) => typeof(n) === 'string' && SETTING_NAME.test(n))) coded += `${MISSING_SETTINGS}${missing.join(',')}`;
  return (data != null && data.era === 'modern') ? `${CALL_ANSWERED}${coded}` : coded;
}
// The runner's marks in a failure's text, read in this one place, by every
// reader that says a failure to a client (a task's answer, a legacy task's
// statusMessage, a job's public record and its stacktrace): the text
// without them, and what they said (the medium on #482's round 2, 1, 3, 9).
// failureText writes \u001f only in a mark.
const MARKS = /\u001f(?:fromHandler|missingSettings=[a-zA-Z0-9_,]*)/g;
function decodeFailedReason(raw) {
  let text = String(raw);
  const answered = text.startsWith(CALL_ANSWERED);
  if (answered) text = text.slice(CALL_ANSWERED.length);
  const fromHandler = text.includes(FROM_HANDLER_MARK);
  let missingSettings = null;
  const at = text.lastIndexOf(MISSING_SETTINGS);
  if (at !== -1) {
    const names = text.slice(at + MISSING_SETTINGS.length).split(',');
    if (names.every((n) => SETTING_NAME.test(n))) missingSettings = names;
  }
  return {text: text.replace(MARKS, ''), answered, fromHandler, missingSettings};
}
// a text with the marks taken out, anything else of it kept
const withoutMarks = (s) => (typeof(s) === 'string' ? s.replace(MARKS, '') : s);

// What one add-job may ask for. A job's runs are not rate limited -- only
// creating it is (lib/routes/add-job.js, lib/mcp/gateway.js) -- so these keep
// one rate-limited request from becoming unbounded work: a repeating job at
// most once a second, and at most 10 attempts. A cron pattern's finest step
// is a second, so it needs no check of its own.
const MIN_REPEAT_EVERY_MS = 1000;
const MAX_ATTEMPTS        = 10;

function isWhole(n) {
  return typeof(n) === 'number' && Number.isInteger(n);
}

// A 2026-07-28 task's id (MCP completeness M15): minted by the gateway, 128
// random bits, never the runner's own counting ids (the extension needs an
// unguessable taskId). Its form, checked where a job is added.
const TASK_ID = /^t-[0-9a-f]{32}$/;

function jobOptsError(jobOpts) {
  if (jobOpts.taskId != null && !(typeof(jobOpts.taskId) === 'string' && TASK_ID.test(jobOpts.taskId))) return 'a task id is the gateway\'s minted one';
  if (jobOpts.taskId != null && jobOpts.repeat != null) return 'a task is never repeated';
  if (jobOpts.attempts != null && !(isWhole(jobOpts.attempts) && jobOpts.attempts >= 1 && jobOpts.attempts <= MAX_ATTEMPTS)) {
    return `attempts must be a whole number from 1 to ${MAX_ATTEMPTS}`;
  }
  if (jobOpts.timeout != null && !(isWhole(jobOpts.timeout) && jobOpts.timeout >= 1)) {
    return 'timeout must be a whole number of milliseconds, at least 1';
  }
  const repeat = jobOpts.repeat;
  if (repeat == null) return null;
  if (typeof(repeat) !== 'object') return 'repeat must be an object with every or cron';
  if (repeat.cron != null) {
    if (typeof(repeat.cron) !== 'string') return 'repeat.cron must be a cron pattern string';
  } else if (!(isWhole(repeat.every) && repeat.every >= MIN_REPEAT_EVERY_MS)) {
    return `repeat.every must be a whole number of milliseconds, at least ${MIN_REPEAT_EVERY_MS}`;
  }
  if (repeat.limit != null && !(isWhole(repeat.limit) && repeat.limit >= 1)) return 'repeat.limit must be a whole number, at least 1';
  return null;
}

// --- job ownership (S1/S5) ---
//
// Every job records the owner that created it by opaque id (jobData.ownerId,
// from the *authenticated* identity by addJob below -- never from anything
// the requester supplied, see addJob's own comment; never the key itself). Every read/mutate entry
// point then takes an `authCtx` as its FIRST argument and refuses to touch a
// job the caller doesn't own.
//
// The check lives here rather than in lib/mcp/gateway.js because there are
// two independent front doors onto the same jobs -- the MCP tasks/* methods
// and the HTTP /devices/:deviceID/{get,remove}-job(-history) routes. Gating
// only the gateway would leave the HTTP routes as a bypass (exactly the
// shape of the gap docs/cross-cutting-matrix.md exists to prevent), so the
// gate is put at the single point both funnel through.
//
// authCtx is one of:
//   {appKey: <string>, isAdmin: <bool>}  a tenant-originated request
//   JobControl.INTERNAL                   platform-internal call (see below)
//
// Anything else -- null, undefined, a missing appKey -- is denied. Fail
// closed: an unauthenticated caller has no owner identity to match against,
// so it can never match one.
const INTERNAL = {internal: true};

// A repeatable job's scheduler id: the caller's name, scoped to its owner.
// The id was the raw name in one shared queue, and bullmq upserts schedulers
// with override, so another tenant posting the same name replaced the first
// tenant's scheduler, its later runs then owned and billed to the second
// (review R3-2). The owner's opaque id, so the id never carries the key.
// (The identity is ready before the server listens: lib/identity.js.)
function schedulerId(authCtx, name) {
  if (authCtx === INTERNAL || authCtx == null || authCtx.appKey == null) return name;
  return `${require('./identity').idForKey(authCtx.appKey)}:${name}`;
}

// A job records its owner by opaque id (jobData.ownerId, lib/identity.js),
// never by its key: not in its data, a scheduler's template or the history
// (B-meter-keys (2); CLAUDE.md). The key is made known to the identity
// index first (identity.know: a refill for a key it doesn't hold yet), so
// it is found again from the id before every run (authorizeOwner). A job
// with no owner (an internal path's) is nobody's, so only an admin can
// reach it: treating "no owner" as "everyone's" is exactly the original
// gap. A job's session is not its data's: it is the main thread's, in
// memory (lib/job-sessions.js, B1 Task 3), so nothing here stores it.
// sessionOfCtx: the client session a job is created in (authCtx.session,
// which only the gateway sets), or null.
// -> Promise of {ownerId} (or {} for an internal path); rejects
// SYSTEM_ERROR_USERDB_NA when the provider could not be asked.
function ownerData(authCtx) {
  if (authCtx === INTERNAL || authCtx == null || authCtx.appKey == null) return Promise.resolve({});
  const options = require('./cli-options');
  const identity = require('./identity');
  // (inside the promise: a provider that throws while it is asked is the
  // same refusal, never a throw out of addJob)
  // (--debug accepts every key, its single-identity profile's included: a
  // key the provider doesn't list is remembered, never refused -- #518's
  // high, L4 b)
  return Promise.resolve().then(() => identity.know(authCtx.appKey, () => require('./auth').identitySource(options), {rememberUnlisted: options.debug === true})).then((id) => {
    if (id == null) return Promise.reject(new CountinghouseError('SYSTEM_ERROR_USERDB_NA'));
    return {ownerId: id};
  }, () => Promise.reject(new CountinghouseError('SYSTEM_ERROR_USERDB_NA')));
}

// What a run's call carries for the main thread beside the start hook's
// answer, when set: the owner's key (the run's token bills the owner), the
// run's timeout (which bounds that token), and the job's session and its
// values (run: lib/job-sessions.js forRun, for the token). None is sent on to
// the worker (lib/job-args.js). Set over the start hook's answer
// unconditionally: the hook cannot name them (#141 N6); absent when unset.
// The run's owner key as authorizeRun resolved it: an owned job whose key did
// not come back is refused for good, never run unbilled (fail closed: #518's
// high, L1). -> the key (null for a job with no owner); throws otherwise.
// A run billed to its owner's key runs only while that charge can be
// recorded (the owner's decision, 11-27): asked after the owner check, before
// anything runs. -> Promise: resolved, or rejected with the catalogued
// retryable refusal (LEDGER_UNREACHABLE, LEDGER_UNWRITABLE...), which fails
// the run as one its attempts may retry. A run with no owner key isn't billed.
// (the refusal said as "CODE: text", as authorizeOwner's are, so the run's
// failure keeps its code for tasks/result; retried as the catalogue says)
function chargeableRun(cdifInterface, ownerKey) {
  if (ownerKey == null || cdifInterface == null || typeof(cdifInterface.chargeable) !== 'function') return Promise.resolve();
  return new Promise((resolve, reject) => cdifInterface.chargeable(ownerKey, (refusal) => {
    if (refusal == null) return resolve();
    const code = refusal.code;
    const entry = (code != null && Object.prototype.hasOwnProperty.call(CODES, code)) ? CODES[code] : null;
    return reject(Object.assign(new Error(`${code}: ${refusal.message}`), {code, retry: entry != null ? entry.retryable === true : true}));
  }));
}

function ownerKeyAuthorized(data, key) {
  if (ownerIdOf(data) != null && (key == null || key === '')) {
    throw Object.assign(new Error(`SYSTEM_ERROR_UNKNOWN_USER: ${new CountinghouseError('SYSTEM_ERROR_UNKNOWN_USER').message}`), {final: true, retry: false});
  }
  return key != null ? key : null;
}

// The add, once the owner is known (both runners): on its own turn, outside
// the promise, a throw in it answered to the callback, never thrown on the
// main thread (#518's high, L4 a), the callback answered once; and refused
// when the caller's session ended meanwhile (authCtx.stillOpen, the
// gateway's: #518's high, M2) -- in the tick the job's session is
// remembered in.
function addWhenOwned(authCtx, callback, add) {
  let answered = false;
  const once = (...a) => { if (answered) return undefined; answered = true; return callback(...a); };
  ownerData(authCtx).then((owner) => process.nextTick(() => {
    try {
      if (authCtx != null && typeof(authCtx.stillOpen) === 'function' && authCtx.stillOpen() !== true) {
        return once(Object.assign(new CountinghouseError('MODULE_NOT_LISTED'), {sessionEnded: true}));
      }
      return add(owner, once);
    } catch (e) {
      try { require('./logger').E(e); } catch (logErr) { /* no logger */ }
      return once(new CountinghouseError('ADD_JOB_ERROR', 'the job could not be added'));
    }
  }), (err) => process.nextTick(once, err));
}

function withRunBookkeeping(extra, ownerKey, timeoutMs, run = null) {
  const out = Object.assign({}, extra, {ownerKey: ownerKey, timeoutMs: timeoutMs,
    session: run != null ? run.session : null, limits: run != null ? run.limits : null});
  for (const k of ['ownerKey', 'timeoutMs', 'session', 'limits']) if (out[k] == null) delete out[k];
  return out;
}
// Whether the caller's session sees a job its owner session made (B5 Task
// 2, by lib/session-scope.js): INTERNAL sees every job; outside shared mode
// every job is seen (the owner key decides, as before); in shared mode only
// the session that made it does, admin or not. Asked before ownsJob, and a
// job not seen is answered as an id never issued.
function seesJob(authCtx, ownerSession) {
  if (authCtx === INTERNAL) return true;
  const scope = require('./session-scope');
  return scope.sees(scope.of(authCtx != null ? authCtx.session : null), ownerSession == null ? null : ownerSession);
}
function sessionOfCtx(authCtx) {
  return (authCtx != null && authCtx !== INTERNAL && typeof(authCtx.session) === 'string') ? authCtx.session : null;
}
function ownerIdOf(data) {
  return (data != null && data.ownerId != null) ? String(data.ownerId) : null;
}
// The owner's key, for authorization and billing, from the identity index;
// null when the job has no owner, or its owner is not in the index (a
// removed key; a --debug owner after a restart) -- authorizeOwner refills
// once and says which before a run gets here.
function ownerKeyOf(data) {
  const id = ownerIdOf(data);
  if (id == null) return null;
  const found = require('./identity').lookup(id);
  return (found != null) ? found.apiKey : null;
}

function ownsJob(authCtx, jobData) {
  if (authCtx === INTERNAL) return true;
  if (authCtx == null || authCtx.appKey == null) return false;
  if (authCtx.isAdmin === true) return true;
  if (jobData == null) return false;
  const owner = ownerIdOf(jobData);
  return owner != null && owner === require('./identity').idForKey(authCtx.appKey);
}

function denied(authCtx) {
  // "you didn't authenticate" is said; a job another key owns is answered as
  // one never issued, JOB_NOT_FOUND, so no caller learns which job ids
  // exist (post-rel caller 400)
  if (authCtx == null || authCtx.appKey == null) return new CountinghouseError('SYSTEM_ERROR_UNKNOWN_USER');
  return new CountinghouseError('JOB_NOT_FOUND');
}

// A job's history, the last 20 distinct runs its caller owns, from the
// store's kv (this server's jobinfo:<its queue prefix>:<name>, jobInfoKeyFor;
// written by saveJobInfo), the same for both runners.
function getJobHistory(authCtx, name, callback) {
  if (authCtx !== INTERNAL && (authCtx == null || authCtx.appKey == null)) {
    return callback(denied(authCtx));
  }

  // (no server id: answered as an error, never thrown past the callback)
  let jobInfoKey;
  try { jobInfoKey = jobInfoKeyFor(name); } catch (e) { return callback(new CountinghouseError('GET_JOB_ERROR', e.message)); }
  //TODO: make this value configurable
  require('./redis-api').client.lrange(jobInfoKey, 0, -1, (err, data) => {
    // (an error is a CountinghouseError, never a bare string: post-rel
    // caller 400)
    if (err) return callback(new CountinghouseError('GET_JOB_ERROR', err.message));
    if (data == null) return callback(new CountinghouseError('GET_JOB_ERROR'));

    const keyList = {};
    const jsonRet = [];

    let cap = 0;
    data.forEach((item) => {
      if (cap >= 20) return;

      const parsedItem = JSON.parse(item);
      const jobID = parsedItem.job.id;

      if (ownsHistory(authCtx, parsedItem.job.data) !== true) return;

      if (keyList[jobID] == null) {
        keyList[jobID] = parsedItem;
        jsonRet.push(parsedItem);
        cap++;
      }
    });

    return callback(null, jsonRet);
  });
}

// One state change of a job, kept in the store's kv as getJobHistory reads it.
// The record of a job both runners answer getJob and listJobs with.
function jobRecord(job) {
  return {
    id: job.id, name: job.name, data: job.data, opts: job.opts, progress: job.progress, delay: job.delay,
    timestamp: job.timestamp, attemptsMade: job.attemptsMade, failedReason: job.failedReason,
    stacktrace: job.stacktrace, returnvalue: job.returnvalue, finishedOn: job.finishedOn, processedOn: job.processedOn
  };
}

// A record as a client sees it: without the internal output-schema stamp.
function publicRecord(record) {
  if (record == null || record.job == null) return record;
  let job = record.job;
  if (job.data != null && 'outputSchemaHash' in job.data) {
    const data = Object.assign({}, job.data);
    delete data.outputSchemaHash;
    job = Object.assign({}, job, {data: data});
  }
  // (a failure that left a handler: said as the module's; the runner's marks
  // never reach a client, from the reason or the stacktrace whose first line
  // repeats it; #482's high, round 2, 5, and the medium on it, 3)
  if (typeof(job.failedReason) === 'string' && job.failedReason.includes('\u001f')) {
    const fields = {failedReason: withoutMarks(job.failedReason)};
    if (decodeFailedReason(job.failedReason).fromHandler) fields.failedKind = 'module';
    job = Object.assign({}, job, fields);
  }
  if (Array.isArray(job.stacktrace) && job.stacktrace.some((line) => typeof(line) === 'string' && line.includes('\u001f'))) {
    job = Object.assign({}, job, {stacktrace: job.stacktrace.map(withoutMarks)});
  }
  return job === record.job ? record : Object.assign({}, record, {job: job});
}

// The owner's key never goes into the history: it is kept in the store's
// kv, which under --store local is a file (the reviewer's ruling: no file
// under --storePath holds a key; review of B5). The record names its owner
// by the R2-1 caller id (lib/identity.js: a server-secret HMAC, the review of
// #163), not by an unsalted hash of the key.
function historyData(data) {
  if (data == null || typeof(data) !== 'object' || data.ownerId == null) return data;
  return Object.assign({}, data, {owner: String(data.ownerId)});
}
// The owner check for a history record: as a job's (ownsJob), or by its
// owner tag, the caller's id.
function ownsHistory(authCtx, data) {
  if (ownsJob(authCtx, data)) return true;
  if (data == null || data.owner == null || authCtx == null || authCtx.appKey == null) return false;
  return require('./identity').idForKey(authCtx.appKey) === data.owner;
}

// The owner may still call the action: checked before every run of a job
// (both runners). Resolves, or rejects with an Error whose `final` says
// whether the refusal is final (a revoked grant or a removed key) or the
// run is to be retried (an auth backend that is unreachable, or that did
// not answer within ms). The message names the code only: an auth error's
// message may hold the key.
// The owner is found from its id in the identity index; a miss waits for a
// refill whose provider read starts after it (identity.freshRefill: one at
// a time, at most once per 5 s, so a removed owner's schedulers don't each
// scan the provider, and a miss is never decided on a read from before it --
// #518's high, M1), then is final, saying which case it is, never the key
// (B-meter-keys (2)): a key no longer in the auth configuration, or, with no
// listing provider (--debug), an owner this process no longer knows
// (identity.OWNER_LOST_WITHOUT_PROVIDER). A refill that fails is retried.
// -> Promise of the owner's key (null for a job with no owner): the run
// bills that key, as checked now, even if the owner leaves the index while
// it runs.
// identity.freshRefill bounded by the run's own deadline, ms: a slow or hung
// provider is a retry, never a run held open
function boundedRefill(provider, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('the owner refill did not answer in time'), {code: 'IDENTITY_REFILL_TIMEOUT'})), ms);
    require('./identity').freshRefill(provider).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
function authorizeOwner(data, jobID, ms) {
  const id = ownerIdOf(data);
  if (id == null) return Promise.resolve(null);
  const known = ownerKeyOf(data);
  // (asked only on a miss, or when the index's key is refused)
  const providerOf = () => require('./auth').identitySource(require('./cli-options'));
  if (known != null) {
    // A key rotated under a stable id on a provider with no change signal
    // (sqlite, CouchDB, no reload since): the index still holds the old key,
    // which auth no longer knows. One refill (throttled and bounded, as a
    // miss's) and the key it finds, if another, is checked before the run
    // is refused for good and a scheduler deleted (the final pass's gateway
    // part, A2).
    // (one deadline, ms, for the whole of it: each step takes what is left,
    // and none left is a retry -- the medium on this PR, 4)
    // (a monotonic clock: a wall-clock step never stretches or cuts it -- #526's high, L5)
    const monotonic = () => require('perf_hooks').performance.now();
    const deadline = monotonic() + ms;
    const left = () => deadline - monotonic();
    const retry = () => Promise.reject(Object.assign(new Error(`SYSTEM_ERROR_USERDB_NA: ${new CountinghouseError('SYSTEM_ERROR_USERDB_NA').message}`), {final: false}));
    return checkOwner(data, jobID, ms, known).catch((err) => {
      const provider = providerOf();
      if (err == null || err.final !== true || !/^SYSTEM_ERROR_UNKNOWN_USER\b/.test(String(err.message))
        || provider == null || typeof(provider.entries) !== 'function') return Promise.reject(err);
      if (left() <= 0) return retry();
      return boundedRefill(provider, left()).then(() => {
        const again = ownerKeyOf(data);
        if (again == null || again === known) return Promise.reject(err);
        return left() > 0 ? checkOwner(data, jobID, left(), again) : retry();
      }, retry);
    });
  }
  const provider = providerOf();
  const listing = provider != null && typeof(provider.entries) === 'function';
  // (with no listing provider, only a remembered key can be lost; with one
  // under --debug, which also remembers keys it doesn't list, either case)
  const debug = require('./cli-options').debug === true;
  const why = !listing ? require('./identity').OWNER_LOST_WITHOUT_PROVIDER
    : debug ? 'the job\'s owner is no longer in the auth configuration, nor held by this process (--debug)'
      : 'the job\'s owner is no longer in the auth configuration';
  const unknown = () => Object.assign(new Error(`SYSTEM_ERROR_UNKNOWN_USER: ${new CountinghouseError('SYSTEM_ERROR_UNKNOWN_USER').message} (${why})`), {final: true});
  // (the refill bounded by the run's own deadline, ms: a slow or hung
  // provider is a retry, never a run held open -- the medium on #518's high
  // round)
  // (one monotonic deadline for the refill and the check after it: the
  // medium on #526's round, 7)
  const missDeadline = require('perf_hooks').performance.now() + ms;
  const missLeft = () => missDeadline - require('perf_hooks').performance.now();
  const refilled = listing ? boundedRefill(provider, ms) : Promise.resolve();
  return refilled.then(() => {
    const ownerKey = ownerKeyOf(data);
    if (ownerKey == null) return Promise.reject(unknown());
    if (missLeft() <= 0) return Promise.reject(Object.assign(new Error(`SYSTEM_ERROR_USERDB_NA: ${new CountinghouseError('SYSTEM_ERROR_USERDB_NA').message}`), {final: false}));
    return checkOwner(data, jobID, missLeft(), ownerKey);
  }, () => Promise.reject(Object.assign(new Error(`SYSTEM_ERROR_USERDB_NA: ${new CountinghouseError('SYSTEM_ERROR_USERDB_NA').message}`), {final: false})));
}
function checkOwner(data, jobID, ms, ownerKey) {
  const userAuth = require('./user-auth');
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      try { require('./logger').E(new Error(`job ${String(jobID).slice(0, 32)}: the owner's authorization did not answer within ${ms} ms; the run fails and is retried`)); } catch (logErr) { /* no logger */ }
      reject(Object.assign(new Error(`SYSTEM_ERROR_USERDB_NA: ${new CountinghouseError('SYSTEM_ERROR_USERDB_NA').message}`), {final: false}));
    }, ms);
    userAuth(null, null, data.deviceID, ownerKey, data.serviceID, data.actionName, () => {}, (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err == null) return resolve(ownerKey);
      const code = (err.code != null) ? err.code : 'SYSTEM_ERROR_UNKNOWN_USER';
      const failMessage = `${code}: ${new CountinghouseError(code).message}`;
      // (a store down, or the limit on keys that don't resolve: both pass,
      // so the run is retried, never failed for good)
      return reject(Object.assign(new Error(failMessage), {final: code !== 'SYSTEM_ERROR_USERDB_NA' && code !== 'UNAUTH_RATE_LIMITED'}));
    });
  });
}

function saveJobInfo(job, state) {
  // Not kept where nothing reads it back (F1-5): it holds a task's input and
  // output under its tool's name, with no session and no expiry, and its one
  // reader is the HTTP get-job-history route, which the single-identity
  // profile (--stdio or --sessionSocket: ch-local's) never serves, nor does
  // --stdio on Redis without --port (a session whose list, its process's
  // own, no later process could read either: the medium review of #463's
  // --stdio ruling). Asked first: no record is made, and no owner tag
  // taken, for nothing.
  const opts = require('./cli-options');
  if (opts.singleIdentity === true || (opts.stdio === true && opts.stdioWithPort !== true)) return;
  const record = jobRecord(job);
  record.data = historyData(record.data);
  const result = {job: record, state: state};

  // the store's kv; before it is set up (a bare process) there is no
  // history to keep
  const client = require('./redis-api').client;
  if (client == null) return;
  // (no server id: logged, never thrown into the job event that saves it)
  let jobInfoKey;
  try { jobInfoKey = jobInfoKeyFor(result.job.name); } catch (e) {
    try { require('./logger').E(e); } catch (logErr) { /* no logger */ }
    return;
  }
  client.lpush(jobInfoKey, JSON.stringify(result));
  // since on each event emission we rpush job's current state to the list, it may contain duplicate jobIDs due to:
  // 1) repeat jobs which each iteration has different job IDs,
  // 2) single job ID with status update, which the latest result is pushed to the head of the list and will be retrieved by getJobHistory()
  // so the list would look like: {id15}, {id15}, ... {id1}, {id1}
  // here we estimate 200 is a big enough length to hold 20 final state records of different jobIDs (repeat job)
  client.ltrim(jobInfoKey, 0, 200);
}

// The job queue's Redis prefix (B-j1): this server's own, so two runtimes on
// one Redis never take each other's jobs (it was '{cdifJob}' for every
// runtime). Its server id (lib/server-id.js: random, kept beside its data,
// never derived from key material): the same across restarts, so jobs
// queued before one are still this server's; another server's, with its own
// data directory and so its own id, is another. Braces kept: a Redis Cluster
// hash tag, so a queue's keys share a slot.
// A --stdio runtime is one session: its tasks end with its client, and its
// job history is served over no HTTP. Two of them on one data directory
// (two MCP clients each spawning countinghouse --stdio with the defaults)
// are two sessions, not one server: each has a queue of its own, the server
// id and a random suffix made once per process ({chj-<id>-<8 hex>}), and
// makes no claim (lib/job-control.js claimServerId). Nothing is shared, and
// nothing taken; tasks an earlier process of that client queued are not run
// (the reviewer's ruling on #463's round 2).
const LEGACY_JOB_QUEUE_PREFIX = '{cdifJob}';
const queuePrefixFrom = (serverId, suffix = null) => `{chj-${serverId}${suffix != null ? `-${suffix}` : ''}}`;
// (the suffix: made by the first caller, and the same for this process's
// life; a test process keeps one for every --stdio case it runs)
let sessionSuffix = null;
function jobQueuePrefix() {
  const id = require('./server-id').get();
  if (require('./cli-options').stdio !== true) return queuePrefixFrom(id);
  if (sessionSuffix == null) sessionSuffix = require('crypto').randomBytes(4).toString('hex');
  return queuePrefixFrom(id, sessionSuffix);
}
// A job's history list (getJobHistory, saveJobInfo) is this server's too:
// with a queue of its own, job ids are no longer unique across runtimes on
// one Redis, and two servers' records under one name would hide each other.
// Fails closed: with no server id (a start runs lib/server-id.js initSync
// before anything is served; a test sets one up) there is no key, never
// the unscoped one of before (the high review of #463's round 2, 7).
function jobInfoKeyFor(name) {
  return `jobinfo:${jobQueuePrefix()}:${name}`;
}

module.exports = {
  FROM_HANDLER_MARK, decodeFailedReason, chargeableRun,
  LEGACY_JOB_QUEUE_PREFIX, queuePrefixFrom, jobQueuePrefix,
  timeoutError,
  runLimitMs,
  holdMsOf,
  passCall,
  TASK_ID, CALL_ANSWERED, MISSING_SETTINGS, failureText, getJobHistory, saveJobInfo, jobRecord, publicRecord, authorizeOwner, MAX_TIMER_MS, NOT_RETRIED, notRetried, MIN_REPEAT_EVERY_MS, MAX_ATTEMPTS, isWhole, jobOptsError,
  INTERNAL, schedulerId, ownsJob, denied, ownerData, addWhenOwned, ownerIdOf, ownerKeyOf, ownerKeyAuthorized, withRunBookkeeping, sessionOfCtx, seesJob};
