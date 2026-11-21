'use strict';
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
// Every function here decides a grant or a path's form in a module's worker,
// after module code has run: each calls only what was taken when this file
// loaded (a module shares the realm and can replace a method of Array,
// String, RegExp, Buffer or Uint8Array). A RegExp is matched with exec as
// taken here: RegExp.prototype.test looks exec up when it runs.
const uncurry = (fn) => Function.prototype.call.bind(fn);
const StringStartsWith = uncurry(String.prototype.startsWith);
const StringEndsWith = uncurry(String.prototype.endsWith);
const StringSlice = uncurry(String.prototype.slice);
const StringToUpperCase = uncurry(String.prototype.toUpperCase);
const StringIndexOf = uncurry(String.prototype.indexOf);
const StringReplaceAll = uncurry(String.prototype.replaceAll);
const RegExpExec = uncurry(RegExp.prototype.exec);
const matches = (re, s) => RegExpExec(re, s) !== null;
const Uint8ArrayCtor = Uint8Array;
const ObjectIsPrototypeOf = uncurry(Object.prototype.isPrototypeOf);
const isBytes = (v) => v != null && typeof(v) === 'object' && ObjectIsPrototypeOf(Uint8ArrayCtor.prototype, v);
const BufferAlloc = Buffer.alloc;
const ReflectApplyAtLoad = Reflect.apply;
const MathMax = Math.max;
// a typed array's length through %TypedArray%.prototype's own getter, and its
// bytes by index (Buffer's and subarray's methods read length, and a species
// constructor, when they run)
const TypedArrayLength = uncurry(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length').get);
const StringFromCharCode = String.fromCharCode;
const latin1Head = (v, n) => {
  const len = TypedArrayLength(v);
  let out = '';
  for (let i = 0; i < len && i < n; i++) out += ReflectApplyAtLoad(StringFromCharCode, String, [v[i]]);
  return out;
};
// bytes as a new Buffer: `from` skipped, then each "\\" as "/" (UTF-8 never
// has 0x5c inside a multi-byte character), with lead before them
const slashedBytes = (v, from, lead) => {
  const len = TypedArrayLength(v);
  const out = ReflectApplyAtLoad(BufferAlloc, Buffer, [lead.length + MathMax(0, len - from)]);
  for (let i = 0; i < lead.length; i++) out[i] = lead[i];
  for (let i = from; i < len; i++) out[lead.length + i - from] = (v[i] === BACKSLASH ? SLASH : v[i]);
  return out;
};
const DRIVE = /^[a-zA-Z]:/;
// every "\\" as "/" (index by index)
const slashed = (s) => {
  let out = '';
  for (let i = 0; i < s.length; i++) out += (s[i] === '\\' ? '/' : s[i]);
  return out;
};

function underFor(platform) {
  if (platform !== 'win32') {
    return (s, roots) => {
      for (let i = 0; i < roots.length; i++) {
        const r = roots[i];
        if (s === r || StringStartsWith(s, `${r}/`)) return true;
      }
      return false;
    };
  }
  const drive = (p) => (matches(DRIVE, p) ? StringToUpperCase(p[0]) + StringSlice(p, 1) : p);
  return (s, roots) => {
    const f = drive(s);
    for (let i = 0; i < roots.length; i++) {
      const r = drive(roots[i]);
      if (f === r || StringStartsWith(f, StringEndsWith(r, '\\') ? r : `${r}\\`)) return true;
    }
    return false;
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
const DRIVE_ROOTED = /^[a-zA-Z]:[\\/]/;
function keptAsGiven(head) {
  return matches(DRIVE_ROOTED, head) || StringStartsWith(head, '\\\\');
}
// #195: with a virtual drive V (lib/fs-broker/virtual-drive.js), a path
// under <V>:\app, <V>:\data or <V>:\tmp (either separator, the drive in
// either case) is the namespace's as Node and the module name it there (its
// files, and path.resolve('/data/x') or path.resolve(os.tmpdir(), 'x') with
// the module's cwd <V>:\app): it becomes /app/..., /data/... or /tmp/...
// before the rules above. Nothing on the host is named by V.
function virtualFormFor(platform, virtualDrive) {
  if (platform !== 'win32') return (v) => v;
  const V = (typeof(virtualDrive) === 'string' && matches(/^[A-Z]$/, virtualDrive)) ? virtualDrive : null;
  const ON_V = /^[a-zA-Z]:[\\/](app|data|tmp)(?=[\\/]|$)/;
  const onV = (s) => V != null && s.length >= 6 && StringToUpperCase(s[0]) === V && matches(ON_V, s);
  const fromV = (s) => `/${slashed(StringSlice(s, 3))}`;   // "V:\" off, the rest in "/"
  return (v) => {
    if (typeof(v) === 'string' && onV(v)) return fromV(v);
    // "V:\" off, a "/" before the rest, every "\\" a "/"
    if (isBytes(v) && V != null && onV(latin1Head(v, 8))) return slashedBytes(v, 3, [SLASH]);
    if (typeof(v) === 'string') return (StringIndexOf(v, '\\') === -1 || keptAsGiven(v)) ? v : slashed(v);
    if (isBytes(v)) {
      const len = TypedArrayLength(v);
      let back = false;
      for (let i = 0; i < len && !back; i++) back = (v[i] === BACKSLASH);
      if (!back || keptAsGiven(latin1Head(v, 3))) return v;
      return slashedBytes(v, 0, []);
    }
    return v;
  };
}

// A boot or resolving grant's roots (lib/fs-broker/patch.js), checked when
// granted. Windows: a grant must be a directory below a drive's or a share's
// root -- D:\x, \\srv\share\x, or their \\?\ forms (\\?\D:\x,
// \\?\UNC\srv\share\x). Anything else (D:\, \\srv\share, a bare server, a
// device-namespace volume such as \\?\GLOBALROOT\Device\HarddiskVolume2)
// could put a whole volume under the grant, so it is refused; the install
// directory and the module's root are never one. POSIX: unchanged.
const BELOW_A_ROOT = [
  /^[a-zA-Z]:[\\/][^\\/]+/,
  /^\\\\(?![?.]\\)[^\\]+\\[^\\]+\\[^\\]+/,
  /^\\\\[?.]\\[a-zA-Z]:\\[^\\]+/,
  /^\\\\[?.]\\UNC\\[^\\]+\\[^\\]+\\[^\\]+/i
];
function assertGrantRoots(platform) {
  if (platform !== 'win32') return (roots) => roots;
  return (roots) => {
    for (let i = 0; i < roots.length; i++) {
      let below = false;
      for (let j = 0; j < BELOW_A_ROOT.length && !below; j++) below = matches(BELOW_A_ROOT[j], roots[i]);
      if (!below) throw new Error(`file broker: a grant must be below a drive's or a share's root (${roots[i]})`);
    }
    return roots;
  };
}

// The way back (C-compat-win): a namespace path the broker answers --
// /app/..., /data/..., /tmp/..., realpath's or mkdtemp's -- in the module's
// own spelling on win32 with a virtual drive V, <V>:\app\..., as its
// __dirname is: a library that builds a parent from realpathSync(__dirname)
// (resolve-from, import-fresh) names its file as Node loaded it.
// virtualFormFor reads it back as the namespace path it was. Anything else,
// and every other platform, as it is.
function seenFormFor(platform, virtualDrive) {
  if (platform !== 'win32') return (v) => v;
  const V = (typeof(virtualDrive) === 'string' && matches(/^[A-Z]$/, virtualDrive)) ? virtualDrive : null;
  if (V == null) return (v) => v;
  const NAMESPACE = /^\/(app|data|tmp)(?=\/|$)/;
  return (v) => ((typeof(v) === 'string' && matches(NAMESPACE, v)) ? `${V}:${StringReplaceAll(v, '/', '\\')}` : v);
}

module.exports = {underFor, virtualFormFor, seenFormFor, assertGrantRoots};
