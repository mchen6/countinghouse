// --moduleSandbox enforce refuses to start on Windows, with a plain message
// naming the follow-up issue and audit as the Windows mode for now, until a
// module's identity is designed for Windows file URLs (#195): no one runs
// "enforce" on Windows believing it holds. The rule is by platform, so it is
// checked on every OS; the start itself on Windows only.
const assert = require('assert');
const path = require('path');
const {spawnSync} = require('child_process');
const {platformRefusal, ISSUE} = require('../../lib/sandbox-platform');
const {testPort} = require('../helpers/test-env');

const ROOT = path.join(__dirname, '..', '..');

describe('stdio 15: --moduleSandbox enforce on Windows (#195)', function() {
  this.timeout(60000);

  it('the rule: enforce on win32 is refused with the issue and audit named; every other mode and platform is not', () => {
    const msg = platformRefusal('enforce', 'win32');
    assert.ok(msg != null && msg.includes(ISSUE), msg);
    assert.match(msg, /not available on Windows yet/);
    assert.match(msg, /--moduleSandbox audit, the Windows mode for now/);
    for (const [mode, platform] of [['audit', 'win32'], ['off', 'win32'], ['enforce', 'linux'], ['enforce', 'darwin']]) {
      assert.strictEqual(platformRefusal(mode, platform), null, `${mode} on ${platform}`);
    }
  });

  it('on Windows: a start with --moduleSandbox enforce exits 2 with the message, and serves nothing', function() {
    if (process.platform !== 'win32') this.skip();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'framework.js'), '--workerThread', '--moduleSandbox', 'enforce', '--port', String(testPort(9791))],
      {encoding: 'utf8', timeout: 30000});
    assert.strictEqual(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes(platformRefusal('enforce', 'win32')), r.stderr);
  });
});
