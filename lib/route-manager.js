var events        = require('events');
var util          = require('util');
var http          = require('http');
var express       = require('express');
var url           = require('url');
var bodyParser    = require('body-parser');
var morgan        = require('morgan');
var CdifUtil      = require('./cdif-util');
var SocketServer  = require('./socket-server');
var WSServer      = require('./ws-server');
var CdifInterface = require('./cdif-interface');
var Session       = require('./session');
var CdifError     = require('./error').CdifError;
var options       = require('./cli-options');
var LOG           = require('./logger');

var discoverRoute      = '/discover';
var stopDiscoverRoute  = '/stop-discover';
var deviceListRoute    = '/device-list';
var deviceControlRoute = '/devices';
var connectRoute       = '/connect';
var disconnectRoute    = '/disconnect';
var actionInvokeRoute  = '/invoke-action';
var eventSubRoute      = '/event-sub';
var eventUnsubRoute    = '/event-unsub';
var getDeviceSpecRoute = '/get-spec';
var getStateRoute      = '/get-state';
var deviceSchemaRoute  = '/schema';
var oauthCallbackUrl   = '/callback_url';

var moduleVerifyRoute  = '/verify-module';
var shutDownRoute      = '/shutdown';

function RouteManager(mm) {
  this.app = express();

  this.moduleManager = mm;
  this.cdifInterface = new CdifInterface(mm);

  this.oauthCallbackRouter = express.Router();

  if (options.allowDiscover) {
    this.discoverRouter      = express.Router();
    this.stopDiscoverRouter  = express.Router();
  }

  this.deviceListRouter    = express.Router();
  this.deviceControlRouter = express.Router();
  this.connectRouter       = express.Router({mergeParams: true});
  this.disconnectRouter    = express.Router({mergeParams: true});
  this.actionInvokeRouter  = express.Router({mergeParams: true});
  this.getDeviceSpecRouter = express.Router({mergeParams: true});
  this.getStateRouter      = express.Router({mergeParams: true});
  this.eventSubRouter      = express.Router({mergeParams: true});
  this.eventUnsubRouter    = express.Router({mergeParams: true});
  this.presentationRouter  = express.Router({mergeParams: true});
  this.deviceSchemaRouter  = express.Router({mergeParams: true});

  this.moduleVerifyRouter    = express.Router();
  this.shutdownRouter        = express.Router();

  this.server = http.createServer(this.app);

  if (options.isDebug === true) {
    this.app.use(morgan('dev'));
  }


  this.app.use(require('./routes/cors'));
  this.app.use(bodyParser.json());

  // global routes
  this.app.use(oauthCallbackUrl,     this.oauthCallbackRouter);
  this.app.use(moduleVerifyRoute,    this.moduleVerifyRouter);
  this.app.use(shutDownRoute,        this.shutdownRouter);

  if (options.allowDiscover) {
    this.app.use(discoverRoute,      this.discoverRouter);
    this.app.use(stopDiscoverRoute,  this.stopDiscoverRouter);
  }

  this.app.use(deviceListRoute,    this.deviceListRouter);
  this.app.use(deviceControlRoute, this.deviceControlRouter);
  //per device routes
  //user validation
  this.deviceControlRouter.use('/:deviceID', require('./routes/user'));

  this.deviceControlRouter.use('/:deviceID' + connectRoute,       this.connectRouter);
  this.deviceControlRouter.use('/:deviceID' + disconnectRoute,    this.disconnectRouter);
  this.deviceControlRouter.use('/:deviceID' + actionInvokeRoute,  this.actionInvokeRouter);
  this.deviceControlRouter.use('/:deviceID' + getDeviceSpecRoute, this.getDeviceSpecRouter);
  this.deviceControlRouter.use('/:deviceID' + getStateRoute,      this.getStateRouter);
  this.deviceControlRouter.use('/:deviceID' + eventSubRoute,      this.eventSubRouter);
  this.deviceControlRouter.use('/:deviceID' + eventUnsubRoute,    this.eventUnsubRouter);
  this.deviceControlRouter.use('/:deviceID' + deviceSchemaRoute,  this.deviceSchemaRouter);

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
      LOG.E(new CdifError('cannot get device root url, error: ' + err.message));
    }
  }.bind(this);

  this.cdifInterface.getDeviceRootUrl(deviceID, session);
};

//TODO: manage session creation and prevent double callback from drivers
//TODO: sanity check to req data
RouteManager.prototype.installRoutes = function() {
  this.oauthCallbackRouter.route('/').get(function (req, res) {
    var session = req.session;
    var deviceID = null;
    var params   = req.query;

    // console.log(params);
    if (params.state != null) {
      deviceID = params.state;    // oauth 2.0 bring back device ID in state param
    } else {
      deviceID = params.deviceID;
    }

    this.cdifInterface.setDeviceOAuthAccessToken(deviceID, params, session);
  }.bind(this));

  // routes to verify the integrity of a package and publish to registry
  if (options.enableVerifyAndPublish === true) {
    this.moduleVerifyRouter.route('/').post(function (req, res) {
      var packageName = req.body.name;      // local name with absolute path prefix of the zipped package
      var session     = req.session;

      this.moduleManager.verifyModule(packageName, session.callback);
    }.bind(this));

    this.shutdownRouter.route('/').post(function (req, res) {
      process.exit(0);
    });
  }

  if (options.allowDiscover === true) {
    this.discoverRouter.route('/').post(function(req, res) {
      var session = req.session;
      this.cdifInterface.discoverAll(session);
    }.bind(this));

    this.stopDiscoverRouter.route('/').post(function(req, res) {
      var session = req.session;
      this.cdifInterface.stopDiscoverAll(session);
    }.bind(this));
  }

  this.deviceListRouter.route('/').get(function(req, res) {
    var getUserDeviceList = require('./routes/device-list');
    getUserDeviceList(req, res);
  }.bind(this));

  this.connectRouter.route('/').post(function(req, res) {
    var session = req.session;

    var deviceID = req.params.deviceID;
    var user     = req.body.username;
    var pass     = req.body.password;

    if (user == null && pass == null) {
      user = ''; pass = '';
    } else if (user == null || user === '') {
      return session.callback(new CdifError('must provide a username'));
    } else if (pass == null || pass === '') {
      return session.callback(new CdifError('must provide a password'));
    }

    this.cdifInterface.connectDevice(deviceID, user, pass, session);
  }.bind(this));

  this.disconnectRouter.route('/').post(function(req, res) {
    var session = req.session;

    var deviceID = req.params.deviceID;
    var token    = req.body.device_access_token;

    this.cdifInterface.disconnectDevice(deviceID, token, session);
  }.bind(this));

  this.actionInvokeRouter.route('/').post(function(req, res) {
    var session = req.session;

    var deviceID   = req.params.deviceID;
    var serviceID  = req.body.serviceID;
    var actionName = req.body.actionName;
    var args       = req.body.argumentList;
    var token      = req.body.device_access_token;

    this.cdifInterface.invokeDeviceAction(deviceID, serviceID, actionName, args, token, session);
  }.bind(this));

  this.getDeviceSpecRouter.route('/').get(function(req, res) {
    var session = req.session;

    var deviceID = req.params.deviceID;
    var token    = req.body.device_access_token;

    this.cdifInterface.getDeviceSpec(deviceID, token, session);
  }.bind(this));

  this.getStateRouter.route('/').get(function(req, res) {
    var session = req.session;

    var deviceID  = req.params.deviceID;
    var serviceID = req.body.serviceID;
    var token     = req.body.device_access_token;

    this.cdifInterface.getDeviceState(deviceID, serviceID, token, session);
  }.bind(this));

  this.eventSubRouter.route('/').post(function(req, res) {
    var session = req.session;

    var deviceID  = req.params.deviceID;
    var serviceID = req.body.serviceID;
    var token     = req.body.device_access_token;

    this.cdifInterface.eventSubscribe(this.subscriber, deviceID, serviceID, token, session);
  }.bind(this));

  this.eventUnsubRouter.route('/').post(function(req, res) {
    var session = req.session;

    var deviceID  = req.params.deviceID;
    var serviceID = req.body.serviceID;
    var token     = req.body.device_access_token;

    this.cdifInterface.eventUnsubscribe(this.subscriber, deviceID, serviceID, token, session);
  }.bind(this));

  this.deviceSchemaRouter.route('/*').get(function(req, res) {
    var session = req.session;

    var deviceID = req.params.deviceID;
    var token    = req.body.device_access_token;
    var path     = req.url;

    this.cdifInterface.getDeviceSchema(deviceID, path, token, session);
  }.bind(this));

  // test subscriber
  this.subscriber = new function() {
    this.publish = function(updated, data) {
      console.log(data);
    };
  }

  console.log(CdifUtil.getHostIp());
  this.server.listen(CdifUtil.getHostPort(), CdifUtil.getHostIp());
};

module.exports = RouteManager;
