// Lean worker step 3, Task 2: the dispatcher a lean worker answers invokes
// with. It requires a module's handlers/<service>/<action>.js files and runs
// a handler with a ctx from handler-ctx, answering as lib/service.js does
// (lib/handler-answer.js, shared), without a CHDevice, a Service or the
// validator. Server-free.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../../lib/cli-options').setOptions({workerThread: false});

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'lean-answers');
const SERVICE = 'urn:countinghouse-test:serviceID:answerService';

describe('module-loading 25: the lean dispatcher (lean worker step 3)', () => {
  // required where used, so each case fails on its own before it exists
  const dispatcher = () => require('../../lib/lean-dispatcher').createDispatcher({
    modulePath: FIXTURE, moduleName: 'lean-answers', spec: JSON.parse(fs.readFileSync(path.join(FIXTURE, 'api.json'), 'utf8'))});
  const invoke = (d, serviceID, actionName, args) => new Promise((resolve) => d.invoke(serviceID, actionName, args, true, (err, data) => resolve({err, data})));

  it('answers a handler\'s output, and lists the actions it serves', async () => {
    const d = dispatcher();
    assert.deepStrictEqual([...d.names].sort(), [`${SERVICE}|fails`, `${SERVICE}|fn`, `${SERVICE}|ok`, `${SERVICE}|throws`]);
    const {err, data} = await invoke(d, SERVICE, 'ok', {input: {v: 7}});
    assert.strictEqual(err, null);
    assert.deepStrictEqual(data, {output: {v: 7}});
  });

  it('a service or action it does not have: SERVICE_NOT_FOUND, ACTION_NOT_FOUND', async () => {
    const d = dispatcher();
    assert.strictEqual((await invoke(d, 'urn:x:serviceID:none', 'ok', {input: {}})).err.code, 'SERVICE_NOT_FOUND');
    assert.strictEqual((await invoke(d, SERVICE, 'none', {input: {}})).err.code, 'ACTION_NOT_FOUND');
  });

  it('a handler that throws: DEVICE_INVOKE_EXCEPTION with its message in the fault; a callback failure: DEVICE_INVOKE_FAIL', async () => {
    const d = dispatcher();
    const thrown = await invoke(d, SERVICE, 'throws', {input: {}});
    assert.strictEqual(thrown.err.code, 'DEVICE_INVOKE_EXCEPTION');
    assert.strictEqual(thrown.data.message, 'boom');
    assert.strictEqual((await invoke(d, SERVICE, 'fails', {input: {}})).err.code, 'DEVICE_INVOKE_FAIL');
  });

  // as lib/service.js answered it, checked call or not (test/unit/test020)
  it('a handler whose output is a function: OUTPUT_DATA_VALIDATION_FAIL, even for a call the main thread checked', async () => {
    const d = dispatcher();
    const r = await invoke(d, SERVICE, 'fn', {input: {}});
    assert.strictEqual(r.err.code, 'OUTPUT_DATA_VALIDATION_FAIL');
    assert.deepStrictEqual(r.data, {reason: 'output argument not found', info: ''});
  });

  it('loads no CHDevice, Service or validator', () => {
    dispatcher();
    const loaded = Object.keys(require.cache).map((k) => path.basename(k));
    // other tests in this run may have loaded them; the dispatcher's own
    // requires are what count: checked by the module's source
    const src = fs.readFileSync(require.resolve('../../lib/lean-dispatcher'), 'utf8');
    for (const file of ['./countinghouse-device', './service', './validator', './handler-map-module']) {
      assert.ok(!src.includes(`require('${file}')`), `the dispatcher requires ${file}`);
    }
    assert.ok(loaded.length > 0);
  });
});
