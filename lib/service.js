var events            = require('events');
var util              = require('util');
var validator         = require('./validator');
var LOG               = require('./logger');
var options           = require('./cli-options');
var CdifError         = require('./cdif-error').CdifError;
var DeviceError       = require('./cdif-error').DeviceError;
var hashKey           = require('./hash-key');
var Domain            = require('domain');
var redis             = require("redis");
var stringHash        = require('string-hash');
var redisClient       = redis.createClient(options.redisUrl, {db: 5});

var wss               = require('./routes/wss');

redisClient.on('error', function (err) {
  if (options.debug !== true) LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
});

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
  if (options.apiCache === true && action.apiCache != null) {
    var hashString       = hashKey.getInputHashKey(this.device.deviceID, this.serviceID, action.name, input);
    var outputString     = JSON.stringify(output);

    redisClient.hmget(hashString, 'deviceID', function(err, results) {
      if (err) {
        LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
        return callback(false);
      }
      if ((results[0] != null && results[0] !== this.device.deviceID)) {
        LOG.I('hash collision for input key: ' + this.device.deviceID + '#' + this.serviceID + '#' + action.name + '#' + JSON.stringify(input));
        return callback(false); // hash collision
      }

      //TODO: do not allow more than 1 request create cache entry, multiple creation requests can happen when we flush redis cache
      if (results[0] == null) {
        redisClient.hmset(hashString, 'deviceID', this.device.deviceID, 'value', outputString, function(err) {
          if (err) {
            LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
            return callback(false);
          }
          // LOG.I('api cache created for input key: ' + this.device.deviceID + '#' + this.serviceID + '#' + action.name + '#' + JSON.stringify(input));
          redisClient.pexpire(hashString, action.apiCache); // set key auto-expire time, no need to check error
          return callback(false); //no longer return updated event to caller
        }.bind(this));
      }
      //  else {
      //   if(results[1] !== outputHashString) {
      //     redisClient.hmset(hashString, 'value', outputString, 'valueHash', outputHashString, function(err) {
      //       if (err) {
      //         LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
      //         return callback(false);
      //       }
      //       LOG.I('api cache updated for input key: ' + this.device.deviceID + '#' + this.serviceID + '#' + action.name + '#' + JSON.stringify(input));
      //       redisClient.pexpire(hashString, action.apiCache); // set key auto-expire time, no need to check error
      //       return callback(true);
      //     }.bind(this));
      //   } else {
      //     // in case of error or not, return non-update anyway
      //     redisClient.hmset(hashString, 'timestamp', Date.now(), function(err) {
      //       if (err) LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
      //       return callback(false);
      //     }.bind(this));
      //   }
      // }
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
    return callback(new DeviceError('ARGUMENTS_INVALID'), null);
  }

  // argument keys must match spec
  if (isInput) {
    for (var i in argList) {
      if (argList[i].direction === 'in') {
        if (arguments[i] === undefined) {
          failed = true;

          error = new DeviceError('DATA_VALIDATION_FAIL');
          errorData = {fault: {reason: '未找到输入参数', info: ''}};
          break;
        }
      }
    }
  } else {
    for (var i in argList) {
      if (argList[i].direction === 'out') {
        if (arguments[i] === undefined) {
          failed = true;
          error = new DeviceError('DATA_VALIDATION_FAIL');
          errorData = {fault: {reason: '未找到输出参数', info: ''}};
          break;
        }
      }
    }
  }
  if (failed) {
    return callback(error, errorData);
  }

  //disable input validation by default but we still do output validation
  // if (options.doDataValidation !== true && isInput === true) {
  //   return callback(null, null);
  // }
  // validate data
  for (var i in arguments) {
    var name = argList[i].relatedStateVariable;
    var stateVar = this.states[name].variable;

    if (isInput && argList[i].direction === 'out') {
      // only check out args on call return
      continue;
    } else {
      validator.validate(i, stateVar, arguments[i], function(errMsg, errInfo) {
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

  if (options.apiMonitor === true) {
    if (action.realPrice > 0) {
      session.realPrice = action.realPrice;
      if (session.apiRemainCount <= 0 && session.balance < action.realPrice) {
        return session.callback(new CdifError('NOT_ENOUGH_USER_BALANCE', actionName), null);
      }
    }
    //to log api details in session code
    if (action.apiLog === true) session.apiLog = true;
  }

  this.validateActionCall(action, input, true, function(err, data) {
    if (err) {
      if (data && data.fault) {
        return session.callback(err, data.fault);
      }
      return session.callback(err, null);
    }

    if (options.apiCache === true && action.apiCache != null) {
      this.getValueFromAPICache(actionName, action.apiCache, input, function(err, value, freq) {
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
        if (freq != null) session.apiKeyFreq = freq;

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

// Service.prototype.getApiInputKeyAccessInfo = function(key) {
//   // calculate key access frequency
//   if (this.apiKeyStats[key] == null) {
//     this.apiKeyStats[key] = {};
//     this.apiKeyStats[key].accessTime = [];
//     this.apiKeyStats[key].accessFreq = 0;
//     this.apiKeyStats[key].refreshing = false;
//   }

//   var now = Date.now();

//   if (this.apiKeyStats[key].accessTime.length === 0) {
//     this.apiKeyStats[key].accessTime.push(now);
//     return 0;
//   }

//   if (now - this.apiKeyStats[key].accessTime[0] >= 1000) {
//     this.apiKeyStats[key].accessFreq = this.apiKeyStats[key].accessTime.length - 1;
//     this.apiKeyStats[key].accessTime = [];
//   } else {
//     this.apiKeyStats[key].accessTime.push(now);
//   }
//   return this.apiKeyStats[key].accessFreq;
// };

Service.prototype.getApiInputKeyAccessFreq = function(key, now, accessFreq, accessTime) {
  if (accessFreq == null || accessTime == null) {
    redisClient.hmset(key, 'af', 0, 'at', now);
    return 0;
  }

  if (now - accessTime < 1000) {
    accessFreq++;
    redisClient.hmset(key, 'af', accessFreq);
    return 0;
  } else if (now - accessTime < 2000) {
    redisClient.hmset(key, 'af', 0, 'at', now);
    return accessFreq;
  } else {
    redisClient.hmset(key, 'af', 0, 'at', now);
    return 0;
  }
};

Service.prototype.getValueFromAPICache = function(actionName, timeout, input, callback) {
  var hashString = hashKey.getInputHashKey(this.device.deviceID, this.serviceID, actionName, input);
  var freq = null;

  //af: key access frequency, at: key access time
  redisClient.hmget(hashString, 'deviceID', 'value', function(err, results) {
    if (err) {
      LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
      return callback(null, null, null);
    }
    if (results[0] == null || results[1] == null) return callback(null, null, null);
    // in case of hash collision, run the slowest path
    if (results[0] != null && results[0] !== this.device.deviceID) return callback(null, null, null);


    // var now = Date.now();
    // var cacheTimeStamp = results[2];

    // if (options.wsServer === true) {
    //   var af = results[3];
    //   var at = results[4];
    //   freq = this.getApiInputKeyAccessFreq(hashString, now, af, at);
    // }

    // if (now - cacheTimeStamp > timeout) {
    //   LOG.I('value expired for input key, do slow action call to get new value: ' + this.device.deviceID + '#' + this.serviceID + '#' + actionName + '#' + JSON.stringify(input));
    //   return callback(null, null, freq);
    // }
    // if timer not expired, return cached value in this request
    // LOG.I('get value from api cache for input key: ' + inputKey);

    //now we always return null freq 20180724
    return callback(null, JSON.parse(results[1]), freq);
  }.bind(this));
};

Service.prototype.doActionCall = function(action, input, session) {
  var unsafeDomain = Domain.create();
  unsafeDomain.on('error', function(err) {
    return session.callback(new DeviceError('DEVICE_INVOKE_EXCEPTION', err.message), null);
  });

  unsafeDomain.run(function() {
    var args = {};
    // prepare session and httpHeaders object ref for callee
    args.ctx = session;
    // for non-local http call req is available in session obj, for local calls req is null, see session creation code in routes/user.js and service-client.js
    if (session.req != null) {
      args.httpHeaders = session.req.headers;
    }

    if (options.allowSimpleType !== true) {
      // in case simple type is not allowed, the incoming api call must contain 'input' field, see validator.js
      args.input = input.input; // this can be either object or array type, but not simple type
    } else {
      for (var i in input) {
        args[i] = input[i];
      }
    }
    action.invoke(args, function(err, output) {
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
        // TODO: there should be no update event emission if hashCode collision occurs
        // in this case, collided subscribers won't receive any update message
        // we need to detect hash Collision when we do event subscription
        this.updateStateFromAction(action, input, output, function(updated) {
          if (options.apiCache === true && options.wsServer === true && action.apiCache != null && updated === true) {
            var hashString = hashKey.getInputHashKey(this.device.deviceID, this.serviceID, action.name, input);

            LOG.I('value invalidated');
            redisClient.sinter('keyset:' + hashString, 'subset', function(err, results) {
              wss.publish(results, hashString, JSON.stringify(output));
            });

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

// event sub / unsub is only enabled when apiCache CLI option is enabled and a action has apiCache flag
Service.prototype.subscribeEvent = function(actionName, input, inputKey, callback) {
  var action = this.actions[actionName];

  if (action == null) {
    return callback(new CdifError('ACTION_NOT_FOUND', actionName));
  }
  if (input == null) {
    return callback(new CdifError('INPUT_NOT_FOUND'));
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
      return callback(err);
    }
    // here we assume the key always exists, no matter it is available in redis cache or not
    return callback(null);
  }.bind(this));

  // if (this.subscribe) {
  //   this.subscribe(onChange, function(err) {
  //     if (err) {
  //       return callback(new DeviceError('EVENT_SUBSCRIPTION_FAIL', err.message));
  //     }
  //     callback(null);
  //   });
  // } else {
  //   // we can still send state change events upon action call
  //   callback(null);
  // }
};

Service.prototype.unsubscribeEvent = function(actionName, input, inputKey, callback) {
  var action = this.actions[actionName];

  if (action == null) {
    return callback(new CdifError('ACTION_NOT_FOUND', actionName));
  }
  if (input == null) {
    return callback(new CdifError('INPUT_NOT_FOUND'));
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
      return callback(err);
    }
    // here we assume the key always exists, no matter it is available in redis cache or not
    return callback(null);
  }.bind(this));


  // if (this.unsubscribe) {
  //   this.unsubscribe(function(err) {
  //     if (err) {
  //       return callback(new DeviceError('EVENT_UNSUBSCRIPTION_FAIL', err.message));
  //     }
  //     callback(null);
  //   });
  // } else {
  //   callback(null);
  // }
};

module.exports = Service;
