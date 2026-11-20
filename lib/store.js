'use strict';
// The store: the one place that decides where the runtime keeps what it
// used Redis for (docs/superpowers/specs/2026-11-11-local-mode-design.md
// section 1; plan 2026-11-11-lm1-store-and-identity.md, PR B1).
//
// getStore() is one object per process; each part is made when first used,
// never when a file is loaded, and on the main thread only (workers reach
// these through messages to the main thread, as before):
//
//   metering       a MeteringProvider (recordCall, checkBalance, rateLimit)
//   kv             the main-thread client behind a module's ctx.redis
//   jobs           the job runner's surface (lib/job-control.js)
//   deviceLog(deviceID, data, timestamp, callback)
//   globalLimiter  --globalRateLimit's limiter, or null
//   blobs          the result store (MCP completeness M5, lib/store/blobs.js)
//   usedNonces     use(nonce, expiresAt) -> Promise<boolean>: whether this is
//                  the nonce's first use, remembered until expiresAt (epoch
//                  ms). What makes a requestState single use
//                  (lib/request-state.js consume). It rejects when it cannot
//                  say, and the caller refuses: never "first use" by default
//
// Redis dbs in use, so the next part takes a free one: 0 sessions, user
// auth and metering records; 5 a module's ctx.redis (kv); 9 the global rate
// limiter; 10 the device log; 11 BullMQ (lib/job-control.js); 12 the metering
// provider's balances by default (lib/metering/redis-provider.js); 13 blobs;
// 14 the used-nonce store (M12).
//
// createStore(options) -> {metering, kv, jobs} is the spec's interface; the
// other three are the runtime's own. C's counters use metering only
// through recordCall. In --store redis (the default) every part is the
// Redis implementation it was before, on the same db with the same
// options. --store local (framework.js refuses it until PR B5) has the
// parts built so far.
const options = require('./cli-options');

// The job runner, forwarded on each use to the implementation the store
// selects, every read and write (a method, INTERNAL, completionHook, a
// member set later): so a file may take it when it is loaded (const
// JobControl = require('./store').jobs) and still reach the runner the
// store selects, with the runner as `this` (review of B1).
function jobsFacade(select) {
  return new Proxy({}, {
    get: (target, name) => {
      const impl = select();
      const value = impl[name];
      return (typeof(value) === 'function') ? value.bind(impl) : value;
    },
    set: (target, name, value) => { select()[name] = value; return true; },
    has: (target, name) => (name in select()),
    ownKeys: () => Reflect.ownKeys(select()),
    getOwnPropertyDescriptor: (target, name) => {
      const d = Object.getOwnPropertyDescriptor(select(), name);
      return (d != null) ? Object.assign({}, d, {configurable: true}) : undefined;
    }
  });
}

function onError(client) {
  client.on('error', (err) => {
    if (options.debug !== true) {
      const LOG = require('./logger');
      const {CountinghouseError} = require('./countinghouse-error');
      LOG.E(new CountinghouseError('REDIS_CLIENT_ERROR', err.message));
    }
  });
  return client;
}

// A used nonce: 1 to 64 characters of base64url's alphabet (it is part of a
// Redis key's name), remembered at most NONCE_MAX_LIFETIME_MS (a
// requestState lives 5 minutes; nothing asks for longer).
const NONCE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const NONCE_MAX_LIFETIME_MS = 15 * 60 * 1000;
const NONCE_DEADLINE_MS = 2000;
// a kv or device-log command's deadline (a Redis connected but not answering)
const KV_DEADLINE_MS = 3000;
// the kv's Redis db in --store redis (lib/job-control.js reads it too)
const KV_REDIS_DB = 5;
// --globalRateLimit's window: calls per this many ms, the whole runtime's
// (RUNTIME_BUSY's retry hint is clamped to it: lib/countinghouse-interface.js;
// declared before anything that builds a limiter: the medium on #482's
// round 3, 8)
const GLOBAL_LIMIT_WINDOW_MS = 1000;
// BullMQ's (lib/job-control.js), and the server id's claim beside its queue
// (lib/server-claim.js)
const JOB_QUEUE_REDIS_DB = 11;
// the most used nonces the local store's file holds at once
const NONCES_LOCAL_MAX = 65536;
// -> the time to remember it for, in ms, or null: not a nonce, or not a
// time ahead of now within the bound
function nonceLifetime(nonce, expiresAt) {
  if (typeof(nonce) !== 'string' || !NONCE_NAME.test(nonce) || !Number.isFinite(expiresAt)) return null;
  const ms = Math.ceil(expiresAt - Date.now());
  return (ms > 0 && ms <= NONCE_MAX_LIFETIME_MS) ? ms : null;
}

// The Redis implementations, as they were made before the store existed.
function redisParts(opts) {
  return {
    // SET NX with the nonce's own expiry, on a db of its own: every server
    // that shares the Redis refuses a replay. A Redis that is down fails
    // the command at once (redis-resilient); one that does not answer is
    // bounded by NONCE_DEADLINE_MS. Either way it rejects.
    usedNonces: () => {
      const redisResilient = require('./redis-resilient');
      // (bounded by withDeadline alone: one timer, one code, USED_NONCE_TIMEOUT)
      const client = onError(redisResilient.createClient(opts.redisUrl, {db: 14}));
      return {
        use: (nonce, expiresAt) => {
          const ms = nonceLifetime(nonce, expiresAt);
          if (ms == null) return Promise.resolve(false);
          return redisResilient.withDeadline(NONCE_DEADLINE_MS,
            (done) => client.set(`requeststate:nonce:${nonce}`, '1', 'NX', 'PX', ms, (e, reply) => done(e, reply === 'OK')),
            () => Object.assign(new Error('the used-nonce store did not answer in time'), {code: 'USED_NONCE_TIMEOUT'}));
        }
      };
    },
    metering: () => {
      const RedisMeteringProvider = require('./metering/redis-provider');
      return new RedisMeteringProvider({
        redisUrl: opts.redisUrl,
        redisDb: 0, // same db session.js/user-auth.js use for appKey-keyed records
        rateLimitMaxPerInterval: opts.apiKeyRateLimit,
        rateLimitIntervalMs: 1000
      });
    },
    // The kv, device-log and blob clients answer while Redis is down
    // (lib/redis-resilient.js: no offline queue after the first connect, and
    // reconnecting however long the outage), as metering's do: with node_redis'
    // defaults a command waited in memory for the outage, and after an hour
    // the client closed for good (the back-sweep, 11-18: #16's rule). And
    // each command has a deadline, for a Redis that is connected but does
    // not answer (the Reviewer's high review of #443, 1).
    kv: () => {
      const client = require('./redis-resilient').createClient(opts.redisUrl, {db: KV_REDIS_DB}, undefined, {commandDeadlineMs: KV_DEADLINE_MS});
      client.on('error', () => {});
      return client;
    },
    jobs: () => require('./job-control'),
    // The job runner's own clients beside BullMQ's (lib/job-control.js: the
    // old prefix's count; lib/server-claim.js: the server id's claim): (db,
    // deadlineMs) -> a lib/redis-resilient client on that db (one per db:
    // a SELECT has no deadline there), each command with that deadline, its
    // errors each command's answer; client.cmd(name, ...args) -> Promise
    jobClients: () => (db, deadlineMs) => {
      const client = require('./redis-resilient').createClient(opts.redisUrl, {db}, undefined, {commandDeadlineMs: deadlineMs});
      client.on('error', () => {});
      client.cmd = (name, ...args) => new Promise((resolve, reject) => client[name](...args, (e, r) => (e != null ? reject(e) : resolve(r))));
      return client;
    },
    // While Redis cannot be reached a write is dropped, said once per outage
    // with a count when it is back, never once per entry; and an error is
    // handed back as a plain one with its code only, since node_redis'
    // carries the command's arguments, the module's log data (the high
    // review of #443, 8).
    deviceLog: () => {
      const client = onError(require('./redis-resilient').createClient(opts.redisUrl, {db: 10}, undefined, {commandDeadlineMs: KV_DEADLINE_MS}));
      const LOG = () => require('./logger');
      // An outage is Redis unreachable after the client was ready once (the
      // first connect's writes wait in its offline queue: the medium on
      // #443's high round, 3), or a write that timed out on a Redis that is
      // connected but not answering (9). Either way said once, counted, and
      // over at the next 'ready' or the next write that lands.
      let outage = null;
      let everReady = false;
      const dropped = () => {
        if (outage == null) {
          outage = {dropped: 0};
          try { LOG().W('the device log cannot be written: Redis does not answer; entries are dropped until it does'); } catch (e) { /* no logger */ }
        }
        outage.dropped++;
      };
      const over = () => {
        if (outage == null) return;
        try { LOG().W(`the device log is written again: ${outage.dropped} entr${outage.dropped === 1 ? 'y was' : 'ies were'} dropped while Redis did not answer`); } catch (e) { /* no logger */ }
        outage = null;
      };
      client.on('ready', () => { everReady = true; over(); });
      const plain = (e) => Object.assign(new Error(`the device log could not be written (${(e != null && e.code) || 'error'})`), {code: (e != null && e.code) || 'DEVICE_LOG_FAILED'});
      const OUTAGE_CODES = new Set(['REDIS_COMMAND_TIMEOUT', 'NR_CLOSED', 'CONNECTION_BROKEN', 'UNCERTAIN_STATE', 'ECONNREFUSED', 'ECONNRESET']);
      return function(deviceID, data, timestamp, callback) {
        if (everReady && client.ready !== true) { dropped(); return callback(null); }
        client.multi()
          .lpush(`devicelog:${deviceID}`, data)
          .lpush(`devicelogtimestamp:${deviceID}`, timestamp)
          .ltrim(`devicelog:${deviceID}`, 0, opts.deviceLogEntrySize)
          .ltrim(`devicelogtimestamp:${deviceID}`, 0, opts.deviceLogEntrySize)
          .exec((e) => {
            if (e == null) { over(); return callback(null); }
            if (OUTAGE_CODES.has(e.code)) { dropped(); return callback(null); }
            return callback(plain(e));
          });
      };
    },
    globalLimiter: () => {
      if (opts.globalRateLimit == null) return null;
      const redisResilient = require('./redis-resilient');
      const client = onError(redisResilient.createClient(opts.redisUrl, {db: 9}));
      return redisResilient.rateLimiter({
        redis: client,
        namespace: 'globalRateLimiter',
        interval: GLOBAL_LIMIT_WINDOW_MS,
        maxInInterval: opts.globalRateLimit
      });
    },
    blobs: () => {
      const blobs = require('./store/blobs');
      const limits = blobs.limitsFromOptions(opts);
      // (each command bounded too: by the largest value's own write deadline)
      const commandDeadlineMs = blobs.commandDeadlineFor(limits);
      const client = onError(require('./redis-resilient').createClient(opts.redisUrl, {db: blobs.BLOBS_DB, detect_buffers: true}, undefined, {commandDeadlineMs}));
      return blobs.createBlobs({kind: 'redis', client, limits});
    }
  };
}

const DEVICE_LOG_LOCAL = 1000;

// The local implementations (--store local, LM1): files under --storePath
// and memory, no Redis client. The parts later PRs bring refuse until then.
function localParts(opts) {
  const notYet = (part, pr) => () => { throw new Error(`the local store has no ${part} in this build (LM1 ${pr})`); };
  return {
    // The used nonces in local: a file of the store (used-nonces.json),
    // not memory. A requestState's key is derived from the identity secret
    // on disk, so a state outlives a runtime restart; its used nonce must
    // too, or a client could replay a user's yes inside the state's five
    // minutes after one (the reviewer's condition on M12, before anything
    // mints a state). Each use is a read-modify-write under the store lock
    // (two runtimes on one store: exactly one first use), written and
    // synced before it answers. The expired are swept with it, and the file
    // is bounded: full, it refuses. A store that cannot be written rejects.
    usedNonces: () => {
      const jsonFile = require('./store/json-file');
      jsonFile.flushAllOnExit();
      const file = jsonFile.openJsonFile(require('path').join(opts.storePath, 'used-nonces.json'));
      const live = (e, now) => e != null && typeof(e) === 'object' && Number.isFinite(e.until) && e.until > now;
      return {
        use: (nonce, expiresAt) => new Promise((resolve, reject) => {
          if (nonceLifetime(nonce, expiresAt) == null) { resolve(false); return; }
          const now = Date.now();
          let kept = 0;
          for (const key of Object.keys(file.data)) {
            if (live(file.data[key], now)) kept += 1;
            else if (key !== nonce) file.delete(key);
          }
          if (kept >= NONCES_LOCAL_MAX && !live(file.data[nonce], now)) { resolve(false); return; }
          // this call's own mark: the entry is this one's only if it wrote it
          const mine = require('crypto').randomBytes(8).toString('hex');
          file.update(nonce, (held) => (live(held, Date.now()) ? held : {until: expiresAt, by: mine}), (err, value) => {
            if (err != null) reject(err);
            else resolve(value != null && value.by === mine);
          });
        })
      };
    },
    metering: () => {
      require('./store/json-file').flushAllOnExit();
      const LocalMeteringProvider = require('./metering/local-provider');
      return new LocalMeteringProvider({storePath: opts.storePath, meter: opts.meter === true,
        rateLimitMaxPerInterval: opts.apiKeyRateLimit, rateLimitIntervalMs: 1000});
    },
    kv: () => {
      require('./store/json-file').flushAllOnExit();
      const LocalKv = require('./local-kv');
      return new LocalKv({storePath: opts.storePath});
    },
    jobs: () => require('./job-control-local'),
    // The device log in local: memory only, the last DEVICE_LOG_LOCAL
    // entries per device, newest first, not persisted (the spec's table;
    // nothing in the runtime reads it back, operators read Redis's).
    deviceLog: () => {
      const logs = new Map();
      const deviceLog = function(deviceID, data, timestamp, callback) {
        const list = logs.get(deviceID) || [];
        list.unshift({data: data, timestamp: timestamp});
        if (list.length > DEVICE_LOG_LOCAL) list.length = DEVICE_LOG_LOCAL;
        logs.set(deviceID, list);
        process.nextTick(callback, null);
      };
      deviceLog.entries = (deviceID) => (logs.get(deviceID) || []).slice();
      return deviceLog;
    },
    globalLimiter: () => ((opts.globalRateLimit == null) ? null
      : require('./metering/local-provider').slidingWindow(opts.globalRateLimit, GLOBAL_LIMIT_WINDOW_MS)),
    blobs: () => {
      const blobs = require('./store/blobs');
      return blobs.createBlobs({kind: 'local', storePath: opts.storePath, moduleDataPath: opts.moduleDataPath, limits: blobs.limitsFromOptions(opts)});
    }
  };
}

// Each part made once, when first read. open() makes, at start, the parts
// whose files used to make their clients when they were loaded (the device
// log), so a bad --redisUrl still fails at start, not on a request (review
// of B1).
const AT_START = ['deviceLog'];
function lazily(parts) {
  const made = {};
  const store = {};
  Object.keys(parts).forEach((name) => {
    Object.defineProperty(store, name, {enumerable: true, get: () => {
      if (!Object.prototype.hasOwnProperty.call(made, name)) made[name] = parts[name]();
      return made[name];
    }});
  });
  Object.defineProperty(store, 'open', {value: () => { AT_START.forEach((name) => void store[name]); return store; }});
  return store;
}

function createStore(opts) {
  const o = opts || options;
  const which = (o.store != null) ? o.store : 'redis';
  if (which === 'local') return lazily(localParts(o));
  if (which !== 'redis') throw new Error(`--store must be redis or local (got ${which})`);
  return lazily(redisParts(o));
}

// One store per process, made from the options as they are at start: the
// metering provider the gateway's counters record into is the one every
// CdifInterface uses (before, each CdifInterface built its own provider
// against the same Redis db; review of B1).
let store = null;
function getStore() {
  if (store == null) store = createStore(options);
  return store;
}

module.exports = {
  createStore: createStore,
  getStore: getStore,
  KV_REDIS_DB,
  JOB_QUEUE_REDIS_DB,
  GLOBAL_LIMIT_WINDOW_MS,
  // the job runner's surface, for files that take it when they are loaded
  jobs: jobsFacade(() => getStore().jobs)
};
