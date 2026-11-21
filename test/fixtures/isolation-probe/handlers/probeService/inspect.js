// inspect.js -- one thing module code can see of the runtime, after the
// worker's lockdown (#194's PR 2, test/sandbox/68). Each step returns what it
// found, as text, so the test asserts it in both modes.
const path = require('path');
const util = require('util');
const ROOT = path.resolve(__dirname, '..', '..');
const insideRoot = (f) => typeof(f) === 'string' && (f === ROOT || f.startsWith(ROOT + path.sep));
const M = module.constructor;

// a runtime Module, from the test's probe (module code reaches none: A)
const handle = () => globalThis[Symbol.for('countinghouse.test.runtime')] || null;
const outcome = (fn) => { try { fn(); return 'loaded'; } catch (e) { return String(e.code || e.message); } };

const STEPS = {
  // P alone, and the net: a load with one of the runtime's Modules as its
  // parent, by every route module code has, and one with no parent at all
  netLoad: () => { const h = handle(); return h == null ? 'no handle' : outcome(() => M._load('./node-version.js', h.module)); },
  netRequire: () => { const h = handle(); return h == null ? 'no handle' : outcome(() => h.module.require('./node-version.js')); },
  netModuleLoad: () => {
    const h = handle();
    if (h == null) return 'no handle';
    const file = path.join(path.dirname(h.module.filename), 'node-version.js');
    return outcome(() => { const m = new M(file, h.module); m.load(file); });
  },
  noParent: () => { const h = handle(); return h == null ? 'no handle' : outcome(() => M._load(path.join(path.dirname(h.module.filename), 'node-version.js'))); },
  // the high review of #434, item 2: after the seal every resolution is
  // module code's, a require made for a runtime file by createRequire too:
  // under enforce its 'module' is the reduced one, under audit its watched
  // built-in is reported
  runtimeParentBuiltins: () => {
    const h = handle();
    if (h == null) return 'no handle';
    const req = M.createRequire(path.join(path.dirname(h.module.filename), 'logger.js'));
    const mod = req('module');
    req('dgram');
    return typeof(mod._load) === 'function' ? 'real module' : 'reduced module';
  },
  // #434's Fable pass F1-F3 (enforce): whether a runtime package is
  // installed is no answer, by the whole error (code and message), for a
  // forged parent inside it (Node reads the package.json above a parent's
  // filename natively), findPackageJSON's base in any URL case or a
  // relative specifier that climbs out, and _findPath's array-like paths
  parentPackage: () => {
    const h = handle();
    if (h == null) return 'no handle';
    const root = path.dirname(path.dirname(h.module.filename));
    const nm = path.join(root, 'node_modules');
    const forge = (pkg) => { const f = path.join(nm, pkg, 'lib', 'x.js'); return {__proto__: null, id: f, filename: f, paths: M._nodeModulePaths(path.dirname(f))}; };
    // (each side's own package name masked: the whole error otherwise, code
    // and message)
    const o = (fn, pkg) => { try { return String(fn()).split(pkg).join('PKG'); } catch (e) { return `${e.code}|${e.message}`.split(pkg).join('PKG'); } };
    const same = (a, b, pa = 'sshpk', pb = 'no-such-isolation-pkg') => {
      const x = o(a, pa);
      const y = o(b, pb);
      return x === y ? 'same' : `differs(${x.slice(0, 200)} / ${y.slice(0, 200)})`;
    };
    const out = [];
    // a '#' import, and a self-reference into a runtime package with an
    // exports map (es-errors): Node reads the package.json above the parent
    for (const [pkg, req] of [['sshpk', () => '#nope'], ['es-errors', (p) => `${p}/no-such-export`]]) {
      out.push(same(() => M._resolveFilename(req(pkg), forge(pkg)), () => M._resolveFilename(req('no-such-isolation-pkg'), forge('no-such-isolation-pkg')), pkg));
    }
    if (typeof(M.findPackageJSON) === 'function') {
      const upper = `File://${require('url').pathToFileURL(path.join(root, 'lib', 'logger.js')).href.slice('file://'.length)}`;
      out.push(same(() => M.findPackageJSON('sshpk', upper), () => M.findPackageJSON('no-such-isolation-pkg', upper)));
      const climb = (pkg) => `./${path.relative(__dirname, path.join(nm, pkg)).split(path.sep).join('/')}`;
      out.push(same(() => M.findPackageJSON(climb('sshpk'), __filename), () => M.findPackageJSON(climb('no-such-isolation-pkg'), __filename)));
    } else {
      out.push('same', 'same');
    }
    // (a %-escape is no '..': judged and read as written, so this one finds
    // the module's own package.json, never one above it; the review of
    // e0f39de9)
    if (typeof(M.findPackageJSON) === 'function') {
      const found = M.findPackageJSON('./%2e%2e/%2e%2e/%2e%2e/%2e%2e/', __filename);
      // (by its virtual name: the module's own root's package.json; where
      // this Node throws for a directory that isn't there, as 22.16 and
      // 24.0-24.14 do, nothing, as for a plainly missing one)
      const throwsMissing = M.findPackageJSON('./no-such-isolation-dir/', __filename) === undefined;
      const isOwn = (f) => typeof(f) === 'string' && /^(\/app\/|[A-Z]:\\app\\)package\.json$/.test(f);
      // (and the module's own lookup, from its own file, answers on every
      // Node)
      const here = M.findPackageJSON('./', __filename);
      out.push(isOwn(here) && (isOwn(found) || (throwsMissing && found === undefined)) ? 'same' : `climbed(${String(here)} ${String(found)})`);
    } else {
      out.push('same');
    }
    // (PR 3: a '#' import whose bare target Node looks up above the root,
    // and a lookup path that leaves /app through '..', reaching Node as the
    // literal host path: a runtime-only package and a missing one alike)
    out.push(same(() => require('#p/json-stringify-safe'), () => require('#p/no-such-isolation-pkg'), 'json-stringify-safe'));
    const up = `/app/..${nm.split(path.sep).join('/')}`;
    out.push(same(() => M._findPath('json-stringify-safe', [up]), () => M._findPath('no-such-isolation-pkg', [up]), 'json-stringify-safe'));
    const like = (dir) => ({length: 1, 0: dir});
    out.push(same(() => M._findPath('sshpk', like(nm)), () => M._findPath('no-such-isolation-pkg', like(nm))));
    // a parent named by a virtual name with backslashes (a separator on
    // Windows once on the host: shaped so on every OS), or naming the root
    // itself, whose package.json walk would start above it: the sandbox's
    // own refusal, never Node's answer (the review of #434's round 4, E1/E2)
    for (const filename of ['/app/x\\..\\..\\..\\f.js', '/app']) {
      let said;
      try { M._resolveFilename('#nope', {filename, paths: []}); said = 'found'; } catch (e) { said = `${e.code}|${e.message}`; }
      out.push(/^MODULE_NOT_FOUND\|Cannot find module '#nope' \(countinghouse module sandbox\)$/.test(said) ? 'same' : `answered(${said.slice(0, 160)})`);
    }
    // (a '#' name through Module._resolveFilename called directly: the one
    // refusal the hook gives; the second round on #440)
    out.push(same(() => M._resolveFilename('#p/json-stringify-safe', module), () => M._resolveFilename('#p/no-such-isolation-pkg', module), 'json-stringify-safe'));
    // (... and a bare name refused there has a requireStack of virtual
    // names, as the hook's has)
    let directStack;
    try { M._resolveFilename('no-such-isolation-pkg', module); directStack = 'found'; } catch (e) { directStack = e.requireStack; }
    out.push(Array.isArray(directStack) && directStack.length > 0 && directStack.every((f) => /^(\/app\/|[A-Z]:\\app\\)/.test(f)) ? 'same' : `directStack(${JSON.stringify(directStack)})`);
    // (a refused require keeps a requireStack, of virtual names only: code
    // reading it doesn't break; the high review of #440)
    let stack;
    try { require('no-such-isolation-pkg'); stack = 'found'; } catch (e) { stack = e.requireStack; }
    out.push(Array.isArray(stack) && stack.length > 0 && stack.every((f) => /^(\/app\/|[A-Z]:\\app\\)/.test(f)) ? 'same' : `stack(${JSON.stringify(stack)})`);
    // a primitive parent, whose filename Node would read off its prototype
    // (the review of e0f39de9): a number, a string, a boolean
    for (const [proto, prim] of [[Number.prototype, 1], [String.prototype, 'x'], [Boolean.prototype, true]]) {
      const run = (pkg) => {
        Object.defineProperty(proto, 'filename', {configurable: true, value: path.join(nm, pkg, 'lib', 'x.js')});
        Object.defineProperty(proto, 'paths', {configurable: true, value: M._nodeModulePaths(path.join(nm, pkg, 'lib'))});
        try { return M._resolveFilename(`${pkg}/no-such-export`, prim); } finally { delete proto.filename; delete proto.paths; }
      };
      out.push(same(() => run('es-errors'), () => run('no-such-isolation-pkg'), 'es-errors'));
    }
    return out.join(' ');
  },
  // The reduced module's confined statics (enforce; the compatibility PR):
  // lookup paths only for a virtual directory inside the root, only those
  // inside it; a resolution through the file broker's confined
  // _resolveFilename, answered by a virtual name, never a host path, with
  // every refusal enforce has (outside the root, a primitive or odd parent,
  // the one refusal for a bare or '#' name it can't resolve)
  reducedStatics: () => {
    const R = require('module');
    if (typeof(R._nodeModulePaths) !== 'function' || typeof(R._resolveFilename) !== 'function') return 'not reduced';
    const h = handle();
    const root = h != null ? path.dirname(path.dirname(h.module.filename)) : null;
    const out = [];
    const lookups = R._nodeModulePaths(__dirname);
    out.push(lookups.length > 0 && lookups.every((p) => /^(\/app(\/|$)|[A-Z]:\\app)/.test(p)) ? 'virtual' : `paths(${lookups.join(',')})`);
    out.push(R._nodeModulePaths('/etc').length === 0 && (root == null || R._nodeModulePaths(root).length === 0) && R._nodeModulePaths('/app/../etc').length === 0 ? 'none' : 'outside');
    const parent = {id: __filename, filename: __filename, paths: lookups};
    let own;
    try { own = R._resolveFilename('../../lib/data.json', parent); } catch (e) { own = `threw ${e.code}`; }
    out.push(/^(\/app\/|[A-Z]:\\app\\)lib[\\/]data\.json$/.test(own) ? 'own' : `own(${own})`);
    const whole = (fn, name) => { try { fn(); return 'found'; } catch (e) { return `${e.code}|${e.message}`.split(name).join('NAME'); } };
    const refusal = (fn) => {
      try { fn(); return 'found'; } catch (e) { return /\(countinghouse module sandbox\)$/.test(String(e.message)) && e.code === 'MODULE_NOT_FOUND' ? 'refused' : `${e.code}|${String(e.message).slice(0, 80)}`; }
    };
    out.push(refusal(() => R._resolveFilename('x', 1)));
    out.push(refusal(() => R._resolveFilename('./x', {filename: '/app/../etc/f.js', paths: []})));
    out.push(refusal(() => R._resolveFilename('./x', {filename: '/app', paths: []})));
    // (a path outside the root answers as a missing one: by the whole error)
    out.push(root == null ? 'no handle' : (whole(() => R._resolveFilename(path.join(root, 'lib', 'node-version.js'), parent), 'node-version.js') ===
      whole(() => R._resolveFilename(path.join(root, 'lib', 'no-such-isolation.js'), parent), 'no-such-isolation.js') ? 'same' : 'differs'));
    out.push(whole(() => R._resolveFilename('json-stringify-safe', parent), 'json-stringify-safe') === whole(() => R._resolveFilename('no-such-isolation-pkg', parent), 'no-such-isolation-pkg') ? 'same' : 'differs');
    out.push(whole(() => R._resolveFilename('#p/json-stringify-safe', parent), 'json-stringify-safe') === whole(() => R._resolveFilename('#p/no-such-isolation-pkg', parent), 'no-such-isolation-pkg') ? 'same' : 'differs');
    return out.join(' ');
  },
  // F4 (#194's PR 3): an import() from an ES module is no existence oracle
  // (C-bare, Fable's pass on #452: a bare name's subpath, or a '#' mapping
  // to one, never walks or stats above the root; a package found above it
  // and one missing give one answer, and nothing of module code's runs
  // inside Node's step while it looks)
  // C-bare R0: a bare require is CommonJS's own lookup, every disk access
  // on it judged. An "exports" target climbing out by '%2e' (plain Node:
  // the file beside the root) reads as a missing name, by the whole error;
  // an import of it the same; a self-reference from deep in the tree finds
  // the root's package.json, never the one above the root.
  cjsJudged: async () => {
    const out = [];
    const o = (fn, pkg) => { try { fn(); return 'found'; } catch (e) { return `${e.code}|${e.message}`.split(pkg).join('PKG'); } };
    const same = (tag, a, b) => out.push(a === b ? 'same' : `${tag}(${a.slice(0, 200)} / ${b.slice(0, 200)})`);
    same('requireClimb', o(() => require('dep6/e'), 'dep6'), o(() => require('nosuchdep6/e'), 'nosuchdep6'));
    same('resolveClimb', o(() => require.resolve('dep6/e'), 'dep6'), o(() => require.resolve('nosuchdep6/e'), 'nosuchdep6'));
    const oi = async (spec, pkg) => { try { await import(spec); return 'found'; } catch (e) { return `${e.code}|${e.message}`.split(pkg).join('PKG'); } };
    same('importClimb', await oi('dep6/e', 'dep6'), await oi('nosuchdep6/e', 'nosuchdep6'));
    const deep = require('../../lib/deep/a/b/c/self.js');
    out.push(deep('isolation-probe/self-check') === 'counted' ? 'same' : `ownSelf(${deep('isolation-probe/self-check')})`);
    same('outerSelf', deep('outer-self').split('outer-self').join('PKG'), deep('no-such-outer').split('no-such-outer').join('PKG'));
    // (a require by CommonJS's own test: '..foo/...' is a relative path,
    // which loads; 'a:b/...' a bare name, whose climbing subpath is refused
    // as any bare name's is)
    out.push(o(() => require('..foo/../../../lib/stat-count.js'), 'x') === 'found' ? 'same' : `dotdotRelative(${o(() => require('..foo/../../../lib/stat-count.js'), 'x').slice(0, 200)})`);
    // (the climbing pairs: the 'a:b' side refused -- never found, which
    // plain Node on POSIX answers for either side (on Windows 'a:b' is
    // drive-relative, so there the pair's equality is what catches it) --
    // and by the same whole error as a missing name's climb)
    const refusedPair = (tag, a, b) => out.push(!a.startsWith('found') && a === b ? 'same' : `${tag}(${a.slice(0, 200)} / ${b.slice(0, 200)})`);
    refusedPair('urlishClimb', o(() => require('a:b/../../lib/stat-count.js'), 'a:b'), o(() => require('nosuchdep/../../lib/stat-count.js'), 'nosuchdep'));
    // (the same by require.resolve, and by a direct Module._resolveFilename
    // below: these pin the behaviour by each route module code has, not one
    // layer -- on 24.21, with the direct wrapper's own line reverted, both
    // still refused: another layer of identity's answers first)
    out.push(o(() => require.resolve('..foo/../../../lib/stat-count.js'), 'x') === 'found' ? 'same' : `dotdotResolve(${o(() => require.resolve('..foo/../../../lib/stat-count.js'), 'x').slice(0, 200)})`);
    refusedPair('urlishResolve', o(() => require.resolve('a:b/../../lib/stat-count.js'), 'a:b'), o(() => require.resolve('nosuchdep/../../lib/stat-count.js'), 'nosuchdep'));
    out.push(o(() => M._resolveFilename('..foo/../../../lib/stat-count.js', module), 'x') === 'found' ? 'same' : `dotdotDirect(${o(() => M._resolveFilename('..foo/../../../lib/stat-count.js', module), 'x').slice(0, 200)})`);
    refusedPair('urlishDirect', o(() => M._resolveFilename('a:b/../../lib/stat-count.js', module), 'a:b'), o(() => M._resolveFilename('nosuchdep/../../lib/stat-count.js', module), 'nosuchdep'));
    // (#465's Fable pass, F1: a request that is no string -- a String
    // object, an object with its own toString -- is refused by a direct
    // Module._resolveFilename and answers nothing from findPackageJSON,
    // after the seal, with nothing of module code's run to make it one)
    {
      let ran = 0;
      const tricky = {toString() { ran++; return '#p/sshpk/package.json'; }};
      const codeOf = (fn) => { try { fn(); return 'found'; } catch (e) { return String(e.code); } };
      const direct = [codeOf(() => M._resolveFilename(new String('#p/sshpk/package.json'), module)), codeOf(() => M._resolveFilename(tricky, module))];
      const findOf = (fn) => { try { return String(fn()); } catch (e) { return String(e.code); } };
      const finds = typeof(M.findPackageJSON) === 'function' ? [findOf(() => M.findPackageJSON(new String('sshpk'), __filename)), findOf(() => M.findPackageJSON(tricky, __filename)),
        findOf(() => M.findPackageJSON('sshpk', {toString() { ran++; return __filename; }}))] : ['undefined', 'undefined', 'undefined'];
      out.push(direct.every((c) => c === 'ERR_INVALID_ARG_TYPE') && finds.every((f) => f === 'undefined') && ran === 0 ? 'same' : `nonString(${direct.join(',')} ${finds.join(',')} ran ${ran})`);
    }
    // (the high review of #465, 6: a '#' require from a scope with no
    // "imports" falls through to node_modules, as Node's CommonJS lookup
    // does; one from a scope with "imports" is resolved there)
    {
      const fromSelfScope = require('../../lib/selfscope/req.js');
      const hash = fromSelfScope('#hashpkg');
      out.push(hash === 'hash' ? 'same' : `hashFallsThrough(${hash})`);
    }
    // (the high review of #465, 5: '#cond' by a direct call and by the
    // hook, the same target, as Node's own CommonJS conditions pick it)
    {
      const base = (fn) => { try { return path.basename(String(fn())); } catch (e) { return String(e.code); } };
      const direct = base(() => M._resolveFilename('#cond', module));
      const hooked = base(() => require.resolve('#cond'));
      // (Node's own answer on every line here: require(esm) is on, so its
      // CommonJS conditions hold 'module-sync', which comes first)
      out.push(direct === 'cond-ms.js' && hooked === 'cond-ms.js' ? 'same' : `conditions(${direct} / ${hooked})`);
    }
    // (#465's Fable pass, F4: findPackageJSON of the module's own name,
    // a self-reference through its "exports", answers its own package.json)
    if (typeof(M.findPackageJSON) === 'function') {
      let own;
      try { own = String(M.findPackageJSON('isolation-probe/self-check', __filename)); } catch (e) { own = String(e.code); }
      out.push(/\/app\/package\.json$|\\app\\package\.json$/.test(own) ? 'same' : `selfFind(${own})`);
    } else out.push('same');
    // (the high review of #465, round 3, item 1: a package.json read for a
    // resolution runs nothing of module code's -- Buffer.prototype.toString,
    // Buffer.from and Object.assign replaced here are never called while a
    // '#' name resolves from a scope no resolution has read yet)
    {
      let calls = 0;
      const realToString = Buffer.prototype.toString;
      const realFrom = Buffer.from;
      const realAssign = Object.assign;
      Buffer.prototype.toString = function(...a) { calls++; return realToString.apply(this, a); };
      Buffer.from = function(...a) { calls++; return realFrom.apply(this, a); };
      Object.assign = function(...a) { calls++; return realAssign.apply(this, a); };
      let got;
      try {
        try { got = path.basename(String(M._resolveFilename('#f', {filename: '/app/lib/fresh2/x.js', paths: []}))); } catch (e) { got = String(e.code); }
      } finally { Buffer.prototype.toString = realToString; Buffer.from = realFrom; Object.assign = realAssign; }
      out.push(calls === 0 && got === 'f.js' ? 'same' : `moduleCodeInRead(${calls} ${got})`);
    }
    // (K1, ruled after #465's round 3: after the seal findPackageJSON takes
    // a primitive string alone -- any object, a real URL included, answers
    // nothing, and none of its code runs: not a Proxy's traps in its
    // prototype chain, not a URL's searchParams.toString, which the href
    // getter calls once the params are marked changed)
    if (typeof(M.findPackageJSON) === 'function') {
      let ran = 0;
      const count = (k) => (...a) => { ran++; return Reflect[k](...a); };
      const handler = {};
      ['get', 'has', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'ownKeys'].forEach((k) => { handler[k] = count(k); });
      const odd = Object.create(new Proxy(URL.prototype, handler));
      const dirty = new URL(require('url').pathToFileURL(__filename).href);
      Object.defineProperty(dirty.searchParams, 'toString', {value() { ran++; return 'q=1'; }});
      URLSearchParams.prototype.append.call(dirty.searchParams, 'a', 'b');
      const plain = require('url').pathToFileURL(__filename);
      const bare = Object.setPrototypeOf(require('url').pathToFileURL(__filename), null);
      const answers = [];
      for (const [spec, base] of [[odd, __filename], ['./', odd], [dirty, __filename], ['./', dirty], [plain, __filename], ['./', plain], [bare, __filename], ['./', bare]]) {
        try { answers.push(String(M.findPackageJSON(spec, base))); } catch (e) { answers.push(String(e.code)); }
      }
      const all = answers.every((x) => x === 'undefined');
      out.push(ran === 0 && all ? 'same' : `objectInFind(${ran} ${answers.join(',')})`);
    } else out.push('same');
    // (C-compat, item 6: '..c6x/y' is relative to CommonJS, a directory
    // named '..c6x' beside this file: missing, it fails in the words a
    // missing './c6x/y' does, never as a bare name refused)
    {
      const said = (req) => { try { require(req); return 'found'; } catch (e) { return `${e.code} ${String(e.message).split('\n')[0].replace(req, 'R')}`; } };
      const a = said('./no-such-c6x/y');
      const b = said('..no-such-c6x/y');
      out.push(a === b ? 'same' : `dotDotName(${a} | ${b})`);
    }
    // (#465's Fable pass, F2 and F3: a require whose parent is the root
    // itself -- createRequire('/app') -- is refused before Node, as a missing
    // name is, while createRequire('/app/'), a directory, still requires
    // from it; an empty specifier is refused by import as a missing name is,
    // and findPackageJSON answers nothing for it)
    {
      const req = M.createRequire('/app');
      const errOf = (fn) => { try { fn(); return 'found'; } catch (e) { return String(e.code); } };
      const rootParent = [errOf(() => req('outer-self')), errOf(() => req('no-such-outer'))];
      const fromDir = errOf(() => M.createRequire('/app/')('./lib/stat-count.js'));
      const emptyImport = await oi('', 'x');
      const missingImport = (await oi('no-such-empty-control', 'no-such-empty-control')).split('PKG').join('');
      let emptyFind = 'undefined';
      if (typeof(M.findPackageJSON) === 'function') { try { emptyFind = String(M.findPackageJSON('', __filename)); } catch (e) { emptyFind = String(e.code); } }
      const ok = rootParent[0] === rootParent[1] && rootParent[0] !== 'found' && fromDir === 'found' && emptyImport.split('|')[0] === missingImport.split('|')[0] && emptyFind === 'undefined';
      out.push(ok ? 'same' : `rootOrEmpty(${rootParent.join(',')} ${fromDir} ${emptyImport.slice(0, 80)} / ${missingImport.slice(0, 80)} ${emptyFind})`);
    }
    // (a bare name with a ':' URL parsing rejects -- bare to Node -- above
    // the root against a missing one, by import, findPackageJSON and
    // require; POSIX, where a file name can hold one)
    if (process.platform !== 'win32') {
      same('colonImport', await oi('co_lon:pkg', 'co_lon:pkg'), await oi('noco_lon:pkg', 'noco_lon:pkg'));
      if (typeof(M.findPackageJSON) === 'function') {
        same('colonFind', o(() => String(M.findPackageJSON('co_lon:pkg', __filename)), 'co_lon:pkg'), o(() => String(M.findPackageJSON('noco_lon:pkg', __filename)), 'noco_lon:pkg'));
      } else out.push('same');
      same('colonRequire', o(() => require('co_lon:pkg'), 'co_lon:pkg'), o(() => require('noco_lon:pkg'), 'noco_lon:pkg'));
      // (and it is the in-root resolver that answers such a name, never
      // Node's walk: one with a node_modules/node_modules copy imports as
      // dep2 does, the copy Node's walk takes; and findPackageJSON, rebased
      // to its level, answers nothing for it as for dep2, where Node's own
      // findPackageJSON would name one)
      same('colonDecoy', await oi('co_lon:dec', 'co_lon:dec'), await oi('dep2', 'dep2'));
      if (typeof(M.findPackageJSON) === 'function') {
        same('colonDecoyFind', o(() => String(M.findPackageJSON('co_lon:dec', __filename)), 'co_lon:dec'), o(() => String(M.findPackageJSON('dep2', __filename)), 'dep2'));
      } else out.push('same');
    } else out.push('same', 'same', 'same', 'same', 'same');
    return out.join(' ');
  },
  // C-bare R0's layers past the judged _stat, each pinned alone by a
  // route only it stands on. A link inside the root (made by the test after
  // the load) to the file beside the root passes the lexical stat, and
  // Node's realpath answers outside:
  // - findPath: a direct Module._findPath of a package whose index.js is
  //   the link -- the _findPath wrapper's answer check alone
  // - direct: a direct _resolveFilename of the root's own export that is
  //   the link (trySelf's answer never passes _findPath) -- the direct
  //   call's answer check alone
  // - hook: a require of another such export -- the require hook's
  //   bound() alone
  // each a missing name (a missing file, by the whole error)
  linkLayers: () => {
    const o = (fn, pkg) => { try { const r = fn(); return r === false ? 'false' : `found ${String(r)}`; } catch (e) { return `${e.code}|${e.message}`.split(pkg).join('PKG'); } };
    const out = [];
    const pair = (tag, a, b) => out.push(a === b ? 'same' : `${tag}(${a.slice(0, 200)} / ${b.slice(0, 200)})`);
    pair('findPath', o(() => M._findPath('linkpkg', module.paths), 'linkpkg'), o(() => M._findPath('nosuchlink', module.paths), 'nosuchlink'));
    pair('direct', o(() => M._resolveFilename('isolation-probe/link-self', module), 'link-self'), o(() => M._resolveFilename('isolation-probe/link-none', module), 'link-none'));
    pair('hook', o(() => require('isolation-probe/link-self2'), 'link-self2'), o(() => require('isolation-probe/link-none2'), 'link-none2'));
    return out.join(' ');
  },
  bareSubpath: async () => {
    const out = [];
    const tryImport = async (spec) => { try { await import(spec); return 'found'; } catch (e) { return String(e.code); } };
    const tryRequire = (spec) => { try { require(spec); return 'found'; } catch (e) { return String(e.code); } };
    const same = (tag, a, b) => out.push(a === b ? 'same' : `${tag}(${a}/${b})`);
    // (a sibling above the root against a missing one, climbing back to the
    // module's own file)
    same('importSibling', await tryImport('sibpkg/../../isolation-probe/lib/bare-target.mjs'), await tryImport('nosuchsib/../../isolation-probe/lib/bare-target.mjs'));
    same('importMapped', await tryImport('#sibclimb'), await tryImport('#nosibclimb'));
    same('requireMapped', tryRequire('#sibclimb'), tryRequire('#nosibclimb'));
    // (a package scope inside the root named as the sibling, its "exports"
    // null: no self-reference, so the one answer again)
    const selfTry = require('../../lib/selfscope/try.js');
    same('nullExports', await selfTry('sibpkg/../../isolation-probe/lib/bare-target.mjs'), await selfTry('nosuchsib/../../isolation-probe/lib/bare-target.mjs'));
    // (a '#' mapping as plain Node resolves it: to a bare built-in name
    // loads; to a 'node:' URL is an invalid target (ERR_INVALID_PACKAGE_
    // TARGET in plain Node on 22.16, 24 and 26); an array's first valid
    // target loads)
    out.push((await tryImport('#bare')) === 'found' && tryRequire('#bare') === 'found' && (await tryImport('#builtin')) !== 'found' &&
      (await tryImport('#fallback')) === 'found' ? 'same' : 'mapped');
    // (a subpath climbing out of the module's own dependency: no getter of
    // module code's runs inside Node's step)
    let ran = 'not run';
    Object.defineProperty(Object.prototype, 'WATCH_REPORT_DEPENDENCIES', {configurable: true, get() { ran = 'ran'; return undefined; }});
    try {
      await tryImport('dep/../../../../no-such-climb.mjs');
      tryRequire('dep/../../../../no-such-climb.js');
      tryRequire('dep/x?/../../../../../no-such-climb.js');
      tryRequire('dep\\..\\..\\..\\..\\no-such-climb.js');
    } finally { delete Object.prototype.WATCH_REPORT_DEPENDENCIES; }
    out.push(ran === 'not run' ? 'same' : 'ranInStep');
    // (a backslash spelling of a climbing subpath is the one refusal too)
    out.push(tryRequire('dep\\..\\..\\lib\\bare-target.mjs') === tryRequire('nosuchdep\\..\\..\\lib\\bare-target.mjs') ? 'same' : 'backslash');
    // (a getter on Object.prototype named as the lookup's own fields never
    // runs inside the hook, and changes nothing)
    let protoRan = 'not run';
    const fields = ['specifier', 'from', 'file', 'refuse', 'asIs'];
    for (const f of fields) Object.defineProperty(Object.prototype, f, {configurable: true, get() { protoRan = `ran ${f}`; return undefined; }});
    let protoOutcome;
    try { protoOutcome = await tryImport('#fallback'); } finally { for (const f of fields) delete Object.prototype[f]; }
    out.push(protoRan === 'not run' && protoOutcome === 'found' ? 'same' : `proto(${protoRan} ${protoOutcome})`);
    // (a package with a node_modules/node_modules copy beside it loads the
    // one Node's walk takes from here, the real one; the high review of
    // #465, 2)
    { let real; try { real = (await import('dep2')).default; } catch (e) { real = String(e.code); } out.push(real === 'real' ? 'same' : `decoy(${real})`); }
    // (an import from a script given a filename outside the root: judged
    // from the root, never walked from there)
    const vm = require('vm');
    const fromOutside = async (spec) => {
      try { await vm.runInThisContext(`import(${JSON.stringify(spec)})`, {filename: '/nowhere.invalid/x.js', importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER}); return 'found'; } catch (e) { return String(e.code); }
    };
    same('outsideParent', await fromOutside('sibpkg/../../isolation-probe/lib/bare-target.mjs'), await fromOutside('nosuchsib/../../isolation-probe/lib/bare-target.mjs'));
    // (targets picked as Node picks them: an empty array is no target, as
    // plain Node answers on 22.16, 24 and 26; an invalid segment falls to
    // the array's next entry)
    out.push((await tryImport('#emptyArr')) !== 'found' && (await tryImport('#badFirst')) === 'found' ? 'same' : 'targets');
    // ("exports" false is none, as Node's reader takes it: a climbing
    // subpath under it the one refusal)
    same('exportsFalse', await tryImport('dep3/../../lib/bare-target.mjs'), await tryImport('nosuchdep/../../lib/bare-target.mjs'));
    // (a pattern with an empty segment loads, as in Node; an array of
    // invalid targets falls to no other condition)
    out.push((await tryImport('#pat//x.mjs')) === 'found' && (await tryImport('#z')) !== 'found' ? 'same' : 'patterns');
    // (a parent named as a countinghouse file is judged from the root: a
    // runtime package's presence is no answer)
    const h = handle();
    const runtimeLib = h != null ? path.join(path.dirname(path.dirname(h.module.filename)), 'lib', 'any.js') : null;
    const fromRuntime = async (spec) => {
      try { await require('vm').runInThisContext(`import(${JSON.stringify(spec)})`, {filename: runtimeLib, importModuleDynamically: require('vm').constants.USE_MAIN_CONTEXT_DEFAULT_LOADER}); return 'found'; } catch (e) { return String(e.code); }
    };
    same('runtimeParent', await fromRuntime('mocha/../../node_modules/.ch-sb-68 probe/isolation-probe/lib/bare-target.mjs'),
      await fromRuntime('nosuchpkg/../../node_modules/.ch-sb-68 probe/isolation-probe/lib/bare-target.mjs'));
    // (a direct Module._resolveFilename call with a '#' name, which Node
    // 24.15 and later run no hook for: one answer for a sibling above the
    // root and a missing one)
    const direct = (spec) => { try { M._resolveFilename(spec, module); return 'found'; } catch (e) { return String(e.code); } };
    same('directMapped', direct('#sibclimb'), direct('#nosibclimb'));
    // (findPackageJSON of a bare name: the module's own dependency's, found
    // inside the root -- for a subpath too, its root manifest, as plain Node
    // answers -- from a file or a directory base; one above it is nothing)
    const fpj = M.findPackageJSON;
    const asDir = require('url').pathToFileURL(`${path.dirname(__filename)}/`).href;
    out.push(typeof(fpj) !== 'function' ||
      (String(fpj('dep', __filename)).endsWith('/node_modules/dep/package.json') && String(fpj('dep', asDir)).endsWith('/node_modules/dep/package.json') &&
       String(fpj('dep/esm/x.mjs', __filename)).endsWith('/node_modules/dep/package.json') && fpj('sibpkg', __filename) === undefined) ? 'same' : `findPackageJSON(${fpj('dep', asDir)} ${fpj('dep/esm/x.mjs', __filename)})`);
    // (a '#' target is an exact file, as in Node: none with no extension)
    out.push(direct('#noext') !== 'found' ? 'same' : 'noext');
    // (findPackageJSON of a '#' name, one mapped to a built-in too, is
    // nothing; a bare name holding '?' or '#', which Node's URL lookup would
    // cut short and climb with, is the one refusal, as a missing one)
    out.push(typeof(fpj) !== 'function' || (fpj('#builtin', __filename) === undefined && fpj('#sibclimb', __filename) === undefined) ? 'same' : 'fpjMapped');
    same('queryName', await tryImport('q?x/index.js'), await tryImport('nosuchq/index.js'));
    same('tabName', await tryImport('t\tx/index.js'), await tryImport('nosucht/index.js'));
    // (a subpath whose URL names another path -- a tab the URL parser drops
    // -- under an "exports" pattern, is refused, never carried by it into a
    // sibling package; a plain subpath under it loads)
    out.push((await tryImport('dep4/index.js')) === 'found' && (await tryImport('dep4/.\t./dep/index.js')) !== 'found' ? 'same' : 'exportsSubpath');
    // (Reflect.apply replaced by module code: the in-root resolver calls
    // its own, so no host path ever reaches it)
    const realApply = Reflect.apply;
    let hostSeen = false;
    Reflect.apply = function(fn, self, args) {
      for (const a of [self].concat(Array.from(args || []))) if (typeof(a) === 'string' && a.includes('ch-sb-68')) hostSeen = true;
      return realApply(fn, self, args);
    };
    try { await tryImport('dep'); await tryImport('#fallback'); } finally { Reflect.apply = realApply; }
    out.push(hostSeen ? 'reflectApply' : 'same');
    // (require.resolve with options.paths looks a bare name up from those,
    // as a plugin loader does; a direct Module._resolveFilename from module
    // code fails closed for any name, the virtual-paths compat gap)
    let viaPaths;
    try { viaPaths = require.resolve('dep5', {paths: ['/app/node_modules/dep']}); } catch (e) { viaPaths = `threw ${e.code}`; }
    out.push(String(viaPaths).endsWith('/node_modules/dep5/index.js') ? 'same' : `paths(${viaPaths})`);
    // (and the module's own dependency still loads, by name and by subpath)
    out.push((await tryImport('dep')) === 'found' && (await tryImport('dep/index.js')) === 'found' && tryRequire('dep') === 'found' &&
      tryRequire('filedep') === 'found' ? 'same' : 'ownDep');
    return out.join(' ');
  },
  importOracle: async () => {
    const h = handle();
    if (h == null) return 'no handle';
    const root = path.dirname(path.dirname(h.module.filename));
    // (and from a vm script given a runtime file's name and Node's
    // main-context loader, so its parent is the runtime's: the high review
    // of #440)
    const vm = require('vm');
    const viaVm = async (spec, name) => {
      try {
        await vm.runInThisContext(`import(${JSON.stringify(spec)})`, {filename: path.join(root, 'lib', 'logger.js'), importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
        return 'found';
      } catch (e) { return `${e.code}|${e.message}`.split(name).join('NAME'); }
    };
    const vmSame = (await viaVm('json-stringify-safe', 'json-stringify-safe')) === (await viaVm('no-such-isolation-pkg', 'no-such-isolation-pkg')) ? 'same' : 'differs';
    // (the third round on #440: from that claimed CommonJS parent, a
    // lowercase file: URL is an import, judged: a runtime file, a missing
    // one, a runtime directory and an encoded separator give one answer
    // each, the first three the one refusal)
    const fileUrl = (rel) => require('url').pathToFileURL(path.join(root, rel)).href;
    const claimed = [
      await viaVm(fileUrl('lib/node-version.js'), fileUrl('lib/node-version.js')),
      await viaVm(fileUrl('lib/no-such-isolation.js'), fileUrl('lib/no-such-isolation.js')),
      await viaVm(fileUrl('lib'), fileUrl('lib'))
    ];
    const claimedSame = claimed.every((c) => c === claimed[0]) && /^ERR_MODULE_NOT_FOUND\|.*countinghouse module sandbox/.test(claimed[0]) ? 'same' : `claimed(${claimed.join(' / ')})`;
    const encoded = [await viaVm(`${fileUrl('lib')}/a%2Fb.js`, 'a%2Fb.js'), await viaVm(`${fileUrl('lib')}/node-version%2F.js`, 'node-version%2F.js')];
    const encodedSame = encoded.every((c) => /^ERR_INVALID_MODULE_SPECIFIER\|/.test(c)) && encoded[0].split('|')[0] === encoded[1].split('|')[0] ? 'same' : `encodedClaimed(${encoded.join(' / ')})`;
    // (a bare name holding a ':' that is no URL, and the empty name: the
    // one refusal, never Node's walk above the root)
    const colonBare = (await viaVm('json-stringify-safe/nope.js?a:b', 'json-stringify-safe')) === (await viaVm('no-such-isolation-pkg/nope.js?a:b', 'no-such-isolation-pkg')) ? 'same' : 'colonBare';
    // (Module._resolveFilename called directly with a runtime file's path,
    // against a missing one)
    const direct = (name) => { try { M._resolveFilename(path.join(root, 'lib', name), module); return 'found'; } catch (e) { return `${e.code}|${e.message}`.split(name).join('NAME'); } };
    const directSame = direct('node-version.js') === direct('no-such-isolation.js') ? 'same' : `direct(${direct('node-version.js')} / ${direct('no-such-isolation.js')})`;
    // (The _stat PR. A package.json "main" leading outside the module root
    // is refused at load under enforce, sandbox 03: what is left to see at
    // run time is that Node's own walk is judged, and what it gives module
    // code.)
    const unlike = [];
    const loadOf = (r) => { try { return String(require(r)); } catch (e) { return `threw ${e.code}`; } };
    // (the root by its virtual name: its own index, never the file beside
    // the root, which Node tries with each extension first)
    const byApp = loadOf('/app');
    if (byApp !== 'root') unlike.push(`app ${byApp}`);
    // (a warning Node emits on its walk -- an invalid "main" inside the
    // root, naming nothing -- is not emitted to module code at all; any
    // other names no host path)
    const heard = [];
    const listen = (w) => heard.push(String(w && w.message));
    process.on('warning', listen);
    const warnLoad = loadOf('../../lib/main-warn');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    process.removeListener('warning', listen);
    const warnedHost = heard.join(' ').match(/(?<=^|[\s"'(])(?:file:\/\/)?\/[^\s'"]+/g) || [];
    const hostInWarning = warnedHost.filter((p) => !/^(file:\/\/)?\/([A-Za-z]:\/)?app(\/|$)/.test(p));
    if (hostInWarning.length > 0 || warnLoad !== 'warned' || heard.some((m) => /main/i.test(m))) unlike.push(`warning ${warnLoad} ${heard.length} ${hostInWarning.join(',')}`);
    // (and module code may still set process.emitWarning: its own call
    // reaches what it set at once, with the arguments it gave)
    const emitWas = process.emitWarning;
    let setHeard = null;
    try { process.emitWarning = function(w, type) { setHeard = `${w} ${type}`; }; } catch (e) { setHeard = `threw ${e.name}`; }
    process.emitWarning(`probe ${__filename}`, 'ProbeWarning');
    process.emitWarning = emitWas;
    if (setHeard !== `probe ${__filename} ProbeWarning`) unlike.push(`setEmit ${setHeard}`);
    // (Node's ES resolver, on a target it doesn't find, calls process.send
    // with its host path when WATCH_REPORT_DEPENDENCIES is set: module code
    // can set the variable, never process.send, so nothing of its own runs
    // inside Node's step; Fable's pass on #451, F2)
    let sent = 'not called';
    const envWas = process.env.WATCH_REPORT_DEPENDENCIES;
    process.env.WATCH_REPORT_DEPENDENCIES = '1';
    try { process.send = (m) => { sent = JSON.stringify(m); }; } catch (e) { /* held */ }
    try { await import('../../lib/no-such-watch-target.mjs'); } catch (e) { /* missing */ }
    if (envWas === undefined) delete process.env.WATCH_REPORT_DEPENDENCIES; else process.env.WATCH_REPORT_DEPENDENCIES = envWas;
    if (sent !== 'not called') unlike.push(`sent ${sent}`);
    // (the root itself by require: its own index)
    let rootLoad;
    try { rootLoad = `${require('../..')}`; } catch (e) { rootLoad = `threw ${e.code} ${e.message}`; }
    // (module code run inside the hook -- a getter on its own module's
    // paths, read while a require resolves -- never runs there: the hook
    // reads own data only; the review of 1ed50454)
    let inside = 'not run';
    const pathsWas = Object.getOwnPropertyDescriptor(module, 'paths');
    Object.defineProperty(module, 'paths', {configurable: true, get() { try { inside = String(M._findPath('main-warn', ['/app/lib'])); } catch (e) { inside = `threw ${e.code}`; } return pathsWas.value; }});
    try { require('no-such-isolation-pkg'); } catch (e) { /* refused */ }
    Object.defineProperty(module, 'paths', pathsWas);
    // (Node's own walk calls identity's Module._stat wrapper: a fresh own
    // file required raises the count)
    const before = h.statCalls();
    let counted;
    try { counted = require('../../lib/stat-count.js'); } catch (e) { counted = `threw ${e.code}`; }
    const statWalk = counted === 'counted' && h.statCalls() > before ? 'walked' : `statCalls ${before} -> ${h.statCalls()} (${counted})`;
    // (and an own package with only a nested outside "main" loads: only a
    // top-level one is Node's)
    const nested = loadOf('../../lib/main-in-nested');
    const mainSame = unlike.length === 0 && nested === 'nested' && rootLoad === 'root' && inside === 'not run' && statWalk === 'walked'
      ? 'same' : `main(${unlike.join(' | ')} / ${nested} / ${rootLoad} / inside ${inside} / ${statWalk})`;
    let empty;
    try { await import(''); empty = 'found'; } catch (e) { empty = `${e.code}|${e.message}`; }
    const emptySame = /^ERR_MODULE_NOT_FOUND\|Cannot find module '' \(countinghouse module sandbox\)$/.test(empty) ? 'same' : `empty(${empty})`;
    // (a vm script with no filename: a relative name climbing from the
    // working directory, /app, to a runtime file, against a missing one; the
    // second round on #440)
    const noName = async (rel, name) => {
      try {
        await vm.runInThisContext(`import(${JSON.stringify(rel)})`, {importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
        return 'found';
      } catch (e) { return `${e.code}|${e.message}`.split(name).join('NAME'); }
    };
    const climb = (name) => `${'../'.repeat(24)}${path.join(root, 'lib', name).replace(/^\//, '')}`;
    const noNameSame = (await noName(climb('node-version.js'), 'node-version.js')) === (await noName(climb('no-such-isolation.js'), 'no-such-isolation.js')) ? 'same' : 'differs';
    // (... and with a ':' in a segment, which is no URL scheme in a relative
    // name; the review of the second round)
    const colonSame = (await noName(`./x:y/${climb('node-version.js')}`, 'node-version.js')) === (await noName(`./x:y/${climb('no-such-isolation.js')}`, 'no-such-isolation.js')) ? 'same' : 'differs';
    // (... and a missing one's error names no host path: every path in it
    // is a virtual one)
    // (and an encoded separator's refusal there, whose base Node would
    // take as the host's working directory)
    const missing = `${await noName('./no-such-isolation.mjs', 'no-such-isolation.mjs')} ${await noName('./a%2Fb.mjs', 'a%2Fb.mjs')}`;
    const hostNamed = (missing.match(/(?<=^|[\s"'(|])(?:file:\/\/)?\/[^\s'"]+/g) || []).filter((p) => !/^(file:\/\/)?\/([A-Za-z]:\/)?app(\/|$)/.test(p));
    const virtualOnly = hostNamed.length === 0 ? 'same' : `host(${hostNamed.join(',')})`;
    return `${await (await import('../../lib/import-oracle.mjs')).default(root)} ${await require('../../lib/import-url-oracle.cjs')(root)} ${vmSame} ${noNameSame} ${colonSame} ${virtualOnly} ${claimedSame} ${encodedSame} ${colonBare} ${directSame} ${mainSame} ${emptySame}`;
  },
  // item 7: after the seal, what exists in the runtime's tree is no answer:
  // a runtime lib path, or a package only the runtime has, resolved from a
  // genuine runtime parent, a forged one, or createRequire on a runtime
  // file, fails as a missing file does
  resolveOracle: () => {
    const h = handle();
    if (h == null) return 'no handle';
    const lib = path.dirname(h.module.filename);
    const code = (fn) => { try { fn(); return 'found'; } catch (e) { return String(e.code); } };
    const forged = {__proto__: null, id: path.join(lib, 'logger.js'), filename: path.join(lib, 'logger.js'), paths: M._nodeModulePaths(lib)};
    return [
      code(() => M._resolveFilename('./no-such-isolation-file.js', h.module)),
      code(() => M._resolveFilename('./node-version.js', h.module)),
      code(() => M._resolveFilename('json-stringify-safe', h.module)),
      code(() => M._resolveFilename('json-stringify-safe', forged)),
      code(() => M.createRequire(path.join(lib, 'logger.js')).resolve('json-stringify-safe')),
      // and the loader's own stat: a runtime file as a missing one
      `stat:${M._stat(path.join(lib, 'node-version.js')) === M._stat(path.join(lib, 'no-such-isolation-file.js'))
        && M._stat(path.relative(process.cwd(), path.join(lib, 'node-version.js'))) === M._stat(path.join(lib, 'no-such-isolation-file.js')) ? 'missing' : 'found'}`
    ].join(' ');
  },
  // the exception is sshpk's alone (the reviewer's ruling on #434): module
  // code asking for bcrypt-pbkdf itself, or with a parent shaped like
  // sshpk's file, gets its own copy or a refusal, never the exports the net
  // answers sshpk with
  lazyHitOthers: async () => {
    const h = handle();
    if (h == null || h.modules == null) return 'no handle';
    const sshKey = Object.keys(h.modules).find((k) => /[\\/]node_modules[\\/]sshpk[\\/]lib[\\/]formats[\\/]ssh-private\.js$/.test(k));
    const bcryptKey = Object.keys(h.modules).find((k) => /[\\/]node_modules[\\/]bcrypt-pbkdf[\\/]index\.js$/.test(k));
    if (sshKey == null || bcryptKey == null) return 'no sshpk';
    const captured = h.modules[bcryptKey].exports;
    const M = module.constructor;
    const judge = (fn) => { try { return fn() === captured ? 'captured' : 'own'; } catch (e) { return 'refused'; } };
    const forged = {__proto__: null, id: sshKey, filename: sshKey, paths: M._nodeModulePaths(path.dirname(sshKey))};
    // (and the object sshpk is answered with frozen: require tracing shows it
    // to module code, #434's Fable pass F8)
    return `${judge(() => require('bcrypt-pbkdf'))} ${judge(() => M._load('bcrypt-pbkdf', forged))} ${Object.isFrozen(captured) ? 'frozen' : 'not frozen'}`;
  },
  // interop, in both modes: the module's own files by every form
  interop: async () => {
    const out = [];
    out.push((await import('../../lib/own.cjs')).default.own);
    out.push(require('../../lib/own.mjs').own);
    out.push(require('module').createRequire(__filename)('../../lib/data.json').own);
    out.push(insideRoot(require.resolve('../../lib/data.json')) ? 'resolved' : 'outside');
    // (a CommonJS file reached by import(), asking for the module built-in:
    // the reduced module's re-resolution, which has no parent, still served)
    out.push((await import('../../lib/needs-module.cjs')).default.createRequire);
    // (and one importing it: named exports of the same form)
    out.push(await (await import('../../lib/imports-module.cjs')).default());
    // (a require of a sibling with no extension, and an import of an ES
    // module, from CommonJS reached by import(): each as written)
    out.push((await import('../../lib/needs-sibling.cjs')).default.own);
    out.push(await (await import('../../lib/imports-esm.cjs')).default());
    out.push(await (await import('../../lib/imports-url.cjs')).default());
    return out.join(' ');
  },
  // The window (Revision 4, test 4): while the runtime's late paths run (a
  // log line, a request, redis), every function object module code can
  // reach from a frame of the runtime's (a getter's .caller and its
  // .arguments, a thenable's, each CallSite's getFunction()), and a
  // Module.wrap set first: none yields a loader (a require, Module._load,
  // or anything with a resolve and a cache)
  window: async (input) => {
    const found = new Set();
    const loaderLike = (f) => typeof(f) === 'function' && (f === M._load || f === M.prototype.require
      || (typeof(f.resolve) === 'function' && f.cache != null) || f.name === 'require' || f.name === '_load');
    const look = (fn) => {
      try {
        const c = fn.caller;
        if (c != null) { found.add(`caller ${c.name}`); if (loaderLike(c)) found.add('LOADER via caller'); }
        const a = c != null ? c.arguments : null;
        if (a != null) for (const x of Array.from(a)) if (loaderLike(x)) found.add('LOADER via arguments');
      } catch (e) { /* strict: none */ }
      const prepare = Error.prepareStackTrace;
      try {
        Error.prepareStackTrace = (e, frames) => frames.map((f) => { try { return f.getFunction(); } catch (x) { return undefined; } });
        const fns = new Error().stack;
        if (Array.isArray(fns)) for (const f of fns) if (loaderLike(f)) found.add('LOADER via getFunction');
      } finally { Error.prepareStackTrace = prepare; }
    };
    const leaked = [];
    let skipped = false;
    const wrapWas = M.wrap;
    try { M.wrap = (src) => `globalThis.__isolationLeak && globalThis.__isolationLeak(require, module);${wrapWas(src)}`; } catch (e) { /* refused */ }
    globalThis.__isolationLeak = (req, mod) => { if (mod != null && typeof(mod.filename) === 'string' && !insideRoot(mod.filename)) leaked.push(mod.filename); };
    const keys = ['isolationWindow', 'then'];
    for (const key of keys) {
      Object.defineProperty(Object.prototype, key, {configurable: true, get: function windowGetter() { look(windowGetter); return undefined; }});
    }
    try {
      await new Promise((resolve) => CHUtil.recordUsage('isolation-probe', 'window', 0, () => resolve()));
      await new Promise((resolve) => { try { CHUtil.request({url: 'http://isolation.example.invalid/', timeout: 500}, () => resolve()); } catch (e) { resolve(); } });
      // (with no store, as on the Windows subset's runner, the test says so
      // and the store's part is skipped, saying so: a command that never
      // answers would hold the step, and the module's wrap with it)
      if (input.noStore === true) skipped = true;
      else await new Promise((resolve) => { try { CHUtil.redis.get('isolation-window', () => resolve()); } catch (e) { resolve(); } });
    } finally {
      for (const key of keys) delete Object.prototype[key];
      try { M.wrap = wrapWas; } catch (e) { /* refused */ }
      delete globalThis.__isolationLeak;
    }
    const loaders = [...found].filter((x) => x.startsWith('LOADER'));
    return `${loaders.length === 0 ? 'no loader' : loaders.join(' ')}, ${leaked.length === 0 ? 'nothing compiled' : `compiled: ${leaked.length}`}${skipped ? ' (store part skipped: no store)' : ''}`;
  },
  // BroadcastChannel: gone under enforce, by either route; under audit it
  // stays (a message crosses to the peer module's worker) and is reported
  // #434's Fable pass F9: Web Locks, a channel between workers
  locks: () => (globalThis.navigator != null && globalThis.navigator.locks != null ? 'locks' : 'no locks'),
  broadcast: () => {
    const global = typeof(globalThis.BroadcastChannel);
    let viaRequire;
    try { viaRequire = typeof(require('worker_threads').BroadcastChannel); } catch (e) { viaRequire = String(e.code); }
    if (global === 'function') {
      const c = new globalThis.BroadcastChannel('isolation-68');
      c.postMessage('hello');
      c.close();
    }
    // (under audit its prototype's constructor is the same view: no route to
    // the original unreported)
    const ctor = global === 'function' ? (globalThis.BroadcastChannel.prototype.constructor === globalThis.BroadcastChannel ? 'one' : 'another') : 'none';
    return `${global} ${viaRequire} ${ctor}`;
  },
  // A: the require cache lists the module's own files only
  cacheFiles: () => {
    const outside = Object.keys(require.cache).filter((k) => !insideRoot(k));
    return outside.length === 0 ? 'module files only' : `outside: ${outside.length} ${outside.slice(0, 4).join(' ')}`;
  },
  // A: one cache, the module's and module.constructor's alike
  sameCache: () => (M._cache === require.cache ? 'same' : 'different'),
  // A: util.inspect reads the cache past anything a view could show: it
  // names no runtime file, and no Module of the runtime's reaches
  // inspect.custom (Revision 6, blocking 1)
  inspect: () => {
    const seen = [];
    const key = util.inspect.custom;
    Object.defineProperty(Object.prototype, key, {configurable: true, get() {
      if (this != null && typeof(this.filename) === 'string' && !insideRoot(this.filename)) seen.push(this.filename);
      return undefined;
    }});
    let text;
    try { text = util.inspect(require.cache, {depth: 1}); } finally { delete Object.prototype[key]; }
    const runtimeNamed = /[\\/]lib[\\/][a-z-]+\.js|node_modules/.test(text.replace(ROOT, ''));
    return `${runtimeNamed ? 'runtime named' : 'none named'}, ${seen.length === 0 ? 'no runtime Module' : `runtime Modules: ${seen.length}`}`;
  },
  // C, #434's Fable pass F6: a parent is cut at Node's own slot, not only
  // shadowed: Module.prototype's getter, called directly, and a delete of
  // the own property, reach no runtime Module, for every module file in the
  // cache and for a runtime Module the test's hand-over gives
  parentSlot: () => {
    const get = Object.getOwnPropertyDescriptor(M.prototype, 'parent').get;
    const runtimeParent = (p) => p != null && typeof(p.filename) === 'string' && !insideRoot(p.filename);
    const found = [];
    const h = handle();
    const ms = Object.values(require.cache).concat(h != null && h.module != null ? [h.module] : []);
    for (const m of ms) {
      if (runtimeParent(get.call(m))) found.push('getter');
      try { delete m.parent; } catch (e) { /* held */ }
      if (runtimeParent(m.parent)) found.push('delete');
      // (a module file's own Module keeps a parent it can set: only the
      // runtime's are locked)
      if (m !== (h != null ? h.module : null)) {
        const mark = {};
        try { m.parent = mark; } catch (e) { /* refused */ }
        if (m.parent !== mark) found.push(`locked ${String(m.filename).split(/[\\/]/).pop()}`);
        try { m.parent = undefined; } catch (e) { /* refused */ }
      }
    }
    return `${h == null ? 'no handle' : 'handle'}, ${found.length === 0 ? 'no runtime parent' : found.join(' ')}`;
  },
  // C: no main module, in either form
  main: () => `${require.main === undefined ? 'no require.main' : 'require.main'}, ${process.mainModule === undefined ? 'no mainModule' : 'mainModule'}`,
  // S: each loader static stays as it was (a replacement doesn't stick);
  // the ones the lockdown leaves to audit as reported accessors aside
  statics: () => {
    const keys = ['_cache', '_pathCache', '_nodeModulePaths', '_initPaths', '_findPath', '_resolveLookupPaths', '_stat', '_readPackage', 'findPackageJSON'];
    const stuck = [];
    for (const k of keys) {
      const was = M[k];
      const mark = typeof(was) === 'function' ? function() {} : {};
      try { M[k] = mark; } catch (e) { /* locked */ }
      try { Object.defineProperty(M, k, {value: mark}); } catch (e) { /* locked */ }
      if (M[k] === mark) stuck.push(k);
    }
    for (const k of ['require', '_compile']) {
      const mark = function() {};
      try { M.prototype[k] = mark; } catch (e) { /* locked */ }
      if (M.prototype[k] === mark) stuck.push(`prototype.${k}`);
    }
    const proto = M.prototype;
    try { M.prototype = {}; } catch (e) { /* locked */ }
    if (M.prototype !== proto) stuck.push('prototype');
    try { M._extensions['.isolation'] = function() {}; } catch (e) { /* locked */ }
    if (typeof(M._extensions['.isolation']) === 'function') stuck.push("_extensions['.isolation']");
    return stuck.length === 0 ? 'none replaced' : `replaced: ${stuck.join(' ')}`;
  },
  // S: an entry planted in Node's path cache reads as never there
  // (C-lows: every stack module code can read names no host file of the
  // runtime's -- its own frames by /app, Node's by node:, the runtime's by
  // countinghouse: -- by every route: a plain stack, captureStackTrace, a
  // V8 error, an async frame, an error the runtime made, and a function the
  // module assigned to Error.prepareStackTrace, whose frames' getThis and
  // getFunction answer nothing for a runtime frame)
  stackFrames: async () => {
    const files = [];
    const look = (text) => {
      for (const line of String(text).split('\n').slice(1)) {
        const m = /\(?((?:file:\/\/)?[^\s()]+?):\d+:\d+\)?\s*$/.exec(line);
        if (m) files.push(m[1]);
      }
    };
    look(new Error('x').stack);
    const o = {};
    Error.captureStackTrace(o);
    look(o.stack);
    try { null.x; } catch (e) { look(e.stack); }
    await Promise.resolve();
    look(new Error('y').stack);
    try { M._resolveFilename('no-such-c-lows-pkg', {id: __filename, filename: __filename, paths: []}); } catch (e) { look(e.stack); }
    const saved = Error.prepareStackTrace;
    const viaFn = [];
    let objects = 0;
    let custom = false;
    try {
      Error.prepareStackTrace = (e, frames) => {
        for (const f of frames) {
          const n = f.getFileName();
          if (typeof(n) === 'string') viaFn.push(n);
          if (typeof(n) === 'string' && n.startsWith('countinghouse:') && (f.getThis() !== undefined || f.getFunction() !== undefined)) objects++;
        }
        return 'custom';
      };
      custom = new Error('z').stack === 'custom';
    } finally { Error.prepareStackTrace = saved; }
    files.push(...viaFn);
    const bad = files.filter((f) => !/^(\/app(\/|$)|[A-Z]:\\app(\\|$)|node:|countinghouse:|native$|<anonymous>$|evalmachine)/.test(f));
    const runtime = files.filter((f) => f.startsWith('countinghouse:')).length;
    return `${bad.length === 0 ? 'virtual' : `host(${bad.slice(0, 3).join('|')})`} ${objects === 0 ? 'no-objects' : 'objects'} ${custom && viaFn.length > 0 ? 'custom' : 'not-custom'} ${runtime > 0 ? 'runtime-frames' : 'no-runtime-frames'}`;
  },
  // (C-lows, the medium's round: a vm realm's own prepareStackTrace sees
  // raw frames -- the runtime's files by path, never a receiver or a
  // function of the runtime's (its files are strict); an assigned function
  // that calls the one it replaced; a frame of no file of the module's
  // answers no receiver; util.getCallSites names no host file;
  // Module._initPaths is no throw)
  stackEdges: () => {
    const out = [];
    const vm = require('vm');
    const raw = vm.runInNewContext(`Error.prepareStackTrace = (e, f) => f.map((s) => [String(s.getFileName()), s.getThis() !== undefined, s.getFunction() !== undefined]); new Error().stack`);
    const runtimeFrames = raw.filter(([f]) => !/^(\/app(\/|$)|[A-Z]:\\app(\\|$)|node:|undefined$|evalmachine)/.test(f));
    out.push(runtimeFrames.some(([, t, fn]) => t || fn) ? 'vm-receivers' : 'vm-no-receivers');
    const saved = Error.prepareStackTrace;
    try {
      const prev = Error.prepareStackTrace;
      Error.prepareStackTrace = (e, f) => (prev != null ? prev(e, f) : 'none');
      let s;
      try { s = String(new Error('chained').stack); } catch (e) { s = `threw ${e.name}`; }
      out.push(/^Error: chained\n {4}at /.test(s) ? 'chained' : `chained(${s.slice(0, 80)})`);
      let builtinThis = null;
      let found = false;
      Error.prepareStackTrace = (e, f) => {
        for (const site of f) {
          if (/forEach/.test(String(site.getFunctionName()))) { found = true; builtinThis = site.getThis(); }
        }
        return 'x';
      };
      [1].forEach(() => new Error('b').stack);
      out.push(!found ? 'builtin-none' : builtinThis === undefined ? 'builtin-no-this' : 'builtin-this');
    } finally { Error.prepareStackTrace = saved; }
    const util = require('util');
    if (typeof(util.getCallSites) === 'function') {
      const names = util.getCallSites().map((c) => String(c.scriptName));
      out.push(names.every((n) => /^(\/app(\/|$)|[A-Z]:\\app(\\|$)|node:|countinghouse:|$)/.test(n)) ? 'callsites-virtual' : `callsites-host`);
    } else out.push('callsites-virtual');
    try { module.constructor._initPaths(); out.push('initPaths'); } catch (e) { out.push(`initPaths-${e.name}`); }
    // (the round's second medium: Node 22's alias; Node's counts; an eval's
    // frame of the module's own; frames handed back to the formatter)
    // (the first site is this probe's own frame: no frame of the runtime's
    // before it; exact counts. On a Node with no alias: said so.)
    const ownFirst = (sites) => sites.length > 0 && /inspect\.js$/.test(String(sites[0].scriptName));
    if (typeof(util.getCallSite) === 'function') {
      const sites = util.getCallSite();
      const names = sites.map((c) => String(c.scriptName));
      out.push(ownFirst(sites) && names.every((n) => /^(\/app(\/|$)|[A-Z]:\\app(\\|$)|file:|node:|countinghouse:|$)/.test(n)) ? 'alias' : `alias(${names.slice(0, 2).join('|')})`);
    } else out.push('alias');
    if (typeof(util.getCallSites) === 'function') {
      let counts;
      // (relative to this stack's depth: all of it, then 10 of it at most)
      try {
        const depth = util.getCallSites(200).length;
        const ten = Math.min(10, depth);
        counts = `${util.getCallSites(2).length === Math.min(2, depth) && util.getCallSites(2.7).length === Math.min(2, depth)} ${util.getCallSites({}).length === ten} ${util.getCallSites(undefined, {}).length === ten} ${util.getCallSites().length === ten} ${ownFirst(util.getCallSites(3))}`;
        let refused = 'no';
        try { util.getCallSites(null, {}); } catch (e) { refused = String(e.code); }
        let refused2 = 'no';
        try { util.getCallSites({}, {}); } catch (e) { refused2 = String(e.code); }
        counts += ` ${refused} ${refused2}`;
      } catch (e) { counts = `threw ${e.code}`; }
      out.push(counts === 'true true true true true ERR_INVALID_ARG_TYPE ERR_INVALID_ARG_TYPE' ? 'counts' : `counts(${counts})`);
    } else out.push('counts');
    const saved2 = Error.prepareStackTrace;
    try {
      let evalFn = null;
      let evalSeen = false;
      let kept = null;
      Error.prepareStackTrace = (e, f) => {
        kept = f;
        for (const site of f) {
          if (site.isEval() && site.getFileName() == null && !evalSeen) { evalSeen = true; evalFn = site.getFunction(); }
        }
        return 'x';
      };
      // (a frame with no file -- a new Function's -- answers no function:
      // ruled M-eval, a listed limit)
      new Function('return new Error("e").stack')();
      out.push(!evalSeen ? 'eval-unseen' : evalFn == null ? 'eval-none' : 'eval-function');
      // (a file only like the root's -- '/apps-...' is not '/app' -- is no
      // file of the module's: its frame answers no function)
      let near = 'unseen';
      Error.prepareStackTrace = (e, f) => {
        for (const site of f) if (site.getFileName() === '/apps-not-the-root/x.js') near = site.getFunction() === undefined ? 'boundary' : 'boundary-function';
        return 'x';
      };
      require('vm').runInThisContext('(function near() { return new Error("n").stack; })()', {filename: '/apps-not-the-root/x.js'});
      out.push(near);
      // (frames kept from one stack, handed to the formatter again with a
      // function of the module's assigned: read as frames, never wrapped twice)
      Error.prepareStackTrace = (e, f) => f.map((site) => String(site.getFileName())).join(',');
      const fmt = Error.prepareStackTrace;
      let text;
      try { text = String(fmt(new Error('again'), kept)); } catch (e) { text = `threw ${e.name}`; }
      out.push(/^threw/.test(text) || text === '' ? `rewrapped(${text.slice(0, 60)})` : 'rewrapped');
    } finally { Error.prepareStackTrace = saved2; }
    return out.join(' ');
  },
  // (#493's high, round 1: globalThis.Error swapped or deleted reaches no
  // raw frame; a module's save/swap/restore keeps its own function; the
  // stack wrappers' prototype is an object's; Error.captureStackTrace as
  // the runtime holds it)
  stackHold: () => {
    const out = [];
    const E = Error;
    // (a module may swap and delete globalThis.Error -- a library that does
    // must load; ruled on #493: what a swapped Error's own formatter sees is
    // a listed limit)
    let swapped = 'held';
    try {
      try { globalThis.Error = class Wrapped extends E {}; swapped = globalThis.Error !== E ? 'swappable' : 'held'; } catch (e) { swapped = 'threw'; }
    } finally { globalThis.Error = E; }
    out.push(swapped);
    let deleted = 'held';
    try {
      try { deleted = (delete globalThis.Error) && globalThis.Error === undefined ? 'deletable' : 'held'; } catch (e) { deleted = 'threw'; }
    } finally { globalThis.Error = E; }
    out.push(deleted);
    const saved0 = E.prepareStackTrace;
    try {
      E.prepareStackTrace = () => 'mine';
      const saved = E.prepareStackTrace;
      E.prepareStackTrace = () => 'other';
      E.prepareStackTrace = saved;
      out.push(new E('z').stack === 'mine' ? 'restore' : `restore(${String(new E('z').stack).slice(0, 30)})`);
      // (a function that hands the one it replaced no frames, or others of
      // its own: the default text, never round again)
      E.prepareStackTrace = undefined;
      const prev = E.prepareStackTrace;
      E.prepareStackTrace = (e, f) => prev(e, []);
      let filtered;
      try { filtered = /^Error: q/.test(String(new E('q').stack)) ? 'filtered' : 'filtered-other'; } catch (e) { filtered = `filtered-threw-${e.name}`; }
      out.push(filtered);
      let proto = null;
      E.prepareStackTrace = (e, f) => { proto = Object.getPrototypeOf(Object.getPrototypeOf(f[0])); return 'x'; };
      void new E('w').stack;
      out.push(proto === Object.prototype ? 'wrapper-object' : 'wrapper-null');
    } finally { E.prepareStackTrace = saved0; }
    return out.join(' ');
  },
  // (C-lows d: process.argv as module code reads it under enforce)
  argv: () => {
    let pushed = false;
    try { process.argv.push('x'); pushed = true; } catch (e) { /* frozen */ }
    return `${JSON.stringify(process.argv)} ${pushed ? 'writable' : 'frozen'}`;
  },
  // (C-lows d, a report: every channel from a module object that could name
  // the root's host path or the install directory, each listed by name with
  // what it named; input.needles, the host paths to look for)
  hostChannels: async (input) => {
    const needles = Array.isArray(input && input.needles) ? input.needles.filter((n) => typeof(n) === 'string' && n.length > 1) : [];
    const hits = [];
    const look = (name, v) => {
      let t;
      try { t = typeof(v) === 'string' ? v : JSON.stringify(v, (k, x) => (typeof(x) === 'function' ? `fn ${x.name}` : x)); } catch (e) { t = `unreadable ${e && e.code}`; }
      if (typeof(t) !== 'string') return;
      for (const n of needles) if (t.includes(n) || t.includes(encodeURI(n))) { hits.push(`${name}=${t.slice(t.indexOf(n) - 20 < 0 ? 0 : t.indexOf(n) - 20, t.indexOf(n) + n.length + 40)}`); return; }
    };
    const safe = (name, fn) => { try { look(name, fn()); } catch (e) { look(`${name}!`, String(e && e.message) + String(e && e.stack)); } };
    const modOf = (name, m) => {
      if (m == null || typeof(m) !== 'object') return;
      for (const k of ['id', 'filename', 'path', 'paths', 'loaded']) safe(`${name}.${k}`, () => m[k]);
      safe(`${name}.parent`, () => (m.parent != null ? m.parent.filename : null));
      safe(`${name}.children`, () => (Array.isArray(m.children) ? m.children.map((c) => [c.id, c.filename, c.path]) : null));
    };
    modOf('module', module);
    safe('__filename', () => __filename);
    safe('require.cache', () => Object.keys(require.cache));
    for (const [k, m] of Object.entries(require.cache)) modOf(`cache[${k.slice(-24)}]`, m);
    modOf('require.main', require.main);
    modOf('process.mainModule', process.mainModule);
    const C = module.constructor;
    safe('Module._cache', () => Object.keys(C._cache || {}));
    try { require('./node-version.js'); } catch (e) { /* none */ }
    safe('Module._pathCache', () => C._pathCache);
    safe('Module._findPath', () => C._findPath('./node-version.js', [__dirname]));
    safe('Module._findPath(abs)', () => C._findPath(__filename, []));
    safe('Module._nodeModulePaths', () => C._nodeModulePaths(__dirname));
    safe('Module._resolveFilename', () => C._resolveFilename('./node-version.js', module));
    safe('Module._resolveLookupPaths', () => (typeof(C._resolveLookupPaths) === 'function' ? C._resolveLookupPaths('x', module) : null));
    safe('Module.globalPaths', () => C.globalPaths);
    safe('require.resolve', () => require.resolve('./node-version.js'));
    safe('require.resolve.paths', () => require.resolve.paths('x'));
    safe('Module.prototype keys', () => Object.getOwnPropertyNames(C.prototype));
    safe('process.argv', () => process.argv);
    safe('process.execArgv', () => process.execArgv);
    safe('process.cwd', () => process.cwd());
    safe('process.env', () => process.env);
    safe('process.title', () => process.title);
    safe('workerData', () => require('worker_threads').workerData);
    safe('process.report', () => (process.report != null && typeof(process.report.getReport) === 'function' ? process.report.getReport() : null));
    safe('new Module', () => { const m = new C('x', module); return [m.id, m.path, m.paths]; });
    safe('createRequire', () => require('module').createRequire(__filename).resolve('./node-version.js'));
    let im = null;
    try { im = await import('./node-version.js'); } catch (e) { look('import()!', String(e && e.message)); }
    look('import() ns', im != null ? Object.keys(im) : null);
    return hits.length === 0 ? 'none' : hits.join('\n');
  },
  // (C-lows: a warning Node emits as it resolves inside the root -- a
  // pattern's empty segment, an invalid target's segment -- names no host
  // path, by import and by require alike)
  warningPaths: async () => {
    const heard = [];
    const listen = (w) => heard.push(`${w && w.code} ${String(w && w.message)}`);
    process.on('warning', listen);
    const tries = [];
    for (const spec of ['#pat//x.mjs', '#badFirst', '#pat/./x.mjs']) {
      try { await import(spec); tries.push('found'); } catch (e) { tries.push(String(e.code)); }
      try { require(spec); tries.push('found'); } catch (e) { tries.push(String(e.code)); }
    }
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    process.removeListener('warning', listen);
    const paths = heard.join(' ').match(/(?:file:\/\/)?\/[^\s'"]+/g) || [];
    const host = paths.filter((p) => !/^(file:\/\/)?\/([A-Za-z]:\/)?app(\/|$)/.test(p));
    return host.length === 0 ? `no-host ${heard.length}` : `host(${heard.slice(0, 2).join(' | ').slice(0, 400)})`;
  },
  // (C-lows: Node's global lookup directories, as module.constructor
  // exposes them -- the install's prefix and $HOME -- are none to module
  // code under enforce)
  globalPaths: () => {
    const g = module.constructor.globalPaths;
    if (!Array.isArray(g)) return `not a list: ${typeof(g)}`;
    let pushed = false;
    try { g.push('/nowhere'); pushed = true; } catch (e) { /* frozen */ }
    return `${g.length === 0 ? 'none' : `${g.length} paths`} ${pushed ? 'writable' : 'frozen'}`;
  },
  pathCache: () => {
    const key = `planted\0${ROOT}`;
    try { M._pathCache[key] = '/nowhere/planted.js'; } catch (e) { /* refused */ }
    return M._pathCache[key] === undefined ? 'empty' : 'planted';
  }
};

module.exports = async (input) => {
  const step = STEPS[input.step];
  if (step == null) return {output: {step: input.step, detail: 'no such step'}};
  let detail;
  try { detail = String(await step(input)); } catch (e) { detail = `threw: ${e.code || e.message}`; }
  return {output: {step: input.step, detail}};
};
