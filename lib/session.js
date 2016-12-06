var CdifError   = require('./error').CdifError;
var DeviceError = require('./error').DeviceError;
var Timer       = require('./timer');
var LOG         = require('./logger');
var once        = require('once');

function Session(req, res, username, appKey, balance) {
  this.req      = req;
  this.res      = res;
  this.username = username;
  this.appKey   = appKey;
  this.balance  = balance;
  this.timer    = null;
  this.device   = null;

  //below two field would be set by device manager when we do api monitoring
  //only successful api call would set these two fields for api logging
  this.serviceID  = '';
  this.actionName = '';

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
      return LOG.DE(new CdifError(err.message));
    }
    return LOG.E(new CdifError(err.message));
  } else {
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
    return this.callback(new DeviceError('device not responding'), null);
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
