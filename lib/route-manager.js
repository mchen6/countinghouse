var events        = require('events');
var util          = require('util');
var http          = require('http');
var express       = require('express');
var url           = require('url');
var cors          = require('cors');
var bodyParser    = require('body-parser');
var morgan        = require('morgan');
var CdifUtil      = require('./cdif-util');
var SocketServer  = require('./socket-server');
var WSServer      = require('./ws-server');
var CdifInterface = require('./cdif-interface');
var Session       = require('./session');
var CdifError     = require('./cdif-error').CdifError;
var options       = require('./cli-options');
var LOG           = require('./logger');

var proxyHandler  = require('./proxy-handler');

require('body-parser-xml')(bodyParser);

var oauthCallbackUrl   = '/callback_url';

function RouteManager(mm) {
  this.app = express();

  this.moduleManager = mm;
  this.cdifInterface = new CdifInterface(mm);

  this.deviceControlRouter = express.Router();
  this.callbacksRouter     = express.Router();
  this.presentationRouter  = express.Router({mergeParams: true});

  this.server = http.createServer(this.app);

  if (options.isDebug === true) {
    // this.app.use(morgan('dev'));
  }

  this.app.use(function (req, res, next) {
    delete req.headers['content-encoding'];
    next();
  });

  this.app.use(cors());

  if (options.reverseProxy === true) {
    // must put this before body parser because it will consume incoming requests
    this.installReverseHttpProxyRoutes(this.app, function(err) {
      if (err) LOG.I('reverse proxy error: ' + err.message);

      this.installNormalRoutes();
      this.startServer();
    }.bind(this));
  } else {
    this.installNormalRoutes();
    this.startServer();
  }
}

util.inherits(RouteManager, events.EventEmitter);

RouteManager.prototype.installNormalRoutes = function() {
  this.app.use(bodyParser.json({type: ['application/json', 'text/plain'], limit: '1gb'}));
  this.app.use(bodyParser.xml({limit: '1gb'}));
  this.app.use(bodyParser.urlencoded({extended:true, type: ['application/x-www-form-urlencoded'], limit: '1gb'}));

  // global routes base path
  this.app.use('/devices',   this.deviceControlRouter);
  this.app.use('/callbacks', this.callbacksRouter);

  if (options.enableVerifyAndPublish === true) {
    this.app.use('/verify-module', require('./routes/verify-module')(this.moduleManager, this.cdifInterface));
    //TODO: move this route outside and be protected by user validation route if normal user requires module reload functionality
    this.app.use('/reload-module', require('./routes/reload-module')(this.moduleManager, this.cdifInterface));
    this.app.use('/shutdown',      require('./routes/shutdown')());
  }

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
  this.deviceControlRouter.use('/:deviceID',                require('./routes/user'));
  this.deviceControlRouter.use('/:deviceID/connect',        require('./routes/connect')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/disconnect',     require('./routes/disconnect')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/invoke-action',  require('./routes/invoke-action')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/get-spec',       require('./routes/get-spec')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/get-state',      require('./routes/get-state')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/event-sub',      require('./routes/event-sub')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/event-unsub',    require('./routes/event-unsub')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/schema',         require('./routes/schema')(this.moduleManager, this.cdifInterface));

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
      LOG.E(new CdifError('GET_DEVICE_ROOTURL_FAIL', err.message));
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

  this.server.listen(options.hostPort, CdifUtil.getHostIp());
  LOG.I('cdif listen on: ' + CdifUtil.getHostIp() + ':' + options.hostPort);
};

RouteManager.prototype.installOpenStackRoutes = function(app, mm, ci) {
  app.use('/v2/:tenantID/servers', require('./routes/openstack/createServer')(mm, ci));
  app.use('/v2/:tenantID/servers/:serverID', require('./routes/openstack/deleteServer')(mm, ci));
};

RouteManager.prototype.installReverseHttpProxyRoutes = function(app, callback) {
  app.use('/api-proxy/:deviceID', require('./routes/user'));

  proxyHandler.loadAllProxyHosts(function(err) {
    if (err) return callback(err);
    proxyHandler.installProxyRoutes(app);
    return callback(null);
  });
};

module.exports = RouteManager;
