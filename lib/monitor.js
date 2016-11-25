module.exports = {
  init: function(mm) {
    this.moduleManager = mm;
    process.on('message', this.onProcessMessage.bind(this));
  },

  // process message from pm2
  onProcessMessage: function(packet) {
    var data = packet.data;
    if (data.loadModule) {
      this.moduleManager.loadModuleFromPath(data.loadModule.path, data.loadModule.name, data.loadModule.version);
    } else if (data.unloadModule) {
      this.moduleManager.unloadModule(data.unloadModule.name);
    }
  }
};