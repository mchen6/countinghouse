// One lock per module name (spec section 3, "Worker end"; section 7). A
// spawn's critical section, from waiting for the previous broker to settle
// through the walk and the new broker, runs alone for its name, and so does
// uninstall's deletion. A tracked entry is the live worker of that name:
// settled resolves once the worker is gone and its broker idle.
class ModuleLifecycle {
  constructor() {
    this.chains = new Map();
    this.entries = new Map();
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
    entry.settled.then(() => { if (this.entries.get(name) === entry) this.entries.delete(name); });
  }

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
}

// Waits for a broker whose worker is gone to finish its operations, but not
// forever: an operation stuck in the host (a hung network read, a device that
// never answers) would otherwise lock the name out of every later spawn and
// uninstall. After the bound -- the bridge's 30 s deadline plus a margin --
// it logs what is still running and settles anyway; the cost is a late write
// landing in a fresh /tmp or a quota count a little off (review, plan 4 Task 4).
const IDLE_BOUND_MS = 35000;
function boundedIdle(broker, boundMs, log, name) {
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      log(`file broker: ${name} not idle after ${boundMs / 1000} s (${broker.inFlight} operations still running in the host); continuing`);
      resolve();
    }, boundMs);
    // Never keeps the process alive at shutdown (review, plan 4 Task 5).
    if (typeof(timer.unref) === 'function') timer.unref();
  });
  return Promise.race([broker.idle(), late]).then(() => clearTimeout(timer));
}

// What track() gets as `settled` for a module worker: once it exited, its
// bridge closed and its broker idle (bounded). Never rejects: a failing close
// is logged and settling continues, so a later spawn's await settled(name)
// cannot throw and track() always removes the entry (review, plan 4 Task 5).
function settleAfterExit(o) {
  return o.exited
    .then(() => o.closeBridge())
    .catch((e) => o.log(e && e.message ? e.message : String(e)))
    .then(() => boundedIdle(o.broker, o.boundMs != null ? o.boundMs : IDLE_BOUND_MS, o.log, o.name))
    .then(() => o.onSettled && o.onSettled(), (e) => o.log(String(e)));
}

module.exports = {ModuleLifecycle, boundedIdle, settleAfterExit, IDLE_BOUND_MS};
