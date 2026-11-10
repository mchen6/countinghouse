// --hardened: real paths resolved by the unrestricted parent before it
// relaunches the server under Node's permission model, handed to the child on
// fd 3. Node 24.22 and later refuse a sync realpath of a granted directory
// when another grant extends its name (nodejs/node#66812), and the server
// realpaths its own grant roots at startup: the install directory, the module
// roots, the protected paths, and each dependency in the code-root walk
// (redis beside redis-commands). With these, the child never makes that call;
// the grants themselves are unchanged (user decision, 2026-11-04). The answers
// hold for the process's lifetime: a grant root repointed on the host while the
// server runs (an install-directory symlink, say) is seen at the next start,
// which is fine for what is startup configuration. Paths are keyed as
// path.resolve gives them, so a trailing slash or a relative spelling of the
// same path is answered too.
const fs = require('fs');
const path = require('path');

const FD = 3;
const ENV = 'COUNTINGHOUSE_HARDENED_REALPATHS';
let known = null;   // spelling -> real path, in the child only

// Wraps a realpath function so every path it resolved can be sent on.
function recorder(realpath) {
  const seen = {};
  return {
    realpath: (p) => { const r = realpath(p); seen[path.resolve(p)] = r; return r; },
    known: () => Object.assign({}, seen)
  };
}

// The relaunch: the marker telling the child to read fd 3, and the write.
function childEnv() {
  return {[ENV]: String(FD)};
}

function send(child, paths) {
  child.stdio[FD].end(JSON.stringify(paths));
}

// In the child, once, before anything realpaths: read and close fd 3, and
// drop the marker so the server's own child processes (the authoring tools)
// never try to read a descriptor they were not given.
function receive() {
  if (process.env[ENV] !== String(FD)) return;
  delete process.env[ENV];
  const text = fs.readFileSync(FD, 'utf8');
  try { fs.closeSync(FD); } catch (e) { /* already closed by the read */ }
  known = new Map(Object.entries(JSON.parse(text)));
}

// The native fs.realpathSync (what the kernel opens: Node's JS form resolves
// x -> "." / y -> "x/.." to x's directory, the kernel to its parent; FB3),
// answered from the parent's results where it has them.
function realpathSync(p) {
  if (has(p)) return known.get(path.resolve(String(p)));
  return fs.realpathSync.native(p);
}

function has(p) {
  return known != null && typeof(p) === 'string' && known.has(path.resolve(p));
}

module.exports = {ENV, FD, recorder, childEnv, send, receive, realpathSync, has};
