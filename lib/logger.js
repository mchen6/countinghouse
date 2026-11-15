const bunyan      = require('bunyan');
const options     = require('./cli-options');

// var redisClient = redis.createClient(options.redisUrl, {db: 7});
// var RedisStream = require('./logger-stream-redis');

// redisClient.on('error', function (err) {
//   if (options.debug !== true) console.error(err);
// });

// var redisStream = new RedisStream({
//   client : redisClient,
//   key    : 'logs',
//   type   : 'channel'
// });

//TODO: configurable error log path, per component (child) logging
//TODO: each worker thread has a logger instance. set its moduleInstance
//so we can have per-module log info to redis
// A worker's runtime file may log before anything in that worker made a
// logger (a lean worker makes it on the first line logged, whichever file
// logs it): it is then the worker's (lib/worker-logger.js), whose records go
// to the main thread. The main thread makes its own at start.
function ready() {
  if (module.exports.logger == null && require('./thread-info').isMainThread !== true) require('./worker-logger').createWorkerLogger();
  return module.exports.logger;
}

module.exports = {
  createLogger: function(logStream) {
    if (logStream === true) {
      this.logger = bunyan.createLogger({
        name: 'countinghouse',
        serializers: {
          de: this.deviceErrorSerializer,
          e:  this.errorSerializer
        },
        streams: [
          {
            level: 'info',
            stream: process.stdout
          }
          // {
          //   level: 'error',
          //   type:   'raw',
          //   stream: redisStream
          // }
        ]
      });
    } else {
      this.logger = bunyan.createLogger({
        name: 'countinghouse',
        serializers: {
          de: this.deviceErrorSerializer,
          e:  this.errorSerializer
        },
        streams: [
          {
            level: 'info',
            stream: process.stdout
          }
        ]
      });
    }
  },
  E: function(errorInfo) {
    ready().error({e: errorInfo});
    return errorInfo;
  },
  DE: function(device, errorInfo) {
    // this takes an error object as input
    if (device != null) {
      device.lastDeviceError = errorInfo;
      if (device.spec) return ready().error({de: {name: device.spec.device.friendlyName, message: errorInfo.message}});
    }
    return ready().error({de: {message: errorInfo.message}});
  },
  W: function(logMessage) {
    ready().warn(logMessage);
    return logMessage;
  },
  I: function(logMessage) {
    // this takes an error message as input
    ready().info(logMessage);
    return logMessage;
  },
  deviceErrorSerializer: function(de) {
    // a worker's record arrives already serialized (lib/worker-output.js)
    if (typeof(de) === 'string') return de;
    return `${de.name}: ${de.message}`;
  },
  errorSerializer: function(e) {
    if (Array.isArray(e) === true) return JSON.stringify(e);
    if (typeof(e) === 'object')    return e.message;
    return e;
  }
};
