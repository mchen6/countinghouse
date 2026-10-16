// --hardened: re-launch this server under Node's permission model
// (docs/superpowers/specs/2026-10-15-module-sandbox-foundation-design.md,
// section 5). The flags have to be given when Node starts, so framework.js
// calls relaunch() before doing anything else and the child, which sees
// process.permission, carries on normally.
const path  = require('path');
const spawn = require('child_process').spawn;

function insideRoot(modulePath, root) {
  const p = path.resolve(modulePath);
  const r = path.resolve(root);
  return p === r || p.startsWith(r + path.sep);
}

function permissionFlags(options, installDir, cwd) {
  const read  = [installDir, path.resolve(cwd, options.modulePath)];
  const write = [path.resolve(cwd, options.modulePath)];
  if (options.authConfigPath != null) read.push(path.resolve(cwd, options.authConfigPath));
  if (options.deviceConfigPath != null) read.push(path.resolve(cwd, options.deviceConfigPath));
  else read.push(path.resolve(cwd, 'config', 'devices'));
  if (options.modulePolicy != null) read.push(path.resolve(cwd, options.modulePolicy));

  const flags = ['--permission', '--allow-worker'];
  // sqlite3 is a native addon. framework.js loads it for the module registry
  // (lib/device-db) whenever no --loadModule is given, and the sqlite auth
  // provider loads it too. One flag covers both.
  let addons = options.localModulePath == null;
  if (options.authProvider === 'sqlite') {
    const db = path.resolve(cwd, options.authConfigPath || 'auth.sqlite3');
    read.push(path.dirname(db));
    write.push(path.dirname(db));
    addons = true;
  }
  if (addons) flags.push('--allow-addons');
  if (options.authoringTools === true) flags.push('--allow-child-process');
  read.forEach((p) => flags.push(`--allow-fs-read=${p}`));
  write.forEach((p) => flags.push(`--allow-fs-write=${p}`));
  return flags;
}

function relaunch(flags) {
  const child = spawn(process.execPath, flags.concat(process.execArgv, process.argv.slice(1)), {stdio: 'inherit'});
  ['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => child.kill(sig)));
  child.on('exit', (code, signal) => process.exit(code != null ? code : (signal != null ? 1 : 0)));
}

module.exports = {insideRoot, permissionFlags, relaunch};
