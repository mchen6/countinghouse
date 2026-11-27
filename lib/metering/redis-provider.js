'use strict';
// Default MeteringProvider implementation, backed by Redis: one hash per
// key, named by the key's fingerprint (lib/key-fingerprint.js meterId),
// never the key -- a Redis dump, a KEYS listing or a replica must not hand
// out keys (CLAUDE.md; B-meter-keys) -- with a `balance` field. Seeded with
// bin/countinghouse-meter.js --store redis. AuthProvider's providers are
// deliberately independent of it -- see docs/design-decisions.md's
// AuthProvider section. No answer carries the key.

const util          = require('util');
// Fails a command at once while Redis is down and reconnects however long it
// was down; the limiter has a deadline (review M5).
const {createClient, rateLimiter} = require('../redis-resilient');
const {meterId} = require('../key-fingerprint');
const MeteringProvider = require('./provider');
const options        = require('../cli-options');
const {CountinghouseError, setRetryAfter} = require('../countinghouse-error');
const {chargeMark} = require('./charge-mark');

// Each metering command's deadline: a Redis that is connected but stalled
// fails a charge within it (and marks the provider), rather than holding it.
const METER_DEADLINE_MS = 3000;
// A billed call refused while the ledger can't be reached: retry in 5 s.
const RETRY_MS = 5000;
const unreachable = () => setRetryAfter(new CountinghouseError('LEDGER_UNREACHABLE'), RETRY_MS, RETRY_MS);

// The tool-name encoding is the provider interface's (lib/metering/
// provider.js), so code that needs only the name (the local store, LM1)
// loads no Redis client library.
const {encodeLegacyTool} = MeteringProvider;

// recordCall's whole decision runs inside this script because it has to be
// one step. It used to be an HMGET followed by an HMSET, and calls that
// overlapped -- a composite fanning hops out through Promise.all is enough --
// all read the same balance and all wrote the same result, so ten hops
// charged for two. The same race let one free-call quota be spent by every
// overlapping caller at once.
//
// KEYS[1] the key's record (meterId); ARGV[1] tool, ARGV[2] cost.
//
// Returns [free, balance, remainingFreeCalls]. balance travels as a string
// because a Lua number is truncated to an integer on its way out of Redis.
const RECORD_CALL_SCRIPT = `
local tool = ARGV[1]
local raw  = redis.call('HGET', KEYS[1], 'toolPriceRecord')
local record = {}
if raw then
  local ok, parsed = pcall(cjson.decode, raw)
  if not ok or type(parsed) ~= 'table' then
    return redis.error_reply('toolPriceRecord is not valid JSON')
  end
  record = parsed
end
local entry = record[tool]
if type(entry) == 'table' and type(entry.count) == 'number' and entry.count > 0 then
  entry.count = entry.count - 1
  redis.call('HSET', KEYS[1], 'toolPriceRecord', cjson.encode(record))
  return {1, redis.call('HGET', KEYS[1], 'balance') or '0', entry.count}
end
return {0, redis.call('HINCRBYFLOAT', KEYS[1], 'balance', -tonumber(ARGV[2])), 0}
`;

function RedisMeteringProvider(opts) {
  MeteringProvider.call(this);
  opts = opts || {};

  this.redisClient = opts.redisClient || createClient(
    opts.redisUrl || options.redisUrl,
    {db: opts.redisDb != null ? opts.redisDb : 12},
    undefined, {commandDeadlineMs: METER_DEADLINE_MS}
  );
  // Whether a charge can be recorded now: marked by a charge that fails, or
  // by a client that isn't connected; cleared by a PING that answers (at
  // most one a second). Its lines name the code only, never a URL or a
  // credential.
  const client = this.redisClient;
  this._chargeMark = chargeMark({
    now: opts.now,
    probe: (cb) => client.ping((err) => cb(err)),
    refusal: unreachable,
    marked: (code) => `the usage ledger (Redis) can't be reached (${code}); charged calls are refused until it answers`,
    cleared: () => 'the usage ledger (Redis) answers again; charged calls are served'
  });

  this._rateLimiter = null;
  // (the window, said with each refusal: a retry hint is clamped to it)
  this._rateWindowMs = opts.rateLimitIntervalMs || 1000;
  if (opts.rateLimitMaxPerInterval != null) {
    this._rateLimiter = rateLimiter({
      redis: this.redisClient,
      namespace: 'meteringRateLimiter',
      interval: this._rateWindowMs,
      maxInInterval: opts.rateLimitMaxPerInterval
    });
  }
}

util.inherits(RedisMeteringProvider, MeteringProvider);

RedisMeteringProvider.prototype.checkBalance = function(apiKey, callback) {
  // guard here (not just at each HTTP/MCP call site) so any caller gets a
  // clean error instead of node_redis's confusing "invalid argument type"
  // message when apiKey is null/undefined.
  if (apiKey == null) return callback(new Error('apiKey is required'));

  this.redisClient.hmget(meterId(apiKey), 'balance', (err, results) => {
    // (a store that can't answer: the catalogued, retryable refusal, never
    // node_redis's own code or message)
    if (err) {
      this._chargeMark.mark(err);
      return callback(unreachable());
    }
    const balance = (results[0] != null) ? +results[0] : 0;
    return callback(null, {balance: balance});
  });
};

// Free calls are counted per tool under the record's `toolPriceRecord`
// field, keyed by the caller-supplied `tool` identifier; a call with none
// left is charged to `balance`. (The old `devices` field and its seeding
// from a legacy price record are gone: nothing wrote it since the
// AuthProvider refactor, and under a record named by meterId nothing ever
// could -- B-meter-keys (1); no shims, CLAUDE.md.)
RedisMeteringProvider.prototype.recordCall = function(apiKey, tool, cost, callback) {
  if (apiKey == null) return callback(new Error('apiKey is required'));

  return this.redisClient.eval(RECORD_CALL_SCRIPT, 1, meterId(apiKey), tool, cost, (err, reply) => {
    // (a charge that fails marks the provider: the next billed call is
    // refused until a PING answers)
    if (err) {
      this._chargeMark.mark(err);
      return callback(err);
    }

    if (reply[0] === 1) {
      return callback(null, {
        tool: tool, charged: 0, balance: +reply[1],
        remainingFreeCalls: reply[2]
      });
    }
    return callback(null, {tool: tool, charged: cost, balance: +reply[1]});
  });
};

RedisMeteringProvider.prototype.chargeable = function(apiKey, callback) {
  // (a client that isn't connected fails every command at once: refused
  // before any is sent, and marked, so the PING says when it is back)
  if (this.redisClient.ready !== true) this._chargeMark.mark({code: 'NR_CLOSED'});
  return this._chargeMark.check(callback);
};

RedisMeteringProvider.prototype.rateLimit = function(apiKey, callback, opts) {
  // (a billed call asks first: refused there, it is not counted by the limiter)
  if (opts != null && opts.billed === true) {
    return this.chargeable(apiKey, (refusal) => (refusal != null ? callback(refusal) : this._limit(apiKey, callback)));
  }
  return this._limit(apiKey, callback);
};

RedisMeteringProvider.prototype._limit = function(apiKey, callback) {
  if (this._rateLimiter == null) return callback(null, {limited: false});

  // (the limiter's Redis key is its namespace and this id: the key's
  // fingerprint, never the key -- the limiter PR's medium, 5)
  this._rateLimiter(meterId(apiKey), (err, timeLeft, actionsLeft) => {
    if (err) return callback(err);
    return callback(null, {
      limited: (timeLeft != null && timeLeft > 0),
      timeLeft: timeLeft,
      actionsLeft: actionsLeft,
      windowMs: this._rateWindowMs
    });
  });
};

RedisMeteringProvider.encodeLegacyTool = encodeLegacyTool;

module.exports = RedisMeteringProvider;
