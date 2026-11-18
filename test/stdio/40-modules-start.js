// M4 Task 4 (module-level configuration, #413 rev 3, section 7.2), spawned:
// a start given --modulesRoot loads only what lies inside it. Every
// --loadModule and --partDir directory is checked (inside the root by real
// path, no link out); a called part is looked for only among the
// directories given, never on a node_modules search path; a top-level
// module that cannot load is told to ch-local at once as module-stopped
// with when 'start'. Units seeded from the store are recorded under their
// package names and unloaded by them.
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
const part = (dir, name) => writeModule(dir, {name, role: 'part', service: 'stepService',
  actions: {run: `module.exports = async () => ({output: {part: '${dir}'}});\n`}});
const scenario = (dir, name, tool, partName) => writeModule(dir, {name, role: 'scenario', calls: [`${partName}/stepService.run`], service: 'packService',
  actions: {[tool]: `module.exports = async (input, ctx) => ({output: {via: (await ctx.call('${partName}/stepService.run', {})).output.part}});\n`}});

describe('stdio 40: a start under --modulesRoot (M4 Task 4)', function() {
  this.timeout(180000);
  const started = [];
  let nextId = 100;
  const listed = async (io) => (await io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/list'}, 60000)).result.tools.map((t) => t.name).filter((n) => n.startsWith('t_')).sort();
  async function start(home, args, env = {}) {
    const io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc', '--requestTimeout', '4'].concat(args), {ipc: true, env: Object.assign({HOME: home}, env)});
    started.push(io);
    const init = await io.request(INITIALIZE, 30000);
    assert.ok(init.result != null, `${JSON.stringify(init)}\n${io.err.slice(-1500)}`);
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
    return io;
  }
  const until = async (test, ms = 10000) => {
    const end = Date.now() + ms;
    while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return test();
  };
  const stopped = (io) => io.told.filter((m) => m.type === 'module-stopped');
  afterEach(async () => {
    for (const io of started.splice(0)) if (io.child.exitCode == null) { io.child.kill(); await io.exited; }
  });

  it('a planted part: with --modulesRoot, a package in ~/node_modules and one beside the scenario are not found; the scenario is told stopped (PART_MISSING)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-40a-'));
    const store = path.join(home, 'module-store');
    const s = scenario(path.join(store, '@t', 'ch-pack-a', '1.0.0'), '@t/ch-pack-a', 't_a', 'ch-step-s');
    part(path.join(home, 'node_modules', '@t', 'ch-step-s'), '@t/ch-step-s');
    part(path.join(s, 'node_modules', '@t', 'ch-step-s'), '@t/ch-step-s');
    const io = await start(home, ['--modulesRoot', store, '--loadModule', s]);
    assert.deepStrictEqual(await listed(io), []);
    assert.ok(await until(() => stopped(io).length > 0), JSON.stringify(io.told));
    assert.deepStrictEqual(stopped(io), [{type: 'module-stopped', name: '@t/ch-pack-a', code: 'PART_MISSING', when: 'start'}]);
  });

  it('without --modulesRoot today\'s lookup still finds the part beside the scenario', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-40b-'));
    const s = scenario(path.join(home, 'packs', 'ch-pack-a'), '@t/ch-pack-a', 't_a', 'ch-step-s');
    part(path.join(s, 'node_modules', '@t', 'ch-step-s'), '@t/ch-step-s');
    const io = await start(home, ['--loadModule', s]);
    assert.deepStrictEqual(await listed(io), ['t_a']);
    assert.deepStrictEqual(stopped(io), []);
  });

  it('with --partDir: the part found among the given directories loads; one outside the root, or with a link out, is not, and its caller is told stopped', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-40c-'));
    const store = path.join(home, 'module-store');
    const ok = scenario(path.join(store, '@t', 'ch-pack-ok', '1.0.0'), '@t/ch-pack-ok', 't_ok', 'ch-step-ok');
    const okPart = part(path.join(store, '@t', 'ch-step-ok', '1.0.0'), '@t/ch-step-ok');
    const out = scenario(path.join(store, '@t', 'ch-pack-out', '1.0.0'), '@t/ch-pack-out', 't_out', 'ch-step-out');
    const outPart = part(path.join(home, 'elsewhere', 'ch-step-out'), '@t/ch-step-out');
    const linked = scenario(path.join(store, '@t', 'ch-pack-link', '1.0.0'), '@t/ch-pack-link', 't_link', 'ch-step-link');
    const linkedPart = part(path.join(store, '@t', 'ch-step-link', '1.0.0'), '@t/ch-step-link');
    fs.symlinkSync(path.join(home, 'elsewhere', 'ch-step-out', 'package.json'), path.join(linkedPart, 'handlers', 'escape.json'));
    const io = await start(home, ['--modulesRoot', store, '--loadModule', ok, '--partDir', okPart, '--loadModule', out, '--partDir', outPart,
      '--loadModule', linked, '--partDir', linkedPart]);
    assert.deepStrictEqual(await listed(io), ['t_ok']);
    assert.deepStrictEqual(toolOutput((await io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: {name: 't_ok', arguments: {}}}, 60000)).result), {via: okPart});
    assert.ok(await until(() => stopped(io).length === 2), JSON.stringify(io.told));
    assert.deepStrictEqual(stopped(io).map((m) => m.name).sort(), ['@t/ch-pack-link', '@t/ch-pack-out']);
    assert.ok(stopped(io).every((m) => m.when === 'start' && typeof(m.code) === 'string'), JSON.stringify(stopped(io)));
  });

  it('a --loadModule directory outside the root is not loaded, and told stopped', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-40d-'));
    const store = path.join(home, 'module-store');
    fs.mkdirSync(store, {recursive: true});
    const s = writeModule(path.join(home, 'elsewhere', 'ch-tool-x'), {name: '@t/ch-tool-x', role: 'scenario', service: 'xService', actions: {t_x: 'module.exports = async () => ({output: {}});\n'}});
    const io = await start(home, ['--modulesRoot', store, '--loadModule', s]);
    assert.deepStrictEqual(await listed(io), []);
    assert.ok(await until(() => stopped(io).length > 0), JSON.stringify(io.told));
    assert.deepStrictEqual(stopped(io).map((m) => [m.name, m.when]), [['@t/ch-tool-x', 'start']]);
  });

  it('two units seeded from the store are each unloaded by their own package name', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-40e-'));
    const store = path.join(home, 'module-store');
    const p = part(path.join(store, '@countinghouse', 'ch-step-s', '1.0.0'), '@countinghouse/ch-step-s');
    const one = scenario(path.join(store, '@countinghouse', 'ch-pack-one', '1.0.0'), '@countinghouse/ch-pack-one', 't_one', 'ch-step-s');
    const two = scenario(path.join(store, '@countinghouse', 'ch-pack-two', '1.0.0'), '@countinghouse/ch-pack-two', 't_two', 'ch-step-s');
    const io = await start(home, ['--modulesRoot', store, '--loadModule', one, '--loadModule', two, '--partDir', p]);
    assert.deepStrictEqual(await listed(io), ['t_one', 't_two']);
    const r1 = await io.control({type: 'unload', name: '@countinghouse/ch-pack-one'});
    assert.strictEqual(r1.ok, true, JSON.stringify(r1));
    assert.deepStrictEqual(await listed(io), ['t_two']);
    const r2 = await io.control({type: 'unload', name: '@countinghouse/ch-pack-two'});
    assert.strictEqual(r2.ok, true, JSON.stringify(r2));
    assert.deepStrictEqual(await listed(io), []);
    const again = await io.control({type: 'unload', name: '@countinghouse'});
    assert.strictEqual(again.ok, false, 'no unit is recorded as @countinghouse');
  });
});
