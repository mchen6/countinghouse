// Tool-to-tool communication overhead: countinghouse's direct peer channel
// vs. the two transports an MCP deployment would otherwise use to get from
// one tool to another -- a stdio subprocess and localhost HTTP.
//
// WHAT THIS MEASURES, AND WHAT IT DOES NOT
//
// It measures the *transport*. Every peer in all three conditions does the
// same nothing: parse the request, echo the payload back, serialize. There
// is no tool work, no schema validation, no auth, no metering. So these
// numbers are an upper bound on how much any of this can matter, not a
// prediction about a real workload -- see the note the generated report
// prints about tool execution time dominating.
//
// It is NOT a comparison of MCP implementations. Condition (b) is a bare
// newline-delimited JSON-RPC 2.0 echo over stdin/stdout -- the framing MCP's
// stdio transport uses -- not a real MCP server: no initialize handshake, no
// capability negotiation, no tools/list. A real MCP server does strictly
// more than this per call, so (b) here is the *best case* for stdio.
//
// The three conditions, and why each is shaped the way it is:
//
//   (a) direct peer channel  -- two worker_threads connected by a
//       MessageChannel, both ends running the real lib/peer-channel.js.
//       Same-process, structured-clone postMessage. This is the production
//       topology (worker-to-worker, see lib/peer-channel-broker.js's D1),
//       not a mock.
//   (b) MCP stdio subprocess -- a child *process*, newline-delimited
//       JSON-RPC over stdin/stdout. Serialization + pipe + process boundary.
//   (c) localhost HTTP       -- a child *process* serving JSON-RPC over
//       HTTP on 127.0.0.1, keep-alive on. Serialization + loopback TCP +
//       HTTP framing + process boundary. Keep-alive is deliberate:
//       reconnecting per call would measure connection setup, not transport.
//
// A "chain of N hops" here is N sequential request/response round trips
// through one peer, not a pipeline through N distinct peers. That isolates
// per-hop transport cost, which is the thing being compared; threading a
// request through 100 distinct subprocesses would mostly measure process
// startup, which is a separate (and separately interesting) cost.
//
// METHODOLOGY -- matches perf/direct-peer-channels-perf.js:
//   - warm up before measuring; the matrix is about steady state
//   - report the median (p50) and p99 of per-chain wall time, plus the
//     sample count, so a coarse percentile is visible as coarse
//   - CPU and peak RSS are summed across every process involved in a
//     condition (for (a) that is one process containing both workers; for
//     (b)/(c) it is the driver plus its child), read from /proc on Linux
//   - THE COMPARISON SUMMARY IS GENERATED FROM THE MEASURED NUMBERS. Same
//     rule as direct-peer-channels-perf.js, for the same reason: a
//     hand-written summary in docs/ drifted from the table beside it once
//     already. Prose in docs/direct-peer-channels.md may only quote numbers
//     this script printed, copy-pasted from a real run.
//
// Usage: node perf/cross-process-comparison.js
// Prints a markdown table + generated summary, then raw JSON. Takes several
// minutes; the 1MB/100-hop cells move gigabytes through each transport.

const cp     = require('child_process');
const path   = require('path');
const fs     = require('fs');
const http   = require('http');
const Worker = require('worker_threads').Worker;
const MessageChannel = require('worker_threads').MessageChannel;

const PAYLOAD_SIZES = [1024, 65536, 1048576];   // 1KB, 64KB, 1MB
const CHAIN_LENGTHS = [1, 10, 100];
const HTTP_PORT     = 18700;
const PEERS_DIR     = path.resolve(__dirname, 'cross-process-peers');

// Iteration count per cell, chosen so total bytes moved stays bounded while
// keeping enough samples for a meaningful p50. Small payloads get many more
// iterations than large ones; long chains get fewer, since each iteration is
// already N round trips.
const TARGET_HOPS_BY_PAYLOAD = {1024: 4000, 65536: 1000, 1048576: 200};
const MIN_ITERATIONS = 20;
const MAX_ITERATIONS = 500;

function iterationsFor(payloadBytes, hops) {
  const target = TARGET_HOPS_BY_PAYLOAD[payloadBytes];
  return Math.max(MIN_ITERATIONS, Math.min(MAX_ITERATIONS, Math.round(target / hops)));
}

// --- /proc sampling (Linux). Returns null elsewhere rather than guessing. ---
function readCpuSeconds(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // utime and stime are fields 14 and 15, after the comm field which may
    // itself contain spaces -- so split from the closing paren, not the start
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const clk = 100; // USER_HZ; 100 on every mainstream Linux build
    return (parseInt(after[11], 10) + parseInt(after[12], 10)) / clk;
  } catch (e) { return null; }
}

function readRssBytes(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /VmRSS:\s+(\d+) kB/.exec(status);
    return m != null ? parseInt(m[1], 10) * 1024 : null;
  } catch (e) { return null; }
}

function sumOrNull(values) {
  if (values.some((v) => { return v == null; })) return null;
  return values.reduce((a, b) => { return a + b; }, 0);
}

// Samples CPU/RSS across a set of pids for the duration of `fn`.
function withResourceSampling(pids, fn) {
  const cpuStart = sumOrNull(pids.map(readCpuSeconds));
  let peakRss  = sumOrNull(pids.map(readRssBytes)) || 0;

  const timer = setInterval(() => {
    const rss = sumOrNull(pids.map(readRssBytes));
    if (rss != null && rss > peakRss) peakRss = rss;
  }, 100);

  return fn().then((result) => {
    clearInterval(timer);
    const cpuEnd = sumOrNull(pids.map(readCpuSeconds));
    result.cpuSeconds = (cpuStart != null && cpuEnd != null) ? (cpuEnd - cpuStart) : null;
    result.peakRssBytes = peakRss > 0 ? peakRss : null;
    return result;
  }).catch((e) => { clearInterval(timer); throw e; });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length));
  return sorted[idx];
}

function summarize(latencies, hops) {
  const sorted = latencies.slice().sort((a, b) => { return a - b; });
  const totalMs = latencies.reduce((a, b) => { return a + b; }, 0);
  return {
    samples:      latencies.length,
    chainP50Ms:   percentile(sorted, 50),
    chainP99Ms:   percentile(sorted, 99),
    perHopP50Ms:  percentile(sorted, 50) / hops,
    hopsPerSecond: totalMs > 0 ? (latencies.length * hops) / (totalMs / 1000) : null
  };
}

// --------------------------- (a) direct peer channel ---------------------
// Setup is separated from measurement so that worker startup is NOT inside
// the sampled region -- conditions (b) and (c) warm their peer up before
// sampling too, and charging (a) for two Worker spawns while not charging
// them for a process spawn would be a rigged comparison.
function setupPeerChannel() {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const caller = new Worker(path.join(PEERS_DIR, 'worker-peer.js'),
      {workerData: {role: 'caller', port: channel.port1}, transferList: [channel.port1]});
    const callee = new Worker(path.join(PEERS_DIR, 'worker-peer.js'),
      {workerData: {role: 'callee', port: channel.port2}, transferList: [channel.port2]});

    let ready = 0, pending = null;

    caller.on('message', (msg) => {
      if (msg.ready === true) { if (++ready === 2) finish(); return; }
      if (msg.done === true && pending != null) { const cb = pending; pending = null; cb(msg); }
    });
    callee.on('message', (msg) => { if (msg.ready === true && ++ready === 2) finish(); });
    caller.on('error', reject);
    callee.on('error', reject);

    function finish() {
      resolve({
        run: function(payloadBytes, hops, iterations) {
          return new Promise((res, rej) => {
            pending = function(msg) {
              if (msg.error != null) return rej(new Error(`peer-channel: ${msg.error}`));
              res(msg.latencies);
            };
            caller.postMessage({command: 'run', payloadBytes: payloadBytes, hops: hops, iterations: iterations});
          });
        },
        stop: function() { return Promise.all([caller.terminate(), callee.terminate()]); }
      });
    }
  });
}

// --------------------------- (b) MCP stdio subprocess --------------------
function startStdioPeer() {
  const child = cp.spawn('node', [path.join(PEERS_DIR, 'stdio-peer.js')], {stdio: ['pipe', 'pipe', 'ignore']});
  let pending = null;
  let buf = '';

  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() === '' || pending == null) continue;
      const cb = pending; pending = null;
      cb(null);
    }
  });

  return {
    child: child,
    call: function(id, payload, cb) {
      pending = cb;
      child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: id, method: 'echo', params: {payload: payload}})  }\n`);
    },
    stop: function() { try { child.kill('SIGKILL'); } catch (e) {} }
  };
}

// --------------------------- (c) localhost HTTP --------------------------
function startHttpPeer(port) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn('node', [path.join(PEERS_DIR, 'http-peer.js'), String(port)], {stdio: ['ignore', 'pipe', 'ignore']});
    child.on('error', reject);
    child.stdout.once('data', () => { resolve(child); });
    setTimeout(() => { resolve(child); }, 3000); // fallback if 'ready' is missed
  });
}

// --------------------------- shared chain driver -------------------------
// Runs `iterations` chains of `hops` sequential round trips through `call`,
// timing each whole chain.
function driveChain(call, payload, hops, iterations) {
  return new Promise((resolve, reject) => {
    const latencies = [];
    let n = 0, id = 0;

    function iteration() {
      if (n >= iterations) return resolve(latencies);
      n++;
      const t0 = process.hrtime.bigint();
      let i = 0;
      (function hop() {
        if (i >= hops) {
          latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
          return iteration();
        }
        i++;
        call(++id, payload, (err) => {
          if (err != null) return reject(err);
          hop();
        });
      })();
    }
    iteration();
  });
}

function httpCall(port, agent) {
  return function(id, payload, cb) {
    const body = JSON.stringify({jsonrpc: '2.0', id: id, method: 'echo', params: {payload: payload}});
    const req = http.request({
      host: '127.0.0.1', port: port, method: 'POST', path: '/', agent: agent,
      headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}
    }, (res) => {
      res.resume();
      res.on('end', () => { cb(null); });
    });
    req.on('error', cb);
    req.end(body);
  };
}

// --------------------------- conditions ----------------------------------
async function benchmarkPeerChannel(payloadBytes, hops, iterations) {
  const peer = await setupPeerChannel();
  try {
    await peer.run(payloadBytes, 1, 3); // warm up, outside the sampled region
    // both workers live in THIS process, so this pid covers the whole condition
    return await withResourceSampling([process.pid], () => {
      return peer.run(payloadBytes, hops, iterations).then((l) => { return summarize(l, hops); });
    });
  } finally { await peer.stop(); }
}

async function benchmarkStdio(payloadBytes, hops, iterations) {
  const peer = startStdioPeer();
  const payload = 'x'.repeat(payloadBytes);
  try {
    await driveChain(peer.call, payload, 1, 3); // warm up
    return await withResourceSampling([process.pid, peer.child.pid], () => {
      return driveChain(peer.call, payload, hops, iterations).then((l) => { return summarize(l, hops); });
    });
  } finally { peer.stop(); }
}

async function benchmarkHttp(payloadBytes, hops, iterations) {
  const child = await startHttpPeer(HTTP_PORT);
  const agent = new http.Agent({keepAlive: true, maxSockets: 1});
  const call = httpCall(HTTP_PORT, agent);
  const payload = 'x'.repeat(payloadBytes);
  try {
    await driveChain(call, payload, 1, 3); // warm up + establish the connection
    return await withResourceSampling([process.pid, child.pid], () => {
      return driveChain(call, payload, hops, iterations).then((l) => { return summarize(l, hops); });
    });
  } finally {
    agent.destroy();
    try { child.kill('SIGKILL'); } catch (e) {}
    await new Promise((r) => { setTimeout(r, 200); });
  }
}

// --------------------------- reporting -----------------------------------
function formatPayload(bytes) {
  if (bytes >= 1048576) return `${bytes / 1048576}MB`;
  if (bytes >= 1024) return `${bytes / 1024}KB`;
  return `${bytes}B`;
}

function fmtMs(v)  { return v == null ? 'n/a' : `${v.toFixed(3)}ms`; }
function fmtRss(v) { return v == null ? 'n/a' : `${(v / 1048576).toFixed(0)}MB`; }
function fmtCpu(v) { return v == null ? 'n/a' : `${v.toFixed(2)}s`; }

// Generated from the measured numbers -- never hand-written. See the header.
function buildReport(results) {
  const rows = [
    '| Payload | Hops | Direct peer channel<br>p50 / p99 | MCP stdio subprocess<br>p50 / p99 | localhost HTTP<br>p50 / p99 | Per-hop p50<br>(peer / stdio / http) | Hops/s<br>(peer / stdio / http) | CPU<br>(peer / stdio / http) | Peak RSS<br>(peer / stdio / http) | n |',
    '|---|---|---|---|---|---|---|---|---|---|'
  ];

  const speedupsStdio = [], speedupsHttp = [];

  PAYLOAD_SIZES.forEach((p) => {
    CHAIN_LENGTHS.forEach((h) => {
      const k = `${p}:${h}`;
      const a = results.peerChannel[k], b = results.stdio[k], c = results.http[k];

      rows.push(`| ${formatPayload(p)} | ${h} | ${fmtMs(a.chainP50Ms)} / ${fmtMs(a.chainP99Ms)} | ${fmtMs(b.chainP50Ms)} / ${fmtMs(b.chainP99Ms)} | ${fmtMs(c.chainP50Ms)} / ${fmtMs(c.chainP99Ms)} | ${fmtMs(a.perHopP50Ms)} / ${fmtMs(b.perHopP50Ms)} / ${fmtMs(c.perHopP50Ms)} | ${a.hopsPerSecond.toFixed(0)} / ${b.hopsPerSecond.toFixed(0)} / ${c.hopsPerSecond.toFixed(0)} | ${fmtCpu(a.cpuSeconds)} / ${fmtCpu(b.cpuSeconds)} / ${fmtCpu(c.cpuSeconds)} | ${fmtRss(a.peakRssBytes)} / ${fmtRss(b.peakRssBytes)} / ${fmtRss(c.peakRssBytes)} | ${a.samples} |`);

      speedupsStdio.push({label: `${formatPayload(p)}/${h}hop`, v: b.chainP50Ms / a.chainP50Ms});
      speedupsHttp.push({label: `${formatPayload(p)}/${h}hop`, v: c.chainP50Ms / a.chainP50Ms});
    });
  });

  function range(arr) {
    const min = arr.reduce((x, y) => { return x.v < y.v ? x : y; });
    const max = arr.reduce((x, y) => { return x.v > y.v ? x : y; });
    return {min: min, max: max, wins: arr.filter((x) => { return x.v > 1; }).length, total: arr.length};
  }

  const rs = range(speedupsStdio), rh = range(speedupsHttp);

  // the honest counterweight, computed rather than asserted: how long a tool
  // would have to take for the transport difference to be <=10% of a hop
  let worstHopDeltaMs = 0;
  PAYLOAD_SIZES.forEach((p) => {
    CHAIN_LENGTHS.forEach((h) => {
      const k = `${p}:${h}`;
      const d = Math.min(results.stdio[k].perHopP50Ms, results.http[k].perHopP50Ms) - results.peerChannel[k].perHopP50Ms;
      if (d > worstHopDeltaMs) worstHopDeltaMs = d;
    });
  });

  const summary = [];
  summary.push(`**vs. MCP stdio subprocess**: the direct peer channel has a lower p50 in ${rs.wins} of ${rs.total} cells, from ${rs.min.v.toFixed(2)}× (at ${rs.min.label}) to ${rs.max.v.toFixed(2)}× (at ${rs.max.label}).`);
  summary.push(`**vs. localhost HTTP**: lower p50 in ${rh.wins} of ${rh.total} cells, from ${rh.min.v.toFixed(2)}× (at ${rh.min.label}) to ${rh.max.v.toFixed(2)}× (at ${rh.max.label}).`);
  const breakEvenMs = worstHopDeltaMs * 10;
  summary.push(`**Scale of the difference**: the largest per-hop saving measured here is ${worstHopDeltaMs.toFixed(3)}ms (best case for the direct channel, across every cell). ` +
    `A tool whose own execution takes more than ${ 
    breakEvenMs >= 1 ? `~${breakEvenMs.toFixed(0)}ms` : `~${breakEvenMs.toFixed(2)}ms` 
    } per call would see even that saving as under 10% of the hop, and proportionally less the ` +
    `slower it gets. This benchmark measures transport, not tools.`);

  return {table: rows.join('\n'), summary: summary.join('\n\n')};
}

async function main() {
  const results = {peerChannel: {}, stdio: {}, http: {}};

  for (let s = 0; s < PAYLOAD_SIZES.length; s++) {
    for (let c = 0; c < CHAIN_LENGTHS.length; c++) {
      const payloadBytes = PAYLOAD_SIZES[s];
      const hops = CHAIN_LENGTHS[c];
      const iterations = iterationsFor(payloadBytes, hops);
      const key = `${payloadBytes}:${hops}`;

      console.error(`payload=${formatPayload(payloadBytes)} hops=${hops} iterations=${iterations}`);

      console.error('  (a) direct peer channel ...');
      results.peerChannel[key] = await benchmarkPeerChannel(payloadBytes, hops, iterations);
      console.error(`      p50=${fmtMs(results.peerChannel[key].chainP50Ms)}`);

      console.error('  (b) MCP stdio subprocess ...');
      results.stdio[key] = await benchmarkStdio(payloadBytes, hops, iterations);
      console.error(`      p50=${fmtMs(results.stdio[key].chainP50Ms)}`);

      console.error('  (c) localhost HTTP ...');
      results.http[key] = await benchmarkHttp(payloadBytes, hops, iterations);
      console.error(`      p50=${fmtMs(results.http[key].chainP50Ms)}`);
    }
  }

  const report = buildReport(results);
  console.log(`\n${report.table}\n`);
  console.log(`${report.summary}\n`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
