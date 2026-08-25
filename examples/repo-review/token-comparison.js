// The same repository review, done two ways, measured.
//
//   (a) STANDARD MCP ARCHITECTURE -- the client calls three independent tools
//       in sequence. Every intermediate result comes back to the client, and
//       the client hands it to the next tool. This is what an MCP client with
//       three separate servers has to do: the servers cannot see each other, so
//       the client is the only place composition can happen.
//
//   (b) COMPOSITE TOOL -- one call to repo-review, which runs the same three
//       tools in-process and returns only the aggregate.
//
// Both conditions run against the SAME server process, with the SAME four
// modules loaded, doing the SAME work. The only difference is where the
// composition happens, so the byte difference is attributable to that and
// nothing else.
//
// WHAT IS MEASURED
//
//   responseBytes  bytes of JSON-RPC response body received by the client.
//                  This is the number that matters: it is what an MCP client
//                  puts into a model's context.
//   requestBytes   bytes of JSON-RPC request body sent by the client. In (a)
//                  the client must send the previous tool's output back down as
//                  the next tool's arguments, so this is not negligible -- and
//                  for a real model client it is worse than measured here,
//                  since a model would have to re-emit two megabytes of source
//                  token by token. This script just copies the object, which is
//                  the most charitable possible version of (a).
//   wallMs         end-to-end wall time for the whole condition, client side.
//
// TOKENS ARE ESTIMATED, NOT COUNTED. There is no tokenizer here and no network
// call to one. The estimate is bytes / 4, the usual rule of thumb for English
// text and source code. It is reported as an order-of-magnitude figure to make
// the byte counts legible, and the ratio between the two conditions -- which is
// what the comparison rests on -- does not depend on the divisor at all.
//
// TWO THINGS THAT WORK AGAINST CONDITION (b), STATED SO THEY ARE NOT MISTAKEN
// FOR MEASUREMENT ERROR:
//   - repo-review serializes every hop payload purely to fill in its dataFlow
//     report. That is real CPU spent on measurement that condition (a) never
//     pays, so (b)'s wall time here is pessimistic.
//   - MCP responses carry the payload twice, once as `structuredContent` and
//     once serialized into `content[0].text`. Both conditions pay that, so it
//     cancels out of the ratio, but it does inflate both absolute figures.
//
// METHODOLOGY -- matches perf/cross-process-comparison.js:
//   - one warm-up iteration before measuring, outside the sampled region
//   - report the median of per-iteration totals, plus the sample count
//   - THE COMPARISON SUMMARY IS GENERATED FROM THE MEASURED NUMBERS. Same rule
//     as the perf/ scripts, for the same reason: a hand-written summary in a
//     README drifts from the table beside it. Prose in
//     examples/repo-review/README.md may only quote numbers this script
//     printed, copy-pasted from a real run.
//
// Usage: node examples/repo-review/token-comparison.js
// Starts its own countinghouse on port 9595 with the four demo modules, runs
// both conditions, prints a markdown table + generated summary, then raw JSON.
// Needs a running Redis (metering); takes about a minute.
const cp    = require('child_process');
const http  = require('http');
const path  = require('path');

const PORT       = 9595;
const HOST       = '127.0.0.1';
const API_KEY    = 'token-comparison-demo';
const ITERATIONS = 5;
const REPO_ROOT  = path.resolve(__dirname, '..', '..');

// Bytes per token. A rule of thumb, not a tokenizer -- see the header.
const BYTES_PER_TOKEN = 4;

const TOOL_SCAN    = 'repo_scan_scanservice_scan';
const TOOL_DETECT  = 'secret_detect_detectservice_detect';
const TOOL_AUDIT   = 'dep_audit_auditservice_audit';
const TOOL_REVIEW  = 'repo_review_reviewservice_review';

const MODULES = ['repo-scan', 'secret-detect', 'dep-audit', 'repo-review'];

// --------------------------- server lifecycle ----------------------------
// --debug on purpose: condition (a) has to call the three inner tools directly,
// which on a real deployment they would not be exposed for (see the README --
// granting the caller only the composite device is what makes repo-review the
// only visible tool). Running both conditions against one permissive server is
// what keeps the comparison apples-to-apples.
function startServer() {
  const args = ['./framework.js', '--workerThread', '--debug', '--bindAddr', HOST,
                '--port', String(PORT), '--mcpToolCallCost', '1'];
  MODULES.forEach((m) => { args.push('--loadModule', `./examples/repo-review/${m}`); });

  const child = cp.spawn(process.execPath, args, {cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe']});
  // Buffered rather than discarded (resume()'d): waitForAllModulesDiscovered
  // below needs to read it back.
  child.log = '';
  child.stdout.on('data', (c) => { child.log += c.toString(); });
  child.stderr.on('data', (c) => { child.log += c.toString(); });
  return child;
}

// repo-review is this repo's first module to declare "countinghouse.calls" --
// composition binding (DeviceManager.prototype.verifyComposition) does its own
// async work (a queryDevice resolution plus an authenticate() round trip per
// declared address, then under --workerThread a further main<->worker relay)
// AFTER a device is already visible in tools/list and callable for its own
// action, but BEFORE ctx.call inside it has anything to call through. Waiting
// on tools/list alone (as waitForReady below does) races that: repo-review can
// appear ready and still reject its first call with "ctx.call is unavailable".
// test/composition/03-declaration.js hit the same ordering and waits for the
// server's own "all module discovered" log line plus a settle buffer instead
// -- same fix, here.
function waitForAllModulesDiscovered(child, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      if (/all module discovered/i.test(child.log)) return setTimeout(resolve, 2500);
      if (Date.now() > deadline) return reject(new Error('"all module discovered" never appeared in server output'));
      setTimeout(poll, 100);
    })();
  });
}

// Poll tools/list until every demo module is registered, rather than sleeping a
// fixed number of seconds: module load time varies with machine and with how
// many workers are starting, and a fixed sleep either wastes time or races.
function waitForReady(deadlineMs) {
  const deadline = Date.now() + deadlineMs;

  return new Promise((resolve, reject) => {
    (function poll() {
      rpc('tools/list', {}).then((res) => {
        const names = (res.body.result != null && Array.isArray(res.body.result.tools))
                        ? res.body.result.tools.map((t) => t.name) : [];
        const ready = [TOOL_SCAN, TOOL_DETECT, TOOL_AUDIT, TOOL_REVIEW].every((n) => names.indexOf(n) !== -1);
        if (ready) return resolve(names);
        if (Date.now() > deadline) return reject(new Error(`only ${JSON.stringify(names)} registered before the deadline`));
        setTimeout(poll, 500);
      }).catch(() => {
        if (Date.now() > deadline) return reject(new Error('server never accepted a request'));
        setTimeout(poll, 500);
      });
    })();
  });
}

// --------------------------- transport -----------------------------------
// Byte counts come off the wire (the request body written, the response chunks
// received), not off a re-serialization of the parsed object, so what is
// reported is what actually crossed the socket.
let nextId = 1;

function rpc(method, params) {
  const body  = Buffer.from(JSON.stringify({jsonrpc: '2.0', id: nextId++, method: method, params: params}), 'utf8');

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST, port: PORT, method: 'POST', path: '/mcp',
      headers: {'Content-Type': 'application/json', 'X-CH-Key': API_KEY, 'Content-Length': body.length}
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (c) => { chunks.push(c); bytes += c.length; });
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let parsed;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch (e) {
          return reject(new Error(`non-JSON response (${bytes} bytes): ${raw.toString('utf8').slice(0, 200)}`));
        }
        resolve({body: parsed, responseBytes: bytes, requestBytes: body.length});
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function callTool(name, args) {
  return rpc('tools/call', {name: name, arguments: args}).then((res) => {
    const result = res.body.result;
    if (res.body.error != null) throw new Error(`${name}: ${JSON.stringify(res.body.error)}`);
    if (result == null) throw new Error(`${name}: no result in response`);
    if (result.isError === true) throw new Error(`${name}: ${JSON.stringify(result).slice(0, 500)}`);
    return {
      output:        result.structuredContent.output,
      responseBytes: res.responseBytes,
      requestBytes:  res.requestBytes
    };
  });
}

// --------------------------- conditions ----------------------------------
const LOCKFILE_NAMES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock'];

// (a) Three independent tools, composed by the client. Every intermediate
// result round-trips through the client, which is the only thing this condition
// is meant to show.
async function conditionA(scanArgs) {
  const t0 = Date.now();
  const calls = [];

  const scan = await callTool(TOOL_SCAN, scanArgs);
  calls.push({tool: TOOL_SCAN, requestBytes: scan.requestBytes, responseBytes: scan.responseBytes});

  // The client now holds every file's full text and has to hand it onward.
  const detect = await callTool(TOOL_DETECT, {files: scan.output.files, maxFindings: 100});
  calls.push({tool: TOOL_DETECT, requestBytes: detect.requestBytes, responseBytes: detect.responseBytes});

  const manifest = scan.output.files.find((f) => f.path === 'package.json');
  const lock     = scan.output.files.find((f) => LOCKFILE_NAMES.indexOf(f.path) !== -1);
  if (manifest == null) throw new Error('condition (a): no package.json in the scan result');

  const audit = await callTool(TOOL_AUDIT, {
    manifest:     manifest.content,
    lockfile:     (lock != null) ? lock.content : null,
    lockfileName: (lock != null) ? lock.path : null
  });
  calls.push({tool: TOOL_AUDIT, requestBytes: audit.requestBytes, responseBytes: audit.responseBytes});

  return {
    wallMs:        Date.now() - t0,
    calls:         calls,
    toolCalls:     calls.length,
    requestBytes:  calls.reduce((a, c) => a + c.requestBytes, 0),
    responseBytes: calls.reduce((a, c) => a + c.responseBytes, 0),
    // Kept so the two conditions can be shown to have done the same work.
    work: {files: scan.output.fileCount, bytes: scan.output.byteCount,
           secretFindings: detect.output.findingCount, deps: audit.output.counts.total}
  };
}

// (b) One call. The same three tools run, in the same order, on the same data.
async function conditionB(reviewArgs) {
  const t0 = Date.now();
  const review = await callTool(TOOL_REVIEW, reviewArgs);
  const calls = [{tool: TOOL_REVIEW, requestBytes: review.requestBytes, responseBytes: review.responseBytes}];

  return {
    wallMs:        Date.now() - t0,
    calls:         calls,
    toolCalls:     1,
    requestBytes:  review.requestBytes,
    responseBytes: review.responseBytes,
    dataFlow:      review.output.dataFlow,
    bill:          review.output.bill,
    work: {files: review.output.findings.scanned.fileCount,
           bytes: review.output.findings.scanned.byteCount,
           secretFindings: review.output.findings.secrets.findingCount,
           deps: review.output.findings.dependencies.counts.total}
  };
}

// --------------------------- statistics ----------------------------------
function median(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return (sorted.length % 2 === 1) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarizeRuns(runs) {
  return {
    samples:       runs.length,
    toolCalls:     runs[0].toolCalls,
    requestBytes:  median(runs.map((r) => r.requestBytes)),
    responseBytes: median(runs.map((r) => r.responseBytes)),
    wallMsP50:     median(runs.map((r) => r.wallMs)),
    work:          runs[0].work
  };
}

// --------------------------- reporting -----------------------------------
function fmtBytes(n) {
  if (n == null) return 'n/a';
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function estTokens(bytes) {
  return Math.round(bytes / BYTES_PER_TOKEN);
}

function fmtTokens(bytes) {
  const t = estTokens(bytes);
  if (t >= 1000000) return `~${(t / 1000000).toFixed(2)}M`;
  if (t >= 1000)    return `~${(t / 1000).toFixed(1)}k`;
  return `~${t}`;
}

// Generated from the measured numbers -- never hand-written. See the header.
function buildReport(a, b, perCall) {
  const rows = [
    '| | (a) three separate tools | (b) one composite tool | ratio |',
    '|---|---|---|---|',
    `| MCP tool calls | ${a.toolCalls} | ${b.toolCalls} | ${(a.toolCalls / b.toolCalls).toFixed(0)}× |`,
    `| Response bytes (into model context) | ${fmtBytes(a.responseBytes)} | ${fmtBytes(b.responseBytes)} | **${(a.responseBytes / b.responseBytes).toFixed(0)}×** |`,
    `| Estimated response tokens | ${fmtTokens(a.responseBytes)} | ${fmtTokens(b.responseBytes)} | ${(a.responseBytes / b.responseBytes).toFixed(0)}× |`,
    `| Request bytes (out of model context) | ${fmtBytes(a.requestBytes)} | ${fmtBytes(b.requestBytes)} | ${(a.requestBytes / b.requestBytes).toFixed(0)}× |`,
    `| Total bytes across the MCP boundary | ${fmtBytes(a.requestBytes + a.responseBytes)} | ${fmtBytes(b.requestBytes + b.responseBytes)} | ${((a.requestBytes + a.responseBytes) / (b.requestBytes + b.responseBytes)).toFixed(0)}× |`,
    `| End-to-end wall time (p50) | ${a.wallMsP50.toFixed(0)} ms | ${b.wallMsP50.toFixed(0)} ms | ${(a.wallMsP50 / b.wallMsP50).toFixed(2)}× |`,
    `| Samples | ${a.samples} | ${b.samples} | |`
  ];

  const perCallRows = [
    '| Condition | Tool call | Request | Response |',
    '|---|---|---|---|'
  ];
  perCall.a.forEach((c) => perCallRows.push(`| (a) | \`${c.tool}\` | ${fmtBytes(c.requestBytes)} | ${fmtBytes(c.responseBytes)} |`));
  perCall.b.forEach((c) => perCallRows.push(`| (b) | \`${c.tool}\` | ${fmtBytes(c.requestBytes)} | ${fmtBytes(c.responseBytes)} |`));

  const sameWork = JSON.stringify(a.work) === JSON.stringify(b.work);
  const responseRatio = a.responseBytes / b.responseBytes;
  const savedBytes    = a.responseBytes - b.responseBytes;

  const summary = [];

  summary.push(`**Same work, checked rather than assumed**: both conditions reported ${
    a.work.files} files / ${a.work.bytes} bytes scanned, ${a.work.secretFindings} credential finding(s) and ${
    a.work.deps} declared dependencies. ${sameWork ? 'The two work descriptors are identical.'
      : `MISMATCH -- (a) ${JSON.stringify(a.work)} vs (b) ${JSON.stringify(b.work)}; the comparison below is not valid.`}`);

  summary.push(`**Context cost**: the client received ${fmtBytes(a.responseBytes)} across ${
    a.toolCalls} calls in (a) and ${fmtBytes(b.responseBytes)} in one call in (b) -- ${
    responseRatio.toFixed(0)}× less. That is ${savedBytes} bytes, an estimated ${fmtTokens(savedBytes)
    } tokens, that never entered a model context. The source code is the whole of the difference: it was read and analysed in both conditions, and only in (b) did it stay inside the server.`);

  summary.push(`**Latency**: (b) took ${b.wallMsP50.toFixed(0)}ms at p50 against (a)'s ${a.wallMsP50.toFixed(0)}ms (${
    (a.wallMsP50 / b.wallMsP50).toFixed(2)}×). Both numbers are dominated by the tools' own work -- reading and regex-scanning ${
    fmtBytes(a.work.bytes)} of source -- not by the transport, and (b) additionally pays for serializing every hop payload to build its dataFlow report. ` +
    'Treat the byte column as the result of this benchmark and the latency column as context for it.');

  summary.push(`**What (a) is charitable about**: its ${fmtBytes(a.requestBytes)} of request body is this script copying an object in memory. A model client would have to emit those bytes as tool-call arguments, token by token, before the second and third calls could happen at all.`);

  return {table: rows.join('\n'), perCall: perCallRows.join('\n'), summary: summary.join('\n\n')};
}

// --------------------------- main ----------------------------------------
async function main() {
  console.error(`starting countinghouse on ${HOST}:${PORT} with ${MODULES.join(', ')} ...`);
  const server = startServer();

  const shutdown = () => { try { server.kill('SIGKILL'); } catch (e) { /* already gone */ } };
  process.on('exit', shutdown);

  try {
    await waitForAllModulesDiscovered(server, 60000);
    await waitForReady(60000);
    console.error('all four tools registered.\n');

    // Identical arguments to both conditions: whatever repo-scan's defaults are,
    // both sides get them, so neither can be reading a different tree.
    const scanArgs = {};

    console.error('warm-up (not measured) ...');
    await conditionA(scanArgs);
    await conditionB(scanArgs);

    const runsA = [];
    const runsB = [];
    for (let i = 0; i < ITERATIONS; i++) {
      console.error(`iteration ${i + 1}/${ITERATIONS} ...`);
      const a = await conditionA(scanArgs);
      const b = await conditionB(scanArgs);
      console.error(`  (a) ${fmtBytes(a.responseBytes)} in ${a.wallMs}ms   (b) ${fmtBytes(b.responseBytes)} in ${b.wallMs}ms`);
      runsA.push(a);
      runsB.push(b);
    }

    const a = summarizeRuns(runsA);
    const b = summarizeRuns(runsB);
    const report = buildReport(a, b, {a: runsA[runsA.length - 1].calls, b: runsB[runsB.length - 1].calls});

    console.log(`\n${report.table}\n`);
    console.log(`${report.perCall}\n`);
    console.log(`${report.summary}\n`);
    console.log(JSON.stringify({
      conditionA: a,
      conditionB: b,
      lastRun: {
        aCalls:   runsA[runsA.length - 1].calls,
        bCalls:   runsB[runsB.length - 1].calls,
        dataFlow: runsB[runsB.length - 1].dataFlow,
        bill:     runsB[runsB.length - 1].bill
      },
      bytesPerTokenEstimate: BYTES_PER_TOKEN
    }, null, 2));
  } finally {
    shutdown();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
