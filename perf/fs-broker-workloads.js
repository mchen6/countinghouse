// The file broker's workloads beyond the 4-op round (the broker performance
// spec, docs/superpowers/specs/2026-11-09-fs-broker-performance-design.md,
// section 2):
//   S: many small writes to one descriptor (10 000 x 100 bytes), a logger's
//      or a stream's shape;
//   W: a repo walk -- readdir and stat over 3 000 files in 30 directories;
//   L: a dependency-heavy require at load -- a POST /reload-module round
//      trip until a module that requires 300 packages (3 files each) answers
//      (a new worker under --workerThread, a purged require cache without).
// Under --no-workerThread (no broker), --moduleSandbox off and enforce, with
// perf/fixtures/fs-bench (copied, with a generated node_modules for L).
// RUNS timed runs after a warm-up; median, min and max, each printed as it is
// measured. --count instead prints the machine-independent counts for S and
// W: bridge calls and libuv pool jobs (async fs calls on the main thread) per
// operation, with the broker as the runtime makes it (createForWorker: the
// always-denied set, the quota, the write guards).
//   node perf/fs-broker-workloads.js [--count] [--only S,W,L]
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../test/helpers/sandbox-server');

const PORT = 9642;
const KEY = 'k';
const RUNS = 5;
const FIXTURE = path.join(__dirname, 'fixtures', 'fs-bench');
const S = {writes: 10000, size: 100};
const W = {dirs: 30, files: 100};
const L = {deps: 300, filesPerDep: 3};
const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const ONLY = (arg('--only') || 'S,W,L').split(',');

const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const stats = (xs) => ({median: +median(xs).toFixed(1), min: +Math.min(...xs).toFixed(1), max: +Math.max(...xs).toFixed(1)});
const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;

// The fixture, with L's node_modules: dep-<i>/index.js requires its lib files.
function moduleCopy(base) {
  const dir = path.join(base, 'fs-bench');
  fs.cpSync(FIXTURE, dir, {recursive: true});
  const names = [];
  for (let i = 0; i < L.deps; i++) {
    const name = `dep-${i}`;
    const d = path.join(dir, 'node_modules', name);
    fs.mkdirSync(path.join(d, 'lib'), {recursive: true});
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({name, version: '1.0.0', main: 'index.js'}));
    const libs = [];
    for (let f = 1; f < L.filesPerDep; f++) {
      fs.writeFileSync(path.join(d, 'lib', `f${f}.js`), `module.exports = ${f};\n`);
      libs.push(`require('./lib/f${f}.js')`);
    }
    fs.writeFileSync(path.join(d, 'index.js'), `module.exports = [${libs.join(', ')}];\n`);
    names.push(name);
  }
  fs.writeFileSync(path.join(dir, 'deps.json'), JSON.stringify(names));
  return dir;
}

const call = async (tool, args) => {
  const r = await mcpCall(PORT, KEY, tool, args);
  if (r.structuredContent == null) throw new Error(`${tool}: ${JSON.stringify(r)}`);
  return r.structuredContent;
};
async function timed(fn) {
  await fn();   // warm-up
  const out = [];
  for (let i = 0; i < RUNS; i++) out.push(await fn());
  return stats(out);
}

async function wallClock(label, flags, base, mod) {
  const server = await startServer(PORT, flags.concat(['--debug', '--debugKey', KEY, '--requestTimeout', '300000',
    '--moduleDataPath', path.join(base, label.replace(/\W+/g, '-')), '--loadModule', mod]));
  try {
    const out = {mode: label};
    if ((await call('fs_bench_benchservice_loaded', {})).deps !== L.deps) throw new Error('the dependencies were not loaded');
    if (ONLY.includes('S')) out.S_handler_ms = await timed(async () => (await call('fs_bench_benchservice_smallwrites', S)).ms);
    if (ONLY.includes('W')) {
      await call('fs_bench_benchservice_seedtree', W);
      out.W_handler_ms = await timed(async () => (await call('fs_bench_benchservice_walk', {})).ms);
    }
    if (ONLY.includes('L')) {
      out.L_reload_ms = await timed(async () => {
        const t = process.hrtime.bigint();
        const r = await post(PORT, KEY, '/reload-module', {path: mod});
        if (r.status !== 200) throw new Error(JSON.stringify(r.body));
        await waitFor(async () => {
          try { return (await mcpCall(PORT, KEY, 'fs_bench_benchservice_loaded', {})).structuredContent != null; } catch (e) { return false; }
        }, 120000, 'fs-bench back');
        return ms(t);
      });
    }
    return out;
  } finally {
    stopServer(server);
  }
}

// --count: the broker's own counts, per operation.
async function counts(base, mod) {
  const counted = {};
  const count = (name) => { counted[name] = (counted[name] || 0) + 1; };
  const wrapHandle = (fh) => {
    ['stat', 'read', 'write', 'truncate', 'close', 'sync'].forEach((k) => {
      const orig = fh[k].bind(fh);
      fh[k] = (...a) => { count(`fh.${k}`); return orig(...a); };
    });
    return fh;
  };
  for (const k of ['realpath', 'stat', 'lstat', 'open', 'readlink', 'unlink', 'readdir', 'mkdir', 'access', 'rename', 'rm', 'rmdir']) {
    const orig = fsp[k];
    fsp[k] = (...a) => { count(k); const r = orig(...a); return k === 'open' ? r.then(wrapHandle) : r; };
  }
  const fsBroker = require('../lib/fs-broker');
  const out = {};
  for (const mode of ['off', 'audit', 'enforce']) {
    const options = {moduleDataPath: path.join(base, `count-${mode}`), modulePath: path.join(base, 'modules'), localModulePath: [mod]};
    const fsb = await fsBroker.createForWorker({name: 'fs-bench', mode, modulePath: mod, declared: [], options,
      limits: {diskMb: 1024, diskEntries: 1000000}, report: () => {}});
    const b = fsb.broker;
    const measure = async (n, fn) => {
      await fn();   // warm-up
      Object.keys(counted).forEach((k) => delete counted[k]);
      let bridge = 0;
      await fn(() => { bridge += 1; });
      const pool = Object.values(counted).reduce((a, c) => a + c, 0);
      return {bridgeCallsPerOp: +(bridge / n).toFixed(2), poolJobsPerOp: +(pool / n).toFixed(2), byCall: Object.assign({}, counted)};
    };
    const res = {};
    const writes = 100;
    res.S = await measure(writes, async (tick = () => {}) => {
      tick(); const fd = await b.handle('open', ['/data/s.log', 'w', 0o644]);
      for (let i = 0; i < writes; i++) { tick(); await b.handle('write', [fd, Buffer.alloc(S.size, 120), null]); }
      tick(); await b.handle('close', [fd]);
    });
    const host = path.join(fsb.dirs.data, 'tree');
    for (let d = 0; d < 3; d++) {
      fs.mkdirSync(path.join(host, `d${d}`), {recursive: true});
      for (let f = 0; f < 10; f++) fs.writeFileSync(path.join(host, `d${d}`, `f${f}.txt`), 'x');
    }
    let entries = 0;
    res.W = await measure(33, async (tick = () => {}) => {
      entries = 0;
      const walk = async (dir) => {
        tick(); const names = await b.handle('readdir', [dir, {}]);
        for (const name of names) {
          tick(); const st = await b.handle('stat', [`${dir}/${name}`]);
          entries += 1;
          if ((st.fields.mode & 0o170000) === 0o040000) await walk(`${dir}/${name}`);
        }
      };
      await walk('/data/tree');
    });
    res.W.entries = entries;
    out[mode] = res;
    await fsb.bridge.close();
  }
  return out;
}

(async () => {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.ch-fsb-workloads-'));
  try {
    const mod = moduleCopy(base);
    if (process.argv.includes('--count')) {
      console.log(JSON.stringify({node: process.version, S: `${S.size}-byte writes to one descriptor`, W: 'readdir + stat per entry',
        counts: await counts(base, mod)}, null, 2));
      return;
    }
    console.log(JSON.stringify({node: process.version, cpus: os.cpus().length, uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE || '16 (countinghouse default)',
      runs: RUNS, S, W, L, only: ONLY}));
    console.log(JSON.stringify(await wallClock('single-thread (no broker)', ['--no-workerThread'], base, mod)));
    console.log(JSON.stringify(await wallClock('worker, off', ['--workerThread', '--moduleSandbox', 'off'], base, mod)));
    console.log(JSON.stringify(await wallClock('worker, enforce', ['--workerThread', '--moduleSandbox', 'enforce'], base, mod)));
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
})().catch((e) => { console.error(e); process.exit(1); });
