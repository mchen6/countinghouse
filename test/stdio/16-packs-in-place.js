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
function packVersion(home, scenario, tool, version, {slow = false, remote = false} = {}) {
  const nm = path.join(home, 'packs', scenario, version, 'node_modules');
  writeModule(path.join(nm, 'ch-step-shared'), {name: 'ch-step-shared', role: 'part', service: 'stepService',
    actions: {run: 'module.exports = async () => ({output: {part: "shared"}});\n'}});
  const body = slow
    ? `module.exports = async (input, ctx) => { await new Promise((r) => setTimeout(r, Number(input.sleepMs) || 0)); const p = await ctx.call('ch-step-shared/stepService.run', {}); return {output: {version: '${version}', part: p.output.part}}; };\n`
    : `module.exports = async (input, ctx) => { const p = await ctx.call('ch-step-shared/stepService.run', {}); return {output: {version: '${version}', part: p.output.part}}; };\n`;
  return writeModule(path.join(nm, scenario), {name: scenario, version, role: 'scenario', service: 'packService',
    calls: ['ch-step-shared/stepService.run'], actions: {[tool]: body},
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
      '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc', '--requestTimeout', '4', '--loadModule', one],
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
});
