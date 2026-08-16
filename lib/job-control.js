const url         = require('url');
const async       = require('async');
const Queue       = require('bullmq').Queue;
const Worker      = require('bullmq').Worker;
const QueueEvents = require('bullmq').QueueEvents;
const options     = require('./cli-options');
const LOG         = require('./logger');
const CHError   = require('./countinghouse-error').CHError;

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
  if (authCtx == null || authCtx.appKey == null) return new CHError('SYSTEM_ERROR_UNKNOWN_USER');
  return new CHError('JOB_ACCESS_DENIED');
}

module.exports = {
  jobQueue: null,

  // Sentinel for platform-internal callers that legitimately bypass the
  // ownership check because they aren't acting on behalf of any tenant --
  // currently only DeviceManager's 'getjobinfo' handler, where a worker is
  // asking about the job it is itself executing.
  INTERNAL: INTERNAL,

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

      return new Promise((resolve, reject) => {
        if (job.opts != null && job.opts.timeout != null) {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`Promise timed out after ${job.opts.timeout} milliseconds`));
          }, job.opts.timeout);
        }

        _this.cdifInterface.invokeJobs(deviceID, serviceID, actionName, input, jobID, (err, results) => {
          if (timeoutHandle != null) clearTimeout(timeoutHandle);
          //TODO: add results object to result-queue as a job to be able to notify job sender reliably under distributed environment
          if (err != null) {
            // bullmq's Worker only persists a job failure as a plain string
            // (job.failedReason = err.message) -- any other property on the
            // rejected error, including CHError/DeviceError's locale-
            // independent `code`, is lost once it round-trips through
            // redis. Encode it into the message itself as a "CODE: message"
            // prefix (every CHError/DeviceError code is an UPPER_SNAKE_CASE
            // identifier, which a real message would not otherwise start
            // with) so lib/mcp/gateway.js's handleTasksResult can recover
            // it -- see the matching decode there.
            const failMessage = (err.code != null) ? (`${err.code}: ${err.message}`) : err.message;
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

          return resolve(results);
        });
      });
    }), {prefix: '{cdifJob}', connection: connection, concurrency: 1024});
  },

  addJob: function(authCtx, jobOpts, deviceID, serviceID, actionName, input, callback) {
    if (options.workerThread !== true) {
      return callback(new CHError('ADD_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
    }
    if (authCtx !== INTERNAL && (authCtx == null || authCtx.appKey == null)) {
      return callback(denied(authCtx));
    }
    if (jobOpts == null) {
      return callback(new CHError('ADD_JOB_ERROR', 'must have opts to add a job'));
    }
    if (jobOpts.name == null) {
      return callback(new CHError('ADD_JOB_ERROR', 'job must have a name'));
    }

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

      this.jobQueue.upsertJobScheduler(name, repeatOpts, {name: name, data: jobData, opts: opts})
      .then((job) => {
        return callback(null, {id: job.id});
      }).catch((err) => {
        return callback(new CHError('ADD_JOB_ERROR', err.message));
      });
      return;
    }

    this.jobQueue.add(name, jobData, opts)
    .then((job) => {
      return callback(null, {id: job.id});
    }).catch((err) => {
      return callback(new CHError('ADD_JOB_ERROR', err.message));
    });
  },

  getJob: function(authCtx, id, callback) {
    if (options.workerThread !== true) {
      return callback(new CHError('GET_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
    }

    const _this = this;

    this.jobQueue.getJob(id).then((job) => {
      if (job == null) return callback(new CHError('GET_JOB_ERROR', 'unknown job'));

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
          return callback(new CHError('GET_JOB_ERROR', error.message));
        });

      }).catch((error) => {
        return callback(new CHError('GET_JOB_ERROR', error.message));
      });
    }).catch((err) => {
      return callback(new CHError('GET_JOB_ERROR', err.message));
    });
  },

  // History is keyed by job *name*, which is caller-chosen and therefore not
  // an ownership boundary on its own (two tenants can pick the same name).
  // Each stored record carries the full job, including job.data.apiKey, so
  // the filter is applied per record -- a caller gets its own history for
  // that name and nothing else, instead of the previous "whoever asks for
  // the name gets every tenant's entries under it" (the in-code TODO this
  // replaces).
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
      return callback(new CHError('REMOVE_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
    }
    if (authCtx !== INTERNAL && (authCtx == null || authCtx.appKey == null)) {
      return callback(denied(authCtx));
    }
    if (name == null) {
      return callback(new CHError('REMOVE_JOB_ERROR', 'job must have a name'));
    }
    if (isRepeat == null ||typeof(isRepeat) !== 'boolean') {
      return callback(new CHError('REMOVE_JOB_ERROR', 'must pass in isRepeat boolean flag'));
    }

    if (isRepeat === true) {
      // A repeatable job is removed by *scheduler id* (the caller-chosen
      // `name`), not by a job instance, and bullmq's scheduler record has no
      // owner field to match against -- so there is no per-tenant identity to
      // check here the way there is for a concrete job below. Rather than
      // leave the previous "any valid key can remove any scheduler by
      // guessing its name" behavior in place, this requires admin. Narrowing
      // an unattributable delete to the operator is the fail-closed reading;
      // per-scheduler ownership would need its own persisted record, which is
      // a design question and not something to decide as a side effect of
      // closing this hole. Recorded in docs/cross-cutting-matrix.md's HTTP
      // job-routes row.
      if (authCtx !== INTERNAL && authCtx.isAdmin !== true) {
        return callback(new CHError('JOB_ACCESS_DENIED', 'removing a repeatable job scheduler requires an admin apiKey'));
      }
    }

    if (isRepeat === false) {
      _this.jobQueue.getJob(jobID).then((job) => {
        if (job == null) return callback(new CHError('REMOVE_JOB_ERROR', 'unknown job'));
        if (ownsJob(authCtx, job.data) !== true) return callback(denied(authCtx));
        // job.remove() returns a promise and *rejects* (rather than resolving
        // false) when the job is currently locked by an active worker -- it
        // must be awaited, otherwise a job stuck mid-processing (e.g. one
        // whose action handler never calls back) silently fails to remove
        // while the caller is told {removed: true}.
        job.remove().then(() => {
          return callback(null, {removed: true});
        }).catch((err) => {
          return callback(new CHError('REMOVE_JOB_ERROR', err.message));
        });
      }).catch((err) => {
        return callback(new CHError('REMOVE_JOB_ERROR', err.message));
      });
    } else {
      // jobSchedulerId was set to `name` when the scheduler was created (see addJob above),
      // so it can be removed directly without enumerating existing schedulers
      _this.jobQueue.removeJobScheduler(name).then((removed) => {
        if (removed !== true) return callback(new CHError('REMOVE_JOB_ERROR', 'unknown job'));
        return callback(null, {removed: true});
      }).catch((err) => {
        return callback(new CHError('REMOVE_JOB_ERROR', err.message));
      });
    }
  },

  // lists recent jobs across all states directly from the live queue (unlike
  // getJobHistory, which reads the separate Redis snapshot log keyed by job
  // name -- this is a name-agnostic view, used by the MCP gateway's tasks/list).
  listJobs: function(authCtx, callback) {
    if (options.workerThread !== true) {
      return callback(new CHError('GET_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
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
        if (err) return callback(new CHError('GET_JOB_ERROR', err.message));
        return callback(null, results.filter((r) => { return r != null; }));
      });
    }).catch((err) => {
      return callback(new CHError('GET_JOB_ERROR', err.message));
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
