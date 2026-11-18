'use strict';
// ch-local's pack messages on the control channel (packs in place, part 2;
// shared runtime B3, Task 6: docs/superpowers/plans/2026-11-16-shared-runtime-b3-session-packs.md,
// and the contract in docs/superpowers/specs/shared-runtime-wire/vectors.json
// packMessages): load, reload, unload, a notice and set pack.<n>.
//
// In shared mode a load or a reload carries pack: <n> and global: a boolean.
// The runtime sets the pack's global value from the message before the load
// (so its modules are listed as they register), and never infers it from who
// is waiting; a load that fails puts the value back. A notice about a pack
// goes, once each, to the sessions that list it when it is delivered. A
// terminal off is always an unload, which does all of it, in order: the
// audience is taken; the pack is unloaded; it is gone from the session
// store (not global, no set); every session's own "on" ends (its "off"
// stays); and each session of the audience, and each whose "on" ended, is
// told once. set pack.<n> true makes a pack already loaded for a session
// global; there is no set pack.<n> false (refused, as an unknown set).
//
// Under --stdio (and over HTTP) pack and global are not read: every handler
// does what it did before B3.

// one grammar for a pack's name (lib/settings-tool.js): <n>, and pack.<n>
const {PACK_NAME: PACK, PACK: SET_PACK} = require('./settings-tool');

// a control request refused: the control channel's reply code (as
// lib/modules-in-place.js refuses one), never a catalogue error
function refusal(why) {
  return Object.assign(new Error(why), {code: 'CONTROL_FAILED'});
}

// deps: mm, dm, packs (lib/modules-in-place.js: loadPack, reloadPack,
// unloadPack), toolsOf(modules) -> Promise of the tools they list, shared()
// -> whether this is a shared runtime; packUnloaded(name) (lib/settings-tool.js,
// a pack turned on this start is off again), applyControlSet(msg) (the other
// sets); notices, sessionPacks and sessionSettings for tests to replace.
function createPackControl(given) {
  const deps = Object.assign({
    packUnloaded: (name) => require('./settings-tool').packUnloaded(name),
    applyControlSet: null,
    notices: require('./notices'),
    sessionPacks: require('./session-packs'),
    sessionSettings: require('./session-settings')
  }, given);
  const {notices, sessionPacks, sessionSettings} = deps;
  const shared = () => deps.shared() === true;

  // the pack a shared runtime's message is about
  const packOf = (msg, {needsGlobal}) => {
    if (msg == null || typeof(msg.pack) !== 'string' || !PACK.test(msg.pack)) throw refusal('a pack message names its pack');
    if (needsGlobal && typeof(msg.global) !== 'boolean') throw refusal(`${msg.pack}: a load or a reload says whether the pack is global`);
    return msg.pack;
  };
  // a text to each session that lists the pack now, once
  const tell = (pack, module, text, sessions) => {
    for (const id of sessions) notices.add(module, text, {session: id, sessionOnly: true});
  };

  const loadOrReload = (fn) => async(msg) => {
    if (!shared()) {
      const {modules} = await fn(deps.mm, msg, deps.dm);
      if (typeof(msg.notice) === 'string') notices.add(msg.name, msg.notice);
      return {tools: await deps.toolsOf(modules)};
    }
    const pack = packOf(msg, {needsGlobal: true});
    const was = sessionPacks.isGlobal(pack);
    sessionPacks.setGlobal(pack, msg.global);
    let modules;
    try {
      ({modules} = await fn(deps.mm, msg, deps.dm));
    } catch (e) {
      if (sessionPacks.isGlobal(pack) !== was) sessionPacks.setGlobal(pack, was);
      throw e;
    }
    // its records changed: the views are built again
    sessionPacks.packChanged(pack);
    if (typeof(msg.notice) === 'string') tell(pack, msg.name, msg.notice, sessionPacks.audienceOf(pack));
    return {tools: await deps.toolsOf(modules)};
  };

  async function unload(msg) {
    if (!shared()) {
      const {modules} = await deps.packs.unloadPack(deps.mm, msg, deps.dm);
      if (typeof(msg.notice) === 'string') notices.add(msg.name, msg.notice);
      deps.packUnloaded(msg != null ? msg.name : null);
      return {tools: await deps.toolsOf(modules)};
    }
    const pack = packOf(msg, {needsGlobal: false});
    // 1. who lists it now
    const audience = sessionPacks.audienceOf(pack);
    // 2. the unload
    const {modules} = await deps.packs.unloadPack(deps.mm, msg, deps.dm);
    // 3. gone from the store: not global, no set
    sessionPacks.packGone(pack);
    // 4. every session's own "on" ends; an "off" stays
    const ended = new Set(sessionSettings.dropPack(`pack.${pack}`));
    deps.packUnloaded(msg.name);
    // 5. each told once
    const plain = typeof(msg.notice) === 'string' ? msg.notice : `the ${pack} tools were turned off`;
    for (const id of new Set([...audience, ...ended])) {
      notices.add(msg.name, ended.has(id) ? `your this-session pack ${pack} ended: it was turned off` : plain, {session: id, sessionOnly: true});
    }
    return {tools: await deps.toolsOf(modules)};
  }

  async function notice(msg) {
    const module = (typeof(msg.module) === 'string') ? msg.module : null;
    if (shared() && msg.pack != null) {
      const pack = packOf(msg, {needsGlobal: false});
      tell(pack, module, msg.text, sessionPacks.audienceOf(pack));
      return {};
    }
    notices.add(module, msg.text);
    return {};
  }

  // set pack.<n> true (shared mode only): the terminal turned on, for
  // everyone, a pack already loaded for a session. Anything else is the
  // settings' (applyControlSet), where a pack name is an unknown set.
  async function set(msg) {
    const m = (msg != null && typeof(msg.name) === 'string') ? SET_PACK.exec(msg.name) : null;
    if (shared() && m != null && msg.value === true) {
      sessionPacks.setGlobal(m[1], true);
      return {};
    }
    if (typeof(deps.applyControlSet) === 'function') return deps.applyControlSet(msg);
    throw Object.assign(new Error(`${String(msg != null ? msg.name : '').slice(0, 40)} was not applied`), {code: 'CONTROL_FAILED'});
  }

  return {load: loadOrReload(deps.packs.loadPack), reload: loadOrReload(deps.packs.reloadPack), unload, notice, set};
}

module.exports = {createPackControl};
