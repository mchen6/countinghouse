// #144: a module that blocks while it is required never answers its load.
// Under audit and enforce the block watchdog ends it (sandbox 12); under
// --moduleSandbox off nothing did, and the worker stayed. A load bound
// (--moduleLoadTimeout, seconds) now covers every mode: a worker that has not
// answered its load in time is ended and the load fails MODULE_LOAD_TIMEOUT.
const assert = require('assert');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
// A copy of the options singleton, set from argv.
const optionsFrom = (argv) => { const o = Object.create(require('../../lib/cli-options')); o.setOptions(argv); return o; };

const KEY  = 'aabbcc';
const PORT = 9734;
const TRAP = path.join(ROOT, 'test', 'fixtures', 'sandbox-load-trap');

describe('sandbox 45: a load that never answers is bounded in every mode (#144)', function() {
  this.timeout(60000);
  let server = null;
  afterEach(() => { stopServer(server); server = null; });

  it('--moduleSandbox off: a module that blocks at require fails MODULE_LOAD_TIMEOUT within the bound, its worker ended, and the server serves on', async () => {
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', 'off',
      '--moduleLoadTimeout', '3'], {env: {LOAD_TRAP: 'block'}});
    const t0 = Date.now();
    const r = await mcpCall(PORT, KEY, 'countinghouse_load_module', {path: TRAP, name: 'sandbox-load-trap', version: '1.0.0'});
    const took = Date.now() - t0;
    assert.strictEqual(r.isError, true, JSON.stringify(r));
    assert.match(JSON.stringify(r), /MODULE_LOAD_TIMEOUT/);
    // before the authoring tool's own 15 s answer deadline: the bound answered, not the tool
    assert.ok(took >= 2500 && took < 12000, `took ${took} ms`);
    assert.match(server.output, /sandbox-load-trap: the load was not answered within 3 s; ending its worker/);
    // the server is not held: a second try is bounded the same way
    const again = await mcpCall(PORT, KEY, 'countinghouse_load_module', {path: TRAP, name: 'sandbox-load-trap', version: '1.0.0'});
    assert.match(JSON.stringify(again), /MODULE_LOAD_TIMEOUT/);
  });

  it('--moduleLoadTimeout: seconds, 120 by default; anything but a number > 0 that a timer can hold is refused', () => {
    assert.strictEqual(optionsFrom({}).moduleLoadTimeoutMs, 120000);
    assert.strictEqual(optionsFrom({}).moduleLoadTimeoutInvalid, null);
    assert.strictEqual(optionsFrom({moduleLoadTimeout: 3}).moduleLoadTimeoutMs, 3000);
    assert.strictEqual(optionsFrom({moduleLoadTimeout: 2.5}).moduleLoadTimeoutMs, 2500);
    for (const bad of [0, -1, 'soon', true, '', 99999999, Infinity]) {
      assert.deepStrictEqual(optionsFrom({moduleLoadTimeout: bad}).moduleLoadTimeoutInvalid, {value: bad}, String(bad));
    }
    assert.strictEqual(optionsFrom({moduleLoadTimeout: 3}).getOptionsForWorker().moduleLoadTimeoutMs, undefined, 'the main thread\'s alone');
  });

  it('a refused --moduleLoadTimeout stops the start, exit 2, saying why', async () => {
    for (const bad of [['--moduleLoadTimeout', '0'], ['--moduleLoadTimeout']]) {
      const s = await startServer(9735, ['--debug', '--debugKey', KEY, '--workerThread'].concat(bad), {expectExit: true});
      assert.strictEqual(s.exitCode, 2, s.output);
      assert.match(s.output, /--moduleLoadTimeout must be a number of seconds > 0/);
    }
  });
});
