// Cross-worker call benchmark: main-thread-routed (--directPeerChannels off,
// the default) vs direct peer channel (--directPeerChannels on). See
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
// This script computes its own comparison summary (p50 improvement range,
// throughput win count, p99 win/loss per cell) from whatever numbers it
// actually measured -- a hand-written summary sentence in
// docs/direct-peer-channels.md can silently drift from the table next to
// it (this happened once already: "1.3-7x" and "7 of 9" were both wrong
// against the table they described, found and fixed after the fact). The
// rule going forward: docs/direct-peer-channels.md's prose may only
// quote numbers this script printed, copy-pasted from a real run --
// nothing hand-computed or hand-remembered.
//
// Usage: node perf/direct-peer-channels-perf.js
// Starts and stops its own server for each condition; takes several
// minutes for the full 2 x 3 x 3 matrix (conditions x payload sizes x
// concurrency levels). Prints a markdown table and a plain-language
// summary to stdout, ready to paste into docs/direct-peer-channels.md,
// followed by the raw JSON for archival/scripting use.

const cp = require('child_process');
const path = require('path');

const PORT = 18500;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CALLER_DEVICE_ID = '13793b1a-132d-5a03-a46b-2e0bb72d0d82'; // perf-caller-demo, computed offline via UUID.v5

const PAYLOAD_SIZES = [1024, 102400, 1048576]; // 1KB, 100KB, 1MB
const CONCURRENCY_LEVELS = [1, 16, 64];
const REQUESTS_PER_COMBINATION = 150;

function startServer(directPeerChannels) {
  return new Promise((resolve, reject) => {
    const args = [
      './framework.js',
      '--workerThread', '--debug',
      '--bindAddr', '127.0.0.1',
      '--port', String(PORT),
      '--loadModule', './pre-installed-packages/perf-callee-demo',
      '--loadModule', './pre-installed-packages/perf-caller-demo'
    ];
    if (directPeerChannels === true) args.push('--directPeerChannels');

    const child = cp.spawn('node', args, {cwd: path.resolve(__dirname, '..'), stdio: 'ignore'});
    child.on('error', reject);

    // module discovery is a fixed ~5s per module (sandbox.js's
    // 'discover-device' handling) -- 2 modules loaded sequentially, plus
    // startup itself, so this is a generous fixed wait rather than a poll
    // loop, matching the rest of this codebase's test/perf conventions.
    setTimeout(() => { resolve(child); }, 13000);
  });
}

function stopServer(child) {
  return fetch(`${BASE_URL}/shutdown`, {method: 'POST'}).catch(() => {}).then(() => {
    return new Promise((resolve) => {
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
  }).then((res) => { return res.json(); }).then((body) => {
    return {wallMs: Date.now() - t0, hopMs: body.output != null ? body.output.durationMs : null, error: body.output == null ? body : null};
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
    let errors = 0;
    let started = 0;
    let completed = 0;
    const wallStart = Date.now();

    function next() {
      if (started >= total) return;
      started++;
      invoke(payloadSizeBytes).then((r) => {
        if (r.error != null) errors++;
        results.push(r);
        completed++;
        if (completed >= total) {
          const totalWallMs = Date.now() - wallStart;
          const hopLatencies = results.filter((r) => { return r.hopMs != null; }).map((r) => { return r.hopMs; }).sort((a, b) => { return a - b; });
          return resolve({
            errors: errors,
            throughputRps: (total / totalWallMs) * 1000,
            hopP50: percentile(hopLatencies, 50),
            hopP99: percentile(hopLatencies, 99),
            hopMean: hopLatencies.reduce((a, b) => { return a + b; }, 0) / hopLatencies.length
          });
        }
        next();
      }).catch(reject);
    }

    for (let i = 0; i < Math.min(concurrency, total); i++) next();
  });
}

async function benchmarkCondition(directPeerChannels) {
  const label = directPeerChannels === true ? 'directPeerChannels' : 'mainThreadRouted';
  console.error(`\n=== ${label} ===`);
  const child = await startServer(directPeerChannels);

  const results = {};
  try {
    // warm up the channel (and, for the flag-off case, the worker pair in
    // general) with a couple of throwaway calls before measuring -- the
    // matrix below is about steady-state behavior, not cold-start cost
    // (D1's brokering cost on the very first call is a separate, one-time
    // thing, not what this table is measuring).
    await invoke(1024);
    await invoke(1024);

    for (let s = 0; s < PAYLOAD_SIZES.length; s++) {
      for (let c = 0; c < CONCURRENCY_LEVELS.length; c++) {
        const payloadSizeBytes = PAYLOAD_SIZES[s];
        const concurrency = CONCURRENCY_LEVELS[c];
        const key = `${payloadSizeBytes}:${concurrency}`;
        console.error(`  payload=${payloadSizeBytes}B concurrency=${concurrency} ...`);
        const r = await runLoad(payloadSizeBytes, concurrency, REQUESTS_PER_COMBINATION);
        results[key] = r;
        console.error(`    throughput=${r.throughputRps.toFixed(1)} req/s, hop p50=${r.hopP50.toFixed(2)}ms p99=${r.hopP99.toFixed(2)}ms, errors=${r.errors}`);
      }
    }
  } finally {
    await stopServer(child);
  }
  return results;
}

function formatPayload(bytes) {
  if (bytes >= 1048576) return `${bytes / 1048576}MB`;
  if (bytes >= 1024) return `${bytes / 1024}KB`;
  return `${bytes}B`;
}

function cellKeys() {
  const keys = [];
  for (let s = 0; s < PAYLOAD_SIZES.length; s++) {
    for (let c = 0; c < CONCURRENCY_LEVELS.length; c++) {
      keys.push({key: `${PAYLOAD_SIZES[s]}:${CONCURRENCY_LEVELS[c]}`, payload: PAYLOAD_SIZES[s], concurrency: CONCURRENCY_LEVELS[c]});
    }
  }
  return keys;
}

// Builds the markdown table plus a plain-language summary computed from
// the actual measured numbers -- see this file's header comment for why
// this exists (docs/direct-peer-channels.md's prose must only quote
// numbers this function produced, not hand-computed ones).
function buildReport(mainThreadRouted, directPeerChannels) {
  const keys = cellKeys();

  const rows = ['| Payload | Concurrency | Main-thread-routed p50 / p99 | Direct peer channel p50 / p99 | Throughput (main-thread / direct) |', '|---|---|---|---|---|'];
  const p50Ratios = [];   // {key, ratio} -- mainP50 / directP50; >1 means direct is faster
  const throughputWins = []; // keys where direct throughput > main throughput
  const throughputLosses = [];
  const p99Wins = [];     // keys where direct p99 < main p99
  const p99Losses = [];

  keys.forEach((k) => {
    const m = mainThreadRouted[k.key];
    const d = directPeerChannels[k.key];

    rows.push(`| ${formatPayload(k.payload)} | ${k.concurrency} | ${m.hopP50.toFixed(2)}ms / ${m.hopP99.toFixed(2)}ms | ${d.hopP50.toFixed(2)}ms / ${d.hopP99.toFixed(2)}ms | ${m.throughputRps.toFixed(0)} / ${d.throughputRps.toFixed(0)} req/s |`);

    const ratio = m.hopP50 / d.hopP50;
    p50Ratios.push({key: k.key, label: `${formatPayload(k.payload)}/c=${k.concurrency}`, ratio: ratio});

    if (d.throughputRps > m.throughputRps) throughputWins.push(k.key);
    else throughputLosses.push(k.key);

    if (d.hopP99 < m.hopP99) p99Wins.push({label: `${formatPayload(k.payload)}/c=${k.concurrency}`, main: m.hopP99, direct: d.hopP99});
    else p99Losses.push({label: `${formatPayload(k.payload)}/c=${k.concurrency}`, main: m.hopP99, direct: d.hopP99});
  });

  const minRatio = p50Ratios.reduce((a, b) => { return a.ratio < b.ratio ? a : b; });
  const maxRatio = p50Ratios.reduce((a, b) => { return a.ratio > b.ratio ? a : b; });

  // Named fragments rather than deeply nested interpolations: this text is
  // copied verbatim into docs/direct-peer-channels.md, so it has to stay
  // readable enough to review against the table it summarises.
  const fasterCells  = p50Ratios.filter((r) => r.ratio > 1).length;
  const winList      = throughputWins.map((k) => k.replace(':', '/c=')).join(', ');
  const lossList     = throughputLosses.map((k) => k.replace(':', '/c=')).join(', ');
  const p99LossList  = p99Losses.map((l) => `${l.label} (${l.main.toFixed(2)}ms main vs. ${l.direct.toFixed(2)}ms direct)`).join(', ');

  const winNote      = throughputWins.length   > 0 ? ` (${winList})` : '';
  const lossNote     = throughputLosses.length > 0 ? `; main-thread-routed wins on the remaining ${throughputLosses.length} (${lossList})` : '';
  const p99LossNote  = p99Losses.length        > 0 ? `; higher (worse) in ${p99Losses.length}: ${p99LossList}` : '';

  const summary = [];
  summary.push(`**p50**: direct peer channels are faster than main-thread-routed in ${fasterCells} of ${p50Ratios.length} cells, ranging from ${minRatio.ratio.toFixed(2)}× (at ${minRatio.label}) to ${maxRatio.ratio.toFixed(2)}× (at ${maxRatio.label}).`);

  summary.push(`**Throughput**: direct peer channels win on ${throughputWins.length} of ${keys.length} cells${winNote}${lossNote}.`);

  summary.push(`**p99**: direct peer channels are lower in ${p99Wins.length} of ${keys.length} cells${p99LossNote}.`);

  return {table: rows.join('\n'), summary: summary.join('\n\n')};
}

async function main() {
  const mainThreadRouted = await benchmarkCondition(false);
  const directPeerChannels = await benchmarkCondition(true);

  const report = buildReport(mainThreadRouted, directPeerChannels);

  console.log(`\n${report.table}\n`);
  console.log(`${report.summary}\n`);
  console.log(JSON.stringify({mainThreadRouted: mainThreadRouted, directPeerChannels: directPeerChannels}, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
