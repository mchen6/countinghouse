var CdifError   = require('./error').CdifError;
var DeviceError = require('./error').DeviceError;
var Timer       = require('./timer');
var LOG         = require('./logger');
var once        = require('once');

function Session(req, res, username) {
  this.req      = req;
  this.res      = res;
  this.username = username;
  this.timers   = {};
  this.device   = null;

  //below two field would be set by device manager when we do api monitoring
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
  if (this.res) {
    this.res.setHeader('Content-Type', 'application/json');
    if (err) {
      if (data != null) {
        this.res.status(500).json({topic: err.topic, message: err.message, fault: data});
      } else {
        this.res.status(500).json({topic: err.topic, message: err.message});
      }
      return LOG.DE(this.device, new CdifError(err.message));
    } else {
      this.res.status(200).json(data);
    }
  }
};

Session.prototype.setDeviceTimer = function(device, callback) {
  this.device = device; // set device instance so we can log its error and set lastDeviceError, see LOG.DE call above

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
  var timer = new Timer(this);
  this.timers[timer.uuid] = timer;
  timer.once('expired', function(timer) {
    clearTimeout(timer.timeout);
    timer.session = null;
    delete this.timers[timer.uuid];
    return this.callback(new DeviceError('device not responding'), null);
  }.bind(this));
  callback(null, device, timer);
};

Session.prototype.clearDeviceTimer = function(timer) {
  var uuid = timer.uuid;

  if (uuid == null) return false;

  if (this.timers[uuid]) {
    clearTimeout(this.timers[uuid].timeout);
    delete this.timers[uuid];
  }

  return true;
};

module.exports = Session;
