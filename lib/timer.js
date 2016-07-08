var CdifError   = require('./error').CdifError;
var DeviceError = require('./error').DeviceError;

function Timer(device, eventName, session) {
  this.device     = device;
  this.eventName  = eventName;
  this.session    = session;
}

Timer.prototype.expire = function() {
  // this.device.removeListener(this.eventName, this.session.callback);
  if (this.device.online === true) this.device.online = false;
  if (this.device.connectionState !== 'disconnected') this.device.connectionState = 'disconnected';

  if (this.device.timer[this.eventName][this.session.uuid]) {
    delete this.device.timer[this.eventName][this.session.uuid];
  }

  this.session.callback(new DeviceError('device not responding'), null);
};

module.exports = Timer;
