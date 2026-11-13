// whenDiscovered (lib/module-manager.js), server-free: discovery ends when this
// discovery's devices are reported, never on a device an earlier discovery
// reported, and the 5 s hold stays the cap for a discovery-style module
// (review of 84cd6bd, 2026-11-12). The flag is set where every handler-map
// instance is made, so a reload discovers at once too.
const assert = require('assert');
const path = require('path');
const {EventEmitter} = require('events');
require('../../lib/cli-options').setOptions({workerThread: false});
const ModuleManager = require('../../lib/module-manager');

function handlerMapLike() { const m = new EventEmitter(); m.discoversAtOnce = true; return m; }
const settle = () => new Promise((r) => setImmediate(r));

describe('module-loading 18: whenDiscovered', () => {
  it('ends once every module has reported a device after it started listening', async () => {
    const a = handlerMapLike();
    const b = handlerMapLike();
    let done = 0;
    ModuleManager.whenDiscovered({a, b}, () => { done++; });
    a.emit('devicereported', {});
    await settle();
    assert.strictEqual(done, 0, 'b has not reported');
    b.emit('devicereported', {});
    await settle();
    assert.strictEqual(done, 1);
    a.emit('devicereported', {});
    await settle();
    assert.strictEqual(done, 1, 'done is called once');
    assert.strictEqual(a.listenerCount('devicereported') + b.listenerCount('devicereported'), 0, 'its listeners are removed');
  });

  it('a device reported by an earlier discovery does not end this one', async () => {
    const a = handlerMapLike();
    a.emit('devicereported', {});            // the earlier discovery's device
    let done = 0;
    ModuleManager.whenDiscovered({a}, () => { done++; });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(done, 0);
    a.emit('devicereported', {});
    await settle();
    assert.strictEqual(done, 1);
  });

  it('a discovery-style module keeps the hold as the cap, even if it reports at once', function(done) {
    this.timeout(ModuleManager.DISCOVERY_HOLD_MS + 3000);
    const legacy = new EventEmitter();
    const start = Date.now();
    ModuleManager.whenDiscovered({a: handlerMapLike(), legacy}, () => {
      const ms = Date.now() - start;
      try { assert.ok(ms >= ModuleManager.DISCOVERY_HOLD_MS - 50, `ended after ${ms} ms`); done(); } catch (e) { done(e); }
    });
    legacy.emit('devicereported', {});
  });

  it('every handler-map instance is marked, so a reload discovers at once too', () => {
    const mm = Object.create(ModuleManager.prototype);
    const made = mm.instantiateModule(path.join(__dirname, '..', 'fixtures', 'usage-scenario'), 'usage-scenario');
    assert.strictEqual(made.isHandlerMap, true);
    assert.strictEqual(made.instance.discoversAtOnce, true);
  });
});
