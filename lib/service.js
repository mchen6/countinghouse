const events            = require('events');
const util              = require('util');
const path              = require('path');
const validator         = require('./validator');
const LOG               = require('./logger');
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const {textOf}           = require('./countinghouse-error');

// The three schema-bearing keys an action can declare. Each is optional and
// holds a pointer into the module's schema.json ({schema: '/a/b/input'}),
// which is resolved and compiled once, here, at spec load time.
const SCHEMA_KEYS = ['input', 'output', 'fault'];

// The two reserved argument names. An action's arguments are exactly one
// `input` and one `output` -- that is the whole vocabulary, and has been since
// --allowSimpleType went.
const ARGUMENT_KEYS = {input: true, output: true};

// Keys the framework injects into the argument object itself rather than the
// module declaring them: the Session (`ctx`, set by lib/routes/invoke-action.js
// and dropped again before any worker boundary), the raw request headers
// (`httpHeaders`, same place), and `jobID` (lib/device-manager.js's
// invokeJobs). They are not action arguments and are never validated, but they
// are legal to find here.
const FRAMEWORK_ARG_KEYS = {ctx: true, httpHeaders: true, jobID: true};

function Service(device, serviceID, spec) {
  this.device      = device;
  this.serviceID   = serviceID;
  this.serviceType = spec.serviceType;
  this.actions     = {};

  this.updateSpec(spec);
}

util.inherits(Service, events.EventEmitter);

Service.prototype.addAction = function(actionName, action) {
  this.actions[actionName].invoke = action;
};

// Resolves one {schema: <pointer>} object in place: replaces the pointer with
// the dereferenced schema document and attaches a compiled validator. On
// failure the pointer is left as-is and validator stays null, which
// validateActionCall reports as 'schema validator unavailable' rather than
// silently accepting unvalidated data.
Service.prototype.resolveSchemaObject = function(obj) {
  this.device.resolveSchemaFromPath(obj.schema, obj, (err, s, data) => {
    if (err) return; // or else s.schema is still a pointer
    try {
      s.schema    = JSON.parse(JSON.stringify(data)); // reclaim doc object
      s.validator = validator.getSchemaValidator().compile(s.schema);     // pre-compile the schema
    } catch (e) {
      s.validator = null;
      LOG.DE(this.device, new CountinghouseError('SCHEMA_COMPILE_ERROR', e.message));
    }
  });
};

Service.prototype.updateSpec = function(spec) {
  const actionList = spec.actionList;

  // TODO: to save memory usage we can reclaim spec object and dynamically reconstruct it on get-spec call
  for (let i = 0; i < actionList.length; i++) {
    const action = actionList[i];
    const name   = action.name;
    if (this.actions[name]) continue;

    this.actions[name] = {
      name:   name,
      invoke: null              // to be filled by device modules
    };

    for (let k = 0; k < SCHEMA_KEYS.length; k++) {
      const key = SCHEMA_KEYS[k];
      if (action[key] == null) continue;
      this.actions[name][key] = JSON.parse(JSON.stringify(action[key])); // save for schema deref
      this.resolveSchemaObject(this.actions[name][key]);
    }
  }
};

// Validates one side of a call. `args` is the whole argument object -- on the
// way in {input: ..., ctx, httpHeaders, jobID}, on the way out whatever the
// module passed back -- and only the key matching the direction is looked at;
// anything else in there is none of this function's business.
//
// An action that declares no schema for a direction is not validated in that
// direction, and may then be called without that key at all.
Service.prototype.validateActionCall = function(action, args, isInput, callback) {
  const key       = (isInput === true) ? 'input' : 'output';
  const errorCode = (isInput === true) ? 'INPUT_DATA_VALIDATION_FAIL' : 'OUTPUT_DATA_VALIDATION_FAIL';

  if (isInput === true && args == null) {
    return callback(new CountinghouseError('ARGUMENTS_INVALID'), null);
  }

  if (isInput === false && args == null) {
    return callback(new CountinghouseError('MISSING_OUTPUT_ARGUMENT'), null);
  }

  // An argument object may contain only the two reserved argument names and
  // the framework's own injected keys. Anything else is rejected rather than
  // ignored -- see docs/design-decisions.md, "Unknown arguments are rejected".
  // Only plain objects are scanned: a non-object return value (a number, a
  // string, a function) is a different failure, reported below as a missing
  // output argument, which is what it is.
  if (args !== null && typeof(args) === 'object' && !Array.isArray(args)) {
    for (const name in args) {
      if (ARGUMENT_KEYS[name] === true || FRAMEWORK_ARG_KEYS[name] === true) continue;
      return callback(new CountinghouseError(errorCode),
                      {fault: {reason: `unexpected ${key} argument: ${name}`, info: ''}});
    }
  }

  const schemaObj = action[key];
  if (schemaObj == null) return callback(null, null);

  if (args[key] === undefined) {
    return callback(new CountinghouseError(errorCode), {fault: {reason: `${key} argument not found`, info: ''}});
  }

  let error     = null;
  let errorData = null;

  validator.validate(key, schemaObj, args[key], (errMsg, errInfo) => {
    if (errMsg) {
      error = new CountinghouseError(errorCode);
      //TODO: define this error reason msg in locale
      errorData = {fault: {reason: errMsg, info: errInfo}};
    }
  });
  callback(error, errorData);
};

Service.prototype.invokeAction = function(actionName, args, session) {
  const action = this.actions[actionName];

  let cb = null;
  //under child thread mode session object is a callback function
  if (typeof(session) === 'function') {
    cb = session;
  } else {
    cb = session.callback;
  }

  if (action == null) {
    return cb(new CountinghouseError('ACTION_NOT_FOUND', actionName), null);
  }
  if (args == null) {
    return cb(new CountinghouseError('INPUT_NOT_FOUND'), null);
  }
  if (action.invoke == null) {
    return cb(new CountinghouseError('ACTION_NOT_IMPLEMENTED', actionName), null);
  }

  // Per-action pricing (realPrice) + the NOT_ENOUGH_USER_BALANCE gate that
  // used to live here were retired (docs/design-decisions.md's
  // AuthProvider section): it read balance/apiRemainCount off the Session
  // object, which came from lib/user-auth.js's CouchDB-backed
  // devices[].priceRecord lookup -- both retired alongside AuthProvider.
  // No bundled device module ever declared realPrice on an action, so this
  // gate never actually fired in any test; billing lives entirely in
  // MeteringProvider now (options.mcpToolCallCost et al).
  this.validateActionCall(action, args, true, (err, data) => {
    if (err) {
      if (data && data.fault) {
        return cb(err, data.fault);
      }
      return cb(err, data);
    }
    return this.doActionCall(action, args, session);
  });
};

// Native Error objects do not survive JSON.stringify -- `.message` and
// `.stack` are non-enumerable own properties, so `res.json({fault: err})`
// silently serializes to `{}`. Verified this was *already* true with the
// old Domain-based catching this function used until 2026-08-09 (the
// domain's 'error' handler received the exact same raw Error object,
// same result) -- initially assumed CI's test027-030 failure was Domain
// losing track of the error (the known fragility from the Sprint 2 nano
// incident), but comparing the
// old and new code side by side against the same environment showed both
// produce an empty fault; this was a latent, pre-existing gap in how a
// caught exception gets shaped for the response, not something Domain
// was ever actually protecting against. Fixed by explicitly normalizing
// the caught error into a plain, JSON-safe object before it becomes
// `fault` (see toJSONSafeFault below), independent of catching mechanism.
// Total: a thrown null, a rejection with nothing, or any non-object is a
// fault too (review of #37: it used to throw, leaving the call unanswered).
// Reading the value never throws either (review of c9: a Proxy whose get
// trap throws used to make fail() throw, so the call was never answered).
// Each field is read on its own and kept as text when present (null and
// undefined stay so), so one throwing getter loses only its own field, and
// the fault is always serialisable, as JSON or over a thread reply
// (reviews of c10 and c11).
// `message` is the one read fail() already made (review of c12: a getter
// runs once), on every path but a runtime bug's, where fromModule read it
// once before it threw (review of c14).
const UNREADABLE_MESSAGE = 'a thrown value whose properties cannot be read';
function toJSONSafeFault(err, message) {
  if (err == null || typeof(err) !== 'object') return {message: textOf(err)};
  return {message: (message === UNREADABLE) ? UNREADABLE_MESSAGE : message,
    name: readField(err, 'name'), stack: readField(err, 'stack')};
}

// One field of a thrown or called-back value, as text (textOf), or
// `fallback` when reading it throws; never throws itself. fail() calls it
// with a thrown null too.
const UNREADABLE = Symbol('unreadable');
function readField(err, name, fallback = undefined) {
  try {
    const value = (err != null) ? err[name] : undefined;
    return (value == null || typeof(value) === 'string') ? value : textOf(value);
  } catch (readErr) {
    return fallback;
  }
}

// A runtime bug's name and where it threw, for the log line; never its
// message, which may carry the module's text. The stack's head is the
// message as it was when the stack was taken, which may since have changed,
// so no line count can skip it (review of c14): the frame is the first line
// that has a frame's exact form and names a file this process has loaded
// (require.cache) under the runtime's root, logged as that file, relative
// to the root, and a line number; a file outside the root (a module's,
// under someone's home directory) is never named (review of c15). A line of
// module text can at most name such a file and a number. The name is logged only when it is one of the language's own
// error names or the runtime's. Never throws.
const RUNTIME_ROOT = path.resolve(__dirname, '..');
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError', 'CountinghouseError']);
const FRAME = /^ {4}at (?:[^\n]*\()?((?:\/|[A-Za-z]:\\)[^():\n]+):(\d{1,7}):\d{1,7}\)?$/;
function whereFrom(err) {
  try {
    if (err == null || typeof(err) !== 'object') return `a thrown ${err === null ? 'null' : typeof(err)}`;
    const name = err.name;
    const named = (typeof(name) === 'string' && ERROR_NAMES.has(name)) ? name : 'an error of another name';
    const stack = err.stack;
    const lines = (typeof(stack) === 'string') ? stack.split('\n') : [];
    for (const line of lines) {
      const frame = FRAME.exec(line);
      if (frame == null || !Object.prototype.hasOwnProperty.call(require.cache, frame[1])) continue;
      const file = path.relative(RUNTIME_ROOT, frame[1]);
      if (file === '' || file.startsWith('..') || path.isAbsolute(file)) continue;
      return `${named} at ${file}:${frame[2]}`;
    }
    return named;
  } catch (readErr) {
    return 'unreadable';
  }
}

// Domain-based catching (Node's deprecated `domain` module) replaced with
// plain try/catch on 2026-08-09, alongside the fault-serialization fix
// above. try/catch has none of domain's dependency-tree fragility, but
// comes with a real, unavoidable capability loss domain's monkey-patching
// used to paper over: try/catch (and `await`) can only catch an exception
// thrown *synchronously relative to where the try/catch is*. It cannot
// catch one thrown later, inside a fully detached callback (e.g. inside a
// bare `setTimeout` in a callback-style action, or inside a `new Promise`
// executor's deferred callback that never calls `resolve`/`reject`) --
// there is no modern, non-deprecated replacement for that specific
// capability short of a much larger AsyncLocalStorage-based
// reimplementation, out of scope for this fix. Two existing tests
// exercise exactly that scenario on purpose
// (test/unit/test029.js/errorInfoTestService/testAsyncThrowInDomain,
// test030.js/testAsyncThrowInAsync -- both throw inside a detached
// setTimeout) and were updated alongside this change: such a call now
// times out (DEVICE_NOT_RESPONDING) rather than returning a fast
// DEVICE_INVOKE_EXCEPTION, an honest behavior change, not an oversight.
Service.prototype.doActionCall = function(action, args, session) {
  let cb = null;
  //under child thread mode session object is a callback function
  if (typeof(session) === 'function') {
    cb = session;
  } else {
    cb = session.callback;
  }

  const _this = this;

  // One path, not two. Which style a handler uses is decided by what it
  // *returns* -- a thenable means await it, anything else means wait for the
  // callback -- rather than by `action.invoke.constructor.name ===
  // 'AsyncFunction'`, which was the old test. That test was wrong in a way
  // that hangs rather than fails: an ordinary function returning a promise
  // (the common shape once a handler is refactored to call an async helper)
  // was sent down the callback branch, where nothing ever called back.
  //
  // The callback contract is still supported in 6.0.0 and is DEPRECATED --
  // scheduled for removal in 7.0.0. `(input, ctx) => ({output})` is the form
  // to write new handlers in.
  let settled = false;

  // Output validation and reply, shared by both styles. Previously the async
  // branch had its own copy which turned *any* validation failure into
  // DEVICE_INVOKE_EXCEPTION, losing the validator's own code; now both report
  // what the validator actually said.
  const finish = function(output) {
    _this.validateActionCall(action, output, false, (error, data) => {
      if (error) {
        if (data && data.fault) return cb(error, data.fault);
        return cb(error, data);
      }
      return cb(null, output);
    });
  };

  // A reported failure is classified by the *value*, not by how it arrived:
  // a CountinghouseError keeps its own code on either style, so an async
  // handler can finally return a typed error at all (a rejection used to be
  // flattened to DEVICE_INVOKE_EXCEPTION unconditionally, discarding the
  // code).
  //
  // For anything untyped the two styles deliberately still differ, and
  // docs/design-decisions.md records why: `callback(err)` is a handler
  // reporting a failure (DEVICE_INVOKE_FAIL), while a throw is a handler
  // crashing (DEVICE_INVOKE_EXCEPTION). Collapsing those would erase the
  // distinction rather than unify it -- an async function has no way to
  // express the first except by throwing, so the error's type is the only
  // honest signal of which one happened.
  //
  // Typed means §5.1's rule (CountinghouseError.fromModule): a
  // CountinghouseError, or a plain Error whose `.code` is a module's own
  // (not a system error's or Node's).
  const fail = function(err, output, untypedCode) {
    // Building the module's error is the runtime's own code: should it
    // throw (a runtime bug), the call is still answered, as a crash, and
    // the bug is logged by its name and the frame it threw in, never its
    // message, which may carry the module's text (reviews of c11, c12).
    // A typed failure is answered with the runtime's copy of the module's
    // error, never the module's object, which it may still change
    // (CountinghouseError.answerable, review of c14).
    let typed;
    try {
      typed = CountinghouseError.fromModule(err);
      if (typed != null) typed = CountinghouseError.answerable(typed);
    } catch (buildErr) {
      try { LOG.E(`a module's error could not be built (a runtime bug): ${whereFrom(buildErr)}`); } catch (logErr) { /* still answered */ }
      typed = null;
      untypedCode = 'DEVICE_INVOKE_EXCEPTION';
    }
    // The message is read once here, for the error and the fault alike
    // (on the runtime-bug path fromModule had read it already). With
    // none, the catalogue's text alone (getErrorMessage drops empty
    // arguments); an object message is rendered as JSON, as before.
    const message = (typed != null) ? undefined : readField(err, 'message', UNREADABLE);
    const error = (typed != null) ? typed
                : new CountinghouseError(untypedCode, (message === UNREADABLE) ? undefined : message);

    if (typed == null && untypedCode === 'DEVICE_INVOKE_EXCEPTION') {
      return cb(error, toJSONSafeFault(err, message));
    }
    //TODO: validate the content of fault object according to its optional fault definition in device spec
    // API's formal fault definition, which can be in either simple or complex type, would make it more conformant to WSDL
    // The output a failure came with is the module's: reading its fault
    // may throw, and then the answer carries none (review of c15).
    let reply = output;
    try {
      if (output && output.fault) reply = output.fault;
    } catch (readErr) {
      reply = null;
    }
    return cb(error, reply);
  };

  let returned;
  try {
    returned = action.invoke(args, (err, output) => {
      if (settled === true) return;
      settled = true;

      if (err) return fail(err, output, 'DEVICE_INVOKE_FAIL');
      return finish(output);
    });
  } catch (err) {
    // synchronous throw, before the handler ever called back or returned:
    // the same as a rejection, so a plain function may throw its typed
    // error (ctx.error) too, and an untyped throw is still a crash
    if (settled === true) return;
    settled = true;
    return fail(err, null, 'DEVICE_INVOKE_EXCEPTION');
  }

  // A handler may hand back its error by returning it (ctx.error, the
  // user's preferred form), from a plain function or an async one: the same
  // answer as callback(err) or a throw. Only a CountinghouseError counts; a
  // plain object that looks like one is a result. Reading what came back
  // runs the module's own traps and getters (a Proxy's getPrototypeOf, a
  // `then` getter): one that throws is a crash, answered (review of c15).
  const isReturnedError = (value) => {
    try {
      return value instanceof CountinghouseError;
    } catch (readErr) {
      return readErr;
    }
  };
  const crashed = (value) => (value !== true && value !== false);

  // (The `then` handlers are attached even once the handler has called
  // back, so a promise it also returned never rejects unhandled.)
  const returnedError = isReturnedError(returned);
  if (crashed(returnedError)) {
    if (settled === true) return;
    settled = true;
    return fail(returnedError, null, 'DEVICE_INVOKE_EXCEPTION');
  }
  if (returnedError === true) {
    if (settled === true) return;
    settled = true;
    return fail(returned, null, 'DEVICE_INVOKE_FAIL');
  }

  try {
    if (returned == null || typeof(returned.then) !== 'function') return;
    returned.then((output) => {
      if (settled === true) return;
      settled = true;
      const outputError = isReturnedError(output);
      if (crashed(outputError)) return fail(outputError, null, 'DEVICE_INVOKE_EXCEPTION');
      if (outputError === true) return fail(output, null, 'DEVICE_INVOKE_FAIL');
      return finish(output);
    }, (err) => {
      if (settled === true) return;
      settled = true;
      return fail(err, null, 'DEVICE_INVOKE_EXCEPTION');
    });
  } catch (thenErr) {
    if (settled === true) return;
    settled = true;
    return fail(thenErr, null, 'DEVICE_INVOKE_EXCEPTION');
  }
};

module.exports = Service;
