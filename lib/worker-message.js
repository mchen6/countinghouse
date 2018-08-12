var Worker         = require('worker_threads').Worker;
var isMainThread   = require('worker_threads').isMainThread;
var parentPort     = require('worker_threads').parentPort;

module.exports = {
  msgQueue: {},
  msgID: 0,

  // invoke from main thread
  sendLoadModuleMessage: function(worker, message, callback) {
    message.command = 'load-module';
    this.sendWorkerMessage(worker, message, callback);
  },

  sendSetOptionsMessage: function(worker, message, callback) {
    message.command = 'set-options';
    this.sendWorkerMessage(worker, message, callback);
  },

  // invoke from main thread
  sendWorkerMessage: function(worker, message, callback) {
    var id = this.msgID;
    message.id = id;

    this.msgQueue[id] = {worker: worker, cb: callback};
    this.msgID++;

    worker.postMessage(message);
    worker.once('message', this.onWorkerMessage.bind(this));
  },

  // invoke from main thread
  onWorkerMessage: function(msg) {
    var id = msg.id;
    if (this.msgQueue[id] != null) {
      var callback = this.msgQueue[id].cb;
      var worker = this.msgQueue[id].worker;
      if (callback == null || worker == null) return;

      if (msg.errMsg != null) {
        callback(new Error(msg.errMsg), msg.data);
      } else {
        callback(null, msg.data);
      }
      delete this.msgQueue[id];
    }
    //or else discard this message
  },

  //invoked from worker thread to reply a message to parent
  replyMessageToParent: function(id, err, data) {
    if (err) return parentPort.postMessage({id: id, errMsg: err.message, data: data});
    return parentPort.postMessage({id: id, errMsg: null, data: data});
  }
}