'use strict';
// Module settings at a call (the module-level configuration design,
// docs/superpowers/specs/2026-11-18-module-level-configuration-and-install-
// design.md, sections 4.5 and 4.6). Main thread only.
//
// - What a call carries: the settings state of the module it runs in
//   (lib/module-settings.js stateFor, kept on its worker or its per-session
//   record; module settings run only with worker threads), sent as
//   args.settings: {v} once the worker has that version's values, else
//   {v, values}. A worker keeps the last KEPT versions it was given
//   (lib/handler-ctx.js); the main thread keeps the same ring per worker, so
//   it never sends a version without values the worker has dropped.
// - SETTING_REQUIRED before the handler runs: a module whose declared
//   `required` setting is unset fails the call, unbilled, over the whole
//   declared call graph for a client's or a job's call (a top-level module
//   never swallows a part's missing setting), and the target alone for a hop.
// - ctx.settingRequired(name): the handler's claim, checked here against the
//   module's pinned declaration and the snapshot the call ran with: a
//   declared setting unset there is answered SETTING_REQUIRED in the
//   runtime's words; any other claim is a module fault
//   (DEVICE_INVOKE_EXCEPTION), so no module puts text in the runtime's voice.
const {CountinghouseError} = require('./countinghouse-error');
// a command for the user's terminal, through ch-local's launcher where it gave
// one (lib/held-back.js terminalCommand: ch-local is on no PATH)
const {terminalCommand} = require('./held-back');
const {declaredText} = require('./schema-safety');
const moduleSettings = require('./module-settings');
const options = require('./cli-options');
const LOG = require('./logger');

const toolGeneration = require('./tool-generation');
const callTokensLib = require('./require-once')(() => require('./call-tokens'));
const workerMessageLib = require('./require-once')(() => require('./worker-message'));
const {isRecord} = require('./session-module-record');

const {KEPT} = require('./settings-ring');
// The call graph walked for SETTING_REQUIRED: at most this many devices.
// A graph past it is never checked in part: the call is refused
// (graphTooLarge), fail closed. (Kept per tool-set generation: walked once.)
const MAX_REACH = 4096;

const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// a device's (or worker's) settings state: a worker's proxy or a
// per-session record keep their own. Single-thread mode holds none: a
// module that declares settings is refused there at its load (module
// settings run only with worker threads).
function stateOf(dm, device) {
  if (device == null) return null;
  // the main thread's own field (never a module's own device object, which
  // single-thread mode holds)
  if (device instanceof workerMessageLib() || isRecord(device)) return (device.settings !== undefined) ? device.settings : null;
  return null;
}

// What a call to `target` carries for `st`: {v} when the worker has that
// version's values (the ring this side keeps for it, in the order its
// messages were posted), else {v, values}. Nothing is noted here: sent()
// notes the version once the message carrying its values has been posted
// (a call refused or failed before then never counts).
function ringOf(target) {
  if (target.settingsRing == null) {
    Object.defineProperty(target, 'settingsRing', {value: {versions: new Array(KEPT).fill(null), at: 0}, writable: true, configurable: true});
  }
  return target.settingsRing;
}
function toCarry(target, st) {
  if (st == null || st.settings == null) return null;
  // declared, with no values: carried as no version, which a worker never
  // holds (lib/handler-ctx.js settingsHeld), so no handler runs on none
  if (st.values == null) return {v: null};
  if (target == null || typeof(target) !== 'object') return {v: st.version, values: st.values};
  if (ringOf(target).versions.includes(st.version)) return {v: st.version};
  return {v: st.version, values: st.values};
}
// `carried` (toCarry's answer) has been posted to `target`: its values,
// when it held them, are the worker's now (lib/handler-ctx.js holdSettings
// keeps them as the message arrives, in the order posted).
function sent(target, carried) {
  if (target == null || typeof(target) !== 'object' || carried == null || carried.values == null || !Number.isFinite(carried.v)) return;
  const ring = ringOf(target);
  if (ring.versions.includes(carried.v)) return;
  ring.versions[ring.at] = carried.v;
  ring.at = (ring.at + 1) % KEPT;
}

// A task's settings: the state its first pass was sent with, kept for its
// life (an answer to ctx.ask is never run under other settings than it was
// asked under), while its module keeps the same declaration. A pass that
// was refused pins nothing (pin is called once one is sent). Bounded: a pin
// goes after a day, or as the oldest past MAX_TASK_PINS; a task whose pin
// went runs with the current values.
const MAX_TASK_PINS = 4096;
const PIN_MS = 24 * 3600 * 1000;
const taskPins = new Map();   // jobID -> {state, key, at}
const declarationKey = (st) => {
  if (st == null || st.settings == null) return null;
  if (st.declarationKey === undefined) Object.defineProperty(st, 'declarationKey', {value: JSON.stringify(st.settings), configurable: true});
  return st.declarationKey;
};
function forTask(jobID, current) {
  if (jobID == null || current == null || current.settings == null) return current;
  const p = taskPins.get(String(jobID));
  if (p == null) return current;
  if (Date.now() - p.at > PIN_MS || p.key !== declarationKey(current)) { taskPins.delete(String(jobID)); return current; }
  return p.state;
}
function pin(jobID, st) {
  if (jobID == null || st == null || st.settings == null || taskPins.has(String(jobID))) return;
  taskPins.set(String(jobID), {state: st, key: declarationKey(st), at: Date.now()});
  if (taskPins.size > MAX_TASK_PINS) taskPins.delete(taskPins.keys().next().value);
}

// whether module `name` declares settings, by its pinned package.json
// (lib/device-manager.js packageOfModule, {live}: a stale pin never
// declares). Asked each time, never kept: it runs only for a device with no
// state, and an answer kept across a pin, a spawn's start or a failed spawn
// could fail open (round 7: three keys tried, none tracks all of them).
// `onThrow`: the answer when the package.json cannot be read. The gate's
// refusal takes it as declaring (not ready: fail closed, said in the log);
// the check of a module's own claim takes it as not (a claim is accepted
// only on what is known: never the runtime's voice on a guess).
function declares(dm, name, {onThrow = true} = {}) {
  if (name == null || dm == null || typeof(dm.packageOfModule) !== 'function') return false;
  try { return moduleSettings.declaresSettings(dm.packageOfModule(name, {live: true})); } catch (e) {
    if (onThrow) {
      try { LOG.I(`module settings: ${declaredText(String(name))}: its package.json could not be read (${e && e.code ? e.code : 'error'}); its calls are refused as not ready`); } catch (err) { /* not serving */ }
    }
    return onThrow;
  }
}
const moduleNameOf = (device) => {
  if (device == null) return null;
  if (typeof(device.hostModuleName) === 'string') return device.hostModuleName;
  return typeof(device.moduleName) === 'string' ? device.moduleName : null;
};

// The SETTING_REQUIRED answer, in the runtime's words. `module`: the module
// whose settings are unset; `names`: those settings; `top`: the top-level
// module the call was to (a part's settings are never named to a client: the
// hint names the top-level module, and missingSettings is left out).
function requiredError(st, module, names, top) {
  const part = top != null && top !== module;
  const shownModule = declaredText(String(top != null ? top : module));
  let settings;
  let hint;
  if (part) {
    settings = 'a module this tool calls needs a setting made at the terminal';
    hint = (options.singleIdentity === true)
      ? `Run \`${terminalCommand(`settings modules ${shownModule}`)}\` at a terminal.`
      : 'Its operator sets it in --moduleSettings.';
  } else {
    settings = names.map((n) => {
      const d = (st != null && st.settings != null) ? st.settings[n] : null;
      // (the author's title as every other place shows it: module-settings ownWords)
      const title = moduleSettings.ownWords(d).title;
      return title != null ? `${n} (${title})` : n;
    }).join(', ');
    hint = (options.singleIdentity === true)
      // (a setting's value is the user's to give, in their own terminal: a
      // text value is never set in conversation, so the hint offers none; the
      // command carries no value, ch-local asks for it, so it stays out of the
      // conversation and the shell's history)
      ? `Ask the user to run \`${terminalCommand(`settings set ${shownModule}.${names[0]}`)}\` in their own terminal; it asks for the value. Do not guess it.`
      : 'Its operator sets it in --moduleSettings.';
  }
  return CountinghouseError.withFields('SETTING_REQUIRED', {module: shownModule, settings, hint, missingSettings: part ? null : names.slice()});
}

// A device's declared targets: its verified bindings. Only for finding which
// module's setting is unset: what a module may call is decided elsewhere.
function targetsOf(device, deviceID) {
  return callTokensLib().declaredTargetsOf(callTokensLib().bindingOf(device, deviceID));
}

// The devices reached from `deviceID` over their verified declared calls,
// breadth first, `deviceID` first: {ids, truncated}, at most MAX_REACH
// (truncated: there were more). Kept per device and tool-set generation
// (lib/tool-generation.js: a load, an unload, a restart or a verdict
// changes it), so an outer call does not walk again until the graph may
// have changed.
const reachCache = new Map();   // deviceID -> {generation, reach}
function reachOf(dm, deviceID) {
  const generation = toolGeneration.current();
  const kept = reachCache.get(deviceID);
  if (kept != null && kept.generation === generation && kept.dm === dm) return kept.reach;
  const map = (dm != null && dm.deviceMap != null) ? dm.deviceMap : {};
  const seen = new Set([deviceID]);
  const ids = [deviceID];
  let truncated = false;
  for (let i = 0; i < ids.length; i++) {
    for (const t of targetsOf(map[ids[i]], ids[i])) {
      if (seen.has(t.deviceID)) continue;
      if (seen.size >= MAX_REACH) { truncated = true; continue; }
      seen.add(t.deviceID);
      ids.push(t.deviceID);
    }
  }
  const reach = {ids, truncated};
  reachCache.set(deviceID, {generation, dm, reach});
  if (reachCache.size > 4096) reachCache.delete(reachCache.keys().next().value);
  return reach;
}

// The devices to check for a call to `deviceID`: its reach (`graph`), or
// itself; visit(deviceID, device) for each, the first non-null answer
// returned.
function walk(dm, deviceID, visit, follow = true) {
  const map = (dm != null && dm.deviceMap != null) ? dm.deviceMap : {};
  const ids = follow ? reachOf(dm, deviceID).ids : [deviceID];
  for (const id of ids) {
    const found = visit(id, map[id]);
    if (found != null) return found;
  }
  return null;
}

// The first module reached from `deviceID` (itself, then, when `graph`, the
// modules its verified declared calls reach) with a required setting unset,
// or null; the target's state as the call carries it (`own0`, a task's pin)
// when given. -> {module, names, state} | null
function firstUnset(dm, deviceID, graph, own0 = undefined) {
  return walk(dm, deviceID, (id, device) => {
    const st = (id === deviceID && own0 !== undefined) ? own0 : stateOf(dm, device);
    // a module that declares settings, loaded and serving here (its device
    // registered) with no state: never run with no settings and no required
    // check (fail closed). One not serving (suspended, restarting, spawning:
    // not in the map) is left to its hop's own answer (MODULE_SUSPENDED,
    // MODULE_RESTARTING), so an action that never calls it is not refused.
    if (st == null && device != null && declares(dm, moduleNameOf(device))) return {notReady: true, module: moduleNameOf(device)};
    // a state that declares settings with no values (a dry run's shape):
    // not ready either, never run with none
    if (st != null && st.settings != null && st.values == null) return {notReady: true, module: moduleNameOf(device)};
    if (st != null && st.settings != null) {
      const unset = moduleSettings.unsetRequired(st.settings, st.values);
      if (unset.length > 0) return {module: moduleNameOf(device), names: unset, state: st};
    }
    return null;
  }, graph);
}

// A call whose declared graph reaches more than MAX_REACH devices: its
// settings cannot all be checked, so it is refused, never checked in part.
function graphTooLarge(dm, deviceID) {
  const name = moduleNameOf((dm != null && dm.deviceMap != null) ? dm.deviceMap[deviceID] : null);
  return new CountinghouseError('MODULE_COMPOSITION_INVALID', declaredText(String(name)),
    `its declared calls reach more than ${MAX_REACH} modules, so their settings cannot all be checked; the call was refused`);
}

// A claim, as ctx.settingRequired makes one in a worker: code
// SETTING_REQUIRED, the setting's name as its message. What a hop's or a
// peer match's refusal is sent to the calling module as, so a module that
// passes it on is answered in the outer call's words (claimAnswer), and a
// part's setting is never named in a sentence a client could be shown.
function claimOf(name) {
  const e = new CountinghouseError('SETTING_REQUIRED');
  e.message = String(name);
  return e;
}
// a not-ready's module when none can be named: the tool
const THIS_TOOL = 'this tool';

// A hop's not-ready, for its calling module: SETTING_NOT_READY naming no
// module (a part is never named to a client), answered in the outer call's
// words when passed on (claimAnswer).
function notReadyClaim() {
  const e = new CountinghouseError('SETTING_NOT_READY');
  e.message = 'not ready';
  return e;
}


// SETTING_REQUIRED for a call to `deviceID`, or null. `graph` (a client's or
// a job's call): over the whole declared call graph, in the runtime's
// words. A hop's or a peer match's (the target alone): the claim of the
// first setting unset, for the calling module.
function requiredRefusal(dm, deviceID, graph, st = undefined) {
  if (graph && reachOf(dm, deviceID).truncated) return graphTooLarge(dm, deviceID);
  const found = firstUnset(dm, deviceID, graph, st);
  if (found == null) return null;
  // a client's call (graph) names its top-level module, never a part; a
  // hop's goes to its calling module as a claim naming none (claimAnswer
  // answers it in the outer call's words, if the module passes it on)
  if (found.notReady === true) {
    if (!graph) return notReadyClaim();
    const named = moduleNameOf((dm != null && dm.deviceMap != null) ? dm.deviceMap[deviceID] : null) || found.module;
    return CountinghouseError.withFields('SETTING_NOT_READY', {module: declaredText(String(named))});
  }
  if (!graph) return claimOf(found.names[0]);
  const top = moduleNameOf((dm != null && dm.deviceMap != null) ? dm.deviceMap[deviceID] : null);
  return requiredError(found.state, found.module, found.names, top);
}

// A SETTING_REQUIRED claim a call answered with (ctx.settingRequired, or a
// hop's refusal its module passed on: the setting's name as the message),
// checked against the target's pinned declaration and the snapshot `st` the
// call ran with, then over the modules its verified declared calls reach (a
// part's claim its caller passed on). A SETTING_REQUIRED already in the
// runtime's words (its fields this thread filled in) passes as it is.
// `outer` (a client's or a job's call): answered in the runtime's words; a
// hop's goes back to its caller as the claim it was. A claim that is not a
// declared setting unset is a module fault.
function claimAnswer(err, dm, deviceID, st, outer) {
  if (err != null && err.code === 'SETTING_NOT_READY') return notReadyAnswer(err, dm, deviceID, outer);
  if (err == null || err.code !== 'SETTING_REQUIRED') return err;
  if (err.fields != null && own(err.fields, 'hint')) return err;
  const name = String(err.message);
  const map = (dm != null && dm.deviceMap != null) ? dm.deviceMap : {};
  const top = moduleNameOf(map[deviceID]);
  const unsetIn = (state) => state != null && state.settings != null && own(state.settings, name) && (state.values == null || !own(state.values, name));
  const found = walk(dm, deviceID, (id, device) => {
    const state = (id === deviceID && st !== undefined) ? st : stateOf(dm, device);
    return unsetIn(state) ? {state, module: (id === deviceID) ? top : moduleNameOf(device)} : null;
  });
  if (found == null) return new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a module claimed a setting it does not need (ctx.settingRequired)');
  return outer ? requiredError(found.state, found.module, [name], top) : err;
}

// A SETTING_NOT_READY a call answered with: in the runtime's words already
// (its fields this thread filled in), as it is; a hop's claim passed on, in
// the outer call's words naming its own top-level module (never the part),
// or passed on to the caller as it is from a hop. A module whose graph
// has no module behind it serving with no state now cannot have met one:
// a module fault.
function notReadyAnswer(err, dm, deviceID, outer) {
  if (err.fields != null && own(err.fields, 'module')) return err;
  const map = (dm != null && dm.deviceMap != null) ? dm.deviceMap : {};
  // accepted only when a reached module is serving right now with no state
  // (the very condition the gate refuses on); a module that merely declares
  // settings is no reason: a claim then is a module's fault
  const declaring = walk(dm, deviceID, (id, device) => {
    if (id === deviceID || device == null) return null;
    const st = stateOf(dm, device);
    if (st == null) return declares(dm, moduleNameOf(device), {onThrow: false}) ? true : null;
    return (st.settings != null && st.values == null) ? true : null;
  });
  if (declaring == null) return new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a module answered SETTING_NOT_READY with no module that declares settings behind it');
  if (!outer) return err;
  // the outer call's top-level module, by its device or the device
  // manager's one lookup (it may have left the map meanwhile); none known:
  // the catalogue's text all the same, naming "this tool" (never the hop's own message, never an internal ID)
  const named = moduleNameOf(map[deviceID]) || ((dm != null && typeof(dm.moduleOfDevice) === 'function') ? dm.moduleOfDevice(deviceID) : null);
  return CountinghouseError.withFields('SETTING_NOT_READY', {module: named != null ? declaredText(String(named)) : THIS_TOOL});
}

module.exports = {stateOf, toCarry, sent, forTask, pin, requiredRefusal, claimAnswer, requiredError, claimOf, notReadyClaim, KEPT, MAX_REACH};
