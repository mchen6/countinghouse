const options      = require('./cli-options');
const v8           = require('v8');

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
      return;
    }

    if (packet.data == null) {
      return;
    }

    const data = packet.data;
    if (data.loadModule) {
      this.moduleManager.loadModuleFromPath(data.loadModule.path, data.loadModule.name, data.loadModule.version, () => {});
    } else if (data.unloadModule) {
      this.moduleManager.unloadModuleExternal(data.unloadModule.name, () => {});
    } else if (data.restartModule) {
      this.moduleManager.restartModule(data.restartModule.path, data.restartModule.name, data.restartModule.version, () => {});
    }
  },
  onProcessExit: function() {
    process.exit();
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