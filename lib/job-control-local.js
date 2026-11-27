'use strict';
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
// --jobTimeout, fails it (JOB_TIMEOUT, "JOB_TIMEOUT: <text>") and an
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
// a job outlives the request that queued it: its runs are scheduled outside
// that request's store, so its lookups are never counted against the
// request's address (lib/unauth-limit.js)
const {outsideRequest} = require('./unauth-limit');
const soon = (fn) => outsideRequest(() => setImmediate(fn));
// a job's session, kept in memory by the job's key, never in its data
const jobSessions = require('./job-sessions');
// a 2026-07-28 task's changes, for the listen hub (M16)
const taskEvents = require('./task-events');
const sessionOfCtx = common.sessionOfCtx;
const withRunBookkeeping = common.withRunBookkeeping;
const {MAX_TIMER_MS, jobOptsError, INTERNAL, schedulerId, ownsJob, denied} = common;
const encodeLegacyTool = require('./metering/provider').encodeLegacyTool;

const LIST_STATES = ['waiting', 'active', 'delayed', 'completed', 'failed'];
const LIST_MAX = 50;
const DEFAULT_RESULT_TTL_MS = 3600 * 1000;

const record = common.jobRecord;

function nextCron(pattern, after) {
  const {CronExpressionParser} = require('cron-parser');
  return CronExpressionParser.parse(pattern, {currentDate: new Date(after)}).next().getTime();
}

// the next run: `every` after this one, or, when the clock passed that
// already, `every` after now (one catch-up run, then a whole period, never
// two runs close together on the old grid -- the medium on this PR, 5)
function nextSlot(at, every, now) {
  const first = at + every;
  return (first >= now) ? first : now + every;
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
      h.t = outsideRequest(() => setTimeout(() => {
        timers.delete(h);
        if (Date.now() < at) { timers.add(h); return arm(); }
        return fn();
      }, Math.min(Math.max(left, 0), maxTimerMs)));
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
    // cancelHook(jobData, {extra, jobId}): a pass close() ended without an
    // answer, synchronously (B-shutdown-usage: its usage call is cancelled)
    cancelHook: null,
    // a 2026-07-28 task's question (M22, lib/task-asks.js, through the
    // gateway's jobHooks().ask): {before, asked, settled, holdMs}
    askHooks: null,
    cdifInterface: null,
    authorizeRunMs: 10000,

    setCompletionHook(fn) { runner.completionHook = fn; },
    setStartHook(fn) { runner.startHook = fn; },
    // a pass that ended with no answer to come: its usage call closed (F2-2)
    setEndHook(fn) { runner.endHook = fn; },
    setCancelHook(fn) { runner.cancelHook = fn; },
    setAskHooks(hooks) { runner.askHooks = hooks; },

    // A task whose last pass asked, and whose question is answered: run
    // again under the same id (M22). -> Promise of whether it was started:
    // false for a job that is gone (cancelled) or not waiting on a question.
    rerunTask(id) {
      const job = jobs.get(String(id));
      if (job == null || job.cancelled || job.state !== 'completed' || job.data == null || job.data.asking == null) return Promise.resolve(false);
      clear(job.holdTimer);
      job.holdTimer = null;
      job.state = 'waiting';
      job.finishedOn = undefined;
      common.saveJobInfo(job, 'waiting');
      soon(() => run(job));
      return Promise.resolve(true);
    },

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
      if (jobOpts == null) return callback(new CountinghouseError('JOB_OPTS_INVALID', 'must have opts to add a job'));
      if (jobOpts.name == null) return callback(new CountinghouseError('JOB_OPTS_INVALID', 'job must have a name'));
      const boundsError = jobOptsError(jobOpts);
      if (boundsError != null) return callback(new CountinghouseError('JOB_OPTS_INVALID', boundsError));
      const name = jobOpts.name;
      const jobOptions = {attempts: jobOpts.attempts, delay: jobOpts.delay, timeout: jobOpts.timeout};
      // the owner by opaque id, never the key, made known to the identity
      // index first (job-control-common's ownerData; B-meter-keys (2)); the
      // add goes on outside the promise, so a throw in it stays an exception
      return common.addWhenOwned(authCtx, callback, addOwned);
      function addOwned(owner, callback) {
      const data = Object.assign({deviceID, serviceID, actionName, input}, owner);
      // a 2026-07-28 task's (M15): its result is shaped, and stamped, for that era
      if (jobOpts.era === 'modern') data.era = 'modern';
      // whether its request declared form elicitation: its handler may ask (M22)
      if (jobOpts.era === 'modern' && jobOpts.asks === true) data.asks = true;
      if (jobOpts.repeat != null) {
        const id = schedulerId(authCtx, name);
        // a re-upsert: the entry as it was survives stopping the old scheduler,
        // then the new request's session takes it (job-sessions replace)
        const before = jobSessions.entryOf(id);
        if (schedulers.has(id)) stopScheduler(id);
        jobSessions.putBack(id, before);
        let first;
        try {
          first = (jobOpts.repeat.cron != null) ? nextCron(jobOpts.repeat.cron, Date.now()) : Date.now();
        } catch (e) {
          jobSessions.forget(id);   // no scheduler of that id is left
          return callback(new CountinghouseError('ADD_JOB_ERROR', e.message));
        }
        const s = {name, data, opts: jobOptions, every: jobOpts.repeat.every, pattern: jobOpts.repeat.cron,
          limit: jobOpts.repeat.limit, runs: 0, timer: null, session: sessionOfCtx(authCtx)};
        schedulers.set(id, s);
        // its session, for every run of it, set before the first can start
        jobSessions.replace(id, sessionOfCtx(authCtx));
        const job = scheduleRun(id, s, first);
        return process.nextTick(callback, null, {id: job.id});
      }
      // the id (B5 Task 2): a 2026-07-28 task's minted one (M15; checked by
      // jobOptsError), never one a job already has; else, in a shared
      // runtime, one of its own (s- and 128 random bits); else the runner's
      // counting one
      if (jobOpts.taskId != null && jobs.has(jobOpts.taskId)) return callback(new CountinghouseError('ADD_JOB_ERROR', 'a task with that id exists'));
      const chosen = jobOpts.taskId != null ? jobOpts.taskId : (require('./sessions').shared() === true ? `s-${require('crypto').randomBytes(16).toString('hex')}` : null);
      const job = enqueue(name, data, jobOptions, null, Date.now() + ((jobOptions.delay > 0) ? jobOptions.delay : 0), chosen, sessionOfCtx(authCtx));
      // set before its run can start (enqueue starts it on setImmediate at the soonest)
      if (sessionOfCtx(authCtx) != null) jobSessions.remember(job.id, sessionOfCtx(authCtx));
      return process.nextTick(callback, null, {id: job.id});
      }
    },

    getJob(authCtx, id, callback) {
      if (options.workerThread !== true) return callback(new CountinghouseError('GET_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
      const job = jobs.get(String(id));
      // a job the caller's session doesn't see is an id never issued (B5 Task 2)
      if (job == null || !common.seesJob(authCtx, job.session)) return process.nextTick(callback, new CountinghouseError('JOB_NOT_FOUND'));
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
      if (name == null) return callback(new CountinghouseError('JOB_OPTS_INVALID', 'job must have a name'));
      if (isRepeat == null || typeof(isRepeat) !== 'boolean') return callback(new CountinghouseError('JOB_OPTS_INVALID', 'must pass in isRepeat boolean flag'));
      if (isRepeat === false) {
        const job = jobs.get(String(jobID));
        if (job == null || !common.seesJob(authCtx, job.session)) return process.nextTick(callback, new CountinghouseError('JOB_NOT_FOUND'));
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
        // (a task between two of its passes: its question's record and slot
        // go with it -- F2-2's medium)
        settleAsk(job);
        if (job.schedulerId == null) jobSessions.forget(job.id);   // it will not run
        else if (exhausted(job.schedulerId)) jobSessions.forget(job.schedulerId);   // a limited scheduler's last
        common.saveJobInfo(job, 'removed');
        return process.nextTick(callback, null, {removed: true});
      }
      // the owner's scheduler, then (an admin) the bare name, as
      // job-control.js looks them up
      const candidates = [schedulerId(authCtx, name)];
      if (authCtx !== INTERNAL && authCtx.isAdmin === true && schedulerId(authCtx, name) !== name) candidates.push(name);
      const found = candidates.find((c) => c != null && schedulers.has(c));
      if (found == null) return process.nextTick(callback, new CountinghouseError('JOB_NOT_FOUND'));
      stopScheduler(found);
      return process.nextTick(callback, null, {removed: true});
    },

    listJobs(authCtx, callback) {
      if (options.workerThread !== true) return callback(new CountinghouseError('GET_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
      if (authCtx !== INTERNAL && (authCtx == null || authCtx.appKey == null)) return callback(denied(authCtx));
      // newest first within each state, LIST_MAX of the caller's a state,
      // as job-control lists Redis's; one left out is said ({truncated}, the
      // third argument: the medium on #531's round, 2). In memory, nothing
      // bounds what is read.
      const out = [];
      let truncated = false;
      const newestFirst = Array.from(jobs.values()).reverse();
      for (const s of LIST_STATES) {
        let mine = 0;
        for (const job of newestFirst) {
          if (!(job.state === s && common.seesJob(authCtx, job.session) && ownsJob(authCtx, job.data))) continue;
          if (mine >= LIST_MAX) { truncated = true; break; }
          out.push({job: record(job), state: job.state});
          mine += 1;
        }
      }
      return process.nextTick(callback, null, out, {truncated});
    },

    updateJobProgress(jobID, progress) {
      const job = jobs.get(String(jobID));
      if (job == null) return;
      job.progress = progress;
      taskEvents.emit(job.id, 'progress');
    },

    saveJobInfoToRedis(job, state) {
      return common.saveJobInfo(job, state);
    },

    // The timers waiting (tests).
    pendingTimers() { return timers.size; },

    // A session has ended (B5 Task 4, lib/sessions.js close): nothing runs
    // that no one can read. Its schedulers stop, with their runs not yet
    // started; of its jobs, one waiting or delayed is removed (it never
    // runs, and costs nothing), a finished one's record and result go now,
    // and an active one runs to its end, as tasks/cancel leaves one
    // (cooperative): billed and recorded under the session as any run is,
    // never retried, and its record gone once it finishes (one that hasn't
    // reached a worker yet never starts). A job of no session, or of
    // another, is untouched. -> {removed, finishing}
    cancelSession(session) {
      const out = {removed: 0, finishing: 0};
      if (typeof(session) !== 'string' || session === '') return out;
      for (const [id, s] of Array.from(schedulers)) if (s.session === session) stopScheduler(id);
      for (const job of Array.from(jobs.values())) {
        if (job.session !== session) continue;
        if (job.state === 'active') {
          job.sessionEnded = true;
          out.finishing++;
          continue;
        }
        if (job.state === 'waiting' || job.state === 'delayed') {
          job.cancelled = true;
          clear(job.delayTimer);
          common.saveJobInfo(job, 'removed');
        }
        // one held on its question (M22): its record goes, as a cancel's does
        clear(job.holdTimer);
        job.holdTimer = null;
        settleAsk(job);
        jobs.delete(job.id);
        if (job.schedulerId == null) jobSessions.forget(job.id);
        out.removed++;
      }
      return out;
    },

    // Timers stopped, schedulers and jobs forgotten (shutdown, tests). A
    // pass still running is ended: its answer, if one comes, is dropped, and
    // the cancel hook ends its usage call (B-shutdown-usage).
    close() {
      closed = true;
      for (const h of timers) clearTimeout(h.t);
      timers.clear();
      for (const id of Array.from(schedulers.keys())) stopScheduler(id);
      for (const job of jobs.values()) {
        job.cancelled = true;
        if (job.schedulerId == null) jobSessions.forget(job.id);   // their sessions' entries too
        const pass = job.pass;
        if (pass != null && !pass.attempt.settled) {
          pass.attempt.settle();
          // (its call, if open, ended as cancelled -- once: the close-once
          // helper's; between two passes none is open; #487 on #488)
          pass.call.cancel(String(job.id));
        }
        job.pass = null;
      }
      jobs.clear();
    }
  };

  // owner: the session that made the job (B5 Task 2), in memory only: never
  // in its data or its record (jobRecord copies named fields)
  function enqueue(name, data, jobOptions, sid, at, chosenId = null, owner = null) {
    const id = (chosenId != null) ? chosenId : (require('./sessions').shared() === true ? `s-${require('crypto').randomBytes(16).toString('hex')}` : String(nextId++));
    const now = Date.now();
    const delay = Math.max(at - now, 0);
    const job = {id, name, data: Object.assign({}, data), opts: Object.assign({}, jobOptions), progress: 0, delay: delay,
      timestamp: now, attemptsMade: 0, failedReason: undefined, stacktrace: [], returnvalue: null,
      finishedOn: undefined, processedOn: undefined, state: (delay > 0) ? 'delayed' : 'waiting',
      schedulerId: sid, cancelled: false, delayTimer: null};
    Object.defineProperty(job, 'session', {value: owner, enumerable: false});
    jobs.set(id, job);
    common.saveJobInfo(job, 'waiting');
    if (delay > 0) job.delayTimer = timerAt(() => { job.delayTimer = null; job.state = 'waiting'; run(job); }, at);
    else soon(() => run(job));
    return job;
  }

  // a scheduler whose repeat limit has run out, with no run of it left to start
  function exhausted(id) {
    const s = schedulers.get(id);
    if (s == null) return true;
    if (s.limit == null || s.runs < s.limit) return false;
    for (const job of jobs.values()) if (job.schedulerId === id && (job.state === 'delayed' || job.state === 'waiting' || job.state === 'active')) return false;
    return true;
  }

  function scheduleRun(id, s, at) {
    const job = enqueue(s.name, s.data, s.opts, id, at, null, s.session || null);
    s.runs++;
    const more = (s.limit == null) || (s.runs < s.limit);
    if (more) {
      let next;
      try {
        // (`every`: the first slot that isn't in the past. After the wall
        // clock jumps ahead -- a suspend, a paused VM -- the slots it passed
        // are skipped, not each run at once in a burst: the final pass's
        // gateway part, A10)
        next = (s.pattern != null) ? nextCron(s.pattern, Math.max(at, Date.now())) : nextSlot(at, s.every, Date.now());
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
    jobSessions.forget(id);
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
    // a task that asked is done with its question (M22)
    if (job.data != null && job.data.asking != null) {
      const hooks = runner.askHooks;
      if (hooks != null) Promise.resolve().then(() => hooks.settled(job.data, job.id)).catch((e) => log('E', e));
      job.data = Object.assign({}, job.data);
      delete job.data.asking;
    }
    if (job.schedulerId == null) jobSessions.forget(job.id);   // a one-off job's last run
    else if (exhausted(job.schedulerId)) jobSessions.forget(job.schedulerId);   // a scheduler's last
    // a run its session ended under: no one is left to read it (B5 Task 4)
    if (job.sessionEnded === true) { if (jobs.get(job.id) === job) jobs.delete(job.id); return; }
    const ttl = resultTtlMs();
    if (ttl > 0) timer(() => { if (jobs.get(job.id) === job) jobs.delete(job.id); }, ttl);
  }

  // A run's time limit: its job's own timeout, else --jobTimeout; null for
  // none. A run that starts again for a question no form could be shown
  // for, or that found no room, is the same run, as BullMQ runs those
  // passes within one run: its limit counts from the start of the pass that
  // began it (job.chainStartedAt) -- one rule in both runners (F2-2's
  // medium, ruled).
  function limitOf(job) {
    return common.runLimitMs(job.opts, jobTimeoutMs());
  }
  // err: the job's stored failure (its message the failure text); answered:
  // the error the call answered with, handed to the completion hook as the
  // BullMQ runner hands it, so the usage record keeps its code and kind (it
  // was the stored text's plain Error: NO_CODE)
  function failed(job, err, extra, retriable, answered = err) {
    job.chainStartedAt = null;
    job.attemptsMade++;
    job.stacktrace.push(String(err.stack || err.message).split('\n').slice(0, 10).join('\n'));
    const attempts = (job.opts.attempts != null) ? job.opts.attempts : 1;
    const hook = runner.completionHook;
    if (typeof(hook) === 'function') {
      Promise.resolve().then(() => hook(job.data, null, {extra, error: answered, jobId: String(job.id)})).catch((e) => log('E', e));
    }
    if (retriable && job.attemptsMade < attempts && !job.cancelled && job.sessionEnded !== true) {
      job.state = 'waiting';
      common.saveJobInfo(job, 'waiting');
      return soon(() => run(job));
    }
    job.state = 'failed';
    job.failedReason = err.message;
    common.saveJobInfo(job, 'failed');
    finish(job);
    return taskEvents.emit(job.id, 'failed');
  }

  // The pass ended on its question (M22): not billed, no attempt spent, and
  // the job is kept, completed with no result and marked asking, while the
  // question waits (job.data.asking: the passes that asked); the task reads
  // input_required from its record. Or, when no form can be shown, the
  // run starts again at once, its ctx.ask ASK_UNAVAILABLE.
  //   call       this pass's usage call (common.passCall: closed once,
  //              ruled M1 on #487; the gateway's asked hook's own close
  //              counts -- it closed the call when it wrote the question)
  //   attempt    this pass's deadline (run()): still armed while the
  //              question is written; settled here, on every branch
  function askedPass(job, state, call, runSession, attempt) {
    const hooks = runner.askHooks;
    const data = job.data;
    // (whether a branch below has ended the job -- set once it has: a throw
    // after that fails nothing again)
    let ended = false;
    return Promise.resolve().then(() => hooks.asked(data, job.id, state, {extra: call.extra(), session: runSession.session})).then((r) => {
      if (r != null && r.asked != null) call.closedByAsk();
      // (the run timed out while its question was written -- its failure took
      // the pass's call, or one of its own: its question goes, and nothing
      // more is marked, as BullMQ's run; a retry already asking could lose
      // its own, the listed limit (d). One that failed for good is done with
      // its question whatever the hook wrote, as BullMQ's last attempt is:
      // settled here unless finish() settled it, a job marked asking -- read
      // from this pass's data: finish() leaves job.data unmarked.)
      if (attempt.timedOut) {
        if ((r != null && r.asked != null) || (job.state === 'failed' && data.asking == null)) settleAsk(job);
        ended = true;
        return undefined;
      }
      attempt.settle();
      // removed meanwhile, or its session ended while it ran (B5 Task 4):
      // its question goes with it, and its slot (the review of #374, L2),
      // and this pass's usage call is closed (F2-2's medium)
      if (job.cancelled || jobs.get(job.id) !== job) {
        call.close('cancelled');
        settleAsk(job);
        ended = true;
        return undefined;
      }
      if (job.sessionEnded === true) {
        call.close('cancelled');
        settleAsk(job);
        finish(job);
        ended = true;
        return undefined;
      }
      // cancelled while it ran (its tombstone; the hook took the record):
      // it ends as a run cancelled while running does, unread
      if (r != null && r.cancelled === true) {
        call.close('cancelled');
        job.state = 'completed';
        job.returnvalue = null;
        common.saveJobInfo(job, 'completed');
        finish(job);
        ended = true;
        return undefined;
      }
      job.data = Object.assign({}, job.data, {asking: (Number.isInteger(job.data.asking) ? job.data.asking : 0) + 1});
      // no form could be shown, or no room: this pass's usage call closed,
      // and the run starts again at once (run() starts the next pass's own
      // call), bounded by the run's limit from the chain's first pass
      if (r != null && r.rerun === true) {
        call.close('unavailable');
        job.state = 'waiting';
        common.saveJobInfo(job, 'waiting');
        if (job.chainStartedAt == null) job.chainStartedAt = job.passStartedAt;
        return soon(() => run(job));
      }
      job.chainStartedAt = null;
      job.state = 'completed';
      job.returnvalue = null;
      job.finishedOn = Date.now();
      common.saveJobInfo(job, 'completed');
      hold(job);
      // its listeners hear it waits on its question (M16)
      return taskEvents.emit(job.id, 'input_required');
    }).catch((e) => {
      // (a job ended meanwhile -- by a branch above, removed, cancelled, its
      // run timed out -- is not failed again: its pass's call closed if
      // still open, the error logged; any other is failed on the pass's call
      // or one of its own)
      if (ended || attempt.timedOut || job.cancelled || jobs.get(job.id) !== job) {
        call.close('cancelled');
        return log('E', e);
      }
      attempt.settle();
      return failed(job, (e instanceof Error) ? e : new Error(String(e)), call.failure(), false);
    });
  }
  // A task's question goes: its record and its slot (M22). For a job that
  // may have asked: a modern task whose request could be asked.
  function settleAsk(job) {
    const hooks = runner.askHooks;
    if (hooks == null || job.data == null || job.data.era !== 'modern' || job.data.asks !== true) return undefined;
    return Promise.resolve().then(() => hooks.settled(job.data, job.id)).catch((e) => log('E', e));
  }

  // kept while its question can wait; past that the task has failed,
  // ASK_EXPIRED (no result: never the answered call's), and the job is
  // forgotten as a finished job is
  function hold(job) {
    const ms = common.holdMsOf(runner.askHooks);
    clear(job.holdTimer);
    job.holdTimer = timer(() => {
      job.holdTimer = null;
      if (jobs.get(job.id) !== job || job.state !== 'completed' || job.data.asking == null) return;
      job.state = 'failed';
      job.failedReason = `ASK_EXPIRED: ${new CountinghouseError('ASK_EXPIRED').message}`;
      common.saveJobInfo(job, 'failed');
      finish(job);
    }, ms);
  }

  function run(job) {
    if (closed || job.cancelled || jobs.get(job.id) !== job) return;
    job.state = 'active';
    job.processedOn = Date.now();
    job.passStartedAt = job.processedOn;
    common.saveJobInfo(job, 'active');
    taskEvents.emit(job.id, 'active');
    const ci = runner.cdifInterface;
    const data = job.data;
    const hooks = runner.askHooks;
    // a pass of a run started again within itself (no form shown, or no room)
    const rerun = job.chainStartedAt != null;
    // the job's session and values for this run (B1 Task 3), read once its
    // owner check has passed: by its scheduler for a repeating job's run,
    // else by its own id
    let runSession = {session: null, limits: null};
    // the owner's key as authorizeRun resolved it: it bills the run even if
    // the owner leaves the index meanwhile (B-meter-keys (2); #518's high,
    // L1)
    let runOwnerKey = null;
    const sessionOfRun = () => jobSessions.forRun(job.schedulerId != null ? job.schedulerId : job.id);
    // this pass's usage call (C's step 3b; closed once, common.passCall)
    const call = common.passCall(runner, data, () => runSession.session, (e) => log('E', e));
    // This pass's deadline: the run's limit (limitOf), as BullMQ's run
    // counts it -- from its first pass's dispatch (the owner check before it
    // has its own deadline, authorizeRunMs), and for a run started again
    // within itself from that first pass (job.chainStartedAt): one chain
    // deadline, armed across each later pass's owner check, before and
    // dispatch and every asked write. Past it the run fails JOB_TIMEOUT, a
    // failure like any other (retried as its attempts allow), on the pass's
    // call or one of its own (#487's high, round 2).
    const timeoutMs = limitOf(job);
    let deadlineAt = null;
    const attempt = {settled: false, timedOut: false, timer: null,
      settle: () => { attempt.settled = true; clear(attempt.timer); }};
    const timedOut = () => {
      if (attempt.settled) return undefined;
      attempt.settled = true;
      attempt.timedOut = true;
      clear(attempt.timer);
      return failed(job, common.timeoutError(timeoutMs), call.failure(), true);
    };
    const arm = (from) => {
      if (timeoutMs == null) return;
      deadlineAt = from + timeoutMs;
      attempt.timer = timer(timedOut, Math.max(0, deadlineAt - Date.now()));
    };
    if (rerun) arm(job.chainStartedAt);
    // the pass running now, for close() (B-shutdown-usage)
    Object.defineProperty(job, 'pass', {value: {attempt, call}, writable: true, configurable: true, enumerable: false});
    // (the owner checked again before every pass, of a run started again too
    // (#487's high, round 2): a refusal there fails the run with a call of
    // its own; a refusal before a run's first pass, with none, as before)
    // (a pass of a run started again has its session already, its owner
    // checked before the chain's first pass: a failure before its own check
    // passes -- a refusal, the deadline -- is recorded with it, as BullMQ's;
    // read inside the chain, so a throw there fails the run)
    Promise.resolve().then(() => { if (rerun) runSession = sessionOfRun(); }).then(() => Promise.resolve().then(() => runner.authorizeRun(job)).then((key) => {
      // (an owned job whose key didn't come back: refused for good, its
      // scheduler stopped, as authorizeRun's own final refusal)
      try { runOwnerKey = common.ownerKeyAuthorized(data, key); } catch (e) { if (job.schedulerId != null) stopScheduler(job.schedulerId); throw e; }
      // (billed to its owner: refused, retryably, while the charge can't be recorded)
      return common.chargeableRun(ci, runOwnerKey);
    }).then(() => ((hooks != null && data != null && data.era === 'modern') ? Promise.resolve().then(() => hooks.before(data, job.id, {rerun})).catch((e) => {
      // (a before that fails -- a read of the record or the tombstone -- is
      // {error}: the run fails with a call of its own and runs nothing, a
      // failure retried as its attempts allow; #487's high, rounds 1 and 2)
      log('E', e);
      return {error: (e instanceof Error) ? e : new Error(String(e))};
    }) : null), (e) => ({refused: (e instanceof Error) ? e : new Error(String(e))}))).then((asks) => {
      if (attempt.settled) return undefined;
      if (asks != null && asks.refused != null) {
        attempt.settle();
        return failed(job, asks.refused, rerun ? call.failure() : null, asks.refused.retry !== false);
      }
      if (job.cancelled || jobs.get(job.id) !== job) return attempt.settle();
      // its session ended before it reached a worker: it never starts (B5
      // Task 4), and its question, if it asked one, goes with it (M22)
      if (job.sessionEnded === true) {
        attempt.settle();
        if (jobs.get(job.id) === job) jobs.delete(job.id);
        if (job.schedulerId == null) jobSessions.forget(job.id);
        else if (exhausted(job.schedulerId)) jobSessions.forget(job.schedulerId);
        settleAsk(job);
        return common.saveJobInfo(job, 'removed');
      }
      if (!rerun) runSession = sessionOfRun();
      // started again with its question not answered (its record gone or
      // still waiting): nothing runs, and the job is as it was
      if (asks != null && asks.skip === true) {
        attempt.settle();
        job.chainStartedAt = null;
        // (cancelled meanwhile -- its tombstone, read before anything runs:
        // it ends as a run cancelled while running does, with no call
        // opened; #487's high, round 1)
        if (asks.cancelled === true) {
          job.state = 'completed';
          job.returnvalue = null;
          common.saveJobInfo(job, 'completed');
          return finish(job);
        }
        job.state = 'completed';
        common.saveJobInfo(job, 'completed');
        // (a hold that can't be made fails the run, with a call of its own:
        // never a job held by nothing)
        try { hold(job); } catch (e) {
          return failed(job, (e instanceof Error) ? e : new Error(String(e)), call.failure(), false);
        }
        // its run() told active: the task is back to waiting (M16)
        return taskEvents.emit(job.id, 'input_required');
      }
      if (asks != null && asks.error != null) {
        attempt.settle();
        return failed(job, asks.error, call.failure(), true);
      }
      // (a run's first pass: its deadline from here, its dispatch; a later
      // pass already past it is never dispatched with a millisecond left)
      if (!rerun) {
        job.passStartedAt = Date.now();
        arm(job.passStartedAt);
      } else if (deadlineAt != null && Date.now() >= deadlineAt) return timedOut();
      const askState = (asks != null && asks.state != null) ? asks.state : null;
      const extra = call.open();
      // (the worker is told the time left: never 0, which it reads as no
      // limit at all; a first pass, its whole limit, as before)
      const passMs = (deadlineAt != null && rerun) ? Math.max(1, deadlineAt - Date.now()) : timeoutMs;
      // a synchronous throw from the dispatch fails the run, as BullMQ's
      // processor turns it into a failure (review of B5)
      try {
      ci.invokeJobs(data.deviceID, data.serviceID, data.actionName, data.input, job.id, (err, results) => {
        if (attempt.settled) return log('I', `job ${String(job.id).slice(0, 32)}: an answer after its timeout, dropped`);
        if (job.cancelled) return attempt.settle();
        // ended on its question: only by the main thread's own record of it
        // (its deadline still armed while the question is written)
        if (err != null && err.code === 'ASK_PENDING' && askState != null && askState.pending != null) return askedPass(job, askState, call, runSession, attempt);
        attempt.settle();
        job.chainStartedAt = null;
        if (err != null) {
          // (a 2026-07-28 task's answered call is marked: failureText)
          const failMessage = common.failureText(err, data);
          return failed(job, new Error(failMessage), call.failure(), !common.notRetried(err.code, err), err);
        }
        const ownerKey = runOwnerKey;
        if (ownerKey != null && typeof(ci.recordCall) === 'function') {
          const meteredTool = encodeLegacyTool(data.deviceID, data.serviceID, data.actionName);
          // (lost after the run: said by the key's fingerprint, the tool and the amount)
          ci.recordCall(ownerKey, meteredTool, options.mcpToolCallCost,
            (e) => { if (e) log('E', require('./metering/charge-bound').chargeLost(meteredTool, ownerKey, options.mcpToolCallCost, e)); }, {session: runSession.session});
        }
        const done = () => {
          job.state = 'completed';
          job.returnvalue = results;
          common.saveJobInfo(job, 'completed');
          finish(job);
          taskEvents.emit(job.id, 'completed');
        };
        const hook = runner.completionHook;
        if (typeof(hook) !== 'function') return done();
        return Promise.resolve().then(() => hook(data, results, {extra, session: runSession.session, jobId: String(job.id)}))
          .then((merged) => { if (merged != null) job.data = Object.assign({}, job.data, merged); })
          .catch((e) => log('E', e))
          .then(done);
      }, () => attempt.settled || job.cancelled, Object.assign(withRunBookkeeping(extra, runOwnerKey, passMs, runSession), askState != null ? {ask: askState} : {},
        // a run's last progress, onto the job this runner holds (F4-3)
        {progressTo: (p) => { if (!attempt.settled && !job.cancelled) job.progress = p; }}));
      } catch (dispatchErr) {
        if (attempt.settled) return;
        attempt.settle();
        failed(job, (dispatchErr instanceof Error) ? dispatchErr : new Error(String(dispatchErr)), call.failure(), true);
      }
      return undefined;
    }).catch((e) => {
      // (a throw in the steps above before the pass is settled -- not a
      // refusal or a read, answered above -- fails the run on a call; a throw
      // from the runner's own bookkeeping once settled (saveJobInfo, failed)
      // is only logged, as on master)
      log('E', e);
      if (attempt.settled) return;
      attempt.settle();
      try { failed(job, (e instanceof Error) ? e : new Error(String(e)), call.failure(), false); } catch (x) { log('E', x); }
    });
  }

  return runner;
}

module.exports = Object.assign(createRunner(), {createRunner: createRunner, nextSlotFor: nextSlot});
