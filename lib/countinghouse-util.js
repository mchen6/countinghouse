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
// postman-request itself; handed only to the lean worker's facade
// (__attach), never exported.
function rawRequest(opts, callback) {
  const lib = orCallback(requestLib, callback);
  if (lib != null) lib(opts, callback);
}
// Every request this file makes: in a lean worker, through the module's
// CHUtil.request as the lockdown wrapped it (its host check), whichever
// helper makes it (CHUtil.invokeAction among them); elsewhere directly.
function request(opts, callback) {
  if (runtimeState.outbound != null) return runtimeState.outbound(opts, callback);
  return rawRequest(opts, callback);
}
const CHDevice     = require('./countinghouse-device');
const LOG            = require('./logger');
const keyFingerprint = require('./key-fingerprint').keyFingerprint;
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const QueryDevice    = require('./query-device');
const ServiceClient  = require('./service-client');
const options        = require('./cli-options');

const async          = require('async');
const stringify      = require('json-stringify-safe');
const path           = require('path');

// from lib/thread-info.js: this file loads on first use in a lean worker,
// after the lockdown, which refuses worker_threads then
const isMainThread   = require('./thread-info').isMainThread;

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
  //FIXME: under debug mode do not query remote server if device module is creating a service client for himself
  //instead we should follow the non-debug mode path
  createServiceClient: function(opts, callback) {
    const deviceID  = opts.deviceID;
    const serviceID = opts.serviceID;
    const session   = opts.ctx;       // ctx may be passed into device modules as part of the args

    if (typeof(callback) !== 'function') return;

    //appKey should exist for security reason
    if (opts.appKey == null && opts.ctx == null) return callback(new Error('must specify appKey or ctx object'), null);
    if (deviceID == null || serviceID == null || typeof(deviceID) !== 'string' || typeof(serviceID) !== 'string') return callback(new Error('must specify deviceID and serviceID'), null);

    //if both are present, appKey should have precendence over ctx
    const appKey = (opts.appKey != null) ? opts.appKey : session.appKey;
    // 6.0.0: authorization and billing may be different identities. An
    // explicit billingKey wins; otherwise the caller's session supplies it
    // when one was passed as ctx; otherwise it collapses to appKey, which is
    // the pre-split behaviour. See docs/composite-tools.md.
    const billingKey = (opts.billingKey != null) ? opts.billingKey
                     : ((session != null && session.appKey != null) ? session.appKey : appKey);
    //under debug mode we query remote server, e.g. api.countinghouse.com:3049/device-list to get the serviceID
    //this means under debug mode we will query remote portal even user create a service client for himself
    if (options.debug === true && options.verifyModule === true) {
      const deviceListOpts = {
        url: `${options.centralPortalUrl}/device-list`,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-CH-Key': appKey
        }
      };
      //TODO: add request timeout support
      request(deviceListOpts, (err, response, body) => {
        let info = null;
        if (err != null) return callback(err, null);
        try {
          info = JSON.parse(body);
        } catch (e) {
          return callback(e, null);
        }
        if (response.statusCode > 200) return callback(new Error(info.message), null); // user not found or other error from device-list call

        let targetService = null;
        async.each(info, (item, cb) => {
          if (item.device.deviceID === deviceID) {
            const getDeviceSpecOpts = {
              url: `${options.centralPortalUrl}/devices/${item.device.deviceID}/get-spec`,
              method: 'GET',
              headers: {
                'Content-Type': 'application/json',
                'X-CH-Key': appKey
              }
            };
            //TODO: add request timeout support
            request(getDeviceSpecOpts, (err, resp, body) => {
              let spec = null;
              if (err != null) {
                return cb(err);
              }
              try {
                spec = JSON.parse(body);
              } catch (e) {
                return cb(e);
              }
              if (resp.statusCode > 200) return cb(new Error(spec.message), null);

              const serviceList = spec.device.serviceList;
              let found = false;
              for (const id in serviceList) {
                if (id === serviceID) found = true;
              }
              if (found === true) {
                targetService = new ServiceClient(null, true, false, appKey, deviceID, serviceID);
                targetService.deviceBaseUrl = `${options.centralPortalUrl}/devices/${item.device.deviceID}`;
                return cb();
              }
              return cb(new CountinghouseError('SERVICE_NOT_FOUND', serviceID));
            });
          } else {
            return cb();
          }
        }, (err) => {
          if (err != null) {
            return callback(err, null);
          }
          if (targetService == null) {
            return callback(new CountinghouseError('DEVICE_NOT_FOUND', deviceID));
          }
          return callback(null, targetService);
        });
      });
    } else {
      // under non-debug mode we query local instance to find the service
      const queryDeviceObj = new QueryDevice(appKey, runtimeState.ci, deviceID, serviceID, callback, billingKey);

      if (options.workerThread !== true && isMainThread === true) {
        //non worker thread mode
        runtimeState.dm.emit('querydevice', deviceID, queryDeviceObj.callback);
      } else if (options.workerThread !== true && isMainThread === false) {
        //worker thread mode and running in child thread
        // see 'query-device-reply' message handler in app-sandbox and callback def in query-device.js
        // callback receives err and spec and return
        const wm = runtimeState.dm.workerMessage;
        // with the call's token and the identity named (R2-1 Task 3): a
        // missing device is then answered with its reason to an identity
        // granted it
        if (wm != null) wm.sendDeviceQueryMessageToParent(deviceID, queryDeviceObj.callback, {token: opts.token, appKey: appKey});
      } else {
        //worker thread mode and running in main thread
        return callback(new CountinghouseError('QUERY_DEVICE_ON_MAIN_THREAD'));
      }

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
    if (options.debug === true && options.verifyModule === true) {
      return callback(new Error('ctx.call needs a local runtime -- it is not available ' +
                                'under --debug --verifyModule, which resolves devices ' +
                                'through the remote portal'), null);
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

    if (options.workerThread !== true && isMainThread === true) {
      return runtimeState.dm.emit('querydevice', deviceID, relay);
    }
    if (options.workerThread !== true && isMainThread === false) {
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
  recordUsage: function(apiKey, tool, cost, callback) {
    // Runs in the module's worker, where only the key is in hand.
    LOG.I(`CHUtil.recordUsage (app-layer bookkeeping, no balance effect): ${keyFingerprint(apiKey)} tool=${tool} cost=${cost}`);
    return callback(null, {apiKey: apiKey, tool: tool, cost: cost, ts: Date.now()});
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

    if (isMainThread === true) {
      store.getStore().deviceLog(deviceID, data, Date.now(), (e) => {
        if (e) LOG.E(e);
      });
    } else {
      const wm = runtimeState.dm.workerMessage;
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

    if (isMainThread === true) {
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
    if (options.workerThread !== true && isMainThread === true) return;

    if (typeof(jobID) !== 'string' && typeof(jobID) !== 'number') return;
    if (typeof(progress) !== 'number') return;
    if (progress < 0 || progress > 100) return;

    //worker thread mode and running in child thread
    if (options.workerThread !== true && isMainThread === false) {
      const wm = runtimeState.dm.workerMessage;
      if (wm != null) wm.sendJobProgressMessageToParent({jobID: jobID, progress: progress});
    }
  },

  jobInfo: function(jobID, callback) {
    if (isMainThread === true) return callback(new Error('cannot work in main thread and single-thread mode'));

    if (typeof(jobID) !== 'string' && typeof(jobID) !== 'number') return callback(new Error(`invalid jobID: ${jobID}. must be string or number type`));

    //worker thread mode and running in child thread
    const wm = runtimeState.dm.workerMessage;

    if (wm != null) {
      return wm.sendGetJobInfoMessageToParent(jobID, (e, job) => {
        if (e) LOG.E(e);
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
    get: () => (isMainThread === true ? runtimeState[key] : undefined),
    set: (value) => { if (isMainThread === true) runtimeState[key] = value; }
  });
}
// A lean worker's state, attached once, by lib/chutil-facade.js when it first
// loads this file: {dm, ci, redis, outbound}. Returns postman-request's own
// call, which only the facade holds. A second attach is refused, so module
// code that reaches this file through require.cache cannot rewire it.
Object.defineProperty(module.exports, '__attach', {enumerable: false, configurable: false, writable: false, value: (state) => {
  if (attached) throw new Error('countinghouse-util: already attached');
  attached = true;
  runtimeState.dm = state.dm;
  runtimeState.ci = state.ci;
  runtimeState.outbound = state.outbound;
  module.exports.redis = state.redis;
  return rawRequest;
}});
// ctx.call('remote:...') from a worker: sent over the worker's own channel to
// the main thread, which checks its token (lib/handler-ctx.js).
Object.defineProperty(module.exports, '__remoteCall', {enumerable: false, configurable: false, writable: false, value: (data, callback) => {
  const wm = (runtimeState.dm != null) ? runtimeState.dm.workerMessage : null;
  if (wm == null) return callback(new CountinghouseError('CTX_CALL_NOT_READY', 'remote'), null);
  return wm.sendRemoteCallToParent(data, callback);
}});
