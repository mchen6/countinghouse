var url         = require('url');
var JobQueue    = require('bull');
var options     = require('./cli-options');
var LOG         = require('./logger');
var CdifError   = require('./cdif-error').CdifError;

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
    this.jobQueue.process(function(job, done) {
      var jobData = job.data;

      if (jobData == null) return done(new Error('job input data not available'));

      var deviceID   = jobData.deviceID;
      var serviceID  = jobData.serviceID;
      var actionName = jobData.actionName;
      var input      = jobData.input;

      this.cdifInterface.invokeJobs(deviceID, serviceID, actionName, input, function(err, results) {
        //TODO: add results object to result-queue as a job to be able to notify job sender reliably under distributed environment
        return done(err, results);
      }.bind(this));
    }.bind(this));
  },

  addJob: function(jobOpts, deviceID, serviceID, actionName, input, callback) {
    if (options.workerThread !== true) {
      return callback(new CdifError('ADD_JOB_ERROR', 'app server should be in multi-thread mode'));
    }

    var opts = {};

    if (jobOpts != null) {
      opts.attempts = jobOpts.attempts;   // The total number of attempts to try the job until it completes.
      opts.delay    = jobOpts.delay;      // [Optional] An amount of milliseconds to wait until this job can be processed. Note that for accurate delays, both server and clients should have their clocks synchronized.
      opts.timeout  = jobOpts.timeout;    // [Optional] The number of milliseconds after which the job should be fail with a timeout error
      if (jobOpts.repeat != null) {
        opts.repeat = {};
        opts.repeat.limit = jobOpts.repeat.limit;   // Number of times the job should repeat at max.
        opts.repeat.every = jobOpts.repeat.every;   //Repeat every milliseconds
      }
    }

    this.jobQueue.add({
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
    this.jobQueue.getJob(id).then(function(job) {
      if (job == null) return callback(new CdifError('GET_JOB_ERROR', 'unknown job'));
      return callback(null, job);
    }).catch(function(err) {
      return callback(new CdifError('GET_JOB_ERROR', err.message));
    });
  }
};