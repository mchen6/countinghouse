# Module sandbox part 2, plan 3 of 5 — virtual identity, the loader, and enforce live

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, chosen by the user) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. After each task's commit, send the reviewer session (`countinghouse-0a`) the range from `git log --oneline` output and wait for its approval before the next task. Tell the reviewer before running tests that use ports.

**Goal:** Make module identity virtual (`/app/...` everywhere a module looks), give the loader exactly the original-fs access it needs and nothing more, close the routes around the broker, move countinghouse's own worker-side file reads to the main thread, and then switch `enforce`'s file decisions on — deleting the plan 2 gate and the interim host routing together.

**Architecture:** A new `lib/fs-broker/identity.js` installs `module.registerHooks` resolve/load hooks at `set-options`, after part 1's lockdown, in every mode. Its hooks map virtual specifiers and parents to host paths, let part 1's boundary and Node's resolver work on host paths, bound every resolve (L2), and return `file:///app/...` URLs for the module's files. The patch's interim `hostServed()` is replaced by a grant controller that only `lib/sandbox.js` holds and passes to the identity hook: realpath/stat under the allowed roots during a resolve, reads of the one checked target during its load (L1). The main thread sends `/app` as the load path and the module's device config in the load-module message. Part 1's lockdown learns the other routes (descriptor/handle adoption, report and compile-cache writes, source maps), and `repl`/`trace_events` leave the built-in allowlist.

**Tech Stack:** Node.js >= 22.16 (`module.registerHooks`), mocha.

**Spec:** `docs/superpowers/specs/2026-10-17-module-sandbox-fs-broker-design.md` — section 1 (virtual everywhere a module looks), section 2 ("The loader": B5 identity, L1, L2, the exact-pair guard, no privileged requests; "Other routes to files"), section 4 (modes). Plan series: 1, 2a, 2b (done) · **3 (this)** · 4 quota and data lifecycle · 5 single-thread mode, docs, benchmarks.

## Global Constraints

- Virtual paths in **every** `--moduleSandbox` mode under `--workerThread` (off included): the identity hook, `process.cwd() === '/app'`, `os.tmpdir() === '/tmp'`, and the broker's `cwd: '/app'`. L2's refusals and reports, and the other-routes refusals, follow the mode (`enforce` refuses, `audit` reports, `off` neither).
- Virtual and host are told apart by identity, not spelling (review C2): a parent URL is the module's only if the identity hook issued it; a `/app` specifier means the module's `/app` only from a module parent; countinghouse names module files with `identity.moduleSpecifier('/app/...')` (`countinghouse-module:/...`). Node's caches are keyed by filename, so a worker refuses to load a module when any countinghouse code it has loaded lives under `/app` (`codeUnderVroot`), with advice; the main thread checks the install directory at start-up under `--workerThread` and exits 2 with the same advice.
- Boot grant (review C1): from `patch.install` until `set-options`, realpath/stat and reads under `<installDir>/lib`, `<installDir>/node_modules` and `<installDir>/package.json` are served by the original fs (countinghouse's own boot `require`s; no module code runs in that window). It is released at `set-options`, before the identity hook installs.
- L1 grants are by path, never by time: realpath/stat/exists originals only for paths under the roots the requesting parent may reach, during that resolve; `readFileSync`/`openSync` originals only for the one checked target, during its load. The grant controller is returned by `patch.install()` to `lib/sandbox.js` and passed to `identity.install()`; it is never exported.
- L2 (non-`file:` parents, such as `data:` modules or a missing `parentURL`, count as module parents — review M1): from `set-options` on, a countinghouse parent may reach only `lib/`, `node_modules/` and `package.json` under the install directory, plus the module root; a module parent only the module root. Boot `require`s before `set-options` are unbounded by design.
- The re-entry guard recognises only the hook's own inner call (the exact `(specifier, parentURL)` pair).
- **Task 4 deletes `ENFORCE_FILE_DECISIONS` (and `FsBroker`'s `enforceFileDecisions` option) and `hostServed()` in the same commit**, and runs the collision tests after both are gone (series ledger, from plan 2b's agreement).
- Under `--hardened`, no main-thread or worker path may do an async operation on a grant root itself (Node 24's prefix-grant refusal, plan 2b); L1's grants act on files inside, which is fine.
- Do not run the full `npm test` except in the last task. Kill stray servers by PID. Test trees under `test/.tmp`, or under `os.homedir()` where a path must be outside the repo and outside `/tmp`. Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A module that builds paths from `__dirname` and reads its own files with `fs` — must work in `off`, `audit` and `enforce` (Task 3 test, Task 4 wired tests).
2. A module whose `package.json` says `"type": "module"` — its `.js` files must load as ES modules through the virtual URLs (Task 3 test).
3. A module loaded from `/tmp` with its data under `/tmp` — no collision between virtual and host paths (Task 4 collision tests, after the gate and `hostServed` are gone); countinghouse installed under `/app` (including as `/app/node_modules/countinghouse`) — refused at start-up with advice, never silently mixed (Task 3 unit tests).
4. A getter on `Object.prototype` that runs during a resolve and calls `require('/abs/outside/file')` — must get `MODULE_NOT_FOUND` under `enforce`, never original-fs access (Task 3 test).
5. `module.parent.require`, `require.cache[lib].require`, `Module._load(path, cmModule)`, `Module.prototype.require.call(cmModule, path)` and a `vm.Script` `import()` — none may read a file outside the allowed roots under `enforce` (Task 3 test).

---

### Task 1: Device config from the main thread

**Files:**
- Modify: `lib/device-config.js` (split reading from applying), `lib/module-manager.js` (`spawnModuleWorker` sends `/app` and the config; the worker branch of `loadModuleFromPath` applies it; `deviceonline` keeps the host path), `lib/sandbox.js` (`load-module` passes `msg.deviceConfig`), `lib/fs-broker/index.js` (returns `moduleRoot` and `installDir` instead of `hostRoots`; broker `cwd: '/app'`)
- Test: `test/device-config/02-from-main-thread.js`

**Interfaces:**
- Produces: `device-config.js` → `readDeviceConfig(opts, moduleName, cb(err, config|null))` (main thread, the file read) and `applyDeviceConfig(opts, config)` (the globals); the default export keeps today's behaviour for single-thread mode.
- Produces: load-module message `{path, name, version, deviceConfig: object|null}` (the path becomes `/app` in Task 3, together with the identity hook that makes it loadable); `ModuleManager.prototype.loadModuleFromPath(modulePath, name, version, callback, deviceConfig)` in the worker applies `deviceConfig` instead of reading a file.
- Produces: `createForWorker(...)` → `{broker, bridge, namespace, dirs, moduleRoot, installDir}`.

- [ ] **Step 1: Survey.** Run `grep -n "fs\.\|process.cwd()\|os.tmpdir()" lib/module-manager.js lib/handler-map.js lib/device-config.js lib/countinghouse-util.js lib/countinghouse-device.js lib/device-manager.js lib/handler-ctx.js lib/sandbox.js lib/redis-api.js lib/worker-message.js` and classify every hit that can run in a worker after `set-options`: (a) uses the module's path, which becomes `/app` (fine through the broker), (b) reads a countinghouse or operator file by host path (must move to the main thread), (c) main thread only. Write the table in the ledger. Expected (b): `device-config.js` only. Any other (b) is handled in this task the same way and reported to the reviewer.
  Extend it (reviews I2 and C2): (d) every `path.resolve(` and `fs.*` call in `lib/` that can run in a worker after `set-options` with a possibly relative argument (it now resolves against `/app`); (e) every read by countinghouse or its dependencies of countinghouse's own files by host path after `set-options` (now a broker request, `ENOENT` under `enforce`) — `grep -rn "__dirname" lib` and the dependencies the worker requires after `set-options` (`node -e` the worker's `require.cache` keys at `set-options` against those loaded afterwards); (f) the `node_modules` countinghouse requires in the worker after `set-options` that may resolve relative paths (bunyan, redis, bullmq and others found). Each hit is fixed in this task (moved before `set-options`, made absolute against the install directory and granted, or moved to the main thread) or listed with why it is safe; write "none found" explicitly for an empty class.

- [ ] **Step 2: Write the failing test** — `test/device-config/02-from-main-thread.js`: a server with `--workerThread --moduleSandbox enforce --deviceConfigPath <dir>` where `<dir>/fs-probe.json` holds `{"greeting": "hi"}`, and a fixture handler that returns `global.DeviceConfig`. Add to `test/fixtures/fs-probe` a handler `handlers/probeService/config.js`:

```js
// config.js -- returns the module's device config.
module.exports = async () => ({output: {config: global.DeviceConfig == null ? null : global.DeviceConfig}});
```

with its `api.json` action `config` and `schema.json` entry (`input: {"type": "object"}`, `output: {"type": "object", "properties": {"config": {"type": ["object", "null"]}}}`). The test:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {mkdtemp} = require('../helpers/test-tmp');

describe('device-config 02: config reaches a worker from the main thread', function() {
  this.timeout(90000);
  let server = null;
  let base = null;
  afterEach(() => { stopServer(server); server = null; if (base) fs.rmSync(base, {recursive: true, force: true}); });

  ['off', 'enforce'].forEach((mode) => {
    it(`${mode}: the module sees its config without reading the file itself`, async () => {
      base = mkdtemp('devcfg-');
      fs.writeFileSync(path.join(base, 'fs-probe.json'), JSON.stringify({greeting: 'hi'}));
      server = await startServer(9629, ['--workerThread', '--debug', '--debugKey', 'k', '--moduleSandbox', mode,
        '--deviceConfigPath', base, '--moduleDataPath', path.join(base, 'store'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'fs-probe')]);
      const r = await mcpCall(9629, 'k', 'fs_probe_probeservice_config', {});
      assert.deepStrictEqual(r.structuredContent.output, {config: {greeting: 'hi'}}, JSON.stringify(r));
      assert.ok(!server.output.includes(`file outside ${path.join(base, 'fs-probe.json')}`), 'the worker read the config file itself');
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails** (tell the reviewer first: port 9629)

Run: `npx mocha --exit test/device-config/02-from-main-thread.js`
Expected: FAIL on the "did not read the file itself" assertion (today the worker reads it through the broker, which logs `file outside …` under audit-like `enforce`) — or on the config if the read fails.

- [ ] **Step 4: Implement.**
  - `lib/device-config.js`: move the file read into `readDeviceConfig(opts, moduleName, cb)` and the globals into `applyDeviceConfig(opts, config)`; keep `module.exports = loadDeviceConfigFromFile` (read then apply) and add `module.exports.readDeviceConfig`, `module.exports.applyDeviceConfig`.
  - `lib/module-manager.js` `spawnModuleWorker` (inside `startWorker`, before `sendLoadModuleMessage`): `getDeviceConfig.readDeviceConfig(options, name, (cfgErr, deviceConfig) => { if (cfgErr) LOG.E(new CHError('DEVICE_CONFIG_LOAD_FAIL', cfgErr.message)); workerMessage.sendLoadModuleMessage({path: modulePath, name, version, deviceConfig: deviceConfig || null}, …) })`, and set `workerMessage.hostModulePath = modulePath`.
  - The worker branch of `loadModuleFromPath(modulePath, name, version, callback, deviceConfig)`: when `isMainThread !== true && deviceConfig !== undefined`, call `getDeviceConfig.applyDeviceConfig(options, deviceConfig)` and continue as the existing callback does, instead of `getDeviceConfig(options, name, …)`.
  - `lib/sandbox.js` `load-module`: `mm.loadModuleFromPath(msg.path, msg.name, msg.version, cb, msg.deviceConfig)`.
  - `lib/device-manager.js` `onWorkerLoaded`'s `deviceonline` handler: `wm.modulePath = (wm.hostModulePath != null) ? wm.hostModulePath : msg.data.modulePath;` and use that same value for `deviceIdConflict.conflictingModulePath(...)` — from Task 3 the worker reports `/app`, which would make every module look alike; doing it now keeps Task 3 small.
  - `lib/fs-broker/index.js`: return `moduleRoot` and `installDir: realDir(INSTALL_DIR)` (drop `hostRoots`), broker `cwd: '/app'`; `module-manager.js` passes `workerData: {fsBridge, moduleRoot: fsb.moduleRoot, installDir: fsb.installDir}`; `sandbox.js` keeps passing `hostRoots: [workerData.moduleRoot, workerData.installDir]` to `patch.install` until Task 4 deletes `hostServed`.

- [ ] **Step 5: Run the tests**

Run: `npx mocha --exit test/device-config/*.js test/fs-broker/09-wired.js test/composition/03-declaration.js test/module-loading/06-dual-path-discovery.js`
Expected: all passing (the device-ID conflict and discovery paths still see host module paths).

- [ ] **Step 6: Commit**

```bash
git add lib/device-config.js lib/module-manager.js lib/sandbox.js lib/device-manager.js lib/fs-broker/index.js test/fixtures/fs-probe test/device-config/02-from-main-thread.js
git commit -m "feat(fs-broker): device config from the main thread" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The grant controller replaces nothing yet — add it to the patch

**Files:**
- Modify: `lib/fs-broker/patch.js`
- Test: `test/fs-broker/11-grants.js`, `test/fs-broker/scripts/grants.js`

**Interfaces:**
- Produces: `patch.install(client, settings)` returns `{fs, promises, fileHandle, grant}` where `grant = {originals: {readFileSync}, resolving(roots: string[]) → release(), reading(file: string) → release(), boot(roots: string[]) → release()}`. `boot` grants both the stat keys and the read keys (`readFileSync`, `openSync`) for any path under its roots (review C1); `lib/sandbox.js` calls `grant.boot([<installDir>/lib, <installDir>/node_modules, <installDir>/package.json])` right after `patch.install` and releases it in `set-options` before installing identity. While a `resolving` grant is active, `realpathSync` (and `.native`), `statSync`, `lstatSync` and `existsSync` of an **absolute** path under one of its roots are served by the original fs; while a `reading` grant is active, `readFileSync` and `openSync` of exactly that file are (descriptors from `openSync` tracked as today). Releases remove exactly what they added; grants nest.

- [ ] **Step 1: Write the failing test.** `test/fs-broker/scripts/grants.js`:

```js
// Uses the grant controller the way identity.js does, from inside the worker.
const path = require('path');

module.exports = async (fs, root, ctx) => {
  const grant = ctx.handled.grant;
  const dir = ctx.extra.dir;
  const file = path.join(dir, 'f.txt');
  const out = {};
  const outside = () => { try { return fs.realpathSync(file); } catch (e) { return e.code; } };
  out.before = outside();                       // no grant: the broker answers (outside -> pass-through under audit)
  let release = grant.resolving([dir]);
  out.realpathGranted = fs.realpathSync(file) === file;
  out.readNotGranted = (() => { try { fs.readFileSync(file, 'utf8'); return 'read'; } catch (e) { return e.code; } })();
  release();
  release = grant.reading(file);
  out.readGranted = fs.readFileSync(file, 'utf8');
  out.otherNotGranted = (() => { try { fs.readFileSync(path.join(dir, 'g.txt'), 'utf8'); return 'read'; } catch (e) { return e.code; } })();
  release();
  out.originalsRead = grant.originals.readFileSync(file, 'utf8');
  release = grant.boot([dir]);
  out.bootRead = fs.readFileSync(path.join(dir, 'g.txt'), 'utf8');
  release();
  out.afterBoot = (() => { try { fs.readFileSync(path.join(dir, 'g.txt'), 'utf8'); return 'read'; } catch (e) { return e.code; } })();
  out.grantNotExported = Object.keys(ctx.patch).includes('grant') === false;
  return out;
};
```

`test/fs-broker/11-grants.js` runs it with `runBrokered(S('grants.js'), {mode: 'enforce', extra: {dir}})` against a directory created under `os.homedir()` holding `f.txt` (`'granted'`) and `g.txt`, with a broker whose `enforce` is live for this test (pass `enforceFileDecisions: true` through `runBrokered`'s options; Task 4 removes the option), and asserts: `realpathGranted: true`, `readNotGranted: 'ENOENT'` (a resolve grant does not grant reads), `readGranted: 'granted'`, `otherNotGranted: 'ENOENT'`, `originalsRead: 'granted'`, `bootRead` equal to `g.txt`'s content, `afterBoot: 'ENOENT'`, `grantNotExported: true`. Add `enforceFileDecisions` pass-through to `test/helpers/brokered-worker.js` for now.

- [ ] **Step 2: Run it to verify it fails** — `npx mocha --exit test/fs-broker/11-grants.js` → `ctx.handled.grant` is undefined.

- [ ] **Step 3: Implement** in `lib/fs-broker/patch.js`: a `grants = {roots: [], files: [], bootRoots: []}` state; `granted(key, value)` true when the path argument is an absolute string (or `file:` URL) and either `key` is one of `realpathSync`, `realpath`, `statSync`, `stat`, `lstatSync`, `lstat`, `existsSync`, `exists` and the path is under an active root, or `key` is `readFileSync` or `openSync` and the path is an active file. `boot` pushes its roots to a third list, `grants.bootRoots`, matched for both key sets. In `routed()`, serve with the original when `hostServed(a[i]) || granted(key, a[i])` (Task 4 removes `hostServed`). `lib/sandbox.js`: keep `const fsGrant = …install(...).grant` and `let releaseBoot = fsGrant.boot([...])` (the roots from `workerData.installDir`); `set-options` calls `releaseBoot()` before the identity install (Task 3). Return `grant` from `install()`:

```js
  const grant = {
    originals: Object.freeze({readFileSync: origFs.readFileSync.bind(fs)}),
    resolving(roots) {
      const mine = roots.map(String);
      grants.roots.push(...mine);
      return () => { mine.forEach((r) => { const i = grants.roots.lastIndexOf(r); if (i >= 0) grants.roots.splice(i, 1); }); };
    },
    reading(file) {
      grants.files.push(String(file));
      return () => { const i = grants.files.lastIndexOf(String(file)); if (i >= 0) grants.files.splice(i, 1); };
    },
    boot(roots) {
      const mine = roots.map(String);
      grants.bootRoots.push(...mine);
      return () => { mine.forEach((r) => { const i = grants.bootRoots.lastIndexOf(r); if (i >= 0) grants.bootRoots.splice(i, 1); }); };
    }
  };
  handled.grant = grant;
```

`grant` stays off `module.exports`.

- [ ] **Step 4: Run** `npx mocha --exit test/fs-broker/11-grants.js test/fs-broker/07-patch.js test/fs-broker/08-differential.js` → all passing.

- [ ] **Step 5: Commit**

```bash
git add lib/fs-broker/patch.js lib/sandbox.js test/fs-broker/11-grants.js test/fs-broker/scripts/grants.js test/helpers/brokered-worker.js
git commit -m "feat(fs-broker): path-scoped original-fs grants for the loader (L1)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Virtual identity and the bounded loader

**Files:**
- Create: `lib/fs-broker/identity.js`, `test/fs-broker/12-identity.js`, `test/fixtures/esm-probe/{package.json,api.json,schema.json,handlers/probeService/where.js,lib/helper.js}`
- Modify: `lib/sandbox.js` (install identity at `set-options`, after part 1's lockdown, every mode), `lib/module-lockdown.js` (the reduced `createRequire` and `CHUtil.loadFile` map `/app` to the module root), `test/fixtures/fs-probe/handlers/probeService/` (a `where` action), `test/fs-broker/09-wired.js`

**Interfaces:**
- Consumes: `grant` (Task 2), `workerData.moduleRoot`/`installDir` (Task 1).
- Produces: `require('./fs-broker/identity')` → `{install({moduleRoot, installDir, mode, grant, report}), mapper(moduleRoot, issued: Set), moduleSpecifier(virtualPath), codeUnderVroot(installDir, loadedFiles), VROOT, MODULE_SPECIFIER}`. `install` throws when `codeUnderVroot` finds anything.

- [ ] **Step 1: Write the failing tests.** `fs-probe` gains `handlers/probeService/where.js`:

```js
// where.js -- what a module sees of its own location, and a read built from __dirname.
const path = require('path');
module.exports = async () => {
  let frame;
  try { throw new Error('x'); } catch (e) { frame = e.stack.split('\n')[1].trim(); }
  let own;
  try { own = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).name; } catch (e) { own = String(e.code); }
  return {output: {dirname: __dirname, filename: __filename, cwd: process.cwd(), tmpdir: require('os').tmpdir(),
    resolve: require.resolve('./read'), frame: frame, own: own}};
};
```

(`api.json` action `where`, schema output with those string properties.) An ES-module fixture `test/fixtures/esm-probe` (`package.json` `{"name": "esm-probe", "version": "1.0.0", "type": "module"}`; one action `where` whose handler is an ES module importing `../../lib/helper.js` and returning `import.meta.url`, `import.meta.dirname` and the helper's value, and `dep`, the value of `import dep from 'plain-dep'`). `test/fixtures/esm-probe/node_modules/plain-dep/{package.json,index.js}`: a `package.json` with no `"type"` (`{"name": "plain-dep", "version": "1.0.0", "main": "index.js"}`) and a CommonJS `index.js` (`module.exports = 'plain';`) — it must load as CommonJS inside a `"type": "module"` package (review I1); un-ignore that one directory in `.gitignore` if `node_modules` is ignored. The handler-map loader must accept `export default` (it already does: `loaded.default`).

`test/fs-broker/12-identity.js` (port 9630; tell the reviewer):

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {mkdtemp} = require('../helpers/test-tmp');
const identity = require('../../lib/fs-broker/identity');

describe('fs-broker 12: virtual identity', function() {
  this.timeout(120000);
  let server = null;
  let base = null;
  afterEach(() => { stopServer(server); server = null; if (base) fs.rmSync(base, {recursive: true, force: true}); });

  function start(mode, mod) {
    base = mkdtemp('identity-');
    return startServer(9630, ['--workerThread', '--debug', '--debugKey', 'k', '--moduleSandbox', mode,
      '--moduleDataPath', path.join(base, 'store'), '--loadModule', path.join(ROOT, 'test', 'fixtures', mod)]);
  }

  ['off', 'audit', 'enforce'].forEach((mode) => {
    it(`${mode}: a module sees /app, cwd /app, tmpdir /tmp, and reads its own files via __dirname`, async () => {
      server = await start(mode, 'fs-probe');
      const r = (await mcpCall(9630, 'k', 'fs_probe_probeservice_where', {})).structuredContent.output;
      assert.strictEqual(r.dirname, '/app/handlers/probeService');
      assert.strictEqual(r.filename, '/app/handlers/probeService/where.js');
      assert.strictEqual(r.cwd, '/app');
      assert.strictEqual(r.tmpdir, '/tmp');
      assert.strictEqual(r.resolve, '/app/handlers/probeService/read.js');
      assert.ok(r.frame.includes('/app/handlers/probeService/where.js'), r.frame);
      assert.strictEqual(r.own, 'fs-probe');
    });
  });

  it('an ES-module package loads through virtual URLs', async () => {
    server = await start('enforce', 'esm-probe');
    const r = (await mcpCall(9630, 'k', 'esm_probe_probeservice_where', {})).structuredContent.output;
    assert.strictEqual(r.url, 'file:///app/handlers/probeService/where.js');
    assert.strictEqual(r.dirname, '/app/handlers/probeService');
    assert.strictEqual(r.helper, 'helped');
    assert.strictEqual(r.dep, 'plain');
  });

  it('countinghouse installed at /app: its own parents stay host, issued module parents map to the module', () => {
    const issued = new Set(['file:///app/index.js']);
    const m = identity.mapper('/app/modules/x', issued);
    const ch = m.parent('file:///app/lib/handler-ctx.js');
    assert.deepStrictEqual(ch, {host: '/app/lib/handler-ctx.js', fromModule: false});
    assert.strictEqual(m.specifier('./x', ch), '/app/lib/x.js');
    assert.strictEqual(m.specifier('/app/lib/x.js', ch), '/app/lib/x.js', 'a bare /app from countinghouse is a host path');
    const mod = m.parent('file:///app/index.js');
    assert.deepStrictEqual(mod, {host: '/app/modules/x/index.js', fromModule: true});
    assert.strictEqual(m.specifier('/app/lib/y.js', mod), '/app/modules/x/lib/y.js');
    assert.strictEqual(m.specifier(identity.moduleSpecifier('/app/package.json'), ch), '/app/modules/x/package.json');
    assert.deepStrictEqual(m.parent('data:text/javascript,1'), {host: null, fromModule: true});
    assert.deepStrictEqual(m.parent(undefined), {host: null, fromModule: true});
  });

  it('refuses when countinghouse code is under /app (Node caches are keyed by filename)', () => {
    assert.deepStrictEqual(identity.codeUnderVroot('/opt/ch', ['/opt/ch/lib/a.js']), []);
    assert.deepStrictEqual(identity.codeUnderVroot('/app', []), ['/app']);
    assert.deepStrictEqual(identity.codeUnderVroot('/opt/ch', ['/app/node_modules/countinghouse/lib/a.js']),
      ['/app/node_modules/countinghouse/lib/a.js']);
    assert.deepStrictEqual(identity.codeUnderVroot('/application', []), []);
  });
});
```

Route tests (Review Focus 4 and 5) — a fixture `test/fixtures/route-probe` whose single action `attempt` takes `{what}` and tries one route, returning `{outcome: 'read'|'refused', code}`: `parentRequire` (`module.parent.require(<auth file>)`), `cacheRequire` (`require.cache[Object.keys(require.cache).find((k) => k.includes('/lib/'))].require(<auth file>)`; it returns `{outcome: 'no-key'}` when no such key is visible, and the test asserts it is visible, so the route test cannot pass vacuously — review I3), `moduleLoad` (`module.constructor._load(<auth file>, module.parent)`), `protoRequire` (`module.constructor.prototype.require.call(module.parent, <auth file>)`), `vmImport` (a `vm.Script` with a countinghouse `filename` and `importModuleDynamically` doing `import(<auth file URL>)`), and `getter` (define `Object.prototype.parentURL` as a getter that calls `require(<auth file>)` and records the result, then `require('./read')`). `<auth file>` is a JSON file the test writes under `os.homedir()` (outside every root) and passes via the server's environment (`ROUTE_PROBE_TARGET`, declared in the fixture's `countinghouse.permissions.env`). Add to `12-identity.js`:

```js
  // Two targets (review I3): one outside everything, and one inside the
  // install directory but outside lib/, node_modules/ and package.json,
  // where <installDir>/auth.json lives.
  const targets = {
    home: () => { const d = fs.mkdtempSync(path.join(require('os').homedir(), '.ch-route-')); return {file: path.join(d, 'secret.json'), cleanup: d}; },
    installDir: () => { const f = path.join(ROOT, `.ch-route-secret-${process.pid}.json`); return {file: f, cleanup: f}; }
  };
  ['parentRequire', 'cacheRequire', 'moduleLoad', 'protoRequire', 'vmImport', 'getter'].forEach((what) => Object.keys(targets).forEach((where) => {
    it(`enforce: ${what} cannot read a secret in ${where}`, async () => {
      const t = targets[where]();
      const target = t.cleanup;
      const file = t.file;
      fs.writeFileSync(file, '{"secret": true}');
      try {
        base = mkdtemp('identity-');
        server = await startServer(9630, ['--workerThread', '--debug', '--debugKey', 'k', '--moduleSandbox', 'enforce',
          '--moduleDataPath', path.join(base, 'store'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'route-probe')],
        {env: {ROUTE_PROBE_TARGET: file}});
        const r = (await mcpCall(9630, 'k', 'route_probe_probeservice_attempt', {what})).structuredContent.output;
        assert.strictEqual(r.outcome, 'refused', JSON.stringify(r));
      } finally {
        fs.rmSync(target, {recursive: true, force: true});
      }
    });
  }));
```

(Until Task 4 removes the gate, a refusal comes from L2 — the resolve is bounded — not from the broker; that is what these tests pin.)

- [ ] **Step 2: Run them to verify they fail** (tell the reviewer first) — `npx mocha --exit test/fs-broker/12-identity.js`: the identity assertions fail (host paths), the ES-module test fails, the route tests read the file.

- [ ] **Step 3: Implement** — `lib/fs-broker/identity.js` (the whole file, as revised after review: C2 identity, I1 nearest package.json, M1, M2, the `/app` code refusal):

```js
// Module identity in a module worker (docs/superpowers/specs/2026-10-17-
// module-sandbox-fs-broker-design.md, section 2, "The loader"): the module's
// files are loaded as file:///app/... URLs, so __filename, __dirname,
// require.resolve, module.paths, require.cache keys, import.meta and stack
// frames are virtual by construction, and every resolve is bounded (L2).
// Installed at set-options, after part 1's lockdown, in every mode, so its
// hooks run first: it maps virtual specifiers and parents to host paths,
// lets the next hooks (part 1's boundary, Node's resolver) work on host
// paths, and maps the result back.
//
// Virtual and host paths are told apart by identity, not by spelling
// (review C2): a parent URL is virtual only if this hook issued it, a "/app"
// specifier means the module's /app only from module code, and countinghouse
// names module files with MODULE_SPECIFIER ("countinghouse-module:/...").
// That settles which file a resolve means. It cannot settle Node's caches:
// require.cache and the ESM module map are keyed by filename and URL, so a
// module file issued as /app/lib/x.js and a countinghouse file at host
// /app/lib/x.js would share one entry, and the module would be handed
// countinghouse's own module object. So install() refuses when any code
// already loaded in this worker lives under /app (codeUnderVroot).
//
// The loader calls the public fs (realpathSync, readFileSync) at call time;
// those calls are served by the original fs only for paths the patch grants
// (L1): realpath/stat under the roots this parent may reach, during this
// resolve; reads of the one checked target, during its load. Everything else
// goes to the broker with the module's rights.
const Module = require('module');
const path = require('path');
const url = require('url');

const VROOT = '/app';
const MODULE_SPECIFIER = 'countinghouse-module:';

function inside(p, root) {
  return p === root || p.startsWith(`${root}/`);
}

// Pure path and URL arithmetic, exported for the collision tests.
// issued: the virtual URLs this hook has returned for module files.
function mapper(moduleRoot, issued) {
  const m = {
    isVirtual: (p) => inside(p, VROOT),
    toHost: (v) => moduleRoot + v.slice(VROOT.length),
    toVirtual: (h) => VROOT + h.slice(moduleRoot.length),
    isModuleHost: (h) => inside(h, moduleRoot),
    // A parent URL is the module's only if this hook issued it.
    parent(parentURL) {
      if (typeof(parentURL) !== 'string') return {host: null, fromModule: true};
      if (issued.has(parentURL)) return {host: m.toHost(url.fileURLToPath(parentURL)), fromModule: true};
      if (!parentURL.startsWith('file:')) return {host: null, fromModule: true};   // data: and the like are module code (review M1)
      const host = url.fileURLToPath(parentURL);
      return {host: host, fromModule: m.isModuleHost(host)};
    },
    // What a specifier names, given its parent.
    specifier(s, parent) {
      if (s.startsWith(MODULE_SPECIFIER)) return m.toHost(VROOT + s.slice(MODULE_SPECIFIER.length));
      let t = s.startsWith('file:') ? url.fileURLToPath(s) : s;
      if (parent.fromModule && m.isVirtual(t)) return m.toHost(t);
      if (parent.host != null && (t === '.' || t === '..' || t.startsWith('./') || t.startsWith('../'))) t = path.resolve(path.dirname(parent.host), t);
      return t;
    }
  };
  return m;
}

function notFound(specifier) {
  const err = new Error(`Cannot find module '${specifier}' (countinghouse module sandbox)`);
  err.code = 'MODULE_NOT_FOUND';
  return err;
}

// The loaded files (require.cache keys) that live under /app, plus the
// install directory itself if it does.
function codeUnderVroot(installDir, loadedFiles) {
  return [installDir].concat(loadedFiles).filter((f) => typeof(f) === 'string' && inside(f, VROOT));
}

function install(cfg) {
  const clash = codeUnderVroot(cfg.installDir, Object.keys(require.cache));
  if (clash.length > 0) {
    throw new Error(`countinghouse's own code is under ${VROOT} (${clash[0]}), where module workers show each module its ` +
      `own files; install countinghouse elsewhere (for example /opt/countinghouse) or run with --no-workerThread`);
  }
  const moduleRoot = cfg.moduleRoot;
  const issued = new Set();
  const m = mapper(moduleRoot, issued);
  const grant = cfg.grant;
  const originals = grant.originals;
  const enforce = (cfg.mode === 'enforce');
  const reportL2 = (cfg.mode === 'audit' || enforce) ? cfg.report : () => {};
  const countinghouseRoots = ['lib', 'node_modules', 'package.json'].map((p) => path.join(cfg.installDir, p));
  const typeCache = new Map();
  let inner = null;   // the exact (specifier, parentURL) of this hook's own createRequire().resolve

  // L2: from set-options on, every resolve is bounded, whoever the parent is.
  function bound(hostPath, fromModule, specifier) {
    if (m.isModuleHost(hostPath)) return;
    if (!fromModule && countinghouseRoots.some((r) => inside(hostPath, r))) return;
    reportL2('require', String(specifier).slice(0, 200));
    if (enforce) throw notFound(String(specifier).slice(0, 200));
  }

  // "type" from the nearest package.json, as Node decides it: the first one
  // found going up wins, and one without "type" means commonjs (review I1).
  function packageType(hostFile) {
    for (let dir = path.dirname(hostFile); inside(dir, moduleRoot); dir = path.dirname(dir)) {
      if (typeCache.has(dir)) return typeCache.get(dir);
      let raw = null;
      try { raw = originals.readFileSync(path.join(dir, 'package.json'), 'utf8'); } catch (e) { raw = null; }
      if (raw != null) {
        let type = 'commonjs';
        try { type = JSON.parse(raw).type === 'module' ? 'module' : 'commonjs'; } catch (e) { type = 'commonjs'; }
        typeCache.set(dir, type);
        return type;
      }
      if (dir === moduleRoot || dir === path.dirname(dir)) break;
    }
    return 'commonjs';
  }

  function formatOf(hostFile) {
    const ext = path.extname(hostFile);
    if (ext === '.json') return 'json';
    if (ext === '.mjs') return 'module';
    if (ext === '.cjs') return 'commonjs';
    return packageType(hostFile) === 'module' ? 'module' : 'commonjs';
  }

  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (inner != null && inner.specifier === specifier && inner.parentURL === context.parentURL) return nextResolve(specifier, context);
      if (Module.isBuiltin(specifier)) return nextResolve(specifier, context);
      const parent = m.parent(context.parentURL);
      const hostParent = parent.host;
      const fromModule = parent.fromModule;
      const s = m.specifier(specifier, parent);
      const roots = fromModule ? [moduleRoot] : [moduleRoot].concat(countinghouseRoots);
      let hostResolved = null;
      let format;
      const release = grant.resolving(roots);
      try {
        if (fromModule && hostParent != null && Array.isArray(context.conditions) && context.conditions.includes('require')) {
          // require.resolve(s, {paths}) is resolved against the parent here;
          // its paths option is not honoured (review M2, documented).
          // Node's CommonJS resolver works from the parent Module object, whose
          // filename is virtual, so module-parent CommonJS requests are
          // resolved here against the host parent.
          inner = {specifier: s, parentURL: url.pathToFileURL(hostParent).href};
          try { hostResolved = Module.createRequire(hostParent).resolve(s); } finally { inner = null; }
          if (Module.isBuiltin(hostResolved)) return nextResolve(hostResolved, context);
        } else {
          const r = nextResolve(path.isAbsolute(s) ? url.pathToFileURL(s).href : s,
            Object.assign({}, context, {parentURL: hostParent != null ? url.pathToFileURL(hostParent).href : context.parentURL}));
          if (typeof(r.url) !== 'string' || !r.url.startsWith('file:')) return r;
          hostResolved = url.fileURLToPath(r.url);
          format = r.format;
        }
      } finally {
        release();
      }
      bound(hostResolved, fromModule, specifier);
      // Native addons keep their host URL: Node loads them from disk itself
      // (part 1 refuses them under enforce and reports them under audit).
      if (m.isModuleHost(hostResolved) && path.extname(hostResolved) !== '.node') {
        const virtual = url.pathToFileURL(m.toVirtual(hostResolved)).href;
        issued.add(virtual);
        return {url: virtual, format: format, shortCircuit: true};
      }
      return {url: url.pathToFileURL(hostResolved).href, format: format, shortCircuit: true};
    },
    load(hookUrl, context, nextLoad) {
      if (typeof(hookUrl) === 'string' && hookUrl.startsWith('file:')) {
        const p = url.fileURLToPath(hookUrl);
        if (issued.has(hookUrl)) {
          const host = m.toHost(p);
          const format = formatOf(host);
          const source = originals.readFileSync(host, format === 'commonjs' ? undefined : 'utf8');
          return {format: format, source: source, shortCircuit: true};
        }
        const release = grant.reading(p);
        try { return nextLoad(hookUrl, context); } finally { release(); }
      }
      return nextLoad(hookUrl, context);
    }
  });

  // The module's view of its process: the current directory is /app and the
  // temp directory is /tmp (spec section 1). Workers cannot chdir.
  const os = require('os');
  Object.defineProperty(process, 'cwd', {value: () => VROOT, writable: false, configurable: false});
  Object.defineProperty(os, 'tmpdir', {value: () => '/tmp', writable: false, configurable: false, enumerable: true});
}

// How countinghouse's own worker code names a module file (module-manager,
// handler-map): never a bare "/app", which from countinghouse code is a host path.
function moduleSpecifier(virtualPath) {
  return MODULE_SPECIFIER + String(virtualPath).slice(VROOT.length);
}

module.exports = {install, mapper, moduleSpecifier, codeUnderVroot, VROOT, MODULE_SPECIFIER};
```

  - `lib/sandbox.js`: keep the grant controller from `patch.install` in a module-local `const`; in `set-options`, after part 1's lockdown block, when `fsWorkerData.fsBridge != null`:
    ```js
    // Virtual module identity and the bounded loader (part 2, plan 3), in
    // every mode, after part 1's hooks so this hook runs first.
    require('./fs-broker/identity').install({moduleRoot: fsWorkerData.moduleRoot, installDir: fsWorkerData.installDir,
      mode: options.moduleSandbox, grant: fsGrant, report: (rule, target) => wm.sendSandboxViolationToParent(rule, target)});
    ```
  - `lib/module-lockdown.js`: in the reduced `createRequire` and in the `CHUtil.loadFile` lock, map a path under `/app` to the module root before the `inside()` check (`const host = (p === '/app' || p.startsWith('/app/')) ? root + p.slice(4) : p;`).
  - `lib/module-manager.js`: the load-module message's `path` becomes `'/app'`. The worker's countinghouse code reads `/app/package.json` and `/app/handlers` through the broker (fs is virtual-only there, so no ambiguity), and requires module files only through `identity.moduleSpecifier(...)` — in `instantiateModule` and `lib/handler-map.js`'s handler `require`s/`import()`s — never a bare `/app` path (review C2). No privileged request (review A4).
  - `lib/sandbox.js` `set-options`: `releaseBoot()` before `identity.install(...)`; an `install` throw (code under `/app`) fails the module load with its message.
  - `framework.js`: under `--workerThread`, if `identity.codeUnderVroot(realDir(INSTALL_DIR), [])` is non-empty, print the same advice and exit 2. The worker's `install()` receives `installDir` as the real path too (`workerData.installDir = realDir(INSTALL_DIR)`), so an install reached through a symlink into `/app`, or one checked while the cache is still empty, is caught (reviewer). Spec decision 12 (user, 2026-10-17).
  - Ledger: `require.resolve(s, {paths})` from module code ignores `paths` (review M2); recorded for plan 5's docs.

- [ ] **Step 4: Run the tests** — `npx mocha --exit test/fs-broker/12-identity.js test/sandbox/05-lockdown.js test/fs-broker/09-wired.js` → all passing. A route test that still reads the file is a real gap: stop and send it to the reviewer with the route and the path it took.

- [ ] **Step 5: Commit**

```bash
git add framework.js lib/fs-broker/identity.js lib/sandbox.js lib/module-lockdown.js lib/module-manager.js lib/handler-map.js test/fs-broker/12-identity.js test/fixtures/fs-probe test/fixtures/esm-probe test/fixtures/route-probe
git commit -m "feat(fs-broker): virtual module identity and a bounded loader (L1, L2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Enforce live — delete the gate and the interim host routing together

**Files:**
- Modify: `lib/fs-broker/broker.js` (delete `ENFORCE_FILE_DECISIONS` and the `enforceFileDecisions` option), `lib/fs-broker/patch.js` (delete `hostServed`, `hostRoots`, `globHost`), `lib/sandbox.js` (stop passing `hostRoots`), `test/fs-broker/03-broker.js`, `05-broker-2b.js`, `07-patch.js` (drop the K1 test and `scripts/k1.js`), `11-grants.js`, `test/helpers/brokered-worker.js` (drop `hostRoots` and `enforceFileDecisions`), `test/fs-broker/09-wired.js` (the gate test becomes an enforce test)
- Create: `test/fs-broker/13-collisions.js`

- [ ] **Step 1: Write the failing tests.** In `09-wired.js`, replace "enforce behaves as audit for files until plan 3 (the gate)" with:

```js
  it('enforce refuses a path outside the namespace (ENOENT) and logs it', async () => {
    server = await start('enforce');
    const outside = outsidePath();
    const w = await mcpCall(9626, KEY, tool('write'), {path: outside, content: 'o'});
    assert.deepStrictEqual(w.structuredContent.output, {ok: false, code: 'ENOENT'}, JSON.stringify(w));
    assert.strictEqual(fs.existsSync(outside), false);
    await waitFor(async () => server.output.includes(`module sandbox: fs-probe file outside ${outside}`), 5000, 'outside log line');
  });
```

and `test/fs-broker/13-collisions.js` (port 9631), run only after the deletions:

```js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');

describe('fs-broker 13: virtual and host paths do not collide', function() {
  this.timeout(120000);
  let server = null;
  const made = [];
  afterEach(() => { stopServer(server); server = null; made.splice(0).forEach((d) => fs.rmSync(d, {recursive: true, force: true})); });
  const tmp = (p) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };

  ['off', 'audit', 'enforce'].forEach((mode) => {
    it(`${mode}: a module installed under /tmp with its data under /tmp sees /app and its own private /tmp`, async () => {
      const mod = path.join(tmp('ch-col-mod-'), 'fs-probe');
      fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'fs-probe'), mod, {recursive: true});
      const store = tmp('ch-col-store-');
      server = await startServer(9631, ['--workerThread', '--debug', '--debugKey', 'k', '--moduleSandbox', mode,
        '--moduleDataPath', store, '--loadModule', mod]);
      const where = (await mcpCall(9631, 'k', 'fs_probe_probeservice_where', {})).structuredContent.output;
      assert.strictEqual(where.dirname, '/app/handlers/probeService');
      assert.strictEqual(where.own, 'fs-probe');
      await mcpCall(9631, 'k', 'fs_probe_probeservice_write', {path: '/tmp/t', content: 'mine'});
      assert.strictEqual(fs.readFileSync(path.join(store, 'fs-probe', 'tmp', 't'), 'utf8'), 'mine');
      const hostTmpPath = path.join(path.dirname(mod), 'fs-probe', 'package.json');
      const r = (await mcpCall(9631, 'k', 'fs_probe_probeservice_read', {path: hostTmpPath})).structuredContent.output;
      assert.strictEqual(r.code, 'ENOENT', 'a host path under /tmp is the module\'s own /tmp, not the host\'s');
    });
  });
});
```

(Countinghouse installed at `/app` cannot be created on a test machine without root. It is refused, not supported, because Node's module caches are keyed by filename; Task 3's mapper and `codeUnderVroot` unit tests cover the identity rule and the refusal. Ledger exactly that.)

Two more tests in `test/fs-broker/11-grants.js`, under live `enforce`:
- **Plain boot (review C1):** a worker boots and loads `fs-probe` under `--moduleSandbox enforce` with no `outside` lines for countinghouse's own files — `09-wired.js`'s enforce test above starts such a server; add `assert.ok(!server.output.includes(`file outside ${ROOT}`))` to it.
- **ESM dependency of a countinghouse parent (review I4):** `test/fs-broker/scripts/esm-dep.js` builds, under `test/.tmp`, a fake install directory `ch/` with `lib/parent.js` (`module.exports = () => import('esm-dep').then((m) => m.default);`) and `node_modules/esm-dep/{package.json ("type": "module", "exports": "./index.js"), index.js (export default 'esm-ok')}`, a module root `mod/`, calls `grant.boot` then releases it, installs identity with `{installDir: ch, moduleRoot: mod, mode: 'enforce'}`, and returns `await require(ch + '/lib/parent.js')()`. Expected `'esm-ok'` — the ESM loader's `openSync` → `readSync` of the target under `grant.reading`.

- [ ] **Step 2: Run them to verify they fail** (tell the reviewer first) — the enforce test writes the file (the gate), and the collision test's last assertion reads the host file (interim routing serves the module's own install directory by host path). After Step 3's deletions, run `09-wired.js` again before anything else and check deliberately that the plain worker boot under `enforce` works (the boot grant replaces `hostServed` for countinghouse's own boot requires — review C1).

- [ ] **Step 3: Implement — one commit for both deletions.**
  - `broker.js`: delete `ENFORCE_FILE_DECISIONS` and its comment; `this.enforce = (opts.mode === 'enforce');`.
  - `patch.js`: delete `hostRoots`, `hostServed()`, `globHost` and the K1 comment; in `routed()`, serve with the original only when `granted(key, a[i])` (paths) or the descriptor came from the original fs; `glob`/`globSync`/`fsp.glob` always use the brokered implementation.
  - `sandbox.js`: `patch.install(client)` without `hostRoots`.
  - Tests: drop every `enforceFileDecisions` option (03, 05, 11, the harness); delete the "plan 3 gate" test in 03; delete the K1 test in 07 and `scripts/k1.js`; drop `hostRoots` from the harness.
  - `grep -rn "ENFORCE_FILE_DECISIONS\|enforceFileDecisions\|hostServed\|hostRoots" lib test` must print nothing.
- [ ] **Step 3b: Tighten the getter route (Task 3 ruling).** In `12-identity.js`, delete the Task 3 exception that accepts a getter `read` when the broker logged it: every route, the getter included, must now be strictly `refused`.
- [ ] **Step 3c: countinghouse's own reads are not the module's (reviewer, Task 3 finding 3).** Worker boot logs `file outside` in the module's name for `/proc/self/exe`, `node_modules/msgpackr-extract/build/{Release,Debug}` and `<node>/bin/prebuilds` (node-gyp-build probing for msgpackr-extract's optional addon). First find when the probe runs (before or after `set-options`; log the stack once from the broker's report hook in a throwaway run). If during boot: add the calls it makes (`readdirSync` and whatever else) to the boot grant's keys for the boot roots, and report paths outside them as countinghouse's own, once, not as module violations. If lazily after `set-options` from countinghouse code: preload that code during boot so it falls in the boot window. Add to the plain-boot test: a fresh worker under `audit` loading `fs-probe`, with no tool call, logs no `module sandbox: fs-probe file outside` line.
- [ ] **Step 4: The `--hardened` check.** Run `npx mocha --exit test/sandbox/09-hardened.js` (the `/data` case uses the prefix layout `<repo>_data-<pid>`) and add one case to it that restarts the module under `--hardened` (`POST /restart-module {name: 'fs-probe'}`) and reads `/data/x` again — load, restart and file I/O together exercise every main-thread and worker path; L1's grants act on files inside the roots, never on a root itself.
- [ ] **Step 5: Run the tests** — `npx mocha --exit test/fs-broker/*.js test/sandbox/*.js` → all passing.
- [ ] **Step 6: Commit**

```bash
git add -A lib/fs-broker/broker.js lib/fs-broker/patch.js lib/sandbox.js test/fs-broker test/helpers/brokered-worker.js test/sandbox/09-hardened.js
git commit -m "feat(fs-broker)!: enforce's file decisions are live; the interim host routing is gone" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The other routes to files and descriptors

**Files:**
- Modify: `lib/module-lockdown.js`, `lib/fs-broker/patch.js` (`process.loadEnvFile` brokered)
- Test: `test/sandbox/05-lockdown.js` (new routes), `test/fixtures/sandbox-probe/handlers/probeService/attempt.js`

**Interfaces:**
- Produces: in audit and enforce (part 1's lockdown): `module.enableCompileCache`, `process.report.writeReport` and the `process.report.directory`/`filename` setters, and `process.setSourceMapsEnabled` locked (`violate('report'|'compile-cache'|'source-maps', …)`); the `fd`/`handle` options refused under `enforce` and reported under `audit` for `new net.Socket({fd|handle})`, `net.Server.prototype.listen({fd|handle} | handle)` (covers `http`, `https`, `http2` servers), `new tls.TLSSocket(...)` wrapping such a socket (covered by the socket check), `tty.ReadStream`/`tty.WriteStream(fd)`, and `dgram` `socket.bind({fd})`; `repl` and `trace_events` removed from `ALLOWED_BUILTINS` (and added to 05's REFUSED list). In every mode: `process.loadEnvFile(path)` reads through the broker (`readFileSync`) and applies `util.parseEnv`.

- [ ] **Step 1: Write the failing tests.** Add attempts to `sandbox-probe`'s `attempt.js`: `listenFd` (`require('net').createServer().listen({fd: 999999})`), `socketFd` (`new (require('net').Socket)({fd: 999999})`), `socketHandle` (`new (require('net').Socket)({handle: {}})`), `ttyFd` (`new (require('tty').WriteStream)(999999)`), `dgramFd` (`require('dgram').createSocket('udp4').bind({fd: 999999})`), `report` (`process.report.writeReport('/app/r.json')`), `compileCache` (`require('module').enableCompileCache('/tmp/cc')` — under enforce the reduced `module` has no `enableCompileCache`, so test via `module.constructor.enableCompileCache`), `sourceMaps` (`process.setSourceMapsEnabled(true)`), `repl` (`require('repl')`), `traceEvents` (`require('trace_events')`). Append them to 05's `ROUTES`. In an "every mode" check, `loadEnvFile`: the probe writes `/data/.env` with `PROBE_ENV=1` and calls `process.loadEnvFile('/data/.env')`, returning `process.env.PROBE_ENV`.
- [ ] **Step 2: Run** `npx mocha --exit test/sandbox/05-lockdown.js` (tell the reviewer) → the new enforce routes are not blocked.
- [ ] **Step 3: Implement** in `lib/module-lockdown.js` (after the OpenSSL engine locks), with comments naming the spike that showed adoption works; `patch.js` gains `process.loadEnvFile` (locked) built on the brokered `readFileSync` and `require('util').parseEnv`. Then sweep the remaining allowlisted built-ins for other file or descriptor access (`grep -n "fd\b\|\.fd\|handle\|path:" node_modules/@types/node/*.d.ts` is a starting list; read each allowlisted module's public API in the Node 24 docs), and write the result in the ledger: what else was found and how it is treated, or "nothing further".
- [ ] **Step 4: Run** `npx mocha --exit test/sandbox/05-lockdown.js test/fs-broker/07-patch.js` → all passing.
- [ ] **Step 5: Commit**

```bash
git add lib/module-lockdown.js lib/fs-broker/patch.js test/sandbox/05-lockdown.js test/fixtures/sandbox-probe
git commit -m "feat(sandbox): refuse descriptor and handle adoption, report and compile-cache writes, source maps; broker loadEnvFile" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The example, the CHANGELOG, the full suite

- [ ] **Step 1: The log-triage example under `enforce`.** `log-read` reads directories outside its own root by design; a declaration cannot name the repo's `sample-logs` (inside countinghouse's install directory, a protected path). Add to `examples/log-triage/README.md` a short section "Under `--moduleSandbox enforce`": generate the logs outside the install directory, declare that directory in `log-read/package.json` (`countinghouse.permissions.fs: [{"path": "/var/log/myapp", "access": "r"}]`), and approve it in `--modulePolicy`. Do not change `log-read/package.json` itself: its paths are site-specific. Ledger the reviewer-agreed deviation from "declare log-read's path".
- [ ] **Step 2: CHANGELOG.** In `### Added — module sandbox, part 2 (in progress)`: replace "The file checks are not enforced yet; until they are, `enforce` behaves like `audit` for files." with "Under `enforce`, paths outside the namespace are `ENOENT`, `/app` and read-only declared paths are `EROFS`, and the link rules apply in every mode. A module sees `/app` as its own directory everywhere: `__dirname`, `__filename`, `require.resolve`, stack traces, `process.cwd()` (`/app`) and `os.tmpdir()` (`/tmp`)." and add: "The loader and countinghouse's own worker code can no longer reach files outside the module's root and countinghouse's code (`module.parent.require` and similar routes are bounded); descriptor and handle adoption (`listen({fd})`, `new net.Socket({fd})` and the like) is refused under `enforce`." Under the 8.0.0 `Changed` section: "A module's device config (`--deviceConfigPath`) is read by the main thread and handed to the worker." And in the upgrade notes: "Under `--workerThread`, countinghouse refuses to start when its real install path is under `/app` (modules see their own files there, and Node keys loaded code by path): install it elsewhere, for example `/opt/countinghouse`, or run with `--no-workerThread`." (spec decision 12)
- [ ] **Step 3:** Tell the reviewer, then run the full suite: `npm test > .superpowers/part2-plan3-suite.log 2>&1; echo "exit=$?" >> .superpowers/part2-plan3-suite.log`. Expected `exit=0`; a failure goes to the reviewer with output and diagnosis before any fix.
- [ ] **Step 4:** Commit the README and CHANGELOG, send the reviewer the range and the result, and write plan 4.
