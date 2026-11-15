#!/usr/bin/env node
'use strict';
// Matt's latency gate for the shared runtime (2026-11-15), measured end to
// end through the real Rust shim:
//   N = 1:  a warm shared call is at most 2 ms slower than a separate server;
//   N >= 2: a warm shared call is no slower than separate servers.
// A (separate): N copies of plain-server.js, the MCP SDK's own stdio server,
//   one per session, each with its client.
// S (shared): ONE runtime on --sessionSocket in a private home, started as
//   ch-local's daemon starts it (--workerThread --store local --moduleSandbox
//   enforce --controlChannel ipc), with perf-time as a scenario; daemon.json
//   written once it listens; each session is a client running
//   `ch-shim --home <home>` over stdio, which attaches and proves the secret.
// Each session makes WARMUP calls, then CALLS timed sequential calls, all N
// sessions at once. A and S alternate, ROUNDS times per N. A round's figure
// is the median over every session's timed calls; the result is the median
// of the rounds. See README.md.
//
// node perf/latency-gate/gate.js --shim <ch-shim> [--sessions 1,2] [--rounds 5] [--calls 300] [--json <file>]
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
const SDK = path.dirname(path.dirname(require.resolve('@modelcontextprotocol/sdk/client/index.js', {paths: [ROOT]})));
const {Client} = require(path.join(SDK, 'client', 'index.js'));
const {StdioClientTransport} = require(path.join(SDK, 'client', 'stdio.js'));

function args() {
  const o = {shim: null, chLocal: null, sessions: [1, 2], rounds: 5, calls: 300, json: null};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--shim') o.shim = path.resolve(a[++i]);
    else if (a[i] === '--ch-local') o.chLocal = path.resolve(a[++i]);
    else if (a[i] === '--sessions') o.sessions = a[++i].split(',').map(Number);
    else if (a[i] === '--rounds') o.rounds = Number(a[++i]);
    else if (a[i] === '--calls') o.calls = Number(a[++i]);
    else if (a[i] === '--json') o.json = path.resolve(a[++i]);
    else throw new Error(`unknown option ${a[i]}`);
  }
  if (o.shim == null && o.chLocal == null) throw new Error('--shim <ch-shim binary> or --ch-local <ch-local checkout> is needed');
  if (o.sessions.some((n) => !(n >= 1)) || !(o.rounds >= 1) || !(o.calls >= 10)) throw new Error('--sessions, --rounds and --calls must be positive (calls >= 10)');
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

// every session at once: WARMUP calls, then `calls` timed sequential calls
async function drive(sessions, calls) {
  const all = await Promise.all(sessions.map(async ({c, name}) => {
    const ms = [];
    for (let i = 0; i < WARMUP + calls; i++) {
      const t = process.hrtime.bigint();
      const r = await c.callTool({name, arguments: {timezone: 'UTC'}});
      if (r.isError) throw new Error(JSON.stringify(r).slice(0, 300));
      if (i >= WARMUP) ms.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    return ms;
  }));
  return all.flat();
}

async function separate(n, calls) {
  const sessions = [];
  try {
    for (let i = 0; i < n; i++) sessions.push({c: await connect(process.execPath, [path.join(HERE, 'plain-server.js')], process.env), name: 'get_current_time'});
    return await drive(sessions, calls);
  } finally {
    for (const s of sessions) await s.c.close().catch(() => {});
  }
}

const priv = (file, text) => { fs.writeFileSync(file, text, {mode: 0o600}); fs.chmodSync(file, 0o600); };

async function shared(n, calls, shim) {
  // a short path: a Unix socket's is capped near 107 bytes
  const home = fs.mkdtempSync(path.join(os.homedir(), '.chgate-'));
  const run = path.join(home, 'run', 'daemon');
  for (const d of [home, path.join(home, 'run'), run, path.join(home, 'store'), path.join(home, 'data')]) { fs.mkdirSync(d, {recursive: true, mode: 0o700}); fs.chmodSync(d, 0o700); }
  const cond = path.join(home, 'cond.sh');
  // the shim's conditions child: a client that never elicits
  fs.writeFileSync(cond, 'echo \'{"status":"ok","conditions":"no","repo":null,"token":null}\'\n', {mode: 0o700});
  priv(path.join(home, 'shim.json'), JSON.stringify({node: '/bin/sh', chLocal: cond, env: {PATH: '/usr/bin:/bin'}}));
  const socket = path.join(run, 'rt.sock');
  const rt = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--sessionSocket', socket, '--workerThread', '--store', 'local',
    '--storePath', path.join(home, 'store'), '--moduleSandbox', 'enforce', '--moduleDataPath', path.join(home, 'data'),
    '--loadModule', path.join(HERE, 'modules', 'perf-time'), '--controlChannel', 'ipc'],
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
    return await drive(sessions, calls);
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
  if (process.platform === 'win32') throw new Error('the shared runtime does not run on Windows yet (each session runs its own there)');
  const shim = shimOf(o);
  if (!fs.existsSync(shim)) throw new Error(`no ch-shim at ${shim}`);
  const machine = {cpus: os.cpus().length, model: (os.cpus()[0] || {}).model, node: process.version, platform: `${os.platform()} ${os.release()}`, loadavgAtStart: os.loadavg()};
  process.stdout.write(`latency gate: ${machine.cpus} CPUs (${machine.model}), node ${machine.node}, load ${machine.loadavgAtStart.map((x) => x.toFixed(2)).join('/')}; ${o.rounds} rounds of ${o.calls} calls per session\n`);
  const rows = [];
  for (const n of o.sessions) {
    const a = [], s = [];
    for (let r = 0; r < o.rounds; r++) {
      a.push(median(await separate(n, o.calls)));
      s.push(median(await shared(n, o.calls, shim)));
      process.stdout.write(`  N=${n} round ${r + 1}: separate ${a[r].toFixed(2)} ms, shared ${s[r].toFixed(2)} ms\n`);
    }
    const A = median(a), S = median(s);
    const limit = n === 1 ? A + 2 : A;
    const pass = S <= limit;
    rows.push({n, separateMs: A, sharedMs: S, overMs: S - A, limitMs: limit, pass, rounds: {separate: a, shared: s}});
    process.stdout.write(`N=${n}: separate ${A.toFixed(2)} ms, shared ${S.toFixed(2)} ms (${S - A >= 0 ? '+' : ''}${(S - A).toFixed(2)} ms); gate ${n === 1 ? 'shared <= separate + 2 ms' : 'shared <= separate'}: ${pass ? 'PASS' : 'FAIL'}\n`);
  }
  const verdict = rows.every((r) => r.pass) ? 'PASS' : 'FAIL';
  process.stdout.write(`verdict: ${verdict}\n`);
  const result = {when: new Date().toISOString(), machine, calls: o.calls, rounds: o.rounds, rows, verdict, loadavgAtEnd: os.loadavg()};
  if (o.json != null) fs.writeFileSync(o.json, `${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = verdict === 'PASS' ? 0 : 1;
}

main().catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exitCode = 2; });
