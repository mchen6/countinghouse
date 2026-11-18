// Each entry tries one thing the module sandbox controls. "blocked" means the
// sandbox refused it -- recognised by its message, so an ordinary failure of
// the operation itself (a missing file, a refused connection) still counts as
// "allowed". test/sandbox/05-lockdown.js drives this under audit and enforce.
const ATTEMPTS = {
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
  // #406's second review: Node's relative-resolve cache is keyed by the
  // parent's path, answered before any hook. A parent with countinghouse's
  // lib/ as its path and the module's own file as its filename records the
  // module's decoy lib/bind-address.js under the lib's key; the runtime's
  // first getHostIp then requires './bind-address' from lib/ and gets it.
  poisonRelative:   () => {
    const key = Object.keys(require.cache).find((k) => /[\\/]lib[\\/]countinghouse-util\.js$/.test(k));
    if (key == null) throw new Error('no countinghouse-util in the cache');
    const path = require('path');
    const forged = {id: 'forged', path: path.dirname(key), filename: path.join(__dirname, '..', '..', 'lib', 'decoy.js'), paths: [], children: []};
    module.constructor._load('./bind-address', forged, false);
    if (CHUtil.getHostIp() === 'POISONED') throw Object.assign(new Error('poisoned'), {code: 'POISONED'});
  },
  // a forged parent of every kind the reviews of #406 found: none of them
  // may record the module's decoy under lib/'s key (the shadow parent
  // takes only its filename); a request that is no string, isMain and a
  // filename that throws are refused
  forgeParent:      (arg) => {
    const path = require('path');
    const M = module.constructor;
    const key = Object.keys(require.cache).find((k) => /[\\/]lib[\\/]countinghouse-util\.js$/.test(k));
    const libDir = path.dirname(key);
    // (a directory of its own per variant, with its own decoy: no variant is
    // answered from the cache entry another's load made)
    const ownDir = path.join(__dirname, '..', '..', 'lib', 'v', String(arg));
    const agreeing = (dir) => Object.assign(new M(path.join(dir, 'decoy.js'), null), {filename: path.join(dir, 'decoy.js'), paths: M._nodeModulePaths(dir)});
    const variants = {
      // the key's directory is lib/, the resolution's the module's own
      dirname: () => Object.assign(agreeing(ownDir), {path: libDir}),
      paths: () => Object.assign(agreeing(ownDir), {paths: []}),
      noId: () => Object.assign(agreeing(ownDir), {id: ''}),
      plainObject: () => Object.assign({}, agreeing(ownDir)),
      // agrees when checked, then Node's own read of id moves path to lib/
      idGetter: () => {
        const p = agreeing(ownDir);
        Object.defineProperty(p, 'id', {configurable: true, get() { this.path = libDir; return 'x'; }});
        return p;
      },
      // (its own throw, in words of its own: blocked only if the wrapper refuses)
      filenameThrows: () => Object.defineProperty({}, 'filename', {get() { throw new Error('the module\'s own throw'); }})
    };
    if (arg === 'builtinModule') return M._load('module', Object.assign(agreeing(ownDir), {path: libDir}), false);
    if (arg === 'relativeFilename') return M._load('./bind-address', {filename: 'decoy.js'}, false);
    // a relative filename that leads to the module's decoy, with lib/ as the
    // path Node would key on (the medium review of 243abf5d)
    if (arg === 'relativeWithPath') {
      return M._load('./bind-address', {path: libDir, filename: path.relative(process.cwd(), path.join(ownDir, 'decoy.js')), paths: []}, false);
    }
    if (arg === 'nonObject') return M._load('./bind-address', 5, false);
    // Node's path cache, keyed by the request and the directory it is looked
    // up in: an entry for the runtime's first './bind-address' from lib/
    if (arg === 'pathCache') {
      M._pathCache[`./bind-address\u0000${libDir}`] = path.join(__dirname, '..', '..', 'lib', 'v', 'dirname', 'bind-address.js');
      return undefined;
    }
    const decoy = (got) => {
      if (got == null || typeof(got.hostIp) !== 'function' || got.hostIp() !== 'POISONED') throw Object.assign(new Error('the decoy did not load'), {code: 'NOT_LOADED'});
    };
    // no parent: passed through as given, and loads
    if (arg === 'nullParent' || arg === 'undefinedParent') {
      return decoy(M._load(path.join(__dirname, '..', '..', 'lib', 'v', 'dirname', 'bind-address.js'), arg === 'nullParent' ? null : undefined, false));
    }
    if (arg === 'objectRequest') {
      const p = agreeing(ownDir);
      return M._load({toString() { p.path = libDir; return './bind-address'; }}, p, false);
    }
    if (arg === 'isMain') return M._load(path.join(ownDir, 'bind-address.js'), null, true);
    // each loads its own decoy (from its own directory, under its own key)
    return decoy(M._load('./bind-address', variants[arg](), false));
  },
  createRequireOwn: () => require('module').createRequire(__filename)('./attempt'),
  // nothing of the caller's is touched for linkage: an own parent accessor
  // on the runtime's child and a children accessor on the runtime's Module
  // are each set while the runtime requires through it; neither may run
  linkageSpy:       () => {
    const key = Object.keys(require.cache).find((k) => /[\\/]lib[\\/]countinghouse-util\.js$/.test(k));
    const runtime = require.cache[key];
    const seen = [];
    const kids = runtime.children;
    Object.defineProperty(runtime, 'children', {configurable: true, get() { seen.push('children'); return kids; }, set() { seen.push('children='); }});
    const kid = require.cache[require('path').join(require('path').dirname(key), 'bind-address.js')];
    if (kid != null) Object.defineProperty(kid, 'parent', {configurable: true, get() { seen.push('parent'); return undefined; }, set() { seen.push('parent='); }});
    try {
      CHUtil.getHostIp();
    } finally {
      Object.defineProperty(runtime, 'children', {value: kids, writable: true, enumerable: true, configurable: true});
      if (kid != null) delete kid.parent;
    }
    if (seen.length > 0) throw Object.assign(new Error(`linkage ran module code: ${seen.join(', ')}`), {code: 'SEEN'});
  },
  // and none emulated (#406): the module's own require gives its child a
  // data-only stand-in for a parent, named for this file (so "am I main" is
  // still no), and leaves this module's own children as they were
  linkageNone:      () => {
    const before = module.children.length;
    const kid = require('../../lib/kid');
    const child = require.cache[require.resolve('../../lib/kid')];
    const p = kid.parentAtLoad;
    const ok = child != null && kid.mainAtLoad === false && p != null && p !== module && p.filename === module.filename &&
      Array.isArray(p.children) && child.parent === p && module.children.length === before;
    if (!ok) throw Object.assign(new Error('linked'), {code: 'LINKED'});
  },
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
  hostIpClean:      () => {
    if (CHUtil.getHostIp() === 'POISONED') throw Object.assign(new Error('poisoned'), {code: 'POISONED'});
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
    module.constructor._load = function(...args) { return prev.apply(this, args); };
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
