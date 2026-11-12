const events         = require('events');
const util           = require('util');
const options        = require('../lib/cli-options');
const exec           = require('child_process').exec;
const CountinghouseError = require('../lib/countinghouse-error').CountinghouseError;
const LOG            = require('../lib/logger');

const getDeviceConfig = require('./device-config');

const semver      = require('semver');
const rimraf      = require('rimraf');
const fs          = require('fs');
const Domain      = require('domain');
const async       = require('async');
const path        = require('path');

const Worker         = require('worker_threads').Worker;
const isMainThread   = require('worker_threads').isMainThread;
const WorkerMessage  = require('./worker-message');
const workerLimits   = require('./worker-limits');
const moduleSandboxConfig = require('./module-sandbox-config');
const ModuleSupervisor = require('./module-supervisor');
const moduleRoles = require('./module-roles');
const RESERVED_TOOL_NAMES = require('./mcp/tool-name').RESERVED_TOOL_NAMES;

// How long a loaded worker's discovery may take before the devices a reload
// was waiting for are treated as gone (onModuleLoad): three times the
// worker's own discovery timer.
const DISCOVERY_BOUND_MS = 15000;

function ModuleManager() {
  this.modules = {};
  // Package names of the parts a scenario pulled in at --loadModule: loaded,
  // never listed (local-mode spec §3; lib/mcp/tool-registry.js listingOf).
  this.unlisted = new Set();
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
  this.supervisor = (isMainThread === true && options.workerThread === true && options.moduleSandbox !== 'off')
    ? new ModuleSupervisor({
      restart: (name, record) => {
        LOG.I(`module sandbox: ${name} restarting after: ${record.lastReason}`);
        // An operator action while this spawn is in flight clears the record;
        // the spawn then terminates its worker instead of registering it.
        this.spawnModuleWorker(record.modulePath, name, record.version, (err) => {
          if (err == null || !this.supervisor.isCurrent(name, record)) return;
          LOG.E(new Error(`module sandbox: ${name} restart failed: ${err.message}`));
          if (err.code === 'MODULE_SANDBOX_REFUSED') {
            this.supervisor.suspend(name, `restart refused: ${err.message}`);
            return LOG.E(new Error(`module sandbox: ${name} suspended: the sandbox refuses it -- POST /restart-module to try again`));
          }
          const decision = this.supervisor.exited(name, `restart failed: ${err.message}`, record.specs);
          if (decision.action === 'suspend') {
            LOG.E(new Error(`module sandbox: ${name} suspended after repeated exits: ${
              JSON.stringify(this.supervisor.status(name).exits)} -- POST /restart-module to start it again`));
          } else {
            LOG.I(`module sandbox: ${name} restart failed; retrying in ${decision.delayMs} ms`);
          }
        }, () => this.supervisor.isCurrent(name, record));
      }
    })
    : null;

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
  //only print this in child thread when a module is truly loaded, or when worker thread mode is disabled
  if (options.workerThread !== true || !isMainThread) LOG.I(`module: ${name}@${version} loaded`);

  module.discoverState = 'stopped';

  const m = this.modules[name];
  if (m != null) {
    // module reloaded
    if (m.discoverState === 'discovering') {
      m.discoverState = 'stopped';
    }
    this.emit('purgedevice', m, 'MODULE RELOADED', () => {
      this.modules[name] = module;
    }); // to be handled by device manager
    // Backstop: a replaced worker must not outlive its module entry.
    if (m !== module && m instanceof WorkerMessage && m.worker != null) {
      m.worker.terminate().catch(() => {});
    }
  } else {
    this.modules[name] = module;
  }


  const _mm = this;

  if (options.workerThread === true && isMainThread === true) {
    //worker thread mode and run in main thread
    _mm.emit('modulediscovering');

    module.discoverState = 'discovering';

    // The worker answers discovery on its own 5 s timer (lib/sandbox.js), so
    // one that has not answered by this bound is blocked by its module --
    // and with the sandbox off nothing else would end it. It is unloaded,
    // as an operator would (no supervisor restart: it would only block
    // again): its devices are MODULE_UNLOADED, and the worker is terminated
    // once the unload's acknowledgement timer runs out. A lifecycle rule,
    // in every sandbox mode, like that timer. Not for a worker already being
    // unloaded (a reload's 3 s acknowledgement window, say): that unload ends
    // it, and as what it is.
    const discoveryBound = setTimeout(() => {
      if (module.discoverState !== 'discovering' || module.unloading === true || _mm.modules[name] !== module) return;
      LOG.E(new Error(`module: ${name}: discovery did not finish within ${DISCOVERY_BOUND_MS / 1000} s; worker terminated`));
      _mm.settleEndedDevices(name);
      _mm.unloadModuleExternal(name, () => {});
    }, DISCOVERY_BOUND_MS);
    if (typeof(discoveryBound.unref) === 'function') discoveryBound.unref();

    module.sendDiscoverMessage({}, () => {
      clearTimeout(discoveryBound);
      module.discoverState = 'stopped';
      // Discovery is over: a device of the old code that did not come back
      // online is gone for good. Only for the worker still serving the
      // module: a replaced worker's pending discovery is answered when it
      // ends (WorkerMessage.endWith) and must not settle the reload that
      // replaced it.
      if (_mm.modules[name] === module) _mm.settleEndedDevices(name);

      if (_mm.modules[name] != null) {
        _mm.noofLoadedModules ++;

        if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules > _mm.noofTotalModules) {
          // this can happen if we reload an existing module and resend discover message
          _mm.noofLoadedModules = _mm.noofTotalModules;
        }
        // `noofTotalModules === 0` is the bare-instance case: nothing was
        // preloaded, so there is no startup total to reach and each runtime
        // load is by itself a completed discovery. Without this arm the event
        // never fires again on such an instance, which left a module loaded
        // through countinghouse_load_module unverified and therefore unable to
        // ctx.call at all -- in exactly the --authoringTools setup that is
        // designed to start with no modules. The same condition appears at the
        // other emit sites in this file for the same reason.
        if (_mm.noofTotalModules === 0 || _mm.noofLoadedModules === _mm.noofTotalModules) {
          LOG.I('all module discovered');
          _mm.emit('allmodulediscovered');
        }
      }
    });
  } else if (options.workerThread === false && isMainThread === true) {
    //non worker-thread mode
    _mm.emit('modulediscovering'); //is this event garenteed handled before next event?

    module.emit('discover');
    module.discoverState = 'discovering';

    setTimeout(function() {
      this.emit('stopdiscover');
      this.discoverState = 'stopped';

      _mm.noofLoadedModules ++;
      // if an independent module is loaded during run time, noofLoadedModules would be larger than noofTotalModules
      // in this case we emit allmodulesloaded event again to let device manager cleanup remaining notifyDeviceLoad callbacks if any
      // this allows createServiceClient to be called at any place in the user code at any time
      if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules > _mm.noofTotalModules) {
        // this can happen if we reload an existing module and resend discover message
        _mm.noofLoadedModules = _mm.noofTotalModules;
      }

      if (_mm.noofTotalModules === 0 || _mm.noofLoadedModules === _mm.noofTotalModules) {
        LOG.I('all module discovered');
        _mm.emit('allmodulediscovered');
      }
    }.bind(module), 5000);
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
      try {
        JSON.parse(fs.readFileSync(`${item}/package.json`).toString());
        dirs.push(item);
      } catch (e) {
        LOG.E(new CountinghouseError('LOAD_MODULE_FAIL', 'invalid package.json file:', item));
      }
    } else {
      LOG.E(new CountinghouseError('LOAD_MODULE_FAIL', 'invalid path or package.json file not found:', item));
    }
  });

  // A scenario brings its parts, unlisted; a scenario with a part missing or
  // a tool name taken is not loaded, and the log says why (local-mode spec §3).
  // Expansion must never stop a start: if it throws anyway, the modules load
  // as given, every one listed, as before roles existed, and the log says so.
  let load, refused;
  try {
    ({load, refused} = moduleRoles.expandLoadList(dirs, {reserved: RESERVED_TOOL_NAMES}));
  } catch (e) {
    LOG.E(new CountinghouseError('LOAD_MODULE_FAIL', `scenario expansion failed, loading the modules as given: ${e.message}`));
    refused = [];
    load = dirs.map((dir) => {
      const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`).toString());
      return {path: dir, name: pkg.name, version: pkg.version, listed: true};
    });
  }
  for (const r of refused) {
    const why = r.code === 'PART_MISSING' ? `${r.name} calls ${r.part}, which is not installed beside it`
      : `${r.name}: its tool ${r.tool} is already ${r.with === 'a runtime built-in' ? 'a runtime built-in' : `the tool of ${r.with}`}`;
    LOG.E(new CountinghouseError(r.code, why));
  }
  for (const m of load) if (m.listed === false) this.unlisted.add(m.name);
  return load.map((m) => ({path: m.path, name: m.name, version: m.version}));
};

// This function is only run in main thread
// to load a local module specified by --loadModule CLI option
// or load all modules according to sqlite db info
ModuleManager.prototype.loadAllModules = function() {
  const _this = this;
  const _mm   = this;

  // in case loading local module, we won't read module info from DB, instead read its info from package.json
  if (options.localModulePath != null) {
    const info = this.getModuleInfoFromPath(options.localModulePath);
    if (info == null) return;

    this.noofTotalModules = info.length;

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

    async.eachSeries(info, (item, cb) => {
      _this.loadModuleFromPath(item.path, item.name, item.version, (err, mi) => {
        LOG.I(`load local module from path: ${item.path}`);

        if (err != null) {
          LOG.E(err);
          _mm.noofLoadedModules ++;

          if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules > _mm.noofTotalModules) {
            _mm.noofLoadedModules = _mm.noofTotalModules;
          }
          if (_mm.noofTotalModules === 0 || _mm.noofLoadedModules === _mm.noofTotalModules) {
            LOG.I('all module discovered');
            _mm.emit('allmodulediscovered');
          }
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

      if (this.noofTotalModules === 0) {
        // Same reasoning as the localModulePath branch above: zero modules is a
        // finished discovery, and saying so is what lets verifyComposition and
        // allDevicesLoaded behave on a bare instance.
        LOG.I('all module discovered');
        this.emit('allmodulediscovered');
      }

      async.eachSeries(data, (item, cb) => {
        _this.loadModuleFromPath(item.path, item.name, item.version, (err, mi) => {
          // in case of load fail (exception thrown while loading the module), we increase noofLoadedModules
          // so we don't block 'allmoduleloaded' event emission after all module loaded
          // in normal case where no exceptions occured, noofLoadedModules increment is done after discover message is delivered
          // which indicates module is successfully loaded
          if (err != null) {
            LOG.E(err);
            _mm.noofLoadedModules ++;

            if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules > _mm.noofTotalModules) {
              _mm.noofLoadedModules = _mm.noofTotalModules;
            }
            if (_mm.noofTotalModules === 0 || _mm.noofLoadedModules === _mm.noofTotalModules) {
              LOG.I('all module discovered');
              _mm.emit('allmodulediscovered');
            }
          }
          return cb();
        });
      }, (err) => {
        // _this.noofTotalModules = _this.noofAvailableModules;
      });
    });
  }
};

//this is a sync call if not enabled worker thread
//TODO: load module from existing thread if already existed
// Resolve a module directory to a live module instance, whichever shape it is:
// a 6.0.0 handler map (plain export or handlers/ tree) or the 5.x
// class/EventEmitter that does its own discovery.
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
  const CHUtil           = require('./countinghouse-util');
  const handlerMapModule = require('./handler-map-module');

  const moduleRoot = path.resolve(modulePath);
  purgeRequireCache(moduleRoot);

  let moduleConstructor = null;
  // A handler-map module may have no main entry at all (the handlers/
  // convention), so failing to load one is not yet fatal -- only failing to
  // find *either* shape is.
  try {
    moduleConstructor = require(require('./fs-broker/identity').specifierFor(moduleRoot));
  } catch (e) {
    moduleConstructor = null;
  }

  const resolved = handlerMapModule.resolveHandlerMap(modulePath, moduleConstructor,
                                                      (file) => CHUtil.loadFile(file));
  if (resolved != null) {
    return {instance: handlerMapModule.assemble(modulePath, name, resolved.handlerMap, resolved.source),
            isHandlerMap: true};
  }

  if (moduleConstructor == null) throw new CountinghouseError('INVALID_MODULE_PATH', modulePath);
  //TODO: support loading 3rd party npm packages and publish them to our own registry
  //this would allow user publish and use a missing npm package in closed network environment
  return {instance: new moduleConstructor(), isHandlerMap: false};
};

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
    pkgName = JSON.parse(fs.readFileSync(path.join(String(modulePath), 'package.json'), 'utf8')).name;
  } catch (e) {
    return null;
  }
  if (typeof(pkgName) !== 'string' || pkgName === name) return null;
  return new CountinghouseError('MODULE_NAME_MISMATCH', name, pkgName);
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
function registerRemotes(name, modulePath) {
  const remote = require('./remote');
  const registered = remote.register(name, modulePath);
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

ModuleManager.prototype.loadModuleFromPath = function(modulePath, name, version, callback, deviceConfig) {
  const outside = outsideHardenedRoot(modulePath);
  if (outside != null) return callback(outside);
  const mismatch = nameMismatch(modulePath, name);
  if (mismatch != null) return callback(mismatch);
  if (options.workerThread === true && isMainThread === true) {
    return this.loadModuleByWorker(modulePath, name, version, (err, mi) => {
      // if (err) LOG.E(new CountinghouseError('LOAD_MODULE_FAIL', err.message));

      return callback(err, mi);
    });
  }
  if (typeof(modulePath) !== 'string' || !fs.existsSync(modulePath)) return callback(new CountinghouseError('INVALID_MODULE_PATH', modulePath));

  // Single-thread (debug) mode: the module's data directories, /tmp emptied,
  // and the module registered with the path facade before its code loads
  // (part 2 spec, section 6). Worker mode does this in the main thread's spawn.
  if (isMainThread === true && options.workerThread !== true) {
    const moduleData = require('./module-data');
    moduleData.ensureDirs(options.moduleDataPath, name)
      .then((dirs) => require('./fs-broker/spawn-walk').emptyTmp(dirs.tmp).then(() => dirs))
      .then((dirs) => {
        require('./single-thread-facade').register(fs.realpathSync.native(modulePath), {name: name, data: dirs.data, tmp: dirs.tmp});
      })
      .then(() => {
        const remotes = registerRemotes(name, modulePath);
        if (remotes.refused != null) return callback(remotes.refused);
        return this.loadModuleCode(modulePath, name, version, remotes.failed(callback), deviceConfig);
      },
        (e) => callback(new CountinghouseError('LOAD_MODULE_FAIL', name, `module data: ${e.message}`)));
    return;
  }
  return this.loadModuleCode(modulePath, name, version, callback, deviceConfig);
};

// The module's code, in this thread: single-thread mode, or a module worker.
ModuleManager.prototype.loadModuleCode = function(modulePath, name, version, callback, deviceConfig) {
  let moduleInstance = null;
  let packageInfo    = null;

  let isHandlerMapModule = false;

  try {
    packageInfo = JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json')).toString());

    const resolved     = this.instantiateModule(modulePath, name);
    moduleInstance     = resolved.instance;
    isHandlerMapModule = resolved.isHandlerMap;
  } catch (e) {
    LOG.E(new CountinghouseError('LOAD_MODULE_FAIL', name, e.message, e.stack));
    return callback(e);
  }

  // A module whose entry point isn't a device *module* can never come online:
  // discovery works by emitting 'discover' at this instance and waiting for it
  // to emit 'deviceonline' (see discoverAllDevices below and any bundled
  // module's index.js). If nothing is listening for 'discover', that handshake
  // silently never happens -- the module loads, reports success, and then
  // simply never appears in tools/list with no error anywhere.
  //
  // The overwhelmingly common cause is package.json's `main` pointing at
  // device.js (the CHDevice subclass) instead of index.js (the DeviceModule
  // that constructs it) -- an easy mistake to make, and previously an
  // undiagnosable one. Checked here rather than by waiting to see whether a
  // device shows up, so the message arrives immediately and deterministically.
  //
  // Only meaningful for the legacy shape. A handler-map module gets its
  // 'discover' listener from the framework's own shim, so it can never fail
  // this check -- and the advice below, about package.json "main" and
  // index.js, would be actively misleading for one.
  if (isHandlerMapModule !== true &&
      (typeof(moduleInstance.listenerCount) !== 'function' || moduleInstance.listenerCount('discover') === 0)) {
    LOG.E(new CountinghouseError('MODULE_NOT_DISCOVERABLE', name,
      'its main entry point registers no "discover" listener, so it can never emit "deviceonline" ' +
      'and its devices will never load. package.json "main" must point at the device *module* ' +
      '(conventionally index.js, which does this.on("discover", ...) and emits "deviceonline" ' +
      'with a new Device()), not at the CHDevice subclass in device.js. ' +
      'See docs/module-development.md'));
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
    return (this.modules[name] != null || this.lifecycle.live(name) != null) ? 'loaded' : null;
  };
  const state = busy();
  if (state != null) return callback(new CountinghouseError('MODULE_LOADED', name, state));
  this.lifecycle.run(name, async () => {
    // Checked again inside the lock, before waiting: a load that won the lock
    // has a live worker, whose settle would never come while it runs.
    const now = busy();
    if (now != null) throw new CountinghouseError('MODULE_LOADED', name, now);
    await this.lifecycle.settled(name);   // a worker that exited: its broker finishing
    // The registry first (used only when no --loadModule is given): if it
    // fails, nothing has been deleted yet and the error says so.
    let registryEntryRemoved = false;
    if (options.localModulePath == null) {
      registryEntryRemoved = await new Promise((resolve, reject) => require('./device-db').removeModuleInfo(name, function(e) {
        // sqlite3 calls back with the statement as `this`: changes is the number of rows removed
        if (e) return reject(new CountinghouseError('REMOVE_MODULE_INFO_FAIL', name, e.message));
        return resolve(this != null && this.changes > 0);
      }));
    }
    let dataDeleted = false;
    if (keepData !== true) {
      const root = moduleData.dirsFor(options.moduleDataPath, name).root;
      const st = await fsp.lstat(root).catch(() => null);
      if (st != null) {
        if (!st.isDirectory()) throw new CountinghouseError('MODULE_DATA_NOT_DIRECTORY', name, root);
        await fsp.rm(root, {recursive: true, force: true});
        dataDeleted = true;
        // A scoped name leaves <store>/@scope behind: remove it when empty (review M2).
        if (name.startsWith('@')) await fsp.rmdir(path.dirname(root)).catch(() => {});
      }
    }
    return {name: name, dataDeleted: dataDeleted, registryEntryRemoved: registryEntryRemoved};
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
// startup, never following a link.
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
    sandbox = moduleSandboxConfig.build(resolved, name, {mode: options.moduleSandbox, modulePolicy: options.modulePolicy, serverEnv: process.env, redisUrl: options.redisUrl});
  } catch (e) {
    return failed('validateModuleSandbox', e.message);
  }
  if (sandbox != null && sandbox.refusal != null && options.moduleSandbox === 'enforce') {
    return failed('validateModuleSandbox', `refused under enforce, the module's code was not run: ${sandbox.refusal}`);
  }

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
    limits: sandbox != null ? sandbox.limits : null, report: (rule, target) => LOG.I(`validate: ${shown} file ${rule} ${target}`)
  }).then((created) => {
    fsb = created;
    worker = new Worker(`${__dirname}/sandbox.js`, Object.assign({}, sandbox != null ? sandbox.workerOptions : {},
      {workerData: {fsBridge: fsb.bridge.transfer, moduleRoot: fsb.moduleRoot, installDir: fsb.installDir, codeRoots: fsb.codeRoots,
        validateOnly: true}, transferList: fsb.bridge.transferList}));
    const wm = new WorkerMessage(worker);
    // Nothing the main thread serves is open to it: refused, by name, in the log.
    worker.on('message', (msg) => {
      if (msg == null || msg.category !== 'child' || msg.command === 'sandbox-violation') return;
      LOG.I(`validate: refused ${String(msg.command).slice(0, 64)} from the worker validating ${shown}`);
      if (msg.id != null) worker.postMessage({command: 'refused-reply', msgID: msg.id, errMsg: 'a validation has no main-thread services', errCode: 'VALIDATE_REFUSED'});
    });
    if (sandbox != null) {
      wm.messageRate = options.moduleMessageRate;
      wm.rateTokens  = options.moduleMessageRate;
    }
    worker.on('error', (e) => finish(null, {ok: false, module: shown, problems: [{stage: 'validateModuleSandbox', module: shown,
      message: `the module ended its validation: ${e.message}`, fix: 'Check the module\'s main entry for anything that throws, exits or runs away while being required.'}]}));
    worker.on('exit', (code) => finish(null, {ok: false, module: shown, problems: [{stage: 'validateModuleSandbox', module: shown,
      message: `the module ended its validation (exit code ${code})`, fix: 'Check the module\'s main entry for a process.exit() call.'}]}));
    timer = setTimeout(() => finish(null, {ok: false, module: shown, problems: [{stage: 'validateModuleSandbox', module: shown,
      message: `the validation did not finish within ${timeoutMs} ms`, fix: 'Check the module\'s main entry for an infinite loop or a wait that never ends.'}]}), timeoutMs);
    wm.sendSetOptionsMessage({options: options.getOptionsForWorker(), sandbox: sandbox != null ? sandbox.lockdown : null}, (err) => {
      if (err) return finish(null, {ok: false, module: shown, problems: [{stage: 'validateModuleSandbox', module: shown, message: err.message, fix: null}]});
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
ModuleManager.prototype.nextGeneration = function(name) {
  this.generations[name] = (this.generations[name] || 0) + 1;
  return this.generations[name];
};

ModuleManager.prototype.loadModuleByWorker = function(modulePath, name, version, callback) {
  if (this.supervisor != null) this.supervisor.clear(name);
  const gen = this.nextGeneration(name);
  const current = () => this.generations[name] === gen;
  // A load that fails leaves a reload's devices unloaded. One that succeeds
  // clears nothing yet: each device's entry goes when the device comes back
  // online, and once discovery is over any left (a device the new code no
  // longer has) are unloaded (onModuleLoad). A superseded load settles
  // nothing: the action that superseded it decides.
  const settle = (err, data) => {
    this.spawnsPending[name] = (this.spawnsPending[name] || 1) - 1;
    if (!current()) return callback(new CountinghouseError('MODULE_LOAD_SUPERSEDED', name));
    if (err != null) this.settleEndedDevices(name);
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

ModuleManager.prototype.markEndedDevices = function(deviceIDs, name, code) {
  deviceIDs.forEach((id) => { this.endedDevices[id] = {code: code, name: name}; });
};

// The module's devices still recorded as reloading or restarting will not
// come back.
ModuleManager.prototype.settleEndedDevices = function(name) {
  for (const id in this.endedDevices) {
    const e = this.endedDevices[id];
    if (e.name === name && (e.code === 'MODULE_RELOADING' || e.code === 'MODULE_RESTARTING')) e.code = 'MODULE_UNLOADED';
  }
};

// Its device is back in the device map (DeviceManager, on 'deviceonline').
ModuleManager.prototype.clearEndedDevice = function(deviceID) {
  delete this.endedDevices[deviceID];
};

ModuleManager.prototype.endedStateForDevice = function(deviceID) {
  return this.endedDevices[deviceID] || null;
};

// stillWanted (optional): asked once the worker has loaded the module; false
// terminates the worker instead of registering it.
// operator (optional): true for an operator's load, reload or restart, which
// replaces a live worker of the name; a supervisor restart stands down.
ModuleManager.prototype.spawnModuleWorker = function(modulePath, name, version, callback, stillWanted, operator) {
  const outside = outsideHardenedRoot(modulePath);
  if (outside != null) return callback(outside);
  // Repeated here: restartModule and supervised restarts reach the spawn
  // without loadModuleFromPath.
  const mismatch = nameMismatch(modulePath, name);
  if (mismatch != null) return callback(mismatch);
  let sandbox = null;
  try {
    sandbox = moduleSandboxConfig.build(modulePath, name,
      {mode: options.moduleSandbox, modulePolicy: options.modulePolicy, serverEnv: process.env, redisUrl: options.redisUrl});
  } catch (e) {
    return callback(new CountinghouseError('LOAD_MODULE_FAIL', name, e.message));
  }
  if (sandbox != null) {
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
  const remotes = registerRemotes(name, modulePath);
  if (remotes.refused != null) return callback(remotes.refused);
  callback = remotes.failed(callback);

  // The worker's file broker is built first (data directories, namespace,
  // bridge); the worker receives its end of the bridge in workerData.
  const startWorker = (fsb) => {
    const worker = new Worker(`${__dirname}/sandbox.js`, Object.assign({}, sandbox != null ? sandbox.workerOptions : {},
      {workerData: {fsBridge: fsb.bridge.transfer, moduleRoot: fsb.moduleRoot, installDir: fsb.installDir, codeRoots: fsb.codeRoots}, transferList: fsb.bridge.transferList})); //this is the name under release mode
    // The lifecycle lock's view of this worker: live until it exits, settled
    // once its bridge is closed and its broker idle (review I5).
    const workerExited = new Promise((resolve) => worker.once('exit', resolve));
    const brokerSettled = require('./module-lifecycle').settleAfterExit({exited: workerExited, closeBridge: () => fsb.bridge.close(),
      broker: fsb.broker, name: name, log: (line) => LOG.E(new Error(line)), onSettled: () => LOG.I(`file broker: ${name} settled`)});
    this.lifecycle.track(name, {exited: workerExited, settled: brokerSettled, terminate: () => worker.terminate()});
    const workerMessage = new WorkerMessage(worker);
    workerMessage.sandboxLimits = sandbox != null ? sandbox.limits : null;
    workerMessage.violationCount = 0;
    workerMessage.killReason = null;
    // RC1-min: ctx.call('remote:...') from this worker, answered for this
    // worker's module (`name` here), never for a name the worker states.
    workerMessage.on('remote-call', (message) => {
      const d = (message.data != null && typeof(message.data) === 'object') ? message.data : {};
      require('./remote').callRemote(name, d.remote, d.tool, d.args, {billingKey: d.billingKey}).then(
        (result) => workerMessage.sendRemoteCallReplyToChild({msgID: message.id, result: result, errMsg: null}),
        (err) => workerMessage.sendRemoteCallReplyToChild(Object.assign({msgID: message.id, result: null}, CountinghouseError.replyFields(err))));
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
    const isCurrent = () => this.modules[name] === workerMessage;

    // The spawn calls back once: on load, on a refusal from the worker, or when
    // the worker ends before the module has loaded.
    let loaded = false;
    let settled = false;
    const done = (err, data) => {
      if (settled) return;
      settled = true;
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
      if (!isCurrent()) return;   // a deliberate unload already took the module off this worker
      if (workerMessage.unloading === true) return;   // an operator unload is under way; its own timer finishes it

      // A restarted worker that exits before discovery brought its devices
      // back still has them: the ones still marked ended carry over from the
      // previous exit, so they stay listed and answer the supervisor's state.
      const specs = {};
      const previous = (this.supervisor != null) ? this.supervisor.previousSpecs(name) : {};
      for (const id in previous) {
        const ended = this.endedDevices[id];
        if (ended != null && ended.name === name) specs[id] = previous[id];
      }
      Object.assign(specs, workerMessage.deviceList);
      // With no supervisor the module stays down. With one it restarts: the
      // supervisor's own state answers until the restarted worker is
      // running, this entry until its devices are back (after discovery).
      this.markEndedDevices(Object.keys(specs), name, this.supervisor == null ? 'MODULE_UNLOADED' : 'MODULE_RESTARTING');
      this.unloadModule(name, this.supervisor == null ? offText : `WORKER EXIT: ${exitReason}`, () => {
        if (this.supervisor == null) return;
        const decision = this.supervisor.exited(name, exitReason, specs);
        if (decision.action === 'suspend') {
          LOG.E(new Error(`module sandbox: ${name} suspended after repeated exits: ${
            JSON.stringify(this.supervisor.status(name).exits)} -- POST /restart-module to start it again`));
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
      const why = (workerMessage.endingFor === 'reload') ? 'MODULE_RELOADING'
        : (workerMessage.unloading === true) ? 'MODULE_UNLOADED'
          : (this.supervisor != null && loaded) ? 'MODULE_RESTARTING' : 'MODULE_UNLOADED';
      workerMessage.endWith(why, name, exitReason || `exit code ${exitCode}`);
    });

    // worker.threadId is a real, unique-per-Worker-instance identifier Node
    // already provides -- used as-is for "workerId" throughout the direct
    // peer channel feature (docs/direct-peer-channels-design.md) rather
    // than inventing a parallel ID scheme. A restart gets a new worker and so
    // a new workerId; channels to the old one are invalidated by the unload
    // (DeviceManager.prototype.onPurgeDevice), not by noticing the ID change.
    workerMessage.workerId = worker.threadId;

    workerMessage.sendSetOptionsMessage({options: options.getOptionsForWorker(), sandbox: sandbox != null ? sandbox.lockdown : null}, (err, data) => {
      if (err) {
        worker.terminate();
        return done(err, data);
      }
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
          loaded = true;
          if (this.supervisor != null) this.supervisor.track(name, {modulePath: modulePath, version: version});
          if (workerMessage.sandboxLimits != null) {
            workerMessage.messageRate = options.moduleMessageRate;
            workerMessage.rateTokens  = options.moduleMessageRate;
          }
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
  this.lifecycle.run(name, async () => {
    // Given up on while queued (a later operator action): no worker starts.
    if (stillWanted != null && !stillWanted()) throw Object.assign(new Error('module sandbox: spawn superseded by a later operator action'), {superseded: true});
    const live = this.lifecycle.live(name);
    if (live != null) {
      if (stillWanted != null && operator !== true) throw Object.assign(new Error('module sandbox: restart superseded by an operator action'), {superseded: true});
      await live.terminate();
    }
    await this.lifecycle.settled(name);
    LOG.I(`file broker: ${name} spawn walk`);
    const fsb = await require('./fs-broker').createForWorker({name: name, mode: options.moduleSandbox, modulePath: modulePath,
      declared: sandbox != null ? sandbox.fs : [], options: options, limits: sandbox != null ? sandbox.limits : null,
      report: (rule, target) => LOG.I(`module sandbox: ${name} file ${rule} ${target}`)
    });
    // A synchronous throw in startWorker (new Worker refusing its options,
    // say) must still answer the load and release the broker (review I1).
    try {
      startWorker(fsb);
    } catch (e) {
      fsb.bridge.close().catch(() => {});
      throw Object.assign(new Error(e.message), {startFailed: true});
    }
  }).then(() => {}, (e) => {
    if (e != null && e.superseded === true) return callback(e);
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

  try {
    packageInfo = JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json')).toString());
    name    = packageInfo.name;
    version = packageInfo.version;

    if (typeof(name) !== 'string') {
      return callback(new CountinghouseError('MODULE_PACKAGE_NAME_TYPE_ERROR', name));
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
      return this.loadModuleByWorker(modulePath, name, version, callback);
    }

    // Single-thread: the remote is registered again (its old client closed,
    // a changed declaration read), as a worker's spawn does.
    const remotes = registerRemotes(name, modulePath);
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
  if (m == null) return this.loadModuleByWorker(modulePath, name, version, callback);

  if (options.workerThread !== true || isMainThread !== true) {
    return this.loadModuleFromPath(modulePath, name, version, callback);
  }

  // The restart's own action, taken now: an operator unload or reload that
  // arrives while the old worker is still being ended outranks it, and the
  // continuation then stands down instead of bringing the module back (the
  // worker can take up to 3 s to acknowledge).
  const gen = this.nextGeneration(name);
  this.unloadModuleExternal(name, () => {
    if (this.generations[name] !== gen) return callback(new CountinghouseError('MODULE_LOAD_SUPERSEDED', name));
    this.loadModuleByWorker(modulePath, name, version, (err, mi) => {
      if (err) LOG.E(new CountinghouseError('LOAD_MODULE_FAIL', err.message));
      return callback(err, mi);
    });
  }, 'reload');
};

// `why` is 'reload' when a new worker replaces this one (loadModuleByWorker,
// restartModule): what the old worker had in flight then fails
// MODULE_RELOADING rather than MODULE_UNLOADED.
ModuleManager.prototype.unloadModuleExternal = function(name, callback, why) {
  const wasSupervised = this.supervisor != null && this.supervisor.status(name) != null;
  if (this.supervisor != null) this.supervisor.clear(name);
  // An operator's unload is an action of its own (a 'reload' unload is part
  // of the reload's): a reload still bringing its worker up is cancelled.
  if (why !== 'reload') this.nextGeneration(name);
  const m = this.modules[name];
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
        this.markEndedDevices(Object.keys(m.deviceList || {}), name, m.endingFor === 'reload' ? 'MODULE_RELOADING' : 'MODULE_UNLOADED');
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
      this.markEndedDevices(Object.keys(m.deviceList || {}), name, m.endingFor === 'reload' ? 'MODULE_RELOADING' : 'MODULE_UNLOADED');
      // The worker is told why it ends, so it answers what reaches it after
      // its own devices are purged with that code too (lib/sandbox.js).
      m.sendUnloadModuleMessage({name: name, why: m.endingFor}, finish);
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
      this.settleEndedDevices(name);
      return callback();
    }
    return callback(new CountinghouseError('UNLOAD_MODULE_FAIL', 'unknown module', name));
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

ModuleManager.prototype.loadModuleUnsafe = function(modulePath, name, version, packageInfo, apiDesignID, callback) {
  const _this = this;
  const moduleInstance = null;

  // use domain here to catch and report error info in module's device obj constructor code
  const unsafeDomain = Domain.create();
  unsafeDomain.on('error', (err) => {
    return callback(new CountinghouseError('MODULE_INSTALL_FAIL', err.stack), {packageInfo: packageInfo, deviceList: [], moduleInstallPath: modulePath});
  });

  unsafeDomain.run(() => { _this.loadModuleAndQueryDevice(modulePath, name, version, packageInfo, callback); });
};

ModuleManager.prototype.loadModuleAndQueryDevice = function(modulePath, name, version, packageInfo, callback) {
  this.loadModuleFromPath(modulePath, name, version, (e, mi) => {
    if (e != null) return callback(new CountinghouseError('MODULE_INSTALL_FAIL', name, e.message, e.stack), {packageInfo: packageInfo, deviceList: [], moduleInstallPath: modulePath});
    moduleInstance = mi;

    //give time to allow device online
    setTimeout(() => {
      //get the list of device objects which belongs to moduleInstance
      //this event is handled by device manager
      this.emit('querydevicelist', moduleInstance, packageInfo, (err, info) => {
        if (info != null) { info.moduleInstallPath = modulePath }; //append module install path to return result
        return callback(err, info);
      });
    }, 2000);
  });
};

ModuleManager.prototype.onQueryDeviceListResult = function(error, deviceList, packageInfo, callback) {
  if (packageInfo != null && packageInfo.name != null) {
    return callback(error, {packageInfo: packageInfo, deviceList: deviceList});  // in case of error, packageInfo is the original one we passed in to querydevice event, deviceList will be []
  } else {
    return callback(new CountinghouseError('MODULE_PACKAGE_INFO_INVALID'));
  }
};

module.exports = ModuleManager;
