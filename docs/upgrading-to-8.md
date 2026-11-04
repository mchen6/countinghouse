# Upgrading to 8.0.0

One page for operators deciding on the upgrade from 7.x. 8.0.0 runs modules
in worker threads by default, inside the module sandbox (parts 1 and 2),
with every file access a module makes going through the main thread. The
[CHANGELOG](../CHANGELOG.md) has the full list; this page groups it by what
you have to do. What the sandbox does and does not protect is in
[`security-model.md`](security-model.md).

## Before you upgrade

- **Node 22.16 or later.** Startup exits with status 2 on an older Node.
- **Redis 5.0 or later if you use jobs** (6.2 recommended). Worker mode now
  starts the BullMQ job worker on a plain start; on an older Redis it logs
  BullMQ's version error and jobs do not run.
- **A writable `--moduleDataPath`.** Every module now gets private data
  directories there, in every mode. The default is
  `$HOME/countinghouse_module_data`; where `$HOME` is read-only (systemd
  `ProtectHome` or `ProtectSystem=strict`, a read-only container root) set it
  to a writable directory first, or modules fail to load with `cannot create
  the module data directory`. Under systemd, add it to `ReadWritePaths`
  ([example](security-model.md#hardening-with-systemd)).
- **countinghouse not installed under `/app`.** In worker mode startup exits
  with status 2 if countinghouse's own code is under `/app`, where modules
  see their own files. Install it elsewhere (for example
  `/opt/countinghouse`) or run with `--no-workerThread`. Modules and data
  under `/app` are fine.
- **Load names equal to package.json names.** A load whose name differs from
  the module's package.json name is refused with `MODULE_NAME_MISMATCH`, in
  every mode. Check registry entries, `load_module` calls and composite
  `runsModules` bindings before upgrading. `POST /load-module` may leave
  `name` out.
- **Worker mode is the default.** `--no-workerThread` keeps single-thread
  mode, which is now for debugging modules only and has no sandbox. In
  worker mode the sandbox runs in `audit` by default, which changes some
  module behaviour (next section); `--moduleSandbox off` turns its lockdown,
  limits and logging off, but not the file broker.
- **pnpm installs and `--hardened`.** `--hardened` does not work with a pnpm
  install of countinghouse until
  [nodejs/node#66812](https://github.com/nodejs/node/issues/66812) is fixed:
  Node's permission model refuses the dependency links. Use npm, or run
  without `--hardened`. pnpm installs work in worker mode without it.

## What modules will notice

Under worker mode, in every `--moduleSandbox` mode unless noted:

- **Virtual paths.** A module sees its own directory as `/app`:
  `__dirname`, `__filename`, `require.resolve`, `import.meta`, stack traces,
  `process.cwd()` (`/app`) and `os.tmpdir()` (`/tmp`). Code that builds
  paths from `__dirname` keeps working; code that logs or compares host
  paths sees `/app/...`. A CommonJS file that an ES module imports directly
  still shows its host path in `__filename` and stack frames (a Node 24
  limit).
- **`/data` and `/tmp` are private.** Each module writes under `/data`
  (kept) and `/tmp` (its own, not the host's, and **emptied every time its
  worker starts**). Anything a module left in `/tmp` is gone after a restart.
- **Writes to `/app` are refused under `enforce`** (`EROFS`), logged under
  `audit`.
- **Outside paths must be declared under `enforce`.** Anything outside the
  namespace is `ENOENT` unless the module declares it in
  `countinghouse.permissions.fs` and your `--modulePolicy` approves it.
  Under `audit` such access works and is logged, so run in `audit` first and
  read the log.
- **A disk quota** on `/data` and `/tmp` together: `diskMb` (default ceiling
  1024) and `diskEntries` (default ceiling 100 000). Past it, writes are
  `ENOSPC` under `enforce`; under `audit` crossings of 75 % and 100 % are
  logged.
- **Links.** A hard link only within one writable root; a symlink only with
  a relative target inside its root. `chmod` drops setuid, setgid and sticky
  bits. A cross-root `rename` answers `EXDEV`.
- **Only declared environment variables** (under `audit` and `enforce`). A
  module's `process.env` holds the names it declares in
  `countinghouse.permissions.env`, with values from the policy or the
  server's environment; anything else, `NODE_PATH` included, is unset. For
  example, a module that read an undeclared `DYNAMIC_DEVICE_COUNT` to decide
  how many devices to expose falls back to its default.
- **Resource limits and restarts** (under `audit` and `enforce`): over
  256 MB of heap or external memory, or an event loop blocked for 10 s, ends
  the worker; it restarts after 1 s, then 2 s, and is suspended on the 3rd
  exit within 10 minutes. A module that sends the main thread more than 2000
  messages a second gets `RATE_LIMITED`.
- **Files are slower.** Every `fs` call is a hop to the main thread (see
  [measured cost](#measured-cost)). Descriptors from `fs.open` are numbers
  from `0x10000000` up. `fs.watch` and friends are not available, and
  neither is HTTP/2 `respondWithFile` (read the file with `fs` and stream
  it).
- **Start-up time grows with the files in `/data` and `/tmp`:** a worker's
  start walks them, about 70 µs per entry on one CPU (715 ms for 10 000;
  about 7 s near the 100 000 default; measured at `dab69d0`). The walk does
  not block the server.

Module authors: [Files and paths](module-development.md#files-and-paths)
says how to write a module for this.

## What operators get

- **`POST /uninstall-module {name, keepData}`** (admin key): removes a
  module's registry entry and deletes its data under `--moduleDataPath`
  unless `keepData` is true. It never removes the module's code. Unload the
  module first ([reference](cli-and-api-reference.md)).
- **Disk limits in the policy:** `diskMb` and `diskEntries` take the same
  ceilings and per-module entries as the other limits.
- **A link check at start:** under `enforce`, a module whose data holds a
  symlink with an absolute target, or a hard link to a file that also has a
  name outside its data, does not start until you remove it; the log names
  the entries.
- **Under `enforce`, modules cannot read** `auth.json`, other modules' code
  and data, or anything else outside their namespace through `fs` or the
  loader, by the routes the design knows of. Under `audit` you get a log of
  what they would have been refused. The remaining gaps (network access
  until parts 3 and 4, host processes racing the checks, module code
  reaching countinghouse's objects) are listed in
  [`security-model.md`](security-model.md#what-this-explicitly-does-not-provide-accepted-gaps-and-limits).

## Measured cost

From [`benchmarks/sandbox-part2.md`](benchmarks/sandbox-part2.md), on the
maintainer's VM; treat these as orders of magnitude and measure your own.

- **File I/O**, 250 rounds of a 4 KB write, read, stat and unlink, on 2 CPUs
  (measured at `9246db1`): about 30 ms with no broker (`--no-workerThread`),
  1.2 s in worker mode under `--moduleSandbox off`, 1.9 s under `enforce`.
  Brokered file I/O costs tens of times the direct path. Modules doing
  occasional file I/O will not notice; modules doing thousands of small
  synchronous operations per request will.
- **Spawn time** on 1 CPU (measured at `dab69d0`): `POST /restart-module`
  until the module answers, a median of about 6 s; the `/data` walk as above.

## Going back to 7.x

7.x does not know about `--moduleDataPath`: modules that wrote under `/data`
in 8.0.0 will not find that data after a downgrade. Copy what you need out of
`<moduleDataPath>/<name>/data` first.

## Known issues

- HTTP/2 `respondWithFile` is not available to modules.
- The `__filename` and stack frames of a CommonJS file imported directly by
  an ES module show its host path.
- `--hardened` does not support pnpm installs
  ([nodejs/node#66812](https://github.com/nodejs/node/issues/66812)).
