'use strict';
// ch-local's module and pack messages on the control channel (packs in
// place, part 2; module-level configuration, #413 rev 3, section 7.3; the
// contract in docs/superpowers/specs/shared-runtime-wire/vectors.json
// packMessages and moduleMessages): load, reload, unload, a notice, and set.
//
// No session has a view of its own (M5a, section 5.4): whatever is loaded is
// listed to every session, and a module going on or off is hidden from all
// of them (lib/module-visibility.js, kept by lib/modules-in-place.js). So in
// a shared runtime a notice goes once to every open session, and a pack
// form's `global` decides nothing (its `pack` is still checked, until M6
// retires the pack form). set is applyControlSet's: a pack name there is an
// unknown set.
//
// Under --stdio (and over HTTP) a notice is the runtime's own, as before.

// one grammar for a pack's name (lib/settings-tool.js)
const {PACK_NAME: PACK} = require('./settings-tool');

// a control request refused: the control channel's reply code (as
// lib/modules-in-place.js refuses one), never a catalogue error
function refusal(why) {
  return Object.assign(new Error(why), {code: 'CONTROL_FAILED'});
}

// deps: mm, dm, packs (lib/modules-in-place.js: loadPack, reloadPack,
// unloadPack), toolsOf(modules) -> Promise of the tools they list, shared()
// -> whether this is a shared runtime; packUnloaded(name) (lib/settings-tool.js,
// a pack turned on this start is off again), applyControlSet(msg) (the
// sets); notices for tests to replace.
function createPackControl(given) {
  const deps = Object.assign({
    packUnloaded: (name) => require('./settings-tool').packUnloaded(name),
    applyControlSet: null,
    notices: require('./notices')
  }, given);
  const {notices} = deps;
  const shared = () => deps.shared() === true;
  const mip = require('./modules-in-place');
  const {isModuleForm} = mip;

  // a pack-form message's pack, checked as before (the pack form stays until M6)
  const packOf = (msg) => {
    if (msg == null || typeof(msg.pack) !== 'string' || !PACK.test(msg.pack)) throw refusal('a pack message names its pack');
    return msg.pack;
  };
  // A text, once to every open session of a shared runtime; otherwise the
  // runtime's own notice.
  const toEveryone = (module, text) => {
    if (!shared()) return notices.add(module, text);
    for (const id of require('./sessions').ids()) notices.add(module, text, {session: id, sessionOnly: true});
    return undefined;
  };
  // its shape checked before anything is loaded (#429's high review, 5)
  const checked = (msg) => {
    if (!shared()) return;
    if (isModuleForm(msg)) {
      const problem = mip.moduleMessageProblem(msg);
      if (problem != null) throw refusal(problem.message);
    } else packOf(msg);
  };

  const loadOrReload = (fn) => async(msg) => {
    checked(msg);
    const {modules} = await fn(deps.mm, msg, deps.dm);
    // a module-form reload names its modules in names (#427's high review,
    // 1): its notice is filed under each, so a client of any of them hears it
    const about = (msg != null && typeof(msg.name) === 'string') ? [msg.name] : (msg != null && Array.isArray(msg.names) ? msg.names : [null]);
    if (msg != null && typeof(msg.notice) === 'string') for (const m of about) toEveryone(m, msg.notice);
    return {tools: await deps.toolsOf(modules)};
  };

  async function unload(msg) {
    // in a shared runtime, a pack-form unload names its pack; a module-form
    // unit's never does. Decided by the record, never by a missing field
    // (M4b's medium review, 6)
    if (shared()) {
      const units = (deps.mm != null && deps.mm.packsInPlace instanceof Map) ? deps.mm.packsInPlace : null;
      const recorded = (msg != null && typeof(msg.name) === 'string' && units != null) ? units.get(msg.name) : null;
      if (!(msg != null && msg.pack === undefined && recorded != null && recorded.form === 'module')) packOf(msg);
    }
    const {modules} = await deps.packs.unloadPack(deps.mm, msg, deps.dm);
    deps.packUnloaded(msg != null ? msg.name : null);
    // a shared runtime's sessions are each told, in the message's words or
    // the plain ones; the runtime's own, only in the message's
    const text = (msg != null && typeof(msg.notice) === 'string') ? msg.notice
      : shared() ? `the ${msg.pack !== undefined ? msg.pack : msg.name} tools were turned off` : null;
    if (text != null) toEveryone(msg.name, text);
    return {tools: await deps.toolsOf(modules)};
  }

  async function notice(msg) {
    const module = (typeof(msg.module) === 'string') ? msg.module : null;
    if (shared() && msg.pack != null) packOf(msg);
    toEveryone(module, msg.text);
    return {};
  }

  // set {name, value}: the settings' (applyControlSet), where a pack name is
  // an unknown set
  async function set(msg) {
    if (typeof(deps.applyControlSet) === 'function') return deps.applyControlSet(msg);
    throw Object.assign(new Error(`${String(msg != null ? msg.name : '').slice(0, 40)} was not applied`), {code: 'CONTROL_FAILED'});
  }

  return {load: loadOrReload(deps.packs.loadPack), reload: loadOrReload(deps.packs.reloadPack), unload, notice, set};
}

// createModuleControl: the module form's name for it (M4); createPackControl
// stays for the pack form until M6
module.exports = {createPackControl, createModuleControl: createPackControl};
