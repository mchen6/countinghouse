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

const KEPT = 4;
// the call graph walked for SETTING_REQUIRED: at most this many devices
const MAX_REACH = 64;

const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// a device's (or worker's) settings state: a worker's proxy or a
// per-session record keep their own; single-thread mode's, its manager's
function stateOf(dm, device) {
  if (device == null) return null;
  if (device.settings !== undefined) return device.settings;
  const mm = (dm != null) ? dm.moduleManager : null;
  const name = (typeof(device.moduleName) === 'string') ? device.moduleName : null;
  return (mm != null && mm.singleThreadSettings != null && name != null) ? (mm.singleThreadSettings.get(name) || null) : null;
}

// What a call to `target` carries for `st`: {v} when the worker has that
// version's values (the ring this side keeps for it, in the order it was
// sent them), else {v, values}, the version then noted as sent.
function carried(target, st) {
  if (st == null || st.settings == null || st.values == null) return null;
  if (target == null || typeof(target) !== 'object') return {values: st.values};
  if (target.settingsRing == null) {
    Object.defineProperty(target, 'settingsRing', {value: {versions: new Array(KEPT).fill(null), at: 0}, writable: true, configurable: true});
  }
  const ring = target.settingsRing;
  if (ring.versions.includes(st.version)) return {v: st.version};
  ring.versions[ring.at] = st.version;
  ring.at = (ring.at + 1) % KEPT;
  return {v: st.version, values: st.values};
}

// A task's settings: the state its first pass ran with, kept for its life
// (an answer to ctx.ask is never run under other settings than it was asked
// under), while its module keeps the same declaration. Bounded: the oldest
// pin goes first; a task whose pin went runs with the current values.
const MAX_TASK_PINS = 4096;
const taskPins = new Map();
function forTask(jobID, current) {
  if (jobID == null || current == null || current.settings == null) return current;
  const key = String(jobID);
  const pinned = taskPins.get(key);
  if (pinned != null && JSON.stringify(pinned.settings) === JSON.stringify(current.settings)) return pinned;
  taskPins.delete(key);
  taskPins.set(key, current);
  if (taskPins.size > MAX_TASK_PINS) taskPins.delete(taskPins.keys().next().value);
  return current;
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

// The first module reached from `deviceID` (itself, then over its verified
// declared calls when `graph`) with a required setting unset, or null.
// -> {module, names, state} | null
function firstUnset(dm, deviceID, graph, own0 = undefined) {
  const callTokens = require('./call-tokens');
  const map = (dm != null && dm.deviceMap != null) ? dm.deviceMap : {};
  const seen = new Set([deviceID]);
  const queue = [deviceID];
  while (queue.length > 0 && seen.size <= MAX_REACH) {
    const id = queue.shift();
    const device = map[id];
    // the target's own as the call carries it (a task's pin), when given
    const st = (id === deviceID && own0 !== undefined) ? own0 : stateOf(dm, device);
    if (st != null && st.settings != null) {
      const unset = moduleSettings.unsetRequired(st.settings, st.values);
      if (unset.length > 0) return {module: moduleNameOf(device), names: unset, state: st};
    }
    if (!graph || device == null) continue;
    for (const t of callTokens.declaredTargetsOf(callTokens.bindingOf(device, id))) {
      if (!seen.has(t.deviceID)) { seen.add(t.deviceID); queue.push(t.deviceID); }
    }
  }
  return null;
}

// SETTING_REQUIRED for a call to `deviceID`, or null: the whole declared call
// graph (`graph`: a client's or a job's call), or the target alone (a hop).
function requiredRefusal(dm, deviceID, graph, st = undefined) {
  const found = firstUnset(dm, deviceID, graph, st);
  if (found == null) return null;
  const top = moduleNameOf((dm != null && dm.deviceMap != null) ? dm.deviceMap[deviceID] : null);
  return requiredError(found.state, found.module, found.names, top);
}

// A handler's ctx.settingRequired(name), as its reply carried it (code
// SETTING_REQUIRED, the setting's name as the message): checked against the
// module's pinned declaration and the snapshot `st` the call ran with, then
// over the call graph (a part's claim a top-level module passed on). A
// SETTING_REQUIRED already in the runtime's words (fields) passes as it is.
// `outer`: the client's or job's call, which is answered in the runtime's
// words; a hop's claim goes back to its caller as the claim it was.
function claimAnswer(err, dm, deviceID, st, outer) {
  if (err == null || err.code !== 'SETTING_REQUIRED') return err;
  if (err.fields != null && own(err.fields, 'hint')) return err;
  const name = String(err.message);
  const map = (dm != null && dm.deviceMap != null) ? dm.deviceMap : {};
  const top = moduleNameOf(map[deviceID]);
  const unsetIn = (state) => state != null && state.settings != null && own(state.settings, name) && (state.values == null || !own(state.values, name));
  if (unsetIn(st)) return outer ? requiredError(st, top, [name], top) : err;
  // a claim a module passed on from one it calls: a module reached by its
  // verified declared calls whose setting it is, unset
  const callTokens = require('./call-tokens');
  const seen = new Set([deviceID]);
  const queue = [deviceID];
  while (queue.length > 0 && seen.size <= MAX_REACH) {
    const id = queue.shift();
    for (const t of callTokens.declaredTargetsOf(callTokens.bindingOf(map[id], id))) {
      if (seen.has(t.deviceID)) continue;
      seen.add(t.deviceID);
      const state = stateOf(dm, map[t.deviceID]);
      if (unsetIn(state)) return outer ? requiredError(state, moduleNameOf(map[t.deviceID]), [name], top) : err;
      queue.push(t.deviceID);
    }
  }
  return new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a module claimed a setting it does not need (ctx.settingRequired)');
}

module.exports = {stateOf, carried, forTask, requiredRefusal, claimAnswer, requiredError, KEPT};
