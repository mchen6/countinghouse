//this object serves as a broker for redis api cache operations in main thread
const Worker            = require('worker_threads').Worker;
const isMainThread      = require('worker_threads').isMainThread;
const redis             = require('redis');
const stringHash        = require('string-hash');

const LOG               = require('./logger');
const options           = require('./cli-options');

const WorkerMessage     = require('./worker-message');
const supportedCommands = require('./supported-redis-commands.json');
const redisCommands     = require('redis-commands');
const _                 = require('lodash');


function RedisClient(clientInstance) {
  if (isMainThread === true) {
    this.clientInstance = clientInstance;
  } else {
    this.clientInstance  = clientInstance.workerMessage;
  }
}

function generateFunction(_commandName) {
  return function () {
    const args = Array.prototype.slice.call(arguments);
    const name = _commandName;

    let callback = args[args.length - 1];
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
      const commands = _.intersection(redisCommands.list, supportedCommands);

      commands.forEach((commandName) => {
        RedisClient.prototype[commandName] = generateFunction(commandName);
      });


      if (isMainThread === true) {
        const redisClient = redis.createClient(options.redisUrl, {db: 5});
        redisClient.on('error', (err) => {});

        this.client = new RedisClient(redisClient);
      } else {
        this.client = new RedisClient(deviceManager);
      }
    }
  },
}