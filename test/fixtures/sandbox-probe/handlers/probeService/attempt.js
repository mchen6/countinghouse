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
  socketHandle:     () => new (require('net').Socket)({handle: {}}),
  ttyFd:            () => new (require('tty').WriteStream)(999999),
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
