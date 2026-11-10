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

// The old names, kept only behind the module-facing globals (lib/sandbox.js,
// framework.js) until step 1 (d) of the logger-and-errors spec retires them
// for ctx.error. They make CountinghouseErrors, so lib/service.js still
// recognises a module's typed error; `new` on either returns that object.
// Nothing else in lib/ uses them (test/validation/04).
function CHError(...all) {
  const e = new CountinghouseError(...all);
  Error.captureStackTrace(e, CHError);
  return e;
}

function DeviceError(...all) {
  const e = CountinghouseError.device(...all);
  Error.captureStackTrace(e, DeviceError);
  return e;
}

// The codes the runtime itself defines (the catalogue's keys).
const RUNTIME_CODES = new Set(Object.keys(CODES));

// The one error class of the logger-and-errors spec (docs/superpowers/specs/
// 2026-11-09-logger-design.md §5.1). It replaced CHError and DeviceError
// (step 1 (c), a codemod) without changing an answer: the constructor
// takes the same (code, ...args), decides by how many arguments it was
// given as they did (an explicit undefined code stays undefined, message
// and all), renders at construction as they did, and an instance has the
// same enumerable own properties, in the
// same order (topic, code, message), so anything that serialises one (JSON,
// a worker message) sees the same thing. What is new is not enumerable: a
// real stack, `name` and the catalogue's kind, retryable, httpStatus and
// mcpCode on the prototype (a code the catalogue does not know is a
// module's: kind module), and origin, details and cause.
function CountinghouseError(...all) {
  if (!(this instanceof CountinghouseError)) return new CountinghouseError(...all);
  this.topic   = 'countinghouse error';
  // the locale-formatted message is for humans; `code` is the catalogue key
  // (locale-independent) so callers -- tests included -- can identify the
  // error without depending on which locale is active.
  this.code    = all.length > 0 ? all[0] : null;
  this.message = getErrorMessage(all);
  // Not enumerable, so JSON and a worker message see exactly what they saw
  // of the old classes.
  Object.defineProperty(this, 'origin', {value: 'runtime', enumerable: false, writable: true, configurable: true});
  Error.captureStackTrace(this, CountinghouseError);
}

// An ordinary object with Error.prototype in its chain, as the old classes were, not an
// instance of a class that extends Error: V8 clones a real Error across a
// worker boundary as {name, message, stack} and drops `topic` and `code`,
// where an ordinary object crosses whole. `instanceof Error` still holds,
// and the stack is real (Error.captureStackTrace).
CountinghouseError.prototype = Object.create(Error.prototype, {
  constructor: {value: CountinghouseError, enumerable: false, writable: true, configurable: true},
  name: {value: 'CountinghouseError', enumerable: false, writable: true, configurable: true},
  kind: {get() { const e = entryOf(this); return e != null ? e.kind : 'module'; }, enumerable: false, configurable: true},
  retryable: {get() { const e = entryOf(this); return e != null ? e.retryable : false; }, enumerable: false, configurable: true},
  httpStatus: {get() { const e = entryOf(this); return e != null ? e.httpStatus : 500; }, enumerable: false, configurable: true},
  mcpCode: {get() { const e = entryOf(this); return e != null ? e.mcpCode : null; }, enumerable: false, configurable: true}
});

// The old names share the class's prototype, so a check written against
// them (`x instanceof DeviceError || x instanceof CHError`) holds for every
// CountinghouseError, the same as `x instanceof CountinghouseError`.
CHError.prototype = CountinghouseError.prototype;
DeviceError.prototype = CountinghouseError.prototype;

// The catalogue entry an error's fields come from: none for a module's
// error, whose code is its own even when it equals a catalogue name (§5.1).
function entryOf(err) {
  if (err.origin === 'module') return null;
  const code = err.code;
  return (typeof(code) === 'string' && Object.prototype.hasOwnProperty.call(CODES, code)) ? CODES[code] : null;
}

// The old DeviceError's topic, which some answers carry (pinned by
// test/mcp-contract/07): every `new DeviceError(` became this.
CountinghouseError.device = function(...all) {
  const e = new CountinghouseError(...all);
  e.topic = 'device error';
  Error.captureStackTrace(e, CountinghouseError.device);
  return e;
};

// A module's own error: what ctx.error(code, message?, details?) returns
// (logger-design §5.1). origin 'module', so the catalogue says nothing about
// it (kind module, 500, mcpCode null), even for a code that equals a
// catalogue name. It renders "CODE: message" (the bare code with no message):
// a module code has no catalogue text, and rendering it the old way would
// drop the module's message. The old DeviceError's topic, which a module's
// typed error has always answered with. It never throws.
CountinghouseError.module = function(code, message, details) {
  const e = CountinghouseError.device(code);
  e.origin = 'module';
  const head = (code == null) ? '' : String(code);
  e.message = (message != null && message !== '') ? (head === '' ? String(message) : `${head}: ${message}`) : head;
  Object.defineProperty(e, 'details', {value: (details != null && typeof(details) === 'object') ? details : {},
    enumerable: false, writable: true, configurable: true});
  Error.captureStackTrace(e, CountinghouseError.module);
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
    return (err instanceof CountinghouseError) ? err : CountinghouseError.device(err.code);
  }
  if (err.code == null && !(err instanceof CountinghouseError)) return err;
  return new Error(err.message);
}

module.exports = {
  CountinghouseError: CountinghouseError,
  CHError: CHError,
  DeviceError: DeviceError,
  hopError: hopError
};
