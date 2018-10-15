var events      = require('events');
var util        = require('util');
var UUID        = require('uuid-1345');
var CdifDevice  = require('./cdif-device');
var validator   = require('./validator');
var LOG         = require('./logger');
var options     = require('../lib/cli-options');
var OAuthDevice = require('./oauth/oauth');
var CdifError   = require('./cdif-error').CdifError;
var DeviceError = require('./cdif-error').DeviceError;

var userAuth    = require('./user-auth');

var Worker         = require('worker_threads').Worker;
var isMainThread   = require('worker_threads').isMainThread;
var WorkerMessage  = require('./worker-message');

function DeviceManager(mm) {
  this.deviceMap     = {};
  this.moduleManager = mm;

  this.allDevicesLoaded = false;
  this.notifyDeviceLoad = {};

  //this instance is used in child thread only, which
  //send its message through parent port and doesn't need to specify worker instance
  this.workerMessage  = new WorkerMessage(null);

  this.moduleManager.on('deviceonline',        this.onDeviceOnline.bind(this));
  this.moduleManager.on('deviceoffline',       this.onDeviceOffline.bind(this));
  this.moduleManager.on('purgedevice',         this.onPurgeDevice.bind(this));
  this.moduleManager.on('querydevicelist',     this.onQueryDeviceList.bind(this));
  this.moduleManager.on('modulediscovering',   this.onModuleDiscovering.bind(this));
  this.moduleManager.on('allmodulediscovered', this.onAllModulesDiscovered.bind(this));
  this.moduleManager.on('workerloaded',        this.onWorkerLoaded.bind(this));

  this.on('discoverall',     this.onDiscoverAll.bind(this));
  this.on('stopdiscoverall', this.onStopDiscoverAll.bind(this));
  this.on('devicelist',      this.onGetDiscoveredDeviceList.bind(this));
  this.on('invokeaction',    this.onInvokeDeviceAction.bind(this));
  this.on('getspec',         this.onGetDeviceSpec.bind(this));
  this.on('devicestate',     this.onGetDeviceState.bind(this));
  this.on('subscribe',       this.onEventSubscribe.bind(this));
  this.on('unsubscribe',     this.onEventUnsubscribe.bind(this));
  this.on('getschema',       this.onGetDeviceSchema.bind(this));
  this.on('invokecallback',  this.onInvokeDeviceCallback.bind(this));
  this.on('querydevice',     this.onQueryDevice.bind(this));
}

util.inherits(DeviceManager, events.EventEmitter);

DeviceManager.prototype.onDeviceOnline = function(cdifDevice, moduleInstance, moduleName) {
  if (cdifDevice.oauth_version === '1.0' || cdifDevice.oauth_version === '2.0') {
    var oauth = new OAuthDevice(cdifDevice);
    oauth.createOAuthDevice();
  }

  if (this.checkDeviceInterface(cdifDevice) === false) {
    if (options.verifyModule !== true) return;       // fall through in case of we are verifying a module
  }

  validator.validateDeviceSpec(cdifDevice.spec, function(error) {
    if (error) {
      LOG.DE(cdifDevice, new CdifError('DEVICE_SPEC_VALIDATION_FAIL', error.message));
      if (options.verifyModule !== true) return;       // fall through in case of we are verifying a module
    }
    if (moduleInstance == null) {
      LOG.DE(cdifDevice, new CdifError('INVALID_MODULE_INSTANCE', cdifDevice.spec.device.friendlyName));
      if (options.verifyModule !== true) return;      // fall through in case of we are verifying a module
    }

    UUID.v5({
        namespace: UUID.namespace.url,
        name: 'https://registry.apemesh.com/packages/' + moduleName + '@' + cdifDevice.spec.device.friendlyName
    }, function (err, uuid) {
        if (err) {
          LOG.DE(cdifDevice, new CdifError('DEVICE_ID_GENERATION_FAIL', err.message));
          if (options.verifyModule !== true) return;      // fall through in case of we are verifying a module
        }

        if(this.deviceMap[uuid] != null) {
          if (this.deviceMap[uuid].module === moduleInstance) {
            LOG.DE(cdifDevice, new CdifError('DEVICE_OBJECT_CONFLICT'));
            if (options.verifyModule !== true) return;      // fall through in case of we are verifying a module
          }
        }

        cdifDevice.module     = moduleInstance;
        cdifDevice.moduleName = moduleName;
        cdifDevice.deviceID   = uuid;
        cdifDevice.online     = true;

        // below information is added to spec and can be used when adding device info to the database
        cdifDevice.spec.device.deviceID = uuid;
        LOG.I('new device online: ' + uuid);
        this.deviceMap[uuid] = cdifDevice;

        if (!isMainThread) {
          this.workerMessage.sendDeviceOnlineMessageToParent({deviceID: uuid, spec: cdifDevice.spec, moduleName: moduleName});
        }

        //under worker thread mode, code below is never run in main thread, and it has no effect in child thread
        //because notifyDeviceLoad[uuid] would always be null
        // TODO: for the notifyDeviceLoad callback, send message to device's thread
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

DeviceManager.prototype.sendDeviceQueryMessageToParent = function(deviceID, callback) {
  // see 'query-device-reply' message handler in app-sandbox and callback def in query-device.js
  // callback receives err and spec and return
  return this.workerMessage.sendDeviceQueryMessageToParent(deviceID, callback);
};

DeviceManager.prototype.sendActionInvokeMessageToParent = function(appKey, deviceID, serviceID, actionName, args, callback) {
  return this.workerMessage.sendActionInvokeMessageToParent(appKey, deviceID, serviceID, actionName, args, callback);
};

// install deviceonline event handler after worker loaded the module
DeviceManager.prototype.onWorkerLoaded = function(workerMessage) {
  if (workerMessage == null) return;
  workerMessage.on('deviceonline', function(msg, wm) {
    var deviceID   = msg.data.deviceID;
    var spec       = msg.data.spec;
    var moduleName = msg.data.moduleName;

    wm.moduleName = moduleName;
    // we need to be able to handle multi device instances in the same module
    // we need this to be able to handle device-list call
    wm.deviceList[deviceID] = spec;

    wm.online = true; // to make ensureDeviceState happy
    if (deviceID != null) {
      //instead of cdifDevice we save workerMessage instance to deviceMap so we can send msg to it
      //in case one module contains multiple devices,
      //one wm.deviceList can hold multiple deviceID, and multiple deviceMap[deviceID] can refer to the same wm instance
      this.deviceMap[deviceID] = wm;
    }

    if (this.allDevicesLoaded === false) {
      if (this.notifyDeviceLoad[deviceID] != null) {
        for (var i = 0; i < this.notifyDeviceLoad[deviceID].length; i++) {
          //see notifyDeviceLoad definition in queryDeviceForChild() method below
          var workerMsg = this.notifyDeviceLoad[deviceID][i].wm;
          var msgID     = this.notifyDeviceLoad[deviceID][i].msgID;

          workerMsg.sendDeviceQueryReplyToChild({msgID: msgID, errMsg: null, spec: spec});
        }
        delete this.notifyDeviceLoad[deviceID];
      }
    }
  }.bind(this));

  workerMessage.on('querydevice', function(message, wm) {
    var deviceID = message.deviceID;
    var msgID    = message.id;

    this.queryDeviceForChild(deviceID, msgID, wm);
  }.bind(this));

  workerMessage.on('invokeforeignaction', function(message, wm) {
    var msgID = message.id;

    var appKey     = message.data.appKey;
    var deviceID   = message.data.deviceID;
    var serviceID  = message.data.serviceID;
    var actionName = message.data.actionName;
    var args       = message.data.args;

    this.sendInvokeActionMessageToWorker(appKey, deviceID, serviceID, actionName, args, msgID, wm);
  }.bind(this));
};

//here callerWM represents caller's workerMessage instance
DeviceManager.prototype.sendInvokeActionMessageToWorker = function(appKey, deviceID, serviceID, actionName, args, msgID, callerWM) {
  //find out callee's workerMessage instance
  var calleeWM = this.deviceMap[deviceID];

  if (calleeWM == null) {
    return callerWM.sendActionInvokeReplyToChild({msgID: msgID, errMsg: 'device not found in map', data: null});
  }


  var localCB = function(err, data) {
    if (err != null) {
      return callerWM.sendActionInvokeReplyToChild({msgID: msgID, errMsg: err.message, data: data});
    }
    return callerWM.sendActionInvokeReplyToChild({msgID: msgID, errMsg: null, data: data});
  };


  userAuth(null, null, deviceID, appKey, serviceID, actionName, localCB, function(err, session) {
    if (err) return callerWM.sendActionInvokeReplyToChild({msgID: msgID, errMsg: err.message, data: null});

    session.setDeviceTimer(calleeWM, function(error, device, timer) {
      calleeWM.sendInvokeActionMessage({deviceID: deviceID, serviceID: serviceID, actionName: actionName, args: args}, function(err, data) {
        return this.callback(null, data);
      }.bind(this));
    }.bind(session));
  });
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
  if (options.workerThread === true && isMainThread === true) LOG.I('setting allDevicesLoaded to true');

  this.allDevicesLoaded = true;

  if (options.workerThread !== true && isMainThread === true) {
    // non worker thread mode
    for (var deviceID in this.notifyDeviceLoad) {
      var arr = this.notifyDeviceLoad[deviceID];
      for (var i = 0; i < arr.length; i++) {
        var cb = arr[i];
        cb(new Error('未知应用'), null);
      }
      delete this.notifyDeviceLoad[deviceID];
    }
  } else if (options.workerThread === true && isMainThread === true) {
    // worker thread mode
    for (var deviceID in this.notifyDeviceLoad) {
      var arr = this.notifyDeviceLoad[deviceID];
      for (var i = 0; i < arr.length; i++) {
        var workerMessage = arr[i].wm;
        var msgID = arr[i].msgID;
        workerMessage.sendDeviceQueryReplyToChild({msgID: msgID, errMsg: '未知应用', spec: null});
      }
      delete this.notifyDeviceLoad[deviceID];
    }
  }
};

// purge all device objects which are managed by the unloaded module
// under worker thread mode moduleInstance represents a workerMessage instance
DeviceManager.prototype.onPurgeDevice = function(moduleInstance, callback) {
  if (options.workerThread === true && isMainThread === true) {
    for (var deviceID in this.deviceMap) {
      if (this.deviceMap[deviceID] === moduleInstance) {
        delete moduleInstance.deviceList[deviceID];
        delete this.deviceMap[deviceID];
        // do not repeat the log in main thread
        // LOG.I('device purged: ' + deviceID);

        //notifier target has died, do not notify him again
        for (var id in this.notifyDeviceLoad) {
          for (var i = 0; i < this.notifyDeviceLoad[id].length; i++) {
            if (moduleInstance === this.notifyDeviceLoad[id][i].wm) {
              //TODO: delete it from notify array, the array can contain multiple entry of same workerMessage instance
              LOG.I('AAAA');
            }
          }
        }
      }
    }
  } else {
    for (var deviceID in this.deviceMap) {
      if (this.deviceMap[deviceID].module === moduleInstance) {
        delete this.deviceMap[deviceID];
        LOG.I('device purged: ' + deviceID);
      }
    }
  }
  callback();
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
  if (typeof(session) === 'function') return session(null);
  session.callbackWithoutTimer(null);
};

DeviceManager.prototype.onStopDiscoverAll = function(session) {
  this.moduleManager.stopDiscoverAllDevices();
  if (typeof(session) === 'function') return session(null);
  session.callbackWithoutTimer(null);
};

DeviceManager.prototype.onGetDiscoveredDeviceList = function(session) {
  var deviceList = [];
  for (var i in this.deviceMap) {
    var cdifDevice = this.deviceMap[i];

    if (cdifDevice instanceof WorkerMessage) {
      for (var i in cdifDevice.deviceList) {
        var desc = JSON.parse(JSON.stringify(cdifDevice.deviceList[i]));
        desc.device.serviceList = {};
        deviceList.push(desc);
      }
    } else {
      if (cdifDevice.spec) {
        //this is ugly but the easiest way to handle this request
        var desc = JSON.parse(JSON.stringify(cdifDevice.spec));
        desc.device.serviceList = {};
        deviceList.push(desc);
      }
    }
  }
  session.callbackWithoutTimer(null, deviceList);
};

//under worker mode cdifDevice actually represents a workerMessage instance
DeviceManager.prototype.ensureDeviceState = function(deviceID, token, callback) {
  var cdifDevice = this.deviceMap[deviceID];

  if (options.workerThread === true && isMainThread === true) {
    //for now we assume under worker mode all devices running inside workers
    if (!(cdifDevice instanceof WorkerMessage)) return callback(new CdifError('DEVICE_NOT_FOUND', deviceID));
  }

  if (cdifDevice == null) {  // check null or undefined
    return callback(new CdifError('DEVICE_NOT_FOUND', deviceID));
  }

  if (cdifDevice.online === false) {
    return callback(new CdifError('DEVICE_OFFLINE'));
  }

  callback(null, cdifDevice);
};

DeviceManager.prototype.onInvokeDeviceAction = function(deviceID, serviceID, actionName, args, token, session) {
  this.ensureDeviceState(deviceID, token, function(err, cdifDevice) {
    if (err) {
      if (typeof(session) === 'function') {
        return session(err, null);
      }
      return session.callbackWithoutTimer(err, null);
    }

    //in child thread session object represents a callback function
    if (typeof(session) === 'function') {
      try {
        cdifDevice.deviceControl(serviceID, actionName, args, session);
      } catch (e) {
        return session(new DeviceError('DEVICE_ACTION_CALL_FAIL', e.message), null);
      }
    } else {
      session.setDeviceTimer(cdifDevice, function(error, device, timer) {
        try {
          if (options.workerThread === true && isMainThread === true) {
            //have to delete args.ctx here because JS object can't be carried to child thread...
            if (args.ctx) delete args.ctx;
            device.sendInvokeActionMessage({deviceID: deviceID, serviceID: serviceID, actionName: actionName, args: args}, function(err, data) {
              if (err) return this.callback(new DeviceError(err.message), data);
              return this.callback(null, data);
            }.bind(this));
          } else {
            device.deviceControl(serviceID, actionName, args, this);
          }
        } catch (e) {
          return this.callback(new DeviceError('DEVICE_ACTION_CALL_FAIL', e.message), null);
        }
      }.bind(session));
    }
  });
};

DeviceManager.prototype.onGetDeviceSpec = function(deviceID, token, session) {
  this.ensureDeviceState(deviceID, token, function(err, cdifDevice) {
    if (err) {
      if (typeof(session) === 'function') {
        return session(err, null);
      }
      return session.callbackWithoutTimer(err, null);
    }

    //in child thread session object represents a callback function
    if (typeof(session) === 'function') {
      return cdifDevice.getDeviceSpec(session);
    }

    session.setDeviceTimer(cdifDevice, function(error, device, timer) {
      if (options.workerThread === true && isMainThread === true) {
        device.sendGetSpecMessage({deviceID: deviceID}, function(err, data) {
          if (err) return this.callback(new DeviceError(err.message), data);
          return this.callback(null, data);
        }.bind(this));
      } else {
        return device.getDeviceSpec(this);
      }
    }.bind(session));
  });
};

DeviceManager.prototype.onGetDeviceState = function(deviceID, serviceID, token, session) {
  this.ensureDeviceState(deviceID, token, function(err, cdifDevice) {
    if (err) return session.callbackWithoutTimer(err, null);

    session.setDeviceTimer(cdifDevice, function(error, device, timer) {
      return device.getServiceStates(serviceID, session);
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
    if (err) {
      if (typeof(session) === 'function') {
        return session(err, null);
      }
      return session.callbackWithoutTimer(err, null);
    }

    //in child thread session object represents a callback function
    if (typeof(session) === 'function') {
      cdifDevice.resolveSchemaFromPath(path, null, function(err, self, data) {
        return session(err, data);
      });
    } else {
      session.setDeviceTimer(cdifDevice, function(error, device, timer) {
        if (options.workerThread === true && isMainThread === true) {
          device.sendGetDeviceSchemaMessage({deviceID: deviceID, path: path}, function(err, data) {
            if (err) return this.callback(new DeviceError(err.message), data);
            return this.callback(null, data);
          }.bind(this));
        } else {
          device.resolveSchemaFromPath(path, null, function(err, self, data) {
            return this.callback(err, data);
          }.bind(this));
        }
      }.bind(session));
    }
  });
};

DeviceManager.prototype.onInvokeDeviceCallback = function(deviceID, path, data, token, session) {
  this.ensureDeviceState(deviceID, token, function(err, cdifDevice) {
    if (err) {
      if (typeof(session) === 'function') {
        return session(err, null);
      }
      return session.callbackWithoutTimer(err, null);
    }

    //in child thread session object represents a callback function
    if (typeof(session) === 'function') {
      try {
        cdifDevice.invokeDeviceCallback(path, data, session);
      } catch (e) {
        session(new DeviceError('DEVICE_INVOKE_CALLBACK_FAIL', e.message), null);
      }
    } else {
      session.setDeviceTimer(cdifDevice, function(error, device, timer) {
        try {
          if (options.workerThread === true && isMainThread === true) {
            device.sendInvokeDeviceCallbackMessage({deviceID: deviceID, path: path, data: data}, function(err, data) {
              if (err) return this.callback(new DeviceError(err.message), data);
              return this.callback(null, data);
            }.bind(this));
          } else {
            device.invokeDeviceCallback(path, data, this);
          }
        } catch (e) {
          this.callback(new DeviceError('DEVICE_INVOKE_CALLBACK_FAIL', e.message), null);
        }
      }.bind(session));
    }
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
// and return the full device API spec including resolved schema contents to the client
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
};

//query specific deviceID for child thread
DeviceManager.prototype.queryDeviceForChild = function(deviceID, msgID, workerMessage) {
  this.ensureDeviceState(deviceID, null, function(err, cdifDevice) {
    if (err == null) {
      var spec = cdifDevice.deviceList[deviceID];
      return workerMessage.sendDeviceQueryReplyToChild({msgID: msgID, errMsg: null, spec: spec});
    }

    // err not null, but all devices discovered
    if (this.allDevicesLoaded === true) {
      return workerMessage.sendDeviceQueryReplyToChild({msgID: msgID, errMsg: err.message, spec: null});
    }

    // err not null, but still discovering, so we delay notification by saving it
    if (this.notifyDeviceLoad[deviceID] == null) {
      this.notifyDeviceLoad[deviceID] = [];
    }
    this.notifyDeviceLoad[deviceID].push({msgID: msgID, wm: workerMessage});
  }.bind(this));
}

DeviceManager.prototype.onModuleDiscovering = function() {
  if (options.workerThread === true && isMainThread === true) LOG.I('setting allDevicesLoaded to false');
  this.allDevicesLoaded = false; // temporarily set this flag to false during module discovering
};


module.exports = DeviceManager;
