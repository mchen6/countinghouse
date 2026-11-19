// sandbox 66 (#194's PR 1): after a worker's lockdown the runtime loads
// nothing of its own. Every file it needs is loaded at boot, so no
// require of countinghouse's (a lazy library, a logger, a re-require) is
// made where module code could stand between it and Node's loader: a
// planted require.cache entry, a poisoned relative-resolve key, a replaced
// handler all find no runtime load to take. Recorded by a test-only probe
// the main thread turns on (--testLateLoads, lib/lean-worker.js): every
// _load and _resolveFilename with a runtime parent, and every createRequire
// and getBuiltinModule with a runtime caller, after the lockdown. Each step
// asserts what it reached, so a step that never reaches its path fails; and
// a positive control, last, must be recorded, in a module's worker and in a
// validation worker.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {testPort, redisAnswers} = require('../helpers/test-env');

// (whether the servers this test starts have a Redis that answers: the
// Windows subset's runner has none, so a step that needs one is skipped
// there, saying so)
let noStore = false;
const {startStdio, withoutRedisNoise, INITIALIZE} = require('../helpers/stdio-client');

const KEY = 'aabbcc';
const PROBE = path.join(ROOT, 'test', 'fixtures', 'late-load-probe');
const CONTROL = path.join(ROOT, 'test', 'fixtures', 'late-load-control');
const TOOL = 'late_load_probe_probeservice_exercise';
const detail = (r) => (r != null && r.structuredContent != null ? r.structuredContent.detail : undefined);
// [step, what it must have reached (detail), or a check of the whole answer]
const STEPS = [
  // the declared host, approved by the policy: past the sandbox, into
  // postman-request (a .invalid name ends in its own error)
  ['request', (d) => /^error: /.test(d)],
  // (skipped only when the test found no Redis to start the server with;
  // with one, a command that never answers fails it)
  ['redis', (d) => (noStore ? d === 'skipped: no store' : /^called: /.test(d))],
  ['hostIp', (d) => d === 'string'],
  ['loadFile', (d) => d === 'loaded'],
  // a lib/ file and a node_modules file of countinghouse's: refused
  ['loadRuntime', (d) => /^(MODULE_NOT_FOUND|ERR_ACCESS_DENIED) (MODULE_NOT_FOUND|ERR_ACCESS_DENIED)$/.test(d)],
  ['readLines', (d) => d === 'read'],
  ['libName', (d) => d === 'MODULE_NOT_FOUND'],
  ['ownLoaders', (d) => /^createRequire/.test(d)],
  ['log', (d, r, output) => d === 'logged' && /CHUtil\.recordUsage \(app-layer bookkeeping/.test(output)],
  ['progress', (d) => d === 'reported'],
  ['usage', (d) => d === 'read' || d === 'none'],
  ['ask', (d) => typeof(d) === 'string' && d !== 'undefined'],
  ['call', (d) => typeof(d) === 'string' && d !== 'undefined'],
  ['tooLarge', (d, r) => r.isError === true && /OUTPUT_TOO_LARGE/.test(JSON.stringify(r))],
  // module code can't replace path's functions (the lockdown fixes path,
  // path.posix and path.win32 in both modes), and a module specifier that
  // walks out of the root stays refused (identity takes path at load too:
  // the in-process case below)
  ['pathSwap', (d) => d === 'not replaced: MODULE_NOT_FOUND'],
  // the one listed lazy require, answered by the net with nothing loaded
  ['lazyHit', (d) => d === 'served'],
  ['error', (d, r) => r.isError === true]
];
const settle = () => new Promise((res) => setTimeout(res, 200));
const waitFor = async (server, re) => {
  const deadline = Date.now() + 5000;
  while (!re.test(server.output) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  return re.test(server.output);
};

describe('sandbox 66: no runtime load after the lockdown', function() {
  this.timeout(120000);
  let home;
  let policy;
  before(async () => {
    noStore = !(await redisAnswers());
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sb-66-'));
    // the operator approves the probe's declared net: under enforce
    // postman-request is then warmed, and a request reaches it
    policy = path.join(home, 'policy.json');
    fs.writeFileSync(policy, JSON.stringify({modules: {'late-load-probe': {approve: 'as-declared'}}}));
  });
  after(() => {
    fs.rmSync(home, {recursive: true, force: true});
  });
  // (each start with the test's probe, --testLateLoads, but the normal one)
  const args = (mode, extra = []) => ['--testLateLoads', '--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', mode,
    '--modulePolicy', policy, '--maxOutputBytes', '262144', ...extra, '--loadModule', PROBE];

  ['enforce', 'audit'].forEach((mode, i) => describe(mode, () => {
    let server = null;
    const port = testPort(9775 + i);
    before(async () => {
      server = await startServer(port, args(mode));
    });
    after(() => { stopServer(server); });
    const late = () => server.output.split('\n').filter((l) => l.includes('late runtime '));

    // a module validated in a worker of its own, after that worker's lockdown
    it('validate-module: nothing of the runtime\'s is loaded or resolved', async () => {
      const r = await mcpCall(port, KEY, 'countinghouse_validate_module', {path: PROBE});
      assert.ok(r.structuredContent != null, JSON.stringify(r).slice(0, 500));
      await settle();
      assert.deepStrictEqual(late(), [], late().join('\n'));
    });
    for (const [step, reached] of STEPS) {
      it(`${step}: reaches its path, and nothing of the runtime's is loaded or resolved`, async () => {
        const r = await mcpCall(port, KEY, TOOL, {step});
        await settle();
        assert.ok(reached(detail(r), r, server.output, mode), `${step}: ${JSON.stringify(r).slice(0, 800)}`);
        assert.deepStrictEqual(late(), [], late().join('\n'));
      });
    }
    // last: the probe's positive controls, so the steps above can't pass
    // with a probe that never installed or never locked: in a validation
    // worker (a module whose top level loads with a runtime parent), then in
    // this module's worker, each of the four hooks
    it('the probe records a runtime-parented load in a validation worker (its control)', async () => {
      const validated = await mcpCall(port, KEY, 'countinghouse_validate_module', {path: CONTROL});
      // the validation worker is locked down: child_process refused under
      // enforce, allowed (and reported) under audit, said in the answer
      const said = JSON.stringify(validated);
      assert.match(said, mode === 'enforce' ? /late-load-control: child_process (MODULE_NOT_FOUND|ERR_ACCESS_DENIED)/ : /late-load-control: child_process allowed/, said.slice(0, 1500));
      assert.ok(await waitFor(server, /late runtime load: path from .*[\\/]lib[\\/]logger\.js/), server.output.slice(-2000));
      // its request at load: nothing of postman-request loaded late (the
      // refusal itself, answered on the next tick, can outlive the worker,
      // which is discarded once it has answered: proved in a worker of its
      // own below)
      assert.ok(!/late runtime \w+: [^\n]*postman-request/.test(server.output), server.output.slice(-2000));
    });
    it('the probe records each hook with a runtime parent or caller in the module\'s worker (its control)', async () => {
      const before = late().length;
      const r = await mcpCall(port, KEY, TOOL, {step: 'control'});
      assert.strictEqual(detail(r), 'ran', JSON.stringify(r).slice(0, 800));
      await settle();
      const lines = late().slice(before).join('\n');
      assert.match(lines, /late runtime load: path from .*[\\/]lib[\\/]logger\.js/);
      assert.match(lines, /late runtime resolve: path from .*[\\/]lib[\\/]logger\.js/);
      assert.match(lines, /late runtime createRequire: undefined from .*[\\/]lib[\\/]lazy-require\.js/);
      if (typeof(process.getBuiltinModule) === 'function') assert.match(lines, /late runtime getBuiltinModule: undefined from .*[\\/]lib[\\/]lazy-require\.js/);
    });
  }));

  // a worker that only validates sends no request (noRequests), in either
  // mode: refused with the sandbox's error, reported, and the library's
  // request never reached (#425's final review)
  ['enforce', 'audit'].forEach((mode) => it(`${mode}: a validation worker's CHUtil.request is refused`, () => {
    const {inWorker, install} = require('../helpers/lockdown-worker');
    const out = inWorker(`
      let reached = false;
      global.CHUtil = {request: (uri, options, callback) => { reached = true; (typeof(options) === 'function' ? options : callback)(null); }};
      ${install({mode, noRequests: true, net: [{host: 'late-load.example.invalid'}]})}
      const err = await new Promise((resolve) => CHUtil.request('http://late-load.example.invalid/', (e) => resolve(e)));
      return {code: err != null ? err.code : null, reached, reports};
    `);
    assert.deepStrictEqual([out.code, out.reached], ['ERR_ACCESS_DENIED', false], JSON.stringify(out));
    assert.ok(out.reports.includes('net a request while validating'), JSON.stringify(out.reports));
  }));

  // the runtime's loads of module files (the dispatcher's, CHUtil.loadFile's)
  // have the module's own anchor as parent, and the fixture's files carry the
  // CLI idiom (`if (!module.parent) throw`), so they load at all only with
  // one. And CHUtil.request's options as handed on, with no net approved
  // (this start has no policy): every request that gets past its options is
  // refused for its host under enforce, and reported under audit.
  ['enforce', 'audit'].forEach((mode, i) => it(`${mode}: CHUtil.request's options as handed on; a module file's parent is the module's anchor`, async () => {
    const port = testPort(9775 + i);
    const server = await startServer(port, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', mode, '--loadModule', PROBE]);
    try {
      const r = await mcpCall(port, KEY, TOOL, {step: 'httpSignature'});
      assert.strictEqual(r.isError, false, JSON.stringify(r).slice(0, 800));
      const outcomes = JSON.parse(r.structuredContent.outcomes);
      if (mode === 'audit') {
        // nothing refused; an inherited proxy, and a second argument's
        // request, reported as sent
        for (const form of ['signed', 'inheritedProxy', 'secondArgument', 'callbackOption']) assert.ok(!/^refused/.test(outcomes[form]), `${form}: ${outcomes[form]}`);
        assert.ok(await waitFor(server, /late-load-probe violation net proxy/), server.output.slice(-2000));
        assert.ok(await waitFor(server, /late-load-probe violation net elsewhere\.example\.invalid:80/), server.output.slice(-2000));
      } else {
        // the options pass (only own keys are handed on, a second argument's
        // with the first), and each is refused for its host
        assert.deepStrictEqual(outcomes, {signed: 'refused: late-load.example.invalid:80', inheritedProxy: 'refused: late-load.example.invalid:80',
          secondArgument: 'refused: elsewhere.example.invalid:80', callbackOption: 'refused: elsewhere.example.invalid:80'});
      }
      const p = await mcpCall(port, KEY, TOOL, {step: 'parents'});
      assert.ok(p.structuredContent != null, JSON.stringify(p).slice(0, 800));
      // the module's own anchor, inside its root (/app, as module code sees
      // it; on Windows <V>:\app, #195)
      const anchor = process.platform === 'win32' ? /^[A-Z]:\\app\\\.countinghouse-entry$/ : /^\/app\/\.countinghouse-entry$/;
      assert.ok([p.structuredContent.handlerParent, p.structuredContent.loadedParent].every((f) => anchor.test(f)),
        JSON.stringify([p.structuredContent.handlerParent, p.structuredContent.loadedParent]));
      assert.strictEqual(p.structuredContent.handlerParent, p.structuredContent.loadedParent);
    } finally {
      stopServer(server);
    }
  }));

  // a live setting reaches a running worker ('live-options'): a tightening
  // through the settings tool, which needs no form. The tool is served only
  // in the single-identity profile (stdio, the local store, a settings
  // file), which lists only a pack's scenario tools, so the probe's worker
  // is only loaded here: it takes the broadcast, with nothing loaded late.
  it('live options: a worker takes a tightened setting with nothing loaded late', async () => {
    const file = path.join(home, 'settings.json');
    const io = startStdio(['--testLateLoads', '--workerThread', '--moduleSandbox', 'enforce', '--modulePolicy', policy, '--store', 'local',
      '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data'),
      '--settingsFile', file, '--loadModule', PROBE]);
    try {
      await io.request({...INITIALIZE, id: 1}, 30000);
      io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
      const deadline = Date.now() + 30000;
      while (!/late-load-probe/.test(io.err) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100));
      const set = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'countinghouse_settings',
        arguments: {action: 'set', name: 'maxOutputBytes', value: '8MiB'}}}, 30000);
      assert.deepStrictEqual(set.result && set.result.structuredContent, {name: 'maxOutputBytes', old: 16 * 1024 * 1024, new: 8 * 1024 * 1024, applies: 'now'},
        `${JSON.stringify(set).slice(0, 800)}; ${withoutRedisNoise(io.err)}`);
      await new Promise((res) => setTimeout(res, 500));
      const late = io.err.split('\n').filter((l) => l.includes('late runtime '));
      assert.deepStrictEqual(late, [], late.join('\n'));
    } finally {
      await io.stop();
    }
  });

  // identity's hooks and helpers use path's functions as taken at load
  // (#425's review): join and resolve replaced afterwards move nothing.
  // (Node's own join calls path.posix.normalize through the object, so the
  // capture alone doesn't hold that one: the lockdown fixes path, path.posix
  // and path.win32 before any module code runs, in both modes.)
  it('identity takes path at load: path.posix.join and resolve replaced later move nothing', async () => {
    const {Worker} = require('worker_threads');
    const out = await new Promise((resolve, reject) => {
      const w = new Worker(`
        const {parentPort} = require('worker_threads');
        const identity = require(${JSON.stringify(path.join(ROOT, 'lib', 'fs-broker', 'identity.js'))});
        const posix = require('path').posix;
        posix.join = () => '/elsewhere';
        posix.resolve = () => '/elsewhere';
        parentPort.postMessage({resolved: identity.resolveModulePath('/app/a/../b.js'), joined: identity.pathFor('/app').join('/app', 'c.js'),
          reaches: identity.reachesLib('x/../cli-options')});
      `, {eval: true});
      w.once('message', (m) => { w.terminate(); resolve(m); });
      w.once('error', reject);
    });
    assert.deepStrictEqual(out, {resolved: '/app/b.js', joined: '/app/c.js', reaches: true});
  });

  // a live setting is applied in the worker after its lockdown: module code
  // that replaced an Array iterator, Array.prototype.includes or
  // Number.isInteger since can't stop an operator's tightening (#425's
  // final review)
  it('live options apply on intrinsics taken at load: replaced ones stop no tightening', async () => {
    const {Worker} = require('worker_threads');
    const out = await new Promise((resolve, reject) => {
      const w = new Worker(`
        const {parentPort} = require('worker_threads');
        const {applyLiveOptions} = require(${JSON.stringify(path.join(ROOT, 'lib', 'live-options.js'))});
        Array.prototype[Symbol.iterator] = function* () {};
        Array.prototype.includes = () => false;
        Number.isInteger = () => false;
        const target = {maxOutputBytes: 16777216, requestTimeout: 30000, locale: 'zh-CN'};
        applyLiveOptions(target, {maxOutputBytes: 4096, requestTimeout: 1000, locale: 'en-US'});
        parentPort.postMessage(target);
      `, {eval: true});
      w.once('message', (m) => { w.terminate(); resolve(m); });
      w.once('error', reject);
    });
    assert.deepStrictEqual(out, {maxOutputBytes: 4096, requestTimeout: 1000, locale: 'en-US'});
  });

  // without --testLateLoads the probe is never installed: its control
  // records nothing
  // (and module code has no runtime Module to make one with: the probe's
  // hand-over is the test's alone, #194's PR 2)
  it('a normal start has no probe: its control has no runtime Module, and records nothing', async () => {
    const port = testPort(9775);
    const server = await startServer(port, args('enforce').filter((a) => a !== '--testLateLoads'));
    try {
      const r = await mcpCall(port, KEY, TOOL, {step: 'control'});
      assert.strictEqual(detail(r), 'no runtime Module', JSON.stringify(r).slice(0, 800));
      await settle();
      assert.ok(!server.output.includes('late runtime '), server.output.slice(-2000));
    } finally {
      stopServer(server);
    }
  });
});
