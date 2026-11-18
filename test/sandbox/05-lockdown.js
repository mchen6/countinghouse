// Every route the lockdown controls, under enforce (blocked, logged) and audit
// (allowed, logged once). Plus Review Focus 2: a full composition scenario
// under enforce, so countinghouse's own worker code is proven not to trip the
// built-in block.
const assert = require('assert');
const path   = require('path');
const Module = require('module');
const {normaliseRequestOptions, builtinAllowed, ALLOWED_BUILTIN_IDS} = require('../../lib/module-lockdown');
const {ROOT, startServer, stopServer, mcpCall, waitFor} = require('../helpers/sandbox-server');
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
  ['listenFd'], ['socketFd'], ['socketFdNumber'], ['connectFd'], ['ttyFd'], ['socketCtor'], ['ttyWriteCtor'], ['ttyReadCtor'], ['ttySuper'], ['tlsSuper'], ['dgramFd'], ['report'], ['compileCache'], ['sourceMaps'],
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

describe('sandbox 05: worker lockdown', function() {
  this.timeout(120000);

  describe('enforce', () => {
    let server = null;
    before(async () => { server = await startServer(testPort(9608), serverArgs('enforce')); }); // serverArgs passes --workerThread
    after(() => stopServer(server));

    it('a handle object given to net.Socket is not adoption', () => handleIsNotAdoption(testPort(9608), server));

    ROUTES.forEach(([what, arg]) => {
      it(`blocks ${what} and logs it`, async () => {
        const r = await mcpCall(testPort(9608), KEY, TOOL, arg != null ? {what: what, arg: arg} : {what: what});
        assert.strictEqual(r.isError, false, JSON.stringify(r));
        // (a path outside is invisible under enforce: the file broker's
        // _findPath answers it missing, so a load of one finds nothing, and
        // Node's own not-found is what the module sees; B1's loadSource
        // compiled its source there before)
        if (what === 'loadSource') assert.deepStrictEqual(toolOutput(r), {outcome: 'allowed', code: 'MODULE_NOT_FOUND'}, JSON.stringify(r));
        else assert.strictEqual(toolOutput(r).outcome, 'blocked', `${what}: ${JSON.stringify(r)}`);
        assert.ok(server.output.includes('module sandbox: sandbox-probe violation'), server.output.slice(-2000));
      });
    });

    if (!STREAM_WRAP) {
      STREAM_WRAP_ROUTES.forEach(([what]) => {
        it(`${what} is not found: this Node has no _stream_wrap`, async () => {
          const r = await mcpCall(testPort(9608), KEY, TOOL, {what: what});
          assert.deepStrictEqual(toolOutput(r), {outcome: 'allowed', code: 'MODULE_NOT_FOUND'}, JSON.stringify(r));
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
    // #406's second review: a parent whose path is lib/ and whose filename is
    // the module's own poisoned Node's relative-resolve cache, so the
    // runtime's first getHostIp got the module's decoy. Node is now handed a
    // shadow built from the filename alone: the module's load is its own,
    // recorded under its own directory, and the runtime's getHostIp is clean
    // (the route throws POISONED otherwise)
    it('a parent whose path is lib/ and whose filename is the module\'s own no longer poisons the runtime\'s later require', async () => {
      assert.deepStrictEqual(toolOutput(await mcpCall(port, KEY, TOOL, {what: 'poisonRelative'})), {outcome: 'allowed', code: null});
      assert.deepStrictEqual(toolOutput(await mcpCall(port, KEY, TOOL, {what: 'hostIpClean'})), {outcome: 'allowed', code: null});
    });
    it('createRequire\'s own Module still loads', async () => {
      assert.deepStrictEqual(toolOutput(await mcpCall(port, KEY, TOOL, {what: 'createRequireOwn'})), {outcome: 'allowed', code: null});
    });
    it('no linkage is emulated: a child has no parent, at its load and after', async () => {
      assert.deepStrictEqual(toolOutput(await mcpCall(port, KEY, TOOL, {what: 'linkageNone'})), {outcome: 'allowed', code: null});
    });
    it(`a new extension ${mode === 'enforce' ? 'can\'t be added to the table' : 'is reported at the next load'}`, async () => {
      const from = server.output.length;
      const r = toolOutput(await mcpCall(port, KEY, TOOL, {what: 'newExtension'}));
      if (mode === 'enforce') assert.deepStrictEqual(r, {outcome: 'allowed', code: null});
      else {
        assert.deepStrictEqual(r, {outcome: 'allowed', code: 'ADDED'});
        await waitFor(() => server.output.slice(from).includes('violation require Module._extensions[.min.js] added'), 20000, 'the added extension\'s line');
      }
    });
    it(`each property #406 holds ${mode === 'enforce' ? 'can\'t be replaced' : 'is replaced and reported'}`, async () => {
      const names = {protoLoad: 'Module.prototype.load', jsHandler: 'Module._extensions[\'.js\']', jsonHandler: 'Module._extensions[\'.json\']',
        resolveFilename: '_resolveFilename'};
      for (const arg of Object.keys(names)) {
        const from = server.output.length;
        const r = toolOutput(await mcpCall(port, KEY, TOOL, {what: 'replaceHeld', arg}));
        if (mode === 'enforce') {
          assert.deepStrictEqual(r, {outcome: 'allowed', code: null}, `${arg} was replaced under enforce`);
        } else {
          assert.deepStrictEqual(r, {outcome: 'allowed', code: 'REPLACED'}, arg);
          await waitFor(() => server.output.slice(from).includes(`violation require ${names[arg]} replaced`), 20000, `${arg}'s violation line`);
        }
      }
    });
    if (mode === 'audit') {
      it('an assignment of load on one Module is that Module\'s own, never the worker\'s', async () => {
        assert.deepStrictEqual(toolOutput(await mcpCall(port, KEY, TOOL, {what: 'instanceLoad'})), {outcome: 'allowed', code: 'OWN'});
      });
      it('a module that replaces Module._load is reported', async () => {
        const from = server.output.length;
        assert.strictEqual(toolOutput(await mcpCall(port, KEY, TOOL, {what: 'replaceLoad'})).outcome, 'allowed');
        await waitFor(() => server.output.slice(from).includes('violation require _load replaced'), 20000, 'the replacement\'s violation line');
      });
    }
    it(`loadSource: no source compiled under a countinghouse filename; ${mode === 'enforce' ? 'the path is invisible' : 'the real file, reported'}`, async () => {
      const from = server.output.length;
      const r = toolOutput(await mcpCall(port, KEY, TOOL, {what: 'loadSource', arg: OUTSIDE_FILE}));
      // (under enforce a path outside is invisible: the file broker's
      // _findPath answers it missing, and Node's own not-found is what the
      // module sees)
      if (mode === 'enforce') assert.deepStrictEqual(r, {outcome: 'allowed', code: 'MODULE_NOT_FOUND'});
      else {
        assert.deepStrictEqual(r, {outcome: 'allowed', code: null});
        await waitFor(() => server.output.slice(from).split('\n').some((l) => l.includes('module sandbox: sandbox-probe violation require') && l.includes('cli-options')),
          20000, 'the require\'s violation line');
      }
      const cached = toolOutput(await mcpCall(port, KEY, TOOL, {what: 'compiledInCache', arg: OUTSIDE_FILE}));
      assert.deepStrictEqual(cached, {outcome: 'allowed', code: null}, 'the cache holds compiled source under that filename');
    });
  }));

  // Every forged parent the reviews of #406 found, on a server of its own
  // per mode, each tried before the runtime's first getHostIp (once the
  // runtime has resolved './bind-address' itself, Node answers its key from
  // the cache and nothing can be recorded under it): none may leave the
  // decoy under lib/'s key. The refused ones are each said, by their reason.
  ['enforce', 'audit'].forEach((mode, i) => describe(`${mode}: forged parents before the runtime's first require`, () => {
    let server = null;
    const port = testPort(9773 + i);
    before(async () => { server = await startServer(port, serverArgs(mode)); });
    after(() => stopServer(server));
    it('none poisons the runtime\'s first require (each decoy loads as its own); the refused ones are each said; nothing of the runtime\'s runs module code', async () => {
      const refused = {objectRequest: 'a request that is no string', isMain: 'as the main module', filenameThrows: 'a parent whose filename could not be read',
        filenameThrowsOnce: 'a parent whose filename could not be read', relativeFilename: 'a parent with no absolute filename',
        relativeWithPath: 'a parent with no absolute filename', nonObject: 'a parent that is no object', primitiveProto: 'a parent that is no object'};
      // under audit nothing is refused: each is said, and the load goes on
      // (never with a parent Node could key on a runtime directory)
      const saidOnly = mode === 'audit' ? Object.keys(refused) : [];
      const said = new Set();
      for (const variant of ['dirname', 'paths', 'noId', 'plainObject', 'idGetter', 'builtinModule', 'nullParent', 'undefinedParent', 'pathCache',
        'objectRequest', 'isMain', 'filenameThrows', 'filenameThrowsOnce', 'relativeFilename', 'relativeWithPath', 'nonObject', 'primitiveProto']) {
        const from = server.output.length;
        const r = toolOutput(await mcpCall(port, KEY, TOOL, {what: 'forgeParent', arg: variant}));
        if (refused[variant] == null) {
          assert.deepStrictEqual(r, {outcome: 'allowed', code: null}, variant);
          continue;
        }
        assert.strictEqual(r.outcome, saidOnly.includes(variant) ? 'allowed' : 'blocked', `${variant}: ${JSON.stringify(r)}`);
        // (a line is said once: two variants with the same request and reason share it)
        if (said.has(refused[variant])) continue;
        said.add(refused[variant]);
        await waitFor(() => server.output.slice(from).includes(`(${refused[variant]})`), 20000, `${variant}'s violation line`);
      }
      // the runtime's first './bind-address' (a fresh load): nothing of its own Module runs module code
      assert.deepStrictEqual(toolOutput(await mcpCall(port, KEY, TOOL, {what: 'linkageSpy'})), {outcome: 'allowed', code: null});
      assert.deepStrictEqual(toolOutput(await mcpCall(port, KEY, TOOL, {what: 'hostIpClean'})), {outcome: 'allowed', code: null}, 'the runtime got the decoy');
    });
  }));

  describe('audit', () => {
    let server = null;
    before(async () => { server = await startServer(testPort(9609), serverArgs('audit')); }); // serverArgs passes --workerThread
    after(() => stopServer(server));

    it('a handle object given to net.Socket is not adoption', () => handleIsNotAdoption(testPort(9609), server));

    ROUTES.forEach(([what, arg]) => {
      it(`allows ${what} and logs it`, async () => {
        const r = await mcpCall(testPort(9609), KEY, TOOL, arg != null ? {what: what, arg: arg} : {what: what});
        assert.strictEqual(toolOutput(r).outcome, 'allowed', `${what}: ${JSON.stringify(r)}`);
      });
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
  });

  // Review Focus 2.
  describe('composition under enforce', () => {
    let server = null;
    // Same server as test/composition/02-ctx-call.js (no --debug, its own
    // auth config and key), plus --moduleSandbox enforce. Direct peer
    // channels are at their default, on.
    before(async () => {
      server = await startServer(testPort(9610), ['--workerThread', '--moduleSandbox', 'enforce',
        '--authConfigPath', path.join(ROOT, 'test', 'composition', 'fixtures-auth.json'),
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
