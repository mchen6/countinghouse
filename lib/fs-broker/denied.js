// The always-denied files (R2-1 spec, "The always-denied set"): the auth
// configuration -- the JSON file under --authProvider file, the database
// under sqlite with its -wal, -shm and -journal side files -- and the
// identity secret (under --moduleDataPath, or --storePath in the
// single-identity profile). Refused to a module in audit and
// enforce, EACCES, however the module names them: directly, through a
// symlink or `..`, or through a hard link in a declared directory. Off
// decides nothing, so off never consults this set.
//
// A file is known by its real path and, once it exists, by (dev, ino), so a
// hard link (a different path, the same inode) is refused like the file.
// The identities are re-taken at most once a second (REFRESH_MS), which
// bounds how long a file a provider rewrote in place (a new inode) is known
// by its path alone: a hard link to the new inode made inside that second
// is not recognised by inode until the next refresh. A path that does not
// exist yet (the secret before a first start, a sqlite side file) is matched
// by its real path, computed from its parent's, until it exists.
const fsp  = require('fs/promises');
const path = require('path');

const REFRESH_MS = 1000;
const SIDE_FILES = ['', '-wal', '-shm', '-journal'];

// The paths for a server's options: the auth configuration and its side
// files, and the identity secret.
function deniedPathsFor(options) {
  const cwd = process.cwd();
  const auth = path.resolve(cwd, options.authConfigPath || path.join(cwd, 'auth.json'));
  const out = SIDE_FILES.map((s) => auth + s);
  if (options.moduleDataPath != null) out.push(path.join(path.resolve(cwd, options.moduleDataPath), '.identity-secret'));
  // in the single-identity profile the secret lives in the store (LM1 spec
  // section 4)
  if (options.singleIdentity === true && options.storePath != null) out.push(path.join(path.resolve(cwd, options.storePath), '.identity-secret'));
  return out;
}

async function realOf(p) {
  try {
    return await fsp.realpath(p);
  } catch (e) {
    try {
      return path.join(await fsp.realpath(path.dirname(p)), path.basename(p));
    } catch (e2) {
      return p;
    }
  }
}

class DeniedSet {
  constructor(paths) {
    this.paths = (paths || []).slice();
    this.reals = new Set();
    this.idents = [];
    this.at = 0;
    this.refreshing = null;
  }

  // Real paths and identities, at most once per REFRESH_MS; concurrent
  // callers share one refresh.
  refresh() {
    if (Date.now() - this.at < REFRESH_MS) return Promise.resolve();
    if (this.refreshing != null) return this.refreshing;
    this.refreshing = (async () => {
      const reals = new Set();
      const idents = [];
      for (const p of this.paths) {
        const real = await realOf(p);
        reals.add(real);
        const st = await fsp.stat(real).catch(() => null);
        if (st != null) idents.push({dev: st.dev, ino: st.ino});
      }
      this.reals = reals;
      this.idents = idents;
      this.at = Date.now();
      this.refreshing = null;
    })();
    return this.refreshing;
  }

  // Whether the object at realLoc (its real path), with identity ident
  // ({dev, ino} when known), is one of the denied files.
  async matches(realLoc, ident) {
    if (this.paths.length === 0) return false;
    await this.refresh();
    if (realLoc != null && this.reals.has(realLoc)) return true;
    if (ident != null && ident.ino != null) {
      return this.idents.some((d) => d.dev === ident.dev && d.ino === ident.ino);
    }
    return false;
  }
}

module.exports = {DeniedSet, deniedPathsFor, REFRESH_MS};
