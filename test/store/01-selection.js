'use strict';

// LM1 part B, PR B1 (docs/superpowers/specs/2026-11-11-local-mode-design.md
// section 1; plan 2026-11-11-lm1-store-and-identity.md, Task 1): one
// selection point. lib/store.js's getStore() hands every part of the
// runtime that used Redis its object; nothing creates a client when it is
// loaded, only when a part is first used. In --store redis (the default)
// every part is today's, with today's db.

const assert = require('assert');
const path = require('path');
const {spawnSync} = require('child_process');

const ROOT = path.resolve(__dirname, '../..');

// Runs `body` in a child process with redis.createClient counted (the db
// each call asks for); the child prints a JSON result and exits, which
// closes any connection it made.
function inChild(body) {
  const script = `
    const redis = require('redis');
    const EventEmitter = require('events');
    const created = [];
    // A stand-in client: every command, and every command on a multi(),
    // chains or calls back with nothing; no connection is made.
    const fake = () => {
      const chain = new Proxy({}, {get: (t, k) => (k === 'exec')
        ? (cb) => { if (typeof(cb) === 'function') setImmediate(cb, null, []); }
        : () => chain});
      const client = new EventEmitter();
      return new Proxy(client, {get: (t, k) => {
        if (k in t) return (typeof(t[k]) === 'function') ? t[k].bind(t) : t[k];
        if (k === 'multi' || k === 'batch') return () => chain;
        if (k === 'connected' || k === 'ready') return false;
        return (...args) => { const cb = args[args.length - 1]; if (typeof(cb) === 'function') setImmediate(cb, null, null); return true; };
      }});
    };
    redis.createClient = function(...a) {
      const opts = a.find((x) => x != null && typeof(x) === 'object') || {};
      created.push(opts.db != null ? opts.db : 0);
      return fake();
    };
    const lib = (f) => require(require('path').join(${JSON.stringify(ROOT)}, 'lib', f));
    (async () => {
      const out = await (async () => { ${body} })();
      process.stdout.write(JSON.stringify(out));
      process.exit(0);
    })().catch((e) => { process.stderr.write(String(e && e.stack)); process.exit(1); });
  `;
  const run = spawnSync(process.execPath, ['-e', script], {cwd: ROOT, encoding: 'utf8', timeout: 30000});
  assert.strictEqual(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

describe('store 01: one selection point (LM1 B1)', function() {
  this.timeout(60000);

  it('loading the files that used Redis creates no client', () => {
    const out = inChild(`
      for (const f of ['countinghouse-util', 'session', 'redis-api', 'countinghouse-interface', 'job-control', 'store']) lib(f);
      return {created: created};
    `);
    assert.deepStrictEqual(out.created, []);
  });

  it('getStore() is one object per process', () => {
    const out = inChild(`const s = lib('store'); return {same: s.getStore() === s.getStore()};`);
    assert.strictEqual(out.same, true);
  });

  it("in --store redis each part is today's, on today's db, created when first used", () => {
    const out = inChild(`
      const options = lib('cli-options');
      options.globalRateLimit = 5;
      options.apiMonitor = true;
      const store = lib('store').getStore();
      const seen = {};
      const before = created.length;
      const metering = store.metering;
      seen.metering = created.slice(before);
      seen.meteringClass = metering instanceof lib('metering/redis-provider');
      let at = created.length; void store.kv; seen.kv = created.slice(at);
      at = created.length; void store.globalLimiter; seen.globalLimiter = created.slice(at);
      at = created.length; void store.apiLog; seen.apiLog = created.slice(at);
      at = created.length;
      await new Promise((resolve) => store.deviceLog('store-01-device', 'entry', Date.now(), () => resolve()));
      seen.deviceLog = created.slice(at);
      seen.jobsInternal = store.jobs.INTERNAL === lib('job-control').INTERNAL;
      seen.jobsAddJob = typeof(store.jobs.addJob) === 'function';
      return seen;
    `);
    assert.deepStrictEqual(out, {metering: [0], meteringClass: true, kv: [5], globalLimiter: [9], apiLog: [0],
      deviceLog: [10], jobsInternal: true, jobsAddJob: true});
  });

  it("the job runner's consumers reach it through the store", () => {
    const fs = require('fs');
    for (const f of ['framework.js', 'lib/device-manager.js', 'lib/routes/add-job.js', 'lib/routes/remove-job.js',
      'lib/routes/get-job-history.js', 'lib/routes/get-job.js', 'lib/mcp/gateway.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.ok(!/require\(['"][^'"]*job-control['"]\)/.test(src), `${f} requires job-control directly`);
    }
  });

  it('the jobs facade reads and writes the runner itself, with the runner as `this`', () => {
    const out = inChild(`
      const jobs = lib('store').jobs;
      const impl = lib('job-control');
      const hook = () => {};
      jobs.setCompletionHook(hook);
      const viaMethod = impl.completionHook === hook;
      const other = () => {};
      jobs.completionHook = other;
      const viaSet = impl.completionHook === other;
      jobs.someMemberNotListed = 7;
      impl.anotherMember = 8;
      return {viaMethod, viaSet, newOnImpl: impl.someMemberNotListed === 7, readThrough: jobs.anotherMember === 8,
        internal: jobs.INTERNAL === impl.INTERNAL};
    `);
    assert.deepStrictEqual(out, {viaMethod: true, viaSet: true, newOnImpl: true, readThrough: true, internal: true});
  });

  it('open() makes the device log and API log clients at start, as loading those files used to', () => {
    const out = inChild(`
      const options = lib('cli-options');
      options.apiMonitor = false;
      lib('store').getStore().open();
      return {created: created.slice().sort(), apiLog: lib('store').getStore().apiLog != null};
    `);
    assert.deepStrictEqual(out, {created: [0, 10], apiLog: true});
  });
});

describe('store 01: --store local, so far (LM1 B2)', function() {
  this.timeout(60000);

  it('makes the local metering provider and an in-memory global limiter, with no Redis client', () => {
    const out = inChild(`
      const os = require('os');
      const fs = require('fs');
      const storePath = fs.mkdtempSync(require('path').join(os.tmpdir(), 'ch-store-01-'));
      const store = lib('store').createStore({store: 'local', storePath, meter: false, globalRateLimit: 1});
      const local = store.metering instanceof lib('metering/local-provider');
      const limits = [];
      for (let i = 0; i < 2; i++) limits.push(await new Promise((resolve) => store.globalLimiter('g', (err, timeLeft) => resolve(timeLeft != null && timeLeft > 0))));
      const jobsLocal = store.jobs === lib('job-control-local') && typeof(store.jobs.addJob) === 'function';
      return {local, limits, apiLog: store.apiLog, jobsLocal, created};
    `);
    assert.deepStrictEqual(out, {local: true, limits: [false, true], apiLog: null, jobsLocal: true, created: []});
  });
});

describe('store 01: --store local kv and device log (LM1 B3)', function() {
  this.timeout(60000);

  it('the local kv is LocalKv behind ctx.redis, and the device log keeps the last 1000 entries per device in memory', () => {
    const out = inChild(`
      const os = require('os');
      const fs = require('fs');
      const storePath = fs.mkdtempSync(require('path').join(os.tmpdir(), 'ch-store-01-'));
      const store = lib('store').createStore({store: 'local', storePath, meter: false});
      const isLocal = store.kv instanceof lib('local-kv');
      for (let i = 0; i < 1005; i++) await new Promise((resolve) => store.deviceLog('dev', 'e' + i, i, resolve));
      const log = store.deviceLog.entries('dev');
      store.kv.close();
      return {isLocal, n: log.length, first: log[0].data, last: log[log.length - 1].data,
        files: fs.readdirSync(storePath).filter((f) => f.startsWith('devicelog')), created};
    `);
    assert.deepStrictEqual(out, {isLocal: true, n: 1000, first: 'e1004', last: 'e5', files: [], created: []});
  });
});
