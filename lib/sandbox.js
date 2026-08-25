//workaround worker thread issue which didn't set process.umask as a function
process.umask = function() {};

//TODO: consider replace bson with bson-ext native addon to increase message passing performance
const Worker         = require('worker_threads').Worker;
const isMainThread   = require('worker_threads').isMainThread;
const parentPort     = require('worker_threads').parentPort;

const options        = require('./cli-options');
options.setOptions({});

const LOG = require('./logger');
LOG.createLogger(false);

process.on('uncaughtException', (e) => {
  LOG.E(new Error(`Uncaught exception in worker thread: ${e.stack}`));
});

const ModuleManager = require('./module-manager');
const CdifInterface = require('./countinghouse-interface');

const mm = new ModuleManager();
//device manager instance is created inside cdifInterface
const ci = new CdifInterface(mm);

const dm = ci.deviceManager;

//use device-manager's workerMessage instance to receive message from parent
//each child thread should exactly have only this ONE workerMessage instance
const wm = dm.workerMessage;

const redisAPI        = require('./redis-api');
redisAPI.init(dm); //send in dm instance to get the workerMessage instance in it

// var WorkerMessage = require('./worker-message');
// var workerMessage = new WorkerMessage(null);
global.CHUtil     = require('./countinghouse-util');
global.CHDevice   = require('./countinghouse-device');
global.CHError    = require('./countinghouse-error').CHError;
global.DeviceError  = require('./countinghouse-error').DeviceError;

//manually set CHUtil.redis because when countinghouse-util.js is first time required, redis-api.js isn't loaded and initialized yet
global.CHUtil.redis = redisAPI.client;

if (!isMainThread) {
  parentPort.on('message', (msg) => {
    switch (msg.command) {
      case 'set-options': {
        // MUST disable options.workerThread here because this flag is enabled only in main thread
        // or else main thread will recursively run the load module path
        msg.options.workerThread = false;
        options.setOptions(msg.options);
        return wm.sendMessageToParent(msg.id, null, null);
        break;
      }
      case 'set-composition': {
        // From DeviceManager.prototype.verifyComposition (main thread only,
        // after discovery), relayed via WorkerMessage.prototype.
        // sendSetCompositionMessage. dm.deviceMap here is THIS worker's own
        // map, holding the real CHDevice buildCtx/ctx.call read _composition
        // off of -- not the WorkerMessage proxy the main thread sees.
        const handlerCtx = require('./handler-ctx');
        handlerCtx.setComposition(dm.deviceMap[msg.deviceID],
          {identity: msg.identity, allowed: msg.allowed});
        return wm.sendMessageToParent(msg.id, null, null);
        break;
      }
      case 'load-module': {
        mm.loadModuleFromPath(msg.path, msg.name, msg.version, (err, mi) => {
          return wm.sendMessageToParent(msg.id, err, null);
        });
        break;
      }
      case 'unload-module': {
        mm.unloadModuleExternal(msg.name, () => {
          return wm.sendMessageToParent(msg.id, null, null);
        });
        break;
      }
      case 'invoke-action': {
        ci.invokeDeviceAction(msg.deviceID, msg.serviceID, msg.actionName, msg.args, null, (err, data) => {
          let retData = data;

          if (typeof(data) === 'function') {
            err = new Error('Invoke fail');
            retData = {fault: 'Incorrect return data type', reason: 'Return function type to caller is not allowed'};
          }
          return wm.sendMessageToParent(msg.id, err, retData);
        });
        break;
      }
      case 'get-spec': {
        ci.getDeviceSpec(msg.deviceID, null, (err, data) => {
          return wm.sendMessageToParent(msg.id, err, data);
        });
        break;
      }
      case 'get-schema': {
        ci.getDeviceSchema(msg.deviceID, msg.path, null, (err, data) => {
          return wm.sendMessageToParent(msg.id, err, data);
        });
        break;
      }
      case 'invoke-device-callback': {
        ci.invokeDeviceCallbacks(msg.deviceID, msg.path, msg.data, null, (err, data) => {
          return wm.sendMessageToParent(msg.id, err, data);
        });
        break;
      }
      case 'discover-device': {

        setTimeout(() => {
          ci.stopDiscoverAll(() => {});
          return wm.sendMessageToParent(msg.id, null, null);
        }, 5000);

        ci.discoverAll(() => {});
        break;
      }
      //below *-reply messages are reply to child initiated message, so we take out callback object from message queue and call it
      case 'query-device-reply': {
        // message contains: {msgID: msgID, errMsg: errMsg, spec: spec}
        const id = msg.msgID;

        if (wm.msgQueue[id] != null) {
          const callback = wm.msgQueue[id];
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
        // msg.platformMetering (D5) rides alongside msg.data as a 3rd,
        // additive callback arg -- see
        // DeviceManager.prototype.sendInvokeActionMessageToWorker's own
        // comment for why it's never merged into msg.data itself.
        const id = msg.msgID;
        if (wm.msgQueue[id] != null) {
          const callback = wm.msgQueue[id];
          if (callback != null && typeof(callback) === 'function') {
            if (msg.errMsg != null) {
              callback(new Error(msg.errMsg), msg.data);
            } else {
              callback(null, msg.data, msg.platformMetering);
            }
            delete wm.msgQueue[id];
          }
        }
        break;
      }
      case 'device-log-reply': {
        const id = msg.msgID;

        if (wm.msgQueue[id] != null) {
          const callback = wm.msgQueue[id];
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
        const id = msg.msgID;

        if (wm.msgQueue[id] != null) {
          const callback = wm.msgQueue[id];
          if (callback != null && typeof(callback) === 'function') {
            if (msg.errMsg != null) {
              callback(new Error(msg.errMsg), null);
            } else {
              callback(null, msg.result);
            }
            delete wm.msgQueue[id];
          }
        }
        break;
      }
      case 'get-job-info-reply': {
        // message contains: {msgID: msgID, errMsg: errMsg, job: job}
        const id = msg.msgID;

        if (wm.msgQueue[id] != null) {
          const callback = wm.msgQueue[id];
          if (callback != null && typeof(callback) === 'function') {
            if (msg.errMsg != null) {
              callback(new Error(msg.errMsg), null);
            } else {
              callback(null, msg.job);
            }
            delete wm.msgQueue[id];
          }
        }
        break;
      }
      // direct peer channels (docs/direct-peer-channels-design.md) -- these
      // four are NOT correlated via wm.msgQueue/msg.msgID like the
      // *-reply cases above (peer-channel-request was sent fire-and-forget,
      // see WorkerMessage.prototype.sendPeerChannelRequestToParent); dm's
      // own onPeerChannel* methods correlate by targetDeviceID/workerId
      // instead. See lib/device-manager.js for the actual handling.
      case 'peer-channel-grant': {
        dm.onPeerChannelGrant(msg);
        break;
      }
      case 'peer-channel-deny': {
        dm.onPeerChannelDeny(msg);
        break;
      }
      case 'peer-channel-open': {
        dm.onPeerChannelOpen(msg);
        break;
      }
      case 'peer-invalidate': {
        dm.onPeerInvalidate(msg);
        break;
      }
      // Unlike the four above, this one *is* correlated via wm.msgQueue/
      // msg.msgID, same pattern as get-job-info-reply etc. above -- see
      // WorkerMessage.prototype.sendPeerMeteringRequestToParent.
      case 'peer-metering-reply': {
        // message contains: {msgID: msgID, errMsg: errMsg, meteringResult: meteringResult}
        const id = msg.msgID;

        if (wm.msgQueue[id] != null) {
          const callback = wm.msgQueue[id];
          if (callback != null && typeof(callback) === 'function') {
            if (msg.errMsg != null) {
              callback(new Error(msg.errMsg), null);
            } else {
              callback(null, msg.meteringResult);
            }
            delete wm.msgQueue[id];
          }
        }
        break;
      }
    }
  });
}

