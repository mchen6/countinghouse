const events            = require('events');
const util              = require('util');
const validator         = require('./validator');
const LOG               = require('./logger');
const CHError         = require('./countinghouse-error').CHError;
const DeviceError       = require('./countinghouse-error').DeviceError;

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
      LOG.DE(this.device, new CHError('SCHEMA_COMPILE_ERROR', e.message));
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
    return callback(new DeviceError('ARGUMENTS_INVALID'), null);
  }

  if (isInput === false && args == null) {
    return callback(new DeviceError('MISSING_OUTPUT_ARGUMENT'), null);
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
      return callback(new DeviceError(errorCode),
                      {fault: {reason: `unexpected ${key} argument: ${name}`, info: ''}});
    }
  }

  const schemaObj = action[key];
  if (schemaObj == null) return callback(null, null);

  if (args[key] === undefined) {
    return callback(new DeviceError(errorCode), {fault: {reason: `${key} argument not found`, info: ''}});
  }

  let error     = null;
  let errorData = null;

  validator.validate(key, schemaObj, args[key], (errMsg, errInfo) => {
    if (errMsg) {
      error = new DeviceError(errorCode);
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
    return cb(new CHError('ACTION_NOT_FOUND', actionName), null);
  }
  if (args == null) {
    return cb(new CHError('INPUT_NOT_FOUND'), null);
  }
  if (action.invoke == null) {
    return cb(new DeviceError('ACTION_NOT_IMPLEMENTED', actionName), null);
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
function toJSONSafeFault(err) {
  return {message: err.message, name: err.name, stack: err.stack};
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

  const isAsync = action.invoke.constructor.name === 'AsyncFunction';
  if (isAsync === true) {
    (async function() {
      let output;
      try {
        output = await action.invoke(args);

        await new Promise((resolve, reject) => {
          _this.validateActionCall(action, output, false, (error, data) => {
            if (error) return reject(error);
            return resolve();
          });
        });
      } catch (err) {
        return cb(new DeviceError('DEVICE_INVOKE_EXCEPTION'), toJSONSafeFault(err));
      }
      return cb(null, output);
    })();
  } else {
    try {
      action.invoke(args, (err, output) => {
        if (err) {
          //TODO: validate the content of fault object according to its optional fault definition in device spec
          // API's formal fault definition, which can be in either simple or complex type, would make it more conformant to WSDL
          let error = null;
          if (err instanceof DeviceError || err instanceof CHError) {
            error = err;
          } else {
            error = new DeviceError('DEVICE_INVOKE_FAIL', err.message);
          }
          if (output && output.fault) {
            return cb(error, output.fault);
          }
          return cb(error, output);
        }

        _this.validateActionCall(action, output, false, (error, data) => {
          if (error) {
            if (data && data.fault) {
              return cb(error, data.fault);
            }
            return cb(error, data);
          }
          return cb(null, output);
        });
      });
    } catch (err) {
      return cb(new DeviceError('DEVICE_INVOKE_EXCEPTION'), toJSONSafeFault(err));
    }
  }
};

module.exports = Service;
