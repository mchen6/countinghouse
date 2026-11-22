'use strict';
// A shared runtime, end to end: a session on 2025-11-25 (what Claude Code
// falls back to when its 3 s server/discover probe times out on a cold
// start) is told tools/list_changed for an in-place load and unload, once it
// has listed; a 2026-07-28 session beside it, with no listen open, is told
// nothing unasked.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const handshake = require('../../lib/session-transport/handshake');
const shim = require('../session-transport/helpers/shim');
const {dirsOf} = require('../helpers/module-dirs');
const tmp = require('../helpers/test-tmp').forFile(['ch-ll-'], {base: require('os').tmpdir()});

const ROOT = path.join(__dirname, '..', '..');
const FRAMEWORK = path.join(ROOT, 'framework.js');
const MODERN = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
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
    '--modulesRoot', packs, '--sessionSocket', socket], {stdio: ['pipe', 'pipe', 'pipe', 'ipc'], detached: true, env: Object.assign({}, process.env, {COUNTINGHOUSE_GITHUB_TOKEN: ''})});
  const r = {child, socket, run, err: ''};
  child.stderr.on('data', (d) => { r.err += d; });
  r.exited = new Promise((res) => child.on('exit', res));
  const replies = new Map();
  let next = 1;
  child.on('message', (m) => {
    if (m != null && m.type === 'ready') child.send({id: 'restore-1', type: 'restore', sessions: [], declines: [], reset: []});
    const f = m != null ? replies.get(m.id) : null;
    if (f != null) { replies.delete(m.id); f(m); }
  });
  r.control = (msg) => new Promise((resolve) => { const id = next++; replies.set(id, resolve); child.send(Object.assign({}, msg, {id})); });
  return r;
}

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
  shim.message(c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method, params}));
  const end = Date.now() + 60000;
  while (!rd.answers.has(seq) && Date.now() < end) await tick();
  return rd.answers.get(seq);
}
const changes = (rd) => rd.notes.filter((n) => n.method === 'notifications/tools/list_changed').length;
const until = async(ok, ms = 15000) => { const by = Date.now() + ms; while (!ok() && Date.now() < by) await tick(100); };

describe('session-runtime 09: a 2025-11-25 session of a shared runtime hears its tools change', function() {
  this.timeout(120000);
  if (process.platform === 'win32') return;
  let home;
  let r = null;
  beforeEach(() => { home = tmp.mkdtemp('ch-ll-'); });
  afterEach(async() => {
    // (its process group: whatever the runtime started goes with it)
    if (r != null) { try { process.kill(-r.child.pid, 'SIGKILL'); } catch (e) { /* gone */ } await r.exited; }
    r = null;
  });

  it('declares tools.listChanged on initialize; one list_changed for a load and one for an unload; a modern session told nothing unasked', async() => {
    const packs = path.join(home, 'packs');
    r = runtime(home, packs);
    const end = Date.now() + 30000;
    while (!(fs.existsSync(path.join(r.run, 'secret')) && fs.existsSync(r.socket)) && Date.now() < end) await tick(100);
    await tick(300);
    const secret = handshake.parseSecret(fs.readFileSync(path.join(r.run, 'secret'), 'utf8'));
    const legacy = await shim.session(r.socket, secret);
    const modern = await shim.session(r.socket, secret);
    const rl = reader(legacy.c);
    const rm = reader(modern.c);
    const init = await ask(legacy.c, rl, 'initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'test', version: '1'}});
    assert.strictEqual(init.result.protocolVersion, '2025-11-25');
    assert.deepStrictEqual(init.result.capabilities.tools, {listChanged: true}, JSON.stringify(init.result.capabilities));
    shim.message(legacy.c, null, JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    const names = async() => (await ask(legacy.c, rl, 'tools/list')).result.tools.map((t) => t.name);
    assert.ok(!(await names()).some((n) => /two_hello/.test(n)));
    await ask(modern.c, rm, 'tools/list', {_meta: MODERN});

    const two = scenario(path.join(packs, 'ch-pack-two', '1.0.0', 'node_modules', 'ch-pack-two'), 'ch-pack-two');
    const loaded = await r.control({type: 'load', name: 'ch-pack-two', dirs: dirsOf(two)});
    assert.strictEqual(loaded.ok, true, `${JSON.stringify(loaded)}\n${r.err.slice(-1500)}`);
    await until(() => changes(rl) >= 1);
    assert.strictEqual(changes(rl), 1, JSON.stringify(rl.notes));
    assert.ok(!('params' in rl.notes.find((n) => n.method === 'notifications/tools/list_changed')), 'a plain notification, with no subscription id');
    assert.ok((await names()).some((n) => /two_hello/.test(n)), 'the new tool is listed');

    const gone = await r.control({type: 'unload', name: 'ch-pack-two'});
    assert.strictEqual(gone.ok, true, `${JSON.stringify(gone)}\n${r.err.slice(-1500)}`);
    await until(() => changes(rl) >= 2);
    assert.strictEqual(changes(rl), 2, JSON.stringify(rl.notes));
    assert.ok(!(await names()).some((n) => /two_hello/.test(n)), 'the tool is gone');
    // anything written to the modern session arrives before this answer
    await ask(modern.c, rm, 'tools/list', {_meta: MODERN});
    assert.strictEqual(changes(rm), 0, 'a 2026-07-28 session with no listen is told nothing unasked');
    legacy.c.end();
    modern.c.end();
  });

  it('an initialize and a tools/list written together, as the shim replays them: the list counts because initialize is answered as it is read, so a later change gives one notice', async() => {
    const packs = path.join(home, 'packs');
    r = runtime(home, packs);
    const end = Date.now() + 30000;
    while (!(fs.existsSync(path.join(r.run, 'secret')) && fs.existsSync(r.socket)) && Date.now() < end) await tick(100);
    await tick(300);
    const secret = handshake.parseSecret(fs.readFileSync(path.join(r.run, 'secret'), 'utf8'));
    const legacy = await shim.session(r.socket, secret);
    const rl = reader(legacy.c);
    // written together, with no wait for the initialize's answer (shim/src/relay.rs)
    const init = seqs++;
    const list = seqs++;
    shim.message(legacy.c, {seq: init}, JSON.stringify({jsonrpc: '2.0', id: init, method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'test', version: '1'}}}));
    shim.message(legacy.c, null, JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    shim.message(legacy.c, {seq: list}, JSON.stringify({jsonrpc: '2.0', id: list, method: 'tools/list', params: {}}));
    await until(() => rl.answers.has(init) && rl.answers.has(list));
    assert.ok(rl.answers.get(init).result != null && rl.answers.get(list).result != null, 'both answered');
    const two = scenario(path.join(packs, 'ch-pack-two', '1.0.0', 'node_modules', 'ch-pack-two'), 'ch-pack-two');
    const loaded = await r.control({type: 'load', name: 'ch-pack-two', dirs: dirsOf(two)});
    assert.strictEqual(loaded.ok, true, `${JSON.stringify(loaded)}\n${r.err.slice(-1500)}`);
    await until(() => changes(rl) >= 1);
    assert.strictEqual(changes(rl), 1, JSON.stringify(rl.notes));
    legacy.c.end();
  });

  tmp.hooks();
});
