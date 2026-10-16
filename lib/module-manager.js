const events         = require('events');
const util           = require('util');
const options        = require('../lib/cli-options');
const exec           = require('child_process').exec;
const CHError      = require('../lib/countinghouse-error').CHError;
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

function ModuleManager() {
  this.modules = {};
  this.noofTotalModules = 0;
  // this.noofAvailableModules = 0;
  this.noofLoadedModules = 0;

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

    module.sendDiscoverMessage({}, () => {
      module.discoverState = 'stopped';

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
    LOG.E(new CHError('CORRESPONDING_MODULE_NOT_FOUND', 'device online'));
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
    LOG.E(new CHError('CORRESPONDING_MODULE_NOT_FOUND', 'device offline'));
  }
};

ModuleManager.prototype.getModuleInfoFromPath = function(pathList) {
  let list = [];

  if (typeof(pathList) === 'string') {
    list.push(pathList);
  } else if (Array.isArray(pathList)) {
    list = pathList;
  } else {
    LOG.E(new CHError('LOAD_MODULE_FAIL', 'invalid loadModule argument:', pathList));
    return null;
  }

  const info = [];

  list.forEach((item) => {
    if (fs.existsSync(item) && fs.existsSync(`${item}/package.json`)) {
      try {
        const packageInfo = JSON.parse(fs.readFileSync(`${item}/package.json`).toString());
        info.push({path: item, name: packageInfo.name, version: packageInfo.version});
      } catch (e) {
        LOG.E(new CHError('LOAD_MODULE_FAIL', 'invalid package.json file:', item));
      }
    } else {
      LOG.E(new CHError('LOAD_MODULE_FAIL', 'invalid path or package.json file not found:', item));
    }
  });
  return info;
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
        return LOG.E(new CHError('GET_MODULE_INFO_FAIL', err.message));
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
    moduleConstructor = require(moduleRoot);
  } catch (e) {
    moduleConstructor = null;
  }

  const resolved = handlerMapModule.resolveHandlerMap(modulePath, moduleConstructor,
                                                      (file) => CHUtil.loadFile(file));
  if (resolved != null) {
    return {instance: handlerMapModule.assemble(modulePath, name, resolved.handlerMap, resolved.source),
            isHandlerMap: true};
  }

  if (moduleConstructor == null) throw new CHError('INVALID_MODULE_PATH', modulePath);
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
function outsideHardenedRoot(modulePath) {
  if (options.hardened !== true || isMainThread !== true) return null;
  if (require('./hardened-launch').insideRoot(String(modulePath), options.modulePath)) return null;
  return new CHError('MODULE_PATH_OUTSIDE_ROOT', modulePath);
}

ModuleManager.prototype.loadModuleFromPath = function(modulePath, name, version, callback) {
  const outside = outsideHardenedRoot(modulePath);
  if (outside != null) return callback(outside);
  if (options.workerThread === true && isMainThread === true) {
    return this.loadModuleByWorker(modulePath, name, version, (err, mi) => {
      // if (err) LOG.E(new CHError('LOAD_MODULE_FAIL', err.message));

      return callback(err, mi);
    });
  }

  let moduleInstance = null;
  let packageInfo    = null;

  if (typeof(modulePath) !== 'string' || !fs.existsSync(modulePath)) return callback(new CHError('INVALID_MODULE_PATH', modulePath));

  let isHandlerMapModule = false;

  try {
    packageInfo = JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json')).toString());

    const resolved     = this.instantiateModule(modulePath, name);
    moduleInstance     = resolved.instance;
    isHandlerMapModule = resolved.isHandlerMap;
  } catch (e) {
    LOG.E(new CHError('LOAD_MODULE_FAIL', name, e.message, e.stack));
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
    LOG.E(new CHError('MODULE_NOT_DISCOVERABLE', name,
      'its main entry point registers no "discover" listener, so it can never emit "deviceonline" ' +
      'and its devices will never load. package.json "main" must point at the device *module* ' +
      '(conventionally index.js, which does this.on("discover", ...) and emits "deviceonline" ' +
      'with a new Device()), not at the CHDevice subclass in device.js. ' +
      'See docs/module-development.md'));
  }

  moduleInstance.on('deviceonline',  this.onDeviceOnline.bind(this, packageInfo, modulePath));  //append content of package.json and modulePath to module instance
  moduleInstance.on('deviceoffline', this.onDeviceOffline.bind(this));

  // Access CouchDB to load device specific configuration data
  getDeviceConfig(options, name, (err) => {
    if (err) LOG.E(new CHError('DEVICE_CONFIG_LOAD_FAIL', err.message));

    this.emit('moduleload', name, moduleInstance, version);
    return callback(null, moduleInstance);
  });
};

// this call always run in main thread
//
// Loading a module that is already loaded restarts it: the old worker is
// unloaded and terminated, and the module starts again in a new one. There is
// no in-place reload. A reused worker keeps its require cache, its globals and
// whatever timers or sockets the old code left open, so an in-place reload
// ran a mix of new and old code; a new worker has none of that.
ModuleManager.prototype.loadModuleByWorker = function(modulePath, name, version, callback) {
  if (this.supervisor != null) this.supervisor.clear(name);
  if (this.modules[name] == null) return this.spawnModuleWorker(modulePath, name, version, callback);

  this.unloadModuleExternal(name, () => {
    this.spawnModuleWorker(modulePath, name, version, callback);
  });
};

// stillWanted (optional): asked once the worker has loaded the module; false
// terminates the worker instead of registering it.
ModuleManager.prototype.spawnModuleWorker = function(modulePath, name, version, callback, stillWanted) {
  const outside = outsideHardenedRoot(modulePath);
  if (outside != null) return callback(outside);
  let sandbox = null;
  try {
    sandbox = moduleSandboxConfig.build(modulePath, name,
      {mode: options.moduleSandbox, modulePolicy: options.modulePolicy, serverEnv: process.env});
  } catch (e) {
    return callback(new CHError('LOAD_MODULE_FAIL', name, e.message));
  }
  if (sandbox != null) {
    sandbox.notes.forEach((note) => LOG.I(`module sandbox: ${name}: ${note}`));
    if (sandbox.refusal != null) {
      if (options.moduleSandbox === 'enforce') {
        const refused = new CHError('MODULE_SANDBOX_REFUSED', name, sandbox.refusal);
        LOG.E(refused);
        return callback(refused);
      }
      LOG.I(`module sandbox: ${name} would be refused under enforce: ${sandbox.refusal}`);
    }
    LOG.I(sandbox.logLine);
  }

  const worker = new Worker(`${__dirname}/sandbox.js`, sandbox != null ? sandbox.workerOptions : undefined); //this is the name under release mode
  const workerMessage = new WorkerMessage(worker);
  workerMessage.sandboxLimits = sandbox != null ? sandbox.limits : null;
  workerMessage.violationCount = 0;
  workerMessage.killReason = null;
  workerMessage.on('sandbox-violation', (data) => {
    // 'uses' is information, not a violation: the first require of fs, net
    // and the like, which will need declared permissions once the brokers
    // (parts 2 and 3) ship.
    if (data.rule === 'uses') {
      return LOG.I(`module sandbox: ${name} uses ${data.target} -- it will need fs/net permissions once the broker ships`);
    }
    if (data.rule === 'suppressed') return LOG.I(`module sandbox: ${name} further violations suppressed`);
    workerMessage.violationCount++;
    LOG.I(`module sandbox: ${name} violation ${data.rule} ${data.target} (${options.moduleSandbox === 'enforce' ? 'blocked' : 'allowed, audit'})`);
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
  let exitReason = null;
  const onUnexpectedExit = (reason) => {
    if (exitReason != null) return;
    exitReason = workerMessage.killReason || reason;
    if (!loaded) return done(new CHError('LOAD_MODULE_FAIL', name, `worker ended while loading: ${exitReason}`));
    if (!isCurrent()) return;   // a deliberate unload already took the module off this worker
    if (workerMessage.unloading === true) return;   // an operator unload is under way; its own timer finishes it

    // Fail calls in flight now instead of at their timeout.
    if (this.supervisor != null) {
      const pending = workerMessage.msgQueue;
      workerMessage.msgQueue = {};
      Object.keys(pending).forEach((id) => {
        const err = new CHError('MODULE_RESTARTING', name, exitReason);
        if (typeof(pending[id]) === 'function') pending[id](err, null);
      });
    }

    const specs = Object.assign({}, workerMessage.deviceList);
    this.unloadModule(name, `WORKER EXIT: ${exitReason}`, () => {
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
    onUnexpectedExit(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'heap limit' : `crash: ${err.message}`);
  });

  worker.on('exit', (exitCode) => {
    LOG.E(new Error(`worker exit with code: ${exitCode}`));
    onUnexpectedExit(`exit code ${exitCode}`);
  });

  // worker.threadId is a real, unique-per-Worker-instance identifier Node
  // already provides -- used as-is for "workerId" throughout the direct
  // peer channel feature (docs/direct-peer-channels-design.md) rather
  // than inventing a parallel ID scheme. A restart gets a new worker and so
  // a new workerId; channels to the old one are invalidated by the unload
  // (DeviceManager.prototype.onPurgeDevice), not by noticing the ID change.
  workerMessage.workerId = worker.threadId;

  workerMessage.sendSetOptionsMessage({options: options.getOptions(), sandbox: sandbox != null ? sandbox.lockdown : null}, (err, data) => {
    if (err) {
      worker.terminate();
      return done(err, data);
    }
    // Watched from here, so a module that blocks while loading is ended too.
    if (workerMessage.sandboxLimits != null) workerLimits.watch(worker, workerMessage, workerMessage.sandboxLimits);
    workerMessage.sendLoadModuleMessage({path: modulePath, name: name, version: version}, (e, d) => {
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
};

//this call MUST NOT run under worker thread mode
ModuleManager.prototype.reloadModule = function(modulePath, callback) {
  let moduleInstance = null;
  let packageInfo    = null;
  let name    = null;
  let version = null;

  if (typeof(modulePath) !== 'string' || !fs.existsSync(modulePath)) return callback(new CHError('INVALID_MODULE_PATH', modulePath));
  const outside = outsideHardenedRoot(modulePath);
  if (outside != null) return callback(outside);

  try {
    packageInfo = JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json')).toString());
    name    = packageInfo.name;
    version = packageInfo.version;

    if (typeof(name) !== 'string') {
      return callback(new CHError('MODULE_PACKAGE_NAME_TYPE_ERROR', name));
    }
    if (typeof(version) !== 'string' || semver.valid(version) == null) {
      // in case of any error, unload the module so user must fix coding errors before he can continue to use this module
      return this.unloadModule(name, 'RELOAD MODULE FAIL DUE TO INVALID VERSION STRING', () => {
        return callback(new CHError('MODULE_VERSION_INFO_INVALID', version));
      });
    }

    // Under --workerThread, module code runs only in its worker: a reload is
    // a restart in a new worker, never an instantiation here in the main
    // thread.
    if (options.workerThread === true && isMainThread === true) {
      return this.loadModuleByWorker(modulePath, name, version, callback);
    }

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
    this.unloadModule(name, `RELOAD MODULE FAIL DUE TO EXCEPTION: ${e.message}`, () => {
      return callback(new CHError('LOAD_MODULE_FAIL', e.message, e.stack));
    });
  }
};

//this should only be available under worker mode to restart a worker thread,
// and non worker mode has no such concept of 'restart', only reload a module
// and return the newly discovered device list to caller
ModuleManager.prototype.restartModule = function(modulePath, name, version, callback) {
  const outside = outsideHardenedRoot(modulePath);
  if (outside != null) return callback(outside);
  const m = this.modules[name];
  // A restarting or suspended module is not in this.modules, but an operator
  // restart is exactly what brings it back.
  const supervised = this.supervisor != null && this.supervisor.status(name) != null;
  if (m == null && !supervised) {
    return callback(new CHError('RESTART_MODULE_FAIL', 'unknown module', name));
  }
  if (m == null) return this.loadModuleByWorker(modulePath, name, version, callback);

  if (options.workerThread !== true || isMainThread !== true) {
    return this.loadModuleFromPath(modulePath, name, version, callback);
  }

  this.unloadModuleExternal(name, () => {
    this.loadModuleByWorker(modulePath, name, version, (err, mi) => {
      if (err) LOG.E(new CHError('LOAD_MODULE_FAIL', err.message));
      return callback(err, mi);
    });
  });
};

ModuleManager.prototype.unloadModuleExternal = function(name, callback) {
  const wasSupervised = this.supervisor != null && this.supervisor.status(name) != null;
  if (this.supervisor != null) this.supervisor.clear(name);
  const m = this.modules[name];
  if (m != null) {
    if (m instanceof WorkerMessage) {
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
        this.unloadModule(name, 'CLEANUP MODULE INFO IN MAIN THREAD', () => {
          m.worker.terminate().then(() => callback(), () => callback());
        });
      };
      const timer = setTimeout(finish, 3000);

      // The worker may exit while it answers (its destroy code, a limit kill):
      // that is part of this unload, not an unexpected exit.
      m.unloading = true;
      m.sendUnloadModuleMessage({name: name}, finish);
    } else {
      //single thread mode
      if (isMainThread === true) return this.unloadModule(name, 'UNLOAD MODULE IN MAIN THREAD', callback);
      //do unload in child thread
      return this.unloadModule(name, 'UNLOAD MODULE IN WORKER', callback);
    }
  } else {
    // a restarting or suspended module is not loaded, but unloading it took effect
    if (wasSupervised) return callback();
    return callback(new CHError('UNLOAD_MODULE_FAIL', 'unknown module', name));
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
    return callback(new CHError('MODULE_INSTALL_FAIL', err.stack), {packageInfo: packageInfo, deviceList: [], moduleInstallPath: modulePath});
  });

  unsafeDomain.run(() => { _this.loadModuleAndQueryDevice(modulePath, name, version, packageInfo, callback); });
};

ModuleManager.prototype.loadModuleAndQueryDevice = function(modulePath, name, version, packageInfo, callback) {
  this.loadModuleFromPath(modulePath, name, version, (e, mi) => {
    if (e != null) return callback(new CHError('MODULE_INSTALL_FAIL', name, e.message, e.stack), {packageInfo: packageInfo, deviceList: [], moduleInstallPath: modulePath});
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
    return callback(new CHError('MODULE_PACKAGE_INFO_INVALID'));
  }
};

module.exports = ModuleManager;
