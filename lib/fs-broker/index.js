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

// ch-local's home (the directory of --settingsFile), or null. It holds the
// daemon's session secret (run/), the launcher (bin/), the install, every
// module's code and data, and the settings protocol, so it is no module's
// (#253, the reviewer's ruling): no module may declare it, anything in it or
// above it (protectedPaths); every path in it is always denied, reads and
// writes, except the module's own namespace roots (its /app, /data, /tmp:
// the broker's deniedHome); the settings file and its history are also
// known by identity (deniedPathsFor), so a hard link elsewhere is refused;
// and it and every directory above it are refused to renames (the ancestor
// guard).
function settingsHomeOf(options) {
  if (options == null || typeof(options.settingsFile) !== 'string' || options.settingsFile === '') return null;
  return path.dirname(path.resolve(process.cwd(), options.settingsFile));
}

// The links the install is reached through, each by its place
// (lib/fs-broker/install-links.js), once per process: under --hardened the
// parent's list (the relaunched server may not lstat above its grants),
// otherwise found here. Like the real paths, they hold for the process's
// life: a link repointed while the server runs is seen at the next start.
let installLinks = null;
function installLinkPlaces() {
  if (installLinks == null) {
    const handed = require('../hardened-realpaths').installLinks();
    installLinks = (handed != null) ? handed : require('./install-links').linkLocations(INSTALL_DIR);
  }
  return installLinks;
}

// The paths countinghouse is configured with.
function configuredPaths(options) {
  const cwd = process.cwd();
  return [INSTALL_DIR, options.modulePath, options.moduleDataPath, settingsHomeOf(options),
    // the local store (metering, kv, the profile's identity secret; LM1)
    (options.store === 'local') ? options.storePath : null,
    options.authConfigPath || path.join(cwd, 'auth.json'),
    options.deviceConfigPath || path.join(cwd, 'config', 'devices'),
    options.modulePolicy].filter((p) => p != null).map((p) => path.resolve(cwd, p));
}

// What no module may declare, or declare an ancestor of (spec section 1):
// the configured paths, and each link the install is reached through, where
// the link is -- a root holding one could repoint the install (#280's
// follow-up). A link's real path is what it leads to, so a root declared
// inside that is refused with it: more than is needed, and only where the
// install is run through a link above its own directory.
function protectedPaths(options) {
  const paths = configuredPaths(options);
  return paths.concat(installLinkPlaces().filter((p) => !paths.includes(p)));
}

// Every module root this server knows (--modulePath and each --loadModule),
// never a countinghouse code root (identity.codeRootsFor).
// The protected trees for a spawn: from the server's own options (a
// validation's spawn options swap --moduleDataPath for a throwaway, and the
// real one must stay protected meanwhile: #260's review, G1) and the spawn's,
// with every module root (--modulePath and each --loadModule, G2); the
// module's own /app is excepted by the broker. Not the install: it is
// readable but for its secrets (installSecrets). Nor a link it is reached
// through (protectedPaths): a denied tree follows its directory to its real
// path, which for such a link is the install, or a directory holding it.
function deniedTreesFor(options) {
  const global = require('../cli-options');
  const all = [].concat(configuredPaths(global), configuredPaths(options), moduleRootsOf(global), moduleRootsOf(options));
  const install = path.resolve(INSTALL_DIR);
  return [...new Set(all)].filter((p) => p !== install);
}

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
  // from the install as countinghouse runs from it, not its real path: the
  // worker loads its own files and looks up its dependencies by that
  // spelling, so each root is listed under it and under its real path (#272:
  // on Windows an 8.3 short name, C:\Users\RUNNER~1\...)
  const codeRoots = require('./identity').codeRootsFor(path.resolve(INSTALL_DIR), require('../hardened-realpaths').realpathSync, moduleRootsOf(cfg.options).concat([moduleRoot]));
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
    // the module's own package.json (its countinghouse.calls are its
    // declarations) and the pin records' directory (cfg.pinsDir,
    // lib/manifest-pins.js): no write the broker sees reaches them, under
    // audit too; the routes it does not see are the pin's to record
    ownManifest: cfg.mode === 'off' ? null : new DeniedSet([path.join(moduleRoot, 'package.json')]),
    pinsDir: cfg.mode === 'off' ? null : (cfg.pinsDir || null),
    // every protected path but the install (every module's code and data,
    // the local store, the auth and device config, the policy, ch-local's
    // home), every path in each refused but the module's own base roots, and
    // each and the directories above it to renames (#253's follow-up). The
    // install is countinghouse's public code: reading it gives nothing away,
    // and in a checkout it is the whole repository a module may be pointed
    // at; it can't be declared (protectedPaths), under ch-local it is inside
    // the home, and writes to it are the audit-writes rule's
    deniedTrees: cfg.mode === 'off' ? null : deniedTreesFor(cfg.options),
    // the install's top-level dot entries and auth.json (#260's review)
    installSecrets: cfg.mode === 'off' ? null : path.resolve(INSTALL_DIR)});
  const bridge = createBridge({broker: broker, scheduler: sched, key: key});
  return {broker, bridge, namespace, dirs, moduleRoot, installDir, codeRoots,
    usage: usage == null ? null : {bytes: usage.bytes, entries: usage.entries}};
}

module.exports = {createForWorker, protectedPaths, deniedTreesFor, installLinkPlaces, settingsHomeOf, sharedScheduler, deniedSet, realDir, moduleRootsOf, INSTALL_DIR};
