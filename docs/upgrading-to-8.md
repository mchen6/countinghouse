# Upgrading to 8.0.0

One page for operators deciding on the upgrade from 7.x. 8.0.0 runs modules
in worker threads by default, inside the module sandbox (parts 1 and 2),
with every file access a module makes going through the main thread. The
[CHANGELOG](../CHANGELOG.md) has the full list; this page groups it by what
you have to do. What the sandbox does and does not protect is in
[`security-model.md`](security-model.md).

## Before you upgrade

- **Every device ID changed.** A device's ID is now a UUID v5 of its
  `friendlyName` in countinghouse's own namespace (`lib/call-address.js`
  `deviceIDForName`); before 8.0 it was derived from another project's
  registry URL. Grants that list specific device IDs (an auth file's
  `devices`, a sqlite provider's `user_devices`, a CouchDB user's
  `devices[].deviceID`) must be regenerated: a grant of `'*'` is
  unaffected. A grant in an auth file or sqlite that still names a loaded
  module's pre-8.0 ID is logged once, with its new ID (at start, and again
  after the auth configuration is reloaded); CouchDB's grants are not
  checked. What is kept under a device ID is left where it is and no longer
  read: a device's log, and the metering's per-tool records (a tool is
  `<deviceID>/<service>/<action>` there, and a CouchDB user's
  `devices[].priceRecord` likewise). A per-tool price or free-call record
  is not carried over: the free calls left on it are lost unless you
  rewrite the record under the new ID, and a report spanning the upgrade
  shows a tool under both IDs. A job or a repeatable scheduler created
  before the upgrade names its device by the old ID: 8.0 does not run the
  old shared queue it is in (see the job queue entry), and if one were run
  it would reach no device (under a specific-ID grant it is refused, and a
  refused scheduler is removed without a word). Remove pending jobs and
  repeatable schedulers made before the upgrade and add them again after
  it. Composite
  modules address their callees by name (`<module>/<service>.<action>`) and
  are unaffected; one that hard-codes a callee's device ID must take the
  new one.
- **If you run ch-local, or write a ceiling or a module's remote: what
  module-level configuration removed.**
  - The operator's ceiling (`/etc/countinghouse/ceiling.json`, or
    `%ProgramData%\countinghouse\ceiling.json`) no longer reads `packs`. A
    ceiling that still holds it is not trusted, so no module loads, and it
    says why: "it holds "packs", which is no longer read: list each module
    under "modules"". Rewrite it with `modules`, naming each module by
    package name, parts included.
  - `--packsRoot` is no longer taken (exit 2): ch-local passes
    `--modulesRoot`, and the pack form of its control messages is gone.
  - With `--controlChannel`, `--remoteCredentials` must be version 2 (ch-local
    writes it); a version 1 file stops the start. An operator's runtime
    without a control channel still takes version 1.
  - A remote's `credential` is one variable (`env`): a `fallbackEnv` is
    refused at load.
  - Usage records name the call's top-level module as `scenario` (records
    written before say `pack`, and are still read). The usage report groups
    by `scenario`; `groupBy: "pack"` is no longer taken.

- **Most likely surprise: module outputs are capped, and checked out of a
  module's reach.**
  - `--maxOutputBytes` (default 16 MiB, at most 256 MiB) caps a module's
    output on every call the main thread carries, measured by its bytes
    there: a client's call, a job's run, and a hop routed through the main
    thread (its result and its input). Past it the call is refused with
    `OUTPUT_TOO_LARGE` or `INPUT_TOO_LARGE`, naming the module and the
    action. A module that returns more than 16 MiB stops working on upgrade:
    raise the cap, or have it return a reference (a path in its data)
    instead.
  - A hop over a direct peer channel (the default; `--no-directPeerChannels`
    routes hops through the main thread) is capped the same way, on its input
    (`INPUT_TOO_LARGE`) and its output (`OUTPUT_TOO_LARGE`), and both are
    checked against the called module's schemas by the main thread before
    the handler runs and before the caller sees the result.
  - Every call the main thread sends a module (an MCP `tools/call`, an HTTP
    `invoke-action`, a job's run, a hop routed through the main thread) has
    its input and output validated in a validator worker, under a deadline.
    The pool is sized by `--validatorWorkers` (2 to 4 by default), and each
    validation has `--validationTimeoutMs` (1000 ms by default) from when it
    is queued. Past the deadline the call is refused `VALIDATION_TIMEOUT`.
  - A caller whose inputs to a module keep missing the deadline is refused
    `VALIDATION_CALLER_THROTTLED` on that module for a minute. A module whose
    own outputs or compiles miss it 3 times in 5 minutes is quarantined
    (`VALIDATION_QUARANTINED`) until you load it again.
  - At load, a module's schemas must compile within `--validationCompileMs`
    (10000 ms by default). A plainly unsafe `schema.json` is refused (over
    1 MB, a backtracking pattern, a `$ref` cycle, over 100,000 nodes with
    its `$ref`s expanded). Either refusal is `MODULE_ASSEMBLY_FAIL`, at stage
    `schemaCompile` or `schemaSafety`. Load modules with heavy schemas in a
    test run first.
  - At load, what a module declares is checked too, at stage `declarations`.
    Two things a 7.x module could carry are refused: a binary output field
    (`contentEncoding: base64` with a `contentMediaType`) that is not under
    `properties` or an array's `items`, and `x-mcp-header` anywhere in an
    input schema. `countinghouse-validate` reports both before you upgrade.
- **A module's load is bounded.** `--moduleLoadTimeout` (120 s by default,
  every sandbox mode) ends a worker that hasn't answered its load in time,
  and the load fails `MODULE_LOAD_TIMEOUT`.
- **Node 22.16 or later.** Startup exits with status 2 on an older Node.
  Below 24.15 a compatibility shim routes `require.resolve` through the
  sandbox's hooks; multi-tenant hosting of third-party modules should run
  24.15 or later, where Node's own hook covers it. The floor rises to 24
  when Node 22 reaches end of life, on 2027-04-30.
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
- **`runsModules` names the module.** A composing module's identity is
  bound by its module name (its package.json `name`, which the server loads
  it under), no longer by a device's `friendlyName`. Where the two differ
  (the bundled `echo-device-client-module`, whose device is
  `echo-device-client`), list the module name; one identity runs a module,
  all its devices. Under `--authProvider sqlite`, bind with
  `countinghouse-auth-sqlite bind-module <moduleName>`, with the identity's
  key on stdin. Remove the
  old friendlyName entries too (from `runsModules`, or with
  `unbind-module <friendlyName>`): a stale entry still binds whatever module
  is loaded under that name. A module left unbound is unloaded at startup
  with `MODULE_COMPOSITION_INVALID`, and its tools are gone from
  `tools/list`.
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
- **Request bodies are bounded:** 8 MB for JSON and XML
  (`--maxRequestBody`); they were 1 GB. A client that sends larger bodies
  gets 413 until you raise the limit.
- **BSON bodies are no longer taken.** A request with
  `Content-Type: application/bson` is answered 415
  (`REQUEST_UNSUPPORTED_MEDIA_TYPE`) on every route, where
  `POST /devices/:deviceID/invoke-action` used to decode it. Send JSON, with
  binary data as base64. (MCP was always JSON only.) The
  `--maxBsonRequestBody` option is gone with it: a start that still passes
  it is not refused (the flag is ignored, and bounds nothing), so take it
  out of your start command.

- **Six flags are gone:**
  - `--verifyModule`, which let a module that failed its spec or interface
    check load anyway. Such a module is now refused whatever the options:
    check a module with `countinghouse-validate`.
  - `--apiMonitor`, a per-call API log in Redis that nothing read.
  - `--centralPortalUrl`, `--wetty` and `--validateData`, which nothing read.
  - `--logStream`, which changed nothing: the log went to the same place with
    it or without.

  A start that still passes one is not refused, and the flag does nothing.
  Take it out of your start command.

- **Jobs that run longer than an hour need `--jobTimeout`.** A job that
  sets no timeout of its own is now ended after `--jobTimeout` seconds
  (default `3600`; `0` for none), so a handler that never answers cannot
  hold a job worker slot forever. It applies when a job runs, so jobs queued
  before the upgrade and schedulers stored earlier are bounded too. A job's
  own `opts.timeout` still wins; either is capped at about 24 days
  (setTimeout's maximum). A run past it fails `JOB_TIMEOUT` (retryable, HTTP
  504), and an answer that comes later is dropped.

- **`add-job`'s `opts.timeout` must be a whole number of milliseconds, at
  least 1.** A string (`"5000"`), a fraction, zero or a negative value used
  to be coerced or to fail the run; it is now refused at once with
  `ADD_JOB_ERROR`. A job stored earlier with such a value runs under
  `--jobTimeout`, as if it had set none.

- **Repeatable jobs created before 8.0.0** keep running under their old
  scheduler ids. A new `add-job` with the same name creates a second,
  owner-scoped scheduler rather than replacing the old one, so remove the
  old one first (admin key, `POST /devices/:id/remove-job`
  `{name, isRepeat: true}`). Schedulers now belong to the key that created
  them; see [Rotating a key](authentication.md#rotating-a-key).

## What modules will notice

- **Module settings need worker threads.** A module that declares
  `countinghouse.settings` loads only with worker threads (the default). In
  single-thread mode (`--no-workerThread`) it is refused at its load and at a
  reload (`SETTINGS_NEED_WORKER_THREADS`); a module that declares no settings
  loads as before.

- **Breaking, under the sandbox: Node's loader internals are held.**
  `Module._load` takes only its request, parent and isMain (Node's internal
  fourth argument, which skips the resolve hooks, is dropped). Under
  `enforce`:
  - a request that is no string, or a main-module load, is refused;
  - `Module._load`, `Module._resolveFilename`, `Module.prototype.load` and
    the extension handlers are locked;
  - the `Module._extensions` table takes no new extension.

  Under `audit` the request is made a string and `isMain` is passed on as
  given, each reported; a replacement of `Module._load`,
  `Module._resolveFilename`, `Module.prototype.load` or an extension handler
  never takes effect (Node hands each of them the runtime's own modules):
  an assignment is reported, and so is a redefinition, which then fails
  with Node's own `TypeError`. A dependency that replaces any of them
  (proxyquire, mock-require, some APM agents) needs `--moduleSandbox off`.
- **Breaking, under the sandbox (`audit` and `enforce`): the runtime's own
  modules are out of a module's reach.**
  - `require.cache` (and `module.constructor._cache`, the same object)
    holds the module's own files only.
  - There is no main module: `require.main` and `process.mainModule` are
    `undefined`.
  - The loader's other statics are locked in both modes: `_pathCache`
    lists nothing and keeps only the module's own files,
    `Module.prototype.require` and `_compile`,
    `Module.prototype` and the resolver's helpers can't be replaced (under
    `audit` an attempt is reported), and the extensions table takes no new
    extension under `audit` too: a key added (`require.extensions['.ts'] =
    …`, as pirates, ts-node or @babel/register do) is reported and refused.
  - Under `enforce`, a file of countinghouse's, or a package only it has,
    resolves as a missing one would; under `audit` a require of one is
    reported.
  - Under `enforce`, the global `BroadcastChannel` and `navigator.locks`
    (Node 24.5+), channels between workers, are gone; under `audit` the
    first use of each is reported.
- **Breaking: `ctx.job` is never `null`.** Outside a task it is now
  `{id: null, progress(n), info(cb)}`: `progress(n)`, a number from 0 to 100,
  is the call's own progress, sent to an MCP client that asked for it
  (`_meta.progressToken`) as `notifications/progress` with `total: 100`, at
  most one every 250 ms, the latest value winning, none after the answer.
  Only the outer call's handler is heard: a composite's parts' reports are
  dropped, and once the outer handler reports, its hops stop counting as
  progress. `info` calls back with an error there. A module that asked
  `ctx.job == null` to tell a call that is not a task must ask
  `ctx.job.id == null`; a module that wrote `ctx.job.id` into its output
  outside a task now gets `null` where it threw before. Inside a task
  nothing changes.
- **Breaking: `contentEncoding: "base64"` is an assertion.** A string whose
  schema says `contentEncoding: "base64"` must now be canonical RFC 4648
  base64 (the standard alphabet, padded, no whitespace, zero pad bits), in an
  input and in an output, on every path. Before, it was an annotation that
  asserted nothing, so a schema that used it loosely could have passed values
  that are now refused (`INPUT_DATA_VALIDATION_FAIL` or
  `OUTPUT_DATA_VALIDATION_FAIL`, naming the field). No bundled module used it.
  Any other `contentEncoding` stays an annotation.
- **Breaking: a Buffer in an output is refused, `OUTPUT_NOT_JSON`.** An output
  holding a Buffer, a typed array or a DataView is refused in the module's
  worker (`--workerThread`, the default), naming the field: before, it was
  mangled. Single-thread mode serializes no output, so there only a typed
  field's own check refuses one.
  Return `buf.toString('base64')` in a field its output schema declares
  `{"type": "string", "contentEncoding": "base64", "contentMediaType": "<type>/<subtype>"}`.
  The check costs a clean output nothing. A bare `ArrayBuffer` is not caught
  by it: under a typed field the validator refuses it, and under an untyped
  one it is sent as `{}`, so don't return one.
- **Breaking: one module format.** A module is `api.json`, `schema.json` and
  `handlers/<service>/<action>.js`. A module with a main entry
  (`package.json` `"main"`, or an `index.js`) and no `handlers/` directory is
  refused before any of its code runs, with `MODULE_LAYOUT_UNSUPPORTED`: a
  `device.js` exporting a handler map, or an `index.js` doing its own
  discovery. Move each action into its own handler file (shared code into a
  plain file the handlers require); for a 5.x module (a `CHDevice` with
  `setAction`), `npx countinghouse-migrate-module ./my-module` does that. A
  module that had several devices becomes several modules. With `handlers/`, a main entry is never
  run.
- **Breaking: `ctx.redis` is per module (#164).** Each key a module names
  is stored under `m:<module name, URI-encoded>:`, the name the runtime loaded it under,
  so modules no longer share keys: one module cannot read, overwrite or
  delete another's, nor the runtime's own (`jobinfo:*`). A module reads and
  writes its keys as it named them. Data a 7.x module wrote unprefixed is not
  visible under its new namespace; there is no migration (no module authors
  depend on it yet). `multi` and `exec` are gone from `ctx.redis`.
- **Breaking: `DeviceError` and `CHError` are gone.** Neither the classes nor
  the module-facing globals exist; a module that names them fails at call
  time. Report a failure with your module's own code:
  `return ctx.error('INPUT_REJECTED', 'text must be a string')` (returning it
  is the preferred form; throwing it or `callback(err)` give the same
  answer), or throw a plain `Error` with a `.code` from a helper that has no
  `ctx`. A module raises only its own codes, never the runtime's (so
  `ARGUMENTS_INVALID` in a handler becomes a code of your own, such as
  `INPUT_REJECTED`). Before:
  `throw new DeviceError('ARGUMENTS_INVALID')`; after:
  `return ctx.error('INPUT_REJECTED', 'text must be a string')`. See
  [module-development.md](module-development.md#failing-a-call).
- **Removed: `CHUtil.createSOAPClient`.** SOAP support and the `soap`
  dependency are gone; a module that calls it fails at call time
  (`CHUtil.createSOAPClient is not a function`). A module that needs SOAP
  depends on a SOAP library of its own and declares its hosts under
  `countinghouse.permissions.net`.
- **New: a remote MCP server per module.** A module may declare one in
  `countinghouse.remotes` and call it with `ctx.call('remote:<name>/<tool>')`;
  the main thread holds the connection and the credential
  ([module-development.md](module-development.md#calling-a-remote-mcp-server);
  what the operator allows is under [What operators get](#what-operators-get)).
- **Your input and output are checked outside your worker.** For every call
  the main thread sends you, the check runs in a validator worker your code
  can't reach, under the deadlines and caps in
  [Before you upgrade](#before-you-upgrade). Patching your own worker's
  validation no longer changes what's accepted. That includes a call over a
  direct peer channel: the main thread checks its input before your
  handler runs, and your output before the calling module gets it.
- **Every hop must be declared.** A composing module's `ctx.call`,
  `ctx.serviceClient` and device queries reach only the devices and actions
  it declares in `countinghouse.calls`; anything else is
  `CTX_CALL_UNDECLARED`.
- **A hop's input is sent as bytes.** A routed `ctx.call` serialises its
  input once in your worker. A value that structured clone can't carry, or
  a `SharedArrayBuffer`, now fails the `ctx.call` there. A
  `SharedArrayBuffer` used to be shared between two modules' workers.
- **New: `ctx.usage()`** resolves with the current `tools/call`'s counts so
  far (`{calls, bytesIn, tokensInEst, servers, sentence}`). A
  scenario can put its receipt sentence in its own summary. It's `null`
  outside a counted call, and never carries a key or a caller.
- **A scenario module may not have a top-level `receipt` output field**
  (`RECEIPT_RESERVED`): the runtime adds its receipt to a scenario's
  result, and there the name is its own. Any other module's `receipt` field
  passes through untouched.
- **Breaking: a device's `rateLimit` is no longer enforced.** The CDIF-era
  device fields `rateLimit` and `price` in `api.json` are retired: nothing
  reads them. A spec that still carries one loads and validates, and
  `countinghouse-validate` warns about it; `bin/countinghouse-migrate-spec.js`
  removes both. Limit callers with `--apiKeyRateLimit` (per key) and
  `--globalRateLimit` (the runtime's direct calls: a task-augmented call and
  an `add-job` count against the per-key limit when they are made, not
  against this one); jobs are bounded by the add-job limits on
  `repeat.every`, `repeat.limit` and `attempts`.

Under worker mode, in every `--moduleSandbox` mode unless noted:

- **Part 1's lockdown now applies by default** (under `audit` and
  `enforce`), since worker mode is the default: native addons,
  `child_process` and the other blocked built-ins, process controls, and a
  module whose dependencies resolve outside its own directory all work but
  are logged under `audit`, and are refused under `enforce`. The list is in
  the CHANGELOG's "module sandbox, part 1" section and in
  [`security-model.md`](security-model.md).
- **Some shared built-ins are fixed** under `audit` and `enforce`: the
  functions of `path`, `path.posix`, `path.win32` and `url`,
  `URL.prototype`'s accessors and methods, `module.isBuiltin`, and the
  methods of `EventTarget.prototype`, `NodeEventTarget` and
  `MessagePort.prototype` are non-writable and non-configurable. A module
  that replaces one of them runs only under `off`. Because the inherited
  property is non-writable, a plain assignment on an instance, such as
  `target.addEventListener = fn` on an `EventTarget` or `AbortSignal`,
  throws a `TypeError` in strict code (and is ignored in sloppy code).
  Accessors (`port.onmessage = fn`, `signal.onabort = fn`), subclasses
  that define their own methods, and `Object.defineProperty` on an
  instance still work, as do `AbortController`, `AbortSignal.timeout` and
  `fetch`'s `signal`.
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
- **Writes to `/app` are refused**: `EROFS` under `enforce`, `EACCES` under
  `audit`; under `off` they reach the install directory.
- **Outside paths must be declared under `enforce`.** Anything outside the
  namespace is `ENOENT` unless the module declares it in
  `countinghouse.permissions.fs` and your `--modulePolicy` approves it.
  Under `audit` a read of such a path works and is logged, so run in `audit`
  first and read the log; a write outside the module's own area, and every
  access to a protected path, is refused (`EACCES`) under `audit` too.
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
  exit within 10 minutes. A module that sends the main thread more than
  `--moduleMessageRate` messages a second (default 2000) gets
  `RATE_LIMITED`.
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

- **A tool outside your key's grants is an unknown tool.** `tools/call` of
  one now answers `-32602 unknown tool: <name>; countinghouse_overview shows what is installed here and which tools you can use`, as a name never registered
  does, where it answered `-32603` "This apiKey does not have access to this
  device". So is a runtime tool your key isn't listed: an authoring tool
  for a key that is no admin's (it answered `ADMIN_REQUIRED`), and in the
  single-identity profile the built-ins it hides (they answered
  `MODULE_NOT_LISTED`). No key and an unknown key keep their auth refusal.
- **A call can be cancelled while it runs.** For a 2026-07-28 request over
  HTTP, closing the POST before its answer cancels it; on stdio and the
  shared runtime, `notifications/cancelled` with the request's id does,
  naming a request of your own connection or session only. A cancelled call
  writes no answer. A composite stops at its next hop, which is refused, and
  a remote call made for it is aborted. Work already running finishes, its
  result discarded, and is billed as before: the bill is what ran. A legacy
  HTTP request's disconnect changes nothing, and the call runs to its end.
  A task-augmented call cancelled before its task's id was sent has its job
  removed if it hasn't started (one already running runs to its end). This
  is with `--workerThread`, the default: in single-thread mode a cancel only
  suppresses the answer.
- **Results are the tool's output itself.** A module tool's
  `structuredContent` used to be `{output: …}`, one level above the
  `outputSchema` it advertised, so clients that validate results (the
  official MCP SDK client does) rejected every module tool. It is now the
  output itself, and `content[0].text` is the same object serialized. Read
  `structuredContent`, not `structuredContent.output`.
- **Images and audio arrive as their own blocks.** An output field declared
  `contentEncoding: "base64"` with an `image/*` or `audio/*`
  `contentMediaType` is sent as an `image` or `audio` content block after the
  text block, and `structuredContent` (and the text) hold a reference to it,
  `{mimeType, bytes, block}`, as the tool's `outputSchema` says. A client that
  knows only protocol revision 2024-11-05, which has no audio content type,
  may not render an audio block.
- **Every binary field is a block, and a large one is a link.** Any other
  media type (a PDF, a zip, `text/plain`) arrives as a `resource` block,
  `{uri, mimeType, blob}`, whose `uri` (`countinghouse://r/<id>`) can be read
  back; its reference in `structuredContent` carries the `uri` too. Before,
  it stayed a base64 string there and in the `outputSchema`. Past
  `--inlineContentBytes` (1 MiB of decoded bytes per result, in schema order)
  a value is stored instead and sent as a `resource_link` with its `name`
  (the field), `mimeType` and `size`; `structuredContent` holds
  `{mimeType, bytes, uri}`. `resources/read` returns it to the caller who
  made the call, in the same session, for `--resourceRetention` (24 h), as
  `text` for valid UTF-8 `text/*`, else `blob`; anything else is "Resource
  not found". Stored results are never listed in `resources/list`. A
  result whose stored values would pass a store limit is
  refused `RESULT_STORE_FULL`, with nothing stored. Under `--store redis`,
  one whose store does not answer in time (3 s, plus 1 s per MiB of the
  value), or with Redis down, fails `RESULT_STORE_UNAVAILABLE` (retryable),
  and anything it may have written is removed once Redis answers again;
  every other call goes on answering. A `resources/read` then answers
  -32603, "the stored value can't be read right now; try reading it
  again", with `data` `{code: "RESULT_STORE_UNAVAILABLE", kind, retryable,
  operation: "read"}` (the URI still holds), and a task tries its result's
  store again for a few seconds before it records that refusal. A client
  on protocol
  revision 2025-03-26 or 2024-11-05, which have no `resource_link` block,
  may not show a link; it can still read the `uri` from the text block.
  `ctx.call` and `invoke-action` are unchanged: their output keeps the base64
  in place.
- **Output schemas of any JSON type, for 2026-07-28 requests.** A modern
  `tools/list` advertises an output schema whatever its root type (an array,
  a string, a number, null), and a modern result carries the output as
  `structuredContent`, whatever its type; the text block is a string output
  itself, else its JSON. A legacy request (`initialize`) is unchanged: only an
  object schema is advertised, and other results are text only. A module's
  output may now be any JSON value its schema allows, `null` included; before,
  anything but an object was refused `OUTPUT_DATA_VALIDATION_FAIL`.
- **`tools/list` comes in pages.** A list longer than `--listPageSize`
  (250 by default) is answered in pages, each but the last with a
  `nextCursor`; the resource, template and prompt lists page the same way. A
  client that reads only the first page of a long list misses the rest. A
  modern list result carries `ttlMs` and `cacheScope`.
- **A tool may carry `title`, `annotations` and `icons`** on `tools/list`,
  when its module declares them. The annotations' hints are the module
  author's claims, and the runtime enforces none of them. Icons are inline
  `data:` URIs, PNG, JPEG or WebP, never a URL.
- **Module resources.** An action may be declared a resource instead of a
  tool. It is listed on `resources/list` (a URI with no variables) or
  `resources/templates/list` (one with variables), as
  `countinghouse://m/<module>/<path>`, to the keys that may reach its module.
  `resources/read` runs the action as a `tools/call` would: authorized,
  validated, rate limited and billed.
- **Change notices without a listen.** A 2025-11-25 client of a `--stdio`
  runtime or of a shared runtime's session has no listen. Once it has listed
  its prompts or resources, it is told `notifications/prompts/list_changed`
  or `notifications/resources/list_changed` unasked, as it is told of its
  tools, and initialize declares `listChanged` for both. A client that goes on
  in 2026-07-28 after its initialize is told nothing unasked.
- **Change notices on a listen.** `subscriptions/listen` also agrees to
  `resourcesListChanged`, `promptsListChanged` and `resourceSubscriptions`,
  on HTTP, stdio and a shared runtime's session.
  - A change that moves the resources or prompts you are shown sends one
    `notifications/resources/list_changed` or
    `notifications/prompts/list_changed`.
  - Of the URIs you subscribe to, the ones you can read are agreed to: at
    most 64, each at most 2048 bytes. After an action that a resource's
    `changesWith` names succeeds, each URI gets
    `notifications/resources/updated`, at most once a quarter second.
- **Prompts and completion.** `prompts/list` and `prompts/get` serve the
  prompts modules declare, as `<module>_<name>`. `prompts/get` runs no module
  code. `completion/complete` offers values for a prompt's argument or a
  resource template's variable, from the schema or from an action the module
  names (not billed, and recorded in usage as `completion/complete`).
- **A module may ask the user a question.** For a 2026-07-28 client that
  declares form elicitation, a call can be answered with a declared
  question (an `InputRequiredResult`), and the client's retry carries the
  answer.
  - The retry's `requestState` is bound to the caller, the session, the tool
    and the arguments. It lasts five minutes and can be used once.
  - A call is asked at most eight rounds.
  - Other clients are never asked: the module gets `ASK_UNAVAILABLE`, and may
    fall back.
  - Inside a 2026-07-28 task too, when the request that made it declared
    form elicitation. The task reads `input_required`, with the form in
    `inputRequests` and the status message "waiting for an answer". The
    client answers with `tasks/update`, and the run starts again under the
    same `taskId`.
    - Only a request that declares form elicitation is handed the form
      (`tasks/get`) or may answer it: a `tasks/update` with `inputResponses`
      from one that doesn't is refused `-32021`, naming the capability.
    - A question waits at most an hour; then the task fails `ASK_EXPIRED`.
    - At most 64 of a key's tasks, and 10,000 in all, wait on a question at
      once. Past either, a new task's question is `ASK_UNAVAILABLE`.
  - `--moduleQuestions off` turns every question off.
- **Tasks for 2026-07-28 clients.** A client that declares the
  `io.modelcontextprotocol/tasks` extension gets a task, answered at once,
  for a call to an action that declares `longRunning` (with
  `--workerThread`). It polls `tasks/get`, and may `tasks/update` and
  `tasks/cancel`.
  - A request to those methods that doesn't declare the extension is refused
    `-32021`.
  - Over HTTP, those three, `tools/call`, `resources/read` and `prompts/get`
    carry an `Mcp-Name` header that must agree with the body.
  - A task is the caller's own, and on a shared runtime its session's.
  - A task whose module was unloaded, reloaded or suspended while it ran is
    `completed`, with the isError result the inline call gets. It is
    `failed`, with a JSON-RPC error, only when its run left no answer: past
    its timeout (`JOB_TIMEOUT`), with the owner's access refused at the
    start, or with its question unanswered for an hour (`ASK_EXPIRED`).

  The legacy era's tasks (`params.task`) are unchanged.
- **Progress for composite calls.** A `tools/call` whose `params._meta`
  carries a `progressToken` (a string of at most 256 characters, or a safe
  integer) gets `notifications/progress` as its hops run: `progress` counts
  the hops and remote calls billed so far, with no `total` and no message.
  They come at most every 250 ms (240 at most per call), always before the
  answer and never after. Over HTTP the POST's response becomes an SSE stream
  only when the first one is due and your `Accept` allows
  `text/event-stream`; a call that answers first is plain JSON, as before. On
  stdio they're lines before the answer's line; on the shared runtime,
  frames on your own session. A runtime started with `--no-workerThread`
  (single-thread mode) sends none: its hops carry no call tokens to count by.
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
- **`tools/list` has one more built-in for every key:
  `countinghouse_usage_report`**, a key's own usage counts (an admin's covers
  every caller, by opaque id). A client that pins the tool list sees it.
- **In ch-local's single-identity runtime,** `tools/list` also has
  `countinghouse_settings` when the runtime is given `--settingsFile`.
  Pack changes are announced as `notifications/message` (level `notice`;
  the server declares `logging` and answers `logging/setLevel`) and once
  as a text block on the pack's next result.
- **A scenario's result carries a receipt**
  ([module-authoring.md](module-authoring.md#the-receipt-and-the-usage-report)):
  `_meta['countinghouse/receipt']` holds the counts, and a second text block
  holds its sentence (`read 3.1 MB in 14 calls to github; …`).
  `structuredContent` is unchanged; a client that reads only
  `content[0].text` is unaffected.
- **Different error codes from the bundled modules and examples:**
  `INPUT_REJECTED` where they answered `ARGUMENTS_INVALID`, and
  `INNER_CALL_FAILED` where they answered `DEVICE_ACTION_CALL_FAIL`. A
  composite that lets a callee module's own error escape now answers with
  the callee's code; it was `DEVICE_INVOKE_EXCEPTION`. 23 catalogue codes
  that nothing raised are gone (the CHANGELOG lists them).
- ctx.call and HTTP `invoke-action` are unchanged: they keep `{output: …}`.
- **What a module declares reaches the client with no hidden characters**
  (#378). A tool's title and description, a prompt's text and its
  arguments' descriptions, a resource's title and description, and a
  question's dialog are cleaned as they leave. Each control, bidi, zero-width
  or other invisible character becomes a space, though a prompt message keeps
  its `\n` and `\t`, and emoji sequences stay whole. Nothing is refused or
  changed at load. A completion candidate carrying one is left out
  ([security-model.md](security-model.md#declared-text-as-it-reaches-the-client)).
- **A question's text with a bidi mark is refused at load.** A question's
  message and its form's text (`title`, `description`, `enum`, `enumNames`,
  `default`, a property's name) were already refused for a control character,
  a line or paragraph separator, or a bidi override or isolate. The bidi marks
  U+200E, U+200F and U+061C are now refused with them, since they reorder
  what the user reads. Every other invisible character in a question is
  still cleaned on the way out, as above. `countinghouse-validate` names the
  text that carries one.
- **Checked against the official schemas.** The results above are tested
  against the official 2026-07-28 schema and the tasks extension's
  (`test/mcp-contract/35`), and the legacy era's through the official SDK
  client (`36`), in CI. Only the list caching hints changed with it.

## What HTTP API clients will notice

- **No `topic` in an error body.** It is `{code, message, kind, fault?}`.
  Match on `code`.
- **The HTTP status comes from the error catalogue.** Each code has its
  own: a caller's error is a 4xx, a rate limit 429 and a busy runtime 503
  (the last two with `Retry-After` when the limiter says when to retry).
  Match on `code`, not on the status.
- The request-body limits, `application/json` for JSON, and the browser
  origin check are in [Before you upgrade](#before-you-upgrade).
- **Breaking: an action whose declared schemas make it unusable is refused
  here too.** A tool whose input schema, or output schema as advertised,
  holds a hidden character where nothing can be left out (an enum or const
  member, a property name, a required entry, a pattern...) is not listed
  and not callable over MCP. `invoke-action` now refuses it as well, with
  `ACTION_NOT_FOUND`, as an action that isn't there; `add-job` accepts it,
  and the job's run fails with `ACTION_NOT_FOUND` instead of running, as
  does a task already queued for it; `get-spec` leaves it out of the
  spec it answers, and `schema` refuses its input and output schemas.
  Every action is decided, a tool or not (a resource or completion
  action, or one with no description, is refused over these routes too,
  and over `resources/read` and `completion/complete`). It is decided
  once, when the module loads, and the load's warning names each such
  action.
- **Breaking: `GET /devices/:id/schema` answers only the advertised,
  cleaned schemas.** It no longer serves `schema.json` by any JSON
  pointer. A path at or under a usable action's declared schema (its
  input, its output, a question's form) answers that schema as
  `tools/list` shows it: `$ref`s put in place, an output's binary fields as
  advertised, its text cleaned and anything holding a hidden character
  left out. `/`, a service or an action answers a container of only those
  schemas, at their places (no `$defs`, no `$ref`). Any other path
  (`/$defs/...`, another keyword of the document, a part that was left
  out, a character of a string) answers `SCHEMA_PATH_NOT_FOUND`, as a path
  that names nothing does.
- **Breaking: `get-spec` and `schema` answer only a module the caller's
  `tools/list` could show.** A module outside the key's grants, a part that
  is loaded only because another module calls it, a module that is not a scenario under the single-identity
  profile, or one that is going on or off at that moment is refused whole
  with `MODULE_NOT_LISTED`. Within a listed module every usable action is
  answered, a tool or not, as above. An output declared with any type is
  shown, as `tools/list` shows it to a client of the current protocol era.
- **`get-spec`'s declared text is cleaned as the MCP lists show it.** Each
  action's and resource's `title`, a question's `message` and the
  device's own short fields (its `manufacturer`, `modelName`...) are one
  line; a `description`, the device's `modelDescription` and a prompt
  message's `text` keep their line breaks and tabs; every hidden character
  becomes a space (as in `tools/list`, `resources/list`, `prompts/list`
  and a question's dialog), in an embedded device's spec too. A prompt
  `prompts/list` leaves out (an argument named with a hidden character) is
  left out of `promptList`. The device's `deviceID` and `friendlyName`, and
  the spec's structure, are as declared.
- **Breaking: `/device-list` and `package-info` keep to the same scope.**
  `/device-list` lists only the modules the caller's `tools/list` could
  show, each spec as `get-spec` answers it (no unusable action, the text
  cleaned); with `--debug` too. `package-info` refuses a module outside
  that scope with `MODULE_NOT_LISTED`. A device no module serves, or one
  outside the key's grants, answers the same: `MODULE_NOT_LISTED`, 404, on
  every route, the single-identity profile included, so the answer never
  says which modules exist. (A listed module's device that is still loading
  answers `DEVICE_NOT_FOUND` on `invoke-action`.)

## What operators get

- **The Redis balance ledger is named by fingerprint (#516).** Each key's
  record is a hash named `sha256:<hex>` of the key, never the key itself,
  so 8.0 does not read a 7.x balance. Re-seed each key's balance:
  `COUNTINGHOUSE_SEED_KEY=<key> countinghouse-meter set --store redis
  --balance <n>` (the key from the environment, never an argument). The 7.x records, hashes named
  by the raw keys in Redis db 0 (the ledger's database, in 7.x and 8.0),
  stay until you delete them: once re-seeded, delete every hash there with a
  `balance` field whose name does not start with `sha256:` (for example,
  list them with `redis-cli -n 0 --scan`).
- **Each runtime's job queue is its own.** Its BullMQ prefix is the
  server's own id (`{chj-<16 hex>}`), random, made at the first start and
  kept beside the data as `.server-id` (in `--moduleDataPath`, or
  `--storePath` in the single-identity profile; mode 0600), so two runtimes
  on one Redis no longer take each other's jobs. It does not follow the
  identity secret: rotating the secret keeps the queue. A data directory
  restored without its `.server-id` is a new server, with a new queue; so
  is every start on a data directory that does not persist (a container
  with no volume for it), even with the secret given in
  `COUNTINGHOUSE_IDENTITY_SECRET`: keep `--moduleDataPath` (`--storePath`
  in the single-identity profile) on storage that outlives a restart.
  One live runtime per server id on a Redis: a start whose id another live
  runtime holds (two runtimes on one data directory, or a directory or
  image copied with its `.server-id`) is refused, exit 2, naming the
  holder, before it serves; give each server its own data directory, or
  remove `.server-id` from the copy. A claim whose holder is gone is taken
  over: at once when it was a process of this host that has ended, else
  once it goes a heartbeat (about 12 s) without renewal, so a replaced pod
  waits that long before it serves. (ch-local's runtimes share a data
  directory with `--store local`, which has no Redis queue and makes no
  claim; nor does a `--stdio` runtime, one session whose queue is its
  process's own, `{chj-<server id>-<8 hex>}`, so several MCP clients each
  spawning one on the default data directory run side by side.) The start
  whose scan finds no old job history records that in
  Redis (`countinghouse:legacy-jobs-none`, db 5), and later starts no longer
  scan for it; the old jobs and schedulers are a few cheap reads, counted
  at every start. Jobs
  and schedulers queued before the upgrade, under the old shared
  `{cdifJob}`, are not moved: the start logs how many, once, and leaves them;
  re-create any you still want once no older runtime serves that prefix.
- **Old job history is not carried over.** A job's history is now the
  server's own (`jobinfo:{chj-<server id>}:<name>`; a `--stdio` runtime
  without `--port` keeps none); the lists 7.x kept under
  `jobinfo:<name>` are not read (the start's line counts them). Purge them as
  below once no older runtime uses them.
- **The module registry is opt-in: `--moduleRegistry`.** A start with no
  `--loadModule` no longer reads the CDIF-era registry database
  (`lib/device-db`, `sqlite3`) or loads modules from it: it loads nothing,
  and serves the platform tools. Pass `--moduleRegistry` to keep the old
  behaviour. Under `--hardened`, such a start no longer gets
  `--allow-addons` either ([reference](cli-and-api-reference.md)).
- **`POST /reload-auth`** (admin key), and the authoring tool
  `countinghouse_reload_auth`, re-read the auth configuration without a
  restart. A file that fails its checks is refused (`AUTH_RELOAD_INVALID`),
  and the configuration in use stays. A file that can't be verified as this
  user's own is applied tighten-only: what tightens is applied, what adds or
  widens is refused, and the answer carries a note saying how many changes
  were applied and refused (`ok: false` when any was refused). The answer never holds a key.
- **MCP over stdin and stdout:** `--stdio`, started by a desktop MCP client
  through `countinghouse-stdio` (`bin/countinghouse-stdio.js`; not
  `bin/countinghouse`, which pipes the log). The log goes to stderr and no
  port is opened ([reference](cli-and-api-reference.md)).
- **Scenarios and parts** (`countinghouse.role` in a module's
  `package.json`): `--loadModule <scenario>` also loads the parts its
  `countinghouse.calls` names; a part it loads is not listed
  (`MODULE_NOT_LISTED` from outside), and a scenario's tools are listed
  under their bare action names. A module with no role is listed as before
  ([module-authoring.md](module-authoring.md#roles-scenarios-and-parts)).
- **Usage records:** every `tools/call` on a listed module is counted at the
  runtime's boundary. `--usageDir <dir>` appends the records to daily JSON
  Lines files (counts, tool and server names, the credential variable's
  name and the opaque caller id; never a credential value or content), and `countinghouse-usage --usageDir <dir>` prints the
  report in your shell. The counts, the receipt and
  `countinghouse_usage_report` work without `--usageDir`.
  Under `--store local` the directory defaults to `<storePath>/usage`;
  under `--store redis` it is explicit-only.
- **Local mode, with no Redis:** `--store local` keeps metering, a
  module's `ctx.redis` data and jobs in files under `--storePath` and in
  memory, for a client machine. Jobs and MCP tasks run in-process, are not
  kept across restarts, and a finished one is readable for `--jobResultTtl`
  seconds (default 3600). `--meter` keeps balances and limits. With
  `--stdio` and neither `--authConfigPath` nor `--authProvider`, it is the
  single-identity profile: one key made at start and written nowhere. `--store redis` stays the default
  ([reference](cli-and-api-reference.md)).
- **`POST /uninstall-module {name, keepData}`** (admin key): removes a
  module's registry entry. Unless `keepData` is true, it deletes the
  module's data under `--moduleDataPath` and its `ctx.redis` keys (its
  namespace, `m:` plus the URI-encoded module name plus `:`, so `@acme/tool`'s
  keys are under `m:%40acme%2Ftool:`), so a later module of the same name inherits
  neither; the answer gives `keysDeleted`. The keys go first, then the
  registry entry, then the data: a purge that fails answers
  `MODULE_KEYS_NOT_PURGED` with the registry entry and the data kept (a
  retry deletes the keys that are left); one that fails at the data, after
  the keys and the entry are gone, answers `MODULE_DATA_NOT_REMOVED` with
  the data kept, and a retry finishes it. It never removes the
  module's code. Unload the
  module first ([reference](cli-and-api-reference.md)). A reload or an
  upgrade keeps the keys.
- **For ch-local's single-identity runtime:**
  - **`--settingsFile <path>`** (the user's `settings.json`) lists the
    built-in **`countinghouse_settings`**. An agent reads the settings and
    tightens them within bounds. Raising a cap or a timeout, or turning a
    pack on, needs the user's own confirmation
    (`SETTING_NEEDS_CONFIRMATION`, which names the terminal command; made
    there, a raised cap or timeout above what the runtime started with takes
    effect when it next starts); the
    sandbox and automatic upgrades are loosened only from a terminal
    (`SETTING_LOOSENS_A_GUARD`). It works only in the single-identity profile:
    anywhere else, a hosted server or a start with `--authConfigPath` or
    `--authProvider`, the start stops with exit 2.
  - **`--controlChannel ipc`** is the channel `ch-local start` uses while
    the runtime serves. It works only in the single-identity profile, over
    an IPC descriptor the spawning process holds, and is refused with
    `--hardened`. It serves `notice` (a pack change to announce) and `set`
    (a setting that applies now), and `load`, `unload` and `reload` of a
    pack, named by its scenario's package name. A reload drains, then
    switches: calls already running finish on the old version, and new calls
    to the pack wait until the new version is up. That wait is at most
    `--requestTimeout` plus the new worker's start, the cost of upgrading
    without a restart.
  - **The shared runtime:** `ch-local daemon` starts one runtime per user
    with `--sessionSocket` (a Unix socket, or a named pipe on Windows), and
    each client session reaches it through ch-local's native shim, `ch-shim`. A stored
    result, a task and the lists are the session's own. See
    [the reference](cli-and-api-reference.md#cli-flags-reference).
  - **Per-session modules:** a module whose `package.json` declares
    `"countinghouse": {"state": "per-session"}` gets, on the shared runtime,
    a worker of its own per session, with its own `ctx.redis` keys, `/data`
    and `/tmp`.
    - `--maxSessionWorkers` (16 by default) caps how many such workers run
      at once, in all.
    - Each costs about 24 MB, plus about 15 MB once: about 400 MB at the
      default cap ([the measurement](benchmarks/lean-worker.md#per-session-workers-shared-runtime-r1)).
    - A hosted server refuses such a module (`MODULE_NEEDS_SESSIONS`); under
      `--stdio` it runs as a shared one.
  - **A pack a ch-local release withdraws** (no longer lists) is not
    started, at `ch-local start` or after an upgrade. The client is told once
    per session: "pack X was withdrawn in this release and was not started;
    `ch-local remove-pack X` removes it". Nothing of the pack is deleted. An
    upgrade to such a release still installs (ch-local #74).
  - None of these is for a hosted server.
- **Disk limits in the policy:** `diskMb` and `diskEntries` take the same
  ceilings and per-module entries as the other limits.
- **A link check at start:** under `enforce`, a module whose data holds a
  symlink with an absolute target, or a hard link to a file that also has a
  name outside its data, does not start until you remove it; the log names
  the entries.
- **Under `enforce`, modules cannot read** `auth.json`, other modules' code
  and data, or anything else outside their namespace through `fs` or the
  loader, by the routes the design knows of. Under `audit` the protected
  files (`auth.json`, other modules' code and data) and writes outside a
  module's own area are refused as well, and other reads go ahead and are
  logged; `audit` does not stop a module that starts a process, a thread or
  native code ([security model](security-model.md)). The remaining gaps (network access
  until parts 3 and 4, host processes racing the checks, module code
  reaching countinghouse's objects) are listed in
  [`security-model.md`](security-model.md#what-this-explicitly-does-not-provide-accepted-gaps-and-limits).
- **Remote MCP servers** (RC1-min): a module may declare one in
  `countinghouse.remotes` and call it with `ctx.call('remote:<name>/<tool>')`
  through the main thread, which holds the connection and the credential. A
  credential is sent only where your `--remoteCredentials <file>` allows
  that variable for the declared URL's exact origin; a remote whose
  credential is not allowed is not contacted. `--remoteTimeout` and
  `--remoteMaxBytes` bound each call. A redirect is followed only within the
  declared URL's origin (the same scheme, host and port, at most 5); one to
  another origin is refused (`REMOTE_UNREACHABLE`), so a credential never
  leaves its origin. Earlier documentation said no redirect was followed;
  it has been corrected
  ([module-development.md](module-development.md#calling-a-remote-mcp-server),
  [security-model.md](security-model.md#remote-mcp-servers-a-module-cannot-choose-where-a-credential-goes)).

## Modules no longer receive API keys (R2-1)

The runtime no longer hands a module an API key or a user name. Before and
after:

| A module reads | 7.x | 8.0 |
|---|---|---|
| `ctx.caller` | `{apiKey, userName, isAdmin}` | `{id, isAdmin}`: `id` is `u_` and 22 characters, the same for a user everywhere on this server |
| `ctx.recordUsage(...)`'s answer | `{apiKey, tool, cost, ts}` | `{id, tool, cost, ts}` |
| `ctx.httpHeaders` | every request header | minus `X-CH-Key`, `X-App-Key` and `Authorization` |
| `ctx.serviceClient({..., as})` | authorizes as `as` | `as` is refused ("identities come from the operator's runsModules binding; remove `as`"); it authorizes as the module's binding, like `ctx.call` |
| `CHUtil.createServiceClient({appKey})` in a worker | authorizes as `appKey` | refused; use `ctx.serviceClient` |
| `CHUtil.dm`, `CHUtil.ci` | reachable | gone from the global `CHUtil` (undocumented; breaking for any use) |
| a hop callee's `ctx.caller` | the hop identity's key | the hop identity's `{id, isAdmin}` |

**For module authors.** Replace `ctx.caller.apiKey` and `.userName` with
`ctx.caller.id` (a bill or a per-user record keys on it), drop `as` from
`ctx.serviceClient`, and declare every call in `countinghouse.calls`: in 8.0
a third-party module's undeclared inner calls are refused
(`CTX_CALL_UNDECLARED`), whatever API it uses. The bundled demos and
examples show the shape.

**For operators.**

- Bind each composing module to its internal identity (`runsModules`, by the
  module's package.json name, or sqlite's `bind-module`), as
  [Before you upgrade](#before-you-upgrade) says, and grant that identity
  the targets.
- Add an `id` to an auth entry **before** you rotate its key: without one,
  the user's id is derived from the key, so a new key is a new id, which
  orphans the user's per-user module data and schedulers.
- The secret behind every id is generated at first start in
  `<moduleDataPath>/.identity-secret` (0600), or given in
  `COUNTINGHOUSE_IDENTITY_SECRET`. Back it up with the auth config: a new
  secret changes every id. Back up `.server-id` beside it too: a new one is
  a new job queue.
- Purge the job history 7.x kept in Redis db 5: its `jobinfo:*` lists
  hold callers' raw keys. In 8.0 a module's `ctx.redis` can no longer reach
  them, since every module's keys live in its own namespace (`m:` plus the
  URI-encoded module name), and new records name their owner by the caller id, but the old
  lists stay until removed:
  `redis-cli -n 5 --scan --pattern 'jobinfo:*' | grep -v '^jobinfo:{chj-' | while IFS= read -r k; do redis-cli -n 5 del "$k"; done`
  (8.0's own lists, `jobinfo:{chj-...}:<name>`, are kept; a 7.x
  job's history is gone).
- A module still reads files and environment outside its namespace under
  `--moduleSandbox audit` and `off` (the always-denied set aside), so keys
  in such files are within its reach there: run `enforce` for tenants you do
  not trust, and keep Redis behind a password or ACL
  ([security-model.md](security-model.md)).

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
- On Windows, `--hardened` with an npm-hoisted install (countinghouse's
  dependencies beside it in `node_modules`) is refused before it relaunches:
  Node 24.22's permission model refuses grants whose names extend each
  other's there (`ajv` beside `ajv-formats`;
  [nodejs/node#66812](https://github.com/nodejs/node/issues/66812)), and
  countinghouse names them and exits 2. This is a limitation of Node, not of
  countinghouse: until Node fixes it, on Windows run `--moduleSandbox enforce`
  without `--hardened` (enforce protects files on Windows without it;
  `--hardened` is the opt-in extra layer), or from an install whose
  dependencies are inside it.
- On Windows, `--hardened` loads no module in a worker yet: every module
  load fails with Node's "Access to this API has been restricted" (fails
  closed; the read it refuses is not pinned yet). Run `--moduleSandbox
  enforce` without `--hardened` there.
- On Windows, a module's declared host paths (`countinghouse.permissions.fs`)
  are limited ([#204](https://github.com/mchen6/countinghouse/issues/204)):
  a declaration is POSIX-absolute, so `/srv/x` names that path on the
  runtime's current drive, and a path on another drive can't be declared.
  The module always has its own `/data` and `/tmp`.
