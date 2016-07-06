var events = require('events');
var util   = require('util');
var supported_modules = require('./modules.json');

//var forever = require('forever-monitor');

function ModuleManager() {
  this.modules = {};

  this.on('moduleload', this.onModuleLoad.bind(this));
  this.on('moduleunload', this.onModuleUnload.bind(this));
}

util.inherits(ModuleManager, events.EventEmitter);

ModuleManager.prototype.onModuleLoad = function(name, module) {
  console.log('module: ' + name + ' loaded');
  var m = this.modules[name];
  if (m == null) {
    this.modules[name] = {};
  }

  this.modules[name].module = module;
  this.modules[name].state = 'loaded';
};

ModuleManager.prototype.onModuleUnload = function(name) {
  console.log('module: ' + name + ' unloaded');
  var m = this.modules[name];
  if (m != null) {
    this.modules[name].module = null;
    this.modules[name].state = 'unloaded';
  }
};

ModuleManager.prototype.discoverAllDevices = function() {
  var map = this.modules;

  for (var i in map) {
    if (map[i].state === 'loaded') {
      if (map[i].module.discoverState === 'discovering') {
        return;
      }
      map[i].module.emit('discover');
      map[i].module.discoverState = 'discovering';
    }
  }
};

ModuleManager.prototype.stopDiscoverAllDevices = function() {
  var map = this.modules;

  for (var i in map) {
    if (map[i].state === 'loaded') {
      if (map[i].module.discoverState === 'stopped') {
        return;
      }
      map[i].module.emit('stopdiscover');
      map[i].module.discoverState = 'stopped';
    }
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
