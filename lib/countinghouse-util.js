'use strict';
const util           = require('util');
const events         = require('events');
// postman-request: loaded on first use (lib/lazy-require.js).
const {lazy, orCallback} = require('./lazy-require');
const requestLib = lazy('postman-request');
// The runtime's own state, kept out of what a module can read from this
// file's exports (the high review of #177): the worker's device manager and
// interface (dm, ci; readable on the main thread only, below), and in a lean
// worker the route every outbound request of this file takes.
const runtimeState = {dm: null, ci: null, outbound: null};
let attached = false;
// postman-request itself, on the main thread (and single-thread mode) only.
function rawRequest(opts, callback) {
  const lib = orCallback(requestLib, callback);
  if (lib != null) lib(opts, callback);
}
// Every request this file makes: in a lean worker, through the module's
// CHUtil.request as the lockdown wrapped it (its host check), whichever
// helper makes it (CHUtil.invokeAction among them); on the main thread
// directly. In a worker that route is the only one: without it (this file
// not attached, or attached by module code with none) a request is
// refused, never sent unchecked (#177's re-review, item 2).
function request(opts, callback) {
  if (runtimeState.outbound != null) return runtimeState.outbound(opts, callback);
  if (threadInfo.isMainThread !== true) {
    const refused = Object.assign(new Error('CHUtil.request: no checked route in this worker'), {code: 'ERR_ACCESS_DENIED'});
    if (typeof(callback) === 'function') return process.nextTick(callback, refused);
    throw refused;
  }
  return rawRequest(opts, callback);
}
// The logger on the first line logged (in a worker, the worker's: lib/logger.js)
const log = lazy('./logger');
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
// a device query's state, on the first query (it loads the service client)
const QueryDevice    = lazy('./query-device');
const options        = require('./cli-options');

const stringify      = require('json-stringify-safe');
const path           = require('path');

// The thread's facts from lib/thread-info.js, read at call time (a test may
// stand in for a worker): this file loads on first use in a lean worker,
// after the lockdown, which refuses worker_threads then.
const threadInfo     = require('./thread-info');

// The device log is the store's (lib/store.js, made when first used, on
// the main thread).
const store          = require('./store');

module.exports = {
  // --bindAddr, else loopback (lib/bind-address.js).
  getHostIp: function() {
    return require('./bind-address').hostIp();
  },
  getHostProtocol: function() {
    // in production return https instead
    return 'http://';
  },

  inherits: function(constructor, superConstructor) {
    util.inherits(constructor, superConstructor);

    // prevent child override
    if (superConstructor != null && superConstructor === QueryDevice().chDeviceClass()) {
      for (const i in superConstructor.prototype) {
        constructor.prototype[i] = superConstructor.prototype[i];
      }
    }
  },
  // Loads one of a module's own files. A plain require(): the file and
  // everything it requires come from the require cache, so repeated calls
  // return the same object. Freshness on reload comes from the reload itself
  // -- a new worker under --workerThread, a purged cache in single-thread
  // mode (module-manager.js's instantiateModule) -- not from re-evaluating
  // one file here. name must be an absolute path, e.g.
  // CHUtil.loadFile(`${__dirname}/device.js`).
  loadFile: function loadFile(name) {
    // Under the file broker, a module's own path is /app/... (spec section 2);
    // in single-thread mode it maps through the calling module's root.
    // a module's /app path is POSIX on every OS, a relative name included
    // (identity.resolveModulePath; issue #40)
    let p = require('./fs-broker/identity').resolveModulePath(name);
    const facade = require('./single-thread-facade');
    if (facade.active() && (p === '/app' || p.startsWith('/app/'))) p = facade.hostFromCaller(p, loadFile);
    return require(require('./fs-broker/identity').specifierFor(p));
  },
  request: function(opts, callback) {
    //wrapper for postman-request (maintained fork of the deprecated `request`
    //package, same API), https://www.npmjs.com/package/postman-request
    request(opts, callback);
  },
  invokeAction: function(userKey, deviceBaseUrl, serviceID, actionName, args, callback) {
    // convenience method to invoke a COUNTINGHOUSE action
    if (deviceBaseUrl == null || typeof(deviceBaseUrl) !== 'string') return callback(new Error('invalid device base url'));
    if (typeof(args) !== 'object') return callback(new Error('must specify input argument'));

    const opts = {
      url: `${deviceBaseUrl}/invoke-action`,
      headers: {
        'X-CH-Key': userKey,
        'Accept': 'application/json',
        'Content-Type': 'application/json;charset=utf-8',
      },
      method: 'POST',
      json: {
        serviceID:  serviceID,
        actionName: actionName,
        input: args.input
      }
    };

    request(opts, (error, response, body) => {
      if (error != null) {
        return callback(error, null);
      }
      if (response.statusCode > 200) {
        return callback(new Error(body.message), null);
      }
      //body contain parsed JSON data with output field in it
      return callback(null, body);
    });
  },
  // A client for another device's service. In a module's worker it names no
  // identity (R2-1 Task 5, spec section 3): an appKey or a ctx passed here
  // is refused, as `as` is on ctx.serviceClient, and the hop is authorized
  // and billed by the call's token. On the main thread (single-thread mode,
  // which isolates nothing) it takes the key it authorizes as. The CDIF-era
  // --debug --verifyModule branch, which queried a central portal with the
  // key over HTTP, is gone: both modes resolve devices locally.
  createServiceClient: function(opts, callback) {
    const deviceID  = opts.deviceID;
    const serviceID = opts.serviceID;

    if (typeof(callback) !== 'function') return;

    const isMainThread = threadInfo.isMainThread;
    const inWorker = (isMainThread !== true);
    // worker mode's main thread hosts no module: the coded answer first
    if (options.workerThread === true && isMainThread === true) return callback(new CountinghouseError('QUERY_DEVICE_ON_MAIN_THREAD'));
    if (inWorker && (opts.appKey != null || opts.ctx != null)) {
      return callback(new Error('createServiceClient: identities come from the operator\'s runsModules binding; remove `appKey`'), null);
    }
    // nor whom to bill: the main thread bills the call's token (the review of #163)
    if (inWorker && opts.billingKey != null) {
      return callback(new Error('createServiceClient: a hop is billed to the call\'s caller by the runtime; remove `billingKey`'), null);
    }
    if (!inWorker && opts.appKey == null) return callback(new Error('must specify appKey'), null);
    if (deviceID == null || serviceID == null || typeof(deviceID) !== 'string' || typeof(serviceID) !== 'string') return callback(new Error('must specify deviceID and serviceID'), null);

    const appKey = inWorker ? null : opts.appKey;
    // 6.0.0: authorization and billing may be different identities; an
    // explicit billingKey wins, else it collapses to appKey. Main thread
    // only: a worker's hop is billed by its token.
    const billingKey = inWorker ? null : ((opts.billingKey != null) ? opts.billingKey : appKey);
    const queryDeviceObj = new (QueryDevice())(appKey, runtimeState.ci, deviceID, serviceID, callback, billingKey);

    if (options.workerThread !== true && isMainThread === true) {
      //non worker thread mode
      runtimeState.dm.emit('querydevice', deviceID, queryDeviceObj.callback);
    } else if (options.workerThread !== true && isMainThread === false) {
      //worker thread mode and running in child thread
      // see 'query-device-reply' message handler in app-sandbox and callback def in query-device.js
      // callback receives err and spec and return
      const wm = runtimeState.dm.workerMessage;
      // with the call's token (R2-1 Task 3): the query is refused without it
      if (wm != null) wm.sendDeviceQueryMessageToParent(deviceID, queryDeviceObj.callback, {token: opts.token});
    } else {
      //worker thread mode and running in main thread
      return callback(new CountinghouseError('QUERY_DEVICE_ON_MAIN_THREAD'));
    }
  },

  // The spec of another loaded device, by deviceID. createServiceClient
  // already reaches it, but only as a step toward a client for a serviceID
  // the caller must already know -- ctx.call resolves the serviceID FROM the
  // spec, so it needs this half on its own.
  //
  // The thread-mode branches mirror createServiceClient's exactly,
  // deliberately: in worker mode the child asks the parent, which answers
  // only for a device the calling module declared, and only once its
  // composition verdict has landed (CTX_CALL_NOT_READY before it; ctx.call
  // waits for the verdict first); a query during a later discovery pass is
  // queued until the target loads (R2-1 Task 5, #148). Calling from the
  // main thread in worker mode is a programming error, not a runtime
  // condition. The CHDevice-vs-spec
  // discrimination below mirrors QueryDevice.prototype.callback
  // (lib/query-device.js) instead, using the same `instanceof CHDevice`
  // check rather than duck-typing a `.spec` property.
  // claim: {token} (R2-1 Task 3), the call's token; in a worker the query
  // is refused without it (the review of #138, 5b).
  queryDeviceSpec: function(deviceID, callback, claim) {
    if (typeof(callback) !== 'function') return;
    if (deviceID == null || typeof(deviceID) !== 'string') {
      return callback(new Error('must specify deviceID'), null);
    }
    const relay = (err, deviceOrSpec) => {
      // a coded refusal (CALL_TOKEN_INVALID, the typed missing-device
      // reasons) keeps its code for ctx.call's caller
      if (err != null) return callback((err.code != null) ? err : new Error(err.message), null);
      // main thread hands back a CHDevice, a worker hands back the spec itself
      const CHDevice = QueryDevice().chDeviceClass();
      const spec = (CHDevice != null && deviceOrSpec instanceof CHDevice) ? deviceOrSpec.spec : deviceOrSpec;
      if (spec == null || spec.device == null) {
        return callback(new CountinghouseError('NO_VALID_DEVICE_SPEC', deviceID), null);
      }
      return callback(null, spec);
    };

    if (options.workerThread !== true && threadInfo.isMainThread === true) {
      return runtimeState.dm.emit('querydevice', deviceID, relay);
    }
    if (options.workerThread !== true && threadInfo.isMainThread === false) {
      const wm = runtimeState.dm.workerMessage;
      if (wm == null) return callback(new CountinghouseError('QUERY_DEVICE_ON_MAIN_THREAD'), null);
      return wm.sendDeviceQueryMessageToParent(deviceID, relay, claim);
    }
    return callback(new CountinghouseError('QUERY_DEVICE_ON_MAIN_THREAD'), null);
  },

  // App-layer bookkeeping only (docs/composite-tools.md's "billing
  // authority" principle): does NOT touch MeteringProvider and has no
  // effect on any apiKey's balance -- balance is now deducted exactly
  // once per cross-worker call, automatically, by the platform itself
  // (see lib/peer-channel-broker.js's PeerChannelBroker.prototype.
  // handleMeteringRequest for the --directPeerChannels path and
  // lib/device-manager.js's DeviceManager.prototype.
  // sendInvokeActionMessageToWorker for the main-thread-routed path).
  // This used to be named recordCall and *did* deduct balance via
  // CdifInterface.prototype.recordCall, which is what let a composite
  // call be billed twice (once here, once by the platform); renamed
  // rather than left as the same name with different behavior, so a
  // module author who remembers "recordCall = billing" isn't misled.
  // A module that wants its own call-level record (e.g. composite-demo's
  // bill array) should call this for logging, then read the real
  // charged/balance numbers off the 3rd (platformMetering) argument on the
  // ServiceClient.invoke() reply callback -- never off `data` itself,
  // which is the hop's own action output and stays untouched.
  recordUsage: function(id, tool, cost, callback) {
    // Runs in the module's worker, where only the caller's opaque id is in
    // hand (R2-1 Task 5): no key.
    log().I(`CHUtil.recordUsage (app-layer bookkeeping, no balance effect): ${id != null ? id : 'no id'} tool=${tool} cost=${cost}`);
    return callback(null, {id: id, tool: tool, cost: cost, ts: Date.now()});
  },

  // device: the handler's device (ctx.log), a CHDevice or, in a lean worker,
  // a plain object with its deviceID; the main thread logs only under a
  // device the sending worker hosts (DeviceManager's devicelog).
  deviceLog: function(device, entry) {
    if (device == null || typeof(device) !== 'object' || typeof(device.deviceID) !== 'string') return;

    const deviceID = device.deviceID;
    if (deviceID  == null || deviceID === '') return;

    let data = null;
    if (typeof(entry) === 'object' || Array.isArray(entry)) {
      data = stringify(entry);
    } else {
      data = entry;
    }

    if (options.debug === true) return console.log(data);

    if (threadInfo.isMainThread === true) {
      store.getStore().deviceLog(deviceID, data, Date.now(), (e) => {
        if (e) log().E(e);
      });
    } else {
      const wm = runtimeState.dm.workerMessage;
      if (wm != null) {
        wm.sendDeviceLogMessageToParent(deviceID, data, Date.now(), (e) => {
          if (e) log().E(e);
        });
      }
    }
  },

  // this call is used by framework to do deviceLog in mainthread under worker-thread mode, normally it should not be exposed to external caller
  __deviceLogWithID: function(deviceID, entry, timestamp, callback) {
    if (deviceID  == null || deviceID === '') return;

    let data = null;
    if (typeof(entry) === 'object' || Array.isArray(entry)) {
      data = stringify(entry);
    } else {
      data = entry;
    }

    if (options.debug === true) return console.log(data);

    if (threadInfo.isMainThread === true) {
      store.getStore().deviceLog(deviceID, data, timestamp, (e) => callback(e));
    } else {
      return callback(new Error('this should be called from main thread'));
    }
  },
  //TODO: add message broadcast support,
  // such as: broadCastMessage(data);

  redis: null,  //this reference is set in lean-worker.js / framework.js

  jobProgress: function(jobID, progress) {
    // non worker mode
    if (options.workerThread !== true && threadInfo.isMainThread === true) return;

    if (typeof(jobID) !== 'string' && typeof(jobID) !== 'number') return;
    if (typeof(progress) !== 'number') return;
    if (progress < 0 || progress > 100) return;

    //worker thread mode and running in child thread
    if (options.workerThread !== true && threadInfo.isMainThread === false) {
      const wm = runtimeState.dm.workerMessage;
      if (wm != null) wm.sendJobProgressMessageToParent({jobID: jobID, progress: progress});
    }
  },

  // a call's own progress (MCP completeness M21), from a module's worker:
  // not a module's to call (lib/chutil-facade.js METHODS leaves it out);
  // ctx.job.progress posts through it, bounded in the worker
  // (lib/handler-ctx.js callProgressPoster)
  callProgress: function(token, progress) {
    if (threadInfo.isMainThread === true) return;
    if (typeof(token) !== 'string' || typeof(progress) !== 'number') return;
    const wm = runtimeState.dm != null ? runtimeState.dm.workerMessage : null;
    if (wm != null) wm.sendCallProgressMessageToParent({token: token, progress: progress});
  },

  jobInfo: function(jobID, callback) {
    if (threadInfo.isMainThread === true) return callback(new Error('cannot work in main thread and single-thread mode'));

    if (typeof(jobID) !== 'string' && typeof(jobID) !== 'number') return callback(new Error(`invalid jobID: ${jobID}. must be string or number type`));

    //worker thread mode and running in child thread
    const wm = runtimeState.dm.workerMessage;

    if (wm != null) {
      return wm.sendGetJobInfoMessageToParent(jobID, (e, job) => {
        if (e) log().E(e);
        return callback(e, job);
      });
    }

    return callback(new Error('unknown worker thread'));
  }
};

// dm and ci: the main thread's device manager and interface, set by
// CdifInterface and read by the main thread's own code. In a worker they
// read as undefined and cannot be set: a lean worker's are attached once,
// below, and only this file uses them.
for (const key of ['dm', 'ci']) {
  Object.defineProperty(module.exports, key, {
    enumerable: false,
    configurable: false,
    get: () => (threadInfo.isMainThread === true ? runtimeState[key] : undefined),
    set: (value) => { if (threadInfo.isMainThread === true) runtimeState[key] = value; }
  });
}
// A lean worker's state, attached once, by lib/chutil-facade.js when it first
// loads this file: {dm, ci, redis, outbound}, redis a function that makes
// the bridge on its first read (CHUtil.redis). It hands nothing back. A second
// attach is refused. Tidying, not a boundary (spec section 3's residual):
// module code that reaches this file through require.cache before the
// facade has can attach it itself, but gets nothing it did not pass in, and
// this file's requests then have no checked route, so they are refused.
Object.defineProperty(module.exports, '__attach', {enumerable: false, configurable: false, writable: false, value: (state) => {
  if (attached) throw new Error('countinghouse-util: already attached');
  attached = true;
  runtimeState.dm = state.dm;
  runtimeState.ci = state.ci;
  runtimeState.outbound = (typeof(state.outbound) === 'function') ? state.outbound : null;
  if (typeof(state.redis) === 'function') {
    Object.defineProperty(module.exports, 'redis', {enumerable: true, configurable: false, get: state.redis});
  } else {
    module.exports.redis = state.redis;
  }
}});
// ctx.usage() from a worker: the current call's counts, asked of the main
// thread over the worker's own channel (lib/handler-ctx.js).
Object.defineProperty(module.exports, '__usageQuery', {enumerable: false, configurable: false, writable: false, value: (data, callback) => {
  const wm = (runtimeState.dm != null) ? runtimeState.dm.workerMessage : null;
  if (wm == null) return callback(new CountinghouseError('CTX_CALL_NOT_READY', 'usage'), null);
  return wm.sendUsageQueryToParent(data, callback);
}});
// ctx.ask() from a worker: {token, name, values}, asked of the main thread
// over the worker's own channel (lib/handler-ctx.js; lib/module-ask.js
// answers).
Object.defineProperty(module.exports, '__ask', {enumerable: false, configurable: false, writable: false, value: (data, callback) => {
  const wm = (runtimeState.dm != null) ? runtimeState.dm.workerMessage : null;
  if (wm == null) return callback(new CountinghouseError('CTX_CALL_NOT_READY', 'ask'), null);
  return wm.sendAskToParent(data, callback);
}});
// ctx.call('remote:...') from a worker: sent over the worker's own channel to
// the main thread, which checks its token (lib/handler-ctx.js).
Object.defineProperty(module.exports, '__remoteCall', {enumerable: false, configurable: false, writable: false, value: (data, callback) => {
  const wm = (runtimeState.dm != null) ? runtimeState.dm.workerMessage : null;
  if (wm == null) return callback(new CountinghouseError('CTX_CALL_NOT_READY', 'remote'), null);
  return wm.sendRemoteCallToParent(data, callback);
}});
