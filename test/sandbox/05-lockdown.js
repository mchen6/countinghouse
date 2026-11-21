// Every route the lockdown controls, under enforce (blocked, logged) and audit
// (allowed, logged once). Plus Review Focus 2: a full composition scenario
// under enforce, so countinghouse's own worker code is proven not to trip the
// built-in block.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const Module = require('module');
const {normaliseRequestOptions, builtinAllowed, ALLOWED_BUILTIN_IDS} = require('../../lib/module-lockdown');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {toolOutput} = require('../helpers/tool-result');

const KEY   = 'aabbcc';
const PROBE = path.join(ROOT, 'test', 'fixtures', 'sandbox-probe');
const TOOL  = 'sandbox_probe_probeservice_attempt';
const OUTSIDE_FILE = path.join(ROOT, 'lib', 'cli-options.js');

const ROUTES = [
  ['dlopen'], ['binding'], ['kill'], ['getBuiltinModule'], ['child_process'], ['worker_threads'],
  ['v8'], ['registerHooks'], ['nodePath'], ['loadFileOutside', OUTSIDE_FILE], ['request', 'http://127.0.0.1:1/'],
  ['loadSkipHooks'], ['loadResolved'], ['loadSource', OUTSIDE_FILE],
  ['_kill'], ['dataImport', OUTSIDE_FILE], ['reducedCreateRequire'], ['requestUri'], ['requestBaseUrl'], ['requestHar'],
  ['sqlite'], ['nodeTest'], ['importSqlite'], ['getBuiltinSqlite'], ['tlsEngine'], ['clientCertEngine'], ['cryptoEngine'],
  ['listenFd'], ['socketFd'], ['socketFdNumber'], ['connectFd'], ['ttyFd'], ['socketCtor'], ['ttyWriteCtor'], ['ttyReadCtor'], ['ttySuper'], ['tlsSuper'], ['dgramFd'], ['report'], ['reportDirectory'], ['compileCache'], ['sourceMaps'],
  ['repl'], ['traceEvents'], ['http2RespondFD']
];

// _stream_wrap (DEP0125) is refused by the lockdown where Node still has it
// (24). Node 26 removed it from its built-ins: there require answers
// MODULE_NOT_FOUND, and Node itself has closed both routes.
const STREAM_WRAP = Module.builtinModules.includes('_stream_wrap');
const STREAM_WRAP_ROUTES = [['streamWrap'], ['streamWrapSuper']];
if (STREAM_WRAP) ROUTES.push(...STREAM_WRAP_ROUTES);

function serverArgs(mode) {
  return ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', mode, '--loadModule', PROBE];
}

// L1: adoption is a descriptor number. A handle object given to net.Socket
// is never a route to a foreign descriptor inside a worker (Node's own
// TLSSocket constructs one that way), so it is not a violation: the bogus
// handle fails on its own, and no descriptor line is logged. The log
// reaches the test asynchronously, so a known violation is made after the
// call and the log is read up to its line (L1 round 5: not after a fixed
// wait, which a slow machine outlasts). Its target is new each time, so the
// once-per-target report always logs it.
async function handleIsNotAdoption(port, server) {
  const from = server.output.length;
  const name = `ch-05-mark-${process.pid}-${Date.now()}`;
  const mark = `/nonexistent/${name}`;
  const r = await mcpCall(port, KEY, TOOL, {what: 'socketHandle'});
  assert.strictEqual(toolOutput(r).outcome, 'allowed', JSON.stringify(r));
  await mcpCall(port, KEY, TOOL, {what: 'loadFileOutside', arg: mark});
  // by its unique name: on Windows the line holds it resolved on the drive, in JSON
  await waitFor(() => server.output.indexOf(name, from) !== -1, 20000, 'the loadFile violation line');
  const since = server.output.slice(from, server.output.indexOf(mark, from));
  assert.ok(!since.includes('violation descriptor'), since.split('\n').filter((l) => l.includes('violation')).join('\n'));
}

// F4-2: nothing logged for a call (a "violation report <what>" line) up to a
// known violation made after it, read up to its line (L1 round 5's pattern)
async function noReportViolation(port, server, from, what) {
  const name = `ch-05-mark-${process.pid}-${Date.now()}`;
  await mcpCall(port, KEY, TOOL, {what: 'loadFileOutside', arg: `/nonexistent/${name}`});
  await waitFor(() => server.output.indexOf(name, from) !== -1, 20000, 'the loadFile violation line');
  const since = server.output.slice(from, server.output.indexOf(name, from));
  assert.ok(!since.includes(`violation report ${what}`), since.split('\n').filter((l) => l.includes('violation')).join('\n'));
}

describe('sandbox 05: worker lockdown', function() {
  this.timeout(120000);

  describe('enforce', () => {
    let server = null;
    before(async () => { server = await startServer(testPort(9608), serverArgs('enforce')); }); // serverArgs passes --workerThread
    after(() => stopServer(server));

    it('a handle object given to net.Socket is not adoption', () => handleIsNotAdoption(testPort(9608), server));

    // F4-2: as under audit (below)
    it('process.report.getReport answers with nothing of the process\'s environment, command line or handles', async () => {
      const r = await mcpCall(testPort(9608), KEY, TOOL, {what: 'getReport'});
      assert.deepStrictEqual(toolOutput(r), {outcome: 'allowed', code: null}, JSON.stringify(r));
    });

    it('detect-libc\'s steps (excludeNetwork set around getReport, then put back) are never refused, and leak nothing', async () => {
      const from = server.output.length;
      const r = await mcpCall(testPort(9608), KEY, TOOL, {what: 'detectLibc'});
      assert.deepStrictEqual(toolOutput(r), {outcome: 'allowed', code: null}, JSON.stringify(r));
      await noReportViolation(testPort(9608), server, from, 'excludeNetwork');
    });

    it('a report setting is a boolean, as Node\'s own: anything else is a TypeError, ERR_INVALID_ARG_TYPE', async () => {
      const r = await mcpCall(testPort(9608), KEY, TOOL, {what: 'reportCompactNotBoolean'});
      assert.deepStrictEqual(toolOutput(r), {outcome: 'allowed', code: null}, JSON.stringify(r));
    });

    ROUTES.forEach(([what, arg]) => {
      it(`blocks ${what} and logs it`, async () => {
        const r = await mcpCall(testPort(9608), KEY, TOOL, arg != null ? {what: what, arg: arg} : {what: what});
        assert.strictEqual(r.isError, false, JSON.stringify(r));
        // (a path outside is invisible under enforce: a resolution headed
        // outside the module's root is the one refusal, found or not, the
        // third round on #440; B1's loadSource compiled its source there
        // before)
        if (what === 'loadSource') assert.deepStrictEqual(toolOutput(r), {outcome: 'blocked', code: 'MODULE_NOT_FOUND'}, JSON.stringify(r));
        else assert.strictEqual(toolOutput(r).outcome, 'blocked', `${what}: ${JSON.stringify(r)}`);
        assert.ok(server.output.includes('module sandbox: sandbox-probe violation'), server.output.slice(-2000));
      });
    });

    if (!STREAM_WRAP) {
      STREAM_WRAP_ROUTES.forEach(([what]) => {
        it(`${what} is not found: this Node has no _stream_wrap`, async () => {
          const r = await mcpCall(testPort(9608), KEY, TOOL, {what: what});
          // (no built-in by that name, so a bare name the module can't
          // resolve: the one refusal under enforce, #440's third round)
          assert.deepStrictEqual(toolOutput(r), {outcome: 'blocked', code: 'MODULE_NOT_FOUND'}, JSON.stringify(r));
        });
      });
    }

    it('a createRequire on the module directory (trailing slash) still resolves inside it', async () => {
      const r = await mcpCall(testPort(9608), KEY, TOOL, {what: 'createRequireDir'});
      assert.deepStrictEqual(toolOutput(r), {outcome: 'allowed', code: null});
    });

    it('process.loadEnvFile reads through the broker', async () => {
      const r = await mcpCall(testPort(9608), KEY, TOOL, {what: 'loadEnvFile'});
      assert.deepStrictEqual(toolOutput(r), {outcome: 'allowed', code: null}, JSON.stringify(r));
    });

    it('http2 respondWithFile is not available', async () => {
      const r = await mcpCall(testPort(9608), KEY, TOOL, {what: 'http2RespondFile'});
      assert.deepStrictEqual(toolOutput(r), {outcome: 'blocked', code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'}, JSON.stringify(r));
    });

    it('uses Node\'s own error codes', async () => {
      const notFound = await mcpCall(testPort(9608), KEY, TOOL, {what: 'child_process'});
      assert.strictEqual(toolOutput(notFound).code, 'MODULE_NOT_FOUND');
      const denied = await mcpCall(testPort(9608), KEY, TOOL, {what: 'kill'});
      assert.strictEqual(toolOutput(denied).code, 'ERR_ACCESS_DENIED');
    });
  });

  // #194's review, B1: Module._load's internal argument skipped the hooks,
  // so a load through it was neither refused nor reported. Each mode on a
  // server of its own, so no earlier route has reported the same target
  // (a report is once per target), and each form's own line is looked for
  // in what was written after its call (#406's high review).
  ['enforce', 'audit'].forEach((mode, i) => describe(`${mode}: Module._load's internal argument`, () => {
    let server = null;
    const port = testPort(9771 + i);
    before(async () => { server = await startServer(port, serverArgs(mode)); });
    after(() => stopServer(server));
    // (this route's own report: the built-in rule, on its target)
    const reportedSince = (from, target) => server.output.slice(from).split('\n')
      .some((l) => l.includes(`module sandbox: sandbox-probe violation builtin ${target}`));
    for (const [what, target] of [['loadSkipHooks', 'child_process'], ['loadResolved', 'worker_threads']]) {
      it(`${what}: runs the hooks, so ${target} is ${mode === 'enforce' ? 'refused' : 'loaded'} and reported`, async () => {
        const from = server.output.length;
        const r = toolOutput(await mcpCall(port, KEY, TOOL, {what}));
        assert.strictEqual(r.outcome, mode === 'enforce' ? 'blocked' : 'allowed', JSON.stringify(r));
        await waitFor(() => reportedSince(from, target), 20000, `${target}'s violation line`);
      });
    }
    it(`a request that is no string, and isMain, ${mode === 'enforce' ? 'are refused' : 'are reported and go on'}, each with its line`, async () => {
      for (const [arg, why] of [['objectRequest', 'a request that is no string'], ['isMain', 'as the main module']]) {
        const from = server.output.length;
        const r = toolOutput(await mcpCall(port, KEY, TOOL, {what: 'forgeParent', arg}));
        assert.strictEqual(r.outcome, mode === 'enforce' ? 'blocked' : 'allowed', `${arg}: ${JSON.stringify(r)}`);
        await waitFor(() => server.output.slice(from).includes(`(${why})`), 20000, `${arg}'s violation line`);
      }
    });
    // (the review of e0f39de9: audit reports what it stops; under enforce
    // the same is refused)
    it(`what the lockdown holds: an assignment, a defineProperty, a new extension take nothing${mode === 'audit' ? ', and each is reported' : ''}`, async () => {
      // [attempt, its line, said under enforce too]
      for (const [what, line, both] of [['holdAssign', 'Module._pathCache replaced (the runtime\'s kept)', false],
        ['holdDefine', '_load redefined (the runtime\'s kept)', false],
        // (a key that is an object, turned into 'load' once, as the engine does)
        ['holdDefineKey', 'Module.prototype.load redefined (the runtime\'s kept)', false],
        ['holdDefineSetter', '_resolveFilename redefined (the runtime\'s kept)', false],
        ['holdHandler', mode === 'audit' ? 'Module._extensions[\'.js\'] replaced (the runtime\'s kept)' : 'Module._extensions[.js] replaced (refused)', true],
        ['holdExtension', 'Module._extensions[.chprobe] added (refused)', true],
        // (PR 3: the locked .node handler, said in both modes; a
        // Reflect.deleteProperty, said under audit)
        ['holdNode', 'Module._extensions[.node] replaced (refused)', true],
        ['holdDeleteReflect', '_resolveFilename removed (the runtime\'s kept)', false]]) {
        const from = server.output.length;
        assert.deepStrictEqual(toolOutput(await mcpCall(port, KEY, TOOL, {what})), {outcome: 'allowed', code: null}, what);
        if (mode === 'audit' || both) await waitFor(() => server.output.slice(from).includes(`violation require ${line}`), 20000, `${what}'s line`);
      }
    });
    // F4-7: a module's code cache is never run in place of its source under
    // enforce (V8 checks a cache against its source's length only); under
    // audit it is reported, and used
    it(`vm code caches: ${mode === 'enforce' ? 'dropped, so the source runs' : 'used, and reported'}, by every route`, async () => {
      const from = server.output.length;
      for (const route of ['script', 'createScript', 'functionOptions', 'runInThisContext', 'subclass', 'protoConstructor', 'compileFunction', 'esm:script', 'esm:createScript']) {
        const r = toolOutput(await mcpCall(port, KEY, TOOL, {what: 'vmCache', arg: route}));
        const ran = route === 'compileFunction' && mode === 'enforce' ? 'NO_CACHE' : (mode === 'enforce' ? 'SOURCE' : 'CACHE');
        assert.deepStrictEqual(r, {outcome: 'allowed', code: ran}, route);
      }
      // (one on Object.prototype is no option of the module's: never taken)
      assert.deepStrictEqual(toolOutput(await mcpCall(port, KEY, TOOL, {what: 'vmCache', arg: 'inherited'})), {outcome: 'allowed', code: 'SOURCE'}, 'inherited');
      await waitFor(() => server.output.slice(from).includes(`violation vm cachedData (${mode === 'enforce' ? 'blocked' : 'allowed, audit'})`), 20000, 'the cachedData line');
    });
    // (PR 3: defineProperties reads its props once; a key a Proxy shows only
    // on a second read is never defined, nor the call made to fail on it)
    it('Object.defineProperties defines what it read once, never a key shown on a second read', async () => {
      assert.deepStrictEqual(toolOutput(await mcpCall(port, KEY, TOOL, {what: 'holdDefineProps'})), {outcome: 'allowed', code: null});
    });
    it('vm: no prototype leads to Node\'s native class; a produce-only script is not marked rejected; inherited options are kept', async () => {
      // (vmFreeze last: it freezes the worker's vm.Script for good)
      const from = server.output.length;
      for (const what of ['vmNative', 'vmProduce', 'vmInherited', 'vmInvalidCache', 'vmShape', 'vmAssign', 'vmFreeze']) {
        assert.deepStrictEqual(toolOutput(await mcpCall(port, KEY, TOOL, {what})), {outcome: 'allowed', code: null}, what);
      }
      // (the assignment is said under audit, as the loader's statics' are)
      if (mode === 'audit') {
        await waitFor(() => server.output.slice(from).includes('violation vm vm.runInThisContext replaced'), 20000, 'the vm assignment line');
        await waitFor(() => server.output.slice(from).includes('violation vm vm.compileFunction redefined'), 20000, 'the vm redefinition line');
        await waitFor(() => server.output.slice(from).includes('violation vm vm.runInNewContext removed'), 20000, 'the vm delete line');
      }
    });
    it('createRequire\'s own Module still loads', async () => {
      assert.deepStrictEqual(toolOutput(await mcpCall(port, KEY, TOOL, {what: 'createRequireOwn'})), {outcome: 'allowed', code: null});
    });
    // (in both modes since #194's PR 2: the loader's statics locked, the
    // extensions table taking no new key, audit's reported accessors aside)
    it('a new extension can\'t be added to the table', async () => {
      const r = toolOutput(await mcpCall(port, KEY, TOOL, {what: 'newExtension'}));
      assert.deepStrictEqual(r, {outcome: 'allowed', code: null});
    });
    it(`each property #406 holds ${mode === 'enforce' ? 'can\'t be replaced' : 'is replaced and reported'}`, async () => {
      const names = {protoLoad: 'Module.prototype.load', jsHandler: 'Module._extensions[\'.js\']', jsonHandler: 'Module._extensions[\'.json\']',
        resolveFilename: '_resolveFilename'};
      for (const arg of Object.keys(names)) {
        const from = server.output.length;
        const r = toolOutput(await mcpCall(port, KEY, TOOL, {what: 'replaceHeld', arg}));
        // (never replaced, in either mode: Node hands each the runtime's own
        // Modules; under audit the attempt is reported, #434's Fable pass F7)
        assert.deepStrictEqual(r, {outcome: 'allowed', code: null}, `${arg} was replaced under ${mode}`);
        if (mode === 'audit') {
          await waitFor(() => server.output.slice(from).includes(`violation require ${names[arg]} replaced`), 20000, `${arg}'s violation line`);
        }
      }
    });
    if (mode === 'audit') {
      it('an assignment of load on one Module is that Module\'s own, never the worker\'s', async () => {
        assert.deepStrictEqual(toolOutput(await mcpCall(port, KEY, TOOL, {what: 'instanceLoad'})), {outcome: 'allowed', code: 'OWN'});
      });
      it('a module that replaces Module._load is reported, and the runtime\'s kept', async () => {
        const from = server.output.length;
        assert.deepStrictEqual(toolOutput(await mcpCall(port, KEY, TOOL, {what: 'replaceLoad'})), {outcome: 'allowed', code: null});
        await waitFor(() => server.output.slice(from).includes('violation require _load replaced'), 20000, 'the replacement\'s violation line');
      });
    }
    it(`loadSource: no source compiled under a countinghouse filename; ${mode === 'enforce' ? 'the path is invisible' : 'the real file, reported'}`, async () => {
      const from = server.output.length;
      const r = toolOutput(await mcpCall(port, KEY, TOOL, {what: 'loadSource', arg: OUTSIDE_FILE}));
      // (under enforce a path outside is invisible: the one refusal, found
      // or not, as for any resolution headed outside the root)
      if (mode === 'enforce') assert.deepStrictEqual(r, {outcome: 'blocked', code: 'MODULE_NOT_FOUND'});
      else {
        assert.deepStrictEqual(r, {outcome: 'allowed', code: null});
        await waitFor(() => server.output.slice(from).split('\n').some((l) => l.includes('module sandbox: sandbox-probe violation require') && l.includes('cli-options')),
          20000, 'the require\'s violation line');
      }
      const cached = toolOutput(await mcpCall(port, KEY, TOOL, {what: 'compiledInCache', arg: OUTSIDE_FILE}));
      assert.deepStrictEqual(cached, {outcome: 'allowed', code: null}, 'the cache holds compiled source under that filename');
    });
  }));

  describe('audit', () => {
    let server = null;
    before(async () => { server = await startServer(testPort(9609), serverArgs('audit')); }); // serverArgs passes --workerThread
    after(() => stopServer(server));

    it('a handle object given to net.Socket is not adoption', () => handleIsNotAdoption(testPort(9609), server));

    // (loadFileOutside is refused under audit too since #425's final review:
    // a path that isn't the module's is never loaded as the runtime's; it is
    // still reported, below)
    const AUDIT_REFUSED = new Set(['loadFileOutside']);
    ROUTES.forEach(([what, arg]) => {
      it(`${AUDIT_REFUSED.has(what) ? 'refuses' : 'allows'} ${what} and logs it`, async () => {
        const r = await mcpCall(testPort(9609), KEY, TOOL, arg != null ? {what: what, arg: arg} : {what: what});
        assert.strictEqual(toolOutput(r).outcome, AUDIT_REFUSED.has(what) ? 'blocked' : 'allowed', `${what}: ${JSON.stringify(r)}`);
      });
    });

    // F4-2: a module's report is read (native-addon loaders read its header), but never holds the process's secrets
    it('process.report.getReport answers with nothing of the process\'s environment, command line or handles', async () => {
      const r = await mcpCall(testPort(9609), KEY, TOOL, {what: 'getReport'});
      assert.deepStrictEqual(toolOutput(r), {outcome: 'allowed', code: null}, JSON.stringify(r));
    });

    it('detect-libc\'s steps leak nothing under audit either, and are not violations', async () => {
      const from = server.output.length;
      const r = await mcpCall(testPort(9609), KEY, TOOL, {what: 'detectLibc'});
      assert.deepStrictEqual(toolOutput(r), {outcome: 'allowed', code: null}, JSON.stringify(r));
      await noReportViolation(testPort(9609), server, from, 'excludeNetwork');
    });

    it('a report written under audit holds no environment, and is in the process\'s compact, not the module\'s', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-05-report-'));
      try {
        for (const compact of [true, false]) {
          const file = path.join(dir, `r-${compact}.json`);
          const r = await mcpCall(testPort(9609), KEY, TOOL, {what: 'writeReportTo', arg: JSON.stringify({file, compact})});
          assert.deepStrictEqual(toolOutput(r), {outcome: 'allowed', code: null}, JSON.stringify(r));
          const text = fs.readFileSync(file, 'utf8');
          const report = JSON.parse(text);
          assert.strictEqual(report.environmentVariables, undefined, `${compact}: the environment was written`);
          assert.ok(text.trim().includes('\n'), `module's compact ${compact}: written in the process's (not compact)`);
        }
      } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    });

    it('process.loadEnvFile reads through the broker', async () => {
      const r = await mcpCall(testPort(9609), KEY, TOOL, {what: 'loadEnvFile'});
      assert.deepStrictEqual(toolOutput(r), {outcome: 'allowed', code: null}, JSON.stringify(r));
    });

    it('the guarded net.Socket still subclasses and recognises Node\'s own sockets', async () => {
      const r = await mcpCall(testPort(9609), KEY, TOOL, {what: 'socketClass'});
      assert.deepStrictEqual(toolOutput(r), {outcome: 'allowed', code: null}, JSON.stringify(r));
    });

    it('http2 respondWithFile is not available', async () => {
      const r = await mcpCall(testPort(9609), KEY, TOOL, {what: 'http2RespondFile'});
      assert.deepStrictEqual(toolOutput(r), {outcome: 'blocked', code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'}, JSON.stringify(r));
    });

    it('logs a repeated violation once', async () => {
      await mcpCall(testPort(9609), KEY, TOOL, {what: 'v8'});
      await mcpCall(testPort(9609), KEY, TOOL, {what: 'v8'});
      const lines = server.output.split('\n').filter((l) => l.includes('module sandbox: sandbox-probe violation builtin v8'));
      assert.strictEqual(lines.length, 1, lines.join('\n'));
    });

    // last of the block: it restarts the probe
    it('a module\'s compact is its own: the process\'s is unchanged, as a restarted worker finds it', async () => {
      const set = await mcpCall(testPort(9609), KEY, TOOL, {what: 'reportCompactSet'});
      assert.deepStrictEqual(toolOutput(set), {outcome: 'allowed', code: null}, JSON.stringify(set));
      const restarted = await post(testPort(9609), KEY, '/restart-module', {name: 'sandbox-probe'});
      assert.strictEqual(restarted.status, 200, `the restart: ${JSON.stringify(restarted)}`);
      // (until the restart answers, the old worker still says its own compact: COMPACT_true)
      let last = null;
      await waitFor(async () => {
        const r = await mcpCall(testPort(9609), KEY, TOOL, {what: 'reportCompactIsFalse'});
        last = toolOutput(r);
        return r.isError === false && last != null && last.outcome === 'allowed' && last.code === null;
      }, 30000, 'the restarted probe to find the process\'s compact false', () => JSON.stringify(last));
    });
  });

  // Review Focus 2.
  describe('composition under enforce', () => {
    let server = null;
    // Same server as test/composition/02-ctx-call.js (no --debug, its own
    // auth config and key), plus --moduleSandbox enforce. Direct peer
    // channels are at their default, on.
    before(async () => {
      server = await startServer(testPort(9610), ['--workerThread', '--moduleSandbox', 'enforce',
        '--authConfigPath', require('../helpers/private-auth').privateAuth(path.join(ROOT, 'test', 'composition', 'fixtures-auth.json')),
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'compose-callee'),
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'compose-caller')]);
    });
    after(() => stopServer(server));

    it('a ctx.call between two modules works, with no violation from countinghouse\'s own code', async () => {
      const r = await mcpCall(testPort(9610), 'composition-test-key', 'compose_caller_callerservice_viacall', {n: 21});
      assert.strictEqual(r.isError, false, JSON.stringify(r));
      assert.strictEqual(toolOutput(r).n, 42, JSON.stringify(r));
      assert.ok(!/violation builtin/.test(server.output), server.output.slice(-3000));
    });
  });

  describe('normaliseRequestOptions (enforce side of CHUtil.request)', () => {
    const NET = [{host: 'allowed.example.test'}];
    const norm = (opts, onRedirect) => normaliseRequestOptions(opts, NET, onRedirect || (() => {}));

    it('turns a string into uri', () => {
      const r = norm('http://allowed.example.test/a');
      assert.strictEqual(r.refusal, null);
      assert.strictEqual(r.options.uri, 'http://allowed.example.test/a');
      assert.strictEqual(typeof(r.options.followRedirect), 'function');
    });
    it('refuses a forbidden host, in a string too', () => {
      assert.strictEqual(norm('http://127.0.0.1:1/').refusal, '127.0.0.1:1');
      assert.strictEqual(norm({uri: 'http://127.0.0.1:1/'}).refusal, '127.0.0.1:1');
    });
    it('refuses har, baseUrl and proxy', () => {
      ['har', 'baseUrl', 'proxy'].forEach((key) => {
        const r = norm({url: 'http://allowed.example.test/', [key]: 'http://x.test/'});
        assert.strictEqual(r.refusal, key);
      });
    });
    it('prefers uri to url, and moves url into uri', () => {
      assert.strictEqual(norm({url: 'http://allowed.example.test/', uri: 'http://127.0.0.1:1/'}).refusal, '127.0.0.1:1');
      const r = norm({url: 'http://allowed.example.test/x', timeout: 5});
      assert.strictEqual(r.options.uri, 'http://allowed.example.test/x');
      assert.ok(!('url' in r.options));
      assert.strictEqual(r.options.timeout, 5);
    });
    it('uses the href of a URL object, and refuses a non-string target', () => {
      const r = norm({uri: new URL('http://allowed.example.test/u')});
      assert.strictEqual(r.options.uri, 'http://allowed.example.test/u');
      assert.strictEqual(norm({uri: {href: 7}}).refusal, 'invalid');
      assert.strictEqual(norm({}).refusal, 'invalid');
    });
    it('disables proxies', () => {
      const r = norm({uri: 'http://allowed.example.test/'});
      assert.ok(Object.prototype.hasOwnProperty.call(r.options, 'proxy'));
      assert.strictEqual(r.options.proxy, null);
    });
    it('refuses every key that is not on the allowlist', () => {
      ['followAllRedirects', 'socketPath', 'urlParser', 'lookup', 'agentOptions', 'agents', 'agent', 'pool',
        'disableUrlEncoding', 'localAddress', 'forever'].forEach((key) => {
        const r = norm({uri: 'http://allowed.example.test/', followRedirect: false, [key]: {}});
        assert.strictEqual(r.refusal, key);
        assert.strictEqual(r.options, null);
      });
    });
    it('passes allowlisted keys into the copy', () => {
      const r = norm({uri: 'http://allowed.example.test/', method: 'POST', headers: {a: 'b'}, json: true, qs: {q: 1}, timeout: 9});
      assert.strictEqual(r.refusal, null);
      assert.strictEqual(r.options.method, 'POST');
      assert.deepStrictEqual(r.options.headers, {a: 'b'});
      assert.strictEqual(r.options.json, true);
      assert.deepStrictEqual(r.options.qs, {q: 1});
      assert.strictEqual(r.options.timeout, 9);
    });
    it('keeps followRedirect false, and does not mutate the caller\'s options', () => {
      const given = {uri: 'http://allowed.example.test/', followRedirect: false};
      assert.strictEqual(norm(given).options.followRedirect, false);
      assert.deepStrictEqual(given, {uri: 'http://allowed.example.test/', followRedirect: false});
    });
    it('the redirect guard refuses a forbidden target and reports it', () => {
      const seen = [];
      const guard = norm('http://allowed.example.test/', (t) => seen.push(t)).options.followRedirect;
      const self = {uri: {href: 'http://allowed.example.test/start'}};
      assert.strictEqual(guard.call(self, {headers: {location: 'http://127.0.0.1:1/x'}}), false);
      assert.deepStrictEqual(seen, ['127.0.0.1:1']);
      assert.strictEqual(guard.call(self, {headers: {location: '/next'}}), true);
    });
  });
});

// vm's module classes, with --experimental-vm-modules (which a worker
// inherits from the server's own flags): each takes a code cache by more
// routes than a view can close, so under enforce they are gone from module
// code's vm; under audit their use is said (#194's PR 3)
describe('sandbox 05: vm module classes (--experimental-vm-modules)', function() {
  this.timeout(120000);
  ['enforce', 'audit'].forEach((mode) => {
    it(`${mode}: ${mode === 'enforce' ? 'gone, the key too' : 'there, and their use said'}`, async () => {
      const port = testPort(9773);
      const server = await startServer(port, serverArgs(mode), {nodeArgs: ['--experimental-vm-modules']});
      try {
        const from = server.output.length;
        assert.deepStrictEqual(toolOutput(await mcpCall(port, KEY, TOOL, {what: 'vmModules'})), {outcome: 'allowed', code: mode === 'enforce' ? 'GONE' : 'PRESENT'});
        if (mode === 'audit') await waitFor(() => server.output.slice(from).includes('violation vm SourceTextModule (--experimental-vm-modules: removed under enforce)'), 20000, 'the vm module line');
      } finally {
        stopServer(server);
      }
    });
  });
});

// The file broker runs in every mode, so its limits do too.
describe('sandbox 05: off', function() {
  this.timeout(120000);
  let server = null;
  before(async () => { server = await startServer(testPort(9610), serverArgs('off')); });
  after(() => stopServer(server));

  it('http2 respondWithFile is not available', async () => {
    const r = await mcpCall(testPort(9610), KEY, TOOL, {what: 'http2RespondFile'});
    assert.deepStrictEqual(toolOutput(r), {outcome: 'blocked', code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'}, JSON.stringify(r));
  });
});

describe('sandbox 05: the built-in allowlist', () => {
  const REFUSED = ['child_process', 'cluster', 'worker_threads', 'inspector', 'inspector/promises', 'v8', 'wasi',
    'sqlite', 'test', 'test/reporters', 'sea', 'repl', 'trace_events',
    '_tls_wrap', '_tls_common',   // Node's tls internals: a module needs tls, which carries the lockdown's wrappers
    '_stream_wrap',   // DEP0125; its JSStreamSocket extends the real net.Socket, past the guard
    'ffi'];   // Node 26: a foreign-function interface, native code from JavaScript

  it('refuses each left-out built-in, with or without node:', () => {
    REFUSED.forEach((id) => {
      assert.strictEqual(builtinAllowed(id), false, id);
      assert.strictEqual(builtinAllowed(`node:${id}`), false, `node:${id}`);
    });
    assert.strictEqual(builtinAllowed('node:fs'), true);
  });

  it('refuses a built-in it has never heard of', () => {
    assert.strictEqual(builtinAllowed('node:some_future_builtin'), false);
  });

  // Fails when a Node upgrade adds a built-in: read it, then add it to the
  // allowlist or to REFUSED here.
  it('accounts for every built-in this Node has', () => {
    const unaccounted = Module.builtinModules.map((id) => id.replace(/^node:/, ''))
      .filter((id) => !ALLOWED_BUILTIN_IDS.includes(id) && REFUSED.indexOf(id) === -1);
    assert.deepStrictEqual(unaccounted, []);
  });
});
