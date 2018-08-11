var Worker         = require('worker_threads').Worker;
var isMainThread   = require('worker_threads').isMainThread;
var MessageChannel = require('worker_threads').MessageChannel;
var MessagePort    = require('worker_threads').MessagePort;
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
          if (err) return parentPort.postMessage({errMsg: err.message, data: null});
          return parentPort.postMessage({id: msg.id, errMsg: null, data: null});
        });
      }
    }

    // setTimeout(function() {
    //   parentPort.postMessage({errMsg: null, data: {output: {result: value.serviceID}}});
    // }, 3000);
  });
}

