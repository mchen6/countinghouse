var wss          = require('./routes/wss');
var options      = require('./cli-options');
var proxyHandler = require('./proxy-handler');

module.exports = {
  init: function(mm) {
    this.moduleManager = mm;
    process.on('message', this.onProcessMessage.bind(this));
    process.on('exit',    this.onProcessExit.bind(this));
    process.on('SIGINT',  this.onProcessExit.bind(this));
  },

  // process message from pm2
  onProcessMessage: function(packet) {
    if (packet === 'shutdown') {
      if (options.wsServer === true) wss.deleteAllClienIDs(function(err){});
      return;
    }

    if (packet.data == null) {
      return;
    }

    var data = packet.data;
    if (data.loadModule) {
      this.moduleManager.loadModuleFromPath(data.loadModule.path, data.loadModule.name, data.loadModule.version, function() {});
    } else if (data.unloadModule) {
      this.moduleManager.unloadModuleExternal(data.unloadModule.name, function() {});
    } else if (data.restartModule) {
      this.moduleManager.restartModule(data.restartModule.path, data.restartModule.name, data.restartModule.version, function() {});
    } else if (data.loadApiProxy) {
      if (options.reverseProxy) {
        proxyHandler.loadProxyHost(data.loadApiProxy.deviceID, data.loadApiProxy.target);
      }
    }
  },
  onProcessExit: function() {
    if (options.wsServer === true) {
      wss.deleteAllClienIDs(function(err) {
        process.exit();
      });
    } else {
      process.exit();
    }
  }
};