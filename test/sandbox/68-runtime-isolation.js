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
  let plainControl = null;
  before(async () => {
    noStore = !(await redisAnswers());
    fs.rmSync(spaced, {recursive: true, force: true});
    probe = path.join(spaced, 'isolation-probe');
    fs.cpSync(PROBE, probe, {recursive: true});
    // (The _stat PR: a package.json "main" leading outside the root is
    // refused at load under enforce, sandbox 03; here, what Node's own walk
    // does now that it is judged.)
    fs.writeFileSync(path.join(probe, 'lib', 'stat-count.js'), 'module.exports = "counted";\n');
    // (C-bare: a package above the root, one of the module's own, a file of
    // its own a bare subpath could climb back to, and '#' mappings to bare
    // targets that climb)
    fs.mkdirSync(path.join(spaced, 'node_modules', 'sibpkg'), {recursive: true});
    fs.writeFileSync(path.join(spaced, 'node_modules', 'sibpkg', 'package.json'), JSON.stringify({name: 'sibpkg'}));
    fs.writeFileSync(path.join(spaced, 'node_modules', 'sibpkg', 'index.js'), 'module.exports = 1;\n');
    fs.mkdirSync(path.join(probe, 'node_modules', 'dep'), {recursive: true});
    fs.writeFileSync(path.join(probe, 'node_modules', 'dep', 'package.json'), JSON.stringify({name: 'dep'}));
    fs.writeFileSync(path.join(probe, 'node_modules', 'dep', 'index.js'), 'module.exports = "dep";\n');
    // (a package named with a '?', where the platform allows one)
    if (process.platform !== 'win32') {
      fs.mkdirSync(path.join(probe, 'node_modules', 'q?x'), {recursive: true});
      fs.writeFileSync(path.join(probe, 'node_modules', 'q?x', 'package.json'), JSON.stringify({name: 'q?x'}));
      fs.writeFileSync(path.join(probe, 'node_modules', 'q?x', 'index.js'), 'module.exports = 1;\n');
      fs.mkdirSync(path.join(probe, 'node_modules', 't\tx'), {recursive: true});
      fs.writeFileSync(path.join(probe, 'node_modules', 't\tx', 'package.json'), JSON.stringify({name: 't\tx'}));
      fs.writeFileSync(path.join(probe, 'node_modules', 't\tx', 'index.js'), 'module.exports = 1;\n');
    }
    // (C-bare R0: an "exports" target climbing out by '%2e' to the file
    // beside the root; a package.json above the root a self-reference from
    // deep in the tree would find were the root's own not there first)
    if (process.platform !== 'win32') {
      fs.mkdirSync(path.join(spaced, 'node_modules', 'co_lon:pkg'), {recursive: true});
      fs.writeFileSync(path.join(spaced, 'node_modules', 'co_lon:pkg', 'package.json'), JSON.stringify({name: 'co_lon:pkg'}));
      fs.writeFileSync(path.join(spaced, 'node_modules', 'co_lon:pkg', 'index.js'), 'module.exports = "above";\n');
      for (const at of [path.join(probe, 'node_modules', 'co_lon:dec'), path.join(probe, 'node_modules', 'node_modules', 'co_lon:dec')]) {
        fs.mkdirSync(at, {recursive: true});
        fs.writeFileSync(path.join(at, 'package.json'), JSON.stringify({name: 'co_lon:dec', exports: {'.': './index.js'}}));
        fs.writeFileSync(path.join(at, 'index.js'), 'module.exports = "dec";\n');
      }
    }
    fs.mkdirSync(path.join(probe, 'node_modules', 'dep6'), {recursive: true});
    fs.writeFileSync(path.join(probe, 'node_modules', 'dep6', 'package.json'), JSON.stringify({name: 'dep6', exports: {'./*': './.%2*/.%2*/.%2*/isolation-probe.js'}}));
    fs.writeFileSync(path.join(spaced, 'package.json'), JSON.stringify({name: 'outer-self', exports: './isolation-probe.js'}));
    fs.mkdirSync(path.join(probe, 'lib', 'deep', 'a', 'b', 'c'), {recursive: true});
    fs.writeFileSync(path.join(probe, 'lib', 'deep', 'a', 'b', 'c', 'self.js'),
      'module.exports = (spec) => { try { return require(spec); } catch (e) { return `${e.code}|${e.message}`; } };\n');
    fs.mkdirSync(path.join(probe, 'node_modules', 'dep5'), {recursive: true});
    fs.writeFileSync(path.join(probe, 'node_modules', 'dep5', 'package.json'), JSON.stringify({name: 'dep5', exports: {'.': './index.js'}}));
    fs.writeFileSync(path.join(probe, 'node_modules', 'dep5', 'index.js'), 'module.exports = 5;\n');
    fs.mkdirSync(path.join(probe, 'node_modules', 'dep4'), {recursive: true});
    fs.writeFileSync(path.join(probe, 'node_modules', 'dep4', 'package.json'), JSON.stringify({name: 'dep4', exports: {'./*': './*'}}));
    fs.writeFileSync(path.join(probe, 'node_modules', 'dep4', 'index.js'), 'module.exports = 4;\n');
    fs.mkdirSync(path.join(probe, 'node_modules', 'dep', 'esm'), {recursive: true});
    fs.writeFileSync(path.join(probe, 'node_modules', 'dep', 'esm', 'package.json'), JSON.stringify({type: 'module'}));
    fs.writeFileSync(path.join(probe, 'node_modules', 'dep', 'esm', 'x.mjs'), 'export default 1;\n');
    fs.writeFileSync(path.join(probe, 'lib', 'bare-target.mjs'), 'export default "own";\n');
    // (a file module in node_modules, as CommonJS finds one)
    fs.writeFileSync(path.join(probe, 'node_modules', 'filedep.js'), 'module.exports = "file";\n');
    const probePkg = JSON.parse(fs.readFileSync(path.join(probe, 'package.json'), 'utf8'));
    probePkg.exports = {'./self-check': './lib/stat-count.js', './link-self': './lib/link-self.js', './link-none': './lib/link-none.js',
      './link-self2': './lib/link-self2.js', './link-none2': './lib/link-none2.js'};
    probePkg.imports = Object.assign({}, probePkg.imports, {'#sibclimb': 'sibpkg/../../isolation-probe/lib/bare-target.mjs',
      '#nosibclimb': 'nosuchsib/../../isolation-probe/lib/bare-target.mjs',
      '#builtin': {node: 'node:crypto', default: './lib/bare-target.mjs'}, '#bare': 'crypto', '#fallback': ['https://x.invalid/a.js', './lib/bare-target.mjs'],
      '#emptyArr': {node: [], default: './lib/bare-target.mjs'}, '#badFirst': ['./lib/../lib/bare-target.mjs', './lib/bare-target.mjs'],
      '#pat/*': './lib/pat/*', '#noext': './lib/bare-target', '#z': {node: ['https://x.invalid/a.js', {browser: './nope.mjs'}], default: './lib/bare-target.mjs'}});
    fs.mkdirSync(path.join(probe, 'lib', 'pat'), {recursive: true});
    fs.writeFileSync(path.join(probe, 'lib', 'pat', 'x.mjs'), 'export default "pat";\n');
    fs.mkdirSync(path.join(probe, 'node_modules', 'dep3'), {recursive: true});
    fs.writeFileSync(path.join(probe, 'node_modules', 'dep3', 'package.json'), JSON.stringify({name: 'dep3', exports: false}));
    fs.writeFileSync(path.join(probe, 'node_modules', 'dep3', 'index.js'), 'module.exports = 3;\n');
    // (a decoy in node_modules/node_modules beside a real dep2)
    fs.mkdirSync(path.join(probe, 'node_modules', 'dep2'), {recursive: true});
    fs.writeFileSync(path.join(probe, 'node_modules', 'dep2', 'package.json'), JSON.stringify({name: 'dep2', exports: {'.': './index.js'}}));
    fs.writeFileSync(path.join(probe, 'node_modules', 'dep2', 'index.js'), 'module.exports = "real";\n');
    fs.mkdirSync(path.join(probe, 'node_modules', 'node_modules', 'dep2'), {recursive: true});
    fs.writeFileSync(path.join(probe, 'node_modules', 'node_modules', 'dep2', 'package.json'), JSON.stringify({name: 'dep2'}));
    fs.writeFileSync(path.join(probe, 'node_modules', 'node_modules', 'dep2', 'index.js'), 'module.exports = "decoy";\n');
    fs.mkdirSync(path.join(probe, 'lib', 'selfscope'), {recursive: true});
    fs.writeFileSync(path.join(probe, 'lib', 'selfscope', 'package.json'), JSON.stringify({name: 'sibpkg', exports: null}));
    fs.writeFileSync(path.join(probe, 'lib', 'selfscope', 'try.js'),
      'module.exports = async (spec) => { try { await import(spec); return "found"; } catch (e) { return String(e.code); } };\n');
    fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify(probePkg));
    // (a directory required once, for the warning Node gives for a "main"
    // that names nothing)
    fs.mkdirSync(path.join(probe, 'lib', 'main-warn'));
    fs.writeFileSync(path.join(probe, 'lib', 'main-warn', 'package.json'), JSON.stringify({main: './no-such-main.js'}));
    fs.writeFileSync(path.join(probe, 'lib', 'main-warn', 'index.js'), 'module.exports = "warned";\n');
    // (the root itself: an index.js of its own, and a file beside the root,
    // outside it, that Node would try first with an extension)
    fs.writeFileSync(path.join(probe, 'index.js'), 'module.exports = "root";\n');
    fs.writeFileSync(path.join(spaced, 'isolation-probe.js'), 'module.exports = "beside";\n');
    // (and one that loads: a package.json whose only outside "main" is
    // nested, not the package's; one JSON.parse can't read, a UTF-8 BOM's
    // say, never loads: the module's tree check refuses it)
    fs.mkdirSync(path.join(probe, 'lib', 'main-in-nested'));
    const nestedOut = path.relative(path.join(probe, 'lib', 'main-in-nested'), path.join(ROOT, 'lib')).split(path.sep).join('/');
    fs.writeFileSync(path.join(probe, 'lib', 'main-in-nested', 'package.json'), JSON.stringify({main: './index.js', config: {main: nestedOut}}));
    fs.writeFileSync(path.join(probe, 'lib', 'main-in-nested', 'index.js'), 'module.exports = "nested";\n');
    {
      const {createRequire} = require('module');
      const pj = path.join(probe, 'package.json');
      const climb = createRequire(path.join(probe, 'index.js')).resolve('dep6/e');
      fs.renameSync(pj, `${pj}.away`);
      let above;
      // (in a child of its own: Node keeps the package.json it read once)
      try {
        const r = require('child_process').spawnSync(process.execPath, ['-e', 'try { process.stdout.write(require("module").createRequire(process.argv[1]).resolve("outer-self")); } catch (e) { process.stdout.write(String(e.code)); }',
          path.join(probe, 'lib', 'deep', 'a', 'b', 'c', 'self.js')], {encoding: 'utf8'});
        above = r.stdout;
      } finally { fs.renameSync(`${pj}.away`, pj); }
      plainControl = [climb, above];
    }
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
      // (C-bare, Fable's pass on #452, F1 and F2)
      it('a bare name\'s subpath, or a \'#\' mapping to one, never walks above the root: a sibling there and a missing one, one answer; nothing of module code\'s runs in Node\'s step; its own dependency loads', async () => {
        const r = await mcpCall(testPort(9759), KEY, TOOL, {step: 'bareSubpath'});
        assert.strictEqual(detail(r), 'same same same same same same same same same same same same same same same same same same same same same same same same', JSON.stringify(r).slice(0, 1500));
      });
      // (C-bare R0, with the reviewer's pins)
      it('a bare require is CommonJS\'s own judged lookup: an "exports" target climbing out by \'%2e\' reads as a missing name, a self-reference from deep finds the root\'s package.json and nothing above', async () => {
        // (plain Node, the control, taken before any server: the climb finds
        // the file beside the root; with the root's package.json away, the
        // deep self-reference finds the one above it)
        assert.deepStrictEqual(plainControl, [path.join(spaced, 'isolation-probe.js'), path.join(spaced, 'isolation-probe.js')]);
        const r = await mcpCall(testPort(9759), KEY, TOOL, {step: 'cjsJudged'});
        assert.strictEqual(detail(r), 'same same same same same same same same same same same same same same same same same', JSON.stringify(r).slice(0, 1500));
      });
      // (each layer past the judged _stat, alone: removing any one fails
      // this; POSIX, where a test makes a link without privileges)
      (process.platform === 'win32' ? it.skip : it)('a link inside the root to a file outside, made after the load: _findPath\'s answer check, the direct call\'s, and the require hook\'s bound() each answer a missing name', async () => {
        const beside = path.join(spaced, 'isolation-probe.js');
        const links = [path.join(probe, 'node_modules', 'linkpkg', 'index.js'), path.join(probe, 'lib', 'link-self.js'), path.join(probe, 'lib', 'link-self2.js')];
        try {
          fs.mkdirSync(path.join(probe, 'node_modules', 'linkpkg'), {recursive: true});
          for (const l of links) fs.symlinkSync(beside, l);
          const r = await mcpCall(testPort(9759), KEY, TOOL, {step: 'linkLayers'});
          assert.strictEqual(detail(r), 'same same same', JSON.stringify(r).slice(0, 1500));
        } finally {
          for (const l of links) fs.rmSync(l, {force: true});
          fs.rmSync(path.join(probe, 'node_modules', 'linkpkg'), {recursive: true, force: true});
        }
      });
      it('whether a runtime package is installed is no answer, by the whole error: a forged parent inside it, findPackageJSON\'s base and climbing specifier, _findPath\'s array-like paths, a primitive parent', async () => {
        const r = await mcpCall(testPort(9759), KEY, TOOL, {step: 'parentPackage'});
        assert.strictEqual(detail(r), 'same same same same same same same same same same same same same same same same', JSON.stringify(r).slice(0, 1500));
      });
    }
    if (mode === 'audit') {
      // (the red side of the enforce test above: the same step, nothing
      // refused, finds the file the '%2e' climb names, beside the root --
      // so that test tells the escape from its absence)
      it('audit: the same "exports" climb by \'%2e\' finds the file beside the root', async () => {
        const r = await mcpCall(testPort(9759), KEY, TOOL, {step: 'cjsJudged'});
        assert.ok(/^requireClimb\(found \/ /.test(detail(r)), JSON.stringify(r).slice(0, 1500));
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
