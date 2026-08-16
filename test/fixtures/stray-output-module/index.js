const util   = require('util');
const events = require('events');

const Device = CHUtil.loadFile(`${__dirname}/device.js`);

function DeviceModule() {
  this.on('discover',     this.discoverDevices.bind(this));
  this.on('stopdiscover', this.stopDiscoverDevices.bind(this));
}

util.inherits(DeviceModule, events.EventEmitter);

DeviceModule.prototype.discoverDevices = function() {
  this.emit('deviceonline', new Device(), this);
};

DeviceModule.prototype.stopDiscoverDevices = function() {
};

module.exports = DeviceModule;
