var events      = require('events');
var util        = require('util');
var options     = require('./lib/cli-options');
var npm         = require('npm');
var deviceDB    = require('./lib/device-db');
var CdifError   = require('./lib/error').CdifError;
//var forever = require('forever-monitor');

function ModuleManager() {
  this.modules = {};
  this.allowDiscover = options.allowDiscover;

  this.on('moduleload', this.onModuleLoad.bind(this));
  this.on('moduleunload', this.onModuleUnload.bind(this));
}

util.inherits(ModuleManager, events.EventEmitter);

ModuleManager.prototype.onModuleLoad = function(name, module) {
  console.log('module: ' + name + ' loaded');

  module.discoverState = 'stopped';

  var m = this.modules[name];
  if (m != null) {
    // module reloaded
    if (m.discoverState === 'discovering') {
      m.discoverState = 'stopped';
    }
  }
  this.modules[name] = module;

  if (this.allowDiscover === false) {
    module.emit('discover');
    setTimeout(function() {
      this.emit('stopdiscover');
    }.bind(module), 5000);
  }
};

ModuleManager.prototype.onModuleUnload = function(name) {
  console.log('module: ' + name + ' unloaded');
  var module = this.modules[name];
  if (module != null) {
    this.modules[name] = null;
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
      return console.error(err);
    }
    data.forEach(function(item) {
      var mod = null;
      try {
        mod = require(item.name);
      } catch (e) {
        return console.error(e);
      }

      var m = new mod();
      m.on('deviceonline',  this.onDeviceOnline.bind(this));
      m.on('deviceoffline', this.onDeviceOffline.bind(this));
      this.emit('moduleload', item.name, m);
    }.bind(this));
  }.bind(this));
};

ModuleManager.prototype.loadModule = function(name) {
  var mod = null;
  try {
    mod = require(name);
  } catch (e) {
    return console.error(e);
  }

  var m = new mod();
  m.on('deviceonline',  this.onDeviceOnline.bind(this));
  m.on('deviceoffline', this.onDeviceOffline.bind(this));
  this.emit('moduleload', name, m);
};

//TODO: check module validness, e.g. name start with cdif
ModuleManager.prototype.installModule = function(registry, name, version, callback) {
  var _this = this;

  if ((registry != null) && (typeof(registry) !== 'string' ||
    ((/^http:\/\/.{1,256}$/.test(registry) ||
     /^https:\/\/.{1,256}$/.test(registry)) === false))) {
    return callback(new CdifError('module install: invalid registry name'));
  }

  if (name == null || typeof(name) !== 'string') {
    return callback(new CdifError('invalid package name'));
  }

  if (typeof(version) !== 'string') {
    return callback(new CdifError('invalid package version'));
  }

  npm.load({}, function(err) {
    if (err) {
      console.log(err);
      return callback(new CdifError('module install failed: ' + name + ', error: ' + err.message), null);
    }

    if (registry != null) {
      npm.config.set('registry', registry);
    }

    var args = [];
    args.push(name + '@' + version);

    try {
      npm.commands.install(args, function(err, data) {
        if (err) {
          console.error(err);
          return callback(new CdifError('module install failed: ' + name + ', error: ' + err.message), null);
        }
        _this.addModuleInformation(name, version, function(e) {
          if (e) {
            return callback(new CdifError('add module record failed: ' + name + ', error: ' + e.message), null);
          }
          return callback(null);
        });
      });
    } catch (e) {
      return callback(new CdifError('module install failed: ' + name + ', error: ' + e.message), null);
    }
  });
};

ModuleManager.prototype.uninstallModule = function(name, callback) {
  callback(null);
};

ModuleManager.prototype.addModuleInformation = function(name, version, callback) {
  if (version === '') version = 'latest';

  deviceDB.setModuleInfo(name, version, function(err) {
    if (err) {
      return callback(new Error('cannot set module info in db: ' + err.message));
    }

    this.loadModule(name);
    return callback(null);
  }.bind(this));
};

module.exports = ModuleManager;
