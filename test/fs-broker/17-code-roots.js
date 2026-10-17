// countinghouse's code roots (lib/fs-broker/identity.js codeRootsFor): its
// own entries plus its dependency closure, computed once per process (the
// install does not change while it runs; plan 5 benchmark: ~80 ms per spawn
// uncached), with each call's module roots still subtracted.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const identity = require('../../lib/fs-broker/identity');

describe('fs-broker 17: code roots', () => {
  const installDir = fs.realpathSync(path.join(__dirname, '..', '..'));

  it('computes the closure once per process; exclusions apply on every call', () => {
    let calls = 0;
    const counting = (p) => { calls++; return fs.realpathSync(p); };
    const first = identity.codeRootsFor(installDir, counting, []);
    const afterFirst = calls;
    const second = identity.codeRootsFor(installDir, counting, []);
    assert.deepStrictEqual(second, first);
    assert.strictEqual(calls - afterFirst, 0, 'the second call resolves nothing again');
    const ajv = first.find((r) => r.endsWith(`${path.sep}node_modules${path.sep}ajv`));
    assert.ok(ajv, 'ajv is one of countinghouse\'s dependencies');
    const excluded = identity.codeRootsFor(installDir, counting, [ajv]);
    assert.ok(!excluded.includes(ajv), 'a module root is subtracted even from the cached closure');
    assert.strictEqual(excluded.length, first.length - 1);
  });
});
