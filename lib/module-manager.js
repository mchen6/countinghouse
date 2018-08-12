var events      = require('events');
var util        = require('util');
var options     = require('../lib/cli-options');
var exec        = require('child_process').exec;
var deviceDB    = require('@apemesh/cdif-device-db');
var CdifError   = require('../lib/cdif-error').CdifError;
var LOG         = require('../lib/logger');
var rewire      = require('rewire');
var semver      = require('semver');
var mkdirp      = require('mkdirp');
var rimraf      = require('rimraf');
var fs          = require('fs');
var chmodr      = require('chmodr');
var Domain      = require('domain');

var Worker         = require('worker_threads').Worker;
var isMainThread   = require('worker_threads').isMainThread;
var workerMessage  = require('./worker-message');

function ModuleManager() {
  this.modules = {};
  this.noofTotalModules = 0;
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
  LOG.I('module: ' + name + '@' + version + ' loaded');

  module.discoverState = 'stopped';

  var m = this.modules[name];
  if (m != null) {
    // module reloaded
    if (m.discoverState === 'discovering') {
      m.discoverState = 'stopped';
    }
    this.emit('purgedevice', m); // to be handled by device manager
  }
  this.modules[name] = module;

  var _mm = this;
  if (options.allowDiscover === false) {
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
      if (_mm.noofLoadedModules > _mm.noofTotalModules) _mm.noofLoadedModules = _mm.noofTotalModules;

      if (_mm.noofLoadedModules === _mm.noofTotalModules) {
        _mm.emit('allmodulediscovered');
      }
    }.bind(module), 5000);
  }
};

ModuleManager.prototype.onModuleUnload = function(name) {
  LOG.I('module: ' + name + ' unloaded');

  var m = this.modules[name];
  if (m != null) {
    if (m.discoverState === 'discovering') {
      m.discoverState = 'stopped';
    }
    delete this.modules[name];
    this.emit('purgedevice', m); // to be handled by device manager
  }
};

ModuleManager.prototype.discoverAllDevices = function() {
  this.emit('modulediscovering');
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
  this.emit('allmodulediscovered');
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

ModuleManager.prototype.getModuleInfoFromPath = function(path) {
  if (!fs.existsSync(path) || !fs.existsSync(path + '/package.json')) {
    return null;
  }

  try {
    var packageInfo = JSON.parse(fs.readFileSync(path + '/package.json').toString());
    return {name: packageInfo.name, version: packageInfo.version};
  } catch (e) {
    return null;
  }
};

ModuleManager.prototype.loadAllModules = function() {
  // in case loading local module, we won't read module info from DB, instead read its info from package.json
  if (options.localModulePath != null) {
    var info = this.getModuleInfoFromPath(options.localModulePath);
    if (info == null) return LOG.E(new CdifError('LOAD_MODULE_FAIL', 'invalid package.json file'));
    if (info.name == null || info.name === '' || typeof(info.name) !== 'string') {
      return LOG.E(new CdifError('LOAD_MODULE_FAIL', 'invalid module name in package.json'));
    }

    this.loadModuleFromPath(options.localModulePath, info.name, info.version, function(err, mi) {
      if (err) return;
      LOG.I('load local module from path: ' + options.localModulePath);
    });
    return;
  }

  deviceDB.getAllModuleInfo(function(err, data) {
    if (err) {
      return LOG.E(new CdifError('GET_MODULE_INFO_FAIL', err.message));
    }

    if (data == null) return;

    data.forEach(function(item) {
      this.loadModuleFromPath(item.path, item.name, item.version, function(err, mi) {
        if (err) return;
        this.noofTotalModules ++;
      }.bind(this));
    }.bind(this));
  }.bind(this));
};

//this is a sync call if not enabled worker thread
ModuleManager.prototype.loadModuleFromPath = function(path, name, version, callback) {

  if (options.enableWorkerThread === true && isMainThread === true) {
    return this.loadModuleByWorker(path, name, version, callback);
  }

  var moduleConstructor = null;
  var moduleInstance    = null;

  if (typeof(path) !== 'string' || !fs.existsSync(path)) return callback(new CdifError('INVALID_MODULE_PATH', path));

  try {
    moduleConstructor = rewire(path);
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

ModuleManager.prototype.loadModuleByWorker = function(path, name, version, callback) {
  if (isMainThread) {
    var worker = new Worker(__dirname + '/sandbox.js'); //this is the name under release mode
    workerMessage.sendLoadModuleMessage(worker, {path: path, name: name, version: version}, callback);
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
      this.unloadModule(name);
      return callback(new CdifError('MODULE_VERSION_INFO_INVALID', version));
    }

    moduleConstructor = rewire(path);
    moduleInstance    = new moduleConstructor();
  } catch (e) {
    this.unloadModule(name);
    return callback(new CdifError('LOAD_MODULE_FAIL', e.message, e.stack));
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

ModuleManager.prototype.unloadModule = function(name) {
  var m = this.modules[name];
  if (m != null) {
    this.emit('moduleunload', name);
  }
};

//this call MUST NOT run under worker thread mode
ModuleManager.prototype.verifyModule = function(registryUrl, packageName, packagePath, callback) {
  var registry = registryUrl;
  if (typeof(registry) !== 'string') {
    registry = options.regUrl; //fall back to default registry url
  }

  if (typeof(packageName) !== 'string') {
    return callback(new CdifError('MODULE_NAME_TYPE_ERROR', packageName));
  }
  if (packagePath == null || typeof(packagePath) !== 'string') {
    return callback(new CdifError('MODULE_INSTALL_PATH_PREFIX_INVALID'));
  }

  var name = null, version = null;

  var _this     = this;
  var zlib      = require('zlib');
  var tar       = require('tar');
  var stream    = require('stream');
  var errorInfo = null;

  var file = fs.createReadStream(packageName);
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
      var data = '';
      bufferStream.on('data', function(chunk) {
        data += chunk;
      }).on('end', function() {
        var packageInfo;
        try {
          var packageInfo = JSON.parse(data);
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

        var installBasePath = packagePath + '/cdif-package';
        var command = 'npm install ' + '--prefix ' + installBasePath + ' --registry=' + registry + ' ' + packageName;

        try {
          fs.accessSync(packagePath, fs.W_OK);
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
