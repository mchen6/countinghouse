// S1: the device-spec fields rateLimit and price are CDIF-era and retired.
// price was read by nothing; rateLimit was read only by the per-device
// limiter (DeviceManager.createRateLimiterForDevice, Redis db 9). A spec
// that still carries them loads and validates (the schema doesn't close
// `device`), is not limited, and countinghouse-validate warns about each.
// The per-key (--apiKeyRateLimit) and global (--globalRateLimit) limits and
// M4's job bounds are the replacements.
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const {spawnSync} = require('child_process');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {mkdtemp} = require('../helpers/test-tmp');

const PORT    = 9655;
const CALLER  = `s1-caller-${process.pid}`;
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'retired-device-fields');
const TOOL    = 'retired_device_fields_greetservice_hello';

describe('auth 45: the retired device fields rateLimit and price (S1)', function() {
  this.timeout(60000);
  let server = null;
  let dir = null;

  before(async () => {
    dir = mkdtemp('s1-');
    const authPath = path.join(dir, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({[CALLER]: {userName: 's1', devices: ['*']}}));
    // Not --debug: the per-device limiter never ran under --debug.
    server = await startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', authPath, '--loadModule', FIXTURE]);
  });
  after(() => {
    stopServer(server);
    if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
  });

  it('a spec with rateLimit: 1 is not limited: two calls in quick succession both succeed', async () => {
    const [a, b] = await Promise.all([mcpCall(PORT, CALLER, TOOL, {name: 'a'}), mcpCall(PORT, CALLER, TOOL, {name: 'b'})]);
    assert.strictEqual(a.isError, false, JSON.stringify(a));
    assert.strictEqual(b.isError, false, JSON.stringify(b));
  });

  it('countinghouse-validate warns about each retired field, and still passes', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'countinghouse-validate.js'), FIXTURE], {encoding: 'utf8', timeout: 30000});
    assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(r.stdout.includes('`rateLimit` is no longer read; use --apiKeyRateLimit or --globalRateLimit'), r.stdout);
    assert.ok(r.stdout.includes('`price` is no longer read'), r.stdout);
  });
});
