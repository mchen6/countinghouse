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
//
// createStore(options) -> {metering, kv, jobs} is the spec's interface; the
// other three are the runtime's own. C's counters use metering only
// through recordCall. In --store redis (the default and, until PR B5, the
// only store) every part is the Redis implementation it was before, on the
// same db with the same options: no behaviour changes.
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

// The Redis implementations, as they were made before the store existed.
function redisParts(opts) {
  return {
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
    apiLog: () => onError(require('redis').createClient(opts.redisUrl))
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
  if (which !== 'redis') throw new Error(`--store ${which} is not available in this build`);
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
