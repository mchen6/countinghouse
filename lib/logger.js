var bunyan      = require('bunyan');

//TODO: configurable error log path, per component (child) logging
module.exports = {
  createLogger: function() {
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
          level:  'error',
          type:   'file',
          path:   __dirname + '/../cdif-error-info.log'
        }
      ]
    });
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
    return {name: de.name, message: de.message};
  },
  errorSerializer: function(e) {
    return {message: e.message};
  }
};
