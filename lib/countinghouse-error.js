const options   = require('./cli-options');

function getErrorMessage(args) {
  const locale = options.locale;

  if (args.length === 0) return 'unknown error';

  const code     = args[0];
  let ErrorInfo = null;
  try {
    ErrorInfo = require(`./error-info.${locale}.json`);
  } catch (e) {
    ErrorInfo = require('./error-info.zh-CN.json');
  }

  let message = ErrorInfo[code];
  if (message == null) {
    //in case we can't find predefined err message head, return
    //the original message
    return code;
  }

  if (args.length > 1) {
    message += ': ';

    for (let index = 1; index < args.length; index++) {
      if (args[index] == null) continue;

      if (typeof(args[index]) === 'object') {
        message += JSON.stringify(args[index]);
      } else {
        message += args[index];
      }
      if (index < args.length - 1) message += ' ';
    }
  }
  return message;
};

function CHError() {
  this.topic   = 'countinghouse error';
  // the locale-formatted message is for humans; `code` is the raw
  // error-info.json key (locale-independent) so callers -- tests included --
  // can identify the error without depending on which locale is active.
  this.code    = arguments.length > 0 ? arguments[0] : null;
  this.message = getErrorMessage(arguments);
}

CHError.prototype = new Error;

function DeviceError() {
  this.topic   = 'device error';
  this.code    = arguments.length > 0 ? arguments[0] : null;
  this.message = getErrorMessage(arguments);
}

DeviceError.prototype = new Error;

module.exports = {
  CHError: CHError,
  DeviceError: DeviceError
};
