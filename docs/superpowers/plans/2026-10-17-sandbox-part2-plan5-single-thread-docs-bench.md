# Module sandbox part 2, plan 5 of 5 — single-thread mode, benchmarks, docs, spec amendments

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, chosen by the user) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. After each task's commit, send the reviewer session (`countinghouse-0a`) the range from `git log --oneline` output and wait for its approval before the next task. Tell the reviewer before running tests that use ports. Never run two server test files at once on this one-CPU VM.

**Goal:** Give single-thread (debug) mode the same virtual paths modules see in worker mode, as far as one shared process allows; measure what part 2 costs; bring the docs, the spec and part 1's spec in line with what was built; and give operators one page that says everything 8.0.0 changes.

**Architecture:** Single-thread mode gets `lib/single-thread-facade.js`, installed once at startup when `--no-workerThread` is given: a registry of loaded modules (host root → name, data directories, declared paths), a `module.registerHooks` pair that prefixes each module CommonJS file with its virtual `__filename`/`__dirname` and answers module-parent requests for `fs`, `fs/promises` and `os` with a per-module translating facade, and a mapping of virtual absolute specifiers against the requiring file's module root. Identity stays the host path, so two modules' files never collide in `require.cache`. No checks, quota or link rules — the mode stays debug-only. The benchmarks extend `perf/` with a file-I/O and a spawn-time measurement. Docs, the spec amendments and the part 1 amendment close the series.

**Tech Stack:** Node.js >= 22.16 (`module.registerHooks`), mocha, the existing `perf/` harness style.

**Spec:** `docs/superpowers/specs/2026-10-17-module-sandbox-fs-broker-design.md` — section 6 (single-thread mode), section 5 (8.0.0: the upgrade section, the part 1 amendment), "Docs", "Testing" (single-thread prefix, benchmarks). Series ledger: every "PLAN 5 DOCS" and plan 5 note in `.superpowers/sdd/*/progress.md`.

## Global Constraints

- Single-thread mode stays debug-only and unsandboxed: the facade translates paths, nothing more (no namespace refusal, no quota, no link rules). Startup's existing warning stays.
- Written from the current worker-mode behaviour (reviewer, end of plan 4), not the old section 6 text: `/tmp` is emptied and the data directories created at each module load; the device config is read on the main thread as it always was in this mode; a virtual absolute specifier from module code maps to that module's root (worker mode's rule, without `countinghouse-module:` because countinghouse code here names host paths); `CHUtil.loadFile('/app/…')` maps through the calling module's root.
- Documented differences from worker mode (the docs list exactly these): `process.cwd()` stays real; stack frames, `module.filename`, `require.cache` keys and `require.resolve` stay host; ES modules' `import.meta.*` stays host; paths given to non-`fs` APIs are not translated; a module can require countinghouse's own dependencies through `NODE_PATH`; no checks, quota, link rules or other-routes locks.
- Spec text is the user's: Task 6 proposes all amendments in one batch and changes the spec only with the user's approval, as decision 12 went. Docs never contradict the spec after the merge.
- Any task that adds an HTTP route lists `docs/cross-cutting-matrix.md` and `test/fixtures/route-inventory.json` (none planned here).
- Do not run the full `npm test` except in the last task. Kill stray servers by PID. Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A module file starting with a hashbang, then `'use strict'`, then a comment — the prefix must keep strict mode, keep the hashbang parsing, and keep every line number (Task 2 unit test).
2. Two modules loaded together in single-thread mode, each reading its own `package.json` through `path.join(__dirname, …)` — each gets its own, and `require.cache` holds both under distinct host keys (Task 2 wired test).
3. A module calling `fs.realpath('/data')`, `fs.mkdtemp('/tmp/x-')` and `fs.readdir('/data', {withFileTypes: true})` in single-thread mode — results come back virtual (Task 1 test).
4. Countinghouse's own `fs` use in single-thread mode — never translated (the facade is per module parent; Task 1 test reads a countinghouse file by host path from countinghouse code after a module loaded).
5. The benchmarks run on a loaded one-CPU VM — each reports the median of repeated runs and the machine, and the docs quote them as "on this machine", not as guarantees (Task 4).

---

### Task 1: Single-thread data directories and the fs/os facade

**Files:**
- Create: `lib/single-thread-facade.js`, `test/single-thread/01-facade.js`
- Modify: `lib/module-manager.js` (single-thread load: data directories, `/tmp` emptied, module registered), `framework.js` (installs the facade under `--no-workerThread`), `package.json` (`test/single-thread/*.js` in the `npm test` chain)

**Interfaces:**
- Produces: `facade.install()` (once, main thread, single-thread mode); `facade.register(hostRoot, {name, data, tmp, declared})`; `facade.forModule(hostRoot, kind)` → the translating `fs` / `fs/promises` / `os` object; `facade.toHost(hostRoot, p)` and `facade.toVirtual(hostRoot, hostPath)`; `facade.rootOf(hostFile)` → the registered root containing it or null.

- [ ] **Step 1: Write the failing tests** — `test/single-thread/01-facade.js` (port 9636; `--no-workerThread`), against `fs-probe` with `--moduleDataPath` under `test/.tmp`:
  - `write {path: '/data/x'}` lands in `<store>/fs-probe/data/x`; `read {path: '/data/x'}` returns it;
  - a file left in `<store>/fs-probe/tmp/old` before start is gone (`read '/tmp/old'` → `ENOENT`);
  - `where`: `tmpdir === '/tmp'`, `own === 'fs-probe'` (its `__dirname` read works, Task 2 makes `__dirname` virtual — here it is still host, and the read must work either way);
  - a new fixture action `fsResults` in `fs-probe` returning `{realpath: fs.realpathSync('/data'), mkdtemp: <a fs.mkdtempSync('/tmp/x-') result with the random suffix replaced by '*'>, parent: fs.readdirSync('/data', {withFileTypes: true})[0].parentPath, relative: fs.existsSync('package.json')}` → `{realpath: '/data', mkdtemp: '/tmp/x-*', parent: '/data', relative: true}` (relative paths resolve against `/app`);
  - countinghouse's own fs is untouched: after the module loaded, the test calls a debug route that reads a countinghouse file by host path — `GET /package-info` of the device works (it reads package.json on the main thread); assert 200.
- [ ] **Step 2: Run** (tell the reviewer: 9636) → FAIL (data written to the host's `/data`, i.e. `EACCES`/`ENOENT`; `/tmp/old` still there).
- [ ] **Step 3: Implement** `lib/single-thread-facade.js`:

```js
// Single-thread (debug) mode's virtual paths (part 2 spec, section 6): no
// sandbox, only translation. Each loaded module is registered with its host
// root and data directories; module-parent requests for fs, fs/promises and
// os get a per-module object that translates /app, /data, /tmp (and declared
// paths, which keep their names) to host paths and results back. Countinghouse
// code and other modules' code are never translated.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');

const modules = new Map();     // hostRoot -> {name, data, tmp}
const facades = new Map();     // `${hostRoot}\0${kind}` -> object
const inside = (p, root) => p === root || p.startsWith(`${root}/`);
const KINDS = {fs: 'fs', 'node:fs': 'fs', 'fs/promises': 'fs/promises', 'node:fs/promises': 'fs/promises', os: 'os', 'node:os': 'os'};

function register(hostRoot, info) { modules.set(hostRoot, info); }
function rootOf(hostFile) {
  for (const root of modules.keys()) if (inside(hostFile, root)) return root;
  return null;
}

function toHost(root, p) {
  const m = modules.get(root);
  let s = (p instanceof URL) ? url.fileURLToPath(p) : String(p);
  if (!path.isAbsolute(s)) s = path.posix.resolve('/app', s);
  if (inside(s, '/app')) return root + s.slice(4);
  if (inside(s, '/data')) return m.data + s.slice(5);
  if (inside(s, '/tmp')) return m.tmp + s.slice(4);
  return s;   // declared paths keep their names; anything else is passed through (no checks here)
}

function toVirtual(root, h) {
  const m = modules.get(root);
  const s = String(h);
  if (inside(s, m.data)) return `/data${s.slice(m.data.length)}`;
  if (inside(s, m.tmp)) return `/tmp${s.slice(m.tmp.length)}`;
  if (inside(s, root)) return `/app${s.slice(root.length)}`;
  return s;
}

// Which arguments are paths: the first, and the second for two-path calls.
const TWO_PATHS = new Set(['rename', 'renameSync', 'copyFile', 'copyFileSync', 'link', 'linkSync', 'cp', 'cpSync']);
const RESULT_PATH = new Set(['realpath', 'realpathSync', 'mkdtemp', 'mkdtempSync']);
const pathLike = (v) => typeof(v) === 'string' || v instanceof URL || Buffer.isBuffer(v);

function translateError(root, e) {
  if (e != null && typeof(e) === 'object') {
    if (typeof(e.path) === 'string') e.path = toVirtual(root, e.path);
    if (typeof(e.dest) === 'string') e.dest = toVirtual(root, e.dest);
  }
  return e;
}

function translateResult(root, key, r) {
  if (RESULT_PATH.has(key) && typeof(r) === 'string') return toVirtual(root, r);
  if (Array.isArray(r)) return r.map((d) => (d instanceof fs.Dirent ? Object.assign(Object.create(Object.getPrototypeOf(d)), d, {parentPath: toVirtual(root, d.parentPath), path: toVirtual(root, d.parentPath)}) : d));
  return r;
}

function wrapFn(root, key, fn, target) {
  return function(...a) {
    const n = TWO_PATHS.has(key) ? 2 : 1;
    // symlink's first argument is the target text: translated only when absolute
    for (let i = 0; i < n && i < a.length; i++) if (pathLike(a[i]) && !(key.startsWith('symlink') && i === 0)) a[i] = toHost(root, Buffer.isBuffer(a[i]) ? a[i].toString() : a[i]);
    if (key.startsWith('symlink') && a.length > 1) a[1] = toHost(root, a[1]);
    const last = a[a.length - 1];
    if (typeof(last) === 'function' && !key.endsWith('Sync')) {
      a[a.length - 1] = (e, r, ...more) => last(translateError(root, e), translateResult(root, key, r), ...more);
    }
    try {
      const r = fn.apply(target, a);
      if (r != null && typeof(r.then) === 'function') return r.then((v) => translateResult(root, key, v), (e) => { throw translateError(root, e); });
      return translateResult(root, key, r);
    } catch (e) { throw translateError(root, e); }
  };
}

function forModule(root, kind) {
  const key = `${root}\0${kind}`;
  if (facades.has(key)) return facades.get(key);
  let f;
  if (kind === 'os') {
    f = Object.assign(Object.create(null), os, {tmpdir: () => '/tmp'});
  } else {
    const real = kind === 'fs' ? fs : fs.promises;
    f = Object.create(null);
    for (const k of Object.keys(real)) f[k] = typeof(real[k]) === 'function' && !/^[A-Z]/.test(k) ? wrapFn(root, k, real[k], real) : real[k];
    if (kind === 'fs') f.promises = forModule(root, 'fs/promises');
  }
  facades.set(key, f);
  return f;
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = typeof(context.parentURL) === 'string' && context.parentURL.startsWith('file:') ? url.fileURLToPath(context.parentURL) : null;
      const root = parent != null ? rootOf(parent) : null;
      if (root != null && KINDS[specifier] != null) {
        return {url: `countinghouse-facade:${KINDS[specifier]}?${encodeURIComponent(root)}`, format: 'commonjs', shortCircuit: true};
      }
      if (root != null && (specifier === '/app' || specifier.startsWith('/app/'))) return nextResolve(root + specifier.slice(4), context);
      return nextResolve(specifier, context);
    },
    load(hookUrl, context, nextLoad) {
      if (hookUrl.startsWith('countinghouse-facade:')) {
        const [kind, root] = hookUrl.slice('countinghouse-facade:'.length).split('?');
        return {format: 'commonjs', shortCircuit: true,
          source: `module.exports = require(${JSON.stringify(__filename)}).forModule(${JSON.stringify(decodeURIComponent(root))}, ${JSON.stringify(kind)});`};
      }
      return nextLoad(hookUrl, context);
    }
  });
}

module.exports = {install, register, rootOf, toHost, toVirtual, forModule};
```

  `framework.js`: under `options.workerThread !== true`, `require('./lib/single-thread-facade').install()` before modules load. `lib/module-manager.js`, in `loadModuleFromPath`'s main-thread single-thread branch, before `instantiateModule`: `const dirs = await moduleData.ensureDirs(options.moduleDataPath, name); await spawnWalk.emptyTmp(dirs.tmp); facade.register(realDir(modulePath), {name, data: dirs.data, tmp: dirs.tmp})` (the function is callback-style: wrap these in a promise chain that continues the existing body, and fail the load with `LOAD_MODULE_FAIL` and the walk's message on error). Add `test/single-thread/*.js` to `npm test` after `test/sandbox/*.js` with `--exit`.
- [ ] **Step 4: Run** `npx mocha --exit test/single-thread/01-facade.js`, then the pinned single-thread tests (`npx mocha --exit test/test2.js test/module-loading/*.js`) → all passing.
- [ ] **Step 5: Commit** `feat(single-thread): data directories and translated fs/os for modules`.

---

### Task 2: Single-thread identity — the `__filename`/`__dirname` prefix, absolute specifiers, `CHUtil.loadFile`

**Files:**
- Modify: `lib/single-thread-facade.js` (`prefixSource`, the load hook for module CommonJS files), `lib/countinghouse-util.js` (`loadFile` maps a virtual path through the caller's module root)
- Test: `test/single-thread/02-identity.js`, `test/fixtures/fs-probe-twin/` (a copy of `fs-probe` named `fs-probe-twin`)

**Interfaces:**
- Produces: `facade.prefixSource(source, virtualFile) → string` (exported for tests).

- [ ] **Step 1: Write the failing tests.** Unit (`test/single-thread/02-identity.js`, no port):

```js
const assert = require('assert');
const vm = require('vm');
const facade = require('../../lib/single-thread-facade');

const run = (src) => {
  const fn = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${src}\n})`);
  const m = {exports: {}};
  fn(m.exports, require, m, '/host/x/lib/a.js', '/host/x/lib');
  return m.exports;
};

describe('single-thread 02: the identity prefix', () => {
  it('sets the virtual __filename and __dirname, keeping strict mode and line numbers', () => {
    const src = "'use strict';\n// a comment\nmodule.exports = {f: __filename, d: __dirname, strict: (function() { return this === undefined; })(), line: new Error().stack.split('\\n')[1]};";
    const out = run(facade.prefixSource(src, '/app/lib/a.js'));
    assert.deepStrictEqual([out.f, out.d, out.strict], ['/app/lib/a.js', '/app/lib', true]);
    assert.ok(/:3:/.test(out.line), out.line);
  });

  it('keeps a hashbang first and parsing', () => {
    const src = "#!/usr/bin/env node\n'use strict';\nmodule.exports = __dirname;";
    const prefixed = facade.prefixSource(src, '/app/bin/cli.js');
    assert.ok(prefixed.startsWith('#!/usr/bin/env node\n'));
    assert.strictEqual(prefixed.split('\n').length, src.split('\n').length);
  });

  it('a file with no directive gets the prefix on its first line', () => {
    const prefixed = facade.prefixSource('module.exports = __filename;', '/app/index.js');
    assert.strictEqual(prefixed.split('\n').length, 1);
    assert.strictEqual(run(prefixed), '/app/index.js');
  });
});
```

  Wired (port 9636): `fs-probe` and `fs-probe-twin` loaded together with `--no-workerThread`; each one's `where` returns `dirname === '/app/handlers/probeService'` and `own` equal to its own package name; `CHUtil.loadFile`-style loading works (the existing handler-map loader goes through `CHUtil.loadFile`, so both modules loading at all proves it); the `where` output's `filename` is `/app/handlers/probeService/where.js` while `resolve` stays a host path (a documented difference: assert it starts with the fixture's host path).
- [ ] **Step 2: Run** → FAIL (`prefixSource` missing; `dirname` host).
- [ ] **Step 3: Implement.** `prefixSource(source, virtualFile)`: keep a leading `#!…` line as is; then skip the directive prologue — whitespace, `//` and `/* */` comments, and string-literal statements (`'…';` / `"…";`) — on the first code line, and insert, on that same line right after the prologue, `var __filename = <json>, __dirname = <json>;` (so strict mode stays first and the line count is unchanged; `var` rebinds the wrapper's parameters). The load hook: for a `file:` URL whose path is inside a registered root and whose format is CommonJS (`.cjs`, or `.js` under a package without `"type": "module"`), read the source with `fs.readFileSync` and return `{format: 'commonjs', source: prefixSource(src, toVirtual(root, hostPath)), shortCircuit: true}`. `CHUtil.loadFile(name)`: when `name` is virtual (`/app…`) and single-thread mode is on, map it with `facade.toHost(facade.rootOf(callerFile), name)`, where `callerFile` is the first stack frame outside `lib/countinghouse-util.js` (debug-only mode; documented).
- [ ] **Step 4: Run** `npx mocha --exit test/single-thread/*.js test/test2.js` → passing.
- [ ] **Step 5: Commit** `feat(single-thread): modules see their own /app paths in __filename and __dirname`.

---

### Task 3: The pinned single-thread tests, and the registry-mode uninstall test

**Files:**
- Modify: test files pinned to `--no-workerThread` in plan 1 Task 2 (the list is in plan 1's ledger), `test/sandbox/17-uninstall.js`

- [ ] **Step 1:** For each file pinned to `--no-workerThread` in plan 1 (series ledger "Open: decide per test file …"), decide: keep pinned (it tests single-thread semantics, or a feature that only exists there) or move to the default worker mode (it tests module behaviour that is the same in both). Record the table in the ledger: file, decision, reason. Move the "default" ones by dropping the flag, run each, and fix only test assumptions that worker mode changes (virtual paths, device config). Close the series ledger's open item.
- [ ] **Step 2:** Registry-mode uninstall (carried from plan 4): in `17-uninstall.js`, a case started without `--loadModule` (the sqlite3 registry), with the module registered through `POST /load-module`, unloaded, then uninstalled → `registryEntryRemoved: true`; uninstall again → `registryEntryRemoved: false`. Skip with a message when `sqlite3` is not installed (`require('./lib/optional-sqlite3')`'s probe).
- [ ] **Step 3: Run** every file touched, one at a time (tell the reviewer the ports).
- [ ] **Step 4: Commit** `test: move module-behaviour tests to worker mode; registry-mode uninstall`.

---

### Task 4: Benchmarks

**Files:**
- Create: `perf/fs-broker-io-perf.js`, `perf/spawn-time-perf.js`, `docs/benchmarks/sandbox-part2.md`

- [ ] **Step 1: File I/O.** `perf/fs-broker-io-perf.js` starts countinghouse (worker mode) with a fixture module whose action does N small file operations (write 4 KB, read it back, stat, unlink — 1000 rounds) in `/data`, and times the action under `--moduleSandbox off` and `enforce`, and in `--no-workerThread` as the unbrokered baseline. 5 runs each; report median and min/max, the Node version, CPU count and `UV_THREADPOOL_SIZE`. Also 10 workers at once under `enforce` (the scheduler's fairness and the global cap).
- [ ] **Step 2: Spawn time.** `perf/spawn-time-perf.js`: time `createForWorker` alone (data directories, the spawn walk over an empty and over a 10 000-file `/data`, `codeRootsFor` with its ~300 realpaths, namespace prepare) and a full `POST /restart-module` round trip, 10 runs each, median and min/max.
- [ ] **Step 3: Decide the two plan 4 perf notes from the numbers:** if `codeRootsFor` is more than 20 ms median, cache it per process (countinghouse's install does not change while it runs); if a grant/L2 check shows in a CPU profile of the I/O benchmark (`--cpu-prof`), replace the root list with a Set of package directories walked by parent. Otherwise ledger "not needed: <numbers>". Each change, if made, gets its own test and commit.
- [ ] **Step 4:** Write `docs/benchmarks/sandbox-part2.md`: the method, the machine, the tables, and what they mean for operators ("on this machine; measure your own"). The CHANGELOG upgrade section quotes the broker's measured cost under `off` and `enforce` from it (spec section 5, item 4).
- [ ] **Step 5: Commit** `perf: file-broker I/O and spawn-time benchmarks`.

---

### Task 5: Docs

**Files:**
- Modify: `docs/security-model.md`, `docs/module-development.md`, `docs/cli-and-api-reference.md`, `examples/log-triage/README.md`
- Create: `docs/upgrading-to-8.md`

- [ ] **Step 1: `docs/security-model.md`** — rewrite, not append (end-of-plan-3 gate): the layers (part 1's lockdown, part 2's broker and virtual namespace, the bounded loader, the lifecycle lock, `--hardened`), the modes (`off` runs the broker and the link rules; `audit` logs; `enforce` refuses), and the gaps: everything in the spec's "Gaps that remain", plus what plans 3–4 found — Unix-socket paths until part 4; under `audit`/`off` the loader lookups and outside reads are not hidden; the host path leaks through `__filename` and stack frames of a CommonJS file imported directly by an ES module (Node 24); a module may learn whether a host path exists, and its type, under `audit` and `off` (under `enforce` the loader's lookups answer missing); HTTP/2 `respondWithFile` is not available; the quota is approximate in the safe direction; the 35 s settle bound; descriptor numbers modules see are `0x10000000 + n`. The systemd example adds `--moduleDataPath` to `ReadWritePaths`. Code roots: countinghouse's own entries and its dependency closure, never a whole `node_modules`; countinghouse installed under `/app` is refused.
- [ ] **Step 2: `docs/module-development.md`** — the namespace (`/app`, `/data`, `/tmp`, declared paths; `__dirname` is `/app/...`, `process.cwd()` is `/app`); writing data under `/data` or `/tmp` and declaring outside paths; the disk limits; "fs takes effect now" replaces "when the file and network brokers ship"; `respondWithFile` (read the file with `fs` and stream it); single-thread differences (Task 1–2's list); descriptor numbers; the upgrade guide pointer.
- [ ] **Step 3: `docs/cli-and-api-reference.md`** — `--moduleDataPath`, `diskMb`/`diskEntries`, `POST /uninstall-module {name, keepData}` and its errors (`MODULE_NAME_INVALID`, `MODULE_LOADED`, `MODULE_DATA_NOT_DIRECTORY`, `REMOVE_MODULE_INFO_FAIL`), `MODULE_NAME_MISMATCH`, the `/app` install refusal (exit 2).
- [ ] **Step 4: `examples/log-triage/README.md`** — with a non-default `--moduleDataPath`, run `node examples/log-triage/generate-logs.js --dir <moduleDataPath>/log-read/data/sample-logs` (the option exists).
- [ ] **Step 5: `docs/upgrading-to-8.md`** — one page for operators deciding on the upgrade (reviewer, end of plan 4): every 8.0.0 `Changed` item and Known issue from the CHANGELOG, grouped as "before you upgrade" (Node 22.16; Redis 5.0 for jobs; a writable `--moduleDataPath`; not installed under `/app`; load names equal to package.json names), "what modules will notice" (virtual paths, `/tmp` private and emptied, outside paths under `enforce`, the quota, `respondWithFile`), "what operators get" (uninstall, the policy's disk limits, the link check), and "measured cost" (Task 4). Linked from the CHANGELOG and the README.
- [ ] **Step 6: Commit** `docs: part 2 in the security model, module guide, reference and upgrade page`.

---

### Task 6: The spec amendments (user's decision), the part 1 amendment, the full suite

- [ ] **Step 1: Ask the user, in one batch,** to approve these amendments to `docs/superpowers/specs/2026-10-17-module-sandbox-fs-broker-design.md` (they reflect decisions already taken during plans 3–4, most of them the user's; the spec should say what was built):
  1. Code roots: countinghouse's own entries (`lib/`, `package.json`, `spec/schema.json`) and the package directories of its dependency closure, minus every module root — not "`lib/`, `node_modules/` and `package.json`".
  2. HTTP/2 `respondWithFile` is not available to modules, in every mode (user decision).
  3. Under `enforce`, the loader's own disk lookups (`Module._stat`, `_findPath`, `_resolveFilename`, `_readPackage`, `findPackageJSON`) answer missing outside those roots (user decision).
  4. Descriptor numbers: modules see `0x10000000 + n`; the broker numbers its table from 3 (the plan 2b gate's note; ask whether the spec should say both).
  5. The CommonJS-imported-by-ES-module exception keeps a host `__filename` (Node 24), with the reason.
  6. Single-thread mode (section 6) as built in Tasks 1–2.
  7. The other-routes table gains HTTP/2 `respondWithFD` (refused under `enforce`) and the sweep's result.
  8. The spawn link check flags links that can lead outside (hard links with a name outside `/data` and `/tmp`, absolute symlinks), not every hard link; the settle wait is bounded at 35 s.
  Apply exactly what the user approves; record the rest as declined in the ledger.
- [ ] **Step 2: The part 1 amendment** (spec section 5, item 5, still owed): in `docs/superpowers/specs/2026-10-15-module-sandbox-foundation-design.md`, a dated "Amended by part 2" section — `off` runs the file broker and adds a hop to every file call; a load whose request name differs from its package.json name is refused in every mode. The user approved these in the part 2 design; the reviewer checks the wording.
- [ ] **Step 3:** CHANGELOG: the upgrade section links `docs/upgrading-to-8.md` and quotes the measured cost; "module sandbox, part 2 (in progress)" becomes "module sandbox, part 2".
- [ ] **Step 4:** Tell the reviewer, then run the full suite alone: `npm test > .superpowers/part2-plan5-suite.log 2>&1; echo "exit=$?" >> .superpowers/part2-plan5-suite.log`. Expected `exit=0`, 0 guard refusals.
- [ ] **Step 5:** Commit, send the reviewer the range and the result for the end-of-series gate, and report to the user: what part 2 delivered, the rulings, the deferred items (Alpine smoke test; Unix sockets for part 4), and that the branch awaits their merge decision.
