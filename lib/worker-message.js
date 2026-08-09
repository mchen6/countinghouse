//TODO: consider replace bson with bson-ext native addon to increase message passing performance
var Worker         = require('worker_threads').Worker;
var isMainThread   = require('worker_threads').isMainThread;
var parentPort     = require('worker_threads').parentPort;

var events         = require('events');
var util           = require('util');

var monitor       = require('./monitor');

function WorkerMessage(worker) {
  this.msgQueue = {};
  this.msgID = 0;
  this.worker = worker;
  this.deviceList = {};    // deviceID as key, store specs for each device object hosted by the worker thread
  this.rateLimiters = {};  // deviceID as key, store rate limiters for each device object hosted by the worker thread
  this.moduleName   = null;
  this.packageInfo  = null;
  this.modulePath   = null;
  // child thread will have null worker field
  if (this.worker != null) this.worker.on('message', this.onWorkerMessage.bind(this));
}

util.inherits(WorkerMessage, events.EventEmitter);

// invoke from main thread
WorkerMessage.prototype.sendLoadModuleMessage = function(message, callback) {
  message.command = 'load-module';
  this.sendMessageToWorker(message, callback);
};

WorkerMessage.prototype.sendUnloadModuleMessage = function(message, callback) {
  message.command = 'unload-module';
  this.sendMessageToWorker(message, callback);
};

// invoke from main thread
WorkerMessage.prototype.sendSetOptionsMessage = function(message, callback) {
  message.command = 'set-options';
  this.sendMessageToWorker(message, callback);
};

// invoke in main thread
WorkerMessage.prototype.sendInvokeActionMessage = function(message, callback) {
  message.command = 'invoke-action';
  this.sendMessageToWorker(message, callback);
};

WorkerMessage.prototype.sendGetSpecMessage = function(message, callback) {
  message.command = 'get-spec';
  this.sendMessageToWorker(message, callback);
};

WorkerMessage.prototype.sendGetDeviceSchemaMessage = function(message, callback) {
  message.command = 'get-schema';
  this.sendMessageToWorker(message, callback);
};

WorkerMessage.prototype.sendInvokeDeviceCallbackMessage = function(message, callback) {
  message.command = 'invoke-device-callback';
  this.sendMessageToWorker(message, callback);
};

//the callback is invoked after stop discover is done
WorkerMessage.prototype.sendDiscoverMessage = function(message, callback) {
  message.command = 'discover-device';
  this.sendMessageToWorker(message, callback);
};

// message contains: {msgID: msgID, errMsg: errMsg, spec: spec}
WorkerMessage.prototype.sendDeviceQueryReplyToChild = function(message) {
  message.command = 'query-device-reply';
  this.sendMessageToWorker(message, null);
};

// message contains: {msgID: msgID, errMsg: errMsg}
WorkerMessage.prototype.sendDeviceLogReplyToChild = function(message) {
  message.command = 'device-log-reply';
  this.sendMessageToWorker(message, null);
};

WorkerMessage.prototype.sendRedisCommandReplyToChild = function(message) {
  message.command = 'redis-command-reply';
  this.sendMessageToWorker(message, null);
}

WorkerMessage.prototype.sendGetJobInfoReplyToChild = function(message) {
  message.command = 'get-job-info-reply';
  this.sendMessageToWorker(message, null);
}

// --- direct peer channels (docs/direct-peer-channels-design.md), main -> child ---

// D1: told to the *caller* worker A -- either a fresh port (new pair, `port`
// present, transferred) or a bare ack that a previously-granted port for
// this worker pair should now also be used for `targetDeviceID` (no new
// MessageChannel, `port` omitted). See lib/peer-channel-broker.js#grant.
WorkerMessage.prototype.sendPeerChannelGrantToChild = function(message, port) {
  message.command = 'peer-channel-grant';
  if (this.worker == null) return;
  if (port != null) return this.worker.postMessage(message, [port]);
  return this.worker.postMessage(message);
};

// D3: told to the caller worker A when brokering was denied (unknown
// device, self-target, or the userAuth check failed).
WorkerMessage.prototype.sendPeerChannelDenyToChild = function(message) {
  message.command = 'peer-channel-deny';
  if (this.worker != null) this.worker.postMessage(message);
};

// D1: told to the *callee* worker B -- always carries a fresh port (B only
// ever learns about a peer channel when a brand new one is created for it;
// see lib/peer-channel-broker.js#grant's "already connected" branch, which
// only re-notifies A, not B, since B's existing handler already accepts
// peer-invoke for any deviceID it hosts).
WorkerMessage.prototype.sendPeerChannelOpenToChild = function(message, port) {
  message.command = 'peer-channel-open';
  message.port     = port; // must be on the message itself, not just in the transferList, or the receiving side has nothing to read msg.port from
  if (this.worker != null) this.worker.postMessage(message, [port]);
};

// D4: told to whichever worker did NOT trigger the reload/unload/exit, so
// it can drop its now-stale cached port for the affected workerId.
WorkerMessage.prototype.sendPeerInvalidateToChild = function(message) {
  message.command = 'peer-invalidate';
  if (this.worker != null) this.worker.postMessage(message);
};

// message contains: {msgID: msgID, errMsg: errMsg, data: data}
WorkerMessage.prototype.sendActionInvokeReplyToChild = function(message) {
  message.command = 'invoke-action-reply';
  this.sendMessageToWorker(message, null);
}

// invoke in main thread, message handler defined in app-sandbox
WorkerMessage.prototype.sendMessageToWorker = function(message, callback) {
  if (this.worker != null) {
    //callback null indicates this message doesn't need reply
    //usually this is a reply to child initiated message
    if (callback == null) return this.worker.postMessage(message);

    var id = this.msgID;
    message.id = id;
    this.msgQueue[id] = callback;
    this.msgID++;

  // https://nolanlawson.com/2016/02/29/high-performance-web-worker-messages/ said sending full stringifyied message is faster than sending raw objects
  // we need to review this in the future
    this.worker.postMessage(message);
  }
};

// a message sending from child to parent has following fields:
// {id:       message id,
//  category: "child" or "reply", indicates child created message or reply message
//  command:  null for reply category, string name of the command for child message
//  errMsg:   null for child created message, contains error information for reply message
//  data:     contains the data sending to parent
// }

// invoke in main thread
WorkerMessage.prototype.onWorkerMessage = function(msg) {
  var id = msg.id;

  if (id == null) return;

  //deviceonline, jobprogress and heapstat msg are origined from childs and doesn't have associated parent created callbacks
  if (id === 'deviceonline') return this.emit('deviceonline', msg, this);
  if (id === 'jobprogress')  return this.emit('jobprogress', msg, this);
  if (id === 'heapstat') {
    return monitor.sendHeapStatMessageToParentController(this.deviceList, msg);
  }

  if (msg.category === 'reply') {
    if (this.msgQueue[id] != null) {
      var callback = this.msgQueue[id];
      if (callback == null || typeof(callback) !== 'function') return;

      if (msg.errMsg != null) {
        var replyErr = new Error(msg.errMsg);
        // preserve the original error-info.json code (locale-independent)
        // across the postMessage boundary -- without this, every error
        // reconstructed here only carries the already locale-formatted
        // message text, which breaks any caller trying to re-wrap it into a
        // new CHError/DeviceError with a meaningful `code`.
        if (msg.errCode != null) replyErr.code = msg.errCode;
        callback(replyErr, msg.data);
      } else {
        callback(null, msg.data);
      }
      delete this.msgQueue[id];
    }
  } else if (msg.category === 'child') {
    if (msg.command == null) return;

    switch(msg.command) {
      case 'querydevice': {
        var deviceID = msg.data;
        this.emit('querydevice', {deviceID: deviceID, id: id}, this);
        break;
      }
      case 'invokeforeignaction': {
        this.emit('invokeforeignaction', {data: msg.data, id: id}, this);
        break;
      }
      case 'devicelog': {
        this.emit('devicelog', {data: msg.data, id: id}, this);
        break;
      }
      case 'rediscommand': {
        this.emit('rediscommand', {data: msg.data, id: id}, this);
        break;
      }
      case 'getjobinfo': {
        this.emit('getjobinfo', {data: msg.data, id: id}, this);
        break;
      }
      // direct peer channels (docs/direct-peer-channels-design.md), child -> main
      case 'peer-channel-request': {
        this.emit('peer-channel-request', {data: msg.data, id: id}, this);
        break;
      }
      case 'peer-metering': {
        this.emit('peer-metering', {data: msg.data, id: id}, this);
        break;
      }
      case 'peer-self-invalidate': {
        this.emit('peer-self-invalidate', {id: id}, this);
        break;
      }
    }
  }
  //or else discard this message
};

// invoke from worker to send an independent device online message, not as a reply
// to previous msg from parent, in this case we set special msg id to deviceonline
WorkerMessage.prototype.sendDeviceOnlineMessageToParent = function(msg) {
  return this.sendMessageToParent('deviceonline', null, msg);
};

WorkerMessage.prototype.sendHeapStatisticsMessageToParent = function(msg) {
  return this.sendMessageToParent('heapstat', null, msg);
}

// invoke in child thread only
WorkerMessage.prototype.sendJobProgressMessageToParent = function(msg) {
  return this.sendMessageToParent('jobprogress', null, msg);
};

//invoke from worker to reply a message to parent, or a message initiated in worker and doesn't expect reply (applies to deviceonline, jobprgress, heapstats etc events only)
WorkerMessage.prototype.sendMessageToParent = function(id, err, data) {
  if (err) return parentPort.postMessage({command: null, id: id, category: 'reply', errMsg: err.message, errCode: err.code || null, data: data});   //reply category indicates a child reply message
  return          parentPort.postMessage({command: null, id: id, category: 'reply', errMsg: null,        errCode: null,             data: data});
};

// below calls are invoked from child worker threads only, and expect callbacks to child worker threads
WorkerMessage.prototype.sendDeviceQueryMessageToParent = function(deviceID, callback) {
  var message = {};
  message.command = 'querydevice';
  message.data = deviceID;

  return this.sendActiveMessageToParent(message, callback);
};

// invoke in child thread only
WorkerMessage.prototype.sendDeviceLogMessageToParent = function(deviceID, data, timestamp, callback) {
  var message = {};
  message.command = 'devicelog';
  message.data = {deviceID: deviceID, data: data, timestamp: timestamp};

  return this.sendActiveMessageToParent(message, callback);
};

// invoke in child thread only
WorkerMessage.prototype.sendGetJobInfoMessageToParent = function(jobID, callback) {
  var message = {};
  message.command = 'getjobinfo';
  message.data = {jobID: jobID};

  return this.sendActiveMessageToParent(message, callback);
}

// invoke in child thread only
WorkerMessage.prototype.sendRedisCommandToParent = function(commandData, callback) {
  var message = {};
  message.command = 'rediscommand';
  message.data = commandData;  // command data contains op and data field
  return this.sendActiveMessageToParent(message, callback);
};

// invoke in child thread only
WorkerMessage.prototype.sendActionInvokeMessageToParent = function(appKey, deviceID, serviceID, actionName, args, callback) {
  var message = {};
  message.command = 'invokeforeignaction'; // invoke goes to another thread
  message.data = {appKey: appKey, deviceID: deviceID, serviceID: serviceID, actionName: actionName, args: args};

  return this.sendActiveMessageToParent(message, callback);
};

// --- direct peer channels (docs/direct-peer-channels-design.md), child -> main ---
// Both are fire-and-forget (no reply expected, so unlike
// sendActiveMessageToParent below they never touch msgQueue) -- correlation
// happens differently for each: peer-channel-request's eventual grant/deny
// is matched by targetDeviceID (see lib/device-manager.js's
// onPeerChannelGrant/onPeerChannelDeny), and peer-metering has no reply at
// all. `id` still has to be non-null: onWorkerMessage (above) drops any
// message where it's missing, this being a generic requirement of every
// message a worker sends, not something specific to these two.
WorkerMessage.prototype.sendPeerChannelRequestToParent = function(data) {
  var id = this.msgID;
  this.msgID++;
  parentPort.postMessage({id: id, category: 'child', command: 'peer-channel-request', errMsg: null, data: data});
};

WorkerMessage.prototype.sendPeerMeteringToParent = function(data) {
  var id = this.msgID;
  this.msgID++;
  parentPort.postMessage({id: id, category: 'child', command: 'peer-metering', errMsg: null, data: data});
};

// D4: a same-worker in-place module reload (POST /load-module targeting an
// already-loaded module name -- see ModuleManager.prototype.onModuleLoad's
// "module reloaded" branch, reached via loadModuleByWorker's `wm != null`
// path, which reuses the existing Worker/threadId rather than creating a
// new one) purges this worker's own devices *entirely locally* -- the main
// thread's deviceMap/workerId for this worker never changes, so it has no
// other way to learn that any peer channel pointing at this worker is now
// stale. Sent unconditionally from DeviceManager.prototype.onPurgeDevice's
// worker-side branch on every local purge (reload or otherwise) --
// harmless and idempotent if this worker is also mid-crash/unload (the
// port's own native 'close' event covers that case redundantly), so there
// is no need to distinguish reload from other purge reasons here.
WorkerMessage.prototype.sendPeerSelfInvalidateToParent = function() {
  var id = this.msgID;
  this.msgID++;
  parentPort.postMessage({id: id, category: 'child', command: 'peer-self-invalidate', errMsg: null, data: null});
};

// invoke in child thread only, send a child created message and expect reply from parent
WorkerMessage.prototype.sendActiveMessageToParent = function(message, callback) {
  var id = this.msgID;
  message.id = id;
  message.category = 'child';    // child category indicates a child created message
  message.errMsg = null;

  this.msgQueue[id] = callback;
  this.msgID++;

  parentPort.postMessage(message);
};




module.exports = WorkerMessage;