'use strict';
// A per-session module's workers on the shared runtime (R1; #236 section
// 4a): one per (module, session), spawned on that session's first call into
// the module. Main thread only. How a worker is spawned and ended is the
// module manager's (create's spawn and end); this keeps which ones run, the
// cap, and what each session is told.
//
// - The cap (--maxSessionWorkers) counts every one, spawning ones included,
//   across every module and session. At the cap the least recently used one
//   that is idle gives up its slot: no call in flight and no live token
//   issued to it (a hop's, a job's, a peer channel's: `busy`). It is never
//   taken mid-call. With none idle the call is refused SESSION_WORKERS_BUSY
//   (retryable); nothing is queued.
// - A crash frees its slot at once; the call it was running is answered by
//   the worker's own drain (its exit). It isn't restarted: that session's
//   next call spawns a fresh one. Its session is told, as an evicted one's
//   is, that the module's in-memory state was reset and its files kept.
//   SUSPEND_AFTER exits within WINDOW_MS (the module supervisor's rule)
//   suspend that (module, session) alone until the module is reloaded,
//   restarted or unloaded, or the session ends.
// - stopModule (an unload or reload) refuses new spawns of the module while
//   its workers stop, and a spawn that was under way when it began is
//   stopped once its worker is up (`wanted`), so no worker outlives its
//   module (the Reviewer's P4).
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const {SUSPEND_AFTER, WINDOW_MS} = require('./module-supervisor');

const keyOf = (name, sid) => `${name}\0${sid}`;
const RESET_TEXT = (name) => `${name}'s in-memory state was reset; its files were kept`;

// spawn(name, sid, wanted() -> boolean, cb(err, wm)): a worker for the
//   module, its session's partition its /data and /tmp; wanted() is false
//   once the spawn was given up on (it ends the worker then)
// end(wm) -> Promise: the worker ended (resolves when it has exited)
// onExit(wm, fn): fn once when the worker exits, for whatever reason
// busy(wm) -> boolean: a call in flight or a live token issued to it
// announce(name, sid, text): said to that session alone
// max() -> the cap, read at each use
function create({spawn, end, onExit, busy, announce, max, now = Date.now}) {
  const entries = new Map();     // key -> {name, sid, wm, waiters, lastUsed, stopping}
  const exits = new Map();       // key -> [times]
  const closing = new Set();     // module names being stopped

  const suspended = (k) => {
    const t = (exits.get(k) || []).filter((x) => now() - x < WINDOW_MS);
    if (t.length === 0) exits.delete(k); else exits.set(k, t);
    return t.length >= SUSPEND_AFTER;
  };
  const fail = (waiters, err) => { for (const cb of waiters) cb(err); };

  function stopEntry(e) {
    e.stopping = true;
    if (entries.get(keyOf(e.name, e.sid)) === e) entries.delete(keyOf(e.name, e.sid));
    return (e.wm != null) ? Promise.resolve(end(e.wm)).catch(() => {}) : Promise.resolve();
  }

  // the least recently used idle one, or null
  function idlest() {
    let best = null;
    for (const e of entries.values()) {
      if (e.wm == null || e.stopping || busy(e.wm)) continue;
      if (best == null || e.lastUsed < best.lastUsed) best = e;
    }
    return best;
  }

  function get(name, sid, cb) {
    const k = keyOf(name, sid);
    if (closing.has(name)) return cb(new CountinghouseError('MODULE_UNLOADED'));
    const e = entries.get(k);
    if (e != null) {
      e.lastUsed = now();
      if (e.wm != null) return cb(null, e.wm);
      e.waiters.push(cb);
      return;
    }
    if (suspended(k)) return cb(new CountinghouseError('MODULE_SUSPENDED'));
    if (entries.size >= max()) {
      const victim = idlest();
      if (victim == null) return cb(CountinghouseError.withFields('SESSION_WORKERS_BUSY', {max: max()}));
      stopEntry(victim);
      announce(victim.name, victim.sid, RESET_TEXT(victim.name));
    }
    const entry = {name, sid, wm: null, waiters: [cb], lastUsed: now(), stopping: false};
    entries.set(k, entry);
    const wanted = () => !entry.stopping && entries.get(k) === entry && !closing.has(name);
    spawn(name, sid, wanted, (err, wm) => {
      const waiters = entry.waiters;
      entry.waiters = [];
      if (err != null || wm == null) {
        if (entries.get(k) === entry) entries.delete(k);
        return fail(waiters, err || new CountinghouseError('MODULE_UNLOADED'));
      }
      if (!wanted()) {
        // given up on while it came up (an unload, the session's end)
        Promise.resolve(end(wm)).catch(() => {});
        return fail(waiters, new CountinghouseError('MODULE_UNLOADED'));
      }
      entry.wm = wm;
      onExit(wm, () => {
        if (entry.stopping || entries.get(k) !== entry) return;
        // a crash: its slot is free now, and its session is told
        entries.delete(k);
        exits.set(k, (exits.get(k) || []).concat([now()]));
        announce(name, sid, RESET_TEXT(name));
      });
      for (const w of waiters) w(null, wm);
    });
  }

  function stop(name, sid) {
    const e = entries.get(keyOf(name, sid));
    return (e != null) ? stopEntry(e) : Promise.resolve();
  }

  // the session's end: its workers stop, and its exits are forgotten
  function stopSession(sid) {
    const all = [...entries.values()].filter((e) => e.sid === sid).map(stopEntry);
    for (const k of [...exits.keys()]) if (k.endsWith(`\0${sid}`)) exits.delete(k);
    return Promise.all(all).then(() => {});
  }

  // an unload or reload: every session's worker of the module, none started
  // meanwhile
  async function stopModule(name) {
    closing.add(name);
    try {
      await Promise.all([...entries.values()].filter((e) => e.name === name).map(stopEntry));
      for (const k of [...exits.keys()]) if (k.startsWith(`${name}\0`)) exits.delete(k);
    } finally {
      closing.delete(name);
    }
  }

  // the module's live workers, for a listing or a test
  function workersOf(name) {
    return [...entries.values()].filter((e) => e.name === name && e.wm != null).map((e) => ({sid: e.sid, wm: e.wm}));
  }

  // every live one, for a view change (B3's session packs)
  function all() {
    return [...entries.values()].filter((e) => e.wm != null).map((e) => ({name: e.name, sid: e.sid, wm: e.wm}));
  }

  return {get, stop, stopSession, stopModule, workersOf, all, inFlight: (wm) => busy(wm), size: () => entries.size, RESET_TEXT};
}

module.exports = {create, RESET_TEXT};
