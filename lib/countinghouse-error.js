const options   = require('./cli-options');
const {CODES}   = require('./error-catalogue');

// The catalogue's language for a locale: en-US is the default and the
// fallback (logger-design §5.3; before 8.0 a missing locale fell back to zh-CN).
const LANGUAGE = {'en-US': 'en', 'zh-CN': 'zh'};

function getErrorMessage(args) {
  if (args.length === 0) return 'unknown error';

  const code  = args[0];
  const entry = Object.prototype.hasOwnProperty.call(CODES, code) ? CODES[code] : null;
  if (entry == null) {
    //in case we can't find predefined err message head, return
    //the original message
    return code;
  }
  let message = entry[LANGUAGE[options.locale] || 'en'];

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

// The codes the runtime itself defines (the catalogue's keys).
const RUNTIME_CODES = new Set(Object.keys(CODES));

// The one error class of the logger-and-errors spec (docs/superpowers/specs/
// 2026-11-09-logger-design.md §5.1). Step 1 keeps CHError and DeviceError
// beside it so a codemod can move every site over unchanged: the
// constructor takes the same (code, ...args) and renders at construction as
// they do, and an instance has the same enumerable own properties, in the
// same order (topic, code, message), so anything that serialises one (JSON,
// a worker message) sees the same thing. What is new is not enumerable: a
// real stack, `name` and the catalogue's kind, retryable, httpStatus and
// mcpCode on the prototype (a code the catalogue does not know is a
// module's: kind module), and origin, details and cause.
function CountinghouseError(code, ...args) {
  if (!(this instanceof CountinghouseError)) return new CountinghouseError(code, ...args);
  this.topic   = 'countinghouse error';
  this.code    = (code !== undefined) ? code : null;
  this.message = getErrorMessage(code === undefined ? [] : [code, ...args]);
  // Not enumerable, so JSON and a worker message see exactly what they see
  // of a CHError today.
  Object.defineProperty(this, 'origin', {value: 'runtime', enumerable: false, writable: true, configurable: true});
  Error.captureStackTrace(this, CountinghouseError);
}

// An ordinary object with Error.prototype in its chain, like CHError, not an
// instance of a class that extends Error: V8 clones a real Error across a
// worker boundary as {name, message, stack} and drops `topic` and `code`,
// where an ordinary object crosses whole. `instanceof Error` still holds,
// and the stack is real (Error.captureStackTrace).
CountinghouseError.prototype = Object.create(Error.prototype, {
  constructor: {value: CountinghouseError, enumerable: false, writable: true, configurable: true},
  name: {value: 'CountinghouseError', enumerable: false, writable: true, configurable: true},
  kind: {get() { const e = entryOf(this.code); return e != null ? e.kind : 'module'; }, enumerable: false, configurable: true},
  retryable: {get() { const e = entryOf(this.code); return e != null ? e.retryable : false; }, enumerable: false, configurable: true},
  httpStatus: {get() { const e = entryOf(this.code); return e != null ? e.httpStatus : 500; }, enumerable: false, configurable: true},
  mcpCode: {get() { const e = entryOf(this.code); return e != null ? e.mcpCode : null; }, enumerable: false, configurable: true}
});

function entryOf(code) {
  return (typeof(code) === 'string' && Object.prototype.hasOwnProperty.call(CODES, code)) ? CODES[code] : null;
}

// A DeviceError's topic, for the codemod (logger-design §9, step 1).
CountinghouseError.device = function(code, ...args) {
  const e = new CountinghouseError(code, ...args);
  e.topic = 'device error';
  Error.captureStackTrace(e, CountinghouseError.device);
  return e;
};

// The structured form: a free-text message (else the catalogue's text),
// details and a cause.
CountinghouseError.create = function(code, opts) {
  const o = opts || {};
  const e = new CountinghouseError(code);
  if (o.message != null) e.message = String(o.message);
  Object.defineProperty(e, 'details', {value: o.details != null ? o.details : {}, enumerable: false, writable: true, configurable: true});
  if (o.cause !== undefined) Object.defineProperty(e, 'cause', {value: o.cause, enumerable: false, writable: true, configurable: true});
  Error.captureStackTrace(e, CountinghouseError.create);
  return e;
};

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
  CountinghouseError: CountinghouseError,
  CHError: CHError,
  DeviceError: DeviceError,
  hopError: hopError
};
