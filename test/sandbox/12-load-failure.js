// A worker that ends or blocks while its module loads must fail the load,
// not leave it (or a supervised restart) waiting forever.
const assert = require('assert');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');

const KEY  = 'aabbcc';
const TRAP = path.join(ROOT, 'test', 'fixtures', 'sandbox-load-trap');

describe('sandbox 12: a worker that fails while loading', function() {
  this.timeout(60000);
  let server = null;
  afterEach(() => { stopServer(server); server = null; });

  [['exit', /exit code 3/], ['block', /blocked event loop/]].forEach(([trap, reason]) => {
    it(`${trap}: the load fails with the reason, promptly`, async () => {
      server = await startServer(9614, ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread'],
        {env: {LOAD_TRAP: trap}});
      const t0 = Date.now();
      const r = await mcpCall(9614, KEY, 'countinghouse_load_module', {path: TRAP, name: 'sandbox-load-trap', version: '1.0.0'});
      assert.strictEqual(r.isError, true, JSON.stringify(r));
      assert.ok(reason.test(JSON.stringify(r)), JSON.stringify(r));
      assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
    });
  });
});
