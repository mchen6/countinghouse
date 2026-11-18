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
// - A refusal is a notice (one per module) to the sessions that have its
//   top-level module in view (a part's is said as "a part of <top>", never
//   named; the ceiling's file problem goes to the log only) and, for a
//   value, a "not applied" history line: the user's value's, or the
//   ceiling's when its fixed value is what refused.
// - Never silent: a change of the running values is said, a history line
//   (by the runtime, for module.<package>) and a notice naming what changed
//   and what is still not applied; never a value.
// - Applied: the new state, with a new version, on the module's worker's
//   proxy, its per-session record and every session's worker, the copy a
//   supervised restart reads and single-thread mode's. The next call sends
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
// --settingsFile, or a file that cannot be read, is refused whole
// (CONTROL_FAILED) with nothing changed.
const options = require('./cli-options');
const moduleSettings = require('./module-settings');
const LOG = require('./logger');
const WorkerMessage = require('./worker-message');
const {isRecord} = require('./session-module-record');
const settingsTool = require('./settings-tool');
const {callsOf} = require('./manifest-pins');
const callAddress = require('./call-address');

const failed = (why) => Object.assign(new Error(why), {code: 'CONTROL_FAILED'});
// the refusals the operator's ceiling made (a fixed value rejected or not
// declared): isCeilingRefusal(err)
const ceilingRefusals = new WeakSet();
const isCeilingRefusal = (err) => err != null && typeof(err) === 'object' && ceilingRefusals.has(err);

const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// the values as one text, by name: whether two states run alike
const valuesText = (values) => (values == null ? 'null' : JSON.stringify(Object.keys(values).sort().map((k) => [k, values[k]])));
const keyOf = (n) => `${n.setting}\0${n.digest}`;
const notAppliedText = (list) => JSON.stringify((list || []).map(keyOf).sort());

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
// and was made by stateFor), from its worker's proxy or per-session record,
// else single-thread mode's copy (a module coming up takes its state as it
// registers)
function loaded(mm) {
  const out = new Map();
  const take = (name, st) => { if (st != null && st.made != null && !out.has(name)) out.set(name, st); };
  for (const name of Object.keys(mm.modules || {})) {
    const m = mm.modules[name];
    if (m != null && (isRecord(m) || m instanceof WorkerMessage)) take(name, m.settings);
  }
  if (mm.singleThreadSettings != null) for (const [name, st] of mm.singleThreadSettings) take(name, st);
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

// the module manager and device manager notices are told through
// (lib/route-manager.js configure; a test passes its own)
// (a function: the device manager as it is when asked)
let context = {dm: null};
function configure({dm = null} = {}) { context = {dm}; }
const dmNow = () => (typeof(context.dm) === 'function' ? context.dm() : context.dm);

// the module's package.json as pinned, or null
const pinnedOf = (mm, name) => (mm.manifestPins != null && typeof(mm.manifestPins.pinnedOf) === 'function') ? mm.manifestPins.pinnedOf(name) : null;
// the package a device is of: the module that registered it (a worker's,
// lib/device-manager.js moduleOfDevice), else the package.json an
// in-process device (single-thread mode) was made from
function packageOfDevice(dm, id) {
  const pkg = (typeof(dm.moduleOfDevice) === 'function') ? dm.moduleOfDevice(id) : null;
  if (typeof(pkg) === 'string') return pkg;
  const d = (dm.deviceMap != null) ? dm.deviceMap[id] : null;
  return (d != null && d.packageInfo != null && typeof(d.packageInfo.name) === 'string') ? d.packageInfo.name : null;
}
// the package a call address names: its <device> is the callee's
// friendlyName (lib/call-address.js parseAddress), and the package is the
// one of that device's ID; without a device manager, the friendlyName
function calleeOf(call, dm) {
  const p = callAddress.parseAddress(call);
  if (p == null) return null;
  if (dm == null) return p.device;
  return packageOfDevice(dm, callAddress.deviceIDForName(p.device));
}
// the friendlyNames a tool result of package `pkg` takes its notices by
// (lib/mcp/tool-registry.js target.module, lib/usage/receipt.js): the one
// its own api.json gives (read at its spawn, before its devices register:
// lib/module-manager.js pinnedFriendlyNames), else one per device of it
// registered (single-thread mode's in-process devices); none known: the
// package name
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

// One notice for module `name`, to the sessions that have its top-level
// module in view (#429's helper, lib/modules-in-place.js tellEverySession,
// with a session filter), keyed as a tool result of that module takes it
// (its friendlyName): said with its next result there. A module of several
// devices (several friendlyNames): with the session's next result, once. A part's goes to
// each top-level module that calls it, as "a part of <top>". (text(label,
// part) -> the notice.)
function tell(mm, dm, reach, name, st, text) {
  const part = isPart(mm, name, st);
  const tops = part ? [...reach.keys()].filter((top) => reach.get(top).has(name)) : [name];
  if (part && tops.length === 0) LOG.I(`module settings: ${name}: no loaded top-level module calls it now; this is said in this log only`);
  const view = require('./session-packs');
  const {tellEverySession} = require('./modules-in-place');
  for (const top of tops) {
    const names = friendlyNamesOf(top, dm, mm);
    tellEverySession(names.length === 1 ? names[0] : null, text(part ? `a part of ${top}` : top, part), {only: (sid) => view.listsModule(sid, top)});
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
// it ran with, or null), load (an operator's load: its history lines), ceiling (as read; undefined: read now), raw (the
// settings file's values, read once; null: read here), ceilingRefuses (a
// ceiling's refusal refuses even with a previous state), mm, dm, reach (for
// the notices), log.
// -> {state, refusal, refused: [{name, code}], applied}: state null and
// refusal set when it may not run; state === previous when nothing changed;
// applied when the running values changed.
function next(name, made, opts = {}) {
  const c = (opts.ceiling !== undefined) ? opts.ceiling : settingsTool.moduleCeilingNow();
  // what it was made under: the settings file's stamp and the ceiling read
  // (a worker registering skips making it again when neither changed)
  const seen = {stamp: fileStamp(), ceiling: c};
  const r = make(name, made, Object.assign({}, opts, {ceiling: c}));
  if (r.state != null) Object.defineProperty(r.state, 'seen', {value: seen, writable: true, configurable: true});
  return r;
}
function make(name, made, {previous = null, load = false, ceiling: c = null, raw = null, ceilingRefuses = false, mm = null, dm = dmNow(), reach = null,
  log = (line) => LOG.I(line)} = {}) {
  // a previous state of another declaration (another version) is none
  if (previous != null && (previous.made == null || JSON.stringify(previous.settings) !== JSON.stringify(moduleSettings.parseDeclaration(made.pkg).settings))) previous = null;
  // made from other inputs (a restart: the pin again, the net granted now):
  // the previous state checked again against them, so what is kept is never
  // outside the net granted now, and later rereads make it from these
  if (previous != null && (previous.made.pkg !== made.pkg || JSON.stringify(previous.made.net) !== JSON.stringify(made.net))) {
    previous = moduleSettings.restate(name, previous, {pkg: made.pkg, net: made.net, ceiling: c});
  }
  // the history's "no longer valid" lines are an operator's load's only: a
  // restart, a registration or a reread never writes them (one whose
  // previous state was set aside, as another version's, included)
  const st = moduleSettings.stateFor(name, made.pkg, {net: made.net, operator: true, log, ceiling: c, raw, history: load === true && previous == null});
  const stored = (key) => (raw != null ? raw[`module.${name}.${key}`] : undefined);
  const told = (text) => { if (mm != null) tell(mm, dm, reach || reachOf(mm, dm), name, previous, text); };
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
  const names = new Set([...Object.keys(previous.values || {}), ...Object.keys(values)]);
  const valueOf = (vs, k) => JSON.stringify(own(vs, k) ? vs[k] : null);
  const changed = [...names].filter((k) => valueOf(previous.values, k) !== valueOf(values, k)).sort();
  const pending = st.notApplied.filter(counts).map((n) => n.setting).sort();
  const tail = pending.length > 0 ? `; still not applied: ${pending.join(', ')}` : '';
  moduleSettings.historyLine(name, null, `applied: ${changed.join(', ')}${tail}`, {log});
  told((label, part) => (part ? `${label}: its settings changed` : `${label}'s settings changed: ${changed.join(', ')}${tail}`));
  log(`module settings: ${name}: applied ${changed.join(', ')} (version ${st.version})${tail}`);
  return {state: copyOf(st, {values}, null), refusal: null, refused: [], applied: true};
}

// the settings file's stamp now (its inode, size and times), or 'none'
function fileStamp() {
  if (options.settingsFile == null) return 'none';
  try {
    const st = require('fs').statSync(options.settingsFile);
    return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch (e) { return `error:${e && e.code}`; }
}
// whether state `st` was made under the settings file and ceiling as they
// are now (a worker registering then takes it as it is: lib/module-manager.js
// settleSettings)
function unchangedSince(st) {
  if (st == null || st.seen == null) return false;
  let c;
  try { c = settingsTool.moduleCeilingNow(); } catch (e) { return false; }
  return st.seen.stamp === fileStamp() && st.seen.ceiling === c;
}

// the user's settings file's problem last said (said once while it stays)
let lastFileProblem = null;

// The operator's ceiling over each running module's values alone, when the
// user's settings file cannot be used (reread): its fixed values applied
// (lib/module-settings.js restate), nothing else changed, each change said
// in the log. A module whose declaration rejects a fixed value keeps its
// state (as reread keeps it). -> the modules changed.
function ceilingOnly(mm, c, log) {
  let changed = 0;
  for (const [name, old] of loaded(mm)) {
    const st = moduleSettings.restate(name, old, {pkg: old.made.pkg, net: old.made.net, ceiling: c});
    if (st == null || st.version === old.version) continue;
    put(mm, name, st);
    changed += 1;
    log(`module settings: ${name}: the operator's ceiling applied (version ${st.version})`);
  }
  return changed;
}

// mm: the module manager; msg: the request. ceiling, log, dm: a test's.
async function reread(mm, msg, {ceiling = () => settingsTool.moduleCeilingNow(), log = (line) => LOG.I(line), dm = dmNow()} = {}) {
  const shape = require('./modules-in-place').moduleMessageProblem(msg);
  if (shape != null || msg.type !== 'reread') throw failed(shape != null ? shape.message : 'a reread is {type: "reread", what: "module-settings"}');
  if (options.settingsFile == null) {
    throw failed(options.moduleSettings != null
      ? 'reread reads --settingsFile only; --moduleSettings is the operator\'s file, read at each load'
      : 'this runtime has no --settingsFile to read');
  }
  // the ceiling as it is now; one that cannot be read binds as one that
  // cannot be trusted
  let c = null;
  try { c = ceiling(); } catch (e) { c = {state: 'untrusted', file: null, problem: `it cannot be read (${e && e.code ? e.code : 'error'})`}; }
  let raw;
  try { raw = settingsTool.readFile(options.settingsFile).raw; } catch (e) {
    // The user's file cannot be used: the operator's ceiling binds all the
    // same. Its fixed values go over each module's running values (nothing
    // else changes); the file's problem is said once; and the request is
    // refused, nothing of the file applied.
    const why = `the settings file cannot be read: ${String(e.message).slice(0, 200)}`;
    if (why !== lastFileProblem) log(`module settings: ${why}; only the operator's ceiling is applied`);
    lastFileProblem = why;
    const byCeiling = ceilingOnly(mm, c, log);
    throw Object.assign(failed(why), {fileProblem: true, appliedByCeiling: byCeiling});
  }
  lastFileProblem = null;
  const reach = reachOf(mm, dm);
  const reply = {applied: 0, refused: []};
  for (const [name, old] of loaded(mm)) {
    const r = next(name, old.made, {previous: old, ceiling: c, raw, mm, dm, reach, log});
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
// applied the ceiling all the same (reread's ceilingOnly) and is tried once
// more in 10 s (mid-write); a later change, or ch-local's reread after a
// write, reads it again. Any other failure is not retried. A failure is
// logged once, and again only when it changes; a success clears a retry
// pending. -> fn(ceiling) for onCeilingChange. deps: enqueue(fn) (the
// control channel's chain), now (the ceiling read now), log, later(fn, ms)
// and clear(t) (a timer).
function ceilingWatcher(mm, {enqueue, now = () => settingsTool.moduleCeilingNow(), log = (line) => LOG.I(line),
  later = (fn, ms) => { const t = setTimeout(fn, ms); if (typeof(t.unref) === 'function') t.unref(); return t; }, clear = (t) => clearTimeout(t)} = {}) {
  let seen = moduleSettingsKey((() => { try { return now(); } catch (e) { return null; } })());
  let waiting = false;
  let retry = null;
  let retried = false;
  let lastFailure = null;
  const run = () => {
    if (waiting) return;
    waiting = true;
    enqueue(async () => {
      waiting = false;
      try {
        const r = await reread(mm, {type: 'reread', what: 'module-settings'});
        lastFailure = null;
        retried = false;
        if (retry != null) { clear(retry); retry = null; }
        log(`module settings: the operator's ceiling changed: re-read (${r.applied} applied, ${r.refused.length} refused)`);
      } catch (e) {
        const why = String(e && e.message).slice(0, 200);
        // the user's file cannot be used (the ceiling was applied all the
        // same): tried once more, in case it was mid-write; not again
        const again = e != null && e.fileProblem === true && !retried;
        if (again) retried = true;
        if (why !== lastFailure) log(`module settings: the operator's ceiling changed, and the re-read failed (${why})${again ? '; trying once more in 10 s' : ''}`);
        lastFailure = why;
        // only a file that cannot be read now may read later; anything else
        // (no --settingsFile) would fail the same way for ever
        if (again && retry == null) retry = later(() => { retry = null; run(); }, 10000);
      }
    });
  };
  return (c) => {
    const key = moduleSettingsKey(c);
    if (key === seen) return;
    seen = key;
    retried = false;
    run();
  };
}

module.exports = {next, reread, put, unchangedSince, configure, calleeOf, friendlyNamesOf, isCeilingRefusal, ceilingWatcher};
