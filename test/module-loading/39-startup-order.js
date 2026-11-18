'use strict';
// The startup levers' (2): the startup list's modules load several at once
// under --workerThread (at most max(2, min(4, CPUs - 1))), and each is still
// handed on to registration in the list's order, so what every reader of the
// device map sees is what a one-at-a-time start gave (tools/list and its
// deduped names, a deviceID's first holder). Server-free: the order itself
// (lib/startup-order.js), and loadAllModules with its loads stubbed, finishing
// in reverse. The spawned start is session-runtime 12.
const assert = require('assert');
const os = require('os');
const options = require('../../lib/cli-options');
const LOG = require('../../lib/logger');
LOG.createLogger();

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('module-loading 39: startup loads several at once, registered in the list\'s order', function() {
  this.timeout(30000);
  let StartupOrder = null;
  before(() => { ({StartupOrder} = require('../../lib/startup-order')); });

  describe('the order', () => {
    it('hands on in the list\'s order, whatever order the loads report in', () => {
      const o = new StartupOrder(['a', 'b', 'c', 'd']);
      const out = [];
      o.inTurn('d', () => out.push('d'));
      o.inTurn('b', () => out.push('b'));
      assert.deepStrictEqual(out, [], 'a has not reported');
      o.inTurn('a', () => out.push('a'));
      assert.deepStrictEqual(out, ['a', 'b'], 'a, then b, which waited; d waits for c');
      o.inTurn('c', () => out.push('c'));
      assert.deepStrictEqual(out, ['a', 'b', 'c', 'd']);
      assert.strictEqual(o.done(), true);
    });

    it('a load that ends without being handed on (it failed) passes its turn', () => {
      const o = new StartupOrder(['a', 'b', 'c']);
      const out = [];
      o.inTurn('c', () => out.push('c'));
      o.inTurn('b', () => out.push('b'));
      o.finished('a');
      assert.deepStrictEqual(out, ['b', 'c']);
    });

    it('finished() after its own hand-on changes nothing; it never drops one that waits', () => {
      const o = new StartupOrder(['a', 'b']);
      const out = [];
      o.inTurn('b', () => out.push('b'));
      o.finished('b');                // b's load answered before a's turn came
      assert.deepStrictEqual(out, [], 'b still waits for a');
      o.inTurn('a', () => out.push('a'));
      o.finished('a');
      assert.deepStrictEqual(out, ['a', 'b']);
    });

    it('a hand-on in its turn is told so (fn(true)); one at once is not', () => {
      const o = new StartupOrder(['a', 'b']);
      const told = [];
      o.inTurn('b', (inOrder) => told.push(['b', inOrder]));
      o.inTurn('a', (inOrder) => told.push(['a', inOrder]));
      o.inTurn('x', (inOrder) => told.push(['x', inOrder]));
      assert.deepStrictEqual(told, [['a', true], ['b', true], ['x', undefined]]);
    });

    it('a second hand-on for a waiting name (a restart before its turn) replaces the first', () => {
      const o = new StartupOrder(['a', 'b']);
      const out = [];
      o.inTurn('b', () => out.push('b first'));
      o.inTurn('b', () => out.push('b again'));
      o.inTurn('a', () => out.push('a'));
      assert.deepStrictEqual(out, ['a', 'b again']);
    });

    it('a name not in the list, or one whose turn has passed (a restart), runs at once', () => {
      const o = new StartupOrder(['a', 'b']);
      const out = [];
      o.inTurn('x', () => out.push('x'));
      o.finished('a');
      o.inTurn('a', () => out.push('a again'));
      assert.deepStrictEqual(out, ['x', 'a again']);
    });
  });

  describe('loadAllModules', () => {
    let ModuleManager = null;
    let saved = null;
    before(() => {
      saved = {workerThread: options.workerThread, localModulePath: options.localModulePath, registry: options.moduleRegistry};
      ModuleManager = require('../../lib/module-manager');
    });
    after(() => {
      options.workerThread = saved.workerThread;
      if (saved.localModulePath === undefined) delete options.localModulePath; else options.localModulePath = saved.localModulePath;
      options.moduleRegistry = saved.registry;
    });

    // a manager whose startup list is `names` and whose loads are stubbed:
    // module i takes (n - i) * 15 ms, so they finish in reverse; `fails`
    // ends with an error, never loaded; `unloadedWhileWaiting` is taken off
    // (as a crash or an operator unload does) while it waits for its turn.
    // A load ends as the worker path's does: 'moduleload' (onModuleLoad, which
    // registers the module at once), then the answer. Registration of its
    // devices ('registerdevices') is what waits for the list's order.
    // -> what it recorded.
    async function start(names, {fails = null, unloadedWhileWaiting = null, workerThread = true} = {}) {
      options.workerThread = workerThread;
      options.localModulePath = names.map((n) => `/modules/${n}`);
      options.moduleRegistry = false;
      const mm = new ModuleManager();
      // single-thread mode's onModuleLoad waits on a real discovery; only the
      // concurrency is checked there
      if (workerThread !== true) mm.removeAllListeners('moduleload');
      const rec = {inFlight: 0, max: 0, registered: [], discovered: 0, inMapAtOnce: []};
      mm.on('registerdevices', (module) => rec.registered.push(module.name));
      mm.on('allmodulediscovered', () => { rec.discovered += 1; });
      mm.getModuleInfoFromPath = () => names.map((n) => ({path: `/modules/${n}`, name: n, version: '1.0.0'}));
      mm.loadModuleFromPath = (p, name, version, cb) => {
        rec.inFlight += 1;
        rec.max = Math.max(rec.max, rec.inFlight);
        setTimeout(() => {
          rec.inFlight -= 1;
          if (name === fails) return cb(new Error(`${name} failed`));
          const module = {name};
          mm.emit('moduleload', name, module, version);
          // in the module map at once, whatever its turn: an exit handler's
          // isCurrent(), unload and reload all see it
          if (mm.modules[name] === module) rec.inMapAtOnce.push(name);
          if (name === unloadedWhileWaiting) delete mm.modules[name];
          return cb(null, module);
        }, (names.length - names.indexOf(name)) * 15);
      };
      mm.loadAllModules();
      for (let i = 0; i < 200 && rec.discovered === 0; i++) await tick();
      await tick(50);
      return rec;
    }
    const limit = Math.max(2, Math.min(4, os.cpus().length - 1));

    it(`at most ${limit} at once, more than one, and registered in the list's order though they finish in reverse`, async () => {
      const names = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
      const rec = await start(names);
      assert.strictEqual(rec.max, limit, `${rec.max} at once`);
      assert.deepStrictEqual(rec.registered, names);
      assert.strictEqual(rec.discovered, 1, 'discovery ends once');
    });

    it('a loaded module is in the module map at once, though its devices wait for its turn', async () => {
      const names = ['m1', 'm2', 'm3', 'm4'];
      const rec = await start(names);
      assert.deepStrictEqual(rec.inMapAtOnce.slice().sort(), names);
    });

    it('one taken off while it waits (a crash, an unload): not registered, the rest are, discovery still ends', async () => {
      const rec = await start(['m1', 'm2', 'm3', 'm4'], {unloadedWhileWaiting: 'm3'});
      assert.deepStrictEqual(rec.registered, ['m1', 'm2', 'm4']);
      assert.strictEqual(rec.discovered, 1);
    });

    it('one failing mid-way: the others are registered, in order', async () => {
      const rec = await start(['m1', 'm2', 'm3', 'm4'], {fails: 'm2'});
      assert.deepStrictEqual(rec.registered, ['m1', 'm3', 'm4']);
      assert.strictEqual(rec.discovered, 1);
    });

    it('--no-workerThread: one at a time, as before', async () => {
      const rec = await start(['m1', 'm2', 'm3'], {workerThread: false});
      assert.strictEqual(rec.max, 1);
    });

    it('the same name twice in the list: one at a time (no order to keep between two loads of one module)', async () => {
      const rec = await start(['m1', 'm2', 'm1']);
      assert.strictEqual(rec.max, 1);
    });
  });
});
