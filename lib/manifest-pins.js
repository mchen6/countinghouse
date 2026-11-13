// R2-1 Task 4 (spec section 4, "Where the declarations come from"): the main
// thread's copy of each module's package.json. Its countinghouse.calls are
// the declarations the main thread enforces, so it is read before any of the
// module's code runs: when a worker is spawned for the module, or, when the
// operator validates the module first, before that validation (which runs
// the module's code), and that copy is then the one the next operator load
// of the same path takes.
//
// What holds the file afterwards depends on the mode. Under enforce the file
// broker refuses every write to it and the module reaches nothing outside its
// namespace, so the declaration holds. Under audit the broker refuses writes
// to it by any name it sees, but routes it does not see remain (a rename of
// an ancestor directory, a child process, both report-only there); under off
// nothing stops a write. So the pin raises the bar and every change is
// recorded: each re-pin -- an operator's load, reload or restart, a supervised
// restart, a server restart -- is compared with the module's previous pin,
// and each call added since is logged as an error, in full, saying whether it
// was adopted. An operator's action adopts what the file says (or the copy
// read before its validation); a supervised restart keeps the previous pin.
//
// The pin covers countinghouse.calls only. Permissions and remotes are read
// from disk again at every spawn, a supervised restart's included.
//
// The previous pin outlives the server as a record of its calls alone, under
// <moduleDataPath>/.pins (a name no module's data directory can have).
const fs = require('fs');
const path = require('path');

// Validations whose copy is still waiting for its load; the oldest goes.
const MAX_VALIDATION_PINS = 64;
// Added calls logged per re-pin; each one in full, the rest counted.
const MAX_LOGGED = 64;

function callsOf(pkg) {
  const c = (pkg != null && pkg.countinghouse != null && Array.isArray(pkg.countinghouse.calls)) ? pkg.countinghouse.calls : [];
  return c.map((x) => (typeof(x) === 'string' ? x : JSON.stringify(x)));
}

const addedTo = (before, after) => {
  const had = new Set(before);
  return after.filter((c) => !had.has(c));
};

// One path, however it was named.
function keyOf(modulePath) {
  const resolved = path.resolve(String(modulePath));
  try { return fs.realpathSync(resolved); } catch (e) { return resolved; }
}

const RECORD_DIR = '.pins';
const recordFile = (dir, name) => path.join(dir, `${encodeURIComponent(name)}.json`);

// What the file broker refuses to every write of module `name`'s worker
// under audit and enforce (lib/fs-broker/index.js): its package.json, and its
// own pin record and the record directory, so a write the broker sees can
// neither widen the declarations nor erase the trail of a widening.
function guardedPaths(modulePath, name, moduleDataPath) {
  const dir = path.join(moduleDataPath, RECORD_DIR);
  return [path.join(modulePath, 'package.json'), recordFile(dir, name), dir];
}

const sameCalls = (a, b) => a != null && b != null && a.length === b.length && a.every((c, i) => c === b[i]);

class ManifestPins {
  // recordDir: () => the directory of the records; log: (line) => void, an error line
  constructor({recordDir, log}) {
    this.recordDir = recordDir;
    this.log = log;
    this.pinned = new Map();       // module name -> the package.json pinned for it (null: unreadable)
    this.baseline = new Map();     // module name -> the calls of its last readable pin
    this.validated = new Map();    // module path -> the package.json read before its validation
  }

  // The file as the main thread reads it; null when it cannot be, logged
  // unless quiet. A parse error's message can quote the file, so only its
  // kind is logged.
  read(modulePath, name, quiet) {
    try {
      return JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json'), 'utf8'));
    } catch (e) {
      if (quiet !== true) {
        this.log(`module sandbox: ${name}: its package.json could not be read on the main thread ` +
          `(${e.code != null ? e.code : 'not valid JSON'}); no declarations are taken from it`);
      }
      return null;
    }
  }

  // Before a validation runs the module's code. A file that cannot be read
  // carries nothing: the load reads it then (the validation reports it).
  // Validating again replaces the copy, so an operator who edits the file
  // after validating validates again (or reloads after the load).
  forValidation(modulePath) {
    const key = keyOf(modulePath);
    this.validated.delete(key);
    const pkg = this.read(key, null, true);
    if (pkg == null) return;
    if (this.validated.size >= MAX_VALIDATION_PINS) this.validated.delete(this.validated.keys().next().value);
    this.validated.set(key, pkg);
  }

  // Before a worker for module `name` starts; operator: an operator's load,
  // reload or restart (otherwise a supervised restart). Returns the pin.
  pin(name, modulePath, operator) {
    const onDisk = this.read(modulePath, name);
    const key = keyOf(modulePath);
    const had = this.pinned.has(name);
    let pinned = onDisk;
    let kept = null;
    if (had && operator !== true) {
      pinned = this.pinned.get(name);
      kept = 'not adopted: the pin from the last operator action stays';
    } else if (operator === true && this.validated.has(key)) {
      pinned = this.validated.get(key);
      this.validated.delete(key);
      kept = 'not adopted: the copy read before its validation stays';
    }
    const calls = callsOf(pinned);
    if (kept != null) this.report(name, addedTo(calls, callsOf(onDisk)), kept);
    this.pinned.set(name, pinned);
    // An unreadable file pins no declarations and leaves the baseline: the
    // next readable pin compares with the last readable one.
    if (pinned == null) return null;
    const previous = this.baseline.has(name) ? this.baseline.get(name) : this.recorded(name);
    if (previous != null) this.report(name, addedTo(previous, calls), 'adopted');
    if (!sameCalls(previous, calls)) this.record(name, calls);
    this.baseline.set(name, calls);
    return pinned;
  }

  report(name, calls, how) {
    calls.slice(0, MAX_LOGGED).forEach((c) =>
      this.log(`module sandbox: ${name} declared call added since its last pin: ${JSON.stringify(c)} (${how})`));
    if (calls.length > MAX_LOGGED) this.log(`module sandbox: ${name}: ${calls.length - MAX_LOGGED} more added calls not shown (${how})`);
  }

  file(name) {
    return recordFile(this.recordDir(), name);
  }

  // The calls of the pin an earlier server recorded, or null.
  recorded(name) {
    try {
      const r = JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
      return Array.isArray(r.calls) ? r.calls.map(String) : null;
    } catch (e) {
      return null;
    }
  }

  record(name, calls) {
    const file = this.file(name);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
      fs.writeFileSync(tmp, JSON.stringify({calls: calls}), {mode: 0o600});
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* nothing written */ }
      this.log(`module sandbox: ${name}: its declarations' record could not be written (${e.code != null ? e.code : e.message}); ` +
        'a server restart will not compare with this pin');
    }
  }
}

module.exports = {ManifestPins, callsOf, guardedPaths, RECORD_DIR};
