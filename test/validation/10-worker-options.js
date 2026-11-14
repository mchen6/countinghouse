// A worker's options are the main thread's (lib/sandbox.js and the lean
// worker's set-options), set with setResolvedOptions from
// getOptionsForWorker(): durations in milliseconds, kept as they are. A
// worker's requestTimeout, jobTimeout and jobResultTtl equal the main
// thread's, never 1000 times them (#112). One conversion, in setOptions, for
// the CLI's seconds; nothing on the command line changes the units.
const assert = require('assert');
const options = require('../../lib/cli-options');

describe('validation 10: a worker\'s durations equal the main thread\'s', () => {
  let saved = null;
  before(() => { saved = options.getOptions(); });
  after(() => options.setResolvedOptions(saved));

  // the main thread's options from the CLI, then a worker's from them
  const asWorker = (argv) => {
    options.setOptions(argv);
    const main = options.getOptions();
    options.setResolvedOptions(options.getOptionsForWorker());
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
    options.setResolvedOptions(options.getOptionsForWorker());
    options.setResolvedOptions(options.getOptionsForWorker());
    assert.strictEqual(options.requestTimeout, 2000);
  });

  it('a flag with no number is the default, as before: --no-requestTimeout, a bare --requestTimeout, a repeated one, not a number', () => {
    for (const v of [false, true, ['5', '6'], 'soon', '']) {
      options.setOptions({requestTimeout: v, jobTimeout: v});
      assert.deepStrictEqual([options.requestTimeout, options.jobTimeout], [30000, 3600000], JSON.stringify(v));
    }
  });

  it('a timer of 0 is kept (it expires at once, lib/timer.js); one past setTimeout\'s largest delay is capped', () => {
    assert.strictEqual(asWorker({requestTimeout: 0}).worker.requestTimeout, 0);
    options.setOptions({requestTimeout: 3000000, jobTimeout: 2200000});
    assert.deepStrictEqual([options.requestTimeout, options.jobTimeout], [2147483647, 2147483647]);
  });

  it('nothing on the command line changes the units, and getOptions() carries no marker', () => {
    options.setOptions({requestTimeout: 5, durationsInMs: true, resolved: true});
    assert.strictEqual(options.requestTimeout, 5000);
    assert.ok(!Object.keys(options.getOptions()).some((k) => /durationsInMs|resolved/.test(k)));
  });
});
