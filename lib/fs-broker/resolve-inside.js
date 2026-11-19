'use strict';
// A bare or '#' request resolved inside a module's root, as Node's ES
// resolver (lib/internal/modules/esm/resolve.js: packageResolve,
// packageImportsResolve, packageExportsResolve, resolvePackageTarget,
// legacyMainResolve) resolves it, so that under --moduleSandbox enforce Node
// is handed only the file URL found here and never walks, stats or reads
// anything above the root itself (C-bare, Fable's pass on #452 and the
// reviewer's ruling): every stat and every package.json read is the
// caller's, inside the root only. What this doesn't understand -- a shape
// Node would reject, or one it handles that this doesn't -- is a refusal,
// never handed on. Pure apart from the injected stat and read; the
// intrinsics it uses are taken at load.
const path = require('path');
const url = require('url');

const uncurry = (fn) => (self, ...args) => Reflect.apply(fn, self, args);
const ReflectApply = Reflect.apply;
const ObjectHasOwn = Object.hasOwn;
const ObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
const ArrayIsArray = Array.isArray;
const JSONParse = JSON.parse;
const StringStartsWith = uncurry(String.prototype.startsWith);
const StringEndsWith = uncurry(String.prototype.endsWith);
const StringIndexOf = uncurry(String.prototype.indexOf);
const StringLastIndexOf = uncurry(String.prototype.lastIndexOf);
const StringSlice = uncurry(String.prototype.slice);
const StringCharCodeAt = uncurry(String.prototype.charCodeAt);
const RegExpExec = uncurry(RegExp.prototype.exec);
const URLCtor = URL;
const URLHref = uncurry(Object.getOwnPropertyDescriptor(URL.prototype, 'href').get);
const URLPathname = uncurry(Object.getOwnPropertyDescriptor(URL.prototype, 'pathname').get);
const URLCanParse = URL.canParse;
const PathToFileURL = url.pathToFileURL;
const FileURLToPath = url.fileURLToPath;
const toHref = (p) => URLHref(ReflectApply(PathToFileURL, url, [p]));
const toPath = (u) => ReflectApply(FileURLToPath, url, [u]);
const PATH = {resolve: path.resolve, join: path.join, dirname: path.dirname, basename: path.basename, sep: path.sep};
const pathResolve = (...a) => ReflectApply(PATH.resolve, path, a);
const pathJoin = (...a) => ReflectApply(PATH.join, path, a);
const pathDirname = (p) => ReflectApply(PATH.dirname, path, [p]);
const pathBasename = (p) => ReflectApply(PATH.basename, path, [p]);

// (Node's own expressions, lib/internal/modules/esm/resolve.js)
const invalidSegmentRegEx = /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))?(\\|\/|$)/i;
const deprecatedInvalidSegmentRegEx = /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))(\\|\/|$)/i;
const invalidPackageNameRegEx = /^\.|%|\\/;
const encodedSepRegEx = /%2F|%5C/i;
// legacyMainResolve's candidates, in Node's order: the "main" with these,
// then the package's own index
const MAIN_TRIES = ['', '.js', '.json', '.node', '/index.js', '/index.json', '/index.node'];
const INDEX_TRIES = ['./index.js', './index.json', './index.node'];

// (each answer an own-data object with no prototype: a getter module code
// put on Object.prototype under one of these names never runs)
const REFUSE = Object.freeze({__proto__: null, refuse: true});
const refuse = () => REFUSE;
const fileAnswer = (href) => ({__proto__: null, url: href});
const builtinAnswer = (name) => ({__proto__: null, builtin: name});
// (resolvePackageTarget's own outcomes besides a URL: Node's undefined and
// null, and its ERR_INVALID_PACKAGE_TARGET, which an array skips past)
const INVALID = Object.freeze({__proto__: null, invalid: true});
const isArrayIndex = (key) => {
  if (key === '' || key.length > 10) return false;
  for (let i = 0; i < key.length; i++) {
    const c = StringCharCodeAt(key, i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return key === '0' || StringCharCodeAt(key, 0) !== 0x30;
};
// '*' everywhere in s replaced by sub, by index (Node's patternRegEx /\*/g)
const starred = (s, sub) => {
  let out = '';
  let at = 0;
  for (let i = StringIndexOf(s, '*'); i !== -1; i = StringIndexOf(s, '*', at)) {
    out = `${out}${StringSlice(s, at, i)}${sub}`;
    at = i + 1;
  }
  return `${out}${StringSlice(s, at)}`;
};
// Node's patternKeyCompare
const patternKeyCompare = (a, b) => {
  const ai = StringIndexOf(a, '*');
  const bi = StringIndexOf(b, '*');
  const baseLenA = ai === -1 ? a.length : ai + 1;
  const baseLenB = bi === -1 ? b.length : bi + 1;
  if (baseLenA > baseLenB) return -1;
  if (baseLenB > baseLenA) return 1;
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  if (a.length > b.length) return -1;
  if (b.length > a.length) return 1;
  return 0;
};

// createResolver({root, insideRoot(p), stat(p) -> 0 file | 1 dir | <0
// none, readText(p) -> string | null, isBuiltin(name)}): stat and readText
// are only ever asked about paths insideRoot answers true for.
function createResolver({root, insideRoot, stat, readText, isBuiltin}) {
  const kind = (p) => (insideRoot(p) ? stat(p) : -2);
  // (a package.json as Node's reader takes one: a BOM skipped; one that
  // doesn't parse is Node's ERR_INVALID_PACKAGE_CONFIG: a refusal)
  const manifestAt = (dir) => {
    const file = pathJoin(dir, 'package.json');
    if (!insideRoot(file) || kind(file) !== 0) return null;
    const raw = readText(file);
    if (typeof(raw) !== 'string') return null;
    try {
      const pkg = ReflectApply(JSONParse, JSON, [StringCharCodeAt(raw, 0) === 0xFEFF ? StringSlice(raw, 1) : raw]);
      return pkg != null && typeof(pkg) === 'object' && !ArrayIsArray(pkg) ? pkg : INVALID;
    } catch (e) { return INVALID; }
  };
  const own = (o, k) => (o != null && typeof(o) === 'object' && ObjectHasOwn(o, k) ? o[k] : undefined);
  // (Node's reader keeps an "exports" or "imports" that is an object, an
  // array or a string; any other is none)
  const mapOf = (v) => (v != null && (typeof(v) === 'string' || typeof(v) === 'object') ? v : undefined);

  // getPackageScopeConfig: the nearest package.json from a file's
  // directory up, inside the root; none past a directory whose name ends
  // in node_modules
  const scopeOf = (file) => {
    for (let dir = pathDirname(file); insideRoot(dir); dir = pathDirname(dir)) {
      if (StringEndsWith(pathBasename(dir), 'node_modules')) return null;
      const pkg = manifestAt(dir);
      if (pkg === INVALID) return INVALID;
      if (pkg != null) return {__proto__: null, dir, pkg};
      if (dir === root || dir === pathDirname(dir)) break;
    }
    return null;
  };

  // resolvePackageTargetString, as Node's; internal: an "imports" target
  // -> a URL href, INVALID, or {bare} (an imports target that is a bare
  // name, resolved as one by the caller)
  const targetString = (pkgJsonHref, target, subpath, pattern, internal, isPathMap) => {
    if (subpath !== '' && !pattern && StringSlice(target, -1) !== '/') return INVALID;
    if (!StringStartsWith(target, './')) {
      if (internal && StringSlice(target, 0, 1) !== '/' && !StringStartsWith(target, '../') && !ReflectApply(URLCanParse, URLCtor, [target])) {
        return {__proto__: null, bare: pattern ? starred(target, subpath) : `${target}${subpath}`};
      }
      return INVALID;
    }
    const rest = StringSlice(target, 2);
    if (RegExpExec(invalidSegmentRegEx, rest) !== null && RegExpExec(deprecatedInvalidSegmentRegEx, rest) !== null) return INVALID;
    let resolved;
    try { resolved = new URLCtor(target, pkgJsonHref); } catch (e) { return INVALID; }
    const packagePath = URLPathname(new URLCtor('.', pkgJsonHref));
    if (!StringStartsWith(URLPathname(resolved), packagePath)) return INVALID;
    if (subpath === '') return URLHref(resolved);
    // (isPathMap: a trailing-'/' request; Node only warns there, and a
    // folder mapping is refused here, below)
    if (RegExpExec(invalidSegmentRegEx, subpath) !== null && RegExpExec(deprecatedInvalidSegmentRegEx, subpath) !== null) return INVALID;
    void isPathMap;
    try {
      return pattern ? URLHref(new URLCtor(starred(URLHref(resolved), subpath))) : URLHref(new URLCtor(subpath, resolved));
    } catch (e) { return INVALID; }
  };

  // resolvePackageTarget: a URL href, null, undefined, INVALID, {bare}
  // (internal), or REFUSE for a shape Node rejects outright
  const target = (pkgJsonHref, t, subpath, pattern, internal, isPathMap, has) => {
    if (typeof(t) === 'string') return targetString(pkgJsonHref, t, subpath, pattern, internal, isPathMap);
    if (ArrayIsArray(t)) {
      if (t.length === 0) return null;
      let last;
      for (let i = 0; i < t.length; i++) {
        const r = target(pkgJsonHref, t[i], subpath, pattern, internal, isPathMap, has);
        if (r === REFUSE) return REFUSE;
        if (r === INVALID) { last = INVALID; continue; }
        if (r === undefined) continue;
        if (r === null) { last = null; continue; }
        return r;
      }
      return last === undefined || last === null ? last : INVALID;
    }
    if (t !== null && typeof(t) === 'object') {
      const keys = ObjectGetOwnPropertyNames(t);
      for (let i = 0; i < keys.length; i++) if (isArrayIndex(keys[i])) return REFUSE;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key === 'default' || has(key)) {
          const r = target(pkgJsonHref, t[key], subpath, pattern, internal, isPathMap, has);
          if (r === undefined) continue;
          return r;
        }
      }
      return undefined;
    }
    if (t === null) return null;
    return INVALID;
  };

  // the key in a map a request matches, as Node finds it: the key itself,
  // else the pattern by patternKeyCompare -> {key, sub, pattern} | null
  const matchKey = (map, request, exact) => {
    if (exact && ObjectHasOwn(map, request) && StringIndexOf(request, '*') === -1) return {__proto__: null, key: request, sub: '', pattern: false};
    let best = '';
    let bestSub;
    const keys = ObjectGetOwnPropertyNames(map);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const star = StringIndexOf(key, '*');
      if (star === -1 || !StringStartsWith(request, StringSlice(key, 0, star))) continue;
      const trailer = StringSlice(key, star + 1);
      if (request.length >= key.length && StringEndsWith(request, trailer) && patternKeyCompare(best, key) === 1 && StringLastIndexOf(key, '*') === star) {
        best = key;
        bestSub = StringSlice(request, star, request.length - trailer.length);
      }
    }
    return best === '' ? null : {__proto__: null, key: best, sub: bestSub, pattern: true};
  };

  // isConditionalExportsMainSugar: a string, an array, or an object whose
  // keys none start with '.'; a mix is Node's ERR_INVALID_PACKAGE_CONFIG
  const sugared = (exports) => {
    if (typeof(exports) === 'string' || ArrayIsArray(exports)) return true;
    if (exports === null || typeof(exports) !== 'object') return false;
    const keys = ObjectGetOwnPropertyNames(exports);
    let sugar = null;
    for (let i = 0; i < keys.length; i++) {
      const s = keys[i] === '' || StringSlice(keys[i], 0, 1) !== '.';
      if (sugar === null) sugar = s;
      else if (sugar !== s) return REFUSE;
    }
    return sugar === true;
  };

  // packageExportsResolve -> a URL href or REFUSE
  const exportsResolve = (pkgDir, subpath, exports, has) => {
    const pkgJsonHref = toHref(pathJoin(pkgDir, 'package.json'));
    const s = sugared(exports);
    if (s === REFUSE) return REFUSE;
    const map = s ? {__proto__: null, '.': exports} : exports;
    // (a folder mapping, a request ending in '/', is refused: Node has
    // deprecated it)
    if (StringEndsWith(subpath, '/')) return REFUSE;
    const m = matchKey(map, subpath, true);
    if (m == null) return REFUSE;
    const r = target(pkgJsonHref, map[m.key], m.sub, m.pattern, false, false, has);
    return typeof(r) === 'string' ? r : REFUSE;
  };

  // legacyMainResolve: Node's candidates in order, each stat'd here
  const legacyMain = (pkgDir, pkg) => {
    const main = own(pkg, 'main');
    if (typeof(main) === 'string') {
      for (let i = 0; i < MAIN_TRIES.length; i++) {
        const candidate = pathResolve(pkgDir, `${main}${MAIN_TRIES[i]}`);
        if (kind(candidate) === 0) return toHref(candidate);
      }
    }
    for (let i = 0; i < INDEX_TRIES.length; i++) {
      const candidate = pathResolve(pkgDir, INDEX_TRIES[i]);
      if (kind(candidate) === 0) return toHref(candidate);
    }
    return REFUSE;
  };

  // parsePackageName, as Node's; and a name whose own URL (Node builds its
  // node_modules lookup as one) names another path than it does, refused
  const parseName = (spec) => {
    let sep = StringIndexOf(spec, '/');
    let valid = true;
    if (StringSlice(spec, 0, 1) === '@') {
      if (sep === -1 || spec.length === 0) valid = false;
      else sep = StringIndexOf(spec, '/', sep + 1);
    }
    const name = sep === -1 ? spec : StringSlice(spec, 0, sep);
    if (RegExpExec(invalidPackageNameRegEx, name) !== null) valid = false;
    if (!valid) return null;
    for (let i = 0; i < name.length; i++) {
      const c = StringCharCodeAt(name, i);
      if (c < 0x20 || c === 0x7F) return null;
    }
    const rel = `./node_modules/${name}/package.json`;
    let asUrl;
    try { asUrl = toPath(URLHref(new URLCtor(rel, toHref(pathJoin(root, 'x.js'))))); } catch (e) { return null; }
    if (asUrl !== pathJoin(root, 'node_modules', name, 'package.json')) return null;
    return {__proto__: null, name, subpath: `.${sep === -1 ? '' : StringSlice(spec, sep)}`};
  };

  // the package directory for a name, as Node's getPackageJSONURL walks:
  // each node_modules from the parent's directory up, inside the root
  // only; a decoy where a lookup from that level's node_modules would look
  // first refused
  const locate = (name, parentFile) => {
    for (let dir = pathDirname(parentFile); insideRoot(dir); dir = pathDirname(dir)) {
      if (pathBasename(dir) !== 'node_modules') {
        const pkgDir = pathJoin(dir, 'node_modules', name);
        if (kind(pkgDir) === 1) {
          if (kind(pathJoin(dir, 'node_modules', 'node_modules', name)) >= 0) return null;
          return pkgDir;
        }
      }
      if (dir === root || dir === pathDirname(dir)) break;
    }
    return null;
  };

  // packageResolve -> an answer
  const packageResolve = (spec, parentFile, has) => {
    if (isBuiltin(spec)) return builtinAnswer(spec);
    const parsed = parseName(spec);
    if (parsed == null) return refuse();
    // (a self-reference: the parent's own scope, by its name, through its
    // "exports")
    const scope = scopeOf(parentFile);
    if (scope === INVALID) return refuse();
    if (scope != null && own(scope.pkg, 'name') === parsed.name && mapOf(own(scope.pkg, 'exports')) !== undefined) {
      const r = exportsResolve(scope.dir, parsed.subpath, own(scope.pkg, 'exports'), has);
      return r === REFUSE ? REFUSE : finish(r, scope.dir);
    }
    const pkgDir = locate(parsed.name, parentFile);
    if (pkgDir == null) return refuse();
    const pkg = manifestAt(pkgDir);
    if (pkg === INVALID) return refuse();
    const exports = mapOf(own(pkg, 'exports'));
    if (exports !== undefined) {
      const r = exportsResolve(pkgDir, parsed.subpath, exports, has);
      return r === REFUSE ? REFUSE : finish(r, pkgDir);
    }
    if (parsed.subpath === '.') {
      const r = legacyMain(pkgDir, pkg);
      return r === REFUSE ? REFUSE : finish(r, root);
    }
    let r;
    try { r = URLHref(new URLCtor(parsed.subpath, toHref(pathJoin(pkgDir, 'package.json')))); } catch (e) { return refuse(); }
    return finish(r, pkgDir);
  };

  // packageImportsResolve -> an answer
  const importsResolve = (name, parentFile, has) => {
    if (name === '#' || StringEndsWith(name, '/')) return refuse();
    const scope = scopeOf(parentFile);
    if (scope == null || scope === INVALID) return refuse();
    const imports = own(scope.pkg, 'imports');
    if (imports == null || typeof(imports) !== 'object' || ArrayIsArray(imports)) return refuse();
    const pkgJsonHref = toHref(pathJoin(scope.dir, 'package.json'));
    const m = matchKey(imports, name, true);
    if (m == null) return refuse();
    const r = target(pkgJsonHref, imports[m.key], m.sub, m.pattern, true, false, has);
    if (r != null && typeof(r) === 'object' && typeof(r.bare) === 'string') {
      // (a bare target: a built-in, or resolved from the scope's
      // package.json, as Node's packageResolve(target, packageJSONUrl))
      return packageResolve(r.bare, pathJoin(scope.dir, 'package.json'), has);
    }
    return typeof(r) === 'string' ? finish(r, scope.dir) : refuse();
  };

  // the resolved URL: no encoded separator (Node refuses one), its path
  // inside `within` and the root -> the answer
  const finish = (href, within) => {
    let u;
    try { u = new URLCtor(href); } catch (e) { return REFUSE; }
    if (RegExpExec(encodedSepRegEx, URLPathname(u)) !== null) return REFUSE;
    let p;
    try { p = toPath(href); } catch (e) { return REFUSE; }
    if (!(p === within || StringStartsWith(p, `${within}${PATH.sep}`)) || !insideRoot(p)) return REFUSE;
    return fileAnswer(href);
  };

  // A bare or '#' request from parentFile (a host path inside the root),
  // with has(condition) -> {url} | {builtin} | REFUSE
  function resolve(spec, parentFile, has) {
    if (typeof(spec) !== 'string' || spec === '' || typeof(parentFile) !== 'string' || !insideRoot(parentFile)) return REFUSE;
    try {
      return StringStartsWith(spec, '#') ? importsResolve(spec, parentFile, has) : packageResolve(spec, parentFile, has);
    } catch (e) { return REFUSE; }
  }

  // The package a bare name names from parentFile, inside the root
  // (findPackageJSON): {pkgDir, level} -- level the directory whose
  // node_modules holds it -- or null.
  function packageDir(spec, parentFile) {
    const parsed = parseName(spec);
    if (parsed == null) return null;
    const pkgDir = locate(parsed.name, parentFile);
    if (pkgDir == null) return null;
    let level = pkgDir;
    const depth = StringSlice(parsed.name, 0, 1) === '@' ? 3 : 2;
    for (let i = 0; i < depth; i++) level = pathDirname(level);
    return {__proto__: null, pkgDir, level};
  }

  // Whether a package located from parentFile for this bare name has
  // "exports" (a require then resolves it here, as Node's CommonJS
  // resolveExports would through its ES resolver), or a self-reference.
  function resolvesHere(spec, parentFile) {
    const parsed = parseName(spec);
    if (parsed == null) return true;
    const scope = scopeOf(parentFile);
    if (scope === INVALID) return true;
    if (scope != null && own(scope.pkg, 'name') === parsed.name && mapOf(own(scope.pkg, 'exports')) !== undefined) return true;
    const pkgDir = locate(parsed.name, parentFile);
    if (pkgDir == null) return false;
    const pkg = manifestAt(pkgDir);
    return pkg === INVALID || mapOf(own(pkg, 'exports')) !== undefined;
  }

  return Object.freeze({__proto__: null, resolve, packageDir, resolvesHere});
}

module.exports = {createResolver, REFUSE};
