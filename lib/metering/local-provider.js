// The local MeteringProvider (LM1, docs/superpowers/specs/2026-11-11-local-
// mode-design.md sections 1 and 4; plan 2026-11-11-lm1-store-and-
// identity.md, Task 4): the same three methods as RedisMeteringProvider,
// for --store local.
//
// Without --meter (the client-machine default): one user has no balance to
// run out of and no neighbour to be limited for. recordCall records every
// call (in memory, per key and tool: the usage records and the receipt are
// the counters', lib/usage) and charges nothing; checkBalance answers no
// balance; rateLimit never limits. Nothing keyed by an API key is written:
// in the single-identity profile the key exists only in memory.
//
// With --meter (an operator testing a hosted configuration locally, with
// an auth file): today's semantics. A key's record is {balance,
// toolPriceRecord: {<tool>: {count}}}, as the Redis hash holds it: a free
// call is spent first, then the balance drops by the cost (below zero
// too: there is no balance gate, as on Redis). Records persist in
// <storePath>/metering.json keyed by the API key, as Redis keys its
// hashes; the auth file next to them already holds the keys. An operator
// seeds a balance there as with `redis-cli hset`. --apiKeyRateLimit is a
// sliding window per key, in memory.
const util = require('util');
const path = require('path');
const MeteringProvider = require('./provider');

// A sliding-window limiter with rolling-rate-limiter's answer: null time
// left while under the limit, else the ms until the oldest call leaves the
// window. A refused call is not counted.
function slidingWindow(maxInInterval, intervalMs) {
  const seen = new Map();   // key -> timestamps within the window
  return function(key, callback) {
    const now = Date.now();
    const times = (seen.get(key) || []).filter((t) => now - t < intervalMs);
    if (times.length >= maxInInterval) {
      seen.set(key, times);
      return callback(null, times[0] + intervalMs - now, 0);
    }
    times.push(now);
    seen.set(key, times);
    return callback(null, null, maxInInterval - times.length);
  };
}

function LocalMeteringProvider(opts) {
  MeteringProvider.call(this);
  const o = opts || {};
  this.meter = (o.meter === true);
  this.calls = new Map();   // key -> Map(tool -> count), without --meter
  this.file = null;
  if (this.meter) {
    this.file = require('../store/json-file').openJsonFile(path.join(o.storePath, 'metering.json'));
  }
  this._rateLimiter = (this.meter && o.rateLimitMaxPerInterval != null)
    ? slidingWindow(o.rateLimitMaxPerInterval, o.rateLimitIntervalMs || 1000) : null;
}

util.inherits(LocalMeteringProvider, MeteringProvider);

LocalMeteringProvider.prototype.record = function(apiKey) {
  const r = this.file.data[apiKey];
  return {
    balance: (r != null && r.balance != null && Number.isFinite(+r.balance)) ? +r.balance : 0,
    toolPriceRecord: (r != null && r.toolPriceRecord != null && typeof(r.toolPriceRecord) === 'object') ? r.toolPriceRecord : {}
  };
};

LocalMeteringProvider.prototype.recordCall = function(apiKey, tool, cost, callback) {
  if (apiKey == null) return callback(new Error('apiKey is required'));
  if (!this.meter) {
    const byTool = this.calls.get(apiKey) || new Map();
    byTool.set(tool, (byTool.get(tool) || 0) + 1);
    this.calls.set(apiKey, byTool);
    return callback(null, {apiKey: apiKey, tool: tool, charged: 0, balance: null});
  }
  const r = this.record(apiKey);
  const entry = r.toolPriceRecord[tool];
  if (entry != null && typeof(entry.count) === 'number' && entry.count > 0) {
    entry.count -= 1;
    this.file.set(apiKey, r);
    return callback(null, {apiKey: apiKey, tool: tool, charged: 0, balance: r.balance, remainingFreeCalls: entry.count});
  }
  r.balance -= +cost;
  this.file.set(apiKey, r);
  return callback(null, {apiKey: apiKey, tool: tool, charged: cost, balance: r.balance});
};

LocalMeteringProvider.prototype.checkBalance = function(apiKey, callback) {
  if (apiKey == null) return callback(new Error('apiKey is required'));
  if (!this.meter) return callback(null, {apiKey: apiKey, balance: null});
  return callback(null, {apiKey: apiKey, balance: this.record(apiKey).balance});
};

LocalMeteringProvider.prototype.rateLimit = function(apiKey, callback) {
  if (this._rateLimiter == null) return callback(null, {limited: false});
  this._rateLimiter(apiKey, (err, timeLeft, actionsLeft) => {
    if (err) return callback(err);
    return callback(null, {limited: (timeLeft != null && timeLeft > 0), timeLeft: timeLeft, actionsLeft: actionsLeft});
  });
};

// The calls recorded for a key and tool without --meter (tests, the usage
// report's in-memory source).
LocalMeteringProvider.prototype.callCount = function(apiKey, tool) {
  const byTool = this.calls.get(apiKey);
  return (byTool != null && byTool.get(tool) != null) ? byTool.get(tool) : 0;
};

LocalMeteringProvider.prototype.close = function() {
  if (this.file != null) this.file.close();
};

LocalMeteringProvider.slidingWindow = slidingWindow;

module.exports = LocalMeteringProvider;
