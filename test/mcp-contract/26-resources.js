'use strict';
// Run with --exit (package.json): requiring the gateway leaves a Redis client
// open.
// MCP completeness M7, spec section 3: module resources, over a fake
// interface whose devices are worker-mode records. Two synthetic keys: A is
// granted every device, B only `notes`. A resource is listed per key under
// countinghouse://m/<module>/<path>; a read runs its action through the
// same runner as a tools/call (the fake's invokeDeviceAction is the call
// path's one way into a module), billed under the same metering identity,
// counted as that action's call; its output becomes one `contents` entry.
// A resource action is no longer a tool. Every URI that reads nothing gets
// one -32602, and M6's countinghouse://r/ path is its own.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {redisUrlFor} = require('../helpers/test-env');

const callAddress = require('../../lib/call-address');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mcp-26-'));
const AUTH = path.join(home, 'auth.json');
const KEY_A = `test-a-${'a'.repeat(24)}`;
const KEY_B = `test-b-${'b'.repeat(24)}`;
const ID = (name) => callAddress.deviceIDForName(name);
fs.writeFileSync(AUTH, JSON.stringify({[KEY_A]: {userName: 'a', devices: ['*']}, [KEY_B]: {userName: 'b', devices: [ID('notes')]}}));

const options = require('../../lib/cli-options');
// set again before this file's tests: a folder run requires every file first
const OPTIONS = {redisUrl: redisUrlFor(), authConfigPath: AUTH, listPageSize: 10, workerThread: true};
options.setOptions(OPTIONS);
require('../../lib/logger').createLogger(false);
const gateway = require('../../lib/mcp/gateway');
const {encodeLegacyTool} = require('../../lib/metering/provider');

const SVC = 'urn:x:serviceID:svc';
const PNG64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]).toString('base64');
const act = (name, extra = {}) => Object.assign({name, description: `${name} it`, input: {schema: `/${name}/in`}, output: {schema: `/${name}/out`}}, extra);
// output schemas by pointer (the fake's getDeviceSchema answers them)
const SCHEMAS = {
  '/readNote/out': {type: 'string'},
  '/readCsv/out': {type: 'string', contentMediaType: 'text/csv'},
  '/allNotes/out': {type: 'object'},
  '/cover/out': {type: 'string', contentEncoding: 'base64', contentMediaType: 'image/png'},
  '/broken/out': {type: 'string'},
  '/pick/color': {type: 'object', properties: {color: {type: 'string'}}}
};
const DEVICES = {
  notes: {role: null, actions: [
    act('readNote', {resource: {uriTemplate: 'notes/{id}', name: 'note', title: 'Note', mimeType: 'text/markdown'}}),
    act('readCsv', {resource: {uriTemplate: 'csv/{id}.csv', name: 'csv', mimeType: 'text/plain'}}),
    act('allNotes', {description: 'Every note.', resource: {uriTemplate: 'all', name: 'all'}}),
    act('cover', {resource: {uriTemplate: 'cover/{id}', name: 'cover'}}),
    act('broken', {resource: {uriTemplate: 'broken/{id}', name: 'broken'}}),
    act('loop', {resource: {uriTemplate: 'loop/{id}', name: 'loop'}}),
    act('save')
  ]},
  // two modules whose names slug alike: neither's resources are served, so
  // a URI can never come to name the other's (the review of M7)
  'twin-a': {role: null, actions: [act('readTwin', {resource: {uriTemplate: 'x/{id}', name: 'twin'}})]},
  'twin_a': {role: null, actions: [act('readTwin', {resource: {uriTemplate: 'x/{id}', name: 'twin'}})]},
  secret: {role: null, actions: [act('readNote', {resource: {uriTemplate: 'secret/{k}', name: 'secret'}})]},
  'ch-pack-x': {role: 'scenario', actions: [act('readRun', {resource: {uriTemplate: 'runs/{run}', name: 'run'}})]},
  'ch-step-part': {role: 'part', actions: [act('readPart', {resource: {uriTemplate: 'parts/{p}', name: 'part'}})]},
  // an action that declares a question (M13): a modern tools/call of it has
  // someone to ask; a resource read never does
  asker: {role: null, actions: [act('pick', {questions: {color: {message: 'Which colour?', schema: '/pick/color'}}})]}
};

const invoked = [];
// each call's ask state as the call path receives it: {action, askable}
const asked = [];
const billed = [];
let limited = false;
function buildInterface(devices = DEVICES) {
  const deviceMap = {};
  const specs = {};
  for (const [name, d] of Object.entries(devices)) {
    const spec = {device: {friendlyName: name, serviceList: {[SVC]: {actionList: d.actions}}}};
    specs[ID(name)] = spec;
    deviceMap[ID(name)] = {spec, packageInfo: {name, countinghouse: d.role != null ? {role: d.role} : {}}};
  }
  return {
    deviceManager: {deviceMap, moduleManager: {unlisted: new Set(['ch-step-part'])}, getAllDeviceSpecs: () => specs},
    getDeviceSchema(deviceID, p, session) { session.localCallback(null, SCHEMAS[p] || {type: 'object'}); },
    rateLimit: (key, cb) => cb(null, {limited: limited}),
    recordCall(appKey, tool, cost, cb) { billed.push({appKey, tool, cost}); cb(null); },
    // the call path's one way into a module: a read reaches it as a call does
    invokeDeviceAction(deviceID, serviceID, actionName, args, session) {
      const answer = (err, data) => setImmediate(() => session.localCallback(err, data));
      // its per-key limit first, as the real one's (lib/countinghouse-interface.js):
      // a limited caller's call is refused DENY_DEVICE_ACCESS and never reaches the module
      if (limited) return answer(new (require('../../lib/countinghouse-error').CountinghouseError)('DENY_DEVICE_ACCESS'), null);
      invoked.push({deviceID, serviceID, actionName, input: args.input});
      asked.push({action: actionName, askable: session.ask != null ? session.ask.askable : null});
      if (actionName === 'readNote' || actionName === 'readRun' || actionName === 'readPart') return answer(null, {output: `# ${JSON.stringify(args.input)}`});
      if (actionName === 'readCsv') return answer(null, {output: 'a,b'});
      if (actionName === 'allNotes') return answer(null, {output: {ids: ['first']}});
      if (actionName === 'cover') return answer(null, {output: PNG64});
      if (actionName === 'broken') return answer(Object.assign(new Error('the note is gone'), {code: 'NOTE_GONE'}), null);
      if (actionName === 'loop') { const o = {}; o.self = o; return answer(null, {output: o}); }
      return answer(null, {output: {saved: true}});
    }
  };
}
const ci = buildInterface();

const MODERN = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
const ask = (method, key, params = {}, {modern = false} = {}) => new Promise((resolve) => {
  const p = Object.assign({}, params);
  if (modern) p._meta = MODERN;
  gateway.handle({jsonrpc: '2.0', id: 1, method, params: p}, ci, key, (err, r) => resolve(r));
});
const read = (key, uri, opts) => ask('resources/read', key, {uri}, opts);
const listAll = async (method, field, key, opts) => {
  const out = [];
  let cursor;
  for (let n = 0; n < 20; n++) {
    const r = await ask(method, key, cursor !== undefined ? {cursor} : {}, opts);
    assert.ok(r.result != null, JSON.stringify(r));
    out.push(...r.result[field]);
    cursor = r.result.nextCursor;
    if (cursor === undefined) break;
  }
  return out;
};

describe('mcp-contract 26: module resources (M7)', function() {
  this.timeout(60000);
  let provider = null;
  let real = null;
  const usageSeen = [];
  let usageReal = null;
  // the operator's warnings, from the first list on (the slug collision's)
  const warnings = [];
  let warnReal = null;
  before(() => {
    options.setOptions(OPTIONS);
    const LOG = require('../../lib/logger');
    warnReal = LOG.W;
    LOG.W = (m) => { warnings.push(String(m)); };
    const FileAuthProvider = require('../../lib/auth/file-provider');
    const own = new FileAuthProvider({configPath: AUTH});
    provider = require('../../lib/auth').getAuthProvider();
    real = {authenticate: provider.authenticate, listDevices: provider.listDevices};
    provider.authenticate = (...args) => own.authenticate(...args);
    provider.listDevices = (...args) => own.listDevices(...args);
    const u = require('../../lib/usage/runtime').usage();
    usageReal = {beginCall: u.beginCall, recordOut: u.recordOut};
    u.beginCall = (c) => { usageSeen.push({begin: c}); return {id: usageSeen.length}; };
    u.recordOut = (call, out) => { usageSeen.push({out}); };
  });
  after(() => {
    if (warnReal != null) require('../../lib/logger').W = warnReal;
    if (provider != null) Object.assign(provider, real);
    if (usageReal != null) Object.assign(require('../../lib/usage/runtime').usage(), usageReal);
    fs.rmSync(home, {recursive: true, force: true});
  });

  for (const modern of [false, true]) {
    const era = modern ? '2026-07-28' : 'legacy';
    it(`${era}: resources/list holds the static ones, resources/templates/list the rest, per key, under countinghouse://m/<module>/`, async () => {
      const statics = await listAll('resources/list', 'resources', KEY_A, {modern});
      assert.deepStrictEqual(statics, [{uri: 'countinghouse://m/notes/all', name: 'all', description: 'Every note.'}]);
      const templates = await listAll('resources/templates/list', 'resourceTemplates', KEY_A, {modern});
      assert.deepStrictEqual(templates.map((t) => t.uriTemplate), ['countinghouse://m/notes/notes/{id}', 'countinghouse://m/notes/csv/{id}.csv',
        'countinghouse://m/notes/cover/{id}', 'countinghouse://m/notes/broken/{id}', 'countinghouse://m/notes/loop/{id}', 'countinghouse://m/secret/secret/{k}',
        'countinghouse://m/ch_pack_x/runs/{run}'], 'the twins, whose names slug alike, are not served');
      assert.deepStrictEqual(templates[0], {uriTemplate: 'countinghouse://m/notes/notes/{id}', name: 'note', title: 'Note', description: 'readNote it', mimeType: 'text/markdown'});
      const b = await listAll('resources/templates/list', 'resourceTemplates', KEY_B, {modern});
      assert.ok(b.every((t) => t.uriTemplate.startsWith('countinghouse://m/notes/')), 'B is granted notes only');
      if (modern) {
        const r = await ask('resources/list', KEY_A, {}, {modern});
        assert.deepStrictEqual([r.result.ttlMs, r.result.cacheScope], [0, 'private']);
      }
    });
  }

  // master 939cee95: runModuleTarget, split out of handleToolsCall by M7,
  // bound a question's state to `name`, a local it no longer had: a
  // ReferenceError, so every modern ask ran with no one to ask
  // (ASK_UNAVAILABLE). The fix binds the tool the client called.
  it('a 2026-07-28 tools/call of an action that asks has someone to ask; a resource read never does', async () => {
    const meta = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {elicitation: {}}};
    const errors = [];
    const LOG = require('../../lib/logger');
    const errReal = LOG.E;
    LOG.E = (e) => { errors.push(String(e && e.message)); return e; };
    try {
      asked.length = 0;
      const called = await ask('tools/call', KEY_A, {name: 'asker_svc_pick', arguments: {}, _meta: meta});
      assert.ok(called.result != null && called.result.isError !== true, JSON.stringify(called));
      assert.deepStrictEqual(asked, [{action: 'pick', askable: true}], errors.join('\n'));
      assert.ok(!errors.some((e) => /is not defined/.test(e)), errors.join('\n'));
      asked.length = 0;
      const read = await ask('resources/read', KEY_A, {uri: 'countinghouse://m/notes/notes/x', _meta: meta});
      assert.ok(read.result != null, JSON.stringify(read));
      assert.deepStrictEqual(asked, [{action: 'readNote', askable: false}]);
    } finally {
      LOG.E = errReal;
    }
  });

  it('a resource action is not a tool: gone from tools/list and from tools/call; a plain action is still one', async () => {
    const tools = (await ask('tools/list', KEY_A)).result.tools.map((t) => t.name);
    assert.ok(tools.includes('notes_svc_save'));
    assert.ok(!tools.some((t) => /readnote|readcsv|allnotes|cover|broken|readrun/.test(t)), tools.join(', '));
    const called = await ask('tools/call', KEY_A, {name: 'notes_svc_readnote', arguments: {id: 'a'}});
    assert.match(JSON.stringify(called), /unknown tool/);
  });

  it('a read runs the action as a call does: its variables as the input, billed under the action\'s metering identity, counted as its call', async () => {
    invoked.length = 0;
    billed.length = 0;
    usageSeen.length = 0;
    const r = await read(KEY_A, 'countinghouse://m/notes/notes/caf%C3%A9');
    assert.ok(r.result != null, JSON.stringify(r));
    assert.deepStrictEqual(r.result.contents, [{uri: 'countinghouse://m/notes/notes/caf%C3%A9', mimeType: 'text/markdown', text: '# {"id":"café"}'}]);
    assert.deepStrictEqual(invoked, [{deviceID: ID('notes'), serviceID: SVC, actionName: 'readNote', input: {id: 'café'}}]);
    assert.deepStrictEqual(billed.map((b) => b.tool), [encodeLegacyTool(ID('notes'), SVC, 'readNote')]);
    assert.strictEqual(billed[0].cost, options.mcpToolCallCost);
    const begin = usageSeen.find((x) => x.begin != null);
    assert.deepStrictEqual([begin.begin.module, begin.begin.tool], ['notes', 'notes_svc_readnote']);
  });

  // the review of #327: on stdio or a session, a cancel names what is
  // registered when it arrives. A read registered only once its caller and
  // resource were looked up let a cancel in that window drop, and then ran
  // and billed.
  it('a read cancelled while its caller and resource are looked up neither runs nor bills, and is not answered', async () => {
    invoked.length = 0;
    billed.length = 0;
    // a transport's registry: a cancel reaches what is registered now, else it is dropped
    let registered = null;
    const opts = {cancellable: (fn) => { registered = fn; return () => { registered = null; }; }};
    // the lookups take a moment, as a real auth provider's do: its device
    // list answers on a later turn, and the cancel arrives in between
    let inWindow = null;
    const listDevices = provider.listDevices;
    provider.listDevices = (key, cb) => listDevices(key, (...answer) => { inWindow = setImmediate(() => cb(...answer)); });
    let got;
    try {
      const req = {jsonrpc: '2.0', id: 1, method: 'resources/read', params: {uri: 'countinghouse://m/notes/notes/one'}};
      got = new Promise((resolve) => gateway.handle(req, ci, KEY_A, (err, r, info) => resolve({r, info}), opts));
      for (let w = 0; inWindow == null && w < 200; w++) await new Promise((res) => setImmediate(res));
      assert.ok(inWindow != null, 'the device lookup is in flight');
      assert.deepStrictEqual(invoked, [], 'nothing has run yet');
      assert.strictEqual(typeof(registered), 'function', 'registered before the lookups end');
      registered();
    } finally {
      provider.listDevices = listDevices;
    }
    const {r, info} = await got;
    assert.strictEqual(r, null, JSON.stringify(r));
    assert.deepStrictEqual(info, {cancelled: true});
    await new Promise((res) => setTimeout(res, 100));
    assert.deepStrictEqual(invoked, [], 'not run');
    assert.deepStrictEqual(billed, [], 'not billed');
    assert.strictEqual(registered, null, 'unregistered at its end');
  });

  it('the output\'s shape: a string as text (the schema\'s media type, else the declared one), a binary string as a blob, anything else as JSON', async () => {
    assert.deepStrictEqual((await read(KEY_A, 'countinghouse://m/notes/csv/x.csv')).result.contents, [{uri: 'countinghouse://m/notes/csv/x.csv', mimeType: 'text/csv', text: 'a,b'}]);
    assert.deepStrictEqual((await read(KEY_A, 'countinghouse://m/notes/cover/1')).result.contents, [{uri: 'countinghouse://m/notes/cover/1', mimeType: 'image/png', blob: PNG64}]);
    assert.deepStrictEqual((await read(KEY_A, 'countinghouse://m/notes/all')).result.contents,
      [{uri: 'countinghouse://m/notes/all', mimeType: 'application/json', text: '{"ids":["first"]}'}]);
    const scenario = await read(KEY_A, 'countinghouse://m/ch_pack_x/runs/7');
    assert.strictEqual(scenario.result.contents[0].text, '# {"run":"7"}');
  });

  it('a handler\'s error is -32603 with its code, and nothing is billed', async () => {
    billed.length = 0;
    const r = await read(KEY_A, 'countinghouse://m/notes/broken/1');
    assert.strictEqual(r.error && r.error.code, -32603, JSON.stringify(r));
    assert.strictEqual(r.error.data && r.error.data['countinghouse/code'], 'NOTE_GONE');
    assert.deepStrictEqual(billed, []);
  });

  it('every URI that reads nothing gets one -32602: malformed, unknown module, unmatched path, ungranted, unlisted, a refused variable', async () => {
    invoked.length = 0;
    const answers = [];
    for (const [key, uri] of [[KEY_A, 'countinghouse://m/notes'], [KEY_A, 'countinghouse://m/nobody/notes/a'], [KEY_A, 'countinghouse://m/notes/nothing/a'],
      [KEY_B, 'countinghouse://m/secret/secret/a'], [KEY_A, 'countinghouse://m/ch_step_part/parts/a'], [KEY_A, 'countinghouse://m/notes/notes/%2E%2E'],
      [KEY_A, 'countinghouse://m/notes/notes/a%2Fb'], [KEY_A, 'countinghouse://m/notes/notes/%00'], [KEY_A, 'https://example.com/x'], [KEY_A, 42]]) {
      const r = await read(key, uri);
      assert.ok(r.error != null && r.result == null, `${uri}: ${JSON.stringify(r)}`);
      answers.push(JSON.stringify(r.error));
    }
    assert.strictEqual(new Set(answers).size, 1, [...new Set(answers)].join(' / '));
    assert.deepStrictEqual(JSON.parse(answers[0]), {code: -32602, message: 'Resource not found'});
    assert.deepStrictEqual(invoked, [], 'no module reached');
    assert.ok((await read(KEY_A, 'countinghouse://m/secret/secret/a')).result != null, 'A is granted secret');
  });

  it('an output that cannot be made JSON is the read\'s error, never a hang', async () => {
    const r = await read(KEY_A, 'countinghouse://m/notes/loop/1');
    assert.strictEqual(r.error && r.error.code, -32603, JSON.stringify(r));
  });

  it('modules whose names slug alike are not read: their URI is no one\'s; the operator is warned once for the slug', async () => {
    const r = await read(KEY_A, 'countinghouse://m/twin_a/x/1');
    assert.deepStrictEqual(r.error, {code: -32602, message: 'Resource not found'});
    await listAll('resources/templates/list', 'resourceTemplates', KEY_A);
    const about = warnings.filter((w) => /"twin_a"/.test(w));
    assert.strictEqual(about.length, 1, JSON.stringify(warnings));
    assert.match(about[0], /neither's resources are served; rename one of them/);
  });

  // the review of #327: updateDeviceSpec mutates a spec in place, so a
  // template compiled once per declaration object went stale: the list showed
  // the new template while reads matched the old one
  it('a declaration whose template changed in place is read by its new template, never its old one', async () => {
    const csv = DEVICES.notes.actions.find((a) => a.name === 'readCsv').resource;
    assert.ok((await read(KEY_A, 'countinghouse://m/notes/csv/x.csv')).result != null, 'compiled at first');
    const was = csv.uriTemplate;
    csv.uriTemplate = 'tables/{id}.csv';
    try {
      const templates = await listAll('resources/templates/list', 'resourceTemplates', KEY_A);
      assert.ok(templates.some((t) => t.uriTemplate === 'countinghouse://m/notes/tables/{id}.csv'), 'listed by the new one');
      const now = await read(KEY_A, 'countinghouse://m/notes/tables/x.csv');
      assert.ok(now.result != null, JSON.stringify(now));
      assert.deepStrictEqual((await read(KEY_A, 'countinghouse://m/notes/csv/x.csv')).error, {code: -32602, message: 'Resource not found'}, 'the old one reads nothing');
    } finally {
      csv.uriTemplate = was;
    }
  });

  it('a rate-limited caller\'s probe that reads nothing is limited too, with the refusal a limited read gets', async () => {
    limited = true;
    try {
      invoked.length = 0;
      const probe = await read(KEY_A, 'countinghouse://m/nobody/x/1');
      assert.strictEqual(probe.error && probe.error.code, -32603, JSON.stringify(probe));
      assert.strictEqual(probe.error.data && probe.error.data['countinghouse/code'], 'DENY_DEVICE_ACCESS');
      // a limited read of a real resource, refused by the call path's own limit: the same answer
      const real = await read(KEY_A, 'countinghouse://m/notes/notes/one');
      assert.deepStrictEqual(probe.error, real.error, 'the limit says nothing of what exists');
      assert.deepStrictEqual(invoked, [], 'no module reached');
    } finally {
      limited = false;
    }
  });

  it('M6\'s stored results are their own path: a countinghouse://r/ URI never reaches a module', async () => {
    invoked.length = 0;
    const r = await read(KEY_A, 'countinghouse://r/0123456789abcdef0123456789abcdef');
    assert.strictEqual(r.error && r.error.code, -32602);
    assert.deepStrictEqual(invoked, []);
  });

  it('resources/list and resources/templates/list page with M1\'s cursor; a bad cursor is -32602', async () => {
    for (const method of ['resources/list', 'resources/templates/list']) {
      const r = await ask(method, KEY_A, {cursor: 'nope'});
      assert.strictEqual(r.error && r.error.code, -32602, method);
    }
  });

  // the review of #327: a list longer than a page (the floor is 10)
  it('resources/templates/list pages past one page: 10, then exactly the rest; a cursor whose anchor is gone is -32602', async () => {
    const actions = Array.from({length: 11}, (_, i) => act(`r${i}`, {resource: {uriTemplate: `r${i}/{id}`, name: `r${i}`}}));
    const many = buildInterface({pages: {role: null, actions}});
    const on = (params) => new Promise((resolve) => gateway.handle({jsonrpc: '2.0', id: 1, method: 'resources/templates/list', params}, many, KEY_A, (err, r) => resolve(r)));
    const all = actions.map((a, i) => `countinghouse://m/pages/r${i}/{id}`);
    const first = await on({});
    assert.deepStrictEqual(first.result.resourceTemplates.map((t) => t.uriTemplate), all.slice(0, 10));
    assert.strictEqual(typeof(first.result.nextCursor), 'string', 'a next page');
    const second = await on({cursor: first.result.nextCursor});
    assert.deepStrictEqual(second.result.resourceTemplates.map((t) => t.uriTemplate), all.slice(10), 'exactly the rest');
    assert.strictEqual(second.result.nextCursor, undefined, 'the last page');
    // the anchor's resource gone (its action removed, as an unload would)
    actions.splice(9, 1);
    const stale = await on({cursor: first.result.nextCursor});
    assert.strictEqual(stale.error && stale.error.code, -32602, JSON.stringify(stale));
  });
});
