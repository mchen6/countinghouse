const CHError     = require('./countinghouse-error').CHError;
const DeviceError   = require('./countinghouse-error').DeviceError;
const options       = require('./cli-options');
const Timer         = require('./timer');
const LOG           = require('./logger');
const once          = require('once');
const redis         = require('redis');
const Worker        = require('worker_threads').Worker;
const isMainThread  = require('worker_threads').isMainThread;
const WorkerMessage = require('./worker-message');

let redisClient  = null;

//create redis client under single thread mode or main thread
if (isMainThread === true) {
  redisClient    = redis.createClient(options.redisUrl);

  redisClient.on('error', (err) => {
    if (options.debug !== true) LOG.E(new CHError('REDIS_CLIENT_ERROR', err.message));
  });
}

// apiRemainCount kept as a positional parameter -- still passed by every
// call site -- but no longer stored: it was only ever read by the retired
// realPrice/NOT_ENOUGH_USER_BALANCE gate (docs/design-decisions.md's
// AuthProvider section). Same for userDevices/realPrice below.
function Session(req, res, username, appKey, balance, deviceID, apiRemainCount, localCallback) {
  this.req            = req;
  this.res            = res;
  this.username       = username;           // user's name
  this.appKey         = appKey;             // user's appKey
  this.balance        = balance;            // user's balance
  this.deviceID       = deviceID;
  this.timer          = null;
  this.device         = null;               // this field is set by setDeviceTimer call below

  this.localCallback  = localCallback;      // a local callback from other services in the same countinghouse instance, only available in service-client

  //NOTICE: below two fields are set by user auth code for external http call, or by service-client code for internal service call
  //only successful api call would set these two fields for api logging
  //under debug mode these stays null so under debug mode we cannot do api logging to redis
  this.serviceID  = null;
  this.actionName = null;

  this.localInput = null;    // to be filled by the session obj created by service-client

  // Opt-in per-call metering for HTTP-originated action invocations (S3).
  // Set by lib/routes/invoke-action.js to the MeteringProvider `tool`
  // identifier for this call; left null by every other session (get-spec,
  // schema, presentation, ...), none of which are
  // billable events. Explicitly opt-in rather than "meter every session
  // that reaches response()" so that adding a new non-action route can't
  // accidentally start charging for it.
  this.meteredTool = null;

  this.redirect         = this.redirect.bind(this);
  this.callback         = once(this.callback.bind(this));
  this.setDeviceTimer   = this.setDeviceTimer.bind(this);
  this.clearDeviceTimer = this.clearDeviceTimer.bind(this);

  this.startTime = Date.now();
};

Session.prototype.redirect = function(url) {
  this.res.redirect(url);
};

// platformMetering (D5, docs/composite-tools.md's "billing authority"
// principle) is an optional 3rd arg, only ever populated on the
// main-thread-routed cross-worker call path (see
// DeviceManager.prototype.sendInvokeActionMessageToWorker) -- passed
// through to localCallback (a module's own ServiceClient.invoke()
// callback) as-is, never merged into `data`, since `data` is the callee
// action's own already-schema-validated return value and some caller-side
// modules pass it straight through as their own action's output.
Session.prototype.callback = function(err, data, platformMetering) {
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
    return this.res.status(500).json({topic: err.topic, code: err.code, message: err.message});
  }
  this.clearDeviceTimer();
  if (this.localCallback != null) {
    this.logAPICall(err, this.localInput, data, false);
    return this.localCallback(err, data, platformMetering);
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

// Records the call against MeteringProvider for an HTTP-originated action
// invocation, on success only -- the same condition, the same
// CdifInterface.prototype.recordCall, the same options.mcpToolCallCost, and
// the same fire-and-forget style lib/mcp/gateway.js's tools/call path
// already uses, so the two entry paths produce identical metering records
// for the same action.
//
// This exists because the HTTP path's original metering hook
// (Session.prototype.updateRedisUserRecord) was retired during the
// AuthProvider refactor and nothing replaced it: docs/cross-cutting-matrix.md
// still claimed this path was metered, while in practice
// POST /devices/:deviceID/invoke-action charged nothing at all -- a complete
// billing bypass via the pre-MCP HTTP API.
//
// CHUtil is required lazily: lib/countinghouse-util.js -> countinghouse-device.js
// -> session.js is a require cycle, so a top-level require here would see a
// half-initialized module. Same inline-require technique
// lib/device-manager.js and lib/service-client.js already use for user-auth.
Session.prototype.recordMeteredCall = function() {
  if (this.meteredTool == null || this.appKey == null) return;

  const CHUtil = require('./countinghouse-util');
  if (CHUtil.ci == null || typeof(CHUtil.ci.recordCall) !== 'function') return;

  const tool = this.meteredTool;
  this.meteredTool = null; // never bill the same session twice

  CHUtil.ci.recordCall(this.appKey, tool, options.mcpToolCallCost, (err) => {
    if (err) LOG.E(err);
  });
};

Session.prototype.response = function(err, data) {
  if (err) {
    if (data != null) {
      this.res.status(500).json({topic: err.topic, code: err.code, message: err.message, fault: data});
    } else {
      this.res.status(500).json({topic: err.topic, code: err.code, message: err.message});
    }
  } else {
    // success only -- a failed action isn't a billable call, matching
    // gateway.js's `if (result.isError !== true)` guard on the MCP path.
    this.recordMeteredCall();
    this.res.status(200).json(data);
  }
};

// True when `serviceList` declares this session's serviceID + actionName.
Session.prototype.specDeclaresAction = function(serviceList) {
  if (serviceList == null) return false;

  const service = serviceList[this.serviceID];
  if (service == null || service.actionList == null) return false;

  for (let i = 0; i < service.actionList.length; i++) {
    if (service.actionList[i].name === this.actionName) return true;
  }
  return false;
};

//
// Depend of whether this is a log request from local service-client call (localInput) or normal http call(req.body)
// the detail log format could be different. e.g. for local call the logged input would be {input: {...}}
// for http call the logged input would be {serviceID: '...', actionName: '...', input: {...}}
//
Session.prototype.logAPICall = function(err, input, data, isHTTPCall) {
  // we do redis API log only in main thread
  if (isMainThread !== true || redisClient == null) return;

  if (err != null) {
    if (options.debug === true) {
      if (input != null) {
        LOG.E(new CHError('DEVICE_ACCESS_ERROR', err.message, 'input:', input, 'fault: ', data));
      } else {
        LOG.E(new CHError('DEVICE_ACCESS_ERROR', err.message, 'fault: ', data));
      }
    }
  }

  if (options.apiMonitor === true) {
    const now = Date.now();
    //we don't count get-spec and schema calls so here we check non-null-ness of serviceID and actionName in the session obj
    //for error logs this only log valid input (with valid serviceID, actionName and input)
    if (this.device == null) return;

    if (this.serviceID != null && this.actionName != null) {
      const apiChannel = `${this.appKey}#${this.deviceID}#${this.serviceID}#${this.actionName}`;

      // Only log calls that name a service + action the device spec actually
      // declares, so a bogus actionName cannot create redis keys of its own.
      if (this.device instanceof WorkerMessage) {
        //deviceList elements is spec object, see device-manager onWorkerLoaded code
        const deviceList = this.device.deviceList;

        for (const deviceID in deviceList) {
          if (deviceID === this.deviceID) {
            if (this.specDeclaresAction(deviceList[deviceID].device.serviceList) !== true) return;
            break; //we can break loop if found first matching element
          }
        }
      } else {
        if (this.specDeclaresAction(this.device.spec.device.serviceList) !== true) return;
      }

      // Summary log only. The per-action `apiLog` spec flag that used to
      // switch this to a detailed log (input + output bodies pushed into
      // redis per call) was removed in 5.0.0.
      redisClient.multi()
      .sadd('nightlyset', apiChannel)
      .rpush(`starttime:${apiChannel}`, this.startTime)
      .rpush(`list:${apiChannel}`, now)
      .rpush(`isError:${apiChannel}`, (err != null) ? true : false)
      .rpush(`isHTTP:${apiChannel}`, isHTTPCall)
      .exec((e, reply) => {
        if (e) LOG.E(e);
      });
    }
  }
};

Session.prototype.setDeviceTimer = function(device, callback) {
  this.device = device; // set device instance so we can log its error and set lastDeviceError, see LOG.DE call above

  // TODO: configurable max no. of parallel ops, it can be done by counting numbers of alive timers
  this.installTimer((err, timer) => {
    if (err) {
      return callback(err, device, null);
    }
    callback(null, device, timer);
  });
};

Session.prototype.installTimer = function(callback) {
  const timer  = new Timer();
  this.timer = timer;
  timer.once('expired', (timer) => {
    clearTimeout(timer.timeout);
    return this.callback(new DeviceError('DEVICE_NOT_RESPONDING'), null);
  });
  callback(null, timer);
};

Session.prototype.clearDeviceTimer = function() {
  if (this.timer != null) {
    clearTimeout(this.timer.timeout);
    this.timer = null;
  }
};


module.exports = Session;
