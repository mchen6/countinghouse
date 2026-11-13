const url         = require('url');
const async       = require('async');
const Queue       = require('bullmq').Queue;
const Worker      = require('bullmq').Worker;
const QueueEvents = require('bullmq').QueueEvents;
const UnrecoverableError = require('bullmq').UnrecoverableError;

// The bounds, the ownership checks and the scheduler ids both job runners
// share (LM1 B5).
const {MAX_TIMER_MS, NOT_RETRIED, jobOptsError, INTERNAL, schedulerId, legacySchedulerId, ownsJob, denied,
  getJobHistory, saveJobInfo, jobRecord, publicRecord, authorizeOwner, ownerData, ownerKeyOf} = require('./job-control-common');

const options     = require('./cli-options');
const LOG         = require('./logger');
const CountinghouseError = require('./countinghouse-error').CountinghouseError;

const encodeLegacyTool = require('./metering/provider').encodeLegacyTool;
// What a run's call carries for the main thread beside the start hook's
// answer, when set: the owner's key (the run's token bills the owner) and
// the run's timeout (which bounds that token). Neither is sent on to the
// worker (lib/job-args.js).
const withRunBookkeeping = (extra, ownerKey, timeoutMs) => {
  // set over the start hook's answer unconditionally: the hook cannot name
  // them (#141 N6); absent when unset
  const out = Object.assign({}, extra, {ownerKey: ownerKey, timeoutMs: timeoutMs});
  if (out.ownerKey == null) delete out.ownerKey;
  if (out.timeoutMs == null) delete out.timeoutMs;
  return out;
};

//NOTE: the methods in this object should be called in main thread only, do not call them in the context of workers


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
  //
  // It is called as hook(jobData, results, run): `run.extra` is what the
  // start hook returned for this run. A run that fails (its error, or its
  // timeout) calls it as hook(jobData, null, {extra, error}), fire and
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

  setStartHook: function(fn) {
    this.startHook = fn;
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
      // A failed run tells the completion hook, so its Out record is written.
      let extra = null;
      const failed = (error) => {
        const hook = _this.completionHook;
        if (typeof(hook) !== 'function') return;
        Promise.resolve().then(() => hook(jobData, null, {extra, error})).catch((e) => LOG.E(e));
      };

      return _this.authorizeRun(job).then(() => new Promise((resolve, reject) => {
        // A job's own timeout, else --jobTimeout -- applied here rather than
        // stamped on the job at addJob, so it also bounds jobs queued before
        // the flag existed and scheduler jobs made from templates stored
        // earlier. 0 means none.
        // Clamped to setTimeout's maximum (2^31-1 ms, about 24.8 days): past
        // it the timer fires at once, which would fail the job immediately.
        // a job's own timeout is validated where it comes in (jobOptsError); one
        // stored otherwise (an older record) counts as none
        const own = (job.opts != null && Number.isInteger(job.opts.timeout) && job.opts.timeout > 0) ? job.opts.timeout : null;
        const wanted = (own != null) ? own : (options.jobTimeout > 0 ? options.jobTimeout : null);
        const timeoutMs = (wanted != null) ? Math.min(wanted, MAX_TIMER_MS) : null;
        if (timeoutMs != null) {
          timeoutHandle = setTimeout(() => {
            run.settled = true;
            const timedOut = new Error(`Promise timed out after ${timeoutMs} milliseconds`);
            failed(timedOut);
            reject(timedOut);
          }, timeoutMs);
        }

        if (typeof(_this.startHook) === 'function') {
          try { extra = _this.startHook(jobData); } catch (e) { LOG.E(e); }
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
            failed(err);
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
          const ownerKey = ownerKeyOf(jobData);
          if (ownerKey != null && typeof(_this.cdifInterface.recordCall) === 'function') {
            // Same canonical metering identity every other entry path uses
            // (see lib/mcp/gateway.js's tools/call comment) rather than
            // job.name, which is the MCP tool name for a task-augmented call
            // but an arbitrary caller-chosen string for an HTTP-submitted job.
            _this.cdifInterface.recordCall(ownerKey, encodeLegacyTool(deviceID, serviceID, actionName),
                                           options.mcpToolCallCost, (err) => {
              if (err) LOG.E(err);
            });
          }

          const hook = _this.completionHook;
          if (typeof(hook) !== 'function') return resolve(results);
          // The full main-side data is written back with the stamp merged
          // in: updateData replaces job.data, and ownership (ownsJob), billing
          // and tasks/result's addressing all read it.
          return Promise.resolve().then(() => hook(jobData, results, {extra}))
            .then((extra) => (extra != null ? job.updateData(Object.assign({}, jobData, extra)) : null))
            .catch((e) => LOG.E(e))
            .then(() => resolve(results));
        }, () => run.settled, withRunBookkeeping(extra, ownerKeyOf(jobData), timeoutMs));
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
    return authorizeOwner(job.data, job.id, this.authorizeRunMs).catch((e) => {
      if (e.final !== true) throw e;
      const scheduler = (job.repeatJobKey != null) ? this.jobQueue.removeJobScheduler(job.repeatJobKey) : Promise.resolve();
      return scheduler.catch((x) => LOG.E(x)).then(() => { throw new UnrecoverableError(e.message); });
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
      input: input
    };
    // the owner by opaque id, or the key where the id is not indexed
    // (R2-1 Task 3, job-control-common's ownerData)
    Object.assign(jobData, ownerData(authCtx));

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
  // Each stored record carries the full job, including job.data.apiKey, so
  // the filter is applied per record -- a caller gets its own history for
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
            job: jobRecord(job),
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
    return saveJobInfo(job, state);
  }
};
