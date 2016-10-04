var events      = require('events');
var util        = require('util');
var options     = require('../lib/cli-options');
var exec        = require('child_process').exec;
var deviceDB    = require('../lib/device-db');
var CdifError   = require('../lib/error').CdifError;
var logger      = require('../lib/logger');
var rewire      = require('rewire');
var semver      = require('semver');
var fs          = require('fs');
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
  logger.info('module: ' + name + '@' + version + ' loaded');

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
  logger.info('module: ' + name + ' unloaded');

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
  this.emit('deviceonline', device, module);
};

ModuleManager.prototype.onDeviceOffline = function(device, module) {
  this.emit('deviceoffline', device, module);
};

ModuleManager.prototype.loadAllModules = function() {
  deviceDB.getAllModuleInfo(function(err, data) {
    if (err) {
      return logger.error(err);
    }

    if (data == null) return;

    data.forEach(function(item) {
      var mod = null;
      try {
        mod = rewire(item.name);
      } catch (e) {
        return logger.error(e);
      }

      var m = new mod();
      m.on('deviceonline',  this.onDeviceOnline.bind(this));
      m.on('deviceoffline', this.onDeviceOffline.bind(this));
      this.emit('moduleload', item.name, m, item.version);
    }.bind(this));
  }.bind(this));

  // load any local module specified on command line
  if (options.localModulePath != null) {
    logger.info('load local module from path: ' + options.localModulePath);

    try {
      var moduleConstructor = rewire(options.localModulePath);
      var moduleInstance    = new moduleConstructor();

      moduleInstance.on('deviceonline',  this.onDeviceOnline.bind(this));
      moduleInstance.on('deviceoffline', this.onDeviceOffline.bind(this));
      this.emit('moduleload', options.localModulePath, moduleInstance, 'local'); // local module won't need version info

    } catch (e) {
      return logger.error('local module load failed: ' + options.localModulePath + ', reason: ' + e.message, null);
    }
  }
};

ModuleManager.prototype.loadModule = function(name, version) {
  var moduleConstructor = null;
  var moduleInstance    = null;

  try {
    moduleConstructor = rewire(name);
    moduleInstance    = new moduleConstructor();
  } catch (e) {
    logger.error(e);
    return null;
  }

  moduleInstance.on('deviceonline',  this.onDeviceOnline.bind(this));
  moduleInstance.on('deviceoffline', this.onDeviceOffline.bind(this));

  this.emit('moduleload', name, moduleInstance, version);
  return moduleInstance;
};

ModuleManager.prototype.unloadModule = function(name) {
  this.emit('moduleunload', name);
};

//TODO: check module validness, e.g. name start with cdif
ModuleManager.prototype.installModuleFromRegistry = function(registry, name, version, callback) {
  if ((registry != null) && (typeof(registry) !== 'string' ||
    ((/^http:\/\/.{1,256}$/.test(registry) ||
     /^https:\/\/.{1,256}$/.test(registry)) === false))) {
    return callback(new CdifError('module install: invalid registry name'));
  }

  if (name == null || typeof(name) !== 'string') {
    return callback(new CdifError('invalid package name'));
  }

  if (typeof(version) !== 'string' || semver.valid(version) == null) {
    return callback(new CdifError('invalid package version: ' + version));
  }

  var command = null;
  if (registry == null) {
    command = 'npm install ' + name + '@' + version;
  } else {
    command = 'npm install ' + '--registry=' + registry + ' ' + name + '@' + version;
  }

  try {
    exec(command, {timeout: 60000}, function(err, stdout, stderr) {
      if (err) {
        return callback(new CdifError('module install failed: ' + name + ', reason: ' + err.message), null);
      }

      logger.info('module installed: ' + name + '@' + version);

      this.addModuleInformation(name, version, function(e) {
        if (e) {
          return callback(new CdifError('add module record failed: ' + name + ', reason: ' + e.message), null);
        }
        this.loadModule(name, version);
        return callback(null, {name: name, version: version});
      }.bind(this));
    }.bind(this));
  } catch (e) {
    return callback(new CdifError('module install failed: ' + name + ', reason: ' + e.message), null);
  }
};

ModuleManager.prototype.uninstallModule = function(name, callback) {
  if (name == null || typeof(name) !== 'string') {
    return callback(new CdifError('invalid package name'));
  }

  var command = 'npm uninstall ' + name;

  try {
    exec(command, {timeout: 60000}, function(err, stdout, stderr) {
      if (err) {
        return callback(new CdifError('module uninstall failed: ' + name + ', reason: ' + err.message), null);
      }

      logger.info('module uninstalled: ' + name);

      this.removeModuleInformation(name, function(e) {
        if (e) {
          return callback(new CdifError('remove module record failed: ' + name + ', reason: ' + e.message), null);
        }
        this.unloadModule(name);
        return callback(null);
      }.bind(this));
    }.bind(this));
  } catch (e) {
    return callback(new CdifError('module uninstall failed: ' + name + ', reason: ' + e.message), null);
  }
};

ModuleManager.prototype.addModuleInformation = function(name, version, callback) {
  if (version === '') version = 'latest';

  deviceDB.setModuleInfo(name, version, function(err) {
    if (err) {
      return callback(new Error('cannot set module info in db: ' + err.message));
    }
    return callback(null);
  }.bind(this));
};

ModuleManager.prototype.removeModuleInformation = function(name, callback) {
  deviceDB.removeModuleInfo(name, function(err) {
    if (err) {
      return callback(new Error('cannot remove module info in db: ' + err.message));
    }
    return callback(null);
  }.bind(this));
};

ModuleManager.prototype.verifyModule = function(packageName, callback) {

  if (typeof(packageName) !== 'string') {
    return callback(new CdifError('package name incorrect: ' + packageName));
  }

  var name = null, version = null;

  var _this     = this;
  var zlib      = require('zlib');
  var tar       = require('tar');
  var stream    = require('stream');
  var errorInfo = null;

  var file = fs.createReadStream(packageName);
  file.on('error', function(e) {
    return callback(new CdifError(e));
  });

  var unzip = file.pipe(zlib.Unzip());
  unzip.on('error', function(e) {
    return callback(new CdifError(e));
  });

  var tar = unzip.pipe(tar.Parse());
  tar.on('error', function(e) {
    return callback(new CdifError(e));
  });

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
          return callback(new CdifError('invalid package.json file'));
        }

        name    = packageInfo.name;
        version = packageInfo.version;
        if (typeof(name) !== 'string' || typeof(version) !== 'string' || semver.valid(version) == null) {
          return callback(new CdifError('invalid package name or version: ' + name + '@' + version));
        }

        var command = 'npm install ' + packageName;

        try {
          exec(command, {timeout: 120000}, function(err, stdout, stderr) {
            if (err) {
              return callback(new CdifError('unable to locally install package: ' + name + ', reason: ' + err.message));
            }
            //TODO: check if this version already exists in registry so we can prompt user earlier
            var moduleInstance = _this.loadModule(name, version);

            //give time to allow device online
            setTimeout(function() {
              //get the list of device objects which belongs to moduleInstance
              //this event is handled by device manager
              _this.emit('querydevicelist', moduleInstance, name, version, callback);
            }, 3000);
          });
        } catch (e) {
          return callback(new CdifError('unable to locally install package: ' + name + ', reason: ' + e.message));
        }
      }).on('error', function(err) {
        return callback(new CdifError(err));
      });

      entry.pipe(bufferStream).on('error', function(err) {
        return callback(new CdifError(err));
      });
    }
  });
};

ModuleManager.prototype.onQueryDeviceListResult = function(error, deviceList, moduleName, moduleVersion, callback) {
  return callback(error, {name: moduleName, version: moduleVersion, deviceList: deviceList});
};

ModuleManager.prototype.publishModule = function(option, callback) {
  if (typeof(option.user) !== 'string' || typeof(option.pass) !== 'string' || typeof(option.email) !== 'string') {
    return callback(new CdifError('must provide correct user credential'));
  }

  if (typeof(option.moduleName) !== 'string') {
    return callback(new CdifError('module name must be string: ' + option.moduleName));
  }

  var registry = option.registry;

  if ((registry != null) && (typeof(registry) !== 'string' ||
    ((/^http:\/\/.{1,256}$/.test(registry) ||
     /^https:\/\/.{1,256}$/.test(registry)) === false))) {
    return callback(new CdifError('module publish: invalid registry name: ' + option.registry));
  }

  var command = 'npm root';
  var packagePath = null;

  try {
    exec(command, {timeout: 30000}, function(err, stdout, stderr) {
      if (err) {
        return callback(new CdifError('get npm root path failed: ' + err.message));
      }
      packagePath = stdout.replace(/(\r\n|\n|\r)/gm, '') + '/' + option.moduleName;

      this.packPackage(packagePath, function(error, zippedPackageName) {
        if (error) {
          return callback(error);
        }
        this.publishPackage(zippedPackageName, packagePath, option, function(err) {
          // uninstall and rimraf package no matter publish success or fail
          this.uninstallModule(option.moduleName, function(e) {
            var rimraf = require('rimraf');
            rimraf(zippedPackageName, function() {
              if (err) return callback(err);
              return callback(e);
            });
          });
        }.bind(this));
      }.bind(this));
    }.bind(this));
  } catch (e) {
    return callback(new CdifError('get npm root path failed: ' + e.message));
  }

  // publish to registry, unload module, and uninstall package
};

ModuleManager.prototype.packPackage = function(packagePath, callback) {
  var cmd = 'npm pack ' + packagePath;
  try {
    exec(cmd, {timeout: 30000}, function(err, stdout, stderr) {
      if (err) {
        var error = new CdifError('pack failed for package: ' + packagePath + ', reason: ' + err.message);
        return callback(error);
      }
      zippedPackageName =  process.cwd() + '/' + stdout.replace(/(\r\n|\n|\r)/gm, '');
      console.log(zippedPackageName);
      callback(null, zippedPackageName);
    });
  } catch (e) {
    return callback(new CdifError('pack failed for package: ' + packagePath + ', reason: ' + e.message));
  }
};

ModuleManager.prototype.publishPackage = function(packageName, packagePath, option, callback) {
  try {
    fs.accessSync(packagePath, fs.W_OK);
    var packageInfo = JSON.parse(fs.readFileSync(packagePath + '/package.json').toString());
    var RegClient   = require('npm-registry-client');
    var client      = new RegClient({});
    var uri         = option.registry;

    var params = {
      timeout: 30000,
      metadata: packageInfo,
      body: fs.createReadStream(packageName),
      auth: {
        username: option.user,
        password: option.pass,
        email: option.email,
        alwaysAuth: true
      }
    };

    client.publish(uri, params, function(error, data, raw, res) {
      if (error) {
        return callback(new CdifError(error.message));
      }
      return callback(null);
    });
  } catch (e) {
    return callback(new CdifError('cannot publish package at: ' + zippedPackageName + ', reason: ' + e.message));
  }
};

module.exports = ModuleManager;
