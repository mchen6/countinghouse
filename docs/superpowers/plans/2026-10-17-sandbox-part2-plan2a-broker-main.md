# Module sandbox part 2, plan 2a of 5 — the broker, main-thread side

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, chosen by the user) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. After each task's commit, send the reviewer session (`countinghouse-0a`) the range from `git log --oneline` output and wait for its approval before the next task. Tell the reviewer before running tests that use ports.

**Goal:** Build everything the file broker needs on the main thread — per-module data directories, the virtual namespace, the operation executor with its checks, and the scheduler that protects the libuv threadpool — as plain modules tested in-process, ready for plan 2b to connect to workers.

**Architecture:** Four new files under `lib/`, none wired into the running server yet (plan 2b does that). `module-data.js` names and creates data directories. `fs-broker/namespace.js` (prepared once per worker: every root and protected path realpath'd) turns a path a module gave into a decision (one of the virtual roots, a synthesised ancestor, or outside). `fs-broker/broker.js` (`FsBroker`) runs one primitive file operation for one worker: decide, check on the host, run, verify, and answer with Node-shaped errors and virtual paths. `fs-broker/scheduler.js` (`FsScheduler`) shares a global cap on operations in flight fairly between workers.

**Tech Stack:** Node.js >= 22.16 (`fs/promises`), mocha.

**Spec:** `docs/superpowers/specs/2026-10-17-module-sandbox-fs-broker-design.md` — sections 1 (namespace), 3 (broker), 4 (modes). Plan series: 1 groundwork (done) · **2a broker, main side (this)** · 2b bridge, worker patch and wiring · 3 virtual identity and the loader · 4 quota and data lifecycle · 5 single-thread mode, docs, benchmarks. Plan 2 was split into 2a and 2b for reviewability (ledger ruling in `.superpowers/sdd/sandbox-part2/progress.md`).

## Global Constraints

- Linux paths (POSIX); countinghouse targets Linux servers. macOS works for development where noted (device+inode checks instead of `/proc/self/fd`).
- Module-facing errors are Node's own codes: `ENOENT`, `EROFS`, `EPERM`, `EBUSY`, `EMFILE`, `EBADF`, `EXDEV`, `ETIMEDOUT`, `EIO`. Error objects carry `code`, a negative `errno`, `syscall`, and a **virtual** `path`/`dest`; the message names the virtual path, never a host path inside the namespace.
- **Plan 3 gate:** `lib/fs-broker/broker.js` has a module constant `ENFORCE_FILE_DECISIONS = false`. While false, `enforce` makes the same file decisions as `audit` (pass through, logged). It is not a CLI flag or option and nothing in a worker can see it. `FsBroker`'s constructor takes `enforceFileDecisions` (defaulting to the constant) only so the unit tests can exercise `enforce`; plan 3 deletes the constant and the parameter's default.
- **Interim relative paths:** until plan 3 makes `process.cwd()` virtual, a relative path resolves against the main process's real `process.cwd()` (the worker's cwd is the same), so module behaviour is unchanged. `FsBroker` takes `cwd` for this; plan 3 passes `'/app'`.
- **Link rules and `chmod` stripping apply in every mode** (user decision 9). Everything else in "Decide" depends on the mode.
- Limits: 256 open descriptors per worker; 16 MB per `read`/`write`; global in-flight cap `max(1, floor(UV_THREADPOOL_SIZE × 3/4))`; at most 2 in flight per worker while another worker waits; queue 4096 per worker, then `EMFILE`; `UV_THREADPOOL_SIZE` defaults to 16 unless the operator set it.
- Audit log lines: once per (module, rule, target), at most 100 distinct per broker, then one `suppressed` (the same cap shape as part 1's lockdown).
- Do not run the full `npm test` except in the last task. Kill stray servers by PID. Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A path that lies inside a root but whose real target (via a symlink planted in `/data`) is outside — `enforce` must answer `ENOENT`, `audit` must log `escape` and proceed (Task 3 test).
2. A module removing or renaming one of its roots itself (`rm -r /data`, `rename('/tmp', …)`) — must be `EBUSY`, never an empty data directory or a moved root (Task 3 test).
3. A declared path that is an ancestor of `--moduleDataPath` or the install directory (`/home` when data lives under `$HOME`) — refused at namespace creation in every mode (Task 2 test).
4. One worker flooding the scheduler while another does a single read — the single read must not wait behind the flood (Task 4 test).
5. A descriptor opened in `/data` whose file is swapped for a symlink between check and open — verify-after-open must close it and answer `ENOENT` under `enforce` (Task 3 test, simulated by swapping inside the check hook).

---

### Task 1: Module data directories and `--moduleDataPath`

**Files:**
- Create: `lib/module-data.js`, `test/fs-broker/01-module-data.js`
- Modify: `lib/cli-options.js` (new option next to `modulePath`, and `getOptions`), `lib/hardened-launch.js` (`permissionFlags`), `test/sandbox/09-hardened.js` is unchanged but must still pass

**Interfaces:**
- Produces: `require('./module-data')` → `{safeName(name): boolean, dirsFor(dataRoot, name): {root, data, tmp}, ensureDirs(dataRoot, name): Promise<{root, data, tmp}>}`; `options.moduleDataPath` (string).

- [ ] **Step 1: Write the failing test** — `test/fs-broker/01-module-data.js`:

```js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const md = require('../../lib/module-data');

describe('fs-broker 01: module data directories', () => {
  it('accepts npm-style names, scoped or not', () => {
    ['weather', 'sandbox-probe', '@acme/x', 'a.b_c~d', 'Legacy-Name'].forEach((n) => assert.strictEqual(md.safeName(n), true, n));
  });

  it('refuses names that could leave the data directory or collide', () => {
    ['', '.', '..', '../x', 'a/b', '@acme', '@/x', '@acme/../x', '@acme/.x', '.hidden', 'a\\b', 'a\0b', '@a/@b', 'x'.repeat(215)]
      .forEach((n) => assert.strictEqual(md.safeName(n), false, JSON.stringify(n)));
  });

  it('lays scoped names out as node_modules does', () => {
    const d = md.dirsFor('/srv/data', '@acme/x');
    assert.deepStrictEqual(d, {root: '/srv/data/@acme/x', data: '/srv/data/@acme/x/data', tmp: '/srv/data/@acme/x/tmp'});
    assert.strictEqual(md.dirsFor('/srv/data', 'x').root, '/srv/data/x');
  });

  it('leaves an existing --moduleDataPath\'s mode alone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-md-'));
    try {
      const store = path.join(root, 'store');
      fs.mkdirSync(store);
      fs.chmodSync(store, 0o750);
      const d = await md.ensureDirs(store, 'x');
      assert.strictEqual(fs.statSync(store).mode & 0o777, 0o750);
      assert.strictEqual(fs.statSync(d.root).mode & 0o777, 0o700);
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });

  it('creates the directories with mode 0700', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-md-'));
    try {
      const d = await md.ensureDirs(path.join(root, 'store'), '@acme/x');
      for (const p of [path.join(root, 'store'), path.join(root, 'store', '@acme'), d.root, d.data, d.tmp]) {
        assert.strictEqual(fs.statSync(p).mode & 0o777, 0o700, p);
      }
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });

  it('throws for an unsafe name', () => {
    assert.throws(() => md.dirsFor('/srv/data', '../etc'), /cannot be used as a data directory name/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx mocha test/fs-broker/01-module-data.js`
Expected: FAIL, `Cannot find module '../../lib/module-data'`.

- [ ] **Step 3: Implement** — `lib/module-data.js`:

```js
// Where each module's private /data and /tmp live on the host
// (docs/superpowers/specs/2026-10-17-module-sandbox-fs-broker-design.md,
// section 1): <moduleDataPath>/<name>/{data,tmp}, scoped names laid out as
// node_modules does (@scope/name), directories private to the service user.
const fs = require('fs');
const path = require('path');

// A name must map to exactly one directory under the data path and never
// leave it: one segment, or "@scope/name"; no empty, dot-leading or "@"-only
// segments; no backslash or NUL. Distinct names give distinct paths on a
// case-sensitive file system (Linux, the target); on macOS "Foo" and "foo"
// would share one, which npm's lowercase rule makes rare.
function safeName(name) {
  if (typeof(name) !== 'string' || name.length === 0 || name.length > 214) return false;
  if (name.includes('\0') || name.includes('\\')) return false;
  const parts = name.split('/');
  if (parts.length > 2) return false;
  if (parts.length === 2 && !(parts[0].startsWith('@') && parts[0].length > 1)) return false;
  return parts.every((part, i) => {
    if (part.length === 0 || part.startsWith('.')) return false;
    const scope = (parts.length === 2 && i === 0);
    return scope || !part.startsWith('@');
  });
}

function dirsFor(dataRoot, name) {
  if (!safeName(name)) throw new Error(`module name ${JSON.stringify(name)} cannot be used as a data directory name`);
  const root = path.join(path.resolve(dataRoot), ...name.split('/'));
  return {root: root, data: path.join(root, 'data'), tmp: path.join(root, 'tmp')};
}

// mkdir's mode is filtered by the umask, so each directory this creates is
// chmod'ed to 0700 afterwards. Directories that already exist (an operator's
// --moduleDataPath set to 0750 for a backup group, say) are left alone.
async function ensureDirs(dataRoot, name) {
  const d = dirsFor(dataRoot, name);
  for (const target of [d.data, d.tmp]) {
    const first = await fs.promises.mkdir(target, {recursive: true, mode: 0o700});
    if (first == null) continue;
    // mkdir returned the first directory it created; chmod it and every one below it
    for (let p = target; ; p = path.dirname(p)) {
      await fs.promises.chmod(p, 0o700);
      if (p === first) break;
    }
  }
  return d;
}

module.exports = {safeName, dirsFor, ensureDirs};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx mocha test/fs-broker/01-module-data.js`
Expected: 6 passing.

- [ ] **Step 5: The option and `--hardened`.**
  - `lib/cli-options.js`, after the `modulePath` line:
    ```js
    // Each module's private /data and /tmp (module sandbox part 2).
    this.moduleDataPath = argv.moduleDataPath || `${process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME']}/countinghouse_module_data`;
    ```
    and add `moduleDataPath: this.moduleDataPath,` to `getOptions()` next to `modulePath`.
  - `lib/hardened-launch.js` `permissionFlags`: add `path.resolve(cwd, options.moduleDataPath)` to both `read` and `write`.
  - Add a unit check to `test/fs-broker/01-module-data.js`:
    ```js
    it('--hardened grants read and write on --moduleDataPath', () => {
      const {permissionFlags} = require('../../lib/hardened-launch');
      const flags = permissionFlags({modulePath: '/m', moduleDataPath: '/d', debug: true, localModulePath: '/m/x'}, '/install', '/');
      assert.ok(flags.includes('--allow-fs-read=/d'), flags.join(' '));
      assert.ok(flags.includes('--allow-fs-write=/d'), flags.join(' '));
    });
    ```

- [ ] **Step 6: Run the tests** (tell the reviewer first: 09 uses port 9614)

Run: `npx mocha test/fs-broker/01-module-data.js && npx mocha --exit test/sandbox/09-hardened.js`
Expected: 7 passing; 09 all passing.

- [ ] **Step 7: Commit**

```bash
git add lib/module-data.js test/fs-broker/01-module-data.js lib/cli-options.js lib/hardened-launch.js
git commit -m "feat(fs-broker): module data directories and --moduleDataPath" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Also add `./test/fs-broker/*.js` to the `npm test` script in `package.json`, inside the existing `mocha ./test/auth/*.js …` run (in-process, no ports), in the same commit, and to the CI job's matching `npx mocha` line in `.github/workflows/ci.yml`.

---

### Task 2: The namespace

**Files:**
- Create: `lib/fs-broker/namespace.js`, `test/fs-broker/02-namespace.js`

**Interfaces:**
- Consumes: nothing from Task 1 at run time (paths are passed in).
- Produces: `createNamespace({moduleRoot, dataDir, tmpDir, declared: [{path, access: 'r'|'rw'}], protectedPaths: [string]})` → a namespace object; **`await ns.prepare()` before use** (realpaths every root and protected path once, decides refusals, records each root's type). After `prepare()`: `ns.roots` (each `{vroot, host, real, type: 'dir'|'file'|'missing', access, writable, quota, name: 'app'|'data'|'tmp'|'declared'}`), `ns.refused: [{path, reason}]`, `ns.resolve(p, cwd) → Resolution`, `ns.rootForReal(realHostPath) → root|null` (longest `real` match), `ns.toVirtual(hostPath) → string|null` (accepts `real` and `host` forms).
- `Resolution`: `{kind: 'root', virtual, host, root}` · `{kind: 'ancestor', virtual, children: [{name, type}]}` · `{kind: 'outside', virtual, host}`.
- Module function `toVirtualPath(p, cwd)` → normalised absolute POSIX path from a string, `Buffer` or `file:` URL.

- [ ] **Step 1: Write the failing test** — `test/fs-broker/02-namespace.js`:

```js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ns = require('../../lib/fs-broker/namespace');

// Paths that do not exist: prepare() keeps them as they are (real = host).
const CFG = {
  moduleRoot: '/srv/modules/weather', dataDir: '/srv/data/weather/data', tmpDir: '/srv/data/weather/tmp',
  declared: [{path: '/var/log/app', access: 'rw'}, {path: '/etc/weather', access: 'r'}],
  protectedPaths: ['/srv/countinghouse', '/srv/modules', '/srv/data', '/srv/countinghouse/auth.json']
};

async function prepared(cfg) {
  const n = ns.createNamespace(cfg);
  await n.prepare();
  return n;
}

function pick(r) {
  return {kind: r.kind, host: r.host, name: r.root.name, writable: r.root.writable};
}

describe('fs-broker 02: namespace', () => {
  it('maps the three virtual roots and declared paths, longest match first', async () => {
    const n = await prepared(CFG);
    assert.deepStrictEqual(pick(n.resolve('/app/handlers/x.js', '/')), {kind: 'root', host: '/srv/modules/weather/handlers/x.js', name: 'app', writable: false});
    assert.deepStrictEqual(pick(n.resolve('/data', '/')), {kind: 'root', host: '/srv/data/weather/data', name: 'data', writable: true});
    assert.deepStrictEqual(pick(n.resolve('/tmp/a/../b', '/')), {kind: 'root', host: '/srv/data/weather/tmp/b', name: 'tmp', writable: true});
    assert.deepStrictEqual(pick(n.resolve('/var/log/app/x.log', '/')), {kind: 'root', host: '/var/log/app/x.log', name: 'declared', writable: true});
    assert.deepStrictEqual(pick(n.resolve('/etc/weather/k', '/')), {kind: 'root', host: '/etc/weather/k', name: 'declared', writable: false});
  });

  it('does not treat a sibling with a common prefix as inside a root', async () => {
    const n = await prepared(CFG);
    assert.strictEqual(n.resolve('/database/x', '/').kind, 'outside');
    assert.strictEqual(n.resolve('/apps', '/').kind, 'outside');
  });

  it('synthesises ancestors that list only the next component, with its type', async () => {
    const n = await prepared(CFG);
    assert.deepStrictEqual(n.resolve('/', '/'), {kind: 'ancestor', virtual: '/',
      children: [{name: 'app', type: 'dir'}, {name: 'data', type: 'dir'}, {name: 'etc', type: 'dir'}, {name: 'tmp', type: 'dir'}, {name: 'var', type: 'dir'}]});
    assert.deepStrictEqual(n.resolve('/var/log', '/'), {kind: 'ancestor', virtual: '/var/log', children: [{name: 'app', type: 'dir'}]});
  });

  it('a declared root that is a file is listed as a file', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ns-')));
    try {
      fs.writeFileSync(path.join(base, 'w.conf'), 'x');
      const n = await prepared(Object.assign({}, CFG, {declared: [{path: path.join(base, 'w.conf'), access: 'r'}]}));
      const parent = n.resolve(base, '/');
      assert.deepStrictEqual(parent.children, [{name: 'w.conf', type: 'file'}]);
    } finally { fs.rmSync(base, {recursive: true, force: true}); }
  });

  it('a declared root that covers an ancestor answers as that root', async () => {
    const n = await prepared(Object.assign({}, CFG, {declared: [{path: '/var', access: 'r'}, {path: '/var/log/app', access: 'rw'}]}));
    assert.strictEqual(n.resolve('/var/log', '/').kind, 'root');
    assert.strictEqual(n.resolve('/var/log/app/x', '/').root.writable, true);
  });

  it('resolves relative paths against the given cwd', async () => {
    const n = await prepared(CFG);
    assert.strictEqual(n.resolve('handlers/x.js', '/app').host, '/srv/modules/weather/handlers/x.js');
    assert.strictEqual(n.resolve('x', '/home/u').kind, 'outside');
  });

  it('accepts Buffers and file: URLs', async () => {
    const n = await prepared(CFG);
    assert.strictEqual(n.resolve(Buffer.from('/data/x'), '/').host, '/srv/data/weather/data/x');
    assert.strictEqual(n.resolve(new URL('file:///tmp/y'), '/').host, '/srv/data/weather/tmp/y');
  });

  it('maps host paths back to virtual ones', async () => {
    const n = await prepared(CFG);
    assert.strictEqual(n.toVirtual('/srv/data/weather/tmp/q'), '/tmp/q');
    assert.strictEqual(n.toVirtual('/srv/modules/weather'), '/app');
    assert.strictEqual(n.toVirtual('/var/log/app/x'), '/var/log/app/x');
    assert.strictEqual(n.toVirtual('/etc/passwd'), null);
  });

  it('refuses a declared path that overlaps a protected path, either way round', async () => {
    const n = await prepared(Object.assign({}, CFG, {declared: [{path: '/srv', access: 'r'}, {path: '/srv/data/other', access: 'rw'}, {path: '/opt/ok', access: 'r'}]}));
    assert.deepStrictEqual(n.refused.map((r) => r.path), ['/srv', '/srv/data/other']);
    assert.strictEqual(n.resolve('/srv/data/other/x', '/').kind, 'outside');
    assert.strictEqual(n.resolve('/opt/ok/x', '/').kind, 'root');
  });

  // /home -> /var/home on Fedora Silverblue/CoreOS: textually disjoint, really the same.
  it('refuses an overlap that only shows after resolving symlinks', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ns-')));
    try {
      fs.mkdirSync(path.join(base, 'var', 'home', 'u', 'data'), {recursive: true});
      fs.symlinkSync(path.join(base, 'var', 'home'), path.join(base, 'home'));
      fs.mkdirSync(path.join(base, 'elsewhere'));
      fs.symlinkSync(path.join(base, 'var', 'home', 'u'), path.join(base, 'elsewhere', 'into-home'));
      const n = await prepared(Object.assign({}, CFG, {
        protectedPaths: [path.join(base, 'home', 'u', 'data')],
        declared: [{path: path.join(base, 'var'), access: 'r'}, {path: path.join(base, 'elsewhere', 'into-home'), access: 'rw'}]
      }));
      assert.deepStrictEqual(n.refused.map((r) => r.path).sort(), [path.join(base, 'elsewhere', 'into-home'), path.join(base, 'var')].sort());
    } finally { fs.rmSync(base, {recursive: true, force: true}); }
  });

  it('a root whose host path is a symlink maps its real paths back too', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ns-')));
    try {
      fs.mkdirSync(path.join(base, 'real-data'));
      fs.symlinkSync(path.join(base, 'real-data'), path.join(base, 'data-link'));
      const n = await prepared(Object.assign({}, CFG, {dataDir: path.join(base, 'data-link')}));
      assert.strictEqual(n.toVirtual(path.join(base, 'real-data', 'sub', 'x')), '/data/sub/x');
      assert.strictEqual(n.toVirtual(path.join(base, 'data-link', 'sub', 'x')), '/data/sub/x');
      assert.strictEqual(n.rootForReal(path.join(base, 'real-data', 'y')).name, 'data');
    } finally { fs.rmSync(base, {recursive: true, force: true}); }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx mocha test/fs-broker/02-namespace.js`
Expected: FAIL, `Cannot find module`.

- [ ] **Step 3: Implement** — `lib/fs-broker/namespace.js`:

```js
// A module's file namespace (docs/superpowers/specs/2026-10-17-module-
// sandbox-fs-broker-design.md, section 1): /app, /data, /tmp and declared
// paths, the synthesised directories above them, and everything else
// ("outside"). prepare() resolves every root and protected path once, at
// spawn; resolve() is then pure path arithmetic, and the broker does the
// per-request host checks against the prepared real paths.
const fsp = require('fs/promises');
const path = require('path').posix;
const url = require('url');

function inside(p, root) {
  return p === root || p.startsWith(root === '/' ? '/' : root + '/');
}

function toVirtualPath(p, cwd) {
  let s = p;
  if (Buffer.isBuffer(s)) s = s.toString('utf8');
  else if (s instanceof URL) s = url.fileURLToPath(s);
  else if (typeof(s) === 'string' && s.startsWith('file:')) s = url.fileURLToPath(s);
  if (typeof(s) !== 'string') throw new TypeError('path must be a string, Buffer or file URL');
  if (s.includes('\0')) throw Object.assign(new TypeError('path must not contain null bytes'), {code: 'ERR_INVALID_ARG_VALUE'});
  return path.resolve(cwd || '/', s);
}

async function realOf(p) {
  try { return await fsp.realpath(p); } catch (e) { return p; }
}

async function typeOf(p) {
  try { return (await fsp.stat(p)).isDirectory() ? 'dir' : 'file'; } catch (e) { return 'missing'; }
}

function createNamespace(cfg) {
  const self = {roots: [], refused: [], prepared: false};
  let byVroot = [];
  let byReal = [];
  let byHost = [];

  self.prepare = async function() {
    const protectedReal = [];
    for (const p of cfg.protectedPaths || []) protectedReal.push({text: p, real: await realOf(p)});
    const kept = [];
    for (const d of cfg.declared || []) {
      const real = await realOf(d.path);
      const clash = protectedReal.find((p) => inside(p.text, d.path) || inside(d.path, p.text) ||
        inside(p.real, real) || inside(real, p.real));
      if (clash != null) self.refused.push({path: d.path, reason: `overlaps countinghouse's ${clash.text}`});
      else kept.push(d);
    }
    const base = [
      {vroot: '/app', host: cfg.moduleRoot, access: 'r', writable: false, quota: false, name: 'app'},
      {vroot: '/data', host: cfg.dataDir, access: 'rw', writable: true, quota: true, name: 'data'},
      {vroot: '/tmp', host: cfg.tmpDir, access: 'rw', writable: true, quota: true, name: 'tmp'}
    ].concat(kept.map((d) => ({vroot: d.path, host: d.path, access: d.access, writable: d.access === 'rw', quota: false, name: 'declared'})));
    for (const r of base) {
      r.real = await realOf(r.host);
      r.type = await typeOf(r.host);
    }
    self.roots = base;
    byVroot = base.slice().sort((a, b) => b.vroot.length - a.vroot.length);
    byReal = base.slice().sort((a, b) => b.real.length - a.real.length);
    byHost = base.slice().sort((a, b) => b.host.length - a.host.length);
    self.prepared = true;
  };

  self.resolve = function(p, cwd) {
    if (!self.prepared) throw new Error('namespace used before prepare()');
    const v = toVirtualPath(p, cwd);
    const root = byVroot.find((r) => inside(v, r.vroot));
    if (root != null) return {kind: 'root', virtual: v, host: root.host + v.slice(root.vroot.length), root: root};
    const below = byVroot.filter((r) => inside(r.vroot, v) && r.vroot !== v);
    if (below.length > 0) {
      const seen = new Map();
      below.forEach((r) => {
        const rest = r.vroot.slice(v === '/' ? 1 : v.length + 1).split('/');
        const name = rest[0];
        const type = (rest.length === 1 && r.type === 'file') ? 'file' : 'dir';
        if (!seen.has(name) || type === 'dir') seen.set(name, type);
      });
      const children = Array.from(seen.keys()).sort().map((name) => ({name: name, type: seen.get(name)}));
      return {kind: 'ancestor', virtual: v, children: children};
    }
    return {kind: 'outside', virtual: v, host: v};
  };

  self.rootForReal = function(realPath) {
    return byReal.find((r) => inside(realPath, r.real)) || null;
  };

  self.toVirtual = function(hostPath) {
    const viaReal = byReal.find((r) => inside(hostPath, r.real));
    if (viaReal != null) return viaReal.vroot + hostPath.slice(viaReal.real.length);
    const viaHost = byHost.find((r) => inside(hostPath, r.host));
    return viaHost == null ? null : viaHost.vroot + hostPath.slice(viaHost.host.length);
  };

  return self;
}

module.exports = {createNamespace, toVirtualPath, inside};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx mocha test/fs-broker/02-namespace.js`
Expected: 11 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/fs-broker/namespace.js test/fs-broker/02-namespace.js
git commit -m "feat(fs-broker): the virtual namespace" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The broker's operations

**Files:**
- Create: `lib/fs-broker/broker.js`, `lib/fs-broker/errors.js`, `lib/fs-broker/rwlock.js`, `test/fs-broker/03-broker.js`

**Interfaces:**
- Consumes: `createNamespace` (prepared), `ns.rootForReal`, `ns.toVirtual`, `inside` (Task 2).
- Produces: `new FsBroker({name, mode: 'off'|'audit'|'enforce', namespace /* prepared */, cwd, report(rule, virtualPath), enforceFileDecisions?, hooks?})` with
  - `handle(op: string, args: Array) → Promise<result>` — rejects with a Node-shaped error;
  - `closeAll() → Promise<void>`;
  - op names, lock modes, `follow` flags and result shapes as in the `OPS` table (Step 4). `stat`-like results are `{kind: 'stats', bigint, fields}`; `readdir` with `withFileTypes` returns `[{name, type, parentPath}]`, `type` one of `'file'|'dir'|'symlink'|'other'`.
  - `hooks.afterCheck(syscall, host) → void|Promise` — test-only seam, awaited between the host check and the operation, inside the operation's lock (Review Focus 5, lock tests); not passed in production.
- Produces: `errors.nodeError(code, syscall, vpath, dest?)`; `errors.rewrite(err, syscall, placed, destPlaced, namespace)` — any error out of a host operation, re-addressed: `E*` codes become a fresh `nodeError`; anything else (`ERR_FS_EISDIR`, `ERR_FS_CP_*` …) keeps its `code` with host paths scrubbed to virtual ones in `message`, `path` and `dest`.

**Lock rule (spec section 3):** operations that resolve a path take the module's lock shared; operations that create, remove, rename or change metadata of a path take it exclusive; `open` is exclusive only when it can create or replace (`w`, `a`, `x` flags, or `O_CREAT`/`O_TRUNC`/`O_EXCL`); descriptor operations take no path lock and are ordered per descriptor.

**Follow rule:** operations that act on a symlink itself (`lstat`, `readlink`, `unlink`, `rm`, `rmdir`, `rename`, `link`, `symlink`, `lchown`, `lutimes`, `mkdir`, `mkdtemp`) are checked through their parent's realpath and the leaf's `lstat`; the others follow the leaf. Either way, the root that contains the **real** location decides access: a link from `/data` into a declared `r` directory is not writable.

- [ ] **Step 1: Write the failing tests** — `test/fs-broker/03-broker.js`:

```js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');

async function setup(mode, opts) {
  opts = opts || {};
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-broker-')));
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp'),
    outside: path.join(base, 'outside'), ro: path.join(base, 'ro')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  fs.writeFileSync(path.join(dirs.app, 'index.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(dirs.outside, 'secret'), 'no');
  fs.writeFileSync(path.join(dirs.ro, 'config'), 'ro');
  if (opts.dataIsLink) {
    fs.renameSync(dirs.data, path.join(base, 'real-data'));
    fs.symlinkSync(path.join(base, 'real-data'), dirs.data);
  }
  const reports = [];
  const namespace = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp,
    declared: [{path: dirs.ro, access: 'r'}], protectedPaths: []});
  await namespace.prepare();
  const broker = new FsBroker({name: 'm', mode: mode, namespace: namespace, cwd: '/',
    report: (rule, target) => reports.push(`${rule} ${target}`),
    enforceFileDecisions: opts.enforceFileDecisions != null ? opts.enforceFileDecisions : true, hooks: opts.hooks});
  return {base, dirs, broker, reports, done: () => broker.closeAll().then(() => fs.rmSync(base, {recursive: true, force: true}))};
}

function gate() {
  let open;
  const p = new Promise((r) => { open = r; });
  return {wait: () => p, open: open};
}

const tick = () => new Promise((r) => setTimeout(r, 30));

describe('fs-broker 03: broker operations', function() {
  this.timeout(10000);

  it('writes, reads and lists inside /data, answering virtual paths', async () => {
    const t = await setup('enforce');
    try {
      const fd = await t.broker.handle('open', ['/data/a.txt', 'w', 0o644]);
      assert.ok(fd >= 3);
      assert.strictEqual(await t.broker.handle('write', [fd, Buffer.from('hello'), null]), 5);
      await t.broker.handle('close', [fd]);
      const rfd = await t.broker.handle('open', ['/data/a.txt', 'r']);
      assert.strictEqual(Buffer.from(await t.broker.handle('read', [rfd, 100, 0])).toString(), 'hello');
      await t.broker.handle('close', [rfd]);
      assert.deepStrictEqual(await t.broker.handle('readdir', ['/data', {withFileTypes: true}]), [{name: 'a.txt', type: 'file', parentPath: '/data'}]);
      assert.strictEqual(await t.broker.handle('realpath', ['/data/a.txt']), '/data/a.txt');
      assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, 'a.txt'), 'utf8'), 'hello');
    } finally { await t.done(); }
  });

  it('enforce: outside is ENOENT with a virtual path, and is reported', async () => {
    const t = await setup('enforce');
    try {
      const secret = path.join(t.dirs.outside, 'secret');
      await assert.rejects(t.broker.handle('stat', [secret]), (e) => e.code === 'ENOENT' && e.path === secret && e.errno < 0 && e.syscall === 'stat');
      assert.ok(t.reports.includes(`outside ${secret}`), t.reports.join('\n'));
    } finally { await t.done(); }
  });

  it('audit: outside passes through and is reported once', async () => {
    const t = await setup('audit');
    try {
      const secret = path.join(t.dirs.outside, 'secret');
      assert.strictEqual((await t.broker.handle('stat', [secret])).fields.size, 2);
      await t.broker.handle('stat', [secret]);
      assert.strictEqual(t.reports.filter((r) => r === `outside ${secret}`).length, 1);
    } finally { await t.done(); }
  });

  it('off: outside passes through silently', async () => {
    const t = await setup('off');
    try {
      await t.broker.handle('stat', [path.join(t.dirs.outside, 'secret')]);
      assert.deepStrictEqual(t.reports, []);
    } finally { await t.done(); }
  });

  it('the plan 3 gate: enforce behaves as audit while enforceFileDecisions is false', async () => {
    const t = await setup('enforce', {enforceFileDecisions: false});
    try {
      assert.strictEqual((await t.broker.handle('stat', [path.join(t.dirs.outside, 'secret')])).fields.size, 2);
    } finally { await t.done(); }
  });

  it('enforce: /app is read-only (EROFS); audit allows and reports it', async () => {
    const e = await setup('enforce');
    try {
      await assert.rejects(e.broker.handle('open', ['/app/index.js', 'w']), (err) => err.code === 'EROFS' && err.path === '/app/index.js');
    } finally { await e.done(); }
    const a = await setup('audit');
    try {
      await a.broker.handle('close', [await a.broker.handle('open', ['/app/new.js', 'w'])]);
      assert.ok(a.reports.includes('readonly /app/new.js'), a.reports.join('\n'));
    } finally { await a.done(); }
  });

  it('a symlink planted in /data that points outside: reading through it is refused under enforce, reported under audit', async () => {
    const e = await setup('enforce');
    try {
      fs.symlinkSync(path.join(e.dirs.outside, 'secret'), path.join(e.dirs.data, 'link'));
      await assert.rejects(e.broker.handle('open', ['/data/link', 'r']), (err) => err.code === 'ENOENT' && err.path === '/data/link');
    } finally { await e.done(); }
    const a = await setup('audit');
    try {
      fs.symlinkSync(path.join(a.dirs.outside, 'secret'), path.join(a.dirs.data, 'link'));
      await a.broker.handle('close', [await a.broker.handle('open', ['/data/link', 'r'])]);
      assert.ok(a.reports.includes('escape /data/link'), a.reports.join('\n'));
    } finally { await a.done(); }
  });

  it('the same link can be lstat\'d, read as a link and removed under enforce', async () => {
    const t = await setup('enforce');
    try {
      const target = path.join(t.dirs.outside, 'secret');
      fs.symlinkSync(target, path.join(t.dirs.data, 'link'));
      assert.strictEqual((await t.broker.handle('lstat', ['/data/link'])).fields.mode & 0o170000, 0o120000);
      assert.strictEqual(await t.broker.handle('readlink', ['/data/link']), target);
      await t.broker.handle('unlink', ['/data/link']);
      assert.strictEqual(fs.existsSync(path.join(t.dirs.data, 'link')), false);
    } finally { await t.done(); }
  });

  it('readlink maps an absolute target inside a root back to its virtual path', async () => {
    const t = await setup('enforce');
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'f'), 'x');
      fs.symlinkSync(path.join(t.dirs.data, 'f'), path.join(t.dirs.data, 'abs'));
      assert.strictEqual(await t.broker.handle('readlink', ['/data/abs']), '/data/f');
    } finally { await t.done(); }
  });

  it('the real target\'s root decides access: a link from /data into a declared r directory is not writable', async () => {
    const e = await setup('enforce');
    try {
      fs.symlinkSync(path.join(e.dirs.ro, 'config'), path.join(e.dirs.data, 'cfg'));
      await assert.rejects(e.broker.handle('open', ['/data/cfg', 'w']), (err) => err.code === 'EROFS' && err.path === '/data/cfg');
      await e.broker.handle('close', [await e.broker.handle('open', ['/data/cfg', 'r'])]);
    } finally { await e.done(); }
  });

  it('a /data that is itself a symlink answers canonical virtual paths', async () => {
    const t = await setup('enforce', {dataIsLink: true});
    try {
      await t.broker.handle('mkdir', ['/data/sub', {}]);
      await t.broker.handle('close', [await t.broker.handle('open', ['/data/sub/x', 'w'])]);
      assert.strictEqual(await t.broker.handle('realpath', ['/data/sub/x']), '/data/sub/x');
      assert.deepStrictEqual(await t.broker.handle('readdir', ['/data', {withFileTypes: true, recursive: true}]),
        [{name: 'sub', type: 'dir', parentPath: '/data'}, {name: 'x', type: 'file', parentPath: '/data/sub'}]);
    } finally { await t.done(); }
  });

  it('a root itself cannot be removed or renamed (EBUSY), in every mode', async () => {
    for (const mode of ['off', 'audit', 'enforce']) {
      const t = await setup(mode);
      try {
        await assert.rejects(t.broker.handle('rm', ['/data', {recursive: true, force: true}]), (e) => e.code === 'EBUSY', mode);
        await assert.rejects(t.broker.handle('rename', ['/tmp', '/data/t']), (e) => e.code === 'EBUSY', mode);
        assert.ok(fs.existsSync(t.dirs.data) && fs.existsSync(t.dirs.tmp), mode);
      } finally { await t.done(); }
    }
  });

  it('link rules in every mode: hard links only within one writable root, symlinks only relative and inside', async () => {
    for (const mode of ['off', 'audit', 'enforce']) {
      const t = await setup(mode);
      try {
        await assert.rejects(t.broker.handle('link', ['/app/index.js', '/data/x.js']), (e) => e.code === 'EPERM', mode);
        await assert.rejects(t.broker.handle('symlink', ['/etc', '/data/l']), (e) => e.code === 'EPERM', mode);
        await assert.rejects(t.broker.handle('symlink', ['../app/index.js', '/data/l']), (e) => e.code === 'EPERM', mode);
        fs.writeFileSync(path.join(t.dirs.data, 'f'), 'x');
        await t.broker.handle('link', ['/data/f', '/data/g']);
        await t.broker.handle('symlink', ['f', '/data/s']);
        assert.strictEqual(fs.readlinkSync(path.join(t.dirs.data, 's')), 'f', mode);
      } finally { await t.done(); }
    }
  });

  it('chmod strips setuid, setgid and sticky bits', async () => {
    const t = await setup('off');
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'f'), 'x');
      await t.broker.handle('chmod', ['/data/f', 0o7755]);
      assert.strictEqual(fs.statSync(path.join(t.dirs.data, 'f')).mode & 0o7777, 0o755);
    } finally { await t.done(); }
  });

  it('descriptors: numbered from 3, at most 256, unknown or 0-2 are EBADF', async () => {
    const t = await setup('enforce');
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'f'), 'x');
      const fds = [];
      for (let i = 0; i < 256; i++) fds.push(await t.broker.handle('open', ['/data/f', 'r']));
      assert.strictEqual(fds[0], 3);
      await assert.rejects(t.broker.handle('open', ['/data/f', 'r']), (e) => e.code === 'EMFILE');
      for (const fd of [0, 1, 2, 9999]) await assert.rejects(t.broker.handle('read', [fd, 1, 0]), (e) => e.code === 'EBADF', String(fd));
    } finally { await t.done(); }
  });

  it('read and write are capped at 16 MB per call', async () => {
    const t = await setup('enforce');
    try {
      const fd = await t.broker.handle('open', ['/data/big', 'w']);
      await assert.rejects(t.broker.handle('write', [fd, Buffer.alloc(16 * 1024 * 1024 + 1), null]), (e) => e.code === 'EINVAL');
      await assert.rejects(t.broker.handle('read', [fd, 16 * 1024 * 1024 + 1, 0]), (e) => e.code === 'EINVAL');
    } finally { await t.done(); }
  });

  it('verify after open: a file swapped for a symlink between check and open is refused under enforce', async () => {
    const t = await setup('enforce', {hooks: {afterCheck: (syscall, host) => {
      if (syscall === 'open' && host.endsWith('/swap')) {
        fs.rmSync(host);
        fs.symlinkSync(path.join(path.dirname(path.dirname(host)), 'outside', 'secret'), host);
      }
    }}});
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'swap'), 'in');
      await assert.rejects(t.broker.handle('open', ['/data/swap', 'r']), (e) => e.code === 'ENOENT' && e.path === '/data/swap');
    } finally { await t.done(); }
  });

  it('errors from the host carry the virtual path, never the host path', async () => {
    const t = await setup('enforce');
    try {
      await assert.rejects(t.broker.handle('stat', ['/data/missing']), (e) => e.code === 'ENOENT' && e.path === '/data/missing' &&
        !e.message.includes(t.base) && e.message.includes('/data/missing'));
    } finally { await t.done(); }
  });

  it('non-E* errors keep their code and lose the host path', async () => {
    const t = await setup('enforce');
    try {
      fs.mkdirSync(path.join(t.dirs.data, 'd'));
      await assert.rejects(t.broker.handle('rm', ['/data/d', {}]), (e) => e.code === 'ERR_FS_EISDIR' && !e.message.includes(t.base) && e.message.includes('/data/d'));
    } finally { await t.done(); }
  });

  it('enforce: synthesised ancestors list only the next component and cannot be written', async () => {
    const t = await setup('enforce');
    try {
      const names = await t.broker.handle('readdir', ['/', {}]);
      assert.ok(['app', 'data', 'tmp'].every((n) => names.includes(n)), names.join(','));
      assert.strictEqual((await t.broker.handle('stat', ['/'])).fields.mode & 0o170000, 0o040000);
      await assert.rejects(t.broker.handle('mkdir', ['/new', {}]), (e) => e.code === 'EROFS');
    } finally { await t.done(); }
  });

  it('closeAll closes every open descriptor', async () => {
    const t = await setup('enforce');
    fs.writeFileSync(path.join(t.dirs.data, 'f'), 'x');
    const fd = await t.broker.handle('open', ['/data/f', 'r']);
    await t.broker.closeAll();
    await assert.rejects(t.broker.handle('read', [fd, 1, 0]), (e) => e.code === 'EBADF' || e.code === 'EIO');
    fs.rmSync(t.base, {recursive: true, force: true});
  });

  it('a mutation waits for a read that holds the lock (deterministic)', async () => {
    const g = gate();
    const t = await setup('enforce', {hooks: {afterCheck: (syscall, host) => (syscall === 'stat' && host.endsWith('/f') ? g.wait() : null)}});
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'f'), 'x');
      const stat = t.broker.handle('stat', ['/data/f']);
      await tick();
      const rename = t.broker.handle('rename', ['/data/f', '/data/g']);
      await tick();
      assert.ok(fs.existsSync(path.join(t.dirs.data, 'f')), 'rename ran while a read held the lock');
      g.open();
      await stat;
      await rename;
      assert.ok(fs.existsSync(path.join(t.dirs.data, 'g')));
    } finally { await t.done(); }
  });

  it('reads share the lock: a read-only open is not held up by a paused stat', async () => {
    const g = gate();
    const t = await setup('enforce', {hooks: {afterCheck: (syscall, host) => (syscall === 'stat' ? g.wait() : null)}});
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'f'), 'x');
      const stat = t.broker.handle('stat', ['/data/f']);
      await tick();
      const fd = await t.broker.handle('open', ['/data/f', 'r']);
      await t.broker.handle('close', [fd]);
      g.open();
      await stat;
    } finally { await t.done(); }
  });

  it('descriptor operations take no path lock: a write proceeds while a mutation is paused', async () => {
    const g = gate();
    const t = await setup('enforce', {hooks: {afterCheck: (syscall) => (syscall === 'mkdir' ? g.wait() : null)}});
    try {
      const fd = await t.broker.handle('open', ['/data/f', 'w']);
      const mkdir = t.broker.handle('mkdir', ['/data/d', {}]);
      await tick();
      assert.strictEqual(await t.broker.handle('write', [fd, Buffer.from('x'), null]), 1);
      await t.broker.handle('close', [fd]);
      g.open();
      await mkdir;
    } finally { await t.done(); }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx mocha test/fs-broker/03-broker.js`
Expected: FAIL, `Cannot find module '../../lib/fs-broker/broker'`.

- [ ] **Step 3: Implement the helpers.** `lib/fs-broker/errors.js`:

```js
// Node-shaped errors for the broker: code, negative errno, syscall, and the
// path the module gave (virtual), never a host path inside its namespace.
const os = require('os');

const TEXT = {
  ENOENT: 'no such file or directory', EROFS: 'read-only file system', EPERM: 'operation not permitted',
  EBUSY: 'resource busy or locked', EMFILE: 'too many open files', EBADF: 'bad file descriptor',
  EXDEV: 'cross-device link not permitted', ETIMEDOUT: 'connection timed out', EIO: 'i/o error',
  EINVAL: 'invalid argument', EACCES: 'permission denied', EISDIR: 'illegal operation on a directory',
  EEXIST: 'file already exists', ENOTDIR: 'not a directory', ENOTEMPTY: 'directory not empty', ELOOP: 'too many symbolic links encountered'
};

function nodeError(code, syscall, vpath, dest) {
  const where = vpath != null ? ` '${vpath}'${dest != null ? ` -> '${dest}'` : ''}` : '';
  const err = new Error(`${code}: ${TEXT[code] || code.toLowerCase()}, ${syscall}${where}`);
  err.code = code;
  err.errno = -(os.constants.errno[code] || 0);
  err.syscall = syscall;
  if (vpath != null) err.path = vpath;
  if (dest != null) err.dest = dest;
  return err;
}

function scrub(text, placed, dest, namespace) {
  let s = String(text);
  [placed, dest].forEach((p) => { if (p != null && p.host != null && p.host !== p.virtual) s = s.split(p.host).join(p.virtual); });
  const roots = (namespace != null ? namespace.roots : []).slice().sort((a, b) => b.real.length - a.real.length);
  roots.forEach((r) => {
    if (r.real !== r.vroot) s = s.split(r.real).join(r.vroot);
    if (r.host !== r.vroot) s = s.split(r.host).join(r.vroot);
  });
  return s;
}

// Any error out of a host operation, re-addressed to the module's paths.
function rewrite(e, syscall, placed, dest, namespace) {
  if (e == null || typeof(e) !== 'object') return e;
  const vpath = placed != null ? placed.virtual : undefined;
  const vdest = dest != null ? dest.virtual : undefined;
  if (typeof(e.code) === 'string' && /^E[A-Z0-9]+$/.test(e.code)) return nodeError(e.code, e.syscall || syscall, vpath, vdest);
  const out = new Error(scrub(e.message, placed, dest, namespace));
  if (e.code != null) out.code = e.code;
  if (e.syscall != null) out.syscall = e.syscall;
  if (vpath != null) out.path = vpath;
  if (vdest != null) out.dest = vdest;
  return out;
}

module.exports = {nodeError, rewrite, scrub};
```

`lib/fs-broker/rwlock.js`:

```js
// One module's read/write lock: path-resolving operations share it,
// path mutations take it alone, in arrival order, so a module cannot race
// itself between the broker's check and the operation.
class RwLock {
  constructor() {
    this.readers = 0;
    this.writer = false;
    this.queue = [];
  }

  acquire(exclusive) {
    return new Promise((resolve) => {
      this.queue.push({exclusive, resolve});
      this.pump();
    });
  }

  release(exclusive) {
    if (exclusive) this.writer = false; else this.readers--;
    this.pump();
  }

  pump() {
    while (this.queue.length > 0 && !this.writer) {
      const next = this.queue[0];
      if (next.exclusive && this.readers > 0) return;
      this.queue.shift();
      if (next.exclusive) this.writer = true; else this.readers++;
      next.resolve();
      if (next.exclusive) return;
    }
  }
}

module.exports = {RwLock};
```

- [ ] **Step 4: Implement the broker** — `lib/fs-broker/broker.js`:

```js
// One module worker's file broker on the main thread (docs/superpowers/
// specs/2026-10-17-module-sandbox-fs-broker-design.md, section 3). Each call
// runs one primitive operation: decide by mode, check on the host, run it
// with Node's async fs, verify after open, and answer with virtual paths.
const fsp = require('fs/promises');
const fs = require('fs');
const posix = require('path').posix;
const {inside} = require('./namespace');
const {nodeError, rewrite} = require('./errors');
const {RwLock} = require('./rwlock');

// Plan 3 gate (plan 2a, Global Constraints): while false, enforce makes the
// same file decisions as audit. Not an option; plan 3 deletes it.
const ENFORCE_FILE_DECISIONS = false;
const MAX_FDS = 256;
const MAX_IO = 16 * 1024 * 1024;
const MAX_REPORTS = 100;
const ANCESTOR_STATS = {dev: 0, ino: 0, mode: 0o040555, nlink: 1, uid: 0, gid: 0, rdev: 0, size: 0, blksize: 4096, blocks: 0,
  atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0};
const STAT_KEYS = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs'];

function statsOut(st, bigint) {
  const f = {};
  STAT_KEYS.forEach((k) => { f[k] = st[k]; });
  if (bigint) ['atimeNs', 'mtimeNs', 'ctimeNs', 'birthtimeNs'].forEach((k) => { f[k] = st[k]; });
  return {kind: 'stats', bigint: bigint === true, fields: f};
}

function direntType(d) {
  if (d.isFile()) return 'file';
  if (d.isDirectory()) return 'dir';
  if (d.isSymbolicLink()) return 'symlink';
  return 'other';
}

function openFlags(flags) {
  if (typeof(flags) === 'number') {
    const c = fs.constants;
    return {
      writes: (flags & (c.O_WRONLY | c.O_RDWR | c.O_CREAT | c.O_TRUNC | c.O_APPEND)) !== 0,
      creates: (flags & (c.O_CREAT | c.O_TRUNC | c.O_EXCL)) !== 0
    };
  }
  const f = String(flags == null ? 'r' : flags);
  return {writes: /[wax+]/.test(f), creates: /[wax]/.test(f)};
}

class FsBroker {
  constructor(opts) {
    this.name = opts.name;
    this.mode = opts.mode;
    this.ns = opts.namespace;
    this.cwd = opts.cwd || '/';
    this.reportFn = opts.report || (() => {});
    this.enforce = (opts.mode === 'enforce') &&
      (opts.enforceFileDecisions != null ? opts.enforceFileDecisions === true : ENFORCE_FILE_DECISIONS);
    this.hooks = opts.hooks || {};
    this.lock = new RwLock();
    this.fds = new Map();
    this.nextFd = 3;
    this.reported = new Set();
    this.closed = false;
  }

  report(rule, target) {
    if (this.mode === 'off') return;
    const key = `${rule}\0${target}`;
    if (this.reported.has(key) || this.reported.size > MAX_REPORTS) return;
    this.reported.add(key);
    if (this.reported.size > MAX_REPORTS) return this.reportFn('suppressed', '');
    this.reportFn(rule, target);
  }

  async handle(op, args) {
    const spec = OPS[op];
    if (spec == null) throw nodeError('EINVAL', op);
    if (this.closed) throw nodeError('EIO', op);
    const a = args || [];
    const mode = (typeof(spec.lock) === 'function') ? spec.lock(a) : spec.lock;
    if (mode === 'none') return spec.run.call(this, a);
    const exclusive = (mode === 'exclusive');
    await this.lock.acquire(exclusive);
    try {
      return await spec.run.call(this, a);
    } finally {
      this.lock.release(exclusive);
    }
  }

  // Place one path argument for an operation that wants 'r' or 'w'.
  // Returns {res, host, virtual, root, ident} or throws the module-facing error.
  async place(p, want, syscall, follow) {
    const res = this.ns.resolve(p, this.cwd);
    const v = res.virtual;
    if (res.kind === 'ancestor') {
      if (!this.enforce) return {res: {kind: 'outside', virtual: v, host: v}, host: v, virtual: v};
      if (want === 'w') throw nodeError('EROFS', syscall, v);
      return {res, host: null, virtual: v};
    }
    if (res.kind === 'outside') {
      this.report('outside', v);
      if (this.enforce) throw nodeError('ENOENT', syscall, v);
      return {res, host: v, virtual: v};
    }
    const placed = {res, host: res.host, virtual: v, root: res.root, ident: null};
    const chk = await this.checkHost(placed, syscall, follow !== false);
    if (chk.escape) {
      this.report('escape', v);
      if (this.enforce) throw nodeError('ENOENT', syscall, v);
    } else {
      placed.root = chk.root;
      placed.ident = chk.ident;
    }
    if (want === 'w' && !placed.root.writable) {
      this.report('readonly', v);
      if (this.enforce) throw nodeError('EROFS', syscall, v);
    }
    if (this.hooks.afterCheck) await this.hooks.afterCheck(syscall, res.host);
    return placed;
  }

  // Where the object the operation acts on really is, and which root holds
  // it. Following ops resolve the leaf; no-follow ops (acting on a link
  // itself) resolve the parent and lstat the leaf. Returns {root, ident},
  // or {escape: true} when the real location is in no root.
  async checkHost(placed, syscall, follow) {
    const res = placed.res;
    const isRootItself = (res.virtual === res.root.vroot);
    let realLoc = null;
    let ident = null;
    const viaParent = async() => {
      const parentReal = await fsp.realpath(posix.dirname(res.host)).catch(() => null);
      if (parentReal == null) return false;   // the operation itself answers ENOENT
      realLoc = posix.join(parentReal, posix.basename(res.host));
      const st = await fsp.lstat(realLoc).catch(() => null);
      ident = (st != null && !follow) ? {dev: st.dev, ino: st.ino} : {parent: parentReal};
      return true;
    };
    if (follow || isRootItself) {
      try {
        realLoc = await fsp.realpath(res.host);
        const st = await fsp.stat(realLoc);
        ident = {dev: st.dev, ino: st.ino};
      } catch (e) {
        if (e.code !== 'ENOENT') throw rewrite(e, syscall, placed, null, this.ns);
        if (!(await viaParent())) return {root: res.root, ident: null};
      }
    } else if (!(await viaParent())) {
      return {root: res.root, ident: null};
    }
    const root = this.ns.rootForReal(realLoc);
    if (root == null) return {escape: true};
    return {root: root, ident: ident};
  }

  async verifyOpened(fh, placed, syscall) {
    if (!this.enforce || placed.ident == null || placed.res.kind !== 'root') return;
    let ok = true;
    if (placed.ident.parent !== undefined) {
      const parentReal = await fsp.realpath(posix.dirname(placed.host)).catch(() => null);
      ok = (parentReal != null && parentReal === placed.ident.parent);
    } else {
      const st = await fh.stat();
      ok = (st.dev === placed.ident.dev && st.ino === placed.ident.ino);
    }
    if (ok && process.platform === 'linux') {
      const link = await fsp.readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);
      if (link != null && this.ns.rootForReal(link) == null) ok = false;
    }
    if (!ok) {
      await fh.close().catch(() => {});
      this.report('escape', placed.virtual);
      throw nodeError('ENOENT', syscall, placed.virtual);
    }
  }

  isRoot(placed) {
    return placed.res.kind === 'root' && placed.res.virtual === placed.res.root.vroot;
  }

  fdEntry(fd, syscall) {
    const e = this.fds.get(fd);
    if (e == null) throw nodeError('EBADF', syscall);
    return e;
  }

  out(hostPath, placed) {
    if (placed.res.kind !== 'root') return hostPath;
    const v = this.ns.toVirtual(hostPath);
    return v != null ? v : placed.virtual;
  }

  run(placed, syscall, fn, dest) {
    return fn().catch((e) => { throw rewrite(e, syscall, placed, dest, this.ns); });
  }

  async closeAll() {
    this.closed = true;
    const all = Array.from(this.fds.values());
    this.fds.clear();
    await Promise.all(all.map((e) => e.fh.close().catch(() => {})));
  }
}

const SHARED = 'shared';
const EXCL = 'exclusive';
const NONE = 'none';

// Each operation: lock mode (or a function of its args), and run(args).
const OPS = {
  access: {lock: SHARED, async run(a) {
    const p = await this.place(a[0], 'r', 'access');
    if (p.host == null) return true;
    return this.run(p, 'access', () => fsp.access(p.host, a[1]).then(() => true));
  }},
  exists: {lock: SHARED, async run(a) {
    try {
      const p = await this.place(a[0], 'r', 'access');
      if (p.host != null) await fsp.access(p.host);
      return true;
    } catch (e) { return false; }
  }},
  stat: {lock: SHARED, async run(a) {
    const p = await this.place(a[0], 'r', 'stat');
    const big = !!(a[1] && a[1].bigint);
    if (p.host == null) return statsOut(ANCESTOR_STATS, false);
    return this.run(p, 'stat', () => fsp.stat(p.host, {bigint: big}).then((s) => statsOut(s, big)));
  }},
  lstat: {lock: SHARED, async run(a) {
    const p = await this.place(a[0], 'r', 'lstat', false);
    const big = !!(a[1] && a[1].bigint);
    if (p.host == null) return statsOut(ANCESTOR_STATS, false);
    return this.run(p, 'lstat', () => fsp.lstat(p.host, {bigint: big}).then((s) => statsOut(s, big)));
  }},
  realpath: {lock: SHARED, async run(a) {
    const p = await this.place(a[0], 'r', 'realpath');
    if (p.host == null) return p.virtual;
    return this.run(p, 'realpath', () => fsp.realpath(p.host).then((r) => this.out(r, p)));
  }},
  readlink: {lock: SHARED, async run(a) {
    const p = await this.place(a[0], 'r', 'readlink', false);
    return this.run(p, 'readlink', async() => {
      const target = await fsp.readlink(p.host);
      if (!posix.isAbsolute(target)) return target;
      const v = this.ns.toVirtual(target);
      return v != null ? v : target;
    });
  }},
  readdir: {lock: SHARED, async run(a) {
    const p = await this.place(a[0], 'r', 'scandir');
    const opts = a[1] || {};
    if (p.host == null) {
      const kids = p.res.children;
      return opts.withFileTypes ? kids.map((k) => ({name: k.name, type: k.type, parentPath: p.virtual})) : kids.map((k) => k.name);
    }
    return this.run(p, 'scandir', async() => {
      const list = await fsp.readdir(p.host, {withFileTypes: !!opts.withFileTypes, recursive: !!opts.recursive});
      if (!opts.withFileTypes) return list.map(String);
      return list.map((d) => ({name: d.name, type: direntType(d), parentPath: this.out(d.parentPath || p.host, p)}));
    });
  }},
  statfs: {lock: SHARED, async run(a) {
    const p = await this.place(a[0], 'r', 'statfs');
    return this.run(p, 'statfs', () => fsp.statfs(p.host).then((s) => Object.assign({}, s)));
  }},

  mkdir: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'mkdir', false);
    return this.run(p, 'mkdir', () => fsp.mkdir(p.host, a[1]).then((r) => (r == null ? undefined : this.out(r, p))));
  }},
  mkdtemp: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'mkdtemp', false);
    return this.run(p, 'mkdtemp', () => fsp.mkdtemp(p.host).then((r) => this.out(r, p)));
  }},
  rmdir: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'rmdir', false);
    if (this.isRoot(p)) throw nodeError('EBUSY', 'rmdir', p.virtual);
    return this.run(p, 'rmdir', () => fsp.rmdir(p.host));
  }},
  rm: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'rm', false);
    if (this.isRoot(p)) throw nodeError('EBUSY', 'rm', p.virtual);
    return this.run(p, 'rm', () => fsp.rm(p.host, a[1]));
  }},
  unlink: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'unlink', false);
    if (this.isRoot(p)) throw nodeError('EBUSY', 'unlink', p.virtual);
    return this.run(p, 'unlink', () => fsp.unlink(p.host));
  }},
  rename: {lock: EXCL, async run(a) {
    const from = await this.place(a[0], 'w', 'rename', false);
    const to = await this.place(a[1], 'w', 'rename', false);
    if (this.isRoot(from) || this.isRoot(to)) throw nodeError('EBUSY', 'rename', from.virtual, to.virtual);
    if (from.res.kind === 'root' && to.res.kind === 'root' && from.root !== to.root) throw nodeError('EXDEV', 'rename', from.virtual, to.virtual);
    return this.run(from, 'rename', () => fsp.rename(from.host, to.host), to);
  }},
  copyFile: {lock: EXCL, async run(a) {
    const from = await this.place(a[0], 'r', 'copyfile');
    const to = await this.place(a[1], 'w', 'copyfile');
    return this.run(from, 'copyfile', () => fsp.copyFile(from.host, to.host, a[2]), to);
  }},
  link: {lock: EXCL, async run(a) {
    const from = await this.place(a[0], 'r', 'link', false);
    const to = await this.place(a[1], 'w', 'link', false);
    const touches = from.res.kind === 'root' || to.res.kind === 'root';
    if (touches && !(from.res.kind === 'root' && to.res.kind === 'root' && from.root === to.root && to.root.writable)) {
      throw nodeError('EPERM', 'link', from.virtual, to.virtual);
    }
    return this.run(from, 'link', () => fsp.link(from.host, to.host), to);
  }},
  symlink: {lock: EXCL, async run(a) {
    const target = String(a[0]);
    const at = await this.place(a[1], 'w', 'symlink', false);
    if (at.res.kind === 'root') {
      const resolved = posix.resolve(posix.dirname(at.virtual), target);
      if (posix.isAbsolute(target) || !inside(resolved, at.res.root.vroot)) throw nodeError('EPERM', 'symlink', target, at.virtual);
    }
    return this.run(at, 'symlink', () => fsp.symlink(target, at.host, a[2]));
  }},
  chmod: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'chmod');
    return this.run(p, 'chmod', () => fsp.chmod(p.host, Number(a[1]) & 0o777));
  }},
  chown: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'chown');
    return this.run(p, 'chown', () => fsp.chown(p.host, a[1], a[2]));
  }},
  lchown: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'lchown', false);
    return this.run(p, 'lchown', () => fsp.lchown(p.host, a[1], a[2]));
  }},
  utimes: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'utime');
    return this.run(p, 'utime', () => fsp.utimes(p.host, a[1], a[2]));
  }},
  lutimes: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'lutime', false);
    return this.run(p, 'lutime', () => fsp.lutimes(p.host, a[1], a[2]));
  }},
  truncate: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'open');
    return this.run(p, 'open', () => fsp.truncate(p.host, a[1]));
  }},

  open: {lock: (a) => (openFlags(a[1]).creates ? EXCL : SHARED), async run(a) {
    const fl = openFlags(a[1]);
    const p = await this.place(a[0], fl.writes ? 'w' : 'r', 'open');
    if (p.host == null) throw nodeError('EISDIR', 'open', p.virtual);
    if (this.fds.size >= MAX_FDS) throw nodeError('EMFILE', 'open', p.virtual);
    let fh;
    try { fh = await fsp.open(p.host, a[1] == null ? 'r' : a[1], a[2]); } catch (e) { throw rewrite(e, 'open', p, null, this.ns); }
    await this.verifyOpened(fh, p, 'open');
    const fd = this.nextFd++;
    this.fds.set(fd, {fh, virtual: p.virtual, placed: p, chain: Promise.resolve()});
    return fd;
  }},
  close: {lock: NONE, async run(a) {
    const e = this.fdEntry(a[0], 'close');
    this.fds.delete(a[0]);
    await e.chain;
    await e.fh.close().catch(() => {});
  }},
  read: {lock: NONE, async run(a) {
    const e = this.fdEntry(a[0], 'read');
    const length = Number(a[1]);
    if (!(length >= 0) || length > MAX_IO) throw nodeError('EINVAL', 'read', e.virtual);
    return serial(e, async() => {
      const buf = Buffer.alloc(length);
      const r = await e.fh.read(buf, 0, length, a[2] == null ? null : a[2]).catch((err) => { throw rewrite(err, 'read', e.placed, null, this.ns); });
      return buf.subarray(0, r.bytesRead);
    });
  }},
  write: {lock: NONE, async run(a) {
    const e = this.fdEntry(a[0], 'write');
    const buf = Buffer.from(a[1]);
    if (buf.length > MAX_IO) throw nodeError('EINVAL', 'write', e.virtual);
    return serial(e, async() => {
      const r = await e.fh.write(buf, 0, buf.length, a[2] == null ? null : a[2]).catch((err) => { throw rewrite(err, 'write', e.placed, null, this.ns); });
      return r.bytesWritten;
    });
  }},
  fstat: {lock: NONE, async run(a) {
    const e = this.fdEntry(a[0], 'fstat');
    const big = !!(a[1] && a[1].bigint);
    return serial(e, () => e.fh.stat({bigint: big}).then((s) => statsOut(s, big)));
  }},
  ftruncate: {lock: NONE, async run(a) { const e = this.fdEntry(a[0], 'ftruncate'); return serial(e, () => e.fh.truncate(a[1])); }},
  fsync: {lock: NONE, async run(a) { const e = this.fdEntry(a[0], 'fsync'); return serial(e, () => e.fh.sync()); }},
  fdatasync: {lock: NONE, async run(a) { const e = this.fdEntry(a[0], 'fdatasync'); return serial(e, () => e.fh.datasync()); }},
  fchmod: {lock: NONE, async run(a) { const e = this.fdEntry(a[0], 'fchmod'); return serial(e, () => e.fh.chmod(Number(a[1]) & 0o777)); }},
  fchown: {lock: NONE, async run(a) { const e = this.fdEntry(a[0], 'fchown'); return serial(e, () => e.fh.chown(a[1], a[2])); }},
  futimes: {lock: NONE, async run(a) { const e = this.fdEntry(a[0], 'futime'); return serial(e, () => e.fh.utimes(a[1], a[2])); }}
};

// Operations on one descriptor run in order.
function serial(entry, fn) {
  const next = entry.chain.then(fn, fn);
  entry.chain = next.catch(() => {});
  return next;
}

module.exports = {FsBroker, OPS, MAX_IO, MAX_FDS};
```

Known residual, ledgered for plan 4 (review M3): `copyFile` and `rename` write to a destination without verify-after-open; a pre-existing dangling absolute link at the destination would be followed. Module code cannot create one (link rules), and plan 4's spawn check refuses `/data`/`/tmp` holding one under `enforce`; plan 4 tests it.

- [ ] **Step 5: Run the tests**

Run: `npx mocha test/fs-broker/03-broker.js`
Expected: 24 passing. When a test fails, debug the broker (superpowers:systematic-debugging), do not loosen the test; a test that turns out to contradict the spec is a ruling for the ledger and the reviewer.

- [ ] **Step 6: Commit**

```bash
git add lib/fs-broker/broker.js lib/fs-broker/errors.js lib/fs-broker/rwlock.js test/fs-broker/03-broker.js
git commit -m "feat(fs-broker): the broker's operations, checks and descriptor table" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The scheduler and the threadpool

**Files:**
- Create: `lib/fs-broker/scheduler.js`, `test/fs-broker/04-scheduler.js`
- Modify: `framework.js` (first statement)

**Interfaces:**
- Produces: `new FsScheduler({globalCap, perWorkerWhenContended = 2, queueCap = 4096})` with `submit(workerKey, task: () => Promise) → Promise` (rejects with `nodeError('EMFILE', 'queue')` when that worker's queue is full) and `forget(workerKey)` (rejects that worker's queued tasks with `EIO`); `FsScheduler.capFor(threadpoolSize) → max(1, floor(size × 3/4))`.

- [ ] **Step 1: Write the failing test** — `test/fs-broker/04-scheduler.js`:

```js
const assert = require('assert');
const {FsScheduler} = require('../../lib/fs-broker/scheduler');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('fs-broker 04: scheduler', () => {
  it('computes the global cap from the threadpool size, at least 1', () => {
    assert.strictEqual(FsScheduler.capFor(16), 12);
    assert.strictEqual(FsScheduler.capFor(4), 3);
    assert.strictEqual(FsScheduler.capFor(1), 1);
    assert.strictEqual(FsScheduler.capFor(0), 1);
  });

  it('never runs more than the global cap at once', async () => {
    const s = new FsScheduler({globalCap: 3});
    let running = 0, peak = 0;
    const task = async () => { running++; peak = Math.max(peak, running); await sleep(10); running--; };
    await Promise.all(Array.from({length: 20}, (_, i) => s.submit(`w${i % 4}`, task)));
    assert.strictEqual(peak, 3);
  });

  it('a single read from a quiet worker does not wait behind a flood', async () => {
    const s = new FsScheduler({globalCap: 3});
    const flood = Array.from({length: 200}, () => s.submit('busy', () => sleep(5)));
    await sleep(1);
    const t0 = Date.now();
    await s.submit('quiet', () => sleep(1));
    assert.ok(Date.now() - t0 < 40, `took ${Date.now() - t0} ms`);
    await Promise.all(flood);
  });

  it('a worker past its queue cap gets EMFILE', async () => {
    const s = new FsScheduler({globalCap: 1, queueCap: 2});
    const block = s.submit('w', () => sleep(20));
    const a = s.submit('w', () => sleep(1));
    const b = s.submit('w', () => sleep(1));
    await assert.rejects(s.submit('w', () => sleep(1)), (e) => e.code === 'EMFILE');
    await Promise.all([block, a, b]);
  });

  it('forget rejects a gone worker\'s queued tasks with EIO', async () => {
    const s = new FsScheduler({globalCap: 1});
    const block = s.submit('w', () => sleep(20));
    const queued = s.submit('w', () => sleep(1));
    s.forget('w');
    await assert.rejects(queued, (e) => e.code === 'EIO');
    await block;
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx mocha test/fs-broker/04-scheduler.js`
Expected: FAIL, `Cannot find module`.

- [ ] **Step 3: Implement** — `lib/fs-broker/scheduler.js`:

```js
// Shares the libuv threadpool between module workers (docs/superpowers/
// specs/2026-10-17-module-sandbox-fs-broker-design.md, section 3): a global
// cap on brokered operations in flight, round-robin across workers, at most
// perWorkerWhenContended for one worker while another waits, and a bounded
// queue per worker (EMFILE past it, which graceful-fs and its kind retry).
const {nodeError} = require('./errors');

class FsScheduler {
  static capFor(size) {
    return Math.max(1, Math.floor((Number(size) || 0) * 3 / 4));
  }

  constructor(opts) {
    this.globalCap = opts.globalCap;
    this.perWorker = opts.perWorkerWhenContended || 2;
    this.queueCap = opts.queueCap || 4096;
    this.queues = new Map();     // key -> [{task, resolve, reject}]
    this.active = new Map();     // key -> count
    this.running = 0;
    this.order = [];             // round-robin rotation of keys
  }

  submit(key, task) {
    let q = this.queues.get(key);
    if (q == null) { q = []; this.queues.set(key, q); this.order.push(key); }
    if (q.length >= this.queueCap) return Promise.reject(nodeError('EMFILE', 'queue'));
    return new Promise((resolve, reject) => {
      q.push({task, resolve, reject});
      this.pump();
    });
  }

  forget(key) {
    const q = this.queues.get(key) || [];
    this.queues.delete(key);
    this.order = this.order.filter((k) => k !== key);
    q.forEach((item) => item.reject(nodeError('EIO', 'queue')));
  }

  waitingOthers(key) {
    for (const [k, q] of this.queues) if (k !== key && q.length > 0) return true;
    return false;
  }

  pump() {
    let progressed = true;
    while (this.running < this.globalCap && progressed) {
      progressed = false;
      for (let i = 0; i < this.order.length && this.running < this.globalCap; i++) {
        const key = this.order[0];
        this.order.push(this.order.shift());
        const q = this.queues.get(key);
        if (q == null || q.length === 0) continue;
        const act = this.active.get(key) || 0;
        if (act >= this.perWorker && this.waitingOthers(key)) continue;
        const item = q.shift();
        this.active.set(key, act + 1);
        this.running++;
        progressed = true;
        Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => {
          this.running--;
          this.active.set(key, (this.active.get(key) || 1) - 1);
          this.pump();
        });
      }
    }
  }
}

module.exports = {FsScheduler};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx mocha test/fs-broker/04-scheduler.js`
Expected: 5 passing.

- [ ] **Step 5: The threadpool size.** First statement of `framework.js` (before the `minimist` line):

```js
// Brokered file operations from module workers share libuv's threadpool with
// countinghouse's own DNS lookups, crypto and zlib. 16 threads unless the
// operator chose otherwise; it must be set before the pool is first used.
if (process.env.UV_THREADPOOL_SIZE == null) process.env.UV_THREADPOOL_SIZE = '16';
```

and, after the `module sandbox:` log lines:

```js
logger.I('file broker: up to ' + require('./lib/fs-broker/scheduler').FsScheduler.capFor(process.env.UV_THREADPOOL_SIZE) +
  ' module file operations in flight (UV_THREADPOOL_SIZE ' + process.env.UV_THREADPOOL_SIZE + ')');
```

Place the `file broker:` line directly after the `module sandbox:` lines and before the `--modulePolicy` check, so a missing policy file (exit 2) still prints it. Add to `test/fs-broker/04-scheduler.js`:

```js
const {execFileSync} = require('child_process');
const path = require('path');

// Checks the startup log line (what framework.js set and the cap it derived),
// not the pool libuv actually created: libuv reads the variable itself.
describe('fs-broker 04: threadpool size at startup', function() {
  this.timeout(30000);
  // A missing --modulePolicy file makes startup exit 2 right after the log
  // lines, so no port is bound.
  function startup(extraEnv) {
    const env = Object.assign({}, process.env);
    delete env.UV_THREADPOOL_SIZE;
    Object.assign(env, extraEnv);
    try {
      execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'framework.js'), '--no-workerThread', '--debug',
        '--bindAddr', '127.0.0.1', '--port', '9625', '--modulePolicy', '/nonexistent/policy.json'],
      {env: env, stdio: 'pipe', timeout: 15000});
      return '';
    } catch (e) {
      return String(e.stdout) + String(e.stderr);
    }
  }

  it('defaults UV_THREADPOOL_SIZE to 16 and logs the cap', () => {
    assert.match(startup({}), /up to 12 module file operations in flight \(UV_THREADPOOL_SIZE 16\)/);
  });

  it('keeps an operator-set UV_THREADPOOL_SIZE', () => {
    assert.match(startup({UV_THREADPOOL_SIZE: '4'}), /up to 3 module file operations in flight \(UV_THREADPOOL_SIZE 4\)/);
  });
});
```

- [ ] **Step 6: Run the tests**

Run: `npx mocha --exit test/fs-broker/04-scheduler.js`
Expected: all passing.

- [ ] **Step 7: Commit**

```bash
git add lib/fs-broker/scheduler.js test/fs-broker/04-scheduler.js framework.js
git commit -m "feat(fs-broker): scheduler sharing the threadpool between workers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Hand-off

- [ ] **Step 1:** Run `npx mocha --exit test/fs-broker/*.js` and `npm run lint`. Expected: all passing, lint clean.
- [ ] **Step 2:** Send the reviewer the plan's commit range and the result. No full suite: nothing in this plan is wired into the server except the startup threadpool line and the new option, both covered by their tests and by the full suite at the end of plan 2b.
- [ ] **Step 3:** Write plan 2b, carrying these notes from the plan 2a review:
  - submit to the scheduler only the host I/O, after the module's lock is held, so a module's lock queue cannot park global slots;
  - `cp` of a tree containing absolute symlinks fails with `EPERM` under the link rules — document it;
  - `fsync` of a directory (write-file-atomic opens the parent with `r`) works on real roots only; a synthesised ancestor answers `EISDIR`.
