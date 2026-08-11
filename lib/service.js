var events            = require('events');
var util              = require('util');
var validator         = require('./validator');
var LOG               = require('./logger');
var options           = require('./cli-options');
var CHError         = require('./countinghouse-error').CHError;
var DeviceError       = require('./countinghouse-error').DeviceError;
var hashKey           = require('./hash-key');
var redis             = require("redis");
var stringHash        = require('string-hash');

var redisAPI          = require('./redis-api');

function Service(device, serviceID, spec) {
  this.device      = device;
  this.serviceID   = serviceID;
  this.serviceType = spec.serviceType;
  this.actions     = {};
  this.states      = {};

  this.updateSpec(spec);
  this.updateStateFromAction = this.updateStateFromAction.bind(this);
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
      this.actions[i].apiCache  = null;
      this.actions[i].apiLog    = false;

      if (action.apiCache != null) {
        this.actions[i].apiCache = action.apiCache;
      }
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

      //TODO: need to deep clone this if we reclaim spec obj
      if (stateVariables[i].hasOwnProperty('defaultValue')) {
        this.states[i].value = stateVariables[i].defaultValue;
      } else {
        this.states[i].value = '';
      }
    }
  }
};

Service.prototype.getServiceStates = function(callback) {
  var output = {};
  for (var i in this.states) {
    output[i] = this.states[i].value;
  }
  callback(null, output);
};

Service.prototype.setServiceStates = function(values, callback) {
  var _this = this;
  var errorMessage = null;
  var updated = false;
  var sendEvent = false;
  var data = {};

  if (typeof(values) !== 'object') {
    errorMessage = 'event data must be object';
  } else {
    for (var i in values) {
      if (this.states[i] === undefined) {
        errorMessage = 'set invalid state for variable name: ' + i;
        break;
      }
    }
  }

  if (errorMessage === null) {
    for (var i in values) {
      validator.validate(i, this.states[i].variable, values[i], function(err) {
        if (!err) {
          if (typeof(values[i]) === 'object') {
            if (JSON.stringify(values[i]) !== JSON.stringify(_this.states[i].value)) {
              updated = true;
              _this.states[i].value = JSON.parse(JSON.stringify(values[i]));
            }
          } else {
            if (_this.states[i].value !== values[i]) {
              _this.states[i].value = values[i];
              updated = true;
            }
          }
        } else {
          errorMessage = err.message;
        }
      });
      if (errorMessage) break;

      // report only eventable data
      if (this.states[i].variable.sendEvents === true) {
        if (typeof(values[i]) === 'object') {
          data[i] = JSON.parse(JSON.stringify(values[i]));
        } else {
          data[i] = values[i];
        }
      }
    }
  }

  if (errorMessage) {
    callback(new CHError('SET_SERVICE_STATE_ERROR', errorMessage));
  } else {
    this.emit('serviceevent', updated, this.device.deviceID, this.serviceID, data);
    callback(null);
  }
};

Service.prototype.updateStateFromAction = function(action, args, output, callback) {
  if (options.apiCache === true && action.apiCache != null) {

    if (args.httpHeaders != null) {
      if (args.httpHeaders['content-type'] === 'application/bson' || args.httpHeaders['content-length'] == null || args.httpHeaders['content-length'] > 2048) {
        return callback(false);
      }
    }

    var hashString       = hashKey.getInputHashKey(this.device.deviceID, this.serviceID, action.name, {input: args.input});
    var outputString     = JSON.stringify(output);
    redisAPI.client.hmget(hashString, 'deviceID', function(err, results) {
      if (err) {
        LOG.E(new CHError('REDIS_CLIENT_ERROR', err.message));
        return callback(false);
      }
      if ((results[0] != null && results[0] !== this.device.deviceID)) {
        LOG.I('hash collision for input key: ' + this.device.deviceID + '#' + this.serviceID + '#' + action.name + '#' + JSON.stringify({input: args.input}));
        return callback(false); // hash collision
      }

      //TODO: do not allow more than 1 request create cache entry, multiple creation requests can happen when we flush redis cache
      if (results[0] == null) {
        redisAPI.client.hmset(hashString, 'deviceID', this.device.deviceID, 'value', outputString, function(err) {
          if (err) {
            LOG.E(new CHError('REDIS_CLIENT_ERROR', err.message));
            return callback(false);
          }
          LOG.I('api cache created for input key: ' + this.device.deviceID + '#' + this.serviceID + '#' + action.name + '#' + JSON.stringify({input: args.input}));
          redisAPI.client.pexpire(hashString, action.apiCache);
          return callback(false); //no longer return updated event to caller
        }.bind(this));
      }
    }.bind(this));
  }
  return callback(false);
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
          errorData = {fault: {reason: '未找到输入参数', info: ''}};
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
          errorData = {fault: {reason: '未找到输出参数', info: ''}};
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
    if (options.apiCache === true && action.apiCache != null) {
      this.getValueFromAPICache(actionName, action.apiCache, args, function(err, value, freq) {
        // here the freq indicates the access freq. per second for a specific input key, not the whole api
        // when we return 200, this freq will be carried back to client in http max-age cache control header
        // and this means if there is any hash code collision, or if we return 500 from action call, there
        // will be no cache control header set

        // in reality the access frequency won't be very high, for example if we can locally reach 2000 freq, in real env.
        // 500 would be very nice, and in this case we may ask client refresh a key every 100 seconds
        // This 1/5 factor can be tuned in real env. And this is to ensure we fetch backend server value every 1 second.
        // And during this 100 seconds time period,  client would always fetch value from local cache,
        // and at the same time we will push value updates to client, so client may see latest value update
        // if it access the key within this 100 seconds period.

        // If any hashCode collision occurs for an input key, freq would be always set to null
        // And client won't receive server load hint and should not delay any action call
        if (typeof(session) !== 'function') {
          if (freq != null) session.apiKeyFreq = freq;
        }
        if (err != null || value == null) {
          return this.doActionCall(action, args, session);
        }
        return cb(null, value);
      }.bind(this));
    } else {
      return this.doActionCall(action, args, session);
    }
  }.bind(this));
};

// Service.prototype.getApiInputKeyAccessFreq = function(key, now, accessFreq, accessTime) {
//   if (accessFreq == null || accessTime == null) {
//     redisClient.hmset(key, 'af', 0, 'at', now);
//     return 0;
//   }

//   if (now - accessTime < 1000) {
//     accessFreq++;
//     redisClient.hmset(key, 'af', accessFreq);
//     return 0;
//   } else if (now - accessTime < 2000) {
//     redisClient.hmset(key, 'af', 0, 'at', now);
//     return accessFreq;
//   } else {
//     redisClient.hmset(key, 'af', 0, 'at', now);
//     return 0;
//   }
// };

//apiCache will not check httpHeaders as api's cache value
Service.prototype.getValueFromAPICache = function(actionName, timeout, args, callback) {
  if (args.httpHeaders != null) {
    if (args.httpHeaders['content-type'] === 'application/bson' || args.httpHeaders['content-length'] == null || args.httpHeaders['content-length'] > 2048) {
      return callback(null, null, null);
    }
  }

  var hashString = hashKey.getInputHashKey(this.device.deviceID, this.serviceID, actionName, {input: args.input});
  var freq = null;
  //af: key access frequency, at: key access time
  redisAPI.client.hmget(hashString, 'deviceID', 'value', function(err, results) {
    if (err) {
      LOG.E(new CHError('REDIS_CLIENT_ERROR', err.message));
      return callback(null, null, null);
    }
    if (results[0] == null || results[1] == null) return callback(null, null, null);
    // in case of hash collision, run the slowest path
    if (results[0] != null && results[0] !== this.device.deviceID) return callback(null, null, null);

    //now we always return null freq 20180724
    return callback(null, JSON.parse(results[1]), freq);
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
            // TODO: there should be no update event emission if hashCode collision occurs
            // in this case, collided subscribers won't receive any update message
            // we need to detect hash Collision when we do event subscription
            _this.updateStateFromAction(action, args, output, function(updated) {});
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
          // TODO: there should be no update event emission if hashCode collision occurs
          // in this case, collided subscribers won't receive any update message
          // we need to detect hash Collision when we do event subscription
          _this.updateStateFromAction(action, args, output, function(updated) {
            // disable this kind of wss publish code for now, see TODO comments in wss.js code
            // if (options.apiCache === true && options.wsServer === true && action.apiCache != null && updated === true) {
            //   var hashString = hashKey.getInputHashKey(this.device.deviceID, this.serviceID, action.name, {input: args.input});

            //   LOG.I('value invalidated');
            //   redisClient.sinter('keyset:' + hashString, 'subset', function(err, results) {
            //     wss.publish(results, hashString, JSON.stringify(output));
            //   });
            // }
          });
          return cb(null, output);
        });
      });
    } catch (err) {
      return cb(new DeviceError('DEVICE_INVOKE_EXCEPTION'), toJSONSafeFault(err));
    }
  }
};

Service.prototype.setEventSubscription = function(subscribe, unsubscribe) {
  this.subscribe = subscribe;
  this.unsubscribe = unsubscribe;
};

// event sub / unsub is only enabled when apiCache CLI option is enabled and a action has apiCache flag
Service.prototype.subscribeEvent = function(actionName, input, inputKey, callback) {
  var action = this.actions[actionName];

  if (action == null) {
    return callback(new CHError('ACTION_NOT_FOUND', actionName));
  }
  if (input == null) {
    return callback(new CHError('INPUT_NOT_FOUND'));
  }
  if (action.invoke == null) {
    return callback(new DeviceError('ACTION_NOT_IMPLEMENTED', actionName));
  }

  if (options.apiCache !== true || action.apiCache == null) {
    return callback(new DeviceError('EVENT_SUBSCRIPTION_FAIL'));
  }

  this.validateActionCall(action, input, true, function(err, data) {
    if (err) {
      if (data && data.fault) {
        return callback(err, data.fault);
      }
      return callback(err, data);
    }
    // here we assume the key always exists, no matter it is available in redis cache or not
    return callback(null);
  }.bind(this));
};

Service.prototype.unsubscribeEvent = function(actionName, input, inputKey, callback) {
  var action = this.actions[actionName];

  if (action == null) {
    return callback(new CHError('ACTION_NOT_FOUND', actionName));
  }
  if (input == null) {
    return callback(new CHError('INPUT_NOT_FOUND'));
  }
  if (action.invoke == null) {
    return callback(new DeviceError('ACTION_NOT_IMPLEMENTED', actionName));
  }

  if (options.apiCache !== true || action.apiCache == null) {
    return callback(new DeviceError('EVENT_SUBSCRIPTION_FAIL'));
  }

  this.validateActionCall(action, input, true, function(err, data) {
    if (err) {
      if (data && data.fault) {
        return callback(err, data.fault);
      }
      return callback(err, data);
    }
    // here we assume the key always exists, no matter it is available in redis cache or not
    return callback(null);
  }.bind(this));
};

module.exports = Service;
