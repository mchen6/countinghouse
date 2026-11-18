'use strict';
// bunyan: the main thread's only (createLogger). A worker's logger is
// lib/worker-logger.js, which needs none of it, so a worker never loads
// bunyan (#194's PR 1: no third-party code loads after its lockdown).

//TODO: configurable error log path, per component (child) logging
// A worker's runtime file may log before anything in that worker made a
// logger (a lean worker makes it at boot, #194's PR 1; another worker on the
// first line logged, whichever file logs it): it is then the worker's
// (lib/worker-logger.js), whose records go to the main thread. The main
// thread makes its own at start.
// LOG: this file's exports as made at load, held here, never read back
// through module.exports (module code can replace a file's exports through
// require.cache; Fable's check of #425). A lean worker sets its logger at
// boot and fixes LOG then (lib/lean-worker.js fixOwn), so the requires below
// never run there; another worker (a validator's) makes it on its first line.
function ready() {
  if (LOG.logger == null && threadInfo.isMainThread !== true) require('./worker-logger').createWorkerLogger();
  return LOG.logger;
}
// (read at call time: a test may stand in for a worker)
const threadInfo = require('./thread-info');

const LOG = module.exports = {
  // One logger, to stdout (the main thread's; a worker's is
  // lib/worker-logger.js). --logStream, which once chose a Redis stream
  // here, is gone: both of its branches had become this one.
  createLogger: function() {
    this.logger = require('bunyan').createLogger({
      name: 'countinghouse',
      serializers: {
        de: this.deviceErrorSerializer,
        e:  this.errorSerializer
      },
      streams: [{level: 'info', stream: process.stdout}]
    });
  },
  E: function(errorInfo) {
    ready().error({e: errorInfo});
    return errorInfo;
  },
  DE: function(device, errorInfo) {
    // this takes an error object as input
    if (device != null) {
      device.lastDeviceError = errorInfo;
      if (device.spec) return ready().error({de: {name: device.spec.device.friendlyName, message: errorInfo.message}});
    }
    return ready().error({de: {message: errorInfo.message}});
  },
  W: function(logMessage) {
    ready().warn(logMessage);
    return logMessage;
  },
  I: function(logMessage) {
    // this takes an error message as input
    ready().info(logMessage);
    return logMessage;
  },
  deviceErrorSerializer: function(de) {
    // a worker's record arrives already serialized (lib/worker-output.js)
    if (typeof(de) === 'string') return de;
    return `${de.name}: ${de.message}`;
  },
  errorSerializer: function(e) {
    if (Array.isArray(e) === true) return JSON.stringify(e);
    if (typeof(e) === 'object')    return e.message;
    return e;
  }
};
