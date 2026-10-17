// countinghouse 8 needs Node 22.16 (module.registerHooks, Worker
// getHeapStatistics, --permission). Older Node fails fast at startup.
const assert = require('assert');
const nodeVersion = require('../../lib/node-version');

describe('sandbox 10: Node version floor', () => {
  it('accepts 22.16.0 and later', () => {
    ['v22.16.0', 'v22.20.1', 'v23.0.0', 'v24.21.0'].forEach((v) => assert.strictEqual(nodeVersion.supported(v), true, v));
  });

  it('refuses anything older', () => {
    ['v20.20.2', 'v22.0.0', 'v22.15.9', 'v18.0.0'].forEach((v) => assert.strictEqual(nodeVersion.supported(v), false, v));
  });

  it('says what it needs and what it got', () => {
    assert.strictEqual(nodeVersion.message('v20.20.2'), 'countinghouse 8 needs Node 22.16 or later (this is v20.20.2)');
  });

  it('accepts the Node running this test', () => {
    assert.strictEqual(nodeVersion.supported(process.version), true);
  });
});
