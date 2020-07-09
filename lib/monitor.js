// var wss          = require('./routes/wss');
var options      = require('./cli-options');
var proxyHandler = require('./proxy-handler');
var v8           = require('v8');

module.exports = {
  init: function(mm, dm) {
    this.moduleManager = mm;
    this.deviceManager = dm;
    process.on('message', this.onProcessMessage.bind(this));
    process.on('exit',    this.onProcessExit.bind(this));
    process.on('SIGINT',  this.onProcessExit.bind(this));
  },

  // process message from pm2
  onProcessMessage: function(packet) {
    if (packet === 'shutdown') {
      // if (options.wsServer === true) wss.deleteAllClienIDs(function(err){});
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
    process.exit();
    // if (options.wsServer === true) {
    //   wss.deleteAllClienIDs(function(err) {
    //     process.exit();
    //   });
    // } else {
    //   process.exit();
    // }
  },
  //this msg is send to ccl only under workerThread mode
  // obj is workerMessage instance and obj.deviceList contains api specs of the devices managed by the worker
  //message is heap statistics message itself
  sendHeapStatMessageToParentController: function(obj, message) {
    // process.send({
    //   type : 'process:msg',
    //   data : {id:process.pid}
    // });
    if (options.withPM2 === true) {
      process.send({
        type: 'process:msg',
        data: {
          type: 'v8.heap.stat',
          devices: obj,
          stat: message
        }
      });
    }
  }
};