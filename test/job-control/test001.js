const request = require('supertest');
const {deviceIDForName} = require('../../lib/call-address');
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
      // (one answer: a completion, a failure or the add's error, whichever is first)
      let answered = false;
      const once = (err) => { if (answered) return; answered = true; done(err); };
      waitForReady.inText(() => cp.log, (readyErr) => {
        if (readyErr != null) return once(readyErr);
        jobQueue = new Queue('job-queue', {prefix: prefixFor(), connection: connection});
        queueEvents = new QueueEvents('job-queue', {prefix: prefixFor(), connection: connection});

          queueEvents.on('failed', (args) => {
            return once(new Error(args.failedReason));
          });

          queueEvents.on('stalled', (args) => {
            return once(new Error('stalled'));
          });

          queueEvents.on('completed', (args) => {
            console.log(`Job completed with result ${JSON.stringify(args.returnvalue)}`);

            request(url).post('/shutdown').set('X-CH-Key', 'aabbcc').end(() => {}); // /shutdown is now admin-gated, shared with test5.js's debugKey
            return once();
          });

          // the events stream is read before the job is added: a quick job's
          // completion is never missed (the high review of #463)
          queueEvents.waitUntilReady().then(() => jobQueue.add('test1', {
            deviceID: deviceIDForName('echo-device'),
            serviceID:'urn:countinghouse-com:serviceID:echoService',
            actionName: 'echo',
            input: {foo: [], bar: 'inputString'}
          })).catch((err) => once(new Error(`job add error: ${err.message}`)));
      });
    });
  });
};
