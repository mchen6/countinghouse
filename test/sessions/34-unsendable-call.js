// The review of #416 (a session worker's call that never answers): a call
// whose post to its worker throws (an argument that can't be cloned) is
// answered once, by the main thread, on both of sendCounted's paths -- the
// synchronous one (no spec to check its input) and the one after its input's
// validation -- and a task run's token and in-flight count are given back,
// so nothing holds its worker's pool slot. Driven directly: fake workers
// whose post throws, as a DataCloneError does.
const assert = require('assert');
const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'lib');

describe('sessions 34: a call that cannot be sent to its worker is answered once, holding nothing', () => {
  let DeviceManager, callTokens, moduleSpec, LOG;
  let realValidate, realE;
  const logged = [];
  before(() => {
    require(path.join(LIB, 'cli-options')).setOptions({workerThread: true});
    LOG = require(path.join(LIB, 'logger'));
    LOG.createLogger();
    DeviceManager = require(path.join(LIB, 'device-manager'));
    callTokens = require(path.join(LIB, 'call-tokens'));
    moduleSpec = require(path.join(LIB, 'module-spec'));
    realValidate = moduleSpec.validate;
    realE = LOG.E;
    LOG.E = (e) => logged.push(String(e && e.message));
  });
  after(() => {
    moduleSpec.validate = realValidate;
    LOG.E = realE;
    require(path.join(LIB, 'cli-options')).setOptions({});
  });
  afterEach(() => { moduleSpec.validate = realValidate; });

  const cloneError = () => Object.assign(new Error('could not be cloned'), {name: 'DataCloneError'});
  // a worker whose post throws; with spec, a call to d1 svc/act has its
  // input checked (the asynchronous path), else it is sent at once
  const device = (workerId, withSpec) => Object.assign({workerId: workerId, sendInvokeActionMessage: () => { throw cloneError(); }},
    withSpec ? {moduleSpec: {deviceID: 'd1', key: 'k', names: {svc: new Set(['act'])}}} : {});
  const tick = () => new Promise((r) => setImmediate(r));

  for (const [label, withSpec] of [['sent at once (no spec)', false], ['sent after its input is checked', true]]) {
    it(`a task run ${label}: answered once with an error; its token dropped, its count back to 0`, async() => {
      if (withSpec) moduleSpec.validate = () => Promise.resolve(null);
      const workerId = withSpec ? 3402 : 3401;
      const dev = device(workerId, withSpec);
      const answers = [];
      DeviceManager.prototype.invokeJobs.call({}, dev, 'd1', 'svc', 'act', {}, 'j1', (err) => answers.push(err && err.code), {ownerKey: 'k', timeoutMs: null});
      for (let i = 0; i < 5; i++) await tick();
      assert.strictEqual(answers.length, 1, JSON.stringify(answers));
      assert.ok(/DEVICE_ACTION_CALL_FAIL|DEVICE_INVOKE_EXCEPTION/.test(answers[0]), answers[0]);
      assert.strictEqual(callTokens.liveFor(workerId), 0, 'the run\'s token (no timeout: an endless ttl) is gone');
      assert.strictEqual(dev.jobsInFlight.size, 0, 'no run counted in flight');
    });
  }

  it('a client call sent after its input is checked: answered once, never an unhandled rejection', async() => {
    moduleSpec.validate = () => Promise.resolve(null);
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const answers = [];
      const session = {sessionId: null, deadline: Date.now() + 60000, appKey: null,
        callback(err) { answers.push(err && err.code); },
        setDeviceTimer(d, fn) { fn.call(this, null, d, null); }};
      DeviceManager.prototype.invokeAction.call({}, device(3403, true), 'd1', 'svc', 'act', {input: {}}, session);
      for (let i = 0; i < 5; i++) await tick();
      assert.deepStrictEqual(answers, ['DEVICE_INVOKE_EXCEPTION']);
      assert.deepStrictEqual(unhandled, []);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});
