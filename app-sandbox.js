//workaround worker thread issue which didn't set process.umask as a function
process.umask = function() {};

var Worker         = require('worker_threads').Worker;
var isMainThread   = require('worker_threads').isMainThread;
var parentPort     = require('worker_threads').parentPort;
var options        = require('./lib/cli-options');

options.setOptions({});

var LOG = require('./lib/logger');
LOG.createLogger(false);


var workerMessage = require('./lib/worker-message');

var ModuleManager = require('./lib/module-manager');
var CdifInterface = require('./lib/cdif-interface');

var mm = new ModuleManager();
//device manager instance is created inside cdifInterface
var ci = new CdifInterface(mm);


if (!isMainThread) {
  parentPort.on('message', function(msg) {
    switch (msg.command) {
      case 'set-options': {
        // MUST disable options.enableWorkerThread here because this flag is enabled only in main thread
        msg.options.enableWorkerThread = false;
        options.setOptions(msg.options);
        return workerMessage.replyMessageToParent(msg.id, null, null);
        break;
      }
      case 'load-module': {
        mm.loadModuleFromPath(msg.path, msg.name, msg.version, function(err, mi) {
          //TODO: return an ID representing moduleInstance to parent
          //TODO: return loaded deviceList in this module to parent
          //so parent can dispatch device API calls to this worker
          //this can be done by install an event handler in mm
          return workerMessage.replyMessageToParent(msg.id, err, null);
        });
        break;
      }
    }
  });
}

