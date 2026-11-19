'use strict';
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
const {moduleText} = require('../module-text');

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

// The links countinghouse is reached through, each by its place
// (lib/fs-broker/install-links.js; #280's follow-up): no module is given a
// writable root that holds one (lib/fs-broker/namespace.js prepare). Whoever
// repoints such a link chooses what the next start runs, or where it keeps
// its modules, its data, its store, its policy. The paths walked:
//   - the install, as it is run (a link in it only under --preserve-symlinks);
//   - the file the runtime was started from, as it was named: Node runs the
//     main file by its real path, but the operator's command still goes
//     through the link (a "current" link, npm's bin link). bin/countinghouse
//     is a shell script that runs framework.js by its real path, so it says
//     how it was started itself (COUNTINGHOUSE_STARTED_FROM);
//   - every configured path (protectedPaths) and every module root
//     (--modulePath, each --loadModule), the server's own and the spawn's.
// They are not protected paths: one of those is a denied tree, followed to
// its real path, and a link's leads to what it protects, which for the
// install stays readable but for its secrets.
//
// Not only the links: every name on such a path is on the host's way to it
// (install-links.js: a directory a link's target leaves with ".." decides
// where that ".." leaves; the reviewer's security review of #282, I1). For
// the install, the start file and a configured path every name is taken:
// besides the links and what a ".." left, those are the directories above
// the path or above what its links lead to, refused to a declaration
// already, and, for the start file, the directories above a launcher that
// is no link. For a module root only the links and what a ".." left: a
// module may be given a writable root above another module's code, as
// before, and the broker refuses writes in that code and renames of it and
// of the directories above it.
//
// A path's walk is kept once its whole path has resolved, and then holds
// for the process's life, like the real paths: a link repointed while the
// server runs is seen at the next start. A path that did not resolve (its
// end not there yet) is walked again at the next spawn. Under --hardened
// the names are the parent's (the relaunched server may not lstat above its
// grants), handed over by path. A process restricted another way, or a
// path the parent handed nothing for, cannot be looked for, and the spawn
// is refused: it never goes on without them (M1).
const walks = new Map();   // path -> its walk, once complete
const unique = (list) => [...new Set(list)];
const insideOf = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
// How the runtime was started, as it was named: the main file Node was
// given, and what the launcher says (bin/countinghouse). Either only adds a
// path to walk.
function startedFrom() {
  const named = [process.argv[1], process.env.COUNTINGHOUSE_STARTED_FROM];
  return named.filter((p) => typeof(p) === 'string' && p.length <= 4096 && path.isAbsolute(p)).map((p) => path.resolve(p));
}
// The paths walked, each {path, all}: all, every name on it is taken; not
// all (a module root), its links and what a ".." left.
// The server's own, from its own options:
function serverWalks() {
  const global = require('../cli-options');
  const full = unique([path.resolve(INSTALL_DIR)].concat(startedFrom(), protectedPaths(global)));
  const roots = unique(moduleRootsOf(global)).filter((p) => !full.includes(p));
  return full.map((p) => ({path: p, all: true})).concat(roots.map((p) => ({path: p, all: false})));
}
// and a spawn's own. One inside the server's module data path is reached
// through that path's names and no other: what is there is the runtime's to
// make (a validation's throwaway data directory, one a validation). So it
// is not walked, or kept, for itself; under --hardened it could not be.
function spawnWalks(options, server) {
  const global = require('../cli-options');
  const have = server.map((w) => w.path);
  const dataPath = typeof(global.moduleDataPath) === 'string' ? path.resolve(process.cwd(), global.moduleDataPath) : null;
  const skip = (p) => have.includes(p) || (dataPath != null && insideOf(p, dataPath));
  const full = unique(protectedPaths(options)).filter((p) => !skip(p));
  const roots = unique(moduleRootsOf(options)).filter((p) => !skip(p) && !full.includes(p));
  return full.map((p) => ({path: p, all: true})).concat(roots.map((p) => ({path: p, all: false})));
}
// one path's names: its links first
// The broker's refusal (module-manager answers it as the runtime's own).
// Its text can name links under the module's data, names the module chose:
// the one module-text rule (lib/module-text.js), so none forges a log line
// (the Reviewer's second high review of #445, R1 and 7).
function sandboxRefused(text) {
  return Object.assign(new Error(moduleText(text)), {code: 'MODULE_SANDBOX_REFUSED'});
}

function namesOn(w) {
  const handed = require('../hardened-realpaths').linkPlaces();
  if (handed != null && Object.prototype.hasOwnProperty.call(handed, w.path)) return handed[w.path];
  let walk = walks.get(w.path);
  if (walk == null) {
    try {
      walk = require('./install-links').walkLinks(w.path);
    } catch (err) {
      if (err.code !== 'ERR_ACCESS_DENIED') throw err;
      throw sandboxRefused(`countinghouse cannot look for the links on ${w.path} under Node's permission model (--permission): ` +
        'start it with --hardened, which finds them before it restricts itself');
    }
    if (walk.complete) walks.set(w.path, walk);
  }
  return unique(walk.places.concat(w.all ? walk.passed : walk.left));
}
function protectedLinks(options) {
  const server = serverWalks();
  const out = [];
  for (const w of server.concat(spawnWalks(options, server))) for (const place of namesOn(w)) if (!out.includes(place)) out.push(place);
  return out;
}
// (the paths a spawn with these options has walked)
function pathsWalked(options) {
  const server = serverWalks();
  return server.concat(spawnWalks(options, server)).map((w) => w.path);
}
// The server's own paths' names, found now, for the --hardened hand-over
// (lib/hardened-launch.js relaunch): {path: names}.
function serverLinkPlaces() {
  const out = {};
  for (const w of serverWalks()) out[w.path] = namesOn(w);
  return out;
}

// What no module may declare, or declare an ancestor of (spec section 1).
function protectedPaths(options) {
  const cwd = process.cwd();
  return [INSTALL_DIR, options.modulePath, options.moduleDataPath, settingsHomeOf(options),
    // the local store (metering, kv, the profile's identity secret; LM1)
    (options.store === 'local') ? options.storePath : null,
    options.authConfigPath || path.join(cwd, 'auth.json'),
    options.deviceConfigPath || path.join(cwd, 'config', 'devices'),
    options.modulePolicy,
    // an operator's modules' settings (module settings, section 4.7)
    options.moduleSettings,
    // where each credential may be sent (lib/remote/credentials.js): a
    // module that rewrote it could send one to an origin of its own
    options.remoteCredentials].filter((p) => p != null).map((p) => path.resolve(cwd, p));
}

// Every module root this server knows (--modulePath and each --loadModule),
// never a countinghouse code root (identity.codeRootsFor).
// The protected trees for a spawn: from the server's own options (a
// validation's spawn options swap --moduleDataPath for a throwaway, and the
// real one must stay protected meanwhile: #260's review, G1) and the spawn's,
// with every module root (--modulePath and each --loadModule, G2); the
// module's own /app is excepted by the broker. Not the install: it is
// readable but for its secrets (installSecrets).
function deniedTreesFor(options) {
  const global = require('../cli-options');
  const all = [].concat(protectedPaths(global), protectedPaths(options), moduleRootsOf(global), moduleRootsOf(options));
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

// A module's /data and /tmp never overlap its own code, either way round:
// under enforce /app stays read-only by every name, so what the load-time
// tree check read is what runs (a root inside its /data could have an
// ancestor renamed and linked away); under audit it is said; in every mode
// an overlapping /tmp is never emptied, which would delete the module's own
// files. Judged first on the planned paths, before anything is made or
// emptied there, and again on the real ones once made (the high reviews of
// #451 and #452): a directory not made yet by its nearest existing
// ancestor's real path -- under --hardened's permission model never above
// the --moduleDataPath grant root, which is answered from the parent's
// recorded real paths, the path as given above it; containment by the
// platform's own rule (a drive letter's case, a drive's root).
function plannedDirs(cfg) {
  return (cfg.session != null) ? moduleData.sessionDirsFor(cfg.options.moduleDataPath, cfg.name, cfg.session)
    : moduleData.dirsFor(cfg.options.moduleDataPath, cfg.name);
}

function realOrPlanned(p, base) {
  const inside = require('./identity').insideHostFor(process.platform);
  let at = path.resolve(p);
  const rest = [];
  for (;;) {
    // (above the grant root, resolved where that can be done -- a link
    // into the module's code there is seen before anything is made; under
    // --hardened's permission model never resolved there, an ancestor it
    // grants nothing on: the path as given, the real one judged again once
    // made)
    const above = !inside(at, base);
    if (above && process.permission != null) return path.resolve(p);
    try { return path.join(realDir(at), ...rest.reverse()); } catch (e) {
      if (above && e != null && e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return path.resolve(p);
      if (!above && (e == null || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR'))) throw sandboxRefused(`cannot resolve the module's data directory ${p}: ${e && e.code}`);
    }
    if (path.dirname(at) === at) return path.resolve(p);
    rest.push(path.basename(at));
    at = path.dirname(at);
  }
}

async function createForWorker(cfg) {
  const moduleRoot = realDir(path.resolve(cfg.modulePath));
  const insideHost = require('./identity').insideHostFor(process.platform);
  // (this module's own code, and every other module's: each --loadModule
  // directory whole, and in a --modulePath folder any directory with a
  // package.json between the --moduleDataPath root and the folder -- a
  // scoped layout's too; never below that root, where the module's own data
  // is and what it writes there counts for nothing -- or a data directory
  // holding the folder; one beside the modules in the folder is none of
  // theirs. A package.json that can't be looked at counts
  // as one. Each spelling, real and as given, both ways round, so a root
  // realDir can't answer is still compared. The high reviews of #452)
  const spellings = (p) => { const given = path.resolve(p); try { const r = realDir(given); return r === given ? [given] : [r, given]; } catch (e) { return [given]; } };
  const flat = (lists) => lists.reduce((a, b) => a.concat(b), []);
  const wholeRoots = flat([spellings(cfg.modulePath)].concat([].concat(cfg.options.localModulePath || []).filter((p) => typeof(p) === 'string').map(spellings)));
  const folders = flat([].concat(cfg.options.modulePath || []).filter((p) => typeof(p) === 'string').map(spellings));
  const hasManifest = (dir) => {
    try { fs.statSync(path.join(dir, 'package.json')); return true; } catch (e) { return e.code !== 'ENOENT' && e.code !== 'ENOTDIR'; }
  };
  const inModuleOf = (p) => folders.some((folder) => {
    if (insideHost(folder, p)) return true;
    if (!insideHost(p, folder)) return false;
    for (let at = p; insideHost(at, folder) && !insideHost(folder, at); at = path.dirname(at)) if (hasManifest(at)) return true;
    return false;
  });
  // (judged once, from the --moduleDataPath root as given and as it
  // resolves: what module code writes under it never decides)
  const baseInModule = spellings(cfg.options.moduleDataPath).some(inModuleOf);
  const overlapping = new Set();
  const judgeOverlap = (what, dir, real) => {
    const here = [real, path.resolve(dir)];
    if (!baseInModule && !here.some((p) => wholeRoots.some((root) => insideHost(p, root) || insideHost(root, p)) || folders.some((folder) => insideHost(folder, p)))) return;
    const text = `the module's ${what} (${dir}) and its own code overlap -- set --moduleDataPath apart from the module`;
    if (cfg.mode === 'enforce') throw sandboxRefused(text);
    if (overlapping.has(what)) return;
    overlapping.add(what);
    if (cfg.mode === 'audit') cfg.report('overlap', text);
  };
  let dirs;
  try {
    // (an unusable name is ensureDirs's to say)
    if (moduleData.safeName(cfg.name)) {
      const planned = plannedDirs(cfg);
      const base = path.resolve(cfg.options.moduleDataPath);
      // (a planned path that can't be resolved refuses under enforce;
      // otherwise the real one, once made, is judged)
      const plannedReal = (p) => { try { return realOrPlanned(p, base); } catch (e) { if (cfg.mode === 'enforce') throw e; return null; } };
      const realData = plannedReal(planned.data);
      const realTmp = plannedReal(planned.tmp);
      if (realData != null) judgeOverlap('/data', planned.data, realData);
      if (realTmp != null) judgeOverlap('/tmp', planned.tmp, realTmp);
    }
    // R1: a session worker's /data and /tmp are its session's partition
    dirs = (cfg.session != null) ? await moduleData.ensureSessionDirs(cfg.options.moduleDataPath, cfg.name, cfg.session)
      : await moduleData.ensureDirs(cfg.options.moduleDataPath, cfg.name);
    // (and the real ones, now made)
    judgeOverlap('/data', dirs.data, realDir(dirs.data));
    judgeOverlap('/tmp', dirs.tmp, realDir(dirs.tmp));
  } catch (e) {
    if (e != null && e.code === 'MODULE_SANDBOX_REFUSED') throw e;
    // Every mode creates it, so a read-only $HOME (systemd ProtectHome, a
    // read-only container root) must say what to do (review I6).
    let where = cfg.options.moduleDataPath;
    try { where = moduleData.dirsFor(cfg.options.moduleDataPath, cfg.name).root; } catch (e2) { /* unsafe name: keep the base */ }
    throw new Error(`cannot create the module data directory ${where}: ${e.message} -- set --moduleDataPath to a writable directory`);
  }
  // The spawn walk (spec section 3): /tmp emptied in every mode, never
  // through a link; then, when counting, /data and /tmp measured and checked
  // for links that can lead outside.
  // A session worker takes its module's shared quota first (built: its build
  // walk finished; and held by this spawn, so not dropped meanwhile), then
  // empties its /tmp through it (lib/module-manager.js emptySessionTmp gives
  // back what its share counted there): never while a build walks it.
  const sessionQuota = (typeof(cfg.sharedQuota) === 'function' && cfg.mode !== 'off') ? await cfg.sharedQuota() : null;
  // (an overlapping /tmp is never emptied -- it holds module code -- and a
  // session's share of it stays counted: its files are still there)
  if (overlapping.has('/tmp')) { /* kept */ } else if (typeof(cfg.emptyTmp) === 'function') await cfg.emptyTmp(dirs.tmp, sessionQuota);
  else await spawnWalk.emptyTmp(dirs.tmp);
  let usage = null;
  if (cfg.mode !== 'off') {
    usage = await spawnWalk.measure([[dirs.data, '/data'], [dirs.tmp, '/tmp']], {maxListed: 10});
    if (usage.links.length > 0) {
      const text = 'links that could lead outside the module\'s data (a symlink with an absolute target, or a hard link ' +
        `with a name outside /data and /tmp): ${usage.links.map((l) => moduleText(l, 200)).join(', ')}${usage.moreLinks > 0 ? ` and ${usage.moreLinks} more` : ''}` +
        ` -- remove or replace them under ${dirs.root}, then POST /restart-module`;
      if (cfg.mode === 'enforce') throw sandboxRefused(text);
      cfg.report('links', text);
    }
  }
  // Everything that can fail comes before the bridge, which holds open ports.
  const installDir = realDir(INSTALL_DIR);
  // from the install as countinghouse runs from it, not its real path: the
  // worker loads its own files and looks up its dependencies by that
  // spelling, so each root is listed under it and under its real path (#272:
  // on Windows an 8.3 short name, C:\Users\RUNNER~1\...)
  const codeRoots = require('./identity').codeRootsFor(path.resolve(INSTALL_DIR), require('../hardened-realpaths').realpathSync, moduleRootsOf(cfg.options).concat([moduleRoot]));
  // (postman-request's own closure: the roots of the lockdown's one late
  // load under audit, lib/module-lockdown.js; none other)
  const lateRoots = cfg.mode === 'audit' ? require('./identity').lateRootsFor(path.resolve(INSTALL_DIR), require('../hardened-realpaths').realpathSync, moduleRootsOf(cfg.options).concat([moduleRoot]), fs) : [];
  const namespace = createNamespace({moduleRoot: moduleRoot, dataDir: dirs.data, tmpDir: dirs.tmp, mode: cfg.mode,
    declared: cfg.declared || [], protectedPaths: protectedPaths(cfg.options), protectedLinks: protectedLinks(cfg.options)});
  await namespace.prepare();
  namespace.refused.forEach((r) => cfg.report('refused', `${r.path} (${r.reason})`));
  if (cfg.mode === 'audit') namespace.ownCodeWritable.forEach((p) => cfg.report('declared', `${p} (a writable path over the module's own code: refused under enforce)`));
  const key = `${cfg.name}#${++spawned}`;
  const sched = sharedScheduler();
  // One pool for /data and /tmp, counted from what the walk measured; not
  // counted under off.
  // R1: a session worker shares its module's (cfg.sharedQuota, all its
  // partitions together; lib/module-manager.js sessionQuota)
  const quota = (typeof(cfg.sharedQuota) === 'function') ? (usage == null ? null : sessionQuota)
    : (usage == null || cfg.limits == null) ? null : new Quota({maxBytes: cfg.limits.diskMb * 1024 * 1024,
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
    // the local store, the auth and device config, the policy, the remote
    // credentials file, ch-local's
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
  return {broker, bridge, namespace, dirs, moduleRoot, installDir, codeRoots, lateRoots,
    usage: usage == null ? null : {bytes: usage.bytes, entries: usage.entries}};
}

module.exports = {createForWorker, protectedPaths, protectedLinks, serverLinkPlaces, pathsWalked, settingsHomeOf, sharedScheduler, deniedSet, realDir, moduleRootsOf, INSTALL_DIR};
