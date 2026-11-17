// The lockdown's checks run on intrinsics taken before module code loads
// (docs/security-model.md, "Boundary checks run on intrinsics captured
// before module code loads"). A module shares the worker's realm: it can
// replace a String, Array, Set, RegExp or Function method, a getter on
// URL.prototype, or a function of a shared built-in module (path, url,
// module). With each replaced in turn (the fixture's CHANGES), every check
// still answers as it would with none replaced:
// - under enforce, every built-in outside the allowed list is refused, by
//   require and by process.getBuiltinModule; a file outside the module's
//   root is refused (require, CHUtil.loadFile); an ungranted host is refused
//   (CHUtil.request); and no guard hands the original it wraps to the
//   replaced function (call, apply, Reflect's);
// - under audit, each of those is still reported.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const {ROOT, startServer, stopServer, post} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {deviceIDForName} = require('../../lib/call-address');
const {ALLOWED_BUILTIN_IDS} = require('../../lib/module-lockdown');

const KEY = 'sandbox-62-key';
const PROBE = 'intrinsics-probe';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', PROBE);
const SERVICE = 'urn:countinghouse-test:serviceID:probeService';
const TAG = '(countinghouse module sandbox)';
// the fixture's list, read from its file so the two never differ
// the fixture's own list of its changes (its CHANGES' keys)
const CHANGES = require(path.join(FIXTURE, 'handlers', 'probeService', 'probe.js')).CHANGE_NAMES;
const BLOCKED = Module.builtinModules.filter((b) => !b.startsWith('internal/') && !ALLOWED_BUILTIN_IDS.includes(b.replace(/^node:/, '')));
// files outside the module's root, distinct for each change (each
// reported once under audit) and harmless to load: other fixtures' api.json
const OUTSIDE_FILES = fs.readdirSync(path.join(ROOT, 'test', 'fixtures'))
  .map((d) => path.join(ROOT, 'test', 'fixtures', d, 'api.json'))
  .filter((f) => !f.startsWith(`${FIXTURE}${path.sep}`) && fs.existsSync(f)).sort();
// the originals the guards wrap, by name: none may be handed to a replaced
// call, apply or Reflect method
const ORIGINALS = ['loadFile', 'request', 'getBuiltinModule', 'readFileSync', 'openSync', 'fstatSync', 'statSync',
  '_stat', '_findPath', '_resolveFilename', '_readPackage'];
// the file broker's own refusal of a path outside the module's grants (the
// host file exists, so only the broker answers so), and of a descriptor it
// did not open
// (a change to the array iterator mangles the module's own arguments on
// their way to the broker, which then refuses them as invalid: the host file
// exists, so any of these means it was not read)
const BROKER_PATH_REFUSAL = ['ENOENT', 'EACCES', 'EINVAL', 'ERR_INVALID_ARG_TYPE'];
const H2 = path.join(FIXTURE, 'h2.cjs');
// what the lockdown fixes (non-writable, non-configurable): these changes
// cannot be made at all under audit or enforce, and every other one can
const FIXED = new Set(['url.fileURLToPath', 'path.resolve', 'path.relative', 'Module.isBuiltin', 'URL hostname',
  'NodeEventTarget.prototype.on', 'MessagePort.prototype.postMessage', 'EventTarget.prototype.addEventListener',
  // the runtime fixes its own files' exports and classes' prototypes at a
  // worker's boot, under every mode
  'runtime exports and prototypes replaced in place']);
// changes left in place across calls (the probe's persist mode): a call's
// token is kept, passed on and answered after the call that made the change
const PERSISTENT = ['Map.prototype.set/get/has/delete', 'Array.prototype.push/shift/unshift/splice/forEach', 'Object.assign',
  'TypedArray buffer/byteOffset/byteLength, ArrayBuffer.prototype.slice', 'Object.prototype numeric-key setters',
  'Object.prototype port-symbol setters', 'EventEmitter.prototype emit/on/once/addListener/removeListener/listenerCount',
  'require.cache entries swapped (call-limits, hop-input, port-scope, peer-channel, peer-worker, chutil-facade)',
  'runtime exports and prototypes replaced in place', 'Object.prototype setters', 'Object.prototype getters (runtime fields read)'];
const URL_BREAKING = 'Object.prototype getters (href, host, ports, net)';

for (const {mode, port} of [{mode: 'enforce', port: testPort(9714)}, {mode: 'audit', port: testPort(9715)}]) {
  describe(`sandbox 62: the lockdown's checks with the realm changed around them (${mode})`, function() {
    this.timeout(240000);
    let server = null;
    let base = null;
    // host files outside every grant and outside the namespace (under the
    // home: os.tmpdir() can be the host side of the module's /tmp), one for
    // each change (under audit each read is reported once), and a host
    // directory with a package.json
    const HOST_FILE = (i) => path.join(base, `host-file-${i}.txt`);
    const HOST_DIR = () => path.join(base, 'host-pkg');
    const HOST_PKG_NAME = 'ch-sandbox-62-host-pkg';
    before(async () => {
      assert.ok(CHANGES.length >= 35, CHANGES.join(', '));
      assert.ok(CHANGES.includes('Array.prototype index setters') && CHANGES.includes('WeakSet.prototype.has/add'), CHANGES.join(', '));
      assert.ok(OUTSIDE_FILES.length >= CHANGES.length, `${OUTSIDE_FILES.length} files for ${CHANGES.length} changes`);
      base = fs.mkdtempSync(path.join(os.homedir(), '.ch-sandbox-62-'));
      for (let i = 0; i < CHANGES.length; i++) fs.writeFileSync(HOST_FILE(i), 'a host file\n');
      fs.mkdirSync(HOST_DIR());
      fs.writeFileSync(path.join(HOST_DIR(), 'package.json'), JSON.stringify({name: HOST_PKG_NAME}));
      server = await startServer(port, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', mode,
        '--moduleDataPath', path.join(base, 'store')]);
      const loaded = await post(port, KEY, '/load-module', {path: FIXTURE, name: PROBE});
      assert.strictEqual(loaded.status, 200, JSON.stringify(loaded.body));
    });
    // the worker's own ports still carry its messages after the lockdown fixed
    // their methods: a reply (its parent port) and a line on stdout (Node's
    // stdio port)
    it('the worker\'s own ports work with their methods fixed', async () => {
      const marker = `${process.pid}-${Date.now()}`;
      const r = await post(port, KEY, `/devices/${deviceIDForName(PROBE)}/invoke-action`, {serviceID: SERVICE, actionName: 'probe', input: {change: CHANGES[0], route: 'stdio', marker}});
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.output, {written: true});
      const until = Date.now() + 5000;
      while (!server.output.includes(`ch-sandbox-62-stdio-${marker}`) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(server.output.includes(`ch-sandbox-62-stdio-${marker}`), 'the module\'s stdout line reached the server');
    });

    // what shares EventTarget.prototype with a port still works for a module
    it('AbortController, AbortSignal.timeout, timers\' abort, EventTarget (subclassed, defined on, onabort) and fetch\'s abort still work', async () => {
      const r = await post(port, KEY, `/devices/${deviceIDForName(PROBE)}/invoke-action`, {serviceID: SERVICE, actionName: 'probe', input: {change: CHANGES[0], route: 'abort'}});
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.output, {controller: true, timeout: true, timers: 'AbortError', eventTarget: 'ping',
        // EventTarget.prototype's methods are fixed: an instance assignment
        // throws in strict code; a definition, a subclass and an accessor work
        instanceAssign: 'TypeError', ownDefine: 'own', subclass: 'sub', onabort: true, fetch: 'rejected'});
    });

    // ctx.ask's values as the runtime copies them: never written through a
    // setter module code put on Object.prototype
    it('ctx.ask copies its values without a setter on Object.prototype seeing them', async () => {
      const r = await post(port, KEY, `/devices/${deviceIDForName(PROBE)}/invoke-action`, {serviceID: SERVICE, actionName: 'probe', input: {change: CHANGES[0], route: 'ask'}});
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.output, {setterHits: 0, answer: 'ASK_UNAVAILABLE'});
    });

    // util.inspect (console.log's way) of a port, with its methods fixed
    it('a port is inspected as a MessagePort', async () => {
      const r = await post(port, KEY, `/devices/${deviceIDForName(PROBE)}/invoke-action`, {serviceID: SERVICE, actionName: 'probe', input: {change: CHANGES[0], route: 'inspect'}});
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.output, {inspect: 'MessagePort'});
    });

    // a change installed by one call and kept: the next calls' tokens, kept by
    // the runtime, passed on to the main thread and answered, are never seen
    for (const change of PERSISTENT) {
      it(`with ${change} kept across calls, no later call's token or port is handed over`, async () => {
        const invoke = (input) => post(port, KEY, `/devices/${deviceIDForName(PROBE)}/invoke-action`, {serviceID: SERVICE, actionName: 'probe', input: Object.assign({change}, input)});
        const installed = await invoke({persist: 'install'});
        assert.strictEqual(installed.status, 200, JSON.stringify(installed.body));
        assert.strictEqual(installed.body.output.installed, !FIXED.has(change), `${change}: ${JSON.stringify(installed.body.output)}`);
        const work = [];
        for (let n = 0; n < 2; n++) {
          const r = await invoke({route: 'work'});
          work[n] = r.status === 200 ? r.body.output : {status: r.status, body: r.body};
        }
        const collected = await invoke({persist: 'collect'});
        const shown = JSON.stringify({work, collected: collected.body});
        assert.strictEqual(collected.status, 200, shown);
        for (const w of work) assert.deepStrictEqual(Object.keys(w).sort(), ['ask', 'remote', 'usage'], shown);
        assert.strictEqual(collected.body.output.tokensSeen, 0, `a token was handed over with ${change} kept: ${shown}`);
        assert.strictEqual(collected.body.output.portsSeen, 0, `a port was handed over with ${change} kept: ${shown}`);
      });
    }

    // a read grant does not write (h2.cjs: kept as it was, whatever happens)
    let h2Before = null;
    it('a read grant (an imported CommonJS file) opens read-only and reads with options of its own', async () => {
      h2Before = fs.readFileSync(H2, 'utf8');
      const r = await post(port, KEY, `/devices/${deviceIDForName(PROBE)}/invoke-action`, {serviceID: SERVICE, actionName: 'probe', input: {change: CHANGES[0], route: 'grant-write'}});
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const out = r.body.output;
      const shown = JSON.stringify(out);
      if (mode === 'enforce') {
        // (the broker's answer: the imported file's host path is outside the namespace)
        assert.deepStrictEqual(out.write, {outcome: 'refused', code: 'ENOENT'}, `openSync(r+) of a granted file: ${shown}`);
        // a descriptor the grant opened (a real one) stats, reads and
        // closes; every other descriptor call is the broker's, which does
        // not know it
        for (const op of ['fstat', 'read', 'close']) assert.strictEqual(out.fdOps[op].outcome, 'reached', `${op} on the grant's descriptor: ${shown}`);
        for (const op of ['fchmod', 'fchown', 'futimes', 'fsync', 'ftruncate', 'write']) {
          assert.deepStrictEqual(out.fdOps[op], {outcome: 'refused', code: 'EBADF'}, `${op} on the grant's read-only descriptor: ${shown}`);
        }
      }
      assert.strictEqual(fs.readFileSync(H2, 'utf8'), h2Before, 'the file is as it was');
      assert.ok(out.length > 0, shown);
    });
    // the loader's package.json read reads the directory it checked (enforce
    // hides a host directory's package.json from the loader; audit hides nothing)
    if (mode === 'enforce') {
      it('Module._readPackage reads the directory it checked, with a setter on Array.prototype[0]', async () => {
        const r = await post(port, KEY, `/devices/${deviceIDForName(PROBE)}/invoke-action`, {serviceID: SERVICE, actionName: 'probe', input: {change: CHANGES[0], route: 'read-package', hostDir: HOST_DIR()}});
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        const got = r.body.output.readPackage;
        assert.ok(got === 'unreachable' || (got != null && got.name !== HOST_PKG_NAME && got.exists !== true), `the host directory's package.json was read: ${JSON.stringify(got)}`);
      });
    }
    after(() => {
      if (h2Before != null && fs.readFileSync(H2, 'utf8') !== h2Before) fs.writeFileSync(H2, h2Before);
      stopServer(server);
      if (base != null) fs.rmSync(base, {recursive: true, force: true});
    });

    CHANGES.forEach((change, i) => {
      it(`with ${change} replaced`, async () => {
        // under audit a fresh worker each: a worker reports at most 100
        // distinct violations, then goes quiet
        if (mode === 'audit' && i > 0) {
          const restarted = await post(port, KEY, '/restart-module', {path: FIXTURE, name: PROBE});
          assert.strictEqual(restarted.status, 200, JSON.stringify(restarted.body));
        }
        const mark = server.output.length;
        // (a name under .invalid never resolves: no connection is made, audit's included)
        const input = {change, builtins: mode === 'enforce' ? BLOCKED : (i < BLOCKED.length ? [BLOCKED[i]] : []),
          runtimeFile: OUTSIDE_FILES[i], outsidePath: path.join(os.tmpdir(), `ch-sandbox-62-outside-${i}.txt`), host: `ch-sandbox-62-${i}.invalid`,
          hostFile: HOST_FILE(i), realFd: 2};
        const r = await post(port, KEY, `/devices/${deviceIDForName(PROBE)}/invoke-action`, {serviceID: SERVICE, actionName: 'probe', input});
        // A change the runtime's own code in the worker then trips over (Map's
        // get, say) can end the module's worker: the module's own loss. A
        // fresh worker for the next change; under audit the reports below are
        // still required, under enforce nothing may have been reached.
        if (r.status !== 200) {
          const restarted = await post(port, KEY, '/restart-module', {path: FIXTURE, name: PROBE});
          assert.strictEqual(restarted.status, 200, JSON.stringify(restarted.body));
        }
        const out = r.status === 200 ? r.body.output : null;
        if (mode === 'enforce') assert.ok(out != null, `the worker ended with ${change} replaced: ${JSON.stringify(r.body)}`);
        if (out != null) {
          assert.strictEqual(out.undone, true, JSON.stringify(out));
          assert.strictEqual(out.changed, !FIXED.has(change), `${change} ${FIXED.has(change) ? 'is fixed by the lockdown' : 'was made'}: ${JSON.stringify(out)}`);
        }
        const shown = JSON.stringify(out);
        if (mode === 'enforce') {
          for (const b of BLOCKED) {
            assert.strictEqual(out.builtins[b].outcome, 'refused', `require(${b}): ${shown}`);
            assert.strictEqual(out.builtins[b].code, 'MODULE_NOT_FOUND', `require(${b}): ${shown}`);
            assert.ok(out.builtins[b].message.includes(TAG), `require(${b}) refused by the lockdown: ${shown}`);
            assert.deepStrictEqual(out.getBuiltin[b], {outcome: 'refused', code: 'undefined'}, `getBuiltinModule(${b}): ${shown}`);
          }
          assert.strictEqual(out.outsidePath.outcome, 'refused', `CHUtil.loadFile outside the root: ${shown}`);
          assert.strictEqual(out.outsidePath.code, 'MODULE_NOT_FOUND', shown);
          assert.ok(out.outsidePath.message.includes(TAG), shown);
          assert.strictEqual(out.createRequireOutside.outcome, 'refused', `module.createRequire outside the root: ${shown}`);
          assert.strictEqual(out.createRequireOutside.code, 'MODULE_NOT_FOUND', shown);
          assert.deepStrictEqual(out.host, {outcome: 'refused', code: 'ERR_ACCESS_DENIED'}, `an ungranted host: ${shown}`);
          assert.strictEqual(out.runtimeFile.outcome, 'refused', `require of a file outside the root: ${shown}`);
          // (a getter-only href on Object.prototype makes Node's own URL
          // parser throw first, in that realm: refused all the same)
          if (!(change === URL_BREAKING && /only a getter/.test(out.runtimeFile.message))) assert.strictEqual(out.runtimeFile.code, 'MODULE_NOT_FOUND', shown);
          // the file broker (enforce only: under audit a module may read
          // outside its grants, as the broker's L2 rule says)
          assert.strictEqual(out.hostFile.outcome, 'refused', `fs.readFileSync of a host file outside every grant: ${shown}`);
          assert.ok(BROKER_PATH_REFUSAL.includes(out.hostFile.code), `refused by the broker: ${shown}`);
          assert.strictEqual(out.hostStat.outcome, 'refused', `fs.statSync of a host file outside every grant: ${shown}`);
          assert.ok(BROKER_PATH_REFUSAL.includes(out.hostStat.code), `refused by the broker: ${shown}`);
          // descriptor 2 is always open in this process, so the original
          // fs's fstat of it cannot fail: any refusal means the original was
          // not used (EBADF is the broker's; a change to the array iterator
          // mangles the module's own arguments, which the broker refuses)
          assert.strictEqual(out.realFd.outcome, 'refused', `fs.fstatSync of a real descriptor: ${shown}`);
          assert.ok(['EBADF', ...BROKER_PATH_REFUSAL].includes(out.realFd.code), `refused by the broker: ${shown}`);
          assert.ok(!('importFailed' in out), `the module's own import: ${shown}`);
        } else {
          // reported, whatever the call did (audit allows)
          const log = () => server.output.slice(mark);
          const seen = async (re, what) => {
            const until = Date.now() + 5000;
            while (!re.test(log()) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
            assert.match(log(), re, `${what} reported with ${change} replaced; the log said: ${log().split('\n').filter((l) => /violation|sandbox|Error/.test(l)).slice(-12).join(' | ')}`);
          };
          const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (i < BLOCKED.length) await seen(new RegExp(`${PROBE} violation builtin ${esc(BLOCKED[i].replace(/^node:/, ''))} `), `the built-in ${BLOCKED[i]}`);
          await seen(new RegExp(`${PROBE} violation loadFile ${esc(input.outsidePath)}`), 'CHUtil.loadFile outside the root');
          // (a getter-only href on Object.prototype makes Node's own URL
          // parser throw in that realm: the check then fails closed, and the
          // report names the target "invalid")
          await seen(new RegExp(`${PROBE} violation net (?:${esc(input.host)}:80\\b|invalid )`), 'an ungranted host');
          // the file broker: a host file outside the namespace, read (audit
          // allows) and reported
          await seen(new RegExp(`module sandbox: ${PROBE} file outside ${esc(input.hostFile)}\\b`), 'a host file outside the namespace');
        }
        if (out != null) for (const name of ORIGINALS) assert.ok(!out.handed.includes(name), `the original ${name} was handed to the replaced ${change}: ${shown}`);
        // what is checked is what is used: never the host file
        if (out != null) {
          assert.ok(!(out.toPrimitiveLoad.outcome === 'reached' && out.toPrimitiveLoad.value !== 'own data'), `CHUtil.loadFile of a value read twice: ${shown}`);
          assert.ok(!(out.ownHrefRead.outcome === 'reached' && out.ownHrefRead.value !== "'use strict';\nmodule.exports = 'own data';\n"), `fs.readFileSync of a URL with an own href: ${shown}`);
        }
        // no port reaches a setter a module put on a prototype
        if (out != null) assert.strictEqual(out.portsSeen, 0, `a port was handed to a setter with ${change} in place: ${shown}`);
        // nor a message holding the call's token
        if (out != null) assert.strictEqual(out.tokensSeen, 0, `a token was handed to a setter with ${change} in place: ${shown}`);
        // the code of an error the runtime issued is one it issued, never one
        // the module chose (the change offers DEVICE_OFFLINE)
        const issued = await post(port, KEY, `/devices/${deviceIDForName(PROBE)}/invoke-action`, {serviceID: SERVICE, actionName: 'probe', input: Object.assign({}, input, {rethrow: true})});
        if (issued.status !== 200 && mode === 'audit') {
          const restarted = await post(port, KEY, '/restart-module', {path: FIXTURE, name: PROBE});
          assert.strictEqual(restarted.status, 200, JSON.stringify(restarted.body));
        }
        const issuedText = JSON.stringify(issued.body);
        assert.ok(!/DEVICE_OFFLINE/.test(issuedText), `an issued code changed with ${change} replaced: ${issuedText}`);

      });
    });
  });
}
