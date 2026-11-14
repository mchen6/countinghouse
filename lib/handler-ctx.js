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
// CHUtil is required lazily inside buildCtx below -- every ctx method,
// including call, reads it from that one closure-scoped binding.
const callAddress = require('./call-address');
// Same reasoning: countinghouse-error.js requires cli-options and nothing
// else, so it is safe at module scope on the validator path too. ctx.call's
// refusals are CountinghouseErrors rather than plain Errors on purpose -- see the
// comment on the guard clauses in `call` below.
const {CountinghouseError, issue} = require('./countinghouse-error');
// A refusal the runtime gives a module's ctx.call or ctx.serviceClient is
// issued (d2b): a module
// that passes it on answers with the runtime's code and origin, which a
// module's own error never has. A callee's own error (origin module) is not.
const refuse = (err) => ((err instanceof CountinghouseError && err.origin !== 'module') ? issue(err) : err);

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

// The serializable form of a Session's caller, sent with the call (and to a
// worker): {id, isAdmin}, computed on the main thread.
function wireIdentityOf(session) {
  if (session == null || typeof session !== 'object') return null;
  return require('./identity').callerOf(session.appKey, session.isAdmin === true);
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
        if (comp == null || !Array.isArray(comp.targets) || !comp.targets.includes(target)) {
          const err = new CountinghouseError('CTX_CALL_UNDECLARED', `${client.serviceID}/${opts != null ? opts.actionName : null}`);
          return (typeof(cb) === 'function') ? cb(err, null) : undefined;
        }
      }
      const withBilling = Object.assign({}, opts, {billingKey: billingKey, usageCall: usageCall, token: token});
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
  const m = REMOTE_ADDRESS.exec(address);
  if (m == null) {
    return Promise.reject(new CountinghouseError('REMOTE_ARGS_INVALID', `not a remote address: ${address.slice(0, 80)}`));
  }
  // The arguments as the main thread will see them in either mode: a
  // structured clone (a class instance arrives as a plain object, a
  // function or a symbol cannot cross), checked before anything is sent.
  let args = input;
  try {
    args = (input === undefined) ? undefined : structuredClone(input);
  } catch (e) {
    return Promise.reject(new CountinghouseError('REMOTE_ARGS_INVALID', 'the arguments must be a plain JSON object'));
  }
  // token (R2-1 Task 3): the main thread bills a worker's remote call by
  // it; a key is stated only on the main thread (single-thread mode).
  const data = {remote: m[1], tool: m[2], args: args, usageCall: usageCall, token: token};
  if (workerThreads.isMainThread === true) data.billingKey = billingKey;
  if (workerThreads.isMainThread !== true) {
    const CHUtil = require('./countinghouse-util');
    const wm = (CHUtil.dm != null) ? CHUtil.dm.workerMessage : null;
    if (wm == null) return Promise.reject(new CountinghouseError('CTX_CALL_NOT_READY', address));
    return new Promise((resolve, reject) => wm.sendRemoteCallToParent(data, (err, result) => (err != null ? reject(err) : resolve(result))));
  }
  const moduleName = (device != null) ? device.moduleName : null;
  return require('./remote').callRemote(moduleName, data.remote, data.tool, data.args, {billingKey: data.billingKey, usageCall: usageCall, token: token});
}

// Built fresh per call. The ctx object itself is never cached, because
// ctx.caller differs per call and a ctx that outlived its call would be a way
// to bill the wrong identity.
function buildCtx(device, args, opts) {
  // When this call's handler started: ctx is built per call, and the wait for
  // a composition verdict counts from here, under the request's timer.
  const startedAt = Date.now();
  const o       = opts || {};
  const CHUtil  = require('./countinghouse-util');
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

    // null outside a task, rather than an object whose methods no-op
    job: (jobID == null) ? null : {
      id:       jobID,
      progress: (progress) => CHUtil.jobProgress(jobID, progress),
      info:     (cb) => CHUtil.jobInfo(jobID, cb)
    },

    log: (entry) => CHUtil.deviceLog(device, entry),

    // The module's own error (logger-design §5.1): returns it, never throws.
    // A handler hands it back by returning it (from a plain or an async
    // function), throwing it, or calling back with it -- the same answer.
    error: (code, message, details) => CountinghouseError.module(code, message, details),

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
      if (Object.prototype.hasOwnProperty.call(o, 'as')) {
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
          if (device._ctxServiceClients == null) device._ctxServiceClients = {};
          const cached = device._ctxServiceClients[key];
          if (cached != null) return cb(null, billingWrapper(cached, billingKey, usageCall, token, device));
        }
        return CHUtil.createServiceClient({
          deviceID:  o.deviceID,
          serviceID: o.serviceID,
          // single-thread mode authorizes on the main thread, as the binding
          // the composition holds there; a worker's hop names nothing, the
          // main thread authorizes it by its token
          appKey:    (options.workerThread !== true && workerThreads.isMainThread === true) ? comp.identity : undefined,
          token:     token            // the call's token, for the device query (R2-1 Task 3)
        }, (err, client) => {
          // a runtime refusal (SERVICE_NOT_FOUND, DEVICE_NOT_FOUND, ...) is
          // issued, as ctx.call's are (review of #45)
          if (err != null) return cb(refuse(err), null);
          if (device != null) device._ctxServiceClients[key] = client;
          return cb(null, billingWrapper(client, billingKey, usageCall, token, device));
        });
      };
      if (device == null || device._compositionSettled === true) return build();
      return untilVerdict(device, startedAt).then(build);
    },

    // Composition by name. The identity and the allowed set come from
    // load-time verification (see DeviceManager), not from the handler --
    // a module never names the identity it runs as.
    call: (address, input, opts) => {
      if (typeof(address) === 'string' && address.startsWith('remote:')) return callRemoteAddress(device, billingKey, address, input, usageCall, token);
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
          // CHUtil is the outer, already-lazy binding from the top of
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
          if (comp.allowed[address] !== true) {
            return reject(new CountinghouseError('CTX_CALL_UNDECLARED', address));
          }

          const parsed = callAddress.parseAddress(address);
          if (parsed == null) {
            return reject(new CountinghouseError('CTX_CALL_BAD_ADDRESS', address));
          }

          const deviceID = callAddress.deviceIDForName(parsed.device);

          return CHUtil.queryDeviceSpec(deviceID, (specErr, spec) => {
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
      return untilVerdict(device, startedAt).then(callNow);
    },

    // app-layer bookkeeping only -- never touches balance. Platform metering
    // is the sole billing authority (docs/design-decisions.md).
    // returns {id, tool, cost, ts}: the caller's opaque id (R2-1 Task 5)
    recordUsage: (tool, cost, cb) => CHUtil.recordUsage(caller.id, tool, cost, cb),

    redis: CHUtil.redis,

    debug: options.debug === true
  };

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
  device._composition        = composition;
  device._compositionSettled = true;
  releaseWaiters(device);
}

// Wakes every ctx.call waiting for this device's verdict; each then answers
// from what the device holds (a verdict, or still none: CTX_CALL_NOT_READY).
function releaseWaiters(device) {
  if (device == null) return;
  const waiters = device._verdictWaiters || [];
  device._verdictWaiters = [];
  for (const go of waiters) go();
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
function verdictWaitMs() {
  const t = Number(options.requestTimeoutMs);
  // lib/timer.js gives setTimeout the timer as it is: 0 or less expires at once.
  const timer = Number.isFinite(t) ? t : 30000;
  return Math.max(0, Math.min(COMPOSITION_WAIT_MAX_MS, timer - COMPOSITION_WAIT_MARGIN_MS));
}

function untilVerdict(device, startedAt = Date.now()) {
  if (device == null || device._compositionSettled === true) return Promise.resolve();
  const remaining = verdictWaitMs() - (Date.now() - startedAt);
  if (remaining <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const go = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      device._verdictWaiters = (device._verdictWaiters || []).filter((w) => w !== go);
      go();
    }, remaining);
    (device._verdictWaiters || (device._verdictWaiters = [])).push(go);
  });
}

module.exports = {
  buildCtx:          buildCtx,
  callerIdentityOf:  callerIdentityOf,
  wireIdentityOf:    wireIdentityOf,
  setComposition:    setComposition,
  billingKeyOf:      billingKeyOf,
  attachBilling:     attachBilling,
  releaseWaiters:    releaseWaiters,
  verdictWaitMs:     verdictWaitMs
};
