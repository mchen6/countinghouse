'use strict';
// ch-local's module messages on the control channel (module-level
// configuration, #413 rev 3, section 7.3; the contract in
// docs/superpowers/specs/shared-runtime-wire/vectors.json moduleMessages):
// load, reload, unload, a notice, and set. The pack form is gone (M6): a
// message carrying scenario, pack, global or remoteCredentials is refused.
//
// No session has a view of its own (M5a, section 5.4): whatever is loaded is
// listed to every session, and a module going on or off is hidden from all
// of them (lib/module-visibility.js, kept by lib/modules-in-place.js). So in
// a shared runtime a notice goes once to every open session. set is
// applyControlSet's.
//
// Under --stdio (and over HTTP) a notice is the runtime's own, as before.

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
function createModuleControl(given) {
  const deps = Object.assign({
    applyControlSet: null,
    notices: require('./notices'),
    // where the settings tool is served (its off text says how to turn a
    // module on again there), and the loaded top-level modules with their
    // closures, from the manager the unload acts on: an unload with reason
    // 'off' tells every session what went with it and the way back
    // (#449's high review, round 4)
    settingsServed: null,
    storedOff: null,
    loadedTops: null
  }, given);
  // (served: the tool on and a settings file to write, the single-identity
  // profile's; the medium review of round 4, 6)
  // whether the settings file holds enabled.<name> false (one read, as
  // stored: a value elsewhere in it the settings would refuse never hides
  // the off; throws when it cannot be read): the off text needs it beside
  // reason 'off' (round 5, 2; the medium review of round 5, 7)
  if (typeof(deps.storedOff) !== 'function') {
    deps.storedOff = (name) => {
      const raw = JSON.parse(require('fs').readFileSync(require('./cli-options').settingsFile, 'utf8'));
      const values = raw != null && typeof(raw) === 'object' ? raw.values : null;
      return values != null && typeof(values) === 'object' && Object.hasOwn(values, `enabled.${name}`) && values[`enabled.${name}`] === false;
    };
  }
  if (typeof(deps.settingsServed) !== 'function') {
    deps.settingsServed = () => { const o = require('./cli-options'); return o.settingsTool === true && o.settingsFile != null; };
  }
  const {notices} = deps;
  const shared = () => deps.shared() === true;
  const mip = require('./modules-in-place');
  // A text, once to every open session of a shared runtime; otherwise the
  // runtime's own notice (one helper: lib/modules-in-place.js)
  // (own: the runtime's own off text, in a lane nothing else evicts; long:
  // the runtime's own caller line, its bound kept so the way back is whole)
  // (about: the module the text names, so a session opening while it is hidden is not given it)
  const toEveryone = (module, text, {own = false, long = false, about = null, clears = false} = {}) => mip.tellEverySession(module, text,
    Object.assign({notices, shared, about, clears}, own ? {own: true} : long ? {max: notices.OWN_NOTICE_MAX} : {}));
  // its shape checked before anything is loaded (#429's high review, 5), on
  // any runtime: the module form is the only one (M6). Once, here, by the
  // rule of the handler it reached (its own type field never chooses the
  // rule; #455's high review, 4): lib/modules-in-place.js reads what is
  // checked here.
  const checked = (type, msg) => {
    const problem = mip.moduleMessageProblem(type, msg);
    if (problem != null) throw refusal(problem.message);
  };

  const loadOrReload = (fn, type) => async(msg) => {
    checked(type, msg);
    const {modules} = await fn(deps.mm, msg, deps.dm);
    // a module-form reload names its modules in names (#427's high review,
    // 1): its notice is filed under each, so a client of any of them hears it
    const about = type === 'reload' ? msg.names : [msg.name];
    // (a module loaded again: what was kept about it is no longer true)
    if (typeof(msg.notice) === 'string') for (const m of about) toEveryone(m, msg.notice, {about: m, clears: true});
    return {tools: await deps.toolsOf(modules)};
  };

  async function unload(msg) {
    checked('unload', msg);
    // Every unload is told once, in its own text, on the next result of any
    // tool; never held back, never silenced (the settings tool tells only the
    // asker, so nothing here is a duplicate). Reason 'off', ch-local's own
    // and explicit: the full off text, with the callers loaded before this
    // unload and the way back (#449's high review, round 4, the cut)
    let offText = null;
    let ownLane = false;
    try {
      // (reason 'off' and the settings holding it off, both: a ceiling's
      // unload, or a stale reason, never gets the way back)
      if (msg.reason === 'off' && deps.settingsServed() === true && deps.storedOff(msg.name) === true) {
        // (the manager this unload acts on: the same one the settings tool
        // is given, lib/route-manager.js)
        const tops = typeof(deps.loadedTops) === 'function' ? deps.loadedTops() : mip.loadedTops(deps.mm);
        const st = require('./settings-tool');
        offText = st.offNotice(msg.name, st.callersIn(msg.name, tops));
        ownLane = true;
      }
      // a caller unloaded with the module it went with, explicit (reason
      // 'calls', because: that module) and held off by the settings: its own
      // line, with the way back (round 5, 6)
      else if (msg.reason === 'calls' && typeof(msg.because) === 'string' && require('./remote/credentials').isPackage(msg.because)
        && deps.settingsServed() === true && deps.storedOff(msg.because) === true) {
        offText = require('./settings-tool').callsNotice(msg.name, msg.because);
      }
    } catch (err) { offText = null; /* the message's own words */ }
    const {modules} = await deps.packs.unloadPack(deps.mm, msg, deps.dm);
    // a shared runtime's sessions are each told, in the message's words or
    // the plain ones; the runtime's own, only in the message's
    const ownText = (typeof(msg.notice) === 'string') ? msg.notice
      : shared() ? `the ${msg.name} tools were turned off` : null;
    const text = offText != null ? offText : ownText;
    // (under no module: the unloaded module's tools are gone, so its notice
    // goes on the next result of any tool, and nothing is left for a later
    // turn-on to deliver: round 5, 1)
    // (the off text alone in the own lane: the callers' lines, however many,
    // never evict it; the medium review of round 6, 1)
    if (text != null) toEveryone(null, text, {own: ownLane, long: offText != null, about: msg.name});
    return {tools: await deps.toolsOf(modules)};
  }

  async function notice(msg) {
    checked('notice', msg);
    const module = (typeof(msg.module) === 'string') ? msg.module : null;
    toEveryone(module, msg.text, {about: module});
    return {};
  }

  // set {name, value}: the settings' (applyControlSet)
  async function set(msg) {
    if (typeof(deps.applyControlSet) === 'function') return deps.applyControlSet(msg);
    throw Object.assign(new Error(`${String(msg != null ? msg.name : '').slice(0, 40)} was not applied`), {code: 'CONTROL_FAILED'});
  }

  return {load: loadOrReload(deps.packs.loadPack, 'load'), reload: loadOrReload(deps.packs.reloadPack, 'reload'), unload, notice, set};
}

module.exports = {createModuleControl};
