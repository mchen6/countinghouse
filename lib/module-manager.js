var events      = require('events');
var util        = require('util');
var CdifUtil    = require('../lib/cdif-util');
var options     = require('../lib/cli-options');
var exec        = require('child_process').exec;
var CdifError   = require('../lib/cdif-error').CdifError;
var LOG         = require('../lib/logger');
var C9Launcher  = require('../lib/c9-launcher');
var rewire      = require('rewire');
var semver      = require('semver');
var mkdirp      = require('mkdirp');
var rimraf      = require('rimraf');
var fs          = require('fs');
var chmodr      = require('chmodr');
var Domain      = require('domain');
var async       = require('async');
var resolve     = require('path').resolve;

var Worker         = require('worker_threads').Worker;
var isMainThread   = require('worker_threads').isMainThread;
var WorkerMessage  = require('./worker-message');

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

ModuleManager.prototype.onModuleLoad = function(name, module, version) {
  //only print this in child thread when a module is truly loaded, or when worker thread mode is disabled
  if (options.workerThread !== true || !isMainThread) LOG.I('module: ' + name + '@' + version + ' loaded');

  module.discoverState = 'stopped';

  var m = this.modules[name];
  if (m != null) {
    // module reloaded
    if (m.discoverState === 'discovering') {
      m.discoverState = 'stopped';
    }
    this.emit('purgedevice', m, function() {
      this.modules[name] = module;
    }.bind(this)); // to be handled by device manager
  } else {
    this.modules[name] = module;
  }


  var _mm = this;

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

      setTimeout(function() {
        // in our module's ABI we run module's constructor after it received discover message
        // and it's worker thread could die and exit during this phase
        // so after timeout increase noofLoadedModules counter if we can't find the module
        if (_mm.modules[name] == null) {
          _mm.noofLoadedModules ++;

          if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules > _mm.noofTotalModules) {
            _mm.noofLoadedModules = _mm.noofTotalModules;
          }
          if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules === _mm.noofTotalModules) {
            _mm.emit('allmodulediscovered');
          }
        }
      }, 10000);

      module.sendDiscoverMessage({}, function() {
        module.discoverState = 'stopped';

        if (_mm.modules[name] != null) {
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

ModuleManager.prototype.onModuleUnload = function(name, callback) {
  LOG.I('module: ' + name + ' unloaded');

  var m = this.modules[name];
  if (m == null) {
    if (callback != null && typeof(callback) === 'function') return callback();
  }

  if (m.discoverState === 'discovering') {
    m.discoverState = 'stopped';
  }

  this.emit('purgedevice', m, function() {
    delete this.modules[name];
    if (callback != null && typeof(callback) === 'function') callback();
  }.bind(this));
};

ModuleManager.prototype.discoverAllDevices = function() {
  if (options.workerThread === false && isMainThread === true) this.emit('modulediscovering');
  for (var m in this.modules) {
    var module = this.modules[m];
    if (module.discoverState === 'discovering') {
      return;
    }
    module.emit('discover');
    module.discoverState = 'discovering';
  }
};

ModuleManager.prototype.stopDiscoverAllDevices = function() {
  if (options.workerThread === false && isMainThread === true) this.emit('allmodulediscovered');
  for (var m in this.modules) {
    var module = this.modules[m];
    if (module.discoverState === 'stopped') {
      return;
    }
    module.emit('stopdiscover');
    module.discoverState = 'stopped';
  }
};

ModuleManager.prototype.onDeviceOnline = function(device, module) {
  var found = false;
  for (var moduleName in this.modules) {
    if (this.modules[moduleName] === module) {
      found = true;
      this.emit('deviceonline', device, module, moduleName);
    }
  }
  if (found === false) {
    LOG.E(new CdifError('CORRESPONDING_MODULE_NOT_FOUND', 'device online'));
  }
};

ModuleManager.prototype.onDeviceOffline = function(device, module) {
  var found = false;

  for (var moduleName in this.modules) {
    if (this.modules[moduleName] === module) {
      found = true;
      this.emit('deviceoffline', device, module, moduleName);
    }
  }
  if (found === false) {
    LOG.E(new CdifError('CORRESPONDING_MODULE_NOT_FOUND', 'device offline'));
  }
};

ModuleManager.prototype.getModuleInfoFromPath = function(pathList) {
  var list = [];

  if (typeof(pathList) === 'string') {
    list.push(pathList);
  } else if (Array.isArray(pathList)) {
    list = pathList;
  } else {
    LOG.E(new CdifError('LOAD_MODULE_FAIL', 'invalid loadModule argument:', pathList));
    return null;
  }

  var info = [];

  list.forEach(function(item) {
    if (fs.existsSync(item) && fs.existsSync(item + '/package.json')) {
      try {
        var packageInfo = JSON.parse(fs.readFileSync(item + '/package.json').toString());
        info.push({path: item, name: packageInfo.name, version: packageInfo.version});
      } catch (e) {
        LOG.E(new CdifError('LOAD_MODULE_FAIL', 'invalid package.json file:', item));
      }
    } else {
      LOG.E(new CdifError('LOAD_MODULE_FAIL', 'invalid path or package.json file not found:', item));
    }
  });
  return info;
};

ModuleManager.prototype.loadAllModules = function() {
  var _this = this;

  // in case loading local module, we won't read module info from DB, instead read its info from package.json
  if (options.localModulePath != null) {
    var info = this.getModuleInfoFromPath(options.localModulePath);
    if (info == null) return;

    async.eachSeries(info, function(item, cb) {
      _this.loadModuleFromPath(item.path, item.name, item.version, function(err, mi) {
        LOG.I('load local module from path: ' + item.path);
        return cb();
      });
    }, function(e) {

    });

    return;
  }

  if (options.workerThread !== true || isMainThread === true) {
    //do not require sqlite3 which contains native bindings in child thread
    var deviceDB = require('@apemesh/cdif-device-db');
    deviceDB.getAllModuleInfo(function(err, data) {
      if (err) {
        return LOG.E(new CdifError('GET_MODULE_INFO_FAIL', err.message));
      }

      if (data == null) return;

      this.noofTotalModules = data.length;

      if (this.noofTotalModules === 0) {
        if (options.withPM2 === true) process.send('ready');   // send ready event to ccl
      }

      async.eachSeries(data, function(item, cb) {
        _this.loadModuleFromPath(item.path, item.name, item.version, function(err, mi) {
          // if (err == null) {
          //   _this.noofAvailableModules++;
          // }
          return cb();
        });
      }, function(err) {
        // _this.noofTotalModules = _this.noofAvailableModules;
      });
    }.bind(this));
  }
};

//this is a sync call if not enabled worker thread
//TODO: load module from existing thread if already existed
ModuleManager.prototype.loadModuleFromPath = function(path, name, version, callback) {
  if (options.workerThread === true && isMainThread === true) {
    return this.loadModuleByWorker(path, name, version, function(err, mi) {
      if (err) LOG.E(new CdifError('LOAD_MODULE_FAIL', err.message));
      return callback(err, mi);
    });
  }

  var moduleConstructor = null;
  var moduleInstance    = null;

  if (typeof(path) !== 'string' || !fs.existsSync(path)) return callback(new CdifError('INVALID_MODULE_PATH', path));

  try {

    moduleConstructor = rewire(resolve(path));  //resolve relative path to absolute since rewire cant handle it
    //TODO: support loading 3rd party npm packages and publish them to our own registry
    //this would allow user publish and use a missing npm package in closed network environment
    moduleInstance    = new moduleConstructor();
  } catch (e) {
    LOG.E(new CdifError('LOAD_MODULE_FAIL', e.message));
    return callback(e);
  }

  moduleInstance.on('deviceonline',  this.onDeviceOnline.bind(this));
  moduleInstance.on('deviceoffline', this.onDeviceOffline.bind(this));

  this.emit('moduleload', name, moduleInstance, version);
  return callback(null, moduleInstance);
};

//TODO: if module load failed, terminate the child thread
// this call always run in main thread
ModuleManager.prototype.loadModuleByWorker = function(path, name, version, callback) {
  var wm = this.modules[name];

  if (wm != null) {
    //module reload
    wm.sendLoadModuleMessage({path: path, name: name, version: version}, function(e, d) {
      if (e) {
        //this can happen if module load fail caused by errors in device modules such as code syntax error etc.
        this.unloadModule(name, function() {
          wm.worker.terminate();
          return callback(e, d);
        });
      }
      this.emit('moduleload', name, wm, version);
      return callback(null, wm);
    }.bind(this));
  } else {
    var worker = new Worker(__dirname + '/sandbox.js'); //this is the name under release mode

    worker.on('error', function(err) {
      // in case of uncaught exception, work will exit here, we should clean up it
      LOG.E(new Error('worker exit on error: ' + err.message));
      this.unloadModule(name, null);
    }.bind(this));

    worker.on('exit', function(exitCode) {
      // in case of uncaught exception, work will exit here, we should clean up it
      LOG.E(new Error('worker exit with code: ' + exitCode));
      this.unloadModule(name, null);
    }.bind(this));


    var workerMessage = new WorkerMessage(worker);

    if (workerMessage == null) {
      return callback(new Error('spawn worker failed'));
    }

    workerMessage.sendSetOptionsMessage({options: options.getOptions()}, function(err, data) {
      if (err) {
        this.unloadModule(name, function() {
          worker.terminate();
          return callback(err, data);
        });
      }
      workerMessage.sendLoadModuleMessage({path: path, name: name, version: version}, function(e, d) {
        if (e) {
          this.unloadModule(name, function() {
            worker.terminate();
            return callback(e, d);
          });
        }
        this.emit('workerloaded', workerMessage);
        //workerMessage also acting as moduleInstance in main thread
        this.emit('moduleload', name, workerMessage, version);
        return callback(null, workerMessage);
      }.bind(this));
    }.bind(this));
  }
};

//this call MUST NOT run under worker thread mode
ModuleManager.prototype.reloadModule = function(path, callback) {
  var moduleConstructor = null;
  var moduleInstance    = null;
  var packageInfo       = null;
  var name    = null;
  var version = null;

  if (typeof(path) !== 'string' || !fs.existsSync(path)) return callback(new CdifError('INVALID_MODULE_PATH', path));

  try {
    packageInfo = JSON.parse(fs.readFileSync(path + '/package.json').toString());
    name    = packageInfo.name;
    version = packageInfo.version;

    if (typeof(name) !== 'string') {
      return callback(new CdifError('MODULE_PACKAGE_NAME_TYPE_ERROR', name));
    }
    if (typeof(version) !== 'string' || semver.valid(version) == null) {
      // in case of any error, unload the module so user must fix coding errors before he can continue to use this module
      this.unloadModule(name, function() {
        return callback(new CdifError('MODULE_VERSION_INFO_INVALID', version));
      });
    }

    moduleConstructor = rewire(resolve(path));  //resolve relative path to absolute since rewire cant handle it
    moduleInstance    = new moduleConstructor();
  } catch (e) {
    this.unloadModule(name, function() {
      return callback(new CdifError('LOAD_MODULE_FAIL', e.message, e.stack));
    });
  }

  moduleInstance.on('deviceonline',  this.onDeviceOnline.bind(this));
  moduleInstance.on('deviceoffline', this.onDeviceOffline.bind(this));

  // if there is no error, new module and devices instances inside it will be replaced in device manager
  this.emit('moduleload', name, moduleInstance, version);

  setTimeout(function() {
    //get the list of device objects which belongs to moduleInstance
    //this event is handled by device manager
    this.emit('querydevicelist', moduleInstance, packageInfo, callback);
  }.bind(this), 1000);
  // return callback(null, {ok: true});
};

//this should only be available under worker mode to restart a worker thread,
// and non worker mode has no such concept of 'restart', only reload a module
// and return the newly discovered device list to caller
ModuleManager.prototype.restartModule = function(path, name, version, callback) {
  var m = this.modules[name];
  if (m == null) {
    return callback(new CdifError('RESTART_MODULE_FAIL', 'unknown module', name));
  }

  if (options.workerThread !== true || isMainThread !== true) {
    return this.loadModuleFromPath(path, name, version, callback);
  }

  this.unloadModuleExternal(name, function() {
    this.loadModuleByWorker(path, name, version, function(err, mi) {
      if (err) LOG.E(new CdifError('LOAD_MODULE_FAIL', err.message));
      return callback(err, mi);
    });
  }.bind(this));
};

ModuleManager.prototype.unloadModuleExternal = function(name, callback) {
  var m = this.modules[name];
  if (m != null) {
    if (m instanceof WorkerMessage) {
      //first send message to child to allow child run destroyDevice call
      //then invoke unloadModule in main thread to clean workerMessage instances saved in deviceMap
      //TODO: setTimeout and if unload message didn't get responded (possibly due to blocked by module's code), we force terminate its thread
      //TODO: deny any external API call goes into child thread before terminate the thread to be safer

      m.sendUnloadModuleMessage({name: name}, function() {
        if (this.modules[name] != null) {
          this.unloadModule(name, function() {
            m.worker.terminate();
            return callback();
          });
        }
      }.bind(this));

      // if device is blocked, terminate thread and return after 3 seconds
      setTimeout(function() {
        if (this.modules[name] != null) {
          this.unloadModule(name, function() {
            m.worker.terminate();
            return callback();
          });
        }
      }.bind(this), 3000);
    } else {
      return this.unloadModule(name, callback);
    }
  }
};

//TODO: send message to event handler say why this module is unloaded
//then we can write this message to deviceLog where user can lookup from redis
//when called in main thread, this cleans workerMessage instances saved in deviceMap
//when called in child thread, this cleans device object saved in deviceMap
ModuleManager.prototype.unloadModule = function(name, callback) {
  var m = this.modules[name];
  if (m != null) {
    return this.emit('moduleunload', name, callback);
  }
};

ModuleManager.prototype.verifyModule = function(input, callback) {
  var registry = input.registry;
  if (typeof(registry) !== 'string') {
    registry = options.regUrl; //fall back to default registry url
  }

  if (typeof(input.name) !== 'string') {
    return callback(new CdifError('MODULE_NAME_TYPE_ERROR', input.name));
  }
  if (input.path == null || typeof(input.path) !== 'string') {
    return callback(new CdifError('MODULE_INSTALL_PATH_PREFIX_INVALID'));
  }

  var name = null, version = null;

  var _this     = this;
  var zlib      = require('zlib');
  var tar       = require('tar');
  var stream    = require('stream');
  var errorInfo = null;

  var file = fs.createReadStream(input.name);
  file.on('error', function(e) {
    return callback(new CdifError('READ_MODULE_FAIL', e.message));
  });

  var unzip = file.pipe(zlib.Unzip());
  unzip.on('error', function(e) {
    return callback(new CdifError('UNZIP_MODULE_FAIL', e.message));
  });

  var tar = unzip.pipe(tar.Parse());
  tar.on('error', function(e) {
    return callback(new CdifError('UNTAR_MODULE_FAIL', e.message));
  });

  //TODO: add check that if no package.json is found in the end of entry, return error info
  tar.on('entry', function(entry) {
    if (/package\.json$/.test(entry.path)) { // look into package.json
      if (entry.type === 'Directory') return;

      var bufferStream = new stream.PassThrough();
      var data = Buffer.alloc(0);
      bufferStream.on('data', function(chunk) {
        data = Buffer.concat([data, chunk]);
      }).on('end', function() {
        var packageInfo;
        try {
          var packageInfo = JSON.parse(data.toString());
        } catch (e) {
          return callback(new CdifError('MODULE_PACKAGE_INFO_INVALID', e.message));
        }

        if (typeof(packageInfo) !== 'object') {
          return callback(new CdifError('MODULE_PACKAGE_INFO_TYPE_ERROR', name));
        }
        name    = packageInfo.name;
        version = packageInfo.version;

        if (typeof(name) !== 'string') {
          return callback(new CdifError('MODULE_PACKAGE_NAME_TYPE_ERROR', name));
        }
        if (typeof(version) !== 'string' || semver.valid(version) == null) {
          return callback(new CdifError('MODULE_VERSION_INFO_INVALID', version));
        }
        if (packageInfo.publishConfig != null) {
          return callback(new CdifError('MODULE_INFO_CONTAINS_PUBLISHCONFIG', name));
        }

        var installBasePath = input.path + '/cdif-package';
        var command = 'npm install ' + '--prefix ' + installBasePath + ' --registry=' + registry + ' ' + input.name;

        try {
          fs.accessSync(input.path, fs.W_OK);
          mkdirp.sync(installBasePath);
        } catch (e) {
          return callback(new CdifError('MODULE_INSTALL_PATH_PREFIX_INVALID', e.message));
        }

        try {
          exec(command, {timeout: 120000}, function(err, stdout, stderr) {
            if (err) {
              return callback(new CdifError('MODULE_INSTALL_FAIL', name, err.message));
            }

            var moduleInstance = null;
            // this is current designated npm behaviour by putting things under node_modules/<package-name>
            var path = installBasePath + '/node_modules/' + name;
            // use domain here to catch and report error info in module's device obj constructor code
            var unsafeDomain = Domain.create();
            unsafeDomain.on('error', function(err) {
              return callback(new CdifError('MODULE_INSTALL_FAIL', err.stack));
            });

            unsafeDomain.run(function() {
              _this.loadModuleFromPath(path, name, version, function(e, mi) {
                if (e != null) return callback(new CdifError('MODULE_INSTALL_FAIL', name, e.message, e.stack));
                moduleInstance = mi;
                // in docker we are running in root privledge, so the folder created and the things created by
                // npm install command above would have root owner, in order to let users modify its content,
                // we have to set its permission to 0777
                chmodr(installBasePath, 0777, function(err) {
                  if (err) return callback(new CdifError('MODULE_PATH_CHMOD_FAIL', err.message));
                  //rewrite package.json file after npm install, this removes customized fields npm added to the installed package
                  fs.writeFileSync(path + '/package.json', JSON.stringify(packageInfo, null, 2), 'utf8');

                  if (options.cloud9 === true) {
                    C9Launcher.startCloud9(path, CdifUtil.getHostIp(), options.dbUrl, input.apiDesignID, function(errr) {
                      if (errr) return callback(new CdifError('MODULE_INSTALL_FAIL', errr.message));
                    });
                  }

                  //give time to allow device online
                  setTimeout(function() {
                    //get the list of device objects which belongs to moduleInstance
                    //this event is handled by device manager
                    _this.emit('querydevicelist', moduleInstance, packageInfo, callback);
                  }, 2000);
                });
              });
            });
          });
        } catch (e) {
          return callback(new CdifError('MODULE_INSTALL_FAIL', name, e.message));
        }
      }).on('error', function(err) {
        return callback(new CdifError('READ_MODULE_FAIL', err.message));
      });

      entry.pipe(bufferStream).on('error', function(err) {
        return callback(new CdifError('READ_MODULE_FAIL', err.message));
      });
    }
  });
};

ModuleManager.prototype.onQueryDeviceListResult = function(error, deviceList, packageInfo, callback) {
  if (packageInfo != null && packageInfo.name != null) {
    return callback(error, {packageInfo: packageInfo, deviceList: deviceList});
  } else {
    return callback(new CdifError('MODULE_PACKAGE_INFO_INVALID'));
  }
};

module.exports = ModuleManager;
