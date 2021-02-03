//this object serves as a broker for redis api cache operations in main thread
var Worker            = require('worker_threads').Worker;
var isMainThread      = require('worker_threads').isMainThread;
var redis             = require('redis');
var stringHash        = require('string-hash');

var LOG               = require('./logger');
var options           = require('./cli-options');

var WorkerMessage     = require('./worker-message');
var supportedCommands = require('./supported-redis-commands.json');
var redisCommands     = require('redis-commands');
var _                 = require('lodash');


function RedisClient(clientInstance) {
  if (isMainThread === true) {
    this.clientInstance = clientInstance;
  } else {
    this.clientInstance  = clientInstance.workerMessage;
  }
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

    if (isMainThread === true) {
      this.clientInstance[name](...args, callback);
    } else {
      this.clientInstance.sendRedisCommandToParent({op: name, data: args}, callback);
    }
  };
}

module.exports = {
  client: null,   // the redis client instance

  init: function(deviceManager) {
    if (this.client == null) {

      // var commands = redisCommands.list.filter(function (command) {
      //   return command !== "monitor";
      // });
      var commands = _.intersection(redisCommands.list, supportedCommands);

      commands.forEach(function (commandName) {
        RedisClient.prototype[commandName] = generateFunction(commandName);
      }.bind(this));


      if (isMainThread === true) {
        var redisClient = redis.createClient(options.redisUrl, {db: 5});
        redisClient.on('error', function (err) {});

        this.client = new RedisClient(redisClient);
      } else {
        this.client = new RedisClient(deviceManager);
      }
    }
  },
}