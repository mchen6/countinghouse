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

// The codes the runtime itself defines (the catalogue's keys; every locale
// has the same ones).
const RUNTIME_CODES = new Set(Object.keys(require('./error-info.en-US.json')));

// An error coming back over a composition hop (lib/service-client.js), on
// either path -- a direct peer channel or the main thread. A code the
// runtime defines reaches the composing module typed, so it keeps its code
// up to that module's caller (MODULE_RELOADING, PEER_GONE, a callee's
// DEVICE_INVOKE_FAIL). Any other code is the callee's own invention: to the
// composing module's caller it is a callee failure (lib/service.js reports
// an untyped error as DEVICE_INVOKE_EXCEPTION, message in the fault), so a
// callee cannot pass a made-up code off as a runtime one.
function hopError(err) {
  if (err == null) return err;
  if (typeof(err.code) === 'string' && RUNTIME_CODES.has(err.code)) {
    return (err instanceof DeviceError || err instanceof CHError) ? err : new DeviceError(err.code);
  }
  if (err.code == null && !(err instanceof DeviceError) && !(err instanceof CHError)) return err;
  return new Error(err.message);
}

module.exports = {
  CHError: CHError,
  DeviceError: DeviceError,
  hopError: hopError
};
