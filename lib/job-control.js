'use strict';
const url         = require('url');
const async       = require('async');
const Queue       = require('bullmq').Queue;
const Worker      = require('bullmq').Worker;
const QueueEvents = require('bullmq').QueueEvents;
const UnrecoverableError = require('bullmq').UnrecoverableError;

// The bounds, the ownership checks and the scheduler ids both job runners
// share (LM1 B5).
const {MAX_TIMER_MS, notRetried, failureText, jobOptsError, INTERNAL, schedulerId, ownsJob, denied,
  getJobHistory, saveJobInfo, jobRecord, publicRecord, authorizeOwner, addWhenOwned, ownerKeyAuthorized, withRunBookkeeping, runLimitMs, timeoutError, holdMsOf, passCall, chargeableRun} = require('./job-control-common');
// a job's session, kept in memory by the job's key, never in its data
const jobSessions = require('./job-sessions');
// a 2026-07-28 task's changes, for the listen hub (M16)
const taskEvents = require('./task-events');
const {sessionOfCtx, jobQueuePrefix, LEGACY_JOB_QUEUE_PREFIX} = require('./job-control-common');
// one-off jobs that have finished, newest kept: a session remembered once an
// add answers (--stdio with Redis) is skipped for a job already done, so its
// entry is never left behind (#251's re-check)
const finished = new Set();
const FINISHED_KEPT = 1000;
// A task waiting on its question (M22): its job has completed with no
// result, and its session's entry is kept for the run again, until that run
// starts (rerunTask) or the question's wait and as long again have passed
// (askHooks.holdMs), as the local runner holds its job.
const asking = new Map();   // job id -> the timer that forgets its session
function holdSession(id, ms) {
  const key = String(id);
  clearTimeout(asking.get(key));
  const t = setTimeout(() => { if (asking.get(key) === t) { asking.delete(key); markFinished(key); } }, ms);
  if (typeof(t.unref) === 'function') t.unref();
  asking.set(key, t);
}
function releaseHold(id) {
  const key = String(id);
  clearTimeout(asking.get(key));
  asking.delete(key);
}
function markFinished(id) {
  finished.add(String(id));
  if (finished.size > FINISHED_KEPT) finished.delete(finished.values().next().value);
  jobSessions.forget(String(id));
}
const crypto      = require('crypto');

const options     = require('./cli-options');
const LOG         = require('./logger');
const CountinghouseError = require('./countinghouse-error').CountinghouseError;

const encodeLegacyTool = require('./metering/provider').encodeLegacyTool;

// Jobs left under the prefix every runtime shared before B-j1 ('{cdifJob}')
// are not moved: which server owned one cannot be told, and a runtime of an
// older release may still be serving them. Nor is the job history kept
// before it under unscoped jobinfo:<name> keys read. Counted at each start
// with read-only commands (LLEN, ZCARD, SCAN: nothing consumed, moved or
// deleted, never through a Queue, which writes) on the store's job clients
// (lib/store.js jobClients: one per db, each command with a deadline, so a
// Redis that hangs holds nothing), closed after, and said in one line, so
// an operator can re-create what is wanted. The jobs and schedulers are a
// few cheap reads, made every start: an older runtime still on this Redis
// may queue more. The history's SCAN of the kv's db stops after
// SCAN_ROUNDS_MAX rounds ("at least N"), and once a SCAN finds none a flag
// in the kv (LEGACY_NONE_KEY, the one write) stops later starts from
// scanning again. A count that cannot be made is said, and made again by
// the next start (the high review of #463's round 2, 4 and 5, and the
// medium after it).
// (once per process: initJobProcess may run again in one, as tests do)
const LEGACY_LISTS = ['wait', 'paused', 'active'];
const LEGACY_SETS = ['delayed', 'prioritized', 'waiting-children'];
const SCAN_ROUNDS_MAX = 100;
const SCAN_COUNT = 1000;
const LEGACY_DEADLINE_MS = 3000;
const LEGACY_NONE_KEY = 'countinghouse:legacy-jobs-none';
let legacyLooked = false;
function legacyJobsSaid(clients) {
  if (legacyLooked) return undefined;
  legacyLooked = true;
  return countLegacy(clients).then((counted) => { if (!counted) legacyLooked = false; });
}
// clients: the store's jobClients (lib/store.js). -> Promise of true once
// counted (and said, when anything is left), false when the count could not
// be made (said so)
function countLegacy(clients) {
  const store = require('./store');
  let jobsDb;
  let kvDb;
  try {
    jobsDb = clients(store.JOB_QUEUE_REDIS_DB, LEGACY_DEADLINE_MS);
    kvDb = clients(store.KV_REDIS_DB, LEGACY_DEADLINE_MS);
  } catch (e) {
    LOG.E(e);
    if (jobsDb != null) jobsDb.end(true);
    return Promise.resolve(false);
  }
  const key = (part) => `${LEGACY_JOB_QUEUE_PREFIX}:job-queue:${part}`;
  // every job not finished: a running one too, left by a runtime that
  // stopped in it, which nothing now watches; and its schedulers
  const jobs = () => Promise.all([...LEGACY_LISTS.map((k) => jobsDb.cmd('llen', key(k))), ...LEGACY_SETS.map((k) => jobsDb.cmd('zcard', key(k)))])
    .then((ns) => ns.reduce((n, c) => n + (Number(c) || 0), 0));
  const schedulers = () => jobsDb.cmd('zcard', key('repeat')).then((n) => Number(n) || 0);
  // the history lists of before, unscoped: jobinfo:<name>, never
  // jobinfo:{chj-...}:<name>, in the kv's db; none once a SCAN found none
  const histories = () => kvDb.cmd('exists', LEGACY_NONE_KEY).then((none) => {
    if (Number(none) === 1) return {n: 0, more: false, known: true};
    let n = 0;
    const round = (cursor, rounds) => kvDb.cmd('scan', cursor, 'MATCH', 'jobinfo:*', 'COUNT', SCAN_COUNT).then(([next, keys]) => {
      n += keys.filter((k) => !String(k).startsWith('jobinfo:{chj-')).length;
      if (String(next) === '0') return {n, more: false, known: false};
      if (rounds + 1 >= SCAN_ROUNDS_MAX) return {n, more: true, known: false};
      return round(next, rounds + 1);
    });
    return round('0', 0);
  });
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return Promise.all([jobs(), schedulers(), histories()])
    .then(([j, s, h]) => {
      const flagged = (h.n === 0 && !h.more && !h.known) ? kvDb.cmd('set', LEGACY_NONE_KEY, new Date().toISOString()) : Promise.resolve();
      if (j > 0 || s > 0 || h.n > 0) {
        LOG.W(`job queue: ${plural(j, 'job', 'jobs')} and ${plural(s, 'scheduler', 'schedulers')} under the old shared prefix ` +
          `${LEGACY_JOB_QUEUE_PREFIX} were not moved to this server's queue, and ${h.more ? 'at least ' : ''}${plural(h.n, 'job history', 'job histories')} ` +
          'under the old jobinfo:<name> keys are not read; once no older runtime serves that prefix, re-create any job still wanted');
      }
      return flagged.then(() => true);
    })
    .then((done) => done, (e) => {
      LOG.W(`job queue: what is left under the old shared prefix ${LEGACY_JOB_QUEUE_PREFIX} and the old jobinfo:<name> keys could not be counted ` +
        `(${e.message}); none of it is moved or read, and the next start counts again`);
      return false;
    })
    .then((done) => { jobsDb.end(true); kvDb.end(true); return done; });
}

// How long a --stdio runtime's finished job is kept (seconds; BullMQ's
// removeOnComplete/removeOnFail age): tasks/result reads it while the
// session's client is alive, and a task whose question waits holds its
// completed job for the wait and an hour past it (lib/task-asks.js WAIT_MS
// + KEPT_PAST_WAIT_MS, two hours): three hours keeps that, and an hour more
// (the reviewer's ruling on #463, (c))
const STDIO_JOB_KEPT_S = 3 * 60 * 60;
// (checked at load: a later change to the question's timings can never
// leave a waiting task's job removed under it)
{
  const asks = require('./task-asks');
  if (!(STDIO_JOB_KEPT_S * 1000 > asks.WAIT_MS + asks.KEPT_PAST_WAIT_MS)) {
    throw new Error(`job-control: STDIO_JOB_KEPT_S (${STDIO_JOB_KEPT_S} s) must outlast a task question's hold, ` +
      `task-asks WAIT_MS + KEPT_PAST_WAIT_MS (${asks.WAIT_MS + asks.KEPT_PAST_WAIT_MS} ms)`);
  }
}

// The store's job clients on redisUrl (lib/store.js jobClients): this
// runner's Redis is --redisUrl's whatever the kv
const jobClientsOn = (redisUrl) => require('./store').createStore(Object.assign({}, options, {store: 'redis', redisUrl})).jobClients;

// Another live runtime holds this server id's claim (lib/server-claim.js):
// the start is refused (exit 2), as a start refuses a bad option.
const SHARED_ID_FIX = 'give each server its own --moduleDataPath (--storePath in the single-identity profile), or remove .server-id from a copied directory';
const holderText = (h) => (h == null ? 'another runtime' : `${String(h.host)} pid ${String(h.pid)} (since ${String(h.since)})`);
function refuseSharedId(holder) {
  let file = null;
  try { file = require('./server-id').fileFor(options); } catch (e) { file = null; }
  const message = `another server is using this data directory's server id${file != null ? ` (${file})` : ''}: ` +
    `${holderText(holder)} holds its claim on Redis; ${SHARED_ID_FIX}`;
  try { LOG.E(new Error(message)); } catch (e) { /* no logger */ }
  console.error(message);
  process.exit(2);
}

//NOTE: the methods in this object should be called in main thread only, do not call them in the context of workers


// listJobs: the states listed, in order; at most LIST_MAX of the caller's
// own a state, as master; read LIST_PAGE at a time, at most STATE_READ_MAX
// a state (A9; the medium on PR 2; #531's high, M2)
const LIST_STATES = ['waiting', 'active', 'delayed', 'completed', 'failed'];
const LIST_MAX = 50;
const LIST_PAGE = 50;
const STATE_READ_MAX = 200;

module.exports = {
  jobQueue: null,

  // (test/auth/56: the count of what the old shared prefix left, and how
  // long a --stdio runtime keeps a finished job)
  countLegacy: countLegacy,
  STDIO_JOB_KEPT_S: STDIO_JOB_KEPT_S,

  // Sentinel for platform-internal callers that legitimately bypass the
  // ownership check because they aren't acting on behalf of any tenant --
  // currently only DeviceManager's 'getjobinfo' handler, where a worker is
  // asking about the job it is itself executing.
  INTERNAL: INTERNAL,

  // Called with a job's main-side data when it completes successfully,
  // before the job is marked completed; whatever object it resolves to is
  // merged into the job's data. The MCP gateway registers one that stamps
  // the hash of the output schema the result was produced under, which
  // tasks/result compares against the one advertised when it is read.
  //
  // It is called as hook(jobData, results, run): `run.extra` is what the
  // start hook returned for this run, `run.jobId` the job's id (a task's
  // id: its tombstone tells a cancelled run). A run that fails (its error,
  // or its timeout) calls it as hook(jobData, null, {extra, error, jobId}), fire and
  // forget, and nothing it returns is merged: the usage counters write that
  // run's Out record with outcome error (local-mode spec §5, step 3b).
  completionHook: null,

  setCompletionHook: function(fn) {
    this.completionHook = fn;
  },

  // Called with a job's main-side data just before each run is sent to its
  // worker, in the process that runs it; whatever object it returns is
  // passed to the worker in the invoke args beside input and jobID (the
  // device manager keeps only the keys it knows: today `usageCall`, the id
  // the usage counters mint for the run). Its errors are logged and ignored.
  startHook: null,

  // a pass that ended with no answer to come: its usage call closed (F2-2)
  endHook: null,
  setEndHook: function(fn) {
    this.endHook = fn;
  },
  setStartHook: function(fn) {
    this.startHook = fn;
  },

  // Called as hook(jobData, {extra, jobId}) for a pass close() ends without
  // an answer, synchronously (B-shutdown-usage: its usage call is ended as a
  // cancelled one). The job itself is left to BullMQ: its lock (lockDuration,
  // 30 s) is not renewed once the process is gone, and a worker's stall
  // check (every 30 s) moves it back to wait, to run again as a pass of its
  // own (charged again on success). Stalled twice in its life, a job is
  // failed (maxStalledCount 1, kept: each stalled run is charged again).
  cancelHook: null,

  setCancelHook: function(fn) {
    this.cancelHook = fn;
  },

  // the runs in this process: {run, call, jobId}
  running: new Set(),

  // At shutdown (lib/exit-sequence.js): every pass running here ended (its
  // answer, if one comes, dropped) and told to the cancel hook; the worker
  // closed, without waiting for what it runs. Synchronous; once.
  close: function() {
    for (const live of Array.from(this.running)) {
      this.running.delete(live);
      if (live.run.settled) continue;
      live.run.settled = true;
      // (its pass's call, if open, ended as cancelled -- once: the close-once
      // helper's; between two passes none is open; #487 on #488)
      live.call.cancel(live.jobId);
    }
    // (asked to close, not waited for: from a synchronous 'exit' listener
    // nothing asynchronous completes, so the active job's lock simply runs
    // out, as described at cancelHook)
    const worker = this.worker;
    this.worker = null;
    if (worker != null) worker.close(true).catch(() => undefined);
  },

  // a 2026-07-28 task's question (M22, lib/task-asks.js, through the
  // gateway's jobHooks().ask): {before, asked, settled, holdMs}
  askHooks: null,

  setAskHooks: function(hooks) {
    this.askHooks = hooks;
  },

  // A task whose last pass asked, and whose question is answered: run again
  // under the same id (M22), by BullMQ's retry of a completed job: one
  // script, no gap, its attempts counted afresh (asks spend none). A job
  // that is gone (cancelled first: BullMQ refuses the retry) or not waiting
  // on a question runs nothing. -> Promise of whether it was started.
  rerunTask: function(id) {
    if (this.jobQueue == null) return Promise.resolve(false);
    return this.jobQueue.getJob(String(id)).then((job) => {
      if (job == null || job.data == null || job.data.asking == null) return false;
      return job.retry('completed', {resetAttemptsMade: true, resetAttemptsStarted: true}).then(() => {
        releaseHold(id);
        return true;
      });
    }).catch((e) => {
      try { LOG.I(`task ${String(id).slice(0, 34)}: not run again (${String(e && e.message).slice(0, 80)})`); } catch (_) { /* no logger */ }
      return false;
    });
  },

  // This server id's claim on Redis (lib/server-claim.js), made once: by the
  // start before it serves (framework.js waits for its decision, so a
  // refusal ends the start before anything is served), else by
  // initJobProcess. The worker runs once it is held, pauses while another
  // runtime holds it, and resumes when it is this one's again.
  claim: null,
  claimServerId: function() {
    const prefix = jobQueuePrefix();
    if (this.claim != null && this.claim.prefix === prefix) return this.claim;
    if (this.claim != null) this.claim.stop();
    // a --stdio runtime's queue is its process's own (job-control-common.js
    // jobQueuePrefix): nothing to claim, nobody to refuse
    if (options.stdio === true) {
      this.claim = {held: Promise.resolve(), decided: Promise.resolve(), prefix, stop: () => Promise.resolve()};
      return this.claim;
    }
    const _this = this;
    const made = require('./server-claim').claim(jobClientsOn(options.redisUrl), prefix, {
      onRefused: (holder) => refuseSharedId(holder),
      // another runtime took the claim while this one's lapsed (Redis out of
      // reach): this worker takes no job until it is this one's again
      onLost: (holder) => {
        LOG.E(new Error(`job queue: this server id's claim on Redis was taken by ${holderText(holder)} while Redis was out of reach: ` +
          `this runtime takes no job until it is free again; ${SHARED_ID_FIX}`));
        if (_this.worker != null) Promise.resolve().then(() => _this.worker.pause(true)).catch((e) => LOG.E(e));
      },
      onRegained: () => {
        LOG.I('job queue: this server id\'s claim on Redis is this runtime\'s again: it takes jobs');
        try { if (_this.worker != null) _this.worker.resume(); } catch (e) { LOG.E(e); }
      }
    });
    this.claim = Object.assign(made, {prefix});
    return this.claim;
  },

  initJobProcess: function(cdifInterface) {
    this.cdifInterface = cdifInterface;

    const redisUrl = options.redisUrl;
    let urlObj   = null;

    try {
      urlObj = url.parse(redisUrl);
    } catch(e) {
      return LOG.E(new Error(`redis URL parse fail, check redisUrl option: ${e.message}`));
    }

    let password = null;
    if (urlObj.auth != null) {
      password = urlObj.auth.split(':')[1];
    }

    const connection = {db: require('./store').JOB_QUEUE_REDIS_DB, port: urlObj.port, host: urlObj.hostname, password: password};

    // this server's own queue (lib/job-control-common.js jobQueuePrefix)
    const prefix = jobQueuePrefix();
    this.jobQueue = new Queue('job-queue', {prefix: prefix, connection: connection});

    if (this.jobQueue == null) return LOG.E(new Error('Invalid job queue'));

    this.queueEvents = new QueueEvents('job-queue', {prefix: prefix, connection: connection});
    legacyJobsSaid(jobClientsOn(redisUrl));

    this.installJobEventHandlers();

    const _this = this;

    this.worker = new Worker('job-queue', ((job) => {
      if (job == null) return Promise.reject(new Error('received null job in processor'));

      const jobData = job.data;
      const jobID   = job.id;

      if (jobData == null) return Promise.reject(new Error('job input data not available'));

      const deviceID   = jobData.deviceID;
      const serviceID  = jobData.serviceID;
      const actionName = jobData.actionName;
      const input      = jobData.input;
      // the job's session and values for this run (B1 Task 3), by its
      // scheduler for a repeating job's run, else by its own id
      // (read once its owner check has passed, below)
      const sessionKey = (job.repeatJobKey != null) ? String(job.repeatJobKey) : String(jobID);
      let runSession = {session: null, limits: null};
      // the owner's key as authorizeRun resolved it: it bills the run even
      // if the owner leaves the index meanwhile (B-meter-keys (2); #518's
      // high, L1)
      let runOwnerKey = null;
      // a one-off job's entry ends with its last run; a scheduler's, once
      // BullMQ has removed it (its repeat limit run out)
      // (a run's last attempt: one that succeeded, failed for good, or spent
      // its attempts -- a scheduler's run's too)
      const lastAttempt = (err) => err == null || err instanceof UnrecoverableError || (job.attemptsMade + 1) >= (Number.isInteger(job.opts.attempts) && job.opts.attempts > 0 ? job.opts.attempts : 1);
      const lastRun = (err) => job.repeatJobKey == null && lastAttempt(err);
      // (a run that failed on its last attempt is done with its question --
      // a scheduler's run's question as a one-off job's, each run its own;
      // #487's high, round 2)
      const settledRun = (err) => {
        if (err != null && lastAttempt(err)) settledAsk();
        if (lastRun(err)) return markFinished(sessionKey);
        if (job.repeatJobKey == null) return undefined;
        return _this.jobQueue.getJobScheduler(job.repeatJobKey)
          .then((scheduler) => { if (scheduler == null) jobSessions.forget(sessionKey); }, (e) => LOG.E(e));
      };

      // bullmq dropped bull's job-level `opts.timeout` (previously enforced internally
      // via p-timeout); job.opts.timeout is still stored on the job, so re-implement
      // the same "reject after N ms" behavior here to avoid silently losing it
      let timeoutHandle = null;
      // This run of the job. Once its timeout has failed it, bullmq owns the
      // job again (a retry may already be running), so an answer that still
      // arrives from the worker is dropped: not billed, not stamped, nothing
      // written over the retry's data. The worker cannot be told to stop.
      const run = {settled: false};
      // this pass's usage call (C's step 3b), closed once: common.passCall
      // (ruled M1 on #487) -- BullMQ runs the next pass within this run, so
      // the next pass's own call is opened on it
      const call = passCall(_this, jobData, () => runSession.session, (e) => LOG.E(e));
      // A failed run tells the completion hook, so its Out record is
      // written: on the pass's call if still open, else on one of its own --
      // never one with no call, never one closed twice (ruled M1)
      // this run, among those close() ends (once it starts its first pass;
      // its pass's call, if one is open, ended through call.cancel)
      let live = null;
      const failWith = (error) => {
        const extra = call.failure();
        const hook = _this.completionHook;
        if (typeof(hook) !== 'function') return;
        Promise.resolve().then(() => hook(jobData, null, {extra, error, jobId: String(jobID)})).catch((e) => LOG.E(e));
      };

      const hooks = _this.askHooks;
      const askable = hooks != null && jobData.era === 'modern';
      // (a before that fails -- a read of the record or the tombstone -- is
      // {error}: the run fails with a usage call of its own and runs nothing,
      // never as if nothing were known, a failure retried as its attempts
      // allow; #487's high, rounds 1 and 2)
      const askBefore = (rerun) => (askable ? Promise.resolve().then(() => hooks.before(jobData, String(jobID), {rerun})).catch((e) => {
        try { LOG.E(e); } catch (x) { /* no logger */ }
        return {error: (e instanceof Error) ? e : new Error(String(e))};
      }) : Promise.resolve(null));
      // a task that may have asked is done with its question once a run ends
      // without asking (M22): keyed on whether it may ask, not on its
      // asking mark, so a run that timed out (JOB_TIMEOUT) while its ask hook
      // was writing leaves no record and no slot behind (removing none is
      // harmless)
      const settledAsk = () => {
        if (askable && jobData.asks === true) Promise.resolve().then(() => hooks.settled(jobData, String(jobID))).catch((e) => LOG.E(e));
      };
      // (a refusal that is no Error is one with its text, as the local
      // runner's: on every pass)
      return _this.authorizeRun(job).catch((e) => Promise.reject((e instanceof Error) ? e : new Error(String(e)))).then((key) => {
        // (an owned job whose key didn't come back: refused for good, its
        // scheduler removed, as authorizeRun's own final refusal)
        try { runOwnerKey = ownerKeyAuthorized(jobData, key); } catch (e) { return _this.refusedForGood(job, e); }
        // (billed to its owner: refused while the charge can't be recorded,
        // retried as the refusal allows -- one that isn't retryable,
        // LEDGER_RECORD_INVALID, ends the run, as the local runner's)
        return chargeableRun(_this.cdifInterface, runOwnerKey)
          .catch((e) => { throw (e != null && e.retry === false) ? new UnrecoverableError(e.message) : e; })
          .then(() => askBefore(false));
      }).then((asks) => new Promise((resolve, reject) => {
        runSession = jobSessions.forRun(sessionKey);
        // started again with its question not answered (its record gone or
        // still waiting): nothing runs, and the job completes as it was
        // (one cancelled meanwhile -- its tombstone -- is no asked run)
        if (asks != null && asks.skip === true) {
          run.asked = asks.cancelled !== true;
          if (asks.cancelled === true) settledAsk();
          return resolve(null);
        }
        // A job's own timeout, else --jobTimeout -- applied here rather than
        // stamped on the job at addJob, so it also bounds jobs queued before
        // the flag existed and scheduler jobs made from templates stored
        // earlier. 0 means none.
        // Clamped to setTimeout's maximum (2^31-1 ms, about 24.8 days): past
        // it the timer fires at once, which would fail the job immediately.
        // a job's own timeout is validated where it comes in (jobOptsError); one
        // stored otherwise (an older record) counts as none
        const timeoutMs = runLimitMs(job.opts, options.jobTimeout);
        // (a pass of a run started again tells its worker the time left, as
        // the local runner does -- one run limit, F2-2's medium)
        const runStartedAt = Date.now();
        const leftMs = () => (timeoutMs != null ? Math.max(1, timeoutMs - (Date.now() - runStartedAt)) : timeoutMs);
        // (the run ends failed: settled, its timer cleared, the failure
        // recorded on a call (failWith), and BullMQ told -- one order on
        // every path; the rejection decides whether it is retried)
        const failRun = (error, rejection = error) => {
          run.settled = true;
          if (timeoutHandle != null) clearTimeout(timeoutHandle);
          // (BullMQ is told whatever the failure's record does)
          try { failWith(error); } catch (e) { try { LOG.E(e); } catch (x) { /* no logger */ } }
          reject(rejection);
        };
        if (timeoutMs != null) {
          timeoutHandle = setTimeout(() => {
            // (a run a stop has ended -- close() -- records nothing more)
            if (run.settled) return;
            const timedOut = timeoutError(timeoutMs);
            failRun(timedOut);
          }, timeoutMs);
        }

        // (a read that failed: retried as the job's attempts allow)
        if (asks != null && asks.error != null) return failRun(asks.error, new Error(String(asks.error.message)));
        live = {run, call, jobId: String(jobID)};
        _this.running.add(live);
        const pass = (askState) => _this.cdifInterface.invokeJobs(deviceID, serviceID, actionName, input, jobID, (err, results) => {
          if (run.settled) return LOG.I(`job ${String(jobID).slice(0, 32)}: an answer after its timeout, dropped`);
          // The pass ended on its question (M22), by the main thread's own
          // record of it: not billed, no attempt spent. The job completes
          // with no result, marked asking, and is run again once answered
          // (rerunTask); or, with no form to show, the pass runs again now,
          // its ctx.ask ASK_UNAVAILABLE.
          if (err != null && err.code === 'ASK_PENDING' && askState != null && askState.pending != null) {
            const marked = Object.assign({}, jobData, {asking: (Number.isInteger(jobData.asking) ? jobData.asking : 0) + 1});
            return Promise.resolve().then(() => hooks.asked(jobData, String(jobID), askState, {extra: call.extra(), session: runSession.session}))
              .then((r) => {
                // (the hook closed this pass's call when it wrote the
                // question: it counts as closed -- ruled M1; the usage
                // counters' close of a call already completed is nothing)
                if (r != null && r.asked != null) call.closedByAsk();
                return r;
              })
              .then((r) => {
                // (the run timed out while the question was written: its
                // question goes, and nothing more is marked)
                if (run.settled) {
                  if (r != null && r.asked != null) settledAsk();
                  return undefined;
                }
                return ((r != null && r.cancelled === true) ? Promise.resolve() : job.updateData(marked)).then(() => {
                if (run.settled) return undefined;
                // cancelled while it ran (its tombstone; the hook took the
                // record): it ends as a run cancelled while running does
                if (r != null && r.cancelled === true) {
                  call.close('cancelled');
                  run.settled = true;
                  if (timeoutHandle != null) clearTimeout(timeoutHandle);
                  return resolve(null);
                }
                jobData.asking = marked.asking;
                // no form could be shown, or no room: this pass's call
                // closed, and the next pass runs at once, bounded by this
                // run's own timeout: its owner checked again, its record read
                // and the task's tombstone checked first, before its own call
                // is opened -- a skip there (cancelled, or its question
                // waiting) ends the run as the local runner ends it (#487's
                // high, rounds 1 and 2)
                if (r != null && r.rerun === true) {
                  call.close('unavailable');
                  return _this.authorizeRun(job).then((key) => {
                    try { runOwnerKey = ownerKeyAuthorized(jobData, key); } catch (e) { return _this.refusedForGood(job, e).catch((x) => ({refused: x})); }
                    // (refused: as authorizeRun's refusal, retried as its attempts allow)
                    return chargeableRun(_this.cdifInterface, runOwnerKey).then(() => askBefore(true), (e) => ({refused: e}));
                  }, (e) => ({refused: (e instanceof Error) ? e : new Error(String(e))})).then((a) => {
                    if (run.settled) return undefined;
                    // (refused: the run fails with a call of its own, as a
                    // first pass's refusal does -- final when the refusal
                    // is (authorizeRun: a scheduler's then removed), else
                    // retried as its attempts allow, a check that timed out)
                    if (a != null && a.refused != null) return failRun(a.refused, a.refused.retry === false ? new UnrecoverableError(a.refused.message) : a.refused);
                    // (a read that failed: the run fails, with a call of its
                    // own, retried as its attempts allow)
                    if (a != null && a.error != null) return failRun(a.error, new Error(String(a.error.message)));
                    if (a != null && a.skip === true) {
                      // (the hold's length read before the run is settled)
                      const holdFor = a.cancelled !== true ? holdMsOf(hooks) : null;
                      run.settled = true;
                      run.asked = a.cancelled !== true;
                      if (timeoutHandle != null) clearTimeout(timeoutHandle);
                      if (run.asked) holdSession(jobID, holdFor);
                      else settledAsk();
                      return resolve(null);
                    }
                    call.open();
                    return pass(a != null ? a.state : null);
                  });
                }
                // (the hold's length read before the run is settled: a throw
                // there fails the run below, never leaves it unsettled)
                const holdFor = holdMsOf(hooks);
                run.settled = true;
                run.asked = true;
                if (timeoutHandle != null) clearTimeout(timeoutHandle);
                holdSession(jobID, holdFor);
                return resolve(null);
                });
              })
              .catch((e) => {
                if (run.settled) return;
                // (a run failed after its question was written: the question
                // goes too, as the local runner's failure settles it)
                settledAsk();
                failRun((e instanceof Error) ? e : new Error(String(e)), new UnrecoverableError(String((e && e.message) || e)));
              });
          }
          run.settled = true;
          if (timeoutHandle != null) clearTimeout(timeoutHandle);
          //TODO: add results object to result-queue as a job to be able to notify job sender reliably under distributed environment
          if (err != null) {
            // bullmq's Worker only persists a job failure as a plain string
            // (job.failedReason = err.message) -- any other property on the
            // rejected error, including CountinghouseError's `code`, is lost
            // once it round-trips through
            // redis. Encode it into the message itself as a "CODE: message"
            // prefix (every CountinghouseError code is an UPPER_SNAKE_CASE
            // identifier, which a real message would not otherwise start
            // with) so lib/mcp/gateway.js's handleTasksResult can recover
            // it -- see the matching decode there.
            // (a 2026-07-28 task's answered call is marked: failureText)
            const failMessage = failureText(err, jobData);
            failWith(err);
            // A module that is gone stays gone until an operator loads it
            // again: retrying (attempts > 1) could only fail the same way.
            // A reload or a supervised restart is retried as any failure is.
            if (notRetried(err.code, err)) return reject(new UnrecoverableError(failMessage));
            return reject(new Error(failMessage));
          }

          // task-augmented MCP tool calls (lib/mcp/gateway.js's
          // createTaskForToolCall) stash the caller's apiKey on the job data
          // so a successful completion can still be recorded here -- this
          // path never goes through lib/session.js's Session/logAPICall
          // machinery (which is what records ordinary, synchronous
          // invoke-action calls), so without this, task-augmented calls
          // would never be recorded at all. Fire-and-forget, matching the
          // existing (also fire-and-forget) session.js billing call.
          const ownerKey = runOwnerKey;
          if (ownerKey != null && typeof(_this.cdifInterface.recordCall) === 'function') {
            // Same canonical metering identity every other entry path uses
            // (see lib/mcp/gateway.js's tools/call comment) rather than
            // job.name, which is the MCP tool name for a task-augmented call
            // but an arbitrary caller-chosen string for an HTTP-submitted job.
            const meteredTool = encodeLegacyTool(deviceID, serviceID, actionName);
            _this.cdifInterface.recordCall(ownerKey, meteredTool, options.mcpToolCallCost, (err) => {
              // (lost after the run: said by the key's fingerprint, the tool and the amount)
              if (err) LOG.E(require('./metering/charge-bound').chargeLost(meteredTool, ownerKey, options.mcpToolCallCost, err));
            }, {session: runSession.session});
          }

          // a task that asked: its data is no longer marked, then its record
          // goes; the record last, so a failed write leaves a task that
          // still reads its question, never a completed one read as expired
          // (the review of #374, N3; the write is tried twice)
          const unmarked = Object.assign({}, jobData);
          delete unmarked.asking;
          const write = (data) => job.updateData(data).catch(() => job.updateData(data));
          const hook = _this.completionHook;
          if (typeof(hook) !== 'function') {
            return (jobData.asking != null ? write(unmarked).then(settledAsk) : Promise.resolve()).catch((e) => LOG.E(e)).then(() => resolve(results));
          }
          // The full main-side data is written back with the stamp merged
          // in: updateData replaces job.data, and ownership (ownsJob), billing
          // and tasks/result's addressing all read it.
          return Promise.resolve().then(() => hook(jobData, results, {extra: call.extra(), session: runSession.session, jobId: String(jobID)}))
            .then((extra) => ((extra != null || jobData.asking != null) ? write(Object.assign({}, unmarked, extra)) : null))
            .then(() => { if (jobData.asking != null) settledAsk(); }, (e) => {
              // the hook failed: the run is still done, so unmarked all the same
              LOG.E(e);
              return jobData.asking != null ? write(unmarked).then(settledAsk) : null;
            })
            .catch((e) => LOG.E(e))
            .then(() => resolve(results));
        }, () => run.settled, Object.assign(withRunBookkeeping(call.extra(), runOwnerKey, leftMs(), runSession), askState != null ? {ask: askState} : {},
          // a run's last progress, written through the Job this processor holds (no read: F4-3)
          {progressTo: (p) => (run.settled ? undefined : job.updateProgress(p))}));
        // (a dispatch that throws fails the run on its pass's call, retried as
        // any failure is, as the local runner's does; a later pass's throw
        // reaches its asked catch)
        call.open();
        try { return pass(asks != null ? asks.state : null); } catch (e) {
          // (settled by its own answer, then a throw: BullMQ is still told,
          // nothing recorded again)
          if (run.settled) return reject((e instanceof Error) ? e : new Error(String(e)));
          return failRun((e instanceof Error) ? e : new Error(String(e)));
        }
      // a pass that asked keeps the job's session for its run again
      })).then((r) => { _this.running.delete(live); if (run.asked !== true) settledRun(null); return r; },
        (e) => { _this.running.delete(live); settledRun(e); throw e; });
    }), {prefix: prefix, connection: connection, concurrency: 1024, autorun: false});

    // the worker takes jobs once this server's id is claimed on this Redis
    // (lib/server-claim.js): another live runtime with this id is another
    // server on one queue, and this start is refused (the start's own claim,
    // made before it served, is this one)
    const worker = this.worker;
    this.claimServerId().held.then(() => { if (this.worker === worker) worker.run().catch((e) => LOG.E(e)); });
  },

  // A job runs only while its owner may still call that action: the owner's
  // key is checked again before every run, as a synchronous call is, so a
  // queued, delayed, retried or scheduled job stops once the grant is
  // revoked or the key removed. A refusal is final (not retried) and, for a
  // scheduled job, removes its scheduler, which would only be refused again.
  // An unreachable auth backend is retried as any failure is. The failure
  // names the code only: an auth error's message may hold the key. A job with
  // no owner (JobControl.INTERNAL) is the platform's own.
  // The check has a deadline (authorizeRunMs): an auth backend that accepts
  // the lookup and never answers fails the run SYSTEM_ERROR_USERDB_NA, which
  // is retried, instead of holding it with no bound (the run's own timeout
  // is set only once this resolves). An answer after the deadline changes
  // nothing.
  authorizeRunMs: 10000,

  authorizeRun: function(job) {
    return authorizeOwner(job.data, job.id, this.authorizeRunMs).catch((e) => {
      if (e.final !== true) throw e;
      return this.refusedForGood(job, e);
    });
  },

  // A run refused for good: its scheduler removed (it would only fail
  // again), then the refusal, unrecoverable. -> a rejected Promise.
  refusedForGood: function(job, e) {
    const scheduler = (job.repeatJobKey != null)
      ? this.jobQueue.removeJobScheduler(job.repeatJobKey).then((removed) => { if (removed === true) jobSessions.forget(String(job.repeatJobKey)); }) : Promise.resolve();
    return scheduler.catch((x) => LOG.E(x)).then(() => { throw new UnrecoverableError(e.message); });
  },

  addJob: function(authCtx, jobOpts, deviceID, serviceID, actionName, input, callback) {
    if (options.workerThread !== true) {
      return callback(new CountinghouseError('ADD_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
    }
    if (authCtx !== INTERNAL && (authCtx == null || authCtx.appKey == null)) {
      return callback(denied(authCtx));
    }
    if (jobOpts == null) {
      return callback(new CountinghouseError('JOB_OPTS_INVALID', 'must have opts to add a job'));
    }
    if (jobOpts.name == null) {
      return callback(new CountinghouseError('JOB_OPTS_INVALID', 'job must have a name'));
    }

    const boundsError = jobOptsError(jobOpts);
    if (boundsError != null) return callback(new CountinghouseError('JOB_OPTS_INVALID', boundsError));

    const name = jobOpts.name;
    const opts = {};

    opts.attempts = jobOpts.attempts;   // [Optional] The total number of attempts to try the job until it completes or fail. Defaults to 1
    opts.delay    = jobOpts.delay;      // [Optional] An amount of milliseconds to wait until this job can be processed. Note that for accurate delays, both server and clients should have their clocks synchronized.
    opts.timeout  = jobOpts.timeout;    // [Optional] The number of milliseconds after which the job should be fail with a timeout error
    // A --stdio runtime is one session, its queue its process's own
    // (job-control-common.js jobQueuePrefix): a finished job is kept
    // STDIO_JOB_KEPT_S, then BullMQ removes it, so what a session leaves on
    // Redis is bounded by time, not by how many sessions ran
    if (options.stdio === true) {
      opts.removeOnComplete = {age: STDIO_JOB_KEPT_S};
      opts.removeOnFail = {age: STDIO_JOB_KEPT_S};
    }

    // apiKey comes from `authCtx` -- the *authenticated* identity resolved by
    // the caller's own auth gate -- and never from `jobOpts`, which on the
    // HTTP path (lib/routes/add-job.js) is request-body data the caller
    // controls end to end. Reading it from jobOpts is what let any valid key
    // bill an arbitrary other key by sending {"opts":{"apiKey":"victim"}}.
    // It is both the billing subject (see initJobProcess's worker callback)
    // and the ownership subject (see ownsJob above), so a forgeable value
    // here was simultaneously a billing-attribution and an authorization bug.
    const jobData = {
      deviceID: deviceID,
      serviceID: serviceID,
      actionName: actionName,
      input: input
    };
    // the owner by opaque id, never the key: the key made known to the
    // identity index first (job-control-common's ownerData; B-meter-keys
    // (2)). The add goes on outside the promise, so a throw in it stays an
    // exception and the callback runs once.
    const _this = this;
    return addWhenOwned(authCtx, callback, (owner, answer) => addOwned.call(_this, owner, answer));
    function addOwned(owner, callback) {
    Object.assign(jobData, owner);
    // a 2026-07-28 task's (M15): its result is shaped, and stamped, for that era
    if (jobOpts.era === 'modern') jobData.era = 'modern';
    // whether its request declared form elicitation: its handler may ask (M22)
    if (jobOpts.era === 'modern' && jobOpts.asks === true) jobData.asks = true;

    if (jobOpts.repeat != null) {
      // bullmq moved repeatable job creation off Queue.add() and onto a dedicated
      // scheduler API; jobSchedulerId is used the same way `name` was used before
      // to look up / remove a repeatable job later (see removeJob below)
      const repeatOpts = {};
      // according to bullmq documentation pattern (cron) is mutual exclusive to every. we prioritize cron setting here
      if (jobOpts.repeat.cron != null) {
        repeatOpts.pattern = jobOpts.repeat.cron;   // cron string; bullmq calls this field "pattern"
      } else {
        repeatOpts.every = jobOpts.repeat.every;    //Repeat every milliseconds
      }
      repeatOpts.limit = jobOpts.repeat.limit;      // Number of times the job should repeat at max.

      // its session, set before its first run can start (every run of it);
      // a re-upsert from no session clears it, and a failed one puts back
      // what was there
      const sid = schedulerId(authCtx, name);
      const before = jobSessions.entryOf(sid);
      jobSessions.replace(sid, sessionOfCtx(authCtx));
      this.jobQueue.upsertJobScheduler(sid, repeatOpts, {name: name, data: jobData, opts: opts})
      .then((job) => {
        return callback(null, {id: job.id});
      }).catch((err) => {
        jobSessions.putBack(sid, before);
        return callback(new CountinghouseError('ADD_JOB_ERROR', err.message));
      });
      return;
    }

    // A job made in a shared runtime's session gets an id chosen here
    // (opaque, random: BullMQ takes no integer-like custom id), so its
    // session is set before its run can start. Every other job keeps
    // BullMQ's own ids; --stdio's one session is set once the add answers
    // (a run that starts first takes the defaults).
    const session = sessionOfCtx(authCtx);
    if (session != null && require('./sessions').shared()) {
      opts.jobId = `s-${crypto.randomBytes(12).toString('hex')}`;
      jobSessions.remember(opts.jobId, session);
    }
    // a 2026-07-28 task (M15): the gateway's minted id (checked by
    // jobOptsError). A shared runtime runs on the local store's runner
    // (framework.js), never this one, so this runner never meets a shared
    // session's task.
    if (jobOpts.taskId != null) {
      opts.jobId = jobOpts.taskId;
      if (session != null) jobSessions.remember(opts.jobId, session);
    }
    this.jobQueue.add(name, jobData, opts)
    .then((job) => {
      if (session != null && opts.jobId == null && !finished.has(String(job.id))) jobSessions.remember(String(job.id), session);
      return callback(null, {id: job.id});
    }).catch((err) => {
      if (opts.jobId != null) jobSessions.forget(opts.jobId);
      return callback(new CountinghouseError('ADD_JOB_ERROR', err.message));
    });
    }
  },

  getJob: function(authCtx, id, callback) {
    if (options.workerThread !== true) {
      return callback(new CountinghouseError('GET_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
    }

    const _this = this;

    this.jobQueue.getJob(id).then((job) => {
      if (job == null) return callback(new CountinghouseError('JOB_NOT_FOUND'));

      // Ownership is checked before anything about the job is handed back --
      // including before getState()'s extra redis read, so a probe for
      // someone else's job costs nothing and reveals nothing.
      if (ownsJob(authCtx, job.data) !== true) return callback(denied(authCtx));

      job.getState().then((state) => {
        // job.getState() (bullmq's Job.prototype.getState -> a separate
        // redis read keyed on job id) never refreshes the `job` instance's
        // own fields -- if the job transitions to a terminal state in the
        // gap between the jobQueue.getJob(id) fetch above and this getState()
        // resolving, `job.failedReason`/`job.returnvalue` can still reflect
        // the pre-transition (stale/empty) snapshot even though `state`
        // correctly reports the job as done. Found via test/unit/test032.js
        // intermittently seeing a failed task's tasks/result come back with
        // the generic 'task failed' fallback instead of the real reason.
        // Re-fetch once the state is known to be terminal so the returned
        // fields reflect the same settled data the state itself does.
        const refetch = (state === 'completed' || state === 'failed')
          ? _this.jobQueue.getJob(id)
          : Promise.resolve(job);

        refetch.then((freshJob) => {
          const j = freshJob != null ? freshJob : job;

          return callback(null, {
            job: jobRecord(j),
            state: state
          });
        }).catch((error) => {
          return callback(new CountinghouseError('GET_JOB_ERROR', error.message));
        });

      }).catch((error) => {
        return callback(new CountinghouseError('GET_JOB_ERROR', error.message));
      });
    }).catch((err) => {
      return callback(new CountinghouseError('GET_JOB_ERROR', err.message));
    });
  },

  // History is keyed by job *name*, which is caller-chosen and therefore not
  // an ownership boundary on its own (two tenants can pick the same name).
  // Each stored record carries the full job, its owner by id, so the filter
  // is applied per record -- a caller gets its own history for
  // that name and nothing else, instead of the previous "whoever asks for
  // the name gets every tenant's entries under it" (the in-code TODO this
  // replaces).
  // A {job, state} record as the HTTP job routes return it: without the
  // completion hook's internal outputSchemaHash, so their response shape is
  // the one it was before tasks/result needed the stamp.
  publicRecord: function(record) {
    return publicRecord(record);
  },

  getJobHistory: function(authCtx, name, callback) {
    return getJobHistory(authCtx, name, callback);
  },

  removeJob: function(authCtx, name, jobID, isRepeat, callback) {
    const _this = this;

    if (options.workerThread !== true) {
      return callback(new CountinghouseError('REMOVE_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
    }
    if (authCtx !== INTERNAL && (authCtx == null || authCtx.appKey == null)) {
      return callback(denied(authCtx));
    }
    if (name == null) {
      return callback(new CountinghouseError('JOB_OPTS_INVALID', 'job must have a name'));
    }
    if (isRepeat == null ||typeof(isRepeat) !== 'boolean') {
      return callback(new CountinghouseError('JOB_OPTS_INVALID', 'must pass in isRepeat boolean flag'));
    }


    if (isRepeat === false) {
      _this.jobQueue.getJob(jobID).then((job) => {
        if (job == null) return callback(new CountinghouseError('JOB_NOT_FOUND'));
        if (ownsJob(authCtx, job.data) !== true) return callback(denied(authCtx));
        // job.remove() returns a promise and *rejects* (rather than resolving
        // false) when the job is currently locked by an active worker -- it
        // must be awaited, otherwise a job stuck mid-processing (e.g. one
        // whose action handler never calls back) silently fails to remove
        // while the caller is told {removed: true}.
        job.remove().then(() => {
          jobSessions.forget(String(job.id));   // it will not run
          return callback(null, {removed: true});
        }).catch((err) => {
          return callback(new CountinghouseError('REMOVE_JOB_ERROR', err.message));
        });
      }).catch((err) => {
        return callback(new CountinghouseError('REMOVE_JOB_ERROR', err.message));
      });
    } else {
      // A repeatable job is removed by scheduler id, which is scoped to its
      // owner (schedulerId above): a caller removes its own scheduler of that
      // name and can reach no other (review R3-2). This replaces the earlier
      // admin-only rule, which stood in for the missing owner. An admin may
      // also remove an ownerless scheduler (an internal path's), whose id is
      // the bare name.
      const legacy = (authCtx !== INTERNAL && authCtx.isAdmin === true && schedulerId(authCtx, name) !== name);
      _this.jobQueue.removeJobScheduler(schedulerId(authCtx, name)).then((removed) => {
        if (removed === true) jobSessions.forget(schedulerId(authCtx, name));
        if (removed === true) return true;
        return legacy ? _this.jobQueue.removeJobScheduler(name) : false;
      }).then((removed) => {
        if (removed !== true) return callback(new CountinghouseError('JOB_NOT_FOUND'));
        return callback(null, {removed: true});
      }).catch((err) => {
        return callback(new CountinghouseError('REMOVE_JOB_ERROR', err.message));
      });
    }
  },

  // lists recent jobs across all states directly from the live queue (unlike
  // getJobHistory, which reads the separate Redis snapshot log keyed by job
  // name -- this is a name-agnostic view, used by the MCP gateway's tasks/list).
  listJobs: function(authCtx, callback) {
    if (options.workerThread !== true) {
      return callback(new CountinghouseError('GET_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
    }
    if (authCtx !== INTERNAL && (authCtx == null || authCtx.appKey == null)) {
      return callback(denied(authCtx));
    }

    // The caller's own, LIST_MAX at most a state, newest first within each:
    // each state paged until the caller's are found or it runs out, never
    // one page of every caller's then filtered, which dropped a caller's tasks
    // once others had LIST_MAX newer ones (the final pass's gateway part,
    // A9). What is read is bounded a state (STATE_READ_MAX), so no state's
    // jobs, of any caller, use up another's reach: master's newest page of
    // every state is the floor (#531's high, M2). A state is paged to its
    // count, taken once: BullMQ drops a job removed mid-read, so a short page
    // is not its end (L2). A job seen twice (an offset that moved between
    // pages, a job that changed state between reads) is listed once. A list
    // that may be missing some of the caller's -- a state read to its bound,
    // one of the caller's left out past LIST_MAX, a state that changed while
    // it was read -- says so: the third argument, {truncated}.
    const owned = [];
    const seen = new Set();
    let truncated = false;
    const queue = this.jobQueue;
    const readState = (state) => Promise.resolve(queue.getJobCountByTypes(state)).then((count) => {
      let mine = 0;
      let full = false;   // LIST_MAX of the caller's: read on only to see whether one more is there
      const page = (start) => {
        if (start >= count || (full && truncated)) return Promise.resolve();
        // (past the bound, more of the caller's may be there: said)
        if (start >= STATE_READ_MAX) { truncated = true; return Promise.resolve(); }
        const size = Math.min(LIST_PAGE, STATE_READ_MAX - start);
        return queue.getJobs([state], start, start + size - 1, false).then((jobs) => {
          // (a page short of what the count promised: a job left the state
          // while it was read, and the rest moved up past this offset -- one
          // of the caller's may have been skipped: the medium on the round, 3)
          if (jobs.length < Math.min(size, count - start)) truncated = true;
          // Filtered before anything is mapped: an unowned job never even gets
          // its state read, and never appears in the result. A *filter*, not an
          // error: "list mine" is empty for a caller with no jobs.
          for (let i = 0; i < jobs.length; i++) {
            const id = String(jobs[i].id);
            if (seen.has(id)) continue;
            seen.add(id);
            if (!ownsJob(authCtx, jobs[i].data)) continue;
            // (cut only when one of the caller's is left out: the medium on
            // the round, 4)
            if (full) { truncated = true; break; }
            owned.push(jobs[i]);
            mine += 1;
            if (mine >= LIST_MAX) full = true;
          }
          return page(start + size);
        });
      };
      // (and a count that moved while the state was read: one may have been
      // pushed past where it was read to, or below an offset read -- said)
      return page(0).then(() => Promise.resolve(queue.getJobCountByTypes(state))).then((now) => { if (now !== count) truncated = true; });
    });
    LIST_STATES.reduce((p, state) => p.then(() => readState(state)), Promise.resolve())
    .then(() => owned)
    .then((jobs) => {

      async.map(jobs, (job, cb) => {
        job.getState().then((state) => {
          cb(null, {
            job: jobRecord(job),
            state: state
          });
        }).catch((err) => {
          cb(null, null); // skip jobs whose state can't be read rather than failing the whole list
        });
      }, (err, results) => {
        if (err) return callback(new CountinghouseError('GET_JOB_ERROR', err.message));
        return callback(null, results.filter((r) => { return r != null; }), {truncated});
      });
    }).catch((err) => {
      return callback(new CountinghouseError('GET_JOB_ERROR', err.message));
    });
  },

  updateJobProgress: function(jobID, progress) {
    // (its write chained, so a job gone meanwhile is caught here, never an
    // unhandled rejection: F4-3's coalesced progress can arrive after it)
    // (returned: a run's end waits for its last progress, lib/device-manager.js)
    return this.jobQueue.getJob(jobID).then((job) => {
      if (job != null) return job.updateProgress(progress);
      return undefined;
    }).catch((err) => {
      return;
    });
  },

  installJobEventHandlers: function() {
    const _this = this;

    this.queueEvents.on('error', (error) => {
      LOG.E(`job queue error: ${error}`);
    });

    //TODO: ltrim and hdel (according to value in trimed jobID list) to entries in joblist: jobinfo: keyspace to keep redis clean
    //This could be done in api-mon once an hour by iterating all joblist:* keys
    this.queueEvents.on('waiting', (args) => {
      _this.jobQueue.getJob(args.jobId).then((job) => {
        if (job == null) return;
        _this.saveJobInfoToRedis(job, 'waiting');
        // a task's run again after its answer (M22: rerunTask's retry), queued:
        // tasks/get reads working from now, not only once a worker takes it
        // (M16 D2), so its listeners are told now
        if (job.data != null && job.data.asking != null) taskEvents.emit(job.id, 'active');
      }).catch((err) => {
        return;
      });
    });

    this.queueEvents.on('removed', (args) => {
      // TODO: this event is never fired now
      // LOG.I('job removed: ' + jobID);
      _this.jobQueue.getJob(args.jobId).then((job) => {
        if (job == null) return;
        _this.saveJobInfoToRedis(job, 'removed');
      }).catch((err) => {
        return;
      });
    });

    this.queueEvents.on('active', (args) => {
      // LOG.I('job active: ' + args.jobId);
      _this.jobQueue.getJob(args.jobId).then((job) => {
        if (job == null) return;
        _this.saveJobInfoToRedis(job, 'active');
        taskEvents.emit(job.id, 'active');
      }).catch((err) => {
        return;
      });
    });

    this.queueEvents.on('stalled', (args) => {
      // LOG.I('job stalled: ' + args.jobId);
      // A job has been marked as stalled. This is useful for debugging job
      // workers that crash or pause the event loop.
      _this.jobQueue.getJob(args.jobId).then((job) => {
        if (job == null) return;
        _this.saveJobInfoToRedis(job, 'stalled');
      }).catch((err) => {
        return;
      });
    });

    this.queueEvents.on('progress', (args) => {
      // A job's progress was updated. Its job info isn't written (it has no
      // state for it); a 2026-07-28 task's listeners are told (M16), and
      // read the progress from the job itself.
      taskEvents.emit(args.jobId, 'progress');
    });

    this.queueEvents.on('completed', (args) => {
      // LOG.I('job completed: ' + args.jobId);
      // A job successfully completed with a `result`.
      _this.jobQueue.getJob(args.jobId).then((job) => {
        if (job == null) return;
        // a one-off job done, wherever it ran: its session's entry ends; not
        // a task's pass that ended on its question (M22: job.data.asking,
        // written before the pass resolved), whose run again needs it
        if (job.repeatJobKey == null && (job.data == null || job.data.asking == null)) markFinished(job.id);
        _this.saveJobInfoToRedis(job, 'completed');
        // a pass that ended on its question waits for its answer (M22): the
        // mark is written before the pass resolves, and gone before a run
        // again resolves, so it tells the two apart
        taskEvents.emit(job.id, (job.data != null && job.data.asking != null) ? 'input_required' : 'completed');
      }).catch((err) => {
        return;
      });
    });

    this.queueEvents.on('failed', (args) => {
      // LOG.I('job failed: ' + args.jobId);
      // A job failed with reason `args.failedReason`!
      _this.jobQueue.getJob(args.jobId).then((job) => {
        if (job == null) return;
        // a one-off job failed for good, its processor's end or not (a
        // stalled run, a deferred failure): its session's entry ends
        if (job.repeatJobKey == null && job.finishedOn != null) markFinished(job.id);
        _this.saveJobInfoToRedis(job, 'failed');
        // for good only: an attempt that will be retried is still working
        if (job.finishedOn != null) taskEvents.emit(job.id, 'failed');
      }).catch((err) => {
        return;
      });
    });


  },

  saveJobInfoToRedis: function(job, state) {
    return saveJobInfo(job, state);
  }
};
