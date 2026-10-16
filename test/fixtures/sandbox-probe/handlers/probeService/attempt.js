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
  requestHar:       () => new Promise((resolve, reject) => {
    CHUtil.request({url: 'http://allowed.example.test/', har: {url: 'http://127.0.0.1:1/', method: 'GET'}, timeout: 2000}, (err) => (err != null && /module sandbox/.test(err.message) ? reject(err) : resolve()));
  }),
  requestBaseUrl:   () => new Promise((resolve, reject) => {
    CHUtil.request({baseUrl: 'http://127.0.0.1:1', uri: '/x', timeout: 2000}, (err) => (err != null && /module sandbox/.test(err.message) ? reject(err) : resolve()));
  })
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
