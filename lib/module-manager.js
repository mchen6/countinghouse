'use strict';
const events         = require('events');
const util           = require('util');
const options        = require('../lib/cli-options');
// a module's worker outlives the request that may have started it: spawned
// outside its store, so nothing the worker sends later is counted against
// that request's address (lib/unauth-limit.js)
const {outsideRequest} = require('./unauth-limit');
const exec           = require('child_process').exec;
const CountinghouseError = require('../lib/countinghouse-error').CountinghouseError;
const LOG            = require('../lib/logger');

const getDeviceConfig = require('./device-config');

const semver      = require('semver');
const rimraf      = require('rimraf');
const fs          = require('fs');
// a module quota's build (or rebuild): -> Promise of the quota, never
// rejected (a session's end and a respawn await it). A walk that throws
// leaves what it counted, logged; the quota is marked for a rebuild.
function buildShares(q, skip) {
  return measureShares(q.quota, q.sessionsDir, q.limits, skip).catch((e) => {
    q.quota.buildFailed = true;
    LOG.E(e);
  }).then(() => q.quota);
}

// R1 Task 6: how many partitions a module quota's first build walks at once
const BUILD_WALKS = 4;
// a session's id, the only name of a partition under <name>/sessions
const {SESSION_ID} = require('./redis-namespace');
// how long past its deadline a call that never answered still counts as its
// session worker's work (lib/worker-message.js inFlight)
const STALE_CALL_MARGIN_MS = 5000;
const async       = require('async');
const path        = require('path');
// a lean worker's entry by the spelling its loader gives every file it
// requires: one instance of each (lib/fs-broker/worker-entry.js). The
// loader's options are read once, as the process starts; the entry is
// resolved on the first start and kept.
const PRESERVES_SYMLINKS = require('./fs-broker/worker-entry').preservesSymlinks(process.execArgv, process.env);
let leanEntry = null;
const leanWorkerEntry = () => {
  if (leanEntry != null) return leanEntry;
  leanEntry = require('./fs-broker/worker-entry').entryFor(__dirname, 'lean-worker.js', {preserve: PRESERVES_SYMLINKS,
    onFallback: (e) => LOG.I(`lean worker: its entry's real path could not be read (${(e && e.code) || 'error'}); started by ${__dirname} as spelled`)});
  return leanEntry;
};
const {ManifestPins, RECORD_DIR} = require('./manifest-pins');
const moduleState = require('./module-state');
const moduleSettings = require('./module-settings');
// the operator's ceiling a module's settings are made under (its fixed
// values; one that cannot be trusted refuses a load): where the settings
// tool is served, else none (lib/settings-tool.js moduleCeilingNow)
const settingsCeiling = () => require('./settings-tool').moduleCeilingNow();
// a module's entries in the pinned device index (pinnedDevicePackages), by
// its own pinned IDs (still its own: another module's are never dropped)
function dropPinnedDevices(mm, name) {
  if (!(mm.pinnedDevicePackages instanceof Map) || mm.pinnedDeviceIDs == null) return;
  const own = mm.pinnedDeviceIDs[name];
  if (own instanceof Set) for (const id of own) if (mm.pinnedDevicePackages.get(id) === name) mm.pinnedDevicePackages.delete(id);
}

// A module's package.json from disk, parsed (throws as fs and JSON.parse do):
// the one read single-thread mode's settings check and its load share.
function readPackageJson(modulePath) {
  return JSON.parse(fs.readFileSync(require('./fs-broker/identity').pathFor(modulePath).join(modulePath, 'package.json')).toString());
}

// Module settings run only with worker threads (the user's decision, 11-18):
// in single-thread mode a module that declares them is refused at its load
// and its reload; null for one that declares none.
function singleThreadSettingsRefusal(name, pkg) {
  if (!moduleSettings.declaresSettings(pkg)) return null;
  return CountinghouseError.withFields('SETTINGS_NEED_WORKER_THREADS', {module: String(name)});
}

// A supervised restart that failed (err): retried by the supervisor, or
// suspended at once when retrying cannot succeed: a module the sandbox
// refuses, or one the operator's ceiling refuses (its fixed value rejected
// or not declared: a ceiling typo must not crash-loop a module to
// MODULE_SUSPENDED; the ceiling's reason is said, and once the ceiling is
// fixed the next load proceeds).
function restartFailed(mm, name, record, err) {
  if (err == null || !mm.supervisor.isCurrent(name, record)) return;
  LOG.E(new Error(`module sandbox: ${name} restart failed: ${err.message}`));
  if (err.code === 'MODULE_SANDBOX_REFUSED') {
    mm.supervisor.suspend(name, `restart refused: ${err.message}`);
    LOG.E(new Error(`module sandbox: ${name} suspended: the sandbox refuses it -- POST /restart-module to try again`));
    return mm.givenUp(name, 'MODULE_SANDBOX_REFUSED');
  }
  if (require('./settings-reread').isCeilingRefusal(err)) {
    mm.supervisor.suspend(name, `restart refused: ${err.message}`);
    LOG.E(new Error(`module settings: ${name} suspended: ${err.message} -- once the ceiling is updated, load it again`));
    return mm.givenUp(name, 'MODULE_SUSPENDED');
  }
  const decision = mm.supervisor.exited(name, `restart failed: ${err.message}`, record.specs);
  if (decision.action === 'suspend') {
    LOG.E(new Error(`module sandbox: ${name} suspended after repeated exits: ${
      JSON.stringify(mm.supervisor.status(name).exits)} -- POST /restart-module to start it again`));
    mm.givenUp(name, 'MODULE_SUSPENDED');
  } else {
    LOG.I(`module sandbox: ${name} restart failed; retrying in ${decision.delayMs} ms`);
  }
}

// A worker (or per-session record) takes its state as it registers, by the
// one rule (lib/settings-reread.js next, the state its spawn made as the
// previous one): a reread while it came up (which finds no proxy for it yet)
// is not missed, and it runs what its siblings would. A refusal now keeps
// the state it was spawned with, as a running module keeps its own.
// Asked once it is in the module map, so its new state goes where every
// state goes (lib/settings-reread.js put). Skipped when the settings file and
// the ceiling are as they were when its state was made; otherwise stateFor's
// own lines are not said again (the spawn said them), and a change is.
function settleSettings(mm, name, module) {
  if (module == null || !(module instanceof WorkerMessage || isRecord(module))) return;
  const own = module.settings;
  if (own == null || own.made == null) return;
  const reread = require('./settings-reread');
  const st = reread.settle(mm, name, own);
  if (st !== own) reread.put(mm, name, st);
}
const modulePermissions = require('./module-permissions');
const {SessionModuleRecord, isRecord} = require('./session-module-record');
const {StartupOrder} = require('./startup-order');

const Worker         = require('worker_threads').Worker;
const isMainThread   = require('worker_threads').isMainThread;
// In a worker, the one module it runs (see loadModuleFromPath).
let workerModuleName = null;
const WorkerMessage  = require('./worker-message');
const workerLimits   = require('./worker-limits');
const moduleSandboxConfig = require('./module-sandbox-config');
const ModuleSupervisor = require('./module-supervisor');
const moduleRoles = require('./module-roles');
const RESERVED_TOOL_NAMES = require('./mcp/tool-name').RESERVED_TOOL_NAMES;

// Discovery's hold, in single-thread (debug) mode only (a worker's device is
// registered from the main thread's spec, with no discovery: lean worker
// step 3): a module brings its one device online at once on discover
// (lib/module-layout.js, the one module format), so its discovery is over as
// soon as that device has reported. This is only the cap, for a module whose
// device never comes online: its construction failed (an invalid spec).
const DISCOVERY_HOLD_MS = 5000;

// Calls done() once, when every module in `modules` (name -> instance) has
// reported its device (the device manager emits 'devicereported' on the
// module after registering the device and sending its online message), or
// after DISCOVERY_HOLD_MS when any has not. Attach it before emitting
// 'discover', so only this discovery's device counts.
function whenDiscovered(modules, done) {
  let finished = false;
  const listening = [];
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(cap);
    for (const [mod, fn] of listening) mod.removeListener('devicereported', fn);
    done();
  };
  const cap = setTimeout(finish, DISCOVERY_HOLD_MS);
  const all = Object.values(modules);
  if (all.length === 0 || !all.every((mod) => mod != null && typeof(mod.once) === 'function')) return;
  let left = all.length;
  for (const mod of all) {
    // Deferred, so the device manager's onDeviceOnline (which emits this)
    // finishes with the device before discovery is declared over.
    const fn = () => { left--; if (left === 0) setImmediate(finish); };
    mod.once('devicereported', fn);
    listening.push([mod, fn]);
  }
}

function ModuleManager() {
  this.modules = {};
  // Package names of the parts a scenario pulled in at --loadModule: loaded,
  // never listed (local-mode spec §3; lib/mcp/tool-registry.js listingOf).
  this.unlisted = new Set();
  // the startup list's order, while its modules load (loadAllModules)
  this.startupOrder = null;
  // and each startup module's place in that list, until the start's
  // discovery is over: a device ID several of them declare is the earliest's
  // (lib/device-manager.js registerFromSpec; C-startup-order). Every load answering, a restart meanwhile, ends nothing
  // here: only the start's discovery does.
  this.startupRanks = null;
  // each module's last settings state (lib/module-settings.js stateFor), what a
  // supervised restart keeps if the settings file cannot be read then;
  // dropped by an operator's unload and an uninstall
  this.lastSettings = new Map();
  // One lock per module name for spawns and uninstall (lib/module-lifecycle.js).
  this.lifecycle = new (require('./module-lifecycle').ModuleLifecycle)();
  this.noofTotalModules = 0;
  // this.noofAvailableModules = 0;
  this.noofLoadedModules = 0;
  // deviceID -> {code, name} for the devices of a module whose worker was
  // ended on purpose or for good: MODULE_RELOADING while a reload replaces
  // it, MODULE_UNLOADED once it is unloaded, its new code failed to load,
  // or it crashed with no supervisor. A request for one of these devices
  // says so instead of DEVICE_NOT_FOUND (DeviceManager's missingDeviceError).
  // Recorded before the old devices leave the device map (unloadModuleExternal
  // marks synchronously, the purge follows the worker's acknowledgement), and
  // an entry is cleared only when its device is back in the map, which comes
  // after the new worker's discovery, seconds after the load itself. One
  // entry per device ever hosted, so bounded by the modules loaded.
  this.endedDevices = {};
  // Operator actions per module name (loadModuleByWorker): the count of
  // actions so far, and how many of its spawns have not settled.
  this.generations = {};
  this.spawnsPending = {};

  // Restart policy for unexpected worker exits (lib/module-supervisor.js).
  // Main thread, worker mode, sandbox on only; null otherwise, which keeps
  // today's "a crashed module stays down".
  // The main thread's copy of each module's package.json, read before any
  // of its code runs: at a spawn, or before an operator's validation
  // (lib/manifest-pins.js, R2-1 Task 4).
  // name -> the device IDs the module's own api.json declares, read on the
  // main thread at the spawn before its code runs, again only at an
  // operator's action (the review of #163): what a worker may announce.
  this.pinnedDeviceIDs = {};
  // name -> the friendlyName that api.json gives its device (or null)
  this.pinnedFriendlyNames = {};
  this.pinnedDevicePackages = new Map();
  this.manifestPins = new ManifestPins({recordDir: () => path.join(options.moduleDataPath, RECORD_DIR),
    log: (line) => LOG.E(new Error(line))});
  this.supervisor = (isMainThread === true && options.workerThread === true && options.moduleSandbox !== 'off')
    ? new ModuleSupervisor({
      restart: (name, record) => {
        LOG.I(`module sandbox: ${name} restarting after: ${record.lastReason}`);
        // An operator action while this spawn is in flight clears the record;
        // the spawn then terminates its worker instead of registering it.
        this.spawnModuleWorker(record.modulePath, name, record.version, (err) => restartFailed(this, name, record, err),
          () => this.supervisor.isCurrent(name, record));
      }
    })
    : null;

  // R1 (#236 section 4a): a per-session module's workers on the shared
  // runtime, one per (module, session) (lib/session-workers.js), and the fs
  // quota each module's share (the Reviewer's P5): name -> {ready, workers}
  this.sessionQuotas = new Map();
  // name -> Map(token -> path): each spawn begun and not yet answered,
  // known to the overlap judgement meanwhile (knownModuleRoots); each spawn
  // retires its own when it answers, loaded or failed (retireSpawning)
  this.spawningModules = new Map();
  this.sessionWorkers = (isMainThread === true) ? require('./session-workers').create({
    // once up, the worker takes its record's settings as they are then: a
    // reread while it came up (lib/settings-reread.js, which sets those of
    // the workers already up) is not missed
    spawn: (name, sid, wanted, cb) => this.spawnSessionWorker(name, sid, wanted, (err, wm) => {
      const rec = this.modules[name];
      if (err == null && wm != null && isRecord(rec)) wm.settings = (rec.settings != null) ? rec.settings : null;
      cb(err, wm);
    }),
    end: (wm) => this.endSessionWorker(wm),
    onExit: (wm, fn) => { if (wm.exited === true) return fn(); wm.worker.once('exit', fn); },
    // a live token, a request under way, or a call held for its verdict
    // (ModuleManager.workerBusy)
    busy: (wm) => ModuleManager.workerBusy(wm),
    announce: (name, sid, text) => require('./notices').add(name, text, {session: sid}),
    max: () => options.maxSessionWorkers,
    // a session still open (lib/sessions.js, as workerFor asks): none is
    // spawned for one that has ended
    live: (sid) => require('./sessions').live(sid)
  }) : null;

  // What is listed may have changed (a module began to go on or off: #413
  // section 5.5, the one set every session reads). Each session worker of a
  // module no longer listed stops; its partition is kept until the session
  // ends. (one per process: a later manager's replaces it, as below)
  if (isMainThread === true) require('./module-visibility').onChange(() => this.sessionViewChanged(), 'session-workers');
  // a session closed: the pool's stopping mark for it goes (R1 Task 6)
  // (one per process: a later manager's replaces it, so none piles up)
  if (this.sessionWorkers != null) require('./sessions').onClose('session-workers', (sid) => this.sessionWorkers.sessionClosed(sid));

  this.on('moduleload', this.onModuleLoad.bind(this));
  this.on('moduleunload', this.onModuleUnload.bind(this));

  // special event handler to get the list of devices under a module instance
  // this event is emmited by device manager and is only active when verify
  // package route is enabled
  this.on('querydevicelistresult', this.onQueryDeviceListResult.bind(this));
}

util.inherits(ModuleManager, events.EventEmitter);

//get the list of devices owned by module name
ModuleManager.prototype.getModuleDeviceListByName = function(name, callback) {
  const moduleInstance = this.modules[name];
  const supervised = (this.supervisor != null) ? this.supervisor.status(name) : null;
  const sandboxStatus = (wm) => {
    if (supervised == null && wm == null) return null;
    const s = supervised || {state: 'running', lastReason: null, exits: [], nextRestartAt: null};
    return Object.assign({}, s, {violations: (wm != null && wm.violationCount != null) ? wm.violationCount : 0});
  };

  if (moduleInstance == null) {
    if (supervised != null) return callback(null, {packageInfo: {name: name}, deviceList: [], sandbox: sandboxStatus(null)});
    return callback(new Error('unknown module name'), null);
  }

  //HACK: the handler is not interested with packageInfo so we pass it just an empty object here
  //this is to make onQueryDeviceListResult() happy
  this.emit('querydevicelist', moduleInstance, {name: name}, (err, data) => {
    if (data != null && typeof(data) === 'object' && options.moduleSandbox !== 'off') {
      data.sandbox = sandboxStatus(moduleInstance instanceof WorkerMessage ? moduleInstance : null);
    }
    return callback(err, data);
  });
};

ModuleManager.prototype.onModuleLoad = function(name, module, version) {
  // Once a module's code is loaded: in single-thread mode here, and under
  // --workerThread on the main thread once the worker acknowledged the load
  // (a lean worker logs nothing of its own: lean worker step 3).
  LOG.I(`module: ${name}@${version} loaded`);
  this.unitLoaded(name);

  module.discoverState = 'stopped';

  const m = this.modules[name];
  if (m != null) {
    // module reloaded
    if (m.discoverState === 'discovering') {
      m.discoverState = 'stopped';
    }
    this.emit('purgedevice', m, 'MODULE RELOADED', () => {
      this.modules[name] = module;
      settleSettings(this, name, module);
    }); // to be handled by device manager
    // Backstop: a replaced worker must not outlive its module entry.
    if (m !== module && m instanceof WorkerMessage && m.worker != null) {
      m.worker.terminate().catch(() => {});
    }
  } else {
    this.modules[name] = module;
    settleSettings(this, name, module);
  }


  const _mm = this;

  if (options.workerThread === true && isMainThread === true) {
    //worker thread mode and run in main thread
    // a unit's held load opens no discovery window (allDevicesLoaded stays
    // as it is: a query for a device not there still answers at once)
    if (!_mm.isHeld(name)) _mm.emit('modulediscovering');

    module.discoverState = 'discovering';

    // The worker has loaded the module's handlers: its device is registered
    // from the main thread's own copy of the spec (lean worker step 3, Task
    // 4; DeviceManager's registerFromSpec), with no discovery round trip.
    // Deferred a turn, as the worker's discover answer was, so the load that
    // emitted 'moduleload' finishes first. During the startup list's loads,
    // which run several at once, also held until every module before it in
    // the list is registered (the startup levers' (2)), so the device map
    // fills in the list's order: tools/list, its deduped names, a deviceID's
    // first holder. The module itself is in this.modules already: a crash,
    // unload or reload meanwhile acts on it as on any loaded module, and its
    // devices are then not registered (it is no longer `module`).
    _mm.handOn(name, (inOrder) => setImmediate(() => {
      module.discoverState = 'stopped';
      if (_mm.modules[name] === module) {
        _mm.emit('registerdevices', module);
        // a device of the old code that did not come back is gone for good
        _mm.settleEndedDevices(name);
      }
      // its registration's outcome, registered or refused, for a unit: this
      // load's own, or the module taken off (not one replaced meanwhile,
      // whose replacement's registration is the outcome)
      if (_mm.modules[name] === module || _mm.modules[name] == null) _mm.unitRegistration(name);
      // a startup module taken off while it waited is counted all the same,
      // as a failed load is, so discovery still ends
      if (_mm.modules[name] != null || inOrder === true) _mm.moduleDiscovered(name);
    }));
  } else if (options.workerThread === false && isMainThread === true) {
    //non worker-thread mode
    if (!_mm.isHeld(name)) _mm.emit('modulediscovering'); //is this event garenteed handled before next event?

    // Listening before 'discover', so only this discovery's device counts.
    whenDiscovered({[name]: module}, function() {
      this.emit('stopdiscover');
      this.discoverState = 'stopped';
      _mm.unitRegistration(name);
      _mm.moduleDiscovered(name);
    }.bind(module));
    module.emit('discover');
    module.discoverState = 'discovering';
  } else {
    //worker thread mode but run in child thread, this is handled by discoverAllDevices call below
    // because we send discover event to child thread from main thread, see above
  }
};

ModuleManager.prototype.onModuleUnload = function(name, reason, callback) {
  LOG.I(`module: ${name} unloaded due to reason: ${reason}`);
  require('./remote').unregister(name);

  const m = this.modules[name];
  if (m == null) {
    if (callback != null && typeof(callback) === 'function') return callback();
  }

  if (m.discoverState === 'discovering') {
    m.discoverState = 'stopped';
  }

  this.emit('purgedevice', m, reason, () => {
    delete this.modules[name];
    if (callback != null && typeof(callback) === 'function') callback();
  });
};

ModuleManager.prototype.discoverAllDevices = function() {
  if (options.workerThread === false && isMainThread === true) this.emit('modulediscovering');
  for (const m in this.modules) {
    const module = this.modules[m];
    if (module.discoverState === 'discovering') {
      return;
    }
    module.emit('discover');
    module.discoverState = 'discovering';
  }
};

ModuleManager.prototype.stopDiscoverAllDevices = function() {
  if (options.workerThread === false && isMainThread === true) this.emit('allmodulediscovered');
  for (const m in this.modules) {
    const module = this.modules[m];
    if (module.discoverState === 'stopped') {
      return;
    }
    module.emit('stopdiscover');
    module.discoverState = 'stopped';
  }
};

ModuleManager.prototype.onDeviceOnline = function(packageInfo, modulePath, device, module) {
  let found = false;
  for (const moduleName in this.modules) {
    if (this.modules[moduleName] === module) {
      found = true;
      this.emit('deviceonline', device, module, moduleName, packageInfo, modulePath);
    }
  }
  if (found === false) {
    LOG.E(new CountinghouseError('CORRESPONDING_MODULE_NOT_FOUND', 'device online'));
  }
};

ModuleManager.prototype.onDeviceOffline = function(device, module) {
  let found = false;

  for (const moduleName in this.modules) {
    if (this.modules[moduleName] === module) {
      found = true;
      this.emit('deviceoffline', device, module, moduleName);
    }
  }
  if (found === false) {
    LOG.E(new CountinghouseError('CORRESPONDING_MODULE_NOT_FOUND', 'device offline'));
  }
};

ModuleManager.prototype.getModuleInfoFromPath = function(pathList) {
  let list = [];

  if (typeof(pathList) === 'string') {
    list.push(pathList);
  } else if (Array.isArray(pathList)) {
    list = pathList;
  } else {
    LOG.E(new CountinghouseError('LOAD_MODULE_FAIL', 'invalid loadModule argument:', pathList));
    return null;
  }

  const dirs = [];

  list.forEach((item) => {
    if (fs.existsSync(item) && fs.existsSync(`${item}/package.json`)) {
      // (read once and parsed once; a byte-order mark said as itself, as at
      // every other way in, by the package's name where the rest parses;
      // dropped from the start list as an unreadable package.json is; the
      // high review of #452, 10)
      let text = null;
      try { text = fs.readFileSync(`${item}/package.json`, 'utf8'); } catch (e) { text = null; }
      const bom = text != null && text.charCodeAt(0) === 0xFEFF;
      let pkg = null;
      let parsed = false;
      try { pkg = JSON.parse(bom ? text.slice(1) : text); parsed = text != null; } catch (e) { pkg = null; }
      if (bom) {
        const named = pkg != null && typeof(pkg.name) === 'string' ? pkg.name : path.basename(String(item));
        return LOG.E(CountinghouseError.withFields('MODULE_PACKAGE_BOM', {name: named}));
      }
      if (parsed) dirs.push(item);
      else LOG.E(new CountinghouseError('LOAD_MODULE_FAIL', 'invalid package.json file:', item));
    } else {
      LOG.E(new CountinghouseError('LOAD_MODULE_FAIL', 'invalid path or package.json file not found:', item));
    }
  });

  // A scenario brings its parts, unlisted; a scenario with a part missing or
  // a tool name taken is not loaded, and the log says why (local-mode spec §3).
  // Expansion must never stop a start: if it throws anyway, the modules load
  // as given, every one listed, as before roles existed, and the log says so.
  // the modules given at start and what each owns, recorded now: a pack
  // loaded then is unloaded or reloaded in place by name, from this record,
  // never from disk again (lib/modules-in-place.js; #205's review)
  // M4 (#413 section 7.2): under --modulesRoot every directory the start
  // loads is checked, and a part is looked for only among --partDir and the
  // --loadModule directories; a top-level module that cannot load is told
  // to ch-local (module-stopped, when 'start') once the channel is up
  const confined = Array.isArray(options.modulesRoot) && options.modulesRoot.length > 0;
  this.startRefused = [];
  let tops = dirs;
  let partDirs;
  if (confined) {
    const checked = require('./modules-in-place').checkStartPlan(dirs, options.partDir || []);
    tops = checked.tops;
    partDirs = checked.partDirs;
    this.startRefused.push(...checked.refused);
  }
  this.startScenarios = tops.slice();
  this.startPlan = null;
  let load, refused;
  try {
    let owners;
    ({load, refused, owners} = moduleRoles.expandLoadList(tops, {reserved: RESERVED_TOOL_NAMES, partDirs}));
    this.startPlan = {load: load, owners: owners};
  } catch (e) {
    LOG.E(new CountinghouseError('LOAD_MODULE_FAIL', `scenario expansion failed, loading the modules as given: ${e.message}`));
    refused = [];
    // under --modulesRoot only what checkStartPlan kept (M4b's medium review,
    // 1): a directory refused there never loads by this way round
    load = tops.map((dir) => {
      const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`).toString());
      return {path: dir, name: pkg.name, version: pkg.version, listed: true};
    });
  }
  // (the modules this start loads, known to the overlap judgement while
  // they load, whichever way the list was made)
  this.startLoad = load;
  for (const r of refused) {
    // told by its package name only, as checkStartPlan tells (#429's high
    // review, 3): module-stopped names a package
    if (confined && require('./remote/credentials').isPackage(r.name)) this.startRefused.push({name: r.name, code: r.code});
    if (r.code === 'PART_VERSION_CONFLICT') {
      LOG.E(CountinghouseError.withFields('PART_VERSION_CONFLICT', {scenario: r.name, name: r.part, versions: r.versions.join(', ')}));
      continue;
    }
    LOG.E(new CountinghouseError(r.code, moduleRoles.refusedWhy(r)));
  }
  for (const m of load) if (m.listed === false) this.unlisted.add(m.name);
  this.tellStartRefused();
  return load.map((m) => ({path: m.path, name: m.name, version: m.version}));
};

// The supervisor gave up on `name` (three exits, or a restart the sandbox
// refuses; #413 section 7.3). With a control channel nobody can restart it,
// so every unit that holds it is unloaded by the runtime itself, on the
// channel's own chain (ch-local's requests wait behind it), and ch-local is
// told module-stopped only once that has completed. Without one it stays
// suspended and listed, as before (POST /restart-module).
ModuleManager.prototype.givenUp = function(name, code) {
  // (the code it was given up with, kept on its record: a re-add's rollback
  // queues the same -- #397, the high on #528, L2)
  if (this.supervisor != null && this.supervisor.records[name] != null) this.supervisor.records[name].givenUpCode = code;
  if (options.controlChannel == null) return;
  // still given up when its turn comes: the supervisor's same record,
  // suspended, and the same worker generation; a restart or a reload in
  // place meanwhile changes one of them (#429's high review, 2)
  const record = this.supervisor != null ? this.supervisor.records[name] : null;
  const gen = this.generations != null ? this.generations[name] : undefined;
  // (no record now, or none then: not given up; never a throw on the
  // channel's chain: the medium review of #429's high fixes, 5)
  const stillGivenUp = () => {
    if (this.supervisor == null || record == null || !this.supervisor.isCurrent(name, record)) return false;
    const st = this.supervisor.status(name);
    return st != null && st.state === 'suspended' && this.generations[name] === gen;
  };
  const queued = require('./control-channel').enqueue(() => require('./modules-in-place').selfUnload(this, name, code, stillGivenUp));
  if (queued !== true) LOG.W(`module sandbox: ${name}: no control channel to unload it on; it stays suspended`);
};

// A start-plan module the runtime refused is in the final stopped state
// from the beginning (#413 section 7.3): told to ch-local once, as soon as
// the control channel is up (here, or when lib/route-manager.js starts it).
ModuleManager.prototype.tellStartRefused = function() {
  const pending = this.startRefused || [];
  if (pending.length === 0) return;
  const channel = require('./control-channel');
  this.startRefused = pending.filter((r) => channel.tell({type: 'module-stopped', name: r.name, code: r.code, when: 'start'}) !== true);
};

// How many of the startup list's modules load at once: max(1, min(4,
// CPUs - 1)) under --workerThread, where a load is mostly its worker's boot
// on its own thread. On 2 CPUs that is 1: two boots on the one core the main
// thread leaves gained nothing once anything else held a core, and widened
// the tail (startup levers' (2), measured). One at a time also in
// single-thread mode, where module code loads on this thread, and when the
// list names a module twice. A test may set it
// (COUNTINGHOUSE_TEST_STARTUP_LIMIT, read only under the test flag).
function startupLoadLimit(info) {
  if (options.workerThread !== true || info.length < 2) return 1;
  if (new Set(info.map((item) => item.name)).size !== info.length) return 1;
  if (process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG === '1') {
    const forced = Number(process.env.COUNTINGHOUSE_TEST_STARTUP_LIMIT);
    if (Number.isInteger(forced) && forced >= 1) return forced;
  }
  return Math.max(1, Math.min(4, require('os').cpus().length - 1));
}

// Whether `a` comes before `b` in the startup list, while the start's
// discovery lasts: `a` on it and `b` later or not on it at all (a load in
// place meanwhile). False outside that time, or for `a` not on the list.
ModuleManager.prototype.startupEarlier = function(a, b) {
  const ranks = this.startupRanks;
  if (ranks == null || !ranks.has(a)) return false;
  return !ranks.has(b) || ranks.get(b) > ranks.get(a);
};

// A loaded module's devices handed on to registration (onModuleLoad's
// 'registerdevices'): during the startup list's loads, in the list's order
// (lib/startup-order.js), fn(true); at once otherwise, fn().
ModuleManager.prototype.handOn = function(name, fn) {
  if (this.startupOrder == null) return fn();
  return this.startupOrder.inTurn(name, fn);
};

// Discovery: when a module has loaded (its device registered) or failed to.
// The start's discovery ends once each module on the startup list has, by
// name, once (startupPending), whatever else loads meanwhile: a module loaded
// in place, or by an operator, or one of the start's own loaded a second
// time. They counted toward noofTotalModules, so "all module discovered"
// fired before the start's own modules had loaded: the first composition
// pass ran early, and a module that failed it was purged as at a start. A
// module loaded meanwhile has registered before it is discovered, so the
// start's pass, when it comes, verifies it with the rest. After the start's
// discovery every load re-runs it, as before (noofLoadedModules held at the
// total; a bare instance, total 0, the same).
// A unit loaded in place (lib/modules-in-place.js loadPack): while it is in
// progress, its modules' loads re-run no discovery (moduleDiscovered holds
// them), so no pass verifies part of it; once it is whole, one pass scoped
// to it does (DeviceManager.prototype.verifyModules). A load that is not
// part of a unit runs its own pass meanwhile, as before, and leaves the
// unit's devices to the unit's pass. During the start's discovery a unit's
// loads re-run nothing either (startupPending), and its pass waits for the
// start's own (verificationPass).
// -> the unit: {names, loaded, registered}: what it holds, and which of them
// loaded (their code acknowledged: 'moduleload') and registered (the outcome
// of their registration, registered or refused) while it was in progress.
ModuleManager.prototype.holdDiscovery = function(names) {
  if (this.units == null) this.units = new Set();
  const unit = {names: new Set(names), loaded: new Set(), registered: new Set(), changed: null};
  this.units.add(unit);
  return unit;
};
ModuleManager.prototype.releaseDiscovery = function(unit) {
  if (this.units != null) this.units.delete(unit);
};
ModuleManager.prototype.isHeld = function(name) {
  if (this.units == null) return false;
  for (const unit of this.units) if (unit.names.has(name)) return true;
  return false;
};
// what a unit holds: a module's load acknowledged ('moduleload'), and the
// outcome of its registration, registered or refused
ModuleManager.prototype.unitLoaded = function(name) { this.unitNote(name, 'loaded'); };
ModuleManager.prototype.unitRegistration = function(name) { this.unitNote(name, 'registered'); };
ModuleManager.prototype.unitNote = function(name, set) {
  if (this.units == null) return;
  for (const unit of this.units) {
    if (!unit.names.has(name)) continue;
    unit[set].add(name);
    if (unit.changed != null) unit.changed();
  }
};

ModuleManager.prototype.startupDiscovery = function(names) {
  this.startupPending = (names.length > 0) ? new Set(names) : null;
};
ModuleManager.prototype.moduleDiscovered = function(name) {
  if (this.startupPending != null) {
    if (!this.startupPending.delete(name) || this.startupPending.size > 0) return;
    this.startupPending = null;
    this.startupRanks = null;
    this.noofLoadedModules = this.noofTotalModules;
  } else {
    // a unit in progress has its own pass, once whole
    if (this.isHeld(name)) return;
    this.noofLoadedModules ++;
    if (this.noofTotalModules > 0 && this.noofLoadedModules > this.noofTotalModules) this.noofLoadedModules = this.noofTotalModules;
    // `noofTotalModules === 0` is the bare-instance case: nothing was
    // preloaded, so each runtime load completes on its own (a module loaded
    // through countinghouse_load_module is verified, and can ctx.call, in an
    // --authoringTools setup that starts with none).
    if (this.noofTotalModules !== 0 && this.noofLoadedModules !== this.noofTotalModules) return;
  }
  LOG.I('all module discovered');
  this.emit('allmodulediscovered');
};

// This function is only run in main thread
// to load a local module specified by --loadModule CLI option
// or load all modules according to sqlite db info
// A loaded module's remote registered again (M4a, #427's high review, 7):
// a reload changed its allowance while keeping it at its version, so its
// remote takes the new allowance (or none: a revoke) now, from the
// package.json it is pinned at.
ModuleManager.prototype.reRegisterRemotes = function(name) {
  const wm = this.modules[name];
  if (wm == null) return;
  const pinned = this.manifestPins.pinnedOf(name);
  const version = (wm.packageInfo != null) ? wm.packageInfo.version : null;
  registerRemotes(name, wm.modulePath, version, pinned);
};

ModuleManager.prototype.loadAllModules = function() {
  const _this = this;
  const _mm   = this;

  // in case loading local module, we won't read module info from DB, instead read its info from package.json.
  // With no --loadModule and no --moduleRegistry (the registry is opt-in):
  // nothing to load, and discovery finishes at once below.
  if (!options.usesModuleRegistry()) {
    const info = options.localModulePath != null ? this.getModuleInfoFromPath(options.localModulePath) : [];
    if (info == null) return;

    this.noofTotalModules = info.length;
    this.startupDiscovery(info.map((item) => item.name));

    // A startup list with nothing in it still finishes discovering -- vacuously,
    // but genuinely. Without saying so, `allmodulediscovered` never fires at all
    // on a bare instance (both emit sites below are gated on
    // noofTotalModules > 0, and noofTotalModules only ever comes from this
    // list), which left two things broken for the --authoringTools workflow
    // that is *designed* to start with no modules:
    //   - DeviceManager.prototype.verifyComposition never ran, so a module
    //     loaded later via countinghouse_load_module was never bound and its
    //     every ctx.call refused with "no auth identity is bound" -- blaming an
    //     auth config that was correct.
    //   - allDevicesLoaded stayed false, and queryDeviceForChild only errors for
    //     an unknown device once it is true, so a call to a genuinely missing
    //     module queued until the request timeout instead of failing fast.
    // Emitting here puts a bare instance in the same state as every other one:
    // each later runtime load re-fires the event through the clamp below and
    // verifies whatever was just loaded.
    if (this.noofTotalModules === 0) {
      LOG.I('all module discovered');
      this.emit('allmodulediscovered');
      return;
    }

    // Several at once under --workerThread (the startup levers' (2)), each
    // handed on to registration in the list's order (lib/startup-order.js)
    const limit = startupLoadLimit(info);
    this.startupOrder = (limit > 1) ? new StartupOrder(info.map((item) => item.name)) : null;
    this.startupRanks = (limit > 1) ? new Map(info.map((item, i) => [item.name, i])) : null;
    async.eachLimit(info, limit, (item, cb) => {
      _this.loadModuleFromPath(item.path, item.name, item.version, (err, mi) => {
        LOG.I(`load local module from path: ${item.path}`);
        if (_this.startupOrder != null) {
          _this.startupOrder.finished(item.name);
          if (_this.startupOrder.done()) _this.startupOrder = null;
        }

        if (err != null) {
          LOG.E(err);
          // a failed load is discovered too, so discovery still ends
          _mm.moduleDiscovered(item.name);
        }
        return cb();
      });
    }, (e) => {

    });

    return;
  }

  if (options.workerThread !== true || isMainThread === true) {
    //do not require sqlite3 which contains native bindings in child thread
    const deviceDB = require('./device-db');
    deviceDB.getAllModuleInfo((err, data) => {
      if (err) {
        return LOG.E(new CountinghouseError('GET_MODULE_INFO_FAIL', err.message));
      }

      if (data == null) return;

      this.noofTotalModules = data.length;
      this.startupDiscovery(data.map((item) => item.name));

      if (this.noofTotalModules === 0) {
        // Same reasoning as the localModulePath branch above: zero modules is a
        // finished discovery, and saying so is what lets verifyComposition and
        // allDevicesLoaded behave on a bare instance.
        LOG.I('all module discovered');
        this.emit('allmodulediscovered');
      }

      async.eachSeries(data, (item, cb) => {
        _this.loadModuleFromPath(item.path, item.name, item.version, (err, mi) => {
          // a failed load is discovered too (moduleDiscovered), so discovery
          // still ends; a loaded one is, once its device is registered
          if (err != null) {
            LOG.E(err);
            _mm.moduleDiscovered(item.name);
          }
          return cb();
        });
      }, (err) => {
        // _this.noofTotalModules = _this.noofAvailableModules;
      });
    });
  }
};

// Resolve a module directory to a live module instance: api.json,
// schema.json and handlers/<service>/<action>.js (lib/module-layout.js). A
// main entry is never run; one with no handlers/ directory is refused.
//
// Shared deliberately. loadModuleFromPath and reloadModule each had their own
// copy of "load it and call new on it", and when the handler-map shape was
// added only the first learned about it -- so a migrated module loaded fine
// and then failed to reload with a 500. One resolver, both callers.
//
// Required lazily: countinghouse-util -> countinghouse-device -> session is a
// require cycle, and handler-map-module pulls in countinghouse-device too.
// Same technique session.js and device-manager.js already use.
ModuleManager.prototype.instantiateModule = function(modulePath, name) {
  // One module per worker (R2-1 Task 4), checked where every load path in a
  // worker meets (loadModuleFromPath, loadModuleCode, an in-worker reload):
  // a different module's code is never instantiated in it.
  if (isMainThread !== true) {
    if (workerModuleName != null && workerModuleName !== name) {
      throw new CountinghouseError('LOAD_MODULE_FAIL', name, `a worker runs one module, and this one runs ${workerModuleName}`);
    }
    workerModuleName = name;
  }
  const CHUtil           = require('./countinghouse-util');
  const handlerMapModule = require('./handler-map-module');

  const moduleRoot = require('./fs-broker/identity').pathFor(modulePath).resolve(modulePath);
  purgeRequireCache(moduleRoot);

  // (and the tools its declared text leaves unusable: the load's one
  // decision, marked on the spec assemble builds, as a worker's spawn marks
  // its own, #400)
  const layout = require('./module-layout').layoutRefusal(moduleRoot, name);
  if (layout != null) throw layout;
  const checked = require('./schema-safety').schemaChecked(moduleRoot, name);
  if (checked.refusal != null) throw checked.refusal;
  // Single-thread mode: every icon the module declares, read and checked
  // here (MCP completeness M2), kept on the instance its device holds, for
  // tools/list to inline. A worker's are read at its spawn
  // (lib/module-spec.js icons), so a worker reads none.
  const declaredIcons = (isMainThread === true) ? iconsAtLoad(moduleRoot, name) : null;

  const resolved = handlerMapModule.resolveHandlerMap(modulePath, (file) => CHUtil.loadFile(file));
  if (resolved == null) throw new CountinghouseError('INVALID_MODULE_PATH', modulePath);
  // One device, online at once on discover (whenDiscovered), on a first load
  // and on a reload alike.
  const instance = handlerMapModule.assemble(modulePath, name, resolved.handlerMap, resolved.source, {hiddenUnlisted: checked.hiddenUnlisted, spec: checked.spec});
  if (declaredIcons != null && instance != null) instance.declaredIcons = declaredIcons;
  return {instance: instance};
};

// A module's declared icons, read and checked (lib/declared-icons.js
// inline): the Map, or a throw that refuses the load. An api.json that
// cannot be read is left to the load to report.
function iconsAtLoad(moduleRoot, name) {
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'api.json'), 'utf8'));
  } catch (e) {
    return null;
  }
  const read = require('./declared-icons').inline(moduleRoot, spec);
  if (read.problem != null) throw new CountinghouseError('MODULE_ASSEMBLY_FAIL', name, `stage=icons -- ${read.problem}`);
  return read.icons;
}

// Drop every cached file under a module's directory, its own node_modules
// included, so the next require() reads the module's current code. This is
// what makes a reload in single-thread mode fresh; under --workerThread each
// load starts in a new worker whose cache is already empty.
function purgeRequireCache(moduleRoot) {
  const prefix = moduleRoot + path.sep;
  Object.keys(require.cache).forEach((file) => {
    if (file.startsWith(prefix)) delete require.cache[file];
  });
}

// --hardened: every module lives under --modulePath. Checked on the main
// thread at each way in (load, reload, restart) before anything is unloaded,
// and again at spawn; the worker re-runs loadModuleFromPath for a path the
// main thread already checked.
// 8.0.0: a load must use the module's own package.json name. The policy
// entry and (from part 2) the data directory are keyed by that name, so a
// request under another name must not borrow them. Every mode, and single-
// thread mode too. A package.json that cannot be read is left to the load
// itself to report.
function nameMismatch(modulePath, name) {
  let pkgName = null;
  try {
    pkgName = JSON.parse(fs.readFileSync(require('./fs-broker/identity').pathFor(String(modulePath)).join(String(modulePath), 'package.json'), 'utf8')).name;
  } catch (e) {
    return null;
  }
  if (typeof(pkgName) !== 'string' || pkgName === name) return null;
  return new CountinghouseError('MODULE_NAME_MISMATCH', name, pkgName);
}

// The one module format (lib/module-layout.js): a main entry with no
// handlers/ directory is refused before any of the module's code runs, on
// the main thread at each way in (load, reload, restart, spawn).
// What is refused from the module's files alone, before any of its code
// runs or its schema is compiled: the retired layout (lib/module-layout.js),
// and a schema.json that could stall or exhaust the main thread
// (lib/schema-safety.js). At every way in: a load, a spawn, a reload (before
// the loaded version is unloaded) and a restart.
// A module's own package.json that starts with a byte-order mark: refused
// at load, in every mode -- Node reads past one, JSON.parse and the
// runtime's own readers (its name, remotes, pins) don't, so the two would
// disagree on what the module is (the high review of #452). -> the error,
// or null
function bomRefusal(modulePath, name) {
  let head = null;
  try {
    const fd = fs.openSync(require('./fs-broker/identity').pathFor(String(modulePath)).join(String(modulePath), 'package.json'), 'r');
    try { head = Buffer.alloc(3); if (fs.readSync(fd, head, 0, 3, 0) < 3) head = null; } finally { fs.closeSync(fd); }
  } catch (e) { return null; }
  if (head == null || head[0] !== 0xEF || head[1] !== 0xBB || head[2] !== 0xBF) return null;
  return CountinghouseError.withFields('MODULE_PACKAGE_BOM', {name: String(name)});
}

// (bomChecked: the caller refused a byte-order mark itself, before it read
// the name)
function layoutRefused(modulePath, name, bomChecked) {
  const bom = bomChecked === true ? null : bomRefusal(modulePath, name);
  if (bom != null) { LOG.E(bom); return bom; }
  // In worker mode the main thread never walks a module's schema: the
  // spawn checks it in a validator (spawnModuleWorker). Here: single-thread
  // mode, where the module's own code runs on this thread anyway, and a
  // module's worker.
  const schemaHere = !(options.workerThread === true && isMainThread === true);
  // single-thread mode's icons (M2), checked here too, before a reload
  // unloads the version that serves; a worker's are checked at its spawn
  const iconsHere = isMainThread === true && options.workerThread !== true;
  let refusal = require('./module-layout').layoutRefusal(String(modulePath), name) || (schemaHere ? require('./schema-safety').schemaRefusal(String(modulePath), name) : null);
  if (refusal == null && iconsHere) {
    try { iconsAtLoad(String(modulePath), name); } catch (e) { refusal = e; }
  }
  if (refusal != null) LOG.E(refusal);
  return refusal;
}

function outsideHardenedRoot(modulePath) {
  if (options.hardened !== true || isMainThread !== true) return null;
  if (require('./hardened-launch').insideRoot(String(modulePath), options.modulePath)) return null;
  return new CountinghouseError('MODULE_PATH_OUTSIDE_ROOT', modulePath);
}

// deviceConfig: under --workerThread, the worker gets its device config in
// the load-module message (read by the main thread) instead of reading it.
// RC1-min: the module's remote MCP server (lib/remote/), registered on the
// main thread before its code runs: the notes logged, a bad declaration
// refusing the load. -> {refused: null or the refusal, failed(cb)}: failed
// wraps the load's callback so a load that fails after this point drops
// its own registration (and the credential it holds), never a newer one.
// M3: every name a credentials allowance in force reads a value from (the
// start's file: a pack's own file went with the pack form, M6), which
// resolveEnv never copies to a worker. Taken at each spawn: a worker keeps
// the environment it was given until its next spawn.
function credentialNamesNow() {
  return require('./remote/credentials').namesReadFrom();
}

// pkg: the package.json the spawn's pin takes (undefined: read from disk).
function registerRemotes(name, modulePath, version, pkg) {
  const remote = require('./remote');
  const opts = {version: version};
  if (pkg !== undefined) opts.pkg = pkg;
  const registered = remote.register(name, modulePath, opts);
  registered.notes.forEach((note) => LOG.I(`module remote: ${name}: ${note}`));
  const failed = (callback) => (err, ...rest) => {
    if (err != null) remote.unregister(name, registered.entries);
    return callback(err, ...rest);
  };
  if (registered.problems.length === 0) return {refused: null, failed: failed};
  const refused = new CountinghouseError('REMOTE_DECLARATION_INVALID', name, registered.problems.join('; '));
  LOG.E(refused);
  return {refused: refused, failed: failed};
}

// options: {deviceConfig} (a worker's, see loadModuleCode), {generation} (a
// reload's own, for loadModuleByWorker under --workerThread)
ModuleManager.prototype.loadModuleFromPath = function(modulePath, name, version, callback, {deviceConfig, generation = null} = {}) {
  // One module per worker (R2-1 Task 4): the peer path's argument rests on
  // it, since a channel's identity and declarations are the calling
  // worker's module's. Checked first, so module code that reaches this
  // manager through the worker's realm is refused before any path is read.
  // The name is held in this file's own scope (workerModuleName), not on
  // the manager, so module code that reaches the manager cannot clear it;
  // it is pinned once the load's own checks pass.
  if (isMainThread !== true && workerModuleName != null && workerModuleName !== name) {
    return callback(new CountinghouseError('LOAD_MODULE_FAIL', name, `a worker runs one module, and this one runs ${workerModuleName}`));
  }
  const outside = outsideHardenedRoot(modulePath);
  if (outside != null) return callback(outside);
  const mismatch = nameMismatch(modulePath, name);
  if (mismatch != null) return callback(mismatch);
  const layout = layoutRefused(modulePath, name);
  if (layout != null) return callback(layout);
  // Single-thread mode: module settings run only with worker threads (the
  // user's decision, 11-18). Decided first, from one read of package.json
  // from disk, before the state and settings checks below (which read what
  // a pin would take) and before anything of the module is set up (its
  // /tmp, the path facade, its remotes); the same object is what
  // loadModuleCode loads with, so the check and the load cannot disagree.
  // One read decides, and a read that fails stops the load here (never a
  // second read, never loadModuleCode without this one): a path that is no
  // string, or where there is no package.json, is INVALID_MODULE_PATH; one
  // that is there and cannot be read or parsed is LOAD_MODULE_FAIL, saying
  // why.
  let onDisk = null;
  if (isMainThread === true && options.workerThread !== true) {
    if (typeof(modulePath) !== 'string') return callback(new CountinghouseError('INVALID_MODULE_PATH', modulePath));
    try { onDisk = readPackageJson(modulePath); } catch (e) {
      if (e != null && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return callback(new CountinghouseError('INVALID_MODULE_PATH', modulePath));
      return callback(new CountinghouseError('LOAD_MODULE_FAIL', name, `its package.json could not be read (${(e && e.code) || 'not JSON'})`));
    }
    const refusedHere = singleThreadSettingsRefusal(name, onDisk);
    if (refusedHere != null) return callback(refusedHere);
  }
  // R1: its state declaration, and its settings declaration, from what an
  // operator's pin takes, before anything is unloaded or spawned
  // (lib/module-state.js, lib/module-settings.js)
  if (isMainThread === true) {
    const stateRefused = this.stateRefusal(modulePath, name);
    if (stateRefused != null) return callback(stateRefused);
  }
  if (options.workerThread === true && isMainThread === true) {
    return this.loadModuleByWorker(modulePath, name, version, (err, mi) => {
      // if (err) LOG.E(new CountinghouseError('LOAD_MODULE_FAIL', err.message));

      return callback(err, mi);
    }, {generation});
  }
  if (typeof(modulePath) !== 'string' || !fs.existsSync(modulePath)) return callback(new CountinghouseError('INVALID_MODULE_PATH', modulePath));

  // Single-thread (debug) mode: the module's data directories, /tmp emptied,
  // and the module registered with the path facade before its code loads
  // (part 2 spec, section 6). Worker mode does this in the main thread's spawn.
  if (isMainThread === true && options.workerThread !== true) {
    const moduleData = require('./module-data');
    // (a data or tmp from before ownership marks adopted where no module the
    // runtime knows, this one's own code included, overlaps it; a /tmp the
    // runtime did not make is kept, said once -- A-overlap-rm)
    const ownership = require('./data-ownership');
    const code = ownership.knownCode(this, options, [modulePath]);
    moduleData.ensureDirs(options.moduleDataPath, name)
      .then((dirs) => ownership.adoptWhereFree(dirs.root, dirs, options.moduleDataPath, code).then((marks) => ({dirs, marks})))
      .then(({dirs, marks}) => require('./fs-broker/spawn-walk').emptyTmp(dirs.tmp, {holder: dirs.root, base: options.moduleDataPath, marks, code, say: (text) => LOG.I(`module: ${name}: ${text}`)}).then(() => dirs))
      .then((dirs) => {
        require('./single-thread-facade').register(fs.realpathSync.native(modulePath), {name: name, data: dirs.data, tmp: dirs.tmp});
      })
      .then(() => {
        const remotes = registerRemotes(name, modulePath, version);
        if (remotes.refused != null) return callback(remotes.refused);
        return this.loadModuleCode(modulePath, name, version, remotes.failed(callback), deviceConfig, onDisk);
      },
        (e) => callback(new CountinghouseError('LOAD_MODULE_FAIL', name, `module data: ${e.message}`)));
    return;
  }
  return this.loadModuleCode(modulePath, name, version, callback, deviceConfig);
};

// The module's code, in this thread: single-thread mode, or a module worker.
// `given`: the package.json the caller read (single-thread mode's load: the
// object its settings check read), else read here.
ModuleManager.prototype.loadModuleCode = function(modulePath, name, version, callback, deviceConfig, given = null) {
  let moduleInstance = null;
  let packageInfo    = null;

  try {
    packageInfo = (given != null) ? given : readPackageJson(modulePath);
    moduleInstance = this.instantiateModule(modulePath, name).instance;
  } catch (e) {
    LOG.E(new CountinghouseError('LOAD_MODULE_FAIL', name, e.message, e.stack));
    return callback(e);
  }

  moduleInstance.on('deviceonline',  this.onDeviceOnline.bind(this, packageInfo, modulePath));  //append content of package.json and modulePath to module instance
  moduleInstance.on('deviceoffline', this.onDeviceOffline.bind(this));

  const configured = (err) => {
    if (err) LOG.E(new CountinghouseError('DEVICE_CONFIG_LOAD_FAIL', err.message));

    this.emit('moduleload', name, moduleInstance, version);
    return callback(null, moduleInstance);
  };
  if (isMainThread !== true && deviceConfig !== undefined) {
    getDeviceConfig.applyDeviceConfig(options, deviceConfig);
    return configured(null);
  }
  getDeviceConfig(options, name, configured);
};

// POST /uninstall-module (spec section 7): the module's data and registry
// entry, never its code. Refused while it is loaded, restarting or
// suspended; the deletion runs under the module's lifecycle lock, after the
// name's last broker settled, and never follows a link.
ModuleManager.prototype.uninstallModule = function(name, keepData, callback) {
  const moduleData = require('./module-data');
  const fsp = require('fs/promises');
  if (typeof(name) !== 'string' || !moduleData.safeName(name)) return callback(new CountinghouseError('MODULE_NAME_INVALID', String(name)));
  const busy = () => {
    const status = this.supervisor != null ? this.supervisor.status(name) : null;
    if (status != null) return status.state;
    // a per-session module's session workers, under name\0sid (R1), too
    return (this.modules[name] != null || this.lifecycle.live(name) != null || this.lifecycle.liveUnder(`${name}\0`) != null) ? 'loaded' : null;
  };
  const state = busy();
  if (state != null) return callback(new CountinghouseError('MODULE_LOADED', name, state));
  this.lifecycle.run(name, async () => {
    // Checked again inside the lock, before waiting: a load that won the lock
    // has a live worker, whose settle would never come while it runs.
    const now = busy();
    if (now != null) throw new CountinghouseError('MODULE_LOADED', name, now);
    await this.lifecycle.settled(name);   // a worker that exited: its broker finishing
    await this.lifecycle.settledUnder(`${name}\0`);   // and every session worker's (R1)
    // A local kv.json this process never saw whole (R-store-aside-locked):
    // its keys can't be purged, so refused here, before the registry or
    // anything else is touched (never a registry row gone, keys and data left)
    if (keepData !== true) {
      let blocked = null;
      try {
        const kv = require('./store').getStore().kv;
        if (kv != null && typeof(kv.unanswerable) === 'function') blocked = kv.unanswerable();
      } catch (e) { /* a store that can't be had: the purge below says so */ }
      if (blocked != null) throw new CountinghouseError('MODULE_STORE_CORRUPT');
    }
    // Every refusal before anything is removed: the data directory's own
    // checks (a <name>/ that is not a directory, a link on the way down to it)
    // are read here first, and made again where it is deleted below, where a
    // link swapped in between is refused. Only a <name>/ that isn't there
    // (ENOENT, ENOTDIR) is no directory to remove; one that can't be read, or
    // whose sessions/ can't be listed, or where the ownership marker can't be
    // written (checked without writing) is refused here too, by its errno
    // code alone, while nothing has been removed.
    if (keepData !== true) {
      const early = moduleData.dirsFor(options.moduleDataPath, name).root;
      // (its errno code alone; the answer goes only to the operator's admin route)
      const unreadable = (at, e) => CountinghouseError.withFields('MODULE_DATA_UNREADABLE', {path: at, code: (e != null && typeof(e.code) === 'string' && /^E[A-Z0-9_]+$/.test(e.code)) ? e.code : 'UNKNOWN'}, name);
      let est = null;
      try { est = await fsp.lstat(early); } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw unreadable(early, e);
      }
      if (est != null) {
        if (!est.isDirectory()) throw new CountinghouseError('MODULE_DATA_NOT_DIRECTORY', name, early);
        const ebad = await moduleData.notRealBelow(options.moduleDataPath, early, {missing: 'refuse'});
        // (gone since the lstat: nothing to check; an error with no code: UNKNOWN)
        if (ebad != null && ebad.why !== 'missing') {
          if (ebad.why !== 'a link' && ebad.why !== 'not a directory' && ebad.why !== 'outside') throw unreadable(ebad.path, {code: ebad.why});
          throw new CountinghouseError('MODULE_DATA_NOT_DIRECTORY', name, ebad.path);
        }
        // (what the removal will need, checked without writing, and only
        // where it will remove something: a <name>/ it can't list can't be
        // judged, so it is refused; then if anything there is the runtime's
        // -- a data or tmp its marker names, one it would adopt (at its
        // expected path, no module code in it), a session partition -- it
        // must be able to read and write in <name>/, in its parent (<name>/'s
        // own rmdir), in each of those and in sessions/. A <name>/ holding
        // only what isn't the runtime's is kept, named in `kept`, as ever:
        // no write is needed to keep it)
        const fsc = require('fs').constants;
        if (ebad == null) {
          await fsp.access(early, fsc.R_OK | fsc.X_OK).catch((e) => { throw unreadable(early, e); });
          const ownership = require('./data-ownership');
          const dirs = moduleData.dirsFor(options.moduleDataPath, name);
          const code = ownership.knownCode(this, options);
          let marks;
          try { marks = await ownership.readMarker(early, options.moduleDataPath); } catch (e) { throw unreadable(early, e); }
          const removing = [];
          for (const which of ['data', 'tmp']) {
            const at = dirs[which];
            const atSt = await fsp.lstat(at).catch(() => null);
            if (atSt == null || !atSt.isDirectory()) continue;
            let ours = marks[which] != null;
            if (!ours) {
              try { ours = (await ownership.atExpectedPath(at, options.moduleDataPath)) && !(await ownership.codeInside(at, code)); } catch (e) { throw unreadable(at, e); }
            }
            if (ours) removing.push(at);
          }
          const sessions = path.join(early, 'sessions');
          const sst = await fsp.lstat(sessions).catch(() => null);
          if (sst != null && sst.isDirectory()) {
            await fsp.access(sessions, fsc.R_OK | fsc.X_OK).catch((e) => { throw unreadable(sessions, e); });
            const ids = await fsp.readdir(sessions).catch((e) => { throw unreadable(sessions, e); });
            if (ids.some((id) => require('./session-partition').SESSION_ID.test(id))) removing.push(sessions);
          }
          if (removing.length > 0) {
            await fsp.access(early, fsc.W_OK).catch((e) => { throw unreadable(early, e); });
            await fsp.access(path.dirname(early), fsc.W_OK | fsc.X_OK).catch((e) => { throw unreadable(path.dirname(early), e); });
            for (const at of removing) await fsp.access(at, fsc.R_OK | fsc.W_OK | fsc.X_OK).catch((e) => { throw unreadable(at, e); });
          }
        }
      }
    }
    let dataDeleted = false;
    let keysDeleted = null;   // null: kept (keepData)
    const kept = [];   // what the runtime did not make, so did not remove
    let kv = null;   // (the store's kv, for the session partitions' removal below too)
    if (keepData !== true) {
      // Its ctx.redis keys (m:<name>:*, #164) go with its data, so a later
      // module of the same name inherits none; a reload or an upgrade keeps
      // them (they never come here). First of what is removed: a store that
      // cannot be reached leaves the registry row and the data directory as
      // they were.
      const ns = require('./redis-namespace');
      try {
        kv = require('./store').getStore().kv;
        keysDeleted = await ns.purgeNamespace(kv, ns.prefixFor(name));
        // and every session partition's keys, ms:<name>:* (R1, section 4a); its
        // files are under <name>/sessions/, which the directory's removal below takes
        const sessions = ns.sessionsPrefixFor(name);
        if (sessions != null) keysDeleted += await ns.purgeNamespace(kv, sessions);
      } catch (e) {
        // (the store's error code alone: never its message, which can name a key)
        const code = (e != null && typeof(e.code) === 'string' && /^[A-Z][A-Z0-9_]*$/.test(e.code)) ? e.code : 'ERROR';
        throw CountinghouseError.withFields('MODULE_KEYS_NOT_PURGED', {code}, name);
      }
    }
    // Then the registry row (used only with --moduleRegistry and no
    // --loadModule): after the keys, so a store that can't be reached removes
    // nothing (the row would otherwise go first and leave the keys and the
    // data to a later module of the same name); if this fails, the data
    // directory is still there and the error says what went.
    let registryEntryRemoved = false;
    if (options.usesModuleRegistry()) {
      registryEntryRemoved = await new Promise((resolve, reject) => require('./device-db').removeModuleInfo(name, function(e) {
        // sqlite3 calls back with the statement as `this`: changes is the number of rows removed
        // (the registry's own message goes to the log, never into the answer)
        if (e) {
          LOG.W(`module: ${name}: its registry entry was not removed: ${e.message}`);
          return reject(new CountinghouseError('REMOVE_MODULE_INFO_FAIL', name));
        }
        return resolve(this != null && this.changes > 0);
      }));
    }
    // Once the keys and the registry row are gone, the uninstall has gone
    // ahead: no restart will want its last settings, and its session workers'
    // late messages are dropped (an uninstall refused before this keeps both)
    if (this.lastSettings != null) this.lastSettings.delete(name);
    if (typeof(this.lifecycle.forgetLateUnder) === 'function') this.lifecycle.forgetLateUnder(`${name}\0`);
    if (keepData !== true) {
      // Never <name>/ removed recursively (A-overlap-rm): its data and tmp
      // each only when the runtime made it (lib/data-ownership.js), each
      // session's partition likewise, then the directories once empty. What
      // the runtime did not make is kept, said once, and named in `kept`:
      // paths under --moduleDataPath, never a session's id.
      const d = moduleData.dirsFor(options.moduleDataPath, name);
      const root = d.root;
      // The keys and the registry row are gone by now: a failure from here on
      // (a marker write on a full or read-only disk, a session partition's
      // removal, a directory that can't be read at the delete) is
      // MODULE_DATA_NOT_REMOVED, naming the directory and the errno code
      // alone, with the error itself in the log; a refusal of its own
      // (MODULE_DATA_NOT_DIRECTORY: a link swapped in) passes as it is. A
      // second uninstall finishes: its purge is a no-op, a missing row is
      // no error, and this step runs again.
      // (the log line never names a session: its id is cut from the message)
      const notRemoved = (e, at = root) => {
        // (a file's name in an fs message is the module's: escaped, so it
        // can't write a line of its own into the log)
        const said = JSON.stringify(String(e != null && e.message != null ? e.message : e).replace(/(sessions[\\/])[0-9a-f]{32}/g, '$1<a session>'));
        LOG.W(`module: ${name}: its data directory was not removed: ${said}`);
        const code = (e != null && typeof(e.code) === 'string' && /^E[A-Z0-9_]+$/.test(e.code)) ? e.code : 'UNKNOWN';
        return CountinghouseError.withFields('MODULE_DATA_NOT_REMOVED', {path: at, code}, name);
      };
      try {
        let st = null;
        try { st = await fsp.lstat(root); } catch (e) {
          if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw notRemoved(e);
        }
        if (st != null) {
          if (!st.isDirectory()) throw new CountinghouseError('MODULE_DATA_NOT_DIRECTORY', name, root);
          // every directory from the data root down to <name>/ a real one: an
          // @scope that is a link is refused, nothing under it touched (the
          // reviewer's high on #467, round 3, 1); one that can't be read is
          // not removed
          const bad = await moduleData.notRealBelow(options.moduleDataPath, root, {missing: 'refuse'});
          if (bad != null && bad.why !== 'a link' && bad.why !== 'not a directory' && bad.why !== 'outside' && bad.why !== 'missing') throw notRemoved({code: bad.why, message: `${bad.path}: ${bad.why}`}, bad.path);
          if (bad != null && bad.why !== 'missing') throw new CountinghouseError('MODULE_DATA_NOT_DIRECTORY', name, bad.path);
          // (gone since its lstat -- removed by hand meanwhile: nothing to remove)
          if (bad != null) st = null;
        }
        if (st != null) {
          const say = (text) => LOG.I(`module: ${name}: ${text}`);
          const ownership = require('./data-ownership');
          // (an existing install's, adopted first where no module code the
          // runtime knows is in or around it; and none removed that holds
          // some: the medium on A-overlap-rm, 2 and 5)
          const code = ownership.knownCode(this, options);
          const marks = await ownership.adoptWhereFree(root, d, options.moduleDataPath, code);
          kept.push(...await ownership.removeOwned(root, d, options.moduleDataPath, say, code, marks));
          // each session's partition by session-partition's own remove (its
          // checks, adoption and removal; its keys went above, so again is a
          // no-op): no hand loop here (the high's round 3, 1). An entry that is
          // no session's, and anything at sessions/ that isn't a directory,
          // is kept and said.
          const sessions = path.join(root, 'sessions');
          let sst = null;
          try { sst = await fsp.lstat(sessions); } catch (e) {
            if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
          }
          let sessionKept = false;
          if (sst != null && !sst.isDirectory()) {
            ownership.keptSaid({state: 'foreign'}, sessions, 'removed', say);
            sessionKept = true;
          } else if (sst != null) {
            const partition = require('./session-partition');
            for (const id of await fsp.readdir(sessions)) {
              if (!partition.SESSION_ID.test(id)) {
                // (no session's: kept, and said: the medium on the high's round 3, 5)
                ownership.keptSaid({state: 'foreign'}, path.join(sessions, id), 'removed', say);
                sessionKept = true;
                continue;
              }
              const r = await partition.remove(options.moduleDataPath, kv, name, id, {adopt: true, code, say, keys: false});
              if (r.kept.length > 0) sessionKept = true;
            }
            // (kept only when something is still in it; any other failure is the removal's)
            if (!sessionKept) {
              await fsp.rmdir(sessions).catch((e) => {
                if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') { sessionKept = true; return; }
                if (e.code !== 'ENOENT') throw e;
              });
            }
          }
          if (sessionKept) kept.push(sessions);
          // (<name>/ kept only when something is still in it; any other
          // failure of its rmdir -- a read-only disk, a parent made unwritable
          // -- is the removal's)
          await fsp.rmdir(root).catch((e) => {
            if (e.code === 'ENOENT') return;
            if (e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST') throw e;
            if (kept.length === 0) kept.push(root);
          });
          dataDeleted = await fsp.lstat(root).then(() => false, (e) => e.code === 'ENOENT' || e.code === 'ENOTDIR');
          // A scoped name leaves <store>/@scope behind: remove it when empty (review M2).
          if (dataDeleted && name.startsWith('@')) await fsp.rmdir(path.dirname(root)).catch(() => {});
        }
      } catch (e) {
        if (e instanceof CountinghouseError) throw e;
        // (a session partition's own link refusal: the link refusal it is)
        if (e != null && typeof(e.notRealPath) === 'string') throw new CountinghouseError('MODULE_DATA_NOT_DIRECTORY', name, path.resolve(options.moduleDataPath, e.notRealPath));
        throw notRemoved(e);
      }
    }
    return {name: name, dataDeleted: dataDeleted, keysDeleted: keysDeleted, registryEntryRemoved: registryEntryRemoved, kept: kept};
  }).then((r) => callback(null, r), (e) => callback(e));
};

// this call always run in main thread
//
// Loading a module that is already loaded restarts it: the old worker is
// unloaded and terminated, and the module starts again in a new one. There is
// no in-place reload. A reused worker keeps its require cache, its globals and
// whatever timers or sockets the old code left open, so an in-place reload
// ran a mix of new and old code; a new worker has none of that.
// countinghouse_validate_module under audit and enforce (review R1-4; user
// decision, 2026-11-04): the validator requires the module's code, so it runs
// in a worker set up exactly as a load of that module would be (its policy,
// declared env, limits, --hardened root, file namespace and lockdown), then
// the worker is discarded. It gets no main-thread services: the device
// manager never sees it, and any message but the validator's reply is
// refused. Its data directory is a throwaway under <moduleDataPath>/.validate
// (not a possible npm name, so never a live module's), removed afterwards,
// and at most VALIDATE_MAX run at once. The result describes the module; the
// module runs beside the validator and can fool it, so nothing gates on it.
const VALIDATE_MAX = 2;
let validating = 0;
const validateRoot = () => path.join(options.moduleDataPath, '.validate');

// A crash mid-validation leaves its throwaway directory behind: cleared at
// startup, never following a link. Not under the ownership rule for
// recursive deletes (lib/data-ownership.js; the reviewer, A-overlap-rm): a
// fresh directory the runtime makes under a dot name no module's name can
// take, and this sweep only ever touches that one.
ModuleManager.prototype.sweepValidateRoot = function() {
  const root = validateRoot();
  let st = null;
  try { st = fs.lstatSync(root); } catch (e) { return; }
  try {
    if (!st.isDirectory()) return fs.unlinkSync(root);
    fs.rmSync(root, {recursive: true, force: true});
  } catch (e) {
    LOG.E(new Error(`validate: could not clear ${root}: ${e.message}`));
  }
};

// A test's record of what the runtime loads in a module's worker after its
// lockdown (#194's PR 1, test/sandbox/66), and its hand-over of the
// runtime's modules to the test's fixtures (its PR 2): only when the
// operator started this process with --testLateLoads, never in a normal
// start, and never under --hardened (it hands module code what the
// lockdown seals away; framework.js refuses the two together); said once
// when it is on.
let lateLoadProbeSaid = false;
const lateLoadProbe = () => {
  if (options.testLateLoads !== true || options.hardened === true) return false;
  if (!lateLoadProbeSaid) {
    lateLoadProbeSaid = true;
    LOG.W('module sandbox: the test-only late-load probe is on (--testLateLoads): it hands module code the runtime\'s modules; never use it outside a test');
  }
  return true;
};

// A spawn's entry, its own: added when its walk begins, retired when it
// answers.
ModuleManager.prototype.addSpawning = function(name, token, p) {
  if (!(this.spawningModules instanceof Map)) return;
  let mine = this.spawningModules.get(name);
  if (mine == null) { mine = new Map(); this.spawningModules.set(name, mine); }
  mine.set(token, p);
};
ModuleManager.prototype.retireSpawning = function(name, token) {
  if (!(this.spawningModules instanceof Map)) return;
  const mine = this.spawningModules.get(name);
  if (mine == null) return;
  mine.delete(token);
  if (mine.size === 0) this.spawningModules.delete(name);
};

// Every module root the manager knows -- a loaded module's, a supervised
// one's, a session module's -- for the file broker's overlap judgement
// (the reviewer's ruling on #452: the runtime's own list, no layout
// guessing).
// -> [{name, root}], each once, as a host path (a relative one against the
// working directory, as the spawn resolves it)
ModuleManager.prototype.knownModuleRoots = function() {
  const known = [];
  const seen = new Set();
  const add = (name, p) => {
    if (typeof(p) !== 'string' || p === '') return;
    const root = path.resolve(p);
    const key = `${name}\0${root}`;
    if (!seen.has(key)) { seen.add(key); known.push({name: typeof(name) === 'string' ? name : null, root}); }
  };
  // (and, at boot, every module the start plan will load, before each has)
  const plan = Array.isArray(this.startLoad) ? this.startLoad : [];
  for (const item of plan) if (item != null) add(item.name, item.path);
  for (const [name, m] of Object.entries(this.modules || {})) {
    if (m == null) continue;
    add(name, m.modulePath);
    add(name, m.hostModulePath);
  }
  const records = this.supervisor != null && this.supervisor.records != null ? Object.entries(this.supervisor.records) : [];
  for (const [name, r] of records) if (r != null) add(name, r.modulePath);
  // (and every module whose spawn has begun, its load not yet confirmed)
  if (this.spawningModules instanceof Map) for (const [name, mine] of this.spawningModules) for (const p of mine.values()) add(name, p);
  return known;
};

ModuleManager.prototype.validateModuleSandboxed = function(modulePath, timeoutMs, callback) {
  const resolved = path.resolve(String(modulePath));
  const shown = path.basename(resolved);
  const failed = (stage, message) => callback(null, {ok: false, module: shown, problems: [{stage: stage, module: shown, message: message, fix: null}]});
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return callback(new Error(`${resolved} is not a directory`));
  const outside = outsideHardenedRoot(resolved);
  if (outside != null) return failed('validateModuleSandbox', outside.message);
  if (validating >= VALIDATE_MAX) {
    return failed('validateModuleSandbox', `the server is busy: ${VALIDATE_MAX} validations are already running; try again shortly`);
  }
  // The package.json name picks the module's policy entry, as for a load.
  let pkgName = null;
  try { pkgName = JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf8')).name; } catch (e) { pkgName = null; }
  const name = (typeof(pkgName) === 'string' && require('./module-data').safeName(pkgName)) ? pkgName : 'validate';
  let sandbox = null;
  try {
    sandbox = moduleSandboxConfig.build(resolved, name, {mode: options.moduleSandbox, modulePolicy: options.modulePolicy, serverEnv: process.env, redisUrl: options.redisUrl,
      credentialNames: credentialNamesNow()});
  } catch (e) {
    return failed('validateModuleSandbox', e.message);
  }
  if (sandbox != null && sandbox.refusal != null && options.moduleSandbox === 'enforce') {
    return failed('validateModuleSandbox', `refused under enforce, the module's code was not run: ${sandbox.refusal}`);
  }

  // The validation runs the module's code: its package.json is pinned first,
  // and the operator's load of this path that follows takes that copy
  // (Task 4's re-review, 1).
  this.manifestPins.forValidation(resolved);
  validating++;
  const tmpRoot = path.join(validateRoot(), require('crypto').randomBytes(8).toString('hex'));
  let fsb = null;
  let worker = null;
  let answered = false;
  let timer = null;
  const finish = (err, result) => {
    if (answered) return;
    answered = true;
    clearTimeout(timer);
    // terminate() resolves whether the worker is still running or has already
    // ended; a worker that ended itself emits 'exit' only once, inside which
    // this can run, so waiting for another 'exit' would never finish (review R1-4a).
    const exited = (worker != null) ? worker.terminate().then(() => {}, () => {}) : Promise.resolve();
    // The same teardown as a worker's end: the bridge closed, the broker
    // idle (its descriptors and scheduler slots released), then the data.
    const settled = (fsb != null)
      ? require('./module-lifecycle').settleAfterExit({exited: exited, closeBridge: () => fsb.bridge.close(), broker: fsb.broker,
        name: `validate ${shown}`, log: (line) => LOG.E(new Error(line))})
      : exited;
    // The answer waits for the teardown, so a caller who sends its next
    // validation the moment this one answers finds the slot free and the
    // throwaway directory gone. The slot is released however the teardown
    // ends; settleAfterExit bounds a broker that never goes idle
    // (IDLE_BOUND_MS), as at a module worker's end.
    Promise.resolve(settled).catch(() => {}).then(() => {
      try { fs.rmSync(tmpRoot, {recursive: true, force: true}); } catch (e) { LOG.E(new Error(`validate: could not remove ${tmpRoot}: ${e.message}`)); }
    }).finally(() => {
      validating--;
      // Outside the promise chain, so a callback that throws crashes as a
      // plain throw, as it did when the answer came first.
      setImmediate(() => (err != null ? callback(err) : callback(null, result)));
    });
  };

  require('./fs-broker').createForWorker({name: name, mode: options.moduleSandbox, modulePath: resolved,
    declared: sandbox != null ? sandbox.fs : [], options: Object.assign(Object.create(options), {moduleDataPath: tmpRoot}),
    pinsDir: path.join(options.moduleDataPath, RECORD_DIR), knownModules: this.knownModuleRoots(), knownDataPath: options.moduleDataPath,
    limits: sandbox != null ? sandbox.limits : null, report: (rule, target) => LOG.I(`validate: ${shown} file ${rule} ${target}`)
  }).then((created) => {
    fsb = created;
    const workerOptions = Object.assign({}, sandbox != null ? sandbox.workerOptions : {},
      {workerData: {fsBridge: fsb.bridge.transfer, moduleRoot: fsb.moduleRoot, installDir: fsb.installDir, codeRoots: fsb.codeRoots, lateRoots: fsb.lateRoots, installSpellings: fsb.installSpellings,
        virtualDrive: require('./fs-broker/virtual-drive').pick(),
        validateOnly: true, lateLoadProbe: lateLoadProbe()}, transferList: fsb.bridge.transferList});
    worker = outsideRequest(() => new Worker(leanWorkerEntry(), workerOptions));
    const wm = new WorkerMessage(worker);
    // (a session's worker: budgeted from its first message, F4-4)
    wm.byteBudgeted = true;
    // the name the lockdown charges its lines for, so the two budgets agree
    wm.logName = (sandbox != null && sandbox.lockdown != null) ? sandbox.lockdown.moduleName : shown;
    worker.once('exit', () => require('./worker-output').end(wm));
    fsb.bridge.setOnViolation((why) => wm.endForMessage(`file bridge: ${why}`));
    // Nothing the main thread serves is open to it: refused, by name, in the log.
    // wm decodes each message once (#170) and ends a worker whose message is not an envelope
    wm.onDecoded = (msg) => {
      // a violation, its log and its module's output are handled as from any worker
      if (msg == null || msg.category !== 'child' || ['sandbox-violation', 'log', 'stdout', 'stderr'].includes(msg.command)) return;
      LOG.I(`validate: refused ${String(msg.command).slice(0, 64)} from the worker validating ${shown}`);
      if (msg.id != null) worker.postMessage({command: 'refused-reply', msgID: msg.id, errMsg: 'a validation has no main-thread services', errCode: 'VALIDATE_REFUSED'});
    };
    if (sandbox != null) {
      wm.messageRate = options.moduleMessageRate;
      wm.rateTokens  = options.moduleMessageRate;
    }
    worker.on('error', (e) => finish(null, {ok: false, module: shown, problems: [{stage: 'validateModuleSandbox', module: shown,
      message: `the module ended its validation: ${e.message}`, fix: 'Check the module\'s handler files for anything that throws, exits or runs away while being required.'}]}));
    worker.on('exit', (code) => finish(null, {ok: false, module: shown, problems: [{stage: 'validateModuleSandbox', module: shown,
      message: `the module ended its validation (exit code ${code})`, fix: 'Check the module\'s handler files for a process.exit() call.'}]}));
    timer = setTimeout(() => finish(null, {ok: false, module: shown, problems: [{stage: 'validateModuleSandbox', module: shown,
      message: `the validation did not finish within ${timeoutMs} ms`, fix: 'Check the module\'s handler files for an infinite loop or a wait that never ends.'}]}), timeoutMs);
    wm.sendSetOptionsMessage({options: options.getOptionsForWorker(), sandbox: sandbox != null ? sandbox.lockdown : null}, (err) => {
      if (err) return finish(null, {ok: false, module: shown, problems: [{stage: 'validateModuleSandbox', module: shown, message: err.message, fix: null}]});
      // a validation runs the module's code too: told the Redis host name's
      // addresses as a module's worker is (#207)
      if (sandbox != null) moduleSandboxConfig.trackWorker(wm, worker, options.redisUrl);
      if (sandbox != null && sandbox.limits != null) workerLimits.watch(worker, wm, sandbox.limits, {busy: () => fsb.bridge.syncInFlight() > 0});
      wm.sendValidateModuleMessage({}, (vErr, result) => finish(vErr, result));
    });
  }).catch((e) => finish(null, {ok: false, module: shown, problems: [{stage: 'validateModuleSandbox', module: shown, message: `file broker: ${e.message}`, fix: null}]}));
};

// Operator actions on one name -- a load, reload, restart or unload -- are
// counted, and the latest is the one in force. A reload still bringing its
// worker up when the next action arrives is superseded: its worker is ended
// (by the lifecycle lock when the next spawn takes its turn, or by the
// unload), its caller is told MODULE_LOAD_SUPERSEDED, and it settles nothing.
// R1 (lib/module-state.js): the refusal an operator's load, reload or restart
// of `name` from `modulePath` gets for its state declaration, or null: a value
// that is neither "shared" nor "per-session", a per-session module on the HTTP
// profile, or, for a module loaded (or recorded by its supervisor) now, a
// state that differs from the one it was pinned with. Checked before anything
// is unloaded, so a refused one leaves the loaded module serving.
// The net a module's worker is granted: its declaration as the operator's
// policy narrows it, as the spawn's sandbox build narrows it
// (lib/module-sandbox-config.js: a policy that cannot be read is an empty one
// there too), without that build's tree walk; with the sandbox off, its
// declared net.
function grantedNet(name, pkg) {
  const declared = modulePermissions.parseDeclaration(pkg).declared;
  if (options.moduleSandbox === 'off') return declared.net;
  let policy = require('./module-policy').EMPTY;
  if (options.modulePolicy != null) {
    try { policy = require('./module-policy').load(options.modulePolicy); } catch (e) { policy = require('./module-policy').EMPTY; }
  }
  const key = (pkg != null && typeof(pkg.name) === 'string') ? pkg.name : name;
  const entry = (policy.modules[key] != null) ? policy.modules[key] : null;
  return modulePermissions.narrow(declared, entry, policy.limits, options.moduleSandbox).net;
}

ModuleManager.prototype.stateRefusal = function(modulePath, name) {
  const next = this.manifestPins.wouldPin(modulePath, name);
  const problem = moduleState.stateProblem(next, name, options);
  if (problem != null) return problem;
  // its settings (lib/module-settings.js), from the same file: the
  // declaration, and what refuses the values (a source that cannot be read,
  // a required setting --moduleSettings leaves unset), against the net the
  // spawn will grant (the policy's narrowing), so a refusal always comes
  // before anything is unloaded
  if (moduleSettings.declaresSettings(next)) {
    const settingsProblem = moduleSettings.stateFor(name, next, {dryRun: true, operator: true, net: grantedNet(name, next), ceiling: settingsCeiling()}).refused;
    if (settingsProblem != null) return settingsProblem;
  }
  const loaded = this.manifestPins.pinnedOf(name);
  const running = this.modules[name] != null || (this.supervisor != null && this.supervisor.recorded(name) != null);
  return (running && loaded != null) ? moduleState.stateChanged(loaded, next, name) : null;
};

ModuleManager.prototype.nextGeneration = function(name) {
  this.generations[name] = (this.generations[name] || 0) + 1;
  return this.generations[name];
};

// Why a lean worker's load acknowledgement ({loaded, deviceID, names}) does
// not match the main thread's own spec (lib/module-spec.js), or null. A spec
// the main thread could not read registers nothing anyway (registerFromSpec).
function loadAckMismatch(own, ack) {
  if (own == null || own.error != null || own.names == null) return null;
  if (ack == null || ack.loaded !== true || !Array.isArray(ack.names)) return 'no load acknowledgement';
  if (ack.deviceID !== own.deviceID) return `device ${String(ack.deviceID).slice(0, 64)}, not ${own.deviceID}`;
  const declared = [];
  for (const serviceID of Object.keys(own.names)) for (const action of own.names[serviceID]) declared.push(`${serviceID}|${action}`);
  // A handler file can post the acknowledgement itself while it loads, with
  // any names (#177's re-review, item 1): more than api.json declares is
  // refused before any is compared, and the rest is one pass over Sets.
  if (ack.names.length > declared.length) return `more names (${ack.names.length}) than api.json declares (${declared.length})`;
  const want = new Set(declared);
  const got = new Set();
  for (const n of ack.names) got.add(String(n));
  const missing = declared.filter((n) => !got.has(n));
  if (missing.length > 0) return `no handler loaded for ${missing.slice(0, 5).join(', ')}`;
  const extra = [];
  for (const n of got) { if (!want.has(n)) { extra.push(n); if (extra.length === 5) break; } }
  if (extra.length > 0) return `actions api.json does not declare: ${extra.join(', ')}`;
  return null;
}
ModuleManager.loadAckMismatch = loadAckMismatch;
// what a reloading device's record keeps (markEndedDevices): its module's
// device specs and package.json as loaded
function keptOf(m, name) {
  // (a record with no module path, a per-session one, keeps none: never a
  // bare {name} stub ahead of the supervisor's own)
  const packageInfo = m.packageInfo != null ? m.packageInfo
    : (m.hostModulePath != null ? require('./device-manager').pinnedPackageInfo(m, {name: name}) : null);
  return {specs: m.deviceList || {}, packageInfo: packageInfo || null};
}

ModuleManager.declaredDeviceIDs = declaredDeviceIDs;

// generation: a reload's own (lib/modules-in-place.js replaceDrainThenSwitch),
// taken before its drain; the spawn holds that one instead of taking its own,
// so an operator action since (an unload, a restart) supersedes it
// (MODULE_LOAD_SUPERSEDED: the Reviewer's high review of #441, 3)
ModuleManager.prototype.loadModuleByWorker = function(modulePath, name, version, callback, {generation = null} = {}) {
  if (generation != null && this.generations[name] !== generation) return callback(new CountinghouseError('MODULE_LOAD_SUPERSEDED', name));
  this.keepRetainedForReload(name);
  if (this.supervisor != null) this.supervisor.clear(name);
  const gen = generation != null ? generation : this.nextGeneration(name);
  const current = () => this.generations[name] === gen;
  // A load that fails leaves a reload's devices unloaded. One that succeeds
  // clears nothing yet: each device's entry goes when the device comes back
  // online, and once discovery is over any left (a device the new code no
  // longer has) are unloaded (onModuleLoad). A superseded load settles
  // nothing: the action that superseded it decides.
  const settle = (err, data) => {
    this.spawnsPending[name] = (this.spawnsPending[name] || 1) - 1;
    if (!current()) return callback(new CountinghouseError('MODULE_LOAD_SUPERSEDED', name));
    // (held while a unit's switch may roll it back: replaceDrainThenSwitch)
    if (err != null && !(this.settleHeld instanceof Set && this.settleHeld.has(name))) this.settleEndedDevices(name);
    return callback(err, data);
  };
  const spawn = () => {
    this.spawnsPending[name] = (this.spawnsPending[name] || 0) + 1;
    if (!current()) return settle();
    this.spawnModuleWorker(modulePath, name, version, settle, current, true);
  };
  if (this.modules[name] == null) return spawn();

  this.unloadModuleExternal(name, spawn, 'reload');
};

// A reloading device's record keeps its spec and its module's package.json
// (kept: {specs: {deviceID: spec}, packageInfo}), so its tools stay listed,
// by the names they had, until that device registers again
// (clearEndedDevice) or the reload ends without it (settleEndedDevices):
// DeviceManager getAllDeviceSpecs, packageOfModule and keepsDecision read
// it (stdio 39 on macOS: every reload path left a window of "unknown tool";
// the Reviewer's high review of #435). A record marked again keeps what it
// had where the new mark has nothing for that device.
// The records indexed by module (byModule: name -> Set of ids) and the ids
// reloading with a kept spec (reloading), so no reader walks a list that
// only grows (the high review of #435's medium round, 7); created on first
// use, for a module manager a test builds by hand too.
function indexOf(mm) {
  if (mm.endedIndex == null) mm.endedIndex = {byModule: new Map(), reloading: new Set()};
  return mm.endedIndex;
}
function unindex(mm, id) {
  const ix = indexOf(mm);
  const prev = mm.endedDevices[id];
  if (prev != null && ix.byModule.has(prev.name)) {
    ix.byModule.get(prev.name).delete(id);
    if (ix.byModule.get(prev.name).size === 0) ix.byModule.delete(prev.name);
  }
  ix.reloading.delete(id);
}
// settled (MODULE_UNLOADED) records kept to answer MODULE_UNLOADED for a
// device gone: at most this many, the oldest dropped first (insertion
// order), never one just marked or settled (`keep`)
const MAX_SETTLED_RECORDS = 4096;
function capSettled(mm, keep) {
  let over = Object.keys(mm.endedDevices).length - MAX_SETTLED_RECORDS;
  if (over <= 0) return;
  for (const id of Object.keys(mm.endedDevices)) {
    if (over <= 0) break;
    if (mm.endedDevices[id].code !== 'MODULE_UNLOADED' || keep.has(id)) continue;
    unindex(mm, id);
    delete mm.endedDevices[id];
    over -= 1;
  }
}
const isKeptReloading = (e) => e != null && e.code === 'MODULE_RELOADING' && e.spec != null;
ModuleManager.isKeptReloading = isKeptReloading;
ModuleManager.keptOf = (m, name) => keptOf(m, name);

// The device specs an unexpectedly exited worker leaves with the supervisor
// (its exit handler, startWorker). A restarted worker that exits before its
// devices are back still has them: the ones still marked ended carry over
// from the previous exit, so they stay listed and answer the supervisor's
// state (#9). A reload's new worker that exits before its devices
// registered: the devices still reloading go with this exit, kept by the
// supervisor from here (restarting, then suspended if it gives up), never
// left listed as reloading (6). Then the worker's own registered devices.
ModuleManager.prototype.specsAtExit = function(name, workerMessage) {
  const specs = {};
  const previous = (this.supervisor != null) ? this.supervisor.previousSpecs(name) : {};
  for (const id in previous) {
    const ended = this.endedDevices[id];
    if (ended != null && ended.name === name) specs[id] = previous[id];
  }
  for (const id of indexOf(this).byModule.get(name) || []) {
    const e = this.endedDevices[id];
    if (isKeptReloading(e) && specs[id] == null) specs[id] = e.spec;
  }
  Object.assign(specs, workerMessage.deviceList);
  return specs;
};

ModuleManager.prototype.markEndedDevices = function(deviceIDs, name, code, kept = null) {
  const ix = indexOf(this);
  deviceIDs.forEach((id) => {
    const prev = this.endedDevices[id];
    const rec = {code: code, name: name};
    if (code === 'MODULE_RELOADING') {
      // (what it had: only from a record still reloading, never a settled one's)
      const had = prev != null && prev.name === name && prev.code === 'MODULE_RELOADING' ? prev : null;
      const spec = (kept != null && kept.specs != null && kept.specs[id] != null) ? kept.specs[id] : (had != null ? had.spec : null);
      const packageInfo = (kept != null && kept.packageInfo != null) ? kept.packageInfo : (had != null ? had.packageInfo : null);
      if (spec != null) { rec.spec = spec; rec.packageInfo = packageInfo; }
    }
    unindex(this, id);
    // deleted first: a record marked again is the newest (the cap's order)
    delete this.endedDevices[id];
    this.endedDevices[id] = rec;
    if (!ix.byModule.has(name)) ix.byModule.set(name, new Set());
    ix.byModule.get(name).add(id);
    if (isKeptReloading(rec)) ix.reloading.add(id);
  });
  capSettled(this, new Set(deviceIDs));
};
// A reload of a module that is restarting or suspended: the specs and
// package.json the supervisor kept listed go into its devices' reloading
// records before the supervisor forgets them (its clear()), so the reload
// keeps them listed in turn (the high review of #435, 4).
ModuleManager.prototype.keepRetainedForReload = function(name) {
  if (this.supervisor == null) return;
  // only what the supervisor still keeps listed (restarting or suspended),
  // never a running module's old exit-time snapshot (5)
  const listed = this.supervisor.retainedSpecs();
  const previous = this.supervisor.previousSpecs(name) || {};
  const specs = {};
  for (const id of Object.keys(previous)) if (Object.hasOwn(listed, id)) specs[id] = previous[id];
  const ids = Object.keys(specs);
  if (ids.length === 0) return;
  this.markEndedDevices(ids, name, 'MODULE_RELOADING', {specs, packageInfo: this.supervisor.packageInfoOf(name)});
};

// The module's devices still recorded as reloading or restarting will not
// come back. only: just that code's (a unit's end settles the reloading
// ones: a device of a module that restarted meanwhile is the supervisor's;
// a reload's unload of a supervised module the restarting ones: the
// supervisor no longer restarts it).
ModuleManager.prototype.settleEndedDevices = function(name, {only = null} = {}) {
  if (this.endedDevices == null) return;   // none recorded: nothing to settle
  const settled = [];
  const ix = indexOf(this);
  for (const id of ix.byModule.get(name) || []) {
    const e = this.endedDevices[id];
    if (e == null) continue;
    if (only != null ? e.code === only : (e.code === 'MODULE_RELOADING' || e.code === 'MODULE_RESTARTING')) {
      ix.reloading.delete(id);
      e.code = 'MODULE_UNLOADED';
      // never listed again: what it kept goes with it (9)
      delete e.spec;
      delete e.packageInfo;
      settled.push(id);
    }
  }
  capSettled(this, new Set(settled));
  // (not coming back: their hidden-text decisions go, DeviceManager)
  if (settled.length > 0) this.emit('endeddevicessettled', settled);
};

// Its device is back in the device map (DeviceManager, on 'deviceonline').
ModuleManager.prototype.clearEndedDevice = function(deviceID) {
  unindex(this, deviceID);
  delete this.endedDevices[deviceID];
};

ModuleManager.prototype.endedStateForDevice = function(deviceID) {
  return this.endedDevices[deviceID] || null;
};

// The device IDs a module's api.json declares, from its device's friendlyName
// (as a device's ID is derived from it), or null: no api.json, one over the
// size the main thread reads (lib/module-spec.js MAX_API_JSON_BYTES, checked
// before this first read: #177's re-review, item 3; the spawn then refuses
// it), or one that does not parse or names no device. Such a module declares
// nothing, so no other module is kept off an ID on its account; its
// registration is checked by ownership alone (DeviceManager's
// registerFromSpec).
function declaredDeviceIDs(modulePath) {
  return deviceIDsOf(declaredFriendlyName(modulePath));
}
const deviceIDsOf = (name) => ((name != null) ? new Set([require('./call-address').deviceIDForName(name)]) : null);
// the friendlyName a module's api.json gives its device, or null (as above)
function declaredFriendlyName(modulePath) {
  try {
    const apiPath = path.join(modulePath, 'api.json');
    if (fs.statSync(apiPath).size > require('./module-spec').MAX_API_JSON_BYTES) return null;
    const api = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
    const name = (api != null && api.device != null) ? api.device.friendlyName : null;
    return (typeof(name) === 'string' && name !== '') ? name : null;
  } catch (e) {
    return null;
  }
}

// stillWanted (optional): asked once the worker has loaded the module; false
// terminates the worker instead of registering it.
// operator (optional): true for an operator's load, reload or restart, which
// replaces a live worker of the name; a supervisor restart stands down.
// session (optional, R1): {sid, record}: a per-session module's worker for
// one session (spawnSessionWorker). Its spec is the record's, its lock
// name\0sid, its /data and /tmp the session's partition; it isn't the
// module's entry, the supervisor doesn't track it, and its exit is
// lib/session-workers.js's to handle. Without it, a per-session module on
// the shared runtime is loaded as its listing record, with no worker.
ModuleManager.prototype.spawnModuleWorker = function(modulePath, name, version, callback, stillWanted, operator, session) {
  // (a spawn that answers, loaded or failed, before or after its worker
  // started, is no longer one in progress: its own entry retired, never
  // another's)
  const spawnToken = {};
  const answer = callback;
  callback = (err, ...rest) => {
    this.retireSpawning(name, spawnToken);
    return answer(err, ...rest);
  };
  const sess = (session != null && isMainThread === true) ? session : null;
  const lockKey = (sess != null) ? `${name}\0${sess.sid}` : name;
  const outside = outsideHardenedRoot(modulePath);
  if (outside != null) return callback(outside);
  // Repeated here: restartModule and supervised restarts reach the spawn
  // without loadModuleFromPath.
  const mismatch = nameMismatch(modulePath, name);
  if (mismatch != null) return callback(mismatch);
  const layout = layoutRefused(modulePath, name);
  if (layout != null) return callback(layout);
  let sandbox = null;
  // A session worker takes the sandbox its record's load built and accepted
  // (the review of #356): not read from disk again at each session's spawn.
  const fromRecord = sess != null && sess.record.sandbox !== undefined;
  try {
    sandbox = fromRecord ? sess.record.sandbox : moduleSandboxConfig.build(modulePath, name,
      {mode: options.moduleSandbox, modulePolicy: options.modulePolicy, serverEnv: process.env, redisUrl: options.redisUrl,
      credentialNames: credentialNamesNow()});
  } catch (e) {
    return callback(new CountinghouseError('LOAD_MODULE_FAIL', name, e.message));
  }
  if (sandbox != null && !fromRecord) {
    sandbox.notes.forEach((note) => LOG.I(`module sandbox: ${name}: ${note}`));
    if (sandbox.refusal != null) {
      if (options.moduleSandbox === 'enforce') {
        const refused = new CountinghouseError('MODULE_SANDBOX_REFUSED', name, sandbox.refusal);
        LOG.E(refused);
        return callback(refused);
      }
      LOG.I(`module sandbox: ${name} would be refused under enforce: ${sandbox.refusal}`);
    }
    LOG.I(sandbox.logLine);
  }
  // A session worker's spawn registers no remote (the review of #356): the
  // record's load registered the module's, for every session. Registering
  // again would close every session's remote clients (remote.register
  // starts with an unregister), and a failed or given-up session spawn would
  // unregister them for every session.
  // M3 (#413 section 6.1): the remotes the pin below takes -- the pin's
  // plan, made once with no side effect (one read of the file), registered
  // here and committed by the pin, so a refused load leaves the
  // validation's copy and the remotes registered are the ones pinned.
  const planned = (sess != null) ? null : this.manifestPins.plan(name, modulePath, operator === true);
  // Its settings (lib/module-settings.js), before the remotes are registered
  // and the pin is taken, from what the pin will take (the plan: the last
  // pin at a supervised restart, else the copy read before its validation,
  // or the file), so a refusal leaves the remotes, the pin and the
  // validation's copy as they were: the declaration, the values read now,
  // checked against its granted net (the policy's narrowing; with the
  // sandbox off, its declared net). A session worker takes its record's, as
  // the record was loaded.
  let settingsState = null;
  if (sess != null) settingsState = (sess.record.settings != null) ? sess.record.settings : null;
  else if (isMainThread === true) {
    const willPin = planned.pinned;
    if (moduleSettings.declaresSettings(willPin)) {
      const net = (sandbox != null) ? sandbox.lockdown.net : modulePermissions.parseDeclaration(willPin).declared.net;
      // by the one rule (lib/settings-reread.js next): an operator's load
      // has no previous state; a supervised restart's is the state it ran
      // with (kept whole if a value is refused or the settings file cannot
      // be read now). The operator's ceiling refusing it refuses the restart
      // too: its fixed value is never run around.
      const previous = (operator === true || this.lastSettings == null) ? null : (this.lastSettings.get(name) || null);
      const made = require('./settings-reread').next(name, {pkg: willPin, net}, {previous, load: operator === true, ceilingRefuses: true, mm: this});
      if (made.state == null) {
        LOG.E(made.refusal);
        return callback(made.refusal);
      }
      settingsState = made.state;
      // what a supervised restart keeps if the settings file cannot be read then
      if (this.lastSettings == null) this.lastSettings = new Map();
      this.lastSettings.set(name, settingsState);
    } else if (this.lastSettings != null) {
      // a version that declares none: nothing of an earlier one is kept
      this.lastSettings.delete(name);
    }
  }
  const remotes = (sess != null) ? {refused: null, failed: (cb) => cb} : registerRemotes(name, modulePath, version, planned.pinned);
  if (remotes.refused != null) return callback(remotes.refused);
  callback = remotes.failed(callback);

  // The module's package.json as the main thread reads it, before any of the
  // module's code runs (its worker starts below): its countinghouse.calls are
  // the declarations the main thread enforces (R2-1 Task 4). An operator's
  // load, reload or restart takes the file (or the copy read before its
  // validation); a supervised restart keeps the last pin, so a module that
  // rewrote the file gains nothing by crashing. Each call added since the
  // previous pin is logged (lib/manifest-pins.js). After the refusals above,
  // so a refused load leaves the validation's copy for the next one.
  // A session worker takes its record's pin, as the record was loaded.
  const hostPackageInfo = (sess != null) ? sess.record.hostPackageInfo : this.manifestPins.pin(name, modulePath, operator === true, planned);
  // R1: the pinned state declaration (lib/module-state.js): the operator's
  // checks ran before this; here for every spawn, a load at start included
  const stateRefused = (sess != null) ? null : moduleState.stateProblem(hostPackageInfo, name, options);
  if (stateRefused != null) return callback(stateRefused);
  if (sess == null && (operator === true || this.pinnedDeviceIDs[name] === undefined)) {
    // its friendlyName, read once: the device IDs derive from it, and its
    // tool results take notices by it (lib/settings-reread.js), before its
    // devices register
    const friendly = declaredFriendlyName(modulePath);
    // this module's earlier IDs (a friendlyName changed) go first
    dropPinnedDevices(this, name);
    this.pinnedFriendlyNames[name] = friendly;
    this.pinnedDeviceIDs[name] = deviceIDsOf(friendly);
    // and back, a device ID to its module (lib/device-manager.js
    // moduleOfDevice: a part whose device is not registered yet)
    for (const id of (this.pinnedDeviceIDs[name] || [])) this.pinnedDevicePackages.set(id, name);
  }
  const hostDeviceIDs = (sess != null) ? sess.record.hostDeviceIDs : this.pinnedDeviceIDs[name];
  // R1: loaded as its listing record (no worker) on the shared runtime
  const asRecord = sess == null && isMainThread === true && moduleState.isPerSession(hostPackageInfo, name, options);
  // R1: a session worker's share of its module's quota (P5)
  const sharedQuota = (sess != null) ? this.sessionQuota(name, sandbox != null ? sandbox.limits : null,
    (rule, target) => LOG.I(`module sandbox: ${name} file ${rule} ${target}`), sess.sid) : null;

  // The worker's file broker is built first (data directories, namespace,
  // bridge); the worker receives its end of the bridge in workerData.
  const startWorker = (fsb, moduleSpec) => {
    const workerOptions = Object.assign({}, sandbox != null ? sandbox.workerOptions : {},
      {workerData: {fsBridge: fsb.bridge.transfer, moduleRoot: fsb.moduleRoot, installDir: fsb.installDir, codeRoots: fsb.codeRoots, lateRoots: fsb.lateRoots, installSpellings: fsb.installSpellings,
        virtualDrive: require('./fs-broker/virtual-drive').pick(), lateLoadProbe: lateLoadProbe()}, transferList: fsb.bridge.transferList});
    const worker = outsideRequest(() => new Worker(leanWorkerEntry(), workerOptions)); //this is the name under release mode
    // The lifecycle lock's view of this worker: live until it exits, settled
    // once its bridge is closed and its broker idle (review I5).
    const workerExited = new Promise((resolve) => worker.once('exit', resolve));
    const brokerSettled = require('./module-lifecycle').settleAfterExit({exited: workerExited, closeBridge: () => fsb.bridge.close(),
      broker: fsb.broker, name: name, log: (line) => LOG.E(new Error(line)), onSettled: () => LOG.I(`file broker: ${name} settled`)});
    this.lifecycle.track(lockKey, {exited: workerExited, settled: brokerSettled, terminate: () => worker.terminate(), idle: () => fsb.broker.idle()});
    const workerMessage = new WorkerMessage(worker);
    // its messages' bytes budgeted from its first, the load's included (F4-4)
    workerMessage.byteBudgeted = true;
    // Its log lines and its module's output carry this name (lib/worker-output.js);
    // what is left of them is written when it ends.
    workerMessage.logName = name;
    worker.once('exit', () => require('./worker-output').end(workerMessage));
    // A message on the file bridge it cannot read ends the worker, as one on
    // its own port does (the review of #186, HIGH 3).
    fsb.bridge.setOnViolation((why) => workerMessage.endForMessage(`file bridge: ${why}`));
    // The module's spec and validators on the main thread (lib/module-spec.js):
    // its device is registered from it, and every call sent to this worker is
    // checked with it.
    workerMessage.moduleSpec = moduleSpec;
    workerMessage.sandboxLimits = sandbox != null ? sandbox.limits : null;
    workerMessage.violationCount = 0;
    workerMessage.killReason = null;
    // RC1-min: ctx.call('remote:...') from this worker, answered for this
    // worker's module (`name` here), never for a name the worker states; its
    // usage call id is checked against this worker (step 5).
    workerMessage.on('remote-call', (message) => {
      require('./remote').answerRemoteMessage(name, message.data, workerMessage.workerId).then(
        (result) => {
          // (the remote call went through: a refusal of an earlier call is not why the call may fail now)
          require('./call-tokens').noteThrough(message.data != null ? message.data.token : null, workerMessage.workerId);
          workerMessage.sendRemoteCallReplyToChild({msgID: message.id, result: result, errMsg: null});
        },
        (err) => {
          // (the runtime's own refusal of the call's remote call: kept on the call, said where it fails)
          const fields = CountinghouseError.replyFields(err);
          require('./call-tokens').noteRefused(message.data != null ? message.data.token : null, fields.errCode, 'remote', workerMessage.workerId, fields.errMsg);
          workerMessage.sendRemoteCallReplyToChild(Object.assign({msgID: message.id, result: null}, fields));
        });
    });
    // ctx.usage() from this worker: its call's counts so far, the id and
    // token checked against this worker (lib/usage/query.js).
    workerMessage.on('usage-query', (message) => {
      let result = null;
      try {
        result = require('./usage/query').answerUsageQuery(message.data, workerMessage.workerId);
      } catch (err) {
        return workerMessage.sendUsageQueryReplyToChild(Object.assign({msgID: message.id, result: null}, CountinghouseError.replyFields(err)));
      }
      workerMessage.sendUsageQueryReplyToChild({msgID: message.id, result: result, errMsg: null});
    });
    // ctx.ask() from this worker (lib/module-ask.js): the question is one of
    // this worker's own module's (its spec as the main thread built it),
    // for the call its token names, checked against this worker.
    workerMessage.on('ask', (message) => {
      let result = null;
      try {
        const own = workerMessage.moduleSpec;
        // the module's name is this worker's, as the main thread spawned it
        result = require('./module-ask').answer(message.data, workerMessage.workerId, own != null && own.spec != null ? own.spec : null, name);
      } catch (err) {
        const fields = CountinghouseError.replyFields(err);
        // (an answer the runtime handed this call's ask: one its module may pass on as the runtime's, call-tokens noteHanded)
        require('./call-tokens').noteHanded(message.data != null ? message.data.token : null, fields.errCode, workerMessage.workerId, fields.errMsg);
        return workerMessage.sendAskReplyToChild(Object.assign({msgID: message.id, result: null}, fields));
      }
      workerMessage.sendAskReplyToChild({msgID: message.id, result: result, errMsg: null});
    });
    workerMessage.on('sandbox-violation', (data) => {
      // 'uses' is information, not a violation: the first require of fs, net
      // and the like. Files go through the file broker (part 2): anything
      // outside /app, /data and /tmp needs a declared fs permission. The
      // network broker is still to come.
      if (data.rule === 'uses') {
        const fsTarget = data.target === 'fs' || data.target === 'fs/promises';
        return LOG.I(`module sandbox: ${name} uses ${data.target} -- ${fsTarget
          ? 'files outside /app, /data and /tmp need a declared fs permission'
          : 'it will need net permissions once the network broker ships'}`);
      }
      if (data.rule === 'suppressed') return LOG.I(`module sandbox: ${name} further violations suppressed`);
      // The lockdown's own state under audit (enforce refuses the load instead).
      if (data.rule === 'unguarded') return LOG.E(new Error(`module sandbox: ${name} cannot guard ${data.target} -- audit continues; enforce would refuse to start`));
      workerMessage.violationCount++;
      // The always-denied set (rule 'redis') is blocked in audit too.
      const blocked = options.moduleSandbox === 'enforce' || data.rule === 'redis';
      LOG.I(`module sandbox: ${name} violation ${data.rule} ${data.target} (${blocked ? 'blocked' : 'allowed, audit'})`);
    });

    // A restart puts a new worker under the same name before the old worker's
    // 'exit' event has necessarily fired. Only clean up the module if it is
    // still this worker's: otherwise the old worker's exit would unload the new
    // one.
    const isCurrent = () => (sess != null) ? (stillWanted == null || stillWanted()) : this.modules[name] === workerMessage;

    // The spawn calls back once: on load, on a refusal from the worker, or when
    // the worker ends before the module has loaded.
    let loaded = false;
    let settled = false;
    let loadTimer = null;
    const done = (err, data) => {
      if (settled) return;
      settled = true;
      if (loadTimer != null) clearTimeout(loadTimer);
      callback(err, data);
    };

    // 'error' and 'exit' both fire for one crash; the first decides the reason.
    // offText is the unload reason --moduleSandbox off logs, unchanged from
    // before the sandbox.
    let exitReason = null;
    const onUnexpectedExit = (reason, offText) => {
      if (exitReason != null) return;
      exitReason = workerMessage.killReason || reason;
      if (!loaded) return done(new CountinghouseError('LOAD_MODULE_FAIL', name, `worker ended while loading: ${exitReason}`));
      // R1: a session worker's crash is lib/session-workers.js's (its slot
      // freed, its session told); the module and its other workers run on
      if (sess != null) return LOG.E(new Error(`module: ${name}: a session's worker exited (${exitReason})`));
      if (!isCurrent()) return;   // a deliberate unload already took the module off this worker
      if (workerMessage.unloading === true) return;   // an operator unload is under way; its own timer finishes it

      const specs = this.specsAtExit(name, workerMessage);
      // With no supervisor the module stays down. With one it restarts: the
      // supervisor's own state answers until the restarted worker is
      // running, this entry until its devices are back (after discovery).
      this.markEndedDevices(Object.keys(specs), name, this.supervisor == null ? 'MODULE_UNLOADED' : 'MODULE_RESTARTING');
      this.unloadModule(name, this.supervisor == null ? offText : `WORKER EXIT: ${exitReason}`, () => {
        if (this.supervisor == null) return;
        const decision = this.supervisor.exited(name, exitReason, specs, workerMessage.packageInfo || workerMessage.hostPackageInfo);
        if (decision.action === 'suspend') {
          LOG.E(new Error(`module sandbox: ${name} suspended after repeated exits: ${
            JSON.stringify(this.supervisor.status(name).exits)} -- POST /restart-module to start it again`));
          this.givenUp(name, 'MODULE_SUSPENDED');
        } else {
          LOG.I(`module sandbox: ${name} exited (${exitReason}); restarting in ${decision.delayMs} ms`);
        }
      });
    };

    worker.on('error', (err) => {
      LOG.E(new Error(`worker exit on error: ${err.message}`));
      onUnexpectedExit(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'heap limit' : `crash: ${err.message}`,
        `ERROR MESSAGE FROM WORKER: ${err.message}`);
    });

    worker.on('exit', (exitCode) => {
      LOG.E(new Error(`worker exit with code: ${exitCode}`));
      onUnexpectedExit(`exit code ${exitCode}`, `WORKER EXIT WITH CODE: ${exitCode}`);
      // Whatever ended the worker, what it still owed an answer -- calls,
      // jobs, the unload's own acknowledgement -- is answered now, with why:
      // a reload, an unload, or a crash the supervisor restarts (or, with no
      // supervisor, one the module stays down after). Deliberately AFTER
      // onUnexpectedExit, not before: a worker that ends while loading has
      // its load-module request in msgQueue, and draining first would answer
      // the load with this code instead of onUnexpectedExit's
      // LOAD_MODULE_FAIL "worker ended while loading". Its early returns
      // (unloading, not current) are inside it, so this still runs for
      // every exit.
      workerMessage.exited = true;
      // R1: a session worker's crash: its session's next call starts another
      const why = (workerMessage.endingFor === 'reload') ? 'MODULE_RELOADING'
        : (workerMessage.unloading === true) ? 'MODULE_UNLOADED'
          : (sess != null && loaded) ? 'SESSION_WORKER_ENDED'
            : (this.supervisor != null && loaded) ? 'MODULE_RESTARTING' : 'MODULE_UNLOADED';
      // The tokens of the calls this worker was running end with it (R2-1
      // Task 3): nothing may cite them again.
      require('./call-tokens').dropFor(workerMessage.workerId);
      workerMessage.endWith(why, name, exitReason || `exit code ${exitCode}`);
      // the calls held on it for its module's composition verdict, never sent: answered now, as a fresh call to the tool is answered
      // then (lib/device-manager.js HeldCall, releaseHeldOn, heldAnswerNow)
      require('./device-manager').releaseHeldOn(workerMessage);
      // Its spec's validators are dropped (a new start reads a new spec); a
      // session worker's spec is its record's, released at the unload.
      if (sess == null) require('./module-spec').release(workerMessage.moduleSpec);
      else {
        sharedQuota.release();
        if (loaded) LOG.I(`module: ${name}: a session's worker ended`);
      }
    });

    // worker.threadId is a real, unique-per-Worker-instance identifier Node
    // already provides -- used as-is for "workerId" throughout the direct
    // peer channel feature (docs/direct-peer-channels-design.md) rather
    // than inventing a parallel ID scheme. A restart gets a new worker and so
    // a new workerId; channels to the old one are invalidated by the unload
    // (DeviceManager.prototype.onPurgeDevice), not by noticing the ID change.
    workerMessage.workerId = worker.threadId;

    // #144: the load is bounded in every mode, from here to the module's
    // answer (set-options, the device config, the load). Requiring a module's
    // files is synchronous, so one that blocks while it is required never
    // answers; under audit and enforce the block watchdog ends it, under off
    // nothing else would. The load fails first, with its own code, so the
    // worker's exit cannot answer it LOAD_MODULE_FAIL.
    const loadBoundMs = options.moduleLoadTimeoutMs;
    loadTimer = setTimeout(() => {
      if (settled || loaded) return;
      LOG.E(new Error(`module: ${name}: the load was not answered within ${loadBoundMs / 1000} s; ending its worker`));
      workerMessage.killReason = `load not answered within ${loadBoundMs / 1000} s`;
      done(new CountinghouseError('MODULE_LOAD_TIMEOUT', name, `no answer within ${loadBoundMs / 1000} s`));
      worker.terminate().catch(() => {});
    }, loadBoundMs);
    if (typeof(loadTimer.unref) === 'function') loadTimer.unref();

    workerMessage.sendSetOptionsMessage({options: options.getOptionsForWorker(), sandbox: sandbox != null ? sandbox.lockdown : null}, (err, data) => {
      if (err) {
        worker.terminate();
        return done(err, data);
      }
      // the Redis host name's addresses known now, and every later refresh's
      // (#207: a worker built before a refresh is caught up)
      if (sandbox != null) moduleSandboxConfig.trackWorker(workerMessage, worker, options.redisUrl);
      // Watched from here, so a module that blocks while loading is ended too.
      if (workerMessage.sandboxLimits != null) workerLimits.watch(worker, workerMessage, workerMessage.sandboxLimits,
        {busy: () => fsb.bridge.syncInFlight() > 0});
      // The device config is read here, on the main thread: a worker sees
      // only its own namespace, not the operator's config directory.
      getDeviceConfig.readDeviceConfig(options, name, (cfgErr, deviceConfig) => {
        if (cfgErr) LOG.E(new CountinghouseError('DEVICE_CONFIG_LOAD_FAIL', cfgErr.message));
        // The worker reports its module path as the worker sees it; the main
        // thread keeps the host path for device-ID conflicts and restarts.
        workerMessage.hostModulePath = modulePath;
        workerMessage.hostPackageInfo = hostPackageInfo;
        // the settings it runs with, numbered (lib/module-settings.js stateFor)
        workerMessage.settings = settingsState;
        // The module name the main thread loaded: what its identity binding
        // is looked up by, never a name the worker states (R2-1 Task 5, #148).
        workerMessage.hostModuleName = name;
        // the devices its api.json declares (null: none to go by)
        workerMessage.hostDeviceIDs = hostDeviceIDs;
        // R1: the session it serves, main thread only (never sent to it)
        if (sess != null) workerMessage.hostSession = sess.sid;
          // The worker loads its module as it sees it: /app (spec section 2).
        workerMessage.sendLoadModuleMessage({path: '/app', name: name, version: version, deviceConfig: deviceConfig || null}, (e, d) => {
          if (settled) return;   // the worker already ended
          if (e) {
            worker.terminate();
            return done(e, d);
          }
          if (stillWanted != null && !stillWanted()) {
            worker.terminate();
            return done(new Error('module sandbox: restart superseded by an operator action'));
          }
          // What the worker loaded is what the main thread read (lean worker
          // step 3, the high review of #177): its device and every declared
          // action, with a handler for each. Anything else fails the load.
          const mismatch = loadAckMismatch(workerMessage.moduleSpec, d);
          if (mismatch != null) {
            const refused = new CountinghouseError('LOAD_MODULE_FAIL', name, `its worker's load does not match api.json as the main thread read it: ${mismatch}`);
            LOG.E(refused);
            worker.terminate();
            return done(refused);
          }
          loaded = true;
          // --moduleMessageRate, for every module worker: a per-session
          // module's too (the review of #356: one declaring "per-session"
          // must not escape it)
          if (workerMessage.sandboxLimits != null) {
            workerMessage.messageRate = options.moduleMessageRate;
            workerMessage.rateTokens  = options.moduleMessageRate;
          }
          if (sess != null) return this.sessionWorkerReady(workerMessage, sess.record, done);
          if (this.supervisor != null) this.supervisor.track(name, {modulePath: modulePath, version: version});
          this.emit('workerloaded', workerMessage);
          //workerMessage also acting as moduleInstance in main thread
          this.emit('moduleload', name, workerMessage, version);
          return done(null, workerMessage);
        });
      });
    });
  };

  // Under the module's lifecycle lock (spec section 3, "Worker end"): one
  // spawn or uninstall per name at a time, and the walk only once the
  // previous broker of this name has settled. A live worker of the same name
  // is replaced by an operator load and wins over a supervisor restart.
  let loadedRecord = null;
  this.lifecycle.run(lockKey, async () => {
    // Given up on while queued (a later operator action): no worker starts.
    if (stillWanted != null && !stillWanted()) throw Object.assign(new Error('module sandbox: spawn superseded by a later operator action'), {superseded: true});
    // R1: a session worker runs its record's spec, checked at the load
    if (sess != null) return this.startSessionWorker(name, modulePath, sandbox, sess, sharedQuota, lockKey, startWorker, stillWanted);
    // The module's spec, read before the worker starts and before a live
    // worker of the name is replaced (lib/module-spec.js), and its schema.json
    // checked in a validator, not on this thread (lib/schema-safety.js, a
    // courtesy refusal at load; the validator's deadline is the boundary). A
    // refused or timed-out check refuses the start, and a reload's refusal
    // leaves the loaded version serving.
    const specs = require('./module-spec');
    // An operator's load (or a first one) ends a validation quarantine; a
    // supervisor's restart does not (lib/validator-pool.js).
    if (operator === true || stillWanted == null) specs.clearQuarantine(name);
    const moduleSpec = await specs.build(modulePath, name);
    if (moduleSpec.refused === true) {
      // an api.json over the size the main thread reads (lib/module-spec.js)
      const refused = new CountinghouseError('MODULE_ASSEMBLY_FAIL', name, `stage=readApiJson -- ${moduleSpec.error}`);
      LOG.E(refused);
      throw Object.assign(refused, {schemaRefused: true});
    }
    if (moduleSpec.error != null) LOG.E(new Error(`module: ${name}: its spec could not be read on the main thread: ${moduleSpec.error}`));
    const problem = await specs.safety(moduleSpec);
    if (problem != null) {
      specs.release(moduleSpec);
      const refused = (problem.timeout != null) ? problem.timeout : require('./schema-safety').refusalFor(name, problem);
      LOG.E(refused);
      throw Object.assign(refused, {schemaRefused: true});
    }
    // (the tools its declared text leaves unusable, moduleSpec.hiddenUnlisted:
    // taken when this spec serves, at its device's registration, #400)
    // api.json against the device spec's own schema, in a validator under
    // the compile budget, not on this thread (the high review of #177): a
    // spec that fails is refused with every error, before a worker starts.
    const specChecked = await specs.deviceSpec(moduleSpec);
    if (specChecked != null) {
      specs.release(moduleSpec);
      const refused = (specChecked.timeout != null) ? specChecked.timeout
        : new CountinghouseError('DEVICE_SPEC_VALIDATION_FAIL', name, specs.specFailureDetail(specChecked.specError));
      LOG.E(refused);
      throw Object.assign(refused, {schemaRefused: true});
    }
    // Every action compiled in a validator now, under the compile budget, so
    // an operator sees a schema too slow to compile at load, not as call
    // timeouts later.
    const warmed = await specs.warm(moduleSpec);
    if (warmed != null) {
      specs.release(moduleSpec);
      const refused = new CountinghouseError('MODULE_ASSEMBLY_FAIL', name, (warmed.timeout != null)
        ? `stage=schemaCompile -- its schemas were not compiled within ${options.validationCompileMs} ms (--validationCompileMs)`
        : `stage=schemaCompile -- its schemas could not be compiled (${warmed.failed})`);
      LOG.E(refused);
      throw Object.assign(refused, {schemaRefused: true});
    }
    // Its prompts' arguments, derived and compiled in a validator (M10)
    const promptsProblem = await specs.prompts(moduleSpec);
    if (promptsProblem != null) {
      specs.release(moduleSpec);
      const refused = new CountinghouseError('MODULE_ASSEMBLY_FAIL', name, `stage=prompts -- ${promptsProblem}`);
      LOG.E(refused);
      throw Object.assign(refused, {schemaRefused: true});
    }
    // Every icon it declares, read and checked here, on the main thread
    // (MCP completeness M2): the load decides, and tools/list inlines what
    // was read now. A refusal leaves a loaded version serving.
    const iconProblem = specs.icons(moduleSpec);
    if (iconProblem != null) {
      specs.release(moduleSpec);
      const refused = new CountinghouseError('MODULE_ASSEMBLY_FAIL', name, `stage=icons -- ${iconProblem}`);
      LOG.E(refused);
      throw Object.assign(refused, {schemaRefused: true});
    }
    const live = this.lifecycle.live(name);
    if (live != null) {
      if (stillWanted != null && operator !== true) throw Object.assign(new Error('module sandbox: restart superseded by an operator action'), {superseded: true});
      await live.terminate();
    }
    // R1: a per-session module on the shared runtime: its listing record,
    // registered as a worker's device is, and no worker until a session
    // calls it (lib/session-module-record.js)
    if (asRecord) {
      if (stillWanted != null && !stillWanted()) {
        specs.release(moduleSpec);
        throw Object.assign(new Error('module sandbox: spawn superseded by a later operator action'), {superseded: true});
      }
      const rec = new SessionModuleRecord({name: name, version: version, modulePath: modulePath, moduleSpec: moduleSpec,
        hostPackageInfo: hostPackageInfo, hostDeviceIDs: hostDeviceIDs});
      // its sandbox as built and accepted now, for every session's worker
      rec.sandbox = sandbox;
      // and its settings, for every session's worker
      rec.settings = settingsState;
      LOG.I(`module: ${name} keeps state per session: loaded with no worker; each session's first call starts its own`);
      this.emit('moduleload', name, rec, version);
      loadedRecord = rec;
      return;
    }
    await this.lifecycle.settled(name);
    LOG.I(`file broker: ${name} spawn walk`);
    // (known to every other spawn's overlap judgement from now on, before
    // its load is confirmed: two loads at once see each other)
    this.addSpawning(name, spawnToken, modulePath);
    const fsb = await require('./fs-broker').createForWorker({name: name, mode: options.moduleSandbox, modulePath: modulePath,
      declared: sandbox != null ? sandbox.fs : [], options: options, limits: sandbox != null ? sandbox.limits : null,
      pinsDir: path.join(options.moduleDataPath, RECORD_DIR), knownModules: this.knownModuleRoots(), knownDataPath: options.moduleDataPath,
      report: (rule, target) => LOG.I(`module sandbox: ${name} file ${rule} ${target}`)
    });
    // the walk's end, so its own time shows (perf/lean-worker-perf.js)
    LOG.I(`file broker: ${name} walk finished`);
    // A synchronous throw in startWorker (new Worker refusing its options,
    // say) must still answer the load and release the broker (review I1).
    try {
      startWorker(fsb, moduleSpec);
    } catch (e) {
      fsb.bridge.close().catch(() => {});
      throw Object.assign(new Error(e.message), {startFailed: true});
    }
  }).then(() => { if (loadedRecord != null) callback(null, loadedRecord); }, (e) => {
    if (sharedQuota != null) sharedQuota.release();
    if (e != null && e.superseded === true) return callback(e);
    if (e != null && e.schemaRefused === true) return callback(e);
    if (e != null && e.startFailed === true) return callback(new CountinghouseError('LOAD_MODULE_FAIL', name, e.message));
    if (e != null && e.code === 'MODULE_SANDBOX_REFUSED') {
      const refused = new CountinghouseError('MODULE_SANDBOX_REFUSED', name, e.message);
      LOG.E(refused);
      return callback(refused);
    }
    return callback(new CountinghouseError('LOAD_MODULE_FAIL', name, `file broker: ${e.message}`));
  });
};

//this call MUST NOT run under worker thread mode
ModuleManager.prototype.reloadModule = function(modulePath, callback) {
  let moduleInstance = null;
  let packageInfo    = null;
  let name    = null;
  let version = null;

  if (typeof(modulePath) !== 'string' || !fs.existsSync(modulePath)) return callback(new CountinghouseError('INVALID_MODULE_PATH', modulePath));
  const outside = outsideHardenedRoot(modulePath);
  if (outside != null) return callback(outside);

  // A reload that fails here unloads the module. Under --workerThread that is
  // the operator's unload, which ends the worker and its supervisor record
  // too; unloadModule alone would purge the main thread's records and leave
  // the worker running, unreachable, with its devices DEVICE_NOT_FOUND.
  const unloadOnFailure = (reason, done) => {
    if (options.workerThread === true && isMainThread === true && typeof(name) === 'string') return this.unloadModuleExternal(name, () => done());
    return this.unloadModule(name, reason, done);
  };

  // (before its name is read, and before anything is unloaded)
  const bom = bomRefusal(modulePath, path.basename(String(modulePath)));
  if (bom != null) return callback(bom);
  try {
    packageInfo = JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json')).toString());
    name    = packageInfo.name;
    version = packageInfo.version;

    if (typeof(name) !== 'string') {
      return callback(new CountinghouseError('MODULE_PACKAGE_NAME_TYPE_ERROR', name));
    }
    // Before anything is unloaded: a refused layout leaves the module as it was.
    const layout = layoutRefused(modulePath, name, true);
    if (layout != null) return callback(layout);
    // and a version that declares settings, in single-thread mode (they run
    // only with worker threads): refused before its remotes or any unload,
    // so the loaded version keeps serving
    // (the package.json read from disk above, as a load checks it)
    if (isMainThread === true && options.workerThread !== true) {
      const refusedHere = singleThreadSettingsRefusal(name, packageInfo);
      if (refusedHere != null) return callback(refusedHere);
    }
    if (typeof(version) !== 'string' || semver.valid(version) == null) {
      // in case of any error, unload the module so user must fix coding errors before he can continue to use this module
      return unloadOnFailure('RELOAD MODULE FAIL DUE TO INVALID VERSION STRING', () => {
        return callback(new CountinghouseError('MODULE_VERSION_INFO_INVALID', version));
      });
    }

    // Under --workerThread, module code runs only in its worker: a reload is
    // a restart in a new worker, never an instantiation here in the main
    // thread.
    if (options.workerThread === true && isMainThread === true) {
      // R1: a state declaration refused, or changed, leaves the module as it was
      const stateRefused = this.stateRefusal(modulePath, name);
      if (stateRefused != null) return callback(stateRefused);
      return this.loadModuleByWorker(modulePath, name, version, callback);
    }

    // Single-thread: the remote is registered again (its old client closed,
    // a changed declaration read), as a worker's spawn does.
    const remotes = registerRemotes(name, modulePath, version);
    if (remotes.refused != null) return unloadOnFailure(remotes.refused.message, () => callback(remotes.refused));
    callback = remotes.failed(callback);

    moduleInstance = this.instantiateModule(modulePath, name).instance;

    moduleInstance.on('deviceonline',  this.onDeviceOnline.bind(this, packageInfo, modulePath)); //append content of package.json and modulePath to module instance
    moduleInstance.on('deviceoffline', this.onDeviceOffline.bind(this));

    // if there is no error, new module and devices instances inside it will be replaced in device manager
    this.emit('moduleload', name, moduleInstance, version);

    setTimeout(() => {
      //get the list of device objects which belongs to moduleInstance
      //this event is handled by device manager
      this.emit('querydevicelist', moduleInstance, packageInfo, callback);
    }, 1000);
  } catch (e) {
    unloadOnFailure(`RELOAD MODULE FAIL DUE TO EXCEPTION: ${e.message}`, () => {
      return callback(new CountinghouseError('LOAD_MODULE_FAIL', e.message, e.stack));
    });
  }
};

//this should only be available under worker mode to restart a worker thread,
// and non worker mode has no such concept of 'restart', only reload a module
// and return the newly discovered device list to caller
ModuleManager.prototype.restartModule = function(modulePath, name, version, callback) {
  const m = this.modules[name];
  // A restarting or suspended module is not in this.modules, but an operator
  // restart is exactly what brings it back.
  const record = (this.supervisor != null) ? this.supervisor.recorded(name) : null;
  if (m == null && record == null) {
    return callback(new CountinghouseError('RESTART_MODULE_FAIL', 'unknown module', name));
  }
  // No path or version given: restart what is running or recorded.
  if (modulePath == null) modulePath = (record != null) ? record.modulePath : m.modulePath;
  if (version == null) version = (record != null) ? record.version : (m.packageInfo != null ? m.packageInfo.version : null);
  // Checked before anything is unloaded or the supervisor record cleared, so
  // a bad request leaves the module as it was.
  if (typeof(modulePath) !== 'string' || !fs.existsSync(modulePath)) {
    return callback(new CountinghouseError('INVALID_MODULE_PATH', modulePath));
  }
  const outside = outsideHardenedRoot(modulePath);
  if (outside != null) return callback(outside);
  const layout = layoutRefused(modulePath, name);
  if (layout != null) return callback(layout);
  // R1: a state declaration refused, or changed, leaves the module as it was
  const stateRefused = this.stateRefusal(modulePath, name);
  if (stateRefused != null) return callback(stateRefused);
  if (m == null) return this.loadModuleByWorker(modulePath, name, version, callback);

  if (options.workerThread !== true || isMainThread !== true) {
    return this.loadModuleFromPath(modulePath, name, version, callback);
  }

  // The restart's own action, taken now: an operator unload or reload that
  // arrives while the old worker is still being ended outranks it, and the
  // continuation then stands down instead of bringing the module back (the
  // worker can take up to 3 s to acknowledge).
  const gen = this.nextGeneration(name);
  // Test suite only (test/direct-peer-channels/02, D4): the new worker starts
  // COUNTINGHOUSE_TEST_RESTART_HOLD_MS after the old one has ended, for every
  // module or, with COUNTINGHOUSE_TEST_RESTART_HOLD_MODULE, that one only, so
  // the reload's window (old devices gone, MODULE_RELOADING) is wide enough
  // for a test's calls to land in it whatever the boot time. Everything the
  // restart does runs as it would. Honoured only under the suite's own
  // marker, and it says so.
  const holdMs = (process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG === '1') ? Number(process.env.COUNTINGHOUSE_TEST_RESTART_HOLD_MS) : NaN;
  const holdModule = process.env.COUNTINGHOUSE_TEST_RESTART_HOLD_MODULE;
  const held = holdMs > 0 && (holdModule == null || holdModule === name);
  this.unloadModuleExternal(name, () => {
    const load = () => {
      if (this.generations[name] !== gen) return callback(new CountinghouseError('MODULE_LOAD_SUPERSEDED', name));
      this.loadModuleByWorker(modulePath, name, version, (err, mi) => {
        if (err) LOG.E(new CountinghouseError('LOAD_MODULE_FAIL', err.message));
        return callback(err, mi);
      });
    };
    if (!held) return load();
    LOG.I(`test hook: ${name}'s restart starts its new worker ${holdMs} ms after the old one ended`);
    return setTimeout(load, holdMs);
  }, 'reload');
};

// `why` is 'reload' when a new worker replaces this one (loadModuleByWorker,
// restartModule): what the old worker had in flight then fails
// MODULE_RELOADING rather than MODULE_UNLOADED.
ModuleManager.prototype.unloadModuleExternal = function(name, callback, why) {
  const wasSupervised = this.supervisor != null && this.supervisor.status(name) != null;
  if (this.supervisor != null) this.supervisor.clear(name);
  // no supervised restart follows an operator's unload: its last settings go
  if (this.lastSettings != null) this.lastSettings.delete(name);
  // nor does a part still spawning answer for its devices any more
  dropPinnedDevices(this, name);
  // An operator's unload is an action of its own (a 'reload' unload is part
  // of the reload's): a reload still bringing its worker up is cancelled.
  if (why !== 'reload') this.nextGeneration(name);
  const m = this.modules[name];
  if (isRecord(m)) return this.unloadSessionModule(name, m, why, callback);
  if (m != null) {
    if (m instanceof WorkerMessage) {
      // Already being ended (a reload's unload under way): an operator
      // unload arriving now has cancelled that reload, so the worker ends as
      // an unload after all and its devices are unloaded, not reloading. The
      // acknowledgement already awaited finishes every caller.
      if (m.unloading === true) {
        if (why !== 'reload') {
          m.endingFor = 'unload';
          this.markEndedDevices(Object.keys(m.deviceList || {}), name, 'MODULE_UNLOADED');
          this.settleEndedDevices(name);
          // The worker was already told why: 'reload', so for the rest of its
          // window (at most 3 s) a call that still reaches it answers
          // MODULE_RELOADING while main answers MODULE_UNLOADED. Transient.
        }
        (m.unloadWaiters = m.unloadWaiters || []).push(callback);
        return;
      }
      //worker thread mode
      //first send message to child to allow child run destroyDevice call
      //then invoke unloadModule in main thread to clean workerMessage instances saved in deviceMap
      //TODO: setTimeout and if unload message didn't get responded (possibly due to blocked by module's code), we force terminate its thread
      //TODO: deny any external API call goes into child thread before terminate the thread to be safer

      // Terminate as soon as the worker acknowledges the unload; the timer
      // covers a worker whose module code blocks it from ever answering.
      // Called once, whichever comes first. The callback waits for
      // terminate() so a restart's new worker never overlaps the old one.
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        // Again, for what the worker's device list holds now.
        this.markEndedDevices(Object.keys(m.deviceList || {}), name, m.endingFor === 'reload' ? 'MODULE_RELOADING' : 'MODULE_UNLOADED', keptOf(m, name));
        this.unloadModule(name, 'CLEANUP MODULE INFO IN MAIN THREAD', () => {
          const done = () => { callback(); (m.unloadWaiters || []).forEach((cb) => cb()); };
          m.worker.terminate().then(done, done);
        });
      };
      const timer = setTimeout(finish, 3000);

      // The worker may exit while it answers (its destroy code, a limit kill):
      // that is part of this unload, not an unexpected exit.
      m.unloading = true;
      m.endingFor = (why === 'reload') ? 'reload' : 'unload';
      this.markEndedDevices(Object.keys(m.deviceList || {}), name, m.endingFor === 'reload' ? 'MODULE_RELOADING' : 'MODULE_UNLOADED', keptOf(m, name));
      // The worker is told why it ends, so it answers what reaches it after
      // its own devices are purged with that code too (lib/lean-worker.js).
      m.sendUnloadModuleMessage({name: name, why: m.endingFor}, finish);
      // Logged once the unload is posted: a call posted to the worker after
      // this line is never run. It is answered with the ending's code, by the
      // worker once it reads it (after any handler still running), or by the
      // drain when the worker ends (the 3 s bound, an exit).
      LOG.I(`module: ${name} ending its worker (${m.endingFor})`);
    } else {
      //single thread mode
      if (isMainThread === true) return this.unloadModule(name, 'UNLOAD MODULE IN MAIN THREAD', callback);
      //do unload in child thread
      return this.unloadModule(name, 'UNLOAD MODULE IN WORKER', callback);
    }
  } else {
    // A worker of this name still coming up (a reload's, superseded by this
    // unload): it is ended, and the devices the reload marked reloading are
    // unloaded now. Likewise a restarting or suspended module: not loaded,
    // but unloading it took effect.
    const live = this.lifecycle.live(name);
    if (why !== 'reload' && (live != null || (this.spawnsPending[name] || 0) > 0)) {
      if (live != null) live.terminate();
      this.settleEndedDevices(name);
      return callback();
    }
    if (wasSupervised) {
      // (a reload's own unload of a restarting or suspended module: its
      // devices' reloading records, taken from the supervisor first, stay
      // for the load that follows: the high review of #435's medium round, 2)
      // its restarting ones go: nothing restarts it now (the supervisor is
      // cleared), and what it still listed is reloading already
      this.settleEndedDevices(name, why === 'reload' ? {only: 'MODULE_RESTARTING'} : {});
      return callback();
    }
    return callback(new CountinghouseError('UNLOAD_MODULE_FAIL', 'unknown module', name));
  }
};

// R1: a per-session module's unload or reload (the Reviewer's P2/P4): no
// session worker starts from now on (closing), every one running stops and
// is awaited, then the record's devices are purged as a worker's are, and
// the spec it owns is released. A call that reached a session worker before
// it stopped ends as an unload's (or reload's) does.
ModuleManager.prototype.unloadSessionModule = function(name, rec, why, callback) {
  if (rec.unloading === true) {
    // an operator unload arriving during a reload's: it ends as an unload
    if (why !== 'reload') {
      rec.endingFor = 'unload';
      this.markEndedDevices(Object.keys(rec.deviceList || {}), name, 'MODULE_UNLOADED');
      this.settleEndedDevices(name);
    }
    (rec.unloadWaiters = rec.unloadWaiters || []).push(callback);
    return;
  }
  rec.unloading = true;
  rec.closing = true;
  rec.endingFor = (why === 'reload') ? 'reload' : 'unload';
  const code = () => (rec.endingFor === 'reload' ? 'MODULE_RELOADING' : 'MODULE_UNLOADED');
  this.markEndedDevices(Object.keys(rec.deviceList || {}), name, code(), keptOf(rec, name));
  LOG.I(`module: ${name} ending its session workers (${rec.endingFor})`);
  this.sessionWorkers.stopModule(name).then(() => {
    // its workers' late marks too (a reload's workers start their own)
    if (this.lifecycle != null && typeof(this.lifecycle.forgetLateUnder) === 'function') this.lifecycle.forgetLateUnder(`${name}\0`);
    this.markEndedDevices(Object.keys(rec.deviceList || {}), name, code(), keptOf(rec, name));
    this.unloadModule(name, 'CLEANUP MODULE INFO IN MAIN THREAD', () => {
      require('./module-spec').release(rec.moduleSpec);
      callback();
      (rec.unloadWaiters || []).forEach((cb) => cb());
    });
  });
};

// Every running module worker, for what is told to all of them (the live
// options, lib/settings-tool.js broadcastLiveOptions): each module's own,
// and each per-session worker (R1), which the module map doesn't hold. A
// per-session module's record has no worker and is left out.
ModuleManager.prototype.liveWorkers = function() {
  const out = Object.values(this.modules).filter((m) => !isRecord(m));
  if (this.sessionWorkers != null) for (const w of this.sessionWorkers.all()) out.push(w.wm);
  return out;
};

// R1 x #413 section 5.5: what is listed may have changed, for every session
// at once (no session has a view of its own). Each session worker of a
// hidden module stops.
ModuleManager.prototype.sessionViewChanged = function() {
  if (this.sessionWorkers == null) return;
  const visibility = require('./module-visibility');
  if (visibility.none()) return;
  for (const w of this.sessionWorkers.all()) {
    if (visibility.listsModule(w.name) === false) {
      LOG.I(`module: ${w.name}: going on or off; its worker for a session stops (its files are kept)`);
      this.sessionWorkers.stop(w.name, w.sid);
    }
  }
};

// R1: a session's worker of per-session module `name` (lib/session-workers.js
// spawn): from the record's own spec, under its own lock, its /data and /tmp
// the session's partition. Nothing about the session reaches the worker.
ModuleManager.prototype.spawnSessionWorker = function(name, sid, wanted, cb) {
  const rec = this.modules[name];
  if (!isRecord(rec) || rec.closing === true) return cb(new CountinghouseError('MODULE_UNLOADED'));
  // the modules this session ran in this process: its end removes those
  // partitions without looking (R1 Task 6, sessionRanModule); none recorded
  // for a session that has ended (its end has forgotten it)
  if (require('./sessions').live(sid)) {
    if (this.sessionModules == null) this.sessionModules = new Map();
    if (!this.sessionModules.has(sid)) this.sessionModules.set(sid, new Set());
    this.sessionModules.get(sid).add(name);
  }
  const stillWanted = () => wanted() && this.modules[name] === rec && rec.closing !== true;
  this.spawnModuleWorker(rec.hostModulePath, name, rec.version, cb, stillWanted, false, {sid: sid, record: rec});
};

// R1: a session worker ended (its module's unload or reload, its session's
// end, the cap): what it still owed is answered with the unload's or the
// reload's code; resolves once it has exited and its broker settled.
ModuleManager.prototype.endSessionWorker = function(wm) {
  const rec = this.modules[wm.hostModuleName];
  wm.unloading = true;
  wm.endingFor = (isRecord(rec) && rec.endingFor === 'reload') ? 'reload' : 'unload';
  const lockKey = `${wm.hostModuleName}\0${wm.hostSession}`;
  const exited = (wm.exited === true) ? Promise.resolve() : new Promise((resolve) => {
    wm.worker.once('exit', resolve);
    wm.worker.terminate().catch(() => resolve());
  });
  return exited.then(() => this.lifecycle.settled(lockKey)).then(() => {}, () => {});
};

// R1, the Reviewer's P5: one fs quota for all of a module's partitions,
// shared by its session workers and dropped with the last one, so the next
// spawn builds it again. Built at its first session worker's spawn by
// walking <name>/sessions one partition at a time (lstat only, never through
// a link; each walk bounded by the module's limits), each into its session's
// share (R1 Task 6, the reviewer's redesign of 11-17: fs-broker/quota.js
// shareOf), so a session's end gives back exactly its own share
// (creditSessionEnd), with no walk then and no lock. take() resolves to the
// spawning session's view of it.
// -> {take: async () => view | null, release}
ModuleManager.prototype.sessionQuota = function(name, limits, report, sid) {
  if (options.moduleSandbox === 'off' || limits == null) return {take: async () => null, release: () => {}};
  let taken = null;
  let released = false;
  // (the quota this worker took, which a failed build's drop may have taken
  // out of the map meanwhile)
  const release = () => {
    if (taken == null || released) return;
    released = true;
    if (--taken.workers <= 0 && this.sessionQuotas.get(name) === taken) this.sessionQuotas.delete(name);
  };
  const take = async () => {
    let q = this.sessionQuotas.get(name);
    if (q == null) {
      const {Quota} = require('./fs-broker/quota');
      const quota = new Quota({maxBytes: limits.diskMb * 1024 * 1024, maxEntries: limits.diskEntries,
        enforce: options.moduleSandbox === 'enforce', report: report, bytes: 0, entries: 0});
      const sessionsDir = path.join(require('./module-data').dirsFor(options.moduleDataPath, name).root, 'sessions');
      // ready always resolves, never rejects (a session's end and a respawn
      // await it): a walk that throws leaves what it counted, logged
      q = {quota, workers: 0, ready: null, sessionsDir, limits};
      q.ready = buildShares(q);
      this.sessionQuotas.set(name, q);
    } else if (q.quota.buildFailed === true && !q.rebuilding) {
      // a build that couldn't read it all: this spawn builds it again, in
      // place (one quota per module while any worker holds it: every
      // charge and credit goes to the same one). Only the partitions with
      // no share yet are walked: a share made meanwhile is exact for what
      // it charged and unknown for the rest, never counted twice
      q.rebuilding = true;
      q.quota.buildFailed = false;
      q.ready = q.ready.then(() => buildShares(q, (id) => q.quota.shares.has(id))).then((quota) => { q.rebuilding = false; return quota; });
    }
    q.workers++;
    taken = q;
    await q.ready;
    return q.quota.viewFor(sid);
  };
  return {take, release};
};

// <sessions>/<id>, each its own walk into its session's share, a few at a
// time, EVERY one (the reviewer's ruling, 11-17: the first spawn's cost is
// correctness's price; an early stop left partitions uncounted): one whose
// walk fails, or stops past the module's limits (counted to the limit + 1),
// leaves that share unknown (it gives nothing back from a respawn's /tmp),
// and no other. No sessions/ is no
// partition; a sessions/ that can't be read, or isn't a real directory,
// leaves every share unknown (quota.buildFailed).
async function measureShares(quota, sessionsDir, limits, skip = () => false) {
  // sessions/ that can't be read: every share unknown, and the quota built
  // again at the next spawn (sessionQuota drops it), never pinned
  const failed = () => { quota.buildFailed = true; };
  let st = null;
  try { st = await fs.promises.lstat(sessionsDir); } catch (e) { if (e.code !== 'ENOENT') failed(); return; }
  if (!st.isDirectory()) return failed();
  let names;
  try { names = await fs.promises.readdir(sessionsDir); } catch (e) { return failed(); }
  // only a session's id names a partition (as partition.list has it): a
  // stray entry under sessions/ is no session's, and isn't counted
  names = names.filter((id) => SESSION_ID.test(id) && !skip(id));
  const stopAfter = {entries: limits.diskEntries + 1, bytes: limits.diskMb * 1024 * 1024 + 1};
  const walk = require('./fs-broker/spawn-walk');
  // a few at a time (each walk holds a directory open): never all at once
  const queue = names.slice();
  const one = async(id) => {
    const child = path.join(sessionsDir, id);
    let cst = null;
    try { cst = await fs.promises.lstat(child); } catch (e) {
      if (e.code !== 'ENOENT') quota.addMeasured(id, null);   // removed meanwhile: nothing to count
      return;
    }
    if (!cst.isDirectory()) {
      // a file or a link where a partition would be: one entry (its size for a file)
      return quota.addMeasured(id, {bytes: cst.isFile() ? cst.size : 0, entries: 1});
    }
    // (the session root's ownership marker is the runtime's: not counted)
    const usage = await walk.measure([[child, `/sessions/${id}`]], {maxListed: 1, stopAfter, skipTop: require('./data-ownership').isMarkerName}).catch(() => null);
    return quota.addMeasured(id, usage);
  };
  const lane = async() => { while (queue.length > 0) await one(queue.shift()); };
  await Promise.all(Array.from({length: Math.min(BUILD_WALKS, queue.length)}, lane));
}

// every per-session module loaded now (its listing record): the one list a
// session's end works through (lib/session-lifetime.js) and settles
ModuleManager.prototype.perSessionModuleNames = function() {
  const modules = this.modules || {};
  return Object.keys(modules).filter((name) => isRecord(modules[name]));
};

// A session's workers' lifecycle settled, each (module, session) lock: a
// worker that crashed has no pool entry for stopSession to wait on, and its
// broker's last op (a recursive mkdir) could make its partition again after
// the removal. -> Promise
// (each per-session module's lock key, as a spawn takes it: a spawn still in
// its critical section is waited out too, then what it tracked)
// -> Promise of {name: whether it settled}: false for one whose broker was
// still busy when the bound passed (module-lifecycle boundedIdle), whose
// partition its end keeps for the next start's sweep
// names: the per-session modules the end works through (one list for both).
// A worker that settled before this asked is remembered by the lifecycle
// (wentLate), and an unknown state (a rejection) counts as not settled.
ModuleManager.prototype.sessionSettled = function(sid, names = this.perSessionModuleNames()) {
  if (this.lifecycle == null) return Promise.resolve(Object.fromEntries(names.map((n) => [n, true])));
  return Promise.all(names.map((name) => {
    const key = `${name}\0${sid}`;
    return this.lifecycle.run(key, () => {}).then(() => this.lifecycle.settled(key))
      .then((idle) => {
        const late = idle === false || (typeof(this.lifecycle.wentLate) === 'function' && this.lifecycle.wentLate(key));
        if (typeof(this.lifecycle.forgetLate) === 'function') this.lifecycle.forgetLate(key);
        return !late;
      }, () => false);
  })).then((settled) => Object.fromEntries(names.map((n, i) => [n, settled[i]])));
};

// whether this session ran the module in this process (a worker of it was
// spawned for it); and forgetting it all at the session's end
ModuleManager.prototype.sessionRanModule = function(sid, name) {
  const used = (this.sessionModules != null) ? this.sessionModules.get(sid) : null;
  return used != null && used.has(name);
};
ModuleManager.prototype.forgetSessionModules = function(sid) {
  if (this.sessionModules != null) this.sessionModules.delete(sid);
};

// A session's partition of the module removed (lib/session-lifetime.js, after
// its workers stopped and the removal finished): its share leaves the
// module's quota, if one is held, once that quota's build walk has finished
// (q.ready, which always resolves), so the walk can't count it again after.
// Nothing written meanwhile: its workers have stopped, and the pool spawns
// none for it. -> Promise of whether anything was given back
ModuleManager.prototype.creditSessionEnd = async function(name, sid) {
  const q = this.sessionQuotas.get(name);
  if (q == null) return false;
  await q.ready;
  return q.quota.releaseSession(sid);
};

// A session worker's spawn empties its /tmp (fs-broker createForWorker) outside
// the broker: with the module's quota held by another session's worker, what
// that /tmp held leaves the session's share (only files wholly inside it: a
// name in its /data keeps the bytes there), measured before it is emptied and
// given back once it has been. Nothing runs in that /tmp meanwhile: the
// session's worker is the one being spawned. -> Promise
// view: the session's view of the module's quota, which the spawn has
// already taken (fs-broker createForWorker: its build walk done, and held by
// this spawn), or null; it measures only for a known share, bounded by the
// module's limits.
// owner: the broker's (its ownership marker's holder, the session's root,
// and where a kept /tmp is said): a /tmp the runtime did not make is kept,
// and nothing is given back for it.
ModuleManager.prototype.emptySessionTmp = async function(name, sid, tmpDir, view, owner) {
  const walk = require('./fs-broker/spawn-walk');
  const q = this.sessionQuotas.get(name);
  let usage = null;
  if (q != null && view != null && view.base === q.quota) {
    const st = q.quota.knows(sid) ? await fs.promises.lstat(tmpDir).catch(() => null) : null;
    if (st != null && st.isDirectory()) {
      usage = await walk.measure([[tmpDir, '/tmp']], {maxListed: 1, whollyInside: true,
        stopAfter: {entries: q.quota.maxEntries + 1, bytes: q.quota.maxBytes + 1}}).catch(() => null);
      if (usage != null && usage.truncated === true) usage = null;
    }
  }
  const emptied = await walk.emptyTmp(tmpDir, owner);
  if (emptied && usage != null && this.sessionQuotas.get(name) === q) q.quota.releasePart(sid, usage.bytes, usage.entries);
};

// R1: under a session worker's lock (spawnModuleWorker): its broker over the
// session's partition, sharing its module's quota, then its worker from the
// record's spec. Its lock is its own, so sessions never wait on each other.
ModuleManager.prototype.startSessionWorker = async function(name, modulePath, sandbox, sess, sharedQuota, lockKey, startWorker, stillWanted) {
  // given up on (an unload, a stop) at any await below: nothing is started,
  // nothing is left open (the review of #356)
  const superseded = () => Object.assign(new Error('module: a session\'s worker was given up on before it started'), {superseded: true});
  await this.lifecycle.settled(lockKey);
  if (stillWanted != null && !stillWanted()) throw superseded();
  const fsb = await require('./fs-broker').createForWorker({name: name, mode: options.moduleSandbox, modulePath: modulePath,
    declared: sandbox != null ? sandbox.fs : [], options: options, limits: sandbox != null ? sandbox.limits : null,
    pinsDir: path.join(options.moduleDataPath, RECORD_DIR), knownModules: this.knownModuleRoots(), knownDataPath: options.moduleDataPath, session: sess.sid, sharedQuota: sharedQuota.take,
    emptyTmp: (dir, view, owner) => this.emptySessionTmp(name, sess.sid, dir, view, owner),
    report: (rule, target) => LOG.I(`module sandbox: ${name} file ${rule} ${target}`)
  });
  if (stillWanted != null && !stillWanted()) {
    fsb.bridge.close().catch(() => {});
    throw superseded();
  }
  try {
    startWorker(fsb, sess.record.moduleSpec);
  } catch (e) {
    fsb.bridge.close().catch(() => {});
    throw Object.assign(new Error(e.message), {startFailed: true});
  }
};

// R1: a session worker that loaded: the fields its record's device has, so
// the call path treats it as the device's worker; the device-manager's
// handlers (its store under the session's prefix); and the module's
// composition verdict, before it serves a call. Stopped instead if its
// module began closing meanwhile (the Reviewer's P4).
ModuleManager.prototype.sessionWorkerReady = function(wm, rec, done) {
  const own = rec.moduleSpec;
  wm.moduleName = rec.hostModuleName;
  wm.packageInfo = rec.packageInfo;
  wm.modulePath = rec.hostModulePath;
  if (own != null && own.spec != null) wm.deviceList[own.deviceID] = own.spec;
  wm.online = true;
  wm.bindings = rec.bindings;
  this.emit('workerloaded', wm);
  LOG.I(`module: ${rec.hostModuleName}: a session's worker is up`);
  const verdicts = Object.values(rec.verdicts);
  let left = verdicts.length;
  if (left === 0) return done(null, wm);
  for (const v of verdicts) {
    wm.sendSetCompositionMessage(v, () => {
      if (--left === 0) done(null, wm);
    });
  }
};

//when called in main thread, this cleans workerMessage instances saved in deviceMap
//when called in child thread, this cleans device object saved in deviceMap

// Note that under worker thread mode, unloadModule() call is ALWAYS initiated
// from main thread by sending module-unload to worker, but it also run in child
// thread to clean up the deviceMap in it
// the reason system calling this method can be either:
// 1. user initiated module unload from unloadModuleExternal()
// 2. worker thread exit / error exception caught by main thread
// 3. load module fail on worker start up
ModuleManager.prototype.unloadModule = function(name, reason, callback) {
  const m = this.modules[name];

  if (m != null) return this.emit('moduleunload', name, reason, callback);

  return callback();
};

ModuleManager.prototype.onQueryDeviceListResult = function(error, deviceList, packageInfo, callback) {
  if (packageInfo != null && packageInfo.name != null) {
    return callback(error, {packageInfo: packageInfo, deviceList: deviceList});  // in case of error, packageInfo is the original one we passed in to querydevice event, deviceList will be []
  } else {
    return callback(new CountinghouseError('MODULE_PACKAGE_INFO_INVALID'));
  }
};

ModuleManager.whenDiscovered = whenDiscovered;
// A session worker in use (lib/session-workers.js busy): a live token, a
// request under way, or a call held for its module's composition verdict
// (lib/device-manager.js HeldCall). A call past its own deadline (its
// caller answered) and STALE_CALL_MARGIN_MS more isn't, so a handler that
// never answers can't pin the slot (the security pass of 11-17); a job's run
// with no timeout always is.
ModuleManager.workerBusy = (wm) => require('./call-tokens').liveFor(wm.workerId) > 0 || wm.inFlight(Date.now(), STALE_CALL_MARGIN_MS) ||
  require('./device-manager').verdictHeldOn(wm) > 0;
ModuleManager.DISCOVERY_HOLD_MS = DISCOVERY_HOLD_MS;

module.exports = ModuleManager;
module.exports.credentialNamesNow = credentialNamesNow;
module.exports.settleSettings = settleSettings;
module.exports.restartFailed = restartFailed;
