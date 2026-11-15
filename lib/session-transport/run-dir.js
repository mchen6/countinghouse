'use strict';
// The session socket's directory and the secret beside it (the shared-runtime
// design section 1, "Where it listens"; C1). POSIX only: the Windows named
// pipe and its DACL are C2's.
//
// - The directory, <home>/run/daemon, is the user's, not a symlink, and
//   mode 0700: a wrong owner or mode refuses the start.
// - The socket path fits the platform's limit (107 bytes on Linux, 103 on
//   macOS, without the terminating NUL).
// - A socket file already there is taken over only if nothing answers on it;
//   a live one refuses the start (a bind failure is fatal; the runtime never
//   serves under a path it doesn't hold).
// - The secret is written new at each start, 0600, through a temporary file
//   created exclusively and renamed over the old one, before the socket
//   listens.
const fs = require('fs');
const net = require('net');
const path = require('path');
const handshake = require('./handshake');

const SOCKET_PATH_MAX = process.platform === 'darwin' ? 103 : 107;

const mine = (st) => typeof(process.getuid) !== 'function' || st.uid === process.getuid();

// -> null, or what is wrong with the directory or its parent (<home>/run):
// the parent too must be the user's and not group- or world-writable, so no
// one else can swap the directory out from under the checks
function runDirProblem(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    return `its directory ${dir} could not be read (${e.code || e.message})`;
  }
  if (st.isSymbolicLink()) return `its directory ${dir} is a symbolic link`;
  if (!st.isDirectory()) return `${dir} is not a directory`;
  if (!mine(st)) return `its directory ${dir} is not owned by this user`;
  if ((st.mode & 0o777) !== 0o700) return `its directory ${dir} is mode ${(st.mode & 0o777).toString(8)}, not 700`;
  const parent = path.dirname(dir);
  let pst;
  try {
    pst = fs.lstatSync(parent);
  } catch (e) {
    return `its parent ${parent} could not be read (${e.code || e.message})`;
  }
  if (pst.isSymbolicLink() || !pst.isDirectory()) return `its parent ${parent} is not a directory`;
  if (!mine(pst)) return `its parent ${parent} is not owned by this user`;
  if ((pst.mode & 0o022) !== 0) return `its parent ${parent} is group- or world-writable`;
  return null;
}

// the directory's device and inode, taken at the check and compared after
// listen, so a directory swapped meanwhile is caught
function identityOf(dir) {
  const st = fs.lstatSync(dir);
  return {dev: st.dev, ino: st.ino};
}
function sameIdentity(dir, id) {
  try {
    const now = identityOf(dir);
    return now.dev === id.dev && now.ino === id.ino;
  } catch (e) {
    return false;
  }
}

// the bind is synchronous, so a socket made under it gets no group or other
// bits whatever the process's umask
function withPrivateUmask(fn) {
  const old = process.umask(0o077);
  try {
    return fn();
  } finally {
    process.umask(old);
  }
}

// <dir>/runtime.lock, created exclusively with this pid, held for the
// runtime's life: two runtimes starting at once can't both replace the
// secret. A lock whose pid is dead is taken over, safely when two starts find
// it at once: the stale lock is renamed to a name of this start's own, the pid
// inside the renamed file is checked, and only then is a new lock created
// exclusively. A live lock renamed by mistake (the other start's new one) is
// linked back. Each read is O_NOFOLLOW and at most 4 KiB.
// -> {ok, release} | {ok: false, why}
const LOCK_READ_MAX = 4096;
function readLock(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (e) {
    return {missing: e.code === 'ENOENT', holder: null};
  }
  try {
    const buf = Buffer.alloc(LOCK_READ_MAX);
    const n = fs.readSync(fd, buf, 0, LOCK_READ_MAX, 0);
    try { return {missing: false, holder: JSON.parse(buf.subarray(0, n).toString('utf8'))}; } catch (e) { return {missing: false, holder: null}; }
  } finally {
    fs.closeSync(fd);
  }
}
// beforeTakeover: for the tests, called once a dead holder has been read,
// before it is taken aside (where a second start's race lands)
function takeStartLock(dir, {beforeTakeover} = {}) {
  const file = path.join(dir, 'runtime.lock');
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const dead = (h) => h != null && Number.isInteger(h.pid) && !alive(h.pid);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      try { fs.writeSync(fd, `${JSON.stringify({pid: process.pid, at: new Date().toISOString()})}\n`); } finally { fs.closeSync(fd); }
      let held = true;
      const release = () => {
        if (!held) return;
        held = false;
        const now = readLock(file).holder;
        if (now != null && now.pid === process.pid) { try { fs.unlinkSync(file); } catch (e) { /* gone */ } }
      };
      return {ok: true, release};
    } catch (e) {
      if (e.code !== 'EEXIST') return {ok: false, why: `its start lock ${file} could not be taken (${e.code || e.message})`};
    }
    const {holder} = readLock(file);
    if (!dead(holder)) {
      return {ok: false, why: `another runtime holds ${file}${holder != null && Number.isInteger(holder.pid) ? ` (pid ${holder.pid})` : ''}`};
    }
    if (typeof(beforeTakeover) === 'function') beforeTakeover();
    // take the stale lock aside under a name of our own, then look again
    const aside = `${file}.stale.${process.pid}.${require('crypto').randomBytes(6).toString('hex')}`;
    try {
      fs.renameSync(file, aside);
    } catch (e) {
      if (e.code === 'ENOENT') continue;   // another start took it aside first
      return {ok: false, why: `its start lock ${file} could not be taken (${e.code || e.message})`};
    }
    const moved = readLock(aside).holder;
    if (dead(moved)) {
      try { fs.unlinkSync(aside); } catch (e) { /* gone */ }
      continue;
    }
    // it was another start's new, live lock: put it back where it was
    try { fs.linkSync(aside, file); } catch (e) { /* a newer lock is there */ }
    try { fs.unlinkSync(aside); } catch (e) { /* gone */ }
    return {ok: false, why: `another runtime holds ${file}${moved != null && Number.isInteger(moved.pid) ? ` (pid ${moved.pid})` : ''}`};
  }
  return {ok: false, why: `its start lock ${file} could not be taken`};
}

function socketPathProblem(socketPath) {
  const n = Buffer.byteLength(socketPath);
  return n > SOCKET_PATH_MAX ? `its path is ${n} bytes, over this platform's ${SOCKET_PATH_MAX}` : null;
}

// a socket file already at the path: removed when nothing listens on it ->
// Promise<null | problem>. A probe with no answer within probeMs counts as
// in use (macOS refuses a full backlog's connection as it would a dead
// socket's). The file is re-checked (same device and inode) before it is
// removed. connect: for the tests.
function clearStale(socketPath, {probeMs = 2000, connect = (p) => net.createConnection(p)} = {}) {
  let st;
  try {
    st = fs.lstatSync(socketPath);
  } catch (e) {
    return Promise.resolve(e.code === 'ENOENT' ? null : `${socketPath} could not be read (${e.code || e.message})`);
  }
  if (!st.isSocket()) return Promise.resolve(`${socketPath} is there and is not a socket`);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const probe = connect(socketPath);
    const timer = setTimeout(() => { try { probe.destroy(); } catch (e) { /* gone */ } done(`${socketPath} is in use by another runtime (it did not answer)`); }, probeMs);
    probe.once('connect', () => { probe.destroy(); done(`${socketPath} is in use by another runtime`); });
    probe.once('error', (e) => {
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOENT') {
        let now;
        try { now = fs.lstatSync(socketPath); } catch (l) { return done(l.code === 'ENOENT' ? null : `${socketPath} could not be read (${l.code || l.message})`); }
        if (now.dev !== st.dev || now.ino !== st.ino) return done(`${socketPath} changed while it was checked`);
        try { fs.unlinkSync(socketPath); } catch (u) { return done(`${socketPath} could not be removed (${u.code || u.message})`); }
        return done(null);
      }
      return done(`${socketPath} could not be checked (${e.code || e.message})`);
    });
  });
}

// writes <dir>/secret (0600) -> the secret
function writeSecret(dir, secret = handshake.newSecret()) {
  const file = path.join(dir, 'secret');
  const tmp = path.join(dir, `.secret.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  let placed = false;
  try {
    try {
      fs.writeSync(fd, handshake.formatSecret(secret));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    placed = true;
  } finally {
    // a secret that could not be put in place leaves nothing behind
    if (!placed) { try { fs.unlinkSync(tmp); } catch (e) { /* gone */ } }
  }
  return secret;
}

module.exports = {runDirProblem, socketPathProblem, clearStale, writeSecret, identityOf, sameIdentity, withPrivateUmask, takeStartLock, SOCKET_PATH_MAX};
