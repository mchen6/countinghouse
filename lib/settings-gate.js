'use strict';
// Module settings at a call (the module-level configuration design,
// docs/superpowers/specs/2026-11-18-module-level-configuration-and-install-
// design.md, sections 4.5 and 4.6). Main thread only.
//
// - What a call carries: the settings state of the module it runs in
//   (lib/module-settings.js stateFor, kept on its worker, its per-session
//   record, or, in single-thread mode, by its module manager), sent as
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
const {declaredText} = require('./schema-safety');
const moduleSettings = require('./module-settings');
const options = require('./cli-options');

const callTokensLib = require('./require-once')(() => require('./call-tokens'));
const workerMessageLib = require('./require-once')(() => require('./worker-message'));
const {isRecord} = require('./session-module-record');

const KEPT = 4;
// the call graph walked for SETTING_REQUIRED: at most this many devices
const MAX_REACH = 64;

const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// a device's (or worker's) settings state: a worker's proxy or a
// per-session record keep their own; single-thread mode's, its manager's
function stateOf(dm, device) {
  if (device == null) return null;
  // a worker's proxy or a per-session record: the main thread's own field
  // (never a module's own device object, which single-thread mode holds)
  if (device instanceof workerMessageLib() || isRecord(device)) return (device.settings !== undefined) ? device.settings : null;
  const mm = (dm != null) ? dm.moduleManager : null;
  const name = (typeof(device.moduleName) === 'string') ? device.moduleName : null;
  return (mm != null && mm.singleThreadSettings != null && name != null) ? (mm.singleThreadSettings.get(name) || null) : null;
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
  if (st == null || st.settings == null || st.values == null) return null;
  if (target == null || typeof(target) !== 'object') return {values: st.values};
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
      ? `Run \`ch-local settings modules ${shownModule}\` at a terminal.`
      : 'Its operator sets it in --moduleSettings.';
  } else {
    settings = names.map((n) => {
      const d = (st != null && st.settings != null) ? st.settings[n] : null;
      return (d != null && typeof(d.title) === 'string') ? `${n} (${declaredText(d.title)})` : n;
    }).join(', ');
    hint = (options.singleIdentity === true)
      ? `Ask the user for the value (do not guess), then set it, or run \`ch-local settings set ${shownModule}.${names[0]}\`.`
      : 'Its operator sets it in --moduleSettings.';
  }
  return CountinghouseError.withFields('SETTING_REQUIRED', {module: shownModule, settings, hint, missingSettings: part ? null : names.slice()});
}

// The modules reached from `deviceID` over their verified declared calls,
// breadth first, at most MAX_REACH devices: visit(deviceID, device) for
// each, `deviceID` first; one that answers non-null ends the walk with it.
// follow false: `deviceID` alone.
function walk(dm, deviceID, visit, follow = true) {
  const map = (dm != null && dm.deviceMap != null) ? dm.deviceMap : {};
  const seen = new Set([deviceID]);
  const queue = [deviceID];
  while (queue.length > 0) {
    const id = queue.shift();
    const found = visit(id, map[id]);
    if (found != null) return found;
    if (!follow) break;
    for (const t of callTokensLib().declaredTargetsOf(callTokensLib().bindingOf(map[id], id))) {
      if (seen.has(t.deviceID) || seen.size >= MAX_REACH) continue;
      seen.add(t.deviceID);
      queue.push(t.deviceID);
    }
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
    if (st != null && st.settings != null) {
      const unset = moduleSettings.unsetRequired(st.settings, st.values);
      if (unset.length > 0) return {module: moduleNameOf(device), names: unset, state: st};
    }
    return null;
  }, graph);
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

// SETTING_REQUIRED for a call to `deviceID`, or null. `graph` (a client's or
// a job's call): over the whole declared call graph, in the runtime's
// words. A hop's or a peer match's (the target alone): the claim of the
// first setting unset, for the calling module.
function requiredRefusal(dm, deviceID, graph, st = undefined) {
  const found = firstUnset(dm, deviceID, graph, st);
  if (found == null) return null;
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

module.exports = {stateOf, toCarry, sent, forTask, pin, requiredRefusal, claimAnswer, requiredError, claimOf, KEPT};
