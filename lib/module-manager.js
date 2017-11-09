var events      = require('events');
var util        = require('util');
var options     = require('../lib/cli-options');
var exec        = require('child_process').exec;
var deviceDB    = require('cdif-device-db');
var CdifError   = require('../lib/cdif-error').CdifError;
var LOG         = require('../lib/logger');
var rewire      = require('rewire');
var semver      = require('semver');
var mkdirp      = require('mkdirp');
var rimraf      = require('rimraf');
var fs          = require('fs');
var chmodr      = require('chmodr');
//var forever = require('forever-monitor');

function ModuleManager() {
  this.modules = {};

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

  if (options.allowDiscover === false) {
    module.emit('discover');
    setTimeout(function() {
      this.emit('stopdiscover');
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
    var moduleConstructor = null;
    var moduleInstance    = null;

    try {
      moduleConstructor = rewire(options.localModulePath);
      moduleInstance    = new moduleConstructor();
    } catch (e) {
      return LOG.E(new CdifError('LOAD_MODULE_FAIL', e.message));
    }

    moduleInstance.on('deviceonline',  this.onDeviceOnline.bind(this));
    moduleInstance.on('deviceoffline', this.onDeviceOffline.bind(this));
    LOG.I('loading local module from path: ' + options.localModulePath);

    var info = this.getModuleInfoFromPath(options.localModulePath);
    if (info == null) return LOG.E(new CdifError('LOAD_MODULE_FAIL', 'invalid package.json file'));
    if (info.name == null || info.name === '' || typeof(info.name) !== 'string') {
      return LOG.E(new CdifError('LOAD_MODULE_FAIL', 'invalid module name in package.json'));
    }
    return this.emit('moduleload', info.name, moduleInstance, info.version);
  }

  deviceDB.getAllModuleInfo(function(err, data) {
    if (err) {
      return LOG.E(new CdifError('GET_MODULE_INFO_FAIL', err.message));
    }

    if (data == null) return;

    data.forEach(function(item) {
      var mod = null;
      try {
        mod = rewire(item.path);
        var m = new mod();
        m.on('deviceonline',  this.onDeviceOnline.bind(this));
        m.on('deviceoffline', this.onDeviceOffline.bind(this));
        this.emit('moduleload', item.name, m, item.version);
      } catch (e) {
        return LOG.E(new CdifError('LOAD_MODULE_FAIL', e.message));
      }
    }.bind(this));
  }.bind(this));
};

ModuleManager.prototype.loadModule = function(name, version) {
  var moduleConstructor = null;
  var moduleInstance    = null;

  moduleConstructor = rewire(name);
  moduleInstance    = new moduleConstructor();

  moduleInstance.on('deviceonline',  this.onDeviceOnline.bind(this));
  moduleInstance.on('deviceoffline', this.onDeviceOffline.bind(this));

  this.emit('moduleload', name, moduleInstance, version);
  return moduleInstance;
};

ModuleManager.prototype.loadModuleFromPath = function(path, name, version) {
  var moduleConstructor = null;
  var moduleInstance    = null;

  if (typeof(path) !== 'string' || !fs.existsSync(path)) return callback(new CdifError('INVALID_MODULE_PATH', path));

  try {
    moduleConstructor = rewire(path);
    moduleInstance    = new moduleConstructor();
  } catch (e) {
    LOG.E(new CdifError('LOAD_MODULE_FAIL', e.message));
    return null;
  }

  moduleInstance.on('deviceonline',  this.onDeviceOnline.bind(this));
  moduleInstance.on('deviceoffline', this.onDeviceOffline.bind(this));

  this.emit('moduleload', name, moduleInstance, version);
  return moduleInstance;
};

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

    moduleConstructor = rewire(path);
    moduleInstance    = new moduleConstructor();
  } catch (e) {
    return callback(new CdifError('LOAD_MODULE_FAIL', e.message));
  }

  if (typeof(name) !== 'string') {
    return callback(new CdifError('MODULE_PACKAGE_NAME_TYPE_ERROR', name));
  }
  if (typeof(version) !== 'string' || semver.valid(version) == null) {
    return callback(new CdifError('MODULE_VERSION_INFO_INVALID', version));
  }

  moduleInstance.on('deviceonline',  this.onDeviceOnline.bind(this));
  moduleInstance.on('deviceoffline', this.onDeviceOffline.bind(this));

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

ModuleManager.prototype.verifyModule = function(packageName, packagePath, callback) {

  if (typeof(packageName) !== 'string') {
    return callback(new CdifError('MODULE_NAME_TYPE_ERROR', packageName));
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

        var command = null, installBasePath = null, prefixed = false;

        if (packagePath != null && typeof(packagePath) === 'string') {
          try {
            fs.accessSync(packagePath, fs.W_OK);
            installBasePath = packagePath + '/cdif-package';
            mkdirp.sync(installBasePath);
          } catch (e) {
            return callback(new CdifError('MODULE_INSTALL_PATH_PREFIX_INVALID', err.message));
          }

          command = 'npm install ' + '--prefix ' + installBasePath + ' ' + packageName;
          prefixed = true;
        } else {
          command = 'npm install ' + packageName;
        }

        try {
          exec(command, {timeout: 120000}, function(err, stdout, stderr) {
            if (err) {
              return callback(new CdifError('MODULE_INSTALL_FAIL', name, err.message));
            }

            var moduleInstance = null;
            if (prefixed === true) {
              // this is current designated npm behaviour by putting things under node_modules/<package-name>
              var path = installBasePath + '/node_modules/' + name;
              moduleInstance = _this.loadModuleFromPath(path, name, version);
            } else {
              try {
                moduleInstance = _this.loadModule(name, version);
              } catch (e) {
                return callback(new CdifError('LOAD_MODULE_FAIL', name, e));
              }
            }

            if (moduleInstance == null) {
              //no need to uninstall module since we are in docker instance
              return callback(new CdifError('LOAD_MODULE_FAIL', name));
            }
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
