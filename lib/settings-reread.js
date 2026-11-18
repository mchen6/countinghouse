'use strict';
// reread {what: 'module-settings'} on the control channel (the module-level
// configuration design, sections 4.3 and 7.3; M2a): ch-local has written a
// module.* value of --settingsFile, and the runtime reads them again.
//
// The file is read once. Each loaded module that declares settings gets its
// state again (lib/module-settings.js stateFor), from what the state it runs
// with was made from (its pinned package.json and granted net: the state's
// own, so a reload whose worker failed leaves the old worker's), under the
// operator's ceiling as it is now:
// - Atomic per module. Any value of a module that this reread refuses (or a
//   fixed value its declaration rejects, a ceiling that cannot be trusted,
//   values over 32 KiB) keeps ALL of that module's old values; the other
//   modules still apply. Each refusal is a notice to the module's sessions
//   and, for a value, a "not applied" history line beside the settings file;
//   never the value.
// - A value that already was not applied in the state the module runs with,
//   and is the same value, is no refusal: it holds nothing new back, and
//   would otherwise hold back every later change until a restart. Neither is
//   a stored name this version does not declare (the settings tool keeps
//   unknown names in the file). The log says both, as at a load.
// - Applied: the new state, with a new version, on the module's worker's
//   proxy, its per-session record and every session's worker, the copy a
//   supervised restart reads and single-thread mode's. The next call sends
//   the new values (lib/settings-gate.js); a call already sent keeps the
//   values it was sent with, and a task keeps its pin.
// - A module whose values are the same keeps its state (no new version).
// - Never an unload: a required setting newly unset stays loaded, and its
//   calls answer SETTING_REQUIRED.
// -> {applied: <modules whose values changed>, refused: [{name, code}]},
// name "module.<package>.<setting>", or "module.<package>" when the refusal
// is not one value's. A request for anything else, a runtime with no
// --settingsFile, or a file that cannot be read, is refused whole
// (CONTROL_FAILED) with nothing changed.
const path = require('path');
const options = require('./cli-options');
const moduleSettings = require('./module-settings');
const notices = require('./notices');
const LOG = require('./logger');
const WorkerMessage = require('./worker-message');
const {isRecord} = require('./session-module-record');
const settingsTool = require('./settings-tool');

const failed = (why) => Object.assign(new Error(why), {code: 'CONTROL_FAILED'});

// the values as one text, by name: whether two states run alike
const valuesText = (values) => (values == null ? 'null' : JSON.stringify(Object.keys(values).sort().map((k) => [k, values[k]])));

// The ceiling binds where the settings tool is served (the single-identity
// profile with a settings file: lib/cli-options.js settingsTool), as it binds
// a load there; elsewhere none does.
const ceilingNow = () => (options.settingsTool === true ? settingsTool.controlCeilingNow() : null);

// each loaded module's state now: name -> state (one that declares settings
// and was made by stateFor), from its worker's proxy or per-session record,
// or single-thread mode's copy
function loaded(mm) {
  const out = new Map();
  for (const name of Object.keys(mm.modules || {})) {
    const m = mm.modules[name];
    if (m == null || !(isRecord(m) || m instanceof WorkerMessage)) continue;
    const st = m.settings;
    if (st != null && st.made != null) out.set(name, st);
  }
  if (mm.singleThreadSettings != null) {
    for (const [name, st] of mm.singleThreadSettings) if (st != null && st.made != null && !out.has(name)) out.set(name, st);
  }
  return out;
}

// the new state, everywhere the module's calls read it
function put(mm, name, st) {
  if (mm.singleThreadSettings != null && mm.singleThreadSettings.has(name)) mm.singleThreadSettings.set(name, st);
  if (mm.lastSettings != null && mm.lastSettings.has(name)) mm.lastSettings.set(name, st);
  const m = (mm.modules != null && Object.prototype.hasOwnProperty.call(mm.modules, name)) ? mm.modules[name] : null;
  if (m != null && (isRecord(m) || m instanceof WorkerMessage)) m.settings = st;
  if (mm.sessionWorkers != null && typeof(mm.sessionWorkers.all) === 'function') {
    for (const w of mm.sessionWorkers.all()) if (w != null && w.name === name && w.wm instanceof WorkerMessage) w.wm.settings = st;
  }
}

// a "not applied" history line, as a load writes one (by the runtime; the
// value kept as stored, or cut with its SHA-256)
function historyLine(setting, change, stored) {
  const file = path.join(path.dirname(options.settingsFile), 'history.jsonl');
  const kept = (stored !== undefined) ? moduleSettings.keptOf(stored) : {};
  try {
    settingsTool.appendHistoryLine(file, Object.assign({by: 'runtime', setting, change}, kept));
  } catch (err) { LOG.I(`module settings: the history line for ${setting} could not be written (${err.code || err.message})`); }
}

// mm: the module manager; msg: the request. ceiling, log: a test's.
async function reread(mm, msg, {ceiling = ceilingNow, log = (line) => LOG.I(line)} = {}) {
  if (msg == null || msg.what !== 'module-settings') throw failed('reread names what it reads: module-settings');
  if (options.settingsFile == null) {
    throw failed(options.moduleSettings != null
      ? 'reread reads --settingsFile only; --moduleSettings is the operator\'s file, read at each load'
      : 'this runtime has no --settingsFile to read');
  }
  let raw;
  try { raw = settingsTool.readFile(options.settingsFile).raw; } catch (e) {
    throw failed(`the settings file cannot be read: ${String(e.message).slice(0, 200)}`);
  }
  // the ceiling as it is now; one that cannot be read binds as one that
  // cannot be trusted
  let c = null;
  try { c = ceiling(); } catch (e) { c = {state: 'untrusted', file: null, problem: `it cannot be read (${e && e.code ? e.code : 'error'})`}; }
  const reply = {applied: 0, refused: []};
  for (const [name, old] of loaded(mm)) {
    const st = moduleSettings.stateFor(name, old.made.pkg, {net: old.made.net, operator: true, log, ceiling: c, raw, history: false});
    const stored = (key) => raw[`module.${name}.${key}`];
    if (st.refused != null) {
      const by = st.refusedBy || {code: 'SETTING_NOT_APPLIED', setting: null};
      const setting = by.setting != null ? `module.${name}.${by.setting}` : `module.${name}`;
      reply.refused.push({name: setting, code: by.code});
      notices.add(name, `${name}'s settings not applied: ${String(st.refusedWhy).slice(0, 200)}; it keeps the settings it had`);
      if (by.setting != null) historyLine(setting, `not applied: ${String(st.refusedWhy).slice(0, 200)}`, stored(by.setting));
      log(`module settings: ${name}: reread not applied (${by.code}); it keeps the settings it had`);
      continue;
    }
    // what was not applied before, as the same value: no refusal now
    const before = new Set((old.notApplied || []).map((n) => `${n.setting}\0${n.digest}`));
    const refusals = st.notApplied.filter((n) => n.code !== 'SETTING_UNKNOWN' && !before.has(`${n.setting}\0${n.digest}`));
    if (refusals.length > 0) {
      for (const n of refusals) {
        const setting = `module.${name}.${n.setting}`;
        reply.refused.push({name: setting, code: n.code});
        notices.add(name, `${name}'s setting ${n.setting} not applied: ${n.reason}; it keeps the settings it had`);
        historyLine(setting, `not applied: ${n.reason}`, stored(n.setting));
      }
      log(`module settings: ${name}: reread not applied (${refusals.length} value${refusals.length > 1 ? 's' : ''} refused); it keeps the settings it had`);
      continue;
    }
    if (valuesText(old.values) === valuesText(st.values)) continue;
    put(mm, name, st);
    reply.applied += 1;
    log(`module settings: ${name}: reread applied (version ${st.version})`);
  }
  return reply;
}

module.exports = {reread, ceilingNow};
