var Worker         = require('worker_threads').Worker;
var isMainThread   = require('worker_threads').isMainThread;

module.exports = {
  msgQueue: {},
  msgID: 0,

  sendLoadModuleMessage: function(worker, message, callback) {
    message.command = 'load-module';
    this.sendWorkerMessage(worker, message, callback);
  },

  sendWorkerMessage: function(worker, message, callback) {
    var id = this.msgID;
    message.id = id;

    this.msgQueue[id] = {worker: worker, cb: callback};
    this.msgID++;

    worker.postMessage(message);
    worker.once('message', this.onWorkerMessage.bind(this));
  },

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
  }
}