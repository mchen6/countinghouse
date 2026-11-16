'use strict';
// Run with --exit (package.json): requiring the gateway leaves a Redis client
// open.
// MCP completeness M10, spec section 7: prompts/list and prompts/get, over a
// fake interface whose devices are worker-mode records (each with its
// main-side spec record, its prompts' arguments derived in a validator at
// load: lib/module-spec.js prompts). Two synthetic keys: A is granted every
// device, B only `notes`. prompts/get runs no module code (the fake has none
// to run), validates the arguments in a validator, replaces each {{name}}
// once and never scans the result again, bounds it at 64 KiB, and is counted
// in the usage records, never billed. A name that is unknown and one that is
// not listed to the caller get one answer.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {redisUrlFor} = require('../helpers/test-env');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mcp-24-'));
const AUTH = path.join(home, 'auth.json');
const KEY_A = `test-a-${'a'.repeat(24)}`;
const KEY_B = `test-b-${'b'.repeat(24)}`;
// B's grant names the notes device by its ID, derived from its name
const NOTES_ID = require('../../lib/call-address').deviceIDForName('notes');
const Z_ID = require('../../lib/call-address').deviceIDForName('ch-pack-z');
fs.writeFileSync(AUTH, JSON.stringify({[KEY_A]: {userName: 'a', devices: ['*']}, [KEY_B]: {userName: 'b', devices: [NOTES_ID, Z_ID]}}));

const options = require('../../lib/cli-options');
// set again before this file's tests: a folder run requires every file first
const OPTIONS = {redisUrl: redisUrlFor(), authConfigPath: AUTH, listPageSize: 10};
options.setOptions(OPTIONS);
require('../../lib/logger').createLogger(false);
const gateway = require('../../lib/mcp/gateway');
const moduleSpec = require('../../lib/module-spec');
const callAddress = require('../../lib/call-address');

const SVC = 'urn:x:serviceID:svc';
const SCHEMA = '$schema';
// a module's api.json and schema.json, with prompts
function moduleOf(friendlyName, prompts, argumentSchemas, {role} = {}) {
  const spec = {device: {friendlyName, serviceList: {[SVC]: {actionList: [{name: 'go', description: 'go it', input: {schema: '/svc/go/input'}}]}}, promptList: prompts}};
  const schemaDoc = {[SCHEMA]: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object', svc: {go: {input: {type: 'object'}}}, prompts: argumentSchemas};
  return {spec, schemaDoc, role};
}
const MODULES = [
  moduleOf('notes', [
    {name: 'summarise', title: 'Summarise a note', description: 'Asks for a summary.', arguments: {schema: '/prompts/summarise'},
      messages: [{role: 'user', text: 'Summarise {{id}} in a {{style}} style.'}, {role: 'assistant', text: 'The summary of {{id}}:'}]},
    {name: 'plain', messages: [{role: 'user', text: 'Hello, and ${{ not.a.placeholder }}.'}]},
    {name: 'big', arguments: {schema: '/prompts/big'}, messages: [{role: 'user', text: '{{x}}{{x}}{{x}}{{x}}{{x}}{{x}}{{x}}{{x}}'}]}
  ], {
    summarise: {type: 'object', properties: {id: {type: 'string', description: 'the note\'s id', maxLength: 32}, style: {type: 'string', description: 'how'}},
      required: ['id'], additionalProperties: false},
    big: {type: 'object', properties: {x: {type: 'string'}}, required: ['x']}
  }),
  moduleOf('secret', [{name: 'hidden', messages: [{role: 'user', text: 'secret'}]}], {}),
  moduleOf('ch-pack-x', [{name: 'triage', description: 'Triage a run.', arguments: {schema: '/prompts/triage'}, messages: [{role: 'user', text: 'Triage run {{run}}.'}]}],
    {triage: {type: 'object', properties: {run: {type: 'string'}}, required: ['run']}}, {role: 'scenario'}),
  // two scenarios whose prompts share a bare name: deduped over every
  // module, before a caller's grants (B is granted z only)
  moduleOf('ch-pack-y', [{name: 'review', messages: [{role: 'user', text: 'y'}]}], {}, {role: 'scenario'}),
  moduleOf('ch-pack-z', [{name: 'review', messages: [{role: 'user', text: 'z'}]}], {}, {role: 'scenario'})
];

let ci = null;
async function buildInterface() {
  const devices = {};
  for (const m of MODULES) {
    const own = await moduleSpec.fromParts(m.spec, m.schemaDoc, m.spec.device.friendlyName);
    moduleSpec.register(own);
    const problem = await moduleSpec.prompts(own);
    assert.strictEqual(problem, null, JSON.stringify(problem));
    const deviceID = callAddress.deviceIDForName(m.spec.device.friendlyName);
    devices[deviceID] = {spec: own.spec, moduleSpec: own, packageInfo: {name: m.spec.device.friendlyName, countinghouse: m.role != null ? {role: m.role} : {}}};
  }
  return {
    deviceManager: {deviceMap: devices, getAllDeviceSpecs: () => Object.fromEntries(Object.entries(devices).map(([id, d]) => [id, d.spec]))},
    getDeviceSchema(deviceID, p, session) { session.localCallback(null, {type: 'object'}); },
    rateLimit: (key, cb) => cb(null, {limited: limited}),
    // a prompt never reaches a module's code: anything that tried to would throw here
    invoke() { throw new Error('module code was run'); }
  };
}
let limited = false;

const MODERN = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
const ask = (method, key, params = {}, {modern = false} = {}) => new Promise((resolve) => {
  const p = Object.assign({}, params);
  if (modern) p._meta = MODERN;
  gateway.handle({jsonrpc: '2.0', id: 1, method, params: p}, ci, key, (err, r) => resolve(r));
});
const listAll = async (key, opts) => {
  const out = [];
  let cursor;
  for (let n = 0; n < 20; n++) {
    const r = await ask('prompts/list', key, cursor !== undefined ? {cursor} : {}, opts);
    assert.ok(r.result != null, JSON.stringify(r));
    out.push(...r.result.prompts);
    cursor = r.result.nextCursor;
    if (cursor === undefined) break;
  }
  return out;
};
const get = (key, name, args, opts) => ask('prompts/get', key, args !== undefined ? {name, arguments: args} : {name}, opts);

describe('mcp-contract 24: prompts (M10)', function() {
  this.timeout(60000);
  let provider = null;
  let real = null;
  const usageSeen = [];
  let usageReal = null;
  before(async () => {
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
    ci = await buildInterface();
  });
  after(() => {
    // the validator pool this file started (lib/validator-pool.js): closed,
    // or a run without --exit (the pre-commit hook's) never ends
    const validatorPool = require('../../lib/validator-pool');
    if (validatorPool.started() != null) validatorPool.started().close();
    if (provider != null) Object.assign(provider, real);
    if (usageReal != null) Object.assign(require('../../lib/usage/runtime').usage(), usageReal);
    fs.rmSync(home, {recursive: true, force: true});
  });
  afterEach(() => { limited = false; });

  for (const modern of [false, true]) {
    const era = modern ? '2026-07-28' : 'legacy';
    it(`${era}: a key's prompts, named <module>_<name> (a scenario's bare), each with what it declares and its arguments from its schema`, async () => {
      const a = await listAll(KEY_A, {modern});
      assert.deepStrictEqual(a.map((p) => p.name), ['notes_summarise', 'notes_plain', 'notes_big', 'secret_hidden', 'triage', 'review', 'review_2']);
      const s = a[0];
      assert.deepStrictEqual(s, {name: 'notes_summarise', title: 'Summarise a note', description: 'Asks for a summary.',
        arguments: [{name: 'id', description: 'the note\'s id', required: true}, {name: 'style', description: 'how', required: false}]});
      assert.deepStrictEqual(a[1], {name: 'notes_plain'}, 'no arguments declared: none listed');
      const b = await listAll(KEY_B, {modern});
      assert.deepStrictEqual(b.map((p) => p.name), ['notes_summarise', 'notes_plain', 'notes_big', 'review_2'], 'B is granted notes and z; z\'s prompt has the name A sees it by');
    });
  }

  it('prompts/list pages with M1\'s cursor; a bad cursor is -32602', async () => {
    const was = options.listPageSize;
    options.listPageSize = 10;
    try {
      const r = await ask('prompts/list', KEY_A, {cursor: 'nope'});
      assert.strictEqual(r.error && r.error.code, -32602);
    } finally {
      options.listPageSize = was;
    }
  });

  it('prompts/get: each {{name}} replaced once, the result never scanned again; an absent optional argument is the empty string', async () => {
    const r = await get(KEY_A, 'notes_summarise', {id: '{{style}}'});
    assert.ok(r.result != null, JSON.stringify(r));
    assert.deepStrictEqual(r.result, {description: 'Asks for a summary.', messages: [
      {role: 'user', content: {type: 'text', text: 'Summarise {{style}} in a  style.'}},
      {role: 'assistant', content: {type: 'text', text: 'The summary of {{style}}:'}}
    ]});
  });

  it('prompts/get: text in double braces that is no argument is sent as written', async () => {
    const r = await get(KEY_A, 'notes_plain');
    assert.strictEqual(r.result.messages[0].content.text, 'Hello, and ${{ not.a.placeholder }}.');
  });

  it('prompts/get: a scenario\'s prompt by its bare name', async () => {
    const r = await get(KEY_B === null ? null : KEY_A, 'triage', {run: '42'});
    assert.strictEqual(r.result.messages[0].content.text, 'Triage run 42.');
  });

  it('prompts/get: arguments that fail the schema are -32602 with its messages, cut and bounded', async () => {
    for (const [args, why] of [[{}, /id/], [{id: 'x'.repeat(40)}, /32/], [{id: 'a', extra: 'b'}, /additional/i], [{id: 7}, /string/], ['nope', /object/]]) {
      const r = await get(KEY_A, 'notes_summarise', args);
      assert.strictEqual(r.error && r.error.code, -32602, `${JSON.stringify(args)}: ${JSON.stringify(r)}`);
      assert.match(r.error.message, why, JSON.stringify(args));
      assert.ok(r.error.message.length <= 2048, 'bounded');
    }
  });

  it('prompts/get: an unknown name and one not listed to the caller get one answer', async () => {
    const unknown = await get(KEY_B, 'never_was', {});
    const hidden = await get(KEY_B, 'secret_hidden', {});
    assert.strictEqual(unknown.error.code, -32602);
    assert.deepStrictEqual(hidden.error, unknown.error);
    assert.ok((await get(KEY_A, 'secret_hidden')).result != null, 'A is listed it');
  });

  it('prompts/get: a result over 64 KiB is -32602', async () => {
    const ok = await get(KEY_A, 'notes_big', {x: 'y'.repeat(1000)});
    assert.ok(ok.result != null);
    const big = await get(KEY_A, 'notes_big', {x: 'y'.repeat(9 * 1024)});
    assert.strictEqual(big.error && big.error.code, -32602, JSON.stringify(big).slice(0, 300));
    assert.match(big.error.message, /64 KiB/);
  });

  it('prompts/get is counted in the usage records, and never billed', async () => {
    usageSeen.length = 0;
    let billed = 0;
    ci.recordCall = (...args) => { billed += 1; args[args.length - 1](null); };
    const r = await get(KEY_A, 'triage', {run: '1'});
    assert.ok(r.result != null);
    delete ci.recordCall;
    assert.strictEqual(billed, 0, 'not billed');
    const begin = usageSeen.find((x) => x.begin != null);
    const out = usageSeen.find((x) => x.out != null);
    assert.deepStrictEqual([begin.begin.tool, begin.begin.module, begin.begin.pack, out.out.tool, out.out.outcome], ['prompts/get', 'ch-pack-x', 'ch-pack-x', 'prompts/get', 'ok'],
      'a scenario\'s prompt under its pack, as a tool call');
    usageSeen.length = 0;
    await get(KEY_A, 'notes_summarise', {});
    const refused = usageSeen.find((x) => x.out != null);
    assert.deepStrictEqual([refused.out.outcome, refused.out.code], ['error', 'INPUT_DATA_VALIDATION_FAIL'], 'a refused get is counted too');
  });

  it('prompts/get\'s check is bounded as a call\'s: a quarantined module\'s is refused', async () => {
    const validatorPool = require('../../lib/validator-pool').pool();
    validatorPool.quarantined.add('notes');
    try {
      const r = await get(KEY_A, 'notes_summarise', {id: 'a'});
      assert.match(r.error && r.error.message, /could not be checked now \(VALIDATION_QUARANTINED\)/, JSON.stringify(r));
    } finally {
      validatorPool.quarantined.delete('notes');
    }
  });

  // single-thread mode (no worker spec record): derived on the main thread,
  // in a schema validator of the device's own, so a schema's $id compiled
  // again (a reload makes a new device) is no clash
  it('single-thread mode: a reloaded device whose prompt schema has an $id still lists its arguments', async () => {
    const CHDevice = require('../../lib/countinghouse-device');
    const spec = {device: {friendlyName: 'single', serviceList: {}, promptList: [{name: 'ask', arguments: {schema: '/prompts/ask'}, messages: [{role: 'user', text: '{{q}}'}]}]}};
    const schemaDoc = {$id: '#/', prompts: {ask: {$id: 'urn:countinghouse-test:ask', type: 'object', properties: {q: {type: 'string'}}, required: ['q']}}};
    const listFor = async () => {
      const device = {spec, schemaDoc, resolveSchemaFromPath: CHDevice.prototype.resolveSchemaFromPath, packageInfo: {name: 'single'}};
      const single = {deviceManager: {deviceMap: {single: device}, getAllDeviceSpecs: () => ({single: spec})}, rateLimit: (key, cb) => cb(null, {limited: false})};
      return new Promise((resolve) => gateway.handle({jsonrpc: '2.0', id: 1, method: 'prompts/list', params: {}}, single, KEY_A, (err, r) => resolve(r)));
    };
    for (let n = 0; n < 2; n++) {
      const r = await listFor();
      assert.deepStrictEqual(r.result.prompts, [{name: 'single_ask', arguments: [{name: 'q', required: true}]}], `listing ${n + 1}: ${JSON.stringify(r)}`);
    }
  });

  it('prompts/get is rate limited', async () => {
    limited = true;
    const r = await get(KEY_A, 'triage', {run: '1'});
    assert.match(r.error && r.error.message, /rate limit/);
  });

  for (const modern of [false, true]) {
    it(`${modern ? 'discover' : 'initialize'} declares prompts`, async () => {
      const r = modern ? await ask('server/discover', KEY_A, {}, {modern: true})
        : await ask('initialize', KEY_A, {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 't', version: '0'}});
      assert.ok(r.result != null, JSON.stringify(r));
      assert.deepStrictEqual(r.result.capabilities.prompts, {});
    });
  }
});
