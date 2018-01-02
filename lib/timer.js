var events      = require('events');
var util        = require('util');
var options     = require('./cli-options');

function Timer() {
  this.expired = false;
  this.timeout = setTimeout(this.expire.bind(this), options.requestTimeout);
}

util.inherits(Timer, events.EventEmitter);

Timer.prototype.expire = function() {
  this.expired = true;
  this.emit('expired', this);
};

module.exports = Timer;
