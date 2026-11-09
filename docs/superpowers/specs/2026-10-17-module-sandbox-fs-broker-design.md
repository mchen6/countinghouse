# Module sandbox, part 2 — file broker and virtual paths

The second of four sub-projects that harden how countinghouse runs module
code (part 1: `docs/superpowers/specs/2026-10-15-module-sandbox-foundation-design.md`).
Part 2 puts every file access a module makes behind the main thread, gives
each module its own file namespace, and closes the routes part 1 left around
the `require` boundary. It ships as **8.0.0**, together with `--workerThread`
becoming the default and a Node floor of 24.15 *(amended 2026-11-04; was
22.16)*.

Designed with the user on 2026-10-17, and reviewed section by section by a
second Claude Code session acting as reviewer. Every decision below was
either made by the user or agreed between author and reviewer. The user
delegated approval of this text to the reviewer's agreement. Verified
against `master` at `fd6daee`. The spikes behind the claims marked
*(spiked)* ran on Node 24.21 in throwaway code; their results are summarised
in [Spike results](#spike-results).

**Amended 2026-11-04** (plan 5 Task 6, approved by the user): the spec now
says what plans 3-5 built. Each changed passage is marked *(amended 2026-11-04)*.

## The problem

Part 1 gave each module's worker a lockdown, limits and a policy, but no file
permission: `docs/security-model.md` says "a module can read and write what
the process user can". Under any mode a module can read `auth.json` (every
tenant's keys), other modules' code and data, and anything else the service
user can reach. It can also write over them. Part 1 also left routes through
countinghouse's own loader: `module.parent.require(...)`,
`require.cache[...].require(...)`, `Module._load(...)` and the `vm.Script`
dynamic-`import()` referrer reach any file even if `fs` were brokered.

## Decisions

Made by the user during design:

1. **Sync `fs` calls go over a blocking bridge.** The worker posts a request
   and waits on shared memory; the main thread does the I/O asynchronously and
   wakes it. The main thread never blocks.
2. **All of `fs` is brokered except watching.** Path calls, descriptor calls
   and streams, in sync, callback and promise forms. `fs.watch`,
   `fs.watchFile` and `fs.promises.watch` answer
   `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
3. **A per-module disk quota** on `/data` and `/tmp`, enforced by the broker.
4. **`/app` (the module's code) is read-only under `enforce`,** and writable
   but logged under `audit`.
5. **Architecture: patch `fs` in place in the worker**, with two transports
   (sync bridge, async messages) and one broker per worker on the main thread.
6. **Modules see the same virtual paths in every mode** (`off`, `audit`,
   `enforce`, and single-thread mode), with the single-thread differences
   listed in [section 6](#6-single-thread-mode). `--moduleSandbox off` turns
   off enforcement and logging, not the broker.
7. **Single-thread mode is debug-only;** modules still see virtual paths
   there, through a lighter mechanism ([section 6](#6-single-thread-mode)).
   Identity stays the host path in that mode (option "a" of the collision
   question).
8. **8.0.0:** Node >= 24.15 *(amended 2026-11-04, user decision: Node 22
   dropped; see section 5)*; `--workerThread` becomes the default (its own
   change); the part 1 spec is amended where it promised "off is today's
   behaviour" and "no new hop".
9. **Link rules apply in every `--moduleSandbox` mode** (`off`, `audit`,
   `enforce`; [section 3](#3-the-broker)). Single-thread mode has none.
10. **A load whose request name differs from its package.json name is
    refused** in every mode (`MODULE_NAME_MISMATCH`).
11. **Uninstall** is a new admin route that deletes a module's data unless
    told to keep it.
12. **Countinghouse installed under `/app` is refused under `--workerThread`**
    (amendment, 2026-10-17, found while planning part 2's plan 3). Modules see
    their files as `/app/...`, and Node keys loaded code (`require.cache`,
    the ES module map) by that path, so a countinghouse whose own code lives
    under `/app` would share entries with its modules, and a module could be
    handed countinghouse's own module objects. No hook can separate them. The
    start-up check uses the install directory's real path and exits 2 with
    advice (install elsewhere, e.g. `/opt/countinghouse`, or use
    `--no-workerThread`); a worker also refuses a load if any code it has
    loaded lives under `/app`. Single-thread mode, and modules or data under
    `/app`, are unaffected. The user chose refusal over renaming the virtual
    root.
13. Earlier, part 1 design: out-of-namespace access is `ENOENT` to the module
    plus a host log line; outside paths are declared `r`/`rw` in
    `countinghouse.permissions.fs` and narrowed by the operator; modules stay
    standard npm packages.

## What this can and cannot promise

**Only `enforce` protects files.** Under `audit` (the default) and `off`,
access outside the namespace passes through to the host, so `auth.json` and
other modules' files stay readable; those modes give modules virtual paths
and give operators a report, not protection.

Under `enforce`, module code cannot read or write a host file outside its
install directory (read-only), its data and temp directories, and the paths
it declared and the operator approved, by the routes this design knows of;
the known exceptions are listed in [Gaps](#gaps-that-remain). As in part 1,
everything still runs in one process with countinghouse: an overlooked
internal API or a V8 bug gets past it, and module code can reach
countinghouse's objects (part 1's R3 gap: `CHUtil.ci`, the worker's channel to
the main thread) and countinghouse's own code files. Network access stays open
until parts 3 and 4. Host processes writing inside a data or declared path at
the same moment can race the broker's checks. This is a strong barrier, not
a hard boundary against code written to defeat it.

## 1. The virtual namespace

What a module sees, in every mode, under `--workerThread`:

| Virtual path | Host path | Access |
|---|---|---|
| `/app` | the module's install directory | read-only under `enforce` (`EROFS`); writes allowed and logged under `audit`, allowed under `off` |
| `/data` | `<moduleDataPath>/<name>/data` | read-write, quota, kept across restarts |
| `/tmp` | `<moduleDataPath>/<name>/tmp` | read-write, quota, emptied when the worker starts |
| each declared path, e.g. `/var/log/app` | the same host path | `r` or `rw` as narrowed by the policy; no quota |

- **`--moduleDataPath`** (new), default `$HOME/.countinghouse/module_data`
  *(amended 2026-11-04, user decision; was `$HOME/countinghouse_module_data`,
  whose name extends a likely install directory, `$HOME/countinghouse`, which
  Node's permission model mishandles under `--hardened`)*. The
  directory and each module's directories are created with mode `0700`.
  `<name>` is the **package.json name the main thread verified**, never the
  load request's `name`. Part 2 moves part 1's policy lookup
  (`lib/module-sandbox-config.js`, today keyed by the request's name) to the
  same verified name, and refuses a load whose request `name` differs from
  the package.json name, in every mode (`MODULE_NAME_MISMATCH`). Otherwise any
  code loaded under another module's name would get that module's policy
  entry and data. The user chose refusal over ignoring the request's `name`
  (2026-10-17). It changes part 1's behaviour in every mode, `off` included,
  and goes in the part 1 amendment and the upgrade section. Scoped names use the
  `node_modules` layout (`@scope/name`), which is injective; the encoding has
  a test.
- **Virtual everywhere a module looks:** `__filename`, `__dirname`,
  `require.resolve`, `require.resolve.paths`, `module.paths`, `require.cache`
  keys, `import.meta.url`/`dirname`/`filename`, stack frames *(spiked)*,
  `process.cwd()` (`/app`) and `os.tmpdir()` (`/tmp`). Paths in results and
  errors are virtual ([section 3](#3-the-broker)).
- **Ancestors of a root** (`/`, `/var`, `/var/log` for a declared
  `/var/log/app`) answer as synthesised read-only directories that list only
  the next component on the way to a root — unless a declared root covers
  them, in which case the real directory answers.
- **Outside the namespace:** `enforce` answers `ENOENT` and logs; `audit`
  passes through to the host path and logs once per (module, rule, target);
  `off` passes through silently. Socket paths are outside this rule until
  part 4 ([Gaps](#gaps-that-remain)).
- **Declared paths can never cover countinghouse's own directories.** A
  declaration that overlaps the install directory, `--modulePath`,
  `--moduleDataPath`, the auth or device-config paths, or the policy file — or
  is an ancestor of any of them — is refused in every mode whatever the policy
  says, and logged at spawn.
- **Uninstall:** `POST /uninstall-module {name, keepData}` ([section 7](#7-uninstall)).
  Unload, restart and reload never delete data.

## 2. The worker side

### Patching `fs` first

The lockdown configuration travels in `workerData` at spawn. The first
statements of `lib/sandbox.js` capture what the bridge needs (`MessagePort`,
`receiveMessageOnPort`, `Atomics`), then replace every method of the shared
`fs` and `fs/promises` objects and of `FileHandle.prototype`, before any
countinghouse or dependency code loads. Each replacement is locked
(non-writable, non-configurable); the originals live only in lockdown's
closure. Nothing in the worker then holds an unbrokered `fs` except Node's
internals and lockdown itself. Part 1's remaining lockdown still installs at
`set-options`.

**Fail closed.** Every key of `fs`, `fs.promises` and `FileHandle.prototype` is
either handled by the broker or replaced by a function that throws. A test
fails when the running Node has a key the list does not account for (the same
pattern as part 1's built-in allowlist). Keys that are easy to miss and are
handled: `realpathSync.native`/`realpath.native`, `cp`/`cpSync`,
`glob`/`globSync`, `opendir`/`Dir`, `openAsBlob`, `statfs`, `readv`/`writev`,
`exists`/`existsSync`, `FileHandle#readLines`/`readableWebStream`/
`createReadStream`/`createWriteStream`, and the `fs` and `flush` options of
the stream constructors. `Stats`, `BigIntStats` and `Dirent` results are real
instances rebuilt in the worker. File streams look up `fs` methods at call
time and so go through the patch *(spiked)*.

### The bridge

Two `MessageChannel`s per worker: one for sync calls, one for async calls, so
a sync wait never consumes an async reply. Plus a 4-byte `SharedArrayBuffer`
holding a sequence number.

- **Sync call:** the worker posts `{id, op, args}` on the sync port. Then, in
  a loop: read the flag; drain the sync port with `receiveMessageOnPort`,
  returning on the reply whose `id` matches and discarding stale replies;
  otherwise `Atomics.wait(flag, 0, valueJustRead, remaining)`. Reading the
  flag before draining is required: waiting on a value the reply already set
  sleeps until the timeout *(spiked)*. The main thread posts the full result
  on the port, then `Atomics.store(flag, 0, id)` and `Atomics.notify`.
  Results of any size come back in one structured clone (a 20 MB Buffer in
  the spike); about 92 µs per round trip on a 1-CPU VM *(spiked)*.
- **Async call:** the same request shape on the async port; replies are
  dispatched by `id` to callbacks and promises.
- **Every outcome comes back on the bridge,** refusals included — never on
  `parentPort`, which a waiting worker cannot read.
- **Deadlines:** the broker answers `ETIMEDOUT` after 30 s. The worker's own
  backstop is 35 s and answers `EIO`, meaning the broker is gone.
  `worker.terminate()` interrupts a waiting worker *(spiked: 13–120 ms)*.
- **Heartbeat:** a worker with a bridge request in flight is not "blocked" for
  part 1's `maxBlockMs`. Its time is spent by the main thread.
- **Errors** are rebuilt as Node errors (`code`, `errno`, `syscall`, virtual
  `path`/`dest`).
- **Descriptors** are numbers from the main thread's table. `0` answers
  `EBADF`; `1` and `2` go to the module's console path for `write`,
  `writeSync`, `writev` and `writevSync` (so `pino`'s `fs.writeSync(1, …)` and
  `sonic-boom` work; release mode silences them as it silences `console`).

### The loader

Node's loader calls the public `fs` at call time (`realpathSync`,
`readFileSync`, `openSync`/`readSync`). The hooks decide that traffic:

- **Module identity is virtual.** The resolve hook returns `file:///app/...`
  URLs; the load hook reads the host file and returns `source`. Node's default
  CommonJS resolver works from the parent `Module` object, not
  `ctx.parentURL`, so the hook resolves module-parent specifiers itself:
  relative and `/app` specifiers against the host directory, bare CommonJS
  specifiers with `Module.createRequire(hostParent).resolve`, ESM through
  `next()` with a host `parentURL`. A virtual absolute specifier from a
  countinghouse parent (load-module's `/app`) is mapped too *(spiked)*.
- **Original-fs access is scoped by path (L1),** never granted for a stretch
  of time. Two rules, and nothing else is served by the originals:
  - during a resolve, `realpathSync` and `statSync`/`lstatSync` for paths under
    the roots that parent may reach (L2);
  - during a load, reads of the one checked target.

  Every other call, even inside a hook, goes to the broker with the module's
  rights. Run with this rule in force and everything else answering `ENOENT`,
  a relative `require`, a bare dependency, a JSON `require`, an ES module
  import, `createRequire(import.meta.url)` and a countinghouse lazy `require`
  after lockdown all loaded with no denied call *(spiked)*.
- **The re-entry guard recognises only the hook's own inner call.**
  `Module.createRequire(...).resolve` passes back through the hooks, so the
  hook records the exact (specifier, parent) pair just before its inner call
  and skips its logic only for a re-entered resolve matching that pair. Any
  other resolve during the window, such as a `require` made by module code
  from a getter, gets the full checks; a test has such a getter `require` an
  outside absolute path and expects `MODULE_NOT_FOUND` under `enforce`.
- **Every resolve is bounded from `set-options` onwards (L2), whoever the
  parent is.** *(amended 2026-11-04)* The boot window, from worker start to `set-options`, runs
  only countinghouse's own code, before any module code exists: it is served
  under a boot grant for countinghouse's code roots, and anything else it
  touches is answered `ENOENT` and logged once as countinghouse's own, in
  every mode. From `set-options` on, a countinghouse parent may reach only
  its code roots plus the module root. Anything else is `MODULE_NOT_FOUND`
  under `enforce` and logged under `audit`.
- **Code roots** *(amended 2026-11-04)*: countinghouse's own entries (`lib/`, `package.json`,
  `spec/schema.json`) and the package directory of each package in its
  dependency closure (dependencies, optional and peer dependencies,
  transitively), found the way Node finds them so a hoisted npm install
  works, minus every module root. Never a whole `node_modules`, which may
  hold other modules. A dependency installed as a symlink (pnpm, a linked
  `node_modules`) is a root under the name Node looks it up by and under its
  real path; a module root excludes both. One list serves the boot grant,
  L2, the loader lookups below and `--hardened`'s read grants.
- **The loader's own lookups under `enforce`** *(amended 2026-11-04)*: `Module._stat`,
  `_findPath`, `_resolveFilename`, `_readPackage` and `findPackageJSON` stat
  and read natively, past the broker; under `enforce` they answer missing
  outside the module root and the code roots, so a module cannot probe host
  paths through them. Under `audit` and `off` they are unchanged (outside
  access passes through there anyway). This
  closes `module.parent.require`, `require.cache[lib].require`,
  `Module._load(path, cmModule)`, `Module.prototype.require.call(cmModule,
  path)` and the `vm.Script` `import()` referrer as routes to files.

**No privileged requests (A4).** Module code can reach the worker's channels
(part 1, R3), so the broker gives every request the module's rights.
Countinghouse's worker code therefore speaks virtual paths: load-module
carries `/app`, and `package.json`, `api.json`, `schema.json` and the
handlers are read through `/app`. Anything it needs from outside the
namespace (device config and the like) comes from the main thread in a
message. The plan begins with a survey of every post-lockdown `fs`, `cwd` and
`tmpdir` use in `lib/`.

### Other routes to files

| Route | Treatment |
|---|---|
| `process.loadEnvFile(path)` | brokered |
| `module.enableCompileCache(dir)` | locked |
| `process.report.writeReport`, `report.directory`/`filename` | locked |
| `process.setSourceMapsEnabled` (the loader reads `sourceMappingURL` paths) | locked |
| `repl`, `trace_events` | removed from the built-in allowlist |
| `net.Socket({fd})`, `net.Socket({handle})`, `tty.ReadStream`/`WriteStream(fd)`, `server.listen({fd})` and `server.listen(handle)` on `net`, `http`, `https` and `http2` servers, and `tls.TLSSocket` wrapping any of them | the `fd`/`handle` option is refused under `enforce`, logged under `audit`. In the spike a worker adopted the main thread's real listening socket with `net.Socket({fd})`, and with `listen({fd})` on `net` and `http` servers took over the main server's connections *(spiked)* |
| HTTP/2 `respondWithFD(fd)` *(amended 2026-11-04)* | refused under `enforce`, logged under `audit` (it sends a real descriptor's contents natively) |
| HTTP/2 `respondWithFile(path)` *(amended 2026-11-04)* | not available to modules in any mode (`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`): it hands the brokered descriptor to native code, which cannot read it (user decision) |
| Unix-socket paths (`net.connect(path)`, `http.request({socketPath})`) | a gap until part 4 |

*(amended 2026-11-04)* Plan 3's sweep of the allowlisted built-ins found three routes:
`respondWithFD` and `respondWithFile` (above) and the loader's own lookups
(section 2, "The loader"). `dns`, `tls`, `crypto`, `zlib`, `vm`, `dgram`
(whose `bind({fd})` was already locked), `tty`, `net` and the rest needed
nothing further.

## 3. The broker

One `FsBroker` per module worker, created at spawn. Its inputs: the verified
package name, the mode, the host install root, the data directory, the
effective `fs` declarations, and the quota.

**Per request:**

1. **Translate** virtual to host: longest root match (`/app`, `/data`,
   `/tmp`, declared); relative paths against `/app`; synthesised ancestors as
   in section 1.
2. **Decide** by mode: outside the namespace, `/app` writes and writes to `r`
   paths, as in section 1.
3. **Check on the host:** `lstat` each component and keep the leaf's
   device+inode. The real target must lie inside its root or a declared path,
   compared against roots that were realpath'd at spawn. Under `enforce`
   anything else is `ENOENT`; under `audit` it is logged.
4. **Run** the operation with Node's async `fs`.
5. **Verify after open:** the descriptor's `fstat` device+inode must equal the
   leaf identity from step 3; on Linux also `readlink /proc/self/fd/N`. For
   creation, re-`lstat` the parent chain. On a mismatch, close and answer
   `ENOENT`.

*(amended 2026-11-04)* Three optimisations (user decision, plan 5 Task 4b; commits `b977146`,
`60ca7e8`, `9246db1`):
- Under `off` the broker makes no host checks (step 3), since `off` decides
  nothing about files; post-open verification was already enforce-only. The
  link rules, `EXDEV`, `EBUSY` on roots and the special-file check after open
  still run.
- `writeFile` and `appendFile` on a path are one brokered operation: open,
  write and close inside the broker, with the quota, the verification and
  the checks unchanged.
- Each broker caches directory real paths for up to 1 s and 1024 entries.
  Every operation that takes the exclusive lock clears the cache first; only
  directories are cached, never the file a call names; under `enforce`
  opened descriptors are still verified without the cache.

**Per-module read/write lock.** Mutating operations (write, rename, unlink,
mkdir, rm, link, symlink, chmod, truncate, utimes…) take it exclusively;
every path-resolving operation, reads and opens included, takes it shared. A
module cannot race itself.

**Link rules, in every `--moduleSandbox` mode:** `link()` only within one
writable root, and counted where the quota is counted; `symlink()` only with a relative target that
resolves inside the same root; absolute targets are `EPERM`. *(Amended 2026-11-09, FB1:)* the target
may hold no `..` segment, and is decided by where it really leads — walked from the real path of the
link's directory, following links on the way — not by its text; text alone let `x -> "."` then
`y -> "x/.."` lead to the root's parent, and a `..` that stays inside at creation can lead out after a
rename. `chmod` and
`fchmod` strip setuid, setgid and sticky bits. Under `enforce`, the spawn walk
refuses to start a module whose `/data` or `/tmp` holds a link that can lead
outside *(amended 2026-11-04)*: a symlink with an absolute target, or a hard link to a file that
also has a name outside `/data` and `/tmp`. A hard link the module made
inside them, which the link rules allow, is fine. The log names the entries.
The operator clears that by removing or replacing them under
`<moduleDataPath>/<name>/`, then `POST /restart-module`.

**Results back to virtual:** `realpath`, `mkdtemp`, `Dirent.parentPath`/`path`,
`Dir.path`, `glob` results, and `err.path`, `err.dest` and the message.
Cross-root `rename` answers `EXDEV`, so copy fallbacks work.

**Descriptor table:** at most 256 per worker, numbered from 3 in the broker,
operations on one descriptor serialised, all closed when the worker exits.
*(amended 2026-11-04)* Module code sees `0x10000000 + n` for broker descriptor `n`, so a
brokered descriptor is never mistaken for a real one.

**Quota:**
- At spawn: empty `/tmp` (lstat; never follow links), then measure `/data` and
  `/tmp` with an asynchronous walk; the spawn waits for it.
- `diskMb` (default ceiling 1024) and `diskEntries` (default ceiling 100000):
  module `limits`, narrowed by the policy as part 1's limits are. One pool for
  `/data` and `/tmp`.
- Reserve before a write; count logical growth (positional writes and
  `ftruncate` up count to the new length).
- `enforce`: `ENOSPC`. `audit`: logged at threshold crossings. `off`: not
  counted.

**Main-thread protection, in every mode:**
- `UV_THREADPOOL_SIZE` is raised to 16 at the top of `framework.js` unless the
  operator set it, and is passed to `--hardened`'s relaunch.
- A global cap on brokered operations in flight: `max(1, floor(size × 3/4))`,
  logged at startup, with the size-4 case tested.
- Scheduling is round-robin across workers, at most 2 in flight per worker
  while others wait.
- A queue of 4096 per worker; past it, `EMFILE` (which `graceful-fs` and its
  kind retry).
- At most 16 MB per transfer; `readFile` and friends are served as chunked
  reads the worker assembles, so the main thread holds one chunk.
- File traffic has its own budget, outside `--moduleMessageRate`.

**Worker end** (restart, crash, unload): operations in flight reject `EIO`,
descriptors close, the broker is discarded. A per-name lifecycle lock makes the
next spawn wait for the old broker's operations to settle before it empties
`/tmp` and walks, and keeps uninstall's deletion and a load of the same name
apart. *(amended 2026-11-04)* The wait is bounded at 35 s (the bridge's 30 s deadline plus a
margin); past it the next spawn goes ahead and logs what was still running.

## 4. Modes

| | `off` | `audit` | `enforce` |
|---|---|---|---|
| Virtual paths, broker, bridge | yes | yes | yes |
| Link rules, main-thread protection | yes | yes | yes |
| Namespace refusals, `/app` and `r` writes | pass through | pass through, logged | refused |
| Quota | not counted | logged | enforced |
| Part 1 lockdown, limits, clean env | no | yes | yes |

The plan sweeps part 1's `options.moduleSandbox !== 'off'` and
`sandbox != null` branches for anything the broker now relies on in `off`
(the heartbeat exemption, `RATE_EXEMPT`), and keeps the clean worker
environment for `audit` and `enforce` only.

## 5. 8.0.0

1. **Node >= 24.15** *(amended 2026-11-04; was 22.16)*. `package.json`
   engines, the CI matrix (24.15.0, the floor itself, and the newest 24.x),
   and `CLAUDE.md`'s target line. Part 1's `lib/sandbox-support.js` fallback is
   removed. Why 24.15: on Node 22 and on 24.x before 24.15,
   `module.registerHooks` resolve hooks are not called for `require.resolve`
   or `createRequire().resolve`, so module code's `require.resolve` reaches
   Node's resolver with its virtual `/app` path and fails (found by the first
   CI run on 22.23.4; bisected on each minor's latest patch: 24.0.0, 24.10.0,
   24.12.0, 24.13.1 and 24.14.1 skip the hook, 24.15.0, 24.21.0 and 24.22.2
   call it). The user chose dropping Node 22 over a Node-22-only
   `require.resolve` shim.
2. **`--workerThread` is the default** (its own commit). `--no-workerThread`
   selects single-thread mode; `--workerThread false` and
   `--workerThread=false`, which minimist passes as the string `"false"`
   *(spiked)*, are coerced to false. The worker's first `setOptions` call
   passes `{workerThread: false}` explicitly, and the plan sweeps every
   `options.workerThread` read before `set-options`, the authoring tools'
   child process, `bin/countinghouse` and the test helpers.
3. **The test-suite migration is its own task:** each file is either pinned
   to single-thread semantics with `--no-workerThread` or moved to the
   default; part 1's tests about `off` and the defaults (01-modes, the 07
   `off` cases, 10-node-support) are rewritten.
4. **The CHANGELOG has an upgrade section:** write under `/data` or `/tmp`;
   declare outside paths; `__dirname` is `/app/...` and the current directory
   is `/app`; the link rules; what `off` now means; the measured cost of the
   broker under `off` and `enforce`; and a downgrade note (7.x does not see
   data under `--moduleDataPath`). It also tells operators to check, before
   upgrading, for registry entries, `load_module` calls and composite
   `runsModules` bindings whose name differs from the module's package.json
   name, which 8.0.0 refuses, and for countinghouse installed under `/app`,
   which 8.0.0 refuses under `--workerThread` (decision 12).
5. **The part 1 spec is amended:** `off` runs the broker, and part 2 adds a
   hop to every file call; and a load whose request name differs from its
   package.json name is refused in every mode (the user approved all three).

## 6. Single-thread mode

Debug-only: starting modules without `--workerThread` logs a warning that this
mode has no sandbox and is for debugging modules. Modules still see virtual
paths:

- **Identity stays the host path,** so two modules' files never collide in
  `require.cache`. A load-hook prefix sets `__filename` and `__dirname` to the
  file's own virtual values (`/app/lib` for a file in `lib/`). It goes after a
  hashbang line and after the directive prologue (`'use strict'`, leading
  comments), on that same line, so strict mode is kept, the hashbang still
  parses, and line numbers are unchanged. A virtual absolute specifier is
  mapped against the requiring file's module root *(spiked)*.
- Module-parent requests for `fs`, `fs/promises` and `os` (including
  `node:` imports, `process.getBuiltinModule` from module code, and
  `createRequire`) get a per-module facade that translates `/app`, `/data`,
  `/tmp` and declared paths to host paths and translates paths in results
  back. `os.tmpdir()` returns `/tmp`. Relative paths resolve against `/app`.
  Countinghouse APIs that take a path from module code (`CHUtil.loadFile`)
  translate at their boundary. No checks, quota or link rules.
- The data directories are created and `/tmp` emptied at every module load
  *(amended 2026-11-04)*.
- **Documented differences from worker mode:** `process.cwd()` stays real;
  stack frames, `module.filename`, `require.cache` keys and `require.resolve`
  stay host; paths given to non-`fs` APIs are not translated; a module can
  require countinghouse's own dependencies through `NODE_PATH`; ES modules'
  `import.meta.dirname` stays host; *(amended 2026-11-04)* `createRequire` with a virtual (`/app`)
  path fails with `MODULE_NOT_FOUND` (both modules see `/app`, and the
  resolver cannot tell which is meant), so use `require`, or
  `createRequire(import.meta.url)` in ES modules.

## 7. Uninstall

`POST /uninstall-module {name, keepData}`, admin key required. It:
- validates `name` against npm package-name rules before building any path;
- refuses while the module is loaded, restarting or suspended;
- removes the registry entry (`lib/device-db.js` `removeModuleInfo`, which has
  no caller today), first *(amended 2026-11-04)*: if that fails nothing has been deleted
  (`REMOVE_MODULE_INFO_FAIL`), and `registryEntryRemoved` is reported true
  only when an entry existed;
- deletes `<moduleDataPath>/<name>` unless `keepData`, never following links,
  under the per-name lifecycle lock (`MODULE_DATA_NOT_DIRECTORY` if it is a
  link or a file, which is left alone).

It never removes the module's code under `--modulePath`; the docs say so.

## Gaps that remain

Each goes into `docs/security-model.md` and the CHANGELOG:
- Module code can reach countinghouse's objects (the globals, the worker's
  main-thread channel) and countinghouse's own code files; the main thread
  trusts the identity a worker states (part 1, R3; deferred by the user).
- Network access, including Unix-socket paths, until parts 3 and 4.
- Host processes writing inside a data or declared path can race the checks.
- Single-thread mode has no sandbox and only translates paths; there a
  module can also require countinghouse's own dependencies through
  `NODE_PATH`.
- Descriptor and handle adoption (the `fd`/`handle` options) is refused only
  under `enforce`.
- Part 1's gaps remain except the file routes closed here: the
  `CHUtil.request` host check is not a network boundary; `--hardened`'s
  symlink and write-scope limits; native code in the main thread; uncaught
  exceptions do not end a worker; resource limits can misfire.
- *(amended 2026-11-04)* A CommonJS file that an ES module imports directly keeps its host
  `__filename` and host stack frames (Node 24 gives the hooks no way to
  change them); what that file requires is virtual again.
- *(amended 2026-11-04)* The directory real-path cache: a host process's change, or another
  module's change in a shared `rw` directory, can go unseen for up to 1 s;
  under `enforce` every open is still verified.
- *(amended 2026-11-04)* HTTP/2 `respondWithFile` is not available to modules.
- *(amended 2026-11-04)* `--hardened` does not support pnpm installs until nodejs/node#66812 is
  fixed: Node's permission model refuses a granted symlink when another
  grant extends its name, even for a synchronous call (a form of the bug
  found after it was filed).

## Error codes and flags

New flag: `--moduleDataPath`. New limits: `diskMb` and `diskEntries`. New
error codes: `MODULE_NAME_MISMATCH`, and for uninstall *(amended 2026-11-04)*
`MODULE_NAME_INVALID`, `MODULE_LOADED`, `MODULE_DATA_NOT_DIRECTORY` and
`REMOVE_MODULE_INFO_FAIL`. New route: `POST /uninstall-module`. Module-facing
errors are Node's own: `ENOENT`, `EROFS`, `EPERM`, `ENOSPC`, `EMFILE`,
`ETIMEDOUT`, `EIO`, `EXDEV`, `EBADF`, `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
Registry errors for uninstall follow the existing error-info files.

## Docs

`docs/security-model.md` (layers, modes, gaps, the systemd example with
`--moduleDataPath` in `ReadWritePaths`), `docs/module-development.md` (the
namespace, the upgrade guide, single-thread differences),
`docs/cli-and-api-reference.md` (flags, limits, uninstall), the CHANGELOG
upgrade section, and the part 1 spec amendment.

## Testing

- **Spikes first** (done for the design; the plan's first task turns them
  into tests): the bridge, virtual URLs, remaining loader calls, the L1 grant,
  single-thread mapping, fd adoption, streams.
- **A differential test:** one script of `fs` operations against real `fs` in
  a temp directory and against the broker, comparing results and error codes.
- **Fail-closed key tests** for `fs`, `fs.promises` and `FileHandle.prototype`.
- **Route tests:** each of L2's routes, the other-routes table, links,
  symlinks, hard links surviving from `audit`, the race lock, ancestors,
  declared-path overlap with countinghouse's directories.
- **Quota:** sparse files, entries, reservation under concurrency, `EXDEV`.
- **Main-thread protection:** caps, `EMFILE`, chunked reads,
  `UV_THREADPOOL_SIZE=4`.
- **Collisions:** the module and data paths under `/tmp`; countinghouse
  installed under `/app` refused (decision 12), by unit tests of the check,
  since an install at `/app` needs root on a test machine.
- **Lifecycle:** restart while operations are in flight, uninstall racing a
  load, worker end during a sync wait.
- **Single-thread prefix:** `'use strict'` files, hashbang files, a file with
  leading comments, and a nested file.
- **Descriptor and handle adoption:** each form in the routes table.
- **Name mismatch:** a load whose request name differs from package.json.
- **A composition scenario under `enforce`,** the single-thread facade, and
  the full suite.
- **Benchmarks:** test6 and test7 plus a new file-heavy benchmark, `off`
  against `enforce` in the same build, reported in the upgrade section.

## Spike results

Throwaway code, Node 24.21, a 1-CPU VM, 2026-10-17.

- **Bridge:** about 92 µs per round trip; 20 MB in one message; timeouts and
  stale-reply discarding work; `terminate()` interrupts a wait in 13–120 ms;
  the wait must read the flag before draining the port.
- **Virtual URLs in a worker:** all of the identity surfaces listed in section
  1 come out virtual, for CommonJS, JSON, `.cjs`, ES modules and
  `createRequire(import.meta.url)`; `require(path.join(__dirname, …))` returns
  the same instance as the relative `require`.
- **Loader `fs` calls with the path-scoped rule in force** (everything else
  answered `ENOENT` by a stub): no denied call for a relative `require`, a bare
  dependency, JSON, an ES module, `createRequire(import.meta.url)` or a
  countinghouse lazy `require` after lockdown. Served by the originals:
  `realpathSync` under the allowed roots, and `readFileSync` of the target.
- **Single-thread:** two modules both see `/app/index.js` with distinct
  modules and no cache collision; for a `require()`d CommonJS file the load
  hook reads the source itself.
- **fd adoption:** `new net.Socket({fd})` in a worker adopted the main thread's
  listening socket; `server.listen({fd})` on a `net` and an `http` server in a
  worker took over the main server's connections (6 of 6 HTTP requests, 4 of
  6 raw TCP); `tty.WriteStream` refused a file descriptor.
- **Single-thread prefix placement:** after a hashbang and `'use strict'`,
  and after a leading comment and `"use strict"`, strict mode held, the file
  parsed, line numbers were unchanged and a nested file saw `/app/lib`.
- **Streams** call `fs.open`/`read`/`write`/`close` dynamically.
- **minimist** passes `--workerThread false` as the string `"false"`.

## Out of scope

`fs.watch` and friends; network brokering (parts 3, 4); the main thread's
trust in worker-stated identity (deferred by the user); the part 1 deferred
items (keep the last good policy; tools briefly missing during a restart; a
redirect-guard test). Part 1's M7 (async tree walk) becomes required here
for the quota walk.
