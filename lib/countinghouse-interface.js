var events        = require('events');
var util          = require('util');
var isMainThread  = require('worker_threads').isMainThread;
var options       = require('./cli-options');
var DeviceManager = require('./device-manager');
var LOG           = require('./logger');
var cdifUtil      = require('./countinghouse-util');

var CHError   = require('./countinghouse-error').CHError;
var DeviceError = require('./countinghouse-error').DeviceError;

var RateLimiter   = require('rolling-rate-limiter');
var redis         = require('redis');
var RedisMeteringProvider = require('./metering/redis-provider');


function CdifInterface(mm) {
  this.deviceManager = new DeviceManager(mm);

  // set dm to countinghouse util instance
  cdifUtil.dm = this.deviceManager;
  cdifUtil.ci = this;

  this.rateLimiter = null;
  this.redisClient = null;
  this.meteringProvider = null;

  if (options.heapDump === true) {
    setInterval(function() {
      global.gc();
      LOG.I('heap used: ' + process.memoryUsage().heapUsed);
      // heapdump.writeSnapshot('./' + Date.now() + '.heapsnapshot');
    }, 1 * 60 * 1000);
  }

  if (options.loadProfile === true && isMainThread === true) {
    this.lastMinuteLoadLevel = 0;
    this.loadLevel = 0;
    setInterval(function() {
      this.lastMinuteLoadLevel = this.loadLevel;
      LOG.I('requests in last 10 minutes: ' + this.loadLevel);
      this.loadLevel = 0;
    }.bind(this), 10 * 60 * 1000);
  }

  if (options.globalRateLimit != null && isMainThread === true) {
    this.redisClient   = redis.createClient(options.redisUrl, {db: 9});

    this.redisClient.on('error', function (err) {
      if (options.debug !== true) LOG.E(new CHError('REDIS_CLIENT_ERROR', err.message));
    });

    this.rateLimiter = RateLimiter({
      redis: this.redisClient,
      namespace: "globalRateLimiter",
      interval: 1000,
      maxInInterval: options.globalRateLimit
    });
  }

  // Always available -- checkBalance (see below, exposed via
  // lib/routes/balance.js) doesn't depend on rate limiting being
  // configured. The per-apiKey rateLimit it also provides stays inert
  // unless --apiKeyRateLimit is set (RedisMeteringProvider only builds its
  // internal rolling-rate-limiter when rateLimitMaxPerInterval is given),
  // so leaving this unconditional doesn't change invokeDeviceAction's
  // behavior for a deployment/test run that doesn't set that flag.
  //
  // Deliberately NOT gated to isMainThread === true (unlike most other
  // redis-backed pieces of this file/lib/countinghouse-util.js): sandbox.js
  // constructs its own CdifInterface instance inside every worker thread
  // too, and device modules that compose other modules' actions in-process
  // (see CHUtil.recordCall / pre-installed-packages/composite-demo) need a
  // *working* meteringProvider there to record each internal hop. The
  // tradeoff is one extra Redis connection per worker rather than routing
  // metering calls through the existing worker->main-thread message channel
  // (the way lib/redis-api.js proxies raw Redis commands) -- a reasonable
  // simplification for this demo, called out as a known follow-up in
  // docs/composite-tools.md rather than built now.
  this.meteringProvider = new RedisMeteringProvider({
    redisUrl: options.redisUrl,
    redisDb: 0, // same db session.js/user-auth.js use for appKey-keyed records
    rateLimitMaxPerInterval: options.apiKeyRateLimit,
    rateLimitIntervalMs: 1000
  });

  this.deviceManager.on('presentation', this.onDevicePresentation.bind(this));
}

util.inherits(CdifInterface, events.EventEmitter);

CdifInterface.prototype.discoverAll = function(session) {
  this.deviceManager.emit('discoverall', session);
};

CdifInterface.prototype.stopDiscoverAll = function(session) {
  this.deviceManager.emit('stopdiscoverall', session);
};

CdifInterface.prototype.getDiscoveredDeviceList = function(session) {
  if (options.loadProfile === true) this.loadLevel ++;

  this.deviceManager.emit('devicelist', session);
};

CdifInterface.prototype.invokeDeviceAction = function(deviceID, serviceID, actionName, args, token, session) {
  if (options.loadProfile === true) this.loadLevel ++;

  var _this = this;
  var doInvoke = function() {
    _this.deviceManager.emit('invokeaction', deviceID, serviceID, actionName, args, token, session);
  };
  var checkApiKeyRateLimit = function() {
    if (session.appKey == null) return doInvoke();

    _this.rateLimit(session.appKey, function(err, result) {
      if (err) return doInvoke(); // redis failed, allow action -- same fail-open behavior as the global limiter below
      if (result.limited === true) return session.callbackWithoutTimer(new DeviceError('DENY_DEVICE_ACCESS'), null);
      return doInvoke();
    });
  };

  if (this.rateLimiter != null && isMainThread === true) {
    this.rateLimiter('globalratelimit', function(err, timeLeft, actionsLeft) {
      if (err) {
        // redis failed, allow action
        checkApiKeyRateLimit();
      } else if (timeLeft) {
        return session.callbackWithoutTimer(new DeviceError('DENY_DEVICE_ACCESS'), null);
      } else {
        checkApiKeyRateLimit();
      }
    });
  } else {
    checkApiKeyRateLimit();
  }
};

CdifInterface.prototype.invokeJobs = function(deviceID, serviceID, actionName, input, jobID, callback) {
    this.deviceManager.emit('invokejobs', deviceID, serviceID, actionName, input, jobID, callback);
};


CdifInterface.prototype.getDeviceSpec = function(deviceID, token, session) {
  if (options.loadProfile === true) this.loadLevel ++;

  this.deviceManager.emit('getspec', deviceID, token, session);
};

CdifInterface.prototype.getDevicePackageInfo = function(deviceID, callback) {
  this.deviceManager.emit('getdevicepackageinfo', deviceID, callback);
};

CdifInterface.prototype.getDevicePackageModulePath = function(deviceID, callback) {
  this.deviceManager.emit('getdevicepackagemodulepath', deviceID, callback);
};

CdifInterface.prototype.getDeviceSchema = function(deviceID, path, token, session) {
  if (options.loadProfile === true) this.loadLevel ++;

  this.deviceManager.emit('getschema', deviceID, path, token, session);
};

CdifInterface.prototype.invokeDeviceCallbacks = function(deviceID, path, data, token, session) {
  if (options.loadProfile === true) this.loadLevel ++;

  if (this.rateLimiter != null && isMainThread === true) {
    this.rateLimiter('globalratelimit', function(err, timeLeft, actionsLeft) {
      if (err) {
        // redis failed, allow action
        this.deviceManager.emit('invokecallback', deviceID, path, data, token, session);
      } else if (timeLeft) {
        return session.callbackWithoutTimer(new DeviceError('DENY_DEVICE_ACCESS'), null);
      } else {
        this.deviceManager.emit('invokecallback', deviceID, path, data, token, session);
      }
    }.bind(this));
  } else {
    this.deviceManager.emit('invokecallback', deviceID, path, data, token, session);
  }
};

CdifInterface.prototype.checkBalance = function(apiKey, callback) {
  if (this.meteringProvider == null) return callback(new CHError('SYSTEM_ERROR'));
  return this.meteringProvider.checkBalance(apiKey, callback);
};

CdifInterface.prototype.recordCall = function(apiKey, tool, cost, callback) {
  if (this.meteringProvider == null) return callback(new CHError('SYSTEM_ERROR'));
  return this.meteringProvider.recordCall(apiKey, tool, cost, callback);
};

// unlike checkBalance/recordCall, a missing meteringProvider fails open here
// (limited: false) rather than erroring -- matches invokeDeviceAction's own
// existing rate-limit checks below, which always fail open (on a missing
// limiter, a Redis error, etc.) rather than denying access as a side effect
// of infrastructure being unavailable.
CdifInterface.prototype.rateLimit = function(apiKey, callback) {
  if (this.meteringProvider == null) return callback(null, {limited: false});
  return this.meteringProvider.rateLimit(apiKey, callback);
};

CdifInterface.prototype.onDevicePresentation = function(deviceID) {
  this.emit('presentation', deviceID);
};

//For now we ignore interval argument
CdifInterface.prototype.getServerLoadLevel = function(interval, callback) {
  callback(null, this.lastMinuteLoadLevel);
};

module.exports = CdifInterface;
