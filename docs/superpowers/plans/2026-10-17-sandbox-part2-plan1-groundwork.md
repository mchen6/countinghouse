# Module sandbox part 2, plan 1 of 5 — 8.0.0 groundwork

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, chosen pending the user's confirmation) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. After each task's commit, send the commit range to the reviewer session (`countinghouse-0a`) and wait for its approval before starting the next task.

**Goal:** Put the 8.0.0 platform changes in place — Node >= 22.16, `--workerThread` as the default, the test suite pinned to explicit thread modes, and refusal of a load whose request name differs from its package.json name — so plans 2 to 5 build on the new defaults.

**Architecture:** No new subsystem. Startup gets a Node version check and loses part 1's feature-detection fallback; option parsing flips the `workerThread` default and its callers that relied on the old default say what they mean; module loading compares the request name with package.json before anything else.

**Tech Stack:** Node.js >= 22.16, mocha, minimist (option parsing), the existing `lib/` modules.

**Spec:** `docs/superpowers/specs/2026-10-17-module-sandbox-fs-broker-design.md` (sections "Decisions" 8 and 10, section 1's name paragraph, section 5 items 1–3). Part 1's spec is `docs/superpowers/specs/2026-10-15-module-sandbox-foundation-design.md`.

**Plan series:** 1 groundwork (this) · 2 bridge and broker · 3 virtual identity and the loader · 4 quota and data lifecycle · 5 single-thread mode, docs, benchmarks. Each is written after the previous one lands.

## Global Constraints

- Node floor: `>= 22.16` (`package.json` engines, CI, startup check). Exact message on an older Node: `countinghouse 8 needs Node 22.16 or later (this is <process.version>)`, exit code 2.
- `--workerThread` default: on. `--no-workerThread`, `--workerThread false` and `--workerThread=false` turn it off.
- Error code `MODULE_NAME_MISMATCH`, refused in every mode (`off` included) and in single-thread mode.
- Keep `docs/` and code comments in English; small commits, one task per commit; `npm run lint` clean (the pre-commit hook runs it).
- Do not run the full `npm test` until the final task: it takes about 35 minutes on this 1-CPU VM. Run single files (`npx mocha --exit <file>`). Tell the reviewer before running anything that uses ports 9604–9623.
- Kill stray servers by PID, never with `pkill -f`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A test file that starts a server with neither `--workerThread` nor `--no-workerThread` silently changes meaning when the default flips — after Task 2 there must be none (Task 2's checker).
2. `--workerThread false` typed by an operator must mean off, not on (Task 3, unit test).
3. The worker thread and `bin/countinghouse-validate.js` call `setOptions` with no thread flag; after the flip they must still behave as single-threaded internally (Task 3, explicit `{workerThread: false}` plus the composition and validate tests).
4. A registry entry whose stored name differs from its package.json name must fail with `MODULE_NAME_MISMATCH` at startup, not hang `allmodulediscovered` (Task 4, test).
5. Running on Node 20 must fail fast with the exact message, before the logger or any worker starts (Task 1, test with a stubbed version).

---

### Task 1: Node 22.16 floor

**Files:**
- Create: `lib/node-version.js`
- Create: `test/sandbox/10-node-version.js` (replaces `test/sandbox/10-node-support.js`)
- Delete: `lib/sandbox-support.js`, `test/sandbox/10-node-support.js`
- Modify: `framework.js:14-60`, `lib/cli-options.js:120-135`, `package.json:24-26`, `.github/workflows/ci.yml:39,158`, `bin/countinghouse:9-20`, `CLAUDE.md:36`, `docs/security-model.md` (the "needs Node 22.16" sentences), `docs/cli-and-api-reference.md` (the `--moduleSandbox` and `--hardened` rows), `CHANGELOG.md`

**Interfaces:**
- Produces: `require('./lib/node-version')` → `{MIN: '22.16.0', supported(version: string): boolean, message(version: string): string}`.

- [ ] **Step 1: Write the failing test** — `test/sandbox/10-node-version.js`:

```js
// countinghouse 8 needs Node 22.16 (module.registerHooks, Worker
// getHeapStatistics, --permission). Older Node fails fast at startup.
const assert = require('assert');
const nodeVersion = require('../../lib/node-version');

describe('sandbox 10: Node version floor', () => {
  it('accepts 22.16.0 and later', () => {
    ['v22.16.0', 'v22.20.1', 'v23.0.0', 'v24.21.0'].forEach((v) => assert.strictEqual(nodeVersion.supported(v), true, v));
  });

  it('refuses anything older', () => {
    ['v20.20.2', 'v22.0.0', 'v22.15.9', 'v18.0.0'].forEach((v) => assert.strictEqual(nodeVersion.supported(v), false, v));
  });

  it('says what it needs and what it got', () => {
    assert.strictEqual(nodeVersion.message('v20.20.2'), 'countinghouse 8 needs Node 22.16 or later (this is v20.20.2)');
  });

  it('accepts the Node running this test', () => {
    assert.strictEqual(nodeVersion.supported(process.version), true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx mocha test/sandbox/10-node-version.js`
Expected: FAIL, `Cannot find module '../../lib/node-version'`.

- [ ] **Step 3: Implement** — `lib/node-version.js`:

```js
// countinghouse 8 needs Node 22.16: module.registerHooks and Worker
// getHeapStatistics (the module sandbox) and the --permission flag
// (--hardened) all arrive by then. framework.js checks this before anything
// else starts.
const MIN = '22.16.0';

function parts(version) {
  return String(version).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
}

function supported(version) {
  const have = parts(version);
  const need = parts(MIN);
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

function message(version) {
  return `countinghouse 8 needs Node 22.16 or later (this is ${version})`;
}

module.exports = {MIN, supported, message};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx mocha test/sandbox/10-node-version.js`
Expected: 4 passing.

- [ ] **Step 5: Wire the check and remove the fallback.**
  - `framework.js`: directly after `var packageJson = require('./package.json');` add
    ```js
    var nodeVersion = require('./lib/node-version');
    if (!nodeVersion.supported(process.version)) {
      console.error(nodeVersion.message(process.version));
      process.exit(2);
    }
    ```
    Remove the `hasPermissionModel()` block inside the `--hardened` branch, the `options.moduleSandboxMissing.length > 0` refusal, and the `offReason` branch that names missing APIs (keep the two remaining `off` lines: explicit off, and "it needs --workerThread").
  - `lib/cli-options.js`: replace the `sandboxSupport` lines with
    ```js
    this.moduleSandboxExplicit = (argv.moduleSandbox != null);
    this.moduleSandbox = this.moduleSandboxExplicit
      ? String(argv.moduleSandbox)
      : (this.workerThread === true ? 'audit' : 'off');
    ```
    and delete `this.moduleSandboxMissing`. Adjust the comment above to drop the Node-support sentence.
  - `git rm lib/sandbox-support.js test/sandbox/10-node-support.js`.
  - `package.json`: `"node": ">=22.16"`.
  - `.github/workflows/ci.yml`: line 39 `node-version: 22`; line 158 `node-version: [22, 24]` (setup-node resolves `22` to the newest 22.x, which is >= 22.16).
  - `bin/countinghouse`: delete the `NODE_VERSION`/`NODE_MAJOR_VERSION`/`WORKER_FLAG` lines and the Node 10 branch, and drop `$WORKER_FLAG` from both `node` invocations.
  - `CLAUDE.md:36`: `- Target: Node >= 22.16, JSON Schema 2020-12 (ajv 8), MCP spec 2026-07-28` (the user asked for this edit).
  - Docs: in `docs/security-model.md` replace "The sandbox needs Node 22.16 or later … an explicit `audit` or `enforce` is a startup error." with "countinghouse 8 needs Node 22.16 or later." In `docs/cli-and-api-reference.md` change the `--moduleSandbox` default cell to "`audit` with `--workerThread`; `off` without it" and drop ", or on Node < 22.16," from its description; in the `--hardened` row change "(needs `--workerThread` and Node >= 22.13; a startup error otherwise)" to "(needs `--workerThread`)".
  - `CHANGELOG.md`: add at the top, above `## Unreleased` contents' first heading, a section `### Changed — 8.0.0 platform` with the bullet "**Node 22.16 or later is required.** Startup exits with status 2 on an older Node. Node 20 reached end of life in April 2026." and remove the Node-version clauses from the part 1 `--moduleSandbox` and `--hardened` bullets.

- [ ] **Step 6: Check nothing still references the removed module**

Run: `grep -rn "sandbox-support\|moduleSandboxMissing\|hasPermissionModel\|PERMISSION_MIN_NODE" lib framework.js bin test docs CHANGELOG.md`
Expected: no output.

- [ ] **Step 7: Run the affected tests**

Run: `npm run lint && npx mocha --exit test/sandbox/01-modes.js test/sandbox/09-hardened.js test/sandbox/10-node-version.js`
Expected: lint clean; all passing. (Tell the reviewer first: 01 and 09 use ports 9605 and 9614.)

- [ ] **Step 8: Commit**

```bash
git add -A lib/node-version.js test/sandbox/10-node-version.js framework.js lib/cli-options.js package.json .github/workflows/ci.yml bin/countinghouse CLAUDE.md docs/security-model.md docs/cli-and-api-reference.md CHANGELOG.md
git rm -q --cached lib/sandbox-support.js test/sandbox/10-node-support.js 2>/dev/null || true
git commit -m "feat!: require Node 22.16; drop part 1's Node feature fallback" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pin every test server to an explicit thread mode

Before the default flips, make every test that starts a server say which mode it wants, so Task 3 changes no test's meaning. Rule: a server start that already passes `--workerThread` is left alone; every other server start gets `--no-workerThread` (it tests single-thread behaviour today, so it keeps testing it). Which files to move to the new default is a later decision, not part of this plan.

**Files:**
- Create: `test/helpers/thread-flag-check.js`
- Modify: every file the checker lists (expected, from a survey at `75d125c`: `test/test2.js`, `test/test3.js`, `test/test4.js`, `test/test5.js`, `test/test6.js`, `test/test7.js`, `test/fixtures/route-inventory.js`, `test/composition/01-worker-mode-conflict-guard.js`, `test/composition/07-single-thread-conflict-guard.js`, `test/mcp-contract/*.js`, `test/module-authoring/03-authoring-tools-gating.js`, `test/module-loading/01,03,05,06,08,10,11-*.js`, `test/validation/02-stray-output-rejected.js`, `test/direct-peer-channels/01,02-*.js`, and the server starts without the flag inside `test/auth/*.js`, `test/composition/*.js`, `test/module-loading/12-reload-fresh-code.js` and `test/sandbox/*.js`)

**Interfaces:**
- Produces: `node test/helpers/thread-flag-check.js` prints `file:line` for each server start that passes neither flag, and exits 1 if there are any.

- [ ] **Step 1: Write the checker** — `test/helpers/thread-flag-check.js`:

```js
// Lists test server starts that pass neither --workerThread nor
// --no-workerThread. 8.0.0 makes --workerThread the default, so such a start
// would silently change which mode its test exercises. Run by hand:
//   node test/helpers/thread-flag-check.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const START = /framework\.js|bin\/countinghouse"|startServer\(/;
const FLAG = /--(no-)?workerThread/;

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === 'node_modules' || name === 'unit') continue;
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js') && p !== __filename && !p.endsWith(path.join('helpers', 'sandbox-server.js'))) out.push(p);
  }
  return out;
}

const misses = [];
for (const file of walk(ROOT, [])) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!START.test(line)) return;
    // the arguments may continue on the next two lines
    const window = lines.slice(i, i + 3).join(' ');
    if (!FLAG.test(window)) misses.push(`${path.relative(ROOT, file)}:${i + 1}`);
  });
}
misses.forEach((m) => console.log(m));
process.exit(misses.length > 0 ? 1 : 0);
```

- [ ] **Step 2: Run it to see the list (this is the failing state)**

Run: `node test/helpers/thread-flag-check.js; echo "exit=$?"`
Expected: a list of `file:line` entries and `exit=1`. Save the list in the task's working notes; it is the set of edits for Step 3. A match that is not a server start (a comment, a `require` of `framework.js` for another purpose) is a false positive: note it, and leave the line alone but reword the comment or add the flag to the nearest argument list so the checker passes honestly — never weaken the checker's regex to hide a real start.

- [ ] **Step 3: Add `--no-workerThread` to each listed start.** Three shapes occur:
  - an argument array, e.g. `['--debug', '--debugKey', KEY]` → `['--no-workerThread', '--debug', '--debugKey', KEY]`;
  - an `exec` string, e.g. `'"./bin/countinghouse" --debug …'` → `'"./bin/countinghouse" --no-workerThread --debug …'`;
  - a `startServer(port, args)` call: put `'--no-workerThread'` first in `args`.
  Do not touch starts that already pass `--workerThread`.

- [ ] **Step 4: Run the checker until it is clean**

Run: `node test/helpers/thread-flag-check.js; echo "exit=$?"`
Expected: no output, `exit=0`.

- [ ] **Step 5: Spot-check that pinning changed nothing.** The default is still off before Task 3, so `--no-workerThread` must be a no-op today.

Run (one at a time, telling the reviewer before sandbox ports): `npx mocha --exit test/module-loading/01-load-failure-diagnostics.js test/composition/07-single-thread-conflict-guard.js test/sandbox/01-modes.js`
Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add test
git commit -m "test: pin every test server to an explicit thread mode" -m "8.0.0 makes --workerThread the default. Every server start that did not pass it now passes --no-workerThread, so no test changes which mode it exercises when the default flips; test/helpers/thread-flag-check.js lists any start that passes neither." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `--workerThread` on by default

**Files:**
- Modify: `lib/cli-options.js:14`, `lib/sandbox.js:9-10`, `bin/countinghouse-validate.js:19`, `framework.js` (single-thread warning), `test/sandbox/01-modes.js`, `docs/cli-and-api-reference.md` (`--workerThread` row), `CHANGELOG.md`
- Create: `test/sandbox/13-thread-default.js`

**Interfaces:**
- Produces: `options.workerThread === true` unless argv says `--no-workerThread`, `--workerThread false` or `--workerThread=false`.

- [ ] **Step 1: Write the failing unit test** — `test/sandbox/13-thread-default.js`:

```js
// 8.0.0: --workerThread is on unless the operator turns it off, in any of
// the spellings minimist produces.
const assert = require('assert');
const minimist = require('minimist');
const options = require('../../lib/cli-options');

function parse(args) {
  options.setOptions(minimist(args));
  return options.workerThread;
}

describe('sandbox 13: --workerThread default', () => {
  after(() => options.setOptions({workerThread: false}));

  it('is on with no flag', () => assert.strictEqual(parse([]), true));
  it('is on with --workerThread', () => assert.strictEqual(parse(['--workerThread']), true));
  it('is off with --no-workerThread', () => assert.strictEqual(parse(['--no-workerThread']), false));
  it('is off with --workerThread false', () => assert.strictEqual(parse(['--workerThread', 'false']), false));
  it('is off with --workerThread=false', () => assert.strictEqual(parse(['--workerThread=false']), false));
  it('makes audit the default sandbox mode', () => {
    parse([]);
    assert.strictEqual(options.moduleSandbox, 'audit');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx mocha test/sandbox/13-thread-default.js`
Expected: FAIL on "is on with no flag", "is off with --workerThread false" (string `"false"` is not `true` today, so that one may pass — note which) and "makes audit the default sandbox mode".

- [ ] **Step 3: Implement**
  - `lib/cli-options.js:14`:
    ```js
    // On unless turned off (8.0.0). minimist gives `--workerThread false` and
    // `--workerThread=false` as the string "false", which means off too.
    this.workerThread            = (argv.workerThread !== false && argv.workerThread !== 'false');
    ```
  - `lib/sandbox.js:10`: `options.setOptions({workerThread: false});` with the comment "A worker is single-threaded inside; set-options (below) replaces these with the main thread's options, with workerThread forced false again." (the existing `msg.options.workerThread = false` line stays).
  - `bin/countinghouse-validate.js:19`: `.setOptions({workerThread: false});` — the validator requires the module in its own process and must not take the worker path.
  - `framework.js`, after the `module sandbox:` lines: 
    ```js
    if (options.workerThread !== true) {
      logger.I('single-thread mode (--no-workerThread) is for debugging modules: no module sandbox, and not for production');
    }
    ```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx mocha test/sandbox/13-thread-default.js`
Expected: 6 passing.

- [ ] **Step 5: Rewrite `test/sandbox/01-modes.js` for the new default.** Replace the first two tests with:

```js
  it('defaults to audit with no thread flag (worker mode is the default)', async () => {
    server = await startServer(9605, ['--debug', '--debugKey', 'aabbcc']); // thread-flag-check: default on purpose
    assert.ok(server.output.includes('module sandbox: mode audit'), server.output.slice(-2000));
  });

  it('is off in single-thread mode, and says why and that the mode is for debugging', async () => {
    server = await startServer(9605, ['--no-workerThread', '--debug', '--debugKey', 'aabbcc']);
    assert.ok(server.output.includes('module sandbox: off -- it needs --workerThread'), server.output.slice(-2000));
    assert.ok(server.output.includes('single-thread mode (--no-workerThread) is for debugging modules'), server.output.slice(-2000));
  });
```

and change the "refuses an explicit enforce without --workerThread" test's args to `['--no-workerThread', '--debug', '--moduleSandbox', 'enforce']`. The first test above deliberately passes no flag and carries the comment `// thread-flag-check: default on purpose`; teach the checker to skip lines carrying that comment:

```js
    if (!START.test(line) || line.includes('thread-flag-check: default on purpose')) return;
```

- [ ] **Step 6: Run the affected tests** (tell the reviewer first)

Run: `npx mocha --exit test/sandbox/01-modes.js test/sandbox/13-thread-default.js test/validation/*.js test/composition/02-ctx-call.js && node test/helpers/thread-flag-check.js`
Expected: all passing; checker exit 0.

- [ ] **Step 7: Docs and CHANGELOG.** `docs/cli-and-api-reference.md` `--workerThread` row: default "on (8.0.0)", description "Run each module in its own worker thread. `--no-workerThread` selects single-thread mode, which is for debugging modules: no module sandbox." CHANGELOG `### Changed — 8.0.0 platform`: "**`--workerThread` is on by default.** Pass `--no-workerThread` for single-thread mode, now meant only for debugging modules; startup logs a line saying so. Because the module sandbox follows worker mode, its default `audit` mode now applies without any flag."

- [ ] **Step 8: Commit**

```bash
git add lib/cli-options.js lib/sandbox.js bin/countinghouse-validate.js framework.js test/sandbox/01-modes.js test/sandbox/13-thread-default.js test/helpers/thread-flag-check.js docs/cli-and-api-reference.md CHANGELOG.md
git commit -m "feat!: --workerThread is on by default" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Refuse a load whose request name differs from package.json

**Files:**
- Modify: `lib/module-manager.js` (`loadModuleFromPath` at :450, `spawnModuleWorker` at :536, a new helper), `lib/module-sandbox-config.js:41` (policy lookup by the verified name), `lib/error-info.en-US.json`, `lib/error-info.zh-CN.json`, `docs/cli-and-api-reference.md`, `CHANGELOG.md`
- Create: `test/module-loading/13-name-mismatch.js`

**Interfaces:**
- Produces: `CHError('MODULE_NAME_MISMATCH', requestName, packageName)`; `lib/module-manager.js` internal `nameMismatch(modulePath, name)` → `CHError | null`.

- [ ] **Step 1: Write the failing test** — `test/module-loading/13-name-mismatch.js`:

```js
// A load whose request name differs from the module's package.json name is
// refused in every mode, so code cannot be loaded under another module's
// name (and so get its policy entry and, from part 2, its data).
const assert = require('assert');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');

const KEY = 'aabbcc';
const PROBE = path.join(ROOT, 'test', 'fixtures', 'sandbox-probe');   // package.json name: sandbox-probe

describe('module-loading 13: request name must match package.json', function() {
  this.timeout(90000);
  let server = null;
  afterEach(() => { stopServer(server); server = null; });

  [['worker mode, off', ['--workerThread', '--moduleSandbox', 'off']],
   ['worker mode, enforce', ['--workerThread', '--moduleSandbox', 'enforce']],
   ['single-thread mode', ['--no-workerThread']]].forEach(([label, flags]) => {
    it(`${label}: refuses a mismatched name and loads the matching one`, async () => {
      server = await startServer(9615, flags.concat(['--debug', '--debugKey', KEY, '--authoringTools']));
      const bad = await mcpCall(9615, KEY, 'countinghouse_load_module', {path: PROBE, name: 'weather', version: '1.0.0'});
      assert.strictEqual(bad.structuredContent.code, 'MODULE_NAME_MISMATCH', JSON.stringify(bad));
      const good = await mcpCall(9615, KEY, 'countinghouse_load_module', {path: PROBE, name: 'sandbox-probe', version: '1.0.0'});
      assert.strictEqual(good.structuredContent.loaded, true, JSON.stringify(good));
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails** (tell the reviewer first: port 9615)

Run: `npx mocha --exit test/module-loading/13-name-mismatch.js`
Expected: FAIL — the mismatched load succeeds (`loaded: true`), so `code` is undefined.

- [ ] **Step 3: Implement**
  - Error text, `lib/error-info.en-US.json` (after `MODULE_PATH_OUTSIDE_ROOT`): `"MODULE_NAME_MISMATCH": "The load request names a module differently from its package.json -- load it under its package.json name"`; `lib/error-info.zh-CN.json`: `"MODULE_NAME_MISMATCH": "加载请求中的模块名与其 package.json 中的名称不一致 -- 请使用 package.json 中的名称加载"`.
  - `lib/module-manager.js`, next to `outsideHardenedRoot`:
    ```js
    // 8.0.0: a load must use the module's own package.json name. The policy
    // entry and (from part 2) the data directory are keyed by that name, so a
    // request under another name must not borrow them. Every mode, and single-
    // thread mode too. A package.json that cannot be read is left to the load
    // itself to report.
    function nameMismatch(modulePath, name) {
      let pkgName = null;
      try {
        pkgName = JSON.parse(fs.readFileSync(path.join(String(modulePath), 'package.json'), 'utf8')).name;
      } catch (e) {
        return null;
      }
      if (typeof(pkgName) !== 'string' || pkgName === name) return null;
      return new CHError('MODULE_NAME_MISMATCH', name, pkgName);
    }
    ```
    In `loadModuleFromPath` and in `spawnModuleWorker`, right after the `outsideHardenedRoot` check:
    ```js
    const mismatch = nameMismatch(modulePath, name);
    if (mismatch != null) return callback(mismatch);
    ```
    (`spawnModuleWorker` repeats the check because supervised restarts and `restartModule` reach it without `loadModuleFromPath`. `reloadModule` takes the name from package.json and needs nothing.)
  - `lib/module-sandbox-config.js:41`: key the policy by the verified name — replace `policy.modules[name]` with `policy.modules[(read.pkg != null && typeof(read.pkg.name) === 'string') ? read.pkg.name : name]` and add the comment "The verified package.json name; the request's name has already been checked against it (lib/module-manager.js nameMismatch)."

- [ ] **Step 4: Run it to verify it passes**

Run: `npx mocha --exit test/module-loading/13-name-mismatch.js`
Expected: 3 passing.

- [ ] **Step 5: Run the suites most likely to load modules under other names** (one at a time, telling the reviewer)

Run: `npx mocha --exit test/composition/*.js` then `npx mocha --exit test/sandbox/04-load-time.js test/sandbox/07-restart.js` then `npx mocha test/module-loading/*.js test/auth/*.js`
Expected: all passing. A failure here is a test or fixture loading a module under a name that differs from its package.json: fix the test's name (it is the bug the new rule exists to catch), and list each such fix in the commit message.

- [ ] **Step 6: Docs and CHANGELOG.** `docs/cli-and-api-reference.md`, under the module lifecycle routes: "A load (`/load-module`, `countinghouse_load_module`, `--loadModule`, the registry at startup) must use the module's package.json name; any other name is refused with `MODULE_NAME_MISMATCH`." CHANGELOG `### Changed — 8.0.0 platform`: "**A load must use the module's package.json name** (`MODULE_NAME_MISMATCH` otherwise), in every mode. The module sandbox's policy is looked up by that name. Before upgrading, check registry entries, `load_module` calls and composite `runsModules` bindings for names that differ from the module's package.json."

- [ ] **Step 7: Commit**

```bash
git add lib/module-manager.js lib/module-sandbox-config.js lib/error-info.en-US.json lib/error-info.zh-CN.json test/module-loading/13-name-mismatch.js docs/cli-and-api-reference.md CHANGELOG.md
git commit -m "feat!: refuse a load whose name differs from its package.json name" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Full suite and hand-off

- [ ] **Step 1:** Tell the reviewer, then run `npm test > .superpowers/part2-plan1-suite.log 2>&1; echo "exit=$?" >> .superpowers/part2-plan1-suite.log` in the background (about 35 minutes; keep the machine idle).
- [ ] **Step 2:** Expected: `exit=0`. On a failure, fix it in a separate commit, send that commit to the reviewer, and re-run the failing file and then the full suite.
- [ ] **Step 3:** Send the reviewer the final commit range for plan 1 and the suite result; report to the user. Plan 2 is written next.
