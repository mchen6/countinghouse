// #170: a module's worker cannot make the main thread decode an arbitrary
// size. Every message to the main thread is an envelope of bounded bytes
// (lib/message-envelope.js); over --maxOutputBytes plus 64 KiB it is refused
// in the worker; the lockdown pins the worker's port, so a patched
// MessagePort.prototype.postMessage is never handed it; a violation's long
// target is cut, not lost; a file larger than one bridge call still writes
// (the patch splits it).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');

const KEY = 'k';
const PORT = 9739;

describe('sandbox 48: messages to the main thread are bounded (#170)', function() {
  this.timeout(120000);
  let server = null;
  let base = null;
  before(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-msg-bound-'));
    server = await startServer(PORT, ['--workerThread', '--moduleSandbox', 'enforce', '--debug', '--debugKey', KEY,
      '--maxOutputBytes', String(1024 * 1024), '--moduleDataPath', path.join(base, 'data'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'message-bound')]);
  });
  after(() => {
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });
  const call = async (action, args) => toolOutput(await mcpCall(PORT, KEY, `message_bound_boundservice_${action.toLowerCase()}`, args || {}));

  it('a message over the cap is refused in the worker, MESSAGE_TOO_LARGE, and the worker carries on', async () => {
    const r = await call('big', {bytes: 2 * 1024 * 1024});
    assert.strictEqual(r.code, 'MESSAGE_TOO_LARGE', JSON.stringify(r));
    assert.doesNotMatch(server.output, /message bound: .*worker ended/, 'the main thread never had to end it');
    assert.strictEqual((await call('big', {bytes: 1000})).error, null, 'a small one still goes');
  });

  it('a patched MessagePort.prototype.postMessage is never handed the worker\'s port, and posting still works', async () => {
    const r = await call('patch');
    assert.strictEqual(r.captured, false, JSON.stringify(r));
    assert.strictEqual(r.after, 'ok');
  });

  it('a violation whose target is over the cap is still refused as a violation, and logged cut short', async () => {
    const r = await call('longPath');
    assert.notStrictEqual(r.code, 'MESSAGE_TOO_LARGE', JSON.stringify(r));
    assert.ok(r.refused, JSON.stringify(r));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.match(server.output, /violation loadFile \/etc\/a+\.\.\. \(\d+ characters\)/);
  });

  it('a 17 MiB file, larger than one bridge call, still writes', async () => {
    const raw = await mcpCall(PORT, KEY, 'message_bound_boundservice_writebig', {});
    assert.strictEqual(toolOutput(raw) && toolOutput(raw).size, 17 * 1024 * 1024, JSON.stringify(raw).slice(0, 600));
  });
});
