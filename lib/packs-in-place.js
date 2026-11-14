'use strict';
// Packs in place (part 2, plan Task A3; docs/superpowers/specs/
// 2026-11-14-packs-in-place-and-settings-tool-design.md section 2): a pack
// loaded, unloaded or reloaded while the runtime serves, at ch-local start's
// request over the control channel (lib/control-channel.js), under the same
// checks as at start. Only in the single-identity profile, under
// --workerThread.
//
// A pack is a scenario and its parts (lib/module-roles.js). The runtime holds
// one version of a module: a part two packs share is loaded once, and a pack
// whose part is loaded at another version is refused whole
// (PART_VERSION_CONFLICT, Task A1). Unloading a pack unloads its scenario and
// every part no other loaded pack's scenario owns.
//
// A reload drains, then switches (the reviewer's ruling A, 2026-11-14): one
// worker and one file broker per module, as the lifecycle lock keeps. A
// module whose version changes finishes the calls it was given on the old
// version, up to --requestTimeout (what it still owes then is answered
// MODULE_RELOADING); new calls to it wait meanwhile, and are served by the
// new version once it is up. The wait is bounded by --requestTimeout plus
// the spawn: the latency cost of a reload in place.
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

// A pack is named by its scenario's package name (the reviewer's ruling,
// 2026-11-14): the name the runtime loaded it under, at start or in place.
const PACK_NAME = /^(@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/;
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

// The pack a message names, checked: {name, scenario, allowance}.
function readRequest(msg, {needsScenario}) {
  if (msg == null || typeof(msg.name) !== 'string' || !PACK_NAME.test(msg.name)) throw refusal('CONTROL_FAILED', 'a pack is named by its scenario\'s package name');
  if (!needsScenario) return {name: msg.name};
  if (typeof(msg.scenario) !== 'string' || !path.isAbsolute(msg.scenario) || packageNameOf(msg.scenario) == null) {
    throw refusal('CONTROL_FAILED', `${msg.name}: its scenario is an absolute path to a module directory`);
  }
  if (packageNameOf(msg.scenario) !== msg.name) {
    throw refusal('CONTROL_FAILED', `${msg.name}: the scenario at that path is ${String(packageNameOf(msg.scenario)).slice(0, 128)}`);
  }
  let allowance = new Map();
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
  return {name: msg.name, scenario: msg.scenario, allowance: allowance};
}

// mm: the module manager. Its packs: the scenario's package name ->
// {scenario, scenarioName}. Seeded with what the runtime was started with
// (mm.startScenarios, every module given by --loadModule, by its package
// name), then kept by each load, unload and reload in place.
function packsOf(mm) {
  if (mm.packsInPlace == null) {
    mm.packsInPlace = new Map();
    for (const dir of (mm.startScenarios || [])) {
      const name = packageNameOf(dir);
      if (typeof(name) === 'string' && !mm.packsInPlace.has(name)) mm.packsInPlace.set(name, {scenario: dir, scenarioName: name});
    }
  }
  return mm.packsInPlace;
}

// The load list with `scenario` in place of `except`'s, against every other
// loaded pack's: {load, refused, owners, mine}. mine: the refusal of this
// scenario, if any.
function planWith(mm, except, scenario) {
  const others = [...packsOf(mm)].filter(([name]) => name !== except).map(([, p]) => p.scenario);
  const reserved = require('./mcp/tool-name').RESERVED_TOOL_NAMES;
  const plan = moduleRoles.expandLoadList(others.concat(scenario != null ? [scenario] : []), {reserved: reserved});
  const real = (scenario != null) ? realOf(scenario) : null;
  plan.mine = (real != null) ? plan.refused.find((r) => realOf(r.path) === real) || null : null;
  return plan;
}

function refusalOf(r) {
  if (r.code === 'PART_VERSION_CONFLICT') {
    return CountinghouseError.withFields('PART_VERSION_CONFLICT', {scenario: r.name, name: r.part, versions: r.versions.join(', ')});
  }
  if (r.code === 'PART_MISSING') return new CountinghouseError('PART_MISSING', `${r.name} calls ${r.part}, which is not installed beside it`);
  return new CountinghouseError(r.code, `${r.name}: its tool ${r.tool} is already ${r.with === 'a runtime built-in' ? 'a runtime built-in' : `the tool of ${r.with}`}`);
}

// The modules a scenario owns in a plan (its own name and its parts').
function ownedBy(plan, scenarioName) {
  const names = new Set();
  for (const [module, owners] of plan.owners) if (owners.has(scenarioName)) names.add(module);
  return names;
}

const loaded = (mm, name) => mm.modules[name] != null;

function loadOne(mm, entry) {
  return new Promise((resolve, reject) => {
    mm.loadModuleFromPath(entry.path, entry.name, entry.version, (err) => (err != null ? reject(err) : resolve()));
  });
}

function unloadOne(mm, name) {
  return new Promise((resolve) => mm.unloadModuleExternal(name, () => resolve()));
}

// A module at a new version (the reviewer's ruling A, drain then switch):
// while it is replaced, new calls to its device wait (lib/device-manager.js
// onInvokeDeviceAction). The old worker finishes the calls it was given, up
// to --requestTimeout; what it still owes then is answered MODULE_RELOADING
// when the reload ends it. Then the reload is the runtime's own (unload,
// then spawn): one worker and one file broker per module at a time. A new
// version that fails to load leaves the module unloaded, as any reload
// does.
function drainCalls(old) {
  const deadline = Date.now() + Number(options.requestTimeout);
  const owes = () => (old.msgQueue != null ? Object.keys(old.msgQueue).length : 0);
  return new Promise((resolve) => {
    const poll = () => {
      if (owes() > 0 && Date.now() < deadline && old.ended == null) return setTimeout(poll, DRAIN_POLL_MS).unref();
      if (owes() > 0) LOG.I(`module: ${old.hostModuleName}: its old version still owed ${owes()} answers at --requestTimeout; ended`);
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

async function replaceDrainThenSwitch(mm, entry) {
  const name = entry.name;
  const old = mm.modules[name];
  const WorkerMessage = require('./worker-message');
  if (!(old instanceof WorkerMessage)) {
    await unloadOne(mm, name);
    return loadOne(mm, entry);
  }
  if (!(mm.replacingInPlace instanceof Map)) mm.replacingInPlace = new Map();
  mm.replacingInPlace.set(name, true);
  try {
    await drainCalls(old);
    await new Promise((resolve, reject) => mm.loadModuleByWorker(entry.path, name, entry.version, (err) => (err != null ? reject(err) : resolve())));
    await waitRegistered(mm, name, old);
  } finally {
    mm.replacingInPlace.delete(name);
  }
}

// Each module of a plan the pack owns, loaded in turn; on a failure, the ones
// this request loaded are unloaded again, and the failure answers.
async function loadAll(mm, entries) {
  const done = [];
  try {
    for (const entry of entries) {
      await loadOne(mm, entry);
      done.push(entry.name);
    }
  } catch (err) {
    for (const name of done.reverse()) await unloadOne(mm, name);
    throw err;
  }
  return done;
}

function setRemotes(mm, names, allowance) {
  const packRemotes = require('./module-manager').packRemotes;
  for (const n of names) packRemotes.set(n, {allowance: allowance});
}

async function loadPack(mm, msg) {
  const req = readRequest(msg, {needsScenario: true});
  if (packsOf(mm).has(req.name)) throw refusal('CONTROL_FAILED', `${req.name} is loaded already; reload it`);
  const scenarioName = req.name;
  const plan = planWith(mm, req.name, req.scenario);
  if (plan.mine != null) throw refusalOf(plan.mine);
  const owned = ownedBy(plan, scenarioName);
  const entries = plan.load.filter((e) => owned.has(e.name) && !loaded(mm, e.name));
  setRemotes(mm, entries.map((e) => e.name), req.allowance);
  for (const e of entries) if (e.listed === false) mm.unlisted.add(e.name);
  try {
    await loadAll(mm, entries);
  } catch (err) {
    for (const e of entries) { require('./module-manager').packRemotes.delete(e.name); if (e.listed === false) mm.unlisted.delete(e.name); }
    throw err;
  }
  packsOf(mm).set(req.name, {scenario: req.scenario, scenarioName: scenarioName});
  return {modules: [...owned]};
}

async function unloadPack(mm, msg) {
  const req = readRequest(msg, {needsScenario: false});
  const pack = packsOf(mm).get(req.name);
  if (pack == null) throw refusal('CONTROL_FAILED', `${req.name} is not loaded`);
  const mine = ownedBy(planWith(mm, null, null), pack.scenarioName);
  const rest = planWith(mm, req.name, null);
  const kept = new Set(rest.owners.keys());
  packsOf(mm).delete(req.name);
  const gone = [...mine].filter((n) => !kept.has(n));
  for (const name of gone) {
    if (loaded(mm, name)) await unloadOne(mm, name);
    require('./module-manager').packRemotes.delete(name);
    mm.unlisted.delete(name);
  }
  return {modules: gone};
}

async function reloadPack(mm, msg) {
  const req = readRequest(msg, {needsScenario: true});
  const pack = packsOf(mm).get(req.name);
  if (pack == null) throw refusal('CONTROL_FAILED', `${req.name} is not loaded; load it`);
  const scenarioName = req.name;
  const before = ownedBy(planWith(mm, null, null), pack.scenarioName);
  const plan = planWith(mm, req.name, req.scenario);
  if (plan.mine != null) throw refusalOf(plan.mine);
  const owned = ownedBy(plan, scenarioName);
  const current = (name) => (mm.modules[name] != null ? mm.modules[name] : null);
  const changes = plan.load.filter((e) => owned.has(e.name));
  setRemotes(mm, changes.map((e) => e.name), req.allowance);
  for (const e of changes) {
    if (e.listed === false) mm.unlisted.add(e.name); else mm.unlisted.delete(e.name);
    const wm = current(e.name);
    if (wm == null) { await loadOne(mm, e); continue; }
    // the same name at the same version, from whichever tree, is that module
    // again (Task A1): it stays as it is
    const version = (wm.packageInfo != null) ? wm.packageInfo.version : null;
    const same = version === e.version || (wm.hostModulePath != null && realOf(wm.hostModulePath) === realOf(e.path));
    if (!same) await replaceDrainThenSwitch(mm, e);
  }
  const kept = new Set(plan.owners.keys());
  for (const name of before) {
    if (kept.has(name)) continue;
    if (loaded(mm, name)) await unloadOne(mm, name);
    require('./module-manager').packRemotes.delete(name);
    mm.unlisted.delete(name);
  }
  packsOf(mm).set(req.name, {scenario: req.scenario, scenarioName: scenarioName});
  return {modules: [...owned]};
}

module.exports = {loadPack, unloadPack, reloadPack, PACK_NAME};
