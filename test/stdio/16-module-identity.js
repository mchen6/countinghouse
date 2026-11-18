// A module's view of its own files under --moduleSandbox enforce, on every OS
// (#195). On Linux and macOS its files are /app/...; on Windows they carry
// a drive the host does not have, <V>:\app\... (lib/fs-broker/virtual-drive.js),
// because Node there takes a file URL only with one, and the file broker maps
// <V>:\app back to /app. One module (test/fixtures/win-probe) runs every
// check and reports each, so a run says all that is wrong at once.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, waitForTool, withoutRedisNoise, INITIALIZE} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');

const ROOT = path.join(__dirname, '..', '..');
const MODULE = path.join(ROOT, 'test', 'fixtures', 'win-probe');
const KEY = 'identity-probe-key';
const WIN = process.platform === 'win32';

// The module's own file as it should see it: /app/... or <V>:\app\... .
const own = (rel) => new RegExp(WIN ? `^[A-Z]:\\\\app\\\\${rel.split('/').join('\\\\')}$` : `^/app/${rel}$`);

const EXPECT = {
  // the runtime's files each loaded once (stdio 26)
  'runtime files loaded twice': (c) => c.ok && c.value.files > 0 && c.value.twice.length === 0,
  '__filename': (c) => own('handlers/probeService/probe.js').test(c.value),
  '__dirname': (c) => own('handlers/probeService').test(c.value),
  'process.cwd()': (c) => (WIN ? /^[A-Z]:\\app$/ : /^\/app$/).test(c.value),
  'os.tmpdir()': (c) => c.value === '/tmp',
  'path.resolve(x)': (c) => own('x').test(c.value),
  'require ../../lib/sub': (c) => c.ok && c.value.sub === true && own('lib/sub.js').test(c.value.file),
  'require.resolve ../../lib/sub': (c) => own('lib/sub.js').test(c.value),
  'require probe-dep': (c) => c.ok && c.value.dep === true && own('node_modules/probe-dep/index.js').test(c.value.file),
  'import esm': (c) => c.ok && c.value.esm === true,
  // (git may check the file out with CRLF on Windows)
  'readFileSync own file via __dirname': (c) => /^hello from the module\r?\n$/.test(c.value),
  'readdirSync own dir': (c) => c.ok && c.value.includes('data.txt') && c.value.includes('sub.js'),
  'statSync own file isFile': (c) => c.value === true,
  'promises.readFile own file': (c) => /^hello from the module\r?\n$/.test(c.value),
  'existsSync own file': (c) => c.value === true,
  'write /data then read': (c) => c.value === 'w',
  'write path.join(/data) then read': (c) => c.value === 'j',
  'write tmpdir then read': (c) => c.value === 't',
  'write own file (refused)': (c) => !c.ok && ['EROFS', 'EACCES', 'EPERM'].includes(c.code),
  'read outside (refused)': (c) => !c.ok && ['ENOENT', 'EACCES', 'EPERM'].includes(c.code),
  'stack frame path': (c) => c.ok && (WIN ? /[A-Z]:\\app\\handlers/ : /\/app\/handlers/).test(c.value),
  'require module is the reduced one': (c) => c.value === true,
  'CHUtil.loadFile own file': (c) => c.value === true,
  'write path.resolve(/data) then read': (c) => c.value === 'r',
  'write path.resolve(tmpdir) then read': (c) => c.value === 't2',
  'readFileSync a file URL of its own': (c) => /^hello from the module\r?\n$/.test(c.value),
  'globSync with the default cwd': (c) => c.ok && c.value.map((p) => p.replace(/\\/g, '/')).includes('lib/data.txt'),
  'import a "type": "module" package file': (c) => c.value === true,
  // only its own lookup paths: none of the host's (the install, the home directory)
  'require.resolve.paths are its own': (c) => c.ok && c.value.length > 0 && c.value.every((p) => (WIN ? /^[A-Z]:\\(app\\|node_modules$)/ : /^\/(app\/|node_modules$)/).test(p))
};

// (each start with the test's late-load probe, --testLateLoads: since
// #194's PR 2 its fixtures reach a runtime object only through the
// probe's hand-over, module code's own require.cache holding its own files)
describe('stdio 16: a module\'s own files under enforce, as it sees them (#195)', function() {
  this.timeout(120000);
  let home = null;
  let io = null;
  before(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-identity-')); });
  after(async () => {
    if (io != null) await io.stop();
    tmp.remove(home);
  });

  it('every check: its files and directory, the cwd, requires and imports, reads, writes where it may, refusals where it may not', async () => {
    const auth = path.join(home, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'probe', devices: ['*']}}));
    io = startStdio(['--testLateLoads', '--workerThread', '--moduleSandbox', 'enforce', '--debug', '--loadModule', MODULE, '--authConfigPath', auth,
      '--moduleDataPath', path.join(home, 'module_data'), '--redisUrl', 'redis://127.0.0.1:9749'],
    {env: {COUNTINGHOUSE_API_KEY: KEY}});
    await io.request({...INITIALIZE, id: 1});
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
    const tool = await waitForTool(io, /win_probe_probeservice_probe$/, {deadlineMs: 30000});
    assert.ok(tool != null, `the module's tool is not listed; stderr: ${withoutRedisNoise(io.err).slice(-4000)}`);
    const r = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: tool.name, arguments: {}}});
    const checks = r.result && r.result.structuredContent ? r.result.structuredContent.checks : null;
    assert.ok(Array.isArray(checks), `no checks: ${JSON.stringify(r).slice(0, 2000)}; stderr: ${withoutRedisNoise(io.err).slice(-3000)}`);
    const wrong = checks.filter((c) => EXPECT[c.name] == null || !EXPECT[c.name](c));
    const missing = Object.keys(EXPECT).filter((n) => !checks.some((c) => c.name === n));
    assert.deepStrictEqual({wrong, missing}, {wrong: [], missing: []},
      `on ${process.platform}: ${JSON.stringify(checks, null, 1)}\nstderr: ${withoutRedisNoise(io.err).slice(-3000)}`);
  });
});
