// Every route the lockdown controls, under enforce (blocked, logged) and audit
// (allowed, logged once). Plus Review Focus 2: a full composition scenario
// under enforce, so countinghouse's own worker code is proven not to trip the
// built-in block.
const assert = require('assert');
const path   = require('path');
const Module = require('module');
const {normaliseRequestOptions, builtinAllowed, ALLOWED_BUILTINS} = require('../../lib/module-lockdown');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');

const KEY   = 'aabbcc';
const PROBE = path.join(ROOT, 'test', 'fixtures', 'sandbox-probe');
const TOOL  = 'sandbox_probe_probeservice_attempt';
const OUTSIDE_FILE = path.join(ROOT, 'lib', 'cli-options.js');

const ROUTES = [
  ['dlopen'], ['binding'], ['kill'], ['getBuiltinModule'], ['child_process'], ['worker_threads'],
  ['v8'], ['registerHooks'], ['nodePath'], ['loadFileOutside', OUTSIDE_FILE], ['request', 'http://127.0.0.1:1/'],
  ['_kill'], ['dataImport', OUTSIDE_FILE], ['reducedCreateRequire'], ['requestUri'], ['requestBaseUrl'], ['requestHar'],
  ['sqlite'], ['nodeTest'], ['importSqlite'], ['getBuiltinSqlite'], ['tlsEngine'], ['clientCertEngine'], ['cryptoEngine'],
  ['listenFd'], ['socketFd'], ['socketFdNumber'], ['ttyFd'], ['dgramFd'], ['report'], ['compileCache'], ['sourceMaps'],
  ['repl'], ['traceEvents'], ['http2RespondFD']
];

function serverArgs(mode) {
  return ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', mode, '--loadModule', PROBE];
}

// L1: adoption is a descriptor number. A handle object given to net.Socket
// is never a route to a foreign descriptor inside a worker (Node's own
// TLSSocket constructs one that way), so it is not a violation: the bogus
// handle fails on its own, and no descriptor line is logged. First in each
// mode, before any route logs a descriptor violation, and the log is read
// after it has had time to arrive (it reaches the test asynchronously).
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));
async function handleIsNotAdoption(port, server) {
  const r = await mcpCall(port, KEY, TOOL, {what: 'socketHandle'});
  assert.strictEqual(toolOutput(r).outcome, 'allowed', JSON.stringify(r));
  await settle();
  assert.ok(!server.output.includes('violation descriptor'), server.output.split('\n').filter((l) => l.includes('violation')).join('\n'));
}

describe('sandbox 05: worker lockdown', function() {
  this.timeout(120000);

  describe('enforce', () => {
    let server = null;
    before(async () => { server = await startServer(9608, serverArgs('enforce')); }); // serverArgs passes --workerThread
    after(() => stopServer(server));

    it('a handle object given to net.Socket is not adoption', () => handleIsNotAdoption(9608, server));

    ROUTES.forEach(([what, arg]) => {
      it(`blocks ${what} and logs it`, async () => {
        const r = await mcpCall(9608, KEY, TOOL, arg != null ? {what: what, arg: arg} : {what: what});
        assert.strictEqual(r.isError, false, JSON.stringify(r));
        assert.strictEqual(toolOutput(r).outcome, 'blocked', `${what}: ${JSON.stringify(r)}`);
        assert.ok(server.output.includes('module sandbox: sandbox-probe violation'), server.output.slice(-2000));
      });
    });

    it('a createRequire on the module directory (trailing slash) still resolves inside it', async () => {
      const r = await mcpCall(9608, KEY, TOOL, {what: 'createRequireDir'});
      assert.deepStrictEqual(toolOutput(r), {outcome: 'allowed', code: null});
    });

    it('process.loadEnvFile reads through the broker', async () => {
      const r = await mcpCall(9608, KEY, TOOL, {what: 'loadEnvFile'});
      assert.deepStrictEqual(toolOutput(r), {outcome: 'allowed', code: null}, JSON.stringify(r));
    });

    it('http2 respondWithFile is not available', async () => {
      const r = await mcpCall(9608, KEY, TOOL, {what: 'http2RespondFile'});
      assert.deepStrictEqual(toolOutput(r), {outcome: 'blocked', code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'}, JSON.stringify(r));
    });

    it('uses Node\'s own error codes', async () => {
      const notFound = await mcpCall(9608, KEY, TOOL, {what: 'child_process'});
      assert.strictEqual(toolOutput(notFound).code, 'MODULE_NOT_FOUND');
      const denied = await mcpCall(9608, KEY, TOOL, {what: 'kill'});
      assert.strictEqual(toolOutput(denied).code, 'ERR_ACCESS_DENIED');
    });
  });

  describe('audit', () => {
    let server = null;
    before(async () => { server = await startServer(9609, serverArgs('audit')); }); // serverArgs passes --workerThread
    after(() => stopServer(server));

    it('a handle object given to net.Socket is not adoption', () => handleIsNotAdoption(9609, server));

    ROUTES.forEach(([what, arg]) => {
      it(`allows ${what} and logs it`, async () => {
        const r = await mcpCall(9609, KEY, TOOL, arg != null ? {what: what, arg: arg} : {what: what});
        assert.strictEqual(toolOutput(r).outcome, 'allowed', `${what}: ${JSON.stringify(r)}`);
      });
    });

    it('process.loadEnvFile reads through the broker', async () => {
      const r = await mcpCall(9609, KEY, TOOL, {what: 'loadEnvFile'});
      assert.deepStrictEqual(toolOutput(r), {outcome: 'allowed', code: null}, JSON.stringify(r));
    });

    it('the guarded net.Socket still subclasses and recognises Node\'s own sockets', async () => {
      const r = await mcpCall(9609, KEY, TOOL, {what: 'socketClass'});
      assert.deepStrictEqual(toolOutput(r), {outcome: 'allowed', code: null}, JSON.stringify(r));
    });

    it('http2 respondWithFile is not available', async () => {
      const r = await mcpCall(9609, KEY, TOOL, {what: 'http2RespondFile'});
      assert.deepStrictEqual(toolOutput(r), {outcome: 'blocked', code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'}, JSON.stringify(r));
    });

    it('logs a repeated violation once', async () => {
      await mcpCall(9609, KEY, TOOL, {what: 'v8'});
      await mcpCall(9609, KEY, TOOL, {what: 'v8'});
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
      server = await startServer(9610, ['--workerThread', '--moduleSandbox', 'enforce',
        '--authConfigPath', path.join(ROOT, 'test', 'composition', 'fixtures-auth.json'),
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'compose-callee'),
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'compose-caller')]);
    });
    after(() => stopServer(server));

    it('a ctx.call between two modules works, with no violation from countinghouse\'s own code', async () => {
      const r = await mcpCall(9610, 'composition-test-key', 'compose_caller_callerservice_viacall', {n: 21});
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
  before(async () => { server = await startServer(9610, serverArgs('off')); });
  after(() => stopServer(server));

  it('http2 respondWithFile is not available', async () => {
    const r = await mcpCall(9610, KEY, TOOL, {what: 'http2RespondFile'});
    assert.deepStrictEqual(toolOutput(r), {outcome: 'blocked', code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'}, JSON.stringify(r));
  });
});

describe('sandbox 05: the built-in allowlist', () => {
  const REFUSED = ['child_process', 'cluster', 'worker_threads', 'inspector', 'inspector/promises', 'v8', 'wasi',
    'sqlite', 'test', 'test/reporters', 'sea', 'repl', 'trace_events',
    '_tls_wrap', '_tls_common',   // Node's tls internals: a module needs tls, which carries the lockdown's wrappers
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
      .filter((id) => !ALLOWED_BUILTINS.has(id) && REFUSED.indexOf(id) === -1);
    assert.deepStrictEqual(unaccounted, []);
  });
});
