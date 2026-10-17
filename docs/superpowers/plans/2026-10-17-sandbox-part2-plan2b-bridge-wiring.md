# Module sandbox part 2, plan 2b of 5 — the bridge, the worker patch and the wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, chosen by the user) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. After each task's commit, send the reviewer session (`countinghouse-0a`) the range from `git log --oneline` output and wait for its approval before the next task. Tell the reviewer before running tests that use ports.

**Goal:** Connect plan 2a's broker to module workers: a two-channel bridge, `fs` patched first thing in every worker, one broker per worker created at spawn, so that from this plan on every file operation a module worker makes goes through the main thread — in every `--moduleSandbox` mode.

**Architecture:** `lib/fs-broker/client.js` (worker) and `lib/fs-broker/server.js` (main) implement the bridge: a sync port with a shared counter for blocking calls, an async port for the rest, the 30 s broker deadline and the 35 s worker backstop, and a cap on operations stuck past their deadline. `lib/fs-broker/patch.js` replaces the methods of `fs`, `fs/promises` and `FileHandle` in the worker, failing closed. `lib/fs-broker/index.js` builds a worker's broker at spawn (data directories, prepared namespace, protected paths, the shared scheduler). `lib/sandbox.js` installs the patch as its first statement from `workerData`; `lib/module-manager.js` creates the broker before the worker and closes it when the worker exits.

**Tech Stack:** Node.js >= 22.16 (`worker_threads`: `MessageChannel`, `receiveMessageOnPort`, `SharedArrayBuffer`, `Atomics`), mocha.

**Spec:** `docs/superpowers/specs/2026-10-17-module-sandbox-fs-broker-design.md` — section 2 (worker side), section 3 (main-thread protection, worker end), section 4 (modes). Builds on plan 2a (`lib/module-data.js`, `lib/fs-broker/{namespace,broker,errors,rwlock,scheduler}.js`). Plan series: 1 (done) · 2a (done) · **2b (this)** · 3 virtual identity and the loader · 4 quota and data lifecycle · 5 single-thread mode, docs, benchmarks.

## Global Constraints

- Everything in plan 2a's Global Constraints still holds, in particular the plan 3 gate (`ENFORCE_FILE_DECISIONS = false`: `enforce` makes `audit`'s file decisions) and the interim relative-path rule (the broker's `cwd` is the main process's real `process.cwd()`).
- **Every mode under `--workerThread` runs the broker** (`off`, `audit`, `enforce`); single-thread mode does not (plan 5 gives it a facade).
- Bridge: two ports per worker; the sync side waits on a shared `Int32Array` counter that the main thread bumps (`Atomics.add`) after posting each sync reply, and the worker reads the counter **before** draining the port, then waits on the value it read. Replies whose `id` does not match are discarded. Every outcome, refusals included, comes back on the bridge.
- Deadlines: broker 30 s → `ETIMEDOUT`; worker backstop 35 s → `EIO`. An operation past its deadline keeps its scheduler slot until the host operation really returns; a worker with 2 such stuck operations gets `EIO` for every new request until one returns (review F1).
- Special files: opening anything that is not a regular file or a directory (FIFO, socket, character or block device) is `EPERM` under live `enforce`; otherwise it is reported (`special`) and opened with `O_NONBLOCK` added, so it cannot block a pool thread at `open` (review F1).
- The module's lock is taken before a scheduler slot is requested; lock waiters never hold slots (review M6).
- Interim until plan 3 (removed there): `outside` is not reported for paths under the module's own install directory or countinghouse's install directory — that is the loader reading code by host path, which plan 3 makes virtual.
- `fs` file descriptors 1 and 2 go to the worker's console path (`process.stdout`/`stderr`), silenced in release mode like `console`.
- The `file broker: up to N …` startup line is logged only when worker mode runs the broker.
- Do not run the full `npm test` except in the last task. Kill stray servers by PID. Test trees under `test/.tmp` (`test/helpers/test-tmp.js`). Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A module opening a FIFO with no writer, twelve times — must not wedge the threadpool for other modules or countinghouse (Task 1 test: non-blocking open; Task 2 test: stuck cap with simulated stuck operations).
2. A worker killed (restart, crash, unload) while it waits in `Atomics.wait` — it must end promptly, and its broker must close its descriptors and release its scheduler queue (Task 2 test, Task 5 test).
3. A module that reads a file bigger than 16 MB with `readFileSync` — must get the whole file (chunked), not an error (Task 3 test).
4. A module using `pino` or another logger that writes `fs.writeSync(1, …)` — must work, and be silent in release mode (Task 3 test for fd 1/2; Task 5 release-mode check).
5. A worker whose sync call is in flight during a long host operation must not be killed by the `maxBlockMs` heartbeat (Task 5 test on `lib/worker-limits.js`).

---

### Task 1: Broker additions — scheduling, `readFile`, special files, quiet loader paths

**Files:**
- Modify: `lib/fs-broker/broker.js`
- Create: `test/fs-broker/05-broker-2b.js`

**Interfaces:**
- Consumes: plan 2a's `FsBroker`, `OPS`, `openFlags` (module-internal).
- Produces: `FsBroker` options `schedule(fn: () => Promise) → Promise` (default runs `fn` directly) and `quiet: [hostPath]`; new op `readFile(path, flag) → Buffer` (whole file; `EFBIG` past 16 MB so the worker falls back to chunked reads).

- [ ] **Step 1: Write the failing tests** — `test/fs-broker/05-broker-2b.js`:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const {mkdtemp} = require('../helpers/test-tmp');

async function setup(mode, extra) {
  const base = mkdtemp('broker2b-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp'), outside: path.join(base, 'outside')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  const reports = [];
  const ns = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
  await ns.prepare();
  const broker = new FsBroker(Object.assign({name: 'm', mode: mode, namespace: ns, cwd: '/',
    report: (r, t) => reports.push(`${r} ${t}`), enforceFileDecisions: true}, extra || {}));
  return {base, dirs, broker, reports, done: () => broker.closeAll().then(() => fs.rmSync(base, {recursive: true, force: true}))};
}

describe('fs-broker 05: broker additions for the bridge', function() {
  this.timeout(10000);

  it('runs each operation through schedule(), after taking the lock', async () => {
    const events = [];
    const t = await setup('enforce', {schedule: (fn) => { events.push('slot'); return fn(); }});
    try {
      await t.broker.handle('stat', ['/data']);
      await t.broker.handle('mkdir', ['/data/d', {}]);
      assert.deepStrictEqual(events, ['slot', 'slot']);
    } finally { await t.done(); }
  });

  it('readFile returns a whole file in one call, and EFBIG past 16 MB', async () => {
    const t = await setup('enforce');
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'small'), 'hello');
      assert.strictEqual(Buffer.from(await t.broker.handle('readFile', ['/data/small', 'r'])).toString(), 'hello');
      fs.writeFileSync(path.join(t.dirs.data, 'big'), Buffer.alloc(16 * 1024 * 1024 + 10));
      await assert.rejects(t.broker.handle('readFile', ['/data/big', 'r']), (e) => e.code === 'EFBIG' && e.path === '/data/big');
      assert.strictEqual(t.broker.fds.size, 0, 'readFile leaves no descriptor open');
    } finally { await t.done(); }
  });

  it('readFile reads files whose stat size is 0 but which have content (procfs)', async () => {
    const t = await setup('audit');
    try {
      const r = Buffer.from(await t.broker.handle('readFile', ['/proc/self/status', 'r'])).toString();
      assert.ok(r.includes('Name:'), r.slice(0, 100));
    } finally { await t.done(); }
  });

  it('enforce: a FIFO is EPERM; audit: it is reported and opened without blocking', async () => {
    const e = await setup('enforce');
    try {
      execFileSync('mkfifo', [path.join(e.dirs.data, 'pipe')]);
      await assert.rejects(e.broker.handle('open', ['/data/pipe', 'r']), (err) => err.code === 'EPERM' && err.path === '/data/pipe');
    } finally { await e.done(); }
    const a = await setup('audit');
    try {
      execFileSync('mkfifo', [path.join(a.dirs.data, 'pipe')]);
      const t0 = Date.now();
      const fd = await a.broker.handle('open', ['/data/pipe', 'r']);
      assert.ok(Date.now() - t0 < 2000, 'open of a FIFO with no writer did not block');
      await a.broker.handle('close', [fd]);
      assert.ok(a.reports.includes('special /data/pipe'), a.reports.join('\n'));
    } finally { await a.done(); }
  });

  it('does not report outside for quiet paths (loader traffic until plan 3), but still reports others', async () => {
    const t = await setup('audit');
    try {
      fs.writeFileSync(path.join(t.dirs.outside, 'lib.js'), '1');
      const quiet = new FsBroker({name: 'm', mode: 'audit', namespace: t.broker.ns, cwd: '/',
        report: (r, x) => t.reports.push(`${r} ${x}`), quiet: [t.dirs.outside]});
      await quiet.handle('stat', [path.join(t.dirs.outside, 'lib.js')]);
      assert.deepStrictEqual(t.reports, []);
      await quiet.handle('stat', [t.base]);
      assert.deepStrictEqual(t.reports, [`outside ${t.base}`]);
    } finally { await t.done(); }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx mocha test/fs-broker/05-broker-2b.js`
Expected: FAIL — `schedule` is never called, `readFile` is `EINVAL`, the FIFO is not refused (the enforce `open` blocks until mocha's timeout: run with `--timeout 5000` and expect that test to fail by timeout), quiet paths are reported.

- [ ] **Step 3: Implement** in `lib/fs-broker/broker.js`:
  - Constructor: `this.schedule = opts.schedule || ((fn) => fn());` and `this.quiet = (opts.quiet || []).map(String);`.
  - `handle`: replace the two `spec.run.call(this, a)` calls with `this.schedule(() => spec.run.call(this, a))` (the `none` branch and inside the locked `try`), so a scheduler slot is requested only after the lock is held.
  - `place`, in the `outside` branch: report only when the path is not under a quiet root:
    ```js
    if (!this.quiet.some((q) => inside(v, q))) this.report('outside', v);
    ```
  - Special files, in `OPS.open.run` right after `place` and the `EISDIR` check:
    ```js
    let flags = a[1] == null ? 'r' : a[1];
    const st = await fsp.stat(p.host).catch(() => null);
    if (st != null && !st.isFile() && !st.isDirectory()) {
      this.report('special', p.virtual);
      if (this.enforce) throw nodeError('EPERM', 'open', p.virtual);
      flags = nonBlocking(flags);
    }
    ```
    and pass `flags` to `fsp.open`. Add the helper near `openFlags`:
    ```js
    // FIFOs, sockets and devices could block a threadpool thread at open or
    // read; open them non-blocking (review F1).
    const STRING_FLAGS = {r: 'O_RDONLY', 'r+': 'O_RDWR', 'rs+': 'O_RDWR', w: 'O_WRONLY|O_CREAT|O_TRUNC', 'w+': 'O_RDWR|O_CREAT|O_TRUNC',
      a: 'O_WRONLY|O_CREAT|O_APPEND', 'a+': 'O_RDWR|O_CREAT|O_APPEND'};
    function nonBlocking(flags) {
      const c = fs.constants;
      let n = flags;
      if (typeof(flags) === 'string') {
        if (STRING_FLAGS[flags] == null) return flags;
        n = STRING_FLAGS[flags].split('|').reduce((acc, k) => acc | c[k], 0);
      }
      return n | c.O_NONBLOCK;
    }
    ```
  - New op, after `open`:
    ```js
    readFile: {lock: (a) => (openFlags(a[1]).creates ? EXCL : SHARED), async run(a) {
      const fd = await OPS.open.run.call(this, [a[0], a[1] == null ? 'r' : a[1]]);
      const e = this.fds.get(fd);
      try {
        const parts = [];
        let size = 0;
        for (;;) {
          const buf = Buffer.alloc(64 * 1024);
          const r = await e.fh.read(buf, 0, buf.length, null).catch((err) => { throw rewrite(err, 'read', e.placed, null, this.ns); });
          if (r.bytesRead === 0) break;
          size += r.bytesRead;
          if (size > MAX_IO) throw nodeError('EFBIG', 'read', e.virtual);
          parts.push(buf.subarray(0, r.bytesRead));
        }
        return Buffer.concat(parts);
      } finally {
        this.fds.delete(fd);
        await e.fh.close().catch(() => {});
      }
    }},
    ```
    and add `EFBIG: 'file too large'` to `TEXT` in `lib/fs-broker/errors.js`.

- [ ] **Step 4: Run the tests**

Run: `npx mocha test/fs-broker/05-broker-2b.js test/fs-broker/03-broker.js`
Expected: all passing (5 new, 25 from plan 2a).

- [ ] **Step 5: Commit**

```bash
git add lib/fs-broker/broker.js lib/fs-broker/errors.js test/fs-broker/05-broker-2b.js
git commit -m "feat(fs-broker): scheduling hook, readFile, non-blocking special files, quiet loader paths" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The bridge

**Files:**
- Create: `lib/fs-broker/client.js`, `lib/fs-broker/server.js`, `test/fs-broker/06-bridge.js`

**Interfaces:**
- Consumes: `FsBroker` (Task 1), `FsScheduler` (plan 2a), `nodeError`.
- Produces:
  - `createBridge({broker, scheduler, key, deadlineMs = 30000, maxStuck = 2})` → `{transfer: {syncPort, asyncPort, flag}, transferList: [syncPort, asyncPort], syncInFlight() → number, stuck() → number, close() → Promise}`. The broker given here must have been built with `schedule: (fn) => scheduler.submit(key, fn)`.
  - `createClient(transfer, {backstopMs = 35000})` (worker) → `{sync(op, args) → result, async(op, args) → Promise<result>}`; errors are rebuilt as `Error` with `code`, `errno`, `syscall`, `path`, `dest`.

- [ ] **Step 1: Write the failing tests** — `test/fs-broker/06-bridge.js`. A real worker runs the client (`new Worker(code, {eval: true})`):

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {Worker} = require('worker_threads');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const {FsScheduler} = require('../../lib/fs-broker/scheduler');
const {createBridge} = require('../../lib/fs-broker/server');
const {mkdtemp} = require('../helpers/test-tmp');

const CLIENT = path.join(__dirname, '..', '..', 'lib', 'fs-broker', 'client.js');

async function harness(opts) {
  opts = opts || {};
  const base = mkdtemp('bridge-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  const ns = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
  await ns.prepare();
  const scheduler = opts.scheduler || new FsScheduler({globalCap: 3});
  const key = opts.key || 'w1';
  const broker = new FsBroker({name: 'm', mode: 'audit', namespace: ns, cwd: '/', report: () => {},
    schedule: (fn) => scheduler.submit(key, fn), hooks: opts.hooks});
  const bridge = createBridge({broker, scheduler, key, deadlineMs: opts.deadlineMs, maxStuck: opts.maxStuck});
  return {base, dirs, broker, scheduler, bridge,
    run(body) {
      const code = `const {workerData, parentPort} = require('worker_threads');
        const client = require(${JSON.stringify(CLIENT)}).createClient(workerData.t, {backstopMs: workerData.backstop || 35000});
        (async () => { ${body} })().then((r) => parentPort.postMessage({ok: true, r}), (e) => parentPort.postMessage({ok: false, e: {code: e.code, message: e.message, path: e.path}}));`;
      const w = new Worker(code, {eval: true, workerData: {t: bridge.transfer, backstop: opts.backstop}, transferList: bridge.transferList});
      this.worker = w;
      return new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); });
    },
    async done() { if (this.worker) await this.worker.terminate(); await bridge.close(); fs.rmSync(base, {recursive: true, force: true}); }
  };
}

describe('fs-broker 06: the bridge', function() {
  this.timeout(20000);

  it('answers sync and async calls, and rebuilds errors', async () => {
    const h = await harness();
    try {
      fs.writeFileSync(path.join(h.dirs.data, 'a'), 'hello');
      const m = await h.run(`
        const s = client.sync('readFile', ['/data/a', 'r']);
        const a = await client.async('readFile', ['/data/a', 'r']);
        let err = null;
        try { client.sync('stat', ['/data/missing']); } catch (e) { err = {code: e.code, path: e.path, isError: e instanceof Error}; }
        return {s: Buffer.from(s).toString(), a: Buffer.from(a).toString(), err};`);
      assert.deepStrictEqual(m, {ok: true, r: {s: 'hello', a: 'hello', err: {code: 'ENOENT', path: '/data/missing', isError: true}}});
    } finally { await h.done(); }
  });

  it('returns a 16 MB result in one sync call', async () => {
    const h = await harness();
    try {
      fs.writeFileSync(path.join(h.dirs.data, 'big'), Buffer.alloc(16 * 1024 * 1024, 7));
      const m = await h.run(`return Buffer.from(client.sync('readFile', ['/data/big', 'r'])).length;`);
      assert.deepStrictEqual(m, {ok: true, r: 16 * 1024 * 1024});
    } finally { await h.done(); }
  });

  it('a call past the broker deadline gets ETIMEDOUT, and the next call still works (stale reply discarded)', async () => {
    let release;
    const h = await harness({deadlineMs: 200, hooks: {afterCheck: (syscall, host) => (host.endsWith('/slow') ? new Promise((r) => { release = r; }) : null)}});
    try {
      const m = await h.run(`
        let code = null;
        try { client.sync('stat', ['/data/slow']); } catch (e) { code = e.code; }
        return code;`);
      assert.deepStrictEqual(m, {ok: true, r: 'ETIMEDOUT'});
      release();
      await new Promise((r) => setTimeout(r, 50));
      const n = await h.run(`return Buffer.from(client.sync('readFile', ['/data/ok', 'r'])).toString();`);
      assert.ok(n.ok === false && n.e.code === 'ENOENT', JSON.stringify(n));
    } finally { await h.done(); }
  });

  it('two stuck operations put the worker on EIO, and do not stop another worker', async () => {
    const scheduler = new FsScheduler({globalCap: 3});
    const h = await harness({scheduler, key: 'stuck', deadlineMs: 100, maxStuck: 2,
      hooks: {afterCheck: (syscall, host) => (host.endsWith('/hang') ? new Promise(() => {}) : null)}});
    const other = await harness({scheduler, key: 'other'});
    try {
      const m = await h.run(`
        const codes = [];
        for (let i = 0; i < 3; i++) { try { await client.async('stat', ['/data/hang']); } catch (e) { codes.push(e.code); } }
        return codes;`);
      assert.deepStrictEqual(m, {ok: true, r: ['ETIMEDOUT', 'ETIMEDOUT', 'EIO']});
      assert.strictEqual(h.bridge.stuck(), 2);
      fs.writeFileSync(path.join(other.dirs.data, 'x'), 'y');
      const o = await other.run(`return Buffer.from(await client.async('readFile', ['/data/x', 'r'])).toString();`);
      assert.deepStrictEqual(o, {ok: true, r: 'y'});
    } finally { await other.done(); await h.done(); }
  });

  it('counts sync calls in flight for the heartbeat', async () => {
    let release;
    const h = await harness({hooks: {afterCheck: (syscall, host) => (host.endsWith('/wait') ? new Promise((r) => { release = r; }) : null)}});
    try {
      const pending = h.run(`try { client.sync('stat', ['/data/wait']); } catch (e) { return e.code; } return 'ok';`);
      await new Promise((r) => setTimeout(r, 200));
      assert.strictEqual(h.bridge.syncInFlight(), 1);
      release();
      await pending;
      assert.strictEqual(h.bridge.syncInFlight(), 0);
    } finally { await h.done(); }
  });

  it('a worker terminated while waiting ends promptly, and close() releases its descriptors', async () => {
    const h = await harness({hooks: {afterCheck: (syscall, host) => (host.endsWith('/forever') ? new Promise(() => {}) : null)}});
    try {
      fs.writeFileSync(path.join(h.dirs.data, 'f'), 'x');
      h.run(`client.sync('open', ['/data/f', 'r']); client.sync('stat', ['/data/forever']);`);
      await new Promise((r) => setTimeout(r, 300));
      const t0 = Date.now();
      await h.worker.terminate();
      assert.ok(Date.now() - t0 < 2000, `terminate took ${Date.now() - t0} ms`);
      h.worker = null;
      await h.bridge.close();
      assert.strictEqual(h.broker.fds.size, 0);
    } finally { await h.done(); }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx mocha --exit test/fs-broker/06-bridge.js`
Expected: FAIL, `Cannot find module '../../lib/fs-broker/server'`.

- [ ] **Step 3: Implement the client** — `lib/fs-broker/client.js`:

```js
// Module worker's end of the file bridge (docs/superpowers/specs/2026-10-17-
// module-sandbox-fs-broker-design.md, section 2). Sync calls post on the sync
// port and wait on a shared counter; async calls use the async port. Loaded
// by lib/sandbox.js before anything else, so it holds the only references to
// receiveMessageOnPort and the ports.
const {receiveMessageOnPort} = require('worker_threads');

function toError(e) {
  const err = new Error(e.message);
  ['code', 'errno', 'syscall', 'path', 'dest'].forEach((k) => { if (e[k] !== undefined) err[k] = e[k]; });
  return err;
}

function eio(op) {
  const err = new Error(`EIO: i/o error, ${op} (the file broker did not answer)`);
  err.code = 'EIO';
  err.errno = -5;
  err.syscall = op;
  return err;
}

function createClient(t, settings) {
  const backstopMs = (settings && settings.backstopMs) || 35000;
  const counter = new Int32Array(t.flag);
  const pending = new Map();
  let seq = 0;

  t.asyncPort.on('message', (m) => {
    const w = pending.get(m.id);
    if (w == null) return;
    pending.delete(m.id);
    if (pending.size === 0) t.asyncPort.unref();
    if (m.ok) w.resolve(m.result); else w.reject(toError(m.error));
  });
  t.asyncPort.unref();

  function sync(op, args) {
    const id = ++seq;
    t.syncPort.postMessage({id, op, args});
    const deadline = Date.now() + backstopMs;
    for (;;) {
      // Read the counter before draining: a reply that lands after the drain
      // bumps it, so the wait below returns at once instead of sleeping.
      const seen = Atomics.load(counter, 0);
      let msg;
      while ((msg = receiveMessageOnPort(t.syncPort)) !== undefined) {
        const m = msg.message;
        if (m.id !== id) continue;   // a reply to a call that already timed out
        if (m.ok) return m.result;
        throw toError(m.error);
      }
      const left = deadline - Date.now();
      if (left <= 0) throw eio(op);
      Atomics.wait(counter, 0, seen, left);
    }
  }

  function async(op, args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, {resolve, reject});
      t.asyncPort.ref();
      t.asyncPort.postMessage({id, op, args});
    });
  }

  return {sync, async};
}

module.exports = {createClient};
```

- [ ] **Step 4: Implement the server** — `lib/fs-broker/server.js`:

```js
// Main thread's end of one worker's file bridge (docs/superpowers/specs/
// 2026-10-17-module-sandbox-fs-broker-design.md, sections 2 and 3). Every
// request becomes broker.handle(); every outcome goes back on the port it
// came from, and a sync reply also bumps the shared counter the worker waits
// on. A request past its deadline is answered ETIMEDOUT but keeps its
// scheduler slot until the host operation returns; maxStuck such requests
// put the worker on EIO until one returns (review F1).
const {MessageChannel} = require('worker_threads');
const {nodeError} = require('./errors');

function errorOut(e) {
  const o = {message: String(e && e.message)};
  ['code', 'errno', 'syscall', 'path', 'dest'].forEach((k) => { if (e != null && e[k] !== undefined) o[k] = e[k]; });
  return o;
}

function createBridge(opts) {
  const broker = opts.broker;
  const scheduler = opts.scheduler;
  const key = opts.key;
  const deadlineMs = opts.deadlineMs || 30000;
  const maxStuck = opts.maxStuck || 2;
  const syncCh = new MessageChannel();
  const asyncCh = new MessageChannel();
  const flag = new SharedArrayBuffer(4);
  const counter = new Int32Array(flag);
  let stuck = 0;
  let inFlight = 0;
  let closed = false;

  function exec(op, args) {
    if (stuck >= maxStuck) return Promise.reject(nodeError('EIO', op));
    const work = broker.handle(op, args);
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        stuck++;
        work.then(() => {}, () => {}).then(() => { stuck--; });
        reject(nodeError('ETIMEDOUT', op));
      }, deadlineMs);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }

  function reply(port, id, ok, value, isSync) {
    if (closed) return;
    try {
      port.postMessage(ok ? {id, ok: true, result: value} : {id, ok: false, error: errorOut(value)});
    } catch (e) {
      port.postMessage({id, ok: false, error: errorOut(e)});
    }
    if (isSync) {
      Atomics.add(counter, 0, 1);
      Atomics.notify(counter, 0);
    }
  }

  syncCh.port1.on('message', (m) => {
    inFlight++;
    exec(m.op, m.args)
      .then((r) => reply(syncCh.port1, m.id, true, r, true), (e) => reply(syncCh.port1, m.id, false, e, true))
      .finally(() => { inFlight--; });
  });
  asyncCh.port1.on('message', (m) => {
    exec(m.op, m.args).then((r) => reply(asyncCh.port1, m.id, true, r, false), (e) => reply(asyncCh.port1, m.id, false, e, false));
  });

  return {
    transfer: {syncPort: syncCh.port2, asyncPort: asyncCh.port2, flag: flag},
    transferList: [syncCh.port2, asyncCh.port2],
    syncInFlight: () => inFlight,
    stuck: () => stuck,
    async close() {
      if (closed) return;
      closed = true;
      syncCh.port1.close();
      asyncCh.port1.close();
      scheduler.forget(key);
      await broker.closeAll();
    }
  };
}

module.exports = {createBridge};
```

- [ ] **Step 5: Run the tests**

Run: `npx mocha --exit test/fs-broker/06-bridge.js`
Expected: 6 passing. No stray worker threads (mocha exits).

- [ ] **Step 6: Commit**

```bash
git add lib/fs-broker/client.js lib/fs-broker/server.js test/fs-broker/06-bridge.js
git commit -m "feat(fs-broker): the bridge between module workers and their broker" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The worker patch

**Files:**
- Create: `lib/fs-broker/patch.js`, `test/helpers/brokered-worker.js`, `test/helpers/brokered-worker-entry.js`, `test/fs-broker/scripts/keys.js`, `test/fs-broker/scripts/behaviour.js`, `test/fs-broker/07-patch.js`

**Interfaces:**
- Consumes: `createClient` (Task 2), `createBridge`, `FsBroker` with `schedule` and `readFile` (Task 1).
- Produces: `require('./fs-broker/patch')` → `{install(client, {consoleWrite?}) → handled: {fs: Set, promises: Set, fileHandle: Set}, setConsoleSilenced(boolean), PASSTHROUGH: {fs: [...], promises: [...]}}`.
- Produces (tests): `runBrokered(scriptPath, {patch = true, mode = 'audit', files = {}}) → Promise<{ok, r} | {ok: false, e}>` in `test/helpers/brokered-worker.js`. With `patch`, the script runs in a worker whose `fs` is patched against a broker over a fresh tree and gets `root = '/data'`; without, the same script runs in a plain worker with `root` = the tree's real data directory. `files` are written into the data directory first. The script is `module.exports = async (fs, root, ctx) => result`, `ctx = {handled, patch, realFileHandleKeys, consoleLines}`.

- [ ] **Step 1: Write the harness.** `test/helpers/brokered-worker-entry.js`:

```js
// Worker entry for test/helpers/brokered-worker.js: optionally installs the
// fs patch first (as lib/sandbox.js does), then runs a test script.
const {workerData, parentPort} = require('worker_threads');
const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'lib', 'fs-broker');

(async () => {
  const ctx = {consoleLines: []};
  const fh = await require('fs/promises').open(__filename);
  ctx.realFileHandleKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(fh));
  await fh.close();
  if (workerData.fsBridge != null) {
    ctx.patch = require(path.join(LIB, 'patch'));
    ctx.handled = ctx.patch.install(require(path.join(LIB, 'client')).createClient(workerData.fsBridge),
      {consoleWrite: (fd, buf) => ctx.consoleLines.push(`${fd}:${Buffer.from(buf).toString()}`)});
  }
  return require(workerData.script)(require('fs'), workerData.root, ctx);
})().then((r) => parentPort.postMessage({ok: true, r: r}),
  (e) => parentPort.postMessage({ok: false, e: {code: e && e.code, message: String(e && e.message), stack: String(e && e.stack)}}));
```

`test/helpers/brokered-worker.js`:

```js
// Runs a test script in a worker whose fs is patched against a broker over a
// fresh tree (root '/data'), or in a plain worker over the same kind of tree
// (root = the real data directory), for the patch and differential tests.
const fs = require('fs');
const path = require('path');
const {Worker} = require('worker_threads');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const {FsScheduler} = require('../../lib/fs-broker/scheduler');
const {createBridge} = require('../../lib/fs-broker/server');
const {mkdtemp} = require('./test-tmp');

const ENTRY = path.join(__dirname, 'brokered-worker-entry.js');
const REPO = path.join(__dirname, '..', '..');

async function runBrokered(script, opts) {
  opts = opts || {};
  const usePatch = opts.patch !== false;
  const base = mkdtemp('pw-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  Object.entries(opts.files || {}).forEach(([name, content]) => fs.writeFileSync(path.join(dirs.data, name), content));
  let bridge = null;
  const data = {script: script, root: dirs.data, fsBridge: null};
  let transferList = [];
  if (usePatch) {
    const ns = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
    await ns.prepare();
    const scheduler = new FsScheduler({globalCap: 3});
    const broker = new FsBroker({name: 't', mode: opts.mode || 'audit', namespace: ns, cwd: process.cwd(), report: () => {},
      schedule: (fn) => scheduler.submit('t', fn), quiet: [REPO]});
    bridge = createBridge({broker, scheduler, key: 't'});
    data.fsBridge = bridge.transfer;
    data.root = '/data';
    transferList = bridge.transferList;
  }
  const worker = new Worker(ENTRY, {workerData: data, transferList: transferList});
  try {
    return await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  } finally {
    await worker.terminate();
    if (bridge) await bridge.close();
    fs.rmSync(base, {recursive: true, force: true});
  }
}

module.exports = {runBrokered};
```

- [ ] **Step 2: Write the failing tests.** `test/fs-broker/scripts/keys.js`:

```js
// Every fs, fs.promises and FileHandle method is either handled by the patch
// or a known data/class export; anything else fails the test (fail closed).
module.exports = async (fs, root, ctx) => {
  const fsp = require('fs/promises');
  const pass = ctx.patch.PASSTHROUGH;
  const before = fs.readFileSync;
  try { fs.readFileSync = null; } catch (e) { /* non-writable */ }
  return {
    fs: Object.keys(fs).filter((k) => !ctx.handled.fs.has(k) && !pass.fs.includes(k)),
    promises: Object.keys(fsp).filter((k) => !ctx.handled.promises.has(k) && !pass.promises.includes(k)),
    fileHandle: ctx.realFileHandleKeys.filter((k) => !ctx.handled.fileHandle.has(k)),
    locked: fs.readFileSync === before
  };
};
```

`test/fs-broker/scripts/behaviour.js`:

```js
// Exercises the patched fs the way modules and libraries use it.
const path = require('path');

module.exports = async (fs, root, ctx) => {
  const fsp = require('fs/promises');
  const j = (...p) => path.posix.join(root, ...p);
  const out = {};
  fs.writeFileSync(j('a.txt'), 'hello');
  out.readSync = fs.readFileSync(j('a.txt'), 'utf8');
  out.readCb = await new Promise((r, x) => fs.readFile(j('a.txt'), 'utf8', (e, d) => (e ? x(e) : r(d))));
  out.readPromise = await fsp.readFile(j('a.txt'), {encoding: 'utf8'});
  const st = fs.statSync(j('a.txt'));
  out.stats = {isStats: st instanceof fs.Stats, isFile: st.isFile(), size: st.size, mtimeIsDate: st.mtime instanceof Date};
  out.bigint = typeof(fs.statSync(j('a.txt'), {bigint: true}).size);
  const d = fs.readdirSync(root, {withFileTypes: true})[0];
  out.dirent = {isDirent: d instanceof fs.Dirent, name: d.name, isFile: d.isFile(), parentPath: d.parentPath};
  try { fs.readFileSync(j('missing')); } catch (e) { out.missing = {code: e.code, path: e.path, isError: e instanceof Error}; }
  out.fd1 = fs.writeSync(1, 'to stdout\n');
  out.console = ctx.consoleLines.slice();
  await new Promise((r, x) => { const w = fs.createWriteStream(j('s.txt')); w.on('error', x); w.end('streamed', r); });
  out.stream = await new Promise((r, x) => { let s = ''; fs.createReadStream(j('s.txt'), 'utf8').on('data', (c) => { s += c; }).on('end', () => r(s)).on('error', x); });
  const fh = await fsp.open(j('h.txt'), 'w');
  await fh.write('handle');
  await fh.close();
  out.handle = await fsp.readFile(j('h.txt'), 'utf8');
  fs.appendFileSync(j('a.txt'), ' world');
  out.append = fs.readFileSync(j('a.txt'), 'utf8');
  out.exists = [fs.existsSync(j('a.txt')), fs.existsSync(j('nope'))];
  fs.mkdirSync(j('d', 'e'), {recursive: true});
  fs.writeFileSync(j('d', 'e', 'f.txt'), 'deep');
  fs.cpSync(j('d'), j('d2'), {recursive: true});
  out.cp = fs.readFileSync(j('d2', 'e', 'f.txt'), 'utf8');
  out.glob = fs.globSync('**/*.txt', {cwd: root}).sort();
  const dir = fs.opendirSync(root);
  const names = [];
  for await (const e of dir) names.push(e.name);
  out.opendir = names.sort();
  const v = fs.openSync(j('v.bin'), 'w+');
  fs.writevSync(v, [Buffer.from('ab'), Buffer.from('cd')], 0);
  const b1 = Buffer.alloc(2);
  const b2 = Buffer.alloc(2);
  fs.readvSync(v, [b1, b2], 0);
  fs.closeSync(v);
  out.vector = b1.toString() + b2.toString();
  out.realpathNative = fs.realpathSync.native(j('a.txt'));
  out.blob = await (await fs.openAsBlob(j('a.txt'))).text();
  const tmp = fs.mkdtempDisposableSync(j('t-'));
  out.disposable = fs.existsSync(tmp.path);
  tmp.remove();
  try { fs.watch(root); } catch (e) { out.watch = e.code; }
  const big = Buffer.alloc(17 * 1024 * 1024, 1);
  fs.writeFileSync(j('big.bin'), big);
  out.bigRead = fs.readFileSync(j('big.bin')).length;
  return out;
};
```

`test/fs-broker/07-patch.js`:

```js
const assert = require('assert');
const path = require('path');
const {runBrokered} = require('../helpers/brokered-worker');

const S = (name) => path.join(__dirname, 'scripts', name);

describe('fs-broker 07: the worker patch', function() {
  this.timeout(60000);

  it('handles every fs, fs.promises and FileHandle method, or knows it as data; replacements are locked', async () => {
    const m = await runBrokered(S('keys.js'));
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    assert.deepStrictEqual(m.r, {fs: [], promises: [], fileHandle: [], locked: true});
  });

  it('behaves as modules and libraries expect', async () => {
    const m = await runBrokered(S('behaviour.js'));
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    const r = m.r;
    assert.strictEqual(r.readSync, 'hello');
    assert.strictEqual(r.readCb, 'hello');
    assert.strictEqual(r.readPromise, 'hello');
    assert.deepStrictEqual(r.stats, {isStats: true, isFile: true, size: 5, mtimeIsDate: true});
    assert.strictEqual(r.bigint, 'bigint');
    assert.deepStrictEqual(r.dirent, {isDirent: true, name: 'a.txt', isFile: true, parentPath: '/data'});
    assert.deepStrictEqual(r.missing, {code: 'ENOENT', path: '/data/missing', isError: true});
    assert.strictEqual(r.fd1, 10);
    assert.deepStrictEqual(r.console, ['1:to stdout\n']);
    assert.strictEqual(r.stream, 'streamed');
    assert.strictEqual(r.handle, 'handle');
    assert.strictEqual(r.append, 'hello world');
    assert.deepStrictEqual(r.exists, [true, false]);
    assert.strictEqual(r.cp, 'deep');
    assert.deepStrictEqual(r.glob, ['a.txt', 'd/e/f.txt', 'd2/e/f.txt', 'h.txt', 's.txt']);
    assert.deepStrictEqual(r.opendir, ['a.txt', 'd', 'd2', 'h.txt', 's.txt']);
    assert.strictEqual(r.vector, 'abcd');
    assert.strictEqual(r.realpathNative, '/data/a.txt');
    assert.strictEqual(r.blob, 'hello world');
    assert.strictEqual(r.disposable, true);
    assert.strictEqual(r.watch, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
    assert.strictEqual(r.bigRead, 17 * 1024 * 1024);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx mocha --exit test/fs-broker/07-patch.js`
Expected: FAIL, `Cannot find module '…/lib/fs-broker/patch'` reported by the worker.

- [ ] **Step 4: Implement** — `lib/fs-broker/patch.js` (the whole file; the `EFBIG` fallback in `readFileSyncImpl`/`readFileImpl` falls back to `open` + chunked reads + `close`):

```js
// Module worker side of the file broker (docs/superpowers/specs/2026-10-17-
// module-sandbox-fs-broker-design.md, section 2): replaces every method of
// the shared fs, fs/promises and FileHandle objects, before any countinghouse
// or dependency code loads, with versions that ask the main thread's broker.
// Sync calls go over the blocking bridge, callback and promise calls over the
// async channel (lib/fs-broker/client.js). Anything not handled here throws,
// so a method a later Node adds fails closed (test/fs-broker/07-patch-keys.js).
const fs = require('fs');
const fsp = require('fs/promises');
const pathMod = require('path');
const {EventEmitter} = require('events');

const MAX_IO = 16 * 1024 * 1024;
const STATS_PROTO = Object.getPrototypeOf(fs.statSync(__filename));
const BIGINT_STATS_PROTO = Object.getPrototypeOf(fs.statSync(__filename, {bigint: true}));
const DIRENT_TYPE = {file: fs.constants.UV_DIRENT_FILE, dir: fs.constants.UV_DIRENT_DIR,
  symlink: fs.constants.UV_DIRENT_LINK, other: fs.constants.UV_DIRENT_UNKNOWN};
const toUnixTimestamp = fs._toUnixTimestamp;

let consoleSilenced = false;
function setConsoleSilenced(v) { consoleSilenced = (v === true); }

function unavailable(what) {
  const err = new Error(`${what} is not available to modules (countinghouse module sandbox)`);
  err.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
  return err;
}

function argType(name, value) {
  const err = new TypeError(`The "${name}" argument must be of type string or an instance of Buffer or URL. Received ${typeof(value)}`);
  err.code = 'ERR_INVALID_ARG_TYPE';
  return err;
}

// Paths cross the bridge as strings (a Buffer arrives as a Uint8Array and a
// URL does not clone).
function p(v, name) {
  if (typeof(v) === 'string') return v;
  if (v instanceof URL) return v.href;
  if (v instanceof Uint8Array) return Buffer.from(v).toString('utf8');
  throw argType(name || 'path', v);
}

function opts(o, def) {
  if (typeof(o) === 'string') return Object.assign({}, def, {encoding: o});
  return Object.assign({}, def, o || {});
}

function enc(buf, encoding) {
  const b = Buffer.from(buf);
  return (encoding && encoding !== 'buffer') ? b.toString(encoding) : b;
}

function str(s, encoding) {
  return encoding === 'buffer' ? Buffer.from(s) : s;
}

function stats(r) {
  const s = Object.create(r.bigint ? BIGINT_STATS_PROTO : STATS_PROTO);
  return Object.assign(s, r.fields);
}

function dirent(e) {
  return new fs.Dirent(e.name, DIRENT_TYPE[e.type] != null ? DIRENT_TYPE[e.type] : DIRENT_TYPE.other, e.parentPath);
}

function mode(m, def) {
  if (m == null) return def;
  return typeof(m) === 'string' ? parseInt(m, 8) : m;
}

function toBuffer(data, encoding) {
  if (typeof(data) === 'string') return Buffer.from(data, encoding || 'utf8');
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const err = new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.');
  err.code = 'ERR_INVALID_ARG_TYPE';
  throw err;
}

function splitCb(args) {
  const cb = args[args.length - 1];
  if (typeof(cb) !== 'function') {
    const err = new TypeError('The "cb" argument must be of type function.');
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  return {args: Array.prototype.slice.call(args, 0, -1), cb: cb};
}

function install(client, settings) {
  const sync = client.sync;
  const call = client.async;
  const consoleWrite = (settings && settings.consoleWrite) || ((fd, buf) => (fd === 1 ? process.stdout : process.stderr).write(buf));
  const handled = {fs: new Set(), promises: new Set(), fileHandle: new Set()};

  function lock(obj, key, value, set) {
    Object.defineProperty(obj, key, {value: value, writable: false, configurable: false, enumerable: true});
    set.add(key);
  }

  // One operation, three forms. spec: {args(...a) -> [op, args], out(result, ...a) -> value}
  function define(name, spec) {
    const syncName = `${name}Sync`;
    const syncFn = function(...a) { return spec.out(sync(...spec.args(...a)), ...a); };
    const cbFn = function(...all) {
      const {args, cb} = splitCb(all);
      let req;
      try { req = spec.args(...args); } catch (e) { return process.nextTick(cb, e); }
      call(...req).then((r) => cb(null, spec.out(r, ...args)), (e) => cb(e));
    };
    const promiseFn = async function(...a) { return spec.out(await call(...spec.args(...a)), ...a); };
    if (spec.native) { syncFn.native = syncFn; cbFn.native = cbFn; }
    if (spec.sync !== false) lock(fs, syncName, syncFn, handled.fs);
    if (spec.callback !== false) lock(fs, name, cbFn, handled.fs);
    if (spec.promise !== false) lock(fsp, name, promiseFn, handled.promises);
  }

  const none = () => undefined;

  define('access', {args: (path, m) => ['access', [p(path), m]], out: none});
  define('stat', {args: (path, o) => ['stat', [p(path), opts(o)]], out: stats});
  define('lstat', {args: (path, o) => ['lstat', [p(path), opts(o)]], out: stats});
  define('fstat', {args: (fd, o) => ['fstat', [fd, opts(o)]], out: stats, promise: false});
  define('statfs', {args: (path, o) => ['statfs', [p(path), opts(o)]], out: (r) => r});
  define('realpath', {args: (path) => ['realpath', [p(path)]], out: (r, path, o) => str(r, opts(o).encoding), native: true});
  define('readlink', {args: (path) => ['readlink', [p(path)]], out: (r, path, o) => str(r, opts(o).encoding)});
  define('readdir', {
    args: (path, o) => { const x = opts(o); return ['readdir', [p(path), {withFileTypes: !!x.withFileTypes, recursive: !!x.recursive}]]; },
    out: (r, path, o) => { const x = opts(o); return x.withFileTypes ? r.map(dirent) : r.map((n) => str(n, x.encoding)); }
  });
  define('mkdir', {args: (path, o) => { const x = (typeof(o) === 'object' && o != null) ? o : {mode: o}; return ['mkdir', [p(path), {recursive: !!x.recursive, mode: mode(x.mode, 0o777)}]]; }, out: (r) => r});
  define('mkdtemp', {args: (prefix) => ['mkdtemp', [p(prefix, 'prefix')]], out: (r, prefix, o) => str(r, opts(o).encoding)});
  define('rmdir', {args: (path, o) => ['rmdir', [p(path), o]], out: none});
  define('rm', {args: (path, o) => ['rm', [p(path), opts(o)]], out: none});
  define('unlink', {args: (path) => ['unlink', [p(path)]], out: none});
  define('rename', {args: (a, b) => ['rename', [p(a, 'oldPath'), p(b, 'newPath')]], out: none});
  define('copyFile', {args: (a, b, m) => ['copyFile', [p(a, 'src'), p(b, 'dest'), m]], out: none});
  define('link', {args: (a, b) => ['link', [p(a, 'existingPath'), p(b, 'newPath')]], out: none});
  define('symlink', {args: (target, path, type) => ['symlink', [p(target, 'target'), p(path), type]], out: none});
  define('chmod', {args: (path, m) => ['chmod', [p(path), mode(m)]], out: none});
  define('chown', {args: (path, uid, gid) => ['chown', [p(path), uid, gid]], out: none});
  define('lchown', {args: (path, uid, gid) => ['lchown', [p(path), uid, gid]], out: none});
  define('utimes', {args: (path, at, mt) => ['utimes', [p(path), toUnixTimestamp(at), toUnixTimestamp(mt)]], out: none});
  define('lutimes', {args: (path, at, mt) => ['lutimes', [p(path), toUnixTimestamp(at), toUnixTimestamp(mt)]], out: none});
  define('truncate', {args: (path, len) => (typeof(path) === 'number' ? ['ftruncate', [path, len || 0]] : ['truncate', [p(path), len || 0]]), out: none});
  define('open', {args: (path, flags, m) => ['open', [p(path), flags == null ? 'r' : flags, mode(m, 0o666)]], out: (fd) => fd, promise: false});
  define('close', {args: (fd) => ['close', [fd]], out: none, promise: false});
  define('fsync', {args: (fd) => ['fsync', [fd]], out: none, promise: false});
  define('fdatasync', {args: (fd) => ['fdatasync', [fd]], out: none, promise: false});
  define('ftruncate', {args: (fd, len) => ['ftruncate', [fd, len || 0]], out: none, promise: false});
  define('fchmod', {args: (fd, m) => ['fchmod', [fd, mode(m)]], out: none, promise: false});
  define('fchown', {args: (fd, uid, gid) => ['fchown', [fd, uid, gid]], out: none, promise: false});
  define('futimes', {args: (fd, at, mt) => ['futimes', [fd, toUnixTimestamp(at), toUnixTimestamp(mt)]], out: none, promise: false});

  // exists: the callback gets one argument, a boolean.
  lock(fs, 'existsSync', (path) => { try { return sync('exists', [p(path)]); } catch (e) { return false; } }, handled.fs);
  lock(fs, 'exists', (path, cb) => {
    let req;
    try { req = p(path); } catch (e) { return process.nextTick(cb, false); }
    call('exists', [req]).then((r) => cb(r), () => cb(false));
  }, handled.fs);

  // read / write on descriptors, with Node's argument shapes.
  function readArgs(fd, buffer, offset, length, position) {
    if (buffer != null && !ArrayBuffer.isView(buffer) && typeof(buffer) === 'object') {
      const o = buffer;
      buffer = o.buffer || Buffer.alloc(16384);
      offset = o.offset; length = o.length; position = o.position;
    } else if (offset != null && typeof(offset) === 'object') {
      const o = offset;
      offset = o.offset; length = o.length; position = o.position;
    }
    offset = offset || 0;
    length = (length == null) ? buffer.byteLength - offset : length;
    return {buffer, offset, length: Math.min(length, MAX_IO), position: (position == null || position === -1) ? null : Number(position)};
  }
  function fillRead(r, a) {
    const b = Buffer.from(r);
    b.copy(Buffer.from(a.buffer.buffer, a.buffer.byteOffset, a.buffer.byteLength), a.offset);
    return b.length;
  }
  function writeArgs(fd, data, offset, length, position) {
    if (typeof(data) === 'string') {
      // write(fd, string[, position[, encoding]])
      return {buf: Buffer.from(data, typeof(length) === 'string' ? length : 'utf8'), position: (offset == null) ? null : offset};
    }
    const buf = toBuffer(data);
    if (offset != null && typeof(offset) === 'object') {
      const o = offset;
      return {buf: buf.subarray(o.offset || 0, (o.offset || 0) + (o.length == null ? buf.length - (o.offset || 0) : o.length)), position: o.position == null ? null : o.position};
    }
    const off = offset || 0;
    const len = (length == null) ? buf.length - off : length;
    return {buf: buf.subarray(off, off + len), position: position == null ? null : position};
  }
  function writeChunks(fd, buf, position) {
    if (fd === 1 || fd === 2) { if (!consoleSilenced) consoleWrite(fd, buf); return buf.length; }
    let done = 0;
    while (done < buf.length) {
      const chunk = buf.subarray(done, done + MAX_IO);
      done += sync('write', [fd, chunk, position == null ? null : position + done]);
    }
    return done;
  }
  async function writeChunksAsync(fd, buf, position) {
    if (fd === 1 || fd === 2) { if (!consoleSilenced) consoleWrite(fd, buf); return buf.length; }
    let done = 0;
    while (done < buf.length) {
      const chunk = buf.subarray(done, done + MAX_IO);
      done += await call('write', [fd, chunk, position == null ? null : position + done]);
    }
    return done;
  }

  lock(fs, 'readSync', (fd, ...rest) => { const a = readArgs(fd, ...rest); return fillRead(sync('read', [fd, a.length, a.position]), a); }, handled.fs);
  lock(fs, 'read', (fd, ...all) => {
    const {args, cb} = splitCb(all);
    let a;
    try { a = readArgs(fd, ...(args.length > 0 ? args : [{}])); } catch (e) { return process.nextTick(cb, e); }
    call('read', [fd, a.length, a.position]).then((r) => cb(null, fillRead(r, a), a.buffer), (e) => cb(e));
  }, handled.fs);
  lock(fs, 'writeSync', (fd, ...rest) => { const w = writeArgs(fd, ...rest); return writeChunks(fd, w.buf, w.position); }, handled.fs);
  lock(fs, 'write', (fd, data, ...all) => {
    const {args, cb} = splitCb(all);
    let w;
    try { w = writeArgs(fd, data, ...args); } catch (e) { return process.nextTick(cb, e); }
    writeChunksAsync(fd, w.buf, w.position).then((n) => cb(null, n, data), (e) => cb(e));
  }, handled.fs);
  function vec(buffers) { return Buffer.concat(buffers.map((b) => toBuffer(b))); }
  lock(fs, 'writevSync', (fd, buffers, position) => writeChunks(fd, vec(buffers), position), handled.fs);
  lock(fs, 'writev', (fd, buffers, ...all) => {
    const {args, cb} = splitCb(all);
    writeChunksAsync(fd, vec(buffers), args[0]).then((n) => cb(null, n, buffers), (e) => cb(e));
  }, handled.fs);
  function scatter(r, buffers) {
    const b = Buffer.from(r);
    let off = 0;
    for (const t of buffers) {
      const n = Math.min(t.byteLength, b.length - off);
      b.copy(Buffer.from(t.buffer, t.byteOffset, t.byteLength), 0, off, off + n);
      off += n;
    }
    return b.length;
  }
  const total = (buffers) => Math.min(buffers.reduce((n, b) => n + b.byteLength, 0), MAX_IO);
  lock(fs, 'readvSync', (fd, buffers, position) => scatter(sync('read', [fd, total(buffers), position == null ? null : position]), buffers), handled.fs);
  lock(fs, 'readv', (fd, buffers, ...all) => {
    const {args, cb} = splitCb(all);
    call('read', [fd, total(buffers), args[0] == null ? null : args[0]]).then((r) => cb(null, scatter(r, buffers), buffers), (e) => cb(e));
  }, handled.fs);

  // Whole files: a path goes to the broker's readFile (one round trip, up to
  // 16 MB, chunked past it); a descriptor reads from its current position.
  function readAllFd(fd) {
    const parts = [];
    for (;;) {
      const r = Buffer.from(sync('read', [fd, MAX_IO, null]));
      if (r.length === 0) break;
      parts.push(r);
    }
    return Buffer.concat(parts);
  }
  async function readAllFdAsync(fd) {
    const parts = [];
    for (;;) {
      const r = Buffer.from(await call('read', [fd, MAX_IO, null]));
      if (r.length === 0) break;
      parts.push(r);
    }
    return Buffer.concat(parts);
  }
  function readFileSyncImpl(path, o) {
    const x = opts(o, {flag: 'r'});
    if (typeof(path) === 'number') return enc(readAllFd(path), x.encoding);
    try {
      return enc(sync('readFile', [p(path), x.flag]), x.encoding);
    } catch (e) {
      if (e.code !== 'EFBIG') throw e;
    }
    // past 16 MB: chunked reads the worker assembles
    const fd = sync('open', [p(path), x.flag, 0o666]);
    try { return enc(readAllFd(fd), x.encoding); } finally { sync('close', [fd]); }
  }
  async function readFileImpl(path, o) {
    const x = opts(o, {flag: 'r'});
    if (typeof(path) === 'number') return enc(await readAllFdAsync(path), x.encoding);
    if (path instanceof BrokeredFileHandle) return enc(await readAllFdAsync(path.fd), x.encoding);
    try {
      return enc(await call('readFile', [p(path), x.flag]), x.encoding);
    } catch (e) {
      if (e.code !== 'EFBIG') throw e;
    }
    const fd = await call('open', [p(path), x.flag, 0o666]);
    try { return enc(await readAllFdAsync(fd), x.encoding); } finally { await call('close', [fd]); }
  }
  function writeFileSyncImpl(path, data, o, defFlag) {
    const x = opts(o, {flag: defFlag, mode: 0o666});
    const buf = toBuffer(data, x.encoding);
    if (typeof(path) === 'number') { writeChunks(path, buf, null); return; }
    const fd = sync('open', [p(path), x.flag, mode(x.mode)]);
    try { writeChunks(fd, buf, null); } finally { sync('close', [fd]); }
  }
  async function writeFileImpl(path, data, o, defFlag) {
    const x = opts(o, {flag: defFlag, mode: 0o666});
    if (data != null && typeof(data) === 'object' && !ArrayBuffer.isView(data) && typeof(data[Symbol.asyncIterator]) === 'function') {
      const parts = [];
      for await (const chunk of data) parts.push(toBuffer(chunk, x.encoding));
      data = Buffer.concat(parts);
    }
    const buf = toBuffer(data, x.encoding);
    if (typeof(path) === 'number') { await writeChunksAsync(path, buf, null); return; }
    if (path instanceof BrokeredFileHandle) { await writeChunksAsync(path.fd, buf, null); return; }
    const fd = await call('open', [p(path), x.flag, mode(x.mode)]);
    try { await writeChunksAsync(fd, buf, null); } finally { await call('close', [fd]); }
  }
  lock(fs, 'readFileSync', readFileSyncImpl, handled.fs);
  lock(fs, 'readFile', (path, ...all) => { const {args, cb} = splitCb(all); readFileImpl(path, args[0]).then((r) => cb(null, r), (e) => cb(e)); }, handled.fs);
  lock(fsp, 'readFile', readFileImpl, handled.promises);
  lock(fs, 'writeFileSync', (path, data, o) => writeFileSyncImpl(path, data, o, 'w'), handled.fs);
  lock(fs, 'writeFile', (path, data, ...all) => { const {args, cb} = splitCb(all); writeFileImpl(path, data, args[0], 'w').then(() => cb(null), (e) => cb(e)); }, handled.fs);
  lock(fsp, 'writeFile', (path, data, o) => writeFileImpl(path, data, o, 'w'), handled.promises);
  lock(fs, 'appendFileSync', (path, data, o) => writeFileSyncImpl(path, data, o, 'a'), handled.fs);
  lock(fs, 'appendFile', (path, data, ...all) => { const {args, cb} = splitCb(all); writeFileImpl(path, data, args[0], 'a').then(() => cb(null), (e) => cb(e)); }, handled.fs);
  lock(fsp, 'appendFile', (path, data, o) => writeFileImpl(path, data, o, 'a'), handled.promises);

  // FileHandle (fs.promises.open).
  class BrokeredFileHandle extends EventEmitter {
    constructor(fd) { super(); this._fd = fd; }
    get fd() { return this._fd; }
    getAsyncId() { return -1; }
    async close() { if (this._fd < 0) return; const fd = this._fd; this._fd = -1; await call('close', [fd]); this.emit('close'); }
    async [Symbol.asyncDispose]() { await this.close(); }
    async read(buffer, offset, length, position) {
      if (buffer == null || (!ArrayBuffer.isView(buffer) && typeof(buffer) === 'object')) {
        const o = buffer || {};
        buffer = o.buffer || Buffer.alloc(16384);
        offset = o.offset; length = o.length; position = o.position;
      }
      const a = readArgs(this._fd, buffer, offset, length, position);
      const n = fillRead(await call('read', [this._fd, a.length, a.position]), a);
      return {bytesRead: n, buffer: a.buffer};
    }
    async write(data, ...rest) { const w = writeArgs(this._fd, data, ...rest); return {bytesWritten: await writeChunksAsync(this._fd, w.buf, w.position), buffer: data}; }
    async readv(buffers, position) { return {bytesRead: scatter(await call('read', [this._fd, total(buffers), position == null ? null : position]), buffers), buffers}; }
    async writev(buffers, position) { return {bytesWritten: await writeChunksAsync(this._fd, vec(buffers), position), buffers}; }
    readFile(o) { return readFileImpl(this, o); }
    writeFile(data, o) { return writeFileImpl(this, data, o, 'w'); }
    appendFile(data, o) { return writeFileImpl(this, data, o, 'a'); }
    async stat(o) { return stats(await call('fstat', [this._fd, opts(o)])); }
    async truncate(len) { await call('ftruncate', [this._fd, len || 0]); }
    async sync() { await call('fsync', [this._fd]); }
    async datasync() { await call('fdatasync', [this._fd]); }
    async chmod(m) { await call('fchmod', [this._fd, mode(m)]); }
    async chown(uid, gid) { await call('fchown', [this._fd, uid, gid]); }
    async utimes(at, mt) { await call('futimes', [this._fd, toUnixTimestamp(at), toUnixTimestamp(mt)]); }
    createReadStream(o) { return fs.createReadStream(null, Object.assign({}, o, {fd: this._fd, autoClose: false})); }
    createWriteStream(o) { return fs.createWriteStream(null, Object.assign({}, o, {fd: this._fd, autoClose: false})); }
    readLines(o) { return require('readline').createInterface({input: this.createReadStream(o), crlfDelay: Infinity}); }
    readableWebStream() { return require('stream').Readable.toWeb(this.createReadStream()); }
  }
  Object.getOwnPropertyNames(BrokeredFileHandle.prototype).forEach((k) => handled.fileHandle.add(k));
  lock(fsp, 'open', async(path, flags, m) => new BrokeredFileHandle(await call('open', [p(path), flags == null ? 'r' : flags, mode(m, 0o666)])), handled.promises);

  // Directories as streams of entries (fs.opendir).
  function makeDir(path, entries) {
    const dir = Object.create(fs.Dir.prototype);
    let i = 0;
    let closed = false;
    const next = () => (i < entries.length ? entries[i++] : null);
    Object.defineProperties(dir, {
      path: {value: path, enumerable: true},
      readSync: {value: () => next()},
      read: {value: (cb) => (typeof(cb) === 'function' ? process.nextTick(cb, null, next()) : Promise.resolve(next()))},
      closeSync: {value: () => { closed = true; }},
      close: {value: (cb) => { closed = true; return typeof(cb) === 'function' ? process.nextTick(cb, null) : Promise.resolve(); }},
      entries: {value: async function* () { let e; while (!closed && (e = next()) != null) yield e; }},
      [Symbol.asyncIterator]: {value: async function* () { let e; while (!closed && (e = next()) != null) yield e; closed = true; }},
      [Symbol.asyncDispose]: {value: async() => { closed = true; }},
      [Symbol.dispose]: {value: () => { closed = true; }}
    });
    return dir;
  }
  lock(fs, 'opendirSync', (path, o) => makeDir(p(path), sync('readdir', [p(path), {withFileTypes: true, recursive: !!(o && o.recursive)}]).map(dirent)), handled.fs);
  lock(fs, 'opendir', (path, ...all) => {
    const {args, cb} = splitCb(all);
    call('readdir', [p(path), {withFileTypes: true, recursive: !!(args[0] && args[0].recursive)}]).then((r) => cb(null, makeDir(p(path), r.map(dirent))), (e) => cb(e));
  }, handled.fs);
  lock(fsp, 'opendir', async(path, o) => makeDir(p(path), (await call('readdir', [p(path), {withFileTypes: true, recursive: !!(o && o.recursive)}])).map(dirent)), handled.promises);

  // cp: a recursive copy built on the primitives, so every step is checked.
  // A tree holding absolute symlinks fails with EPERM under the link rules.
  function cpPlan(src, dest, o) {
    return {src: p(src, 'src'), dest: p(dest, 'dest'), o: Object.assign({force: true, recursive: false}, o || {})};
  }
  function cpSyncImpl(src, dest, o) {
    if (typeof(o.filter) === 'function' && !o.filter(src, dest)) return;
    const st = stats(sync(o.dereference ? 'stat' : 'lstat', [src, {}]));
    if (st.isDirectory()) {
      if (!o.recursive) { const e = new Error(`Recursive option is required to copy a directory: ${src}`); e.code = 'ERR_FS_EISDIR'; throw e; }
      sync('mkdir', [dest, {recursive: true}]);
      for (const name of sync('readdir', [src, {}])) cpSyncImpl(pathMod.posix.join(src, name), pathMod.posix.join(dest, name), o);
    } else if (st.isSymbolicLink()) {
      sync('symlink', [sync('readlink', [src]), dest]);
    } else {
      sync('copyFile', [src, dest, (o.force === false || o.errorOnExist) ? fs.constants.COPYFILE_EXCL : 0]);
    }
    if (o.preserveTimestamps) sync('utimes', [dest, toUnixTimestamp(st.atime), toUnixTimestamp(st.mtime)]);
  }
  async function cpImpl(src, dest, o) {
    if (typeof(o.filter) === 'function' && !(await o.filter(src, dest))) return;
    const st = stats(await call(o.dereference ? 'stat' : 'lstat', [src, {}]));
    if (st.isDirectory()) {
      if (!o.recursive) { const e = new Error(`Recursive option is required to copy a directory: ${src}`); e.code = 'ERR_FS_EISDIR'; throw e; }
      await call('mkdir', [dest, {recursive: true}]);
      for (const name of await call('readdir', [src, {}])) await cpImpl(pathMod.posix.join(src, name), pathMod.posix.join(dest, name), o);
    } else if (st.isSymbolicLink()) {
      await call('symlink', [await call('readlink', [src]), dest]);
    } else {
      await call('copyFile', [src, dest, (o.force === false || o.errorOnExist) ? fs.constants.COPYFILE_EXCL : 0]);
    }
    if (o.preserveTimestamps) await call('utimes', [dest, toUnixTimestamp(st.atime), toUnixTimestamp(st.mtime)]);
  }
  lock(fs, 'cpSync', (src, dest, o) => { const c = cpPlan(src, dest, o); cpSyncImpl(c.src, c.dest, c.o); }, handled.fs);
  lock(fs, 'cp', (src, dest, ...all) => { const {args, cb} = splitCb(all); const c = cpPlan(src, dest, args[0]); cpImpl(c.src, c.dest, c.o).then(() => cb(null), (e) => cb(e)); }, handled.fs);
  lock(fsp, 'cp', (src, dest, o) => { const c = cpPlan(src, dest, o); return cpImpl(c.src, c.dest, c.o); }, handled.promises);

  // glob: walk with readdir and match with path.matchesGlob.
  function globMatch(entries, patterns, o) {
    const exclude = o.exclude;
    const out = [];
    for (const e of entries) {
      const rel = pathMod.posix.relative(o.cwd, pathMod.posix.join(e.parentPath, e.name));
      if (!patterns.some((pat) => pathMod.matchesGlob(rel, pat))) continue;
      if (typeof(exclude) === 'function' && exclude(o.withFileTypes ? dirent(e) : rel)) continue;
      if (Array.isArray(exclude) && exclude.some((pat) => pathMod.matchesGlob(rel, pat))) continue;
      out.push(o.withFileTypes ? dirent(e) : rel);
    }
    return out;
  }
  function globOpts(pattern, o) {
    const x = Object.assign({}, o || {});
    x.cwd = x.cwd != null ? p(x.cwd, 'cwd') : process.cwd();
    return {patterns: Array.isArray(pattern) ? pattern : [pattern], x: x};
  }
  lock(fs, 'globSync', (pattern, o) => { const g = globOpts(pattern, o); return globMatch(sync('readdir', [g.x.cwd, {withFileTypes: true, recursive: true}]), g.patterns, g.x); }, handled.fs);
  lock(fs, 'glob', (pattern, ...all) => {
    const {args, cb} = splitCb(all);
    const g = globOpts(pattern, args[0]);
    call('readdir', [g.x.cwd, {withFileTypes: true, recursive: true}]).then((r) => cb(null, globMatch(r, g.patterns, g.x)), (e) => cb(e));
  }, handled.fs);
  lock(fsp, 'glob', (pattern, o) => {
    const g = globOpts(pattern, o);
    return (async function* () { for (const m of globMatch(await call('readdir', [g.x.cwd, {withFileTypes: true, recursive: true}]), g.patterns, g.x)) yield m; })();
  }, handled.promises);

  lock(fs, 'openAsBlob', async(path, o) => new Blob([await readFileImpl(path)], {type: (o && o.type) || ''}), handled.fs);
  lock(fs, 'mkdtempDisposableSync', (prefix) => {
    const path = sync('mkdtemp', [p(prefix, 'prefix')]);
    const remove = () => sync('rm', [path, {recursive: true, force: true}]);
    return {path: path, remove: remove, [Symbol.dispose]: remove};
  }, handled.fs);
  lock(fsp, 'mkdtempDisposable', async(prefix) => {
    const path = await call('mkdtemp', [p(prefix, 'prefix')]);
    const remove = () => call('rm', [path, {recursive: true, force: true}]);
    return {path: path, remove: remove, [Symbol.asyncDispose]: remove};
  }, handled.promises);

  // Watching is not offered (spec decision 2); Utf8Stream is not brokered.
  ['watch', 'watchFile'].forEach((k) => lock(fs, k, () => { throw unavailable(`fs.${k}`); }, handled.fs));
  lock(fs, 'unwatchFile', () => undefined, handled.fs);
  lock(fsp, 'watch', () => { throw unavailable('fs.promises.watch'); }, handled.promises);
  lock(fs, 'Utf8Stream', function() { throw unavailable('fs.Utf8Stream'); }, handled.fs);
  // lchmod exists only on macOS; the promise form throws there anyway.
  lock(fsp, 'lchmod', async() => { const e = new Error('The lchmod() method is not implemented'); e.code = 'ERR_METHOD_NOT_IMPLEMENTED'; throw e; }, handled.promises);

  return handled;
}

// Exports that are data or classes, not file operations. ReadStream and
// WriteStream look fs methods up at call time, so they use the patched ones.
const PASSTHROUGH = {
  fs: ['Dir', 'Dirent', 'FileReadStream', 'FileWriteStream', 'ReadStream', 'Stats', 'WriteStream', '_toUnixTimestamp',
    'constants', 'promises', 'createReadStream', 'createWriteStream', 'lchmod', 'lchmodSync',
    'F_OK', 'R_OK', 'W_OK', 'X_OK'],
  promises: ['constants']
};

module.exports = {install, setConsoleSilenced, PASSTHROUGH};
```

- [ ] **Step 5: Run the tests**

Run: `npx mocha --exit test/fs-broker/07-patch.js`
Expected: 2 passing. A failing assertion is a patch bug (debug it); a key reported by `keys.js` is a method the patch must handle or, if it is data or a class, add to `PASSTHROUGH` with a comment saying why — ask the reviewer before adding a function to `PASSTHROUGH`.

- [ ] **Step 6: Commit**

```bash
git add lib/fs-broker/patch.js test/helpers/brokered-worker.js test/helpers/brokered-worker-entry.js test/fs-broker/scripts/keys.js test/fs-broker/scripts/behaviour.js test/fs-broker/07-patch.js
git commit -m "feat(fs-broker): the worker patch, failing closed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The differential test

**Files:**
- Create: `test/fs-broker/scripts/differential.js`, `test/fs-broker/08-differential.js`

**Interfaces:**
- Consumes: `runBrokered` (Task 3).

- [ ] **Step 1: Write the script and the test.** `test/fs-broker/scripts/differential.js` — one sequence of operations whose outcome must not depend on whether `fs` is real or brokered (paths relative to `root`, errors reduced to their code):

```js
const path = require('path');

module.exports = async (fs, root) => {
  const fsp = require('fs/promises');
  const j = (...p) => path.posix.join(root, ...p);
  const rel = (p) => (typeof(p) === 'string' && p.startsWith(root) ? `<root>${p.slice(root.length)}` : p);
  const steps = [];
  const step = async(name, fn) => {
    try {
      const v = await fn();
      steps.push([name, 'ok', v === undefined ? null : v]);
    } catch (e) {
      steps.push([name, 'error', e.code || e.message]);
    }
  };
  await step('write', () => fs.writeFileSync(j('f'), 'abc'));
  await step('read', () => fs.readFileSync(j('f'), 'utf8'));
  await step('read missing', () => fs.readFileSync(j('missing')));
  await step('stat size', () => fs.statSync(j('f')).size);
  await step('stat dir', () => fs.statSync(root).isDirectory());
  await step('lstat missing', () => fs.lstatSync(j('nope')));
  await step('mkdir', () => fs.mkdirSync(j('d')));
  await step('mkdir exists', () => fs.mkdirSync(j('d')));
  await step('mkdir -p', () => rel(fs.mkdirSync(j('p', 'q', 'r'), {recursive: true})));
  await step('rmdir not empty', () => fs.rmdirSync(j('p')));
  await step('rm dir no recursive', () => fs.rmSync(j('d')));
  await step('rm -r', () => fs.rmSync(j('p'), {recursive: true}));
  await step('readdir', () => fs.readdirSync(root).sort());
  await step('rename', () => fs.renameSync(j('f'), j('g')));
  await step('rename missing', () => fs.renameSync(j('f'), j('h')));
  await step('copy', () => fs.copyFileSync(j('g'), j('c')));
  await step('copy excl', () => fs.copyFileSync(j('g'), j('c'), fs.constants.COPYFILE_EXCL));
  await step('symlink rel', () => fs.symlinkSync('g', j('l')));
  await step('readlink', () => fs.readlinkSync(j('l')));
  await step('read via link', () => fs.readFileSync(j('l'), 'utf8'));
  await step('link', () => fs.linkSync(j('g'), j('hard')));
  await step('nlink', () => fs.statSync(j('g')).nlink);
  await step('chmod', () => { fs.chmodSync(j('g'), 0o600); return fs.statSync(j('g')).mode & 0o777; });
  await step('truncate', () => { fs.truncateSync(j('g'), 1); return fs.readFileSync(j('g'), 'utf8'); });
  await step('open/write/read', () => {
    const fd = fs.openSync(j('o'), 'w+');
    fs.writeSync(fd, 'xyz');
    const b = Buffer.alloc(3);
    fs.readSync(fd, b, 0, 3, 0);
    fs.closeSync(fd);
    return b.toString();
  });
  await step('close twice', () => { const fd = fs.openSync(j('o'), 'r'); fs.closeSync(fd); fs.closeSync(fd); });
  await step('open dir for write', () => fs.openSync(root, 'w'));
  await step('append', () => { fs.appendFileSync(j('o'), '!'); return fs.readFileSync(j('o'), 'utf8'); });
  await step('promises readdir types', async() => (await fsp.readdir(root, {withFileTypes: true})).map((d) => [d.name, d.isFile(), d.isDirectory(), d.isSymbolicLink()]).sort());
  await step('unlink', () => fs.unlinkSync(j('c')));
  await step('unlink missing', () => fs.unlinkSync(j('c')));
  await step('access', () => fs.accessSync(j('g'), fs.constants.R_OK));
  await step('exists', () => [fs.existsSync(j('g')), fs.existsSync(j('c'))]);
  await step('utimes', () => { fs.utimesSync(j('g'), 1000, 2000); return fs.statSync(j('g')).mtimeMs; });
  return steps;
};
```

`test/fs-broker/08-differential.js`:

```js
const assert = require('assert');
const path = require('path');
const {runBrokered} = require('../helpers/brokered-worker');

const SCRIPT = path.join(__dirname, 'scripts', 'differential.js');

describe('fs-broker 08: brokered fs matches real fs', function() {
  this.timeout(60000);

  it('gives the same results and error codes for the same operations', async () => {
    const real = await runBrokered(SCRIPT, {patch: false});
    const brokered = await runBrokered(SCRIPT, {patch: true});
    assert.strictEqual(real.ok, true, JSON.stringify(real));
    assert.strictEqual(brokered.ok, true, JSON.stringify(brokered));
    for (let i = 0; i < Math.max(real.r.length, brokered.r.length); i++) {
      assert.deepStrictEqual(brokered.r[i], real.r[i], `step ${i}: ${JSON.stringify(real.r[i])}`);
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx mocha --exit test/fs-broker/08-differential.js`
Expected: PASS. This test was written after the patch, so it cannot be seen failing for a missing feature; instead check it can fail: temporarily change `fs.statSync(j('f')).size` in the script to compare `.blocks` under the broker only (or break `readFile`'s encoding in the patch locally), see it fail with the step name, and revert. Note in the ledger which mutation you used. A real mismatch is a patch or broker bug: fix the code, never special-case the comparison.

- [ ] **Step 3: Commit**

```bash
git add test/fs-broker/scripts/differential.js test/fs-broker/08-differential.js
git commit -m "test(fs-broker): brokered fs gives the same results and error codes as real fs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Wiring — every module worker gets a broker

**Files:**
- Create: `lib/fs-broker/index.js`, `test/fixtures/fs-probe/{package.json,api.json,schema.json,handlers/probeService/write.js,handlers/probeService/read.js}`, `test/fs-broker/09-wired.js`
- Modify: `lib/sandbox.js` (first statements; `set-options`), `lib/module-manager.js` (`spawnModuleWorker`), `lib/module-sandbox-config.js` (`build` returns `fs`), `lib/worker-limits.js` (`busy`), `framework.js` (the `file broker:` line only in worker mode), `test/fs-broker/04-scheduler.js` (its startup test now passes `--workerThread`), `test/sandbox/11-heartbeat.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `require('./fs-broker').createForWorker({name, mode, modulePath, declared, options, report}) → Promise<{broker, bridge, namespace, dirs}>`; `protectedPaths(options) → [string]`; `watch(worker, workerMessage, limits, {busy})`.

- [ ] **Step 1: Write the failing tests.** The heartbeat case in `test/sandbox/11-heartbeat.js` (append inside its `describe`):

```js
  it('a worker waiting on a sync file call is not blocked', async () => {
    const {w, wm} = fakeWorker(() => false);   // never answers pings
    let busy = true;
    stop = workerLimits.watch(w, wm, Object.assign({maxBlockMs: 300}, LIMITS), {busy: () => busy});
    await sleep(900);
    assert.strictEqual(w.killed, false, `killed: ${wm.killReason}`);
    busy = false;
    const t0 = Date.now();
    while (!w.killed && Date.now() - t0 < 3000) await sleep(20);
    assert.strictEqual(wm.killReason, 'blocked event loop');
  });
```

The fixture module `test/fixtures/fs-probe`: `package.json`:

```json
{"name": "fs-probe", "version": "1.0.0", "description": "writes and reads files so the file broker can be seen working"}
```

`api.json`:

```json
{
  "device": {
    "friendlyName": "fs-probe",
    "manufacturer": "countinghouse-test",
    "modelDescription": "writes and reads files so the file broker can be seen working",
    "serviceList": {
      "urn:countinghouse-test:serviceID:probeService": {
        "actionList": [
          {"name": "write", "description": "Write a file.", "input": {"schema": "/probeService/write/input"}, "output": {"schema": "/probeService/write/output"}},
          {"name": "read", "description": "Read a file.", "input": {"schema": "/probeService/read/input"}, "output": {"schema": "/probeService/read/output"}}
        ]
      }
    }
  }
}
```

`schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/",
  "type": "object",
  "probeService": {
    "write": {
      "input": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]},
      "output": {"type": "object", "properties": {"ok": {"type": "boolean"}, "code": {"type": ["string", "null"]}}}
    },
    "read": {
      "input": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
      "output": {"type": "object", "properties": {"content": {"type": ["string", "null"]}, "code": {"type": ["string", "null"]}}}
    }
  }
}
```

`handlers/probeService/write.js`:

```js
// write.js -- writes input.content to input.path with the module's fs.
module.exports = async (input) => {
  try {
    require('fs').writeFileSync(input.path, input.content);
    return {output: {ok: true, code: null}};
  } catch (e) {
    return {output: {ok: false, code: String(e.code)}};
  }
};
```

`handlers/probeService/read.js`:

```js
// read.js -- reads input.path with the module's fs.
module.exports = async (input) => {
  try {
    return {output: {content: require('fs').readFileSync(input.path, 'utf8'), code: null}};
  } catch (e) {
    return {output: {content: null, code: String(e.code)}};
  }
};
```

`test/fs-broker/09-wired.js`:

```js
// Every module worker's fs goes through its broker, in every mode.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');
const {mkdtemp} = require('../helpers/test-tmp');

const KEY = 'aabbcc';
const PROBE = path.join(ROOT, 'test', 'fixtures', 'fs-probe');
const tool = (a) => `fs_probe_probeservice_${a}`;

describe('fs-broker 09: module workers use the broker', function() {
  this.timeout(120000);
  let server = null;
  let base = null;
  beforeEach(() => { base = mkdtemp('wired-'); });
  afterEach(() => { stopServer(server); server = null; fs.rmSync(base, {recursive: true, force: true}); });

  function start(mode) {
    return startServer(9626, ['--workerThread', '--debug', '--debugKey', KEY, '--moduleSandbox', mode,
      '--moduleDataPath', path.join(base, 'store'), '--loadModule', PROBE]);
  }

  ['off', 'audit', 'enforce'].forEach((mode) => {
    it(`${mode}: /data is the module's own data directory`, async () => {
      server = await start(mode);
      const w = await mcpCall(9626, KEY, tool('write'), {path: '/data/x', content: 'hello'});
      assert.deepStrictEqual(w.structuredContent.output, {ok: true, code: null}, JSON.stringify(w));
      assert.strictEqual(fs.readFileSync(path.join(base, 'store', 'fs-probe', 'data', 'x'), 'utf8'), 'hello');
      const r = await mcpCall(9626, KEY, tool('read'), {path: '/data/x'});
      assert.deepStrictEqual(r.structuredContent.output, {content: 'hello', code: null});
    });
  });

  it('audit: a path outside the namespace passes through and is logged', async () => {
    server = await start('audit');
    const outside = path.join(base, 'outside.txt');
    const w = await mcpCall(9626, KEY, tool('write'), {path: outside, content: 'o'});
    assert.strictEqual(w.structuredContent.output.ok, true, JSON.stringify(w));
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'o');
    await waitFor(async () => server.output.includes(`module sandbox: fs-probe file outside ${outside}`), 5000, 'outside log line');
  });

  it('enforce behaves as audit for files until plan 3 (the gate)', async () => {
    server = await start('enforce');
    const outside = path.join(base, 'outside.txt');
    const w = await mcpCall(9626, KEY, tool('write'), {path: outside, content: 'o'});
    assert.strictEqual(w.structuredContent.output.ok, true, JSON.stringify(w));
  });

  it('data survives a restart of the module', async () => {
    server = await start('audit');
    await mcpCall(9626, KEY, tool('write'), {path: '/data/keep', content: 'kept'});
    const r1 = await post(9626, KEY, '/restart-module', {name: 'fs-probe'});
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
    await waitFor(async () => (await mcpCall(9626, KEY, tool('read'), {path: '/data/keep'})).structuredContent.output.content === 'kept', 15000, 'read after restart');
  });

  it('logs the broker\'s capacity at startup in worker mode', async () => {
    server = await start('audit');
    assert.ok(/file broker: up to \d+ module file operations in flight/.test(server.output), server.output.slice(-2000));
  });
});
```

- [ ] **Step 2: Run them to verify they fail** (tell the reviewer first: port 9626)

Run: `npx mocha test/sandbox/11-heartbeat.js` → the new case fails (killed while busy).
Run: `npx mocha --exit test/fs-broker/09-wired.js` → fails: `/data/x` resolves to the host's `/data` (no broker).

- [ ] **Step 3: Implement.**
  - `lib/worker-limits.js` `watch`: add `const busy = (opts != null && typeof(opts.busy) === 'function') ? opts.busy : () => false;` and in the tick change `if (stalled) pending.since = now;` to `if (stalled || busy()) pending.since = now;` with the comment "a worker waiting on a sync file call is not blocking: the main thread is doing its I/O".
  - `lib/module-sandbox-config.js` `build`: add `fs: eff.fs,` to the returned object.
  - `lib/fs-broker/index.js`:

```js
// Builds one module worker's file broker at spawn (docs/superpowers/specs/
// 2026-10-17-module-sandbox-fs-broker-design.md, section 3): its data
// directories, its prepared namespace, its broker on the shared scheduler,
// and the bridge the worker receives in workerData.
const fsp = require('fs/promises');
const path = require('path');
const moduleData = require('../module-data');
const {createNamespace} = require('./namespace');
const {FsBroker} = require('./broker');
const {FsScheduler} = require('./scheduler');
const {createBridge} = require('./server');

const INSTALL_DIR = path.join(__dirname, '..', '..');
let scheduler = null;
let spawned = 0;

function sharedScheduler() {
  if (scheduler == null) scheduler = new FsScheduler({globalCap: FsScheduler.capFor(process.env.UV_THREADPOOL_SIZE)});
  return scheduler;
}

// What no module may declare, or declare an ancestor of (spec section 1).
function protectedPaths(options) {
  const cwd = process.cwd();
  return [INSTALL_DIR, options.modulePath, options.moduleDataPath,
    options.authConfigPath || path.join(cwd, 'auth.json'),
    options.deviceConfigPath || path.join(cwd, 'config', 'devices'),
    options.modulePolicy].filter((p) => p != null).map((p) => path.resolve(cwd, p));
}

async function createForWorker(cfg) {
  const dirs = await moduleData.ensureDirs(cfg.options.moduleDataPath, cfg.name);
  const moduleRoot = await fsp.realpath(path.resolve(cfg.modulePath));
  const namespace = createNamespace({moduleRoot: moduleRoot, dataDir: dirs.data, tmpDir: dirs.tmp,
    declared: cfg.declared || [], protectedPaths: protectedPaths(cfg.options)});
  await namespace.prepare();
  namespace.refused.forEach((r) => cfg.report('refused', `${r.path} (${r.reason})`));
  const key = `${cfg.name}#${++spawned}`;
  const sched = sharedScheduler();
  const broker = new FsBroker({name: cfg.name, mode: cfg.mode, namespace: namespace, cwd: process.cwd(), report: cfg.report,
    schedule: (fn) => sched.submit(key, fn), quiet: [moduleRoot, INSTALL_DIR]});
  const bridge = createBridge({broker: broker, scheduler: sched, key: key});
  return {broker, bridge, namespace, dirs};
}

module.exports = {createForWorker, protectedPaths, sharedScheduler, INSTALL_DIR};
```

  - `lib/sandbox.js`: directly after the `process.umask` workaround, before any other `require`:
    ```js
    // File broker (module sandbox part 2): patch fs before anything else
    // loads, so nothing in this worker holds an unbrokered fs.
    const fsBridge = (require('worker_threads').workerData || {}).fsBridge;
    if (fsBridge != null) require('./fs-broker/patch').install(require('./fs-broker/client').createClient(fsBridge));
    ```
    and in `set-options`, next to the console silencing: `require('./fs-broker/patch').setConsoleSilenced(options.debug !== true);`.
  - `lib/module-manager.js` `spawnModuleWorker`: after the sandbox block, wrap the rest of the function body (from `const worker = new Worker(` to the end) in `const startWorker = (fsb) => { … };`, and inside it:
    - create the worker with `Object.assign({}, sandbox != null ? sandbox.workerOptions : {}, {workerData: {fsBridge: fsb.bridge.transfer}, transferList: fsb.bridge.transferList})`;
    - right after, `worker.once('exit', () => { fsb.bridge.close().catch((e) => LOG.E(e)); });`;
    - pass `{busy: () => fsb.bridge.syncInFlight() > 0}` as the fourth argument of `workerLimits.watch`.
    Then end `spawnModuleWorker` with:
    ```js
    require('./fs-broker').createForWorker({name: name, mode: options.moduleSandbox, modulePath: modulePath,
      declared: sandbox != null ? sandbox.fs : [], options: options,
      report: (rule, target) => LOG.I(`module sandbox: ${name} file ${rule} ${target}`)
    }).then(startWorker, (e) => callback(new CHError('LOAD_MODULE_FAIL', name, `file broker: ${e.message}`)));
    ```
  - `framework.js`: guard the `file broker:` line with `if (options.workerThread === true)`, and change `test/fs-broker/04-scheduler.js`'s startup test to pass `--workerThread` instead of `--no-workerThread`.
  - Sweep: `grep -n "moduleSandbox !== 'off'\|sandbox != null\|sandbox == null" lib/*.js` and confirm none of those branches is something the broker needs under `off` (the broker is created for every worker regardless of `sandbox`; the heartbeat watcher only runs with limits, i.e. not under `off`, which is part 1's behaviour and fine). Write what you found in the ledger.

- [ ] **Step 4: Run the tests** (tell the reviewer first)

Run: `npx mocha test/sandbox/11-heartbeat.js && npx mocha --exit test/fs-broker/*.js && npx mocha --exit test/fs-broker/09-wired.js`
Expected: all passing.

- [ ] **Step 5: Run the suites most affected by every worker now patching `fs`** (one at a time, telling the reviewer)

Run: `npx mocha --exit test/sandbox/*.js`, then `npx mocha --exit test/composition/*.js`, then `npx mocha test/module-loading/*.js test/auth/*.js`
Expected: all passing. Note worker start-up time in the ledger (the loader now reads code through the bridge until plan 3): compare the `countinghouse ready` time of `09-wired`'s server before and after this task (`git stash` the task to measure the baseline).

- [ ] **Step 6: Commit**

```bash
git add lib/fs-broker/index.js lib/sandbox.js lib/module-manager.js lib/module-sandbox-config.js lib/worker-limits.js framework.js test/fixtures/fs-probe test/fs-broker/09-wired.js test/fs-broker/04-scheduler.js test/sandbox/11-heartbeat.js
git commit -m "feat(fs-broker): every module worker's fs goes through its broker" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: CHANGELOG, full suite, hand-off

- [ ] **Step 1: CHANGELOG.** Under `## Unreleased`, a new section `### Added — module sandbox, part 2 (in progress)` with: "**File access from module workers goes through the main thread**, in every `--moduleSandbox` mode under `--workerThread`: `fs` is patched before any module code loads, and a per-worker broker answers every call. Each module gets private `/data` and `/tmp` directories under the new **`--moduleDataPath`** (default `$HOME/countinghouse_module_data`). The file checks are not enforced yet; until they are, `enforce` behaves like `audit` for files." and, under `### Changed — 8.0.0 platform`: "`UV_THREADPOOL_SIZE` defaults to 16 (set it yourself to override)." Plan 5 rewrites these into the final upgrade section.
- [ ] **Step 2:** Tell the reviewer, then run the full suite: `npm test > .superpowers/part2-plan2b-suite.log 2>&1; echo "exit=$?" >> .superpowers/part2-plan2b-suite.log` (about 35 minutes or more; keep the machine idle). Expected: `exit=0`. A failure goes to the reviewer with its output and your diagnosis before any fix.
- [ ] **Step 3:** Commit the CHANGELOG, send the reviewer the plan's commit range and the suite result, and write plan 3.
