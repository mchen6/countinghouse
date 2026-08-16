const util   = require('util');
const events = require('events');

const Device = CHUtil.loadFile(`${__dirname}/device.js`);

// The dynamic-discovery shape, kept supported in 6.0.0 alongside handler maps.
// How many devices exist is decided here, at discover time -- the count comes
// from the environment, standing in for "one device per configured database
// connection" and the like. A handler map cannot express this: it is one
// device, described statically by api.json.
function DeviceModule() {
  this.on('discover',     this.discoverDevices.bind(this));
  this.on('stopdiscover', this.stopDiscoverDevices.bind(this));
}

util.inherits(DeviceModule, events.EventEmitter);

DeviceModule.prototype.discoverDevices = function() {
  const count = parseInt(process.env.DYNAMIC_DEVICE_COUNT, 10) || 2;

  for (let i = 1; i <= count; i++) {
    const device = new Device(`dynamic-device-${i}`);
    device.on('retire-me', (d) => { this.emit('deviceoffline', d, this); });
    this.emit('deviceonline', device, this);
  }
};

DeviceModule.prototype.stopDiscoverDevices = function() {
};

module.exports = DeviceModule;
