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
      mm.packsInPlace.set(name, {scenario: dir, pack: chLocalPackOf(dir, roots()), modules: modules, tools: new Set(toolsOf(dir)), prompts: new Set(promptsOf(dir)), allowance: null});
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

// The modules a pack's unload or reload is taking out, no other pack
// holding them (the Fable security pass, F1-3): owned by a pack no session
// lists, so none is listed to every session if it registers again. Its
// unload clears the supervisor's record (unloadModuleExternal), and the
// module then leaves this set; one whose record somehow survived (a restart
// could still register it, with no owner) stays, hidden, until a pack loads
// it again and takes it back. So the set is empty but for that case, and
// sessionPacks.none() keeps its fast path.
const orphansOf = (mm) => (mm.packOrphans != null ? mm.packOrphans : (mm.packOrphans = new Set()));
const settleOrphan = (mm, name) => {
  if (mm.supervisor == null || mm.supervisor.status(name) == null) orphansOf(mm).delete(name);
};
// the owner packRecords gives them: a pack no session lists and none has on
const ORPHANED = '\u0000orphaned';
// Another pack's load or reload under way holds the module too: not taken
// out from under it (its worker may be mid-spawn, out of the module map).
// Another pack's unload doesn't: two unloads of packs sharing a module would
// each leave it to the other.
const loadingElsewhere = (mm, except, moduleName) => mm.packsLoading != null &&
  [...mm.packsLoading].some(([name, l]) => name !== except && l.unloading !== true && l.modules.includes(moduleName));

function loadOne(mm, entry) {
  return new Promise((resolve, reject) => {
    mm.loadModuleFromPath(entry.path, entry.name, entry.version, (err) => (err != null ? reject(err) : resolve()));
  });
}

// resolves whatever the unload answers; a module neither loaded, restarting
// nor coming up is 'unknown module', nothing to do, and any other error is
// logged
function unloadOne(mm, name) {
  return new Promise((resolve) => mm.unloadModuleExternal(name, (err) => {
    if (err != null && err.message !== 'unknown module') LOG.W(`module: ${name}: its pack's unload: ${err.message}`);
    resolve();
  }));
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

async function loadPack(mm, msg, dm) {
  const req = readRequest(msg, {needsScenario: true});
  if (packsOf(mm).has(req.name)) throw refusal('CONTROL_FAILED', `${req.name} is loaded already; reload it`);
  const forbidden = ceilingRefusal(req);
  if (forbidden != null) throw forbidden;
  const {entries, tools, prompts} = planFor(mm, req);
  const pack = packNameOf(msg, req);
  const toLoad = [...entries.values()].filter((e) => !loaded(mm, e.name));
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
      for (const n of done.reverse()) await unloadOne(mm, n);
      for (const e of toLoad) mm.unlisted.delete(e.name);
      removeAllowance(req.name, [...entries.keys()]);
      throw err;
    }
    for (const n of entries.keys()) orphansOf(mm).delete(n);
    packsOf(mm).set(req.name, {scenario: req.scenario, pack: pack, modules: new Map([...entries].map(([n, e]) => [n, {path: e.path, version: e.version, listed: e.listed}])),
      tools: tools, prompts: prompts, allowance: req.allowance});
    return {modules: [...entries.keys()]};
  } finally {
    // whatever threw, the rollback included (#341's review, 5)
    loaded_(mm, req.name, pack);
  }
}

async function unloadPack(mm, msg) {
  const req = readRequest(msg, {needsScenario: false});
  const pack = packsOf(mm).get(req.name);
  if (pack == null) throw refusal('CONTROL_FAILED', `${req.name} is not loaded`);
  // its modules stay owned by the pack until they are unloaded, as while
  // it loads: a view rebuilt meanwhile never lists their still-registered
  // devices to a session that doesn't list the pack (the #341 deep review, 1)
  loading(mm, req.name, pack.pack, pack.modules.keys(), true);
  try {
    packsOf(mm).delete(req.name);
    const gone = [...pack.modules.keys()].filter((n) => heldElsewhere(mm, null, n) == null && !loadingElsewhere(mm, req.name, n));
    removeAllowance(req.name, [...pack.modules.keys()]);
    for (const name of gone) {
      // whether or not it is in the module map: one restarting after a
      // crash, or suspended, is not, and its unload clears the supervisor's
      // record so it never comes back (unloadModuleExternal)
      orphansOf(mm).add(name);
      await unloadOne(mm, name);
      settleOrphan(mm, name);
      mm.unlisted.delete(name);
    }
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
  const req = readRequest(msg, {needsScenario: true});
  const pack = packsOf(mm).get(req.name);
  if (pack == null) throw refusal('CONTROL_FAILED', `${req.name} is not loaded; load it`);
  const forbidden = ceilingRefusal(req);
  if (forbidden != null) throw forbidden;
  const {entries, tools, prompts} = planFor(mm, req);
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
          await loadOne(mm, e);
          journal.push({added: e.name});
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
          if (step.added != null) await unloadOne(mm, step.added);
          else if (step.back != null) await replaceDrainThenSwitch(mm, dm, step.back);
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
    for (const name of before.keys()) {
      if (entries.has(name) || heldElsewhere(mm, req.name, name) != null || loadingElsewhere(mm, req.name, name)) continue;
      // as the unload's, whether or not it is in the module map
      orphansOf(mm).add(name);
      await unloadOne(mm, name);
      settleOrphan(mm, name);
      mm.unlisted.delete(name);
    }
    for (const n of entries.keys()) orphansOf(mm).delete(n);
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
function loading(mm, name, pack, modules, unloading = false) {
  if (mm.packsLoading == null) mm.packsLoading = new Map();
  mm.packsLoading.set(name, {pack, modules: [...modules], unloading});
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
  // modules a pack's unload is taking out, or whose supervisor's record
  // survived it: owned by a pack no session lists (F1-3)
  const held = new Set([...byPack.values()].flatMap((s) => [...s]));
  const orphans = [...orphansOf(mm)].filter((m) => !held.has(m));
  if (orphans.length > 0) add(ORPHANED, orphans);
  return [...byPack].map(([pack, modules]) => ({pack, modules: [...modules]}));
}

module.exports = {loadPack, unloadPack, reloadPack, packRecords, loadedVersionOf, PACK_NAME, ORPHANED, insideRoots, linkOut, chLocalPackOf, ceilingRefusal};
