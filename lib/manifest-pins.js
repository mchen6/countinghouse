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
// to it by any name it sees, and to every directory above it (so none is
// renamed away and back), but routes it does not see remain (a child process
// or a worker thread, report-only there); under off
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
// <moduleDataPath>/.pins (a name no module's data directory can have), which
// the file broker refuses to every module's write under audit and enforce.
// A copy read before a validation is recorded too when the module has no
// record yet, so a server restart between the validation and the load still
// compares with it. Under audit a module that uses child_process or
// worker_threads (report-only there, and that use is logged) can still change
// its package.json and the records; only enforce holds the declarations.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Validations whose copy is still waiting for its load; the oldest goes.
const MAX_VALIDATION_PINS = 64;
// Added calls logged per re-pin, the rest counted; each call capped.
const MAX_LOGGED = 16;
const MAX_CALL_CHARS = 256;

function callsOf(pkg) {
  const c = (pkg != null && pkg.countinghouse != null && Array.isArray(pkg.countinghouse.calls)) ? pkg.countinghouse.calls : [];
  return c.map((x) => (typeof(x) === 'string' ? x : JSON.stringify(x)));
}

const addedTo = (before, after) => {
  const had = new Set(before);
  return after.filter((c) => !had.has(c));
};

const shown = (c) => JSON.stringify(c.length > MAX_CALL_CHARS ? `${c.slice(0, MAX_CALL_CHARS)}…` : c);

const RECORD_DIR = '.pins';
const recordFile = (dir, name) => path.join(dir, `${encodeURIComponent(name)}.json`);

const sameCalls = (a, b) => a != null && b != null && a.length === b.length && a.every((c, i) => c === b[i]);

// The keys a validation's copy is found by: the module path as named (not
// its real path: the root can be swapped for a link to a staged directory
// while the module validates), and the package name.
const pathKey = (modulePath) => `path:${path.resolve(String(modulePath))}`;
const nameKey = (name) => `name:${name}`;

class ManifestPins {
  // recordDir: () => the directory of the records; log: (line) => void, an error line
  constructor({recordDir, log}) {
    this.recordDir = recordDir;
    this.log = log;
    this.pinned = new Map();       // module name -> the package.json pinned for it (null: unreadable)
    this.baseline = new Map();     // module name -> the calls of its last readable pin
    this.validated = new Map();    // pathKey / nameKey -> {pkg, keys}: the copy read before a validation
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

  // What the next pin of `name` compares with: its last readable pin, or the
  // record an earlier server (or a validation) left.
  previousOf(name) {
    return this.baseline.has(name) ? this.baseline.get(name) : this.recorded(name);
  }

  // Before a validation runs the module's code. A file that cannot be read
  // carries nothing: the load reads it then (the validation reports it).
  // Validating again replaces the copy, so an operator who edits the file
  // after validating validates again (or reloads after the load); each call
  // the new copy adds to the earlier copy, or to the record, is logged.
  forValidation(modulePath) {
    const pkg = this.read(modulePath, null, true);
    if (pkg == null) return;
    const name = (typeof(pkg.name) === 'string' && pkg.name !== '') ? pkg.name : null;
    const label = (name != null) ? name : path.basename(path.resolve(String(modulePath)));
    const calls = callsOf(pkg);
    const earlier = this.validated.get(pathKey(modulePath)) || ((name != null) ? this.validated.get(nameKey(name)) : undefined);
    const before = (earlier != null) ? callsOf(earlier.pkg) : ((name != null) ? this.previousOf(name) : null);
    if (before != null) this.report(label, addedTo(before, calls), 'found at its validation');
    // A module not pinned on this server: its record becomes this copy, so a
    // restart before the load compares with what was validated last, not
    // with a wider version validated earlier and never loaded. A module
    // pinned here keeps its record: the pin's.
    if (name != null && !this.pinned.has(name)) this.record(name, calls);
    const entry = {pkg: pkg, keys: [pathKey(modulePath)].concat((name != null) ? [nameKey(name)] : [])};
    // an earlier copy under either key is replaced; the oldest copy goes
    // when there are MAX_VALIDATION_PINS
    entry.keys.forEach((k) => { if (this.validated.has(k)) this.drop(this.validated.get(k)); });
    const copies = new Set(this.validated.values());
    if (copies.size >= MAX_VALIDATION_PINS) this.drop(copies.values().next().value);
    entry.keys.forEach((k) => this.validated.set(k, entry));
  }

  drop(entry) {
    entry.keys.forEach((k) => { if (this.validated.get(k) === entry) this.validated.delete(k); });
  }

  // Before a worker for module `name` starts; operator: an operator's load,
  // reload or restart (otherwise a supervised restart). Returns the pin.
  pin(name, modulePath, operator) {
    const onDisk = this.read(modulePath, name);
    const had = this.pinned.has(name);
    const byPath = this.validated.get(pathKey(modulePath));
    const carried = (byPath != null) ? byPath : this.validated.get(nameKey(name));
    let pinned = onDisk;
    let kept = null;
    if (had && operator !== true) {
      pinned = this.pinned.get(name);
      kept = 'not adopted: the pin from the last operator action stays';
    } else if (operator === true && carried != null) {
      pinned = carried.pkg;
      this.drop(carried);
      kept = 'not adopted: the copy read before its validation stays';
      // Found by package name only, the copy is of another directory: only
      // the calls the file loaded also declares are pinned, and the rest are
      // said.
      if (byPath == null) {
        const loaded = new Set(callsOf(onDisk));
        const copy = callsOf(pinned);
        this.report(name, copy.filter((c) => !loaded.has(c)), 'not adopted: declared by the validation of another path, not by the file loaded');
        const countinghouse = Object.assign({}, pinned.countinghouse, {calls: copy.filter((c) => loaded.has(c))});
        pinned = Object.assign({}, pinned, {countinghouse: countinghouse});
      }
    }
    const calls = callsOf(pinned);
    if (kept != null) this.report(name, addedTo(calls, callsOf(onDisk)), kept);
    this.pinned.set(name, pinned);
    // An unreadable file pins no declarations and leaves the baseline: the
    // next readable pin compares with the last readable one.
    if (pinned == null) return null;
    const previous = this.previousOf(name);
    if (previous != null) this.report(name, addedTo(previous, calls), 'adopted');
    if (!sameCalls(previous, calls)) this.record(name, calls);
    this.baseline.set(name, calls);
    return pinned;
  }

  report(name, calls, how) {
    calls.slice(0, MAX_LOGGED).forEach((c) =>
      this.log(`module sandbox: ${name} declared call added since its last pin: ${shown(c)} (${how})`));
    if (calls.length > MAX_LOGGED) this.log(`module sandbox: ${name}: ${calls.length - MAX_LOGGED} more added calls not shown (${how})`);
  }

  file(name) {
    return recordFile(this.recordDir(), name);
  }

  // A record nothing vouches for counts as empty: every declared call is
  // then reported as added.
  untrusted(name, why) {
    this.log(`module sandbox: ${name}: its pin record is not trusted (${why}); every declared call is reported as added`);
    return [];
  }

  // The calls of the pin an earlier server recorded; null when there is
  // none. Read without following a link, and only from a regular file with
  // no other name, in a directory that is not a link.
  recorded(name) {
    const dir = this.recordDir();
    let st = null;
    try { st = fs.lstatSync(dir); } catch (e) { return (e.code === 'ENOENT') ? null : this.untrusted(name, e.code); }
    if (!st.isDirectory()) return this.untrusted(name, 'its directory is not a directory');
    let fd = null;
    try {
      fd = fs.openSync(this.file(name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (e) {
      return (e.code === 'ENOENT') ? null : this.untrusted(name, e.code === 'ELOOP' ? 'a link' : e.code);
    }
    try {
      const fst = fs.fstatSync(fd);
      if (!fst.isFile() || fst.nlink !== 1) return this.untrusted(name, 'not a regular file of its own');
      const r = JSON.parse(fs.readFileSync(fd, 'utf8'));
      return Array.isArray(r.calls) ? r.calls.map(String) : this.untrusted(name, 'no calls in it');
    } catch (e) {
      return this.untrusted(name, e.code != null ? e.code : 'not valid JSON');
    } finally {
      fs.closeSync(fd);
    }
  }

  // Written through a random temporary name created exclusively (never a
  // planted file or link), then renamed over the record, which replaces a
  // link rather than following it.
  record(name, calls) {
    const dir = this.recordDir();
    let tmp = null;
    try {
      fs.mkdirSync(dir, {recursive: true, mode: 0o700});
      if (!fs.lstatSync(dir).isDirectory()) throw Object.assign(new Error('the record directory is not a directory'), {code: 'ENOTDIR'});
      tmp = path.join(dir, `.${crypto.randomBytes(12).toString('hex')}.tmp`);
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeSync(fd, JSON.stringify({calls: calls})); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file(name));
      tmp = null;
    } catch (e) {
      if (tmp != null) { try { fs.unlinkSync(tmp); } catch (e2) { /* nothing written */ } }
      this.log(`module sandbox: ${name}: its declarations' record could not be written (${e.code != null ? e.code : e.message}); ` +
        'a server restart will not compare with this pin');
    }
  }
}

module.exports = {ManifestPins, callsOf, RECORD_DIR};
