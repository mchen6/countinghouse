var CdifError   = require('./error').CdifError;
var DeviceError = require('./error').DeviceError;
var uuid        = require('uuid');

function Timer(device, session) {
  this.device     = device;
  this.session    = session;
  this.uuid       = uuid.v4();
  this.expired    = false;

  this.timeout = setTimeout(this.expire.bind(this), 30000);
  this.expire  = this.expire.bind(this);
}

Timer.prototype.expire = function() {
  // if (this.device.connectionState !== 'disconnected') this.device.connectionState = 'disconnected';
  this.expired = true;
  delete this.session.timers[this.uuid];
  this.session.callback(new DeviceError('device not responding'), null);
};

module.exports = Timer;
