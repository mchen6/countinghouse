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

1. A test that starts a server, or builds countinghouse objects in the mocha process, without saying which thread mode it wants silently changes meaning when the default flips — after Task 2 there must be none (Task 2's runtime guard, in-process pins and the full suite in Task 5).
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

### Task 2: Pin every test to an explicit thread mode

Before the default flips, make every test say which mode it wants, so Task 3 changes no test's meaning. Rule: a server start that already passes `--workerThread` is left alone; every other server start gets `--no-workerThread`; every in-process `setOptions(...)` that does not set `workerThread` gets `workerThread: false`. All of these test single-thread behaviour today, so they keep testing it. Which files later move to the new default is a separate decision, recorded as an open item in the plan series' ledger (`.superpowers/sdd/sandbox-part2/progress.md`, created in this task) so it is not lost.

A static scan cannot see every spawn shape (`spawn(path.join(ROOT, 'bin', 'countinghouse'), args)` with `args` built elsewhere, `fork(…, [` with a conditional push later). So the proof is a **runtime guard**: under the test suite, `framework.js` refuses to start without a thread flag. The static checker stays as a quick pre-check.

**Files:**
- Create: `test/helpers/thread-flag-check.js`, `test/helpers/require-thread-flag.js`, `.mocharc.json`, `.superpowers/sdd/sandbox-part2/progress.md`
- Modify: `framework.js` (the guard), every file the checker or the guard reports (server starts), and every in-process `setOptions` caller (expected from a survey at `75d125c`: `test/module-authoring/01-*.js`, `05-*.js`, `test/composition/01, 02, 05, 06, 07, 09-*.js`, `test/sandbox/14-rate-exempt.js`, `test/sandbox/15-call-restarting.js`, `test/fixtures/route-inventory.js`; and the `minimist(args)` callers `test/composition/12-*.js`, `test/auth/19-*.js`)

**Interfaces:**
- Produces: env `COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG=1` makes `framework.js` exit 3 with `no thread flag given (pass --workerThread or --no-workerThread)` when argv has neither. Kept, test-only, after the migration.
- Produces: `node test/helpers/thread-flag-check.js` prints `file:line` for each obvious server start without a flag, exit 1 if any.

- [ ] **Step 1: Write the runtime guard and its test.** `test/helpers/require-thread-flag.js`:

```js
// Loaded by every mocha run (.mocharc.json). Test servers inherit the
// variable, and framework.js then refuses to start without an explicit
// thread flag, so no test can silently change mode when a default changes.
process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG = '1';
```

`.mocharc.json`:

```json
{
  "require": ["test/helpers/require-thread-flag.js"]
}
```

`framework.js`, directly after the Node version check:

```js
// Test suite only (test/helpers/require-thread-flag.js): every test server
// must say which thread mode it wants.
if (process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG === '1' &&
    process.argv.indexOf('--workerThread') === -1 && process.argv.indexOf('--no-workerThread') === -1) {
  console.error('no thread flag given (pass --workerThread or --no-workerThread)');
  process.exit(3);
}
```

Add to `test/sandbox/10-node-version.js`:

```js
const {execFileSync} = require('child_process');
const pathMod = require('path');

describe('sandbox 10: thread-flag guard (test suite only)', () => {
  it('refuses a test server with no thread flag', () => {
    let code = 0, out = '';
    try {
      execFileSync(process.execPath, [pathMod.join(__dirname, '..', '..', 'framework.js'), '--debug'],
        {env: Object.assign({}, process.env, {COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG: '1'}), stdio: 'pipe'});
    } catch (e) { code = e.status; out = String(e.stderr); }
    assert.strictEqual(code, 3);
    assert.ok(out.includes('no thread flag given'), out);
  });
});
```

- [ ] **Step 2: Run the guard test to verify it fails, then passes**

Run before adding the `framework.js` lines: `npx mocha test/sandbox/10-node-version.js` → the guard test FAILS (the server starts and is killed by nothing; use `timeout: 15000` in `execFileSync` options so it fails rather than hangs). Add the lines, run again → passes.

- [ ] **Step 3: Write the static pre-check** — `test/helpers/thread-flag-check.js`:

```js
// Quick pre-check: lists obvious test server starts that pass neither
// --workerThread nor --no-workerThread, and in-process setOptions calls that
// do not set workerThread. The runtime guard (test/helpers/require-thread-
// flag.js) is the proof; this only saves a 35-minute run.
//   node test/helpers/thread-flag-check.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const START = /framework\.js|bin['"\/, ]+countinghouse|startServer\(/;
const FLAG = /--(no-)?workerThread/;
const SET_OPTIONS = /setOptions\((\{[^)]*\}|minimist\()/;

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
    if (line.includes('thread-flag-check: default on purpose')) return;
    const window = lines.slice(i, i + 3).join(' ');
    if (START.test(line) && !FLAG.test(window)) misses.push(`${path.relative(ROOT, file)}:${i + 1} server start`);
    if (SET_OPTIONS.test(line) && !/workerThread/.test(window)) misses.push(`${path.relative(ROOT, file)}:${i + 1} setOptions`);
  });
}
misses.forEach((m) => console.log(m));
process.exit(misses.length > 0 ? 1 : 0);
```

Run: `node test/helpers/thread-flag-check.js; echo "exit=$?"` → a list and `exit=1`. Also run `grep -rn "setOptions(" test --include=*.js` and compare: every caller must end up setting `workerThread`.

- [ ] **Step 4: Pin.** Server starts: add `--no-workerThread` (argument arrays: first element; `exec` strings: right after the program; `args` arrays built elsewhere: at their definition; conditional pushes: make both branches explicit). In-process: `setOptions({})` → `setOptions({workerThread: false})`; `setOptions(minimist(args))` → make the test's `args` include `--no-workerThread` unless the test is about the flag. A false positive of the checker (a comment, a non-server `require`) is reworded, never hidden by weakening the regex.

- [ ] **Step 5: Run the checker until it is clean,** then the files most likely to be affected (the default is still off, so every pin must be a no-op today), telling the reviewer before sandbox ports:

Run: `node test/helpers/thread-flag-check.js && npx mocha --exit test/module-loading/01-load-failure-diagnostics.js test/composition/07-single-thread-conflict-guard.js test/module-authoring/*.js test/mcp-contract/01-tools-list-unchanged.js test/sandbox/01-modes.js`
Expected: checker exit 0; all passing. Any test failing with `no thread flag given` is a missed start: pin it.

- [ ] **Step 6: Ledger.** Create `.superpowers/sdd/sandbox-part2/progress.md` with its first line `# Ledger — module sandbox part 2 (plans 1-5)` and the open item: "Decide per test file which pinned `--no-workerThread` tests move to the default (worker) mode. Pinned in plan 1, Task 2."

- [ ] **Step 7: Commit**

```bash
git add .mocharc.json framework.js test
git commit -m "test: require an explicit thread mode in every test" -m "8.0.0 makes --workerThread the default. Every server start that did not pass it now passes --no-workerThread, and every in-process setOptions sets workerThread: false, so no test changes mode when the default flips. Under mocha, framework.js refuses to start without a thread flag (COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG, set by .mocharc.json); test/helpers/thread-flag-check.js is a quick static pre-check." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `--workerThread` on by default

**Files:**
- Modify: `lib/cli-options.js:14`, `lib/sandbox.js:9-10`, `bin/countinghouse-validate.js:19`, `framework.js` (single-thread warning), `test/sandbox/01-modes.js`, `docs/cli-and-api-reference.md` (`--workerThread` row), `CHANGELOG.md`
- Create: `test/sandbox/16-thread-default.js`

**Interfaces:**
- Produces: `options.workerThread === true` unless argv says `--no-workerThread`, `--workerThread false` or `--workerThread=false`.

- [ ] **Step 1: Write the failing unit test** — `test/sandbox/16-thread-default.js`:

```js
// 8.0.0: --workerThread is on unless the operator turns it off, in any of
// the spellings minimist produces. Parsed in a child process so the shared
// cli-options singleton of this mocha run is left untouched.
const assert = require('assert');
const path = require('path');
const {execFileSync} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

function parse(args) {
  const script = `const o = require(${JSON.stringify(path.join(ROOT, 'lib', 'cli-options'))});` +
    `o.setOptions(require(${JSON.stringify(path.join(ROOT, 'node_modules', 'minimist'))})(${JSON.stringify(args)}));` +
    'process.stdout.write(JSON.stringify({workerThread: o.workerThread, moduleSandbox: o.moduleSandbox}));';
  return JSON.parse(execFileSync(process.execPath, ['-e', script], {encoding: 'utf8'}));
}

describe('sandbox 16: --workerThread default', function() {
  this.timeout(20000);
  it('is on with no flag', () => assert.strictEqual(parse([]).workerThread, true));
  it('is on with --workerThread', () => assert.strictEqual(parse(['--workerThread']).workerThread, true));
  it('is off with --no-workerThread', () => assert.strictEqual(parse(['--no-workerThread']).workerThread, false));
  it('is off with --workerThread false', () => assert.strictEqual(parse(['--workerThread', 'false']).workerThread, false));
  it('is off with --workerThread=false', () => assert.strictEqual(parse(['--workerThread=false']).workerThread, false));
  it('makes audit the default sandbox mode', () => assert.strictEqual(parse([]).moduleSandbox, 'audit'));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx mocha test/sandbox/16-thread-default.js`
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
      logger.W('single-thread mode (--no-workerThread) is for debugging modules: no module sandbox, and not for production');
    }
    ```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx mocha test/sandbox/16-thread-default.js`
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

and change the "refuses an explicit enforce without --workerThread" test's args to `['--no-workerThread', '--debug', '--moduleSandbox', 'enforce']`. The first test above deliberately passes no flag and carries the comment `// thread-flag-check: default on purpose` (the static checker skips it). The runtime guard would refuse it, so that one test starts its server with `{env: {COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG: '0'}}` as `startServer`'s third argument.

- [ ] **Step 6: Run the affected tests** (tell the reviewer first)

Run: `npx mocha --exit test/sandbox/01-modes.js test/sandbox/16-thread-default.js test/validation/*.js test/composition/02-ctx-call.js && node test/helpers/thread-flag-check.js`
Expected: all passing; checker exit 0.

- [ ] **Step 7: List what now starts by default.** Run `grep -n "options.workerThread\|this.workerThread" lib/*.js lib/**/*.js framework.js` and, for each read that gates something at startup or on first use (for example `framework.js` starting `JobControl.initJobProcess`, the bullmq job worker on Redis; the peer-channel broker; the module supervisor), write one line in the task's notes: what it starts, and whether it is wanted by default. Anything not wanted goes to the reviewer and the user before this task is committed. The user-visible ones go into the CHANGELOG entry below.

- [ ] **Step 8: Docs and CHANGELOG.** `docs/cli-and-api-reference.md` `--workerThread` row: default "on (8.0.0)", description "Run each module in its own worker thread. `--no-workerThread` selects single-thread mode, which is for debugging modules: no module sandbox." CHANGELOG `### Changed — 8.0.0 platform`: "**`--workerThread` is on by default.** Pass `--no-workerThread` for single-thread mode, now meant only for debugging modules; startup logs a line saying so. Because the module sandbox follows worker mode, its default `audit` mode now applies without any flag. Worker mode also starts, by default, what it always started: <the user-visible list from Step 7, for example the bullmq job worker on Redis>."

- [ ] **Step 9: Commit**

```bash
git add lib/cli-options.js lib/sandbox.js bin/countinghouse-validate.js framework.js test/sandbox/01-modes.js test/sandbox/16-thread-default.js docs/cli-and-api-reference.md CHANGELOG.md
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

Add a registry case to the same file — a registry entry under the wrong name must fail at startup with `MODULE_NAME_MISMATCH` and the server must still reach its ready line (Review Focus 4):

```js
const fs = require('fs');
const os = require('os');
const sqlite3 = require('sqlite3');

describe('module-loading 13: a mismatched registry entry at startup', function() {
  this.timeout(90000);
  let server = null;
  let dir = null;
  afterEach(() => { stopServer(server); server = null; if (dir) fs.rmSync(dir, {recursive: true, force: true}); });

  it('logs MODULE_NAME_MISMATCH and still reaches ready', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-registry-'));
    await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(path.join(dir, 'countinghouse-modules.db'));
      db.serialize(() => {
        db.run('CREATE TABLE IF NOT EXISTS module_info(name TEXT PRIMARY KEY, version TEXT, path TEXT, deviceList TEXT)');
        db.run('INSERT INTO module_info VALUES (?, ?, ?, ?)', ['weather', '1.0.0', PROBE, '{}'], (e) => (e ? reject(e) : db.close(resolve)));
      });
    });
    server = await startServer(9615, ['--workerThread', '--debug', '--debugKey', KEY, '--modulePath', dir]);
    assert.ok(server.output.includes('MODULE_NAME_MISMATCH') || server.output.includes('package.json'), server.output.slice(-3000));
  });
});
```

(`startServer` resolves only on the ready line, so reaching the assertion proves startup was not hung. Tighten the assertion to the exact logged error text once Step 3 shows what `LOG.E` prints for the CHError.)

Add an omitted-name case for the REST route — a load without `name` uses the package.json name:

```js
const {post} = require('../helpers/sandbox-server');

describe('module-loading 13: /load-module without a name', function() {
  this.timeout(90000);
  let server = null;
  afterEach(() => { stopServer(server); server = null; });

  it('loads under the package.json name', async () => {
    server = await startServer(9615, ['--workerThread', '--debug', '--debugKey', KEY]);
    const r = await post(9615, KEY, '/load-module', {path: PROBE, version: '1.0.0'});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.name, 'sandbox-probe', JSON.stringify(r.body));
  });
});
```

- [ ] **Step 2: Run it to verify it fails** (tell the reviewer first: port 9615)

Run: `npx mocha --exit test/module-loading/13-name-mismatch.js`
Expected: FAIL — the mismatched load succeeds (`loaded: true`), so `code` is undefined; the registry case logs no `MODULE_NAME_MISMATCH`; the omitted-name case loads with `name` undefined.

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
  - `lib/routes/load-module.js`: when `req.body.name` is missing or not a string, use the module's package.json name (read the same way as `nameMismatch`; if package.json cannot be read, pass the missing name through and let the load report the real problem). Comment: "A REST load may omit name; the package.json name is the only name 8.0.0 accepts anyway."
  - `lib/module-sandbox-config.js:41`: key the policy by the verified name — replace `policy.modules[name]` with `policy.modules[(read.pkg != null && typeof(read.pkg.name) === 'string') ? read.pkg.name : name]` and add the comment "The verified package.json name; the request's name has already been checked against it (lib/module-manager.js nameMismatch)."

- [ ] **Step 4: Run it to verify it passes**

Run: `npx mocha --exit test/module-loading/13-name-mismatch.js`
Expected: 5 passing.

- [ ] **Step 5: Run the suites most likely to load modules under other names** (one at a time, telling the reviewer)

Run: `npx mocha --exit test/composition/*.js` then `npx mocha --exit test/sandbox/04-load-time.js test/sandbox/07-restart.js` then `npx mocha test/module-loading/*.js test/auth/*.js`
Expected: all passing. A failure here is a test or fixture loading a module under a name that differs from its package.json: fix the test's name (it is the bug the new rule exists to catch), and list each such fix in the commit message.

- [ ] **Step 6: Docs and CHANGELOG.** `docs/cli-and-api-reference.md`, under the module lifecycle routes: "A load (`/load-module`, `countinghouse_load_module`, `--loadModule`, the registry at startup) must use the module's package.json name; any other name is refused with `MODULE_NAME_MISMATCH`." CHANGELOG `### Changed — 8.0.0 platform`: "**A load must use the module's package.json name** (`MODULE_NAME_MISMATCH` otherwise), in every mode. The module sandbox's policy is looked up by that name. Before upgrading, check registry entries, `load_module` calls and composite `runsModules` bindings for names that differ from the module's package.json."

- [ ] **Step 7: Commit**

```bash
git add lib/module-manager.js lib/module-sandbox-config.js lib/routes/load-module.js lib/error-info.en-US.json lib/error-info.zh-CN.json test/module-loading/13-name-mismatch.js docs/cli-and-api-reference.md CHANGELOG.md
git commit -m "feat!: refuse a load whose name differs from its package.json name" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Full suite and hand-off

- [ ] **Step 1:** Tell the reviewer, then run `npm test > .superpowers/part2-plan1-suite.log 2>&1; echo "exit=$?" >> .superpowers/part2-plan1-suite.log` in the background (about 35 minutes; keep the machine idle).
- [ ] **Step 2:** Expected: `exit=0`. On a failure, fix it in a separate commit, send that commit to the reviewer, and re-run the failing file and then the full suite.
- [ ] **Step 3:** Send the reviewer the final commit range for plan 1 and the suite result; report to the user. Plan 2 is written next.
