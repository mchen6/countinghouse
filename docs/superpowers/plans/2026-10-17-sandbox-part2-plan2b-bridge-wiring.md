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
- Special files (review F1, I2): **every** open adds `O_NONBLOCK` (no effect on regular files on Linux), with string flags converted through a complete table; after opening, a descriptor that is not a regular file or directory (FIFO, socket, device) is `EPERM` under live `enforce`, otherwise reported (`special`) and kept, already non-blocking. `copyFile` (and `cp`, built on it) refuses a source that is not a regular file with `EPERM` in **every** mode — it protects the main thread, it is not policy. A `readdir` returns at most 100 000 entries, recursive included, then `ENOBUFS` (review I5).
- The module's lock is taken before a scheduler slot is requested; lock waiters never hold slots (review M6).
- **Interim until plan 3 (review K1), removed there:** the worker patch serves paths whose real location is inside the module's own install directory or countinghouse's (`workerData.hostRoots`) with the original `fs`, before anything reaches the broker — the loader and countinghouse's worker code still name files by host path, and a host path under `/app`, `/data` or `/tmp` would otherwise be remapped into the module's roots (countinghouse installed at `/app`, a module loaded from `/tmp`). Descriptors from the original `fs` are tracked and routed back to it; broker descriptors are shown to module code above `FD_BASE = 0x10000000`, so the two never collide. Plan 3 replaces this with its per-target grant.
- A data directory that cannot be created fails the load with `cannot create the module data directory <path>: … -- set --moduleDataPath to a writable directory` (review I6). Two spawns of one module can overlap (supervisor restart against an operator load) and briefly share a data directory; plan 4's per-name lifecycle lock closes that (ledgered).
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

### Task 1: Broker additions — scheduling, `readFile`, special files, listing cap

**Files:**
- Modify: `lib/fs-broker/broker.js`, `lib/fs-broker/errors.js`
- Create: `test/fs-broker/05-broker-2b.js`

**Interfaces:**
- Consumes: plan 2a's `FsBroker`, `OPS`.
- Produces: `FsBroker` options `schedule(fn: () => Promise) → Promise` (default runs `fn` directly) and `maxEntries` (default 100 000); new op `readFile(path, flag) → Buffer` (whole file; `EFBIG` past 16 MB so the worker falls back to chunked reads); `open` always non-blocking with a post-open special-file check; `copyFile` copying through descriptors.

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
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  const reports = [];
  const ns = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
  await ns.prepare();
  const broker = new FsBroker(Object.assign({name: 'm', mode: mode, namespace: ns, cwd: '/',
    report: (r, t) => reports.push(`${r} ${t}`), enforceFileDecisions: true}, extra || {}));
  return {base, dirs, broker, reports, done: () => broker.closeAll().then(() => fs.rmSync(base, {recursive: true, force: true}))};
}

const quick = async(fn) => {
  const t0 = Date.now();
  let out;
  try { out = {ok: await fn()}; } catch (e) { out = {code: e.code}; }
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  return out;
};

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

  it('enforce: a FIFO is EPERM, without blocking', async () => {
    const t = await setup('enforce');
    try {
      execFileSync('mkfifo', [path.join(t.dirs.data, 'pipe')]);
      assert.deepStrictEqual(await quick(() => t.broker.handle('open', ['/data/pipe', 'r'])), {code: 'EPERM'});
      assert.strictEqual(t.broker.fds.size, 0);
    } finally { await t.done(); }
  });

  it('audit: a FIFO is reported and opened without blocking, whatever the flags', async () => {
    const t = await setup('audit');
    try {
      execFileSync('mkfifo', [path.join(t.dirs.data, 'pipe')]);
      const r = await quick(() => t.broker.handle('open', ['/data/pipe', 'r']));
      await t.broker.handle('close', [r.ok]);
      const as = await quick(() => t.broker.handle('open', ['/data/pipe', 'as']));
      assert.ok(as.ok != null || as.code === 'ENXIO', JSON.stringify(as));   // no reader: ENXIO at once
      assert.ok(t.reports.includes('special /data/pipe'), t.reports.join('\n'));
    } finally { await t.done(); }
  });

  it('copyFile refuses a FIFO source in every mode, without blocking', async () => {
    for (const mode of ['off', 'audit', 'enforce']) {
      const t = await setup(mode);
      try {
        execFileSync('mkfifo', [path.join(t.dirs.data, 'pipe')]);
        assert.deepStrictEqual(await quick(() => t.broker.handle('copyFile', ['/data/pipe', '/data/copy'])), {code: 'EPERM'}, mode);
      } finally { await t.done(); }
    }
  });

  it('copyFile copies content and honours COPYFILE_EXCL', async () => {
    const t = await setup('enforce');
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'a'), 'abc');
      await t.broker.handle('copyFile', ['/data/a', '/data/b', 0]);
      assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, 'b'), 'utf8'), 'abc');
      await assert.rejects(t.broker.handle('copyFile', ['/data/a', '/data/b', fs.constants.COPYFILE_EXCL]), (e) => e.code === 'EEXIST' && e.path === '/data/a');
    } finally { await t.done(); }
  });

  it('a listing past maxEntries is ENOBUFS, recursive or not', async () => {
    const t = await setup('enforce', {maxEntries: 3});
    try {
      fs.mkdirSync(path.join(t.dirs.data, 'sub'));
      ['a', 'b', 'sub/c', 'sub/d'].forEach((f) => fs.writeFileSync(path.join(t.dirs.data, f), 'x'));
      assert.strictEqual((await t.broker.handle('readdir', ['/data', {}])).length, 3);
      await assert.rejects(t.broker.handle('readdir', ['/data', {recursive: true}]), (e) => e.code === 'ENOBUFS');
      fs.writeFileSync(path.join(t.dirs.data, 'e'), 'x');
      await assert.rejects(t.broker.handle('readdir', ['/data', {}]), (e) => e.code === 'ENOBUFS');
    } finally { await t.done(); }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx mocha --timeout 5000 test/fs-broker/05-broker-2b.js`
Expected: FAIL — `schedule` is never called, `readFile` is `EINVAL`, the FIFO tests block until the timeout, `copyFile` from a FIFO blocks, listings are not capped.

- [ ] **Step 3: Implement** in `lib/fs-broker/broker.js`:
  - Constructor: `this.schedule = opts.schedule || ((fn) => fn());` and `this.maxEntries = opts.maxEntries || 100000;`.
  - `handle`: replace both `spec.run.call(this, a)` calls with `this.schedule(() => spec.run.call(this, a))`, so a scheduler slot is requested only after the lock is held.
  - Replace `openFlags` with a complete flag table and a numeric form:
    ```js
    // Node's string flags (lib/internal/fs/utils.js stringToFlags), as a table.
    const FLAG_TABLE = {
      r: 'O_RDONLY', rs: 'O_RDONLY|O_SYNC', sr: 'O_RDONLY|O_SYNC', 'r+': 'O_RDWR', 'rs+': 'O_RDWR|O_SYNC', 'sr+': 'O_RDWR|O_SYNC',
      w: 'O_TRUNC|O_CREAT|O_WRONLY', wx: 'O_TRUNC|O_CREAT|O_WRONLY|O_EXCL', xw: 'O_TRUNC|O_CREAT|O_WRONLY|O_EXCL',
      'w+': 'O_TRUNC|O_CREAT|O_RDWR', 'wx+': 'O_TRUNC|O_CREAT|O_RDWR|O_EXCL', 'xw+': 'O_TRUNC|O_CREAT|O_RDWR|O_EXCL',
      a: 'O_APPEND|O_CREAT|O_WRONLY', ax: 'O_APPEND|O_CREAT|O_WRONLY|O_EXCL', xa: 'O_APPEND|O_CREAT|O_WRONLY|O_EXCL',
      as: 'O_APPEND|O_CREAT|O_WRONLY|O_SYNC', sa: 'O_APPEND|O_CREAT|O_WRONLY|O_SYNC',
      'a+': 'O_APPEND|O_CREAT|O_RDWR', 'ax+': 'O_APPEND|O_CREAT|O_RDWR|O_EXCL', 'xa+': 'O_APPEND|O_CREAT|O_RDWR|O_EXCL',
      'as+': 'O_APPEND|O_CREAT|O_RDWR|O_SYNC', 'sa+': 'O_APPEND|O_CREAT|O_RDWR|O_SYNC'
    };
    function numericFlags(flags) {
      if (typeof(flags) === 'number') return flags;
      const spec = FLAG_TABLE[flags == null ? 'r' : String(flags)];
      if (spec == null) throw nodeError('EINVAL', 'open');
      return spec.split('|').reduce((n, k) => n | fs.constants[k], 0);
    }
    function openFlags(flags) {
      const n = numericFlags(flags);
      const c = fs.constants;
      return {
        writes: (n & (c.O_WRONLY | c.O_RDWR | c.O_CREAT | c.O_TRUNC | c.O_APPEND)) !== 0,
        creates: (n & (c.O_CREAT | c.O_TRUNC | c.O_EXCL)) !== 0
      };
    }
    ```
  - `OPS.open.run`: open with `numericFlags(a[1]) | fs.constants.O_NONBLOCK`, and after `verifyOpened` add:
    ```js
    // Every open is non-blocking, so a FIFO, socket or device cannot block a
    // pool thread at open; what it turned out to be decides the rest (review I2).
    const st = await fh.stat();
    if (!st.isFile() && !st.isDirectory()) {
      this.report('special', p.virtual);
      if (this.enforce) { await fh.close().catch(() => {}); throw nodeError('EPERM', 'open', p.virtual); }
    }
    ```
  - `OPS.copyFile.run`, replacing `fsp.copyFile` (which opens the source inside libuv, where a FIFO would block):
    ```js
    copyFile: {lock: EXCL, async run(a) {
      const from = await this.place(a[0], 'r', 'copyfile');
      const to = await this.place(a[1], 'w', 'copyfile');
      const c = fs.constants;
      const excl = (Number(a[2] || 0) & c.COPYFILE_EXCL) !== 0;
      let src = null;
      let dst = null;
      try {
        src = await fsp.open(from.host, c.O_RDONLY | c.O_NONBLOCK).catch((e) => { throw rewrite(e, 'copyfile', from, to, this.ns); });
        const st = await src.stat();
        // every mode: a FIFO or device source would block a pool thread
        if (!st.isFile()) throw nodeError('EPERM', 'copyfile', from.virtual, to.virtual);
        await this.verifyOpened(src, from, 'copyfile', false);
        dst = await fsp.open(to.host, c.O_WRONLY | c.O_CREAT | c.O_TRUNC | c.O_NONBLOCK | (excl ? c.O_EXCL : 0), st.mode & 0o777)
          .catch((e) => { throw rewrite(e, 'copyfile', from, to, this.ns); });
        await this.verifyOpened(dst, to, 'copyfile', true);
        const buf = Buffer.alloc(1024 * 1024);
        for (;;) {
          const r = await src.read(buf, 0, buf.length, null);
          if (r.bytesRead === 0) break;
          await dst.write(buf, 0, r.bytesRead);
        }
      } finally {
        if (src) await src.close().catch(() => {});
        if (dst) await dst.close().catch(() => {});
      }
    }},
    ```
  - `OPS.readdir.run`: cap the entries. Non-recursive: after `fsp.readdir`, `if (list.length > this.maxEntries) throw nodeError('ENOBUFS', 'scandir', p.virtual);`. Recursive: replace `fsp.readdir(..., {recursive: true})` with a breadth-first walk of non-recursive `fsp.readdir(dir, {withFileTypes: true})` calls that throws `ENOBUFS` as soon as the count passes `this.maxEntries`, producing `{name, type, parentPath: this.out(dir, p)}` entries (with types) or relative names `sub/x` (without), in the order Node uses (each directory's entries, then its subdirectories).
  - New op `readFile`, after `open`:
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
  - `lib/fs-broker/errors.js` `TEXT`: add `EFBIG: 'file too large', ENOBUFS: 'no buffer space available', ENXIO: 'no such device or address'`.

- [ ] **Step 4: Run the tests**

Run: `npx mocha test/fs-broker/05-broker-2b.js test/fs-broker/03-broker.js`
Expected: all passing (8 new, 25 from plan 2a).

- [ ] **Step 5: Commit**

```bash
git add lib/fs-broker/broker.js lib/fs-broker/errors.js test/fs-broker/05-broker-2b.js
git commit -m "feat(fs-broker): scheduling hook, readFile, non-blocking opens, special files, listing cap" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
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
const {Worker, receiveMessageOnPort} = require('worker_threads');
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
      if (this.worker) throw new Error('one run() per harness: a bridge\'s ports can be transferred once');
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

  it('a call past the broker deadline gets ETIMEDOUT; the late reply is discarded and the next call in the same worker gets its own', async () => {
    const h = await harness({deadlineMs: 200,
      hooks: {afterCheck: (syscall, host) => (host.endsWith('/slow') ? new Promise((r) => setTimeout(r, 400)) : null)}});
    try {
      fs.writeFileSync(path.join(h.dirs.data, 'ok'), 'fine');
      const m = await h.run(`
        let code = null;
        try { client.sync('stat', ['/data/slow']); } catch (e) { code = e.code; }
        await new Promise((r) => setTimeout(r, 400));   // the slow call's late reply lands meanwhile
        let second;
        try { second = Buffer.from(client.sync('readFile', ['/data/ok', 'r'])).toString(); } catch (e) { second = e.code; }
        return {code, second};`);
      assert.deepStrictEqual(m, {ok: true, r: {code: 'ETIMEDOUT', second: 'fine'}});
    } finally { await h.done(); }
  });

  it('refuses a second sync request while one is in flight (a waiting worker cannot send two)', async () => {
    const h = await harness({hooks: {afterCheck: (syscall, host) => (host.endsWith('/wait') ? new Promise((r) => setTimeout(r, 300)) : null)}});
    try {
      const port = h.bridge.transfer.syncPort;
      port.postMessage({id: 1, op: 'stat', args: ['/data/wait']});
      port.postMessage({id: 2, op: 'stat', args: ['/data']});
      await new Promise((r) => setTimeout(r, 700));
      const got = [];
      let msg;
      while ((msg = receiveMessageOnPort(port)) !== undefined) got.push(msg.message);
      assert.deepStrictEqual(got.find((x) => x.id === 2).error.code, 'EIO', JSON.stringify(got));
      assert.strictEqual(got.find((x) => x.id === 1).error.code, 'ENOENT');
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
    // A worker waiting on a sync call cannot send another; a second one in
    // flight is not a real wait, and must not extend the heartbeat exemption.
    if (inFlight > 0) return reply(syncCh.port1, m.id, false, nodeError('EIO', m.op), true);
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
Expected: 7 passing. No stray worker threads (mocha exits).

- [ ] **Step 6: Commit**

```bash
git add lib/fs-broker/client.js lib/fs-broker/server.js test/fs-broker/06-bridge.js
git commit -m "feat(fs-broker): the bridge between module workers and their broker" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The worker patch

**Files:**
- Create: `lib/fs-broker/patch.js`, `test/helpers/brokered-worker.js`, `test/helpers/brokered-worker-entry.js`, `test/fs-broker/scripts/keys.js`, `test/fs-broker/scripts/behaviour.js`, `test/fs-broker/scripts/k1.js`, `test/fs-broker/07-patch.js`

**Interfaces:**
- Consumes: `createClient` (Task 2), `createBridge`, `FsBroker` with `schedule` and `readFile` (Task 1).
- Produces: `require('./fs-broker/patch')` → `{install(client, {hostRoots?, consoleWrite?}) → handled: {fs: Set, promises: Set, fileHandle: Set}, setConsoleSilenced(boolean), PASSTHROUGH: {fs: [...], promises: [...]}, FD_BASE}`.
- Produces (tests): `runBrokered(scriptPath, {patch = true, mode = 'audit', files = {}}) → Promise<{ok, r} | {ok: false, e}>` in `test/helpers/brokered-worker.js`. With `patch`, the script runs in a worker whose `fs` is patched against a broker over a fresh tree and gets `root = '/data'`; without, the same script runs in a plain worker with `root` = the tree's real data directory. `files` are written into the data directory first. The script is `module.exports = async (fs, root, ctx) => result`, `ctx = {handled, patch, realFileHandleKeys, consoleLines, extra}`; options `hostRoots` (default: the repo's real path) and `extra` (passed to the script).

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
  ctx.extra = workerData.extra || {};
  if (workerData.fsBridge != null) {
    ctx.patch = require(path.join(LIB, 'patch'));
    ctx.handled = ctx.patch.install(require(path.join(LIB, 'client')).createClient(workerData.fsBridge),
      {hostRoots: workerData.hostRoots, consoleWrite: (fd, buf) => ctx.consoleLines.push(`${fd}:${Buffer.from(buf).toString()}`)});
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
  // hostRoots: the repo by default, so the script itself loads by host path (review K1)
  const data = {script: script, root: dirs.data, fsBridge: null, extra: opts.extra || {},
    hostRoots: opts.hostRoots != null ? opts.hostRoots : [fs.realpathSync(REPO)]};
  let transferList = [];
  if (usePatch) {
    const ns = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
    await ns.prepare();
    const scheduler = new FsScheduler({globalCap: 3});
    const broker = new FsBroker({name: 't', mode: opts.mode || 'audit', namespace: ns, cwd: process.cwd(), report: () => {},
      schedule: (fn) => scheduler.submit('t', fn)});
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
  const fh2 = await fsp.open(j('h.txt'), 'r');
  out.fhStream = await new Promise((r, x) => { let s = ''; fh2.createReadStream({encoding: 'utf8'}).on('data', (c) => { s += c; }).on('end', () => r(s)).on('error', x); });
  await fh2.close();
  out.noEntry = fs.statSync(j('missing'), {throwIfNoEntry: false}) === undefined;
  out.fsync1 = fs.fsyncSync(1) === undefined;
  const rfd = fs.openSync(j('a.txt'), 'r');
  out.brokerFd = rfd >= ctx.patch.FD_BASE;
  try { fs.readSync(rfd, Buffer.alloc(2), 0, 5, 0); } catch (e) { out.readRange = e.code; }
  fs.closeSync(rfd);
  out.globAbs = fs.globSync(`${root}/d/**/*.txt`).sort();
  const big = Buffer.alloc(17 * 1024 * 1024, 1);
  fs.writeFileSync(j('big.bin'), big);
  out.bigRead = fs.readFileSync(j('big.bin')).length;
  return out;
};
```

`test/fs-broker/scripts/k1.js`:

```js
// Reads a file by host path, by name and through a descriptor.
module.exports = async (fs, root, ctx) => {
  const fd = fs.openSync(ctx.extra.file, 'r');
  const b = Buffer.alloc(4);
  fs.readSync(fd, b, 0, 4, 0);
  fs.closeSync(fd);
  return {content: fs.readFileSync(ctx.extra.file, 'utf8'), viaFd: b.toString()};
};
```

`test/fs-broker/07-patch.js`:

```js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
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
    assert.strictEqual(r.fhStream, 'handle');
    assert.strictEqual(r.noEntry, true);
    assert.strictEqual(r.fsync1, true);
    assert.strictEqual(r.brokerFd, true);
    assert.strictEqual(r.readRange, 'ERR_OUT_OF_RANGE');
    assert.deepStrictEqual(r.globAbs, ['/data/d/e/f.txt']);
  });

  // Review K1: a host path under /tmp (a module loaded from there, say) is the
  // virtual /tmp unless it lies inside a host root.
  it('serves host paths inside the host roots with the original fs, until plan 3', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-k1-')));
    try {
      const file = path.join(dir, 'f');
      fs.writeFileSync(file, 'host');
      const served = await runBrokered(S('k1.js'), {hostRoots: [dir], extra: {file}});
      assert.deepStrictEqual(served, {ok: true, r: {content: 'host', viaFd: 'host'}});
      const remapped = await runBrokered(S('k1.js'), {hostRoots: [fs.realpathSync(path.join(__dirname, '..', '..'))], extra: {file}});
      assert.strictEqual(remapped.ok, false);
      assert.strictEqual(remapped.e.code, 'ENOENT');
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx mocha --exit test/fs-broker/07-patch.js`
Expected: FAIL, `Cannot find module '…/lib/fs-broker/patch'` reported by the worker.

- [ ] **Step 4: Implement** — `lib/fs-broker/patch.js` (the whole file: three forms per operation from `define()`, Node's argument shapes for descriptors including `ERR_OUT_OF_RANGE`, `throwIfNoEntry`, the `EFBIG` fallback to chunked reads, fds 1/2 to the console (writes) or no-ops (`close`/`fsync`/`fdatasync`), a FileHandle closed on garbage collection, `cp` with Node's `force`/`errorOnExist` semantics and `ERR_FS_CP_EINVAL`, a level-by-level `glob` with absolute patterns, and the interim host routing from review K1):

```js
// Module worker side of the file broker (docs/superpowers/specs/2026-10-17-
// module-sandbox-fs-broker-design.md, section 2): replaces every method of
// the shared fs, fs/promises and FileHandle objects, before any countinghouse
// or dependency code loads, with versions that ask the main thread's broker.
// Sync calls go over the blocking bridge, callback and promise calls over the
// async channel (lib/fs-broker/client.js). Anything not handled here throws,
// so a method a later Node adds fails closed (test/fs-broker/07-patch.js).
//
// Interim until plan 3 (review K1): paths whose real location is inside the
// module's install directory or countinghouse's (settings.hostRoots) are
// served by the original fs, as before this patch, because the loader and
// countinghouse's worker code still name files by host path. Plan 3 replaces
// this with its per-target grant and deletes hostServed().
const fs = require('fs');
const fsp = require('fs/promises');
const pathMod = require('path');
const url = require('url');
const {EventEmitter} = require('events');

const MAX_IO = 16 * 1024 * 1024;
// Broker descriptors are shown to module code above FD_BASE, so they never
// collide with real descriptors from the original fs (hostServed paths).
const FD_BASE = 0x10000000;
const STATS_PROTO = Object.getPrototypeOf(fs.statSync(__filename));
const BIGINT_STATS_PROTO = Object.getPrototypeOf(fs.statSync(__filename, {bigint: true}));
const DIRENT_TYPE = {file: fs.constants.UV_DIRENT_FILE, dir: fs.constants.UV_DIRENT_DIR,
  symlink: fs.constants.UV_DIRENT_LINK, other: fs.constants.UV_DIRENT_UNKNOWN};
const toUnixTimestamp = fs._toUnixTimestamp;
const GLOB_CHARS = /[*?[\]{}!]/;

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

function outOfRange(name, value) {
  const err = new RangeError(`The value of "${name}" is out of range. Received ${value}`);
  err.code = 'ERR_OUT_OF_RANGE';
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

function cpError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function install(client, settings) {
  settings = settings || {};
  const sync = client.sync;
  const call = client.async;
  const consoleWrite = settings.consoleWrite || ((fd, buf) => (fd === 1 ? process.stdout : process.stderr).write(buf));
  const hostRoots = (settings.hostRoots || []).map(String);
  const origFs = Object.assign({}, fs);
  const origFsp = Object.assign({}, fsp);
  const realFds = new Set();
  const handled = {fs: new Set(), promises: new Set(), fileHandle: new Set()};

  const toBroker = (fd) => (typeof(fd) === 'number' && fd >= FD_BASE ? fd - FD_BASE : -1);
  const fromBroker = (fd) => fd + FD_BASE;

  function hostServed(v) {
    if (hostRoots.length === 0) return false;
    let s;
    try { s = p(v); } catch (e) { return false; }
    if (s.startsWith('file:')) { try { s = url.fileURLToPath(s); } catch (e) { return false; } }
    const abs = pathMod.resolve(s);
    let real;
    try {
      real = origFs.realpathSync(abs);
    } catch (e) {
      try { real = pathMod.join(origFs.realpathSync(pathMod.dirname(abs)), pathMod.basename(abs)); } catch (e2) { return false; }
    }
    return hostRoots.some((r) => real === r || real.startsWith(`${r}/`));
  }

  function callOrig(key, orig, a) {
    if (key === 'openSync') { const fd = orig.apply(fs, a); realFds.add(fd); return fd; }
    if (key === 'open' && typeof(a[a.length - 1]) === 'function') {
      const cb = a[a.length - 1];
      a[a.length - 1] = (e, fd) => { if (!e) realFds.add(fd); cb(e, fd); };
    }
    if (key === 'closeSync' || key === 'close') realFds.delete(a[0]);
    return orig.apply(fs, a);
  }

  // route: {paths: [argIndex...], fd: argIndex} -- when every listed path is
  // host-served, or the descriptor came from the original fs, call the original.
  function routed(obj, key, value, route) {
    if (route == null) return value;
    const orig = (obj === fs ? origFs : origFsp)[key];
    if (typeof(orig) !== 'function') return value;
    return function(...a) {
      if (route.fd != null && typeof(a[route.fd]) === 'number' && realFds.has(a[route.fd])) return callOrig(key, orig, a);
      if (route.paths != null && route.paths.length > 0 && route.paths.every((i) => a[i] != null && typeof(a[i]) !== 'number' && hostServed(a[i]))) {
        return obj === fs ? callOrig(key, orig, a) : orig.apply(fsp, a);
      }
      return value.apply(this, a);
    };
  }

  function lock(obj, key, value, set, route) {
    Object.defineProperty(obj, key, {value: routed(obj, key, value, route), writable: false, configurable: false, enumerable: true});
    set.add(key);
  }

  // One operation, three forms. spec: {args(...a) -> [op, args], out(result, ...a) -> value,
  // route, noEntry (index of an options argument honouring throwIfNoEntry), consoleNoop}
  function define(name, spec) {
    const syncName = `${name}Sync`;
    const syncFn = function(...a) {
      if (spec.consoleNoop && (a[0] === 1 || a[0] === 2)) return undefined;
      try {
        return spec.out(sync(...spec.args(...a)), ...a);
      } catch (e) {
        if (spec.noEntry != null && e.code === 'ENOENT' && a[spec.noEntry] != null && a[spec.noEntry].throwIfNoEntry === false) return undefined;
        throw e;
      }
    };
    const cbFn = function(...all) {
      const {args, cb} = splitCb(all);
      if (spec.consoleNoop && (args[0] === 1 || args[0] === 2)) return process.nextTick(cb, null);
      let req;
      try { req = spec.args(...args); } catch (e) { return process.nextTick(cb, e); }
      call(...req).then((r) => cb(null, spec.out(r, ...args)), (e) => cb(e));
    };
    const promiseFn = async function(...a) { return spec.out(await call(...spec.args(...a)), ...a); };
    if (spec.native) { syncFn.native = syncFn; cbFn.native = cbFn; }
    if (spec.sync !== false) lock(fs, syncName, syncFn, handled.fs, spec.route);
    if (spec.callback !== false) lock(fs, name, cbFn, handled.fs, spec.route);
    if (spec.promise !== false) lock(fsp, name, promiseFn, handled.promises, spec.route);
  }

  const none = () => undefined;
  const P0 = {paths: [0]};
  const P01 = {paths: [0, 1]};
  const P1 = {paths: [1]};
  const F0 = {fd: 0};
  const bfd = (fd) => toBroker(fd);

  define('access', {args: (path, m) => ['access', [p(path), m]], out: none, route: P0});
  define('stat', {args: (path, o) => ['stat', [p(path), opts(o)]], out: stats, route: P0, noEntry: 1});
  define('lstat', {args: (path, o) => ['lstat', [p(path), opts(o)]], out: stats, route: P0, noEntry: 1});
  define('fstat', {args: (fd, o) => ['fstat', [bfd(fd), opts(o)]], out: stats, promise: false, route: F0});
  define('statfs', {args: (path, o) => ['statfs', [p(path), opts(o)]], out: (r) => r, route: P0});
  define('realpath', {args: (path) => ['realpath', [p(path)]], out: (r, path, o) => str(r, opts(o).encoding), native: true, route: P0});
  define('readlink', {args: (path) => ['readlink', [p(path)]], out: (r, path, o) => str(r, opts(o).encoding), route: P0});
  define('readdir', {
    args: (path, o) => { const x = opts(o); return ['readdir', [p(path), {withFileTypes: !!x.withFileTypes, recursive: !!x.recursive}]]; },
    out: (r, path, o) => { const x = opts(o); return x.withFileTypes ? r.map(dirent) : r.map((n) => str(n, x.encoding)); },
    route: P0
  });
  define('mkdir', {args: (path, o) => { const x = (typeof(o) === 'object' && o != null) ? o : {mode: o}; return ['mkdir', [p(path), {recursive: !!x.recursive, mode: mode(x.mode, 0o777)}]]; }, out: (r) => r, route: P0});
  define('mkdtemp', {args: (prefix) => ['mkdtemp', [p(prefix, 'prefix')]], out: (r, prefix, o) => str(r, opts(o).encoding), route: P0});
  define('rmdir', {args: (path, o) => ['rmdir', [p(path), o]], out: none, route: P0});
  define('rm', {args: (path, o) => ['rm', [p(path), opts(o)]], out: none, route: P0});
  define('unlink', {args: (path) => ['unlink', [p(path)]], out: none, route: P0});
  define('rename', {args: (a, b) => ['rename', [p(a, 'oldPath'), p(b, 'newPath')]], out: none, route: P01});
  define('copyFile', {args: (a, b, m) => ['copyFile', [p(a, 'src'), p(b, 'dest'), m]], out: none, route: P01});
  define('link', {args: (a, b) => ['link', [p(a, 'existingPath'), p(b, 'newPath')]], out: none, route: P01});
  define('symlink', {args: (target, path, type) => ['symlink', [p(target, 'target'), p(path), type]], out: none, route: P1});
  define('chmod', {args: (path, m) => ['chmod', [p(path), mode(m)]], out: none, route: P0});
  define('chown', {args: (path, uid, gid) => ['chown', [p(path), uid, gid]], out: none, route: P0});
  define('lchown', {args: (path, uid, gid) => ['lchown', [p(path), uid, gid]], out: none, route: P0});
  define('utimes', {args: (path, at, mt) => ['utimes', [p(path), toUnixTimestamp(at), toUnixTimestamp(mt)]], out: none, route: P0});
  define('lutimes', {args: (path, at, mt) => ['lutimes', [p(path), toUnixTimestamp(at), toUnixTimestamp(mt)]], out: none, route: P0});
  define('truncate', {args: (path, len) => (typeof(path) === 'number' ? ['ftruncate', [bfd(path), len || 0]] : ['truncate', [p(path), len || 0]]), out: none, route: {paths: [0], fd: 0}});
  define('open', {args: (path, flags, m) => ['open', [p(path), flags == null ? 'r' : flags, mode(m, 0o666)]], out: fromBroker, promise: false, route: P0});
  define('close', {args: (fd) => ['close', [bfd(fd)]], out: none, promise: false, route: F0, consoleNoop: true});
  define('fsync', {args: (fd) => ['fsync', [bfd(fd)]], out: none, promise: false, route: F0, consoleNoop: true});
  define('fdatasync', {args: (fd) => ['fdatasync', [bfd(fd)]], out: none, promise: false, route: F0, consoleNoop: true});
  define('ftruncate', {args: (fd, len) => ['ftruncate', [bfd(fd), len || 0]], out: none, promise: false, route: F0});
  define('fchmod', {args: (fd, m) => ['fchmod', [bfd(fd), mode(m)]], out: none, promise: false, route: F0});
  define('fchown', {args: (fd, uid, gid) => ['fchown', [bfd(fd), uid, gid]], out: none, promise: false, route: F0});
  define('futimes', {args: (fd, at, mt) => ['futimes', [bfd(fd), toUnixTimestamp(at), toUnixTimestamp(mt)]], out: none, promise: false, route: F0});

  // exists: the callback gets one argument, a boolean.
  lock(fs, 'existsSync', (path) => { try { return sync('exists', [p(path)]); } catch (e) { return false; } }, handled.fs, P0);
  lock(fs, 'exists', (path, cb) => {
    let req;
    try { req = p(path); } catch (e) { return process.nextTick(cb, false); }
    call('exists', [req]).then((r) => cb(r), () => cb(false));
  }, handled.fs, P0);

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
    if (offset < 0 || offset > buffer.byteLength) throw outOfRange('offset', offset);
    length = (length == null) ? buffer.byteLength - offset : length;
    if (length < 0 || length > buffer.byteLength - offset) throw outOfRange('length', length);
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
      done += sync('write', [bfd(fd), chunk, position == null ? null : position + done]);
    }
    return done;
  }
  async function writeChunksAsync(fd, buf, position) {
    if (fd === 1 || fd === 2) { if (!consoleSilenced) consoleWrite(fd, buf); return buf.length; }
    let done = 0;
    while (done < buf.length) {
      const chunk = buf.subarray(done, done + MAX_IO);
      done += await call('write', [bfd(fd), chunk, position == null ? null : position + done]);
    }
    return done;
  }

  lock(fs, 'readSync', (fd, ...rest) => { const a = readArgs(fd, ...rest); return fillRead(sync('read', [bfd(fd), a.length, a.position]), a); }, handled.fs, F0);
  lock(fs, 'read', (fd, ...all) => {
    const {args, cb} = splitCb(all);
    let a;
    try { a = readArgs(fd, ...(args.length > 0 ? args : [{}])); } catch (e) { return process.nextTick(cb, e); }
    call('read', [bfd(fd), a.length, a.position]).then((r) => cb(null, fillRead(r, a), a.buffer), (e) => cb(e));
  }, handled.fs, F0);
  lock(fs, 'writeSync', (fd, ...rest) => { const w = writeArgs(fd, ...rest); return writeChunks(fd, w.buf, w.position); }, handled.fs, F0);
  lock(fs, 'write', (fd, data, ...all) => {
    const {args, cb} = splitCb(all);
    let w;
    try { w = writeArgs(fd, data, ...args); } catch (e) { return process.nextTick(cb, e); }
    writeChunksAsync(fd, w.buf, w.position).then((n) => cb(null, n, data), (e) => cb(e));
  }, handled.fs, F0);
  function vec(buffers) { return Buffer.concat(buffers.map((b) => toBuffer(b))); }
  lock(fs, 'writevSync', (fd, buffers, position) => writeChunks(fd, vec(buffers), position), handled.fs, F0);
  lock(fs, 'writev', (fd, buffers, ...all) => {
    const {args, cb} = splitCb(all);
    writeChunksAsync(fd, vec(buffers), args[0]).then((n) => cb(null, n, buffers), (e) => cb(e));
  }, handled.fs, F0);
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
  lock(fs, 'readvSync', (fd, buffers, position) => scatter(sync('read', [bfd(fd), total(buffers), position == null ? null : position]), buffers), handled.fs, F0);
  lock(fs, 'readv', (fd, buffers, ...all) => {
    const {args, cb} = splitCb(all);
    call('read', [bfd(fd), total(buffers), args[0] == null ? null : args[0]]).then((r) => cb(null, scatter(r, buffers), buffers), (e) => cb(e));
  }, handled.fs, F0);

  // Whole files: a path goes to the broker's readFile (one round trip, up to
  // 16 MB, chunked past it); a descriptor reads from its current position.
  function readAllFd(fd) {
    const parts = [];
    for (;;) {
      const r = Buffer.from(sync('read', [bfd(fd), MAX_IO, null]));
      if (r.length === 0) break;
      parts.push(r);
    }
    return Buffer.concat(parts);
  }
  async function readAllFdAsync(fd) {
    const parts = [];
    for (;;) {
      const r = Buffer.from(await call('read', [bfd(fd), MAX_IO, null]));
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
    const fd = fromBroker(sync('open', [p(path), x.flag, 0o666]));
    try { return enc(readAllFd(fd), x.encoding); } finally { sync('close', [bfd(fd)]); }
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
    const fd = fromBroker(await call('open', [p(path), x.flag, 0o666]));
    try { return enc(await readAllFdAsync(fd), x.encoding); } finally { await call('close', [bfd(fd)]); }
  }
  function writeFileSyncImpl(path, data, o, defFlag) {
    const x = opts(o, {flag: defFlag, mode: 0o666});
    const buf = toBuffer(data, x.encoding);
    if (typeof(path) === 'number') { writeChunks(path, buf, null); return; }
    const fd = fromBroker(sync('open', [p(path), x.flag, mode(x.mode)]));
    try { writeChunks(fd, buf, null); } finally { sync('close', [bfd(fd)]); }
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
    const fd = fromBroker(await call('open', [p(path), x.flag, mode(x.mode)]));
    try { await writeChunksAsync(fd, buf, null); } finally { await call('close', [bfd(fd)]); }
  }
  const FILE = {paths: [0], fd: 0};
  lock(fs, 'readFileSync', readFileSyncImpl, handled.fs, FILE);
  lock(fs, 'readFile', (path, ...all) => { const {args, cb} = splitCb(all); readFileImpl(path, args[0]).then((r) => cb(null, r), (e) => cb(e)); }, handled.fs, FILE);
  lock(fsp, 'readFile', readFileImpl, handled.promises, P0);
  lock(fs, 'writeFileSync', (path, data, o) => writeFileSyncImpl(path, data, o, 'w'), handled.fs, FILE);
  lock(fs, 'writeFile', (path, data, ...all) => { const {args, cb} = splitCb(all); writeFileImpl(path, data, args[0], 'w').then(() => cb(null), (e) => cb(e)); }, handled.fs, FILE);
  lock(fsp, 'writeFile', (path, data, o) => writeFileImpl(path, data, o, 'w'), handled.promises, P0);
  lock(fs, 'appendFileSync', (path, data, o) => writeFileSyncImpl(path, data, o, 'a'), handled.fs, FILE);
  lock(fs, 'appendFile', (path, data, ...all) => { const {args, cb} = splitCb(all); writeFileImpl(path, data, args[0], 'a').then(() => cb(null), (e) => cb(e)); }, handled.fs, FILE);
  lock(fsp, 'appendFile', (path, data, o) => writeFileImpl(path, data, o, 'a'), handled.promises, P0);

  // FileHandle (fs.promises.open). Like Node's own, one that is never closed
  // is closed when it is garbage-collected, with a warning (review M4).
  const unclosed = new FinalizationRegistry((fd) => {
    process.emitWarning('Closing a file handle on garbage collection (countinghouse file broker)');
    call('close', [bfd(fd)]).catch(() => {});
  });
  class BrokeredFileHandle extends EventEmitter {
    constructor(fd) { super(); this._fd = fd; unclosed.register(this, fd, this); }
    get fd() { return this._fd; }
    getAsyncId() { return -1; }
    async close() {
      if (this._fd < 0) return;
      const fd = this._fd;
      this._fd = -1;
      unclosed.unregister(this);
      await call('close', [bfd(fd)]);
      this.emit('close');
    }
    async [Symbol.asyncDispose]() { await this.close(); }
    async read(buffer, offset, length, position) {
      if (buffer == null || (!ArrayBuffer.isView(buffer) && typeof(buffer) === 'object')) {
        const o = buffer || {};
        buffer = o.buffer || Buffer.alloc(16384);
        offset = o.offset; length = o.length; position = o.position;
      }
      const a = readArgs(this._fd, buffer, offset, length, position);
      const n = fillRead(await call('read', [bfd(this._fd), a.length, a.position]), a);
      return {bytesRead: n, buffer: a.buffer};
    }
    async write(data, ...rest) { const w = writeArgs(this._fd, data, ...rest); return {bytesWritten: await writeChunksAsync(this._fd, w.buf, w.position), buffer: data}; }
    async readv(buffers, position) { return {bytesRead: scatter(await call('read', [bfd(this._fd), total(buffers), position == null ? null : position]), buffers), buffers}; }
    async writev(buffers, position) { return {bytesWritten: await writeChunksAsync(this._fd, vec(buffers), position), buffers}; }
    readFile(o) { return readFileImpl(this, o); }
    writeFile(data, o) { return writeFileImpl(this, data, o, 'w'); }
    appendFile(data, o) { return writeFileImpl(this, data, o, 'a'); }
    async stat(o) { return stats(await call('fstat', [bfd(this._fd), opts(o)])); }
    async truncate(len) { await call('ftruncate', [bfd(this._fd), len || 0]); }
    async sync() { await call('fsync', [bfd(this._fd)]); }
    async datasync() { await call('fdatasync', [bfd(this._fd)]); }
    async chmod(m) { await call('fchmod', [bfd(this._fd), mode(m)]); }
    async chown(uid, gid) { await call('fchown', [bfd(this._fd), uid, gid]); }
    async utimes(at, mt) { await call('futimes', [bfd(this._fd), toUnixTimestamp(at), toUnixTimestamp(mt)]); }
    createReadStream(o) { return fs.createReadStream(null, Object.assign({}, o, {fd: this._fd, autoClose: false})); }
    createWriteStream(o) { return fs.createWriteStream(null, Object.assign({}, o, {fd: this._fd, autoClose: false})); }
    readLines(o) { return require('readline').createInterface({input: this.createReadStream(o), crlfDelay: Infinity}); }
    readableWebStream() { return require('stream').Readable.toWeb(this.createReadStream()); }
  }
  Object.getOwnPropertyNames(BrokeredFileHandle.prototype).forEach((k) => handled.fileHandle.add(k));
  lock(fsp, 'open', async(path, flags, m) => new BrokeredFileHandle(fromBroker(await call('open', [p(path), flags == null ? 'r' : flags, mode(m, 0o666)]))), handled.promises, P0);

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
  lock(fs, 'opendirSync', (path, o) => makeDir(p(path), sync('readdir', [p(path), {withFileTypes: true, recursive: !!(o && o.recursive)}]).map(dirent)), handled.fs, P0);
  lock(fs, 'opendir', (path, ...all) => {
    const {args, cb} = splitCb(all);
    call('readdir', [p(path), {withFileTypes: true, recursive: !!(args[0] && args[0].recursive)}]).then((r) => cb(null, makeDir(p(path), r.map(dirent))), (e) => cb(e));
  }, handled.fs, P0);
  lock(fsp, 'opendir', async(path, o) => makeDir(p(path), (await call('readdir', [p(path), {withFileTypes: true, recursive: !!(o && o.recursive)}])).map(dirent)), handled.promises, P0);

  // cp: a recursive copy built on the primitives, so every step is checked.
  // Node's semantics: force overwrites (whatever errorOnExist says); without
  // force an existing destination is skipped, or an error with errorOnExist;
  // a destination inside the source is refused. A tree holding absolute
  // symlinks fails with EPERM under the link rules.
  function cpPlan(src, dest, o) {
    const plan = {src: pathMod.posix.resolve(p(src, 'src')), dest: pathMod.posix.resolve(p(dest, 'dest')), o: Object.assign({force: true, recursive: false}, o || {})};
    if (plan.dest === plan.src || plan.dest.startsWith(`${plan.src}/`)) {
      throw cpError('ERR_FS_CP_EINVAL', `Invalid src or dest: cp returned EINVAL (cannot copy ${plan.src} to a subdirectory of self ${plan.dest})`);
    }
    return plan;
  }
  function cpFile(srcPath, destPath, o, exists) {
    if (exists && !o.force) {
      if (o.errorOnExist) throw cpError('ERR_FS_CP_EEXIST', `Target already exists: cp returned EEXIST (${destPath} already exists)`);
      return null;
    }
    return 0;
  }
  function cpSyncImpl(src, dest, o) {
    if (typeof(o.filter) === 'function' && !o.filter(src, dest)) return;
    const st = stats(sync(o.dereference ? 'stat' : 'lstat', [src, {}]));
    if (st.isDirectory()) {
      if (!o.recursive) throw cpError('ERR_FS_EISDIR', `Recursive option is required to copy a directory: ${src}`);
      sync('mkdir', [dest, {recursive: true}]);
      for (const name of sync('readdir', [src, {}])) cpSyncImpl(pathMod.posix.join(src, name), pathMod.posix.join(dest, name), o);
    } else {
      const exists = sync('exists', [dest]);
      if (cpFile(src, dest, o, exists) === null) return;
      if (exists) sync('unlink', [dest]);
      if (st.isSymbolicLink()) sync('symlink', [sync('readlink', [src]), dest]);
      else sync('copyFile', [src, dest, 0]);
    }
    if (o.preserveTimestamps) sync('utimes', [dest, toUnixTimestamp(st.atime), toUnixTimestamp(st.mtime)]);
  }
  async function cpImpl(src, dest, o) {
    if (typeof(o.filter) === 'function' && !(await o.filter(src, dest))) return;
    const st = stats(await call(o.dereference ? 'stat' : 'lstat', [src, {}]));
    if (st.isDirectory()) {
      if (!o.recursive) throw cpError('ERR_FS_EISDIR', `Recursive option is required to copy a directory: ${src}`);
      await call('mkdir', [dest, {recursive: true}]);
      for (const name of await call('readdir', [src, {}])) await cpImpl(pathMod.posix.join(src, name), pathMod.posix.join(dest, name), o);
    } else {
      const exists = await call('exists', [dest]);
      if (cpFile(src, dest, o, exists) === null) return;
      if (exists) await call('unlink', [dest]);
      if (st.isSymbolicLink()) await call('symlink', [await call('readlink', [src]), dest]);
      else await call('copyFile', [src, dest, 0]);
    }
    if (o.preserveTimestamps) await call('utimes', [dest, toUnixTimestamp(st.atime), toUnixTimestamp(st.mtime)]);
  }
  lock(fs, 'cpSync', (src, dest, o) => { const c = cpPlan(src, dest, o); cpSyncImpl(c.src, c.dest, c.o); }, handled.fs, P01);
  lock(fs, 'cp', (src, dest, ...all) => {
    const {args, cb} = splitCb(all);
    let c;
    try { c = cpPlan(src, dest, args[0]); } catch (e) { return process.nextTick(cb, e); }
    cpImpl(c.src, c.dest, c.o).then(() => cb(null), (e) => cb(e));
  }, handled.fs, P01);
  lock(fsp, 'cp', async(src, dest, o) => { const c = cpPlan(src, dest, o); return cpImpl(c.src, c.dest, c.o); }, handled.promises, P01);

  // glob: one non-recursive readdir per directory level, starting from the
  // pattern's literal prefix, descending only as deep as the pattern can
  // match ('**' unbounded). Absolute patterns give absolute results.
  function globPlan(pattern, o) {
    const x = Object.assign({}, o || {});
    x.cwd = x.cwd != null ? p(x.cwd, 'cwd') : process.cwd();
    const pats = (Array.isArray(pattern) ? pattern : [pattern]).map((pat) => {
      const abs = pathMod.posix.isAbsolute(pat);
      const segs = pat.split('/').filter((s, i) => !(abs && i === 0 && s === ''));
      const lit = [];
      while (lit.length < segs.length - 1 && !GLOB_CHARS.test(segs[lit.length])) lit.push(segs[lit.length]);
      const rest = segs.slice(lit.length);
      const base = abs ? `/${lit.join('/')}` : pathMod.posix.join(x.cwd, ...lit);
      return {pat, abs, base, depth: rest.includes('**') ? Infinity : rest.length};
    });
    return {x, pats};
  }
  function globKeep(x, pl, full, d, out, seen) {
    const shown = pl.abs ? full : pathMod.posix.relative(x.cwd, full);
    if (seen.has(shown) || !pathMod.matchesGlob(shown, pl.pat)) return;
    if (typeof(x.exclude) === 'function' && x.exclude(x.withFileTypes ? d : shown)) return;
    if (Array.isArray(x.exclude) && x.exclude.some((e) => pathMod.matchesGlob(shown, e))) return;
    seen.add(shown);
    out.push(x.withFileTypes ? d : shown);
  }
  function globSyncImpl(pattern, o) {
    const {x, pats} = globPlan(pattern, o);
    const out = [];
    const seen = new Set();
    for (const pl of pats) {
      const queue = [[pl.base, 1]];
      while (queue.length > 0) {
        const [dir, level] = queue.shift();
        let entries;
        try { entries = sync('readdir', [dir, {withFileTypes: true}]); } catch (e) { continue; }
        for (const e of entries) {
          const d = dirent(e);
          const full = pathMod.posix.join(dir, e.name);
          globKeep(x, pl, full, d, out, seen);
          if (e.type === 'dir' && level < pl.depth) queue.push([full, level + 1]);
        }
      }
    }
    return out;
  }
  async function globAsyncImpl(pattern, o) {
    const {x, pats} = globPlan(pattern, o);
    const out = [];
    const seen = new Set();
    for (const pl of pats) {
      const queue = [[pl.base, 1]];
      while (queue.length > 0) {
        const [dir, level] = queue.shift();
        let entries;
        try { entries = await call('readdir', [dir, {withFileTypes: true}]); } catch (e) { continue; }
        for (const e of entries) {
          const d = dirent(e);
          const full = pathMod.posix.join(dir, e.name);
          globKeep(x, pl, full, d, out, seen);
          if (e.type === 'dir' && level < pl.depth) queue.push([full, level + 1]);
        }
      }
    }
    return out;
  }
  const globHost = (o) => (o != null && o.cwd != null && hostServed(o.cwd));
  lock(fs, 'globSync', (pattern, o) => (globHost(o) ? origFs.globSync(pattern, o) : globSyncImpl(pattern, o)), handled.fs);
  lock(fs, 'glob', (pattern, ...all) => {
    const {args, cb} = splitCb(all);
    if (globHost(args[0])) return origFs.glob(pattern, ...all);
    globAsyncImpl(pattern, args[0]).then((r) => cb(null, r), (e) => cb(e));
  }, handled.fs);
  lock(fsp, 'glob', (pattern, o) => {
    if (globHost(o)) return origFsp.glob(pattern, o);
    return (async function* () { for (const m of await globAsyncImpl(pattern, o)) yield m; })();
  }, handled.promises);

  lock(fs, 'openAsBlob', async(path, o) => new Blob([await readFileImpl(path)], {type: (o && o.type) || ''}), handled.fs, P0);
  lock(fs, 'mkdtempDisposableSync', (prefix) => {
    const path = sync('mkdtemp', [p(prefix, 'prefix')]);
    const remove = () => sync('rm', [path, {recursive: true, force: true}]);
    return {path: path, remove: remove, [Symbol.dispose]: remove};
  }, handled.fs, P0);
  lock(fsp, 'mkdtempDisposable', async(prefix) => {
    const path = await call('mkdtemp', [p(prefix, 'prefix')]);
    const remove = () => call('rm', [path, {recursive: true, force: true}]);
    return {path: path, remove: remove, [Symbol.asyncDispose]: remove};
  }, handled.promises, P0);

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
// A function joins this list only with the reviewer's agreement.
const PASSTHROUGH = {
  fs: ['Dir', 'Dirent', 'FileReadStream', 'FileWriteStream', 'ReadStream', 'Stats', 'WriteStream', '_toUnixTimestamp',
    'constants', 'promises', 'createReadStream', 'createWriteStream', 'lchmod', 'lchmodSync'],
  promises: ['constants']
};

module.exports = {install, setConsoleSilenced, PASSTHROUGH, FD_BASE};
```

- [ ] **Step 5: Run the tests**

Run: `npx mocha --exit test/fs-broker/07-patch.js`
Expected: 3 passing. A failing assertion is a patch bug (debug it); a key reported by `keys.js` is a method the patch must handle or, if it is data or a class, add to `PASSTHROUGH` with a comment saying why — ask the reviewer before adding a function to `PASSTHROUGH`.

- [ ] **Step 6: Commit**

```bash
git add lib/fs-broker/patch.js test/helpers/brokered-worker.js test/helpers/brokered-worker-entry.js test/fs-broker/scripts/keys.js test/fs-broker/scripts/behaviour.js test/fs-broker/scripts/k1.js test/fs-broker/07-patch.js
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
  await step('stat throwIfNoEntry', () => fs.statSync(j('nope'), {throwIfNoEntry: false}) === undefined);
  await step('lstat throwIfNoEntry', () => fs.lstatSync(j('nope'), {throwIfNoEntry: false}) === undefined);
  await step('cp file', () => { fs.cpSync(j('g'), j('cpd')); return fs.readFileSync(j('cpd'), 'utf8'); });
  await step('cp force + errorOnExist overwrites', () => { fs.cpSync(j('o'), j('cpd'), {force: true, errorOnExist: true}); return fs.readFileSync(j('cpd'), 'utf8'); });
  await step('cp without force skips', () => { fs.cpSync(j('g'), j('cpd'), {force: false}); return fs.readFileSync(j('cpd'), 'utf8'); });
  await step('cp without force, errorOnExist', () => fs.cpSync(j('g'), j('cpd'), {force: false, errorOnExist: true}));
  await step('cp into itself', () => { fs.mkdirSync(j('cs')); fs.cpSync(j('cs'), j('cs', 'sub'), {recursive: true}); });
  await step('glob absolute', () => fs.globSync(j('*')).map(rel).sort());
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
- Produces: `require('./fs-broker').createForWorker({name, mode, modulePath, declared, options, report}) → Promise<{broker, bridge, namespace, dirs, hostRoots}>`; `protectedPaths(options) → [string]`; `watch(worker, workerMessage, limits, {busy})`.

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
const os = require('os');
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

  // Review K1: a module loaded from under /tmp, and data under /tmp, still work.
  ['off', 'audit'].forEach((mode) => {
    it(`${mode}: a module loaded from under /tmp still loads and works`, async () => {
      const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-fsprobe-'));
      fs.cpSync(PROBE, copy, {recursive: true});
      try {
        server = await startServer(9626, ['--workerThread', '--debug', '--debugKey', KEY, '--moduleSandbox', mode,
          '--moduleDataPath', path.join(base, 'store'), '--loadModule', copy]);
        const w = await mcpCall(9626, KEY, tool('write'), {path: '/data/x', content: 'from tmp'});
        assert.deepStrictEqual(w.structuredContent.output, {ok: true, code: null}, JSON.stringify(w));
      } finally {
        fs.rmSync(copy, {recursive: true, force: true});
      }
    });
  });

  it('a --moduleDataPath under /tmp works', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-store-'));
    try {
      server = await startServer(9626, ['--workerThread', '--debug', '--debugKey', KEY, '--moduleDataPath', store, '--loadModule', PROBE]);
      await mcpCall(9626, KEY, tool('write'), {path: '/data/x', content: 'y'});
      assert.strictEqual(fs.readFileSync(path.join(store, 'fs-probe', 'data', 'x'), 'utf8'), 'y');
    } finally {
      fs.rmSync(store, {recursive: true, force: true});
    }
  });

  it('a data directory that cannot be created fails the load and says what to do', async () => {
    const ro = path.join(base, 'ro');
    fs.mkdirSync(ro);
    fs.chmodSync(ro, 0o500);
    try {
      server = await startServer(9626, ['--workerThread', '--debug', '--debugKey', KEY, '--authoringTools',
        '--moduleDataPath', path.join(ro, 'store')]);
      const r = await mcpCall(9626, KEY, 'countinghouse_load_module', {path: PROBE, name: 'fs-probe', version: '1.0.0'});
      assert.ok(/set --moduleDataPath to a writable directory/.test(JSON.stringify(r)), JSON.stringify(r));
    } finally {
      fs.chmodSync(ro, 0o700);
    }
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
  let dirs;
  try {
    dirs = await moduleData.ensureDirs(cfg.options.moduleDataPath, cfg.name);
  } catch (e) {
    // Every mode creates it, so a read-only $HOME (systemd ProtectHome, a
    // read-only container root) must say what to do (review I6).
    let where = cfg.options.moduleDataPath;
    try { where = moduleData.dirsFor(cfg.options.moduleDataPath, cfg.name).root; } catch (e2) { /* unsafe name: keep the base */ }
    throw new Error(`cannot create the module data directory ${where}: ${e.message} -- set --moduleDataPath to a writable directory`);
  }
  const moduleRoot = await fsp.realpath(path.resolve(cfg.modulePath));
  const namespace = createNamespace({moduleRoot: moduleRoot, dataDir: dirs.data, tmpDir: dirs.tmp,
    declared: cfg.declared || [], protectedPaths: protectedPaths(cfg.options)});
  await namespace.prepare();
  namespace.refused.forEach((r) => cfg.report('refused', `${r.path} (${r.reason})`));
  const key = `${cfg.name}#${++spawned}`;
  const sched = sharedScheduler();
  const broker = new FsBroker({name: cfg.name, mode: cfg.mode, namespace: namespace, cwd: process.cwd(), report: cfg.report,
    schedule: (fn) => sched.submit(key, fn)});
  const bridge = createBridge({broker: broker, scheduler: sched, key: key});
  // Interim until plan 3 (review K1): the worker serves these by host path itself.
  const hostRoots = [moduleRoot, await fsp.realpath(INSTALL_DIR)];
  return {broker, bridge, namespace, dirs, hostRoots};
}

module.exports = {createForWorker, protectedPaths, sharedScheduler, INSTALL_DIR};
```

  - `lib/sandbox.js`: directly after the `process.umask` workaround, before any other `require`:
    ```js
    // File broker (module sandbox part 2): patch fs before anything else
    // loads, so nothing in this worker holds an unbrokered fs.
    const fsWorkerData = require('worker_threads').workerData || {};
    if (fsWorkerData.fsBridge != null) {
      require('./fs-broker/patch').install(require('./fs-broker/client').createClient(fsWorkerData.fsBridge), {hostRoots: fsWorkerData.hostRoots});
    }
    ```
    and in `set-options`, next to the console silencing: `require('./fs-broker/patch').setConsoleSilenced(options.debug !== true);`.
  - `lib/module-manager.js` `spawnModuleWorker`: after the sandbox block, wrap the rest of the function body (from `const worker = new Worker(` to the end) in `const startWorker = (fsb) => { … };`, and inside it:
    - create the worker with `Object.assign({}, sandbox != null ? sandbox.workerOptions : {}, {workerData: {fsBridge: fsb.bridge.transfer, hostRoots: fsb.hostRoots}, transferList: fsb.bridge.transferList})`;
    - right after, `worker.once('exit', () => { fsb.bridge.close().catch((e) => LOG.E(e)); });`;
    - pass `{busy: () => fsb.bridge.syncInFlight() > 0}` as the fourth argument of `workerLimits.watch`.
    Then end `spawnModuleWorker` with:
    ```js
    require('./fs-broker').createForWorker({name: name, mode: options.moduleSandbox, modulePath: modulePath,
      declared: sandbox != null ? sandbox.fs : [], options: options,
      report: (rule, target) => LOG.I(`module sandbox: ${name} file ${rule} ${target}`)
    }).then((fsb) => {
      // A synchronous throw in startWorker (new Worker refusing its options,
      // say) must still answer the load and release the broker (review I1).
      try {
        startWorker(fsb);
      } catch (e) {
        fsb.bridge.close().catch(() => {});
        callback(new CHError('LOAD_MODULE_FAIL', name, e.message));
      }
    }, (e) => callback(new CHError('LOAD_MODULE_FAIL', name, `file broker: ${e.message}`)));
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

- [ ] **Step 1: CHANGELOG.** Under `## Unreleased`, a new section `### Added — module sandbox, part 2 (in progress)` with: "**File access from module workers goes through the main thread**, in every `--moduleSandbox` mode under `--workerThread`: `fs` is patched before any module code loads, and a per-worker broker answers every call. Each module gets private `/data` and `/tmp` directories under the new **`--moduleDataPath`** (default `$HOME/countinghouse_module_data`). The file checks are not enforced yet; until they are, `enforce` behaves like `audit` for files." and, under `### Changed — 8.0.0 platform`: "`UV_THREADPOOL_SIZE` defaults to 16 (set it yourself to override)." and "**Every module now needs a writable `--moduleDataPath`**, in every mode: the default is `$HOME/countinghouse_module_data`, so where `$HOME` is read-only (systemd `ProtectHome` or `ProtectSystem=strict`, a read-only container root) set `--moduleDataPath` to a writable directory before upgrading, or modules fail to load with `cannot create the module data directory`." Plan 5 rewrites these into the final upgrade section.
- [ ] **Step 2:** Tell the reviewer, then run the full suite: `npm test > .superpowers/part2-plan2b-suite.log 2>&1; echo "exit=$?" >> .superpowers/part2-plan2b-suite.log` (about 35 minutes or more; keep the machine idle). Expected: `exit=0`. A failure goes to the reviewer with its output and your diagnosis before any fix.
- [ ] **Step 3:** Commit the CHANGELOG, send the reviewer the plan's commit range and the suite result, and write plan 3.
