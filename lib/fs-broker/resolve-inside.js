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

const ReflectApply = Reflect.apply;
// (through the Reflect.apply taken here: module code may replace the global
// one)
const uncurry = (fn) => (self, ...args) => ReflectApply(fn, self, args);
const MapCtor = Map;
const MapGet = uncurry(Map.prototype.get);
const MapSet = uncurry(Map.prototype.set);
const MapHas = uncurry(Map.prototype.has);
// (a '#/' imports name: taken from Node 24.14.0, semver-minor, "module:
// allow subpath imports that start with #/" (nodejs/node#60864); refused
// before it -- 22.x (as of 22.23), 24.0-24.13 -- and on 25.x, whose first
// release with it is not pinned here: refused there, the stricter answer)
const [NODE_MAJOR, NODE_MINOR] = String(process.versions.node).split('.').map(Number);
const HASH_SLASH = NODE_MAJOR >= 26 || (NODE_MAJOR === 24 && NODE_MINOR >= 14);
const ObjectHasOwn = Object.hasOwn;
const ObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
const ArrayIsArray = Array.isArray;
const JSONParse = JSON.parse;
// (taken at load: createResolver runs at first use, after module code
// could have replaced the global; the high review of #465, round 3, item 2)
const ObjectFreeze = Object.freeze;
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
  if (key !== '0' && StringCharCodeAt(key, 0) === 0x30) return false;
  // (below 2 ** 32 - 1, as Node's isArrayIndex: a ten-digit key at or past
  // '4294967295' is a condition name)
  return key.length < 10 || key < '4294967295';
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
function createResolver({root, insideRoot, stat, readText, isBuiltin, keepMisses}) {
  const kind = (p) => (insideRoot(p) ? stat(p) : -2);
  // (the base parseName builds a name's own URL against: fixed per root)
  const rootBase = toHref(pathJoin(root, 'x.js'));
  // (a package.json as Node's reader takes one: a BOM skipped; one that
  // doesn't parse is Node's ERR_INVALID_PACKAGE_CONFIG: a refusal)
  // (each package.json read once: under enforce the root is read-only)
  const manifests = new MapCtor();
  const manifestAt = (dir) => {
    if (MapHas(manifests, dir)) return MapGet(manifests, dir);
    const read = manifestRead(dir);
    // (a read that failed is none now, asked again later)
    if (read === undefined) return null;
    // (a package.json found is kept; none is asked again, as one can be
    // made later where nothing is read-only -- kept as none only where the
    // root is: keepMisses)
    if (read !== null || (typeof(keepMisses) === 'function' && keepMisses() === true)) MapSet(manifests, dir, read);
    return read;
  };
  // (-> the parsed object, INVALID, null for no file there -- what a stat
  // says -- or undefined for a read that failed, never kept as none)
  const manifestRead = (dir) => {
    const file = pathJoin(dir, 'package.json');
    if (!insideRoot(file) || kind(file) !== 0) return null;
    const raw = readText(file);
    if (typeof(raw) !== 'string') return undefined;
    try {
      const pkg = ReflectApply(JSONParse, JSON, [StringCharCodeAt(raw, 0) === 0xFEFF ? StringSlice(raw, 1) : raw]);
      return pkg != null && typeof(pkg) === 'object' && !ArrayIsArray(pkg) ? pkg : INVALID;
    } catch (e) { return INVALID; }
  };
  const own = (o, k) => (o != null && typeof(o) === 'object' && ObjectHasOwn(o, k) ? o[k] : undefined);
  // (Node's reader keeps an "exports" or "imports" that is an object, an
  // array or a string; any other is none. It keeps the field's own JSON
  // text and parses it again when used, so a string beginning with '{' or
  // '[' is the object or array it spells -- one that doesn't parse stays the
  // string, an invalid target, refused as Node's throw is; #465's Fable
  // pass, F4)
  const mapOf = (v) => {
    if (v == null || (typeof(v) !== 'string' && typeof(v) !== 'object')) return undefined;
    if (typeof(v) === 'string' && (StringStartsWith(v, '{') || StringStartsWith(v, '['))) {
      try {
        const parsed = ReflectApply(JSONParse, JSON, [v]);
        if (parsed != null && typeof(parsed) === 'object') return parsed;
      } catch (e) { return v; }
    }
    return v;
  };

  // getPackageScopeConfig: the nearest package.json from a file's
  // directory up, inside the root; none past a directory whose name ends
  // in node_modules
  const scopeOf = (file) => {
    for (let dir = pathDirname(file); insideRoot(dir); dir = pathDirname(dir)) {
      // (a directory named node_modules exactly, as Node's walk stops: one
      // whose name only ends so is walked past; the high review of #465,
      // round 3, item 4)
      if (pathBasename(dir) === 'node_modules') return null;
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
  const targetString = (pkgJsonHref, target, subpath, pattern, internal) => {
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
    // (an invalid subpath is Node's throw, which no array skips past)
    if (RegExpExec(invalidSegmentRegEx, subpath) !== null && RegExpExec(deprecatedInvalidSegmentRegEx, subpath) !== null) return REFUSE;
    try {
      return pattern ? URLHref(new URLCtor(starred(URLHref(resolved), subpath))) : URLHref(new URLCtor(subpath, resolved));
    } catch (e) { return INVALID; }
  };

  // resolvePackageTarget: a URL href, null, undefined, INVALID, {bare}
  // (internal), or REFUSE for a shape Node rejects outright
  const target = (pkgJsonHref, t, subpath, pattern, internal, has) => {
    if (typeof(t) === 'string') return targetString(pkgJsonHref, t, subpath, pattern, internal);
    // (REFUSE from a string target -- Node's throw -- ends an array too)
    if (ArrayIsArray(t)) {
      if (t.length === 0) return null;
      let last;
      for (let i = 0; i < t.length; i++) {
        const r = target(pkgJsonHref, t[i], subpath, pattern, internal, has);
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
          const r = target(pkgJsonHref, t[key], subpath, pattern, internal, has);
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
  const matchKey = (map, request) => {
    if (ObjectHasOwn(map, request) && StringIndexOf(request, '*') === -1) return {__proto__: null, key: request, sub: '', pattern: false};
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
    const m = matchKey(map, subpath);
    if (m == null) return REFUSE;
    const r = target(pkgJsonHref, map[m.key], m.sub, m.pattern, false, has);
    return typeof(r) === 'string' ? r : REFUSE;
  };

  // legacyMainResolve: Node's candidates in order, each stat'd here
  const legacyMain = (pkgDir, pkg) => {
    const main = own(pkg, 'main');
    if (typeof(main) === 'string') {
      // (as Node's: each extension appended to "main" resolved, for the
      // stat; the file answered is (main || './') + that extension,
      // resolved -- the two differ for a "main" ending in '/', where Node
      // answers a file it never statted, which then fails to load; the high
      // review of #465, 3)
      const base = pathResolve(pkgDir, main);
      for (let i = 0; i < MAIN_TRIES.length; i++) {
        const candidate = `${base}${MAIN_TRIES[i]}`;
        const answer = pathResolve(pkgDir, `${main === '' ? './' : main}${MAIN_TRIES[i]}`);
        // (a candidate outside the root: Node would stat it -- refused,
        // never passed over for the next)
        if (!insideRoot(candidate) || !insideRoot(answer)) return REFUSE;
        if (kind(candidate) === 0) return toHref(answer);
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
    // (a scope's name part empty, '.' or '..' names no package directory:
    // refused, as the joined path would be another directory)
    if (StringSlice(name, 0, 1) === '@') {
      const part = StringSlice(name, StringIndexOf(name, '/') + 1);
      if (part === '' || part === '.' || part === '..') valid = false;
    }
    if (!valid) return null;
    for (let i = 0; i < name.length; i++) {
      const c = StringCharCodeAt(name, i);
      if (c < 0x20 || c === 0x7F) return null;
    }
    const rel = `./node_modules/${name}/package.json`;
    let asUrl;
    try { asUrl = toPath(URLHref(new URLCtor(rel, rootBase))); } catch (e) { return null; }
    if (asUrl !== pathJoin(root, 'node_modules', name, 'package.json')) return null;
    return {__proto__: null, name, subpath: `.${sep === -1 ? '' : StringSlice(spec, sep)}`};
  };

  // the package directory for a name, as Node's packageResolve walks:
  // <dir>/node_modules/<name> for every directory from the parent's up --
  // one named node_modules included (its node_modules/node_modules) --
  // inside the root only (the high review of #465, 1)
  const locate = (name, parentFile) => {
    for (let dir = pathDirname(parentFile); insideRoot(dir); dir = pathDirname(dir)) {
      const pkgDir = pathJoin(dir, 'node_modules', name);
      if (kind(pkgDir) === 1) return pkgDir;
      if (dir === root || dir === pathDirname(dir)) break;
    }
    return null;
  };

  // The package a bare name names from parentFile, as Node's packageResolve
  // finds it: a self-reference first (the parent's own scope, by its name,
  // through its "exports"), then the node_modules walk -> {parsed, self,
  // dir} or null -- the one step packageResolve and packageDir share
  const locatePackage = (spec, parentFile) => {
    const parsed = parseName(spec);
    if (parsed == null) return null;
    const scope = scopeOf(parentFile);
    if (scope === INVALID) return null;
    if (scope != null && own(scope.pkg, 'name') === parsed.name && mapOf(own(scope.pkg, 'exports')) !== undefined) {
      return {__proto__: null, parsed, self: scope.pkg, dir: scope.dir};
    }
    const dir = locate(parsed.name, parentFile);
    return dir == null ? null : {__proto__: null, parsed, self: null, dir};
  };

  // packageResolve -> an answer
  const packageResolve = (spec, parentFile, has) => {
    if (isBuiltin(spec)) return builtinAnswer(spec);
    const found = locatePackage(spec, parentFile);
    if (found == null) return REFUSE;
    const parsed = found.parsed;
    if (found.self != null) {
      const r = exportsResolve(found.dir, parsed.subpath, mapOf(own(found.self, 'exports')), has);
      return r === REFUSE ? REFUSE : finish(r, found.dir);
    }
    const pkgDir = found.dir;
    const pkg = manifestAt(pkgDir);
    if (pkg === INVALID) return REFUSE;
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
    try { r = URLHref(new URLCtor(parsed.subpath, toHref(pathJoin(pkgDir, 'package.json')))); } catch (e) { return REFUSE; }
    return finish(r, pkgDir);
  };

  // packageImportsResolve -> an answer
  const importsResolve = (name, parentFile, has) => {
    if (name === '#' || StringEndsWith(name, '/') || (!HASH_SLASH && StringStartsWith(name, '#/'))) return REFUSE;
    const scope = scopeOf(parentFile);
    if (scope == null || scope === INVALID) return REFUSE;
    const imports = mapOf(own(scope.pkg, 'imports'));
    if (imports == null || typeof(imports) !== 'object' || ArrayIsArray(imports)) return REFUSE;
    const pkgJsonHref = toHref(pathJoin(scope.dir, 'package.json'));
    const m = matchKey(imports, name);
    if (m == null) return REFUSE;
    const r = target(pkgJsonHref, imports[m.key], m.sub, m.pattern, true, has);
    if (r === REFUSE) return REFUSE;
    if (r != null && typeof(r) === 'object' && typeof(r.bare) === 'string') {
      // (a bare target: a built-in, or resolved from the scope's
      // package.json, as Node's packageResolve(target, packageJSONUrl))
      return packageResolve(r.bare, pathJoin(scope.dir, 'package.json'), has);
    }
    return typeof(r) === 'string' ? finish(r, scope.dir) : REFUSE;
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
  // (findPackageJSON) -> {pkgDir, base} or null: base, a file from which
  // Node's own lookup finds the same package without leaving the root (the
  // scope's own directory for a self-reference, the node_modules level
  // otherwise)
  function packageDir(spec, parentFile) {
    const found = locatePackage(spec, parentFile);
    if (found == null) return null;
    const pkgDir = found.dir;
    if (found.self != null) return {__proto__: null, pkgDir, base: pathJoin(pkgDir, '.ch-bare-parent.js'), self: true};
    let level = pkgDir;
    const depth = StringSlice(found.parsed.name, 0, 1) === '@' ? 3 : 2;
    for (let i = 0; i < depth; i++) level = pathDirname(level);
    if (!insideRoot(level)) return null;
    // (a decoy where Node's own walk from that base looks first -- its
    // node_modules/node_modules/<name> -- refused: there alone, as this is
    // where the walk is rebased; the high review of #465, 2)
    if (kind(pathJoin(level, 'node_modules', 'node_modules', found.parsed.name)) >= 0) return null;
    return {__proto__: null, pkgDir, base: pathJoin(level, 'node_modules', '.ch-bare-parent.js')};
  }

  // Whether parentFile's nearest package scope has no "imports" at all (null
  // or absent): a '#' require then falls through to CommonJS's ordinary
  // node_modules lookup, as Node's does (`pkg?.data.imports != null`); an
  // import throws there instead (the high review of #465, 6)
  function noImports(parentFile) {
    const scope = scopeOf(parentFile);
    if (scope === INVALID) return false;
    return scope == null || own(scope.pkg, 'imports') == null;
  }

  // A directory's own package.json, parsed once and kept -- the one read
  // the module's package "type" and its resolution share (the high review
  // of #465, 7) -> {pkg} (pkg null for one that doesn't parse), or null for
  // none
  function manifest(dir) {
    const pkg = manifestAt(dir);
    if (pkg === null) return null;
    return {__proto__: null, pkg: pkg === INVALID ? null : pkg};
  }

  return ObjectFreeze({__proto__: null, resolve, packageDir, noImports, manifest});
}

module.exports = {createResolver};
