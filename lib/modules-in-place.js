'use strict';
// Modules in place (#413 rev 3, sections 7.1-7.3; packs in place before it,
// part 2): a top-level module and its closure loaded, unloaded or reloaded
// while the runtime serves, at ch-local start's request over the control
// channel (lib/control-channel.js), under the same checks as at start. Only
// in the single-identity profile, under --workerThread. The request names
// its modules by package name, with the directory of each module of the
// closure (the module form; the pack form went in M6).
//
// The runtime holds one version of a module: a part two units share is
// loaded once, and a unit whose part is loaded at another version is
// refused whole (PART_VERSION_CONFLICT).
//
// The operator's ceiling binds a load or reload in place as it binds start:
// every module of the closure must be on its modules list, by package name
// (SETTING_FORBIDDEN_BY_CEILING); a ceiling that cannot be trusted refuses
// every load (SETTING_CEILING_UNTRUSTED), as ch-local does. An unload is a
// tightening and is never refused.
//
// What a unit owns is RECORDED when it loads (at start or in place), and
// unload, reload and the parts kept for other units are decided from that
// record, never from disk again: a tree removed before its unload still
// unloads what it loaded. Disk is read only for the directories a load or
// reload names, and each must lie, by real path, inside a --modulesRoot
// ch-local start gave.
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
const hardenedRealpaths = require('./hardened-realpaths');

// A load or a reload whose closure holds a module still hidden from an
// unload that failed is refused: nothing brings it back into view.
function stillHidden(names) {
  const h = visibility.hiddenOf(names);
  if (h.length > 0) throw refusal('CONTROL_FAILED', `${h[0]} is still being unloaded, until countinghouse restarts`);
}

// The modules an unload took away: out of view once out of the module map;
// one still there failed to unload and stays hidden until the runtime ends.
function goneOrHidden(names) {
  for (const n of visibility.gone(names)) {
    LOG.E(new Error(`module: ${n} is still loaded after its unload; it stays hidden until the runtime ends`));
  }
}
// After a rollback: a suspended module a unit holds, out of the map -- put
// back by putSuspensionBack, or never reached by the operation -- is shown
// again as its holder had it (its supervisor answers its calls: suspended);
// every other name is out of view or said (#397; the medium on the high's
// round)
function afterRollback(mm, names) {
  const suspendedNow = (n) => !loaded(mm, n) && mm.supervisor != null && mm.supervisor.status(n) != null && mm.supervisor.status(n).state === 'suspended';
  visibility.show(names.filter(suspendedNow));
  goneOrHidden(names.filter((n) => !suspendedNow(n)));
}

// a confined module's files, walked for links out of --modulesRoot, at most
const WALK_MAX = 20000;
const DRAIN_POLL_MS = 50;

function refusal(code, message) {
  return Object.assign(new Error(message), {code: code});
}

function packageNameOf(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name; } catch (e) { return null; }
}

// The kernel's real path (#10: confinement decides on what the kernel
// opens). Node's JS realpath resolves a chain like x -> ".", a -> "x/..",
// b -> "a/.." to the module's own directory, where a POSIX kernel walks one
// level up per link, so --modulesRoot's check would pass a link that leads
// out of it (the back-sweep, 11-18). Two sources, by what is resolved (the
// Reviewer's high review of #442, 2):
// - a path inside the roots (a module's directory, a link in it): resolved
//   now, natively, never a startup-recorded result a directory repointed
//   since would make stale;
// - a root (--modulesRoot: startup configuration): by
//   lib/hardened-realpaths.js, which under --hardened answers the parent's
//   recorded result (a live realpath of a grant root the parent resolved
//   can be refused there, ERR_ACCESS_DENIED, which would leave no root and
//   refuse every load in place), and the native realpath otherwise.
function realOf(dir) {
  try { return fs.realpathSync.native(dir); } catch (e) { return null; }
}
function rootRealOf(dir) {
  try { return hardenedRealpaths.realpathSync(dir); } catch (e) { return null; }
}

// The real paths of --modulesRoot (M4: the module form).
function modulesRoots() {
  return (Array.isArray(options.modulesRoot) ? options.modulesRoot : []).map(rootRealOf).filter((r) => r != null);
}
// a real path already resolved, inside one of the roots
function realInside(real, rs) {
  return real != null && rs.some((r) => real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}
function insideRoots(dir, rs) {
  return realInside(realOf(dir), rs);
}

// The first link under a module's directory (an entry file, a handler, a
// directory) whose target is outside the roots, or missing; null if none.
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

// A unit's record: {dir, modules: Map(name -> {path, version, listed}),
// tools: Set, prompts: Set}. mm.packsInPlace: name
// -> record, seeded with what the runtime was started with (mm.startPlan,
// recorded at start), then kept by each load, unload and reload in place.
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
      // a unit the start seeds is recorded under its package name (in the
      // store the path's first directory would be @countinghouse for every
      // one: #413 section 16, rule 3)
      mm.packsInPlace.set(name, {dir: dir, modules: modules, tools: new Set(toolsOf(dir)), prompts: new Set(promptsOf(dir))});
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

function refusalOf(r) {
  if (r.code === 'PART_VERSION_CONFLICT') {
    return CountinghouseError.withFields('PART_VERSION_CONFLICT', {scenario: r.name, name: r.part, versions: r.versions.join(', ')});
  }
  return new CountinghouseError(r.code, moduleRoles.refusedWhy(r));
}

const loaded = (mm, name) => mm.modules[name] != null;
// Present: in the module map, or out of it while it restarts after a crash
// (its supervisor's record in state 'restarting') and a unit's record holds
// it (#397). A load or a reload never loads a present module again as new, so
// its rollback never unloads one it did not bring in; its restart stands. A
// suspended module is not present: the supervisor has given up on it (its
// self-unload is queued), and a load brings it back fresh, which moves its
// generation so that self-unload stands down, as before. One no unit holds
// (loaded outside any) is not present either, as before.
// A suspended module a unit's record holds: loaded again as new (it is not
// present), and journalled with its supervisor record, so a rollback puts its
// suspension back and queues a new self-unload for it, with the code it was
// given up with (#397's residual 1). -> {record} or null.
function suspendedHeld(mm, name) {
  if (loaded(mm, name) || mm.supervisor == null) return null;
  const st = mm.supervisor.status(name);
  if (st == null || st.state !== 'suspended' || ![...packsOf(mm).values()].some((p) => p.modules.has(name))) return null;
  return {record: mm.supervisor.records[name]};
}
// (puts a re-added module's suspension back, after its fresh instance went:
// its record, and a self-unload queued anew -- the one queued before stands
// down, its generation passed; generations only move forward: the medium's
// round 3 on #397)
function putSuspensionBack(mm, name, was) {
  if (was == null || mm.supervisor == null) return;
  mm.supervisor.records[name] = was.record;
  if (typeof(mm.givenUp) === 'function') mm.givenUp(name, (was.record != null && was.record.givenUpCode) || 'MODULE_SUSPENDED');
}

function present(mm, name) {
  if (loaded(mm, name)) return true;
  const st = mm.supervisor != null ? mm.supervisor.status(name) : null;
  return st != null && st.state === 'restarting' && [...packsOf(mm).values()].some((p) => p.modules.has(name));
}

// generation: a reload's own (replaceDrainThenSwitch), held by the spawn
function loadOne(mm, entry, {generation = null} = {}) {
  // test hook (under the test flag only): a module whose load in place
  // starts this long after it is asked, as a slow spawn would (M4: what a
  // load newly brings in stays hidden meanwhile)
  const holdMs = (process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG === '1' && process.env.COUNTINGHOUSE_TEST_LOAD_HOLD_MODULE === entry.name)
    ? Number(process.env.COUNTINGHOUSE_TEST_LOAD_HOLD_MS) : NaN;
  return new Promise((resolve, reject) => {
    // (resolves with the instance loaded: a switch that stood down unloads
    // its own)
    const load = () => mm.loadModuleFromPath(entry.path, entry.name, entry.version, (err, mi) => (err != null ? reject(err) : resolve(mi)), {generation});
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
// why: 'reload' for a switch's unload (its devices marked reloading, their
// specs kept listed: ModuleManager markEndedDevices)
function unloadOne(mm, name, why = undefined) {
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
  }, why));
}

// Pack operations run one at a time: the control channel, their only caller
// (lib/control-channel.js, through lib/module-control.js), serialises every
// load, reload and unload on one promise chain. What follows rests on that
// (a module held by another pack is read from the records, never from an
// operation under way), so one arriving while another is under way is refused.
function oneAtATime(mm, name) {
  if (mm.packsLoading != null && mm.packsLoading.size > 0) {
    throw refusal('CONTROL_FAILED', `${name}: another module operation is under way (${[...mm.packsLoading.keys()].join(', ')}); module operations are serialised`);
  }
}

// What a module still owes: its routed calls, the calls held on it for its
// composition verdict (lib/device-manager.js HeldCall), and its direct
// peer invokes (matched and unbilled, or announced on its channels).
function owedBy(old, dm) {
  const routed = (old.msgQueue != null) ? Object.keys(old.msgQueue).length : 0;
  const held = require('./device-manager').verdictHeldOn(old);
  const broker = (dm != null) ? dm.peerChannelBroker : null;
  return routed + held + ((broker != null && typeof(broker.openInvokesTo) === 'function') ? broker.openInvokesTo(old) : 0);
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

// superseded(): a later action took the module meanwhile; waiting ends then
function waitRegistered(mm, name, old, superseded = () => false) {
  const deadline = Date.now() + 5000;
  return new Promise((resolve) => {
    const poll = () => {
      const wm = mm.modules[name];
      const up = wm != null && wm !== old && Object.keys(wm.deviceList || {}).length > 0;
      if (!up && !superseded() && Date.now() < deadline) return setTimeout(poll, DRAIN_POLL_MS).unref();
      resolve();
    };
    poll();
  });
}

// A module at another version: drain, then switch. While it is replaced,
// new calls to its device wait (lib/device-manager.js onInvokeDeviceAction)
// and new direct peer channels to it are denied (lib/peer-channel-broker.js).
// The switch is the runtime's own reload (unload, then spawn).
// unit (M4a): the reload's unit; its notes of this module (loaded,
// registered) are cleared as the new instance starts, so only that
// instance's registration counts -- never one of the old version's, a
// supervised restart during the drain, say (the reload's review item 4).
// step: the reload's journal step for this switch, which records the
// generation (rollbackStep)
async function replaceDrainThenSwitch(mm, dm, entry, unit = null, step = null) {
  const name = entry.name;
  // The reload's own action, taken first and held through every window of
  // the switch (the drain, the spawn, the registration; the unload and load
  // of a restarting or suspended one): an operator action on the module
  // meanwhile (an unload or a restart: POST /unload-module, /restart-module;
  // under --ipc there are no admin routes, and the control channel
  // serialises its own) takes a generation of its own, and the switch stands
  // down with MODULE_LOAD_SUPERSEDED instead of bringing the module back.
  // Recorded on the journal step, so the rollback never switches the module
  // back over such an action, during the switch or after it (the
  // back-sweep's group 3; the Reviewer's high review of #441, 3, 4, 6, 7;
  // its medium, 1 and 2).
  const gen = mm.nextGeneration(name);
  if (step != null) step.gen = gen;
  const stillMine = () => mm.generations[name] === gen;
  const superseded = () => new CountinghouseError('MODULE_LOAD_SUPERSEDED', name);
  // within a unit, a failed load does not settle the module's reloading
  // records: the unit's rollback switches it back with them still listed,
  // and the unit's end settles what never came back (unitDone; the medium
  // review of #435's high fixes, 2)
  if (unit != null) {
    if (!(mm.settleHeld instanceof Set)) mm.settleHeld = new Set();
    mm.settleHeld.add(name);
  }
  const old = mm.modules[name];
  const WorkerMessage = require('./worker-message');
  const fresh = () => { if (unit != null) { unit.loaded.delete(name); unit.registered.delete(name); } };
  if (!(mm.replacingInPlace instanceof Map)) mm.replacingInPlace = new Map();
  if (!(old instanceof WorkerMessage)) {
    // a restarting or suspended module (out of the map): what the
    // supervisor keeps listed goes into reloading records before the
    // unload clears it (the high review of #435's medium round, 2); and a
    // per-session record's calls and hops wait through the switch (3)
    // Worker mode only: single-thread reloads keep their old window (the
    // high review's scope cut).
    const inWorkers = options.workerThread === true;
    if (inWorkers) {
      mm.keepRetainedForReload(name);
      mm.replacingInPlace.set(name, true);
    }
    try {
      await unloadOne(mm, name, 'reload');
      if (!stillMine()) throw superseded();
      fresh();
      // (single-thread loadModuleFromPath takes no generation: checked after
      // too, as the worker branch is: the Reviewer's high review of #442, 3)
      const loaded = await loadOne(mm, entry, {generation: gen});
      if (!stillMine()) {
        // the later action found nothing of ours to unload (it came before
        // this load put the module in the map): our instance, if it is still
        // the one there, goes now, never left serving over that action (the
        // medium on #442's high round, 1)
        const ours = mm.modules[name];
        if (ours != null && ours === loaded) await unloadOne(mm, name, 'reload');
        throw superseded();
      }
      return loaded;
    } catch (err) {
      // a load refused before it reached the worker settles nothing itself:
      // outside a unit nothing else would (within one, unitDone does)
      if (unit == null && inWorkers) mm.settleEndedDevices(name, {only: 'MODULE_RELOADING'});
      throw err;
    } finally {
      if (inWorkers) mm.replacingInPlace.delete(name);
    }
  }
  mm.replacingInPlace.set(name, true);
  old.replacing = true;
  try {
    await drainCalls(old, dm);
    if (!stillMine()) throw superseded();
    fresh();
    await new Promise((resolve, reject) => mm.loadModuleByWorker(entry.path, name, entry.version, (err) => (err != null ? reject(err) : resolve()), {generation: gen}));
    await waitRegistered(mm, name, old, () => !stillMine());
    if (!stillMine()) throw superseded();
  } finally {
    old.replacing = false;
    mm.replacingInPlace.delete(name);
  }
}

// The records a failed reload leaves untrue, marked uncertain with its
// reason: the units it named, and every other unit whose record holds a
// module that was not put back or was left to a later action (the medium on
// #442's high round, 4). A reload of any of them is refused until the
// runtime restarts; an unload still runs.
function markUncertain(mm, named, modules, why) {
  const touched = new Set(modules);
  for (const [key, rec] of packsOf(mm)) {
    const holds = rec.modules instanceof Map && [...rec.modules.keys()].some((m) => touched.has(m));
    if (named.includes(key) || holds) Object.assign(rec, {uncertain: true, uncertainWhy: why});
  }
}

// What a failed reload's rollback could not make all-or-none, said once
function uncertainWhy(failed, left) {
  const parts = [];
  if (failed.length > 0) parts.push(`${failed.join(', ')} could not be put back`);
  if (left.length > 0) parts.push(`${left.join(', ')} ${left.length === 1 ? 'was' : 'were'} left to a later operator action`);
  return parts.join(', and ');
}

// One journal step of a failed reload undone (reloadModuleUnits and
// reloadPack; the Reviewer's high review of #441, 7): an addition hidden and
// unloaded again; a switch whose module a later action took since (its
// generation moved past the one the switch recorded: replaceDrainThenSwitch)
// left as that action left it, whether the switch stood down or had
// finished ('left': the reload is then not all-or-none, so its outcome is
// uncertain: the high review of #442, 1); a switch put back to what it was.
// A switch with nothing to put back to is uncertain where the caller says so.
// -> 'putBack' | 'left' | 'uncertain' | null; throws what putting back threw.
async function rollbackStep(mm, dm, step, {unit = null, say = () => {}, noBackIsUncertain}) {
  if (step.added != null) {
    // shown once it loaded: hidden again before its unload (#427's high
    // review, 8)
    visibility.hide([step.added]);
    await unloadOne(mm, step.added);
    goneOrHidden([step.added]);
    putSuspensionBack(mm, step.added, step.suspended);
    return null;
  }
  if (step.gen != null && mm.generations[step.switched] !== step.gen) {
    LOG.I(`module: ${step.switched} was not switched back: a later action on it outranked the reload`);
    return 'left';
  }
  if (step.back != null) {
    say(`switched back ${step.switched}`);
    await replaceDrainThenSwitch(mm, dm, step.back, unit);
    return 'putBack';
  }
  // nothing recorded to switch it back to: it runs the new version, so the
  // outcome is uncertain, never all-or-none (#427's high review, 3)
  return step.switched != null && noBackIsUncertain ? 'uncertain' : null;
}

function setListed(mm, name, listed) {
  if (listed === false) mm.unlisted.add(name); else mm.unlisted.delete(name);
}

// ---- The module form (M4; #413 sections 7.1-7.3) ----
// {type: 'load', name: '<top-level package>', dirs: {'<package>': '<absolute
// dir>', ...}, credentials?: {'<package>': {'<origin>': {'<VARIABLE>':
// 'COUNTINGHOUSE_CREDENTIAL_<n>'}}}, notice?}. The unit is a top-level
// module and its closure, found only among the directories given. The pack
// form's fields (scenario, pack, global, remoteCredentials) are refused
// (old-field): that form is gone (M6).
const MAX_DIRS = 64;
const OLD_FIELDS = ['scenario', 'pack', 'global', 'remoteCredentials'];
const isPackage = (n) => require('./remote/credentials').isPackage(n);

// Every open session told once, on a shared runtime; the one client
// otherwise (#429's high review, 6: one helper for module-control, the
// supervisor's unload and the module settings' notices). notices and
// shared(): module-control's own, which its tests replace.
// (max: the runtime's own text's bound, lib/notices.js OWN_NOTICE_MAX)
// (own: the runtime's own lane, never evicted by other notices)
function tellEverySession(module, text, {notices = require('./notices'), shared = () => require('./sessions').shared(), max = undefined, own = false} = {}) {
  const bound = Object.assign(max === undefined ? {} : {max}, own === true ? {own: true} : {});
  if (shared() === true) {
    for (const id of require('./sessions').ids()) notices.add(module, text, Object.assign({session: id, sessionOnly: true}, bound));
    // (and kept for the sessions that join later: lib/notices.js keep)
    if (typeof(notices.keep) === 'function') notices.keep(module, text, bound);
  } else notices.add(module, text, bound);
}

// A module-form message's shape, before anything is read from disk (#413
// section 7.3; the shared vectors' moduleMessages), judged by the rule of
// `type`: the handler it reached (its own type field never chooses the
// rule). -> null, or {reason, message}, reason one of name, names, dirs,
// credentials, old-field.
function moduleMessageProblem(type, msg) {
  const {SLOT} = require('./remote/credentials');
  const isObj = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
  const bad = (reason, message) => ({reason, message});
  if (!isObj(msg)) return bad('name', 'a control message is an object');
  if (type === 'module-stopped') {
    if (!isPackage(msg.name)) return bad('name', 'a module is named by its package name');
    return (typeof(msg.code) === 'string' && (msg.when === 'start' || msg.when === 'restart')) ? null : bad('name', 'module-stopped carries a code and when');
  }
  // (a notice carrying the pack form's fields is refused too: M6's medium review, 3)
  if (type === 'notice' && OLD_FIELDS.some((f) => msg[f] !== undefined)) return bad('old-field', 'a notice carries no scenario, pack, global or remoteCredentials');
  // (a notice with no module is about none, as ch-local sends one)
  if (type === 'notice') return (msg.module == null || isPackage(msg.module)) && typeof(msg.text) === 'string' ? null : bad('name', 'a notice names a module by its package name, or none');
  if (type === 'reread') {
    if (msg.what !== 'module-settings' && msg.what !== 'held-back') return bad('name', 'reread names what it reads: module-settings or held-back');
    // (nothing else rides on it: the shared vectors, B-firstrun)
    return Object.keys(msg).every((k) => k === 'id' || k === 'type' || k === 'what') ? null : bad('name', 'reread carries only id, type and what');
  }
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
  // its handler checked its shape by the one rule, once
  // (lib/module-control.js checked, moduleMessageProblem; #455's high
  // review, 4): what is left here is what reads the disk (the medium review
  // of #429's high fixes, 3 and 9)
  const d = msg.dirs;
  const rs = modulesRoots();
  if (rs.length === 0) throw refusal('CONTROL_FAILED', `${label}: this runtime was given no --modulesRoot, so it loads no module in place`);
  const dirs = new Map();
  const seen = new Map();   // real dir -> package
  for (const [name, dir] of Object.entries(d)) {
    // (judged and read at the one real path kept: never the directory
    // resolved again -- the high on #419)
    const real = realOf(dir);
    if (!realInside(real, rs)) throw refusal('CONTROL_FAILED', `${name}: its directory is outside --modulesRoot`);
    const pkgName = packageNameOf(real);
    if (pkgName !== name) throw refusal('CONTROL_FAILED', `${name}: the package at that directory is ${String(pkgName).slice(0, 128)}`);
    if (seen.has(real)) throw refusal('CONTROL_FAILED', `${name}: the same directory as ${seen.get(real)}`);
    seen.set(real, name);
    dirs.set(name, real);
  }
  // a part is found by its friendly name among these: one name, one
  // directory (the medium review's finding 10)
  const friendly = new Map();
  for (const [name, real] of dirs) {
    const f = moduleRoles.friendlyNameOf(real);
    if (typeof(f) !== 'string') continue;
    if (friendly.has(f)) throw refusal('CONTROL_FAILED', `${friendly.get(f)} and ${name} hold modules with the friendly name ${f}`);
    friendly.set(f, name);
  }
  const credentials = new Map();
  if (msg.credentials !== undefined) {
    for (const [name, entry] of Object.entries(msg.credentials)) {
      try {
        credentials.set(name, require('./remote/credentials').checkEntry(name, entry));
      } catch (e) {
        throw refusal('CONTROL_FAILED', String(e.message).slice(0, 240));
      }
    }
  }
  return {dirs, credentials, roots: rs};
}

// (msg: its shape checked by its handler, lib/module-control.js)
function readModuleRequest(msg, {needsDirs}) {
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
    // checked again by the path that loads: a link swapped in after the
    // request was read never loads from outside the root (#427's high
    // review, 4)
    if (!realInside(real, req.roots)) throw refusal('CONTROL_FAILED', `${label}: its module ${e.name} is outside --modulesRoot`);
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

// The order a reload switches its modules in (#413 section 7.3): a called
// module before the module that calls it -- a depth-first walk of each
// module's countinghouse.calls from the tops, in the closure's order, each
// module placed after what it calls -- so modules that call each other in a
// cycle come in the walk's order, fixed for a given request.
// The closure's call graph: name -> the modules of the closure it calls.
function callGraph(entries) {
  const byFriendly = new Map();
  for (const e of entries.values()) {
    const f = moduleRoles.friendlyNameOf(e.path);
    if (typeof(f) === 'string') byFriendly.set(f, e.name);
  }
  const graph = new Map();
  for (const e of entries.values()) {
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(e.path, 'package.json'), 'utf8')); } catch (err) { pkg = null; }
    graph.set(e.name, (pkg != null) ? moduleRoles.partsOf(pkg).map((f) => byFriendly.get(f)).filter((n) => n != null) : []);
  }
  return graph;
}

function calleesFirst(entries, tops, graph = callGraph(entries)) {
  const order = [];
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name) || !entries.has(name)) return;
    seen.add(name);
    for (const c of (graph.get(name) || [])) walk(c);
    order.push(name);
  };
  for (const t of tops) walk(t);
  for (const n of entries.keys()) walk(n);
  return order;
}

// A module a reload has just added or switched, verified at once, on its
// own: its callees were switched or added before it (calleesFirst), so it
// can be bound now. A caller still being drained hops into it, and that
// drain is what the unit's end waits for: left to the unit's one pass, the
// call would wait the composition window out (CTX_CALL_NOT_READY). Only the
// module itself: its callers outside the unit wait for that pass (the
// reload's review items 1 and 2); no window is touched (item 7).
function verifyOwn(dm, names) {
  if (dm == null || typeof(dm.verificationPass) !== 'function' || names.length === 0) return;
  try {
    dm.verificationPass(new Set(names));
  } catch (err) {
    LOG.E(new Error(`composition: a module a reload switched could not be verified: ${err.message}`));
  }
}

// {type: 'reload', names: [...], dirs, credentials?}: the named loaded
// top-level modules, and their closures, brought to the directories given,
// all or none (#413 section 7.3): the plan made and checked whole (a module
// changes version only when every loaded top-level module that holds it is
// named: PART_VERSION_CONFLICT otherwise); what the new closures add loaded
// first, hidden, then shown together; each module at another version
// drained then switched, callees first; what no record holds any more
// unloaded. A failure switches back what was switched and unloads what was
// added (CONTROL_MODULE_UNCERTAIN when that fails too).
// (msg: its shape checked by its handler, lib/module-control.js)
async function reloadModuleUnits(mm, msg, dm) {
  const names = msg.names;
  const label = names.join(', ');
  oneAtATime(mm, label);
  for (const n of names) if (!packsOf(mm).has(n)) throw refusal('CONTROL_FAILED', `${n} is not loaded; load it`);
  for (const n of names) {
    if (packsOf(mm).get(n).uncertain === true) throw refusal('CONTROL_MODULE_UNCERTAIN', `${n}: ${packsOf(mm).get(n).uncertainWhy || 'the runtime could not fully unload it after it gave up on one of its modules'}; nothing of it is reloaded until countinghouse restarts`);
  }
  const req = Object.assign({tops: names}, readDirs(msg, names));
  const {entries, owners} = closurePlan(req, mm, names);
  stillHidden(entries.keys());
  const forbidden = moduleCeilingRefusal([...entries.keys()]);
  if (forbidden != null) throw forbidden;
  const credentials = require('./remote/credentials');
  const say = (what) => LOG.I(`module: reload of ${label}: ${what}`);

  const records = new Map(names.map((n) => [n, packsOf(mm).get(n)]));
  const before = new Map();
  for (const rec of records.values()) for (const [n, e] of rec.modules) before.set(n, e);
  const versionNow = (n) => {
    if (before.has(n)) return before.get(n).version;
    const wm = mm.modules[n];
    if (wm != null && wm.packageInfo != null) return wm.packageInfo.version;
    // (out of the map, as its supervisor recorded it: #397)
    const r = mm.supervisor != null ? mm.supervisor.recorded(n) : null;
    return r != null ? r.version : null;
  };
  const graph = callGraph(entries);
  const order = calleesFirst(entries, names, graph);
  const flat = (e) => (e == null ? '' : JSON.stringify([...e].map(([o, v]) => [o, [...v].sort()]).sort()));
  const credentialsBefore = new Map([...req.dirs.keys()].map((n) => [n, credentials.moduleEntry(n)]));
  const wanted = (n) => (req.credentials.has(n) ? req.credentials.get(n) : null);
  const additions = order.filter((n) => !present(mm, n)).map((n) => entries.get(n));
  // (a present member out of the map -- restarting -- whose allowance changes
  // is switched at its version: a restart already spawning took the old
  // allowance, so it is ended and loaded again with the new one, as an
  // addition would have been: the medium's round 3 on #397)
  const restartingRecredentialed = (n) => !loaded(mm, n) && flat(credentialsBefore.get(n)) !== flat(wanted(n));
  const switches = order.filter((n) => present(mm, n) && (versionNow(n) !== entries.get(n).version || restartingRecredentialed(n))).map((n) => entries.get(n));
  const heldByOthers = (n) => [...packsOf(mm)].some(([k, p]) => !names.includes(k) && p.modules.has(n));
  const removed = [...before.keys()].filter((n) => !entries.has(n) && !heldByOthers(n));

  const unlistedBefore = new Set(mm.unlisted);
  // the request is authoritative for every module it names (#427's high
  // review, 7): given credentials replace its allowance, absent ones clear
  // it -- a revoke -- kept modules included; a kept module whose allowance
  // changed has its remote registered again once the reload has completed
  // compared whatever their order (the medium review of #427's high fixes, 8)
  // a module another, unnamed unit holds changes its allowance only when
  // every holder is named, as its version does (finding 3): refused, with
  // nothing changed
  for (const n of req.dirs.keys()) {
    if (heldByOthers(n) && flat(credentialsBefore.get(n)) !== flat(wanted(n))) {
      throw refusal('CONTROL_FAILED', `${n}: its credentials can change only when every loaded module that holds it is named in the reload`);
    }
  }
  const changing = new Set(additions.map((e) => e.name).concat(switches.map((e) => e.name)));
  const keptChanged = [...req.dirs.keys()].filter((n) => !changing.has(n) && flat(credentialsBefore.get(n)) !== flat(wanted(n)));
  const applyCredentials = () => {
    for (const n of req.dirs.keys()) {
      if (req.credentials.has(n)) credentials.setModule(n, req.credentials.get(n));
      else credentials.clearModule(n);
    }
  };
  for (const e of additions) setListed(mm, e.name, e.listed);
  visibility.hide(additions.map((e) => e.name));
  // under its view key, as its record is (the medium review of #429's high
  // fixes, 1)
  for (const n of names) loading(mm, n, entries.keys());
  // a unit (#423; the reload's review items 1, 5, 7): what this reload itself
  // starts -- its additions and its switches -- re-runs no discovery and
  // opens no window until the unit is whole, and a full pass some other load
  // triggers leaves them, and the modules outside that call them, alone; a
  // kept module (same version) is not held, so its own supervised restart
  // runs its own discovery; a module the reload drops is not in the unit,
  // so its callers are not re-verified (they answer DEVICE_NOT_FOUND at the
  // call, as after an unload: item 6)
  const unit = mm.holdDiscovery(additions.map((e) => e.name).concat(switches.map((e) => e.name)));
  try {
    const journal = [];
    try {
      // inside the try: a failure anywhere puts every named module's
      // allowance back (finding 5)
      applyCredentials();
      for (const e of additions) {
        journal.push({added: e.name, suspended: suspendedHeld(mm, e.name)});
        await loadOne(mm, e);
        say(`loaded ${e.name}`);
      }
      // every addition is up: shown together, before any switch, so a
      // caller switched next never meets a part still hidden
      // an addition is verified once every module it calls is in its final
      // version: at once, or after the switch of the last one it calls
      // (the medium review's finding 5)
      const pendingSwitch = new Set(switches.map((e) => e.name));
      let unverified = additions.map((e) => e.name);
      const verifyReady = () => {
        const ready = unverified.filter((n) => !(graph.get(n) || []).some((c) => pendingSwitch.has(c)));
        unverified = unverified.filter((n) => !ready.includes(n));
        verifyOwn(dm, ready);
      };
      if (additions.length > 0) {
        await unitRegistered(unit, additions.map((e) => e.name));
        visibility.show(additions.map((e) => e.name));
        say(`shown ${additions.map((e) => e.name).join(', ')}`);
        verifyReady();
      }
      for (const e of switches) {
        const was = before.get(e.name);
        // what to switch back to: the record's, else the loaded module's own
        // (finding 6); with neither, the outcome is uncertain
        const wm = mm.modules[e.name];
        const loadedBack = (wm != null && typeof(wm.modulePath) === 'string' && wm.packageInfo != null && typeof(wm.packageInfo.version) === 'string')
          ? {path: wm.modulePath, name: e.name, version: wm.packageInfo.version} : null;
        journal.push({switched: e.name, back: (was != null) ? {path: was.path, name: e.name, version: was.version} : loadedBack});
        say(`switching ${e.name}`);
        await replaceDrainThenSwitch(mm, dm, e, unit, journal[journal.length - 1]);
        // its own verdict now (its callees switched before it), so a caller
        // still being drained, whose calls hop into it, is not left waiting
        // for the unit's end, which waits for that drain
        await unitRegistered(unit, [e.name]);
        verifyOwn(dm, [e.name]);
        pendingSwitch.delete(e.name);
        verifyReady();
      }
      // every module this reload started has registered (its own instance)
      await unitRegistered(unit, additions.map((e) => e.name).concat(switches.map((e) => e.name)));
    } catch (err) {
      for (const [n, entry] of credentialsBefore) {
        if (entry != null) credentials.setModule(n, entry); else credentials.clearModule(n);
      }
      mm.unlisted.clear();
      for (const n of unlistedBefore) mm.unlisted.add(n);
      const failed = [];
      const left = [];
      const putBack = [];
      for (const step of journal.reverse()) {
        try {
          const done = await rollbackStep(mm, dm, step, {unit, say, noBackIsUncertain: true});
          if (done === 'putBack') putBack.push(step.switched);
          else if (done === 'uncertain') failed.push(step.switched);
          else if (done === 'left') left.push(step.switched);
        } catch (e) {
          failed.push(step.added || step.switched);
          LOG.E(new Error(`module: ${label}: a reload's rollback could not put ${step.added || step.switched} back: ${e.message}`));
        }
      }
      // every addition out of view again: one whose load never ran (a load
      // before it failed) is out of the map, so it leaves the set too (the
      // medium review's finding 1)
      afterRollback(mm, additions.map((e) => e.name));
      // what the rollback put back has registered before the unit's pass
      // (the reload's review item 3)
      try {
        await unitRegistered(unit, putBack);
      } catch (e) {
        failed.push(...putBack);
        LOG.E(new Error(`module: ${label}: a reload's rollback put ${putBack.join(', ')} back, not registered in time: ${e.message}`));
      }
      if (failed.length > 0 || left.length > 0) {
        // the records no longer say what runs: marked, so a reload of them
        // is refused until the runtime restarts (an unload still runs)
        const why = uncertainWhy(failed, left);
        markUncertain(mm, names, failed.concat(left), why);
        throw refusal('CONTROL_MODULE_UNCERTAIN', `${label}: the reload failed (${err.code || 'error'}: ${String(err.message).slice(0, 120)}), and ${why}; the modules' state is uncertain until countinghouse restarts`);
      }
      throw err;
    }
    // the records: each named module's own closure
    for (const n of names) {
      const own = new Map();
      for (const [m, e] of entries) if (owners.has(m) && owners.get(m).has(n)) own.set(m, {path: e.path, version: e.version, listed: e.listed});
      packsOf(mm).set(n, {dir: req.dirs.get(n), modules: own,
        tools: new Set(toolsOf(req.dirs.get(n))), prompts: new Set(promptsOf(req.dirs.get(n)))});
    }
    visibility.hide(removed);
    for (const n of removed) {
      say(`unloading ${n}`);
      await unloadOne(mm, n);
      mm.unlisted.delete(n);
      credentials.dropModule(n);
    }
    goneOrHidden(removed);
    recomputeUnlisted(mm);
    // a kept module's new allowance (or none) takes effect now
    // (its remote clients are rebuilt: a call in flight on them ends, as at a
    // revoke it must; a registration refused is logged by registerRemotes)
    for (const n of keptChanged) {
      if (typeof(mm.reRegisterRemotes) !== 'function') continue;
      // (one restarting has no remote to register now: its next spawn takes
      // the new allowance)
      say(mm.modules[n] != null ? `credentials of ${n} changed; its remote registered again` : `credentials of ${n} changed; its next start takes them`);
      mm.reRegisterRemotes(n);
    }
    return {modules: [...entries.keys()]};
  } finally {
    // the unit's one pass, scoped to what it started and the modules outside
    // it that call them (item 2: their binding kept on a target not loaded,
    // cleared on any other failure); it ends no other load's window (item 7)
    try { for (const n of names) loaded_(mm, n); } finally { unitDone(mm, dm, unit); }
  }
}

// The operator's ceiling (#413 section 8), by each module's package name: a
// trusted `modules` list must name every one; a ceiling that still holds
// `packs` is not trusted (lib/settings-ceiling.js NO_LONGER_READ, at parse),
// so it refuses every load as SETTING_CEILING_UNTRUSTED. -> null, or the
// refusal.
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
  return null;
}

// The supervisor gave up on `name` (#413 section 7.3): each unit whose
// closure holds it loses its record, and each of its modules no other
// record holds is unloaded as an unload does it (hidden, out of the module
// map, the supervisor's record cleared, its devices no longer listed). Only
// once all of that is gone is ch-local told {type: 'module-stopped', name,
// code, when: 'restart'}, once per top-level module, and the sessions told.
// If a module is still in the map, the records are put back, it stays
// hidden and nothing is told: ch-local still holds the units as loaded, and
// its own unload meets the same failure. Runs on the control channel's
// chain (lib/module-manager.js givenUp).
async function selfUnload(mm, name, code, stillGivenUp = () => true) {
  // it ran later, on the channel's chain: a module restarted or reloaded
  // meanwhile (an unload and a load queued ahead, POST /restart-module) is
  // no longer given up, and is left alone (#429's high review, 2)
  if (stillGivenUp() !== true) {
    LOG.I(`module: ${name} is no longer given up; the runtime does not unload it`);
    return;
  }
  const units = [...packsOf(mm)].filter(([, p]) => p.modules.has(name)).map(([top]) => top);
  if (units.length === 0) return;
  const records = new Map(units.map((t) => [t, packsOf(mm).get(t)]));
  let stay;
  try {
    ({stay} = await unloadUnits(mm, records));
  } catch (e) {
    // cut short: each module still in the map is said, and so is each
    // already gone (its allowance and credentials too); the records come
    // back marked uncertain below, so a reload is refused and an unload,
    // which takes a module already gone, is still taken (the medium review
    // of #429's high fixes, 4)
    const held = [...new Set([...records.values()].flatMap((rec) => [...rec.modules.keys()]))];
    stay = held.filter((n) => mm.modules[n] != null);
    const went = held.filter((n) => mm.modules[n] == null);
    LOG.E(new Error(`module: unloading after the runtime gave up on ${name} failed (${e.message}); still loaded: ${stay.join(', ') || 'none'}; unloaded: ${went.join(', ') || 'none'}`));
    if (stay.length === 0) stay = [name];
  }
  if (stay.length > 0) {
    // ch-local still holds the units as loaded, so the records come back,
    // marked: what they say is no longer whole, so a reload of one is
    // refused (until a restart) and only an unload is taken (M4b's
    // medium review, 8)
    for (const [t, rec] of records) packsOf(mm).set(t, Object.assign(rec, {uncertain: true, uncertainWhy: null}));
    recomputeUnlisted(mm);
    LOG.E(new Error(`module: ${stay.join(', ')} still loaded after the runtime gave up on ${name}; hidden until the runtime ends, nothing told`));
    return;
  }
  for (const t of units) {
    // one unit's failure never stops the rest being told (#429's high review, 1)
    try {
      LOG.E(new Error(`module: ${t} unloaded: the runtime gave up on ${name} (${code})`));
      require('./control-channel').tell({type: 'module-stopped', name: t, code: code, when: 'restart'});
      tellEverySession(t, `${t} stopped (${code}); it is tried again when countinghouse restarts`);
    } catch (e) {
      LOG.E(new Error(`module: telling that ${t} stopped failed: ${e.message}`));
    }
  }
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
  // each directory's real path resolved once (#429's high review, 10); what
  // loads is that checked real path, a top-level module's as a part's, so a
  // link swapped after the check never leads a later spawn outside the root
  // (#429's high review, 4)
  // (the one real path judged is the one kept: never the directory resolved
  // again, which a link swapped in between could answer inside the root --
  // the high on #419)
  const why = (real) => {
    if (!realInside(real, rs)) return 'it is outside --modulesRoot';
    const out = linkOut(real, rs);
    return (out != null) ? `it has a link outside --modulesRoot (${path.relative(real, out) || out})` : null;
  };
  const kept = [];
  const refused = [];
  for (const d of tops) {
    const real = realOf(d);
    const w = why(real);
    if (w == null) { kept.push(real); continue; }
    // (named by the package at the real path judged, when there is one)
    const name = packageNameOf(real != null ? real : d);
    const code = (real == null) ? 'INVALID_MODULE_PATH' : 'MODULE_PATH_OUTSIDE_ROOT';
    LOG.E(new CountinghouseError(code, `${d}: not loaded: ${(code === 'INVALID_MODULE_PATH') ? 'it is not there' : w}`));
    // told by its package name only: one with no readable name has none to
    // tell by (module-stopped names a package: M4b's medium review, 7)
    if (isPackage(name)) refused.push({name, code});
  }
  const partDirs = [];
  for (const d of parts) {
    const real = realOf(d);
    const w = why(real);
    if (w == null) partDirs.push(real);
    else LOG.E(new CountinghouseError('MODULE_PATH_OUTSIDE_ROOT', `${d}: the part there is not loaded: ${w}`));
  }
  return {tops: kept, partDirs: partDirs.concat(kept), refused};
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
  // a module that stays loaded and joins or leaves the list changes what
  // tools/list shows with no device coming or going. (One hidden now is told
  // when it is shown.)
  let flipped = false;
  for (const n of held) {
    const was = mm.unlisted.has(n);
    setListed(mm, n, listed.has(n));
    if (was !== mm.unlisted.has(n) && !visibility.isHidden(n)) flipped = true;
  }
  if (flipped) visibility.listingChanged();
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
  const toLoad = [...entries.values()].filter((e) => !present(mm, e.name));
  // (a suspended part another unit holds: its holder's allowance and listing
  // stand, and a failed load puts its suspension back -- #397's residual 1)
  const suspended = new Map(toLoad.map((e) => [e.name, suspendedHeld(mm, e.name)]).filter(([, w]) => w != null));
  const unlistedBefore = new Set([...suspended.keys()].filter((n) => mm.unlisted.has(n)));
  // each module's allowance before its remote registers at its spawn; one
  // already loaded keeps what it has (the medium review's finding 3)
  // authoritative for each module it brings in, as a reload is: given
  // credentials are its allowance, absent ones none (the medium review of
  // #427's high fixes, 2)
  for (const e of toLoad) {
    if (suspended.has(e.name)) continue;
    if (req.credentials.has(e.name)) credentials.setModule(e.name, req.credentials.get(e.name));
    else credentials.clearModule(e.name);
  }
  for (const e of toLoad) if (!suspended.has(e.name)) setListed(mm, e.name, e.listed);
  visibility.hide(toLoad.map((e) => e.name));
  // recorded among the units loading under its package name
  loading(mm, req.name, entries.keys());
  // a unit (#423): its loads re-run no discovery until it is whole
  const unit = mm.holdDiscovery(toLoad.map((e) => e.name));
  try {
    const done = [];
    try {
      for (const e of toLoad) {
        // journalled before its load: one that entered the module map and
        // then failed is taken out again (#427's high review, 5)
        done.push(e.name);
        await loadOne(mm, e);
      }
      await unitRegistered(unit, done);
    } catch (err) {
      try {
        for (const n of done.reverse()) {
          await unloadOne(mm, n);
          // (out of the hidden set before its suspension is back: gone now,
          // as the visibility's predicate reads it -- the high on #528, L1)
          if (suspended.has(n)) visibility.gone([n]);
          putSuspensionBack(mm, n, suspended.get(n));
        }
      } finally {
        for (const e of toLoad) {
          if (suspended.has(e.name)) {
            if (unlistedBefore.has(e.name)) mm.unlisted.add(e.name); else mm.unlisted.delete(e.name);
            continue;
          }
          mm.unlisted.delete(e.name);
          if (req.credentials.has(e.name)) credentials.dropModule(e.name);
        }
        afterRollback(mm, toLoad.map((e) => e.name));
      }
      throw err;
    }
    packsOf(mm).set(req.name, {dir: req.dirs.get(req.name),
      modules: new Map([...entries].map(([n, e]) => [n, {path: e.path, version: e.version, listed: e.listed}])),
      tools: new Set(toolsOf(req.dirs.get(req.name))), prompts: new Set(promptsOf(req.dirs.get(req.name)))});
    recomputeUnlisted(mm);
    visibility.show(toLoad.map((e) => e.name));
    return {modules: [...entries.keys()]};
  } finally {
    try { loaded_(mm, req.name); } finally { unitDone(mm, dm, unit); }
  }
}

// One load, reload and unload: the module form (M4; the pack form is gone,
// M6). The names stay those lib/module-control.js calls.
async function loadPack(mm, msg, dm) {
  return loadModuleUnit(mm, msg, dm);
}

async function unloadPack(mm, msg) {
  const req = readModuleRequest(msg, {needsDirs: false});
  oneAtATime(mm, req.name);
  const pack = packsOf(mm).get(req.name);
  if (pack == null) throw refusal('CONTROL_FAILED', `${req.name} is not loaded`);
  const {gone, stay} = await unloadUnits(mm, new Map([[req.name, pack]]));
  for (const n of stay) LOG.E(new Error(`module: ${n} is still loaded after its unload; it stays hidden until the runtime ends`));
  return {modules: gone};
}

// The units of `records` (Map key -> record) unloaded, as every unload does
// it, ch-local's and the supervisor's (#429's high review, 8): each stays
// owned by its unit until its modules are gone (a view rebuilt meanwhile
// never lists their still-registered devices: the #341 deep review, 1);
// the records leave; each module no other unit holds is hidden from the
// start (a module turned off is not callable because its worker is slow to
// end), loses its unit's allowance, and is unloaded, out of the listing and
// its credentials dropped. -> {gone: the modules unloaded, stay: those still
// in the module map, hidden}. Throws as unloadOne does.
async function unloadUnits(mm, records) {
  for (const [t, rec] of records) loading(mm, t, rec.modules.keys());
  try {
    for (const t of records.keys()) packsOf(mm).delete(t);
    const held = new Set();
    for (const rec of records.values()) for (const n of rec.modules.keys()) held.add(n);
    const gone = [...held].filter((n) => heldElsewhere(mm, null, n) == null);
    visibility.hide(gone);
    for (const n of gone) {
      // in the module map or not (unloadOne)
      await unloadOne(mm, n);
      mm.unlisted.delete(n);
      require('./remote/credentials').dropModule(n);
    }
    const stay = visibility.gone(gone);
    recomputeUnlisted(mm);
    return {gone, stay};
  } finally {
    for (const t of records.keys()) loaded_(mm, t);
  }
}

async function reloadPack(mm, msg, dm) {
  return reloadModuleUnits(mm, msg, dm);
}

// A unit's modules while it loads (mm.packsLoading: name -> {modules}: one
// operation at a time); and once it has loaded, or failed to.
function loading(mm, name, modules) {
  if (mm.packsLoading == null) mm.packsLoading = new Map();
  mm.packsLoading.set(name, {modules: [...modules]});
}
function loaded_(mm, name) {
  if (mm.packsLoading != null) mm.packsLoading.delete(name);
}

// A unit loaded in place is verified as a whole (ch-local #81's acceptance:
// CTX_CALL_UNBOUND after an in-place load). It loads in its closure's order,
// the scenario before its part; each registration re-ran composition
// verification, so a scenario verified before its part had registered was
// given a failed verdict, and its hop answered CTX_CALL_UNBOUND until the
// part's own pass. While a load is in progress, the modules it adds re-run no
// discovery (ModuleManager.prototype.holdDiscovery); a hop meanwhile waits
// for its verdict (the composition window). Once the unit is whole, one pass
// verifies the modules it added, and the modules outside it that call them
// (DeviceManager.prototype.verifyModules). (A reload, a switch and a
// rollback are as before: the modules-in-place design's multi-name reload
// takes them.)
//
// unitRegistered: each module the load added (`names`) whose load was
// acknowledged ('moduleload') has had its registration's outcome,
// registered or refused (ModuleManager's unitRegistration: queued when its
// load is acknowledged, registered synchronously; in single-thread mode once
// discovered). One still without an outcome at the bound (its registration
// deferred: lib/startup-order.js while a start's list loads) fails the load,
// loudly, and it is rolled back: never let through unverified. The bound,
// min(20 s, requestTimeout - 3 s) and at least 1 s, is under the composition
// window (min(25 s, requestTimeout - 2 s)) whenever that window is over 4 s,
// so a hop waiting for the unit hears the load fail first; with a shorter
// requestTimeout a hop does not wait long enough to hear either.
const registrationBoundMs = () => {
  const t = Number(options.requestTimeout);
  return Math.max(1000, Math.min(20000, (Number.isFinite(t) ? t : 30000) - 3000));
};
function unitRegistered(unit, names, boundMs = registrationBoundMs()) {
  const waiting = () => names.filter((n) => unit.loaded.has(n) && !unit.registered.has(n));
  if (waiting().length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unit.changed = null;
      reject(refusal('CONTROL_FAILED', `${waiting().join(', ')}: loaded, but not registered within ${boundMs / 1000} s; the change was not applied`));
    }, boundMs);
    if (typeof(timer.unref) === 'function') timer.unref();
    unit.changed = () => {
      if (waiting().length > 0) return;
      unit.changed = null;
      clearTimeout(timer);
      resolve();
    };
  });
}

// The unit is no longer held, and the modules it added are verified in one
// pass with their callers (DeviceManager.prototype.verifyModules; one its
// rollback took off has no device left, and a pass with no device in it
// runs nothing).
// From a finally: a throw here is logged, never masking the operation's own
// answer or error.
function unitDone(mm, dm, unit) {
  // what a switch held unsettled: every reloading record of it whose device
  // did not register again goes now, whatever the module's state (absent,
  // or present but never registered: the high review of #435's medium
  // round, 4); a device restarting meanwhile is the supervisor's
  if (mm.settleHeld instanceof Set) {
    for (const n of unit.names) if (mm.settleHeld.delete(n)) mm.settleEndedDevices(n, {only: 'MODULE_RELOADING'});
  }
  mm.releaseDiscovery(unit);
  try {
    if (dm != null && typeof(dm.verifyModules) === 'function') dm.verifyModules([...unit.names]);
  } catch (err) {
    LOG.E(new Error(`composition: the verification of a unit loaded in place failed: ${err.message}`));
  }
}

// The loaded top-level modules, as the settings tool shows and turns them
// off (#413 rev 3, section 5.3; M5b): each one's name, the modules its
// closure holds (itself and its parts) and its listed tools.
// -> [{name, modules: [names], tools: [names]}]
function loadedTops(mm) {
  return [...packsOf(mm)].map(([name, r]) => ({name, modules: [...r.modules.keys()], tools: [...r.tools]}));
}

// The top-level modules still loading: a unit loading in place and the
// start's list not yet loaded (lib/module-manager.js startupPending).
// -> [package name]
function loadingTops(mm) {
  const out = new Set();
  if (mm != null && mm.packsLoading instanceof Map) for (const n of mm.packsLoading.keys()) out.add(n);
  if (mm != null && mm.startupPending instanceof Set) for (const n of mm.startupPending) out.add(n);
  return [...out];
}

module.exports = {unitDone, unitRegistered, loadPack, unloadPack, reloadPack, loadedTops, loadingTops, tellEverySession, insideRoots, linkOut,
  readModuleRequest, closureOf, moduleCeilingRefusal, moduleMessageProblem, checkStartPlan, selfUnload, unloadUnits, owedBy};
