'use strict';
// A unit loaded in place (lib/packs-in-place.js) is verified as a whole:
// while it is in progress its modules' loads re-run no discovery, so no
// composition pass sees part of it; a load that is not part of it
// runs its own, as before. The unit waits for each module it loaded to have
// its registration's outcome, registered or refused, in worker mode and in
// single-thread mode alike, and fails loudly if one has none at the bound.
// Server-free: the loads are emitted by hand (ModuleManager's
// 'moduleload', as a worker's acknowledgement or a single-thread load does).
const assert = require('assert');
const EventEmitter = require('events');
const options = require('../../lib/cli-options');
const LOG = require('../../lib/logger');
LOG.createLogger();

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('module-loading 43: a unit in place re-runs no discovery until it is whole', function() {
  this.timeout(30000);
  let ModuleManager = null;
  let packs = null;
  let saved = null;
  before(() => {
    saved = {workerThread: options.workerThread};
    ModuleManager = require('../../lib/module-manager');
    packs = require('../../lib/packs-in-place');
  });
  after(() => { options.workerThread = saved.workerThread; });

  // a manager past its start (nothing on its list), counting discovery passes
  function manager(workerThread = true) {
    options.workerThread = workerThread;
    const mm = new ModuleManager();
    mm.startupDiscovery([]);
    mm.noofTotalModules = 0;
    const rec = {passes: 0};
    mm.on('allmodulediscovered', () => { rec.passes += 1; });
    return {mm, rec};
  }
  // a module object as single-thread mode's: reports its device on discover
  const reporting = () => {
    const m = new EventEmitter();
    m.on('discover', () => setImmediate(() => m.emit('devicereported')));
    return m;
  };

  it('a load held by a unit runs no pass; one outside it runs its own; the unit\'s registrations are waited for', async () => {
    const {mm, rec} = manager();
    const unit = mm.holdDiscovery(['s', 'p']);
    mm.emit('moduleload', 's', {name: 's'}, '1.0.0');
    mm.emit('moduleload', 'p', {name: 'p'}, '1.0.0');
    const waited = packs.unitRegistered(unit, ['s', 'p'], 2000);
    mm.emit('moduleload', 'other', {name: 'other'}, '1.0.0');
    await waited;
    await tick(20);
    assert.deepStrictEqual([...unit.registered].sort(), ['p', 's']);
    assert.strictEqual(rec.passes, 1, 'only the load outside the unit ran a pass');
    mm.releaseDiscovery(unit);
    mm.emit('moduleload', 's', {name: 's'}, '1.0.0');
    await tick(20);
    assert.strictEqual(rec.passes, 2, 'once released, a load runs its pass again');
  });

  it('a held load opens no discovery window (allDevicesLoaded is left as it is); a load outside the unit does', async () => {
    const {mm} = manager();
    let windows = 0;
    mm.on('modulediscovering', () => { windows += 1; });
    const unit = mm.holdDiscovery(['s']);
    mm.emit('moduleload', 's', {name: 's'}, '1.0.0');
    assert.strictEqual(windows, 0);
    mm.emit('moduleload', 'other', {name: 'other'}, '1.0.0');
    assert.strictEqual(windows, 1);
    mm.releaseDiscovery(unit);
  });

  it('a refused registration is an outcome: noted through the refusal itself, so the unit does not wait for it', async () => {
    const {mm} = manager();
    // the device manager refuses this registration (DEVICE_OBJECT_CONFLICT):
    // nothing is registered, and the outcome is noted after the attempt
    const attempts = [];
    mm.on('registerdevices', (module) => { attempts.push([module.name, mm.units != null && [...mm.units][0].registered.has('s')]); return false; });
    const unit = mm.holdDiscovery(['s']);
    mm.emit('moduleload', 's', {name: 's'}, '1.0.0');
    const t0 = Date.now();
    await packs.unitRegistered(unit, ['s'], 2000);
    assert.ok(Date.now() - t0 < 1000, `waited ${Date.now() - t0} ms`);
    assert.deepStrictEqual(attempts, [['s', false]], 'the refusal ran, before the outcome was noted');
    assert.ok(unit.registered.has('s'));
  });

  it('a load replaced before its registration ran is no outcome: the replacement\'s is', async () => {
    const {mm} = manager();
    const unit = mm.holdDiscovery(['s']);
    mm.emit('moduleload', 's', {name: 's'}, '1.0.0');
    mm.modules.s = {name: 's', replacement: true};   // replaced before the queued registration runs
    await assert.rejects(packs.unitRegistered(unit, ['s'], 100), (err) => err.code === 'CONTROL_FAILED');
    assert.strictEqual(unit.registered.has('s'), false);
  });

  it('a module loaded but never registered fails the unit, loudly, at the bound', async () => {
    const {mm} = manager();
    const unit = mm.holdDiscovery(['s']);
    unit.loaded.add('s');   // loaded, its registration never comes
    await assert.rejects(packs.unitRegistered(unit, ['s'], 100), (err) => err.code === 'CONTROL_FAILED' && /s: loaded, but not registered/.test(err.message));
  });

  it('a stub that never acknowledges a load is not waited for', async () => {
    const {mm} = manager();
    const unit = mm.holdDiscovery(['s']);
    await packs.unitRegistered(unit, ['s'], 2000);
  });

  it('single-thread mode: the unit waits for its module\'s discovery, and the held load runs no pass', async () => {
    const {mm, rec} = manager(false);
    const unit = mm.holdDiscovery(['s']);
    mm.emit('moduleload', 's', reporting(), '1.0.0');
    assert.strictEqual(unit.registered.has('s'), false, 'not before its discovery');
    await packs.unitRegistered(unit, ['s'], 2000);
    assert.ok(unit.registered.has('s'));
    await tick(20);
    assert.strictEqual(rec.passes, 0);
  });
});
