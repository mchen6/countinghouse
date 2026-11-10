const events        = require('events');
const util          = require('util');
const isMainThread  = require('worker_threads').isMainThread;
const options       = require('./cli-options');
const handlerCtx    = require('./handler-ctx');
const DeviceManager = require('./device-manager');
const LOG           = require('./logger');
const cdifUtil      = require('./countinghouse-util');

const CountinghouseError = require('./countinghouse-error').CountinghouseError;

// The global limiter's client and limiter answer while Redis is down (review M5).
const redisResilient = require('./redis-resilient');
const RedisMeteringProvider = require('./metering/redis-provider');

function CdifInterface(mm) {
  this.deviceManager = new DeviceManager(mm);

  // set dm to countinghouse util instance
  cdifUtil.dm = this.deviceManager;
  cdifUtil.ci = this;

  this.rateLimiter = null;
  this.redisClient = null;
  this.meteringProvider = null;

  if (options.heapDump === true) {
    setInterval(() => {
      global.gc();
      LOG.I(`heap used: ${process.memoryUsage().heapUsed}`);
      // heapdump.writeSnapshot('./' + Date.now() + '.heapsnapshot');
    }, 1 * 60 * 1000);
  }

  if (options.globalRateLimit != null && isMainThread === true) {
    this.redisClient   = redisResilient.createClient(options.redisUrl, {db: 9});

    this.redisClient.on('error', (err) => {
      if (options.debug !== true) LOG.E(new CountinghouseError('REDIS_CLIENT_ERROR', err.message));
    });

    this.rateLimiter = redisResilient.rateLimiter({
      redis: this.redisClient,
      namespace: "globalRateLimiter",
      interval: 1000,
      maxInInterval: options.globalRateLimit
    });
  }

  // On the main thread only (review M6). Metering runs there: the routed
  // path (DeviceManager.prototype.sendInvokeActionMessageToWorker), the peer
  // broker (PeerChannelBroker.prototype.handleMeteringRequest) and sessions.
  // A worker used to build its own provider on db 0, the balance ledger,
  // and module code reaches its worker's CdifInterface (CHUtil.ci, a
  // documented gap), so a module could recordCall(anyKey, t, -N) to credit a
  // key or +N to debit anyone. A worker holds none: recordCall and
  // checkBalance answer SYSTEM_ERROR there and rateLimit fails open, which
  // nothing in a worker reaches (a worker's invokeDeviceAction gets a bare
  // callback as its session). This removes the worker's ready, connected
  // handle on the ledger; it is not network isolation (module code can still
  // open its own connections until sandbox parts 3 and 4,
  // docs/security-model.md).
  //
  // checkBalance (lib/routes/balance.js) doesn't depend on rate limiting
  // being configured. The per-apiKey rateLimit stays inert unless
  // --apiKeyRateLimit is set (RedisMeteringProvider only builds its internal
  // rolling-rate-limiter when rateLimitMaxPerInterval is given).
  if (isMainThread === true) {
    this.meteringProvider = new RedisMeteringProvider({
      redisUrl: options.redisUrl,
      redisDb: 0, // same db session.js/user-auth.js use for appKey-keyed records
      rateLimitMaxPerInterval: options.apiKeyRateLimit,
      rateLimitIntervalMs: 1000
    });
  }
}

util.inherits(CdifInterface, events.EventEmitter);

CdifInterface.prototype.discoverAll = function(session) {
  this.deviceManager.emit('discoverall', session);
};

CdifInterface.prototype.stopDiscoverAll = function(session) {
  this.deviceManager.emit('stopdiscoverall', session);
};

CdifInterface.prototype.getDiscoveredDeviceList = function(session) {
  this.deviceManager.emit('devicelist', session);
};

CdifInterface.prototype.invokeDeviceAction = function(deviceID, serviceID, actionName, args, session) {
  // Every entry path funnels through here, so this is where the caller's
  // identity becomes available to a handler's ctx (lib/handler-ctx.js).
  // Previously only lib/routes/invoke-action.js set args.ctx, so an action
  // reached over MCP -- the primary surface -- had no caller context at all.
  //
  // It is the *identity*, never the Session, and that is load-bearing rather
  // than tidiness: args travels into worker threads (structured clone) and
  // into job payloads (bullmq serializes them). A Session holds req/res, which
  // are circular and uncloneable, so putting one here deadlocks the
  // task-augmented path instead of failing visibly.
  //
  // Left alone when `session` is not an object: on worker re-entry it is a
  // bare callback, and args.ctx already carries the forwarded identity.
  if (args != null && session != null && typeof(session) === 'object') {
    args.ctx = handlerCtx.wireIdentityOf(session);
  }

  const _this = this;
  const doInvoke = function() {
    _this.deviceManager.emit('invokeaction', deviceID, serviceID, actionName, args, session);
  };
  const checkApiKeyRateLimit = function() {
    if (session.appKey == null) return doInvoke();

    _this.rateLimit(session.appKey, (err, result) => {
      if (err) return doInvoke(); // redis failed, allow action -- same fail-open behavior as the global limiter below
      if (result.limited === true) return session.callbackWithoutTimer(new CountinghouseError('DENY_DEVICE_ACCESS'), null);
      return doInvoke();
    });
  };

  if (this.rateLimiter != null && isMainThread === true) {
    this.rateLimiter('globalratelimit', (err, timeLeft, actionsLeft) => {
      if (err) {
        // redis failed, allow action
        checkApiKeyRateLimit();
      } else if (timeLeft) {
        return session.callbackWithoutTimer(new CountinghouseError('DENY_DEVICE_ACCESS'), null);
      } else {
        checkApiKeyRateLimit();
      }
    });
  } else {
    checkApiKeyRateLimit();
  }
};

// cancelled (optional): asked before the job is sent to its worker; true once
// the job processor has given up on this run (its timeout), so nothing starts
// for it.
CdifInterface.prototype.invokeJobs = function(deviceID, serviceID, actionName, input, jobID, callback, cancelled) {
    this.deviceManager.emit('invokejobs', deviceID, serviceID, actionName, input, jobID, callback, cancelled);
};


CdifInterface.prototype.getDeviceSpec = function(deviceID, session) {
  this.deviceManager.emit('getspec', deviceID, session);
};

CdifInterface.prototype.getDevicePackageInfo = function(deviceID, callback) {
  this.deviceManager.emit('getdevicepackageinfo', deviceID, callback);
};

CdifInterface.prototype.getDeviceSchema = function(deviceID, path, session) {
  this.deviceManager.emit('getschema', deviceID, path, session);
};

CdifInterface.prototype.checkBalance = function(apiKey, callback) {
  if (this.meteringProvider == null) return callback(new CountinghouseError('SYSTEM_ERROR'));
  return this.meteringProvider.checkBalance(apiKey, callback);
};

CdifInterface.prototype.recordCall = function(apiKey, tool, cost, callback) {
  if (this.meteringProvider == null) return callback(new CountinghouseError('SYSTEM_ERROR'));
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

module.exports = CdifInterface;
