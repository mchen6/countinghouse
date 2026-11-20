// Each entry tries one thing the module sandbox controls. "blocked" means the
// sandbox refused it -- recognised by its message, so an ordinary failure of
// the operation itself (a missing file, a refused connection) still counts as
// "allowed". test/sandbox/05-lockdown.js drives this under audit and enforce.
// F4-2: a report as a module reads it holds nothing of the process: its
// environment, command line, working directory, host, open handles, stacks,
// or any shared object's path (only libc's and the loader's names). One that
// does is LEAKED, whatever the mode; and it is still a report.
function reportChecked(r) {
  const header = (r != null && r.header != null) ? r.header : {};
  const leaked = ['environmentVariables', 'libuv', 'workers', 'nativeStack', 'javascriptStack'].filter((k) => r != null && r[k] != null)
    .concat(['commandLine', 'cwd', 'networkInterfaces', 'host', 'osRelease', 'osVersion', 'osMachine', 'cpus'].filter((k) => header[k] != null).map((k) => `header.${k}`))
    // shared objects: only libc's and the musl loader's names, as detect-libc reads them
    .concat((r != null && Array.isArray(r.sharedObjects) ? r.sharedObjects : []).filter((o) => /[\\/]/.test(o) || !/^(libc[.-]|ld-musl-|ld-linux)/.test(o)).map((o) => `sharedObjects ${o}`));
  if (leaked.length > 0) throw Object.assign(new Error(`the report holds ${leaked.join(', ')}`), {code: 'LEAKED'});
  // still a report: its header's runtime facts, as native-addon loaders read them
  if (typeof(header.nodejsVersion) !== 'string' || typeof(header.platform) !== 'string') throw Object.assign(new Error('not a report'), {code: 'NOT_A_REPORT'});
}

// F4-7: a V8 code cache is not checked against its source (only its
// length), so a cache made for one source runs in place of another of the
// same length. Each vm route is given one: CACHE when the cached code ran,
// SOURCE when the source given did, NO_CACHE when none could be produced.
const VM_CACHED = 'globalThis.__chVm = 1;;';
const VM_SOURCE = 'globalThis.__chVm = 2;;';
function vmRan(run) {
  globalThis.__chVm = 0;
  run();
  const v = globalThis.__chVm;
  throw Object.assign(new Error('ran'), {code: v === 1 ? 'CACHE' : (v === 2 ? 'SOURCE' : `OTHER_${v}`)});
}
const scriptCache = (vm) => new vm.Script(VM_CACHED, {filename: 'ch-probe-vm.js'}).createCachedData();
const VM_ROUTES = {
  script: (vm) => vmRan(() => new vm.Script(VM_SOURCE, {filename: 'ch-probe-vm.js', cachedData: scriptCache(vm)}).runInThisContext()),
  // (vm.createScript, which makes Node's own Script; the second round on #440)
  createScript: (vm) => vmRan(() => vm.createScript(VM_SOURCE, {filename: 'ch-probe-vm.js', cachedData: scriptCache(vm)}).runInThisContext()),
  // (options given as a function, which runInNewContext reads too)
  functionOptions: (vm) => {
    const ctx = {};
    const cached = 'this.__chVm = 1;;';
    const source = 'this.__chVm = 2;;';
    const opts = function() {};
    opts.filename = 'ch-probe-vm-ctx.js';
    opts.cachedData = new vm.Script(cached, {filename: 'ch-probe-vm-ctx.js'}).createCachedData();
    vm.runInNewContext(source, ctx, opts);
    throw Object.assign(new Error('ran'), {code: ctx.__chVm === 1 ? 'CACHE' : (ctx.__chVm === 2 ? 'SOURCE' : `OTHER_${ctx.__chVm}`)});
  },
  runInThisContext: (vm) => vmRan(() => vm.runInThisContext(VM_SOURCE, {filename: 'ch-probe-vm.js', cachedData: scriptCache(vm)})),
  subclass: (vm) => vmRan(() => new (class extends vm.Script {})(VM_SOURCE, {filename: 'ch-probe-vm.js', cachedData: scriptCache(vm)}).runInThisContext()),
  protoConstructor: (vm) => vmRan(() => new vm.Script.prototype.constructor(VM_SOURCE, {filename: 'ch-probe-vm.js', cachedData: scriptCache(vm)}).runInThisContext()),
  // (a source of the same length no other route compiled: V8's in-memory
  // compilation cache, keyed by the source, would otherwise answer with what
  // an earlier route's cache made of VM_SOURCE under audit)
  inherited: (vm) => {
    const data = scriptCache(vm);
    Object.defineProperty(Object.prototype, 'cachedData', {configurable: true, get: () => data});
    try { vmRan(() => new vm.Script('globalThis.__chVm =2;;;', {filename: 'ch-probe-vm.js'}).runInThisContext()); } finally { delete Object.prototype.cachedData; }
  },
  compileFunction: (vm) => {
    const produced = vm.compileFunction(VM_CACHED, [], {produceCachedData: true}).cachedData;
    if (produced == null) throw Object.assign(new Error('none produced'), {code: 'NO_CACHE'});
    vmRan(() => vm.compileFunction(VM_SOURCE, [], {cachedData: produced})());
  }
};

const ATTEMPTS = {
  // (the medium review of PR 3) no prototype of vm.Script leads to Node's
  // native class, which takes a cache in its own arguments
  vmNative:         () => {
    const vm = require('vm');
    if (Object.getPrototypeOf(vm.Script) !== Function.prototype) throw Object.assign(new Error('reached'), {code: 'REACHED'});
    if (Object.getPrototypeOf(vm.Script.prototype).constructor !== vm.Script) throw Object.assign(new Error('reached'), {code: 'REACHED'});
  },
  // ... the view freezes like any function, never touching Node's class,
  // and still constructs; its length is Script's
  vmFreeze:         () => {
    const vm = require('vm');
    Object.freeze(vm.Script);
    const s = new vm.Script('1;', {filename: 'ch-probe-freeze.js'});
    if (s.runInThisContext() !== 1 || vm.Script.length < 1 || vm.Script.name !== 'Script') throw Object.assign(new Error('changed'), {code: 'CHANGED'});
  },
  // ... vm's module classes (with --experimental-vm-modules): gone from
  // module code's vm under enforce, its key too; under audit there, and
  // their use said
  vmModules:        () => {
    const vm = require('vm');
    if (!('SourceTextModule' in vm)) throw Object.assign(new Error('gone'), {code: 'GONE'});
    if (typeof(vm.SourceTextModule) !== 'function') throw Object.assign(new Error('key left'), {code: 'KEY_LEFT'});
    void new vm.SourceTextModule('export default 1;');
    throw Object.assign(new Error('present'), {code: 'PRESENT'});
  },
  // ... an invalid cache value is Node's to refuse, as it would (the high
  // review of #440: present means not undefined, and only a valid one is
  // dropped)
  vmInvalidCache:   () => {
    const vm = require('vm');
    for (const opts of [{cachedData: null}, {cachedData: 0}, {produceCachedData: 0}]) {
      let code = null;
      try { new vm.Script('1;', Object.assign({filename: 'ch-probe-invalid.js'}, opts)); } catch (e) { code = e.code; }
      if (code !== 'ERR_INVALID_ARG_TYPE') throw Object.assign(new Error('taken'), {code: `TAKEN_${String(code)}`});
    }
  },
  // ... the vm module code is handed answers as Node's does: createScript
  // named and callable with new; options given as a function or an array
  // refused by Script as Node refuses them (the review of #440's second round)
  vmShape:          () => {
    const vm = require('vm');
    if (vm.createScript.name !== 'createScript') throw Object.assign(new Error('name'), {code: 'NAME'});
    if (!(new vm.createScript('1;') instanceof vm.Script)) throw Object.assign(new Error('new'), {code: 'NEW'});
    for (const opts of [function() {}, []]) {
      let code = null;
      try { new vm.Script('1;', opts); } catch (e) { code = e.code; }
      if (code !== 'ERR_INVALID_ARG_TYPE') throw Object.assign(new Error('taken'), {code: `TAKEN_${String(code)}`});
    }
  },
  // ... a vm function module code assigns never takes; under audit it is said
  vmAssign:         () => {
    const vm = require('vm');
    const was = vm.runInThisContext;
    try { vm.runInThisContext = function() {}; } catch (e) { /* refused */ }
    // (a redefinition and a delete too: said under vm as the assignment is)
    try { Object.defineProperty(vm, 'compileFunction', {value: function() {}}); } catch (e) { /* refused */ }
    try { Reflect.deleteProperty(vm, 'runInNewContext'); } catch (e) { /* refused */ }
    if (vm.runInThisContext !== was) throw Object.assign(new Error('replaced'), {code: 'REPLACED'});
    if (typeof(vm.runInNewContext) !== 'function') throw Object.assign(new Error('removed'), {code: 'REMOVED'});
  },
  // ... a script asked only to produce a cache is never marked rejected
  vmProduce:        () => {
    const s = new (require('vm').Script)('1;', {filename: 'ch-probe-produce.js', produceCachedData: true});
    if (s.cachedDataRejected === true) throw Object.assign(new Error('marked'), {code: 'MARKED'});
  },
  // ... and options from a defaults object keep their filename
  vmInherited:      () => {
    const s = new (require('vm').Script)('new Error("x").stack', Object.create({filename: 'ch-probe-defaults.js'}));
    if (!String(s.runInThisContext()).includes('ch-probe-defaults.js')) throw Object.assign(new Error('lost'), {code: 'LOST'});
  },
  // what the lockdown holds, as a dependency would try to change it (the
  // review of e0f39de9: under audit each is reported, and none takes)
  holdAssign:       () => {
    const M = module.constructor;
    const was = M._pathCache;
    try { M._pathCache = {}; } catch (e) { /* refused */ }
    if (M._pathCache !== was) throw Object.assign(new Error('replaced'), {code: 'REPLACED'});
  },
  holdDefine:       () => {
    const M = module.constructor;
    const was = M._load;
    try { Object.defineProperty(M, '_load', {value: function() {}}); } catch (e) { /* refused */ }
    if (M._load !== was) throw Object.assign(new Error('replaced'), {code: 'REPLACED'});
  },
  holdDefineKey:    () => {
    const P = module.constructor.prototype;
    const was = P.load;
    try { Object.defineProperty(P, {toString: () => 'load'}, {value: function() {}}); } catch (e) { /* refused */ }
    if (P.load !== was) throw Object.assign(new Error('replaced'), {code: 'REPLACED'});
  },
  holdDefineSetter: () => {
    const M = module.constructor;
    const was = M._resolveFilename;
    try { M.__defineSetter__('_resolveFilename', () => {}); } catch (e) { /* refused */ }
    if (M._resolveFilename !== was) throw Object.assign(new Error('replaced'), {code: 'REPLACED'});
  },
  holdHandler:      () => {
    const was = require.extensions['.js'];
    try { require.extensions['.js'] = function() {}; } catch (e) { /* refused */ }
    if (require.extensions['.js'] !== was) throw Object.assign(new Error('replaced'), {code: 'REPLACED'});
  },
  holdNode:         () => {
    const was = require.extensions['.node'];
    try { require.extensions['.node'] = function() {}; } catch (e) { /* refused */ }
    if (require.extensions['.node'] !== was) throw Object.assign(new Error('replaced'), {code: 'REPLACED'});
  },
  // (a Proxy whose keys differ on a second read: what is defined is only
  // what was read once, never a key read again; PR 3)
  holdDefineProps:  () => {
    const M = module.constructor;
    const was = M._load;
    let reads = 0;
    const props = new Proxy({}, {
      ownKeys: () => (reads++ === 0 ? ['chProbeProp'] : ['_load']),
      getOwnPropertyDescriptor: () => ({value: {value: function() {}, configurable: true, writable: true}, enumerable: true, configurable: true}),
      get: () => ({value: function() {}, configurable: true, writable: true})
    });
    try { Object.defineProperties(M, props); } catch (e) { throw Object.assign(new Error('threw'), {code: 'THREW'}); }
    if (M._load !== was) throw Object.assign(new Error('replaced'), {code: 'REPLACED'});
  },
  holdDeleteReflect: () => {
    const M = module.constructor;
    const was = M._resolveFilename;
    Reflect.deleteProperty(M, '_resolveFilename');
    if (M._resolveFilename !== was) throw Object.assign(new Error('removed'), {code: 'REMOVED'});
  },
  holdExtension:    () => {
    try { require.extensions['.chprobe'] = () => {}; } catch (e) { /* refused */ }
    if (require.extensions['.chprobe'] !== undefined) throw Object.assign(new Error('added'), {code: 'ADDED'});
  },
  // F4-7 (arg: a VM_ROUTES name; 'esm:<name>' takes vm by an import's named
  // exports)
  vmCache: async (arg) => {
    const esm = arg.startsWith('esm:');
    const vm = esm ? await import('node:vm') : require('vm');
    VM_ROUTES[esm ? arg.slice(4) : arg](esm ? {Script: vm.Script, createScript: vm.createScript, runInThisContext: vm.runInThisContext, compileFunction: vm.compileFunction} : vm);
  },
  dlopen:           () => process.dlopen({exports: {}}, '/nonexistent/probe.node'),
  binding:          () => process.binding('fs'),
  kill:             () => process.kill(process.pid, 0),
  getBuiltinModule: () => {
    if (process.getBuiltinModule('child_process') === undefined) throw new Error('countinghouse module sandbox: getBuiltinModule returned undefined');
  },
  _kill:            () => process._kill(process.pid, 0),
  dataImport:       (arg) => import(`data:text/javascript,export {default} from ${JSON.stringify(require('url').pathToFileURL(arg).href)}`),
  reducedCreateRequire: () => require('module').createRequire('/tmp/x.js')('/tmp'),
  child_process:    () => require('child_process'),
  sqlite:           () => require('node:sqlite'),
  nodeTest:         () => require('node:test'),
  importSqlite:     () => import('node:sqlite'),
  getBuiltinSqlite: () => {
    if (process.getBuiltinModule('node:sqlite') === undefined) throw new Error('countinghouse module sandbox: getBuiltinModule returned undefined');
  },
  tlsEngine:        () => require('tls').createSecureContext({privateKeyEngine: '/nonexistent/engine.so', privateKeyIdentifier: 'x'}),
  clientCertEngine: () => require('tls').createSecureContext({clientCertEngine: '/nonexistent/engine.so'}),
  cryptoEngine:     () => require('crypto').setEngine('/nonexistent/engine.so'),
  worker_threads:   () => require('worker_threads'),
  v8:               () => require('v8'),
  registerHooks:    () => module.constructor.registerHooks({resolve: (s, c, n) => n(s, c)}),
  // Module._load's fourth, internal argument skips the resolve hooks, where
  // the built-in gate and the file broker's bound live (#194's review, B1):
  // the flag itself, a resolution handed over (24.21 and later), and source
  // compiled under a filename of the module's choosing (24.21 and later)
  loadSkipHooks:    () => module.constructor._load('node:child_process', null, false, {shouldSkipModuleHooks: true}),
  // (worker_threads: a target of its own, so its report is told apart)
  loadResolved:     () => module.constructor._load('worker_threads', null, false, {resolved: {filename: 'worker_threads', url: 'node:worker_threads', format: 'builtin'}}),
  // B1's own checks (#406): a request that is no string, and isMain
  forgeParent:      (arg) => {
    const M = module.constructor;
    if (arg === 'objectRequest') return M._load({toString() { return './attempt'; }}, module, false);
    if (arg === 'isMain') return M._load(__filename, null, true);
    throw new Error(`unknown variant ${arg}`);
  },
  createRequireOwn: () => require('module').createRequire(__filename)('./attempt'),
  // under audit an assignment of load on one Module is that Module's own
  instanceLoad:     () => {
    const M = module.constructor;
    const before = M.prototype.load;
    const one = new M('/app/one.js', null);
    const mine = function() {};
    one.load = mine;
    if (M.prototype.load !== before) throw Object.assign(new Error('worker-wide'), {code: 'WORKER_WIDE'});
    if (Object.hasOwn(one, 'load') && one.load === mine) throw Object.assign(new Error('own'), {code: 'OWN'});
  },
  // each loader property #406 holds: whether a replacement takes (put back
  // at once where it does, under audit, where it is reported)
  replaceHeld:      (arg) => {
    const M = module.constructor;
    const [obj, key] = {protoLoad: [M.prototype, 'load'], jsHandler: [M._extensions, '.js'], jsonHandler: [M._extensions, '.json'],
      resolveFilename: [M, '_resolveFilename']}[arg];
    const prev = obj[key];
    const mine = function(...a) { return prev.apply(this, a); };
    try { obj[key] = mine; } catch (e) { /* refused */ }
    if (obj[key] !== mine) return;
    obj[key] = prev;
    throw Object.assign(new Error('replaced'), {code: 'REPLACED'});
  },
  // a new, longer extension would take over a file the runtime asks for
  // (Node picks the longest): whether it takes (taken out at once where it
  // does, after a load that reports it, under audit)
  newExtension:     () => {
    const exts = module.constructor._extensions;
    try { exts['.min.js'] = exts['.js']; } catch (e) { /* refused */ }
    if (!Object.hasOwn(exts, '.min.js')) return;
    require('path');
    delete exts['.min.js'];
    throw Object.assign(new Error('added'), {code: 'ADDED'});
  },
  // under audit, a module that replaces the loader is reported
  replaceLoad:      () => {
    const prev = module.constructor._load;
    try { module.constructor._load = function(...args) { return prev.apply(this, args); }; } catch (e) { /* refused */ }
    // (whether it took: it never does, in either mode, #434's Fable pass F7)
    if (module.constructor._load !== prev) throw Object.assign(new Error('replaced'), {code: 'REPLACED'});
  },
  // whether the cache holds source compiled under that filename (what
  // loadSource's internal argument did before B1's fix)
  compiledInCache:  (arg) => {
    const entry = require.cache[arg];
    if (entry != null && entry.exports != null && entry.exports.compiled === true) throw Object.assign(new Error('poisoned'), {code: 'POISONED'});
  },
  loadSource:       (arg) => module.constructor._load(arg, null, false,
    {resolved: {filename: arg, url: require('url').pathToFileURL(arg).href, format: 'commonjs'}, source: 'module.exports = {compiled: true};'}),
  nodePath:         () => require('cli-options'),
  loadFileOutside:  (arg) => CHUtil.loadFile(arg),
  request:          (arg) => new Promise((resolve, reject) => {
    CHUtil.request({url: arg, timeout: 2000}, (err) => (err != null && /module sandbox/.test(err.message) ? reject(err) : resolve()));
  }),
  requestUri:       () => new Promise((resolve, reject) => {
    CHUtil.request({url: 'http://allowed.example.test/', uri: 'http://127.0.0.1:1/', timeout: 2000}, (err) => (err != null && /module sandbox/.test(err.message) ? reject(err) : resolve()));
  }),
  createRequireDir: () => require('module').createRequire(require('path').join(__dirname, '/'))('./attempt.js'),
  requestHar:       () => new Promise((resolve, reject) => {
    CHUtil.request({url: 'http://allowed.example.test/', har: {url: 'http://127.0.0.1:1/', method: 'GET'}, timeout: 2000}, (err) => (err != null && /module sandbox/.test(err.message) ? reject(err) : resolve()));
  }),
  requestBaseUrl:   () => new Promise((resolve, reject) => {
    CHUtil.request({baseUrl: 'http://127.0.0.1:1', uri: '/x', timeout: 2000}, (err) => (err != null && /module sandbox/.test(err.message) ? reject(err) : resolve()));
  }),
  // Descriptor and handle adoption (spec section 2, "Other routes to files").
  listenFd:         () => new Promise((resolve, reject) => {
    const server = require('net').createServer();
    server.once('error', (e) => (/module sandbox/.test(e.message) ? reject(e) : resolve()));
    server.listen({fd: 999999}, () => { server.close(); resolve(); });
  }),
  socketFd:         () => new (require('net').Socket)({fd: 999999}),
  socketFdNumber:   () => new (require('net').Socket)(999999),
  connectFd:        () => require('net').connect({fd: 999999}),
  socketHandle:     () => new (require('net').Socket)({handle: {}}),
  ttyFd:            () => new (require('tty').WriteStream)(999999),
  // The real constructors behind the guards, through prototype.constructor
  // (L1 round 4): tty builds its handle from the fd with no open(fd).
  socketCtor:       () => new (require('net').Socket.prototype.constructor)(999999),
  ttyWriteCtor:     () => new (require('tty').WriteStream.prototype.constructor)(999999),
  ttyReadCtor:      () => new (require('tty').ReadStream.prototype.constructor)(999999),
  ttySuper:         () => new (Object.getPrototypeOf(require('tty').WriteStream))(999999),
  tlsSuper:         () => new (Object.getPrototypeOf(require('tls').TLSSocket))(999999),
  streamWrap:       () => require('_stream_wrap'),
  streamWrapSuper:  () => new (Object.getPrototypeOf(require('_stream_wrap')))(999999),
  dgramFd:          () => new Promise((resolve, reject) => {
    const socket = require('dgram').createSocket('udp4');
    socket.once('error', (e) => (/module sandbox/.test(e.message) ? reject(e) : resolve()));
    socket.bind({fd: 999999}, () => { socket.close(); resolve(); });
  }),
  http2RespondFD:   () => new Promise((resolve, reject) => {
    const http2 = require('http2');
    const server = http2.createServer();
    let client = null;
    const done = (fn, v) => { if (client) client.close(); server.close(); fn(v); };
    server.on('stream', (stream) => {
      try { stream.respondWithFD(0); done(resolve); } catch (e) { done(reject, e); }
    });
    server.listen(0, '127.0.0.1', () => {
      client = http2.connect(`http://127.0.0.1:${server.address().port}`);
      client.on('error', () => {});
      const req = client.request({':path': '/'});
      req.on('error', () => {});
      req.end();
    });
  }),
  // Not available to modules in any mode (user decision, plan 3): it hands
  // a broker descriptor to native code, which cannot read it.
  http2RespondFile: () => new Promise((resolve, reject) => {
    const http2 = require('http2');
    const server = http2.createServer();
    let client = null;
    const done = (fn, v) => { if (client) client.close(); server.close(); fn(v); };
    server.on('stream', (stream) => {
      try { stream.respondWithFile('/app/package.json'); done(resolve); } catch (e) { done(reject, e); }
    });
    server.listen(0, '127.0.0.1', () => {
      client = http2.connect(`http://127.0.0.1:${server.address().port}`);
      client.on('error', () => {});
      const req = client.request({':path': '/'});
      req.on('error', () => {});
      req.end();
    });
  }),
  // The guarded net.Socket still subclasses and still recognises Node's own
  // sockets (review, Task 5).
  socketClass:      () => {
    const net = require('net');
    class Sub extends net.Socket {}
    const sub = new Sub();
    const internal = net.createConnection({port: 1, host: '127.0.0.1'});
    internal.on('error', () => {});
    const ok = sub instanceof Sub && sub instanceof net.Socket && internal instanceof net.Socket && internal instanceof net.Stream;
    sub.destroy();
    internal.destroy();
    if (!ok) throw Object.assign(new Error('the guarded net.Socket broke subclassing or instanceof'), {code: 'PROXY_BROKEN'});
  },
  // Writes by native code, outside the broker (to directories that do not
  // exist, so audit writes nothing).
  report:           () => process.report.writeReport('/nonexistent-ch-probe/r.json'),
  // F4-2: a diagnostic report read in the worker. It must never hold the
  // process's own environment, command line, working directory, open
  // handles or loaded objects (the --redisUrl password, --debugKey, the
  // server's tokens): one that does is LEAKED, whatever the mode.
  getReport:        () => reportChecked(process.report.getReport()),
  // detect-libc's own steps (its lib/process.js): excludeNetwork set around
  // the call, then put back; never refused, in any mode
  detectLibc:       () => {
    const orig = process.report.excludeNetwork;
    process.report.excludeNetwork = true;
    const r = process.report.getReport();
    process.report.excludeNetwork = orig;
    if (process.report.excludeNetwork !== orig) throw Object.assign(new Error('excludeNetwork was not put back'), {code: 'NOT_RESTORED'});
    reportChecked(r);
    if (typeof(r.header.glibcVersionRuntime) !== 'string' && process.platform === 'linux' && !(r.sharedObjects || []).some((o) => /musl/.test(o))) {
      throw Object.assign(new Error('no libc to be read'), {code: 'NO_LIBC'});
    }
  },
  // a setting that writes where a report goes (re-set to itself: audit changes nothing)
  reportDirectory:  () => { process.report.directory = process.report.directory; },
  // a report written to {file} (arg as JSON) with the module's compact set to {compact} (audit only: refused under enforce)
  writeReportTo:    (arg) => {
    const {file, compact} = JSON.parse(arg);
    const was = process.report.compact;
    process.report.compact = compact === true;
    try { process.report.writeReport(file); } finally { process.report.compact = was; }
  },
  // compact is the module's own: set here, the process's is unchanged (a new worker starts from it)
  reportCompactSet: () => {
    process.report.compact = true;
    if (process.report.compact !== true) throw Object.assign(new Error('not set'), {code: 'NOT_SET'});
  },
  reportCompactIsFalse: () => {
    if (process.report.compact !== false) throw Object.assign(new Error(`compact is ${process.report.compact}`), {code: `COMPACT_${process.report.compact}`});
  },
  // a view of Node's own: a setting is a boolean, as Node checks
  reportCompactNotBoolean: () => {
    try { process.report.compact = 'yes'; } catch (e) {
      if (e instanceof TypeError && e.code === 'ERR_INVALID_ARG_TYPE' && /Received type string \('yes'\)/.test(e.message) && process.report.compact === false) return;
      throw e;
    }
    throw Object.assign(new Error('a non-boolean was taken'), {code: 'TAKEN'});
  },
  compileCache:     () => module.constructor.enableCompileCache('/nonexistent-ch-probe/cc'),
  sourceMaps:       () => process.setSourceMapsEnabled(true),
  repl:             () => require('repl'),
  traceEvents:      () => require('trace_events'),
  // Every mode: process.loadEnvFile reads through the broker.
  loadEnvFile:      () => {
    require('fs').writeFileSync('/data/.env', 'PROBE_ENV=1\n');
    process.loadEnvFile('/data/.env');
    if (process.env.PROBE_ENV !== '1') throw Object.assign(new Error('loadEnvFile did not apply /data/.env'), {code: 'NOT_LOADED'});
  }
};

module.exports = async (input) => {
  try {
    await ATTEMPTS[input.what](input.arg);
    return {output: {outcome: 'allowed', code: null}};
  } catch (e) {
    const blocked = /countinghouse module sandbox/.test(String(e && e.message));
    return {output: {outcome: blocked ? 'blocked' : 'allowed', code: (e && e.code != null) ? String(e.code) : null}};
  }
};
