var events            = require('events');
var util              = require('util');
var socketio          = require('socket.io');
var SubscriberManager = require('./subscriber');
var Session           = require('./session');
var LOG               = require('./logger');
var CHError         = require('./countinghouse-error').CHError;

function SocketServer(server, cdifInterface) {
  this.io                = new socketio.Server(server);
  this.cdifInterface     = cdifInterface;
  this.subscriberManager = new SubscriberManager(this.io);
}

util.inherits(SocketServer, events.EventEmitter);

SocketServer.prototype.installHandlers = function() {
  var _this = this;

  //TODO: support event id, cancel and subscription expire time
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

      LOG.I('client subscribe to events of deviceID: ' + deviceID + ', serviceID: '+ serviceID);
      _this.subscriberManager.getSubscriber(socket.id, _this.io, info, function(subscriber) {
        //TODO: add user key support
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
    socket.on('disconnect', function() {
      _this.subscriberManager.removeSubscriber(socket.id, function(err, subscriber, info) {
        if (!err) {
          var deviceID            = info.deviceID;
          var serviceID           = info.serviceID;
          var actionName          = info.actionName;
          var input               = info.input;
          var inputKey            = info.inputKey;
          var device_access_token = info.device_access_token;

          //TODO: add user key support
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
