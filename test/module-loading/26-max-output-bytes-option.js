// --maxOutputBytes (lean worker step 2, the reviewer's ruling (b) of
// 2026-11-13): one cap on every module output, a hop's result included. The
// default is 16 MiB (maintainer's decision, 2026-11-15; it was 8 MiB); 256 MiB is the most it
// may be set to, since every hop result is a buffer the size of the cap.
const assert = require('assert');

describe('module-loading 26: --maxOutputBytes allows at most 256 MiB', () => {
  const cli = require('../../lib/cli-options');
  after(() => cli.setOptions({workerThread: false}));

  it('16 MiB by default; 1 to 268435456 accepted; anything else stops the start with the bound in its text', () => {
    cli.setOptions({workerThread: false});
    assert.strictEqual(cli.maxOutputBytes, 16777216);
    assert.strictEqual(cli.validatorLimitInvalid, null);
    // one default, stated in four places: the flag's, the settings tool's
    // (what its `get` reports with no file; ch-local's lib/settings.js is
    // kept in step with it), and the fallbacks of the two bounds that read
    // the option (module-loading 28 holds capFor's)
    assert.strictEqual(require('../../lib/settings-tool').ALLOWLIST.maxOutputBytes.default, cli.maxOutputBytes);
    for (const v of [1, 8388608, 16777216, 268435456]) {
      cli.setOptions({workerThread: false, maxOutputBytes: v});
      assert.strictEqual(cli.validatorLimitInvalid, null, String(v));
    }
    for (const v of [268435457, 0, -1, 1.5, 'lots']) {
      cli.setOptions({workerThread: false, maxOutputBytes: v});
      assert.deepStrictEqual(cli.validatorLimitInvalid, {name: 'maxOutputBytes', value: v, what: 'a positive integer, at most 268435456'}, String(v));
    }
  });
});
