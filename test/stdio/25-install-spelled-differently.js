// An install run by a spelling that isn't its real path (#272). On Windows,
// a runtime installed under os.tmpdir() on GitHub's runner runs from
// C:\Users\RUNNER~1\... (an 8.3 short name), while realpath gives the long
// form; countinghouse's code roots were listed long only, so under enforce
// every module worker died loading countinghouse's own lazily required files
// (ENOENT, realpath ...\lib\thread-info.js), and no module tool was listed.
// Here a copy of the runtime is installed under os.tmpdir() as spelled (its
// node_modules a junction to this checkout's) and a module loaded under
// enforce must be listed and answer. Elsewhere the same copy runs as a plain
// regression check: Node runs a POSIX main file by its real path.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, waitForTool, withoutRedisNoise, INITIALIZE} = require('../helpers/stdio-client');

const ROOT = path.join(__dirname, '..', '..');
const MODULE = path.join(ROOT, 'test', 'fixtures', 'win-probe');
const KEY = 'spelled-install-key';
const WIN = process.platform === 'win32';

describe('stdio 25: an install run by a spelling that isn\'t its real path (#272)', function() {
  this.timeout(180000);
  let base = null;
  let io = null;
  after(async () => {
    if (io != null) await io.stop();
    if (base != null) fs.rmSync(base, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  });

  it('under enforce a module loads and answers: countinghouse\'s own files stay its own', async () => {
    // os.tmpdir() as it is spelled, never resolved
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-spelled-'));
    const install = path.join(base, 'install');
    for (const p of ['framework.js', 'package.json', 'bin', 'lib', 'pre-installed-packages']) fs.cpSync(path.join(ROOT, p), path.join(install, p), {recursive: true});
    fs.mkdirSync(path.join(install, 'spec'));
    fs.copyFileSync(path.join(ROOT, 'spec', 'schema.json'), path.join(install, 'spec', 'schema.json'));
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(install, 'node_modules'), 'junction');
    const real = fs.realpathSync.native(install);
    // what this run checks: on GitHub's windows-latest, a short-name spelling
    if (WIN) console.log(`      install as spelled: ${install}${real !== install ? `; real: ${real}` : ' (its real path: no short name here)'}`);
    const auth = path.join(base, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'probe', devices: ['*']}}));
    io = startStdio(['--workerThread', '--moduleSandbox', 'enforce', '--debug', '--loadModule', MODULE, '--authConfigPath', auth,
      '--moduleDataPath', path.join(base, 'module_data'), '--redisUrl', 'redis://127.0.0.1:9749'],
    {env: {COUNTINGHOUSE_API_KEY: KEY}, entry: path.join(install, 'bin', 'countinghouse-stdio.js')});
    await io.request({...INITIALIZE, id: 1});
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
    const tool = await waitForTool(io, /win_probe_probeservice_probe$/, {deadlineMs: 60000});
    assert.ok(tool != null, `the module's tool is not listed; stderr: ${withoutRedisNoise(io.err).slice(-4000)}`);
    const r = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: tool.name, arguments: {}}});
    const checks = r.result && r.result.structuredContent ? r.result.structuredContent.checks : null;
    assert.ok(Array.isArray(checks) && checks.length > 0, `no checks: ${JSON.stringify(r).slice(0, 2000)}; stderr: ${withoutRedisNoise(io.err).slice(-3000)}`);
    // its own file read through __dirname: the worker is whole
    const own = checks.find((c) => c.name === 'readFileSync own file via __dirname');
    assert.ok(own != null && /^hello from the module\r?\n$/.test(own.value), JSON.stringify(own));
  });
});
