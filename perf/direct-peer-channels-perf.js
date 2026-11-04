// Cross-worker call benchmark: main-thread-routed (--no-directPeerChannels)
// vs direct peer channel (the default since 7.1.0). See
// docs/direct-peer-channels-design.md section 4 and docs/direct-peer-channels.md
// for the results this produces and how to read them.
//
// Drives HTTP load against pre-installed-packages/perf-caller-demo's `run`
// action, which round-trips a payload of the requested size through
// perf-callee-demo via ServiceClient.invoke -- the exact isRemoteThread
// path lib/service-client.js branches on the flag for. Each response
// includes `durationMs`, measured server-side around just the
// ServiceClient.invoke call (excludes this script's own HTTP/network
// overhead, and this action's own session/routing overhead on either
// side of that call) -- that is the number this script reports as
// "hop latency". Throughput is measured client-side (wall-clock time for
// N requests at a given concurrency), which *does* include full HTTP
// overhead, but that overhead is identical in both conditions, so it
// doesn't distort the relative comparison between them.
//
// This script computes its own comparison summary from whatever numbers it
// actually measured -- a hand-written summary sentence in
// docs/direct-peer-channels.md can silently drift from the table next to
// it (this happened once already: "1.3-7x" and "7 of 9" were both wrong
// against the table they described, found and fixed after the fact). The
// rule going forward: docs/direct-peer-channels.md's prose may only
// quote numbers this script printed, copy-pasted from a real run --
// nothing hand-computed or hand-remembered.
//
// Usage: node perf/direct-peer-channels-perf.js [options]
//
//   --runs <n>              n independent runs, each in a fresh process with
//                           fresh servers; cells report the median across
//                           runs and the [min-max] range (perf/multi-run.js).
//                           A comparison only counts as faster or slower when
//                           the two ranges do not overlap.
//   --moduleSandbox <mode>  passed to every server (default: the server's own)
//   --sandboxModes <list>   measure each of these modes, e.g. off,audit,enforce,
//                           and compare each against the first
//   --paths <list>          direct, routed, or both (default both)
//   --cells <list>          payload:concurrency pairs, e.g. 1048576:64
//   --mcpToolCallCost <n>   passed to every server (default: not passed)
//   --directPeerChannelsMaxConcurrency <n>
//                           passed to every server (default: not passed)
//   --json <file>           write every run's raw results
//
// Starts and stops its own server for each condition; takes several
// minutes per run for the full 2 x 3 x 3 matrix (conditions x payload sizes
// x concurrency levels). Prints markdown tables and a plain-language summary
// to stdout, ready to paste into docs/direct-peer-channels.md.

const cp = require('child_process');
const path = require('path');
const multiRun = require('./multi-run');

const PORT = 18500;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CALLER_DEVICE_ID = '13793b1a-132d-5a03-a46b-2e0bb72d0d82'; // perf-caller-demo, computed offline via UUID.v5

const ALL_PAYLOAD_SIZES = [1024, 102400, 1048576]; // 1KB, 100KB, 1MB
const ALL_CONCURRENCY_LEVELS = [1, 16, 64];
const REQUESTS_PER_COMBINATION = 150;

const PATH_LABELS = {routed: 'Main-thread-routed', direct: 'Direct peer channel'};

function listArg(name, fallback) {
  const v = multiRun.argValue(name, null);
  return v != null ? v.split(',').map((s) => s.trim()).filter((s) => s !== '') : fallback;
}

const PATHS = (() => {
  const p = multiRun.argValue('--paths', 'both');
  return p === 'both' ? ['routed', 'direct'] : listArg('--paths', []);
})();
const SANDBOX_MODES = listArg('--sandboxModes', [null]); // null: --moduleSandbox, or the server default
const CELLS = (() => {
  const all = [];
  ALL_PAYLOAD_SIZES.forEach((p) => ALL_CONCURRENCY_LEVELS.forEach((c) => all.push({key: `${p}:${c}`, payload: p, concurrency: c})));
  const only = listArg('--cells', null);
  return only == null ? all : all.filter((k) => only.indexOf(k.key) !== -1);
})();

function extraServerArgs() {
  const out = [];
  ['--mcpToolCallCost', '--directPeerChannelsMaxConcurrency'].forEach((flag) => {
    const v = multiRun.argValue(flag, null);
    if (v != null) out.push(flag, v);
  });
  return out;
}

function serverArgs(pathName, sandbox) {
  const args = [
    './framework.js',
    '--workerThread', '--debug',
    '--bindAddr', '127.0.0.1',
    '--port', String(PORT),
    '--loadModule', './pre-installed-packages/perf-callee-demo',
    '--loadModule', './pre-installed-packages/perf-caller-demo'
  ];
  args.push(pathName === 'direct' ? '--directPeerChannels' : '--no-directPeerChannels');
  const sb = sandbox != null ? ['--moduleSandbox', sandbox] : multiRun.sandboxArgs();
  return args.concat(sb, extraServerArgs());
}

function conditionKey(pathName, sandbox) {
  return `${pathName}|${sandbox != null ? sandbox : 'default'}`;
}

function conditionLabel(pathName, sandbox) {
  return SANDBOX_MODES.length > 1 ? `${PATH_LABELS[pathName]}, sandbox ${sandbox}` : PATH_LABELS[pathName];
}

// Waits for the server's ready line rather than a fixed delay, and keeps
// reading its log afterwards to count sandbox lines.
function startServer(args, sandboxLog) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn('node', args, {cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    let ready = false;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
      reject(new Error(`server was never ready:\n${out.slice(-2000)}`));
    }, 90000);
    const onData = (buf) => {
      const text = buf.toString();
      child.logText = (child.logText || '') + text;
      if (!ready) {
        out += text;
        if (/countinghouse ready/.test(out)) { ready = true; clearTimeout(timer); resolve(child); }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!ready) { clearTimeout(timer); reject(new Error(`server exited before it was ready (code=${code}):\n${out.slice(-2000)}`)); }
      multiRun.scanSandboxLog(child.logText || '', sandboxLog);
    });
  });
}

function stopServer(child) {
  return fetch(`${BASE_URL}/shutdown`, {method: 'POST'}).catch(() => {}).then(() => {
    return new Promise((resolve) => {
      if (child.exitCode != null) return resolve();
      child.on('exit', resolve);
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve(); }, 3000);
    });
  });
}

function invoke(payloadSizeBytes) {
  const t0 = Date.now();
  return fetch(`${BASE_URL}/devices/${CALLER_DEVICE_ID}/invoke-action`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-CH-Key': 'perf'},
    body: JSON.stringify({
      serviceID: 'urn:countinghouse-com:serviceID:perfCallerService',
      actionName: 'run',
      input: {payloadSizeBytes: payloadSizeBytes}
    })
  }).then((res) => { return res.text(); }).then((text) => {
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
    const ok = body != null && body.output != null;
    return {wallMs: Date.now() - t0, hopMs: ok ? body.output.durationMs : null, error: ok ? null : text};
  });
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length));
  return sorted[idx];
}

// runs `total` requests at the given concurrency (a fixed-size pool of
// in-flight requests, each starting a new one as soon as one completes --
// not `total` requests fired in lockstep batches).
function runLoad(payloadSizeBytes, concurrency, total) {
  return new Promise((resolve, reject) => {
    const results = [];
    const errors = {};
    const errorSamples = [];
    let started = 0;
    let completed = 0;
    const wallStart = Date.now();

    function next() {
      if (started >= total) return;
      started++;
      invoke(payloadSizeBytes).then((r) => {
        if (r.error != null) {
          const code = multiRun.classifyError(r.error);
          errors[code] = (errors[code] || 0) + 1;
          if (errorSamples.length < 3) errorSamples.push(r.error.slice(0, 300));
        }
        results.push(r);
        completed++;
        if (completed >= total) {
          const totalWallMs = Date.now() - wallStart;
          const hopLatencies = results.filter((r) => { return r.hopMs != null; }).map((r) => { return r.hopMs; }).sort((a, b) => { return a - b; });
          return resolve({
            errors: errors,
            errorSamples: errorSamples,
            throughputRps: (total / totalWallMs) * 1000,
            hopP50: hopLatencies.length > 0 ? percentile(hopLatencies, 50) : null,
            hopP99: hopLatencies.length > 0 ? percentile(hopLatencies, 99) : null,
            hopMean: hopLatencies.length > 0 ? hopLatencies.reduce((a, b) => { return a + b; }, 0) / hopLatencies.length : null
          });
        }
        next();
      }).catch(reject);
    }

    for (let i = 0; i < Math.min(concurrency, total); i++) next();
  });
}

async function benchmarkCondition(pathName, sandbox) {
  const args = serverArgs(pathName, sandbox);
  console.error(`\n=== ${conditionLabel(pathName, sandbox)} (sandbox ${multiRun.sandboxMode(args)}) ===`);
  const sandboxLog = multiRun.newSandboxLog();
  const child = await startServer(args, sandboxLog);

  const cells = {};
  try {
    // warm up the channel (and, for the flag-off case, the worker pair in
    // general) with a couple of throwaway calls before measuring -- the
    // matrix below is about steady-state behavior, not cold-start cost
    // (D1's brokering cost on the very first call is a separate, one-time
    // thing, not what this table is measuring).
    await invoke(1024);
    await invoke(1024);

    for (const k of CELLS) {
      console.error(`  payload=${k.payload}B concurrency=${k.concurrency} ...`);
      const r = await runLoad(k.payload, k.concurrency, REQUESTS_PER_COMBINATION);
      cells[k.key] = r;
      const errCount = Object.keys(r.errors).reduce((a, c) => a + r.errors[c], 0);
      console.error(`    throughput=${r.throughputRps.toFixed(1)} req/s, hop p50=${r.hopP50 != null ? r.hopP50.toFixed(2) : 'n/a'}ms p99=${
        r.hopP99 != null ? r.hopP99.toFixed(2) : 'n/a'}ms, errors=${errCount}`);
    }
  } finally {
    await stopServer(child);
  }
  return {path: pathName, sandbox: sandbox, sandboxMode: multiRun.sandboxMode(args), cells: cells, sandboxLog: sandboxLog};
}

async function measureOnce() {
  const conditions = {};
  for (const sandbox of SANDBOX_MODES) {
    for (const p of PATHS) conditions[conditionKey(p, sandbox)] = await benchmarkCondition(p, sandbox);
  }
  return {conditions: conditions};
}

function formatPayload(bytes) {
  if (bytes >= 1048576) return `${bytes / 1048576}MB`;
  if (bytes >= 1024) return `${bytes / 1024}KB`;
  return `${bytes}B`;
}

function cellLabel(k) {
  return `${formatPayload(k.payload)}/c=${k.concurrency}`;
}

// metric across runs for one condition and cell
function rangeOf(runs, condKey, cellKey, metric) {
  const values = runs.map((r) => r.conditions[condKey].cells[cellKey][metric]).filter((v) => v != null);
  return values.length > 0 ? multiRun.across(values) : null;
}

// range formatters (perf/multi-run.js): three significant figures, the unit once
const ms  = (r) => multiRun.fmtRangeMs(r);
const rps = (r) => multiRun.fmtRangeInt(r);

// Per cell: is a better than b, worse, or within noise (ranges overlap)?
// lowerIsBetter: true for latency, false for throughput. Ratios are of the
// medians, oriented so that > 1 means a is better.
function compareCells(runs, aKey, bKey, metric, lowerIsBetter) {
  const better = [], worse = [], noise = [];
  const ratios = [];
  CELLS.forEach((k) => {
    const a = rangeOf(runs, aKey, k.key, metric);
    const b = rangeOf(runs, bKey, k.key, metric);
    if (a == null || b == null) return;
    const c = multiRun.compareLower(a, b); // -1: a lower
    const aBetter = lowerIsBetter ? c === -1 : c === 1;
    const aWorse  = lowerIsBetter ? c === 1 : c === -1;
    const entry = {label: cellLabel(k), a: a, b: b};
    if (aBetter) better.push(entry); else if (aWorse) worse.push(entry); else noise.push(entry);
    ratios.push({label: cellLabel(k), v: lowerIsBetter ? b.median / a.median : a.median / b.median});
  });
  return {better: better, worse: worse, noise: noise, ratios: ratios, total: better.length + worse.length + noise.length};
}

function ratioRange(ratios) {
  if (ratios.length === 0) return '';
  const min = ratios.reduce((x, y) => (x.v < y.v ? x : y));
  const max = ratios.reduce((x, y) => (x.v > y.v ? x : y));
  return `ratio of medians from ${multiRun.fmtRatio(min.v)} (at ${min.label}) to ${multiRun.fmtRatio(max.v)} (at ${max.label})`;
}

function listCells(entries, fmt) {
  return entries.map((e) => `${e.label} (${fmt(e.b)} vs. ${fmt(e.a)})`).join(', ');
}

function pathSummary(runs, sandbox) {
  const d = conditionKey('direct', sandbox), m = conditionKey('routed', sandbox);
  const out = [];
  const p50 = compareCells(runs, d, m, 'hopP50', true);
  out.push(`**p50**: direct peer channels are lower than main-thread-routed in ${p50.better.length} of ${p50.total} cells, higher in ${
    p50.worse.length}${p50.worse.length > 0 ? ` (${listCells(p50.worse, ms)}, main vs. direct)` : ''}, and within noise in ${
    p50.noise.length}; ${ratioRange(p50.ratios)}.`);
  const tp = compareCells(runs, d, m, 'throughputRps', false);
  out.push(`**Throughput**: direct peer channels are higher in ${tp.better.length} of ${tp.total} cells, lower in ${
    tp.worse.length}${tp.worse.length > 0 ? ` (${listCells(tp.worse, rps)}, main vs. direct req/s)` : ''}, and within noise in ${
    tp.noise.length}; ${ratioRange(tp.ratios)}.`);
  const p99 = compareCells(runs, d, m, 'hopP99', true);
  out.push(`**p99**: direct peer channels are lower in ${p99.better.length} of ${p99.total} cells, higher (worse) in ${
    p99.worse.length}${p99.worse.length > 0 ? ` (${listCells(p99.worse, ms)}, main vs. direct)` : ''}, and within noise in ${
    p99.noise.length}.`);
  return out.join('\n\n');
}

// Each later sandbox mode against the first, per path: how much slower or
// faster the p50 and throughput are, and whether it clears the noise.
function sandboxSummary(runs, pathName) {
  const base = SANDBOX_MODES[0];
  const out = [];
  SANDBOX_MODES.slice(1).forEach((mode) => {
    const a = conditionKey(pathName, mode), b = conditionKey(pathName, base);
    ['hopP50', 'throughputRps'].forEach((metric) => {
      const lowerIsBetter = metric === 'hopP50';
      const parts = [];
      let flagged = 0;
      CELLS.forEach((k) => {
        const ra = rangeOf(runs, a, k.key, metric), rb = rangeOf(runs, b, k.key, metric);
        if (ra == null || rb == null) return;
        const slower = lowerIsBetter ? (ra.median / rb.median - 1) : (rb.median / ra.median - 1);
        const c = multiRun.compareLower(ra, rb);
        const verdict = c === 0 ? 'within noise' : ((lowerIsBetter ? c === 1 : c === -1) ? 'slower' : 'faster');
        if (verdict === 'slower' && slower > 0.10) flagged++;
        parts.push(`${cellLabel(k)} ${slower >= 0 ? '+' : ''}${(slower * 100).toFixed(0)}% (${verdict})`);
      });
      out.push(`**${PATH_LABELS[pathName]}, ${mode} vs. ${base}, ${metric === 'hopP50' ? 'p50' : 'throughput'}** (positive = ${mode} slower): ${
        parts.join(', ')}. Cells where ${mode} is more than 10% slower with non-overlapping ranges: ${flagged}.`);
    });
  });
  return out.join('\n\n');
}

function buildReport(runs) {
  const lines = [];
  const anyCond = runs[0].conditions[Object.keys(runs[0].conditions)[0]];
  lines.push(multiRun.envHeader(serverArgs(anyCond.path, anyCond.sandbox), runs.length));
  lines.push(`Requests per cell: ${REQUESTS_PER_COMBINATION}. Server flags beyond the defaults: ${extraServerArgs().join(' ') || 'none'}.`);

  SANDBOX_MODES.forEach((sandbox) => {
    const condKeys = PATHS.map((p) => conditionKey(p, sandbox));
    lines.push('');
    lines.push(`### Module sandbox: ${runs[0].conditions[condKeys[0]].sandboxMode}`);
    lines.push('');
    const header = ['Payload', 'Concurrency'];
    PATHS.forEach((p) => header.push(`${PATH_LABELS[p]} p50`, `${PATH_LABELS[p]} p99`, `${PATH_LABELS[p]} req/s`));
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`|${header.map(() => '---').join('|')}|`);
    const noise = {hopP50: [], hopP99: [], throughputRps: []};
    CELLS.forEach((k) => {
      const row = [formatPayload(k.payload), String(k.concurrency)];
      condKeys.forEach((ck, i) => {
        ['hopP50', 'hopP99', 'throughputRps'].forEach((metric) => {
          const r = rangeOf(runs, ck, k.key, metric);
          row.push(r == null ? 'n/a' : (metric === 'throughputRps' ? rps : ms)(r));
          if (r != null) noise[metric].push({label: `${PATH_LABELS[PATHS[i]]} ${cellLabel(k)}`, range: r});
        });
      });
      lines.push(`| ${row.join(' | ')} |`);
    });
    lines.push('');
    if (runs.length < 2) {
      lines.push('*Noise floor: not measured (a single run has no spread across runs).*');
    } else {
      const parts = [['p50', 'hopP50'], ['p99', 'hopP99'], ['throughput', 'throughputRps']].map((pair) => {
        const w = multiRun.noiseFloor(noise[pair[1]]);
        return `${pair[0]} ${(w.spread * 100).toFixed(0)}% (${w.label})`;
      });
      lines.push(`*Noise floor: the largest spread of any single configuration across the ${runs.length} runs, as (max - min) / median: ${parts.join('; ')}.*`);
    }

    const tally = {};
    const sbLog = multiRun.newSandboxLog();
    const samples = [];
    condKeys.forEach((ck) => runs.forEach((r) => {
      const cond = r.conditions[ck];
      Object.keys(cond.cells).forEach((cell) => {
        multiRun.mergeTally(tally, cond.cells[cell].errors);
        cond.cells[cell].errorSamples.forEach((s) => { if (samples.length < 3) samples.push(`${cell}: ${s}`); });
      });
      ['violations', 'wouldRefuse', 'uses', 'restarts', 'suspended'].forEach((f) => { sbLog[f] += cond.sandboxLog[f]; });
      cond.sandboxLog.samples.forEach((s) => { if (sbLog.samples.length < 10 && sbLog.samples.indexOf(s) === -1) sbLog.samples.push(s); });
    }));
    lines.push('');
    lines.push(`${multiRun.errorLine(tally)} ${multiRun.sandboxLogLine(sbLog)}`);
    if (samples.length > 0) lines.push(`Error samples: ${samples.join(' | ')}`);

    if (PATHS.length === 2) {
      lines.push('');
      lines.push(pathSummary(runs, sandbox));
    }
  });

  if (SANDBOX_MODES.length > 1) {
    PATHS.forEach((p) => {
      lines.push('');
      lines.push(sandboxSummary(runs, p));
    });
  }
  return lines.join('\n');
}

multiRun.main({measure: measureOnce, report: buildReport}).then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
