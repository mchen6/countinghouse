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

const {execFileSync} = require('child_process');
const pathMod = require('path');

describe('sandbox 10: thread-flag guard (test suite only)', function() {
  this.timeout(30000);
  it('refuses a test server with no thread flag', () => {
    let code = 0, out = '';
    try {
      // thread-flag-check: default on purpose (this test is about the missing flag)
      execFileSync(process.execPath, [pathMod.join(__dirname, '..', '..', 'framework.js'), '--debug', '--bindAddr', '127.0.0.1', '--port', '9624'],
        {env: Object.assign({}, process.env, {COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG: '1'}), stdio: 'pipe', timeout: 15000});
    } catch (e) { code = e.status; out = String(e.stderr); }
    assert.strictEqual(code, 3);
    assert.ok(out.includes('no thread flag given'), out);
  });
});
