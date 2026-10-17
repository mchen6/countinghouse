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

module.exports = {ModuleLifecycle};
