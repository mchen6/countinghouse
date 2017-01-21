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
  this.app.use(bodyParser.json());

  // global routes base path
  this.app.use('/devices',   this.deviceControlRouter);
  this.app.use('/callbacks', this.callbacksRouter);

  if (options.enableVerifyAndPublish === true) {
    this.app.use('/verify-module', require('./routes/verify-module')(mm, this.cdifInterface));
    this.app.use('/shutdown',      require('./routes/shutdown')());
  }

  //TODO: move this to callback routes
  this.app.use('/callback_url', require('./routes/oauth-callback')(mm, this.cdifInterface));
  this.app.use('/device-list',  require('./routes/device-list')());

  //callback don't do user auth
  this.callbacksRouter.use('/:deviceID', require('./routes/callbacks')(mm, this.cdifInterface));

  //per device routes
  //user validation
  this.deviceControlRouter.use('/:deviceID',                require('./routes/user'));
  this.deviceControlRouter.use('/:deviceID/connect',        require('./routes/connect')(mm, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/disconnect',     require('./routes/disconnect')(mm, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/invoke-action',  require('./routes/invoke-action')(mm, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/get-spec',       require('./routes/get-spec')(mm, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/get-state',      require('./routes/get-state')(mm, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/event-sub',      require('./routes/event-sub')(mm, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/event-unsub',    require('./routes/event-unsub')(mm, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/schema',         require('./routes/schema')(mm, this.cdifInterface));

  if (options.allowDiscover) {
    this.app.use('/',              require('./routes/user'));
    this.app.use('/discover',      require('./routes/discover')(mm, this.cdifInterface));
    this.app.use('/stop-discover', require('./routes/stop-discover')(mm, this.cdifInterface));
  }

  this.cdifInterface.on('presentation', this.mountDevicePresentationPage.bind(this));

  if (options.wsServer === true) {
    this.wsServer = new WSServer(this.server, this.cdifInterface);
  } else if (options.sioServer === true) {
    this.socketServer = new SocketServer(this.server, this.cdifInterface);
    this.socketServer.installHandlers();
  }
}

util.inherits(RouteManager, events.EventEmitter);

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

RouteManager.prototype.installRoutes = function() {
  // setInterval(function() {
  //   this.server.getConnections(function(err, count) {
  //     console.log(count);
  //   });
  // }.bind(this), 100);

  this.server.listen(options.hostPort, CdifUtil.getHostIp());
  LOG.I('cdif listen on: ' + CdifUtil.getHostIp() + ':' + options.hostPort);
};

module.exports = RouteManager;
