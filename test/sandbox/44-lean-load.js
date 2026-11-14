// Lean worker step 3, Task 3: the lean worker entry (lib/lean-worker.js),
// driven over its own message port as the main thread drives it, with no
// server: set-options, then load-module answers once every handler file is
// required ({loaded: true, names}), an invoke the main thread checked is
// answered by the dispatcher, and a handler file that throws while it is
// required fails the load with LOAD_MODULE_FAIL naming that file (Review
// Focus 2; the main thread ends such a worker, ModuleManager's
// loadModuleByWorker, checked end to end in Task 4).
const assert = require('assert');
const path = require('path');
const {Worker} = require('worker_threads');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const SERVICE = 'urn:countinghouse-test:serviceID:answerService';

function start() {
  const worker = new Worker(path.join(ROOT, 'lib', 'lean-worker.js'));
  const pending = new Map();
  let id = 0;
  worker.on('message', (m) => {
    if (m != null && m.category === 'reply' && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (command, fields) => new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve);
    worker.postMessage(Object.assign({command: command, id: id}, fields));
  });
  return {worker, send};
}

describe('sandbox 44: the lean worker loads a module and answers (lean worker step 3)', function() {
  this.timeout(20000);
  let w = null;
  afterEach(async () => { if (w != null) await w.worker.terminate(); w = null; });

  it('load-module answers {loaded, names} once the handlers are required; a checked invoke is answered by the dispatcher', async () => {
    w = start();
    const opts = await w.send('set-options', {options: {}, sandbox: null});
    assert.strictEqual(opts.errMsg, null, JSON.stringify(opts));
    const loaded = await w.send('load-module', {path: path.join(FIXTURES, 'lean-answers'), name: 'lean-answers', version: '1.0.0', deviceConfig: null});
    assert.strictEqual(loaded.errMsg, null, JSON.stringify(loaded));
    assert.strictEqual(loaded.data.loaded, true);
    assert.deepStrictEqual([...loaded.data.names].sort(), [`${SERVICE}|fails`, `${SERVICE}|fn`, `${SERVICE}|ok`, `${SERVICE}|throws`]);
    const out = await w.send('invoke-action', {deviceID: loaded.data.deviceID, serviceID: SERVICE, actionName: 'ok', args: {input: {v: 3}}, mainChecked: true});
    assert.strictEqual(out.errMsg, null, JSON.stringify(out));
    assert.deepStrictEqual(out.data, {output: {v: 3}});
    const thrown = await w.send('invoke-action', {deviceID: loaded.data.deviceID, serviceID: SERVICE, actionName: 'throws', args: {input: {}}, mainChecked: true});
    assert.strictEqual(thrown.errCode, 'DEVICE_INVOKE_EXCEPTION', JSON.stringify(thrown));
  });

  it('a handler file that throws while it is required: LOAD_MODULE_FAIL naming the file, and its error', async () => {
    w = start();
    await w.send('set-options', {options: {}, sandbox: null});
    const r = await w.send('load-module', {path: path.join(FIXTURES, 'lean-load-throws'), name: 'lean-load-throws', version: '1.0.0', deviceConfig: null});
    assert.strictEqual(r.errCode, 'LOAD_MODULE_FAIL', JSON.stringify(r));
    assert.match(r.errMsg, /handlers\/pingService\/ping\.js/);
    assert.match(r.errMsg, /boom at load/);
  });

  it('a worker runs one module: a second load-module is refused', async () => {
    w = start();
    await w.send('set-options', {options: {}, sandbox: null});
    await w.send('load-module', {path: path.join(FIXTURES, 'lean-answers'), name: 'lean-answers', version: '1.0.0', deviceConfig: null});
    const again = await w.send('load-module', {path: path.join(FIXTURES, 'lean-load-throws'), name: 'lean-load-throws', version: '1.0.0', deviceConfig: null});
    assert.strictEqual(again.errCode, 'LOAD_MODULE_FAIL', JSON.stringify(again));
    assert.match(again.errMsg, /a worker runs one module/);
  });
});
