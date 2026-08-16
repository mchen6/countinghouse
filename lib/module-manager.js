const events         = require('events');
const util           = require('util');
const options        = require('../lib/cli-options');
const exec           = require('child_process').exec;
const CHError      = require('../lib/countinghouse-error').CHError;
const LOG            = require('../lib/logger');

const getDeviceConfig = require('./device-config');

const rewire      = require('rewire');
const semver      = require('semver');
const rimraf      = require('rimraf');
const fs          = require('fs');
const Domain      = require('domain');
const async       = require('async');
const path        = require('path');

const Worker         = require('worker_threads').Worker;
const isMainThread   = require('worker_threads').isMainThread;
const WorkerMessage  = require('./worker-message');

function ModuleManager() {
  this.modules = {};
  this.noofTotalModules = 0;
  // this.noofAvailableModules = 0;
  this.noofLoadedModules = 0;

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
  if (moduleInstance == null) return callback(new Error('unknown module name'), null);

  //HACK: the handler is not interested with packageInfo so we pass it just an empty object here
  //this is to make onQueryDeviceListResult() happy
  this.emit('querydevicelist', moduleInstance, {name: name}, callback); //we only interested at deviceList in the callbacked object
}

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
  } else {
    this.modules[name] = module;
  }


  const _mm = this;

  if (options.allowDiscover === true && options.workerThread === true) {
    //TODO: manually send discover event to worker start from route-manager
    LOG.E('we do not support emit discover events in main thread yet');
    return;
  }

  if (options.allowDiscover === false) {
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
          if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules === _mm.noofTotalModules) {
            LOG.I('all module discovered');
            _mm.emit('allmodulediscovered');
            if (options.withPM2 === true) process.send('ready');   // send ready event to ccl
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

        if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules === _mm.noofTotalModules) {
          LOG.I('all module discovered');
          _mm.emit('allmodulediscovered');
          if (options.withPM2 === true) process.send('ready');   // send ready event to ccl
        }
      }.bind(module), 5000);
    } else {
      //worker thread mode but run in child thread, this is handled by discoverAllDevices call below
      // because we send discover event to child thread from main thread, see above
    }
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

    async.eachSeries(info, (item, cb) => {
      _this.loadModuleFromPath(item.path, item.name, item.version, (err, mi) => {
        LOG.I(`load local module from path: ${item.path}`);

        if (err != null) {
          _mm.noofLoadedModules ++;

          if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules > _mm.noofTotalModules) {
            _mm.noofLoadedModules = _mm.noofTotalModules;
          }
          if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules === _mm.noofTotalModules) {
            LOG.I('all module discovered');
            _mm.emit('allmodulediscovered');
            if (options.withPM2 === true) process.send('ready');   // send ready event to ccl
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
        if (options.withPM2 === true) process.send('ready');   // send ready event to ccl
      }

      async.eachSeries(data, (item, cb) => {
        _this.loadModuleFromPath(item.path, item.name, item.version, (err, mi) => {
          // in case of load fail (exception catched during rewire()), we increase noofLoadedModules
          // so we don't block 'allmoduleloaded' event emission after all module loaded
          // in normal case where no exceptions occured, noofLoadedModules increment is done after discover message is delivered
          // which indicates module is successfully loaded
          if (err != null) {
            _mm.noofLoadedModules ++;

            if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules > _mm.noofTotalModules) {
              _mm.noofLoadedModules = _mm.noofTotalModules;
            }
            if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules === _mm.noofTotalModules) {
              LOG.I('all module discovered');
              _mm.emit('allmodulediscovered');
              if (options.withPM2 === true) process.send('ready');   // send ready event to ccl
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
ModuleManager.prototype.loadModuleFromPath = function(modulePath, name, version, callback) {
  if (options.workerThread === true && isMainThread === true) {
    return this.loadModuleByWorker(modulePath, name, version, (err, mi) => {
      // if (err) LOG.E(new CHError('LOAD_MODULE_FAIL', err.message));

      return callback(err, mi);
    });
  }

  let moduleConstructor = null;
  let moduleInstance    = null;
  let packageInfo       = null;

  if (typeof(modulePath) !== 'string' || !fs.existsSync(modulePath)) return callback(new CHError('INVALID_MODULE_PATH', modulePath));

  // Required lazily, both of them: countinghouse-util -> countinghouse-device
  // -> session is a require cycle, and handler-map-module pulls in
  // countinghouse-device too. Same technique session.js and device-manager.js
  // already use for the same reason.
  const CHUtil          = require('./countinghouse-util');
  const handlerMapModule = require('./handler-map-module');

  let isHandlerMapModule = false;

  try {
    packageInfo = JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json')).toString());

    // A handler-map module may have no main entry at all (the handlers/
    // convention), so a failure to load one is not yet fatal -- only a failure
    // to find *either* shape is.
    try {
      moduleConstructor = rewire(path.resolve(modulePath));  //resolve relative path to absolute since rewire cant handle it
    } catch (e) {
      moduleConstructor = null;
    }

    // 6.0.0 shape first: a plain {service: {action: fn}} export, or a
    // handlers/ tree. Anything else falls through to the discovery path
    // below completely unchanged. See lib/handler-map-module.js.
    const resolved = handlerMapModule.resolveHandlerMap(modulePath, moduleConstructor,
                                                        (file) => CHUtil.loadFile(file));
    if (resolved != null) {
      moduleInstance     = handlerMapModule.assemble(modulePath, name, resolved.handlerMap, resolved.source);
      isHandlerMapModule = true;
    } else {
      if (moduleConstructor == null) throw new CHError('INVALID_MODULE_PATH', modulePath);
      //TODO: support loading 3rd party npm packages and publish them to our own registry
      //this would allow user publish and use a missing npm package in closed network environment
      moduleInstance = new moduleConstructor();
    }
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

//TODO: if module load failed, terminate the child thread
// this call always run in main thread
ModuleManager.prototype.loadModuleByWorker = function(modulePath, name, version, callback) {
  const wm = this.modules[name];

  if (wm != null) {
    //module reload
    wm.sendLoadModuleMessage({path: modulePath, name: name, version: version}, (e, d) => {
      if (e) {
        //this can happen if module load fail caused by errors in device modules such as code syntax error etc.
        this.unloadModule(name, `WORKER LOAD MODULE FAIL: ${e.message}`, () => {
          wm.worker.terminate();
          return callback(e, d);
        });
      } else {
        this.emit('moduleload', name, wm, version);
        return callback(null, wm);
      }
    });
  } else {
    const worker = new Worker(`${__dirname}/sandbox.js`); //this is the name under release mode

    worker.on('error', (err) => {
      // in case of uncaught exception, work will exit here, we should clean up it
      LOG.E(new Error(`worker exit on error: ${err.message}`));
      this.unloadModule(name, `ERROR MESSAGE FROM WORKER: ${err.message}`, () => {});
    });

    worker.on('exit', (exitCode) => {
      // in case of uncaught exception, work will exit here, we should clean up it
      LOG.E(new Error(`worker exit with code: ${exitCode}`));
      this.unloadModule(name, `WORKER EXIT WITH CODE: ${exitCode}`, () => {});
    });


    const workerMessage = new WorkerMessage(worker);
    // worker.threadId is a real, unique-per-Worker-instance identifier Node
    // already provides -- used as-is for "workerId" throughout the direct
    // peer channel feature (docs/direct-peer-channels-design.md) rather
    // than inventing a parallel ID scheme. It survives a hot-reload of this
    // worker's module (loadModuleByWorker's "module reload" branch below
    // reuses this same Worker instance), which is fine: reload invalidation
    // is triggered by the reload *event* itself (see
    // DeviceManager.prototype.onPurgeDevice), not by workerId changing.
    workerMessage.workerId = worker.threadId;

    if (workerMessage == null) {
      return callback(new Error('spawn worker failed'));
    }

    workerMessage.sendSetOptionsMessage({options: options.getOptions()}, (err, data) => {
      if (err) {
        worker.terminate();
        return callback(err, data);
      }
      workerMessage.sendLoadModuleMessage({path: modulePath, name: name, version: version}, (e, d) => {
        if (e) {
          worker.terminate();
          return callback(e, d);
        }
        this.emit('workerloaded', workerMessage);
        //workerMessage also acting as moduleInstance in main thread
        this.emit('moduleload', name, workerMessage, version);
        return callback(null, workerMessage);
      });
    });
  }
};

//this call MUST NOT run under worker thread mode
ModuleManager.prototype.reloadModule = function(modulePath, callback) {
  let moduleConstructor = null;
  let moduleInstance    = null;
  let packageInfo       = null;
  let name    = null;
  let version = null;

  if (typeof(modulePath) !== 'string' || !fs.existsSync(modulePath)) return callback(new CHError('INVALID_MODULE_PATH', modulePath));

  try {
    packageInfo = JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json')).toString());
    name    = packageInfo.name;
    version = packageInfo.version;

    if (typeof(name) !== 'string') {
      return callback(new CHError('MODULE_PACKAGE_NAME_TYPE_ERROR', name));
    }
    if (typeof(version) !== 'string' || semver.valid(version) == null) {
      // in case of any error, unload the module so user must fix coding errors before he can continue to use this module
      this.unloadModule(name, 'RELOAD MODULE FAIL DUE TO INVALID VERSION STRING', () => {
        return callback(new CHError('MODULE_VERSION_INFO_INVALID', version));
      });
    }

    moduleConstructor = rewire(path.resolve(modulePath));  //resolve relative path to absolute since rewire cant handle it
    moduleInstance    = new moduleConstructor();

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
  const m = this.modules[name];
  if (m == null) {
    return callback(new CHError('RESTART_MODULE_FAIL', 'unknown module', name));
  }

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
  const m = this.modules[name];
  if (m != null) {
    if (m instanceof WorkerMessage) {
      //worker thread mode
      //first send message to child to allow child run destroyDevice call
      //then invoke unloadModule in main thread to clean workerMessage instances saved in deviceMap
      //TODO: setTimeout and if unload message didn't get responded (possibly due to blocked by module's code), we force terminate its thread
      //TODO: deny any external API call goes into child thread before terminate the thread to be safer

      m.sendUnloadModuleMessage({name: name}, () => {});

      // to prevent device is blocked by user code, terminate thread and return after 3 seconds
      setTimeout(() => {
        if (this.modules[name] != null) {
          this.unloadModule(name, 'CLEANUP MODULE INFO IN MAIN THREAD', () => {
            m.worker.terminate();
            return callback();
          });
        }
      }, 3000);
    } else {
      //single thread mode
      if (isMainThread === true) return this.unloadModule(name, 'UNLOAD MODULE IN MAIN THREAD', callback);
      //do unload in child thread
      return this.unloadModule(name, 'UNLOAD MODULE IN WORKER', callback);
    }
  } else {
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

ModuleManager.prototype.verifyModule = function(input, callback) {
  let registry = input.registry;
  if (typeof(registry) !== 'string') {
    registry = options.regUrl; //fall back to default registry url
  }

  if (typeof(input.name) !== 'string') {
    return callback(new CHError('MODULE_NAME_TYPE_ERROR', input.name));
  }
  if (input.path == null || typeof(input.path) !== 'string') {
    return callback(new CHError('MODULE_INSTALL_PATH_PREFIX_INVALID'));
  }

  const _this     = this;
  const zlib      = require('zlib');
  const tarModule = require('tar');
  const stream    = require('stream');
  const errorInfo = null;

  let installBasePath, modulePath, packageInfo, name, version;  // these variables are assigned in package.json parse code and used on parsing end

  let apiJson, schemaJson;

  const fileBuffer = {};

  const file = fs.createReadStream(input.name);
  file.on('error', (e) => {
    return callback(new CHError('READ_MODULE_FAIL', e.message));
  });

  const unzip = file.pipe(zlib.Unzip());
  unzip.on('error', (e) => {
    return callback(new CHError('UNZIP_MODULE_FAIL', e.message));
  });

  const tar = unzip.pipe(new tarModule.Parser());
  tar.on('error', (e) => {
    return callback(new CHError('UNTAR_MODULE_FAIL', e.message));
  });

  tar.on('end', () => {
    try {
      packageInfo = JSON.parse(fileBuffer['package.json'].toString());
      apiJson     = JSON.parse(fileBuffer['api.json'].toString());
      schemaJson  = JSON.parse(fileBuffer['schema.json'].toString());
    } catch (e) {
      return callback(new CHError('MODULE_INSTALL_FAIL', e.message));
    }

    if (typeof(packageInfo) !== 'object') {
      return callback(new CHError('MODULE_PACKAGE_INFO_TYPE_ERROR'));
    }
    name    = packageInfo.name;
    version = packageInfo.version;

    if (name == null || version == null) {
      return callback(new CHError('MODULE_PACKAGE_INFO_TYPE_ERROR'));
    }

    installBasePath = path.join(input.path, name);
    modulePath = installBasePath;

    fs.mkdirSync(installBasePath, {recursive: true, mode: 0666});

    // write file contents to modulePath and install dependent packages
    for (const fileName in fileBuffer) {
      const fileContent = fileBuffer[fileName];
      const absolutePath = path.join(installBasePath, fileName);
      fs.mkdirSync(path.dirname(absolutePath), {recursive: true});
      fs.writeFileSync(absolutePath, fileContent);
    }

    const command = `cd ${installBasePath} && npm install ` + `--registry=${registry}`;

    try {
      fs.accessSync(input.path, fs.W_OK);

      exec(command, {timeout: 120000}, (err, stdout, stderr) => {
        if (err) {
          //TODO: in case of npm install error, rimraf the created module folder
          console.error(`dependent module install failed: ${err.message}`);
        }
        _this.loadModuleUnsafe(modulePath, name, version, packageInfo, input.apiDesignID, callback);
      });
    } catch (e) {
      return callback(new CHError('MODULE_INSTALL_FAIL', e.message));
    }
  });

  tar.on('entry', (entry) => {
    if (entry.type === 'Directory') return;  // this package is created by `npm pack`, and it won't create empty folder, so we write file only, and safely skip creating directory entries
    if (entry.path == null || entry.path.startsWith('package/') === false) {
      return console.log(`errored file name found in package: ${entry.path}`);
    }

    const fileName = entry.path.replace(/^package\//,'');  //remove leading 'package/' from npm packed package

    const bufferStream = new stream.PassThrough();
    let data = Buffer.alloc(0);
    bufferStream.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
    }).on('end', () => {
      fileBuffer[fileName] = data;
    }).on('error', (err) => {
      console.error(`file entry: ${entry.path} pipe failed: ${err.message}`);
      fileBuffer[fileName] = undefined;
    });

    entry.pipe(bufferStream);
  });
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
