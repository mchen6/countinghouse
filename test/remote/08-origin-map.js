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
// A --hardened start's HTTP port (stdio under --hardened is countinghouse #124).
const HARDENED_PORT = testPort(9748);
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

  const om = require('../../lib/remote/origin-map');
  // The map in effect, fixed as framework.js fixes it at start. Only the
  // tests reset it (several files share one process); nothing in the runtime can.
  const useMap = (spec) => { om.deactivateForTests(); if (spec != null) om.activate(om.parse(spec).map); };
  const MAP = () => `${DECLARED}=http://127.0.0.1:${STAND_IN}`;
  after(() => om.deactivateForTests());

  describe('the option', () => {
    const targets = (spec) => { const p = om.parse(spec); assert.strictEqual(p.problem, undefined, p.problem); return Object.fromEntries(Object.entries(p.map).map(([k, v]) => [k, v.target])); };
    it('takes <https origin>=<http loopback origin>, one per declared origin', () => {
      assert.deepStrictEqual(targets(`${GITHUB}=http://127.0.0.1:9`), {[GITHUB]: 'http://127.0.0.1:9'});
      assert.deepStrictEqual(Object.keys(targets([`${GITHUB}=http://[::1]:9`, 'https://linear-08.invalid=http://127.0.0.1:10'])), [GITHUB, 'https://linear-08.invalid']);
      assert.deepStrictEqual(targets('https://API.Example.invalid:443=http://127.0.0.1:9'), {'https://api.example.invalid': 'http://127.0.0.1:9'}, 'the origin as the runtime reads a declaration: normalised');
      assert.deepStrictEqual(targets(`${GITHUB}=http://127.0.0.1:80`), {[GITHUB]: 'http://127.0.0.1:80'}, 'port 80, as written');
      assert.strictEqual(om.parse(null).map, null);
    });
    it('refuses any other target, port 0 or above 65535, a key that is not an https origin, a repeated key, or no =', () => {
      for (const bad of [`${GITHUB}=https://127.0.0.1:9`, `${GITHUB}=http://10.0.0.1:9`, `${GITHUB}=http://localhost:9`, `${GITHUB}=http://127.0.0.1:9/mcp`, `${GITHUB}=http://127.0.0.1`,
        `${GITHUB}=http://127.0.0.1:0`, `${GITHUB}=http://127.0.0.1:65536`,
        `${GITHUB}/mcp=http://127.0.0.1:9`, 'http://github-08.invalid=http://127.0.0.1:9', GITHUB, [`${GITHUB}=http://127.0.0.1:9`, `${GITHUB}=http://127.0.0.1:10`]]) {
        const p = om.parse(bad);
        assert.ok(typeof p.problem === 'string' && /--remoteOriginMap/.test(p.problem), JSON.stringify(bad));
      }
    });
    it('the option is a string, not a boolean: --no-remoteOriginMap is none, a bare one is refused', () => {
      try {
        cli.setOptions({workerThread: false, remoteOriginMap: false});
        assert.strictEqual(cli.remoteOriginMapArg, null);
        cli.setOptions({workerThread: false, remoteOriginMap: true});
        assert.match(String(om.parse(cli.remoteOriginMapArg).problem), /--remoteOriginMap/);
        cli.setOptions({workerThread: false, remoteOriginMap: [`${GITHUB}=http://127.0.0.1:9`]});
        assert.deepStrictEqual(cli.remoteOriginMapArg, [`${GITHUB}=http://127.0.0.1:9`]);
      } finally {
        cli.setOptions({workerThread: false});
      }
    });

    it('a target on the Redis endpoint is a problem of the option; with no Redis configured there is none', () => {
      const {map} = om.parse(`${GITHUB}=http://127.0.0.1:${UNMAPPED}`);
      assert.match(om.problems(map, {host: '127.0.0.1', port: UNMAPPED}).join('\n'), /--remoteOriginMap .* the target is refused: it is the Redis endpoint/);
      assert.deepStrictEqual(om.problems(map, null), []);
    });
    it('the map is fixed at start: a write to cli-options or setOptions() changes nothing, and a second activation throws', () => {
      useMap(MAP());
      const fixed = om.current();
      assert.ok(Object.isFrozen(fixed) && Object.values(fixed).every(Object.isFrozen));
      cli.remoteOriginMap = {[GITHUB]: 'http://127.0.0.1:1'};
      cli.remoteOriginMapActive = false;
      cli.remoteOriginMapArg = null;
      cli.setOptions({workerThread: false});
      assert.strictEqual(om.current(), fixed);
      assert.throws(() => om.activate(om.parse(`${GITHUB}=http://127.0.0.1:1`).map), /already in effect/);
      assert.throws(() => { 'use strict'; fixed[GITHUB] = {target: 'http://127.0.0.1:1'}; }, TypeError);
      delete cli.remoteOriginMap; delete cli.remoteOriginMapActive;
      om.deactivateForTests();
    });
    it('the tests\' reset works only under the test flag, as the other test-only hooks do', () => {
      useMap(MAP());
      const fixed = om.current();
      const saved = process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG;
      delete process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG;
      try {
        assert.throws(() => om.deactivateForTests(), /only under the test flag/);
        assert.strictEqual(om.current(), fixed, 'the map stays');
      } finally {
        process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG = saved;
      }
      om.deactivateForTests();
      assert.strictEqual(om.current(), null);
    });
  });

  describe('a mapped remote', () => {
    const registry = require('../../lib/remote');
    const credentials = require('../../lib/remote/credentials');
    const remoteUsage = require('../../lib/remote/usage');
    let standIn = null;
    let u = null;
    before(async () => {
      cli.setOptions({workerThread: false, debug: false});
      useMap(MAP());   // what framework.js does once the gate holds
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
      om.deactivateForTests();
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
      assert.deepStrictEqual(u.totals(id).standIn, ['probe'], 'the structured receipt marks the stand-in too');
      assert.match(u.receiptSentenceOf(id), /in 1 call to probe \(acceptance stand-in\);/);
    });

    it('with no map fixed at start the registry applies none, whatever the options or the environment say later', async () => {
      om.deactivateForTests();
      cli.remoteOriginMapArg = MAP();
      cli.remoteOriginMapActive = true;
      process.env.COUNTINGHOUSE_ACCEPTANCE = '1';
      try {
        await registry.unregister('map-probe');
        const r = registry.register('map-probe', probe(`${DECLARED}/mcp`));
        assert.ok(!r.notes.some((n) => /mapped/.test(n)), r.notes.join('\n'));
      } finally {
        await registry.unregister('map-probe');
        delete process.env.COUNTINGHOUSE_ACCEPTANCE;
        delete cli.remoteOriginMapActive;
        cli.remoteOriginMapArg = null;
        useMap(MAP());
      }
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
        cli.setOptions({workerThread: false, debug: true});
        await registry.unregister('map-probe');
        const r = registry.register('map-probe', probe(`http://127.0.0.1:${UNMAPPED}/mcp`));
        assert.deepStrictEqual(r.problems, []);
        assert.ok(r.notes.some((n) => /is not covered by --remoteOriginMap; acceptance runs contact mapped origins only, so the remote is disabled/.test(n)), r.notes.join('\n'));
        await assert.rejects(registry.callRemote('map-probe', 'probe', 'echo_text', {n: 1}, {billingKey: 'k'}), (e) => e.code === 'REMOTE_CREDENTIAL_NOT_ALLOWED' && /not covered by --remoteOriginMap; acceptance runs contact mapped origins only/.test(e.message) && !/no credential/.test(e.message));
        await new Promise((res) => setTimeout(res, 200));
        assert.strictEqual(seen, 0, 'nothing reached the unmapped remote');
      } finally {
        await registry.unregister('map-probe');
        await new Promise((r) => counter.close(r));
        cli.setOptions({workerThread: false, debug: false});
      }
    });

    it('an error from the stand-in names it, not only the real origin', async () => {
      await registry.unregister('map-probe');
      useMap(`${DECLARED}=http://127.0.0.1:1`);
      try {
        registry.register('map-probe', probe(`${DECLARED}/mcp`));
        const listed = await registry.listing('map-probe', 'probe').then(() => null, (e) => e);
        const called = await registry.callRemote('map-probe', 'probe', 'echo_text', {n: 1}, {billingKey: 'k'}).then(() => null, (e) => e);
        const message = String((called || listed || {}).message);
        assert.match(message, /acceptance stand-in at http:\/\/127\.0\.0\.1:1/, message);
      } finally {
        await registry.unregister('map-probe');
        useMap(MAP());
      }
    });

    it('an unmapped remote is untouched: no mapped field, no stand-in note', async () => {
      cli.setOptions({workerThread: false, debug: true});
      om.deactivateForTests();
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
      assert.strictEqual(u.totals(id).standIn, undefined);
    });
  });

  // A tool call (Out) with one real server call and two a stand-in answered.
  const usageRecords = () => {
    const t = new Date(Date.now() - 1000).toISOString();   // before the report's window ends
    const base = {t, call: 1, tool: 'echo_text', bytesIn: 10, linesIn: 1, ms: 1, outcome: 'ok', credential: 'V', caller: 'u'};
    return [{...base, server: 'github'}, {...base, server: 'github', mapped: true}, {...base, server: 'github', mapped: true},
      {t, call: 1, server: null, pack: 'p', tool: 'outer', bytesOut: 5, linesOut: 1, ms: 1, outcome: 'ok', caller: 'u'}];
  };
  const STAND_IN_SECTION = {serverCalls: 2, bytesIn: 20, linesIn: 2, tokensInEst: 5, servers: {github: 2}};

  it('the aggregate counts stand-in calls in no total or grouping, only in its standIn section', () => {
    const r = aggregate(usageRecords().map((x) => ({...x, process: 'p-1'})));
    assert.deepStrictEqual(r.byServer.map((s) => [s.server, s.serverCalls]), [['github', 1]]);
    assert.strictEqual(r.totals.serverCalls, 1);
    assert.deepStrictEqual(r.byTool.map((x) => x.serverCalls), [1]);
    assert.deepStrictEqual(r.byPack.map((x) => x.serverCalls), [1]);
    assert.deepStrictEqual(r.processes.map((x) => x.serverCalls), [1]);
    assert.deepStrictEqual(r.replaced.map((x) => x.serverCalls), [1]);
    assert.deepStrictEqual(r.standIn, STAND_IN_SECTION);
    assert.strictEqual(aggregate([usageRecords()[0]].map((x) => ({...x, process: 'p-1'}))).standIn, undefined, 'none: no section');
  });

  it('the usage report counts them in no group or total either, in every grouping, and its schema takes the section', () => {
    const {usageReport, OUTPUT_SCHEMA, reportText} = require('../../lib/usage/report');
    const Ajv2020 = require('ajv/dist/2020');
    const ajv = new Ajv2020({strict: false});
    const usage = {process: 'p-1', records: usageRecords};
    for (const groupBy of ['tool', 'pack', 'server', 'module']) {
      const r = usageReport({groupBy}, {isAdmin: true}, {usage});
      assert.strictEqual(r.totals.serverCalls, 1, groupBy);
      assert.strictEqual(r.groups.reduce((s, g) => s + g.serverCalls, 0), 1, groupBy);
      assert.deepStrictEqual(r.standIn, STAND_IN_SECTION, groupBy);
      assert.ok(ajv.validate(OUTPUT_SCHEMA, r), JSON.stringify(ajv.errors));
    }
    assert.match(reportText(usageReport({groupBy: 'server'}, {isAdmin: true}, {usage})), /acceptance stand-in \(in no row or total above\): 2 server calls \(2 to github\)/);
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
    it('a target on the configured Redis endpoint refuses the start, blamed on the option, not a module', () => {
      // The Redis store (no --store local); the start stops at the option, before any connection.
      const store = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-08r-'));
      const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'countinghouse-stdio.js'), '--workerThread', '--redisUrl', `redis://127.0.0.1:${UNMAPPED}`, // run-local: not the shared Redis
        '--moduleDataPath', path.join(store, 'md'), '--modulePath', path.join(store, 'modules'), '--remoteOriginMap', `${GITHUB}=http://127.0.0.1:${UNMAPPED}`],
      {env: {...process.env, COUNTINGHOUSE_ACCEPTANCE: '1'}, input: '', encoding: 'utf8', timeout: 20000});
      fs.rmSync(store, {recursive: true, force: true});
      assert.strictEqual(r.status, 2, r.stderr.slice(-1500));
      assert.match(r.stderr, /--remoteOriginMap .*the target is refused: it is the Redis endpoint/);
      assert.ok(!/REMOTE_DECLARATION_INVALID/.test(r.stderr));
    });
    it('under --store local there is no Redis endpoint: a target on 6379 is honoured', () => {
      const r = start(['--remoteOriginMap', `${GITHUB}=http://127.0.0.1:6379`], {COUNTINGHOUSE_ACCEPTANCE: '1'});
      assert.match(r.stderr, /remote origin mapped: https:\/\/github-08\.invalid -> http:\/\/127\.0\.0\.1:6379 \(acceptance only\)/);
      assert.strictEqual(r.status, 0, r.stderr.slice(-1500));
    });
    it('under --hardened the mapping is logged once, by the child that serves', async () => {
      const {spawn} = require('child_process');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-08h-'));
      const child = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--workerThread', '--hardened', '--bindAddr', '127.0.0.1', '--port', String(HARDENED_PORT),
        '--store', 'local', '--storePath', path.join(root, 'store'), '--moduleDataPath', path.join(root, 'md'), '--modulePath', path.join(root, 'modules'),
        '--authConfigPath', path.join(root, 'auth.json'), '--remoteOriginMap', `${GITHUB}=http://127.0.0.1:9`],
      {env: {...process.env, COUNTINGHOUSE_ACCEPTANCE: '1'}, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      try {
        for (const until = Date.now() + 30000; !/countinghouse ready/.test(out) && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
        assert.match(out, /countinghouse ready/, out.slice(-2000));
        assert.strictEqual((out.match(/remote origin mapped: /g) || []).length, 1, out.slice(-2000));
      } finally {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { /* gone */ }
        await new Promise((r) => setTimeout(r, 500));
        try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ }
        fs.rmSync(root, {recursive: true, force: true});
      }
    });
    it('honoured, it says so loudly at start', () => {
      const r = start(['--remoteOriginMap', `${GITHUB}=http://127.0.0.1:9`], {COUNTINGHOUSE_ACCEPTANCE: '1'});
      assert.match(r.stdout + r.stderr, /remote origin mapped: https:\/\/github-08\.invalid -> http:\/\/127\.0\.0\.1:9 \(acceptance only\)/);
      assert.strictEqual(r.error, undefined, 'not killed at the timeout');
      assert.strictEqual(r.status, 0, r.stderr.slice(-1500));
    });
  });
});
