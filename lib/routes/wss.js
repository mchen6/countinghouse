var express   = require('express');
var hashKey   = require('../hash-key');
var LOG       = require('../logger');
var CdifError = require('../cdif-error').CdifError;


//when we receive an event, it means a output value invalidation
var subscriber = function(key, output) {
  this.send(output); // updated
};

var onSocketOpen = function(req, cdifInterface) {

};

var onSocketClose = function(req, cdifInterface, code, reason) {
  for (var key in this.subscribedKeyList) {
    var keyObject = this.subscribedKeyList[key];
    if (this.apiKeySubscriber != null) keyObject.removeEventSubscriber(this.apiKeySubscriber);
    delete this.subscribedKeyList[key];
  }
}

var onSocketError = function(req, cdifInterface, error) {
  for (var key in this.subscribedKeyList) {
    var keyObject = this.subscribedKeyList[key];
    if (this.apiKeySubscriber != null) keyObject.removeEventSubscriber(this.apiKeySubscriber);
    delete this.subscribedKeyList[key];
  }
  this.terminate();
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
  var input      = inputMessage.input;  // key corresponding to API call argument, which is keyed by 'input' object

  if (serviceID == null || actionName == null || input == null) return;

  if (this.apiKeySubscriber == null) {
    this.apiKeySubscriber = subscriber.bind(this);
  }

  if (this.subscribedKeyList == null) this.subscribedKeyList = {};

  switch(inputMessage.topic) {
    case 'subscribe':
      var inputKey = hashKey.getInputHashKey(deviceID, serviceID, actionName, input);
      cdifInterface.eventSubscribe(this.apiKeySubscriber, deviceID, serviceID, actionName, input, inputKey, null, function(err, data) {
        if (err) {
          this.send('subfail'); //TODO: improve err msg
        } else {
          if (this.subscribedKeyList[inputKey] == null) this.subscribedKeyList[inputKey] = data; // here data is the input-key object
          LOG.I('subscription done');
          this.send('subok');
        }
      }.bind(this));
      break;
    case 'unsubscribe':
      var inputKey = hashKey.getInputHashKey(deviceID, serviceID, actionName, input);
      cdifInterface.eventUnSubscribe(this.apiKeySubscriber, deviceID, serviceID, actionName, input, inputKey, null, function(err, data) {
        if (err) {
          this.send('unsubfail'); //TODO: improve err msg
        } else {
          if (this.subscribedKeyList[inputKey] != null) {
            delete this.subscribedKeyList[inputKey];
          }
          this.send('unsubok');
        }
      });
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

