#!/usr/bin/env node
'use strict';
// Shared runtime R1: what one idle per-session lean worker adds to the shared
// runtime's memory (docs/benchmarks/lean-worker.md, "Per-session workers").
// A per-session worker is a worker_thread in the runtime's process, so its
// cost is the runtime process's VmRSS and Pss (/proc/<pid>/smaps_rollup)
// after N sessions' first calls started N workers, minus before (the same N
// sessions open, the module listed, no worker), each at steady state (RSS
// moved under 1% over 6 one-second samples, at most 90 s).
//
//   systemd-run --user --scope -q -p MemoryMax=2G -p MemorySwapMax=0 -- \
//     node perf/session-worker-rss.js [--runtime <dir>] [--reps 3] [--json <file>] [--lock <dir>]
//
// N = 1, 4, 8, each in a fresh runtime (--workerThread --store local
// --sessionSocket, as ch-local's daemon starts it), with
// test/fixtures/per-session-module loaded, --reps times. Before each run it
// waits for MemAvailable >= 3 GB and logs the load average (an idle
// worker's RSS is a memory figure, barely moved by CPU load). --lock: a
// directory taken (mkdir) for each run's measuring steps only, never while
// waiting, on a machine where test runs share one. One JSON line per event
// to --json (else stdout); the last is the summary: per N the medians and
// ranges, and the least-squares fit of added memory on N (slope: per
// worker; intercept: what the first worker brings once). Linux only (/proc).
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn, execSync} = require('child_process');

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const REPO = path.resolve(arg('--runtime', path.join(__dirname, '..')));
const OUT = arg('--json', null);
const REPS = Number(arg('--reps', 3));
const LOCK = arg('--lock', null);
const NS = [1, 4, 8];
const handshake = require(path.join(REPO, 'lib/session-transport/handshake'));
const shim = require(path.join(REPO, 'test/session-transport/helpers/shim'));
const FIXTURE = path.join(REPO, 'test/fixtures/per-session-module');
const META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async(test, ms = 60000) => { const end = Date.now() + ms; while (!(await test()) && Date.now() < end) await sleep(100); return test(); };
const log = (o) => {
  const line = `${JSON.stringify(Object.assign({at: new Date().toISOString()}, o))}\n`;
  if (OUT != null) fs.appendFileSync(OUT, line); else process.stdout.write(line);
};

// No CPU gate (the reviewer, 2026-11-17: an idle worker's RSS/PSS is a memory
// figure, barely moved by CPU load): only MemAvailable >= 3 GB before a run,
// and the load average logged as context.
async function memGate() {
  for (;;) {
    const avail = Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]);
    if (avail >= 3 * 1024 * 1024) return {memAvailableMb: Math.round(avail / 1024), loadavg: os.loadavg().map((x) => Number(x.toFixed(2)))};
    await sleep(5000);
  }
}
// --lock, only for a run's measuring steps (never while waiting)
async function withLock(label, fn) {
  if (LOCK == null) return fn();
  for (;;) {
    try { fs.mkdirSync(LOCK); break; } catch (e) { if (e.code !== 'EEXIST') throw e; await sleep(5000); }
  }
  try {
    fs.writeFileSync(path.join(LOCK, 'owner'), `perf/session-worker-rss.js (pid ${process.pid}), ${label}, ${new Date().toISOString()}\n`);
    return await fn();
  } finally {
    fs.rmSync(LOCK, {recursive: true, force: true});
  }
}

function memOf(pid) {
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)[1]);
  const rollup = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
  const pssKb = Number(/^Pss:\s+(\d+)/m.exec(rollup)[1]);
  const threads = Number(/Threads:\s+(\d+)/.exec(status)[1]);
  return {rssKb, pssKb, threads};
}
// steady state: a sample a second until RSS moved under 1% over the last 5 s
// (6 samples); the medians of that window. At most 90 s (then marked unsettled).
async function steady(pid) {
  const s = [];
  const end = Date.now() + 90000;
  for (;;) {
    s.push(memOf(pid));
    const w = s.slice(-6);
    const rss = w.map((x) => x.rssKb);
    const settled = w.length === 6 && (Math.max(...rss) - Math.min(...rss)) / Math.max(...rss) < 0.01;
    if (settled || Date.now() > end) {
      const med = (k) => w.map((x) => x[k]).sort((a, b) => a - b)[Math.floor(w.length / 2)];
      return {rssKb: med('rssKb'), pssKb: med('pssKb'), threads: med('threads'), settled, samples: s.length};
    }
    await sleep(1000);
  }
}

let nextSeq = 1;
async function request(c, method, params = {}) {
  const seq = nextSeq++;
  shim.message(c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method, params: Object.assign({_meta: META}, params)}));
  for (;;) {
    const m = await shim.readM(c, 60000);
    if (m == null) return null;
    if (m.header != null && m.header.seq === seq) return JSON.parse(m.line.toString('utf8'));
  }
}

async function one(n, rep) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-perf-psw-'));
  const dir = path.join(home, 'pack', 'per-session-module');
  fs.cpSync(FIXTURE, dir, {recursive: true});
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  pkg.countinghouse = Object.assign({}, pkg.countinghouse, {role: 'scenario'});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  const run = path.join(home, 'run', 'daemon');
  fs.mkdirSync(run, {recursive: true});
  fs.chmodSync(path.join(home, 'run'), 0o700);
  fs.chmodSync(run, 0o700);
  const socket = path.join(run, 's');
  const child = spawn(process.execPath, [path.join(REPO, 'framework.js'), '--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
    '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc',
    '--sessionSocket', socket, '--loadModule', dir], {cwd: REPO, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: Object.assign({}, process.env, {COUNTINGHOUSE_GITHUB_TOKEN: '', GITHUB_TOKEN: ''})});
  let logText = '';
  child.stdout.on('data', (d) => { logText += d; });
  child.stderr.on('data', (d) => { logText += d; });
  child.on('message', (m) => { if (m != null && m.type === 'ready') child.send({id: 'restore-1', type: 'restore', sessions: [], declines: [], reset: []}); });
  const exited = new Promise((res) => child.on('exit', res));
  const ups = () => (logText.match(/a session's worker is up/g) || []).length;
  try {
    const secretOf = () => { try { return handshake.parseSecret(fs.readFileSync(path.join(run, 'secret'), 'utf8')); } catch (e) { return null; } };
    if (!await until(async() => fs.existsSync(socket) && secretOf() != null)) throw new Error(`no socket: ${logText.slice(-2000)}`);
    const secret = secretOf();
    const sessions = [];
    for (let i = 0; i < n; i++) sessions.push(await shim.session(socket, secret));
    let tool = null;
    await until(async() => {
      const list = await request(sessions[0].c, 'tools/list');
      const t = (list && list.result && list.result.tools || []).find((x) => /touch$/.test(x.name));
      tool = t ? t.name : null;
      return tool != null;
    });
    if (tool == null) throw new Error(`touch not listed: ${logText.slice(-2000)}`);
    if (ups() !== 0) throw new Error('a worker before any call');
    const before = await steady(child.pid);
    for (const s of sessions) {
      const res = await request(s.c, 'tools/call', {name: tool, arguments: {}});
      if (res == null || res.result == null || res.result.isError === true) throw new Error(`call failed: ${JSON.stringify(res).slice(0, 400)}`);
    }
    if (!await until(async() => ups() === n, 30000)) throw new Error(`workers up ${ups()} of ${n}`);
    const after = await steady(child.pid);
    const row = {kind: 'run', n, rep, before, after,
      addedRssMb: Number(((after.rssKb - before.rssKb) / 1024).toFixed(2)),
      addedPssMb: Number(((after.pssKb - before.pssKb) / 1024).toFixed(2)),
      threadsAdded: after.threads - before.threads};
    row.perWorkerRssMb = Number((row.addedRssMb / n).toFixed(2));
    row.perWorkerPssMb = Number((row.addedPssMb / n).toFixed(2));
    log(row);
    for (const s of sessions) { try { s.c.end(); } catch (e) { /* gone */ } }
    return row;
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch (e) { /* gone */ }
    await exited;
    fs.rmSync(home, {recursive: true, force: true});
  }
}

// least squares of added memory on N, over the runs
function fit(rows, key) {
  const xs = rows.map((r) => r.n);
  const ys = rows.map((r) => r[key]);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return {slope: Number(slope.toFixed(2)), intercept: Number((my - slope * mx).toFixed(2))};
}

(async() => {
  log({kind: 'start', node: process.version, repo: execSync('git rev-parse --short HEAD', {cwd: REPO, encoding: 'utf8'}).trim(), reps: REPS, ns: NS,
    cpus: os.cpus().length, memTotalMb: Math.round(os.totalmem() / 1048576)});
  const rows = [];
  for (let rep = 1; rep <= REPS; rep++) {
    for (const n of NS) {
      const ctx = await memGate();
      log(Object.assign({kind: 'gate', n, rep}, ctx));
      try { rows.push(await withLock(`lean worker baseline n=${n} rep=${rep}`, () => one(n, rep))); } catch (e) { log({kind: 'error', n, rep, message: String(e && e.message).slice(0, 1500)}); }
    }
  }
  const med = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const table = NS.map((n) => {
    const r = rows.filter((x) => x.n === n);
    return {n, runs: r.length, addedRssMb: med(r.map((x) => x.addedRssMb)), addedPssMb: med(r.map((x) => x.addedPssMb)),
      perWorkerRssMb: med(r.map((x) => x.perWorkerRssMb)), perWorkerPssMb: med(r.map((x) => x.perWorkerPssMb)),
      rangeRss: [Math.min(...r.map((x) => x.perWorkerRssMb)), Math.max(...r.map((x) => x.perWorkerRssMb))],
      rangePss: [Math.min(...r.map((x) => x.perWorkerPssMb)), Math.max(...r.map((x) => x.perWorkerPssMb))]};
  });
  log({kind: 'summary', table, fitRss: fit(rows, 'addedRssMb'), fitPss: fit(rows, 'addedPssMb')});
})().catch((e) => { log({kind: 'fatal', message: String(e && e.stack)}); process.exit(1); });
