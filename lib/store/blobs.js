'use strict';
// The store's blobs part (MCP completeness M5, spec section 2): where M6
// keeps a result's binary values that are stored and linked rather than
// inlined. Two implementations, as every part of the store has:
//   --store redis  lib/store/blobs-redis.js: db BLOBS_DB, its own; one Lua
//                  script per put prunes expired items, checks every limit,
//                  charges and writes, the expiry set with the write;
//   --store local  lib/store/blobs-local.js: owner-only files under
//                  <storePath>/resources/, data before meta, the limits
//                  checked and charged under one mutex.
//
// The interface (all async):
//   put({owner, session, mimeType, bytes: Buffer, source: {module, tool, field}})
//     -> {id, expiresAt}; RESULT_STORE_FULL {limit} past a limit. Nothing is
//     evicted early: a link promises its retention.
//   get(id, {owner, session}) -> {meta, bytes} | null. The access check is
//     here and only here: null alike for an unknown, malformed, expired or
//     foreign id (another owner, or another session where the item has one).
//   remove(id), sweep() -> items removed, usage(owner?) -> {bytes, items},
//     close(); and clear() for tests. RESULT_STORE_FULL's limit is the option
//     that bounds it: maxOutputBytes (one value, three quarters of it),
//     resourceQuotaBytes, resourceQuotaItems or resourceStoreBytes.
// meta: {id, owner, session, mimeType, bytes, sha256, createdAt, expiresAt,
// source}. Names (Redis keys, file names) carry the id and the opaque owner
// id only, never a key or a user name: put refuses any owner that is not an
// opaque caller id.
const crypto = require('crypto');
const {CountinghouseError} = require('../countinghouse-error');

const BLOBS_DB = 13;
const MIB = 1024 * 1024;
const OWNER = /^u_[A-Za-z0-9_-]{22}$/;
const ID = /^[A-Za-z0-9_-]{43}$/;
const SWEEP_MS = 10 * 60 * 1000;

const isId = (id) => typeof(id) === 'string' && ID.test(id);
const newId = () => crypto.randomBytes(32).toString('base64url');

// The defaults follow the store (spec section 2): an operator's Redis is
// shared memory; local files are the user's own disk.
const DEFAULTS = {
  redis: {storeBytes: 512 * MIB, quotaBytes: 128 * MIB},
  local: {storeBytes: 4096 * MIB, quotaBytes: 256 * MIB}
};
const RETENTION = {defaultS: 24 * 3600, minS: 60, maxS: 7 * 24 * 3600};

// The effective limits from the resolved options: retentionMs, storeBytes,
// quotaBytes, quotaItems, and itemBytes (three quarters of the output cap:
// a stored value is decoded base64 of an output within that cap).
function limitsFromOptions(o) {
  const d = DEFAULTS[o.store === 'local' ? 'local' : 'redis'];
  return {
    retentionMs: (o.resourceRetention != null ? o.resourceRetention : RETENTION.defaultS) * 1000,
    storeBytes: o.resourceStoreBytes != null ? o.resourceStoreBytes : d.storeBytes,
    quotaBytes: o.resourceQuotaBytes != null ? o.resourceQuotaBytes : d.quotaBytes,
    quotaItems: o.resourceQuotaItems != null ? o.resourceQuotaItems : 1024,
    itemBytes: Math.floor((Number.isInteger(o.maxOutputBytes) ? o.maxOutputBytes : 16 * MIB) * 3 / 4)
  };
}

const full = (limit) => CountinghouseError.withFields('RESULT_STORE_FULL', {limit});

// A put's item, checked, and its meta: TypeError for what no caller of the
// runtime's should ever pass (the owner above all), RESULT_STORE_FULL for an
// item over its own cap.
function prepare(item, limits, now) {
  if (item == null || typeof(item) !== 'object') throw new TypeError('blobs.put: an item');
  if (typeof(item.owner) !== 'string' || !OWNER.test(item.owner)) throw new TypeError('blobs.put: the owner must be an opaque caller id (u_...)');
  if (item.session != null && (typeof(item.session) !== 'string' || item.session.length > 128 || /[^\x21-\x7e]/.test(item.session))) {
    throw new TypeError('blobs.put: a session id');
  }
  // type/subtype, as a declaration must be (a parameter is refused at load:
  // lib/binary-fields.js, M0)
  if (typeof(item.mimeType) !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(item.mimeType)) throw new TypeError('blobs.put: a media type');
  if (!Buffer.isBuffer(item.bytes)) throw new TypeError('blobs.put: the bytes as a Buffer');
  if (item.bytes.length > limits.itemBytes) throw full('maxOutputBytes');
  const source = item.source || {};
  const field = (v) => (typeof(v) === 'string' ? v : null);
  const createdAt = now();
  const meta = {id: newId(), owner: item.owner, session: item.session != null ? item.session : null, mimeType: item.mimeType,
    bytes: item.bytes.length, sha256: crypto.createHash('sha256').update(item.bytes).digest('hex'), createdAt,
    expiresAt: createdAt + limits.retentionMs,
    source: {module: field(source.module), tool: field(source.tool), field: field(source.field)}};
  return meta;
}

// The one access rule (spec section 2, "Access"): the caller's id is the
// owner, and where the item has a session the request's is that one; an
// admin key gets no wider access; past its expiresAt it is gone, whatever the
// backend still holds.
function readable(meta, {owner, session}, now) {
  if (meta == null || meta.owner !== owner) return false;
  if (meta.session != null && meta.session !== session) return false;
  return now() < meta.expiresAt;
}

function createBlobs({kind, storePath = null, moduleDataPath = null, client = null, prefix = 'blob:', limits, now = Date.now, prune} = {}) {
  if (kind === 'redis') return require('./blobs-redis').create({client, prefix, limits, now, prune});
  if (kind === 'local') return require('./blobs-local').create({storePath, moduleDataPath, limits, now});
  throw new Error(`blobs: --store must be redis or local (got ${kind})`);
}

// The start line (M6, spec section 2: "The start line logs the effective
// limits"): the inline budget, then where the rest is stored, for how long,
// and the limits.
const sizeOf = (n) => {
  for (const [unit, k] of [['GiB', 1024 * MIB], ['MiB', MIB], ['KiB', 1024]]) {
    if (n >= k) return `${Number.isInteger(n / k) ? n / k : (n / k).toFixed(1)} ${unit}`;
  }
  return `${n} bytes`;
};
const durationOf = (s) => {
  if (s === 86400) return '24 h';
  if (s % 86400 === 0) return `${s / 86400} days`;
  if (s % 3600 === 0) return `${s / 3600} h`;
  return `${Number.isInteger(s / 60) ? s / 60 : (s / 60).toFixed(1)} min`;
};
function describeLimits(o) {
  const l = limitsFromOptions(o);
  const inline = o.inlineContentBytes === 0 ? 'every binary value stored' : `inline up to ${sizeOf(o.inlineContentBytes)} per result, the rest stored`;
  return `result store: ${inline} (${o.store === 'local' ? 'local files' : 'redis'}) for ${durationOf(l.retentionMs / 1000)}: ` +
    `at most ${sizeOf(l.storeBytes)} in all, ${sizeOf(l.quotaBytes)} and ${l.quotaItems} items per caller, ${sizeOf(l.itemBytes)} each`;
}

// A stored result's write or read (--store redis) waits at most this long
// for Redis, and a put this much more per MiB of its value (the back-sweep,
// 11-18: tools/call shapes its result on it, so a hung or absent Redis held
// the call until Redis came back; #16's rule is that calls answer with
// Redis down). Past it, or on a connection error, the call fails
// RESULT_STORE_UNAVAILABLE (lib/store/blobs-redis.js).
const DEADLINE_MS = 3000;
const PER_MIB_MS = 1000;
// the redis client's per-command deadline: the largest value's own write's
const commandDeadlineFor = (limits) => DEADLINE_MS + Math.ceil(((limits && limits.itemBytes) || 0) / (1 << 20)) * PER_MIB_MS;

module.exports = {DEADLINE_MS, PER_MIB_MS, commandDeadlineFor, createBlobs, limitsFromOptions, describeLimits, prepare, readable, isId, full, BLOBS_DB, DEFAULTS, RETENTION, SWEEP_MS};
