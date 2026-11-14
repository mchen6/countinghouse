const events      = require('events');
const util        = require('util');
const UUID        = require('uuid-1345');
const CHDevice  = require('./countinghouse-device');
const validator   = require('./validator');
const LOG         = require('./logger');
const options     = require('../lib/cli-options');
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const CHUtil    = require('./countinghouse-util');
const JobControl     = require('./store').jobs;   // the store's job runner (lib/store.js)
const Worker         = require('worker_threads').Worker;
// worker_threads at load, before a worker's lockdown: the peer path reads
// threadId in a module's call, where the lockdown refuses the builtin
// (R2-1 Task 3; the same as #116 for handler-ctx).
const workerThreads = require('worker_threads');
const isMainThread = workerThreads.isMainThread;
const WorkerMessage  = require('./worker-message');
const redisAPI       = require('./redis-api');
const PeerChannelBroker = require('./peer-channel-broker');
const PeerChannel       = require('./peer-channel');
const encodeLegacyTool  = require('./metering/provider').encodeLegacyTool;
const deviceIdConflict  = require('./device-id-conflict');
const callAddress = require('./call-address');
const handlerCtx  = require('./handler-ctx');

// Logged when the server is ready to serve -- see onAllModulesDiscovered.
// test/helpers/wait-for-ready.js and the example verify scripts match this
// text, so changing it changes what they wait for.
const READY_LINE = 'countinghouse ready';
// getAuthProvider() is main-thread only (lib/auth/index.js's header) and
// constructed lazily/cached on first call, so requiring the module itself
// here at top scope is cheap -- it does not touch any backend (sqlite/
// couchdb) until verifyComposition below actually calls getAuthProvider().
const authModule   = require('./auth');

// The per-device limiter (the device spec's `rateLimit`, on Redis db 9) is
// retired (S1): --apiKeyRateLimit, --globalRateLimit and the job bounds
// replace it.

function DeviceManager(mm) {
  this.deviceMap     = {};
  this.moduleManager = mm;

  this.allDevicesLoaded = false;
  this.notifyDeviceLoad = {};

  // Set true after the FIRST run of onAllModulesDiscovered's composition
  // verification loop. 'allmodulediscovered' is not a once-per-process
  // event (see that method's own comment) -- this flag is what lets it
  // tell its first, startup run apart from every later re-verification.
  this._compositionStartupDone = false;

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
  this.on('querydevice',     this.onQueryDevice.bind(this));

  this.on('getdevicepackageinfo',         this.onGetDevicePackageInfo.bind(this));
}

util.inherits(DeviceManager, events.EventEmitter);

DeviceManager.prototype.onGetDevicePackageInfo = function(deviceID, callback) {
  if (deviceID == null) return callback(new Error('illegal deviceID'));

  const cdifDevice = this.deviceMap[deviceID];

  if (cdifDevice == null) return callback(new Error('unknown device'));

  //under both single-thread and worker-thread mode, packageInfo is annotated on deviceObj.packageInfo
  return callback(null, cdifDevice.packageInfo);
};

DeviceManager.prototype.onDeviceOnline = function(cdifDevice, moduleInstance, moduleName, packageInfo, modulePath) {
  if (this.checkDeviceInterface(cdifDevice) === false) {
    // Name the module and the stage. Without this, checkDeviceInterface's
    // `lastDeviceError != null` branch returns false having logged nothing at
    // all (the error it is reacting to was logged earlier, possibly with no
    // module name attached), and the module then just never appears --
    // see docs/module-development.md's troubleshooting section.
    LOG.E(new CountinghouseError('MODULE_NO_DEVICE_ONLINE', moduleName,
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
      LOG.E(new CountinghouseError('DEVICE_SPEC_VALIDATION_FAIL', moduleName, detail));
      LOG.DE(cdifDevice, new CountinghouseError('DEVICE_SPEC_VALIDATION_FAIL', error.message));
      if (options.verifyModule !== true) return;       // fall through in case of we are verifying a module
    }
    if (moduleInstance == null) {
      LOG.DE(cdifDevice, new CountinghouseError('INVALID_MODULE_INSTANCE', cdifDevice.spec.device.friendlyName));
      if (options.verifyModule !== true) return;      // fall through in case of we are verifying a module
    }

    // deviceID is generated in CHDevice's constructor code
    // and should be already available here
    const uuid = cdifDevice.deviceID;
    if (uuid == null) {
      LOG.DE(cdifDevice, new CountinghouseError('DEVICE_ID_INVALID_OR_NULL'));
      return;
    }

    const existingConflict = deviceIdConflict.conflictingModulePath(this.deviceMap[uuid], modulePath);
    if (existingConflict != null) {
      LOG.DE(cdifDevice, new CountinghouseError('DEVICE_OBJECT_CONFLICT',
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
    // single-thread mode: this is the main thread (a worker's device is announced from its 'deviceonline')
    this.toolsetChanged();

    if (!isMainThread) {
      this.workerMessage.sendDeviceOnlineMessageToParent({deviceID: uuid, spec: cdifDevice.spec, moduleName: moduleName, packageInfo: packageInfo, modulePath: modulePath});

    }
    // This discovery's device is registered (and, in a worker, its online
    // message sent to the parent): discovery may end (module-manager.js
    // whenDiscovered).
    if (moduleInstance != null && typeof(moduleInstance.emit) === 'function') moduleInstance.emit('devicereported', cdifDevice);

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

DeviceManager.prototype.sendActionInvokeMessageToParent = function(deviceID, serviceID, actionName, args, callback) {
  return this.workerMessage.sendActionInvokeMessageToParent(deviceID, serviceID, actionName, args, callback);
};

// --- direct peer channels (docs/direct-peer-channels-design.md), worker-side, caller role ---
// This is what lib/service-client.js calls instead of
// sendActionInvokeMessageToParent above when --directPeerChannels is on.
// Runs inside a worker thread only.
DeviceManager.prototype.invokeActionViaPeerChannel = function(deviceID, serviceID, actionName, args, callback) {
  const workerId = this.peerDeviceWorkerMap[deviceID];
  const channel  = (workerId != null) ? this.peerChannels[workerId] : null;

  if (channel != null && channel.closed !== true) {
    // fast path: a live, already-authorized port for this device's worker
    // exists -- invoke directly, zero main-thread involvement (D1/D2),
    // except the one-way announcement of the invoke (R2-1 Task 3).
    return channel.invoke(deviceID, serviceID, actionName, args.input, options.requestTimeoutMs, (err, data, platformMetering) => {
      if (err != null) return callback(CountinghouseError.fromReply(err), data);
      return callback(null, data, platformMetering);
    }, args.token);
  }

  // No live channel yet -- either this is the first call ever for this
  // device, or a previous channel to it was invalidated (D4) and this is
  // the call that triggers re-brokering. Queue behind a single in-flight
  // peer-channel-request per deviceID (D1's "A 在等待 grant 期间的后续调用进队列") --
  // only the first caller waiting on a given deviceID actually sends one.
  if (this.pendingPeerInvokes[deviceID] == null) {
    this.pendingPeerInvokes[deviceID] = [];
    // with the call's token (R2-1 Task 4): the broker opens a channel only to
    // a device the calling module declared calls on
    this.workerMessage.sendPeerChannelRequestToParent({targetDeviceID: deviceID, token: args.token});
  }
  this.pendingPeerInvokes[deviceID].push({serviceID: serviceID, actionName: actionName, args: args, callback: callback});
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
      // R2-1 Task 3 (spec 10b): each invoke is announced to the main thread
      // with the call's token, on the broker's pair key for this channel.
      announce: (invokeId, token) => _this.workerMessage.sendPeerAnnounceToParent(
        {channel: `${workerThreads.threadId}:${targetWorkerId}`, invokeId: invokeId, token: token}),
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
// msg carries the denial's rendered text and its code (errMsg, errCode),
// decoded as every other reply is (fromReplyFields): the text once, not
// rendered again around itself (high review of #37).
// The main thread refused this worker's announcement of a peer invoke
// (--moduleMessageRate; the review of #138, 6): the invoke fails at once
// with the refusal, instead of waiting out the callee's refusal a second
// later. {channel, invokeId, errMsg, errCode}; the channel key's second
// half is the callee worker, which is how this side keys its channels.
DeviceManager.prototype.onPeerAnnounceRefused = function(msg) {
  if (msg == null || typeof(msg.channel) !== 'string') return;
  const targetWorkerId = Number(msg.channel.split(':')[1]);
  const channel = this.peerChannels[targetWorkerId];
  if (channel == null) return;
  channel.fail(msg.invokeId, CountinghouseError.fromReplyFields({errMsg: msg.errMsg, errCode: msg.errCode != null ? msg.errCode : 'RATE_LIMITED'}));
};

DeviceManager.prototype.onPeerChannelDeny = function(msg) {
  const err = CountinghouseError.fromReplyFields({errMsg: msg.errMsg, errCode: msg.errCode != null ? msg.errCode : 'PEER_CHANNEL_DENIED'});
  // The request carried the first queued call's token. That token refused
  // (its call over), only that call fails; the next queued call asks again
  // with its own.
  const queued = (this.pendingPeerInvokes != null) ? this.pendingPeerInvokes[msg.targetDeviceID] : null;
  if (err.code === 'CALL_TOKEN_INVALID' && queued != null && queued.length > 1) {
    const head = queued.shift();
    head.callback(err);
    return this.workerMessage.sendPeerChannelRequestToParent({targetDeviceID: msg.targetDeviceID, token: queued[0].args.token});
  }
  this.flushPendingPeerInvokes(msg.targetDeviceID, null, err);
};

DeviceManager.prototype.flushPendingPeerInvokes = function(deviceID, workerId, err) {
  const queued = this.pendingPeerInvokes[deviceID];
  delete this.pendingPeerInvokes[deviceID];
  if (queued == null) return;

  const channel = (workerId != null) ? this.peerChannels[workerId] : null;

  queued.forEach((item) => {
    if (err != null || channel == null) {
      return item.callback(err != null ? err : new CountinghouseError('PEER_GONE'));
    }
    channel.invoke(deviceID, item.serviceID, item.actionName, item.args.input, options.requestTimeoutMs, (cErr, data, platformMetering) => {
      if (cErr != null) return item.callback(CountinghouseError.fromReply(cErr), data);
      return item.callback(null, data, platformMetering);
    }, item.args.token);
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
  // The devices the broker granted on this channel, each with the actions
  // the calling module declared on it (R2-1 Task 4): the one it opened for,
  // and each later grant (onPeerChannelAllow). Module code can post on its
  // own end of a channel, so an invoke for any other device this worker
  // hosts is refused (review R2-2), and one for an undeclared action is
  // refused here, with no main round trip per invoke.
  const allowed = new Map([[msg.targetDeviceID, grantedActions(msg)]]);

  const channel = new PeerChannel(msg.port, {
    workerId: callerWorkerId,
    callerModule: null,   // no key crosses to the callee (R2-1 Task 4's review)
    // Backpressure (docs/direct-peer-channels.md's benchmark finding) --
    // see lib/peer-channel.js's maxConcurrentInvokes comment.
    maxConcurrentInvokes: options.directPeerChannelsMaxConcurrency,
    onInvoke: function(request, reply) {
      if (!allowed.has(request.deviceID)) {
        return reply(new CountinghouseError('PEER_NOT_GRANTED', String(request.deviceID).slice(0, 64)), null);
      }
      if (!allowed.get(request.deviceID).has(`${request.serviceID}|${request.actionName}`)) {
        return reply(new CountinghouseError('CTX_CALL_UNDECLARED', `${request.serviceID}/${request.actionName}`), null);
      }
      // The callee's work bills by its own token for this invoke (below), and
      // no key crosses the channel (R2-1 Task 5).
      // R2-1 Task 3: the peer path authorizes BEFORE it serves and bills on
      // success (spec 3 and 10b, as amended). The main thread matches this
      // request to the caller worker's announcement of the invoke; one it
      // cannot match runs no handler. The reply carries this worker's own
      // token for the invoke, which the handler's ctx runs under; after the
      // handler succeeds, the bill request cites it and the hop is billed
      // to the announced call's caller, as the routed path bills: a failed
      // hop costs nothing on either path.
      _this.workerMessage.sendPeerMeteringRequestToParent({
        channel:      `${callerWorkerId}:${workerThreads.threadId}`,
        invokeId:     request.id,
        deviceID:     request.deviceID,
        serviceID:    request.serviceID,
        actionName:   request.actionName
      }, (matchErr, unused, token, caller) => {
        if (matchErr != null) return reply(matchErr, null, null);
        // CdifInterface.prototype.invokeDeviceAction, same call the existing
        // main-thread-routed 'invoke-action' case in lib/sandbox.js makes --
        // reached via CHUtil.ci (set by CdifInterface's own constructor)
        // rather than a direct reference, since DeviceManager doesn't
        // otherwise keep a back-pointer to the CdifInterface that owns it.
        // the hop's caller as a module sees it, {id, isAdmin}, built on the
        // main thread with the match (R2-1 Task 5)
        const callArgs = Object.assign({input: request.input}, (typeof(token) === 'string') ? {token: token} : {},
          (caller != null && typeof(caller) === 'object') ? {ctx: {id: caller.id != null ? String(caller.id) : null, isAdmin: caller.isAdmin === true}} : {});
        CHUtil.ci.invokeDeviceAction(request.deviceID, request.serviceID, request.actionName, callArgs, (err, data) => {
          if (err != null) {
            // not served: the main thread drops the invoke's token, bills nothing
            if (typeof(token) === 'string') _this.workerMessage.sendPeerBillRequestToParent({token: token, served: false}, () => {});
            return reply(err, data);
          }
          _this.workerMessage.sendPeerBillRequestToParent({token: token}, (meteringErr, meteringResult) => {
            if (meteringErr != null) LOG.E(meteringErr);
            return PeerChannel.finishMeteredHop(meteringErr, data, meteringResult, reply);
          });
        });
      });
    },
    onClose: function() {
      if (_this.peerChannels[callerWorkerId] === this) delete _this.peerChannels[callerWorkerId];
    }
  });

  channel.allowedDevices = allowed;
  this.peerChannels[callerWorkerId] = channel;
};

// The declared actions a grant carries, as a Set. A grant without its list
// (no sender in this tree omits it) grants no action, fail closed, and says
// so in the log rather than leaving every invoke to fail unexplained.
function grantedActions(msg) {
  if (Array.isArray(msg.actions)) return new Set(msg.actions);
  LOG.E(new Error(`peer channel grant for ${String(msg.targetDeviceID || msg.deviceID).slice(0, 64)} came with no declared actions: every invoke on it will be refused CTX_CALL_UNDECLARED`));
  return new Set();
}

// Callee side: one more device granted on the channel from callerWorkerId.
DeviceManager.prototype.onPeerChannelAllow = function(msg) {
  const channel = this.peerChannels[msg.callerWorkerId];
  if (channel != null && channel.allowedDevices != null) channel.allowedDevices.set(msg.deviceID, grantedActions(msg));
};

// D4: main thread (or this worker's own PeerChannel 'close' listener, as a
// second, main-thread-independent safety net) says the channel to
// `msg.workerId` is no longer valid. Invalidating a PeerChannel that's
// already closed is a no-op (see PeerChannel.prototype.invalidate).
DeviceManager.prototype.onPeerInvalidate = function(msg) {
  const channel = this.peerChannels[msg.workerId];
  if (channel != null) channel.invalidate();
};

// The package.json the main thread pinned for a worker's module at its
// spawn, before any of the module's code ran (spawnModuleWorker,
// lib/manifest-pins.js), set on the proxy together with its host path; when
// the file could not be read, the worker's statement with no declarations;
// the worker's own statement only for a worker the main thread did not spawn
// from a host path.
function hostPackageInfo(wm, stated) {
  if (wm == null || wm.hostModulePath == null) return stated;
  if (wm.hostPackageInfo === undefined) {
    // a spawn path that set the host path without the pin: no declarations,
    // said once rather than taken from the worker
    if (wm.unpinnedLogged !== true) LOG.E(new Error(`module at ${wm.hostModulePath}: no package.json was pinned for it; no declarations are taken`));
    wm.unpinnedLogged = true;
  }
  if (wm.hostPackageInfo == null) return Object.assign({}, stated, {countinghouse: undefined});
  return wm.hostPackageInfo;
}

DeviceManager.hostPackageInfo = hostPackageInfo;

// install deviceonline event handler after worker loaded the module
// This is run in main thread under multi-thread mode
DeviceManager.prototype.onWorkerLoaded = function(workerMessage) {
  if (workerMessage == null) return;
  workerMessage.on('deviceonline', (msg, wm) => {
    const deviceID    = msg.data.deviceID;
    const spec        = msg.data.spec;
    const moduleName  = msg.data.moduleName;
    // The package.json the main thread reads itself, from the host path it
    // loaded the module from, never the one the worker states: its
    // countinghouse.calls are the module's declarations, which a module
    // must not be able to write for itself (R2-1 Task 4's review).
    const packageInfo = hostPackageInfo(wm, msg.data.packageInfo);
    // The host path the main thread loaded from: the worker reports the path
    // as it sees it, which under the file broker is /app for every module.
    const modulePath  = (wm.hostModulePath != null) ? wm.hostModulePath : msg.data.modulePath;

    // A worker being unloaded, already ended, or no longer its module's
    // current worker is going: what it announces now is not registered, or
    // it would undo what its unload recorded (the device's ended entry) and
    // leave a device the purge then drops as DEVICE_NOT_FOUND.
    // The module is the one the main thread loaded into this worker, never
    // the name the worker states (R2-1 Task 5).
    const hostName = (wm.hostModuleName != null) ? wm.hostModuleName : moduleName;
    const mm = this.moduleManager;
    if (wm.unloading === true || wm.ended != null || (mm != null && mm.modules != null && mm.modules[hostName] !== wm)) {
      LOG.I(`module: ${hostName}: a device announced by a worker that is going was not registered`);
      return;
    }
    // A worker announces only the devices its module's api.json declares
    // (read on the main thread at the spawn; the review of #163), at any
    // time: another module's device ID is not its to take.
    if (deviceID != null && wm.hostDeviceIDs instanceof Set && !wm.hostDeviceIDs.has(deviceID)) {
      LOG.E(new CountinghouseError('DEVICE_OBJECT_CONFLICT',
        `module ${hostName} announced device ${deviceID}, which its api.json does not declare -- refused`));
      return;
    }
    // A device ID is the worker's statement (#153's review): a device whose
    // module is reloading or restarting is that module's to bring back, so
    // another module announcing its ID meanwhile does not take it, nor the
    // hops and tools that would follow it. (A module unloaded for good
    // leaves its device free for whatever the operator loads next.)
    const endedState = (deviceID != null && mm != null && typeof(mm.endedStateForDevice) === 'function') ? mm.endedStateForDevice(deviceID) : null;
    if (endedState != null && endedState.name !== hostName && (endedState.code === 'MODULE_RELOADING' || endedState.code === 'MODULE_RESTARTING')) {
      LOG.E(new CountinghouseError('DEVICE_OBJECT_CONFLICT',
        `module ${hostName} announced device ${deviceID}, which belongs to module ${endedState.name} -- ` +
        'deviceID is derived from friendlyName, so two modules cannot share one. Rename one of them.'));
      return;
    }

    if (deviceID != null) {
      const existingConflict = deviceIdConflict.conflictingModulePath(this.deviceMap[deviceID], modulePath);
      if (existingConflict != null) {
        LOG.E(new CountinghouseError('DEVICE_OBJECT_CONFLICT',
          `friendlyName "${spec.device.friendlyName}" is already registered by ${
          existingConflict} -- deviceID ${deviceID} is derived from friendlyName, so two ` +
          'modules cannot share one. Rename one of them.'));
        return;
      }
    }

    wm.moduleName  = hostName;
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
      if (this.moduleManager != null && typeof(this.moduleManager.clearEndedDevice) === 'function') this.moduleManager.clearEndedDevice(deviceID);
      this.toolsetChanged();
    }

    if (this.allDevicesLoaded === false) {
      if (this.notifyDeviceLoad[deviceID] != null) {
        for (let i = 0; i < this.notifyDeviceLoad[deviceID].length; i++) {
          //see notifyDeviceLoad definition in queryDeviceForChild() method below
          const held      = this.notifyDeviceLoad[deviceID][i];
          const workerMsg = held.wm;
          const msgID     = held.msgID;

          // the access check a present device's query gets (the review of
          // 5b): the spec only to an identity granted the device
          DeviceManager.prototype.replyAfterQueryAccessCheck.call(this, workerMsg, msgID, deviceID, held.identity,
            () => workerMsg.sendDeviceQueryReplyToChild({msgID: msgID, errMsg: null, spec: spec}));
        }
        delete this.notifyDeviceLoad[deviceID];
      }
    }
  });

  workerMessage.on('jobprogress', (message, wm) => {
    if (!runsJob(wm, message.data.jobID)) return LOG.I(`job progress refused: job ${String(message.data.jobID).slice(0, 32)} is not running on this worker`);
    JobControl.updateJobProgress(message.data.jobID, message.data.progress);
  });

  workerMessage.on('querydevice', (message, wm) => {
    const deviceID = message.deviceID;
    const msgID    = message.id;

    this.queryDeviceForChild(deviceID, msgID, wm, {token: message.token});
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

    if (!redisAPI.isCommand(opName)) {
      return wm.sendRedisCommandReplyToChild({msgID: msgID, errMsg: `${String(opName).slice(0, 64)} is not a supported redis command`});
    }
    // the runtime's own keys (job history) are not a module's to read or write
    if (redisAPI.touchesRuntimeKey(opName, data)) {
      return wm.sendRedisCommandReplyToChild({msgID: msgID, errMsg: `${opName} refused: the key is one the runtime keeps for itself`});
    }
    redisAPI.client[opName](data, (e, result) => {
      if (e) return wm.sendRedisCommandReplyToChild({msgID: msgID, errMsg: e.message});
      return wm.sendRedisCommandReplyToChild({msgID: msgID, result: result, errMsg: null});
    });
  });

  workerMessage.on('getjobinfo', (message, wm) => {
    const jobID = message.data.jobID;
    const msgID  = message.id;

    // Only a job this worker is running (invokeJobs records it): module code
    // can send this message with any id, and the main thread answered with
    // JobControl.INTERNAL, so any job, another tenant's API key included,
    // was readable (review R3-1).
    if (!runsJob(wm, jobID)) {
      return wm.sendGetJobInfoReplyToChild({msgID: msgID, errMsg: 'that job is not running on this worker'});
    }
    JobControl.getJob(JobControl.INTERNAL, jobID, (e, job) => {
      if (e) return wm.sendGetJobInfoReplyToChild({msgID: msgID, errMsg: e.message});

      return wm.sendGetJobInfoReplyToChild({msgID: msgID, job: forWorker(job), errMsg: null});
    });
  });

  workerMessage.on('invokeforeignaction', (message, wm) => {
    const msgID = message.id;

    // A worker's hop names no identity and no billing key (R2-1 Task 5): the
    // main thread authorizes and bills it by its token.
    const deviceID   = message.data.deviceID;
    const serviceID  = message.data.serviceID;
    const actionName = message.data.actionName;
    const args       = message.data.args;
    // the call's token (R2-1 Task 3): what the hop is billed and checked by
    const token      = message.data.token;

    this.sendInvokeActionMessageToWorker(null, null, deviceID, serviceID, actionName, args, msgID, wm, token);
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
DeviceManager.prototype.sendInvokeActionMessageToWorker = function(appKey, billingKey, deviceID, serviceID, actionName, args, msgID, callerWM, token) {
  // R2-1 Task 3: the hop is billed by the call's token, which must be one
  // the main thread issued to the calling worker; an unknown, expired or
  // foreign token is refused before anything else, which tells the worker
  // nothing about the device. Side by side until Task 5: the hop authorizes
  // as the identity it names (`as`, worker-claimed exactly as today), else
  // as the token's (the module's runsModules binding); the stated
  // billingKey is ignored.
  const tokenEntry = callTokens.resolve(token, {workerId: callerWM.workerId});
  if (tokenEntry == null) {
    return callerWM.sendActionInvokeReplyToChild(Object.assign({msgID: msgID},
      CountinghouseError.replyFields(new CountinghouseError('CALL_TOKEN_INVALID', `${serviceID}/${actionName}`)), {data: null}));
  }
  const identity = callTokens.identityOf(tokenEntry);   // the token's alone (R2-1 Task 5)
  billingKey = tokenEntry.billingKey;
  appKey = identity;
  // R2-1 Task 4: a module calls only what it declared, whatever API it
  // used. The module is the one the calling worker hosts (its token's
  // device), never anything the message says; a target outside its resolved
  // declarations is refused before the access check, and a module that
  // declared nothing can hop nowhere.
  // Before the verdict has landed there is no binding yet: not ready, not
  // undeclared (the review of Task 4).
  if (!callTokens.hasVerdict(callerWM, tokenEntry.deviceID)) {
    return callerWM.sendActionInvokeReplyToChild(Object.assign({msgID: msgID},
      CountinghouseError.replyFields(new CountinghouseError('CTX_CALL_NOT_READY', `${serviceID}/${actionName}`)), {data: null}));
  }
  if (!callTokens.declaredTarget(bindingOf(callerWM, tokenEntry.deviceID), deviceID, serviceID, actionName)) {
    return callerWM.sendActionInvokeReplyToChild(Object.assign({msgID: msgID},
      CountinghouseError.replyFields(new CountinghouseError('CTX_CALL_UNDECLARED', `${serviceID}/${actionName}`)), {data: null}));
  }

  //find out callee's workerMessage instance
  const calleeWM = this.deviceMap[deviceID];

  if (calleeWM == null) {
    // Why the device is missing (restarting, suspended, unloaded, never
    // hosted) is answered only after userAuth, as to a client: a caller
    // without access gets the access error whatever the reason, so it cannot
    // tell a device once hosted here from one never hosted.
    return require('./user-auth')(null, null, deviceID, appKey, serviceID, actionName, () => {}, (err) => {
      if (err != null) {
        return callerWM.sendActionInvokeReplyToChild(Object.assign({msgID: msgID}, CountinghouseError.replyFields(err), {data: null}));
      }
      // every reason with its code, DEVICE_NOT_FOUND included (it used to
      // carry only the text 'device not found in map')
      const answer = this.missingDeviceErrorForHop(deviceID);
      return callerWM.sendActionInvokeReplyToChild(Object.assign({msgID: msgID}, CountinghouseError.replyFields(answer), {data: null}));
    });
  }


  const localCB = function(err, data, platformMetering) {
    if (err != null) {
      // errCode rides as a sibling of errMsg on the envelope itself, never
      // inside `data` -- `data` is the callee's own already-schema-validated
      // output, and a caller-side module may pass it straight through as its
      // own action's return value (see the platformMetering comment just
      // above this function); an extra key there fails that pass-through's
      // own output validation and hangs the call to its 30s timeout instead
      // of failing fast (lib/sandbox.js's 'invoke-action-reply' case has the
      // matching child-side reconstruction). Mirrors
      // lib/peer-channel.js's _dispatchInvoke, which already does this for
      // the --directPeerChannels path -- without it, a rejected ctx.call's
      // `.code` silently differed between the two paths (null here, the
      // real code there), even though `.fault` itself was always identical.
      // A callee module's error crosses whole (CountinghouseError.replyFields:
      // its origin and details too), so the composing module sees what it
      // would in single-thread mode.
      return callerWM.sendActionInvokeReplyToChild(Object.assign({msgID: msgID},
        CountinghouseError.replyFields(err), {data: data}));
    }
    return callerWM.sendActionInvokeReplyToChild(Object.assign({msgID: msgID}, CountinghouseError.replyFields(null), {data: data, platformMetering: platformMetering}));
  };

  // this should NEVER happen
  if (isMainThread !== true) {
    return callerWM.sendActionInvokeReplyToChild(Object.assign({msgID: msgID},
      CountinghouseError.replyFields(new Error('message not delivered by main thread')), {data: null}));
  }

  const userAuth    = require('./user-auth');

  userAuth(null, null, deviceID, appKey, serviceID, actionName, localCB, (err, session) => {
    if (err) return callerWM.sendActionInvokeReplyToChild(Object.assign({msgID: msgID}, CountinghouseError.replyFields(err), {data: null}));

    // Step 3c, checked only once user-auth has let the hop through, so a
    // refusal says nothing about a device the caller may not use: a
    // usageCall is the calling worker's claim (lib/usage/hop.js). An owned
    // one grants the callee's worker for this hop; a finished one is removed;
    // anything else is USAGE_CALL_FOREIGN and nothing is sent.
    const claim = claimHop(usageRuntime.usage(), args, callerWM.workerId);
    if (claim.error != null) {
      return callerWM.sendActionInvokeReplyToChild(Object.assign({msgID: msgID}, CountinghouseError.replyFields(claim.error), {data: null}));
    }
    // The callee as it stands now: a reload or a supervised restart during
    // the auth round trip replaces it, and the hop (and its grant) must go to
    // the worker that will run it (the review of #90). Gone meanwhile: answered
    // as the missing-device path answers, after auth as there.
    const current = this.deviceMap[deviceID];
    if (current == null) {
      return callerWM.sendActionInvokeReplyToChild(Object.assign({msgID: msgID}, CountinghouseError.replyFields(this.missingDeviceErrorForHop(deviceID)), {data: null}));
    }

    // The callee gets no key (R2-1 Task 5, #130's interim args.ctx removed):
    // its own token, issued below, is what its work bills and authorizes by
    // -- further hops, remote calls -- so a part bills whoever this hop bills
    // (test/remote/11, test/composition/20) with no key in its worker.

    session.setDeviceTimer(current, function(error, device, timer) {
      // The callee's own token for this hop (R2-1 Task 3): bound to its
      // worker, billing the same caller, chained to the caller's token, so a
      // part can hop and call remotes under the outer call. Never the
      // caller's token: that one is the caller worker's alone.
      const binding = bindingOf(current, deviceID);
      let child;
      try {
        child = callTokens.issue({billingKey: billingKey, identityKey: binding.identity, module: binding.module,
          workerId: current.workerId, deviceID: deviceID, parent: token, ttlMs: TOKEN_TTL_MS()});
      } catch (e) {   // the chain at its depth limit (HOP_CHAIN_TOO_DEEP)
        return this.callback(e, null);
      }
      // Only what a hop carries, from the calling worker's args: its input
      // and its usage call (checked above); the token is the main thread's.
      // Anything else the worker put there -- a ctx of its own making, a job
      // id -- does not reach the callee (R2-1 Task 5).
      // The callee's ctx.caller: the identity the hop authorized as, {id,
      // isAdmin}, built here, never a key (R2-1 Task 5).
      const hopArgs = {input: (args != null) ? args.input : undefined, token: child, ctx: require('./identity').callerOf(appKey)};
      if (args != null && Number.isInteger(args.usageCall)) hopArgs.usageCall = args.usageCall;
      // send foreign action call message to callee; an owned usageCall is
      // granted to it until it answers (sendCounted). The child token ends
      // with the hop's session timer too.
      const answered = dropAfter(child, options.requestTimeout);
      sendCounted(current, {deviceID: deviceID, serviceID: serviceID, actionName: actionName, args: hopArgs}, (err, data) => {
        answered();
        callTokens.drop(child);
        if (err) return this.callback(CountinghouseError.fromReply(err), data);

        if (CHUtil.ci == null) return this.callback(null, data);

        const tool = encodeLegacyTool(deviceID, serviceID, actionName);

        // An answer after the hop's session timer fired (the caller's
        // per-invoke timeout) reaches a caller that has failed the hop
        // already, and a failed hop costs 0 (the review of #138, 8): not
        // billed, on this path as on the peer path. The timer's own flag,
        // so the decision is the one the caller saw.
        if (timer != null && timer.expired === true) {
          LOG.I(`hop ${tool} not billed: it answered after the caller's timeout (${options.requestTimeout} ms), so the caller had failed it`);
          return this.callback(null, data, null);
        }

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
          return this.callback(new CountinghouseError('HOP_IDENTITY_UNRESOLVED',
            `${serviceID}/${actionName}`), null);
        }

        // billingKey, not appKey: userAuth above already ran on appKey (may
        // this call happen), and this is the other question (who pays).
        return CHUtil.ci.recordCall(billingKey, tool, options.mcpToolCallCost, (meteringErr, meteringResult) => {
          if (meteringErr) LOG.E(meteringErr);
          // the charge as a module may see it: no key (the review of #163)
          return this.callback(null, data, (meteringErr == null) ? require('./metering/provider').forModule(meteringResult) : null);
        });
      });
    }.bind(session));
  });
};

// for now this is not triggered
DeviceManager.prototype.onDeviceOffline = function(cdifDevice, moduleInstance) {
  LOG.DE(cdifDevice, new CountinghouseError('DEVICE_OFFLINE', cdifDevice.spec.device.friendlyName));
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
        cb(new CountinghouseError('DEVICE_NOT_FOUND', deviceID), null);
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
        workerMessage.sendDeviceQueryReplyToChild({msgID: msgID, errMsg: new CountinghouseError('DEVICE_NOT_FOUND', deviceID).message, spec: null});
      }
      delete this.notifyDeviceLoad[deviceID];
    }
  }

  // Composition verification (see verifyComposition below) runs here, after
  // both allDevicesLoaded is set and the notifyDeviceLoad drain above --
  // running before the flag is set would make a query for a not-yet-loaded
  // target queue forever instead of erroring, and running before the drain
  // would interleave our own querydevice traffic with the failure drain.
  //
  // getAuthProvider() (used inside verifyComposition) is main-thread only
  // (lib/auth/index.js's header comment) -- guarded here even though the
  // 'allmodulediscovered' event this method is bound to is, in the current
  // wiring, only ever emitted on the main thread (see module-manager.js's
  // guards on every emit site): this listener is unconditionally attached
  // by the DeviceManager constructor in every thread, main or worker, so
  // nothing prevents a future or exceptional path from firing it inside a
  // worker. A module declaring no "countinghouse.calls" is unaffected by
  // this whole block either way -- verifyComposition below returns early.
  //
  // IMPORTANT: this whole block runs on EVERY 'allmodulediscovered' emit,
  // not just once at process startup. ModuleManager.prototype.onModuleLoad
  // re-emits it on every subsequent module load/reload once
  // noofTotalModules > 0 (set from the startup module list) -- see its own
  // comment and the noofLoadedModules clamps beside it. this.deviceMap at
  // that point holds every device currently online, old and new alike, so
  // this loop re-verifies devices that already verified successfully and
  // may already be serving traffic.
  //
  // isReVerification (below) is what tells those two situations apart. On
  // the FIRST run (startup), a verification failure means the device was
  // never allowed to come online in the first place -- purging it from
  // deviceMap/wm.deviceList is correct and safe, nothing has shipped
  // traffic for it yet. On any LATER run, purging here would delete a
  // device that IS serving, with no recovery: 'deviceonline' will not fire
  // again for it, so its worker keeps running unreachable. So on
  // re-verification failure we never purge -- we only clear any existing
  // composition binding (handlerCtx.setComposition(..., null)), which
  // makes ctx.call refuse for that device while its own actions keep
  // being served. The failure is still logged the same way either run.
  if (isMainThread === true) {
    const isReVerification = this._compositionStartupDone === true;
    this._compositionStartupDone = true;

    // READY_LINE is logged once every device below has had its verdict
    // delivered -- for a worker-hosted device that means the relay into its
    // worker has been acknowledged, not merely sent, because that
    // acknowledgement is what ends ctx.call's CTX_CALL_NOT_READY window.
    // "all module discovered" is logged before any of this starts, so it
    // cannot serve as the signal; anything that waits for the server
    // (test/helpers/wait-for-ready.js, the example verify scripts, an
    // operator's deploy script) waits for this line instead. It is logged
    // again after every later pass, like the pass itself.
    let verdictsPending = Object.keys(this.deviceMap).length;
    // Test suite only (test/composition/19): the startup pass's verdicts are
    // delivered COUNTINGHOUSE_TEST_COMPOSITION_DELAY_MS late, to every device or,
    // with COUNTINGHOUSE_TEST_COMPOSITION_DELAY_MODULE, to that package's only.
    // The pass itself, and everything it decides, runs as it would.
    // Honoured only under the suite's own marker, and it says so.
    const testDelayMs = (process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG === '1') ? Number(process.env.COUNTINGHOUSE_TEST_COMPOSITION_DELAY_MS) : NaN;
    const testDelayModule = process.env.COUNTINGHOUSE_TEST_COMPOSITION_DELAY_MODULE;
    if (isReVerification !== true && testDelayMs > 0) LOG.I(`test hook: composition verdicts delivered ${testDelayMs} ms late${testDelayModule != null ? ` to ${testDelayModule}` : ''}`);
    const deliver = (packageInfo, fn) => {
      const name = (packageInfo != null) ? packageInfo.name : null;
      const held = isReVerification !== true && testDelayMs > 0 && (testDelayModule == null || testDelayModule === name);
      return held ? setTimeout(fn, testDelayMs) : fn();
    };
    const verdictDelivered = () => {
      verdictsPending--;
      if (verdictsPending === 0) this.announceReady();
    };
    if (verdictsPending === 0) this.announceReady();
    // The startup discovery has finished once every verdict of this first
    // pass is decided: a module that fails verification is purged then, so
    // it counts as failed, not loaded. Delivery into the workers is not
    // waited for (ctx.call waits for its own verdict).
    let decisionsPending = (isReVerification === true) ? 0 : Object.keys(this.deviceMap).length;
    const decided = () => {
      if (isReVerification === true) return;
      decisionsPending--;
      if (decisionsPending === 0) this.announceDiscovered();
    };
    if (isReVerification !== true && decisionsPending === 0) this.announceDiscovered();

    for (const deviceID in this.deviceMap) {
      const cdifDevice = this.deviceMap[deviceID];
      const fromWorker = (cdifDevice instanceof WorkerMessage);

      // Own spec/packageInfo/modulePath for this device: under
      // --workerThread, cdifDevice is the per-worker WorkerMessage proxy
      // (see onWorkerLoaded's 'deviceonline' handler above), which keeps
      // specs in .deviceList rather than a single .spec -- the same
      // fromWorker/.deviceList-vs-.spec distinction used elsewhere in this
      // file wherever a device's spec is resolved from either shape.
      const spec        = fromWorker ? cdifDevice.deviceList[deviceID] : cdifDevice.spec;
      const packageInfo = cdifDevice.packageInfo;
      const modulePath  = cdifDevice.modulePath;
      // The module name the main thread loaded (R2-1 Task 5, #148): on a
      // worker's proxy the one spawnModuleWorker set, never the worker's own
      // statement; in single-thread mode the device's, set on the main thread.
      const moduleName  = fromWorker ? cdifDevice.hostModuleName : cdifDevice.moduleName;

      this.verifyComposition(deviceID, spec, packageInfo, modulePath, moduleName, (err, composition) => {
        if (err != null) {
          // A broken chain must not serve traffic through ctx.call -- log
          // (this is the primary way an author learns about it -- see
          // verifyComposition's own comment) either way.
          LOG.E(err);

          if (isReVerification === true) {
            // Never purge an already-online device (see comment above) --
            // only disable ctx.call for it by clearing any composition
            // binding it may still be holding from a prior successful
            // verification.
            if (fromWorker) {
              this.clearBinding(cdifDevice, deviceID);
              cdifDevice.sendSetCompositionMessage({deviceID: deviceID, identity: null, allowed: null},
                (relayErr) => {
                  if (relayErr != null) {
                    LOG.E(new CountinghouseError('MODULE_COMPOSITION_INVALID', deviceID,
                      `re-verification failed and clearing its composition inside its worker ` +
                      `thread also failed: ${relayErr.message}`));
                  }
                  verdictDelivered();
                });
            } else {
              handlerCtx.setComposition(cdifDevice, null);
              verdictDelivered();
            }
            return;
          }

          // First (startup) run: purge just this deviceID, not the whole
          // module, so a sibling device in the same module that composes
          // correctly is unaffected.
          delete this.deviceMap[deviceID];
          if (fromWorker) delete cdifDevice.deviceList[deviceID];
          this.toolsetChanged();
          decided();
          // Its ctx.calls already waiting for a verdict are released,
          // unsettled, so they refuse CTX_CALL_NOT_READY now, not at the bound.
          deliver(packageInfo, () => {
            if (fromWorker) cdifDevice.sendSetCompositionMessage({deviceID: deviceID, release: true}, () => verdictDelivered());
            else { handlerCtx.releaseWaiters(cdifDevice); verdictDelivered(); }
          });
          return;
        }

        // A verdict is delivered even when there is nothing to bind --
        // "countinghouse.calls" absent is verifyComposition's documented
        // no-op, but it is still an answer, and handlerCtx.setComposition
        // being called AT ALL is what ends the startup window for this
        // device (see its comment). Returning early here instead left such
        // a module reporting CTX_CALL_NOT_READY forever, on a server that
        // had finished starting long ago.
        const identity = (composition != null) ? composition.identity : null;
        const allowed  = (composition != null) ? composition.allowed  : null;
        decided();

        if (fromWorker) {
          // Kept on the proxy too (R2-1 Task 3): the identity a token issued
          // for this device's calls authorizes hops as.
          if (cdifDevice.bindings == null) cdifDevice.bindings = {};
          cdifDevice.bindings[deviceID] = {identity: identity, module: moduleName,
            targets: new Set((composition != null && Array.isArray(composition.targets)) ? composition.targets : [])};
          // The real CHDevice this composition belongs to lives inside the
          // worker thread, not here -- this cdifDevice is only a proxy.
          // Relay the verdict across so the worker can call
          // handlerCtx.setComposition on its own local device object, the
          // same one buildCtx uses when a handler runs: the allowed set and
          // that the module is bound, never to whom (R2-1 Task 5, spec
          // section 2). The main thread keeps the binding and authorizes
          // every hop by the call's token.
          deliver(packageInfo, () => cdifDevice.sendSetCompositionMessage(
            {deviceID: deviceID, identity: (identity != null) ? callTokens.BOUND_IDENTITY : null, allowed: allowed},
            (relayErr) => {
              if (relayErr != null) {
                LOG.E(new CountinghouseError('MODULE_COMPOSITION_INVALID', deviceID,
                  `resolved composition successfully but failed to bind it inside its worker ` +
                  `thread: ${relayErr.message}`));
              }
              verdictDelivered();
            }));
        } else {
          deliver(packageInfo, () => {
            handlerCtx.setComposition(cdifDevice, (composition != null) ? composition : null);
            verdictDelivered();
          });
        }
      });
    }
  }
};

// Every address a module declares in package.json's "countinghouse.calls" is
// resolved here, after discovery has finished -- at startup, and again on
// every later re-verification triggered by a runtime module load (see the
// caller's comment for why re-verification does not purge on failure). A
// typo becomes a load-time error naming the module and the address,
// instead of a runtime failure the first time that code path is reached.
// ctx.call's own rejection does now carry a typed code an MCP client can
// branch on (lib/handler-ctx.js's guard clauses -- CTX_CALL_UNDECLARED and
// friends), but only the code survives the worker hop: this function's
// messages remain the only place the module, the offending address and the
// exact file to fix are all named together. Each one below names all three.
//
// Called from onAllModulesDiscovered for every device currently registered,
// each time that method runs (startup, and again on each later
// re-verification -- see its comment), after allDevicesLoaded is set and
// the notifyDeviceLoad drain has run: resolution below goes through the
// same 'querydevice' path that queues while discovery is in flight, so a
// composing module may declare a target that loads after it.
//
// callback(err, composition): err non-null means the module must not
// continue running with a composition binding intact (the caller purges
// it on the first run, or clears its existing binding on a later
// re-verification -- either way the device must not be left able to
// ctx.call out under a stale or unresolved identity). On success,
// composition is {identity, allowed} -- exactly the shape
// handlerCtx.setComposition expects -- or undefined when the module
// declares no "countinghouse.calls" at all, which is not an error.
DeviceManager.prototype.verifyComposition = function(deviceID, spec, packageInfo, modulePath, moduleName, callback) {
  const declared = (packageInfo != null && packageInfo.countinghouse != null &&
                    Array.isArray(packageInfo.countinghouse.calls))
    ? packageInfo.countinghouse.calls : null;

  if (declared == null || declared.length === 0) return callback(null);

  const friendlyName = (spec != null && spec.device != null) ? spec.device.friendlyName : null;
  const packageName  = (packageInfo != null && packageInfo.name != null) ? packageInfo.name : null;

  if (friendlyName == null) {
    return callback(new CountinghouseError('MODULE_COMPOSITION_INVALID', String(packageName),
      `declares "countinghouse.calls" in package.json (at ${modulePath}/package.json), but its ` +
      'own api.json has no device.friendlyName to bind the composition to.'));
  }

  // Composition binds by the MODULE the main thread loaded (R2-1 Task 5,
  // #148), never by a friendlyName the worker states: a device's
  // friendlyName is the module's own statement, so binding by it let a
  // module claim another module's identity by naming that module's device.
  // One identity runs a module, all its devices: the peer path's premise
  // (spec section 4) is one identity per worker. A device whose
  // friendlyName differs from the module name (a multi-device module) binds
  // with its module.
  //
  // Base AuthProvider.prototype.identityForModule (lib/auth/provider.js)
  // throws synchronously rather than reporting through its callback -- it
  // exists on every backend via the prototype chain (couchdb-auth-provider.js
  // inherits it and does not override it, since Task 3 only updated
  // file-provider.js and sqlite-provider.js), so `typeof` alone can't tell
  // an unsupported backend apart from a real implementation. Comparing
  // against the base prototype's own function catches it before the throw.
  const authProvider = authModule.getAuthProvider();
  if (authProvider.identityForModule === authModule.AuthProvider.prototype.identityForModule) {
    return callback(new CountinghouseError('MODULE_COMPOSITION_INVALID', friendlyName,
      `it declares "countinghouse.calls" in package.json, but the configured auth backend ` +
      `(--authProvider ${options.authProvider}) does not implement module composition ` +
      '(no identityForModule). Use --authProvider file or sqlite, or add identityForModule to it.'));
  }

  // ctx.call's own runtime refusal never reaches an MCP client with any
  // detail (lib/mcp/gateway.js's toolCallResult discards the fault payload
  // on error), so this load-time message is how an author actually learns
  // the chain is misconfigured -- it must name the file to edit
  // (options.authConfigPath, NOT package.json: package.json is already
  // correct at this point) rather than just the module.

  if (moduleName == null) {
    return callback(new CountinghouseError('MODULE_COMPOSITION_INVALID', friendlyName,
      'the main thread has no module name for it, so no identity can be bound to its declared calls'));
  }
  authProvider.identityForModule(moduleName, (identErr, identity) => {
    if (identErr != null) return callback(identErr);

    if (identity.conflicts != null) {
      return callback(new CountinghouseError('MODULE_COMPOSITION_INVALID', moduleName,
        `more than one auth identity claims this module in "runsModules": ${
        identity.conflicts.map((k) => require('./key-fingerprint').keyFingerprint(k)).join(', ')}. Exactly one must -- edit ${options.authConfigPath} so only ` +
        'one does.'));
    }
    // --debug with no auth file (the file provider with no --authConfigPath
    // and no COUNTINGHOUSE_API_KEY; not sqlite or couchdb, which name their
    // own identity source) is single-tenant and admin: a declared module no
    // identity claims there binds to the debug key (R2-1 Task 4, the
    // reviewer's narrowing), or, with no --debugKey, where every key is
    // accepted, to the session identity "debug". So the bundled demos load
    // in that mode; their declarations resolve without an access check, and
    // the log says so once per module. What their hops authorize as is
    // unchanged until Task 5: the `as` each module names, which under
    // --debug with a --debugKey must be that key. Under --debug with an
    // auth file, or anywhere else, an unbound declaration is the error it
    // always was. Billing is unchanged by the binding: the caller's token
    // decides who pays.
    if (identity.apiKey == null && options.debug === true && options.authConfigPath == null && options.singleIdentity !== true &&
        (options.authProvider == null || options.authProvider === 'file') && process.env.COUNTINGHOUSE_API_KEY == null) {
      identity = {apiKey: (options.debugKey != null) ? options.debugKey : 'debug', debug: true};
      if (!debugBoundLogged.has(moduleName)) {
        debugBoundLogged.add(moduleName);
        LOG.I(`${moduleName}: its declared calls authorize as the debug key (--debug, no auth file)`);
      }
    }
    if (identity.apiKey == null) {
      return callback(new CountinghouseError('MODULE_COMPOSITION_INVALID', moduleName,
        `it declares ${declared.length} composition target(s) in "countinghouse.calls" (package.json ` +
        `is fine as-is), but no auth identity in ${options.authConfigPath} lists the module "${moduleName}" in ` +
        `"runsModules" (sqlite: bind-module). Add it there, to the identity you want its inner hops authorized as` +
        `${(friendlyName !== moduleName) ? `; runsModules names the module (its package.json name), not the device's friendlyName "${friendlyName}"` : ''}.`));
    }

    const allowed = {};
    // the declared calls as resolved targets, `${deviceID}|${serviceID}|${action}`:
    // what the main thread lets this module's hops reach, whatever API it
    // used (R2-1 Task 4)
    const targets = [];
    let pending   = declared.length;
    let failed    = false;

    const finish = (err) => {
      if (failed === true) return;
      if (err != null) { failed = true; return callback(err); }
      pending--;
      if (pending === 0) return callback(null, {identity: identity.apiKey, allowed: allowed, targets: targets, debugBound: identity.debug === true});
    };

    declared.forEach((address) => {
      const parsed = callAddress.parseAddress(address);
      if (parsed == null) {
        return finish(new CountinghouseError('MODULE_COMPOSITION_INVALID', friendlyName,
          `"${address}" in ${modulePath}/package.json's "countinghouse.calls" is not a valid ` +
          `address -- expected ${callAddress.ADDRESS_FORM}`));
      }

      const targetID = callAddress.deviceIDForName(parsed.device);

      this.emit('querydevice', targetID, (qErr, deviceOrSpec) => {
        if (qErr != null) {
          return finish(new CountinghouseError('MODULE_COMPOSITION_INVALID', friendlyName,
            `declares "${address}" in ${modulePath}/package.json, but module "${
            parsed.device}" is not loaded`));
        }

        // this.emit('querydevice', ...) hands back whatever this.deviceMap
        // holds: a real CHDevice (single-thread mode, .spec) or a
        // per-worker WorkerMessage proxy (--workerThread, .deviceList
        // keyed by deviceID) -- same distinction as everywhere else in this
        // file that reads deviceMap directly (e.g. onGetDiscoveredDeviceList).
        const targetSpec = (deviceOrSpec instanceof WorkerMessage)
          ? deviceOrSpec.deviceList[targetID]
          : (deviceOrSpec != null && deviceOrSpec.spec != null) ? deviceOrSpec.spec : deviceOrSpec;

        const resolved = callAddress.resolveAddress(targetSpec, parsed);
        if (resolved.ok !== true) {
          return finish(new CountinghouseError('MODULE_COMPOSITION_INVALID', friendlyName,
            `declares "${address}" in ${modulePath}/package.json: ${resolved.message}`));
        }

        targets.push(`${targetID}|${resolved.serviceID}|${parsed.action}`);
        // the debug key is admin: nothing to check
        if (identity.debug === true) { allowed[address] = true; return finish(null); }
        authProvider.authenticate(identity.apiKey, targetID, resolved.serviceID, parsed.action,
          (authErr, result) => {
            if (authErr != null) return finish(authErr);
            if (result.ok !== true) {
              return finish(new CountinghouseError('MODULE_COMPOSITION_INVALID', friendlyName,
                `identity ${require('./key-fingerprint').keyFingerprint(identity.apiKey)} has no grant to "${address}". Add device ${
                targetID} (module "${parsed.device}") to its "devices" in ${options.authConfigPath}.`));
            }
            allowed[address] = true;
            return finish(null);
          });
      });
    });
  });
};

// The ready line (READY_LINE above), logged after every discovery pass once
// its verdicts are delivered, and 'toolschanged': what tools/list shows may
// have changed.
DeviceManager.prototype.announceReady = function() {
  LOG.I(READY_LINE);
  this.toolsetChanged();
};

// Once: the startup discovery of the --loadModule modules has finished, each
// loaded or failed (failing composition verification included). Its verdicts
// may still be on their way into the workers. lib/route-manager.js holds
// --stdio's tools/list for it.
DeviceManager.prototype.announceDiscovered = function() {
  if (this.discovered === true) return;
  this.discovered = true;
  this.emit('discovered');
  this.toolsetChanged();
};

// What tools/list shows may have changed (a device came, went, or got its
// verdict): --stdio compares and tells its client (lib/route-manager.js).
DeviceManager.prototype.toolsetChanged = function() {
  if (isMainThread === true) this.emit('toolschanged');
};

// A composition disabled (its re-verification failed): the binding keeps
// no identity and no targets, so the main thread's declared-target check
// refuses every hop of the module until a verification passes again.
DeviceManager.prototype.clearBinding = function(cdifDevice, deviceID) {
  const b = (cdifDevice != null && cdifDevice.bindings != null) ? cdifDevice.bindings[deviceID] : null;
  if (b == null) return;
  b.identity = null;
  b.targets = new Set();
};

// purge all device objects which are managed by the unloaded module
// under worker thread mode moduleInstance represents a workerMessage instance
DeviceManager.prototype.onPurgeDevice = function(moduleInstance, reason, callback) {
  if (options.workerThread === true && isMainThread === true) {
    for (const deviceID in this.deviceMap) {
      if (this.deviceMap[deviceID] === moduleInstance) {
        delete moduleInstance.deviceList[deviceID];
        delete this.deviceMap[deviceID];
        this.toolsetChanged();

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
        this.toolsetChanged();
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
    return this.moduleManager.emit('querydevicelistresult', new CountinghouseError('MODULE_VERIFICATION_FAILED'), deviceList, packageInfo, callback);
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

  // Keep a restarting or suspended module's tools listed: clients get no
  // tools/list_changed notification, so a vanishing tool only confuses them.
  const supervisor = (this.moduleManager != null) ? this.moduleManager.supervisor : null;
  if (supervisor != null) {
    const retained = supervisor.retainedSpecs();
    for (const deviceID in retained) {
      if (result[deviceID] == null) result[deviceID] = retained[deviceID];
    }
  }
  return result;
};

// A device missing from deviceMap may belong to a module whose worker exited
// and is restarting or suspended (lib/module-supervisor.js); say so instead
// of DEVICE_NOT_FOUND.
DeviceManager.prototype.missingDeviceError = function(deviceID) {
  // In a worker being unloaded (lib/sandbox.js): its devices are going.
  if (this.endingCode != null) return new CountinghouseError(this.endingCode, deviceID);
  const supervisor = (this.moduleManager != null) ? this.moduleManager.supervisor : null;
  const state = (supervisor != null) ? supervisor.errorForDevice(deviceID) : null;
  if (state == null) {
    const ended = (this.moduleManager != null && typeof(this.moduleManager.endedStateForDevice) === 'function')
      ? this.moduleManager.endedStateForDevice(deviceID) : null;
    if (ended != null) return new CountinghouseError(ended.code, ended.name);
    return new CountinghouseError('DEVICE_NOT_FOUND', deviceID);
  }
  const when = state.retryAt != null ? `, retry after ${new Date(state.retryAt).toISOString()}` : '';
  return new CountinghouseError(state.code, state.module, `${state.reason}${when}`);
};

// The same, to a composing worker's hop (the main-thread path here and the
// direct peer path, lib/peer-channel-broker.js): DEVICE_NOT_FOUND without
// the ID, which the composing module named itself (review of c10: one
// place, not a copy at each site).
DeviceManager.prototype.missingDeviceErrorForHop = function(deviceID) {
  const missing = this.missingDeviceError(deviceID);
  return (missing.code === 'DEVICE_NOT_FOUND') ? new CountinghouseError('DEVICE_NOT_FOUND') : missing;
};

//under worker mode cdifDevice actually represents a workerMessage instance
DeviceManager.prototype.ensureDeviceState = function(deviceID, callback) {
  const cdifDevice = this.deviceMap[deviceID];

  if (options.workerThread === true && isMainThread === true) {
    //for now we assume under worker mode all devices running inside workers
    if (!(cdifDevice instanceof WorkerMessage)) return callback(this.missingDeviceError(deviceID));
  }

  if (cdifDevice == null) {  // check null or undefined
    return callback(this.missingDeviceError(deviceID));
  }

  if (cdifDevice.online === false) {
    return callback(new CountinghouseError('DEVICE_OFFLINE'));
  }

  callback(null, cdifDevice);
};

// The jobs each worker is running, so it can read and update those and no
// others (review R3-1). A worker-hosted device is its WorkerMessage here.
// Counted per run, not per job: a job failed by its timeout may be running
// again as a retry while the first run's handler is still going, and the
// first run's return must not take the retry's entry with it.
function runsJob(wm, jobID) {
  return wm != null && wm.jobsInFlight instanceof Map && wm.jobsInFlight.get(String(jobID)) > 0;
}

// What a worker gets of its job: never the creator's API key, nor the
// queue's options (review R3-1).
function forWorker(record) {
  if (record == null || record.job == null) return record;
  const data = Object.assign({}, record.job.data);
  delete data.apiKey;
  return Object.assign({}, record, {job: Object.assign({}, record.job, {data: data, opts: undefined})});
}

// jobArgs: what a job's run sends its worker (lib/job-args.js).
const jobArgs = require('./job-args');
// R2-1 Task 3: the per-call tokens the main thread issues with every call it
// sends to a worker, and bills and checks every hop by.
const callTokens = require('./call-tokens');
// options.requestTimeout is in milliseconds. A token lives as long as its
// call (the review of #138, 3): dropped at the call's session timeout, or
// at a run's timeout (extraArgs.timeoutMs, from the job runner; a run with
// none has a token with no end but its worker's), with a margin past that
// as the backstop.
const TOKEN_TTL_MS = () => options.requestTimeout + 60000;
// The modules bound to the debug key, logged once each per process.
const debugBoundLogged = new Set();
const TOKEN_MARGIN_MS = 60000;
// Drops `token` once `afterMs` have passed (never, for null): the timer is
// cleared by the returned function when the call answers first.
function dropAfter(token, afterMs) {
  if (token == null || afterMs == null) return () => {};
  const timer = setTimeout(() => callTokens.drop(token), Math.min(afterMs, 2147483647));
  timer.unref();
  return () => clearTimeout(timer);
}
const bindingOf = callTokens.bindingOf;
// Step 3c: the main thread's check of a hop's usageCall.
const {claimHop} = require('./usage/hop');
const usageRuntime = require('./usage/runtime');

// Step 3c (the review of #90): every send of a call to a worker goes through
// here, the gateway's (invokeAction), a task run's (invokeJobs) and a hop's
// (invokeforeignaction). A usageCall in the args is granted to the worker it
// is sent to for as long as that worker has not answered: released on its
// answer (which also comes, as a failure, when the worker ends), never on a
// session timer, since the worker may still be running under the open call.
// A finished call holds no grant either way.
function sendCounted(target, message, callback) {
  const args = message != null ? message.args : null;
  const call = (args != null && Number.isInteger(args.usageCall)) ? args.usageCall : null;
  const release = (call != null) ? usageRuntime.usage().grantCall(call, target.workerId) : () => {};
  return target.sendInvokeActionMessage(message, (...answer) => {
    release();
    return callback(...answer);
  });
}


DeviceManager.prototype.invokeJobs = function(cdifDevice, deviceID, serviceID, actionName, input, jobID, callback, extraArgs) {
  try {
    if (options.workerThread === true && isMainThread === true) {
      if (!(cdifDevice.jobsInFlight instanceof Map)) cdifDevice.jobsInFlight = new Map();
      const key = String(jobID);
      cdifDevice.jobsInFlight.set(key, (cdifDevice.jobsInFlight.get(key) || 0) + 1);
      // Step 3c: a task run's call is owned by the worker it is sent to, until
      // that worker answers (sendCounted). Its token (R2-1 Task 3) bills the
      // job's owner (extraArgs.ownerKey, from job-control; never sent on).
      const args = jobArgs(input, jobID, extraArgs);
      const ownerKey = (extraArgs != null) ? extraArgs.ownerKey : null;
      const timeoutMs = (extraArgs != null && Number.isFinite(extraArgs.timeoutMs) && extraArgs.timeoutMs > 0) ? extraArgs.timeoutMs : null;
      const binding = bindingOf(cdifDevice, deviceID);
      const token = (ownerKey != null) ? callTokens.issue({billingKey: ownerKey, identityKey: binding.identity, module: binding.module,
        workerId: cdifDevice.workerId, deviceID: deviceID, jobID: jobID, ttlMs: (timeoutMs != null) ? timeoutMs + TOKEN_MARGIN_MS : Infinity}) : null;
      if (token != null) args.token = token;
      // the task's caller as its handler's ctx shows it: the owner's {id,
      // isAdmin}, built here, never the key (R2-1 Task 5)
      if (ownerKey != null) args.ctx = require('./identity').callerOf(ownerKey);
      const answered = dropAfter(token, timeoutMs);
      sendCounted(cdifDevice, {deviceID: deviceID, serviceID: serviceID, actionName: actionName, args: args}, (err, result) => {
        answered();
        if (token != null) callTokens.drop(token);
        const left = (cdifDevice.jobsInFlight.get(key) || 1) - 1;
        if (left > 0) cdifDevice.jobsInFlight.set(key, left); else cdifDevice.jobsInFlight.delete(key);
        if (err) return callback(CountinghouseError.fromReply(err), result);
        return callback(null, result);
      });
    } else {
      return callback(new CountinghouseError('DEVICE_ACTION_CALL_FAIL', 'job cannot be processed in non-worker mode, please restart server in multi-thread mode. this job will fail.'));
    }
  } catch (e) {
    return callback(new CountinghouseError('DEVICE_ACTION_CALL_FAIL', e.message), null);
  }
};

DeviceManager.prototype.invokeAction = function(cdifDevice, deviceID, serviceID, actionName, args, session) {
  //in child thread session object represents a callback function
  if (typeof(session) === 'function') {
    try {
      cdifDevice.deviceControl(serviceID, actionName, args, session);
    } catch (e) {
      // console.log('DDDDDDD: ' + e);
      return session(new CountinghouseError('DEVICE_INVOKE_EXCEPTION'), e);
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
          //
          // Step 3c: the gateway's call is owned by the worker it is sent to,
          // until that worker answers (sendCounted).
          //
          // R2-1 Task 3: the call's token, issued here and dropped when the
          // worker answers: the caller's key is who its hops are billed to,
          // the module's binding who they authorize as.
          const binding = bindingOf(device, deviceID);
          const token = (this.appKey != null) ? callTokens.issue({billingKey: this.appKey, identityKey: binding.identity, module: binding.module,
            workerId: device.workerId, deviceID: deviceID, ttlMs: TOKEN_TTL_MS()}) : null;
          const callArgs = (token != null) ? Object.assign({}, args, {token: token}) : args;
          // dropped at the session's timeout too (lib/session.js's timer is
          // options.requestTimeout): the call has failed by then
          const answered = dropAfter(token, options.requestTimeout);
          sendCounted(device, {deviceID: deviceID, serviceID: serviceID, actionName: actionName, args: callArgs}, (err, data) => {
            answered();
            if (token != null) callTokens.drop(token);
            if (err) return this.callback(CountinghouseError.fromReply(err), data);
            return this.callback(null, data);
          });
        } else {
          device.deviceControl(serviceID, actionName, args, this);
        }
      } catch (e) {
        // console.log('AAAAAAA: ' + e.message);
        // console.log(e);
        return this.callback(new CountinghouseError('DEVICE_INVOKE_EXCEPTION'), e);
      }
    }.bind(session));
  }
};

// How long a job waits for its module to come back from a reload or a
// supervisor restart before it fails with MODULE_RELOADING/RESTARTING.
const JOB_RELOAD_WAIT_MS = 30000;
const JOB_RELOAD_POLL_MS = 100;

// A job (not a synchronous call: that fails at once) whose device is gone
// only for the moment -- its module reloading or being restarted, or its
// worker still being unloaded -- waits for the new worker, up to
// JOB_RELOAD_WAIT_MS. Whatever then stands is answered by ensureDeviceState:
// the device, MODULE_UNLOADED or MODULE_SUSPENDED if it ended that way, or
// the reloading/restarting code if the wait ran out. The wait is inside the
// job processor's pending promise, so bullmq keeps renewing the job's lock.
// cancelled (optional): once true (the processor's timeout), the wait ends
// with no callback; the processor has already failed the job.
DeviceManager.prototype.waitThroughReload = function(deviceID, callback, cancelled) {
  const deadline = Date.now() + JOB_RELOAD_WAIT_MS;
  const check = () => {
    if (typeof(cancelled) === 'function' && cancelled()) return;
    const present = this.deviceMap[deviceID];
    const leaving = (present instanceof WorkerMessage) && present.unloading === true;
    if (present != null && !leaving) return callback();
    const code = leaving ? 'MODULE_RELOADING' : this.missingDeviceError(deviceID).code;
    if ((code !== 'MODULE_RELOADING' && code !== 'MODULE_RESTARTING') || Date.now() >= deadline) return callback();
    return setTimeout(check, JOB_RELOAD_POLL_MS);
  };
  check();
};

DeviceManager.prototype.onInvokeJobs = function(deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) {
  if (options.workerThread === true && isMainThread === true) {
    return this.waitThroughReload(deviceID, () => this.invokeJobsNow(deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs), cancelled);
  }
  return this.invokeJobsNow(deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs);
};

DeviceManager.prototype.invokeJobsNow = function(deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) {
  // Given up on meanwhile (the processor's timeout during the reload wait):
  // nothing is sent to the worker, and the processor has already answered.
  if (typeof(cancelled) === 'function' && cancelled()) return;
  this.ensureDeviceState(deviceID, (err, cdifDevice) => {
    if (err) return callback(err);

    if (isMainThread !== true) return callback(new CountinghouseError('DEVICE_ACTION_CALL_FAIL', 'cannot start process job in child thread, this job will fail'));
    return this.invokeJobs(cdifDevice, deviceID, serviceID, actionName, input, jobID, callback, extraArgs);
  });
}

DeviceManager.prototype.onInvokeDeviceAction = function(deviceID, serviceID, actionName, args, session) {
  this.ensureDeviceState(deviceID, (err, cdifDevice) => {
    if (err) {
      if (typeof(session) === 'function') {
        return session(err, null);
      }
      return session.callbackWithoutTimer(err, null);
    }

    return this.invokeAction(cdifDevice, deviceID, serviceID, actionName, args, session);
  });
};

DeviceManager.prototype.onGetDeviceSpec = function(deviceID, session) {
  this.ensureDeviceState(deviceID, (err, cdifDevice) => {
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
          if (err) return this.callback(CountinghouseError.fromReply(err), data);
          return this.callback(null, data);
        });
      } else {
        return device.getDeviceSpec(this);
      }
    }.bind(session));
  });
};

DeviceManager.prototype.onGetDeviceSchema = function(deviceID, path, session) {
  this.ensureDeviceState(deviceID, (err, cdifDevice) => {
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
            if (err) return this.callback(CountinghouseError.fromReply(err), data);
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

DeviceManager.prototype.checkDeviceInterface = function(cdifDevice) {
  if (cdifDevice.lastDeviceError != null) {
    return false;
  }
  if (!(cdifDevice instanceof CHDevice)) {
    LOG.DE(cdifDevice, new CountinghouseError('DEVICE_OBJECT_NOT_VALID_CDIF_DEVICE'));
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
  this.ensureDeviceState(deviceID, (err, cdifDevice) => {
    if (err == null) return callback(null, cdifDevice);
    if (this.allDevicesLoaded === true) return callback(err, null);

    if (this.notifyDeviceLoad[deviceID] == null) {
      this.notifyDeviceLoad[deviceID] = [];
    }
    this.notifyDeviceLoad[deviceID].push(callback);
  });
};

//query specific deviceID for child thread
// claim (R2-1 Task 3): {token, appKey}, the call's token and, side by side
// until Task 5, the identity the module named. With a token the main thread
// issued to this worker, a missing device is answered with its reason to an
// identity granted it (the typed codes the reload work asked for), and with
// the access error to any other; without one, as before.
// The device query's access check (#153's review): the identity the call's
// token carries, granted the device, gets onGranted (the spec, or why the
// device is missing); any other identity the access error. With a deadline,
// as the other main-side lookups have: an auth backend that never answers
// gets the generic answer, and the worker's query is not left pending.
DeviceManager.prototype.replyAfterQueryAccessCheck = function(workerMessage, msgID, deviceID, identity, onGranted) {
  if (identity == null) {
    return workerMessage.sendDeviceQueryReplyToChild({msgID: msgID, errMsg: new CountinghouseError('DEVICE_NOT_FOUND', deviceID).message, spec: null});
  }
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    workerMessage.sendDeviceQueryReplyToChild({msgID: msgID, errMsg: new CountinghouseError('DEVICE_NOT_FOUND', deviceID).message, spec: null});
  }, options.peerChannelAuthLookupTimeoutMs);
  return require('./user-auth')(null, null, deviceID, identity, null, null, () => {}, (authErr) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (authErr != null) return workerMessage.sendDeviceQueryReplyToChild(Object.assign({msgID: msgID, spec: null}, CountinghouseError.replyFields(authErr)));
    return onGranted();
  });
};

DeviceManager.prototype.queryDeviceForChild = function(deviceID, msgID, workerMessage, claim) {
  // The query takes the call's token, and fails closed without it (the
  // review of #138, 5b): a query citing none, or another worker's, is
  // answered with nothing, the device present or not.
  const tokenEntry = (claim != null && claim.token != null) ? callTokens.resolve(claim.token, {workerId: workerMessage.workerId}) : null;
  if (tokenEntry == null) {
    return workerMessage.sendDeviceQueryReplyToChild(Object.assign({msgID: msgID, spec: null},
      CountinghouseError.replyFields(new CountinghouseError('CALL_TOKEN_INVALID', 'device query'))));
  }
  // R2-1 Task 5 (#148): a spec only for a device the calling module declared
  // calls on, as a hop reaches only those; any other device is refused as
  // its hop would be, the same whether it is present or not, so the query
  // tells a module nothing about devices it may not call. Before the
  // module's verdict nothing is declared yet: not ready, as a hop then is.
  if (!callTokens.hasVerdict(workerMessage, tokenEntry.deviceID)) {
    return workerMessage.sendDeviceQueryReplyToChild(Object.assign({msgID: msgID, spec: null},
      CountinghouseError.replyFields(new CountinghouseError('CTX_CALL_NOT_READY', 'device query'))));
  }
  if (!callTokens.declaresDevice(bindingOf(workerMessage, tokenEntry.deviceID), deviceID)) {
    return workerMessage.sendDeviceQueryReplyToChild(Object.assign({msgID: msgID, spec: null},
      CountinghouseError.replyFields(new CountinghouseError('CTX_CALL_UNDECLARED', String(deviceID).slice(0, 64)))));
  }
  const identity = callTokens.identityOf(tokenEntry);
  const answerAfterAccessCheck = (onGranted) => DeviceManager.prototype.replyAfterQueryAccessCheck.call(this, workerMessage, msgID, deviceID, identity, onGranted);
  this.ensureDeviceState(deviceID, (err, cdifDevice) => {
    if (err == null) {
      const spec = cdifDevice.deviceList[deviceID];
      return answerAfterAccessCheck(() => workerMessage.sendDeviceQueryReplyToChild({msgID: msgID, errMsg: null, spec: spec}));
    }

    // err not null, but all devices discovered: a missing device's reason
    // goes only to an identity that passes the access check (a module must
    // not learn whether a device it may not use was ever hosted).
    if (this.allDevicesLoaded === true) {
      return answerAfterAccessCheck(() => workerMessage.sendDeviceQueryReplyToChild(Object.assign({msgID: msgID, spec: null},
        CountinghouseError.replyFields(this.missingDeviceErrorForHop(deviceID)))));
    }

    // err not null, but still discovering, so we delay notification by saving it
    if (this.notifyDeviceLoad[deviceID] == null) {
      this.notifyDeviceLoad[deviceID] = [];
    }
    this.notifyDeviceLoad[deviceID].push({msgID: msgID, wm: workerMessage, identity: identity});
  });
}

DeviceManager.prototype.onModuleDiscovering = function() {
  // if (options.workerThread === true && isMainThread === true) LOG.I('setting allDevicesLoaded to false');
  this.allDevicesLoaded = false; // temporarily set this flag to false during module discovering
};


module.exports = DeviceManager;
