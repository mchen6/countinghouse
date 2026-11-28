'use strict';
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
// R1: a per-session module's listing record, which keeps its spec in
// deviceList as a worker's proxy does (lib/session-module-record.js)
const {isRecord} = require('./session-module-record');
const keepsDeviceList = (d) => (d instanceof WorkerMessage) || isRecord(d);
// The module a device belongs to, by the name the main thread loaded it
// under (R2-1 Task 5, #148): on a worker's proxy the one spawnModuleWorker
// set, never the worker's own statement; in single-thread mode the
// device's, set on the main thread.
const moduleNameOf = (d) => (keepsDeviceList(d) ? d.hostModuleName : d.moduleName);
const redisAPI       = require('./redis-api');
const redisNamespace = require('./redis-namespace');
const PeerChannelBroker = require('./peer-channel-broker');
const encodeLegacyTool  = require('./metering/provider').encodeLegacyTool;
// a hop's charge, waited for at most METER_PENDING_MS (B-hopcharge)
const {boundedCharge, chargeLost} = require('./metering/charge-bound');
const deviceIdConflict  = require('./device-id-conflict');
const callAddress = require('./call-address');
const moduleSpec  = require('./module-spec');
const settingsGate = require('./settings-gate');
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

// required on first use, then kept (lib/require-once.js): no require() on the call path
const requireOnce = require('./require-once');
const identityLib = requireOnce(() => require('./identity'));
const pre8DeviceIdsLib = requireOnce(() => require('./pre-8-device-ids'));
const hopInputLib = requireOnce(() => require('./hop-input'));
// read from require.cache on each use: tests replace user-auth's entry
const userAuthLib = requireOnce.cached(require.resolve('./user-auth'));
const sessionLib = requireOnce(() => require('./session'));
const failedCallLogLib = requireOnce(() => require('./failed-call-log'));
// Whether the device is listed (#413 section 5.5; M5a: no session has a
// view of its own): a device whose module is going on or off is listed to
// no one, and answered as one never hosted, after the access check, at
// every hop (lib/module-visibility.js, main thread only)
const visibilityLib = requireOnce(() => require('./module-visibility'));
const listsDevice = (deviceID) => visibilityLib().listsDevice(deviceID);
const notListed = () => new CountinghouseError('DEVICE_NOT_FOUND');
const sessionsLib = requireOnce(() => require('./sessions'));

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
  this.peerCalleeChannels = {}; // callerWorkerId -> PeerChannel (worker-side, callee role)
  this.peerDeviceWorkerMap = {}; // deviceID -> targetWorkerId, once resolved by a grant
  this.pendingPeerInvokes  = {}; // deviceID -> [{serviceID, actionName, args, callback}, ...] queued while brokering is in flight

  this.moduleManager.on('deviceonline',        this.onDeviceOnline.bind(this));
  this.moduleManager.on('deviceoffline',       this.onDeviceOffline.bind(this));
  this.moduleManager.on('purgedevice',         this.onPurgeDevice.bind(this));
  // a restart or reload that won't come back: each device's hidden-text
  // decision (#400) goes with it, unless a device holds the ID now
  this.moduleManager.on('endeddevicessettled', (ids) => {
    for (const id of ids) if (!this.keepsDecision(id)) require('./hidden-text-verdict').forget(id);
  });
  this.moduleManager.on('querydevicelist',     this.onQueryDeviceList.bind(this));
  this.moduleManager.on('modulediscovering',   this.onModuleDiscovering.bind(this));
  this.moduleManager.on('allmodulediscovered', this.onAllModulesDiscovered.bind(this));
  this.moduleManager.on('workerloaded',        this.onWorkerLoaded.bind(this));
  this.moduleManager.on('registerdevices',     this.registerFromSpec.bind(this));

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

const specFailureDetail = moduleSpec.specFailureDetail;

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
    return;
  }

  validator.validateDeviceSpec(cdifDevice.spec, (error) => {
    if (error) {
      LOG.E(new CountinghouseError('DEVICE_SPEC_VALIDATION_FAIL', moduleName, specFailureDetail(error)));
      LOG.DE(cdifDevice, new CountinghouseError('DEVICE_SPEC_VALIDATION_FAIL', error.message));
      // a module that fails its spec never loads (the retired --verifyModule
      // let one through)
      return;
    }
    if (moduleInstance == null) {
      LOG.DE(cdifDevice, new CountinghouseError('INVALID_MODULE_INSTANCE', cdifDevice.spec.device.friendlyName));
      return;
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
      return;
    }

    cdifDevice.module      = moduleInstance;
    cdifDevice.moduleName  = moduleName;
    cdifDevice.packageInfo = packageInfo;
    cdifDevice.modulePath  = modulePath;
    cdifDevice.online      = true;

    LOG.I(`new device online: ${uuid}`);
    // its load's decision on hidden text, now that it serves (#400)
    require('./hidden-text-verdict').adopt(uuid, cdifDevice.spec, undefined, cdifDevice);
    this.deviceMap[uuid] = cdifDevice;
    // single-thread mode: this is the main thread (a worker's device is
    // registered from the main thread's spec, registerFromSpec)
    this.toolsetChanged();

    // This discovery's device is registered: discovery may end
    // (module-manager.js whenDiscovered).
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

// --- direct peer channels, worker side: lib/peer-worker.js (lean worker
// step 3), taken as DeviceManager's own methods for now ---
Object.assign(DeviceManager.prototype, require('./peer-worker').methods);

// The package.json the main thread pinned for a worker's module at its
// spawn, before any of the module's code ran (spawnModuleWorker,
// lib/manifest-pins.js), set on the proxy together with its host path; when
// the file could not be read, the worker's statement with no declarations;
// the worker's own statement only for a worker the main thread did not spawn
// from a host path.
function hostPackageInfo(wm, stated) {
  if (wm != null && wm.hostModulePath != null && wm.hostPackageInfo === undefined) {
    // a spawn path that set the host path without the pin: no declarations,
    // said once rather than taken from the worker
    if (wm.unpinnedLogged !== true) LOG.E(new Error(`module at ${wm.hostModulePath}: no package.json was pinned for it; no declarations are taken`));
    wm.unpinnedLogged = true;
  }
  return pinnedPackageInfo(wm, stated);
}
// hostPackageInfo's answer alone, with nothing logged: what a reader that
// only asks (packageOfModule, a listing) takes
function pinnedPackageInfo(wm, stated) {
  if (wm == null || wm.hostModulePath == null) return stated;
  if (wm.hostPackageInfo == null) return Object.assign({}, stated, {countinghouse: undefined});
  return wm.hostPackageInfo;
}

DeviceManager.hostPackageInfo = hostPackageInfo;
DeviceManager.pinnedPackageInfo = pinnedPackageInfo;
// a reloading record that keeps its device's spec: ModuleManager's one
// predicate (resolved on first use: the two files require each other)
let keptReloading = null;
const isKeptReloading = (e) => {
  if (keptReloading == null) keptReloading = require('./module-manager').isKeptReloading;
  return keptReloading(e);
};

// Whether a call is a resource's read (F3-4), by its device's spec as it is
// now: a worker's or an in-process device's, or the one its supervisor keeps
// while it restarts or is suspended. Its reads, by full service URN and
// action, are taken once per spec object and again when the tool generation
// moves (a spec changed in place: CHDevice.updateDeviceSpec).
const readSets = new WeakMap();
DeviceManager.prototype.isReadAction = function(deviceID, serviceURN, actionName) {
  const held = (this.deviceMap != null) ? this.deviceMap[deviceID] : null;
  let spec = held == null ? null : (held.deviceList != null && held.deviceList[deviceID] != null ? held.deviceList[deviceID] : held.spec);
  if (spec == null && this.moduleManager != null && this.moduleManager.supervisor != null) spec = this.moduleManager.supervisor.retainedSpecs()[deviceID];
  if (spec == null || typeof(spec) !== 'object') return false;
  const generation = require('./tool-generation').current();
  let kept = readSets.get(spec);
  if (kept == null || kept.generation !== generation) {
    const {actionsOf, isResourceRead} = require('./declarations');
    kept = {generation, reads: new Set(actionsOf(spec).filter((e) => isResourceRead(e.action)).map((e) => `${e.serviceID}\u0000${e.action.name}`))};
    readSets.set(spec, kept);
  }
  return kept.reads.has(`${serviceURN}\u0000${actionName}`);
};

// install deviceonline event handler after worker loaded the module
// This is run in main thread under multi-thread mode
// A worker's devices, registered from the main thread's own copy of its
// module's spec (lib/module-spec.js, read from the module's files before the
// worker started) once the worker has loaded the module's handlers (lean
// worker step 3, Task 4; ModuleManager's onModuleLoad). Nothing the worker
// states is taken: not its device, its spec, its module's name, its path or
// its package.json. Returns whether the device was registered.
DeviceManager.prototype.registerFromSpec = function(wm) {
  if (wm == null) return false;
  const own = wm.moduleSpec;
  const moduleName = wm.hostModuleName;
  const modulePath = wm.hostModulePath;

  // A worker being unloaded, already ended, or no longer its module's
  // current worker is going: nothing is registered for it, or it would undo
  // what its unload recorded (the device's ended entry).
  const mm = this.moduleManager;
  if (wm.unloading === true || wm.ended != null || (mm != null && mm.modules != null && mm.modules[moduleName] !== wm)) {
    LOG.I(`module: ${moduleName}: a worker that is going loaded; its device was not registered`);
    return false;
  }
  // A spec the main thread could not read registers nothing (logged at the
  // spawn, lib/module-manager.js).
  if (own == null || own.error != null || own.spec == null) return false;
  const deviceID = own.deviceID;
  const ownSpec  = own.spec;
  // The spec's own format was checked at the spawn, in a validator
  // (lib/module-spec.js deviceSpec): one that failed never got a worker.
  // The package.json the main thread pinned at the spawn, from the host path
  // it loaded the module from: its countinghouse.calls are the module's
  // declarations, which a module must not be able to write for itself (R2-1
  // Task 4's review). Without a pin, the module's name and no declarations.
  const packageInfo = hostPackageInfo(wm, {name: moduleName});

  // Device IDs by ownership (the review of #163, re-expressed here by the
  // high review of #177): a module may not register an ID another module
  // owns now or owned before; an ID no module has owned yet, it may not
  // register when another module's api.json declares it (pinned on the main
  // thread at its spawn, kept while it is unloaded or restarting). The owner
  // always may, so a squatter's own declaration, refused, never shuts the
  // owner out. Any other ID belongs to the first module that registers it.
  if (this.deviceOwners == null) this.deviceOwners = new Map();
  const owner = this.deviceOwners.get(deviceID);
  let other = null;
  if (owner != null) {
    if (owner !== moduleName) other = owner;
  } else if (mm != null && mm.pinnedDeviceIDs != null) {
    // (during the start's discovery a startup module's declaration comes
    // first against one pinned by a module later in the startup list, or
    // not on it at all (a load in place meanwhile): every startup module
    // pins its IDs at its spawn, several spawning at once, so the list's
    // order -- the earliest wins, as a one-at-a-time start gave -- is
    // decided here. A module before it still counts: an owner, or a load
    // that failed; a restart before discovery ends keeps its place.
    // C-startup-order, the high on #419)
    const earlier = (n) => typeof(mm.startupEarlier) === 'function' && mm.startupEarlier(moduleName, n);
    const declaredElsewhere = Object.keys(mm.pinnedDeviceIDs).find((n) => n !== moduleName && mm.pinnedDeviceIDs[n] instanceof Set && mm.pinnedDeviceIDs[n].has(deviceID) && !earlier(n));
    if (declaredElsewhere != null) other = declaredElsewhere;
  }
  if (other != null) {
    LOG.E(new CountinghouseError('DEVICE_OBJECT_CONFLICT',
      `module ${moduleName}'s device ${deviceID} is module ${other}'s -- refused; deviceID is derived from friendlyName, so two modules cannot share one. Rename one of them.`));
    return false;
  }
  // A device whose ended entry names another module that is reloading or
  // restarting is that module's to bring back (#153's review), and another
  // module's ended entry is never cleared here.
  const ended = (mm != null && typeof(mm.endedStateForDevice) === 'function') ? mm.endedStateForDevice(deviceID) : null;
  if (ended != null && ended.name !== moduleName && (ended.code === 'MODULE_RELOADING' || ended.code === 'MODULE_RESTARTING')) {
    LOG.E(new CountinghouseError('DEVICE_OBJECT_CONFLICT',
      `module ${moduleName}'s device ${deviceID} belongs to module ${ended.name} -- ` +
      'deviceID is derived from friendlyName, so two modules cannot share one. Rename one of them.'));
    return false;
  }

  const existingConflict = deviceIdConflict.conflictingModulePath(this.deviceMap[deviceID], modulePath);
  if (existingConflict != null) {
    LOG.E(new CountinghouseError('DEVICE_OBJECT_CONFLICT',
      `friendlyName "${ownSpec.device.friendlyName}" is already registered by ${
      existingConflict} -- deviceID ${deviceID} is derived from friendlyName, so two ` +
      'modules cannot share one. Rename one of them.'));
    return false;
  }

  if (!this.deviceOwners.has(deviceID)) this.deviceOwners.set(deviceID, moduleName);
  wm.moduleName  = moduleName;
  wm.packageInfo = packageInfo;
  wm.modulePath  = modulePath;
  wm.deviceList[deviceID] = ownSpec;
  // this spec serves now: its load's decision on hidden text is the one
  // every route takes (#400; never before, so a load refused on the way
  // leaves the serving version's decision as it was)
  require('./hidden-text-verdict').adopt(deviceID, ownSpec, Array.isArray(own.hiddenUnlisted) ? own.hiddenUnlisted : [], wm);
  wm.online = true; // to make ensureDeviceState happy
  // the workerMessage stands for its device: calls to it are sent to the worker
  this.deviceMap[deviceID] = wm;
  // only this module's own ended entry (another's was refused above)
  if (mm != null && typeof(mm.clearEndedDevice) === 'function' && (ended == null || ended.name === moduleName)) mm.clearEndedDevice(deviceID);
  this.toolsetChanged();

  if (this.allDevicesLoaded === false && this.notifyDeviceLoad[deviceID] != null) {
    for (const held of this.notifyDeviceLoad[deviceID]) {
      // see notifyDeviceLoad in queryDeviceForChild() below: the access check
      // a present device's query gets (the review of 5b), with the main
      // thread's own copy of the spec
      DeviceManager.prototype.replyAfterQueryAccessCheck.call(this, held.wm, held.msgID, deviceID, held.identity,
        () => held.wm.sendDeviceQueryReplyToChild({msgID: held.msgID, errMsg: null, spec: ownSpec}));
    }
    delete this.notifyDeviceLoad[deviceID];
  }
  return true;
};

DeviceManager.prototype.onWorkerLoaded = function(workerMessage) {
  if (workerMessage == null) return;
  // A task's progress (F4-3): {jobID: string | number, progress: finite
  // 0..100}, anything else dropped; for a job this worker runs, the latest of
  // each job's reaches the queue (a Redis read and write) at most every
  // PROGRESS_FLUSH_MS; for another, dropped, and logged at most once a
  // minute for the worker, with how many since
  workerMessage.on('jobprogress', (message, wm) => {
    const data = dataOf(message);
    const jobID = data.jobID;
    const progress = data.progress;
    if (!((typeof(jobID) === 'string' && jobID.length <= 256) || (typeof(jobID) === 'number' && Number.isFinite(jobID)))) return;
    if (!isProgress(progress)) return;
    if (!runsJob(wm, jobID)) {
      wm.progressRefused = (wm.progressRefused || 0) + 1;
      const now = Date.now();
      if (wm.progressRefusedLoggedAt == null || now - wm.progressRefusedLoggedAt >= PROGRESS_REFUSED_LOG_MS) {
        LOG.I(`job progress refused: job ${String(jobID).slice(0, 32)} is not running on this worker (${wm.progressRefused} refused since the last line)`);
        wm.progressRefusedLoggedAt = now;
        wm.progressRefused = 0;
      }
      return;
    }
    // held by run: the job and the run's token (two runs of one job on one
    // worker, a re-run while the timed-out one goes on, never mix)
    if (!(wm.progressPending instanceof Map)) wm.progressPending = new Map();
    // the token is the worker's word: taken only as a live call token of this
    // worker for this job; one named that is not (a run timed out, its token
    // dropped) is dropped with its progress, never the re-run's; with no token
    // at all, the progress is the job's (one key, as before)
    let token = null;
    if (typeof(data.token) === 'string') {
      token = liveRunToken(wm, jobID, data.token);
      if (token == null) return;
    }
    wm.progressPending.set(runKey(jobID, token), {jobID, progress});
    if (wm.progressFlush != null) return;
    wm.progressFlush = setTimeout(() => {
      wm.progressFlush = null;
      const pending = wm.progressPending;
      wm.progressPending = new Map();
      // (each was this worker's when it came; a run that ended meanwhile
      // took its own first: invokeJobs)
      for (const [key, p] of pending) progressWrite(wm, key, p);
    }, PROGRESS_FLUSH_MS);
    if (typeof(wm.progressFlush.unref) === 'function') wm.progressFlush.unref();
  });

  workerMessage.on('callprogress', (message, wm) => onCallProgress(message, wm));

  workerMessage.on('querydevice', (message, wm) => {
    const deviceID = message.deviceID;
    const msgID    = message.id;

    this.queryDeviceForChild(deviceID, msgID, wm, {token: message.token});
  });

  workerMessage.on('devicelog', (message, wm) => {
    const given     = dataOf(message);
    const deviceID  = given.deviceID;
    const data      = given.data;
    const timestamp = given.timestamp;
    const msgID     = message.id;

    // only under a device this worker hosts, as the main thread registered
    // it: a module does not write another module's log
    if (typeof(deviceID) !== 'string' || wm.deviceList == null || !Object.prototype.hasOwnProperty.call(wm.deviceList, deviceID)) {
      return wm.sendDeviceLogReplyToChild({msgID: msgID, errMsg: 'device log refused: not a device of this module'});
    }
    CHUtil.__deviceLogWithID(deviceID, data, timestamp, (e) => {
      if (e) return wm.sendDeviceLogReplyToChild({msgID: msgID, errMsg: e.message});
      return wm.sendDeviceLogReplyToChild({msgID: msgID, errMsg: null});
    });

  });

  workerMessage.on('rediscommand', (message, wm) => {
    const given  = dataOf(message);
    const opName = given.op;
    const data   = given.data;
    const msgID  = message.id;

    if (!redisAPI.isCommand(opName)) {
      return wm.sendRedisCommandReplyToChild({msgID: msgID, errMsg: `${String(opName).slice(0, 64)} is not a supported redis command`});
    }
    // #164: the module's own namespace, by the name main loaded it under
    // (hostModuleName), never one the worker states (lib/redis-namespace.js).
    // A throw here (a client fault) answers the worker, never the main
    // thread's event loop.
    try {
      // R1: a session worker's store is its session's partition
      const prefix = (typeof(wm.hostSession) === 'string') ? redisNamespace.sessionPrefixFor(wm.hostModuleName, wm.hostSession)
        : redisNamespace.prefixFor(wm.hostModuleName);
      if (prefix == null) return wm.sendRedisCommandReplyToChild({msgID: msgID, errMsg: 'no store namespace for this module'});
      redisNamespace.runNamespaced(redisAPI.client, prefix, opName, data, (e, result) => {
        if (e) return wm.sendRedisCommandReplyToChild({msgID: msgID, errMsg: e.message});
        return wm.sendRedisCommandReplyToChild({msgID: msgID, result: result, errMsg: null});
      });
    } catch (e) {
      wm.sendRedisCommandReplyToChild({msgID: msgID, errMsg: `${opName}: ${e.message}`});
    }
  });

  workerMessage.on('getjobinfo', (message, wm) => {
    const jobID = dataOf(message).jobID;
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
    const given      = dataOf(message);
    const deviceID   = given.deviceID;
    const serviceID  = given.serviceID;
    const actionName = given.actionName;
    const args       = given.args;
    // the call's token (R2-1 Task 3): what the hop is billed and checked by
    const token      = given.token;

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
// echo-device-client-module's x/API.js). Merging an extra field
// into it broke that pass-through's own output validation
// (Service.prototype.validateActionCall throws on an unrecognized key),
// which silently hung the call until the session's 30s timeout -- see
// lib/peer-channel.js's _dispatchInvoke for the same note on the
// --directPeerChannels path.
//here callerWM represents caller's workerMessage instance
// hold (a hop held for its callee's verdict, run again): {until} its one deadline, set at its first hold and kept through its passes;
// {final: true} its last pass, at that deadline: no hold, and a callee still undecided then is not ready
DeviceManager.prototype.sendInvokeActionMessageToWorker = function(appKey, billingKey, deviceID, serviceID, actionName, args, msgID, callerWM, token, waited, hold = null) {
  // the main thread's own refusal of this hop, answered and kept on its outer
  // call (said where that call fails); a callee's answer
  // relayed back (localCB below) is never one
  const refuse = (fields) => { callTokens.noteRefused(token, fields != null ? fields.errCode : null, 'module', callerWM.workerId); return callerWM.sendActionInvokeReplyToChild(fields); };
  // this device manager, for the call's module settings (sendCounted)
  const settingsDM = this;
  // R2-1 Task 3: the hop is billed by the call's token, which must be one
  // the main thread issued to the calling worker; an unknown, expired or
  // foreign token is refused before anything else, which tells the worker
  // nothing about the device. The hop authorizes as the token's identity
  // (the module's runsModules binding, R2-1 Task 5); nothing the worker
  // states is read.
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
    return refuse(Object.assign({msgID: msgID},
      CountinghouseError.replyFields(new CountinghouseError('CTX_CALL_NOT_READY', `${serviceID}/${actionName}`)), {data: null}));
  }
  if (!callTokens.declaredTarget(bindingOf(callerWM, tokenEntry.deviceID), deviceID, serviceID, actionName)) {
    return refuse(Object.assign({msgID: msgID},
      CountinghouseError.replyFields(new CountinghouseError('CTX_CALL_UNDECLARED', `${serviceID}/${actionName}`)), {data: null}));
  }

  //find out callee's workerMessage instance: none for a callee not listed
  // (its module going on or off, #413 section 5.5), which then takes the missing-device
  // path as one never hosted, its access check first. (A per-session
  // module's record counts as present: the worker the hop goes to is its
  // session's, picked after the access check, R1 Task 5.)
  // M4a (#413 section 7.3): a hop to a module being replaced in place waits
  // for its new version, as a client's call does (onInvokeDeviceAction):
  // only once its declared target and verdict are checked, so a caller
  // learns nothing it could not before (the medium review of #427's high
  // fixes, 4). Bounded by the hop's own call -- its token's life, ending a
  // little before it -- it then goes on as it arrives, its token still
  // valid (never CALL_TOKEN_INVALID: #427's high review, 6): a callee still
  // being replaced takes the missing-device path, which answers after the
  // access check, MODULE_RELOADING (missingDeviceErrorForHop).
  if (waited !== true && isMainThread === true && this.replacingInPlace(deviceID)) {
    const tokenUntil = Number.isFinite(tokenEntry.expires) ? tokenEntry.expires - HOP_WAIT_MARGIN_MS : Date.now() + Number(options.requestTimeout) + REPLACE_SPAWN_BOUND_MS;
    // (a hop held for its callee's verdict: no longer than its own deadline; its final pass, not at all)
    const until = (hold == null) ? tokenUntil : (hold.final === true) ? Date.now() : Math.min(tokenUntil, Number.isFinite(hold.until) ? hold.until : Infinity);
    return this.whileReplacing(deviceID, until, () => this.sendInvokeActionMessageToWorker(appKey, billingKey, deviceID, serviceID, actionName, args, msgID, callerWM, token, true, hold));
  }
  const listed = listsDevice(deviceID);
  const calleeWM = listed ? this.deviceMap[deviceID] : null;

  if (calleeWM == null) {
    // Why the device is missing (restarting, suspended, unloaded, never
    // hosted) is answered only after userAuth, as to a client: a caller
    // without access gets the access error whatever the reason, so it cannot
    // tell a device once hosted here from one never hosted.
    return userAuthLib()(null, null, deviceID, appKey, serviceID, actionName, () => {}, (err) => {
      if (err != null) {
        return refuse(Object.assign({msgID: msgID}, CountinghouseError.replyFields(err), {data: null}));
      }
      // every reason with its code, DEVICE_NOT_FOUND included (it used to
      // carry only the text 'device not found in map'); a callee the session
      // doesn't list has none of its states (restarting and the like)
      const answer = listed ? this.missingDeviceErrorForHop(deviceID) : notListed();
      return refuse(Object.assign({msgID: msgID}, CountinghouseError.replyFields(answer), {data: null}));
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
      // of failing fast (lib/lean-worker.js's 'invoke-action-reply' case has the
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

  const userAuth    = userAuthLib();
  // The hop may run; then, billed to its call's key, it runs only while that
  // charge can be recorded (the owner's decision, 11-27): asked after the
  // access check, so a tool the caller can't use answers as it always has.
  // (done's third argument: which check refused, 'auth' or 'charge')
  const authorizedAndChargeable = (done) => userAuth(null, null, deviceID, appKey, serviceID, actionName, localCB, (err, session) => {
    if (err) return done(err, null, 'auth');
    if (billingKey == null || CHUtil.ci == null || typeof(CHUtil.ci.chargeable) !== 'function') return done(null, session);
    return CHUtil.ci.chargeable(billingKey, (refusal) => (refusal != null ? done(refusal, null, 'charge') : done(null, session)));
  });

  authorizedAndChargeable((err, session, stage) => {
    // (the access check's refusal is noted as the runtime's refusal of the
    // call, as every hop refusal here; a charge that can't be recorded is
    // answered without a note, so no sentence says it)
    if (err) {
      const fields = Object.assign({msgID: msgID}, CountinghouseError.replyFields(err), {data: null});
      return (stage === 'auth') ? refuse(fields) : callerWM.sendActionInvokeReplyToChild(fields);
    }
    // (a hop's own session: a part of its caller's call, whose failure is the one logged; lib/session.js)
    session.hop = true;
    // A callee whose composition verdict is not decided yet (a composite calling a composite on a cold start, or into a callee
    // reloaded or loaded late): its binding is none, and a token issued from it would authorize the callee's own calls as no one for
    // the whole call. The hop waits for the callee's verdict, as an outer call does (a HeldCall on the callee, the same wait), only
    // once the caller's access check has let it through: a caller with no grant on the callee is refused at once above, the same
    // answer whether the callee is hosted and undecided or never hosted, so a wait tells no one a module exists. Bounded once, at its
    // first hold, by the 25 s rule and its caller's token life (a little before its end); every end runs it again from the start
    // (listed, auth, the binding read then), its bound as its final pass (no hold: what a fresh hop gets then, and a callee still
    // undecided, CTX_CALL_NOT_READY). A callee that no longer serves (ended, exited, unloading, closing) is not held for: the paths
    // below answer as for a fresh hop. Its caller's call gone (its token dropped): refused as a hop with a dropped token is. Never a
    // token from a binding not decided.
    // The callee as the map holds it once the access check has answered: a reload or a supervised restart during it replaced the one
    // read above, and a hop is held only on the copy that serves now (one no longer listed: the paths below answer it).
    // the hold, on target: until its first pass's deadline; at most HOP_HOLDS_PER_CALL held at once by the outer call (its chain's
    // first entry: a hop's own hops count with it), one more not ready now, as its final pass would answer it
    const holdOn = (target) => {
      const left = Number.isFinite(tokenEntry.expires) ? tokenEntry.expires - HOP_WAIT_MARGIN_MS - Date.now() : Infinity;
      const until = (hold != null && Number.isFinite(hold.until)) ? hold.until : Date.now() + Math.max(0, Math.min(verdictHoldMs(callLimits.of(tokenEntry)), left));
      // (each answer here is the main thread's own refusal of the hop: noted, as every one above)
      const reply = (e) => refuse(Object.assign({msgID: msgID}, CountinghouseError.replyFields(e), {data: null}));
      const holder = callTokens.outerOf(tokenEntry) || tokenEntry;
      if ((hopHolds.get(holder) || 0) >= HOP_HOLDS_PER_CALL) return reply(new CountinghouseError('CTX_CALL_NOT_READY', `${serviceID}/${actionName}`));
      // (a later pass waits out a replacement it meets, within the hop's deadline, whatever an earlier pass waited for)
      const again = (next) => this.sendInvokeActionMessageToWorker(null, null, deviceID, serviceID, actionName, args, msgID, callerWM, token, undefined, next);
      return new HeldCall(target, deviceID, Math.max(0, until - Date.now()), {
        rerun: true,
        heldBy: holder,
        live: () => callTokens.resolve(token, {workerId: callerWM.workerId}) != null,
        release: () => again({until: until}),
        // (its bound: the final pass; an answer handed to it, a throw's uniform one, as it is)
        answer: (e) => ((e != null) ? reply(e) : again({final: true})),
        callerEnded: () => reply(new CountinghouseError('CALL_TOKEN_INVALID', `${serviceID}/${actionName}`))
      }, this, until);
    };
    const calleeNow = listsDevice(deviceID) ? this.deviceMap[deviceID] : null;
    if (holdsHop(calleeNow, deviceID, hold)) return holdOn(calleeNow);
    // the hop is held to its caller's cap and timeout: its call's token
    // entry's override (lib/call-limits.js), or the global values read at
    // each check, and its call's session, main-side (lib/session.js Session.holdTo);
    // its timers take them now
    const override = tokenEntry.limits || null;
    sessionLib().holdTo(session, tokenEntry);
    const limits = callLimits.of(tokenEntry);

    // Step 3c, checked only once user-auth has let the hop through, so a
    // refusal says nothing about a device the caller may not use: a
    // usageCall is the calling worker's claim (lib/usage/hop.js). An owned
    // one grants the callee's worker for this hop; a finished one is removed;
    // anything else is USAGE_CALL_FOREIGN and nothing is sent.
    const claim = claimHop(usageRuntime.usage(), args, callerWM.workerId);
    if (claim.error != null) {
      return refuse(Object.assign({msgID: msgID}, CountinghouseError.replyFields(claim.error), {data: null}));
    }
    // The callee as it stands now: a reload or a supervised restart during
    // the auth round trip replaces it, and the hop (and its grant) must go to
    // the worker that will run it (the review of #90). Gone meanwhile: answered
    // as the missing-device path answers, after auth as there.
    // Whether it is listed is asked again too: its module may have begun to
    // go on or off meanwhile (#413 section 5.5); not listed, it is a device
    // never hosted.
    // R1 Task 5: a listed per-session module's worker is the one of the
    // session the hop's own token names (workerFor): never another
    // session's, and none for a session that has ended. Every hop into one
    // comes this way: none has a direct peer channel.
    const listedNow = listsDevice(deviceID);
    const pick = (cb) => (listedNow ? this.workerFor(deviceID, tokenEntry.session, cb, {hop: true}) : cb(null, null));
    return pick((hopErr, current) => {
    if (hopErr != null) {
      return refuse(Object.assign({msgID: msgID}, CountinghouseError.replyFields(hopErr), {data: null}));
    }
    if (current == null) {
      return refuse(Object.assign({msgID: msgID}, CountinghouseError.replyFields(listedNow ? this.missingDeviceErrorForHop(deviceID) : notListed()), {data: null}));
    }
    // The callee picked, its binding not decided (its final pass at its bound; a copy that replaced the one checked above; one that no
    // longer serves): never a token from it. One that no longer serves: the missing-device answer; a first pass, or a later one with
    // time left before its deadline: held on the copy picked, its deadline with it; at its deadline: not ready
    if (options.workerThread === true && isMainThread === true && !callTokens.hasVerdict(current, deviceID)) {
      if (!hopServes(current)) return refuse(Object.assign({msgID: msgID}, CountinghouseError.replyFields(this.missingDeviceErrorForHop(deviceID)), {data: null}));
      // (held on the copy picked, never run again at once: the next pass would pick it again, undecided, the map's entry decided)
      if (hold == null || hold.until === null || hopTimeLeft(hold)) return holdOn(current);
      return refuse(Object.assign({msgID: msgID}, CountinghouseError.replyFields(new CountinghouseError('CTX_CALL_NOT_READY', `${serviceID}/${actionName}`)), {data: null}));
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
      // (the hop goes ahead: a refusal of an earlier call of the caller's is not
      // why it may fail now; before the part's token, so its note may pass up)
      callTokens.noteThrough(token, callerWM.workerId);
      let child;
      try {
        child = callTokens.issue({billingKey: billingKey, identityKey: binding.identity, module: binding.module,
          workerId: current.workerId, deviceID: deviceID, parent: token, ttlMs: TOKEN_TTL_MS(override, tokenEntry.session), limits: override,
          // the action this hop is of: what the part may ask of the outer
          // call's user is what THIS action declares (ctx.ask over
          // composition, lib/module-ask.js; M14). The call's ask state
          // stays on the outer call's token.
          serviceID: serviceID, actionName: actionName});
      } catch (e) {   // the chain at its depth limit (HOP_CHAIN_TOO_DEEP)
        callTokens.noteRefused(token, e != null ? e.code : null, 'module', callerWM.workerId);
        return this.callback(e, null);
      }
      // Only what a hop carries, from the calling worker's args: its input
      // and its usage call (checked above); the token is the main thread's.
      // Anything else the worker put there -- a ctx of its own making, a job
      // id -- does not reach the callee (R2-1 Task 5).
      // The input crosses as the calling worker's bytes (lib/hop-input.js),
      // never deserialised here. Every worker of this runtime sends bytes, so
      // an input sent as a value is a worker tampered with: refused, never
      // cloned on to a validator and the callee, where the cap could not
      // reach it.
      const hopInput = hopInputLib();
      const inputBytes = hopInput.bytesOf(args);
      if (inputBytes == null && args != null && args.input !== undefined) {
        callTokens.drop(child);
        // (a worker tampered with: a crash's class, noted as no refusal)
        callTokens.noteRefused(token, 'DEVICE_INVOKE_EXCEPTION', 'module', callerWM.workerId);
        return this.callback(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a hop\'s input must cross as bytes'), null);
      }
      // The callee's ctx.caller: the identity the hop authorized as, {id,
      // isAdmin}, built here, never a key (R2-1 Task 5).
      const callerCtx = identityLib().callerOf(appKey);
      const hopArgs = (inputBytes != null) ? {inputBytes: inputBytes, token: child, ctx: callerCtx} : {token: child, ctx: callerCtx};
      const inputTooLarge = hopInput.sizeRefusal(inputBytes, {module: (typeof(current.moduleName) === 'string') ? current.moduleName : 'module', action: String(actionName), max: limits.maxOutputBytes});
      if (inputTooLarge != null) {
        callTokens.drop(child);
        callTokens.noteRefused(token, inputTooLarge.code, 'module', callerWM.workerId);
        return this.callback(inputTooLarge, null);
      }
      if (args != null && Number.isInteger(args.usageCall)) hopArgs.usageCall = args.usageCall;
      // send foreign action call message to callee; an owned usageCall is
      // granted to it until it answers (sendCounted). The child token ends
      // with the hop's session timer too.
      const answered = dropAfter(child, limits.requestTimeout);
      // Its reply crosses as bytes (lean worker step 2): this thread holds
      // them, has them checked in a validator and transfers them on to the
      // caller, never unpacking them. Its caller, for the validators'
      // per-caller rules, is the CALLING MODULE (the review of #165): its end
      // users' ids would let it spread its stalls.
      sendCounted(current, {deviceID: deviceID, serviceID: serviceID, actionName: actionName, args: hopArgs, relayBytes: true, caller: hopCallerOf(callerWM, billingKey), limits: override}, (err, data) => {
        answered();
        if (err) {
          const failure = CountinghouseError.fromReply(err);
          // only what main itself raised after the hop was sent (sendCounted's
          // own refusals: a validator's, the settings gate's, the output cap's)
          // is the caller's refusal; anything decoded from the callee worker's
          // reply (its own error, a crash, a code it passed on, a callee gone
          // mid-call) clears instead
          // (anything else was cleared when the hop went ahead, noteThrough above:
          // no second clear here, which would count as a move of the caller's
          // and keep the part's note from passing up)
          // (never after the hop's own timer fired: the caller was answered then and
          // has moved on; a late answer, timed by the callee's worker, is not its refusal)
          if (MAIN_RAISED.has(err) && !(timer != null && timer.expired === true)) callTokens.noteRefused(token, failure.code, 'module', callerWM.workerId);
          // (then the part's token goes: its own note passes up only if this call has none; call-tokens drop)
          callTokens.drop(child);
          return this.callback(failure, data);
        }
        callTokens.drop(child);

        if (CHUtil.ci == null) return this.callback(null, data);

        const tool = encodeLegacyTool(deviceID, serviceID, actionName);

        // An answer after the hop's session timer fired (the caller's
        // per-invoke timeout) reaches a caller that has failed the hop
        // already, and a failed hop costs 0 (the review of #138, 8): not
        // billed, on this path as on the peer path. The timer's own flag,
        // so the decision is the one the caller saw.
        if (timer != null && timer.expired === true) {
          LOG.I(`hop ${tool} not billed: it answered after the caller's timeout (${limits.requestTimeout} ms), so the caller had failed it`);
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
        // Checked here, before recordCall. A ledger that can't record a
        // charge refused the hop before it ran (chargeable(), after its
        // access check above); a charge that fails after it ran is logged as
        // lost and marks the ledger, so the next billed call is refused.
        // Unresolvable identity is a call that nobody can be charged for,
        // which is exactly what must not proceed.
        if (billingKey == null) {
          callTokens.noteRefused(token, 'HOP_IDENTITY_UNRESOLVED', 'module', callerWM.workerId);
          return this.callback(new CountinghouseError('HOP_IDENTITY_UNRESOLVED',
            `${serviceID}/${actionName}`), null);
        }

        // billingKey, not appKey: userAuth above already ran on appKey (may
        // this call happen), and this is the other question (who pays).
        // the outer call's progress (M9): this hop is a tick once billed
        const progress = callTokens.progressOf(tokenEntry.token);
        // charged once, its answer waited for at most METER_PENDING_MS, as
        // a peer hop's is (B-hopcharge): past it the hop answers with its
        // billing pending, and the charge's outcome is logged when it comes
        // (lib/metering/charge-bound.js). A tick only for a charge that
        // answered in time: a late one may follow the outer call's answer.
        return boundedCharge(CHUtil.ci, billingKey, tool, options.mcpToolCallCost, (meteringErr, meteringResult, pending) => {
          // (its code kept; the key, should the store's message repeat it, by its meterId)
          if (meteringErr) LOG.E(chargeLost(tool, billingKey, options.mcpToolCallCost, meteringErr));
          else if (!pending && progress != null) progress.tick();
          // the charge as a module may see it: no key (the review of #163)
          if (pending) return this.callback(null, data, {billingPending: true});
          return this.callback(null, data, (meteringErr == null) ? require('./metering/provider').forModule(meteringResult) : null);
        // (the session's deadline as it is when read: a tightening, Session.rearm, is kept)
        }, {what: 'hop', opts: {session: tokenEntry.session}, deadline: () => this.deadline});
      }, tokenEntry.session, this.deadline, settingsDM);
    }.bind(session));
    });
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

  // a grant naming a loaded module's pre-8.0 device ID, said once per
  // module (lib/pre-8-device-ids.js: removed after release 1). --debug with
  // an auth file still reads its grants (as composition does below): only
  // --debug with none has no grants to look at.
  if (isMainThread === true && !(options.debug === true && options.authConfigPath == null)) {
    let provider = null;
    try { provider = authModule.getAuthProvider(); } catch (e) { provider = null; }
    // each device's friendlyName: its spec on a worker's channel (deviceList),
    // or on the device itself in single-thread mode
    // (the modules loaded now, asked again by a reload of the auth config)
    const loadedNames = () => Object.entries(this.deviceMap).map(([id, d]) => {
      const spec = d == null ? null : (keepsDeviceList(d) ? (d.deviceList != null ? d.deviceList[id] : null) : d.spec);
      return (spec != null && spec.device != null) ? spec.device.friendlyName : null;
    });
    pre8DeviceIdsLib().warnPre8Grants(provider, loadedNames, (line) => LOG.W(line));
  }

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
        workerMessage.sendDeviceQueryReplyToChild({msgID: msgID, errMsg: new CountinghouseError('DEVICE_NOT_FOUND', deviceID).message, spec: null}, 'DEVICE_NOT_FOUND');
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
  // re-emits it on every subsequent module load/reload once the start's
  // discovery is over (moduleDiscovered), except for a load that is part of
  // a unit loaded in place, whose modules are verified in the unit's own
  // pass (verifyModules). this.deviceMap at
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
  if (isMainThread === true) this.verificationPass(null);
};

// A composition verification pass: every device (`only` null: at the start,
// and after each load that is not part of a unit), or the devices of the
// modules named in `only` (a unit loaded in place, once whole, and its
// callers outside it: verifyModules). A scoped pass is a re-verification; before the
// start's own pass has run it does nothing, since that pass verifies what
// there is then. A full pass leaves the devices of a unit still in progress
// (ModuleManager.prototype.isHeld) to that unit's own pass: verified before
// its part has registered, a scenario would fail, and its hop answer
// CTX_CALL_UNBOUND until the next pass (ch-local #81's acceptance). They
// are not counted in that pass, so READY_LINE still means every device it
// covers has its verdict.
// opts.outside (M4a, the reload's review item 2): the modules of a scoped
// pass that are outside the unit, its callers. Their re-verification is
// fail closed except for one failure: a target that is not loaded (and
// nothing else wrong) keeps the binding they hold, so their call to it
// answers DEVICE_NOT_FOUND, as after an unload (a gone module and a hidden
// one give one answer); any other failure (a grant revoked, an action gone
// or unresolved) clears it.
DeviceManager.prototype.verificationPass = function(only, opts = {}) {
  if (only == null || this._compositionStartupDone === true) {
    const isReVerification = this._compositionStartupDone === true;
    this._compositionStartupDone = true;
    const mm = this.moduleManager;
    const held = (name) => mm != null && typeof(mm.isHeld) === 'function' && mm.isHeld(name);
    // no unit in progress: no caller's targets to look up (#427's high review, 9)
    const anyHeld = mm != null && mm.units instanceof Set && mm.units.size > 0;
    // a device that calls a module a unit in progress holds (M4a, the
    // reload's review item 1): mid-switch its target is not there, so a
    // full pass that some other load triggered leaves it to the unit's own
    // pass, as it leaves the unit's own devices
    const callsHeld = (d) => {
      const ch = (d != null && d.packageInfo != null) ? d.packageInfo.countinghouse : null;
      const calls = (ch != null && Array.isArray(ch.calls)) ? ch.calls : [];
      return calls.some((a) => {
        const p = callAddress.parseAddress(a);
        if (p == null) return false;
        const target = this.moduleOfDevice(callAddress.deviceIDForName(p.device));
        return typeof(target) === 'string' && held(target);
      });
    };
    const inPass = (deviceID) => {
      const name = moduleNameOf(this.deviceMap[deviceID]);
      if (only != null) return only.has(name);
      return !held(name) && !(anyHeld && callsHeld(this.deviceMap[deviceID]));
    };
    const deviceIDs = Object.keys(this.deviceMap).filter(inPass);
    // a scoped pass with nothing in it (a unit rolled back) decides nothing,
    // and says nothing (READY_LINE)
    if (only != null && deviceIDs.length === 0) return;

    // READY_LINE is logged once every device below has had its verdict
    // delivered -- for a worker-hosted device that means the relay into its
    // worker has been acknowledged, not merely sent, because that
    // acknowledgement is what ends ctx.call's CTX_CALL_NOT_READY window.
    // "all module discovered" is logged before any of this starts, so it
    // cannot serve as the signal; anything that waits for the server
    // (test/helpers/wait-for-ready.js, the example verify scripts, an
    // operator's deploy script) waits for this line instead. It is logged
    // again after every later pass, like the pass itself.
    let verdictsPending = deviceIDs.length;
    // Test suite only (test/composition/19, test/stdio/36): the startup
    // pass's verdicts are delivered COUNTINGHOUSE_TEST_COMPOSITION_DELAY_MS
    // late, to every device or, with COUNTINGHOUSE_TEST_COMPOSITION_DELAY_MODULE,
    // to that package's only; with COUNTINGHOUSE_TEST_COMPOSITION_DELAY_LATER=1,
    // every later pass's too, a failed verdict as a bound one (so the hook
    // never reorders them). The pass itself, and everything it decides, runs
    // as it would. Honoured only under the suite's own marker, and it says so.
    const testDelayMs = (process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG === '1') ? Number(process.env.COUNTINGHOUSE_TEST_COMPOSITION_DELAY_MS) : NaN;
    const testDelayModule = process.env.COUNTINGHOUSE_TEST_COMPOSITION_DELAY_MODULE;
    const testDelayThisPass = testDelayMs > 0 && (isReVerification !== true || process.env.COUNTINGHOUSE_TEST_COMPOSITION_DELAY_LATER === '1');
    if (testDelayThisPass) LOG.I(`test hook: composition verdicts delivered ${testDelayMs} ms late${testDelayModule != null ? ` to ${testDelayModule}` : ''}`);
    const deliver = (packageInfo, fn) => {
      const name = (packageInfo != null) ? packageInfo.name : null;
      const held = testDelayThisPass && (testDelayModule == null || testDelayModule === name);
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
    let decisionsPending = (isReVerification === true) ? 0 : deviceIDs.length;
    const decided = () => {
      if (isReVerification === true) return;
      decisionsPending--;
      if (decisionsPending === 0) this.announceDiscovered();
    };
    if (isReVerification !== true && decisionsPending === 0) this.announceDiscovered();

    for (const deviceID of deviceIDs) {
      const cdifDevice = this.deviceMap[deviceID];
      const fromWorker = keepsDeviceList(cdifDevice);

      // Own spec/packageInfo/modulePath for this device: under
      // --workerThread, cdifDevice is the per-worker WorkerMessage proxy
      // (see onWorkerLoaded's 'deviceonline' handler above), which keeps
      // specs in .deviceList rather than a single .spec -- the same
      // fromWorker/.deviceList-vs-.spec distinction used elsewhere in this
      // file wherever a device's spec is resolved from either shape.
      const spec        = fromWorker ? cdifDevice.deviceList[deviceID] : cdifDevice.spec;
      const packageInfo = cdifDevice.packageInfo;
      const modulePath  = cdifDevice.modulePath;
      const moduleName  = moduleNameOf(cdifDevice);

      this.verifyComposition(deviceID, spec, packageInfo, modulePath, moduleName, (err, composition) => {
        if (err != null) {
          // A broken chain must not serve traffic through ctx.call -- log
          // (this is the primary way an author learns about it -- see
          // verifyComposition's own comment) either way.
          LOG.E(err);

          // a caller outside a unit whose only failure is a target not
          // loaded keeps what it holds (opts.outside, above)
          // (only one that holds a verdict keeps it: one never verified, a
          // caller a full pass skipped while the unit was held, gets its
          // verdict now, unbound: the medium review's finding 4)
          const holds = fromWorker && cdifDevice.bindings != null && cdifDevice.bindings[deviceID] != null;
          if (isReVerification === true && opts.outside != null && opts.outside.has(moduleName) && err.targetNotFound === true && holds) {
            verdictDelivered();
            return;
          }

          if (isReVerification === true) {
            // Never purge an already-online device (see comment above) --
            // only disable ctx.call for it by clearing any composition
            // binding it may still be holding from a prior successful
            // verification.
            if (fromWorker) {
              this.clearBinding(cdifDevice, deviceID);
              // one never verified before (a module loaded after the start) gets its verdict now, unbound: it serves its own actions,
              // and a call to it is not held for a verdict that would never come
              if (cdifDevice.bindings == null) cdifDevice.bindings = {};
              if (cdifDevice.bindings[deviceID] == null) cdifDevice.bindings[deviceID] = {identity: null, module: moduleName, targets: new Set()};
              deliver(packageInfo, () => this.relayComposition(cdifDevice, {deviceID: deviceID, identity: null, allowed: null},
                (relayErr) => {
                  if (relayErr != null) {
                    LOG.E(new CountinghouseError('MODULE_COMPOSITION_INVALID', deviceID,
                      `re-verification failed and clearing its composition inside its worker ` +
                      `thread also failed: ${relayErr.message}`));
                  }
                  verdictDelivered();
                  // the outer calls held for this verdict go on now, unbound: released on its delivery, never before it; a relay that
                  // failed delivered nothing, and they stay held to their bound
                  if (relayErr == null) heldVerdictDelivered(deviceID, cdifDevice);
                }));
            } else {
              deliver(packageInfo, () => {
                handlerCtx.setComposition(cdifDevice, null);
                verdictDelivered();
              });
            }
            return;
          }

          // First (startup) run: purge just this deviceID, not the whole
          // module, so a sibling device in the same module that composes
          // correctly is unaffected. Only the entry this pass verified: a
          // copy registered under the ID since keeps its entry.
          if (this.deviceMap[deviceID] === cdifDevice) delete this.deviceMap[deviceID];
          this.forgetDecision(deviceID, cdifDevice);
          if (fromWorker) delete cdifDevice.deviceList[deviceID];
          this.toolsetChanged();
          decided();
          // The outer calls held for its verdict: answered as a device not listed (on MCP, as any tool the caller can't use), never
          // sent; at the purge, each on a later turn, so neither a pending delivery nor their bound answers otherwise
          heldPurgedAtVerdict(deviceID, cdifDevice);
          // Its ctx.calls already waiting for a verdict are released,
          // unsettled, so they refuse CTX_CALL_NOT_READY now, not at the bound.
          deliver(packageInfo, () => {
            if (fromWorker) this.relayComposition(cdifDevice, {deviceID: deviceID, release: true}, () => verdictDelivered());
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
          deliver(packageInfo, () => this.relayComposition(cdifDevice, 
            {deviceID: deviceID, identity: (identity != null) ? callTokens.BOUND_IDENTITY : null, allowed: allowed},
            (relayErr) => {
              if (relayErr != null) {
                LOG.E(new CountinghouseError('MODULE_COMPOSITION_INVALID', deviceID,
                  `resolved composition successfully but failed to bind it inside its worker ` +
                  `thread: ${relayErr.message}`));
              }
              verdictDelivered();
              // the outer calls held for this verdict go on now, their tokens issued with this binding: released on its delivery,
              // so the worker has its composition when their handlers run; a relay that failed delivered nothing, and they stay held
              // to their bound
              if (relayErr == null) heldVerdictDelivered(deviceID, cdifDevice);
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

// A unit loaded in place, once whole: verified in one pass (verificationPass,
// scoped), the modules it added and every module outside it that declares a
// call to one of their devices (one loaded while its target was missing is
// bound now; one whose grant is gone is unbound: fail closed, as master's
// pass at each load did). Its loads opened no discovery window
// (ModuleManager's onModuleLoad: a held load emits no 'modulediscovering'),
// so there is none to end: allDevicesLoaded, and the queries waiting on
// another load's window, are that load's. Before the start's own pass has
// run, that pass verifies everything there is.
DeviceManager.prototype.verifyModules = function(names) {
  if (isMainThread !== true || names == null) return;
  const scope = new Set(names);
  const outside = new Set();
  // a caller of the unit, by the module its target belongs to: also one
  // whose target is out of the map (a unit rolled back), so a caller a full
  // pass skipped while the unit was held is never left without a verdict
  // (the medium review of M4a, finding 4)
  const targetsUnit = (deviceID) => {
    const m = this.moduleOfDevice(deviceID);
    return typeof(m) === 'string' && scope.has(m);
  };
  for (const id of Object.keys(this.deviceMap)) {
    const d = this.deviceMap[id];
    const ch = (d.packageInfo != null) ? d.packageInfo.countinghouse : null;
    const calls = (ch != null && Array.isArray(ch.calls)) ? ch.calls : [];
    if (calls.some((a) => { const p = callAddress.parseAddress(a); return p != null && targetsUnit(callAddress.deviceIDForName(p.device)); })) {
      const name = moduleNameOf(d);
      if (!scope.has(name)) outside.add(name);
      scope.add(name);
    }
  }
  this.verificationPass(scope, {outside});
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
        identity.conflicts.map((k) => require('./key-fingerprint').keyFingerprint(k)).join(', ')}. Exactly one must -- edit ${require('./auth/auth-file-defaults').authStoreName(options)} so only ` +
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
        `is fine as-is), but no auth identity in ${require('./auth/auth-file-defaults').authStoreName(options)} lists the module "${moduleName}" in ` +
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
    // a target not loaded is answered only once every other address has
    // checked out (M4a, the reload's review item 2): it then marks the
    // error targetNotFound, and a revoked grant or an action gone elsewhere
    // is never hidden behind it
    let notLoaded = null;

    const finish = (err) => {
      if (failed === true) return;
      if (err != null && err.targetNotFound === true) {
        if (notLoaded == null) notLoaded = err;
        err = null;
      }
      if (err != null) { failed = true; return callback(err); }
      pending--;
      if (pending > 0) return;
      if (notLoaded != null) { failed = true; return callback(notLoaded); }
      return callback(null, {identity: identity.apiKey, allowed: allowed, targets: targets, debugBound: identity.debug === true});
    };

    declared.forEach((address) => {
      const parsed = callAddress.parseAddress(address);
      if (parsed == null) {
        return finish(new CountinghouseError('MODULE_COMPOSITION_INVALID', friendlyName,
          `"${address}" in ${modulePath}/package.json's "countinghouse.calls" is not a valid ` +
          `address -- expected ${callAddress.ADDRESS_FORM}`));
      }

      const targetID = callAddress.deviceIDForName(parsed.device);

      // R1: a per-session module's record holds its spec, as a worker's
      // proxy does: declarations resolve against it (its calls are routed to
      // a session's worker at the hop); the device query itself stays the
      // dispatch's, which takes no record
      const viaRecord = (id, cb) => (isRecord(this.deviceMap[id]) ? cb(null, this.deviceMap[id]) : this.emit('querydevice', id, cb));
      viaRecord(targetID, (qErr, deviceOrSpec) => {
        if (qErr != null) {
          const notThere = new CountinghouseError('MODULE_COMPOSITION_INVALID', friendlyName,
            `declares "${address}" in ${modulePath}/package.json, but module "${
            parsed.device}" is not loaded`);
          Object.defineProperty(notThere, 'targetNotFound', {value: true, enumerable: false});
          return finish(notThere);
        }

        // this.emit('querydevice', ...) hands back whatever this.deviceMap
        // holds: a real CHDevice (single-thread mode, .spec) or a
        // per-worker WorkerMessage proxy (--workerThread, .deviceList
        // keyed by deviceID) -- same distinction as everywhere else in this
        // file that reads deviceMap directly (e.g. onGetDiscoveredDeviceList).
        const targetSpec = keepsDeviceList(deviceOrSpec)
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
                targetID} (module "${parsed.device}") to its "devices" in ${require('./auth/auth-file-defaults').authStoreName(options)}.`));
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
  require('./tool-generation').bump();
  if (isMainThread === true) this.emit('toolschanged');
};

// A composition verdict told to a device's worker (R2-1). A per-session
// module's record keeps it for every session worker spawned later, and tells
// each one running now (R1); `callback` once, with the first relay error.
DeviceManager.prototype.relayComposition = function(cdifDevice, message, callback) {
  if (!isRecord(cdifDevice)) return cdifDevice.sendSetCompositionMessage(message, callback);
  cdifDevice.verdicts[message.deviceID] = message;
  const mm = this.moduleManager;
  const workers = (mm != null && mm.sessionWorkers != null) ? mm.sessionWorkers.workersOf(cdifDevice.hostModuleName) : [];
  let left = workers.length;
  let first = null;
  if (left === 0) return callback(null);
  for (const {wm} of workers) {
    wm.sendSetCompositionMessage(message, (err) => {
      if (err != null && first == null) first = err;
      if (--left === 0) callback(first);
    });
  }
};

// R1 (#236 section 4a; plan D2): the worker a dispatch to `deviceID` goes
// to, for session `sessionId`. A shared module's entry answers with itself,
// synchronously. A per-session module's record answers with that session's
// own worker (lib/session-workers.js), spawned on its first call. With no
// session, a session no longer live, or a module closing, it answers as for
// a device not hosted (D2(a): fail closed, the same bytes as an unknown
// device; opts.hop: without its ID, as a hop's). Busy and suspended pass
// through. A worker that failed to start is logged and answered with a
// fixed text: its error can name the session and its partition's path, and
// a hop's error goes to the calling module, a job's into its history.
// workerFor's errors that reach a caller as they are: each a catalogued
// text that names no session and no path
// R1 Task 5: whether a session can still reach a per-session module (a live
// one); the one rule for workerFor and the device query alike
const sessionLive = (sessionId) => require('./sessions').live(sessionId);
const PASSED_THROUGH = new Set(['SESSION_WORKERS_BUSY', 'MODULE_SESSION_PAUSED']);
DeviceManager.prototype.workerFor = function(deviceID, sessionId, callback, opts) {
  const entry = this.deviceMap[deviceID];
  if (!isRecord(entry)) return callback(null, entry);
  const hop = opts != null && opts.hop === true;
  // no session that can reach it: exactly an unknown device
  const unknown = () => hop ? new CountinghouseError('DEVICE_NOT_FOUND') : new CountinghouseError('DEVICE_NOT_FOUND', deviceID);
  // its module going (an unload, a reload): what a worker's device says then
  const going = () => hop ? this.missingDeviceErrorForHop(deviceID) : this.missingDeviceError(deviceID);
  const mm = this.moduleManager;
  // no session at all: only a session's MCP calls reach a per-session
  // module, and nothing sessionless reaches here. REST is refused at its
  // routes (listing-scope restReaches), a sessionless MCP call in shared
  // mode at the gateway's start (handleToolsCall: sessionIdOf is undefined),
  // both before any limiter, and a job's run with no session in
  // invokeJobsNow, with the same one answer (#482's high, rounds 2 and 3).
  // Kept as the last guard.
  if (!hop && sessionId == null) return callback(new CountinghouseError('MODULE_NOT_LISTED'));
  if (!sessionLive(sessionId) || mm == null || mm.sessionWorkers == null) return callback(unknown());
  if (entry.closing === true) return callback(going());
  mm.sessionWorkers.get(entry.hostModuleName, sessionId, (err, wm) => {
    if (err == null) return callback(null, wm);
    // given up on for an unload or reload: as the device's ended state says;
    // or because the session ended meanwhile (a spawn given up on says
    // MODULE_UNLOADED too): then, as ever, a device not hosted
    if (err.code === 'MODULE_UNLOADED') return callback(sessionLive(sessionId) ? going() : unknown());
    // a session that ended meanwhile (the pool's refusal): exactly an unknown device
    if (err.code === 'DEVICE_NOT_FOUND') return callback(unknown());
    // busy, suspended: catalogued texts, as they are
    if (PASSED_THROUGH.has(err.code)) return callback(err);
    // anything else (a start that failed): the log has it, the caller a fixed text
    LOG.E(err);
    return callback(new CountinghouseError('SESSION_WORKER_NOT_STARTED'));
  });
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

// Whether a device's hidden-text decision (#400) stays when its old
// version's devices have settled: one in the map now, one the supervisor
// keeps listed (a restart), or one whose reloading record keeps its spec
// (ModuleManager markEndedDevices): a kept spec is listed
// by its decision too, so an action its text leaves unusable stays out
// through the switch (the Reviewer on #435).
DeviceManager.prototype.keepsDecision = function(deviceID) {
  if (Object.hasOwn(this.deviceMap, deviceID)) return true;
  const mm = this.moduleManager;
  const supervisor = mm != null ? mm.supervisor : null;
  if (supervisor != null && Object.hasOwn(supervisor.retainedSpecs(), deviceID)) return true;
  return isKeptReloading((mm != null && mm.endedDevices != null) ? mm.endedDevices[deviceID] : null);
};

// A purged device's hidden-text decision (#400) goes with it, unless it is
// coming back: restarting (its spec stays listed meanwhile, the supervisor's)
// or reloading (whose registration adopts the next). Only the owner's: a
// device registered under the ID since keeps its own.
DeviceManager.prototype.forgetDecision = function(deviceID, owner) {
  const ended = (this.moduleManager != null && this.moduleManager.endedDevices != null) ? this.moduleManager.endedDevices[deviceID] : null;
  if (ended != null && (ended.code === 'MODULE_RESTARTING' || ended.code === 'MODULE_RELOADING')) return;
  require('./hidden-text-verdict').forget(deviceID, owner);
};

// purge all device objects which are managed by the unloaded module
// under worker thread mode moduleInstance represents a workerMessage instance
DeviceManager.prototype.onPurgeDevice = function(moduleInstance, reason, callback) {
  if (options.workerThread === true && isMainThread === true) {
    for (const deviceID in this.deviceMap) {
      if (this.deviceMap[deviceID] === moduleInstance) {
        delete moduleInstance.deviceList[deviceID];
        delete this.deviceMap[deviceID];
        this.forgetDecision(deviceID, moduleInstance);
        this.toolsetChanged();

        // under worker-thread mode, in main thread we cannot get cdifDevice instance directly
        // which is available only in child thread , so we use __deviceLogWithID instead
        CHUtil.__deviceLogWithID(deviceID, reason, Date.now(), () =>{});
        // do not repeat the log in main thread
        // LOG.I('device purged: ' + deviceID);
      }
    }
    // the outer calls held on it for a verdict, and on its session workers if it is a record: answered now, unsent
    releaseHeldOn(moduleInstance);
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
        this.forgetDecision(deviceID, device);
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

    if (keepsDeviceList(cdifDevice)) {
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

    if (keepsDeviceList(cdifDevice)) {
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
  // and a reloading device's (ModuleManager markEndedDevices keeps its spec
  // in its record), per device: until that device ID registers again (its
  // record cleared) or the reload ends without it (settled, or rolled
  // back), whatever path reloads it -- an in-place switch, a load over a
  // loaded module, a restart, a reload of a restarting one. A tools/call to
  // it reaches the device manager, which answers MODULE_RELOADING,
  // retryable, never "unknown tool" (the high review of #435)
  const mm = this.moduleManager;
  const reloading = (mm != null && mm.endedIndex != null) ? mm.endedIndex.reloading : null;
  if (reloading != null) {
    for (const deviceID of reloading) {
      const e = mm.endedDevices[deviceID];
      if (isKeptReloading(e) && result[deviceID] == null) result[deviceID] = e.spec;
    }
  }
  return result;
};

// whether module `name` is spawning or loaded: in the module map, a live
// spawn (its lifecycle), a per-session worker of it (name\0sid), or under
// supervision (restarting, suspended), as uninstall's busy() counts them
function spawningOrLoaded(mm, name) {
  if (mm == null || name == null) return false;
  return (mm.modules != null && mm.modules[name] != null) ||
    (mm.lifecycle != null && typeof(mm.lifecycle.live) === 'function' && mm.lifecycle.live(name) != null) ||
    (mm.lifecycle != null && typeof(mm.lifecycle.liveUnder) === 'function' && mm.lifecycle.liveUnder(`${name}\0`) != null) ||
    (mm.supervisor != null && typeof(mm.supervisor.status) === 'function' && mm.supervisor.status(name) != null);
}

// The module a device is, in the map or out of it: the one answer every
// reader takes (the visibility set's listing, lib/route-manager.js; the registry's
// listingOf, F3-5), so they never disagree. In the map, its worker's host
// module (as registered, never what the worker states). Otherwise: the main
// thread's ended entry (its worker exited, reloading, unloaded: one map
// get), else the supervisor's record (a scan of its records), and, for a
// device out of the map only, the module that registered the ID
// (deviceOwners, kept for every ID once registered). An in-process device
// (no worker) is in the map under its own moduleName (moduleNameOf, the
// one rule; #490's high round 2, 6). An ID no
// module has registered yet: the module whose pinned api.json declares it,
// while that module is spawning or loaded (a live spawn, a record, a
// supervised restart); null otherwise (a spawn that failed leaves no answer).
DeviceManager.prototype.moduleOfDevice = function(deviceID) {
  const d = (this.deviceMap != null) ? this.deviceMap[deviceID] : null;
  const named = d != null ? moduleNameOf(d) : null;
  if (typeof(named) === 'string') return named;
  const mm = this.moduleManager;
  const ended = (mm != null && typeof(mm.endedStateForDevice) === 'function') ? mm.endedStateForDevice(deviceID) : null;
  if (ended != null && typeof(ended.name) === 'string') return ended.name;
  const sup = (mm != null && mm.supervisor != null && typeof(mm.supervisor.errorForDevice) === 'function') ? mm.supervisor.errorForDevice(deviceID) : null;
  if (sup != null && typeof(sup.module) === 'string') return sup.module;
  const owner = (d == null && this.deviceOwners instanceof Map) ? this.deviceOwners.get(deviceID) : null;
  if (typeof(owner) === 'string') return owner;
  // a device no module has registered yet (a module still spawning, its
  // first spawn included): the module whose pinned api.json declares it
  // (lib/module-manager.js pinnedDevicePackages, read at its spawn), only
  // while that module is spawning or loaded
  const pinned = (mm != null && mm.pinnedDevicePackages instanceof Map) ? mm.pinnedDevicePackages.get(deviceID) : undefined;
  return (typeof(pinned) === 'string' && spawningOrLoaded(mm, pinned)) ? pinned : null;
};

// The package.json a module's devices are listed by while out of the map
// (F3-5): the worker's own once its devices registered; else what
// registration would take from a worker of it that is up (its pin:
// hostPackageInfo, nothing logged); else, between a restart's spawn with no
// pin and its registration, or with no worker up, the one the supervisor
// kept at its last exit; else as registration would: the name alone.
// {live}: the pin only while the module is spawning or loaded (the settings
// gate: a stale pin never declares settings for it); a listing takes it
// whenever it is held (an ended module's role, as it ran).
DeviceManager.prototype.packageOfModule = function(name, {live = false} = {}) {
  const mm = this.moduleManager;
  const m = (mm != null && mm.modules != null) ? mm.modules[name] : null;
  if (m != null && m.packageInfo != null) return m.packageInfo;
  if (m != null && m.hostPackageInfo != null) return pinnedPackageInfo(m, {name: name});
  // reloading: its package.json as its devices' reloading records keep it,
  // before the pin and anything the supervisor kept from an earlier exit
  // (only while the module is out of the map: a new worker of it, pinned
  // or not yet, is never given the old version's declarations: the high
  // review of #435's medium round, 5 and 6)
  if (m == null && mm != null && mm.endedIndex != null) {
    for (const id of mm.endedIndex.byModule.get(name) || []) {
      const e = mm.endedDevices[id];
      if (isKeptReloading(e) && e.packageInfo != null) return e.packageInfo;
    }
  }
  // no live package.json (a module spawning, its first spawn, an ended
  // one): the one its manifest pin holds (lib/manifest-pins.js), the main
  // thread's copy read before any of its code ran; with {live}, only while
  // the module is spawning or loaded
  const pin = (mm != null && mm.manifestPins != null && typeof(mm.manifestPins.pinnedOf) === 'function' && (!live || spawningOrLoaded(mm, name))) ? mm.manifestPins.pinnedOf(name) : null;
  if (pin != null) return pin;
  // then what the supervisor kept at its last exit (the order agreed for
  // #430 and #435: live, the reloading record, the pin, the supervisor,
  // the name)
  const kept = (mm != null && mm.supervisor != null && typeof(mm.supervisor.packageInfoOf) === 'function') ? mm.supervisor.packageInfoOf(name) : null;
  if (kept != null) return kept;
  return m != null ? pinnedPackageInfo(m, {name: name}) : {name: name};
};

// A device missing from deviceMap may belong to a module whose worker exited
// and is restarting or suspended (lib/module-supervisor.js); say so instead
// of DEVICE_NOT_FOUND.
DeviceManager.prototype.missingDeviceError = function(deviceID) {
  // In a worker being unloaded (lib/lean-worker.js): its devices are going.
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

// A held call's answer at any end that does not send (HeldCall: 'bound', 'gone'), at that moment, as the fresh dispatch decides it:
//   not listed now (off, hidden, a scenario's part)               -> the uniform answer, as any tool the caller can't use
//   being replaced in place                                       -> null: not ready (a fresh call waits for it; the retry is served)
//   out of the map, or the very target it holds and that ended    -> the device's ended state: gone (not found, unloaded) the uniform
//                                                                    answer; restarting, or its supervisor's state, that code
//   a closing record (a per-session module's unload)              -> going(): what workerFor answers a fresh call then
//   its own target, listed, alive, no verdict delivered           -> null: not ready (the plain bound)
//   another copy listed, or its record's next session worker      -> null: not ready (served by something else after the retry)
// Nothing a fresh call would not tell.
DeviceManager.prototype.heldAnswerNow = function(deviceID, target = null) {
  const gone = (err) => (err.code === 'DEVICE_NOT_FOUND' || err.code === 'MODULE_UNLOADED') ? goneAtVerdict() : err;
  if (!this.listedNow(deviceID)) return goneAtVerdict();
  if (typeof(this.replacingInPlace) === 'function' && this.replacingInPlace(deviceID)) return null;
  const entry = (this.deviceMap != null) ? this.deviceMap[deviceID] : null;
  const targetEnded = target != null && (target.ended != null || target.exited === true);
  if (entry == null || (entry === target && targetEnded)) return gone(this.missingDeviceError(deviceID));
  if (isRecord(entry) && entry.closing === true) return this.missingDeviceError(deviceID);
  return null;
};

// Whether a call to the device may be sent now, as the fresh dispatch's listing checks say (invokeJobsNow's; the gateway's table is
// built from the same): listed (its module not going on or off) and not a part a scenario has taken in.
DeviceManager.prototype.listedNow = function(deviceID) {
  return listsDevice(deviceID) && !require('./mcp/tool-registry').pulledInPart({deviceManager: this}, deviceID);
};

// The same, to a composing worker's hop (the main-thread path here and the
// direct peer path, lib/peer-channel-broker.js): DEVICE_NOT_FOUND without
// the ID, which the composing module named itself (review of c10: one
// place, not a copy at each site).
// In shared mode an unloaded module is a device not found too (B3 Task 4):
// its pack's session set went with it, so MODULE_UNLOADED would tell a
// session that another's pack had been on.
DeviceManager.prototype.missingDeviceErrorForHop = function(deviceID) {
  // being replaced in place: retryable, the new version answers once up
  if (typeof(this.replacingInPlace) === 'function' && this.replacingInPlace(deviceID)) return new CountinghouseError('MODULE_RELOADING', deviceID);
  const missing = this.missingDeviceError(deviceID);
  if (missing.code === 'DEVICE_NOT_FOUND') return new CountinghouseError('DEVICE_NOT_FOUND');
  if (missing.code === 'MODULE_UNLOADED' && sessionsLib().shared() === true) return new CountinghouseError('DEVICE_NOT_FOUND');
  return missing;
};

// The device's spec or schema, which the main thread holds a copy of
// (lean worker step 3): a per-session module's record answers these as a
// worker's proxy does, with no worker (R1: listings don't move). Every
// dispatch goes through ensureDeviceState or workerFor instead.
DeviceManager.prototype.ensureListedDevice = function(deviceID, callback) {
  const entry = this.deviceMap[deviceID];
  if (isRecord(entry) && entry.online === true && entry.unloading !== true && options.workerThread === true && isMainThread === true) return callback(null, entry);
  return this.ensureDeviceState(deviceID, callback);
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

// A worker message's data, as an object: a null or non-object one (module
// code can send any) reads as empty, so a handler answers it, never throws
// into the uncaught log (F4-3)
function dataOf(message) {
  const data = (message != null) ? message.data : null;
  return (data != null && typeof(data) === 'object') ? data : {};
}

// At most this often a job's progress reaches the queue, and a refused one
// is logged, per worker (F4-3); and at most this long a run's end waits for
// its last progress to be written
const PROGRESS_FLUSH_MS = 250;
const PROGRESS_REFUSED_LOG_MS = 60 * 1000;
const RUN_PROGRESS_WAIT_MS = 2000;
const {isProgress} = require('./progress-value');

// a run's key: its job and its token (null for a run with no owner to bill)
const runKey = (jobID, token) => `${String(jobID)}|${typeof(token) === 'string' ? token : ''}`;
// the token a worker named, if it is a live call token of that worker for
// that job; else null
function liveRunToken(wm, jobID, token) {
  if (typeof(token) !== 'string' || token.length > 256) return null;
  const entry = callTokens.resolve(token, {workerId: wm.workerId});
  return (entry != null && entry.jobID != null && String(entry.jobID) === String(jobID)) ? token : null;
}

// one held progress written, tracked by run until it settles
function progressWrite(wm, key, p) {
  if (!(wm.progressWrites instanceof Map)) wm.progressWrites = new Map();
  const w = Promise.resolve().then(() => JobControl.updateJobProgress(p.jobID, p.progress)).catch(() => {});
  wm.progressWrites.set(key, w);
  w.then(() => { if (wm.progressWrites.get(key) === w) wm.progressWrites.delete(key); });
  return w;
}

// A run's end: its held progress written now, and that and any write of it
// already under way waited for, at most `ms`; or null when there is none
// (and the job's own key: progress a module posted with no token, through
// CHUtil.jobProgress, is the job's)
// progressTo(p): the run's own writer (its processor's Job: no read first),
// for the run's last value; else the job's queue (getJob, then a write)
function runProgressWritten(wm, key, ms, progressTo = null) {
  const waits = [];
  const jobKey = `${key.slice(0, key.lastIndexOf('|'))}|`;
  for (const k of (key === jobKey ? [key] : [key, jobKey])) {
    const inFlight = (wm.progressWrites instanceof Map) ? wm.progressWrites.get(k) : null;
    const held = (wm.progressPending instanceof Map) ? wm.progressPending.get(k) : null;
    if (held != null) wm.progressPending.delete(k);
    if (held != null && progressTo != null) {
      // after any write of it already under way (another connection: an
      // older value must not land after the last)
      waits.push(Promise.resolve(inFlight).then(() => progressTo(held.progress)).catch(() => {}));
    } else {
      if (inFlight != null) waits.push(inFlight);
      if (held != null) waits.push(progressWrite(wm, k, held));
    }
  }
  if (waits.length === 0) return null;
  let timer = null;
  const bound = new Promise((resolve) => { timer = setTimeout(resolve, ms); if (typeof(timer.unref) === 'function') timer.unref(); });
  return Promise.race([Promise.all(waits), bound]).then(() => clearTimeout(timer));
}

// The jobs each worker is running, so it can read and update those and no
// others (review R3-1). A worker-hosted device is its WorkerMessage here.
// Counted per run, not per job: a job failed by its timeout may be running
// again as a retry while the first run's handler is still going, and the
// first run's return must not take the retry's entry with it.
function runsJob(wm, jobID) {
  return wm != null && wm.jobsInFlight instanceof Map && wm.jobsInFlight.get(String(jobID)) > 0;
}

// What a worker gets of its job: not the queue's options (review R3-1). Its
// data never held the creator's key: a job names its owner by id
// (B-meter-keys (2)).
function forWorker(record) {
  if (record == null || record.job == null) return record;
  return Object.assign({}, record, {job: Object.assign({}, record.job, {data: Object.assign({}, record.job.data), opts: undefined})});
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
// (each call's own timeout: lib/call-limits.js)
const callLimits = require('./call-limits');
const TOKEN_TTL_MS = (limits, session = null) => callLimits.of({limits}, session).requestTimeout + 60000;
// The modules bound to the debug key, logged once each per process.
const debugBoundLogged = new Set();
const TOKEN_MARGIN_MS = 60000;
// Drops `token` once `afterMs` have passed (never, for null): the timer is
// cleared by the returned function when the call answers first.
function dropAfter(token, afterMs) {
  if (token == null || afterMs == null) return () => {};
  // a timeout's drop aborts the call's remote calls, as a cancel's does (M19)
  const timer = setTimeout(() => callTokens.drop(token, {abort: true}), Math.min(afterMs, 2147483647));
  timer.unref();
  return () => clearTimeout(timer);
}
const bindingOf = callTokens.bindingOf;
// An outer call to a device whose composition verdict has not been decided yet (a shared runtime lists a module while its parts still
// load): held on the main thread until it is, so its token is issued with the binding the verdict gives, never with none (a token
// authorizes as the module's binding when its call was issued). Bounded as ctx.call's own wait (lib/handler-ctx.js verdictWaitMs:
// 25 s, and 2 s inside the call's request timer); at the bound it answers CTX_CALL_NOT_READY (retryable), never sent.
// Each held call has one owner, a HeldCall, and one way out, its end(kind): the first end wins, later ones do nothing.
// Its ends, whatever their source:
//   'release'       its verdict delivered into the worker (heldVerdictDelivered, on an acknowledged relay; a binding decided but
//                   not yet relayed is not one), or its timer with the verdict delivered and the release still on its way
//   'bound'         its timer, no verdict delivered
//   'gone'          its module purged at its verdict, its target purged or unloaded, or its own worker exited (releaseHeldOn, by the
//                   identity of the target it holds, or of the record whose session worker that is); a verdict delivered on a copy
//                   that replaced the one it holds
//   'caller-ended'  its caller went (cancelled, answered at its deadline, a job given up on), seen by a poll or at any other end
// Every end drops the call from verdictHeldOn (a drain's count) and clears its timers. 'release' is the only one that sends, and only
// to a caller still live, to a device still listed (listedNow: a tightening during the hold applies to it as to a fresh call; else
// the uniform answer), and into the copy still serving it (servingNow; else heldAnswerNow). Every other end is answered with heldAnswerNow, what a fresh call to the tool gets at that moment. A
// caller that ended is never sent and never answered with the hold's answer (owner.callerEnded). Each end runs on its own turn,
// under its own try/LOG.E: a throw in one call's answer ends only that call.
// deviceID -> the HeldCalls waiting for its verdict.
const VERDICT_HOLD_MAX_MS = 25000;
const VERDICT_HOLD_MARGIN_MS = 2000;
const HELD_POLL_MS = 100;
const verdictHolds = new Map();
// device object -> how many calls are held on it: calls in flight for a drain (an in-place reload's, a session worker pool's), as a
// queued one is (verdictHeldOn)
const verdictHeld = new WeakMap();
// a device's bindings object -> the device IDs whose verdict has been delivered into its worker (a session's worker shares its record's
// bindings, so the record's delivery is its own: lib/module-manager.js sessionWorkerReady)
const verdictsDelivered = new WeakMap();
const verdictHoldMs = (limits) => {
  const t = Number(limits != null ? limits.requestTimeout : options.requestTimeout);
  return Math.max(0, Math.min(VERDICT_HOLD_MAX_MS, (Number.isFinite(t) ? t : 30000) - VERDICT_HOLD_MARGIN_MS));
};
const deliveredOn = (device, deviceID) => device != null && device.bindings != null && verdictsDelivered.has(device.bindings) &&
  verdictsDelivered.get(device.bindings).has(deviceID);
// Test suite only (composition 19): a held call says it was held and how it ended, so a case can tell a held call from one sent at
// once. Honoured only under the suite's own marker, with COUNTINGHOUSE_TEST_HELD_LOG=1.
const heldLogOn = () => process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG === '1' && process.env.COUNTINGHOUSE_TEST_HELD_LOG === '1';
// The most hops one call holds at once for their callees' verdicts: each holds a timer and a poll on the main thread, so a module's
// fan-out into an undecided callee is bounded per call (and calls by the rate limit). Counted by the outer call's token entry (a
// hop's own hops with it), never by the token itself; an entry gone takes its count with it.
const HOP_HOLDS_PER_CALL = 64;
const hopHolds = new WeakMap();
// owner: {live() -> boolean, release(), answer(err | null: not ready), callerEnded(), rerun?, heldBy?: the hop's caller's token entry,
// counted while held (HOP_HOLDS_PER_CALL)}; dm: the device manager, for an end's
// answer. An owner with rerun (a hop) is released on every end but its bound and runs again from the start, its own checks with it.
class HeldCall {
  constructor(target, deviceID, waitMs, owner, dm, deadline = null) {
    this.target = target;
    this.deviceID = deviceID;
    this.owner = owner;
    this.dm = dm;
    this.ended = null;
    verdictHeld.set(target, (verdictHeld.get(target) || 0) + 1);
    if (!verdictHolds.has(deviceID)) verdictHolds.set(deviceID, new Set());
    verdictHolds.get(deviceID).add(this);
    if (owner.heldBy != null) hopHolds.set(owner.heldBy, (hopHolds.get(owner.heldBy) || 0) + 1);
    this.endsAt = Number.isFinite(deadline) ? deadline : Date.now() + waitMs;   // (its deadline: DeviceManager.heldDeadlinesOn, for tests)
    this.timer = setTimeout(() => this.atBound(), waitMs);
    this.timer.unref();
    this.poll = setInterval(() => {
      let live = false;
      try { live = this.owner.live(); } catch (e) { LOG.E(e); return this.end('gone', true); }
      if (!live) return this.end('caller-ended');
      // (a hop, held on a binding not decided: released once it is, its delivery or not, as it was held)
      return (this.owner.rerun === true && callTokens.hasVerdict(this.target, this.deviceID)) ? this.end('release') : undefined;
    }, HELD_POLL_MS);
    this.poll.unref();
    if (heldLogOn()) LOG.I(`test hook: a call held for ${deviceID}'s verdict`);
  }

  // the one way out: idempotent. liveThrew: its caller check threw (in the poll, logged there): the uniform answer
  // its deadline: delivered by then, released; otherwise its bound (DeviceManager.atBoundOnForTests runs this, for tests)
  atBound() {
    return this.end(deliveredOn(this.target, this.deviceID) ? 'release' : 'bound');
  }
  end(kind, liveThrew = false) {
    if (this.ended != null) return;
    this.ended = kind;
    if (heldLogOn()) LOG.I(`test hook: a call held for ${this.deviceID}'s verdict ended: ${kind}`);
    clearTimeout(this.timer);
    clearInterval(this.poll);
    const left = (verdictHeld.get(this.target) || 1) - 1;
    if (left > 0) verdictHeld.set(this.target, left); else verdictHeld.delete(this.target);
    const holds = verdictHolds.get(this.deviceID);
    if (holds != null) { holds.delete(this); if (holds.size === 0) verdictHolds.delete(this.deviceID); }
    if (this.owner.heldBy != null) {
      const n = (hopHolds.get(this.owner.heldBy) || 1) - 1;
      if (n > 0) hopHolds.set(this.owner.heldBy, n); else hopHolds.delete(this.owner.heldBy);
    }
    // what to do, decided first: a throw while deciding (a caller check, a listing or serving check, the answer) is logged once and
    // answered with the uniform answer, so no end leaves its call unanswered; a throw in the owner's own act is logged, never answered
    // again
    let act = null;
    try {
      let threw = liveThrew;
      let live = true;
      if (!threw) { try { live = this.owner.live(); } catch (e) { LOG.E(e); threw = true; } }
      if (threw) act = () => this.owner.answer(goneAtVerdict());
      else if (kind === 'caller-ended' || !live) act = () => this.owner.callerEnded();
      // (an owner that runs again from the start, a hop: every check is its own then; only its bound answers here)
      else if (this.owner.rerun === true) {
        // (its next pass runs here: a throw in it is answered with the uniform answer, never left to its caller's timeout)
        const pass = (kind === 'bound') ? () => this.owner.answer(null) : () => this.owner.release();
        act = () => { try { return pass(); } catch (e) { LOG.E(e); return this.owner.answer(goneAtVerdict()); } };
      }
      else if (kind === 'release') {
        if (!listedNow(this.dm, this.deviceID)) act = () => this.owner.answer(goneAtVerdict());
        // only into the copy still serving the device: never one that ended (its exit in the release's own turn) or was replaced
        // since (a late acknowledgement of its relay); else answered as a fresh call is then
        else if (!servingNow(this.dm, this.deviceID, this.target)) { const a = answerNow(this.dm, this.deviceID, this.target); act = () => this.owner.answer(a); }
        else act = () => this.owner.release();
      } else { const a = answerNow(this.dm, this.deviceID, this.target); act = () => this.owner.answer(a); }
    } catch (e) {
      LOG.E(e);
      act = () => this.owner.answer(goneAtVerdict());
    }
    try {
      return act();
    } catch (e) {
      LOG.E(e);
      return undefined;
    }
  }
}
// what a held call is answered when its module was purged at its verdict: as a device not listed, marked (main thread only: a module's
// error crosses fromReply, which never carries the mark) for the gateway to answer as any tool the caller can't use
function goneAtVerdict() {
  const err = notListed();
  Object.defineProperty(err, 'goneAtVerdict', {value: true, enumerable: false});
  return err;
}
// (a device manager stub without these, in a unit test: listed, and not ready, with no map to say otherwise)
const answerNow = (dm, deviceID, target) => (dm != null && typeof(dm.heldAnswerNow) === 'function') ? dm.heldAnswerNow(deviceID, target) : null;
const listedNow = (dm, deviceID) => !(dm != null && typeof(dm.listedNow) === 'function') || dm.listedNow(deviceID);
// a held call's session ended meanwhile (a shared runtime's session closed): never sent, as a fresh call on it is not
const sessionEnded = (call) => typeof(call.sessionId) === 'string' && !sessionLive(call.sessionId);
// A held call whose caller went: never sent, never run. Counted against the caller's rate limit when it arrived; never billed, since
// nothing ran. Cancelled: answered as send() answers a call cancelled before it was sent (the gateway writes nothing, records it
// cancelled, and lets go of its in-flight hold). Its session ended: the ended answer, as the gateway answers a call on an ended
// session (MODULE_NOT_LISTED). At its deadline: its session's timer answers it (the timeout), nothing here.
const callerEndedOf = (call, serviceID, actionName) => {
  if (call.timer == null || call.timer.expired === true) return undefined;
  if (call.cancelled === true) return call.callback(new CountinghouseError('CALL_TOKEN_INVALID', `${serviceID}/${actionName}`), null);
  if (sessionEnded(call)) return call.callback(new CountinghouseError('MODULE_NOT_LISTED'), null);
  return undefined;
};
// a hop's callee that still serves (not ended, exited, unloading, nor a closing record): one that doesn't is not held for
const hopServes = (wm) => wm != null && wm.ended == null && wm.exited !== true && wm.unloading !== true && wm.closing !== true;
// a pass that is not its hop's final one and whose (finite) deadline has not passed
const hopTimeLeft = (hold) => hold != null && hold.final !== true && Number.isFinite(hold.until) && Date.now() < hold.until;
// whether a hop is held for its callee's verdict: a callee in the map that serves and has none decided, on any pass but its final one
// (a pass past its deadline is its final pass: never held again)
const holdsHop = (calleeWM, deviceID, hold) => calleeWM != null && options.workerThread === true && isMainThread === true &&
  (hold == null || hold.until === null || hopTimeLeft(hold)) && hopServes(calleeWM) && !callTokens.hasVerdict(calleeWM, deviceID);
// whether target still serves deviceID: not ended or exited, and the map's entry, or a session worker of the record that is the entry
// and is not closing (a stub with no map, in a unit test: serving)
// (unloading: an in-place reload's drain found it idle and posted its unload; a call sent now would answer MODULE_RELOADING behind it)
const servingNow = (dm, deviceID, target) => {
  if (target == null || target.ended != null || target.exited === true || target.unloading === true) return false;
  if (dm == null || dm.deviceMap == null) return true;
  const entry = dm.deviceMap[deviceID];
  return entry === target || (isRecord(entry) && entry.closing !== true && entry.bindings != null && entry.bindings === target.bindings);
};
// each end on its own turn and on its own (HeldCall.end's try/LOG.E): a source never waits on, nor is ended by, a held call's answer
const endSoon = (held, kind) => setImmediate(() => held.end(kind));
const heldFor = (deviceID) => Array.from(verdictHolds.get(deviceID) || []);
// whether `held` waits on `device`: that very object, or a session worker of that record (a record's session workers share its
// bindings); never a sibling worker, nor another copy
const heldOn = (held, device) => device != null && (held.target === device || (isRecord(device) && device.bindings != null && held.target.bindings === device.bindings));
const dmOf = (held) => held.dm;
// A verdict for deviceID delivered into `on`'s worker: its held calls on `on` (or on a session worker sharing its verdict) are released;
// one held on another copy is answered as a fresh call is now
function heldVerdictDelivered(deviceID, on) {
  if (on != null && on.bindings != null) {
    if (!verdictsDelivered.has(on.bindings)) verdictsDelivered.set(on.bindings, new Set());
    verdictsDelivered.get(on.bindings).add(deviceID);
  }
  heldFor(deviceID).forEach((held) => {
    if (deliveredOn(held.target, deviceID)) return endSoon(held, 'release');
    // (held on a copy that no longer serves the device, a reload having replaced it: answered as a fresh call is now; one held on the
    // serving copy, or on a session worker of the listed record, waits for its own verdict)
    if (!servingNow(dmOf(held), deviceID, held.target)) return endSoon(held, 'gone');
    return undefined;
  });
}
// deviceID purged at its verdict on `on`: the calls held on `on` (or on its record's session workers), answered as a fresh call is then
// (out of the map: the uniform answer; another copy listed since: not ready); a call held on another copy is not this verdict's
function heldPurgedAtVerdict(deviceID, on) {
  heldFor(deviceID).forEach((held) => { if (heldOn(held, on)) endSoon(held, 'gone'); });
}
// A device object ended (its purge or unload; its worker's exit): the calls held on that very object, and on the session workers of a
// record that ended, are answered as a fresh call is then. Never a call held on another object: a sibling session worker's exit is not
// this call's end.
function releaseHeldOn(device) {
  if (device == null) return;
  Array.from(verdictHolds.values()).forEach((holds) => Array.from(holds).forEach((held) => { if (heldOn(held, device)) endSoon(held, 'gone'); }));
}
// Step 3c: the main thread's check of a hop's usageCall.
const {claimHop} = require('./usage/hop');
const {SerializedResult, decode} = require('./serialized-result');
const usageRuntime = require('./usage/runtime');

// Step 3c (the review of #90): every send of a call to a worker goes through
// here, the gateway's (invokeAction), a task run's (invokeJobs) and a hop's
// (invokeforeignaction). A usageCall in the args is granted to the worker it
// is sent to for as long as that worker has not answered: released on its
// answer (which also comes, as a failure, when the worker ends), never on a
// session timer, since the worker may still be running under the open call.
// A finished call holds no grant either way.
//
// Every one is checked too (lean worker step 1(b)): its service, action and
// input's presence here (lib/module-spec.js), then its input in a validator
// worker (lib/validator-pool.js) before it is sent, so a bad input never
// reaches the module's worker, and its output there on the reply. No module
// code runs in a validator, and the main thread never runs a module's
// schema. A refusal is answered as a worker's reply would carry it, always on
// a later turn: never inside the caller's own try/catch, which would answer
// a second time if the answer threw. The module's worker is told
// (mainChecked) and skips its own validation.
// A hop's caller for the validators' per-caller rules: the calling module,
// by the name the main thread gave its worker at spawn (hostModuleName, R2-1
// 5a), never anything the worker announced. Without one, the call's own
// caller id.
function hopCallerOf(callerWM, billingKey) {
  const name = (callerWM != null && typeof(callerWM.hostModuleName) === 'string') ? callerWM.hostModuleName : null;
  return (name != null) ? `module:${name}` : callerIdOf(billingKey);
}

// The R2-1 caller id (u_...) of a key, for the validators' per-caller rules;
// never the key. null when it cannot be had.
function callerIdOf(key) {
  if (key == null) return null;
  try { return identityLib().idForKey(key); } catch (_) { return null; }
}

// message.caller: the R2-1 caller id the call is for (callerIdOf), or null;
// taken off the message here, never sent to the worker.
// A hop's reply comes as bytes (message.serializedReply, lean worker step 2,
// the reviewer's rulings of 2026-11-13): a SerializedResult this thread never
// unpacks. It is refused OUTPUT_TOO_LARGE from its length over
// --maxOutputBytes (the guarantee: the callee worker's own check is only the
// early answer, since a module can post through its worker's send path), then
// checked in a validator from its bytes and passed on as the bytes the
// validator gave back. Unchecked bytes never reach a caller.
// session: the call's client session (main-side, never in the message), so
// the reply cap is the tighter of the call's own and its session's now.
// deadline: when the call's caller stops waiting, in ms, as it stands at the
// send (its timer's, lib/session.js: the session's own timeout when it had
// tightened it by then, --requestTimeout being its ceiling; a job run's
// timeout), or null when it has none. Queued with the request
// (WorkerMessage sendMessageToWorker), so a call that never answers stops
// counting as its worker's work once that has passed (inFlight). A later
// rearm or a cancel doesn't reach it: the registered post-R1 follow-up (with
// the call token's dropAfter).
// dm: the device manager, for the module settings of the call's target and
// of the modules it can reach (lib/settings-gate.js).
// The errors main itself raised in answer to a sent call (sendCounted: a
// validator's, the settings gate's, the output cap's refusal), never one
// decoded from a worker's reply: only these are a caller's refusal to note
// (a hop's answer, below; the Fable read of #577).
const MAIN_RAISED = new WeakSet();
function sendCounted(target, message, callerCallback, session = null, deadline = null, dm = null) {
  // whether the caller has been answered: a throw that comes back out of a
  // send can be the caller's own callback's (a worker that has ended answers
  // synchronously), and is then never answered again (the review of #416)
  let answeredYet = false;
  const callback = (...a) => { answeredYet = true; return callerCallback(...a); };
  // (main's own refusal: tagged, then answered as any)
  const own = (...a) => { if (a[0] != null && typeof(a[0]) === 'object') MAIN_RAISED.add(a[0]); return callback(...a); };
  // the validators' per-caller key: in a shared runtime, the caller and its
  // session (lib/sessions.js validationCallerOf, B-valsess)
  const caller = (message != null && typeof(message.caller) === 'string') ? sessionsLib().validationCallerOf(message.caller, session) : null;
  // The call's own override, taken here before anything is sent: from the
  // message this thread built (the session's or the token entry's,
  // lib/call-limits.js), held in this closure. Nothing a worker sends back (a
  // reply, a hop request) is ever read for it: the worker's copy is for its
  // own early check only. The cap is read from it, or from the global value
  // as it is then, when the reply arrives (a live tightening applies).
  const override = (message != null && message.limits != null) ? message.limits : null;
  // relayBytes (a hop): the result is passed on as the checked bytes; any
  // other call's result (a client's, a job's) is unpacked here once checked
  const relayBytes = (message != null && message.relayBytes === true);
  if (message != null) { delete message.caller; delete message.relayBytes; }
  const args = message != null ? message.args : null;
  const checked = moduleSpec.checkInput(target.moduleSpec, message.deviceID, message.serviceID, message.actionName, args);
  if (checked != null && checked.refused != null) return setImmediate(() => own(...checked.refused));
  // Module settings (#413 section 4.5, 4.6): the target's state as this call
  // carries it (a task's pinned one, else its worker's), SETTING_REQUIRED
  // before the handler runs (unbilled: nothing is sent), over the whole
  // declared call graph for a client's or a job's call (`outer`), the target
  // alone for a hop; the values sent once per version per worker; the
  // handler's ctx.settingRequired checked when it answers.
  const outer = !relayBytes;
  const settingsState = (message != null && message.settingsState !== undefined) ? message.settingsState : settingsGate.stateOf(dm, target);
  // a job's: told when the call is sent with its settings (its task's pin)
  const settingsSentHook = (message != null && typeof(message.settingsSent) === 'function') ? message.settingsSent : null;
  if (message != null) { delete message.settingsState; delete message.settingsSent; }
  const settingsRefused = settingsGate.requiredRefusal(dm, message.deviceID, outer, settingsState);
  if (settingsRefused != null) return setImmediate(() => own(settingsRefused, null));
  const claimed = (e) => settingsGate.claimAnswer(e, dm, message.deviceID, settingsState, outer);
  const send = () => {
    // Every call whose spec is read here answers in bytes (lean worker step 2,
    // the review of #165): their length is the cap's guarantee. With no spec,
    // the reply is a value, checked in the module's worker as before.
    if (checked != null) { message.mainChecked = true; message.serializedReply = true; }
    else delete message.serializedReply;
    const call = (args != null && Number.isInteger(args.usageCall)) ? args.usageCall : null;
    const release = (call != null) ? usageRuntime.usage().grantCall(call, target.workerId) : () => {};
    // its module settings as this send carries them: the values once per
    // version per worker, noted as the worker's only once posted
    const settingsCarried = (args != null) ? settingsGate.toCarry(target, settingsState) : null;
    if (settingsCarried != null) args.settings = settingsCarried;
    const sendIt = (cb) => {
      let posted;
      try {
        posted = target.sendInvokeActionMessage(message, cb, deadline);
      } catch (e) {
        release();
        throw e;
      }
      // posted only to a live worker (WorkerMessage sendMessageToWorker
      // answers an ended or absent one without posting)
      if (target.ended == null && target.worker != null) {
        settingsGate.sent(target, settingsCarried);
        if (settingsSentHook != null) settingsSentHook(settingsState);
      }
      return posted;
    };
    return sendIt((err, data, ...rest) => {
      release();
      if (err == null && data instanceof SerializedResult) {
        // the call's own cap, now (main-side state only)
        const max = callLimits.of({limits: override}, session).maxOutputBytes;
        if (Number.isInteger(max) && data.bytes > max) {
          const moduleName = (typeof(target.moduleName) === 'string') ? target.moduleName : 'module';
          return own(CountinghouseError.withFields('OUTPUT_TOO_LARGE', {module: moduleName, action: String(message.actionName), bytes: data.bytes, max: max,
            raise: callLimits.raiseHint(data.bytes)}), null);
        }
        if (data.isError) {
          // a failed call: its error and payload, within the cap, unpacked here
          let payload;
          try { payload = decode(data.buffer); } catch (e) { return callback(e, null); }
          const fields = (payload != null && typeof(payload.fields) === 'object') ? payload.fields : null;
          // the module's own fields: read in a try, as anything it made
          let replyErr = null;
          try { replyErr = (fields != null) ? CountinghouseError.fromReplyFields(fields) : null; } catch (e) { replyErr = null; }
          if (replyErr == null) replyErr = CountinghouseError.runtimeReason('DEVICE_INVOKE_EXCEPTION', 'a module\'s error could not be read');
          return callback(claimed(replyErr), (payload != null) ? payload.data : null, ...rest);
        }
        return moduleSpec.validateSerialized(checked, 'output', data.buffer, caller).then((answer) => {
          if (answer.refused != null) return own(...answer.refused);
          if (relayBytes) return callback(null, new SerializedResult(answer.buffer), ...rest);
          // a client's or a job's result: unpacked here, once checked
          let value;
          try { value = decode(answer.buffer); } catch (e) { return callback(e, null); }
          return callback(null, value, ...rest);
        }).catch((e) => LOG.E(e));   // a throw in the reply's own handling: logged, never an unhandled rejection
      }
      if (err != null || checked == null) return callback(claimed(err), data, ...rest);
      moduleSpec.validate(checked, 'output', data, caller).then((refused) => {
        if (refused != null) return own(...refused);
        return callback(err, data, ...rest);
      });
    });
  };
  if (checked == null) return send();
  // a hop's input as bytes: checked in a validator and handed back,
  // transferred both ways; the checked bytes are what the callee gets
  const inputBytes = hopInputLib().bytesOf(args);
  if (inputBytes != null) {
    // Answered once, outside the promise chain: a throw from the callback
    // is never caught here and answered again (the review of #185).
    return moduleSpec.validateSerialized(checked, 'input', inputBytes, caller).then((answer) => ({answer}), (e) => ({error: e}))
      .then(({answer, error}) => process.nextTick(() => {
        if (error != null) {
          LOG.E(error);
          return callback(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a hop\'s input could not be checked'), null);
        }
        if (answer.refused != null) return own(...answer.refused);
        // a pass hands the checked bytes back; anything else fails closed,
        // never a hop sent on with no input as main-checked
        if (!(answer.buffer instanceof ArrayBuffer)) return callback(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a hop\'s input could not be checked'), null);
        args.inputBytes = answer.buffer;
        let sent = false;
        try {
          send();
          sent = true;
        } catch (e) {
          // a post that failed: the hop is answered, never left to its
          // timeout (send released what it granted, and its reply was
          // never queued)
          LOG.E(e);
        }
        if (!sent && !answeredYet) return callback(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the hop could not be sent to its module'), null);
        return undefined;
      }));
  }
  moduleSpec.validate(checked, 'input', args, caller).then((refused) => {
    if (refused != null) return own(...refused);
    // a post that throws here (a value that can't be cloned) is answered,
    // never an unhandled rejection: its reply was never queued (send
    // released what it granted), so nothing else would ever answer it, and
    // a task run's token would hold its worker's slot (the review of #416)
    let sent = false;
    try {
      send();
      sent = true;
    } catch (e) {
      LOG.E(e);
    }
    if (!sent && !answeredYet) return callback(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the call could not be sent to its module'), null);
    return undefined;
  }, (e) => {
    // the check itself failed (a validator pool's): answered, never left
    // unanswered with a task run's token held
    LOG.E(e);
    if (!answeredYet) callback(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the call\'s input could not be checked'), null);
  }).catch((e) => LOG.E(e));   // a throw in the caller's own answer: logged, never answered twice
}


// For the gateway (a task's creation, held as a call is): cb(decided, err). decided: 'landed' (create it), 'bound' (not ready),
// 'purged' (err the uniform answer: as any tool the caller can't use), 'caller-ended' (live() went false: the gateway's own checks
// answer it). 'landed' at once for a device with its verdict, one not found (the caller's own paths answer it), or outside worker mode
// (no token is issued there); and at an end whose answer is not gone (a module restarting): created, as a fresh creation is, its run
// waiting for the module as any run does.
DeviceManager.prototype.untilVerdict = function(deviceID, limits, cb, live = () => true) {
  const device = (this.deviceMap != null) ? this.deviceMap[deviceID] : null;
  if (device == null || !(options.workerThread === true && isMainThread === true) || callTokens.hasVerdict(device, deviceID)) return cb('landed');
  return new HeldCall(device, deviceID, verdictHoldMs(limits), {
    live: live,
    // (held: the third argument says so, and the gateway checks its caller's grant again, as a fresh creation's is checked)
    release: () => cb('landed', undefined, true),
    answer: (err) => ((err == null) ? cb('bound') : (err.goneAtVerdict === true) ? cb('purged', err) : cb('landed', undefined, true)),
    callerEnded: () => cb('caller-ended')
  }, this);
};

// cancelled (optional): the job processor's, true once it has given up on this run (invokeJobsNow asks it before; a run held for its
// verdict asks it again at its end, and nothing starts for it then)
DeviceManager.prototype.invokeJobs = function(cdifDevice, deviceID, serviceID, actionName, input, jobID, callback, extraArgs, cancelled = null) {
  // this device manager, for the call's module settings (sendCounted)
  const settingsDM = this;
  // the run's own clock: its timeout counts from here, before any hold for its module's verdict
  const runStartedAt = Date.now();
  try {
    if (options.workerThread === true && isMainThread === true) {
      const run = () => {
        if (!(cdifDevice.jobsInFlight instanceof Map)) cdifDevice.jobsInFlight = new Map();
        const key = String(jobID);
        cdifDevice.jobsInFlight.set(key, (cdifDevice.jobsInFlight.get(key) || 0) + 1);
        // Step 3c: a task run's call is owned by the worker it is sent to, until
        // that worker answers (sendCounted). Its token (R2-1 Task 3) bills the
        // job's owner (extraArgs.ownerKey, from job-control; never sent on).
        const args = jobArgs(input, jobID, extraArgs);
        const ownerKey = (extraArgs != null) ? extraArgs.ownerKey : null;
        const fullMs = (extraArgs != null && Number.isFinite(extraArgs.timeoutMs) && extraArgs.timeoutMs > 0) ? extraArgs.timeoutMs : null;
        // what its timeout leaves now (a held run's clock ran while it was held)
        const timeoutMs = (fullMs != null) ? Math.max(0, runStartedAt + fullMs - Date.now()) : null;
        const runSession = (extraArgs != null && typeof(extraArgs.session) === 'string') ? extraArgs.session : null;
        const runLimits = (extraArgs != null) ? callLimits.check(extraArgs.limits) : null;
        const binding = bindingOf(cdifDevice, deviceID);
        const token = (ownerKey != null) ? callTokens.issue({billingKey: ownerKey, identityKey: binding.identity, module: binding.module,
          workerId: cdifDevice.workerId, deviceID: deviceID, jobID: jobID, ttlMs: (timeoutMs != null) ? timeoutMs + TOKEN_MARGIN_MS : Infinity,
          // the job's session and this run's values (B1 Task 3: the runner's
          // bookkeeping, from lib/job-sessions.js, never the worker's)
          session: runSession, limits: runLimits,
          // a 2026-07-28 task's ask state (M22, lib/task-asks.js forRun, the
          // runner's): the action asks as a call's does, and its question is
          // held for the task. Never sent: job-args copies none of it.
          serviceID: serviceID, actionName: actionName, ask: (extraArgs != null && extraArgs.ask != null) ? extraArgs.ask : null}) : null;
        if (token != null) args.token = token;
        // the task's caller as its handler's ctx shows it: the owner's {id,
        // isAdmin}, built here, never the key (R2-1 Task 5)
        if (ownerKey != null) args.ctx = identityLib().callerOf(ownerKey);
        const answered = dropAfter(token, timeoutMs);
        // the run's token and its count, given back once, whichever way it ends
        // (an answer, or a send that threw: the review of #416)
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          answered();
          if (token != null) callTokens.drop(token);
          const left = (cdifDevice.jobsInFlight.get(key) || 1) - 1;
          if (left > 0) cdifDevice.jobsInFlight.set(key, left); else cdifDevice.jobsInFlight.delete(key);
        };
        try {
          // a task's settings: those its first pass was sent with, for its
          // life (lib/settings-gate.js forTask, pinned once a pass is sent)
          const settingsState = settingsGate.forTask(jobID, settingsGate.stateOf(settingsDM, cdifDevice));
          sendCounted(cdifDevice, {deviceID: deviceID, serviceID: serviceID, actionName: actionName, args: args, caller: callerIdOf(ownerKey), limits: runLimits,
            settingsState: settingsState, settingsSent: (st) => settingsGate.pin(jobID, st)}, (err, result) => {
            // (the run's last module call, if the runtime refused it: read before its token goes)
            const refused = (token != null) ? callTokens.refusedOf(token) : null;
            settle();
            const failure = err ? CountinghouseError.withRefusal(CountinghouseError.fromReply(err), refused) : null;
            if (failure != null) {
              // a task run's failure, logged as a call's is (lib/failed-call-log.js)
              try {
                const tool = failedCallLogLib().toolOf(cdifDevice, actionName, deviceID);
                if (tool != null) failedCallLogLib().runtimeLog().failed(tool, {code: failure.code, origin: failure.origin, fromHandler: CountinghouseError.fromHandlerOf(failure)}, failure.refusedBefore);
              } catch (e) { /* never in the run's way */ }
            }
            const finish = () => (failure != null ? callback(failure, result) : callback(null, result));
            // its last progress, held for the next flush or being written (F4-3),
            // is written before the run's answer completes the job, as it was
            // before; bounded, so a stalled store never holds the completion. The
            // callback runs as on the plain path: on its own turn, a throw its own.
            const progressTo = (extraArgs != null && typeof(extraArgs.progressTo) === 'function') ? extraArgs.progressTo : null;
            const written = runProgressWritten(cdifDevice, runKey(jobID, token), RUN_PROGRESS_WAIT_MS, progressTo);
            if (written == null) return finish();
            return written.then(() => process.nextTick(finish));
          }, runSession, (fullMs != null) ? runStartedAt + fullMs : null, settingsDM);
        } catch (e) {
          // the run was answered already: the throw is its own callback's, and
          // it is never answered again
          if (settled) {
            LOG.E(e);
            return undefined;
          }
          // a send that threw (a run's input that can't be cloned): its reply
          // was never queued, so it is answered here, once
          settle();
          const unsent = new CountinghouseError('DEVICE_ACTION_CALL_FAIL', e.message);
          try {
            const tool = failedCallLogLib().toolOf(cdifDevice, actionName, deviceID);
            if (tool != null) failedCallLogLib().runtimeLog().failed(tool, {code: unsent.code, origin: unsent.origin, fromHandler: false}, null);
          } catch (logErr) { /* never in the run's way */ }
          return callback(unsent, null);
        }
      };
      // A run of a module whose composition verdict is not decided yet (a task created, or resumed at a start,
      // before it) waits for it as a call does, so its token never authorizes as no one; bounded by the call's rule and the run's own timeout
      const holdOwner = (extraArgs != null) ? extraArgs.ownerKey : null;
      if (holdOwner != null && !callTokens.hasVerdict(cdifDevice, deviceID)) {
        const runTimeout = (extraArgs != null && Number.isFinite(extraArgs.timeoutMs) && extraArgs.timeoutMs > 0) ? extraArgs.timeoutMs : null;
        // (its session's limits as they are now, as a call's: callLimits.of; a tightening shortens the hold. Its own override read as
        // run() reads it, callLimits.check: a malformed one is none, the defaults, never a throw)
        const runHolder = {limits: (extraArgs != null) ? callLimits.check(extraArgs.limits) : null, sessionId: runSessionOf(extraArgs)};
        const holdMs = Math.min(verdictHoldMs(callLimits.of(runHolder)), (runTimeout != null) ? Math.max(0, runTimeout - VERDICT_HOLD_MARGIN_MS) : Infinity);
        return new HeldCall(cdifDevice, deviceID, holdMs, {
          live: () => !(typeof(cancelled) === 'function' && cancelled()),
          release: () => {
            try { return run(); } catch (e) {
              const unsent = new CountinghouseError('DEVICE_ACTION_CALL_FAIL', e.message);
              try {
                const tool = failedCallLogLib().toolOf(cdifDevice, actionName, deviceID);
                if (tool != null) failedCallLogLib().runtimeLog().failed(tool, {code: unsent.code, origin: unsent.origin, fromHandler: false}, null);
              } catch (logErr) { /* never in the run's way */ }
              return callback(unsent, null);
            }
          },
          // (a gone answer tagged as invokeJobsNow tags its own: after the discovery, in a shared runtime, it fails for good)
          answer: (err) => {
            const out = (err != null) ? ((typeof(this.discoveredTag) === 'function') ? this.discoveredTag(err) : err) : new CountinghouseError('CTX_CALL_NOT_READY', `${serviceID}/${actionName}`);
            // (a held run answered at its bound or gone: logged as a held call's answer is)
            try { const tool = failedCallLogLib().toolOf(cdifDevice, actionName, deviceID); if (tool != null) failedCallLogLib().runtimeLog().failed(tool, {code: out.code, origin: out.origin, fromHandler: false}, null); } catch (logErr) { /* never in the run's way */ }
            return callback(out, null);
          },
          // given up on: nothing starts and nothing is answered, as invokeJobsNow's own check does
          callerEnded: () => undefined
        }, this);
      }
      return run();
    } else {
      return callback(new CountinghouseError('DEVICE_ACTION_CALL_FAIL', 'job cannot be processed in non-worker mode, please restart server in multi-thread mode. this job will fail.'));
    }
  } catch (e) {
    return callback(new CountinghouseError('DEVICE_ACTION_CALL_FAIL', e.message), null);
  }
};

DeviceManager.prototype.invokeAction = function(cdifDevice, deviceID, serviceID, actionName, args, session) {
  // this device manager, for the call's module settings (sendCounted)
  const settingsDM = this;
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
          // the call's own override of the cap and timeout, or null (the
          // global values, read at each check: lib/call-limits.js), on its
          // token for every hop it makes, and with the call to its worker
          const override = this.limits || null;
          const limits = callLimits.of(this);
          const send = () => {
            // a call cancelled before it was sent (M19, lib/mcp/gateway.js):
            // never sent; its token never issued
            if (this.cancelled === true) return this.callback(new CountinghouseError('CALL_TOKEN_INVALID', `${serviceID}/${actionName}`), null);
            // the module's binding now: after a held call's verdict, the one it gave
            const binding = bindingOf(device, deviceID);
            const token = (this.appKey != null) ? callTokens.issue({billingKey: this.appKey, identityKey: binding.identity, module: binding.module,
              workerId: device.workerId, deviceID: deviceID, ttlMs: TOKEN_TTL_MS(override, this.sessionId), limits: override,
              session: this.sessionId || null, progress: this.progress || null,
              // the action the call is of and its ask state (ctx.ask,
              // lib/module-ask.js; the gateway makes the state)
              serviceID: serviceID, actionName: actionName, ask: this.ask || null}) : null;
            // wantsProgress (M21): the client asked for progress, so the
            // handler's own reports are worth posting (lib/handler-ctx.js)
            const callArgs = (token != null) ? Object.assign({}, args, (this.progress != null) ? {token: token, wantsProgress: true} : {token: token}) : args;
            // kept on the call's session, so a cancel can drop it (M19)
            this.callToken = token;
            // dropped at the session's timeout too (lib/session.js's timer is
            // the call's own): the call has failed by then
            // dropped at the caller's own deadline (its clock started before any hold for its verdict): its hops never run or bill
            // past the moment its caller was answered
            const answered = dropAfter(token, Number.isFinite(this.deadline) ? Math.max(0, this.deadline - Date.now()) : limits.requestTimeout);
            let ran = false;
            try {
              sendCounted(device, {deviceID: deviceID, serviceID: serviceID, actionName: actionName, args: callArgs, caller: callerIdOf(this.appKey), limits: override}, (err, data) => {
                ran = true;
                answered();
                // (the runtime's own refusal of one of its module calls, read before the token goes: said where it failed)
                const refused = (token != null) ? callTokens.refusedOf(token) : null;
                if (token != null) callTokens.drop(token);
                if (err) return this.callback(CountinghouseError.withRefusal(CountinghouseError.fromReply(err), refused), data);
                return this.callback(null, data);
              }, this.sessionId, this.deadline, settingsDM);
            } catch (e) {
              // a send that threw before any answer: its token goes now, never
              // left live to its timeout holding the worker (the review of
              // #416); answered by the catch below
              if (!ran) {
                answered();
                if (token != null) callTokens.drop(token);
                this.callToken = null;
              }
              throw e;
            }
          };
          // A call to a device whose composition verdict is not decided yet waits for it here, after the
          // caller's access checks and its count against the rate limit (both before this send), so a token never authorizes as no one
          if (this.appKey != null && !callTokens.hasVerdict(device, deviceID)) {
            const call = this;
            return new HeldCall(device, deviceID, verdictHoldMs(limits), {
              // live: not cancelled, and not answered at its deadline (the session's timer, which clears itself as it answers) nor
              // past a tightening's earlier one whose timer has not answered yet
              live: () => call.cancelled !== true && call.timer != null && call.timer.expired !== true &&
                !(Number.isFinite(call.deadline) && Date.now() >= call.deadline) && !sessionEnded(call),
              // its caller checked again, as a fresh call is: its grant on the device read anew (main's own check, userAuth; a grant
              // revoked during the hold is refused with the uniform answer), then its state again, after that lookup
              release: () => userAuthLib()(null, null, deviceID, call.appKey, serviceID, actionName, () => {}, (authErr) => {
                try {
                  if (call.cancelled === true || call.timer == null || call.timer.expired === true ||
                    (Number.isFinite(call.deadline) && Date.now() >= call.deadline) || sessionEnded(call)) return callerEndedOf(call, serviceID, actionName);
                  if (authErr != null) return call.callback(goneAtVerdict(), null);
                  // (and the device again, after the lookup: neither held nor in flight while it ran, so a module turned off, or a copy
                  // replaced, meanwhile is seen here, just before the send)
                  if (!listedNow(settingsDM, deviceID)) return call.callback(goneAtVerdict(), null);
                  if (!servingNow(settingsDM, deviceID, device)) {
                    const now = answerNow(settingsDM, deviceID, device);
                    return call.callback((now != null) ? now : new CountinghouseError('CTX_CALL_NOT_READY', `${serviceID}/${actionName}`), null);
                  }
                  return send();
                } catch (e) {
                  // (a check that threw, or a send that threw before any answer: logged, and answered with the uniform answer from its
                  // one maker, as HeldCall.end answers one, never with the thrown object)
                  LOG.E(e);
                  return call.callback(goneAtVerdict(), null);
                }
              }),
              answer: (err) => call.callback((err != null) ? err : new CountinghouseError('CTX_CALL_NOT_READY', `${serviceID}/${actionName}`), null),
              callerEnded: () => callerEndedOf(call, serviceID, actionName)
            }, settingsDM);
          }
          return send();
        } else {
          // single-thread mode: a call has no token, so its ask context
          // rides on its args under a Symbol (ctx.ask, lib/handler-ctx.js
          // attachAsk): not in the handler's input, though this mode
          // isolates nothing and keeps nothing from a handler
          if (this.ask != null) {
            handlerCtx.attachAsk(args, {state: this.ask, module: device.moduleName, deviceID: deviceID, serviceID: serviceID, actionName: actionName, spec: device.spec});
          }
          // Module settings run only with worker threads: a module that
          // declares them is refused at its load in single-thread mode
          // (lib/module-manager.js: at the load's first check, at the
          // package.json read just before its code loads, and at a reload),
          // so none has a state or values here. The gate still runs, and
          // every claim is checked: a
          // module that declares none never has its text answered in the
          // runtime's voice. A hop here is a ctx.call's (lib/service-client.js's
          // local branch sets its session's billingKey); a client's call is
          // outer.
          const settingsOuter = this.billingKey == null;
          const settingsState = settingsGate.stateOf(settingsDM, device);
          const settingsRefused = settingsGate.requiredRefusal(settingsDM, deviceID, settingsOuter, settingsState);
          if (settingsRefused != null) return this.callback(settingsRefused, null);
          const answer = this.callback;
          this.callback = (err, ...rest) => answer.call(this, settingsGate.claimAnswer(err, settingsDM, deviceID, settingsState, settingsOuter), ...rest);
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
    const leaving = keepsDeviceList(present) && present.unloading === true;
    if (present != null && !leaving) return callback();
    const code = leaving ? 'MODULE_RELOADING' : this.missingDeviceError(deviceID).code;
    if ((code !== 'MODULE_RELOADING' && code !== 'MODULE_RESTARTING') || Date.now() >= deadline) return callback();
    return setTimeout(check, JOB_RELOAD_POLL_MS);
  };
  check();
};

// A run's DEVICE_NOT_FOUND says whether startup discovery had finished when
// it was answered (the reviewer's ruling (6)(b) on #341): before, a hidden
// device's run and a never-hosted one's are both retried; after, neither
// (lib/job-control-common.js notRetried). Not enumerable: never serialized.
DeviceManager.prototype.discoveredTag = function(err) {
  if (err != null && err.code === 'DEVICE_NOT_FOUND') Object.defineProperty(err, 'afterDiscovery', {value: this.allDevicesLoaded === true, enumerable: false});
  return err;
};

// the session a job's run carries (lib/job-sessions.js forRun), or null
const runSessionOf = (extraArgs) => ((extraArgs != null && typeof(extraArgs.session) === 'string') ? extraArgs.session : null);

DeviceManager.prototype.onInvokeJobs = function(deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) {
  // a device not listed (its module going on or off) waits for nothing
  if (options.workerThread === true && isMainThread === true && listsDevice(deviceID)) {
    return this.waitThroughReload(deviceID, () => this.invokeJobsNow(deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs), cancelled);
  }
  return this.invokeJobsNow(deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs);
};

DeviceManager.prototype.invokeJobsNow = function(deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) {
  // Given up on meanwhile (the processor's timeout during the reload wait):
  // nothing is sent to the worker, and the processor has already answered.
  if (typeof(cancelled) === 'function' && cancelled()) return;
  // A device not listed (its module going on or off, #413 section 5.5): as
  // one never hosted, and in shared mode not retried (lib/job-control-common.js
  // notRetried), as one never hosted isn't.
  if (!listsDevice(deviceID)) return callback(this.discoveredTag(new CountinghouseError('DEVICE_NOT_FOUND', deviceID)));
  // nor a part a scenario has taken in (a scheduler made while its module
  // was listed never runs it once it is a part: post-rel caller 400's
  // medium, 4), as add-job refuses it; not retried (MODULE_NOT_LISTED).
  // (the single-identity profile's other unlisted modules are not refused
  // here: their runs are the runtime's own)
  if (require('./mcp/tool-registry').pulledInPart({deviceManager: this}, deviceID)) {
    return callback(new CountinghouseError('MODULE_NOT_LISTED'));
  }
  // (after the listing: a device not listed says nothing
  // of its actions) A job whose action its declared text leaves unusable never runs (F3-1,
  // the load's one decision, lib/hidden-text-verdict.js): a task's run and
  // its re-run (an answered question, a pass with no form) and add-job's,
  // judged here, after any reload it waited out, by the spec now loaded
  // (#400); not retried (lib/job-control-common.js NOT_RETRIED)
  // answered as a missing action is (lib/listing-scope.js oneActionAnswer:
  // post-rel caller 400, a job's recorded failure doesn't tell them apart
  // either), and a missing one's (or a missing service's) failure the same,
  // whichever path raised it
  const {noAction, oneActionAnswer} = require('./listing-scope');
  if (require('./hidden-text-verdict').unusableAt(deviceID, serviceID, actionName)) {
    return callback(noAction());
  }
  const told = callback;
  callback = (err, ...rest) => told(oneActionAnswer(err), ...rest);
  // A run with no session of a per-session module: the one answer, as a
  // sessionless call's, not retried (#482's high, round 2, 6). Per-session
  // by its record, or, out of the map (restarting, spawning), by its
  // module's pin, as the routes decide it (listing-scope restReaches; round
  // 3, 3), so it never takes the shared path below. (A run WITH a session
  // whose device is out of the map takes that path as before: its
  // missing-device answer. workerFor serves only a record: the medium on
  // round 3, 1.)
  const record = isMainThread === true && isRecord(this.deviceMap[deviceID]);
  if (isMainThread === true && runSessionOf(extraArgs) == null &&
    (record || (!Object.hasOwn(this.deviceMap, deviceID) && !require('./listing-scope').restReaches({deviceManager: this}, deviceID)))) {
    return callback(new CountinghouseError('MODULE_NOT_LISTED'));
  }
  // R1 Task 5: a per-session module's run goes to the worker of the job's
  // own session (the runner's bookkeeping, lib/job-sessions.js); one whose
  // session has ended runs nothing and is answered as a device not hosted
  if (record) {
    return this.workerFor(deviceID, runSessionOf(extraArgs), (err, wm) => {
      // a session that has ended (or none): as one never hosted, not retried
      if (err) return callback(this.discoveredTag(err));
      if (typeof(cancelled) === 'function' && cancelled()) return;
      return this.invokeJobs(wm, deviceID, serviceID, actionName, input, jobID, callback, extraArgs, cancelled);
    }, {hop: true});
  }
  this.ensureDeviceState(deviceID, (err, cdifDevice) => {
    if (err) return callback(this.discoveredTag(err));

    if (isMainThread !== true) return callback(new CountinghouseError('DEVICE_ACTION_CALL_FAIL', 'cannot start process job in child thread, this job will fail'));
    return this.invokeJobs(cdifDevice, deviceID, serviceID, actionName, input, jobID, callback, extraArgs, cancelled);
  });
}

// A reload in place (packs in place, part 2; the reviewer's ruling A, drain
// then switch: lib/modules-in-place.js): while a module is replaced, a new call
// to its device waits, polled, until the new version is up or the bound
// passes (--requestTimeout for the old version's calls to finish, plus the
// spawn), then goes to whatever stands. Calls already running finish on the
// old version.
const REPLACE_SPAWN_BOUND_MS = 30000;
const REPLACE_POLL_MS = 50;
// a waiting hop's last moment before its token expires
const HOP_WAIT_MARGIN_MS = 250;
DeviceManager.prototype.replacingInPlace = function(deviceID) {
  const mm = this.moduleManager;
  if (mm == null || !(mm.replacingInPlace instanceof Map) || mm.replacingInPlace.size === 0) return false;
  const wm = this.deviceMap[deviceID];
  const ended = (wm == null && typeof(mm.endedStateForDevice) === 'function') ? mm.endedStateForDevice(deviceID) : null;
  // out of the map with its ended record already settled (between the old
  // version's end and the new one's registration): the module the device
  // belongs to, as the registry knows it (M4a)
  const name = (wm != null) ? wm.hostModuleName : (ended != null ? ended.name : this.moduleOfDevice(deviceID));
  return typeof(name) === 'string' && mm.replacingInPlace.has(name);
};

// fn once the device's module is no longer being replaced in place, or at
// `until` (ms): a client's call and a hop alike.
DeviceManager.prototype.whileReplacing = function(deviceID, until, fn) {
  const check = () => {
    if (this.replacingInPlace(deviceID) && Date.now() < until) return setTimeout(check, REPLACE_POLL_MS);
    return fn();
  };
  return check();
};

DeviceManager.prototype.onInvokeDeviceAction = function(deviceID, serviceID, actionName, args, session) {
  if (options.workerThread === true && isMainThread === true && this.replacingInPlace(deviceID)) {
    // the waiting call's own timeout (lib/call-limits.js)
    const until = Date.now() + Number(callLimits.of(session).requestTimeout) + REPLACE_SPAWN_BOUND_MS;
    return this.whileReplacing(deviceID, until, () => this.invokeDeviceActionNow(deviceID, serviceID, actionName, args, session));
  }
  return this.invokeDeviceActionNow(deviceID, serviceID, actionName, args, session);
};

DeviceManager.prototype.invokeDeviceActionNow = function(deviceID, serviceID, actionName, args, session) {
  // R1: a per-session module's call goes to its session's own worker
  // (workerFor); every other dispatch site is Task 5's
  if (isRecord(this.deviceMap[deviceID]) && typeof(session) !== 'function') {
    return this.workerFor(deviceID, session != null ? session.sessionId : null, (err, wm) => {
      if (err) return session.callbackWithoutTimer(err, null);
      return this.invokeAction(wm, deviceID, serviceID, actionName, args, session);
    });
  }
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
  this.ensureListedDevice(deviceID, (err, cdifDevice) => {
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
        // the main thread's own copy (lean worker step 3): a worker is not asked
        const spec = (device.deviceList != null) ? device.deviceList[deviceID] : null;
        if (spec == null) return this.callback(new CountinghouseError('CANNOT_GET_DEVICE_SPEC'), null);
        return this.callback(null, spec);
      } else {
        return device.getDeviceSpec(this);
      }
    }.bind(session));
  });
};

// What CHDevice's resolveSchemaFromPath reads (schemaDoc, and its own
// dereferenced cache), for a worker's module: from the main thread's copy of
// its schema.json, parsed once per worker.
function schemaHolderOf(wm) {
  if (wm.schemaHolder == null) {
    const text = (wm.moduleSpec != null) ? wm.moduleSpec.schemaText : null;
    let doc = null;
    try { doc = (text == null) ? null : JSON.parse(text); } catch (e) { doc = null; }
    wm.schemaHolder = {schemaDoc: doc};
  }
  return wm.schemaHolder;
}

// A served device's spec and the raw schema.json its schema route answers
// from (the main thread's own copy in worker mode), for the route's judging
// (lib/routes/schema.js, #400)
DeviceManager.prototype.schemaPartsOf = function(deviceID) {
  const entry = (this.deviceMap != null && Object.hasOwn(this.deviceMap, deviceID)) ? this.deviceMap[deviceID] : null;
  if (entry == null) return {spec: null, schemaDoc: null};
  if (options.workerThread === true && isMainThread === true) {
    // (a worker's, or a per-session module's record: both answer the route
    // from the main thread's copy, schemaHolderOf)
    if (!keepsDeviceList(entry)) return {spec: null, schemaDoc: null};
    return {spec: this.specOf(deviceID), schemaDoc: schemaHolderOf(entry).schemaDoc};
  }
  return {spec: this.specOf(deviceID), schemaDoc: entry.schemaDoc};
};
// The spec a device serves by, from its device map entry: a worker's (or a
// per-session record's) copy in its deviceList, or an in-process device's
// own; null when no entry holds the ID
DeviceManager.prototype.specOf = function(deviceID) {
  const entry = (this.deviceMap != null && Object.hasOwn(this.deviceMap, deviceID)) ? this.deviceMap[deviceID] : null;
  if (entry == null) return null;
  if (keepsDeviceList(entry)) return entry.deviceList != null && Object.hasOwn(entry.deviceList, deviceID) ? entry.deviceList[deviceID] : null;
  return entry.spec != null ? entry.spec : null;
};

DeviceManager.prototype.onGetDeviceSchema = function(deviceID, path, session) {
  this.ensureListedDevice(deviceID, (err, cdifDevice) => {
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
          // the main thread's own copy of schema.json (lean worker step 3),
          // resolved as a device resolves it
          return CHDevice.prototype.resolveSchemaFromPath.call(schemaHolderOf(device), path, null, (err, self, data) => {
            return this.callback(err, data);
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
    return workerMessage.sendDeviceQueryReplyToChild({msgID: msgID, errMsg: new CountinghouseError('DEVICE_NOT_FOUND', deviceID).message, spec: null}, 'DEVICE_NOT_FOUND');
  }
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    // (an auth backend that did not answer in time: not the runtime refusing, so no refusal is noted)
    workerMessage.sendDeviceQueryReplyToChild({msgID: msgID, errMsg: new CountinghouseError('DEVICE_NOT_FOUND', deviceID).message, spec: null});
  }, options.peerChannelAuthLookupTimeoutMs);
  return userAuthLib()(null, null, deviceID, identity, null, null, () => {}, (authErr) => {
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
  // a device not listed (its module going on or off): as one never hosted,
  // after the access check (#413 section 5.5)
  if (!listsDevice(deviceID)) {
    return answerAfterAccessCheck(() => workerMessage.sendDeviceQueryReplyToChild(Object.assign({msgID: msgID, spec: null}, CountinghouseError.replyFields(notListed()))));
  }
  // R1 Task 5: a per-session module's spec is its record's (no worker is
  // needed for it, and none is started), for a call whose session is live;
  // for any other it is a device not hosted, as its hop would be
  // (the session and the record read again after the access check's round
  // trip: either may have gone meanwhile, as the hop reads them again)
  if (isRecord((this.deviceMap != null) ? this.deviceMap[deviceID] : null)) {
    return answerAfterAccessCheck(() => {
      const entry = (this.deviceMap != null) ? this.deviceMap[deviceID] : null;
      const live = sessionLive(tokenEntry.session);
      return workerMessage.sendDeviceQueryReplyToChild((live && isRecord(entry) && entry.closing !== true && entry.deviceList[deviceID] != null)
        ? {msgID: msgID, errMsg: null, spec: entry.deviceList[deviceID]}
        : Object.assign({msgID: msgID, spec: null}, CountinghouseError.replyFields(live ? this.missingDeviceErrorForHop(deviceID) : new CountinghouseError('DEVICE_NOT_FOUND'))));
    });
  }
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


// the validators' caller for a hop from callerWM (the peer path's too,
// lib/peer-channel-broker.js)
DeviceManager.hopCallerOf = hopCallerOf;
// the calls held on a device object for its verdict (HeldCall): in flight for a drain
DeviceManager.releaseHeldOn = releaseHeldOn;
// (for tests: the calls held on a device object, or on a record's session workers, each with its deadline)
DeviceManager.heldDeadlinesOn = (device) => Array.from(verdictHolds.values()).flatMap((holds) => Array.from(holds)).filter((h) => heldOn(h, device)).map((h) => ({deviceID: h.deviceID, endsAt: h.endsAt}));
// For tests: each call held on device reaches its deadline now, as its timer would, in this turn (before its poll can run)
DeviceManager.atBoundOnForTests = (device) => Array.from(verdictHolds.values()).flatMap((holds) => Array.from(holds)).filter((h) => heldOn(h, device)).forEach((h) => h.atBound());
DeviceManager.HOP_HOLDS_PER_CALL = HOP_HOLDS_PER_CALL;
DeviceManager.verdictHeldOn = (device) => (device != null && typeof(device) === 'object') ? (verdictHeld.get(device) || 0) : 0;

// A call's own progress, posted by its worker (MCP completeness M21): only
// the posting worker's own token, and only its call's root token, counts --
// a hop's report is dropped (a part's percentage says nothing about the
// whole call) -- then the call's notifier reports n of 100 (lib/mcp/
// progress.js keeps it strictly increasing, coalesced, capped, never after
// the answer, and stops the hop ticks). Anything malformed is dropped.
function onCallProgress(message, wm) {
  const data = dataOf(message);
  if (typeof(data.token) !== 'string' || !isProgress(data.progress) || wm == null) return;
  const entry = callTokens.resolve(data.token, {workerId: wm.workerId});
  // a task's token too: a task's progress is its statusMessage (spec
  // section 6), never notifications/progress
  if (entry == null || entry.parent != null || entry.jobID != null || entry.progress == null) return;
  entry.progress.report(data.progress, 100);
}

module.exports = DeviceManager;
module.exports.onCallProgress = onCallProgress;
// (sandbox 65: a run's end, bounded)
module.exports.runProgressWritten = runProgressWritten;
module.exports.runKey = runKey;
// (validation 26: what a send records of its module settings)
module.exports.sendCounted = sendCounted;
