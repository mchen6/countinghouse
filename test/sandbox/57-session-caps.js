'use strict';
// B2 Task 2, spawned: a terminal tightening reaches a shared runtime's
// session's call already under way (#236 section 3: "at once" includes calls
// in flight). The runtime serves sessions on --sessionSocket, spawned as
// ch-local's daemon spawns it (C1 part 2's test does the same); ch-local's
// control channel sends the terminal's set. A call's timer is re-armed at the
// new timeout from its start (lib/session.js rearmAll), and its reply is held
// to the cap as it is at reply time. (A session's own overrides reach its
// calls through the same checks, server-free: sessions 07.)
//
// No port: the session socket is in the test's home.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const handshake = require('../../lib/session-transport/handshake');
const shim = require('../session-transport/helpers/shim');

const ROOT = path.join(__dirname, '..', '..');
const FRAMEWORK = path.join(ROOT, 'framework.js');
const MiB = 1024 * 1024;
const META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const until = async(test, ms = 30000) => {
  const end = Date.now() + ms;
  while (!(await test()) && Date.now() < end) await tick(100);
  return test();
};

// a scenario (the single-identity profile lists scenarios only): slow, and
// slow then big
function scenario(home) {
  const name = 'ch-session-caps';
  const dir = path.join(home, 'pack', name);
  const svc = 'capsService';
  fs.mkdirSync(path.join(dir, 'handlers', svc), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', license: 'Apache-2.0', countinghouse: {role: 'scenario'}}));
  const action = (a, d) => ({name: a, description: d, input: {schema: `/${svc}/${a}/input`}, output: {schema: `/${svc}/${a}/output`}});
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name, manufacturer: 'countinghouse-test', modelDescription: 'caps',
    serviceList: {[`urn:countinghouse-test:serviceID:${svc}`]: {actionList: [action('slow', 'waits input.ms'), action('slowBig', 'waits input.ms, then answers input.n bytes')]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    [svc]: {slow: {input: {type: 'object'}, output: {type: 'object'}}, slowBig: {input: {type: 'object'}, output: {type: 'object'}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', svc, 'slow.js'), 'module.exports = async (input) => { await new Promise((r) => setTimeout(r, input.ms)); return {output: {done: true}}; };\n');
  fs.writeFileSync(path.join(dir, 'handlers', svc, 'slowBig.js'), 'module.exports = async (input) => { await new Promise((r) => setTimeout(r, input.ms)); return {output: {big: "x".repeat(input.n)}}; };\n');
  return dir;
}

function runtime(home, extra) {
  const run = path.join(home, 'run', 'daemon');
  fs.mkdirSync(run, {recursive: true});
  fs.chmodSync(path.join(home, 'run'), 0o700);
  fs.chmodSync(run, 0o700);
  const socket = path.join(run, 's');
  const child = spawn(process.execPath, [FRAMEWORK, '--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
    '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc',
    '--sessionSocket', socket, ...extra], {stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: Object.assign({}, process.env, {COUNTINGHOUSE_GITHUB_TOKEN: '', GITHUB_TOKEN: ''})});
  const r = {child, socket, run, err: '', code: undefined};
  const replies = new Map();
  let nextControl = 1;
  child.on('message', (m) => { const f = m != null ? replies.get(m.id) : null; if (f != null) { replies.delete(m.id); f(m); } });
  r.control = (msg) => new Promise((resolve) => { const id = nextControl++; replies.set(id, resolve); child.send(Object.assign({}, msg, {id})); });
  child.stderr.on('data', (d) => { r.err += d; });
  child.stdout.on('data', () => {});
  r.exited = new Promise((res) => child.on('exit', (code) => { r.code = code; res(); }));
  child.on('error', () => {});
  return r;
}
const secretOf = (r) => { try { return handshake.parseSecret(fs.readFileSync(path.join(r.run, 'secret'), 'utf8')); } catch (e) { return null; } };
let nextSeq = 1;
function call(c, name, args) {
  const seq = nextSeq++;
  shim.message(c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method: 'tools/call', params: {_meta: META, name, arguments: args}}));
  return (async () => {
    for (;;) {
      const m = await shim.readM(c, 90000);
      if (m == null) return null;
      if (m.header != null && m.header.seq === seq) return JSON.parse(m.line.toString('utf8'));
    }
  })();
}
async function toolsOf(c) {
  const seq = nextSeq++;
  shim.message(c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method: 'tools/list', params: {_meta: META}}));
  for (;;) {
    const m = await shim.readM(c, 30000);
    if (m == null) return [];
    if (m.header != null && m.header.seq === seq) return (JSON.parse(m.line.toString('utf8')).result || {}).tools || [];
  }
}

describe('sandbox 57: a terminal tightening reaches a session\'s call under way (shared runtime B2, Task 2)', function() {
  this.timeout(180000);
  if (process.platform === 'win32') return;   // the named pipe is C2's
  let home;
  let r = null;
  let c = null;
  let tool = null;
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-b2-57-'));
    r = runtime(home, ['--loadModule', scenario(home), '--requestTimeout', '60', '--maxOutputBytes', String(4 * MiB)]);
    await until(async () => fs.existsSync(r.socket) && secretOf(r) != null);
    const a = await shim.session(r.socket, secretOf(r));
    assert.ok(a.welcome != null, `no session: ${r.err.slice(-1500)}`);
    c = a.c;
    let tools = [];
    await until(async () => { tools = await toolsOf(c); return tools.length > 0; });
    tool = (action) => tools.find((t) => new RegExp(`(^|_)${action.toLowerCase()}$`).test(t.name)).name;
  });
  afterEach(async () => {
    if (c != null) c.end();
    if (r != null && r.code === undefined) { r.child.kill('SIGKILL'); await r.exited; }
    r = null;
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('a call started under a 60 s timeout ends at a 5 s one set mid-call, measured from its start (re-armed)', async () => {
    const started = Date.now();
    const pending = call(c, tool('slow'), {ms: 30000});
    await tick(500);
    const set = await r.control({type: 'set', name: 'requestTimeout', value: 5});
    assert.strictEqual(set.ok, true, JSON.stringify(set));
    const res = await pending;
    const took = Date.now() - started;
    assert.ok(res != null && res.result != null && res.result.isError === true, JSON.stringify(res).slice(0, 400));
    assert.match(JSON.stringify(res), /DEVICE_NOT_RESPONDING|not responding/i);
    assert.ok(took >= 4500 && took < 15000, `${took} ms`);
  });

  it('a reply is held to the cap as it is at reply time: 1 MiB set mid-call refuses a 2 MiB answer', async () => {
    const pending = call(c, tool('slowBig'), {ms: 1500, n: 2 * MiB});
    await tick(300);
    const set = await r.control({type: 'set', name: 'maxOutputBytes', value: MiB});
    assert.strictEqual(set.ok, true, JSON.stringify(set));
    const res = await pending;
    assert.match(JSON.stringify(res).slice(0, 2000), /OUTPUT_TOO_LARGE|over the \d+-byte limit/);
  });
});
