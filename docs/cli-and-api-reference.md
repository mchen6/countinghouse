# CLI and HTTP API reference

Operator-facing reference for the countinghouse runtime: the command-line
flags most deployments need, and the HTTP endpoints the server exposes.
For what the runtime *is* and why it exists, start with the
[README](../README.md).

## CLI flags reference

Every flag the runtime reads (`lib/cli-options.js`). The last rows are the
less common ones: a few operator flags (`--modulePath`, `--authoringTools`,
`--debugKey`, `--dbUrl`, `--deviceLogEntrySize`, `--heapDump`,
`--maxSessionWorkers`), then the shared runtime's and `ch-local`'s, which
`ch-local` passes and an operator of a hosted server never sets, and two
internal ones.

| Flag | Default | Purpose |
|---|---|---|
| `--workerThread` | on (8.0.0) | Run each device module in its own `worker_threads.Worker` — the isolation this project is built around. `--no-workerThread` (or `--workerThread false`) selects single-thread mode, which is for debugging modules: no module sandbox, and startup logs a warning saying so. |
| `--bindAddr` | `127.0.0.1` | Address to bind the HTTP server to. Remote clients need it set (e.g. `0.0.0.0`); it was the first non-internal IPv4 address before 8.0.0. |
| `--port` | `9527` | HTTP port. |
| `--stdio` | off | Serve MCP over stdin and stdout instead of HTTP: newline-delimited JSON-RPC, one response line per request, batches and notifications as over HTTP. The log goes to stderr, and nothing but JSON-RPC is written to stdout. No port is opened, and `--port` with `--stdio` is refused (exit 2). The key is the process's own, from the single-identity profile, or `COUNTINGHOUSE_API_KEY`, and is never printed. When stdin closes, the calls in flight drain (up to `--requestTimeout`) and the process exits 0, or 1 if the drain ran out. Clients start it through `countinghouse-stdio` (`bin/countinghouse-stdio.js`), a pure JavaScript entry. `bin/countinghouse` is a shell script that pipes the log through bunyan, so it is not for stdio. |
| `--usageDir` | `<storePath>/usage` under `--store local`; unset under `--store redis` | Where usage records are appended: `<dir>/<YYYY-MM-DD>/<pid>-<startMs>.jsonl`, one JSON object per line, one file per process per day. Each record holds counts, tool, server and pack names, the credential variable's name and the opaque caller id, never a credential value or any content. Under `--store local` every launcher that shares a `--storePath` writes to one usage directory, so the report covers every agent on the machine. Under `--store redis` it is explicit-only, and unset nothing is written. The counters, the receipt and `countinghouse_usage_report`'s memory source work either way. `countinghouse-usage --usageDir <dir> [--since <day|ISO time|30m|24h|7d|all>] [--until <day|ISO time|duration>] [--groupBy tool|server|pack|module] [--json|--csv]` prints the report of the files for the operator's shell: first the days the records cover, then the period's totals with the tokens kept out of the model's context (an upper-bound estimate), the rows, one row per day and a profile. An error result's record also holds its error code (`countinghouse/code`), never its message. |
| `--loadModule <path>` | — | Load a local device module at startup; repeat for multiple modules. |
| `--moduleRegistry` | off | Read the CDIF-era module registry (`lib/device-db`, which needs the optional `sqlite3`) when no `--loadModule` is given, and load the modules it lists from `--modulePath`. Off, a start with no `--loadModule` loads nothing and serves the platform tools. |
| `--redisUrl` | `redis://127.0.0.1:6379` | Redis instance for metering, rate limiting, and session state. |
| `--store redis\|local` | `redis` | Where the runtime keeps metering, a module's `ctx.redis` data and jobs. `local` uses no Redis: plain files under `--storePath` and memory, for a client machine. `--store local` with `--redisUrl` exits with status 2 ("choose one"). |
| `--storePath <path>` | `<moduleDataPath>/../store` | The local store's directory. Several runtime processes may share one: every write is locked and merges by key. Files are the owner's only. |
| `--jobResultTtl <seconds>` | `3600` | In `--store local`, how long the local job runner keeps a finished job (its result, or its failure) to be read; jobs are not kept across restarts. Under `--store redis` BullMQ keeps them as before. |
| `--meter` | off | In `--store local`, keep today's balances and limits (`--apiKeyRateLimit`, free calls, balances in `<storePath>/metering.json`, under each key's fingerprint, never the key). Without it, every call is recorded and none is refused for balance or rate. Set a key's balance with `COUNTINGHOUSE_SEED_KEY=<key> countinghouse-meter set --storePath <dir> --balance <n>`: the key is read from that variable only, never from an argument, and the command prints the fingerprint it wrote. |
| `--authProvider file\|sqlite\|couchdb` | `file` | AuthProvider backend — see [Authentication](authentication.md). `sqlite` needs the optional `sqlite3` native module, whose prebuilt binary requires glibc >= 2.38 and so does not load on e.g. Ubuntu 22.04; `file` (the default) and `couchdb` need no native modules. See [authentication.md](authentication.md#sqlite). |
| `--authConfigPath <path>` | backend-specific | Config file/db path for the selected AuthProvider backend. |
| `--debug` | off | Bypass AuthProvider entirely: every apiKey accepted, every key treated as admin, no `tools/list` filtering, no task-ownership check. Local iteration only — not a way to grant access, see [Admin keys](authentication.md#admin-keys). |
| `--no-directPeerChannels` | direct channels on | Route worker-to-worker calls through the main thread instead of directly. Direct peer channels are the default since 7.1.0 (when hosting, `--directPeerChannels` is still accepted and is a no-op; in the single-identity profile it is refused, below) — see [`direct-peer-channels.md`](direct-peer-channels.md) for what the two paths check and when. In the single-identity profile peer channels are off, and `--directPeerChannels` is refused (exit 2): a peer hop carries no usage call id. When hosting, they stay on, and a receipt undercounts the server calls of any hop that takes one. |
| `--peerChannelAuthRecheckSeconds <n>` | `5` | How often the authorization behind each open peer channel is re-checked, so a grant revoked while the server runs closes the channel. `0` turns the re-check off. |
| `--peerChannelAuthLookupTimeoutMs <n>` | `10000` | How long one of those re-check lookups may take, in milliseconds. Past it the channel it guards is closed as unconfirmed: an auth backend that never answers leaves no channel open. A number above 0, else the default. |
| `--directPeerChannelsMaxConcurrency` | `16` | Backpressure cap (in-flight calls per channel) for the direct-peer-channels path (the default path). |
| `--moduleQuestions off` | questions on | Turn off every module's question to the user (`ctx.ask`): each ask is then `ASK_UNAVAILABLE`, which a module may catch to fall back. Takes `on` or `off` (`true`, `false`); any other value stops the start. On by default: a question reaches only a client whose own request declares form elicitation (MCP 2026-07-28). See `docs/security-model.md`, "A module's question to the user". |
| `--mcpToolCallCost <n>` | `0` | Cost recorded via `MeteringProvider.recordCall` for every MCP `tools/call`. A finite number `>= 0`; anything else exits with status 2. |
| `--remoteCredentials <file>` | none: no credential is read | Where each credential may be sent. **Version 2** binds a key to one module: `{"version": 2, "modules": {"<package>": {"<origin>": {"<VARIABLE>": "COUNTINGHOUSE_CREDENTIAL_<n>"}}}}`. The value is read from the slot `COUNTINGHOUSE_CREDENTIAL_<n>` (n from 1 to 9999) in the server's environment, and no other name is accepted, so the file cannot send any other variable; one slot holds one binding, fixed for the life of the process; a binding of a variable that holds no secret and that every process needs (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PWD`, `LANG`, `LANGUAGE`, `TZ`, `TMPDIR`, `TEMP`, `TMP`, `LC_*`) is refused. A module gets a key only for the origin and variable bound to it; a fallbackEnv is never read. **Version 1** (process-wide): `{"<origin>": ["VAR", ...]}`; a credential is sent only where this file allows that variable for the declared URL's origin. An origin is scheme, host and port, matched exactly. Either way, under `--moduleSandbox audit` and `enforce`, a variable an allowance reads (version 2: its slots and every variable name it binds) is never copied into a worker's environment, even when a module declares it in `permissions.env`; only a value `--modulePolicy` sets for that module under that name is given. With the sandbox off a module shares the runtime's environment. A file that is neither shape exits with status 2. See [`module-development.md`](module-development.md#calling-a-remote-mcp-server). The file is a protected path: no module may read or write it, and a module's declared path that covers it, or is a directory above it, is refused. Keep it in a directory no module needs. |
| `--remoteTimeout <seconds>` | `60` | One deadline for a remote MCP call, connecting included. A positive number; anything else exits with status 2. |
| `--remoteOriginMap <origin>=<target>` | none | **Acceptance runs only.** Sends the calls of every remote declared at `<origin>` (an https origin, compared as the runtime normalises a declared one) to `<target>`, which must be `http://127.0.0.1:<port>` or `http://[::1]:<port>` (a port from 1 to 65535): a local stand-in. Only the transport moves. The declaration, the `--remoteCredentials` allowance, the variable and the receipt's `servers` stay the real ones. The map is checked whole and fixed at start, never changed after. While it is in effect, a remote whose origin it does not cover is disabled (`REMOTE_CREDENTIAL_NOT_ALLOWED`, "not covered by --remoteOriginMap; acceptance runs contact mapped origins only") and never contacted. A mapped call is not metered; every usage record of one carries `mapped: true`. The usage report and its aggregate count such calls in no group or total: they are in a `standIn` section of their own (`serverCalls`, `bytesIn`, `linesIn`, `servers`). A tool call's structured receipt (`_meta['countinghouse/receipt']`) lists the stand-in's servers under `standIn`, and its sentence says `<server> (acceptance stand-in)`. Errors from a stand-in name it beside the declared origin. A target on the Redis endpoint's port is refused at start (under `--store local` there is no Redis endpoint). It is honoured only with `COUNTINGHOUSE_ACCEPTANCE=1` in the server's own environment, which no module sees; without it, or with a malformed map, the start exits with status 2. Each mapping is logged at start. Repeat the option for another origin, one mapping each. |
| `--remoteMaxBytes <n>` | `16777216` | Largest answer a remote MCP server may send, cut off as it streams (`REMOTE_RESULT_TOO_LARGE`). A positive number; anything else exits with status 2. |
| `--validatorWorkers <n>` | one per spare CPU, 2 to 4 | Validator workers that check every module call's input and output (worker mode), off the main thread and out of the module's reach. A positive integer; anything else exits with status 2. |
| `--validationTimeoutMs <n>` | `1000` | How long one validation may take, from when it is queued (queue wait plus run); past it the call is refused `VALIDATION_TIMEOUT`, a queued one is dropped unsent, and a running one's validator is replaced. A module whose own outputs or compiles miss it 3 times in 5 minutes is refused `VALIDATION_QUARANTINED` until an operator loads it again (a slow input is not held against it). A positive number; anything else exits with status 2. |
| `--validationCompileMs <n>` | `10000` | How long compiling a module's schemas may take: every action at load (past it the load is refused, `MODULE_ASSEMBLY_FAIL` stage `schemaCompile`), and an action again in a validator that replaced one. A positive number; anything else exits with status 2. |
| `--maxOutputBytes <n>` | `16777216` (16 MiB) | The largest output a module's call may return, a hop's result to another module included, measured in its own worker before it is posted; past it the call is refused `OUTPUT_TOO_LARGE`. It also bounds every other message a module's worker sends the main thread (a log line, a `ctx.redis` command, a request): over this cap plus 64 KiB it is refused in the worker, `MESSAGE_TOO_LARGE`. The same cap bounds a hop's input on the main-thread-routed path, measured from its bytes on the main thread: past it the hop is refused `INPUT_TOO_LARGE` before any check or handler runs (a hop over a direct peer channel takes this cap with lean worker step 4). A positive integer, at most `268435456` (256 MiB); anything else exits with status 2. A validator worker's heap is four times this cap plus 64 MB, never under 256 MB. Over about 48 MiB, raise `--validationTimeoutMs` too: a result is unpacked and checked within it. |
| `--resourceRetention <s>` | `86400` (24 h) | How long a stored result (a binary value too large to send inline, MCP completeness section 2) is kept, in seconds: from `60` to `604800` (7 days). Anything else exits with status 2. |
| `--resourceStoreBytes <n>` | `536870912` (512 MiB) under `--store redis`; `4294967296` (4 GiB) under `--store local` | The bytes every owner's stored results may take in all. Past it a result that would be stored is refused `RESULT_STORE_FULL`; nothing is evicted early. Redis keeps them in db 13, local files under `<storePath>/resources/`. A positive integer, else exit 2. |
| `--resourceQuotaBytes <n>` | `134217728` (128 MiB) under redis; `268435456` (256 MiB) under local | The bytes one caller's stored results may take. Past it, `RESULT_STORE_FULL`. A positive integer, else exit 2. |
| `--resourceQuotaItems <n>` | `1024` | How many stored results one caller may hold. Past it, `RESULT_STORE_FULL`. A positive integer, else exit 2. |
| `--inlineContentBytes <n>` | `1048576` (1 MiB) | The decoded bytes of binary values sent inline in one result. In schema order, each value that fits what is left is inlined (an image or audio block, or a resource block for any other media type); the rest are stored and sent as `resource_link`s, read back with `resources/read`. `0` links every one. A whole number, else exit 2. |
| `--resourceReadCost <n>` | `0` | The metering cost of one `resources/read` of a stored result. A whole number, else exit 2. |
| `--listPageSize <n>` | `250` | How many items one page of `tools/list` (and of the other MCP lists) holds; a longer list is answered in pages, each with a `nextCursor` but the last. From `10` to `1000`, else exit 2. A client can't choose the size. |
| `--apiKeyRateLimit <n>` | unlimited | Per-apiKey calls/second cap. |
| `--globalRateLimit <n>` | unlimited | Combined calls/second cap across every caller. |
| `--requestTimeout <seconds>` | `30` | Per-call timeout before a device is considered unresponsive. |
| `--jobTimeout <seconds>` | `3600` | How long a job (a task, an HTTP `add-job`, a scheduler run) may run when it sets no timeout of its own; `0` for none; at most about 24 days (a larger value, or a job's own larger `opts.timeout`, is taken as that). A job's own `opts.timeout` wins. Like the other numeric flags, a value that is not a number of seconds (`-1`, `1h`) falls back to the default rather than stopping the server. |
| `--deviceConfigPath <path>` | `./config/devices` | Directory of per-module device config files (one `<moduleName>.json` each). |
| `--moduleSandbox off\|audit\|enforce` | `audit` (worker mode); `off` in single-thread mode | Module sandbox mode: `off` is no lockdown, limits or policy; `audit` logs violations and lets them through; `enforce` blocks them. Resource limits apply in `audit` too. Explicit `audit` or `enforce` without `--workerThread` is a startup error. See [Security model](security-model.md). |
| `--modulePolicy <file>` | none | JSON file of operator ceilings and per-module entries that narrow what each module's `countinghouse.permissions` declaration grants. Re-read when a module restarts. See [Declaring permissions](module-development.md#declaring-permissions). |
| `--moduleDataPath <dir>` | `$HOME/.countinghouse/module_data` | Where each module's private data lives: `<dir>/<package name>/data` (its `/data`, kept) and `.../tmp` (its `/tmp`, emptied when its worker starts), created with mode `0700`. Must be writable by the service user. Unload, restart and reload never delete it; `POST /uninstall-module` does. See [Files and paths](module-development.md#files-and-paths). |
| `--allowedOrigins <list>` | none | Comma-separated browser origins (e.g. `https://app.example`) allowed cross-origin access (CORS). Every route refuses (403) a request whose `Origin` is not listed; MCP clients and other clients outside a browser send no `Origin` and are unaffected. |
| `--maxRequestBody <MB>` | `8` | Largest JSON or XML request body, on every route; larger ones are answered 413. Bodies are read before the caller's key is checked, so keep this small. An `application/bson` body is answered 415 and not parsed (BSON was retired in 8.0.0: send JSON, binary as base64). |
| `--moduleLoadTimeout <seconds>` | `120` | How long a module's worker may take to answer its load, in every sandbox mode; past it the worker is ended and the load fails `MODULE_LOAD_TIMEOUT`. Generous on purpose: a slow load that does not block (a large `node_modules` through the file broker) must not trip it. A number of seconds above 0 (at most 2147483); anything else, `0` included, stops the start (exit 2). |
| `--moduleMessageRate <n>` | `2000` | Messages per second a module's worker may send to the main thread (Redis commands included); beyond it, calls fail with `RATE_LIMITED`. |
| `--hardened` | off | Re-launch the server under Node's permission model (needs `--workerThread`). Not supported for pnpm installs until [nodejs/node#66812](https://github.com/nodejs/node/issues/66812) is fixed (see [Security model](security-model.md)). Exits with status 2 before relaunching if Node would refuse one of its granted directories (paths whose names extend each other), naming them. Every module must live under `--modulePath`, symlinks resolved, on load, reload and restart alike (`MODULE_PATH_OUTSIDE_ROOT`). Adds `--allow-addons` for SQLite auth or when no `--loadModule` is given, which leaves native code in the main thread outside the permission model. `--authoringTools` adds `--allow-child-process`, which lets the whole process start children outside the permission model. On Node 26 and later it passes `--allow-net` (experimental in Node 26), so the network is unrestricted under `--hardened` on every supported Node, until the network broker. |
| `--locale <locale>` | `en-US` | Error message locale (`zh-CN` also available). |
| `--modulePath <dir>` | `$HOME/countinghouse_modules` | The module folder, created at start if it is missing; the start stops if it can't be written. `--moduleRegistry` loads from it, and under `--hardened` every module must live under it (`MODULE_PATH_OUTSIDE_ROOT`). |
| `--authoringTools` | off | Serve the four authoring tools (`countinghouse_validate_plan`, `countinghouse_validate_module`, `countinghouse_load_module`, `countinghouse_call_tool`): admin-only, and absent from `tools/list` without it. See [`module-authoring.md`](module-authoring.md). |
| `--debugKey <key>` | none | With `--debug`: the one key accepted, compared in constant time, instead of every key; any other is `SYSTEM_ERROR_UNKNOWN_USER`. Without it, `--debug` binds only to a loopback address and answers only a loopback `Host`. A bare `--debugKey` stops the start (exit 2). |
| `--dbUrl <url>` | a CouchDB at `127.0.0.1:5984` | The CouchDB that `--authProvider couchdb` uses ([Authentication](authentication.md)). The default carries development credentials: set it whenever you use CouchDB. |
| `--deviceLogEntrySize <n>` | `1000` | Under `--store redis`, about how many entries each device's log keeps (Redis db 10, newest first; it trims to the newest n + 1). Under `--store local` the log is in memory, the last 1000, whatever this says. |
| `--maxSessionWorkers <n>` | `16` | On the shared runtime, how many per-session workers run at once, in all: every per-session module, every session (one per session that uses such a module). At the cap the least recently used idle one gives up its slot, its session told that the module's in-memory state was reset, never one with a call in flight; with none idle, a call is refused `SESSION_WORKERS_BUSY` (retryable). Each costs about 24 MB, plus about 15 MB once (measured, Node 24, a small module; a heavier module adds its own heap), so the default is about 400 MB at most ([the measurement](benchmarks/lean-worker.md#per-session-workers-shared-runtime-r1)). The operator's only: no session can change it. A positive integer, else exit 2. See [module development](module-development.md#modules-that-keep-state-per-session). |
| `--heapDump` | off | A development aid: every minute, a full garbage collection, and the heap in use logged. Needs `node --expose-gc`, which `bin/countinghouse` passes; without it, it warns once and logs nothing. |
| `--sessionSocket <path>` | none | *Set by `ch-local daemon`.* Serve MCP sessions on this Unix socket (on Windows the named pipe `\\.\pipe\countinghouse-<32 hex>`) instead of stdio or HTTP: the shared runtime. Needs `--store local`, `--controlChannel ipc` and the single-identity profile; `--stdio` or `--port` with it, or a bare `--sessionSocket`, stops the start (exit 2). |
| `--sessionDir <dir>` | the socket's own directory | *Set by `ch-local daemon`.* The directory of the session secret and the runtime's lock. Required with a named pipe; on Windows a drive path only. Only with `--sessionSocket`. |
| `--controlChannel ipc` | none | *Set by `ch-local`.* The channel `ch-local start` (and its daemon) uses while the runtime serves: announcements, settings that apply now, and a pack's load, unload and reload ([Upgrading to 8](upgrading-to-8.md)). Only in the single-identity profile, over an IPC descriptor the spawning process holds; any other value, and `--hardened`, are refused. |
| `--packsRoot <dir>` | none | *Set by `ch-local`.* Where a pack the control channel loads may be (`<home>/packs`). A pack whose real path is outside every one given is refused; with none, the channel loads nothing. Repeat for more. |
| `--modulesRoot <dir>` | none | *Set by `ch-local`.* Where a module the control channel loads in the module form may be (`<home>/module-store`). Each directory a load names (`dirs`) must lie inside one by real path, with no link leading out, and holds the package its key names; a module's closure is found only among the directories given, never on a `node_modules` search path. With none, no module loads in the module form. A start given it loads only what lies inside it: every `--loadModule` and `--partDir` directory is checked the same way, a called part is looked for only among those directories, and a top-level module that cannot load is not loaded and is told to `ch-local` (`module-stopped`, `when: "start"`). Repeatable. |
| `--partDir <dir>` | none | *Set by `ch-local`.* The directory of a part the start loads, one per part. Only with `--modulesRoot`, which it must lie inside; a module a start loads calls its parts only from these and the `--loadModule` directories. Repeatable. |
| `--settingsFile <path>` | none | *Set by `ch-local`.* The user's `settings.json`, which the built-in `countinghouse_settings` reads and tightens. Only in the single-identity profile: given anywhere else (a hosted server, or a start with `--authConfigPath` or `--authProvider`), or with no path, it stops the start (exit 2). |
| `--settingsTool` | — | *Internal.* Whether `countinghouse_settings` is served, given to each module's worker (which never gets the file's path), so a size cap's error can say how to raise it. On with `--settingsFile` in the single-identity profile; a value given on the command line is ignored. |
| `--outputCeiling <n>` | — | *Internal.* The most `--maxOutputBytes` may be raised to under the operator's ceiling, as the main thread read it when it spawned a worker, given to that worker for the same error. |

**Module limits in the policy.** `--modulePolicy` ceilings and per-module
entries take the same `limits` keys a module declares: `heapMb`,
`externalMb`, `maxBlockMs`, and since 8.0.0 `diskMb` and `diskEntries`
(the module's `/data` and `/tmp` together; default ceilings 1024 and
100000). Over a disk limit, writes fail with `ENOSPC` under `enforce`.

**Installed under `/app`.** In worker mode (the default) the server refuses
to start, exit code 2, when its own code lives under `/app`, the path
modules see their own code at. Install it elsewhere (e.g.
`/opt/countinghouse`) or run with `--no-workerThread`. Modules and data under
`/app` are fine.

## HTTP API surface

| Endpoint | Protocol | Purpose |
|---|---|---|
| `POST /mcp` | MCP (JSON-RPC 2.0, stateless Streamable HTTP) | `initialize`, `tools/list`, `tools/call`, the legacy era's tasks (`params.task`; `tasks/get`/`tasks/result`/`tasks/list`/`tasks/cancel`), and for 2026-07-28 clients the `io.modelcontextprotocol/tasks` extension (`tasks/get`/`tasks/update`/`tasks/cancel`, for an action that declares `longRunning`) — the primary interface. Tasks need `--workerThread`. |
| `GET /balance` | Platform | Current balance for the caller's apiKey (`MeteringProvider.checkBalance`). |
| `GET /device-list` | Platform | Devices the caller's apiKey can see — same filtering `tools/list` applies. |
| `POST /devices/:deviceID/invoke-action` | Platform, pre-MCP HTTP API | Direct HTTP equivalent of `tools/call`; predates the MCP gateway and still works. |
| `GET /devices/:deviceID/get-spec`, `.../schema` | Platform | A device's `api.json` / resolved JSON Schema 2020-12 documents. |
| `POST /devices/:deviceID/{add,get,remove}-job`, `get-job-history` | Platform | Job control predating the MCP Tasks extension; still available for non-MCP callers. Scoped to the caller's own jobs, same ownership rule `tasks/*` applies. `add-job`'s `opts` takes `name`, `attempts` (1 to 10), `delay`, `timeout` (a whole number of milliseconds, at least 1; anything else is `ADD_JOB_ERROR`) and `repeat` (`every`, in whole milliseconds of at least 1000, or `cron`; optional `limit`); a job is authorized again each time it runs. |
| `POST /load-module`, `/unload-module`, `/restart-module`, `/reload-module`, `/uninstall-module`, `/reload-auth`, `/shutdown`, `/get-module-device-list` | Platform, **admin key required** | Module lifecycle and operational surface. Gated per request on the caller's apiKey having `admin` — see [Admin keys](authentication.md#admin-keys). Not `--debug`-gated: `--debug` bypasses the check like it bypasses every other one, but is not how you configure access to these. |

**Module names.** A load (`/load-module`, `countinghouse_load_module`, `--loadModule`, the registry at startup, restarts) must use the module's package.json name; any other name is refused with `MODULE_NAME_MISMATCH`. `POST /load-module` may leave `name` out, and then uses the package.json name.

**`sandbox` key on `POST /get-module-device-list`.** With the module sandbox
on (`--moduleSandbox audit` or `enforce`), the response for a module carries
`sandbox: {state, lastReason, exits, nextRestartAt, violations}`: `state` is
`running`, `restarting` or `suspended`; `lastReason` is why the worker last
exited (`heap limit`, `external memory limit`, `blocked event loop`,
`crash: <message>`, `exit code <n>`), or `null`; `exits` lists the exits in
the current 10-minute window as `{at, reason}`; `nextRestartAt` is the time
of the next restart attempt in milliseconds since the epoch (or `null`); and
`violations` counts the module's logged sandbox violations. A module that is
restarting or suspended is still answered, with an empty `deviceList`. The
key is absent under `--moduleSandbox off`.

**`POST /identity-lookup`** `{id}` answers `{id, userName, isAdmin}`
(`userName` null for an entry without one) for an opaque user id this server issued (`u_` and 22 characters: what a module
sees as its caller, what a bill's `billedTo` holds, what log lines name a
tenant by), and `IDENTITY_NOT_FOUND` otherwise; never the key. It's also the
authoring tool `countinghouse_lookup_identity`. Admin only. The id is an
HMAC of the auth entry's stable `id` field, else of its API key, under the
server's identity secret: 64 hex characters in
`<moduleDataPath>/.identity-secret` (mode 0600, generated on first start)
or in `COUNTINGHOUSE_IDENTITY_SECRET`. Changing the secret changes every id.
See [authentication.md](authentication.md#the-opaque-user-id).

**`POST /reload-auth`** re-reads the auth configuration without a restart,
and answers `{ok, entries, changed}`: counts only, never keys. It's also the
authoring tool `countinghouse_reload_auth`.
- **File provider:** the file is re-read and checked. If it passes, it
  replaces the configuration in use at once. If it doesn't (unreadable, not
  JSON, an entry that isn't an object), the configuration in use stays, and
  the answer, `AUTH_RELOAD_INVALID`, names the problem by entry position,
  never by key. This check is stricter than at startup, on purpose: at
  startup an unreadable file means no key is accepted (the server fails
  closed), but a reload must never replace a working configuration with a
  broken one. So a file the server started with can still be refused by a
  reload, and the answer says which entry to fix.
- **CouchDB:** its cache is emptied. **sqlite:** it reads its database on
  every call, so the reload changes nothing and says so.
- Grants added or removed apply from the next call; calls in flight finish
  as they started. An open peer channel whose grant was removed closes at
  the next re-check (`--peerChannelAuthRecheckSeconds`).
- A changed `runsModules` binding applies to modules loaded or reloaded
  after the reload. A module already running keeps the binding it was
  verified with at its load, so reload that module (`POST /reload-module`)
  to pick up a new one. The same holds for the sqlite CLI's `bind-module` and
  `unbind-module`: they take effect at the module's next load or reload.

**`POST /restart-module`** takes `{name, path, version}`; `path` and `version`
may be left out to restart the module from where it was last loaded, which
is how a suspended module is brought back. A `path` that does not exist is
refused with `INVALID_MODULE_PATH` before anything is unloaded.

**`POST /uninstall-module`** takes `{name, keepData}` and answers
`{uninstalled: true, name, dataDeleted, keysDeleted, registryEntryRemoved}`.
It removes the module's registry entry (when the server uses the registry,
that is when no `--loadModule` is given), then, unless `keepData` is `true`,
deletes the module's `ctx.redis` keys (every key under its
`m:<name, URI-encoded>:` namespace; `keysDeleted` says how many, `null`
with `keepData`) and
`<moduleDataPath>/<name>`, never following links. A reload or an upgrade
keeps both. It never removes the module's
code under `--modulePath`. Errors:

| Code | When |
|---|---|
| `MODULE_NAME_INVALID` | `name` is not a valid npm package name |
| `MODULE_LOADED` | the module is loaded, restarting or suspended: unload it first |
| `REMOVE_MODULE_INFO_FAIL` | the registry entry could not be removed; nothing was deleted |
| `MODULE_KEYS_NOT_PURGED` | the module's keys could not be deleted (the store did not answer within 30 s); its data directory was kept, its registry entry already removed |
| `MODULE_DATA_NOT_DIRECTORY` | the data directory is a link or a file; it is left alone, remove it by hand |

Every device-scoped route above (everything under `/devices/:deviceID/...`)
goes through the same `AuthProvider` check `tools/call` does. For exactly
which guarantee (auth, schema validation, metering, rate limiting,
timeout, error shape) applies on which entry path — HTTP, MCP sync, MCP
task-augmented, and both direct-peer-channel modes —
see [`cross-cutting-matrix.md`](cross-cutting-matrix.md), kept
current as a living inventory rather than a point-in-time snapshot.

