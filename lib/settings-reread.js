'use strict';
// A module's settings state by one rule, and reread {what: 'module-settings'}
// on the control channel (the module-level configuration design, sections
// 4.3, 7.3 and 8; M2a).
//
// next(name, made, {previous, ...}) makes the state a module runs with, from
// the stored values, the operator's ceiling as it is now, and the state it
// ran with before (previous). Every state comes from it: a load (no
// previous); a supervised restart (the state it ran with); a module as it
// registers (the state its spawn made: a reread while it came up, which
// finds no proxy yet, is not missed; lib/module-manager.js settleSettings);
// and reread (each loaded module's running state). The operator's ceiling
// changing while modules run rereads too (lib/route-manager.js, on
// lib/settings-tool.js onCeilingChange), so a fixed value binds without
// ch-local.
// - No previous (a load): lib/module-settings.js stateFor's state, or its
//   refusal (the load is refused).
// - A refusal of the whole module (the ceiling's fixed value rejected or not
//   declared, a ceiling that cannot be trusted, a source that cannot be
//   read, values over 32 KiB): the previous state, kept whole, the refusal
//   said once while it stays the same. A refusal BY THE CEILING refuses
//   where `ceilingRefuses` (a supervised restart: the operator's fixed value
//   is never run around); a running module, and one registering (its worker
//   is up), keeps running on its previous values (never an unload). A
//   previous state made from other inputs (a restart's: the net granted
//   now) is checked against them first (lib/module-settings.js restate).
// - Atomic per module (the reviewer's ruling): a value newly refused keeps
//   ALL of the previous values. Not a refusal (ruling (a)): a stored name
//   this version does not declare (the settings tool keeps unknown names in
//   the file); a value that was already not applied, the same value (by
//   SHA-256). A refused value is recorded as not applied in the state kept,
//   so it is said once and blocks no later change; the setting then keeps
//   the value it ran with, never its default. What was not applied is made
//   again every time, so a bad value removed and written back is new again.
// - A refusal is a notice (one per module) to every session, while its
//   top-level module is listed (a part's is said as "a part of <top>", never
//   named; the ceiling's file problem goes to the log only) and, for a
//   value, a "not applied" history line: the user's value's, or the
//   ceiling's when its fixed value is what refused.
// - Never silent: a change of the running values is said, a history line
//   (by the runtime, for module.<package>) and a notice naming what changed
//   and what is still not applied; never a value.
// - Applied: the new state, with a new version, on the module's worker's
//   proxy, its per-session record and every session's worker, and the copy a
//   supervised restart reads (module settings run only with worker
//   threads: single-thread mode holds none). The next call sends
//   the new values (lib/settings-gate.js); a call already sent keeps the
//   values it was sent with, and a task keeps its pin.
// - The same values and what was not applied: the previous state itself
//   (no new version, nothing put).
// - Never an unload: a required setting newly unset stays loaded, and its
//   calls answer SETTING_REQUIRED.
// reread -> {applied: <modules whose values changed>, refused: [{name,
// code}]}, name "module.<package>.<setting>", or "module.<package>" when
// the refusal is not one value's; never a value. A request of another shape
// (lib/modules-in-place.js moduleMessageProblem), a runtime with no
// --settingsFile, is refused whole (CONTROL_FAILED) with nothing changed. A
// settings file that cannot be read is refused too (CONTROL_FAILED), nothing
// of the file applied; the operator's ceiling's fixed values are applied
// all the same, and the refusal says how many modules they changed.
const options = require('./cli-options');
const moduleSettings = require('./module-settings');
const {CountinghouseError} = require('./countinghouse-error');
const LOG = require('./logger');
const WorkerMessage = require('./worker-message');
const {isRecord} = require('./session-module-record');
const settingsTool = require('./settings-tool');
const {callsOf} = require('./manifest-pins');
const callAddress = require('./call-address');
const controlChannel = require('./control-channel');

const failed = (why) => Object.assign(new Error(why), {code: 'CONTROL_FAILED'});
// the refusals the operator's ceiling made (a fixed value rejected or not
// declared): isCeilingRefusal(err)
const ceilingRefusals = new WeakSet();
const isCeilingRefusal = (err) => err != null && typeof(err) === 'object' && ceilingRefusals.has(err);
// A restart the ceiling's fixed value refuses (its declaration rejects or
// does not declare it), where the ceiling refuses: one wording, marked as
// the ceiling's, and said in the log. -> next()'s answer.
function ceilingRefusalOf(name, refusedBy, refused, log) {
  const why = 'the operator\'s ceiling fixes a value this version does not accept or declare';
  const refusal = moduleSettings.settingsRefusal(name, why);
  ceilingRefusals.add(refusal);
  log(`module settings: ${name}: ${why}; it is not started until the ceiling is updated`);
  return {state: null, refusal, refusedBy, refused, applied: false};
}

const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// the values as one text, by name: whether two states run alike
const {valuesText} = moduleSettings;
const keyOf = (n) => `${n.setting}\0${n.digest}`;
const notAppliedText = (list) => JSON.stringify((list || []).map(keyOf).sort());

// the settings whose values differ between two states' values, by name
function changedNames(a, b) {
  const valueOf = (vs, k) => JSON.stringify(own(vs, k) ? vs[k] : null);
  return [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter((k) => valueOf(a, k) !== valueOf(b, k)).sort();
}

// a copy of state `st` with fields replaced, carrying what it was made from
// and the whole module's refusal last said (`said`: undefined keeps st's,
// null drops it)
function copyOf(st, fields, said = undefined) {
  const out = Object.assign({}, st, fields);
  Object.defineProperty(out, 'made', {value: st.made});
  const s = (said !== undefined) ? said : st.said;
  if (s != null) Object.defineProperty(out, 'said', {value: s});
  return out;
}

// each loaded module's state now: name -> state (one that declares settings
// and was made by stateFor), from its worker's proxy or per-session record
// (a module coming up takes its state as it registers)
function loaded(mm) {
  const out = new Map();
  const take = (name, st) => { if (st != null && st.made != null && !out.has(name)) out.set(name, st); };
  for (const name of Object.keys(mm.modules || {})) {
    const m = mm.modules[name];
    if (m != null && (isRecord(m) || m instanceof WorkerMessage)) take(name, m.settings);
  }
  return out;
}

// the new state, everywhere the module's calls read it
function put(mm, name, st) {
  if (mm.lastSettings != null && mm.lastSettings.has(name)) mm.lastSettings.set(name, st);
  const m = (mm.modules != null && Object.prototype.hasOwnProperty.call(mm.modules, name)) ? mm.modules[name] : null;
  if (m != null && (isRecord(m) || m instanceof WorkerMessage)) m.settings = st;
  if (mm.sessionWorkers != null && typeof(mm.sessionWorkers.all) === 'function') {
    for (const w of mm.sessionWorkers.all()) if (w != null && w.name === name && w.wm instanceof WorkerMessage) w.wm.settings = st;
  }
}

// the module manager and device manager notices are told through
// (lib/route-manager.js configure; a test passes its own)
// (a function: the device manager as it is when asked)
let context = {dm: null};
function configure({dm = null} = {}) { context = {dm}; }
const dmNow = () => (typeof(context.dm) === 'function' ? context.dm() : context.dm);

// the module's package.json as pinned, or null
const pinnedOf = (mm, name) => (mm.manifestPins != null && typeof(mm.manifestPins.pinnedOf) === 'function') ? mm.manifestPins.pinnedOf(name) : null;
// the package a device is of (lib/device-manager.js moduleOfDevice: the
// module that registered it, else the one whose pinned api.json declares it)
function packageOfDevice(dm, id) {
  const pkg = (typeof(dm.moduleOfDevice) === 'function') ? dm.moduleOfDevice(id) : null;
  return (typeof(pkg) === 'string') ? pkg : null;
}
// the package a call address names: its <device> is the callee's
// friendlyName (lib/call-address.js parseAddress), and the package is the
// one of that device's ID. The device manager is required: it is
// configured in every profile (lib/route-manager.js); without one nothing is
// resolved (a friendlyName is never taken for a package: the walk is by
// package).
function calleeOf(call, dm) {
  const p = callAddress.parseAddress(call);
  if (p == null || dm == null) return null;
  // (a part still spawning too: the device manager knows its pinned IDs)
  return packageOfDevice(dm, callAddress.deviceIDForName(p.device));
}
// the friendlyNames a tool result of package `pkg` takes its notices by
// (lib/mcp/tool-registry.js target.module, lib/usage/receipt.js): the one
// its own api.json gives (read at its spawn, before its devices register:
// lib/module-manager.js pinnedFriendlyNames), else one per device of it
// registered; none known: the package name
function friendlyNamesOf(pkg, dm, mm = null) {
  const own = (mm != null && mm.pinnedFriendlyNames != null && Object.prototype.hasOwnProperty.call(mm.pinnedFriendlyNames, pkg)) ? mm.pinnedFriendlyNames[pkg] : null;
  if (typeof(own) === 'string' && own !== '') return [own];
  const names = new Set();
  if (dm != null && dm.deviceMap != null) {
    for (const id of Object.keys(dm.deviceMap)) {
      if (packageOfDevice(dm, id) !== pkg) continue;
      const d = dm.deviceMap[id];
      const name = (d != null && d.spec != null && d.spec.device != null) ? d.spec.device.friendlyName : null;
      if (typeof(name) === 'string' && name !== '') names.add(name);
    }
  }
  return names.size > 0 ? [...names] : [pkg];
}
function isPart(mm, name, st) {
  if (mm.unlisted != null && typeof(mm.unlisted.has) === 'function' && mm.unlisted.has(name)) return true;
  const pkg = (st != null && st.made != null) ? st.made.pkg : pinnedOf(mm, name);
  return pkg != null && pkg.countinghouse != null && pkg.countinghouse.role === 'part';
}
// what each loaded top-level module's declared calls reach, by package:
// top -> Set, made once per reread
function reachOf(mm, dm) {
  const reach = new Map();
  for (const top of Object.keys(mm.modules || {})) {
    if (isPart(mm, top, null)) continue;
    const seen = new Set();
    const queue = [top];
    while (queue.length > 0) {
      for (const call of callsOf(pinnedOf(mm, queue.shift()))) {
        const callee = calleeOf(call, dm);
        if (callee == null || callee === top || seen.has(callee)) continue;
        seen.add(callee);
        queue.push(callee);
      }
    }
    reach.set(top, seen);
  }
  return reach;
}

// One notice for module `name`, to every session while its top-level module
// is listed (#429's helper, lib/modules-in-place.js tellEverySession; a
// module going on or off is told to no one), keyed as a tool result of that module takes it
// (its friendlyName): said with its next result there. A module of several
// devices (several friendlyNames): with the session's next result, once. A part's goes to
// each top-level module that calls it, as "a part of <top>". (text(label,
// part) -> the notice.)
function tell(mm, dm, reach, name, st, text) {
  const part = isPart(mm, name, st);
  const tops = part ? [...reach.keys()].filter((top) => reach.get(top).has(name)) : [name];
  if (part && tops.length === 0) LOG.I(`module settings: ${name}: no loaded top-level module calls it now; this is said in this log only`);
  // every session lists what is loaded (M5a); in a shared runtime a module
  // going on or off is listed to no session, and told to none. Under --stdio
  // its one client is told as before (#438's high review, 1)
  const visibility = require('./module-visibility');
  const {tellEverySession} = require('./modules-in-place');
  const shared = require('./sessions').shared() === true;
  for (const top of tops) {
    if (shared && !visibility.listsModule(top)) continue;
    const names = friendlyNamesOf(top, dm, mm);
    tellEverySession(names.length === 1 ? names[0] : null, text(part ? `a part of ${top}` : top, part), {about: top});
  }
}

// a module's refusal as a client is told it: the runtime's words, never the
// ceiling's file problem (that is the log's)
function refusalText(by, why) {
  if (by.code === 'SETTING_CEILING_UNTRUSTED') return 'the operator\'s ceiling cannot be trusted';
  if (by.ceiling === true) return by.code === 'SETTING_UNKNOWN' ? 'the operator\'s ceiling fixes a setting this version does not declare' : 'the operator\'s ceiling fixes a value this version does not accept';
  return String(why).slice(0, 200);
}

// The state module `name` runs with, by the one rule (above). made: {pkg,
// net} (its pinned package.json and granted net). opts: previous (the state
// it ran with, or null), load (an operator's load: its history lines),
// quietState (stateFor's lines not said again: a registration), ceiling (as read; undefined: read now), raw (the
// settings file's values, read once; null: read here), ceilingRefuses (a
// ceiling's refusal refuses even with a previous state), mm, dm, reach (for
// the notices), log.
// -> {state, refusal, refused: [{name, code}], applied}: state null and
// refusal set when it may not run; state === previous when nothing changed;
// applied when the running values changed.
function next(name, made, opts = {}) {
  // the ceiling as given, else read now; one that cannot be read binds as
  // one that cannot be trusted (as reread takes it), never a throw out of a
  // registration or a load's callback
  let c = opts.ceiling;
  if (c === undefined) {
    try { c = settingsTool.moduleCeilingNow(); } catch (e) { c = {state: 'untrusted', file: null, problem: `it cannot be read (${e && e.code ? e.code : 'error'})`}; }
  }
  // what it was made under: the settings file's stamp and the ceiling read
  // (a worker registering skips making it again when neither changed)
  const seen = {stamp: (opts.stamp !== undefined) ? opts.stamp : fileStamp(), ceiling: moduleSettingsKey(c)};
  const r = make(name, made, Object.assign({}, opts, {ceiling: c}));
  if (r.state != null) Object.defineProperty(r.state, 'seen', {value: seen, writable: true, configurable: true});
  return r;
}
function make(name, made, {previous = null, load = false, ceiling: c = null, raw = null, ceilingRefuses = false, mm = null, dm = dmNow(), reach = null,
  log = (line) => LOG.I(line), quietState = false, sourceProblem = null, fileProblem = null} = {}) {
  // the declaration, parsed once (stateFor takes it)
  const declared = moduleSettings.parseDeclaration(made.pkg);
  // a previous state of another declaration (another version) is none
  if (previous != null && (previous.made == null || JSON.stringify(previous.settings) !== JSON.stringify(declared.settings))) previous = null;
  // made from other inputs (a restart: the pin again, the net granted now):
  // the previous state checked again against them, so what is kept is never
  // outside the net granted now, and later rereads make it from these
  if (previous != null && (previous.made.pkg !== made.pkg || JSON.stringify(previous.made.net) !== JSON.stringify(made.net))) {
    const rebased = {};
    previous = moduleSettings.restate(name, previous, {pkg: made.pkg, net: made.net, ceiling: c}, rebased);
    // refused by the ceiling's fixed value: where the ceiling refuses (a
    // supervised restart), that is the answer, marked as the ceiling's
    // whatever else would follow (restartFailed suspends at once)
    if (previous == null && ceilingRefuses && rebased.refusedBy != null && rebased.refusedBy.ceiling === true) {
      return ceilingRefusalOf(name, rebased.refusedBy, [{name: `module.${name}`, code: rebased.refusedBy.code || 'SETTING_INVALID'}], log);
    }
  }
  // the history's "no longer valid" lines are an operator's load's only: a
  // restart, a registration or a reread never writes them (one whose
  // previous state was set aside, as another version's, included)
  // quietState: stateFor's own lines (what is not applied, at a load) were
  // said when the state was first made; what changes is said all the same
  const told = (text) => { if (mm != null) tell(mm, dm, reach || reachOf(mm, dm), name, previous, text); };
  // The stored values cannot be read (`sourceProblem`, reread's; or the one
  // stateFor finds): the operator's ceiling binds all the same, for every
  // caller (a load excepted, which is refused). Its fixed values go over the
  // previous state's values (lib/module-settings.js restate); nothing else
  // changes. One the declaration rejects keeps the previous state, said
  // once while the ceiling stays the same.
  // `problem`: why the stored values cannot be read, said once (log and
  // notice) while it stays the same, and named in `refused`
  const overPrevious = (problem) => {
    const refusedNow = [{name: `module.${name}`, code: 'SETTING_NOT_APPLIED'}];
    const why = {};
    const re = moduleSettings.restate(name, previous, {pkg: made.pkg, net: made.net, ceiling: c}, why);
    if (re == null) {
      const refusedHere = [{name: `module.${name}`, code: 'SETTING_INVALID'}].concat(refusedNow);
      const byCeiling = why.refusedBy != null && why.refusedBy.ceiling === true;
      // not the ceiling's (values over 32 KiB): the previous state, kept
      if (!byCeiling) {
        const said = `invalid\0${String(why.refusedBy != null ? why.refusedBy.code : '')}`;
        if (previous.said !== said) log(`module settings: ${name}: its settings could not be applied again (${why.refusedBy != null ? why.refusedBy.code : 'refused'}); it keeps the settings it had`);
        return {state: previous.said === said ? previous : copyOf(previous, {}, said), refusal: null, refused: refusedHere, applied: false};
      }
      // the ceiling binds whether the file can be read or not: where it
      // refuses (a supervised restart), it refuses here too, marked as the
      // ceiling's (lib/module-manager.js restartFailed suspends at once)
      if (ceilingRefuses) return ceilingRefusalOf(name, {code: 'SETTING_INVALID', setting: null, ceiling: true}, refusedHere, log);
      const said = `ceiling\0${moduleSettingsKey(c)}`;
      // said once, but never hidden from the reply
      if (previous.said === said) return {state: previous, refusal: null, refused: refusedHere, applied: false};
      log(`module settings: ${name}: the operator's ceiling fixes a value this version does not accept or declare; it keeps the settings it had`);
      told((label) => `${label}'s settings were not changed: the operator's ceiling fixes a value this version does not accept; it keeps the settings it had`);
      return {state: copyOf(previous, {}, said), refusal: null, refused: refusedHere, applied: false};
    }
    let state = (re.version === previous.version) ? previous : re;
    let applied = false;
    if (re.version !== previous.version) {
      const names = changedNames(previous.values, re.values);
      moduleSettings.historyLine(name, null, `applied by the operator's ceiling: ${names.join(', ')}`, {log});
      told((label, part) => (part ? `${label}: its settings changed (the operator's ceiling)` : `${label}'s settings changed by the operator's ceiling: ${names.join(', ')}`));
      log(`module settings: ${name}: the operator's ceiling applied ${names.join(', ')} (version ${re.version})`);
      applied = true;
    }
    // the stored values' problem, said once while it stays the same
    const said = `source\0${problem}`;
    if (previous.said !== said) {
      log(`module settings: ${name}: ${String(problem).slice(0, 300)}; it keeps the settings it ran with, the operator's ceiling applied`);
      told((label) => `${label}'s settings were not read again: they cannot be read now; it keeps the settings it had`);
    }
    if (state.said !== said) state = copyOf(state, {}, said);
    return {state, refusal: null, refused: refusedNow, applied};
  };
  if (sourceProblem != null) {
    if (previous == null) return {state: null, refusal: (fileProblem != null ? moduleSettings.settingsFileRefusal(name, fileProblem) : moduleSettings.settingsRefusal(name, sourceProblem)), refusedBy: {code: 'SETTING_NOT_APPLIED', setting: null}, refused: [], applied: false};
    return overPrevious(sourceProblem);
  }
  const st = moduleSettings.stateFor(name, made.pkg, {net: made.net, operator: true, log: quietState ? () => {} : log, ceiling: c, raw,
    history: load === true && previous == null, declared});
  const stored = (key) => (raw != null ? raw[`module.${name}.${key}`] : undefined);
  if (st.refused != null && previous != null && st.refusedBy != null && st.refusedBy.code === 'SETTING_NOT_APPLIED') return overPrevious(st.refusedWhy);
  if (st.refused != null) {
    const by = st.refusedBy || {code: 'SETTING_NOT_APPLIED', setting: null};
    const refused = [{name: by.setting != null ? `module.${name}.${by.setting}` : `module.${name}`, code: by.code}];
    if (previous == null || (by.ceiling === true && ceilingRefuses)) {
      // a refusal by the ceiling: retrying cannot succeed until it changes
      // (lib/module-manager.js restartFailed suspends at once)
      if (by.ceiling === true && st.refused != null && typeof(st.refused) === 'object') ceilingRefusals.add(st.refused);
      return {state: null, refusal: st.refused, refusedBy: by, refused, applied: false};
    }
    // said once while it stays the same (every reread and ceiling change
    // would otherwise say it again)
    const said = `${by.code}\0${by.setting}\0${st.refusedWhy}`;
    if (previous.said === said) return {state: previous, refusal: null, refused, applied: false};
    const words = refusalText(by, st.refusedWhy);
    told((label) => `${label}'s settings were not changed: ${words}; it keeps the settings it had`);
    if (by.setting != null) {
      moduleSettings.historyLine(name, by.setting, 'not applied', by.ceiling === true ? {ceiling: st.refusedWhy, log} : {stored: stored(by.setting), log});
    }
    // the operator's log has the whole reason (the ceiling's file problem too)
    log(`module settings: ${name}: not applied (${by.code}: ${String(st.refusedWhy).slice(0, 300)}); it keeps the settings it had`);
    return {state: copyOf(previous, {}, said), refusal: null, refused, applied: false};
  }
  if (previous == null) return {state: st, refusal: null, refused: [], applied: true};
  const counts = (n) => n.code !== 'SETTING_UNKNOWN';
  const before = new Set((previous.notApplied || []).map(keyOf));
  const refusals = st.notApplied.filter((n) => counts(n) && !before.has(keyOf(n)));
  if (refusals.length > 0) {
    for (const n of refusals) moduleSettings.historyLine(name, n.setting, `not applied: ${n.reason}`, {stored: stored(n.setting), log});
    // one notice for the module, whatever the number of values
    told((label, part) => (part ? `${label} kept its settings: a value set for it was not applied (ch-local settings modules lists them)`
      : `${label} kept its settings: ${refusals.map((n) => `${n.setting} not applied (${n.reason})`).join('; ')}`));
    log(`module settings: ${name}: not applied (${refusals.length} value${refusals.length > 1 ? 's' : ''} refused); it keeps the settings it had`);
    // kept whole, the refused values recorded as not applied: said once, and
    // holding no later change back
    return {state: copyOf(previous, {notApplied: st.notApplied}, null), refusal: null,
      refused: refusals.map((n) => ({name: `module.${name}.${n.setting}`, code: n.code})), applied: false};
  }
  // a value still not applied keeps the value it ran with (one the ceiling
  // fixes is the ceiling's)
  const fixed = moduleSettings.fixedOf(c, name);
  const still = st.notApplied.filter((n) => counts(n) && before.has(keyOf(n)) && own(previous.values, n.setting) && !own(fixed, n.setting));
  let values = st.values;
  if (still.length > 0) {
    values = Object.assign(Object.create(null), st.values);
    for (const n of still) values[n.setting] = previous.values[n.setting];
    values = Object.freeze(values);
  }
  if (valuesText(previous.values) === valuesText(values)) {
    if (notAppliedText(previous.notApplied) === notAppliedText(st.notApplied) && previous.said == null) return {state: previous, refusal: null, refused: [], applied: false};
    return {state: copyOf(previous, {notApplied: st.notApplied}, null), refusal: null, refused: [], applied: false};
  }
  // never silent: what changed (by name, never a value), and what is still
  // not applied, in the history and to the sessions
  const changed = changedNames(previous.values, values);
  const pending = st.notApplied.filter(counts).map((n) => n.setting).sort();
  const tail = pending.length > 0 ? `; still not applied: ${pending.join(', ')}` : '';
  moduleSettings.historyLine(name, null, `applied: ${changed.join(', ')}${tail}`, {log});
  told((label, part) => (part ? `${label}: its settings changed` : `${label}'s settings changed: ${changed.join(', ')}${tail}`));
  log(`module settings: ${name}: applied ${changed.join(', ')} (version ${st.version})${tail}`);
  return {state: copyOf(st, {values}, null), refusal: null, refused: [], applied: true};
}

// the stamp of where the stored values come from now (--settingsFile, else
// --moduleSettings: its inode, size and times), or 'none'. (A rewrite of the
// same size within one timestamp tick reads as unchanged: a registration
// then takes the state its spawn made, and the next reread brings it on.)
function fileStamp() {
  const file = (options.settingsFile != null) ? options.settingsFile : options.moduleSettings;
  if (file == null) return 'none';
  try {
    // (read as bigints: the exact ino, and times to the nanosecond;
    // lib/file-identity.js)
    const st = require('fs').statSync(file, require('./file-identity').BIG);
    return `${file}\0${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  } catch (e) { return `${file}\0error:${e && e.code}`; }
}
// what a state would be made under now: the stored values' stamp and the
// ceiling read (undefined when it cannot be read)
function seenNow() {
  let ceiling;
  try { ceiling = settingsTool.moduleCeilingNow(); } catch (e) { ceiling = undefined; }
  return {stamp: fileStamp(), ceiling};
}
// whether state `st` was made under the settings file and ceiling as they
// are `now` (seenNow): the ceiling by what binds module settings (a re-read
// of the same file is a new object: on Windows every few minutes)
function unchangedSince(st, now = seenNow()) {
  if (st == null || st.seen == null || now.ceiling === undefined) return false;
  return st.seen.stamp === now.stamp && st.seen.ceiling === moduleSettingsKey(now.ceiling);
}
// A state as its instance starts to serve (a worker or record registering:
// lib/module-manager.js settleSettings): taken as it is when nothing
// changed since it was made, else
// made again by the one rule, from what was read just now, quietly (what
// stateFor says was said when it was made; a change is said). -> the state.
function settle(mm, name, st) {
  if (st == null || st.made == null) return st;
  const now = seenNow();
  if (unchangedSince(st, now)) return st;
  const opts = {previous: st, mm, quietState: true, stamp: now.stamp};
  if (now.ceiling !== undefined) opts.ceiling = now.ceiling;
  const r = next(name, st.made, opts);
  return r.state != null ? r.state : st;
}

// mm: the module manager; msg: the request. ceiling, log, dm: a test's.
async function reread(mm, msg, {ceiling = () => settingsTool.moduleCeilingNow(), log = (line) => LOG.I(line), dm = dmNow(), only = null} = {}) {
  const shape = require('./modules-in-place').moduleMessageProblem('reread', msg);
  if (shape != null) throw failed(shape.message);
  if (options.settingsFile == null) {
    throw failed(options.moduleSettings != null
      ? 'reread reads --settingsFile only; --moduleSettings is the operator\'s file, read at each load'
      : 'this runtime has no --settingsFile to read');
  }
  // the ceiling as it is now; one that cannot be read binds as one that
  // cannot be trusted
  let c = null;
  try { c = ceiling(); } catch (e) { c = {state: 'untrusted', file: null, problem: `it cannot be read (${e && e.code ? e.code : 'error'})`}; }
  // the file's stamp before it is read: each module's state is stamped with
  // the file it was made from (never a newer one written meanwhile)
  const stamp = fileStamp();
  let raw;
  try { raw = settingsTool.readFile(options.settingsFile).raw; } catch (e) {
    // The user's file cannot be used: the operator's ceiling binds all the
    // same. Its fixed values go over each module's running values (nothing
    // else changes); the file's problem is said once; and the request is
    // refused, nothing of the file applied.
    const fileProblem = moduleSettings.settingsFileProblem(e).slice(0, 200);
    const why = `the settings file cannot be read: ${fileProblem}`;
    if (mm.settingsFileProblem !== why) log(`module settings: ${why}; only the operator's ceiling is applied`);
    mm.settingsFileProblem = why;
    // each module by the one rule, its stored values unreadable
    const reach = reachOf(mm, dm);
    let byCeiling = 0;
    for (const [name, old] of loaded(mm)) {
      // (the settings tool's write: the one module whose value changed)
      if (only != null && name !== only) continue;
      const r = next(name, old.made, {previous: old, ceiling: c, sourceProblem: why, fileProblem, stamp, mm, dm, reach, log});
      if (r.applied) byCeiling += 1;
      if (r.state != null && r.state !== old) put(mm, name, r.state);
    }
    // the reply says what changed all the same (ch-local reads the message)
    throw Object.assign(failed(`${why}; the operator's ceiling was applied (${byCeiling} module${byCeiling === 1 ? '' : 's'} changed)`),
      {fileProblem: true, appliedByCeiling: byCeiling, stamp});
  }
  // The file read, while its problem was said: it has been put right, and
  // the other modules ran with the ceiling's values only, so this is a
  // whole reread (the file's problem cleared), whatever was asked.
  if (only != null && mm.settingsFileProblem != null) only = null;
  if (only == null) mm.settingsFileProblem = null;
  const reach = reachOf(mm, dm);
  const reply = {applied: 0, refused: []};
  for (const [name, old] of loaded(mm)) {
    // (the settings tool's write: the one module whose value changed)
    if (only != null && name !== only) continue;
    const r = next(name, old.made, {previous: old, ceiling: c, raw, stamp, mm, dm, reach, log});
    reply.refused.push(...r.refused);
    if (r.applied) reply.applied += 1;
    if (r.state != null && r.state !== old) put(mm, name, r.state);
  }
  return reply;
}

// What a ceiling binds module settings by: whether it can be trusted, and
// its moduleSettings; a change of anything else (packs, the caps) is no
// reason to reread.
function moduleSettingsKey(c) {
  if (c == null) return 'none';
  if (c.state !== 'trusted') return c.state;
  return `trusted\0${JSON.stringify(c.ceiling != null ? c.ceiling.moduleSettings : null)}`;
}

// The operator's ceiling watched for the modules' settings
// (lib/route-manager.js, on lib/settings-tool.js onCeilingChange): a change
// of what binds them rereads every module's, so a fixed value binds without
// ch-local. One reread waits at a time (a change while one waits is in it).
// One that fails because the user's settings file cannot be used has
// applied the ceiling all the same (next's one rule, reread saying the
// file's problem once per module manager: mm.settingsFileProblem); the
// file's stamp is then checked every 10 s, and it is read again once it
// changes (by ch-local or by hand). Any other failure is said once and not
// retried. A success stops the watch. -> fn(ceiling) for onCeilingChange. deps: enqueue(fn) (the
// control channel's chain), now (the ceiling read now), log, later(fn, ms)
// and clear(t) (a timer).
function ceilingWatcher(mm, {enqueue, now = () => settingsTool.moduleCeilingNow(), log = (line) => LOG.I(line),
  later = (fn, ms) => { const t = setTimeout(fn, ms); if (typeof(t.unref) === 'function') t.unref(); return t; }, clear = (t) => clearTimeout(t)} = {}) {
  let seen = moduleSettingsKey((() => { try { return now(); } catch (e) { return null; } })());
  let waiting = false;
  let watch = null;
  let lastFailure = null;
  const stopWatch = () => { if (watch != null) { clear(watch); watch = null; } };
  const run = () => {
    if (waiting) return;
    waiting = true;
    enqueue(async () => {
      waiting = false;
      try {
        const r = await reread(mm, {type: 'reread', what: 'module-settings'});
        lastFailure = null;
        stopWatch();
        log(`module settings: the operator's ceiling changed: re-read (${r.applied} applied, ${r.refused.length} refused)`);
      } catch (e) {
        if (e != null && e.fileProblem === true) {
          // the user's file cannot be used (reread said so once, and applied
          // the ceiling all the same): its stamp is checked every 10 s (a
          // stat), and it is read again once it changes, by ch-local or by
          // hand; nothing else is said meanwhile
          // against the stamp taken before the failed read (a write that
          // finished after it, before this, is a change)
          const failedAt = (typeof(e.stamp) === 'string') ? e.stamp : fileStamp();
          const check = () => {
            watch = null;
            if (fileStamp() !== failedAt) run();
            else watch = later(check, 10000);
          };
          if (watch == null) watch = later(check, 10000);
          return;
        }
        // anything else (no --settingsFile) would fail the same way for
        // ever: said once, not retried
        const why = String(e && e.message).slice(0, 200);
        if (why !== lastFailure) log(`module settings: the operator's ceiling changed, and the re-read failed (${why})`);
        lastFailure = why;
      }
    });
  };
  return (c) => {
    const key = moduleSettingsKey(c);
    if (key === seen) return;
    seen = key;
    run();
  };
}

// The loaded top-level modules that declare settings, for the settings
// tool's module.* (lib/settings-tool.js, M2b): [{name, version, part:
// false, state}], a part never. mm: the module manager (default: the
// device manager's).
function topModuleStates(mm = null) {
  const m = mm != null ? mm : ((dmNow() != null) ? dmNow().moduleManager : null);
  if (m == null) return [];
  const out = [];
  for (const [name, st] of loaded(m)) {
    if (isPart(m, name, st)) continue;
    const pkg = st.made != null ? st.made.pkg : null;
    out.push({name, version: (pkg != null && typeof(pkg.version) === 'string') ? pkg.version : null, part: false, state: st});
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
// the loaded top-level modules, their closures and listed tools (the
// settings tool's enabled.* rows and the callers turned off with one:
// lib/modules-in-place.js loadedTops); none when no runtime serves
function loadedTops(mm = null) {
  const m = mm != null ? mm : ((dmNow() != null) ? dmNow().moduleManager : null);
  if (m == null) return [];
  try { return require('./modules-in-place').loadedTops(m); } catch (err) { return []; }
}
// whether the startup list is still loading (lib/module-manager.js
// startupPending): the settings tool's get says some modules may not be
// listed yet
function startingUp() {
  const dm = dmNow();
  const mm = dm != null ? dm.moduleManager : null;
  return mm != null && mm.startupPending instanceof Set && mm.startupPending.size > 0;
}

// the module.* values applied now, after the settings tool wrote one
// (`pkg`: the module whose value changed, the only one re-read), on the
// control channel's chain when there is one, so it never races ch-local's
// rereads, a reload or the ceiling's watch
async function applyNow(pkg = null) {
  const dm = dmNow();
  const mm = dm != null ? dm.moduleManager : null;
  if (mm == null) return {applied: 0, refused: []};
  const run = () => reread(mm, {type: 'reread', what: 'module-settings'}, {only: pkg});
  return new Promise((resolve, reject) => {
    const queued = controlChannel.enqueue(async () => { try { resolve(await run()); } catch (e) { reject(e); } });
    if (queued !== true) run().then(resolve, reject);
  });
}

module.exports = {next, reread, put, settle, unchangedSince, configure, calleeOf, friendlyNamesOf, isCeilingRefusal, ceilingWatcher, topModuleStates, loadedTops, applyNow, startingUp};
