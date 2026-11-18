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
  // each condition of the parent check on its own (the medium review of
  // cb3ce40e): a parent that agrees in all but one, or that changes once
  // the check has passed, is refused; createRequire's own Module still loads
  forgeParent:      (arg) => {
    const path = require('path');
    const M = module.constructor;
    const key = Object.keys(require.cache).find((k) => /[\\/]lib[\\/]countinghouse-util\.js$/.test(k));
    const libDir = path.dirname(key);
    const ownDir = path.join(__dirname, '..', '..', 'lib');
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
      }
    };
    if (arg === 'objectRequest') {
      const p = agreeing(ownDir);
      return M._load({toString() { p.path = libDir; return './bind-address'; }}, p, false);
    }
    if (arg === 'isMain') return M._load(path.join(ownDir, 'bind-address.js'), null, true);
    return M._load('./bind-address', variants[arg](), false);
  },
  createRequireOwn: () => require('module').createRequire(__filename)('./attempt'),
  hostIpClean:      () => {
    if (CHUtil.getHostIp() === 'POISONED') throw Object.assign(new Error('poisoned'), {code: 'POISONED'});
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
