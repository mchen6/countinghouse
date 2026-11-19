'use strict';
// Shared runtime B3, Task 3, as M5a leaves it (module-level configuration,
// #413 rev 3, sections 5.4 and 5.5): no session has a view of its own. A
// module going on or off (lib/module-visibility.js) is in no session's
// tools/list, and a tools/call of one of its tools is answered exactly as a
// name that was never registered ("unknown tool"), byte for byte, for every
// session alike. Over a fake interface (as roles 02), with real shared
// sessions (lib/sessions.js attached to a stand-in registry) and the
// visibility set configured with a stand-in device map.
// Redis is pointed at port 1 (nothing can listen there, a private Redis
// included) before the registry is required.
const assert = require('assert');
const EventEmitter = require('events');
const options = require('../../lib/cli-options');
options.setOptions({redisUrl: 'redis://127.0.0.1:1'});
require('../../lib/logger').createLogger();
const toolRegistry = require('../../lib/mcp/tool-registry');
const gateway = require('../../lib/mcp/gateway');
const sessions = require('../../lib/sessions');
const visibility = require('../../lib/module-visibility');

// (each module declares one prompt with no arguments: prompts/list and prompts/get hide a hidden module's too)
// (and an action named *_res declares a resource, M7: one static, one a template, so resources/list and
// resources/templates/list hide a hidden module's too)
const spec = (friendlyName, actions) => ({device: {friendlyName, serviceList: {'urn:x:serviceID:svc': {actionList: actions.map((a) => Object.assign({name: a, description: `${a} it`},
  /_res$/.test(a) ? {resource: {uriTemplate: 'all', name: `${friendlyName}-all`}} : {}, /_tpl$/.test(a) ? {resource: {uriTemplate: 'logs/{id}', name: `${friendlyName}-logs`}} : {}))}},
  promptList: [{name: `${friendlyName.replace(/-/g, '_')}_brief`, description: 'Briefly.', messages: [{role: 'user', text: 'Be brief.'}]}]}});

// a scenario ch-pack-x and its unlisted part ch-step-a (`withCi`), a scenario ch-pack-docs, and a plain module
function fakeInterface({withCi = true} = {}) {
  const devices = {
    d2: {spec: spec('ch-step-a', ['run']), packageInfo: {name: 'ch-step-a', countinghouse: {role: 'part'}}, hostModuleName: 'ch-step-a'},
    d3: {spec: spec('ch-pack-docs', ['docs_search']), packageInfo: {name: 'ch-pack-docs', countinghouse: {role: 'scenario'}}, hostModuleName: 'ch-pack-docs'},
    d4: {spec: spec('plain', ['go']), packageInfo: {name: 'plain'}, hostModuleName: 'plain'}
  };
  if (withCi) devices.d1 = {spec: spec('ch-pack-x', ['ci_failure_triage', 'ci_res', 'ci_tpl']), packageInfo: {name: 'ch-pack-x', countinghouse: {role: 'scenario'}}, hostModuleName: 'ch-pack-x'};
  return {deviceManager: {
    deviceMap: devices,
    moduleManager: {unlisted: new Set(['ch-step-a'])},
    getAllDeviceSpecs: () => Object.fromEntries(Object.entries(devices).map(([id, d]) => [id, d.spec]))
  }};
}


describe('sessions 15: a module going on or off is in no session\'s lists (B3 Task 3, as M5a leaves it)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
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
  const opts = (id) => ({session: {id, client: {status: 'ok', conditions: 'yes', repo: null}}});
  const request = (ciNow, id, method, params) => new Promise((resolve) => gateway.handle({jsonrpc: '2.0', id: 7, method, params}, ciNow, null, (err, r) => resolve(r), opts(id)));
  const names = (r) => r.result.tools.map((t) => t.name);
  const pnames = (r) => r.result.prompts.map((p) => p.name);
  // the prompt of ch-pack-x, as listed while nothing is hidden
  const ciPrompt = async () => pnames(await request(ci, A, 'prompts/list', {})).find((n) => /ch_pack_x_brief/.test(n));

  beforeEach(() => {
    savedDebug = options.debug;
    options.debug = true;   // every device granted: the visibility set is what this file looks at
    sessions.resetForTests();
    visibility.resetForTests();
    const reg = new EventEmitter();
    sessions.attach(reg);
    openSession(reg, A);
    openSession(reg, B);
    ci = fakeInterface();
    visibility.configure({moduleOf: (deviceID) => { const d = ci.deviceManager.deviceMap[deviceID]; return d != null ? d.hostModuleName : null; }, isGone: () => false});
  });
  afterEach(() => { options.debug = savedDebug; sessions.resetForTests(); visibility.resetForTests(); });

  // what a pack-form load of ch-pack-x hides until it completes: the scenario and the part it newly brings in
  const hideCi = () => visibility.hide(['ch-pack-x', 'ch-step-a']);

  it('every session lists a loaded module: A\'s and B\'s tools/list are the same', async () => {
    const a = await request(ci, A, 'tools/list', {});
    const b = await request(ci, B, 'tools/list', {});
    assert.ok(names(a).includes('ci_failure_triage'), JSON.stringify(names(a)));
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  });

  it('a hidden module is in neither session\'s tools/list; each is exactly its list with the module never loaded', async () => {
    hideCi();
    const never = JSON.stringify(await request(fakeInterface({withCi: false}), B, 'tools/list', {}));
    for (const id of [A, B]) {
      const r = await request(ci, id, 'tools/list', {});
      assert.ok(!names(r).includes('ci_failure_triage'), JSON.stringify(names(r)));
      assert.strictEqual(JSON.stringify(r), never);
    }
    visibility.show(['ch-pack-x', 'ch-step-a']);
    assert.ok(names(await request(ci, B, 'tools/list', {})).includes('ci_failure_triage'), 'listed again once shown');
  });

  it('a tools/call of a hidden module\'s tool is answered as one with the module unloaded, byte for byte: unknown tool', async () => {
    hideCi();
    for (const id of [A, B]) {
      const hidden = await request(ci, id, 'tools/call', {name: 'ci_failure_triage', arguments: {}});
      const gone = await request(fakeInterface({withCi: false}), id, 'tools/call', {name: 'ci_failure_triage', arguments: {}});
      assert.match(hidden.error.message, /unknown tool: ci_failure_triage/);
      assert.strictEqual(JSON.stringify(hidden), JSON.stringify(gone));
    }
  });

  it('calling a hidden unlisted part by name gets unknown tool; once shown, MODULE_NOT_LISTED as before', async () => {
    hideCi();
    const hidden = await request(ci, B, 'tools/call', {name: 'ch_step_a_svc_run', arguments: {}});
    assert.match(hidden.error.message, /unknown tool: ch_step_a_svc_run/);
    visibility.show(['ch-pack-x', 'ch-step-a']);
    const shown = await request(ci, B, 'tools/call', {name: 'ch_step_a_svc_run', arguments: {}});
    assert.strictEqual(shown.result._meta['countinghouse/code'], 'MODULE_NOT_LISTED');
  });

  it('a legacy task-augmented call of a hidden module\'s tool is unknown too, and makes no task', async () => {
    hideCi();
    const b = await request(ci, B, 'tools/call', {name: 'ci_failure_triage', arguments: {}, task: {}});
    assert.match(b.error.message, /unknown tool: ci_failure_triage/);
  });

  // the reviewer's ruling (2026-11-16): a module's prompt surface is hidden as its tools are
  it('a hidden module\'s prompts are in no session\'s prompts/list; each is exactly its list with the module never loaded', async () => {
    assert.ok(await ciPrompt(), 'listed while nothing is hidden');
    hideCi();
    const never = JSON.stringify(await request(fakeInterface({withCi: false}), B, 'prompts/list', {}));
    for (const id of [A, B]) {
      const r = await request(ci, id, 'prompts/list', {});
      assert.ok(!pnames(r).some((n) => /ch_pack_x_brief|ch_step_a_brief/.test(n)), JSON.stringify(pnames(r)));
      assert.strictEqual(JSON.stringify(r), never);
    }
  });

  it('a prompts/get of a hidden module\'s prompt is answered as one with the module unloaded: unknown prompt', async () => {
    const listed = await ciPrompt();
    // found while shown (past the lookup; the fake interface has no validators to check its arguments)
    assert.doesNotMatch(JSON.stringify(await request(ci, A, 'prompts/get', {name: listed})), /unknown prompt/);
    hideCi();
    const hidden = await request(ci, B, 'prompts/get', {name: listed});
    const gone = await request(fakeInterface({withCi: false}), B, 'prompts/get', {name: listed});
    assert.match(JSON.stringify(hidden), /unknown prompt/);
    assert.strictEqual(JSON.stringify(hidden), JSON.stringify(gone));
  });

  // completion/complete (M11, #332) for a hidden module's prompt: the same unknown answer (the reviewer's ruling)
  it('a completion/complete for a hidden module\'s prompt is answered as one with the module unloaded: unknown prompt', async () => {
    const listed = await ciPrompt();
    const params = {ref: {type: 'ref/prompt', name: listed}, argument: {name: 'x', value: ''}};
    assert.doesNotMatch(JSON.stringify(await request(ci, A, 'completion/complete', params)), /unknown prompt/, 'found while shown');
    hideCi();
    const hidden = await request(ci, B, 'completion/complete', params);
    const gone = await request(fakeInterface({withCi: false}), B, 'completion/complete', params);
    assert.match(JSON.stringify(hidden), /unknown prompt/);
    assert.strictEqual(JSON.stringify(hidden), JSON.stringify(gone));
  });

  // the reviewer's ruling (6) on #340: in shared mode, with no live session, every surface answers as tools/call does
  it('in shared mode a request whose session is not live gets no surface: empty lists, unknown prompt, MODULE_NOT_LISTED', async () => {
    const C = 'c'.repeat(32);   // never opened (as one ended)
    const listed = pnames(await request(ci, A, 'prompts/list', {})).find((n) => /ch_pack_docs_brief/.test(n));
    assert.deepStrictEqual((await request(ci, C, 'tools/list', {})).result.tools, []);
    assert.deepStrictEqual((await request(ci, C, 'prompts/list', {})).result.prompts, []);
    assert.match(JSON.stringify(await request(ci, C, 'prompts/get', {name: listed})), /unknown prompt/);
    assert.match(JSON.stringify(await request(ci, C, 'completion/complete', {ref: {type: 'ref/prompt', name: listed}, argument: {name: 'x', value: ''}})), /unknown prompt/);
    assert.strictEqual((await request(ci, C, 'tools/call', {name: 'docs_search', arguments: {}})).result._meta['countinghouse/code'], 'MODULE_NOT_LISTED');
  });

  it('outside shared mode (no session given) nothing changes: every tool and prompt is listed', async () => {
    sessions.resetForTests();   // not shared: the request carries no session
    const plain = (method) => new Promise((resolve) => gateway.handle({jsonrpc: '2.0', id: 7, method, params: {}}, ci, null, (err, r) => resolve(r)));
    const tools = names(await plain('tools/list'));
    assert.ok(['ci_failure_triage', 'docs_search', 'plain_svc_go'].every((n) => tools.includes(n)), JSON.stringify(tools));
    const prompts = pnames(await plain('prompts/list'));
    assert.ok(prompts.some((n) => /ch_pack_x_brief/.test(n)), JSON.stringify(prompts));
  });

  // the reviewer's #340 review, 6: a page's cursor anchored at a hidden tool is an invalid cursor,
  // byte for byte as one anchored at a name that never existed
  it('a cursor anchored at a hidden module\'s tool or prompt is -32602, identical to a cursor at a name never registered', async () => {
    const {encodeCursor} = require('../../lib/mcp/pages');
    hideCi();
    const hiddenAt = await request(ci, B, 'tools/list', {cursor: encodeCursor('tools', 'ci_failure_triage')});
    const neverAt = await request(ci, B, 'tools/list', {cursor: encodeCursor('tools', 'no_such_tool_ever')});
    assert.strictEqual(hiddenAt.error && hiddenAt.error.code, -32602, JSON.stringify(hiddenAt));
    assert.strictEqual(JSON.stringify(hiddenAt), JSON.stringify(neverAt));
    const promptHidden = await request(ci, B, 'prompts/list', {cursor: encodeCursor('prompts', 'ch_pack_x_brief')});
    const promptNever = await request(ci, B, 'prompts/list', {cursor: encodeCursor('prompts', 'no_such_prompt_ever')});
    assert.strictEqual(promptHidden.error && promptHidden.error.code, -32602, JSON.stringify(promptHidden));
    assert.strictEqual(JSON.stringify(promptHidden), JSON.stringify(promptNever));
  });

  // M7's resources: a hidden module's resources are hidden as its tools and prompts are (#340's TODO)
  it('a hidden module\'s resources are in no session\'s resources/list or templates/list; each equals its lists with the module never loaded', async () => {
    const uris = (r) => r.result.resources.map((x) => x.uri);
    const tpls = (r) => r.result.resourceTemplates.map((x) => x.uriTemplate);
    const shown = await request(ci, A, 'resources/list', {});
    assert.ok(uris(shown).some((u) => /ch_pack_x/.test(u)), JSON.stringify(shown));
    assert.ok(tpls(await request(ci, A, 'resources/templates/list', {})).some((u) => /ch_pack_x/.test(u)));
    const uri = uris(shown).find((u) => /ch_pack_x/.test(u));
    hideCi();
    const never = fakeInterface({withCi: false});
    for (const id of [A, B]) {
      const list = await request(ci, id, 'resources/list', {});
      assert.ok(!uris(list).some((u) => /ch_pack_x/.test(u)), JSON.stringify(list));
      assert.strictEqual(JSON.stringify(list), JSON.stringify(await request(never, id, 'resources/list', {})));
      assert.strictEqual(JSON.stringify(await request(ci, id, 'resources/templates/list', {})), JSON.stringify(await request(never, id, 'resources/templates/list', {})));
    }
    // a read of the hidden module's resource is the answer a URI never served gets
    const hidden = await request(ci, B, 'resources/read', {uri});
    const gone = await request(never, B, 'resources/read', {uri});
    assert.strictEqual(JSON.stringify(hidden), JSON.stringify(gone));
    assert.ok(hidden.error != null, JSON.stringify(hidden));
  });

  it('in shared mode a session that isn\'t live gets no resources either: empty lists, and its read is not found', async () => {
    const C = 'c'.repeat(32);
    assert.deepStrictEqual((await request(ci, C, 'resources/list', {})).result.resources, []);
    assert.deepStrictEqual((await request(ci, C, 'resources/templates/list', {})).result.resourceTemplates, []);
    const uri = (await request(ci, A, 'resources/list', {})).result.resources.map((x) => x.uri).find((u) => /ch_pack_docs|ch_pack_x/.test(u));
    assert.ok((await request(ci, C, 'resources/read', {uri})).error != null);
  });

  it('the global tool table is untouched: the same frozen object, and the filter hands it back while nothing is hidden', () => {
    const before = toolRegistry.buildToolTargets(ci);
    assert.strictEqual(toolRegistry.forCaller(ci, before, null), before, 'none(): the table itself');
    hideCi();
    const view = toolRegistry.forCaller(ci, before, null);
    assert.strictEqual(view === before, false, 'a copy while a module is hidden');
    assert.ok(!Object.keys(view).includes('ci_failure_triage'));
    assert.strictEqual(toolRegistry.buildToolTargets(ci), before);
    visibility.show(['ch-pack-x', 'ch-step-a']);
    assert.strictEqual(toolRegistry.forCaller(ci, before, null), before, 'none() again: the table itself');
  });

  // #447's high review, 6: one predicate decides every surface that shows a
  // module (tool-registry listedFor / callerSees). While ch-pack-x is
  // hidden, tools/list, prompts/list, resources/list and the routes' one
  // gate (lib/listing-scope.js scopeOf: get-spec, schema, package-info,
  // /device-list) leave it out alike, each checked against one expected
  // list; the part is never shown. (Grants across all seven, on a real
  // server: auth 54.)
  it('every surface shows exactly the expected modules, hidden or not', async () => {
    const {scopeOf} = require('../../lib/listing-scope');
    const MODULES = ['ch-pack-x', 'ch-step-a', 'ch-pack-docs', 'plain'];
    const deviceOf = {'ch-pack-x': 'd1', 'ch-step-a': 'd2', 'ch-pack-docs': 'd3', plain: 'd4'};
    const table = toolRegistry.buildToolTargets(ci, {includeUnlisted: true});
    const moduleOfTool = (n) => ci.deviceManager.deviceMap[table[n].deviceID].hostModuleName;
    const shown = async () => {
      const tools = names(await request(ci, A, 'tools/list', {})).filter((n) => table[n] != null);
      const prompts = pnames(await request(ci, A, 'prompts/list', {}));
      const uris = (await request(ci, A, 'resources/list', {})).result.resources.map((x) => x.uri)
        .concat((await request(ci, A, 'resources/templates/list', {})).result.resourceTemplates.map((x) => x.uriTemplate));
      return {
        'tools/list': MODULES.filter((m) => tools.some((n) => moduleOfTool(n) === m)),
        'prompts/list': MODULES.filter((m) => prompts.some((n) => n.includes(`${m.replace(/-/g, '_')}_brief`))),
        'resources/list': MODULES.filter((m) => uris.some((u) => u.startsWith(`countinghouse://m/${toolRegistry.slugify(m)}/`))),
        routes: MODULES.filter((m) => scopeOf(ci, deviceOf[m]) === 'listed')
      };
    };
    // (only ch-pack-x declares resources)
    const expect = (listed) => ({'tools/list': listed, 'prompts/list': listed, 'resources/list': listed.filter((m) => m === 'ch-pack-x'), routes: listed});
    assert.deepStrictEqual(await shown(), expect(['ch-pack-x', 'ch-pack-docs', 'plain']), 'nothing hidden');
    hideCi();
    assert.deepStrictEqual(await shown(), expect(['ch-pack-docs', 'plain']), 'ch-pack-x hidden');
    visibility.show(['ch-pack-x', 'ch-step-a']);
    assert.deepStrictEqual(await shown(), expect(['ch-pack-x', 'ch-pack-docs', 'plain']), 'shown again');
  });

  // forCaller's fast path (#457's high round): whenever everyoneSeesAll
  // holds, walking the table by listedFor, device by device, keeps every
  // target, so the table handed back with no walk is the walk's. A condition
  // added to listedFor alone, that leaves out a device a built table lists,
  // fails here: in both profiles, over scenarios, a part, a plain module.
  it('whenever everyoneSeesAll holds, the walk by listedFor gives the table the fast path hands back', () => {
    const savedSingle = options.singleIdentity;
    try {
      for (const single of [false, true]) {
        options.singleIdentity = single;
        for (const granted of [null, new Set(['d1', 'd3', 'd4'])]) {
          const table = toolRegistry.buildToolTargets(ci);
          const walked = Object.keys(table).filter((n) => toolRegistry.listedFor(ci, table[n].deviceID, granted));
          if (toolRegistry.everyoneSeesAll(granted)) {
            assert.deepStrictEqual(walked, Object.keys(table), `single ${single}`);
            assert.strictEqual(toolRegistry.forCaller(ci, table, granted), table);
          } else {
            assert.deepStrictEqual(Object.keys(toolRegistry.forCaller(ci, table, granted)), walked, `single ${single}, granted`);
          }
        }
        assert.strictEqual(toolRegistry.everyoneSeesAll(null), true, 'nothing hidden, no grants: the fast path is taken');
      }
    } finally {
      options.singleIdentity = savedSingle;
    }
  });

  // B-uniform (the reviewer's ruling on #457's probe): every tool a caller
  // can't see -- outside its grants, an unlisted part outside them, one whose
  // module is hidden while it goes on or off, a name never registered --
  // takes the same path to the same answer: the key's grant set read once
  // (tool-registry grantsForCall), then the unknown tool's, byte for byte.
  it('a tool the caller can\'t see: one grant read, then the unknown tool\'s answer, whatever the reason', async () => {
    const real = toolRegistry.grantsForCall;
    let reads = 0;
    toolRegistry.grantsForCall = (key, cb) => { reads++; cb(null, new Set(['d3', 'd4'])); };
    try {
      const table = toolRegistry.buildToolTargets(ci, {includeUnlisted: true});
      const nameOf = (d) => Object.keys(table).find((n) => table[n].deviceID === d);
      visibility.hide(['ch-pack-docs']);
      const cases = {'outside the grants': nameOf('d1'), 'an unlisted part outside them': nameOf('d2'),
        'hidden while it goes on or off': nameOf('d3'), 'never registered': 'no_such_tool'};
      const seen = {};
      for (const [why, name] of Object.entries(cases)) {
        assert.ok(typeof(name) === 'string', why);
        const before = reads;
        const r = await request(ci, A, 'tools/call', {name, arguments: {}});
        seen[why] = `${reads - before} ${JSON.stringify(r).split(name).join('<name>')}`;
      }
      const want = seen['never registered'];
      assert.ok(want.startsWith('1 ') && want.includes('unknown tool: <name>'), want);
      assert.deepStrictEqual(seen, Object.fromEntries(Object.keys(cases).map((k) => [k, want])));
    } finally {
      toolRegistry.grantsForCall = real;
      visibility.show(['ch-pack-docs']);
    }
  });
});
