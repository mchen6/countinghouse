var events      = require('events');
var util        = require('util');
var CdifError   = require('./error').CdifError;
var DeviceError = require('./error').DeviceError;
var uuid        = require('uuid-1345');

function Timer(session) {
  this.session    = session;
  this.uuid       = uuid.v4fast();
  this.expired    = false;

  this.timeout = setTimeout(this.expire.bind(this), 10000);
}

util.inherits(Timer, events.EventEmitter);

Timer.prototype.expire = function() {
  // if (this.device.connectionState !== 'disconnected') this.device.connectionState = 'disconnected';
  this.expired = true;
  this.emit('expired', this);
  // delete this.session.timers[this.uuid];
  // this.session.callback(new DeviceError('device not responding'), null);
};

module.exports = Timer;
