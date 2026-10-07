// Benchmark for examples/log-triage: how the composite's latency follows its
// input, what the runtime adds on top of the work itself, and what the same
// hops cost when a client orchestrates them instead. docs/log-triage-performance.md
// carries a run of this script and how to read it.
//
//   node perf/log-triage-perf.js [--reps <n>] [--json <file>]
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
// The servers are non-debug with metering on (--mcpToolCallCost 1), so every
// hop pays its Redis round trip as it would in a deployment. Each server gets
// its own temporary auth file and keys; nothing is left in examples/.
//
// Latency is measured at the client around one tools/call, in milliseconds.
// With REPS in the tens the table reports median, min and max rather than a
// p95 that so few samples could not support.
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const spawn = require('child_process').spawn;

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

const PATHS = [
  {label: 'direct',             port: 9602, flags: []},
  {label: 'main-thread-routed', port: 9603, flags: ['--no-directPeerChannels']}
];

const FILE_COUNTS = [1, 2, 4, 8, 16, 32];
const LINE_COUNTS = [100, 400, 1600, 6400];
const SIZE_FILES  = 8;
const CLIENT_FILES = 8;
const WARMUP      = 5;

function argValue(name, fallback) {
  const at = process.argv.indexOf(name);
  return (at !== -1 && process.argv[at + 1] != null) ? process.argv[at + 1] : fallback;
}
const REPS      = Number(argValue('--reps', 15));
const JSON_PATH = argValue('--json', null);

let currentServer = null;
let tempRoot      = null;

function cleanupAndExit(code) {
  if (currentServer != null) { try { currentServer.kill('SIGKILL'); } catch (e) { /* gone */ } }
  if (tempRoot != null) { try { fs.rmSync(tempRoot, {recursive: true, force: true}); } catch (e) { /* gone */ } }
  process.exit(code);
}
process.on('SIGINT',  () => cleanupAndExit(130));
process.on('SIGTERM', () => cleanupAndExit(130));

function startServer(port, authPath, flags) {
  return new Promise((resolve, reject) => {
    const args = [path.join(ROOT, 'framework.js'),
      '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(port),
      '--authProvider', 'file', '--authConfigPath', authPath, '--mcpToolCallCost', '1',
      '--loadModule', path.join(EXAMPLE, 'log-read'),
      '--loadModule', path.join(EXAMPLE, 'pii-redact'),
      '--loadModule', path.join(EXAMPLE, 'error-cluster'),
      '--loadModule', path.join(EXAMPLE, 'log-triage')].concat(flags);

    const server = spawn(process.execPath, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    currentServer = server;

    let out = '';
    let settled = false;
    const settle = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };

    const timer = setTimeout(() => {
      server.kill('SIGKILL');
      settle(reject, new Error(`server on ${port} was never ready:\n${out.slice(-2000)}`));
    }, 90000);

    server.on('exit', (code, signal) => {
      settle(reject, new Error(`server on ${port} exited before it was ready (code=${code} signal=${signal}):\n${out.slice(-2000)}`));
    });

    const onData = (buf) => {
      if (settled) return;       // keep the pipe drained, stop accumulating
      out += buf.toString();
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
// bytes sent and received.
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

  const parsed = JSON.parse(text);
  if (parsed.result == null || parsed.result.isError !== false) {
    throw new Error(`${tool} failed: ${text.slice(0, 600)}`);
  }
  return {
    out:      parsed.result.structuredContent.output,
    ms:       ms,
    reqBytes: Buffer.byteLength(body),
    resBytes: Buffer.byteLength(text)
  };
}

function summarize(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  const median = (sorted.length % 2 === 1) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {median: median, min: sorted[0], max: sorted[sorted.length - 1], n: sorted.length};
}

async function repeat(fn) {
  for (let i = 0; i < WARMUP; i++) await fn();
  const samples = [];
  let last = null;
  for (let i = 0; i < REPS; i++) {
    last = await fn();
    samples.push(last.ms);
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
    ms += r.ms; reqBytes += r.reqBytes; resBytes += r.resBytes; calls++;
    return r.out;
  };

  const listed = await step(TOOLS.list, {dir: dir});
  let lines = [];
  for (const file of listed.files.slice(0, maxFiles)) {
    const raw      = await step(TOOLS.read, {dir: dir, name: file.name});
    const redacted = await step(TOOLS.redact, {lines: raw.lines});
    lines = lines.concat(redacted.lines);
  }
  await step(TOOLS.cluster, {lines: lines});

  return {ms: ms, reqBytes: reqBytes, resBytes: resBytes, calls: calls};
}

const fmt = (n) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));

async function runPath(p, dirs, baselines) {
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

  const server = await startServer(p.port, authPath, p.flags);
  const result = {label: p.label, files: [], size: [], client: null};

  try {
    for (const n of FILE_COUNTS) {
      const r = await repeat(() => call(url, caller, TOOLS.triage, {dir: dirs.files, maxFiles: n}));
      if (r.last.out.cost.hops !== 2 * n + 2) throw new Error(`expected ${2 * n + 2} hops at N=${n}, got ${r.last.out.cost.hops}`);
      result.files.push({n: n, hops: r.last.out.cost.hops, stats: r.stats, resBytes: r.last.resBytes,
                         baseline: baselines.files[n]});
    }

    for (const lines of LINE_COUNTS) {
      const r = await repeat(() => call(url, caller, TOOLS.triage, {dir: dirs.size[lines], maxFiles: SIZE_FILES}));
      result.size.push({lines: lines, hops: r.last.out.cost.hops, stats: r.stats, baseline: baselines.size[lines]});
    }

    const composite = await repeat(() => call(url, caller, TOOLS.triage, {dir: dirs.files, maxFiles: CLIENT_FILES}));
    const client    = await repeat(() => clientOrchestrated(url, orchestrator, dirs.files, CLIENT_FILES));
    result.client = {
      n: CLIENT_FILES,
      composite: {stats: composite.stats, reqBytes: composite.last.reqBytes, resBytes: composite.last.resBytes, calls: 1},
      client:    {stats: client.stats, reqBytes: client.last.reqBytes, resBytes: client.last.resBytes, calls: client.last.calls}
    };
  } finally {
    await stopServer(server);
    currentServer = null;
  }
  return result;
}

function report(results, env) {
  const lines = [];
  const say = (s) => lines.push(s);

  say(`Machine: ${env.cpus} x ${env.cpuModel}, ${env.memGb} GB, Node ${env.node}, ${env.platform}`);
  say(`Repetitions: ${REPS} per cell after ${WARMUP} warm-up calls. Times in ms: median (min-max).`);

  for (const r of results) {
    say('');
    say(`## ${r.label}`);
    say('');
    say('### Latency against files read (400 lines per file)');
    say('');
    say('| files | hops | composite | in-process | runtime adds | per hop |');
    say('|---|---|---|---|---|---|');
    for (const row of r.files) {
      const added = row.stats.median - row.baseline.median;
      say(`| ${row.n} | ${row.hops} | ${fmt(row.stats.median)} (${fmt(row.stats.min)}-${fmt(row.stats.max)}) | ${
        fmt(row.baseline.median)} | ${fmt(added)} | ${fmt(added / row.hops)} |`);
    }
    say('');
    say(`### Latency against file size (${SIZE_FILES} files, ${2 * SIZE_FILES + 2} hops)`);
    say('');
    say('| lines per file | composite | in-process | runtime adds | per hop |');
    say('|---|---|---|---|---|');
    for (const row of r.size) {
      const added = row.stats.median - row.baseline.median;
      say(`| ${row.lines} | ${fmt(row.stats.median)} (${fmt(row.stats.min)}-${fmt(row.stats.max)}) | ${
        fmt(row.baseline.median)} | ${fmt(added)} | ${fmt(added / row.hops)} |`);
    }
    say('');
    say(`### One composite call against the same hops made by the client (${r.client.n} files)`);
    say('');
    say('| | tool calls | latency | bytes sent | bytes received |');
    say('|---|---|---|---|---|');
    for (const key of ['composite', 'client']) {
      const c = r.client[key];
      say(`| ${key === 'composite' ? 'composite' : 'client-orchestrated'} | ${c.calls} | ${fmt(c.stats.median)} (${
        fmt(c.stats.min)}-${fmt(c.stats.max)}) | ${c.reqBytes} | ${c.resBytes} |`);
    }
  }

  say('');
  say('## Where the work itself goes (in-process, no runtime)');
  say('');
  say('| files | lines per file | total | list | read | redact | cluster |');
  say('|---|---|---|---|---|---|---|');
  for (const row of env.stages) {
    say(`| ${row.n} | ${row.lines} | ${fmt(row.ms)} | ${fmt(row.stages.list)} | ${fmt(row.stages.read)} | ${
      fmt(row.stages.redact)} | ${fmt(row.stages.cluster)} |`);
  }
  return lines.join('\n');
}

async function main() {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'log-triage-perf-'));
  const dirs = {root: tempRoot, files: path.join(tempRoot, 'files'), size: {}};

  gen.generate({dir: dirs.files, files: Math.max.apply(null, FILE_COUNTS), lines: 400, seed: 1});
  for (const lines of LINE_COUNTS) {
    dirs.size[lines] = path.join(tempRoot, `size-${lines}`);
    gen.generate({dir: dirs.size[lines], files: SIZE_FILES, lines: lines, seed: 1});
  }

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
  for (const n of FILE_COUNTS) {
    const b = await baseline(dirs.files, n);
    baselines.files[n] = b.stats;
    stages.push({n: n, lines: 400, ms: b.typical.ms, stages: b.typical.stages});
  }
  for (const lines of LINE_COUNTS) {
    const b = await baseline(dirs.size[lines], SIZE_FILES);
    baselines.size[lines] = b.stats;
    if (lines !== 400) stages.push({n: SIZE_FILES, lines: lines, ms: b.typical.ms, stages: b.typical.stages});
  }

  const results = [];
  for (const p of PATHS) results.push(await runPath(p, dirs, baselines));

  const cpus = os.cpus();
  const env = {
    cpus: cpus.length, cpuModel: cpus[0].model.trim(), memGb: (os.totalmem() / 1073741824).toFixed(1),
    node: process.version, platform: `${os.platform()} ${os.release()}`, stages: stages
  };

  console.log(report(results, env));
  if (JSON_PATH != null) {
    fs.writeFileSync(JSON_PATH, JSON.stringify({env: env, reps: REPS, warmup: WARMUP, results: results}, null, 2));
  }
}

main().then(() => cleanupAndExit(0)).catch((e) => {
  console.error(`\nFAILED: ${e.stack || e.message}`);
  cleanupAndExit(1);
});
