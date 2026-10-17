// Every module worker's fs goes through its broker, in every mode.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');
const {mkdtemp} = require('../helpers/test-tmp');

const KEY = 'aabbcc';
const PROBE = path.join(ROOT, 'test', 'fixtures', 'fs-probe');
const tool = (a) => `fs_probe_probeservice_${a}`;

describe('fs-broker 09: module workers use the broker', function() {
  this.timeout(120000);
  let server = null;
  let base = null;
  const outsideDirs = [];
  beforeEach(() => { base = mkdtemp('wired-'); });
  afterEach(() => {
    stopServer(server);
    server = null;
    fs.rmSync(base, {recursive: true, force: true});
    outsideDirs.splice(0).forEach((d) => fs.rmSync(d, {recursive: true, force: true}));
  });

  function start(mode) {
    return startServer(9626, ['--workerThread', '--debug', '--debugKey', KEY, '--moduleSandbox', mode,
      '--moduleDataPath', path.join(base, 'store'), '--loadModule', PROBE]);
  }

  ['off', 'audit', 'enforce'].forEach((mode) => {
    it(`${mode}: /data is the module's own data directory`, async () => {
      server = await start(mode);
      const w = await mcpCall(9626, KEY, tool('write'), {path: '/data/x', content: 'hello'});
      assert.deepStrictEqual(w.structuredContent.output, {ok: true, code: null}, JSON.stringify(w));
      assert.strictEqual(fs.readFileSync(path.join(base, 'store', 'fs-probe', 'data', 'x'), 'utf8'), 'hello');
      const r = await mcpCall(9626, KEY, tool('read'), {path: '/data/x'});
      assert.deepStrictEqual(r.structuredContent.output, {content: 'hello', code: null});
    });
  });

  // Outside the namespace and outside /tmp (virtual).
  function outsidePath() {
    const dir = fs.mkdtempSync(path.join(os.homedir(), '.ch-wired-'));
    outsideDirs.push(dir);
    return path.join(dir, 'outside.txt');
  }

  it('audit: a path outside the namespace passes through and is logged', async () => {
    server = await start('audit');
    const outside = outsidePath();
    const w = await mcpCall(9626, KEY, tool('write'), {path: outside, content: 'o'});
    assert.strictEqual(w.structuredContent.output.ok, true, JSON.stringify(w));
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'o');
    await waitFor(async () => server.output.includes(`module sandbox: fs-probe file outside ${outside}`), 5000, 'outside log line');
  });

  it('enforce refuses a path outside the namespace (ENOENT) and logs it', async () => {
    server = await start('enforce');
    const outside = outsidePath();
    const w = await mcpCall(9626, KEY, tool('write'), {path: outside, content: 'o'});
    assert.deepStrictEqual(w.structuredContent.output, {ok: false, code: 'ENOENT'}, JSON.stringify(w));
    assert.strictEqual(fs.existsSync(outside), false);
    await waitFor(async () => server.output.includes(`module sandbox: fs-probe file outside ${outside}`), 5000, 'outside log line');
    // The worker booted and loaded the module with countinghouse's own code
    // read under the boot grant, not through the broker (review C1).
    [ROOT, fs.realpathSync(ROOT)].forEach((r) => assert.ok(!server.output.includes(`file outside ${r}`), server.output));
  });

  // Only what module code did is reported in the module's name: countinghouse's
  // own boot (and its dependencies' probing) is not (reviewer, plan 3 Task 3).
  it('audit: a worker that only loads its module reports no outside access', async () => {
    server = await start('audit');
    await mcpCall(9626, KEY, tool('read'), {path: '/data/none'});
    assert.ok(!server.output.includes('module sandbox: fs-probe file outside'), server.output);
  });

  it('data survives a restart of the module', async () => {
    server = await start('audit');
    await mcpCall(9626, KEY, tool('write'), {path: '/data/keep', content: 'kept'});
    const r1 = await post(9626, KEY, '/restart-module', {name: 'fs-probe'});
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
    await waitFor(async () => (await mcpCall(9626, KEY, tool('read'), {path: '/data/keep'})).structuredContent.output.content === 'kept', 15000, 'read after restart');
  });

  // A module loaded from under /tmp, and data under /tmp, still work.
  ['off', 'audit'].forEach((mode) => {
    it(`${mode}: a module loaded from under /tmp still loads and works`, async () => {
      const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-fsprobe-'));
      fs.cpSync(PROBE, copy, {recursive: true});
      try {
        server = await startServer(9626, ['--workerThread', '--debug', '--debugKey', KEY, '--moduleSandbox', mode,
          '--moduleDataPath', path.join(base, 'store'), '--loadModule', copy]);
        const w = await mcpCall(9626, KEY, tool('write'), {path: '/data/x', content: 'from tmp'});
        assert.deepStrictEqual(w.structuredContent.output, {ok: true, code: null}, JSON.stringify(w));
      } finally {
        fs.rmSync(copy, {recursive: true, force: true});
      }
    });
  });

  it('a --moduleDataPath under /tmp works', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-store-'));
    try {
      server = await startServer(9626, ['--workerThread', '--debug', '--debugKey', KEY, '--moduleDataPath', store, '--loadModule', PROBE]);
      await mcpCall(9626, KEY, tool('write'), {path: '/data/x', content: 'y'});
      assert.strictEqual(fs.readFileSync(path.join(store, 'fs-probe', 'data', 'x'), 'utf8'), 'y');
    } finally {
      fs.rmSync(store, {recursive: true, force: true});
    }
  });

  it('a data directory that cannot be created fails the load and says what to do', async () => {
    const ro = path.join(base, 'ro');
    fs.mkdirSync(ro);
    fs.chmodSync(ro, 0o500);
    try {
      server = await startServer(9626, ['--workerThread', '--debug', '--debugKey', KEY, '--authoringTools',
        '--moduleDataPath', path.join(ro, 'store')]);
      const r = await mcpCall(9626, KEY, 'countinghouse_load_module', {path: PROBE, name: 'fs-probe', version: '1.0.0'});
      assert.ok(/set --moduleDataPath to a writable directory/.test(JSON.stringify(r)), JSON.stringify(r));
    } finally {
      fs.chmodSync(ro, 0o700);
    }
  });

  it('enforce: a hard link made through the broker inside /data does not stop a restart (review I4)', async () => {
    server = await start('enforce');
    await mcpCall(9626, KEY, tool('write'), {path: '/data/a', content: 'x'});
    fs.linkSync(path.join(base, 'store', 'fs-probe', 'data', 'a'), path.join(base, 'store', 'fs-probe', 'data', 'b'));   // as link() inside one root would
    const r1 = await post(9626, KEY, '/restart-module', {name: 'fs-probe'});
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
    await waitFor(async () => (await mcpCall(9626, KEY, tool('read'), {path: '/data/b'})).structuredContent.output.content === 'x', 15000, 'read after restart');
  });

  it('enforce: a planted absolute symlink or hard link under the data directory refuses the load, naming it', async () => {
    const store = path.join(base, 'store');
    fs.mkdirSync(path.join(store, 'fs-probe', 'data'), {recursive: true});
    fs.symlinkSync('/nonexistent-ch-target', path.join(store, 'fs-probe', 'data', 'dest'));   // a dangling copyFile/rename destination (plan 2a M3)
    server = await start('enforce');
    await waitFor(async () => server.output.includes('links that could lead outside'), 15000, 'refusal');
    assert.ok(server.output.includes('/data/dest'), server.output.slice(-2000));
    const r = await mcpCall(9626, KEY, tool('read'), {path: '/data/x'});
    assert.ok(/unknown tool/.test(JSON.stringify(r)), 'the module must not have loaded');
  });

  it('audit: the same entry is logged and the module loads', async () => {
    const store = path.join(base, 'store');
    fs.mkdirSync(path.join(store, 'fs-probe', 'data'), {recursive: true});
    fs.symlinkSync('/nonexistent-ch-target', path.join(store, 'fs-probe', 'data', 'dest'));
    server = await start('audit');
    const w = await mcpCall(9626, KEY, tool('write'), {path: '/data/x', content: 'y'});
    assert.deepStrictEqual(w.structuredContent.output, {ok: true, code: null});
    assert.ok(server.output.includes('/data/dest'), server.output.slice(-2000));
  });

  it('every mode: /tmp is emptied when the worker starts', async () => {
    const store = path.join(base, 'store');
    fs.mkdirSync(path.join(store, 'fs-probe', 'tmp'), {recursive: true});
    fs.writeFileSync(path.join(store, 'fs-probe', 'tmp', 'old'), 'stale');
    server = await start('off');
    const r = await mcpCall(9626, KEY, tool('read'), {path: '/tmp/old'});
    assert.deepStrictEqual(r.structuredContent.output, {content: null, code: 'ENOENT'});
  });

  it('enforce: the policy\'s diskMb reaches the broker in megabytes (ENOSPC past 1 MB)', async () => {
    const policy = path.join(base, 'policy.json');
    fs.writeFileSync(policy, JSON.stringify({modules: {'fs-probe': {approve: 'as-declared', limits: {diskMb: 1}}}}));
    server = await startServer(9626, ['--workerThread', '--debug', '--debugKey', KEY, '--moduleSandbox', 'enforce', '--modulePolicy', policy,
      '--moduleDataPath', path.join(base, 'store'), '--loadModule', PROBE]);
    const small = await mcpCall(9626, KEY, tool('write'), {path: '/data/small', content: '0123456789', repeat: 50000});   // 500 KB
    assert.deepStrictEqual(small.structuredContent.output, {ok: true, code: null}, JSON.stringify(small));
    const big = await mcpCall(9626, KEY, tool('write'), {path: '/data/big', content: '0123456789', repeat: 200000});      // 2 MB
    assert.deepStrictEqual(big.structuredContent.output, {ok: false, code: 'ENOSPC'}, JSON.stringify(big));
  });

  it('enforce: the policy\'s disk limits reach the broker (ENOSPC past diskEntries)', async () => {
    const policy = path.join(base, 'policy.json');
    fs.writeFileSync(policy, JSON.stringify({modules: {'fs-probe': {approve: 'as-declared', limits: {diskEntries: 2}}}}));
    server = await startServer(9626, ['--workerThread', '--debug', '--debugKey', KEY, '--moduleSandbox', 'enforce', '--modulePolicy', policy,
      '--moduleDataPath', path.join(base, 'store'), '--loadModule', PROBE]);
    for (const f of ['a', 'b']) {
      const w = await mcpCall(9626, KEY, tool('write'), {path: `/data/${f}`, content: f});
      assert.deepStrictEqual(w.structuredContent.output, {ok: true, code: null}, JSON.stringify(w));
    }
    const third = await mcpCall(9626, KEY, tool('write'), {path: '/data/c', content: 'c'});
    assert.deepStrictEqual(third.structuredContent.output, {ok: false, code: 'ENOSPC'}, JSON.stringify(third));
  });

  it('logs the broker\'s capacity at startup in worker mode', async () => {
    server = await start('audit');
    assert.ok(/file broker: up to \d+ module file operations in flight/.test(server.output), server.output.slice(-2000));
  });
});
