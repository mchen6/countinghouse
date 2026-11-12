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
// <storePath>/metering.json under each key's meterId (lib/key-fingerprint
// .js), never the key: no file under --storePath holds a key (the
// reviewer's ruling, 2026-11-11). Each charge is a read-modify-write under
// the store lock, so processes sharing the store, or an operator seeding a
// balance with bin/countinghouse-meter.js meanwhile, lose nothing.
// --apiKeyRateLimit is rolling-rate-limiter's in-memory window per key.
const util = require('util');
const path = require('path');
const MeteringProvider = require('./provider');
const {meterId} = require('../key-fingerprint');

// --apiKeyRateLimit and --globalRateLimit in memory: rolling-rate-limiter
// itself, in its in-memory mode, so the answers are the Redis-backed
// limiter's to the call (a refused call is counted, timeLeft 0 when
// allowed; review of B2).
function slidingWindow(maxInInterval, intervalMs) {
  return require('rolling-rate-limiter')({interval: intervalMs, maxInInterval: maxInInterval});
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

// A record as Redis's hash holds it, every field kept; toolPriceRecord may
// be stored as a JSON string, as Redis stores it (review of B2).
function asRecord(stored) {
  const r = (stored != null && typeof(stored) === 'object') ? Object.assign({}, stored) : {};
  let tools = r.toolPriceRecord;
  if (typeof(tools) === 'string') {
    try { tools = JSON.parse(tools); } catch (e) { tools = {}; }
  }
  r.toolPriceRecord = (tools != null && typeof(tools) === 'object') ? tools : {};
  r.balance = (r.balance != null && Number.isFinite(+r.balance)) ? +r.balance : 0;
  return r;
}

LocalMeteringProvider.prototype.recordCall = function(apiKey, tool, cost, callback) {
  if (apiKey == null) return callback(new Error('apiKey is required'));
  if (!this.meter) {
    const byTool = this.calls.get(apiKey) || new Map();
    byTool.set(tool, (byTool.get(tool) || 0) + 1);
    this.calls.set(apiKey, byTool);
    return callback(null, {apiKey: apiKey, tool: tool, charged: 0, balance: null});
  }
  // The whole decision under the store lock, on the record as the file
  // holds it now: another process's charge, or a balance seeded meanwhile,
  // is never lost (review of B2), as HINCRBYFLOAT never loses one.
  let answer = null;
  this.file.update(meterId(apiKey), (stored) => {
    const r = asRecord(stored);
    const entry = r.toolPriceRecord[tool];
    if (entry != null && typeof(entry.count) === 'number' && entry.count > 0) {
      entry.count -= 1;
      answer = {apiKey: apiKey, tool: tool, charged: 0, balance: r.balance, remainingFreeCalls: entry.count};
    } else {
      r.balance -= +cost;
      answer = {apiKey: apiKey, tool: tool, charged: cost, balance: r.balance};
    }
    return r;
  }, (err) => (err != null ? callback(err) : callback(null, answer)));
};

LocalMeteringProvider.prototype.checkBalance = function(apiKey, callback) {
  if (apiKey == null) return callback(new Error('apiKey is required'));
  if (!this.meter) return callback(null, {apiKey: apiKey, balance: null});
  this.file.reload();
  return callback(null, {apiKey: apiKey, balance: asRecord(this.file.data[meterId(apiKey)]).balance});
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
