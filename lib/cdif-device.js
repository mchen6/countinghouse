var events      = require('events');
var util        = require('util');
var url         = require('url');
var parser      = require('json-schema-ref-parser');
var Service     = require('./service');
var ConnMan     = require('./connect');
var validator   = require('./validator');
var LOG         = require('./logger');
var options     = require('./cli-options');
var Session     = require('./session');
var CdifError   = require('./cdif-error').CdifError;
var DeviceError = require('./cdif-error').DeviceError;
var redis       = require("redis");
var RateLimiter = require("rolling-rate-limiter");

var redisClient = redis.createClient(options.redisUrl, {db: 9});

redisClient.on('error', function (err) {
  if (options.isDebug !== true) LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
});


//warn: try not add event listeners in this class
function CdifDevice(spec) {
  this.deviceID        = '';
  this.user            = '';
  this.secret          = '';
  this.connectionState = 'disconnected';  // enum of disconnected, connected, & redirecting
  this.connMan     = new ConnMan(this);
  this.schemaDoc   = this.getDeviceRootSchema();

  this.spec = spec;
  this.initServices();
  this.createRateLimiter();

  this.getDeviceSpec          = this.getDeviceSpec.bind(this);
  this.connect                = this.connect.bind(this);
  this.disconnect             = this.disconnect.bind(this);
  this.getHWAddress           = this.getHWAddress.bind(this);
  this.deviceControl          = this.deviceControl.bind(this);
  this.subscribeDeviceEvent   = this.subscribeDeviceEvent.bind(this);
  this.unsubscribeDeviceEvent = this.unsubscribeDeviceEvent.bind(this);
}

util.inherits(CdifDevice, events.EventEmitter);


CdifDevice.prototype.setAction = function(serviceID, actionName, action) {
  if (action === null || typeof(action) !== 'function') {
    return LOG.DE(this, new DeviceError('SET_INCORRECT_ACTION_TYPE', serviceID, actionName));
  }

  var service = this.services[serviceID];
  if (service != null && service.actions != null && service.actions[actionName] != null) {
    return service.actions[actionName].invoke = action.bind(this);
  }

  if (service == null)                     return LOG.DE(this, new DeviceError('CANNOT_SET_ACTION_SERVICE_OBJ_NOT_EXIST', serviceID, actionName));
  if (service.actions == null)             return LOG.DE(this, new DeviceError('CANNOT_SET_ACTION_ACTION_LIST_NOT_EXIST', serviceID, actionName));
  if (service.actions[actionName] == null) return LOG.DE(this, new DeviceError('CANNOT_SET_ACTION_OBJ_NOT_EXIST', serviceID, actionName));
  
  return LOG.DE(this, new DeviceError('CANNOT_SET_ACTION', serviceID, actionName));
};

CdifDevice.prototype.initServices = function() {
  if (typeof(this.spec) !== 'object' || this.spec.device == null || this.spec.device.serviceList == null) {
    return LOG.DE(this, new DeviceError('NO_VALID_DEVICE_SPEC', this.constructor.name));
  }

  var serviceList = this.spec.device.serviceList;

  if (!this.services) {
    this.services = new Object();
  }
  for (var i in serviceList) {
    var service_spec = serviceList[i];
    if (!this.services[i]) {
      this.services[i] = new Service(this, i, service_spec);
    } else {
      this.services[i].updateSpec(service_spec);
    }
  }
};

CdifDevice.prototype.getDeviceSpec = function(session) {
  if (this.spec === null) {
    return session.callback(new CdifError('CANNOT_GET_DEVICE_SPEC'), null);
  }
  session.callback(null, this.spec);
};

// this api may be called by device module or interface, so session could be a real Session obj or a normal callback
CdifDevice.prototype.getServiceStates = function(serviceID, session) {
  if (session == null) {
    return LOG.DE(this, new DeviceError('GET_SERVICE_STATE_FAIL_INVALID_CALLBACK'));
  }
  var callback = null;
  if (session instanceof Session) {
    callback = session.callback;
  } else if (typeof(session) === 'function') {
    callback = session;
  } else {
    return LOG.DE(this, new DeviceError('GET_SERVICE_STATE_FAIL_INVALID_CALLBACK'));
  }

  var service = this.services[serviceID];
  if (service == null) {
    return callback(new DeviceError('SERVICE_NOT_FOUND', serviceID), null);
  }
  service.getServiceStates(callback);
};

CdifDevice.prototype.setServiceStates = function(serviceID, values, callback) {
  if (callback == null || typeof(callback) !== 'function') {
    return LOG.DE(this, new CdifError('GET_SERVICE_STATE_FAIL_INVALID_CALLBACK'));
  }
  var service = this.services[serviceID];
  if (service == null) {
    var error = new DeviceError('SERVICE_NOT_FOUND', serviceID);
    LOG.DE(this, error);
    return callback(error);
  }

  service.setServiceStates(values, callback);
};

// now support only one user / pass pair
// TODO: check if no other case than oauth redirect flow needs to temporarily unset connected flag
CdifDevice.prototype.connect = function(user, pass, callback) {
  if (this.connectionState === 'redirecting') {
    return callback(new CdifError('DEVICE_IN_ACTION'), null, null);
  }

  if (this.connectionState === 'connected') {
    return this.connMan.verifyConnect(user, pass, callback);
  }
  return this.connMan.processConnect(user, pass, callback);
};

CdifDevice.prototype.disconnect = function(session) {
  return this.connMan.processDisconnect(session.callback);
};

CdifDevice.prototype.getHWAddress = function(callback) {
  if (this._getHWAddress && typeof(this._getHWAddress) === 'function') {
    this._getHWAddress(function(error, data) {
      if (error) {
        var err = new DeviceError('GET_HARDWARE_ADDR_FAIL', error.message);
        LOG.DE(this, err);
        return callback(err, null);
      }
      callback(null, data);
    }.bind(this));
  } else {
    callback(null, null);
  }
};

CdifDevice.prototype.deviceControl = function(serviceID, actionName, args, session) {
  var service = this.services[serviceID];
  if (service == null) {
    return session.callback(new DeviceError('SERVICE_NOT_FOUND', serviceID), null);
  }

  if (this.rateLimiter == null) {
    service.invokeAction(actionName, args, session);
  } else {
    this.rateLimiter(this.deviceID, function(err, timeLeft, actionsLeft) {
      if (err) {
        // redis failed, allow action
        service.invokeAction(actionName, args, session);
      } else if (timeLeft) {
        // limit was exceeded, action should not be allowed, TODO: update to HTTP statusCode 429
        return session.callback(new DeviceError('DENY_DEVICE_ACCESS'), null);
      } else {
        // limit was not exceeded, action should be allowed
        service.invokeAction(actionName, args, session);
      }
    }.bind(this));
  }
};

CdifDevice.prototype.invokeDeviceCallback = function(path, data, session) {
  if (this._deviceCallbackHandler == null || typeof(this._deviceCallbackHandler) !== 'function') {
    return session.callback(new DeviceError('DEVICE_CALLBACK_NOT_AVAILABLE'), null);
  }
  this._deviceCallbackHandler(path, data, function(err, output) {
    if (err != null) {
      var error = null;
      if (err instanceof DeviceError || err instanceof CdifError) {
        error = err;
      } else {
        error = new DeviceError('DEVICE_INVOKE_CALLBACK_FAIL', err.message);
      }
      return session.callback(error, output);
    }
    return session.callback(null, output);
  });
};

CdifDevice.prototype.updateDeviceSpec = function(newSpec) {
  validator.validateDeviceSpec(newSpec, function(error) {
    if (error) {
      return LOG.DE(this, new DeviceError('DEVICE_SPEC_UPDATE_FAIL', error.message, JSON.stringify(newSpec)));
    }
    this.spec = newSpec;
    this.initServices();
  }.bind(this));
};

CdifDevice.prototype.setEventSubscription = function(serviceID, subscribe, unsubscribe) {
  if (typeof(subscribe) !== 'function' || typeof(unsubscribe) !== 'function') {
    return LOG.DE(this, new DeviceError('EVENT_SUBSCRIBER_TYPE_ERROR'));
  }
  var service = this.services[serviceID];
  if (service) {
    service.setEventSubscription(subscribe.bind(this), unsubscribe.bind(this));
  } else {
    LOG.DE(this, new DeviceError('SERVICE_NOT_FOUND', serviceID));
  }
};

CdifDevice.prototype.subscribeDeviceEvent = function(serviceID, actionName, input, inputKey, callback) {
  var service = this.services[serviceID];
  if (service == null) {
    return callback(new DeviceError('SERVICE_NOT_FOUND', serviceID));
  }

  service.subscribeEvent(actionName, input, inputKey, callback);
  // , function(err) {
  //   if (!err) {
  //     service.addListener('serviceevent', subscriber.publish);
  //   }
  //   session.callback(err);
  // });
};

CdifDevice.prototype.unsubscribeDeviceEvent = function(serviceID, actionName, input, inputKey, callback) {
  var service = this.services[serviceID];
  if (service == null) {
    return callback(new DeviceError('SERVICE_NOT_FOUND', serviceID));
  }

  service.unsubscribeEvent(actionName, input, inputKey, callback);
  // service.removeListener('serviceevent', subscriber.publish);
  // if (service.listeners('serviceevent').length === 0) {
  //   service.unsubscribeEvent(session.callback);
  // } else {
  //   session.callback(null);
  // }
};

// get device root url string
CdifDevice.prototype.getDeviceRootUrl = function(session) {
  if (this.spec.device.devicePresentation !== true || typeof(this._getDeviceRootUrl) !== 'function') {
    return session.callback(new DeviceError('PRESENTATION_NOT_SUPPORTED'), null);
  }
  this._getDeviceRootUrl(function(err, data) {
    if (err) {
      return session.callback(new DeviceError('GET_DEVICE_ROOTURL_FAIL', err.message), null);
    }
    try {
      url.parse(data);
    } catch(e) {
      return session.callback(new DeviceError('PARSE_DEVICE_ROOTURL_FAIL', e.message), null);
    }
    session.callback(null, data);
  });
};

// get device root schema document object, must be sync
CdifDevice.prototype.getDeviceRootSchema = function() {
  if (typeof(this._getDeviceRootSchema) !== 'function') return null;
  try {
    return this._getDeviceRootSchema();
  } catch (e) {
    LOG.DE(this, new DeviceError('GET_DEVICE_SCHEMADOC_FAIL', e.message));
    return null;
  }
};

// resolve JSON pointer based schema ref and return the schema object associated with it
// For now we only support single doc schema to avoid security risks when resolving external refs
CdifDevice.prototype.resolveSchemaFromPath = function(path, self, callback) {
  var schemaDoc = this.schemaDoc;
  if (schemaDoc == null || typeof(schemaDoc) !== 'object') {
    return callback(new DeviceError('INVALID_DEVICE_SCHEMADOC'), self, null);
  }
  if (path === '/') {
    return callback(null, self, schemaDoc);
  }

  var doc = null;
  try {
    doc = JSON.parse(JSON.stringify(schemaDoc));
  } catch(e) {
    return callback(new DeviceError('INVALID_DEVICE_SCHEMADOC', e.message), self, null);
  }

  var ref;

  // for now we dont support fragment based pointer
  // because it won't be able to be resolved
  if (/^\/./.test(path) === false) {
    return callback(new CdifError('INVALID_JSON_POINTER'), self, null);
  }

  ref = '#' + path;

  doc.__ =  {
    "$ref": ref
  };

  parser.dereference(doc, {$refs: {external: false}}, function(err, out) {
    if (err) {
      return callback(new CdifError('POINTER_DEREF_ERROR', err.message), self, null);
    }
    callback(null, self, out.__);
  });
};

CdifDevice.prototype.setOAuthAccessToken = function(params, session) {
  if (typeof(this._setOAuthAccessToken) === 'function') {
    this._setOAuthAccessToken(params, function(err) {
      if (err) {
        return session.callback(new CdifError(err.message));
      }
      this.connectionState = 'connected';
      session.callback(null);
    }.bind(this));
  } else {
    session.callback(new CdifError('CANNOT_SET_OAUTH_ACCESS_TOKEN_INVALID_INTERFACE'));
  }
};

CdifDevice.prototype.createRateLimiter = function() {
  this.rateLimiter = null;

  if (options.isDebug === true) return; // under debug mode we have no redis support and we dont do rate limiting

  if (this.spec.device && this.spec.device.rateLimit != null) {
    var limit = this.spec.device.rateLimit;
    if (typeof(limit) !== 'number' || (limit % 1) !== 0 || limit <= 0) return; // limit must be > 0
    this.rateLimiter = RateLimiter({
      redis: redisClient,             // use single client instance to handle all devices requests
      namespace: "deviceRateLimiter", // optional: allows one redis instance to handle multiple types of rate limiters. defaults to "rate-limiter-{string of 8 random characters}"
      interval: 1000,
      maxInInterval: limit
    });
  }
}

module.exports = CdifDevice;
