var ModuleManager = require('./lib/module-manager');
var RouteManager  = require('./lib/route-manager');
var argv          = require('minimist')(process.argv.slice(1));
var options       = require('./lib/cli-options');
var logger        = require('./lib/logger');
var monitor       = require('./lib/monitor');
var deviceDB      = require('cdif-device-db');
var mkdirp        = require('mkdirp');
var fs            = require('fs');

logger.createLogger();
options.setOptions(argv);

try {
  // create module folder
  mkdirp.sync(options.modulePath);
  fs.accessSync(options.modulePath, fs.W_OK);
} catch (e) {
  logger.E(new Error('cannot access module folder: ' + e.message));
  process.exit(-1);
}

deviceDB.init(options.modulePath);

var mm = new ModuleManager();

monitor.init(mm);

var routeManager = new RouteManager(mm);

routeManager.installRoutes();
mm.loadAllModules();


// forever to restart on crash?
