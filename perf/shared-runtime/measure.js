// The shared runtime against separate ones (Validation 1, 2026-11-14;
// perf/shared-runtime/README.md): N MCP client sessions, each with its own
// runtime (the command `ch-local start --stdio` builds), against ONE
// countinghouse on loopback HTTP with one API key per session. Pack 1 as
// installed (0.4.0 or later), its GitHub remote sent to a local stub
// (github-stub.js) by --remoteOriginMap under COUNTINGHOUSE_ACCEPTANCE=1, with
// a token made at run time: every call runs the scenario's 11 hops between the
// pack's real modules and the runtime's remote path, offline, with no --debug
// (it bypasses the auth provider). Per configuration: process RSS (the
// layout's total), per-session first-call and warm-call latency, startup; for
// the shared layout, each session's own usage report and an admin's view by
// caller. Keys and the token are made here, at random, written only to a
// temporary auth file (mode 0600) or a child's environment, and no output
// carries one.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {testPort} = require('../../test/helpers/test-env');
const {startGithubStub} = require('./github-stub');

const ROOT = path.join(__dirname, '..', '..');
const SERVICE_TOOL = /ci_failure_triage/;
const ARGS = {repo: 'acme/widgets'};
const WARM = 5;
const PORT = testPort(9751);
const MIN_PACK = [0, 4, 0];
// the pack's GitHub remote: its declared origin, the credential's variable
function githubRemoteOf(pack) {
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(pack), 'ch-access-github', 'package.json'), 'utf8'));
  const remote = ((pkg.countinghouse || {}).remotes || []).find((r) => r.name === 'github');
  if (remote == null) throw new Error('ch-access-github declares no github remote: give an installed pack, not a stand-in');
  return {origin: new URL(remote.url).origin, variable: remote.credential.env};
}
function checkPackVersion(pack) {
  const v = JSON.parse(fs.readFileSync(path.join(pack, 'package.json'), 'utf8')).version;
  const parts = String(v).split(/[.+-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i] > MIN_PACK[i]) return v;
    if (parts[i] < MIN_PACK[i]) throw new Error(`pack 1 ${v}: 0.4.0 or later is needed (0.1.0's scenario output fails its own schema, coverage.historyRebuilt)`);
  }
  return v;
}

function parseArgs(argv) {
  const o = {runtime: ROOT, pack: null, runs: 1, sessions: [1, 3, 6, 10], layouts: ['separate', 'shared'], json: null, withParts: false};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runtime') o.runtime = path.resolve(argv[++i]);
    else if (a === '--pack') o.pack = path.resolve(argv[++i]);
    else if (a === '--runs') o.runs = Number(argv[++i]);
    // ascending: the memory guard's estimate comes from the first measured
    else if (a === '--sessions') o.sessions = argv[++i].split(',').map(Number).sort((x, y) => x - y);
    else if (a === '--layouts') o.layouts = argv[++i].split(',');
    else if (a === '--json') o.json = path.resolve(argv[++i]);
    // a runtime that loads only the scenario in multi-key mode (7.1.2): its
    // parts are loaded too, each by --loadModule, in the shared layout
    else if (a === '--withParts') o.withParts = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.pack == null) throw new Error('give --pack <installed scenario dir>');
  return o;
}

// A process gone (crashed, killed) is never counted as 0 MB: the row fails.
const rssOf = (pid) => {
  let text = null;
  try { text = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); } catch (e) { text = null; }
  const m = (text == null) ? null : /VmRSS:\s+(\d+) kB/.exec(text);
  if (m == null) throw new Error(`process ${pid} is gone: its RSS cannot be read`);
  return Number(m[1]) / 1024;
};
const rssSum = (pids) => pids.reduce((s, p) => s + rssOf(p), 0);
const median = (a) => { if (a.length === 0) return null; const x = [...a].sort((p, q) => p - q); const m = Math.floor(x.length / 2); return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the directories a runtime gets, under one temporary root (shared by every
// runtime of a layout, as ch-local's home is shared by its sessions)
function dirsUnder(root, github) {
  const d = {store: path.join(root, 'store'), modules: path.join(root, 'modules'), moduleData: path.join(root, 'module_data'),
    config: path.join(root, 'config'), rc: path.join(root, 'remote-credentials.json')};
  for (const k of ['modules', 'moduleData', 'config']) fs.mkdirSync(d[k], {recursive: true});
  // the token's variable may go to the declared origin only (lib/remote/credentials.js)
  fs.writeFileSync(d.rc, `${JSON.stringify({[github.origin]: [github.variable]})}\n`);
  return d;
}
// The stub stands in for the declared origin (acceptance runs only: the
// runtime activates the map only with COUNTINGHOUSE_ACCEPTANCE=1).
const commonArgs = (d, pack, github, stubPort) => ['--workerThread', '--store', 'local', '--storePath', d.store, '--moduleSandbox', 'enforce',
  '--modulePath', d.modules, '--moduleDataPath', d.moduleData, '--remoteCredentials', d.rc, '--deviceConfigPath', d.config,
  '--remoteOriginMap', `${github.origin}=http://127.0.0.1:${stubPort}`, '--loadModule', pack];

function child(file, args, env) {
  const c = spawn(process.execPath, [file].concat(args), {stdio: ['pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, env || {})});
  c.out = ''; c.err = '';
  c.stdout.on('data', (b) => { c.out += b; });
  c.stderr.on('data', (b) => { c.err += b; });
  c.readyAt = null;
  const look = () => { if (c.readyAt == null && /countinghouse ready/.test(c.err + c.out)) c.readyAt = Date.now(); };
  c.stdout.on('data', look); c.stderr.on('data', look);
  return c;
}
const killAll = (cs) => { for (const c of cs) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } } };

// A newline JSON-RPC client over a stdio runtime: lines parsed once, as they
// arrive, and matched to the pending request by id.
function stdioClient(c) {
  let id = 0;
  let buffered = '';
  const pending = new Map();
  c.stdout.on('data', (b) => {
    buffered += b;
    let nl;
    while ((nl = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      let msg = null;
      try { msg = JSON.parse(line); } catch (e) { msg = null; }
      const p = (msg != null && msg.id != null) ? pending.get(msg.id) : null;
      if (p != null) { pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg); }
    }
  });
  return (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); reject(new Error(`stdio: no answer to ${method} in 120 s; ${c.err.slice(-400)}`)); }, 120000);
    pending.set(n, {resolve, timer});
    c.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: n, method, params})}\n`);
  });
}
// A JSON-RPC client over the shared server's /mcp, one key.
function httpClient(key) {
  let id = 0;
  return (method, params) => new Promise((resolve, reject) => {
    const body = JSON.stringify({jsonrpc: '2.0', id: ++id, method, params});
    const req = http.request({host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', headers: {'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream', 'X-CH-Key': key, 'Content-Length': Buffer.byteLength(body)}}, (res) => {
      let data = '';
      res.on('data', (b) => { data += b; });
      res.on('end', () => {
        try {
          const sse = /text\/event-stream/.test(String(res.headers['content-type'] || ''));
          const line = sse ? data.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('') : data;
          resolve(JSON.parse(line));
        } catch (e) { reject(new Error(`http: ${method}: not JSON (${res.statusCode}): ${data.slice(0, 200)}`)); }
      });
    });
    req.setTimeout(120000, () => req.destroy(new Error(`http: no answer to ${method} in 120 s`)));
    req.on('error', reject);
    req.end(body);
  });
}

// One session: initialize, list, the first call, WARM more, its own report.
async function session(call) {
  await call('initialize', {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: 'shared-runtime-measure', version: '0'}});
  const list = await call('tools/list', {});
  const tool = ((list.result && list.result.tools) || []).map((t) => t.name).find((n) => SERVICE_TOOL.test(n));
  if (tool == null) throw new Error(`no ci_failure_triage tool listed: ${JSON.stringify(list).slice(0, 300)}`);
  const timed = async () => {
    const t = process.hrtime.bigint();
    const r = await call('tools/call', {name: tool, arguments: ARGS});
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    const ok = r.result != null && r.result.isError !== true;
    const text = ok ? null : String(((r.result && r.result.content && r.result.content[0] && r.result.content[0].text) || (r.error && r.error.message) || '')).slice(0, 400);
    return {ms, ok, text, code: ok ? null : ((r.result && r.result._meta && r.result._meta['countinghouse/code']) || (r.error && r.error.message) || 'error')};
  };
  const first = await timed();
  return {first, rest: async () => {
    const warm = [];
    for (let i = 0; i < WARM; i++) warm.push(await timed());
    const report = await call('tools/call', {name: 'countinghouse_usage_report', arguments: {}});
    return {warm, report};
  }};
}

const callsIn = (report) => {
  const r = report && report.result;
  if (r == null || r.isError === true) return null;
  const s = r.structuredContent || (() => { try { return JSON.parse(r.content[0].text); } catch (e) { return null; } })();
  if (s == null) return null;
  const total = s.total || s.totals || null;
  return (total != null && Number.isFinite(total.calls)) ? total.calls : null;
};

const exited = (c) => c.exitCode != null || c.signalCode != null;
async function untilReady(procs, what) {
  for (let w = 0; procs.some((c) => c.readyAt == null) && w < 180000; w += 50) {
    if (procs.some(exited)) throw new Error(`${what}: a runtime ended (${procs.filter(exited).map((c) => c.signalCode || `exit ${c.exitCode}`).join(', ')}): ${procs.map((c) => c.err.slice(-300)).join(' | ')}`);
    await sleep(50);
  }
  if (procs.some((c) => c.readyAt == null)) throw new Error(`${what}: not ready in 180 s`);
}

async function once(o, layout, n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-runtime-'));
  const d = dirsUnder(root, o.github);
  const procs = [];
  // the remote's token, made here; only the runtimes' environment carries it
  const env = {COUNTINGHOUSE_ACCEPTANCE: '1', [o.github.variable]: `measure-${crypto.randomBytes(16).toString('hex')}`};
  const args = () => commonArgs(d, o.pack, o.github, o.stub.port);
  try {
    let clients;
    let pids;
    let keys = null;
    let t0 = Date.now();
    if (layout === 'separate') {
      const file = path.join(o.runtime, 'bin', 'countinghouse-stdio.js');
      // The store as ch-local's home has it in steady state: one runtime
      // starts first and makes its identity secret, so N fresh ones do not
      // race to (lib/identity.js). Not timed.
      const first = child(file, args(), env);
      try { await untilReady([first], 'separate (preparing the store)'); } finally { first.kill('SIGKILL'); }
      await sleep(300);
      t0 = Date.now();
      for (let i = 0; i < n; i++) procs.push(child(file, args(), env));
      clients = procs.map((c) => stdioClient(c));
      pids = () => procs.map((c) => c.pid);
    } else {
      keys = Array.from({length: n}, (_, i) => `session-${i}-${crypto.randomBytes(16).toString('hex')}`);
      const admin = `admin-${crypto.randomBytes(16).toString('hex')}`;
      const internal = `internal-${crypto.randomBytes(16).toString('hex')}`;
      const auth = {};
      keys.forEach((k, i) => { auth[k] = {userName: `session-${i}`, devices: ['*']}; });
      auth[admin] = {userName: 'measure-admin', devices: ['*'], admin: true};
      // the scenario by its package name (current runtimes) and its device name (7.1.2)
      const scenario = JSON.parse(fs.readFileSync(path.join(o.pack, 'package.json'), 'utf8')).name;
      const device = JSON.parse(fs.readFileSync(path.join(o.pack, 'api.json'), 'utf8')).device.friendlyName;
      auth[internal] = {userName: 'pack-internal', devices: ['*'], runsModules: [...new Set([scenario, device])]};
      const authFile = path.join(root, 'auth.json');
      fs.writeFileSync(authFile, JSON.stringify(auth), {mode: 0o600});
      const parts = o.withParts ? [...new Set(((JSON.parse(fs.readFileSync(path.join(o.pack, 'package.json'), 'utf8')).countinghouse || {}).calls || [])
        .map((c) => String(c).split('/')[0]))].map((n) => path.join(path.dirname(o.pack), n)) : [];
      procs.push(child(path.join(o.runtime, 'framework.js'), ['--bindAddr', '127.0.0.1', '--port', String(PORT), '--authProvider', 'file', '--authConfigPath', authFile]
        .concat(args(), ...parts.map((p) => ['--loadModule', p])), env));
      clients = keys.map((k) => httpClient(k));
      clients.admin = httpClient(admin);
      pids = () => [procs[0].pid];
    }
    await untilReady(procs, layout);
    const startup = Math.max(...procs.map((c) => c.readyAt)) - t0;
    const rssReady = rssSum(pids());
    // every session at once
    const sessions = await Promise.all(clients.map((call) => session(call)));
    await sleep(1500);
    const rssFirst = rssSum(pids());
    const later = await Promise.all(sessions.map((s) => s.rest()));
    await sleep(1500);
    const rssWarm = rssSum(pids());
    const firsts = sessions.map((s) => s.first);
    const warms = later.flatMap((l) => l.warm);
    const out = {layout, n, startupMs: startup, rssReadyMb: r1(rssReady), rssAfterFirstMb: r1(rssFirst), rssAfterWarmMb: r1(rssWarm),
      firstMs: {median: r1(median(firsts.map((f) => f.ms))), max: r1(Math.max(...firsts.map((f) => f.ms)))},
      warmMs: {median: r1(median(warms.map((w) => w.ms))), max: r1(Math.max(...warms.map((w) => w.ms)))},
      failed: firsts.concat(warms).filter((x) => !x.ok).map((x) => x.code),
      firstFailure: (firsts.concat(warms).find((x) => !x.ok) || {}).text || null};
    // identity: each session's own report counts its own calls; an admin's
    // report groups every caller by opaque id
    out.ownCalls = later.map((l) => callsIn(l.report));
    if (layout === 'shared') {
      const r = await clients.admin('tools/call', {name: 'countinghouse_usage_report', arguments: {groupBy: 'module'}});
      const s = r.result && (r.result.structuredContent || (() => { try { return JSON.parse(r.result.content[0].text); } catch (e) { return null; } })());
      const callers = new Set(((s && s.groups) || []).map((g) => g.caller).filter((c) => typeof(c) === 'string'));
      out.adminDistinctCallers = callers.size;
    }
    return out;
  } finally {
    killAll(procs);
    await sleep(300);
    fs.rmSync(root, {recursive: true, force: true});
  }
}

const memAvailableMb = () => {
  const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
  return (m == null) ? 0 : Number(m[1]) / 1024;
};

async function main(argv) {
  const o = parseArgs(argv);
  if (!fs.existsSync('/proc/self/status')) throw new Error('reads /proc: Linux only');
  o.packVersion = checkPackVersion(o.pack);
  o.github = githubRemoteOf(o.pack);
  o.stub = await startGithubStub();
  try {
    return await measure(o);
  } finally {
    o.stub.close();
  }
}

async function measure(o) {
  const rows = [];
  for (const layout of o.layouts) {
    let perRuntimeMb = null;
    for (const n of o.sessions) {
      // A separate layout is N whole runtimes: skipped, and said so, when the
      // machine lacks the memory for them (N times one runtime's RSS after its
      // warm calls, from the first separate configuration measured, whatever
      // its N; 10% more, and 400 MB of headroom); a run that swaps would
      // measure the swap. Before any separate row is measured there is no
      // estimate: put the smallest N first.
      if (layout === 'separate' && perRuntimeMb != null) {
        const need = n * perRuntimeMb * 1.1 + 400;
        const avail = memAvailableMb();
        if (need > avail) {
          const row = {layout, n, skipped: `needs about ${Math.round(need)} MB, ${Math.round(avail)} MB available`, perRuntimeMb: r1(perRuntimeMb)};
          rows.push(row);
          process.stdout.write(`${layout.padEnd(8)} N=${String(n).padStart(2)}  SKIPPED: ${row.skipped} (one runtime ${row.perRuntimeMb} MB)\n`);
          continue;
        }
      }
      const runs = [];
      for (let i = 0; i < o.runs; i++) runs.push(await once(o, layout, n));
      const pick = (f) => r1(median(runs.map(f)));
      const row = {layout, n, runs: o.runs, startupMs: pick((r) => r.startupMs), rssReadyMb: pick((r) => r.rssReadyMb),
        rssAfterFirstMb: pick((r) => r.rssAfterFirstMb), rssAfterWarmMb: pick((r) => r.rssAfterWarmMb),
        firstMedianMs: pick((r) => r.firstMs.median), firstMaxMs: pick((r) => r.firstMs.max),
        warmMedianMs: pick((r) => r.warmMs.median), warmMaxMs: pick((r) => r.warmMs.max),
        failed: runs.flatMap((r) => r.failed), firstFailure: (runs.find((r) => r.firstFailure != null) || {}).firstFailure || null, ownCalls: runs.map((r) => r.ownCalls), adminDistinctCallers: runs.map((r) => r.adminDistinctCallers)};
      if (layout === 'separate' && perRuntimeMb == null) perRuntimeMb = row.rssAfterWarmMb / n;
      rows.push(row);
      process.stdout.write(`${layout.padEnd(8)} N=${String(n).padStart(2)}  ready ${row.startupMs} ms  RSS ready ${row.rssReadyMb} / after first ${row.rssAfterFirstMb} / after warm ${row.rssAfterWarmMb} MB  ` +
        `first ${row.firstMedianMs} (max ${row.firstMaxMs}) ms  warm ${row.warmMedianMs} (max ${row.warmMaxMs}) ms  failed ${row.failed.length}${row.failed.length ? ` (${[...new Set(row.failed)].join(', ').slice(0, 200)})` : ''}` +
        `  own calls ${JSON.stringify(row.ownCalls)}${layout === 'shared' ? `  admin callers ${JSON.stringify(row.adminDistinctCallers)}` : ''}\n${ 
        row.firstFailure != null ? `  first failure: ${row.firstFailure}\n` : ''}`);
    }
  }
  const result = {runtime: o.runtime, pack: o.pack, packVersion: o.packVersion, remote: `${o.github.origin} -> the local stub (${o.stub.calls.calls} calls)`,
    node: process.version, cpus: os.cpus().length, rows};
  process.stdout.write(`SHARED-RUNTIME-JSON ${JSON.stringify(result)}\n`);
  if (o.json != null) fs.writeFileSync(o.json, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const argsFile = path.join(__dirname, 'measure.args.json');
const loadedByMocha = module.parent != null && /[\\/]mocha[\\/]/.test(String(module.parent.filename));
if (typeof(describe) === 'function' && typeof(it) === 'function' && loadedByMocha) {
  describe('perf: shared runtime', function() {
    this.timeout(0);
    it('measures', async () => { assert.ok(fs.existsSync(argsFile), 'measure.args.json'); await main(JSON.parse(fs.readFileSync(argsFile, 'utf8'))); });
  });
} else if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e.stack || e.message}\n`); process.exit(1); });
}
module.exports = {main};
