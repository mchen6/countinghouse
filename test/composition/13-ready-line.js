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

// Under --withPM2 the server also tells its parent process it is ready, which
// is what PM2's wait_ready (or any supervisor that forked it) acts on. That
// message has to carry the same promise as the log line. It used to be sent
// at "all module discovered", before the composition verdicts, so a
// supervisor could route traffic to a server whose composites still answered
// CTX_CALL_NOT_READY.
describe('composition 13b: the --withPM2 ready message means the same thing', function() {
  this.timeout(60000);

  let server    = null;
  let firstCall = null;

  before((done) => {
    server = fork(path.join(ROOT, 'framework.js'), [
      '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(PORT_PM2),
      '--mcpToolCallCost', '1',
      '--debug', '--debugKey', CALLER_KEY,
      '--authConfigPath', path.join(__dirname, 'fixtures-auth.json'),
      '--loadModule', path.join(FIXTURES, 'compose-callee'),
      '--loadModule', path.join(FIXTURES, 'compose-caller'),
      '--withPM2'
    ], {silent: true});

    server.stdout.on('data', () => {});   // keep the pipe drained
    server.stderr.on('data', () => {});

    const timer = setTimeout(() => done(new Error('no ready message within 45 s')), 45000);

    server.once('message', (message) => {
      clearTimeout(timer);
      if (message !== 'ready') return done(new Error(`expected 'ready', got ${JSON.stringify(message)}`));

      request(`http://127.0.0.1:${PORT_PM2}`)
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

  it('a composite called the instant the message arrives makes its hop', () => {
    assert.ifError(firstCall.err);
    const text = JSON.stringify(firstCall.body);
    assert.ok(!/CTX_CALL_NOT_READY/.test(text), `ctx.call was not ready: ${text}`);
    assert.strictEqual(firstCall.body.result.isError, false, `expected a successful call, got ${text}`);
  });
});
