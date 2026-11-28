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
// The lock holds {pid, startId, instance, n, at}: its process, that
// process's start (as the announcements below record it), the copy of this
// module that took it, that copy's count of its acquisitions (so no two of
// its locks are ever the same content, whatever the clock), and when. It is stale, and taken over, when its process is gone,
// or when it carries this process's pid from an earlier start (a
// container's pid 1, where that start can be told exactly: Linux), or when
// it is this copy's own and this copy no longer holds it (a release refused
// to the end, below); an empty or unreadable lock, when it is
// older than any write takes (STALE_MS, by its file's age); a live holder's
// lock only past LIVE_STALE_MS (120 s), which no write reaches, so a slow
// live writer keeps it and a hung one cannot stop writes for good. Taking over is
// itself exclusive (each taker's own intent, <storePath>/.lock.takeover.*:
// takeOver), and the stale lock is read again under it, so two processes
// never both hold the lock.
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
// will wait announces itself in a file of its own, everything in its name:
// <storePath>/.lock.waiting.<pid>-<startId>-<since>, created exclusively and
// never written, never renamed over another (on Windows a rename onto a file
// another process has open, as every busy attempt reads the announcements,
// is refused: one shared file could then never be announced in, and the
// waiter was starved). startId is the process's own start (on Linux its
// start in clock ticks since boot, exact and untouched by a clock step;
// elsewhere its start in ms), shared by its threads; since is the start of
// its oldest wait in progress. Its freshness is the file's mtime, renewed (a
// touch) every ANNOUNCE_RENEW_MS as it finds the lock busy. A wait backing
// off from a refused rename isn't contending: it is left out of its
// process's announcement (its file dated in the past when no other wait of
// the process contends) and renews nothing there, keeping its since for its
// next busy attempt. Of the fresh announcements of
// live processes, the oldest since is the one every other attempt yields to,
// its holder's next one included, so the lock goes to that waiter at its next
// retry. When its oldest wait ends and others remain, the file is made again
// with the next since (the new name first, then the old one removed), so a
// process with waits that overlap never keeps first place; when its last wait
// ends, its file goes (withdrawn); a process starting to wait again first
// removes any file of its own a failed withdraw left. One older than
// ANNOUNCE_FRESH_MS (a waiter that stopped retrying; under every
// synchronous wait, so one left idle is always outlasted) is ignored. A dead process's file is removed:
// its pid gone, or, where a process's start can be read (aliveAs), a reused
// pid. Another live process's file is never touched. Best effort: a failure
// on an announcement file never fails a lock.
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
// A file that does not parse as a JSON object is never moved: under the
// lock, in the same hold, the first writer copies it aside
// (<file>.corrupt-<ms>-<pid>-<n>, a copy) and renames a deep copy
// of its whole map, with its unwritten keys, over it (R-store-aside-locked).
// A write that fails leaves the corrupt file in place, never missing, so
// every process, this one or another, finds it corrupt and rebuilds from its
// own map; a later writer reads the first one's file and lays its unwritten
// keys over it, as always (keys another process held only in memory are not
// recovered). A copy that can't be made never blocks the write: the warning
// says no copy was kept. One copy for each corruption this map finds, until
// a write lands or a good file is read. Only a map that saw the file whole
// (opened on a good or a missing file, or read a good one since) may
// replace it: one opened on a corrupt file starts empty and holds no copy,
// so its writes are refused with an error naming the file (an update()'s
// callback gets it: a charge or a nonce use refused) and its unwritten keys
// wait, until a map that saw it whole replaces it, or the file is moved
// away (a missing file is written as it is now). reload() keeps the map as
// it is and asks for the whole-map write, which the scheduled write,
// flush(), close() and the exit flush make with nothing unwritten too. A
// read that fails otherwise (EACCES, EIO...) is thrown to the caller and
// logged once for its code, and once when the file can be read again. An
// update()'s fn is given a deep copy of the value, so it may change it, and
// run again, without changing the map's own objects (R-free-counter-double).
// Files are the owner's only (0600, the directory 0700).
const fs   = require('fs');
const path = require('path');

const LOCK_FILE = '.lock';
// a takeover's intent, one per taker and attempt: .lock.takeover.<pid>-<startId>-<instance>-<count>-<at>
const TAKEOVER_PREFIX = '.lock.takeover.';
const TAKEOVER_NAME = /^\.lock\.takeover\.(\d+)-([tm]\d+)-([0-9a-f]+)-(\d+)-(\d+)$/;
const WAIT_PREFIX = '.lock.waiting.';
const LOCK_WAIT_MS = 2000;
const UPDATE_WAIT_MS = 10000;
// an announcement is yielded to while this fresh; its waiter renews it
// (under every synchronous wait, LOCK_WAIT_MS, so an announcement left
// idle -- a waiter stopped or blocked, a reused pid's -- is outlasted within
// any wait; on a filesystem whose mtimes are coarser than this, a waiter
// renewing can read as stale now and then: its turn less certain, never a
// second holder)
const ANNOUNCE_FRESH_MS = 1000;
const ANNOUNCE_RENEW_MS = 250;
const LOCK_RETRY_MS = 10;
const STALE_MS = 10000;
// a live holder's lock: taken over only past this (#301)
const LIVE_STALE_MS = 120000;
const RETRY_MIN_MS = 25;
const RETRY_MAX_MS = 1000;

const WIN = process.platform === 'win32';

// A busy attempt at the lock: refused is the Windows refusal that made it
// busy (onLockFile: a delete pending's EPERM, or a sharing violation's EBUSY
// or EACCES on a read or removal), else null.
// (why it was busy, for the failure a wait ends with: busyError)
const busy = (refused = null, why = {}) => ({busy: true, refused: refused, yieldedTo: why.yieldedTo != null ? why.yieldedTo : null, heldBy: why.heldBy != null ? why.heldBy : null, ownLeft: why.ownLeft === true});
const isBusy = (r) => r != null && r.busy === true;

// The one place a lock file's refusal is classified: fn's value as {value},
// or, on Windows, {refused: e} for a refusal -- a delete pending (see the
// header; EPERM), or, on a read or a removal of an existing lock file
// (`sharing`), another program holding it open without sharing it (a
// sharing violation: EBUSY, or EACCES); any other error is thrown. A create
// refused EACCES is a real access denied, thrown; one refused EPERM can't
// be told from a delete pending (Windows reports a denied access as EPERM
// too), so it is a refusal, and a wait ends saying it was still refused.
const lockRefused = (e, sharing = true) => lockRefusable && e != null && (e.code === 'EPERM' || (sharing && (e.code === 'EACCES' || e.code === 'EBUSY')));
function onLockFile(fn, sharing = false) {
  try {
    return {value: fn()};
  } catch (e) {
    if (lockRefused(e, sharing)) return {refused: e};
    throw e;
  }
}
// This copy of the store module, as a lock records it (with START_ID, the
// process's start): a lock of another copy in this process -- another
// thread's, or one loaded again -- is a live holder's. (No worker_threads:
// a file loaded lazily in a module worker can't require it.)
const INSTANCE_ID = require('crypto').randomBytes(8).toString('hex');
// A wait's deadlines and backoffs are kept by a monotonic clock, never moved
// by a step of the wall clock (a step back would stretch a synchronous wait,
// the whole thread blocked, by as much). Ages of files stay wall-clock.
// (the store's own tests may move either clock: clockOffsets)
const clockOffsets = {mono: 0, wall: 0};
const monoNow = () => performance.now() + clockOffsets.mono;
const wallNow = () => Date.now() + clockOffsets.wall;

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

// A process's start in clock ticks since boot (Linux /proc/<pid>/stat), or
// null where it can't be read cheaply and synchronously.
function processStartTicks(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    return Number.isInteger(ticks) ? ticks : null;
  } catch (e) {
    return null;
  }
}
// This process's start, as its announcements record it: t<ticks> on Linux,
// else m<ms> (its start in ms, by its uptime: the same for all its threads).
const START_ID = (() => { const t = processStartTicks(process.pid); return t != null ? `t${t}` : `m${Math.max(0, Math.round(Date.now() - process.uptime() * 1000))}`; })();
const START_SLACK_MS = 5000;
// Whether `pid` is still the process that recorded `startId`. Never reads
// a live process as dead by a clock: the start check only ever turns alive
// into dead, and only on an exact mismatch (Linux: clock ticks since boot,
// untouched by a clock step) or, for this process's own pid recorded in ms,
// one past START_SLACK_MS. Where a process's start can't be read (Windows,
// macOS, an unreadable /proc), alive(pid) alone: a reused pid then reads as
// alive, its announcement (which it can't renew) is ignored once
// ANNOUNCE_FRESH_MS stale, a bounded yield, and its file is left until that
// pid's process ends.
function aliveAs(pid, startId) {
  if (!alive(pid)) return false;
  if (typeof(startId) !== 'string') return true;
  if (startId.startsWith('t')) {
    const ticks = processStartTicks(pid);
    return ticks == null || `t${ticks}` === startId;
  }
  if (pid === process.pid && START_ID.startsWith('m')) return Math.abs(Number(startId.slice(1)) - Number(START_ID.slice(1))) <= START_SLACK_MS;
  return true;
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
  return {raw: raw, holder: holder, ageMs: wallNow() - at};
}

// Stale at once when its holder is gone (or is this pid from an earlier
// start); when no holder is readable, after STALE_MS (an empty or broken
// lock); and a live holder's only after LIVE_STALE_MS, far longer than any
// write here takes (milliseconds, and about a second at the worst measured,
// on a loaded Windows runner: B-storelock). So a live
// writer held up past STALE_MS (a slow fsync, a debugger, a long GC pause)
// keeps its lock while it writes, and a truly hung one still cannot stop
// the store's writes for good.
// A lock with this process's pid: this copy's own, not held now (a release
// refused to the end: its entry gone once the release's retries are over),
// is stale at once until another process may take it for stale too
// (RELEASE_STALE_CAP_MS after it was taken, by either clock: pastCapAt), and
// from then on judged as any holder's (stale past LIVE_STALE_MS); one this
// copy holds is never stale. Another's:
// of an earlier process given this pid when its start, exactly read (Linux,
// in clock ticks), is another; else a live holder's, another copy's (another
// thread's), stale only past LIVE_STALE_MS -- a start in ms, computed by each
// copy from the wall clock, is never trusted to tell another copy from an
// earlier process (a clock step between two copies' loads would). One with
// this pid and no startId was not written by this module (foreign or broken
// content): stale.
const held = new Map();   // this copy's held locks: a lock file's real path -> its content
let acquisitions = 0;
// this copy's last lock released on each store: {mine, acquired, at}, for the clock test of a lock it left behind
const ownLast = new Map();
// Whether another process may take a lock this copy took (acquired:
// monotonic, at: wall) for stale by now: RELEASE_STALE_CAP_MS after it was
// taken, by the monotonic clock or by the wall clock other processes judge
// its at by (which runs on through a suspend, where the monotonic one stops).
// (one-sided by the wall clock, as a lock's age is judged: a step back makes no lock stale sooner; a
// takeover's own check, takeOver, is two-sided, as intents are discounted either side)
const pastCapAt = (acquired, at) => monoNow() - acquired >= releaseStaleCapMs || wallNow() - at >= releaseStaleCapMs;
const ownPastCap = (lock, lockKey) => {
  const last = ownLast.get(lockKey);
  return (last != null && last.mine === lock.raw) ? pastCapAt(last.acquired, last.at) : lock.ageMs >= releaseStaleCapMs;
};
function isStale(lock, lockKey = null) {
  if (lock.holder == null) return lock.ageMs > STALE_MS;   // being written just now: not stale until old
  if (lock.holder.pid === process.pid) {
    if (typeof(lock.holder.startId) !== 'string') return true;
    if (lock.holder.instance === INSTANCE_ID) return held.get(lockKey) !== lock.raw && (!ownPastCap(lock, lockKey) || lock.ageMs > LIVE_STALE_MS);
    if (lock.holder.startId.startsWith('t') && START_ID.startsWith('t') && lock.holder.startId !== START_ID) return true;
    return lock.ageMs > LIVE_STALE_MS;
  }
  if (!alive(lock.holder.pid)) return true;
  return lock.ageMs > LIVE_STALE_MS;
}
const lockKeyOf = (storePath) => path.join(keyOf(storePath), LOCK_FILE);

// Removes a stale lock, exclusively. Each taker makes an intent of its own,
// .lock.takeover.<pid>-<startId>-<instance>-<count>-<at> (created
// exclusively; count is this copy's own count of its takeovers, so no name
// is ever made twice), then lists the store afresh: it goes on only if no
// other intent that counts is there, and otherwise withdraws its own and
// answers busy (tried again later). Two takers can't both go on: each lists
// after its own intent is made, and an intent stays until its taker has
// left, so of two the later lister always sees the earlier's.
// An intent counts (intentCounts) when its taker is alive (another process:
// aliveAs; this process: dead only on an exact start mismatch, as isStale
// judges), it was made within LIVE_STALE_MS by the at in its name (or is
// dated up to that far in the future; a hung taker, or a clock step, can't
// stop takeovers for good), and its file is still there; anything unsure
// counts (a stat that fails but for a gone file, or a name this copy can't
// read while its file is a live holder's age). An intent that doesn't count may be
// removed by its name by anyone (its name is never made again); this copy's
// own other intents are leftovers of its own, removed. Nobody removes an
// intent that counts.
// Under it, the lock is read again and removed only if it is still the one
// found stale (or, exactOwn, this copy's own acquisition, whatever its age),
// and only if this taker has not itself been in it past the point others
// may take its intent for gone (RELEASE_STALE_CAP_MS, by either clock). So
// two takers are never in a takeover at once, but for one stalled about
// LIVE_STALE_MS inside its own -- the bound every live holder's lock has.
// Leaving, after its removal of the lock has returned (a finally), the taker
// removes its own intent; refused, the intent counts until LIVE_STALE_MS
// after it was made, and is tried again by a timer and by this copy's next
// takeover (failing closed: others wait, never two takers).
// Returns null, or the Windows refusal that stopped it (onLockFile).
let takeoverCount = 0;
const takeoverPrefix = () => `${TAKEOVER_PREFIX}${process.pid}-${START_ID}-${INSTANCE_ID}-`;
// (another copy of this process is dead only on an exact start mismatch, as isStale judges)
const intentAlive = (pid, startId) => (pid === process.pid) ? !(startId.startsWith('t') && START_ID.startsWith('t') && startId !== START_ID) : aliveAs(pid, startId);
// whether another taker's intent, by its name, counts (its taker in a takeover, or about to be)
function intentCounts(storePath, name) {
  const m = TAKEOVER_NAME.exec(name);
  // (a name this copy can't read -- another version's -- counts while its file is a live holder's age, by its mtime)
  if (m == null) {
    try { return Math.abs(wallNow() - fs.lstatSync(path.join(storePath, name)).mtimeMs) <= LIVE_STALE_MS; } catch (e) { return e.code !== 'ENOENT'; }
  }
  if (!intentAlive(Number(m[1]), m[2])) return false;
  const at = Number(m[5]);
  // (made within LIVE_STALE_MS; dated in the future, up to LIVE_STALE_MS ahead -- a clock stepped back
  // since -- it counts, further ahead it doesn't, so no clock step stops takeovers for longer)
  if (Math.abs(wallNow() - at) > LIVE_STALE_MS) return false;
  try {
    fs.lstatSync(path.join(storePath, name));
    return true;
  } catch (e) {
    return e.code !== 'ENOENT';   // (gone: withdrawn; unsure: counts)
  }
}
// this copy's intents left behind, their removal refused: tried again by a timer
const leftIntents = new Map();   // file -> its at
let leftTimer = null;
function sweepIntents() {
  leftTimer = null;
  for (const [file, at] of leftIntents) {
    if (Math.abs(wallNow() - at) > LIVE_STALE_MS) { leftIntents.delete(file); continue; }
    try { fs.unlinkSync(file); leftIntents.delete(file); } catch (e) {
      if (e.code === 'ENOENT') leftIntents.delete(file);   // (else tried again)
    }
  }
  if (leftIntents.size > 0) { leftTimer = setTimeout(sweepIntents, RETRY_MAX_MS); if (typeof(leftTimer.unref) === 'function') leftTimer.unref(); }
}
// this copy's own intent removed; refused, it counts until removed (tried again by a timer and by this
// copy's next takeover) or LIVE_STALE_MS after it was made: others wait, never two takers. (No dating
// of a file stands for its withdrawal: a date can't be told from a clock that reads otherwise.)
function withdrawIntent(file, at) {
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    leftIntents.set(file, at);
    if (leftTimer == null) { leftTimer = setTimeout(sweepIntents, RETRY_MAX_MS); if (typeof(leftTimer.unref) === 'function') leftTimer.unref(); }
  }
}
function takeOver(storePath, staleRaw, lockKey, exactOwn = false) {
  const madeMono = monoNow();
  // (its name's at never below zero, so a clock before 1970 can't make a name the pattern can't read;
  // its own checks keep the clock as read)
  const madeAt = wallNow();
  const name = `${takeoverPrefix()}${++takeoverCount}-${Math.max(0, madeAt)}`;
  const mine = path.join(storePath, name);
  const made = onLockFile(() => fs.writeFileSync(mine, '', {flag: 'wx', mode: 0o600}));
  if (made.refused != null) return made.refused;
  try {
    let names;
    try { names = fs.readdirSync(storePath); } catch (e) { return null; }
    // (a listing without this taker's own intent is not one made after it)
    if (!names.includes(name)) return null;
    for (const n of names) {
      if (n === name || !n.startsWith(TAKEOVER_PREFIX)) continue;
      // (this copy's own others: leftovers, removed; another's that doesn't count: removed by its name)
      if (n.startsWith(takeoverPrefix())) { try { fs.unlinkSync(path.join(storePath, n)); leftIntents.delete(path.join(storePath, n)); } catch (e) { /* the timer tries again */ } continue; }
      if (intentCounts(storePath, n)) return null;
      try { fs.unlinkSync(path.join(storePath, n)); } catch (e) { /* tried again by the next taker */ }
    }
    const read = onLockFile(() => readLock(path.join(storePath, LOCK_FILE)), true);
    if (read.refused != null) return read.refused;
    const lock = read.value;
    // (exactOwn: this copy's own acquisition, its content unique: removed under the exclusion whatever its age)
    if (lock == null || lock.raw !== staleRaw || (!exactOwn && !isStale(lock, lockKey))) return null;
    // (this taker in it past the point others may take its intent for gone: it removes nothing)
    // (by the wall clock either way: others discount an intent dated as far ahead as behind)
    if (monoNow() - madeMono >= releaseStaleCapMs || Math.abs(wallNow() - madeAt) >= releaseStaleCapMs) return null;
    // Gone already (released or taken over meanwhile) is what unlinking meant.
    try {
      const gone = onLockFile(() => fs.unlinkSync(path.join(storePath, LOCK_FILE)), true);
      return gone.refused != null ? gone.refused : null;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  } finally {
    withdrawIntent(mine, madeAt);
  }
}

// The announcements (#150), each {pid, startId, since, at}, all from its
// file's name but `at`, its mtime. A dead process's file is removed
// (aliveAs); a file of this process's own is never removed here. Only this
// store's directory is read.
const WAIT_NAME = /^\.lock\.waiting\.(\d+)-([tm]\d+)-(\d+)$/;
const ownPrefix = () => `${WAIT_PREFIX}${process.pid}-${START_ID}-`;
const isMine = (w) => w != null && w.pid === process.pid && w.startId === START_ID;
function readWaiters(storePath) {
  let names;
  try { names = fs.readdirSync(storePath); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    const m = WAIT_NAME.exec(name);
    if (m == null) continue;
    const w = {pid: Number(m[1]), startId: m[2], since: Number(m[3]), at: null};
    const file = path.join(storePath, name);
    if (!isMine(w) && !aliveAs(w.pid, w.startId)) {
      try { fs.unlinkSync(file); } catch (e) { /* gone, or refused: ignored either way */ }
      continue;
    }
    try { const st = fs.lstatSync(file); if (!st.isFile()) continue; w.at = st.mtimeMs; } catch (e) { continue; }
    out.push(w);
  }
  return out;
}
// fresh: renewed within ANNOUNCE_FRESH_MS before now, never well after it
// (one dated in the future, a clock stepped back since, is not fresh); a
// file just made can be dated a fraction of a millisecond ahead of
// Date.now(), which is whole milliseconds (NTFS dates a new file finely):
// FUTURE_SLACK_MS allows for that
const FUTURE_SLACK_MS = 50;
const fresh = (w, now = Date.now()) => { const age = now - w.at; return age >= -FUTURE_SLACK_MS && age <= ANNOUNCE_FRESH_MS; };
// The waiter another process's attempt yields to, or null: of the fresh
// announcements of live processes, the oldest by since (then pid), unless it
// is this process's own. `ws`: the announcements already read.
function waiterAhead(storePath, ws = readWaiters(storePath), now = Date.now()) {
  let first = null;
  for (const w of ws) {
    if (!fresh(w, now)) continue;
    if (first == null || w.since < first.since || (w.since === first.since && w.pid < first.pid)) first = w;
  }
  return (first != null && !isMine(first)) ? first : null;
}
// This process's waits in progress, by store (its real path, so two
// spellings of one directory are one): each wait's start, and the name of
// the file that announces their oldest.
const waits = new Map();
const keyOf = (storePath) => { try { return fs.realpathSync.native(storePath); } catch (e) { return path.resolve(storePath); } };
// removes every announcement file of this process's own in the store; one
// refused (or a store it can't list) is looked for again at the next wait
const leftOwn = new Set();      // stores this process may have a file of its own left in
const checkedOwn = new Set();   // stores this process has looked in for leftovers since it started
function withdraw(storePath) {
  const key = keyOf(storePath);
  let names;
  try { names = fs.readdirSync(storePath); } catch (e) { leftOwn.add(key); return; }
  let left = false;
  for (const name of names) {
    if (name.startsWith(ownPrefix())) { try { fs.unlinkSync(path.join(storePath, name)); } catch (e) { left = true; } }
  }
  if (left) leftOwn.add(key); else leftOwn.delete(key);
}
// A wait begins: a token for waitEnded. The first of this process's waits
// on the store removes any file of its own a failed withdraw left.
function waitBegan(storePath) {
  // (a store not there yet is made first, so its real path is its key from the start)
  let key;
  try { key = fs.realpathSync.native(storePath); } catch (e) {
    try { ensureDir(storePath); } catch (mkdirErr) { /* tryLock says it */ }
    key = keyOf(storePath);
  }
  let st = waits.get(key);
  if (st == null) {
    st = {key, starts: [], file: null, made: false};
    waits.set(key, st);
    // (a leftover of its own: looked for once a store, and again only after a withdraw was refused)
    if (!checkedOwn.has(key) || leftOwn.has(key)) { checkedOwn.add(key); withdraw(storePath); }
  }
  const token = {key, since: Date.now(), backingOff: false};
  st.starts.push(token);
  return token;
}
function waitEnded(storePath, token) {
  const st = waits.get(token.key);
  if (st == null) return;
  const at = st.starts.indexOf(token);
  if (at >= 0) st.starts.splice(at, 1);
  if (st.starts.length > 0) {
    // (its oldest wait may have ended: the file made again now with the next oldest contending since, never keeping first place)
    if (st.file != null) announce(storePath);
    // (the ended wait's file, under its since alone, removed: whether it was
    // kept while it backed off, or is still the one announced, as when the
    // others all back off or the next one's file couldn't be made)
    if (!st.starts.some((t) => t.since === token.since)) {
      const kept = `${ownPrefix()}${token.since}`;
      if (kept === st.file) st.file = null;
      try { fs.lstatSync(path.join(storePath, kept)); unannounce(storePath, st, kept); } catch (e) { /* none */ }
    }
    return;
  }
  waits.delete(token.key);
  // (a file only if one was made, or one was left by a refused withdraw)
  if (st.made || leftOwn.has(token.key)) withdraw(storePath);
}
// Announces this process's oldest wait in progress that is contending for
// the lock (not backing off): its file, by that wait's since, created
// exclusively (the new name first, then the old one removed, when that wait
// changed); renewed (a touch) once ANNOUNCE_RENEW_MS old, dated in the past,
// or dated more than FUTURE_SLACK_MS in the future. With none contending,
// its file is dated in the past (retired). Never a rename, never a write
// into a file. `token`: the wait
// announcing, contending again if it was backing off. `blocking`: a
// synchronous wait, while which no other wait of the process can run: it
// announces its own since alone (another's older since would put it ahead
// of other processes' waits begun since).
function announce(storePath, token = null, blocking = false) {
  try {
    if (token != null) token.backingOff = false;
    const st = waits.get(keyOf(storePath));
    if (st == null) return;
    const contending = st.starts.filter((t) => !t.backingOff);
    if (contending.length === 0) { retireFile(storePath, st); return; }
    const since = (blocking && token != null) ? token.since : Math.min(...contending.map((t) => t.since));
    const name = `${ownPrefix()}${since}`;
    const file = path.join(storePath, name);
    const now = Date.now();
    if (st.file === name) {
      let mtime = null;
      try { mtime = fs.lstatSync(file).mtimeMs; } catch (e) { mtime = null; }
      if (mtime != null) {
        const age = now - mtime;
        if (age >= -FUTURE_SLACK_MS && age < ANNOUNCE_RENEW_MS) return;
        fs.lutimesSync(file, now / 1000, now / 1000);
        return;
      }
    }
    try {
      fs.writeFileSync(file, '', {flag: 'wx', mode: 0o600});
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      fs.lutimesSync(file, now / 1000, now / 1000);
    }
    st.made = true;
    const old = st.file;
    st.file = name;
    if (old != null && old !== name) {
      // (a wait still in progress, backing off: its file dated in the past and
      // kept for its next busy attempt, never removed and made again; any
      // other, removed)
      if (st.starts.some((t) => `${ownPrefix()}${t.since}` === old)) datePast(storePath, st, old);
      else unannounce(storePath, st, old);
    }
  } catch (e) { /* best effort */ }
}
// One file of this process's own dated in the past (never fresh), kept;
// not dated, removed.
function datePast(storePath, st, name) {
  try { fs.lutimesSync(path.join(storePath, name), 0, 0); } catch (e) { unannounce(storePath, st, name); }
}
// Removes one announcement file of this process's own; refused, it is dated
// in the past (never fresh) and removed at the next withdraw.
function unannounce(storePath, st, name) {
  try {
    fs.unlinkSync(path.join(storePath, name));
  } catch (e) {
    if (e.code === 'ENOENT') return;   // (gone already)
    try { fs.lutimesSync(path.join(storePath, name), 0, 0); } catch (utimesErr) { /* best effort */ }
    leftOwn.add(st.key);
  }
}
// This process's file dated in the past (never fresh), and kept: its next
// announce under the same since touches it again, with no removal and
// re-creation of one name (on Windows a name being deleted can't be created
// again while another process has it open). Not dated, it is removed.
function retireFile(storePath, st) {
  if (st.file == null) return;
  try {
    fs.lutimesSync(path.join(storePath, st.file), 0, 0);
  } catch (e) {
    const name = st.file;
    st.file = null;
    unannounce(storePath, st, name);
  }
}
// A wait backing off from a refused rename isn't contending for the lock:
// it reserves nothing while it backs off. It keeps its since; this process's
// file is announced again by its other waits that are contending, or retired
// when none is, and its own next busy attempt announces its since again.
// `blocking`: a synchronous wait (flush()), while which no other wait of
// the process can run: the process's file is retired outright; its next
// busy attempt announces its own since alone, and the other waits announce
// theirs at their own next busy attempt, once it has returned.
function retire(storePath, token, blocking = false) {
  try {
    token.backingOff = true;
    if (!blocking) { announce(storePath); return; }
    const st = waits.get(keyOf(storePath));
    if (st != null) retireFile(storePath, st);
  } catch (e) { /* best effort */ }
}


// Releases this copy's lock: the file removed if it is still this copy's
// own (only ever this store's own .lock). Never waits: a removal refused
// (Windows: another program has the file open without letting it be
// deleted) is a pending release, tried again by a timer, backing off, and by
// this copy's next attempt at the lock (so a synchronous wait, while which
// no timer runs, tries it too), for up to RELEASE_RETRY_MS. Still refused,
// the file stays and is no longer held: this copy's next attempt finds its
// own lock not held and takes it over -- at once until another process may
// take it for stale too (isStale), then by the rule every holder's lock is
// judged by, LIVE_STALE_MS -- never reading it as held for the rest of its
// life. The entry goes only once the retries are over, so no attempt finds
// it stale while its release is still retrying. Past the point another
// process may take it for stale (pastCapAt), the release removes it only
// under the takeover's exclusion (never raced with another taker), and its
// retries and cleanup remove nothing.
// The timer then goes on removing the file, whichever path ended the
// retries, through the takeover's exclusion (takeOver: exclusive against
// every other taker, the lock read again under it, removed only while it is
// still exactly this acquisition's content, n, and never one this copy
// holds): that is what guards the read and the removal. It stops at the
// earlier of RELEASE_CLEANUP_MS after the release and RELEASE_STALE_CAP_MS
// after the acquisition (pastCap); other processes, which wait for the file
// as for a live holder's, get the lock as soon as the other program lets go.
const RELEASE_RETRY_MS = 500;
const RELEASE_CLEANUP_MS = LIVE_STALE_MS / 2;
const RELEASE_STALE_CAP_MS = LIVE_STALE_MS - 10000;
const releaseRefused = (e) => lockRefused(e) && (e.syscall === 'unlink' || e.syscall === 'open');
let releaseRetryMs = RELEASE_RETRY_MS;       // (the store's tests may shorten them)
let releaseCleanupMs = RELEASE_CLEANUP_MS;
let releaseStaleCapMs = RELEASE_STALE_CAP_MS;
const pendingRelease = new Map();   // a lock file's real path -> {lockFile, lockKey, mine, acquired, at, cleanupEnds, until, waitMs, timer}
let ticks = 0;   // the release timers' runs, retries and cleanups (for the store's tests)
// the lock file removed if still `mine`: null when done (gone, or failed
// otherwise: given up), or the refusal
function removeMine(lockFile, mine) {
  try {
    if (fs.readFileSync(lockFile, 'utf8') === mine) fs.unlinkSync(lockFile);
    return null;
  } catch (e) {
    return releaseRefused(e) ? e : null;
  }
}
function dropHeld(lockKey, mine) {
  if (held.get(lockKey) === mine) held.delete(lockKey);
}
function release(lockFile, lockKey, mine, acquired, at) {
  ownLast.set(lockKey, {mine, acquired, at});
  // (past the point another process may take it for stale: removed only under the takeover's exclusion,
  // never raced with another taker; refused, or another taker in the way, it stays, no longer held)
  if (pastCapAt(acquired, at)) {
    try { takeOver(path.dirname(lockFile), mine, lockKey, true); } catch (e) { /* left: said as this copy's own */ }
    if (!stillMine(lockFile, mine)) ownLast.delete(lockKey);
    return dropHeld(lockKey, mine);
  }
  const refused = removeMine(lockFile, mine);
  if (refused == null) { if (!stillMine(lockFile, mine)) ownLast.delete(lockKey); return dropHeld(lockKey, mine); }
  const released = monoNow();
  const p = {lockFile, lockKey, mine, acquired, at, cleanupEnds: released + releaseCleanupMs, until: released + releaseRetryMs, waitMs: LOCK_RETRY_MS, timer: null};
  pendingRelease.set(lockKey, p);
  const retry = () => {
    ticks++;
    p.timer = null;
    if (pendingRelease.get(lockKey) !== p) return;
    if (retryRelease(lockKey) != null) later(p, retry);
  };
  later(p, retry);
}
const cleanups = new Set();   // releases past their retries, still cleaning up
// (a release's lock past the point another process may take it for stale:
// its retries end, and its cleanup with them)
const pastCap = (p) => pastCapAt(p.acquired, p.at);
function later(p, fn) {
  p.timer = setTimeout(fn, Math.max(1, p.waitMs));
  if (typeof(p.timer.unref) === 'function') p.timer.unref();
  p.waitMs = Math.min(p.waitMs * 2, RETRY_MAX_MS);
}
// Whether the lock file is still exactly `mine` (a read refused: assumed so).
function stillMine(lockFile, mine) {
  const read = (() => { try { return onLockFile(() => fs.readFileSync(lockFile, 'utf8'), true); } catch (e) { return {value: null}; } })();
  return read.refused != null || read.value === mine;
}
// Past the retries, the file no longer held is removed while it is still
// exactly this copy's, until the earlier of RELEASE_CLEANUP_MS after the
// release (a long hold still gets its cleanup) and RELEASE_STALE_CAP_MS
// after the acquisition (never once another process may take the lock for
// stale, at LIVE_STALE_MS by its wall-clock at: the margin covers the gap
// between that at and the monotonic acquisition taken next to it, and a
// small clock step): the time checked first, a takeover that throws tried
// again at the next tick, and the removal through the takeover's exclusion
// (takeOver: exclusive against every other taker, the lock read again under
// it, and never one this copy holds), so it never removes a lock that is not
// exactly this acquisition's.
function cleanup(p) {
  ticks++;
  p.timer = null;
  cleanups.delete(p);
  if (monoNow() >= p.cleanupEnds || pastCap(p)) return;
  try {
    takeOver(path.dirname(p.lockFile), p.mine, p.lockKey);
  } catch (e) {
    /* tried again at the next tick, within its time */
  }
  if (stillMine(p.lockFile, p.mine)) { cleanups.add(p); later(p, () => cleanup(p)); } else dropLast(p);
}
// (the release's lock gone: its record for the clock test with it)
function dropLast(p) {
  const last = ownLast.get(p.lockKey);
  if (last != null && last.mine === p.mine) ownLast.delete(p.lockKey);
}
// A pending release of this copy's, tried again: null once it is over
// (removed, given up, or its time spent: no longer held, and the cleanup
// armed, whichever path ends it), or the refusal.
function retryRelease(lockKey) {
  const p = pendingRelease.get(lockKey);
  if (p == null) return null;
  const refused = pastCap(p) ? null : removeMine(p.lockFile, p.mine);
  if (refused != null && monoNow() < p.until) return refused;
  if (p.timer != null) clearTimeout(p.timer);
  pendingRelease.delete(lockKey);
  dropHeld(lockKey, p.mine);
  if (refused != null) { cleanups.add(p); later(p, () => cleanup(p)); } else if (!stillMine(p.lockFile, p.mine)) dropLast(p);
  return null;
}

// One attempt at the lock: a release function, or busy() (isBusy). Busy too
// while another process's announced wait is ahead (#150).

function tryLock(storePath) {
  ensureDir(storePath);
  const lockKey = lockKeyOf(storePath);
  // (a release of this copy's own still refused: tried again first, and busy while it is)
  const stillRefused = retryRelease(lockKey);
  if (stillRefused != null) return busy(stillRefused);
  const ahead = waiterAhead(storePath);
  if (ahead != null) return busy(null, {yieldedTo: ahead.pid});
  const lockFile = path.join(storePath, LOCK_FILE);
  // (acquired: monotonic, taken next to the lock's at)
  const acquired = monoNow();
  const at = wallNow();
  const mine = JSON.stringify({pid: process.pid, startId: START_ID, instance: INSTANCE_ID, n: ++acquisitions, at});
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const made = onLockFile(() => fs.writeFileSync(lockFile, mine, {flag: 'wx', mode: 0o600}));
      if (made.refused != null) return busy(made.refused);
      held.set(lockKey, mine);
      return () => release(lockFile, lockKey, mine, acquired, at);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const read = onLockFile(() => readLock(lockFile), true);
      if (read.refused != null) return busy(read.refused);
      const lock = read.value;
      if (lock == null) continue;                 // released meanwhile: try again
      if (!isStale(lock, lockKey)) {
        // (this copy's own, left behind and past the point it is taken at once: said as such)
        if (lock.holder != null && lock.holder.pid === process.pid && lock.holder.instance === INSTANCE_ID && held.get(lockKey) !== lock.raw) return busy(null, {ownLeft: true});
        return busy(null, {heldBy: (lock.holder != null && typeof(lock.holder.pid) === 'number') ? lock.holder.pid : 'unknown'});
      }
      const refused = takeOver(storePath, lock.raw, lockKey);
      if (refused != null) return busy(refused);
    }
  }
  // (the lock taken and released twice meanwhile: held, by no one it could name)
  return busy(null, {heldBy: 'unknown'});
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
  // the last attempt's own reason, as it found it, when it recorded one: a
  // state re-read now may have changed since (a yield said as a lock held
  // by no one)
  const found = (attempt.ownLeft === true) ? 'it is this process\'s own lock, left behind because it couldn\'t be removed'
    : (attempt.yieldedTo != null) ? `it yielded to a waiting process (pid ${attempt.yieldedTo})`
    : (attempt.heldBy === 'unknown') ? 'it is held by a process not yet readable in the lock' : (attempt.heldBy != null) ? `it is held by pid ${attempt.heldBy}` : null;
  if (otherwise != null) return new Error(found != null ? `${otherwise} (${found})` : otherwise);
  if (attempt.ownLeft === true) return new Error(`the store lock ${lockFile} is this process's own, left behind because it couldn't be removed (another program may have had it open); any process may take it over ${LIVE_STALE_MS / 1000} s after it was taken: retry after that`);
  if (attempt.yieldedTo != null) return new Error(`the store lock ${lockFile} was yielded to a waiting process (pid ${attempt.yieldedTo}) for ${waitMs} ms`);
  if (attempt.heldBy === 'unknown') return new Error(`the store lock ${lockFile} is held by a process not yet readable in it`);
  if (attempt.heldBy != null) return new Error(`the store lock ${lockFile} is held by pid ${attempt.heldBy}`);
  const read = onLockFile(() => readLock(lockFile), true);
  const lock = read.value;
  // not held: this attempt yielded to another process's announced wait (#150)
  const w = waiterAhead(storePath);
  if (lock == null && w != null) {
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
function withStoreLock(storePath, fn, waitMs = LOCK_WAIT_MS, outer = null) {
  const deadline = monoNow() + waitMs;
  let waited = false;
  let own = null;   // (this call's own wait; an outer one, flush()'s, is its caller's to end)
  let release;
  try {
    release = tryLock(storePath);
    while (isBusy(release)) {
      if (monoNow() > deadline) throw busyError(release, storePath, undefined, waitMs);
      if (!waited && outer == null) own = waitBegan(storePath);
      waited = true;
      // (synchronous: its own since alone)
      announce(storePath, outer != null ? outer : own, true);
      sleepSync(LOCK_RETRY_MS);
      release = tryLock(storePath);
    }
  } catch (e) {
    // every way out of the wait ends it (the announcement goes with the last)
    if (own != null) waitEnded(storePath, own);
    throw e;
  }
  if (own != null) waitEnded(storePath, own);
  try {
    const value = fn();
    withStoreLock.waited = waited;
    return value;
  } finally {
    release();
  }
}

// {data, corrupt} of a file: {} when there is none; one that does not parse
// as a JSON object is reported corrupt and left where it is (only a writer,
// under the lock, replaces it: copyAside). Any other read error is thrown.
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
  } catch (parseErr) { /* corrupt */ }
  return {data: {}, corrupt: true};
}

// Under the lock, before a corrupt file is replaced: a copy of it beside it,
// under a name of its own (another name when one is taken) -> its path, or
// null with the reason none was kept. A copy that can't be made never stops
// the write. A copy, not a hard link: a link shares the corrupt file's
// inode, so an edit in place after it (a hand edit, a truncating writer)
// would change what was kept.
let asideSeq = 0;
function copyAside(file) {
  let why = null;
  for (let tries = 0; tries < 3; tries++) {
    asideSeq += 1;
    const aside = `${file}.corrupt-${Date.now()}-${process.pid}-${asideSeq}`;
    try {
      fs.copyFileSync(file, aside, fs.constants.COPYFILE_EXCL);
      return {aside: aside};
    } catch (copyErr) {
      why = copyErr.message;
      if (copyErr.code !== 'EEXIST') break;
    }
  }
  return {aside: null, why: why};
}

// A rename refused on Windows while another process has the file open (see
// the header): update() tries it again.
// (the store's own tests treat a rename's or a release's refusal as Windows
// does on any system, so their retries run everywhere: renamesRefusable)
let renamesRefusable = WIN;
let lockRefusable = WIN;
const renameRefused = (e) => renamesRefusable && e != null && (e.code === 'EPERM' || e.code === 'EBUSY') && e.syscall === 'rename';

function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    let failed = null;
    try {
      // every byte down before the rename: a write may put down fewer than
      // it was given (a full disk), and one that puts down none fails here,
      // never a truncated file renamed over the good one
      const bytes = Buffer.from(JSON.stringify(data));
      for (let at = 0; at < bytes.length;) {
        const n = fs.writeSync(fd, bytes, at, bytes.length - at);
        if (!(n > 0)) throw Object.assign(new Error(`writing ${tmp} stopped after ${at} of ${bytes.length} bytes`), {code: 'EIO', path: tmp});
        at += n;
      }
      fs.fsyncSync(fd);
    } catch (e) {
      failed = e;
      throw e;
    } finally {
      // (a close that fails too never hides why the write failed)
      try { fs.closeSync(fd); } catch (closeErr) { if (failed == null) throw closeErr; }
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
// the read error last said for each file (its code, else its message), until
// it can be read again: once per code per file, however often it is opened
const readErrors = new Map();

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
  let rewrite = false;      // the file was found corrupt: the next write is the whole map, with nothing unwritten too
  let copied = false;       // a copy of this corruption is kept (or was tried), until a write lands or a good read
  let known = null;         // this map saw the file whole: opened on a good or missing file, or read a good one since (null: not read yet)
  let corrupt = false;      // the last read found it corrupt (and no write has replaced it since)
  let ready = false;        // the map is made (a read at open is before it)
  let refusedFlush = false; // the last flush was refused for a corrupt file this map holds no copy of (said there)

  // The file as it is now; a corrupt one asks for the whole-map write, and
  // a read error is logged once for its code, and once when it clears.
  function readOwn() {
    let read;
    try {
      read = readMap(file);
    } catch (e) {
      const code = e.code || e.message;
      if (code !== readErrors.get(file)) warn(`local store: ${file} could not be read (${code})${ready ? '; the map is kept as it is: changes made in memory wait until it can be read, and a change that needs it read first (a charge, a nonce\'s use) fails and is told to its caller' : ''}`);
      readErrors.set(file, code);
      // (said here, once for its code: the writes that meet it say nothing more)
      if (e != null && typeof(e) === 'object') e.storeRead = true;
      throw e;
    }
    if (readErrors.has(file)) { warn(`local store: ${file} can be read again`); readErrors.delete(file); }
    const wasUnknown = known === false;
    if (known === null || !read.corrupt) known = !read.corrupt;   // (its first read decides; a good or missing file since makes it known)
    // (a map that never saw the file whole, now reading it whole: it takes it in at once, with its unwritten
    // keys over it, so a write that then fails can't leave it known with what it held before)
    if (wasUnknown && known && ready) {
      const data = deepCopy(read.data);
      for (const [key, change] of dirty) {
        if (change.deleted === true) delete data[key];
        else put(data, key, change.value);
      }
      map.data = data;
    }
    if (read.corrupt && !corrupt) {
      warn(known ? `local store: ${file} could not be read as a JSON object; it is replaced by this process's whole map at the next write`
        : `local store: ${file} could not be read as a JSON object, and this process holds no copy of it: nothing is written to it until a process that holds one replaces it, or until it is moved away`);
    }
    corrupt = read.corrupt;
    rewrite = read.corrupt && known;
    if (!read.corrupt) copied = false;
    return read;
  }
  // (a write this map may not make: the file is corrupt, and this map never saw it whole)
  const unknownCorrupt = () => Object.assign(new Error(`local store: ${file} could not be read as a JSON object, and this process holds no copy of it`), {code: 'ECORRUPT', path: file, unknownCorrupt: true});

  // Under the lock: the file as it is now, this process's dirty keys over
  // it, written; a corrupt file is copied aside and a deep copy of the whole
  // map written over it, in this same hold. The map takes the result.
  function writeLocked(extra) {
    const read = readOwn();
    if (read.corrupt && !known) throw unknownCorrupt();
    if (read.corrupt && !copied) {
      const kept = copyAside(file);
      copied = true;
      warn(kept.aside != null ? `local store: ${file} was corrupt; a copy is kept at ${kept.aside}` : `local store: ${file} was corrupt; no copy of it was kept (${kept.why}); it is replaced all the same`);
    }
    const current = read.corrupt ? deepCopy(map.data) : read.data;
    for (const [key, change] of dirty) {
      if (change.deleted === true) delete current[key];
      else put(current, key, change.value);
    }
    const result = (extra != null) ? extra(current) : undefined;
    writeAtomic(file, current);
    rewrite = false;
    copied = false;
    corrupt = false;
    dirty.clear();
    map.data = current;
    return result;
  }
  const pending = () => dirty.size > 0 || rewrite;

  function schedule(ms) {
    if (timer != null) return;
    timer = setTimeout(() => { timer = null; flushSoon(); }, ms);
    if (typeof(timer.unref) === 'function') timer.unref();
  }

  // The scheduled write: never waits for the lock; busy or failed, it is
  // tried again later, backing off. A lock refused on Windows is logged once
  // until a write lands, so a store the process cannot write says so.
  function flushSoon() {
    if (!pending()) return;
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
      if (e.unknownCorrupt !== true && e.storeRead !== true) warn(`local store: ${file} not written (${e.message}); retrying`);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      schedule(retryMs);
    } finally {
      release();
    }
  }

  const map = {
    data: readOwn().data,
    // its file, as opened (heldNoCopy finds a store file's maps by it)
    path: path.resolve(file),
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
      const deadline = monoNow() + UPDATE_WAIT_MS;
      let refused = null;          // the last refused rename, if any
      let refusedMs = RETRY_MIN_MS;
      // (at the deadline: a refused rename is told as itself, with its code
      // and the store's file, though the last attempt found the lock busy)
      const refusal = () => Object.assign(new Error(`${refused.message} (the rename over ${file} was still refused at update()'s deadline, ${UPDATE_WAIT_MS} ms)`),
        {code: refused.code, path: file});
      // (its wait, once it had to wait: kept across a refused rename's
      // retries, so it keeps its since; ended with its answer)
      let waitToken = null;
      const ended = () => { if (waitToken != null) { waitEnded(lockPath, waitToken); waitToken = null; } };
      const attempt = () => {
        let release;
        try { release = tryLock(lockPath); } catch (e) { ended(); return callback(e); }
        if (isBusy(release)) {
          if (monoNow() > deadline) {
            ended();
            return callback(refused != null ? refusal() : busyError(release, lockPath, `the store lock under ${lockPath} stayed busy for ${UPDATE_WAIT_MS} ms`, UPDATE_WAIT_MS));
          }
          if (waitToken == null) waitToken = waitBegan(lockPath);
          announce(lockPath, waitToken);
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
        if (failed == null) { ended(); return callback(null, value); }
        // (a corrupt file this failed write was to replace: the scheduled write tries it again)
        if (rewrite) schedule(retryMs);
        if (!renameRefused(failed)) { ended(); return callback(failed); }
        refused = failed;
        if (monoNow() > deadline) { ended(); return callback(refusal()); }
        // (it waits from its first refusal: its since kept for its next busy
        // attempt, reserving nothing while it backs off)
        if (waitToken == null) waitToken = waitBegan(lockPath);
        retire(lockPath, waitToken);
        // (each attempt writes the new file again: backing off, as the
        // scheduled write does, leaves the lock free between them)
        const wait = refusedMs;
        refusedMs = Math.min(refusedMs * 2, RETRY_MAX_MS);
        return setTimeout(attempt, wait);
      };
      attempt();
    },
    // One write of the map as it is, under the lock, now or never: a lock
    // that is busy is an error at once (EBUSY), never waited for -- a probe
    // on a request's path (the ledger's write-failed mark). -> cb(err)
    writeNow(callback) {
      let release;
      try { release = tryLock(lockPath); } catch (e) { return callback(e); }
      if (isBusy(release)) return callback(Object.assign(new Error(`the store lock under ${lockPath} is busy`), {code: 'EBUSY'}));
      let failed = null;
      try { writeLocked(); } catch (e) { failed = e; } finally { release(); }
      return callback(failed);
    },
    // Whether the last read of the file failed (and none has succeeded since).
    isUnreadable() { return readErrors.has(file); },
    // Whether it is corrupt and this map never saw it whole: nothing it holds can be answered from.
    isUnknownCorrupt() { return corrupt && known === false; },
    // The file as it is now, with this process's unwritten keys over it; the
    // map as it is while the file is corrupt, and the whole-map write asked for.
    reload() {
      const read = readOwn();
      if (read.corrupt) { schedule(debounceMs); return; }
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
      refusedFlush = false;
      if (!pending()) return;
      const deadline = monoNow() + LOCK_WAIT_MS;
      let refusedMs = RETRY_MIN_MS;
      // (one wait for the whole flush: a refused rename's retry keeps its since)
      const wait = waitBegan(lockPath);
      try {
      for (;;) {
        try {
          withStoreLock(lockPath, () => writeLocked(), Math.max(0, deadline - monoNow()), wait);
          return;
        } catch (e) {
          // (the whole wait is used: the last sleep is what is left of it)
          const left = deadline - monoNow();
          if (renameRefused(e) && left > 0) {
            // (its since kept, reserving nothing while it backs off)
            retire(lockPath, wait, true);
            sleepSync(Math.min(refusedMs, left));
            refusedMs = Math.min(refusedMs * 2, RETRY_MAX_MS);
            continue;
          }
          if (e.unknownCorrupt !== true && e.storeRead !== true) warn(`local store: ${file} not written (${e.message}); retrying`);
          // (an explicit flush, a close, the exit: what is lost if nothing else writes it, said)
          else if (dirty.size > 0) {
            refusedFlush = true;
            warn(`local store: ${file}: ${dirty.size} change(s) not written: ${e.unknownCorrupt === true ? 'the file is corrupt, and this process holds no copy of it' : 'the file could not be read'}`);
          }
          schedule(retryMs);
          return;
        }
      }
      } finally {
        waitEnded(lockPath, wait);
      }
    },
    close() {
      map.flush();
      if (timer != null) { clearTimeout(timer); timer = null; }
      // (closed, nothing retries it: said, never dropped silently)
      if (dirty.size > 0 && !refusedFlush) warn(`local store: ${file} closed with ${dirty.size} change(s) not written${rewrite ? ', and the corrupt file not replaced' : ''}`);
      else if (rewrite) warn(`local store: ${file} closed with the corrupt file not replaced`);
      open.delete(map);
    }
  };

  open.add(map);
  ready = true;
  // (a corrupt file at open: the map starts empty and never replaces it, holding no copy of it)
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

// The store files of `names` in `dir` this process holds no copy of
// (the overview): each one that is corrupt now and
// that no map open here saw whole. A map that saw it whole holds a copy and
// replaces the file at its next write; one opened on the corrupt file, or
// none open (a store part is made at its first use, and would find it so),
// can answer nothing from it. Read only: the file is read, never a map
// reloaded (a reload of a corrupt file asks for a write). A file that can't
// be read for another reason, or is a folder, is not named here. -> [name]
// A file is parsed again only when it changed (its size, times or inode):
// the answer is asked on every overview, and kv.json has no size bound.
const realOf = (p) => { try { return fs.realpathSync.native(p); } catch (e) { return path.resolve(p); } };
const corruptSeen = new Map();   // real path -> {at: identity, corrupt}
function corruptNow(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { corruptSeen.delete(file); return false; }
  if (!st.isFile()) return false;
  const at = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  const seen = corruptSeen.get(file);
  if (seen != null && seen.at === at) return seen.corrupt;
  let corrupt;
  try { corrupt = readMap(file).corrupt; } catch (e) { return false; }
  corruptSeen.set(file, {at, corrupt});
  return corrupt;
}
function heldNoCopy(dir, names) {
  return names.filter((name) => {
    const file = realOf(path.resolve(dir, name));
    for (const map of open) if (realOf(map.path) === file && !map.isUnknownCorrupt()) return false;
    return corruptNow(file);
  });
}

// busyError: the message a wait ends with, for a test that decides it
// without waiting (test/store/04).
// (tests: the read errors said so far forgotten; a process starts with none)
function forgetReadErrors() { readErrors.clear(); }

module.exports = {openJsonFile, withStoreLock, flushAllOnExit, busyError, forgetReadErrors, heldNoCopy,
  // (the announcements' parts, for the store's own tests)
  forTests: {refuseAsWindows: (on) => { renamesRefusable = on === true || WIN; lockRefusable = on === true || WIN; },
    // (every pending release and cleanup of this copy's stopped, as a test ends)
    stopReleases: () => { if (leftTimer != null) { clearTimeout(leftTimer); leftTimer = null; } leftIntents.clear(); for (const p of [...pendingRelease.values(), ...cleanups]) if (p.timer != null) clearTimeout(p.timer); for (const [k, p] of pendingRelease) dropHeld(k, p.mine); pendingRelease.clear(); cleanups.clear(); },
    clock: (o) => { clockOffsets.mono = (o && o.mono) || 0; clockOffsets.wall = (o && o.wall) || 0; },
    ticks: () => ticks,
    releaseTimes: (t) => { if (t == null) { releaseRetryMs = RELEASE_RETRY_MS; releaseCleanupMs = RELEASE_CLEANUP_MS; releaseStaleCapMs = RELEASE_STALE_CAP_MS; } else { releaseRetryMs = t.retryMs; releaseCleanupMs = t.cleanupMs; releaseStaleCapMs = t.staleCapMs != null ? t.staleCapMs : RELEASE_STALE_CAP_MS; } }, waitBegan, waitEnded, announce, retire, waiterAhead, readWaiters, fresh, holds: (storePath) => held.has(lockKeyOf(storePath)), ANNOUNCE_FRESH_MS, ANNOUNCE_RENEW_MS, LOCK_WAIT_MS, START_ID}};
