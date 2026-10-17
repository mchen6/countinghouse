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

const INSTALL_DIR = path.join(__dirname, '..', '..');
let scheduler = null;
let spawned = 0;

function sharedScheduler() {
  if (scheduler == null) scheduler = new FsScheduler({globalCap: FsScheduler.capFor(process.env.UV_THREADPOOL_SIZE)});
  return scheduler;
}

// What no module may declare, or declare an ancestor of (spec section 1).
function protectedPaths(options) {
  const cwd = process.cwd();
  return [INSTALL_DIR, options.modulePath, options.moduleDataPath,
    options.authConfigPath || path.join(cwd, 'auth.json'),
    options.deviceConfigPath || path.join(cwd, 'config', 'devices'),
    options.modulePolicy].filter((p) => p != null).map((p) => path.resolve(cwd, p));
}

// A directory's real path, with the sync realpath: one syscall at spawn.
// Under --permission, Node 24 refuses async operations on a granted directory
// itself when another grant extends its name (/x/countinghouse beside
// /x/countinghouse_module_data, the default layout under $HOME); sync calls
// are unaffected (test/fs-broker/10-permission-prefix.js). Resolving the
// directory itself, not a file inside it, keeps a module from choosing its
// own /app with a symlinked package.json.
function realDir(dir) {
  return fs.realpathSync(dir);
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
  // Everything that can fail comes before the bridge, which holds open ports.
  const moduleRoot = realDir(path.resolve(cfg.modulePath));
  const installDir = realDir(INSTALL_DIR);
  const namespace = createNamespace({moduleRoot: moduleRoot, dataDir: dirs.data, tmpDir: dirs.tmp,
    declared: cfg.declared || [], protectedPaths: protectedPaths(cfg.options)});
  await namespace.prepare();
  namespace.refused.forEach((r) => cfg.report('refused', `${r.path} (${r.reason})`));
  const key = `${cfg.name}#${++spawned}`;
  const sched = sharedScheduler();
  const broker = new FsBroker({name: cfg.name, mode: cfg.mode, namespace: namespace, cwd: '/app', report: cfg.report,
    schedule: (fn) => sched.submit(key, fn)});
  const bridge = createBridge({broker: broker, scheduler: sched, key: key});
  return {broker, bridge, namespace, dirs, moduleRoot, installDir};
}

module.exports = {createForWorker, protectedPaths, sharedScheduler, realDir, INSTALL_DIR};
