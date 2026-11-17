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
const CHANGES = Object.keys((() => {
  const src = fs.readFileSync(path.join(FIXTURE, 'handlers', 'probeService', 'probe.js'), 'utf8');
  const block = src.slice(src.indexOf('const CHANGES = {'), src.indexOf('};', src.indexOf('const CHANGES = {')));
  return Object.fromEntries([...block.matchAll(/^ {2}'([^']+)':/gm)].map((m) => [m[1], 1]));
})());
const BLOCKED = Module.builtinModules.filter((b) => !b.startsWith('internal/') && !ALLOWED_BUILTIN_IDS.includes(b.replace(/^node:/, '')));
// files outside the module's root, distinct for each change (each
// reported once under audit) and harmless to load: other fixtures' api.json
const OUTSIDE_FILES = fs.readdirSync(path.join(ROOT, 'test', 'fixtures'))
  .map((d) => path.join(ROOT, 'test', 'fixtures', d, 'api.json'))
  .filter((f) => !f.startsWith(`${FIXTURE}${path.sep}`) && fs.existsSync(f)).sort();
// the originals the guards wrap, by name: none may be handed to a replaced
// call, apply or Reflect method
const ORIGINALS = ['loadFile', 'request', 'getBuiltinModule', 'createRequire', 'dlopen', 'binding'];

for (const {mode, port} of [{mode: 'enforce', port: testPort(9714)}, {mode: 'audit', port: testPort(9715)}]) {
  describe(`sandbox 62: the lockdown's checks with the realm changed around them (${mode})`, function() {
    this.timeout(240000);
    let server = null;
    let base = null;
    before(async () => {
      assert.ok(CHANGES.length >= 20, CHANGES.join(', '));
      assert.ok(OUTSIDE_FILES.length >= CHANGES.length, `${OUTSIDE_FILES.length} files for ${CHANGES.length} changes`);
      base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sandbox-62-'));
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
        const mark = server.output.length;
        const input = {change, builtins: mode === 'enforce' ? BLOCKED : (i < BLOCKED.length ? [BLOCKED[i]] : []),
          runtimeFile: OUTSIDE_FILES[i], outsidePath: path.join(os.tmpdir(), `ch-sandbox-62-outside-${i}.txt`), port: 9 + i};
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
        if (out != null) assert.strictEqual(out.undone, true, JSON.stringify(out));
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
          assert.deepStrictEqual(out.host, {outcome: 'refused', code: 'ERR_ACCESS_DENIED'}, `an ungranted host: ${shown}`);
        } else {
          // reported, whatever the call did (audit allows)
          const log = () => server.output.slice(mark);
          const seen = async (re, what) => {
            const until = Date.now() + 5000;
            while (!re.test(log()) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
            assert.match(log(), re, `${what} reported with ${change} replaced`);
          };
          const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (i < BLOCKED.length) await seen(new RegExp(`${PROBE} violation builtin ${esc(BLOCKED[i].replace(/^node:/, ''))} `), `the built-in ${BLOCKED[i]}`);
          await seen(new RegExp(`${PROBE} violation loadFile ${esc(input.outsidePath)}`), 'CHUtil.loadFile outside the root');
          await seen(new RegExp(`${PROBE} violation net 127\\.0\\.0\\.1:${input.port}\\b`), 'an ungranted host');
        }
        if (out != null) for (const name of ORIGINALS) assert.ok(!out.handed.includes(name), `the original ${name} was handed to the replaced ${change}: ${shown}`);
      });
    });
  });
}
