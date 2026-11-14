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

describe('module-loading 23: a module\'s spec and its checks on the main thread', function() {
  // Requiring the device manager loads much of the runtime: 30 s, as 22 has.
  this.timeout(30000);
  let moduleSpec = null;
  let own = null;
  before(async () => {
    require('../../lib/cli-options').setOptions({workerThread: true});
    moduleSpec = require('../../lib/module-spec');
    own = await moduleSpec.build(FIXTURE);
  });
  after(() => {
    require('../../lib/cli-options').setOptions({workerThread: false});
  });

  const check = (serviceID, actionName, args) => moduleSpec.checkInput(own, own.deviceID, serviceID, actionName, args);
  // [code, message, data] of a refusal
  const answer = (checked) => [checked.refused[0].code, checked.refused[0].message, checked.refused[1]];

  it('is built from the module\'s files: its device ID, spec and one compiled validator per schema', () => {
    assert.strictEqual(own.error, undefined);
    assert.strictEqual(own.deviceID, require('../../lib/call-address').deviceIDForName('main-checked'));
    const take = own.services[SERVICE].actions.take;
    assert.strictEqual(typeof(take.input.validator), 'function');
    assert.strictEqual(typeof(take.output.validator), 'function');
    assert.strictEqual(own.specText, JSON.stringify(own.spec));
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

  it('each build has its own validators: an absolute $id builds again at the next start, and in another module', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-main-spec-id-'));
    try {
      for (const name of ['id-one', 'id-two']) {
        const m = path.join(dir, name);
        fs.mkdirSync(m);
        fs.writeFileSync(path.join(m, 'api.json'), JSON.stringify({device: {friendlyName: name, serviceList: {'urn:countinghouse-test:serviceID:s': {
          actionList: [{name: 'a', input: {schema: '/s/a/input'}}]}}}}));
        fs.writeFileSync(path.join(m, 'schema.json'), JSON.stringify({$id: '#/', s: {a: {input: {$id: 'https://example.invalid/same', type: 'object'}}}}));
      }
      const builds = [await moduleSpec.build(path.join(dir, 'id-one')), await moduleSpec.build(path.join(dir, 'id-one')), await moduleSpec.build(path.join(dir, 'id-two'))];
      for (const b of builds) {
        assert.strictEqual(typeof(b.services['urn:countinghouse-test:serviceID:s'].actions.a.input.validator), 'function', JSON.stringify(b.error));
      }
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('checks in a worker\'s order: the service, the action, an input at all, then the input', () => {
    const bad = {input: {n: 'x'}};
    assert.deepStrictEqual(answer(check('urn:countinghouse-test:serviceID:nowhere', 'take', bad)).slice(0, 1), ['SERVICE_NOT_FOUND']);
    assert.deepStrictEqual(answer(check(SERVICE, 'nowhere', bad)).slice(0, 1), ['ACTION_NOT_FOUND']);
    const none = answer(check(SERVICE, 'take', null));
    assert.deepStrictEqual([none[0], none[2]], ['INPUT_NOT_FOUND', null]);
    const refused = answer(check(SERVICE, 'take', bad));
    assert.strictEqual(refused[0], 'INPUT_DATA_VALIDATION_FAIL');
    assert.deepStrictEqual(refused[2], {reason: 'data validation failed',
      info: {dataPath: '/n', schemaPath: '#/properties/n/type', validatorMessage: 'must be integer'}});
    assert.deepStrictEqual(answer(check(SERVICE, 'take', {input: {n: 1}, more: 1}))[2],
      {reason: 'unexpected input argument: more', info: ''});
  });

  it('a refusal is the error a worker\'s reply carries: a plain Error with its code', () => {
    const err = check(SERVICE, 'take', {input: {n: 'x'}}).refused[0];
    const {CountinghouseError} = require('../../lib/countinghouse-error');
    const viaReply = CountinghouseError.fromReplyFields(CountinghouseError.replyFields(new CountinghouseError('INPUT_DATA_VALIDATION_FAIL')));
    assert.strictEqual(Object.getPrototypeOf(err), Object.getPrototypeOf(viaReply));
    assert.deepStrictEqual([err.code, err.message], [viaReply.code, viaReply.message]);
  });

  it('a valid input passes, and its output is checked on the reply', () => {
    const checked = check(SERVICE, 'give', {input: {kind: 'good'}, ctx: {}, usageCall: 3});
    assert.strictEqual(checked.refused, undefined);
    assert.strictEqual(moduleSpec.checkOutput(checked, {output: {v: 'a'}}), null);
    const refused = moduleSpec.checkOutput(checked, {output: {v: 1}});
    assert.strictEqual(refused[0].code, 'OUTPUT_DATA_VALIDATION_FAIL');
    assert.strictEqual(refused[1].reason, 'data validation failed');
    assert.deepStrictEqual(moduleSpec.checkOutput(checked, {output: {v: 'a'}, extra: 1})[1], {reason: 'unexpected output argument: extra', info: ''});
    assert.strictEqual(moduleSpec.checkOutput(checked, undefined)[0].code, 'MISSING_OUTPUT_ARGUMENT');
  });

  it('leaves to the worker only a device it has no spec for', () => {
    assert.strictEqual(moduleSpec.checkInput(null, own.deviceID, SERVICE, 'take', {input: {n: 'x'}}), null);
    assert.strictEqual(moduleSpec.checkInput(own, 'another-device', SERVICE, 'take', {input: {n: 'x'}}), null);
  });

  it('a name only Object.prototype has is not found: the service, or the action', () => {
    const bad = {input: {n: 'x'}};
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.deepStrictEqual(answer(check(name, 'take', bad)).slice(0, 1), ['SERVICE_NOT_FOUND'], `service ${name}`);
      assert.deepStrictEqual(answer(check(SERVICE, name, bad)).slice(0, 1), ['ACTION_NOT_FOUND'], `action ${name}`);
      assert.deepStrictEqual(answer(check(SERVICE, name, null)).slice(0, 1), ['ACTION_NOT_FOUND'], `action ${name}, no input`);
    }
  });

  it('an action the module declares under an Object.prototype name is its own: on the main thread and in the device a worker builds', async () => {
    const NAMES = ['toString', 'constructor', '__proto__', 'valueOf'];
    const spec = {device: {friendlyName: 'proto-named', serviceList: {'urn:countinghouse-test:serviceID:toString': {actionList: NAMES.map((name) => ({name: name,
      input: {schema: '/s/in'}}))}}}};
    const ownSpec = await moduleSpec.fromParts(JSON.parse(JSON.stringify(spec)), {$id: '#/', s: {in: {type: 'object', properties: {n: {type: 'integer'}}}}});
    const at = (actionName, args) => moduleSpec.checkInput(ownSpec, ownSpec.deviceID, 'urn:countinghouse-test:serviceID:toString', actionName, args);
    for (const name of NAMES) {
      assert.strictEqual(at(name, {input: {n: 1}}).refused, undefined, `${name} is declared`);
      assert.strictEqual(at(name, {input: {n: 'x'}}).refused[0].code, 'INPUT_DATA_VALIDATION_FAIL', `${name}'s input is checked`);
    }
    assert.strictEqual(at('hasOwnProperty', {input: {}}).refused[0].code, 'ACTION_NOT_FOUND');
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

    it('the main thread\'s spec build checks the schema.json it reads, not only the load\'s earlier read', async () => {
      const dir = made(moduleWith('late-bomb', {type: 'object'}));
      const defs = {l0: {type: 'string'}};
      for (let i = 1; i <= 12; i++) defs[`l${i}`] = {anyOf: Array.from({length: 10}, () => ({$ref: `#/defs/l${i - 1}`}))};
      // replaced after a check passed, before the build reads it
      assert.strictEqual(refusalOf(dir, 'late-bomb'), null);
      fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$id: '#/', s: {ping: {input: {$ref: '#/defs/l12'}, output: {type: 'object'}}}, defs}));
      const built = await moduleSpec.build(dir);
      assert.match(String(built.error), /stage=schemaSafety/);
    });

    it('a percent-encoded action pointer resolves as before ("#" + pointer, decoded)', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-safety-pct-'));
      dirs.push(dir);
      fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: 'pct', serviceList: {'urn:countinghouse-test:serviceID:s': {
        actionList: [{name: 'ping', input: {schema: '/s/a%20b'}}]}}}}));
      fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$id: '#/', s: {'a b': {type: 'object', properties: {n: {type: 'integer'}}}}}));
      const built = await moduleSpec.build(dir);
      const at = (input) => moduleSpec.checkInput(built, built.deviceID, 'urn:countinghouse-test:serviceID:s', 'ping', {input});
      assert.strictEqual(at({n: 1}).refused, undefined);
      assert.strictEqual(at({n: 'x'}).refused[0].code, 'INPUT_DATA_VALIDATION_FAIL');
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

    it('the main thread\'s spec build dereferences the document once, and its validators still work', async () => {
      const dir = made(moduleWith('deref', {$ref: '#/defs/n'}, {defs: {n: {type: 'object', properties: {n: {type: 'integer'}}, required: ['n']}}}));
      const built = await moduleSpec.build(dir);
      const checked = (input) => moduleSpec.checkInput(built, built.deviceID, 'urn:countinghouse-test:serviceID:s', 'ping', {input});
      assert.strictEqual(checked({n: 1}).refused, undefined);
      assert.strictEqual(checked({n: 'x'}).refused[0].code, 'INPUT_DATA_VALIDATION_FAIL');
    });
  });

  describe('the device a worker announces', () => {
    let DeviceManager = null;
    const LOG = require('../../lib/logger');
    let logE = null;
    const logged = [];
    before(() => {
      DeviceManager = require('../../lib/device-manager');
      logE = LOG.E;
      LOG.E = (e) => { logged.push(String(e && e.message)); return e; };
    });
    after(() => { LOG.E = logE; });
    beforeEach(() => { logged.length = 0; });

    function announce(wmSpec, deviceID, spec) {
      const wm = new EventEmitter();
      wm.deviceList = {};
      wm.moduleSpec = wmSpec;
      const dm = {deviceMap: {}, allDevicesLoaded: true, notifyDeviceLoad: {}, toolsetChanged: () => {},
        moduleManager: {modules: {'main-checked': wm}, clearEndedDevice: () => {}}};
      DeviceManager.prototype.onWorkerLoaded.call(dm, wm);
      wm.emit('deviceonline', {data: {deviceID: deviceID, moduleName: 'main-checked', packageInfo: {name: 'main-checked'},
        spec: spec, modulePath: '/app'}}, wm);
      return {dm, wm};
    }
    const notRegistered = 'module: main-checked: its worker announced a device that does not match its api.json as the main thread read it; not registered';

    it('exactly its spec: registered, as the main thread\'s own copy', () => {
      const announced = JSON.parse(own.specText);
      const {dm, wm} = announce(own, own.deviceID, announced);
      assert.strictEqual(dm.deviceMap[own.deviceID], wm);
      assert.strictEqual(wm.deviceList[own.deviceID], own.spec);
      assert.deepStrictEqual(logged, []);
    });

    it('a spec changed in the worker: not registered', () => {
      const announced = JSON.parse(own.specText);
      delete announced.device.serviceList[SERVICE].actionList[0].output;
      const {dm, wm} = announce(own, own.deviceID, announced);
      assert.deepStrictEqual(dm.deviceMap, {});
      assert.deepStrictEqual(wm.deviceList, {});
      assert.deepStrictEqual(DeviceManager.prototype.getAllDeviceSpecs.call(dm), {}, 'not listed either');
      assert.deepStrictEqual(logged, [notRegistered]);
    });

    it('another device ID: not registered', () => {
      const {dm} = announce(own, 'another-device', JSON.parse(own.specText));
      assert.deepStrictEqual(dm.deviceMap, {});
      assert.deepStrictEqual(logged, [notRegistered]);
    });

    it('a worker with no main-thread spec: not registered', () => {
      const {dm} = announce(undefined, own.deviceID, JSON.parse(own.specText));
      assert.deepStrictEqual(dm.deviceMap, {});
      assert.deepStrictEqual(logged, [notRegistered]);
    });
  });
});
