var options   = require('./cli-options');

function getErrorMessage(args) {
  var locale = options.locale;

  if (args.length === 0) return 'unknown error';

  var code     = args[0];
  var ErrorInfo = null;
  try {
    ErrorInfo = require('./error-info.' + locale +'.json');
  } catch (e) {
    ErrorInfo = require('./error-info.zh-CN.json');
  }

  var message = ErrorInfo[code];
  if (message == null) {
    //in case we can't find predefined err message head, return
    //the original message
    return code;
  }

  if (args.length > 1) {
    message += ': ';

    for (var index = 1; index < args.length; index++) {
      if (args[index] == null) continue;

      if (typeof(args[index]) === 'object' || typeof(args[index]) === 'array') {
        message += JSON.stringify(args[index]);
      } else {
        message += args[index];
      }
      if (index < args.length - 1) message += ' ';
    }
  }
  return message;
};

function CdifError() {
  this.topic   = 'cdif error';
  this.message = getErrorMessage(arguments);
}

CdifError.prototype = new Error;

function DeviceError() {
  this.topic   = 'device error';
  this.message = getErrorMessage(arguments);
}

DeviceError.prototype = new Error;

module.exports = {
  CdifError: CdifError,
  DeviceError: DeviceError
};
