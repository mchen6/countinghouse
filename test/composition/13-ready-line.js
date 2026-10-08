// The server logs one line when it is ready to serve: every preloaded module
// discovered AND every device's composition verdict delivered. Tests wait for
// it (test/helpers/wait-for-ready.js) instead of sleeping a fixed time after
// starting a server.
//
// "all module discovered" alone is not that signal. Composition verification
// runs after it (lib/device-manager.js, onAllModulesDiscovered) and, under
// --workerThread, has to relay each verdict into the module's worker; until
// that lands ctx.call answers CTX_CALL_NOT_READY. Every composite test used
// to cover the gap with a 2.5 s sleep. So the property worth pinning is not
// that a line is printed but what it promises: a composite called the moment
// the line appears -- no sleep at all -- makes its inner hop successfully.
//
// Same server shape as 04-failure-and-billing.js (compose-caller calling
// compose-callee, --debug so CALLER_KEY is every identity in the chain).
const assert  = require('assert');
const path    = require('path');
const request = require('supertest');
const spawn   = require('child_process').spawn;
const fork    = require('child_process').fork;

const waitForReady = require('../helpers/wait-for-ready');

const ROOT     = path.join(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

const PORT       = 9599;
const PORT_PM2   = 9604;
const CALLER_KEY = 'compose-caller-internal';

describe('composition 13: the server says when it is ready', function() {
  this.timeout(60000);

  let server    = null;
  let out       = '';
  let firstCall = null; // {err, body} of a composite call made the instant the server was ready

  before((done) => {
    server = spawn(process.execPath, [
      path.join(ROOT, 'framework.js'),
      '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(PORT),
      '--mcpToolCallCost', '1',
      '--debug', '--debugKey', CALLER_KEY,
      '--authConfigPath', path.join(__dirname, 'fixtures-auth.json'),
      '--loadModule', path.join(FIXTURES, 'compose-callee'),
      '--loadModule', path.join(FIXTURES, 'compose-caller')
    ], {stdio: ['ignore', 'pipe', 'pipe']});

    server.stdout.on('data', (chunk) => { out += chunk; });

    waitForReady(server, {timeoutMs: 45000}, (err) => {
      if (err) return done(err);

      request(`http://127.0.0.1:${PORT}`)
        .post('/mcp')
        .set('X-CH-Key', CALLER_KEY)
        .set('Accept', 'application/json, text/event-stream')
        .send({jsonrpc: '2.0', id: 1, method: 'tools/call',
               params: {name: 'compose_caller_callerservice_viacall', arguments: {n: 21}}})
        .end((callErr, res) => {
          firstCall = {err: callErr, body: (res != null) ? res.body : null};
          return done();
        });
    });
  });

  after(() => { if (server != null) server.kill('SIGKILL'); });

  it('logs the ready line, after "all module discovered"', () => {
    const discovered = out.search(/all module discovered/i);
    const ready      = out.indexOf(waitForReady.READY_LINE);
    assert.ok(discovered !== -1, 'never saw "all module discovered"');
    assert.ok(ready > discovered, `ready line at ${ready}, discovery at ${discovered}`);
  });

  it('a composite called the instant the line appears makes its hop', () => {
    assert.ifError(firstCall.err);
    const text = JSON.stringify(firstCall.body);
    assert.ok(!/CTX_CALL_NOT_READY/.test(text), `ctx.call was not ready: ${text}`);
    assert.strictEqual(firstCall.body.result.isError, false, `expected a successful call, got ${text}`);
  });
});

// --withPM2 is gone. It dated from when this server ran under PM2 as CDIF: it
// made the server send its parent process a 'ready' message at startup and a
// heap-statistics message every ten seconds. Nothing reads either any more,
// and the log line above is the readiness signal. A leftover --withPM2 on a
// command line is ignored like any other unknown flag, so what this pins is
// that the server stays silent on the IPC channel a supervisor gives it.
describe('composition 13b: --withPM2 is removed', function() {
  this.timeout(60000);

  let server     = null;
  const messages = [];

  before((done) => {
    server = fork(path.join(ROOT, 'framework.js'), [
      '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(PORT_PM2),
      '--debug', '--debugKey', CALLER_KEY, '--apiMonitor',
      '--authConfigPath', path.join(__dirname, 'fixtures-auth.json'),
      '--loadModule', path.join(FIXTURES, 'compose-callee'),
      '--loadModule', path.join(FIXTURES, 'compose-caller'),
      '--withPM2'
    ], {silent: true});

    server.on('message', (message) => { messages.push(message); });
    waitForReady(server, {timeoutMs: 45000}, done);
  });

  after(() => { if (server != null) server.kill('SIGKILL'); });

  it('a forked server sends its parent nothing on the way to ready', (done) => {
    // give a message sent in the same tick as the ready line time to arrive
    setTimeout(() => {
      assert.deepStrictEqual(messages, []);
      done();
    }, 500);
  });

  // The same PM2 era left a listener in lib/monitor.js that loaded, unloaded
  // or restarted a module when the parent process said so over IPC -- an
  // entry path with no row in docs/cross-cutting-matrix.md, never gated by
  // the flag. Loading a module at run time is what the admin-gated HTTP
  // routes and the countinghouse_load_module tool are for.
  //
  // An absence can only be watched for, so this polls for as long as a
  // run-time load takes several times over (measured at about 7 s) and
  // fails the moment the module's tool shows up.
  it('a module-load message from the parent process is ignored', function(done) {
    this.timeout(30000);

    server.send({data: {loadModule: {
      path: path.join(ROOT, 'pre-installed-packages', 'transform-demo'), name: 'transform-demo'}}});

    const deadline = Date.now() + 15000;
    (function poll() {
      request(`http://127.0.0.1:${PORT_PM2}`)
        .post('/mcp')
        .set('X-CH-Key', CALLER_KEY)
        .set('Accept', 'application/json, text/event-stream')
        .send({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}})
        .end((err, res) => {
          if (err) return done(err);
          const names = res.body.result.tools.map((t) => t.name);
          if (names.some((n) => n.indexOf('transform_demo') === 0)) {
            return done(new Error(`the parent's message loaded a module: ${JSON.stringify(names)}`));
          }
          if (Date.now() > deadline) return done();
          return setTimeout(poll, 500);
        });
    })();
  });

  it('the option and the heap-statistics relay no longer exist', () => {
    const options = require('../../lib/cli-options');
    options.setOptions({withPM2: true});
    assert.strictEqual(options.withPM2, undefined);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(options.getOptions(), 'withPM2'), false);
    options.setOptions({});

    assert.strictEqual(require('../../lib/monitor').sendHeapStatMessageToParentController, undefined);
    assert.strictEqual(require('../../lib/monitor').onProcessMessage, undefined);
  });
});
