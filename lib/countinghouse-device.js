const events      = require('events');
const util        = require('util');
const url         = require('url');
const parser      = require('json-schema-ref-parser');

const Service     = require('./service');
const ConnMan     = require('./connect');
const validator   = require('./validator');
const LOG         = require('./logger');
const options     = require('./cli-options');
const CHError   = require('./countinghouse-error').CHError;
const DeviceError = require('./countinghouse-error').DeviceError;
const callAddress = require('./call-address');

//warn: try not add event listeners in this class
function CHDevice(spec) {
  this.deviceID        = '';
  this.user            = '';
  this.secret          = '';
  this.rateLimiter     = null;
  this.connectionState = 'disconnected';  // enum of disconnected, connected, & redirecting
  this.connMan     = new ConnMan(this);
  this.schemaDoc   = this.getDeviceRootSchema();

  this.spec = spec;
  this.initServices();


  // Derived from friendlyName, in lib/call-address.js -- the single
  // definition, so a composition address and a device's real ID cannot
  // disagree. The 'apemesh' hash seed lives there and is deliberately kept;
  // changing it would reassign every existing device's UUID.
  // See MIGRATION.md's "Not changed" section.
  this.deviceID = callAddress.deviceIDForName(spec.device.friendlyName);
  // annotate generated deviceID to spec object
  this.spec.device.deviceID = this.deviceID;

  this.getDeviceSpec          = this.getDeviceSpec.bind(this);
  this.connect                = this.connect.bind(this);
  this.disconnect             = this.disconnect.bind(this);
  this.getHWAddress           = this.getHWAddress.bind(this);
  this.deviceControl          = this.deviceControl.bind(this);
}

util.inherits(CHDevice, events.EventEmitter);


CHDevice.prototype.setAction = function(serviceID, actionName, action) {
  if (action === null || typeof(action) !== 'function') {
    return LOG.DE(this, new DeviceError('SET_INCORRECT_ACTION_TYPE', serviceID, actionName));
  }

  const service = this.services[serviceID];
  if (service != null && service.actions != null && service.actions[actionName] != null) {
    return service.actions[actionName].invoke = action.bind(this);
  }

  if (service == null)                     return LOG.DE(this, new DeviceError('CANNOT_SET_ACTION_SERVICE_OBJ_NOT_EXIST', serviceID, actionName));
  if (service.actions == null)             return LOG.DE(this, new DeviceError('CANNOT_SET_ACTION_ACTION_LIST_NOT_EXIST', serviceID, actionName));
  if (service.actions[actionName] == null) return LOG.DE(this, new DeviceError('CANNOT_SET_ACTION_OBJ_NOT_EXIST', serviceID, actionName));

  return LOG.DE(this, new DeviceError('CANNOT_SET_ACTION', serviceID, actionName));
};

CHDevice.prototype.initServices = function() {
  if (typeof(this.spec) !== 'object' || this.spec.device == null || this.spec.device.serviceList == null) {
    return LOG.DE(this, new DeviceError('NO_VALID_DEVICE_SPEC', this.constructor.name));
  }

  const serviceList = this.spec.device.serviceList;

  if (!this.services) {
    this.services = new Object();
  }
  for (const i in serviceList) {
    const service_spec = serviceList[i];
    if (!this.services[i]) {
      this.services[i] = new Service(this, i, service_spec);
    } else {
      this.services[i].updateSpec(service_spec);
    }
  }
};

CHDevice.prototype.getDeviceSpec = function(session) {
  let cb = null;

  if (typeof(session) === 'function') {
    cb = session;
  } else {
    cb = session.callback;
  }

  if (this.spec === null) {
    return cb(new CHError('CANNOT_GET_DEVICE_SPEC'), null);
  }
  return cb(null, this.spec);
};

// now support only one user / pass pair
// TODO: check if no other case than oauth redirect flow needs to temporarily unset connected flag
CHDevice.prototype.connect = function(user, pass, callback) {
  if (this.connectionState === 'redirecting') {
    return callback(new CHError('DEVICE_IN_ACTION'), null, null);
  }

  if (this.connectionState === 'connected') {
    return this.connMan.verifyConnect(user, pass, callback);
  }
  return this.connMan.processConnect(user, pass, callback);
};

CHDevice.prototype.disconnect = function(session) {
  return this.connMan.processDisconnect(session.callback);
};

CHDevice.prototype.getHWAddress = function(callback) {
  if (this._getHWAddress && typeof(this._getHWAddress) === 'function') {
    this._getHWAddress((error, data) => {
      if (error) {
        const err = new DeviceError('GET_HARDWARE_ADDR_FAIL', error.message);
        LOG.DE(this, err);
        return callback(err, null);
      }
      callback(null, data);
    });
  } else {
    callback(null, null);
  }
};

CHDevice.prototype.deviceControl = function(serviceID, actionName, args, session) {
  const service = this.services[serviceID];
  if (service == null) {
    if (typeof(session) === 'function') {
      return session(new DeviceError('SERVICE_NOT_FOUND', serviceID), null);
    }
    return session.callback(new DeviceError('SERVICE_NOT_FOUND', serviceID), null);
  }
  return service.invokeAction(actionName, args, session);
};

CHDevice.prototype.invokeDeviceCallback = function(path, data, session) {
  let cb = null;

  if (typeof(session) === 'function') {
    cb = session;
  } else {
    cb = session.callback;
  }

  if (this._deviceCallbackHandler == null || typeof(this._deviceCallbackHandler) !== 'function') {
    return cb(new DeviceError('DEVICE_CALLBACK_NOT_AVAILABLE'), null);
  }
  this._deviceCallbackHandler(path, data, (err, output) => {
    if (err != null) {
      let error = null;
      if (err instanceof DeviceError || err instanceof CHError) {
        error = err;
      } else {
        error = new DeviceError('DEVICE_INVOKE_CALLBACK_FAIL', err.message);
      }
      return cb(error, output);
    }
    return cb(null, output);
  });
};

CHDevice.prototype.updateDeviceSpec = function(newSpec) {
  validator.validateDeviceSpec(newSpec, (error) => {
    if (error) {
      return LOG.DE(this, new DeviceError('DEVICE_SPEC_UPDATE_FAIL', error.message, JSON.stringify(newSpec)));
    }
    this.spec = newSpec;
    this.initServices();
  });
};

// get device root url string
CHDevice.prototype.getDeviceRootUrl = function(session) {
  if (this.spec.device.devicePresentation !== true || typeof(this._getDeviceRootUrl) !== 'function') {
    return session.callback(new DeviceError('PRESENTATION_NOT_SUPPORTED'), null);
  }
  this._getDeviceRootUrl((err, data) => {
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
CHDevice.prototype.getDeviceRootSchema = function() {
  if (typeof(this._getDeviceRootSchema) !== 'function') return null;
  try {
    return this._getDeviceRootSchema();
  } catch (e) {
    LOG.DE(this, new DeviceError('GET_DEVICE_SCHEMADOC_FAIL', e.message));
    return null;
  }
};

CHDevice.prototype.destroyCdifDevice = function() {
  if (typeof(this._destroyDevice) !== 'function') return null;
  try {
    return this._destroyDevice();
  } catch (e) {
    LOG.DE(this, new DeviceError('DESTROY_DEVICE_FAIL', e.message));
    return null;
  }
};

// resolve JSON pointer based schema ref and return the schema object associated with it
// For now we only support single doc schema to avoid security risks when resolving external refs
CHDevice.prototype.resolveSchemaFromPath = function(path, self, callback) {
  const schemaDoc = this.schemaDoc;
  if (schemaDoc == null || typeof(schemaDoc) !== 'object') {
    return callback(new DeviceError('INVALID_DEVICE_SCHEMADOC'), self, null);
  }
  if (path === '/') {
    return callback(null, self, schemaDoc);
  }

  let doc = null;
  try {
    doc = JSON.parse(JSON.stringify(schemaDoc));
  } catch(e) {
    return callback(new DeviceError('INVALID_DEVICE_SCHEMADOC', e.message), self, null);
  }

  // for now we dont support fragment based pointer
  // because it won't be able to be resolved
  if (/^\/./.test(path) === false) {
    return callback(new CHError('INVALID_JSON_POINTER'), self, null);
  }

  const ref = `#${path}`;

  doc.__ =  {
    "$ref": ref
  };

  parser.dereference(doc, {$refs: {external: false}}, (err, out) => {
    if (err) {
      return callback(new CHError('POINTER_DEREF_ERROR', err.message), self, null);
    }
    callback(null, self, out.__);
  });
};

CHDevice.prototype.setOAuthAccessToken = function(params, session) {
  if (typeof(this._setOAuthAccessToken) === 'function') {
    this._setOAuthAccessToken(params, (err) => {
      if (err) {
        return session.callback(new CHError(err.message));
      }
      this.connectionState = 'connected';
      session.callback(null);
    });
  } else {
    session.callback(new CHError('CANNOT_SET_OAUTH_ACCESS_TOKEN_INVALID_INTERFACE'));
  }
};



//callback null indicate validation success and otherwise fail
CHDevice.prototype.oauthTokenValidate = function(session, callback) {
  if (options.debug === true) return callback();           // under debug mode we don't do oauth token validation
  if (typeof(session) === 'function') return callback();   // we are in worker thread, there is no session obj

  //20191107: we decide to move oauth validation code down to devices
  // so we can support per-device oauth validation
  // because we can't pass express's app obj to worker thread, this token validation should
  // always happens in main thread
  if (this.spec.device && this.spec.device.requireOAuthAccessToken === true) {
    // the oauth2-server-based token validation that used to live here was never
    // actually wired up (RouteManager never called createOAuthServer, so app.oauth
    // was always undefined -- this branch would have thrown if any device module
    // ever set requireOAuthAccessToken) and oauth2-server itself has unfixed CVEs
    // upstream, so it was removed entirely. No device module sets this flag today.
    // Fail closed with a clear error instead of silently allowing access.
    return callback(new DeviceError('OAUTH_ACCESS_TOKEN_NOT_AVAILABLE'));
  }

  return callback();
};

module.exports = CHDevice;
