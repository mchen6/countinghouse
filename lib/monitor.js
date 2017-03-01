var wss = require('./routes/wss');

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
      return wss.deleteAllClienIDs(function(err){});
    }

    if (packet.data == null) {
      return;
    }

    var data = packet.data;
    if (data.loadModule) {
      this.moduleManager.loadModuleFromPath(data.loadModule.path, data.loadModule.name, data.loadModule.version);
    } else if (data.unloadModule) {
      this.moduleManager.unloadModule(data.unloadModule.name);
    }
  },
  onProcessExit: function() {
    wss.deleteAllClienIDs(function(err) {
      console.log('process exit');
      process.exit();
    });
  }
};