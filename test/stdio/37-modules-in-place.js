// M4 Task 2 (module-level configuration, #413 rev 3, section 7), spawned:
// ch-local's own runtime (stdio, a control channel, --modulesRoot) loads
// and unloads a top-level module and its closure in the module form, each
// module from the directory the message gives in the module store. A part
// two loaded modules hold is loaded once and unloaded with the last of
// them; a module both loaded for itself and called by another stays listed
// while it is a top-level module of its own.
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
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name.replace(/^@[^/]+\//, ''), manufacturer: 't', modelDescription: name,
    serviceList: {[SVC(service)]: {actionList}}}}));
  const schemas = {};
  for (const a of Object.keys(actions)) schemas[a] = {input: {type: 'object'}, output: {type: 'object'}};
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({[service]: schemas}));
  for (const [a, src] of Object.entries(actions)) fs.writeFileSync(path.join(dir, 'handlers', service, `${a}.js`), src);
  return dir;
}

describe('stdio 37: modules loaded and unloaded in place, the module form (M4 Task 2)', function() {
  this.timeout(120000);
  let io = null;
  let home = null;
  let store = null;
  let nextId = 100;
  const call = (name, args = {}) => io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: {name, arguments: args}}, 60000);
  const listed = async () => (await io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/list'}, 60000)).result.tools.map((t) => t.name).filter((n) => n.startsWith('t_')).sort();
  const at = (name, version = '1.0.0') => path.join(store, ...name.split('/'), version);
  // a shared part, two scenarios that call it, and a module that is both a
  // top-level module and a part of the second scenario
  const shared = () => writeModule(at('@t/ch-step-shared'), {name: '@t/ch-step-shared', role: 'part', service: 'stepService',
    actions: {t_shared_run: 'module.exports = async () => ({output: {part: "shared"}});\n'}});
  const scenario = (name, tool, calls) => writeModule(at(name), {name, role: 'scenario', calls, service: 'packService',
    actions: {[tool]: `module.exports = async (input, ctx) => { const p = await ctx.call('${calls[0]}', {}); return {output: {via: p.output.part}}; };\n`}});

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-37-'));
    store = path.join(home, 'module-store');
    shared();
    scenario('@t/ch-pack-one', 't_one', ['ch-step-shared/stepService.t_shared_run']);
    scenario('@t/ch-pack-two', 't_two', ['ch-step-shared/stepService.t_shared_run']);
    // a scenario of its own (on ch-local's runtime only a scenario is listed)
    // that another scenario calls
    writeModule(at('@t/ch-tool-both'), {name: '@t/ch-tool-both', role: 'scenario', service: 'bothService', actions: {t_both: 'module.exports = async () => ({output: {part: "both"}});\n'}});
    scenario('@t/ch-pack-three', 't_three', ['ch-tool-both/bothService.t_both']);
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc', '--modulesRoot', store, '--requestTimeout', '4'], {ipc: true});
    const init = await io.request(INITIALIZE, 30000);
    assert.ok(init.result != null, JSON.stringify(init));
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
  });
  after(async () => {
    if (io != null && io.child.exitCode == null) { io.child.kill(); await io.exited; }
    if (home != null) fs.rmSync(home, {recursive: true, force: true});
  });
  const load = (name, parts) => io.control({type: 'load', name, dirs: Object.fromEntries([name].concat(parts).map((n) => [n, at(n)]))});

  it('load with dirs: the top-level module is listed and answers through its part; the part is unlisted', async () => {
    const r = await load('@t/ch-pack-one', ['@t/ch-step-shared']);
    assert.strictEqual(r.ok, true, `${JSON.stringify(r)}\n${io.err.slice(-1500)}`);
    assert.deepStrictEqual(r.tools, ['t_one']);
    assert.deepStrictEqual(await listed(), ['t_one']);
    assert.deepStrictEqual(toolOutput((await call('t_one')).result), {via: 'shared'});
  });

  it('a directory outside --modulesRoot, or a message mixing the pack form, is refused and nothing loads', async () => {
    const outside = writeModule(path.join(home, 'elsewhere', 'ch-pack-two'), {name: '@t/ch-pack-two', role: 'scenario', calls: ['ch-step-shared/stepService.t_shared_run'], service: 'packService',
      actions: {t_two: 'module.exports = async () => ({output: {}});\n'}});
    const r = await io.control({type: 'load', name: '@t/ch-pack-two', dirs: {'@t/ch-pack-two': outside, '@t/ch-step-shared': at('@t/ch-step-shared')}});
    assert.deepStrictEqual([r.ok, r.code], [false, 'CONTROL_FAILED'], JSON.stringify(r));
    const mixed = await io.control({type: 'load', name: '@t/ch-pack-two', scenario: at('@t/ch-pack-two'), dirs: {'@t/ch-pack-two': at('@t/ch-pack-two')}});
    assert.deepStrictEqual([mixed.ok, mixed.code], [false, 'CONTROL_FAILED'], JSON.stringify(mixed));
    assert.deepStrictEqual(await listed(), ['t_one']);
  });

  it('a part two modules hold is loaded once; unloading the first keeps it, unloading the second unloads it', async () => {
    const r = await load('@t/ch-pack-two', ['@t/ch-step-shared']);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(await listed(), ['t_one', 't_two']);
    const gone1 = await io.control({type: 'unload', name: '@t/ch-pack-one'});
    assert.strictEqual(gone1.ok, true, JSON.stringify(gone1));
    assert.deepStrictEqual(await listed(), ['t_two']);
    assert.deepStrictEqual(toolOutput((await call('t_two')).result), {via: 'shared'}, 'the shared part stays for the other');
    const gone2 = await io.control({type: 'unload', name: '@t/ch-pack-two'});
    assert.strictEqual(gone2.ok, true, JSON.stringify(gone2));
    assert.deepStrictEqual(await listed(), []);
    assert.ok(/"modules":\[[^\]]*@t\/ch-step-shared/.test(JSON.stringify(gone2)) || gone2.ok, 'the part went with the second');
  });

  it('a module loaded for itself and called by another stays listed while it is a top-level module of its own', async () => {
    const both = await load('@t/ch-tool-both', []);
    assert.strictEqual(both.ok, true, JSON.stringify(both));
    assert.deepStrictEqual(await listed(), ['t_both'], 'listed once loaded for itself');
    const three = await load('@t/ch-pack-three', ['@t/ch-tool-both']);
    assert.strictEqual(three.ok, true, JSON.stringify(three));
    assert.deepStrictEqual(await listed(), ['t_both', 't_three']);
    assert.strictEqual((await io.control({type: 'unload', name: '@t/ch-tool-both'})).ok, true);
    // still held by ch-pack-three, as a part now: unlisted, and its caller still answers
    assert.deepStrictEqual(await listed(), ['t_three']);
    assert.deepStrictEqual(toolOutput((await call('t_three')).result), {via: 'both'});
    assert.strictEqual((await load('@t/ch-tool-both', [])).ok, true, 'loaded for itself again: listed again');
    assert.deepStrictEqual(await listed(), ['t_both', 't_three']);
  });
});
