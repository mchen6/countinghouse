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

  it('leaves to the worker what it has no spec for: another device, or a name only Object.prototype has', () => {
    assert.strictEqual(moduleSpec.checkInput(null, own.deviceID, SERVICE, 'take', {input: {n: 'x'}}), null);
    assert.strictEqual(moduleSpec.checkInput(own, 'another-device', SERVICE, 'take', {input: {n: 'x'}}), null);
    assert.strictEqual(check('toString', 'take', {input: {n: 'x'}}), null);
    assert.strictEqual(check(SERVICE, 'constructor', {input: {n: 'x'}}), null);
    assert.strictEqual(check('__proto__', 'take', {input: {n: 'x'}}), null);
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
      const dm = {deviceMap: {}, allDevicesLoaded: true, notifyDeviceLoad: {},
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
