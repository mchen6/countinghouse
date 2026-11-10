// M9: --mcpToolCallCost was parseFloat'ed and never checked. A negative cost
// credits every caller on every call; NaN or Infinity make recordCall fail,
// which the call path treats as infrastructure trouble and serves free;
// "1abc" silently became 1. Anything but a finite number >= 0 is a start-up
// error, exit 2, naming the flag.
const assert = require('assert');
const {startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');

const PORT = 9651;

describe('auth 41: --mcpToolCallCost must be a finite number >= 0 (M9)', function() {
  this.timeout(60000);
  let server = null;
  afterEach(() => { stopServer(server); server = null; });

  [['--mcpToolCallCost=-1'], ['--mcpToolCallCost', 'abc'], ['--mcpToolCallCost', '1abc'], ['--mcpToolCallCost', '1e999'],
    ['--mcpToolCallCost'], ['--mcpToolCallCost=']].forEach((flag) => {
    it(`${flag.join(' ')} exits 2, naming the flag`, async () => {
      server = await startServer(PORT, ['--no-workerThread', '--debug', '--debugKey', 'k'].concat(flag), {expectExit: true});
      assert.strictEqual(server.exitCode, 2, server.output.slice(-1000));
      assert.ok(server.output.includes('--mcpToolCallCost'), server.output.slice(-1000));
    });
  });

  ['0', '2.5'].forEach((v) => {
    it(`--mcpToolCallCost ${v} starts`, async () => {
      server = await startServer(PORT, ['--no-workerThread', '--debug', '--debugKey', 'k', '--mcpToolCallCost', v]);
      const r = await mcpCall(PORT, 'k', 'countinghouse_check_balance', {});
      assert.notStrictEqual(r, null);
    });
  });
});
