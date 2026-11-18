// M4 Task 1 (module-level configuration, #413 rev 3, section 5.5), spawned:
// on ch-local's own runtime (stdio, a control channel, no shared session
// view) a pack loaded in place is not listed, and its tool not callable,
// until every module it brings has loaded; a module whose unload leaves it
// in the module map stays unlisted and uncallable, and a later load whose
// closure holds it is refused. Before M4 such a runtime had no guard: the
// scenario registers first, so its tool was listed (and called into a part
// not there yet) while its parts loaded.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, INITIALIZE} = require('../helpers/stdio-client');
const {toolOutput} = require('../helpers/tool-result');

const SVC = (s) => `urn:countinghouse-test:serviceID:${s}`;

function writeModule(dir, {name, version = '1.0.0', role, calls, service, actions}) {
  fs.mkdirSync(path.join(dir, 'handlers', service), {recursive: true});
  const ch = {};
  if (role != null) ch.role = role;
  if (calls != null) ch.calls = calls;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version, countinghouse: ch}));
  const actionList = Object.keys(actions).map((a) => ({name: a, description: `${a} of ${name}`,
    input: {schema: `/${service}/${a}/input`}, output: {schema: `/${service}/${a}/output`}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name, manufacturer: 't', modelDescription: name,
    serviceList: {[SVC(service)]: {actionList}}}}));
  const schemas = {};
  for (const a of Object.keys(actions)) schemas[a] = {input: {type: 'object'}, output: {type: 'object'}};
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({[service]: schemas}));
  for (const [a, src] of Object.entries(actions)) fs.writeFileSync(path.join(dir, 'handlers', service, `${a}.js`), src);
  return dir;
}

// <packs>/<scenario>/1.0.0/node_modules/{<scenario>, <part>}
function pack(home, scenario, part, tool) {
  const nm = path.join(home, 'packs', scenario, '1.0.0', 'node_modules');
  writeModule(path.join(nm, part), {name: part, role: 'part', service: 'stepService',
    actions: {run: 'module.exports = async () => ({output: {part: true}});\n'}});
  return writeModule(path.join(nm, scenario), {name: scenario, role: 'scenario', calls: [`${part}/stepService.run`], service: 'packService',
    actions: {[tool]: `module.exports = async (input, ctx) => { const p = await ctx.call('${part}/stepService.run', {}); return {output: {via: p.output.part}}; };\n`}});
}

describe('stdio 36: a module going on or off is hidden (M4 Task 1)', function() {
  this.timeout(120000);
  let io = null;
  let home = null;
  let nextId = 100;
  const call = (name, args = {}) => io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: {name, arguments: args}}, 60000);
  const listed = async () => (await io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/list'}, 60000)).result.tools.map((t) => t.name);

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-36-'));
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc', '--packsRoot', path.join(home, 'packs'), '--requestTimeout', '4'],
    {ipc: true, env: {COUNTINGHOUSE_TEST_LOAD_HOLD_MODULE: 'ch-step-slow', COUNTINGHOUSE_TEST_LOAD_HOLD_MS: '3000',
      COUNTINGHOUSE_TEST_UNLOAD_KEEPS: 'ch-step-kept'}});
    const init = await io.request(INITIALIZE, 30000);
    assert.ok(init.result != null, JSON.stringify(init));
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
  });
  after(async () => {
    if (io != null && io.child.exitCode == null) { io.child.kill(); await io.exited; }
    if (home != null) fs.rmSync(home, {recursive: true, force: true});
  });

  it('while a part loads, the scenario that registered first is not listed and its tool is not callable; then both are', async () => {
    const loading = io.control({type: 'load', name: 'ch-pack-slow', scenario: pack(home, 'ch-pack-slow', 'ch-step-slow', 'tool_slow')});
    // the scenario's own worker is up well before the part's held load ends
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(!(await listed()).includes('tool_slow'), 'listed while its part was still loading');
    const during = await call('tool_slow');
    assert.ok(during.error != null || (during.result != null && during.result.isError === true), `callable while loading: ${JSON.stringify(during).slice(0, 300)}`);
    const r = await loading;
    assert.strictEqual(r.ok, true, `${JSON.stringify(r)}\n${io.err.slice(-1500)}`);
    assert.ok((await listed()).includes('tool_slow'));
    assert.deepStrictEqual(toolOutput((await call('tool_slow')).result), {via: true});
  });

  it('a module whose unload leaves it in the module map stays hidden; a load whose closure holds it is refused', async () => {
    const loaded = await io.control({type: 'load', name: 'ch-pack-kept', scenario: pack(home, 'ch-pack-kept', 'ch-step-kept', 'tool_kept')});
    assert.strictEqual(loaded.ok, true, JSON.stringify(loaded));
    assert.deepStrictEqual(toolOutput((await call('tool_kept')).result), {via: true});
    const gone = await io.control({type: 'unload', name: 'ch-pack-kept'});
    assert.strictEqual(gone.ok, true, JSON.stringify(gone));
    assert.ok(io.err.includes('module: ch-step-kept is still loaded after its unload; it stays hidden until the runtime ends'), io.err.slice(-1500));
    // the part (still in the map) stays hidden (the hop, peer-channel and
    // job paths' refusal of a hidden module: sessions 35's bridge cases)
    const again = await io.control({type: 'load', name: 'ch-pack-kept', scenario: path.join(home, 'packs', 'ch-pack-kept', '1.0.0', 'node_modules', 'ch-pack-kept')});
    assert.deepStrictEqual([again.ok, again.code], [false, 'CONTROL_FAILED'], JSON.stringify(again));
    assert.ok(/ch-step-kept is still being unloaded; restart your client/.test(again.message), again.message);
  });
});
