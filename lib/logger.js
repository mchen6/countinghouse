const bunyan      = require('bunyan');
const redis       = require('redis');
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
// Under --stdio, stdout is the MCP transport: the log goes to stderr. The
// stream is chosen at each write, because a worker learns its options only
// after it has created its logger (lib/sandbox.js).
const out = {write: (s) => (require('./cli-options').stdio === true ? process.stderr : process.stdout).write(s)};

//so we can have per-module log info to redis
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
            stream: out
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
            stream: out
          }
        ]
      });
    }
  },
  E: function(errorInfo) {
    this.logger.error({e: errorInfo});
    return errorInfo;
  },
  DE: function(device, errorInfo) {
    // this takes an error object as input
    if (device != null) {
      device.lastDeviceError = errorInfo;
      if (device.spec) return this.logger.error({de: {name: device.spec.device.friendlyName, message: errorInfo.message}});
    }
    return this.logger.error({de: {message: errorInfo.message}});
  },
  W: function(logMessage) {
    this.logger.warn(logMessage);
    return logMessage;
  },
  I: function(logMessage) {
    // this takes an error message as input
    this.logger.info(logMessage);
    return logMessage;
  },
  deviceErrorSerializer: function(de) {
    return `${de.name}: ${de.message}`;
  },
  errorSerializer: function(e) {
    if (Array.isArray(e) === true) return JSON.stringify(e);
    if (typeof(e) === 'object')    return e.message;
    return e;
  }
};
