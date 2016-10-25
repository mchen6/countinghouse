var events      = require('events');
var util        = require('util');
var UUID        = require('uuid-1345');
var CdifDevice  = require('cdif-device');
var deviceDB    = require('./device-db');
var DeviceAuth  = require('./device-auth');
var validator   = require('./validator');
var LOG         = require('./logger');
var options     = require('../lib/cli-options');
var OAuthDevice = require('./oauth/oauth');
var CdifError   = require('./error').CdifError;
var DeviceError = require('./error').DeviceError;

function DeviceManager(mm) {
  this.deviceMap     = {};
  this.deviceAuth    = new DeviceAuth();
  this.moduleManager = mm;

  this.moduleManager.on('deviceonline',    this.onDeviceOnline.bind(this));
  this.moduleManager.on('deviceoffline',   this.onDeviceOffline.bind(this));
  this.moduleManager.on('purgedevice',     this.onPurgeDevice.bind(this));
  this.moduleManager.on('querydevicelist', this.onQueryDeviceList.bind(this));

  this.on('discoverall',     this.onDiscoverAll.bind(this));
  this.on('stopdiscoverall', this.onStopDiscoverAll.bind(this));
  this.on('devicelist',      this.onGetDiscoveredDeviceList.bind(this));
  this.on('connect',         this.onConnectDevice.bind(this));
  this.on('disconnect',      this.onDisconnectDevice.bind(this));
  this.on('invokeaction',    this.onInvokeDeviceAction.bind(this));
  this.on('getspec',         this.onGetDeviceSpec.bind(this));
  this.on('devicestate',     this.onGetDeviceState.bind(this));
  this.on('subscribe',       this.onEventSubscribe.bind(this));
  this.on('unsubscribe',     this.onEventUnsubscribe.bind(this));
  this.on('getschema',       this.onGetDeviceSchema.bind(this));
  this.on('setoauthtoken',   this.onSetDeviceOAuthAccessToken.bind(this));
  this.on('getrooturl',      this.onGetDeviceRootUrl.bind(this));
}

util.inherits(DeviceManager, events.EventEmitter);

DeviceManager.prototype.onDeviceOnline = function(cdifDevice, moduleInstance, moduleName) {
  if (cdifDevice.oauth_version === '1.0' || cdifDevice.oauth_version === '2.0') {
    var oauth = new OAuthDevice(cdifDevice);
    oauth.createOAuthDevice();
  }

  if (this.checkDeviceInterface(cdifDevice) === false) {
    if (options.enableVerifyAndPublish !== true) return;       // fall through in case of we are verifying a module
  }

  validator.validateDeviceSpec(cdifDevice.spec, function(error) {
    if (error) {
      LOG.DE(cdifDevice, new CdifError(error.message));
      if (options.enableVerifyAndPublish !== true) return;       // fall through in case of we are verifying a module
    }
    if (moduleInstance == null) {
      LOG.DE(cdifDevice, new CdifError('unknown module for device: ' + cdifDevice.spec.device.friendlyName));
      if (options.enableVerifyAndPublish !== true) return;      // fall through in case of we are verifying a module
    }

    UUID.v5({
        namespace: UUID.namespace.url,
        name: 'https://registry.apemesh.com/packages/' + moduleName + '@' + cdifDevice.spec.device.friendlyName
    }, function (err, uuid) {
        if (err) {
          LOG.DE(cdifDevice, new CdifError(err.message));
          if (options.enableVerifyAndPublish !== true) return;      // fall through in case of we are verifying a module
        }

        if(this.deviceMap[uuid] != null) {
          if (this.deviceMap[uuid].module === moduleInstance) {
            LOG.DE(cdifDevice, new CdifError('conflict device object, maybe friendlyName duplicates?'));
            if (options.enableVerifyAndPublish !== true) return;      // fall through in case of we are verifying a module
          }
        }

        cdifDevice.module     = moduleInstance;
        cdifDevice.moduleName = moduleName;
        cdifDevice.auth       = this.deviceAuth;
        cdifDevice.deviceID   = uuid;
        cdifDevice.online     = true;
        // below information is added to spec and can be used when adding device info to the database
        cdifDevice.spec.device.deviceID = uuid;
        LOG.I('new device online: ' + uuid);
        this.deviceMap[uuid] = cdifDevice;
    }.bind(this));
  }.bind(this));
};

// for now this is not triggered
DeviceManager.prototype.onDeviceOffline = function(cdifDevice, moduleInstance) {
  LOG.DE(cdifDevice, new CdifError('device offline: ' + cdifDevice.spec.device.friendlyName));
  cdifDevice.online = false;
};

// purge all device objects which are managed by the unloaded module
DeviceManager.prototype.onPurgeDevice = function(moduleInstance) {
  for (var deviceID in this.deviceMap) {
    if (this.deviceMap[deviceID].module === moduleInstance) {
      delete this.deviceMap[deviceID];
      LOG.I('device purged: ' + deviceID);
    }
  }
};

// special event handler to query list of devices under a module instance
// this is only active when verify package route is enabled
DeviceManager.prototype.onQueryDeviceList = function(moduleInstance, packageInfo, callback) {
  var deviceList = [];
  var hasError   = false;

  for (var deviceID in this.deviceMap) {
    if (this.deviceMap[deviceID].module === moduleInstance) {
      var cdifDevice = this.deviceMap[deviceID];
      var deviceInfo = {};

      deviceInfo.deviceErrorMessage = null;
      deviceInfo.spec               = JSON.parse(JSON.stringify(cdifDevice.spec)); //copy spec so we can deref schema in it

      if (cdifDevice.lastDeviceError != null) {
        hasError = true;
        deviceInfo.deviceErrorMessage = cdifDevice.lastDeviceError.message;
      } else {
        try {
          hasError = this.resolveSchemaInfo(cdifDevice, deviceInfo);
        } catch (e) {
          hasError = true;
          deviceInfo.deviceErrorMessage = e.message;
        }
      }
      deviceList.push(deviceInfo);
    }
  }

  if (hasError) {
    return this.moduleManager.emit('querydevicelistresult', new CdifError('module verification failed'), deviceList, packageInfo, callback);
  }
  return this.moduleManager.emit('querydevicelistresult', null, deviceList, packageInfo, callback);
};

DeviceManager.prototype.onDiscoverAll = function(callback) {
  this.moduleManager.discoverAllDevices();
  callback(null);
};

DeviceManager.prototype.onStopDiscoverAll = function(callback) {
  this.moduleManager.stopDiscoverAllDevices();
  callback(null);
};

DeviceManager.prototype.onGetDiscoveredDeviceList = function(callback) {
  var deviceList = {};
  for (var i in this.deviceMap) {
    var cdifDevice = this.deviceMap[i];
    if (cdifDevice.spec) {
      //this is ugly but the easiest way to handle this request
      var desc = JSON.parse(JSON.stringify(cdifDevice.spec));
      desc.device.serviceList = {};
      deviceList[i] = desc;
    }
  }
  callback(null, deviceList);
};

DeviceManager.prototype.ensureDeviceState = function(deviceID, token, callback) {
  var cdifDevice = this.deviceMap[deviceID];

  if (cdifDevice == null) {  // check null or undefined
    return callback(new CdifError('device not found: ' + deviceID));
  }
  if (cdifDevice.module.discoverState === 'discovering') {
    return callback(new CdifError('in discovering'));
  }
  // if (cdifDevice.connectionState !== 'connected') {
  //   return callback(new CdifError('device not connected'));
  // }
  if (cdifDevice.online === false) {
    return callback(new CdifError('device offlined'));
  }
  if (cdifDevice.isOAuthDevice === true) {
     if (cdifDevice.oauth_access_token === '' || cdifDevice.oauth2_access_token === '') {
       return callback(new CdifError('oauth access token not available, do connect first'));
     }
  }
  callback(null);

  // if (cdifDevice.spec.device.userAuth === true) {
  //   // make sure this is sync
  //   this.deviceAuth.verifyAccess(cdifDevice.secret, token, callback);
  // } else {
  //   callback(null);
  // }
};

DeviceManager.prototype.onConnectDevice = function(cdifDevice, user, pass, session) {
  var _this = this;

  session.setDeviceTimer(cdifDevice, function(error, device, timer) {
    try {
      device.connect(user, pass, function(err, secret, redirectObj) {
        if (this.expired === true) return;

        var sess = this.session;
        sess.clearDeviceTimer(this);
        if (err) {
          return sess.callback(err, null);
        }

        if (secret) {
          // FIXME: this brings in 'user' from context which could be an issue, bring in from session
          _this.deviceAuth.generateToken(user, secret, function(err, token) {
            if (err) {
              return sess.callback(new CdifError('cannot generate access token'), null);
            }
            if (redirectObj) {
              return sess.callback(null, {'device_access_token': token, 'url_redirect': redirectObj});
            } else {
              return sess.callback(null, {'device_access_token': token});
            }
          });
        } else {
          if (redirectObj != null) {
            return sess.callback(null, {'url_redirect': redirectObj});
          } else {
            return sess.callback(null, null);
          }
        }
        //FIXME: do not emit presentation event more than once, this brings in from context
        if (device.spec.device.devicePresentation === true) {
          _this.emit('presentation', cdifDevice.deviceID);
        }
      }.bind(timer));
    } catch (e) {
      if (timer.expired === true) return;
      this.clearDeviceTimer(timer);
      return this.callback(new DeviceError(e.message), null);
    }
  }.bind(session));
};

DeviceManager.prototype.onDisconnectDevice = function(cdifDevice, session) {
  session.setDeviceTimer(cdifDevice, function(error, device, timer) {
    try {
      device.disconnect(function(err) {
        if (this.expired === true) return;
        this.session.clearDeviceTimer(this);
        return this.session.callback(err);
      }.bind(timer));
    } catch (e) {
        if (timer.expired === true) return;
        this.clearDeviceTimer(timer);
        return this.callback(new DeviceError(e.message), null);
    }
  }.bind(session));
};

DeviceManager.prototype.onInvokeDeviceAction = function(cdifDevice, serviceID, actionName, args, session) {
  session.setDeviceTimer(cdifDevice, function(error, device, timer) {
    try {
      device.deviceControl(serviceID, actionName, args, function(err, data) {
        if (this.expired === true) return;
        this.session.clearDeviceTimer(this);
        return this.session.callback(err, data);
      }.bind(timer));
    } catch (e) {
      if (timer.expired === true) return;
      this.clearDeviceTimer(timer);
      return this.callback(new DeviceError(e.message), null); //framework won't throw
    }
  }.bind(session));
};

DeviceManager.prototype.onGetDeviceSpec = function(cdifDevice, session) {
  session.setDeviceTimer(cdifDevice, function(error, device, timer) {
    device.getDeviceSpec(function(err, data) {
      if (this.expired === true) return;
      this.session.clearDeviceTimer(this);
      return this.session.callback(err, data);
    }.bind(timer));
  }.bind(session));
};

DeviceManager.prototype.onGetDeviceState = function(cdifDevice, serviceID, session) {
  session.setDeviceTimer(cdifDevice, function(error, device, timer) {
    device.getServiceStates(serviceID, function(err, data) {
      if (this.expired === true) return;
      this.session.clearDeviceTimer(this);
      return this.session.callback(err, data);
    }.bind(timer));
  }.bind(session));
};

DeviceManager.prototype.onEventSubscribe = function(subscriber, cdifDevice, serviceID, session) {
  session.setDeviceTimer(cdifDevice, function(error, device, timer) {
    device.subscribeDeviceEvent(subscriber, serviceID, function(err) {
      if (this.expired === true) return;
      this.session.clearDeviceTimer(this);
      return this.session.callback(err);
    }.bind(timer));
  }.bind(session));
};

DeviceManager.prototype.onEventUnsubscribe = function(subscriber, cdifDevice, serviceID, session) {
  session.setDeviceTimer(cdifDevice, function(error, device, timer) {
    device.unSubscribeDeviceEvent(subscriber, serviceID, function(err) {
      if (this.expired === true) return;
      this.session.clearDeviceTimer(this);
      return this.session.callback(err);
    }.bind(timer));
  }.bind(session));
};

DeviceManager.prototype.onGetDeviceSchema = function(cdifDevice, path, session) {
  session.setDeviceTimer(cdifDevice, function(error, device, timer) {
    device.resolveSchemaFromPath(path, null, function(err, self, data) {
      if (this.expired === true) return;
      this.session.clearDeviceTimer(this);
      return this.session.callback(err, data);
    }.bind(timer));
  }.bind(session));
};

DeviceManager.prototype.onSetDeviceOAuthAccessToken = function(cdifDevice, params, session) {
  session.setDeviceTimer(cdifDevice, function(error, device, timer) {
    device.setOAuthAccessToken(params, function(err) {
      if (this.expired === true) return;
      this.session.clearDeviceTimer(this);
      return this.session.callback(err);
    }.bind(timer));
  }.bind(session));
};

DeviceManager.prototype.onGetDeviceRootUrl = function(cdifDevice, session) {
  session.setDeviceTimer(cdifDevice, function(error, device, timer) {
    device.getDeviceRootUrl(function(err, data) {
      if (this.expired === true) return;
      this.session.clearDeviceTimer(this);
      return this.session.callback(err, data);
    }.bind(timer));
  }.bind(session));
};

DeviceManager.prototype.checkDeviceInterface = function(cdifDevice) {
  if (cdifDevice.lastDeviceError != null) {
    return false;
  }
  if (!(cdifDevice instanceof CdifDevice)) {
    LOG.DE(cdifDevice, new CdifError('device object is not an instance of CDIF device'));
    return false;
  }
  return true;
};

// dereference all schemas in the device spec, only used to verify a package
// and return the full device API information to the client
// if any error occurs, fill in the deviceInfo.deviceErrorMessage
// return true indicates error
DeviceManager.prototype.resolveSchemaInfo = function(cdifDevice, deviceInfo) {
  var spec = deviceInfo.spec;

  var serviceList = spec.device.serviceList;

  for (var serviceID in serviceList) {
    var service    = serviceList[serviceID];
    var stateTable = service.serviceStateTable;
    var actionList = service.actionList;

    for (var actionName in actionList) {
      var action = actionList[actionName];

      for (var argumentName in action.argumentList) {
        var argument          = action.argumentList[argumentName];
        var stateVariableName = argument.relatedStateVariable;

        var stateVariable = stateTable[stateVariableName];

        var schemaObject = cdifDevice.services[serviceID].states[stateVariableName].variable.schema;
        stateVariable.schema = JSON.parse(JSON.stringify(schemaObject)); // replace path

        if (stateVariable.schema.type !== 'object' && stateVariable.schema.type !== 'array') {
          deviceInfo.deviceErrorMessage = 'schema root type must be either object or array';
          return true;
        }
      }
    }
  }
  return false;
};

module.exports = DeviceManager;
