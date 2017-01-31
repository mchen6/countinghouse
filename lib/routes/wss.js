var express   = require('express');
var CdifError = require('../cdif-error').CdifError;

module.exports = function(mm, cdifInterface) {
  var router = express.Router({mergeParams: true});

  router.ws('/', function(ws, req) {
    var session = req.session;

    var deviceID   = req.params.deviceID;
    var serviceID  = req.body.serviceID;
    var actionName = req.body.actionName;
    var args       = req.body;
    var token      = req.body.device_access_token;
    console.log(deviceID);
  // this.wss.on('connection', this.onNewConnection.bind(this));
  // this.wss.on('error',      this.onServerError.bind(this));
    // ws.on('open',    this.onSocketOpen.bind(ws));
    // ws.on('close',   this.onSocketClose.bind(ws));
    // ws.on('message', this.onInputMessage.bind(ws));
    // ws.on('error',   this.onSocketError.bind(ws));
    // ws.on('ping',    this.onPing.bind(ws));
    // ws.on('pong',    this.onPong.bind(ws));

    ws.on('message', function(msg) {
      // build argument object and uniformly use 'input' to identify input argument
      // var argumentList = {};
      // argumentList.input = args.input;
      // cdifInterface.invokeDeviceAction(deviceID, serviceID, actionName, argumentList, token, session);

      ws.send(msg);
    });
  });
  return router;
}

