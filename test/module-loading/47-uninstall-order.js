'use strict';
// The uninstall's order: every refusal before anything is removed, then the
// module's keys, then its --moduleRegistry row, then its data directory. An
// uninstall whose store could not be reached used to remove the row first and
// leave the keys and the data to a later module of the same name. The data
// directory's checks (a <name>/ that is not a directory, a link on the way to
// it) are read before the keys go, and made again where the directory is
// deleted, so a link swapped in between is refused there.
//
// Server-free: the store's kv is a fake whose purge records itself (and can
// swap a link in while it runs), and the registry's removal is stubbed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const options = require('../../lib/cli-options');
const LOG = require('../../lib/logger');

describe('module-loading 47: the uninstall removes nothing before every check has passed, the keys before the registry row', function() {
  this.timeout(30000);
  const trees = require('../helpers/test-tmp').forFile(['ch-ml47-']);
  const store = require('../../lib/store');
  const deviceDb = require('../../lib/device-db');
  let saved = null;
  let ModuleManager = null;
  let calls = [];
  let onPurge = null;
  before(() => {
    LOG.createLogger();
    saved = {workerThread: options.workerThread, moduleDataPath: options.moduleDataPath, usesModuleRegistry: options.usesModuleRegistry,
      getStore: store.getStore, removeModuleInfo: deviceDb.removeModuleInfo};
    options.workerThread = true;
    // (a kv like the local store's: purgeNamespace takes its deletePrefix)
    const kv = {deletePrefix(prefix) {
      calls.push(`purge ${prefix}`);
      if (onPurge != null) { const f = onPurge; onPurge = null; f(); }
      return 0;
    }};
    store.getStore = () => ({kv});
    options.usesModuleRegistry = () => true;
    deviceDb.removeModuleInfo = function(name, cb) { calls.push(`registry ${name}`); cb.call({changes: 1}, null); };
    ModuleManager = require('../../lib/module-manager');
  });
  after(() => {
    options.workerThread = saved.workerThread;
    options.moduleDataPath = saved.moduleDataPath;
    options.usesModuleRegistry = saved.usesModuleRegistry;
    store.getStore = saved.getStore;
    deviceDb.removeModuleInfo = saved.removeModuleInfo;
  });
  beforeEach(() => { calls = []; onPurge = null; });

  const uninstall = (name) => new Promise((resolve) => new ModuleManager().uninstallModule(name, false, (e, r) => resolve({e, r})));

  it('the keys go before the registry row', async () => {
    options.moduleDataPath = trees.mkdtemp('ch-ml47-');
    const {e} = await uninstall('order-mod');
    assert.strictEqual(e, null, String(e && e.message));
    assert.deepStrictEqual(calls, ['purge m:order-mod:', 'purge ms:order-mod:', 'registry order-mod']);
  });

  it('a data directory that is a link is refused before anything is removed: no key purged, no registry row touched', async () => {
    const root = trees.mkdtemp('ch-ml47-');
    options.moduleDataPath = root;
    const outside = trees.mkdtemp('ch-ml47-');
    fs.writeFileSync(path.join(outside, 'keep'), 'keep');
    fs.symlinkSync(outside, path.join(root, 'linked-mod'), 'junction');
    const {e} = await uninstall('linked-mod');
    assert.strictEqual(e && e.code, 'MODULE_DATA_NOT_DIRECTORY', String(e && e.message));
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep');
  });

  it('an @scope that is a link is refused before anything is removed', async () => {
    const root = trees.mkdtemp('ch-ml47-');
    options.moduleDataPath = root;
    const outside = trees.mkdtemp('ch-ml47-');
    fs.mkdirSync(path.join(outside, 'p', 'data'), {recursive: true});
    fs.writeFileSync(path.join(outside, 'p', 'data', 'f'), 'keep');
    fs.symlinkSync(outside, path.join(root, '@fake'), 'junction');
    const {e} = await uninstall('@fake/p');
    assert.strictEqual(e && e.code, 'MODULE_DATA_NOT_DIRECTORY', String(e && e.message));
    assert.deepStrictEqual(calls, []);
    assert.ok(fs.existsSync(path.join(outside, 'p', 'data', 'f')));
  });

  it('a link swapped in after the early check is refused where the directory is deleted, its target untouched', async () => {
    const root = trees.mkdtemp('ch-ml47-');
    options.moduleDataPath = root;
    fs.mkdirSync(path.join(root, 'swap-mod', 'data'), {recursive: true});
    const outside = trees.mkdtemp('ch-ml47-');
    fs.mkdirSync(path.join(outside, 'data'));
    fs.writeFileSync(path.join(outside, 'data', 'f'), 'keep');
    // (while the keys are purged: the real directory moved away, a link to
    // another directory put in its place)
    onPurge = () => {
      fs.renameSync(path.join(root, 'swap-mod'), path.join(root, 'moved-away'));
      fs.symlinkSync(outside, path.join(root, 'swap-mod'), 'junction');
    };
    const {e} = await uninstall('swap-mod');
    assert.strictEqual(e && e.code, 'MODULE_DATA_NOT_DIRECTORY', String(e && e.message));
    assert.ok(calls.includes('purge m:swap-mod:'), JSON.stringify(calls));
    assert.strictEqual(fs.readFileSync(path.join(outside, 'data', 'f'), 'utf8'), 'keep');
    assert.ok(fs.existsSync(path.join(root, 'moved-away', 'data')));
  });

  trees.hooks();
});
