var express   = require('express');
var CdifError = require('../cdif-error').CdifError;


//when we receive an event, it means a output value invalidation
var subscriber = function(output) {

};

var onSocketOpen = function(req, cdifInterface) {
  if (this.apiKeySubscriber == null) {
    this.apiKeySubscriber = subscriber.bind(this);
  }
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

  switch(inputMessage.topic) {
    case 'subscribe':
      // cdifInterface.eventSubscribe(apiKeySubscriber, deviceID, serviceID, actionName, inputKey);
      this.send(message);
      break;
    case 'unsubscribe':
      // cdifInterface.eventUnSubscribe(apiKeySubscriber, deviceID, serviceID, actionName, inputKey);
      break;
    default:
      return;
  }
};
121431

module.exports = function(mm, cdifInterface) {
  var router = express.Router({mergeParams: true});

  router.ws('/', function(ws, req) {
    // var session = req.session;
    console.log(req.headers['sec-websocket-protocol']); // this can be used to identify user

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

