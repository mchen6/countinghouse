var events      = require('events');
var util        = require('util');

function Timer() {
  this.expired = false;
  this.timeout = setTimeout(this.expire.bind(this), 30000);
}

util.inherits(Timer, events.EventEmitter);

Timer.prototype.expire = function() {
  this.expired = true;
  this.emit('expired', this);
};

module.exports = Timer;
