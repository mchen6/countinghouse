// Builds one module worker's file broker at spawn (docs/superpowers/specs/
// 2026-10-17-module-sandbox-fs-broker-design.md, section 3): its data
// directories, its prepared namespace, its broker on the shared scheduler,
// and the bridge the worker receives in workerData.
const fs = require('fs');
const path = require('path');
const moduleData = require('../module-data');
const {createNamespace} = require('./namespace');
const {FsBroker} = require('./broker');
const {FsScheduler} = require('./scheduler');
const {createBridge} = require('./server');
const spawnWalk = require('./spawn-walk');
const {Quota} = require('./quota');
const {DeniedSet, deniedPathsFor} = require('./denied');

const INSTALL_DIR = path.join(__dirname, '..', '..');
let scheduler = null;
let spawned = 0;

// The always-denied files (lib/fs-broker/denied.js), one set for every
// broker, from the server's own options -- not the per-spawn copy a
// validation passes, whose moduleDataPath is a throwaway directory.
let denied = null;
function deniedSet() {
  if (denied == null) denied = new DeniedSet(deniedPathsFor(require('../cli-options')));
  return denied;
}

function sharedScheduler() {
  if (scheduler == null) scheduler = new FsScheduler({globalCap: FsScheduler.capFor(process.env.UV_THREADPOOL_SIZE)});
  return scheduler;
}

// What no module may declare, or declare an ancestor of (spec section 1).
function protectedPaths(options) {
  const cwd = process.cwd();
  return [INSTALL_DIR, options.modulePath, options.moduleDataPath,
    // the local store (metering, kv, the profile's identity secret; LM1)
    (options.store === 'local') ? options.storePath : null,
    options.authConfigPath || path.join(cwd, 'auth.json'),
    options.deviceConfigPath || path.join(cwd, 'config', 'devices'),
    options.modulePolicy].filter((p) => p != null).map((p) => path.resolve(cwd, p));
}

// Every module root this server knows (--modulePath and each --loadModule),
// never a countinghouse code root (identity.codeRootsFor).
function moduleRootsOf(options) {
  const cwd = process.cwd();
  const local = [].concat(options.localModulePath || []);
  return [options.modulePath].concat(local).filter((p) => typeof(p) === 'string').map((p) => path.resolve(cwd, p));
}

// A directory's real path, with the sync realpath: one syscall at spawn.
// Under --permission, Node refuses operations on a granted directory itself
// when another grant extends its name (/x/countinghouse beside
// /x/countinghouse_module_data; nodejs/node#66812): async ones always, sync
// ones from 24.22. So under --hardened the answer comes from the parent's
// precomputed real paths (lib/hardened-realpaths.js;
// test/fs-broker/10-permission-prefix.js). Resolving the directory itself,
// not a file inside it, keeps a module from choosing its own /app with a
// symlinked package.json.
function realDir(dir) {
  return require('../hardened-realpaths').realpathSync(dir);
}

async function createForWorker(cfg) {
  let dirs;
  try {
    dirs = await moduleData.ensureDirs(cfg.options.moduleDataPath, cfg.name);
  } catch (e) {
    // Every mode creates it, so a read-only $HOME (systemd ProtectHome, a
    // read-only container root) must say what to do (review I6).
    let where = cfg.options.moduleDataPath;
    try { where = moduleData.dirsFor(cfg.options.moduleDataPath, cfg.name).root; } catch (e2) { /* unsafe name: keep the base */ }
    throw new Error(`cannot create the module data directory ${where}: ${e.message} -- set --moduleDataPath to a writable directory`);
  }
  // The spawn walk (spec section 3): /tmp emptied in every mode, never
  // through a link; then, when counting, /data and /tmp measured and checked
  // for links that can lead outside.
  await spawnWalk.emptyTmp(dirs.tmp);
  let usage = null;
  if (cfg.mode !== 'off') {
    usage = await spawnWalk.measure([[dirs.data, '/data'], [dirs.tmp, '/tmp']], {maxListed: 10});
    if (usage.links.length > 0) {
      const text = 'links that could lead outside the module\'s data (a symlink with an absolute target, or a hard link ' +
        `with a name outside /data and /tmp): ${usage.links.join(', ')}${usage.moreLinks > 0 ? ` and ${usage.moreLinks} more` : ''}` +
        ` -- remove or replace them under ${dirs.root}, then POST /restart-module`;
      if (cfg.mode === 'enforce') throw Object.assign(new Error(text), {code: 'MODULE_SANDBOX_REFUSED'});
      cfg.report('links', text);
    }
  }
  // Everything that can fail comes before the bridge, which holds open ports.
  const moduleRoot = realDir(path.resolve(cfg.modulePath));
  const installDir = realDir(INSTALL_DIR);
  const codeRoots = require('./identity').codeRootsFor(installDir, require('../hardened-realpaths').realpathSync, moduleRootsOf(cfg.options).concat([moduleRoot]));
  const namespace = createNamespace({moduleRoot: moduleRoot, dataDir: dirs.data, tmpDir: dirs.tmp,
    declared: cfg.declared || [], protectedPaths: protectedPaths(cfg.options)});
  await namespace.prepare();
  namespace.refused.forEach((r) => cfg.report('refused', `${r.path} (${r.reason})`));
  const key = `${cfg.name}#${++spawned}`;
  const sched = sharedScheduler();
  // One pool for /data and /tmp, counted from what the walk measured; not
  // counted under off.
  const quota = (usage == null || cfg.limits == null) ? null : new Quota({maxBytes: cfg.limits.diskMb * 1024 * 1024,
    maxEntries: cfg.limits.diskEntries, enforce: cfg.mode === 'enforce', report: cfg.report, bytes: usage.bytes, entries: usage.entries});
  const broker = new FsBroker({name: cfg.name, mode: cfg.mode, namespace: namespace, cwd: '/app', report: cfg.report,
    schedule: (fn) => sched.submit(key, fn), quota: quota, denied: cfg.mode === 'off' ? null : deniedSet(),
    // the module's own package.json: its countinghouse.calls are its
    // declarations, so no write reaches it, under audit too (R2-1 Task 4)
    ownManifest: cfg.mode === 'off' ? null : new DeniedSet([path.join(moduleRoot, 'package.json')])});
  const bridge = createBridge({broker: broker, scheduler: sched, key: key});
  return {broker, bridge, namespace, dirs, moduleRoot, installDir, codeRoots,
    usage: usage == null ? null : {bytes: usage.bytes, entries: usage.entries}};
}

module.exports = {createForWorker, protectedPaths, sharedScheduler, deniedSet, realDir, moduleRootsOf, INSTALL_DIR};
