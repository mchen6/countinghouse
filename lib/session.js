var CdifError   = require('./error').CdifError;
var DeviceError = require('./error').DeviceError;
var Timer       = require('./timer');
var LOG         = require('./logger');
var once        = require('once');
var options     = require('./cli-options');
var redis       = require('redis');
var pub         = redis.createClient(options.redisUrl);

pub.on('error', function (err) {
  LOG.E(err);
});

function Session(req, res, username, appKey, balance, deviceID, freeAPICount) {
  this.req          = req;
  this.res          = res;
  this.username     = username;     // user's name
  this.appKey       = appKey;       // user's appKey
  this.balance      = balance;      // user's balance
  this.freeAPICount = freeAPICount; // user's free api count, all apis which has this field will set this info
  this.deviceID     = deviceID;
  this.timer        = null;
  this.device       = null;

  //below two field would be set by device manager when we do api monitoring
  //only successful api call would set these two fields for api logging
  this.serviceID  = null;
  this.actionName = null;

  this.redirect         = this.redirect.bind(this);
  this.callback         = once(this.callback.bind(this));
  this.setDeviceTimer   = this.setDeviceTimer.bind(this);
  this.clearDeviceTimer = this.clearDeviceTimer.bind(this);
};

Session.prototype.redirect = function(url) {
  this.res.redirect(url);
};

Session.prototype.callback = function(err, data) {
  // console.log(new Error().stack);
  if (this.timer == null) return;

  this.res.setHeader('Content-Type', 'application/json');

  if (this.timer.expired === true) {
    this.timer = null;
    return this.res.status(500).json({topic: err.topic, message: err.message});
  }
  this.clearDeviceTimer();
  this.response(err, data);
};

Session.prototype.callbackWithoutTimer = function(err, data) {
  this.res.setHeader('Content-Type', 'application/json');
  this.response(err, data);
};

Session.prototype.response = function(err, data) {
  if (err) {
    if (data != null) {
      this.res.status(500).json({topic: err.topic, message: err.message, fault: data});
    } else {
      this.res.status(500).json({topic: err.topic, message: err.message});
    }
    if (this.device != null) {
      return LOG.DE(this.device, new CdifError('DEVICE_ACCESS_ERROR', err.message));
    }
    return LOG.E(new CdifError('DEVICE_ACCESS_ERROR', err.message));
  } else {
    if (options.enableAPIMonitor === true) {
      if (pub != null && this.serviceID != null && this.actionName != null) {
        var channel = {};
        //TODO: add more topic like schema and get-spec later on
        channel.topic         = 'invoke-action';
        channel.deviceID      = this.deviceID;
        channel.serviceID     = this.serviceID;
        channel.actionName    = this.actionName;
        var channelName       = JSON.stringify(channel);
        var freeAPICount      = 0;

        if (this.freeAPICount != null &&
            this.freeAPICount[this.serviceID] != null &&
            this.freeAPICount[this.serviceID][this.actionName] != null
           )
        {
          freeAPICount = this.freeAPICount[this.serviceID][this.actionName];
        }
        var message = JSON.stringify({appKey: this.appKey, username: this.username, timestamp: Date.now(), freeAPICount: freeAPICount});
        pub.publish(channelName, message);
      }
    }
    this.res.status(200).json(data);
  }
};

Session.prototype.setDeviceTimer = function(device, callback) {
  this.device = device; // set device instance so we can log its error and set lastDeviceError, see LOG.DE call above

  // TODO: configurable max no. of parallel ops, it can be done by counting numbers of alive timers
  this.installTimer(function(err, timer) {
    if (err) {
      return callback(err, device, null);
    }
    callback(null, device, timer);
  });
};

Session.prototype.installTimer = function(callback) {
  var timer  = new Timer();
  this.timer = timer;
  timer.once('expired', function(timer) {
    clearTimeout(timer.timeout);
    return this.callback(new DeviceError('DEVICE_NOT_RESPONDING'), null);
  }.bind(this));
  callback(null, timer);
};

Session.prototype.clearDeviceTimer = function() {
  if (this.timer != null) {
    clearTimeout(this.timer.timeout);
    this.timer = null;
  }
};

module.exports = Session;
