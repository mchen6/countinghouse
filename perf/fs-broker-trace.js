// Broker performance, proposal 3 (docs/superpowers/specs/2026-11-09-fs-
// broker-performance-design.md, section 7): the input -- a trace of the
// bridge calls during workloads L (a reload of a module that requires 300
// packages), W (readdir + stat over 3 000 files), the tree's seeding (mkdir
// -p and small files) and S (small writes), under enforce. Prints,
// per workload, the calls by op and the most frequent pairs of consecutive
// calls on one path (what a compound op would fold). A descriptor op is
// traced as 'fd' whatever the descriptor, and the pairs are over one stream
// of every broker's calls: right for these workloads (one module, one
// descriptor at a time), not for one with several descriptors or brokers.
//   node perf/fs-broker-trace.js [top=15]
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startServer, stopServer, mcpCall, post, waitFor} = require('../test/helpers/sandbox-server');

const PORT = 9644;
const KEY = 'k';
const TOP = Number(process.argv[2]) || 15;

function summarise(lines) {
  const ops = {};
  const pairs = {};
  let prev = null;
  for (const [, op, p] of lines) {
    ops[op] = (ops[op] || 0) + 1;
    if (prev != null && p != null && prev[1] === p) pairs[`${prev[0]} -> ${op}`] = (pairs[`${prev[0]} -> ${op}`] || 0) + 1;
    prev = [op, p];
  }
  const top = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, TOP);
  return {calls: lines.length, byOp: top(ops), samePathPairs: top(pairs)};
}

let base = null;
let server = null;
(async () => {
  base = fs.mkdtempSync(path.join(os.homedir(), '.ch-fsb-trace-'));
  const trace = path.join(base, 'trace.jsonl');
  // the workloads script's module copy, with L's node_modules
  const mod = path.join(base, 'fs-bench');
  fs.cpSync(path.join(__dirname, 'fixtures', 'fs-bench'), mod, {recursive: true});
  const names = [];
  for (let i = 0; i < 300; i++) {
    const d = path.join(mod, 'node_modules', `dep-${i}`);
    fs.mkdirSync(path.join(d, 'lib'), {recursive: true});
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({name: `dep-${i}`, version: '1.0.0', main: 'index.js'}));
    for (let f = 1; f < 3; f++) fs.writeFileSync(path.join(d, 'lib', `f${f}.js`), `module.exports = ${f};\n`);
    fs.writeFileSync(path.join(d, 'index.js'), "module.exports = [require('./lib/f1.js'), require('./lib/f2.js')];\n");
    names.push(`dep-${i}`);
  }
  fs.writeFileSync(path.join(mod, 'deps.json'), JSON.stringify(names));
  // (the preload in the server's own node flags: nothing it spawns loads it,
  // and a path with a space stays one argument)
  server = await startServer(PORT, ['--workerThread', '--moduleSandbox', 'enforce', '--debug', '--debugKey', KEY, '--requestTimeout', '300000',
    '--moduleDataPath', path.join(base, 'data'), '--loadModule', mod],
  {nodeArgs: ['--require', path.join(__dirname, 'fixtures', 'trace-broker-ops.js')], env: {CH_FSB_TRACE_OUT: trace}});
  const read = () => fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const loaded = async () => {
    const r = await mcpCall(PORT, KEY, 'fs_bench_benchservice_loaded', {});
    if (r.structuredContent == null || r.structuredContent.deps !== names.length) throw new Error(`the dependencies were not loaded: ${JSON.stringify(r)}`);
  };
  {
    await loaded();
    await mcpCall(PORT, KEY, 'fs_bench_benchservice_seedtree', {dirs: 30, files: 100});
    // L: one reload, checked as the workloads script checks it: answered 200,
    // and the module back with every dependency loaded
    fs.writeFileSync(trace, '');
    const reloaded = await post(PORT, KEY, '/reload-module', {path: mod});
    if (reloaded.status !== 200) throw new Error(`the reload was refused: ${JSON.stringify(reloaded.body)}`);
    await waitFor(async () => {
      try { await loaded(); return true; } catch (e) { return false; }
    }, 120000, 'back');
    const L = summarise(read());
    // W: one walk
    fs.writeFileSync(trace, '');
    await mcpCall(PORT, KEY, 'fs_bench_benchservice_walk', {});
    const W = summarise(read());
    // the tree's seeding (mkdir -p, then many small files) and S
    fs.writeFileSync(trace, '');
    await mcpCall(PORT, KEY, 'fs_bench_benchservice_seedtree', {dirs: 5, files: 10});
    const seed = summarise(read());
    fs.writeFileSync(trace, '');
    await mcpCall(PORT, KEY, 'fs_bench_benchservice_smallwrites', {writes: 100, size: 100});
    const S = summarise(read());
    console.log(JSON.stringify({L, W, seed, S}, null, 2));
  }
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  // every path: the server stopped, the tree removed (an early failure too)
  if (server != null) stopServer(server);
  if (base != null) fs.rmSync(base, {recursive: true, force: true});
});
