'use strict';
// The start's discovery ends when the startup list's own modules have
// loaded, whatever else loads meanwhile. A module loaded in place (or by an
// operator) while the start's modules were still loading counted toward the
// startup total (noofLoadedModules), so "all module discovered" fired before
// the start's own modules had loaded: the first composition pass ran early,
// and a module that failed it there was purged, never listed (found with
// test/stdio/36). Until the start's discovery has ended, only the startup
// list's modules count; after it, every load re-runs discovery as before.
// Server-free: the loads are stubbed.
const assert = require('assert');
const options = require('../../lib/cli-options');
const LOG = require('../../lib/logger');
LOG.createLogger();

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('module-loading 42: the start\'s discovery counts its own list only', function() {
  this.timeout(30000);
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

  // a manager whose startup list is a and b, each 150 ms to load (the worker
  // path's order: 'moduleload', then the answer); -> {mm, rec}
  function start(names = ['a', 'b']) {
    options.workerThread = true;
    options.localModulePath = names.map((n) => `/modules/${n}`);
    options.moduleRegistry = false;
    const mm = new ModuleManager();
    const rec = {discovered: [], loaded: []};
    mm.on('allmodulediscovered', () => rec.discovered.push(rec.loaded.slice()));
    mm.getModuleInfoFromPath = () => names.map((n) => ({path: `/modules/${n}`, name: n, version: '1.0.0'}));
    mm.loadModuleFromPath = (p, name, version, cb) => setTimeout(() => {
      mm.emit('moduleload', name, {name}, version);
      rec.loaded.push(name);
      cb(null, {});
    }, 150);
    // one at a time, whatever the runner's CPUs (lib/module-manager.js
    // startupLoadLimit; read only under the test flag)
    process.env.COUNTINGHOUSE_TEST_STARTUP_LIMIT = '1';
    try { mm.loadAllModules(); } finally { delete process.env.COUNTINGHOUSE_TEST_STARTUP_LIMIT; }
    return {mm, rec};
  }
  // a module loaded outside the startup list, as an in-place load's does
  const loadOther = (mm, rec, name) => { mm.emit('moduleload', name, {name}, '1.0.0'); rec.loaded.push(name); };

  it('a module loaded while the start\'s are loading does not end the start\'s discovery', async () => {
    const {mm, rec} = start();
    await tick(20);
    loadOther(mm, rec, 'x');
    await tick(200);   // a has loaded, b has not
    assert.deepStrictEqual(rec.discovered, [], `discovery ended early: ${JSON.stringify(rec.discovered)}`);
    for (let i = 0; i < 100 && rec.discovered.length === 0; i++) await tick(10);
    assert.strictEqual(rec.discovered.length, 1, JSON.stringify(rec.discovered));
    assert.ok(rec.discovered[0].includes('a') && rec.discovered[0].includes('b'), `ended before the start's own: ${JSON.stringify(rec.discovered[0])}`);
  });

  it('one of the start\'s own loaded a second time meanwhile (a reload in place, a restart) counts once', async () => {
    const {mm, rec} = start(['a', 'b', 'c']);
    for (let i = 0; i < 100 && !rec.loaded.includes('a'); i++) await tick(5);
    loadOther(mm, rec, 'a');   // a again, while b and c load
    await tick(200);           // b has loaded, c has not
    assert.deepStrictEqual(rec.discovered, [], `discovery ended early: ${JSON.stringify(rec.discovered)}`);
    for (let i = 0; i < 100 && rec.discovered.length === 0; i++) await tick(10);
    assert.strictEqual(rec.discovered.length, 1);
    assert.ok(rec.discovered[0].includes('c'), `ended before c: ${JSON.stringify(rec.discovered[0])}`);
  });

  it('a start\'s module whose load fails is discovered too: discovery still ends', async () => {
    options.workerThread = true;
    options.localModulePath = ['/modules/a', '/modules/b'];
    options.moduleRegistry = false;
    const mm = new ModuleManager();
    let discovered = 0;
    mm.on('allmodulediscovered', () => { discovered += 1; });
    mm.getModuleInfoFromPath = () => [{path: '/modules/a', name: 'a', version: '1.0.0'}, {path: '/modules/b', name: 'b', version: '1.0.0'}];
    mm.loadModuleFromPath = (p, name, version, cb) => setTimeout(() => {
      if (name === 'b') return cb(new Error('b failed'));
      mm.emit('moduleload', name, {name}, version);
      return cb(null, {});
    }, 20);
    process.env.COUNTINGHOUSE_TEST_STARTUP_LIMIT = '1';
    try { mm.loadAllModules(); } finally { delete process.env.COUNTINGHOUSE_TEST_STARTUP_LIMIT; }
    for (let i = 0; i < 100 && discovered === 0; i++) await tick(10);
    await tick(30);
    assert.strictEqual(discovered, 1);
  });

  it('after the start\'s discovery, every load re-runs it, as before', async () => {
    const {mm, rec} = start();
    for (let i = 0; i < 100 && rec.discovered.length === 0; i++) await tick(10);
    assert.strictEqual(rec.discovered.length, 1);
    loadOther(mm, rec, 'y');
    await tick(20);
    assert.strictEqual(rec.discovered.length, 2, 'a later load re-runs discovery');
  });
});
