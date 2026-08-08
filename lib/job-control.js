var url         = require('url');
var Queue       = require('bullmq').Queue;
var Worker      = require('bullmq').Worker;
var QueueEvents = require('bullmq').QueueEvents;
var options     = require('./cli-options');
var LOG         = require('./logger');
var CHError   = require('./countinghouse-error').CHError;

var redisAPI       = require('./redis-api');

//NOTE: the methods in this object should be called in main thread only, do not call them in the context of workers

module.exports = {
  jobQueue: null,

  initJobProcess: function(cdifInterface) {
    this.cdifInterface = cdifInterface;

    var redisUrl = options.redisUrl;
    var urlObj   = null;

    try {
      urlObj = url.parse(redisUrl);
    } catch(e) {
      return LOG.E(new Error('redis URL parse fail, check redisUrl option: ' + err.message));
    }

    var password = null;
    if (urlObj.auth != null) {
      password = urlObj.auth.split(':')[1];
    }

    var connection = {db: 11, port: urlObj.port, host: urlObj.hostname, password: password};

    this.jobQueue = new Queue('job-queue', {prefix: '{cdifJob}', connection: connection});

    if (this.jobQueue == null) return LOG.E(new Error('Invalid job queue'));

    this.queueEvents = new QueueEvents('job-queue', {prefix: '{cdifJob}', connection: connection});

    this.installJobEventHandlers();

    var _this = this;

    this.worker = new Worker('job-queue', function(job) {
      if (job == null) return Promise.reject(new Error('received null job in processor'));

      var jobData = job.data;
      var jobID   = job.id;

      if (jobData == null) return Promise.reject(new Error('job input data not available'));

      var deviceID   = jobData.deviceID;
      var serviceID  = jobData.serviceID;
      var actionName = jobData.actionName;
      var input      = jobData.input;

      // bullmq dropped bull's job-level `opts.timeout` (previously enforced internally
      // via p-timeout); job.opts.timeout is still stored on the job, so re-implement
      // the same "reject after N ms" behavior here to avoid silently losing it
      var timeoutHandle = null;

      return new Promise(function(resolve, reject) {
        if (job.opts != null && job.opts.timeout != null) {
          timeoutHandle = setTimeout(function() {
            reject(new Error('Promise timed out after ' + job.opts.timeout + ' milliseconds'));
          }, job.opts.timeout);
        }

        _this.cdifInterface.invokeJobs(deviceID, serviceID, actionName, input, jobID, function(err, results) {
          if (timeoutHandle != null) clearTimeout(timeoutHandle);
          //TODO: add results object to result-queue as a job to be able to notify job sender reliably under distributed environment
          if (err != null) return reject(err);
          return resolve(results);
        });
      });
    }, {prefix: '{cdifJob}', connection: connection, concurrency: 1024});
  },

  addJob: function(jobOpts, deviceID, serviceID, actionName, input, callback) {
    if (options.workerThread !== true) {
      return callback(new CHError('ADD_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
    }
    if (jobOpts == null) {
      return callback(new CHError('ADD_JOB_ERROR', 'must have opts to add a job'));
    }
    if (jobOpts.name == null) {
      return callback(new CHError('ADD_JOB_ERROR', 'job must have a name'));
    }

    var name = jobOpts.name;
    var opts = {};

    opts.attempts = jobOpts.attempts;   // [Optional] The total number of attempts to try the job until it completes or fail. Defaults to 1
    opts.delay    = jobOpts.delay;      // [Optional] An amount of milliseconds to wait until this job can be processed. Note that for accurate delays, both server and clients should have their clocks synchronized.
    opts.timeout  = jobOpts.timeout;    // [Optional] The number of milliseconds after which the job should be fail with a timeout error

    var jobData = {
      deviceID: deviceID,
      serviceID: serviceID,
      actionName: actionName,
      input: input
    };

    if (jobOpts.repeat != null) {
      // bullmq moved repeatable job creation off Queue.add() and onto a dedicated
      // scheduler API; jobSchedulerId is used the same way `name` was used before
      // to look up / remove a repeatable job later (see removeJob below)
      var repeatOpts = {};
      // according to bullmq documentation pattern (cron) is mutual exclusive to every. we prioritize cron setting here
      if (jobOpts.repeat.cron != null) {
        repeatOpts.pattern = jobOpts.repeat.cron;   // cron string; bullmq calls this field "pattern"
      } else {
        repeatOpts.every = jobOpts.repeat.every;    //Repeat every milliseconds
      }
      repeatOpts.limit = jobOpts.repeat.limit;      // Number of times the job should repeat at max.

      this.jobQueue.upsertJobScheduler(name, repeatOpts, {name: name, data: jobData, opts: opts})
      .then(function(job) {
        return callback(null, {id: job.id});
      }).catch(function(err) {
        return callback(new CHError('ADD_JOB_ERROR', err.message));
      });
      return;
    }

    this.jobQueue.add(name, jobData, opts)
    .then(function(job) {
      return callback(null, {id: job.id});
    }).catch(function(err) {
      return callback(new CHError('ADD_JOB_ERROR', err.message));
    });
  },

  getJob: function(id, callback) {
    if (options.workerThread !== true) {
      return callback(new CHError('GET_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
    }

    this.jobQueue.getJob(id).then(function(job) {
      if (job == null) return callback(new CHError('GET_JOB_ERROR', 'unknown job'));

      job.getState().then(function(state) {

        return callback(null, {
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
        });

      }).catch(function(error) {
        return callback(new CHError('GET_JOB_ERROR', error.message));
      });
    }).catch(function(err) {
      return callback(new CHError('GET_JOB_ERROR', err.message));
    });
  },

  getJobHistory: function(name, callback) {
    var jobInfoKey = 'jobinfo:' + name;
    //TODO: make this value configurable
    redisAPI.client.lrange(jobInfoKey, 0, -1, function(err, data) {
      if (err) return callback('GET_JOB_ERROR', err.message);
      if (data == null) return callback('GET_JOB_ERROR', []);

      var keyList = {};
      var jsonRet = [];

      var cap = 0;
      data.forEach(function(item) {
        if (cap >= 20) return;

        var parsedItem = JSON.parse(item);
        var jobID = parsedItem.job.id;

        if (keyList[jobID] == null) {
          keyList[jobID] = parsedItem;
          jsonRet.push(parsedItem);
          cap++;
        }
      });

      return callback(null, jsonRet);
    });
  },

  removeJob: function(name, jobID, isRepeat, callback) {
    var _this = this;

    if (options.workerThread !== true) {
      return callback(new CHError('REMOVE_JOB_ERROR', 'countinghouse should be in multi-thread mode'));
    }
    if (name == null) {
      return callback(new CHError('REMOVE_JOB_ERROR', 'job must have a name'));
    }
    if (isRepeat == null ||typeof(isRepeat) !== 'boolean') {
      return callback(new CHError('REMOVE_JOB_ERROR', 'must pass in isRepeat boolean flag'));
    }

    if (isRepeat === false) {
      _this.jobQueue.getJob(jobID).then(function(job) {
        if (job == null) return callback(new CHError('REMOVE_JOB_ERROR', 'unknown job'));
        job.remove();
        return callback(null, {removed: true});
      }).catch(function(err) {
        return callback(new CHError('REMOVE_JOB_ERROR', err.message));
      });
    } else {
      // jobSchedulerId was set to `name` when the scheduler was created (see addJob above),
      // so it can be removed directly without enumerating existing schedulers
      _this.jobQueue.removeJobScheduler(name).then(function(removed) {
        if (removed !== true) return callback(new CHError('REMOVE_JOB_ERROR', 'unknown job'));
        return callback(null, {removed: true});
      }).catch(function(err) {
        return callback(new CHError('REMOVE_JOB_ERROR', err.message));
      });
    }
  },

  updateJobProgress: function(jobID, progress) {
    this.jobQueue.getJob(jobID).then(function(job) {
      if (job != null) job.updateProgress(progress);
    }).catch(function(err) {
      return;
    });
  },

  installJobEventHandlers: function() {
    var _this = this;

    this.queueEvents.on('error', function(error) {
      LOG.E('job queue error: ' + error);
    });

    //TODO: ltrim and hdel (according to value in trimed jobID list) to entries in joblist: jobinfo: keyspace to keep redis clean
    //This could be done in api-mon once an hour by iterating all joblist:* keys
    this.queueEvents.on('waiting', function(args) {
      _this.jobQueue.getJob(args.jobId).then(function(job) {
        if (job == null) return;
        _this.saveJobInfoToRedis(job, 'waiting');
      }).catch(function(err) {
        return;
      });
    });

    this.queueEvents.on('removed', function(args) {
      // TODO: this event is never fired now
      // LOG.I('job removed: ' + jobID);
      _this.jobQueue.getJob(args.jobId).then(function(job) {
        if (job == null) return;
        _this.saveJobInfoToRedis(job, 'removed');
      }).catch(function(err) {
        return;
      });
    });

    this.queueEvents.on('active', function(args) {
      // LOG.I('job active: ' + args.jobId);
      _this.jobQueue.getJob(args.jobId).then(function(job) {
        if (job == null) return;
        _this.saveJobInfoToRedis(job, 'active');
      }).catch(function(err) {
        return;
      });
    });

    this.queueEvents.on('stalled', function(args) {
      // LOG.I('job stalled: ' + args.jobId);
      // A job has been marked as stalled. This is useful for debugging job
      // workers that crash or pause the event loop.
      _this.jobQueue.getJob(args.jobId).then(function(job) {
        if (job == null) return;
        _this.saveJobInfoToRedis(job, 'stalled');
      }).catch(function(err) {
        return;
      });
    });

    this.queueEvents.on('progress', function(args) {
      // LOG.I('job prgress UPDATED: ' + args.jobId + ' : ' + args.data);
      // A job's progress was updated!
      // DO NOT handle this event since we don't know how to write its current state to redis
    });

    this.queueEvents.on('completed', function(args) {
      // LOG.I('job completed: ' + args.jobId);
      // A job successfully completed with a `result`.
      _this.jobQueue.getJob(args.jobId).then(function(job) {
        if (job == null) return;
        _this.saveJobInfoToRedis(job, 'completed');
      }).catch(function(err) {
        return;
      });
    });

    this.queueEvents.on('failed', function(args) {
      // LOG.I('job failed: ' + args.jobId);
      // A job failed with reason `args.failedReason`!
      _this.jobQueue.getJob(args.jobId).then(function(job) {
        if (job == null) return;
        _this.saveJobInfoToRedis(job, 'failed');
      }).catch(function(err) {
        return;
      });
    });


  },

  saveJobInfoToRedis: function(job, state) {
    var result = {
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

    var jobInfoKey = 'jobinfo:' + result.job.name;

    redisAPI.client.lpush(jobInfoKey, JSON.stringify(result));
    // since on each event emission we rpush job's current state to the list, it may contain duplicate jobIDs due to:
    // 1) repeat jobs which each iteration has different job IDs,
    // 2) single job ID with status update, which the latest result is pushed to the head of the list and will be retrieved by getJobHistory()
    // so the list would look like: {id15}, {id15}, ... {id1}, {id1}
    // here we estimate 200 is a big enough length to hold 20 final state records of different jobIDs (repeat job)
    redisAPI.client.ltrim(jobInfoKey, 0, 200);
  }
};
