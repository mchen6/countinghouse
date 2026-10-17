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

let installed = false;
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

module.exports = {install, register, rootOf, toHost, toVirtual, forModule};
