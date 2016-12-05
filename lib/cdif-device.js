var events      = require('events');
var util        = require('util');
var url         = require('url');
var parser      = require('json-schema-ref-parser');
var Service     = require('./service');
var ConnMan     = require('./connect');
var validator   = require('./validator');
var LOG           = require('./logger');
var CdifError   = require('./error').CdifError;
var DeviceError = require('./error').DeviceError;

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

  this.getDeviceSpec          = this.getDeviceSpec.bind(this);
  this.connect                = this.connect.bind(this);
  this.disconnect             = this.disconnect.bind(this);
  this.getHWAddress           = this.getHWAddress.bind(this);
  this.deviceControl          = this.deviceControl.bind(this);
  this.subscribeDeviceEvent   = this.subscribeDeviceEvent.bind(this);
  this.unSubscribeDeviceEvent = this.unSubscribeDeviceEvent.bind(this);
}

util.inherits(CdifDevice, events.EventEmitter);


CdifDevice.prototype.setAction = function(serviceID, actionName, action) {
  if (action === null || typeof(action) !== 'function') {
    return LOG.DE(this, new DeviceError('set incorrect action type for: ' + serviceID + ' ' + actionName));
  }

  var service = this.services[serviceID];
  if (service) {
    service.actions[actionName].invoke = action.bind(this);
  } else {
    LOG.DE(this, new DeviceError('cannot set action: ' + serviceID + ' ' + actionName));
  }
};

CdifDevice.prototype.initServices = function() {
  if (typeof(this.spec) !== 'object' || this.spec.device == null || this.spec.device.serviceList == null) {
    return LOG.DE(this, new DeviceError('no valid device spec: ' + this.constructor.name));
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

CdifDevice.prototype.getDeviceSpec = function(callback) {
  if (this.spec === null) {
    return callback(new CdifError('cannot get device spec'), null);
  }
  callback(null, this.spec);
};

CdifDevice.prototype.getServiceStates = function(serviceID, callback) {
  if (callback && typeof(callback) !== 'function') {
    return LOG.DE(this, new DeviceError('getServiceStates failed, no valid callback'));
  }
  var service = this.services[serviceID];
  if (service == null) {
    var error = new DeviceError('service not found: ' + serviceID);
    LOG.DE(this, error);
    if (callback && typeof(callback) === 'function') {
      return callback(error, null);
    }
  }
  service.getServiceStates(callback);
};

CdifDevice.prototype.setServiceStates = function(serviceID, values, callback) {
  if (callback == null || typeof(callback) !== 'function') {
    return LOG.DE(this, new CdifError('setServiceStates failed, no valid callback'));
  }
  var service = this.services[serviceID];
  if (service == null) {
    var error = new DeviceError('service not found: ' + serviceID);
    LOG.DE(this, error);
    return callback(error);
  }

  service.setServiceStates(values, callback);
};

// now support only one user / pass pair
// TODO: check if no other case than oauth redirect flow needs to temporarily unset connected flag
CdifDevice.prototype.connect = function(user, pass, callback) {
  if (this.connectionState === 'redirecting') {
    return callback(new CdifError('device in action'), null, null);
  }

  if (this.connectionState === 'connected') {
    return this.connMan.verifyConnect(user, pass, callback);
  }
  return this.connMan.processConnect(user, pass, callback);
};

CdifDevice.prototype.disconnect = function(callback) {
  return this.connMan.processDisconnect(callback);
};

CdifDevice.prototype.getHWAddress = function(callback) {
  if (this._getHWAddress && typeof(this._getHWAddress) === 'function') {
    this._getHWAddress(function(error, data) {
      if (error) {
        var err = new DeviceError('get hardware address fail: ' + error.message);
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
    return session.callback(new DeviceError('service not found: ' + serviceID), null);
  }
  service.invokeAction(actionName, args, session);
};

CdifDevice.prototype.updateDeviceSpec = function(newSpec) {
  validator.validateDeviceSpec(newSpec, function(error) {
    if (error) {
      return LOG.DE(this, new DeviceError('spec update failed: ' + error.message + ',  device spec: ' + JSON.stringify(newSpec)));
    }
    this.spec = newSpec;
    this.initServices();
  }.bind(this));
};

CdifDevice.prototype.setEventSubscription = function(serviceID, subscribe, unsubscribe) {
  if (typeof(subscribe) !== 'function' || typeof(unsubscribe) !== 'function') {
    return LOG.DE(this, new DeviceError('type error for event subscribers'));
  }
  var service = this.services[serviceID];
  if (service) {
    service.setEventSubscription(subscribe.bind(this), unsubscribe.bind(this));
  } else {
    LOG.DE(this, new DeviceError('cannot set subscriber for: ' + serviceID));
  }
};

CdifDevice.prototype.subscribeDeviceEvent = function(subscriber, serviceID, callback) {
  var service = this.services[serviceID];
  if (service == null) {
    return callback(new DeviceError('cannot subscribe to unknown serviceID: ' + serviceID));
  }

  service.subscribeEvent(subscriber.onChange, function(err) {
    if (!err) {
      service.addListener('serviceevent', subscriber.publish);
    }
    callback(err);
  });
};

CdifDevice.prototype.unSubscribeDeviceEvent = function(subscriber, serviceID, callback) {
  var service = this.services[serviceID];
  if (service == null) {
    return callback(new CdifError('cannot unsubscribe from unknown serviceID: ' + serviceID));
  }

  service.removeListener('serviceevent', subscriber.publish);
  if (service.listeners('serviceevent').length === 0) {
    service.unsubscribeEvent(callback);
  } else {
    callback(null);
  }
};

// get device root url string
CdifDevice.prototype.getDeviceRootUrl = function(callback) {
  if (this.spec.device.devicePresentation !== true || typeof(this._getDeviceRootUrl) !== 'function') {
    return callback(new DeviceError('this device do not support presentation'), null);
  }
  this._getDeviceRootUrl(function(err, data) {
    if (err) {
      return callback(new DeviceError('get device root url failed: ' + err.message), null);
    }
    try {
      url.parse(data);
    } catch(e) {
      return callback(new DeviceError('device root url parse failed: ' + e.message), null);
    }
    callback(null, data);
  });
};

// get device root schema document object, must be sync
CdifDevice.prototype.getDeviceRootSchema = function() {
  if (typeof(this._getDeviceRootSchema) !== 'function') return null;
  try {
    return this._getDeviceRootSchema();
  } catch (e) {
    LOG.DE(this, new DeviceError(e.message));
    return null;
  }
};

// resolve JSON pointer based schema ref and return the schema object associated with it
// For now we only support single doc schema to avoid security risks when resolving external refs
CdifDevice.prototype.resolveSchemaFromPath = function(path, self, callback) {
  var schemaDoc = this.schemaDoc;
  if (schemaDoc == null || typeof(schemaDoc) !== 'object') {
    return callback(new DeviceError('device has no schema doc'), self, null);
  }
  if (path === '/') {
    return callback(null, self, schemaDoc);
  }

  var doc = null;
  try {
    doc = JSON.parse(JSON.stringify(schemaDoc));
  } catch(e) {
    return callback(new DeviceError('invalid schema doc: ' + e.message), self, null);
  }

  var ref;

  // for now we dont support fragment based pointer
  // because it won't be able to be resolved
  if (/^\/./.test(path) === false) {
    return callback(new CdifError('path is not a valid pointer'), self, null);
  }

  ref = '#' + path;

  doc.__ =  {
    "$ref": ref
  };

  parser.dereference(doc, {$refs: {external: false}}, function(err, out) {
    if (err) {
      return callback(new CdifError('pointer dereference fail: ' + err.message), self, null);
    }
    callback(null, self, out.__);
  });
};

CdifDevice.prototype.setOAuthAccessToken = function(params, callback) {
  if (typeof(this._setOAuthAccessToken) === 'function') {
    this._setOAuthAccessToken(params, function(err) {
      if (err) {
        return callback(new CdifError(err.message));
      }
      this.connectionState = 'connected';
      callback(null);
    }.bind(this));
  } else {
    callback(new CdifError('cannot set device oauth access token: no available device interface'));
  }
};

module.exports = CdifDevice;
