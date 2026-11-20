'use strict';
// The `ctx` a 6.0.0 handler receives:  async (input, ctx) => ({output})
//
// ctx replaces the Device instance that used to be bound as `this`. That is a
// deliberate narrowing, not a rename. Binding the device handed every handler
// the framework's own surface -- setAction, deviceControl, connect,
// initServices and eleven more -- which is why CHUtil.inherits has a
// "prevent child override" loop copying those methods back over any the module
// tried to replace. ctx is that wall built as a front door instead: handlers
// get what handlers need, and the framework internals are simply not reachable.
//
// ctx.caller is a plain, serializable object on purpose. The Session it is
// derived from cannot cross a worker boundary (it holds req/res, timers and
// bound functions) -- lib/device-manager.js used to delete args.ctx outright
// for exactly that reason, with a comment saying so. Sending the identity
// rather than the session is what lets a handler know who is calling in
// worker-thread mode, which is the default and where it previously could not.
// (taken at load: boot-time, before module code)
const {isProgress} = require('./progress-value');
const options     = require('./cli-options');
// worker_threads at load, before a worker's lockdown: callRemoteAddress runs
// in a module's call, under the lockdown, which refuses the builtin
// (test/remote/09). The module object, read at call time, so a test may
// still stand in for isMainThread (test/remote/07).
const workerThreads = require('worker_threads');
// call-address.js has no requires beyond uuid-1345 (see its own header
// comment), so it is safe to require at module scope even on the serverless
// validator path. countinghouse-util.js is NOT: it opens a Redis client at
// require time when isMainThread === true, and handler-ctx.js is reached by
// that path too (module-validator.js -> handler-map-module.js -> here), so
// CHUtil is required lazily inside buildCtx below, on a ctx helper's first
// use (so a lean worker whose handlers use none never loads it: lean worker
// step 3, Task 5) -- every ctx method, including call, reads it through
// that one closure-scoped function.
const callAddress = require('./call-address');
// Same reasoning: countinghouse-error.js requires cli-options and nothing
// else, so it is safe at module scope on the validator path too. ctx.call's
// refusals are CountinghouseErrors rather than plain Errors on purpose -- see the
// comment on the guard clauses in `call` below.
const {CountinghouseError, issue, hopError} = require('./countinghouse-error');
// What the decisions below call after module code has run, taken when this
// file loads (at a worker's boot, before any module code): a module shares
// the realm and could replace these.
const ReflectApply = Reflect.apply;
const uncurry = (fn) => Function.prototype.call.bind(fn);
const StringStartsWith = uncurry(String.prototype.startsWith);
const StringSlice = uncurry(String.prototype.slice);
const RegExpExec = uncurry(RegExp.prototype.exec);
const ObjectHasOwn = Object.hasOwn;
const ObjectKeys = Object.keys;
const ObjectDefineProperty = Object.defineProperty;
const ArrayIsArrayHC = Array.isArray;
// a declared target, by index (Array.prototype.includes is module code's to
// replace, and would say yes to anything)
const declaredIn = (list, target) => { for (let i = 0; i < list.length; i++) if (list[i] === target) return true; return false; };
// a field set as the object's own: the device a handler runs against holds
// its composition (its binding) and its waiting calls, so nothing of it is
// assigned through a setter module code put on Object.prototype
const setOwnHC = (o, key, value) => ObjectDefineProperty(o, key, {__proto__: null, value: value, writable: true, enumerable: true, configurable: true});
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectFreeze = Object.freeze;
const StructuredClone = structuredClone;
const StringCtor = String;
const ArrayIsArray = Array.isArray;
const NumberIsFinite = Number.isFinite;
// a's own enumerable values, then b's, as a new object's own (no setter on
// a prototype runs, and no Object.assign a module replaced sees b)
const copyInto = (out, o) => {
  if (o == null) return out;
  const keys = ObjectKeys(o);
  for (let i = 0; i < keys.length; i++) ObjectDefineProperty(out, keys[i], {__proto__: null, value: o[keys[i]], writable: true, enumerable: true, configurable: true});
  return out;
};
// (no prototype: a field the copy lacks is never read through a getter
// module code put on Object.prototype)
const ownCopy = (a, b) => copyInto(copyInto({__proto__: null}, a), b);
// an own data property's value, or undefined (never a getter's answer)
const ownData = (o, key) => {
  try {
    const d = ObjectGetOwnPropertyDescriptor(o, key);
    return (d != null && ObjectHasOwn(d, 'value')) ? d.value : undefined;
  } catch (e) {
    return undefined;
  }
};

// The main thread's identity, required on first use, then kept (a worker
// never reads it). What a worker's calls go through is loaded with this
// file, at the worker's boot, before module code: a require on the call path
// would return whatever module code had put in require.cache by then.
let identityHeld = null;
const identityLib = () => (identityHeld != null ? identityHeld : (identityHeld = require('./identity')));
const callLimits = require('./call-limits');
const chutilRuntime = require('./chutil-facade').runtime;
// A refusal the runtime gives a module's ctx.call or ctx.serviceClient is
// issued (d2b): a module
// that passes it on answers with the runtime's code and origin, which a
// module's own error never has. A callee's own error (origin module) is not.
// The refusal issued is a new one of the runtime's, made from the error's
// own code and message (read as own data, never a getter's answer): an
// object that only looks like a runtime error (CountinghouseError.prototype
// in its chain, an origin getter) is never what gets the brand. Its other
// own data fields come along as they are (the callee's .fault, details, a
// limit's fields), read as own data, never a getter's answer; its origin,
// code and message are the fresh error's own.
const refuse = (err) => {
  if (!(err instanceof CountinghouseError) || ownData(err, 'origin') === 'module') return err;
  const code = ownData(err, 'code');
  const message = ownData(err, 'message');
  if (typeof(code) !== 'string') return err;
  const fresh = new CountinghouseError(code);
  if (typeof(message) === 'string') ObjectDefineProperty(fresh, 'message', {__proto__: null, value: message, enumerable: true, writable: true, configurable: true});
  let keys = [];
  try { keys = ObjectKeys(err); } catch (e) { keys = []; }
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === 'origin' || keys[i] === 'code' || keys[i] === 'message') continue;
    let d = null;
    try { d = ObjectGetOwnPropertyDescriptor(err, keys[i]); } catch (e) { d = null; }
    if (d != null && ObjectHasOwn(d, 'value')) ObjectDefineProperty(fresh, keys[i], {__proto__: null, value: d.value, enumerable: true, writable: true, configurable: true});
  }
  return issue(fresh);
};

// Module settings (the module-level configuration design, section 4.5): the
// call's args.settings is {v} or {v, values} (lib/settings-gate.js); module
// settings run only with worker threads, so nothing else is taken. A worker
// keeps the values of the last
// SETTINGS_KEPT versions it was given, in the order it was given them (the
// main thread keeps the same ring for it, so it never sends a version
// without values this worker has dropped). ctx.settings is that version's
// values: frozen, no prototype, an unset setting absent; read once per call,
// so a call keeps the values it started with.
const SETTINGS_KEPT = require('./settings-ring').KEPT;
const EMPTY_SETTINGS = ObjectFreeze({__proto__: null});
const settingsByVersion = {__proto__: null};
const settingsRing = new Array(SETTINGS_KEPT).fill(null);
let settingsRingAt = 0;
// a field read from a message's object: its own data value (ownData), else
// undefined; nothing for a value that is no object
const ownField = (o, key) => ((o == null || typeof(o) !== 'object') ? undefined : ownData(o, key));
// a message's values, frozen, no prototype, own data fields only
function frozenValues(values) {
  const keys = ObjectKeys(values);
  const copy = {__proto__: null};
  for (let i = 0; i < keys.length; i++) setOwnHC(copy, keys[i], ownField(values, keys[i]));
  return ObjectFreeze(copy);
}
// The values a message carries (`container`: a call's args, or a peer
// match's metering reply), kept for their version as the message arrives,
// before anything in this worker can refuse it: the main thread counts a
// version as this worker's once it has posted it (lib/settings-gate.js).
function holdSettings(container) {
  const s = ownField(container, 'settings');
  if (s == null || typeof(s) !== 'object') return;
  const v = ownField(s, 'v');
  const values = ownField(s, 'values');
  if (!NumberIsFinite(v) || values == null || typeof(values) !== 'object' || ObjectHasOwn(settingsByVersion, v)) return;
  const dropped = settingsRing[settingsRingAt];
  if (dropped != null) delete settingsByVersion[dropped];
  settingsRing[settingsRingAt] = v;
  settingsRingAt = (settingsRingAt + 1) % SETTINGS_KEPT;
  settingsByVersion[v] = frozenValues(values);
}
// Whether a call's settings are here: none carried, its values with it, or
// its version's kept. One that is not runs no handler (lib/lean-worker.js
// invokeHere): never a handler with settings it was not meant to have.
function settingsHeld(args) {
  const s = ownField(args, 'settings');
  if (s == null || typeof(s) !== 'object') return true;
  // a version is required, as settingsOf reads only a version's values: one
  // without (a bare {values}) is never held, so no handler runs on empty
  // settings after the required check passed
  const v = ownField(s, 'v');
  if (!NumberIsFinite(v)) return false;
  const values = ownField(s, 'values');
  if (values != null && typeof(values) === 'object') return true;
  return ObjectHasOwn(settingsByVersion, v);
}
function settingsOf(args) {
  const s = ownField(args, 'settings');
  if (s == null || typeof(s) !== 'object') return EMPTY_SETTINGS;
  holdSettings(args);
  const v = ownField(s, 'v');
  if (NumberIsFinite(v) && ObjectHasOwn(settingsByVersion, v)) return settingsByVersion[v];
  return EMPTY_SETTINGS;
}

// The caller a handler sees (R2-1 Task 5, spec section 2): {id, isAdmin},
// the opaque id and the admin flag, never a key or a user name. Built on the
// main thread (wireIdentityOf) and forwarded as is across a worker boundary.
function callerIdentityOf(wire) {
  if (wire == null || typeof wire !== 'object') return {id: null, isAdmin: false};
  return {id: (typeof(wire.id) === 'string') ? wire.id : null, isAdmin: wire.isAdmin === true};
}

// Who pays for what a call does next, for a call that stays on the main
// thread (single-thread mode, which isolates nothing): the caller's key, or
// a hop's billing key, on the call's args under a private Symbol, which no
// structured clone and no JSON carries, so it never reaches a worker or a
// task's stored data. A worker's call bills by its token instead
// (R2-1 Task 5), and has no key at all.
const BILLING_KEY = Symbol('countinghouse.billingKey');
function billingKeyOf(args) {
  return (args != null && typeof(args) === 'object' && args[BILLING_KEY] != null) ? args[BILLING_KEY] : null;
}
function attachBilling(args, session) {
  if (args == null || typeof(args) !== 'object' || session == null || typeof(session) !== 'object') return;
  const key = (session.billingKey != null) ? session.billingKey : session.appKey;
  if (key != null) args[BILLING_KEY] = key;
}

// A call's ask context (ctx.ask, lib/module-ask.js), for a call that stays
// on the main thread, where a call has no token: {state, module, serviceID,
// actionName, spec}, on the call's args under a Symbol of this file's, as
// its billing key is. That keeps it out of the handler's input, not out of
// its reach: single-thread mode isolates nothing, and code that holds the
// args finds it with Object.getOwnPropertySymbols. A worker's call asks by
// its token instead, and its state never leaves the main thread.
const ASK = Symbol('countinghouse.ask');
function askContextOf(args) {
  return (args != null && typeof(args) === 'object' && args[ASK] != null) ? args[ASK] : null;
}
function attachAsk(args, context) {
  if (args == null || typeof(args) !== 'object' || context == null || typeof(context) !== 'object' || Array.isArray(context)) return;
  args[ASK] = context;
}
// The values of a question's placeholders as they are sent on: own
// properties that are strings, finite numbers or booleans, at most 64 of
// them, a string cut to 1000 characters (the dialog takes 200). Anything
// else is null, which the main thread refuses if the message names it.
// Nothing of a value is run: no getter's result is trusted to be the same
// twice, no toString is called.
const MAX_ASK_VALUES = 64;
const MAX_ASK_VALUE_CHARS = 1000;
// (copied into an object with no prototype, by functions taken at load: no
// setter module code put on Object.prototype sees a value, nor the copy)
function plainValues(values) {
  const out = {__proto__: null};
  if (values == null || typeof(values) !== 'object' || ArrayIsArray(values)) return out;
  const keys = ObjectKeys(values);
  const n = keys.length < MAX_ASK_VALUES ? keys.length : MAX_ASK_VALUES;
  for (let i = 0; i < n; i++) {
    const key = keys[i];
    let v = null;
    try { v = values[key]; } catch (e) { v = null; }
    if (typeof(v) === 'string') {
      if (v.length > MAX_ASK_VALUE_CHARS) v = StringSlice(v, 0, MAX_ASK_VALUE_CHARS);
    } else if (!((typeof(v) === 'number' && NumberIsFinite(v)) || typeof(v) === 'boolean')) {
      v = null;
    }
    ObjectDefineProperty(out, key, {__proto__: null, value: v, writable: true, enumerable: true, configurable: true});
  }
  return out;
}

// The serializable form of a Session's caller, sent with the call (and to a
// worker): {id, isAdmin}, computed on the main thread.
function wireIdentityOf(session) {
  if (session == null || typeof session !== 'object') return null;
  return identityLib().callerOf(session.appKey, session.isAdmin === true);
}

// A cached ServiceClient is shared by every caller of this device, so the
// billing identity cannot live on it. This hands each call its own view: the
// same underlying client, with `billingKey` attached per invoke. No mutation
// of shared state, so concurrent callers cannot bill each other.
// `usageCall` (RC1-min step 5) is the tools/call the outer invoke runs
// under, set here whatever the module states, so a part's remote calls are
// recorded under it too; the main thread checks it on the hop.
// `token` (R2-1 Task 3) is the call's per-call token, set here whatever the
// module states: the main thread bills and checks the hop by it.
// `device` (R2-1 Task 4): in single-thread mode, where no main-thread hop
// check runs, the hop's target must be among the calling module's resolved
// declarations (its composition's targets), as spec section 8 asks; a
// module with no verdict or no declarations can hop nowhere. In worker mode
// the main thread decides, and this check is not made.
function billingWrapper(client, billingKey, usageCall, token, device) {
  return {
    invoke: (opts, cb) => {
      if (options.workerThread !== true && workerThreads.isMainThread === true) {
        const comp = (device != null) ? device._composition : null;
        const target = `${client.deviceID}|${client.serviceID}|${opts != null ? opts.actionName : null}`;
        if (comp == null || !ArrayIsArrayHC(comp.targets) || !declaredIn(comp.targets, target)) {
          // (issued: the runtime's refusal, never read as the module's: the
          // high review of #445, 1)
          const err = refuse(new CountinghouseError('CTX_CALL_UNDECLARED', `${client.serviceID}/${opts != null ? opts.actionName : null}`));
          return (typeof(cb) === 'function') ? cb(err, null) : undefined;
        }
      }
      const withBilling = ownCopy(opts, {billingKey: billingKey, usageCall: usageCall, token: token});
      return client.invoke(withBilling, cb);
    },
    deviceID:  client.deviceID,
    serviceID: client.serviceID
  };
}

// RC1-min (docs/superpowers/specs/2026-11-11-rc1-min-remote-mcp-design.md,
// section 4): ctx.call('remote:<name>/<tool>', args) reaches the module's
// declared remote MCP server through the main thread, which holds the
// credential and finds the remote by the module that owns the call. A
// remote is not a device: countinghouse.calls and runsModules play no part.
// Resolves with the CallToolResult as the server sent it.
const REMOTE_ADDRESS = /^remote:([a-z][a-z0-9-]{0,31})\/(.+)$/;
function callRemoteAddress(device, billingKey, address, input, usageCall, token) {
  const m = RegExpExec(REMOTE_ADDRESS, address);
  if (m == null) {
    return Promise.reject(refuse(new CountinghouseError('REMOTE_ARGS_INVALID', `not a remote address: ${StringSlice(address, 0, 80)}`)));
  }
  // The arguments as the main thread will see them in either mode: a
  // structured clone (a class instance arrives as a plain object, a
  // function or a symbol cannot cross), checked before anything is sent.
  let args = input;
  try {
    args = (input === undefined) ? undefined : StructuredClone(input);
  } catch (e) {
    return Promise.reject(refuse(new CountinghouseError('REMOTE_ARGS_INVALID', 'the arguments must be a plain JSON object')));
  }
  // token (R2-1 Task 3): the main thread bills a worker's remote call by
  // it; a key is stated only on the main thread (single-thread mode).
  const data = {remote: m[1], tool: m[2], args: args, usageCall: usageCall, token: token};
  if (workerThreads.isMainThread === true) data.billingKey = billingKey;
  if (workerThreads.isMainThread !== true) {
    // over the worker's own channel, through countinghouse-util as the lean
    // worker attached it (lib/chutil-facade.js)
    const util = chutilRuntime();
    return new Promise((resolve, reject) => util.__remoteCall(data, (err, result) => (err != null ? reject(err) : resolve(result))));
  }
  const moduleName = (device != null) ? device.moduleName : null;
  // (single-thread: the remote's failures as the worker's hop hands them on,
  // hopError: its refusals, REMOTE_TIMEOUT, REMOTE_UNDECLARED,
  // CALL_TOKEN_INVALID, issued, anything else a plain Error with its message,
  // so both modes answer alike: the high review of #445, 1, and its medium, 6)
  return require('./remote').callRemote(moduleName, data.remote, data.tool, data.args, {billingKey: data.billingKey, usageCall: usageCall, token: token}).then(undefined, (e) => Promise.reject(hopError(e)));
}

// Built fresh per call. The ctx object itself is never cached, because
// ctx.caller differs per call and a ctx that outlived its call would be a way
// to bill the wrong identity.
// A call's own progress (MCP completeness M21, spec section 6), in the
// worker: ctx.job.progress(n) outside a task. post(n) sends it to the main
// thread; this bounds how often, whatever a module does: at most one post per
// MIN_POST_MS per call, the latest value winning; anything but a number from
// 0 to 100 dropped here; nothing after end() (the call has answered). The
// main thread then keeps only the call's own root token's reports, and its
// notifier the rest of the rules (lib/mcp/progress.js).
const MIN_POST_MS = 250;
function callProgressPoster(post, {now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  let last = -Infinity;
  // the highest value posted: the main thread drops anything at or below it,
  // so a lower value is dropped here and never replaces a higher pending one
  let highest = -Infinity;
  let pending = null;
  let timer = null;
  let ended = false;
  const flush = () => {
    timer = null;
    if (ended || pending == null) return;
    const v = pending;
    pending = null;
    last = now();
    highest = v;
    try { post(v); } catch (e) { /* the call goes on */ }
  };
  return {
    progress(n) {
      if (ended || !isProgress(n)) return;
      if (n <= highest || (pending != null && n <= pending)) return;
      pending = n;
      if (timer != null) return;
      const wait = last + MIN_POST_MS - now();
      if (wait <= 0) return flush();
      timer = setTimer(flush, wait);
      if (timer != null && typeof(timer.unref) === 'function') timer.unref();
    },
    end() {
      ended = true;
      pending = null;
      if (timer != null) { clearTimer(timer); timer = null; }
    }
  };
}
// ctx -> its call's end (the poster's), kept here so the handler's ctx has
// no extra member; lib/lean-dispatcher.js calls endCtx when the call answers
const enders = new WeakMap();
function endCtx(ctx) {
  const end = (ctx != null) ? enders.get(ctx) : null;
  if (end != null) { enders.delete(ctx); end(); }
}

function buildCtx(device, args, opts) {
  // When this call's handler started: ctx is built per call, and the wait for
  // a composition verdict counts from here, under the request's timer.
  const startedAt = Date.now();
  const o       = opts || {};
  // countinghouse-util, on first use, attached to a lean worker's state
  // (lib/chutil-facade.js); elsewhere as it always was
  const CHUtil  = chutilRuntime;
  // ctx.redis, made on its first read
  let redisClient;
  const caller  = callerIdentityOf(args != null ? args.ctx : null);
  const billingKey = billingKeyOf(args);
  const jobID   = (args != null && args.jobID != null) ? args.jobID : null;
  // The usage call id (lib/mcp/gateway.js, a task's run): kept in this
  // closure and passed on every hop and remote call, never put on ctx.
  const usageCall = (args != null && Number.isInteger(args.usageCall)) ? args.usageCall : null;
  // The call's per-call token (R2-1 Task 3, lib/call-tokens.js), issued by
  // the main thread when it sent this call: kept in this closure and sent on
  // every hop, device query and remote call, never put on ctx.
  const token = (args != null && typeof(args.token) === 'string') ? args.token : null;
  // the call's own progress (M21): posted by its token, which the main
  // thread checks is this worker's and the call's root
  // Posted only for a call whose client asked for progress: the main thread
  // sets wantsProgress with the call (lib/device-manager.js), never a hop's,
  // so a report nobody hears costs no message.
  const wantsProgress = token != null && jobID == null && args.wantsProgress === true;
  const callPoster = callProgressPoster((n) => { if (wantsProgress) CHUtil().callProgress(token, n); });

  // Bound to `const ctx` rather than returned as an object literal directly,
  // because `call` below invokes `ctx.serviceClient` by name -- it needs a
  // reference to the finished object, not to itself mid-construction.
  const ctx = {
    caller: caller,

    device: {
      deviceID:     (device != null) ? device.deviceID : null,
      friendlyName: (device != null && device.spec != null && device.spec.device != null)
                      ? device.spec.device.friendlyName : null
    },

    // the action being served, so a handler shared by several actions can tell
    serviceID:  (o.serviceID != null) ? o.serviceID : null,
    actionName: (o.actionName != null) ? o.actionName : null,

    httpHeaders: (args != null && args.httpHeaders != null) ? args.httpHeaders : null,

    // the module's settings for this call (section 4.5): frozen, read-only
    settings: settingsOf(args),

    // A setting this call needs and the user has not set, which the handler
    // cannot do without (section 4.6): `return ctx.settingRequired('defaultRepo')`
    // (or throw it). The main thread answers SETTING_REQUIRED in its own
    // words when the setting is declared by this module and unset in the
    // values this call ran with; any other claim is a module fault.
    settingRequired: (name) => {
      const claim = new CountinghouseError('SETTING_REQUIRED');
      ObjectDefineProperty(claim, 'message', {__proto__: null, value: StringSlice(StringCtor(name), 0, 64), enumerable: true, writable: true, configurable: true});
      return refuse(claim);
    },

    // a task's job, or (M21) the call's own: id null, progress the call's
    // own progress (posted at most every 250 ms, none after the answer; a
    // call without a token, single-thread mode, posts nothing), info an error
    job: (jobID != null) ? {
      id:       jobID,
      progress: (progress) => CHUtil().jobProgress(jobID, progress, token),
      info:     (cb) => CHUtil().jobInfo(jobID, cb)
    } : {
      id:       null,
      progress: (progress) => callPoster.progress(progress),
      info:     (cb) => { if (typeof(cb) === 'function') cb(new Error('ctx.job.info: this call is not a task')); }
    },

    log: (entry) => CHUtil().deviceLog(device, entry),

    // The module's own error (logger-design §5.1): returns it, never throws;
    // with a code of the runtime's catalogue it is warned of, and the
    // runtime answers it as MODULE_CODE_RESERVED (CountinghouseError.moduleOwn,
    // the boundary's conversion). A handler hands it
    // back by returning it (from a plain or an async function), throwing
    // it, or calling back with it -- the same answer.
    // opts, the fourth argument: {kind: 'caller'} says the caller is at fault
    // (input the schema could not rule out); the default is the module's
    error: (code, message, details, opts) => CountinghouseError.moduleOwn(code, message, details, (device != null && typeof(device.moduleName) === 'string') ? device.moduleName : null, opts),

    // Composition, with the two identities kept apart on purpose.
    //
    //   ctx.serviceClient({deviceID, serviceID, as: 'my-module-internal'}, cb)
    //
    // `as` is the module's own identity and is what gets authorized, so a
    // composing module can reach devices its callers cannot -- callers do not
    // need grants to whatever it calls internally, which is the encapsulation
    // the fixed-internal-identity approach gave. Billing is not that identity:
    // each inner hop is charged to ctx.caller, so per-hop cost lands on whoever
    // actually made the outer call. This is what docs/composite-tools.md listed
    // as a known simplification.
    //
    // `as` is required rather than defaulting to the caller: defaulting would
    // silently authorize inner hops as the end user, and every caller would
    // suddenly need grants to the inner devices.
    // Clients are cached on the device and keyed by what actually
    // distinguishes them (target + authorization identity), not per call.
    // Building one per call allocates a ServiceClient, a QueryDevice and a
    // device lookup on every invoke, which the benchmark turned into a dead
    // process after ~100k calls. The cached client is shared across callers,
    // so the billing identity rides on each invoke instead of being baked in.
    serviceClient: (opts, cb) => {
      const o = opts || {};
      if (typeof cb !== 'function') return;
      // R2-1 Task 5 (spec section 3): a module never names the identity a hop
      // authorizes as; it is the operator's binding, as for ctx.call.
      // refused whatever its value: a 7.x module passing `as:
      // ctx.caller.apiKey` (undefined now) must fail loudly, not run as the
      // binding (the review of 5b)
      if (ObjectHasOwn(o, 'as')) {
        return cb(new Error('ctx.serviceClient: identities come from the operator\'s runsModules binding; remove `as`'));
      }
      const build = () => {
        const comp = (device != null) ? device._composition : null;
        if (device != null && device._compositionSettled !== true) return cb(refuse(new CountinghouseError('CTX_CALL_NOT_READY', `${o.deviceID}/${o.serviceID}`)), null);
        if (comp == null || comp.identity == null) return cb(refuse(new CountinghouseError('CTX_CALL_UNBOUND', `${o.deviceID}/${o.serviceID}`)), null);
        // the binding is part of the key: a re-verification that moves it
        // (single-thread mode holds the real key there) gets a new client
        const key = `${o.deviceID}|${o.serviceID}|${comp.identity}`;
        if (device != null) {
          if (device._ctxServiceClients == null) setOwnHC(device, '_ctxServiceClients', {__proto__: null});
          const cached = device._ctxServiceClients[key];
          if (cached != null) return cb(null, billingWrapper(cached, billingKey, usageCall, token, device));
        }
        return CHUtil().createServiceClient({
          __proto__: null,
          deviceID:  o.deviceID,
          serviceID: o.serviceID,
          // single-thread mode authorizes on the main thread, as the binding
          // the composition holds there; a worker's hop names nothing, the
          // main thread authorizes it by its token
          appKey:    (options.workerThread !== true && workerThreads.isMainThread === true) ? comp.identity : undefined,
          token:     token            // the call's token, for the device query (R2-1 Task 3)
        }, (err, client) => {
          // a runtime refusal (SERVICE_NOT_FOUND, DEVICE_NOT_FOUND,
          // MODULE_UNLOADED, ...) is issued, as ctx.call's are (review of
          // #45); in a worker, query-device issues one decoded from the main
          // thread's reply
          if (err != null) return cb(refuse(err), null);
          if (device != null) setOwnHC(device._ctxServiceClients, key, client);
          return cb(null, billingWrapper(client, billingKey, usageCall, token, device));
        });
      };
      if (device == null || device._compositionSettled === true) return build();
      return untilVerdict(device, startedAt, token).then(build);
    },

    // Composition by name. The identity and the allowed set come from
    // load-time verification (see DeviceManager), not from the handler --
    // a module never names the identity it runs as.
    call: (address, input, opts) => {
      if (typeof(address) === 'string' && StringStartsWith(address, 'remote:')) return callRemoteAddress(device, billingKey, address, input, usageCall, token);
      const detail = (opts != null && opts.detail === true);

      // The composition window: a device still waiting for its verdict waits
      // for it first (bounded; untilVerdict), then reads the composition it
      // delivered. A settled device calls at once.
      const callNow = () => {
        const comp   = (device != null) ? device._composition : null;

        return new Promise((resolve, rejectWith) => {
          // Every rejection is issued when it is the runtime's own refusal
          // (refuse), on this one path, so a refusal added later is too (the
          // high review of #45).
          const reject = (err) => rejectWith(refuse(err));
          // CHUtil is the outer, lazy function from the top of
          // buildCtx (see the comment on the callAddress require at the top
          // of this file for why it can't be required at module scope).
          //
          // Every refusal below is a CountinghouseError, not a plain Error, and that
          // is the whole reason any of this reaches a client. lib/service.js's
          // `fail` keeps a CountinghouseError as-is and flattens everything
          // else to DEVICE_INVOKE_EXCEPTION (the original text goes into the
          // fault payload, which lib/mcp/gateway.js's toolCallResult does not
          // read) -- so as plain Errors, a typo'd address, a missing
          // runsModules binding and a callee that genuinely crashed were
          // indistinguishable to an MCP client. A code survives untouched:
          // over the worker hop DeviceManager.prototype.invokeAction re-wraps
          // as `CountinghouseError.fromReply(err)`, and toolCallResult puts it in
          // _meta['countinghouse/code']. For these runtime refusals that re-wrap
          // discards the message (only a module's own error crosses whole), so
          // each code's head text in the error catalogue says what to do on its
          // own; the detail passed here only survives in single-thread mode
          // and over REST /invoke-action.
          //
          // NOT_READY vs UNBOUND is a distinction about time, not config. This
        // is reached unsettled only after the bounded wait for a verdict
        // (untilVerdict) ran out, or the device was released unverified.
          // Composition verification is asynchronous and runs after discovery
          // (DeviceManager.prototype.onAllModulesDiscovered), while the device
          // is already listed and already serving. setComposition is the
          // delivery of a verdict -- including the empty verdict for a module
          // that declared no "countinghouse.calls" -- so "no verdict yet"
          // means the window, and telling that caller to go fix "runsModules"
          // sent them after a config that was already correct. A null device
          // is not a timing problem at all, so it falls through to UNBOUND.
          if (device != null && device._compositionSettled !== true) {
            return reject(new CountinghouseError('CTX_CALL_NOT_READY', address));
          }
          if (comp == null || comp.identity == null) {
            return reject(new CountinghouseError('CTX_CALL_UNBOUND', address));
          }
          if (!(typeof(address) === 'string' && ObjectHasOwn(comp.allowed, address) && comp.allowed[address] === true)) {
            return reject(new CountinghouseError('CTX_CALL_UNDECLARED', address));
          }

          const parsed = callAddress.parseAddress(address);
          if (parsed == null) {
            return reject(new CountinghouseError('CTX_CALL_BAD_ADDRESS', address));
          }

          const deviceID = callAddress.deviceIDForName(parsed.device);

          return CHUtil().queryDeviceSpec(deviceID, (specErr, spec) => {
            if (specErr != null) return reject(specErr);

            const resolved = callAddress.resolveAddress(spec, parsed);
            if (resolved.ok !== true) {
              return reject(new CountinghouseError('CTX_CALL_UNRESOLVED', resolved.message));
            }

            return ctx.serviceClient({deviceID: deviceID, serviceID: resolved.serviceID}, (clientErr, client) => {
              if (clientErr != null) return reject(clientErr);

              return client.invoke({actionName: parsed.action, input: input},
                (err, data, platformMetering) => {
                  if (err != null) {
                    // The callee's structured fault, when the path supplied one.
                    // Never invented, and never merged into `data`.
                    err.fault = (data != null) ? data : null;
                    return reject(err);
                  }
                  return resolve(detail ? {data: data, platformMetering: platformMetering} : data);
                });
            });
          }, {token: token});   // the call's token: the query is refused without it
        });
      };
      if (device == null || device._compositionSettled === true) return callNow();
      return untilVerdict(device, startedAt, token).then(callNow);
    },

    // The current call's counts so far (the reviewer, 2026-11-13, the pack
    // receipt; lib/usage/query.js): {calls, linesIn, bytesIn, tokensInEst,
    // servers: {name: calls}, sentence, standIn?}, its server calls and its
    // parts', or null when the call is not a counted one. Read-only.
    usage: () => {
      const data = {usageCall: usageCall, token: token};
      if (workerThreads.isMainThread === true) {
        try {
          return Promise.resolve(require('./usage/query').answerUsageQuery(data, undefined));
        } catch (e) {
          return Promise.reject(refuse(e));
        }
      }
      // over the worker's own channel, through countinghouse-util as the lean
      // worker attached it (lib/chutil-facade.js)
      return new Promise((resolve, reject) => CHUtil().__usageQuery(data, (err, result) => (err != null ? reject(err) : resolve(result))));
    },

    // A declared question for the user (the MCP completeness design, section
    // 8): ctx.ask(name, values) -> the answer's content, or null when the
    // user declined. The question is this action's own, from api.json; the
    // values fill its message's {name} placeholders. With no answer yet it
    // rejects ASK_PENDING, which ends the handler: the call is answered
    // with the question, and the handler runs again from the top when the
    // client retries. So ask first, act after. ASK_UNAVAILABLE (no one to
    // ask) may be caught to fall back. Always a promise, never a throw.
    ask: (name, values) => {
      let given;
      try { given = plainValues(values); } catch (e) { given = {__proto__: null}; }
      if (workerThreads.isMainThread === true) {
        try {
          return Promise.resolve(require('./module-ask').decide(askContextOf(args), name, given));
        } catch (e) {
          return Promise.reject(refuse(e));
        }
      }
      // a call that was given no token has no one to ask (never a token
      // error: a handler catches ASK_UNAVAILABLE to fall back)
      if (token == null) return Promise.reject(refuse(new CountinghouseError('ASK_UNAVAILABLE')));
      // over the worker's own channel, as ctx.usage's query goes
      return new Promise((resolve, reject) => CHUtil().__ask({token: token, name: name, values: given}, (err, result) => (err != null ? reject(err) : resolve(result))));
    },

    // app-layer bookkeeping only -- never touches balance. Platform metering
    // is the sole billing authority (docs/design-decisions.md).
    // returns {id, tool, cost, ts}: the caller's opaque id (R2-1 Task 5)
    recordUsage: (tool, cost, cb) => CHUtil().recordUsage(caller.id, tool, cost, cb),

    // per module (#164): in a worker the main thread puts each command in
    // the module's namespace; on the main thread (single-thread mode) this
    // client does it, by the module's name. Read on use, once per ctx.
    get redis() {
      if (redisClient === undefined) {
        redisClient = workerThreads.isMainThread === true ? require('./redis-api').namespacedClient(device != null ? device.moduleName : null) : CHUtil().redis;
      }
      return redisClient;
    },

    debug: options.debug === true
  };

  enders.set(ctx, () => callPoster.end());
  return ctx;
}

// Set at load by DeviceManager's composition verification, and again on
// every later re-verification. Kept on the device rather than on ctx
// because ctx is rebuilt per call.
//
// Calling this AT ALL is the verdict, whatever the verdict is: a bound
// composition, or null for "verified, nothing to bind" (a module with no
// "countinghouse.calls", or one whose re-verification just failed). Until
// it has been called for a device, that device's ctx.call refuses with
// CTX_CALL_NOT_READY instead of accusing the auth config -- which is why
// onAllModulesDiscovered must deliver the null verdict too, not skip it.
function setComposition(device, composition) {
  if (device == null) return;
  setOwnHC(device, '_composition', composition);
  setOwnHC(device, '_compositionSettled', true);
  releaseWaiters(device);
}

// Wakes every ctx.call waiting for this device's verdict; each then answers
// from what the device holds (a verdict, or still none: CTX_CALL_NOT_READY).
function releaseWaiters(device) {
  if (device == null) return;
  const waiters = device._verdictWaiters || [];
  setOwnHC(device, '_verdictWaiters', []);
  for (let i = 0; i < waiters.length; i++) waiters[i]();
}

// The composition window (reviewer, 2026-11-12; LM1 part C). A module is
// listed, and serving, before its composition has been verified and the
// verdict delivered (setComposition), and an agent calls a tool the moment it
// is listed. So ctx.call waits for this device's verdict, here on the device
// the handler runs against, which covers every way into a handler: a direct
// call, a job, a hop from another module. The wait is bounded under the
// request's own timer -- min(25 s, requestTimeout - 2 s), counted from the
// handler's start -- so that, still unverified at the bound, ctx.call
// answers CTX_CALL_NOT_READY as before and that code reaches the client
// rather than a timeout (test/composition/19). A hop is a request of its
// own, with its own timer and its own handler start, so a chain whose inner
// verdicts land long after its outer one can still outlast the outer timer.
// A handler that never calls ctx.call never waits, and nothing is kept
// anywhere but on the device, which a reload replaces.
const COMPOSITION_WAIT_MAX_MS = 25000;
const COMPOSITION_WAIT_MARGIN_MS = 2000;
// the call's own timeout (lib/call-limits.js, by its token), or the global one
function verdictWaitMs(token) {
  const t = Number(callLimits.forToken(token).requestTimeout);
  // lib/timer.js gives setTimeout the timer as it is: 0 or less expires at once.
  const timer = Number.isFinite(t) ? t : 30000;
  return Math.max(0, Math.min(COMPOSITION_WAIT_MAX_MS, timer - COMPOSITION_WAIT_MARGIN_MS));
}

function untilVerdict(device, startedAt = Date.now(), token = null) {
  if (device == null || device._compositionSettled === true) return Promise.resolve();
  const remaining = verdictWaitMs(token) - (Date.now() - startedAt);
  if (remaining <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const go = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      const left = [];
      const was = device._verdictWaiters || [];
      for (let i = 0; i < was.length; i++) if (was[i] !== go) setOwnHC(left, left.length, was[i]);
      setOwnHC(device, '_verdictWaiters', left);
      go();
    }, remaining);
    if (device._verdictWaiters == null) setOwnHC(device, '_verdictWaiters', []);
    setOwnHC(device._verdictWaiters, device._verdictWaiters.length, go);
  });
}

module.exports = {
  holdSettings:      holdSettings,
  settingsHeld:      settingsHeld,
  verdictWaitMs:     verdictWaitMs,   // (its per-call value, test/sandbox/54)
  buildCtx:          buildCtx,
  endCtx:            endCtx,
  callProgressPoster: callProgressPoster,
  callerIdentityOf:  callerIdentityOf,
  wireIdentityOf:    wireIdentityOf,
  setComposition:    setComposition,
  billingKeyOf:      billingKeyOf,
  attachBilling:     attachBilling,
  attachAsk:         attachAsk,
  releaseWaiters:    releaseWaiters,
  verdictWaitMs:     verdictWaitMs
};
