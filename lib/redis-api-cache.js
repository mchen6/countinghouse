//this object serves as a broker for redis api cache operations in main thread
var Worker            = require('worker_threads').Worker;
var isMainThread      = require('worker_threads').isMainThread;
var redis             = require('redis');
var stringHash        = require('string-hash');

var LOG               = require('./logger');
var options           = require('./cli-options');
var WorkerMessage     = require('./worker-message');


function RedisClient(dm) {
  this.workerMessage  = dm.workerMessage;
}

RedisClient.prototype.hmget = function() {
  //convert arguments object into JS array
  var args = Array.prototype.slice.call(arguments);
  //filter out callback argument and send redis command to main thread
  this.workerMessage.sendRedisCommandToParent({ op: 'hmget',   data: args.filter( function(item) {return typeof(item) !== 'function';} ) }, args[args.length - 1]);
}

RedisClient.prototype.hmset = function() {
  var args = Array.prototype.slice.call(arguments);
  this.workerMessage.sendRedisCommandToParent({ op: 'hmset',   data: args.filter( function(item) {return typeof(item) !== 'function';} ) }, args[args.length - 1]);
}

RedisClient.prototype.pexpire = function() {
  var args = Array.prototype.slice.call(arguments);
  this.workerMessage.sendRedisCommandToParent({ op: 'pexpire', data: args.filter( function(item) {return typeof(item) !== 'function';} ) }, args[args.length - 1]);
}

module.exports = {
  client: null,   // the redis client instance

  init: function(deviceManager) {
    if (this.client == null) {
      if (isMainThread === true) {
        this.client = redis.createClient(options.redisUrl, {db: 5});

        this.client.on('error', function (err) {
          if (options.debug !== true) LOG.E(err);
        });
      } else {
        this.client = new RedisClient(deviceManager);
      }
    }
  }
}