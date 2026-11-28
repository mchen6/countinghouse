'use strict';
// B-hopcharge (release 1, from #484): a remote call's charge is waited for
// at most METER_PENDING_MS (lib/metering/charge-bound.js), as a peer hop's
// is; past it the call answers, and the charge, issued once, still lands
// (or its failure is logged by the key's meterId, never the key).
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const {ROOT} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {startRemoteServer} = require('../helpers/remote-mcp-server');

const REMOTE = testPort(9828);
const KEY = `remote-charge-${require('crypto').randomBytes(6).toString('hex')}`;
const TOKEN = `ghp_${'A'.repeat(36)}`;

const tmpDirs = require('../helpers/test-tmp').forFile(['ch-remote-16'], {base: require('os').tmpdir()});
function probeAt(port) {
  const dir = path.join(tmpDirs.mkdtemp('ch-remote-16-'), 'remote-probe');
  fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'remote-probe'), dir, {recursive: true});
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.countinghouse.remotes[0].url = `http://127.0.0.1:${port}/mcp`;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  return dir;
}

describe('remote 16: a remote call\'s charge is waited for at most METER_PENDING_MS (B-hopcharge)', function() {
  this.timeout(60000);
  const cli = require('../../lib/cli-options');
  const registry = require('../../lib/remote');
  const credentials = require('../../lib/remote/credentials');
  const CHUtil = require('../../lib/countinghouse-util');
  const LOG = require('../../lib/logger');
  let remote = null;
  let savedCredentials = null;
  let savedOptions = null;
  let savedCi = null;
  let savedE = null;
  let savedI = null;
  const logged = [];
  // (process-wide state set here and put back in after(): options, the
  // credentials allowance, the metering stand-in, the logger's lines)
  before(async () => {
    require('../../lib/logger').createLogger();
    savedOptions = require('../helpers/options-scope').snapshot();
    savedCredentials = credentials.snapshot();
    cli.setOptions({workerThread: false, debug: true, mcpToolCallCost: 1});
    const file = path.join(tmpDirs.mkdtemp('ch-remote-16a-'), 'remote-credentials.json');
    fs.writeFileSync(file, JSON.stringify({[`http://127.0.0.1:${REMOTE}`]: ['CH_TEST_REMOTE_TOKEN']}));
    credentials.configure(file);
    process.env.CH_TEST_REMOTE_TOKEN = TOKEN;
    savedCi = CHUtil.ci;
    savedE = LOG.E;
    savedI = LOG.I;
    LOG.E = (e) => logged.push(['E', String(e && e.message ? e.message : e)]);
    LOG.I = (line) => logged.push(['I', String(line)]);
    remote = await startRemoteServer(REMOTE);
    registry.register('charge-probe', probeAt(REMOTE));
  });
  after(async () => {
    CHUtil.ci = savedCi;
    LOG.E = savedE;
    LOG.I = savedI;
    await registry.unregister('charge-probe');
    if (remote != null) await remote.close();
    credentials.restore(savedCredentials);
    require('../helpers/options-scope').restore(savedOptions);
    delete process.env.CH_TEST_REMOTE_TOKEN;
  });
  beforeEach(() => { logged.length = 0; });

  // a store that answers when told to
  const heldStore = () => {
    const calls = [];
    let release = null;
    CHUtil.ci = {recordCall: (key, tool, cost, cb) => { calls.push({key, tool, cost}); release = cb; }};
    return {calls, answer: (err, result) => release(err, result)};
  };

  it('a charge slower than the bound: the call answers at the bound, the charge issued once and logged when it lands', async () => {
    const store = heldStore();
    // (answered while the charge is still held: the store above never
    // answers until told, so an answer here is the bound's)
    const r = await registry.callRemote('charge-probe', 'probe', 'echo_text', {n: 1}, {billingKey: KEY});
    assert.ok(r != null && r.isError !== true, JSON.stringify(r));
    assert.ok(logged.some(([lvl, line]) => lvl === 'I' && /remote call remote:probe\/echo_text: billing pending/.test(line)), JSON.stringify(logged));
    assert.strictEqual(store.calls.length, 1, 'charged once');
    store.answer(null, {charged: 1, balance: 9});
    assert.ok(logged.some(([lvl, line]) => lvl === 'I' && /remote call remote:probe\/echo_text: the pending billing landed \(charged 1\)/.test(line)), JSON.stringify(logged));
    assert.strictEqual(store.calls.length, 1, 'never charged again');
  });

  it('a charge that fails after the bound: logged at error by the key\'s fingerprint and the amount, never the key; the call had its result', async () => {
    const store = heldStore();
    const r = await registry.callRemote('charge-probe', 'probe', 'echo_text', {n: 2}, {billingKey: KEY});
    assert.ok(r != null && r.isError !== true);
    store.answer(new Error('the store lock stayed busy for 10000 ms'));
    const errors = logged.filter(([lvl]) => lvl === 'E').map(([, line]) => line);
    const {meterId, keyFingerprint} = require('../../lib/key-fingerprint');
    assert.strictEqual(errors.length, 1, JSON.stringify(logged));
    assert.ok(errors[0].includes(keyFingerprint(KEY)) && errors[0].includes('amount 1') && /goes unbilled/.test(errors[0]) && !errors[0].includes(meterId(KEY)), errors[0]);
    assert.ok(!errors[0].includes(KEY), 'the key itself is never logged');
  });

  it('a charge within the bound: answered after it, as before', async () => {
    const calls = [];
    CHUtil.ci = {recordCall: (key, tool, cost, cb) => { calls.push(key); setTimeout(() => cb(null, {charged: 1}), 20); }};
    const r = await registry.callRemote('charge-probe', 'probe', 'echo_text', {n: 3}, {billingKey: KEY});
    assert.ok(r != null && r.isError !== true);
    assert.deepStrictEqual(calls, [KEY]);
    assert.ok(!logged.some(([, line]) => /pending/.test(line)), JSON.stringify(logged));
  });

  // a billed call runs only while its charge can be recorded (the owner's
  // decision, 11-27): a remote call goes out only then
  it('a remote call whose charge can\'t be recorded now is refused with the ledger\'s code before it goes out; nothing charged', async () => {
    const {CountinghouseError} = require('../../lib/countinghouse-error');
    const calls = [];
    CHUtil.ci = {chargeable: (key, cb) => setImmediate(cb, new CountinghouseError('LEDGER_UNREACHABLE')),
      recordCall: (key, tool, cost, cb) => { calls.push(key); cb(null, {charged: 1}); }};
    const err = await registry.callRemote('charge-probe', 'probe', 'echo_text', {n: 4}, {billingKey: KEY}).then(() => null, (e) => e);
    assert.strictEqual(err && err.code, 'LEDGER_UNREACHABLE', String(err && err.message));
    assert.deepStrictEqual(calls, []);
    CHUtil.ci.chargeable = (key, cb) => setImmediate(cb, null);
    const r = await registry.callRemote('charge-probe', 'probe', 'echo_text', {n: 5}, {billingKey: KEY});
    assert.ok(r != null && r.isError !== true, JSON.stringify(r));
    assert.deepStrictEqual(calls, [KEY]);
  });

  tmpDirs.hooks();
});
