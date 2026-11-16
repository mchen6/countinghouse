'use strict';
// MCP completeness M1 (spec section 5): a change notice compares the whole
// list, never the page a client happened to read. Over real stdio, with
// --listPageSize 10 and a scenario of 12 tools (13 listed with the usage
// report: two pages), a client reads page 1 only; a pack loaded in place,
// listed past page 1, is still announced -- unasked to a legacy session
// (route-manager's stdio fingerprint), on the listen to a 2026-07-28 one
// (the subscriptions hub's).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, MODERN_META} = require('../helpers/stdio-client');

const SVC = (s) => `urn:countinghouse-test:serviceID:${s}`;

function writeModule(dir, {name, role, calls, service, actions}) {
  fs.mkdirSync(path.join(dir, 'handlers', service), {recursive: true});
  const ch = {role};
  if (calls != null) ch.calls = calls;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', license: 'Apache-2.0', countinghouse: ch}));
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

const BODY = 'module.exports = async () => ({output: {}});\n';
// a pack as ch-local lays it out: <home>/packs/<pack>/<version>/node_modules/<scenario>
function pack(home, scenario, tools) {
  const actions = Object.fromEntries(tools.map((t) => [t, BODY]));
  return writeModule(path.join(home, 'packs', scenario, '1.0.0', 'node_modules', scenario), {name: scenario, role: 'scenario', service: 'packService', actions});
}

describe('stdio 28: a change past the first page is still announced (M1)', function() {
  this.timeout(120000);
  const homes = [];
  let io = null;
  afterEach(async() => {
    if (io != null && io.child.exitCode == null) { io.child.kill(); await io.exited; }
    io = null;
  });
  after(() => { for (const h of homes) fs.rmSync(h, {recursive: true, force: true}); });
  const messages = () => io.lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((m) => m != null);
  const until = async(test, ms = 15000) => {
    const end = Date.now() + ms;
    while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return test();
  };

  // meta: the 2026-07-28 request _meta, or null for a legacy session, which
  // sends initialize first
  async function started(meta) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-28-'));
    homes.push(home);
    const big = pack(home, 'ch-pack-big', Array.from({length: 12}, (_, i) => `big_${String(i).padStart(2, '0')}`));
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc', '--packsRoot', path.join(home, 'packs'),
      '--listPageSize', '10', '--loadModule', big], {ipc: true});
    if (meta == null) {
      const init = await io.request({jsonrpc: '2.0', id: 0, method: 'initialize',
        params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'stdio-28', version: '1.0.0'}}}, 60000);
      assert.ok(init.result != null, `${JSON.stringify(init)}\n${io.err.slice(-1500)}`);
    }
    const params = meta != null ? {_meta: meta} : {};
    const first = await io.request({jsonrpc: '2.0', id: 1, method: 'tools/list', params}, 60000);
    assert.ok(first.result != null && typeof first.result.nextCursor === 'string', `two pages: ${JSON.stringify(first).slice(0, 400)}\n${io.err.slice(-1500)}`);
    return {home, params};
  }

  async function load(home) {
    const two = pack(home, 'ch-pack-two', ['tool_two']);
    const r = await io.control({type: 'load', name: 'ch-pack-two', scenario: two});
    assert.strictEqual(r.ok, true, `${JSON.stringify(r)}\n${io.err.slice(-2000)}`);
  }
  // the premise, checked after the notice (a client that lists again needs
  // none): the new tool is listed past page 1
  async function listedPastPageOne(params) {
    const one = await io.request({jsonrpc: '2.0', id: 90, method: 'tools/list', params}, 30000);
    const rest = await io.request({jsonrpc: '2.0', id: 91, method: 'tools/list', params: Object.assign({}, params, {cursor: one.result.nextCursor})}, 30000);
    assert.ok(!one.result.tools.some((t) => t.name === 'tool_two') && rest.result.tools.some((t) => t.name === 'tool_two'),
      JSON.stringify([one.result.tools.map((t) => t.name), rest.result.tools.map((t) => t.name)]));
  }

  it('a legacy session that read page 1 is sent list_changed for a tool added on page 2', async() => {
    const {home, params} = await started(null);
    const changes = () => messages().filter((m) => m.method === 'notifications/tools/list_changed').length;
    const before = changes();
    await load(home);
    assert.ok(await until(() => changes() > before), `no list_changed\n${io.err.slice(-1500)}`);
    await listedPastPageOne(params);
  });

  // The review of M1: what a client was shown is the list as it was when it
  // began paging. A page-1 tool that goes while it pages is announced, even
  // when the next page is read before the change has settled.
  it('a legacy session paging on is sent list_changed for a tool gone from page 1 it already read', async() => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-28-'));
    homes.push(home);
    const zero = pack(home, 'ch-pack-zero', ['zero_tool']);
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc', '--packsRoot', path.join(home, 'packs'),
      '--listPageSize', '10', '--loadModule', zero], {ipc: true});
    const init = await io.request({jsonrpc: '2.0', id: 0, method: 'initialize',
      params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'stdio-28', version: '1.0.0'}}}, 60000);
    assert.ok(init.result != null, `${JSON.stringify(init)}\n${io.err.slice(-1500)}`);
    for (const [name, tools] of [['ch-pack-a', ['a_1', 'a_2', 'a_3']], ['ch-pack-big', Array.from({length: 12}, (_, i) => `big_${String(i).padStart(2, '0')}`)]]) {
      const r = await io.control({type: 'load', name, scenario: pack(home, name, tools)});
      assert.strictEqual(r.ok, true, `${JSON.stringify(r)}\n${io.err.slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
    const one = await io.request({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}}, 60000);
    assert.ok(one.result.tools.some((t) => t.name === 'a_1') && typeof one.result.nextCursor === 'string', JSON.stringify(one.result.tools.map((t) => t.name)));
    await new Promise((r) => setTimeout(r, 1000));
    const changes = () => messages().filter((m) => m.method === 'notifications/tools/list_changed').length;
    const before = changes();
    // the next page read while the unload happens, inside its settling
    const unloading = io.control({type: 'unload', name: 'ch-pack-a'});
    const pages = [];
    for (let i = 0; i < 6; i++) {
      pages.push(io.request({jsonrpc: '2.0', id: 10 + i, method: 'tools/list', params: {cursor: one.result.nextCursor}}, 30000));
      await new Promise((r) => setTimeout(r, 60));
    }
    const gone = await unloading;
    assert.strictEqual(gone.ok, true, JSON.stringify(gone));
    for (const two of await Promise.all(pages)) assert.ok(two.result != null, JSON.stringify(two));
    assert.ok(await until(() => changes() > before), `no list_changed\n${io.err.slice(-1500)}`);
  });

  it('a 2026-07-28 listen opened after reading page 1 hears of a tool added on page 2', async() => {
    const {home, params} = await started(MODERN_META);
    io.notify({jsonrpc: '2.0', id: 2, method: 'subscriptions/listen', params: {_meta: MODERN_META, notifications: {toolsListChanged: true}}});
    assert.ok(await until(() => messages().some((m) => m.method === 'notifications/subscriptions/acknowledged')), io.err.slice(-1500));
    await load(home);
    assert.ok(await until(() => messages().some((m) => m.method === 'notifications/tools/list_changed' &&
      m.params != null && m.params._meta['io.modelcontextprotocol/subscriptionId'] === 2)), `no list_changed on the listen\n${io.err.slice(-1500)}`);
    await listedPastPageOne(params);
  });
});
