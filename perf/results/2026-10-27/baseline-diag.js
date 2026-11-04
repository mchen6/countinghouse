// Diagnostic for the log-triage in-process baseline: the same four handlers,
// run (a) one file after another, as perf/log-triage-perf.js's baseline does,
// and (b) with the per-file read -> redact chains concurrent, as the composite
// (examples/log-triage/log-triage/handlers/triageService/triage.js) runs them.
// Also times read alone, sequential vs concurrent. Variants are interleaved
// rep by rep so drift hits all of them alike.
//   node baseline-diag.js <repo> [reps]
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ROOT = path.resolve(process.argv[2]);
const REPS = Number(process.argv[3] || 25);
const WARMUP = 5;
const EXAMPLE = path.join(ROOT, 'examples', 'log-triage');
global.DeviceError = require(path.join(ROOT, 'lib', 'countinghouse-error')).DeviceError;
const gen = require(path.join(EXAMPLE, 'generate-logs.js'));
const h = {
  list:    require(path.join(EXAMPLE, 'log-read', 'handlers', 'readService', 'list.js')),
  read:    require(path.join(EXAMPLE, 'log-read', 'handlers', 'readService', 'read.js')),
  redact:  require(path.join(EXAMPLE, 'pii-redact', 'handlers', 'redactService', 'redact.js')),
  cluster: require(path.join(EXAMPLE, 'error-cluster', 'handlers', 'clusterService', 'cluster.js'))
};
const now = () => Number(process.hrtime.bigint()) / 1e6;

async function sequential(dir, n) {
  const t = now();
  const files = (await h.list({dir})).output.files.slice(0, n);
  let lines = [];
  for (const f of files) {
    const raw = (await h.read({dir, name: f.name})).output;
    lines = lines.concat((await h.redact({lines: raw.lines})).output.lines);
  }
  await h.cluster({lines});
  return now() - t;
}

async function concurrent(dir, n) {
  const t = now();
  const files = (await h.list({dir})).output.files.slice(0, n);
  const chains = await Promise.all(files.map(async (f) => {
    const raw = (await h.read({dir, name: f.name})).output;
    return (await h.redact({lines: raw.lines})).output.lines;
  }));
  await h.cluster({lines: [].concat(...chains)});
  return now() - t;
}

async function readSeq(dir, n) {
  const files = (await h.list({dir})).output.files.slice(0, n);
  const t = now();
  for (const f of files) await h.read({dir, name: f.name});
  return now() - t;
}

async function readConc(dir, n) {
  const files = (await h.list({dir})).output.files.slice(0, n);
  const t = now();
  await Promise.all(files.map((f) => h.read({dir, name: f.name})));
  return now() - t;
}

const median = (a) => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-diag-'));
  const out = {cpusVisible: os.cpus().length, affinity: process.env.DIAG_AFFINITY || 'all', reps: REPS, sizes: {}};
  try {
    for (const lines of [100, 400, 1600, 6400]) {
      const dir = path.join(tmp, `size-${lines}`);
      gen.generate({dir, files: 8, lines, seed: 1});
      const variants = {sequential, concurrent, readSeq, readConc};
      const samples = {};
      for (const k of Object.keys(variants)) samples[k] = [];
      for (let i = 0; i < WARMUP; i++) for (const k of Object.keys(variants)) await variants[k](dir, 8);
      for (let i = 0; i < REPS; i++) for (const k of Object.keys(variants)) samples[k].push(await variants[k](dir, 8));
      out.sizes[lines] = {};
      for (const k of Object.keys(samples)) out.sizes[lines][k] = median(samples[k]);
    }
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
  console.log(JSON.stringify(out));
})();
