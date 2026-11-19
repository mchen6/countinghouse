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
  // (C-bare, Fable's pass on #452: a bare name's subpath, or a '#' mapping
  // to one, never walks or stats above the root; a package found above it
  // and one missing give one answer, and nothing of module code's runs
  // inside Node's step while it looks)
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
    // (a '#' mapping to a built-in, and an array's first valid target)
    out.push((await tryImport('#builtin')) === 'found' && (await tryImport('#fallback')) === 'found' && tryRequire('#builtin') === 'found' ? 'same' : 'mapped');
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
    // (a decoy where the walk would look first is refused, never loaded)
    out.push((await tryImport('dep2')) !== 'found' ? 'same' : 'decoy');
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
