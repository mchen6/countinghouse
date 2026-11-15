// Lean worker step 3 (the high review of #177): a handler's ctx.log in a lean
// worker reaches its device's log (it was dropped: the lean worker's device
// is a plain object, not a CHDevice), and a module naming another device in
// CHUtil.deviceLog writes nothing there: the main thread logs only under a
// device the sending worker hosts. Not under --debug, which prints device
// log entries instead of storing them.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const redis = require('redis');
const {ROOT, startServer, stopServer, post} = require('../helpers/sandbox-server');
const {testPort, redisUrlFor} = require('../helpers/test-env');
const {deviceIDForName} = require('../../lib/call-address');

const PORT = testPort(9753);
const KEY = 'module-loading-27-key';
const NAME = 'lean-log-probe';
const SERVICE = 'urn:countinghouse-test:serviceID:logService';
const DEVICE = deviceIDForName(NAME);
const OTHER = deviceIDForName('module-loading-27-other');

describe('module-loading 27: ctx.log from a lean worker reaches its device log, and only its own', function() {
  this.timeout(120000);
  let server = null;
  let base = null;
  let client = null;
  const entries = (deviceID) => new Promise((resolve, reject) => client.lrange(`devicelog:${deviceID}`, 0, -1, (e, r) => (e ? reject(e) : resolve(r))));
  before(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ml-27-'));
    const auth = path.join(base, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'module-loading-27', devices: ['*'], admin: true}}));
    client = redis.createClient(redisUrlFor(), {db: 10});
    await new Promise((resolve) => client.del(`devicelog:${DEVICE}`, `devicelog:${OTHER}`, () => resolve()));
    server = await startServer(PORT, ['--workerThread', '--authConfigPath', auth, '--moduleDataPath', path.join(base, 'store'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', NAME)]);
  });
  after(() => {
    stopServer(server);
    if (client != null) client.quit();
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });
  const call = async (actionName, input) => {
    const r = await post(PORT, KEY, `/devices/${DEVICE}/invoke-action`, {serviceID: SERVICE, actionName, input});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  };
  const until = async (fn, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await fn()) return true;
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  it('a handler\'s ctx.log reaches its device log', async () => {
    const marker = `ml27-${Date.now()}`;
    await call('log', {marker});
    assert.ok(await until(async () => (await entries(DEVICE)).some((e) => e.includes(marker)), 5000),
      `not in devicelog:${DEVICE}: ${JSON.stringify(await entries(DEVICE))}`);
  });

  it('CHUtil.deviceLog naming another device writes nothing to its log', async () => {
    const marker = `ml27-forged-${Date.now()}`;
    await call('forged', {marker, other: OTHER});
    await call('log', {marker: `${marker}-after`});
    // the module's own entry after it has landed, so the forged one had its turn
    assert.ok(await until(async () => (await entries(DEVICE)).some((e) => e.includes(`${marker}-after`)), 5000));
    assert.deepStrictEqual((await entries(OTHER)).filter((e) => e.includes(marker)), []);
  });
});
