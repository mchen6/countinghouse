// Issue #40: on Windows a module worker's start stops after "file broker:
// <module> spawn walk", with no error, under --moduleSandbox audit and off
// alike. The step every mode runs first is lib/module-data.js ensureDirs,
// which walks from the directory it asked for up to the first one mkdir
// created, comparing the two as strings. These cases run where the stdio job
// runs (ubuntu, macos, windows), under os.tmpdir() as Node gives it (an 8.3
// short name on the Windows runner) and under its real path (the long name).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const moduleData = require('../../lib/module-data');

const ROOT = path.join(__dirname, '..', '..');

// `p` and every directory above it, up to the file system's root.
function ancestors(p) {
  const out = [p];
  while (path.dirname(p) !== p) { p = path.dirname(p); out.push(p); }
  return out;
}

function within(ms, promise, what) {
  let timer = null;
  const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not settle in ${ms} ms`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const BASES = [['os.tmpdir() as given', () => os.tmpdir()], ['os.tmpdir() real path', () => fs.realpathSync.native(os.tmpdir())]];

describe('stdio 03: module data directories (issue #40)', function() {
  this.timeout(30000);
  let home;
  afterEach(() => { if (home != null) fs.rmSync(home, {recursive: true, force: true}); home = null; });

  for (const [label, base] of BASES) {
    it(`mkdir with recursive answers the directory asked for or one above it, as the same string (${label})`, async () => {
      home = fs.mkdtempSync(path.join(base(), 'ch-dirs-'));
      const target = path.join(home, 'module_data', 'probe', 'data');
      const first = await fs.promises.mkdir(target, {recursive: true, mode: 0o700});
      assert.ok(ancestors(target).includes(first), `mkdir answered ${JSON.stringify(first)} for ${JSON.stringify(target)}`);
    });

    it(`ensureDirs settles and makes data and tmp (${label})`, async () => {
      home = fs.mkdtempSync(path.join(base(), 'ch-dirs-'));
      const d = await within(10000, moduleData.ensureDirs(path.join(home, 'module_data'), 'probe'), 'ensureDirs');
      assert.ok(fs.statSync(d.data).isDirectory() && fs.statSync(d.tmp).isDirectory());
    });
  }
});

// The file broker's steps at spawn, traced by COUNTINGHOUSE_TEST_FSB_TRACE=1
// (step names only): where a start that never reaches the worker stops.
describe('stdio 03: the file broker\'s spawn steps, traced (issue #40)', function() {
  this.timeout(60000);
  let home;
  afterEach(() => { if (home != null) fs.rmSync(home, {recursive: true, force: true}); home = null; });

  it('a --moduleSandbox off start passes every step and starts the worker', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-trace-'));
    const auth = path.join(home, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({'trace-key': {userName: 'trace', devices: ['*']}}));
    // --redisUrl points where nothing listens (B's port block); nothing here is metered.
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'countinghouse-stdio.js'), '--workerThread', '--moduleSandbox', 'off',
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'handler-map-module'), '--authConfigPath', auth,
      '--moduleDataPath', path.join(home, 'module_data'), '--redisUrl', 'redis://127.0.0.1:9733'],
    {env: {...process.env, COUNTINGHOUSE_API_KEY: 'trace-key', COUNTINGHOUSE_TEST_FSB_TRACE: '1'}, stdio: ['pipe', 'pipe', 'pipe']});
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stdout.resume();
    const started = new Promise((resolve) => child.stderr.on('data', (d) => { err += d; if (/file broker: handler-map-module step worker started/.test(err)) resolve(); }));
    const exited = new Promise((resolve) => child.on('exit', resolve));
    try {
      await within(45000, started, 'the worker start');
    } catch (e) {
      const steps = err.split('\n').filter((l) => /file broker: handler-map-module/.test(l)).join('\n');
      throw new Error(`${e.message}; the broker's lines:\n${steps}`);
    } finally {
      child.stdin.end();
      if ((await within(15000, exited, 'the exit').catch(() => 'late')) === 'late') child.kill('SIGKILL');
    }
  });
});
