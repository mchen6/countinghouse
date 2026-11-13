// --remoteOriginMap <declared origin>=<loopback target> (reviewer, 2026-11-12;
// ch-local's acceptance run): the transport of a remote whose declared origin
// is mapped goes to a local stand-in, and nothing else changes. The
// declaration, the --remoteCredentials allowance, the variable and the
// receipt's servers stay the real ones.
// - Gated: honoured only with COUNTINGHOUSE_ACCEPTANCE=1 in the runtime's own
//   environment; with the flag and without it, the start is refused, naming
//   both.
// - Narrow: the target is http://127.0.0.1:<port> or http://[::1]:<port>, one
//   per declared origin, and the start says so loudly.
// - Marked: every usage record of a mapped call carries mapped: true, and the
//   receipt's sentence says "(acceptance stand-in)".
// No listing here can reach a real host. A remote registered with a map
// declares DECLARED, an https origin under .invalid that never resolves, so
// even a map that failed to apply sends nothing anywhere (an earlier version
// of this test declared GitHub's own origin, and before the option existed
// its listing reached it with a generated token). The unmapped case declares
// the stand-in itself, under --debug.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {ROOT} = require('../helpers/sandbox-server');
const {startRemoteServer} = require('../helpers/remote-mcp-server');
const {testPort} = require('../helpers/test-env');
const {createUsage, receiptSentence} = require('../../lib/usage');
const {aggregate} = require('../../lib/usage/aggregate');
require('../../lib/logger').createLogger(false);

const STAND_IN = testPort(9745);
// A plain HTTP server that only counts requests: what an unmapped remote must never reach.
const UNMAPPED = testPort(9744);
// Every origin here is under .invalid, the map's keys included (they need no
// real name: the runtime maps any https origin).
const GITHUB = 'https://github-08.invalid';
const DECLARED = 'https://remote-08.invalid';
const TOKEN = `ghp_${'B'.repeat(36)}`;

function probe(url) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-08-')), 'remote-probe');
  fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'remote-probe'), dir, {recursive: true});
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.countinghouse.remotes[0].url = url;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  return dir;
}

describe('remote 08: --remoteOriginMap sends a declared origin\'s calls to a local stand-in, gated and marked', function() {
  this.timeout(60000);
  const cli = require('../../lib/cli-options');

  describe('the option', () => {
    afterEach(() => cli.setOptions({workerThread: false}));
    it('takes <https origin>=<http loopback origin>, one per declared origin', () => {
      cli.setOptions({workerThread: false, remoteOriginMap: `${GITHUB}=http://127.0.0.1:9`});
      assert.deepStrictEqual(cli.remoteOriginMap, {[GITHUB]: 'http://127.0.0.1:9'});
      assert.strictEqual(cli.remoteOriginMapInvalid, null);
      cli.setOptions({workerThread: false, remoteOriginMap: [`${GITHUB}=http://[::1]:9`, 'https://linear-08.invalid=http://127.0.0.1:10']});
      assert.deepStrictEqual(Object.keys(cli.remoteOriginMap), [GITHUB, 'https://linear-08.invalid']);
      cli.setOptions({workerThread: false, remoteOriginMap: 'https://API.Example.com:443=http://127.0.0.1:9'});
      assert.deepStrictEqual(cli.remoteOriginMap, {'https://api.example.com': 'http://127.0.0.1:9'}, 'the origin as the runtime reads a declaration: normalised');
      cli.setOptions({workerThread: false});
      assert.strictEqual(cli.remoteOriginMap, null);
    });
    it('refuses any other target, a key that is not an https origin, a repeated key, or no =', () => {
      for (const bad of [`${GITHUB}=https://127.0.0.1:9`, `${GITHUB}=http://10.0.0.1:9`, `${GITHUB}=http://localhost:9`, `${GITHUB}=http://127.0.0.1:9/mcp`, `${GITHUB}=http://127.0.0.1`,
        `${GITHUB}/mcp=http://127.0.0.1:9`, 'http://github-08.invalid=http://127.0.0.1:9', GITHUB, [`${GITHUB}=http://127.0.0.1:9`, `${GITHUB}=http://127.0.0.1:10`]]) {
        cli.setOptions({workerThread: false, remoteOriginMap: bad});
        assert.ok(typeof cli.remoteOriginMapInvalid === 'string' && /--remoteOriginMap/.test(cli.remoteOriginMapInvalid), JSON.stringify(bad));
      }
    });
  });

  describe('a mapped remote', () => {
    const registry = require('../../lib/remote');
    const credentials = require('../../lib/remote/credentials');
    const remoteUsage = require('../../lib/remote/usage');
    let standIn = null;
    let u = null;
    before(async () => {
      cli.setOptions({workerThread: false, debug: false, remoteOriginMap: `${DECLARED}=http://127.0.0.1:${STAND_IN}`});
      cli.remoteOriginMapActive = true;   // what framework.js sets once the gate holds
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-08a-')), 'remote-credentials.json');
      fs.writeFileSync(file, JSON.stringify({[DECLARED]: ['CH_TEST_REMOTE_TOKEN']}));
      credentials.configure(file);
      process.env.CH_TEST_REMOTE_TOKEN = TOKEN;
      standIn = await startRemoteServer(STAND_IN);
    });
    after(async () => {
      await registry.unregister('map-probe');
      if (standIn != null) await standIn.close();
      remoteUsage.setRecorder(null);
      cli.setOptions({workerThread: false});
      delete process.env.CH_TEST_REMOTE_TOKEN;
    });

    it('declares the real origin, is allowed by the real allowance, and sends the real variable, to the stand-in, marked', async () => {
      await registry.unregister('map-probe');
      const r = registry.register('map-probe', probe(`${DECLARED}/mcp`));
      assert.deepStrictEqual(r.problems, []);
      assert.ok(r.notes.some((n) => n.includes(`sends CH_TEST_REMOTE_TOKEN to ${DECLARED}, mapped to http://127.0.0.1:${STAND_IN} (acceptance only)`)), r.notes.join('\n'));
      await registry.listing('map-probe', 'probe');
      u = createUsage({usageDir: null});
      remoteUsage.setRecorder(u);
      const id = u.beginCall({module: 'map-probe', tool: 'outer', caller: 'u_test'});
      await registry.callRemote('map-probe', 'probe', 'echo_text', {n: 1}, {billingKey: 'k', usageCall: id});
      assert.ok(standIn.headers.some((h) => h.authorization === `Bearer ${TOKEN}`), 'the stand-in got the real variable\'s value');
      assert.ok(standIn.paths.length > 0 && standIn.paths.every((p) => p === '/mcp'), 'the declared path, at the stand-in');
      const ins = u.records().filter((x) => x.bytesIn !== undefined);
      assert.strictEqual(ins.length, 1);
      assert.strictEqual(ins[0].mapped, true);
      assert.strictEqual(ins[0].server, 'probe', 'the declared server name');
      u.recordOut(id, {tool: 'outer', bytes: 2, lines: 1, ms: 1, outcome: 'ok'});
      assert.deepStrictEqual(u.totals(id).servers, ['probe']);
      assert.match(u.receiptSentenceOf(id), /in 1 call to probe \(acceptance stand-in\);/);
    });

    it('without the start\'s gate the registry applies no map, and a module setting the variable later changes nothing', async () => {
      cli.remoteOriginMapActive = false;
      process.env.COUNTINGHOUSE_ACCEPTANCE = '1';
      await registry.unregister('map-probe');
      const r = registry.register('map-probe', probe(`${DECLARED}/mcp`));
      assert.ok(!r.notes.some((n) => /mapped/.test(n)), r.notes.join('\n'));
      await registry.unregister('map-probe');
      delete process.env.COUNTINGHOUSE_ACCEPTANCE;
      cli.remoteOriginMapActive = true;
    });

    it('a declared path starting with // stays a path at the stand-in, never another host', async () => {
      await registry.unregister('map-probe');
      const r = registry.register('map-probe', probe(`${DECLARED}//elsewhere.invalid/mcp`));
      assert.deepStrictEqual(r.problems, []);
      const before = standIn.paths.length;
      await registry.listing('map-probe', 'probe');
      assert.ok(standIn.paths.length > before, 'the listing reached the stand-in');
      assert.ok(standIn.paths.slice(before).every((p) => p === '//elsewhere.invalid/mcp'), JSON.stringify(standIn.paths.slice(before)));
      await registry.unregister('map-probe');
    });

    it('a target on the Redis endpoint\'s port is refused, as a declared URL there is', async () => {
      const saved = cli.redisUrl;
      cli.redisUrl = `redis://127.0.0.1:${STAND_IN}`;
      try {
        await registry.unregister('map-probe');
        const r = registry.register('map-probe', probe(`${DECLARED}/mcp`));
        assert.ok(r.problems.some((p) => /Redis endpoint/.test(p)), JSON.stringify(r));
      } finally {
        cli.redisUrl = saved;
        await registry.unregister('map-probe');
      }
    });

    it('a mapped call is not metered', async () => {
      const CHUtil = require('../../lib/countinghouse-util');
      const ci = CHUtil.ci;
      let metered = 0;
      CHUtil.ci = {recordCall: (k, tool, cost, cb) => { metered++; cb(null); }};
      try {
        registry.register('map-probe', probe(`${DECLARED}/mcp`));
        await registry.listing('map-probe', 'probe');
        await registry.callRemote('map-probe', 'probe', 'echo_text', {n: 3}, {billingKey: 'k'});
      } finally {
        CHUtil.ci = ci;
        await registry.unregister('map-probe');
      }
      assert.strictEqual(metered, 0);
    });

    it('under an active map, a remote the map does not cover is disabled and never contacted', async () => {
      const http = require('http');
      let seen = 0;
      const counter = http.createServer((req, res) => { seen++; res.statusCode = 500; res.end(); });
      await new Promise((r) => counter.listen(UNMAPPED, '127.0.0.1', r));
      try {
        cli.setOptions({workerThread: false, debug: true, remoteOriginMap: `${DECLARED}=http://127.0.0.1:${STAND_IN}`});
        cli.remoteOriginMapActive = true;
        await registry.unregister('map-probe');
        const r = registry.register('map-probe', probe(`http://127.0.0.1:${UNMAPPED}/mcp`));
        assert.deepStrictEqual(r.problems, []);
        assert.ok(r.notes.some((n) => /is not in --remoteOriginMap; an acceptance run sends nothing to a real remote, so the remote is disabled/.test(n)), r.notes.join('\n'));
        await assert.rejects(registry.callRemote('map-probe', 'probe', 'echo_text', {n: 1}, {billingKey: 'k'}), (e) => e.code === 'REMOTE_CREDENTIAL_NOT_ALLOWED' && /not in --remoteOriginMap/.test(e.message));
        await new Promise((res) => setTimeout(res, 200));
        assert.strictEqual(seen, 0, 'nothing reached the unmapped remote');
      } finally {
        await registry.unregister('map-probe');
        await new Promise((r) => counter.close(r));
        cli.setOptions({workerThread: false, debug: false, remoteOriginMap: `${DECLARED}=http://127.0.0.1:${STAND_IN}`});
        cli.remoteOriginMapActive = true;
      }
    });

    it('an error from the stand-in names it, not only the real origin', async () => {
      await registry.unregister('map-probe');
      cli.setOptions({workerThread: false, debug: false, remoteOriginMap: `${DECLARED}=http://127.0.0.1:1`});
      cli.remoteOriginMapActive = true;
      try {
        registry.register('map-probe', probe(`${DECLARED}/mcp`));
        const listed = await registry.listing('map-probe', 'probe').then(() => null, (e) => e);
        const called = await registry.callRemote('map-probe', 'probe', 'echo_text', {n: 1}, {billingKey: 'k'}).then(() => null, (e) => e);
        const message = String((called || listed || {}).message);
        assert.match(message, /acceptance stand-in at http:\/\/127\.0\.0\.1:1/, message);
      } finally {
        await registry.unregister('map-probe');
        cli.setOptions({workerThread: false, debug: false, remoteOriginMap: `${DECLARED}=http://127.0.0.1:${STAND_IN}`});
        cli.remoteOriginMapActive = true;
      }
    });

    it('an unmapped remote is untouched: no mapped field, no stand-in note', async () => {
      cli.setOptions({workerThread: false, debug: true, remoteOriginMap: null});
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-08b-')), 'remote-credentials.json');
      fs.writeFileSync(file, JSON.stringify({[`http://127.0.0.1:${STAND_IN}`]: ['CH_TEST_REMOTE_TOKEN']}));
      credentials.configure(file);
      await registry.unregister('map-probe');
      const r = registry.register('map-probe', probe(`http://127.0.0.1:${STAND_IN}/mcp`));
      assert.ok(!r.notes.some((n) => /mapped/.test(n)), r.notes.join('\n'));
      await registry.listing('map-probe', 'probe');
      u = createUsage({usageDir: null});
      remoteUsage.setRecorder(u);
      const id = u.beginCall({module: 'map-probe', tool: 'outer', caller: 'u_test'});
      await registry.callRemote('map-probe', 'probe', 'echo_text', {n: 2}, {billingKey: 'k', usageCall: id});
      const ins = u.records().filter((x) => x.bytesIn !== undefined);
      assert.strictEqual(ins[0].mapped, undefined);
      u.recordOut(id, {tool: 'outer', bytes: 2, lines: 1, ms: 1, outcome: 'ok'});
      assert.ok(!/acceptance/.test(u.receiptSentenceOf(id)));
    });
  });

  it('the usage report keeps stand-in calls in a row of their own', () => {
    const t = new Date().toISOString();
    const base = {t, call: 1, tool: 'echo_text', bytesIn: 10, linesIn: 1, ms: 1, outcome: 'ok', credential: 'V', caller: 'u', process: 'p-1'};
    const r = aggregate([{...base, server: 'github'}, {...base, server: 'github', mapped: true}, {...base, server: 'github', mapped: true}]);
    const rows = Object.fromEntries(r.byServer.map((s) => [s.server, s.serverCalls]));
    assert.deepStrictEqual(rows, {'github (acceptance stand-in)': 2, github: 1});
  });

  it('the usage report, grouped by server, keeps stand-in calls in a row of their own too', () => {
    const {usageReport} = require('../../lib/usage/report');
    const t = new Date().toISOString();
    const base = {t, call: 1, tool: 'echo_text', bytesIn: 10, linesIn: 1, ms: 1, outcome: 'ok', credential: 'V', caller: 'u'};
    const usage = {process: 'p-1', records: () => [{...base, server: 'github'}, {...base, server: 'github', mapped: true}, {...base, server: 'github', mapped: true}]};
    const r = usageReport({groupBy: 'server'}, {isAdmin: true}, {usage});
    const rows = Object.fromEntries(r.groups.filter((g) => g.serverCalls > 0).map((g) => [g.server, g.serverCalls]));
    assert.deepStrictEqual(rows, {'github (acceptance stand-in)': 2, github: 1});
  });

  it('receiptSentence marks each mapped server', () => {
    const r = {calls: 3, linesIn: 10, bytesIn: 100, linesOut: 1, bytesOut: 10, servers: ['github', 'linear']};
    assert.strictEqual(receiptSentence(r, {github: 2, linear: 1}, new Set(['github'])),
      'read 10 lines (100 B) in 2 calls to github (acceptance stand-in) and 1 to linear; 1 line (10 B) reached the model.');
  });

  describe('the start', () => {
    // The local store keeps no Redis, so no --redisUrl (framework.js refuses both).
    const start = (args, env) => {
      const store = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-08s-'));
      const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'countinghouse-stdio.js'), '--workerThread', '--store', 'local', '--storePath', path.join(store, 'store'),
        '--moduleDataPath', path.join(store, 'md'), '--modulePath', path.join(store, 'modules'), ...args],
      {env: {...process.env, ...env}, input: '', encoding: 'utf8', timeout: 20000});
      fs.rmSync(store, {recursive: true, force: true});
      return r;
    };
    const ENV_OFF = {COUNTINGHOUSE_ACCEPTANCE: ''};
    it('with the flag but without COUNTINGHOUSE_ACCEPTANCE=1, it refuses, naming both', () => {
      const r = start(['--remoteOriginMap', `${GITHUB}=http://127.0.0.1:9`], ENV_OFF);
      assert.strictEqual(r.status, 2, r.stderr);
      assert.match(r.stderr, /--remoteOriginMap needs COUNTINGHOUSE_ACCEPTANCE=1/);
    });
    it('a bad map refuses the start too', () => {
      const r = start(['--remoteOriginMap', `${GITHUB}=http://10.0.0.1:9`], {COUNTINGHOUSE_ACCEPTANCE: '1'});
      assert.strictEqual(r.status, 2, r.stderr);
      assert.match(r.stderr, /--remoteOriginMap/);
    });
    it('honoured, it says so loudly at start', () => {
      const r = start(['--remoteOriginMap', `${GITHUB}=http://127.0.0.1:9`], {COUNTINGHOUSE_ACCEPTANCE: '1'});
      assert.match(r.stdout + r.stderr, /remote origin mapped: https:\/\/github-08\.invalid -> http:\/\/127\.0\.0\.1:9 \(acceptance only\)/);
      assert.strictEqual(r.error, undefined, 'not killed at the timeout');
      assert.strictEqual(r.status, 0, r.stderr.slice(-1500));
    });
  });
});
