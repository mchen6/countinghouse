var events            = require('events');
var util              = require('util');
var redis             = require('redis');
var LOG               = require('./logger');
var options           = require('./cli-options');

var redisPub         = redis.createClient(options.redisUrl, {db: 6});
var redisSub         = redis.createClient(options.redisUrl, {db: 6});

redisPub.on('error', function (err) {
  LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
});

redisSub.on('error', function (err) {
  LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
});

//here the key is the hashCode of input JSON object
//TODO: how to handle hash collision??
function InputKey(key) {
  this.key = key;
  redisSub.addListener('message', this.eventSubscriber.bind(this));
  //TODO: redis sub cmd is O(N) so when key space is very large there could be performance issues
  //better to sub to a single channel and pub difference messages and filter out their key patterns
  //TODO: is there a need to support unsubscribe to a key?
  redisSub.subscribe(key);
}

util.inherits(InputKey, events.EventEmitter);

//publish to global redis channel
InputKey.prototype.emitEvent = function(eventData) {
  redisPub.publish(this.key, eventData);
};

InputKey.prototype.addEventSubscriber = function(subscriber) {
  this.addListener(this.key, subscriber);
};

InputKey.prototype.removeEventSubscriber = function(subscriber) {
  this.removeListener(this.key, subscriber);
};

InputKey.prototype.eventSubscriber = function(key, message) {
  if (key === this.key) {
    this.emit(key, key, message);
  }
};

module.exports = InputKey;
