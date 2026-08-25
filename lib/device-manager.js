const events      = require('events');
const util        = require('util');
const UUID        = require('uuid-1345');
const CHDevice  = require('./countinghouse-device');
const validator   = require('./validator');
const LOG         = require('./logger');
const options     = require('../lib/cli-options');
const OAuthDevice = require('./oauth/oauth');
const CHError   = require('./countinghouse-error').CHError;
const DeviceError = require('./countinghouse-error').DeviceError;
const CHUtil    = require('./countinghouse-util');
const JobControl     = require('./job-control');
const Worker         = require('worker_threads').Worker;
const isMainThread   = require('worker_threads').isMainThread;
const WorkerMessage  = require('./worker-message');
const monitor        = require('./monitor');
const redisAPI       = require('./redis-api');
const PeerChannelBroker = require('./peer-channel-broker');
const PeerChannel       = require('./peer-channel');
const encodeLegacyTool  = require('./metering/redis-provider').encodeLegacyTool;
const deviceIdConflict  = require('./device-id-conflict');


const v8  = require('v8');
const elu = require('perf_hooks').performance.eventLoopUtilization;

const redis       = require('redis');
const RateLimiter = require("rolling-rate-limiter");
let redisClient = null;


if (isMainThread === true) {
  //rate limit redis client for each device
  redisClient = redis.createClient(options.redisUrl, {db: 9});

  redisClient.on('error', (err) => {
    if (options.debug !== true) LOG.E(new CHError('REDIS_CLIENT_ERROR', err.message));
  });
}


function DeviceManager(mm) {
  this.deviceMap     = {};
  this.moduleManager = mm;

  this.allDevicesLoaded = false;
  this.notifyDeviceLoad = {};

  //this instance is used in child thread only, which
  //send its message through parent port and doesn't need to specify worker instance
  this.workerMessage  = new WorkerMessage(null);

  // Direct peer channels (docs/direct-peer-channels-design.md). The broker
  // (control plane: brokering, D3 auth, D4 invalidation) only exists on the
  // main thread -- see lib/peer-channel-broker.js's own header. The
  // caller-side bookkeeping below exists in every thread unconditionally
  // (cheap empty objects) but is only ever populated when a worker actually
  // makes a direct-peer-channel call, i.e. only under --directPeerChannels.
  this.peerChannelBroker  = (isMainThread === true) ? new PeerChannelBroker(this) : null;
  this.peerChannels       = {}; // targetWorkerId -> PeerChannel (worker-side, caller role)
  this.peerDeviceWorkerMap = {}; // deviceID -> targetWorkerId, once resolved by a grant
  this.pendingPeerInvokes  = {}; // deviceID -> [{serviceID, actionName, args, callback}, ...] queued while brokering is in flight

  this.moduleManager.on('deviceonline',        this.onDeviceOnline.bind(this));
  this.moduleManager.on('deviceoffline',       this.onDeviceOffline.bind(this));
  this.moduleManager.on('purgedevice',         this.onPurgeDevice.bind(this));
  this.moduleManager.on('querydevicelist',     this.onQueryDeviceList.bind(this));
  this.moduleManager.on('modulediscovering',   this.onModuleDiscovering.bind(this));
  this.moduleManager.on('allmodulediscovered', this.onAllModulesDiscovered.bind(this));
  this.moduleManager.on('workerloaded',        this.onWorkerLoaded.bind(this));

  this.on('discoverall',     this.onDiscoverAll.bind(this));
  this.on('stopdiscoverall', this.onStopDiscoverAll.bind(this));
  this.on('devicelist',      this.onGetDiscoveredDeviceList.bind(this));
  this.on('invokeaction',    this.onInvokeDeviceAction.bind(this));
  this.on('invokejobs',      this.onInvokeJobs.bind(this));
  this.on('getspec',         this.onGetDeviceSpec.bind(this));
  this.on('getschema',       this.onGetDeviceSchema.bind(this));
  this.on('invokecallback',  this.onInvokeDeviceCallback.bind(this));
  this.on('querydevice',     this.onQueryDevice.bind(this));

  this.on('getdevicepackageinfo',         this.onGetDevicePackageInfo.bind(this));
  this.on('getdevicepackagemodulepath',   this.onGetDevicePackageModulePath.bind(this));
}

util.inherits(DeviceManager, events.EventEmitter);

DeviceManager.prototype.onGetDevicePackageModulePath = function(deviceID, callback) {
  if (deviceID == null) return callback(new Error('illegal deviceID'));

  const cdifDevice = this.deviceMap[deviceID];

  if (cdifDevice == null) return callback(new Error('unknown device'));

  let spec = null;
  if (options.workerThread === true) {
    // in worker mode cdifDevice represents a workerMessage instance
    spec = cdifDevice.deviceList[deviceID];
  } else {
    spec = cdifDevice.spec;
  }

  //under both single-thread and worker-thread mode, modulePath is annotated on deviceObj.modulePath
  return callback(null, {spec: spec, modulePath: cdifDevice.modulePath});
};

DeviceManager.prototype.onGetDevicePackageInfo = function(deviceID, callback) {
  if (deviceID == null) return callback(new Error('illegal deviceID'));

  const cdifDevice = this.deviceMap[deviceID];

  if (cdifDevice == null) return callback(new Error('unknown device'));

  //under both single-thread and worker-thread mode, packageInfo is annotated on deviceObj.packageInfo
  return callback(null, cdifDevice.packageInfo);
};

DeviceManager.prototype.onDeviceOnline = function(cdifDevice, moduleInstance, moduleName, packageInfo, modulePath) {
  if (cdifDevice.oauth_version === '1.0' || cdifDevice.oauth_version === '2.0') {
    const oauth = new OAuthDevice(cdifDevice);
    oauth.createOAuthDevice();
  }

  if (this.checkDeviceInterface(cdifDevice) === false) {
    // Name the module and the stage. Without this, checkDeviceInterface's
    // `lastDeviceError != null` branch returns false having logged nothing at
    // all (the error it is reacting to was logged earlier, possibly with no
    // module name attached), and the module then just never appears --
    // see docs/module-development.md's troubleshooting section.
    LOG.E(new CHError('MODULE_NO_DEVICE_ONLINE', moduleName,
      `stage=checkDeviceInterface -- the device object failed its interface check${
      cdifDevice != null && cdifDevice.lastDeviceError != null
        ? ` (earlier error on this device: ${cdifDevice.lastDeviceError.message})`
        : ' (not a CHDevice instance)'}`));
    if (options.verifyModule !== true) return;       // fall through in case of we are verifying a module
  }

  validator.validateDeviceSpec(cdifDevice.spec, (error) => {
    if (error) {
      // Log the module name, the stage, and every ajv error with its
      // instancePath -- a bare "invalid spec" leaves a module author with no
      // way to find which action/service is wrong. validateDeviceSpec attaches
      // the structured list (see lib/validator.js).
      let detail = 'stage=validateDeviceSpec';
      if (Array.isArray(error.validationErrors) && error.validationErrors.length > 0) {
        detail += ` -- ${error.validationErrors.length} schema error(s): ${
                  error.validationErrors.map((e) => {
                    return `${e.instancePath} ${e.message}`;
                  }).join(' | ')}`;
      } else {
        detail += ` -- ${error.message}`;
      }
      LOG.E(new CHError('DEVICE_SPEC_VALIDATION_FAIL', moduleName, detail));
      LOG.DE(cdifDevice, new CHError('DEVICE_SPEC_VALIDATION_FAIL', error.message));
      if (options.verifyModule !== true) return;       // fall through in case of we are verifying a module
    }
    if (moduleInstance == null) {
      LOG.DE(cdifDevice, new CHError('INVALID_MODULE_INSTANCE', cdifDevice.spec.device.friendlyName));
      if (options.verifyModule !== true) return;      // fall through in case of we are verifying a module
    }

    // deviceID is generated in CHDevice's constructor code
    // and should be already available here
    const uuid = cdifDevice.deviceID;
    if (uuid == null) {
      LOG.DE(cdifDevice, new CHError('DEVICE_ID_INVALID_OR_NULL'));
      return;
    }

    const existingConflict = deviceIdConflict.conflictingModulePath(this.deviceMap[uuid], modulePath);
    if (existingConflict != null) {
      LOG.DE(cdifDevice, new CHError('DEVICE_OBJECT_CONFLICT',
        `friendlyName "${cdifDevice.spec.device.friendlyName}" is already registered by ${
        existingConflict} -- deviceID ${uuid} is derived from friendlyName, so two modules ` +
        'cannot share one. Rename one of them.'));
      if (options.verifyModule !== true) return;      // fall through in case we are verifying a module
    }

    cdifDevice.module      = moduleInstance;
    cdifDevice.moduleName  = moduleName;
    cdifDevice.packageInfo = packageInfo;
    cdifDevice.modulePath  = modulePath;
    cdifDevice.online      = true;

    LOG.I(`new device online: ${uuid}`);
    this.deviceMap[uuid] = cdifDevice;

    if (isMainThread === true) this.createRateLimiterForDevice(cdifDevice);

    if (!isMainThread) {
      this.workerMessage.sendDeviceOnlineMessageToParent({deviceID: uuid, spec: cdifDevice.spec, moduleName: moduleName, packageInfo: packageInfo, modulePath: modulePath});

      //send heap, cpu statistics data to ccl
      if (options.apiMonitor === true) {
        let lastELU = elu();
        setInterval(() => {
          const heapStat       = v8.getHeapStatistics();
          heapStat.timestamp = Date.now();

          const tmpELU = elu();
          // ELU represents the percentage of time the event loop has spent
          // outside the event loop's event provider
          // It differs to CPU util rate in some cases
          // See: https://nodesource.com/blog/event-loop-utilization-nodejs
          // And:
          // https://images.ctfassets.net/hspc7zpa5cvq/7Emz4rCm9LBevL41t0UvJz/6ed272657397d645992ca4fcf5081214/event_loop_diagram2.png
          // for more detailed explanation
          heapStat.elu = elu(tmpELU, lastELU);
          lastELU = tmpELU;
          // under single-thread mode heapStat data is sent in onAllModulesDiscovered code
          this.workerMessage.sendHeapStatisticsMessageToParent({heapStat: heapStat});
        }, 10000);
      }
    }

    // below code is valid only under single thread mode.
    // under worker thread mode, code below is never run in main thread, and it has no effect in child thread
    // because notifyDeviceLoad[uuid] would always be null
    // TODO: for the notifyDeviceLoad callback, send message to device's thread
    if (this.allDevicesLoaded === false) {
      if (this.notifyDeviceLoad[uuid] != null) {
        for (let i = 0; i < this.notifyDeviceLoad[uuid].length; i++) {
          const cb = this.notifyDeviceLoad[uuid][i];
          //TODO: this cb would eventually fall into user's module code (the callback of createServiceClient)
          // it could be unsafe and block the whole framework, we better to open a new thread to do this and
          // catch errors from it
          cb(null, cdifDevice);
        }
        delete this.notifyDeviceLoad[uuid];
      }
    }
  });
};

DeviceManager.prototype.createRateLimiterForDevice = function(cdifDevice) {
  cdifDevice.rateLimiter = null;

  if (options.debug === true) return; // under debug mode we have no redis support and we dont do rate limiting

  if (cdifDevice instanceof CHDevice) {
    if (cdifDevice.spec.device && cdifDevice.spec.device.rateLimit != null) {
      const limit = cdifDevice.spec.device.rateLimit;
      if (typeof(limit) !== 'number' || (limit % 1) !== 0 || limit <= 0) return; // limit must be > 0
      cdifDevice.rateLimiter = RateLimiter({
        redis: redisClient,             // use single client instance to handle all devices requests
        namespace: "deviceRateLimiter", // optional: allows one redis instance to handle multiple types of rate limiters. defaults to "rate-limiter-{string of 8 random characters}"
        interval: 1000,
        maxInInterval: limit
      });
    }
  } else if (cdifDevice instanceof WorkerMessage) {
    const deviceList = cdifDevice.deviceList;

    for (const deviceID in deviceList) {
      const spec = deviceList[deviceID];
      if (spec.device && spec.device.rateLimit != null) {
        const limit = spec.device.rateLimit;

        if (typeof(limit) !== 'number' || (limit % 1) !== 0 || limit <= 0) continue;
        cdifDevice.rateLimiters[deviceID] = RateLimiter({
          redis: redisClient,
          namespace: "deviceRateLimiter",
          interval: 1000,
          maxInInterval: limit
        });
      }
    }
  }
};

DeviceManager.prototype.sendActionInvokeMessageToParent = function(appKey, billingKey, deviceID, serviceID, actionName, args, callback) {
  return this.workerMessage.sendActionInvokeMessageToParent(appKey, billingKey, deviceID, serviceID, actionName, args, callback);
};

// --- direct peer channels (docs/direct-peer-channels-design.md), worker-side, caller role ---
// This is what lib/service-client.js calls instead of
// sendActionInvokeMessageToParent above when --directPeerChannels is on.
// Runs inside a worker thread only.
DeviceManager.prototype.invokeActionViaPeerChannel = function(appKey, billingKey, deviceID, serviceID, actionName, args, callback) {
  const workerId = this.peerDeviceWorkerMap[deviceID];
  const channel  = (workerId != null) ? this.peerChannels[workerId] : null;

  if (channel != null && channel.closed !== true) {
    // fast path: a live, already-authorized port for this device's worker
    // exists -- invoke directly, zero main-thread involvement (D1/D2).
    return channel.invoke(deviceID, serviceID, actionName, args.input, options.requestTimeout, (err, data, platformMetering) => {
      if (err != null) return callback(new DeviceError(err.code != null ? err.code : err.message), data);
      return callback(null, data, platformMetering);
    }, billingKey);
  }

  // No live channel yet -- either this is the first call ever for this
  // device, or a previous channel to it was invalidated (D4) and this is
  // the call that triggers re-brokering. Queue behind a single in-flight
  // peer-channel-request per deviceID (D1's "A 在等待 grant 期间的后续调用进队列") --
  // only the first caller waiting on a given deviceID actually sends one.
  if (this.pendingPeerInvokes[deviceID] == null) {
    this.pendingPeerInvokes[deviceID] = [];
    this.workerMessage.sendPeerChannelRequestToParent({targetDeviceID: deviceID, appKey: appKey});
  }
  this.pendingPeerInvokes[deviceID].push({serviceID: serviceID, actionName: actionName, args: args,
                                          callback: callback, billingKey: billingKey});
};

// D1: main thread granted (or re-confirmed, for a device sharing an
// already-open worker pair) a channel for `msg.targetDeviceID`.
DeviceManager.prototype.onPeerChannelGrant = function(msg) {
  const targetDeviceID = msg.targetDeviceID;
  const targetWorkerId = msg.targetWorkerId;

  this.peerDeviceWorkerMap[targetDeviceID] = targetWorkerId;

  if (msg.port != null && (this.peerChannels[targetWorkerId] == null || this.peerChannels[targetWorkerId].closed === true)) {
    const _this = this;
    this.peerChannels[targetWorkerId] = new PeerChannel(msg.port, {
      workerId: targetWorkerId,
      // Backpressure (docs/direct-peer-channels.md) -- caller-side cap on
      // outgoing invoke() calls, see lib/peer-channel.js's constructor
      // comment for why this needs to apply on both ends, not just the
      // callee's dispatch.
      maxConcurrentInvokes: options.directPeerChannelsMaxConcurrency,
      onClose: function() {
        // D4/port 'close': nothing to actively clean up in
        // peerDeviceWorkerMap -- invokeActionViaPeerChannel already checks
        // channel.closed before trusting a cached deviceID->workerId
        // mapping, so the next call to any device on this worker naturally
        // re-triggers brokering (D1's "对调用方模块代码完全透明").
        if (_this.peerChannels[targetWorkerId] === this) delete _this.peerChannels[targetWorkerId];
      }
    });
  }

  this.flushPendingPeerInvokes(targetDeviceID, targetWorkerId, null);
};

// D3: main thread denied brokering (unknown device, self-target, or the
// grant-time userAuth check failed).
DeviceManager.prototype.onPeerChannelDeny = function(msg) {
  const err = new DeviceError(msg.errCode != null ? msg.errCode : 'PEER_CHANNEL_DENIED', msg.errMsg);
  this.flushPendingPeerInvokes(msg.targetDeviceID, null, err);
};

DeviceManager.prototype.flushPendingPeerInvokes = function(deviceID, workerId, err) {
  const queued = this.pendingPeerInvokes[deviceID];
  delete this.pendingPeerInvokes[deviceID];
  if (queued == null) return;

  const channel = (workerId != null) ? this.peerChannels[workerId] : null;

  queued.forEach((item) => {
    if (err != null || channel == null) {
      return item.callback(err != null ? err : new DeviceError('PEER_GONE'));
    }
    channel.invoke(deviceID, item.serviceID, item.actionName, item.args.input, options.requestTimeout, (cErr, data, platformMetering) => {
      if (cErr != null) return item.callback(new DeviceError(cErr.code != null ? cErr.code : cErr.message), data);
      return item.callback(null, data, platformMetering);
    }, item.billingKey);
  });
};

// --- direct peer channels, worker-side, callee role ---
// D1: main thread is handing this worker a brand new port to register as
// callee for `callerWorkerId`. D5's metering hook lives here too: every
// incoming peer-invoke on this channel is metered via a synchronous
// request/reply to the main thread's PeerChannelBroker.handleMeteringRequest
// (the platform's sole billing authority -- see that method's own comment,
// and docs/composite-tools.md's "billing authority" principle) before the
// reply goes back to the caller, so the caller can see the real
// {charged, balance} result via reply's 3rd callback arg instead of
// metering itself redundantly (this is what used to cause double-billing).
//
// The metering result is passed as reply's 3rd argument, never merged into
// `data` -- `data` is the callee action's own, already-schema-validated
// return value, and some caller-side modules pass it straight through as
// *their own* action's output (e.g. echo-device-client-module's
// 服务名称-API名称.js). Merging an extra field into it broke that
// pass-through's own output validation (Service.prototype.validateActionCall
// throws on an unrecognized key), which silently hung the call until the
// session's 30s timeout -- see lib/peer-channel.js's _dispatchInvoke for
// the same note.
DeviceManager.prototype.onPeerChannelOpen = function(msg) {
  const _this = this;
  const callerWorkerId = msg.callerWorkerId;
  const appKey         = msg.appKey;

  const channel = new PeerChannel(msg.port, {
    workerId: callerWorkerId,
    callerModule: appKey,
    // Backpressure (docs/direct-peer-channels.md's benchmark finding) --
    // see lib/peer-channel.js's maxConcurrentInvokes comment.
    maxConcurrentInvokes: options.directPeerChannelsMaxConcurrency,
    onInvoke: function(request, reply) {
      // CdifInterface.prototype.invokeDeviceAction, same call the existing
      // main-thread-routed 'invoke-action' case in lib/sandbox.js makes --
      // reached via CHUtil.ci (set by CdifInterface's own constructor)
      // rather than a direct reference, since DeviceManager doesn't
      // otherwise keep a back-pointer to the CdifInterface that owns it.
      CHUtil.ci.invokeDeviceAction(request.deviceID, request.serviceID, request.actionName, {input: request.input}, null, (err, data) => {
        if (err != null) return reply(err, data);

        // Same rule as the main-thread-routed path
        // (sendInvokeActionMessageToWorker): a hop nobody can be billed for is
        // refused, not served for free. Checked before the metering request
        // rather than by treating its error reply as fatal, because that reply
        // also carries infrastructure failures (redis), where this codebase
        // deliberately fails open.
        // per call, falling back to the grant identity for a caller that
        // never set one (pre-split behaviour: one key doing both jobs)
        const billingKey = (request.billingKey != null) ? request.billingKey : appKey;

        if (billingKey == null) {
          return reply(new DeviceError('HOP_IDENTITY_UNRESOLVED',
            `${request.serviceID}/${request.actionName}`), null, null);
        }

        _this.workerMessage.sendPeerMeteringRequestToParent({
          callerModule: billingKey,
          deviceID:     request.deviceID,
          serviceID:    request.serviceID,
          actionName:   request.actionName
        }, (meteringErr, meteringResult) => {
          if (meteringErr != null) LOG.E(meteringErr);
          return reply(null, data, meteringResult);
        });
      });
    },
    onClose: function() {
      if (_this.peerChannels[callerWorkerId] === this) delete _this.peerChannels[callerWorkerId];
    }
  });

  this.peerChannels[callerWorkerId] = channel;
};

// D4: main thread (or this worker's own PeerChannel 'close' listener, as a
// second, main-thread-independent safety net) says the channel to
// `msg.workerId` is no longer valid. Invalidating a PeerChannel that's
// already closed is a no-op (see PeerChannel.prototype.invalidate).
DeviceManager.prototype.onPeerInvalidate = function(msg) {
  const channel = this.peerChannels[msg.workerId];
  if (channel != null) channel.invalidate();
};

// install deviceonline event handler after worker loaded the module
// This is run in main thread under multi-thread mode
DeviceManager.prototype.onWorkerLoaded = function(workerMessage) {
  if (workerMessage == null) return;
  workerMessage.on('deviceonline', (msg, wm) => {
    const deviceID    = msg.data.deviceID;
    const spec        = msg.data.spec;
    const moduleName  = msg.data.moduleName;
    const packageInfo = msg.data.packageInfo;
    const modulePath  = msg.data.modulePath;

    if (deviceID != null) {
      const existingConflict = deviceIdConflict.conflictingModulePath(this.deviceMap[deviceID], modulePath);
      if (existingConflict != null) {
        LOG.E(new CHError('DEVICE_OBJECT_CONFLICT',
          `friendlyName "${spec.device.friendlyName}" is already registered by ${
          existingConflict} -- deviceID ${deviceID} is derived from friendlyName, so two ` +
          'modules cannot share one. Rename one of them.'));
        return;
      }
    }

    wm.moduleName  = moduleName;
    wm.packageInfo = packageInfo;
    wm.modulePath  = modulePath;
    // we need to be able to handle multi device instances in the same module
    // we need this to be able to handle device-list call
    wm.deviceList[deviceID] = spec;

    wm.online = true; // to make ensureDeviceState happy
    if (deviceID != null) {
      //instead of cdifDevice we save workerMessage instance to deviceMap so we can send msg to it
      //in case one module contains multiple devices,
      //one wm.deviceList can hold multiple deviceID, and multiple deviceMap[deviceID] can refer to the same wm instance
      this.deviceMap[deviceID] = wm;
    }

    // this will initialize rateLimiter obj ref in workerMessage obj, which represents the device obj under workerThread mode.
    // so we areable to handle rate limiting in main thread for apps running inside child thread
    if (isMainThread === true) this.createRateLimiterForDevice(wm);

    if (this.allDevicesLoaded === false) {
      if (this.notifyDeviceLoad[deviceID] != null) {
        for (let i = 0; i < this.notifyDeviceLoad[deviceID].length; i++) {
          //see notifyDeviceLoad definition in queryDeviceForChild() method below
          const workerMsg = this.notifyDeviceLoad[deviceID][i].wm;
          const msgID     = this.notifyDeviceLoad[deviceID][i].msgID;

          workerMsg.sendDeviceQueryReplyToChild({msgID: msgID, errMsg: null, spec: spec});
        }
        delete this.notifyDeviceLoad[deviceID];
      }
    }
  });

  workerMessage.on('jobprogress', (message, wm) => {
    JobControl.updateJobProgress(message.data.jobID, message.data.progress);
  });

  workerMessage.on('querydevice', (message, wm) => {
    const deviceID = message.deviceID;
    const msgID    = message.id;

    this.queryDeviceForChild(deviceID, msgID, wm);
  });

  workerMessage.on('devicelog', (message, wm) => {
    const deviceID  = message.data.deviceID;
    const data      = message.data.data;
    const timestamp = message.data.timestamp;
    const msgID     = message.id;

    CHUtil.__deviceLogWithID(deviceID, data, timestamp, (e) => {
      if (e) return wm.sendDeviceLogReplyToChild({msgID: msgID, errMsg: e.message});
      return wm.sendDeviceLogReplyToChild({msgID: msgID, errMsg: null});
    });

  });

  workerMessage.on('rediscommand', (message, wm) => {
    const opName = message.data.op;
    const data   = message.data.data;
    const msgID  = message.id;

    redisAPI.client[opName](data, (e, result) => {
      if (e) return wm.sendRedisCommandReplyToChild({msgID: msgID, errMsg: e.message});
      return wm.sendRedisCommandReplyToChild({msgID: msgID, result: result, errMsg: null});
    });
  });

  workerMessage.on('getjobinfo', (message, wm) => {
    const jobID = message.data.jobID;
    const msgID  = message.id;

    // JobControl.INTERNAL: a worker asking about the job it is itself
    // executing, not a tenant-originated read -- there is no apiKey in
    // scope on this wire message to check against. See lib/job-control.js's
    // ownership comment.
    JobControl.getJob(JobControl.INTERNAL, jobID, (e, job) => {
      if (e) return wm.sendGetJobInfoReplyToChild({msgID: msgID, errMsg: e.message});

      return wm.sendGetJobInfoReplyToChild({msgID: msgID, job: job, errMsg: null});
    });
  });

  workerMessage.on('invokeforeignaction', (message, wm) => {
    const msgID = message.id;

    const appKey     = message.data.appKey;
    // absent on a client that never set one -- fall back to the auth identity,
    // which is exactly the pre-split behaviour (one key doing both jobs)
    const billingKey = (message.data.billingKey != null) ? message.data.billingKey : message.data.appKey;
    const deviceID   = message.data.deviceID;
    const serviceID  = message.data.serviceID;
    const actionName = message.data.actionName;
    const args       = message.data.args;

    this.sendInvokeActionMessageToWorker(appKey, billingKey, deviceID, serviceID, actionName, args, msgID, wm);
  });

  // Direct peer channels (docs/direct-peer-channels-design.md) -- delegates
  // to the broker rather than handling peer-channel-request/peer-metering
  // inline here, unlike invokeforeignaction above, since brokering needs
  // its own registry/state (lib/peer-channel-broker.js) this method has no
  // other reason to own.
  if (this.peerChannelBroker != null) this.peerChannelBroker.attachToWorker(workerMessage);
};

// D5, extended to the main-thread-routed path: platform automatic metering
// is the sole billing authority for cross-worker calls on *either* path
// (see lib/peer-channel-broker.js's PeerChannelBroker.prototype.
// handleMeteringRequest for the direct-peer-channel equivalent, and
// docs/composite-tools.md's "billing authority" principle). Already on the
// main thread here, so no cross-thread round trip is needed -- CHUtil.ci
// is called directly, synchronously in JS terms, right after the callee
// replies and before relaying that reply to the caller.
//
// The metering result rides as a 3rd, additive arg through
// localCB/Session.prototype.callback/sendActionInvokeReplyToChild, never
// merged into `data` -- `data` is the callee action's own,
// already-schema-validated return value, and some caller-side modules pass
// it straight through as *their own* action's output (e.g.
// echo-device-client-module's 服务名称-API名称.js). Merging an extra field
// into it broke that pass-through's own output validation
// (Service.prototype.validateActionCall throws on an unrecognized key),
// which silently hung the call until the session's 30s timeout -- see
// lib/peer-channel.js's _dispatchInvoke for the same note on the
// --directPeerChannels path.
//here callerWM represents caller's workerMessage instance
DeviceManager.prototype.sendInvokeActionMessageToWorker = function(appKey, billingKey, deviceID, serviceID, actionName, args, msgID, callerWM) {
  //find out callee's workerMessage instance
  const calleeWM = this.deviceMap[deviceID];

  if (calleeWM == null) {
    return callerWM.sendActionInvokeReplyToChild({msgID: msgID, errMsg: 'device not found in map', data: null});
  }


  const localCB = function(err, data, platformMetering) {
    if (err != null) {
      return callerWM.sendActionInvokeReplyToChild({msgID: msgID, errMsg: err.message, data: data});
    }
    return callerWM.sendActionInvokeReplyToChild({msgID: msgID, errMsg: null, data: data, platformMetering: platformMetering});
  };

  // this should NEVER happen
  if (isMainThread !== true) return callerWM.sendActionInvokeReplyToChild({msgID: msgID, errMsg: 'message not delivered by main thread', data: null});

  const userAuth    = require('./user-auth');

  userAuth(null, null, deviceID, appKey, serviceID, actionName, localCB, (err, session) => {
    if (err) return callerWM.sendActionInvokeReplyToChild({msgID: msgID, errMsg: err.message, data: null});

    session.setDeviceTimer(calleeWM, function(error, device, timer) {
      // send foreign action call message to callee
      calleeWM.sendInvokeActionMessage({deviceID: deviceID, serviceID: serviceID, actionName: actionName, args: args}, (err, data) => {
        if (err) return this.callback(new DeviceError(err.code != null ? err.code : err.message), data);

        if (CHUtil.ci == null) return this.callback(null, data);

        const tool = encodeLegacyTool(deviceID, serviceID, actionName);

        // An inner hop whose billing identity cannot be resolved used to be
        // metered for free, indefinitely, with no caller-visible signal:
        // recordCall's own `apiKey is required` guard fired, got logged, and
        // the call completed anyway. docs/cross-cutting-matrix.md recorded
        // that as a real (if narrow) monetization gap and asked for the
        // decision to be made before the ctx path started using it. Decided:
        // refuse the hop.
        //
        // Deliberately checked here, before recordCall, rather than by
        // treating any metering error as fatal. A recordCall failure can also
        // mean redis is down, and this codebase fails *open* on infrastructure
        // (see CdifInterface.prototype.rateLimit's comment). Unresolvable
        // identity is not an infrastructure failure -- it is a call that
        // nobody can be charged for, which is exactly what must not proceed.
        if (billingKey == null) {
          return this.callback(new DeviceError('HOP_IDENTITY_UNRESOLVED',
            `${serviceID}/${actionName}`), null);
        }

        // billingKey, not appKey: userAuth above already ran on appKey (may
        // this call happen), and this is the other question (who pays).
        return CHUtil.ci.recordCall(billingKey, tool, options.mcpToolCallCost, (meteringErr, meteringResult) => {
          if (meteringErr) LOG.E(meteringErr);
          return this.callback(null, data, (meteringErr == null) ? meteringResult : null);
        });
      });
    }.bind(session));
  });
};

// for now this is not triggered
DeviceManager.prototype.onDeviceOffline = function(cdifDevice, moduleInstance) {
  LOG.DE(cdifDevice, new CHError('DEVICE_OFFLINE', cdifDevice.spec.device.friendlyName));
  cdifDevice.online = false;
};

// we must garantee this event is handled after all deviceonline events are handled
// for now we emit this event from module-manager discovery code after 5 seconds of start discover,
// we consider all deviceonline events are already processed during this period.
DeviceManager.prototype.onAllModulesDiscovered = function() {
  // After setting allDevicesLoaded flag to true, we consider the remaining deviceIDs in above notifyDeviceLoad object
  // are invalid devices, and we invoke those callbacks with error information
  // if (options.workerThread === true && isMainThread === true) LOG.I('setting allDevicesLoaded to true');

  this.allDevicesLoaded = true;

  if (options.workerThread !== true && isMainThread === true) {
    // non worker thread mode
    for (const deviceID in this.notifyDeviceLoad) {
      const arr = this.notifyDeviceLoad[deviceID];
      for (let i = 0; i < arr.length; i++) {
        const cb = arr[i];
        cb(new CHError('DEVICE_NOT_FOUND', deviceID), null);
      }
      delete this.notifyDeviceLoad[deviceID];
    }
  } else if (options.workerThread === true && isMainThread === true) {
    // worker thread mode
    for (const deviceID in this.notifyDeviceLoad) {
      const arr = this.notifyDeviceLoad[deviceID];
      for (let i = 0; i < arr.length; i++) {
        const workerMessage = arr[i].wm;
        const msgID = arr[i].msgID;
        workerMessage.sendDeviceQueryReplyToChild({msgID: msgID, errMsg: new CHError('DEVICE_NOT_FOUND', deviceID).message, spec: null});
      }
      delete this.notifyDeviceLoad[deviceID];
    }
  }

  //under single thread mode we send process overall heap stats
  if (options.workerThread !== true && isMainThread === true && options.apiMonitor === true) {
    let lastELU = elu();

    setInterval(() => {
      const deviceList = {};

      //export spec to deviceList
      for (const deviceID in this.deviceMap) {
        const device = this.deviceMap[deviceID];

        if (device != null && device.spec != null) {
          deviceList[deviceID] = device.spec;
        }
      }

      const heapStat       = v8.getHeapStatistics();
      heapStat.timestamp = Date.now();
      const tmpELU         = elu();
      heapStat.elu       = elu(tmpELU, lastELU);
      lastELU            = tmpELU;

      monitor.sendHeapStatMessageToParentController(deviceList, {data: {heapStat: heapStat} });
    }, 10000);
  }
};

// purge all device objects which are managed by the unloaded module
// under worker thread mode moduleInstance represents a workerMessage instance
DeviceManager.prototype.onPurgeDevice = function(moduleInstance, reason, callback) {
  if (options.workerThread === true && isMainThread === true) {
    for (const deviceID in this.deviceMap) {
      if (this.deviceMap[deviceID] === moduleInstance) {
        delete moduleInstance.deviceList[deviceID];
        delete this.deviceMap[deviceID];

        // under worker-thread mode, in main thread we cannot get cdifDevice instance directly
        // which is available only in child thread , so we use __deviceLogWithID instead
        CHUtil.__deviceLogWithID(deviceID, reason, Date.now(), () =>{});
        // do not repeat the log in main thread
        // LOG.I('device purged: ' + deviceID);
      }
    }
    //notifier target has died, do not notify him again
    for (const id in this.notifyDeviceLoad) {
      const filtered = this.notifyDeviceLoad[id].filter((item) => {
        return item.wm !== moduleInstance;
      });
      this.notifyDeviceLoad[id] = filtered;
    }

    // D4: this fires whenever moduleInstance's device state goes stale to
    // other workers via a path the MAIN thread itself observes -- external
    // unload (onModuleUnload) and worker crash (module-manager.js's worker
    // 'error'/'exit' handlers, which both route through unloadModule ->
    // onModuleUnload) both emit 'purgedevice' here. NOT sufficient on its
    // own for a same-worker in-place reload, though (ModuleManager.
    // onModuleLoad's "module reloaded" branch, reached via
    // loadModuleByWorker's `wm != null` path) -- that purge happens
    // entirely inside the worker itself (this method's `else` branch
    // below), with the worker's identity/workerId never changing, so the
    // main thread has no other way to learn about it. See that branch's
    // sendPeerSelfInvalidateToParent call for the other half of D4's
    // coverage.
    if (this.peerChannelBroker != null) this.peerChannelBroker.invalidateWorker(moduleInstance);
  } else {
    // this runs in single thread mode or in child thread, we call _destroyDevice only in child thread
    for (const deviceID in this.deviceMap) {
      const device = this.deviceMap[deviceID];

      if (device != null && device.module === moduleInstance) {
        if (device instanceof CHDevice) {
          // do deviceLog under single thread mode
          // under multi-thread mode the log is done in main thread above
          if (isMainThread === true) CHUtil.deviceLog(device, reason);
          device.destroyCdifDevice();
        }
        delete this.deviceMap[deviceID];
        LOG.I(`device purged: ${deviceID}`);
      }
    }

    // D4: tell the main thread this worker just purged devices locally
    // (typically a same-worker in-place reload -- see
    // WorkerMessage.prototype.sendPeerSelfInvalidateToParent's comment for
    // why the main thread can't observe this any other way) so it can
    // invalidate any peer channel involving this worker. Only meaningful
    // inside an actual worker thread with the feature turned on -- true
    // single-thread mode (isMainThread === true here) has no peer channels
    // to invalidate in the first place, and skipping this entirely when
    // the flag is off avoids a pointless message on every purge for
    // deployments that never use direct peer channels.
    if (isMainThread === false && options.directPeerChannels === true) {
      this.workerMessage.sendPeerSelfInvalidateToParent();
    }
  }
  callback();
};

// special event handler to query list of devices under a module instance
// this is only active when verify package route is enabled
DeviceManager.prototype.onQueryDeviceList = function(moduleInstance, packageInfo, callback) {
  const deviceList = [];
  let hasError   = false;

  for (const deviceID in this.deviceMap) {
    if (this.deviceMap[deviceID].module === moduleInstance) {
      const cdifDevice = this.deviceMap[deviceID];
      const deviceInfo = {};

      deviceInfo.deviceErrorMessage = null;
      deviceInfo.spec               = JSON.parse(JSON.stringify(cdifDevice.spec)); //copy spec so we can deref schema in it

      if (cdifDevice.lastDeviceError != null) {
        hasError = true;
        deviceInfo.deviceErrorMessage = cdifDevice.lastDeviceError.message;
      } else {
        try {
          hasError = this.resolveSchemaInfo(cdifDevice, deviceInfo);
        } catch (e) {
          hasError = true;
          deviceInfo.deviceErrorMessage = e.message;
        }
      }
      deviceList.push(deviceInfo);
    }
  }

  if (hasError) {
    return this.moduleManager.emit('querydevicelistresult', new CHError('MODULE_VERIFICATION_FAILED'), deviceList, packageInfo, callback);
  }
  return this.moduleManager.emit('querydevicelistresult', null, deviceList, packageInfo, callback);
};

DeviceManager.prototype.onDiscoverAll = function(session) {
  this.moduleManager.discoverAllDevices();
  if (typeof(session) === 'function') return session(null);
  session.callbackWithoutTimer(null);
};

DeviceManager.prototype.onStopDiscoverAll = function(session) {
  this.moduleManager.stopDiscoverAllDevices();
  if (typeof(session) === 'function') return session(null);
  session.callbackWithoutTimer(null);
};

DeviceManager.prototype.onGetDiscoveredDeviceList = function(session) {
  const deviceList = [];
  // The inner loop used to reuse the name `i` too. Under `var` that is one
  // binding shared with the outer loop, so the inner walk overwrote the outer
  // key mid-iteration; it happened to be harmless only because `i` is not read
  // again after `cdifDevice` is taken from it. Renamed rather than left for
  // the next reader to re-derive that.
  for (const deviceID in this.deviceMap) {
    const cdifDevice = this.deviceMap[deviceID];

    if (cdifDevice instanceof WorkerMessage) {
      for (const idx in cdifDevice.deviceList) {
        const desc = JSON.parse(JSON.stringify(cdifDevice.deviceList[idx]));
        desc.device.serviceList = {};
        deviceList.push(desc);
      }
    } else {
      if (cdifDevice.spec) {
        //this is ugly but the easiest way to handle this request
        const desc = JSON.parse(JSON.stringify(cdifDevice.spec));
        desc.device.serviceList = {};
        deviceList.push(desc);
      }
    }
  }
  session.callbackWithoutTimer(null, deviceList);
};

// same deviceMap walk as onGetDiscoveredDeviceList, but keeps serviceList/actionList
// intact instead of stripping it -- the public device-list HTTP route hides action
// detail on purpose, the MCP gateway needs it to build tools/list. keyed by deviceID
// so entries reachable through more than one deviceMap key (worker-thread mode) collapse
// naturally instead of duplicating, the way an array-based walk would.
DeviceManager.prototype.getAllDeviceSpecs = function() {
  const result = {};
  for (const i in this.deviceMap) {
    const cdifDevice = this.deviceMap[i];

    if (cdifDevice instanceof WorkerMessage) {
      for (const deviceID in cdifDevice.deviceList) {
        result[deviceID] = cdifDevice.deviceList[deviceID];
      }
    } else if (cdifDevice.spec) {
      result[i] = cdifDevice.spec;
    }
  }
  return result;
};

//under worker mode cdifDevice actually represents a workerMessage instance
DeviceManager.prototype.ensureDeviceState = function(deviceID, token, callback) {
  const cdifDevice = this.deviceMap[deviceID];

  if (options.workerThread === true && isMainThread === true) {
    //for now we assume under worker mode all devices running inside workers
    if (!(cdifDevice instanceof WorkerMessage)) return callback(new CHError('DEVICE_NOT_FOUND', deviceID));
  }

  if (cdifDevice == null) {  // check null or undefined
    return callback(new CHError('DEVICE_NOT_FOUND', deviceID));
  }

  if (cdifDevice.online === false) {
    return callback(new CHError('DEVICE_OFFLINE'));
  }

  callback(null, cdifDevice);
};

DeviceManager.prototype.invokeJobs = function(cdifDevice, deviceID, serviceID, actionName, input, jobID, callback) {
  try {
    if (options.workerThread === true && isMainThread === true) {
      cdifDevice.sendInvokeActionMessage({deviceID: deviceID, serviceID: serviceID, actionName: actionName, args: {input: input, jobID: jobID}}, (err, result) => {
        if (err) return callback(new DeviceError(err.code != null ? err.code : err.message), result);
        return callback(null, result);
      });
    } else {
      return callback(new CHError('DEVICE_ACTION_CALL_FAIL', 'job cannot be processed in non-worker mode, please restart server in multi-thread mode. this job will fail.'));
    }
  } catch (e) {
    return callback(new CHError('DEVICE_ACTION_CALL_FAIL', e.message), null);
  }
};

DeviceManager.prototype.invokeAction = function(cdifDevice, deviceID, serviceID, actionName, args, session) {
  //in child thread session object represents a callback function
  if (typeof(session) === 'function') {
    try {
      cdifDevice.deviceControl(serviceID, actionName, args, session);
    } catch (e) {
      // console.log('DDDDDDD: ' + e);
      return session(new DeviceError('DEVICE_INVOKE_EXCEPTION'), e);
    }
  } else {
    session.setDeviceTimer(cdifDevice, function(error, device, timer) {
      try {
        if (options.workerThread === true && isMainThread === true) {
          // args.ctx used to be deleted here, because it held a Session and a
          // Session cannot be structured-cloned (req/res, timers, bound
          // functions) -- so nothing about the caller survived into the
          // worker, which is where handlers actually run in the default mode.
          //
          // It now holds the plain caller identity, set once in
          // CdifInterface.prototype.invokeDeviceAction, so it clones and can
          // simply travel. ctx.caller is built from it on the other side.
          // Nothing to strip.
          device.sendInvokeActionMessage({deviceID: deviceID, serviceID: serviceID, actionName: actionName, args: args}, (err, data) => {
            // console.log('EEEEEEE: ' + err.message);
            // console.log(data);
            if (err) return this.callback(new DeviceError(err.code != null ? err.code : err.message), data);
            return this.callback(null, data);
          });
        } else {
          device.deviceControl(serviceID, actionName, args, this);
        }
      } catch (e) {
        // console.log('AAAAAAA: ' + e.message);
        // console.log(e);
        return this.callback(new DeviceError('DEVICE_INVOKE_EXCEPTION'), e);
      }
    }.bind(session));
  }
};

DeviceManager.prototype.onInvokeJobs = function(deviceID, serviceID, actionName, input, jobID, callback) {
  this.ensureDeviceState(deviceID, null, (err, cdifDevice) => {
    if (err) return callback(err);

    if (isMainThread !== true) return callback(new CHError('DEVICE_ACTION_CALL_FAIL', 'cannot start process job in child thread, this job will fail'));
    return this.invokeJobs(cdifDevice, deviceID, serviceID, actionName, input, jobID, callback);
  });
}

DeviceManager.prototype.onInvokeDeviceAction = function(deviceID, serviceID, actionName, args, token, session) {
  this.ensureDeviceState(deviceID, token, (err, cdifDevice) => {
    if (err) {
      if (typeof(session) === 'function') {
        return session(err, null);
      }
      return session.callbackWithoutTimer(err, null);
    }

    if (isMainThread !== true) return this.invokeAction(cdifDevice, deviceID, serviceID, actionName, args, session);  // running inside child thread

    if (cdifDevice instanceof CHDevice) {
      // single thread mode
      if (cdifDevice.rateLimiter == null) return this.invokeAction(cdifDevice, deviceID, serviceID, actionName, args, session);

      cdifDevice.rateLimiter(this.deviceID, (err, timeLeft, actionsLeft) => {
        if (err) return this.invokeAction(cdifDevice, deviceID, serviceID, actionName, args, session);
        if (timeLeft) {
          // limit was exceeded, action should not be allowed,
          // TODO: update to HTTP statusCode 429
          return session.callbackWithoutTimer(new DeviceError('DENY_DEVICE_ACCESS'), null);
        } else {
          // limit was not exceeded, action should be allowed

          return this.invokeAction(cdifDevice, deviceID, serviceID, actionName, args, session);
        }
      });

    } else {
      //multi thread mode
      const rateLimiter = cdifDevice.rateLimiters[deviceID];
      if (rateLimiter == null) return this.invokeAction(cdifDevice, deviceID, serviceID, actionName, args, session);

      rateLimiter(this.deviceID, (err, timeLeft, actionsLeft) => {
        if (err) return this.invokeAction(cdifDevice, deviceID, serviceID, actionName, args, session);

        if (timeLeft) {
          // limit was exceeded, action should not be allowed,
          // TODO: update to HTTP statusCode 429
          return session.callbackWithoutTimer(new DeviceError('DENY_DEVICE_ACCESS'), null);
        } else {
          // limit was not exceeded, action should be allowed
          return this.invokeAction(cdifDevice, deviceID, serviceID, actionName, args, session);
        }
      });
    }
  });
};

DeviceManager.prototype.onGetDeviceSpec = function(deviceID, token, session) {
  this.ensureDeviceState(deviceID, token, (err, cdifDevice) => {
    if (err) {
      if (typeof(session) === 'function') {
        return session(err, null);
      }
      return session.callbackWithoutTimer(err, null);
    }

    //in child thread session object represents a callback function
    if (typeof(session) === 'function') {
      return cdifDevice.getDeviceSpec(session);
    }

    session.setDeviceTimer(cdifDevice, function(error, device, timer) {
      if (options.workerThread === true && isMainThread === true) {
        device.sendGetSpecMessage({deviceID: deviceID}, (err, data) => {
          if (err) return this.callback(new DeviceError(err.code != null ? err.code : err.message), data);
          return this.callback(null, data);
        });
      } else {
        return device.getDeviceSpec(this);
      }
    }.bind(session));
  });
};

DeviceManager.prototype.onGetDeviceSchema = function(deviceID, path, token, session) {
  this.ensureDeviceState(deviceID, token, (err, cdifDevice) => {
    if (err) {
      if (typeof(session) === 'function') {
        return session(err, null);
      }
      return session.callbackWithoutTimer(err, null);
    }

    //in child thread session object represents a callback function
    if (typeof(session) === 'function') {
      cdifDevice.resolveSchemaFromPath(path, null, (err, self, data) => {
        return session(err, data);
      });
    } else {
      session.setDeviceTimer(cdifDevice, function(error, device, timer) {
        if (options.workerThread === true && isMainThread === true) {
          device.sendGetDeviceSchemaMessage({deviceID: deviceID, path: path}, (err, data) => {
            if (err) return this.callback(new DeviceError(err.code != null ? err.code : err.message), data);
            return this.callback(null, data);
          });
        } else {
          device.resolveSchemaFromPath(path, null, (err, self, data) => {
            return this.callback(err, data);
          });
        }
      }.bind(session));
    }
  });
};

DeviceManager.prototype.onInvokeDeviceCallback = function(deviceID, path, data, token, session) {
  this.ensureDeviceState(deviceID, token, (err, cdifDevice) => {
    if (err) {
      if (typeof(session) === 'function') {
        return session(err, null);
      }
      return session.callbackWithoutTimer(err, null);
    }

    //in child thread session object represents a callback function
    if (typeof(session) === 'function') {
      try {
        cdifDevice.invokeDeviceCallback(path, data, session);
      } catch (e) {
        session(new DeviceError('DEVICE_INVOKE_CALLBACK_FAIL', e.message), null);
      }
    } else {
      session.setDeviceTimer(cdifDevice, function(error, device, timer) {
        try {
          if (options.workerThread === true && isMainThread === true) {
            device.sendInvokeDeviceCallbackMessage({deviceID: deviceID, path: path, data: data}, (err, data) => {
              if (err) return this.callback(new DeviceError(err.code != null ? err.code : err.message), data);
              return this.callback(null, data);
            });
          } else {
            device.invokeDeviceCallback(path, data, this);
          }
        } catch (e) {
          this.callback(new DeviceError('DEVICE_INVOKE_CALLBACK_FAIL', e.message), null);
        }
      }.bind(session));
    }
  });
};

DeviceManager.prototype.checkDeviceInterface = function(cdifDevice) {
  if (cdifDevice.lastDeviceError != null) {
    return false;
  }
  if (!(cdifDevice instanceof CHDevice)) {
    LOG.DE(cdifDevice, new CHError('DEVICE_OBJECT_NOT_VALID_CDIF_DEVICE'));
    return false;
  }
  return true;
};

// dereference all schemas in the device spec, only used to verify a package
// and return the full device API spec including resolved schema contents to the client
// if any error occurs, fill in the deviceInfo.deviceErrorMessage
// return true indicates error
DeviceManager.prototype.resolveSchemaInfo = function(cdifDevice, deviceInfo) {
  const spec = deviceInfo.spec;

  const serviceList  = spec.device.serviceList;
  const SCHEMA_KEYS  = ['input', 'output', 'fault'];

  for (const serviceID in serviceList) {
    const actionList = serviceList[serviceID].actionList;

    for (let i = 0; i < actionList.length; i++) {
      const action        = actionList[i];
      const loadedAction  = cdifDevice.services[serviceID].actions[action.name];

      for (let k = 0; k < SCHEMA_KEYS.length; k++) {
        const key = SCHEMA_KEYS[k];
        if (action[key] == null) continue;

        action[key].schema = JSON.parse(JSON.stringify(loadedAction[key].schema)); // replace path

        // fault schemas are free-form; only call arguments have to be a
        // document a caller can send or receive as a whole
        if (key === 'fault') continue;

        if (action[key].schema.type !== 'object' && action[key].schema.type !== 'array') {
          deviceInfo.deviceErrorMessage = `schema root type must be either object or array: ${
                                          serviceID  }/${action.name}/${key}`;
          return true;
        }
      }
    }
  }
  return false;
};

// lookup specific deviceID in deviceMap, if found return the device object or return null to callback
DeviceManager.prototype.onQueryDevice = function(deviceID, callback) {
  this.ensureDeviceState(deviceID, null, (err, cdifDevice) => {
    if (err == null) return callback(null, cdifDevice);
    if (this.allDevicesLoaded === true) return callback(err, null);

    if (this.notifyDeviceLoad[deviceID] == null) {
      this.notifyDeviceLoad[deviceID] = [];
    }
    this.notifyDeviceLoad[deviceID].push(callback);
  });
};

//query specific deviceID for child thread
DeviceManager.prototype.queryDeviceForChild = function(deviceID, msgID, workerMessage) {
  this.ensureDeviceState(deviceID, null, (err, cdifDevice) => {
    if (err == null) {
      const spec = cdifDevice.deviceList[deviceID];
      return workerMessage.sendDeviceQueryReplyToChild({msgID: msgID, errMsg: null, spec: spec});
    }

    // err not null, but all devices discovered
    if (this.allDevicesLoaded === true) {
      return workerMessage.sendDeviceQueryReplyToChild({msgID: msgID, errMsg: err.message, spec: null});
    }

    // err not null, but still discovering, so we delay notification by saving it
    if (this.notifyDeviceLoad[deviceID] == null) {
      this.notifyDeviceLoad[deviceID] = [];
    }
    this.notifyDeviceLoad[deviceID].push({msgID: msgID, wm: workerMessage});
  });
}

DeviceManager.prototype.onModuleDiscovering = function() {
  // if (options.workerThread === true && isMainThread === true) LOG.I('setting allDevicesLoaded to false');
  this.allDevicesLoaded = false; // temporarily set this flag to false during module discovering
};


module.exports = DeviceManager;
