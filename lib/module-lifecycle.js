'use strict';
// One lock per module name (spec section 3, "Worker end"; section 7). A
// spawn's critical section, from waiting for the previous broker to settle
// through the walk and the new broker, runs alone for its name, and so does
// uninstall's deletion. A tracked entry is the live worker of that name:
// settled resolves once the worker is gone and its broker idle.
class ModuleLifecycle {
  constructor() {
    this.chains = new Map();
    this.entries = new Map();
    // names whose last tracked worker's broker was still busy past the bound
    // (settled false): kept until forgetLate, as the entry itself is dropped
    // at once (R1 Task 6: a session's end asks it)
    this.late = new Set();
  }

  run(name, fn) {
    const prev = this.chains.get(name) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.chains.set(name, tail);
    tail.then(() => { if (this.chains.get(name) === tail) this.chains.delete(name); });
    return next;
  }

  track(name, entry) {
    entry.hasExited = false;
    this.entries.set(name, entry);
    entry.exited.then(() => { entry.hasExited = true; });
    entry.settled.then((idle) => {
      if (idle === false) this.late.add(name);
      if (this.entries.get(name) === entry) this.entries.delete(name);
    });
  }

  // whether name's last worker's broker was still busy when its bound passed
  wentLate(name) { return this.late.has(name); }
  forgetLate(name) { this.late.delete(name); }

  // Live: tracked and not yet exited. An exited worker whose broker is still
  // settling is not live (review I5), but settled() still waits for it.
  live(name) {
    const e = this.entries.get(name);
    return (e != null && !e.hasExited) ? e : null;
  }

  settled(name) {
    const e = this.entries.get(name);
    return e == null ? Promise.resolve() : e.settled;
  }

  // R1: a per-session module's session workers are tracked under
  // name\0sid; these look at all of one module's at once (its uninstall)
  liveUnder(prefix) {
    for (const [k, e] of this.entries) if (k.startsWith(prefix) && !e.hasExited) return e;
    return null;
  }

  settledUnder(prefix) {
    return Promise.all([...this.entries].filter(([k]) => k.startsWith(prefix)).map(([, e]) => e.settled)).then(() => {});
  }
}

// Waits for a broker whose worker is gone to finish its operations, but not
// forever: an operation stuck in the host (a hung network read, a device that
// never answers) would otherwise lock the name out of every later spawn and
// uninstall. After the bound -- the bridge's 30 s deadline plus a margin --
// it logs what is still running and settles anyway; the cost is a late write
// landing in a fresh /tmp or a quota count a little off (review, plan 4 Task 4).
const IDLE_BOUND_MS = 35000;
// -> Promise of whether the broker went idle (false: the bound passed first)
function boundedIdle(broker, boundMs, log, name) {
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      log(`file broker: ${name} not idle after ${boundMs / 1000} s (${broker.inFlight} operations still running in the host); continuing`);
      resolve(false);
    }, boundMs);
    // Never keeps the process alive at shutdown (review, plan 4 Task 5).
    if (typeof(timer.unref) === 'function') timer.unref();
  });
  // (an idle() that fails says nothing about what is in flight: not idle)
  return Promise.race([broker.idle().then(() => true, () => false), late]).then((idle) => { clearTimeout(timer); return idle; });
}

// What track() gets as `settled` for a module worker: once it exited, its
// bridge closed and its broker idle (bounded); resolves to whether the broker
// went idle within the bound (R1 Task 6: a session's end keeps a partition
// whose broker didn't). Never rejects: a failing close
// is logged and settling continues, so a later spawn's await settled(name)
// cannot throw and track() always removes the entry (review, plan 4 Task 5).
function settleAfterExit(o) {
  return o.exited
    .then(() => o.closeBridge())
    .catch((e) => o.log(e && e.message ? e.message : String(e)))
    .then(() => boundedIdle(o.broker, o.boundMs != null ? o.boundMs : IDLE_BOUND_MS, o.log, o.name))
    .then((idle) => {
      if (o.onSettled) o.onSettled();
      return idle;
    }, (e) => {
      o.log(String(e));
      return false;
    });
}

module.exports = {ModuleLifecycle, boundedIdle, settleAfterExit, IDLE_BOUND_MS};
