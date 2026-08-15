var events            = require('events');
var util              = require('util');
var validator         = require('./validator');
var LOG               = require('./logger');
var options           = require('./cli-options');
var CHError         = require('./countinghouse-error').CHError;
var DeviceError       = require('./countinghouse-error').DeviceError;

function Service(device, serviceID, spec) {
  this.device      = device;
  this.serviceID   = serviceID;
  this.serviceType = spec.serviceType;
  this.actions     = {};
  // Schema holder for the spec's state variables. Since the response cache
  // and the /get-state route were removed, a state entry carries only the
  // variable's declared type + compiled schema, used by validateActionCall;
  // it no longer holds a value.
  this.states      = {};

  this.updateSpec(spec);
}

util.inherits(Service, events.EventEmitter);

Service.prototype.addAction = function(actionName, action) {
  this.actions[actionName].invoke = action;
};

Service.prototype.updateSpec = function(spec) {
  var actionList = spec.actionList;
  for (var i in actionList) {
    if (!this.actions[i]) {
      var action = actionList[i];
      this.actions[i] = {};
      this.actions[i].name = i;
      this.actions[i].args = action.argumentList; // save for validation
      this.actions[i].invoke = null;              // to be filled by device modules
      this.actions[i].apiLog    = false;

      if (action.apiLog === true) {
        this.actions[i].apiLog = true;
      }

      if (action.fault != null) {
        this.actions[i].faultObj = JSON.parse(JSON.stringify(action.fault)); // save for schema deref
        var self = this.actions[i].faultObj;
        this.device.resolveSchemaFromPath(action.fault.schema, self, function(err, s, data) {
          if (!err) {
            try {
              s.schema    = JSON.parse(JSON.stringify(data)); // reclaim doc object
              s.validator = validator.getSchemaValidator().compile(s.schema);     // pre-compile the schema
            } catch (e) {
              s.validator = null;
              LOG.DE(this.device, new CHError('SCHEMA_COMPILE_ERROR', e.message));
            }
          } // or else faultObj.schema is still a pointer
        }.bind(this));
      }
    }
  }

  // TODO: to save memory usage we can reclaim spec object and dynamically reconstruct it on get-spec call
  var stateVariables = spec.serviceStateTable;

  for (var i in stateVariables) {
    if (!this.states[i]) {
      this.states[i] = {};

      if (stateVariables[i].dataType === 'object') {
        this.states[i].variable = JSON.parse(JSON.stringify(stateVariables[i])); // save for schema deref

        var schemaRef = stateVariables[i].schema;
        if (schemaRef != null) {
          var self = this.states[i].variable;
          this.device.resolveSchemaFromPath(schemaRef, self, function(err, s, data) {
            if (!err) {
              try {
                s.schema = JSON.parse(JSON.stringify(data)); // reclaim doc object
                s.validator = validator.getSchemaValidator().compile(s.schema);     // pre-compile the schema
              } catch (e) {
                s.validator = null;
                LOG.DE(this.device, new CHError('SCHEMA_COMPILE_ERROR', e.message));
              }
            } // or else this is still a pointer
          }.bind(this));
        }
      } else {
        this.states[i].variable = stateVariables[i];
      }
    }
  }
};

Service.prototype.validateActionCall = function(action, args, isInput, callback) {
  var argList   = action.args;
  var failed    = false;
  var error     = null;
  var errorData = null;

  if (isInput === true && args == null) {
    return callback(new DeviceError('ARGUMENTS_INVALID'), null);
  }

  if (isInput === false && args == null) {
    return callback(new DeviceError('MISSING_OUTPUT_ARGUMENT'), null);
  }

  // argument keys must match spec
  if (isInput === true) {
    for (var i in argList) {
      if (argList[i].direction === 'in') {
        if (args[i] === undefined) {
          failed = true;
          error = new DeviceError('INPUT_DATA_VALIDATION_FAIL');
          errorData = {fault: {reason: 'input argument not found', info: ''}};
          break;
        }
      }
    }
  } else {
    for (var i in argList) {
      if (argList[i].direction === 'out') {
        if (args[i] === undefined) {
          failed = true;
          error = new DeviceError('OUTPUT_DATA_VALIDATION_FAIL');
          errorData = {fault: {reason: 'output argument not found', info: ''}};
          break;
        }
      }
    }
  }
  if (failed) {
    return callback(error, errorData);
  }

  // validate data
  for (var i in args) {
    //patch for special argument name, see routes/invoke-action.js for details
    if (i === 'ctx' || i === 'httpHeaders' || i ==='jobID') continue;
    var name = argList[i].relatedStateVariable;
    var stateVar = this.states[name].variable;

    if (isInput && argList[i].direction === 'out') {
      // only check out args on call return
      continue;
    } else {
      validator.validate(i, stateVar, args[i], function(errMsg, errInfo) {
        if (errMsg) {
          if (isInput === true) {
            error = new DeviceError('INPUT_DATA_VALIDATION_FAIL');
          } else {
            error = new DeviceError('OUTPUT_DATA_VALIDATION_FAIL');
          }
          //TODO: define this error reason msg in locale
          errorData = {fault: {reason: errMsg, info: errInfo}};
          failed = true;
        }
      });
    }
    if (failed) break;
  }
  callback(error, errorData);
};

Service.prototype.invokeAction = function(actionName, args, session) {
  var action = this.actions[actionName];

  var cb = null;
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
  if (options.apiMonitor === true) {
    if (typeof(session) !== 'function') {
      //to log api details in session code
      if (action.apiLog === true) session.apiLog = true;
    }
  }

  this.validateActionCall(action, args, true, function(err, data) {
    if (err) {
      if (data && data.fault) {
        return cb(err, data.fault);
      }
      return cb(err, data);
    }
    return this.doActionCall(action, args, session);
  }.bind(this));
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
  var cb = null;
  //under child thread mode session object is a callback function
  if (typeof(session) === 'function') {
    cb = session;
  } else {
    cb = session.callback;
  }

  var _this = this;

  const isAsync = action.invoke.constructor.name === 'AsyncFunction';
  if (isAsync === true) {
    (async function() {
      var output;
      try {
        output = await action.invoke(args);

        await new Promise(function(resolve, reject) {
          _this.validateActionCall(action, output, false, function(error, data) {
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
      action.invoke(args, function(err, output) {
        if (err) {
          //TODO: validate the content of fault object according to its optional fault definition in device spec
          // API's formal fault definition, which can be in either simple or complex type, would make it more conformant to WSDL
          var error = null;
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

        _this.validateActionCall(action, output, false, function(error, data) {
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
