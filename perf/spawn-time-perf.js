// What a module worker's start costs in module sandbox part 2: the file
// broker's setup (data directories, the spawn walk over an empty and a
// 10 000-file /data, countinghouse's code roots -- its dependency closure,
// ~300 realpaths -- and the namespace), timed in-process; then a full
// POST /restart-module round trip until the module answers again.
// 10 runs each; median, min and max.
//   node perf/spawn-time-perf.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../test/helpers/sandbox-server');

const RUNS = 10;
const PORT = 9641;
const PROBE = path.join(ROOT, 'test', 'fixtures', 'fs-probe');
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const stats = (xs) => ({median: +median(xs).toFixed(1), min: +Math.min(...xs).toFixed(1), max: +Math.max(...xs).toFixed(1)});
const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;

async function timeRuns(fn) {
  const out = [];
  for (let i = 0; i < RUNS; i++) { const t = process.hrtime.bigint(); await fn(); out.push(ms(t)); }
  return stats(out);
}

(async () => {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.ch-spawn-perf-'));
  try {
    const identity = require('../lib/fs-broker/identity');
    const spawnWalk = require('../lib/fs-broker/spawn-walk');
    const fsBroker = require('../lib/fs-broker');
    const installDir = fs.realpathSync(ROOT);
    const results = {};
    results.codeRootsFor = await timeRuns(async () => identity.codeRootsFor(installDir, fs.realpathSync, []));
    results.codeRoots = identity.codeRootsFor(installDir, fs.realpathSync, []).length;
    const empty = path.join(base, 'empty');
    fs.mkdirSync(path.join(empty, 'data'), {recursive: true});
    fs.mkdirSync(path.join(empty, 'tmp'));
    results.walkEmpty = await timeRuns(() => spawnWalk.measure([[path.join(empty, 'data'), '/data'], [path.join(empty, 'tmp'), '/tmp']]));
    const full = path.join(base, 'full');
    for (let d = 0; d < 100; d++) {
      fs.mkdirSync(path.join(full, 'data', `d${d}`), {recursive: true});
      for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(full, 'data', `d${d}`, `f${f}`), 'x');
    }
    fs.mkdirSync(path.join(full, 'tmp'));
    results.walk10000Files = await timeRuns(() => spawnWalk.measure([[path.join(full, 'data'), '/data'], [path.join(full, 'tmp'), '/tmp']]));
    const options = {moduleDataPath: path.join(base, 'store'), modulePath: path.join(base, 'modules'), localModulePath: [PROBE]};
    results.createForWorker = await timeRuns(async () => {
      const fsb = await fsBroker.createForWorker({name: 'fs-probe', mode: 'enforce', modulePath: PROBE, declared: [], options: options,
        limits: {diskMb: 1024, diskEntries: 100000}, report: () => {}});
      await fsb.bridge.close();
    });
    const server = await startServer(PORT, ['--workerThread', '--moduleSandbox', 'enforce', '--debug', '--debugKey', 'k',
      '--moduleDataPath', path.join(base, 'server-store'), '--loadModule', PROBE]);
    try {
      results.restartRoundTrip = await timeRuns(async () => {
        const r = await post(PORT, 'k', '/restart-module', {name: 'fs-probe'});
        if (r.status !== 200) throw new Error(JSON.stringify(r.body));
        await waitFor(async () => (await mcpCall(PORT, 'k', 'fs_probe_probeservice_read', {path: '/data/none'})).structuredContent != null, 30000, 'module back');
      });
    } finally {
      stopServer(server);
    }
    console.log(JSON.stringify({node: process.version, cpus: os.cpus().length, runs: RUNS, ms: results}, null, 2));
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
})().catch((e) => { console.error(e); process.exit(1); });
