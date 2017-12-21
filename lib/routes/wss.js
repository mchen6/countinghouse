var express     = require('express');
var crypto      = require('crypto');
var hashKey     = require('../hash-key');
var LOG         = require('../logger');
var options     = require('../cli-options');
var CdifError   = require('../cdif-error').CdifError;
var redis       = require('redis');
var redisClient = redis.createClient(options.redisUrl, {db: 5});
var async       = require('async');

redisClient.on('error', function (err) {
  if (options.isDebug !== true) LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
});

var onSocketOpen = function(req, cdifInterface, server) {

};

var onSocketClose = function(req, cdifInterface, server, code, reason) {
  delete server.wsClients[this.clientID]; // so we won't be able to publish anymore

  redisClient.smembers('cliset:' + this.clientID, function(err, results) {
    if (err) return;
    results.forEach(function(item) {
      redisClient.srem('keyset:' + item, this.clientID);
    }.bind(this));
    redisClient.del('cliset:' + this.clientID);
    redisClient.srem('subset', this.clientID);
  }.bind(this));
};

var onSocketError = function(req, cdifInterface, server, error) {
  LOG.E(error);
  // delete server.wsClients[this.clientID]; // so we won't be able to publish anymore

  // redisClient.smembers('cliset:' + this.clientID, function(err, results) {
  //   if (err) {
  //     return this.terminate();
  //   }
  //   results.forEach(function(item) {
  //     redisClient.srem('keyset:' + item, this.clientID);
  //   }.bind(this));
  //   redisClient.del('cliset:' + this.clientID);
  //   redisClient.srem('subset', this.clientID);
  //   return this.terminate();
  // }.bind(this));
};

var onPing = function(req, cdifInterface, server, data, flags) {

};

var onPong = function(req, cdifInterface, server, data, flags) {

};

var onInputMessage = function(req, cdifInterface, server, message, flags) {
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

  switch(inputMessage.topic) {
    case 'subscribe':
      var inputKey = hashKey.getInputHashKey(deviceID, serviceID, actionName, input);
      cdifInterface.eventSubscribe(deviceID, serviceID, actionName, input, inputKey, null, function(err, data) {
        if (err) {
          this.send('subfail:' + inputKey); //TODO: improve err msg, on error data may contain useful information
        } else {
          //TODO: better error handling
          redisClient.sadd('subset', this.clientID);
          redisClient.sadd('cliset:' + this.clientID, inputKey);
          redisClient.sadd('keyset:' + inputKey, this.clientID);
          this.send('subok:' + inputKey);
        }
      }.bind(this));
      break;
    case 'unsubscribe':
      var inputKey = hashKey.getInputHashKey(deviceID, serviceID, actionName, input);
      cdifInterface.eventUnSubscribe(deviceID, serviceID, actionName, input, inputKey, null, function(err, data) {
        if (err) {
          this.send('unsubfail:' + inputKey); //TODO: improve err msg, on error data may contain useful information
        } else {
          //TODO: better error handling
          redisClient.srem('subset', this.clientID);
          redisClient.srem('cliset:' + this.clientID, inputKey);
          redisClient.srem('keyset:' + inputKey, this.clientID);
          this.send('unsubok:' + inputKey);
        }
      });
      break;
    default:
      return;
  }
};

// TODO: see http://stackoverflow.com/a/16395220/151312 on how to parse cookie and identify user in production environment
// var location = url.parse(ws.upgradeReq.url, true);
module.exports = {
  getRouter: function(mm, cdifInterface) {
    var router = express.Router({mergeParams: true});
    router.ws('/', function(ws, req) {
      // var session = req.session;
      // TODO: console.log(req.headers['sec-websocket-protocol']); // this can be used to identify user

    // this.wss.on('connection', this.onNewConnection.bind(this));
    // this.wss.on('error',      this.onServerError.bind(this));
      if (this.wsClients == null) this.wsClients = {};
      var id = crypto.randomBytes(16).toString('hex');
      ws.clientID = id;
      this.wsClients[id] = ws;

      ws.on('open',    onSocketOpen.bind(ws, req,   cdifInterface, this));
      ws.on('close',   onSocketClose.bind(ws, req,  cdifInterface, this));
      ws.on('error',   onSocketError.bind(ws, req,  cdifInterface, this));
      ws.on('ping',    onPing.bind(ws, req,         cdifInterface, this));
      ws.on('pong',    onPong.bind(ws, req,         cdifInterface, this));
      ws.on('message', onInputMessage.bind(ws, req, cdifInterface, this));
    }.bind(this));
    return router;
  },
  publish: function(clientIDs, key, value) {
    // clientIDs contain array of clientIDs, key is the updated key, value is the updated value
    clientIDs.forEach(function(id) {
      if (this.wsClients[id] != null) {
        this.wsClients[id].send(key);
      }
    }.bind(this));
  },
  // delete all clientIDs which are managed by this cdif instance from redis cache
  deleteAllClienIDs: function(callback) {
    redisClient.smembers('subset', function(err, results) {
      async.each(results, function(clientID, cb) {
        redisClient.smembers('cliset:' + clientID, function(err, res) {
          if (err) return cb(err);
          res.forEach(function(key) {
            redisClient.srem('keyset:' + key, clientID);
          });
          redisClient.del('cliset:' + clientID);
          cb(null);
        });
      }, function(err) {
        redisClient.del('subset');
        callback(err);
      });
    }.bind(this));
  }
}




