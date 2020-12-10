var url      = require('url');
var JobQueue = require('bull');
var options  = require('./cli-options');
var LOG      = require('./logger');

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
  }
};