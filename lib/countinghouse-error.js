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

// The codes the runtime itself defines (the catalogue's keys).
const RUNTIME_CODES = new Set(Object.keys(CODES));

// The one error class of the logger-and-errors spec (docs/superpowers/specs/
// 2026-11-09-logger-design.md §5.1). It replaced CHError and DeviceError
// (step 1 (c), a codemod); step 1 (d2) retired them, their module-facing
// globals (modules use ctx.error) and the `topic` field. The constructor takes
// (code, ...args), decides by how many arguments it was given (an explicit
// undefined code stays undefined, message and all), and renders at
// construction. An instance's enumerable own properties are code and
// message, in that order, so anything that serialises one (JSON, a worker
// message) sees exactly those. What is not enumerable: a real stack, `name`
// and the catalogue's kind, retryable, httpStatus and mcpCode on the
// prototype (a code the catalogue does not know is a module's: kind
// module), and origin, details and cause.
function CountinghouseError(...all) {
  if (!(this instanceof CountinghouseError)) return new CountinghouseError(...all);
  // the locale-formatted message is for humans; `code` is the catalogue key
  // (locale-independent) so callers -- tests included -- can identify the
  // error without depending on which locale is active.
  this.code    = all.length > 0 ? all[0] : null;
  this.message = getErrorMessage(all);
  // Not enumerable, so JSON and a worker message see only code and message.
  Object.defineProperty(this, 'origin', {value: 'runtime', enumerable: false, writable: true, configurable: true});
  Error.captureStackTrace(this, CountinghouseError);
}

// An ordinary object with Error.prototype in its chain, as the old classes were, not an
// instance of a class that extends Error: V8 clones a real Error across a
// worker boundary as {name, message, stack} and drops `code`,
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

// The catalogue entry an error's fields come from: none for a module's
// error, whose code is its own even when it equals a catalogue name (§5.1).
function entryOf(err) {
  if (err.origin === 'module') return null;
  const code = err.code;
  return (typeof(code) === 'string' && Object.prototype.hasOwnProperty.call(CODES, code)) ? CODES[code] : null;
}

// A module's own error: what ctx.error(code, message?, details?) returns
// (logger-design §5.1). origin 'module', so the catalogue says nothing about
// it (kind module, 500, mcpCode null), even for a code that equals a
// catalogue name. It renders "CODE: message" (the bare code with no message):
// a module code has no catalogue text, and rendering it the old way would
// drop the module's message. `details.cause` is reserved for the
// underlying error: it becomes the non-enumerable `cause`, and is kept off
// `details` and so off every serialised form (JSON, the worker reply). It
// never throws.
// A module's details are a plain non-array object; anything else is {}.
function isDetailsObject(details) {
  return details != null && typeof(details) === 'object' && !Array.isArray(details);
}

CountinghouseError.module = function(code, message, details) {
  const e = new CountinghouseError(code);
  e.origin = 'module';
  const head = (code == null) ? '' : String(code);
  e.message = (message != null && message !== '') ? (head === '' ? String(message) : `${head}: ${message}`) : head;
  let own = {};
  let cause;
  if (isDetailsObject(details)) {
    if (Object.prototype.hasOwnProperty.call(details, 'cause')) {
      own = Object.assign({}, details);
      cause = own.cause;
      delete own.cause;
    } else {
      own = details;
    }
  }
  Object.defineProperty(e, 'details', {value: own, enumerable: false, writable: true, configurable: true});
  if (cause !== undefined) Object.defineProperty(e, 'cause', {value: cause, enumerable: false, writable: true, configurable: true});
  Error.captureStackTrace(e, CountinghouseError.module);
  return e;
};

// Someone else's code, never a module's (§5.1, as amended 2026-11-10): Node's
// own (ERR_..., MODULE_NOT_FOUND, ABORT_ERR, and llhttp's HPE_... from a
// malformed HTTP response), every errno name (a network failure such as
// Node's 'socket hang up' has ECONNRESET with no errno), undici's
// (UND_ERR_..., fetch), and the X509 verify codes Node puts on a TLS error.
// One list: fromModule reads it, and so will countinghouse-validate's
// warning about a module code that collides with it (step 1 (e)).
//
// The X509 codes are an exact list, not prefixes, so a module's own
// UNABLE_TO_PARSE or CERT_NOT_FOUND stays its own. Taken from Node v24.22.2:
// the 27 OpenSSL names in lib/_tls_wrap.js's 'secureConnection' comment,
// which src/crypto/crypto_common.cc's X509ErrorCode maps, plus that
// function's HOSTNAME_MISMATCH. Re-check them when the Node floor moves
// (test/validation/05 pins the list).
const FOREIGN_CODE = /^(ERR_|UND_ERR_|HPE_)|^(MODULE_NOT_FOUND|ABORT_ERR)$/;
const ERRNO_NAMES  = new Set(Object.keys(require('os').constants.errno));
const X509_VERIFY_CODES = Object.freeze([
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_CRL', 'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECRYPT_CRL_SIGNATURE', 'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY', 'CERT_SIGNATURE_FAILURE',
  'CRL_SIGNATURE_FAILURE', 'CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED', 'CRL_NOT_YET_VALID', 'CRL_HAS_EXPIRED',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD', 'ERROR_IN_CERT_NOT_AFTER_FIELD', 'ERROR_IN_CRL_LAST_UPDATE_FIELD',
  'ERROR_IN_CRL_NEXT_UPDATE_FIELD', 'OUT_OF_MEM', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_CHAIN_TOO_LONG', 'CERT_REVOKED',
  'INVALID_CA', 'PATH_LENGTH_EXCEEDED', 'INVALID_PURPOSE', 'CERT_UNTRUSTED', 'CERT_REJECTED',
  'HOSTNAME_MISMATCH'
]);
const X509_SET = new Set(X509_VERIFY_CODES);
CountinghouseError.X509_VERIFY_CODES = X509_VERIFY_CODES;
CountinghouseError.isForeignCode = function(code) {
  return typeof(code) === 'string' && (FOREIGN_CODE.test(code) || ERRNO_NAMES.has(code) || X509_SET.has(code));
};

// §5.1's plain-Error rule: what a module's handler reported, as the error
// the caller gets, or null for an untyped failure (lib/service.js answers
// it with DEVICE_INVOKE_FAIL or DEVICE_INVOKE_EXCEPTION). A
// CountinghouseError passes through unchanged: the module's own (ctx.error)
// or a runtime error it rethrew (from ctx.call, say), which keeps its
// origin. A plain Error's `.code` is the module's own code when it looks
// like one (MODULE_CODE) and is not someone else's: a system error's (it
// has errno or syscall) or a foreign code (isForeignCode). Only an Error
// counts: a thrown non-Error (null, a plain object with a code) is a crash.
// The original is the cause. A dependency's own coded Error (SQLITE_BUSY,
// ER_DUP_ENTRY) that a handler lets escape counts as the module's: the
// design's known cost (§5.1); a module wraps its dependencies' errors with
// ctx.error.
const MODULE_CODE = /^[A-Z][A-Z0-9_]{2,}$/;
CountinghouseError.fromModule = function(err) {
  if (err instanceof CountinghouseError) return err;
  // The rule is for Errors: a thrown plain object with a code is a crash.
  if (err == null || typeof(err) !== 'object' || !(err instanceof Error || require('util').types.isNativeError(err))) return null;
  const code = err.code;
  if (typeof(code) !== 'string' || !MODULE_CODE.test(code) || CountinghouseError.isForeignCode(code)) return null;
  if (err.errno !== undefined || err.syscall !== undefined) return null;
  const e = CountinghouseError.module(code, typeof(err.message) === 'string' ? err.message : undefined);
  Object.defineProperty(e, 'cause', {value: err, enumerable: false, writable: true, configurable: true});
  return e;
};

// An error a worker's reply carried back to the main thread
// (lib/worker-message.js rebuilds it): a module's error as it came (the
// reply carries it whole: code, message, details), else rebuilt from its
// code alone, or from its text when it had none, as before step 1 (d2). A
// runtime error's own text (an ended worker's reason, say) stays on this
// side of the answer.
CountinghouseError.fromReply = function(err) {
  if (err instanceof CountinghouseError && err.origin === 'module') return err;
  return new CountinghouseError(err.code != null ? err.code : err.message);
};

// A reply envelope's error fields, for every reply that crosses between
// threads: a worker's reply to the main thread (lib/worker-message.js), the
// main thread's reply to a composing worker (lib/device-manager.js), and a
// direct peer channel's (lib/peer-channel.js). They ride as siblings of
// `data`, never inside it. A module's error crosses whole: its code and
// rendered message as for any error, plus errOrigin and its details
// (errDetails, a JSON copy: details are bound for JSON at every edge).
// fromReplyFields is the other end, so a composing module sees the same
// rejection in every mode.
// Details that don't survive JSON (a BigInt, a cycle) are not dropped
// silently: the envelope says so ({_details: 'unserialisable'}) and a warn
// line names the code (never the details' content).
function cloneDetails(details, code) {
  if (!isDetailsObject(details) || Object.keys(details).length === 0) return null;
  try {
    return JSON.parse(JSON.stringify(details));
  } catch (e) {
    // the warn line must never throw itself (no logger in a bare unit process)
    try { require('./logger').W(`error details unserialisable across a thread reply (${code}): ${e.name}`); } catch (logErr) { /* the envelope still says so */ }
    return {_details: 'unserialisable'};
  }
}

// errMsg is never null for an error (a receiver reads a null errMsg as
// success): a message-less error, or a thrown non-Error, gives its text.
function errorText(err) {
  if (err != null && typeof(err) === 'object' && err.message != null) return String(err.message);
  return String(err);
}

// The success pair too: replyFields(null) is {errMsg: null, errCode: null},
// so every encoder site calls it unconditionally.
CountinghouseError.replyFields = function(err) {
  if (err == null) return {errMsg: null, errCode: null};
  const code = (typeof(err) === 'object' && err.code != null) ? err.code : null;
  if (err.origin === 'module') {
    return {errMsg: errorText(err), errCode: code, errOrigin: 'module', errDetails: cloneDetails(err.details, code)};
  }
  return {errMsg: errorText(err), errCode: code};
};

// The error a reply carried. A module's comes back as the module's, message
// and details as the module gave them; any other as a plain Error with its
// code (locale-independent), which the receiving side re-wraps.
CountinghouseError.fromReplyFields = function(msg) {
  if (msg.errOrigin === 'module') {
    const e = CountinghouseError.module(msg.errCode);
    e.message = String(msg.errMsg);
    if (isDetailsObject(msg.errDetails)) e.details = msg.errDetails;
    return e;
  }
  const replyErr = new Error(msg.errMsg);
  if (msg.errCode != null) replyErr.code = msg.errCode;
  return replyErr;
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
// DEVICE_INVOKE_FAIL). A callee module's own error (origin module) passes
// through whole, whatever its code (review of #37): code, message and
// details, as the composing module would see it in-process, and its origin
// already says it is not the runtime's. Any other coded error is not the
// runtime's either: to the composing module's caller it is a callee failure
// (lib/service.js reports an untyped error as DEVICE_INVOKE_EXCEPTION,
// message in the fault), so a callee cannot pass a made-up code off as a
// runtime one.
function hopError(err) {
  if (err == null) return err;
  if (err instanceof CountinghouseError && err.origin === 'module') return err;
  if (typeof(err.code) === 'string' && RUNTIME_CODES.has(err.code)) {
    return (err instanceof CountinghouseError) ? err : new CountinghouseError(err.code);
  }
  if (err.code == null && !(err instanceof CountinghouseError)) return err;
  return new Error(err.message);
}

module.exports = {
  CountinghouseError: CountinghouseError,
  hopError: hopError
};
