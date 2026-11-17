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
const ORIGINALS = ['loadFile', 'request', 'getBuiltinModule'];
// what the lockdown fixes (non-writable, non-configurable): these changes
// cannot be made at all under audit or enforce, and every other one can
const FIXED = new Set(['url.fileURLToPath', 'path.resolve', 'path.relative', 'Module.isBuiltin', 'URL hostname']);
// Checked from the next change on (the file broker's own checks): a file
// outside the root by require, refused with each change in place. Until
// then a change that makes the broker's loader hook pass it lets the
// broker's read answer ENOENT instead.
const REQUIRE_OUTSIDE_PENDING = false;
const URL_BREAKING = 'Object.prototype getters (href, host, ports, net)';

for (const {mode, port} of [{mode: 'enforce', port: testPort(9714)}, {mode: 'audit', port: testPort(9715)}]) {
  describe(`sandbox 62: the lockdown's checks with the realm changed around them (${mode})`, function() {
    this.timeout(240000);
    let server = null;
    let base = null;
    // a host file outside every grant, made by the test
    let hostFile = null;
    const HOST_FILE = () => hostFile;
    before(async () => {
      assert.ok(CHANGES.length >= 35, CHANGES.join(', '));
      assert.ok(CHANGES.includes('Array.prototype index setters') && CHANGES.includes('WeakSet.prototype.has/add'), CHANGES.join(', '));
      assert.ok(OUTSIDE_FILES.length >= CHANGES.length, `${OUTSIDE_FILES.length} files for ${CHANGES.length} changes`);
      base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sandbox-62-'));
      hostFile = path.join(base, 'host-file.txt');
      fs.writeFileSync(hostFile, 'a host file\n');
      server = await startServer(port, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', mode,
        '--moduleDataPath', path.join(base, 'store')]);
      const loaded = await post(port, KEY, '/load-module', {path: FIXTURE, name: PROBE});
      assert.strictEqual(loaded.status, 200, JSON.stringify(loaded.body));
    });
    after(() => {
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
          hostFile: HOST_FILE(), realFd: 3};
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
          if (!REQUIRE_OUTSIDE_PENDING) {
            assert.strictEqual(out.runtimeFile.outcome, 'refused', `require of a file outside the root: ${shown}`);
            // (a getter-only href on Object.prototype makes Node's own URL
            // parser throw first, in that realm: refused all the same)
            if (!(change === URL_BREAKING && /only a getter/.test(out.runtimeFile.message))) assert.strictEqual(out.runtimeFile.code, 'MODULE_NOT_FOUND', shown);
          }
          // the file broker
          assert.strictEqual(out.hostFile.outcome, 'refused', `fs.readFileSync of a host file outside every grant: ${shown}`);
          assert.strictEqual(out.realFd.outcome, 'refused', `fs.fstatSync of a real descriptor: ${shown}`);
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
        }
        if (out != null) for (const name of ORIGINALS) assert.ok(!out.handed.includes(name), `the original ${name} was handed to the replaced ${change}: ${shown}`);
        // no port reaches a setter a module put on a prototype
        if (out != null) assert.strictEqual(out.portsSeen, 0, `a port was handed to a setter with ${change} in place: ${shown}`);
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
