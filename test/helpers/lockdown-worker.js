// Runs code in a worker of a fresh node process, optionally under the
// permission model, and returns what it returns: for tests that install the
// module lockdown directly (test/sandbox/36, 37).
const path = require('path');
const {execFileSync} = require('child_process');

const LOCKDOWN = path.join(__dirname, '..', '..', 'lib', 'module-lockdown.js');
const PERMISSION = ['--permission', '--allow-worker', '--allow-fs-read=*']
  .concat(process.allowedNodeEnvironmentFlags.has('--allow-net') ? ['--allow-net'] : []);

// body is an async function body. parentPort is taken first: the lockdown
// refuses worker_threads once installed.
function inWorker(body, opts) {
  const code = `const {parentPort} = require('worker_threads');
    (async () => { ${body} })().then((v) => parentPort.postMessage(v), (e) => parentPort.postMessage({thrown: String(e && e.message)}));`;
  const script = `new (require('worker_threads').Worker)(${JSON.stringify(code)}, {eval: true})
    .on('message', (v) => { console.log(JSON.stringify(v)); process.exit(0); });`;
  const flags = (opts != null && opts.permission === true) ? PERMISSION : [];
  const out = execFileSync(process.execPath, flags.concat(['-e', script]),
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000});
  return JSON.parse(out.trim().split('\n').pop());
}

// The source of a statement that installs the lockdown with cfg (merged over
// a minimal one), collecting reports into `reports`.
const install = (cfg) => `const reports = [];
  require(${JSON.stringify(LOCKDOWN)}).install(Object.assign({moduleName: 'lockdown-probe', moduleRoot: process.cwd()}, ${JSON.stringify(cfg)}),
    (rule, target) => reports.push(rule + ' ' + target));`;

module.exports = {inWorker, install, LOCKDOWN};
