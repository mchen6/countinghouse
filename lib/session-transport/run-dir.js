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

// -> null, or what is wrong with the directory
function runDirProblem(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    return `its directory ${dir} could not be read (${e.code || e.message})`;
  }
  if (st.isSymbolicLink()) return `its directory ${dir} is a symbolic link`;
  if (!st.isDirectory()) return `${dir} is not a directory`;
  if (typeof(process.getuid) === 'function' && st.uid !== process.getuid()) return `its directory ${dir} is not owned by this user`;
  if ((st.mode & 0o777) !== 0o700) return `its directory ${dir} is mode ${(st.mode & 0o777).toString(8)}, not 700`;
  return null;
}

function socketPathProblem(socketPath) {
  const n = Buffer.byteLength(socketPath);
  return n > SOCKET_PATH_MAX ? `its path is ${n} bytes, over this platform's ${SOCKET_PATH_MAX}` : null;
}

// a socket file already at the path: removed when nothing listens on it ->
// Promise<null | problem>
function clearStale(socketPath) {
  let st;
  try {
    st = fs.lstatSync(socketPath);
  } catch (e) {
    return Promise.resolve(e.code === 'ENOENT' ? null : `${socketPath} could not be read (${e.code || e.message})`);
  }
  if (!st.isSocket()) return Promise.resolve(`${socketPath} is there and is not a socket`);
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    probe.once('connect', () => { probe.destroy(); resolve(`${socketPath} is in use by another runtime`); });
    probe.once('error', (e) => {
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOENT') {
        try { fs.unlinkSync(socketPath); } catch (u) { return resolve(`${socketPath} could not be removed (${u.code || u.message})`); }
        return resolve(null);
      }
      return resolve(`${socketPath} could not be checked (${e.code || e.message})`);
    });
  });
}

// writes <dir>/secret (0600) -> the secret
function writeSecret(dir, secret = handshake.newSecret()) {
  const file = path.join(dir, 'secret');
  const tmp = path.join(dir, `.secret.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    fs.writeSync(fd, handshake.formatSecret(secret));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return secret;
}

module.exports = {runDirProblem, socketPathProblem, clearStale, writeSecret, SOCKET_PATH_MAX};
