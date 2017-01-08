var options   = require('./cli-options');

function CdifError(...args) {
  this.topic   = 'cdif error';

  var errorCode     = args[0];
  this.message      = this.getDeviceErrorMessage(errorCode);
  if (args.length > 1) {
    this.message     += ': ';
    for (var index = 1; index < args.length; index++) {
      this.message += args[index];
      this.message += ' ';
    }
  }
}

CdifError.prototype = new Error;

CdifError.prototype.getDeviceErrorMessage = function(code) {
  var locale = options.locale;

  var ErrorInfo = null;
  try {
    ErrorInfo = require('./error-info.' + locale +'.json');
  } catch (e) {
    ErrorInfo = require('./error-info.zh-CN.json');
  }

  var message = ErrorInfo[code];
  if (message == null) message = 'unknown error';
  return message;
};

function DeviceError(...args) {
  this.topic   = 'device error';

  var errorCode     = args[0];
  this.message      = this.getDeviceErrorMessage(errorCode);
  if (args.length > 1) {
    this.message     += ': ';
    for (var index = 1; index < args.length; index++) {
      this.message += args[index];
      this.message += ' ';
    }
  }
}

DeviceError.prototype = new Error;

DeviceError.prototype.getDeviceErrorMessage = function(code) {
  var locale = options.locale;

  var ErrorInfo = null;
  try {
    ErrorInfo = require('./error-info.' + locale +'.json');
  } catch (e) {
    ErrorInfo = require('./error-info.zh-CN.json');
  }

  var message = ErrorInfo[code];
  if (message == null) message = 'unknown error';
  return message;
};

module.exports = {
  CdifError: CdifError,
  DeviceError: DeviceError,
};
