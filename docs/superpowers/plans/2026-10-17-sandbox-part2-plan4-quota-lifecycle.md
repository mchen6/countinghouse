# Module sandbox part 2, plan 4 of 5 — quota, the spawn walk, the lifecycle lock, uninstall

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, chosen by the user) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. After each task's commit, send the reviewer session (`countinghouse-0a`) the range from `git log --oneline` output and wait for its approval before the next task. Tell the reviewer before running tests that use ports. Never run two server test files at once on this one-CPU VM.

**Goal:** Give each module a disk quota on `/data` and `/tmp`, empty `/tmp` and check the data directories at every spawn, serialise everything that touches a module's data directory behind one per-name lock, and add `POST /uninstall-module`.

**Architecture:** A `Quota` object per worker (`lib/fs-broker/quota.js`) is filled at spawn by an asynchronous walk (`lib/fs-broker/spawn-walk.js`) that first empties `/tmp` without following links, then measures `/data` and `/tmp` and lists hard links and absolute symlinks. The broker reserves before every growth on a quota root and settles after. A per-name lifecycle lock (`lib/module-lifecycle.js`) owned by `ModuleManager` makes each spawn wait until the name's previous broker has settled (its worker gone, its operations finished) before the walk starts, and keeps uninstall's deletion apart from any load of the same name. The uninstall route checks state, removes the registry entry when the registry is in use, and deletes `<moduleDataPath>/<name>` unless told to keep it.

**Tech Stack:** Node.js >= 22.16, Express (existing routes), mocha.

**Spec:** `docs/superpowers/specs/2026-10-17-module-sandbox-fs-broker-design.md` — section 1 (the `/tmp` and `/data` rows), section 3 ("Link rules", "Quota", "Worker end"), section 7 (uninstall), "Error codes and flags", "Testing" (quota, lifecycle). Series ledger items closed here: the overlapping-spawn window (plan 2b review I1) and the copyFile/rename destination link (plan 2a review M3).

## Global Constraints

- New limits `diskMb` (default ceiling 1024) and `diskEntries` (default ceiling 100000), declared in `countinghouse.permissions.limits` and narrowed by the policy exactly as part 1's limits are. One pool for `/data` and `/tmp`; declared paths and `/app` are never counted.
- Modes: `enforce` answers `ENOSPC` when a reservation would pass a limit; `audit` allows it and logs once per threshold crossing (75 % and 100 %, each re-armed when usage drops back below it); `off` does not count (no measuring walk, no reservations).
- `/tmp` is emptied at every spawn, in every mode, before the module loads. Never through a link: if the `/tmp` root itself is not a real directory, the spawn fails and says so.
- The spawn link check refuses links that can lead outside (spec section 3, review I4): a symlink with an absolute target, or a regular file with more names than the walk found under `/data` and `/tmp` (`st.nlink` greater than its tally, so a link exists outside). Hard links the link rules allowed inside one root are fine. It refuses the load under `enforce`, naming at most 10 entries and how many more, and is logged under `audit`. `off` does not walk.
- Counting is logical size: positional writes and `ftruncate` up count to the new length; sparse files count their length. Each inode's bytes once (hard links inside a root); each name is one entry (files, directories, symlinks).
- The lifecycle lock is per verified package name. A spawn waits for the previous broker of that name to settle before emptying `/tmp`. A tracked worker is *live* until it exits; it *settles* later, once its broker is idle (review I5). Only a live worker counts as "loaded" for the supervisor's give-way rule and uninstall's pre-check; spawn and uninstall both wait for settle under the lock. An operator spawn that finds a live worker of the same name terminates it first (loading a loaded module restarts it); a supervisor spawn (`stillWanted` given) that finds one gives way with `restart superseded by an operator action`.
- Uninstall: admin key; `name` checked by `module-data.safeName` before any path is built; refused while the module is loaded, restarting or suspended; never deletes code under `--modulePath`; never follows a link (the data root itself must be a real directory).
- First commit of Task 1 fixes the stale comment at `test/device-config/02-from-main-thread.js:15` (end-of-plan-3 gate).
- Do not run the full `npm test` except in the last task. Kill stray servers by PID. Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Two writes to one module racing at the quota edge (different descriptors, both async) — the second must get `ENOSPC` under `enforce`, never both succeed (Task 3 concurrency test).
2. A host-planted symlink as the `/tmp` root, or inside `/tmp`, pointing at a directory with files — emptying `/tmp` must not delete anything outside it (Task 2 test).
3. `POST /uninstall-module` racing `POST /load-module` of the same name — the load either completes before the deletion starts (and uninstall refuses, the module being loaded) or starts after it finished (with an empty data directory); never a worker running on a half-deleted directory (Task 5 test).
4. A restart while the old worker has a long operation in flight — the new spawn must not empty `/tmp` until that operation settled (Task 4 test).
5. A dangling absolute symlink planted at a copyFile/rename destination under `/data` — refused at spawn under `enforce` (Task 2 test; closes plan 2a's M3).

---

### Task 1: The disk limits, and the plan 3 leftover

**Files:**
- Modify: `test/device-config/02-from-main-thread.js` (comment), `lib/module-permissions.js`, `lib/fs-broker/index.js` (accepts `cfg.limits`), `lib/module-manager.js` (passes `sandbox.limits`)
- Test: `test/sandbox/02-permissions.js`

**Interfaces:**
- Produces: `DEFAULT_LIMITS` gains `diskMb: 1024, diskEntries: 100000`; `narrow()` returns them in `limits`; `createForWorker({..., limits})` keeps `limits` (null under `off`) for Task 3.

- [ ] **Step 1: Fix the comment.** In `test/device-config/02-from-main-thread.js`, replace the base-directory comment ("Outside the install directory (served by host path until plan 3's Task 4) and outside /tmp (the module's own /tmp), so a worker-side read would go to the broker and be logged.") with: "Outside the install directory and outside /tmp (the module's own /tmp), so a worker-side read would go to the broker and be logged." Commit alone: `test: drop a stale plan 3 reference`.
- [ ] **Step 2: Write the failing tests** in `test/sandbox/02-permissions.js`:

```js
  it('parses and narrows the disk limits', () => {
    const parsed = perms.parseDeclaration({limits: {diskMb: 64, diskEntries: 500}});
    assert.deepStrictEqual(parsed.problems, []);
    const eff = perms.narrow(parsed.declared, {approve: 'as-declared', limits: {diskMb: 32}}, {}, 'enforce');
    assert.strictEqual(eff.limits.diskMb, 32);
    assert.strictEqual(eff.limits.diskEntries, 500);
    const defaults = perms.narrow(perms.parseDeclaration(undefined).declared, null, {}, 'audit');
    assert.strictEqual(defaults.limits.diskMb, 1024);
    assert.strictEqual(defaults.limits.diskEntries, 100000);
  });
```

Run `npx mocha --exit test/sandbox/02-permissions.js -g "disk limits"` → FAIL (`diskMb is not a known limit`).
- [ ] **Step 3: Implement.** `lib/module-permissions.js`: `DEFAULT_LIMITS = Object.freeze({heapMb: 256, externalMb: 256, maxBlockMs: 10000, diskMb: 1024, diskEntries: 100000})`. Fix any existing test that lists the known limits. `lib/module-manager.js`: pass `limits: sandbox != null ? sandbox.limits : null` to `createForWorker`; `lib/fs-broker/index.js` keeps it (`cfg.limits`).
- [ ] **Step 4: Run** `npx mocha --exit test/sandbox/02-permissions.js test/sandbox/04-load-time.js` → all passing.
- [ ] **Step 5: Commit** `feat(sandbox): diskMb and diskEntries limits`.

---

### Task 2: The spawn walk — empty /tmp, measure, refuse links

**Files:**
- Create: `lib/fs-broker/spawn-walk.js`, `test/fs-broker/15-spawn-walk.js`
- Modify: `lib/fs-broker/index.js` (calls it before `namespace.prepare()`)

**Interfaces:**
- Produces: `spawnWalk.emptyTmp(tmpDir) → Promise<void>`; `spawnWalk.measure([[hostDir, vroot], …], {maxListed, whollyInside})` — `whollyInside: true` (used by `rm`, Task 3) counts a file's bytes only when every one of its links was found in the walk; `spawnWalk.measure([[dataDir, '/data'], [tmpDir, '/tmp']], {maxListed}) → Promise<{bytes, entries, links: string[], moreLinks: number}>`; `createForWorker` result gains `usage: {bytes, entries} | null`.

- [ ] **Step 1: Write the failing tests** — `test/fs-broker/15-spawn-walk.js`:

```js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const walk = require('../../lib/fs-broker/spawn-walk');
const {mkdtemp} = require('../helpers/test-tmp');

describe('fs-broker 15: the spawn walk', function() {
  let base = null;
  let outside = null;
  afterEach(() => { [base, outside].forEach((d) => d && fs.rmSync(d, {recursive: true, force: true})); base = outside = null; });

  it('empties /tmp without following links', async () => {
    base = mkdtemp('walk-');
    outside = fs.mkdtempSync(path.join(os.homedir(), '.ch-walk-outside-'));
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    const tmp = path.join(base, 'tmp');
    fs.mkdirSync(path.join(tmp, 'd'), {recursive: true});
    fs.writeFileSync(path.join(tmp, 'd', 'f'), 'x');
    fs.symlinkSync(outside, path.join(tmp, 'link-to-outside'));
    await walk.emptyTmp(tmp);
    assert.deepStrictEqual(fs.readdirSync(tmp), []);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  });

  it('refuses to empty a /tmp root that is a link', async () => {
    base = mkdtemp('walk-');
    outside = fs.mkdtempSync(path.join(os.homedir(), '.ch-walk-outside-'));
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    fs.symlinkSync(outside, path.join(base, 'tmp'));
    await assert.rejects(walk.emptyTmp(path.join(base, 'tmp')), /not a directory/);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  });

  it('measures logical bytes once per inode and one entry per name, and lists absolute symlinks and links that lead outside', async () => {
    base = mkdtemp('walk-');
    const data = path.join(base, 'data');
    const tmp = path.join(base, 'tmp');
    fs.mkdirSync(path.join(data, 'sub'), {recursive: true});
    fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(data, 'a'), Buffer.alloc(1000));
    fs.linkSync(path.join(data, 'a'), path.join(data, 'sub', 'a2'));       // hard link inside: bytes once, two entries, not listed
    outside = fs.mkdtempSync(path.join(os.homedir(), '.ch-walk-outside-'));
    fs.writeFileSync(path.join(outside, 'o'), Buffer.alloc(10));
    fs.linkSync(path.join(outside, 'o'), path.join(data, 'out'));           // a link whose other name is outside: listed
    const sparse = fs.openSync(path.join(data, 'sparse'), 'w'); fs.ftruncateSync(sparse, 5000); fs.closeSync(sparse);
    fs.symlinkSync('a', path.join(data, 'rel'));                               // relative: fine
    fs.symlinkSync('/etc/hostname', path.join(data, 'abs'));                   // absolute: listed
    const r = await walk.measure([[data, '/data'], [tmp, '/tmp']], {maxListed: 10});
    assert.strictEqual(r.bytes, 6010);
    assert.strictEqual(r.entries, 7);   // sub, a, sub/a2, out, sparse, rel, abs
    assert.deepStrictEqual(r.links.sort(), ['/data/abs', '/data/out'].sort());
    assert.strictEqual(r.moreLinks, 0);
  });

  it('whollyInside counts a file\'s bytes only when all its links are inside the walked tree (review I1)', async () => {
    base = mkdtemp('walk-');
    const data = path.join(base, 'data');
    fs.mkdirSync(path.join(data, 'd'), {recursive: true});
    fs.writeFileSync(path.join(data, 'big'), Buffer.alloc(1000));
    fs.linkSync(path.join(data, 'big'), path.join(data, 'd', 'x'));
    fs.writeFileSync(path.join(data, 'd', 'own'), Buffer.alloc(30));
    const sub = await walk.measure([[path.join(data, 'd'), '/data/d']], {whollyInside: true});
    assert.strictEqual(sub.bytes, 30, 'd/x shares its inode with /data/big, which stays');
    assert.strictEqual(sub.entries, 2);
  });
});
```

and wired tests appended to `test/fs-broker/09-wired.js` (port 9626):

```js
  it('enforce: a hard link made through the broker inside /data does not stop a restart (review I4)', async () => {
    server = await start('enforce');
    await mcpCall(9626, KEY, tool('write'), {path: '/data/a', content: 'x'});
    fs.linkSync(path.join(base, 'store', 'fs-probe', 'data', 'a'), path.join(base, 'store', 'fs-probe', 'data', 'b'));   // as link() inside one root would
    const r1 = await post(9626, KEY, '/restart-module', {name: 'fs-probe'});
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
    await waitFor(async () => (await mcpCall(9626, KEY, tool('read'), {path: '/data/b'})).structuredContent.output.content === 'x', 15000, 'read after restart');
  });

  it('enforce: a planted absolute symlink or hard link under the data directory refuses the load, naming it', async () => {
    const store = path.join(base, 'store');
    fs.mkdirSync(path.join(store, 'fs-probe', 'data'), {recursive: true});
    fs.symlinkSync('/nonexistent-ch-target', path.join(store, 'fs-probe', 'data', 'dest'));   // a dangling copyFile/rename destination (plan 2a M3)
    server = await start('enforce');
    await waitFor(async () => server.output.includes('MODULE_SANDBOX_REFUSED') || server.output.includes('refuses'), 15000, 'refusal');
    assert.ok(server.output.includes('/data/dest'), server.output.slice(-2000));
    const r = await mcpCall(9626, KEY, tool('read'), {path: '/data/x'});
    assert.ok(/unknown tool/.test(JSON.stringify(r)), 'the module must not have loaded');
  });

  it('audit: the same entry is logged and the module loads', async () => {
    const store = path.join(base, 'store');
    fs.mkdirSync(path.join(store, 'fs-probe', 'data'), {recursive: true});
    fs.symlinkSync('/nonexistent-ch-target', path.join(store, 'fs-probe', 'data', 'dest'));
    server = await start('audit');
    const w = await mcpCall(9626, KEY, tool('write'), {path: '/data/x', content: 'y'});
    assert.deepStrictEqual(w.structuredContent.output, {ok: true, code: null});
    assert.ok(server.output.includes('/data/dest'), server.output.slice(-2000));
  });

  it('every mode: /tmp is emptied when the worker starts', async () => {
    const store = path.join(base, 'store');
    fs.mkdirSync(path.join(store, 'fs-probe', 'tmp'), {recursive: true});
    fs.writeFileSync(path.join(store, 'fs-probe', 'tmp', 'old'), 'stale');
    server = await start('off');
    const r = await mcpCall(9626, KEY, tool('read'), {path: '/tmp/old'});
    assert.deepStrictEqual(r.structuredContent.output, {content: null, code: 'ENOENT'});
  });
```

- [ ] **Step 2: Run them to verify they fail** (tell the reviewer first: 9626) — `npx mocha --exit test/fs-broker/15-spawn-walk.js test/fs-broker/09-wired.js -g "spawn walk|planted|same entry|emptied"` → module not found / not refused / not emptied.
- [ ] **Step 3: Implement** `lib/fs-broker/spawn-walk.js`:

```js
// The spawn walk (spec section 3, "Quota" and "Link rules"): before a module
// worker starts, /tmp is emptied and /data and /tmp are measured. Nothing
// here follows a link: lstat everywhere, and fs.rm removes a link, never its
// target. Runs on the main thread with the real fs, asynchronously; the spawn
// waits for it.
const fsp = require('fs/promises');
const path = require('path');

async function realDirectory(dir) {
  const st = await fsp.lstat(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory (a link or a file); refusing to empty or measure it`);
}

async function emptyTmp(tmpDir) {
  await realDirectory(tmpDir);
  for (const name of await fsp.readdir(tmpDir)) {
    await fsp.rm(path.join(tmpDir, name), {recursive: true, force: true});
  }
}

// roots: [[hostDir, '/data'], [hostDir, '/tmp']]; links are reported as virtual paths.
// Hard links: bytes once per inode; names are tallied per inode so a file
// with more links than the walk found (st.nlink > tally) has a name
// elsewhere -- listed, since it can lead outside (review I4). whollyInside
// (rm's release, review I1): count a file's bytes only when all its links
// were found, so removing one name of a shared file gives nothing back.
async function measure(roots, opts) {
  const maxListed = (opts && opts.maxListed) || 10;
  const whollyInside = opts != null && opts.whollyInside === true;
  const inodes = new Map();   // dev:ino -> {size, nlink, names: [virtual]}
  const out = {bytes: 0, entries: 0, links: [], moreLinks: 0};
  const flag = (v) => { if (out.links.length < maxListed) out.links.push(v); else out.moreLinks++; };
  for (const [host, vroot] of roots) {
    await realDirectory(host);
    const queue = [[host, vroot]];
    while (queue.length > 0) {
      const [dir, vdir] = queue.shift();
      for (const d of await fsp.readdir(dir, {withFileTypes: true})) {
        const hp = path.join(dir, d.name);
        const vp = `${vdir}/${d.name}`;
        const st = await fsp.lstat(hp);
        out.entries++;
        if (st.isSymbolicLink()) {
          if (path.isAbsolute(await fsp.readlink(hp))) flag(vp);
        } else if (st.isDirectory()) {
          queue.push([hp, vp]);
        } else if (st.isFile()) {
          const key = `${st.dev}:${st.ino}`;
          const i = inodes.get(key) || {size: st.size, nlink: st.nlink, names: []};
          i.names.push(vp);
          inodes.set(key, i);
        }
      }
    }
  }
  for (const i of inodes.values()) {
    const allFound = i.names.length >= i.nlink;
    if (!allFound) flag(i.names[0]);
    if (!whollyInside || allFound) out.bytes += i.size;
  }
  return out;
}

module.exports = {emptyTmp, measure};
```

In `lib/fs-broker/index.js` `createForWorker`, after `ensureDirs` and before the namespace: `await spawnWalk.emptyTmp(dirs.tmp)` (every mode; a failure is the load's failure with the walk's message); when `cfg.mode !== 'off'`: `const usage = await spawnWalk.measure([[dirs.data, '/data'], [dirs.tmp, '/tmp']], {maxListed: 10})`; if `usage.links.length > 0`: the text `links that could lead outside the module's data (a hard link, or a symlink with an absolute target): ${usage.links.join(', ')}${usage.moreLinks ? ` and ${usage.moreLinks} more` : ''} -- remove or replace them under ${dirs.root}, then POST /restart-module`; under `enforce` throw an error with code `MODULE_SANDBOX_REFUSED` and that text (module-manager turns it into `CHError('MODULE_SANDBOX_REFUSED', name, text)` and logs it), under `audit` `cfg.report('links', text)`. Return `usage: {bytes, entries}` (null under `off`).
- [ ] **Step 4: Run** the Step 2 command → passing; then `npx mocha --exit test/fs-broker/09-wired.js test/fs-broker/14-hoisted-install.js`.
- [ ] **Step 5: Commit** `feat(fs-broker): empty /tmp, measure and check links at every spawn`.

---

### Task 3: Quota accounting in the broker

**Files:**
- Create: `lib/fs-broker/quota.js`, `test/fs-broker/16-quota.js`
- Modify: `lib/fs-broker/broker.js`, `lib/fs-broker/index.js` (builds the `Quota` from `cfg.limits` and `usage`)

**Interfaces:**
- Consumes: `cfg.limits` (Task 1), `usage` (Task 2).
- Produces: `new Quota({maxBytes, maxEntries, enforce, report, bytes, entries})` with `reserve(bytes, entries, syscall, virtual)` (throws `ENOSPC` under enforce when over; reports threshold crossings under audit) and `settle(reservedBytes, reservedEntries, actualBytes, actualEntries)`; `FsBroker` option `quota` (null: not counted).

- [ ] **Step 1: Write the failing tests** — `test/fs-broker/16-quota.js`, using the broker directly as `03-broker.js` does (its `setup(mode, opts)` helper, extended with `quota: {maxBytes, maxEntries}`), each against a fresh tree:

```js
  it('enforce: a write past diskMb is ENOSPC and writes nothing', async () => {
    const t = await setup('enforce', {quota: {maxBytes: 1000, maxEntries: 100}});
    try {
      const fd = await t.broker.handle('open', ['/data/f', 'w']);
      await t.broker.handle('write', [fd, Buffer.alloc(900), null]);
      await assert.rejects(t.broker.handle('write', [fd, Buffer.alloc(200), null]), (e) => e.code === 'ENOSPC' && e.path === '/data/f');
      await t.broker.handle('close', [fd]);
      assert.strictEqual(fs.statSync(path.join(t.dirs.data, 'f')).size, 900);
    } finally { await t.done(); }
  });

  it('counts logical growth: an overwrite in place is free; ftruncate up counts; a sparse file counts its length', async () => {
    const t = await setup('enforce', {quota: {maxBytes: 1000, maxEntries: 100}});
    try {
      const fd = await t.broker.handle('open', ['/data/f', 'w']);
      await t.broker.handle('write', [fd, Buffer.alloc(800), null]);
      await t.broker.handle('write', [fd, Buffer.alloc(800), 0]);              // positional, no growth
      await assert.rejects(t.broker.handle('ftruncate', [fd, 1200]), (e) => e.code === 'ENOSPC');
      await t.broker.handle('ftruncate', [fd, 100]);                          // shrink releases
      await t.broker.handle('ftruncate', [fd, 900]);
      await t.broker.handle('close', [fd]);
    } finally { await t.done(); }
  });

  it('diskEntries counts names: files, directories, symlinks, links; unlink and rm give them back', async () => {
    const t = await setup('enforce', {quota: {maxBytes: 1e6, maxEntries: 3}});
    try {
      await t.broker.handle('mkdir', ['/data/d']);
      await t.broker.handle('close', [await t.broker.handle('open', ['/data/d/f', 'w'])]);
      await t.broker.handle('symlink', ['f', '/data/d/s']);
      await assert.rejects(t.broker.handle('link', ['/data/d/f', '/data/d/h']), (e) => e.code === 'ENOSPC');
      await t.broker.handle('rm', ['/data/d', {recursive: true}]);
      await t.broker.handle('mkdir', ['/data/e']);
    } finally { await t.done(); }
  });

  it('two writes racing at the edge: one gets ENOSPC', async () => {
    const t = await setup('enforce', {quota: {maxBytes: 1000, maxEntries: 100}});
    try {
      const a = await t.broker.handle('open', ['/data/a', 'w']);
      const b = await t.broker.handle('open', ['/data/b', 'w']);
      const results = await Promise.allSettled([t.broker.handle('write', [a, Buffer.alloc(600), null]), t.broker.handle('write', [b, Buffer.alloc(600), null])]);
      assert.deepStrictEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    } finally { await t.done(); }
  });

  it('copyFile counts the copy; rename over an existing file gives the replaced one back; /tmp shares the pool', async () => {
    const t = await setup('enforce', {quota: {maxBytes: 1000, maxEntries: 100}});
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'src'), Buffer.alloc(400));
      t.broker.quota.settle(0, 0, 400, 1);                                    // the file the test planted
      await t.broker.handle('copyFile', ['/data/src', '/tmp/copy']);
      await assert.rejects(t.broker.handle('copyFile', ['/data/src', '/tmp/copy2']), (e) => e.code === 'ENOSPC');
      const before = t.broker.quota.bytes;
      await t.broker.handle('rename', ['/tmp/copy', '/tmp/copy']);              // to itself: nothing changes (review I2)
      assert.strictEqual(t.broker.quota.bytes, before);
      await t.broker.handle('close', [await t.broker.handle('open', ['/tmp/small', 'w'])]);
      await t.broker.handle('rename', ['/tmp/small', '/tmp/copy']);             // over a different file: the replaced copy is given back
      await t.broker.handle('copyFile', ['/data/src', '/tmp/copy2']);
    } finally { await t.done(); }
  });

  it('removing one name of a hard-linked file gives nothing back (review I1)', async () => {
    const t = await setup('enforce', {quota: {maxBytes: 1500, maxEntries: 1000}});
    try {
      const fd = await t.broker.handle('open', ['/data/big', 'w']);
      await t.broker.handle('write', [fd, Buffer.alloc(1000), null]);
      await t.broker.handle('close', [fd]);
      for (let i = 0; i < 3; i++) {
        await t.broker.handle('mkdir', ['/data/d']);
        await t.broker.handle('link', ['/data/big', '/data/d/x']);
        await t.broker.handle('rm', ['/data/d', {recursive: true}]);
      }
      const f2 = await t.broker.handle('open', ['/data/more', 'w']);
      await assert.rejects(t.broker.handle('write', [f2, Buffer.alloc(600), null]), (e) => e.code === 'ENOSPC');
      await t.broker.handle('close', [f2]);
    } finally { await t.done(); }
  });

  it('audit: allowed past the limit, logged once at 75 % and once at 100 %', async () => {
    const t = await setup('audit', {quota: {maxBytes: 1000, maxEntries: 100}});
    try {
      const fd = await t.broker.handle('open', ['/data/f', 'w']);
      for (let i = 0; i < 12; i++) await t.broker.handle('write', [fd, Buffer.alloc(100), null]);
      await t.broker.handle('close', [fd]);
      assert.deepStrictEqual(t.reports.filter((r) => r.startsWith('quota')), ['quota 75% of diskMb (750 of 1000 bytes)', 'quota 100% of diskMb (1000 of 1000 bytes)']);
    } finally { await t.done(); }
  });

  it('declared paths and off are not counted', async () => {
    const t = await setup('off', {quota: null});
    try {
      const fd = await t.broker.handle('open', ['/data/f', 'w']);
      await t.broker.handle('write', [fd, Buffer.alloc(5000), null]);
      await t.broker.handle('close', [fd]);
    } finally { await t.done(); }
  });
```

and one wired test in `09-wired.js`: a policy file granting `fs-probe` `{limits: {diskMb: 1}}` with `approve: "as-declared"`, `enforce`, writing 2 MB through the `write` action → `{ok: false, code: 'ENOSPC'}`.

- [ ] **Step 2: Run** `npx mocha --exit test/fs-broker/16-quota.js` → FAIL (no quota).
- [ ] **Step 3: Implement** `lib/fs-broker/quota.js`:

```js
// The per-module disk quota (spec section 3): one pool for /data and /tmp.
// Reserve before growth, settle after with what actually happened. All
// bookkeeping is synchronous, so two operations racing at the edge cannot
// both pass (the main thread runs one at a time). It is approximate in the
// safe direction: two descriptors extending one file at once each measure
// growth from the same old size, so the overlap is counted twice and usage
// drifts up, never down; the next spawn's walk measures it afresh (review I3).
const {nodeError} = require('./errors');

const THRESHOLDS = [0.75, 1];

class Quota {
  constructor(o) {
    this.maxBytes = o.maxBytes;
    this.maxEntries = o.maxEntries;
    this.enforce = o.enforce === true;
    this.reportFn = o.report || (() => {});
    this.bytes = o.bytes || 0;
    this.entries = o.entries || 0;
    this.armed = {diskMb: THRESHOLDS.map(() => true), diskEntries: THRESHOLDS.map(() => true)};
  }

  reserve(bytes, entries, syscall, virtual) {
    if ((bytes > 0 && this.bytes + bytes > this.maxBytes) || (entries > 0 && this.entries + entries > this.maxEntries)) {
      if (this.enforce) throw nodeError('ENOSPC', syscall, virtual);
    }
    this.bytes += bytes;
    this.entries += entries;
    this.crossings();
  }

  settle(reservedBytes, reservedEntries, actualBytes, actualEntries) {
    this.bytes = Math.max(0, this.bytes - reservedBytes + actualBytes);
    this.entries = Math.max(0, this.entries - reservedEntries + actualEntries);
    this.crossings();
  }

  crossings() {
    [['diskMb', this.bytes, this.maxBytes, 'bytes'], ['diskEntries', this.entries, this.maxEntries, 'entries']].forEach(([key, used, max, unit]) => {
      THRESHOLDS.forEach((t, i) => {
        if (this.armed[key][i] && used >= max * t) {
          this.armed[key][i] = false;
          this.reportFn('quota', `${Math.round(t * 100)}% of ${key} (${used} of ${max} ${unit})`);
        } else if (!this.armed[key][i] && used < max * t) {
          this.armed[key][i] = true;
        }
      });
    });
  }
}

module.exports = {Quota};
```

`lib/fs-broker/broker.js` — a quota root is `placed.res.kind === 'root' && placed.res.root.quota === true`; `this.quota` is null when not counted. Helpers on `FsBroker`:

```js
  // Runs fn with a reservation; settle() with the actual change afterwards.
  async counted(placed, bytes, entries, syscall, fn, actual) {
    if (this.quota == null || !quotaRoot(placed)) return fn();
    this.quota.reserve(bytes, entries, syscall, placed.virtual);
    let result;
    try { result = await fn(); } catch (e) { this.quota.settle(bytes, entries, 0, 0); throw e; }
    const a = await actual(result);
    this.quota.settle(bytes, entries, a.bytes, a.entries);
    return result;
  }
```

with `const quotaRoot = (p) => p != null && p.res != null && p.res.kind === 'root' && p.res.root.quota === true;` and, per operation:
- `open` with `O_CREAT`: `lstat` first; a new name reserves 1 entry. With truncation, after the truncate `settle(0, 0, -oldSize, 0)`. The descriptor entry records `pos: 0`, `append: (flags & O_APPEND) !== 0`, `quota: quotaRoot(p)`.
- `write`: inside `serial`, `const st = await e.fh.stat(); const at = position != null ? position : (e.append ? st.size : e.pos); const growth = Math.max(0, at + buf.length - st.size);` reserve `growth`; after the write settle with `Math.max(0, at + r.bytesWritten - st.size)`; when `position == null` and not append, `e.pos = at + r.bytesWritten`. `read` with a null position advances `e.pos` by `bytesRead`.
- `ftruncate` / `truncate`: `stat` first; growth `max(0, len - size)` reserved; afterwards settle with `len - size` (negative releases).
- `mkdir` (recursive: count the missing components by `lstat` walking down first), `mkdtemp`, `symlink`, `link`: 1 entry each (the missing count for recursive mkdir).
- `copyFile`: reserve `srcSize - (dstExists ? dstSize : 0)` bytes and `dstExists ? 0 : 1` entries; settle with the same after success.
- `rename` within a quota root: `lstat` source and destination first; if they are the same inode (`dev` and `ino` equal: a rename to itself or to another name of the same file, which POSIX leaves unchanged), settle nothing (review I2). Otherwise, if the destination exists and is a file with `nlink === 1`, settle `-dstSize` bytes and `-1` entry after success; a file with more links, `-1` entry only; a directory destination (empty, per rename's rules) `-1` entry.
- `unlink`: `lstat` first; after success `-1` entry and `-size` bytes when `nlink === 1` and it is a file.
- `rmdir`: `-1` entry. `rm`: before removing, measure the subtree with `spawnWalk.measure([[host, virtual]], {whollyInside: true})` plus the node itself (a lone file: its size only when `nlink === 1`); after success settle `-bytes`, `-entries`. `whollyInside` is what stops the hard-link release loop (review I1).

`lib/fs-broker/index.js`: `quota = (cfg.mode === 'off' || cfg.limits == null) ? null : new Quota({maxBytes: cfg.limits.diskMb * 1024 * 1024, maxEntries: cfg.limits.diskEntries, enforce: cfg.mode === 'enforce', report: cfg.report, bytes: usage.bytes, entries: usage.entries})`, passed as `new FsBroker({..., quota})`. `03-broker.js`'s `setup()` passes `opts.quota` through as `new Quota({...opts.quota, enforce: mode === 'enforce', report})` when given.

- [ ] **Step 4: Run** `npx mocha --exit test/fs-broker/16-quota.js test/fs-broker/03-broker.js test/fs-broker/05-broker-2b.js test/fs-broker/07-patch.js test/fs-broker/08-differential.js`, then (tell the reviewer: 9626) `npx mocha --exit test/fs-broker/09-wired.js` → all passing.
- [ ] **Step 5: Commit** `feat(fs-broker): per-module disk quota on /data and /tmp`.

---

### Task 4: The per-name lifecycle lock

**Files:**
- Create: `lib/module-lifecycle.js`, `test/module-loading/14-lifecycle.js`
- Modify: `lib/fs-broker/broker.js` (in-flight count, `idle()`), `lib/module-manager.js` (`spawnModuleWorker` runs under the lock; registers each live worker's settle promise)

**Interfaces:**
- Produces: `new ModuleLifecycle()` with `run(name, fn) → Promise` (one at a time per name), `track(name, {exited: Promise, settled: Promise, terminate: () => Promise})`, `live(name) → entry | null` (tracked and not yet exited), `settled(name) → Promise`; `FsBroker.prototype.idle() → Promise` (resolves when no operation is running).

- [ ] **Step 1: Write the failing tests.** Unit, in `test/module-loading/14-lifecycle.js`:

```js
const assert = require('assert');
const {ModuleLifecycle} = require('../../lib/module-lifecycle');

describe('module-loading 14: the per-name lifecycle lock', () => {
  it('runs one critical section per name at a time, others in parallel', async () => {
    const l = new ModuleLifecycle();
    const order = [];
    const slow = (tag, ms) => () => new Promise((r) => setTimeout(() => { order.push(tag); r(); }, ms));
    await Promise.all([l.run('a', slow('a1', 50)), l.run('a', slow('a2', 1)), l.run('b', slow('b1', 1))]);
    assert.deepStrictEqual(order, ['b1', 'a1', 'a2']);
  });

  it('a worker is live until it exits, and settled(name) waits beyond that for its broker (review I5)', async () => {
    const l = new ModuleLifecycle();
    let exit;
    let done;
    l.track('a', {exited: new Promise((r) => { exit = r; }), settled: new Promise((r) => { done = r; }), terminate: async () => {}});
    assert.notStrictEqual(l.live('a'), null);
    let passed = false;
    const waiting = l.settled('a').then(() => { passed = true; });
    exit();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(l.live('a'), null, 'exited: no longer live');
    assert.strictEqual(passed, false, 'but not settled yet');
    done();
    await waiting;
    assert.strictEqual(passed, true);
  });

  it('the broker delay hook is ignored without the test-only variable (review M1)', () => {
    const {testDelayMs} = require('../../lib/fs-broker/broker');
    assert.strictEqual(testDelayMs({COUNTINGHOUSE_TEST_BROKER_DELAY_MS: '1500'}), 0);
    assert.strictEqual(testDelayMs({COUNTINGHOUSE_TEST_BROKER_DELAY_MS: '1500', COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG: '1'}), 1500);
  });
});
```

and a wired test (port 9634): a fixture handler `slowWrite` in `fs-probe` that starts `fs.promises.writeFile('/tmp/slow', <8 MB>)` and returns at once; the broker is given a test hook through `COUNTINGHOUSE_TEST_BROKER_DELAY_MS=1500` (read only when `COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG` is set, like the thread-flag guard) that delays each `write` by that much; call `slowWrite`, then `POST /restart-module {name: 'fs-probe'}` at once; assert the server log shows the new spawn's `/tmp` emptying after the old broker's last write settled (`file broker: fs-probe settled` logged by the lock before `spawn walk` for the next spawn), and that `/tmp/slow` does not exist in the new worker. A second wired case (review I5): with the delay hook holding a write, crash the worker (the fixture's `exit` action, `process.exit(1)`); the supervisor's restart after its backoff must succeed (not "superseded"), and its walk must come after `fs-probe settled`.
- [ ] **Step 2: Run** them → FAIL (no module; restart empties `/tmp` while the write still runs).
- [ ] **Step 3: Implement** `lib/module-lifecycle.js`:

```js
// One lock per module name (spec section 3, "Worker end"; section 7). A
// spawn's critical section, from waiting for the previous broker to settle
// through the walk and the new broker, runs alone for its name, and so does
// uninstall's deletion. A tracked entry is the live worker of that name:
// settled resolves once the worker is gone and its broker idle.
class ModuleLifecycle {
  constructor() {
    this.chains = new Map();
    this.entries = new Map();
  }

  run(name, fn) {
    const prev = this.chains.get(name) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.chains.set(name, tail);
    tail.then(() => { if (this.chains.get(name) === tail) this.chains.delete(name); });
    return next;
  }

  track(name, entry) {
    entry.hasExited = false;
    this.entries.set(name, entry);
    entry.exited.then(() => { entry.hasExited = true; });
    entry.settled.then(() => { if (this.entries.get(name) === entry) this.entries.delete(name); });
  }

  // Live: tracked and not yet exited. An exited worker whose broker is still
  // settling is not live (review I5), but settled() still waits for it.
  live(name) {
    const e = this.entries.get(name);
    return (e != null && !e.hasExited) ? e : null;
  }

  settled(name) {
    const e = this.entries.get(name);
    return e == null ? Promise.resolve() : e.settled;
  }
}

module.exports = {ModuleLifecycle};
```

`FsBroker`: `this.inFlight = 0; this.idleWaiters = [];` — `handle()` increments before `spec.run` and, in `finally`, decrements and resolves the waiters at zero; `idle()` returns a resolved promise at zero, else a new waiter.

`ModuleManager`: `this.lifecycle = new ModuleLifecycle()` in the constructor. `spawnModuleWorker` wraps the part from `createForWorker` to the worker's start in `this.lifecycle.run(name, async () => { ... })`:
1. `const live = this.lifecycle.live(name)`; if `live != null`: when `stillWanted` is given (a supervisor restart), fail with `new Error('module sandbox: restart superseded by an operator action')`; otherwise `await live.terminate()`. Then `await this.lifecycle.settled(name)`.
2. `const fsb = await createForWorker(...)` (the walk runs here, Task 2), then `startWorker(fsb)` as today.
3. After `new Worker`, `this.lifecycle.track(name, {exited, settled, terminate: () => worker.terminate()})` where `exited = new Promise((r) => worker.once('exit', r))` and `settled = exited.then(() => fsb.bridge.close()).then(() => fsb.broker.idle()).then(() => LOG.I(`file broker: ${name} settled`))`.
The test delay hook: `broker.js` exports `testDelayMs(env)` (0 unless `env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG` is set, else `Number(env.COUNTINGHOUSE_TEST_BROKER_DELAY_MS) || 0`), read once at module load into a constant; `write` awaits that many ms when it is non-zero (review M1).
Log `file broker: ${name} spawn walk` at the start of the walk (in `createForWorker`, through `cfg.report`-like logging) so the ordering is visible.
- [ ] **Step 4: Run** `npx mocha --exit test/module-loading/14-lifecycle.js`, then (tell the reviewer) `npx mocha --exit test/fs-broker/09-wired.js test/sandbox/06-supervisor.js test/module-loading/*.js` → all passing. Ledger: closes plan 2b I1 (overlapping spawns) and, with Task 2, plan 2a M3.
- [ ] **Step 5: Commit** `feat(sandbox): a per-name lifecycle lock for spawns and uninstall`.

---

### Task 5: POST /uninstall-module

**Files:**
- Create: `lib/routes/uninstall-module.js`, `test/sandbox/17-uninstall.js`
- Modify: `lib/route-manager.js` (mounted with `adminOnly`), `lib/module-manager.js` (`uninstallModule(name, keepData, cb)`), `lib/error-info.en-US.json` and `lib/error-info.zh-CN.json` (`MODULE_NAME_INVALID`, `MODULE_LOADED`, `MODULE_DATA_NOT_DIRECTORY`)

**Interfaces:**
- Produces: `ModuleManager.prototype.uninstallModule(name, keepData, callback(err, {name, dataDeleted, registryEntryRemoved}))`; route `POST /uninstall-module {name, keepData}` → `200 {uninstalled: true, name, dataDeleted, registryEntryRemoved}` or the error.

- [ ] **Step 1: Write the failing tests** — `test/sandbox/17-uninstall.js` (port 9635; tell the reviewer), each with its own `--moduleDataPath` under `test/.tmp`:
  - loaded `fs-probe` → `POST /uninstall-module {name: 'fs-probe'}` → error `MODULE_LOADED`; data still there;
  - `POST /unload-module {name: 'fs-probe'}`, then uninstall → `{dataDeleted: true}` and `<store>/fs-probe` gone; with `keepData: true` → `{dataDeleted: false}`, directory kept;
  - `name: '../x'`, `name: 'a/b/c'`, `name: ''` → `MODULE_NAME_INVALID`, and nothing outside the store touched;
  - a scoped name (`@scope/probe`, data created by hand under `<store>/@scope/probe`) → deleted, and the empty `<store>/@scope` with it;
  - unload, then uninstall at once while the old broker is still settling (delay hook) → succeeds after the settle, never `MODULE_LOADED` (review I5);
  - `<store>/fs-probe` replaced by a symlink to a directory outside → uninstall refuses (the data root is not a real directory) and the outside directory is intact;
  - a suspended module (the existing supervisor test fixture `sandbox-hog` driven to suspension, as in `06-supervisor.js`) → `MODULE_LOADED` (message says suspended);
  - racing: start `POST /load-module` and `POST /uninstall-module` for the same name together (after an unload); assert either uninstall refused with `MODULE_LOADED` and the module works, or uninstall succeeded and the load that followed sees an empty `/data` — never a 500 and never a worker with `/data` missing;
  - non-admin key → 403 (the `adminOnly` behaviour the other routes have).
- [ ] **Step 2: Run** them → FAIL (404).
- [ ] **Step 3: Implement.** `uninstallModule(name, keepData, callback)`:

```js
// POST /uninstall-module (spec section 7): the module's data and registry
// entry, never its code. Refused while it is loaded, restarting or
// suspended; the deletion runs under the module's lifecycle lock.
ModuleManager.prototype.uninstallModule = function(name, keepData, callback) {
  const moduleData = require('./module-data');
  if (typeof(name) !== 'string' || !moduleData.safeName(name)) return callback(new CHError('MODULE_NAME_INVALID', String(name)));
  const status = this.supervisor != null ? this.supervisor.status(name) : null;
  if (this.modules[name] != null || this.lifecycle.live(name) != null || status != null) {
    return callback(new CHError('MODULE_LOADED', name, status != null ? status.state : 'loaded'));
  }
  this.lifecycle.run(name, async () => {
    await this.lifecycle.settled(name);
    if (this.modules[name] != null || this.lifecycle.live(name) != null) throw new CHError('MODULE_LOADED', name, 'loaded');
    let dataDeleted = false;
    if (keepData !== true) {
      const root = moduleData.dirsFor(options.moduleDataPath, name).root;
      let st = null;
      try { st = await require('fs/promises').lstat(root); } catch (e) { st = null; }
      if (st != null) {
        if (!st.isDirectory()) throw new CHError('MODULE_DATA_NOT_DIRECTORY', name, root);
        await require('fs/promises').rm(root, {recursive: true, force: true});
        dataDeleted = true;
        // A scoped name leaves <store>/@scope behind: remove it when empty (review M2).
        if (name.startsWith('@')) await require('fs/promises').rmdir(require('path').dirname(root)).catch(() => {});
      }
    }
    const registryEntryRemoved = await removeRegistryEntry(name);
    return {name, dataDeleted, registryEntryRemoved};
  }).then((r) => callback(null, r), (e) => callback(e));
};
```

with `removeRegistryEntry(name)` resolving `false` when `options.localModulePath != null` (the registry is not used) and otherwise calling `require('./device-db').removeModuleInfo(name, cb)` → `true`. Add the error codes (`MODULE_NAME_INVALID` 400, `MODULE_LOADED` 409, `MODULE_DATA_NOT_DIRECTORY` 409) to both `lib/error-info.en-US.json` and `lib/error-info.zh-CN.json`, following the shape of `MODULE_SANDBOX_REFUSED` there (the Chinese text may repeat the English until a translator reviews it; note that in the ledger). The route mirrors `lib/routes/restart-module.js` (`{uninstalled: true, ...result}`) and is mounted beside the others with `adminOnly`.
- [ ] **Step 4: Run** `npx mocha --exit test/sandbox/17-uninstall.js` → passing.
- [ ] **Step 5: Commit** `feat(sandbox): POST /uninstall-module`.

---

### Task 6: CHANGELOG and the full suite

- [ ] **Step 1: CHANGELOG** — in `### Added — module sandbox, part 2`: "Each module's `/data` and `/tmp` share a disk quota (`diskMb`, default 1024; `diskEntries`, default 100000; module `limits`, narrowed by the policy): `ENOSPC` under `enforce`, logged at 75 % and 100 % under `audit`, not counted under `off`. `/tmp` is emptied whenever the worker starts. Under `enforce`, a module whose data holds a hard link or a symlink with an absolute target does not start until the operator removes it (the log names the entries). `POST /uninstall-module {name, keepData}` (admin) deletes a module's data and registry entry, never its code; it is refused while the module is loaded, restarting or suspended." Under the 8.0.0 `Changed` section: "Anything a module left in `/tmp` is gone after a restart."
- [ ] **Step 2:** Tell the reviewer, then run the full suite alone: `npm test > .superpowers/part2-plan4-suite.log 2>&1; echo "exit=$?" >> .superpowers/part2-plan4-suite.log`. Expected `exit=0`, 0 thread-flag guard refusals.
- [ ] **Step 3:** Commit the CHANGELOG, send the reviewer the range and the result, and write plan 5.
