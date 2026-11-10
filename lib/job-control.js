const url         = require('url');
const async       = require('async');
const Queue       = require('bullmq').Queue;
const Worker      = require('bullmq').Worker;
const QueueEvents = require('bullmq').QueueEvents;
const UnrecoverableError = require('bullmq').UnrecoverableError;

// The longest delay setTimeout honours.
const MAX_TIMER_MS = 2147483647;

// Job failures bullmq must not retry (see the processor's reject path): the
// module is gone until an operator acts.
const NOT_RETRIED = new Set(['MODULE_UNLOADED', 'MODULE_SUSPENDED']);

// What one add-job may ask for. A job's runs are not rate limited -- only
// creating it is (lib/routes/add-job.js, lib/mcp/gateway.js) -- so these keep
// one rate-limited request from becoming unbounded work: a repeating job at
// most once a second, and at most 10 attempts. A cron pattern's finest step
// is a second, so it needs no check of its own.
const MIN_REPEAT_EVERY_MS = 1000;
const MAX_ATTEMPTS        = 10;

function isWhole(n) {
  return typeof(n) === 'number' && Number.isInteger(n);
}

function jobOptsError(jobOpts) {
  if (jobOpts.attempts != null && !(isWhole(jobOpts.attempts) && jobOpts.attempts >= 1 && jobOpts.attempts <= MAX_ATTEMPTS)) {
    return `attempts must be a whole number from 1 to ${MAX_ATTEMPTS}`;
  }
  const repeat = jobOpts.repeat;
  if (repeat == null) return null;
  if (typeof(repeat) !== 'object') return 'repeat must be an object with every or cron';
  if (repeat.cron != null) {
    if (typeof(repeat.cron) !== 'string') return 'repeat.cron must be a cron pattern string';
  } else if (!(isWhole(repeat.every) && repeat.every >= MIN_REPEAT_EVERY_MS)) {
    return `repeat.every must be a whole number of milliseconds, at least ${MIN_REPEAT_EVERY_MS}`;
  }
  if (repeat.limit != null && !(isWhole(repeat.limit) && repeat.limit >= 1)) return 'repeat.limit must be a whole number, at least 1';
  return null;
}
const options     = require('./cli-options');
const LOG         = require('./logger');
const CountinghouseError = require('./countinghouse-error').CountinghouseError;

const redisAPI       = require('./redis-api');
const encodeLegacyTool = require('./metering/redis-provider').encodeLegacyTool;

//NOTE: the methods in this object should be called in main thread only, do not call them in the context of workers

// --- job ownership (S1/S5) ---
//
// Every job records the apiKey that created it (jobData.apiKey, set from the
// *authenticated* identity by addJob below -- never from anything the
// requester supplied, see addJob's own comment). Every read/mutate entry
// point then takes an `authCtx` as its FIRST argument and refuses to touch a
// job the caller doesn't own.
//
// The check lives here rather than in lib/mcp/gateway.js because there are
// two independent front doors onto the same jobs -- the MCP tasks/* methods
// and the HTTP /devices/:deviceID/{get,remove}-job(-history) routes. Gating
// only the gateway would leave the HTTP routes as a bypass (exactly the
// shape of the gap docs/cross-cutting-matrix.md exists to prevent), so the
// gate is put at the single point both funnel through.
//
// authCtx is one of:
//   {appKey: <string>, isAdmin: <bool>}  a tenant-originated request
//   JobControl.INTERNAL                   platform-internal call (see below)
//
// Anything else -- null, undefined, a missing appKey -- is denied. Fail
// closed: an unauthenticated caller has no owner identity to match against,
// so it can never match one.
const INTERNAL = {internal: true};

// A repeatable job's scheduler id: the caller's name, scoped to its owner.
// The id was the raw name in one shared queue, and bullmq upserts schedulers
// with override, so another tenant posting the same name replaced the first
// tenant's scheduler, its later runs then owned and billed to the second
// (review R3-2). A hash, so the id never carries the key itself.
function schedulerId(authCtx, name) {
  if (authCtx === INTERNAL || authCtx == null || authCtx.appKey == null) return name;
  const identity = require('./identity');
  const owner = identity.ready() ? identity.idForKey(authCtx.appKey) : legacyOwner(authCtx);
  return `${owner}:${name}`;
}

// The owner tag schedulers were stored under before the opaque id (an
// unsalted sha256 prefix of the key): still looked up on removal, so a
// scheduler set up before the upgrade is found by its owner.
function legacyOwner(authCtx) {
  return require('crypto').createHash('sha256').update(String(authCtx.appKey)).digest('hex').slice(0, 16);
}
function legacySchedulerId(authCtx, name) {
  if (authCtx === INTERNAL || authCtx == null || authCtx.appKey == null) return null;
  return `${legacyOwner(authCtx)}:${name}`;
}

// A job with no recorded apiKey (created before ownership existed, or by an
// internal path) is owned by nobody, so only an admin can reach it. This is
// deliberate: treating "no owner" as "everyone's" is how the original gap
// behaved, and it is exactly what must not survive this fix.
function ownsJob(authCtx, jobData) {
  if (authCtx === INTERNAL) return true;
  if (authCtx == null || authCtx.appKey == null) return false;
  if (authCtx.isAdmin === true) return true;
  return jobData != null && jobData.apiKey === authCtx.appKey;
}

function denied(authCtx) {
  // Distinguish "you didn't authenticate" from "you authenticated but this
  // isn't yours" -- same distinction lib/user-auth.js already draws between
  // SYSTEM_ERROR_UNKNOWN_USER and USER_HAS_NO_DEVICE.
  if (authCtx == null || authCtx.appKey == null) return new CountinghouseError('SYSTEM_ERROR_UNKNOWN_USER');
  return new CountinghouseError('JOB_ACCESS_DENIED');
}

module.exports = {
  jobQueue: null,

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
  completionHook: null,

  setCompletionHook: function(fn) {
    this.completionHook = fn;
  },

  initJobProcess: function(cdifInterface) {
    this.cdifInterface = cdifInterface;

    const redisUrl = options.redisUrl;
    let urlObj   = null;

    try {
      urlObj = url.parse(redisUrl);
    } catch(e) {
      return LOG.E(new Error(`redis URL parse fail, check redisUrl option: ${err.message}`));
    }

    let password = null;
    if (urlObj.auth != null) {
      password = urlObj.auth.split(':')[1];
    }

    const connection = {db: 11, port: urlObj.port, host: urlObj.hostname, password: password};

    this.jobQueue = new Queue('job-queue', {prefix: '{cdifJob}', connection: connection});

    if (this.jobQueue == null) return LOG.E(new Error('Invalid job queue'));

    this.queueEvents = new QueueEvents('job-queue', {prefix: '{cdifJob}', connection: connection});

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

      // bullmq dropped bull's job-level `opts.timeout` (previously enforced internally
      // via p-timeout); job.opts.timeout is still stored on the job, so re-implement
      // the same "reject after N ms" behavior here to avoid silently losing it
      let timeoutHandle = null;
      // This run of the job. Once its timeout has failed it, bullmq owns the
      // job again (a retry may already be running), so an answer that still
      // arrives from the worker is dropped: not billed, not stamped, nothing
      // written over the retry's data. The worker cannot be told to stop.
      const run = {settled: false};

      return _this.authorizeRun(job).then(() => new Promise((resolve, reject) => {
        // A job's own timeout, else --jobTimeout -- applied here rather than
        // stamped on the job at addJob, so it also bounds jobs queued before
        // the flag existed and scheduler jobs made from templates stored
        // earlier. 0 means none.
        // Clamped to setTimeout's maximum (2^31-1 ms, about 24.8 days): past
        // it the timer fires at once, which would fail the job immediately.
        const wanted = (job.opts != null && job.opts.timeout != null) ? job.opts.timeout
          : (options.jobTimeout > 0 ? options.jobTimeout : null);
        const timeoutMs = (wanted != null) ? Math.min(wanted, MAX_TIMER_MS) : null;
        if (timeoutMs != null) {
          timeoutHandle = setTimeout(() => {
            run.settled = true;
            reject(new Error(`Promise timed out after ${timeoutMs} milliseconds`));
          }, timeoutMs);
        }

        _this.cdifInterface.invokeJobs(deviceID, serviceID, actionName, input, jobID, (err, results) => {
          if (run.settled) return LOG.I(`job ${String(jobID).slice(0, 32)}: an answer after its timeout, dropped`);
          run.settled = true;
          if (timeoutHandle != null) clearTimeout(timeoutHandle);
          //TODO: add results object to result-queue as a job to be able to notify job sender reliably under distributed environment
          if (err != null) {
            // bullmq's Worker only persists a job failure as a plain string
            // (job.failedReason = err.message) -- any other property on the
            // rejected error, including CountinghouseError's locale-
            // independent `code`, is lost once it round-trips through
            // redis. Encode it into the message itself as a "CODE: message"
            // prefix (every CountinghouseError code is an UPPER_SNAKE_CASE
            // identifier, which a real message would not otherwise start
            // with) so lib/mcp/gateway.js's handleTasksResult can recover
            // it -- see the matching decode there.
            const failMessage = (err.code != null) ? (`${err.code}: ${err.message}`) : err.message;
            // A module that is gone stays gone until an operator loads it
            // again: retrying (attempts > 1) could only fail the same way.
            // A reload or a supervised restart is retried as any failure is.
            if (NOT_RETRIED.has(err.code)) return reject(new UnrecoverableError(failMessage));
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
          if (jobData.apiKey != null && typeof(_this.cdifInterface.recordCall) === 'function') {
            // Same canonical metering identity every other entry path uses
            // (see lib/mcp/gateway.js's tools/call comment) rather than
            // job.name, which is the MCP tool name for a task-augmented call
            // but an arbitrary caller-chosen string for an HTTP-submitted job.
            _this.cdifInterface.recordCall(jobData.apiKey, encodeLegacyTool(deviceID, serviceID, actionName),
                                           options.mcpToolCallCost, (err) => {
              if (err) LOG.E(err);
            });
          }

          const hook = _this.completionHook;
          if (typeof(hook) !== 'function') return resolve(results);
          // The full main-side data is written back with the stamp merged
          // in: updateData replaces job.data, and ownership (ownsJob), billing
          // and tasks/result's addressing all read it.
          return Promise.resolve().then(() => hook(jobData))
            .then((extra) => (extra != null ? job.updateData(Object.assign({}, jobData, extra)) : null))
            .catch((e) => LOG.E(e))
            .then(() => resolve(results));
        }, () => run.settled);
      }));
    }), {prefix: '{cdifJob}', connection: connection, concurrency: 1024});
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
    const data = job.data;
    if (data.apiKey == null) return Promise.resolve();
    const userAuth = require('./user-auth');
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        LOG.E(new Error(`job ${String(job.id).slice(0, 32)}: the owner's authorization did not answer within ${this.authorizeRunMs} ms; the run fails and is retried`));
        reject(new Error(`SYSTEM_ERROR_USERDB_NA: ${new CountinghouseError('SYSTEM_ERROR_USERDB_NA').message}`));
      }, this.authorizeRunMs);
      userAuth(null, null, data.deviceID, data.apiKey, data.serviceID, data.actionName, () => {}, (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err == null) return resolve();
        const code = (err.code != null) ? err.code : 'SYSTEM_ERROR_UNKNOWN_USER';
        const failMessage = `${code}: ${new CountinghouseError(code).message}`;
        if (code === 'SYSTEM_ERROR_USERDB_NA') return reject(new Error(failMessage));
        const scheduler = (job.repeatJobKey != null) ? this.jobQueue.removeJobScheduler(job.repeatJobKey) : Promise.resolve();
        return scheduler.catch((e) => LOG.E(e)).then(() => reject(new UnrecoverableError(failMessage)));
      });
    });
  },

  addJob: function(authCtx, jobOpts, deviceID, serviceID, actionName, input, callback) {
    if (options.workerThread !== true) {
      return callback(new CountinghouseError('ADD_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
    }
    if (authCtx !== INTERNAL && (authCtx == null || authCtx.appKey == null)) {
      return callback(denied(authCtx));
    }
    if (jobOpts == null) {
      return callback(new CountinghouseError('ADD_JOB_ERROR', 'must have opts to add a job'));
    }
    if (jobOpts.name == null) {
      return callback(new CountinghouseError('ADD_JOB_ERROR', 'job must have a name'));
    }

    const boundsError = jobOptsError(jobOpts);
    if (boundsError != null) return callback(new CountinghouseError('ADD_JOB_ERROR', boundsError));

    const name = jobOpts.name;
    const opts = {};

    opts.attempts = jobOpts.attempts;   // [Optional] The total number of attempts to try the job until it completes or fail. Defaults to 1
    opts.delay    = jobOpts.delay;      // [Optional] An amount of milliseconds to wait until this job can be processed. Note that for accurate delays, both server and clients should have their clocks synchronized.
    opts.timeout  = jobOpts.timeout;    // [Optional] The number of milliseconds after which the job should be fail with a timeout error

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
      input: input,
      apiKey: (authCtx !== INTERNAL && authCtx != null) ? authCtx.appKey : null
    };

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

      this.jobQueue.upsertJobScheduler(schedulerId(authCtx, name), repeatOpts, {name: name, data: jobData, opts: opts})
      .then((job) => {
        return callback(null, {id: job.id});
      }).catch((err) => {
        return callback(new CountinghouseError('ADD_JOB_ERROR', err.message));
      });
      return;
    }

    this.jobQueue.add(name, jobData, opts)
    .then((job) => {
      return callback(null, {id: job.id});
    }).catch((err) => {
      return callback(new CountinghouseError('ADD_JOB_ERROR', err.message));
    });
  },

  getJob: function(authCtx, id, callback) {
    if (options.workerThread !== true) {
      return callback(new CountinghouseError('GET_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
    }

    const _this = this;

    this.jobQueue.getJob(id).then((job) => {
      if (job == null) return callback(new CountinghouseError('GET_JOB_ERROR', 'unknown job'));

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
            job: {
              id: j.id,
              name: j.name,
              data: j.data,
              opts: j.opts,
              progress: j.progress,
              delay: j.delay,
              timestamp: j.timestamp,
              attemptsMade: j.attemptsMade,
              failedReason: j.failedReason,
              stacktrace: j.stacktrace,
              returnvalue: j.returnvalue,
              finishedOn: j.finishedOn,
              processedOn: j.processedOn,
            },
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
  // Each stored record carries the full job, including job.data.apiKey, so
  // the filter is applied per record -- a caller gets its own history for
  // that name and nothing else, instead of the previous "whoever asks for
  // the name gets every tenant's entries under it" (the in-code TODO this
  // replaces).
  // A {job, state} record as the HTTP job routes return it: without the
  // completion hook's internal outputSchemaHash, so their response shape is
  // the one it was before tasks/result needed the stamp.
  publicRecord: function(record) {
    if (record == null || record.job == null || record.job.data == null || !('outputSchemaHash' in record.job.data)) return record;
    const data = Object.assign({}, record.job.data);
    delete data.outputSchemaHash;
    return Object.assign({}, record, {job: Object.assign({}, record.job, {data: data})});
  },

  getJobHistory: function(authCtx, name, callback) {
    if (authCtx !== INTERNAL && (authCtx == null || authCtx.appKey == null)) {
      return callback(denied(authCtx));
    }

    const jobInfoKey = `jobinfo:${name}`;
    //TODO: make this value configurable
    redisAPI.client.lrange(jobInfoKey, 0, -1, (err, data) => {
      if (err) return callback('GET_JOB_ERROR', err.message);
      if (data == null) return callback('GET_JOB_ERROR', []);

      const keyList = {};
      const jsonRet = [];

      let cap = 0;
      data.forEach((item) => {
        if (cap >= 20) return;

        const parsedItem = JSON.parse(item);
        const jobID = parsedItem.job.id;

        if (ownsJob(authCtx, parsedItem.job.data) !== true) return;

        if (keyList[jobID] == null) {
          keyList[jobID] = parsedItem;
          jsonRet.push(parsedItem);
          cap++;
        }
      });

      return callback(null, jsonRet);
    });
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
      return callback(new CountinghouseError('REMOVE_JOB_ERROR', 'job must have a name'));
    }
    if (isRepeat == null ||typeof(isRepeat) !== 'boolean') {
      return callback(new CountinghouseError('REMOVE_JOB_ERROR', 'must pass in isRepeat boolean flag'));
    }


    if (isRepeat === false) {
      _this.jobQueue.getJob(jobID).then((job) => {
        if (job == null) return callback(new CountinghouseError('REMOVE_JOB_ERROR', 'unknown job'));
        if (ownsJob(authCtx, job.data) !== true) return callback(denied(authCtx));
        // job.remove() returns a promise and *rejects* (rather than resolving
        // false) when the job is currently locked by an active worker -- it
        // must be awaited, otherwise a job stuck mid-processing (e.g. one
        // whose action handler never calls back) silently fails to remove
        // while the caller is told {removed: true}.
        job.remove().then(() => {
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
      // also remove a scheduler created before 8.0.0, whose id is the bare name.
      const legacy = (authCtx !== INTERNAL && authCtx.isAdmin === true && schedulerId(authCtx, name) !== name);
      _this.jobQueue.removeJobScheduler(schedulerId(authCtx, name)).then((removed) => {
        if (removed === true) return true;
        // The owner's scheduler from before the opaque id, if any.
        const before = legacySchedulerId(authCtx, name);
        if (before == null || before === schedulerId(authCtx, name)) return false;
        return _this.jobQueue.removeJobScheduler(before);
      }).then((removed) => {
        if (removed === true) return true;
        return legacy ? _this.jobQueue.removeJobScheduler(name) : false;
      }).then((removed) => {
        if (removed !== true) return callback(new CountinghouseError('REMOVE_JOB_ERROR', 'unknown job'));
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

    this.jobQueue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed'], 0, 49, false)
    .then((jobs) => {
      // Filter before mapping: an unowned job never even gets its state read,
      // and never appears in the result. This is a *filter*, not an error --
      // "list mine" returning an empty list is the correct answer for a
      // caller with no jobs, unlike getJob's "this specific one isn't yours".
      jobs = jobs.filter((job) => { return ownsJob(authCtx, job.data); });

      async.map(jobs, (job, cb) => {
        job.getState().then((state) => {
          cb(null, {
            job: {
              id: job.id, name: job.name, data: job.data, opts: job.opts,
              progress: job.progress, delay: job.delay, timestamp: job.timestamp,
              attemptsMade: job.attemptsMade, failedReason: job.failedReason,
              stacktrace: job.stacktrace, returnvalue: job.returnvalue,
              finishedOn: job.finishedOn, processedOn: job.processedOn,
            },
            state: state
          });
        }).catch((err) => {
          cb(null, null); // skip jobs whose state can't be read rather than failing the whole list
        });
      }, (err, results) => {
        if (err) return callback(new CountinghouseError('GET_JOB_ERROR', err.message));
        return callback(null, results.filter((r) => { return r != null; }));
      });
    }).catch((err) => {
      return callback(new CountinghouseError('GET_JOB_ERROR', err.message));
    });
  },

  updateJobProgress: function(jobID, progress) {
    this.jobQueue.getJob(jobID).then((job) => {
      if (job != null) job.updateProgress(progress);
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
      // LOG.I('job prgress UPDATED: ' + args.jobId + ' : ' + args.data);
      // A job's progress was updated!
      // DO NOT handle this event since we don't know how to write its current state to redis
    });

    this.queueEvents.on('completed', (args) => {
      // LOG.I('job completed: ' + args.jobId);
      // A job successfully completed with a `result`.
      _this.jobQueue.getJob(args.jobId).then((job) => {
        if (job == null) return;
        _this.saveJobInfoToRedis(job, 'completed');
      }).catch((err) => {
        return;
      });
    });

    this.queueEvents.on('failed', (args) => {
      // LOG.I('job failed: ' + args.jobId);
      // A job failed with reason `args.failedReason`!
      _this.jobQueue.getJob(args.jobId).then((job) => {
        if (job == null) return;
        _this.saveJobInfoToRedis(job, 'failed');
      }).catch((err) => {
        return;
      });
    });


  },

  saveJobInfoToRedis: function(job, state) {
    const result = {
      job: {
        id: job.id,
        name: job.name,
        data: job.data,
        opts: job.opts,
        progress: job.progress,
        delay: job.delay,
        timestamp: job.timestamp,
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason,
        stacktrace: job.stacktrace,
        returnvalue: job.returnvalue,
        finishedOn: job.finishedOn,
        processedOn: job.processedOn,
      },
      state: state
    };

    const jobInfoKey = `jobinfo:${result.job.name}`;

    redisAPI.client.lpush(jobInfoKey, JSON.stringify(result));
    // since on each event emission we rpush job's current state to the list, it may contain duplicate jobIDs due to:
    // 1) repeat jobs which each iteration has different job IDs,
    // 2) single job ID with status update, which the latest result is pushed to the head of the list and will be retrieved by getJobHistory()
    // so the list would look like: {id15}, {id15}, ... {id1}, {id1}
    // here we estimate 200 is a big enough length to hold 20 final state records of different jobIDs (repeat job)
    redisAPI.client.ltrim(jobInfoKey, 0, 200);
  }
};
