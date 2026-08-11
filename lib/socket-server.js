var events            = require('events');
var util              = require('util');
var socketio          = require('socket.io');
var SubscriberManager = require('./subscriber');
var Session           = require('./session');
var LOG               = require('./logger');
var CHError         = require('./countinghouse-error').CHError;
var doUserAuth       = require('./user-auth');

function SocketServer(server, cdifInterface) {
  this.io                = new socketio.Server(server);
  this.cdifInterface     = cdifInterface;
  this.subscriberManager = new SubscriberManager(this.io);
}

util.inherits(SocketServer, events.EventEmitter);

SocketServer.prototype.installHandlers = function() {
  var _this = this;

  //TODO: support event id, cancel and subscription expire time

  // Handshake-time identity check via the same AuthProvider every
  // HTTP/MCP route already goes through (lib/user-auth.js) -- rejects an
  // unknown/missing apiKey before the socket is ever allowed to connect,
  // rather than the connection silently succeeding with no key at all
  // (the previous state -- see docs/cross-cutting-matrix.md's event
  // channel row). deviceID is deliberately null here, same
  // device-independent-check convention doUserAuth's own header comment
  // documents for lib/routes/admin-only.js: this only proves the apiKey
  // is known at all, not that it can see any particular device. It can't
  // prove more than that yet -- the deviceID a client wants isn't known
  // until it actually sends 'subscribe', and a single long-lived
  // connection can subscribe to more than one device over its lifetime --
  // so the real per-device authorization (the part that makes this "same
  // semantics as HTTP/MCP", not just "has some valid key") happens again
  // below, per subscribe, exactly like lib/routes/user.js does per HTTP
  // request.
  this.io.use(function(socket, next) {
    var appKey = socket.handshake.auth != null ? socket.handshake.auth.apiKey : null;

    doUserAuth(null, null, null, appKey, null, null, null, function(err, session) {
      if (err != null) {
        var authError = new Error(err.message);
        authError.data = {topic: err.topic, code: err.code};
        return next(authError);
      }
      socket.chApiKey = appKey;
      return next();
    });
  });

  this.io.sockets.on('connection', function(socket) {
    socket.on('subscribe', function (options) {
      var info;
      try {
        info = JSON.parse(options);
      } catch (e) {
        return;
      }
      var deviceID            = info.deviceID;
      var serviceID           = info.serviceID;
      var actionName          = info.actionName;
      var input               = info.input;
      var inputKey            = info.inputKey;
      var device_access_token = info.device_access_token;

      // Per-device authorization -- the handshake check above only
      // proved socket.chApiKey is valid at all, not that it can see this
      // specific deviceID.
      doUserAuth(null, null, deviceID, socket.chApiKey, serviceID, actionName, null, function(err) {
        if (err != null) {
          _this.io.to(socket.id).emit('error', {topic: err.topic, code: err.code, message: err.message});
          return;
        }

        LOG.I('client subscribe to events of deviceID: ' + deviceID + ', serviceID: '+ serviceID);
        _this.subscriberManager.getSubscriber(socket.id, _this.io, info, function(subscriber) {
          var session = new Session(null, null, null);

          session.callback = function(err) {
            if (err) {
              _this.io.to(socket.id).emit('error', {topic: err.topic, code: err.code, message: err.message});
              _this.subscriberManager.removeSubscriber(socket.id, function(){});
            }
          }

          // CdifInterface.prototype.eventSubscribe signature is (deviceID,
          // serviceID, actionName, input, inputKey, token, callback) --
          // `callback` must be a plain function, not the Session instance
          // itself (session.callback is the plain function that wraps it).
          _this.cdifInterface.eventSubscribe(deviceID, serviceID, actionName, input, inputKey, device_access_token, session.callback);
        });
      });
    });
    socket.on('disconnect', function() {
      _this.subscriberManager.removeSubscriber(socket.id, function(err, subscriber, info) {
        if (!err) {
          var deviceID            = info.deviceID;
          var serviceID           = info.serviceID;
          var actionName          = info.actionName;
          var input               = info.input;
          var inputKey            = info.inputKey;
          var device_access_token = info.device_access_token;

          // No fresh auth check needed here -- this is tearing down a
          // subscription that was already authorized (per-device) at
          // 'subscribe' time above, on the same socket.
          var session = new Session(null, null, null);
          session.callback = function(err) {
            if (err) {
              LOG.E(new CHError('SOCKET_SERVER_UNSUBSCRIBE_FAIL', err.message));
            }
          }

          _this.cdifInterface.eventUnsubscribe(deviceID, serviceID, actionName, input, inputKey, device_access_token, session.callback);
        }
      });
    });
  });
};


module.exports = SocketServer;
