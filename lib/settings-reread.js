'use strict';
// reread {what: 'module-settings'} on the control channel (the module-level
// configuration design, sections 4.3 and 7.3; M2a): ch-local has written a
// module.* value of --settingsFile, and the runtime reads them again. The
// operator's ceiling changing while modules run does the same
// (lib/route-manager.js, on lib/settings-tool.js onCeilingChange), so a
// fixed value binds without ch-local.
//
// The file is read once. Each loaded module that declares settings gets its
// state again (lib/module-settings.js stateFor), from what the state it runs
// with was made from (its pinned package.json and granted net: the state's
// own, so a reload whose worker failed leaves the old worker's), under the
// operator's ceiling as it is now. A module coming up (a supervised restart,
// a load) has no proxy yet: each reread is numbered (generation), and a
// worker registered with a state made before the last one has its state
// made again then (lib/module-manager.js catchUpSettings).
// - Atomic per module. Any value of a module that this reread newly refuses
//   (or a fixed value its declaration rejects or does not declare, a
//   ceiling that cannot be trusted, values over 32 KiB) keeps ALL of that
//   module's old values; the other modules still apply. Each refusal is a
//   notice to the sessions that have the module in view (a part's is said
//   as "a part of <top>", never named; the ceiling's file problem goes to
//   the log only) and a "not applied" history line: the user's value's, or
//   the ceiling's when its fixed value is what refused.
// - Not a refusal (the reviewer's ruling (a)): a stored name this version
//   does not declare (the settings tool keeps unknown names in the file); a
//   value that was already not applied, the same value (by SHA-256). A
//   refused value is recorded as not applied in the state kept, so it is
//   said once and blocks no later change; another bad value still does.
//   Once it no longer blocks, the setting keeps the value it ran with (not
//   its default), until a value that can be applied is written. What was
//   not applied is made again at every reread, so a bad value removed and
//   written back is new again. A refusal of the whole module (the ceiling,
//   values over 32 KiB) still blocks, and is said once while it stays the
//   same.
// - Applied: the new state, with a new version, on the module's worker's
//   proxy, its per-session record and every session's worker, the copy a
//   supervised restart reads and single-thread mode's. The next call sends
//   the new values (lib/settings-gate.js); a call already sent keeps the
//   values it was sent with, and a task keeps its pin.
// - The same values keep their version (what was not applied is updated).
// - Never an unload: a required setting newly unset stays loaded, and its
//   calls answer SETTING_REQUIRED.
// -> {applied: <modules whose values changed>, refused: [{name, code}]},
// name "module.<package>.<setting>", or "module.<package>" when the refusal
// is not one value's; never a value. A request of another shape
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

// Each reread is numbered; a state made by a load is marked with the number
// it was made under (lib/module-manager.js catchUpSettings).
let current = 0;
const made = new WeakMap();
const generation = () => current;
const markMade = (st) => { if (st != null && typeof(st) === 'object') made.set(st, current); return st; };
const madeAt = (st) => (st != null && typeof(st) === 'object' && made.has(st)) ? made.get(st) : -1;

// the values as one text, by name: whether two states run alike
const valuesText = (values) => (values == null ? 'null' : JSON.stringify(Object.keys(values).sort().map((k) => [k, values[k]])));

// the state `old` with what was not applied made again (the same values and
// version, so nothing is sent again), carrying what it was made from; `said`:
// the whole module's refusal last said (said once while it stays the same)
function kept(old, notApplied, said = null) {
  const st = Object.assign({}, old, {notApplied});
  Object.defineProperty(st, 'made', {value: old.made});
  if (said != null) Object.defineProperty(st, 'said', {value: said});
  return markMade(st);
}
// The new state, with each setting whose value is still the one not applied
// before keeping the value it ran with (not its default): a refused value
// never takes a running value away. A value the ceiling fixes is the
// ceiling's.
function keepingOld(st, old, stillNotApplied, fixed) {
  const carried = stillNotApplied.filter((n) => old.values != null && Object.prototype.hasOwnProperty.call(old.values, n.setting) &&
    !(fixed != null && Object.prototype.hasOwnProperty.call(fixed, n.setting)));
  if (carried.length === 0) return st;
  const values = Object.assign(Object.create(null), st.values);
  for (const n of carried) values[n.setting] = old.values[n.setting];
  const out = Object.assign({}, st, {values: Object.freeze(values)});
  Object.defineProperty(out, 'made', {value: st.made});
  return out;
}

// each loaded module's state now: name -> state (one that declares settings
// and was made by stateFor), from its worker's proxy or per-session record,
// else single-thread mode's copy (a module coming up is caught up when it
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
let context = {dm: null};
function configure({dm = null} = {}) { context = {dm}; }

// the module's package.json as pinned, or null
const pinnedOf = (mm, name) => (mm.manifestPins != null && typeof(mm.manifestPins.pinnedOf) === 'function') ? mm.manifestPins.pinnedOf(name) : null;
// the package a call address names: its <device> is the callee's
// friendlyName (lib/call-address.js parseAddress), and the package is the
// one the device manager has for that device's ID; without a device
// manager, the friendlyName
function calleeOf(call, dm) {
  const p = callAddress.parseAddress(call);
  if (p == null) return null;
  if (dm == null || typeof(dm.moduleOfDevice) !== 'function') return p.device;
  const pkg = dm.moduleOfDevice(callAddress.deviceIDForName(p.device));
  return typeof(pkg) === 'string' ? pkg : null;
}
// the friendlyName a tool result of package `pkg` takes its notices by
// (lib/mcp/tool-registry.js target.module, lib/usage/receipt.js), or the
// package name when no device of it is known
function friendlyNameOf(pkg, dm) {
  if (dm != null && dm.deviceMap != null && typeof(dm.moduleOfDevice) === 'function') {
    for (const id of Object.keys(dm.deviceMap)) {
      if (dm.moduleOfDevice(id) !== pkg) continue;
      const d = dm.deviceMap[id];
      const name = (d != null && d.spec != null && d.spec.device != null) ? d.spec.device.friendlyName : null;
      if (typeof(name) === 'string' && name !== '') return name;
    }
  }
  return pkg;
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
// (its friendlyName): said with its next result there. A part's goes to
// each top-level module that calls it, as "a part of <top>". (text(label,
// part) -> the notice.)
function tell(mm, dm, reach, name, st, text) {
  const part = isPart(mm, name, st);
  const tops = part ? [...reach.keys()].filter((top) => reach.get(top).has(name)) : [name];
  if (part && tops.length === 0) LOG.I(`module settings: ${name}: no loaded top-level module calls it now; this is said in this log only`);
  const view = require('./session-packs');
  const {tellEverySession} = require('./modules-in-place');
  for (const top of tops) {
    tellEverySession(friendlyNameOf(top, dm), text(part ? `a part of ${top}` : top, part), {only: (sid) => view.listsModule(sid, top)});
  }
}

// a module's refusal as a client is told it: the runtime's words, never the
// ceiling's file problem (that is the log's)
function refusalText(by, why) {
  if (by.code === 'SETTING_CEILING_UNTRUSTED') return 'the operator\'s ceiling cannot be trusted';
  if (by.ceiling === true) return by.code === 'SETTING_UNKNOWN' ? 'the operator\'s ceiling fixes a setting this version does not declare' : 'the operator\'s ceiling fixes a value this version does not accept';
  return String(why).slice(0, 200);
}

// mm: the module manager; msg: the request. ceiling, log: a test's.
async function reread(mm, msg, {ceiling = () => settingsTool.moduleCeilingNow(), log = (line) => LOG.I(line), dm = context.dm} = {}) {
  const shape = require('./modules-in-place').moduleMessageProblem(msg);
  if (shape != null || msg.type !== 'reread') throw failed(shape != null ? shape.message : 'a reread is {type: "reread", what: "module-settings"}');
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
  // numbered once it reads: a module coming up is caught up when it registers
  current += 1;
  const reach = reachOf(mm, dm);
  const fixedNow = (name) => moduleSettings.fixedOf(c, name);
  const reply = {applied: 0, refused: []};
  for (const [name, old] of loaded(mm)) {
    const st = moduleSettings.stateFor(name, old.made.pkg, {net: old.made.net, operator: true, log, ceiling: c, raw, history: false});
    const stored = (key) => raw[`module.${name}.${key}`];
    if (st.refused != null) {
      const by = st.refusedBy || {code: 'SETTING_NOT_APPLIED', setting: null};
      reply.refused.push({name: by.setting != null ? `module.${name}.${by.setting}` : `module.${name}`, code: by.code});
      // said once while it stays the same (every reread and ceiling change
      // would otherwise say it again)
      const said = `${by.code}\0${by.setting}\0${st.refusedWhy}`;
      if (old.said !== said) {
        const words = refusalText(by, st.refusedWhy);
        tell(mm, dm, reach, name, old, (label) => `${label}'s settings were not changed: ${words}; it keeps the settings it had`);
        if (by.setting != null) {
          moduleSettings.historyLine(name, by.setting, 'not applied', by.ceiling === true ? {ceiling: st.refusedWhy, log} : {stored: stored(by.setting), log});
        }
        // the operator's log has the whole reason (the ceiling's file problem too)
        log(`module settings: ${name}: reread not applied (${by.code}: ${String(st.refusedWhy).slice(0, 300)}); it keeps the settings it had`);
      }
      put(mm, name, kept(old, old.notApplied || [], said));
      continue;
    }
    // what was not applied before, as the same value: no refusal now
    const key = (n) => `${n.setting}\0${n.digest}`;
    const before = new Set((old.notApplied || []).map(key));
    const refusals = st.notApplied.filter((n) => n.code !== 'SETTING_UNKNOWN' && !before.has(key(n)));
    if (refusals.length > 0) {
      for (const n of refusals) {
        reply.refused.push({name: `module.${name}.${n.setting}`, code: n.code});
        moduleSettings.historyLine(name, n.setting, `not applied: ${n.reason}`, {stored: stored(n.setting), log});
      }
      // one notice for the module, whatever the number of values
      tell(mm, dm, reach, name, old, (label, part) => (part ? `${label} kept its settings: a value set for it was not applied (ch-local settings modules lists them)`
        : `${label} kept its settings: ${refusals.map((n) => `${n.setting} not applied (${n.reason})`).join('; ')}`));
      log(`module settings: ${name}: reread not applied (${refusals.length} value${refusals.length > 1 ? 's' : ''} refused); it keeps the settings it had`);
      // kept whole, with the refused values recorded as not applied: said
      // once, and no longer holding a later change back
      put(mm, name, kept(old, st.notApplied));
      continue;
    }
    // a value still not applied keeps the value it ran with
    const next = keepingOld(st, old, st.notApplied.filter((n) => n.code !== 'SETTING_UNKNOWN' && before.has(key(n))), fixedNow(name));
    if (valuesText(old.values) === valuesText(next.values)) {
      put(mm, name, kept(old, st.notApplied));
      continue;
    }
    put(mm, name, markMade(next));
    reply.applied += 1;
    log(`module settings: ${name}: reread applied (version ${next.version})`);
  }
  return reply;
}

module.exports = {reread, generation, markMade, madeAt, configure, calleeOf, friendlyNameOf};
