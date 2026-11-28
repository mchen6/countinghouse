'use strict';
// the logger, through lazy-require's holder (warmed at a worker's boot, #194's
// PR 1): this file loads before almost everything, the logger included
const {moduleText} = require('./module-text');
const runtimeLog = require('./lazy-require').lazy('./logger');
const util      = require('util');
const {CODES}   = require('./error-catalogue');

// fields (optional): named values for the catalogue text's {placeholders}
// (CountinghouseError.withFields).
function getErrorMessage(args, fields) {
  if (args.length === 0) return 'unknown error';

  const code  = args[0];
  const entry = Object.prototype.hasOwnProperty.call(CODES, code) ? CODES[code] : null;
  if (entry == null) {
    //in case we can't find predefined err message head, return
    //the original message
    return code;
  }
  let message = entry.en;
  if (fields != null) {
    message = message.replace(/\{(\w+)\}/g, (whole, key) => (Object.prototype.hasOwnProperty.call(fields, key) ? textOf(fields[key]) : whole));
  }

  // The extra arguments that say something, joined by spaces. With none
  // (all null, undefined, empty or blank), the catalogue's text alone: no
  // dangling ': ' (reviews of c9 and c10).
  const parts = args.slice(1).filter((a) => a != null).map(textOf).filter((t) => t.trim() !== '');
  if (parts.length > 0) message += `: ${parts.join(' ')}`;
  return message;
};

// What issue() and the text it keeps read, taken when this file loads: a
// module shares a worker's realm and could replace these to change what the
// runtime records as issued.
const ReflectApply = Reflect.apply;
const JSONStringify = JSON.stringify;
const StringCtor = String;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectHasOwn = Object.hasOwn;

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
      const json = ReflectApply(JSONStringify, JSON, [value, functionsAsText]);
      return (typeof(json) === 'string') ? json : UNRENDERABLE;
    }
    return StringCtor(value);
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
// prototype (a code the catalogue does not know: kind module on a module's
// error, origin module; kind runtime on the runtime's, #482's high, 4), and
// origin, details and cause.
// (what the constructor calls, taken when this file loads: it builds the
// runtime's own errors after module code has run, and a module that
// replaced Object.defineProperty would otherwise choose their code)
const CtorDefineProperty = Object.defineProperty;
const CtorCaptureStackTrace = Error.captureStackTrace;
const ReflectConstructAtLoad = Reflect.construct;
const ReflectApplyAtLoad = Reflect.apply;
function CountinghouseError(...all) {
  if (!(this instanceof CountinghouseError)) return ReflectConstructAtLoad(CountinghouseError, all);
  // the message is for humans; `code` is the catalogue key, so callers --
  // tests included -- can identify the error without reading its text.
  // Own data properties, defined, not assigned: an accessor someone added
  // to a prototype (Error.prototype, Object.prototype) must not decide them
  // (review of #45: a module's `code` accessor captured the assignment and
  // so the code the runtime issued).
  CtorDefineProperty(this, 'code', {__proto__: null, value: all.length > 0 ? all[0] : null, enumerable: true, writable: true, configurable: true});
  CtorDefineProperty(this, 'message', {__proto__: null, value: getErrorMessage(all), enumerable: true, writable: true, configurable: true});
  // Not enumerable, so JSON and a worker message see only code and message.
  CtorDefineProperty(this, 'origin', {__proto__: null, value: 'runtime', enumerable: false, writable: true, configurable: true});
  ReflectApplyAtLoad(CtorCaptureStackTrace, Error, [this, CountinghouseError]);
}

// A runtime error whose catalogue text has {placeholders}: (code, fields,
// ...args), the fields filled in. `fields` is kept
// non-enumerable, so a serialised form still carries code and message only.
CountinghouseError.withFields = function(code, fields, ...args) {
  const e = new CountinghouseError(code, ...args);
  Object.defineProperty(e, 'fields', {value: Object.assign({}, fields), enumerable: false, writable: true, configurable: true});
  e.message = getErrorMessage([code, ...args], e.fields);
  return e;
};

// An ordinary object with Error.prototype in its chain, as the old classes were, not an
// instance of a class that extends Error: V8 clones a real Error across a
// worker boundary as {name, message, stack} and drops `code`,
// where an ordinary object crosses whole. `instanceof Error` still holds,
// and the stack is real (Error.captureStackTrace).
CountinghouseError.prototype = Object.create(Error.prototype, {
  constructor: {value: CountinghouseError, enumerable: false, writable: true, configurable: true},
  name: {value: 'CountinghouseError', enumerable: false, writable: true, configurable: true},
  // a module's own error is the module's fault unless its module said it is
  // the caller's (ctx.error's fourth argument, {kind: 'caller'}); never the
  // runtime's or the operator's
  kind: {get() { const e = entryOf(this); return e != null ? (fromHandler(this) ? 'module' : e.kind) : (CallerHas(CALLER_KIND, this) ? 'caller' : (this.origin === 'module' ? 'module' : 'runtime')); }, enumerable: false, configurable: true},
  // (one that left a handler is the module's answer, whatever its row says:
  // kind module, 500, not retryable; the medium on #482's round 2, 7)
  retryable: {get() { const e = entryOf(this); return e != null && !fromHandler(this) ? e.retryable : false; }, enumerable: false, configurable: true},
  // (a module's error its module said is the caller's: 400, the request was
  // wrong; any other module error 500: post-rel caller 400)
  httpStatus: {get() { const e = entryOf(this); return e != null ? (fromHandler(this) ? 500 : e.httpStatus) : (CallerHas(CALLER_KIND, this) ? 400 : 500); }, enumerable: false, configurable: true},
  mcpCode: {get() { const e = entryOf(this); return e != null ? e.mcpCode : null; }, enumerable: false, configurable: true}
});

// The catalogue entry an error's fields come from: none for a module's
// error, whose code is its own (§5.1; one that equals a catalogue name never
// reaches an answer: reservedOr makes it MODULE_CODE_RESERVED).
function entryOf(err) {
  if (err.origin === 'module') return null;
  const code = err.code;
  return (typeof(code) === 'string' && Object.prototype.hasOwnProperty.call(CODES, code)) ? CODES[code] : null;
}

// A module's own error: what ctx.error(code, message?, details?) returns
// (logger-design §5.1). origin 'module', so the catalogue says nothing about
// it (kind module, 500, mcpCode null). One with a catalogue code is still
// returned (moduleOwn warns of it, naming the module); where the handler's
// answer leaves the module, the boundary (answerable, fromModule,
// fromReplyFields: reservedOr) answers it MODULE_CODE_RESERVED, logged once
// per module and code. It renders "CODE: message" (the bare code with no message):
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
  // (by the function taken at load: module code that replaced the global's
  // is never handed the runtime's error, #493's high)
  ReflectApplyAtLoad(CtorCaptureStackTrace, Error, [e, CountinghouseError.module]);
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
// module: the module the handler answering is (handler-answer), named in a
// conversion's warning
CountinghouseError.fromModule = function(err, {module = null} = {}) {
  let read;
  try {
    read = readModuleError(err);
  } catch (readErr) {
    return null;
  }
  if (read == null) return null;
  // (a CountinghouseError of the module's own is converted on the runtime's
  // copy, answerable: never on the module's object, whose origin and code
  // it may still change: the medium on the ctx.error PR, 1)
  if (read.own) return err;
  const e = CountinghouseError.module(read.code, read.message);
  Object.defineProperty(e, 'cause', {value: err, enumerable: false, writable: true, configurable: true});
  return reservedOr(e, {module});
};

// A module defines only its own codes (the logger spec, section 12, 1; the
// back-sweep, 11-18). ctx.error with one of this catalogue is warned of at
// the call, naming the module (moduleOwn), and where a module's error enters
// the runtime (answerable's copy, fromModule, fromReplyFields) one that
// carries a catalogue code, however it got it, becomes the runtime's
// MODULE_CODE_RESERVED, so the wire never shows a catalogue code as a
// module's, on MCP or HTTP. The settings gate's claim codes too: a real
// claim is the runtime's (ctx.settingRequired issues it).
// The module each error ctx.error made belongs to (handler-ctx passes its
// device's), so a conversion can name it; and the ones whose catalogue code
// ctx.error already warned of (the Reviewer's high review of #445, 5 and 9).
// The module errors whose module said the caller is at fault (ctx.error's
// fourth argument, {kind: 'caller'}): their kind is 'caller', carried on
// every copy the runtime makes and across a reply (errKind), and recorded
// in usage as CALLER_ERROR, the caller's (the Reviewer, after #445).
const CALLER_KIND = new WeakSet();
// A runtime-issued error that left a module handler (answerable, the copy
// handler-answer makes of what a handler rejects, throws or calls back with,
// in either mode): the module's answer, not the end caller's, so it reads
// kind module and status 500, whatever its code's row says. The end caller's
// own refusals of their call (their key, their budget, a name they can't
// use) are raised before its handler runs and never cross that boundary;
// what a composer gets from ctx.call or ctx.serviceClient and passes on
// does, whatever it was (#482's high, round 2, 1 and 2: true by
// construction at the one boundary every case crosses). That includes a
// single-thread hop refused by the per-key limiter of the key it bills,
// which can be the end caller's own: passed on by the composer, it is the
// composer's answer, 500 with no retry hint (the reviewer's rule; the
// medium on round 2, 4). Except the codes a handler passes through as the end caller's:
// the settings gate's claims, SETTING_REQUIRED and SETTING_NOT_READY (and a
// module's own ctx.error caller kind, which is no runtime-issued error).
// Carried on every copy the runtime makes and across a reply
// (errFromHandler), and in a task's failure record.
const FROM_HANDLER = new WeakSet();
const FhHas = Function.prototype.call.bind(WeakSet.prototype.has);
const FhAdd = Function.prototype.call.bind(WeakSet.prototype.add);
const HANDLER_PASS_THROUGH = new Set(['SETTING_REQUIRED', 'SETTING_NOT_READY']);
const fromHandler = (err) => err != null && typeof(err) === 'object' && FhHas(FROM_HANDLER, err);
const markFromHandler = (err) => { if (err != null && typeof(err) === 'object') FhAdd(FROM_HANDLER, err); return err; };
// The runtime's own worker-side reasons for a crash (WORKER_REASONS), raised
// as CountinghouseError.runtimeReason: the mark crosses a reply
// (errRuntimeReason), and only a marked error keeps its words on the main
// thread (fromReply). A handler's untyped throw of the same words is built
// unmarked (lib/handler-answer.js), so it never reads as the runtime's.
const RUNTIME_REASON = new WeakSet();
const RrHas = Function.prototype.call.bind(WeakSet.prototype.has);
const RrAdd = Function.prototype.call.bind(WeakSet.prototype.add);
const runtimeReasonOf = (err) => err != null && typeof(err) === 'object' && RrHas(RUNTIME_REASON, err);
// When to retry, in whole seconds: written only by the runtime's limiters
// (setRetryAfter), held here, never read from the error's own properties (a
// module holding an error could set any, or put one on a prototype: #482's
// high, round 2, 3), clamped to the limiter's window.
const RETRY_AFTER = new WeakMap();
const RaGet = Function.prototype.call.bind(WeakMap.prototype.get);
const RaSet = Function.prototype.call.bind(WeakMap.prototype.set);
// `windowMs`: the limiter's window, as it reports it. None (or not a
// positive finite number of ms) gives no hint at all, never a guessed one
// (#482's high, round 3, 5).
function setRetryAfter(err, ms, windowMs) {
  const n = Number(ms);
  if (err == null || typeof(err) !== 'object' || !Number.isFinite(n) || n <= 0) return err;
  if (typeof(windowMs) !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) return err;
  const cap = Math.max(1, Math.ceil(windowMs / 1000));
  RaSet(RETRY_AFTER, err, Math.min(cap, Math.max(1, Math.ceil(n / 1000))));
  return err;
}
const retryAfterOf = (err) => (err != null && typeof(err) === 'object' ? RaGet(RETRY_AFTER, err) : undefined);
// a runtime copy keeps both; never the handler boundary's (answerable): a
// handler's answer is the module's, and says nothing of when to retry
const carryMarks = (from, to) => {
  if (to == null || typeof(to) !== 'object') return to;
  if (fromHandler(from)) FhAdd(FROM_HANDLER, to);
  if (runtimeReasonOf(from)) RrAdd(RUNTIME_REASON, to);
  const after = retryAfterOf(from);
  if (after !== undefined) RaSet(RETRY_AFTER, to, after);
  return to;
};
const CallerHas = Function.prototype.call.bind(WeakSet.prototype.has);
const CallerAdd = Function.prototype.call.bind(WeakSet.prototype.add);
const CallerDelete = Function.prototype.call.bind(WeakSet.prototype.delete);
const MODULE_OF = new WeakMap();
const WARNED_AT_CALL = new WeakMap();   // error -> the code warned of
const ModuleOfGet = Function.prototype.call.bind(WeakMap.prototype.get);
const ModuleOfSet = Function.prototype.call.bind(WeakMap.prototype.set);
const WarnedGet = Function.prototype.call.bind(WeakMap.prototype.get);
const WarnedSet = Function.prototype.call.bind(WeakMap.prototype.set);
// once per module and code, naming the module; the module's message as text
// (textOf: never its own toString), cut short and with no control characters
const RESERVED_SAID = new Set();
function warnReserved(module, code, message, where) {
  const key = `${module || ''}\0${code}`;
  if (RESERVED_SAID.has(key)) return;
  RESERVED_SAID.add(key);
  const text = (message == null) ? '' : moduleText(textOf(message), 120);
  try { runtimeLog().W(`${module || 'a module'} ${where} ${code}, a code of the runtime's own catalogue, which a module may not use (a setting it cannot do without: ctx.settingRequired); answered MODULE_CODE_RESERVED${text !== '' ? `; its message: ${text}` : ''}`); } catch (logErr) { /* still answered */ }
}
// A module's error (origin module) with a catalogue code -> the runtime's
// MODULE_CODE_RESERVED {code}, issued (the runtime's brand); any other error
// as it is. Every catalogue code, the
// settings gate's claim codes included: a real claim is the runtime's
// (ctx.settingRequired issues it), so a module-origin one is forged (the
// high review of #445, 3). A runtime error a module passes on (from
// ctx.call, say) keeps its origin and its code.
function reservedOr(e, {module = null, warned = false} = {}) {
  let code;
  let origin;
  let message;
  try { code = e.code; origin = e.origin; message = e.message; } catch (readErr) { return e; }
  if (origin !== 'module' || typeof(code) !== 'string' || !RUNTIME_CODES.has(code)) return e;
  if (!warned) warnReserved(module, code, message, 'answered with');
  // (no details: no answer of a runtime-origin error carries them, in any
  // mode: the Reviewer's second high review of #445, 6)
  return issue(CountinghouseError.withFields('MODULE_CODE_RESERVED', {code: code}));
}

// ctx.error (lib/handler-ctx.js): a module's own error, origin module, never
// a runtime-branded one: module code gets nothing of the runtime's to keep
// or hand on (the high review of #445, 9). With a code of the runtime's
// catalogue it is warned of now, naming the module, and the boundary
// (answerable, fromReplyFields) answers it once as MODULE_CODE_RESERVED,
// naming that code, with its details. It never throws, so a call is
// answered wherever the module calls it.
// opts: {kind: 'caller' | 'module'}, anything else ignored (a module never
// says an error is the runtime's or the operator's)
CountinghouseError.moduleOwn = function(code, message, details, moduleName = null, opts = undefined) {
  const e = CountinghouseError.module(code, message, details);
  if (opts != null && typeof(opts) === 'object' && readGuarded(opts, 'kind') === 'caller') CallerAdd(CALLER_KIND, e);
  if (typeof(moduleName) === 'string') ModuleOfSet(MODULE_OF, e, moduleName);
  if (typeof(code) === 'string' && RUNTIME_CODES.has(code)) {
    warnReserved(moduleName, code, message, 'called ctx.error with');
    WarnedSet(WARNED_AT_CALL, e, code);
  }
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
// (e.constructor). Under any module sandbox mode the lockdown
// (lib/module-lockdown.js) freezes the class, makes its prototype
// non-extensible with its catalogue getters fixed, and deletes issue from
// this file's exports once the runtime files that issue have taken it, so
// a module finds it neither on the class nor in require.cache; an error's
// code and message are own data properties, so no accessor on a prototype
// decides them. Only enforce blocks the require routes: audit records a
// require of countinghouse's own files but allows it, and single-thread
// mode and --moduleSandbox off have no sandbox.
// The brand holds the issued message too, so a module cannot put its own
// text under a runtime code (review of #45); it is read from own data
// properties only.
const ISSUED = new WeakMap();
// read and written with WeakMap's methods as taken when this file loaded:
// one a module replaced in its worker never decides what the runtime issued
const IssuedHas = Function.prototype.call.bind(WeakMap.prototype.has);
const IssuedGet = Function.prototype.call.bind(WeakMap.prototype.get);
const IssuedSet = Function.prototype.call.bind(WeakMap.prototype.set);
const ObjectFreeze = Object.freeze;
function issue(err) {
  if (err != null && typeof(err) === 'object' && !IssuedHas(ISSUED, err)) {
    const code = codeOf(ownValue(err, 'code'));
    IssuedSet(ISSUED, err, ObjectFreeze({code: code, message: messageOf(ownValue(err, 'message'), code), origin: 'runtime'}));
  }
  return err;
}

// Copies the runtime decoded from a reply envelope (fromReplyFields): the
// runtime's own objects, so a hop hands them over as they are.
const DECODED = new WeakSet();

// An own data property's value, never through a getter or a prototype (a
// module may add accessors to Error.prototype or Object.prototype in its
// worker); undefined when there is none, UNREAD when looking throws.
function ownValue(obj, name) {
  try {
    const d = ObjectGetOwnPropertyDescriptor(obj, name);
    return (d != null && ObjectHasOwn(d, 'value')) ? d.value : undefined;
  } catch (readErr) {
    return UNREAD;
  }
}

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
CountinghouseError.answerable = function(err, {module = null} = {}) {
  const issued = IssuedGet(ISSUED, err);
  const code = (issued != null) ? issued.code : codeOf(readGuarded(err, 'code'));
  const message = (issued != null) ? issued.message : messageOf(readGuarded(err, 'message'), code);
  const details = readGuarded(err, 'details');
  const cause = readGuarded(err, 'cause');
  const e = new CountinghouseError(code);
  e.message = message;
  // (a runtime-issued error leaving a handler: the module's answer, kind
  // module, 500, unless the end caller's to pass through; #482's high,
  // round 2)
  if (issued != null) {
    issue(e);
    if (!HANDLER_PASS_THROUGH.has(code)) FhAdd(FROM_HANDLER, e);
  } else e.origin = 'module';
  // (the caller's, when its module said so: the copy keeps it)
  if (issued == null && CallerHas(CALLER_KIND, err)) CallerAdd(CALLER_KIND, e);
  if (details !== UNREAD && isDetailsObject(details)) Object.defineProperty(e, 'details', {value: details, enumerable: false, writable: true, configurable: true});
  if (cause !== UNREAD && cause !== undefined) Object.defineProperty(e, 'cause', {value: cause, enumerable: false, writable: true, configurable: true});
  // the copy, once read: a module's error with a catalogue code, however
  // built, in any mode, is the runtime's MODULE_CODE_RESERVED, naming the
  // module ctx.error made it for, if it did
  // (warned only of the code warned of: one changed after ctx.error is
  // warned of here)
  return reservedOr(e, {module: module || ModuleOfGet(MODULE_OF, err) || null, warned: WarnedGet(WARNED_AT_CALL, err) === code});
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
// The runtime's own reasons a worker gives a crash (DEVICE_INVOKE_EXCEPTION),
// each a fixed string of the runtime's: lib/serialized-result.js,
// lib/validator-worker.js and lib/peer-worker.js, and REPLY_NOT_SENT below.
const WORKER_REASONS = Object.freeze(['a module\'s result could not be read', 'a hop\'s input could not be read',
  'a module\'s error could not be read', 'the result could not be sent between threads', 'the error could not be sent between threads',
  'the value could not be sent between threads']);
CountinghouseError.WORKER_REASONS = WORKER_REASONS;
// A crash or an untyped failure the runtime answers (DEVICE_INVOKE_EXCEPTION,
// DEVICE_INVOKE_FAIL), told what the runtime itself refused one of that call's
// module calls with before it (call-tokens refusedOf: {code, to}): one line,
// the code the module saw, never the other module's name nor a remote's own
// words. Anything else, a module's own error included, is left as it was.
const REFUSAL_CODE = /^[A-Z][A-Z0-9_]{2,}$/;
// the codes about the calling module's own call, said as they are; any
// other (a part's state: unloaded, restarting, suspended, a session's worker
// ...) is said as DEVICE_NOT_FOUND, so a caller with no grant on that part
// can't read its state (refusedBefore, for the log, keeps the exact code)
const SAID_AS_IS = new Set(['INPUT_TOO_LARGE', 'OUTPUT_TOO_LARGE', 'USAGE_CALL_FOREIGN', 'INPUT_DATA_VALIDATION_FAIL', 'OUTPUT_DATA_VALIDATION_FAIL',
  'VALIDATION_TIMEOUT', 'VALIDATION_CALLER_THROTTLED', 'SETTING_REQUIRED', 'SETTING_NOT_READY',
  'MISSING_OUTPUT_ARGUMENT', 'ARGUMENTS_INVALID', 'ACTION_NOT_FOUND', 'SERVICE_NOT_FOUND', 'INPUT_NOT_FOUND', 'ACTION_NOT_IMPLEMENTED']);
// (not VALIDATION_QUARANTINED: a module's quarantine is that module's state,
// held until an operator reloads it, so it reads DEVICE_NOT_FOUND)
// (a remote's refusal is said as it is, never as a missing module)
const saidAsIs = (code, to) => to === 'remote' || code.startsWith('CTX_CALL_') || code.startsWith('HOP_') || SAID_AS_IS.has(code);
CountinghouseError.withRefusal = function(err, refused) {
  if (!(err instanceof CountinghouseError) || err.origin === 'module' || (err.code !== 'DEVICE_INVOKE_EXCEPTION' && err.code !== 'DEVICE_INVOKE_FAIL')) return err;
  if (refused == null || typeof(refused) !== 'object' || !Object.prototype.hasOwnProperty.call(refused, 'code') || !Object.prototype.hasOwnProperty.call(refused, 'to')) return err;
  if (typeof(refused.code) !== 'string' || !REFUSAL_CODE.test(refused.code) || (refused.to !== 'module' && refused.to !== 'remote')) return err;
  const shown = saidAsIs(refused.code, refused.to) ? refused.code : 'DEVICE_NOT_FOUND';
  err.message = `${err.message}${err.message.endsWith('.') ? '' : '.'} Before it failed, the runtime refused its call to ${refused.to === 'module' ? 'another module' : 'a remote service'}: ${shown}.`;
  Object.defineProperty(err, 'refusedBefore', {value: {code: refused.code, to: refused.to}, enumerable: false, writable: true, configurable: true});
  return err;
};
// a crash the runtime itself raised with one of its own worker-side reasons
CountinghouseError.runtimeReason = function(code, reason) { const e = new CountinghouseError(code, reason); RrAdd(RUNTIME_REASON, e); return e; };
CountinghouseError.fromReply = function(err) {
  if (err instanceof CountinghouseError && err.origin === 'module') return err;
  const code = err.code != null ? err.code : err.message;
  const e = carryMarks(err, new CountinghouseError(code));
  // the runtime's own worker-side reasons for a crash (a closed list, raised
  // as new CountinghouseError(code, reason)): kept when the reply's text is
  // exactly that message and it is not a handler's own throw (its from-handler
  // mark: a handler's words never cross as the runtime's); anything else a reply says is rebuilt from the
  // code alone, as above
  if (code === 'DEVICE_INVOKE_EXCEPTION' && runtimeReasonOf(err) && !fromHandler(err) && typeof(err.message) === 'string' && WORKER_REASONS.some((r) => err.message === new CountinghouseError(code, r).message)) e.message = err.message;
  // A catalogue text with {placeholders} was filled in where it was raised
  // (CountinghouseError.withFields): the reply's text is that rendering, and
  // the code alone would show the placeholders.
  const entry = (typeof(code) === 'string' && Object.prototype.hasOwnProperty.call(CODES, code)) ? CODES[code] : null;
  if (entry != null && /\{\w+\}/.test(entry.en) && typeof(err.message) === 'string') e.message = err.message;
  // the fields this thread filled in (withFields: SETTING_REQUIRED's
  // missingSettings), kept: never a worker's, which crosses as code and text
  if (err instanceof CountinghouseError && err.fields != null && typeof(err.fields) === 'object') {
    Object.defineProperty(e, 'fields', {value: err.fields, enumerable: false, writable: true, configurable: true});
  }
  return e;
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
    // Through lazy-require's holder (warmed at a worker's boot): a bare unit
    // process may not have loaded lib/logger.js, and the warn line must never
    // throw itself.
    try { runtimeLog().W(`error details unserialisable (${codeNamed(code)}): ${e.name}`); } catch (logErr) { /* the envelope still says so */ }
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
    const fields = {errMsg: errMsg, errCode: code, errOrigin: 'module', errDetails: (details === UNREAD) ? {_details: 'unserialisable'} : cloneDetails(details, code)};
    // (the caller's kind crosses as errKind, only ever 'caller')
    if (CallerHas(CALLER_KIND, err)) fields.errKind = 'caller';
    return fields;
  }
  // (an error that left a handler crosses with its mark: errFromHandler)
  const fields = {errMsg: errMsg, errCode: code};
  if (isObject && fromHandler(err)) fields.errFromHandler = true;
  if (isObject && runtimeReasonOf(err)) fields.errRuntimeReason = true;
  return fields;
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
    // over the message cap (#170): said as that, so the author knows to send less
    const crash = CountinghouseError.replyFields((cloneErr != null && cloneErr.code === 'MESSAGE_TOO_LARGE')
      ? cloneErr : CountinghouseError.runtimeReason('DEVICE_INVOKE_EXCEPTION', REPLY_NOT_SENT));
    const fallback = Object.assign({}, envelope, crash, {data: null});
    delete fallback.errOrigin;
    delete fallback.errDetails;
    delete fallback.errKind;
    // (nor a mark of the error it replaces: #482's high, round 2, 4)
    delete fallback.errFromHandler;
    // (the crash's own mark only, never the replaced error's: MESSAGE_TOO_LARGE carries none)
    delete fallback.errRuntimeReason;
    if (crash.errRuntimeReason === true) fallback.errRuntimeReason = true;
    return post(fallback);
  }
};

// The error a reply carried. A module's comes back as the module's, message
// and details as the module gave them; any other as a plain Error with its
// code, which the receiving side re-wraps.
CountinghouseError.fromReplyFields = function(msg) {
  if (msg.errOrigin === 'module') {
    const e = CountinghouseError.module(msg.errCode);
    e.message = String(msg.errMsg);
    if (isDetailsObject(msg.errDetails)) e.details = msg.errDetails;
    if (msg.errKind === 'caller') CallerAdd(CALLER_KIND, e);
    // (silently: the side that made it, its answerable or ctx.error, has
    // warned of it, naming the module)
    const out = reservedOr(e, {warned: true});
    if (out === e) DECODED.add(e);
    return out;
  }
  const replyErr = new Error(msg.errMsg);
  // defined, not assigned (see the constructor)
  if (msg.errCode != null) Object.defineProperty(replyErr, 'code', {value: msg.errCode, enumerable: true, writable: true, configurable: true});
  if (msg.errFromHandler === true) FhAdd(FROM_HANDLER, replyErr);
  if (msg.errRuntimeReason === true) RrAdd(RUNTIME_REASON, replyErr);
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
  ReflectApplyAtLoad(CtorCaptureStackTrace, Error, [e, CountinghouseError.create]);
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
// A runtime refusal decoded from the main thread's reply (a plain Error
// whose own code is the catalogue's, as fromReplyFields builds it) -> the
// runtime's own, issued, its message kept; anything else as it is (the
// Reviewer's high review of #445, 3: issued where it is decoded)
function issuedIfRuntime(err) {
  if (err == null || typeof(err) !== 'object' || IssuedGet(ISSUED, err) != null) return err;
  // (a CountinghouseError is left as it is: refuse() issues it with its
  // fields; only a decoded plain Error is rebuilt here)
  if (err instanceof CountinghouseError) return err;
  return issuedCopy(err) || err;
}
// err's own catalogue code -> a copy of it, the runtime's, issued, with the
// message it carries (whatever its class: a decoded reply is a plain
// Error); null when its code is none of the catalogue's. The one runtime
// branch of hopError and issuedIfRuntime (the high review of #448, 5b).
function issuedCopy(err) {
  const code = ownValue(err, 'code');
  if (typeof(code) !== 'string' || !RUNTIME_CODES.has(code)) return null;
  const copy = new CountinghouseError(code);
  const message = ownValue(err, 'message');
  if (typeof(message) === 'string') copy.message = message;
  return issue(carryMarks(err, copy));
}

function hopError(err) {
  if (err == null) return err;
  if (err instanceof CountinghouseError && err.origin === 'module') {
    // A part's caller-kind error is its caller's, and its caller is the
    // composing module, not the end caller: across a hop it is the module's
    // again, so a composer's own bad call is never counted as the end
    // caller's (a composer that agrees says so with its own ctx.error: the
    // medium on the kind-caller PR, 1)
    const out = DECODED.has(err) ? err : CountinghouseError.fromReplyFields(CountinghouseError.replyFields(err));
    CallerDelete(CALLER_KIND, out);
    return out;
  }
  // The code as the error holds it (an own data property), and a copy
  // handed over, never the object given (review of #45: in single-thread
  // mode that was the callee's live answer).
  const copy = issuedCopy(err);
  if (copy != null) return copy;
  if (err.code == null && !(err instanceof CountinghouseError)) return err;
  return new Error(err.message);
}

// The one rule for an error's HTTP status and the kind an answer names
// (post-rel caller 400): the catalogue is what the edge reads.
// - A CountinghouseError: its catalogue row's httpStatus and kind, or, for a
//   module's own error, 400 and 'caller' when its module said the caller is
//   at fault, else 500 and 'module'.
// - Any other error whose own code is a catalogue code and isn't a
//   module's: that row (a worker's or a validator's reply is decoded as a
//   plain Error carrying its code: the medium on #caller-400, 1), so a status
//   never depends on the thread mode.
// - Anything else: 500 and 'runtime'.
// Never throws: a getter that does is a 500.
const HANDLER_ROW = Object.freeze({kind: 'module', httpStatus: 500, retryable: false});
function rowOf(err) {
  if (err == null || typeof(err) !== 'object' || err instanceof CountinghouseError) return null;
  try {
    const d = Object.getOwnPropertyDescriptor(err, 'code');
    const origin = Object.getOwnPropertyDescriptor(err, 'origin');
    if (origin != null && origin.value === 'module') return null;
    const code = d != null ? d.value : undefined;
    const row = (typeof(code) === 'string' && Object.prototype.hasOwnProperty.call(CODES, code)) ? CODES[code] : null;
    // (one that left a handler: the module's, #482's high, round 2)
    return row != null && fromHandler(err) ? HANDLER_ROW : row;
  } catch (e) {
    return null;
  }
}
function statusOf(err) {
  const row = rowOf(err);
  if (row != null) return row.httpStatus;
  if (!(err instanceof CountinghouseError)) return 500;
  try {
    const s = err.httpStatus;
    return Number.isInteger(s) && s >= 400 && s < 600 ? s : 500;
  } catch (e) {
    return 500;
  }
}
function kindOf(err) {
  const row = rowOf(err);
  if (row != null) return row.kind;
  if (!(err instanceof CountinghouseError)) return 'runtime';
  try {
    const k = err.kind;
    return typeof(k) === 'string' ? k : 'runtime';
  } catch (e) {
    return 'runtime';
  }
}

// {code, message, kind[, fault]}: what every REST error answer says
function errorBody(err, fault) {
  const body = {code: err != null ? err.code : undefined, message: err != null ? err.message : String(err), kind: kindOf(err)};
  if (fault != null) body.fault = fault;
  return body;
}
// A REST error answer: statusOf's status, errorBody's body; a 401 says how
// to authenticate (RFC 9110 requires its WWW-Authenticate: post-rel caller
// 400's medium, 8)
function answerError(res, err, fault) {
  const status = statusOf(err);
  if (status === 401) res.setHeader('WWW-Authenticate', 'X-CH-Key');
  // (when to retry: only what a limiter wrote, in seconds)
  const after = retryAfterOf(err);
  if ((status === 429 || status === 503) && after !== undefined) res.setHeader('Retry-After', String(after));
  return res.status(status).json(errorBody(err, fault));
}

// An MCP tool result's kind of failure, for the usage record only: set,
// non-enumerable and under a Symbol, on a result built from a module's
// caller-kind error (lib/mcp/gateway.js toolCallResult), read by
// lib/usage/receipt.js finishToolCall. Never serialised, never on the wire.
const RESULT_KIND = Symbol('countinghouse.resultKind');

module.exports = {
  CountinghouseError: CountinghouseError,
  RESULT_KIND: RESULT_KIND,
  statusOf: statusOf,
  kindOf: kindOf,
  errorBody: errorBody,
  answerError: answerError,
  fromHandler: fromHandler,
  markFromHandler: markFromHandler,
  retryAfterOf: retryAfterOf,
  setRetryAfter: setRetryAfter,
  hopError: hopError,
  issue: issue,
  issuedIfRuntime: issuedIfRuntime,
  readGuarded: readGuarded,
  UNREAD: UNREAD,
  UNREADABLE_MESSAGE: UNREADABLE_MESSAGE,
  textOf: textOf
};
