const os             = require('os');
const util           = require('util');
const events         = require('events');
const rewire         = require('rewire');
const request        = require('postman-request');
const soap           = require('soap');
const CHDevice     = require('./countinghouse-device');
const LOG            = require('./logger');
const CHError      = require('./countinghouse-error').CHError;
const DeviceError    = require('./countinghouse-error').DeviceError;
const QueryDevice    = require('./query-device');
const ServiceClient  = require('./service-client');
const options        = require('./cli-options');

const async          = require('async');
const stringify      = require('json-stringify-safe');
const redis          = require("redis");
const path           = require('path');

const Worker         = require('worker_threads').Worker;
const isMainThread   = require('worker_threads').isMainThread;

let redisClient    = null;

//create redis client under single thread mode or main thread
if (isMainThread === true) {
  redisClient    = redis.createClient(options.redisUrl, {db: 10});

  redisClient.on('error', (err) => {
    if (options.debug !== true) LOG.E(new CHError('REDIS_CLIENT_ERROR', err.message));
  });
}

module.exports = {
  // if this host run as router it may need to return its WAN IP address
  getHostIp: function() {
    if (options.bindAddr != null) return options.bindAddr;
    // if bindAddr not specified, then we bind to the first available interface, not 0.0.0.0 for security reason
    const interfaces = os.networkInterfaces();
    for (const k in interfaces) {
      for (const k2 in interfaces[k]) {
        const address = interfaces[k][k2];
          if (address.family === 'IPv4' && !address.internal) {
            // only return the first available IP
            return address.address;
          }
      }
    }
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
  //TODO: loadFile cannot handle relative path for now, use https://www.npmjs.com/package/callsites to get caller's file path and
  // based on that information, parse the relative path name in it
  loadFile: function(name) {
    // avoid entering global require cache
    // to be used by device modules to reload its impl. files on module reload
    // name must be absolute path to the files
    if (options.debug === true) {
      return rewire(path.resolve(name));
    }

    const loadedFile = rewire(path.resolve(name));
    if (loadedFile.__set__ == null) return loadedFile;

    // drop console under release mode, according to node.js v10.6 document
    loadedFile.__set__({
      console: {
        assert:         function() {},
        clear:          function() {},
        count:          function() {},
        countReset:     function() {},
        debug:          function() {},
        dir:            function() {},
        dirxml:         function() {},
        error:          function() {},
        group:          function() {},
        groupCollapsed: function() {},
        groupEnd:       function() {},
        info:           function() {},
        log:            function() {},
        table:          function() {},
        time:           function() {},
        timeEnd:        function() {},
        trace:          function() {},
        warn:           function() {}
      },
      __instrument__: {
        isAlive: function(callback) {
          process.nextTick(() => {
            return callback();
          });
        }
      }
    });

    return loadedFile;
  },
  request: function(opts, callback) {
    //wrapper for postman-request (maintained fork of the deprecated `request`
    //package, same API), https://www.npmjs.com/package/postman-request
    request(opts, callback);
  },
  createSOAPClient: function(url, opts, callback) {
    //wrapper for SOAP client, https://www.npmjs.com/package/soap
    soap.createClient(url, opts, callback);
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
              return cb(new CHError('SERVICE_NOT_FOUND', serviceID));
            });
          } else {
            return cb();
          }
        }, (err) => {
          if (err != null) {
            return callback(err, null);
          }
          if (targetService == null) {
            return callback(new CHError('DEVICE_NOT_FOUND', deviceID));
          }
          return callback(null, targetService);
        });
      });
    } else {
      // under non-debug mode we query local instance to find the service
      const queryDeviceObj = new QueryDevice(appKey, this.ci, deviceID, serviceID, callback, billingKey);

      if (options.workerThread !== true && isMainThread === true) {
        //non worker thread mode
        this.dm.emit('querydevice', deviceID, queryDeviceObj.callback);
      } else if (options.workerThread !== true && isMainThread === false) {
        //worker thread mode and running in child thread
        // see 'query-device-reply' message handler in app-sandbox and callback def in query-device.js
        // callback receives err and spec and return
        const wm = this.dm.workerMessage;
        if (wm != null) wm.sendDeviceQueryMessageToParent(deviceID, queryDeviceObj.callback);
      } else {
        //worker thread mode and running in main thread
        return callback(new CHError('QUERY_DEVICE_ON_MAIN_THREAD'));
      }

    }
  },

  // The spec of another loaded device, by deviceID. createServiceClient
  // already reaches it, but only as a step toward a client for a serviceID
  // the caller must already know -- ctx.call resolves the serviceID FROM the
  // spec, so it needs this half on its own.
  //
  // The thread-mode branches mirror createServiceClient's exactly,
  // deliberately: in worker mode the child asks the parent
  // (sendDeviceQueryMessageToParent queues the reply while discovery is
  // still running, which is what lets a composing module name a target
  // that loads after it), and calling from the main thread in worker mode
  // is a programming error, not a runtime condition. The CHDevice-vs-spec
  // discrimination below mirrors QueryDevice.prototype.callback
  // (lib/query-device.js) instead, using the same `instanceof CHDevice`
  // check rather than duck-typing a `.spec` property.
  queryDeviceSpec: function(deviceID, callback) {
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
      if (err != null) return callback(new Error(err.message), null);
      // main thread hands back a CHDevice, a worker hands back the spec itself
      const spec = (deviceOrSpec instanceof CHDevice) ? deviceOrSpec.spec : deviceOrSpec;
      if (spec == null || spec.device == null) {
        return callback(new CHError('NO_VALID_DEVICE_SPEC', deviceID), null);
      }
      return callback(null, spec);
    };

    if (options.workerThread !== true && isMainThread === true) {
      return this.dm.emit('querydevice', deviceID, relay);
    }
    if (options.workerThread !== true && isMainThread === false) {
      const wm = this.dm.workerMessage;
      if (wm == null) return callback(new CHError('QUERY_DEVICE_ON_MAIN_THREAD'), null);
      return wm.sendDeviceQueryMessageToParent(deviceID, relay);
    }
    return callback(new CHError('QUERY_DEVICE_ON_MAIN_THREAD'), null);
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
    LOG.I(`CHUtil.recordUsage (app-layer bookkeeping, no balance effect): apiKey=${apiKey} tool=${tool} cost=${cost}`);
    return callback(null, {apiKey: apiKey, tool: tool, cost: cost, ts: Date.now()});
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

    if (isMainThread === true) {
      redisClient.multi()
      .lpush(`devicelog:${deviceID}`, data)
      .lpush(`devicelogtimestamp:${deviceID}`, Date.now())
      .ltrim(`devicelog:${deviceID}`, 0, options.deviceLogEntrySize)
      .ltrim(`devicelogtimestamp:${deviceID}`, 0, options.deviceLogEntrySize)
      .exec((e, reply) => {
        if (e) LOG.E(e);
      });
    } else {
      const wm = this.dm.workerMessage;
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
      redisClient.multi()
      .lpush(`devicelog:${deviceID}`, data)
      .lpush(`devicelogtimestamp:${deviceID}`, timestamp)
      .ltrim(`devicelog:${deviceID}`, 0, options.deviceLogEntrySize)
      .ltrim(`devicelogtimestamp:${deviceID}`, 0, options.deviceLogEntrySize)
      .exec((e, reply) => {
        return callback(e);
      });
    } else {
      return callback(new Error('this should be called from main thread'));
    }
  },
  //TODO: add message broadcast support,
  // such as: broadCastMessage(data);

  redis: null,  //this reference is set in sandbox.js / framework.js

  jobProgress: function(jobID, progress) {
    // non worker mode
    if (options.workerThread !== true && isMainThread === true) return;

    if (typeof(jobID) !== 'string' && typeof(jobID) !== 'number') return;
    if (typeof(progress) !== 'number') return;
    if (progress < 0 || progress > 100) return;

    //worker thread mode and running in child thread
    if (options.workerThread !== true && isMainThread === false) {
      const wm = this.dm.workerMessage;
      if (wm != null) wm.sendJobProgressMessageToParent({jobID: jobID, progress: progress});
    }
  },

  jobInfo: function(jobID, callback) {
    if (isMainThread === true) return callback(new Error('cannot work in main thread and single-thread mode'));

    if (typeof(jobID) !== 'string' && typeof(jobID) !== 'number') return callback(new Error(`invalid jobID: ${jobID}. must be string or number type`));

    //worker thread mode and running in child thread
    const wm = this.dm.workerMessage;

    if (wm != null) {
      return wm.sendGetJobInfoMessageToParent(jobID, (e, job) => {
        if (e) LOG.E(e);
        return callback(e, job);
      });
    }

    return callback(new Error('unknown worker thread'));
  }
};
