const events        = require('events');
const util          = require('util');
const http          = require('http');
const express       = require('express');
const cors          = require('cors');
const CHUtil      = require('./countinghouse-util');
const CdifInterface = require('./countinghouse-interface');
const options       = require('./cli-options');
const LOG           = require('./logger');

// The routes that take a BSON body (lib/routes/invoke-action.js, add-job.js).
const BSON_ROUTES = ['/devices/:deviceID/invoke-action', '/devices/:deviceID/add-job'];

// express re-exports body-parser's json/raw/text/urlencoded middleware directly
// (Express 4.16+, see https://expressjs.com/en/4x/api.html#express.json), so
// body-parser-xml can extend the express module itself with .xml() the same
// way it would extend a standalone body-parser require, without adding a
// separate body-parser dependency.
require('body-parser-xml')(express);

function RouteManager(mm) {
  this.app = express();

  this.moduleManager = mm;
  this.cdifInterface = new CdifInterface(mm);

  this.deviceControlRouter = express.Router();

  this.server = http.createServer(this.app);

  this.app.use((req, res, next) => {
    delete req.headers['content-encoding'];
    next();
  });

  this.app.use(cors());

  this.installNormalRoutes();
  this.startServer();
}

util.inherits(RouteManager, events.EventEmitter);

RouteManager.prototype.installNormalRoutes = function() {
  // Bodies are read before any route checks the caller's key, so they are
  // bounded: --maxRequestBody (MB) for JSON, XML and forms everywhere, and a
  // larger --maxBsonRequestBody only where BSON is taken (BSON_ROUTES). An
  // oversized body is answered 413. They were 1 GB everywhere (review R1-1).
  const limit = `${options.maxRequestBody}mb`;
  // Not text/plain: a cross-site POST of text/plain needs no CORS preflight (review R1-2).
  this.app.use(express.json({type: ['application/json'], limit: limit}));
  this.app.use(express.xml({limit: limit}));
  this.app.use(express.urlencoded({extended:true, type: ['application/x-www-form-urlencoded'], limit: limit}));
  const bson = express.raw({type: ['application/bson'], limit: `${options.maxBsonRequestBody}mb`}); // BSON as a raw buffer
  BSON_ROUTES.forEach((route) => this.app.use(route, bson));

  // global routes base path
  this.app.use('/devices',   this.deviceControlRouter);

  // MCP gateway: stateless Streamable HTTP transport (2026-07-28 spec) over
  // currently loaded device modules' tools/list + tools/call.
  this.app.use('/mcp', require('./routes/mcp')(this.moduleManager, this.cdifInterface));

  this.app.use('/balance', require('./routes/balance')(this.moduleManager, this.cdifInterface));

  // Module-lifecycle routes: always mounted, gated per-request by
  // adminOnly (lib/routes/admin-only.js) rather than by whether a CLI
  // flag was set at startup -- same pattern every device-scoped route
  // already uses (mounted unconditionally, gated by userAuth). --debug
  // still bypasses everything, same as it always has (see admin-only.js).
  // options.verifyModule itself is NOT retired -- it still exists and
  // still controls real fall-through/reporting behavior inside
  // device-manager.js and countinghouse-util.js during module
  // verification, entirely unrelated to whether these routes are
  // reachable. It just no longer has any bearing on mounting -- that
  // coupling (options.verifyModule === true || options.debug === true)
  // is what's removed here, not the flag itself.
  const adminOnly = require('./routes/admin-only');
  this.app.use('/get-module-device-list', adminOnly, require('./routes/get-module-device-list')(this.moduleManager, this.cdifInterface));
  this.app.use('/reload-module', adminOnly, require('./routes/reload-module')(this.moduleManager, this.cdifInterface));
  this.app.use('/shutdown',      adminOnly, require('./routes/shutdown')());
  this.app.use('/load-module',    adminOnly, require('./routes/load-module')(this.moduleManager, this.cdifInterface));
  this.app.use('/unload-module',  adminOnly, require('./routes/unload-module')(this.moduleManager, this.cdifInterface));
  this.app.use('/restart-module', adminOnly, require('./routes/restart-module')(this.moduleManager, this.cdifInterface));
  this.app.use('/uninstall-module', adminOnly, require('./routes/uninstall-module')(this.moduleManager));


  // if (options.wetty === true) {
  //   require('../wetty/app.js')(this.server, this.app);
  // }

  this.app.use('/device-list',  require('./routes/device-list')(this.moduleManager, this.cdifInterface));

  //per device routes
  //user validation
  this.deviceControlRouter.use('/:deviceID',                  require('./routes/user'));
  this.deviceControlRouter.use('/:deviceID/invoke-action',    require('./routes/invoke-action')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/get-spec',         require('./routes/get-spec')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/schema',           require('./routes/schema')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/package-info',     require('./routes/get-device-package-info')(this.moduleManager, this.cdifInterface));

  this.deviceControlRouter.use('/:deviceID/add-job',        require('./routes/add-job')(this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/get-job',        require('./routes/get-job')(this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/get-job-history',require('./routes/get-job-history')(this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/remove-job',     require('./routes/remove-job')(this.cdifInterface));

};

RouteManager.prototype.startServer = function() {
  // setInterval(function() {
  //   this.server.getConnections(function(err, count) {
  //     console.log(count);
  //   });
  // }.bind(this), 100);

  this.server.listen(options.port, CHUtil.getHostIp());
  LOG.I(`countinghouse listen on: ${CHUtil.getHostIp()}:${options.port}`);
};

module.exports = RouteManager;
module.exports.BSON_ROUTES = BSON_ROUTES;
