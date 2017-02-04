var express   = require('express');
var CdifError = require('../cdif-error').CdifError;


//when we receive an event, it means a output value invalidation
var subscriber = function(output) {
  this.send(JSON.stringify(output)); // updated
};

var onSocketOpen = function(req, cdifInterface) {

};

var onSocketClose = function(req, cdifInterface, code, reason) {
  //TODO: unsubscribe from a key
  console.log(code); console.log(reason);
}

var onSocketError = function(req, cdifInterface, error) {
  //TODO: unsubscribe from a key
  console.log(error);
};

var onPing = function(req, cdifInterface, data, flags) {

};

var onPong = function(req, cdifInterface, data, flags) {

};

var onInputMessage = function(req, cdifInterface, message, flags) {
  var deviceID = req.params.deviceID;

  var inputMessage = null;

  try {
    inputMessage = JSON.parse(message);
  } catch (e) {
    return;
  }

  var serviceID  = inputMessage.serviceID;
  var actionName = inputMessage.actionName;
  var inputKey   = inputMessage.key;  // key corresponding to API call argument, which is keyed by 'input' object

  if (serviceID == null || actionName == null || inputKey == null) return;

  if (this.apiKeySubscriber == null) {
    this.apiKeySubscriber = subscriber.bind(this);
  }

  switch(inputMessage.topic) {
    case 'subscribe':
      cdifInterface.eventSubscribe(this.apiKeySubscriber, deviceID, serviceID, actionName, inputKey, null, function(err, data) {
        if (err) {
          this.send('subfail'); //TODO: improve err msg
        } else {
          this.send('subok');
        }
      }.bind(this));
      // this.send(message);
      break;
    case 'unsubscribe':
      // cdifInterface.eventUnSubscribe(apiKeySubscriber, deviceID, serviceID, actionName, inputKey);
      break;
    default:
      return;
  }
};

// TODO: see http://stackoverflow.com/a/16395220/151312 on how to parse cookie and identify user in production environment
// var location = url.parse(ws.upgradeReq.url, true);
module.exports = function(mm, cdifInterface) {
  var router = express.Router({mergeParams: true});

  router.ws('/', function(ws, req) {
    // var session = req.session;
    // TODO: console.log(req.headers['sec-websocket-protocol']); // this can be used to identify user

  // this.wss.on('connection', this.onNewConnection.bind(this));
  // this.wss.on('error',      this.onServerError.bind(this));
    ws.on('open',    onSocketOpen.bind(ws, req,   cdifInterface));
    ws.on('close',   onSocketClose.bind(ws, req,  cdifInterface));
    ws.on('error',   onSocketError.bind(ws, req,  cdifInterface));
    ws.on('ping',    onPing.bind(ws, req,         cdifInterface));
    ws.on('pong',    onPong.bind(ws, req,         cdifInterface));
    ws.on('message', onInputMessage.bind(ws, req, cdifInterface));
  });
  return router;
}

