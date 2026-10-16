// --moduleSandbox: the default, the downgrade without --workerThread, the
// refusals, and the startup lines operators read.
const assert = require('assert');
const {startServer, stopServer} = require('../helpers/sandbox-server');

describe('sandbox 01: modes', function() {
  this.timeout(60000);
  let server = null;
  afterEach(() => { stopServer(server); server = null; });

  it('defaults to audit under --workerThread', async () => {
    server = await startServer(9605, ['--debug', '--debugKey', 'aabbcc', '--workerThread']);
    assert.ok(server.output.includes('module sandbox: mode audit'), server.output.slice(-2000));
  });

  it('downgrades the default to off without --workerThread, and says why', async () => {
    server = await startServer(9605, ['--debug', '--debugKey', 'aabbcc']);
    assert.ok(server.output.includes('module sandbox: off -- it needs --workerThread'), server.output.slice(-2000));
  });

  it('warns when the operator turns it off explicitly', async () => {
    server = await startServer(9605, ['--debug', '--debugKey', 'aabbcc', '--workerThread', '--moduleSandbox', 'off']);
    assert.ok(server.output.includes('module sandbox: off (--moduleSandbox off)'), server.output.slice(-2000));
  });

  it('refuses an explicit enforce without --workerThread', async () => {
    server = await startServer(9605, ['--debug', '--moduleSandbox', 'enforce'], {expectExit: true});
    assert.strictEqual(server.exitCode, 2);
    assert.ok(server.output.includes('--moduleSandbox enforce needs --workerThread'), server.output);
  });

  it('refuses an unknown mode', async () => {
    server = await startServer(9605, ['--debug', '--workerThread', '--moduleSandbox', 'strict'], {expectExit: true});
    assert.strictEqual(server.exitCode, 2);
    assert.ok(server.output.includes('--moduleSandbox must be one of off, audit, enforce'), server.output);
  });
});
