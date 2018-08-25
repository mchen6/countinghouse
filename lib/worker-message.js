var Worker         = require('worker_threads').Worker;
var isMainThread   = require('worker_threads').isMainThread;
var parentPort     = require('worker_threads').parentPort;

var events         = require('events');
var util           = require('util');

function WorkerMessage(worker) {
  this.msgQueue = {};
  this.msgID = 0;
  this.worker = worker;
  this.deviceList = [];
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
}

// invoke in main thread
WorkerMessage.prototype.sendMessageToWorker = function(message, callback) {
  if (this.worker != null) {
    var id = this.msgID;

    message.id = id;
    this.msgQueue[id] = callback;
    this.msgID++;
    this.worker.postMessage(message);
  }
};

// invoke in main thread
WorkerMessage.prototype.onWorkerMessage = function(msg) {
  var id = msg.id;

  if (id == null) return;
  if (id === 'deviceonline') return this.emit('deviceonline', msg, this);

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
  //or else discard this message
};




// invoke from worker to send an independent device online message, not as a reply
// to previous msg from parent, in this case we set special msg id to deviceonline
WorkerMessage.prototype.sendDeviceOnlineMessageToParent = function(msg) {
  return this.sendMessageToParent('deviceonline', null, msg);
};

//invoke from worker to reply a message to parent
WorkerMessage.prototype.sendMessageToParent = function(id, err, data) {
  if (err) return parentPort.postMessage({id: id, errMsg: err.message, data: data});
  return parentPort.postMessage({id: id, errMsg: null, data: data});
};

module.exports = WorkerMessage;