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
// process is gone, when it carries this process's pid from an earlier
// start (a container's pid 1), or when it is older than any write takes
// (STALE_MS; an empty or unreadable lock by its file's age). Taking over is
// itself exclusive (<storePath>/.lock.takeover), and the stale lock is
// read again under it, so two processes never both hold the lock.
//
// A scheduled write never blocks the event loop: a busy lock reschedules
// it (backing off), and a failed write is retried the same way. Only
// flush() (an explicit call, close, and the flush at exit) waits for the
// lock, up to LOCK_WAIT_MS.
//
// A file that does not parse is moved aside (<file>.corrupt-<ms>), logged:
// at open the map starts empty; during a write this process's whole map
// is written. Files are the owner's only (0600, the directory 0700).
const fs   = require('fs');
const path = require('path');

const LOCK_FILE = '.lock';
const TAKEOVER_FILE = '.lock.takeover';
const LOCK_WAIT_MS = 2000;
const LOCK_RETRY_MS = 10;
const STALE_MS = 10000;
const RETRY_MIN_MS = 25;
const RETRY_MAX_MS = 1000;

const BUSY = Symbol('busy');
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

function isStale(lock) {
  if (lock.ageMs > STALE_MS) return true;
  if (lock.holder == null) return false;   // being written just now: not stale until old
  if (lock.holder.pid === process.pid) return lock.holder.startMs !== START_MS;
  return !alive(lock.holder.pid);
}

// Removes a stale lock, exclusively: under <storePath>/.lock.takeover, the
// lock is read again and removed only if it is still the one found stale.
// A takeover lock left behind by a process that died is itself stale after
// STALE_MS.
function takeOver(storePath, staleRaw) {
  const takeover = path.join(storePath, TAKEOVER_FILE);
  try {
    fs.writeFileSync(takeover, String(process.pid), {flag: 'wx', mode: 0o600});
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      if (Date.now() - fs.statSync(takeover).mtimeMs > STALE_MS) fs.unlinkSync(takeover);
    } catch (statErr) { /* gone already */ }
    return;
  }
  try {
    const lock = readLock(path.join(storePath, LOCK_FILE));
    if (lock != null && lock.raw === staleRaw && isStale(lock)) fs.unlinkSync(path.join(storePath, LOCK_FILE));
  } finally {
    try { fs.unlinkSync(takeover); } catch (unlinkErr) { /* gone already */ }
  }
}

// One attempt at the lock: a release function, or BUSY.
function tryLock(storePath) {
  ensureDir(storePath);
  const lockFile = path.join(storePath, LOCK_FILE);
  const mine = JSON.stringify({pid: process.pid, startMs: START_MS, at: Date.now()});
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile, mine, {flag: 'wx', mode: 0o600});
      return () => {
        try { if (fs.readFileSync(lockFile, 'utf8') === mine) fs.unlinkSync(lockFile); } catch (releaseErr) { /* gone */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const lock = readLock(lockFile);
      if (lock == null) continue;                 // released meanwhile: try again
      if (!isStale(lock)) return BUSY;
      takeOver(storePath, lock.raw);
    }
  }
  return BUSY;
}

// Runs fn while holding <storePath>/.lock, waiting for it up to
// LOCK_WAIT_MS (synchronously: for explicit flushes, the exit flush and the
// seeding command). Returns fn's value; withStoreLock.waited says whether
// it had to wait. A lock still busy after the wait fails with the holder
// named.
function withStoreLock(storePath, fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let waited = false;
  let release = tryLock(storePath);
  while (release === BUSY) {
    if (Date.now() > deadline) {
      const lock = readLock(path.join(storePath, LOCK_FILE));
      const pid = (lock != null && lock.holder != null) ? lock.holder.pid : 'unknown';
      throw new Error(`the store lock ${path.join(storePath, LOCK_FILE)} is held by pid ${pid}`);
    }
    waited = true;
    sleepSync(LOCK_RETRY_MS);
    release = tryLock(storePath);
  }
  try {
    const value = fn();
    withStoreLock.waited = waited;
    return value;
  } finally {
    release();
  }
}

// {data, corrupt} of a file: {} when there is none; a file that does not
// parse as a JSON object is moved aside and reported corrupt.
function readMap(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {data: {}, corrupt: false};
    throw e;
  }
  try {
    const data = JSON.parse(raw);
    if (data != null && typeof(data) === 'object' && !Array.isArray(data)) return {data: data, corrupt: false};
  } catch (parseErr) { /* moved aside below */ }
  const aside = `${file}.corrupt-${Date.now()}`;
  try { fs.renameSync(file, aside); } catch (renameErr) { /* another process moved it */ }
  warn(`local store: ${file} could not be read as a JSON object; moved aside to ${aside}`);
  return {data: {}, corrupt: true};
}

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

function copyOwn(obj) {
  const out = {};
  for (const key of Object.keys(obj)) put(out, key, obj[key]);
  return out;
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

  // Under the lock: the file as it is now, this process's dirty keys over
  // it (its whole map when the file was corrupt), written; the map takes
  // the result.
  function writeLocked(extra) {
    const read = readMap(file);
    const current = read.corrupt ? copyOwn(map.data) : read.data;
    for (const [key, change] of dirty) {
      if (change.deleted === true) delete current[key];
      else put(current, key, change.value);
    }
    const result = (extra != null) ? extra(current) : undefined;
    writeAtomic(file, current);
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
  // tried again later, backing off.
  function flushSoon() {
    if (dirty.size === 0) return;
    let release;
    try {
      release = tryLock(lockPath);
    } catch (e) {
      release = BUSY;
      warn(`local store: ${file} not written (${e.message}); retrying`);
    }
    if (release === BUSY) {
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      return schedule(retryMs);
    }
    try {
      writeLocked();
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
    data: readMap(file).data,
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
    // value lose neither change; callback(err, newValue). Waits for a busy
    // lock without blocking the event loop, up to LOCK_WAIT_MS.
    update(key, fn, callback) {
      const deadline = Date.now() + LOCK_WAIT_MS;
      const attempt = () => {
        let release;
        try { release = tryLock(lockPath); } catch (e) { return callback(e); }
        if (release === BUSY) {
          if (Date.now() > deadline) return callback(new Error(`the store lock under ${lockPath} stayed busy`));
          return setTimeout(attempt, LOCK_RETRY_MS);
        }
        let value;
        try {
          value = writeLocked((current) => {
            const next = fn(Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined);
            put(current, key, next);
            return next;
          });
        } catch (e) {
          return callback(e);
        } finally {
          release();
        }
        return callback(null, value);
      };
      attempt();
    },
    // The file as it is now, with this process's unwritten keys over it.
    reload() {
      const read = readMap(file);
      if (read.corrupt) return;
      const data = read.data;
      for (const [key, change] of dirty) {
        if (change.deleted === true) delete data[key];
        else put(data, key, change.value);
      }
      map.data = data;
    },
    // Writes now, waiting for the lock (an explicit flush, close, exit).
    flush() {
      if (timer != null) { clearTimeout(timer); timer = null; }
      if (dirty.size === 0) return;
      try {
        withStoreLock(lockPath, () => writeLocked());
      } catch (e) {
        warn(`local store: ${file} not written (${e.message}); retrying`);
        schedule(retryMs);
      }
    },
    close() {
      map.flush();
      if (timer != null) { clearTimeout(timer); timer = null; }
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

module.exports = {openJsonFile, withStoreLock, flushAllOnExit};
