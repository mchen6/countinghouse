var CdifError   = require('./cdif-error').CdifError;
var DeviceError = require('./cdif-error').DeviceError;
var Timer       = require('./timer');
var LOG         = require('./logger');
var once        = require('once');
var options     = require('./cli-options');
var redis       = require("redis");
var redisClient = redis.createClient(options.redisUrl);

redisClient.on('error', function (err) {
  LOG.E(err);
});

function Session(req, res, username, appKey, balance, deviceID, apiRemainCount) {
  this.req            = req;
  this.res            = res;
  this.username       = username;           // user's name
  this.appKey         = appKey;             // user's appKey
  this.balance        = balance;            // user's balance
  this.apiRemainCount = apiRemainCount;     // user's remaining api count
  this.deviceID       = deviceID;
  this.timer          = null;
  this.device         = null;

  //below two field would be set by device manager when we do api monitoring
  //only successful api call would set these two fields for api logging
  this.serviceID  = null;
  this.actionName = null;
  this.apiLog     = false;
  this.apiKeyFreq = null;

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
      return LOG.DE(this.device, new CdifError('DEVICE_ACCESS_ERROR', err.message, data));
    }
    this.res.status(500).json({topic: err.topic, message: err.message});
    return LOG.DE(this.device, new CdifError('DEVICE_ACCESS_ERROR', err.message));
  } else {
    if (options.enableAPIMonitor === true) {
      if (this.serviceID != null && this.actionName != null) {
        var apiChannel = this.appKey + '#' + this.deviceID + '#' + this.serviceID + '#' + this.actionName;
        //TODO: if consumed (length of the above list) > apiRemainCount deny api call
        //TODO: can we update apiRemainCount to redis cache? so we can when update to zero deny api call
        if (this.apiLog === true && this.req != null && this.req.body != null && this.req.body.input != null && data != null) {
          redisClient.multi()
            .sadd('nightlyset', apiChannel)
            .rpush('list:' + apiChannel, Date.now())                             //timestamp
            .rpush('input:' + apiChannel,  JSON.stringify(this.req.body.input))  //input data
            .rpush('output:' + apiChannel, JSON.stringify(data.output))          //output data
            .exec(function(e, reply) {
              if (e) LOG.E(e);
            });
        } else {
          redisClient.multi()
            .sadd('nightlyset', apiChannel)
            .rpush('list:' + apiChannel, Date.now())
            .exec(function(e, reply) {
              if (e) LOG.E(e);
            });
        }
      }
    }
    // this is not the real cache value, but the api key access frequency
    if (this.apiKeyFreq != null) this.res.setHeader('Cache-Control', 'max-age=' + this.apiKeyFreq);
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
