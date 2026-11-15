'use strict';
// server/discover and subscriptions/listen on a session runtime (after #238):
// each session's listen is its own. A change reaches each session's stream
// with that session's subscription id, a cancel or a detach closes only that
// session's, and the per-session limit counts a session, not the user's one
// key. The session's tool list is the one its listen compares, so once B3
// lists a pack to one session only, only that session is told.
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
const SUB = 'io.modelcontextprotocol/subscriptionId';
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

function scenario(dir, name) {
  // a service of its own per pack, so two packs' devices never collide
  const svc = `${name.replace(/[^a-z]/g, '')}Service`;
  const action = `${name.replace(/[^a-z]/g, '')}_hello`;
  fs.mkdirSync(path.join(dir, 'handlers', svc), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', license: 'Apache-2.0', countinghouse: {role: 'scenario'}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name, manufacturer: 'countinghouse-test', modelDescription: name,
    serviceList: {[`urn:countinghouse-test:serviceID:${svc}`]: {actionList: [{name: action, description: `hello of ${name}`, input: {schema: `/${svc}/${action}/input`}, output: {schema: `/${svc}/${action}/output`}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object', [svc]: {[action]: {input: {type: 'object'}, output: {type: 'object'}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', svc, `${action}.js`), 'module.exports = async () => ({output: {}});\n');
  return dir;
}

function runtime(home, packs) {
  const run = path.join(home, 'run', 'daemon');
  fs.mkdirSync(run, {recursive: true, mode: 0o700});
  fs.chmodSync(path.join(home, 'run'), 0o700);
  fs.chmodSync(run, 0o700);
  const socket = path.join(run, 's');
  const child = spawn(process.execPath, [FRAMEWORK, '--no-workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
    '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc',
    '--packsRoot', packs, '--sessionSocket', socket], {stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: Object.assign({}, process.env, {COUNTINGHOUSE_GITHUB_TOKEN: ''})});
  const r = {child, socket, run, err: ''};
  child.stderr.on('data', (d) => { r.err += d; });
  r.exited = new Promise((res) => child.on('exit', res));
  const replies = new Map();
  let next = 1;
  child.on('message', (m) => { const f = m != null ? replies.get(m.id) : null; if (f != null) { replies.delete(m.id); f(m); } });
  r.control = (msg) => new Promise((resolve) => { const id = next++; replies.set(id, resolve); child.send(Object.assign({}, msg, {id})); });
  return r;
}

// a session's lines as they arrive: answers by seq, notifications in order
function reader(c) {
  const out = {answers: new Map(), notes: []};
  (async() => {
    for (;;) {
      const m = await shim.readM(c, 60000);
      if (m == null) return;
      const msg = JSON.parse(m.line.toString('utf8'));
      if (m.header != null) out.answers.set(m.header.seq, msg); else out.notes.push(msg);
    }
  })();
  return out;
}
let seqs = 100;
async function ask(c, rd, method, params = {}) {
  const seq = seqs++;
  shim.message(c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method, params: Object.assign({_meta: META}, params)}));
  const end = Date.now() + 60000;
  while (!rd.answers.has(seq) && Date.now() < end) await tick();
  return rd.answers.get(seq);
}
// a listen: its id (the request's), once acknowledged
async function listen(c, rd) {
  const id = seqs++;
  shim.message(c, {seq: id}, JSON.stringify({jsonrpc: '2.0', id, method: 'subscriptions/listen', params: {_meta: META, notifications: {toolsListChanged: true}}}));
  const end = Date.now() + 30000;
  while (!rd.notes.some((n) => n.method === 'notifications/subscriptions/acknowledged' && n.params._meta[SUB] === id) && Date.now() < end) await tick();
  return id;
}
const changesFor = (rd, id) => rd.notes.filter((n) => n.method === 'notifications/tools/list_changed' && n.params._meta[SUB] === id).length;

describe('session-runtime 02: discover and listen per session, spawned', function() {
  this.timeout(120000);
  if (process.platform === 'win32') return;
  let home;
  let r = null;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sl-')); });
  afterEach(async() => {
    if (r != null) { r.child.kill('SIGKILL'); await r.exited; }
    r = null;
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('each session\'s listen hears a change on its own stream, with its own id; a cancelled one hears nothing', async() => {
    const packs = path.join(home, 'packs');
    r = runtime(home, packs);
    const end = Date.now() + 30000;
    while (handshake.parseSecret((() => { try { return fs.readFileSync(path.join(r.run, 'secret'), 'utf8'); } catch (e) { return ''; } })()) == null && Date.now() < end) await tick(100);
    const secret = handshake.parseSecret(fs.readFileSync(path.join(r.run, 'secret'), 'utf8'));
    const a = await shim.session(r.socket, secret);
    const b = await shim.session(r.socket, secret);
    const ra = reader(a.c);
    const rb = reader(b.c);
    const found = await ask(a.c, ra, 'server/discover');
    assert.deepStrictEqual(found.result.capabilities.tools, {listChanged: true}, JSON.stringify(found));
    await ask(a.c, ra, 'tools/list');
    await ask(b.c, rb, 'tools/list');
    const la = await listen(a.c, ra);
    const lb = await listen(b.c, rb);
    const lb2 = await listen(b.c, rb);
    // b cancels its second listen
    shim.message(b.c, null, JSON.stringify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: lb2}}));
    await tick(200);
    const two = scenario(path.join(packs, 'ch-pack-two', '1.0.0', 'node_modules', 'ch-pack-two'), 'ch-pack-two');
    const reply = await r.control({type: 'load', name: 'ch-pack-two', scenario: two});
    assert.strictEqual(reply.ok, true, `${JSON.stringify(reply)}\n${r.err.slice(-1500)}`);
    const until = Date.now() + 15000;
    while ((changesFor(ra, la) < 1 || changesFor(rb, lb) < 1) && Date.now() < until) await tick(100);
    assert.strictEqual(changesFor(ra, la), 1, JSON.stringify(ra.notes));
    assert.strictEqual(changesFor(rb, lb), 1, JSON.stringify(rb.notes));
    assert.strictEqual(changesFor(rb, la), 0, 'a\'s id never on b\'s stream');
    assert.strictEqual(changesFor(ra, lb), 0, 'b\'s id never on a\'s stream');
    assert.strictEqual(changesFor(rb, lb2), 0, 'the cancelled listen hears nothing');
    assert.ok(!rb.answers.has(lb2), 'a cancelled listen is never answered');
    // a's connection drops: its listen goes with it; b's still hears the next change
    a.c.end();
    await tick(300);
    const three = scenario(path.join(packs, 'ch-pack-three', '1.0.0', 'node_modules', 'ch-pack-three'), 'ch-pack-three');
    const reply3 = await r.control({type: 'load', name: 'ch-pack-three', scenario: three});
    assert.strictEqual(reply3.ok, true, `${JSON.stringify(reply3)}\n${r.err.slice(-1500)}`);
    const until2 = Date.now() + 15000;
    while (changesFor(rb, lb) < 2 && Date.now() < until2) await tick(100);
    assert.strictEqual(changesFor(rb, lb), 2);
    b.c.end();
  });

  it('the per-session limit counts a session, not the user\'s one key: each session opens its own 8', async() => {
    const packs = path.join(home, 'packs');
    r = runtime(home, packs);
    const end = Date.now() + 30000;
    while (!fs.existsSync(path.join(r.run, 'secret')) && Date.now() < end) await tick(100);
    await tick(300);
    const secret = handshake.parseSecret(fs.readFileSync(path.join(r.run, 'secret'), 'utf8'));
    const a = await shim.session(r.socket, secret);
    const b = await shim.session(r.socket, secret);
    const ra = reader(a.c);
    const rb = reader(b.c);
    for (let i = 0; i < 8; i++) await listen(a.c, ra);
    const ninth = seqs++;
    shim.message(a.c, {seq: ninth}, JSON.stringify({jsonrpc: '2.0', id: ninth, method: 'subscriptions/listen', params: {_meta: META, notifications: {toolsListChanged: true}}}));
    const until = Date.now() + 15000;
    while (!ra.answers.has(ninth) && Date.now() < until) await tick();
    assert.ok(ra.answers.get(ninth).error != null, 'a\'s ninth is refused');
    const fromB = await listen(b.c, rb);
    assert.ok(rb.notes.some((n) => n.method === 'notifications/subscriptions/acknowledged' && n.params._meta[SUB] === fromB), 'b still gets its own');
    a.c.end();
    b.c.end();
  });
});
