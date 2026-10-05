// Default MeteringProvider implementation, backed by Redis. Uses the same
// per-apiKey redis hash (hash key = apiKey, `balance` field) AuthProvider's
// FileAuthProvider/SqliteAuthProvider are deliberately independent of --
// see docs/design-decisions.md's AuthProvider section.
//
// The legacy-schema fallback in recordCall below (reading a `devices`
// field shaped like [{deviceID, priceRecord}], via
// encodeLegacyTool(deviceID, serviceID, actionName)) is intentionally left
// in place even though nothing writes that field anymore as of the
// AuthProvider refactor -- lib/user-auth.js's old CouchDB-cache-to-Redis
// path (Session.prototype.updateRedisUserRecord, since retired) was the
// only writer. Kept, not deleted, because the underlying concept --
// prepaid per-tool call quotas -- is a real MeteringProvider roadmap item,
// just not implemented via this exact mechanism going forward. Other
// callers (e.g. the MCP gateway) are free to pass any opaque `tool`
// string; the legacy-schema fallback only ever applied when one was built
// with encodeLegacyTool.
const util          = require('util');
const redis         = require('redis');
const RateLimiter    = require('rolling-rate-limiter');
const MeteringProvider = require('./provider');
const options        = require('../cli-options');

// deviceID/serviceID/actionName can't contain this exact sequence in
// practice (deviceIDs are UUIDs, serviceIDs are URNs using single/double
// colons, actionNames are plain identifiers), so it's a safe, reversible
// delimiter for encoding the legacy three-part lookup key into the single
// opaque `tool` string the MeteringProvider interface expects.
const LEGACY_TOOL_DELIMITER = ':::';

function encodeLegacyTool(deviceID, serviceID, actionName) {
  return deviceID + LEGACY_TOOL_DELIMITER + serviceID + LEGACY_TOOL_DELIMITER + actionName;
}

function decodeLegacyTool(tool) {
  const parts = String(tool).split(LEGACY_TOOL_DELIMITER);
  if (parts.length !== 3) return null;
  return {deviceID: parts[0], serviceID: parts[1], actionName: parts[2]};
}

// recordCall's whole decision runs inside this script because it has to be
// one step. It used to be an HMGET followed by an HMSET, and calls that
// overlapped -- a composite fanning hops out through Promise.all is enough --
// all read the same balance and all wrote the same result, so ten hops
// charged for two. The same race let one free-call quota be spent by every
// overlapping caller at once.
//
// KEYS[1] apiKey; ARGV[1] tool, ARGV[2] cost, ARGV[3] the free-call count to
// seed for `tool` from the legacy `devices` field ('' for none). The seed is
// worked out in JS, outside the script: `devices` has had no writer since
// the AuthProvider refactor, so reading it ahead of time cannot race.
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
if record[tool] == nil and ARGV[3] ~= '' then
  record[tool] = {count = tonumber(ARGV[3])}
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
  // guard here (not just at each HTTP/MCP call site) so any caller gets a
  // clean error instead of node_redis's confusing "invalid argument type"
  // message when apiKey is null/undefined.
  if (apiKey == null) return callback(new Error('apiKey is required'));

  this.redisClient.hmget(apiKey, 'balance', (err, results) => {
    if (err) return callback(err);
    const balance = (results[0] != null) ? +results[0] : 0;
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
  if (apiKey == null) return callback(new Error('apiKey is required'));

  const _this = this;

  this.redisClient.hmget(apiKey, 'devices', (err, results) => {
    if (err) return callback(err);

    let legacySeed = '';

    if (results[0] != null) {
      const legacy = decodeLegacyTool(tool);
      if (legacy != null) {
        try {
          const devices = JSON.parse(results[0]);
          for (let i = 0; i < devices.length; i++) {
            if (devices[i].deviceID !== legacy.deviceID) continue;
            const legacyPriceRecord = devices[i].priceRecord;
            if (legacyPriceRecord != null &&
                legacyPriceRecord[legacy.serviceID] != null &&
                legacyPriceRecord[legacy.serviceID][legacy.actionName] != null) {
              legacySeed = String(legacyPriceRecord[legacy.serviceID][legacy.actionName].count);
            }
            break;
          }
        } catch (e) {
          // malformed legacy `devices` blob -- ignore and fall through to balance deduction below
        }
      }
    }

    return _this.redisClient.eval(RECORD_CALL_SCRIPT, 1, apiKey, tool, cost, legacySeed, (err, reply) => {
      if (err) return callback(err);

      if (reply[0] === 1) {
        return callback(null, {
          apiKey: apiKey, tool: tool, charged: 0, balance: +reply[1],
          remainingFreeCalls: reply[2]
        });
      }
      return callback(null, {apiKey: apiKey, tool: tool, charged: cost, balance: +reply[1]});
    });
  });
};

RedisMeteringProvider.prototype.rateLimit = function(apiKey, callback) {
  if (this._rateLimiter == null) return callback(null, {limited: false});

  this._rateLimiter(apiKey, (err, timeLeft, actionsLeft) => {
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
