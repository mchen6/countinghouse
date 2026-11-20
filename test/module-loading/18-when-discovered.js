// whenDiscovered (lib/module-manager.js), server-free: discovery ends when this
// discovery's devices are reported, never on a device an earlier discovery
// reported, and the 5 s hold stays the cap for a module that never reports
// (its device failed at construction) (review of 84cd6bd, 2026-11-12). Every
// module brings its device online at once on discover (the one module
// format), on a reload too.
const assert = require('assert');
const path = require('path');
const {EventEmitter} = require('events');
require('../../lib/cli-options').setOptions({workerThread: false});
const ModuleManager = require('../../lib/module-manager');

function handlerMapLike() { return new EventEmitter(); }
const settle = () => new Promise((r) => setImmediate(r));

// Timing (reviewer, 2026-11-12: 1 failure in 5 runs at load 2): each case
// waits on the events it checks, not on wall-clock margins. The cap is a
// timer, measured on the monotonic clock, with a margin over it that holds
// on a loaded machine; instantiating a fixture loads files, so the whole
// describe has 30 s, not mocha's 2.
describe('module-loading 18: whenDiscovered', function() {
  this.timeout(30000);

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
    // Nothing but a new report could end it: a few turns of the loop, no clock.
    for (let i = 0; i < 5; i++) await settle();
    assert.strictEqual(done, 0);
    a.emit('devicereported', {});
    await settle();
    assert.strictEqual(done, 1);
  });

  it('a module that never reports (its device failed) is ended by the hold, the cap', function(done) {
    this.timeout(ModuleManager.DISCOVERY_HOLD_MS + 20000);
    const {performance} = require('perf_hooks');
    const a = handlerMapLike();
    const failed = handlerMapLike();
    const start = performance.now();
    ModuleManager.whenDiscovered({a, failed}, () => {
      // A timer never fires early on the monotonic clock; 5 ms for rounding.
      const ms = performance.now() - start;
      try { assert.ok(ms >= ModuleManager.DISCOVERY_HOLD_MS - 5, `ended after ${ms} ms`); done(); } catch (e) { done(e); }
    });
    a.emit('devicereported', {});
  });

  it('an instantiated module brings its one device online at once on discover, so a reload discovers at once too', () => {
    const mm = Object.create(ModuleManager.prototype);
    const made = mm.instantiateModule(path.join(__dirname, '..', 'fixtures', 'usage-scenario'), 'usage-scenario');
    let online = 0;
    made.instance.on('deviceonline', () => { online++; });
    made.instance.emit('discover');
    assert.strictEqual(online, 1);
  });
});
