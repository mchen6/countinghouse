var bunyan = require('bunyan');

//TODO: configurable error log path
module.exports = {
  createLogger: function() {
    this.logger = bunyan.createLogger({
      name: 'cdif',
      streams: [
        {
          level: 'info',
          stream: process.stdout
        },
        {
          level:  'error',
          type:   'rotating-file',
          path:   './cdif-error.log',
          period: '1d',
          count: 3
        }
      ]
    });
  },
  info: function(logInfo) {
    this.logger.info(logInfo);
  },
  error: function(errorInfo) {
    this.logger.error(errorInfo);
  }
};
