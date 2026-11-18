'use strict';
// A unit loaded in place is verified as a whole: its hop answers from the
// moment the load is answered, never CTX_CALL_UNBOUND (ch-local #81's
// acceptance, macOS: "the hopping call answers, through its part" got
// CTX_CALL_UNBOUND right after the in-place load).
//
// A unit's modules load in its closure's order, the scenario before its part.
// Each registration re-runs composition verification for every device. The
// scenario's ran while its part was still loading: its declared target was
// not found, and that re-verification's failure was delivered as a settled
// verdict with no binding, until the part's own pass bound it again. A hop
// in between answered UNBOUND. A device of a unit still loading now keeps no
// verdict (a hop waits for one: the composition window), and the unit is
// verified once all of it has registered.
//
// The scenario's part is its own (not loaded by anything else), and its
// tool is called the moment it is listed after the load, as ch-local's
// acceptance does, in rounds of unload and load.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, INITIALIZE} = require('../helpers/stdio-client');
const {toolOutput} = require('../helpers/tool-result');

const SVC = (s) => `urn:countinghouse-test:serviceID:${s}`;
const ROUNDS = 3;

function writeModule(dir, {name, version = '1.0.0', role, calls, service, actions}) {
  fs.mkdirSync(path.join(dir, 'handlers', service), {recursive: true});
  const ch = {};
  if (role != null) ch.role = role;
  if (calls != null) ch.calls = calls;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version, license: 'Apache-2.0', countinghouse: ch}));
  const actionList = Object.keys(actions).map((a) => ({name: a, description: `${a} of ${name}`,
    input: {schema: `/${service}/${a}/input`}, output: {schema: `/${service}/${a}/output`}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name, manufacturer: 'countinghouse-test',
    modelDescription: name, serviceList: {[SVC(service)]: {actionList}}}}));
  const schemas = {};
  for (const a of Object.keys(actions)) schemas[a] = {input: {type: 'object'}, output: {type: 'object'}};
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object', [service]: schemas}));
  for (const [a, src] of Object.entries(actions)) fs.writeFileSync(path.join(dir, 'handlers', service, `${a}.js`), src);
  return dir;
}

// <home>/packs/<scenario>/<version>/node_modules/{<scenario>, <part>}
function unit(home, scenario, part, tool) {
  const nm = path.join(home, 'packs', scenario, '1.0.0', 'node_modules');
  writeModule(path.join(nm, part), {name: part, role: 'part', service: 'ownService',
    // slow to load (a busy second and a half as its handler is required), so
    // the scenario registers, and is verified, while its part still loads
    actions: {run: 'const t0 = Date.now(); while (Date.now() - t0 < 1500) { /* loading */ }\nmodule.exports = async () => ({output: {part: "own"}});\n'}});
  return writeModule(path.join(nm, scenario), {name: scenario, role: 'scenario', service: 'hopService', calls: [`${part}/ownService.run`],
    actions: {[tool]: `module.exports = async (input, ctx) => { const p = await ctx.call('${part}/ownService.run', {}); return {output: {part: p.output.part}}; };\n`}});
}

describe('stdio 36: a unit loaded in place answers its hop at once, never CTX_CALL_UNBOUND', function() {
  this.timeout(240000);
  let home = null;
  let io = null;
  let nextId = 10;
  const listed = async () => (await io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/list'}, 60000)).result.tools.map((t) => t.name);
  const call = (name, args = {}) => io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: {name, arguments: args}}, 60000);

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-36-'));
    const base = unit(home, 'ch-pack-base', 'ch-step-base', 'tool_base');
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc', '--packsRoot', path.join(home, 'packs'), '--loadModule', base],
    // every pass's verdict for the hopping scenario delivered 3 s late (the
    // test hook): the window a slow runner gave the hop, made wide
    {ipc: true, env: {COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG: '1', COUNTINGHOUSE_TEST_COMPOSITION_DELAY_MS: '3000',
      COUNTINGHOUSE_TEST_COMPOSITION_DELAY_MODULE: 'ch-pack-hop', COUNTINGHOUSE_TEST_COMPOSITION_DELAY_LATER: '1'}});
    const init = await io.request(INITIALIZE, 30000);
    assert.ok(init.result != null, JSON.stringify(init));
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
    // the start's own discovery over first (its list is held until then)
    assert.ok((await listed()).includes('tool_base'), io.err.slice(-2000));
  });
  after(async () => {
    if (io != null && io.child.exitCode == null) { io.child.kill(); await io.exited; }
    if (home != null) fs.rmSync(home, {recursive: true, force: true});
  });

  it(`${ROUNDS} rounds: load in place, then call the hopping tool at once; each answers through its part`, async () => {
    const hop = unit(home, 'ch-pack-hop', 'ch-step-own', 'tool_hop');
    const answers = [];
    for (let i = 0; i < ROUNDS; i++) {
      const r = await io.control({type: 'load', name: 'ch-pack-hop', scenario: hop});
      assert.strictEqual(r.ok, true, `round ${i}: ${JSON.stringify(r)}\n${io.err.slice(-2000)}`);
      // as ch-local's acceptance does: once its tool is listed, call it at once
      for (let n = 0; n < 500 && !(await listed()).includes('tool_hop'); n++) await new Promise((res) => setTimeout(res, 10));
      const res = await call('tool_hop');
      const out = (res != null && res.result != null && res.result.isError !== true) ? toolOutput(res.result) : undefined;
      if (out != null && out.part === 'own') answers.push('ok');
      else answers.push(`${JSON.stringify(res).slice(0, 400)}\n${io.err.slice(-1500)}`);
      const u = await io.control({type: 'unload', name: 'ch-pack-hop'});
      assert.strictEqual(u.ok, true, `round ${i} unload: ${JSON.stringify(u)}`);
    }
    assert.deepStrictEqual(answers, new Array(ROUNDS).fill('ok'), answers.join('\n'));
  });
});
