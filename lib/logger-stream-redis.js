var events        = require('events');
var jsonStringify = require('json-stringify-safe');
var util          = require('util');
var possibleTypes = ['channel', 'list', 'set'];

/**
 * Create a new RedisStream instance
 *
 * @param {Object} opts Stream options object
 * @param {String} [opts.key=logs] Name of Redis list or channel
 * @param {Object} opts.client Redis client instance
 * @param {String} [opts.type=channel] Redis data type (channel or list)
 *
 * @constructor
 */
function RedisStream(opts) {
  opts = opts || {};
  this._key = opts.key || 'logs';
  this._client = opts.client;

  if (!this._client) {
    return console.error('Must pass a Redis client');
  }

  this._write = getWriteFunction(opts.type ? opts.type.toLowerCase() : 'channel');
}

util.inherits(RedisStream, events.EventEmitter);

/**
 * Push the log entry to Redis
 *
 * @param {Object} entry
 */
RedisStream.prototype.write = function write(entry) {
  var self = this;

  self.emit('log', entry);
  this._write(entry);
};

/**
 * Push the entry to a list
 *
 * @param {Object} entry
 */
function writeList(entry) {
  var self = this;
  var data = null;

  if (typeof(entry) === 'object') {
    data = stringify(entry);
  } else {
    data = entry;
  }

  self._client.lpush(self._key, data, function(error) {
    if (error) {
      self.emit('error', error);
    } else {
      self.emit('logged', entry);
    }
  });
}

//do not emit event
function writeSet(entry) {
  var self = this;
  var data = null;

  if (typeof(entry) === 'object') {
    data = stringify(entry);
  } else {
    data = entry;
  }
  self._client.sadd(self._key, data);
}

/**
 * Publish the entry to a channel
 *
 * @param {Object} entry
 */
function writeChannel(entry) {
  var self = this;
  var data = null;

  if (typeof(entry) === 'object') {
    data = stringify(entry);
  } else {
    data = entry;
  }

  self._client.publish(self._key, data);
  self.emit('logged', entry);
}

/**
 * Safely convert value to string
 *
 * @param {object} object Value to be stringified
 * @returns {String}
 */
function stringify(object) {
  return jsonStringify(object, null, 2);
}

/**
 * Retrieves proper write function for the type passed
 *
 * @param {String} type
 * @returns {Function}
 * @throws {Error} Will throw an error if type is unknown
 */
function getWriteFunction(type) {
  if (possibleTypes.indexOf(type) === -1) {
    console.error('Unknown Redis stream type: "' + type + '". Must be "channel" or "list" or "set".');
    return null;
  } else if (type === 'channel') {
    return writeChannel;
  } else if (type === 'list') {
    return writeList;
  } else if (type === 'set') {
    return writeSet;
  }
  return null;
}

module.exports = RedisStream;