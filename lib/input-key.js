var events            = require('events');
var util              = require('util');

function InputKey(key) {
}

util.inherits(InputKey, events.EventEmitter);

module.exports = InputKey;