var Worker         = require('worker_threads').Worker;
var isMainThread   = require('worker_threads').isMainThread;
var parentPort     = require('worker_threads').parentPort;

var events         = require('events');
var util           = require('util');

function WorkerMessage(worker) {
  this.msgQueue = {};
  this.msgID = 0;
  this.worker = worker;
  this.deviceList = {};
  this.moduleName = null;
  // child thread will have null worker field
  if (this.worker != null) this.worker.on('message', this.onWorkerMessage.bind(this));
}

util.inherits(WorkerMessage, events.EventEmitter);

// invoke from main thread
WorkerMessage.prototype.sendLoadModuleMessage = function(message, callback) {
  message.command = 'load-module';
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


// invoke in main thread
WorkerMessage.prototype.sendMessageToWorker = function(message, callback) {
  if (this.worker != null) {
    //callback null indicates this message doesn't need reply
    //usually this is a reply to child initiated message
    if (callback == null) this.worker.postMessage(message);

    var id = this.msgID;
    message.id = id;
    this.msgQueue[id] = callback;
    this.msgID++;
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
  if (id === 'deviceonline') return this.emit('deviceonline', msg, this);

  if (msg.category === 'reply') {
    if (this.msgQueue[id] != null) {
      var callback = this.msgQueue[id];
      if (callback == null || typeof(callback) !== 'function') return;

      if (msg.errMsg != null) {
        callback(new Error(msg.errMsg), msg.data);
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
    }
  }
  //or else discard this message
};

// invoke from worker to send an independent device online message, not as a reply
// to previous msg from parent, in this case we set special msg id to deviceonline
WorkerMessage.prototype.sendDeviceOnlineMessageToParent = function(msg) {
  return this.sendMessageToParent('deviceonline', null, msg);
};

//invoke from worker to reply a message to parent
WorkerMessage.prototype.sendMessageToParent = function(id, err, data) {
  var sData = null;

  if (typeof(data) === 'function') return;
  if (typeof(data) === 'object' || Array.isArray(data)) {
    sData = JSON.parse(JSON.stringify(data));
  } else {
    sData = data;
  }

  if (err) return parentPort.postMessage({command: null, id: id, category: 'reply', errMsg: err.message, data: sData});   //reply category indicates a child reply message
  return parentPort.postMessage({command: null, id: id, category: 'reply', errMsg: null, data: sData});
};

// invoke in child thread only
WorkerMessage.prototype.sendDeviceQueryMessageToParent = function(deviceID, callback) {
  var message = {};
  message.command = 'querydevice';
  message.data = deviceID;

  return this.sendActiveMessageToParent(message, callback);
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