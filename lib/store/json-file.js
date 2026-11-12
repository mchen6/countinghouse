// The local store's persisted maps (LM1, docs/superpowers/specs/
// 2026-11-11-local-mode-design.md section 1; plan 2026-11-11-lm1-store-and-
// identity.md, Task 3): plain JSON files under --storePath, written by
// temp-file-and-rename, pure JavaScript.
//
// Several runtime processes may share one --storePath (a developer with
// two agent terminals and an editor open runs three; reviewer's ruling,
// 2026-11-11). So no file is ever replaced whole from one process's view:
// every write takes the store lock (<storePath>/.lock, holding the writer's
// pid and start time), reads the file again, applies this process's dirty
// keys over it (a deletion too), writes a temp file, fsyncs and renames it
// into place, and releases the lock. The last write of a key wins; keys
// other processes wrote stay. A file is read once when it is opened, and
// again after a write that had to wait for the lock (another process wrote
// meanwhile); there is no merge on read beyond that.
//
// A file that does not parse is moved aside (<file>.corrupt-<ms>) and the
// map starts empty, with a log line saying so. Files are the owner's only
// (0600, the directory 0700).
const fs   = require('fs');
const path = require('path');

const LOCK_FILE = '.lock';
const LOCK_WAIT_MS = 2000;
const LOCK_RETRY_MS = 10;

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

// Runs fn while holding <storePath>/.lock. The lock is created
// exclusively; one whose pid is not alive is taken over; one held for
// longer than LOCK_WAIT_MS fails with the holder named. Returns fn's value
// and whether it had to wait (lockedWait.waited).
function withStoreLock(storePath, fn) {
  ensureDir(storePath);
  const lockFile = path.join(storePath, LOCK_FILE);
  const mine = JSON.stringify({pid: process.pid, startMs: Math.round(performance.timeOrigin)});
  const deadline = Date.now() + LOCK_WAIT_MS;
  let waited = false;
  for (;;) {
    try {
      fs.writeFileSync(lockFile, mine, {flag: 'wx', mode: 0o600});
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch (readErr) { holder = null; }
      if (holder != null && typeof(holder.pid) === 'number' && !alive(holder.pid)) {
        try { fs.unlinkSync(lockFile); } catch (unlinkErr) { /* another process took it over first */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`the store lock ${lockFile} is held by pid ${holder != null ? holder.pid : 'unknown'}`);
      }
      waited = true;
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    const value = fn();
    withStoreLock.waited = waited;
    return value;
  } finally {
    try {
      if (fs.readFileSync(lockFile, 'utf8') === mine) fs.unlinkSync(lockFile);
    } catch (releaseErr) { /* already gone */ }
  }
}

// The file's map, or {} when there is none; a file that does not parse is
// moved aside.
function readMap(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  try {
    const data = JSON.parse(raw);
    if (data != null && typeof(data) === 'object' && !Array.isArray(data)) return data;
  } catch (parseErr) { /* moved aside below */ }
  const aside = `${file}.corrupt-${Date.now()}`;
  try { fs.renameSync(file, aside); } catch (renameErr) { /* another process moved it */ }
  warn(`local store: ${file} could not be read as a JSON object; moved aside to ${aside}, starting empty`);
  return {};
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

const open = new Set();

// openJsonFile(file, {debounceMs = 500, lockPath = dirname(file)}) ->
// {data, set(key, value), delete(key), flush(), close()}.
function openJsonFile(file, opts) {
  const o = opts || {};
  const debounceMs = (o.debounceMs != null) ? o.debounceMs : 500;
  const lockPath = (o.lockPath != null) ? o.lockPath : path.dirname(file);
  ensureDir(path.dirname(file));
  const dirty = new Map();   // key -> {value} or {deleted: true}
  let timer = null;

  const map = {
    data: readMap(file),
    set(key, value) {
      map.data[key] = value;
      dirty.set(key, {value: value});
      schedule();
    },
    delete(key) {
      delete map.data[key];
      dirty.set(key, {deleted: true});
      schedule();
    },
    flush() {
      if (timer != null) { clearTimeout(timer); timer = null; }
      if (dirty.size === 0) return;
      const pending = new Map(dirty);
      dirty.clear();
      try {
        const merged = withStoreLock(lockPath, () => {
          const current = readMap(file);
          for (const [key, change] of pending) {
            if (change.deleted === true) delete current[key];
            else current[key] = change.value;
          }
          writeAtomic(file, current);
          return current;
        });
        // another process wrote meanwhile: take its keys too
        if (withStoreLock.waited === true) map.data = merged;
      } catch (e) {
        // kept dirty, for the next flush
        for (const [key, change] of pending) if (!dirty.has(key)) dirty.set(key, change);
        warn(`local store: ${file} not written (${e.message}); retried at the next write`);
      }
    },
    close() {
      map.flush();
      open.delete(map);
    }
  };

  function schedule() {
    if (timer != null) return;
    timer = setTimeout(() => { timer = null; map.flush(); }, debounceMs);
    if (typeof(timer.unref) === 'function') timer.unref();
  }

  open.add(map);
  return map;
}

function flushAll() {
  for (const map of open) map.flush();
}

// Flushes every open file when the process exits, and on SIGINT and SIGTERM
// when nothing else handles them (then the signal is raised again, so the
// process ends as it would have). Registered once.
let registered = false;
function flushAllOnExit() {
  if (registered) return;
  registered = true;
  process.once('exit', flushAll);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    if (process.listenerCount(signal) > 0) continue;
    const onSignal = () => {
      flushAll();
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}

module.exports = {openJsonFile, withStoreLock, flushAllOnExit};
