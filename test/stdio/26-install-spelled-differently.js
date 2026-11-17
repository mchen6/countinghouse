// An install run by a spelling that isn't its real path (#272). On Windows,
// a runtime installed under os.tmpdir() on GitHub's runner runs from
// C:\Users\RUNNER~1\... (an 8.3 short name), while realpath gives the long
// form. countinghouse's code roots were listed long only, so under enforce
// every module worker died loading countinghouse's own lazily required files
// (ENOENT, realpath ...\lib\thread-info.js), and no module tool was listed.
//
// Here a copy of the runtime is reached through a junction (a symlink off
// Windows) and run by that spelling, as Node keeps it with
// --preserve-symlinks-main (a POSIX main file otherwise runs by its real
// path). On Windows the copy is under os.tmpdir() as spelled, so a
// short-name component is in play too. A module loaded under enforce must be
// listed and answer.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, waitForTool, withoutRedisNoise, INITIALIZE} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');
const {testPort} = require('../helpers/test-env');

const ROOT = path.join(__dirname, '..', '..');
const MODULE = path.join(ROOT, 'test', 'fixtures', 'win-probe');
const KEY = 'spelled-install-key';
const WIN = process.platform === 'win32';

describe('stdio 26: an install run by a spelling that isn\'t its real path (#272)', function() {
  this.timeout(180000);
  let base = null;
  let links = [];
  let io = null;
  after(async () => {
    if (io != null) await io.stop();
    // the links first, so the removal never follows one into the checkout
    for (const l of links) { try { fs.unlinkSync(l); } catch (e) { try { fs.rmdirSync(l); } catch (e2) { /* gone */ } } }
    if (base != null) fs.rmSync(base, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  });

  it('under enforce a module loads and answers: countinghouse\'s own files and dependencies stay its own', async () => {
    // on Windows os.tmpdir() as it is spelled (never resolved); elsewhere test/.tmp
    base = WIN ? fs.mkdtempSync(path.join(os.tmpdir(), 'ch-spelled-')) : tmp.mkdtemp('ch-spelled-');
    const copy = path.join(base, 'copy');
    for (const p of ['framework.js', 'package.json', 'bin', 'lib', 'pre-installed-packages']) fs.cpSync(path.join(ROOT, p), path.join(copy, p), {recursive: true});
    fs.mkdirSync(path.join(copy, 'spec'));
    fs.copyFileSync(path.join(ROOT, 'spec', 'schema.json'), path.join(copy, 'spec', 'schema.json'));
    const nodeModules = path.join(copy, 'node_modules');
    fs.symlinkSync(path.join(ROOT, 'node_modules'), nodeModules, 'junction');
    const install = path.join(base, 'install');
    fs.symlinkSync(copy, install, 'junction');
    links = [install, nodeModules];
    const real = fs.realpathSync.native(install);
    assert.notStrictEqual(real, install, 'the install is run by a spelling that isn\'t its real path');
    if (WIN) console.log(`      install as spelled: ${install}; real: ${real}`);
    const auth = path.join(base, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'probe', devices: ['*']}}));
    io = startStdio(['--workerThread', '--moduleSandbox', 'enforce', '--debug', '--loadModule', MODULE, '--authConfigPath', auth,
      '--moduleDataPath', path.join(base, 'module_data'), '--redisUrl', `redis://127.0.0.1:${testPort(9749)}`],
    {env: {COUNTINGHOUSE_API_KEY: KEY}, entry: path.join(install, 'bin', 'countinghouse-stdio.js'), nodeArgs: ['--preserve-symlinks', '--preserve-symlinks-main']});
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
    const twice = checks.find((c) => c.name === 'runtime files loaded twice');
    assert.ok(twice != null && twice.ok && twice.value.files > 0, JSON.stringify(twice));
    assert.deepStrictEqual(twice.value.twice, [], JSON.stringify(twice));
  });

  // ch-local runs an install under its home, which on GitHub's Windows runner
  // is under os.tmpdir()'s 8.3 short name, by that spelling and with no
  // --preserve-symlinks: the loader then realpaths what it requires, and once
  // the file broker is installed that realpath is the native one, which gives
  // the long name. A worker started by the short spelling had two instances
  // of a file required before and after (fs-broker/identity.js), and every
  // module failed: Cannot find module '/app/handlers/...'. The worker is
  // started by its native real path (lib/fs-broker/worker-entry.js).
  it('a copy run by its plain spelling (on Windows the short name), with no symlink flags: a module under enforce loads and answers', async () => {
    if (io != null) { await io.stop(); io = null; }
    const plain = WIN ? fs.mkdtempSync(path.join(os.tmpdir(), 'ch-plain-')) : tmp.mkdtemp('ch-plain-');
    try {
      const copy = path.join(plain, 'copy');
      for (const p of ['framework.js', 'package.json', 'bin', 'lib', 'pre-installed-packages']) fs.cpSync(path.join(ROOT, p), path.join(copy, p), {recursive: true});
      fs.mkdirSync(path.join(copy, 'spec'));
      fs.copyFileSync(path.join(ROOT, 'spec', 'schema.json'), path.join(copy, 'spec', 'schema.json'));
      fs.cpSync(path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules'), {recursive: true});
      if (WIN) console.log(`      copy as spelled: ${copy}; real: ${fs.realpathSync.native(copy)}`);
      const auth = path.join(plain, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'probe', devices: ['*']}}));
      io = startStdio(['--workerThread', '--moduleSandbox', 'enforce', '--debug', '--loadModule', MODULE, '--authConfigPath', auth,
        '--moduleDataPath', path.join(plain, 'module_data'), '--redisUrl', `redis://127.0.0.1:${testPort(9749)}`],
      {env: {COUNTINGHOUSE_API_KEY: KEY}, entry: path.join(copy, 'bin', 'countinghouse-stdio.js')});
      await io.request({...INITIALIZE, id: 1});
      io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
      const tool = await waitForTool(io, /win_probe_probeservice_probe$/, {deadlineMs: 60000});
      assert.ok(tool != null, `the module's tool is not listed; stderr: ${withoutRedisNoise(io.err).slice(-4000)}`);
      const r = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: tool.name, arguments: {}}});
      assert.ok(r.result != null && r.result.isError !== true, `${JSON.stringify(r).slice(0, 2000)}; stderr: ${withoutRedisNoise(io.err).slice(-3000)}`);
      // each of the runtime's files loaded once, by one spelling
      const twice = r.result.structuredContent.checks.find((c) => c.name === 'runtime files loaded twice');
      assert.ok(twice != null && twice.ok && twice.value.files > 0, JSON.stringify(twice));
      assert.deepStrictEqual(twice.value.twice, [], JSON.stringify(twice));
    } finally {
      if (io != null) { await io.stop(); io = null; }
      fs.rmSync(plain, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
    }
  });
});
