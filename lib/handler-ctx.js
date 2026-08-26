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
// refusals are DeviceErrors rather than plain Errors on purpose -- see the
// comment on the guard clauses in `call` below.
const DeviceError = require('./countinghouse-error').DeviceError;

// Accepts either a real Session (main thread) or the plain identity forwarded
// across the worker boundary; both carry `appKey`.
function callerIdentityOf(sessionOrIdentity) {
  const s = sessionOrIdentity;
  if (s == null || typeof s !== 'object') return {apiKey: null, userName: null, isAdmin: false};

  return {
    apiKey:   (s.appKey != null) ? s.appKey : null,
    userName: (s.username != null) ? s.username : null,
    isAdmin:  s.isAdmin === true
  };
}

// The serializable form sent to a worker in place of the Session.
// Named with `appKey` rather than `apiKey` so it stays a drop-in for anything
// already reading `ctx.appKey` off a session (CHUtil.createServiceClient's
// `opts.ctx` does exactly that).
function wireIdentityOf(session) {
  if (session == null || typeof session !== 'object') return null;
  return {
    appKey:   (session.appKey != null) ? session.appKey : null,
    username: (session.username != null) ? session.username : null,
    isAdmin:  session.isAdmin === true
  };
}

// A cached ServiceClient is shared by every caller of this device, so the
// billing identity cannot live on it. This hands each call its own view: the
// same underlying client, with `billingKey` attached per invoke. No mutation
// of shared state, so concurrent callers cannot bill each other.
function billingWrapper(client, billingKey) {
  return {
    invoke: (opts, cb) => {
      const withBilling = Object.assign({}, opts, {billingKey: billingKey});
      return client.invoke(withBilling, cb);
    },
    deviceID:  client.deviceID,
    serviceID: client.serviceID
  };
}

// Built fresh per call. The ctx object itself is never cached, because
// ctx.caller differs per call and a ctx that outlived its call would be a way
// to bill the wrong identity.
function buildCtx(device, args, opts) {
  const o       = opts || {};
  const CHUtil  = require('./countinghouse-util');
  const caller  = callerIdentityOf(args != null ? args.ctx : null);
  const jobID   = (args != null && args.jobID != null) ? args.jobID : null;

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
      if (o.as == null) {
        return cb(new Error('ctx.serviceClient: `as` is required -- it is the identity the ' +
                            'inner hop is authorized as. Billing goes to ctx.caller automatically.'));
      }

      const key = `${o.deviceID}|${o.serviceID}|${o.as}`;
      if (device != null) {
        if (device._ctxServiceClients == null) device._ctxServiceClients = {};
        const cached = device._ctxServiceClients[key];
        if (cached != null) return cb(null, billingWrapper(cached, caller.apiKey));
      }

      return CHUtil.createServiceClient({
        deviceID:  o.deviceID,
        serviceID: o.serviceID,
        appKey:    o.as             // authorization
      }, (err, client) => {
        if (err != null) return cb(err, null);
        if (device != null) device._ctxServiceClients[key] = client;
        return cb(null, billingWrapper(client, caller.apiKey));
      });
    },

    // Composition by name. The identity and the allowed set come from
    // load-time verification (see DeviceManager), not from the handler --
    // a module never names the identity it runs as.
    call: (address, input, opts) => {
      const detail = (opts != null && opts.detail === true);
      const comp   = (device != null) ? device._composition : null;

      return new Promise((resolve, reject) => {
        // CHUtil is the outer, already-lazy binding from the top of
        // buildCtx (see the comment on the callAddress require at the top
        // of this file for why it can't be required at module scope).
        //
        // Every refusal below is a DeviceError, not a plain Error, and that
        // is the whole reason any of this reaches a client. lib/service.js's
        // `fail` keeps a DeviceError/CHError as-is and flattens everything
        // else to DEVICE_INVOKE_EXCEPTION (the original text goes into the
        // fault payload, which lib/mcp/gateway.js's toolCallResult does not
        // read) -- so as plain Errors, a typo'd address, a missing
        // runsModules binding and a callee that genuinely crashed were
        // indistinguishable to an MCP client. A code survives untouched:
        // over the worker hop DeviceManager.prototype.invokeAction re-wraps
        // as `new DeviceError(err.code)`, and toolCallResult puts it in
        // structuredContent.code. That re-wrap does discard the message, so
        // each code's head text in error-info.*.json says what to do on its
        // own; the detail passed here only survives in single-thread mode
        // and over REST /invoke-action.
        //
        // NOT_READY vs UNBOUND is a distinction about time, not config.
        // Composition verification is asynchronous and runs after discovery
        // (DeviceManager.prototype.onAllModulesDiscovered), while the device
        // is already listed and already serving. setComposition is the
        // delivery of a verdict -- including the empty verdict for a module
        // that declared no "countinghouse.calls" -- so "no verdict yet"
        // means the window, and telling that caller to go fix "runsModules"
        // sent them after a config that was already correct. A null device
        // is not a timing problem at all, so it falls through to UNBOUND.
        if (device != null && device._compositionSettled !== true) {
          return reject(new DeviceError('CTX_CALL_NOT_READY', address));
        }
        if (comp == null || comp.identity == null) {
          return reject(new DeviceError('CTX_CALL_UNBOUND', address));
        }
        if (comp.allowed[address] !== true) {
          return reject(new DeviceError('CTX_CALL_UNDECLARED', address));
        }

        const parsed = callAddress.parseAddress(address);
        if (parsed == null) {
          return reject(new DeviceError('CTX_CALL_BAD_ADDRESS', address));
        }

        const deviceID = callAddress.deviceIDForName(parsed.device);

        return CHUtil.queryDeviceSpec(deviceID, (specErr, spec) => {
          if (specErr != null) return reject(specErr);

          const resolved = callAddress.resolveAddress(spec, parsed);
          if (resolved.ok !== true) {
            return reject(new DeviceError('CTX_CALL_UNRESOLVED', resolved.message));
          }

          return ctx.serviceClient({deviceID: deviceID, serviceID: resolved.serviceID,
                                    as: comp.identity}, (clientErr, client) => {
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
        });
      });
    },

    // app-layer bookkeeping only -- never touches balance. Platform metering
    // is the sole billing authority (docs/design-decisions.md).
    recordUsage: (tool, cost, cb) => CHUtil.recordUsage(caller.apiKey, tool, cost, cb),

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
}

module.exports = {
  buildCtx:          buildCtx,
  callerIdentityOf:  callerIdentityOf,
  wireIdentityOf:    wireIdentityOf,
  setComposition:    setComposition
};
