//workaround worker thread issue which didn't set process.umask as a function
process.umask = function() {};

var BSON           = require('bson');
var Worker         = require('worker_threads').Worker;
var isMainThread   = require('worker_threads').isMainThread;
var parentPort     = require('worker_threads').parentPort;

var options        = require('./cli-options');
options.setOptions({});

var LOG = require('./logger');
LOG.createLogger(false);

process.on('uncaughtException', function(e) {
  LOG.E(new Error('Uncaught exception in worker thread: ' + e.stack));
});

var ModuleManager = require('./module-manager');
var CdifInterface = require('./cdif-interface');

var mm = new ModuleManager();
//device manager instance is created inside cdifInterface
var ci = new CdifInterface(mm);

var dm = ci.deviceManager;

//use device-manager's workerMessage instance to receive message from parent
//child thread should exactly have only this ONE workerMessage instance
var wm = dm.workerMessage;

// var WorkerMessage = require('./worker-message');
// var workerMessage = new WorkerMessage(null);
global.CdifUtil     = require('./cdif-util');
global.CdifDevice   = require('./cdif-device');
global.CdifError    = require('./cdif-error').CdifError;
global.DeviceError  = require('./cdif-error').DeviceError;

var redisAPICache   = require('./redis-api-cache');

redisAPICache.init(dm); //send in dm instance to get the workerMessage instance in it

if (!isMainThread) {
  parentPort.on('message', function(msg) {
    switch (msg.command) {
      case 'set-options': {
        // MUST disable options.workerThread here because this flag is enabled only in main thread
        // or else main thread will recursively run the load module path
        msg.options.workerThread = false;
        options.setOptions(msg.options);
        return wm.sendMessageToParent(msg.id, null, null);
        break;
      }
      case 'load-module': {
        mm.loadModuleFromPath(msg.path, msg.name, msg.version, function(err, mi) {
          return wm.sendMessageToParent(msg.id, err, null);
        });
        break;
      }
      case 'unload-module': {
        mm.unloadModuleExternal(msg.name, function() {
          return wm.sendMessageToParent(msg.id, null, null);
        });
        break;
      }
      case 'invoke-action': {
        //deserialize BSON buffer and promote binary data in it as buffer
        if (msg.args.input != null && msg.args.input instanceof Uint8Array) {
          var bufInput = null;
          try {
            bufInput = BSON.deserialize(Buffer.from(msg.args.input), {promoteBuffers: true}).__d;
          } catch (e) {
            return wm.sendMessageToParent(msg.id, e, BSON.serialize({__d: {fault: {reason: 'BSON deserialize fail in worker'}} }));
          }
          msg.args.input = bufInput;
        }
        ci.invokeDeviceAction(msg.deviceID, msg.serviceID, msg.actionName, msg.args, null, function(err, data) {
          var retData = data;

          if (typeof(data) === 'function') {
            err = new Error('Invoke fail');
            retData = {fault: 'Incorrect return data type', reason: 'Return function type to caller is not allowed'};
          }
          // serialize data to bson buffer if it is in object type
          // in worker message handler we will check if this is a buffer and deserialize it
          if (retData != null && (typeof(retData) === 'object' || Array.isArray(retData))) {
            retData = BSON.serialize({__d: retData});
          }
          return wm.sendMessageToParent(msg.id, err, retData);
        });
        break;
      }
      case 'get-spec': {
        ci.getDeviceSpec(msg.deviceID, null, function(err, data) {
          return wm.sendMessageToParent(msg.id, err, data);
        });
        break;
      }
      case 'get-schema': {
        ci.getDeviceSchema(msg.deviceID, msg.path, null, function(err, data) {
          return wm.sendMessageToParent(msg.id, err, data);
        });
        break;
      }
      case 'invoke-device-callback': {
        ci.invokeDeviceCallbacks(msg.deviceID, msg.path, msg.data, null, function(err, data) {
          return wm.sendMessageToParent(msg.id, err, data);
        });
        break;
      }
      case 'discover-device': {

        setTimeout(function() {
          ci.stopDiscoverAll(function() {});
          return wm.sendMessageToParent(msg.id, null, null);
        }, 5000);

        ci.discoverAll(function() {});
        break;
      }
      //below *-reply messages are reply to child initiated message, so we take out callback object from message queue and call it
      case 'query-device-reply': {
        // message contains: {msgID: msgID, errMsg: errMsg, spec: spec}
        var id = msg.msgID;

        if (wm.msgQueue[id] != null) {
          var callback = wm.msgQueue[id];
          if (callback != null && typeof(callback) === 'function') {
            if (msg.errMsg != null) {
              callback(new Error(msg.errMsg), null);
            } else {
              callback(null, msg.spec);
            }
            delete wm.msgQueue[id];
          }
        }
        break;
      }
      case 'invoke-action-reply': {
        var id = msg.msgID;
        if (wm.msgQueue[id] != null) {
          var callback = wm.msgQueue[id];
          if (callback != null && typeof(callback) === 'function') {
            if (msg.data != null && msg.data instanceof Uint8Array) {
              try {
                msg.data = BSON.deserialize(Buffer.from(msg.data), {promoteBuffers: true}).__d;
              } catch (e) {
                msg.errMsg = e.message;
                msg.data = {fault: {reason: 'BSON deserialize fail in worker'}};
              }
            }
            if (msg.errMsg != null) {
              callback(new Error(msg.errMsg), msg.data);
            } else {
              callback(null, msg.data);
            }
            delete wm.msgQueue[id];
          }
        }
        break;
      }
      case 'device-log-reply': {
        var id = msg.msgID;

        if (wm.msgQueue[id] != null) {
          var callback = wm.msgQueue[id];
          if (callback != null && typeof(callback) === 'function') {
            if (msg.errMsg != null) {
              callback(new Error(msg.errMsg));
            } else {
              callback(null);
            }
            delete wm.msgQueue[id];
          }
        }
        break;
      }
      case 'redis-command-reply': {
        // message contains: {msgID: msgID, errMsg: errMsg, result: result}
        var id = msg.msgID;

        if (wm.msgQueue[id] != null) {
          var callback = wm.msgQueue[id];
          if (callback != null && typeof(callback) === 'function') {
            if (msg.errMsg != null) {
              callback(new Error(msg.errMsg), null);
            } else {
              callback(null, msg.result);
            }
            delete wm.msgQueue[id];
          }
        }
      }
    }
  });
}

