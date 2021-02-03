//this object serves as a broker for redis api cache operations in main thread
var Worker            = require('worker_threads').Worker;
var isMainThread      = require('worker_threads').isMainThread;
var redis             = require('redis');
var stringHash        = require('string-hash');

var LOG               = require('./logger');
var options           = require('./cli-options');
var WorkerMessage     = require('./worker-message');
var redisCommands     = require('redis-commands');


function RedisClient(dm) {
  this.workerMessage  = dm.workerMessage;
}

function generateFunction(_commandName) {
  return function () {
    var args = Array.prototype.slice.call(arguments);
    var name = _commandName;

    var callback = args[args.length - 1];
    if (typeof(callback) === 'function') {
      args.pop();
    } else {
      callback = undefined;
    }
    this.workerMessage.sendRedisCommandToParent({ op: name,   data: args.filter( function(item) {return typeof(item) !== 'function';} ) }, callback);
  };
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
        var commands = redisCommands.list.filter(function (command) {
          return command !== "monitor";
        });

        commands.forEach(function (commandName) {
          RedisClient.prototype[commandName] = generateFunction(commandName);
        }.bind(this));

        this.client = new RedisClient(deviceManager);
      }
    }
  }
}