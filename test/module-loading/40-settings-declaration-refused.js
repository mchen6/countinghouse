'use strict';
// A module whose settings declaration is invalid is not loaded (the
// module-level configuration design, section 4.1): SETTINGS_DECLARATION_INVALID,
// naming the module and the first problem by position, before anything is
// unloaded or spawned (a reload of a loaded module leaves it serving), and
// again on the pinned file at every spawn. A good declaration loads as
// before. Server-free: the spawn is stubbed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const options = require('../../lib/cli-options');
const LOG = require('../../lib/logger');
LOG.createLogger();

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'handler-map-convention');

describe('module-loading 40: an invalid settings declaration is refused at load', function() {
  this.timeout(30000);
  const dirs = [];
  let saved = null;
  let ModuleManager = null;
  before(() => {
    saved = {workerThread: options.workerThread};
    ModuleManager = require('../../lib/module-manager');
  });
  after(() => {
    options.workerThread = saved.workerThread;
    for (const d of dirs) fs.rmSync(d, {recursive: true, force: true});
  });

  // the clean fixture, named `name`, with `settings` in its package.json
  function moduleWith(settings) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ml40-'));
    dirs.push(dir);
    fs.cpSync(FIXTURE, dir, {recursive: true});
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.countinghouse = Object.assign({}, pkg.countinghouse, {settings});
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    return {dir, name: pkg.name, version: pkg.version};
  }
  // loadModuleFromPath with the worker's spawn stubbed: -> {err, spawned}
  function load(m) {
    options.workerThread = true;
    const mm = new ModuleManager();
    let spawned = false;
    mm.loadModuleByWorker = (p, n, v, cb) => { spawned = true; cb(null, {}); };
    return new Promise((resolve) => mm.loadModuleFromPath(m.dir, m.name, m.version, (err) => resolve({err, spawned})));
  }

  it('an invalid declaration: refused, naming the module and the first problem, nothing spawned', async () => {
    const m = moduleWith({units: {type: 'enum', values: []}});
    const {err, spawned} = await load(m);
    assert.ok(err != null && err.code === 'SETTINGS_DECLARATION_INVALID', String(err && err.code));
    assert.match(err.message, new RegExp(m.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
    assert.match(err.message, /countinghouse\.settings\.units\.values/);
    assert.strictEqual(spawned, false);
  });

  it('a setting name with a hidden character is shown cleaned in the refusal', async () => {
    const m = moduleWith({'a‮b': {type: 'boolean'}});
    const {err} = await load(m);
    assert.strictEqual(err.code, 'SETTINGS_DECLARATION_INVALID');
    assert.ok(!err.message.includes('‮'), JSON.stringify(err.message));
  });

  it('a required setting --moduleSettings leaves unset: refused before anything is unloaded or spawned', async () => {
    const m = moduleWith({region: {type: 'string', required: true}});
    const file = path.join(path.dirname(m.dir), `${path.basename(m.dir)}-ms.json`);
    fs.writeFileSync(file, JSON.stringify({[m.name]: {}}));
    const was = {moduleSettings: options.moduleSettings, settingsFile: options.settingsFile};
    options.moduleSettings = file;
    options.settingsFile = null;
    try {
      const {err, spawned} = await load(m);
      assert.ok(err != null && err.code === 'LOAD_MODULE_FAIL' && /region/.test(err.message), String(err && err.message));
      assert.strictEqual(spawned, false);
    } finally {
      Object.assign(options, was);
      fs.rmSync(file, {force: true});
    }
  });

  it('the dry run checks against the policy-narrowed net, as the spawn does: refused before anything is unloaded', async () => {
    const m = moduleWith({api: {type: 'string', format: 'hostname', required: true}});
    const pkgFile = path.join(m.dir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    pkg.countinghouse.permissions = {net: [{host: '*.acme.io'}]};
    fs.writeFileSync(pkgFile, JSON.stringify(pkg));
    const policy = path.join(path.dirname(m.dir), `${path.basename(m.dir)}-policy.json`);
    fs.writeFileSync(policy, JSON.stringify({modules: {[m.name]: {net: [{host: 'api.acme.io'}]}}}));
    const ms = path.join(path.dirname(m.dir), `${path.basename(m.dir)}-ms.json`);
    fs.writeFileSync(ms, JSON.stringify({[m.name]: {api: 'other.acme.io'}}));   // inside the declared net, outside the narrowed one
    const was = {moduleSettings: options.moduleSettings, settingsFile: options.settingsFile, modulePolicy: options.modulePolicy, moduleSandbox: options.moduleSandbox};
    Object.assign(options, {moduleSettings: ms, settingsFile: null, modulePolicy: policy, moduleSandbox: 'audit'});
    try {
      const {err, spawned} = await load(m);
      assert.ok(err != null && /api/.test(err.message) && /unset in --moduleSettings/.test(err.message), String(err && err.message));
      assert.strictEqual(spawned, false);
    } finally {
      Object.assign(options, was);
      for (const f of [policy, ms]) fs.rmSync(f, {force: true});
    }
  });

  it('a spawn refused for its settings leaves the pin and the validation\'s copy as they were', async () => {
    const m = moduleWith({region: {type: 'string', required: true}});
    const ms = path.join(path.dirname(m.dir), `${path.basename(m.dir)}-ms2.json`);
    fs.writeFileSync(ms, JSON.stringify({[m.name]: {}}));
    const was = {moduleSettings: options.moduleSettings, settingsFile: options.settingsFile, workerThread: options.workerThread, moduleDataPath: options.moduleDataPath};
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ml40-data-'));
    dirs.push(dataDir);
    Object.assign(options, {moduleSettings: ms, settingsFile: null, workerThread: true, moduleDataPath: dataDir});
    try {
      const mm = new ModuleManager();
      mm.manifestPins.forValidation(m.dir);
      const err = await new Promise((resolve) => mm.spawnModuleWorker(m.dir, m.name, m.version, (e) => resolve(e), () => true, true));
      assert.ok(err != null && /region/.test(err.message), String(err && err.message));
      assert.strictEqual(mm.manifestPins.pinnedOf(m.name), undefined, 'not pinned');
      assert.ok(mm.manifestPins.wouldPin(m.dir, m.name) != null, 'the validation\'s copy still there');
    } finally {
      Object.assign(options, was);
      fs.rmSync(ms, {force: true});
    }
  });

  it('a refused uninstall keeps the module\'s last settings (its restart may still need them)', async () => {
    const mm = new ModuleManager();
    mm.lastSettings.set('kept-mod', {values: {}});
    mm.supervisor = {status: () => ({state: 'running'}), recorded: () => null, clear: () => {}};
    const err = await new Promise((resolve) => mm.uninstallModule('kept-mod', false, (e) => resolve(e)));
    assert.strictEqual(err.code, 'MODULE_LOADED');
    assert.ok(mm.lastSettings.has('kept-mod'));
  });

  it('a good declaration loads as before', async () => {
    const m = moduleWith({units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric'}});
    const {err, spawned} = await load(m);
    assert.strictEqual(err, null);
    assert.strictEqual(spawned, true);
  });
});
