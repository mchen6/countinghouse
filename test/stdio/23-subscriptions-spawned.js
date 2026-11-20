'use strict';
// subscriptions/listen over real stdio (#231): a 2026-07-28 session (no
// initialize) opens a listen asking for toolsListChanged; a pack loaded in
// place (the control channel, as stdio 16) is announced on it, carrying the
// subscription's id, and nothing is sent unasked. A legacy session (stdio 16)
// still gets the unsolicited notice. The client's stdin ending ends the
// listen gracefully, so the process exits without waiting out the drain.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, MODERN_META} = require('../helpers/stdio-client');

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
// base: where the trees are (<home>/packs, the runtime's --modulesRoot, unless
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

const {dirsOf} = require('../helpers/module-dirs');

describe('stdio 23: subscriptions/listen, spawned (#231)', function() {
  this.timeout(120000);
  let home = null;
  let io = null;
  after(async() => {
    if (io != null && io.child.exitCode == null) { io.child.kill(); await io.exited; }
    if (home != null) fs.rmSync(home, {recursive: true, force: true});
  });
  const messages = () => io.lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((m) => m != null);
  const until = async(test, ms = 15000) => {
    const end = Date.now() + ms;
    while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return test();
  };

  it('a pack loaded in place is announced on the listen, with its id; nothing unasked; stdin\'s end ends it', async() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-23-'));
    const one = packVersion(home, 'ch-pack-one', 'tool_one', '1.0.0');
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc', '--modulesRoot', path.join(home, 'packs'), '--loadModule', one],
    {ipc: true, env: {CH_TEST_PACK_TOKEN: ''}});
    const list = await io.request({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {_meta: MODERN_META}}, 60000);
    assert.ok(list.result != null, JSON.stringify(list));
    io.notify({jsonrpc: '2.0', id: 2, method: 'subscriptions/listen', params: {_meta: MODERN_META, notifications: {toolsListChanged: true}}});
    assert.ok(await until(() => messages().some((m) => m.method === 'notifications/subscriptions/acknowledged')), io.err.slice(-1500));
    const ack = messages().find((m) => m.method === 'notifications/subscriptions/acknowledged');
    assert.deepStrictEqual(ack.params, {notifications: {toolsListChanged: true}, _meta: {'io.modelcontextprotocol/subscriptionId': 2}});
    const two = packVersion(home, 'ch-pack-two', 'tool_two', '1.0.0');
    const r = await io.control({type: 'load', name: 'ch-pack-two', dirs: dirsOf(two)});
    assert.strictEqual(r.ok, true, `${JSON.stringify(r)}\n${io.err.slice(-2000)}`);
    assert.ok(await until(() => messages().some((m) => m.method === 'notifications/tools/list_changed')), 'no list_changed on the listen');
    const changed = messages().filter((m) => m.method === 'notifications/tools/list_changed');
    assert.ok(changed.every((m) => m.params != null && m.params._meta['io.modelcontextprotocol/subscriptionId'] === 2), JSON.stringify(changed));
    assert.ok(!messages().some((m) => m.method === 'notifications/message'), 'nothing unasked');
    // a second listen, cancelled: it is closed, and never answered (#238's review)
    io.notify({jsonrpc: '2.0', id: 3, method: 'subscriptions/listen', params: {_meta: MODERN_META, notifications: {toolsListChanged: true}}});
    assert.ok(await until(() => messages().some((m) => m.method === 'notifications/subscriptions/acknowledged' && m.params._meta['io.modelcontextprotocol/subscriptionId'] === 3)));
    io.notify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 3}});
    await new Promise((r) => setTimeout(r, 300));
    const before3 = messages().filter((m) => m.method === 'notifications/tools/list_changed' && m.params._meta['io.modelcontextprotocol/subscriptionId'] === 3).length;
    const three = packVersion(home, 'ch-pack-three', 'tool_three', '1.0.0');
    assert.strictEqual((await io.control({type: 'load', name: 'ch-pack-three', dirs: dirsOf(three)})).ok, true);
    assert.ok(await until(() => messages().filter((m) => m.method === 'notifications/tools/list_changed' && m.params._meta['io.modelcontextprotocol/subscriptionId'] === 2).length >= 2), 'the open listen hears the second load');
    assert.strictEqual(messages().filter((m) => m.method === 'notifications/tools/list_changed' && m.params._meta['io.modelcontextprotocol/subscriptionId'] === 3).length, before3, 'the cancelled one hears nothing');
    const started = Date.now();
    io.child.stdin.end();
    assert.ok(await until(() => messages().some((m) => m.id === 2 && m.result != null)), 'no graceful end');
    const end = messages().find((m) => m.id === 2 && m.result != null);
    assert.strictEqual(end.result.resultType, 'complete');
    assert.strictEqual(end.result._meta['io.modelcontextprotocol/subscriptionId'], 2);
    await io.exited;
    assert.ok(Date.now() - started < 10000, 'the listen did not hold the drain');
    assert.ok(!messages().some((m) => m.id === 3), 'a cancelled listen is never answered');
  });
});
