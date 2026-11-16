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
  '/broken/out': {type: 'string'}
};
const DEVICES = {
  notes: {role: null, actions: [
    act('readNote', {resource: {uriTemplate: 'notes/{id}', name: 'note', title: 'Note', mimeType: 'text/markdown'}}),
    act('readCsv', {resource: {uriTemplate: 'csv/{id}.csv', name: 'csv', mimeType: 'text/plain'}}),
    act('allNotes', {description: 'Every note.', resource: {uriTemplate: 'all', name: 'all'}}),
    act('cover', {resource: {uriTemplate: 'cover/{id}', name: 'cover'}}),
    act('broken', {resource: {uriTemplate: 'broken/{id}', name: 'broken'}}),
    act('save')
  ]},
  secret: {role: null, actions: [act('readNote', {resource: {uriTemplate: 'secret/{k}', name: 'secret'}})]},
  'ch-pack-x': {role: 'scenario', actions: [act('readRun', {resource: {uriTemplate: 'runs/{run}', name: 'run'}})]},
  'ch-step-part': {role: 'part', actions: [act('readPart', {resource: {uriTemplate: 'parts/{p}', name: 'part'}})]}
};

const invoked = [];
const billed = [];
function buildInterface() {
  const deviceMap = {};
  const specs = {};
  for (const [name, d] of Object.entries(DEVICES)) {
    const spec = {device: {friendlyName: name, serviceList: {[SVC]: {actionList: d.actions}}}};
    specs[ID(name)] = spec;
    deviceMap[ID(name)] = {spec, packageInfo: {name, countinghouse: d.role != null ? {role: d.role} : {}}};
  }
  return {
    deviceManager: {deviceMap, moduleManager: {unlisted: new Set(['ch-step-part'])}, getAllDeviceSpecs: () => specs},
    getDeviceSchema(deviceID, p, session) { session.localCallback(null, SCHEMAS[p] || {type: 'object'}); },
    rateLimit: (key, cb) => cb(null, {limited: false}),
    recordCall(appKey, tool, cost, cb) { billed.push({appKey, tool, cost}); cb(null); },
    // the call path's one way into a module: a read reaches it as a call does
    invokeDeviceAction(deviceID, serviceID, actionName, args, session) {
      invoked.push({deviceID, serviceID, actionName, input: args.input});
      const answer = (err, data) => setImmediate(() => session.localCallback(err, data));
      if (actionName === 'readNote' || actionName === 'readRun' || actionName === 'readPart') return answer(null, {output: `# ${JSON.stringify(args.input)}`});
      if (actionName === 'readCsv') return answer(null, {output: 'a,b'});
      if (actionName === 'allNotes') return answer(null, {output: {ids: ['first']}});
      if (actionName === 'cover') return answer(null, {output: PNG64});
      if (actionName === 'broken') return answer(Object.assign(new Error('the note is gone'), {code: 'NOTE_GONE'}), null);
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
  before(() => {
    options.setOptions(OPTIONS);
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
        'countinghouse://m/notes/cover/{id}', 'countinghouse://m/notes/broken/{id}', 'countinghouse://m/secret/secret/{k}', 'countinghouse://m/ch_pack_x/runs/{run}']);
      assert.deepStrictEqual(templates[0], {uriTemplate: 'countinghouse://m/notes/notes/{id}', name: 'note', title: 'Note', description: 'readNote it', mimeType: 'text/markdown'});
      const b = await listAll('resources/templates/list', 'resourceTemplates', KEY_B, {modern});
      assert.ok(b.every((t) => t.uriTemplate.startsWith('countinghouse://m/notes/')), 'B is granted notes only');
      if (modern) {
        const r = await ask('resources/list', KEY_A, {}, {modern});
        assert.deepStrictEqual([r.result.ttlMs, r.result.cacheScope], [0, 'private']);
      }
    });
  }

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
});
