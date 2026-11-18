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

  it('a good declaration loads as before', async () => {
    const m = moduleWith({units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric'}});
    const {err, spawned} = await load(m);
    assert.strictEqual(err, null);
    assert.strictEqual(spawned, true);
  });
});
