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
const {readable, isId, prepare, full, BLOBS_DB} = require('./blobs');

const PRUNE = 256;

const DROP = `
local function drop(p, id)
  local v = redis.call('HGET', p .. 's', id)
  if v then
    local sep = string.find(v, '|', 1, true)
    local b = tonumber(string.sub(v, 1, sep - 1))
    local o = string.sub(v, sep + 1)
    redis.call('DECRBY', p .. 'used', b)
    redis.call('DECRBY', p .. 'ou:' .. o, b)
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
prune(p, tonumber(ARGV[2]), tonumber(ARGV[3]))
local id, n, exp, ttl = ARGV[4], tonumber(ARGV[5]), tonumber(ARGV[6]), ARGV[7]
local owner = ARGV[11]
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

function create({redisUrl, prefix = 'blob:', limits, now = Date.now}) {
  const client = require('redis').createClient(redisUrl, {db: BLOBS_DB, detect_buffers: true});
  client.on('error', (err) => {
    const LOG = require('../logger');
    const {CountinghouseError} = require('../countinghouse-error');
    LOG.E(new CountinghouseError('REDIS_CLIENT_ERROR', err.message));
  });
  const call = (name, ...args) => new Promise((resolve, reject) => client[name](...args, (e, r) => (e != null ? reject(e) : resolve(r))));
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

  return {
    async put(item) {
      const meta = prepare(item, limits, now);
      const answer = await call('eval', PUT, 0, prefix, String(now()), String(PRUNE), meta.id, String(meta.bytes), String(meta.expiresAt),
        String(limits.retentionMs), String(limits.storeBytes), String(limits.quotaBytes), String(limits.quotaItems), meta.owner,
        item.bytes, JSON.stringify(meta));
      // a command given a Buffer answers with one (detect_buffers)
      const said = Buffer.isBuffer(answer) ? answer.toString('utf8') : String(answer);
      if (said !== 'ok') throw full(said);
      return {id: meta.id, expiresAt: meta.expiresAt};
    },
    async get(id, who = {}) {
      if (!isId(id)) return null;
      const text = await call('get', `${prefix}m:${id}`);
      if (text == null) return null;
      let meta;
      try { meta = JSON.parse(text); } catch (e) { return null; }
      if (!readable(meta, who, now)) return null;
      const bytes = await call('get', Buffer.from(`${prefix}d:${id}`));
      if (!Buffer.isBuffer(bytes) || bytes.length !== meta.bytes) return null;
      return {meta, bytes};
    },
    async remove(id) {
      if (!isId(id)) return;
      await call('eval', REMOVE, 0, prefix, id);
    },
    async sweep() {
      let removed = 0;
      for (;;) {
        const n = Number(await call('eval', SWEEP, 0, prefix, String(now()), '1000'));
        removed += n;
        if (n < 1000) return removed;
      }
    },
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
    close: () => new Promise((resolve) => client.quit(() => resolve()))
  };
}

module.exports = {create};
