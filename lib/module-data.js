// Where each module's private /data and /tmp live on the host
// (docs/superpowers/specs/2026-10-17-module-sandbox-fs-broker-design.md,
// section 1): <moduleDataPath>/<name>/{data,tmp}, scoped names laid out as
// node_modules does (@scope/name), directories private to the service user.
const fs = require('fs');
const path = require('path');

// A name must map to exactly one directory under the data path and never
// leave it: one segment, or "@scope/name"; no empty, dot-leading or "@"-only
// segments; no backslash or NUL. Distinct names give distinct paths on a
// case-sensitive file system (Linux, the target); on macOS "Foo" and "foo"
// would share one, which npm's lowercase rule makes rare.
function safeName(name) {
  if (typeof(name) !== 'string' || name.length === 0 || name.length > 214) return false;
  if (name.includes('\0') || name.includes('\\')) return false;
  const parts = name.split('/');
  if (parts.length > 2) return false;
  if (parts.length === 2 && !(parts[0].startsWith('@') && parts[0].length > 1)) return false;
  return parts.every((part, i) => {
    if (part.length === 0 || part.startsWith('.')) return false;
    const scope = (parts.length === 2 && i === 0);
    return scope || !part.startsWith('@');
  });
}

function dirsFor(dataRoot, name) {
  if (!safeName(name)) throw new Error(`module name ${JSON.stringify(name)} cannot be used as a data directory name`);
  const root = path.join(path.resolve(dataRoot), ...name.split('/'));
  return {root: root, data: path.join(root, 'data'), tmp: path.join(root, 'tmp')};
}

// One form for comparing paths: Node's namespaced one, the form a recursive
// mkdir answers in on Windows (\\?\C:\...), and there case-folded, as its
// file systems compare names; on POSIX it is the resolved path.
function sameForm(p) {
  const f = path.toNamespacedPath(path.resolve(p));
  return process.platform === 'win32' ? f.toLowerCase() : f;
}

// The directories one recursive mkdir of `target` created: `target` and each
// directory above it up to `first`, the first it created, as it answered it.
// Never past `first`; an answer that is not `target` or above it throws
// before anything is chmod'ed (issue #40: on Windows the answer and the walk
// never met as strings, and the walk passed the root).
function createdBy(target, first) {
  const stop = sameForm(first);
  const created = [];
  for (let p = target; ; p = path.dirname(p)) {
    created.push(p);
    if (sameForm(p) === stop) return created;
    if (path.dirname(p) === p) throw new Error(`mkdir reported creating ${first}, which is not ${target} or above it`);
  }
}

// mkdir's mode is filtered by the umask, so each directory this creates is
// chmod'ed to 0700 afterwards. Directories that already exist (an operator's
// --moduleDataPath set to 0750 for a backup group, say) are left alone.
async function ensureDirs(dataRoot, name) {
  const d = dirsFor(dataRoot, name);
  for (const target of [d.data, d.tmp]) {
    const first = await fs.promises.mkdir(target, {recursive: true, mode: 0o700});
    if (first == null) continue;
    let created;
    try {
      created = createdBy(target, first);
    } catch (e) {
      // An answer, so `target` did not exist before this mkdir: it made
      // `target` at least. That one is made private before the refusal, as a
      // later start would find it there and leave it alone.
      await fs.promises.chmod(target, 0o700);
      throw e;
    }
    for (const p of created) await fs.promises.chmod(p, 0o700);
  }
  return d;
}

module.exports = {safeName, dirsFor, ensureDirs};
