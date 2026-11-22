'use strict';
// countinghouse_usage_report through the gateway, spawned (H7/K5; the medium
// on H7, 7): two runtimes one after the other on one usage directory, the
// first making one tool call. In ch-local's per-session profile (--stdio, the
// single identity, --settingsFile) the second's report leaves the first's
// call out; a plain --stdio launch (no --settingsFile) still counts it.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {startStdio, withoutRedisNoise, INITIALIZE} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');

// the identity secret, made at run time; with it the single identity's
// caller id (its stable id "local": lib/auth/memory-provider.js), the same
// in both runtimes, as lib/identity.js derives it
const SECRET = crypto.randomBytes(32).toString('hex');
const CALLER = `u_${crypto.createHmac('sha256', Buffer.from(SECRET, 'hex')).update('id:local', 'utf8').digest('base64url').slice(0, 22)}`;   // lib/identity.js ID_LENGTH

describe('usage 28: the report of a session\'s own runtime covers its own process (H7/K5)', function() {
  this.timeout(120000);
  let home;
  let io = null;
  beforeEach(() => { home = tmp.mkdtemp('ch-usage-28-'); });
  afterEach(async () => {
    if (io != null) { io.child.kill('SIGKILL'); await io.exited; }
    io = null;
    tmp.remove(home);
  });

  const start = (extra) => {
    // (the single identity: no auth file)
    return startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
      '--moduleDataPath', path.join(home, 'module_data'), '--modulePath', path.join(home, 'modules'), ...extra],
    {env: {COUNTINGHOUSE_IDENTITY_SECRET: SECRET}});
  };
  const open = async () => {
    await io.request({...INITIALIZE, id: 1}, 30000);
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
  };
  // an earlier process's record, in the usage directory both runtimes write
  const earlier = () => {
    const day = new Date().toISOString().slice(0, 10);
    const at = path.join(home, 'store', 'usage', day);
    fs.mkdirSync(at, {recursive: true});
    fs.writeFileSync(path.join(at, '1-1.jsonl'), `${JSON.stringify({t: new Date(Date.now() - 60000).toISOString(), call: 1, scenario: 'earlier-pack', tool: 'earlier_tool', bytesOut: 4, linesOut: 1, ms: 2, outcome: 'ok', caller: CALLER})}\n`);
  };
  const report = async (extra, before = async () => {}) => {
    io = start(extra);
    await open();
    await before();
    const r = await io.request({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'countinghouse_usage_report', arguments: {since: 'all'}}}, 60000);
    assert.ok(r.result != null && r.result.isError !== true, `${JSON.stringify(r).slice(0, 600)}; ${withoutRedisNoise(io.err)}`);
    return r.result.structuredContent;
  };

  it('a plain --stdio launch: the earlier process\'s call is counted, as before', async () => {
    earlier();
    const out = await report([]);
    assert.strictEqual(out.totals.calls, 1, JSON.stringify(out).slice(0, 800));
  });

  it('ch-local\'s profile: the earlier process\'s call is left out, this process\'s own counted', async () => {
    const settings = ['--settingsFile', path.join(home, 'settings.json'), '--loadModule', path.join(__dirname, '..', 'fixtures', 'usage-scenario')];
    earlier();
    // (this process's own call: the final pass, L5 -- the scope leaves out
    // the earlier process, never this one)
    const own = async () => {
      const called = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'usage_probe', arguments: {}}}, 60000);
      assert.ok(called.result != null && called.result.isError !== true, `${JSON.stringify(called).slice(0, 600)}; ${withoutRedisNoise(io.err)}`);
    };
    const out = await report(settings, own);
    assert.strictEqual(out.totals.calls, 1, JSON.stringify(out).slice(0, 800));
    assert.ok(JSON.stringify(out.groups).includes('usage_probe') && !JSON.stringify(out.groups).includes('earlier_tool'), JSON.stringify(out.groups));
  });
});
