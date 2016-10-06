var events      = require('events');
var util        = require('util');
var uuid        = require('uuid');
var CdifDevice  = require('cdif-device');
var deviceDB    = require('./device-db');
var DeviceAuth  = require('./device-auth');
var validator   = require('./validator');
var logger      = require('./logger');
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

DeviceManager.prototype.onDeviceOnline = function(cdifDevice, m) {
  var _this = this;

  if (cdifDevice.oauth_version === '1.0' || cdifDevice.oauth_version === '2.0') {
    var oauth = new OAuthDevice(cdifDevice);
    oauth.createOAuthDevice();
  }

  if (this.checkDeviceInterface(cdifDevice) === false) return;
  cdifDevice.lastDeviceError = null;

  validator.validateDeviceSpec(cdifDevice.spec, function(error) {
    if (error) {
      cdifDevice.lastDeviceError = new CdifError(error.message);
      logger.error(cdifDevice.lastDeviceError);
      if (options.enableVerifyAndPublish !== true) return;
      // fall through in case of we are verifying a module
    }
    if (m == null) {
      cdifDevice.lastDeviceError = new CdifError('unknown module for device: ' + cdifDevice.spec.device.friendlyName);
      logger.error(cdifDevice.lastDeviceError);
      if (options.enableVerifyAndPublish !== true) return;
    }

    cdifDevice.getHWAddress(function(err, addr) {
      var hwAddr;
      var deviceUUID;
      if (!err) {
        hwAddr = addr;
        deviceDB.getDeviceUUIDFromHWAddr(hwAddr, function(err, data) {
          if (err) {
            cdifDevice.lastDeviceError = new CdifError(err);
            logger.error(cdifDevice.lastDeviceError);
            if (options.enableVerifyAndPublish !== true) return;
          }
          if (!data) {
            deviceUUID = uuid.v4();
            deviceDB.setDeviceUUID(hwAddr, deviceUUID, function(err) {
              if (err) {
                cdifDevice.lastDeviceError = new CdifError('cannot insert address record for device:' + cdifDevice.spec.device.friendlyName);
                logger.error(cdifDevice.lastDeviceError);
                if (options.enableVerifyAndPublish !== true) return;
              }
            });
          } else {
            deviceUUID = data.uuid;
          }
          deviceDB.setSpecForDevice(hwAddr, JSON.stringify(cdifDevice.spec));
          // TODO: handle device offline and purge dead devices
          cdifDevice.module   = m;
          cdifDevice.auth     = _this.deviceAuth;
          cdifDevice.hwAddr   = hwAddr;
          cdifDevice.deviceID = deviceUUID;
          cdifDevice.online   = true;

          //it could return a new device object instance with initial states here
          //module install route rely on this to create new device object
          logger.info('new device online: ' + cdifDevice.deviceID);
          _this.deviceMap[deviceUUID] = cdifDevice;
        });
      } else {
        cdifDevice.lastDeviceError = new CdifError('cannot get HW address for device: ' + cdifDevice.spec.device.friendlyName);
        logger.error(cdifDevice.lastDeviceError);
      }
    });
  });
};

// for now this is not triggered
DeviceManager.prototype.onDeviceOffline = function(cdifDevice, m) {
  logger.error('device offline: ' + cdifDevice.spec.device.friendlyName);
  cdifDevice.online = false;
};

// purge all device objects which are managed by the unloaded module
DeviceManager.prototype.onPurgeDevice = function(m) {
  for (var deviceID in this.deviceMap) {
    if (this.deviceMap[deviceID].module === m) {
      delete this.deviceMap[deviceID];
      logger.info('device purged: ' + deviceID);
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

      this.resolveSchemaInfo(deviceInfo);

      if (deviceInfo.deviceErrorMessage != null) {
        hasError = true;
      } else if (cdifDevice.lastDeviceError != null) {
        hasError = true;
        deviceInfo.deviceErrorMessage = cdifDevice.lastDeviceError.message;
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
  if (cdifDevice.spec.device.userAuth === true) {
    // make sure this is sync
    this.deviceAuth.verifyAccess(cdifDevice, cdifDevice.secret, token, callback);
  } else {
    callback(null);
  }
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
    cdifDevice.lastDeviceError = new CdifError('lastDeviceError is CDIF reserved field for device object');
    logger.error(cdifDevice.lastDeviceError);
    return false;
  }
  if (!(cdifDevice instanceof CdifDevice)) {
    cdifDevice.lastDeviceError = new CdifError('device object is not an instance of CDIF device');
    logger.error(cdifDevice.lastDeviceError);
    return false;
  }
  //TODO: this check can be omitted after we save device info in the global device DB
  if (typeof(cdifDevice._getHWAddress) !== 'function') {
    cdifDevice.lastDeviceError = new CdifError('device interface mismatch, device object must implement _getHWAddress function');
    logger.error(cdifDevice.lastDeviceError);
    return false;
  }
  return true;
};

// dereference all schemas in the device spec, only used to verify a package
// and return the full device API information to the client
// if any error occurs, fill in the deviceInfo.deviceErrorMessage
DeviceManager.prototype.resolveSchemaInfo = function(deviceInfo) {

};

module.exports = DeviceManager;
