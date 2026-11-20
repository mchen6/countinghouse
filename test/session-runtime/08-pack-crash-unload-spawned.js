'use strict';
// A pack turned off while one of its modules is restarting after a crash is
// gone for good, never back for every session (the Fable security pass over
// session isolation, F1-3). Before the fix the pack's unload skipped a module
// out of the module map (packs-in-place loaded()), so its supervisor's record
// survived, the pack record was deleted, and the restart registered the
// module with no owner: listed to every session, with no all-sessions
// confirmation, while the daemon thought the pack was gone.
//
// Spawned, as ch-local's daemon runs the runtime: pack `crashy` loaded (M5a:
// no session has a view of its own, so once loaded it is every session's;
// `global` decides nothing); its module crashes twice on its own (a count in
// its /data, so a third start would load cleanly); the pack is unloaded
// inside the supervisor's second backoff (2 s, room for a slow runner); after
// the restart's time, no session's tools/list holds any of its tools, an
// open session's or a new one's.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const handshake = require('../../lib/session-transport/handshake');
const shim = require('../session-transport/helpers/shim');
// (one copy: the runtime's listening tell, null if it exited first)
const {listening} = require('./helpers/per-session');

const ROOT = path.join(__dirname, '..', '..');
const FRAMEWORK = path.join(ROOT, 'framework.js');
const META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
const NAME = '@countinghouse/ch-pack-crashy';
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const until = async(test, ms = 30000) => {
  const end = Date.now() + ms;
  while (!(await test()) && Date.now() < end) await tick(50);
  return test();
};

// pack `crashy`: a scenario with one tool, whose handler, required at load,
// ends the worker 300 ms after each of its first two loads
function crashyPack(home) {
  const root = path.join(home, 'packs');
  const dir = path.join(root, 'crashy', 'node_modules', '@countinghouse', 'ch-pack-crashy');
  const svc = 'crashyService';
  fs.mkdirSync(path.join(dir, 'handlers', svc), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: NAME, version: '1.0.0', license: 'Apache-2.0', countinghouse: {role: 'scenario'}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: 'ch-pack-crashy', manufacturer: 'countinghouse-test', modelDescription: 'crashes once',
    serviceList: {[`urn:countinghouse-test:serviceID:${svc}`]: {actionList: [
      {name: 'crashy_tool', description: 'a tool of a pack that crashes', input: {schema: `/${svc}/crashy_tool/input`}, output: {schema: `/${svc}/crashy_tool/output`}}
    ]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    [svc]: {crashy_tool: {input: {type: 'object'}, output: {type: 'object'}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', svc, 'crashy_tool.js'), [
    "const fs = require('fs');",
    "const n = fs.existsSync('/data/crashes') ? Number(fs.readFileSync('/data/crashes', 'utf8')) : 0;",
    "if (n < 2) { fs.writeFileSync('/data/crashes', String(n + 1)); setTimeout(() => process.exit(1), 300); }",
    'module.exports = async () => ({output: {ok: true}});', ''].join('\n'));
  return {root, dir};
}

function runtime(home, modulesRoot) {
  const run = path.join(home, 'run', 'daemon');
  fs.mkdirSync(run, {recursive: true});
  fs.chmodSync(path.join(home, 'run'), 0o700);
  fs.chmodSync(run, 0o700);
  const socket = path.join(run, 's');
  const child = spawn(process.execPath, [FRAMEWORK, '--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
    '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc',
    '--sessionSocket', socket, '--modulesRoot', modulesRoot],
  {stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: Object.assign({}, process.env, {COUNTINGHOUSE_GITHUB_TOKEN: '', GITHUB_TOKEN: ''})});
  const r = {child, socket, run, err: '', told: []};
  const replies = new Map();
  let nextControl = 1;
  r.control = (msg) => new Promise((resolve) => { const id = nextControl++; replies.set(id, resolve); child.send(Object.assign({}, msg, {id})); });
  child.on('message', (m) => {
    if (m == null) return;
    if (m.type === 'ready') child.send({id: 'restore-1', type: 'restore', sessions: [], declines: [], reset: []});
    // (what the runtime tells unasked: its 'listening', among others)
    if (m.id === undefined && m.type !== 'ready') r.told.push(m);
    const f = replies.get(m.id);
    if (f != null) { replies.delete(m.id); f(m); }
  });
  child.stderr.on('data', (d) => { r.err += d; });
  child.stdout.on('data', (d) => { r.err += d; });
  r.exited = new Promise((res) => child.on('exit', (code, signal) => { r.code = code; res({code, signal}); }));
  child.on('error', () => {});
  return r;
}
const secretOf = (r) => {
  try { return handshake.parseSecret(fs.readFileSync(path.join(r.run, 'secret'), 'utf8')); } catch (e) { return null; }
};
let nextSeq = 1;
async function request(c, method, params = {}) {
  const seq = nextSeq++;
  shim.message(c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method, params: Object.assign({_meta: META}, params)}));
  for (;;) {
    const m = await shim.readM(c, 60000);
    if (m == null) return null;
    if (m.header != null && m.header.seq === seq) return JSON.parse(m.line.toString('utf8'));
  }
}
const toolNames = async(c) => ((await request(c, 'tools/list')).result.tools || []).map((t) => t.name);

const {dirsOf} = require('../helpers/module-dirs');

describe('session-runtime 08: a pack turned off while its module restarts after a crash stays off for every session (F1-3)', function() {
  this.timeout(120000);
  if (process.platform === 'win32') return;   // the session socket is C2's named pipe there
  let home = null;
  let r = null;
  const conns = [];
  afterEach(async() => {
    for (const c of conns.splice(0)) c.end();
    if (r != null && r.child.exitCode == null && r.child.signalCode == null) { r.child.kill('SIGKILL'); await r.exited; }
    r = null;
    if (home != null) fs.rmSync(home, {recursive: true, force: true});
    home = null;
  });

  it('crash, unload inside the backoff, the restart\'s time: no session lists its tools', async() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sr08-'));
    const pack = crashyPack(home);
    r = runtime(home, pack.root);
    assert.ok(await listening(r) != null, `the runtime is not listening (exit ${r.code}): ${(r.err || '').slice(-1500)}`);
    const s = await shim.session(r.socket, secretOf(r));
    if (s.c != null) conns.push(s.c);
    assert.ok(s.welcome != null, JSON.stringify(s.refused));
    // loaded, it is every session's (M5a); whether it is listed at a given moment depends on its crashes
    // (a module restarting is listed to no one, F3-5), so nothing is asserted of the listing before the unload
    const loaded = await r.control({type: 'load', name: NAME, dirs: dirsOf(pack.dir)});
    assert.strictEqual(loaded.ok, true, `${JSON.stringify(loaded)}: ${r.err.slice(-1500)}`);
    // its worker ends on its own, twice; the supervisor will restart it after its second backoff
    const escaped = NAME.replace(/[/@]/g, (x) => `\\${x}`);
    const exits = () => [...r.err.matchAll(new RegExp(`module sandbox: ${escaped} exited \\(.*\\); restarting in (\\d+) ms`, 'g'))];
    assert.ok(await until(() => exits().length >= 2, 30000), `the module never crashed twice: ${r.err.slice(-1500)}`);
    const backoff = Number(exits()[1][1]);
    // the pack turned off inside the second backoff. Only the listing is asserted: on a slow runner the restart
    // may come first, and the unload then takes out a loaded module, which no build lists after (on master the
    // unload's own answer took longer than the backoff, the restart registering the module meanwhile)
    const supervisorLines = () => r.err.split('\n').filter((l) => l.includes(`module sandbox: ${NAME} `) && /exited|restarting/.test(l)).map((l) => l.slice(0, 300)).join('\n');
    const unloaded = await r.control({type: 'unload', name: NAME});
    assert.strictEqual(unloaded.ok, true, JSON.stringify(unloaded));
    // past the restart's time, and a spawn's
    await tick(backoff + 3000);
    assert.ok(!(await toolNames(s.c)).includes('crashy_tool'), `listed to a session after the restart:\n${supervisorLines()}`);
    const s2 = await shim.session(r.socket, secretOf(r));
    if (s2.c != null) conns.push(s2.c);
    assert.ok(!(await toolNames(s2.c)).includes('crashy_tool'), `nor to a new session:\n${supervisorLines()}`);
  });
});
