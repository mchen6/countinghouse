// Issue #40: on Windows a module worker's start stopped after "file broker:
// <module> spawn walk", with no error, under --moduleSandbox audit and off
// alike. lib/module-data.js ensureDirs chmod'ed from the directory it asked
// for up to the first one mkdir reported creating, comparing the two as
// strings; on Windows mkdir answers in Node's namespaced form (\\?\C:\...),
// the strings never met, and the walk passed the root and spun there. The
// walk is gone: data and tmp, by their known paths, are made 0700. These
// cases run where the stdio job runs (ubuntu, macos, windows).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {startStdio, waitForTool, withoutRedisNoise, INITIALIZE} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_DATA = path.join(ROOT, 'lib', 'module-data.js');
const WIN = process.platform === 'win32';
const posixIt = WIN ? it.skip : it;

// os.tmpdir() as Node gives it (an 8.3 short name on the Windows runner) and
// its real path (the long name): the two bases #40 was seen under. Cases
// that need neither use test/.tmp (test/helpers/test-tmp.js).
const BASES = [['os.tmpdir() as given', () => os.tmpdir()], ['os.tmpdir() real path', () => fs.realpathSync.native(os.tmpdir())]];

// A test directory's removal, retried: on Windows a process just ended can
// still hold handles under it for a moment.
function remove(dir) {
  if (dir != null) fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
}

// ensureDirs(<dataRoot>, 'probe') in a child Node, so a call that never
// settles is killed with it: its directories, or why not. `umask`, when
// given, is the child's.
function ensureDirsInChild(dataRoot, umask = null) {
  const r = spawnSync(process.execPath, ['-e', `
    if (process.argv[3] !== '') process.umask(parseInt(process.argv[3], 8));
    require(process.argv[1]).ensureDirs(process.argv[2], 'probe')
      .then((d) => process.stdout.write(JSON.stringify(d)), (e) => { process.stderr.write(String(e && e.message)); process.exit(1); });`,
  MODULE_DATA, dataRoot, umask == null ? '' : umask.toString(8)], {encoding: 'utf8', timeout: 10000});
  const timedOut = r.error != null && r.error.code === 'ETIMEDOUT';
  assert.ok(!timedOut, 'ensureDirs did not settle in 10 s');
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const modeOf = (p) => fs.statSync(p).mode & 0o777;

// Every directory from `p` up to the root, with its mode.
function modesAbove(p) {
  const out = [];
  for (;;) {
    out.push([p, fs.statSync(p).mode]);
    if (path.dirname(p) === p) return out;
    p = path.dirname(p);
  }
}

describe('stdio 03: module data directories (issue #40)', function() {
  this.timeout(30000);
  let home = null;
  afterEach(() => { remove(home); home = null; });

  for (const [label, base] of BASES) {
    it(`ensureDirs settles and makes data and tmp, 0700 where modes apply (${label})`, () => {
      home = fs.mkdtempSync(path.join(base(), 'ch-dirs-'));
      const d = ensureDirsInChild(path.join(home, 'module_data'));
      for (const dir of [d.data, d.tmp]) {
        assert.ok(fs.statSync(dir).isDirectory(), dir);
        if (!WIN) assert.strictEqual(modeOf(dir), 0o700, dir);
      }
    });
  }

  // A data path that names its directory in another string: through a link
  // (a junction on Windows), or through "x<sep>.." (which dirsFor resolves
  // before mkdir sees it; the case pins that it stays so). Every directory
  // that was there before keeps its mode.
  const SHAPES = [
    ['a symlinked data path', (real) => {
      const link = path.join(home, 'link');
      fs.symlinkSync(real, link, WIN ? 'junction' : 'dir');
      return link;
    }],
    ['a data path through x and ..', (real) => `${real}${path.sep}x${path.sep}..`]
  ];
  for (const [label, shape] of SHAPES) {
    it(`${label}: ensureDirs settles and leaves every directory above data and tmp as it was`, () => {
      home = tmp.mkdtemp('ch-dirs-');
      const real = path.join(home, 'base');
      fs.mkdirSync(real);
      if (!WIN) { fs.chmodSync(home, 0o755); fs.chmodSync(real, 0o755); }
      const before = modesAbove(real);
      ensureDirsInChild(`${shape(real)}${path.sep}module_data`);
      assert.deepStrictEqual(modesAbove(real), before);
      assert.ok(fs.statSync(path.join(real, 'module_data', 'probe', 'data')).isDirectory());
      assert.ok(fs.statSync(path.join(real, 'module_data', 'probe', 'tmp')).isDirectory());
    });
  }

  posixIt('under umask 0 every directory mkdir makes is 0700 (a umask can only clear bits)', () => {
    home = tmp.mkdtemp('ch-dirs-');
    const d = ensureDirsInChild(path.join(home, 'module_data'), 0);
    for (const dir of [path.join(home, 'module_data'), d.root, d.data, d.tmp]) assert.strictEqual(modeOf(dir), 0o700, dir);
  });

  posixIt('a data and tmp already there with other modes are made 0700 on the next start; the directories above are not', () => {
    home = tmp.mkdtemp('ch-dirs-');
    const root = path.join(home, 'module_data', 'probe');
    fs.mkdirSync(path.join(root, 'data'), {recursive: true});
    fs.mkdirSync(path.join(root, 'tmp'));
    fs.chmodSync(path.join(home, 'module_data'), 0o750);
    fs.chmodSync(root, 0o750);
    fs.chmodSync(path.join(root, 'data'), 0o755);
    fs.chmodSync(path.join(root, 'tmp'), 0o750);
    const d = ensureDirsInChild(path.join(home, 'module_data'));
    assert.strictEqual(modeOf(d.data), 0o700);
    assert.strictEqual(modeOf(d.tmp), 0o700);
    assert.strictEqual(modeOf(root), 0o750);
    assert.strictEqual(modeOf(path.join(home, 'module_data')), 0o750);
  });

  posixIt('a data that is a symbolic link is left alone, and so is what it leads to', () => {
    home = tmp.mkdtemp('ch-dirs-');
    const elsewhere = path.join(home, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.chmodSync(elsewhere, 0o755);
    const root = path.join(home, 'module_data', 'probe');
    fs.mkdirSync(root, {recursive: true});
    fs.symlinkSync(elsewhere, path.join(root, 'data'), 'dir');
    const d = ensureDirsInChild(path.join(home, 'module_data'));
    assert.ok(fs.lstatSync(d.data).isSymbolicLink());
    assert.strictEqual(modeOf(elsewhere), 0o755);
    assert.strictEqual(modeOf(d.tmp), 0o700);
  });
});

// End to end: a start under either mode and either base lists the module's
// tool over MCP. One 60 s budget for initialize and the listing together, so
// the assertion, with the server's stderr, comes before mocha's 90 s; the
// stop's 15 s linger is afterEach's.
describe('stdio 03: a spawned start lists the module (issue #40)', function() {
  this.timeout(90000);
  let home = null;
  let io = null;
  afterEach(async() => {
    if (io != null) await io.stop();
    io = null;
    remove(home); home = null;
  });

  for (const mode of ['off', 'audit']) {
    for (const [label, base] of BASES) {
      it(`--moduleSandbox ${mode} (${label})`, async () => {
        home = fs.mkdtempSync(path.join(base(), 'ch-start-'));
        const auth = path.join(home, 'auth.json');
        fs.writeFileSync(auth, JSON.stringify({'start-key': {userName: 'start', devices: ['*']}}));
        // --redisUrl points where nothing listens (B's port block); nothing here is metered.
        io = startStdio(['--workerThread', '--moduleSandbox', mode, '--loadModule', path.join(ROOT, 'test', 'fixtures', 'handler-map-module'),
          '--authConfigPath', auth, '--moduleDataPath', path.join(home, 'module_data'), '--redisUrl', 'redis://127.0.0.1:9733'],
        {env: {COUNTINGHOUSE_API_KEY: 'start-key'}});
        const until = Date.now() + 60000;
        await io.request(INITIALIZE, 60000);
        const tool = await waitForTool(io, /hello/, {deadlineMs: Math.max(0, until - Date.now())});
        assert.ok(tool, `the tool was not listed in 60 s; stderr without the Redis noise:\n${withoutRedisNoise(io.err, 3000)}`);
      });
    }
  }
});
