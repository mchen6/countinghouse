// File I/O through the module file broker (module sandbox part 2): one
// module doing 1000 rounds of write 4 KB / read / stat / unlink in /data,
// under --no-workerThread (no broker: the baseline), --moduleSandbox off and
// enforce; then 10 modules at once under enforce, each doing a tenth of the
// rounds (the same total work: the scheduler's fair share and global cap).
// 5 timed runs after a warm-up; median, min and max. Each result is printed
// as soon as it is measured.
//   node perf/fs-broker-io-perf.js [rounds]
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../test/helpers/sandbox-server');

const PORT = 9640;
const KEY = 'k';
const ROUNDS = Number(process.argv[2]) || 1000;
const RUNS = 5;

const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const stats = (xs) => ({median: +median(xs).toFixed(1), min: +Math.min(...xs).toFixed(1), max: +Math.max(...xs).toFixed(1)});

async function timeOne(tool, rounds) {
  const started = process.hrtime.bigint();
  const r = await mcpCall(PORT, KEY, tool, {rounds: rounds || ROUNDS});
  const wall = Number(process.hrtime.bigint() - started) / 1e6;
  if (r.structuredContent == null) throw new Error(JSON.stringify(r));
  return {inner: r.structuredContent.output.ms, wall: wall};
}

async function single(label, flags, base) {
  const server = await startServer(PORT, flags.concat(['--debug', '--debugKey', KEY, '--requestTimeout', '300000', '--moduleDataPath', path.join(base, label),
    '--loadModule', path.join(ROOT, 'test', 'fixtures', 'fs-probe')]));
  try {
    await timeOne('fs_probe_probeservice_iobench');   // warm-up
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await timeOne('fs_probe_probeservice_iobench'));
    return {mode: label, handler_ms: stats(runs.map((r) => r.inner)), call_ms: stats(runs.map((r) => r.wall))};
  } finally {
    stopServer(server);
  }
}

async function tenAtOnce(base) {
  const mods = [];
  for (let i = 0; i < 10; i++) {
    const dir = path.join(base, 'mods', `fs-probe-${i}`);
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'fs-probe'), dir, {recursive: true});
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.name = `fs-probe-${i}`;
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    fs.writeFileSync(path.join(dir, 'api.json'), fs.readFileSync(path.join(dir, 'api.json'), 'utf8').replace('"friendlyName": "fs-probe"', `"friendlyName": "fs-probe-${i}"`));
    mods.push(dir);
  }
  const server = await startServer(PORT, ['--workerThread', '--moduleSandbox', 'enforce', '--debug', '--debugKey', KEY,
    '--requestTimeout', '300000', '--moduleDataPath', path.join(base, 'ten')].concat(...mods.map((m) => ['--loadModule', m])));
  const share = Math.max(1, Math.round(ROUNDS / 10));
  try {
    const tools = mods.map((m, i) => `fs_probe_${i}_probeservice_iobench`);
    await Promise.all(tools.map((t) => timeOne(t, share)));   // warm-up
    const runs = [];
    for (let r = 0; r < RUNS; r++) {
      const started = process.hrtime.bigint();
      const each = await Promise.all(tools.map((t) => timeOne(t, share)));
      runs.push({total: Number(process.hrtime.bigint() - started) / 1e6, slowest: Math.max(...each.map((e) => e.wall)), fastest: Math.min(...each.map((e) => e.wall))});
    }
    return {mode: `enforce, 10 modules at once, ${share} rounds each`, total_ms: stats(runs.map((r) => r.total)),
      fastest_call_ms: stats(runs.map((r) => r.fastest)), slowest_call_ms: stats(runs.map((r) => r.slowest))};
  } finally {
    stopServer(server);
  }
}

(async () => {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.ch-io-perf-'));
  try {
    console.log(JSON.stringify({node: process.version, cpus: os.cpus().length, uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE || '16 (countinghouse default)',
      rounds: ROUNDS, opsPerRound: 4, runs: RUNS}));
    console.log(JSON.stringify(await single('single-thread (no broker)', ['--no-workerThread'], base)));
    console.log(JSON.stringify(await single('worker, off', ['--workerThread', '--moduleSandbox', 'off'], base)));
    console.log(JSON.stringify(await single('worker, enforce', ['--workerThread', '--moduleSandbox', 'enforce'], base)));
    console.log(JSON.stringify(await tenAtOnce(base)));
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
})().catch((e) => { console.error(e); process.exit(1); });
