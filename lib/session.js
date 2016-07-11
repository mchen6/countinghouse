var CdifError   = require('./error').CdifError;
var DeviceError = require('./error').DeviceError;
var Timer       = require('./timer');
var uuid        = require('uuid');

function Session(req, res) {
  this.req     = req;
  this.res     = res;
  this.timers  = {};

  this.redirect         = this.redirect.bind(this);
  this.callback         = this.callback.bind(this);
  this.setDeviceTimer   = this.setDeviceTimer.bind(this);
  this.clearDeviceTimer = this.clearDeviceTimer.bind(this);
};

Session.prototype.redirect = function(url) {
  this.res.redirect(url);
};

//TODO: consider wrap this with https://www.npmjs.com/package/once
Session.prototype.callback = function(err, data) {
  // console.log(new Error().stack);
  if (this.res) {
    this.res.setHeader('Content-Type', 'application/json');
    if (err) {
      this.res.status(500).json({topic: err.topic, message: err.message});
    } else {
      this.res.status(200).json(data);
    }
  }
};

Session.prototype.setDeviceTimer = function(device, callback) {
  if (device.online === false) {
    return callback(new CdifError('set timer for an offlined device'), device, null);
  }

  // TODO: configurable max no. of parallel ops, it can be done by counting numbers of alive timers
  this.installTimer(device, function(err, device, timer) {
    if (err) {
      return callback(err, device, null);
    }
    callback(null, device, timer);
  });
};

Session.prototype.installTimer = function(device, callback) {
  var timer = new Timer(device, this);
  this.timers[timer.uuid] = timer;
  callback(null, device, timer);
};

Session.prototype.clearDeviceTimer = function(timer) {
  var uuid = timer.uuid;

  if (uuid == null) return false;

  clearTimeout(this.timers[uuid].timeout);
  delete this.timers[uuid];
  return true;
};

module.exports = Session;
