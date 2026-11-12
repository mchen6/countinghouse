// countinghouse 8 needs Node 22.16, the first 22 with module.registerHooks.
// Below 24.15 those hooks do not see require.resolve or
// createRequire().resolve, so a compatibility shim routes them through the
// sandbox's hooks (lib/module-lockdown.js; docs/superpowers/specs/
// 2026-11-11-node-floor-shim-design.md). Older Node fails fast at startup.
const assert = require('assert');
const nodeVersion = require('../../lib/node-version');

describe('sandbox 10: Node version floor', () => {
  it('accepts 22.16.0 and later', () => {
    ['v22.16.0', 'v22.23.4', 'v24.0.0', 'v24.14.1', 'v24.15.0', 'v24.22.2', 'v25.0.0', 'v26.12.0'].forEach((v) => assert.strictEqual(nodeVersion.supported(v), true, v));
  });

  it('refuses anything older', () => {
    ['v18.0.0', 'v20.20.2', 'v22.0.0', 'v22.15.1', 'v21.7.3'].forEach((v) => assert.strictEqual(nodeVersion.supported(v), false, v));
  });

  it('says what it needs and what it got', () => {
    assert.strictEqual(nodeVersion.message('v20.20.2'), 'countinghouse 8 needs Node 22.16 or later (this is v20.20.2)');
  });

  it('accepts the Node running this test', () => {
    assert.strictEqual(nodeVersion.supported(process.version), true);
  });

  it('needs the resolve shim below 24.15 only', () => {
    ['v22.16.0', 'v22.23.4', 'v24.0.0', 'v24.14.1', 'v24.14.9'].forEach((v) => assert.strictEqual(nodeVersion.needsResolveShim(v), true, v));
    ['v24.15.0', 'v24.22.2', 'v26.12.0'].forEach((v) => assert.strictEqual(nodeVersion.needsResolveShim(v), false, v));
    assert.strictEqual(nodeVersion.NEEDS_RESOLVE_SHIM, nodeVersion.needsResolveShim(process.version));
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
