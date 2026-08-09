// Default MeteringProvider implementation, backed by Redis. Mirrors the
// existing per-apiKey redis hash schema already used by lib/user-auth.js /
// lib/session.js (hash key = apiKey, fields include `userName`, `balance`
// (number), `devices` (JSON-stringified array of {deviceID, priceRecord})),
// so this can read/write the same records those already produce -- rather
// than inventing a parallel, incompatible schema.
//
// Note: this is a standalone module, not yet wired into the live
// invoke-action path (lib/session.js/lib/user-auth.js still do their own
// inline metering). Per the plan doc's Sprint 4 scope ("first version:
// interface + Redis impl + one x402 PoC export, don't expand further"),
// swapping the live path over to this abstraction is a deliberate follow-up,
// not done here.
var util         = require('util');
var redis        = require('redis');
var RateLimiter   = require('rolling-rate-limiter');
var MeteringProvider = require('./provider');
var options       = require('../cli-options');

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
// field, keyed directly by the caller-supplied `tool` identifier (a single
// opaque string -- e.g. an MCP tool name -- rather than the older
// serviceID/actionName pair lib/session.js's priceRecord uses). Kept as a
// separate field from the existing `devices` blob so this can run
// alongside the current billing path without conflicting with it.
RedisMeteringProvider.prototype.recordCall = function(apiKey, tool, cost, callback) {
  var _this = this;

  this.redisClient.hmget(apiKey, 'balance', 'toolPriceRecord', function(err, results) {
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

module.exports = RedisMeteringProvider;
