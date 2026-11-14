// A worker's options are the main thread's (lib/sandbox.js and the lean
// worker's set-options), handed over by getOptions() with the durations
// already in milliseconds. setOptions keeps them so (durationsInMs): a
// worker's requestTimeout, jobTimeout and jobResultTtl equal the main
// thread's, never 1000 times them (#112). One conversion, in
// lib/cli-options.js.
const assert = require('assert');
const options = require('../../lib/cli-options');

describe('validation 10: a worker\'s durations equal the main thread\'s', () => {
  let saved = null;
  before(() => { saved = options.getOptions(); });
  after(() => options.setOptions(saved));

  // the main thread's options as a worker sets them from getOptionsForWorker()
  const asWorker = (argv) => {
    options.setOptions(argv);
    const main = options.getOptions();
    options.setOptions(options.getOptionsForWorker());
    return {main, worker: options.getOptions()};
  };
  const durations = (o) => [o.requestTimeout, o.jobTimeout, o.jobResultTtl];

  it('the defaults: 30 s, an hour, an hour', () => {
    const {main, worker} = asWorker({});
    assert.deepStrictEqual(durations(main), [30000, 3600000, 3600000]);
    assert.deepStrictEqual(durations(worker), durations(main));
  });

  it('--requestTimeout 10, --jobTimeout 120, --jobResultTtl 60, as the CLI gives them (seconds)', () => {
    const {main, worker} = asWorker({requestTimeout: 10, jobTimeout: 120, jobResultTtl: 60});
    assert.deepStrictEqual(durations(main), [10000, 120000, 60000]);
    assert.deepStrictEqual(durations(worker), durations(main));
  });

  it('set again and again (a reload\'s set-options), they stay as they are', () => {
    asWorker({requestTimeout: '2'});
    options.setOptions(options.getOptionsForWorker());
    options.setOptions(options.getOptionsForWorker());
    assert.strictEqual(options.requestTimeout, 2000);
  });

  it('a timer of 0 is kept (it expires at once, lib/timer.js), and one that is not a number is the default', () => {
    assert.strictEqual(asWorker({requestTimeout: 0}).worker.requestTimeout, 0);
    assert.strictEqual(asWorker({requestTimeout: 'soon'}).worker.requestTimeout, 30000);
  });
});
