//workaround worker thread issue which didn't set process.umask as a function
process.umask = function() {};

var Worker         = require('worker_threads').Worker;
var isMainThread   = require('worker_threads').isMainThread;
var parentPort     = require('worker_threads').parentPort;

var options        = require('./lib/cli-options');
options.setOptions({});

var LOG = require('./lib/logger');
LOG.createLogger(false);


var ModuleManager = require('./lib/module-manager');
var CdifInterface = require('./lib/cdif-interface');

var mm = new ModuleManager();
//device manager instance is created inside cdifInterface
var ci = new CdifInterface(mm);


var WorkerMessage = require('./lib/worker-message');
var workerMessage = new WorkerMessage(null);

if (!isMainThread) {
  parentPort.on('message', function(msg) {
    switch (msg.command) {
      case 'set-options': {
        // MUST disable options.workerThread here because this flag is enabled only in main thread
        // or else main thread will recursively run the load module path
        msg.options.workerThread = false;
        options.setOptions(msg.options);
        return workerMessage.sendMessageToParent(msg.id, null, null);
        break;
      }
      case 'load-module': {
        mm.loadModuleFromPath(msg.path, msg.name, msg.version, function(err, mi) {
          return workerMessage.sendMessageToParent(msg.id, err, null);
        });
        break;
      }
      case 'invoke-action': {
        ci.invokeDeviceAction(msg.deviceID, msg.serviceID, msg.actionName, msg.args, null, function(err, data) {
          return workerMessage.sendMessageToParent(msg.id, err, data);
        });
        break;
      }
    }
  });
}

