// Draft #40 diagnostic, not for merge: past ensureDirs (#110), a Windows
// module worker died at boot with "ENOENT ... realpath
// '<install dir>\lib\cli-options.js'". With COUNTINGHOUSE_TEST_FSB_TRACE=1
// the boot's refusals name themselves (lib/fs-broker/patch.js bootRefusal):
// the call, the path as given, the boot roots, and whether the path is
// under one by "/" and by path.sep. This case prints them on any system.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, waitForTool, withoutRedisNoise, INITIALIZE} = require('../helpers/stdio-client');

const ROOT = path.join(__dirname, '..', '..');

describe('stdio 04 (draft): the worker boot\'s refusals, traced (issue #40)', function() {
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
    it(`--moduleSandbox ${mode}: the module is listed, and the boot's refusals are shown`, async () => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-boot-'));
      const auth = path.join(home, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({'boot-key': {userName: 'boot', devices: ['*']}}));
      io = startStdio(['--workerThread', '--moduleSandbox', mode, '--loadModule', path.join(ROOT, 'test', 'fixtures', 'handler-map-module'),
        '--authConfigPath', auth, '--moduleDataPath', path.join(home, 'module_data'), '--redisUrl', 'redis://127.0.0.1:9733'],
      {env: {COUNTINGHOUSE_API_KEY: 'boot-key', COUNTINGHOUSE_TEST_FSB_TRACE: '1'}});
      const until = Date.now() + 60000;
      await io.request(INITIALIZE, 60000);
      const tool = await waitForTool(io, /hello/, {deadlineMs: Math.max(0, until - Date.now())});
      const refused = io.err.split('\n').filter((l) => /boot refused|worker exit on error/.test(l)).join('\n');
      process.stdout.write(`      [${mode}] the boot's refusals:\n${refused || '      (none)'}\n`);
      assert.ok(tool, `the tool was not listed in 60 s; the boot's refusals:\n${refused}\nstderr without the Redis noise:\n${withoutRedisNoise(io.err, 3000)}`);
    });
  }
});
