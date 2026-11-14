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

// The commands a module may name (and workers in a rediscommand message):
// redis-commands' list intersected with supported-redis-commands.json.
// The json lists 23 entries, zrange twice and zlen, which is not a Redis
// command, so the set is 21 (test/local-kv/00 pins it); local-kv
// implements exactly these.
// The prefixes of the keys the runtime keeps for itself in the shared kv: a
// module's command naming one is refused.
const RUNTIME_PREFIXES = Object.freeze(['jobinfo:']);
const ALLOWED_COMMANDS = Object.freeze(_.intersection(redisCommands.list, supportedCommands).slice().sort());
const allowed = new Set();

module.exports = {
  ALLOWED_COMMANDS: ALLOWED_COMMANDS,
  client: null,   // the redis client instance

  // Module code can send a rediscommand message itself (it reaches the
  // worker's channel to the main thread), so the main thread checks the op
  // before dispatching: an op such as 'constructor' or '__proto__' used to
  // replace or poison the shared client for every module (review R1-3).
  isCommand: function(op) {
    return typeof(op) === 'string' && allowed.has(op);
  },

  // Whether a module's command names one of the runtime's own keys in the
  // shared kv (R2-1 Task 5, the review of #163): job history
  // (jobinfo:<name>) holds other tenants' inputs, results and owners. Every
  // key argument: all of them for del and mget, the first for the rest, and
  // each command queued in a multi.
  touchesRuntimeKey: function touchesRuntimeKey(op, args) {
    const runtimeKey = (k) => typeof(k) === 'string' && RUNTIME_PREFIXES.some((p) => k.startsWith(p));
    const list = Array.isArray(args) ? args : [args];
    if (op === 'multi') return list.some((c) => Array.isArray(c) && touchesRuntimeKey(String(c[0]), c.slice(1)));
    if (op === 'del' || op === 'mget') return list.flat().some(runtimeKey);
    return runtimeKey(Array.isArray(list[0]) ? list[0][0] : list[0]);
  },

  init: function(deviceManager) {
    if (this.client == null) {

      // var commands = redisCommands.list.filter(function (command) {
      //   return command !== "monitor";
      // });
      const commands = ALLOWED_COMMANDS;

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