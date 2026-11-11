// Runs code in a worker of a fresh node process, optionally under the
// permission model, and returns what it returns: for tests that install the
// module lockdown directly (test/sandbox/36-38).
const path = require('path');
const {spawnSync} = require('child_process');

const LOCKDOWN = path.join(__dirname, '..', '..', 'lib', 'module-lockdown.js');
const PERMISSION = ['--permission', '--allow-worker', '--allow-fs-read=*']
  .concat(process.allowedNodeEnvironmentFlags.has('--allow-net') ? ['--allow-net'] : []);

// body is an async function body. parentPort is taken first: the lockdown
// refuses worker_threads once installed.
function inWorker(body, opts) {
  const code = `const {parentPort} = require('worker_threads');
    (async () => { ${body} })().then((v) => parentPort.postMessage(v), (e) => parentPort.postMessage({thrown: String(e && e.message)}));`;
  const script = `new (require('worker_threads').Worker)(${JSON.stringify(code)}, {eval: true})
    .on('message', (v) => { console.log(JSON.stringify(v)); process.exit(0); })
    .on('error', (e) => { console.error('worker error: ' + ((e && e.stack) || e)); process.exit(1); })
    .on('exit', (c) => { console.error('worker exited with code ' + c + ' without an answer'); process.exit(1); });`;
  const flags = (opts != null && opts.permission === true) ? PERMISSION : [];
  const r = spawnSync(process.execPath, flags.concat(['-e', script]),
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000});
  try {
    return JSON.parse(String(r.stdout).trim().split('\n').pop());
  } catch (e) {
    // A refusal at startup or a crash: say what the process said.
    throw new Error(`no answer from the worker (status ${r.status}, signal ${r.signal}): ${String(r.stderr).trim() || String(r.stdout).trim() || '(no output)'}`);
  }
}

// The source of a statement that installs the lockdown with cfg (merged over
// a minimal one), collecting reports into `reports`.
const install = (cfg) => `const reports = [];
  require(${JSON.stringify(LOCKDOWN)}).install(Object.assign({moduleName: 'lockdown-probe', moduleRoot: process.cwd()}, ${JSON.stringify(cfg)}),
    (rule, target) => reports.push(rule + ' ' + target));`;

// Module source defining capture.TCP(), capture.Pipe() and capture.UDP(),
// each giving the handle prototype as the lockdown takes it: the tests
// build the handles a module could (test/sandbox/09, 36).
const {HANDLE_CAPTURE} = require(LOCKDOWN);
const CAPTURE_SOURCE = `const fromSocket = ${HANDLE_CAPTURE.fromSocket};
  const fromDgram = ${HANDLE_CAPTURE.fromDgram};
  const capture = {TCP: ${HANDLE_CAPTURE.CAPTURE.TCP}, Pipe: ${HANDLE_CAPTURE.CAPTURE.Pipe}, UDP: ${HANDLE_CAPTURE.CAPTURE.UDP}};`;

module.exports = {inWorker, install, LOCKDOWN, CAPTURE_SOURCE};
