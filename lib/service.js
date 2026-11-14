const events            = require('events');
const util              = require('util');
const path              = require('path');
const validator         = require('./validator');
const LOG               = require('./logger');
const {CountinghouseError} = require('./countinghouse-error');
const {answerHandler} = require('./handler-answer');

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
// invokeJobs), and `usageCall` (the usage counters' call id: lib/mcp/gateway.js
// for a tools/call, and a task's run; local-mode spec §5).
// They are not action arguments and are never validated, but they are legal
// to find here.
// `token` (R2-1 Task 3): the call's per-call token, issued by the main
// thread; lib/handler-ctx.js keeps it in ctx's closure.
const FRAMEWORK_ARG_KEYS = {ctx: true, httpHeaders: true, jobID: true, usageCall: true, token: true};

function Service(device, serviceID, spec) {
  this.device      = device;
  this.serviceID   = serviceID;
  this.serviceType = spec.serviceType;
  // No prototype: an action may be named constructor, toString or
  // __proto__ (api.json allows any name), and must then be the module's own
  // entry, never Object.prototype's member (a lookup of an undeclared one
  // finds nothing, and a declared one is set on its own entry).
  this.actions     = Object.create(null);

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
// done (optional): called once the object is resolved and compiled, or has
// failed to be.
Service.prototype.resolveSchemaObject = function(obj, done) {
  this.device.resolveSchemaFromPath(obj.schema, obj, (err, s, data) => {
    if (err) { // or else s.schema is still a pointer
      if (typeof(done) === 'function') done();
      return;
    }
    try {
      s.schema    = JSON.parse(JSON.stringify(data)); // reclaim doc object
      // the device's own instance when it has one (lib/validator-worker.js)
      const ajv = (this.device != null && this.device.schemaValidator != null) ? this.device.schemaValidator : validator.getSchemaValidator();
      s.validator = ajv.compile(s.schema);     // pre-compile the schema
    } catch (e) {
      s.validator = null;
      LOG.DE(this.device, new CountinghouseError('SCHEMA_COMPILE_ERROR', e.message));
    }
    if (typeof(done) === 'function') done();
  });
};

// One action's schemas resolved and compiled, when the device compiles
// lazily (lib/validator-worker.js: per action, on demand, under a budget):
// a promise, resolved once each is (or has failed to be). An action already
// compiled resolves at once.
Service.prototype.compileAction = function(actionName) {
  const action = Object.hasOwn(this.actions, actionName) ? this.actions[actionName] : null;
  if (action == null) return Promise.resolve();
  if (action.compiled == null) {
    action.compiled = Promise.all(SCHEMA_KEYS.filter((key) => action[key] != null)
      .map((key) => new Promise((resolve) => this.resolveSchemaObject(action[key], resolve))));
  }
  return action.compiled;
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
      // A device that compiles lazily (a validator's) compiles an action on
      // demand (compileAction); any other, all of them now.
      if (this.device == null || this.device.lazySchemas !== true) this.resolveSchemaObject(this.actions[name][key]);
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

// The answer a failed check gives: the error, and the fault alone when there
// is one.
function refusal(err, data) {
  return [err, (data && data.fault) ? data.fault : data];
}

// One side of a call checked against its action's schema: null when it
// passes, else [error, data] as the call answers it. A validator worker
// checks every call the main thread routes to a module's worker with this
// (lib/validator-worker.js), so a module worker's answer and a validator's
// are one function's output.
Service.prototype.refuseData = function(action, args, isInput) {
  let answer = null;
  this.validateActionCall(action, args, isInput, (err, data) => {
    if (err) answer = refusal(err, data);
  });
  return answer;
};

// The checks before a call runs, in order: the action, an input at all, a
// handler for it (needsHandler: a validator's copy of a module's services
// has no handlers, and a loaded module has one for every action,
// lib/handler-map.js), then the input against its schema (unless
// validate is false). null when the call may run, else [error, data].
Service.prototype.refuseCall = function(actionName, args, needsHandler, validate) {
  const action = this.actions[actionName];
  if (action == null) return [new CountinghouseError('ACTION_NOT_FOUND', actionName), null];
  if (args == null) return [new CountinghouseError('INPUT_NOT_FOUND'), null];
  if (needsHandler === true && action.invoke == null) return [new CountinghouseError('ACTION_NOT_IMPLEMENTED', actionName), null];
  return (validate === false) ? null : this.refuseData(action, args, true);
};

// A call already checked (lean worker, step 1(b)): the main thread had its
// input validated in a validator worker, sent the invoke with mainChecked,
// and the worker added that invoke's answer callback here (since lean worker
// step 3 a worker answers through lib/lean-dispatcher.js instead, and
// nothing in a worker builds a Service for a checked call). The worker then
// skips its own input and output validation; a validator checks the output
// on the reply. Only the main thread's
// invoke message adds to it: a direct peer channel's call (lib/peer-channel.js)
// is validated here, in the called worker, as before.
const MAIN_CHECKED = new WeakSet();
Service.markMainChecked = function(callback) {
  MAIN_CHECKED.add(callback);
};
function mainChecked(session) {
  return typeof(session) === 'function' && MAIN_CHECKED.has(session);
}

Service.prototype.invokeAction = function(actionName, args, session) {
  let cb = null;
  //under child thread mode session object is a callback function
  if (typeof(session) === 'function') {
    cb = session;
  } else {
    cb = session.callback;
  }

  // Per-action pricing (realPrice) + the NOT_ENOUGH_USER_BALANCE gate that
  // used to live here were retired (docs/design-decisions.md's
  // AuthProvider section): it read balance/apiRemainCount off the Session
  // object, which came from lib/user-auth.js's CouchDB-backed
  // devices[].priceRecord lookup -- both retired alongside AuthProvider.
  // No bundled device module ever declared realPrice on an action, so this
  // gate never actually fired in any test; billing lives entirely in
  // MeteringProvider now (options.mcpToolCallCost et al).
  const refused = this.refuseCall(actionName, args, true, !mainChecked(session));
  if (refused != null) return cb(refused[0], refused[1]);
  return this.doActionCall(this.actions[actionName], args, session);
};

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
  const skipOutput = mainChecked(session);
  const finish = function(output) {
    const refused = (skipOutput === true && typeof(output) !== 'function') ? null : _this.refuseData(action, output, false);
    if (refused != null) return cb(refused[0], refused[1]);
    return cb(null, output);
  };

  // How the handler reported, and what that answers: lib/handler-answer.js.
  return answerHandler((a, c) => action.invoke(a, c), args, cb, finish);
};

module.exports = Service;
