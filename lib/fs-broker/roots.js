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

module.exports = {underFor};
