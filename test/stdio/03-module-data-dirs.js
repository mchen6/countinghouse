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
const {spawn, spawnSync} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_DATA = path.join(ROOT, 'lib', 'module-data.js');

const BASES = [['os.tmpdir() as given', () => os.tmpdir()], ['os.tmpdir() real path', () => fs.realpathSync.native(os.tmpdir())]];

// A test directory's removal, retried: on Windows a process just ended can
// still hold handles under it for a moment.
function remove(dir) {
  if (dir != null) fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
}

// Runs `script` (which reads its input from argv) in a child Node, so a loop
// that never ends is killed with it instead of running on in mocha.
function inChild(script, args, timeoutMs) {
  const r = spawnSync(process.execPath, ['-e', script, MODULE_DATA, ...args], {encoding: 'utf8', timeout: timeoutMs});
  return {timedOut: r.error != null && r.error.code === 'ETIMEDOUT', status: r.status, out: r.stdout, err: r.stderr};
}

describe('stdio 03: module data directories (issue #40)', function() {
  this.timeout(30000);
  let home = null;
  afterEach(() => { remove(home); home = null; });

  for (const [label, base] of BASES) {
    // ensureDirs' own inputs (dirsFor: path.resolve, data then tmp), and the
    // strings mkdir answers for each, against the target's ancestors.
    it(`mkdir with recursive answers, for data and for tmp, the directory asked for or one above it, as the same string (${label})`, () => {
      home = fs.mkdtempSync(path.join(base(), 'ch-dirs-'));
      const r = inChild(`
        const path = require('path'); const fs = require('fs');
        const d = require(process.argv[1]).dirsFor(path.join(process.argv[2], 'module_data'), 'probe');
        const up = (p) => { const out = [p]; while (path.dirname(p) !== p) { p = path.dirname(p); out.push(p); } return out; };
        (async () => {
          const rows = [];
          for (const target of [d.data, d.tmp]) {
            const first = await fs.promises.mkdir(target, {recursive: true, mode: 0o700});
            rows.push({target, first: first === undefined ? null : first, found: first == null || up(target).includes(first)});
          }
          process.stdout.write(JSON.stringify(rows));
        })();`, [home], 10000);
      assert.ok(!r.timedOut && r.status === 0, `the probe ended (status ${r.status}): ${r.err}`);
      for (const row of JSON.parse(r.out)) {
        assert.ok(row.found, `mkdir answered ${JSON.stringify(row.first)} for ${JSON.stringify(row.target)}`);
      }
    });

    it(`ensureDirs settles within 10 s and makes data and tmp (${label})`, () => {
      home = fs.mkdtempSync(path.join(base(), 'ch-dirs-'));
      const r = inChild(`
        const path = require('path');
        require(process.argv[1]).ensureDirs(path.join(process.argv[2], 'module_data'), 'probe')
          .then((d) => process.stdout.write(JSON.stringify(d)), (e) => { process.stderr.write(String(e && e.stack)); process.exit(1); });`, [home], 10000);
      assert.ok(!r.timedOut, 'ensureDirs did not settle in 10 s');
      assert.strictEqual(r.status, 0, r.err);
      const d = JSON.parse(r.out);
      assert.ok(fs.statSync(d.data).isDirectory() && fs.statSync(d.tmp).isDirectory());
    });
  }
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

// The file broker's steps at spawn, traced by COUNTINGHOUSE_TEST_FSB_TRACE=1
// (step names only): where a start that never lists the module stops. Done
// is the module's tool listed over MCP, not the trace's last step.
describe('stdio 03: the file broker\'s spawn steps, traced (issue #40)', function() {
  this.timeout(90000);
  let home = null;
  afterEach(() => { remove(home); home = null; });

  for (const mode of ['off', 'audit']) {
    for (const [label, base] of BASES) {
      it(`a --moduleSandbox ${mode} start passes every step and lists the module's tool (${label})`, async () => {
        home = fs.mkdtempSync(path.join(base(), 'ch-trace-'));
        const auth = path.join(home, 'auth.json');
        fs.writeFileSync(auth, JSON.stringify({'trace-key': {userName: 'trace', devices: ['*']}}));
        // --redisUrl points where nothing listens (B's port block); nothing here is metered.
        const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'countinghouse-stdio.js'), '--workerThread', '--moduleSandbox', mode,
          '--loadModule', path.join(ROOT, 'test', 'fixtures', 'handler-map-module'), '--authConfigPath', auth,
          '--moduleDataPath', path.join(home, 'module_data'), '--redisUrl', 'redis://127.0.0.1:9733'],
        {env: {...process.env, COUNTINGHOUSE_API_KEY: 'trace-key', COUNTINGHOUSE_TEST_FSB_TRACE: '1'}, stdio: ['pipe', 'pipe', 'pipe']});
        let out = '';
        let err = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (d) => { err += d; });
        const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({code, signal})));
        let next = 1;
        const answer = (message) => new Promise((resolve) => {
          const id = next++;
          const check = () => {
            const found = out.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)).find((m) => m.id === id);
            if (found) { child.stdout.off('data', onData); resolve(found); }
          };
          const onData = (d) => { out += d; check(); };
          child.stdout.on('data', onData);
          child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, ...message})}\n`);
        });
        const listed = (async () => {
          await answer({method: 'initialize', params: {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: 'test', version: '0'}}});
          for (;;) {
            const list = await answer({method: 'tools/list'});
            if (((list.result && list.result.tools) || []).some((t) => /hello/.test(t.name))) return 'listed';
            await new Promise((r) => setTimeout(r, 500));
          }
        })();
        let timer = null;
        const late = new Promise((resolve) => { timer = setTimeout(() => resolve('late'), 60000); });
        const outcome = await Promise.race([listed, exited.then((e) => ({exited: e})), late]);
        clearTimeout(timer);
        const steps = err.split('\n').filter((l) => /file broker: handler-map-module/.test(l)).join('\n');
        child.stdin.end();
        if ((await Promise.race([exited, new Promise((r) => setTimeout(() => r('late'), 15000))])) === 'late') {
          child.kill('SIGKILL');
          await exited;
        }
        if (outcome !== 'listed') {
          const why = outcome === 'late' ? 'the tool was not listed in 60 s' : `the server exited (code ${outcome.exited.code}, signal ${outcome.exited.signal})`;
          assert.fail(`${why}; the broker's lines:\n${steps}\nstderr without the Redis noise:\n${tail(err)}`);
        }
      });
    }
  }
});
