'use strict';
// MCP completeness M11 (spec section 7), the part for prompts:
// completion/complete for a prompt's argument offers its schema's enum, then
// its examples, as derived at load (worker mode: in a validator; the main
// thread never walks a module's schema), matched to the value so far: the
// candidates that start with it, case-insensitively, then those that contain
// it, at most 100, with total and hasMore. No module code runs. A prompt the
// caller isn't listed is an unknown one; a resource template's completion
// comes with module resources (M7): until then every template is unknown.
// Discover and initialize declare completions.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {redisUrlFor} = require('../helpers/test-env');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mcp-30-'));
const AUTH = path.join(home, 'auth.json');
const KEY_A = `test-a-${'a'.repeat(24)}`;
const KEY_B = `test-b-${'b'.repeat(24)}`;
// B is granted the colours device only
const COLOURS_ID = require('../../lib/call-address').deviceIDForName('colours');
fs.writeFileSync(AUTH, JSON.stringify({[KEY_A]: {userName: 'a', devices: ['*']}, [KEY_B]: {userName: 'b', devices: [COLOURS_ID]}}));

const options = require('../../lib/cli-options');
const OPTIONS = {redisUrl: redisUrlFor(), authConfigPath: AUTH, listPageSize: 10};
// (set in the describe's before(), the process's put back in its after():
// never at load, which every file of a folder run would see -- B-loadopts)
const {snapshot: optionsNow, restore: restoreOptions} = require('../helpers/options-scope');
let keptOptions = null;
require('../../lib/logger').createLogger();
const gateway = require('../../lib/mcp/gateway');
const moduleSpec = require('../../lib/module-spec');
const callAddress = require('../../lib/call-address');

const SVC = 'urn:x:serviceID:svc';
const SCHEMA = '$schema';
// extra: more actions, each [declaration, its schemas]
function moduleOf(friendlyName, prompts, argumentSchemas, extra = []) {
  const spec = {device: {friendlyName, serviceList: {[SVC]: {actionList: [{name: 'go', description: 'go it', input: {schema: '/svc/go/input'}}].concat(extra.map((e) => e[0]))}}, promptList: prompts}};
  const svc = {go: {input: {type: 'object'}}};
  for (const [action, schemas] of extra) svc[action.name] = schemas;
  const schemaDoc = {[SCHEMA]: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object', svc, prompts: argumentSchemas};
  return {spec, schemaDoc};
}
// resources (M7): a template whose variable's input property declares an
// enum, one whose variable declares nothing, and a static one
const RESOURCES = [
  [{name: 'readShade', description: 'one shade', input: {schema: '/svc/readShade/input'}, output: {schema: '/svc/readShade/output'},
    resource: {uriTemplate: 'shades/{shade}', name: 'shade'}},
  {input: {type: 'object', properties: {shade: {type: 'string', enum: ['Red', 'reddish', 'blue', 'Dark Red']}}, required: ['shade']}, output: {type: 'object'}}],
  [{name: 'readNote', description: 'one note', input: {schema: '/svc/readNote/input'}, output: {schema: '/svc/readNote/output'},
    resource: {uriTemplate: 'notes/{id}', name: 'note'}},
  {input: {type: 'object', properties: {id: {type: 'string'}}, required: ['id']}, output: {type: 'object'}}],
  [{name: 'about', description: 'about', output: {schema: '/svc/about/output'}, resource: {uriTemplate: 'about', name: 'about'}}, {output: {type: 'object'}}]
];
const MANY = Array.from({length: 150}, (_, i) => `shade-${String(i).padStart(3, '0')}`);
const MODULES = [
  moduleOf('colours', [
    {name: 'paint', arguments: {schema: '/prompts/paint'}, messages: [{role: 'user', text: 'Paint it {{colour}} with a {{finish}} finish, {{note}}.'}]},
    {name: 'shades', arguments: {schema: '/prompts/shades'}, messages: [{role: 'user', text: '{{shade}}'}]}
  ], {
    paint: {type: 'object', properties: {
      colour: {type: 'string', enum: ['Red', 'green', 'blue', 'Dark Red', 'reddish', 'Bordeaux']},
      finish: {type: 'string', examples: ['matt', 'gloss', 'satin', 'Matt']},
      note: {type: 'string', description: 'free text'},
      both: {type: 'string', enum: ['alpha', 'beta'], examples: ['beta', 'gamma', 7, 'x'.repeat(300)]}
    }, required: ['colour']},
    shades: {type: 'object', properties: {shade: {type: 'string', enum: MANY}}}
  }, RESOURCES),
  moduleOf('tints', [{name: 'tint', arguments: {schema: '/prompts/tint'}, messages: [{role: 'user', text: '{{shade}}'}], completion: {shade: 'svc.completeTint'}}],
    {tint: {type: 'object', properties: {shade: {type: 'string', enum: ['teal', 'tan']}}}},
    [[{name: 'completeTint', description: 'completes a tint', input: {schema: '/svc/completeTint/input'}, output: {schema: '/svc/completeTint/output'}},
      {input: {type: 'object', properties: {argument: {type: 'string'}, value: {type: 'string'}, context: {type: 'object'}}, required: ['argument', 'value']},
        output: {type: 'object', properties: {values: {type: 'array', items: {type: 'string'}}}, required: ['values']}}]]),
  moduleOf('secret', [{name: 'hidden', arguments: {schema: '/prompts/hidden'}, messages: [{role: 'user', text: '{{code}}'}]}],
    {hidden: {type: 'object', properties: {code: {type: 'string', enum: ['alpha', 'omega']}}}}, [RESOURCES[0]])
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
    devices[deviceID] = {spec: own.spec, moduleSpec: own, packageInfo: {name: m.spec.device.friendlyName, countinghouse: {}}};
  }
  return {
    deviceManager: {deviceMap: devices, getAllDeviceSpecs: () => Object.fromEntries(Object.entries(devices).map(([id, d]) => [id, d.spec]))},
    getDeviceSchema(deviceID, p, session) { session.localCallback(null, {type: 'object'}); },
    rateLimit: (key, cb) => cb(null, {limited: limited}),
    // a completion never reaches a module's code: anything that tried to would throw here
    invoke() { throw new Error('module code was run'); }
  };
}
let limited = false;

const MODERN = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
const ask = (method, key, params = {}, {modern = false, iface} = {}) => new Promise((resolve) => {
  const p = Object.assign({}, params);
  if (modern) p._meta = MODERN;
  gateway.handle({jsonrpc: '2.0', id: 1, method, params: p}, iface || ci, key, (err, r) => resolve(r));
});
const complete = (key, name, argument, value, opts) => ask('completion/complete', key, {ref: {type: 'ref/prompt', name}, argument: {name: argument, value}}, opts);

describe('mcp-contract 30: completion of a prompt\'s arguments (M11)', function() {
  this.timeout(60000);
  let provider = null;
  let real = null;
  // each test starts with a full completion floor (F3-6): the file's calls never spend another test's
  beforeEach(() => gateway.resetCompletionFloor());
  after(() => gateway.resetCompletionFloor());
  before(async () => {
    keptOptions = optionsNow();
    options.setOptions(OPTIONS);
    const FileAuthProvider = require('../../lib/auth/file-provider');
    const own = new FileAuthProvider({configPath: AUTH});
    provider = require('../../lib/auth').getAuthProvider();
    real = {authenticate: provider.authenticate, listDevices: provider.listDevices};
    provider.authenticate = (...args) => own.authenticate(...args);
    provider.listDevices = (...args) => own.listDevices(...args);
    ci = await buildInterface();
  });
  after(() => {
    require('../../lib/validator-pool').closeShared();
    if (provider != null) Object.assign(provider, real);
    fs.rmSync(home, {recursive: true, force: true});
    restoreOptions(keptOptions);
  });
  afterEach(() => { limited = false; });

  for (const modern of [false, true]) {
    const era = modern ? '2026-07-28' : 'legacy';

    it(`${era}: an enum argument: those that start with the value, case-insensitively, first, then those that contain it`, async () => {
      const r = await complete(KEY_A, 'colours_paint', 'colour', 're', {modern});
      assert.deepStrictEqual(r.result.completion, {values: ['Red', 'reddish', 'green', 'Dark Red'], total: 4, hasMore: false}, JSON.stringify(r));
      const all = await complete(KEY_A, 'colours_paint', 'colour', '', {modern});
      assert.deepStrictEqual(all.result.completion.values, ['Red', 'green', 'blue', 'Dark Red', 'reddish', 'Bordeaux'], 'an empty value: every candidate, in its declared order');
      const none = await complete(KEY_A, 'colours_paint', 'colour', 'purple', {modern});
      assert.deepStrictEqual(none.result.completion, {values: [], total: 0, hasMore: false});
    });
  }

  it('examples are candidates too; enum first, then examples, each once; non-strings and over-long ones are not', async () => {
    const r = await complete(KEY_A, 'colours_paint', 'finish', 'MA');
    assert.deepStrictEqual(r.result.completion.values, ['matt', 'Matt']);
    const both = await complete(KEY_A, 'colours_paint', 'both', '');
    assert.deepStrictEqual(both.result.completion.values, ['alpha', 'beta', 'gamma']);
  });

  it('an argument with neither enum nor examples offers nothing; one the prompt does not have is invalid', async () => {
    const r = await complete(KEY_A, 'colours_paint', 'note', 'a');
    assert.deepStrictEqual(r.result.completion, {values: [], total: 0, hasMore: false});
    const unknown = await complete(KEY_A, 'colours_paint', 'nope', 'a');
    assert.strictEqual(unknown.error && unknown.error.code, -32602);
    const proto = await complete(KEY_A, 'colours_paint', '__proto__', '');
    assert.strictEqual(proto.error && proto.error.code, -32602, 'a key of every object is no argument');
  });

  it('at most 100 values, with the total and hasMore', async () => {
    const r = await complete(KEY_A, 'colours_shades', 'shade', 'shade');
    assert.strictEqual(r.result.completion.values.length, 100);
    assert.deepStrictEqual(r.result.completion.values.slice(0, 2), ['shade-000', 'shade-001']);
    assert.strictEqual(r.result.completion.total, 150);
    assert.strictEqual(r.result.completion.hasMore, true);
    // a value past 256 characters (the candidates' own bound) is refused (F3-6); one longer than any candidate matches none
    const long = await complete(KEY_A, 'colours_shades', 'shade', 's'.repeat(300));
    assert.match(long.error && long.error.message, /longer than 256/, JSON.stringify(long));
    const longest = await complete(KEY_A, 'colours_shades', 'shade', 's'.repeat(256));
    assert.deepStrictEqual(longest.result.completion, {values: [], total: 0, hasMore: false}, 'a value longer than any candidate matches none');
  });

  it('a prompt the caller is not listed is an unknown prompt: completion finds no other tenant\'s prompts', async () => {
    const own = await complete(KEY_B, 'colours_paint', 'colour', 'r');
    assert.ok(own.result != null, JSON.stringify(own));
    const other = await complete(KEY_B, 'secret_hidden', 'code', 'a');
    const unknown = await complete(KEY_B, 'no_such_prompt', 'code', 'a');
    assert.deepStrictEqual([other.error && other.error.code, other.error && other.error.message], [-32602, 'unknown prompt']);
    assert.deepStrictEqual(other.error, unknown.error, 'the same answer as an unknown one');
  });

  it('a resource template: its variable\'s candidates, from the input property behind it, matched as a prompt argument\'s are', async () => {
    const res = await ask('completion/complete', KEY_A, {ref: {type: 'ref/resource', uri: 'countinghouse://m/colours/shades/{shade}'}, argument: {name: 'shade', value: 're'}});
    assert.deepStrictEqual(res.result, {completion: {values: ['Red', 'reddish', 'Dark Red'], total: 3, hasMore: false}}, JSON.stringify(res));
    const none = await ask('completion/complete', KEY_A, {ref: {type: 'ref/resource', uri: 'countinghouse://m/colours/notes/{id}'}, argument: {name: 'id', value: ''}});
    assert.deepStrictEqual(none.result, {completion: {values: [], total: 0, hasMore: false}});
  });

  it('a template the caller is not listed, a static resource, an unknown one, or a name that is not its variable: -32602; a malformed ref or argument is invalid', async () => {
    for (const [key, uri, name, message] of [[KEY_A, 'countinghouse://m/colours/x/{id}', 'id', 'unknown resource template'],
      [KEY_A, 'countinghouse://m/colours/about', 'id', 'unknown resource template'],
      [KEY_B, 'countinghouse://m/secret/shades/{shade}', 'shade', 'unknown resource template'],
      [KEY_A, 'countinghouse://m/colours/shades/{shade}', 'colour', 'unknown argument']]) {
      const res = await ask('completion/complete', key, {ref: {type: 'ref/resource', uri}, argument: {name, value: ''}});
      assert.deepStrictEqual([res.error && res.error.code, res.error && res.error.message], [-32602, message], uri);
    }
    for (const params of [{ref: {type: 'ref/resource'}, argument: {name: 'shade', value: ''}}, {ref: {type: 'ref/resource', uri: 5}, argument: {name: 'shade', value: ''}}]) {
      const r = await ask('completion/complete', KEY_A, params);
      assert.strictEqual(r.error && r.error.code, -32602, JSON.stringify(params));
    }
    for (const params of [{}, {ref: 'colours_paint', argument: {name: 'colour', value: ''}}, {ref: {type: 'ref/other', name: 'colours_paint'}, argument: {name: 'colour', value: ''}},
      {ref: {type: 'ref/prompt', name: 'colours_paint'}}, {ref: {type: 'ref/prompt', name: 'colours_paint'}, argument: {name: 'colour', value: 5}},
      {ref: {type: 'ref/prompt', name: 'colours_paint'}, argument: {name: 'colour'}}]) {
      const r = await ask('completion/complete', KEY_A, params);
      assert.strictEqual(r.error && r.error.code, -32602, JSON.stringify(params));
    }
  });

  // The per-key rate limit is what bounds a completion action (it is not
  // billed): the completion request itself is gated (resolveGatedIdentity's
  // rateLimitGate.check, which takes the key's token) before anything is
  // looked up, so a key at its limit is refused and no module code runs.
  it('a completion that would run an action, at the key\'s rate limit: refused, and the action never runs', async () => {
    const ran = [];
    // the module's action, as the call path reaches it, answering at once
    ci.invokeDeviceAction = (deviceID, serviceID, actionName, args, session) => { ran.push(actionName); session.callbackWithoutTimer(null, {output: {values: ['teal-blue']}}); };
    try {
      limited = true;
      const refused = await complete(KEY_A, 'tints_tint', 'shade', 't');
      // (every limiter's answer: -32000 with the key's limit code; A-rpc429)
      assert.deepStrictEqual([refused.error && refused.error.code, refused.error && refused.error.data['countinghouse/code']], [-32000, 'RATE_LIMIT_EXCEEDED'], JSON.stringify(refused));
      assert.deepStrictEqual(ran, [], 'the action ran at the limit');
      // and under it, the action is what answers
      limited = false;
      const answered = await complete(KEY_A, 'tints_tint', 'shade', 't');
      assert.deepStrictEqual(ran, ['completeTint']);
      assert.deepStrictEqual(answered.result && answered.result.completion, {values: ['teal-blue'], total: 1, hasMore: false}, JSON.stringify(answered));
    } finally {
      delete ci.invokeDeviceAction;
    }
  });

  // F3-6: a floor whatever --apiKeyRateLimit says (none here: limited false), and a bounded value
  it('a value longer than 256 characters is refused, before anything is asked', async () => {
    limited = false;
    const r = await complete(KEY_A, 'colours_paint', 'colour', 'r'.repeat(257));
    assert.match(r.error && r.error.message, /longer than 256/, JSON.stringify(r));
    const ok = await complete(KEY_A, 'colours_paint', 'colour', 'r'.repeat(256));
    assert.ok(ok.result != null, JSON.stringify(ok));
  });

  it('with no key limit at all, completion has a floor of its own per key (50 a second)', async () => {
    limited = false;
    // a clock that stands still: the 51st in the same instant is refused, and a second later there are 50 again
    let now = 1000;
    gateway.resetCompletionFloor(() => now);
    try {
      for (let i = 0; i < 50; i++) {
        const r = await complete(KEY_A, 'colours_paint', 'colour', 'r');
        assert.ok(r.result != null, `${i}: ${JSON.stringify(r)}`);
      }
      const over = await complete(KEY_A, 'colours_paint', 'colour', 'r');
      // (every limiter's answer: -32000, A-rpc429)
      assert.strictEqual(over.error && over.error.code, -32000, JSON.stringify(over));
      // (its data as every rate-limit error's: the code, the kind and when
      // to retry, the floor's 1 s; #482's high, round 3, 4)
      assert.deepStrictEqual(over.error.data, {'countinghouse/code': 'RATE_LIMIT_EXCEEDED', 'countinghouse/kind': 'caller', 'countinghouse/retryAfter': 1});
      now += 1000;
      const again = await complete(KEY_A, 'colours_paint', 'colour', 'r');
      assert.ok(again.result != null, JSON.stringify(again));
    } finally { gateway.resetCompletionFloor(); }
  });

  it('at most 8 of a key\'s completion actions run at once: past it, the schema\'s candidates answer at once (F3-6)', async () => {
    limited = false;
    const held = [];
    ci.invokeDeviceAction = (deviceID, serviceID, actionName, args, session) => { held.push(session); };
    try {
      const pending = Array.from({length: 8}, () => complete(KEY_A, 'tints_tint', 'shade', 't'));
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(held.length, 8, 'eight run');
      const ninth = await complete(KEY_A, 'tints_tint', 'shade', 't');
      assert.ok(ninth.result != null && Array.isArray(ninth.result.completion.values), JSON.stringify(ninth));
      assert.strictEqual(held.length, 8, 'the ninth ran nothing');
      for (const s of held) s.callbackWithoutTimer(null, {output: {values: ['teal-blue']}});
      await Promise.all(pending);
    } finally {
      delete ci.invokeDeviceAction;
    }
  });

  it('the floor and the running count are kept by the key\'s meterId, never the key (C-meter-keys-3)', async () => {
    limited = false;
    const {meterId} = require('../../lib/key-fingerprint');
    const {rawKeyPaths} = require('../helpers/no-raw-key');
    const held = [];
    ci.invokeDeviceAction = (deviceID, serviceID, actionName, args, session) => { held.push(session); };
    try {
      const pending = complete(KEY_A, 'tints_tint', 'shade', 't');
      for (let i = 0; i < 1000 && held.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      assert.strictEqual(held.length, 1, 'one runs');
      const kept = gateway.completionKeysForTests();
      assert.deepStrictEqual(rawKeyPaths(kept, KEY_A), [], JSON.stringify(kept));
      assert.deepStrictEqual(kept, {floor: [meterId(KEY_A)], runs: [meterId(KEY_A)]});
      held[0].callbackWithoutTimer(null, {output: {values: ['teal-blue']}});
      await pending;
    } finally {
      delete ci.invokeDeviceAction;
    }
  });

  it('completion is rate limited', async () => {
    limited = true;
    const r = await complete(KEY_A, 'colours_paint', 'colour', 'r');
    assert.deepStrictEqual([r.error && r.error.code, r.error && r.error.data['countinghouse/code']], [-32000, 'RATE_LIMIT_EXCEEDED'], JSON.stringify(r));
  });

  it('single-thread mode (no worker spec record): the candidates are derived on the main thread', async () => {
    const CHDevice = require('../../lib/countinghouse-device');
    const spec = {device: {friendlyName: 'single', serviceList: {}, promptList: [{name: 'ask', arguments: {schema: '/prompts/ask'}, messages: [{role: 'user', text: '{{q}}'}]}]}};
    const schemaDoc = {$id: '#/', prompts: {ask: {type: 'object', properties: {q: {type: 'string', enum: ['yes', 'no', 'maybe']}}}}};
    const device = {spec, schemaDoc, resolveSchemaFromPath: CHDevice.prototype.resolveSchemaFromPath, packageInfo: {name: 'single'}};
    const single = {deviceManager: {deviceMap: {single: device}, getAllDeviceSpecs: () => ({single: spec})}, rateLimit: (key, cb) => cb(null, {limited: false})};
    const r = await complete(KEY_A, 'single_ask', 'q', 'y', {iface: single});
    assert.deepStrictEqual(r.result.completion, {values: ['yes', 'maybe'], total: 2, hasMore: false}, JSON.stringify(r));
  });

  it('single-thread mode: a template\'s candidates are derived on the main thread too', async () => {
    const CHDevice = require('../../lib/countinghouse-device');
    const spec = {device: {friendlyName: 'single', serviceList: {[SVC]: {actionList: [{name: 'readShade', description: 'one shade',
      input: {schema: '/svc/readShade/input'}, output: {schema: '/svc/readShade/output'}, resource: {uriTemplate: 'shades/{shade}', name: 'shade'}}]}}}};
    const schemaDoc = {$id: '#/', svc: {readShade: {input: {type: 'object', properties: {shade: {type: 'string', examples: ['teal', 'tan']}}, required: ['shade']}, output: {type: 'object'}}}};
    const device = {spec, schemaDoc, resolveSchemaFromPath: CHDevice.prototype.resolveSchemaFromPath, packageInfo: {name: 'single'}};
    const single = {deviceManager: {deviceMap: {single: device}, getAllDeviceSpecs: () => ({single: spec})}, rateLimit: (key, cb) => cb(null, {limited: false})};
    const r = await ask('completion/complete', KEY_A, {ref: {type: 'ref/resource', uri: 'countinghouse://m/single/shades/{shade}'}, argument: {name: 'shade', value: 't'}}, {iface: single});
    assert.deepStrictEqual(r.result && r.result.completion, {values: ['teal', 'tan'], total: 2, hasMore: false}, JSON.stringify(r));
  });

  it('a value that only matches lowercased (U+0130 lowercases to two code units) is still matched past 256 characters', () => {
    const completion = require('../../lib/mcp/completion');
    const candidate = '\u0130'.repeat(200);
    const r = completion.match([candidate], candidate.toLowerCase().slice(0, 300));
    assert.deepStrictEqual(r, {values: [candidate], total: 1, hasMore: false});
    assert.deepStrictEqual(completion.match([candidate], 'x'.repeat(513)), {values: [], total: 0, hasMore: false});
  });

  it('a module\'s candidates are bounded over all its prompts (10000), later arguments offering none', async () => {
    const promptArguments = require('../../lib/prompt-arguments');
    const many = (k) => ({type: 'string', enum: Array.from({length: 1000}, (_, i) => `${k}-${i}`)});
    const props = {};
    for (let k = 0; k < 12; k++) props[`a${String(k).padStart(2, '0')}`] = many(k);
    const spec = {device: {promptList: [{name: 'big', arguments: {schema: '/prompts/big'}}]}};
    const schemaDoc = {prompts: {big: {type: 'object', properties: props}}};
    const device = {spec, schemaDoc, resolveSchemaFromPath: (pointer, x, cb) => cb(null, null, schemaDoc.prompts.big)};
    const d = (await promptArguments.deriveAll(device)).get('big').candidates;
    const counts = Object.keys(props).map((k) => d[k].length);
    assert.deepStrictEqual(counts, [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 0, 0]);
  });

  it('single-thread mode: a derivation that fails is the server\'s error (-32603), not an unknown argument', async () => {
    const spec = {device: {friendlyName: 'broken', serviceList: {}, promptList: [{name: 'ask', arguments: {schema: '/prompts/ask'}, messages: [{role: 'user', text: '{{q}}'}]}]}};
    const device = {spec, schemaDoc: {}, resolveSchemaFromPath: (pointer, x, cb) => cb(new Error('no such schema')), packageInfo: {name: 'broken'}};
    const single = {deviceManager: {deviceMap: {broken: device}, getAllDeviceSpecs: () => ({broken: spec})}, rateLimit: (key, cb) => cb(null, {limited: false})};
    const r = await complete(KEY_A, 'broken_ask', 'q', '', {iface: single});
    assert.strictEqual(r.error && r.error.code, -32603, JSON.stringify(r));
  });

  it('a transport that throws on the answer leaves no unhandled rejection', async () => {
    const seen = [];
    const onUnhandled = (e) => seen.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      await new Promise((resolve) => {
        gateway.handle({jsonrpc: '2.0', id: 1, method: 'completion/complete', params: {ref: {type: 'ref/prompt', name: 'colours_paint'}, argument: {name: 'colour', value: 'r'}}}, ci, KEY_A, () => {
          setTimeout(resolve, 50);
          throw new Error('the socket is gone');
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
    assert.deepStrictEqual(seen, []);
  });

  for (const modern of [false, true]) {
    it(`${modern ? 'discover' : 'initialize'} declares completions`, async () => {
      const r = modern ? await ask('server/discover', KEY_A, {}, {modern: true})
        : await ask('initialize', KEY_A, {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 't', version: '0'}});
      assert.ok(r.result != null, JSON.stringify(r));
      assert.deepStrictEqual(r.result.capabilities.completions, {});
    });
  }
});
