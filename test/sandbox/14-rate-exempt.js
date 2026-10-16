// The message rate answers a refused message with rate-limited-reply, which
// only a message with a callback can act on. Fire-and-forget peer control
// messages would be lost instead -- a lost peer-channel-request leaves every
// later call to that device queued for good -- so they are not counted.
const assert = require('assert');
const WorkerMessage = require('../../lib/worker-message');

function exhausted() {
  const posted = [];
  const wm = new WorkerMessage({on() {}, postMessage: (m) => posted.push(m)});
  wm.messageRate = 1;
  wm.rateTokens = 0;
  wm.rateRefillAt = Date.now();
  return {wm, posted};
}

describe('sandbox 14: message rate exemptions', () => {
  ['peer-channel-request', 'peer-self-invalidate', 'sandbox-violation'].forEach((command) => {
    it(`delivers ${command} with the bucket empty`, () => {
      const {wm, posted} = exhausted();
      let seen = false;
      wm.on(command, () => { seen = true; });
      wm.onWorkerMessage({id: 1, category: 'child', command: command, data: {}});
      assert.strictEqual(seen, true);
      assert.deepStrictEqual(posted, []);
    });
  });

  it('still refuses a message that has a callback', () => {
    const {wm, posted} = exhausted();
    wm.onWorkerMessage({id: 7, category: 'child', command: 'rediscommand', data: {}});
    assert.deepStrictEqual(posted, [{command: 'rate-limited-reply', msgID: 7}]);
  });
});
