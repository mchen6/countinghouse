'use strict';
// Packs in place (part 2, plan Task A3; docs/superpowers/specs/
// 2026-11-14-packs-in-place-and-settings-tool-design.md section 2): a pack
// loaded, unloaded or reloaded while the runtime serves, at ch-local start's
// request over the control channel (lib/control-channel.js), under the same
// checks as at start. Only in the single-identity profile, under
// --workerThread.
//
// A pack is a scenario and its parts (lib/module-roles.js), named by the
// scenario's package name (the reviewer's ruling). The runtime holds one
// version of a module: a part two packs share is loaded once, and a pack
// whose part is loaded at another version is refused whole
// (PART_VERSION_CONFLICT, Task A1).
//
// The operator's ceiling binds a load or reload in place as it binds start
// (part 3; #205's review, item 7): its packs allowlist names ch-local's pack
// names, so the pack is the first directory of the scenario's checked real
// path below --packsRoot (<home>/packs/<pack>/<key>/...): the code that runs,
// whatever the request says. A trusted ceiling's list that leaves it out is
// SETTING_FORBIDDEN_BY_CEILING; a ceiling that cannot be trusted refuses
// every load (SETTING_CEILING_UNTRUSTED), as ch-local does. An unload is a
// tightening and is never refused.
//
// What a pack owns is RECORDED when it loads (at start or in place), and
// unload, reload and the parts kept for other packs are decided from that
// record, never from disk again: a tree removed before its unload still
// unloads what it loaded (#205's review). Disk is read only for the
// scenario a load or reload names, and every module of its closure must lie,
// by real path, inside a --packsRoot ch-local start gave.
//
// A reload drains, then switches (the reviewer's ruling A, 2026-11-14): one
// worker and one file broker per module, as the lifecycle lock keeps. A
// module whose version changes finishes the calls it was given on the old
// version, routed or over direct peer channels, up to --requestTimeout (what
// it still owes then is answered MODULE_RELOADING); new calls to it wait
// meanwhile, and are served by the new version once it is up. The wait is
// bounded by --requestTimeout plus the spawn: the latency cost of a reload in
// place. A reload switches all of its modules or none: a failure part-way
// puts back what it changed.
//
// Every applied request changes the tool set through the device manager, so
// the stdio route's comparison (lib/route-manager.js) sends one
// notifications/tools/list_changed once the set settles.
const fs   = require('fs');
const path = require('path');
const {CountinghouseError} = require('./countinghouse-error');
const moduleRoles = require('./module-roles');
const options = require('./cli-options');
const LOG = require('./logger');
// M4 (#413 section 5.5): what a load newly brings in is hidden until it has
// loaded, and what an unload takes away from its start until it is out of
// the module map (lib/module-visibility.js)
const visibility = require('./module-visibility');

// A load or a reload whose closure holds a module still hidden from an
// unload that failed is refused: nothing brings it back into view.
function stillHidden(names) {
  const h = visibility.hiddenOf(names);
  if (h.length > 0) throw refusal('CONTROL_FAILED', `${h[0]} is still being unloaded; restart your client`);
}

// The modules an unload took away: out of view once out of the module map;
// one still there failed to unload and stays hidden until the runtime ends.
function goneOrHidden(names) {
  for (const n of visibility.gone(names)) {
    LOG.E(new Error(`module: ${n} is still loaded after its unload; it stays hidden until the runtime ends`));
  }
}

// The scenario's package name, optionally scoped (ch-local's packs are:
// @countinghouse/ch-pack-<pack>), each part in the characters of a ch-local
// pack name. This is the runtime's name for a pack, not the settings key: the
// settings tool's pack.<name> (lib/settings-tool.js) takes ch-local's pack
// name (ci-failure-triage), which ch-local maps to its scenario, so any pack
// ch-local installs can be turned off.
const PACK_NAME = /^(@[a-z0-9][a-z0-9-]{0,63}\/)?[a-z0-9][a-z0-9-]{0,63}$/;
// a confined module's files, walked for links out of --packsRoot, at most
const WALK_MAX = 20000;
const DRAIN_POLL_MS = 50;

function refusal(code, message) {
  return Object.assign(new Error(message), {code: code});
}

function packageNameOf(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name; } catch (e) { return null; }
}

function realOf(dir) {
  try { return fs.realpathSync(dir); } catch (e) { return null; }
}

// The real paths of --packsRoot; a path is inside one when its real path is
// that root or below it.
function roots() {
  return (Array.isArray(options.packsRoot) ? options.packsRoot : []).map(realOf).filter((r) => r != null);
}
// The real paths of --modulesRoot (M4: the module form).
function modulesRoots() {
  return (Array.isArray(options.modulesRoot) ? options.modulesRoot : []).map(realOf).filter((r) => r != null);
}
function insideRoots(dir, rs) {
  const real = realOf(dir);
  return real != null && rs.some((r) => real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}

// The first link under a module's directory (an entry file, a handler, a
// directory) whose target is outside --packsRoot, or missing; null if none.
// Links are not followed; a directory too large to walk is refused as if it
// had one.
function linkOut(dir, rs) {
  const stack = [dir];
  let seen = 0;
  while (stack.length > 0) {
    const d = stack.pop();
    let names;
    try { names = fs.readdirSync(d); } catch (e) { return d; }
    for (const n of names) {
      if (++seen > WALK_MAX) return `${dir} (over ${WALK_MAX} entries)`;
      const full = path.join(d, n);
      let st;
      try { st = fs.lstatSync(full); } catch (e) { return full; }
      if (st.isSymbolicLink()) { if (!insideRoots(full, rs)) return full; continue; }
      if (st.isDirectory()) stack.push(full);
    }
  }
  return null;
}

// The pack a message names, checked: {name, scenario, allowance}. allowance:
// the pack's own credentials file, or null when it gives none.
function readRequest(msg, {needsScenario}) {
  if (msg == null || typeof(msg.name) !== 'string' || !PACK_NAME.test(msg.name)) throw refusal('CONTROL_FAILED', 'a pack is named by its scenario\'s package name');
  if (!needsScenario) return {name: msg.name};
  if (typeof(msg.scenario) !== 'string' || !path.isAbsolute(msg.scenario) || packageNameOf(msg.scenario) == null) {
    throw refusal('CONTROL_FAILED', `${msg.name}: its scenario is an absolute path to a module directory`);
  }
  const rs = roots();
  if (rs.length === 0) throw refusal('CONTROL_FAILED', `${msg.name}: this runtime was given no --packsRoot, so it loads no pack in place`);
  if (!insideRoots(msg.scenario, rs)) throw refusal('CONTROL_FAILED', `${msg.name}: its scenario is outside --packsRoot`);
  if (packageNameOf(msg.scenario) !== msg.name) {
    throw refusal('CONTROL_FAILED', `${msg.name}: the scenario at that path is ${String(packageNameOf(msg.scenario)).slice(0, 128)}`);
  }
  let allowance = null;
  if (msg.remoteCredentials != null) {
    if (typeof(msg.remoteCredentials) !== 'string' || !path.isAbsolute(msg.remoteCredentials)) {
      throw refusal('CONTROL_FAILED', `${msg.name}: its credentials file is an absolute path`);
    }
    try {
      allowance = require('./remote/credentials').loadAllowance(msg.remoteCredentials);
    } catch (e) {
      throw refusal('CONTROL_FAILED', `${msg.name}: its credentials file could not be read (${e.code || e.message})`);
    }
  }
  return {name: msg.name, scenario: msg.scenario, allowance: allowance, roots: rs};
}

// ch-local's pack name for a scenario inside --packsRoot: the first directory
// of its real path below the root that holds it; null if none.
function chLocalPackOf(scenario, rs) {
  const real = realOf(scenario);
  if (real == null) return null;
  for (const r of rs) {
    const rel = path.relative(r, real);
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep)[0];
  }
  return null;
}

// The ceiling's refusal of loading this pack, or null.
function ceilingRefusal(req) {
  const ceiling = require('./settings-tool').controlCeilingNow();
  if (ceiling == null || ceiling.state === 'none') return null;
  if (ceiling.state !== 'trusted') {
    return CountinghouseError.withFields('SETTING_CEILING_UNTRUSTED', {file: String(ceiling.file), problem: String(ceiling.problem).slice(0, 200)});
  }
  const packs = (ceiling.ceiling != null) ? ceiling.ceiling.packs : null;
  if (!Array.isArray(packs)) return null;
  const pack = chLocalPackOf(req.scenario, req.roots);
  if (pack != null && packs.includes(pack)) return null;
  return CountinghouseError.withFields('SETTING_FORBIDDEN_BY_CEILING', {name: `pack.${pack != null ? pack : req.name}`, value: 'on'});
}

// A pack's record: {scenario, modules: Map(name -> {path, version, listed}),
// tools: Set, allowance}. mm.packsInPlace: name -> record, seeded with what
// the runtime was started with (mm.startPlan, recorded at start), then kept
// by each load, unload and reload in place.
function packsOf(mm) {
  if (mm.packsInPlace == null) {
    mm.packsInPlace = new Map();
    const plan = mm.startPlan;
    for (const dir of (mm.startScenarios || [])) {
      const name = packageNameOf(dir);
      if (typeof(name) !== 'string' || mm.packsInPlace.has(name) || plan == null) continue;
      const modules = new Map();
      for (const e of plan.load) {
        const owners = plan.owners.get(e.name);
        if (owners != null && owners.has(name)) modules.set(e.name, {path: e.path, version: e.version, listed: e.listed !== false});
      }
      if (modules.size === 0) continue;   // refused at start: not loaded
      // under --modulesRoot a unit the start seeds is recorded under its
      // package name (in the store the path's first directory would be
      // @countinghouse for every one: #413 section 16, rule 3)
      const confined = modulesRoots().length > 0;
      mm.packsInPlace.set(name, {scenario: dir, dir: dir, form: confined ? 'module' : undefined, pack: confined ? name : chLocalPackOf(dir, roots()),
        modules: modules, tools: new Set(toolsOf(dir)), prompts: new Set(promptsOf(dir)), allowance: null});
    }
  }
  return mm.packsInPlace;
}

function toolsOf(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return moduleRoles.toolNamesOf(dir, moduleRoles.roleOf(pkg));
  } catch (e) {
    return [];
  }
}
function promptsOf(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return moduleRoles.promptNamesOf(dir, moduleRoles.roleOf(pkg));
  } catch (e) {
    return [];
  }
}

// Which other pack holds a module, and at what version.
function heldElsewhere(mm, except, moduleName) {
  for (const [name, p] of packsOf(mm)) if (name !== except && p.modules.has(moduleName)) return {pack: name, version: p.modules.get(moduleName).version};
  return null;
}

// The scenario's closure, read from disk and checked: inside --packsRoot,
// its tool names free of every other pack's and the built-ins', and no part
// another pack holds at another version. -> {entries: Map(name -> entry),
// tools}.
function planFor(mm, req) {
  const taken = new Set(require('./mcp/tool-name').RESERVED_TOOL_NAMES);
  const takenPrompts = new Set();
  for (const [name, p] of packsOf(mm)) {
    if (name === req.name) continue;
    for (const t of p.tools) taken.add(t);
    for (const t of (p.prompts || [])) takenPrompts.add(t);
  }
  const plan = moduleRoles.expandLoadList([req.scenario], {reserved: [...taken], reservedPrompts: [...takenPrompts]});
  if (plan.refused.length > 0) throw refusalOf(plan.refused[0]);
  const entries = new Map();
  for (const e of plan.load) {
    if (!insideRoots(e.path, req.roots)) throw refusal('CONTROL_FAILED', `${req.name}: its module ${e.name} is outside --packsRoot`);
    // loaded by the real path checked here, so a directory link swapped
    // afterwards (a reload's drain is a long window) is not what loads
    const real = realOf(e.path);
    const out = linkOut(real, req.roots);
    if (out != null) throw refusal('CONTROL_FAILED', `${req.name}: its module ${e.name} has a link outside --packsRoot (${path.relative(real, out) || out})`);
    const other = heldElsewhere(mm, req.name, e.name);
    if (other != null && other.version !== e.version) {
      throw CountinghouseError.withFields('PART_VERSION_CONFLICT', {scenario: req.name, name: e.name, versions: `${other.version}, ${e.version}`});
    }
    entries.set(e.name, {path: real, name: e.name, version: e.version, listed: e.listed !== false});
  }
  return {entries, tools: new Set(toolsOf(req.scenario)), prompts: new Set(promptsOf(req.scenario))};
}

function refusalOf(r) {
  if (r.code === 'PART_VERSION_CONFLICT') {
    return CountinghouseError.withFields('PART_VERSION_CONFLICT', {scenario: r.name, name: r.part, versions: r.versions.join(', ')});
  }
  return new CountinghouseError(r.code, moduleRoles.refusedWhy(r));
}

const loaded = (mm, name) => mm.modules[name] != null;

function loadOne(mm, entry) {
  // test hook (under the test flag only): a module whose load in place
  // starts this long after it is asked, as a slow spawn would (M4: what a
  // load newly brings in stays hidden meanwhile)
  const holdMs = (process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG === '1' && process.env.COUNTINGHOUSE_TEST_LOAD_HOLD_MODULE === entry.name)
    ? Number(process.env.COUNTINGHOUSE_TEST_LOAD_HOLD_MS) : NaN;
  return new Promise((resolve, reject) => {
    const load = () => mm.loadModuleFromPath(entry.path, entry.name, entry.version, (err) => (err != null ? reject(err) : resolve()));
    if (Number.isFinite(holdMs) && holdMs > 0) {
      LOG.I(`test hook: ${entry.name}'s load in place starts in ${holdMs} ms`);
      return setTimeout(load, holdMs);
    }
    return load();
  });
}

// Resolves whatever the unload answers. A module out of the module map is
// unloaded too: one restarting after a crash, or suspended, has its
// supervisor's record cleared, so its restart never registers it again with
// no pack owning it (listed to every session: the Fable security pass,
// F1-3), and a spawn of it under way is ended. Out of the map, nothing of
// that name known (UNLOAD_MODULE_FAIL: no supervisor record, no spawn, as
// for one that crashed with the sandbox off) is no failure; any other error
// is logged.
function unloadOne(mm, name) {
  // test hook (under the test flag only): a module whose unload leaves it in
  // the module map, as a worker that never ends would
  if (process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG === '1' && process.env.COUNTINGHOUSE_TEST_UNLOAD_KEEPS === name) {
    LOG.I(`test hook: ${name}'s unload is skipped: it stays in the module map`);
    return Promise.resolve();
  }
  const wasLoaded = loaded(mm, name);
  return new Promise((resolve) => mm.unloadModuleExternal(name, (err) => {
    if (err != null && (wasLoaded || err.code !== 'UNLOAD_MODULE_FAIL')) LOG.W(`module: ${name}: its pack's unload: ${err.message}`);
    resolve();
  }));
}

// Pack operations run one at a time: the control channel, their only caller
// (lib/control-channel.js, through lib/module-control.js), serialises every
// load, reload and unload on one promise chain. What follows rests on that
// (a module held by another pack is read from the records, never from an
// operation under way), so one arriving while another is under way is refused.
function oneAtATime(mm, name) {
  if (mm.packsLoading != null && mm.packsLoading.size > 0) {
    throw refusal('CONTROL_FAILED', `${name}: another pack operation is under way (${[...mm.packsLoading.keys()].join(', ')}); pack operations are serialised`);
  }
}

// The remote allowances (lib/module-manager.js packRemotes): a pack's own,
// added to each of its modules beside the other packs' (and, for a module
// loaded from start, the process's), and removed for that pack only.
function addAllowance(mm, pack, names, allowance) {
  const mmod = require('./module-manager');
  for (const n of names) {
    if (allowance == null) continue;
    let byPack = mmod.packRemotes.get(n);
    if (byPack == null) {
      byPack = new Map();
      // already loaded from start: the process's allowance stays its own
      if (loaded(mm, n) && heldElsewhere(mm, pack, n) != null) byPack.set(mmod.START_ALLOWANCE, require('./remote/credentials').allowance());
      mmod.packRemotes.set(n, byPack);
    }
    byPack.set(pack, allowance);
  }
}
function removeAllowance(pack, names) {
  const mmod = require('./module-manager');
  for (const n of names) {
    const byPack = mmod.packRemotes.get(n);
    if (byPack == null) continue;
    byPack.delete(pack);
    if ([...byPack.keys()].every((k) => k === mmod.START_ALLOWANCE)) mmod.packRemotes.delete(n);
  }
}

// What a module still owes: its routed calls, and its direct peer invokes
// (matched and unbilled, or announced on its channels).
function owedBy(old, dm) {
  const routed = (old.msgQueue != null) ? Object.keys(old.msgQueue).length : 0;
  const broker = (dm != null) ? dm.peerChannelBroker : null;
  return routed + ((broker != null && typeof(broker.openInvokesTo) === 'function') ? broker.openInvokesTo(old) : 0);
}

function drainCalls(old, dm) {
  const deadline = Date.now() + Number(options.requestTimeout);
  return new Promise((resolve) => {
    const poll = () => {
      const owes = owedBy(old, dm);
      if (owes > 0 && Date.now() < deadline && old.ended == null) return setTimeout(poll, DRAIN_POLL_MS).unref();
      if (owes > 0) LOG.I(`module: ${old.hostModuleName}: its old version still owed ${owes} answers at --requestTimeout; ended`);
      resolve();
    };
    poll();
  });
}

function waitRegistered(mm, name, old) {
  const deadline = Date.now() + 5000;
  return new Promise((resolve) => {
    const poll = () => {
      const wm = mm.modules[name];
      const up = wm != null && wm !== old && Object.keys(wm.deviceList || {}).length > 0;
      if (!up && Date.now() < deadline) return setTimeout(poll, DRAIN_POLL_MS).unref();
      resolve();
    };
    poll();
  });
}

// A module at another version: drain, then switch. While it is replaced,
// new calls to its device wait (lib/device-manager.js onInvokeDeviceAction)
// and new direct peer channels to it are denied (lib/peer-channel-broker.js).
// The switch is the runtime's own reload (unload, then spawn).
async function replaceDrainThenSwitch(mm, dm, entry) {
  const name = entry.name;
  const old = mm.modules[name];
  const WorkerMessage = require('./worker-message');
  if (!(old instanceof WorkerMessage)) {
    await unloadOne(mm, name);
    return loadOne(mm, entry);
  }
  if (!(mm.replacingInPlace instanceof Map)) mm.replacingInPlace = new Map();
  mm.replacingInPlace.set(name, true);
  old.replacing = true;
  try {
    await drainCalls(old, dm);
    await new Promise((resolve, reject) => mm.loadModuleByWorker(entry.path, name, entry.version, (err) => (err != null ? reject(err) : resolve())));
    await waitRegistered(mm, name, old);
  } finally {
    old.replacing = false;
    mm.replacingInPlace.delete(name);
  }
}

function setListed(mm, name, listed) {
  if (listed === false) mm.unlisted.add(name); else mm.unlisted.delete(name);
}

// ---- The module form (M4; #413 sections 7.1-7.3) ----
// {type: 'load', name: '<top-level package>', dirs: {'<package>': '<absolute
// dir>', ...}, credentials?: {'<package>': {'<origin>': {'<VARIABLE>':
// 'COUNTINGHOUSE_CREDENTIAL_<n>'}}}, notice?}. The unit is a top-level
// module and its closure, found only among the directories given; the
// pack form (scenario, pack, global, remoteCredentials) is still taken
// until M6, never mixed with this one.
const MAX_DIRS = 64;
const OLD_FIELDS = ['scenario', 'pack', 'global', 'remoteCredentials'];
const isModuleForm = (msg) => msg != null && (msg.dirs !== undefined || msg.names !== undefined);
const isPackage = (n) => require('./remote/credentials').isPackage(n);

// A module-form message's shape, before anything is read from disk (#413
// section 7.3; the shared vectors' moduleMessages): -> null, or {reason,
// message}, reason one of name, names, dirs, credentials, old-field.
function moduleMessageProblem(msg) {
  const {SLOT} = require('./remote/credentials');
  const isObj = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
  const bad = (reason, message) => ({reason, message});
  if (!isObj(msg)) return bad('name', 'a control message is an object');
  const type = msg.type;
  if (type === 'module-stopped') {
    if (!isPackage(msg.name)) return bad('name', 'a module is named by its package name');
    return (typeof(msg.code) === 'string' && (msg.when === 'start' || msg.when === 'restart')) ? null : bad('name', 'module-stopped carries a code and when');
  }
  if (type === 'notice') return (msg.module === null || isPackage(msg.module)) && typeof(msg.text) === 'string' ? null : bad('name', 'a notice names a module by its package name, or none');
  if (type === 'reread') return msg.what === 'module-settings' ? null : bad('name', 'reread names what it reads: module-settings');
  let tops = null;
  if (type === 'reload') {
    if (!Array.isArray(msg.names) || msg.names.length === 0 || msg.names.length > MAX_DIRS || !msg.names.every((n) => isPackage(n)) || new Set(msg.names).size !== msg.names.length) {
      return bad('names', 'a reload names each loaded top-level module once, by its package name');
    }
    if (msg.name !== undefined) return bad('names', 'a module-form reload names its modules in names, not name');
    tops = msg.names;
  } else {
    if (!isPackage(msg.name)) return bad('name', 'a module is named by its package name');
    tops = [msg.name];
  }
  const label = tops.join(', ');
  if (OLD_FIELDS.some((f) => msg[f] !== undefined)) return bad('old-field', `${label}: a module-form message carries no scenario, pack, global or remoteCredentials`);
  if (type === 'unload') return null;
  const d = msg.dirs;
  if (!isObj(d) || Object.keys(d).length === 0 || Object.keys(d).length > MAX_DIRS) return bad('dirs', `${label}: dirs names each module's directory (1 to ${MAX_DIRS})`);
  for (const [name, dir] of Object.entries(d)) {
    if (!isPackage(name)) return bad('dirs', `${JSON.stringify(name).slice(0, 80)} is not a package name`);
    if (typeof(dir) !== 'string' || !path.isAbsolute(dir)) return bad('dirs', `${name}: its directory is an absolute path`);
  }
  for (const t of tops) if (!Object.prototype.hasOwnProperty.call(d, t)) return bad('dirs', `dirs names no directory for ${t}`);
  if (msg.credentials !== undefined) {
    const c = msg.credentials;
    if (!isObj(c)) return bad('credentials', `${label}: credentials is an object of package -> its allowance`);
    for (const [name, entry] of Object.entries(c)) {
      if (!Object.prototype.hasOwnProperty.call(d, name)) return bad('credentials', `${label}: credentials names ${JSON.stringify(name).slice(0, 80)}, which dirs does not`);
      if (!isObj(entry) || !Object.values(entry).every((vars) => isObj(vars) && Object.values(vars).every((slot) => typeof(slot) === 'string' && SLOT.test(slot)))) {
        return bad('credentials', `${name}: each credential names a slot, COUNTINGHOUSE_CREDENTIAL_<1-9999>`);
      }
    }
  }
  return null;
}

// `tops`: the top-level modules the message names. -> {dirs: Map(package ->
// real dir), credentials: Map(package -> entry), roots}
function readDirs(msg, tops) {
  const label = tops.join(', ');
  const d = msg.dirs;
  if (d == null || typeof(d) !== 'object' || Array.isArray(d) || Object.keys(d).length === 0 || Object.keys(d).length > MAX_DIRS) {
    throw refusal('CONTROL_FAILED', `${label}: dirs names each module's directory (1 to ${MAX_DIRS})`);
  }
  const rs = modulesRoots();
  if (rs.length === 0) throw refusal('CONTROL_FAILED', `${label}: this runtime was given no --modulesRoot, so it loads no module in place`);
  const dirs = new Map();
  const seen = new Map();   // real dir -> package
  for (const [name, dir] of Object.entries(d)) {
    if (!isPackage(name)) throw refusal('CONTROL_FAILED', `${JSON.stringify(name).slice(0, 80)} is not a package name`);
    if (typeof(dir) !== 'string' || !path.isAbsolute(dir)) throw refusal('CONTROL_FAILED', `${name}: its directory is an absolute path`);
    if (!insideRoots(dir, rs)) throw refusal('CONTROL_FAILED', `${name}: its directory is outside --modulesRoot`);
    const pkgName = packageNameOf(dir);
    if (pkgName !== name) throw refusal('CONTROL_FAILED', `${name}: the package at that directory is ${String(pkgName).slice(0, 128)}`);
    const real = realOf(dir);
    if (seen.has(real)) throw refusal('CONTROL_FAILED', `${name}: the same directory as ${seen.get(real)}`);
    seen.set(real, name);
    dirs.set(name, real);
  }
  for (const t of tops) if (!dirs.has(t)) throw refusal('CONTROL_FAILED', `dirs names no directory for ${t}`);
  const credentials = new Map();
  if (msg.credentials !== undefined) {
    const c = msg.credentials;
    if (c == null || typeof(c) !== 'object' || Array.isArray(c)) throw refusal('CONTROL_FAILED', `${label}: credentials is an object of package -> its allowance`);
    for (const [name, entry] of Object.entries(c)) {
      if (!dirs.has(name)) throw refusal('CONTROL_FAILED', `${label}: credentials names ${JSON.stringify(name).slice(0, 80)}, which dirs does not`);
      try {
        credentials.set(name, require('./remote/credentials').checkEntry(name, entry));
      } catch (e) {
        throw refusal('CONTROL_FAILED', String(e.message).slice(0, 240));
      }
    }
  }
  return {dirs, credentials, roots: rs};
}

function readModuleRequest(msg, {needsDirs}) {
  // its shape first, by the one rule the shared vectors hold
  const problem = moduleMessageProblem(needsDirs ? msg : Object.assign({}, msg, {type: 'unload'}));
  if (problem != null) throw refusal('CONTROL_FAILED', problem.message);
  if (!needsDirs) return {name: msg.name};
  return Object.assign({name: msg.name, tops: [msg.name]}, readDirs(msg, [msg.name]));
}

// The closure of the request's top-level modules, from its directories
// alone: -> Map(name -> {path, name, version, listed}). Each module inside
// --modulesRoot with no link out; every directory given is in the closure;
// with mm, tool and prompt names free of the other units' and no module
// another unit holds at another version (`except`: the units the request
// replaces).
function closureOf(req, mm = null, except = []) {
  return closurePlan(req, mm, except).entries;
}
// -> {entries, owners: Map(module -> Set of the tops that hold it)}
function closurePlan(req, mm = null, except = []) {
  const label = req.tops.join(', ');
  const taken = new Set(require('./mcp/tool-name').RESERVED_TOOL_NAMES);
  const takenPrompts = new Set();
  if (mm != null) {
    for (const [name, p] of packsOf(mm)) {
      if (except.includes(name)) continue;
      for (const t of p.tools) taken.add(t);
      for (const t of (p.prompts || [])) takenPrompts.add(t);
    }
  }
  const plan = moduleRoles.expandLoadList(req.tops.map((t) => req.dirs.get(t)),
    {reserved: [...taken], reservedPrompts: [...takenPrompts], partDirs: [...req.dirs.values()]});
  if (plan.refused.length > 0) throw refusalOf(plan.refused[0]);
  const entries = new Map();
  for (const e of plan.load) {
    const real = realOf(e.path);
    const out = linkOut(real, req.roots);
    if (out != null) throw refusal('CONTROL_FAILED', `${label}: its module ${e.name} has a link outside --modulesRoot (${path.relative(real, out) || out})`);
    if (mm != null) {
      for (const [name, p] of packsOf(mm)) {
        if (except.includes(name) || !p.modules.has(e.name)) continue;
        const v = p.modules.get(e.name).version;
        if (v !== e.version) throw CountinghouseError.withFields('PART_VERSION_CONFLICT', {scenario: label, name: e.name, versions: `${v}, ${e.version}`});
      }
    }
    entries.set(e.name, {path: real, name: e.name, version: e.version, listed: e.listed !== false});
  }
  for (const n of req.dirs.keys()) if (!entries.has(n)) throw refusal('CONTROL_FAILED', `${n} is not in the closure of ${label}`);
  return {entries, owners: plan.owners};
}

// The operator's ceiling (#413 section 8), by each module's package name: a
// trusted `modules` list must name every one; a ceiling that still lists
// `packs` and no `modules` refuses a module-form load (fail closed, the plan
// review's Q2). -> null, or the refusal.
function moduleCeilingRefusal(names) {
  const ceiling = require('./settings-tool').controlCeilingNow();
  if (ceiling == null || ceiling.state === 'none') return null;
  if (ceiling.state !== 'trusted') {
    return CountinghouseError.withFields('SETTING_CEILING_UNTRUSTED', {file: String(ceiling.file), problem: String(ceiling.problem).slice(0, 200)});
  }
  const c = ceiling.ceiling || {};
  if (Array.isArray(c.modules)) {
    const missing = names.find((n) => !c.modules.includes(n));
    return (missing == null) ? null : CountinghouseError.withFields('SETTING_FORBIDDEN_BY_CEILING', {name: `enabled.${missing}`, value: 'on'});
  }
  if (Array.isArray(c.packs)) {
    return CountinghouseError.withFields('SETTING_CEILING_UNTRUSTED', {file: String(ceiling.file),
      problem: 'the ceiling lists packs, not modules: list each module under "modules"'});
  }
  return null;
}

// A start given --modulesRoot (#413 section 7.2): every directory it loads,
// top-level (--loadModule) or part (--partDir), lies inside the root by real
// path with no link leading out; one that does not is not loaded, and a
// part found nowhere else leaves its callers PART_MISSING. -> {tops: the
// --loadModule directories kept, partDirs: where parts are looked for (the
// kept --partDir and --loadModule directories, real paths), refused: [{name,
// code}] the top-level modules not loaded for it}.
function checkStartPlan(tops, parts) {
  const rs = modulesRoots();
  const why = (dir) => {
    const real = realOf(dir);
    if (real == null || !insideRoots(dir, rs)) return 'it is outside --modulesRoot';
    const out = linkOut(real, rs);
    return (out != null) ? `it has a link outside --modulesRoot (${path.relative(real, out) || out})` : null;
  };
  const kept = [];
  const refused = [];
  for (const d of tops) {
    const w = why(d);
    if (w == null) { kept.push(d); continue; }
    const name = packageNameOf(d);
    LOG.E(new CountinghouseError('MODULE_PATH_OUTSIDE_ROOT', `${d}: not loaded: ${w}`));
    refused.push({name: (typeof(name) === 'string') ? name : d, code: 'MODULE_PATH_OUTSIDE_ROOT'});
  }
  const partDirs = [];
  for (const d of parts) {
    const w = why(d);
    if (w == null) partDirs.push(realOf(d));
    else LOG.E(new CountinghouseError('MODULE_PATH_OUTSIDE_ROOT', `${d}: the part there is not loaded: ${w}`));
  }
  return {tops: kept, partDirs: partDirs.concat(kept.map(realOf)), refused};
}

// mm.unlisted from the records (#413 section 5.5): a module is listed while
// some record holds it as listed (a top-level module in its own right),
// unlisted while every record that holds it holds it as a part.
function recomputeUnlisted(mm) {
  const listed = new Set();
  const held = new Set();
  for (const p of packsOf(mm).values()) {
    for (const [n, e] of p.modules) {
      held.add(n);
      if (e.listed !== false) listed.add(n);
    }
  }
  for (const n of held) setListed(mm, n, listed.has(n));
}

async function loadModuleUnit(mm, msg, dm) {
  const req = readModuleRequest(msg, {needsDirs: true});
  oneAtATime(mm, req.name);
  if (packsOf(mm).has(req.name)) throw refusal('CONTROL_FAILED', `${req.name} is loaded already; reload it`);
  const entries = closureOf(req, mm);
  stillHidden(entries.keys());
  const forbidden = moduleCeilingRefusal([...entries.keys()]);
  if (forbidden != null) throw forbidden;
  const credentials = require('./remote/credentials');
  const toLoad = [...entries.values()].filter((e) => !loaded(mm, e.name));
  // each module's allowance before its remote registers at its spawn
  for (const [n, entry] of req.credentials) credentials.setModule(n, entry);
  for (const e of toLoad) setListed(mm, e.name, e.listed);
  visibility.hide(toLoad.map((e) => e.name));
  // recorded in the session view under its package name (until M5)
  loading(mm, req.name, req.name, entries.keys());
  try {
    const done = [];
    try {
      for (const e of toLoad) {
        await loadOne(mm, e);
        done.push(e.name);
      }
    } catch (err) {
      try {
        for (const n of done.reverse()) await unloadOne(mm, n);
      } finally {
        for (const e of toLoad) {
          mm.unlisted.delete(e.name);
          if (req.credentials.has(e.name)) credentials.dropModule(e.name);
        }
        goneOrHidden(toLoad.map((e) => e.name));
      }
      throw err;
    }
    packsOf(mm).set(req.name, {dir: req.dirs.get(req.name), form: 'module', pack: req.name,
      modules: new Map([...entries].map(([n, e]) => [n, {path: e.path, version: e.version, listed: e.listed}])),
      tools: new Set(toolsOf(req.dirs.get(req.name))), prompts: new Set(promptsOf(req.dirs.get(req.name))), allowance: null});
    recomputeUnlisted(mm);
    visibility.show(toLoad.map((e) => e.name));
    return {modules: [...entries.keys()]};
  } finally {
    loaded_(mm, req.name, req.name);
  }
}

async function loadPack(mm, msg, dm) {
  if (isModuleForm(msg)) return loadModuleUnit(mm, msg, dm);
  const req = readRequest(msg, {needsScenario: true});
  oneAtATime(mm, req.name);
  if (packsOf(mm).has(req.name)) throw refusal('CONTROL_FAILED', `${req.name} is loaded already; reload it`);
  const forbidden = ceilingRefusal(req);
  if (forbidden != null) throw forbidden;
  const {entries, tools, prompts} = planFor(mm, req);
  stillHidden(entries.keys());
  const pack = packNameOf(msg, req);
  const toLoad = [...entries.values()].filter((e) => !loaded(mm, e.name));
  visibility.hide(toLoad.map((e) => e.name));
  addAllowance(mm, req.name, [...entries.keys()], req.allowance);
  for (const e of toLoad) setListed(mm, e.name, e.listed);
  // owned by its pack before any of its devices registers, so a session that
  // doesn't list the pack never sees them mid-load (B3, the reviewer's #340
  // review, obligation 1)
  loading(mm, req.name, pack, entries.keys());
  try {
    const done = [];
    try {
      for (const e of toLoad) {
        await loadOne(mm, e);
        done.push(e.name);
      }
    } catch (err) {
      try {
        for (const n of done.reverse()) await unloadOne(mm, n);
      } finally {
        for (const e of toLoad) mm.unlisted.delete(e.name);
        removeAllowance(req.name, [...entries.keys()]);
        // what never loaded, or is out of the map again, leaves the set; a
        // module still in it (its unload failed) stays hidden
        goneOrHidden(toLoad.map((e) => e.name));
      }
      throw err;
    }
    packsOf(mm).set(req.name, {scenario: req.scenario, pack: pack, modules: new Map([...entries].map(([n, e]) => [n, {path: e.path, version: e.version, listed: e.listed}])),
      tools: tools, prompts: prompts, allowance: req.allowance});
    // every module of it is up: shown together
    visibility.show(toLoad.map((e) => e.name));
    return {modules: [...entries.keys()]};
  } finally {
    // whatever threw, the rollback included (#341's review, 5)
    loaded_(mm, req.name, pack);
  }
}

async function unloadPack(mm, msg) {
  // one unload for both forms: {name} (and the pack form's pack)
  const req = (msg != null && typeof(msg.name) === 'string' && isPackage(msg.name) && !PACK_NAME.test(msg.name))
    ? readModuleRequest(msg, {needsDirs: false}) : readRequest(msg, {needsScenario: false});
  oneAtATime(mm, req.name);
  const pack = packsOf(mm).get(req.name);
  if (pack == null) throw refusal('CONTROL_FAILED', `${req.name} is not loaded`);
  // its modules stay owned by the pack until they are unloaded, as while
  // it loads: a view rebuilt meanwhile never lists their still-registered
  // devices to a session that doesn't list the pack (the #341 deep review, 1)
  loading(mm, req.name, pack.pack, pack.modules.keys());
  try {
    packsOf(mm).delete(req.name);
    const gone = [...pack.modules.keys()].filter((n) => heldElsewhere(mm, null, n) == null);
    // hidden from the start of the unload: a module turned off is not
    // callable because its worker is slow to end
    visibility.hide(gone);
    removeAllowance(req.name, [...pack.modules.keys()]);
    for (const name of gone) {
      // in the module map or not (unloadOne)
      await unloadOne(mm, name);
      mm.unlisted.delete(name);
      require('./remote/credentials').dropModule(name);
    }
    goneOrHidden(gone);
    recomputeUnlisted(mm);
    return {modules: gone};
  } finally {
    loaded_(mm, req.name, pack.pack);
  }
}

// A reload switches all of its modules or none. Each step is journalled:
// a module added is unloaded again, one switched is switched back to the
// version recorded, and the record, the allowances and the listing are put
// back. Modules the new version no longer owns are unloaded only once every
// switch has succeeded.
async function reloadPack(mm, msg, dm) {
  if (isModuleForm(msg)) throw refusal('CONTROL_FAILED', 'a module-form reload is not served yet');
  const req = readRequest(msg, {needsScenario: true});
  oneAtATime(mm, req.name);
  const pack = packsOf(mm).get(req.name);
  if (pack == null) throw refusal('CONTROL_FAILED', `${req.name} is not loaded; load it`);
  const forbidden = ceilingRefusal(req);
  if (forbidden != null) throw forbidden;
  const {entries, tools, prompts} = planFor(mm, req);
  stillHidden(entries.keys());
  const packName = packNameOf(msg, req, pack.pack);
  const before = new Map(pack.modules);
  // a module the new version adds is owned by the pack before it registers
  loading(mm, req.name, packName, entries.keys());
  try {
    const unlistedBefore = new Set(mm.unlisted);
    const journal = [];
    removeAllowance(req.name, [...before.keys()]);
    addAllowance(mm, req.name, [...entries.keys()], req.allowance);
    try {
      for (const e of entries.values()) {
        setListed(mm, e.name, e.listed);
        if (!loaded(mm, e.name)) {
          visibility.hide([e.name]);
          journal.push({added: e.name});
          await loadOne(mm, e);
          continue;
        }
        // the same name at the same version, from whichever tree, is that
        // module again (Task A1): it stays as it is
        const was = before.get(e.name) || null;
        const wm = mm.modules[e.name];
        const version = (was != null) ? was.version : (wm.packageInfo != null ? wm.packageInfo.version : null);
        if (version === e.version) continue;
        // journalled BEFORE the switch: the switch unloads the old version
        // first, so a new version that fails to spawn leaves the module
        // unloaded, and the rollback must bring the old one back
        journal.push({switched: e.name, back: (was != null) ? {path: was.path, name: e.name, version: was.version} : null});
        await replaceDrainThenSwitch(mm, dm, e);
      }
    } catch (err) {
      // the old allowances first, so a module switched back registers its
      // remotes with them, not the failed reload's
      removeAllowance(req.name, [...entries.keys()]);
      addAllowance(mm, req.name, [...before.keys()], pack.allowance);
      mm.unlisted.clear();
      for (const n of unlistedBefore) mm.unlisted.add(n);
      const failed = [];
      for (const step of journal.reverse()) {
        try {
          if (step.added != null) {
            await unloadOne(mm, step.added);
            goneOrHidden([step.added]);
          } else if (step.back != null) await replaceDrainThenSwitch(mm, dm, step.back);
        } catch (e) {
          failed.push(step.added || step.switched);
          LOG.E(new Error(`module: ${req.name}: a reload's rollback could not put ${step.added || step.switched} back: ${e.message}`));
        }
      }
      if (failed.length > 0) {
        throw refusal('CONTROL_PACK_UNCERTAIN', `${req.name}: the reload failed (${err.code || 'error'}: ${String(err.message).slice(0, 120)}), and ${failed.join(', ')} could not be put back; the pack's state is uncertain, so restart your client`);
      }
      throw err;
    }
    // every addition is up: shown together
    visibility.show(journal.filter((s) => s.added != null).map((s) => s.added));
    const removed = [...before.keys()].filter((name) => !entries.has(name) && heldElsewhere(mm, req.name, name) == null);
    visibility.hide(removed);
    for (const name of removed) {
      // in the module map or not (unloadOne)
      await unloadOne(mm, name);
      mm.unlisted.delete(name);
    }
    goneOrHidden(removed);
    packsOf(mm).set(req.name, {scenario: req.scenario, pack: packName, modules: new Map([...entries].map(([n, e]) => [n, {path: e.path, version: e.version, listed: e.listed}])),
      tools: tools, prompts: prompts, allowance: req.allowance});
    return {modules: [...entries.keys()]};
  } finally {
    // whatever threw (#341's review, 5)
    loaded_(mm, req.name, packName);
  }
}

// The ch-local pack a load is about: the message's (shared mode: ch-local
// names it), else the one its scenario's path says, else the record's.
function packNameOf(msg, req, recorded = null) {
  if (msg != null && typeof(msg.pack) === 'string') return msg.pack;
  const fromPath = req.scenario != null ? chLocalPackOf(req.scenario, req.roots || roots()) : null;
  return fromPath != null ? fromPath : recorded;
}

// A pack's modules while it loads (mm.packsLoading: scenario -> {pack,
// modules}), told to lib/session-packs.js as a change of the pack's records;
// and once it has loaded, or failed to.
function loading(mm, name, pack, modules) {
  if (mm.packsLoading == null) mm.packsLoading = new Map();
  mm.packsLoading.set(name, {pack, modules: [...modules]});
  if (pack != null) require('./session-packs').packChanged(pack);
}
function loaded_(mm, name, pack) {
  if (mm.packsLoading != null) mm.packsLoading.delete(name);
  if (pack != null) require('./session-packs').packChanged(pack);
}

// The version a ch-local pack is loaded at now: its scenario's (the record
// whose pack it is), or null.
function loadedVersionOf(mm, pack) {
  for (const [name, p] of packsOf(mm)) {
    if (p.pack !== pack) continue;
    const own = p.modules.get(name);
    return own != null && typeof(own.version) === 'string' ? own.version : null;
  }
  return null;
}

// [{pack, modules: [module name]}]: every pack loaded or loading, by its
// ch-local name (lib/session-packs.js's records). A module two packs hold is
// in both.
function packRecords(mm) {
  const byPack = new Map();
  const add = (pack, modules) => {
    if (typeof(pack) !== 'string') return;
    if (!byPack.has(pack)) byPack.set(pack, new Set());
    for (const m of modules) byPack.get(pack).add(m);
  };
  for (const p of packsOf(mm).values()) add(p.pack, p.modules.keys());
  if (mm.packsLoading != null) for (const l of mm.packsLoading.values()) add(l.pack, l.modules);
  return [...byPack].map(([pack, modules]) => ({pack, modules: [...modules]}));
}

module.exports = {loadPack, unloadPack, reloadPack, packRecords, loadedVersionOf, PACK_NAME, insideRoots, linkOut, chLocalPackOf, ceilingRefusal,
  readModuleRequest, closureOf, moduleCeilingRefusal, isModuleForm, moduleMessageProblem, checkStartPlan};
