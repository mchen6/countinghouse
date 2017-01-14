var events            = require('events');
var util              = require('util');
var validator         = require('./validator');
var LOG               = require('./logger');
var options           = require('./cli-options');
var CdifError         = require('./cdif-error').CdifError;
var DeviceError       = require('./cdif-error').DeviceError;
var Domain            = require('domain');
var redis             = require("redis");
var stringHash        = require('string-hash');
var redisClient       = redis.createClient(options.redisUrl);

redisClient.on('error', function (err) {
  LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
});

function Service(device, serviceID, spec) {
  this.device      = device;
  this.serviceID   = serviceID;
  this.serviceType = spec.serviceType;
  this.actions     = {};
  this.states      = {};

  this.updateSpec(spec);
  this.updateStateFromAction = this.updateStateFromAction.bind(this);
  this.apiRefreshingKeys = {}; // the buffer holding api key refreshing state, only when apiCache timeout and query device module it would be set to true
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
      this.actions[i].realPrice = 0;
      this.actions[i].apiCache  = null;
      this.actions[i].apiLog    = false;

      if (action.realPrice != null) {
        this.actions[i].realPrice = action.realPrice;
      }
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
              LOG.DE(this.device, new CdifError('SCHEMA_COMPILE_ERROR', e.message));
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
                LOG.DE(this.device, new CdifError('SCHEMA_COMPILE_ERROR', e.message));
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
    callback(new CdifError('SET_SERVICE_STATE_ERROR', errorMessage));
  } else {
    this.emit('serviceevent', updated, this.device.deviceID, this.serviceID, data);
    callback(null);
  }
};

Service.prototype.updateStateFromAction = function(action, input, output, callback) {


  //BELOW CODE MADE OBSOLETE WHEN WE ADD API CACHE FEATURE 20170103
  // var updated = false;
  // var data = {};

  // for (var i in input) {
  //   var argument = action.args[i];
  //   if (argument == null) break;
  //   var stateVarName = argument.relatedStateVariable;
  //   if (stateVarName == null) break;
  //   if (argument.direction === 'in') {
  //     if (this.states[stateVarName].variable.sendEvents === true) {
  //       if (this.states[stateVarName].value !== input[i]) {
  //         data[stateVarName] = input[i];
  //         updated = true;
  //       }
  //     }
  //     this.states[stateVarName].value = input[i];
  //   }
  // }

  // for (var i in output) {
  //   var argument = action.args[i];
  //   if (argument == null) break;
  //   var stateVarName = argument.relatedStateVariable;
  //   if (stateVarName == null) break;
  //   if (argument.direction === 'out') {
  //     if (this.states[stateVarName].variable.sendEvents === true) {
  //       if (this.states[stateVarName].value !== output[i]) {
  //         data[stateVarName] = output[i];
  //         updated = true;
  //       }
  //     }
  //     this.states[stateVarName].value = output[i];
  //   }
  // }

  if (options.enableAPICache === true && action.apiCache != null) {
    var deviceID  = this.device.deviceID;
    var serviceID = this.serviceID;

    var inputKey       = deviceID + '#' + serviceID + '#' + action.name + '#' + JSON.stringify(input);
    var hashCode       = stringHash(inputKey);
    var outputString   = JSON.stringify(output);
    var outputHashCode = stringHash(outputString);

    redisClient.hmget(hashCode, 'deviceID', 'valueHash', function(err, results) {
      if (err) {
        LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
        return callback(false);
      }
      if ((results[0] != null && results[0] !== deviceID)) {
        LOG.I('hash collision for input key: ' + inputKey);
        return callback(false); // hash collision
      }

      if (results[0] == null) {
        //TODO: do not allow more than 1 request create cache entry, multiple creation requests can happen when we flush redis cache
        redisClient.hmset(hashCode, 'deviceID', deviceID, 'value', outputString, 'valueHash', outputHashCode, 'timestamp', Date.now(), function(err) {
          this.apiRefreshingKeys[hashCode.toString()] = false;
          if (err) {
            LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
            return callback(false);
          }
          LOG.I('api cache created for input key: ' + inputKey);
          return callback(true);
        }.bind(this));
      } else {
        // purposely use string to number compare, it seems everything returned from redis is string
        if(results[1] != outputHashCode) {
          redisClient.hmset(hashCode, 'value', outputString, 'valueHash', outputHashCode, 'timestamp', Date.now(), function(err) {
            this.apiRefreshingKeys[hashCode.toString()] = false;
            if (err) {
              LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
              return callback(false);
            }
            LOG.I('api cache updated for input key: ' + inputKey);
            return callback(true);
          }.bind(this));
        } else {
          // in case of error or not, return non-update anyway
          redisClient.hmset(hashCode, 'timestamp', Date.now(), function(err) {
            if (err) LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
            this.apiRefreshingKeys[hashCode.toString()] = false;
            return callback(false);
          }.bind(this));
        }
      }
    }.bind(this));
  }
  return callback(false);
};

Service.prototype.validateActionCall = function(action, arguments, isInput, callback) {
  var argList   = action.args;
  var failed    = false;
  var error     = null;
  var errorData = null;

  if (arguments == null) {
    return callback(new CdifError('ARGUMENTS_INVALID'), null);
  }

  // argument keys must match spec
  if (isInput) {
    for (var i in argList) {
      if (argList[i].direction === 'in') {
        if (arguments[i] === undefined) {
          failed = true;

          error = new CdifError('DATA_VALIDATION_FAIL');
          errorData = {fault: {reason: '校验失败', info: '未找到输入参数'}};
          break;
        }
      }
    }
  } else {
    for (var i in argList) {
      if (argList[i].direction === 'out') {
        if (arguments[i] === undefined) {
          failed = true;
          error = new CdifError('DATA_VALIDATION_FAIL');
          errorData = {fault: {reason: '校验失败', info: '未找到输出参数'}};
          break;
        }
      }
    }
  }
  if (failed) {
    return callback(error, errorData);
  }

  //disable input validation by default but we still do output validation
  if (options.doDataValidation !== true && isInput === true) {
    return callback(null, null);
  }
  // validate data
  for (var i in arguments) {
    var name = argList[i].relatedStateVariable;
    var stateVar = this.states[name].variable;

    if (isInput && argList[i].direction === 'out') {
      // only check out args on call return
      continue;
    } else {
      validator.validate(i, stateVar, arguments[i], function(err) {
        if (err) {
          error = new CdifError('DATA_VALIDATION_FAIL');
          //TODO: define this error reason msg in locale
          errorData = {fault: {reason: '校验失败', info: err.message}};
          failed = true;
        }
      });
    }
    if (failed) break;
  }
  callback(error, errorData);
};

Service.prototype.invokeAction = function(actionName, input, session) {
  var action = this.actions[actionName];

  if (action == null) {
    return session.callback(new CdifError('ACTION_NOT_FOUND', actionName), null);
  }
  if (input == null) {
    return session.callback(new CdifError('INPUT_NOT_FOUND'), null);
  }
  if (action.invoke == null) {
    return session.callback(new DeviceError('ACTION_NOT_IMPLEMENTED', actionName), null);
  }

  if (options.enableAPIMonitor === true) {
    if (action.realPrice > 0) {
      if (session.freeAPICount != null &&
          session.freeAPICount[this.serviceID] != null &&
          session.freeAPICount[this.serviceID][actionName] != null &&
          session.freeAPICount[this.serviceID][actionName] <= 0
         )
      {
        if (session.balance < action.realPrice) {
          return session.callback(new CdifError('NOT_ENOUGH_USER_BALANCE', actionName), null);
        }
      }
    }
    session.serviceID  = this.serviceID;
    session.actionName = actionName;

    if (action.apiLog === true) {
      session.apiLog = true;
    }
  }

  this.validateActionCall(action, input, true, function(err, data) {
    if (err) {
      if (data && data.fault) {
        return session.callback(err, data.fault);
      }
      return session.callback(err, null);
    }

    if (options.enableAPICache === true && action.apiCache != null) {
      this.getValueFromAPICache(actionName, action.apiCache, input, function(err, value) {
        if (err != null || value == null) {
          return this.doActionCall(action, input, session);
        }
        return session.callback(null, value);
      }.bind(this));
    } else {
      return this.doActionCall(action, input, session);
    }
  }.bind(this));
};



Service.prototype.getValueFromAPICache = function(actionName, timeout, input, callback) {
  var deviceID  = this.device.deviceID;
  var serviceID = this.serviceID;

  var inputKey = deviceID + '#' + serviceID + '#' + actionName + '#' + JSON.stringify(input);
  var hashCode = stringHash(inputKey);

  redisClient.hmget(hashCode, 'deviceID', 'value', 'timestamp', function(err, results) {
    if (err) {
      LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
      return callback(err, null);
    }

    //detect hash collision
    var empty = false;
    for (var index = 0; index < results.length; index++) {
      if (results[index] == null) {
        empty = true;
        break;
      }
    }
    if (empty === true) return callback(null, null);
    // in case of hash collision, run the slowest path
    if (results[0] !== deviceID) return callback(null, null);

    var cacheTimeStamp = results[2];
    if (Date.now() - cacheTimeStamp > timeout) {
      if (this.apiRefreshingKeys[hashCode.toString()] == null || this.apiRefreshingKeys[hashCode.toString()] === false) {
        LOG.I('value expired for input key, do slow action call to get new value: ' + inputKey);
        this.apiRefreshingKeys[hashCode.toString()] = true;
        return callback(null, null);
      }
    }
    // if timer not expired, or we are already refreshing a key, return cached value in this request
    // LOG.I('get value from api cache for input key: ' + inputKey);
    return callback(null, JSON.parse(results[1]));
  }.bind(this));
};

Service.prototype.doActionCall = function(action, input, session) {
  var unsafeDomain = Domain.create();
  unsafeDomain.on('error', function(err) {
    return session.callback(new DeviceError('DEVICE_INVOKE_EXCEPTION', err.message), null);
  });

  unsafeDomain.run(function() {
    action.invoke(input, function(err, output) {
      if (err) {
        //TODO: validate the content of fault object according to its optional fault definition in device spec
        // API's formal fault definition, which can be in either simple or complex type, would make it more conformant to WSDL
        var error = null;
        if (err instanceof DeviceError || err instanceof CdifError) {
          error = err;
        } else {
          error = new DeviceError('DEVICE_INVOKE_FAIL', err.message);
        }
        if (output && output.fault) {
          return session.callback(error, output.fault);
        }
        return session.callback(error, null);
      }
      this.validateActionCall(action, output, false, function(error, data) {
        if (error) {
          if (data && data.fault) {
            return session.callback(error, data.fault);
          }
          return session.callback(error, null);
        }

        this.updateStateFromAction(action, input, output, function(updated) {
          //TODO: pub to redis to make this event global, not just local to this cdif instance
          if (options.enableAPICache === true && action.apiCache != null && updated === true) {
            this.emit('serviceevent', updated, this.device.deviceID, this.serviceID, action.name, input, output);
          }
        }.bind(this));

        session.callback(null, output);
      }.bind(this));
    }.bind(this));
  }.bind(this));
};

Service.prototype.setEventSubscription = function(subscribe, unsubscribe) {
  this.subscribe = subscribe;
  this.unsubscribe = unsubscribe;
};

Service.prototype.subscribeEvent = function(onChange, callback) {
  if (this.subscribe) {
    this.subscribe(onChange, function(err) {
      if (err) {
        return callback(new DeviceError('EVENT_SUBSCRIPTION_FAIL', err.message));
      }
      callback(null);
    });
  } else {
    // we can still send state change events upon action call
    callback(null);
  }
};

Service.prototype.unsubscribeEvent = function(callback) {
  if (this.unsubscribe) {
    this.unsubscribe(function(err) {
      if (err) {
        return callback(new DeviceError('EVENT_UNSUBSCRIPTION_FAIL', err.message));
      }
      callback(null);
    });
  } else {
    callback(null);
  }
};

module.exports = Service;
