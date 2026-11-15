const events      = require('events');
const util        = require('util');
const options     = require('./cli-options');

// ms: the call's own timeout (lib/call-limits.js); the global one when none
function Timer(ms) {
  this.expired = false;
  this.timeout = setTimeout(this.expire.bind(this), Number.isFinite(ms) ? ms : options.requestTimeout);
}

util.inherits(Timer, events.EventEmitter);

Timer.prototype.expire = function() {
  this.expired = true;
  this.emit('expired', this);
};

module.exports = Timer;
