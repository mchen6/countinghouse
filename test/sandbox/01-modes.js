// --moduleSandbox: the default (worker mode is the default from 8.0.0), off
// in single-thread mode, the refusals, and the startup lines operators read.
const assert = require('assert');
const {startServer, stopServer} = require('../helpers/sandbox-server');

describe('sandbox 01: modes', function() {
  this.timeout(60000);
  let server = null;
  afterEach(() => { stopServer(server); server = null; });

  it('defaults to audit with no thread flag (worker mode is the default)', async () => {
    server = await startServer(9605, ['--debug', '--debugKey', 'aabbcc'], // thread-flag-check: default on purpose
      {env: {COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG: '0'}});
    assert.ok(server.output.includes('module sandbox: mode audit'), server.output.slice(-2000));
  });

  it('is off in single-thread mode, and says why and that the mode is for debugging', async () => {
    server = await startServer(9605, ['--no-workerThread', '--debug', '--debugKey', 'aabbcc']);
    assert.ok(server.output.includes('module sandbox: off -- it needs --workerThread'), server.output.slice(-2000));
    assert.ok(server.output.includes('single-thread mode (--no-workerThread) is for debugging modules'), server.output.slice(-2000));
  });

  it('warns when the operator turns it off explicitly', async () => {
    server = await startServer(9605, ['--debug', '--debugKey', 'aabbcc', '--workerThread', '--moduleSandbox', 'off']);
    assert.ok(server.output.includes('module sandbox: off (--moduleSandbox off)'), server.output.slice(-2000));
  });

  it('refuses an explicit enforce without --workerThread', async () => {
    server = await startServer(9605, ['--no-workerThread', '--debug', '--moduleSandbox', 'enforce'], {expectExit: true});
    assert.strictEqual(server.exitCode, 2);
    assert.ok(server.output.includes('--moduleSandbox enforce needs --workerThread'), server.output);
  });

  it('refuses an unknown mode', async () => {
    server = await startServer(9605, ['--debug', '--workerThread', '--moduleSandbox', 'strict'], {expectExit: true});
    assert.strictEqual(server.exitCode, 2);
    assert.ok(server.output.includes('--moduleSandbox must be one of off, audit, enforce'), server.output);
  });
});
