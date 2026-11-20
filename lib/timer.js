'use strict';
const events      = require('events');
const util        = require('util');
const options     = require('./cli-options');

// ms: the call's own timeout (lib/call-limits.js); the global one when none
function Timer(ms) {
  this.expired = false;
  // (clamped: past 2^31-1 ms setTimeout fires at once, as dropAfter clamps too)
  this.timeout = setTimeout(this.expire.bind(this), Math.min(Number.isFinite(ms) ? ms : options.requestTimeout, 2147483647));
}

util.inherits(Timer, events.EventEmitter);

Timer.prototype.expire = function() {
  this.expired = true;
  this.emit('expired', this);
};

module.exports = Timer;
