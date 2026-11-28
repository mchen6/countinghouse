'use strict';
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
const {CountinghouseError, setRetryAfter} = require('../countinghouse-error');
const {chargeMark} = require('./charge-mark');
// A billed call refused while the ledger can't be written: retry in 5 s.
const RETRY_MS = 5000;
// The ledger as it can be used now, read again first -> null, or the refusal
// (R-store-aside-locked; the same from the per-key gate and from a balance
// asked for, and both gates pass it through as itself, lib/rate-limit-gate.js
// ledgerRefusal): LEDGER_UNREADABLE (retryable) when it can't be read now;
// LEDGER_CORRUPT (not retryable) when it is corrupt and this process never
// saw it whole. Corrupt, with a map that saw it whole: usable, from the map
// (its own next write replaces the file).
function unusable(file) {
  try { file.reload(); } catch (e) { return new CountinghouseError('LEDGER_UNREADABLE'); }
  if (file.isUnknownCorrupt()) return new CountinghouseError('LEDGER_CORRUPT');
  return null;
}

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
  // meterId(key) -> Map(tool -> count), without --meter: a raw key is never
  // a Map key (the limiter PR's medium, 5)
  this.calls = new Map();
  this.file = null;
  if (this.meter) {
    const ledger = path.join(o.storePath, 'metering.json');
    const file = require('../store/json-file').openJsonFile(ledger);
    this.file = file;
    // Whether a charge can be written now: marked by a charge whose write
    // failed, cleared by a write of the ledger that succeeds (at most one a
    // second, never waiting for the lock). (the owner's decision, 11-27)
    this._chargeMark = chargeMark({
      now: o.now,
      probe: (cb) => file.writeNow(cb),
      refusal: () => setRetryAfter(new CountinghouseError('LEDGER_UNWRITABLE'), RETRY_MS, RETRY_MS),
      marked: (code) => `the usage ledger at ${ledger} could not be written (${code}); charged calls are refused until a write succeeds: check the disk (space, permissions)`,
      cleared: () => `the usage ledger at ${ledger} can be written again; charged calls are served`
    });
  }
  // (the window, said with each refusal: a retry hint is clamped to it)
  this._rateWindowMs = o.rateLimitIntervalMs || 1000;
  this._rateLimiter = (this.meter && o.rateLimitMaxPerInterval != null)
    ? slidingWindow(o.rateLimitMaxPerInterval, this._rateWindowMs) : null;
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
    const id = meterId(apiKey);
    const byTool = this.calls.get(id) || new Map();
    byTool.set(tool, (byTool.get(tool) || 0) + 1);
    this.calls.set(id, byTool);
    return callback(null, {tool: tool, charged: 0, balance: null});
  }
  // A charge of 0 while the ledger can't be used (corrupt with no copy here,
  // or its last read failed): nothing to record, so the file is not touched
  // -- never written, nor even tried (the store never replaces a file whose
  // map it doesn't know). What is skipped: such a call's free-call count, as
  // nothing is charged.
  if (!(+cost > 0) && (this.file.isUnknownCorrupt() || this.file.isUnreadable())) {
    return callback(null, {tool: tool, charged: 0, balance: null});
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
      answer = {tool: tool, charged: 0, balance: r.balance, remainingFreeCalls: entry.count};
    } else {
      r.balance -= +cost;
      answer = {tool: tool, charged: cost, balance: r.balance};
    }
    return r;
  }, (err) => {
    // (a charge that failed to be written marks the ledger: the next billed
    // call is refused until a write succeeds -- a write's own failure, a
    // rename still refused at update()'s deadline, a lock held past it; a
    // read that failed and a corrupt file are the ledger's other states,
    // refused as they are)
    if (err != null && err.storeRead !== true && err.unknownCorrupt !== true) this._chargeMark.mark(err);
    return (err != null ? callback(err) : callback(null, answer));
  });
};

LocalMeteringProvider.prototype.chargeable = function(apiKey, callback) {
  // (without --meter nothing is recorded: every call can be)
  if (!this.meter) return callback(null);
  if (this.file.isUnknownCorrupt() || this.file.isUnreadable()) {
    const refusal = unusable(this.file);
    if (refusal != null) return callback(refusal);
  }
  return this._chargeMark.check(callback);
};

LocalMeteringProvider.prototype.checkBalance = function(apiKey, callback) {
  if (apiKey == null) return callback(new Error('apiKey is required'));
  if (!this.meter) return callback(null, {balance: null});
  // (a ledger that can't be used: its refusal, never a throw into the route,
  // never a balance from a map that never saw it whole; the store logs why,
  // once: R-store-aside-locked)
  const refusal = unusable(this.file);
  if (refusal != null) return callback(refusal);
  return callback(null, {balance: asRecord(this.file.data[meterId(apiKey)]).balance});
};

LocalMeteringProvider.prototype.rateLimit = function(apiKey, callback, opts) {
  // (a billed call asks first whether its charge can be written, in
  // chargeable()'s one order -- corrupt, unreadable, then the mark: refused
  // there, it is not counted by the limiter)
  if (this.meter && opts != null && opts.billed === true) {
    return this.chargeable(apiKey, (refusal) => (refusal != null ? callback(refusal) : this._limit(apiKey, callback)));
  }
  return this._limit(apiKey, callback);
};

LocalMeteringProvider.prototype._limit = function(apiKey, callback) {
  // (the key's budget alone: a ledger that can't be used refuses a charged
  // call at chargeable(), before it runs, never run with its charge lost; a
  // call nothing charges is not refused for it -- the billing rule, one
  // answer per cost on every path)
  if (this._rateLimiter == null) return callback(null, {limited: false});
  // (its window keyed by the key's fingerprint, never the key)
  this._rateLimiter(meterId(apiKey), (err, timeLeft, actionsLeft) => {
    if (err) return callback(err);
    return callback(null, {limited: (timeLeft != null && timeLeft > 0), timeLeft: timeLeft, actionsLeft: actionsLeft, windowMs: this._rateWindowMs});
  });
};

// The calls recorded for a key and tool without --meter (tests, the usage
// report's in-memory source).
LocalMeteringProvider.prototype.callCount = function(apiKey, tool) {
  const byTool = this.calls.get(meterId(apiKey));
  return (byTool != null && byTool.get(tool) != null) ? byTool.get(tool) : 0;
};

LocalMeteringProvider.prototype.close = function() {
  if (this.file != null) this.file.close();
};

LocalMeteringProvider.slidingWindow = slidingWindow;

module.exports = LocalMeteringProvider;
