const util           = require('util');
const events         = require('events');
// postman-request: loaded on first use (lib/lazy-require.js).
const {lazy, orCallback} = require('./lazy-require');
const requestLib = lazy('postman-request');
function request(opts, callback) {
  const lib = orCallback(requestLib, callback);
  if (lib != null) lib(opts, callback);
}
const CHDevice     = require('./countinghouse-device');
const LOG            = require('./logger');
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const QueryDevice    = require('./query-device');
const options        = require('./cli-options');

const stringify      = require('json-stringify-safe');
const path           = require('path');

const Worker         = require('worker_threads').Worker;
// read at call time (createServiceClient), so a test may stand in for a worker
const workerThreads  = require('worker_threads');

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
    if (superConstructor === CHDevice) {
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

    this.request(opts, (error, response, body) => {
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

    const isMainThread = workerThreads.isMainThread;
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
    const queryDeviceObj = new QueryDevice(appKey, module.exports.ci, deviceID, serviceID, callback, billingKey);

    if (options.workerThread !== true && isMainThread === true) {
      //non worker thread mode
      module.exports.dm.emit('querydevice', deviceID, queryDeviceObj.callback);
    } else if (options.workerThread !== true && isMainThread === false) {
      //worker thread mode and running in child thread
      // see 'query-device-reply' message handler in app-sandbox and callback def in query-device.js
      // callback receives err and spec and return
      const wm = module.exports.dm.workerMessage;
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
      const spec = (deviceOrSpec instanceof CHDevice) ? deviceOrSpec.spec : deviceOrSpec;
      if (spec == null || spec.device == null) {
        return callback(new CountinghouseError('NO_VALID_DEVICE_SPEC', deviceID), null);
      }
      return callback(null, spec);
    };

    if (options.workerThread !== true && workerThreads.isMainThread === true) {
      return module.exports.dm.emit('querydevice', deviceID, relay);
    }
    if (options.workerThread !== true && workerThreads.isMainThread === false) {
      const wm = module.exports.dm.workerMessage;
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
    LOG.I(`CHUtil.recordUsage (app-layer bookkeeping, no balance effect): ${id != null ? id : 'no id'} tool=${tool} cost=${cost}`);
    return callback(null, {id: id, tool: tool, cost: cost, ts: Date.now()});
  },

  deviceLog: function(device, entry) {
    if (!(device instanceof CHDevice)) return;

    const deviceID = device.deviceID;
    if (deviceID  == null || deviceID === '') return;

    let data = null;
    if (typeof(entry) === 'object' || Array.isArray(entry)) {
      data = stringify(entry);
    } else {
      data = entry;
    }

    if (options.debug === true) return console.log(data);

    if (workerThreads.isMainThread === true) {
      store.getStore().deviceLog(deviceID, data, Date.now(), (e) => {
        if (e) LOG.E(e);
      });
    } else {
      const wm = module.exports.dm.workerMessage;
      if (wm != null) {
        wm.sendDeviceLogMessageToParent(deviceID, data, Date.now(), (e) => {
          if (e) LOG.E(e);
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

    if (workerThreads.isMainThread === true) {
      store.getStore().deviceLog(deviceID, data, timestamp, (e) => callback(e));
    } else {
      return callback(new Error('this should be called from main thread'));
    }
  },
  //TODO: add message broadcast support,
  // such as: broadCastMessage(data);

  redis: null,  //this reference is set in sandbox.js / framework.js

  jobProgress: function(jobID, progress) {
    // non worker mode
    if (options.workerThread !== true && workerThreads.isMainThread === true) return;

    if (typeof(jobID) !== 'string' && typeof(jobID) !== 'number') return;
    if (typeof(progress) !== 'number') return;
    if (progress < 0 || progress > 100) return;

    //worker thread mode and running in child thread
    if (options.workerThread !== true && workerThreads.isMainThread === false) {
      const wm = module.exports.dm.workerMessage;
      if (wm != null) wm.sendJobProgressMessageToParent({jobID: jobID, progress: progress});
    }
  },

  jobInfo: function(jobID, callback) {
    if (workerThreads.isMainThread === true) return callback(new Error('cannot work in main thread and single-thread mode'));

    if (typeof(jobID) !== 'string' && typeof(jobID) !== 'number') return callback(new Error(`invalid jobID: ${jobID}. must be string or number type`));

    //worker thread mode and running in child thread
    const wm = module.exports.dm.workerMessage;

    if (wm != null) {
      return wm.sendGetJobInfoMessageToParent(jobID, (e, job) => {
        if (e) LOG.E(e);
        return callback(e, job);
      });
    }

    return callback(new Error('unknown worker thread'));
  }
};

// The CHUtil a module's worker sees as a global (lib/sandbox.js, R2-1 Task
// 5): every property but the worker's device manager and CdifInterface (dm,
// ci), which the runtime keeps to itself. Methods are copied unbound, so
// called as CHUtil.x() they run with the facade as `this`, and a wrapper the
// lockdown puts on the facade (CHUtil.request's host check, loadFile) is the
// one the other methods reach; dm and ci they read from the runtime's own
// object. Plain properties are getters onto the runtime's, so they stay
// live. Tidying, not a boundary: require.cache still reaches the runtime.
module.exports.moduleFacade = function() {
  const runtime = module.exports;
  const hidden = new Set(['dm', 'ci', 'moduleFacade']);
  const facade = {};
  for (const k of Object.keys(runtime)) {
    if (hidden.has(k)) continue;
    if (typeof(runtime[k]) === 'function') facade[k] = runtime[k];
    else Object.defineProperty(facade, k, {get: () => runtime[k], set: (v) => { runtime[k] = v; }, enumerable: true, configurable: true});
  }
  return facade;
};

