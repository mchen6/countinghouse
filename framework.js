var argv          = require('minimist')(process.argv.slice(1));
var options       = require('./lib/cli-options');
var deviceDB      = require('./lib/device-db');
var fs            = require('fs');
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

logger.I('countinghouse@' + packageJson.version + ' start with options:' + JSON.stringify(options));

// Eagerly instantiate the configured AuthProvider (lib/auth/) here, at
// startup, rather than lazily on the first authenticated request.
// FileAuthProvider's zero-config demo-key generation (see its own header
// comment) needs to happen now so an operator sees the printed key
// immediately -- with lazy instantiation, nothing ever printed it until
// after someone had already tried (and failed) to make a request with no
// key in hand yet, an unusable chicken-and-egg first-run experience.
// Skipped entirely under --debug, which never consults AuthProvider at
// all (see lib/user-auth.js) -- instantiating it there would be pointless
// and could surprise an operator with an auth.json/demo key they don't
// need. A construction failure (e.g. --authProvider couchdb without nano
// installed, or an unreachable CouchDB) fails the whole server the same
// way a missing module folder does above, rather than surfacing as a
// confusing per-request 500 later.
if (options.debug !== true) {
  try {
    require('./lib/auth').getAuthProvider();
  } catch (e) {
    logger.E(new Error('AuthProvider (--authProvider ' + options.authProvider + ') failed to initialize: ' + e.message));
    process.exit(-1);
  }
}

try {
  // create module folder
  fs.mkdirSync(options.modulePath, {recursive: true});
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

var redisAPI = require('./lib/redis-api');
redisAPI.init();

global.CHUtil     = require('./lib/countinghouse-util');
global.CHDevice   = require('./lib/countinghouse-device');
global.CHError    = require('./lib/countinghouse-error').CHError;
global.DeviceError  = require('./lib/countinghouse-error').DeviceError;

//manually set CHUtil.redis because when countinghouse-util.js is first time required, redis-api.js isn't loaded and initialized yet
global.CHUtil.redis = redisAPI.client;

var JobControl    = require('./lib/job-control');
if (options.workerThread === true) JobControl.initJobProcess(routeManager.cdifInterface);

// routeManager.startServer();
mm.loadAllModules();


// forever to restart on crash?
