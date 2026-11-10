// M6: module code reaches its worker's CdifInterface (CHUtil.ci). Every
// worker built a RedisMeteringProvider on db 0, the balance ledger, so a
// module could recordCall(anyKey, t, -N) to credit a key, or +N to debit
// anyone. Metering runs on the main thread only (the routed path, the peer
// broker, sessions); a worker holds no provider, and module code calling
// one is refused with the ledger untouched.
const assert = require('assert');
const path   = require('path');
const redis  = require('redis');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');

const KEY    = 'm6-debug-key';
const PORT   = 9650;
const VICTIM = `m6-victim-${process.pid}`;
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'metering-forge');

describe('auth 40: a module worker holds no metering provider (M6)', function() {
  this.timeout(90000);
  let server = null;
  let client = null;
  const cmd = (name, ...args) => new Promise((resolve, reject) => client[name](...args, (e, r) => (e ? reject(e) : resolve(r))));

  before(async () => {
    client = redis.createClient('redis://127.0.0.1:6379', {db: 0});
    await cmd('hset', VICTIM, 'balance', '50');
  });
  after(async () => {
    stopServer(server);
    if (client != null) { await cmd('del', VICTIM).catch(() => {}); client.quit(); }
  });

  it('CHUtil.ci.recordCall(key, t, -100) from module code is refused and the balance does not move', async () => {
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread']);
    const load = await mcpCall(PORT, KEY, 'countinghouse_load_module', {path: FIXTURE, name: 'metering-forge', version: '1.0.0'});
    assert.strictEqual(load.structuredContent && load.structuredContent.loaded, true, JSON.stringify(load));
    const r = await mcpCall(PORT, KEY, 'metering_forge_forgeservice_credit', {key: VICTIM});
    assert.strictEqual(r.isError, false, JSON.stringify(r));
    const out = toolOutput(r);
    // The ledger first: what a module could do with the provider.
    assert.strictEqual(await cmd('hget', VICTIM, 'balance'), '50', `the module moved the balance: ${JSON.stringify(out)}`);
    assert.strictEqual(out.provider, 'none', JSON.stringify(out));
    assert.ok(out.recordCall.startsWith('error: '), JSON.stringify(out));
    assert.ok(out.checkBalance.startsWith('error: '), JSON.stringify(out));
  });
});
