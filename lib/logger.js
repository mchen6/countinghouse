var bunyan      = require('bunyan');
var redis       = require('redis');
var options     = require('./cli-options');
var redisClient = redis.createClient(options.redisUrl, {db: 7});
var RedisStream = require('./logger-stream-redis');

redisClient.on('error', function (err) {
  if (options.debug !== true) console.error(err);
});

var redisStream = new RedisStream({
  client : redisClient,
  key    : 'logs',
  type   : 'channel'
});

//TODO: configurable error log path, per component (child) logging
module.exports = {
  createLogger: function(logStream) {
    if (logStream === true) {
      this.logger = bunyan.createLogger({
        name: 'cdif',
        serializers: {
          de: this.deviceErrorSerializer,
          e:  this.errorSerializer
        },
        streams: [
          {
            level: 'info',
            stream: process.stdout
          },
          {
            level: 'error',
            type:   'raw',
            stream: redisStream
          }
        ]
      });
    } else {
      this.logger = bunyan.createLogger({
        name: 'cdif',
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
          //   level:  'error',
          //   stream: process.stderr
          // }
        ]
      });
    }
  },
  E: function(errorInfo) {
    // this takes an error object as input
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
  I: function(logMessage) {
    // this takes an error message as input
    this.logger.info(logMessage);
    return logMessage;
  },
  deviceErrorSerializer: function(de) {
    return de.name + ': ' + de.message;
  },
  errorSerializer: function(e) {
    return e.message;
  }
};
