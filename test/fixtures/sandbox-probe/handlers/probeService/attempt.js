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
  // a report written to {file, compact} (arg as JSON) in the module's own compact (audit only: refused under enforce)
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
    try { process.report.compact = 'yes'; } catch (e) { if (e instanceof TypeError && e.code === 'ERR_INVALID_ARG_TYPE') return; throw e; }
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
