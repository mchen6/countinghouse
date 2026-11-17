'use strict';
// Shared runtime B3, Task 3: tools/list and tools/call read the session.
// A pack a session doesn't list is not in its tools/list, and a tools/call
// of one of its tools is answered exactly as a name that was never
// registered ("unknown tool"), byte for byte. Over a fake interface (as
// roles 02), with real shared sessions (lib/sessions.js attached to a
// stand-in registry) and lib/session-packs.js configured with stand-ins.
// Redis is pointed at a port nothing listens on before the registry is required.
const assert = require('assert');
const EventEmitter = require('events');
const options = require('../../lib/cli-options');
options.setOptions({redisUrl: 'redis://127.0.0.1:9749'});
require('../../lib/logger').createLogger(false);
const toolRegistry = require('../../lib/mcp/tool-registry');
const gateway = require('../../lib/mcp/gateway');
const sessions = require('../../lib/sessions');
const sessionPacks = require('../../lib/session-packs');

// (each module declares one prompt with no arguments: prompts/list and prompts/get read the session too)
const spec = (friendlyName, actions) => ({device: {friendlyName, serviceList: {'urn:x:serviceID:svc': {actionList: actions.map((a) => ({name: a, description: `${a} it`}))}},
  promptList: [{name: `${friendlyName.replace(/-/g, '_')}_brief`, description: 'Briefly.', messages: [{role: 'user', text: 'Be brief.'}]}]}});

// a pack `ci` (its scenario ch-pack-x and its unlisted part ch-step-a), a global pack `docs`, and a plain module no pack owns
function fakeInterface({withCi = true} = {}) {
  const devices = {
    d2: {spec: spec('ch-step-a', ['run']), packageInfo: {name: 'ch-step-a', countinghouse: {role: 'part'}}, hostModuleName: 'ch-step-a'},
    d3: {spec: spec('ch-pack-docs', ['docs_search']), packageInfo: {name: 'ch-pack-docs', countinghouse: {role: 'scenario'}}, hostModuleName: 'ch-pack-docs'},
    d4: {spec: spec('plain', ['go']), packageInfo: {name: 'plain'}, hostModuleName: 'plain'}
  };
  if (withCi) devices.d1 = {spec: spec('ch-pack-x', ['ci_failure_triage']), packageInfo: {name: 'ch-pack-x', countinghouse: {role: 'scenario'}}, hostModuleName: 'ch-pack-x'};
  return {deviceManager: {
    deviceMap: devices,
    moduleManager: {unlisted: new Set(['ch-step-a'])},
    getAllDeviceSpecs: () => Object.fromEntries(Object.entries(devices).map(([id, d]) => [id, d.spec]))
  }};
}

describe('sessions 15: tools/list and tools/call read the session (shared runtime B3, Task 3)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  let overrides;
  let hear;
  let ci;
  let savedDebug;
  const openSession = (reg, id) => {
    const s = new EventEmitter();
    s.id = id;
    s.client = {status: 'ok', conditions: 'yes', repo: null};
    s.notify = () => {};
    s.connected = true;
    s.record = () => {};
    s.forget = () => {};
    reg.emit('session', s);
    return s;
  };
  const override = (id, pack, value) => {
    if (!overrides.has(id)) overrides.set(id, new Map());
    if (value === undefined) overrides.get(id).delete(pack); else overrides.get(id).set(pack, value);
    hear(id);
  };
  const opts = (id) => ({session: {id, client: {status: 'ok', conditions: 'yes', repo: null}}});
  const request = (ciNow, id, method, params) => new Promise((resolve) => gateway.handle({jsonrpc: '2.0', id: 7, method, params}, ciNow, null, (err, r) => resolve(r), opts(id)));
  const names = (r) => r.result.tools.map((t) => t.name);

  beforeEach(() => {
    savedDebug = options.debug;
    options.debug = true;   // every device granted: the session is what this file looks at
    sessions.resetForTests();
    sessionPacks.resetForTests();
    const reg = new EventEmitter();
    sessions.attach(reg);
    openSession(reg, A);
    openSession(reg, B);
    overrides = new Map();
    ci = fakeInterface();
    sessionPacks.configure({
      records: () => [{pack: 'ci', modules: ['ch-pack-x', 'ch-step-a']}, {pack: 'docs', modules: ['ch-pack-docs']}],
      moduleOf: (deviceID) => { const d = ci.deviceManager.deviceMap[deviceID]; return d != null ? d.hostModuleName : null; },
      overridesOf: (id) => new Map(overrides.get(id) || []),
      onOverrideChange: (fn) => { hear = fn; },
      openSessions: () => [A, B],
      shared: () => sessions.shared()
    });
    sessionPacks.setGlobal('docs', true);
    override(A, 'ci', true);
  });
  afterEach(() => { options.debug = savedDebug; sessions.resetForTests(); sessionPacks.resetForTests(); });

  it('A\'s tools/list has the pack\'s tool and B\'s doesn\'t; B\'s is exactly its list with the pack never loaded', async () => {
    const a = await request(ci, A, 'tools/list', {});
    const b = await request(ci, B, 'tools/list', {});
    assert.ok(names(a).includes('ci_failure_triage'), JSON.stringify(names(a)));
    assert.ok(!names(b).includes('ci_failure_triage'));
    const never = await request(fakeInterface({withCi: false}), B, 'tools/list', {});
    assert.strictEqual(JSON.stringify(b), JSON.stringify(never));
  });

  it('B\'s tools/call of the pack\'s tool is answered as one with the pack unloaded, byte for byte: unknown tool', async () => {
    const hidden = await request(ci, B, 'tools/call', {name: 'ci_failure_triage', arguments: {}});
    const gone = await request(fakeInterface({withCi: false}), B, 'tools/call', {name: 'ci_failure_triage', arguments: {}});
    assert.match(hidden.error.message, /unknown tool: ci_failure_triage/);
    assert.strictEqual(JSON.stringify(hidden), JSON.stringify(gone));
  });

  it('B calling the pack\'s unlisted part by name gets unknown tool; A gets MODULE_NOT_LISTED as before', async () => {
    const b = await request(ci, B, 'tools/call', {name: 'ch_step_a_svc_run', arguments: {}});
    assert.match(b.error.message, /unknown tool: ch_step_a_svc_run/);
    const a = await request(ci, A, 'tools/call', {name: 'ch_step_a_svc_run', arguments: {}});
    assert.strictEqual(a.result._meta['countinghouse/code'], 'MODULE_NOT_LISTED');
  });

  it('B\'s legacy task-augmented call of the tool is unknown too, and makes no task', async () => {
    const b = await request(ci, B, 'tools/call', {name: 'ci_failure_triage', arguments: {}, task: {}});
    assert.match(b.error.message, /unknown tool: ci_failure_triage/);
  });

  it('a global pack B turned off: gone from B\'s list and unknown to B\'s call; A\'s unchanged', async () => {
    override(B, 'docs', false);
    assert.ok(!names(await request(ci, B, 'tools/list', {})).includes('docs_search'));
    assert.match((await request(ci, B, 'tools/call', {name: 'docs_search', arguments: {}})).error.message, /unknown tool: docs_search/);
    assert.ok(names(await request(ci, A, 'tools/list', {})).includes('docs_search'));
  });

  // the reviewer's ruling (2026-11-16): a pack's prompt surface is hidden as its tools are
  it('A\'s prompts/list has the pack\'s prompts and B\'s doesn\'t; B\'s is exactly its list with the pack never loaded', async () => {
    const pnames = (r) => r.result.prompts.map((p) => p.name);
    const a = await request(ci, A, 'prompts/list', {});
    const b = await request(ci, B, 'prompts/list', {});
    assert.ok(pnames(a).some((n) => /ch_pack_x_brief/.test(n)), JSON.stringify(pnames(a)));
    assert.ok(!pnames(b).some((n) => /ch_pack_x_brief/.test(n)), JSON.stringify(pnames(b)));
    assert.ok(!pnames(b).some((n) => /ch_step_a_brief/.test(n)), 'nor its part\'s');
    const never = await request(fakeInterface({withCi: false}), B, 'prompts/list', {});
    assert.strictEqual(JSON.stringify(b), JSON.stringify(never));
  });

  it('B\'s prompts/get of the pack\'s prompt is answered as one with the pack unloaded: unknown prompt', async () => {
    const listed = (await request(ci, A, 'prompts/list', {})).result.prompts.map((p) => p.name).find((n) => /ch_pack_x_brief/.test(n));
    const hidden = await request(ci, B, 'prompts/get', {name: listed});
    const gone = await request(fakeInterface({withCi: false}), B, 'prompts/get', {name: listed});
    assert.match(JSON.stringify(hidden), /unknown prompt/);
    assert.strictEqual(JSON.stringify(hidden), JSON.stringify(gone));
    // A's is found (past the lookup; the fake interface has no validators to check its arguments)
    const aGets = await request(ci, A, 'prompts/get', {name: listed});
    assert.doesNotMatch(JSON.stringify(aGets), /unknown prompt/);
  });

  // completion/complete (M11, #332) for a pack's prompt: the same unknown answer (the reviewer's ruling)
  it('B\'s completion/complete for the pack\'s prompt is answered as one with the pack unloaded: unknown prompt', async () => {
    const listed = (await request(ci, A, 'prompts/list', {})).result.prompts.map((p) => p.name).find((n) => /ch_pack_x_brief/.test(n));
    const params = {ref: {type: 'ref/prompt', name: listed}, argument: {name: 'x', value: ''}};
    const hidden = await request(ci, B, 'completion/complete', params);
    const gone = await request(fakeInterface({withCi: false}), B, 'completion/complete', params);
    assert.match(JSON.stringify(hidden), /unknown prompt/);
    assert.strictEqual(JSON.stringify(hidden), JSON.stringify(gone));
    assert.doesNotMatch(JSON.stringify(await request(ci, A, 'completion/complete', params)), /unknown prompt/, 'A\'s is found');
  });

  it('the global tool table is untouched: the same frozen object, and the filter hands it back while no session has a pack override', () => {
    const before = toolRegistry.buildToolTargets(ci);
    assert.strictEqual(toolRegistry.filterTargetsBySession(before, B) === before, false, 'B\'s view is a copy');
    assert.strictEqual(toolRegistry.buildToolTargets(ci), before);
    override(A, 'ci', undefined);
    sessionPacks.setGlobal('ci', true);
    assert.strictEqual(toolRegistry.filterTargetsBySession(before, B), before, 'none(): the table itself');
  });
});
