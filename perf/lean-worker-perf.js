#!/usr/bin/env node
// Lean worker step 5 (docs/superpowers/specs/2026-11-13-lean-worker-design.md,
// "Tests and acceptance" and Sequencing step 5): what a module worker costs,
// measured from outside the server process, so the same harness runs on the
// code before the lean worker and after it.
//
//   node perf/lean-worker-perf.js [--runtime <dir>] [--pack <scenario dir>] [--runs N] [--json <file>]
//   node perf/lean-worker-perf.js --self-check
//
// For each configuration it starts `<runtime>/framework.js --workerThread`
// (--store local, its own temp directories) with one --loadModule per module,
// --runs times, and reads the server's own log lines:
//   ready         spawn to "countinghouse ready"                (target: pack ready <= 5 s)
//   worker boot   per module, "file broker: <name> spawn walk" to
//                 "module: <name>@<version> loaded": the walk, the worker's
//                 start and its module's load                 (target: median <= 200 ms)
//   spawn walk    "spawn walk" to "file broker: <name> walk finished" (a runtime
//                 with no such line reports none)
//   RSS           VmRSS of the server process (/proc/<pid>/status) 1.5 s after
//                 ready; "added per worker" is the least-squares slope over the
//                 configurations' worker counts                (target: <= 20 MB)
// The files a worker requires are not counted here: test/sandbox/43 pins them.
//
// --pack <dir>: an installed scenario (a package whose countinghouse.role is
// scenario); its countinghouse.calls name the modules beside it, which give
// the 1-, 3- and 5-module rows, and the scenario itself gives the full row
// (the runtime loads what it calls) and a single-thread row for reference.
// Without --pack, --self-check runs the bundled pre-installed packages once
// and checks that every metric was read.
//
// Under mocha (scripts/run-in-docker.js runs files with mocha), the arguments
// come from perf/lean-worker-perf.args.json, a JSON array, when that file
// exists (it is never committed), else --self-check. Linux only (/proc).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {testPort} = require('../test/helpers/test-env');

const ROOT = path.join(__dirname, '..');
const PORT = testPort(9752);
const SETTLE_MS = 1500;
const READY_MS = 180000;

function parseArgs(argv) {
  const o = {runtime: ROOT, pack: null, runs: 3, json: null, selfCheck: false};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runtime') o.runtime = path.resolve(argv[++i]);
    else if (a === '--pack') o.pack = path.resolve(argv[++i]);
    else if (a === '--runs') o.runs = parseInt(argv[++i], 10);
    else if (a === '--json') o.json = path.resolve(argv[++i]);
    else if (a === '--self-check') o.selfCheck = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(o.runs) || o.runs < 1) throw new Error('--runs takes a positive integer');
  if (o.pack == null && !o.selfCheck) throw new Error('give --pack <scenario dir>, or --self-check');
  return o;
}

// [label, modules, {thread}] for each configuration.
function configsFor(o) {
  if (o.pack == null) {
    const pre = (n) => path.join(ROOT, 'pre-installed-packages', n);
    return [['0 modules', [], {}], ['1 module', [pre('echo-device-module')], {}],
      ['2 modules', [pre('echo-device-module'), pre('transform-demo')], {}]];
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(o.pack, 'package.json'), 'utf8'));
  const calls = ((pkg.countinghouse || {}).calls || []).map((c) => String(c).split('/')[0]);
  const parts = [...new Set(calls)].map((n) => path.join(path.dirname(o.pack), n));
  for (const p of parts) if (!fs.existsSync(path.join(p, 'package.json'))) throw new Error(`${p}: the scenario calls it, and it is not installed beside it`);
  if (parts.length < 5) throw new Error(`${o.pack}: calls ${parts.length} modules; the ladder needs 5`);
  return [['0 modules', [], {}], ['1 module', parts.slice(0, 1), {}], ['3 modules', parts.slice(0, 3), {}],
    ['5 modules', parts.slice(0, 5), {}], [`pack (${parts.length + 1})`, [o.pack], {}],
    ['pack, --no-workerThread', [o.pack], {thread: false}]];
}

const rssOf = (pid) => {
  const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
  return (m == null) ? null : Number(m[1]) / 1024;
};

// One server start: {ready, rss, workers, boots: {name: ms}, walks: {name: ms}}.
function once(o, modules, {thread = true} = {}) {
  return new Promise((resolve, reject) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-perf-'));
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'rc.json'), '{}\n');
    const args = [path.join(o.runtime, 'framework.js'), thread ? '--workerThread' : '--no-workerThread', '--bindAddr', '127.0.0.1', '--port', String(PORT),
      '--debug', '--debugKey', 'lean-perf-key', '--store', 'local', '--storePath', path.join(root, 'store'), '--modulePath', path.join(root, 'modules'),
      '--moduleDataPath', path.join(root, 'md'), '--remoteCredentials', path.join(root, 'rc.json'), '--deviceConfigPath', path.join(root, 'config')]
      .concat(...modules.map((m) => ['--loadModule', m]));
    const t0 = Date.now();
    const child = spawn(process.execPath, args, {cwd: o.runtime, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, {COUNTINGHOUSE_ACCEPTANCE: ''})});
    const marks = {walk: {}, walked: {}, loaded: {}};
    const tail = [];
    let ready = null;
    let done = false;
    let buf = '';
    const end = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      fs.rmSync(root, {recursive: true, force: true});
      fn(v);
    };
    const timer = setTimeout(() => end(reject, new Error(`not ready in ${READY_MS / 1000} s:\n${tail.join('\n')}`)), READY_MS);
    child.on('exit', (code) => end(reject, new Error(`the server exited (${code}) before it was measured:\n${tail.join('\n')}`)));
    const line = (l) => {
      let j = null;
      try { j = JSON.parse(l); } catch (e) { j = null; }
      if (j == null || typeof(j.msg) !== 'string') { tail.push(l.slice(0, 300)); if (tail.length > 30) tail.shift(); return; }
      const t = Date.parse(j.time);
      let m = null;
      if ((m = /^file broker: (\S+) spawn walk$/.exec(j.msg)) != null) marks.walk[m[1]] = t;
      else if ((m = /^file broker: (\S+) walk finished$/.exec(j.msg)) != null) marks.walked[m[1]] = t;
      else if ((m = /^module: (\S+)@\S* loaded$/.exec(j.msg)) != null) marks.loaded[m[1]] = t;
      else if (j.msg === 'countinghouse ready' && ready == null) {
        ready = t - t0;
        setTimeout(() => {
          const out = {ready, rss: rssOf(child.pid), workers: thread ? Object.keys(marks.loaded).length : 0, boots: {}, walks: {}};
          for (const name of Object.keys(marks.loaded)) {
            if (marks.walk[name] != null) out.boots[name] = marks.loaded[name] - marks.walk[name];
            if (marks.walk[name] != null && marks.walked[name] != null) out.walks[name] = marks.walked[name] - marks.walk[name];
          }
          end(resolve, out);
        }, SETTLE_MS);
      }
    };
    for (const s of [child.stdout, child.stderr]) {
      s.on('data', (d) => { buf += d; const ls = buf.split('\n'); buf = ls.pop(); ls.forEach(line); });
    }
  });
}

const median = (a) => {
  if (a.length === 0) return null;
  const x = [...a].sort((p, q) => p - q);
  const mid = Math.floor(x.length / 2);
  return (x.length % 2 === 1) ? x[mid] : (x[mid - 1] + x[mid]) / 2;
};
// The least-squares slope of y over x.
function slope(points) {
  if (points.length < 2) return null;
  const n = points.length;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  const sxx = points.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  if (sxx === 0) return null;
  return points.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / sxx;
}
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

async function main(argv) {
  const o = parseArgs(argv);
  if (!fs.existsSync('/proc/self/status')) throw new Error('lean-worker-perf reads /proc: Linux only');
  if (o.selfCheck) o.runs = 1;
  const configs = configsFor(o);
  const rows = [];
  for (const [label, modules, opts] of configs) {
    const runs = [];
    for (let i = 0; i < o.runs; i++) runs.push(await once(o, modules, opts));
    const boots = runs.flatMap((r) => Object.values(r.boots));
    const walks = runs.flatMap((r) => Object.values(r.walks));
    rows.push({label, thread: opts.thread !== false, workers: median(runs.map((r) => r.workers)),
      readyMs: median(runs.map((r) => r.ready)), rssMb: r1(median(runs.map((r) => r.rss))),
      bootMs: median(boots), walkMs: median(walks), runs});
  }
  const ladder = rows.filter((r) => r.thread).map((r) => [r.workers, r.rssMb]);
  const full = rows.filter((r) => r.thread).slice(-1)[0];
  const result = {
    runtime: o.runtime, pack: o.pack, runs: o.runs, node: process.version, cpus: os.cpus().length,
    rows: rows.map(({runs, ...r}) => r),
    targets: {
      packReadyMs: full.readyMs,
      workerBootMedianMs: full.bootMs,
      spawnWalkMedianMs: full.walkMs,
      addedRssPerWorkerMb: r1(slope(ladder))
    }
  };
  for (const r of result.rows) {
    process.stdout.write(`${r.label.padEnd(26)} workers ${String(r.workers).padStart(2)}  ready ${String(r.readyMs).padStart(6)} ms  ` +
      `RSS ${String(r.rssMb).padStart(6)} MB  boot ${String(r.bootMs).padStart(5)} ms  walk ${String(r.walkMs).padStart(5)} ms\n`);
  }
  process.stdout.write(`targets: pack ready ${result.targets.packReadyMs} ms (<= 5000), worker boot median ${result.targets.workerBootMedianMs} ms (<= 200; ` +
    `of it the spawn walk ${result.targets.spawnWalkMedianMs} ms), added RSS per worker ${result.targets.addedRssPerWorkerMb} MB (<= 20)\n`);
  process.stdout.write(`LEAN-PERF-JSON ${JSON.stringify(result)}\n`);
  if (o.json != null) fs.writeFileSync(o.json, `${JSON.stringify(result, null, 2)}\n`);
  if (o.selfCheck) {
    const missing = [];
    for (const r of result.rows) {
      if (!(r.readyMs > 0)) missing.push(`${r.label}: ready`);
      if (!(r.rssMb > 0)) missing.push(`${r.label}: RSS`);
      if (r.workers > 0 && r.bootMs == null) missing.push(`${r.label}: worker boot`);
    }
    if (result.targets.addedRssPerWorkerMb == null) missing.push('the RSS slope');
    if (missing.length > 0) throw new Error(`self-check: not measured: ${missing.join(', ')}`);
    process.stdout.write('self-check: every metric was read\n');
  }
  return result;
}

const argsFile = path.join(__dirname, 'lean-worker-perf.args.json');
// Its own suite only when mocha loads this file directly
// (scripts/run-in-docker.js); a test that requires it
// (test/module-loading/28) calls main itself.
const loadedByMocha = module.parent != null && /[\\/]mocha[\\/]/.test(String(module.parent.filename));
if (typeof(describe) === 'function' && typeof(it) === 'function' && loadedByMocha) {
  describe('perf: lean-worker-perf', function() {
    this.timeout(0);
    it('measures', async () => {
      await main(fs.existsSync(argsFile) ? JSON.parse(fs.readFileSync(argsFile, 'utf8')) : ['--self-check']);
    });
  });
} else if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
}

module.exports = {main, parseArgs, slope, median};
