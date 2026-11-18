'use strict';
// An unlisted part whose worker exited is still unlisted while it restarts or
// is suspended (the Fable pass over the MCP surface, F3-5). On an exit its
// devices leave the device map and their specs are kept by the supervisor
// (so a listed module's tools stay listed: clients get no list_changed); the
// kept spec had no package.json beside it, and the registry listed it, so a
// part's tools reached every key granted its device for as long as it was
// down, and a part could crash itself to get there.
//
// Spawned: a scenario and its part, loaded at start; the part ends its worker
// 2 s after every load (time for a slow runner's load to finish first), so
// after its third exit it is suspended. Sampled all along: before its first
// exit, while it restarts (its spec kept), and once suspended. Then tools/list holds no tool of the part, and a call to
// one is refused MODULE_NOT_LISTED, as while it ran.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {startServer, stopServer, post, waitFor} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {toolErrorCode} = require('../helpers/tool-result');

const KEY  = 'aabbcc';
const PORT = testPort(9793);
const PART_TOOL = 'ch_step_crashy_svc_run';

function write(dir, files) {
  fs.mkdirSync(dir, {recursive: true});
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), {recursive: true});
    fs.writeFileSync(path.join(dir, name), typeof(body) === 'string' ? body : JSON.stringify(body));
  }
}
const api = (friendlyName, action, description) => ({device: {friendlyName, manufacturer: 'countinghouse-test', modelDescription: friendlyName,
  serviceList: {'urn:countinghouse-test:serviceID:svc': {actionList: [
    {name: action, description, input: {schema: `/svc/${action}/input`}, output: {schema: `/svc/${action}/output`}}]}}}});
const schema = (action) => ({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
  svc: {[action]: {input: {type: 'object'}, output: {type: 'object'}}}});

// the scenario ch-pack-rst, and below it its part ch-step-crashy, which exits 2 s after each load
function fixture(home) {
  const scenario = path.join(home, 'ch-pack-rst');
  write(scenario, {
    'package.json': {name: 'ch-pack-rst', version: '1.0.0', license: 'Apache-2.0', countinghouse: {role: 'scenario', calls: ['ch-step-crashy/svc.run']}},
    'api.json': api('ch-pack-rst', 'rst_tool', 'a scenario whose part crashes'),
    'schema.json': schema('rst_tool'),
    'handlers/svc/rst_tool.js': 'module.exports = async () => ({output: {ok: true}});\n'
  });
  write(path.join(scenario, 'node_modules', 'ch-step-crashy'), {
    'package.json': {name: 'ch-step-crashy', version: '1.0.0', license: 'Apache-2.0', countinghouse: {role: 'part'}},
    'api.json': api('ch-step-crashy', 'run', 'a part that crashes'),
    'schema.json': schema('run'),
    'handlers/svc/run.js': 'setTimeout(() => process.exit(1), 2000);\nmodule.exports = async () => ({output: {ok: true}});\n'
  });
  return scenario;
}

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    require('supertest')(`http://127.0.0.1:${PORT}`).post('/mcp').set('X-CH-Key', KEY)
      .set('Accept', 'application/json, text/event-stream')
      .send({jsonrpc: '2.0', id: 1, method, params})
      .end((err, res) => (err ? reject(err) : resolve(res.body)));
  });
}
const toolNames = async () => (await rpc('tools/list')).result.tools.map((t) => t.name);
const state = async () => {
  const r = await post(PORT, KEY, '/get-module-device-list', {name: 'ch-step-crashy'});
  return r.body != null && r.body.sandbox != null ? r.body.sandbox.state : null;
};

describe('sandbox 63: an unlisted part is not listed while it restarts or is suspended (F3-5)', function() {
  this.timeout(120000);
  let home = null;
  let server = null;
  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sb63-'));
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--loadModule', fixture(home)]);
  });
  after(() => {
    if (server != null) stopServer(server);
    if (home != null) fs.rmSync(home, {recursive: true, force: true});
  });

  it('from its load to its suspension, never listed: running, restarting (its spec kept), suspended; a call is MODULE_NOT_LISTED', async () => {
    const names = await toolNames();
    assert.ok(names.includes('rst_tool'), `premise: the scenario is listed (${names.join(', ')}): ${server.output.slice(-1500)}`);
    // sampled every 100 ms, the part's state and the list at once, until it is suspended (its backoffs are 1 s and 2 s)
    const seen = new Set();
    const end = Date.now() + 60000;
    // (each list is read between two reads of the state: it was taken in one of them, or in a passage between)
    for (let s = await state(); s !== 'suspended'; s = await state()) {
      assert.ok(Date.now() < end, `never suspended (seen: ${[...seen].join(', ')}): ${server.output.slice(-1500)}`);
      const listed = await toolNames();
      const after = await state();
      seen.add(String(s));
      assert.ok(!listed.includes(PART_TOOL), `listed between ${s} and ${after}: ${listed.join(', ')}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(seen.has('restarting'), `premise: sampled while restarting (seen: ${[...seen].join(', ')})`);
    const during = await toolNames();
    assert.ok(!during.includes(PART_TOOL), `listed while suspended: ${during.join(', ')}`);
    assert.ok(during.includes('rst_tool'), 'and the scenario still is');
    const call = await rpc('tools/call', {name: PART_TOOL, arguments: {}});
    assert.strictEqual(call.result != null ? toolErrorCode(call.result) : null, 'MODULE_NOT_LISTED', JSON.stringify(call));
  });
});
