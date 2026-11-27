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
// an admin, for countinghouse_call_tool (an authoring tool)
const KEY_ADMIN = `test-admin-${'c'.repeat(20)}`;
const ID = (name) => callAddress.deviceIDForName(name);
fs.writeFileSync(AUTH, JSON.stringify({[KEY_A]: {userName: 'a', devices: ['*']}, [KEY_B]: {userName: 'b', devices: [ID('notes')]},
  [KEY_ADMIN]: {userName: 'admin', devices: ['*'], admin: true}}), {mode: 0o600});

const options = require('../../lib/cli-options');
const OPTIONS = {redisUrl: redisUrlFor(), authConfigPath: AUTH, listPageSize: 10, workerThread: true};
// (set in the describe's before(), the process's put back in its after():
// never at load, which every file of a folder run would see -- B-loadopts)
const {snapshot: optionsNow, restore: restoreOptions} = require('../helpers/options-scope');
let keptOptions = null;
require('../../lib/logger').createLogger();
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
// what the runtime's own tools spend or read past their gates (#458's third high round)
const spent = [];
const loads = [];
const balances = [];
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
    deviceManager: {deviceMap, moduleManager: {unlisted: new Set(['ch-step-part']), loadModuleFromPath: (...a) => { loads.push(a[0]); a[3](new Error('not in this test')); }},
      getAllDeviceSpecs: () => specs},
    getDeviceSchema(deviceID, p, session) { session.localCallback(null, SCHEMAS[p] || {type: 'object'}); },
    rateLimit: (key, cb) => { spent.push(key); cb(null, {limited: limited}); },
    checkBalance: (key, cb) => { balances.push(key); cb(null, {balance: 1}); },
    recordCall(appKey, tool, cost, cb) { billed.push({appKey, tool, cost}); cb(null); },
    // the call path's one way into a module: a read reaches it as a call does
    invokeDeviceAction(deviceID, serviceID, actionName, args, session) {
      const answer = (err, data) => setImmediate(() => session.localCallback(err, data));
      // its per-key limit first, as the real one's (lib/countinghouse-interface.js):
      // a limited caller's call is refused RATE_LIMIT_EXCEEDED (#482's high, 1) and never reaches the module
      if (limited) return answer(new (require('../../lib/countinghouse-error').CountinghouseError)('RATE_LIMIT_EXCEEDED'), null);
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
    keptOptions = optionsNow();
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
    restoreOptions(keptOptions);
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

  // #458's high review, 1: a tools/call registers its cancellation before
  // it reads the caller's grants (tool-registry grantsForCall), so a cancel
  // or a closed POST while they are read runs nothing and bills nothing
  it('a tools/call cancelled while the caller\'s grants are read neither runs nor bills, and is not answered', async () => {
    invoked.length = 0;
    billed.length = 0;
    require('../../lib/mcp/tool-registry').forgetGrants();
    let registered = null;
    const opts = {cancellable: (fn) => { registered = fn; return () => { registered = null; }; }};
    // the key's resolution takes a moment, as a real provider's does
    let inWindow = null;
    const authenticate = provider.authenticate;
    provider.authenticate = (...args) => {
      const cb = args.pop();
      return authenticate(...args, (...answer) => { inWindow = setImmediate(() => cb(...answer)); });
    };
    let got;
    try {
      const req = {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'notes_svc_save', arguments: {}}};
      got = new Promise((resolve) => gateway.handle(req, ci, KEY_A, (err, r, info) => resolve({r, info}), opts));
      for (let w = 0; inWindow == null && w < 200; w++) await new Promise((res) => setImmediate(res));
      assert.ok(inWindow != null, 'the key\'s resolution is in flight');
      assert.strictEqual(typeof(registered), 'function', 'registered before the grants are read');
      registered();
    } finally {
      provider.authenticate = authenticate;
    }
    const {r, info} = await got;
    assert.strictEqual(r, null, JSON.stringify(r));
    assert.deepStrictEqual(info, {cancelled: true});
    await new Promise((res) => setTimeout(res, 100));
    assert.deepStrictEqual(invoked, [], 'not run');
    assert.deepStrictEqual(billed, [], 'not billed');
    assert.strictEqual(registered, null, 'unregistered at its end');
  });

  // #458's second high round, 1: countinghouse_call_tool registers its
  // cancellation at its outer gate and its inner call reuses it, so a cancel
  // during the outer gate's key resolution or the admin check's read runs
  // nothing and bills nothing
  for (const [label, slowAt] of [['the outer gate\'s key resolution', 1], ['the admin check\'s identity read', 2]]) {
    it(`countinghouse_call_tool cancelled during ${label}: the inner call neither runs nor bills, and nothing is answered`, async () => {
      invoked.length = 0;
      billed.length = 0;
      require('../../lib/mcp/tool-registry').forgetGrants();
      options.setOptions(Object.assign({}, OPTIONS, {authoringTools: true}));
      let registered = null;
      const opts = {cancellable: (fn) => { registered = fn; return () => { registered = null; }; }};
      let inWindow = null;
      let n = 0;
      const authenticate = provider.authenticate;
      provider.authenticate = (...args) => {
        const cb = args.pop();
        const slow = ++n === slowAt;
        return authenticate(...args, (...answer) => { if (slow) inWindow = setImmediate(() => cb(...answer)); else cb(...answer); });
      };
      let got;
      try {
        const req = {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'countinghouse_call_tool', arguments: {name: 'notes_svc_save', arguments: {}}}};
        got = new Promise((resolve) => gateway.handle(req, ci, KEY_ADMIN, (err, r, info) => resolve({r, info}), opts));
        for (let w = 0; inWindow == null && w < 400; w++) await new Promise((res) => setImmediate(res));
        assert.ok(inWindow != null, 'the read is in flight');
        assert.strictEqual(typeof(registered), 'function', 'registered at the outer gate');
        registered();
      } finally {
        provider.authenticate = authenticate;
        options.setOptions(OPTIONS);
      }
      const {r, info} = await got;
      assert.strictEqual(r, null, JSON.stringify(r));
      assert.deepStrictEqual(info, {cancelled: true});
      await new Promise((res) => setTimeout(res, 100));
      assert.deepStrictEqual(invoked, [], 'not run');
      assert.deepStrictEqual(billed, [], 'not billed');
      assert.strictEqual(registered, null, 'unregistered at its end');
    });
  }

  // #458's second high round, 4: a plain call whose session ends while its
  // own userAuth runs (the second authenticate: the first resolves the key at
  // the gate) is answered as an ended session's, and nothing runs or bills,
  // as a task gets no job
  it('a tools/call whose session ends during its userAuth neither runs nor bills', async () => {
    invoked.length = 0;
    billed.length = 0;
    require('../../lib/mcp/tool-registry').forgetGrants();
    const sessions = require('../../lib/sessions');
    const SID = 's'.repeat(32);
    const realGet = sessions.get;
    let live = true;
    sessions.get = (id) => (id === SID ? (live ? {id} : null) : realGet(id));
    let n = 0;
    const authenticate = provider.authenticate;
    provider.authenticate = (...args) => {
      const cb = args.pop();
      const nth = ++n;
      return authenticate(...args, (...answer) => { if (nth === 2) live = false; cb(...answer); });
    };
    try {
      const req = {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'notes_svc_save', arguments: {}}};
      const r = await new Promise((resolve) => gateway.handle(req, ci, KEY_A, (err, resp) => resolve(resp),
        {session: {id: SID, client: {status: 'ok', conditions: 'no', repo: null}}}));
      assert.strictEqual(r.result && r.result._meta && r.result._meta['countinghouse/code'], 'MODULE_NOT_LISTED', JSON.stringify(r));
      assert.ok(n >= 2, 'the gate\'s resolution, then the call\'s own userAuth');
    } finally {
      provider.authenticate = authenticate;
      sessions.get = realGet;
    }
    await new Promise((res) => setTimeout(res, 100));
    assert.deepStrictEqual(invoked, [], 'not run');
    assert.deepStrictEqual(billed, [], 'not billed');
  });

  // the medium of #458's second round: a resource read whose session ends
  // during its own userAuth is answered as an ended session's read is at the
  // top of handleModuleResourceRead ("not found"), not a tools/call result
  it('a resources/read whose session ends during its userAuth is "not found", and neither runs nor bills', async () => {
    invoked.length = 0;
    billed.length = 0;
    require('../../lib/mcp/tool-registry').forgetGrants();
    const sessions = require('../../lib/sessions');
    const SID = 'r'.repeat(32);
    const realGet = sessions.get;
    let live = true;
    sessions.get = (id) => (id === SID ? (live ? {id} : null) : realGet(id));
    let n = 0;
    const authenticate = provider.authenticate;
    provider.authenticate = (...args) => {
      const cb = args.pop();
      const nth = ++n;
      return authenticate(...args, (...answer) => { if (nth === 2) live = false; cb(...answer); });
    };
    try {
      const req = {jsonrpc: '2.0', id: 1, method: 'resources/read', params: {uri: 'countinghouse://m/notes/notes/one'}};
      const r = await new Promise((resolve) => gateway.handle(req, ci, KEY_A, (err, resp) => resolve(resp),
        {session: {id: SID, client: {status: 'ok', conditions: 'no', repo: null}}}));
      assert.deepStrictEqual(r.error, {code: -32602, message: 'Resource not found'}, JSON.stringify(r));
    } finally {
      provider.authenticate = authenticate;
      sessions.get = realGet;
    }
    await new Promise((res) => setTimeout(res, 100));
    assert.deepStrictEqual(invoked, [], 'not run');
    assert.deepStrictEqual(billed, [], 'not billed');
  });

  // the medium of #458's second round: a key that is no admin's calling an
  // authoring tool is answered as a name never registered with the flag on
  // as with it off, and with no provider read more, so neither the answer
  // nor its cost tells the flag
  it('an authoring tool from a key that is no admin\'s: the same answer and the same provider reads, --authoringTools on or off', async () => {
    const authenticate = provider.authenticate;
    const listDevices = provider.listDevices;
    const run = async(flag) => {
      require('../../lib/mcp/tool-registry').forgetGrants();
      options.setOptions(Object.assign({}, OPTIONS, {authoringTools: flag}));
      let reads = 0;
      provider.authenticate = (...args) => { reads++; return authenticate(...args); };
      provider.listDevices = (...args) => { reads++; return listDevices(...args); };
      try {
        const r = await ask('tools/call', KEY_A, {name: 'countinghouse_validate_module', arguments: {path: '.'}});
        return {r, reads};
      } finally {
        provider.authenticate = authenticate;
        provider.listDevices = listDevices;
        options.setOptions(OPTIONS);
      }
    };
    const off = await run(false);
    const on = await run(true);
    assert.deepStrictEqual(on, off);
    assert.deepStrictEqual(off.r.error, {code: -32602, message: 'unknown tool: countinghouse_validate_module; countinghouse_overview shows what is installed here and which tools you can use'});
  });

  // #458's third high round: ONE cancellation for every name and one
  // stillOpen check after every read. Each of the runtime's own tools, with
  // a cancel during its own identity read, or its session ending there,
  // spends, reads and writes nothing past it; a reserved name and a name
  // never registered answer a cancel alike.
  const BUILTINS = [
    {name: 'countinghouse_check_balance', key: KEY_A, nothing: () => [spent, balances]},
    {name: 'countinghouse_usage_report', key: KEY_A, nothing: () => [spent]},
    // (the overview's key, grants and who are the gate's, read just before:
    // no read of its own (#490's high round 2, 7), so its rate-limit unit is
    // spent at once, as a call that is not billed still counts, and the read
    // held is its listing's; past it, it runs and bills nothing)
    {name: 'countinghouse_overview', key: KEY_A, nothing: () => [invoked, billed]},
    {name: 'countinghouse_reload_auth', key: KEY_ADMIN, authoring: true, nothing: () => [reloads]},
    {name: 'countinghouse_load_module', key: KEY_ADMIN, authoring: true, args: {path: '/nowhere', name: 'x'}, nothing: () => [loads]},
    {name: 'countinghouse_settings', key: KEY_A, single: true, args: {action: 'set', name: 'requestTimeout', value: '20s'}, nothing: () => [settingsWrites()]}
  ];
  const reloads = [];
  const SETTINGS = path.join(home, 'settings.json');
  const settingsWrites = () => (fs.existsSync(SETTINGS) ? [fs.readFileSync(SETTINGS, 'utf8')] : []);
  // a tools/call of name, its own identity read (the provider's nth
  // authenticate) held: then cancelled, or its session ended
  const during = async(name, key, args, {nth, end, single, authoring, extra = {}}) => {
    require('../../lib/mcp/tool-registry').forgetGrants();
    for (const a of [spent, balances, loads, reloads, invoked, billed]) a.length = 0;
    fs.rmSync(SETTINGS, {force: true});
    options.setOptions(Object.assign({}, OPTIONS, authoring ? {authoringTools: true} : {}));
    // (the profile's fields are set as the start sets them, not through setOptions)
    const savedProfile = {singleIdentity: options.singleIdentity, settingsFile: options.settingsFile};
    if (single) Object.assign(options, {singleIdentity: true, settingsFile: SETTINGS});
    const sessions = require('../../lib/sessions');
    const SID = 'h'.repeat(32);
    const realGet = sessions.get;
    let live = true;
    sessions.get = (id) => (id === SID ? (live ? {id} : null) : realGet(id));
    let registered = null;
    // (a cancel: no session, as over HTTP, so a set is the file's and is
    // written; an ended session: the request's own)
    const opts = Object.assign(end ? {session: {id: SID, client: {status: 'ok', conditions: 'no', repo: null}}} : {},
      {cancellable: (fn) => { registered = fn; return () => { registered = null; }; }});
    let held = null;
    let n = 0;
    const authenticate = provider.authenticate;
    const reload = provider.reload;
    provider.reload = (cb) => { reloads.push(1); return reload.call(provider, cb); };
    provider.authenticate = (...a) => {
      const cb = a.pop();
      const k = ++n;
      return authenticate(...a, (...answer) => {
        if (k !== nth) return cb(...answer);
        if (end) { live = false; return cb(...answer); }
        held = () => cb(...answer);
        return undefined;
      });
    };
    try {
      const got = new Promise((resolve) => gateway.handle({jsonrpc: '2.0', id: 1, method: 'tools/call', params: Object.assign({name, arguments: args || {}}, extra)}, ci, key,
        (err, resp, info) => resolve({resp, info}), opts));
      if (!end) {
        for (let w = 0; held == null && w < 400; w++) await new Promise((res) => setImmediate(res));
        assert.ok(held != null, `${name}: its read is in flight`);
        assert.strictEqual(typeof(registered), 'function', `${name}: registered`);
        registered();
        held();
      }
      const out = await got;
      await new Promise((res) => setTimeout(res, 50));
      return out;
    } finally {
      provider.authenticate = authenticate;
      provider.reload = reload;
      sessions.get = realGet;
      options.setOptions(OPTIONS);
      Object.assign(options, savedProfile);
    }
  };
  for (const b of BUILTINS) {
    // (the gate resolves the key first: the tool's own identity read is the second)
    it(`${b.name}: cancelled during its own identity read, it spends, reads and writes nothing`, async () => {
      const {resp, info} = await during(b.name, b.key, b.args, {nth: 2, single: b.single, authoring: b.authoring});
      assert.strictEqual(resp, null, JSON.stringify(resp));
      assert.deepStrictEqual(info, {cancelled: true});
      assert.deepStrictEqual(b.nothing(), b.nothing().map(() => []));
    });
    it(`${b.name}: its session ending during its own identity read, it is answered as an ended session's and writes nothing`, async () => {
      const {resp} = await during(b.name, b.key, b.args, {nth: 2, end: true, single: b.single, authoring: b.authoring});
      assert.strictEqual(resp.result && resp.result._meta && resp.result._meta['countinghouse/code'], 'MODULE_NOT_LISTED', JSON.stringify(resp));
      assert.deepStrictEqual(b.nothing(), b.nothing().map(() => []));
    });
  }
  // (the medium of the cut) a task-augmented call: cancelled, or its session
  // ended, while its userAuth reads the key, it spends no rate-limit unit
  // and makes no job
  it('a task-augmented call cancelled during its userAuth spends no rate limit, and is not answered', async () => {
    const {resp, info} = await during('notes_svc_save', KEY_A, {}, {nth: 2, extra: {task: {}}});
    assert.strictEqual(resp, null, JSON.stringify(resp));
    assert.deepStrictEqual(info, {cancelled: true});
    assert.deepStrictEqual([spent, invoked], [[], []]);
  });
  it('a task-augmented call whose session ends during its userAuth spends no rate limit, and is answered as ended', async () => {
    const {resp} = await during('notes_svc_save', KEY_A, {}, {nth: 2, end: true, extra: {task: {}}});
    assert.strictEqual(resp.result && resp.result._meta && resp.result._meta['countinghouse/code'], 'MODULE_NOT_LISTED', JSON.stringify(resp));
    assert.deepStrictEqual([spent, invoked], [[], []]);
  });
  // #458's acceptance: a continuation that throws answers an internal error,
  // so the call's in-flight registration is released, never left for a
  // later cancel under a reused id to hit -- a built-in's, and a module run's
  for (const [label, name, key, breakIt] of [
    ['a built-in (countinghouse_check_balance)', 'countinghouse_check_balance', KEY_A, (c) => { c.checkBalance = () => { throw new Error('boom'); }; }],
    ['a module run', 'notes_svc_save', KEY_A, (c) => { c.invokeDeviceAction = () => { throw new Error('boom'); }; }]
  ]) {
    it(`${label} that throws in a continuation answers an internal error and leaves no in-flight entry`, async () => {
      require('../../lib/mcp/tool-registry').forgetGrants();
      const broken = Object.assign({}, ci);
      breakIt(broken);
      let registered = null;
      const opts = {cancellable: (fn) => { registered = fn; return () => { registered = null; }; }};
      const LOG = require('../../lib/logger');
      const logged = [];
      const realE = LOG.E;
      LOG.E = (e) => { logged.push(String(e && e.message)); };
      try {
        const r = await new Promise((resolve) => gateway.handle({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: {}}}, broken, key,
          (err, resp) => resolve(resp), opts));
        assert.deepStrictEqual(r.error, {code: -32603, message: 'internal error'}, JSON.stringify(r));
      } finally {
        LOG.E = realE;
      }
      assert.strictEqual(registered, null, 'its in-flight registration released');
      assert.ok(logged.includes('boom'), JSON.stringify(logged));
    });
  }

  // B-shutdown-usage (the high review of #488, 2): a call begun and answered
  // before it was sent is ended in the record then -- never left open for
  // the stop to end, dated at the stop
  it('a module run that throws before it is sent ends its usage record then, an internal error', async () => {
    require('../../lib/mcp/tool-registry').forgetGrants();
    const broken = Object.assign({}, ci, {invokeDeviceAction: () => { throw new Error('boom'); }});
    usageSeen.length = 0;
    const LOG = require('../../lib/logger');
    const realE = LOG.E;
    LOG.E = () => undefined;
    try {
      await new Promise((resolve) => gateway.handle({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'notes_svc_save', arguments: {}}}, broken, KEY_A, () => resolve(), {}));
    } finally {
      LOG.E = realE;
    }
    const outs = usageSeen.filter((e) => e.out != null).map((e) => e.out);
    assert.strictEqual(usageSeen.filter((e) => e.begin != null).length, 1, JSON.stringify(usageSeen));
    assert.deepStrictEqual(outs.map((o) => [o.outcome, o.code, o.bytes]), [['error', 'SYSTEM_ERROR', 0]], JSON.stringify(outs));
  });

  it('a call cancelled after it began, before it is sent, ends its usage record then, cancelled', async () => {
    require('../../lib/mcp/tool-registry').forgetGrants();
    const registry = require('../../lib/mcp/tool-registry');
    const realSchema = registry.outputSchemaForCall;
    let release = null;
    registry.outputSchemaForCall = (...a) => { release = () => realSchema(...a); };
    let registered = null;
    const opts = {cancellable: (fn) => { registered = fn; return () => { registered = null; }; }};
    usageSeen.length = 0;
    invoked.length = 0;
    try {
      const answered = new Promise((resolve) => gateway.handle({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'notes_svc_save', arguments: {}}}, ci, KEY_A, (err, resp, info) => resolve({resp, info}), opts));
      const end = Date.now() + 5000;
      while (release == null && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      assert.ok(release != null && registered != null, 'the call never reached its schema read');
      registered();
      release();
      await answered;
    } finally {
      registry.outputSchemaForCall = realSchema;
    }
    assert.deepStrictEqual(invoked, [], 'nothing was sent');
    const outs = usageSeen.filter((e) => e.out != null).map((e) => e.out);
    assert.deepStrictEqual(outs.map((o) => [o.outcome, o.bytes]), [['cancelled', 0]], JSON.stringify(usageSeen));
  });

  it('a reserved name and a name never registered answer a cancel during the gate\'s read alike', async () => {
    const reserved = await during('countinghouse_check_balance', KEY_A, {}, {nth: 1});
    const never = await during('no_such_tool_anywhere', KEY_A, {}, {nth: 1});
    assert.deepStrictEqual(reserved, never);
    assert.deepStrictEqual(never, {resp: null, info: {cancelled: true}});
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
      // (every limiter's answer, -32000, a module read's included: A-rpc429)
      assert.strictEqual(probe.error && probe.error.code, -32000, JSON.stringify(probe));
      assert.strictEqual(probe.error.data && probe.error.data['countinghouse/code'], 'RATE_LIMIT_EXCEEDED');
      // a limited read of a real resource, refused by the call path's own limit: the same answer
      const real = await read(KEY_A, 'countinghouse://m/notes/notes/one');
      // (the key's limit says nothing of what exists. At the runtime's own
      // limit, --globalRateLimit, only a listed URI's read meets it, 503,
      // while an unlisted one stays -32602; that tells a caller only of its
      // own list, which resources/list gives it anyway: #494's high, 3)
      assert.deepStrictEqual(probe.error, real.error, 'the key\'s limit says nothing of what exists');
      assert.deepStrictEqual(invoked, [], 'no module reached');
    } finally {
      limited = false;
    }
  });

  // (the limiter PR's medium, 2: these two called the gate's removed
  // error() -- a TypeError, answered -32603 -- once their caller was limited)
  it('a rate-limited caller\'s countinghouse_overview and the profile\'s authoring tools are refused RATE_LIMIT_EXCEEDED, as every tool', async () => {
    const SETTINGS = path.join(home, 'settings.json');
    const savedProfile = {singleIdentity: options.singleIdentity, settingsFile: options.settingsFile};
    limited = true;
    try {
      require('../../lib/mcp/tool-registry').forgetGrants();
      for (const [name, single] of [['countinghouse_overview', false], ['countinghouse_validate_plan', true]]) {
        if (single) Object.assign(options, {singleIdentity: true, settingsFile: SETTINGS});
        const r = await ask('tools/call', KEY_A, {name, arguments: {}});
        assert.strictEqual(r.error, undefined, `${name}: ${JSON.stringify(r)}`);
        assert.strictEqual(r.result && r.result.isError, true, `${name}: ${JSON.stringify(r)}`);
        assert.strictEqual(r.result._meta && r.result._meta['countinghouse/code'], 'RATE_LIMIT_EXCEEDED', `${name}: ${JSON.stringify(r)}`);
      }
    } finally {
      limited = false;
      Object.assign(options, savedProfile);
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
