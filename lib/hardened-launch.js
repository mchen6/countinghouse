// --hardened: re-launch this server under Node's permission model
// (docs/superpowers/specs/2026-10-15-module-sandbox-foundation-design.md,
// section 5). The flags have to be given when Node starts, so framework.js
// calls relaunch() before doing anything else and the child, which sees
// process.permission, carries on normally.
const fs    = require('fs');
const path  = require('path');
const spawn = require('child_process').spawn;

// Symlinks resolved, so a link under the root cannot point a module outside it.
// Under --hardened the root's real path comes from the parent (a granted
// directory that Node may refuse to realpath; lib/hardened-realpaths.js).
function real(p) {
  try { return require('./hardened-realpaths').realpathSync(p); } catch (e) { return path.resolve(p); }
}

function insideRoot(modulePath, root) {
  const p = real(modulePath);
  const r = real(root);
  return p === r || p.startsWith(r + path.sep);
}

// realpath: how directories are resolved (default fs.realpathSync.native); the
// relaunch passes a recorder so the child gets these results (see below).
function permissionFlags(options, installDir, cwd, realpath) {
  const read  = [installDir, path.resolve(cwd, options.modulePath), path.resolve(cwd, options.moduleDataPath)];
  // Dependencies npm hoisted beside an installed countinghouse (identity.codeRootsFor);
  // those inside the install directory are covered by its grant already.
  require('./fs-broker/identity').codeRootsFor(installDir, realpath || fs.realpathSync.native, require('./fs-broker').moduleRootsOf(options)).forEach((r) => {
    if (r !== installDir && !r.startsWith(`${installDir}/`) && !read.includes(r)) read.push(r);
  });
  const write = [path.resolve(cwd, options.modulePath), path.resolve(cwd, options.moduleDataPath)];
  // The file auth provider (the default; unused under --debug) reads
  // auth.json, and on first run writes it with a demo key
  // (lib/auth/file-provider.js). Write is granted only for that first run.
  if (options.debug !== true && options.authProvider === 'file') {
    const authFile = path.resolve(cwd, options.authConfigPath || 'auth.json');
    read.push(authFile);
    if (!fs.existsSync(authFile)) write.push(authFile);
  }
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
  // Node 26 adds a network permission: under --permission without it, the
  // server can neither listen nor reach Redis. --hardened has never
  // restricted the network (Node 24 has no such permission), so it grants
  // it where Node has the flag, until the network broker (sandbox parts 3
  // and 4). Node's ExperimentalWarning for the flag is left visible.
  if (process.allowedNodeEnvironmentFlags.has('--allow-net')) flags.push('--allow-net');
  read.forEach((p) => flags.push(`--allow-fs-read=${p}`));
  write.forEach((p) => flags.push(`--allow-fs-write=${p}`));
  return flags;
}

// Node grants a subtree only for a directory that exists when it starts; a
// grant for a missing path covers that path alone. So --moduleDataPath is
// created here, before the relaunch, or no module could create its data
// directory under --permission.
function prepareGrants(options, cwd) {
  // The module folder, which the child would create first thing anyway: the
  // probe must see it as the child will (H1, probeGrants).
  fs.mkdirSync(path.resolve(cwd, options.modulePath), {recursive: true});
  const dir = path.resolve(cwd, options.moduleDataPath);
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  fs.chmodSync(dir, 0o700);
}

// The paths in --allow-fs-read/--allow-fs-write flags, each once.
function grantedPaths(flags) {
  const out = [];
  flags.forEach((f) => {
    const m = /^--allow-fs-(?:read|write)=(.+)$/.exec(f);
    if (m != null && !out.includes(m[1])) out.push(m[1]);
  });
  return out;
}

// Pairs of grants where the second extends the first's name (/x/ch and
// /x/ch_data; /nm/redis and /nm/redis-commands), not a path inside it: the
// shape Node's permission model mishandles (nodejs/node#66812).
function grantOverlaps(flags) {
  const paths = grantedPaths(flags).slice().sort();
  const pairs = [];
  paths.forEach((a) => paths.forEach((b) => {
    if (b.length > a.length && b.startsWith(a) && b[a.length] !== '/') pairs.push([a, b]);
  }));
  return pairs;
}

// Runs, under exactly these flags, the one call countinghouse makes on a
// granted directory itself: a sync realpath (the install directory at
// startup, each dependency directory in the code-root walk), in the native
// form countinghouse uses (FB3; lib/hardened-realpaths.js). Node 24.22 and
// later refuse it when another grant extends the directory's name
// (nodejs/node#66812); the native form is refused on earlier 24.x too
// (24.21.0, measured), as the async one is. stat, lstat, readdir and
// existsSync of such a directory are refused on earlier Node too, where
// these layouts work, because
// countinghouse only makes them on paths inside it; probing them would refuse
// working setups. Behaviour, not a version check, so it stays right when Node
// fixes the bug. opts.spawnSync and opts.existsDir are for tests.
//
// Also, for each directory in opts.writable, the child's first act on its
// module folder (framework.js): mkdirSync(recursive) and accessSync(W_OK).
// Those are refused for --modulePath X beside --moduleDataPath X_data on
// every 24.x, the parent's precomputed real path does not spare them, and
// the relaunched child used to die on them naming nothing (review H1).
// Node decides on a granted path as it was when the process started: a
// folder missing then is not refused later, one present is. So the module
// folder must exist before the probe starts (prepareGrants), as it does when
// the child starts.
const WRITABLE_MARK = ':writable:';
const PROBE = `const fs = require('fs'); const refused = [];
const args = process.argv.slice(1); const cut = args.indexOf('${WRITABLE_MARK}');
const real = cut === -1 ? args : args.slice(0, cut); const writable = cut === -1 ? [] : args.slice(cut + 1);
for (const p of real) {
  try { fs.realpathSync.native(p); } catch (e) { refused.push({path: p, op: 'realpathSync', code: e.code}); }
}
for (const p of writable) {
  try { fs.mkdirSync(p, {recursive: true}); fs.accessSync(p, fs.constants.W_OK); } catch (e) { refused.push({path: p, op: 'mkdir/access', code: e.code}); }
}
process.stdout.write(JSON.stringify({refused}));`;

// opts.skip: directories the child will not realpath itself (the parent's
// precomputed ones), so their refusal does not matter. opts.writable: the
// module folder(s) the child creates and checks for write access at start;
// probed whether skipped or not.
function probeGrants(flags, opts) {
  opts = opts || {};
  const skip = opts.skip || {};
  const writable = opts.writable || [];
  const run = opts.spawnSync || require('child_process').spawnSync;
  const isDir = opts.existsDir || ((p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } });
  const dirs = grantedPaths(flags).filter((p) => !Object.prototype.hasOwnProperty.call(skip, p)).filter(isDir);
  if (dirs.length === 0 && writable.length === 0) return {ok: true, refused: []};
  const args = writable.length > 0 ? dirs.concat([WRITABLE_MARK], writable) : dirs;
  const r = run(process.execPath, flags.concat(['-e', PROBE], args), {encoding: 'utf8', timeout: 20000});
  let answer = null;
  try { answer = JSON.parse(String(r.stdout || '')); } catch (e) { answer = null; }
  if (r.status !== 0 || answer == null || !Array.isArray(answer.refused)) {
    const why = (r.error != null ? r.error.message : '') || String(r.stderr || '').trim() || `exit ${r.status}`;
    return {ok: false, refused: [], error: why.slice(0, 500)};
  }
  return {ok: answer.refused.length === 0, refused: answer.refused};
}

function refusalMessage(probe, overlaps, version) {
  const lines = [`--hardened: Node ${version}'s permission model refuses this server's file grants, so it would fail after relaunching.`];
  if (probe.error != null) {
    lines.push(`  The grant check could not run: ${probe.error}`);
  } else {
    probe.refused.slice(0, 5).forEach((r) => lines.push(`  refused: ${r.op} ${r.path} (${r.code})`));
  }
  if (overlaps.length > 0) {
    lines.push('  Granted paths whose name another grant extends (nodejs/node#66812, https://github.com/nodejs/node/issues/66812):');
    overlaps.slice(0, 10).forEach(([a, b]) => lines.push(`    ${a} and ${b}`));
  } else {
    lines.push('  See nodejs/node#66812 (https://github.com/nodejs/node/issues/66812).');
  }
  lines.push('  What to do: give the granted paths you configured (--moduleDataPath, --modulePath, the auth, device' +
    ' config and policy paths) names that do not extend another grant\'s, e.g. $HOME/.countinghouse/module_data;' +
    ' or run without --hardened.');
  return lines.join('\n');
}

// What the child would realpath at startup that is a grant root: the
// install directory (both spellings countinghouse uses), the module roots and
// the protected paths. The code-root walk is recorded by permissionFlags.
// Paths that do not exist are left to the child, which answers as before.
function precompute(options, installDir, rec) {
  const broker = require('./fs-broker');
  [installDir, broker.INSTALL_DIR].concat(broker.moduleRootsOf(options), broker.protectedPaths(options)).forEach((p) => {
    try { rec.realpath(p); } catch (e) { /* missing: the child sees the same */ }
  });
}

// known: the parent's real paths (lib/hardened-realpaths.js), sent on fd 3.
function relaunch(flags, known) {
  const realpaths = require('./hardened-realpaths');
  const child = spawn(process.execPath, flags.concat(process.execArgv, process.argv.slice(1)),
    {stdio: ['inherit', 'inherit', 'inherit', 'pipe'], env: Object.assign({}, process.env, realpaths.childEnv())});
  realpaths.send(child, known || {});
  ['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => child.kill(sig)));
  child.on('error', (e) => {
    console.error(`--hardened: could not start the server under --permission: ${e.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code != null ? code : (signal != null ? 1 : 0)));
}

module.exports = {insideRoot, permissionFlags, prepareGrants, precompute, relaunch, grantOverlaps, probeGrants, refusalMessage};
