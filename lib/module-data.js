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

// mkdir's mode is filtered by the umask, so each directory this creates is
// chmod'ed to 0700 afterwards. Directories that already exist (an operator's
// --moduleDataPath set to 0750 for a backup group, say) are left alone.
async function ensureDirs(dataRoot, name) {
  const d = dirsFor(dataRoot, name);
  for (const target of [d.data, d.tmp]) {
    const first = await fs.promises.mkdir(target, {recursive: true, mode: 0o700});
    if (first == null) continue;
    // mkdir returned the first directory it created; chmod it and every one below it
    for (let p = target; ; p = path.dirname(p)) {
      await fs.promises.chmod(p, 0o700);
      if (p === first) break;
    }
  }
  return d;
}

module.exports = {safeName, dirsFor, ensureDirs};
