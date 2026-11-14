// Broker performance, proposal 4 (docs/superpowers/specs/2026-11-09-fs-
// broker-performance-design.md, section 5): where the main thread's time goes
// while the broker serves. Starts a server under --moduleSandbox enforce with
// --cpu-prof (NODE_OPTIONS), runs workload R (250 rounds, 3 times) and S
// and W (perf/fs-broker-workloads.js), stops it with SIGINT (so the profile is
// written), and prints the main thread's top functions by self time, and the
// share of the profile each file takes.
//   node perf/fs-broker-profile.js [top=30] [--keep <dir>]
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ROOT, startServer, mcpCall} = require('../test/helpers/sandbox-server');

const PORT = 9643;
const KEY = 'k';
const TOP = Number(process.argv[2]) || 30;
const keepAt = process.argv.indexOf('--keep');

async function call(tool, args) {
  const r = await mcpCall(PORT, KEY, tool, args);
  if (r.structuredContent == null) throw new Error(`${tool}: ${JSON.stringify(r)}`);
  return r.structuredContent;
}

// cpuprofile -> self time (µs) per function and per file.
function selfTimes(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas;
  for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i], (self.get(profile.samples[i]) || 0) + (dt[i] || 0));
  const fns = new Map();
  const files = new Map();
  let total = 0;
  for (const [id, us] of self) {
    const cf = byId.get(id).callFrame;
    const file = cf.url ? cf.url.replace(`file://${ROOT}/`, '').replace(`${ROOT}/`, '') : `(${cf.functionName || 'native'})`;
    const fn = `${cf.functionName || '(anonymous)'} ${file}:${cf.lineNumber + 1}`;
    fns.set(fn, (fns.get(fn) || 0) + us);
    files.set(file, (files.get(file) || 0) + us);
    total += us;
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => ({ms: +(us / 1000).toFixed(1), pct: +(100 * us / total).toFixed(1), where: k}));
  return {totalMs: +(total / 1000).toFixed(1), functions: top(fns, TOP), files: top(files, 15)};
}

(async () => {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.ch-fsb-profile-'));
  const profDir = keepAt > 0 ? path.resolve(process.argv[keepAt + 1]) : path.join(base, 'prof');
  fs.mkdirSync(profDir, {recursive: true});
  const bench = path.join(base, 'fs-bench');
  fs.cpSync(path.join(__dirname, 'fixtures', 'fs-bench'), bench, {recursive: true});
  const server = await startServer(PORT, ['--workerThread', '--moduleSandbox', 'enforce', '--debug', '--debugKey', KEY, '--requestTimeout', '300000',
    '--moduleDataPath', path.join(base, 'data'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'fs-probe'), '--loadModule', bench],
  {env: {NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${profDir}`}});
  try {
    for (let i = 0; i < 3; i++) await call('fs_probe_probeservice_iobench', {rounds: 250});
    await call('fs_bench_benchservice_smallwrites', {writes: 10000, size: 100});
    await call('fs_bench_benchservice_seedtree', {dirs: 30, files: 100});
    for (let i = 0; i < 3; i++) await call('fs_bench_benchservice_walk', {});
  } finally {
    await new Promise((resolve) => {
      server.once('exit', resolve);
      try { process.kill(-server.pid, 'SIGINT'); } catch (e) { resolve(); }
      setTimeout(resolve, 30000);
    });
  }
  // The main thread's profile is the largest; the workers write their own.
  const profiles = fs.readdirSync(profDir).filter((f) => f.endsWith('.cpuprofile'))
    .map((f) => ({f, p: JSON.parse(fs.readFileSync(path.join(profDir, f), 'utf8'))}));
  const main = profiles.find((x) => /^CPU\.[^.]+\.\d+\.0\.\d+\.cpuprofile$/.test(x.f)) || profiles[0];
  if (main == null) throw new Error(`no profile written in ${profDir}`);
  console.log(JSON.stringify({node: process.version, cpus: os.cpus().length, profile: main.f, ...selfTimes(main.p)}, null, 2));
  if (keepAt < 0) fs.rmSync(base, {recursive: true, force: true});
})().catch((e) => { console.error(e); process.exit(1); });
