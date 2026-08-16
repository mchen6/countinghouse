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
const options = require('./cli-options');

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

// Built fresh per call. Nothing here is cached across calls, because
// ctx.caller differs per call and a ctx that outlived its call would be a way
// to bill the wrong identity.
function buildCtx(device, args, opts) {
  const o       = opts || {};
  const CHUtil  = require('./countinghouse-util');
  const caller  = callerIdentityOf(args != null ? args.ctx : null);
  const jobID   = (args != null && args.jobID != null) ? args.jobID : null;

  return {
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

    // app-layer bookkeeping only -- never touches balance. Platform metering
    // is the sole billing authority (docs/design-decisions.md).
    recordUsage: (tool, cost, cb) => CHUtil.recordUsage(caller.apiKey, tool, cost, cb),

    redis: CHUtil.redis,

    debug: options.debug === true
  };
}

module.exports = {
  buildCtx:          buildCtx,
  callerIdentityOf:  callerIdentityOf,
  wireIdentityOf:    wireIdentityOf
};
