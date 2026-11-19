// sandbox 68 (#194's PR 2): what module code can see of the runtime after its
// worker's lockdown, under audit and enforce alike.
// - A: require.cache (one object: module.constructor._cache is it) holds the
//   module's own files only; the runtime's entries were moved out at the
//   lockdown, so util.inspect, which reads past any view, names none, and no
//   runtime Module reaches an inspect.custom (Revision 6, blocking 1).
// - C: no main module (require.main, process.mainModule).
// - S: every loader static stays as the lockdown left it, and Node's path
//   cache keeps nothing outside the module's root that is planted in it.
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

const KEY = 'aabbcc';
const PROBE = path.join(ROOT, 'test', 'fixtures', 'isolation-probe');
const PEER = path.join(ROOT, 'test', 'fixtures', 'isolation-peer');
const TOOL = 'isolation_probe_probeservice_inspect';
const detail = (r) => (r != null && r.structuredContent != null ? r.structuredContent.detail : JSON.stringify(r).slice(0, 300));
const EXPECTED = {
  cacheFiles: 'module files only',
  sameCache: 'same',
  inspect: 'none named, no runtime Module',
  main: 'no require.main, no mainModule',
  parentSlot: 'handle, no runtime parent',
  statics: 'none replaced',
  // (its store part skipped, saying so, only when the test found no Redis)
  window: 'no loader, nothing compiled',
  pathCache: 'empty'
};

const waitFor = async (server, re) => {
  const deadline = Date.now() + 5000;
  while (!re.test(server.output) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  return re.test(server.output);
};

describe('sandbox 68: the runtime isolated from module code after the lockdown', function() {
  this.timeout(120000);
  let home;
  let policy;
  // (the probe loaded from a copy whose root holds a space, so a message
  // quoting it percent-encoded is checked too; under the repo's
  // node_modules, so a bare name still walks the same node_modules above
  // it; the review of #440's second round)
  const spaced = path.join(ROOT, 'node_modules', '.ch-sb-68 probe');
  let probe;
  before(async () => {
    noStore = !(await redisAnswers());
    fs.rmSync(spaced, {recursive: true, force: true});
    probe = path.join(spaced, 'isolation-probe');
    fs.cpSync(PROBE, probe, {recursive: true});
    // (a fresh own file, for the count of Node's calls into identity's
    // Module._stat wrapper; the _stat PR)
    fs.writeFileSync(path.join(probe, 'lib', 'stat-count.js'), 'module.exports = "counted";\n');
    // (two directories of the module's own whose package.json "main" leads
    // outside its root: to a runtime file, and to a missing one beside it;
    // the review of the third round on #440)
    // (c and d with an index.js of their own, which Node falls back to when
    // "main" names nothing)
    for (const [dir, target, index] of [['main-out-a', 'node-version.js', false], ['main-out-b', 'no-such-isolation.js', false],
      ['main-out-c', 'node-version.js', true], ['main-out-d', 'no-such-isolation.js', true]]) {
      fs.mkdirSync(path.join(probe, 'lib', dir));
      const main = path.relative(path.join(probe, 'lib', dir), path.join(ROOT, 'lib', target)).split(path.sep).join('/');
      fs.writeFileSync(path.join(probe, 'lib', dir, 'package.json'), JSON.stringify({main}));
      if (index) fs.writeFileSync(path.join(probe, 'lib', dir, 'index.js'), 'module.exports = 1;\n');
    }
    // (e and f: the outside "main" written first and a number after it,
    // which JSON.parse keeps and Node's own reader may not; g: a directory
    // with an outside "main" beside a file of its name: refused too, the
    // conservative rule)
    for (const [dir, target] of [['main-out-e', 'node-version.js'], ['main-out-f', 'no-such-isolation.js'], ['main-out-g', 'node-version.js']]) {
      fs.mkdirSync(path.join(probe, 'lib', dir));
      const main = path.relative(path.join(probe, 'lib', dir), path.join(ROOT, 'lib', target)).split(path.sep).join('/');
      fs.writeFileSync(path.join(probe, 'lib', dir, 'package.json'), `{"main": ${JSON.stringify(main)}, "main": 1}`);
      fs.writeFileSync(path.join(probe, 'lib', dir, 'index.js'), 'module.exports = 1;\n');
    }
    fs.writeFileSync(path.join(probe, 'lib', 'main-out-g.js'), 'module.exports = "sibling";\n');
    // (the root itself: an index.js of its own, and a file beside the root,
    // outside it, that Node would try first with an extension; and a
    // directory whose "main" is the root)
    fs.writeFileSync(path.join(probe, 'index.js'), 'module.exports = "root";\n');
    fs.writeFileSync(path.join(spaced, 'isolation-probe.js'), 'module.exports = "beside";\n');
    fs.mkdirSync(path.join(probe, 'lib', 'main-root'));
    fs.writeFileSync(path.join(probe, 'lib', 'main-root', 'package.json'), JSON.stringify({main: '../..'}));
    fs.writeFileSync(path.join(probe, 'lib', 'main-root', 'index.js'), 'module.exports = 1;\n');
    // (and one that loads: a package.json whose only outside "main" is
    // nested, not the package's; one JSON.parse can't read, a UTF-8 BOM's
    // say, never loads: the module's tree check refuses it)
    fs.mkdirSync(path.join(probe, 'lib', 'main-in-nested'));
    const nestedOut = path.relative(path.join(probe, 'lib', 'main-in-nested'), path.join(ROOT, 'lib')).split(path.sep).join('/');
    fs.writeFileSync(path.join(probe, 'lib', 'main-in-nested', 'package.json'), JSON.stringify({main: './index.js', config: {main: nestedOut}}));
    fs.writeFileSync(path.join(probe, 'lib', 'main-in-nested', 'index.js'), 'module.exports = "nested";\n');
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sb-68-'));
    policy = path.join(home, 'policy.json');
    fs.writeFileSync(policy, JSON.stringify({modules: {'isolation-probe': {approve: 'as-declared'}}}));
  });
  after(() => {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(spaced, {recursive: true, force: true});
  });
  ['enforce', 'audit'].forEach((mode) => describe(mode, () => {
    let server = null;
    before(async () => {
      // (the test's probe on, --testLateLoads, for its hand-over of a runtime
      // Module: module code reaches none, A)
      // (its declared net approved: postman-request and sshpk warmed, for
      // the bcrypt-pbkdf case)
      server = await startServer(testPort(9759), ['--testLateLoads', '--modulePolicy', policy, '--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', mode, '--loadModule', probe, '--loadModule', PEER]);
    });
    after(() => { stopServer(server); server = null; });
    for (const [step, expected] of Object.entries(EXPECTED)) {
      it(`${step}: ${expected}`, async () => {
        const r = await mcpCall(testPort(9759), KEY, TOOL, {step, noStore});
        assert.strictEqual(detail(r), step === 'window' && noStore ? `${expected} (store part skipped: no store)` : expected, JSON.stringify(r).slice(0, 500));
      });
    }
    // P alone and the net: a load with a runtime Module as its parent, by
    // _load, its require, and new Module().load; and one with no parent:
    // refused under enforce, with the net's line in both modes
    for (const step of ['netLoad', 'netRequire', 'noParent']) {
      it(`${step}: ${mode === 'enforce' ? 'refused' : 'allowed'}, and said`, async () => {
        const r = await mcpCall(testPort(9759), KEY, TOOL, {step});
        if (mode === 'enforce') assert.match(detail(r), /^(MODULE_NOT_FOUND|ERR_ACCESS_DENIED)$/, JSON.stringify(r).slice(0, 500));
        else assert.strictEqual(detail(r), 'loaded', JSON.stringify(r).slice(0, 500));
        const line = step === 'noParent' ? /violation require [^\n]*node-version\.js/ : /violation require \.\/node-version\.js \(a load by the runtime after the lockdown\)/;
        assert.ok(await waitFor(server, line), server.output.slice(-1500));
      });
    }
    it(`netModuleLoad: a runtime file loaded by a Module of its own is ${mode === 'enforce' ? 'refused' : 'read, and reported'}`, async () => {
      const r = await mcpCall(testPort(9759), KEY, TOOL, {step: 'netModuleLoad'});
      // (the refusal's own answer, the broker's for a file outside the
      // module's grants: that it is missing, though it is there; 'no handle'
      // or another failure is no refusal)
      assert.ok(fs.existsSync(path.join(ROOT, 'lib', 'node-version.js')));
      if (mode === 'enforce') assert.strictEqual(detail(r), 'ENOENT', JSON.stringify(r).slice(0, 500));
      else assert.strictEqual(detail(r), 'loaded', JSON.stringify(r).slice(0, 500));
    });
    // (item 7: under enforce each fails as the missing file does; under audit
    // each is reported, as every out-of-root resolution is)
    it(`resolving the runtime's files from a runtime-shaped parent ${mode === 'enforce' ? 'fails as a missing file does' : 'is reported'}`, async () => {
      const from = server.output.length;
      const r = await mcpCall(testPort(9759), KEY, TOOL, {step: 'resolveOracle'});
      const codes = detail(r).split(' ');
      assert.strictEqual(codes[0], 'MODULE_NOT_FOUND', JSON.stringify(r).slice(0, 500));
      if (mode === 'enforce') assert.deepStrictEqual(codes, [...Array(5).fill('MODULE_NOT_FOUND'), 'stat:missing'], JSON.stringify(r).slice(0, 500));
      // (said by this step, not an earlier one: its createRequire resolve,
      // through the resolve hook; the loader's helpers called directly answer
      // truthfully under audit, unreported, as every lookup does there)
      else assert.ok(await waitFor({get output() { return server.output.slice(from); }}, /violation require json-stringify-safe/), server.output.slice(-1500));
    });
    if (mode === 'enforce') {
      // (F4, #194's PR 3)
      it('import() from an ES module: a runtime file or a runtime-only package against a missing one, the same whole error', async () => {
        const r = await mcpCall(testPort(9759), KEY, TOOL, {step: 'importOracle'});
        assert.strictEqual(detail(r), 'same same same same same same same same same same same same same same same same same same same same same', JSON.stringify(r).slice(0, 1500));
      });
      it('whether a runtime package is installed is no answer, by the whole error: a forged parent inside it, findPackageJSON\'s base and climbing specifier, _findPath\'s array-like paths, a primitive parent', async () => {
        const r = await mcpCall(testPort(9759), KEY, TOOL, {step: 'parentPackage'});
        assert.strictEqual(detail(r), 'same same same same same same same same same same same same same same same same', JSON.stringify(r).slice(0, 1500));
      });
    }
    it(`a require made for a runtime file by createRequire is module code's: ${mode === 'enforce' ? 'the reduced module' : 'its watched built-in reported'}`, async () => {
      const r = await mcpCall(testPort(9759), KEY, TOOL, {step: 'runtimeParentBuiltins'});
      if (mode === 'enforce') assert.strictEqual(detail(r), 'reduced module', JSON.stringify(r).slice(0, 500));
      else {
        assert.strictEqual(detail(r), 'real module', JSON.stringify(r).slice(0, 500));
        assert.ok(await waitFor(server, /isolation-probe uses dgram/), server.output.slice(-1500));
      }
    });
    // (#434's Fable pass F9: Web Locks list other workers' locks; only on a
    // Node that has them)
    it(`navigator.locks: ${mode === 'enforce' ? 'gone' : 'there, its read reported'}`, async function() {
      if (globalThis.navigator == null || globalThis.navigator.locks == null) this.skip();
      const r = await mcpCall(testPort(9759), KEY, TOOL, {step: 'locks'});
      assert.strictEqual(detail(r), mode === 'enforce' ? 'no locks' : 'locks', JSON.stringify(r).slice(0, 500));
      if (mode === 'audit') assert.ok(await waitFor(server, /isolation-probe uses navigator\.locks/), server.output.slice(-1500));
    });
    // (the reviewer's ruling on #434: the net's one exception is sshpk's own)
    it('bcrypt-pbkdf asked for by module code, or with a forged sshpk-shaped parent: its own copy or a refusal, never what sshpk is answered (which is frozen)', async () => {
      const r = await mcpCall(testPort(9759), KEY, TOOL, {step: 'lazyHitOthers'});
      assert.match(detail(r), /^(own|refused) (own|refused) frozen$/, JSON.stringify(r).slice(0, 500));
      if (mode === 'enforce') assert.strictEqual(detail(r), 'refused refused frozen', JSON.stringify(r).slice(0, 500));
    });
    it('interop: the module\'s own files by import(), require(esm), createRequire and require.resolve', async () => {
      const r = await mcpCall(testPort(9759), KEY, TOOL, {step: 'interop'});
      assert.strictEqual(detail(r), 'cjs esm json resolved function function function sibling esm cjs', JSON.stringify(r).slice(0, 500));
    });
    it(`BroadcastChannel: ${mode === 'enforce' ? 'gone by either route' : 'a message crosses to another module\'s worker, and is reported'}`, async () => {
      const listening = mcpCall(testPort(9759), KEY, 'isolation_peer_peerservice_listen', {});
      await new Promise((res) => setTimeout(res, 300));
      const r = await mcpCall(testPort(9759), KEY, TOOL, {step: 'broadcast'});
      const heard = await listening;
      if (mode === 'enforce') {
        assert.match(detail(r), /^undefined (MODULE_NOT_FOUND|ERR_ACCESS_DENIED) none$/, JSON.stringify(r).slice(0, 500));
        assert.strictEqual(detail(heard), 'no BroadcastChannel');
      } else {
        // (worker_threads, refused under enforce, is allowed and reported under audit)
        assert.match(detail(r), /^function (function|undefined) one$/, JSON.stringify(r).slice(0, 500));
        assert.strictEqual(detail(heard), 'received hello');
        assert.ok(await waitFor(server, /isolation-probe uses BroadcastChannel/), server.output.slice(-1500));
      }
    });
  }));
});
