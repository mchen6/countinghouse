// The main thread's copy of a module's spec (lib/module-spec.js, lean
// worker step 1), server-free: built from the module's own files, the checks
// it makes before a call is sent to the worker (in a worker's order, with a
// worker's codes, as a worker's reply carries them), the output check on the
// reply, the calls it leaves to the worker, and the device registered only
// when a worker announces exactly this spec. End to end, with a module that
// turns off its own worker's validation: test/sandbox/41.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {EventEmitter} = require('events');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'main-checked');
const SERVICE = 'urn:countinghouse-test:serviceID:checkService';

describe('module-loading 23: a module\'s spec on the main thread, and its checks in a validator', function() {
  // Requiring the device manager loads much of the runtime: 30 s, as 22 has.
  this.timeout(30000);
  let moduleSpec = null;
  let own = null;
  before(async () => {
    require('../../lib/cli-options').setOptions({workerThread: true});
    moduleSpec = require('../../lib/module-spec');
    own = await moduleSpec.build(FIXTURE, 'main-checked');
  });
  after(() => {
    require('../../lib/validator-pool').pool().close();
    require('../../lib/cli-options').setOptions({workerThread: false});
  });

  // The structural check here, then the input in a validator: the call's
  // answer, [error, data], or null when it may be sent.
  async function full(spec, serviceID, actionName, args) {
    const checked = moduleSpec.checkInput(spec, spec.deviceID, serviceID, actionName, args);
    if (checked == null) return 'unchecked';
    if (checked.refused != null) return checked.refused;
    return moduleSpec.validate(checked, 'input', args);
  }
  const check = (serviceID, actionName, args) => full(own, serviceID, actionName, args);
  // [code, message, data] of a refusal
  const answer = (refused) => [refused[0].code, refused[0].message, refused[1]];

  it('is built from the module\'s files: its device ID, its spec, its names and a hash of schema.json, and nothing compiled', () => {
    assert.strictEqual(own.error, undefined);
    assert.strictEqual(own.deviceID, require('../../lib/call-address').deviceIDForName('main-checked'));
    assert.deepStrictEqual([...own.names[SERVICE]].sort(), ['big', 'count', 'give', 'slow', 'stall', 'take', 'tamper']);
    assert.strictEqual(own.specText, JSON.stringify(own.spec));
    assert.strictEqual(own.schemaHash, moduleSpec.hashOf(fs.readFileSync(path.join(FIXTURE, 'schema.json')).toString()));
    assert.strictEqual(own.services, undefined, 'no Service, no validator, on the main thread');
  });

  it('a module whose api.json cannot be read builds no spec, and nothing is checked against it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-main-spec-'));
    try {
      fs.writeFileSync(path.join(dir, 'api.json'), '{');
      const broken = await moduleSpec.build(dir);
      assert.strictEqual(typeof(broken.error), 'string');
      assert.strictEqual(moduleSpec.checkInput(broken, undefined, SERVICE, 'take', {input: {n: 'x'}}), null);
      assert.strictEqual(moduleSpec.matches(broken, undefined, {}), false);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('each module\'s validators are its own: an absolute $id compiles again at the next start, and in another module', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-main-spec-id-'));
    try {
      for (const name of ['id-one', 'id-two']) {
        const m = path.join(dir, name);
        fs.mkdirSync(m);
        fs.writeFileSync(path.join(m, 'api.json'), JSON.stringify({device: {friendlyName: name, serviceList: {'urn:countinghouse-test:serviceID:s': {
          actionList: [{name: 'a', input: {schema: '/s/a/input'}}]}}}}));
        fs.writeFileSync(path.join(m, 'schema.json'), JSON.stringify({$id: '#/', s: {a: {input: {$id: 'https://example.invalid/same', type: 'object', required: ['k']}}}}));
      }
      for (const b of [await moduleSpec.build(path.join(dir, 'id-one')), await moduleSpec.build(path.join(dir, 'id-one')), await moduleSpec.build(path.join(dir, 'id-two'))]) {
        assert.strictEqual(await full(b, 'urn:countinghouse-test:serviceID:s', 'a', {input: {k: 1}}), null, JSON.stringify(b.error));
        assert.strictEqual((await full(b, 'urn:countinghouse-test:serviceID:s', 'a', {input: {}}))[0].code, 'INPUT_DATA_VALIDATION_FAIL');
      }
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('checks in a worker\'s order: the service, the action, an input at all (here), then the input (in a validator)', async () => {
    const bad = {input: {n: 'x'}};
    assert.deepStrictEqual(answer(await check('urn:countinghouse-test:serviceID:nowhere', 'take', bad)).slice(0, 1), ['SERVICE_NOT_FOUND']);
    assert.deepStrictEqual(answer(await check(SERVICE, 'nowhere', bad)).slice(0, 1), ['ACTION_NOT_FOUND']);
    const none = answer(await check(SERVICE, 'take', null));
    assert.deepStrictEqual([none[0], none[2]], ['INPUT_NOT_FOUND', null]);
    const refused = answer(await check(SERVICE, 'take', bad));
    assert.strictEqual(refused[0], 'INPUT_DATA_VALIDATION_FAIL');
    assert.deepStrictEqual(refused[2], {reason: 'data validation failed',
      info: {dataPath: '/n', schemaPath: '#/properties/n/type', validatorMessage: 'must be integer'}});
    assert.deepStrictEqual(answer(await check(SERVICE, 'take', {input: {n: 1}, more: 1}))[2],
      {reason: 'unexpected input argument: more', info: ''});
  });

  it('a refusal is the error a worker\'s reply carries: a plain Error with its code', async () => {
    const err = (await check(SERVICE, 'take', {input: {n: 'x'}}))[0];
    const {CountinghouseError} = require('../../lib/countinghouse-error');
    const viaReply = CountinghouseError.fromReplyFields(CountinghouseError.replyFields(new CountinghouseError('INPUT_DATA_VALIDATION_FAIL')));
    assert.strictEqual(Object.getPrototypeOf(err), Object.getPrototypeOf(viaReply));
    assert.deepStrictEqual([err.code, err.message], [viaReply.code, viaReply.message]);
  });

  it('a valid input passes, and its output is checked in a validator', async () => {
    const args = {input: {kind: 'good'}, ctx: {}, usageCall: 3};
    const checked = moduleSpec.checkInput(own, own.deviceID, SERVICE, 'give', args);
    assert.strictEqual(await moduleSpec.validate(checked, 'input', args), null);
    assert.strictEqual(await moduleSpec.validate(checked, 'output', {output: {v: 'a'}}), null);
    const refused = await moduleSpec.validate(checked, 'output', {output: {v: 1}});
    assert.strictEqual(refused[0].code, 'OUTPUT_DATA_VALIDATION_FAIL');
    assert.strictEqual(refused[1].reason, 'data validation failed');
    assert.deepStrictEqual((await moduleSpec.validate(checked, 'output', {output: {v: 'a'}, extra: 1}))[1], {reason: 'unexpected output argument: extra', info: ''});
    assert.strictEqual((await moduleSpec.validate(checked, 'output', undefined))[0].code, 'MISSING_OUTPUT_ARGUMENT');
  });

  it('leaves to the worker only a device it has no spec for', () => {
    assert.strictEqual(moduleSpec.checkInput(null, own.deviceID, SERVICE, 'take', {input: {n: 'x'}}), null);
    assert.strictEqual(moduleSpec.checkInput(own, 'another-device', SERVICE, 'take', {input: {n: 'x'}}), null);
  });

  it('a name only Object.prototype has is not found: the service, or the action', async () => {
    const bad = {input: {n: 'x'}};
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.deepStrictEqual(answer(await check(name, 'take', bad)).slice(0, 1), ['SERVICE_NOT_FOUND'], `service ${name}`);
      assert.deepStrictEqual(answer(await check(SERVICE, name, bad)).slice(0, 1), ['ACTION_NOT_FOUND'], `action ${name}`);
      assert.deepStrictEqual(answer(await check(SERVICE, name, null)).slice(0, 1), ['ACTION_NOT_FOUND'], `action ${name}, no input`);
    }
  });

  it('an action the module declares under an Object.prototype name is its own: here, in a validator, and in the device a worker builds', async () => {
    const NAMES = ['toString', 'constructor', '__proto__', 'valueOf'];
    const spec = {device: {friendlyName: 'proto-named', serviceList: {'urn:countinghouse-test:serviceID:toString': {actionList: NAMES.map((name) => ({name: name,
      input: {schema: '/s/in'}}))}}}};
    const ownSpec = await moduleSpec.fromParts(JSON.parse(JSON.stringify(spec)), {$id: '#/', s: {in: {type: 'object', properties: {n: {type: 'integer'}}}}});
    moduleSpec.register(ownSpec);
    const at = (actionName, args) => full(ownSpec, 'urn:countinghouse-test:serviceID:toString', actionName, args);
    for (const name of NAMES) {
      assert.strictEqual(await at(name, {input: {n: 1}}), null, `${name} is declared`);
      assert.strictEqual((await at(name, {input: {n: 'x'}}))[0].code, 'INPUT_DATA_VALIDATION_FAIL', `${name}'s input is checked`);
    }
    assert.strictEqual((await at('hasOwnProperty', {input: {}}))[0].code, 'ACTION_NOT_FOUND');
    // The worker's device: setAction sets the module's own entry and leaves Object.prototype alone.
    const CHDevice = require('../../lib/countinghouse-device');
    const device = new CHDevice(JSON.parse(JSON.stringify(spec)));
    const handler = (args, cb) => cb(null, {output: {}});
    for (const name of NAMES) device.setAction('urn:countinghouse-test:serviceID:toString', name, handler);
    const service = device.services['urn:countinghouse-test:serviceID:toString'];
    for (const name of NAMES) assert.strictEqual(typeof(Object.getOwnPropertyDescriptor(service.actions, name).value.invoke), 'function', name);
    assert.strictEqual(Object.prototype.toString.invoke, undefined, 'Object.prototype.toString untouched');
    assert.strictEqual(Object.invoke, undefined, 'Object untouched');
    const refused = await new Promise((resolve) => device.deviceControl('urn:countinghouse-test:serviceID:s', 'toString', {input: {}}, (err) => resolve(err)));
    assert.strictEqual(refused.code, 'SERVICE_NOT_FOUND');
    const notDeclared = await new Promise((resolve) => service.invokeAction('hasOwnProperty', {input: {}}, (err) => resolve(err)));
    assert.strictEqual(notDeclared.code, 'ACTION_NOT_FOUND');
  });

  describe('the schema is checked before anything of it runs on the main thread (lib/schema-safety.js)', () => {
    const safety = () => require('../../lib/schema-safety');
    const SCHEMA_ROOT = (ping) => ({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object', s: {ping: ping}});
    // A module whose one action's input is `input`, and whose schema.json has `extra` beside it.
    function moduleWith(name, input, extra = {}) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ch-safety-${name}-`));
      fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name, serviceList: {'urn:countinghouse-test:serviceID:s': {
        actionList: [{name: 'ping', input: {schema: '/s/ping/input'}, output: {schema: '/s/ping/output'}}]}}}}));
      fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({...SCHEMA_ROOT({input: input, output: {type: 'object'}}), ...extra}));
      return dir;
    }
    const refusalOf = (dir, name) => safety().schemaRefusal(dir, name);
    const dirs = [];
    const made = (dir) => { dirs.push(dir); return dir; };
    after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true}); });

    it('a pattern that can backtrack catastrophically is refused, naming the module and the schema path but not the pattern', () => {
      const e = refusalOf(made(moduleWith('redos', {type: 'object', properties: {s: {type: 'string', pattern: '^(a+)+$'}}})), 'redos');
      assert.strictEqual(e.code, 'MODULE_ASSEMBLY_FAIL');
      assert.match(e.message, /redos/);
      assert.match(e.message, /\/s\/ping\/input\/properties\/s\/pattern/);
      assert.ok(!e.message.includes('(a+)+'), e.message);
    });

    it('a plain pattern is accepted, and so is a pattern-looking value under enum, const, default or examples', () => {
      assert.strictEqual(refusalOf(made(moduleWith('plain', {type: 'object', properties: {s: {type: 'string', pattern: '^[a-z]+$'}}})), 'plain'), null);
      const data = {type: 'object', default: {pattern: '^(a+)+$'}, examples: [{pattern: '(a*)*'}], properties: {k: {enum: [{pattern: '(a+)+'}], const: {pattern: '(x+)+'}}}};
      assert.strictEqual(refusalOf(made(moduleWith('data', data)), 'data'), null);
    });

    it('a property or definition named default, enum, const or examples is a schema: its pattern is checked (/code-review of 5ae7454)', () => {
      const asProperty = refusalOf(made(moduleWith('prop-default', {type: 'object', properties: {default: {type: 'string', pattern: '(a+)+$'}}})), 'prop-default');
      assert.match(asProperty.message, /\/s\/ping\/input\/properties\/default\/pattern/);
      const asDef = refusalOf(made(moduleWith('def-enum', {$ref: '#/$defs/enum'}, {$defs: {enum: {type: 'string', pattern: '(b*)*'}}})), 'def-enum');
      assert.match(asDef.message, /\/\$defs\/enum\/pattern/);
    });

    it('a bomb reached through a $ref partway along a pointer, or left unreferenced in $defs, is counted; a $ref to no place is refused', () => {
      const definitions = {hop: {$ref: '#/definitions'}, a0: {type: 'string'}};
      for (let i = 1; i <= 30; i++) definitions[`a${i}`] = {allOf: [{$ref: `#/definitions/hop/a${i - 1}`}, {$ref: `#/definitions/hop/a${i - 1}`}]};
      assert.match(refusalOf(made(moduleWith('hop', {$ref: '#/definitions/a30'}, {definitions})), 'hop').message, /more than 100000 schema nodes/);
      const defs = {l0: {type: 'string'}};
      for (let i = 1; i <= 12; i++) defs[`l${i}`] = {anyOf: Array.from({length: 10}, () => ({$ref: `#/defs/l${i - 1}`}))};
      assert.match(refusalOf(made(moduleWith('unreferenced', {type: 'object'}, {defs})), 'unreferenced').message, /more than 100000 schema nodes/);
      assert.match(refusalOf(made(moduleWith('anchor', {$ref: '#thing'})), 'anchor').message, /names no place in schema\.json/);
      assert.match(refusalOf(made(moduleWith('external', {$ref: 'other.json#/x'})), 'external').message, /names no place in schema\.json/);
    });

    it('the load\'s check runs on the schema.json the spec was built from, in a validator', async () => {
      const dir = made(moduleWith('late-bomb', {type: 'object'}));
      const defs = {l0: {type: 'string'}};
      for (let i = 1; i <= 12; i++) defs[`l${i}`] = {anyOf: Array.from({length: 10}, () => ({$ref: `#/defs/l${i - 1}`}))};
      // replaced after an earlier check passed, before the spec is read
      assert.strictEqual(refusalOf(dir, 'late-bomb'), null);
      fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$id: '#/', s: {ping: {input: {$ref: '#/defs/l12'}, output: {type: 'object'}}}, defs}));
      const built = await moduleSpec.build(dir, 'late-bomb');
      const problem = await moduleSpec.safety(built);
      assert.match(problem.reason, /more than 100000 schema nodes/);
    });

    it('a percent-encoded action pointer resolves as before ("#" + pointer, decoded per token), in the validator', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-safety-pct-'));
      dirs.push(dir);
      fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: 'pct', serviceList: {'urn:countinghouse-test:serviceID:s': {
        actionList: [{name: 'ping', input: {schema: '/s/a%20b'}}]}}}}));
      fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$id: '#/', s: {'a b': {type: 'object', properties: {n: {type: 'integer'}}}}}));
      const built = await moduleSpec.build(dir, 'pct');
      assert.strictEqual(await full(built, 'urn:countinghouse-test:serviceID:s', 'ping', {input: {n: 1}}), null);
      assert.strictEqual((await full(built, 'urn:countinghouse-test:serviceID:s', 'ping', {input: {n: 'x'}}))[0].code, 'INPUT_DATA_VALIDATION_FAIL');
    });

    it('%2F in a $ref is decoded as the resolution decodes it (left as it is): a bomb behind it is counted (the reviewer, #152)', () => {
      const defs = {a: {b: {type: 'string'}}, l0: {type: 'string'}};
      for (let i = 1; i <= 12; i++) defs[`l${i}`] = {anyOf: Array.from({length: 10}, () => ({$ref: `#/defs/l${i - 1}`}))};
      defs['a%2Fb'] = {$ref: '#/defs/l12'};
      assert.match(refusalOf(made(moduleWith('pct2f', {$ref: '#/defs/a%2Fb'}, {defs})), 'pct2f').message, /more than 100000 schema nodes/);
    });

    it('$dynamicRef is followed through its $dynamicAnchor: recursion refused; one naming no anchor refused (the reviewer, #152)', () => {
      const tree = {$dynamicAnchor: 'node', type: 'object', properties: {kids: {type: 'array', items: {$dynamicRef: '#node'}}}};
      assert.match(refusalOf(made(moduleWith('dyn', {$ref: '#/$defs/tree'}, {$defs: {tree}})), 'dyn').message, /refers to itself/);
      assert.match(refusalOf(made(moduleWith('dyn-none', {type: 'object', properties: {k: {$dynamicRef: '#nowhere'}}})), 'dyn-none').message, /names no place/);
    });

    it('a $ref into enum or default makes what is there a schema: its pattern is checked (the reviewer, #152)', () => {
      const e = refusalOf(made(moduleWith('into-default', {$ref: '#/$defs/x/default'}, {$defs: {x: {type: 'object', default: {type: 'string', pattern: '(a+)+$'}}}})), 'into-default');
      assert.match(e.message, /\/\$defs\/x\/default\/pattern/);
    });

    it('patternProperties keys and propertyNames patterns are checked; the key is not named', () => {
      const pp = refusalOf(made(moduleWith('pp', {type: 'object', patternProperties: {'^(?:x|y+)*$': {type: 'string'}}})), 'pp');
      assert.strictEqual(pp.code, 'MODULE_ASSEMBLY_FAIL');
      assert.ok(!pp.message.includes('y+'), pp.message);
      const pn = refusalOf(made(moduleWith('pn', {type: 'object', propertyNames: {pattern: '([a-z]*)*'}})), 'pn');
      assert.match(pn.message, /\/s\/ping\/input\/propertyNames\/pattern/);
    });

    it('a pattern over 1000 characters is refused', () => {
      const e = refusalOf(made(moduleWith('long', {type: 'string', pattern: `^${'a'.repeat(1001)}$`})), 'long');
      assert.match(e.message, /longer than 1000 characters/);
    });

    it('the star-height check: nested repetition is refused, single repetition is not', () => {
      const unsafe = ['^(a+)+$', '(a*)*', '(?:a|b+)*', '((ab)+c)+', '(x+){2,}', '(\\d+)+', '(a{1,5})*',
        // JavaScript's [] and [^] are whole classes: what follows them is read (/code-review of 5ae7454)
        '[^](a+)+$', '[](a+)+$',
        // alternatives that start alike in a repeated group
        '^(a|aa)+$', '^(\\d|\\d\\d)+$'];
      const safe = ['^[a-z]+$', '(a|b)+', 'a+b+', '[(a+)]+', '\\(a+\\)+', '(a+)?', '(ab)+', '^\\d{1,3}(?:,\\d{3})?$', '^[0-9a-f]{64}$', '(a){2}',
        '(foo|bar)+', '^([a-z]|-)+$', '[]](a)+'];
      for (const re of unsafe) assert.strictEqual(safety().unsafePattern(re) != null, true, re);
      for (const re of safe) assert.strictEqual(safety().unsafePattern(re), null, re);
    });

    it('a schema.json over 1 MB is refused', () => {
      const big = made(moduleWith('big', {type: 'object'}, {padding: 'x'.repeat(1024 * 1024)}));
      assert.match(refusalOf(big, 'big').message, /schema\.json is larger than 1 MB/);
    });

    it('a $ref expansion bomb is refused before it is expanded, the main heap untouched; a $ref cycle too', () => {
      const defs = {l0: {type: 'string'}};
      for (let i = 1; i <= 12; i++) defs[`l${i}`] = {anyOf: Array.from({length: 10}, () => ({$ref: `#/defs/l${i - 1}`}))};
      const dir = made(moduleWith('bomb', {$ref: '#/defs/l12'}, {defs}));
      const heap = process.memoryUsage().heapUsed;
      const started = Date.now();
      const e = refusalOf(dir, 'bomb');
      assert.match(e.message, /more than 100000 schema nodes/);
      assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
      assert.ok(process.memoryUsage().heapUsed - heap < 50 * 1024 * 1024, 'no expansion');
      const loop = made(moduleWith('loop', {$ref: '#/defs/a'}, {defs: {a: {anyOf: [{$ref: '#/defs/b'}]}, b: {anyOf: [{$ref: '#/defs/a'}]}}}));
      assert.match(refusalOf(loop, 'loop').message, /refers to itself/);
      const shared = made(moduleWith('shared', {$ref: '#/defs/l2'}, {defs: {l0: defs.l0, l1: {anyOf: [{$ref: '#/defs/l0'}, {$ref: '#/defs/l0'}]}, l2: {anyOf: [{$ref: '#/defs/l1'}, {$ref: '#/defs/l1'}]}}}));
      assert.strictEqual(refusalOf(shared, 'shared'), null, 'a modest shared $ref is fine');
    });

    it('a $ref\'d schema validates, in a validator', async () => {
      const dir = made(moduleWith('deref', {$ref: '#/defs/n'}, {defs: {n: {type: 'object', properties: {n: {type: 'integer'}}, required: ['n']}}}));
      const built = await moduleSpec.build(dir, 'deref');
      assert.strictEqual(await full(built, 'urn:countinghouse-test:serviceID:s', 'ping', {input: {n: 1}}), null);
      assert.strictEqual((await full(built, 'urn:countinghouse-test:serviceID:s', 'ping', {input: {n: 'x'}}))[0].code, 'INPUT_DATA_VALIDATION_FAIL');
    });
  });

  // Lean worker step 3, Task 4: a worker's device is registered from the
  // main thread's own copy of its spec once the worker has loaded
  // (DeviceManager's registerFromSpec); the worker announces nothing.
  describe('the device registered from the main thread\'s spec', () => {
    let DeviceManager = null;
    const LOG = require('../../lib/logger');
    let logE = null;
    let logI = null;
    const logged = [];
    before(() => {
      DeviceManager = require('../../lib/device-manager');
      logE = LOG.E;
      logI = LOG.I;
      LOG.E = (e) => { logged.push(String(e && e.message)); return e; };
      LOG.I = () => {};
    });
    after(() => { LOG.E = logE; LOG.I = logI; });
    beforeEach(() => { logged.length = 0; });

    function worker(wmSpec, extra) {
      const wm = new EventEmitter();
      wm.deviceList = {};
      wm.moduleSpec = wmSpec;
      wm.hostModuleName = 'main-checked';
      Object.assign(wm, extra || {});
      const dm = {deviceMap: {}, allDevicesLoaded: true, notifyDeviceLoad: {}, toolsetChanged: () => {},
        moduleManager: {modules: {'main-checked': wm}, clearEndedDevice: () => {}}};
      return {dm, wm};
    }

    it('registered as the main thread\'s own copy, under its own device ID', () => {
      const {dm, wm} = worker(own);
      assert.strictEqual(DeviceManager.prototype.registerFromSpec.call(dm, wm), true);
      assert.strictEqual(dm.deviceMap[own.deviceID], wm);
      assert.strictEqual(wm.deviceList[own.deviceID], own.spec);
      assert.strictEqual(wm.moduleName, 'main-checked');
      assert.deepStrictEqual(logged, []);
    });

    it('nothing a worker states is taken: a deviceonline it sends registers nothing', () => {
      const {dm, wm} = worker(own);
      DeviceManager.prototype.onWorkerLoaded.call(dm, wm);
      wm.emit('deviceonline', {data: {deviceID: own.deviceID, moduleName: 'main-checked', packageInfo: {name: 'main-checked'},
        spec: JSON.parse(own.specText), modulePath: '/app'}}, wm);
      assert.deepStrictEqual(dm.deviceMap, {});
      assert.deepStrictEqual(wm.deviceList, {});
    });

    it('a worker with no main-thread spec, or one that could not be read: not registered', () => {
      for (const missing of [undefined, {error: 'api.json: unreadable'}]) {
        const {dm, wm} = worker(missing);
        assert.strictEqual(DeviceManager.prototype.registerFromSpec.call(dm, wm), false);
        assert.deepStrictEqual(dm.deviceMap, {});
        assert.deepStrictEqual(DeviceManager.prototype.getAllDeviceSpecs.call(dm), {}, 'not listed either');
      }
    });

    it('a spec that fails the device-spec check: logged DEVICE_SPEC_VALIDATION_FAIL with the stage, and not registered', async () => {
      const bad = await moduleSpec.fromParts({device: {friendlyName: 'main-checked', serviceList: {}}}, null);
      const {dm, wm} = worker(bad);
      assert.strictEqual(DeviceManager.prototype.registerFromSpec.call(dm, wm), false);
      assert.deepStrictEqual(dm.deviceMap, {});
      assert.ok(logged.some((l) => /stage=validateDeviceSpec/.test(l) && /manufacturer/.test(l)), logged.join('\n'));
    });

    it('a worker that is going (being unloaded, ended, or replaced): not registered', () => {
      for (const going of [{unloading: true}, {ended: {code: 'MODULE_UNLOADED'}}]) {
        const {dm, wm} = worker(own, going);
        assert.strictEqual(DeviceManager.prototype.registerFromSpec.call(dm, wm), false);
        assert.deepStrictEqual(dm.deviceMap, {});
      }
      const {dm, wm} = worker(own);
      dm.moduleManager.modules['main-checked'] = new EventEmitter();
      assert.strictEqual(DeviceManager.prototype.registerFromSpec.call(dm, wm), false);
      assert.deepStrictEqual(dm.deviceMap, {});
    });
  });
});
