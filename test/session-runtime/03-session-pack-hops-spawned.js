'use strict';
// Shared runtime B3, Task 8b (Task 4's spawned cases, moved here by the
// reviewer: before Task 8 nothing in a real runtime gives a session its own
// pack). A spawned runtime on --sessionSocket, two sessions through the
// test's shim, and the test answering the runtime's load-pack and
// unload-pack as ch-local's daemon does (a load or an unload on the control
// channel, then the reply).
//
// Fixtures, written into the test's home under --packsRoot:
//   - pack `back`: a scenario whose `echo` counts its runs (`runs`);
//   - pack `front` (global): a scenario with one tool, `relay`, that calls a
//     role-less part, relay-core, which declares a call on back's echo and
//     returns the call's result or the caught error's own fields.
// A module's declared call must name a module loaded when the module is
// verified, so back is loaded (for A, in conversation) before front. The
// plan's "ghost" (a module never installed) can't be declared at all: what
// B is compared with instead is the same hop once back is gone.
//
// Routed only: a shared runtime is the single-identity profile, which
// refuses --directPeerChannels ("--directPeerChannels and the single-identity
// profile: choose one"), so the direct path's session checks are Task 4's
// server-free cases (sessions 17), not a spawned runtime's.
//   - A's relay to back returns the echo, and back's runs count A's only;
//   - B's relay to back (hidden from B) is DEVICE_NOT_FOUND;
//   - after A ends and back is unloaded (the last one out), B's relay is the
//     same bytes as when back was hidden from it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const handshake = require('../../lib/session-transport/handshake');
const shim = require('../session-transport/helpers/shim');

const ROOT = path.join(__dirname, '..', '..');
const FRAMEWORK = path.join(ROOT, 'framework.js');
const META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
const FORMS = {_meta: Object.assign({}, META, {'io.modelcontextprotocol/clientCapabilities': {elicitation: {}}, 'io.modelcontextprotocol/clientInfo': {name: 'claude-code', version: '2.1.323'}})};
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const until = async(test, ms = 30000) => {
  const end = Date.now() + ms;
  while (!(await test()) && Date.now() < end) await tick(100);
  return test();
};

// one module: package.json, api.json, schema.json and its handlers
function writeModule(dir, {name, role, calls, svc, actions}) {
  for (const a of Object.keys(actions)) fs.mkdirSync(path.join(dir, 'handlers', svc), {recursive: true});
  const ch = Object.assign({}, role != null ? {role} : {}, calls != null ? {calls} : {});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', license: 'Apache-2.0', countinghouse: ch}));
  const friendlyName = name.replace(/^@[^/]+\//, '');
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName, manufacturer: 'countinghouse-test', modelDescription: friendlyName,
    serviceList: {[`urn:countinghouse-test:serviceID:${svc}`]: {actionList: Object.keys(actions).map((a) => ({name: a, description: `${a} it`,
      input: {schema: `/${svc}/${a}/input`}, output: {schema: `/${svc}/${a}/output`}}))}}}}));
  const schemas = {};
  for (const a of Object.keys(actions)) schemas[a] = {input: {type: 'object'}, output: {type: 'object'}};
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object', [svc]: schemas}));
  for (const [a, code] of Object.entries(actions)) fs.writeFileSync(path.join(dir, 'handlers', svc, `${a}.js`), code);
  return dir;
}
function packs(home) {
  const root = path.join(home, 'packs');
  const back = writeModule(path.join(root, 'back', 'node_modules', '@countinghouse', 'ch-pack-back'), {name: '@countinghouse/ch-pack-back', role: 'scenario', svc: 'echoService',
    actions: {
      echo: 'let runs = 0;\nmodule.exports = async () => { runs += 1; global.__backRuns = runs; return {output: {said: "echo"}}; };\n',
      runs: 'module.exports = async () => ({output: {runs: global.__backRuns || 0}});\n'
    }});
  const frontNm = path.join(root, 'front', 'node_modules');
  const front = writeModule(path.join(frontNm, '@countinghouse', 'ch-pack-front'), {name: '@countinghouse/ch-pack-front', role: 'scenario', svc: 'relayService',
    calls: ['relay-core/coreService.relay'],
    actions: {relay: 'module.exports = async (input, ctx) => ctx.call("relay-core/coreService.relay", {});\n'}});
  writeModule(path.join(frontNm, 'relay-core'), {name: 'relay-core', calls: ['ch-pack-back/echoService.echo'], svc: 'coreService',
    actions: {relay: 'module.exports = async (input, ctx) => {\n  try { return {output: {ok: true, result: (await ctx.call("ch-pack-back/echoService.echo", {})).output}}; }\n  catch (e) { return {output: {code: e.code != null ? e.code : null, message: String(e.message), fault: e.fault != null ? e.fault : null}}; }\n};\n'}});
  fs.writeFileSync(path.join(home, 'packs.json'), JSON.stringify({packs: {back: {packages: {'@countinghouse/ch-pack-back': '1.0.0'}}, front: {packages: {'@countinghouse/ch-pack-front': '1.0.0'}}}}));
  return {root, back, front};
}

// the runtime, spawned as ch-local daemon spawns it, the test answering its
// load-pack and unload-pack as the daemon does
function runtime(home, scenarios, extra = []) {
  const run = path.join(home, 'run', 'daemon');
  fs.mkdirSync(run, {recursive: true});
  fs.chmodSync(path.join(home, 'run'), 0o700);
  fs.chmodSync(run, 0o700);
  const socket = path.join(run, 's');
  const child = spawn(process.execPath, [FRAMEWORK, '--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
    '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc',
    '--sessionSocket', socket, '--settingsFile', path.join(home, 'settings.json'), '--packsRoot', scenarios.root, ...extra],
  {stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: Object.assign({}, process.env, {COUNTINGHOUSE_GITHUB_TOKEN: '', GITHUB_TOKEN: '',
    NODE_OPTIONS: `--require ${path.join(__dirname, '..', 'fixtures', 'session-elicitation-preload.js')}`})});
  const r = {child, socket, run, err: '', out: '', asked: []};
  const replies = new Map();
  let nextControl = 1;
  r.control = (msg) => new Promise((resolve) => { const id = nextControl++; replies.set(id, resolve); child.send(Object.assign({}, msg, {id})); });
  const scenarioOf = (pack) => ({name: `@countinghouse/ch-pack-${pack}`, scenario: scenarios[pack]});
  child.on('message', (m) => {
    if (m == null) return;
    if (m.type === 'ready') child.send({id: 'restore-1', type: 'restore', sessions: [], declines: [], reset: []});
    const f = replies.get(m.id);
    if (f != null) { replies.delete(m.id); return f(m); }
    // the daemon's part: a session's load-pack is a load for no one but it
    // (global: false), and an unload-pack is an unload
    if ((m.type === 'load-pack' || m.type === 'unload-pack') && typeof(m.id) === 'string') {
      r.asked.push({type: m.type, name: m.name});
      const s = scenarioOf(m.name);
      const msg = m.type === 'load-pack' ? {type: 'load', name: s.name, scenario: s.scenario, pack: m.name, global: false} : {type: 'unload', name: s.name, pack: m.name};
      r.control(msg).then((reply) => child.send({id: m.id, ok: reply.ok === true, code: reply.code}));
    }
    return undefined;
  });
  child.stderr.on('data', (d) => { r.err += d; });
  child.stdout.on('data', (d) => { r.out += d; });
  r.exited = new Promise((res) => child.on('exit', (code, signal) => res({code, signal})));
  child.on('error', () => {});
  return r;
}
const secretOf = (r) => {
  try { return handshake.parseSecret(fs.readFileSync(path.join(r.run, 'secret'), 'utf8')); } catch (e) { return null; }
};
let nextSeq = 1;
async function request(c, method, params = {}, meta = {_meta: META}) {
  const seq = nextSeq++;
  shim.message(c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method, params: Object.assign({}, meta, params)}));
  for (;;) {
    const m = await shim.readM(c, 60000);
    if (m == null) return null;
    if (m.header != null && m.header.seq === seq) return JSON.parse(m.line.toString('utf8'));
  }
}
// a settings call that answers the runtime's conditions? with yes, once
async function settings(s, args, extra = {}) {
  const seq = nextSeq++;
  shim.message(s.c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method: 'tools/call', params: Object.assign({name: 'countinghouse_settings', arguments: args}, FORMS, extra)}));
  const q = await s.c.json('C', 20000);
  if (q != null) s.c.send('C', {op: 'client', seq: q.seq, status: 'ok', conditions: 'yes', repo: null, token: null});
  for (;;) {
    const m = await shim.readM(s.c, 60000);
    if (m == null) return null;
    if (m.header != null && m.header.seq === seq) return JSON.parse(m.line.toString('utf8'));
  }
}
const tool = async(s, name, args = {}) => {
  const got = await request(s.c, 'tools/call', {name, arguments: args});
  return got != null && got.result != null ? got.result : got;
};

[['routed', []]].forEach(([how, flags]) => {
  describe(`session-runtime 03: a session's pack at every hop, spawned (shared runtime B3, Task 8b), ${how}`, function() {
    this.timeout(180000);
    if (process.platform === 'win32') return;   // the named pipe is C2's
    let home;
    let r;
    beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sr3-')); });
    afterEach(async() => {
      if (r != null && r.child.exitCode === null) { r.child.kill('SIGKILL'); await r.exited; }
      r = null;
      fs.rmSync(home, {recursive: true, force: true});
    });

    it('A turns back on and relays to it; B\'s relay is DEVICE_NOT_FOUND; after A ends and back is unloaded, B\'s relay is the same bytes', async() => {
      const fixtures = packs(home);
      r = runtime(home, fixtures, flags);
      await until(async() => fs.existsSync(r.socket) && secretOf(r) != null);
      const secret = secretOf(r);
      const open = async() => { try { return await shim.session(r.socket, secret); } catch (e) { throw new Error(`${e.message}\n${r.err.slice(-2000)}`); } };
      const a = await open();
      const b = await open();
      // A turns back on in its own form, accepted: the runtime asks the daemon's load-pack
      const ask = await settings(a, {action: 'set', name: 'pack.back', value: 'on'});
      assert.strictEqual(ask.result.resultType, 'input_required', JSON.stringify(ask).slice(0, 600));
      const done = await settings(a, {action: 'set', name: 'pack.back', value: 'on'},
        {requestState: ask.result.requestState, inputResponses: {approve: {action: 'accept', content: {approve: true}}}});
      assert.strictEqual(done.result.structuredContent != null && done.result.structuredContent.applies, 'this session', `${JSON.stringify(done).slice(0, 600)}\n${r.err.slice(-1500)}`);
      assert.deepStrictEqual(r.asked, [{type: 'load-pack', name: 'back'}]);
      // front, global (the terminal's), loaded once back is there to declare a call on
      const front = await r.control({type: 'load', name: '@countinghouse/ch-pack-front', scenario: fixtures.front, pack: 'front', global: true});
      assert.strictEqual(front.ok, true, `${JSON.stringify(front)}\n${r.err.slice(-1500)}`);
      // A lists back's tools, B doesn't; both list front's
      const names = async(s) => (await request(s.c, 'tools/list')).result.tools.map((t) => t.name);
      assert.ok(await until(async() => (await names(a)).includes('relay')), JSON.stringify(await names(a)));
      assert.deepStrictEqual([(await names(a)).includes('echo'), (await names(b)).includes('echo'), (await names(b)).includes('relay')], [true, false, true]);
      // A's relay reaches back's echo
      const fromA = await tool(a, 'relay');
      assert.deepStrictEqual(fromA.structuredContent, {ok: true, result: {said: 'echo'}}, JSON.stringify(fromA).slice(0, 600));
      // B's relay: back is hidden from B, as a device never hosted
      const fromB = await tool(b, 'relay');
      assert.strictEqual(fromB.structuredContent.code, 'DEVICE_NOT_FOUND', JSON.stringify(fromB).slice(0, 600));
      // and again: the same answer
      const again = await tool(b, 'relay');
      assert.strictEqual(JSON.stringify(again.structuredContent), JSON.stringify(fromB.structuredContent), 'the same after A\'s channel');
      // back's runs count A's call only
      assert.deepStrictEqual((await tool(a, 'runs')).structuredContent, {runs: 1});
      // A ends (its shim says bye): the last one out of back asks its unload; then B's relay is the same bytes
      a.c.send('C', {op: 'bye'});
      assert.ok(await until(async() => r.asked.some((m) => m.type === 'unload-pack' && m.name === 'back')), JSON.stringify(r.asked));
      assert.ok(await until(async() => !(await names(b)).includes('echo') && (await tool(b, 'relay')).structuredContent.code === 'DEVICE_NOT_FOUND'));
      const gone = await tool(b, 'relay');
      assert.strictEqual(JSON.stringify(gone.structuredContent), JSON.stringify(fromB.structuredContent), 'hidden and gone: one answer');
      b.c.end();
    });
  });
});
