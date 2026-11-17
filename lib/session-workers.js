'use strict';
// A per-session module's workers on the shared runtime (R1; #236 section
// 4a): one per (module, session), spawned on that session's first call into
// the module. Main thread only. How a worker is spawned and ended is the
// module manager's (create's spawn and end); this keeps which ones run, the
// cap, and what each session is told.
//
// - The cap (--maxSessionWorkers) counts every worker that is spawning,
//   running or still ending, across every module and session, so no more
//   than the cap are ever alive at once. At the cap the least recently used
//   one that is idle gives up its slot: no call in flight and no live token
//   issued to it (a hop's, a job's: `busy`). It is never taken mid-call, and
//   the call that needed its slot starts its own worker only once that one
//   has ended. With none idle the call is refused SESSION_WORKERS_BUSY
//   (retryable); nothing is queued.
// - A crash frees its slot at once; the call it was running is answered by
//   the worker's own drain (its exit). It isn't restarted: that session's
//   next call spawns a fresh one. Its session is told, as an evicted one's
//   is, that the module's in-memory state was reset and its files kept.
//   SUSPEND_AFTER exits within WINDOW_MS (the module supervisor's rule)
//   pause that (module, session) alone until the window has passed (or the
//   module is reloaded, restarted or unloaded, or the session ends).
// - Stopping (stop, stopSession, stopModule) settles only once every worker
//   it stops has ended, one still spawning included: a spawn under way when
//   the stop began is ended as soon as its worker is up (`wanted`), and the
//   stop waits for that. stopModule refuses new spawns of the module
//   meanwhile, so no worker outlives its module (the Reviewer's P4).
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const {SUSPEND_AFTER, WINDOW_MS} = require('./module-supervisor');

const keyOf = (name, sid) => `${name}\0${sid}`;
// how many ended sessions the pool remembers, to refuse their spawns. Enough:
// workerFor (lib/device-manager.js) already refuses a session that isn't
// live, so this set only covers the race window between a session's end and
// that check (a job's run already past it)
const ENDED_KEPT = 4096;
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
  const entries = new Map();     // key -> {name, sid, wm, waiters, lastUsed, stopping, settled, settle}: spawning or running
  const endedSessions = new Set();   // sids whose end stopped their workers (stopSession)
  const ending = new Set();      // entries stopped whose worker hasn't ended yet: they keep their slot
  const exits = new Map();       // key -> [times]
  const closing = new Set();     // module names being stopped

  const occupied = () => entries.size + ending.size;
  const suspended = (k) => {
    const t = (exits.get(k) || []).filter((x) => now() - x < WINDOW_MS);
    if (t.length === 0) exits.delete(k); else exits.set(k, t);
    return t.length >= SUSPEND_AFTER;
  };
  const fail = (waiters, err) => { for (const cb of waiters) cb(err); };
  const gone = () => new CountinghouseError('MODULE_UNLOADED');

  // An entry is done once its worker has ended (or none came up): its slot
  // is free, and whoever waits on its stop goes on.
  function done(e) {
    ending.delete(e);
    if (entries.get(keyOf(e.name, e.sid)) === e) entries.delete(keyOf(e.name, e.sid));
    e.settle();
  }

  // -> Promise, settled once the entry's worker has ended. A running worker
  // is ended now; a spawning one by its spawn's callback once it is up.
  function stopEntry(e) {
    if (e.stopping) return e.settled;
    e.stopping = true;
    if (entries.get(keyOf(e.name, e.sid)) === e) entries.delete(keyOf(e.name, e.sid));
    ending.add(e);
    if (e.wm != null) Promise.resolve(end(e.wm)).catch(() => {}).then(() => done(e));
    return e.settled;
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
    if (endedSessions.has(sid)) return cb(new CountinghouseError('DEVICE_NOT_FOUND'));
    if (closing.has(name)) return cb(gone());
    const e = entries.get(k);
    if (e != null) {
      e.lastUsed = now();
      if (e.wm != null) return cb(null, e.wm);
      e.waiters.push(cb);
      return;
    }
    if (suspended(k)) return cb(CountinghouseError.withFields('MODULE_SESSION_PAUSED', {module: name, minutes: Math.round(WINDOW_MS / 60000)}));
    // at the cap: an idle worker's slot, taken only once it has ended
    let freed = Promise.resolve();
    if (occupied() >= max()) {
      const victim = idlest();
      if (victim == null) return cb(CountinghouseError.withFields('SESSION_WORKERS_BUSY', {max: max()}));
      freed = stopEntry(victim);
      announce(victim.name, victim.sid, RESET_TEXT(victim.name));
    }
    const entry = {name, sid, wm: null, waiters: [cb], lastUsed: now(), stopping: false};
    entry.settled = new Promise((resolve) => { entry.settle = resolve; });
    entries.set(k, entry);
    const wanted = () => !entry.stopping && entries.get(k) === entry && !closing.has(name);
    freed.then(() => {
      if (!wanted()) {
        const waiters = entry.waiters;
        entry.waiters = [];
        done(entry);
        return fail(waiters, gone());
      }
      spawn(name, sid, wanted, (err, wm) => {
        const waiters = entry.waiters;
        entry.waiters = [];
        if (!wanted()) {
          // given up on while it came up (an unload, a stop, the session's
          // end): the worker, if any, is ended, and only then is it done
          fail(waiters, gone());
          if (wm == null) return done(entry);
          return Promise.resolve(end(wm)).catch(() => {}).then(() => done(entry));
        }
        if (err != null || wm == null) {
          done(entry);
          return fail(waiters, err || gone());
        }
        entry.wm = wm;
        onExit(wm, () => {
          if (entry.stopping) return;
          // a crash: its slot is free now, and its session is told
          done(entry);
          exits.set(k, (exits.get(k) || []).concat([now()]));
          announce(name, sid, RESET_TEXT(name));
        });
        for (const w of waiters) w(null, wm);
      });
    });
  }

  function stop(name, sid) {
    const e = entries.get(keyOf(name, sid));
    return (e != null) ? stopEntry(e).then(() => {}) : Promise.resolve();
  }

  // the session's end: its workers stop, and its exits are forgotten; and
  // no worker is spawned for it afterwards (a job's run that raced its end:
  // a device not hosted), so nothing writes to its partition while it is
  // measured and removed (lib/session-lifetime.js). Remembered for the last
  // ENDED_KEPT ended sessions.
  function stopSession(sid) {
    endedSessions.add(sid);
    if (endedSessions.size > ENDED_KEPT) endedSessions.delete(endedSessions.values().next().value);
    const all = [...entries.values()].filter((e) => e.sid === sid).map(stopEntry)
      .concat([...ending].filter((e) => e.sid === sid).map((e) => e.settled));
    for (const k of [...exits.keys()]) if (k.endsWith(`\0${sid}`)) exits.delete(k);
    return Promise.all(all).then(() => {});
  }

  // an unload or reload: every session's worker of the module, those still
  // spawning or ending included; none started meanwhile
  async function stopModule(name) {
    closing.add(name);
    try {
      await Promise.all([...entries.values()].filter((e) => e.name === name).map(stopEntry)
        .concat([...ending].filter((e) => e.name === name).map((e) => e.settled)));
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

  return {get, stop, stopSession, stopModule, workersOf, all, inFlight: (wm) => busy(wm), size: occupied, RESET_TEXT};
}

module.exports = {create, RESET_TEXT};
