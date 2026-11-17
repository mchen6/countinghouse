'use strict';
// R1 Task 4 (#236 section 4a; plan docs/superpowers/plans/
// 2026-11-16-shared-runtime-r1-per-session-modules.md, Task 4 and the
// Reviewer's P1-P5): a per-session module on the shared runtime, spawned as
// ch-local daemon spawns it (session-runtime 01's harness). Each session
// gets its own worker, store partition and files; the cap evicts only an
// idle worker and says so; a crash or a reload touches what it must and no
// more; an unload leaves no worker; and every path not yet routed to a
// session's worker (Task 5) fails closed, never with a TypeError or a hang.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const handshake = require('../../lib/session-transport/handshake');
const shim = require('../session-transport/helpers/shim');

const ROOT = path.join(__dirname, '..', '..');
const FRAMEWORK = path.join(ROOT, 'framework.js');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'per-session-module');
const NAME = 'per-session-module';
const META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
const RESET = `${NAME}'s in-memory state was reset; its files were kept`;
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const until = async(test, ms = 30000) => {
  const end = Date.now() + ms;
  while (!(await test()) && Date.now() < end) await tick(100);
  return test();
};

// the fixture as a scenario (the single-identity profile lists scenarios),
// copied into the test's home; `edit` changes its touch handler (a reload's
// new code)
function perSession(home, {dir = path.join(home, 'pack', NAME), version = '1.0.0', edit = null, role = 'scenario'} = {}) {
  fs.cpSync(FIXTURE, dir, {recursive: true});
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  pkg.version = version;
  pkg.countinghouse = Object.assign({}, pkg.countinghouse, {role});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  if (edit != null) {
    const f = path.join(dir, 'handlers', 'stateService', 'touch.js');
    fs.writeFileSync(f, edit(fs.readFileSync(f, 'utf8')));
  }
  return dir;
}
// a shared scenario that hops into the per-session module (P1: fails closed
// until Task 5 routes a hop to the session's worker); the part it calls is
// installed beside it, as a pack's are
function caller(home) {
  const dir = path.join(home, 'hop', 'node_modules', 'ps-caller');
  const svc = 'callerService';
  fs.mkdirSync(path.join(dir, 'handlers', svc), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'ps-caller', version: '1.0.0', license: 'Apache-2.0',
    countinghouse: {role: 'scenario', calls: [`${NAME}/stateService.touch`]}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: 'ps-caller', manufacturer: 'countinghouse-test', modelDescription: 'hops',
    serviceList: {[`urn:countinghouse-test:serviceID:${svc}`]: {actionList: [{name: 'hop', description: 'hops into the per-session module',
      input: {schema: `/${svc}/hop/input`}, output: {schema: `/${svc}/hop/output`}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    [svc]: {hop: {input: {type: 'object'}, output: {type: 'object'}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', svc, 'hop.js'),
    `module.exports = async (input, ctx) => {
  try { await ctx.call('${NAME}/stateService.touch', {}); return {output: {code: null}}; }
  catch (e) { return {output: {code: (e && e.code) || null, message: String(e && e.message).slice(0, 200)}}; }
};\n`);
  return dir;
}

function runtime(home, extra = [], {restore = true} = {}) {
  const run = path.join(home, 'run', 'daemon');
  fs.mkdirSync(run, {recursive: true});
  fs.chmodSync(path.join(home, 'run'), 0o700);
  fs.chmodSync(run, 0o700);
  const socket = path.join(run, 's');
  const child = spawn(process.execPath, [FRAMEWORK, '--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
    '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc',
    '--sessionSocket', socket, ...extra], {stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: Object.assign({}, process.env, {COUNTINGHOUSE_GITHUB_TOKEN: '', GITHUB_TOKEN: ''})});
  const r = {child, socket, run, err: '', out: '', code: undefined};
  const replies = new Map();
  let nextControl = 1;
  child.on('message', (m) => {
    if (m != null && m.type === 'ready' && restore) child.send({id: 'restore-1', type: 'restore', sessions: [], declines: [], reset: []});
    const f = m != null ? replies.get(m.id) : null; if (f != null) { replies.delete(m.id); f(m); }
  });
  r.control = (msg) => new Promise((resolve) => { const id = nextControl++; replies.set(id, resolve); child.send(Object.assign({}, msg, {id})); });
  child.stderr.on('data', (d) => { r.err += d; });
  child.stdout.on('data', (d) => { r.out += d; });
  r.exited = new Promise((res) => child.on('exit', (code, signal) => { r.code = code; res({code, signal}); }));
  child.on('error', () => {});
  r.log = () => r.out + r.err;
  return r;
}
const secretOf = (r) => {
  try { return handshake.parseSecret(fs.readFileSync(path.join(r.run, 'secret'), 'utf8')); } catch (e) { return null; }
};
let nextSeq = 1;
// one request; its answer (or null). `onSent` runs once it is written.
async function request(c, method, params = {}) {
  const seq = nextSeq++;
  shim.message(c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method, params: Object.assign({_meta: META}, params)}));
  for (;;) {
    const m = await shim.readM(c, 60000);
    if (m == null) return null;
    if (m.header != null && m.header.seq === seq) return JSON.parse(m.line.toString('utf8'));
  }
}
const texts = (res) => (res != null && res.result != null && Array.isArray(res.result.content)) ? res.result.content.map((b) => b.text || '').join('\n') : JSON.stringify(res);
function outOf(res) {
  assert.ok(res != null && res.result != null && res.result.isError !== true, JSON.stringify(res).slice(0, 800));
  if (res.result.structuredContent != null) return res.result.structuredContent;
  return JSON.parse(res.result.content[0].text);
}
// how many session workers came up and ended, by the runtime's own lines
const counts = (r) => ({up: (r.log().match(/a session's worker is up/g) || []).length, ended: (r.log().match(/a session's worker ended/g) || []).length});

describe('session-runtime 03: per-session workers (R1 Task 4)', function() {
  this.timeout(180000);
  if (process.platform === 'win32') return; // the named pipe is C2's
  let home;
  let r = null;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sr3-')); });
  afterEach(async() => {
    if (r != null && r.code === undefined) { r.child.kill('SIGKILL'); await r.exited; }
    r = null;
    fs.rmSync(home, {recursive: true, force: true});
  });

  // the runtime up with `extra`, and two sessions with the touch tool listed
  async function twoSessions(extra = [], modules = [perSession(home)], wanted = ['touch']) {
    r = runtime(home, [...modules.flatMap((m) => ['--loadModule', m]), ...extra]);
    await until(async() => fs.existsSync(r.socket) && secretOf(r) != null);
    const secret = secretOf(r);
    assert.ok(secret != null, `no secret: ${r.log().slice(-3000)}`);
    const out = {};
    for (const s of ['A', 'B']) {
      const a = await shim.session(r.socket, secret);
      assert.ok(a.welcome != null, JSON.stringify(a.refused));
      out[s] = {c: a.c, id: a.welcome.session};
    }
    let tools = [];
    await until(async() => {
      const list = await request(out.A.c, 'tools/list');
      tools = (list != null && list.result != null) ? list.result.tools.map((t) => t.name) : [];
      return wanted.every((w) => tools.some((t) => new RegExp(`${w}$`).test(t)));
    });
    for (const w of wanted) assert.ok(tools.some((t) => new RegExp(`${w}$`).test(t)), `${w} not listed: ${tools.join(', ')}\n${r.log().slice(-4000)}`);
    out.tool = (action) => tools.find((t) => new RegExp(`${action}$`).test(t));
    out.tools = tools;
    out.call = (s, action, args = {}) => request(out[s].c, 'tools/call', {name: out.tool(action), arguments: args});
    return out;
  }
  const partition = (sid) => path.join(home, 'module_data', NAME, 'sessions', sid, 'data');

  it('two sessions each have their own worker, store partition and files; no session id reaches the module', async() => {
    const s = await twoSessions();
    // listed as before, schemas included, with no worker (the record's copy)
    const listed = (await request(s.A.c, 'tools/list')).result.tools.find((t) => t.name === s.tool('touch'));
    assert.strictEqual(listed.inputSchema.type, 'object', JSON.stringify(listed));
    assert.ok(listed.outputSchema != null && listed.outputSchema.properties.file != null, JSON.stringify(listed));
    assert.deepStrictEqual(counts(r), {up: 0, ended: 0}, 'listing starts no worker');
    assert.deepStrictEqual(outOf(await s.call('A', 'touch')), {file: 1, store: 1, memory: 1});
    assert.deepStrictEqual(outOf(await s.call('A', 'touch')), {file: 2, store: 2, memory: 2});
    assert.deepStrictEqual(outOf(await s.call('B', 'touch')), {file: 1, store: 1, memory: 1}, 'B\'s own state');
    assert.strictEqual(fs.readFileSync(path.join(partition(s.A.id), 'count'), 'utf8'), '2');
    assert.strictEqual(fs.readFileSync(path.join(partition(s.B.id), 'count'), 'utf8'), '1');
    assert.ok(!fs.existsSync(path.join(home, 'module_data', NAME, 'data', 'count')), 'nothing in the module\'s shared /data');
    for (const who of ['A', 'B']) {
      const seen = fs.readFileSync(path.join(partition(s[who].id), 'seen.json'), 'utf8');
      for (const sid of [s.A.id, s.B.id]) assert.ok(!seen.includes(sid), `${who}'s worker saw a session id: ${seen.slice(0, 600)}`);
      assert.ok(!seen.includes('/sessions/'), 'nor the partition\'s host path');
    }
    assert.deepStrictEqual(counts(r), {up: 2, ended: 0});
  });

  it('at --maxSessionWorkers 1, B\'s call evicts A\'s idle worker: A is told, and keeps its files and store', async() => {
    const s = await twoSessions(['--maxSessionWorkers', '1']);
    outOf(await s.call('A', 'touch'));
    outOf(await s.call('B', 'touch'));
    const again = await s.call('A', 'touch');
    assert.deepStrictEqual(outOf(again), {file: 2, store: 2, memory: 1}, 'files and store kept, memory reset');
    assert.ok(texts(again).includes(RESET), texts(again));
  });

  it('never mid-call: with A\'s call in flight at --maxSessionWorkers 1, B is SESSION_WORKERS_BUSY and A\'s call completes', async() => {
    const s = await twoSessions(['--maxSessionWorkers', '1']);
    const held = s.call('A', 'hold', {ms: 3000});
    await until(async() => counts(r).up === 1, 20000);
    await tick(300);
    const busy = await s.call('B', 'touch');
    assert.ok(/SESSION_WORKERS_BUSY|per-session module workers are busy/.test(JSON.stringify(busy)), JSON.stringify(busy).slice(0, 800));
    assert.deepStrictEqual(outOf(await held), {held: 3000});
    assert.strictEqual(counts(r).ended, 0, 'A\'s worker was never taken');
  });

  it('a crash of A\'s worker: A\'s next call starts a fresh one and is told; B\'s worker, state and the listing are untouched', async() => {
    const s = await twoSessions();
    outOf(await s.call('A', 'touch'));
    outOf(await s.call('B', 'touch'));
    outOf(await s.call('A', 'crash'));
    await until(async() => counts(r).ended === 1, 20000);
    const a = await s.call('A', 'touch');
    assert.deepStrictEqual(outOf(a), {file: 2, store: 2, memory: 1});
    assert.ok(texts(a).includes(RESET), texts(a));
    assert.deepStrictEqual(outOf(await s.call('B', 'touch')), {file: 2, store: 2, memory: 2}, 'B\'s worker ran on');
    const list = await request(s.B.c, 'tools/list');
    assert.deepStrictEqual(list.result.tools.map((t) => t.name), s.tools);
  });

  it('a reload stops every session\'s worker; the next calls run the new code on the files kept', async() => {
    // a reload in place takes a pack version under --packsRoot, laid out
    // as ch-local lays it (test/stdio/16)
    const s = await twoSessions(['--packsRoot', path.join(home, 'packs')]);
    outOf(await s.call('A', 'touch'));
    outOf(await s.call('B', 'touch'));
    const v2 = perSession(home, {dir: path.join(home, 'packs', NAME, '1.1.0', 'node_modules', NAME), version: '1.1.0',
      edit: (src) => src.replace('return {output: {file: n, store: stored, memory}};', 'return {output: {file: n, store: stored, memory: memory + 1000}};')});
    // on the shared runtime a pack message names its pack, and a reload whether it is global (B3, lib/pack-control.js)
    const answer = await r.control({type: 'reload', name: NAME, scenario: v2, pack: NAME, global: true});
    assert.strictEqual(answer.ok, true, JSON.stringify(answer));
    await until(async() => counts(r).ended === 2, 20000);
    assert.deepStrictEqual(outOf(await s.call('A', 'touch')), {file: 2, store: 2, memory: 1001});
    assert.deepStrictEqual(outOf(await s.call('B', 'touch')), {file: 2, store: 2, memory: 1001});
  });

  it('an unload while a call is under way: the call ends refused or completed, and then no session worker is left', async() => {
    const s = await twoSessions();
    outOf(await s.call('B', 'touch'));
    const held = s.call('A', 'hold', {ms: 1500});
    await until(async() => counts(r).up === 2, 20000);
    const answer = await r.control({type: 'unload', name: NAME, pack: NAME});
    assert.strictEqual(answer.ok, true, JSON.stringify(answer));
    const a = await held;
    assert.ok(a != null && a.result != null, JSON.stringify(a));
    if (a.result.isError === true) assert.ok(/MODULE_UNLOADED|unloaded|DEVICE_NOT_FOUND|not found/i.test(texts(a)), texts(a));
    else assert.deepStrictEqual(outOf(a), {held: 1500});
    await until(async() => counts(r).ended === counts(r).up, 10000);
    const c = counts(r);
    assert.strictEqual(c.ended, c.up, `${c.up} up, ${c.ended} ended`);
    const after = await s.call('A', 'touch');
    assert.ok(after.result == null || after.result.isError === true || after.error != null, 'unloaded');
    await tick(500);
    assert.deepStrictEqual(counts(r), c, 'nothing started after the unload');
  });

  // On the shared runtime peer channels are always off (it is the
  // single-identity profile: lib/local-profile.js), so a hop takes the
  // main-thread route; Task 5 routes it to the session's worker.
  it('a path not yet routed to a session\'s worker (Task 5) fails closed: a hop into it is DEVICE_NOT_FOUND, no TypeError, no hang', async() => {
    const part = perSession(home, {dir: path.join(home, 'hop', 'node_modules', NAME), role: 'part'});
    const s = await twoSessions([], [part, caller(home)], ['hop']);
    const hop = await request(s.A.c, 'tools/call', {name: s.tools.find((t) => /hop$/.test(t)), arguments: {}});
    const out = outOf(hop);
    assert.strictEqual(out.code, 'DEVICE_NOT_FOUND', JSON.stringify(out));
    assert.ok(!/TypeError|is not a function|Cannot read/.test(r.log()), r.log().slice(-3000));
    assert.deepStrictEqual(counts(r), {up: 0, ended: 0}, 'no session worker was started for a hop');
  });

  it('its resource (M7): resources/read goes the call path\'s way, to the reading session\'s own worker and files', async() => {
    const s = await twoSessions();
    outOf(await s.call('A', 'touch'));
    outOf(await s.call('A', 'touch'));
    outOf(await s.call('B', 'touch'));
    const list = await request(s.A.c, 'resources/list');
    const res = (list.result.resources || []).find((x) => /\/count$/.test(x.uri));
    assert.ok(res != null, JSON.stringify(list).slice(0, 800));
    const readA = await request(s.A.c, 'resources/read', {uri: res.uri});
    const readB = await request(s.B.c, 'resources/read', {uri: res.uri});
    assert.strictEqual(readA.result.contents[0].text, '2', JSON.stringify(readA));
    assert.strictEqual(readB.result.contents[0].text, '1', JSON.stringify(readB));
    assert.deepStrictEqual(counts(r), {up: 2, ended: 0}, 'no worker of its own for a read');
  });

  // the review of #356, 1: a per-session module is held to the message rate
  // as any module is (declaring "per-session" escapes nothing)
  it('--moduleMessageRate holds a session\'s worker too: a flood from it is RATE_LIMITED', async() => {
    const s = await twoSessions(['--moduleMessageRate', '50']);
    const out = outOf(await s.call('A', 'flood'));
    assert.strictEqual(out.total, 500);
    assert.ok(out.limited > 0, `limited ${out.limited} of 500`);
  });

  // the review of #356, 2: a session's spawn registers no remote, so it
  // can't close another session's remote clients, and a failed one can't
  // unregister the module's remotes for every session
  it('remotes: a remote call in flight in A survives B\'s first call; a session spawn that fails leaves the module\'s remotes in place', async() => {
    const {startRemoteServer} = require('../helpers/remote-mcp-server');
    const {testPort} = require('../helpers/test-env');
    const port = testPort(9693);
    const remote = await startRemoteServer(port);
    try {
      const dir = path.join(home, 'pack', 'remote-probe');
      fs.cpSync(path.join(__dirname, '..', 'fixtures', 'remote-probe'), dir, {recursive: true});
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      pkg.countinghouse = Object.assign({}, pkg.countinghouse, {role: 'scenario', state: 'per-session'});
      pkg.countinghouse.remotes[0].url = `http://127.0.0.1:${port}/mcp`;
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
      const allowance = path.join(home, 'remote-credentials.json');
      fs.writeFileSync(allowance, JSON.stringify({[`http://127.0.0.1:${port}`]: ['CH_TEST_REMOTE_TOKEN']}));
      process.env.CH_TEST_REMOTE_TOKEN = 'per-session-remote-token';
      let s;
      try {
        s = await twoSessions(['--debug', '--remoteCredentials', allowance], [dir], ['calltool']);
      } finally {
        delete process.env.CH_TEST_REMOTE_TOKEN;
      }
      const call = (who, tool) => request(s[who].c, 'tools/call', {name: s.tool('calltool'), arguments: {tool, args: {text: who}}});
      // A's call held at the remote (3 s) while B's first call spawns B's worker
      const slow = call('A', 'slow');
      await until(async() => counts(r).up === 1, 20000);
      await tick(300);
      const b = outOf(await call('B', 'echo_text'));
      assert.ok(b.result != null, `B's remote call: ${JSON.stringify(b)}`);
      const a = outOf(await slow);
      assert.ok(a.result != null, `A's call in flight survived B's spawn: ${JSON.stringify(a)}`);
      // a third session whose spawn fails (its partition's place is a file)
      const c = await shim.session(r.socket, secretOf(r));
      fs.mkdirSync(path.join(home, 'module_data', 'remote-probe', 'sessions'), {recursive: true});
      fs.writeFileSync(path.join(home, 'module_data', 'remote-probe', 'sessions', c.welcome.session), 'not a directory');
      const failed = await request(c.c, 'tools/call', {name: s.tool('calltool'), arguments: {tool: 'echo_text', args: {text: 'C'}}});
      assert.ok(failed.result == null || failed.result.isError === true || outOf(failed).result == null, JSON.stringify(failed).slice(0, 500));
      const after = outOf(await call('A', 'echo_text'));
      assert.ok(after.result != null, `the module's remotes are still registered after a failed session spawn: ${JSON.stringify(after)}`);
    } finally {
      await remote.close();
    }
  });

  it('its prompt: listed, rendered and completed from the main thread\'s copy of its spec, with no worker; never a TypeError', async() => {
    const s = await twoSessions();
    const list = await request(s.A.c, 'prompts/list');
    const prompt = (list.result.prompts || []).find((p) => /greet$/.test(p.name));
    assert.ok(prompt != null, JSON.stringify(list).slice(0, 800));
    const got = await request(s.A.c, 'prompts/get', {name: prompt.name, arguments: {style: 'brief'}});
    assert.ok(got.result != null, JSON.stringify(got));
    assert.match(JSON.stringify(got.result.messages), /brief style/);
    const done = await request(s.A.c, 'completion/complete', {ref: {type: 'ref/prompt', name: prompt.name}, argument: {name: 'style', value: 'b'}});
    assert.ok(done.result != null, JSON.stringify(done));
    assert.deepStrictEqual(done.result.completion.values, ['brief']);
    assert.ok(!/TypeError|is not a function|Cannot read/.test(r.log()), r.log().slice(-3000));
    assert.deepStrictEqual(counts(r), {up: 0, ended: 0}, 'no worker for a prompt');
  });
});
