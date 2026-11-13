// The local job runner (LM1, docs/superpowers/specs/2026-11-11-local-mode-
// design.md section 1; plan 2026-11-11-lm1-store-and-identity.md, Task 8):
// the surface lib/job-control.js gives the rest of the runtime (addJob,
// getJob, getJobHistory, removeJob, listJobs, updateJobProgress,
// publicRecord, INTERNAL, the start and completion hooks), for --store
// local, run in this process by one worker loop with no queue service.
//
// The same rules as job-control.js, shared from lib/job-control-common.js:
// the bounds on a job's options, its owner's checks, the scheduler ids,
// the history kept in the store's kv. The same processor steps: the owner
// is authorized before every run (authorizeRun); the start hook's answer
// goes to invokeJobs and to the completion hook; a run's own timeout, else
// --jobTimeout, fails it ("Promise timed out after N milliseconds") and an
// answer after that is dropped; a failure is "CODE: message" and retried up
// to its attempts unless its code is never retried; a success is billed as
// a task-augmented call is and the completion hook's answer merged into
// the job's data. A delay holds a job; a repeat (every, or a cron pattern)
// is a scheduler, at most `limit` runs.
//
// State is in memory: a job from an earlier process is not found, and a
// finished job is forgotten --jobResultTtl after it finished (the spec:
// results kept until read or for that long; a result read is kept too, so
// a client may read it again within the time).
const options = require('./cli-options');
const LOG     = require('./logger');
// A log line that never throws (a bare process has no logger set up).
const log = (level, line) => { try { LOG[level](line); } catch (logErr) { /* no logger */ } };
const {CountinghouseError} = require('./countinghouse-error');
const common  = require('./job-control-common');
// as lib/job-control.js: the owner's key and the run's timeout, when set,
// for the run's token; neither is sent on to the worker
const runBookkeeping = (ownerKey, timeoutMs) => Object.assign({}, (ownerKey != null) ? {ownerKey: ownerKey} : {}, (timeoutMs != null) ? {timeoutMs: timeoutMs} : {});
const {MAX_TIMER_MS, NOT_RETRIED, jobOptsError, INTERNAL, schedulerId, legacySchedulerId, ownsJob, denied, ownerData} = common;
const encodeLegacyTool = require('./metering/provider').encodeLegacyTool;

const LIST_STATES = ['waiting', 'active', 'delayed', 'completed', 'failed'];
const LIST_MAX = 50;
const DEFAULT_RESULT_TTL_MS = 3600 * 1000;

const record = common.jobRecord;

function nextCron(pattern, after) {
  const {CronExpressionParser} = require('cron-parser');
  return CronExpressionParser.parse(pattern, {currentDate: new Date(after)}).next().getTime();
}

function createRunner(opts) {
  const o = opts || {};
  const jobs = new Map();          // id -> job
  const schedulers = new Map();    // scheduler id -> {name, data, opts, every, pattern, limit, runs, timer}
  const timers = new Set();
  let nextId = 1;
  let closed = false;

  // A timer for a moment `at` (ms since the epoch): set again while `at`
  // lies past what one timer can hold, so a long delay, a yearly cron or a
  // long result TTL never fires early (review of B5). Each is unref'd and
  // kept in `timers` until it fires or is cleared.
  const maxTimerMs = (o.maxTimerMs != null) ? o.maxTimerMs : MAX_TIMER_MS;
  const timerAt = (fn, at) => {
    const h = {t: null};
    const arm = () => {
      const left = at - Date.now();
      h.t = setTimeout(() => {
        timers.delete(h);
        if (Date.now() < at) { timers.add(h); return arm(); }
        return fn();
      }, Math.min(Math.max(left, 0), maxTimerMs));
      if (typeof(h.t.unref) === 'function') h.t.unref();
    };
    timers.add(h);
    arm();
    return h;
  };
  const timer = (fn, ms) => timerAt(fn, Date.now() + ms);
  const clear = (h) => {
    if (h == null) return;
    clearTimeout(h.t);
    timers.delete(h);
  };

  const resultTtlMs = () => ((o.resultTtlMs != null) ? o.resultTtlMs
    : (options.jobResultTtl != null ? options.jobResultTtl : DEFAULT_RESULT_TTL_MS));
  const jobTimeoutMs = () => ((o.jobTimeoutMs != null) ? o.jobTimeoutMs : options.jobTimeout);

  const runner = {
    INTERNAL: INTERNAL,
    completionHook: null,
    startHook: null,
    cdifInterface: null,
    authorizeRunMs: 10000,

    setCompletionHook(fn) { runner.completionHook = fn; },
    setStartHook(fn) { runner.startHook = fn; },

    initJobProcess(cdifInterface) { runner.cdifInterface = cdifInterface; },

    // The owner may still call the action, checked before every run, as
    // job-control.js does (a refusal is final and removes a scheduler).
    authorizeRun(job) {
      // job-control-common's check, as the BullMQ runner's; a final refusal
      // stops a scheduler
      return common.authorizeOwner(job.data, job.id, runner.authorizeRunMs).catch((e) => {
        if (e.final === true && job.schedulerId != null) stopScheduler(job.schedulerId);
        throw Object.assign(e, {retry: e.final !== true});
      });
    },

    addJob(authCtx, jobOpts, deviceID, serviceID, actionName, input, callback) {
      if (options.workerThread !== true) return callback(new CountinghouseError('ADD_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
      if (authCtx !== INTERNAL && (authCtx == null || authCtx.appKey == null)) return callback(denied(authCtx));
      if (jobOpts == null) return callback(new CountinghouseError('ADD_JOB_ERROR', 'must have opts to add a job'));
      if (jobOpts.name == null) return callback(new CountinghouseError('ADD_JOB_ERROR', 'job must have a name'));
      const boundsError = jobOptsError(jobOpts);
      if (boundsError != null) return callback(new CountinghouseError('ADD_JOB_ERROR', boundsError));
      const name = jobOpts.name;
      const jobOptions = {attempts: jobOpts.attempts, delay: jobOpts.delay, timeout: jobOpts.timeout};
      const data = Object.assign({deviceID, serviceID, actionName, input}, ownerData(authCtx));
      if (jobOpts.repeat != null) {
        const id = schedulerId(authCtx, name);
        if (schedulers.has(id)) stopScheduler(id);
        let first;
        try {
          first = (jobOpts.repeat.cron != null) ? nextCron(jobOpts.repeat.cron, Date.now()) : Date.now();
        } catch (e) {
          return callback(new CountinghouseError('ADD_JOB_ERROR', e.message));
        }
        const s = {name, data, opts: jobOptions, every: jobOpts.repeat.every, pattern: jobOpts.repeat.cron,
          limit: jobOpts.repeat.limit, runs: 0, timer: null};
        schedulers.set(id, s);
        const job = scheduleRun(id, s, first);
        return process.nextTick(callback, null, {id: job.id});
      }
      const job = enqueue(name, data, jobOptions, null, Date.now() + ((jobOptions.delay > 0) ? jobOptions.delay : 0));
      return process.nextTick(callback, null, {id: job.id});
    },

    getJob(authCtx, id, callback) {
      if (options.workerThread !== true) return callback(new CountinghouseError('GET_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
      const job = jobs.get(String(id));
      if (job == null) return process.nextTick(callback, new CountinghouseError('GET_JOB_ERROR', 'unknown job'));
      if (ownsJob(authCtx, job.data) !== true) return process.nextTick(callback, denied(authCtx));
      return process.nextTick(callback, null, {job: record(job), state: job.state});
    },

    publicRecord(r) {
      return common.publicRecord(r);
    },

    getJobHistory(authCtx, name, callback) {
      return common.getJobHistory(authCtx, name, callback);
    },

    removeJob(authCtx, name, jobID, isRepeat, callback) {
      if (options.workerThread !== true) return callback(new CountinghouseError('REMOVE_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
      if (authCtx !== INTERNAL && (authCtx == null || authCtx.appKey == null)) return callback(denied(authCtx));
      if (name == null) return callback(new CountinghouseError('REMOVE_JOB_ERROR', 'job must have a name'));
      if (isRepeat == null || typeof(isRepeat) !== 'boolean') return callback(new CountinghouseError('REMOVE_JOB_ERROR', 'must pass in isRepeat boolean flag'));
      if (isRepeat === false) {
        const job = jobs.get(String(jobID));
        if (job == null) return process.nextTick(callback, new CountinghouseError('REMOVE_JOB_ERROR', 'unknown job'));
        if (ownsJob(authCtx, job.data) !== true) return process.nextTick(callback, denied(authCtx));
        // a running job is not removed, as BullMQ will not remove a locked
        // one: the module's work finishes and is billed (review of B5)
        if (job.state === 'active') {
          return process.nextTick(callback, new CountinghouseError('REMOVE_JOB_ERROR',
            `Job ${job.id} could not be removed because it is locked by another worker`));
        }
        job.cancelled = true;
        clear(job.delayTimer);
        jobs.delete(job.id);
        common.saveJobInfo(job, 'removed');
        return process.nextTick(callback, null, {removed: true});
      }
      // the owner's scheduler, then its pre-opaque-id name, then (an admin)
      // the bare name, as job-control.js looks them up
      const candidates = [schedulerId(authCtx, name), legacySchedulerId(authCtx, name)];
      if (authCtx !== INTERNAL && authCtx.isAdmin === true && schedulerId(authCtx, name) !== name) candidates.push(name);
      const found = candidates.find((c) => c != null && schedulers.has(c));
      if (found == null) return process.nextTick(callback, new CountinghouseError('REMOVE_JOB_ERROR', 'unknown job'));
      stopScheduler(found);
      return process.nextTick(callback, null, {removed: true});
    },

    listJobs(authCtx, callback) {
      if (options.workerThread !== true) return callback(new CountinghouseError('GET_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
      if (authCtx !== INTERNAL && (authCtx == null || authCtx.appKey == null)) return callback(denied(authCtx));
      // newest first within each state, as job-control asks BullMQ
      // (getJobs(states, 0, 49, asc = false))
      const out = [];
      const newestFirst = Array.from(jobs.values()).reverse();
      for (const s of LIST_STATES) {
        for (const job of newestFirst) {
          if (out.length >= LIST_MAX) break;
          if (job.state === s && ownsJob(authCtx, job.data)) out.push({job: record(job), state: job.state});
        }
      }
      return process.nextTick(callback, null, out);
    },

    updateJobProgress(jobID, progress) {
      const job = jobs.get(String(jobID));
      if (job != null) job.progress = progress;
    },

    saveJobInfoToRedis(job, state) {
      return common.saveJobInfo(job, state);
    },

    // The timers waiting (tests).
    pendingTimers() { return timers.size; },

    // Timers stopped, schedulers and jobs forgotten (shutdown, tests).
    close() {
      closed = true;
      for (const h of timers) clearTimeout(h.t);
      timers.clear();
      for (const id of Array.from(schedulers.keys())) stopScheduler(id);
      for (const job of jobs.values()) job.cancelled = true;
      jobs.clear();
    }
  };

  function enqueue(name, data, jobOptions, sid, at) {
    const id = String(nextId++);
    const now = Date.now();
    const delay = Math.max(at - now, 0);
    const job = {id, name, data: Object.assign({}, data), opts: Object.assign({}, jobOptions), progress: 0, delay: delay,
      timestamp: now, attemptsMade: 0, failedReason: undefined, stacktrace: [], returnvalue: null,
      finishedOn: undefined, processedOn: undefined, state: (delay > 0) ? 'delayed' : 'waiting',
      schedulerId: sid, cancelled: false, delayTimer: null};
    jobs.set(id, job);
    common.saveJobInfo(job, 'waiting');
    if (delay > 0) job.delayTimer = timerAt(() => { job.delayTimer = null; job.state = 'waiting'; run(job); }, at);
    else setImmediate(() => run(job));
    return job;
  }

  function scheduleRun(id, s, at) {
    const job = enqueue(s.name, s.data, s.opts, id, at);
    s.runs++;
    const more = (s.limit == null) || (s.runs < s.limit);
    if (more) {
      let next;
      try {
        next = (s.pattern != null) ? nextCron(s.pattern, Math.max(at, Date.now())) : at + s.every;
      } catch (e) {
        log('E', e);
        return job;
      }
      s.timer = timerAt(() => { if (schedulers.get(id) === s) scheduleRun(id, s, next); }, next);
    }
    return job;
  }

  // A scheduler stopped, and its runs not yet started removed with it, as
  // BullMQ's removeJobScheduler removes its pending job (review of B5).
  function stopScheduler(id) {
    const s = schedulers.get(id);
    if (s == null) return;
    clear(s.timer);
    schedulers.delete(id);
    for (const job of Array.from(jobs.values())) {
      if (job.schedulerId === id && (job.state === 'delayed' || job.state === 'waiting')) {
        job.cancelled = true;
        clear(job.delayTimer);
        jobs.delete(job.id);
      }
    }
  }

  // A finished job is forgotten after the result TTL; 0 keeps it, as
  // --jobTimeout 0 means none (review of B5).
  function finish(job) {
    job.finishedOn = Date.now();
    const ttl = resultTtlMs();
    if (ttl > 0) timer(() => { if (jobs.get(job.id) === job) jobs.delete(job.id); }, ttl);
  }

  function failed(job, err, extra, retriable) {
    job.attemptsMade++;
    job.stacktrace.push(String(err.stack || err.message).split('\n').slice(0, 10).join('\n'));
    const attempts = (job.opts.attempts != null) ? job.opts.attempts : 1;
    const hook = runner.completionHook;
    if (typeof(hook) === 'function') {
      Promise.resolve().then(() => hook(job.data, null, {extra, error: err})).catch((e) => log('E', e));
    }
    if (retriable && job.attemptsMade < attempts && !job.cancelled) {
      job.state = 'waiting';
      common.saveJobInfo(job, 'waiting');
      return setImmediate(() => run(job));
    }
    job.state = 'failed';
    job.failedReason = err.message;
    common.saveJobInfo(job, 'failed');
    return finish(job);
  }

  function run(job) {
    if (closed || job.cancelled || jobs.get(job.id) !== job) return;
    job.state = 'active';
    job.processedOn = Date.now();
    common.saveJobInfo(job, 'active');
    const ci = runner.cdifInterface;
    const data = job.data;
    runner.authorizeRun(job).then(() => {
      if (job.cancelled) return;
      // the start hook (C's step 3b): its answer goes to invokeJobs and to
      // the completion hook; its errors are logged and ignored
      let extra = null;
      if (typeof(runner.startHook) === 'function') {
        try { extra = runner.startHook(data); } catch (e) { log('E', e); extra = null; }
      }
      const wanted = (job.opts.timeout != null) ? job.opts.timeout : (jobTimeoutMs() > 0 ? jobTimeoutMs() : null);
      const timeoutMs = (wanted != null) ? Math.min(wanted, MAX_TIMER_MS) : null;
      const attempt = {settled: false};
      let t = null;
      if (timeoutMs != null) {
        t = timer(() => {
          attempt.settled = true;
          failed(job, new Error(`Promise timed out after ${timeoutMs} milliseconds`), extra, true);
        }, timeoutMs);
      }
      // a synchronous throw from the dispatch fails the run, as BullMQ's
      // processor turns it into a failure (review of B5)
      try {
      ci.invokeJobs(data.deviceID, data.serviceID, data.actionName, data.input, job.id, (err, results) => {
        if (attempt.settled) return log('I', `job ${String(job.id).slice(0, 32)}: an answer after its timeout, dropped`);
        attempt.settled = true;
        clear(t);
        if (job.cancelled) return;
        if (err != null) {
          const failMessage = (err.code != null) ? `${err.code}: ${err.message}` : err.message;
          return failed(job, new Error(failMessage), extra, !NOT_RETRIED.has(err.code));
        }
        const ownerKey = common.ownerKeyOf(data);
        if (ownerKey != null && typeof(ci.recordCall) === 'function') {
          ci.recordCall(ownerKey, encodeLegacyTool(data.deviceID, data.serviceID, data.actionName), options.mcpToolCallCost,
            (e) => { if (e) log('E', e); });
        }
        const done = () => {
          job.state = 'completed';
          job.returnvalue = results;
          common.saveJobInfo(job, 'completed');
          finish(job);
        };
        const hook = runner.completionHook;
        if (typeof(hook) !== 'function') return done();
        return Promise.resolve().then(() => hook(data, results, {extra}))
          .then((merged) => { if (merged != null) job.data = Object.assign({}, job.data, merged); })
          .catch((e) => log('E', e))
          .then(done);
      }, () => attempt.settled || job.cancelled, Object.assign({}, extra, runBookkeeping(common.ownerKeyOf(data), timeoutMs)));
      } catch (dispatchErr) {
        if (attempt.settled) return;
        attempt.settled = true;
        clear(t);
        failed(job, (dispatchErr instanceof Error) ? dispatchErr : new Error(String(dispatchErr)), extra, true);
      }
    }, (err) => failed(job, err, null, err.retry !== false));
  }

  return runner;
}

module.exports = Object.assign(createRunner(), {createRunner: createRunner});
