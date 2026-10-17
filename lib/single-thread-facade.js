// Single-thread (debug) mode's virtual paths (part 2 spec, section 6): no
// sandbox, only translation. Each loaded module is registered with its host
// root and data directories; module-parent requests for fs, fs/promises and
// os get a per-module object that translates /app, /data, /tmp (and declared
// paths, which keep their names) to host paths and results back. Countinghouse
// code and other modules' code are never translated.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');

const modules = new Map();     // hostRoot -> {name, data, tmp}
const facades = new Map();     // `${hostRoot}\0${kind}` -> object
const inside = (p, root) => p === root || p.startsWith(`${root}/`);
const KINDS = {fs: 'fs', 'node:fs': 'fs', 'fs/promises': 'fs/promises', 'node:fs/promises': 'fs/promises', os: 'os', 'node:os': 'os'};

function register(hostRoot, info) { modules.set(hostRoot, info); }
// The longest registered root containing the file: a module shipped inside
// another loaded package belongs to itself (review M4).
function rootOf(hostFile) {
  let best = null;
  for (const root of modules.keys()) if (inside(hostFile, root) && (best == null || root.length > best.length)) best = root;
  return best;
}

function toHost(root, p) {
  const m = modules.get(root);
  let s = (p instanceof URL) ? url.fileURLToPath(p) : String(p);
  if (!path.isAbsolute(s)) s = path.posix.resolve('/app', s);
  if (inside(s, '/app')) return root + s.slice(4);
  if (inside(s, '/data')) return m.data + s.slice(5);
  if (inside(s, '/tmp')) return m.tmp + s.slice(4);
  return s;   // declared paths keep their names; anything else is passed through (no checks here)
}

function toVirtual(root, h) {
  const m = modules.get(root);
  const s = String(h);
  if (inside(s, m.data)) return `/data${s.slice(m.data.length)}`;
  if (inside(s, m.tmp)) return `/tmp${s.slice(m.tmp.length)}`;
  if (inside(s, root)) return `/app${s.slice(root.length)}`;
  return s;
}

// Which arguments are paths: the first, and the second for two-path calls.
const TWO_PATHS = new Set(['rename', 'renameSync', 'copyFile', 'copyFileSync', 'link', 'linkSync', 'cp', 'cpSync']);
const RESULT_PATH = new Set(['realpath', 'realpathSync', 'mkdtemp', 'mkdtempSync', 'mkdir', 'mkdirSync']);
const pathLike = (v) => typeof(v) === 'string' || v instanceof URL || Buffer.isBuffer(v);

function translateError(root, e) {
  if (e != null && typeof(e) === 'object') {
    if (typeof(e.path) === 'string') e.path = toVirtual(root, e.path);
    if (typeof(e.dest) === 'string') e.dest = toVirtual(root, e.dest);
  }
  return e;
}

function translateResult(root, key, r) {
  if (RESULT_PATH.has(key) && typeof(r) === 'string') return toVirtual(root, r);
  if (Array.isArray(r)) return r.map((d) => (d instanceof fs.Dirent ? Object.assign(Object.create(Object.getPrototypeOf(d)), d, {parentPath: toVirtual(root, d.parentPath), path: toVirtual(root, d.parentPath)}) : d));
  return r;
}

function wrapFn(root, key, fn, target) {
  return function(...a) {
    const n = TWO_PATHS.has(key) ? 2 : 1;
    if (key.startsWith('symlink')) {
      // the target text: translated only when absolute (a relative target stays relative, review M1)
      if (pathLike(a[0]) && path.isAbsolute(String(a[0]))) a[0] = toHost(root, String(a[0]));
      if (a.length > 1 && pathLike(a[1])) a[1] = toHost(root, a[1]);
    } else {
      for (let i = 0; i < n && i < a.length; i++) if (pathLike(a[i])) a[i] = toHost(root, Buffer.isBuffer(a[i]) ? a[i].toString() : a[i]);
    }
    const last = a[a.length - 1];
    if (typeof(last) === 'function' && !key.endsWith('Sync')) {
      a[a.length - 1] = (e, r, ...more) => last(translateError(root, e), translateResult(root, key, r), ...more);
    }
    try {
      const r = fn.apply(target, a);
      if (r != null && typeof(r.then) === 'function') return r.then((v) => translateResult(root, key, v), (e) => { throw translateError(root, e); });
      return translateResult(root, key, r);
    } catch (e) { throw translateError(root, e); }
  };
}

function forModule(root, kind) {
  const key = `${root}\0${kind}`;
  if (facades.has(key)) return facades.get(key);
  let f;
  if (kind === 'os') {
    f = Object.assign(Object.create(null), os, {tmpdir: () => '/tmp'});
  } else {
    const real = kind === 'fs' ? fs : fs.promises;
    f = Object.create(null);
    for (const k of Object.keys(real)) f[k] = typeof(real[k]) === 'function' && !/^[A-Z]/.test(k) ? wrapFn(root, k, real[k], real) : real[k];
    // realpath.native / realpathSync.native (review M3)
    ['realpath', 'realpathSync'].forEach((k) => { if (f[k] != null && real[k] && typeof(real[k].native) === 'function') f[k].native = wrapFn(root, k, real[k].native, real); });
    if (kind === 'fs') f.promises = forModule(root, 'fs/promises');
  }
  facades.set(key, f);
  return f;
}

const RESERVED = new Set(('break case catch class const continue debugger default delete do else enum export extends false finally for ' +
  'function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static ' +
  'implements interface package private protected public await').split(' '));
const exportable = (k) => /^[A-Za-z_$][\w$]*$/.test(k) && !RESERVED.has(k);

// The nearest package.json's "type" inside a module root decides whether a
// .js file is CommonJS (the prefix applies only to CommonJS).
function isCommonJs(root, hostFile) {
  const ext = path.extname(hostFile);
  if (ext === '.cjs') return true;
  if (ext !== '.js') return false;
  for (let dir = path.dirname(hostFile); inside(dir, root); dir = path.dirname(dir)) {
    let raw = null;
    try { raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8'); } catch (e) { raw = null; }
    if (raw != null) { try { return JSON.parse(raw).type !== 'module'; } catch (e) { return true; } }
    if (dir === root) break;
  }
  return true;
}

// The host path of a virtual path a module passed to countinghouse
// (CHUtil.loadFile), through the root of the module that called: found with
// the CallSite API, not err.stack, which modules rewrite (review I3).
function hostFromCaller(p, below) {
  const saved = Error.prepareStackTrace;
  let file = null;
  try {
    Error.prepareStackTrace = (e, frames) => frames;
    const holder = {};
    Error.captureStackTrace(holder, below);
    for (const frame of holder.stack) {
      const f = frame.getFileName();
      if (typeof(f) === 'string' && rootOf(f.startsWith('file:') ? url.fileURLToPath(f) : f) != null) { file = f.startsWith('file:') ? url.fileURLToPath(f) : f; break; }
    }
  } finally {
    Error.prepareStackTrace = saved;
  }
  return file == null ? p : toHost(rootOf(file), p);
}

let installed = false;
const active = () => installed;
function install() {
  if (installed) return;
  installed = true;
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = typeof(context.parentURL) === 'string' && context.parentURL.startsWith('file:') ? url.fileURLToPath(context.parentURL) : null;
      const root = parent != null ? rootOf(parent) : null;
      if (root != null && KINDS[specifier] != null) {
        // An import gets an ES-module facade with named exports; cjs-module-lexer
        // cannot see names through a computed module.exports (review I1).
        const esm = Array.isArray(context.conditions) && context.conditions.includes('import') && !context.conditions.includes('require');
        return {url: `countinghouse-facade:${KINDS[specifier]}?${encodeURIComponent(root)}${esm ? '&esm' : ''}`, format: esm ? 'module' : 'commonjs', shortCircuit: true};
      }
      if (root != null && (specifier === '/app' || specifier.startsWith('/app/'))) return nextResolve(root + specifier.slice(4), context);
      return nextResolve(specifier, context);
    },
    load(hookUrl, context, nextLoad) {
      // A module's CommonJS files: the virtual __filename and __dirname.
      if (hookUrl.startsWith('file:')) {
        const host = url.fileURLToPath(hookUrl);
        const root = rootOf(host);
        if (root != null && isCommonJs(root, host)) {
          return {format: 'commonjs', shortCircuit: true, source: prefixSource(fs.readFileSync(host, 'utf8'), toVirtual(root, host))};
        }
      }
      if (hookUrl.startsWith('countinghouse-facade:')) {
        const [kind, query] = hookUrl.slice('countinghouse-facade:'.length).split('?');
        const [rootEnc, esm] = query.split('&');
        const get = `require(${JSON.stringify(__filename)}).forModule(${JSON.stringify(decodeURIComponent(rootEnc))}, ${JSON.stringify(kind)})`;
        if (esm !== 'esm') return {format: 'commonjs', shortCircuit: true, source: `module.exports = ${get};`};
        // Named exports only for keys that are valid identifiers and not reserved
        // words; any other key is skipped, with a comment (review I1).
        const lines = Object.keys(forModule(decodeURIComponent(rootEnc), kind)).map((k) => (exportable(k)
          ? `export const ${k} = f.${k};` : `// ${JSON.stringify(k)} is not exported by name`));
        return {format: 'module', shortCircuit: true, source: `import {createRequire} from 'node:module';\nconst require = createRequire(${JSON.stringify(__filename)});\nconst f = ${get};\nexport default f;\n${lines.join('\n')}\n`};
      }
      return nextLoad(hookUrl, context);
    }
  });
}

// The identity prefix: `var __filename = …, __dirname = …;` inserted after a
// BOM, a hashbang line and the directive prologue, on the same line, so
// strict mode stays first and every line number is kept (columns on that one
// line shift). A string literal counts as a directive only when what follows
// cannot continue it as an expression; when unsure, the prologue ends before
// it (review I2).
const CONTINUES = new Set(['(', '[', '.', '`', '+', '-', '*', '/', '%', ',', '?', '=', '<', '>', '&', '|', '^', '!']);

function skipSpaceAndComments(src, i) {
  let sawNewline = false;
  for (;;) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\v' || c === '\f' || c === '\u00a0' || c === '\ufeff') { i++; continue; }
    if (c === '\n' || c === '\u2028' || c === '\u2029') { sawNewline = true; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i, end < 0 ? src.length : end);
      if (/[\n\u2028\u2029]/.test(body)) sawNewline = true;
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    return {i, sawNewline};
  }
}

function stringEnd(src, i) {
  const quote = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === quote) return j + 1;
    if (src[j] === '\n') return -1;
  }
  return -1;
}

function prefixSource(source, virtualFile) {
  const insert = `var __filename = ${JSON.stringify(virtualFile)}, __dirname = ${JSON.stringify(path.posix.dirname(virtualFile))};`;
  let i = 0;
  if (source[0] === '\ufeff') i = 1;
  if (source.startsWith('#!', i)) {
    const nl = source.indexOf('\n', i);
    if (nl < 0) return source;   // only a hashbang: no code to see __dirname
    i = nl + 1;
  }
  let at = i;
  let lead = '';
  for (;;) {
    const p = skipSpaceAndComments(source, i).i;
    at = p;
    lead = '';
    if (source[p] !== '\'' && source[p] !== '"') break;
    const q = stringEnd(source, p);
    if (q < 0) break;
    const after = skipSpaceAndComments(source, q);
    const c = source[after.i];
    if (c === ';') { i = after.i + 1; at = i; continue; }
    if (after.i >= source.length || c === '}') { at = q; lead = ';'; break; }
    const word = /^(instanceof|in)\b/.test(source.slice(after.i));
    if (after.sawNewline && !CONTINUES.has(c) && !word) { i = q; at = q; lead = ';'; continue; }
    at = p;   // not a directive: the prologue ends before this string
    break;
  }
  return source.slice(0, at) + lead + insert + source.slice(at);
}

module.exports = {install, active, register, rootOf, toHost, toVirtual, forModule, prefixSource, hostFromCaller};
