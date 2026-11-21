'use strict';
// B-own-runtime (the own-modules design, tech/plans/2026-11-20-own-modules-
// design.md §2.3): the authoring tools in the single-identity profile, for
// the local user's own modules. validate_plan is open; validate_module is
// open and static -- it never runs the module's code, and reads only a
// folder outside the ch-local home, --modulePath and --moduleDataPath,
// reached through no link; load_module never loads here: it names the
// command the user runs in their own terminal (ch-local add-module).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {startStdio, withoutRedisNoise, INITIALIZE} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp').forFile(['ch-stdio-51-'], {base: require('os').tmpdir()});

const SVC = (s) => `urn:countinghouse-test:serviceID:${s}`;
// a module folder; marker: a file its handler writes when it is required
function writeModule(dir, {name = 'my-own-tool', deps = null, marker = null, role = 'scenario'} = {}) {
  fs.mkdirSync(path.join(dir, 'handlers', 'toolService'), {recursive: true});
  const pkg = {name, version: '1.0.0', license: 'Apache-2.0'};
  if (role != null) pkg.countinghouse = {role};
  if (deps != null) pkg.dependencies = deps;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name, manufacturer: 'me', modelDescription: 'mine',
    serviceList: {[SVC('toolService')]: {actionList: [{name: 'run', description: 'runs', input: {schema: '/toolService/run/input'}, output: {schema: '/toolService/run/output'}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    toolService: {run: {input: {type: 'object'}, output: {type: 'object'}}}}));
  const ran = marker != null ? `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n` : '';
  fs.writeFileSync(path.join(dir, 'handlers', 'toolService', 'run.js'), `${ran}module.exports = async () => ({output: {ok: true}});\n`);
  return dir;
}

describe('stdio 51: the authoring tools in the single-identity profile (B-own-runtime)', function() {
  this.timeout(120000);
  let home = null;
  let work = null;
  let io = null;
  let id = 10;
  const call = (name, args) => io.request({jsonrpc: '2.0', id: id++, method: 'tools/call', params: {name, arguments: args}}, 60000);
  const resultOf = (r) => {
    assert.ok(r.result != null, JSON.stringify(r));
    return r.result;
  };

  before(async () => {
    // (by their real paths: a temp folder can be reached through a link, as
    // macOS's is, and the profile refuses a path through one)
    home = fs.realpathSync.native(tmp.mkdtemp('ch-stdio-51-'));
    work = fs.realpathSync.native(tmp.mkdtemp('ch-stdio-51-'));   // the user's own folders, outside the home
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--settingsFile', path.join(home, 'settings.json')]);
    const init = await io.request({...INITIALIZE, id: 1}, 30000);
    assert.ok(init.result != null, JSON.stringify(init));
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
  });
  after(async () => { if (io != null) await io.stop(); });

  it('lists validate_plan, validate_module and load_module to the local user', async () => {
    const tools = (await io.request({jsonrpc: '2.0', id: id++, method: 'tools/list', params: {}}, 30000)).result.tools.map((t) => t.name);
    for (const t of ['countinghouse_validate_plan', 'countinghouse_validate_module', 'countinghouse_load_module']) assert.ok(tools.includes(t), `${t}: ${JSON.stringify(tools)}`);
  });

  it('validate_plan checks a design', async () => {
    const r = resultOf(await call('countinghouse_validate_plan', {device: 'my-plan', services: [{name: 'svc', actions: [{name: 'run', description: 'runs'}]}]}));
    assert.strictEqual(r.isError, false, JSON.stringify(r));
  });

  it('validate_module checks a folder without running its code', async () => {
    const marker = path.join(work, 'ran.txt');
    const dir = writeModule(path.join(work, 'clean'), {marker});
    const r = resultOf(await call('countinghouse_validate_module', {path: dir}));
    assert.strictEqual(r.isError, false, `${JSON.stringify(r)}\n${withoutRedisNoise(io.err).slice(-1500)}`);
    assert.strictEqual(r.structuredContent.ok, true, JSON.stringify(r.structuredContent));
    assert.strictEqual(fs.existsSync(marker), false, 'its handler file was required: its code ran');
  });

  // (an own module is a scenario: the profile lists only scenarios' tools)
  it('validate_module says an own module is a scenario', async () => {
    const dir = writeModule(path.join(work, 'no-role'), {role: null});
    const r = resultOf(await call('countinghouse_validate_module', {path: dir}));
    assert.strictEqual(r.structuredContent.ok, false);
    assert.ok(r.structuredContent.problems.some((p) => /"role": "scenario"/.test(p.message)), JSON.stringify(r.structuredContent.problems));
  });

  it('validate_module refuses dependencies, as add-module will', async () => {
    const dir = writeModule(path.join(work, 'deps'), {deps: {'left-pad': '1.3.0'}});
    const r = resultOf(await call('countinghouse_validate_module', {path: dir}));
    assert.strictEqual(r.structuredContent.ok, false);
    assert.ok(r.structuredContent.problems.some((p) => /dependencies/.test(p.message)), JSON.stringify(r.structuredContent.problems));
  });

  it('validate_module reads no folder inside the home, --modulePath or --moduleDataPath, and none reached through a link', async () => {
    const inHome = writeModule(path.join(home, 'own-in-home'));
    const inModules = writeModule(path.join(home, 'modules', 'x'));
    const inData = writeModule(path.join(home, 'module_data', 'x'));
    const real = writeModule(path.join(work, 'real'));
    const linked = path.join(work, 'linked');
    fs.symlinkSync(real, linked, 'dir');
    for (const p of [inHome, inModules, inData, linked, path.join(linked, '.')]) {
      const r = resultOf(await call('countinghouse_validate_module', {path: p}));
      assert.strictEqual(r.isError, true, `${p}: ${JSON.stringify(r)}`);
      assert.strictEqual(r._meta['countinghouse/code'], 'OWN_MODULE_PATH_REFUSED', `${p}: ${JSON.stringify(r)}`);
    }
  });

  // (the medium on B-own-runtime, 1) a link inside the folder is never read
  // through, and nothing it points at reaches the answer
  it('validate_module never reads through a link inside the folder, nor quotes what it points at', async () => {
    const secret = path.join(work, 'outside-secret.txt');
    fs.writeFileSync(secret, 'sk-very-secret-value');
    const dir = writeModule(path.join(work, 'with-link'));
    fs.rmSync(path.join(dir, 'api.json'));
    fs.symlinkSync(secret, path.join(dir, 'api.json'));
    const r = resultOf(await call('countinghouse_validate_module', {path: dir}));
    assert.strictEqual(r.structuredContent.ok, false);
    assert.ok(r.structuredContent.problems.some((p) => /link/.test(p.message)), JSON.stringify(r.structuredContent));
    assert.ok(!JSON.stringify(r).includes('sk-very-secret'), 'the linked file\'s text');
  });

  // (the reviewer's high on #499, 1) package.json linked, or a second name
  // of, a JSON file elsewhere: refused before anything is read, its name
  // never in the answer
  it('validate_module reads nothing of a package.json that is a link or a second name of another file', async () => {
    const other = path.join(home, 'someone-elses.json');
    fs.writeFileSync(other, JSON.stringify({name: 'LEAKED-NAME-FROM-HOME'}));
    const linked = writeModule(path.join(work, 'pkg-link'));
    fs.rmSync(path.join(linked, 'package.json'));
    fs.symlinkSync(other, path.join(linked, 'package.json'));
    const twice = writeModule(path.join(work, 'pkg-twice'));
    fs.rmSync(path.join(twice, 'package.json'));
    fs.linkSync(other, path.join(twice, 'package.json'));
    for (const dir of [linked, twice]) {
      const r = resultOf(await call('countinghouse_validate_module', {path: dir}));
      assert.strictEqual(r.structuredContent.ok, false, JSON.stringify(r));
      assert.ok(!JSON.stringify(r).includes('LEAKED-NAME'), `${dir}: ${JSON.stringify(r)}`);
    }
  });

  // (the reviewer's high on #499, 2) a FIFO never holds the runtime
  it('validate_module never opens a FIFO in the folder', async function() {
    if (process.platform === 'win32') this.skip();
    const dir = writeModule(path.join(work, 'fifo'));
    fs.rmSync(path.join(dir, 'api.json'));
    require('child_process').execFileSync('mkfifo', [path.join(dir, 'api.json')]);
    const r = resultOf(await call('countinghouse_validate_module', {path: dir}));
    assert.strictEqual(r.structuredContent.ok, false);
    assert.ok(r.structuredContent.problems.some((p) => /neither a file nor a folder \(api\.json\)/.test(p.message)), JSON.stringify(r.structuredContent));
    // and the runtime still answers
    assert.ok((await io.request({jsonrpc: '2.0', id: id++, method: 'tools/list', params: {}}, 10000)).result != null);
  });

  // (the reviewer's high on #499, 3) a parse error's text never reaches the
  // answer, past a ';' or a line break too
  it('validate_module names a file that does not parse, never its text', async () => {
    const dir = writeModule(path.join(work, 'bad-json'));
    fs.writeFileSync(path.join(dir, 'api.json'), 'x;SECRET-A\nSECRET-B');
    const r = resultOf(await call('countinghouse_validate_module', {path: dir}));
    assert.strictEqual(r.structuredContent.ok, false);
    assert.ok(!/SECRET/.test(JSON.stringify(r)), JSON.stringify(r));
  });

  it('validate_module refuses a folder that holds the home', async () => {
    const r = resultOf(await call('countinghouse_validate_module', {path: path.dirname(home)}));
    assert.strictEqual(r._meta['countinghouse/code'], 'OWN_MODULE_PATH_REFUSED', JSON.stringify(r));
  });

  it('load_module never loads here: it names the command for the user\'s own terminal', async () => {
    const dir = writeModule(path.join(work, 'to-load'));
    const r = resultOf(await call('countinghouse_load_module', {path: dir, name: 'my-own-tool'}));
    assert.strictEqual(r.isError, true, JSON.stringify(r));
    assert.strictEqual(r._meta['countinghouse/code'], 'OWN_MODULE_NEEDS_TERMINAL');
    assert.match(r.content[0].text, /^Loading your own module needs your confirmation: run `ch-local add-module ".+to-load"` in your own terminal\.$/);
    const tools = (await io.request({jsonrpc: '2.0', id: id++, method: 'tools/list', params: {}}, 30000)).result.tools.map((t) => t.name);
    assert.ok(!tools.some((t) => /my_own_tool/.test(t)), 'nothing was loaded');
    // a folder no shell would read plainly is left out of the command
    const odd = writeModule(path.join(work, 'odd$(x)'));
    const o = resultOf(await call('countinghouse_load_module', {path: odd, name: 'my-own-tool'}));
    assert.strictEqual(o.content[0].text, 'Loading your own module needs your confirmation: run `ch-local add-module "<its folder>"` in your own terminal.');
    // (the medium, 8) a character that changes how the command is shown
    const bidi = resultOf(await call('countinghouse_load_module', {path: `${work}/ok\u202Eevil`, name: 'my-own-tool'}));
    assert.strictEqual(bidi.content[0].text, 'Loading your own module needs your confirmation: run `ch-local add-module "<its folder>"` in your own terminal.');
  });

  tmp.hooks();
});
