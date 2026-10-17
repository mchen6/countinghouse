const assert = require('assert');
const path = require('path');
const {runBrokered} = require('../helpers/brokered-worker');

const SCRIPT = path.join(__dirname, 'scripts', 'differential.js');

describe('fs-broker 08: brokered fs matches real fs', function() {
  this.timeout(60000);

  it('gives the same results and error codes for the same operations', async () => {
    const real = await runBrokered(SCRIPT, {patch: false});
    const brokered = await runBrokered(SCRIPT, {patch: true});
    assert.strictEqual(real.ok, true, JSON.stringify(real));
    assert.strictEqual(brokered.ok, true, JSON.stringify(brokered));
    for (let i = 0; i < Math.max(real.r.length, brokered.r.length); i++) {
      assert.deepStrictEqual(brokered.r[i], real.r[i], `step ${i}: ${JSON.stringify(real.r[i])}`);
    }
  });
});
