var request = require('supertest');
var url = 'http://127.0.0.1:9527';

var Queue = require('bull');
var jobQueue = new Queue('job-queue', {
  prefix: '{cdifJob}',
  redis: {db: 11, port: 6379, host: '127.0.0.1', password: null},
  settings: {
    stalledInterval: 500,
    maxStalledCount: 0
  }
});

module.exports = function (cp, isSingleThread) {
  describe('Test job process', function() {
    this.timeout(0);

    it('should complete added job after module is loaded', function(done) {
      cp.on('message', message => {

        if (message === 'ready') {

          jobQueue.on('global:failed', function(job, err) {
            return done(err);
          });

          jobQueue.on('global:stalled', function(job) {
            return done(new Error('stalled'));
          });

          jobQueue.on('global:completed', function(job, result) {
            console.log(`Job completed with result ${result}`);

            request(url).post('/shutdown').end(function() {});
            return done();
          });

          jobQueue.add({
            deviceID: 'b752c14b-27ec-5374-a2ca-0ce71c247566',
            serviceID:'urn:apemesh-com:serviceID:echoService',
            actionName: 'echo',
            input: {foo: [], bar: 'inputString'}
          }).then(function(job) {
          }).catch(function(err) {
            console.log('job add error:' + err.message);
          });
        }
      });
    });
  });
};


