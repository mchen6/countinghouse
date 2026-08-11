var events        = require('events');
var util          = require('util');
var http          = require('http');
var express       = require('express');
var url           = require('url');
var cors          = require('cors');
var CHUtil      = require('./countinghouse-util');
var SocketServer  = require('./socket-server');
// var WSServer      = require('./ws-server');
var CdifInterface = require('./countinghouse-interface');
var Session       = require('./session');
var CHError     = require('./countinghouse-error').CHError;
var options       = require('./cli-options');
var LOG           = require('./logger');

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
  this.callbacksRouter     = express.Router();
  this.presentationRouter  = express.Router({mergeParams: true});

  this.server = http.createServer(this.app);

  this.app.use(function (req, res, next) {
    delete req.headers['content-encoding'];
    next();
  });

  this.app.use(cors());

  this.installNormalRoutes();
  this.startServer();
}

util.inherits(RouteManager, events.EventEmitter);

RouteManager.prototype.installNormalRoutes = function() {
  this.app.use(express.raw({type: ['application/bson'], limit: '1gb'})); //parse bson media type as raw buffer
  this.app.use(express.json({type: ['application/json', 'text/plain'], limit: '1gb'}));
  this.app.use(express.xml({limit: '1gb'}));
  this.app.use(express.urlencoded({extended:true, type: ['application/x-www-form-urlencoded'], limit: '1gb'}));

  // global routes base path
  this.app.use('/devices',   this.deviceControlRouter);
  this.app.use('/callbacks', this.callbacksRouter);

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
  var adminOnly = require('./routes/admin-only');
  this.app.use('/verify-module', adminOnly, require('./routes/verify-module')(this.moduleManager, this.cdifInterface));
  this.app.use('/get-module-device-list', adminOnly, require('./routes/get-module-device-list')(this.moduleManager, this.cdifInterface));
  this.app.use('/reload-module', adminOnly, require('./routes/reload-module')(this.moduleManager, this.cdifInterface));
  this.app.use('/shutdown',      adminOnly, require('./routes/shutdown')());
  this.app.use('/load-module',    adminOnly, require('./routes/load-module')(this.moduleManager, this.cdifInterface));
  this.app.use('/unload-module',  adminOnly, require('./routes/unload-module')(this.moduleManager, this.cdifInterface));
  this.app.use('/restart-module', adminOnly, require('./routes/restart-module')(this.moduleManager, this.cdifInterface));


  if (options.loadProfile === true) {
    this.app.use('/load-profile',  require('./routes/load-profile')(this.moduleManager, this.cdifInterface));
  }

  // if (options.wetty === true) {
  //   require('../wetty/app.js')(this.server, this.app);
  // }

  //TODO: move this to callback routes
  this.app.use('/callback_url', require('./routes/oauth-callback')(this.moduleManager, this.cdifInterface));
  this.app.use('/device-list',  require('./routes/device-list')(this.moduleManager, this.cdifInterface));

  //callback don't do user auth
  this.callbacksRouter.use('/:deviceID', require('./routes/callbacks')(this.moduleManager, this.cdifInterface));

  if (options.simOpenStackAPI === true) {
    // openstack api simulation don't do user auth
    this.installOpenStackRoutes(this.app, this.moduleManager, this.cdifInterface);
  }

  //ws routes also don't do http header based user auth
  if (options.wsServer === true) {
    LOG.I('enable websocket server');
    var expressWs = require('express-ws')(this.app, this.server);
    this.deviceControlRouter.use('/:deviceID/wss', require('./routes/wss').getRouter(this.moduleManager, this.cdifInterface));
    // this.wsServer = new WSServer(this.server, this.cdifInterface);
    //TODO: add verifyClient support here
    // wsOptions: { //<-- express-ws allows passing options nested as this property.
    //   verifyClient: function (info, cb) {
    //     const user = require('basic-auth')(info.req);
    //     if ( ! user || ! auth.authorized(user.name, user.pass)) {
    //       return cb(false, 401, "Unauthorized");
    //     } else return cb(true);
    //   }
    // }
  } else if (options.sioServer === true) {
    LOG.I('enable socketIO server');
    this.socketServer = new SocketServer(this.server, this.cdifInterface);
    this.socketServer.installHandlers();
  }
  //per device routes
  //user validation
  this.deviceControlRouter.use('/:deviceID',                  require('./routes/user'));
  this.deviceControlRouter.use('/:deviceID/connect',          require('./routes/connect')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/disconnect',       require('./routes/disconnect')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/invoke-action',    require('./routes/invoke-action')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/get-spec',         require('./routes/get-spec')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/get-state',        require('./routes/get-state')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/event-sub',        require('./routes/event-sub')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/event-unsub',      require('./routes/event-unsub')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/schema',           require('./routes/schema')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/package-info',     require('./routes/get-device-package-info')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/download-package', require('./routes/download-device-package')(this.moduleManager, this.cdifInterface));

  this.deviceControlRouter.use('/:deviceID/add-job',        require('./routes/add-job')());
  this.deviceControlRouter.use('/:deviceID/get-job',        require('./routes/get-job')());
  this.deviceControlRouter.use('/:deviceID/get-job-history',require('./routes/get-job-history')());
  this.deviceControlRouter.use('/:deviceID/remove-job',     require('./routes/remove-job')());

  if (options.allowDiscover) {
    this.app.use('/',              require('./routes/user'));
    this.app.use('/discover',      require('./routes/discover')(this.moduleManager, this.cdifInterface));
    this.app.use('/stop-discover', require('./routes/stop-discover')(this.moduleManager, this.cdifInterface));
  }

  this.cdifInterface.on('presentation', this.mountDevicePresentationPage.bind(this));
};

RouteManager.prototype.mountDevicePresentationPage = function(deviceID) {
  this.deviceControlRouter.use('/:deviceID/presentation', this.presentationRouter);

  var session = new Session(null, null, null);
  session.callback = function(err, deviceUrl) {
    if (!err) {
      this.presentationRouter.use('/', function(req, res) {
        var redirectedUrl = deviceUrl + req.url;
        res.redirect(redirectedUrl);
      });
    } else {
      LOG.E(new CHError('GET_DEVICE_ROOTURL_FAIL', err.message));
    }
  }.bind(this);

  this.cdifInterface.getDeviceRootUrl(deviceID, session);
};

RouteManager.prototype.startServer = function() {
  // setInterval(function() {
  //   this.server.getConnections(function(err, count) {
  //     console.log(count);
  //   });
  // }.bind(this), 100);

  this.server.listen(options.port, CHUtil.getHostIp());
  LOG.I('countinghouse listen on: ' + CHUtil.getHostIp() + ':' + options.port);
};

RouteManager.prototype.installOpenStackRoutes = function(app, mm, ci) {
  app.use('/v2/:tenantID/servers', require('./routes/openstack/createServer')(mm, ci));
  app.use('/v2/:tenantID/servers/:serverID', require('./routes/openstack/deleteServer')(mm, ci));
};

module.exports = RouteManager;
