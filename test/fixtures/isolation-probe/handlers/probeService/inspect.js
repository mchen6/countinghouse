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
  // F4 (#194's PR 3): an import() from an ES module is no existence oracle
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
    // (a directory of its own whose package.json "main" leads outside the
    // root, to a runtime file against a missing one: by require and by the
    // direct route, the whole error)
    const mainOut = (fn, dir) => { try { fn(`../../lib/${dir}`); return 'found'; } catch (e) { return `${e.code}|${e.message}`.split(dir).join('DIR'); } };
    const routes = [(r) => require(r), (r) => M._resolveFilename(r, module)];
    const answers = [];
    for (const fn of routes) for (const dir of ['main-out-a', 'main-out-b', 'main-out-c', 'main-out-d', 'main-out-e', 'main-out-f', 'main-out-g']) answers.push(mainOut(fn, dir));
    // (and an own package with only a nested outside "main" loads)
    const loads = [];
    for (const dir of ['main-in-nested']) { try { loads.push(require(`../../lib/${dir}`)); } catch (e) { loads.push(`threw ${e.code}`); } }
    const mainSame = answers.every((a) => a === answers[0]) && answers[0] === "MODULE_NOT_FOUND|Cannot find module '../../lib/DIR'" && loads.join(' ') === 'nested'
      ? 'same' : `main(${answers.join(' / ')} / ${loads.join(' ')})`;
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
    const hostNamed = (missing.match(/(?<=^|[\s"'(|])(?:file:\/\/)?\/[^\s'"]+/g) || []).filter((p) => !/^(file:\/\/)?\/app(\/|$)/.test(p));
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
  window: async () => {
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
      await new Promise((resolve) => { try { CHUtil.redis.get('isolation-window', () => resolve()); } catch (e) { resolve(); } });
    } finally {
      for (const key of keys) delete Object.prototype[key];
      try { M.wrap = wrapWas; } catch (e) { /* refused */ }
      delete globalThis.__isolationLeak;
    }
    const loaders = [...found].filter((x) => x.startsWith('LOADER'));
    return `${loaders.length === 0 ? 'no loader' : loaders.join(' ')}, ${leaked.length === 0 ? 'nothing compiled' : `compiled: ${leaked.length}`}`;
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
  try { detail = String(await step()); } catch (e) { detail = `threw: ${e.code || e.message}`; }
  return {output: {step: input.step, detail}};
};
