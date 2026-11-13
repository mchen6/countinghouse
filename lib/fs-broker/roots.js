// Whether a path is one of the granted roots or inside one, for the worker's
// fs patch (lib/fs-broker/patch.js: the boot roots and the loader's
// resolving roots). Both sides are absolute paths as path.resolve gives them.
//
// POSIX: exactly as before, a child of a root follows its "/".
//
// Windows (issue #40): Node's loader gives D:\-form paths, and the roots are
// the same form, so a child follows the root's "\" (never "/", which
// path.resolve has already turned into "\"). A root that already ends in "\"
// (a drive's root, D:\) is not given a second one. Names compare as given,
// case and all: this check grants access, and a directory with per-directory
// case sensitivity (WSL's setting) holds Countinghouse and countinghouse as
// two directories, so folding could grant one by the other's root. Both
// sides come from the same resolution; only a drive letter's case, which is
// never significant, is normalised (d: and D:). Nothing else matches: not a
// sibling that only extends the root's name (D:\a\lib beside D:\a\library),
// not another tree, not another drive.
function underFor(platform) {
  if (platform !== 'win32') return (s, roots) => roots.some((r) => s === r || s.startsWith(`${r}/`));
  const drive = (p) => (/^[a-zA-Z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p);
  return (s, roots) => {
    const f = drive(s);
    return roots.some((root) => {
      const r = drive(root);
      return f === r || f.startsWith(r.endsWith('\\') ? r : `${r}\\`);
    });
  };
}

// A path argument's form for the broker. The namespace's paths (/app, /data,
// /tmp and below) are POSIX on every OS.
//
// POSIX: unchanged ("\" is an ordinary character in a file name there).
//
// Windows (issue #40): "\" is a separator, so a namespace path built with
// the platform's path functions arrives as \app\package.json. A string that
// has no drive letter and is not a UNC or device path, and that starts with
// one of the namespace's roots in either form ("\app" or "/app", then the
// end or a separator), gets every "\" replaced by "/", before anything else
// sees it: the broker's namespace and ".." checks then apply to it
// unchanged. Nothing else is converted: a host path (a drive letter, a UNC
// or device path), a relative path, a name that only starts like a root
// (\application), or anything that is not a string.
const VIRTUAL_ROOTS = ['app', 'data', 'tmp'];
function virtualFormFor(platform) {
  if (platform !== 'win32') return (v) => v;
  return (v) => {
    if (typeof(v) !== 'string' || !v.includes('\\')) return v;
    if (/^[a-zA-Z]:/.test(v) || v.startsWith('\\\\') || v.startsWith('//')) return v;
    const isRoot = VIRTUAL_ROOTS.some((r) => {
      for (const sep of ['\\', '/']) {
        const head = `${sep}${r}`;
        if (v === head || v.startsWith(`${head}\\`) || v.startsWith(`${head}/`)) return true;
      }
      return false;
    });
    return isRoot ? v.replace(/\\/g, '/') : v;
  };
}

module.exports = {underFor, virtualFormFor};
