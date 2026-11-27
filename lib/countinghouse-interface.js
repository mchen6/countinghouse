'use strict';
const events        = require('events');
const util          = require('util');
const isMainThread  = require('worker_threads').isMainThread;
const options       = require('./cli-options');
const handlerCtx    = require('./handler-ctx');
const DeviceManager = require('./device-manager');
const LOG           = require('./logger');
const cdifUtil      = require('./countinghouse-util');

const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const {setRetryAfter} = require('./countinghouse-error');
const {ledgerRefusal} = require('./rate-limit-gate');

function CdifInterface(mm) {
  this.deviceManager = new DeviceManager(mm);

  // set dm to countinghouse util instance
  cdifUtil.dm = this.deviceManager;
  cdifUtil.ci = this;

  this.rateLimiter = null;
  this.meteringProvider = null;

  // --heapDump (a dev aid): every minute, a full GC and the heap used, logged.
  // It needs node --expose-gc (bin/countinghouse and `npm run start-heap-dump`
  // pass it); without it, it says so once and does nothing, never throwing
  // every minute.
  if (options.heapDump === true) {
    if (typeof(global.gc) !== 'function') {
      LOG.W('--heapDump needs node --expose-gc (bin/countinghouse passes it): no heap is logged');
    } else {
      const t = setInterval(() => {
        global.gc();
        LOG.I(`heap used: ${process.memoryUsage().heapUsed}`);
      }, 1 * 60 * 1000);
      if (typeof(t.unref) === 'function') t.unref();
    }
  }

  // --globalRateLimit's limiter is the store's (lib/store.js); its client
  // answers while Redis is down (review M5, lib/redis-resilient.js).
  if (options.globalRateLimit != null && isMainThread === true) {
    this.rateLimiter = require('./store').getStore().globalLimiter;
  }

  // On the main thread only (review M6). Metering runs there: the routed
  // path (DeviceManager.prototype.sendInvokeActionMessageToWorker), the peer
  // broker (PeerChannelBroker.prototype.handleMeteringRequest) and sessions.
  // A worker used to build its own provider on db 0, the balance ledger,
  // and module code reaches its worker's CdifInterface (CHUtil.ci, a
  // documented gap), so a module could recordCall(anyKey, t, -N) to credit a
  // key or +N to debit anyone. A worker holds none: recordCall and
  // checkBalance answer SYSTEM_ERROR there and rateLimit answers "not limited", which
  // nothing in a worker reaches (a worker's invokeDeviceAction gets a bare
  // callback as its session). This removes the worker's ready, connected
  // handle on the ledger; it is not network isolation (module code can still
  // open its own connections until sandbox parts 3 and 4,
  // docs/security-model.md).
  //
  // checkBalance (lib/routes/balance.js) doesn't depend on rate limiting
  // being configured. The per-apiKey rateLimit stays inert unless
  // --apiKeyRateLimit is set (RedisMeteringProvider only builds its internal
  // rolling-rate-limiter when rateLimitMaxPerInterval is given).
  // The provider is the store's (lib/store.js): RedisMeteringProvider on db
  // 0 in --store redis, as before.
  if (isMainThread === true) {
    this.meteringProvider = require('./store').getStore().metering;
  }
}

util.inherits(CdifInterface, events.EventEmitter);

CdifInterface.prototype.discoverAll = function(session) {
  this.deviceManager.emit('discoverall', session);
};

CdifInterface.prototype.stopDiscoverAll = function(session) {
  this.deviceManager.emit('stopdiscoverall', session);
};

CdifInterface.prototype.getDiscoveredDeviceList = function(session) {
  this.deviceManager.emit('devicelist', session);
};

CdifInterface.prototype.invokeDeviceAction = function(deviceID, serviceID, actionName, args, session) {
  // Every entry path funnels through here, so this is where the caller's
  // identity becomes available to a handler's ctx (lib/handler-ctx.js).
  // Previously only lib/routes/invoke-action.js set args.ctx, so an action
  // reached over MCP -- the primary surface -- had no caller context at all.
  //
  // It is the *identity*, never the Session, and that is load-bearing rather
  // than tidiness: args travels into worker threads (structured clone) and
  // into job payloads (bullmq serializes them). A Session holds req/res, which
  // are circular and uncloneable, so putting one here deadlocks the
  // task-augmented path instead of failing visibly.
  //
  // Left alone when `session` is not an object: on worker re-entry it is a
  // bare callback, and args.ctx already carries the forwarded identity.
  if (args != null && session != null && typeof(session) === 'object') {
    args.ctx = handlerCtx.wireIdentityOf(session);
    // the key a call that stays on this thread bills, never on args.ctx and
    // never carried to a worker or a task's data (R2-1 Task 5)
    handlerCtx.attachBilling(args, session);
  }

  const _this = this;
  const doInvoke = function() {
    _this.deviceManager.emit('invokeaction', deviceID, serviceID, actionName, args, session);
  };
  return callGate(this, session, (refusal) => (refusal != null ? session.callbackWithoutTimer(refusal, null) : doInvoke()));
};

// A call's gates, in order: the server-wide limit (--globalRateLimit, on the
// main thread), then its key's own (keyGate) -> cb(null) to go on, or
// cb(the refusal). A call already through them (session.gated: a retry
// gated before its single-use state was spent, lib/mcp/gateway.js) is not
// gated or counted again.
// (over the interface it is given -- its rateLimiter and rateLimit -- as
// invokeDeviceAction runs it)
function callGate(ci, session, cb) {
  if (session.gated === true) return cb(null);
  const key = () => keyGate(ci, session, cb);
  if (ci.rateLimiter == null || isMainThread !== true) return key();
  return ci.rateLimiter('globalratelimit', (err, timeLeft) => {
    // (a limiter that can't answer fails closed, as the per-key one)
    if (err) return cb(new CountinghouseError('RUNTIME_BUSY'));
    // the whole runtime at its limit: the runtime's, not the caller's, 503
    // with when to retry (#482's high, 1; its window the store's,
    // lib/store.js GLOBAL_LIMIT_WINDOW_MS)
    if (timeLeft) return cb(setRetryAfter(new CountinghouseError('RUNTIME_BUSY'), timeLeft, require('./store').GLOBAL_LIMIT_WINDOW_MS));
    return key();
  });
}
CdifInterface.prototype.callGate = function(session, cb) { return callGate(this, session, cb); };

// cancelled (optional): asked before the job is sent to its worker; true once
// the job processor has given up on this run (its timeout), so nothing starts
// for it.
// extraArgs (optional): the job processor's start hook's object for this run.
CdifInterface.prototype.invokeJobs = function(deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) {
    this.deviceManager.emit('invokejobs', deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs);
};


CdifInterface.prototype.getDeviceSpec = function(deviceID, session) {
  this.deviceManager.emit('getspec', deviceID, session);
};

CdifInterface.prototype.getDevicePackageInfo = function(deviceID, callback) {
  this.deviceManager.emit('getdevicepackageinfo', deviceID, callback);
};

CdifInterface.prototype.getDeviceSchema = function(deviceID, path, session) {
  this.deviceManager.emit('getschema', deviceID, path, session);
};

CdifInterface.prototype.checkBalance = function(apiKey, callback) {
  if (this.meteringProvider == null) return callback(new CountinghouseError('SYSTEM_ERROR'));
  return this.meteringProvider.checkBalance(apiKey, callback);
};

// A successful call, recorded: every entry path bills through here (a
// tools/call, an invoke-action, a hop, a peer invoke, a job's run), so it is
// also where the listen hub learns of it ('callrecorded', M8: a resource
// whose changesWith names the action may have changed). opts.session: the
// call's session on a shared runtime, or null. Said before metering
// answers, whatever it answers: the call ran. A worker records nothing (no
// provider), so module code can't say a call happened.
CdifInterface.prototype.recordCall = function(apiKey, tool, cost, callback, opts) {
  if (this.meteringProvider == null) return callback(new CountinghouseError('SYSTEM_ERROR'));
  const session = (opts != null && typeof(opts.session) === 'string') ? opts.session : null;
  // (a call with no key is not recorded, so it is not said either)
  if (apiKey != null) {
    try { this.emit('callrecorded', {apiKey, tool, session}); } catch (e) { /* a listener's error is never the call's */ }
  }
  return this.meteringProvider.recordCall(apiKey, tool, cost, callback);
};

// A call's own per-key gate -> cb(null) to go on, or cb(the refusal). A
// request that spent its key's unit at its own gate already
// (session.perKeySpent: a completion's action) is not counted again; the
// global limit still counts it. (A retry gated before its state was spent
// is session.gated, which callGate checks for both gates.)
// A billed call asks first whether its charge can be recorded (the owner's
// decision, 11-27); refused there, it runs nothing and is not counted by the
// per-key limiter.
function keyGate(ci, session, cb) {
  if (session.appKey == null || session.perKeySpent === true) return cb(null);
  return ci.rateLimit(session.appKey, (err, result) => {
    // (a check Redis cannot answer is decided by the same limit in memory,
    // lib/redis-resilient.js rateLimiter; an error left is the limiter's
    // own, and it fails closed: the runtime's RUNTIME_BUSY, never let
    // through -- the limiter PR's medium, 4; a ledger that can't be used
    // answers as itself)
    if (err) return cb(ledgerRefusal(err) || new CountinghouseError('RUNTIME_BUSY'));
    // (this key over its own budget: RATE_LIMIT_EXCEEDED, 429, as on every
    // other route, when to retry the limiter's own, clamped to its window)
    if (result.limited === true) return cb(setRetryAfter(new CountinghouseError('RATE_LIMIT_EXCEEDED'), result.timeLeft, result.windowMs));
    return cb(null);
  }, {billed: session.billed === true});
}
CdifInterface.prototype.keyGate = function(session, cb) { return keyGate(this, session, cb); };

// With no meteringProvider there is no per-key limit to apply: not limited
// (not a failure; unlike checkBalance/recordCall, which have nothing to
// answer from). A limiter that errors is refused by its callers, RUNTIME_BUSY
// (keyGate above, lib/rate-limit-gate.js).
CdifInterface.prototype.rateLimit = function(apiKey, callback, opts) {
  if (this.meteringProvider == null) return callback(null, {limited: false});
  // (a call nothing would charge is limited as an unbilled one: never refused for the ledger)
  const asked = (opts != null && opts.billed === true && !charges()) ? Object.assign({}, opts, {billed: false}) : opts;
  return this.meteringProvider.rateLimit(apiKey, callback, asked);
};

// Whether a call is charged at all: every gated path (a tools/call, an
// invoke-action, a hop, a peer invoke, a remote call, a job's run) charges
// --mcpToolCallCost, 0 by default. A call nothing would charge is not
// billed, so it is never refused for its charge -- a runtime with no cost
// set, ch-local's included, is not gated (a local --meter ledger that is
// corrupt or unreadable still refuses at its limiter, as it does unbilled
// calls). A stored-result resources/read is charged at its own
// --resourceReadCost before it serves, and refused if that charge fails, so
// it needs no gate.
function charges() {
  return typeof(options.mcpToolCallCost) === 'number' && options.mcpToolCallCost > 0;
}

// A charge lost after its call ran, said by the key's fingerprint, the tool,
// the amount and the error's code (lib/metering/charge-bound.js chargeLost):
// for a caller that holds this interface and nothing of metering's own.
CdifInterface.prototype.logLostCharge = function(tool, apiKey, cost, err) {
  try { require('./logger').E(require('./metering/charge-bound').chargeLost(tool, apiKey, cost, err)); } catch (e) { /* no logger */ }
};

// Whether a charge for apiKey can be recorded now -> callback(null), or
// callback(the catalogued retryable refusal): asked before a billed job run
// or hop runs (the owner's decision, 11-27). No provider: nothing recorded;
// nothing to charge (no --mcpToolCallCost): nothing to refuse for.
CdifInterface.prototype.chargeable = function(apiKey, callback) {
  if (this.meteringProvider == null || apiKey == null || !charges()) return callback(null);
  return this.meteringProvider.chargeable(apiKey, callback);
};

module.exports = CdifInterface;
