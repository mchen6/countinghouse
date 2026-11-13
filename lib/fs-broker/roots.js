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
// Windows (issue #40): "\" is a separator, the same as "/", but the broker's
// namespace is POSIX and would take it as part of a name while the OS takes
// it as a separator. So every path, a string or a Buffer (Uint8Array),
// relative ones included, gets every "\" replaced by "/" before anything
// else sees it: the broker's namespace and ".." checks then apply to it
// unchanged. Kept as given: a drive-qualified path (a letter, ":", then "\"
// or "/") and a UNC or device path ("\\host\share", "\\?\", "\\.\"),
// which are host paths: the broker takes a drive path as outside and refuses
// a namespace path still holding a "\" (lib/fs-broker/namespace.js). A drive
// letter with no separator after it ("C:..\x", drive-relative) is converted
// like any other path. A Buffer is converted byte for byte: UTF-8 never uses
// 0x5C inside a multi-byte character. Anything else is left alone.
const BACKSLASH = 0x5c;
const SLASH = 0x2f;
function keptAsGiven(head) {
  return /^[a-zA-Z]:[\\/]/.test(head) || head.startsWith('\\\\');
}
function virtualFormFor(platform) {
  if (platform !== 'win32') return (v) => v;
  return (v) => {
    if (typeof(v) === 'string') return (!v.includes('\\') || keptAsGiven(v)) ? v : v.replace(/\\/g, '/');
    if (v instanceof Uint8Array) {
      if (!v.includes(BACKSLASH) || keptAsGiven(Buffer.from(v.subarray(0, 3)).toString('latin1'))) return v;
      return Buffer.from(v).map((b) => (b === BACKSLASH ? SLASH : b));
    }
    return v;
  };
}

// A boot or resolving grant's roots (lib/fs-broker/patch.js), checked when
// granted. Windows: a drive's root (D:\, \\?\D:\) or a share's
// (\\srv\share) would put every path on it under the grant, so it is
// refused; the install directory and the module's root are never one.
// POSIX: unchanged.
const WHOLE_VOLUME = [/^[a-zA-Z]:[\\/]?$/, /^\\\\[?.]\\[a-zA-Z]:\\?$/, /^\\\\[^\\]+\\[^\\]+\\?$/];
function assertGrantRoots(platform) {
  if (platform !== 'win32') return (roots) => roots;
  return (roots) => {
    const drive = roots.find((r) => WHOLE_VOLUME.some((re) => re.test(r)));
    if (drive != null) throw new Error(`file broker: a grant may not be a drive's root (${drive})`);
    return roots;
  };
}

module.exports = {underFor, virtualFormFor, assertGrantRoots};
