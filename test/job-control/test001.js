const request = require('supertest');
const url = 'http://127.0.0.1:9527';

const Queue       = require('bullmq').Queue;
const QueueEvents = require('bullmq').QueueEvents;

const connection = {db: 11, port: 6379, host: '127.0.0.1', password: null};

const jobQueue    = new Queue('job-queue', {prefix: '{cdifJob}', connection: connection});
const queueEvents = new QueueEvents('job-queue', {prefix: '{cdifJob}', connection: connection});

module.exports = function (cp, isSingleThread) {
  describe('Test job process', function() {
    this.timeout(0);

    it('should complete added job after module is loaded', (done) => {
      cp.on('message', message => {

        if (message === 'ready') {

          queueEvents.on('failed', (args) => {
            return done(new Error(args.failedReason));
          });

          queueEvents.on('stalled', (args) => {
            return done(new Error('stalled'));
          });

          queueEvents.on('completed', (args) => {
            console.log(`Job completed with result ${JSON.stringify(args.returnvalue)}`);

            request(url).post('/shutdown').set('X-CH-Key', 'aabbcc').end(() => {}); // /shutdown is now admin-gated, shared with test5.js's debugKey
            return done();
          });

          jobQueue.add('test1', {
            deviceID: 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767',
            serviceID:'urn:countinghouse-com:serviceID:echoService',
            actionName: 'echo',
            input: {foo: [], bar: 'inputString'}
          }).then((job) => {
          }).catch((err) => {
            console.log(`job add error:${err.message}`);
          });
        }
      });
    });
  });
};
