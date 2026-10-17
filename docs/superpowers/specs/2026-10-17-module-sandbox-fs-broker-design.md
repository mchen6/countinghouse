# Module sandbox, part 2 — file broker and virtual paths

The second of four sub-projects that harden how countinghouse runs module
code (part 1: `docs/superpowers/specs/2026-10-15-module-sandbox-foundation-design.md`).
Part 2 puts every file access a module makes behind the main thread, gives
each module its own file namespace, and closes the routes part 1 left around
the `require` boundary. It ships as **8.0.0**, together with `--workerThread`
becoming the default and a Node floor of 22.16.

Designed with the user on 2026-10-17, and reviewed section by section by a
second Claude Code session acting as reviewer. Every decision below was
either made by the user or agreed between author and reviewer. The user
delegated approval of this text to the reviewer's agreement. Verified
against `master` at `fd6daee`. The spikes behind the claims marked
*(spiked)* ran on Node 24.21 in throwaway code; their results are summarised
in [Spike results](#spike-results).

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
8. **8.0.0:** Node >= 22.16; `--workerThread` becomes the default (its own
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

- **`--moduleDataPath`** (new), default `$HOME/countinghouse_module_data`. The
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
  parent is.** Countinghouse's boot `require`s of `lib/` and `node_modules/`
  between the `fs` patch and `set-options` are unbounded by design; they run
  before any module code exists. A
  countinghouse parent may reach only `lib/`, `node_modules/` and
  `package.json` under the install directory, plus the module root. Anything
  else is `MODULE_NOT_FOUND` under `enforce` and logged under `audit`. This
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
| Unix-socket paths (`net.connect(path)`, `http.request({socketPath})`) | a gap until part 4 |

This table is not yet known to be complete: the plan's first task sweeps the
allowlisted built-ins for any other file or descriptor access, and anything
found comes back to the reviewer and the user.

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

**Per-module read/write lock.** Mutating operations (write, rename, unlink,
mkdir, rm, link, symlink, chmod, truncate, utimes…) take it exclusively;
every path-resolving operation, reads and opens included, takes it shared. A
module cannot race itself.

**Link rules, in every `--moduleSandbox` mode:** `link()` only within one
writable root, and counted where the quota is counted; `symlink()` only with a relative target that
resolves inside the same root; absolute targets are `EPERM`. `chmod` and
`fchmod` strip setuid, setgid and sticky bits. Under `enforce`, the spawn walk
refuses to start a module whose `/data` or `/tmp` holds a regular file with
more than one link or a symlink with an absolute target, naming the entries.
The operator clears that by removing or replacing them under
`<moduleDataPath>/<name>/`, then `POST /restart-module`.

**Results back to virtual:** `realpath`, `mkdtemp`, `Dirent.parentPath`/`path`,
`Dir.path`, `glob` results, and `err.path`, `err.dest` and the message.
Cross-root `rename` answers `EXDEV`, so copy fallbacks work.

**Descriptor table:** at most 256 per worker, numbered from 3, operations on
one descriptor serialised, all closed when the worker exits.

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
apart.

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

1. **Node >= 22.16.** `package.json` engines, the CI matrix (22 at >= 22.16,
   and 24), and `CLAUDE.md`'s target line (the user asked the author to change
   it). Part 1's `lib/sandbox-support.js` fallback is removed.
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
- The data directories are created and `/tmp` emptied at module load.
- **Documented differences from worker mode:** `process.cwd()` stays real;
  stack frames, `module.filename`, `require.cache` keys and `require.resolve`
  stay host; paths given to non-`fs` APIs are not translated; a module can
  require countinghouse's own dependencies through `NODE_PATH`; ES modules'
  `import.meta.dirname` stays host.

## 7. Uninstall

`POST /uninstall-module {name, keepData}`, admin key required. It:
- validates `name` against npm package-name rules before building any path;
- refuses while the module is loaded, restarting or suspended;
- removes the registry entry (`lib/device-db.js` `removeModuleInfo`, which has
  no caller today);
- deletes `<moduleDataPath>/<name>` unless `keepData`, never following links,
  under the per-name lifecycle lock.

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
- The routes table in section 2 is complete only once the plan's built-in
  sweep has run.

## Error codes and flags

New flag: `--moduleDataPath`. New limits: `diskMb` and `diskEntries`. New
error code: `MODULE_NAME_MISMATCH`. New route: `POST /uninstall-module`. Module-facing
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
