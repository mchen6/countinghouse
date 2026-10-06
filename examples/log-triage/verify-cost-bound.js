// The check behind log-triage's headline claim: the bill follows the input,
// and the caller's own cap bounds it.
//
// Runs non-debug and multi-tenant -- under --debug every key resolves to an
// admin session and neither half of the authorize/bill split is observable
// (same reasoning as examples/repo-review/verify-identity-passthrough.js).
// The whole sequence runs twice, once per hop path, because the two paths
// meter in different places (docs/composite-tools.md, "billing authority").
//
// For N files read, the composite makes 2N + 2 inner hops (one list, a read
// and a redact per file, one cluster) and the caller pays 2N + 3 with the
// outer call. The read-then-redact chains run concurrently, so this is also
// the check that concurrent hops are each charged exactly once.
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const spawn   = require('child_process').spawn;
const request = require('supertest');

const gen = require('./generate-logs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const TRIAGE_DEVICE  = 'dad07d2a-9d65-5ef5-af59-05c0160c5fdc';
const READ_DEVICE    = 'fd0eafbd-20da-53e6-9302-681687350a3b';
const REDACT_DEVICE  = 'b5048beb-2128-52c0-9cd4-42669f57090f';
const CLUSTER_DEVICE = '9f9aab37-b175-5286-81c3-68bdd24bd4f7';

const AS_IDENTITY = 'log-triage-internal';
const TOOL        = 'log_triage_triageservice_triage';
const FILE_COUNT  = 8;

const PATHS = [
  {label: 'main-thread-routed', port: 9596, flags: []},
  {label: 'directPeerChannels', port: 9597, flags: ['--directPeerChannels']}
];

// The server child currently running, and the temp root: both are cleaned up
// on SIGINT/SIGTERM so an interrupted run leaves nothing behind.
let currentServer = null;
let tempRoot      = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer(port, authPath, flags) {
  return new Promise((resolve, reject) => {
    const args = [path.join(REPO_ROOT, 'framework.js'),
      '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(port),
      '--authProvider', 'file', '--authConfigPath', authPath, '--mcpToolCallCost', '1',
      '--loadModule', path.join(__dirname, 'log-read'),
      '--loadModule', path.join(__dirname, 'pii-redact'),
      '--loadModule', path.join(__dirname, 'error-cluster'),
      '--loadModule', path.join(__dirname, 'log-triage')].concat(flags);

    const server = spawn(process.execPath, args, {cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    currentServer = server;   // visible to the signal handler from the first moment
    let out = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.kill('SIGKILL');
      reject(new Error(`server on ${port} never finished discovery:\n${out.slice(-2000)}`));
    }, 60000);

    // A child that dies before it is ready fails the start at once.
    server.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server on ${port} exited before it was ready (code=${code} signal=${signal}):\n${out.slice(-2000)}`));
    });

    const onData = (buf) => {
      out += buf.toString();
      // Composition is verified after discovery completes and the verdict is
      // then relayed into the composing module's worker, so "all module
      // discovered" is the earliest useful signal, not the finish line.
      if (!settled && /all module discovered/i.test(out)) {
        settled = true;
        clearTimeout(timer);
        setTimeout(() => resolve(server), 2500);
      }
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
  });
}

async function balanceOf(url, key) {
  const res = await request(url).get('/balance').set('X-CH-Key', key);
  return (res.body != null) ? res.body.balance : null;
}

// The outer call's own charge is fire-and-forget, so a balance is read only
// once it has stopped moving -- never polled until an expected number shows
// up, which would let an extra charge hide behind an early match.
async function settledBalance(url, key) {
  const deadline = Date.now() + 20000;
  let last = null;
  let stable = 0;

  while (Date.now() < deadline) {
    const balance = await balanceOf(url, key);
    stable = (last !== null && balance === last) ? stable + 1 : 1;
    last   = balance;
    if (stable >= 3) return balance;
    await sleep(200);
  }
  throw new Error(`balance for ${key} never settled (last ${last})`);
}

async function listTools(url, key) {
  const res = await request(url).post('/mcp')
    .set('Content-Type', 'application/json').set('X-CH-Key', key)
    .send({jsonrpc: '2.0', id: 9, method: 'tools/list'});
  return res.body.result.tools.map((t) => t.name);
}

async function triage(url, key, args) {
  const res = await request(url).post('/mcp')
    .set('Content-Type', 'application/json').set('X-CH-Key', key)
    .send({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: TOOL, arguments: args}});
  const result = (res.body != null) ? res.body.result : null;

  assert.ok(result != null, `no result: ${JSON.stringify(res.body).slice(0, 800)}`);
  assert.strictEqual(result.isError, false, `call errored: ${JSON.stringify(result).slice(0, 1500)}`);
  return result;
}

// One call, with the caller's and the module identity's balances read before
// and after. Returns what the call returned and what each identity paid.
async function meteredCall(url, caller, args) {
  const callerBefore   = await settledBalance(url, caller);
  const internalBefore = await settledBalance(url, AS_IDENTITY);

  const result = await triage(url, caller, args);

  const callerAfter   = await settledBalance(url, caller);
  const internalAfter = await settledBalance(url, AS_IDENTITY);

  return {
    result:       result,
    out:          result.structuredContent.output,
    callerPaid:   callerBefore - callerAfter,
    internalPaid: internalBefore - internalAfter
  };
}

async function verifyPath(p, dirs) {
  const url      = `http://127.0.0.1:${p.port}`;
  const caller   = `caller-triage-${p.label}-${process.pid}`;
  const authPath = path.join(dirs.root, `auth-${p.label}.json`);

  // The caller is granted the composite device ONLY; the module identity is
  // granted the three inner devices and bound to the module by "runsModules".
  const config = {};
  config[caller]      = {userName: 'caller', devices: [TRIAGE_DEVICE]};
  config[AS_IDENTITY] = {userName: AS_IDENTITY, devices: [READ_DEVICE, REDACT_DEVICE, CLUSTER_DEVICE],
                         runsModules: ['log-triage']};
  fs.writeFileSync(authPath, JSON.stringify(config, null, 2));

  console.log(`\n=== ${p.label} (port ${p.port}) ===`);
  const server = await startServer(p.port, authPath, p.flags);

  try {
    const tools = (await listTools(url, caller)).filter((n) => n !== 'countinghouse_check_balance');
    assert.deepStrictEqual(tools, [TOOL], 'only the composite must be visible to the caller');
    console.log(`[1] tools/list for the caller: ${JSON.stringify(tools)}`);

    // maxFiles 32 is more than the 8 files present: hops must follow the
    // files actually read, not the cap.
    for (const c of [{maxFiles: 1, n: 1}, {maxFiles: 3, n: 3}, {maxFiles: 8, n: 8}, {maxFiles: 32, n: 8}]) {
      const m    = await meteredCall(url, caller, {dir: dirs.logs, maxFiles: c.maxFiles});
      const hops = 2 * c.n + 2;

      assert.strictEqual(m.out.cost.filesRead, c.n);
      assert.strictEqual(m.out.cost.hops, hops, `maxFiles=${c.maxFiles}: expected ${hops} hops`);
      assert.strictEqual(m.out.bill.length, hops);
      assert.strictEqual(m.out.cost.charged, hops);
      assert.strictEqual(m.out.cost.worstCaseHops, 2 * c.maxFiles + 2);
      assert.deepStrictEqual(m.out.bill.map((b) => b.hop), Array.from({length: hops}, (_, i) => i + 1));
      m.out.bill.forEach((b) => {
        assert.strictEqual(b.charged, 1, `hop ${b.hop} must be charged exactly once`);
        assert.strictEqual(b.billedTo, caller, `hop ${b.hop} must be billed to the outer caller`);
        assert.strictEqual(b.authorizedAs, AS_IDENTITY);
      });

      // Concurrent hops each get their own running balance: none repeated.
      const balances = m.out.bill.map((b) => b.balance);
      assert.strictEqual(new Set(balances).size, hops, `per-hop balances repeat: ${JSON.stringify(balances)}`);

      // The bill is ordered by position, not by completion time.
      const expectedNames = dirs.names.slice(0, c.n);
      const expectedTools = ['log-read/list']
        .concat(...expectedNames.map(() => ['log-read/read', 'pii-redact/redact']))
        .concat('error-cluster/cluster');
      assert.deepStrictEqual(m.out.bill.map((b) => b.tool), expectedTools,
        `maxFiles=${c.maxFiles}: bill order`);
      assert.deepStrictEqual(m.out.findings.files.read.map((f) => f.name), expectedNames,
        `maxFiles=${c.maxFiles}: files read, in name order`);
      if (c.maxFiles === 3) {
        assert.deepStrictEqual(m.out.findings.files.skipped, dirs.names.slice(3));
      }

      assert.strictEqual(m.out.findings.files.read.length, c.n);
      assert.strictEqual(m.out.findings.files.skipped.length, FILE_COUNT - c.n);
      assert.strictEqual(m.callerPaid, hops + 1, `maxFiles=${c.maxFiles}: caller must pay ${hops + 1}`);
      assert.strictEqual(m.internalPaid, 0, 'the module identity must not be billed');

      // Nothing planted may come back, anywhere in the response.
      const serialized = JSON.stringify(m.result);
      for (const value of gen.allPlantedValues()) {
        assert.ok(!serialized.includes(value), `planted value leaked into the response: ${value}`);
      }
      assert.ok(m.out.findings.pii.total > 0, 'the sample logs hold PII, so some must have been masked');
      assert.ok(m.out.findings.clusters.length > 0);

      console.log(`[2] maxFiles=${String(c.maxFiles).padEnd(2)} files read=${c.n} skipped=${FILE_COUNT - c.n} ` +
                  `hops=${hops} caller paid=${m.callerPaid} module identity paid=${m.internalPaid}`);
    }

    const empty = await meteredCall(url, caller, {dir: dirs.empty});
    assert.strictEqual(empty.out.cost.hops, 1);
    assert.strictEqual(empty.out.bill[0].tool, 'log-read/list');
    assert.deepStrictEqual(empty.out.findings.clusters, []);
    assert.strictEqual(empty.out.findings.pii.total, 0);
    assert.strictEqual(empty.callerPaid, 2);
    assert.strictEqual(empty.internalPaid, 0);
    console.log(`[3] empty directory: hops=1 caller paid=${empty.callerPaid}`);
  } finally {
    server.kill('SIGKILL');
    currentServer = null;
    await sleep(1500);
  }
}

function cleanupAndExit() {
  if (currentServer != null) currentServer.kill('SIGKILL');
  if (tempRoot != null) fs.rmSync(tempRoot, {recursive: true, force: true});
  process.exit(130);
}
process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'log-triage-verify-'));
  const dirs = {root: root, logs: path.join(root, 'logs'), empty: path.join(root, 'empty'), names: []};
  tempRoot = root;

  let failed = null;
  try {
    gen.generate({dir: dirs.logs, files: FILE_COUNT, lines: 200, seed: 1});
    fs.mkdirSync(dirs.empty);
    dirs.names = fs.readdirSync(dirs.logs).filter((n) => n.endsWith('.log')).sort();
    assert.strictEqual(dirs.names.length, FILE_COUNT);

    for (const p of PATHS) await verifyPath(p, dirs);
    console.log('\nRESULT: on both hop paths the caller paid 2N + 3 for N files, the cap held, ' +
                'the module identity paid nothing, and no planted value was returned.');
  } catch (e) {
    failed = e;
    console.error('\nFAIL:', e);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
  process.exit(failed == null ? 0 : 1);
})();
