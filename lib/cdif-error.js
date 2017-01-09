var options   = require('./cli-options');

function getErrorMessage(args) {
  var locale = options.locale;

  var code     = args[0];
  var ErrorInfo = null;
  try {
    ErrorInfo = require('./error-info.' + locale +'.json');
  } catch (e) {
    ErrorInfo = require('./error-info.zh-CN.json');
  }

  var message = ErrorInfo[code];
  if (message == null) message = 'unknown error';

  if (args.length > 1) {
    message     += ': ';
    for (var index = 1; index < args.length; index++) {
      message += args[index];
      if (index < args.length - 1) message += ' ';
    }
  }
  return message;
};

function CdifError(...args) {
  this.topic   = 'cdif error';
  this.message = getErrorMessage(args);
}

CdifError.prototype = new Error;

function DeviceError(...args) {
  this.topic   = 'device error';
  this.message = getErrorMessage(args);
}

DeviceError.prototype = new Error;

module.exports = {
  CdifError: CdifError,
  DeviceError: DeviceError
};
