// Token cost of log-triage, four ways: the model chaining the four leaf tools
// itself (A), one call to the composite (B), and code mode -- the leaf tools as
// a generated Node library the model scripts against -- with output types (D1)
// and without (D2). C is B's configuration with a trivial prompt: the fixed
// cost of one turn (system prompt + tool definitions).
//
//   node perf/token-cost-compare.js tools     --mcp <mcp.json> --out <tools-list.json>
//   node perf/token-cost-compare.js reference --mcp <mcp.json> --out <dir>
//   node perf/token-cost-compare.js run       --group A|B|C|D1|D2 --fixture <name> --rep <n>
//        --mcp <mcp.json> --tools <tools-list.json> --out <dir> [--prompt <text>]
//   node perf/token-cost-compare.js matrix    --mcp <mcp.json> --tools <tools-list.json> --out <dir>
//        [--capUsd <n, default 20>] [--imageId <id>]
//   node perf/token-cost-compare.js report    --out <dir> [--tools <tools-list.json>]
//   node perf/token-cost-compare.js scrub     --out <dir> --mcp <mcp.json>
//
// <mcp.json> is a Claude Code MCP config holding exactly one HTTP server named
// "ch" (the local countinghouse, with the test key in its headers). The key is
// read from it at run time and never written anywhere by this script: D's
// wrappers get it through the CH_PERF_KEY environment variable.
//
// Every run goes through a logging proxy started by this script, so the tool
// calls of A, B and D are observed the same way, at the wire. The proxy keeps
// derived facts only (tool, file, line counts, hashes, whether a planted value
// reached the cluster step), never the lines themselves.
//
// `run` writes <out>/<id>.jsonl (claude's stream-json, as emitted),
// <id>.meta.json (command line, wall time, exit) and <id>.wire.json (the
// proxy's record). `report` reads them all back and prints the comparison;
// every comparative word in it comes from the numbers, not from a person.
const crypto = require('crypto');
const fs     = require('fs');
const http   = require('http');
const os     = require('os');
const path   = require('path');
const zlib   = require('zlib');
const {spawn, spawnSync} = require('child_process');

const {allPlantedValues} = require('../examples/log-triage/generate-logs');

const PROXY_PORT = 9541;
const MAX_TURNS  = 80;
const MAX_BUDGET = '5';   // USD per run; a run that hits it is invalid
// The alias the measurement was specified with, and the id it must resolve
// to: a run whose main turns came from any other model is invalid.
const MODEL      = 'sonnet';
const MODEL_ID   = 'claude-sonnet-5-5';

const PROMPT = (dir) => `Triage the logs in ${dir}: give the number of warnings and errors, ` +
  'and the top clusters of similar messages. Secrets in the logs must be redacted before clustering.';
const C_PROMPT = 'Reply with OK.';
// Code mode's counterpart of A/B's tool definitions, appended to D's system
// prompt (D1 and D2 alike, and CD): where the API is and how to call it,
// nothing about the task. Without it the model never looks in ./servers.
const D_SYSTEM_APPEND = 'The MCP tools available to you are provided as a Node.js library in ./servers/ ' +
  '(one directory per MCP server, one .js file per tool, with a README.md and types.d.ts). Use them by ' +
  'writing and running Node.js scripts; the functions read their credentials from the CH_PERF_KEY ' +
  'environment variable, which is already set. Files and directories named in a request are on the MCP ' +
  'server, not on this machine: reach them through these functions. Bash here runs only `node` commands ' +
  "(for example `node -e '...'` or `node <<'EOF' ... EOF`); other shell commands and redirection are refused.";
const isCode = (g) => g === 'D1' || g === 'D2' || g === 'CD';

const FIXTURES = {f2x100: '/data/f2x100', f8x100: '/data/f8x100', f8x400: '/data/f8x400'};

const LEAF = {
  list:    'log_read_readservice_list',
  read:    'log_read_readservice_read',
  redact:  'pii_redact_redactservice_redact',
  cluster: 'error_cluster_clusterservice_cluster'
};
const COMPOSITE = 'log_triage_triageservice_triage';
const mcpName = (tool) => `mcp__ch__${tool}`;

// Every built-in tool, denied for A/B/C and all but Bash/Read/Glob for D.
// --tools already narrows the built-in set; this is the second lock the
// measurement asks for, and the init message is checked against both.
const BUILTINS = ['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch',
  'WebSearch', 'Task', 'Agent', 'TodoWrite', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskOutput',
  'TaskStop', 'KillShell', 'BashOutput', 'ToolSearch', 'Skill', 'SlashCommand', 'ExitPlanMode',
  'EnterPlanMode', 'EnterWorktree', 'ExitWorktree', 'Monitor', 'LSP', 'AskUserQuestion', 'SendMessage',
  'ListAgents', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'PushNotification',
  'Workflow', 'Artifact', 'ReadNotifications', 'SendUserFile', 'ListMcpResourcesTool', 'ReadMcpResourceTool'];

function groupConfig(group, allMcpTools) {
  const leafTools = Object.values(LEAF).map(mcpName);
  const others = (keep) => allMcpTools.filter((t) => !keep.includes(t));
  switch (group) {
    case 'A':  return {tools: '', allowed: leafTools, denied: BUILTINS.concat(others(leafTools))};
    case 'B':
    case 'C':  return {tools: '', allowed: [mcpName(COMPOSITE)], denied: BUILTINS.concat(others([mcpName(COMPOSITE)]))};
    case 'D1':
    case 'D2':
    case 'CD': return {tools: 'Bash,Read,Glob', allowed: ['Bash(node:*)', 'Read(./**)', 'Glob(./**)'],
      denied: BUILTINS.filter((t) => !['Bash', 'Read', 'Glob'].includes(t)).concat(allMcpTools)};
    default: throw new Error(`unknown group ${group}`);
  }
}

// ---- small helpers ----------------------------------------------------------

function parseArgs(argv) {
  const o = {_: []};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}

function readMcp(file) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const names = Object.keys(cfg.mcpServers || {});
  if (names.length !== 1 || names[0] !== 'ch') throw new Error(`${file} must hold exactly one server named "ch"`);
  const s = cfg.mcpServers.ch;
  return {url: s.url, key: s.headers['X-CH-Key']};
}

async function rpc(url, key, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'X-CH-Key': key},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const sha = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex').slice(0, 16);
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };

// ---- the logging proxy ------------------------------------------------------

// Forwards every request to the instance unchanged and records, per tools/call,
// derived facts about it. One proxy per run; `wire` is that run's record.
function startProxy(target) {
  // in memory only: line text -> the file it was read from, and redact
  // output line -> the file of the input line it masks (by position)
  const wire = {calls: [], redactOutputs: new Set(), readOutputs: {}, lineFile: new Map(), redactOutFile: new Map(),
    reached: new Map()};   // file -> Set of its WARN/ERROR lines that reached cluster via redact
  const planted = allPlantedValues();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const headers = Object.assign({}, req.headers);
      delete headers.host;
      delete headers['content-length'];
      let upstream, text;
      try {
        upstream = await fetch(target, {method: req.method, headers, body: req.method === 'GET' ? undefined : raw});
        text = await upstream.text();
      } catch (e) {
        res.writeHead(502); res.end(String(e)); return;
      }
      res.writeHead(upstream.status, {'content-type': upstream.headers.get('content-type') || 'application/json'});
      res.end(text);
      try { record(wire, planted, JSON.parse(raw.toString()), text, upstream.status); } catch (e) { /* not JSON-RPC */ }
    });
  });
  return new Promise((resolve) => server.listen(PROXY_PORT, '127.0.0.1', () => resolve({server, wire})));
}

const WARN_ERROR = /^\S+ (WARN|ERROR) /;
const countBy = (xs) => xs.reduce((m, x) => { m[x] = (m[x] || 0) + 1; return m; }, {});

function parseRpcBody(text) {
  // Streamable HTTP may answer as SSE; take the last data: line.
  if (/^\s*[{[]/.test(text)) return JSON.parse(text);
  const data = text.split('\n').filter((l) => l.startsWith('data:')).pop();
  return data ? JSON.parse(data.slice(5)) : null;
}

function record(wire, planted, reqBody, text, status) {
  if (reqBody.method !== 'tools/call') {
    wire.calls.push({t: Date.now(), method: reqBody.method, status});
    return;
  }
  const name = reqBody.params.name;
  const args = reqBody.params.arguments || {};
  const body = parseRpcBody(text);
  const result = body && body.result;
  // structuredContent is the module's result (8.0.0); the 2026-11-05 runs
  // read it as {output: <result>}
  const sc = result && result.structuredContent;
  const entry = {t: Date.now(), method: 'tools/call', tool: name, status,
    isError: !!(result && result.isError), rpcError: body && body.error ? body.error.message : null,
    errorText: result && result.isError ? (result.content || []).map((c) => c.text).join(' ').slice(0, 300) : null,
    responseBytes: Buffer.byteLength(text), argBytes: Buffer.byteLength(JSON.stringify(args))};
  if (name === LEAF.list) entry.dir = args.dir;
  if (name === LEAF.read) {
    entry.dir = args.dir; entry.file = args.name;
    if (sc && sc.lines) {
      entry.lines = sc.lines.length; entry.outHash = sha(sc.lines); wire.readOutputs[entry.outHash] = args.name;
      entry.warnErrorLines = sc.lines.filter((l) => WARN_ERROR.test(l)).length;
      for (const l of sc.lines) wire.lineFile.set(l, args.name);
    }
  }
  if (name === LEAF.redact) {
    entry.lines = (args.lines || []).length;
    entry.inHash = sha(args.lines || []);
    entry.inputIsAReadOutput = wire.readOutputs[entry.inHash] || null;
    entry.inputPlantedValues = planted.filter((v) => (args.lines || []).some((l) => l.includes(v))).length;
    const inLines = args.lines || [];
    entry.linesBySourceFile = countBy(inLines.map((l) => wire.lineFile.get(l) || '(not a read line)'));
    if (sc && sc.lines) {
      entry.outHash = sha(sc.lines);
      sc.lines.forEach((l, i) => { wire.redactOutputs.add(l); wire.redactOutFile.set(l, wire.lineFile.get(inLines[i]) || null); });
    }
  }
  if (name === LEAF.cluster) {
    const lines = args.lines || [];
    entry.lines = lines.length;
    entry.topClusters = args.topClusters;
    // hashes of the planted values found, never the values themselves
    entry.plantedValuesInInput = planted.filter((v) => lines.some((l) => l.includes(v))).map(sha);
    entry.linesNotFromRedact = lines.filter((l) => !wire.redactOutputs.has(l)).length;
    // a raw read line holding a planted value, sent without masking
    entry.rawPlantedLines = lines.filter((l) => wire.lineFile.has(l) && planted.some((v) => l.includes(v))).length;
    entry.linesBySourceFile = countBy(lines.map((l) => wire.redactOutFile.get(l) || '(not via redact)'));
    for (const l of lines) {
      const f = wire.redactOutFile.get(l);
      if (f && WARN_ERROR.test(l)) { if (!wire.reached.has(f)) wire.reached.set(f, new Set()); wire.reached.get(f).add(l); }
    }
    if (sc) entry.result = {byLevel: sc.byLevel, unparsed: sc.unparsed, clusterCount: sc.clusterCount,
      clusters: (sc.clusters || []).map((c) => ({template: c.template, level: c.level, count: c.count}))};
  }
  if (name === COMPOSITE && sc && sc.findings) {
    entry.args = args;
    entry.result = {levels: sc.findings.levels, files: sc.findings.files.read.length, clusters: sc.findings.clusters.map((c) => ({template: c.template, level: c.level, count: c.count}))};
  }
  wire.calls.push(entry);
}

// ---- subcommands ------------------------------------------------------------

async function cmdTools(o) {
  const {url, key} = readMcp(o.mcp);
  const result = await rpc(url, key, 'tools/list', {});
  fs.writeFileSync(o.out, JSON.stringify(result, null, 2));
  console.log(`tools/list: ${result.tools.map((t) => t.name).join(', ')} -> ${o.out}`);
}

// The ground truth: the composite called directly, once per fixture.
async function cmdReference(o) {
  const {url, key} = readMcp(o.mcp);
  fs.mkdirSync(o.out, {recursive: true});
  const ref = {};
  for (const [name, dir] of Object.entries(FIXTURES)) {
    const r = await rpc(url, key, 'tools/call', {name: COMPOSITE, arguments: {dir}});
    if (r.isError) throw new Error(`reference ${name}: ${r.content.map((c) => c.text).join(' ')}`);
    const f = r.structuredContent.findings;
    // a second call at topClusters 50 gives the full cluster list, for checking
    // answers that list more than the default 10
    const all = (await rpc(url, key, 'tools/call', {name: COMPOSITE, arguments: {dir, topClusters: 50}})).structuredContent.findings;
    ref[name] = {dir, files: f.files.read.map((x) => x.name), levels: f.levels, pii: f.pii,
      clusters: f.clusters.map((c) => ({template: c.template, level: c.level, count: c.count})),
      allClusters: all.clusters.map((c) => ({template: c.template, level: c.level, count: c.count}))};
    console.log(`${name}: files=${ref[name].files.length} WARN=${f.levels.WARN} ERROR=${f.levels.ERROR} clusters=${all.clusters.length}`);
  }
  fs.writeFileSync(path.join(o.out, 'reference.json'), JSON.stringify(ref, null, 2));
}

async function balance(url, key) {
  const r = await rpc(url, key, 'tools/call', {name: 'countinghouse_check_balance', arguments: {}});
  return r.structuredContent ? r.structuredContent.balance : null;
}

async function cmdRun(o) {
  const group = o.group, fixture = o.fixture, rep = o.rep;
  const {url, key} = readMcp(o.mcp);
  const tools = JSON.parse(fs.readFileSync(o.tools, 'utf8')).tools.map((t) => mcpName(t.name));
  const cfg = groupConfig(group, tools);
  const id = runId(group, fixture, rep);
  fs.mkdirSync(o.out, {recursive: true});

  // empty working directory; D's holds only the generated servers/ tree
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-token-'));
  const proxyUrl = `http://127.0.0.1:${PROXY_PORT}/mcp`;
  if (isCode(group)) {
    const g = spawnSync(process.execPath, [path.join(__dirname, 'gen-code-mode-wrappers.js'), '--tools', o.tools,
      '--out', cwd, '--variant', group === 'CD' ? 'D1' : group, '--url', proxyUrl, '--keyEnv', 'CH_PERF_KEY'], {encoding: 'utf8'});
    if (g.status !== 0) throw new Error(`generator failed: ${g.stderr}`);
  }
  // the run's MCP config points at the proxy; it lives outside cwd and is
  // deleted after the run, so the key never sits in the working directory
  const mcpFile = path.join(os.tmpdir(), `ch-token-mcp-${process.pid}.json`);
  const mcpServers = isCode(group) ? {} :
    {ch: {type: 'http', url: proxyUrl, headers: {'X-CH-Key': key}}};
  fs.writeFileSync(mcpFile, JSON.stringify({mcpServers}), {mode: 0o600});

  const prompt = o.prompt || (group === 'C' || group === 'CD' ? C_PROMPT : PROMPT(FIXTURES[fixture]));
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--mcp-config', mcpFile, '--model', MODEL, '--max-turns', String(MAX_TURNS),
    '--max-budget-usd', MAX_BUDGET, '--tools', cfg.tools,
    '--allowedTools', cfg.allowed.join(','), '--disallowedTools', cfg.denied.join(','),
    '--permission-mode', 'dontAsk', '--setting-sources', 'project,local',
    '--disable-slash-commands', '--no-session-persistence',
    // the assistant events carry each response's usage as of message_start;
    // the final output_tokens of a response is only in its message_delta
    '--include-partial-messages'];
  if (isCode(group)) args.push('--append-system-prompt', D_SYSTEM_APPEND);
  const env = Object.assign({}, process.env);
  delete env.CLAUDECODE;
  if (isCode(group)) env.CH_PERF_KEY = key;

  const {server, wire} = await startProxy(url);
  const before = await balance(url, key);
  const t0 = Date.now();
  const out = fs.openSync(path.join(o.out, `${id}.jsonl`), 'w');
  const code = await new Promise((resolve) => {
    const child = spawn('claude', args, {cwd, env, stdio: ['ignore', out, 'pipe']});
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (c, sig) => { if (err) fs.writeFileSync(path.join(o.out, `${id}.stderr.txt`), err); resolve(c == null ? sig : c); });
  });
  const wallMs = Date.now() - t0;
  fs.closeSync(out);
  await new Promise((r) => server.close(r));
  const after = await balance(url, key);
  fs.unlinkSync(mcpFile);

  const serverDir = path.join(o.out, 'servers-seen', group);
  if (isCode(group) && !fs.existsSync(serverDir)) {
    fs.cpSync(path.join(cwd, 'servers'), path.join(serverDir, 'servers'), {recursive: true});
  }
  // what the model left in its working directory: D's shell can't redirect
  // into a file, but node can write one, so a script saved this way shows
  // here -- recorded as a note, not a fault
  const leftover = listTree(cwd).filter((p) => !p.startsWith('servers/'));
  fs.rmSync(cwd, {recursive: true, force: true});

  // The proxy never records headers, so the key must not be in anything this
  // run wrote; checked here, and again by `scrub` before a commit.
  const wireOut = {calls: wire.calls,
    reachedWarnError: Object.fromEntries([...wire.reached].map(([f, set]) => [f, set.size]))};
  fs.writeFileSync(path.join(o.out, `${id}.wire.json`), JSON.stringify(wireOut, null, 2));
  for (const f of fs.readdirSync(o.out).filter((x) => x.startsWith(`${id}.`))) {
    if (fs.readFileSync(path.join(o.out, f), 'utf8').includes(key)) throw new Error(`the key appears in ${f}`);
  }
  fs.writeFileSync(path.join(o.out, `${id}.meta.json`), JSON.stringify({id, group, fixture: isControl(group) ? null : fixture,
    rep: +rep, prompt, args: args.map((a) => (a === mcpFile ? '<mcp-config>' : a)), cwd,
    wallMs, exit: code, startedAt: new Date(t0).toISOString(), versions: versions(), imageId: o.imageId || null, balanceBefore: before, balanceAfter: after,
    metered: before != null && after != null ? before - after : null, leftover}, null, 2));
  console.log(`${id}: exit=${code} wall=${(wallMs / 1000).toFixed(1)}s tool calls at the wire=${wire.calls.filter((c) => c.method === 'tools/call').length}`);
}

const isControl = (g) => g === 'C' || g === 'CD';
const runId = (group, fixture, rep) => `${group}-${isControl(group) ? 'none' : fixture}-r${rep}`;

function versions() {
  const claude = spawnSync('claude', ['--version'], {encoding: 'utf8'});
  return {claude: (claude.stdout || '').trim(), node: process.version};
}

function listTree(dir, base) {
  base = base || dir;
  let out = [];
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(listTree(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

// Interleaved: each rep runs every cell once, and the group order rotates per
// rep, so no group always runs right after the same other group (prompt-cache
// warmth is shared between runs whose prefixes match).
function schedule() {
  const cells = [];
  const order = [['A', 'B', 'D1'], ['B', 'D1', 'A'], ['D1', 'A', 'B']];
  for (let rep = 1; rep <= 3; rep++) {
    cells.push({group: 'C', fixture: 'none', rep});
    cells.push({group: 'CD', fixture: 'none', rep});
    for (const fixture of Object.keys(FIXTURES)) {
      for (const group of order[rep - 1]) cells.push({group, fixture, rep});
      if (fixture === 'f8x100') cells.push({group: 'D2', fixture, rep});
    }
  }
  return cells;
}

// Stops when the spend so far reaches the cap (default $20), whatever the
// projection said.
async function cmdMatrix(o) {
  const cap = o.capUsd != null ? +o.capUsd : 20;
  const cells = schedule();
  for (const c of cells) {
    const spent = spentSoFar(o.out);
    console.log(`spent so far: ${spent.toFixed(3)} USD`);
    // a run can cost up to MAX_BUDGET, so stop before one could cross the cap
    if (spent + Number(MAX_BUDGET) > cap) { console.error(`STOP: spend ${spent.toFixed(3)} USD + one run's ${MAX_BUDGET} USD budget would exceed the ${cap} USD cap`); process.exit(4); }
    const id = runId(c.group, c.fixture, c.rep);
    if (fs.existsSync(path.join(o.out, `${id}.meta.json`)) && !o.force) { console.log(`${id}: done, skipped`); continue; }
    await cmdRun(Object.assign({}, o, c));
    const v = analyse(o.out, id, loadRef(o.out), toolsFile(o));
    if (v.stop) { console.error(`STOP after ${id}: ${v.stop}`); process.exit(3); }
  }
}

function spentSoFar(out) {
  if (!fs.existsSync(out)) return 0;
  let total = 0;
  for (const f of fs.readdirSync(out).filter((x) => x.endsWith('.jsonl') || x.endsWith('.jsonl.gz'))) {
    const r = readEvents(path.join(out, f)).filter((e) => e.type === 'result').pop();
    if (r && r.total_cost_usd) total += r.total_cost_usd;
  }
  return total;
}

// ---- analysis ---------------------------------------------------------------

function loadRef(out) {
  const f = path.join(out, 'reference.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
const toolsFile = (o) => (o.tools && fs.existsSync(o.tools) ? JSON.parse(fs.readFileSync(o.tools, 'utf8')) : null);

// A committed transcript is gzipped (<id>.jsonl.gz); a fresh one is not.
function readEvents(file) {
  if (!fs.existsSync(file) && fs.existsSync(`${file}.gz`)) file = `${file}.gz`;
  const raw = file.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return {type: 'unparsable'}; } });
}

// Words in a path that point at the fixtures, the generator, or anywhere
// outside the working directory. Any hit in a command or tool argument is a
// leak candidate; candidates are listed and the run is a hard stop.
const LEAK_PATTERNS = [/\/home\//, /~\//, /\/etc\//, /\/proc\//, /\/var\//, /\/root\b/, /\.\.\//, /countinghouse(?!_)/i,
  /generate-logs/, /sample-logs/, /module_data/, /\bdocker\b/, /child_process/, /\bexecSync\b|\bspawnSync\b|\bexec\(/,
  /\/tmp\//, /process\.env(?!\.CH_PERF_KEY)\b/];

function analyse(out, id, ref, toolsList) {
  const ev = readEvents(path.join(out, `${id}.jsonl`));
  const meta = JSON.parse(fs.readFileSync(path.join(out, `${id}.meta.json`), 'utf8'));
  const wire = JSON.parse(fs.readFileSync(path.join(out, `${id}.wire.json`), 'utf8'));
  const group = meta.group;
  const init = ev.find((e) => e.type === 'system' && e.subtype === 'init') || {};
  const result = ev.filter((e) => e.type === 'result').pop() || {};

  // usage per API response. Input and cache counts are known at
  // message_start; output_tokens only at the response's message_delta
  // (stream events, from --include-partial-messages). Without stream events
  // the per-response output is unknown and only result.usage has the total.
  const byMsg = new Map();
  let current = null;
  for (const e of ev) {
    if (e.type === 'stream_event' && e.event) {
      if (e.event.type === 'message_start') {
        current = e.event.message.id;
        byMsg.set(current, {usage: Object.assign({}, e.event.message.usage), model: e.event.message.model, final: false});
      } else if (e.event.type === 'message_delta' && current && byMsg.has(current) && e.event.usage) {
        Object.assign(byMsg.get(current).usage, e.event.usage);
        byMsg.get(current).final = true;
      }
      continue;
    }
    if (e.type !== 'assistant' || !e.message || !e.message.usage) continue;
    if (!byMsg.has(e.message.id)) byMsg.set(e.message.id, {usage: e.message.usage, model: e.message.model, final: false});
  }
  const turns = [...byMsg.values()];
  const sum = (k) => turns.reduce((a, t) => a + (t.usage[k] || 0), 0);
  const ru = result.usage || {};
  const perTurnOutputKnown = turns.length > 0 && turns.every((t) => t.final);
  const perTurn = turns.map((t) => ({in: t.usage.input_tokens || 0, out: t.usage.output_tokens || 0,
    cw: t.usage.cache_creation_input_tokens || 0, cr: t.usage.cache_read_input_tokens || 0}));
  // Main turns are the assistant messages; Claude Code may also bill a small
  // model for side tasks, which shows only in modelUsage. Those are listed
  // separately and are already inside total_cost_usd.
  const models = [...new Set(turns.map((t) => t.model))];
  const sideModels = Object.entries(result.modelUsage || {}).filter(([m]) => !models.includes(m))
    .map(([m, u]) => ({model: m, usage: u}));

  // tool uses, as the model issued them
  const uses = [];
  const results = new Map();
  for (const e of ev) {
    const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const c of content) {
      if (e.type === 'assistant' && c.type === 'tool_use') uses.push({id: c.id, name: c.name, input: c.input, msg: e.message.id});
      if (e.type === 'user' && c.type === 'tool_result') {
        const text = typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text || '').join('');
        results.set(c.tool_use_id, {bytes: Buffer.byteLength(text), isError: !!c.is_error, text});
      }
    }
  }
  const toolCounts = {};
  for (const u of uses) toolCounts[u.name] = (toolCounts[u.name] || 0) + 1;

  const tools = toolsList ? toolsList.tools.map((t) => mcpName(t.name)) : [];
  const cfg = groupConfig(group, tools);
  const allowedNames = isCode(group) ? ['Bash', 'Read', 'Glob'] : cfg.allowed;
  const stops = [], invalid = [], notes = [];

  // the environment: which tools the model was given
  const initTools = init.tools || [];
  const unexpected = initTools.filter((t) => !allowedNames.includes(t));
  if (unexpected.length) stops.push(`tools offered beyond the group's set: ${unexpected.join(', ')}`);
  const missing = allowedNames.filter((t) => !initTools.includes(t));
  if (missing.length) invalid.push(`allowed tools missing from init: ${missing.join(', ')}`);
  for (const u of uses) {
    if (!allowedNames.includes(u.name)) stops.push(`used ${u.name}, outside the allowed set`);
  }
  // leak scan over every argument the model passed to a tool
  const leaks = [];
  // the run's own working directory is the one place a path may point
  const inCwd = (x) => (meta.cwd ? x.split(meta.cwd).join('<cwd>') : x);
  // Only local tools can reach the host's files: an MCP tool's arguments go
  // to the server (A's carry log text such as "/var/data", which is no leak).
  // A call the harness refused never ran: its hits are listed as attempts.
  // Any call that ran and matched stays a stop, even one that then failed
  // with ENOENT/EACCES -- the scan cannot prove a script read nothing.
  for (const u of uses) {
    if (u.name.startsWith('mcp__')) continue;
    const res = results.get(u.id);
    const denied = !!(res && res.isError && /^Permission to use \w+ has been denied/.test(res.text));
    const s = inCwd(JSON.stringify(u.input));
    for (const re of LEAK_PATTERNS) if (re.test(s)) leaks.push({tool: u.name, denied, pattern: String(re), excerpt: excerpt(s, re)});
    if ((u.name === 'Read' || u.name === 'Glob') && u.input) {
      const p = inCwd(u.input.file_path || u.input.path || u.input.pattern || '');
      if (path.isAbsolute(p)) leaks.push({tool: u.name, denied, pattern: 'absolute path', excerpt: p});
    }
  }
  const ran = leaks.filter((l) => !l.denied);
  if (ran.length) stops.push(`leak candidates in calls that ran: ${ran.length}`);
  if (leaks.length > ran.length) notes.push(`denied out-of-bounds attempts: ${leaks.length - ran.length}`);

  // validity
  if (result.subtype !== 'success') invalid.push(`result subtype ${result.subtype}`);
  if (result.is_error) invalid.push('result is_error');
  if (meta.exit !== 0) invalid.push(`claude exit ${meta.exit}`);
  for (const c of wire.calls) {
    if (c.status >= 500 || c.rpcError || /RATE_LIMITED|insufficient/i.test(c.errorText || '')) invalid.push(`server-side failure: ${c.tool} ${c.status} ${c.rpcError || c.errorText}`);
  }
  const compactions = ev.filter((e) => e.type === 'system' && /compact/.test(e.subtype || '')).length;

  // correctness, against the reference
  const answer = result.result || '';
  const fx = meta.fixture && ref ? ref[meta.fixture] : null;
  const correctness = fx ? checkAnswer(answer, fx) : null;
  const pipeline = (group === 'A' || group.startsWith('D')) && fx ? checkPipeline(wire, fx) : null;
  if (group === 'B' && fx) {
    const call = wire.calls.find((c) => c.tool === COMPOSITE && c.result);
    // the model may pass its own topClusters/maxFiles: compare the levels,
    // and the clusters it got against the same-length prefix of the full list
    const same = call && JSON.stringify(call.result.levels) === JSON.stringify(fx.levels) &&
      JSON.stringify(call.result.clusters) === JSON.stringify(fx.allClusters.slice(0, call.result.clusters.length));
    if (!call) invalid.push('B made no successful composite call');
    else if (!same) stops.push('B: composite output differs from the direct reference call');
  }

  // code mode specifics
  let code = null;
  const msgOut = new Map([...byMsg].map(([idm, t]) => [idm, t.usage.output_tokens || 0]));
  if (group === 'D1' || group === 'D2') code = codeMode(uses, results, group, toolsList, msgOut);

  // A: output tokens of the responses that called redact or cluster -- the
  // model writing log lines back out as tool arguments -- and those bytes.
  let retype = null;
  if (group === 'A') {
    const dataMsgs = new Set(uses.filter((u) => u.name === mcpName(LEAF.redact) || u.name === mcpName(LEAF.cluster)).map((u) => u.msg));
    const argBytes = uses.filter((u) => dataMsgs.has(u.msg) && u.name.startsWith('mcp__')).reduce((a, u) => a + Buffer.byteLength(JSON.stringify(u.input)), 0);
    retype = {responses: dataMsgs.size, outputTokens: [...dataMsgs].reduce((a, m) => a + (msgOut.get(m) || 0), 0), argBytes};
  }
  // planted values in the final answer, by count only
  const answerPlanted = allPlantedValues().filter((v) => (result.result || '').includes(v)).length;
  // planted values that reached the model's context at all, through any
  // tool result (A's read results carry raw lines by design)
  const contextText = [...results.values()].map((x) => x.text).join('\n');
  const contextPlanted = allPlantedValues().filter((v) => contextText.includes(v)).length;

  if (perTurnOutputKnown) {
    for (const [k, rk] of [['input_tokens', 'input_tokens'], ['output_tokens', 'output_tokens'],
      ['cache_creation_input_tokens', 'cache_creation_input_tokens'], ['cache_read_input_tokens', 'cache_read_input_tokens']]) {
      if (sum(k) !== (ru[rk] || 0)) invalid.push(`per-turn ${k} sum ${sum(k)} != result.usage ${ru[rk] || 0}`);
    }
  } else if (turns.length) {
    invalid.push('per-turn output tokens unknown (no message_delta events)');
  }
  if (models.some((m) => m !== MODEL_ID)) invalid.push(`main turns from ${models.join(', ')}, not ${MODEL_ID}`);
  if (meta.leftover && meta.leftover.length) notes.push(`files left in cwd: ${meta.leftover.join(', ')}`);

  const r = {id, group, fixture: meta.fixture, rep: meta.rep, startedAt: meta.startedAt, models, sideModels, initModel: init.model,
    // totals from result.usage, the authoritative sum; the per-turn sums are
    // kept beside them as a check
    tokens: {input: ru.input_tokens || 0, output: ru.output_tokens || 0, cacheWrite: ru.cache_creation_input_tokens || 0,
      cacheRead: ru.cache_read_input_tokens || 0},
    perTurnSums: {input: sum('input_tokens'), output: sum('output_tokens'), cacheWrite: sum('cache_creation_input_tokens'),
      cacheRead: sum('cache_read_input_tokens'), outputKnown: perTurnOutputKnown},
    thinkingTokens: ru.output_tokens_details ? ru.output_tokens_details.thinking_tokens : null,
    resultUsage: result.usage || null, costUsd: result.total_cost_usd, numTurns: result.num_turns, apiResponses: turns.length,
    perTurn, firstTurnPrompt: perTurn.length ? perTurn[0].in + perTurn[0].cw + perTurn[0].cr : null,
    wallMs: meta.wallMs, toolCounts, wireCalls: wire.calls.filter((c) => c.method === 'tools/call').map((c) => c.tool),
    metered: meta.metered, compactions, initTools, initExtras: {mcp_servers: init.mcp_servers, skills: init.skills,
      slash_commands: init.slash_commands, plugins: init.plugins, permissionMode: init.permissionMode, agents: init.agents},
    correctness, pipeline, code, retype, answerPlanted, contextPlanted, leaks, answer, stops, invalid, notes,
    stop: stops.length ? stops.join('; ') : null};
  r.total = r.tokens.input + r.tokens.output + r.tokens.cacheWrite + r.tokens.cacheRead;
  return r;
}

function excerpt(s, re) {
  const m = s.match(re);
  if (!m) return '';
  return s.slice(Math.max(0, m.index - 60), m.index + 60);
}

// Pulls the reported WARN/ERROR totals and the top clusters out of the
// model's prose. Heuristic by nature, so it reports what it matched; the
// report lists any run it could not settle for reading by hand.
function checkAnswer(answer, fx) {
  const text = answer.replace(/\*\*/g, '').replace(/,(?=\d{3}\b)/g, '');
  const near = (n, word) => new RegExp(`(\\b${n}\\b[^\\n]{0,40}${word})|(${word}[^\\n]{0,40}\\b${n}\\b)`, 'i').test(text);
  const warnOk = near(fx.levels.WARN, 'warn');
  const errOk  = near(fx.levels.ERROR, 'error');
  const top = fx.clusters.slice(0, 5).map((c) => {
    const words = c.template.replace(/<[^>]+>|#/g, ' ').split(/\s+/).filter((w) => w.length > 3).slice(0, 3);
    const has = words.every((w) => text.toLowerCase().includes(w.toLowerCase().replace(/[^\w/-]/g, '')));
    return {template: c.template, count: c.count, mentioned: has, countShown: has && new RegExp(`\\b${c.count}\\b`).test(text)};
  });
  return {warnOk, errOk, expected: {WARN: fx.levels.WARN, ERROR: fx.levels.ERROR},
    top5Mentioned: top.filter((t) => t.mentioned).length, top5CountShown: top.filter((t) => t.countShown).length, top};
}

// What A and D actually did at the wire: every file read, every read output
// redacted, nothing unredacted reaching cluster.
function checkPipeline(wire, fx) {
  const calls = wire.calls.filter((c) => c.method === 'tools/call');
  const reads = calls.filter((c) => c.tool === LEAF.read && !c.isError);
  const redacts = calls.filter((c) => c.tool === LEAF.redact && !c.isError);
  const clusters = calls.filter((c) => c.tool === LEAF.cluster && !c.isError);
  const filesRead = [...new Set(reads.map((c) => c.file))].sort();
  const missingFiles = fx.files.filter((f) => !filesRead.includes(f));
  // Line level, since a model may filter or batch before redacting: per file,
  // how many of its WARN/ERROR lines reached cluster through redact. A file
  // whose warnings and errors never got there was skipped, wholly or partly.
  const warnErrorByFile = {};
  for (const c of reads) warnErrorByFile[c.file] = c.warnErrorLines;
  // distinct WARN/ERROR lines of each file that reached cluster through redact,
  // over every cluster call of the run
  const reachedByFile = wire.reachedWarnError || {};
  const coverage = filesRead.map((f) => ({file: f, warnError: warnErrorByFile[f], reachedClusterViaRedact: reachedByFile[f] || 0}));
  const notRedacted = coverage.filter((c) => c.reachedClusterViaRedact < c.warnError).map((c) => c.file);
  return {
    calls: calls.length, errors: calls.filter((c) => c.isError).map((c) => `${c.tool}: ${c.errorText}`),
    filesRead, missingFiles, notRedacted, coverage,
    redactCalls: redacts.length,
    redactCallsEqualToARead: redacts.filter((c) => c.inputIsAReadOutput).length,
    redactInputLinesNotFromARead: redacts.reduce((a, c) => a + ((c.linesBySourceFile || {})['(not a read line)'] || 0), 0),
    clusterRawPlantedLines: clusters.reduce((a, c) => a + (c.rawPlantedLines || 0), 0),
    clusterCalls: clusters.length,
    clusterLinesTotal: clusters.reduce((a, c) => a + c.lines, 0),
    clusterLinesNotFromRedact: clusters.reduce((a, c) => a + c.linesNotFromRedact, 0),
    plantedValuesReachingCluster: [...new Set(clusters.flatMap((c) => c.plantedValuesInInput))],
    clusterByLevel: clusters.map((c) => c.result && c.result.byLevel)
  };
}

// Field names the model's scripts read, against the Output interfaces.
const JS_NAMES = new Set(('length push map filter reduce forEach join split slice sort concat includes keys values entries ' +
  'log error then catch stringify parse assign from flat flatMap find findIndex some every indexOf toFixed trim replace ' +
  'match test exec padEnd padStart repeat toLowerCase toUpperCase startsWith endsWith localeCompare add has get set size ' +
  'env argv exit stdout write all allSettled resolve reject apply call bind max min round floor ceil abs sum ' +
  'toString json text status headers message stack name lines').split(' '));

function codeMode(uses, results, group, toolsList, msgOut) {
  const bash = uses.filter((u) => u.name === 'Bash');
  const reads = uses.filter((u) => u.name === 'Read');
  const readTypes = reads.some((u) => /types\.d\.ts$/.test(u.input.file_path || '')) ||
    bash.some((u) => /types\.d\.ts/.test(u.input.command || ''));
  const scripts = bash.map((u) => {
    const r = results.get(u.id) || {bytes: 0, text: ''};
    return {command: u.input.command, stdoutBytes: r.bytes, isError: r.isError, msg: u.msg,
      isNode: /(^|[;&|(]\s*|\bcd [^;&]+[;&]+\s*)node\b/.test(u.input.command || ''),
      callsCluster: /\bcluster\s*\(/.test(u.input.command || ''),
      outputTokens: msgOut.get(u.msg) || 0,
      // log lines in stdout, masked or not; and lines still holding a planted value
      printedLogLines: (r.text.match(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z (DEBUG|INFO|WARN|ERROR) /g) || []).length,
      printsRawLines: /\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z (DEBUG|INFO|WARN|ERROR) /.test(r.text),
      printsPlanted: allPlantedValues().some((v) => r.text.includes(v))};
  });
  // Node runs before the first one that calls cluster: exploring the API and
  // its output shape rather than doing the task.
  const nodeRuns = scripts.filter((x) => x.isNode);
  const firstCluster = nodeRuns.findIndex((x) => x.callsCluster);
  const explore = firstCluster < 0 ? nodeRuns : nodeRuns.slice(0, firstCluster);
  let fields = null;
  if (toolsList) {
    const outNames = new Set();
    for (const t of toolsList.tools) {
      if (!Object.values(LEAF).includes(t.name)) continue;
      JSON.stringify(t.outputSchema || {}, (k, v) => { if (k === 'properties' && v && typeof v === 'object') Object.keys(v).forEach((n) => outNames.add(n)); return v; });
    }
    const inNames = new Set();
    for (const t of toolsList.tools) {
      if (!Object.values(LEAF).includes(t.name)) continue;
      JSON.stringify(t.inputSchema || {}, (k, v) => { if (k === 'properties' && v && typeof v === 'object') Object.keys(v).forEach((n) => inNames.add(n)); return v; });
    }
    const accessed = new Set();
    for (const s of scripts) {
      // string literals and file names (types.d.ts, list.js) are not field reads
      const code = (s.command || '').replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""')
        .replace(/[\w./-]+\.(?:d\.ts|ts|js|mjs|cjs|json|md|log)\b/g, '');
      // a member access follows a name, ) or ]; `...x` is a spread, not a field
      for (const m of code.matchAll(/(?<=[\w$)\]])\??\.\s*([A-Za-z_$][\w$]*)/g)) accessed.add(m[1]);
    }
    fields = {accessed: [...accessed].sort(),
      notInOutput: [...accessed].filter((n) => !outNames.has(n) && !JS_NAMES.has(n) && !inNames.has(n)).sort()};
  }
  return {readTypes, readFiles: reads.map((u) => u.input.file_path), globs: uses.filter((u) => u.name === 'Glob').map((u) => u.input.pattern),
    bashRuns: scripts.length, scriptRuns: nodeRuns.length, stdoutBytes: nodeRuns.map((x) => x.stdoutBytes),
    otherBash: scripts.filter((x) => !x.isNode).map((x) => x.command.slice(0, 120)),
    printedRawLines: scripts.filter((x) => x.printsRawLines).length,
    printedLogLines: scripts.reduce((a, x) => a + x.printedLogLines, 0),
    printedPlanted: scripts.filter((x) => x.printsPlanted).length,
    exploreRuns: explore.length, exploreStdoutBytes: explore.reduce((a, x) => a + x.stdoutBytes, 0),
    exploreOutputTokens: [...new Set(explore.map((x) => x.msg))].reduce((a, m) => a + (msgOut.get(m) || 0), 0),
    scripts, fields};
}

// ---- report -----------------------------------------------------------------

function cmdReport(o) {
  const ref = loadRef(o.out);
  const toolsList = toolsFile(o);
  const ids = fs.readdirSync(o.out).filter((f) => f.endsWith('.meta.json')).map((f) => f.replace('.meta.json', '')).sort();
  const runs = ids.map((id) => analyse(o.out, id, ref, toolsList));
  fs.writeFileSync(path.join(o.out, 'analysis.json'), JSON.stringify(runs, null, 2));
  const lines = [];
  const p = (s) => lines.push(s);

  const valid = runs.filter((r) => !r.invalid.length && !r.stops.length);
  const models = [...new Set(runs.flatMap((r) => r.models))];
  p(`Runs: ${runs.length}, valid: ${valid.length}. Models seen: ${models.join(', ')}.`);
  if (models.length !== 1) p('**WARNING: more than one model id across runs.**');
  for (const r of runs.filter((x) => x.invalid.length || x.stops.length)) {
    p(`- ${r.id}: ${r.stops.length ? `STOP ${  r.stops.join('; ')}` : ''} ${r.invalid.length ? `INVALID ${  r.invalid.join('; ')}` : ''}`);
  }
  p('');

  const metric = {
    input: (r) => r.tokens.input, output: (r) => r.tokens.output, cacheWrite: (r) => r.tokens.cacheWrite,
    cacheRead: (r) => r.tokens.cacheRead, total: (r) => r.total, costUsd: (r) => r.costUsd,
    turns: (r) => r.numTurns, toolCalls: (r) => Object.values(r.toolCounts).reduce((a, b) => a + b, 0),
    wallS: (r) => r.wallMs / 1000
  };
  const stat = (rs, f) => { const xs = rs.map(f); return {med: median(xs), min: Math.min(...xs), max: Math.max(...xs), n: xs.length}; };
  const fmt = (s, d) => `${s.med.toFixed(d)} [${s.min.toFixed(d)}–${s.max.toFixed(d)}]`;
  const dec = {costUsd: 3, wallS: 1};

  // The token table and the ratios, for one set of runs.
  const tables = (subset) => {
    const cells = {};
    for (const r of subset) (cells[`${r.group}|${r.fixture || 'none'}`] = cells[`${r.group}|${r.fixture || 'none'}`] || []).push(r);
    p(`| group | fixture | n | ${  Object.keys(metric).join(' | ')  } |`);
    p(`|---|---|---|${  Object.keys(metric).map(() => '---').join('|')  }|`);
    for (const key of Object.keys(cells).sort()) {
      const [g, f] = key.split('|');
      const rs = cells[key];
      p(`| ${g} | ${f} | ${rs.length} | ${  Object.entries(metric).map(([k, fn]) => fmt(stat(rs, fn), dec[k] || 0)).join(' | ')  } |`);
    }
    p('');

      // Runs from a later batch (not in the matrix schedule, started after its
    // last run) and runs far above their cell's median, said in the report
    // itself since they set ranges the verdicts below depend on.
    const planned = new Set(schedule().map((c) => runId(c.group, c.fixture, c.rep)));
    const matrixEnd = subset.filter((r) => planned.has(r.id)).map((r) => r.startedAt).sort().pop();
    const later = subset.filter((r) => !planned.has(r.id) && r.startedAt > matrixEnd);
    if (later.length) {
      p(`Later batch, run after the matrix's last run (${matrixEnd}), so its prompt-cache conditions differ from the matrix's rotated order: ${later.map((r) => r.id).join(', ')}. D1 runs with a named rep in the same batch are the same-conditions check ("outside the cells" table).`);
      p('');
    }
    for (const key of Object.keys(cells).sort()) {
      const rs = cells[key];
      const mt = median(rs.map((r) => r.total));
      for (const r of rs.filter((x) => x.total > 1.5 * mt)) {
        p(`Outlier: ${r.id} total ${r.total} (cost ${r.costUsd.toFixed(4)} USD, cacheWrite ${r.tokens.cacheWrite}) is over 1.5× its cell's median total ${mt}; it sets the cell's upper range, not its median.`);
      }
    }
    p('');

  // Ratios: a direction word only where the two ranges do not overlap.
    p('| ratio | fixture | metric | median ratio | verdict |');
    p('|---|---|---|---|---|');
    const pairs = [['A', 'B'], ['D1', 'B'], ['D2', 'D1']];
    for (const [x, y] of pairs) {
      for (const f of Object.keys(FIXTURES)) {
        const rx = cells[`${x}|${f}`], ry = cells[`${y}|${f}`];
        if (!rx || !ry) continue;
        for (const k of ['input', 'output', 'cacheWrite', 'cacheRead', 'total', 'costUsd']) {
          const sx = stat(rx, metric[k]), sy = stat(ry, metric[k]);
          const ratio = sy.med === 0 ? (sx.med === 0 ? 1 : Infinity) : sx.med / sy.med;
          const verdict = sx.min > sy.max ? `${x} costs more` : sx.max < sy.min ? `${x} costs less` : 'within noise';
          p(`| ${x}/${y} | ${f} | ${k} | ${ratio === Infinity ? '∞' : ratio.toFixed(2)} | ${verdict} |`);
        }
      }
    }
    p('');
    return cells;
  };
  // The cells hold the matrix reps (and later batches given integer reps);
  // runs with a named rep (the gate, same-conditions checks) are listed on
  // their own below.
  const inMatrix = (r) => Number.isInteger(r.rep) && r.rep > 0;
  const cells = tables(valid.filter(inMatrix));

  // A run that is valid but did not do the whole task (an answer that misses
  // the reference counts, a file never read, a file whose warnings and errors
  // did not all reach cluster through redact) is a finding, not a measurement
  // of the task: the same tables again without such runs, where any differ.
  const complete = (r) => !r.correctness || (r.correctness.warnOk && r.correctness.errOk &&
    (!r.pipeline || (!r.pipeline.missingFiles.length && !r.pipeline.notRedacted.length)));
  const partial = valid.filter(inMatrix).filter((r) => !complete(r));
  if (partial.length) {
    p(`Valid runs that did not complete the task: ${partial.map((r) => r.id).join(', ')}. Tables without them:`);
    p('');
    tables(valid.filter(inMatrix).filter(complete));
  }

  // Fixed overhead, and each group minus turns x that overhead -- an
  // approximation: a later turn's prompt is not the control's one-turn prompt.
  // A and B are set against C (B's configuration, as specified); D1/D2
  // against CD (D's configuration with the same appended system text).
  const controls = {C: cells['C|none'], CD: cells['CD|none']};
  const controlPrompt = {};
  for (const [name, rs] of Object.entries(controls)) {
    if (!rs) continue;
    controlPrompt[name] = stat(rs, (r) => r.firstTurnPrompt);
    p(`${name} fixed overhead per turn (first-turn prompt tokens): ${fmt(controlPrompt[name], 0)}; ${name} cost: ${fmt(stat(rs, metric.costUsd), 3)} USD; output: ${fmt(stat(rs, metric.output), 0)}; cacheRead: ${fmt(stat(rs, metric.cacheRead), 0)}.`);
  }
  p('');
  p('API responses = distinct assistant message ids: one model request each, so parallel tool calls in one response count once (`turns` above is Claude Code\'s num_turns, which counts differently).');
  p('');
  p('| group | fixture | control | API responses (median) | total (median) | responses × control prompt | total − responses × control prompt (approx.) | share |');
  p('|---|---|---|---|---|---|---|---|');
  for (const key of Object.keys(cells).sort()) {
    const [g, f] = key.split('|');
    if (isControl(g)) continue;
    const ctl = g === 'D1' || g === 'D2' ? 'CD' : 'C';
    if (!controlPrompt[ctl]) continue;
    const rs = cells[key];
    const turns = median(rs.map((r) => r.apiResponses)), total = median(rs.map((r) => r.total));
    const fixed = turns * controlPrompt[ctl].med;
    p(`| ${g} | ${f} | ${ctl} | ${turns} | ${total} | ${fixed} | ${total - fixed} | ${((total - fixed) / total * 100).toFixed(0)}% |`);
  }
  p('');

  // First-turn prompt per group: the fixed context, which should differ
  // between A, B and C only by tool definitions and the prompt text.
  p('| group | first-turn prompt tokens (min–max) | init tools |');
  p('|---|---|---|');
  for (const g of ['A', 'B', 'C', 'D1', 'D2', 'CD']) {
    const rs = runs.filter((r) => r.group === g && r.firstTurnPrompt != null);
    if (!rs.length) continue;
    const xs = rs.map((r) => r.firstTurnPrompt);
    p(`| ${g} | ${Math.min(...xs)}–${Math.max(...xs)} | ${[...new Set(rs.map((r) => r.initTools.join(',')))].join(' / ')} |`);
  }
  p('');

  // Runs outside the matrix cells, each against its cell's median.
  const extra = valid.filter((r) => !inMatrix(r) && !isControl(r.group));
  if (extra.length) {
    p('| run (outside the cells) | total | cell median total | costUsd | cell median costUsd | WARN/ERROR ok |');
    p('|---|---|---|---|---|---|');
    for (const r of extra) {
      const rs = cells[`${r.group}|${r.fixture}`];
      const mt = rs ? median(rs.map((x) => x.total)) : NaN, mc = rs ? median(rs.map((x) => x.costUsd)) : NaN;
      p(`| ${r.id} | ${r.total} | ${mt} | ${r.costUsd.toFixed(4)} | ${mc.toFixed(4)} | ${r.correctness ? r.correctness.warnOk && r.correctness.errOk : '-'} |`);
    }
    p('');
  }

  // Privacy per group: of the planted values, how many reached the model's
  // context (any tool result) and its final answer.
  const nPlanted = allPlantedValues().length;
  p(`| group | fixture | runs with planted values in context | planted values in context (of ${nPlanted}), per run | runs with planted values in the answer |`);
  p('|---|---|---|---|---|');
  const byCell = {};
  // matrix reps only: the gate run's rep is not a number (stored as null)
  for (const r of runs.filter((x) => !isControl(x.group) && Number.isInteger(x.rep) && x.rep > 0)) {
    (byCell[`${r.group}|${r.fixture}`] = byCell[`${r.group}|${r.fixture}`] || []).push(r);
  }
  for (const key of Object.keys(byCell).sort()) {
    const [g, f] = key.split('|');
    const rs = byCell[key];
    p(`| ${g} | ${f} | ${rs.filter((r) => r.contextPlanted).length}/${rs.length} | ${rs.map((r) => r.contextPlanted).join(', ')} | ${rs.filter((r) => r.answerPlanted).length}/${rs.length} |`);
  }
  p('');

  // Correctness and privacy, per run of A and D.
  p('| run | WARN ok | ERROR ok | top-5 named / counts shown | files missing | files not fully redacted | cluster lines not from redact | raw planted lines to cluster | planted values in answer | compactions |');
  p('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of runs.filter((x) => !isControl(x.group))) {
    const cr = r.correctness || {}, pl = r.pipeline;
    p(`| ${r.id} | ${cr.warnOk} | ${cr.errOk} | ${cr.top5Mentioned}/${cr.top5CountShown} | ${pl ? pl.missingFiles.length : '-'} | ${pl ? pl.notRedacted.length : '-'} | ${pl ? pl.clusterLinesNotFromRedact : '-'} | ${pl ? pl.clusterRawPlantedLines : '-'} | ${r.answerPlanted} | ${r.compactions} |`);
  }
  p('');

  // A: how much of the output is the model writing data back out.
  p('| run | output tokens | in responses calling redact/cluster | share | argument bytes written |');
  p('|---|---|---|---|---|');
  for (const r of runs.filter((x) => x.group === 'A' && x.retype)) {
    const known = r.perTurnSums.outputKnown;
    p(`| ${r.id} | ${r.tokens.output} | ${known ? r.retype.outputTokens : 'n/a (no per-turn data)'} | ${known ? `${(r.retype.outputTokens / r.tokens.output * 100).toFixed(0)}%` : 'n/a'} | ${r.retype.argBytes} |`);
  }
  p('');

  // Code mode.
  p('other shell = Bash commands that are not node: read-only commands inside the working directory (ls, cat, head), which Claude Code allows without a rule; anything else is refused.');
  p('');
  p('| run | read types.d.ts | node runs | stdout bytes per run | log lines printed (masked or not) | runs printing a planted value | exploration runs before cluster (stdout bytes / output tokens) | fields not in Output | other shell |');
  p('|---|---|---|---|---|---|---|---|---|');
  for (const r of runs.filter((x) => x.code)) {
    const cm = r.code;
    p(`| ${r.id} | ${cm.readTypes} | ${cm.scriptRuns} | ${cm.stdoutBytes.join(', ')} | ${cm.printedLogLines} | ${cm.printedPlanted} | ${cm.exploreRuns} (${cm.exploreStdoutBytes} / ${cm.exploreOutputTokens}) | ${cm.fields ? cm.fields.notInOutput.join(', ') || 'none' : '-'} | ${cm.otherBash.length} |`);
  }
  console.log(lines.join('\n'));
  fs.writeFileSync(path.join(o.out, 'report.md'), `${lines.join('\n')  }\n`);
}

// ---- scrub ------------------------------------------------------------------

// Rewrites every file under <out> in place before it is committed: session
// and request ids, the user name, home directory, host name and temp working
// directories are replaced by placeholders, and the key (read from the MCP
// config) must not appear anywhere afterwards -- the scrub fails if it does.
function cmdScrub(o) {
  const {key} = readMcp(o.mcp);
  const user = os.userInfo().username, home = os.homedir(), host = os.hostname();
  const rules = [
    [new RegExp(escapeRe(home), 'g'), '<home>'],
    [new RegExp(`${escapeRe(os.tmpdir())  }/ch-token-[A-Za-z0-9]+`, 'g'), '<cwd>'],
    [new RegExp(`${escapeRe(os.tmpdir())  }/ch-token-mcp-\\d+\\.json`, 'g'), '<mcp-config>'],
    [/"session_id"\s*:\s*"[^"]*"/g, '"session_id":"<session>"'],
    [/"uuid"\s*:\s*"[^"]*"/g, '"uuid":"<uuid>"'],
    [/"request_id"\s*:\s*"[^"]*"/g, '"request_id":"<request>"'],
    [/\breq_[A-Za-z0-9]{10,}\b/g, '<request>'],
    [new RegExp(escapeRe(host), 'g'), '<host>'],
    [new RegExp(`\\b${escapeRe(user)}\\b`, 'g'), '<user>']
  ];
  let files = 0;
  const hits = [];
  for (const rel of listTree(o.out)) {
    const f = path.join(o.out, rel);
    let s = fs.readFileSync(f, 'utf8');
    for (const [re, rep] of rules) s = s.replace(re, rep);
    fs.writeFileSync(f, s);
    files++;
    for (const needle of [key, home, user, host]) if (s.includes(needle)) hits.push(`${rel}: still contains ${needle === key ? 'the key' : needle}`);
  }
  console.log(`scrubbed ${files} file(s)`);
  if (hits.length) { console.error(hits.join('\n')); process.exit(1); }
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- main -------------------------------------------------------------------

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cmd = o._[0];
  if (cmd === 'tools') return cmdTools(o);
  if (cmd === 'reference') return cmdReference(o);
  if (cmd === 'run') { await cmdRun(o); const v = analyse(o.out, runId(o.group, o.fixture, o.rep), loadRef(o.out), toolsFile(o)); console.log(JSON.stringify({stops: v.stops, invalid: v.invalid, tokens: v.tokens, costUsd: v.costUsd, turns: v.numTurns, tools: v.toolCounts, models: v.models, initTools: v.initTools, leaks: v.leaks}, null, 2)); return; }
  if (cmd === 'matrix') return cmdMatrix(o);
  if (cmd === 'report') return cmdReport(o);
  if (cmd === 'scrub') return cmdScrub(o);
  console.error('usage: token-cost-compare.js tools|reference|run|matrix|report ...');
  process.exit(2);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = {analyse, schedule, groupConfig};
