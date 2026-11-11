// The cases test/mcp-contract/07-error-shape.js pins, run against a server
// that has test/fixtures/error-shape-module loaded with
// test/mcp-contract/error-shape-auth.json. Shared with
// test/mcp-contract/capture-error-shape.js, so the golden and the check send
// exactly the same requests.
//
// Every answer is recorded whole: the HTTP status and the body. Only values
// that differ from run to run are replaced: a task id, a time, a stack
// (each with a placeholder that says what was there), and nothing else.
const request = require('supertest');
const {deviceIDForName} = require('../../lib/call-address');

const KEY       = 'error-shape-key';
const NO_ACCESS = 'error-shape-no-access';
const UNKNOWN   = 'error-shape-unknown-key';
const DEVICE    = deviceIDForName('error-shape-module');
const SERVICE   = 'urn:countinghouse-test:serviceID:shapeService';
const MISSING   = '00000000-0000-0000-0000-000000000000';
const tool      = (action) => `error_shape_module_shapeservice_${action.toLowerCase()}`;
const sleep     = (ms) => new Promise((r) => setTimeout(r, ms));

// The outcomes; `args` is the action's input.
const OUTCOMES = [
  {name: 'success', action: 'ok', args: {}},
  {name: 'bad input', action: 'needsInput', args: {}},
  {name: 'module throw', action: 'throwPlain', args: {}},
  {name: 'module callback error', action: 'callbackPlain', args: {}},
  {name: 'module typed error', action: 'callbackTyped', args: {}},
  {name: 'unknown tool', action: 'nope', args: {}},
  // step 1 (d1): a module's own error, handed back four ways, and a lookalike
  {name: 'module error returned', action: 'returnError', args: {}},
  {name: 'module error returned async', action: 'returnErrorAsync', args: {}},
  {name: 'module error thrown', action: 'throwError', args: {}},
  {name: 'module error called back', action: 'callbackError', args: {}},
  {name: 'lookalike returned', action: 'returnLookalike', args: {}},
  // step 1 (d2): thrown from a plain function; a plain Error with a module's
  // code; codes that are not a module's (a system error's, Node's ERR_, an
// errno name with no errno, as a network failure has); and
  // the old module-visible globals, which are gone
  {name: 'module error thrown sync', action: 'throwErrorSync', args: {}},
  {name: 'plain error with a module code', action: 'throwPlainCoded', args: {}},
  {name: 'plain error with a system code', action: 'throwSystemCoded', args: {}},
  {name: 'plain error with a Node code', action: 'throwNodeCoded', args: {}},
  {name: 'plain error with a network code', action: 'throwNetworkCoded', args: {}},
  {name: 'old globals', action: 'globalsProbe', args: {}}
];

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value == null || typeof(value) !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'stack' && typeof(v) === 'string') out[k] = '<stack>';
    else if (k === 'taskId' && typeof(v) === 'string') out[k] = '<taskId>';
    else if (/At$/.test(k) && typeof(v) === 'string' && !isNaN(Date.parse(v))) out[k] = '<time>';
    else if (k === 'text' && typeof(v) === 'string') out[k] = normalizeText(v);
    else out[k] = normalize(v);
  }
  return out;
}

// A tool result's text is JSON when it carries a fault: normalize inside it.
function normalizeText(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed != null && typeof(parsed) === 'object') return JSON.stringify(normalize(parsed));
  } catch (e) { /* plain text */ }
  return text;
}

const answer = (res) => ({status: res.status, body: normalize(res.body)});

function http(port, key, deviceID, action, args) {
  const req = request(`http://127.0.0.1:${port}`).post(`/devices/${deviceID}/invoke-action`);
  if (key != null) req.set('X-CH-Key', key);
  return req.send({serviceID: SERVICE, actionName: action, input: args}).then(answer);
}

function mcp(port, key, method, params) {
  const req = request(`http://127.0.0.1:${port}`).post('/mcp').set('Accept', 'application/json, text/event-stream');
  if (key != null) req.set('X-CH-Key', key);
  return req.send({jsonrpc: '2.0', id: 1, method: method, params: params});
}

async function viaTask(port, key, action, args) {
  const created = await mcp(port, key, 'tools/call', {name: tool(action), arguments: args, task: {}});
  const task = created.body && created.body.result && created.body.result.task;
  if (task == null) return {created: answer(created)};
  const deadline = Date.now() + 20000;
  let got = null;
  for (;;) {
    got = await mcp(port, key, 'tasks/get', {taskId: task.taskId});
    const status = got.body.result && got.body.result.status;
    if (status !== 'working' && status !== 'submitted') break;
    if (Date.now() > deadline) throw new Error(`task for ${action} did not settle: ${JSON.stringify(got.body)}`);
    await sleep(100);
  }
  const result = await mcp(port, key, 'tasks/result', {taskId: task.taskId});
  return {created: answer(created), settled: answer(got), result: answer(result)};
}

// Runs every case in a fixed order; returns {"<path> / <case>": answer}.
// tasks: false for a mode that refuses task-augmented calls; its refusal is
// recorded once instead of once per case.
async function runCases(port, tasks) {
  const out = {};
  for (const o of OUTCOMES) {
    out[`http invoke-action / ${o.name}`] = await http(port, KEY, DEVICE, o.action, o.args);
    out[`mcp tools/call / ${o.name}`] = answer(await mcp(port, KEY, 'tools/call', {name: tool(o.action), arguments: o.args}));
    if (tasks) out[`mcp tasks/result / ${o.name}`] = await viaTask(port, KEY, o.action, o.args);
  }
  out['http invoke-action / missing device'] = await http(port, KEY, MISSING, 'ok', {});
  // Known exception, kept on purpose: the "unknown key" answers echo the
  // presented key ("Unknown user: <key>", HTTP and MCP). An API key in error
  // text is what R2-1 Task 5 removes (implementer A: "SYSTEM_ERROR_UNKNOWN_USER
  // names no key at all", with a near-miss test; the R2-1 plan,
  // docs/superpowers/plans/2026-11-08-r2-1-no-raw-keys-in-modules.md, and the
  // logger-design spec). Task 5 updates this golden deliberately, as a listed
  // exception: do not "fix" it in step 1 or step 3 of the logger series.
  for (const [label, key] of [['no access', NO_ACCESS], ['unknown key', UNKNOWN], ['no key', null]]) {
    out[`http invoke-action / ${label}`] = await http(port, key, DEVICE, 'ok', {});
    out[`mcp tools/call / ${label}`] = answer(await mcp(port, key, 'tools/call', {name: tool('ok'), arguments: {}}));
    if (tasks) out[`mcp tasks/result / ${label}`] = await viaTask(port, key, 'ok', {});
  }
  if (!tasks) out['mcp tasks/result / refused in this mode'] = await viaTask(port, KEY, 'ok', {});
  return out;
}

// The two modes the golden records: worker threads (the default) and the
// single-thread mode, which refuses tasks. A module's error answers the same
// in both (step 1 (d2): the worker reply carries it whole).
const MODES = {
  worker: {flags: ['--workerThread'], tasks: true},
  'single-thread': {flags: ['--no-workerThread'], tasks: false}
};

module.exports = {runCases, MODES, DEVICE, normalize};
