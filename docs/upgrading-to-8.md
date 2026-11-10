# Upgrading to 8.0.0

One page for operators deciding on the upgrade from 7.x. 8.0.0 runs modules
in worker threads by default, inside the module sandbox (parts 1 and 2),
with every file access a module makes going through the main thread. The
[CHANGELOG](../CHANGELOG.md) has the full list; this page groups it by what
you have to do. What the sandbox does and does not protect is in
[`security-model.md`](security-model.md).

## Before you upgrade

- **Node 24.15 or later.** Startup exits with status 2 on an older Node.
  Node 22 is not supported (module loader hooks miss `require.resolve`
  before 24.15).
- **Redis 5.0 or later if you use jobs** (6.2 recommended). Worker mode now
  starts the BullMQ job worker on a plain start; on an older Redis it logs
  BullMQ's version error and jobs do not run.
- **A writable `--moduleDataPath`.** Every module now gets private data
  directories there, in every mode. The default is
  `$HOME/.countinghouse/module_data`; where `$HOME` is read-only (systemd
  `ProtectHome` or `ProtectSystem=strict`, a read-only container root) set it
  to a writable directory first, or modules fail to load with `cannot create
  the module data directory`. Under systemd, add it to `ReadWritePaths`
  ([example](security-model.md#hardening-with-systemd)).
- **Give each user a stable `id` before rotating any key.** 8.0.0 gives
  every user an opaque id, an HMAC of the auth entry's `id` field, else of
  its API key ([authentication.md](authentication.md#the-opaque-user-id)).
  Per-user module data and repeatable job schedulers are scoped by it. An
  entry without `id` keeps working, but rotating its key then changes its id
  and orphans that data; add `id` first. The secret behind the ids is
  written to `<moduleDataPath>/.identity-secret` on first start (or comes
  from `COUNTINGHOUSE_IDENTITY_SECRET`, 64 hex characters): back it up with
  the module data, since changing it changes every id. Start one server on
  a new data directory first; two starting at once on an empty one would
  each generate a secret. An unusable `--moduleDataPath` now refuses
  startup with exit 2 (it used to fail each module load instead). Schedulers stored
  under the pre-8.0 owner prefix are still found and removed by their owner.
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
  without `--hardened`. pnpm installs work in worker mode without it. If paths
  you configure for `--hardened` overlap by name (one extending another's,
  such as `/srv/ch` and `/srv/ch_data`), startup exits with status 2 and
  names them; rename one.

- **The server binds `127.0.0.1` unless `--bindAddr` is given** (it used to
  bind the first non-internal IPv4 address). Remote clients need, for
  example, `--bindAddr 0.0.0.0`. `--debug` without `--debugKey` refuses to
  start on any other address, a bare `--debugKey` with no value refuses to
  start at all (exit 2), and JSON must be sent as `application/json`,
  not `text/plain` (form bodies are not parsed at all).
- **Browser-based clients need `--allowedOrigins`.** CORS is off by default
  (it allowed every origin), and every route refuses a request from a
  browser origin not listed there. Clients outside a browser are unaffected.
- **Request bodies are bounded:** 8 MB for JSON, XML and forms
  (`--maxRequestBody`), 64 MB for BSON on `invoke-action`
  (`--maxBsonRequestBody`); they were 1 GB. A client that sends larger bodies
  gets 413 until you raise the limit. `add-job` takes JSON only; a BSON job
  never worked there (it failed with `SERVICEID_NOT_AVAILABLE`).

- **Repeatable jobs created before 8.0.0** keep running under their old
  scheduler ids. A new `add-job` with the same name creates a second,
  owner-scoped scheduler rather than replacing the old one, so remove the
  old one first (admin key, `POST /devices/:id/remove-job`
  `{name, isRepeat: true}`). Schedulers now belong to the key that created
  them; see [Rotating a key](authentication.md#rotating-a-key).

## What modules will notice

- **Breaking: a device's `rateLimit` is no longer enforced.** The CDIF-era
  device fields `rateLimit` and `price` in `api.json` are retired: nothing
  reads them. A spec that still carries one loads and validates, and
  `countinghouse-validate` warns about it; `bin/countinghouse-migrate-spec.js`
  removes both. Limit callers with `--apiKeyRateLimit` (per key) and
  `--globalRateLimit` (all calls); jobs are bounded by the add-job limits on
  `repeat.every`, `repeat.limit` and `attempts`.

Under worker mode, in every `--moduleSandbox` mode unless noted:

- **Part 1's lockdown now applies by default** (under `audit` and
  `enforce`), since worker mode is the default: native addons,
  `child_process` and the other blocked built-ins, process controls, and a
  module whose dependencies resolve outside its own directory all work but
  are logged under `audit`, and are refused under `enforce`. The list is in
  the CHANGELOG's "module sandbox, part 1" section and in
  [`security-model.md`](security-model.md).
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
  a relative target that really leads inside its root and holds no `..`
  segment (`../f` answers `EPERM`). `chmod` drops setuid, setgid and sticky
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
  start walks them, about 70-145 µs per entry on the maintainer's VM
  (715 ms for 10 000 at `dab69d0`, 1.1-1.5 s at `cd411ee` on a slower disk;
  so 7-15 s near the 100 000 default). The walk does not block the server.

Module authors: [Files and paths](module-development.md#files-and-paths)
says how to write a module for this.

## What MCP clients will notice

- **Results are the tool's output itself.** A module tool's
  `structuredContent` used to be `{output: …}`, one level above the
  `outputSchema` it advertised, so clients that validate results (the
  official MCP SDK client does) rejected every module tool. It is now the
  output itself, and `content[0].text` is the same object serialized. Read
  `structuredContent`, not `structuredContent.output`.
- **A tool whose module declares no output schema advertises none** and
  returns text only: a string as-is, anything else as JSON, no output as one
  empty text block. The bundled modules all declare one, so their
  `tools/list` entries do not change.
- **Error codes moved to `_meta`.** An error result is `isError: true` with
  the message as text and the code in `_meta["countinghouse/code"]`, with no
  `structuredContent` (clients validate it against the output schema even on
  errors). Read the code there instead of `structuredContent.code`.
- **`countinghouse_call_tool` no longer advertises an output schema**: its
  result is whatever the inner tool returns.
- **`countinghouse_check_balance` returns `{userName, balance}`**, not
  `{apiKey, balance}`. `userName` is `null` when it would equal the key.
- ctx.call and HTTP `invoke-action` are unchanged: they keep `{output: …}`.

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
- **Restarts are faster than in 7.1.2.** `POST /restart-module` until a
  small module answers again took a median of about 1.3 s at `cd411ee`
  against about 4.2 s on 7.1.2, same module and machine, 2 CPUs. What part 2
  adds to each start is the walk of `/data` and `/tmp`: about 0.7-1.5 s per
  10 000 entries on the maintainer's VM, depending on the disk.

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
