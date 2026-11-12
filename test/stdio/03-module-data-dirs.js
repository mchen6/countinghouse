// Issue #40: on Windows a module worker's start stopped after "file broker:
// <module> spawn walk", with no error, under --moduleSandbox audit and off
// alike. lib/module-data.js ensureDirs chmod'ed from the directory it asked
// for up to the first one mkdir created, comparing the two as strings; on
// Windows mkdir answers in Node's namespaced form (\\?\C:\...), the strings
// never met, and the walk passed the root and spun there. These cases run
// where the stdio job runs (ubuntu, macos, windows).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn, spawnSync} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_DATA = path.join(ROOT, 'lib', 'module-data.js');
const WIN = process.platform === 'win32';

// os.tmpdir() as Node gives it (an 8.3 short name on the Windows runner) and
// its real path (the long name).
const BASES = [['os.tmpdir() as given', () => os.tmpdir()], ['os.tmpdir() real path', () => fs.realpathSync.native(os.tmpdir())]];

// A test directory's removal, retried: on Windows a process just ended can
// still hold handles under it for a moment.
function remove(dir) {
  if (dir != null) fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
}

// Runs `script` in a child Node (argv[1] is lib/module-data.js, then `args`),
// so a walk that never ends is killed with it instead of running on here.
function inChild(script, args, timeoutMs = 10000) {
  const r = spawnSync(process.execPath, ['-e', script, MODULE_DATA, ...args], {encoding: 'utf8', timeout: timeoutMs});
  return {timedOut: r.error != null && r.error.code === 'ETIMEDOUT', status: r.status, out: r.stdout, err: r.stderr};
}

// ensureDirs(<base><sep>module_data, 'probe') in a child, the base kept as
// the string given: its directories, or why not.
function ensureDirsInChild(base) {
  return inChild(`
    require(process.argv[1]).ensureDirs(process.argv[2], 'probe')
      .then((d) => process.stdout.write(JSON.stringify(d)), (e) => { process.stderr.write(String(e && e.message)); process.exit(1); });`,
  [`${base}${base.endsWith(path.sep) ? '' : path.sep}module_data`]);
}

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
  let link = null;
  afterEach(() => {
    if (link != null) { try { fs.unlinkSync(link); } catch (e) { /* gone */ } link = null; }
    remove(home); home = null;
  });

  for (const [label, base] of BASES) {
    it(`ensureDirs settles and makes data and tmp, 0700 where modes apply (${label})`, () => {
      home = fs.mkdtempSync(path.join(base(), 'ch-dirs-'));
      const r = ensureDirsInChild(home);
      assert.ok(!r.timedOut, 'ensureDirs did not settle in 10 s');
      assert.strictEqual(r.status, 0, r.err);
      const d = JSON.parse(r.out);
      for (const dir of [d.root, d.data, d.tmp]) {
        assert.ok(fs.statSync(dir).isDirectory(), dir);
        if (!WIN) assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700, dir);
      }
    });
  }

  // A base that names the same directory in another string: through a link,
  // with a trailing separator, or through "x<sep>..". Every directory that
  // was there before keeps its mode.
  const SHAPES = [
    ['a symlinked base', (real) => {
      link = path.join(os.tmpdir(), `ch-dirs-link-${process.pid}`);
      fs.symlinkSync(real, link, WIN ? 'junction' : 'dir');
      return link;
    }],
    ['a base with a trailing separator', (real) => `${real}${path.sep}`],
    ['a base through x and ..', (real) => `${real}${path.sep}x${path.sep}..`]
  ];
  for (const [label, shape] of SHAPES) {
    it(`${label}: ensureDirs settles and leaves every directory above its own as it was`, () => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-dirs-'));
      const real = path.join(home, 'base');
      fs.mkdirSync(real);
      if (!WIN) { fs.chmodSync(home, 0o755); fs.chmodSync(real, 0o755); }
      const before = modesAbove(real);
      const r = ensureDirsInChild(shape(real));
      assert.ok(!r.timedOut, 'ensureDirs did not settle in 10 s');
      assert.strictEqual(r.status, 0, r.err);
      assert.deepStrictEqual(modesAbove(real), before);
      assert.ok(fs.statSync(path.join(real, 'module_data', 'probe', 'data')).isDirectory());
      assert.ok(fs.statSync(path.join(real, 'module_data', 'probe', 'tmp')).isDirectory());
    });
  }

  // mkdir's real answer, rewritten into another string for the same
  // directory: the walk still meets it, and chmods exactly what was created.
  // Through "x<sep>.." everywhere (on master the walk passed the root and
  // spun); on Windows also with \\?\ and in upper case.
  const FORMS = [['through x and ..', '(f) => f + path.sep + "x" + path.sep + ".."']].concat(WIN ? [
    ['namespaced', '(f) => path.toNamespacedPath(f)'],
    ['in upper case', '(f) => f.toUpperCase()']
  ] : []);
  for (const [label, rewrite] of FORMS) {
    it(`an answer from mkdir in another form of the same directory (${label}) is met, and only what mkdir created is chmod'ed`, () => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-dirs-'));
      const r = inChild(`
        const fs = require('fs'); const path = require('path');
        const realMkdir = fs.promises.mkdir; const rewrite = ${rewrite};
        const chmods = [];
        fs.promises.mkdir = async (...args) => { const f = await realMkdir(...args); return f == null ? f : rewrite(f); };
        fs.promises.chmod = async (p) => { chmods.push(p); };
        require(process.argv[1]).ensureDirs(path.join(process.argv[2], 'module_data'), 'probe')
          .then(() => process.stdout.write(JSON.stringify({settled: 'resolved', chmods})),
            (e) => process.stdout.write(JSON.stringify({settled: 'rejected', message: e.message, chmods})));`, [home]);
      assert.ok(!r.timedOut, 'ensureDirs did not settle in 10 s');
      const o = JSON.parse(r.out);
      assert.strictEqual(o.settled, 'resolved', r.out);
      const md = path.join(home, 'module_data');
      // data's mkdir made module_data, probe and data; tmp's made tmp.
      assert.deepStrictEqual(o.chmods, [path.join(md, 'probe', 'data'), path.join(md, 'probe'), md, path.join(md, 'probe', 'tmp')]);
    });
  }

  it('an answer from mkdir that is not the directory asked for or above it is refused; only the directory asked for is made private', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-dirs-'));
    const r = inChild(`
      const fs = require('fs'); const path = require('path');
      const chmods = [];
      fs.promises.mkdir = async () => path.join(process.argv[2], 'elsewhere');
      fs.promises.chmod = async (p) => { chmods.push(p); };
      require(process.argv[1]).ensureDirs(path.join(process.argv[2], 'module_data'), 'probe')
        .then(() => process.stdout.write(JSON.stringify({settled: 'resolved', chmods})),
          (e) => process.stdout.write(JSON.stringify({settled: 'rejected', message: e.message, code: e.code, chmods})));`, [home]);
    assert.ok(!r.timedOut, 'ensureDirs did not settle in 10 s');
    const o = JSON.parse(r.out);
    assert.strictEqual(o.settled, 'rejected', r.out);
    assert.match(o.message, /^mkdir reported creating .*elsewhere, which is not .*data or above it$/);
    assert.strictEqual(o.code, undefined, 'no file system code: the writable-path advice is not given');
    // An answer means data did not exist before, so mkdir made it: that one,
    // and nothing above it.
    assert.deepStrictEqual(o.chmods, [path.join(home, 'module_data', 'probe', 'data')]);
  });
});

// The server's stderr for a failure message, without the Redis connection
// noise this start causes on purpose (as test/stdio/02-spawned.js keeps it).
const REDIS_NOISE = /ECONNREFUSED|Redis client error|Redis connection to|job queue error/;
const CONTINUATION = /^\s+\S|^\s*[{}]\s*$/;
function tail(err, max = 3000) {
  const kept = [];
  let inNoise = false;
  for (const l of err.split('\n')) {
    if (l.trim() === '') continue;
    if (REDIS_NOISE.test(l)) { inNoise = true; continue; }
    if (inNoise && CONTINUATION.test(l)) continue;
    inNoise = false;
    kept.push(l);
  }
  const text = kept.join('\n');
  return text.length > max ? `…${text.slice(-max)}` : text;
}

// End to end: a start under either mode and either base lists the module's
// tool over MCP.
describe('stdio 03: a spawned start lists the module (issue #40)', function() {
  this.timeout(90000);
  let home = null;
  afterEach(() => { remove(home); home = null; });

  for (const mode of ['off', 'audit']) {
    for (const [label, base] of BASES) {
      it(`--moduleSandbox ${mode} (${label})`, async () => {
        home = fs.mkdtempSync(path.join(base(), 'ch-start-'));
        const auth = path.join(home, 'auth.json');
        fs.writeFileSync(auth, JSON.stringify({'start-key': {userName: 'start', devices: ['*']}}));
        // --redisUrl points where nothing listens (B's port block); nothing here is metered.
        const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'countinghouse-stdio.js'), '--workerThread', '--moduleSandbox', mode,
          '--loadModule', path.join(ROOT, 'test', 'fixtures', 'handler-map-module'), '--authConfigPath', auth,
          '--moduleDataPath', path.join(home, 'module_data'), '--redisUrl', 'redis://127.0.0.1:9733'],
        {env: {...process.env, COUNTINGHOUSE_API_KEY: 'start-key'}, stdio: ['pipe', 'pipe', 'pipe']});
        let partial = '';
        let err = '';
        let stopped = false;
        const answers = new Map();   // id -> the answer, from complete stdout lines only
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (d) => {
          const parts = (partial + d).split('\n');
          partial = parts.pop();
          for (const l of parts) {
            if (l.trim() === '') continue;
            let m = null;
            try { m = JSON.parse(l); } catch (e) { err += `\n(a stdout line that is not JSON: ${l.slice(0, 200)})`; continue; }
            if (m != null && m.id != null) answers.set(m.id, m);
          }
        });
        child.stderr.on('data', (d) => { err += d; });
        child.stdin.on('error', () => { /* the server ended first: the outcome below says so */ });
        const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({code, signal})));
        let next = 1;
        // One request's answer, or null once the test has stopped waiting.
        const answer = async(message) => {
          const id = next++;
          if (!stopped) child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, ...message})}\n`);
          while (!stopped) {
            if (answers.has(id)) return answers.get(id);
            await new Promise((r) => setTimeout(r, 50));
          }
          return null;
        };
        let outcome = null;
        let listed = Promise.resolve();
        try {
          listed = (async () => {
            await answer({method: 'initialize', params: {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: 'test', version: '0'}}});
            while (!stopped) {
              const list = await answer({method: 'tools/list'});
              if (list != null && ((list.result && list.result.tools) || []).some((t) => /hello/.test(t.name))) return 'listed';
              await new Promise((r) => setTimeout(r, 500));
            }
            return 'stopped';
          })();
          let timer = null;
          const late = new Promise((resolve) => { timer = setTimeout(() => resolve('late'), 60000); });
          outcome = await Promise.race([listed, exited.then((e) => ({exited: e})), late]).finally(() => clearTimeout(timer));
        } finally {
          // Nothing writes to stdin after this, so its end is the last thing it sees.
          stopped = true;
          await listed.catch(() => {});
          child.stdin.end();
          if ((await Promise.race([exited, new Promise((r) => setTimeout(() => r('late'), 15000))])) === 'late') {
            child.kill('SIGKILL');
            await exited;
          }
        }
        if (outcome !== 'listed') {
          const why = outcome === 'late' ? 'the tool was not listed in 60 s' : `the server exited (code ${outcome.exited.code}, signal ${outcome.exited.signal})`;
          assert.fail(`${why}; stderr without the Redis noise:\n${tail(err)}`);
        }
      });
    }
  }
});
