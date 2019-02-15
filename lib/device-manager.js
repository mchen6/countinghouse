var events      = require('events');
var util        = require('util');
var UUID        = require('uuid-1345');
var CdifDevice  = require('./cdif-device');
var DeviceAuth  = require('./device-auth');
var validator   = require('./validator');
var LOG         = require('./logger');
var options     = require('../lib/cli-options');
var OAuthDevice = require('./oauth/oauth');
var CdifError   = require('./cdif-error').CdifError;
var DeviceError = require('./cdif-error').DeviceError;

function DeviceManager(mm) {
  this.deviceMap     = {};
  this.deviceAuth    = new DeviceAuth();
  this.moduleManager = mm;

  this.allDevicesLoaded = false;
  this.notifyDeviceLoad = {};

  this.moduleManager.on('deviceonline',        this.onDeviceOnline.bind(this));
  this.moduleManager.on('deviceoffline',       this.onDeviceOffline.bind(this));
  this.moduleManager.on('purgedevice',         this.onPurgeDevice.bind(this));
  this.moduleManager.on('querydevicelist',     this.onQueryDeviceList.bind(this));
  this.moduleManager.on('modulediscovering',   this.onModuleDiscovering.bind(this));
  this.moduleManager.on('allmodulediscovered', this.onAllModulesDiscovered.bind(this));

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
  this.on('invokecallback',  this.onInvokeDeviceCallback.bind(this));
  this.on('setoauthtoken',   this.onSetDeviceOAuthAccessToken.bind(this));
  this.on('getrooturl',      this.onGetDeviceRootUrl.bind(this));

  this.on('querydevice',     this.onQueryDevice.bind(this));
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
      LOG.DE(cdifDevice, new CdifError('DEVICE_SPEC_VALIDATION_FAIL', error.message));
      if (options.enableVerifyAndPublish !== true) return;       // fall through in case of we are verifying a module
    }
    if (moduleInstance == null) {
      LOG.DE(cdifDevice, new CdifError('INVALID_MODULE_INSTANCE', cdifDevice.spec.device.friendlyName));
      if (options.enableVerifyAndPublish !== true) return;      // fall through in case of we are verifying a module
    }

    UUID.v5({
        namespace: UUID.namespace.url,
        name: 'https://registry.apemesh.com/packages/' + moduleName + '@' + cdifDevice.spec.device.friendlyName
    }, function (err, uuid) {
        if (err) {
          LOG.DE(cdifDevice, new CdifError('DEVICE_ID_GENERATION_FAIL', err.message));
          if (options.enableVerifyAndPublish !== true) return;      // fall through in case of we are verifying a module
        }

        if(this.deviceMap[uuid] != null) {
          if (this.deviceMap[uuid].module === moduleInstance) {
            LOG.DE(cdifDevice, new CdifError('DEVICE_OBJECT_CONFLICT'));
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

        if (this.allDevicesLoaded === false) {
          if (this.notifyDeviceLoad[uuid] != null) {
            for (var i = 0; i < this.notifyDeviceLoad[uuid].length; i++) {
              var cb = this.notifyDeviceLoad[uuid][i];
              //TODO: this cb would eventually fall into user's module code (the callback of createServiceClient)
              // it could be unsafe and block the whole framework, we better to open a new thread to do this and
              // catch errors from it
              cb(null, cdifDevice);
            }
            delete this.notifyDeviceLoad[uuid];
          }
        }
    }.bind(this));
  }.bind(this));
};

// for now this is not triggered
DeviceManager.prototype.onDeviceOffline = function(cdifDevice, moduleInstance) {
  LOG.DE(cdifDevice, new CdifError('DEVICE_OFFLINE', cdifDevice.spec.device.friendlyName));
  cdifDevice.online = false;
};

// we must garantee this event is handled after all deviceonline events are handled
// for now we emit this event from module-manager discovery code after 5 seconds of start discover,
// we consider all deviceonline events are already processed during this period.
DeviceManager.prototype.onAllModulesDiscovered = function() {
  // After setting allDevicesLoaded flag to true, we consider the remaining deviceIDs in above notifyDeviceLoad object
  // are invalid devices, and we invoke those callbacks with error information
  this.allDevicesLoaded = true;
  for (var deviceID in this.notifyDeviceLoad) {
    var arr = this.notifyDeviceLoad[deviceID];
    for (var i = 0; i < arr.length; i++) {
      var cb = arr[i];
      cb(new Error('未知应用'), null);
    }
    delete this.notifyDeviceLoad[deviceID];
  }
};

// purge all device objects which are managed by the unloaded module
// call device's _destroy() method to allow user graceful close
// network connections, opened file descriptors or other resources etc
DeviceManager.prototype.onPurgeDevice = function(moduleInstance) {
  for (var deviceID in this.deviceMap) {
    var device = this.deviceMap[deviceID];

    if (device != null && device.module === moduleInstance) {
      if (device instanceof CdifDevice) {
        device.destroyCdifDevice();
      }
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
    return this.moduleManager.emit('querydevicelistresult', new CdifError('MODULE_VERIFICATION_FAILED'), deviceList, packageInfo, callback);
  }
  return this.moduleManager.emit('querydevicelistresult', null, deviceList, packageInfo, callback);
};

DeviceManager.prototype.onDiscoverAll = function(session) {
  this.moduleManager.discoverAllDevices();
  session.callbackWithoutTimer(null);
};

DeviceManager.prototype.onStopDiscoverAll = function(session) {
  this.moduleManager.stopDiscoverAllDevices();
  session.callbackWithoutTimer(null);
};

DeviceManager.prototype.onGetDiscoveredDeviceList = function(session) {
  var deviceList = [];
  for (var i in this.deviceMap) {
    var cdifDevice = this.deviceMap[i];
    if (cdifDevice.spec) {
      //this is ugly but the easiest way to handle this request
      var desc = JSON.parse(JSON.stringify(cdifDevice.spec));
      desc.device.serviceList = {};
      deviceList.push(desc);
    }
  }
  session.callbackWithoutTimer(null, deviceList);
};

DeviceManager.prototype.ensureDeviceState = function(deviceID, token, callback) {
  var cdifDevice = this.deviceMap[deviceID];

  if (cdifDevice == null) {  // check null or undefined
    return callback(new CdifError('DEVICE_NOT_FOUND', deviceID));
  }
  // 20180129: i think it doesn't make sense to check module's discovery state here because we are validating device's state
  // if (cdifDevice.module.discoverState === 'discovering') {
  //   return callback(new CdifError('MODULE_IN_DISCOVERING'));
  // }
  // if (cdifDevice.connectionState !== 'connected') {
  //   return callback(new CdifError('device not connected'));
  // }
  if (cdifDevice.online === false) {
    return callback(new CdifError('DEVICE_OFFLINE'));
  }

  // FIXME: for oauth devices when we do setOAuthToken we need to ensure redirecting state
  // however when we do invok-action this check will fall through and successfully return device instance
  if (cdifDevice.isOAuthDevice === true && cdifDevice.connectionState !== 'redirecting') {
     if (cdifDevice.oauth_access_token === '' || cdifDevice.oauth2_access_token === '') {
       return callback(new CdifError('OAUTH_ACCESS_TOKEN_NOT_AVAILABLE'));
     }
  }
  callback(null, cdifDevice);

  // if (cdifDevice.spec.device.userAuth === true) {
  //   // make sure this is sync
  //   this.deviceAuth.verifyAccess(cdifDevice.secret, token, callback);
  // } else {
  //   callback(null);
  // }
};

DeviceManager.prototype.onConnectDevice = function(deviceID, user, pass, session) {
  var _this = this;

  var cdifDevice = this.deviceMap[deviceID];
  if (cdifDevice == null) {
    return session.callbackWithoutTimer(new CdifError('DEVICE_NOT_FOUND', deviceID));
  }

  if (cdifDevice.module.discoverState === 'discovering') {
    return session.callbackWithoutTimer(new CdifError('MODULE_IN_DISCOVERING'));
  }

  session.setDeviceTimer(cdifDevice, function(error, device, timer) {
    try {
      device.connect(user, pass, function(err, secret, redirectObj) {
        if (err) {
          return this.callback(err, null);
        }
        if (secret) {
          // FIXME: this brings in 'user' from context which could be an issue, bring in from session
          _this.deviceAuth.generateToken(user, secret, function(err, token) {
            if (err) {
              return this.callback(new CdifError('CANNOT_GENERATE_ACCESS_TOKEN'), null);
            }
            if (redirectObj) {
              return this.callback(null, {'device_access_token': token, 'url_redirect': redirectObj});
            } else {
              return this.callback(null, {'device_access_token': token});
            }
          }.bind(this));
        } else {
          if (redirectObj != null) {
            return this.callback(null, {'url_redirect': redirectObj});
          } else {
            return this.callback(null, null);
          }
        }
        //FIXME: do not emit presentation event more than once, this brings in from context
        if (device.spec.device.devicePresentation === true) {
          _this.emit('presentation', cdifDevice.deviceID);
        }
      }.bind(this));
    } catch (e) {
      return this.callback(new DeviceError('DEVICE_CONNECT_FAIL', e.message), null);
    }
  }.bind(session));
};

DeviceManager.prototype.onDisconnectDevice = function(deviceID, token, session) {
  this.ensureDeviceState(deviceID, token, function(err, cdifDevice) {
    if (cdifDevice == null) {
      return session.callbackWithoutTimer(new CdifError('DEVICE_NOT_FOUND', deviceID));
    }

    if (err) {
      if (cdifDevice.connectionState !== 'redirecting') {
        return session.callbackWithoutTimer(err);
      }
    }

    session.setDeviceTimer(cdifDevice, function(error, device, timer) {
      try {
        device.disconnect(session);
      } catch (e) {
        return this.callback(new DeviceError('DEVICE_DISCONNECT_FAIL', e.message), null);
      }
    }.bind(session));
  });
};

DeviceManager.prototype.onInvokeDeviceAction = function(deviceID, serviceID, actionName, args, token, session) {
  this.ensureDeviceState(deviceID, token, function(err, cdifDevice) {
    if (err) return session.callbackWithoutTimer(err, null);

    session.setDeviceTimer(cdifDevice, function(error, device, timer) {
      try {
        device.deviceControl(serviceID, actionName, args, session);
      } catch (e) {
        return this.callback(new DeviceError('DEVICE_ACTION_CALL_FAIL', e.message), null);
      }
    }.bind(session));
  });
};

DeviceManager.prototype.onGetDeviceSpec = function(deviceID, token, session) {
  this.ensureDeviceState(deviceID, token, function(err, cdifDevice) {
    if (err) return session.callbackWithoutTimer(err, null);

    session.setDeviceTimer(cdifDevice, function(error, device, timer) {
      device.getDeviceSpec(session);
    }.bind(session));
  });
};

DeviceManager.prototype.onGetDeviceState = function(deviceID, serviceID, token, session) {
  this.ensureDeviceState(deviceID, token, function(err, cdifDevice) {
    if (err) return session.callbackWithoutTimer(err, null);

    session.setDeviceTimer(cdifDevice, function(error, device, timer) {
      device.getServiceStates(serviceID, session);
    }.bind(session));
  });
};

DeviceManager.prototype.onEventSubscribe = function(deviceID, serviceID, actionName, input, inputKey, token, callback) {
  this.ensureDeviceState(deviceID, token, function(err, cdifDevice) {
    if (err) return callback(err);
    cdifDevice.subscribeDeviceEvent(serviceID, actionName, input, inputKey, callback);
  });
};

DeviceManager.prototype.onEventUnsubscribe = function(deviceID, serviceID, actionName, input, inputKey, token, callback) {
  this.ensureDeviceState(deviceID, token, function(err, cdifDevice) {
    if (err) return callback(err);
    cdifDevice.unsubscribeDeviceEvent(serviceID, actionName, input, inputKey, callback);
  });
};

DeviceManager.prototype.onGetDeviceSchema = function(deviceID, path, token, session) {
  this.ensureDeviceState(deviceID, token, function(err, cdifDevice) {
    if (err) return session.callbackWithoutTimer(err, null);

    session.setDeviceTimer(cdifDevice, function(error, device, timer) {
      device.resolveSchemaFromPath(path, null, function(err, self, data) {
        return this.callback(err, data);
      }.bind(session));
    }.bind(session));
  });
};

DeviceManager.prototype.onInvokeDeviceCallback = function(deviceID, path, data, token, session) {
  this.ensureDeviceState(deviceID, token, function(err, cdifDevice) {
    if (err) return session.callbackWithoutTimer(err, null);

    session.setDeviceTimer(cdifDevice, function(error, device, timer) {
      try {
        device.invokeDeviceCallback(path, data, session);
      } catch (e) {
        return this.callback(new DeviceError('DEVICE_INVOKE_CALLBACK_FAIL', e.message), null);
      }
    }.bind(session));

  });
};

DeviceManager.prototype.onSetDeviceOAuthAccessToken = function(deviceID, params, session) {
  this.ensureDeviceState(deviceID, null, function(err, cdifDevice) {
    if (err) return session.callbackWithoutTimer(err, null);

    session.setDeviceTimer(cdifDevice, function(error, device, timer) {
      device.setOAuthAccessToken(params, session);
    }.bind(session));
  });
};

DeviceManager.prototype.onGetDeviceRootUrl = function(deviceID, session) {
  this.ensureDeviceState(deviceID, null, function(err, cdifDevice) {
    if (err) return session.callbackWithoutTimer(err, null);

    session.setDeviceTimer(cdifDevice, function(error, device, timer) {
      device.getDeviceRootUrl(session);
    }.bind(session));
  });
};

DeviceManager.prototype.checkDeviceInterface = function(cdifDevice) {
  if (cdifDevice.lastDeviceError != null) {
    return false;
  }
  if (!(cdifDevice instanceof CdifDevice)) {
    LOG.DE(cdifDevice, new CdifError('DEVICE_OBJECT_NOT_VALID_CDIF_DEVICE'));
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

      if (action.fault != null) {
        action.fault.schema = JSON.parse(JSON.stringify(cdifDevice.services[serviceID].actions[actionName].faultObj.schema));
      }

      for (var argumentName in action.argumentList) {
        var argument          = action.argumentList[argumentName];
        var stateVariableName = argument.relatedStateVariable;

        var stateVariable = stateTable[stateVariableName];

        var schemaObject = cdifDevice.services[serviceID].states[stateVariableName].variable.schema;
        stateVariable.schema = JSON.parse(JSON.stringify(schemaObject)); // replace path

        if (stateVariable.schema.type !== 'object' && stateVariable.schema.type !== 'array') {
          deviceInfo.deviceErrorMessage = 'schema root type must be either object or array: ' + stateVariableName;
          return true;
        }
      }
    }
  }
  return false;
};

// lookup specific deviceID in deviceMap, if found return the device object or return null to callback
DeviceManager.prototype.onQueryDevice = function(deviceID, callback) {
  this.ensureDeviceState(deviceID, null, function(err, cdifDevice) {
    if (err == null) return callback(null, cdifDevice);
    if (this.allDevicesLoaded === true) return callback(err, null);

    if (this.notifyDeviceLoad[deviceID] == null) {
      this.notifyDeviceLoad[deviceID] = [];
    }
    this.notifyDeviceLoad[deviceID].push(callback);
  }.bind(this));
}

DeviceManager.prototype.onModuleDiscovering = function() {
  this.allDevicesLoaded = false; // temporarily set this flag to false during module discovering
}

module.exports = DeviceManager;
