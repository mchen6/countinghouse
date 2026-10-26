// Benchmark for examples/log-triage: how the composite's latency follows its
// input, what the runtime adds on top of the work itself, and what the same
// hops cost when a client orchestrates them instead. docs/log-triage-performance.md
// carries a run of this script and how to read it.
//
//   node perf/log-triage-perf.js [--reps <n>] [--runs <n>] [--json <file>]
//        [--moduleSandbox <mode>] [--sandboxModes off,audit,enforce]
//        [--paths direct|routed|both] [--matrix full|headline]
//
// Four measurements, each on both hop paths (direct peer channels, the
// default, and --no-directPeerChannels):
//
//   1. files    latency against the number of files read (maxFiles 1..32,
//               400 lines each). Hops are 2N + 2.
//   2. size     latency against file size at 8 files (100..6400 lines each).
//   3. baseline the same work in this process with no runtime at all: the
//               four handlers called as plain functions, one after another.
//               composite - baseline is what hops, schema validation,
//               metering and HTTP cost together.
//   4. client   the same 2N + 2 tool calls made one by one by an MCP client
//               holding the leaf tools, raw lines crossing the wire both ways.
//
// --matrix headline measures only the composite at 8 files of 400 lines (and
// its baseline), for comparing server configurations such as sandbox modes.
//
// The servers are non-debug with metering on (--mcpToolCallCost 1), so every
// hop pays its Redis round trip as it would in a deployment. Each server gets
// its own temporary auth file and keys; nothing is left in examples/.
//
// Latency is measured at the client around one tools/call, in milliseconds.
// With REPS in the tens each run reports median, min and max rather than a
// p95 that so few samples could not support. With --runs, each run is a
// fresh process with fresh servers (perf/multi-run.js): a cell is then the
// median of the runs' medians, with the [min-max] range of those medians,
// and every comparison sentence below the tables counts one side as faster
// only when the two ranges do not overlap. Derived figures (runtime adds,
// per hop, per file, shares) are computed within each run and then reported
// across runs the same way. A failed call is counted by error code and left
// out of the samples rather than ending the run.
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const spawn = require('child_process').spawn;

const multiRun = require('./multi-run');

const ROOT    = path.resolve(__dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples', 'log-triage');

const gen = require(path.join(EXAMPLE, 'generate-logs.js'));

// the leaf handlers use the runtime's global DeviceError
if (typeof DeviceError === 'undefined') {
  global.DeviceError = require(path.join(ROOT, 'lib', 'countinghouse-error')).DeviceError;
}
const handlers = {
  list:    require(path.join(EXAMPLE, 'log-read', 'handlers', 'readService', 'list.js')),
  read:    require(path.join(EXAMPLE, 'log-read', 'handlers', 'readService', 'read.js')),
  redact:  require(path.join(EXAMPLE, 'pii-redact', 'handlers', 'redactService', 'redact.js')),
  cluster: require(path.join(EXAMPLE, 'error-cluster', 'handlers', 'clusterService', 'cluster.js'))
};

const TRIAGE_DEVICE  = 'dad07d2a-9d65-5ef5-af59-05c0160c5fdc';
const READ_DEVICE    = 'fd0eafbd-20da-53e6-9302-681687350a3b';
const REDACT_DEVICE  = 'b5048beb-2128-52c0-9cd4-42669f57090f';
const CLUSTER_DEVICE = '9f9aab37-b175-5286-81c3-68bdd24bd4f7';

const TOOLS = {
  triage:  'log_triage_triageservice_triage',
  list:    'log_read_readservice_list',
  read:    'log_read_readservice_read',
  redact:  'pii_redact_redactservice_redact',
  cluster: 'error_cluster_clusterservice_cluster'
};

const ALL_PATHS = [
  {label: 'direct',             port: 9602, flags: []},
  {label: 'main-thread-routed', port: 9603, flags: ['--no-directPeerChannels']}
];

const FILE_COUNTS = [1, 2, 4, 8, 16, 32];
const LINE_COUNTS = [100, 400, 1600, 6400];
const SIZE_FILES  = 8;
const CLIENT_FILES = 8;
const HEADLINE    = {files: 8, lines: 400};
const WARMUP      = 5;

const argValue  = multiRun.argValue;
const REPS      = Number(argValue('--reps', 15));
const MATRIX    = argValue('--matrix', 'full');
const PATHS     = (() => {
  const p = argValue('--paths', 'both');
  if (p === 'both') return ALL_PATHS;
  return ALL_PATHS.filter((x) => (p === 'direct' ? x.label === 'direct' : x.label !== 'direct'));
})();
const SANDBOX_MODES = (() => {
  const v = argValue('--sandboxModes', null);
  return v != null ? v.split(',').map((s) => s.trim()).filter((s) => s !== '') : [null];
})();

let currentServer = null;
let tempRoot      = null;

function cleanupAndExit(code) {
  if (currentServer != null) { try { currentServer.kill('SIGKILL'); } catch (e) { /* gone */ } }
  if (tempRoot != null) { try { fs.rmSync(tempRoot, {recursive: true, force: true}); } catch (e) { /* gone */ } }
  process.exit(code);
}
process.on('SIGINT',  () => cleanupAndExit(130));
process.on('SIGTERM', () => cleanupAndExit(130));

function sandboxFlags(sandbox) {
  return sandbox != null ? ['--moduleSandbox', sandbox] : multiRun.sandboxArgs();
}

function serverArgs(port, authPath, flags) {
  return [path.join(ROOT, 'framework.js'),
    '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(port),
    '--authProvider', 'file', '--authConfigPath', authPath, '--mcpToolCallCost', '1',
    '--loadModule', path.join(EXAMPLE, 'log-read'),
    '--loadModule', path.join(EXAMPLE, 'pii-redact'),
    '--loadModule', path.join(EXAMPLE, 'error-cluster'),
    '--loadModule', path.join(EXAMPLE, 'log-triage')].concat(flags);
}

// Resolves with the server once it is ready; the server's log keeps being
// read afterwards, and its sandbox lines are counted into sandboxLog when it
// exits.
function startServer(args, sandboxLog) {
  return new Promise((resolve, reject) => {
    const server = spawn(process.execPath, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    currentServer = server;

    let out = '';
    let log = '';
    let settled = false;
    const settle = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };

    const timer = setTimeout(() => {
      server.kill('SIGKILL');
      settle(reject, new Error(`server was never ready:\n${out.slice(-2000)}`));
    }, 90000);

    server.on('exit', (code, signal) => {
      multiRun.scanSandboxLog(log, sandboxLog);
      settle(reject, new Error(`server exited before it was ready (code=${code} signal=${signal}):\n${out.slice(-2000)}`));
    });

    const onData = (buf) => {
      const text = buf.toString();
      log += text;
      if (settled) return;
      out += text;
      if (/countinghouse ready/.test(out)) settle(resolve, server);
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
  });
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (server == null || server.exitCode != null) return resolve();
    server.once('exit', () => resolve());
    server.kill('SIGKILL');
  });
}

// One tools/call. Returns the tool's output, the wall time and the JSON body
// bytes sent and received -- or {error} with the response text when the call
// failed.
async function call(url, key, tool, args) {
  const body  = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: tool, arguments: args}});
  const start = process.hrtime.bigint();
  const res   = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-CH-Key': key},
    body: body
  });
  const text = await res.text();
  const ms   = Number(process.hrtime.bigint() - start) / 1e6;

  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (parsed == null || parsed.result == null || parsed.result.isError !== false) {
    return {error: `${tool}: ${text.slice(0, 600)}`};
  }
  return {
    out:      parsed.result.structuredContent.output,
    ms:       ms,
    reqBytes: Buffer.byteLength(body),
    resBytes: Buffer.byteLength(text)
  };
}

function summarize(samples) {
  if (samples.length === 0) return null;
  const sorted = samples.slice().sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  const median = (sorted.length % 2 === 1) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {median: median, min: sorted[0], max: sorted[sorted.length - 1], n: sorted.length};
}

// errors: the condition's {code: count} tally, shared across its cells
async function repeat(fn, errors) {
  const record = (r) => {
    if (r.error == null) return true;
    const code = multiRun.classifyError(r.error);
    errors.tally[code] = (errors.tally[code] || 0) + 1;
    if (errors.samples.length < 3) errors.samples.push(r.error);
    return false;
  };
  for (let i = 0; i < WARMUP; i++) record(await fn());
  const samples = [];
  let last = null;
  for (let i = 0; i < REPS; i++) {
    const r = await fn();
    if (record(r)) { last = r; samples.push(r.ms); }
  }
  return {stats: summarize(samples), last: last};
}

// The same work with no runtime: the handlers as plain functions, in the
// order the composite calls them, one file after another.
async function inProcess(dir, maxFiles) {
  const t = {list: 0, read: 0, redact: 0, cluster: 0};
  const clock = async (key, fn) => {
    const s = process.hrtime.bigint();
    const r = await fn();
    t[key] += Number(process.hrtime.bigint() - s) / 1e6;
    return r;
  };

  const start  = process.hrtime.bigint();
  const listed = (await clock('list', () => handlers.list({dir: dir}))).output;
  const chosen = listed.files.slice(0, maxFiles);

  let lines = [];
  for (const file of chosen) {
    const raw      = (await clock('read',   () => handlers.read({dir: dir, name: file.name}))).output;
    const redacted = (await clock('redact', () => handlers.redact({lines: raw.lines}))).output;
    lines = lines.concat(redacted.lines);
  }
  if (chosen.length > 0) await clock('cluster', () => handlers.cluster({lines: lines}));

  return {ms: Number(process.hrtime.bigint() - start) / 1e6, stages: t, lineCount: lines.length};
}

// The same 2N + 2 tool calls, made one at a time by a client that holds the
// leaf tools. Raw lines come down from read and go back up to redact.
async function clientOrchestrated(url, key, dir, maxFiles) {
  let ms = 0, reqBytes = 0, resBytes = 0, calls = 0;
  const step = async (tool, args) => {
    const r = await call(url, key, tool, args);
    if (r.error != null) throw r;
    ms += r.ms; reqBytes += r.reqBytes; resBytes += r.resBytes; calls++;
    return r.out;
  };

  try {
    const listed = await step(TOOLS.list, {dir: dir});
    let lines = [];
    for (const file of listed.files.slice(0, maxFiles)) {
      const raw      = await step(TOOLS.read, {dir: dir, name: file.name});
      const redacted = await step(TOOLS.redact, {lines: raw.lines});
      lines = lines.concat(redacted.lines);
    }
    await step(TOOLS.cluster, {lines: lines});
  } catch (e) {
    if (e != null && e.error != null) return {error: e.error};
    throw e;
  }

  return {ms: ms, reqBytes: reqBytes, resBytes: resBytes, calls: calls};
}

function checkHops(r, n) {
  if (r.last != null && r.last.out.cost.hops !== 2 * n + 2) {
    throw new Error(`expected ${2 * n + 2} hops at N=${n}, got ${r.last.out.cost.hops}`);
  }
}

async function runCondition(p, sandbox, dirs) {
  const url          = `http://127.0.0.1:${p.port}`;
  const caller       = `perf-caller-${p.port}-${process.pid}`;
  const orchestrator = `perf-orchestrator-${p.port}-${process.pid}`;
  const authPath     = path.join(dirs.root, `auth-${p.port}.json`);

  const config = {};
  config[caller]       = {userName: 'perf-caller', devices: [TRIAGE_DEVICE]};
  config[orchestrator] = {userName: 'perf-orchestrator', devices: [READ_DEVICE, REDACT_DEVICE, CLUSTER_DEVICE]};
  config['log-triage-internal'] = {
    userName: 'log-triage-internal',
    devices: [READ_DEVICE, REDACT_DEVICE, CLUSTER_DEVICE],
    runsModules: ['log-triage']
  };
  fs.writeFileSync(authPath, JSON.stringify(config));

  const args = serverArgs(p.port, authPath, p.flags.concat(sandboxFlags(sandbox)));
  const sandboxLog = multiRun.newSandboxLog();
  const errors = {tally: {}, samples: []};
  console.error(`\n=== ${p.label}, sandbox ${multiRun.sandboxMode(args)} ===`);
  const server = await startServer(args, sandboxLog);
  const result = {label: p.label, sandbox: sandbox, sandboxMode: multiRun.sandboxMode(args),
                  files: [], size: [], client: null, headline: null, errors: errors, sandboxLog: sandboxLog};
  const triage = (dir, n) => call(url, caller, TOOLS.triage, {dir: dir, maxFiles: n});

  try {
    if (MATRIX === 'headline') {
      const r = await repeat(() => triage(dirs.files, HEADLINE.files), errors);
      checkHops(r, HEADLINE.files);
      result.headline = {stats: r.stats, charged: r.last != null ? r.last.out.cost.charged : null};
      return result;
    }

    for (const n of FILE_COUNTS) {
      console.error(`  files=${n}`);
      const r = await repeat(() => triage(dirs.files, n), errors);
      checkHops(r, n);
      result.files.push({n: n, hops: 2 * n + 2, stats: r.stats, charged: r.last != null ? r.last.out.cost.charged : null,
                         resBytes: r.last != null ? r.last.resBytes : null});
    }

    for (const lines of LINE_COUNTS) {
      console.error(`  lines=${lines}`);
      const r = await repeat(() => triage(dirs.size[lines], SIZE_FILES), errors);
      checkHops(r, SIZE_FILES);
      result.size.push({lines: lines, hops: 2 * SIZE_FILES + 2, stats: r.stats});
    }

    console.error('  composite vs client-orchestrated');
    const composite = await repeat(() => triage(dirs.files, CLIENT_FILES), errors);
    const client    = await repeat(() => clientOrchestrated(url, orchestrator, dirs.files, CLIENT_FILES), errors);
    const bytes = (r) => (r.last != null ? {reqBytes: r.last.reqBytes, resBytes: r.last.resBytes} : {reqBytes: null, resBytes: null});
    result.client = {
      n: CLIENT_FILES,
      composite: Object.assign({stats: composite.stats, calls: 1}, bytes(composite)),
      client:    Object.assign({stats: client.stats, calls: client.last != null ? client.last.calls : null}, bytes(client))
    };
  } finally {
    await stopServer(server);
    currentServer = null;
  }
  return result;
}

function dirBytes(dir) {
  return fs.readdirSync(dir).reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
}

async function measureOnce() {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'log-triage-perf-'));
  const dirs = {root: tempRoot, files: path.join(tempRoot, 'files'), size: {}};

  gen.generate({dir: dirs.files, files: Math.max.apply(null, FILE_COUNTS), lines: 400, seed: 1});
  for (const lines of LINE_COUNTS) {
    dirs.size[lines] = path.join(tempRoot, `size-${lines}`);
    gen.generate({dir: dirs.size[lines], files: SIZE_FILES, lines: lines, seed: 1});
  }
  const sizeBytes = {};
  LINE_COUNTS.forEach((lines) => { sizeBytes[lines] = dirBytes(dirs.size[lines]); });

  // Baselines first, before any server competes for the CPU.
  const baselines = {files: {}, size: {}};
  const stages = [];
  const baseline = async (dir, n) => {
    for (let i = 0; i < WARMUP; i++) await inProcess(dir, n);
    const runs = [];
    for (let i = 0; i < REPS; i++) runs.push(await inProcess(dir, n));
    const stats = summarize(runs.map((r) => r.ms));
    const byTotal = runs.slice().sort((a, b) => a.ms - b.ms);
    return {stats: stats, typical: byTotal[Math.floor(byTotal.length / 2)]};
  };
  const fileCounts = MATRIX === 'headline' ? [HEADLINE.files] : FILE_COUNTS;
  for (const n of fileCounts) {
    const b = await baseline(dirs.files, n);
    baselines.files[n] = b.stats;
    stages.push({n: n, lines: 400, ms: b.typical.ms, stages: b.typical.stages});
  }
  if (MATRIX !== 'headline') {
    for (const lines of LINE_COUNTS) {
      const b = await baseline(dirs.size[lines], SIZE_FILES);
      baselines.size[lines] = b.stats;
      if (lines !== 400) stages.push({n: SIZE_FILES, lines: lines, ms: b.typical.ms, stages: b.typical.stages});
    }
  }

  const conditions = [];
  for (const sandbox of SANDBOX_MODES) {
    for (const p of PATHS) conditions.push(await runCondition(p, sandbox, dirs));
  }

  fs.rmSync(tempRoot, {recursive: true, force: true});
  tempRoot = null;
  return {reps: REPS, warmup: WARMUP, matrix: MATRIX, baselines: baselines, stages: stages, sizeBytes: sizeBytes, conditions: conditions};
}

// ------------------------------- reporting --------------------------------

const fmt = (n) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
const pct = (n) => `${(n * 100).toFixed(0)}%`;
const R   = (r, f) => (r == null ? 'n/a' : multiRun.fmtRange(r, f || fmt));

// One value per run, computed by fn(run), reported across runs.
function acrossRuns(runs, fn) {
  const values = runs.map(fn).filter((v) => v != null && !Number.isNaN(v));
  return values.length > 0 ? multiRun.across(values) : null;
}

function cond(run, label, sandbox) {
  return run.conditions.find((c) => c.label === label && c.sandbox === sandbox);
}

function med(stats) { return stats != null ? stats.median : null; }

function verdictLower(a, b) {
  const c = multiRun.compareLower(a, b);
  return c === -1 ? 'lower' : (c === 1 ? 'higher' : 'within noise');
}

// least-squares fit of y on x; returns r^2
function rSquared(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
}

function reportSandbox(runs, sandbox, say) {
  const labels = PATHS.map((p) => p.label);
  const first = cond(runs[0], labels[0], sandbox);
  say('');
  say(`## Module sandbox: ${first.sandboxMode}`);

  // errors and sandbox log, every path and run in this mode
  const tally = {};
  const sbLog = multiRun.newSandboxLog();
  const samples = [];
  runs.forEach((run) => labels.forEach((l) => {
    const c = cond(run, l, sandbox);
    multiRun.mergeTally(tally, c.errors.tally);
    c.errors.samples.forEach((s) => { if (samples.length < 3) samples.push(s); });
    ['violations', 'wouldRefuse', 'uses', 'restarts', 'suspended'].forEach((f) => { sbLog[f] += c.sandboxLog[f]; });
    c.sandboxLog.samples.forEach((s) => { if (sbLog.samples.length < 10 && sbLog.samples.indexOf(s) === -1) sbLog.samples.push(s); });
  }));
  say('');
  say(`${multiRun.errorLine(tally)} ${multiRun.sandboxLogLine(sbLog)}`);
  if (samples.length > 0) say(`Error samples: ${samples.join(' | ')}`);

  if (runs[0].matrix === 'headline') {
    say('');
    say(`### Headline: one composite call, ${HEADLINE.files} files of ${HEADLINE.lines} lines`);
    say('');
    say('| path | composite | in-process | charged per call |');
    say('|---|---|---|---|');
    const noise = [];
    labels.forEach((l) => {
      const r = acrossRuns(runs, (run) => med(cond(run, l, sandbox).headline.stats));
      noise.push({label: l, range: r});
      say(`| ${l} | ${R(r)} | ${R(acrossRuns(runs, (run) => med(run.baselines.files[HEADLINE.files])))} | ${
        cond(runs[0], l, sandbox).headline.charged} |`);
    });
    say('');
    say(multiRun.noiseFloorLine(noise, runs.length));
    return;
  }

  // per-run derived values for one path
  const files = (run, l, n) => med(cond(run, l, sandbox).files.find((f) => f.n === n).stats);
  const size  = (run, l, lines) => med(cond(run, l, sandbox).size.find((s) => s.lines === lines).stats);
  const baseF = (run, n) => med(run.baselines.files[n]);
  const baseS = (run, lines) => med(run.baselines.size[lines]);

  // 1. files
  say('');
  say(`### Latency against files read (400 lines per file)`);
  say('');
  say(`| files | hops | ${labels.join(' | ')} | in-process | runtime adds, ${labels.join(' | runtime adds, ')} |`);
  say(`|---|---|${labels.map(() => '---').join('|')}|---|${labels.map(() => '---').join('|')}|`);
  const filesNoise = [];
  FILE_COUNTS.forEach((n) => {
    const lat = labels.map((l) => acrossRuns(runs, (run) => files(run, l, n)));
    lat.forEach((r, i) => filesNoise.push({label: `${labels[i]} ${n} file${n === 1 ? '' : 's'}`, range: r}));
    const base = acrossRuns(runs, (run) => baseF(run, n));
    filesNoise.push({label: `in-process ${n} file${n === 1 ? '' : 's'}`, range: base});
    const added = labels.map((l) => acrossRuns(runs, (run) => files(run, l, n) - baseF(run, n)));
    say(`| ${n} | ${2 * n + 2} | ${lat.map((r) => R(r)).join(' | ')} | ${R(base)} | ${added.map((r) => R(r)).join(' | ')} |`);
  });
  say('');
  say(multiRun.noiseFloorLine(filesNoise, runs.length));
  say('');
  const nMin = FILE_COUNTS[0], nMax = FILE_COUNTS[FILE_COUNTS.length - 1];
  labels.forEach((l) => {
    const lo = acrossRuns(runs, (run) => files(run, l, nMin));
    const hi = acrossRuns(runs, (run) => files(run, l, nMax));
    const slope = acrossRuns(runs, (run) => (files(run, l, nMax) - files(run, l, nMin)) / (nMax - nMin));
    const r2 = acrossRuns(runs, (run) => rSquared(FILE_COUNTS, FILE_COUNTS.map((n) => files(run, l, n))));
    say(`**Per file, ${l}**: from ${nMin} file to ${nMax}, the composite goes from ${R(lo)} ms to ${R(hi)} ms, ${R(slope)} ms for each further file ` +
      `((${nMax}-file median - ${nMin}-file median) / ${nMax - nMin}, per run). A least-squares line through all ${FILE_COUNTS.length} file counts fits with r² ${
      R(r2, (v) => v.toFixed(3))}.`);
    say('');
  });
  const charged = FILE_COUNTS.map((n) => cond(runs[0], labels[0], sandbox).files.find((f) => f.n === n).charged);
  say(`**Bill**: charged per composite call at ${FILE_COUNTS.join(', ')} files: ${charged.join(', ')} (each further file adds ${
    (charged[charged.length - 1] - charged[0]) / (nMax - nMin)}).`);
  say('');
  const small = FILE_COUNTS.filter((n) => n <= 4);
  labels.forEach((l) => {
    const parts = small.map((n) => `${R(acrossRuns(runs, (run) => files(run, l, n) - baseF(run, n)))} ms at ${n} file${n === 1 ? '' : 's'}`);
    const lo = acrossRuns(runs, (run) => Math.min.apply(null, small.map((n) => files(run, l, n) - baseF(run, n))));
    const hi = acrossRuns(runs, (run) => Math.max.apply(null, small.map((n) => files(run, l, n) - baseF(run, n))));
    say(`**Fixed part, ${l}**: the runtime adds ${parts.join(', ')} (hops ${small.map((n) => 2 * n + 2).join(', ')}); per run, the smallest of these is ${
      R(lo)} ms and the largest ${R(hi)} ms.`);
    say('');
  });
  labels.forEach((l) => {
    const perHop = acrossRuns(runs, (run) => (files(run, l, nMax) - baseF(run, nMax)) / (2 * nMax + 2));
    const added = acrossRuns(runs, (run) => files(run, l, nMax) - baseF(run, nMax));
    say(`**Per hop at 400 lines, ${l}**: at ${nMax} files the runtime adds ${R(added)} ms over ${2 * nMax + 2} hops, ${R(perHop)} ms per hop.`);
    say('');
  });

  // 2. size
  say(`### Latency against file size (${SIZE_FILES} files, ${2 * SIZE_FILES + 2} hops)`);
  say('');
  say(`| lines per file | logs in total | ${labels.join(' | ')} | in-process | runtime adds, ${labels.join(' | runtime adds, ')} | runtime's share, ${labels.join(' | runtime\'s share, ')} |`);
  say(`|---|---|${labels.map(() => '---').join('|')}|---|${labels.map(() => '---').join('|')}|${labels.map(() => '---').join('|')}|`);
  const sizeNoise = [];
  LINE_COUNTS.forEach((lines) => {
    const lat = labels.map((l) => acrossRuns(runs, (run) => size(run, l, lines)));
    lat.forEach((r, i) => sizeNoise.push({label: `${labels[i]} ${lines} lines`, range: r}));
    const base = acrossRuns(runs, (run) => baseS(run, lines));
    sizeNoise.push({label: `in-process ${lines} lines`, range: base});
    const added = labels.map((l) => acrossRuns(runs, (run) => size(run, l, lines) - baseS(run, lines)));
    const share = labels.map((l) => acrossRuns(runs, (run) => (size(run, l, lines) - baseS(run, lines)) / size(run, l, lines)));
    say(`| ${lines} | ${(runs[0].sizeBytes[lines] / 1048576).toFixed(2)} MB | ${lat.map((r) => R(r)).join(' | ')} | ${R(base)} | ${
      added.map((r) => R(r)).join(' | ')} | ${share.map((r) => R(r, pct)).join(' | ')} |`);
  });
  say('');
  say(multiRun.noiseFloorLine(sizeNoise, runs.length));
  say('');
  labels.forEach((l) => {
    const parts = LINE_COUNTS.map((lines) => `${R(acrossRuns(runs, (run) => (size(run, l, lines) - baseS(run, lines)) / size(run, l, lines)), pct)} at ${lines} lines`);
    const work = LINE_COUNTS.map((lines) => `${R(acrossRuns(runs, (run) => baseS(run, lines) / size(run, l, lines)), pct)}`);
    say(`**Runtime's share of the call, ${l}**: ${parts.join(', ')}; the handlers' own work is ${work.join(', ')} respectively.`);
    say('');
    const perHop = LINE_COUNTS.map((lines) => `${R(acrossRuns(runs, (run) => (size(run, l, lines) - baseS(run, lines)) / (2 * SIZE_FILES + 2)))} ms at ${lines}`);
    say(`**Per hop by file size, ${l}**: the runtime adds ${perHop.join(', ')} lines per file.`);
    say('');
  });
  const b8F = acrossRuns(runs, (run) => baseF(run, SIZE_FILES));
  const b8S = acrossRuns(runs, (run) => baseS(run, 400));
  say(`**Same baseline, measured twice per run**: the in-process baseline for ${SIZE_FILES} files of 400 lines is ${R(b8F)} ms in the files sweep and ${
    R(b8S)} ms in the size sweep; within each run the two differ by ${R(acrossRuns(runs, (run) => Math.abs(baseF(run, SIZE_FILES) - baseS(run, 400)) /
    Math.min(baseF(run, SIZE_FILES), baseS(run, 400))), pct)}.`);
  say('');

  // 3. direct vs routed
  if (labels.length === 2) {
    say('### Direct against routed');
    say('');
    say('| case | direct | routed | direct is lower by | verdict |');
    say('|---|---|---|---|---|');
    const cases = FILE_COUNTS.map((n) => ({label: `${n} file${n === 1 ? '' : 's'}, 400 lines`, get: (run, l) => files(run, l, n)}))
      .concat(LINE_COUNTS.filter((x) => x !== 400).map((lines) => ({label: `${SIZE_FILES} files, ${lines} lines`, get: (run, l) => size(run, l, lines)})))
      .concat([{label: `${SIZE_FILES} files, 400 lines (size sweep)`, get: (run, l) => size(run, l, 400)}]);
    const lower = [], higher = [], noisy = [];
    cases.forEach((c) => {
      const d = acrossRuns(runs, (run) => c.get(run, labels[0]));
      const m = acrossRuns(runs, (run) => c.get(run, labels[1]));
      const by = 1 - d.median / m.median;
      const v = verdictLower(d, m);
      (v === 'lower' ? lower : v === 'higher' ? higher : noisy).push({label: c.label, by: by});
      say(`| ${c.label} | ${R(d)} | ${R(m)} | ${pct(by)} | ${v === 'lower' ? 'direct lower' : v === 'higher' ? 'routed lower' : 'within noise'} |`);
    });
    say('');
    const span = (arr) => (arr.length === 0 ? '' : ` by ${pct(Math.min.apply(null, arr.map((x) => x.by)))} to ${pct(Math.max.apply(null, arr.map((x) => x.by)))} of the routed median`);
    say(`**Direct against routed**: the direct path is lower in ${lower.length} of ${cases.length} cases${span(lower)}${
      lower.length > 0 ? ` (${lower.map((x) => x.label).join('; ')})` : ''}; routed is lower in ${higher.length}${
      higher.length > 0 ? ` (${higher.map((x) => `${x.label}, ${pct(-x.by)}`).join('; ')})` : ''}; ${noisy.length} are within noise${
      noisy.length > 0 ? ` (${noisy.map((x) => x.label).join('; ')})` : ''}.`);
    say('');
  }

  // 4. composite vs client
  say(`### One composite call against the same hops made by the client (${CLIENT_FILES} files of 400 lines)`);
  say('');
  say(`| | tool calls | ${labels.map((l) => `latency, ${l} server`).join(' | ')} | bytes sent | bytes received |`);
  say(`|---|---|${labels.map(() => '---').join('|')}|---|---|`);
  const clientNoise = [];
  const bytesOf = {};
  ['composite', 'client'].forEach((key) => {
    const lat = labels.map((l) => acrossRuns(runs, (run) => med(cond(run, l, sandbox).client[key].stats)));
    lat.forEach((r, i) => clientNoise.push({label: `${key} ${labels[i]}`, range: r}));
    const c0 = cond(runs[0], labels[0], sandbox).client[key];
    // bytes are deterministic; any run or path that disagrees is reported
    const all = [];
    runs.forEach((run) => labels.forEach((l) => { const c = cond(run, l, sandbox).client[key]; all.push(`${c.reqBytes}/${c.resBytes}`); }));
    bytesOf[key] = {req: c0.reqBytes, res: c0.resBytes, consistent: new Set(all).size === 1};
    say(`| ${key === 'composite' ? 'composite' : 'client-orchestrated'} | ${c0.calls} | ${lat.map((r) => R(r)).join(' | ')} | ${c0.reqBytes} | ${c0.resBytes} |`);
  });
  say('');
  say(multiRun.noiseFloorLine(clientNoise, runs.length));
  say('');
  labels.forEach((l) => {
    const comp = acrossRuns(runs, (run) => med(cond(run, l, sandbox).client.composite.stats));
    const cli  = acrossRuns(runs, (run) => med(cond(run, l, sandbox).client.client.stats));
    const ratio = acrossRuns(runs, (run) => med(cond(run, l, sandbox).client.client.stats) / med(cond(run, l, sandbox).client.composite.stats));
    const v = verdictLower(comp, cli);
    say(`**Composite against client, ${l} server**: one composite call takes ${R(comp)} ms against ${R(cli)} ms for the ${
      CLIENT_FILES * 2 + 2} client calls, ${v === 'lower' ? 'lower' : v === 'higher' ? 'higher' : 'within noise'}; the client takes ${R(ratio, (x) => `${x.toFixed(2)}×`)} as long, per run.`);
    say('');
  });
  const compTotal = bytesOf.composite.req + bytesOf.composite.res;
  const cliTotal  = bytesOf.client.req + bytesOf.client.res;
  say(`**Bytes on the wire**: the composite moves ${compTotal} bytes (${(compTotal / 1000).toFixed(1)} KB) and the client-orchestrated version ${cliTotal} bytes (${
    (cliTotal / 1e6).toFixed(2)} MB), ${(cliTotal / compTotal).toFixed(0)} times as much. ${
    bytesOf.composite.consistent && bytesOf.client.consistent ? 'Identical in every run and on both paths.' : 'NOTE: byte counts differed between runs or paths.'}`);
  say('');
}

function reportStages(runs, say) {
  say('## Where the work itself goes (in-process, no runtime)');
  say('');
  say('Each cell is the median run of that case, then the median across runs.');
  say('');
  say('| files | lines per file | total | list | read | redact | cluster |');
  say('|---|---|---|---|---|---|---|');
  const keys = runs[0].stages.map((s) => `${s.n}:${s.lines}`);
  const shares = {read: [], redact: [], cluster: []};
  keys.forEach((k, i) => {
    const pick = (fn) => acrossRuns(runs, (run) => fn(run.stages.find((s) => `${s.n}:${s.lines}` === k)));
    const row = runs[0].stages[i];
    say(`| ${row.n} | ${row.lines} | ${R(pick((s) => s.ms))} | ${['list', 'read', 'redact', 'cluster'].map((st) => R(pick((s) => s.stages[st]))).join(' | ')} |`);
    if (row.n >= 8) {
      ['read', 'redact', 'cluster'].forEach((st) => {
        shares[st].push(multiRun.median(runs.map((run) => {
          const s = run.stages.find((x) => `${x.n}:${x.lines}` === k);
          return s.stages[st] / (s.stages.list + s.stages.read + s.stages.redact + s.stages.cluster);
        })));
      });
    }
  });
  say('');
  if (shares.redact.length > 0) {
    const span = (arr) => `${pct(Math.min.apply(null, arr))} to ${pct(Math.max.apply(null, arr))}`;
    say(`**Stage shares** (of the four stages' sum, cases with 8 or more files, median across runs): redact ${span(shares.redact)}, cluster ${
      span(shares.cluster)}, read ${span(shares.read)}.`);
    say('');
  }
}

// Each later sandbox mode's composite latency against the first mode's.
function reportSandboxComparison(runs, say) {
  const base = SANDBOX_MODES[0];
  say('## Sandbox modes compared');
  say('');
  PATHS.forEach((p) => {
    const get = runs[0].matrix === 'headline'
      ? (run, mode) => med(cond(run, p.label, mode).headline.stats)
      : (run, mode) => med(cond(run, p.label, mode).client.composite.stats);
    const b = acrossRuns(runs, (run) => get(run, base));
    SANDBOX_MODES.slice(1).forEach((mode) => {
      const m = acrossRuns(runs, (run) => get(run, mode));
      const slower = m.median / b.median - 1;
      const v = verdictLower(m, b);
      const verdict = v === 'within noise' ? 'within noise' : (v === 'higher' ? 'slower' : 'faster');
      say(`**${p.label}, ${mode} against ${base}** (composite, ${HEADLINE.files} files of ${HEADLINE.lines} lines): ${R(m)} ms against ${R(b)} ms, ${
        slower >= 0 ? '+' : ''}${pct(slower)} (${verdict}). More than 10% slower with non-overlapping ranges: ${verdict === 'slower' && slower > 0.10 ? 'yes' : 'no'}.`);
      say('');
    });
  });
}

function report(runs) {
  const lines = [];
  const say = (s) => lines.push(s);
  const c0 = runs[0].conditions[0];
  say(multiRun.envHeader(serverArgs(0, '', ALL_PATHS.find((p) => p.label === c0.label).flags.concat(sandboxFlags(c0.sandbox))), runs.length));
  say(`Repetitions: ${runs[0].reps} per cell after ${runs[0].warmup} warm-up calls, per run. Times in ms: median across runs of each run's median, [min–max] of those medians.`);
  say(`Matrix: ${runs[0].matrix}. Servers: --workerThread, non-debug, --mcpToolCallCost 1.`);

  SANDBOX_MODES.forEach((sandbox) => reportSandbox(runs, sandbox, say));
  say('');
  if (runs[0].matrix !== 'headline') reportStages(runs, say);
  if (SANDBOX_MODES.length > 1) reportSandboxComparison(runs, say);
  return lines.join('\n');
}

multiRun.main({measure: measureOnce, report: report}).then(() => cleanupAndExit(0)).catch((e) => {
  console.error(`\nFAILED: ${e.stack || e.message}`);
  cleanupAndExit(1);
});
