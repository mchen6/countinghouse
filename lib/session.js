var CdifError   = require('./cdif-error').CdifError;
var DeviceError = require('./cdif-error').DeviceError;
var options     = require('./cli-options');
var Timer       = require('./timer');
var LOG         = require('./logger');
var once        = require('once');
var redis       = require("redis");
var redisClient = redis.createClient(options.redisUrl);

var WorkerMessage = require('./worker-message');

redisClient.on('error', function (err) {
  if (options.debug !== true) LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
});

function Session(req, res, username, appKey, balance, deviceID, apiRemainCount, localCallback) {
  this.req            = req;
  this.res            = res;
  this.username       = username;           // user's name
  this.appKey         = appKey;             // user's appKey
  this.balance        = balance;            // user's balance
  this.apiRemainCount = apiRemainCount;     // user's remaining api count
  this.realPrice      = 0;                  // api's realPrice, set by service code
  this.deviceID       = deviceID;
  this.timer          = null;
  this.device         = null;               // this field is set by setDeviceTimer call below
  this.userDevices    = null;               // user's device list

  this.localCallback  = localCallback;      // a local callback from other services in the same cdif instance, only available in service-client

  //below two fields are set by user auth code for external http call, or by service-client code for internal service call
  //only successful api call would set these two fields for api logging
  this.serviceID  = null;
  this.actionName = null;
  // this field is filled by service code when it get the api spec
  this.apiLog     = false;
  this.apiKeyFreq = null;

  this.localInput = null;    // to be filled by the session obj created by service-client

  this.redirect         = this.redirect.bind(this);
  this.callback         = once(this.callback.bind(this));
  this.setDeviceTimer   = this.setDeviceTimer.bind(this);
  this.clearDeviceTimer = this.clearDeviceTimer.bind(this);

  this.startTime = Date.now();
};

Session.prototype.redirect = function(url) {
  this.res.redirect(url);
};

Session.prototype.callback = function(err, data) {
  // timer has been cleared and this could be the second time the callback is invoked from device module
  if (this.timer == null) return;

  if (this.localCallback == null) this.res.setHeader('Content-Type', 'application/json');

  if (this.timer.expired === true) {
    this.timer = null;
    if (this.localCallback != null) {
      this.logAPICall(err, this.localInput, data, false);
      return this.localCallback(new Error(err.message), null);
    }
    this.logAPICall(err, this.req.body, data, true);
    return this.res.status(500).json({topic: err.topic, message: err.message});
  }
  this.clearDeviceTimer();
  if (this.localCallback != null) {
    this.logAPICall(err, this.localInput, data, false);
    return this.localCallback(err, data);
  }
  this.logAPICall(err, this.req.body, data, true);
  return this.response(err, data);
};

Session.prototype.callbackWithoutTimer = function(err, data) {
  if (this.localCallback != null) {
    this.logAPICall(err, this.localInput, data, false);
    return this.localCallback(err, data);
  }
  this.logAPICall(err, this.req.body, data, true);
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
  } else {
    // this is not the real cache value, but the api key access frequency
    if (this.apiKeyFreq != null) this.res.setHeader('Cache-Control', 'max-age=' + this.apiKeyFreq);
    this.res.status(200).json(data);
  }
};

//
// Depend of whether this is a log request from local service-client call (localInput) or normal http call(req.body)
// the detail log format could be different. e.g. for local call the logged input would be {input: {...}}
// for http call the logged input would be {serviceID: '...', actionName: '...', input: {...}}
//
Session.prototype.logAPICall = function(err, input, data, isHTTPCall) {
  if (err != null) {
    if (options.debug === true) {
      if (input != null) {
        LOG.DE(this.device, new CdifError('DEVICE_ACCESS_ERROR', err.message, 'input:', input, 'fault: ', data));
      } else {
        LOG.DE(this.device, new CdifError('DEVICE_ACCESS_ERROR', err.message, 'fault: ', data));
      }
    }
  }

  if (options.apiMonitor === true) {
    var now = Date.now();
    var makeDetailLog = false;
    //we don't count get-spec and schema calls so here we check non-null-ness of serviceID and actionName in the session obj
    //for error logs this only log valid input (with valid serviceID, actionName and input)
    if (this.serviceID != null && this.actionName != null) {
      var apiChannel = this.appKey + '#' + this.deviceID + '#' + this.serviceID + '#' + this.actionName;

      if (this.device instanceof WorkerMessage) {
        //deviceList elements is spec object, see device-manager onWorkerLoaded code
        var deviceList = this.device.deviceList;
        for (var i = 0; i < deviceList.length; i++) {
          if (deviceList[i].device.deviceID === this.deviceID) {
            var sl = deviceList[i].device.serviceList;
            if (sl == null) return;                                             // early return from logAPICall if serviceList is not found in device spec
            if (sl[this.serviceID] == null) return;                             // early return from logAPICall if non-matching serviceID found
            if (sl[this.serviceID].actionList == null) return;                  // early return from logAPICall if actionList is null in device spec
            if (sl[this.serviceID].actionList[this.actionName] == null) return; // early return from logAPICall if non-matching actionName found

            makeDetailLog = sl[this.serviceID].actionList[this.actionName].apiLog;
            break; //we can break loop if found first matching element
          }
        }
      } else {
        var spec = this.device.spec;
        var sl = spec.device.serviceList;
        if (sl[this.serviceID] == null) return;                             // early return from logAPICall if non-matching serviceID found
        if (sl[this.serviceID].actionList == null) return;                  // early return from logAPICall if actionList is null in device spec
        if (sl[this.serviceID].actionList[this.actionName] == null) return; // early return from logAPICall if non-matching actionName found
        makeDetailLog = this.apiLog;
      }

      // apiLog flag is set by service code when we get device spec
      //first check device spec to see if apiLog flag is set
      //this is to incorporate with worker-thrad mode
      if (makeDetailLog === true) {
        redisClient.multi()
        .sadd('nightlyset', apiChannel)
        .rpush('starttime:' + apiChannel, this.startTime)                                                                            //session start time
        .rpush('list:' + apiChannel, now)                                                                                            //timestamp
        .rpush('input:' + apiChannel,  JSON.stringify(input))                                                                        //input data
        .rpush('output:' + apiChannel,  (err != null) ? JSON.stringify({message: err.message, data: data}) : JSON.stringify(data))   //output data
        .rpush('isError:' + apiChannel, (err != null) ? true : false)                                                                //is this an error call
        .rpush('isHTTP:' + apiChannel, isHTTPCall)                                                                                   //is this a http or local call
        .exec(function(e, reply) {
          if (e) LOG.E(e);
        });
      } else {
        redisClient.multi()
        .sadd('nightlyset', apiChannel)
        .rpush('starttime:' + apiChannel, this.startTime)
        .rpush('list:' + apiChannel, now)
        .rpush('isError:' + apiChannel, (err != null) ? true : false)
        .rpush('isHTTP:' + apiChannel, isHTTPCall)
        .exec(function(e, reply) {
          if (e) LOG.E(e);
        });
      }
      this.updateRedisUserRecord(this.appKey, this.deviceID, this.serviceID, this.actionName, 1);
    }
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

// update redis user record if there are remaining api count or balance
// framework will deny priced action call requests if both <= 0
Session.prototype.updateRedisUserRecord = function(appKey, deviceID, serviceID, actionName, count) {
  //update only priced api, no need to update free api
  if (this.realPrice > 0 && this.userDevices != null) {
    var priceRecord = null;

    for (var i = 0; i < this.userDevices.length; i++) {
      if(this.userDevices[i].deviceID === deviceID) {
        priceRecord = this.userDevices[i].priceRecord;
        break;
      }
    }

    if (priceRecord != null && priceRecord[serviceID] != null && priceRecord[serviceID][actionName] != null) {
      if (priceRecord[serviceID][actionName].count >= count) {
        priceRecord[serviceID][actionName].count -= count;
        return redisClient.multi().hmset(appKey, 'devices', JSON.stringify(this.userDevices)).exec(function(err) {
          if (err) LOG.E(err);
        });
      }
    }
    var totalFee = this.realPrice * count;
    this.balance -= totalFee;
    return redisClient.multi().hmset(appKey, 'balance', this.balance).exec(function(err) {
      if (err) LOG.E(err);
    });
  }
};

module.exports = Session;
