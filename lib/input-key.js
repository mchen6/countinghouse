var events            = require('events');
var util              = require('util');
var redis             = require('redis');
var LOG               = require('./logger');
var options           = require('./cli-options');

var redisPub         = redis.createClient(options.redisUrl, {db: 6});
var redisSub         = redis.createClient(options.redisUrl, {db: 6});

redisSub.subscribe('keyupdate');

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
}

util.inherits(InputKey, events.EventEmitter);

//publish to global redis channel
InputKey.prototype.emitEvent = function(eventData) {
  redisPub.publish('keyupdate', JSON.stringify({key: this.key, value: eventData}));
};

InputKey.prototype.addEventSubscriber = function(subscriber) {
  redisSub.addListener('message', subscriber);
};

InputKey.prototype.removeEventSubscriber = function(subscriber) {
  redisSub.removeListener('message', subscriber);
};

module.exports = InputKey;
