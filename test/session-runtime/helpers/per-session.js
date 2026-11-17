'use strict';
// The per-session-module tests' harness (session-runtime 03 and 04): the
// runtime spawned as ch-local daemon spawns it (session-runtime 01's), the
// per-session fixture as a scenario or a part, a shared caller that hops
// into it, and the request and counting helpers.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const handshake = require('../../../lib/session-transport/handshake');
const shim = require('../../session-transport/helpers/shim');

const ROOT = path.join(__dirname, '..', '..', '..');
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
// a shared scenario that hops into the per-session module, installed with
// it as a part beside it, as a pack's are:
// - hop: one touch, its output (or its error's code);
// - hopTwice: a touch, input.ms later another: two sessions' calls in this
//   one worker interleave;
// - later: input.ms, then a touch; what came back is appended to the
//   caller's own /data/hops.log (a session that left meanwhile gets no
//   answer, so the log says what the hop met)
function caller(home) {
  const dir = path.join(home, 'hop', 'node_modules', 'ps-caller');
  const svc = 'callerService';
  fs.mkdirSync(path.join(dir, 'handlers', svc), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'ps-caller', version: '1.0.0', license: 'Apache-2.0',
    countinghouse: {role: 'scenario', calls: [`${NAME}/stateService.touch`]}}));
  const action = (name, description) => ({name, description, input: {schema: `/${svc}/${name}/input`}, output: {schema: `/${svc}/${name}/output`}});
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: 'ps-caller', manufacturer: 'countinghouse-test', modelDescription: 'hops',
    serviceList: {[`urn:countinghouse-test:serviceID:${svc}`]: {actionList: [action('hop', 'one hop'), action('hopTwice', 'two hops, apart'),
      action('later', 'a hop after a while')]}}}}));
  const io = {input: {type: 'object'}, output: {type: 'object'}};
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    [svc]: {hop: io, hopTwice: io, later: io}}));
  const touch = `const touch = (ctx) => ctx.call('${NAME}/stateService.touch', {}).then((r) => r.output !== undefined ? r.output : r, (e) => ({code: (e && e.code) || null, message: String(e && e.message).slice(0, 200)}));\n`;
  const wait = 'const wait = (ms) => new Promise((r) => setTimeout(r, Number(ms) || 0));\n';
  fs.writeFileSync(path.join(dir, 'handlers', svc, 'hop.js'), `${touch}module.exports = async (input, ctx) => ({output: await touch(ctx)});\n`);
  fs.writeFileSync(path.join(dir, 'handlers', svc, 'hopTwice.js'), `${touch}${wait}module.exports = async (input, ctx) => {
  const first = await touch(ctx);
  await wait(input.ms);
  return {output: {first, second: await touch(ctx)}};
};\n`);
  fs.writeFileSync(path.join(dir, 'handlers', svc, 'later.js'), `${touch}${wait}const fs = require('fs');
module.exports = async (input, ctx) => {
  await wait(input.ms);
  const got = await touch(ctx);
  fs.appendFileSync('/data/hops.log', JSON.stringify(got) + '\\n');
  return {output: got};
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


module.exports = {ROOT, FIXTURE, NAME, RESET, tick, until, perSession, caller, runtime, secretOf, request, texts, outOf, counts, shim};
