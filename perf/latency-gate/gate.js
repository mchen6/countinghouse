#!/usr/bin/env node
'use strict';
// The maintainer's latency gate for the shared runtime (2026-11-15, reset the
// same day after the first 4-core run), measured end to end through the real
// Rust shim:
//   N = 1:  a warm shared call is at most 2 ms slower than a separate server;
//   N >= 2: at most 1.5 ms slower than separate servers.
// A (separate): N copies of plain-server.js, the MCP SDK's own stdio server,
//   one per session, each with its client.
// S (shared): ONE runtime on --sessionSocket in a private home, started as
//   ch-local's daemon starts it (--workerThread --store local --moduleSandbox
//   enforce --controlChannel ipc), with perf-time as a scenario; daemon.json
//   written once it listens; each session is a client running
//   `ch-shim --home <home>` over stdio, which attaches and proves the secret.
// P (per-session): the same runtime and shim, with a copy of perf-time that
//   declares "state": "per-session" (generated in the run's home), so each
//   session's calls go to that session's own worker (shared runtime R1:
//   DeviceManager workerFor on every call). Its worker spawns on the
//   session's first warm-up call, so the timed calls are warm.
// Two load shapes (--mode):
// - closed: each session makes WARMUP calls, then CALLS timed calls back to
//   back, all N sessions at once;
// - open: each session makes WARMUP calls, then CALLS timed calls, each after
//   a gap drawn uniformly from 1-5 s by a seeded RNG (--seed), at random
//   offsets, so a run repeats; every layout gets the same schedule.
// A, S and P alternate, ROUNDS times per N, the order rotated each round so
// no layout always follows another's teardown. A round's figures are the
// median, p90 and p95 over every session's timed calls; the result is the
// median of the rounds. The verdict uses the medians: S against A is the
// maintainer's gate; P against A, at the same allowance, is the release
// plan's (the reviewer, 2026-11-17). Each layout's run records the 1-minute
// load average it started at, marked "loaded" above LOADED_PER_CPU x the
// CPUs. It isn't run again: much of that load is the harness's own previous
// run, which a 1-minute average still holds. See README.md.
//
// The gate is measured on an idle machine with 4 or more CPUs. Fewer is
// refused (exit 2, the harness's own); --allowFewerCores runs it anyway, and
// the result is then "not a gate verdict" (exit 3), never PASS or FAIL.
//
// node perf/latency-gate/gate.js --shim <ch-shim> [--mode closed|open] [--sessions 1,2,4] [--rounds 5] [--calls 300] [--seed 1] [--json <file>] [--allowFewerCores]
// node perf/latency-gate/gate.js --ch-local <ch-local checkout>   (builds ch-shim with cargo first)
const {spawn, spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const WARMUP = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length === 0 ? null : s[Math.floor(s.length / 2)]; };
// one sort: {med, p90, p95} of a sample
function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q) => (s.length === 0 ? null : s[Math.min(s.length - 1, Math.floor(s.length * q))]);
  return {med: s.length === 0 ? null : s[Math.floor(s.length / 2)], p90: at(0.90), p95: at(0.95)};
}
// the gate: how much slower than separate a warm call may be, by session count
const allowanceMs = (n) => (n === 1 ? 2 : 1.5);
// a layout's run that starts with the 1-minute load above this many per CPU
// is marked loaded
const LOADED_PER_CPU = 0.75;
// the JSON's shape: 2 since the per-session layout (rows hold separate,
// shared and perSession, each {ms, p90Ms, p95Ms, rounds}); 1 was flat
// (separateMs, sharedMs, ...)
const SCHEMA = 2;
// the gate's machine: 4 or more CPUs (README.md)
const GATE_CPUS = 4;
const WINDOWS_REFUSAL = 'this harness runs on Linux and macOS only (it uses a Unix socket and a POSIX script)';
// -> {gated: true} | {gated: false} (allowed, no gate verdict) | {gated: false, refused: why}
function machineCondition(cpus, allowFewer) {
  if (cpus >= GATE_CPUS) return {gated: true};
  if (allowFewer === true) return {gated: false};
  return {gated: false, refused: `this machine has ${cpus} CPUs; the gate is measured on ${GATE_CPUS} or more (--allowFewerCores runs it anyway, with no gate verdict)`};
}
// rows' passes -> {verdict, exitCode}: PASS 0 or FAIL 1 only where the gate
// holds; otherwise no gate verdict, exit 3 (never read as a pass or a fail)
function verdictOf(rows, condition, cpus) {
  if (condition.gated !== true) return {verdict: `not a gate verdict (${cpus} CPUs, fewer than the gate's ${GATE_CPUS})`, exitCode: 3};
  const pass = rows.every((r) => r.pass);
  return {verdict: pass ? 'PASS' : 'FAIL', exitCode: pass ? 0 : 1};
}
// mulberry32: a small seeded RNG, so an open-mode schedule repeats
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// a usage error: exit 2, as a harness failure
class Usage extends Error {}
const SDK = path.dirname(path.dirname(require.resolve('@modelcontextprotocol/sdk/client/index.js', {paths: [ROOT]})));
const {Client} = require(path.join(SDK, 'client', 'index.js'));
const {StdioClientTransport} = require(path.join(SDK, 'client', 'stdio.js'));

// a small positive integer in [lo, hi], given as text (a workflow input is
// free text): anything else is refused
function int(name, text, lo, hi) {
  if (typeof(text) !== 'string' || !/^[0-9]{1,6}$/.test(text)) throw new Usage(`${name} must be an integer from ${lo} to ${hi}, not ${JSON.stringify(text)}`);
  const n = Number(text);
  if (n < lo || n > hi) throw new Usage(`${name} must be an integer from ${lo} to ${hi}, not ${n}`);
  return n;
}

function args(a = process.argv.slice(2)) {
  const o = {shim: null, chLocal: null, mode: 'closed', sessions: null, rounds: null, calls: null, seed: 1, json: null, allowFewerCores: false};
  for (let i = 0; i < a.length; i++) {
    const v = a[i + 1];
    if (a[i] === '--shim') { o.shim = path.resolve(v); i++; }
    else if (a[i] === '--ch-local') { o.chLocal = path.resolve(v); i++; }
    else if (a[i] === '--mode') { if (v !== 'closed' && v !== 'open') throw new Usage('--mode must be closed or open'); o.mode = v; i++; }
    else if (a[i] === '--sessions') {
      if (typeof(v) !== 'string' || !/^[0-9]{1,2}(,[0-9]{1,2}){0,5}$/.test(v)) throw new Usage(`--sessions must be up to 6 comma-separated counts from 1 to 16, not ${JSON.stringify(v)}`);
      o.sessions = v.split(',').map((x) => int('--sessions', x, 1, 16)); i++;
    }
    else if (a[i] === '--rounds') { o.rounds = int('--rounds', v, 1, 20); i++; }
    else if (a[i] === '--calls') { o.calls = int('--calls', v, 10, 2000); i++; }
    else if (a[i] === '--seed') { o.seed = int('--seed', v, 0, 999999); i++; }
    else if (a[i] === '--json') { o.json = path.resolve(v); i++; }
    else if (a[i] === '--allowFewerCores') o.allowFewerCores = true;
    else throw new Usage(`unknown option ${a[i]}`);
  }
  if (o.shim == null && o.chLocal == null) throw new Usage('--shim <ch-shim binary> or --ch-local <ch-local checkout> is needed');
  // the defaults per load shape: open mode's calls are seconds apart
  if (o.sessions == null) o.sessions = o.mode === 'closed' ? [1, 2, 4] : [2, 3, 10];
  if (o.rounds == null) o.rounds = o.mode === 'closed' ? 5 : 1;
  if (o.calls == null) o.calls = o.mode === 'closed' ? 300 : 60;
  return o;
}

function shimOf(o) {
  if (o.shim != null) return o.shim;
  const manifest = path.join(o.chLocal, 'shim', 'Cargo.toml');
  process.stderr.write('building ch-shim (cargo build --release)...\n');
  const r = spawnSync('cargo', ['build', '--release', '--manifest-path', manifest], {stdio: ['ignore', 'inherit', 'inherit']});
  if (r.status !== 0) throw new Error('cargo build failed');
  const target = process.env.CARGO_TARGET_DIR || path.join(o.chLocal, 'shim', 'target');
  return path.join(target, 'release', process.platform === 'win32' ? 'ch-shim.exe' : 'ch-shim');
}

async function connect(command, argv, env) {
  const c = new Client({name: 'latency-gate', version: '0'});
  await c.connect(new StdioClientTransport({command, args: argv, env, stderr: 'ignore'}));
  return c;
}

// every session at once: WARMUP calls back to back, then `calls` timed
// calls, back to back (closed) or each after a seeded 1-5 s gap (open)
async function drive(sessions, calls, plan) {
  const all = await Promise.all(sessions.map(async ({c, name}, k) => {
    const ms = [];
    const gap = plan.mode === 'open' ? rng(plan.seed * 1000 + k) : null;
    for (let i = 0; i < WARMUP + calls; i++) {
      if (gap != null && i >= WARMUP) await sleep(1000 + 4000 * gap());
      const t = process.hrtime.bigint();
      const r = await c.callTool({name, arguments: {timezone: 'UTC'}});
      if (r.isError) throw new Error(JSON.stringify(r).slice(0, 300));
      if (i >= WARMUP) ms.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    return ms;
  }));
  return all.flat();
}

async function separate(n, calls, plan) {
  const sessions = [];
  try {
    for (let i = 0; i < n; i++) sessions.push({c: await connect(process.execPath, [path.join(HERE, 'plain-server.js')], process.env), name: 'get_current_time'});
    return await drive(sessions, calls, plan);
  } finally {
    for (const s of sessions) await s.c.close().catch(() => {});
  }
}

const priv = (file, text) => { fs.writeFileSync(file, text, {mode: 0o600}); fs.chmodSync(file, 0o600); };

// perf-time as a per-session module (P): a copy in the run's home
function perSessionCopy(home) {
  const dir = path.join(home, 'modules-ps', 'perf-time');
  fs.cpSync(path.join(HERE, 'modules', 'perf-time'), dir, {recursive: true});
  const file = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.countinghouse = Object.assign({}, pkg.countinghouse, {state: 'per-session'});
  fs.writeFileSync(file, JSON.stringify(pkg));
  return dir;
}

// S (perSession false) or P (true)
async function shared(n, calls, shim, plan, perSession = false) {
  // a short path: a Unix socket's is capped near 107 bytes
  const home = fs.mkdtempSync(path.join(os.homedir(), '.chgate-'));
  const run = path.join(home, 'run', 'daemon');
  for (const d of [home, path.join(home, 'run'), run, path.join(home, 'store'), path.join(home, 'data')]) { fs.mkdirSync(d, {recursive: true, mode: 0o700}); fs.chmodSync(d, 0o700); }
  const cond = path.join(home, 'cond.sh');
  // the shim's conditions child: a client that never elicits
  fs.writeFileSync(cond, 'echo \'{"status":"ok","conditions":"no","repo":null,"token":null}\'\n', {mode: 0o700});
  priv(path.join(home, 'shim.json'), JSON.stringify({node: '/bin/sh', chLocal: cond, env: {PATH: '/usr/bin:/bin'}}));
  const socket = path.join(run, 'rt.sock');
  let module;
  try {
    module = perSession ? perSessionCopy(home) : path.join(HERE, 'modules', 'perf-time');
  } catch (e) {
    fs.rmSync(home, {recursive: true, force: true});
    throw e;
  }
  const rt = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--sessionSocket', socket, '--workerThread', '--store', 'local',
    '--storePath', path.join(home, 'store'), '--moduleSandbox', 'enforce', '--moduleDataPath', path.join(home, 'data'),
    '--loadModule', module, '--controlChannel', 'ipc'],
  {stdio: ['ignore', 'pipe', 'pipe', 'ipc'], cwd: home});
  let out = '';
  rt.stdout.on('data', (d) => { out = (out + d).slice(-8000); });
  rt.stderr.on('data', (d) => { out = (out + d).slice(-8000); });
  rt.on('message', () => {});
  const sessions = [];
  try {
    for (let w = 0; !(fs.existsSync(socket) && fs.existsSync(path.join(run, 'secret'))); w += 100) {
      if (w > 60000 || rt.exitCode != null) throw new Error(`the runtime never listened: ${out.slice(-800)}`);
      await sleep(100);
    }
    await sleep(300);
    priv(path.join(run, 'daemon.json'), `${JSON.stringify({pid: rt.pid, socket, runtimeVersion: require(path.join(ROOT, 'package.json')).version,
      daemonVersion: '0.0.0', started: new Date().toISOString()})}\n`);
    for (let i = 0; i < n; i++) {
      const c = await connect(shim, ['--home', home], {PATH: process.env.PATH, HOME: os.homedir()});
      const name = (await c.listTools()).tools.map((t) => t.name).find((x) => x.endsWith('get_current_time'));
      if (name == null) throw new Error(`the shared runtime lists no get_current_time: ${out.slice(-800)}`);
      sessions.push({c, name});
    }
    return await drive(sessions, calls, plan);
  } finally {
    for (const s of sessions) await s.c.close().catch(() => {});
    rt.kill('SIGINT');
    for (let w = 0; rt.exitCode == null && rt.signalCode == null && w < 10000; w += 100) await sleep(100);
    if (rt.exitCode == null && rt.signalCode == null) rt.kill('SIGKILL');
    fs.rmSync(home, {recursive: true, force: true});
  }
}

async function main() {
  const o = args();
  if (process.platform === 'win32') throw new Usage(WINDOWS_REFUSAL);
  // (the CPUs this process may run on, an affinity limit's included: read
  // once, for the condition, the verdict and the result alike)
  const cpus = typeof(os.availableParallelism) === 'function' ? os.availableParallelism() : os.cpus().length;
  const condition = machineCondition(cpus, o.allowFewerCores);
  if (condition.refused != null) throw new Usage(condition.refused);
  const shim = shimOf(o);
  if (!fs.existsSync(shim)) throw new Error(`no ch-shim at ${shim}`);
  const machine = {cpus, hostCpus: os.cpus().length, model: (os.cpus()[0] || {}).model, node: process.version, platform: `${os.platform()} ${os.release()}`, loadavgAtStart: os.loadavg()};
  process.stdout.write(`latency gate (${o.mode}): ${machine.cpus} CPUs (${machine.model}), node ${machine.node}, load ${machine.loadavgAtStart.map((x) => x.toFixed(2)).join('/')}; ${o.rounds} rounds of ${o.calls} calls per session${o.mode === 'open' ? `, 1-5 s gaps, seed ${o.seed}` : ''}\n`);
  const rows = [];
  const fig = (x) => x.toFixed(2);
  const over = (x) => `${x >= 0 ? '+' : ''}${fig(x)}`;
  const loadedAbove = LOADED_PER_CPU * machine.cpus;
  const LAYOUTS = {separate: (n, plan) => separate(n, o.calls, plan), shared: (n, plan) => shared(n, o.calls, shim, plan), perSession: (n, plan) => shared(n, o.calls, shim, plan, true)};
  const order = Object.keys(LAYOUTS);
  let loadedRuns = 0;
  for (const n of o.sessions) {
    // per layout: each round's median, p90 and p95
    const per = {};
    for (const k of order) per[k] = {med: [], p90: [], p95: []};
    const roundsMeta = [];
    for (let r = 0; r < o.rounds; r++) {
      const plan = {mode: o.mode, seed: o.seed + r};
      // rotated each round: no layout always runs right after another
      const ran = order.slice(r % order.length).concat(order.slice(0, r % order.length));
      const meta = {order: ran};
      for (const k of ran) {
        const load = os.loadavg()[0];
        const st = stats(await LAYOUTS[k](n, plan));
        for (const q of ['med', 'p90', 'p95']) per[k][q].push(st[q]);
        meta[k] = {loadAtStart: load, loaded: load > loadedAbove};
        if (load > loadedAbove) loadedRuns++;
      }
      roundsMeta.push(meta);
      const mark = (k) => (meta[k].loaded ? ' LOADED' : '');
      process.stdout.write(`  N=${n} round ${r + 1} (${ran.join(', ')}): separate ${fig(per.separate.med[r])} ms${mark('separate')}, shared ${fig(per.shared.med[r])} ms${mark('shared')}, per-session ${fig(per.perSession.med[r])} ms${mark('perSession')}\n`);
    }
    const A = median(per.separate.med), S = median(per.shared.med), P = median(per.perSession.med);
    const limit = A + allowanceMs(n);
    const pass = {shared: S <= limit, perSession: P <= limit};
    const summary = (k) => ({ms: median(per[k].med), p90Ms: median(per[k].p90), p95Ms: median(per[k].p95), rounds: per[k]});
    rows.push({n, allowanceMs: allowanceMs(n), limitMs: limit, separate: summary('separate'), shared: Object.assign(summary('shared'), {overMs: S - A, pass: pass.shared}),
      perSession: Object.assign(summary('perSession'), {overMs: P - A, pass: pass.perSession}), roundsMeta, pass: pass.shared && pass.perSession});
    process.stdout.write(`N=${n}: separate ${fig(A)} ms (p90 ${fig(median(per.separate.p90))}); shared ${fig(S)} ms, ${over(S - A)} (p90 ${fig(median(per.shared.p90))}); per-session ${fig(P)} ms, ${over(P - A)} (p90 ${fig(median(per.perSession.p90))}); gate <= +${allowanceMs(n)} ms: shared ${pass.shared ? 'PASS' : 'FAIL'}, per-session ${pass.perSession ? 'PASS' : 'FAIL'}\n`);
  }
  const {verdict, exitCode} = verdictOf(rows, condition, machine.cpus);
  process.stdout.write(`verdict: ${verdict}${loadedRuns > 0 ? ` (${loadedRuns} layout run(s) started loaded, above ${fig(loadedAbove)}: see the JSON's roundsMeta)` : ''}\n`);
  const result = {schema: SCHEMA, when: new Date().toISOString(), mode: o.mode, seed: o.mode === 'open' ? o.seed : null, machine, gated: condition.gated, calls: o.calls, rounds: o.rounds, rows, verdict,
    loadedAbove, loadedRuns, loadavgAtEnd: os.loadavg()};
  if (o.json != null) fs.writeFileSync(o.json, `${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = exitCode;
}

// (run only when executed: session-runtime 18 requires it)
if (require.main === module) main().catch((e) => { process.stderr.write(e instanceof Usage ? `latency gate: ${e.message}\n` : `${e.stack || e}\n`); process.exitCode = 2; });

module.exports = {args, machineCondition, verdictOf, WINDOWS_REFUSAL, GATE_CPUS};
