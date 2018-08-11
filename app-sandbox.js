var Worker         = require('worker_threads').Worker;
var isMainThread   = require('worker_threads').isMainThread;
var parentPort     = require('worker_threads').parentPort;

var options        = require('./lib/cli-options');

//TODO: set cli options for worker thread on start, but
// options.enableWorkerThread MUST NOT be set to true
options.setOptions({});

// under worker mode console.log in rewired modules are not available because
// in non-debug mode rewire stripped console.log functions
// rewired modules have to use CdifUtil.deviceLog to print logs
var logger = require('./lib/logger');
logger.createLogger(false);

var workerMessage = require('./lib/worker-message');

var ModuleManager = require('./lib/module-manager');
var CdifInterface = require('./lib/cdif-interface');

var mm = new ModuleManager();
//device manager instance is created inside cdifInterface
var ci = new CdifInterface(mm);

if (!isMainThread) {
  parentPort.on('message', function(msg) {
    switch (msg.command) {
      case 'load-module': {
        mm.loadModuleFromPath(msg.path, msg.name, msg.version, function(err, mi) {
           //unable to send moduleInstane obj to parent, so return null here
           //moduleInstance is only used in verify-module path which is
           //not enabled under production environment
          return workerMessage.replyMessageToParent(msg.id, err, null);
        });
      }
    }
  });
}

