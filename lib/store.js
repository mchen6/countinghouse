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
//   apiLog         --apiMonitor's client
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
      const client = onError(require('./redis-resilient').createClient(opts.redisUrl, {db: 14}));
      return {
        use: (nonce, expiresAt) => new Promise((resolve, reject) => {
          const ms = nonceLifetime(nonce, expiresAt);
          if (ms == null) { resolve(false); return; }
          let done = false;
          const timer = setTimeout(() => {
            if (done) return;
            done = true;
            reject(Object.assign(new Error('the used-nonce store did not answer in time'), {code: 'USED_NONCE_TIMEOUT'}));
          }, NONCE_DEADLINE_MS);
          if (typeof(timer.unref) === 'function') timer.unref();
          client.set(`requeststate:nonce:${nonce}`, '1', 'NX', 'PX', ms, (e, reply) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (e != null) reject(e); else resolve(reply === 'OK');
          });
        })
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
    kv: () => {
      const client = require('redis').createClient(opts.redisUrl, {db: 5});
      client.on('error', () => {});
      return client;
    },
    jobs: () => require('./job-control'),
    deviceLog: () => {
      const client = onError(require('redis').createClient(opts.redisUrl, {db: 10}));
      return function(deviceID, data, timestamp, callback) {
        client.multi()
          .lpush(`devicelog:${deviceID}`, data)
          .lpush(`devicelogtimestamp:${deviceID}`, timestamp)
          .ltrim(`devicelog:${deviceID}`, 0, opts.deviceLogEntrySize)
          .ltrim(`devicelogtimestamp:${deviceID}`, 0, opts.deviceLogEntrySize)
          .exec((e) => callback(e));
      };
    },
    globalLimiter: () => {
      if (opts.globalRateLimit == null) return null;
      const redisResilient = require('./redis-resilient');
      const client = onError(redisResilient.createClient(opts.redisUrl, {db: 9}));
      return redisResilient.rateLimiter({
        redis: client,
        namespace: 'globalRateLimiter',
        interval: 1000,
        maxInInterval: opts.globalRateLimit
      });
    },
    apiLog: () => onError(require('redis').createClient(opts.redisUrl)),
    blobs: () => {
      const blobs = require('./store/blobs');
      const client = onError(require('redis').createClient(opts.redisUrl, {db: blobs.BLOBS_DB, detect_buffers: true}));
      return blobs.createBlobs({kind: 'redis', client, limits: blobs.limitsFromOptions(opts)});
    }
  };
}

const DEVICE_LOG_LOCAL = 1000;

// The local implementations (--store local, LM1): files under --storePath
// and memory, no Redis client. The parts later PRs bring refuse until then.
function localParts(opts) {
  const notYet = (part, pr) => () => { throw new Error(`the local store has no ${part} in this build (LM1 ${pr})`); };
  return {
    // The used nonces in local: memory only (the design, section 8), one
    // runtime, so a replay is refused while this process lives.
    usedNonces: () => {
      const used = new (require('./request-state').UsedNonces)();
      return {use: (nonce, expiresAt) => Promise.resolve(nonceLifetime(nonce, expiresAt) != null && used.use(nonce, expiresAt))};
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
      : require('./metering/local-provider').slidingWindow(opts.globalRateLimit, 1000)),
    // the API log is retired; in local it is absent (spec section 1)
    apiLog: () => null,
    blobs: () => {
      const blobs = require('./store/blobs');
      return blobs.createBlobs({kind: 'local', storePath: opts.storePath, moduleDataPath: opts.moduleDataPath, limits: blobs.limitsFromOptions(opts)});
    }
  };
}

// Each part made once, when first read. open() makes, at start, the parts
// whose files used to make their clients when they were loaded (the device
// log, the API log), so a bad --redisUrl still fails at start, not on a
// request (review of B1).
const AT_START = ['deviceLog', 'apiLog'];
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
  // the job runner's surface, for files that take it when they are loaded
  jobs: jobsFacade(() => getStore().jobs)
};
