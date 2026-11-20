const request = require('supertest');
const waitForReady = require('../helpers/wait-for-ready');
const {testPort, redisConnectionFor} = require('../helpers/test-env');
const {prefixFor} = require('../helpers/job-queue');
const url = `http://127.0.0.1:${testPort(9527)}`;

const Queue       = require('bullmq').Queue;
const QueueEvents = require('bullmq').QueueEvents;

const connection = redisConnectionFor(11);

// the server's own queue (B-j1), opened once it is up: its prefix comes
// from the identity secret it makes at its first start (the default data
// directory: test5.js gives none)
let jobQueue = null;
let queueEvents = null;

module.exports = function (cp, isSingleThread) {
  describe('Test job process', function() {
    this.timeout(0);

    it('should complete added job after module is loaded', (done) => {
      waitForReady.inText(() => cp.log, (readyErr) => {
        if (readyErr != null) return done(readyErr);
        jobQueue = new Queue('job-queue', {prefix: prefixFor(), connection: connection});
        queueEvents = new QueueEvents('job-queue', {prefix: prefixFor(), connection: connection});

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
      });
    });
  });
};
