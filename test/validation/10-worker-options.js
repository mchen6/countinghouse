// A worker's options are the main thread's (lib/sandbox.js, set-options), and
// getOptions() hands them over with its durations already in milliseconds,
// which setOptions then reads as seconds again. ctx.call's composition wait is
// bounded under the request timer (test/composition/19), so a worker needs the
// main thread's request timer as it is: requestTimeoutMs carries it. The other
// durations are left as they were (reviewer's call; see the commit message).
const assert = require('assert');
const options = require('../../lib/cli-options');

describe('validation 10: a worker sees the main thread\'s request timer in milliseconds', () => {
  let saved = null;
  before(() => { saved = options.getOptions(); });
  after(() => { options.setOptions(saved); options.requestTimeoutMs = saved.requestTimeoutMs; });

  it('requestTimeoutMs survives the main thread\'s options being set again in a worker', () => {
    options.setOptions({requestTimeout: 10});
    const main = options.getOptions();
    assert.strictEqual(main.requestTimeoutMs, 10000);
    options.setOptions(main);
    assert.strictEqual(options.requestTimeoutMs, 10000);
  });

  it('and the default: 30 s', () => {
    options.setOptions({});
    options.setOptions(options.getOptions());
    assert.strictEqual(options.requestTimeoutMs, 30000);
  });
});
