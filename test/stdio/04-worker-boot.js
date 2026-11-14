// Issue #40: past ensureDirs (#110), a Windows module worker died at boot
// with "ENOENT ... realpath '<install dir>\lib\cli-options.js'" (fixed by
// lib/fs-broker/roots.js underFor). The worker boots and lists the module's
// tool under --moduleSandbox off and audit; a failure shows the server's
// stderr.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, waitForTool, withoutRedisNoise, INITIALIZE} = require('../helpers/stdio-client');

const ROOT = path.join(__dirname, '..', '..');

describe('stdio 04: the worker boot on every OS (issue #40)', function() {
  this.timeout(90000);
  let home = null;
  let io = null;
  afterEach(async() => {
    if (io != null) await io.stop();
    io = null;
    if (home != null) fs.rmSync(home, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
    home = null;
  });

  for (const mode of ['off', 'audit']) {
    it(`--moduleSandbox ${mode}: the module is listed`, async () => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-boot-'));
      const auth = path.join(home, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({'boot-key': {userName: 'boot', devices: ['*']}}));
      io = startStdio(['--workerThread', '--moduleSandbox', mode, '--loadModule', path.join(ROOT, 'test', 'fixtures', 'handler-map-module'),
        '--authConfigPath', auth, '--moduleDataPath', path.join(home, 'module_data'), '--redisUrl', 'redis://127.0.0.1:9733'],
      {env: {COUNTINGHOUSE_API_KEY: 'boot-key'}});
      const until = Date.now() + 60000;
      await io.request(INITIALIZE, 60000);
      const tool = await waitForTool(io, /hello/, {deadlineMs: Math.max(0, until - Date.now())});
      assert.ok(tool, `the tool was not listed in 60 s; stderr without the Redis noise:\n${withoutRedisNoise(io.err, 3000)}`);
    });
  }
});
