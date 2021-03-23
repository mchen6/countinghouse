var url         = require('url');
var JobQueue    = require('bull');
var options     = require('./cli-options');
var LOG         = require('./logger');
var CdifError   = require('./cdif-error').CdifError;

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

    this.jobQueue = new JobQueue('job-queue', {prefix: '{cdifJob}', redis: {db: 11, port: urlObj.port, host: urlObj.hostname, password: password}});

    if (this.jobQueue == null) return LOG.E(new Error('Invalid job queue'));

    this.installJobEventHandlers();

    this.jobQueue.process("*", 16, function(job, done) {
      if (job == null) return LOG.E(new Error('received null job in processor'));

      var jobData = job.data;
      var jobID   = job.id;

      if (jobData == null) return done(new Error('job input data not available'));

      var deviceID   = jobData.deviceID;
      var serviceID  = jobData.serviceID;
      var actionName = jobData.actionName;
      var input      = jobData.input;

      this.cdifInterface.invokeJobs(deviceID, serviceID, actionName, input, jobID, function(err, results) {
        //TODO: add results object to result-queue as a job to be able to notify job sender reliably under distributed environment
        return done(err, results);
      }.bind(this));
    }.bind(this));
  },

  addJob: function(jobOpts, deviceID, serviceID, actionName, input, callback) {
    if (options.workerThread !== true) {
      return callback(new CdifError('ADD_JOB_ERROR', 'cdif should be in multi-thread mode'));
    }
    if (jobOpts == null) {
      return callback(new CdifError('ADD_JOB_ERROR', 'must have opts to add a job'));
    }
    if (jobOpts.name == null) {
      return callback(new CdifError('ADD_JOB_ERROR', 'job must have a name'));
    }

    var name = jobOpts.name;
    var opts = {};

    opts.attempts = jobOpts.attempts;   // [Optional] The total number of attempts to try the job until it completes or fail. Defaults to 1
    opts.delay    = jobOpts.delay;      // [Optional] An amount of milliseconds to wait until this job can be processed. Note that for accurate delays, both server and clients should have their clocks synchronized.
    opts.timeout  = jobOpts.timeout;    // [Optional] The number of milliseconds after which the job should be fail with a timeout error
    if (jobOpts.repeat != null) {
      opts.repeat = {};
      // according to bull documentation cron is mutual exclusive to every. we prioritize cron setting here
      if (jobOpts.repeat.cron != null) {
        opts.repeat.cron  = jobOpts.repeat.cron;    // cron string
      } else {
        opts.repeat.every = jobOpts.repeat.every;   //Repeat every milliseconds
      }
      opts.repeat.limit = jobOpts.repeat.limit;   // Number of times the job should repeat at max.
    }

    this.jobQueue.add(name, {
        deviceID: deviceID,
        serviceID: serviceID,
        actionName: actionName,
        input: input
      },
      opts
    ).then(function(job) {
      return callback(null, {id: job.id});
    }).catch(function(err) {
      return callback(new CdifError('ADD_JOB_ERROR', err.message));
    });
  },

  getJob: function(id, callback) {
    if (options.workerThread !== true) {
      return callback(new CdifError('GET_JOB_ERROR', 'cdif should be in multi-thread mode'));
    }

    this.jobQueue.getJob(id).then(function(job) {
      if (job == null) return callback(new CdifError('GET_JOB_ERROR', 'unknown job'));

      job.getState().then(function(state) {

        return callback(null, {
          job: {
            id: job.id,
            name: job.name,
            data: job.data,
            opts: job.opts,
            progress: job.progress(),
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
        return callback(new CdifError('GET_JOB_ERROR', error.message));
      });
    }).catch(function(err) {
      return callback(new CdifError('GET_JOB_ERROR', err.message));
    });
  },

  getJobHistory: function(name, callback) {
    var jobInfoKey = 'jobinfo:' + name;
    //TODO: make this value configurable
    redisAPI.client.lrange(jobInfoKey, 0, -1, function(err, data) {
      if (err) return callback('GET_JOB_ERROR', err.message);
      if (data == null) return callback('GET_JOB_ERROR', []);
      console.log(data);
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
      return callback(new CdifError('REMOVE_JOB_ERROR', 'cdif should be in multi-thread mode'));
    }
    if (name == null) {
      return callback(new CdifError('REMOVE_JOB_ERROR', 'job must have a name'));
    }
    if (isRepeat == null ||typeof(isRepeat) !== 'boolean') {
      return callback(new CdifError('REMOVE_JOB_ERROR', 'must pass in isRepeat boolean flag'));
    }

    if (isRepeat === false) {
      _this.jobQueue.getJob(jobID).then(function(job) {
        if (job == null) return callback(new CdifError('REMOVE_JOB_ERROR', 'unknown job'));
        job.remove();
        return callback(null, {removed: true});
      }).catch(function(err) {
        return callback(new CdifError('REMOVE_JOB_ERROR', err.message));
      });
    } else {
      var found = false;

      _this.jobQueue.getRepeatableJobs().then(function(repeatable) {
        repeatable.forEach(function(item) {
           if (item.name === name) {
             found = true;
            _this.jobQueue.removeRepeatableByKey(item.key);
           }
        });
        if (found === true) return callback(null, {removed: true});
        return callback(new CdifError('REMOVE_JOB_ERROR', 'unknown job'));
      }).catch(function(err) {
        return callback(new CdifError('REMOVE_JOB_ERROR', err.message));
      });
    }
  },

  updateJobProgress: function(jobID, progress) {
    this.jobQueue.getJob(jobID).then(function(job) {
      if (job != null) job.progress(progress);
    }).catch(function(err) {
      return;
    });
  },

  installJobEventHandlers: function() {
    this.jobQueue.on('error', function(error) {
      LOG.E('job queue error: ' + error);
    });

    //TODO: ltrim and hdel (according to value in trimed jobID list) to entries in joblist: jobinfo: keyspace to keep redis clean
    //This could be done in api-mon once an hour by iterating all joblist:* keys
    this.jobQueue.on('waiting', function(jobID) {
      var _this = this;
      this.jobQueue.getJob(jobID).then(function(job) {
        if (job == null) return;
        _this.saveJobInfoToRedis(job, 'waiting');
      }).catch(function(err) {
        return;
      });
    }.bind(this));

    this.jobQueue.on('removed', function(jobID) {
      // TODO: this event is never fired now
      // LOG.I('job removed: ' + jobID);
      var _this = this;

      this.jobQueue.getJob(jobID).then(function(job) {
        if (job == null) return;
        _this.saveJobInfoToRedis(job, 'removed');
      }).catch(function(err) {
        return;
      });
    }.bind(this));

    this.jobQueue.on('active', function(job, jobPromise) {
      // LOG.I('job active: ' + job.id);
      // A job has started. You can use `jobPromise.cancel()`` to abort it.
      if (job == null) return;
      this.saveJobInfoToRedis(job, 'active');
    }.bind(this));

    this.jobQueue.on('stalled', function(job) {
      // LOG.I('job stalled: ' + job.id);
      // A job has been marked as stalled. This is useful for debugging job
      // workers that crash or pause the event loop.
      if (job == null) return;
      this.saveJobInfoToRedis(job, 'stalled');
    }.bind(this));

    this.jobQueue.on('progress', function(job, progress) {
      // LOG.I('job prgress UPDATED: ' + job.id + ' : ' + progress);
      // A job's progress was updated!
      // DO NOT handle this event since we don't know how to write its current state to redis
    }.bind(this));

    this.jobQueue.on('completed', function(job, res) {
      // LOG.I('job completed: ' + job.id);
      // LOG.I('job completed: ' + result);
      // A job successfully completed with a `result`.
      if (job == null) return;
      this.saveJobInfoToRedis(job, 'completed');
    }.bind(this));

    this.jobQueue.on('failed', function(job, err) {
      // LOG.I('job failed: ' + JSON.stringify(job));
      // LOG.I('job failed: ' + err);
      // A job failed with reason `err`!
      if (job == null) return;
      this.saveJobInfoToRedis(job, 'failed');
    }.bind(this));


  },

  saveJobInfoToRedis: function(job, state) {
    var result = {
      job: {
        id: job.id,
        name: job.name,
        data: job.data,
        opts: job.opts,
        progress: job.progress(),
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
    // since on each event emission we rpush job's current state to the list, it may contain duplicate jobIDs,
    // so the list would look like: {id15}, {id15}, ... {id1}, {id1}
    // here we estimate 200 is a big enough length to hold 20 final state records of different jobIDs (repeat job)
    redisAPI.client.ltrim(jobInfoKey, 0, 200);
  }
};