var events = require('events');
var util   = require('util');
var supported_modules = require('./modules.json');

//var forever = require('forever-monitor');

function ModuleManager(allowDiscover) {
  this.modules = {};
  this.allowDiscover = allowDiscover;

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

ModuleManager.prototype.loadModules = function() {
  supported_modules.forEach(function(item) {
    var mod = require(item);

    var m = new mod();

    m.on('deviceonline',  this.onDeviceOnline.bind(this));
    m.on('deviceoffline', this.onDeviceOffline.bind(this));
    this.emit('moduleload', item, m);
  }.bind(this));
}

module.exports = ModuleManager;
