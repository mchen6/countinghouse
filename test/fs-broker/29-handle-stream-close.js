// A file handle's stream left while a read is in flight (the broker's
// FileHandle): leaving readLines() early and closing the handle, or closing
// it from a 'data' listener. Node's own FileHandle destroys the stream on
// close, with no error and nothing uncaught; the brokered one does the same,
// so a read the broker answers after the close (EBADF) is dropped, never
// thrown in the module's worker.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {runBrokered} = require('../helpers/brokered-worker');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {mkdtemp} = require('../helpers/test-tmp');
const {toolOutput} = require('../helpers/tool-result');

const SCRIPT = path.join(__dirname, 'scripts', 'handle-stream-close.js');
const PROBE = path.join(ROOT, 'test', 'fixtures', 'handle-stream-probe');
const KEY = 'aabbcc';
const TOOL = 'handle_stream_probe_probeservice_leave';

describe('fs-broker 29: a file handle\'s stream left mid-read', function() {
  this.timeout(120000);

  it('the brokered handle behaves as Node\'s own: the stream closes, no error, nothing uncaught', async () => {
    const plain = await runBrokered(SCRIPT, {patch: false});
    assert.strictEqual(plain.ok, true, JSON.stringify(plain));
    assert.deepStrictEqual(plain.r, {early: [1], mid: ['data,close'], buffered: 'finish,close,handle closed abc', toEnd: 'end,close',
      parity: {webNotAhead: 'start', webSecond: 'ERR_INVALID_STATE', webByob: '4', webClosed: 'ERR_INVALID_STATE', webClosing: 'ERR_INVALID_STATE closing',
        webClose: 'done', 'web-break': '1 closed', 'web-toEnd': 'closed fd -1', 'web-paused': 'closed fd -1', destroyNoAutoClose: 'handle closed', firstClose: 'rejected:once', secondClose: 'resolved'},
      uncaught: []}, 'Node\'s own FileHandle');
    const brokered = await runBrokered(SCRIPT);
    assert.strictEqual(brokered.ok, true, JSON.stringify(brokered));
    assert.deepStrictEqual(brokered.r, plain.r);
  });

  // a read answered after its handle closed (a broker answering out of order,
  // or a read that fails for another reason as the handle closes) is the end
  // of the file to a stream already destroyed: it closes with no error
  it('a read answered with an error after the close is dropped; a write stream\'s writes are done before the handle closes, which alone closes its descriptor', async () => {
    const m = await runBrokered(path.join(__dirname, 'scripts', 'handle-stream-late-error.js'), {patch: false});
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    assert.deepStrictEqual(m.r, {inFlight: 'data,close', early: 1, destroyed: 'close', 'write-end': 'handle closed closes:1',
      'write-destroy': 'handle closed closes:1', 'write-close': 'handle closed closes:1 wrote:abc', 'write-close-flush': 'handle closed closes:1 wrote:abc',
      'write-failed': 'error:EIO,one close closes:1',
      // (ERR_STREAM_DESTROYED: Node's own, for a stream destroyed with a write
      // in flight; its stream settles before its handle, as Node's own)
      'write-in-flight': 'error:ERR_STREAM_DESTROYED,handle closed closes:1',
      'flush-late': 'handle closed closes:1', 'close-listener-throws': 'rejected: a listener of its own',
      'handle-write': 'written:abc closes:1', 'handle-readFile': 'read:40', 'every-method': 'every one held', 'listener-throws-stream': 'rejected: a listener of its own; stream closed, no error', 'web-stream': 'read open', 'flush-destroyed': 'error:ERR_STREAM_DESTROYED,handle closed closes:1',
      afterClose: 'ERR_OUT_OF_RANGE', uncaught: []});
  });

  describe('a module that does it stays up, with nothing uncaught', () => {
    let server = null;
    let base = null;
    beforeEach(() => { base = mkdtemp('hsc-'); });
    afterEach(() => {
      stopServer(server);
      server = null;
      fs.rmSync(base, {recursive: true, force: true});
    });

    ['audit', 'enforce'].forEach((mode) => {
      it(mode, async () => {
        server = await startServer(testPort(9758), ['--workerThread', '--debug', '--debugKey', KEY, '--moduleSandbox', mode,
          '--moduleDataPath', path.join(base, 'store'), '--loadModule', PROBE]);
        for (let i = 0; i < 5; i++) {
          for (const how of ['early', 'mid']) {
            const r = await mcpCall(testPort(9758), KEY, TOOL, {how});
            assert.deepStrictEqual(toolOutput(r), {how, detail: how === 'early' ? '1' : 'data,close'}, JSON.stringify(r));
          }
        }
        // a read answered after its handle closed lands within a few turns
        await new Promise((resolve) => setTimeout(resolve, 500));
        const up = await mcpCall(testPort(9758), KEY, TOOL, {how: 'nothing'});
        assert.deepStrictEqual(toolOutput(up), {how: 'nothing', detail: 'up'}, JSON.stringify(up));
        assert.ok(!/Uncaught exception in worker thread/.test(server.output), server.output.split('\n').filter((l) => /Uncaught|EBADF/.test(l)).join('\n').slice(0, 2000));
        assert.ok(!/EBADF/.test(server.output), server.output.split('\n').filter((l) => /EBADF/.test(l)).join('\n').slice(0, 2000));
      });
    });
  });
});
