var bunyan      = require('bunyan');
var CdifDevice  = require('cdif-device');

//TODO: configurable error log path, per component (child) logging
module.exports = {
  createLogger: function() {
    this.logger = bunyan.createLogger({
      name: 'cdif',
      serializers: bunyan.stdSerializers,
      streams: [
        {
          level: 'info',
          stream: process.stdout
        },
        {
          level:  'error',
          type:   'file',
          path:   __dirname + '/../cdif-error.log'
        }
      ]
    });
  },
  E: function(errorInfo) {
    // this takes an error object as input
    this.logger.error(errorInfo);
    return errorInfo;
  },
  DE: function(device, errorInfo) {
    // this takes an error object as input
    if (device != null && device instanceof CdifDevice) {
      device.lastDeviceError = errorInfo;
    }
    this.logger.error(errorInfo);
    return errorInfo;
  },
  I: function(logMessage) {
    // this takes an error message as input
    this.logger.info(logMessage);
    return logMessage;
  }
};
