//this object serves as a broker for redis api cache operations in main thread
const Worker            = require('worker_threads').Worker;
const isMainThread      = require('worker_threads').isMainThread;
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

// The commands workers may name in a rediscommand message, filled by init().
const allowed = new Set();

module.exports = {
  client: null,   // the redis client instance

  // Module code can send a rediscommand message itself (it reaches the
  // worker's channel to the main thread), so the main thread checks the op
  // before dispatching: an op such as 'constructor' or '__proto__' used to
  // replace or poison the shared client for every module (review R1-3).
  isCommand: function(op) {
    return typeof(op) === 'string' && allowed.has(op);
  },

  init: function(deviceManager) {
    if (this.client == null) {

      // var commands = redisCommands.list.filter(function (command) {
      //   return command !== "monitor";
      // });
      const commands = _.intersection(redisCommands.list, supportedCommands);

      commands.forEach((commandName) => {
        RedisClient.prototype[commandName] = generateFunction(commandName);
        allowed.add(commandName);
      });


      if (isMainThread === true) {
        // the store's (lib/store.js): Redis db 5 in --store redis
        this.client = new RedisClient(require('./store').getStore().kv);
      } else {
        this.client = new RedisClient(deviceManager);
      }
    }
  },
}