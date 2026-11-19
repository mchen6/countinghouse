'use strict';
// The blobs part under --store redis (lib/store/blobs.js has the interface).
// Redis because an HTTP deployment can run more than one runtime against one
// Redis, and a read must work on whichever process receives it.
//
// db BLOBS_DB (13), its own. Keys, under `prefix` (blob: by default), carry
// the item id and the opaque owner id only:
//   d:<id>      the bytes              } both with the retention as their
//   m:<id>      the meta, JSON         } expiry (PX), set in the write
//   all         zset id -> expiresAt, every item
//   o:<owner>   zset id -> expiresAt, an owner's items
//   s           hash id -> "<bytes>|<owner>", what removing it un-charges
//   used        the bytes of every item
//   ou:<owner>  an owner's bytes
// One Lua script per put prunes up to PRUNE expired items (un-charging each),
// checks the owner's bytes, the owner's items and the store's bytes, and only
// then writes, indexes and charges: atomic across every runtime sharing the
// Redis, so two writers can never both fit where one does. get() checks
// expiresAt itself, so an item is never served past it, even before Redis
// drops its keys. (The script touches keys it builds from the prefix: a
// standalone Redis, as every other part of the store uses.)
const {readable, isId, prepare, full, SWEEP_MS, DEADLINE_MS, PER_MIB_MS} = require('./blobs');
const {CountinghouseError} = require('../countinghouse-error');
const {withDeadline} = require('../redis-resilient');

const PRUNE = 256;
// The deadlines (DEADLINE_MS, plus PER_MIB_MS per MiB for a put) are
// lib/store/blobs.js's, where lib/store.js also reads them (sizing the
// client's per-command deadline) without loading this file.
const MIB = 1 << 20;
// at most this many removes wait for Redis to answer again
const PENDING_MAX = 10000;
// what node_redis and the socket say when Redis cannot be reached, or the
// connection broke with a command in flight
const CONNECTION_CODES = new Set(['NR_CLOSED', 'CONNECTION_BROKEN', 'UNCERTAIN_STATE', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTCONN']);
const isConnectionError = (e) => e != null && (CONNECTION_CODES.has(e.code) || e.name === 'AbortError');

const DROP = `
local function drop(p, id)
  local v = redis.call('HGET', p .. 's', id)
  if v then
    local sep = string.find(v, '|', 1, true)
    local b = tonumber(string.sub(v, 1, sep - 1))
    local o = string.sub(v, sep + 1)
    redis.call('DECRBY', p .. 'used', b)
    if redis.call('DECRBY', p .. 'ou:' .. o, b) <= 0 then redis.call('DEL', p .. 'ou:' .. o) end
    redis.call('ZREM', p .. 'o:' .. o, id)
    redis.call('HDEL', p .. 's', id)
  end
  redis.call('ZREM', p .. 'all', id)
  redis.call('DEL', p .. 'd:' .. id, p .. 'm:' .. id)
end
local function prune(p, now, limit)
  local ex = redis.call('ZRANGEBYSCORE', p .. 'all', '-inf', now, 'LIMIT', 0, limit)
  for _, id in ipairs(ex) do drop(p, id) end
  return #ex
end
`;

// ARGV: prefix, now, prune limit, id, bytes, expiresAt, ttlMs, storeBytes,
// quotaBytes, quotaItems, owner, data, meta
const PUT = `${DROP}
local p = ARGV[1]
local owner = ARGV[11]
-- the caller's own expired items first, so it is never refused on them
for _, id in ipairs(redis.call('ZRANGEBYSCORE', p .. 'o:' .. owner, '-inf', tonumber(ARGV[2]))) do drop(p, id) end
prune(p, tonumber(ARGV[2]), tonumber(ARGV[3]))
local id, n, exp, ttl = ARGV[4], tonumber(ARGV[5]), tonumber(ARGV[6]), ARGV[7]
if (tonumber(redis.call('GET', p .. 'ou:' .. owner)) or 0) + n > tonumber(ARGV[9]) then return 'resourceQuotaBytes' end
if redis.call('ZCARD', p .. 'o:' .. owner) + 1 > tonumber(ARGV[10]) then return 'resourceQuotaItems' end
if (tonumber(redis.call('GET', p .. 'used')) or 0) + n > tonumber(ARGV[8]) then return 'resourceStoreBytes' end
redis.call('SET', p .. 'd:' .. id, ARGV[12], 'PX', ttl)
redis.call('SET', p .. 'm:' .. id, ARGV[13], 'PX', ttl)
redis.call('ZADD', p .. 'all', exp, id)
redis.call('ZADD', p .. 'o:' .. owner, exp, id)
redis.call('HSET', p .. 's', id, n .. '|' .. owner)
redis.call('INCRBY', p .. 'used', n)
redis.call('INCRBY', p .. 'ou:' .. owner, n)
return 'ok'
`;

const REMOVE = `${DROP}
drop(ARGV[1], ARGV[2])
return 1
`;

const SWEEP = `${DROP}
return prune(ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]))
`;

// client: a node_redis client on db BLOBS_DB with detect_buffers, made by
// lib/store.js (the one place a Redis client is made); this part quits it on
// close. prune: how many other expired items a put prunes (tests).
// deadlineMs: tests only.
function create({client, prefix = 'blob:', limits, now = Date.now, prune = PRUNE, deadlineMs = DEADLINE_MS}) {
  if (client == null) throw new Error('blobs: --store redis needs its client');
  const call = (name, ...args) => new Promise((resolve, reject) => client[name](...args, (e, r) => (e != null ? reject(e) : resolve(r))));
  // A call a tools/call or resources/read waits on, bounded by `until` (one
  // deadline across every call of one operation: a get's two reads share
  // it). A connection error or the deadline is RESULT_STORE_UNAVAILABLE,
  // with the error under it as its cause; anything else Redis answers (a
  // script error, OOM) goes on as it is, never taken for a passing outage
  // (the medium on the blob-store PR, 4 and 7).
  // (cause and timedOut non-enumerable: never on a serialised form)
  const hidden = (e, name, value) => Object.defineProperty(e, name, {value, enumerable: false, writable: true, configurable: true});
  const unavailable = (cause, timedOut = false) => {
    const e = CountinghouseError.withFields('RESULT_STORE_UNAVAILABLE', {});
    if (cause != null) hidden(e, 'cause', cause);
    if (timedOut) hidden(e, 'timedOut', true);
    return e;
  };
  // (the client's own per-command deadline answers REDIS_COMMAND_TIMEOUT:
  // an outage too)
  const bounded = (until, name, ...args) => withDeadline(Math.max(0, until - Date.now()),
    (done) => call(name, ...args).then((r) => done(null, r), (e) => done(isConnectionError(e) || e.code === 'REDIS_COMMAND_TIMEOUT' ? unavailable(e) : e)),
    () => unavailable(null, true));
  // Items a failed put may have left, or a remove could not reach: removed
  // as soon as the client is ready again (a put's write may have landed
  // before its reply was lost; the client has no offline queue any more, so
  // a remove issued while Redis is down is otherwise dropped: the medium on
  // the blob-store PR, 2 and 3). Bounded; a remove is idempotent.
  // Each id is sent once when it is added and once per 'ready', never while
  // one is in flight, and never on a timer: a hung or refusing Redis gets
  // no more removes than 'ready's (the high review of #443, 2, and its
  // medium, 2 and 4). One that was in flight at a 'ready' (skipped then) and
  // failed after it is sent once more. Past PENDING_MAX one is dropped, and
  // that is logged.
  const pending = new Set();
  const inFlight = new Set();
  let readyEpoch = 0;
  const send = (id) => {
    if (inFlight.has(id)) return;
    inFlight.add(id);
    const sentAt = readyEpoch;
    call('eval', REMOVE, 0, prefix, id).then(() => { inFlight.delete(id); pending.delete(id); }, () => {
      inFlight.delete(id);
      if (readyEpoch !== sentAt && client.ready === true && pending.has(id)) send(id);
    });
  };
  let overflowSaid = false;
  const removeLater = (id) => {
    if (pending.has(id)) return;   // waiting for the next 'ready' already
    if (pending.size >= PENDING_MAX) {
      if (!overflowSaid) {
        overflowSaid = true;
        try { require('../logger').W(`the result store has ${PENDING_MAX} values waiting to be removed once Redis answers; more are left to expire with --resourceRetention`); } catch (e) { /* no logger */ }
      }
      return;
    }
    pending.add(id);
    send(id);
  };
  client.on('ready', () => { readyEpoch++; overflowSaid = false; for (const id of pending) send(id); });
  const scan = async (match) => {
    const out = [];
    let cursor = '0';
    do {
      const [next, keys] = await call('scan', cursor, 'MATCH', match, 'COUNT', 500);
      out.push(...keys);
      cursor = next;
    } while (cursor !== '0');
    return out;
  };

  let swept = Promise.resolve();
  const timer = setInterval(() => { swept = sweep().catch(() => 0); }, SWEEP_MS);
  if (typeof(timer.unref) === 'function') timer.unref();
  async function sweep() {
    let removed = 0;
    for (;;) {
      const n = Number(await call('eval', SWEEP, 0, prefix, String(now()), '1000'));
      removed += n;
      if (n < 1000) return removed;
    }
  }

  return {
    async put(item) {
      const meta = prepare(item, limits, now);
      // (the deadline grows with the value: a large one's transfer is part
      // of the write: the medium on the blob-store PR, 6)
      const until = Date.now() + deadlineMs + (meta.bytes / MIB) * PER_MIB_MS;
      let answer;
      try {
        answer = await bounded(until, 'eval', PUT, 0, prefix, String(now()), String(prune), meta.id, String(meta.bytes), String(meta.expiresAt),
          String(limits.retentionMs), String(limits.storeBytes), String(limits.quotaBytes), String(limits.quotaItems), meta.owner,
          item.bytes, JSON.stringify(meta));
      } catch (err) {
        // the write may have landed (its reply lost, or past the deadline):
        // removed once Redis answers, never left charged
        if (err.code === 'RESULT_STORE_UNAVAILABLE') removeLater(meta.id);
        throw err;
      }
      // a command given a Buffer answers with one (detect_buffers)
      const said = Buffer.isBuffer(answer) ? answer.toString('utf8') : String(answer);
      if (said !== 'ok') throw full(said);
      return {id: meta.id, expiresAt: meta.expiresAt};
    },
    async get(id, who = {}) {
      if (!isId(id)) return null;
      const until = Date.now() + deadlineMs;
      const text = await bounded(until, 'get', `${prefix}m:${id}`);
      if (text == null) return null;
      let meta;
      try { meta = JSON.parse(text); } catch (e) { return null; }
      if (!readable(meta, who, now)) return null;
      const bytes = await bounded(until, 'get', Buffer.from(`${prefix}d:${id}`));
      if (!Buffer.isBuffer(bytes) || bytes.length !== meta.bytes) return null;
      return {meta, bytes};
    },
    async remove(id) {
      if (!isId(id)) return;
      try {
        await bounded(Date.now() + deadlineMs, 'eval', REMOVE, 0, prefix, id);
      } catch (err) {
        if (err.code === 'RESULT_STORE_UNAVAILABLE') removeLater(id);
        throw err;
      }
    },
    sweep,
    async usage(owner = null) {
      if (owner != null) {
        return {bytes: Number(await call('get', `${prefix}ou:${owner}`)) || 0, items: Number(await call('zcard', `${prefix}o:${owner}`)) || 0};
      }
      return {bytes: Number(await call('get', `${prefix}used`)) || 0, items: Number(await call('zcard', `${prefix}all`)) || 0};
    },
    // tests: this prefix's keys, a key's PTTL, and removing every key under
    // the prefix (never anything else in the db)
    keys: () => scan(`${prefix}*`),
    pttl: (key) => call('pttl', key),
    async clear() {
      const keys = await scan(`${prefix}*`);
      for (let i = 0; i < keys.length; i += 500) await call('del', ...keys.slice(i, i + 500));
    },
    close: async () => { clearInterval(timer); await swept; await new Promise((resolve) => client.quit(() => resolve())); }
  };
}

module.exports = {create, DEADLINE_MS, PER_MIB_MS};
