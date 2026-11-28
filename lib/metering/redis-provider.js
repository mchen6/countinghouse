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
const {meterId, keyFingerprint} = require('../key-fingerprint');
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
// The probe that clears the mark: a write, so a Redis that answers reads but
// refuses writes (OOM, READONLY, MISCONF) keeps it; a key of its own, in the
// ledger's db, gone in a minute (never a meterId's: those begin "sha256:").
const PROBE_KEY = 'countinghouse:metering-probe';
// How long a client never yet connected is refused without an outage said:
// a start's own connect, not a Redis down. Past it, marked and said once.
const FIRST_CONNECT_MS = 10000;
// An error about one key's own record (a hash of the wrong type, a free-call
// record that isn't JSON) is that key's, never the store's: it does not mark
// the provider, or one tenant's bad record would refuse every tenant. Any
// other error -- the connection, a deadline, a refused write, one not known
// -- marks it (fail closed).
const RECORD_ERRORS = new Set(['WRONGTYPE', 'BADRECORD']);
// A Redis error's code word: node_redis's, or the one inside an error
// raised in a script, as Redis 6.2 and older wrap it ("ERR Error running
// script (call to f_...): @user_script:3: WRONGTYPE ..."), which node_redis
// reads as ERR. It is the code classified, and the one a mark's line says.
function redisCode(err) {
  if (err == null) return null;
  // (a shared error, READONLY or OOM, placed twice and dashed: "...:
  // @user_script:1: @user_script: 1: -READONLY ...")
  const inner = (err.code === 'ERR' && typeof(err.message) === 'string') ? /@user_script: ?\d+: (?:@user_script: ?\d+: )?-?([A-Z][A-Z0-9_]*)\b/.exec(err.message) : null;
  return inner != null ? inner[1] : err.code;
}
const coded = (err) => ({code: redisCode(err)});
const recordError = (err) => err != null && RECORD_ERRORS.has(redisCode(err));
// (a balance as the scripts refuse it: not a finite number, or padded)
// (and one that underflows -- "1e-5000" -- which Redis refuses and Number reads as 0)
const badBalance = (s) => s != null && (s === '' || /^\s|\s$/.test(s) || !Number.isFinite(Number(s))
  || (Number(s) === 0 && /[1-9]/.test(s.split(/[eE]/)[0])));
// A key's record checked inside each script, so every fault of the record
// itself answers as such on any Redis (6.2 and older wrap an error raised in
// a script as "ERR Error running script ..."): a key that isn't a hash
// (WRONGTYPE), a free-call record that isn't JSON or a balance that isn't a
// number (BADRECORD). Any other error -- a refused write, memory -- passes as
// Redis says it. Leaves `record` (the free-call record) and balanceBy(n).
// (Redis 6 and older place and dash a shared error -- READONLY, OOM --
// from redis.pcall, "@user_script: 1: -READONLY ...\r\n", as checked
// against 6.2.24: taken off, so its code word comes first again)
const UNPLACED = `
local function unplaced(e)
  e = string.gsub(e, '^[^%s]*: ?%d+: ', '')
  e = string.gsub(e, '^%-', '')
  return (string.gsub(e, '[\\r\\n]+$', ''))
end
`;
const RECORD_CHECKS = `${UNPLACED}
local t = redis.call('TYPE', KEYS[1])['ok']
if t ~= 'none' and t ~= 'hash' then
  return redis.error_reply('WRONGTYPE the usage record is not a hash')
end
local raw = redis.call('HGET', KEYS[1], 'toolPriceRecord')
local record = {}
if raw then
  local ok, parsed = pcall(cjson.decode, raw)
  -- (one Redis's cjson decodes but won't encode -- 1e999, NaN -- is no
  -- record a free call can be written back to)
  if not ok or type(parsed) ~= 'table' or not pcall(cjson.encode, parsed) then
    return redis.error_reply('BADRECORD toolPriceRecord is not valid JSON')
  end
  record = parsed
end
local balance = redis.call('HGET', KEYS[1], 'balance')
if balance then
  local n = tonumber(balance)
  if not n or n ~= n or n == math.huge or n == -math.huge
      or string.find(balance, '^%s') or string.find(balance, '%s$') then
    return redis.error_reply('BADRECORD the balance is not a number')
  end
end
local function balanceBy(n)
  local r = redis.pcall('HINCRBYFLOAT', KEYS[1], 'balance', n)
  if type(r) == 'table' and r.err then
    local e = unplaced(r.err)
    -- (a balance Redis's own parser refuses, however Lua's read it)
    if string.find(e, 'hash value is not a float', 1, true) or string.find(e, 'increment would produce', 1, true) then
      return nil, 'BADRECORD the balance is not a number'
    end
    return nil, e
  end
  return r
end
`;

// One key's record, probed: a hash (or none yet) whose free-call record is
// JSON, then a zero write to its balance -- it succeeds only where a charge
// would. Answers WRONGTYPE or BADRECORD as the record script does.
const RECORD_PROBE_SCRIPT = `${RECORD_CHECKS}
local after, failed = balanceBy(0)
if failed then return redis.error_reply(failed) end
return after
`;
// A key whose own record failed (of the wrong type, a free-call record that
// isn't JSON): refused before its billed calls run, LEDGER_RECORD_INVALID,
// not retryable -- a record stays so until someone repairs it, and a retry
// would only loop (business, 11-27). LEDGER_UNWRITABLE is for store-wide
// write failures that pass.
const recordRefusal = () => new CountinghouseError('LEDGER_RECORD_INVALID');

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
${RECORD_CHECKS}
local entry = record[tool]
if type(entry) == 'table' and type(entry.count) == 'number' and entry.count > 0 then
  entry.count = entry.count - 1
  -- (encodable: RECORD_CHECKS refused one that isn't, and a finite count less one stays so)
  redis.call('HSET', KEYS[1], 'toolPriceRecord', cjson.encode(record))
  return {1, redis.call('HGET', KEYS[1], 'balance') or '0', entry.count}
end
local after, failed = balanceBy(-tonumber(ARGV[2]))
if failed then return redis.error_reply(failed) end
return {0, after, 0}
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
  // by a client that isn't connected; cleared by a probe write that
  // succeeds (the probe key set, at most one a second: under Redis ACLs the
  // runtime's user needs write access to that key, PROBE_KEY, or the mark
  // never clears). Its lines name the code only, never a URL or a
  // credential.
  const client = this.redisClient;
  this._chargeMark = chargeMark({
    now: opts.now,
    probe: (cb) => client.set(PROBE_KEY, '1', 'PX', 60000, (err) => cb(err)),
    refusal: unreachable,
    marked: (code) => `the usage ledger (Redis) can't be reached (${code}); charged calls are refused until it answers`,
    cleared: () => 'the usage ledger (Redis) answers again; charged calls are served'
  });
  // One key's own record that failed a charge: a mark of its own, by its
  // meterId (never the key), so only that key is refused; probed at most
  // once a second with RECORD_PROBE_SCRIPT, and forgotten once clear.
  this._recordMarks = new Map();
  this._now = opts.now;
  this._everReady = client.ready === true;
  // (monotonic unless a test gives one: as the marks')
  this._clock = typeof(opts.now) === 'function' ? opts.now : () => performance.now();
  this._startedAt = this._clock();
  if (typeof(client.on) === 'function') client.on('ready', () => { this._everReady = true; });

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
      if (recordError(err)) {
        this._markRecord(apiKey, coded(err));
        return callback(recordRefusal());
      }
      this._chargeMark.mark(coded(err));
      return callback(unreachable());
    }
    if (badBalance(results[0])) {
      this._markRecord(apiKey, {code: 'BADRECORD'});
      return callback(recordRefusal());
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
    // refused until a probe write succeeds)
    if (err) {
      if (recordError(err)) this._markRecord(apiKey, coded(err));
      else this._chargeMark.mark(coded(err));
      return callback(err);
    }
    if (reply[0] !== 1) {
      // (a paid charge recorded: that key's balance can be charged, whatever
      // its mark said -- a free call writes no balance, so shows nothing)
      const own = this._recordMarks.get(meterId(apiKey));
      if (own != null) own.mark.clear();
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
  // before any is sent, and marked, so the probe says when it is back)
  if (this.redisClient.ready !== true) {
    // (not yet connected the first time: refused, retryably, but no outage
    // to mark or say -- until FIRST_CONNECT_MS has passed, a wrong
    // --redisUrl's, say, then marked and said as any)
    if (!this._everReady && this._clock() - this._startedAt < FIRST_CONNECT_MS) return callback(unreachable());
    this._chargeMark.mark({code: 'NR_CLOSED'});
  }
  return this._chargeMark.check((refusal) => {
    if (refusal != null) return callback(refusal);
    const own = (apiKey != null) ? this._recordMarks.get(meterId(apiKey)) : null;
    return own != null ? own.mark.check(callback) : callback(null);
  });
};

// A charge or a balance that failed on the key's own record: that key marked.
RedisMeteringProvider.prototype._markRecord = function(apiKey, err) {
  const id = meterId(apiKey);
  let own = this._recordMarks.get(id);
  if (own == null) {
    const fp = keyFingerprint(apiKey);
    const client = this.redisClient;
    const marks = this._recordMarks;
    const store = this._chargeMark;
    // (forgotten once the mark has cleared, never before: a failure while
    // its probe was out keeps it, and says nothing twice)
    own = {mark: chargeMark({
      now: this._now,
      // (a probe that fails is a failure of its own: one that isn't the
      // record's is the store's too, marked there)
      probe: (cb) => client.eval(RECORD_PROBE_SCRIPT, 1, id, (e) => {
        if (e != null) {
          if (!recordError(e)) store.mark(coded(e));
          // (cleared and forgotten while out -- a paid charge landed -- its
          // failure is that key's mark again, never one no check finds)
          const now = marks.get(id);
          if (now == null) marks.set(id, own);
          (now != null ? now : own).mark.mark(coded(e));
        }
        cb(e);
      }),
      // (final only while the last failure was the record's own; while its
      // probe is out, or after one the store failed, refused retryably)
      // (an asker whose own probe failed is answered by that failure: the
      // mark's code may be a newer mark's by then)
      refusal: ({probing, err}) => {
        const code = (err != null) ? redisCode(err) : own.mark.code();
        return (probing || !RECORD_ERRORS.has(code)) ? unreachable() : recordRefusal();
      },
      marked: (code) => `the usage record of ${fp} can't be read (${code}); its charged calls are refused until it is repaired`,
      cleared: () => {
        marks.delete(id);
        return `the usage record of ${fp} can be read again; its charged calls are served`;
      }
    })};
    this._recordMarks.set(id, own);
  }
  own.mark.mark(err);
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
// (for the tests: the code read from an error, the scripts' place-stripping function)
module.exports.redisCode = redisCode;
module.exports.UNPLACED = UNPLACED;
module.exports.FIRST_CONNECT_MS = FIRST_CONNECT_MS;
