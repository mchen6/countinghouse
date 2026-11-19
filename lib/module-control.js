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
// -> whether this is a shared runtime; applyControlSet(msg) (the sets);
// notices for tests to replace. (No settings state follows an unload since
// M5b: a module's on/off is the settings file's, never this start's.)
function createPackControl(given) {
  const deps = Object.assign({
    applyControlSet: null,
    notices: require('./notices'),
    // a module the settings file has turned off (enabled.<pkg> false; throws
    // when it cannot be read), and the loaded top-level modules with their
    // closures: an unload of one turned off tells every session what went
    // with it and both ways back (#449's high review, round 3, R)
    turnedOff: (name) => require('./settings-tool').storedOff(name),
    loadedTops: () => require('./settings-reread').loadedTops()
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
  // runtime's own notice (one helper: lib/modules-in-place.js)
  // A module turned off (#449's high review, round 3, R, and the medium
  // review of that round, 1, 2 and 4): ch-local unloads it and each loaded
  // module that calls it, each in a message of its own, in either order.
  // All of it is told once, in the module's own notice: its unload, when
  // the settings have it off and ch-local's notice says it was turned off
  // (another reason, a removal, is said in ch-local's words). A caller's
  // unload while a module of its closure is off tells nothing: noted for the
  // module's notice still to come (callersBefore), or already in the one
  // told (offTold). A load of the module clears both, so a later unload is
  // judged afresh. Exact: no timers.
  const OFF_NOTICE = /\bturned off\.?$/;
  // module turned off -> Map(caller unloaded before it -> that unload's own
  // text, said after all if the module's unload is for another reason)
  const callersBefore = new Map();
  const offTold = new Set();         // modules turned off whose notice was told
  // -> {text} for the module's own notice, {silent: true} for a caller's,
  // or null: as before
  function offOf(msg) {
    const name = (msg != null && typeof(msg.name) === 'string') ? msg.name : null;
    if (name == null) return null;
    const tops = deps.loadedTops();
    if (deps.turnedOff(name) === true && typeof(msg.notice) === 'string' && OFF_NOTICE.test(msg.notice)) {
      const callers = new Set(require('./settings-tool').callersIn(name, tops));
      for (const c of (callersBefore.get(name) || new Map()).keys()) callers.add(c);
      return {name, text: require('./settings-tool').offNotice(name, [...callers].sort())};
    }
    const me = tops.find((t) => t.name === name);
    const roots = me == null || !Array.isArray(me.modules) ? [] : me.modules.filter((m) => m !== name && deps.turnedOff(m) === true);
    // (one whose own unload is to come: the module loaded on its own now)
    const pending = roots.find((m) => tops.some((t) => t.name === m));
    if (pending != null) {
      return {silent: true, note: (text) => {
        if (!callersBefore.has(pending)) callersBefore.set(pending, new Map());
        callersBefore.get(pending).set(name, text);
      }};
    }
    if (roots.some((m) => offTold.has(m))) return {silent: true, note: () => {}};
    return null;
  }

  const toEveryone = (module, text, own = false) => mip.tellEverySession(module, text, Object.assign({notices, shared}, own ? {max: notices.OWN_NOTICE_MAX} : {}));
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
    // loaded again: an off told before is judged afresh at a later unload
    for (const m of about) { callersBefore.delete(m); offTold.delete(m); }
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
    // a module turned off, or a caller of one: judged before the unload,
    // from what is loaded now (offOf above)
    let off = null;
    try { off = offOf(msg); } catch (err) { off = null; /* the settings unreadable: the message's words */ }
    const {modules} = await deps.packs.unloadPack(deps.mm, msg, deps.dm);
    // (a caller's own text, kept for when its module is unloaded for
    // another reason)
    const ownText = (msg != null && typeof(msg.notice) === 'string') ? msg.notice
      : shared() ? `the ${msg.pack !== undefined ? msg.pack : msg.name} tools were turned off` : null;
    if (off != null && off.silent === true) {
      off.note(ownText);
      return {tools: await deps.toolsOf(modules)};
    }
    const offText = off != null ? off.text : null;
    if (off != null) offTold.add(off.name);
    // callers held back for this module's notice, which is not an off's:
    // each said in its own words now, never lost
    const heldBack = (msg != null && typeof(msg.name) === 'string') ? callersBefore.get(msg.name) : undefined;
    if (msg != null && typeof(msg.name) === 'string') callersBefore.delete(msg.name);
    if (off == null && heldBack != null) for (const [c, t] of heldBack) if (t != null) toEveryone(c, t);
    // a shared runtime's sessions are each told, in the message's words or
    // the plain ones; the runtime's own, only in the message's
    const text = offText != null ? offText : ownText;
    if (text != null) toEveryone(msg.name, text, offText != null);
    return {tools: await deps.toolsOf(modules)};
  }

  async function notice(msg) {
    const module = (typeof(msg.module) === 'string') ? msg.module : null;
    // (a pack that is there is checked, null included: the vectors' packMessages)
    if (shared() && msg.pack !== undefined) packOf(msg);
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
