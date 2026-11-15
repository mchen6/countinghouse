// Packs in place (part 2, plan Task A3; docs/superpowers/specs/
// 2026-11-14-packs-in-place-and-settings-tool-design.md section 2): over the
// control channel, ch-local start loads, unloads and reloads a pack while
// the runtime serves, under the same checks as at start, and each change
// ends with one notifications/tools/list_changed.
// - Two packs share a part (one version, so it loads once). Unloading one
//   keeps the part for the other (Review Focus 2).
// - A reload drains, then switches (the reviewer's ruling A): a call already
//   running answers from the old version, a call after the reload from the
//   new one. An old version that never drains is ended at --requestTimeout
//   (Review Focus 1).
// - A pack whose credential variable is allowed by its own credentials file
//   but not set is refused REMOTE_CREDENTIAL_MISSING, and nothing of it is
//   listed or contacted (the remote is .invalid).
// Packs are named by their scenario's package name (the reviewer's ruling).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, INITIALIZE} = require('../helpers/stdio-client');
const {toolOutput} = require('../helpers/tool-result');

const SVC = (s) => `urn:countinghouse-test:serviceID:${s}`;

// A module on disk: package.json, api.json, schema.json, one handler per
// action (source given).
function writeModule(dir, {name, version = '1.0.0', role, calls, remotes, service, actions}) {
  fs.mkdirSync(path.join(dir, 'handlers', service), {recursive: true});
  const ch = {};
  if (role != null) ch.role = role;
  if (calls != null) ch.calls = calls;
  if (remotes != null) ch.remotes = remotes;
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

// A pack version as ch-local lays it out: <home>/packs/<pack>/<version>/
// node_modules/<scenario>, with the shared part beside it.
// base: where the trees are (<home>/packs, the runtime's --packsRoot, unless
// a case puts one elsewhere). brokenPart: the scenario also calls a part
// whose handler file is missing, so that part's load is refused.
// sharedVersion, sharedBroken: the shared part at another version, whose
// handler file is missing, so its spawn is refused (lib/module-manager.js
// spawnModuleWorker's layout check, after a reload has unloaded the old one).
function packVersion(home, scenario, tool, version, {slow = false, remote = false, base = path.join(home, 'packs'), brokenPart = false,
  sharedVersion = '1.0.0', sharedBroken = false} = {}) {
  const nm = path.join(base, scenario, version, 'node_modules');
  const shared = writeModule(path.join(nm, 'ch-step-shared'), {name: 'ch-step-shared', version: sharedVersion, role: 'part', service: 'stepService',
    actions: {run: 'module.exports = async () => ({output: {part: "shared"}});\n'}});
  if (sharedBroken) fs.rmSync(path.join(shared, 'handlers', 'stepService', 'run.js'));
  if (brokenPart) {
    const dir = writeModule(path.join(nm, 'ch-step-broken'), {name: 'ch-step-broken', role: 'part', service: 'brokenService',
      actions: {run: 'module.exports = async () => ({output: {}});\n'}});
    fs.rmSync(path.join(dir, 'handlers', 'brokenService', 'run.js'));
  }
  const body = slow
    ? `module.exports = async (input, ctx) => { await new Promise((r) => setTimeout(r, Number(input.sleepMs) || 0)); const p = await ctx.call('ch-step-shared/stepService.run', {}); return {output: {version: '${version}', part: p.output.part}}; };\n`
    : `module.exports = async (input, ctx) => { const p = await ctx.call('ch-step-shared/stepService.run', {}); return {output: {version: '${version}', part: p.output.part}}; };\n`;
  return writeModule(path.join(nm, scenario), {name: scenario, version, role: 'scenario', service: 'packService',
    calls: ['ch-step-shared/stepService.run'].concat(brokenPart ? ['ch-step-broken/brokenService.run'] : []), actions: {[tool]: body},
    remotes: remote ? [{name: 'needs', transport: 'streamable-http', url: 'https://remote.invalid/mcp', credential: {env: 'CH_TEST_PACK_TOKEN'}}] : undefined});
}

describe('stdio 16: packs loaded, unloaded and reloaded in place', function() {
  this.timeout(120000);
  let home = null;
  let io = null;
  let nextId = 10;
  const call = (name, args = {}, ms = 60000) => io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: {name, arguments: args}}, ms);
  const listed = async () => (await io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/list'}, 60000)).result.tools.map((t) => t.name);
  // the module's output, with the response in the message if it is not one
  const outOf = (response) => {
    const out = toolOutput(response != null ? response.result : null);
    return (out !== undefined) ? out : {response: JSON.stringify(response).slice(0, 600), err: io.err.slice(-1500)};
  };
  const changes = () => io.lines.filter((l) => /"method":"notifications\/tools\/list_changed"/.test(l)).length;
  const until = async (test, ms = 10000) => {
    const end = Date.now() + ms;
    while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return test();
  };

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-16-'));
    const one = packVersion(home, 'ch-pack-one', 'tool_one', '1.0.0');
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc', '--packsRoot', path.join(home, 'packs'), '--requestTimeout', '4', '--loadModule', one],
    {ipc: true, env: {CH_TEST_PACK_TOKEN: ''}});
    const init = await io.request(INITIALIZE, 30000);
    assert.ok(init.result != null, JSON.stringify(init));
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
    assert.deepStrictEqual((await listed()).filter((n) => n.startsWith('tool_')), ['tool_one'], io.err.slice(-2000));
  });
  after(async () => {
    if (io != null && io.child.exitCode == null) { io.child.kill(); await io.exited; }
    if (home != null) fs.rmSync(home, {recursive: true, force: true});
  });

  it('load: the pack\'s tool is listed and answers, after one list_changed; the shared part is loaded once', async () => {
    const before = changes();
    const two = packVersion(home, 'ch-pack-two', 'tool_two', '1.0.0', {slow: true});
    const r = await io.control({type: 'load', name: 'ch-pack-two', scenario: two});
    assert.strictEqual(r.ok, true, `${JSON.stringify(r)}\n${io.err.slice(-2000)}`);
    assert.deepStrictEqual(r.tools, ['tool_two']);
    assert.ok(await until(() => changes() === before + 1), 'no list_changed');
    assert.deepStrictEqual((await listed()).filter((n) => n.startsWith('tool_')).sort(), ['tool_one', 'tool_two']);
    assert.deepStrictEqual(outOf(await call('tool_two')), {version: '1.0.0', part: 'shared'});
  });

  it('a load naming a scenario of another package name is refused, and nothing loads', async () => {
    const r = await io.control({type: 'load', name: 'ch-pack-other', scenario: path.join(home, 'packs', 'ch-pack-two', '1.0.0', 'node_modules', 'ch-pack-two')});
    assert.deepStrictEqual([r.ok, r.code], [false, 'CONTROL_FAILED']);
  });

  it('unload: its tool is gone; the shared part stays for the other pack, whose tool still answers', async () => {
    const before = changes();
    const r = await io.control({type: 'unload', name: 'ch-pack-one'});
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(await until(() => changes() === before + 1), 'no list_changed');
    assert.deepStrictEqual((await listed()).filter((n) => n.startsWith('tool_')), ['tool_two']);
    assert.deepStrictEqual(outOf(await call('tool_two')), {version: '1.0.0', part: 'shared'});
    const again = await io.control({type: 'unload', name: 'ch-pack-one'});
    assert.deepStrictEqual([again.ok, again.code], [false, 'CONTROL_FAILED'], 'a name not loaded');
  });

  it('reload: a call running on the old version answers from it; a call after the switch answers from the new one', async () => {
    const slow = call('tool_two', {sleepMs: 1500});
    await new Promise((r) => setTimeout(r, 300));
    const v2 = packVersion(home, 'ch-pack-two', 'tool_two', '2.0.0', {slow: true});
    const r = await io.control({type: 'reload', name: 'ch-pack-two', scenario: v2});
    assert.strictEqual(r.ok, true, `${JSON.stringify(r)}\n${io.err.slice(-2000)}`);
    assert.deepStrictEqual(outOf(await call('tool_two')), {version: '2.0.0', part: 'shared'});
    assert.deepStrictEqual(outOf(await slow), {version: '1.0.0', part: 'shared'});
  });

  it('an old version that never drains is ended at --requestTimeout, and what it owes is answered', async () => {
    const stuck = call('tool_two', {sleepMs: 60000});
    await new Promise((r) => setTimeout(r, 300));
    const v3 = packVersion(home, 'ch-pack-two', 'tool_two', '3.0.0', {slow: true});
    const started = Date.now();
    const r = await io.control({type: 'reload', name: 'ch-pack-two', scenario: v3});
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const answer = await stuck;
    assert.ok(answer.result == null || answer.result.isError === true || answer.error != null, JSON.stringify(answer));
    assert.ok(await until(() => /its old version still owed 1 answers at --requestTimeout; ended/.test(io.err), 8000), io.err.slice(-2000));
    assert.ok(Date.now() - started < 15000);
    assert.deepStrictEqual(outOf(await call('tool_two')), {version: '3.0.0', part: 'shared'});
  });

  it('a pack whose credential variable is allowed but not set is refused REMOTE_CREDENTIAL_MISSING; nothing is listed', async () => {
    const three = packVersion(home, 'ch-pack-three', 'tool_three', '1.0.0', {remote: true});
    const creds = path.join(home, 'remote-credentials-ch-pack-three.json');
    fs.writeFileSync(creds, JSON.stringify({'https://remote.invalid': ['CH_TEST_PACK_TOKEN']}));
    const r = await io.control({type: 'load', name: 'ch-pack-three', scenario: three, remoteCredentials: creds});
    assert.deepStrictEqual([r.ok, r.code], [false, 'REMOTE_CREDENTIAL_MISSING'], JSON.stringify(r));
    assert.ok(!(await listed()).includes('tool_three'));
  });

  // #205's review (1): confinement to --packsRoot, by real path.
  it('a scenario outside --packsRoot is refused, and so is one whose part is a link out of it; nothing loads', async () => {
    const outside = packVersion(home, 'ch-pack-out', 'tool_out', '1.0.0', {base: path.join(home, 'elsewhere')});
    const r1 = await io.control({type: 'load', name: 'ch-pack-out', scenario: outside});
    assert.deepStrictEqual([r1.ok, r1.code], [false, 'CONTROL_FAILED']);
    assert.match(r1.message, /outside --packsRoot/);
    const linked = packVersion(home, 'ch-pack-link', 'tool_link', '1.0.0');
    const nm = path.dirname(linked);
    const away = path.join(home, 'elsewhere', 'ch-step-shared');
    fs.cpSync(path.join(nm, 'ch-step-shared'), away, {recursive: true});
    fs.rmSync(path.join(nm, 'ch-step-shared'), {recursive: true, force: true});
    fs.symlinkSync(away, path.join(nm, 'ch-step-shared'), 'dir');
    const r2 = await io.control({type: 'load', name: 'ch-pack-link', scenario: linked});
    assert.deepStrictEqual([r2.ok, r2.code], [false, 'CONTROL_FAILED'], JSON.stringify(r2));
    assert.match(r2.message, /ch-step-shared is outside --packsRoot/);
    const tools = await listed();
    assert.ok(!tools.includes('tool_out') && !tools.includes('tool_link'));
  });

  // (2): what a pack owns is its record's, not what disk says at unload.
  it('a pack whose tree was removed before its unload is still unloaded: its tool goes', async () => {
    const four = packVersion(home, 'ch-pack-four', 'tool_four', '1.0.0');
    const r = await io.control({type: 'load', name: 'ch-pack-four', scenario: four});
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok((await listed()).includes('tool_four'));
    fs.rmSync(path.join(home, 'packs', 'ch-pack-four'), {recursive: true, force: true});
    const u = await io.control({type: 'unload', name: 'ch-pack-four'});
    assert.strictEqual(u.ok, true, JSON.stringify(u));
    let tools = await listed();
    for (let i = 0; tools.includes('tool_four') && i < 100; i++) { await new Promise((res) => setTimeout(res, 50)); tools = await listed(); }
    assert.ok(!tools.includes('tool_four'), 'its tool stayed listed');
    // the shared part is still the other pack's
    assert.deepStrictEqual(outOf(await call('tool_two')), {version: '3.0.0', part: 'shared'});
  });

  // (3): a reload switches all or none.
  it('a reload that fails part-way switches back: the old version answers, and nothing of the new one stays', async () => {
    const bad = packVersion(home, 'ch-pack-two', 'tool_two', '4.0.0', {slow: true, brokenPart: true});
    const r = await io.control({type: 'reload', name: 'ch-pack-two', scenario: bad});
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.deepStrictEqual(outOf(await call('tool_two')), {version: '3.0.0', part: 'shared'});
    const again = packVersion(home, 'ch-pack-two', 'tool_two', '5.0.0', {slow: true});
    const ok = await io.control({type: 'reload', name: 'ch-pack-two', scenario: again});
    assert.strictEqual(ok.ok, true, `${JSON.stringify(ok)}: the record was left at the failed version`);
    assert.deepStrictEqual(outOf(await call('tool_two')), {version: '5.0.0', part: 'shared'});
  });

  // The re-review (1): a module whose switch unloaded its old version, and
  // whose new version then fails to spawn, is put back too.
  it('a reload whose switched part fails to spawn puts the part\'s old version back: the pack answers as before', async () => {
    const bad = packVersion(home, 'ch-pack-two', 'tool_two', '6.0.0', {slow: true, sharedVersion: '2.0.0', sharedBroken: true});
    const r = await io.control({type: 'reload', name: 'ch-pack-two', scenario: bad});
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.deepStrictEqual(outOf(await call('tool_two')), {version: '5.0.0', part: 'shared'});
  });

  // (3): a file link out of --packsRoot inside a confined module is refused.
  it('a scenario whose handler file is a link out of --packsRoot is refused; nothing loads', async () => {
    const six = packVersion(home, 'ch-pack-six', 'tool_six', '1.0.0');
    const handler = path.join(six, 'handlers', 'packService', 'tool_six.js');
    const away = path.join(home, 'elsewhere', 'tool_six.js');
    fs.mkdirSync(path.dirname(away), {recursive: true});
    fs.copyFileSync(handler, away);
    fs.rmSync(handler);
    fs.symlinkSync(away, handler);
    const r = await io.control({type: 'load', name: 'ch-pack-six', scenario: six});
    assert.deepStrictEqual([r.ok, r.code], [false, 'CONTROL_FAILED'], JSON.stringify(r));
    assert.match(r.message, /has a link outside --packsRoot/);
    assert.ok(!(await listed()).includes('tool_six'));
  });
});
