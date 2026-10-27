// Shared by the perf scripts that take --runs N: run the measurement N times,
// each in a fresh process (so each run gets fresh servers, fresh workers and
// a fresh V8), then report every cell as the median of the N per-run values
// with the [min-max] range across runs.
//
// The comparison rule every generated sentence follows: one side is faster
// or slower than the other only if their ranges across runs do not overlap.
// Overlapping ranges are "within noise", whatever the medians say. Each
// table is followed by its noise floor: the largest relative spread
// ((max - min) / median) of any single configuration across the N runs.
//
// A script uses it like this:
//
//   const multiRun = require('./multi-run');
//   multiRun.main({measure: measureOnce, report: buildReport});
//
// measureOnce() returns one run's results as plain JSON. buildReport(runs)
// receives the array of N such results and returns the text to print.
// Without --runs the script behaves as before: one run, in this process.
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const cp   = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function argValue(name, fallback) {
  const at = process.argv.indexOf(name);
  return (at !== -1 && process.argv[at + 1] != null) ? process.argv[at + 1] : fallback;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return (sorted.length % 2 === 1) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// {median, min, max, n} of one cell's per-run values
function across(values) {
  return {median: median(values), min: Math.min.apply(null, values), max: Math.max.apply(null, values), n: values.length};
}

function overlaps(a, b) {
  return !(a.max < b.min || b.max < a.min);
}

// -1: a is lower, 1: a is higher, 0: within noise
function compareLower(a, b) {
  if (overlaps(a, b)) return 0;
  return a.max < b.min ? -1 : 1;
}

function relativeSpread(r) {
  return r.median > 0 ? (r.max - r.min) / r.median : 0;
}

// cells: [{label, range}] -- every configuration measured in one table.
function noiseFloor(cells) {
  let worst = null;
  cells.forEach((c) => {
    const s = relativeSpread(c.range);
    if (worst == null || s > worst.spread) worst = {label: c.label, spread: s};
  });
  return worst;
}

function noiseFloorLine(cells, runs) {
  const w = noiseFloor(cells);
  if (w == null) return '';
  if (runs < 2) return '*Noise floor: not measured (a single run has no spread across runs).*';
  return `*Noise floor: the largest spread of any single configuration across the ${runs} runs is ${
    (w.spread * 100).toFixed(0)}% (${w.label}), as (max - min) / median.*`;
}

// "1.23 [1.10-1.40]" with the given number formatter
function fmtRange(r, fmt) {
  return `${fmt(r.median)} [${fmt(r.min)}–${fmt(r.max)}]`;
}

// The sandbox mode a server started with these flags runs in, decided by the
// server's own code (lib/sandbox-support.js) rather than restated here.
function sandboxMode(serverArgs) {
  const support = require(path.join(ROOT, 'lib', 'sandbox-support'));
  const at = serverArgs.indexOf('--moduleSandbox');
  const argvMode = at !== -1 ? serverArgs[at + 1] : undefined;
  const worker = serverArgs.indexOf('--workerThread') !== -1;
  const r = support.resolveMode(argvMode, worker, support.missing());
  return r.explicit ? `${r.mode} (--moduleSandbox ${r.mode})` : `${r.mode} (default)`;
}

// --moduleSandbox <mode> on this script's command line, passed through to
// every server it starts. Returns [] when not given, so the server default
// applies.
function sandboxArgs() {
  const mode = argValue('--moduleSandbox', null);
  return mode != null ? ['--moduleSandbox', mode] : [];
}

// Counts of the server's own sandbox log lines (lib/module-manager.js), so a
// table run under audit shows what enforce would have refused.
function newSandboxLog() {
  return {violations: 0, wouldRefuse: 0, uses: 0, restarts: 0, suspended: 0, samples: []};
}

function scanSandboxLog(text, into) {
  const re = /module sandbox: (\S+) (violation (\S+) (\S+)|would be refused under enforce: [^"\n]*|uses (\S+)|restarting after: [^"\n]*|suspended[^"\n]*)/g;
  let m;
  while ((m = re.exec(text)) != null) {
    if (m[2].startsWith('violation')) into.violations++;
    else if (m[2].startsWith('would be refused')) into.wouldRefuse++;
    else if (m[2].startsWith('uses')) into.uses++;
    else if (m[2].startsWith('restarting')) into.restarts++;
    else if (m[2].startsWith('suspended')) into.suspended++;
    if (!m[2].startsWith('uses') && into.samples.length < 10) into.samples.push(`${m[1]} ${m[2]}`);
  }
  return into;
}

function sandboxLogLine(log) {
  return `Sandbox log: ${log.violations} violations, ${log.wouldRefuse} would-be-refused under enforce, ${
    log.restarts} restarts, ${log.suspended} suspensions${log.samples.length > 0 ? ` (${log.samples.join('; ')})` : ''}.`;
}

// Error tally: {code: count}. A call's error is classified by the first
// countinghouse error code found in its body, RATE_LIMITED first.
function classifyError(text) {
  if (/RATE_LIMITED/.test(text)) return 'RATE_LIMITED';
  const m = /\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)\b/.exec(text);
  return m != null ? m[1] : 'OTHER';
}

function errorLine(tally) {
  const keys = Object.keys(tally);
  if (keys.length === 0) return 'Errors: none.';
  return `Errors: ${keys.map((k) => `${k} ${tally[k]}`).join(', ')}.`;
}

function mergeTally(into, from) {
  Object.keys(from || {}).forEach((k) => { into[k] = (into[k] || 0) + from[k]; });
  return into;
}

// The environment header every report starts with.
function envHeader(serverArgs, runs) {
  const cpus = os.cpus();
  const lines = [
    `Machine: ${cpus.length} x ${cpus[0].model.trim()}, ${(os.totalmem() / 1073741824).toFixed(1)} GB, Node ${process.version}, ${os.platform()} ${os.release()}`,
    `Runs: ${runs}, each in a fresh process. Cells are the median across runs, [min–max] across runs.`
  ];
  if (serverArgs != null) lines.push(`Module sandbox: ${sandboxMode(serverArgs)}`);
  else lines.push('Module sandbox: n/a (no countinghouse server involved)');
  return lines.join('\n');
}

// Runs this script N times as child processes with --run-json <file>, or
// once in-process when --runs is absent, and hands the results to report().
async function main(spec) {
  const childOut = argValue('--run-json', null);
  if (childOut != null) {
    const result = await spec.measure();
    fs.writeFileSync(childOut, JSON.stringify(result));
    return null;
  }

  const runs = Number(argValue('--runs', 1));
  const results = [];
  if (argValue('--runs', null) == null) {
    results.push(await spec.measure());
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-runs-'));
    try {
      for (let i = 0; i < runs; i++) {
        console.error(`\n##### run ${i + 1} of ${runs} #####`);
        const out = path.join(dir, `run-${i}.json`);
        const args = [process.argv[1]].concat(stripRuns(process.argv.slice(2)), ['--run-json', out]);
        const code = await new Promise((resolve) => {
          const child = cp.spawn(process.execPath, args, {cwd: process.cwd(), stdio: ['ignore', 'inherit', 'inherit']});
          child.on('exit', (c) => resolve(c));
        });
        if (code !== 0) throw new Error(`run ${i + 1} exited with code ${code}`);
        results.push(JSON.parse(fs.readFileSync(out, 'utf8')));
      }
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }

  const text = spec.report(results);
  console.log(text);
  const jsonPath = argValue('--json', null);
  if (jsonPath != null) fs.writeFileSync(jsonPath, JSON.stringify({runs: results}, null, 2));
  return results;
}

function stripRuns(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs' || argv[i] === '--json') { i++; continue; }
    out.push(argv[i]);
  }
  return out;
}

module.exports = {
  argValue, median, across, overlaps, compareLower, relativeSpread, noiseFloor, noiseFloorLine,
  fmtRange, sandboxMode, sandboxArgs, newSandboxLog, scanSandboxLog, sandboxLogLine,
  classifyError, errorLine, mergeTally, envHeader, main
};
