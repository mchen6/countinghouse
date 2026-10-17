// Node-shaped errors for the broker: code, negative errno, syscall, and the
// path the module gave (virtual), never a host path inside its namespace.
const os = require('os');

const TEXT = {
  ENOENT: 'no such file or directory', EROFS: 'read-only file system', EPERM: 'operation not permitted',
  EBUSY: 'resource busy or locked', EMFILE: 'too many open files', EBADF: 'bad file descriptor',
  EXDEV: 'cross-device link not permitted', ETIMEDOUT: 'connection timed out', EIO: 'i/o error',
  EINVAL: 'invalid argument', EACCES: 'permission denied', EISDIR: 'illegal operation on a directory',
  EEXIST: 'file already exists', ENOTDIR: 'not a directory', ENOTEMPTY: 'directory not empty', ELOOP: 'too many symbolic links encountered',
  EFBIG: 'file too large', ENOBUFS: 'no buffer space available', ENXIO: 'no such device or address'
};

function nodeError(code, syscall, vpath, dest) {
  const where = vpath != null ? ` '${vpath}'${dest != null ? ` -> '${dest}'` : ''}` : '';
  const err = new Error(`${code}: ${TEXT[code] || code.toLowerCase()}, ${syscall}${where}`);
  err.code = code;
  err.errno = -(os.constants.errno[code] || 0);
  err.syscall = syscall;
  if (vpath != null) err.path = vpath;
  if (dest != null) err.dest = dest;
  return err;
}

function scrub(text, placed, dest, namespace) {
  let s = String(text);
  [placed, dest].forEach((p) => { if (p != null && p.host != null && p.host !== p.virtual) s = s.split(p.host).join(p.virtual); });
  const roots = (namespace != null ? namespace.roots : []).slice().sort((a, b) => b.real.length - a.real.length);
  roots.forEach((r) => {
    if (r.real !== r.vroot) s = s.split(r.real).join(r.vroot);
    if (r.host !== r.vroot) s = s.split(r.host).join(r.vroot);
  });
  return s;
}

// Any error out of a host operation, re-addressed to the module's paths.
function rewrite(e, syscall, placed, dest, namespace) {
  if (e == null || typeof(e) !== 'object') return e;
  const vpath = placed != null ? placed.virtual : undefined;
  const vdest = dest != null ? dest.virtual : undefined;
  if (typeof(e.code) === 'string' && /^E[A-Z0-9]+$/.test(e.code)) return nodeError(e.code, e.syscall || syscall, vpath, vdest);
  const out = new Error(scrub(e.message, placed, dest, namespace));
  if (e.code != null) out.code = e.code;
  if (e.syscall != null) out.syscall = e.syscall;
  if (vpath != null) out.path = vpath;
  if (vdest != null) out.dest = vdest;
  return out;
}

module.exports = {nodeError, rewrite, scrub};
