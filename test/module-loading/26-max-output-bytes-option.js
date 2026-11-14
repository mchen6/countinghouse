// --maxOutputBytes (lean worker step 2, the reviewer's ruling (b) of
// 2026-11-13): one cap on every module output, a hop's result included. The
// default is 8 MiB; 256 MiB is the most it may be set to, since every hop
// result is a buffer the size of the cap.
const assert = require('assert');

describe('module-loading 26: --maxOutputBytes allows at most 256 MiB', () => {
  const cli = require('../../lib/cli-options');
  after(() => cli.setOptions({workerThread: false}));

  it('8 MiB by default; 1 to 268435456 accepted; anything else stops the start with the bound in its text', () => {
    cli.setOptions({workerThread: false});
    assert.strictEqual(cli.maxOutputBytes, 8388608);
    assert.strictEqual(cli.validatorLimitInvalid, null);
    for (const v of [1, 8388608, 268435456]) {
      cli.setOptions({workerThread: false, maxOutputBytes: v});
      assert.strictEqual(cli.validatorLimitInvalid, null, String(v));
    }
    for (const v of [268435457, 0, -1, 1.5, 'lots']) {
      cli.setOptions({workerThread: false, maxOutputBytes: v});
      assert.deepStrictEqual(cli.validatorLimitInvalid, {name: 'maxOutputBytes', value: v, what: 'a positive integer, at most 268435456'}, String(v));
    }
  });
});
