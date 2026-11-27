'use strict';
// The local store's persisted maps (LM1, docs/superpowers/specs/
// 2026-11-11-local-mode-design.md section 1; plan 2026-11-11-lm1-store-and-
// identity.md, Task 3): plain JSON files under --storePath, written by
// temp-file-and-rename, pure JavaScript.
//
// Several runtime processes may share one --storePath (a developer with
// two agent terminals and an editor open runs three; reviewer's ruling,
// 2026-11-11). So no file is ever replaced whole from one process's view:
// every write takes the store lock (<storePath>/.lock), reads the file
// again, applies this process's dirty keys over it (a deletion too),
// writes a temp file, fsyncs it, renames it into place, fsyncs the
// directory, and releases the lock. The last write of a key wins; keys
// other processes wrote stay. A file is read when it is opened, after a
// write that had to wait for the lock, and on reload(); update(key, fn) is
// the read-modify-write for a value two processes may both change (a
// balance), done whole under the lock.
//
// The lock holds {pid, startMs, at}. It is stale, and taken over, when its
// process is gone, or when it carries this process's pid from an earlier
// start (a container's pid 1); an empty or unreadable lock, when it is
// older than any write takes (STALE_MS, by its file's age); a live holder's
// lock only past LIVE_STALE_MS (120 s), which no write reaches, so a slow
// live writer keeps it and a hung one cannot stop writes for good. Taking over is
// itself exclusive (<storePath>/.lock.takeover), and the stale lock is
// read again under it, so two processes never both hold the lock.
//
// A scheduled write never blocks the event loop: a busy lock reschedules
// it (backing off), and a failed write is retried the same way. flush() (an
// explicit call, close, and the flush at exit) waits for the lock
// synchronously, up to LOCK_WAIT_MS, and one that fails is rescheduled.
// update() waits without blocking, up to UPDATE_WAIT_MS: its caller (a
// metering charge) has nothing to fall back on, and a hold is I/O -- one
// read and one write with its fsync -- which on a loaded Windows runner
// reached 1.1 s, and on CI outlasted the old 2 s (B-storelock). Either wait
// ends: a holder that is gone is taken over at once, and a live one's lock
// only past LIVE_STALE_MS.
//
// A waiter is not starved (#150): a process that finds the lock busy and
// will wait announces itself (<storePath>/.lock.waiting, {pid, startMs,
// at}) unless another live waiter announced within ANNOUNCE_FRESH_MS, and
// every other process's attempt yields to that announcement, its holder's
// next one included, so the lock goes to the waiter at its next retry. The
// waiter renews its announcement as it retries (every ANNOUNCE_RENEW_MS),
// so it stays fresh through a long wait, and withdraws once it has the lock
// or gives up; an announcement older than ANNOUNCE_FRESH_MS (a waiter that
// stopped retrying), or a dead process's, is ignored. Best effort: a
// failure on the announcement file never fails a lock.
//
// On Windows a lock file another process is deleting (delete pending: a
// handle still open on it) refuses opens with EPERM until that handle
// closes. Taking or reading the lock then counts as busy, not as an error.
// A genuine permission error answers EPERM too, so the waits keep their
// deadline and then fail with that error and the lock's path, not as a
// held lock; the scheduled write, which has no deadline, logs it once and
// keeps retrying. Elsewhere EPERM is an error at once, as before.
//
// A write renames a new file over the old one, and on Windows that rename
// is refused (EPERM, or EBUSY for a sharing violation) while another
// process has the old file open: a reader without the lock (openJsonFile,
// reload(): a balance asked for, another runtime starting) holds it for as
// long as a read takes. update() tries a refused rename again as it waits
// for a busy lock -- without blocking, the lock released in between, the
// value read again each time, backing off -- up to UPDATE_WAIT_MS, then
// fails with the refusal's code, the file named and the wait said
// (R-win-ledger-rename: an update() that failed was a metering charge
// lost). A genuine permission error answers EPERM too, so it is told only
// at that deadline, as a refused lock's is at its own. The scheduled write
// tries any failed write again later; flush() (close, the exit flush) tries a
// refused rename again within its own wait for the lock, LOCK_WAIT_MS, the
// lock released between attempts, and reschedules what it still could not
// write (R-exit-flush-refused). A genuine permission error answers EPERM too,
// so it is told only at that wait's end, for each file the exit flushes.
//
// A file that does not parse is moved aside (<file>.corrupt-<ms>), logged:
// at open the map starts empty; during a write this process's whole map
// is written (a deep copy of it), and so it is when a write finds no file
// while the file this map moved aside is still there (a reload() found it
// corrupt, or an update() is trying a refused rename again); a reload()
// meanwhile keeps the map as it is. An update()'s fn is given a deep copy
// of the value, so it may change it, and run again, without changing the
// map's own objects (R-free-counter-double: a free call spent twice, the
// other keys dropped). Files are the owner's only (0600, the directory
// 0700).
const fs   = require('fs');
const path = require('path');

const LOCK_FILE = '.lock';
const TAKEOVER_FILE = '.lock.takeover';
const WAIT_FILE = '.lock.waiting';
const LOCK_WAIT_MS = 2000;
const UPDATE_WAIT_MS = 10000;
// an announcement is yielded to while this fresh; its waiter renews it
const ANNOUNCE_FRESH_MS = 2000;
const ANNOUNCE_RENEW_MS = 500;
const LOCK_RETRY_MS = 10;
const STALE_MS = 10000;
// a live holder's lock: taken over only past this (#301)
const LIVE_STALE_MS = 120000;
const RETRY_MIN_MS = 25;
const RETRY_MAX_MS = 1000;

const WIN = process.platform === 'win32';

// A busy attempt at the lock: refused is the EPERM that made it busy on
// Windows (delete pending), else null.
const busy = (refused = null) => ({busy: true, refused: refused});
const isBusy = (r) => r != null && r.busy === true;

// The one place a lock file's refusal is classified: fn's value as {value},
// or, for Windows' delete pending (see the header), {refused: e}; any other
// error is thrown.
function onLockFile(fn) {
  try {
    return {value: fn()};
  } catch (e) {
    if (WIN && e != null && e.code === 'EPERM') return {refused: e};
    throw e;
  }
}
const START_MS = Math.round(performance.timeOrigin);

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleeper, 0, 0, ms);
}

function warn(line) {
  try { require('../logger').W(line); } catch (logErr) { /* a bare process has no logger */ }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
}

// {raw, holder, ageMs} of a lock file, or null when there is none.
function readLock(lockFile) {
  let raw;
  let stat;
  try {
    raw = fs.readFileSync(lockFile, 'utf8');
    stat = fs.statSync(lockFile);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  let holder = null;
  try { holder = JSON.parse(raw); } catch (parseErr) { holder = null; }
  if (holder == null || typeof(holder) !== 'object' || typeof(holder.pid) !== 'number') holder = null;
  const at = (holder != null && typeof(holder.at) === 'number') ? holder.at : stat.mtimeMs;
  return {raw: raw, holder: holder, ageMs: Date.now() - at};
}

// Stale at once when its holder is gone (or is this pid from an earlier
// start); when no holder is readable, after STALE_MS (an empty or broken
// lock); and a live holder's only after LIVE_STALE_MS, far longer than any
// write here takes (milliseconds, and about a second at the worst measured,
// on a loaded Windows runner: B-storelock). So a live
// writer held up past STALE_MS (a slow fsync, a debugger, a long GC pause)
// keeps its lock while it writes, and a truly hung one still cannot stop
// the store's writes for good.
function isStale(lock) {
  if (lock.holder == null) return lock.ageMs > STALE_MS;   // being written just now: not stale until old
  if (lock.holder.pid === process.pid) return lock.holder.startMs !== START_MS;
  if (!alive(lock.holder.pid)) return true;
  return lock.ageMs > LIVE_STALE_MS;
}

// Removes a stale lock, exclusively: under <storePath>/.lock.takeover, the
// lock is read again and removed only if it is still the one found stale.
// A takeover lock left behind by a process that died is itself stale after
// STALE_MS.
// Returns null, or the Windows refusal that stopped it (onLockFile).
function takeOver(storePath, staleRaw) {
  const takeover = path.join(storePath, TAKEOVER_FILE);
  try {
    const made = onLockFile(() => fs.writeFileSync(takeover, String(process.pid), {flag: 'wx', mode: 0o600}));
    if (made.refused != null) return made.refused;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      if (Date.now() - fs.statSync(takeover).mtimeMs > STALE_MS) fs.unlinkSync(takeover);
    } catch (statErr) { /* gone already */ }
    return null;
  }
  try {
    const read = onLockFile(() => readLock(path.join(storePath, LOCK_FILE)));
    if (read.refused != null) return read.refused;
    const lock = read.value;
    if (lock == null || lock.raw !== staleRaw || !isStale(lock)) return null;
    // Gone already (released or taken over meanwhile) is what unlinking meant.
    try {
      const gone = onLockFile(() => fs.unlinkSync(path.join(storePath, LOCK_FILE)));
      return gone.refused != null ? gone.refused : null;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  } finally {
    try { fs.unlinkSync(takeover); } catch (unlinkErr) { /* gone already */ }
  }
}

// The announced waiter (#150), {pid, startMs, at}, or null.
function readWaiter(storePath) {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(storePath, WAIT_FILE), 'utf8'));
    return (w != null && typeof(w.pid) === 'number' && typeof(w.at) === 'number') ? w : null;
  } catch (e) {
    return null;
  }
}
const isMine = (w) => w != null && w.pid === process.pid && w.startMs === START_MS;
// Whether another process's announcement is one to yield to: fresh and
// alive. Fresh is dated within ANNOUNCE_FRESH_MS before now, never after it: one
// dated in the future (a clock stepped back since) is not fresh. `w` is the
// announcement already read, when the caller has it.
function waiterAhead(storePath, w = readWaiter(storePath)) {
  if (w == null || isMine(w)) return false;
  const age = Date.now() - w.at;
  return age >= 0 && age <= ANNOUNCE_FRESH_MS && alive(w.pid);
}
// Announces this process as the waiter, unless another one is ahead; its
// own announcement renewed once ANNOUNCE_RENEW_MS old (or dated in the
// future). Written to a temporary name and renamed over, so a reader never
// sees it half written.
function announce(storePath) {
  try {
    const w = readWaiter(storePath);
    if (isMine(w)) {
      const age = Date.now() - w.at;
      if (age >= 0 && age < ANNOUNCE_RENEW_MS) return;
    } else if (waiterAhead(storePath, w)) return;
    const file = path.join(storePath, WAIT_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({pid: process.pid, startMs: START_MS, at: Date.now()}), {mode: 0o600});
      fs.renameSync(tmp, file);
    } catch (e) {
      // (a rename over the announcement while another process reads it can
      // fail on Windows: the next retry, 10 ms on, renews it again)
      try { fs.unlinkSync(tmp); } catch (unlinkErr) { /* never made */ }
    }
  } catch (e) { /* best effort */ }
}
function withdraw(storePath) {
  try {
    if (isMine(readWaiter(storePath))) fs.unlinkSync(path.join(storePath, WAIT_FILE));
  } catch (e) { /* best effort */ }
}

// One attempt at the lock: a release function, or busy() (isBusy). Busy too
// while another process's announced wait is ahead (#150).

function tryLock(storePath) {
  ensureDir(storePath);
  if (waiterAhead(storePath)) return busy();
  const lockFile = path.join(storePath, LOCK_FILE);
  const mine = JSON.stringify({pid: process.pid, startMs: START_MS, at: Date.now()});
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const made = onLockFile(() => fs.writeFileSync(lockFile, mine, {flag: 'wx', mode: 0o600}));
      if (made.refused != null) return busy(made.refused);
      withdraw(storePath);
      return () => {
        try { if (fs.readFileSync(lockFile, 'utf8') === mine) fs.unlinkSync(lockFile); } catch (releaseErr) { /* gone */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const read = onLockFile(() => readLock(lockFile));
      if (read.refused != null) return busy(read.refused);
      const lock = read.value;
      if (lock == null) continue;                 // released meanwhile: try again
      if (!isStale(lock)) return busy();
      const refused = takeOver(storePath, lock.raw);
      if (refused != null) return busy(refused);
    }
  }
  return busy();
}

// The failure for a lock still busy when a wait ends. Refused on Windows:
// the refusal's own code, with the lock named, as a genuine permission error
// answers EPERM too. Else held: the holder named, or `otherwise` (update()'s
// own wording) when given.
function busyError(attempt, storePath, otherwise, waitMs = LOCK_WAIT_MS) {
  const lockFile = path.join(storePath, LOCK_FILE);
  if (attempt.refused != null) {
    return Object.assign(new Error(`${attempt.refused.message} (the store lock ${lockFile} was still refused after ${waitMs} ms)`),
      {code: attempt.refused.code, path: lockFile});
  }
  if (otherwise != null) return new Error(otherwise);
  const read = onLockFile(() => readLock(lockFile));
  const lock = read.value;
  // not held: this attempt yielded to another process's announced wait (#150)
  const w = readWaiter(storePath);
  if (lock == null && waiterAhead(storePath, w)) {
    return new Error(`the store lock ${lockFile} was yielded to a waiting process (pid ${w.pid}) for ${waitMs} ms`);
  }
  const pid = (lock != null && lock.holder != null) ? lock.holder.pid : 'unknown';
  return new Error(`the store lock ${lockFile} is held by pid ${pid}`);
}

// Runs fn while holding <storePath>/.lock, waiting for it up to
// LOCK_WAIT_MS (synchronously: for explicit flushes, the exit flush and the
// seeding command). Returns fn's value; withStoreLock.waited says whether
// it had to wait. A lock still busy after the wait fails with the holder
// named.
function withStoreLock(storePath, fn, waitMs = LOCK_WAIT_MS) {
  const deadline = Date.now() + waitMs;
  let waited = false;
  let release;
  try {
    release = tryLock(storePath);
    while (isBusy(release)) {
      if (Date.now() > deadline) throw busyError(release, storePath, undefined, waitMs);
      waited = true;
      announce(storePath);
      sleepSync(LOCK_RETRY_MS);
      release = tryLock(storePath);
    }
  } catch (e) {
    // every way out of the wait withdraws this process's announcement
    withdraw(storePath);
    throw e;
  }
  try {
    const value = fn();
    withStoreLock.waited = waited;
    return value;
  } finally {
    release();
  }
}

// {data, corrupt, missing, aside} of a file: {} when there is none
// (missing); a file that does not parse as a JSON object is moved aside
// and reported corrupt, aside the path it was moved to (null when another
// process moved it first).
function readMap(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {data: {}, corrupt: false, missing: true, aside: null};
    throw e;
  }
  try {
    const data = JSON.parse(raw);
    if (data != null && typeof(data) === 'object' && !Array.isArray(data)) return {data: data, corrupt: false, missing: false, aside: null};
  } catch (parseErr) { /* moved aside below */ }
  const aside = `${file}.corrupt-${Date.now()}`;
  let moved = true;
  try { fs.renameSync(file, aside); } catch (renameErr) { moved = false; /* another process moved it */ }
  warn(`local store: ${file} could not be read as a JSON object; moved aside to ${aside}`);
  return {data: {}, corrupt: true, missing: false, aside: moved ? aside : null};
}

// A rename refused on Windows while another process has the file open (see
// the header): update() tries it again.
const renameRefused = (e) => WIN && e != null && (e.code === 'EPERM' || e.code === 'EBUSY') && e.syscall === 'rename';

function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (unlinkErr) { /* never made */ }
    throw e;
  }
  // the rename is durable once the directory is (not possible on Windows)
  try {
    const dirFd = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (dirErr) { /* a platform that cannot fsync a directory */ }
}

// A key set as an own data property: `__proto__` is a key like any other
// (assigning obj['__proto__'] would set the prototype instead; review of
// B3). JSON.parse already makes it an own property, and JSON.stringify
// writes it.
function put(obj, key, value) {
  Object.defineProperty(obj, key, {value: value, enumerable: true, writable: true, configurable: true});
}

// A copy sharing no object with obj: a JSON round trip, which is what the
// file holds (an own `__proto__` key stays an own key: JSON.stringify
// writes it, JSON.parse makes it one).
function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

const open = new Set();

// openJsonFile(file, {debounceMs = 500, lockPath = dirname(file)}) ->
// {data, set(key, value), delete(key), update(key, fn, callback),
//  reload(), flush(), close()}.
function openJsonFile(file, opts) {
  const o = opts || {};
  const debounceMs = (o.debounceMs != null) ? o.debounceMs : 500;
  const lockPath = (o.lockPath != null) ? o.lockPath : path.dirname(file);
  ensureDir(path.dirname(file));
  const dirty = new Map();   // key -> {value} or {deleted: true}
  let timer = null;
  let retryMs = RETRY_MIN_MS;
  let refusalLogged = false;   // a Windows refusal of the lock, logged once (flushSoon)
  // where this map moved its corrupt file aside, while no file has been
  // read or written since (else null)
  let movedAside = null;

  function readOwn() {
    const read = readMap(file);
    if (read.corrupt) movedAside = read.aside;
    else if (!read.missing) movedAside = null;
    return read;
  }
  // no file, because this map moved it aside: the aside file is still there
  // (one removed since, as a whole store reset removes it, is a file gone)
  const goneAside = (read) => read.missing && movedAside != null && fs.existsSync(movedAside);

  // Under the lock: the file as it is now, this process's dirty keys over
  // it (a deep copy of its whole map when the file was corrupt, or is gone
  // aside since), written; the map takes the result.
  function writeLocked(extra) {
    const read = readOwn();
    const current = (read.corrupt || goneAside(read)) ? deepCopy(map.data) : read.data;
    for (const [key, change] of dirty) {
      if (change.deleted === true) delete current[key];
      else put(current, key, change.value);
    }
    const result = (extra != null) ? extra(current) : undefined;
    writeAtomic(file, current);
    movedAside = null;
    dirty.clear();
    map.data = current;
    return result;
  }

  function schedule(ms) {
    if (timer != null) return;
    timer = setTimeout(() => { timer = null; flushSoon(); }, ms);
    if (typeof(timer.unref) === 'function') timer.unref();
  }

  // The scheduled write: never waits for the lock; busy or failed, it is
  // tried again later, backing off. A lock refused on Windows is logged once
  // until a write lands, so a store the process cannot write says so.
  function flushSoon() {
    if (dirty.size === 0) return;
    let release;
    try {
      release = tryLock(lockPath);
    } catch (e) {
      release = busy();
      warn(`local store: ${file} not written (${e.message}); retrying`);
    }
    if (isBusy(release)) {
      if (release.refused != null && !refusalLogged) {
        refusalLogged = true;
        warn(`local store: ${file} not written yet (${release.refused.message}); retrying`);
      }
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      return schedule(retryMs);
    }
    try {
      writeLocked();
      refusalLogged = false;
      retryMs = RETRY_MIN_MS;
    } catch (e) {
      warn(`local store: ${file} not written (${e.message}); retrying`);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      schedule(retryMs);
    } finally {
      release();
    }
  }

  const map = {
    data: readOwn().data,
    set(key, value) {
      put(map.data, key, value);
      dirty.set(key, {value: value});
      schedule(debounceMs);
    },
    delete(key) {
      delete map.data[key];
      dirty.set(key, {deleted: true});
      schedule(debounceMs);
    },
    // Reads key's value as the file holds it now and stores fn(value), all
    // under the lock (with any dirty keys), so two processes changing one
    // value lose neither change; callback(err, newValue), called once the
    // lock is released. Waits for a busy lock without blocking the event
    // loop, up to UPDATE_WAIT_MS; a rename refused on Windows (see the
    // header) is tried again within the same wait, backing off, the value
    // read again each time -- so fn may run more than once for one change,
    // and must do nothing but compute its value (closure state its last run
    // sets is the stored one's). It is given a deep copy of the value, so
    // changing that in place changes nothing else.
    update(key, fn, callback) {
      const deadline = Date.now() + UPDATE_WAIT_MS;
      let refused = null;          // the last refused rename, if any
      let refusedMs = RETRY_MIN_MS;
      // (at the deadline: a refused rename is told as itself, with its code
      // and the store's file, though the last attempt found the lock busy)
      const refusal = () => Object.assign(new Error(`${refused.message} (the rename over ${file} was still refused at update()'s deadline, ${UPDATE_WAIT_MS} ms)`),
        {code: refused.code, path: file});
      const attempt = () => {
        let release;
        try { release = tryLock(lockPath); } catch (e) { withdraw(lockPath); return callback(e); }
        if (isBusy(release)) {
          if (Date.now() > deadline) {
            withdraw(lockPath);
            return callback(refused != null ? refusal() : busyError(release, lockPath, `the store lock under ${lockPath} stayed busy for ${UPDATE_WAIT_MS} ms`, UPDATE_WAIT_MS));
          }
          announce(lockPath);
          return setTimeout(attempt, LOCK_RETRY_MS);
        }
        let value;
        let failed = null;
        try {
          value = writeLocked((current) => {
            // (a copy: fn may change it, and may run again)
            const held = Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined;
            const next = fn(held === undefined ? undefined : deepCopy(held));
            put(current, key, next);
            return next;
          });
        } catch (e) {
          failed = e;
        } finally {
          release();
        }
        if (failed == null) return callback(null, value);
        if (!renameRefused(failed)) return callback(failed);
        refused = failed;
        if (Date.now() > deadline) return callback(refusal());
        // (each attempt writes the new file again: backing off, as the
        // scheduled write does, leaves the lock free between them)
        const wait = refusedMs;
        refusedMs = Math.min(refusedMs * 2, RETRY_MAX_MS);
        return setTimeout(attempt, wait);
      };
      attempt();
    },
    // The file as it is now, with this process's unwritten keys over it; the
    // map as it is while the file is corrupt, or gone aside since.
    reload() {
      const read = readOwn();
      if (read.corrupt || goneAside(read)) return;
      const data = read.data;
      for (const [key, change] of dirty) {
        if (change.deleted === true) delete data[key];
        else put(data, key, change.value);
      }
      map.data = data;
    },
    // Writes now (an explicit flush, close, exit), waiting for the lock up to
    // LOCK_WAIT_MS; a rename refused
    // on Windows (another process has the file open, see the header) is
    // tried again within that same wait, backing off, the lock released
    // between attempts (R-exit-flush-refused: at exit a rescheduled write is
    // lost). What it could not write is rescheduled, as before.
    flush() {
      if (timer != null) { clearTimeout(timer); timer = null; }
      if (dirty.size === 0) return;
      const deadline = Date.now() + LOCK_WAIT_MS;
      let refusedMs = RETRY_MIN_MS;
      for (;;) {
        try {
          withStoreLock(lockPath, () => writeLocked(), Math.max(0, deadline - Date.now()));
          return;
        } catch (e) {
          // (the whole wait is used: the last sleep is what is left of it)
          const left = deadline - Date.now();
          if (renameRefused(e) && left > 0) {
            sleepSync(Math.min(refusedMs, left));
            refusedMs = Math.min(refusedMs * 2, RETRY_MAX_MS);
            continue;
          }
          warn(`local store: ${file} not written (${e.message}); retrying`);
          schedule(retryMs);
          return;
        }
      }
    },
    close() {
      map.flush();
      if (timer != null) { clearTimeout(timer); timer = null; }
      // (closed, nothing retries it: said, never dropped silently)
      if (dirty.size > 0) warn(`local store: ${file} closed with ${dirty.size} change(s) not written`);
      open.delete(map);
    }
  };

  open.add(map);
  return map;
}

function flushAll() {
  for (const map of open) map.flush();
}

// Flushes every open file when the process exits, and on SIGINT and
// SIGTERM. Another handler of that signal decides how the process ends
// (framework's own end with process.exit, and flushAll runs again on
// 'exit', finding nothing dirty); with none, the signal is raised again so
// the process ends as it would have. Registered once.
let registered = false;
function flushAllOnExit() {
  if (registered) return;
  registered = true;
  process.once('exit', flushAll);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const onSignal = () => {
      flushAll();
      if (process.listenerCount(signal) === 1) {
        process.removeListener(signal, onSignal);
        process.kill(process.pid, signal);
      }
    };
    process.on(signal, onSignal);
  }
}

// busyError: the message a wait ends with, for a test that decides it
// without waiting (test/store/04).
module.exports = {openJsonFile, withStoreLock, flushAllOnExit, busyError};
