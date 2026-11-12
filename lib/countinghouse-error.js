const util      = require('util');
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

  // The extra arguments that say something, joined by spaces. With none
  // (all null, undefined, empty or blank), the catalogue's text alone: no
  // dangling ': ' (reviews of c9 and c10).
  const parts = args.slice(1).filter((a) => a != null).map(textOf).filter((t) => t.trim() !== '');
  if (parts.length > 0) message += `: ${parts.join(' ')}`;
  return message;
};

// One value as text, never throwing: an object as JSON, a function as
// '[function]' (never its source; inside an object too, where JSON would
// drop it or write null), anything else with String(). A value that cannot
// be rendered (circular, a BigInt inside, a throwing toJSON or Proxy trap,
// or JSON that is nothing) says so, and an object's own toString is never
// run: an error built from a module's message must never throw itself
// (reviews of c10, c11 and c12).
const UNRENDERABLE = '[unrenderable value]';
const FUNCTION_TEXT = '[function]';
function functionsAsText(key, value) {
  return (typeof(value) === 'function') ? FUNCTION_TEXT : value;
}
function textOf(value) {
  if (typeof(value) === 'function') return FUNCTION_TEXT;
  try {
    if (typeof(value) === 'object' && value !== null) {
      const json = JSON.stringify(value, functionsAsText);
      return (typeof(json) === 'string') ? json : UNRENDERABLE;
    }
    return String(value);
  } catch (renderErr) {
    return UNRENDERABLE;
  }
}

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
// A module's details are a plain object (its prototype Object.prototype or
// null): an array, a Map, a Date, a Buffer or a class instance is {}, so
// what a reply carries is what single-thread mode shows. Inspecting them
// never throws (a revoked Proxy is not details).
function isDetailsObject(details) {
  try {
    if (details == null || typeof(details) !== 'object' || Array.isArray(details)) return false;
    const proto = Object.getPrototypeOf(details);
    return proto === Object.prototype || proto === null;
  } catch (e) {
    return false;
  }
}

CountinghouseError.module = function(code, message, details) {
  // Code and message rendered with textOf, never thrown by: a function is
  // '[function]', never its source, and an object's own toString is never
  // run (review of c12). The code is text before anything uses it, so the
  // error's own code is a string too and crosses a thread reply (review of
  // c13). A blank message is none: no dangling ': '.
  const codeText = (code == null || typeof(code) === 'string') ? code : textOf(code);
  const e = new CountinghouseError(codeText);
  e.origin = 'module';
  const head = (codeText == null) ? '' : codeText;
  const text = (message == null) ? '' : textOf(message);
  e.message = (text.trim() !== '') ? (head === '' ? text : `${head}: ${text}`) : head;
  let own = {};
  let cause;
  if (isDetailsObject(details)) {
    // a Proxy's traps may throw: then the details are {}, never a throw
    try {
      if (Object.prototype.hasOwnProperty.call(details, 'cause')) {
        own = Object.assign({}, details);
        cause = own.cause;
        delete own.cause;
      } else {
        own = details;
      }
    } catch (inspectErr) {
      own = {};
      cause = undefined;
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
// Reading the thrown value never throws: one whose properties throw when
// read is a crash like any other untyped value (review of c9). Only the
// reads are guarded; building the module's error is not, so a runtime bug
// there reaches the caller (review of c10), and lib/service.js's fail()
// logs it and still answers the call, as a crash (review of c11).
CountinghouseError.fromModule = function(err) {
  let read;
  try {
    read = readModuleError(err);
  } catch (readErr) {
    return null;
  }
  if (read == null) return null;
  if (read.own) return err;
  const e = CountinghouseError.module(read.code, read.message);
  Object.defineProperty(e, 'cause', {value: err, enumerable: false, writable: true, configurable: true});
  return e;
};
// One property of an error the runtime is about to answer with, or
// UNREAD when reading it throws (a getter, a Proxy trap); never throws.
const UNREAD = Symbol('unread');
function readGuarded(obj, name) {
  try {
    return obj[name];
  } catch (readErr) {
    return UNREAD;
  }
}
// One text for a message that cannot be read, on the typed path and in a
// crash's fault alike (lib/service.js uses it too).
const UNREADABLE_MESSAGE = 'a thrown value whose properties cannot be read';
function codeOf(code) {
  return (code === UNREAD || code == null) ? null : (typeof(code) === 'string' ? code : textOf(code));
}
function messageOf(message, code) {
  if (message === UNREAD) return UNREADABLE_MESSAGE;
  if (message == null) return (code == null) ? '' : code;
  return (typeof(message) === 'string') ? message : textOf(message);
}

// The errors the runtime itself issued to module code (d2b; logger-design
// §5.1: every code a module raises is the module's): each mapped to the
// code and origin it was issued with, frozen. Written by issue() at every
// runtime site a module can see an error from (handler-ctx's ctx.call
// refusals) and when the runtime hands a composing module a hop's error
// (hopError), so a runtime code passed on through a module stays the
// runtime's. Per thread (each worker loads its own copy) and private: issue
// is this file's export, not a static on the class a module can reach
// (e.constructor). Under the module sandbox the class and its prototype
// are frozen too (lib/module-lockdown.js), so a module cannot replace the
// statics that read the brand.
const ISSUED = new WeakMap();
function issue(err) {
  if (err != null && typeof(err) === 'object' && !ISSUED.has(err)) {
    ISSUED.set(err, Object.freeze({code: codeOf(readGuarded(err, 'code')), origin: 'runtime'}));
  }
  return err;
}

// Copies the runtime decoded from a reply envelope (fromReplyFields): the
// runtime's own objects, so a hop hands them over as they are.
const DECODED = new WeakSet();

// The error a handler's failure is answered with (review of c14): the
// runtime's copy, never the module's object. A module owns the error it
// hands back and may set anything on it, then or later (e.code = () => 1, a
// message whose toString throws, a getter that throws); the module's object
// could then not cross a thread reply (DataCloneError) or be written as a
// JSON answer, and the call was never answered. The copy reads each field
// once: its code a string or null, its message a string, its origin, and
// the module's own details and cause objects, by reference, not copied
// (details are JSON-copied at every edge, cloneDetails, which never throws;
// cause is never sent). Its code and origin are the runtime's only for an
// error the runtime issued (ISSUED, which also wins over any change the
// module made since); any other is the module's, origin 'module', whatever
// its code or `.origin` says, so a catalogue code it spells carries no
// runtime kind, retry or status (d2b). Never throws.
CountinghouseError.answerable = function(err) {
  const issued = ISSUED.get(err);
  const code = (issued != null) ? issued.code : codeOf(readGuarded(err, 'code'));
  const message = messageOf(readGuarded(err, 'message'), code);
  const details = readGuarded(err, 'details');
  const cause = readGuarded(err, 'cause');
  const e = new CountinghouseError(code);
  e.message = message;
  if (issued != null) issue(e);
  else e.origin = 'module';
  if (details !== UNREAD && isDetailsObject(details)) Object.defineProperty(e, 'details', {value: details, enumerable: false, writable: true, configurable: true});
  if (cause !== UNREAD && cause !== undefined) Object.defineProperty(e, 'cause', {value: cause, enumerable: false, writable: true, configurable: true});
  return e;
};

// {own: true} for a CountinghouseError, {code, message} for a typed module
// Error, null for anything untyped. It may throw: its caller guards it.
function readModuleError(err) {
  if (err instanceof CountinghouseError) return {own: true};
  // The rule is for Errors: a thrown plain object with a code is a crash.
  if (err == null || typeof(err) !== 'object' || !(err instanceof Error || util.types.isNativeError(err))) return null;
  const code = err.code;
  if (typeof(code) !== 'string' || !MODULE_CODE.test(code) || CountinghouseError.isForeignCode(code)) return null;
  if (err.errno !== undefined || err.syscall !== undefined) return null;
  const message = err.message;
  return {code: code, message: typeof(message) === 'string' ? message : undefined};
}

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
// line names the code (never the details' content), and only a code that
// is a module code or the runtime's: one rendered from an object may carry
// anything the module packed into it (review of c14).
// It never throws: a Proxy whose traps throw is unserialisable too.
function codeNamed(code) {
  return (typeof(code) === 'string' && (MODULE_CODE.test(code) || RUNTIME_CODES.has(code))) ? code : 'a code that is not a module code';
}
function cloneDetails(details, code) {
  try {
    if (!isDetailsObject(details) || Object.keys(details).length === 0) return null;
    return JSON.parse(JSON.stringify(details));
  } catch (e) {
    // Required here, not at the top: lib/logger.js is not loaded in a bare
    // unit process, and the warn line must never throw itself.
    try { require('./logger').W(`error details unserialisable (${codeNamed(code)}): ${e.name}`); } catch (logErr) { /* the envelope still says so */ }
    return {_details: 'unserialisable'};
  }
}

// errMsg is never null for an error (a receiver reads a null errMsg as
// success): a message-less error, or a thrown non-Error, gives its text.
// Each field is read once and is text (a string code, a string message), so
// the reply always crosses: an error a handler answers with is already the
// runtime's copy (answerable), and this holds for any other too (review of
// c14). Never throws.
function errorText(err, message) {
  if (message === UNREAD) return UNREADABLE_MESSAGE;
  if (message != null) return (typeof(message) === 'string') ? message : textOf(message);
  try {
    return String(err);
  } catch (renderErr) {
    return UNRENDERABLE;
  }
}

// The success pair too: replyFields(null) is {errMsg: null, errCode: null},
// so every encoder site calls it unconditionally.
CountinghouseError.replyFields = function(err) {
  if (err == null) return {errMsg: null, errCode: null};
  const isObject = (typeof(err) === 'object' || typeof(err) === 'function');
  const code = isObject ? codeOf(readGuarded(err, 'code')) : null;
  const errMsg = errorText(err, isObject ? readGuarded(err, 'message') : undefined);
  if (isObject && readGuarded(err, 'origin') === 'module') {
    const details = readGuarded(err, 'details');
    return {errMsg: errMsg, errCode: code, errOrigin: 'module', errDetails: (details === UNREAD) ? {_details: 'unserialisable'} : cloneDetails(details, code)};
  }
  return {errMsg: errMsg, errCode: code};
};

// Posts one reply envelope with `post` (a port's or worker's postMessage).
// A body that cannot be cloned (a function or a Symbol inside a module's
// result or fault) is posted as a crash instead: the same head fields
// (id, category, command, msgID, metering), DEVICE_INVOKE_EXCEPTION and no
// data, so the call is still answered. Every reply encoder posts through it:
// a worker's reply to the main thread, the main thread's to a composing
// worker, and a direct peer channel's (review of c15 and the high review of
// #37: an uncloneable body threw, and the caller waited for its timeout).
const REPLY_NOT_SENT = 'the result could not be sent between threads';
CountinghouseError.postReply = function(post, envelope) {
  try {
    return post(envelope);
  } catch (cloneErr) {
    const crash = CountinghouseError.replyFields(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', REPLY_NOT_SENT));
    const fallback = Object.assign({}, envelope, crash, {data: null});
    delete fallback.errOrigin;
    delete fallback.errDetails;
    return post(fallback);
  }
};

// The error a reply carried. A module's comes back as the module's, message
// and details as the module gave them; any other as a plain Error with its
// code (locale-independent), which the receiving side re-wraps.
CountinghouseError.fromReplyFields = function(msg) {
  if (msg.errOrigin === 'module') {
    const e = CountinghouseError.module(msg.errCode);
    e.message = String(msg.errMsg);
    if (isDetailsObject(msg.errDetails)) e.details = msg.errDetails;
    DECODED.add(e);
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
// details, and its origin already says it is not the runtime's. It is a
// copy, exactly what a thread reply would carry (replyFields, then
// fromReplyFields), so a composing module sees the same rejection in every
// mode and never the callee's own object: not its cause, its stack or its
// live details (review of c8). Any other coded error is not the
// runtime's either: to the composing module's caller it is a callee failure
// (lib/service.js reports an untyped error as DEVICE_INVOKE_EXCEPTION,
// message in the fault), so a callee cannot pass a made-up code off as a
// runtime one.
// A copy the runtime decoded from a reply is handed over as it is (it is
// already the runtime's, details JSON-copied once; re-encoding it copied
// them twice). A runtime error it hands over is issued (ISSUED), so the
// composing module may pass it on as the runtime's (d2b).
function hopError(err) {
  if (err == null) return err;
  if (err instanceof CountinghouseError && err.origin === 'module') {
    if (DECODED.has(err)) return err;
    return CountinghouseError.fromReplyFields(CountinghouseError.replyFields(err));
  }
  if (typeof(err.code) === 'string' && RUNTIME_CODES.has(err.code)) {
    return issue((err instanceof CountinghouseError) ? err : new CountinghouseError(err.code));
  }
  if (err.code == null && !(err instanceof CountinghouseError)) return err;
  return new Error(err.message);
}

module.exports = {
  CountinghouseError: CountinghouseError,
  hopError: hopError,
  issue: issue,
  readGuarded: readGuarded,
  UNREAD: UNREAD,
  UNREADABLE_MESSAGE: UNREADABLE_MESSAGE,
  textOf: textOf
};
