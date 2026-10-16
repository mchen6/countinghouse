# Module Sandbox Part 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock down the worker each module runs in, give modules declared permissions that the operator narrows, cap their memory and blocking with restart-and-suspend, and add a `--hardened` launch mode — without changing the single-process architecture, direct peer channels, or the module format.

**Architecture:** Main-thread logic is split into small pure modules (permission parsing and narrowing, policy loading, tree checks, the restart supervisor) that are unit tested in-process, plus thin wiring in `lib/module-manager.js`, `lib/device-manager.js`, `lib/worker-message.js` and `lib/sandbox.js`. The worker-side lockdown is one file, `lib/module-lockdown.js`, installed on the worker's `set-options` message before any module code loads. Everything is driven by one flag, `--moduleSandbox off|audit|enforce`.

**Tech Stack:** Node.js >= 20 (developed on v24.21), `worker_threads`, `module.registerHooks`, mocha + supertest, the existing countinghouse server and fixtures.

**Spec:** `docs/superpowers/specs/2026-10-15-module-sandbox-foundation-design.md` — read it before starting any task; this plan argues from it.

**Base branch:** `design/module-sandbox-foundation` (contains the spec and, beneath it, `fix/loadfile-without-rewire` at `22c19d2`, which this work requires: reload is a restart in a new worker, `CHUtil.loadFile` is a plain `require()`, and a late `exit` from an old worker no longer unloads a newer one).

## Global Constraints

- Default mode is `audit`; with no `--workerThread` the default becomes `off` with a startup line, and an explicit `--moduleSandbox audit|enforce` without `--workerThread` exits with code 2.
- `off` must behave exactly as before this work: no lockdown, no limits, no policy, crashed modules stay down.
- Resource limits apply in `audit` as well as `enforce`.
- Default limit ceilings: `heapMb` 256, `externalMb` 256, `maxBlockMs` 10000. Default `--moduleMessageRate` 2000 messages/second.
- Restart backoff 1 s doubling to a 60 s cap; suspend on the 3rd unexpected exit within 10 minutes; counter resets after 10 minutes without an exit.
- Blocked built-ins: `child_process`, `cluster`, `worker_threads`, `inspector`, `inspector/promises`, `wasi`, `v8`.
- Reserved virtual-root paths that `fs` declarations may not use: `/app`, `/data`, `/tmp` and anything under them, and `/` itself.
- New error codes go into both `lib/error-info.en-US.json` and `lib/error-info.zh-CN.json`, with head text that says what to do on its own (the worker hop keeps only the code).
- Every log line this work adds starts with `module sandbox:` so operators and tests can find them.
- No direct peer channel, Redis, `ctx.call` or billing path gains a hop.
- Code and comments in English; small commits, one task per commit; `npm run lint` clean.
- Test servers use ports 9605–9619 (9602–9604 are taken by `test/module-loading/12-reload-fresh-code.js`).
- The full `npm test` takes ~35 minutes on the 1-CPU dev VM. Keep the machine idle while it runs; a VM pause or a Redis restart mid-run fails it (check `journalctl` for "Clock change" and `redis-server` restarts before blaming code). Stop a run by PID, never with a `pkill -f` pattern.

## Review Focus

1. **A module with no `countinghouse` key at all** (every existing module and fixture) must load and work unchanged under the default `audit`, with no refusal and no violation lines except its first use of a watched built-in. Test added in Task 4.
2. **countinghouse's own code inside the worker lazily requiring a blocked built-in after lockdown** would break the server under `enforce` while looking fine under `audit`. A full composition scenario (ctx.call between two modules, with direct peer channels on) must pass under `enforce`. Test added in Task 5.
3. **A `--modulePolicy` file that is missing or malformed** must stop startup with a clear message (exit 2), not crash later on the first module spawn. Test added in Task 2.
4. **An operator's deliberate unload, restart or reload must never count toward suspension**, including a restart issued while the module is already `restarting` from a crash. Test added in Task 7.
5. **A `--loadModule` path given as a relative path** (the documented quickstart form, `./path/to/module`) must still work under `--hardened` when it resolves inside `--modulePath`. Test added in Task 9.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/cli-options.js` (modify) | `moduleSandbox`, `modulePolicy`, `moduleMessageRate`, `hardened` |
| `framework.js` (modify) | mode validation and startup lines; policy validation at startup; `--hardened` re-launch |
| `lib/module-permissions.js` (create) | parse a `package.json` declaration; narrow it by a policy entry; resolve env values; host matching |
| `lib/module-policy.js` (create) | load and validate the `--modulePolicy` file |
| `lib/module-tree-check.js` (create) | self-contained, native-code and install-script checks over a module directory |
| `lib/module-validator.js`, `bin/countinghouse-validate.js` (modify) | report permission syntax problems, tree problems and warnings |
| `lib/module-sandbox-config.js` (create) | main thread: everything a worker spawn needs (refusal, Worker options, lockdown config, limits, log line) |
| `lib/module-lockdown.js` (create) | worker: native-code block, process controls, `require` boundary, blocked built-ins, CHUtil wrapping, freeze |
| `lib/module-supervisor.js` (create) | restart/backoff/suspend policy, retained device specs, status records |
| `lib/worker-limits.js` (create) | main thread: external-memory polling and the blocked-loop heartbeat for one worker |
| `lib/module-manager.js`, `lib/device-manager.js`, `lib/worker-message.js`, `lib/sandbox.js` (modify) | wiring |
| `lib/hardened-launch.js` (create) | compute `--permission` flags and re-launch |
| `lib/error-info.en-US.json`, `lib/error-info.zh-CN.json` (modify) | new codes |
| `test/sandbox/*.js` (create), `test/fixtures/sandbox-probe/`, `test/fixtures/sandbox-hog/`, `test/fixtures/sandbox-native/` (create) | tests |
| `package.json` (modify) | add `mocha --exit ./test/sandbox/*.js` to `npm test` |
| `docs/security-model.md`, `docs/module-development.md`, `docs/cli-and-api-reference.md`, `CHANGELOG.md` (modify) | docs |

A shared test helper keeps server-spawning code in one place:

| `test/helpers/sandbox-server.js` (create, Task 1) | spawn a countinghouse server with given args, collect stdout, wait for ready; MCP and HTTP call helpers |

---

### Task 1: Modes, flags, error codes and the sandbox test harness

**Files:**
- Modify: `lib/cli-options.js` (inside `setOptions`, after the `authoringTools` line; and `getOptions`)
- Modify: `framework.js` (after `logger.createLogger(...)`)
- Modify: `lib/error-info.en-US.json`, `lib/error-info.zh-CN.json`
- Modify: `package.json` (`scripts.test`)
- Create: `test/helpers/sandbox-server.js`
- Test: `test/sandbox/01-modes.js`

**Interfaces:**
- Produces: `options.moduleSandbox` (`'off'|'audit'|'enforce'`), `options.moduleSandboxExplicit` (boolean), `options.modulePolicy` (string|null), `options.moduleMessageRate` (integer > 0), `options.hardened` (boolean). All but `moduleSandboxExplicit` are in `getOptions()`.
- Produces: error codes `MODULE_SANDBOX_REFUSED`, `MODULE_RESTARTING`, `MODULE_SUSPENDED`, `RATE_LIMITED`, `MODULE_PATH_OUTSIDE_ROOT`.
- Produces (test helper): `startServer(port, args, opts) -> Promise<server>` where `server.output` is accumulated stdout and `server.exitCode` is set on exit; `stopServer(server)`; `mcpCall(port, key, toolName, args) -> Promise<result>`; `post(port, key, route, body) -> Promise<{status, body}>`; `waitFor(predicate, timeoutMs, label) -> Promise`.

- [ ] **Step 1: Write the test helper**

Create `test/helpers/sandbox-server.js`:

```js
// Spawning and calling a countinghouse server for the module-sandbox tests
// (test/sandbox/). One place for the boilerplate the other server tests each
// carry their own copy of: spawn detached so the whole group can be killed,
// collect stdout so tests can look for `module sandbox:` lines, wait for the
// ready line, and talk MCP or plain HTTP to it.
const path    = require('path');
const spawn   = require('child_process').spawn;
const request = require('supertest');
const waitForReady = require('./wait-for-ready');

const ROOT = path.join(__dirname, '..', '..');

// opts.expectExit: resolve as soon as the process exits instead of waiting
// for the ready line -- for startup-refusal tests.
// opts.env: extra environment variables for the server.
function startServer(port, args, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const server = spawn(process.execPath,
      [path.join(ROOT, 'framework.js'), '--bindAddr', '127.0.0.1', '--port', String(port)].concat(args),
      {cwd: ROOT,
       env: Object.assign({}, process.env, {NODE_PATH: path.join(ROOT, 'lib')}, opts.env || {}),
       stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    server.output = '';
    server.exitCode = null;
    server.stdout.on('data', (chunk) => { server.output += chunk.toString(); });
    server.stderr.on('data', (chunk) => { server.output += chunk.toString(); });
    if (opts.expectExit === true) {
      server.on('exit', (code) => { server.exitCode = code; resolve(server); });
      return;
    }
    server.on('exit', (code) => { server.exitCode = code; });
    waitForReady(server, (err) => (err ? reject(err) : resolve(server)));
  });
}

// try/catch: the server may already be gone if an earlier step failed.
function stopServer(server) {
  if (server == null || server.pid == null) return;
  try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
}

function mcpCall(port, key, name, args) {
  return new Promise((resolve, reject) => {
    request(`http://127.0.0.1:${port}`)
      .post('/mcp')
      .set('X-CH-Key', key)
      .set('Accept', 'application/json, text/event-stream')
      .send({jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: {name: name, arguments: args || {}}})
      .end((err, res) => (err ? reject(err) : resolve(res.body.result || res.body.error)));
  });
}

function post(port, key, route, body) {
  return new Promise((resolve, reject) => {
    request(`http://127.0.0.1:${port}`)
      .post(route)
      .set('X-CH-Key', key)
      .send(body || {})
      .end((err, res) => (err ? reject(err) : resolve({status: res.status, body: res.body})));
  });
}

// Poll an async or sync predicate every 200 ms until it returns a truthy
// value, which is resolved; reject with `label` after timeoutMs.
function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (async function attempt() {
      let value = null;
      try { value = await predicate(); } catch (e) { value = null; }
      if (value) return resolve(value);
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(attempt, 200);
    })();
  });
}

module.exports = {ROOT, startServer, stopServer, mcpCall, post, waitFor};
```

- [ ] **Step 2: Write the failing test**

Create `test/sandbox/01-modes.js`:

```js
// --moduleSandbox: the default, the downgrade without --workerThread, the
// refusals, and the startup lines operators read.
const assert = require('assert');
const {startServer, stopServer} = require('../helpers/sandbox-server');

describe('sandbox 01: modes', function() {
  this.timeout(60000);
  let server = null;
  afterEach(() => { stopServer(server); server = null; });

  it('defaults to audit under --workerThread', async () => {
    server = await startServer(9605, ['--debug', '--debugKey', 'aabbcc', '--workerThread']);
    assert.ok(server.output.includes('module sandbox: mode audit'), server.output.slice(-2000));
  });

  it('downgrades the default to off without --workerThread, and says why', async () => {
    server = await startServer(9605, ['--debug', '--debugKey', 'aabbcc']);
    assert.ok(server.output.includes('module sandbox: off -- it needs --workerThread'), server.output.slice(-2000));
  });

  it('warns when the operator turns it off explicitly', async () => {
    server = await startServer(9605, ['--debug', '--debugKey', 'aabbcc', '--workerThread', '--moduleSandbox', 'off']);
    assert.ok(server.output.includes('module sandbox: off (--moduleSandbox off)'), server.output.slice(-2000));
  });

  it('refuses an explicit enforce without --workerThread', async () => {
    server = await startServer(9605, ['--debug', '--moduleSandbox', 'enforce'], {expectExit: true});
    assert.strictEqual(server.exitCode, 2);
    assert.ok(server.output.includes('--moduleSandbox enforce needs --workerThread'), server.output);
  });

  it('refuses an unknown mode', async () => {
    server = await startServer(9605, ['--debug', '--workerThread', '--moduleSandbox', 'strict'], {expectExit: true});
    assert.strictEqual(server.exitCode, 2);
    assert.ok(server.output.includes('--moduleSandbox must be one of off, audit, enforce'), server.output);
  });
});
```

Add the sandbox directory to `npm test` in `package.json`: in `scripts.test`, replace `&& mocha ./test/test8.js` with `&& mocha --exit ./test/sandbox/*.js && mocha ./test/test8.js`.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx mocha --exit test/sandbox/01-modes.js`
Expected: 5 failing — the first three on the missing `module sandbox:` lines, the last two because the server starts (exit code `null` after kill, not 2).

- [ ] **Step 4: Implement the options**

In `lib/cli-options.js`, after the `this.authoringTools = ...` line in `setOptions`:

```js
    // Module sandbox (docs/superpowers/specs/2026-10-15-module-sandbox-
    // foundation-design.md). The default depends on --workerThread because
    // the sandbox only exists in worker mode; moduleSandboxExplicit lets
    // framework.js refuse an explicit audit/enforce without it while quietly
    // downgrading the default. A worker receives the already-resolved mode
    // through getOptions(), which counts as explicit there -- harmless, the
    // worker never applies this check.
    this.moduleSandboxExplicit = (argv.moduleSandbox != null);
    this.moduleSandbox = this.moduleSandboxExplicit
      ? String(argv.moduleSandbox)
      : (this.workerThread === true ? 'audit' : 'off');
    this.modulePolicy = argv.modulePolicy || null;
    this.moduleMessageRate = argv.moduleMessageRate != null ? parseInt(argv.moduleMessageRate) : 2000;
    if (!(this.moduleMessageRate > 0)) this.moduleMessageRate = 2000;
    this.hardened = (argv.hardened === true);
```

In `getOptions`, after `authoringTools: this.authoringTools`:

```js
      authoringTools:           this.authoringTools,
      moduleSandbox:            this.moduleSandbox,
      modulePolicy:             this.modulePolicy,
      moduleMessageRate:        this.moduleMessageRate,
      hardened:                 this.hardened
```

(The existing last line `authoringTools: this.authoringTools` gains a trailing comma.)

In `framework.js`, directly after `logger.createLogger(options.logStream);`:

```js
// Module sandbox mode checks. An explicit mode that cannot work is a startup
// error; the default quietly downgrades (lib/cli-options.js).
if (['off', 'audit', 'enforce'].indexOf(options.moduleSandbox) === -1) {
  console.error('--moduleSandbox must be one of off, audit, enforce (got "' + options.moduleSandbox + '")');
  process.exit(2);
}
if (options.moduleSandbox !== 'off' && options.workerThread !== true) {
  console.error('--moduleSandbox ' + options.moduleSandbox + ' needs --workerThread: the sandbox applies to module workers');
  process.exit(2);
}
if (options.moduleSandbox === 'off') {
  logger.I(options.moduleSandboxExplicit
    ? 'module sandbox: off (--moduleSandbox off) -- module code runs with the full privileges of this process'
    : 'module sandbox: off -- it needs --workerThread; module code runs with the full privileges of this process');
} else {
  logger.I('module sandbox: mode ' + options.moduleSandbox);
}
```

- [ ] **Step 5: Add the error codes**

In `lib/error-info.en-US.json`, add before the closing `}` (keep the previous last entry's comma correct):

```json
  "MODULE_SANDBOX_REFUSED": "Module refused by the module sandbox (enforce mode) -- run countinghouse-validate on it, fix the listed problems (permissions syntax, dependencies outside the module, native code), and load it again",
  "MODULE_RESTARTING": "The module's worker stopped (a resource limit or a crash) and is restarting -- retry after the time given; the server log has the reason",
  "MODULE_SUSPENDED": "The module was suspended after repeated worker exits -- an operator must fix the cause (see the server log) and restart it with POST /restart-module",
  "RATE_LIMITED": "This module sent too many messages to the main thread -- slow down, or ask the operator to raise --moduleMessageRate",
  "MODULE_PATH_OUTSIDE_ROOT": "With --hardened, every module must live under --modulePath -- move the module there or load it from there"
```

In `lib/error-info.zh-CN.json`, add the same keys:

```json
  "MODULE_SANDBOX_REFUSED": "模块被模块沙箱拒绝（enforce 模式）-- 请对其运行 countinghouse-validate，修复列出的问题（权限声明语法、模块目录之外的依赖、原生代码），然后重新加载",
  "MODULE_RESTARTING": "模块的 worker 已停止（资源限制或崩溃），正在重启 -- 请在给出的时间之后重试；原因见服务器日志",
  "MODULE_SUSPENDED": "模块因 worker 反复退出已被暂停 -- 需要运维人员排除原因（见服务器日志）后用 POST /restart-module 重启",
  "RATE_LIMITED": "该模块发往主线程的消息过多 -- 请降低频率，或请运维人员调高 --moduleMessageRate",
  "MODULE_PATH_OUTSIDE_ROOT": "使用 --hardened 时，所有模块都必须位于 --modulePath 之下 -- 请把模块移到那里或从那里加载"
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx mocha --exit test/sandbox/01-modes.js`
Expected: 5 passing. Also run `node -e "JSON.parse(require('fs').readFileSync('lib/error-info.en-US.json'));JSON.parse(require('fs').readFileSync('lib/error-info.zh-CN.json'));console.log('ok')"` → `ok`.

- [ ] **Step 7: Commit**

```bash
git add lib/cli-options.js framework.js lib/error-info.en-US.json lib/error-info.zh-CN.json package.json test/helpers/sandbox-server.js test/sandbox/01-modes.js
git commit -m "feat(sandbox): --moduleSandbox off|audit|enforce, its flags and error codes"
```

---

### Task 2: Permission declarations, operator policy, narrowing

**Files:**
- Create: `lib/module-permissions.js`
- Create: `lib/module-policy.js`
- Modify: `framework.js` (validate `--modulePolicy` at startup)
- Test: `test/sandbox/02-permissions.js`

**Interfaces:**
- Produces: `modulePermissions.parseDeclaration(pkg) -> {declared: {fs: [{path, access}], net: [{host, ports|null}], env: [name], limits: {heapMb?, externalMb?, maxBlockMs?}}, problems: [string]}`. Invalid entries are dropped from `declared` and described in `problems`.
- Produces: `modulePermissions.narrow(declared, entry, ceilings, mode) -> {fs, net, envNames: [name], envOverrides: {name: value}, limits: {heapMb, externalMb, maxBlockMs}, ignored: [string], approved: boolean}`. `entry` is the policy's per-module object or `null`; `ceilings` is the policy's top-level `limits` or `{}`; `mode` is `'audit'|'enforce'`.
- Produces: `modulePermissions.resolveEnv(envNames, envOverrides, serverEnv) -> {name: value}`.
- Produces: `modulePermissions.hostAllowed(net, hostname, port) -> boolean`.
- Produces: `modulePermissions.DEFAULT_LIMITS = {heapMb: 256, externalMb: 256, maxBlockMs: 10000}`.
- Produces: `modulePolicy.load(file) -> {limits: {...}, modules: {name: entry}}` (throws `Error` with a readable message); `modulePolicy.EMPTY`.

Decisions this task pins down (the spec leaves them implicit):
- `env` counts as outside access for approval: under `enforce`, a module declaring `env` names with no policy entry gets none.
- In a policy entry, `env` is an object; a key approves that name, a string value overrides the value, `null` means "take it from the server environment". With `"approve": "as-declared"` every declared name is approved and `env` only supplies overrides.
- A `*.example.com` pattern matches exactly one extra leading label (`a.example.com`, not `a.b.example.com`, not `example.com`), like a TLS wildcard.
- In an entry without `approve`, a missing `fs` or `net` key grants none of that kind.

- [ ] **Step 1: Write the failing test**

Create `test/sandbox/02-permissions.js`:

```js
// Pure functions: parsing a declaration, narrowing it by an operator policy
// entry, env resolution, host matching, policy file loading. No server.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const perms  = require('../../lib/module-permissions');
const policy = require('../../lib/module-policy');
const {startServer, stopServer} = require('../helpers/sandbox-server');

const pkg = (permissions) => ({name: 'm', version: '1.0.0', countinghouse: {permissions: permissions}});

describe('sandbox 02: permission declarations', () => {
  it('treats a package.json without a countinghouse key as declaring nothing', () => {
    const r = perms.parseDeclaration({name: 'm', version: '1.0.0'});
    assert.deepStrictEqual(r.problems, []);
    assert.deepStrictEqual(r.declared, {fs: [], net: [], env: [], limits: {}});
  });

  it('accepts a full valid declaration', () => {
    const r = perms.parseDeclaration(pkg({
      fs: [{path: '/var/log/app', access: 'r'}],
      net: [{host: 'API.Example.com', ports: [443]}, {host: '*.example.org'}],
      env: ['WEATHER_API_KEY'],
      limits: {heapMb: 128, maxBlockMs: 5000}
    }));
    assert.deepStrictEqual(r.problems, []);
    assert.deepStrictEqual(r.declared.net, [{host: 'api.example.com', ports: [443]}, {host: '*.example.org', ports: null}]);
    assert.deepStrictEqual(r.declared.limits, {heapMb: 128, maxBlockMs: 5000});
  });

  it('rejects reserved, relative, non-normalized and root fs paths, and bad access', () => {
    const r = perms.parseDeclaration(pkg({fs: [
      {path: '/data/x', access: 'r'}, {path: '/tmp', access: 'rw'}, {path: 'logs', access: 'r'},
      {path: '/var/log/../etc', access: 'r'}, {path: '/', access: 'r'}, {path: '/var/log', access: 'w'}
    ]}));
    assert.strictEqual(r.declared.fs.length, 0);
    assert.strictEqual(r.problems.length, 6, r.problems.join('\n'));
  });

  it('rejects bad hosts, ports, env names and limits', () => {
    const r = perms.parseDeclaration(pkg({
      net: [{host: 'a.*.com'}, {host: 'ok.com', ports: [0]}, {host: 'ok.com', ports: ['443']}],
      env: ['lower', 'OK_NAME'],
      limits: {heapMb: -1, externalMb: 1.5, other: 3}
    }));
    assert.deepStrictEqual(r.declared.env, ['OK_NAME']);
    assert.deepStrictEqual(r.declared.net, []);
    assert.deepStrictEqual(r.declared.limits, {});
    assert.strictEqual(r.problems.length, 7, r.problems.join('\n'));
  });
});

describe('sandbox 02: narrowing by the operator policy', () => {
  const declared = perms.parseDeclaration(pkg({
    fs: [{path: '/var/log/app', access: 'rw'}],
    net: [{host: 'api.example.com', ports: [443, 8443]}, {host: '*.example.org'}],
    env: ['A', 'B'],
    limits: {heapMb: 512}
  })).declared;

  it('audit with no entry grants the declaration', () => {
    const r = perms.narrow(declared, null, {}, 'audit');
    assert.deepStrictEqual(r.fs, declared.fs);
    assert.deepStrictEqual(r.net, declared.net);
    assert.deepStrictEqual(r.envNames, ['A', 'B']);
    assert.strictEqual(r.approved, false);
  });

  it('enforce with no entry grants nothing outside the module', () => {
    const r = perms.narrow(declared, null, {}, 'enforce');
    assert.deepStrictEqual([r.fs, r.net, r.envNames], [[], [], []]);
  });

  it('enforce with no entry is fine for a module that declares nothing outside', () => {
    const empty = perms.parseDeclaration({name: 'm'}).declared;
    const r = perms.narrow(empty, null, {}, 'enforce');
    assert.deepStrictEqual(r.ignored, []);
    assert.deepStrictEqual(r.limits, perms.DEFAULT_LIMITS);
  });

  it('approve as-declared grants everything and takes env overrides', () => {
    const r = perms.narrow(declared, {approve: 'as-declared', env: {A: 'from-policy'}}, {}, 'enforce');
    assert.deepStrictEqual(r.envNames, ['A', 'B']);
    assert.deepStrictEqual(r.envOverrides, {A: 'from-policy'});
    assert.strictEqual(r.approved, true);
  });

  it('narrows paths, access, hosts and ports, and ignores anything wider', () => {
    const r = perms.narrow(declared, {
      fs: [{path: '/var/log/app/sub', access: 'r'}, {path: '/etc', access: 'r'}],
      net: [{host: 'api.example.com', ports: [443]}, {host: 'x.example.org'}, {host: 'evil.com'},
            {host: 'api.example.com', ports: [80]}],
      env: {A: null, C: 'x'}
    }, {}, 'enforce');
    assert.deepStrictEqual(r.fs, [{path: '/var/log/app/sub', access: 'r'}]);
    assert.deepStrictEqual(r.net, [{host: 'api.example.com', ports: [443]}, {host: 'x.example.org', ports: null}]);
    assert.deepStrictEqual(r.envNames, ['A']);
    assert.strictEqual(r.ignored.length, 4, r.ignored.join('\n'));
  });

  it('takes the smallest of request, top-level ceiling and entry ceiling', () => {
    const r = perms.narrow(declared, {approve: 'as-declared', limits: {heapMb: 300}}, {heapMb: 400, maxBlockMs: 2000}, 'audit');
    assert.deepStrictEqual(r.limits, {heapMb: 300, externalMb: 256, maxBlockMs: 2000});
  });

  it('resolves env values: override, then server env, then absent', () => {
    assert.deepStrictEqual(
      perms.resolveEnv(['A', 'B', 'C'], {A: 'p'}, {A: 's', B: 's', PATH: '/bin'}),
      {A: 'p', B: 's'});
  });

  it('matches hosts and ports, with one-label wildcards', () => {
    const net = [{host: 'api.example.com', ports: [443]}, {host: '*.example.org', ports: null}];
    assert.strictEqual(perms.hostAllowed(net, 'API.example.com', 443), true);
    assert.strictEqual(perms.hostAllowed(net, 'api.example.com', 80), false);
    assert.strictEqual(perms.hostAllowed(net, 'a.example.org', 80), true);
    assert.strictEqual(perms.hostAllowed(net, 'a.b.example.org', 80), false);
    assert.strictEqual(perms.hostAllowed(net, 'example.org', 80), false);
  });
});

describe('sandbox 02: the policy file', function() {
  this.timeout(60000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-policy-'));
  after(() => fs.rmSync(dir, {recursive: true, force: true}));

  it('loads a valid file', () => {
    const file = path.join(dir, 'ok.json');
    fs.writeFileSync(file, JSON.stringify({limits: {heapMb: 128}, modules: {m: {approve: 'as-declared'}}}));
    assert.deepStrictEqual(policy.load(file).modules.m, {approve: 'as-declared'});
  });

  it('names the problem in a malformed file', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({modules: {m: {approve: 'yes'}}}));
    assert.throws(() => policy.load(file), /modules\.m\.approve/);
  });

  it('stops startup on a missing policy file', async () => {
    let server = null;
    try {
      server = await startServer(9606, ['--debug', '--workerThread', '--modulePolicy', path.join(dir, 'nope.json')], {expectExit: true});
      assert.strictEqual(server.exitCode, 2);
      assert.ok(server.output.includes('--modulePolicy'), server.output);
    } finally { stopServer(server); }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx mocha --exit test/sandbox/02-permissions.js`
Expected: FAIL at load with `Cannot find module '../../lib/module-permissions'`.

- [ ] **Step 3: Implement `lib/module-permissions.js`**

```js
// A module's permission declaration (package.json "countinghouse.permissions")
// and how the operator's policy narrows it. Pure functions: no I/O, so the
// rules are tested directly (test/sandbox/02-permissions.js). The design is
// docs/superpowers/specs/2026-10-15-module-sandbox-foundation-design.md,
// section 2.
const path = require('path');

const DEFAULT_LIMITS = Object.freeze({heapMb: 256, externalMb: 256, maxBlockMs: 10000});
const LIMIT_KEYS     = Object.keys(DEFAULT_LIMITS);
// Part 2's virtual root owns these; a declaration may not name them.
const RESERVED       = ['/app', '/data', '/tmp'];
const ENV_NAME       = /^[A-Z_][A-Z0-9_]*$/;
const LABEL          = '[a-z0-9]([a-z0-9-]*[a-z0-9])?';
const HOST           = new RegExp(`^(\\*\\.)?${LABEL}(\\.${LABEL})*$`);
const ACCESS_RANK    = {r: 1, rw: 2};

function isReserved(p) {
  return p === '/' || RESERVED.some((r) => p === r || p.startsWith(r + '/'));
}

function parseFs(list, problems) {
  if (list == null) return [];
  if (!Array.isArray(list)) { problems.push('countinghouse.permissions.fs must be an array'); return []; }
  const out = [];
  list.forEach((e, i) => {
    const where = `countinghouse.permissions.fs[${i}]`;
    if (e == null || typeof(e.path) !== 'string') return problems.push(`${where}.path must be a string`);
    const p = e.path;
    if (!path.posix.isAbsolute(p)) return problems.push(`${where}.path "${p}" must be absolute`);
    if (p.split('/').indexOf('..') !== -1 || path.posix.normalize(p) !== p || (p.length > 1 && p.endsWith('/'))) {
      return problems.push(`${where}.path "${p}" must be normalized (no "..", no trailing "/")`);
    }
    if (isReserved(p)) return problems.push(`${where}.path "${p}" is reserved: "/" and /app, /data, /tmp belong to the module's own root`);
    if (ACCESS_RANK[e.access] == null) return problems.push(`${where}.access must be "r" or "rw"`);
    out.push({path: p, access: e.access});
  });
  return out;
}

function parseNet(list, problems) {
  if (list == null) return [];
  if (!Array.isArray(list)) { problems.push('countinghouse.permissions.net must be an array'); return []; }
  const out = [];
  list.forEach((e, i) => {
    const where = `countinghouse.permissions.net[${i}]`;
    if (e == null || typeof(e.host) !== 'string' || !HOST.test(e.host.toLowerCase())) {
      return problems.push(`${where}.host must be a hostname, optionally starting with "*."`);
    }
    let ports = null;
    if (e.ports != null) {
      if (!Array.isArray(e.ports) || !e.ports.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)) {
        return problems.push(`${where}.ports must be an array of integers 1-65535`);
      }
      ports = e.ports.slice();
    }
    out.push({host: e.host.toLowerCase(), ports: ports});
  });
  return out;
}

function parseEnv(list, problems) {
  if (list == null) return [];
  if (!Array.isArray(list)) { problems.push('countinghouse.permissions.env must be an array'); return []; }
  return list.filter((name, i) => {
    if (typeof(name) === 'string' && ENV_NAME.test(name)) return true;
    problems.push(`countinghouse.permissions.env[${i}] "${name}" is not a valid environment variable name`);
    return false;
  });
}

function parseLimits(obj, problems) {
  if (obj == null) return {};
  if (typeof(obj) !== 'object' || Array.isArray(obj)) { problems.push('countinghouse.permissions.limits must be an object'); return {}; }
  const out = {};
  Object.keys(obj).forEach((k) => {
    if (LIMIT_KEYS.indexOf(k) === -1) return problems.push(`countinghouse.permissions.limits.${k} is not a known limit (${LIMIT_KEYS.join(', ')})`);
    if (!Number.isInteger(obj[k]) || obj[k] <= 0) return problems.push(`countinghouse.permissions.limits.${k} must be a positive integer`);
    out[k] = obj[k];
  });
  return out;
}

function parseDeclaration(pkg) {
  const problems = [];
  const raw = (pkg != null && pkg.countinghouse != null) ? pkg.countinghouse.permissions : null;
  if (raw == null) return {declared: {fs: [], net: [], env: [], limits: {}}, problems: problems};
  if (typeof(raw) !== 'object' || Array.isArray(raw)) {
    return {declared: {fs: [], net: [], env: [], limits: {}}, problems: ['countinghouse.permissions must be an object']};
  }
  return {
    declared: {
      fs:     parseFs(raw.fs, problems),
      net:    parseNet(raw.net, problems),
      env:    parseEnv(raw.env, problems),
      limits: parseLimits(raw.limits, problems)
    },
    problems: problems
  };
}

// One extra leading label, like a TLS wildcard.
function hostMatches(pattern, host) {
  if (!pattern.startsWith('*.')) return pattern === host;
  const suffix = pattern.slice(1); // ".example.org"
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, host.length - suffix.length);
  return label.length > 0 && label.indexOf('.') === -1;
}

function hostAllowed(net, hostname, port) {
  const host = String(hostname).toLowerCase();
  return net.some((e) => hostMatches(e.host, host) && (e.ports == null || e.ports.indexOf(port) !== -1));
}

function narrowFs(declared, wanted, ignored) {
  const out = [];
  (wanted || []).forEach((w) => {
    const ok = w != null && typeof(w.path) === 'string' && ACCESS_RANK[w.access] != null &&
      declared.some((d) => (w.path === d.path || w.path.startsWith(d.path + '/')) &&
                           ACCESS_RANK[w.access] <= ACCESS_RANK[d.access]);
    if (ok) out.push({path: w.path, access: w.access});
    else ignored.push(`fs ${JSON.stringify(w)} is wider than the declaration and was ignored`);
  });
  return out;
}

function narrowNet(declared, wanted, ignored) {
  const out = [];
  (wanted || []).forEach((w) => {
    const host = (w != null && typeof(w.host) === 'string') ? w.host.toLowerCase() : null;
    const ports = (w != null && Array.isArray(w.ports)) ? w.ports.slice() : null;
    const ok = host != null && !host.startsWith('*.') && declared.some((d) => {
      if (!hostMatches(d.host, host)) return false;
      if (d.ports == null) return true;
      return ports != null && ports.every((p) => d.ports.indexOf(p) !== -1);
    });
    if (ok) out.push({host: host, ports: ports});
    else ignored.push(`net ${JSON.stringify(w)} is wider than the declaration and was ignored`);
  });
  return out;
}

function narrowLimits(requested, ceilings, entryLimits) {
  const out = {};
  LIMIT_KEYS.forEach((k) => {
    const caps = [DEFAULT_LIMITS[k]];
    if (ceilings != null && Number.isInteger(ceilings[k])) caps[0] = ceilings[k];
    if (entryLimits != null && Number.isInteger(entryLimits[k])) caps.push(entryLimits[k]);
    const ceiling = Math.min.apply(null, caps);
    out[k] = requested[k] != null ? Math.min(requested[k], ceiling) : ceiling;
  });
  return out;
}

function narrow(declared, entry, ceilings, mode) {
  const ignored = [];
  const limits = narrowLimits(declared.limits, ceilings, entry != null ? entry.limits : null);
  const needsApproval = declared.fs.length > 0 || declared.net.length > 0 || declared.env.length > 0;

  if (entry == null) {
    const grant = (mode !== 'enforce');
    return {
      fs: grant ? declared.fs : [], net: grant ? declared.net : [],
      envNames: grant ? declared.env.slice() : [], envOverrides: {},
      limits: limits, ignored: ignored, approved: !needsApproval
    };
  }

  const envEntry = (entry.env != null && typeof(entry.env) === 'object') ? entry.env : {};
  const envOverrides = {};
  Object.keys(envEntry).forEach((name) => {
    if (declared.env.indexOf(name) === -1) return ignored.push(`env ${name} is not declared and was ignored`);
    if (typeof(envEntry[name]) === 'string') envOverrides[name] = envEntry[name];
  });

  if (entry.approve === 'as-declared') {
    return {fs: declared.fs, net: declared.net, envNames: declared.env.slice(), envOverrides: envOverrides,
            limits: limits, ignored: ignored, approved: true};
  }

  return {
    fs: narrowFs(declared.fs, entry.fs, ignored),
    net: narrowNet(declared.net, entry.net, ignored),
    envNames: Object.keys(envEntry).filter((name) => declared.env.indexOf(name) !== -1),
    envOverrides: envOverrides,
    limits: limits, ignored: ignored, approved: true
  };
}

function resolveEnv(envNames, envOverrides, serverEnv) {
  const out = {};
  envNames.forEach((name) => {
    if (envOverrides[name] != null) out[name] = envOverrides[name];
    else if (serverEnv[name] != null) out[name] = serverEnv[name];
  });
  return out;
}

module.exports = {DEFAULT_LIMITS, parseDeclaration, narrow, resolveEnv, hostAllowed};
```

- [ ] **Step 4: Implement `lib/module-policy.js`**

```js
// The operator's --modulePolicy file: ceilings for every module and per-module
// entries that narrow a module's declared permissions
// (lib/module-permissions.js#narrow). Loaded at startup to fail fast, and
// again on every module spawn so an edit takes effect on module restart.
const fs = require('fs');

const EMPTY = Object.freeze({limits: {}, modules: {}});

function fail(where, message) {
  throw new Error(`--modulePolicy: ${where} ${message}`);
}

function checkArray(v, where) {
  if (v != null && !Array.isArray(v)) fail(where, 'must be an array');
}

function checkObject(v, where) {
  if (v != null && (typeof(v) !== 'object' || Array.isArray(v))) fail(where, 'must be an object');
}

function load(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`--modulePolicy: cannot read ${file}: ${e.message}`);
  }
  checkObject(raw, 'the file');
  checkObject(raw.limits, 'limits');
  checkObject(raw.modules, 'modules');
  const modules = raw.modules || {};
  Object.keys(modules).forEach((name) => {
    const e = modules[name];
    checkObject(e, `modules.${name}`);
    if (e.approve != null && e.approve !== 'as-declared') fail(`modules.${name}.approve`, 'must be "as-declared"');
    checkArray(e.fs, `modules.${name}.fs`);
    checkArray(e.net, `modules.${name}.net`);
    checkObject(e.env, `modules.${name}.env`);
    checkObject(e.limits, `modules.${name}.limits`);
  });
  return {limits: raw.limits || {}, modules: modules};
}

module.exports = {EMPTY, load};
```

- [ ] **Step 5: Validate the policy at startup**

In `framework.js`, after the mode checks added in Task 1:

```js
if (options.modulePolicy != null) {
  try {
    require('./lib/module-policy').load(options.modulePolicy);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx mocha --exit test/sandbox/02-permissions.js`
Expected: all passing.

- [ ] **Step 7: Commit**

```bash
git add lib/module-permissions.js lib/module-policy.js framework.js test/sandbox/02-permissions.js
git commit -m "feat(sandbox): permission declarations, the operator policy file, narrowing"
```

---

### Task 3: Tree checks and the validator

**Files:**
- Create: `lib/module-tree-check.js`
- Modify: `lib/module-validator.js` (`validateModule`, after `callsProblems(...)`)
- Modify: `bin/countinghouse-validate.js` (human-readable output)
- Test: `test/sandbox/03-tree-check.js`

**Interfaces:**
- Consumes: `modulePermissions.parseDeclaration` (Task 2).
- Produces: `moduleTreeCheck.checkTree(moduleRoot) -> {problems: [string], warnings: [string]}`.
- Produces: `validateModule` results gain `warnings: [{stage, module, message, fix}]` (always present, possibly empty); `ok` still depends on `problems` only.

- [ ] **Step 1: Write the failing test**

Create `test/sandbox/03-tree-check.js`:

```js
// Self-contained, native-code and install-script checks over a module's
// directory, and the validator reporting them. Each case builds its own tree
// in a temp directory.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {checkTree} = require('../../lib/module-tree-check');
const validator   = require('../../lib/module-validator');

const ROOT = path.join(__dirname, '..', '..');

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-tree-'));
  Object.keys(files).forEach((rel) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, typeof(files[rel]) === 'string' ? files[rel] : JSON.stringify(files[rel]));
  });
  return dir;
}

describe('sandbox 03: tree checks', () => {
  const made = [];
  const mk = (files) => { const d = tree(files); made.push(d); return d; };
  after(() => made.forEach((d) => fs.rmSync(d, {recursive: true, force: true})));

  it('passes a module whose dependencies are all inside it, nested or hoisted', () => {
    const d = mk({
      'package.json': {name: 'm', dependencies: {a: '1', b: '1'}},
      'node_modules/a/package.json': {name: 'a', dependencies: {c: '1'}},
      'node_modules/a/node_modules/c/package.json': {name: 'c'},
      'node_modules/b/package.json': {name: 'b', dependencies: {a: '1'}}
    });
    assert.deepStrictEqual(checkTree(d), {problems: [], warnings: []});
  });

  it('reports a dependency that is not installed inside the module', () => {
    const d = mk({'package.json': {name: 'm', dependencies: {lodash: '4'}}});
    const r = checkTree(d);
    assert.strictEqual(r.problems.length, 1);
    assert.match(r.problems[0], /"lodash".*not installed inside the module/);
  });

  it('reports a dependency symlinked to outside the module', () => {
    const d = mk({'package.json': {name: 'm', dependencies: {ext: '1'}}});
    const outside = mk({'package.json': {name: 'ext'}});
    fs.mkdirSync(path.join(d, 'node_modules'));
    fs.symlinkSync(outside, path.join(d, 'node_modules', 'ext'));
    assert.match(checkTree(d).problems.join('\n'), /"ext".*outside the module/);
  });

  it('reports native code: .node files, binding.gyp, gypfile', () => {
    const d = mk({
      'package.json': {name: 'm', dependencies: {n: '1', g: '1'}},
      'build/Release/x.node': 'bin',
      'node_modules/n/package.json': {name: 'n'},
      'node_modules/n/binding.gyp': '{}',
      'node_modules/g/package.json': {name: 'g', gypfile: true}
    });
    assert.strictEqual(checkTree(d).problems.length, 3, checkTree(d).problems.join('\n'));
  });

  it('warns about install scripts without failing', () => {
    const d = mk({
      'package.json': {name: 'm', dependencies: {s: '1'}},
      'node_modules/s/package.json': {name: 's', scripts: {postinstall: 'node x.js'}}
    });
    const r = checkTree(d);
    assert.deepStrictEqual(r.problems, []);
    assert.match(r.warnings[0], /node_modules\/s.*postinstall/);
  });
});

describe('sandbox 03: the validator reports them', () => {
  it('adds permission, tree and warning results to an otherwise valid module', (done) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-tree-'));
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'handler-map-convention'), d, {recursive: true});
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
      name: 'handler-map-convention', version: '1.0.0', dependencies: {missing: '1'},
      countinghouse: {permissions: {env: ['bad-name']}}
    }));
    validator.validateModule(d, (err, result) => {
      fs.rmSync(d, {recursive: true, force: true});
      assert.ifError(err);
      const stages = result.problems.map((p) => p.stage).sort();
      assert.deepStrictEqual(stages, ['checkTree', 'countinghouse.permissions']);
      assert.ok(Array.isArray(result.warnings));
      assert.strictEqual(result.ok, false);
      done();
    });
  });

  it('keeps ok true and warnings empty for a clean module', (done) => {
    validator.validateModule(path.join(ROOT, 'test', 'fixtures', 'handler-map-convention'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, true, JSON.stringify(result.problems));
      assert.deepStrictEqual(result.warnings, []);
      done();
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx mocha --exit test/sandbox/03-tree-check.js`
Expected: FAIL at load with `Cannot find module '../../lib/module-tree-check'`.

- [ ] **Step 3: Implement `lib/module-tree-check.js`**

```js
// Checks over a module's directory that the sandbox relies on
// (docs/superpowers/specs/2026-10-15-module-sandbox-foundation-design.md,
// section 2): every dependency installed inside the module, no native code,
// and install scripts reported. Run by countinghouse-validate and again at
// load time (lib/module-sandbox-config.js), which is the check that decides.
const fs   = require('fs');
const path = require('path');

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

function readPkg(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (e) { return null; }
}

function inside(root, p) {
  return p === root || p.startsWith(root + path.sep);
}

// Node's lookup: <dir>/node_modules/<name>, then each parent's, stopping at
// the module root -- a dependency found above the root is outside it.
function findDependency(root, fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

function checkDependencies(root, problems) {
  const seen = new Set();
  (function walk(dir, label) {
    const real = fs.realpathSync(dir);
    if (seen.has(real)) return;
    seen.add(real);
    const pkg = readPkg(dir) || {};
    Object.keys(pkg.dependencies || {}).forEach((name) => {
      const found = findDependency(root, dir, name);
      if (found == null) {
        return problems.push(`dependency "${name}" (needed by ${label}) is not installed inside the module -- ` +
                             'install it into the module\'s own node_modules (npm install --prefix <module>)');
      }
      const realFound = fs.realpathSync(found);
      if (!inside(root, realFound)) {
        return problems.push(`dependency "${name}" (needed by ${label}) resolves outside the module, to ${realFound}`);
      }
      walk(found, path.relative(root, found) || '.');
    });
  })(root, 'the module');
}

function checkFiles(root, problems, warnings) {
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch (e) { return; }
    entries.forEach((ent) => {
      const full = path.join(dir, ent.name);
      const rel  = path.relative(root, full);
      if (ent.isSymbolicLink()) return;            // checkDependencies reports links that leave the tree
      if (ent.isDirectory()) return walk(full);
      if (ent.name.endsWith('.node')) problems.push(`native addon ${rel} -- modules may not contain native code`);
      if (ent.name === 'binding.gyp') problems.push(`${rel} builds native code -- modules may not contain native code`);
      if (ent.name === 'package.json') {
        const pkg = readPkg(dir) || {};
        if (pkg.gypfile === true) problems.push(`${rel} sets "gypfile": true -- modules may not contain native code`);
        INSTALL_SCRIPTS.forEach((s) => {
          if (pkg.scripts != null && pkg.scripts[s] != null) {
            warnings.push(`${path.relative(root, dir) || '.'} has a "${s}" script, which npm runs at install time`);
          }
        });
      }
    });
  })(root);
}

function checkTree(moduleRoot) {
  const root = fs.realpathSync(path.resolve(moduleRoot));
  const problems = [];
  const warnings = [];
  checkDependencies(root, problems);
  checkFiles(root, problems, warnings);
  return {problems: problems, warnings: warnings};
}

module.exports = {checkTree};
```

- [ ] **Step 4: Report from the validator**

In `lib/module-validator.js`, add requires at the top beside the others:

```js
const modulePermissions = require('./module-permissions');
const moduleTreeCheck   = require('./module-tree-check');
```

In `validateModule`, change `const problems   = [];` to:

```js
  const problems   = [];
  const warnings   = [];
```

and directly after `callsProblems(loaded.pkg, moduleName).forEach((p) => problems.push(p));` add:

```js
  // Module sandbox checks (lib/module-permissions.js, lib/module-tree-check.js).
  // The same checks run again at load time, which is the one that decides.
  modulePermissions.parseDeclaration(loaded.pkg).problems.forEach((message) => {
    problems.push(problem('countinghouse.permissions', moduleName, message,
      'See "Declaring permissions" in docs/module-development.md.'));
  });
  const tree = moduleTreeCheck.checkTree(resolved);
  tree.problems.forEach((message) => problems.push(problem('checkTree', moduleName, message, null)));
  tree.warnings.forEach((message) => warnings.push(problem('checkTree', moduleName, message, null)));
```

Then add `warnings: warnings` to both result objects in `validateModule`: the early `return callback(null, {ok: false, module: moduleName, problems: problems});` becomes `return callback(null, {ok: false, module: moduleName, problems: problems, warnings: warnings});`, and the final one becomes `return callback(null, {ok: problems.length === 0, module: moduleName, problems: problems, warnings: warnings});`.

In `bin/countinghouse-validate.js`, the human-readable branch: replace

```js
    console.log(`ok: ${result.module} -- no problems found`);
    process.exit(0);
```

with

```js
    console.log(`ok: ${result.module} -- no problems found`);
    (result.warnings || []).forEach((w) => console.log(`  warning [${w.stage}] ${w.message}`));
    process.exit(0);
```

and after the `result.problems.forEach(...)` block that prints problems, add the same `warnings` loop before the exit.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx mocha --exit test/sandbox/03-tree-check.js test/module-loading/04-handler-map-validation.js test/module-authoring/*.js`
Expected: all passing (the existing validator tests must still pass with the new `warnings` field).

- [ ] **Step 6: Commit**

```bash
git add lib/module-tree-check.js lib/module-validator.js bin/countinghouse-validate.js test/sandbox/03-tree-check.js
git commit -m "feat(sandbox): self-contained and native-code checks in the validator"
```

---

### Task 4: Per-module sandbox config at worker spawn

**Files:**
- Create: `lib/module-sandbox-config.js`
- Modify: `lib/module-manager.js` (`spawnModuleWorker`)
- Create: `test/fixtures/sandbox-probe/` (used by Tasks 4 and 5)
- Create: `test/fixtures/sandbox-native/`
- Test: `test/sandbox/04-load-time.js`

**Interfaces:**
- Consumes: `modulePermissions.*`, `modulePolicy.load`, `moduleTreeCheck.checkTree`.
- Produces: `moduleSandboxConfig.build(modulePath, name, opts) -> null | {refusal: string|null, notes: [string], workerOptions: {env, resourceLimits}, lockdown: {mode, moduleName, moduleRoot, net}, limits: {heapMb, externalMb, maxBlockMs}, logLine: string}` where `opts` is `{mode, modulePolicy, serverEnv}`. Returns `null` when `mode === 'off'`.
- Produces: the `set-options` message carries `sandbox: <lockdown config>|null` (consumed by Task 5).
- Produces: `workerMessage.sandboxLimits` set on the main-thread WorkerMessage (consumed by Task 8).

- [ ] **Step 1: Create the fixtures**

`test/fixtures/sandbox-probe/package.json`:

```json
{
  "name": "sandbox-probe",
  "version": "1.0.0",
  "countinghouse": {
    "permissions": {
      "net": [{"host": "allowed.example.test"}],
      "env": ["PROBE_FROM_POLICY", "PROBE_FROM_SERVER", "PROBE_UNAPPROVED"]
    }
  }
}
```

`test/fixtures/sandbox-probe/api.json`:

```json
{
  "device": {
    "friendlyName": "sandbox-probe",
    "manufacturer": "countinghouse-test",
    "modelDescription": "tries each thing the module sandbox blocks, and reports whether it was blocked",
    "serviceList": {
      "urn:countinghouse-test:serviceID:probeService": {
        "actionList": [
          {"name": "attempt", "description": "Try one blocked operation.",
           "input": {"schema": "/probeService/attempt/input"}, "output": {"schema": "/probeService/attempt/output"}},
          {"name": "env", "description": "Report the environment the module sees.",
           "input": {"schema": "/probeService/env/input"}, "output": {"schema": "/probeService/env/output"}}
        ]
      }
    }
  }
}
```

`test/fixtures/sandbox-probe/schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/",
  "type": "object",
  "probeService": {
    "attempt": {
      "input": {"type": "object", "properties": {"what": {"type": "string"}, "arg": {"type": "string"}}, "required": ["what"]},
      "output": {"type": "object", "properties": {"outcome": {"type": "string"}, "code": {"type": ["string", "null"]}}}
    },
    "env": {
      "input": {"type": "object"},
      "output": {"type": "object", "properties": {"env": {"type": "object"}}}
    }
  }
}
```

`test/fixtures/sandbox-probe/handlers/probeService/env.js`:

```js
// The whole environment the module's worker was given.
module.exports = async () => ({output: {env: Object.assign({}, process.env)}});
```

`test/fixtures/sandbox-probe/handlers/probeService/attempt.js`:

```js
// Each entry tries one thing the module sandbox controls. "blocked" means the
// sandbox refused it -- recognised by its message, so an ordinary failure of
// the operation itself (a missing file, a refused connection) still counts as
// "allowed". test/sandbox/05-lockdown.js drives this under audit and enforce.
const ATTEMPTS = {
  dlopen:           () => process.dlopen({exports: {}}, '/nonexistent/probe.node'),
  binding:          () => process.binding('fs'),
  kill:             () => process.kill(process.pid, 0),
  getBuiltinModule: () => process.getBuiltinModule('child_process'),
  child_process:    () => require('child_process'),
  worker_threads:   () => require('worker_threads'),
  v8:               () => require('v8'),
  registerHooks:    () => module.constructor.registerHooks({resolve: (s, c, n) => n(s, c)}),
  nodePath:         () => require('cli-options'),
  loadFileOutside:  (arg) => CHUtil.loadFile(arg),
  request:          (arg) => new Promise((resolve, reject) => {
    CHUtil.request({url: arg, timeout: 2000}, (err) => (err != null && /module sandbox/.test(err.message) ? reject(err) : resolve()));
  })
};

module.exports = async (input) => {
  try {
    await ATTEMPTS[input.what](input.arg);
    return {output: {outcome: 'allowed', code: null}};
  } catch (e) {
    const blocked = /countinghouse module sandbox/.test(String(e && e.message));
    return {output: {outcome: blocked ? 'blocked' : 'allowed', code: (e && e.code != null) ? String(e.code) : null}};
  }
};
```

`test/fixtures/sandbox-native/`: copy `test/fixtures/handler-map-convention` (all four files), then set `package.json` to `{"name": "sandbox-native", "version": "1.0.0"}`, change `friendlyName` in `api.json` to `sandbox-native`, and add an empty file `test/fixtures/sandbox-native/build/Release/fake.node` (the tree check only looks at the name).

- [ ] **Step 2: Write the failing test**

Create `test/sandbox/04-load-time.js`:

```js
// What the main thread decides before a module's worker starts: refusal in
// enforce, effective permissions, the worker's environment.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');

const KEY    = 'aabbcc';
const PROBE  = path.join(ROOT, 'test', 'fixtures', 'sandbox-probe');
const NATIVE = path.join(ROOT, 'test', 'fixtures', 'sandbox-native');

function policyFile(obj) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-policy-')), 'policy.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

async function load(port, modulePath, name) {
  return mcpCall(port, KEY, 'countinghouse_load_module', {path: modulePath, name: name, version: '1.0.0'});
}

describe('sandbox 04: load-time decisions', function() {
  this.timeout(90000);
  let server = null;
  afterEach(() => { stopServer(server); server = null; });

  it('enforce refuses a module with native code, naming the problem', async () => {
    server = await startServer(9607, ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', 'enforce']);
    const r = await load(9607, NATIVE, 'sandbox-native');
    assert.strictEqual(r.isError, true, JSON.stringify(r));
    assert.strictEqual(r.structuredContent.code, 'MODULE_SANDBOX_REFUSED');
    assert.ok(server.output.includes('fake.node'), server.output.slice(-2000));
  });

  it('audit loads the same module and logs the problem', async () => {
    server = await startServer(9607, ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread']);
    const r = await load(9607, NATIVE, 'sandbox-native');
    assert.strictEqual(r.structuredContent.loaded, true, JSON.stringify(r));
    assert.ok(server.output.includes('module sandbox: sandbox-native would be refused under enforce'), server.output.slice(-2000));
  });

  it('a module with no countinghouse key loads with no refusal and no violation lines', async () => {
    server = await startServer(9607, ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', 'enforce']);
    const r = await load(9607, path.join(ROOT, 'test', 'fixtures', 'handler-map-convention'), 'handler-map-convention');
    assert.strictEqual(r.structuredContent.loaded, true, JSON.stringify(r));
    const call = await mcpCall(9607, KEY, r.structuredContent.toolNames[0], {name: 'x'});
    assert.strictEqual(call.isError, false, JSON.stringify(call));
    assert.ok(!/module sandbox: handler-map-convention (violation|would be refused)/.test(server.output), server.output.slice(-2000));
  });

  it('logs effective permissions and gives the worker only approved env', async () => {
    const policy = policyFile({modules: {'sandbox-probe': {env: {PROBE_FROM_POLICY: 'p', PROBE_FROM_SERVER: null}}}});
    server = await startServer(9607,
      ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', 'enforce', '--modulePolicy', policy],
      {env: {PROBE_FROM_SERVER: 's', PROBE_UNAPPROVED: 'u', PROBE_FROM_POLICY: 'server-loses'}});
    const r = await load(9607, PROBE, 'sandbox-probe');
    assert.strictEqual(r.structuredContent.loaded, true, JSON.stringify(r));
    assert.ok(server.output.includes('module sandbox: sandbox-probe effective permissions'), server.output.slice(-2000));
    const env = await mcpCall(9607, KEY, 'sandbox_probe_probeservice_env', {});
    assert.deepStrictEqual(env.structuredContent.output.env, {PROBE_FROM_POLICY: 'p', PROBE_FROM_SERVER: 's'});
  });

  it('re-reads the policy file when the module restarts', async () => {
    const policy = policyFile({modules: {'sandbox-probe': {env: {PROBE_FROM_POLICY: 'first'}}}});
    server = await startServer(9607,
      ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', 'enforce', '--modulePolicy', policy]);
    await load(9607, PROBE, 'sandbox-probe');
    fs.writeFileSync(policy, JSON.stringify({modules: {'sandbox-probe': {env: {PROBE_FROM_POLICY: 'second'}}}}));
    await require('../helpers/sandbox-server').post(9607, KEY, '/restart-module', {path: PROBE, name: 'sandbox-probe', version: '1.0.0'});
    const env = await require('../helpers/sandbox-server').waitFor(async () => {
      const r = await mcpCall(9607, KEY, 'sandbox_probe_probeservice_env', {});
      return r.isError === false && r.structuredContent.output.env.PROBE_FROM_POLICY === 'second' ? r : null;
    }, 20000, 'env after restart');
    assert.ok(env);
  });

  it('enforce without a policy entry gives a module that declares env none of it', async () => {
    server = await startServer(9607,
      ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', 'enforce'],
      {env: {PROBE_FROM_SERVER: 's'}});
    await load(9607, PROBE, 'sandbox-probe');
    const env = await mcpCall(9607, KEY, 'sandbox_probe_probeservice_env', {});
    assert.deepStrictEqual(env.structuredContent.output.env, {});
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx mocha --exit test/sandbox/04-load-time.js`
Expected: 6 failing — no refusal, no `module sandbox:` lines, and the env tests see the full server environment.

- [ ] **Step 4: Implement `lib/module-sandbox-config.js`**

```js
// Main thread: everything the module sandbox decides before a module's worker
// starts -- whether enforce refuses it, its effective permissions, the
// Worker's env and heap limit, and the lockdown config the worker receives on
// set-options (lib/module-lockdown.js). Re-reads package.json and the policy
// file on every call, so an edit takes effect on module restart.
const fs   = require('fs');
const path = require('path');

const modulePermissions = require('./module-permissions');
const modulePolicy      = require('./module-policy');
const moduleTreeCheck   = require('./module-tree-check');

function readPackage(modulePath) {
  try {
    return {pkg: JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json'), 'utf8')), error: null};
  } catch (e) {
    return {pkg: null, error: `package.json could not be read: ${e.message}`};
  }
}

// opts: {mode: 'off'|'audit'|'enforce', modulePolicy: file|null, serverEnv: object}
function build(modulePath, name, opts) {
  if (opts.mode === 'off') return null;

  const moduleRoot = fs.realpathSync(path.resolve(modulePath));
  const read = readPackage(moduleRoot);
  const parsed = modulePermissions.parseDeclaration(read.pkg);
  const tree = moduleTreeCheck.checkTree(moduleRoot);
  const problems = [].concat(read.error != null ? [read.error] : [], parsed.problems, tree.problems);

  let policy = modulePolicy.EMPTY;
  const notes = [];
  if (opts.modulePolicy != null) {
    try {
      policy = modulePolicy.load(opts.modulePolicy);
    } catch (e) {
      notes.push(`${e.message} -- using an empty policy for this spawn`);
    }
  }

  const entry = policy.modules[name] != null ? policy.modules[name] : null;
  const eff = modulePermissions.narrow(parsed.declared, entry, policy.limits, opts.mode);
  const env = modulePermissions.resolveEnv(eff.envNames, eff.envOverrides, opts.serverEnv);

  const summary = {fs: eff.fs, net: eff.net, env: Object.keys(env), limits: eff.limits};
  return {
    refusal: problems.length > 0 ? problems.join('; ') : null,
    notes: notes.concat(eff.ignored, tree.warnings.map((w) => `warning: ${w}`)),
    workerOptions: {env: env, resourceLimits: {maxOldGenerationSizeMb: eff.limits.heapMb}},
    lockdown: {mode: opts.mode, moduleName: name, moduleRoot: moduleRoot, net: eff.net},
    limits: eff.limits,
    logLine: `module sandbox: ${name} effective permissions ${JSON.stringify(summary)}`
  };
}

module.exports = {build};
```

- [ ] **Step 5: Wire it into `spawnModuleWorker`**

In `lib/module-manager.js`, add near the other requires:

```js
const moduleSandboxConfig = require('./module-sandbox-config');
```

Replace the first two lines of `ModuleManager.prototype.spawnModuleWorker`:

```js
  const worker = new Worker(`${__dirname}/sandbox.js`); //this is the name under release mode
  const workerMessage = new WorkerMessage(worker);
```

with:

```js
  let sandbox = null;
  try {
    sandbox = moduleSandboxConfig.build(modulePath, name,
      {mode: options.moduleSandbox, modulePolicy: options.modulePolicy, serverEnv: process.env});
  } catch (e) {
    return callback(new CHError('LOAD_MODULE_FAIL', name, e.message));
  }
  if (sandbox != null) {
    sandbox.notes.forEach((note) => LOG.I(`module sandbox: ${name}: ${note}`));
    if (sandbox.refusal != null) {
      if (options.moduleSandbox === 'enforce') {
        const refused = new CHError('MODULE_SANDBOX_REFUSED', name, sandbox.refusal);
        LOG.E(refused);
        return callback(refused);
      }
      LOG.I(`module sandbox: ${name} would be refused under enforce: ${sandbox.refusal}`);
    }
    LOG.I(sandbox.logLine);
  }

  const worker = new Worker(`${__dirname}/sandbox.js`, sandbox != null ? sandbox.workerOptions : undefined); //this is the name under release mode
  const workerMessage = new WorkerMessage(worker);
  workerMessage.sandboxLimits = sandbox != null ? sandbox.limits : null;
```

and change the `sendSetOptionsMessage` call in the same function from `{options: options.getOptions()}` to `{options: options.getOptions(), sandbox: sandbox != null ? sandbox.lockdown : null}`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx mocha --exit test/sandbox/04-load-time.js test/module-loading/12-reload-fresh-code.js`
Expected: all passing. (Lockdown is not installed yet; this task only decides and passes the config.)

- [ ] **Step 7: Commit**

```bash
git add lib/module-sandbox-config.js lib/module-manager.js test/fixtures/sandbox-probe test/fixtures/sandbox-native test/sandbox/04-load-time.js
git commit -m "feat(sandbox): per-module config at worker spawn -- refusal, env, heap limit"
```

---

### Task 5: Worker lockdown

**Files:**
- Create: `lib/module-lockdown.js`
- Modify: `lib/sandbox.js` (`set-options` case)
- Modify: `lib/worker-message.js` (worker → main `sandbox-violation`; main-side handling)
- Modify: `lib/module-manager.js` (`spawnModuleWorker`: listen for violations)
- Test: `test/sandbox/05-lockdown.js`

**Interfaces:**
- Consumes: the `set-options` message's `sandbox` field (Task 4): `{mode, moduleName, moduleRoot, net}`; `modulePermissions.hostAllowed` (Task 2).
- Produces: `moduleLockdown.install(cfg, report)` where `report(rule, target)` is called once per distinct (rule, target).
- Produces: `WorkerMessage.prototype.sendSandboxViolationToParent(rule, target)` (worker side, no reply); main side emits `'sandbox-violation'` with `({rule, target}, workerMessage)`.
- Produces: `workerMessage.violationCount` (integer, main side), read by Task 7's status.

Two facts measured on Node v24.21 that shape this code:
- A `module.registerHooks` resolve hook runs on **every** `require` of a built-in, even one already loaded, but a cached relative file `require` skips it. So blocked built-ins are blocked for all code in the worker after lockdown (robust), and countinghouse's own worker code must not lazily `require` a blocked built-in after lockdown — the composition test in Step 1 catches that.
- `process.getBuiltinModule()` bypasses resolve hooks, so it is overridden directly.

The file boundary is applied when the requiring file is inside the module root. A module can still borrow countinghouse's already-loaded modules through `require.cache` or `module.constructor.createRequire` — the spec's accepted gap ("A module that obtains an object countinghouse loaded before lockdown can reach the originals"); Task 10's docs name these two routes.

- [ ] **Step 1: Write the failing test**

Create `test/sandbox/05-lockdown.js`:

```js
// Every route the lockdown controls, under enforce (blocked, logged) and audit
// (allowed, logged once). Plus Review Focus 2: a full composition scenario
// under enforce, so countinghouse's own worker code is proven not to trip the
// built-in block.
const assert = require('assert');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');

const KEY   = 'aabbcc';
const PROBE = path.join(ROOT, 'test', 'fixtures', 'sandbox-probe');
const TOOL  = 'sandbox_probe_probeservice_attempt';
const OUTSIDE_FILE = path.join(ROOT, 'lib', 'cli-options.js');

const ROUTES = [
  ['dlopen'], ['binding'], ['kill'], ['getBuiltinModule'], ['child_process'], ['worker_threads'],
  ['v8'], ['registerHooks'], ['nodePath'], ['loadFileOutside', OUTSIDE_FILE], ['request', 'http://127.0.0.1:1/']
];

function serverArgs(mode) {
  return ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', mode, '--loadModule', PROBE];
}

describe('sandbox 05: worker lockdown', function() {
  this.timeout(120000);

  describe('enforce', () => {
    let server = null;
    before(async () => { server = await startServer(9608, serverArgs('enforce')); });
    after(() => stopServer(server));

    ROUTES.forEach(([what, arg]) => {
      it(`blocks ${what} and logs it`, async () => {
        const r = await mcpCall(9608, KEY, TOOL, arg != null ? {what: what, arg: arg} : {what: what});
        assert.strictEqual(r.isError, false, JSON.stringify(r));
        assert.strictEqual(r.structuredContent.output.outcome, 'blocked', `${what}: ${JSON.stringify(r.structuredContent)}`);
        assert.ok(server.output.includes('module sandbox: sandbox-probe violation'), server.output.slice(-2000));
      });
    });

    it('uses Node\'s own error codes', async () => {
      const notFound = await mcpCall(9608, KEY, TOOL, {what: 'child_process'});
      assert.strictEqual(notFound.structuredContent.output.code, 'MODULE_NOT_FOUND');
      const denied = await mcpCall(9608, KEY, TOOL, {what: 'kill'});
      assert.strictEqual(denied.structuredContent.output.code, 'ERR_ACCESS_DENIED');
    });
  });

  describe('audit', () => {
    let server = null;
    before(async () => { server = await startServer(9609, serverArgs('audit')); });
    after(() => stopServer(server));

    ROUTES.forEach(([what, arg]) => {
      it(`allows ${what} and logs it`, async () => {
        const r = await mcpCall(9609, KEY, TOOL, arg != null ? {what: what, arg: arg} : {what: what});
        assert.strictEqual(r.structuredContent.output.outcome, 'allowed', `${what}: ${JSON.stringify(r.structuredContent)}`);
      });
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
      assert.strictEqual(r.structuredContent.output.n, 42, JSON.stringify(r));
      assert.ok(!/violation builtin/.test(server.output), server.output.slice(-3000));
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx mocha --exit test/sandbox/05-lockdown.js`
Expected: the enforce `blocks ...` cases fail with `outcome: 'allowed'`; audit cases pass already; "logs a repeated violation once" fails (no lines).

- [ ] **Step 3: Implement `lib/module-lockdown.js`**

```js
// Worker side of the module sandbox: runs once, on set-options, before any
// module code loads (lib/sandbox.js). Design: docs/superpowers/specs/
// 2026-10-15-module-sandbox-foundation-design.md, section 3.
//
// In enforce a violation throws the error Node itself would throw; in audit it
// is reported and the original runs. Either way report() hears about it once.
//
// This is a barrier inside the same process, not a boundary: see the spec's
// "What this can and cannot promise".
const Module = require('module');
const path   = require('path');
const url    = require('url');

const modulePermissions = require('./module-permissions');

const BLOCKED = new Set(['child_process', 'cluster', 'worker_threads', 'inspector', 'inspector/promises', 'wasi', 'v8']);
const WATCHED = new Set(['fs', 'fs/promises', 'net', 'tls', 'http', 'https', 'http2', 'dgram', 'dns', 'dns/promises']);
const PROCESS_CONTROLS = ['kill', 'abort', 'chdir', 'setuid', 'setgid', 'seteuid', 'setegid', 'setgroups', 'initgroups'];
const REDUCED_MODULE   = Symbol.for('countinghouse.lockdown.module');
const SANDBOX_TAG      = '(countinghouse module sandbox)';

function bare(specifier) {
  return specifier.startsWith('node:') ? specifier.slice(5) : specifier;
}

function accessDenied(what, moduleName) {
  const err = new Error(`${what} is not allowed for module ${moduleName} ${SANDBOX_TAG}`);
  err.code = 'ERR_ACCESS_DENIED';
  return err;
}

function notFound(specifier) {
  const err = new Error(`Cannot find module '${specifier}' ${SANDBOX_TAG}`);
  err.code = 'MODULE_NOT_FOUND';
  return err;
}

function lock(obj, key, value) {
  Object.defineProperty(obj, key, {value: value, writable: false, configurable: false, enumerable: false});
}

function install(cfg, report) {
  const enforce = (cfg.mode === 'enforce');
  const name    = cfg.moduleName;
  const root    = path.resolve(cfg.moduleRoot);
  const seen    = new Set();

  const once = (rule, target) => {
    const key = `${rule}\0${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    report(rule, target);
  };
  const violate = (rule, target, makeError) => {
    once(rule, target);
    if (enforce) throw makeError();
  };
  const inside = (file) => file === root || file.startsWith(root + path.sep);
  const fromModule = (parentURL) => {
    if (typeof(parentURL) !== 'string' || !parentURL.startsWith('file:')) return false;
    try { return inside(url.fileURLToPath(parentURL)); } catch (e) { return false; }
  };

  // 1. Native code.
  const dlopen = process.dlopen;
  lock(process, 'dlopen', function(mod, filename) {
    violate('native', String(filename), () => accessDenied('loading native code', name));
    return dlopen.apply(process, arguments);
  });
  const nodeLoader = Module._extensions['.node'];
  Module._extensions['.node'] = function(mod, filename) {
    violate('native', String(filename), () => accessDenied('loading native code', name));
    return nodeLoader.apply(this, arguments);
  };
  Object.defineProperty(Module._extensions, '.node', {writable: false, configurable: false});
  ['binding', '_linkedBinding'].forEach((key) => {
    const original = process[key];
    lock(process, key, function(id) {
      violate(`process.${key}`, String(id), () => accessDenied(`process.${key}`, name));
      return original.apply(process, arguments);
    });
  });

  // 2. Process controls. process.exit stays: in a worker it ends only this module.
  PROCESS_CONTROLS.forEach((key) => {
    const original = process[key];
    if (typeof(original) !== 'function') return;
    lock(process, key, function() {
      violate(`process.${key}`, key, () => accessDenied(`process.${key}`, name));
      return original.apply(process, arguments);
    });
  });

  // 4 (reduced `module`). Served in enforce in place of the real one.
  globalThis[REDUCED_MODULE] = Object.freeze({
    builtinModules: Module.builtinModules.slice(),
    isBuiltin:      Module.isBuiltin,
    createRequire:  (from) => Module.createRequire(from)
  });

  const getBuiltinModule = process.getBuiltinModule;
  if (typeof(getBuiltinModule) === 'function') {
    lock(process, 'getBuiltinModule', function(id) {
      const b = bare(String(id));
      if (BLOCKED.has(b)) violate('builtin', b, () => accessDenied(`the ${b} module`, name));
      if (b === 'module' && enforce) return globalThis[REDUCED_MODULE];
      return getBuiltinModule.call(process, id);
    });
  }

  // 3 and 4. The require boundary and blocked built-ins.
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const b = bare(specifier);
      const moduleCode = fromModule(context.parentURL);
      if (Module.isBuiltin(specifier)) {
        // Blocked for every caller: hooks run on each built-in require, and
        // countinghouse's own worker code took what it needs before lockdown.
        if (BLOCKED.has(b)) violate('builtin', b, () => notFound(specifier));
        if (moduleCode && WATCHED.has(b)) once('uses', b);
        if (moduleCode && b === 'module' && enforce) {
          return {url: 'countinghouse-lockdown:module', format: 'commonjs', shortCircuit: true};
        }
        return nextResolve(specifier, context);
      }
      const resolved = nextResolve(specifier, context);
      if (moduleCode && typeof(resolved.url) === 'string' && resolved.url.startsWith('file:') &&
          !inside(url.fileURLToPath(resolved.url))) {
        violate('require', specifier, () => notFound(specifier));
      }
      return resolved;
    },
    load(hookUrl, context, nextLoad) {
      if (hookUrl === 'countinghouse-lockdown:module') {
        return {format: 'commonjs', shortCircuit: true,
                source: 'module.exports = globalThis[Symbol.for("countinghouse.lockdown.module")];'};
      }
      return nextLoad(hookUrl, context);
    }
  });
  // No later hook may run ahead of ours.
  ['registerHooks', 'register'].forEach((key) => {
    lock(Module, key, function() {
      violate(`module.${key}`, key, () => accessDenied(`module.${key}`, name));
    });
  });

  // 5. CHUtil's own routes out (global in every worker, lib/sandbox.js).
  const CHUtil = global.CHUtil;
  if (CHUtil != null) {
    const loadFile = CHUtil.loadFile;
    lock(CHUtil, 'loadFile', function(file) {
      const resolved = path.resolve(String(file));
      if (!inside(resolved)) violate('loadFile', resolved, () => notFound(resolved));
      return loadFile.call(CHUtil, file);
    });
    const checkUrl = (target) => {
      let host = null;
      let port = null;
      try {
        const u = new URL(typeof(target) === 'string' ? target : (target.url || target.uri || target.href));
        host = u.hostname;
        port = u.port !== '' ? parseInt(u.port) : (u.protocol === 'https:' ? 443 : 80);
      } catch (e) {
        host = null;
      }
      if (host == null || !modulePermissions.hostAllowed(cfg.net, host, port)) {
        once('net', `${host}:${port}`);
        if (enforce) return accessDenied(`network access to ${host}:${port}`, name);
      }
      return null;
    };
    const request = CHUtil.request;
    lock(CHUtil, 'request', function(opts, callback) {
      const denied = checkUrl(opts);
      if (denied != null) return process.nextTick(() => callback(denied));
      return request.call(CHUtil, opts, callback);
    });
    const createSOAPClient = CHUtil.createSOAPClient;
    lock(CHUtil, 'createSOAPClient', function(target, opts, callback) {
      const denied = checkUrl(target);
      if (denied != null) return process.nextTick(() => callback(denied));
      return createSOAPClient.call(CHUtil, target, opts, callback);
    });
  }
}

module.exports = {install};
```

- [ ] **Step 4: Install it from `lib/sandbox.js` and report violations**

In `lib/worker-message.js`, add after `sendPeerSelfInvalidateToParent`:

```js
// invoke in child thread only: a module sandbox violation (lib/module-
// lockdown.js), already de-duplicated there. No reply.
WorkerMessage.prototype.sendSandboxViolationToParent = function(rule, target) {
  const id = this.msgID;
  this.msgID++;
  parentPort.postMessage({id: id, category: 'child', command: 'sandbox-violation', errMsg: null,
                          data: {rule: rule, target: target}});
};
```

and in `onWorkerMessage`'s `switch (msg.command)`, add:

```js
      case 'sandbox-violation': {
        this.emit('sandbox-violation', msg.data, this);
        break;
      }
```

In `lib/sandbox.js`, in the `set-options` case, after the release-mode console block and before `return wm.sendMessageToParent(msg.id, null, null);`:

```js
        // Module sandbox: lock this worker down before any module code loads.
        // msg.sandbox is null under --moduleSandbox off.
        if (msg.sandbox != null) {
          require('./module-lockdown').install(msg.sandbox, (rule, target) => {
            wm.sendSandboxViolationToParent(rule, target);
          });
        }
```

In `lib/module-manager.js` `spawnModuleWorker`, after `workerMessage.sandboxLimits = ...`:

```js
  workerMessage.violationCount = 0;
  workerMessage.on('sandbox-violation', (data) => {
    // 'uses' is information, not a violation: the first require of fs, net
    // and the like, which will need declared permissions once the brokers
    // (parts 2 and 3) ship.
    if (data.rule === 'uses') {
      return LOG.I(`module sandbox: ${name} uses ${data.target} -- it will need fs/net permissions once the broker ships`);
    }
    workerMessage.violationCount++;
    LOG.I(`module sandbox: ${name} violation ${data.rule} ${data.target} (${options.moduleSandbox === 'enforce' ? 'blocked' : 'allowed, audit'})`);
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx mocha --exit test/sandbox/05-lockdown.js test/sandbox/04-load-time.js test/module-loading/12-reload-fresh-code.js`
Expected: all passing. If the composition case logs `violation builtin <name>`, the log line names the built-in: find the countinghouse file that requires it lazily (`grep -rn "require('<name>')" lib`), move that `require` to the file's top so it runs before lockdown, and re-run.

- [ ] **Step 6: Commit**

```bash
git add lib/module-lockdown.js lib/sandbox.js lib/worker-message.js lib/module-manager.js test/sandbox/05-lockdown.js
git commit -m "feat(sandbox): worker lockdown -- native code, process controls, require boundary, CHUtil"
```

---

### Task 6: The restart supervisor

**Files:**
- Create: `lib/module-supervisor.js`
- Test: `test/sandbox/06-supervisor.js`

**Interfaces:**
- Produces: `new ModuleSupervisor({now, setTimer, clearTimer, restart, log})` — all optional except `restart(name, record)`; defaults are `Date.now`, `setTimeout`, `clearTimeout`, and a no-op log.
- Produces methods:
  - `track(name, {modulePath, version})` — remember how to restart a running module; state becomes `running`.
  - `exited(name, reason, deviceSpecs)` — record an unexpected exit; returns `{action: 'restart', delayMs, at}` or `{action: 'suspend'}`; schedules `restart(name, record)` after `delayMs`.
  - `backoffFor(nthExit) -> delayMs` — `min(1000 * 2^(n-1), 60000)`.
  - `clear(name)` — an operator acted (unload, restart, reload, load): cancel any pending restart, reset history, drop retained specs.
  - `errorForDevice(deviceID) -> {code: 'MODULE_RESTARTING'|'MODULE_SUSPENDED', module, reason, retryAt|null} | null`.
  - `retainedSpecs() -> {deviceID: spec}`.
  - `status(name) -> {state, lastReason, exits: [{at, reason}], nextRestartAt} | null`.
- Produces constants: `BACKOFF_BASE_MS = 1000`, `BACKOFF_MAX_MS = 60000`, `SUSPEND_AFTER = 3`, `WINDOW_MS = 600000`.

- [ ] **Step 1: Write the failing test**

Create `test/sandbox/06-supervisor.js`:

```js
// Restart, backoff and suspend as pure logic, on a fake clock.
const assert = require('assert');
const ModuleSupervisor = require('../../lib/module-supervisor');

function harness() {
  const h = {t: 0, timers: [], restarts: []};
  h.sup = new ModuleSupervisor({
    now: () => h.t,
    setTimer: (fn, ms) => { const timer = {fn: fn, at: h.t + ms, cancelled: false}; h.timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer != null) timer.cancelled = true; },
    restart: (name, record) => h.restarts.push({name: name, at: h.t, modulePath: record.modulePath})
  });
  h.advance = (ms) => {
    h.t += ms;
    h.timers.filter((x) => !x.cancelled && x.at <= h.t).forEach((x) => { x.cancelled = true; x.fn(); });
  };
  return h;
}

const SPECS = {dev1: {device: {friendlyName: 'm'}}};

describe('sandbox 06: module supervisor', () => {
  it('restarts after 1 s, then 2 s, and suspends on the third exit', () => {
    const h = harness();
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    assert.deepStrictEqual(h.sup.exited('m', 'crash: boom', SPECS), {action: 'restart', delayMs: 1000, at: 1000});
    h.advance(1000);
    assert.deepStrictEqual(h.restarts, [{name: 'm', at: 1000, modulePath: '/m'}]);
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    assert.strictEqual(h.sup.exited('m', 'heap limit', SPECS).delayMs, 2000);
    h.advance(2000);
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    assert.deepStrictEqual(h.sup.exited('m', 'blocked event loop', SPECS), {action: 'suspend'});
    assert.strictEqual(h.sup.status('m').state, 'suspended');
    h.advance(120000);
    assert.strictEqual(h.restarts.length, 2);
  });

  it('caps the delay at 60 s', () => {
    const h = harness();
    const sup = new ModuleSupervisor({now: () => 0, setTimer: () => null, clearTimer: () => {}, restart: () => {}});
    assert.strictEqual(sup.backoffFor(7), 60000);
    assert.strictEqual(h.sup.backoffFor(1), 1000);
  });

  it('forgets exits older than 10 minutes', () => {
    const h = harness();
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    h.sup.exited('m', 'crash: a', SPECS);
    h.advance(1000);
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    h.sup.exited('m', 'crash: b', SPECS);
    h.advance(600001);
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    assert.strictEqual(h.sup.exited('m', 'crash: c', SPECS).delayMs, 1000);
  });

  it('answers calls for a restarting or suspended module\'s devices', () => {
    const h = harness();
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    h.sup.exited('m', 'crash: boom', SPECS);
    assert.deepStrictEqual(h.sup.errorForDevice('dev1'),
      {code: 'MODULE_RESTARTING', module: 'm', reason: 'crash: boom', retryAt: 1000});
    assert.deepStrictEqual(h.sup.retainedSpecs(), SPECS);
    assert.strictEqual(h.sup.errorForDevice('other'), null);
  });

  it('clear() cancels a pending restart and resets the history', () => {
    const h = harness();
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    h.sup.exited('m', 'crash: a', SPECS);
    h.sup.clear('m');
    h.advance(5000);
    assert.strictEqual(h.restarts.length, 0);
    assert.strictEqual(h.sup.errorForDevice('dev1'), null);
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    assert.strictEqual(h.sup.exited('m', 'crash: b', SPECS).delayMs, 1000);
  });

  it('track() after a restart keeps the history but marks the module running', () => {
    const h = harness();
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    h.sup.exited('m', 'crash: a', SPECS);
    h.advance(1000);
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    const s = h.sup.status('m');
    assert.strictEqual(s.state, 'running');
    assert.strictEqual(s.exits.length, 1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx mocha --exit test/sandbox/06-supervisor.js`
Expected: FAIL at load with `Cannot find module '../../lib/module-supervisor'`.

- [ ] **Step 3: Implement `lib/module-supervisor.js`**

```js
// What happens after a module's worker exits unexpectedly -- a resource
// limit kill or a crash (docs/superpowers/specs/2026-10-15-module-sandbox-
// foundation-design.md, section 4): restart with backoff, suspend after
// repeated exits, and answer calls meanwhile with MODULE_RESTARTING or
// MODULE_SUSPENDED instead of an unknown device. Pure apart from the injected
// clock and timers, so the policy is tested on a fake clock
// (test/sandbox/06-supervisor.js). Deliberate exits never reach this: an
// operator action calls clear().
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS  = 60000;
const SUSPEND_AFTER   = 3;
const WINDOW_MS       = 10 * 60 * 1000;

function ModuleSupervisor(opts) {
  opts = opts || {};
  this.now        = opts.now        || Date.now;
  this.setTimer   = opts.setTimer   || setTimeout;
  this.clearTimer = opts.clearTimer || clearTimeout;
  this.restart    = opts.restart;
  this.log        = opts.log        || function() {};
  this.records    = {};   // name -> record
}

ModuleSupervisor.prototype.backoffFor = function(nthExit) {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, nthExit - 1), BACKOFF_MAX_MS);
};

ModuleSupervisor.prototype.recordFor = function(name) {
  if (this.records[name] == null) {
    this.records[name] = {state: 'running', modulePath: null, version: null, exits: [],
                          lastReason: null, nextRestartAt: null, timer: null, specs: {}};
  }
  return this.records[name];
};

ModuleSupervisor.prototype.track = function(name, info) {
  const r = this.recordFor(name);
  r.modulePath = info.modulePath;
  r.version    = info.version;
  r.state      = 'running';
  r.nextRestartAt = null;
  r.specs      = {};
};

ModuleSupervisor.prototype.exited = function(name, reason, deviceSpecs) {
  const r = this.recordFor(name);
  const now = this.now();
  r.exits = r.exits.filter((e) => now - e.at <= WINDOW_MS);
  r.exits.push({at: now, reason: reason});
  r.lastReason = reason;
  r.specs = Object.assign({}, deviceSpecs || {});

  if (r.exits.length >= SUSPEND_AFTER) {
    r.state = 'suspended';
    r.nextRestartAt = null;
    return {action: 'suspend'};
  }

  const delayMs = this.backoffFor(r.exits.length);
  r.state = 'restarting';
  r.nextRestartAt = now + delayMs;
  r.timer = this.setTimer(() => {
    r.timer = null;
    if (r.state === 'restarting') this.restart(name, r);
  }, delayMs);
  return {action: 'restart', delayMs: delayMs, at: r.nextRestartAt};
};

ModuleSupervisor.prototype.clear = function(name) {
  const r = this.records[name];
  if (r == null) return;
  if (r.timer != null) this.clearTimer(r.timer);
  delete this.records[name];
};

ModuleSupervisor.prototype.errorForDevice = function(deviceID) {
  for (const name in this.records) {
    const r = this.records[name];
    if (r.state === 'running' || r.specs[deviceID] == null) continue;
    return {code: r.state === 'suspended' ? 'MODULE_SUSPENDED' : 'MODULE_RESTARTING',
            module: name, reason: r.lastReason, retryAt: r.nextRestartAt};
  }
  return null;
};

ModuleSupervisor.prototype.retainedSpecs = function() {
  const out = {};
  for (const name in this.records) {
    const r = this.records[name];
    if (r.state !== 'running') Object.assign(out, r.specs);
  }
  return out;
};

ModuleSupervisor.prototype.status = function(name) {
  const r = this.records[name];
  if (r == null) return null;
  return {state: r.state, lastReason: r.lastReason, exits: r.exits.slice(), nextRestartAt: r.nextRestartAt};
};

ModuleSupervisor.BACKOFF_BASE_MS = BACKOFF_BASE_MS;
ModuleSupervisor.BACKOFF_MAX_MS  = BACKOFF_MAX_MS;
ModuleSupervisor.SUSPEND_AFTER   = SUSPEND_AFTER;
ModuleSupervisor.WINDOW_MS       = WINDOW_MS;

module.exports = ModuleSupervisor;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx mocha --exit test/sandbox/06-supervisor.js`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/module-supervisor.js test/sandbox/06-supervisor.js
git commit -m "feat(sandbox): restart supervisor -- backoff, suspend, retained device specs"
```

---

### Task 7: Restart wiring — crashes, in-flight calls, retained tools, status

**Files:**
- Modify: `lib/module-manager.js` (constructor, `spawnModuleWorker`, `loadModuleByWorker`, `restartModule`, `unloadModuleExternal`, `getModuleDeviceListByName`)
- Modify: `lib/device-manager.js` (`getAllDeviceSpecs`, `ensureDeviceState`)
- Create: `test/fixtures/sandbox-hog/` (used by Tasks 7 and 8)
- Test: `test/sandbox/07-restart.js`

**Interfaces:**
- Consumes: `ModuleSupervisor` (Task 6); `workerMessage.violationCount` (Task 5).
- Produces: `mm.supervisor` (a `ModuleSupervisor`, or `null` under `off`); `workerMessage.killReason` (string|null) — set by Task 8 before it terminates a worker, read by the exit handler here.
- Produces: the admin route `POST /get-module-device-list` answers `{packageInfo, deviceList, sandbox}` where `sandbox` is `{state, lastReason, exits, nextRestartAt, violations}` or `null`; for a module that is restarting or suspended it answers `{packageInfo: {name}, deviceList: [], sandbox}` instead of `unknown module name`.

- [ ] **Step 1: Create the hog fixture**

`test/fixtures/sandbox-hog/package.json`:

```json
{
  "name": "sandbox-hog",
  "version": "1.0.0",
  "countinghouse": {"permissions": {"limits": {"heapMb": 64, "externalMb": 64, "maxBlockMs": 2000}}}
}
```

`test/fixtures/sandbox-hog/api.json`: same shape as `sandbox-probe`'s, `friendlyName` `sandbox-hog`, service `urn:countinghouse-test:serviceID:hogService` with actions `ping`, `heap`, `external`, `block`, `exit`, `flood`, each with input schema `/hogService/<action>/input` and output `/hogService/<action>/output`.

`test/fixtures/sandbox-hog/schema.json`: `hogService.<action>.input` = `{"type": "object"}` for every action; outputs: `ping`/`external`/`exit` = `{"type": "object", "properties": {"ok": {"type": "boolean"}}}`, `flood` = `{"type": "object", "properties": {"limited": {"type": "integer"}, "total": {"type": "integer"}}}`, `heap`/`block` = `{"type": "object"}` (they never return).

Handlers, one file each under `test/fixtures/sandbox-hog/handlers/hogService/`:

```js
// ping.js -- proves the module is up.
module.exports = async () => ({output: {ok: true}});
```

```js
// heap.js -- grows the JS heap until V8 stops the worker (heapMb).
module.exports = async () => {
  const keep = [];
  for (;;) keep.push(new Array(1e6).fill(1));
};
```

```js
// external.js -- holds Buffers outside the JS heap, past externalMb; the main
// thread's poll terminates the worker within about a second.
module.exports = async () => {
  globalThis.__hogKeep = [];
  for (let i = 0; i < 16; i++) globalThis.__hogKeep.push(Buffer.alloc(8 * 1024 * 1024, 1));
  return {output: {ok: true}};
};
```

```js
// block.js -- blocks the event loop for good; the heartbeat (maxBlockMs)
// terminates the worker.
module.exports = async () => {
  for (;;) { /* spin */ }
};
```

There is deliberately no "throw an uncaught exception" action: `lib/sandbox.js` installs a `process.on('uncaughtException')` handler that logs and keeps the worker alive, so an uncaught exception never ends a worker today. The crash path this task covers is the worker ending — `process.exit()` here, a worker `error` event (as for the heap limit) in Task 8.

```js
// exit.js -- process.exit after answering; in a worker it ends only the module.
module.exports = async () => {
  setTimeout(() => process.exit(3), 50);
  return {output: {ok: true}};
};
```

```js
// flood.js -- many Redis commands at once, each a message to the main thread;
// with a low --moduleMessageRate most come back RATE_LIMITED.
module.exports = async () => {
  const total = 500;
  const results = await Promise.all(Array.from({length: total}, () => new Promise((resolve) => {
    CHUtil.redis.get('sandbox-hog-flood', (err) => resolve(err != null && err.code === 'RATE_LIMITED'));
  })));
  return {output: {limited: results.filter(Boolean).length, total: total}};
};
```

- [ ] **Step 2: Write the failing test**

Create `test/sandbox/07-restart.js`:

```js
// Unexpected worker exits restart with backoff and suspend; calls meanwhile
// get MODULE_RESTARTING / MODULE_SUSPENDED; the tool stays listed; operator
// actions never count (Review Focus 4); off keeps today's behaviour.
const assert = require('assert');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');

const KEY  = 'aabbcc';
const HOG  = path.join(ROOT, 'test', 'fixtures', 'sandbox-hog');
const tool = (action) => `sandbox_hog_hogservice_${action}`;

async function status(port) {
  const r = await post(port, KEY, '/get-module-device-list', {name: 'sandbox-hog'});
  return r.body != null ? r.body.sandbox : null;
}

async function listed(port) {
  const r = await new Promise((resolve, reject) => {
    require('supertest')(`http://127.0.0.1:${port}`).post('/mcp').set('X-CH-Key', KEY)
      .send({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}})
      .end((err, res) => (err ? reject(err) : resolve(res.body.result.tools.map((t) => t.name))));
  });
  return r.indexOf(tool('ping')) !== -1;
}

const pingOk = (port) => async () => {
  const r = await mcpCall(port, KEY, tool('ping'), {});
  return r.isError === false;
};

describe('sandbox 07: restart and suspend', function() {
  this.timeout(120000);

  describe('under audit', () => {
    let server = null;
    before(async () => {
      server = await startServer(9611, ['--debug', '--debugKey', KEY, '--workerThread', '--loadModule', HOG]);
    });
    after(() => stopServer(server));

    it('restarts a module whose worker exited, and answers MODULE_RESTARTING meanwhile with the tool still listed', async () => {
      await mcpCall(9611, KEY, tool('exit'), {});
      const during = await waitFor(async () => {
        const r = await mcpCall(9611, KEY, tool('ping'), {});
        return r.isError === true && r.structuredContent.code === 'MODULE_RESTARTING' ? r : null;
      }, 5000, 'MODULE_RESTARTING');
      assert.ok(during);
      assert.strictEqual(await listed(9611), true);
      await waitFor(pingOk(9611), 15000, 'ping after restart');
      const s = await status(9611);
      assert.strictEqual(s.state, 'running');
      assert.strictEqual(s.exits[0].reason, 'exit code 3');
    });

    it('suspends after the third exit in the window', async () => {
      await mcpCall(9611, KEY, tool('exit'), {});
      await waitFor(pingOk(9611), 15000, 'second restart');
      await mcpCall(9611, KEY, tool('exit'), {});
      const s = await waitFor(async () => {
        const st = await status(9611);
        return st != null && st.state === 'suspended' ? st : null;
      }, 10000, 'suspended');
      assert.strictEqual(s.exits.length, 3);
      const r = await mcpCall(9611, KEY, tool('ping'), {});
      assert.strictEqual(r.structuredContent.code, 'MODULE_SUSPENDED');
      assert.strictEqual(await listed(9611), true);
      assert.ok(server.output.includes('module sandbox: sandbox-hog suspended'), server.output.slice(-2000));
    });

    it('an operator restart clears the suspension', async () => {
      await post(9611, KEY, '/restart-module', {path: HOG, name: 'sandbox-hog', version: '1.0.0'});
      await waitFor(pingOk(9611), 15000, 'ping after operator restart');
      const s = await status(9611);
      assert.strictEqual(s.state, 'running');
      assert.strictEqual(s.exits.length, 0);
    });

    // Review Focus 4.
    it('operator restarts, reloads and loads never count, even mid-restart', async () => {
      await mcpCall(9611, KEY, tool('exit'), {});
      await waitFor(async () => ((await status(9611)) || {}).state === 'restarting', 5000, 'restarting');
      await post(9611, KEY, '/restart-module', {path: HOG, name: 'sandbox-hog', version: '1.0.0'});
      await waitFor(pingOk(9611), 15000, 'ping');
      for (let i = 0; i < 3; i++) {
        await post(9611, KEY, '/reload-module', {path: HOG});
        await waitFor(pingOk(9611), 15000, `ping after reload ${i}`);
      }
      const s = await status(9611);
      assert.strictEqual(s.state, 'running');
      assert.strictEqual(s.exits.length, 0);
    });
  });

  describe('under off', () => {
    let server = null;
    before(async () => {
      server = await startServer(9612, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', 'off', '--loadModule', HOG]);
    });
    after(() => stopServer(server));

    it('a module whose worker exited stays down, as before', async () => {
      await mcpCall(9612, KEY, tool('exit'), {});
      await new Promise((resolve) => setTimeout(resolve, 4000));
      const r = await mcpCall(9612, KEY, tool('ping'), {});
      assert.notStrictEqual(r.isError, false, JSON.stringify(r));
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx mocha --exit test/sandbox/07-restart.js`
Expected: the audit cases fail (the module stays down; the tool disappears from `tools/list`; `sandbox` is undefined in the status). The `off` case passes already.

- [ ] **Step 4: Create the supervisor in the ModuleManager**

In `lib/module-manager.js` add near the other requires:

```js
const ModuleSupervisor = require('./module-supervisor');
```

In the `ModuleManager` constructor, after `this.noofLoadedModules = 0;`:

```js
  // Restart policy for unexpected worker exits (lib/module-supervisor.js).
  // Main thread, worker mode, sandbox on only; null otherwise, which keeps
  // today's "a crashed module stays down".
  this.supervisor = (isMainThread === true && options.workerThread === true && options.moduleSandbox !== 'off')
    ? new ModuleSupervisor({
      restart: (name, record) => {
        LOG.I(`module sandbox: ${name} restarting after: ${record.lastReason}`);
        this.spawnModuleWorker(record.modulePath, name, record.version, (err) => {
          if (err != null) LOG.E(new CHError('LOAD_MODULE_FAIL', name, err.message));
        });
      }
    })
    : null;
```

- [ ] **Step 5: Route unexpected exits through it**

In `spawnModuleWorker`, replace the two worker handlers:

```js
  worker.on('error', (err) => {
    // in case of uncaught exception, work will exit here, we should clean up it
    LOG.E(new Error(`worker exit on error: ${err.message}`));
    if (isCurrent()) this.unloadModule(name, `ERROR MESSAGE FROM WORKER: ${err.message}`, () => {});
  });

  worker.on('exit', (exitCode) => {
    // in case of uncaught exception, work will exit here, we should clean up it
    LOG.E(new Error(`worker exit with code: ${exitCode}`));
    if (isCurrent()) this.unloadModule(name, `WORKER EXIT WITH CODE: ${exitCode}`, () => {});
  });
```

with:

```js
  // 'error' and 'exit' both fire for one crash; the first decides the reason.
  let exitReason = null;
  const onUnexpectedExit = (reason) => {
    if (exitReason != null) return;
    exitReason = workerMessage.killReason || reason;
    if (!isCurrent()) return;   // a deliberate unload already took the module off this worker

    // Fail calls in flight now instead of at their timeout.
    const pending = workerMessage.msgQueue;
    workerMessage.msgQueue = {};
    Object.keys(pending).forEach((id) => {
      const err = new CHError('MODULE_RESTARTING', name, exitReason);
      if (typeof(pending[id]) === 'function') pending[id](err, null);
    });

    const specs = Object.assign({}, workerMessage.deviceList);
    this.unloadModule(name, `WORKER EXIT: ${exitReason}`, () => {
      if (this.supervisor == null) return;
      const decision = this.supervisor.exited(name, exitReason, specs);
      if (decision.action === 'suspend') {
        LOG.E(new Error(`module sandbox: ${name} suspended after repeated exits: ${
          JSON.stringify(this.supervisor.status(name).exits)} -- POST /restart-module to start it again`));
      } else {
        LOG.I(`module sandbox: ${name} exited (${exitReason}); restarting in ${decision.delayMs} ms`);
      }
    });
  };

  worker.on('error', (err) => {
    LOG.E(new Error(`worker exit on error: ${err.message}`));
    onUnexpectedExit(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'heap limit' : `crash: ${err.message}`);
  });

  worker.on('exit', (exitCode) => {
    LOG.E(new Error(`worker exit with code: ${exitCode}`));
    onUnexpectedExit(`exit code ${exitCode}`);
  });
```

Add `workerMessage.killReason = null;` beside `workerMessage.violationCount = 0;`.

In the success branch of `sendLoadModuleMessage` inside `spawnModuleWorker`, before `this.emit('workerloaded', workerMessage);`:

```js
      if (this.supervisor != null) this.supervisor.track(name, {modulePath: modulePath, version: version});
```

- [ ] **Step 6: Operator actions clear the supervisor**

In `ModuleManager.prototype.loadModuleByWorker`, as its first line:

```js
  if (this.supervisor != null) this.supervisor.clear(name);
```

In `ModuleManager.prototype.unloadModuleExternal`, as its first line:

```js
  if (this.supervisor != null) this.supervisor.clear(name);
```

In `ModuleManager.prototype.restartModule`, replace

```js
  const m = this.modules[name];
  if (m == null) {
    return callback(new CHError('RESTART_MODULE_FAIL', 'unknown module', name));
  }
```

with

```js
  const m = this.modules[name];
  // A restarting or suspended module is not in this.modules, but an operator
  // restart is exactly what brings it back.
  const supervised = this.supervisor != null && this.supervisor.status(name) != null;
  if (m == null && !supervised) {
    return callback(new CHError('RESTART_MODULE_FAIL', 'unknown module', name));
  }
  if (m == null) return this.loadModuleByWorker(modulePath, name, version, callback);
```

(`reloadModule` and `/load-module` already reach `loadModuleByWorker` under worker mode, so they clear too.)

- [ ] **Step 7: Retained tools, error codes and status**

In `lib/device-manager.js` `DeviceManager.prototype.ensureDeviceState`, replace both `return callback(new CHError('DEVICE_NOT_FOUND', deviceID));` lines with `return callback(this.missingDeviceError(deviceID));` and add above the function:

```js
// A device missing from deviceMap may belong to a module whose worker exited
// and is restarting or suspended (lib/module-supervisor.js); say so instead
// of DEVICE_NOT_FOUND.
DeviceManager.prototype.missingDeviceError = function(deviceID) {
  const supervisor = (this.moduleManager != null) ? this.moduleManager.supervisor : null;
  const state = (supervisor != null) ? supervisor.errorForDevice(deviceID) : null;
  if (state == null) return new CHError('DEVICE_NOT_FOUND', deviceID);
  const when = state.retryAt != null ? `, retry after ${new Date(state.retryAt).toISOString()}` : '';
  return new CHError(state.code, state.module, `${state.reason}${when}`);
};
```

In `DeviceManager.prototype.getAllDeviceSpecs`, before `return result;`:

```js
  // Keep a restarting or suspended module's tools listed: clients get no
  // tools/list_changed notification, so a vanishing tool only confuses them.
  const supervisor = (this.moduleManager != null) ? this.moduleManager.supervisor : null;
  if (supervisor != null) {
    const retained = supervisor.retainedSpecs();
    for (const deviceID in retained) {
      if (result[deviceID] == null) result[deviceID] = retained[deviceID];
    }
  }
```

Confirm `this.moduleManager` is the property name `DeviceManager` uses for its ModuleManager (`grep -n "this.moduleManager" lib/device-manager.js`); `lib/mcp/gateway.js` reaches it as `cdifInterface.deviceManager.moduleManager`.

In `lib/module-manager.js`, replace `ModuleManager.prototype.getModuleDeviceListByName` with:

```js
ModuleManager.prototype.getModuleDeviceListByName = function(name, callback) {
  const moduleInstance = this.modules[name];
  const supervised = (this.supervisor != null) ? this.supervisor.status(name) : null;
  const sandboxStatus = (wm) => {
    if (supervised == null && wm == null) return null;
    const s = supervised || {state: 'running', lastReason: null, exits: [], nextRestartAt: null};
    return Object.assign({}, s, {violations: (wm != null && wm.violationCount != null) ? wm.violationCount : 0});
  };

  if (moduleInstance == null) {
    if (supervised != null) return callback(null, {packageInfo: {name: name}, deviceList: [], sandbox: sandboxStatus(null)});
    return callback(new Error('unknown module name'), null);
  }

  //HACK: the handler is not interested with packageInfo so we pass it just an empty object here
  //this is to make onQueryDeviceListResult() happy
  this.emit('querydevicelist', moduleInstance, {name: name}, (err, data) => {
    if (data != null && typeof(data) === 'object' && options.moduleSandbox !== 'off') {
      data.sandbox = sandboxStatus(moduleInstance instanceof WorkerMessage ? moduleInstance : null);
    }
    return callback(err, data);
  });
};
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx mocha --exit test/sandbox/07-restart.js test/direct-peer-channels/02-invalidation-on-restart.js test/auth/11-admin-module-lifecycle.js`
Expected: all passing. (`02-invalidation-on-restart` needs the server `test8.js` starts; if it cannot run standalone, run it via `npm test` in Task 10 instead and note that here.)

- [ ] **Step 9: Commit**

```bash
git add lib/module-manager.js lib/device-manager.js test/fixtures/sandbox-hog test/sandbox/07-restart.js
git commit -m "feat(sandbox): restart crashed or killed modules with backoff, suspend, keep tools listed"
```

---

### Task 8: Resource limits — external memory, blocked loop, message rate

**Files:**
- Create: `lib/worker-limits.js`
- Modify: `lib/module-manager.js` (`spawnModuleWorker`: start/stop the watcher)
- Modify: `lib/sandbox.js` (answer `sandbox-ping`; handle `rate-limited-reply`)
- Modify: `lib/worker-message.js` (`sendSandboxPingMessage`; token bucket in `onWorkerMessage`)
- Test: `test/sandbox/08-limits.js`

**Interfaces:**
- Consumes: `workerMessage.sandboxLimits` (Task 4), `workerMessage.killReason` and the exit path (Task 7), `options.moduleMessageRate` (Task 1).
- Produces: `workerLimits.watch(worker, workerMessage, limits, opts) -> stop()` where `opts` is `{intervalMs = 1000}`; on a breach it sets `workerMessage.killReason` to `'external memory limit'` or `'blocked event loop'` and calls `worker.terminate()`.
- Produces: `WorkerMessage.prototype.sendSandboxPingMessage(callback)`; `workerMessage.messageRate` (messages/second, main side, `null` = unlimited).

- [ ] **Step 1: Write the failing test**

Create `test/sandbox/08-limits.js`:

```js
// Each limit ends the worker with its own reason, and the module restarts;
// the message rate rejects without killing.
const assert = require('assert');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');

const KEY  = 'aabbcc';
const HOG  = path.join(ROOT, 'test', 'fixtures', 'sandbox-hog');
const tool = (action) => `sandbox_hog_hogservice_${action}`;

async function lastReason(port) {
  const r = await post(port, KEY, '/get-module-device-list', {name: 'sandbox-hog'});
  const s = r.body != null ? r.body.sandbox : null;
  return s != null && s.exits.length > 0 ? s.exits[s.exits.length - 1].reason : null;
}

describe('sandbox 08: resource limits', function() {
  this.timeout(120000);
  let server = null;
  beforeEach(async () => {
    server = await startServer(9613, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleMessageRate', '50', '--loadModule', HOG]);
  });
  afterEach(() => stopServer(server));

  [['heap', 'heap limit'], ['external', 'external memory limit'], ['block', 'blocked event loop']].forEach(([action, reason]) => {
    it(`${action}: ends the worker with "${reason}" and restarts it`, async () => {
      mcpCall(9613, KEY, tool(action), {}).catch(() => {});
      const got = await waitFor(() => lastReason(9613), 20000, `exit reason for ${action}`);
      assert.strictEqual(got, reason);
      await waitFor(async () => (await mcpCall(9613, KEY, tool('ping'), {})).isError === false, 15000, 'ping after restart');
    });
  });

  it('a call in flight when the worker is killed gets MODULE_RESTARTING, not a timeout', async () => {
    const t0 = Date.now();
    const r = await mcpCall(9613, KEY, tool('block'), {});
    assert.strictEqual(r.structuredContent.code, 'MODULE_RESTARTING', JSON.stringify(r));
    assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
  });

  it('the message rate rejects excess messages without killing the module', async () => {
    const r = await mcpCall(9613, KEY, tool('flood'), {});
    assert.strictEqual(r.isError, false, JSON.stringify(r));
    assert.ok(r.structuredContent.output.limited > 0, JSON.stringify(r.structuredContent));
    assert.strictEqual((await mcpCall(9613, KEY, tool('ping'), {})).isError, false);
    assert.strictEqual(await lastReason(9613), null);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx mocha --exit test/sandbox/08-limits.js`
Expected: `heap` passes already (V8 enforces `resourceLimits` from Task 4, Task 7 maps the reason); `external` and `block` time out; the in-flight case times out at the 30 s request timeout; `flood` reports `limited: 0`.

- [ ] **Step 3: Implement `lib/worker-limits.js`**

```js
// Main thread: the two limits V8 does not enforce for a worker
// (docs/superpowers/specs/2026-10-15-module-sandbox-foundation-design.md,
// section 4). Memory outside the JS heap -- Buffers, typed arrays -- is read
// from worker.getHeapStatistics().external_memory; a blocked event loop is a
// heartbeat that stops coming back. Either way the worker is terminated with
// workerMessage.killReason set, and the exit path in module-manager.js takes
// it from there. The JS heap itself is capped by resourceLimits at spawn.
function watch(worker, workerMessage, limits, opts) {
  const intervalMs = (opts != null && opts.intervalMs != null) ? opts.intervalMs : 1000;
  let lastPong = Date.now();
  let stopped = false;

  const kill = (reason) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    workerMessage.killReason = reason;
    worker.terminate();
  };

  const timer = setInterval(() => {
    if (stopped) return;
    if (Date.now() - lastPong > limits.maxBlockMs) return kill('blocked event loop');

    workerMessage.sendSandboxPingMessage(() => { lastPong = Date.now(); });
    worker.getHeapStatistics().then((s) => {
      if (s.external_memory > limits.externalMb * 1024 * 1024) kill('external memory limit');
    }, () => { /* the worker is already gone */ });
  }, intervalMs);
  timer.unref();

  worker.once('exit', () => { stopped = true; clearInterval(timer); });
  return function stop() { stopped = true; clearInterval(timer); };
}

module.exports = {watch};
```

- [ ] **Step 4: Ping and rate limit in the message layer**

In `lib/worker-message.js`, after `sendSetOptionsMessage`:

```js
// invoke from main thread: the blocked-loop heartbeat (lib/worker-limits.js).
WorkerMessage.prototype.sendSandboxPingMessage = function(callback) {
  this.sendMessageToWorker({command: 'sandbox-ping'}, callback);
};
```

In the `WorkerMessage` constructor, after `this.modulePath = null;`:

```js
  // Module sandbox message rate (main side): a token bucket per worker,
  // refilled continuously. null = unlimited (--moduleSandbox off).
  this.messageRate  = null;
  this.rateTokens   = 0;
  this.rateRefillAt = Date.now();
```

In `onWorkerMessage`, at the top of the `} else if (msg.category === 'child') {` branch, before `if (msg.command == null) return;`:

```js
    if (this.messageRate != null && msg.command !== 'sandbox-violation') {
      const now = Date.now();
      this.rateTokens = Math.min(this.messageRate, this.rateTokens + (now - this.rateRefillAt) * this.messageRate / 1000);
      this.rateRefillAt = now;
      if (this.rateTokens < 1) {
        if (this.worker != null) this.worker.postMessage({command: 'rate-limited-reply', msgID: id});
        return;
      }
      this.rateTokens -= 1;
    }
```

In `lib/sandbox.js`, add two cases to the `switch (msg.command)`:

```js
      case 'sandbox-ping': {
        return wm.sendMessageToParent(msg.id, null, null);
      }
      // The main thread refused a message from this worker: --moduleMessageRate.
      case 'rate-limited-reply': {
        const id = msg.msgID;
        const callback = wm.msgQueue[id];
        if (typeof(callback) === 'function') {
          const err = new Error('too many messages to the main thread (--moduleMessageRate)');
          err.code = 'RATE_LIMITED';
          callback(err, null);
        }
        delete wm.msgQueue[id];
        break;
      }
```

- [ ] **Step 5: Start the watcher at spawn**

In `lib/module-manager.js` add `const workerLimits = require('./worker-limits');` near the other requires. In `spawnModuleWorker`, in the success branch of `sendLoadModuleMessage`, before `this.emit('workerloaded', workerMessage);`:

```js
      if (workerMessage.sandboxLimits != null) {
        workerLimits.watch(worker, workerMessage, workerMessage.sandboxLimits);
        workerMessage.messageRate = options.moduleMessageRate;
        workerMessage.rateTokens  = options.moduleMessageRate;
      }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx mocha --exit test/sandbox/08-limits.js test/sandbox/07-restart.js`
Expected: all passing.

- [ ] **Step 7: Commit**

```bash
git add lib/worker-limits.js lib/worker-message.js lib/sandbox.js lib/module-manager.js test/sandbox/08-limits.js
git commit -m "feat(sandbox): external-memory and blocked-loop limits, worker message rate"
```

---

### Task 9: `--hardened`

**Files:**
- Create: `lib/hardened-launch.js`
- Modify: `framework.js` (re-launch at the very top, after `options.setOptions(argv)`)
- Modify: `lib/module-manager.js` (`loadModuleFromPath`: root check)
- Test: `test/sandbox/09-hardened.js`

**Interfaces:**
- Consumes: `options.hardened`, `options.modulePath`, `options.authProvider`, `options.authConfigPath`, `options.deviceConfigPath`, `options.modulePolicy`, `options.authoringTools`, `options.workerThread`.
- Produces: `hardenedLaunch.permissionFlags(options, installDir, cwd) -> [string]`; `hardenedLaunch.relaunch(flags) -> never returns` (spawns `process.execPath` with `flags` + the original `process.execArgv` + `process.argv.slice(1)`, forwards SIGINT/SIGTERM, exits with the child's code); `hardenedLaunch.insideRoot(modulePath, root) -> boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/sandbox/09-hardened.js`:

```js
// --hardened re-launches under Node's permission model: a module cannot read
// the process's memory or environment files, and every module must live
// under --modulePath.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');

const KEY = 'aabbcc';

function moduleRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-hardened-'));
  fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'sandbox-probe'), path.join(root, 'sandbox-probe'), {recursive: true});
  // A handler that reads a file it names, so the test can aim it at /proc.
  fs.writeFileSync(path.join(root, 'sandbox-probe', 'handlers', 'probeService', 'attempt.js'),
    'module.exports = async (input) => { try { require("fs").readFileSync(input.arg); return {output: {outcome: "allowed", code: null}}; }' +
    ' catch (e) { return {output: {outcome: e.code === "ERR_ACCESS_DENIED" ? "blocked" : "allowed", code: String(e.code)}}; } };');
  return root;
}

describe('sandbox 09: --hardened', function() {
  this.timeout(90000);
  let server = null;
  let root = null;
  beforeEach(() => { root = moduleRoot(); });
  afterEach(() => { stopServer(server); server = null; fs.rmSync(root, {recursive: true, force: true}); });

  it('runs under the permission model and blocks /proc/self/environ and /proc/self/mem', async () => {
    server = await startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened',
      '--modulePath', root, '--loadModule', path.join(root, 'sandbox-probe')]);
    assert.ok(server.output.includes('module sandbox: hardened -- running under --permission'), server.output.slice(-2000));
    for (const file of ['/proc/self/environ', '/proc/self/mem']) {
      const r = await mcpCall(9614, KEY, 'sandbox_probe_probeservice_attempt', {what: 'read', arg: file});
      assert.strictEqual(r.structuredContent.output.outcome, 'blocked', `${file}: ${JSON.stringify(r)}`);
    }
  });

  it('refuses a module outside --modulePath', async () => {
    server = await startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened', '--authoringTools',
      '--modulePath', root]);
    const r = await mcpCall(9614, KEY, 'countinghouse_load_module',
      {path: path.join(ROOT, 'test', 'fixtures', 'handler-map-convention'), name: 'handler-map-convention', version: '1.0.0'});
    assert.strictEqual(r.structuredContent.code, 'MODULE_PATH_OUTSIDE_ROOT', JSON.stringify(r));
  });

  // Review Focus 5.
  it('accepts a relative --loadModule path that resolves inside --modulePath', async () => {
    server = await startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened',
      '--modulePath', root, '--loadModule', path.relative(ROOT, path.join(root, 'sandbox-probe'))]);
    const r = await mcpCall(9614, KEY, 'sandbox_probe_probeservice_env', {});
    assert.strictEqual(r.isError, false, JSON.stringify(r));
  });

  it('needs --workerThread', async () => {
    server = await startServer(9614, ['--debug', '--hardened', '--modulePath', root], {expectExit: true});
    assert.strictEqual(server.exitCode, 2);
    assert.ok(server.output.includes('--hardened needs --workerThread'), server.output);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx mocha --exit test/sandbox/09-hardened.js`
Expected: 4 failing — no hardened line, `/proc` reads allowed, no root check, no exit 2.

- [ ] **Step 3: Implement `lib/hardened-launch.js`**

```js
// --hardened: re-launch this server under Node's permission model
// (docs/superpowers/specs/2026-10-15-module-sandbox-foundation-design.md,
// section 5). The flags have to be given when Node starts, so framework.js
// calls relaunch() before doing anything else and the child, which sees
// process.permission, carries on normally.
const path  = require('path');
const spawn = require('child_process').spawn;

function insideRoot(modulePath, root) {
  const p = path.resolve(modulePath);
  const r = path.resolve(root);
  return p === r || p.startsWith(r + path.sep);
}

function permissionFlags(options, installDir, cwd) {
  const read  = [installDir, path.resolve(cwd, options.modulePath)];
  const write = [path.resolve(cwd, options.modulePath)];
  if (options.authConfigPath != null) read.push(path.resolve(cwd, options.authConfigPath));
  if (options.deviceConfigPath != null) read.push(path.resolve(cwd, options.deviceConfigPath));
  else read.push(path.resolve(cwd, 'config', 'devices'));
  if (options.modulePolicy != null) read.push(path.resolve(cwd, options.modulePolicy));

  const flags = ['--permission', '--allow-worker'];
  if (options.authProvider === 'sqlite') {
    const db = path.resolve(cwd, options.authConfigPath || 'auth.sqlite3');
    read.push(path.dirname(db));
    write.push(path.dirname(db));
    flags.push('--allow-addons');
  }
  if (options.authoringTools === true) flags.push('--allow-child-process');
  read.forEach((p) => flags.push(`--allow-fs-read=${p}`));
  write.forEach((p) => flags.push(`--allow-fs-write=${p}`));
  return flags;
}

function relaunch(flags) {
  const child = spawn(process.execPath, flags.concat(process.execArgv, process.argv.slice(1)), {stdio: 'inherit'});
  ['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => child.kill(sig)));
  child.on('exit', (code, signal) => process.exit(code != null ? code : (signal != null ? 1 : 0)));
}

module.exports = {insideRoot, permissionFlags, relaunch};
```

- [ ] **Step 4: Re-launch from `framework.js`**

In `framework.js`, directly after `options.setOptions(argv);` (before the logger is created, so the parent does no other work):

```js
// --hardened: run the real server as a child under --permission. The child
// sees process.permission and falls through to normal startup.
if (options.hardened === true && process.permission == null) {
  if (options.workerThread !== true) {
    console.error('--hardened needs --workerThread: module workers are what it protects the process from');
    process.exit(2);
  }
  var hardenedLaunch = require('./lib/hardened-launch');
  hardenedLaunch.relaunch(hardenedLaunch.permissionFlags(options, __dirname, process.cwd()));
  return;
}
```

`framework.js` is a CommonJS entry point, so a top-level `return` is valid. Then, after the `module sandbox: mode ...` line from Task 1:

```js
if (options.hardened === true) {
  logger.I('module sandbox: hardened -- running under --permission; modules must live under ' + options.modulePath);
}
```

- [ ] **Step 5: Refuse module paths outside the root**

In `lib/module-manager.js`, as the first lines of `ModuleManager.prototype.loadModuleFromPath`:

```js
  // --hardened: every module lives under --modulePath (main thread only; the
  // worker re-runs loadModuleFromPath for the same, already-checked path).
  if (options.hardened === true && isMainThread === true &&
      !require('./hardened-launch').insideRoot(String(modulePath), options.modulePath)) {
    return callback(new CHError('MODULE_PATH_OUTSIDE_ROOT', modulePath));
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx mocha --exit test/sandbox/09-hardened.js`
Expected: 4 passing. If startup under `--permission` fails reading a path (`ERR_ACCESS_DENIED` naming it in the output), that path is one countinghouse reads at startup and is missing from `permissionFlags`: add it to `read` with a comment saying who reads it, and re-run.

- [ ] **Step 7: Commit**

```bash
git add lib/hardened-launch.js framework.js lib/module-manager.js test/sandbox/09-hardened.js
git commit -m "feat(sandbox): --hardened re-launches under Node's permission model"
```

---

### Task 10: Docs, CHANGELOG, full suite and benchmarks

**Files:**
- Modify: `docs/security-model.md`
- Modify: `docs/module-development.md`
- Modify: `docs/cli-and-api-reference.md`
- Modify: `CHANGELOG.md` (the existing `## Unreleased` section)

**Interfaces:**
- Consumes: everything above. No code.

- [ ] **Step 1: Rewrite `docs/security-model.md`**

Keep the file's existing honesty and structure (threat model, what is and is not provided, comparison, positioning). Replace the content of "What this explicitly does NOT provide" and "Current mitigations inventory" with the layers this work adds, each with what it stops and what it does not:

- the lockdown (section 3 of the spec), including the two known routes around the file boundary: `require.cache` and `module.constructor.createRequire` give module code countinghouse's already-loaded modules;
- declared permissions and the operator policy, and that `fs`/`net` take effect only with parts 2 and 3;
- resource limits and restart/suspend;
- `--hardened`, and that `--allow-addons` (SQLite auth) puts native code in the main thread outside the permission model;
- the sentence from the spec: "It is a strong barrier ... It is not a hard boundary against code written specifically to defeat it."

Update "Roadmap" to list parts 2–4 and point at the spec.

- [ ] **Step 2: Module author docs**

In `docs/module-development.md`, add a section "Declaring permissions" covering: the `countinghouse.permissions` fields with the example from the spec; the self-contained rule (`npm install --prefix <module>`); no native addons (name `bcryptjs` as the usual replacement for `bcrypt`); declared env vars; limits; what `MODULE_RESTARTING` and `MODULE_SUSPENDED` mean for a caller; and that blocked built-ins (list them) are unavailable.

- [ ] **Step 3: CLI reference**

In `docs/cli-and-api-reference.md`, add rows for `--moduleSandbox`, `--modulePolicy`, `--moduleMessageRate`, `--hardened` with the defaults from the spec's "New CLI flags" table, and document the `sandbox` key on `POST /get-module-device-list`.

- [ ] **Step 4: CHANGELOG**

Under the existing `## Unreleased` heading in `CHANGELOG.md`, add:

```markdown
### Added — module sandbox, part 1

- **`--moduleSandbox off|audit|enforce`** (default `audit` under
  `--workerThread`, `off` without it). In each module's worker: no native
  code, no process controls, `require` limited to built-ins and the module's
  own directory, `child_process`/`cluster`/`worker_threads`/`inspector`/
  `wasi`/`v8` blocked. `audit` logs violations; `enforce` blocks them.
- **Declared permissions** (`countinghouse.permissions` in a module's
  `package.json`) narrowed by an operator **`--modulePolicy`** file. `env`
  and limits apply now; `fs` and `net` take effect with parts 2 and 3.
- **Resource limits**: JS heap, memory outside the heap, a blocked event
  loop (`heapMb`, `externalMb`, `maxBlockMs`), and a worker message rate
  (`--moduleMessageRate`).
- **`--hardened`**: re-launches under Node's permission model; every module
  must live under `--modulePath`.
- `countinghouse-validate` reports dependencies outside the module, native
  code, and (as warnings) install scripts.

### Changed

- **A module whose worker crashes now restarts** (under `audit` and
  `enforce`): 1 s, 2 s, ... up to 60 s, suspended after 3 exits in 10
  minutes. Calls meanwhile get `MODULE_RESTARTING` or `MODULE_SUSPENDED`
  and the tools stay listed. `--moduleSandbox off` keeps the old behaviour,
  where a crashed module stays down.
```

- [ ] **Step 5: Lint and the full suite**

Run: `npm run lint`
Expected: clean.

Run (machine otherwise idle, ~35 minutes): `npm test > /tmp/suite.log 2>&1; echo "exit=$?" >> /tmp/suite.log`
Expected: `exit=0`, no failing tests, and the `test/sandbox/*.js` run listed. If anything fails, check `journalctl --since "<start time>"` for "Clock change" and `redis-server` restarts first; report each failure by name either way.

- [ ] **Step 6: Benchmarks**

From the suite log, compare the `test6.js`/`test7.js` latency figures (p50/p95/p99) and the direct-peer-channel benchmark against the same lines from the last `master` run (`git stash` is not needed: run `git checkout master && npx mocha test/test6.js test/test7.js > /tmp/bench-master.log` only if no earlier figures are at hand, then return to the branch). A slowdown beyond run-to-run noise in either is a finding to report, not to paper over.

- [ ] **Step 7: Commit**

```bash
git add docs/security-model.md docs/module-development.md docs/cli-and-api-reference.md CHANGELOG.md
git commit -m "docs(sandbox): security model, module permissions, flags, changelog"
```
