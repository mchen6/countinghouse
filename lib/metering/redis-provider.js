// Default MeteringProvider implementation, backed by Redis. Mirrors the
// existing per-apiKey redis hash schema already used by lib/user-auth.js /
// lib/session.js (hash key = apiKey, fields include `userName`, `balance`
// (number), `devices` (JSON-stringified array of {deviceID, priceRecord})),
// so this can read/write the same records those already produce -- rather
// than inventing a parallel, incompatible schema.
//
// This is wired into the live invoke-action path via
// Session.prototype.updateRedisUserRecord (lib/session.js), which
// constructs `tool` via encodeLegacyTool(deviceID, serviceID, actionName)
// so free-call counts already set up under the old
// devices[].priceRecord[serviceID][actionName] shape (sourced from CouchDB,
// see lib/user-auth.js) keep being honored -- see the adapter note on
// recordCall below. Other callers (e.g. the MCP gateway) are free to pass
// any opaque `tool` string; the legacy-schema fallback only applies when a
// `tool` was actually built with encodeLegacyTool.
var util          = require('util');
var redis         = require('redis');
var RateLimiter    = require('rolling-rate-limiter');
var MeteringProvider = require('./provider');
var options        = require('../cli-options');

// deviceID/serviceID/actionName can't contain this exact sequence in
// practice (deviceIDs are UUIDs, serviceIDs are URNs using single/double
// colons, actionNames are plain identifiers), so it's a safe, reversible
// delimiter for encoding the legacy three-part lookup key into the single
// opaque `tool` string the MeteringProvider interface expects.
var LEGACY_TOOL_DELIMITER = ':::';

function encodeLegacyTool(deviceID, serviceID, actionName) {
  return deviceID + LEGACY_TOOL_DELIMITER + serviceID + LEGACY_TOOL_DELIMITER + actionName;
}

function decodeLegacyTool(tool) {
  var parts = String(tool).split(LEGACY_TOOL_DELIMITER);
  if (parts.length !== 3) return null;
  return {deviceID: parts[0], serviceID: parts[1], actionName: parts[2]};
}

function RedisMeteringProvider(opts) {
  MeteringProvider.call(this);
  opts = opts || {};

  this.redisClient = opts.redisClient || redis.createClient(
    opts.redisUrl || options.redisUrl,
    {db: opts.redisDb != null ? opts.redisDb : 12}
  );

  this._rateLimiter = null;
  if (opts.rateLimitMaxPerInterval != null) {
    this._rateLimiter = RateLimiter({
      redis: this.redisClient,
      namespace: 'meteringRateLimiter',
      interval: opts.rateLimitIntervalMs || 1000,
      maxInInterval: opts.rateLimitMaxPerInterval
    });
  }
}

util.inherits(RedisMeteringProvider, MeteringProvider);

RedisMeteringProvider.prototype.checkBalance = function(apiKey, callback) {
  this.redisClient.hmget(apiKey, 'balance', function(err, results) {
    if (err) return callback(err);
    var balance = (results[0] != null) ? +results[0] : 0;
    return callback(null, {apiKey: apiKey, balance: balance});
  });
};

// Tool-level free-call counts are tracked under a `toolPriceRecord` hash
// field, keyed directly by the caller-supplied `tool` identifier. If no
// entry exists there yet *and* `tool` decodes as a legacy
// encodeLegacyTool(deviceID, serviceID, actionName) key, this falls back to
// reading the count from the existing `devices[].priceRecord[serviceID]
// [actionName]` structure (populated from CouchDB by lib/user-auth.js) --
// so pricing data set up under the old schema keeps being honored on read.
// Every deduction, whether it came from the legacy fallback or not, is
// always written back to the new `toolPriceRecord` field going forward
// (the old `devices` blob itself is never modified by this path anymore).
RedisMeteringProvider.prototype.recordCall = function(apiKey, tool, cost, callback) {
  var _this = this;

  this.redisClient.hmget(apiKey, 'balance', 'toolPriceRecord', 'devices', function(err, results) {
    if (err) return callback(err);

    var balance     = (results[0] != null) ? +results[0] : 0;
    var priceRecord = {};

    if (results[1] != null) {
      try {
        priceRecord = JSON.parse(results[1]);
      } catch (e) {
        return callback(e);
      }
    }

    if (priceRecord[tool] == null && results[2] != null) {
      var legacy = decodeLegacyTool(tool);
      if (legacy != null) {
        try {
          var devices = JSON.parse(results[2]);
          for (var i = 0; i < devices.length; i++) {
            if (devices[i].deviceID !== legacy.deviceID) continue;
            var legacyPriceRecord = devices[i].priceRecord;
            if (legacyPriceRecord != null &&
                legacyPriceRecord[legacy.serviceID] != null &&
                legacyPriceRecord[legacy.serviceID][legacy.actionName] != null) {
              priceRecord[tool] = {count: legacyPriceRecord[legacy.serviceID][legacy.actionName].count};
            }
            break;
          }
        } catch (e) {
          // malformed legacy `devices` blob -- ignore and fall through to balance deduction below
        }
      }
    }

    if (priceRecord[tool] != null && priceRecord[tool].count > 0) {
      priceRecord[tool].count -= 1;
      return _this.redisClient.multi().hmset(apiKey, 'toolPriceRecord', JSON.stringify(priceRecord)).exec(function(err) {
        if (err) return callback(err);
        return callback(null, {
          apiKey: apiKey, tool: tool, charged: 0, balance: balance,
          remainingFreeCalls: priceRecord[tool].count
        });
      });
    }

    var newBalance = balance - cost;
    return _this.redisClient.multi().hmset(apiKey, 'balance', newBalance).exec(function(err) {
      if (err) return callback(err);
      return callback(null, {apiKey: apiKey, tool: tool, charged: cost, balance: newBalance});
    });
  });
};

RedisMeteringProvider.prototype.rateLimit = function(apiKey, callback) {
  if (this._rateLimiter == null) return callback(null, {limited: false});

  this._rateLimiter(apiKey, function(err, timeLeft, actionsLeft) {
    if (err) return callback(err);
    return callback(null, {
      limited: (timeLeft != null && timeLeft > 0),
      timeLeft: timeLeft,
      actionsLeft: actionsLeft
    });
  });
};

RedisMeteringProvider.encodeLegacyTool = encodeLegacyTool;
RedisMeteringProvider.decodeLegacyTool = decodeLegacyTool;

module.exports = RedisMeteringProvider;
