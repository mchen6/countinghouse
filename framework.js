var argv          = require('minimist')(process.argv.slice(1));
var options       = require('./lib/cli-options');
var deviceDB      = require('@apemesh/cdif-device-db');
var mkdirp        = require('mkdirp');
var fs            = require('fs');
var JobControl    = require('./lib/job-control');
var packageJson   = require('./package.json');

process.on('uncaughtException', function(e) {
  console.error('Error: ' + e.stack);
});

process.on('warning', function(e) {
  console.warn(e.stack);
});

options.setOptions(argv);

var logger = require('./lib/logger');
logger.createLogger(options.logStream);
var monitor       = require('./lib/monitor');

logger.I('cdif@' + packageJson.version + ' start with options:' + JSON.stringify(options));

try {
  // create module folder
  mkdirp.sync(options.modulePath);
  fs.accessSync(options.modulePath, fs.W_OK);
} catch (e) {
  logger.E(new Error('cannot access module folder: ' + e.message));
  process.exit(-1);
}

deviceDB.init(options.modulePath);

var ModuleManager = require('./lib/module-manager');
var RouteManager  = require('./lib/route-manager');

var mm = new ModuleManager();

var routeManager = new RouteManager(mm);

var dm = routeManager.cdifInterface.deviceManager;

monitor.init(mm, dm);

global.CdifUtil     = require('./lib/cdif-util');
global.CdifDevice   = require('./lib/cdif-device');
global.CdifError    = require('./lib/cdif-error').CdifError;
global.DeviceError  = require('./lib/cdif-error').DeviceError;

var redisAPI = require('./lib/redis-api');
redisAPI.init();

if (options.workerThread === true) JobControl.initJobProcess(routeManager.cdifInterface);

// routeManager.startServer();
mm.loadAllModules();


// forever to restart on crash?
