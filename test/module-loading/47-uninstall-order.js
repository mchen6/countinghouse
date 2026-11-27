'use strict';
// The uninstall's order: every refusal before anything is removed, then the
// module's keys, then its --moduleRegistry row, then its data directory. An
// uninstall whose store could not be reached used to remove the row first and
// leave the keys and the data to a later module of the same name. The data
// directory's checks (a <name>/ that is not a directory, a link on the way to
// it, one that can't be read, a sessions/ that can't be listed, a <name>/ the
// ownership marker can't be written in) are read before the keys go; the
// link and directory checks are made again where it is deleted, so a link
// swapped in between is refused there.
//
// Server-free: the store's kv is a fake whose purge records itself (and can
// fail, or swap a link in, while it runs), and the registry's removal is
// stubbed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const options = require('../../lib/cli-options');
const LOG = require('../../lib/logger');
const {CODES} = require('../../lib/error-catalogue');

describe('module-loading 47: the uninstall removes nothing before every check has passed, the keys before the registry row', function() {
  this.timeout(30000);
  const trees = require('../helpers/test-tmp').forFile(['ch-ml47-']);
  const store = require('../../lib/store');
  const deviceDb = require('../../lib/device-db');
  let saved = null;
  let ModuleManager = null;
  let calls = [];
  let onPurge = null;   // (prefix) -> run inside the purge of that prefix; may throw
  let registryOn = true;
  let registryFails = false;
  let registryChanges = 1;
  const chmodded = [];
  before(() => {
    LOG.createLogger();
    saved = {workerThread: options.workerThread, moduleDataPath: options.moduleDataPath, usesModuleRegistry: options.usesModuleRegistry,
      getStore: store.getStore, removeModuleInfo: deviceDb.removeModuleInfo};
    options.workerThread = true;
    // (a kv like the local store's: purgeNamespace takes its deletePrefix)
    const kv = {deletePrefix(prefix) {
      calls.push(`purge ${prefix}`);
      if (onPurge != null) onPurge(prefix);
      return 0;
    }};
    store.getStore = () => ({kv});
    options.usesModuleRegistry = () => registryOn;
    deviceDb.removeModuleInfo = function(name, cb) {
      calls.push(`registry ${name}`);
      if (registryFails) return cb.call(null, new Error('the registry is read-only'));
      return cb.call({changes: registryChanges}, null);
    };
    ModuleManager = require('../../lib/module-manager');
  });
  after(() => {
    for (const p of chmodded) { try { fs.chmodSync(p, 0o700); } catch (e) { /* gone */ } }
    options.workerThread = saved.workerThread;
    options.moduleDataPath = saved.moduleDataPath;
    options.usesModuleRegistry = saved.usesModuleRegistry;
    store.getStore = saved.getStore;
    deviceDb.removeModuleInfo = saved.removeModuleInfo;
  });
  beforeEach(() => { calls = []; onPurge = null; registryOn = true; registryFails = false; registryChanges = 1; });
  afterEach(() => {
    // (a directory made unreadable is made readable again, so its tree can go)
    for (const p of chmodded.splice(0)) { try { fs.chmodSync(p, 0o700); } catch (e) { /* gone */ } }
  });

  const uninstall = (name, keepData = false, mm = new ModuleManager()) => new Promise((resolve) => mm.uninstallModule(name, keepData, (e, r) => resolve({e, r})));
  const dataRoot = () => { options.moduleDataPath = trees.mkdtemp('ch-ml47-'); return options.moduleDataPath; };
  const lock = (p, mode) => { fs.chmodSync(p, mode); chmodded.push(p); };
  // (chmod refusing anything: POSIX, and not as root)
  const permissionsBite = process.platform !== 'win32' && !(typeof(process.getuid) === 'function' && process.getuid() === 0);
  const unreadableText = (p, code) => CODES.MODULE_DATA_UNREADABLE.en.replace('{path}', p).replace('{code}', code);

  it('the keys go before the registry row', async () => {
    dataRoot();
    const {e} = await uninstall('order-mod');
    assert.strictEqual(e, null, String(e && e.message));
    assert.deepStrictEqual(calls, ['purge m:order-mod:', 'purge ms:order-mod:', 'registry order-mod']);
  });

  it('with no --moduleRegistry: the keys go, no registry call', async () => {
    dataRoot();
    registryOn = false;
    const {e, r} = await uninstall('noreg-mod');
    assert.strictEqual(e, null, String(e && e.message));
    assert.deepStrictEqual(calls, ['purge m:noreg-mod:', 'purge ms:noreg-mod:']);
    assert.strictEqual(r.registryEntryRemoved, false);
  });

  it('keepData: no key purged and the data directory kept; the registry row goes', async () => {
    const root = dataRoot();
    fs.mkdirSync(path.join(root, 'kept-mod', 'data'), {recursive: true});
    const {e, r} = await uninstall('kept-mod', true);
    assert.strictEqual(e, null, String(e && e.message));
    assert.deepStrictEqual(calls, ['registry kept-mod']);
    assert.strictEqual(r.keysDeleted, null);
    assert.ok(fs.existsSync(path.join(root, 'kept-mod', 'data')));
  });

  it('a purge that fails partway: the registry row and the data directory kept, only the store\'s code said; a second uninstall finishes', async () => {
    const root = dataRoot();
    fs.mkdirSync(path.join(root, 'half-mod', 'data'), {recursive: true});
    onPurge = (prefix) => {
      if (prefix.startsWith('ms:')) throw Object.assign(new Error('READONLY You cannot write against a read only replica. key ms:half-mod:secret-key-name'), {code: 'READONLY'});
    };
    const mm = new ModuleManager();
    mm.lastSettings.set('half-mod', {values: {}});
    const first = await uninstall('half-mod', false, mm);
    assert.strictEqual(first.e && first.e.code, 'MODULE_KEYS_NOT_PURGED', String(first.e && first.e.message));
    assert.ok(first.e.message.startsWith(CODES.MODULE_KEYS_NOT_PURGED.en.replace('{code}', 'READONLY')), first.e.message);
    assert.ok(!first.e.message.includes('secret-key-name') && !first.e.message.includes('read only replica'), first.e.message);
    assert.deepStrictEqual(calls, ['purge m:half-mod:', 'purge ms:half-mod:']);
    assert.ok(fs.existsSync(path.join(root, 'half-mod', 'data')));
    assert.strictEqual(CODES.MODULE_KEYS_NOT_PURGED.retryable, true);
    assert.ok(mm.lastSettings.has('half-mod'), 'a refused uninstall keeps the last settings');
    calls = [];
    onPurge = null;
    const second = await uninstall('half-mod');
    assert.strictEqual(second.e, null, String(second.e && second.e.message));
    assert.deepStrictEqual(calls, ['purge m:half-mod:', 'purge ms:half-mod:', 'registry half-mod']);
  });

  it('a registry row that can\'t be removed: the keys are gone, the data directory kept; not retryable (the operator uninstalls again once the registry is fixed)', async () => {
    const root = dataRoot();
    fs.mkdirSync(path.join(root, 'rowfail-mod', 'data'), {recursive: true});
    registryFails = true;
    const mm = new ModuleManager();
    mm.lastSettings.set('rowfail-mod', {values: {}});
    const {e} = await uninstall('rowfail-mod', false, mm);
    assert.strictEqual(e && e.code, 'REMOVE_MODULE_INFO_FAIL', String(e && e.message));
    // (the registry's own message is the log's, never the answer's)
    assert.ok(!e.message.includes('read-only'), e.message);
    assert.ok(mm.lastSettings.has('rowfail-mod'), 'a refused uninstall keeps the last settings');
    assert.deepStrictEqual(calls, ['purge m:rowfail-mod:', 'purge ms:rowfail-mod:', 'registry rowfail-mod']);
    assert.ok(fs.existsSync(path.join(root, 'rowfail-mod', 'data')));
    assert.strictEqual(CODES.REMOVE_MODULE_INFO_FAIL.retryable, false);
  });

  it('no data directory: the keys and the row go, and the answer is a success', async () => {
    dataRoot();
    const {e, r} = await uninstall('@none/mod');
    assert.strictEqual(e, null, String(e && e.message));
    assert.strictEqual(r.dataDeleted, false);
    assert.deepStrictEqual(calls, ['purge m:%40none%2Fmod:', 'purge ms:%40none%2Fmod:', 'registry @none/mod']);
  });

  it('a data directory that is a link is refused before anything is removed: no key purged, no registry row touched', async () => {
    const root = dataRoot();
    const outside = trees.mkdtemp('ch-ml47-');
    fs.writeFileSync(path.join(outside, 'keep'), 'keep');
    fs.symlinkSync(outside, path.join(root, 'linked-mod'), 'junction');
    const {e} = await uninstall('linked-mod');
    assert.strictEqual(e && e.code, 'MODULE_DATA_NOT_DIRECTORY', String(e && e.message));
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep');
  });

  it('an @scope that is a link is refused before anything is removed', async () => {
    const root = dataRoot();
    const outside = trees.mkdtemp('ch-ml47-');
    fs.mkdirSync(path.join(outside, 'p', 'data'), {recursive: true});
    fs.writeFileSync(path.join(outside, 'p', 'data', 'f'), 'keep');
    fs.symlinkSync(outside, path.join(root, '@fake'), 'junction');
    const {e} = await uninstall('@fake/p');
    assert.strictEqual(e && e.code, 'MODULE_DATA_NOT_DIRECTORY', String(e && e.message));
    assert.deepStrictEqual(calls, []);
    assert.ok(fs.existsSync(path.join(outside, 'p', 'data', 'f')));
  });

  it('a link that loops on the way: MODULE_DATA_UNREADABLE (ELOOP) before any key goes, for a plain and a scoped name', async function() {
    if (process.platform === 'win32') return this.skip();
    // (plain: the data root itself a link to itself; scoped: the @scope)
    const holder = trees.mkdtemp('ch-ml47-');
    const loopRoot = path.join(holder, 'loop');
    fs.symlinkSync(loopRoot, loopRoot);
    options.moduleDataPath = loopRoot;
    const plain = await uninstall('loop-mod');
    assert.strictEqual(plain.e && plain.e.code, 'MODULE_DATA_UNREADABLE', String(plain.e && plain.e.message));
    assert.ok(plain.e.message.startsWith(unreadableText(path.join(loopRoot, 'loop-mod'), 'ELOOP')), plain.e.message);
    const root = dataRoot();
    fs.symlinkSync(path.join(root, '@loop'), path.join(root, '@loop'));
    const scoped = await uninstall('@loop/mod');
    assert.strictEqual(scoped.e && scoped.e.code, 'MODULE_DATA_UNREADABLE', String(scoped.e && scoped.e.message));
    assert.ok(scoped.e.message.includes('(ELOOP)'), scoped.e.message);
    assert.deepStrictEqual(calls, []);
  });

  it('a data directory that can\'t be read: MODULE_DATA_UNREADABLE (EACCES) before any key goes, for a plain and a scoped name', async function() {
    if (!permissionsBite) return this.skip();
    const plainRoot = dataRoot();
    fs.mkdirSync(path.join(plainRoot, 'shut-mod', 'data'), {recursive: true});
    lock(plainRoot, 0o000);
    const plain = await uninstall('shut-mod');
    assert.strictEqual(plain.e && plain.e.code, 'MODULE_DATA_UNREADABLE', String(plain.e && plain.e.message));
    assert.ok(plain.e.message.startsWith(unreadableText(path.join(plainRoot, 'shut-mod'), 'EACCES')), plain.e.message);
    const root = dataRoot();
    fs.mkdirSync(path.join(root, '@shut', 'p', 'data'), {recursive: true});
    lock(path.join(root, '@shut'), 0o000);
    const scoped = await uninstall('@shut/p');
    assert.strictEqual(scoped.e && scoped.e.code, 'MODULE_DATA_UNREADABLE', String(scoped.e && scoped.e.message));
    assert.ok(scoped.e.message.includes('(EACCES)'), scoped.e.message);
    assert.deepStrictEqual(calls, []);
  });

  it('a sessions/ or a <name>/ that can\'t be written in, or a parent its rmdir needs that can\'t be: refused before any key goes', async function() {
    if (!permissionsBite) return this.skip();
    const root = dataRoot();
    fs.mkdirSync(path.join(root, 'rosess-mod', 'sessions', 'e'.repeat(32), 'data'), {recursive: true});
    lock(path.join(root, 'rosess-mod', 'sessions'), 0o500);
    const sess = await uninstall('rosess-mod');
    assert.strictEqual(sess.e && sess.e.code, 'MODULE_DATA_UNREADABLE', String(sess.e && sess.e.message));
    assert.ok(sess.e.message.startsWith(unreadableText(path.join(root, 'rosess-mod', 'sessions'), 'EACCES')), sess.e.message);
    fs.mkdirSync(path.join(root, '@ro', 'p', 'data'), {recursive: true});
    lock(path.join(root, '@ro'), 0o500);
    const parent = await uninstall('@ro/p');
    assert.strictEqual(parent.e && parent.e.code, 'MODULE_DATA_UNREADABLE', String(parent.e && parent.e.message));
    assert.ok(parent.e.message.startsWith(unreadableText(path.join(root, '@ro'), 'EACCES')), parent.e.message);
    assert.deepStrictEqual(calls, []);
  });

  it('a sessions/ that can\'t be listed, or a <name>/ the marker can\'t be written in: refused before any key goes', async function() {
    if (!permissionsBite) return this.skip();
    const root = dataRoot();
    fs.mkdirSync(path.join(root, 'sess-mod', 'sessions'), {recursive: true});
    lock(path.join(root, 'sess-mod', 'sessions'), 0o000);
    const sess = await uninstall('sess-mod');
    assert.strictEqual(sess.e && sess.e.code, 'MODULE_DATA_UNREADABLE', String(sess.e && sess.e.message));
    assert.ok(sess.e.message.startsWith(unreadableText(path.join(root, 'sess-mod', 'sessions'), 'EACCES')), sess.e.message);
    fs.mkdirSync(path.join(root, 'nolist-mod', 'data'), {recursive: true});
    lock(path.join(root, 'nolist-mod'), 0o300);
    const nolist = await uninstall('nolist-mod');
    assert.strictEqual(nolist.e && nolist.e.code, 'MODULE_DATA_UNREADABLE', String(nolist.e && nolist.e.message));
    assert.ok(nolist.e.message.startsWith(unreadableText(path.join(root, 'nolist-mod'), 'EACCES')), nolist.e.message);
    fs.mkdirSync(path.join(root, 'rodata-mod', 'data'), {recursive: true});
    lock(path.join(root, 'rodata-mod', 'data'), 0o500);
    const rodata = await uninstall('rodata-mod');
    assert.strictEqual(rodata.e && rodata.e.code, 'MODULE_DATA_UNREADABLE', String(rodata.e && rodata.e.message));
    assert.ok(rodata.e.message.startsWith(unreadableText(path.join(root, 'rodata-mod', 'data'), 'EACCES')), rodata.e.message);
    fs.mkdirSync(path.join(root, 'ro-mod', 'data'), {recursive: true});
    lock(path.join(root, 'ro-mod'), 0o500);
    const ro = await uninstall('ro-mod');
    assert.strictEqual(ro.e && ro.e.code, 'MODULE_DATA_UNREADABLE', String(ro.e && ro.e.message));
    assert.ok(ro.e.message.includes('(EACCES)'), ro.e.message);
    assert.deepStrictEqual(calls, []);
  });

  it('a <name>/ holding only what isn\'t the runtime\'s, and not writable: kept and named in kept, as ever; the keys and the row go', async function() {
    if (!permissionsBite) return this.skip();
    const root = dataRoot();
    fs.mkdirSync(path.join(root, 'foreign-mod'), {recursive: true});
    fs.writeFileSync(path.join(root, 'foreign-mod', 'stray'), 'keep');
    lock(path.join(root, 'foreign-mod'), 0o500);
    const {e, r} = await uninstall('foreign-mod');
    assert.strictEqual(e, null, String(e && e.message));
    assert.deepStrictEqual(calls, ['purge m:foreign-mod:', 'purge ms:foreign-mod:', 'registry foreign-mod']);
    assert.strictEqual(r.dataDeleted, false);
    assert.ok(r.kept.some((k) => k.endsWith('foreign-mod')), JSON.stringify(r.kept));
    assert.strictEqual(fs.readFileSync(path.join(root, 'foreign-mod', 'stray'), 'utf8'), 'keep');
  });

  it('a <name>/ whose data/ the runtime made (marked), and not writable: MODULE_DATA_UNREADABLE before any key goes', async function() {
    if (!permissionsBite) return this.skip();
    const root = dataRoot();
    const dirs = require('../../lib/module-data').dirsFor(root, 'marked-mod');
    fs.mkdirSync(dirs.data, {recursive: true});
    fs.writeFileSync(path.join(dirs.data, 'f'), 'x');
    await require('../../lib/data-ownership').record(dirs.root, {data: dirs.data}, root);
    assert.ok((await require('../../lib/data-ownership').readMarker(dirs.root, root)).data != null, 'marked');
    lock(dirs.root, 0o500);
    const {e} = await uninstall('marked-mod');
    assert.strictEqual(e && e.code, 'MODULE_DATA_UNREADABLE', String(e && e.message));
    assert.ok(e.message.startsWith(unreadableText(dirs.root, 'EACCES')), e.message);
    assert.deepStrictEqual(calls, []);
  });

  it('a link swapped in after the early check is refused where the directory is deleted, its target untouched', async () => {
    const root = dataRoot();
    fs.mkdirSync(path.join(root, 'swap-mod', 'data'), {recursive: true});
    const outside = trees.mkdtemp('ch-ml47-');
    fs.mkdirSync(path.join(outside, 'data'));
    fs.writeFileSync(path.join(outside, 'data', 'f'), 'keep');
    // (while the keys are purged: the real directory moved away, a link to
    // another directory put in its place)
    onPurge = (prefix) => {
      if (!prefix.startsWith('m:')) return;
      fs.renameSync(path.join(root, 'swap-mod'), path.join(root, 'moved-away'));
      fs.symlinkSync(outside, path.join(root, 'swap-mod'), 'junction');
    };
    const {e} = await uninstall('swap-mod');
    assert.strictEqual(e && e.code, 'MODULE_DATA_NOT_DIRECTORY', String(e && e.message));
    assert.deepStrictEqual(calls, ['purge m:swap-mod:', 'purge ms:swap-mod:', 'registry swap-mod']);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'data', 'f'), 'utf8'), 'keep');
    assert.ok(fs.existsSync(path.join(root, 'moved-away', 'data')));
  });

  it('MODULE_DATA_UNREADABLE is in the catalogue, an operator\'s and not retryable, its text word for word', () => {
    const c = CODES.MODULE_DATA_UNREADABLE;
    assert.deepStrictEqual([c.kind, c.retryable, c.httpStatus], ['operator', false, 500]);
    assert.strictEqual(c.en, 'The module was not uninstalled: its data directory {path} could not be read ({code}), so nothing was removed -- make it readable (its permissions, or a link that loops), then uninstall again');
  });

  // After the keys and the row are gone, a failure in the directory step is
  // MODULE_DATA_NOT_REMOVED, the directory kept; a second uninstall finishes.
  const notRemovedText = (p, code) => CODES.MODULE_DATA_NOT_REMOVED.en.replace('{path}', p).replace('{code}', code);

  it('an ownership marker that can\'t be written (a full disk) after the keys and the row are gone: MODULE_DATA_NOT_REMOVED, the directory kept; a second uninstall, its row already gone, removes it and answers success', async () => {
    const root = dataRoot();
    fs.mkdirSync(path.join(root, 'full-mod', 'data'), {recursive: true});
    fs.writeFileSync(path.join(root, 'full-mod', 'data', 'f'), 'x');
    const fsp = require('fs/promises');
    const realOpen = fsp.open;
    fsp.open = function(p, ...rest) {
      if (String(p).includes('.countinghouse-owned.')) return Promise.reject(Object.assign(new Error('no space left on device'), {code: 'ENOSPC'}));
      return realOpen.call(this, p, ...rest);
    };
    let first;
    try { first = await uninstall('full-mod'); } finally { fsp.open = realOpen; }
    assert.strictEqual(first.e && first.e.code, 'MODULE_DATA_NOT_REMOVED', String(first.e && first.e.message));
    assert.ok(first.e.message.startsWith(notRemovedText(path.join(root, 'full-mod'), 'ENOSPC')), first.e.message);
    assert.deepStrictEqual(calls, ['purge m:full-mod:', 'purge ms:full-mod:', 'registry full-mod']);
    assert.ok(fs.existsSync(path.join(root, 'full-mod', 'data', 'f')));
    calls = [];
    registryChanges = 0;
    const second = await uninstall('full-mod');
    assert.strictEqual(second.e, null, String(second.e && second.e.message));
    assert.strictEqual(second.r.registryEntryRemoved, false);
    assert.strictEqual(second.r.dataDeleted, true);
    assert.ok(!fs.existsSync(path.join(root, 'full-mod')));
  });

  it('a session partition whose removal throws: MODULE_DATA_NOT_REMOVED (UNKNOWN), the directory kept', async () => {
    const root = dataRoot();
    const id = 'a'.repeat(32);
    fs.mkdirSync(path.join(root, 'part-mod', 'sessions', id, 'data'), {recursive: true});
    const partition = require('../../lib/session-partition');
    const realRemove = partition.remove;
    partition.remove = () => Promise.reject(new Error('a partition could not be removed'));
    let res;
    try { res = await uninstall('part-mod'); } finally { partition.remove = realRemove; }
    assert.strictEqual(res.e && res.e.code, 'MODULE_DATA_NOT_REMOVED', String(res.e && res.e.message));
    assert.ok(res.e.message.startsWith(notRemovedText(path.join(root, 'part-mod'), 'UNKNOWN')), res.e.message);
    assert.ok(!res.e.message.includes('a partition could not be removed'), res.e.message);
    assert.ok(fs.existsSync(path.join(root, 'part-mod', 'sessions', id)));
  });

  it('a data directory that can\'t be read at the delete (made so while the keys were purged): MODULE_DATA_NOT_REMOVED (EACCES)', async function() {
    if (!permissionsBite) return this.skip();
    const root = dataRoot();
    fs.mkdirSync(path.join(root, 'late-mod', 'data'), {recursive: true});
    onPurge = (prefix) => { if (prefix.startsWith('ms:')) lock(root, 0o000); };
    const res = await uninstall('late-mod');
    assert.strictEqual(res.e && res.e.code, 'MODULE_DATA_NOT_REMOVED', String(res.e && res.e.message));
    assert.ok(res.e.message.startsWith(notRemovedText(path.join(root, 'late-mod'), 'EACCES')), res.e.message);
    assert.deepStrictEqual(calls, ['purge m:late-mod:', 'purge ms:late-mod:', 'registry late-mod']);
  });

  it('a sessions/ made unlistable while the keys were purged: MODULE_DATA_NOT_REMOVED (EACCES) at the listing', async function() {
    if (!permissionsBite) return this.skip();
    const root = dataRoot();
    const sessions = path.join(root, 'list-mod', 'sessions');
    fs.mkdirSync(path.join(sessions, 'a'.repeat(32), 'data'), {recursive: true});
    onPurge = (prefix) => { if (prefix.startsWith('ms:')) lock(sessions, 0o300); };
    const res = await uninstall('list-mod');
    assert.strictEqual(res.e && res.e.code, 'MODULE_DATA_NOT_REMOVED', String(res.e && res.e.message));
    assert.ok(res.e.message.includes('(EACCES)'), res.e.message);
  });

  it('the log line of a directory step that failed never names a session: its id is cut', async () => {
    const root = dataRoot();
    const id = 'b'.repeat(32);
    fs.mkdirSync(path.join(root, 'logid-mod', 'sessions', id, 'data'), {recursive: true});
    const partition = require('../../lib/session-partition');
    const realRemove = partition.remove;
    partition.remove = () => Promise.reject(Object.assign(new Error(`ENOSPC: no space left on device, open '${path.join(root, 'logid-mod', 'sessions', id, '.countinghouse-owned.ab12')}'`), {code: 'ENOSPC'}));
    const logged = [];
    const realW = LOG.W;
    LOG.W = (line) => { logged.push(String(line)); };
    let res;
    try { res = await uninstall('logid-mod'); } finally { partition.remove = realRemove; LOG.W = realW; }
    assert.strictEqual(res.e && res.e.code, 'MODULE_DATA_NOT_REMOVED', String(res.e && res.e.message));
    assert.ok(res.e.message.includes('(ENOSPC)'), res.e.message);
    const line = logged.find((l) => l.includes('its data directory was not removed'));
    assert.ok(line != null, JSON.stringify(logged));
    assert.ok(!line.includes(id) && line.includes('<a session>'), line);
  });

  it('a session partition refusing a link on the way: MODULE_DATA_NOT_DIRECTORY, as the link refusal it is', async () => {
    const root = dataRoot();
    fs.mkdirSync(path.join(root, 'plink-mod', 'sessions', 'c'.repeat(32), 'data'), {recursive: true});
    const partition = require('../../lib/session-partition');
    const realRemove = partition.remove;
    const at = path.join(root, 'plink-mod', 'sessions');
    partition.remove = () => Promise.reject(Object.assign(new Error(`${at} is not a directory`), {notRealPath: at}));
    let res;
    try { res = await uninstall('plink-mod'); } finally { partition.remove = realRemove; }
    assert.strictEqual(res.e && res.e.code, 'MODULE_DATA_NOT_DIRECTORY', String(res.e && res.e.message));
  });

  it('session-partition\'s own link refusal says which path (notRealPath)', async () => {
    const root = dataRoot();
    const outside = trees.mkdtemp('ch-ml47-');
    fs.mkdirSync(path.join(outside, 'sessions'));
    fs.symlinkSync(outside, path.join(root, 'linkp-mod'), 'junction');
    const partition = require('../../lib/session-partition');
    const err = await partition.remove(root, {}, 'linkp-mod', 'd'.repeat(32), {keys: false}).then(() => null, (e) => e);
    assert.ok(err != null && err.notRealPath === 'linkp-mod', String(err && err.message));
  });

  it('<name>/\'s own rmdir failing otherwise than not empty (a read-only disk): MODULE_DATA_NOT_REMOVED, never a success with it kept', async () => {
    const root = dataRoot();
    fs.mkdirSync(path.join(root, 'rofs-mod'), {recursive: true});
    const fsp = require('fs/promises');
    const realRmdir = fsp.rmdir;
    fsp.rmdir = function(p, ...rest) {
      if (String(p) === path.join(root, 'rofs-mod')) return Promise.reject(Object.assign(new Error('read-only file system'), {code: 'EROFS'}));
      return realRmdir.call(this, p, ...rest);
    };
    let res;
    try { res = await uninstall('rofs-mod'); } finally { fsp.rmdir = realRmdir; }
    assert.strictEqual(res.e && res.e.code, 'MODULE_DATA_NOT_REMOVED', String(res.e && res.e.message));
    assert.ok(res.e.message.includes('(EROFS)'), res.e.message);
  });

  it('a newline in an fs message stays escaped in the log line: a module\'s file name writes no line of its own', async () => {
    const root = dataRoot();
    fs.mkdirSync(path.join(root, 'nl-mod', 'sessions', 'f'.repeat(32), 'data'), {recursive: true});
    const partition = require('../../lib/session-partition');
    const realRemove = partition.remove;
    partition.remove = () => Promise.reject(Object.assign(new Error('EACCES: open \'data/x\n2026-11-27 module: other: forged\''), {code: 'EACCES'}));
    const logged = [];
    const realW = LOG.W;
    LOG.W = (line) => { logged.push(String(line)); };
    try { await uninstall('nl-mod'); } finally { partition.remove = realRemove; LOG.W = realW; }
    const line = logged.find((l) => l.includes('its data directory was not removed'));
    assert.ok(line != null && !line.includes('\n') && line.includes('\\n'), JSON.stringify(logged));
  });

  it('session-partition\'s walk that can\'t read a directory on the way is an error with its code, never a link refusal', async function() {
    if (!permissionsBite) return this.skip();
    const root = dataRoot();
    fs.mkdirSync(path.join(root, 'shutp-mod', 'sessions'), {recursive: true});
    lock(path.join(root, 'shutp-mod'), 0o000);
    const partition = require('../../lib/session-partition');
    const err = await partition.remove(root, {}, 'shutp-mod', 'a'.repeat(32), {keys: false}).then(() => null, (e) => e);
    assert.ok(err != null && err.code === 'EACCES' && err.notRealPath === undefined, String(err && err.message));
  });

  it('MODULE_DATA_NOT_REMOVED is in the catalogue, an operator\'s and not retryable, its text word for word', () => {
    const c = CODES.MODULE_DATA_NOT_REMOVED;
    assert.deepStrictEqual([c.kind, c.retryable, c.httpStatus], ['operator', false, 500]);
    assert.strictEqual(c.en, 'The module\'s stored data and its registry entry, if any, are gone, but its data directory {path} could not be removed ({code}), so it is kept, perhaps only in part -- fix the cause (a full or read-only disk, its permissions), then uninstall again to remove it, or remove it by hand');
  });

  trees.hooks();
});
