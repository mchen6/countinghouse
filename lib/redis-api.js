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

// A module's ctx.redis in single-thread mode (the module runs on the main
// thread): every command put in the module's namespace before it is sent, as
// the main thread does for a worker's (#164; lib/redis-namespace.js
// runNamespaced). One per module, made once. Refused commands call back with
// an error; with no callback, nothing is said, as in a worker.
const namespaced = new Map();
function namespacedClient(clientOf, moduleName) {
  if (namespaced.has(moduleName)) return namespaced.get(moduleName);
  const ns = require('./redis-namespace');
  const prefix = ns.prefixFor(moduleName);
  const out = {};
  for (const op of ALLOWED_COMMANDS) {
    out[op] = (...args) => {
      const callback = (typeof(args[args.length - 1]) === 'function') ? args.pop() : () => {};
      ns.runNamespaced(clientOf(), prefix, op, args, (e, result) => callback(e, result));
    };
  }
  const client = Object.freeze(out);
  namespaced.set(moduleName, client);
  return client;
}

// The commands a module may name (and workers in a rediscommand message):
// redis-commands' list intersected with supported-redis-commands.json.
// The json lists 21 entries, zrange twice and zlen, which is not a Redis
// command, so the set is 19 (test/local-kv/00 pins it). multi and exec are
// not on it (#164): under --store redis node_redis's multi runs any command
// name queued in it, and neither store called a module's multi back.
const ALLOWED_COMMANDS = Object.freeze(_.intersection(redisCommands.list, supportedCommands).slice().sort());
const allowed = new Set();

module.exports = {
  ALLOWED_COMMANDS: ALLOWED_COMMANDS,
  namespacedClient: (moduleName) => namespacedClient(() => module.exports.client, moduleName),
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