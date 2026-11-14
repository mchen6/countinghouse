# CLI and HTTP API reference

Operator-facing reference for the countinghouse runtime: the command-line
flags most deployments need, and the HTTP endpoints the server exposes.
For what the runtime *is* and why it exists, start with the
[README](../README.md).

## CLI flags reference

The flags most operators need. `lib/cli-options.js` has the complete set,
including less commonly used ones (module verification, OpenStack API
simulation).

| Flag | Default | Purpose |
|---|---|---|
| `--workerThread` | on (8.0.0) | Run each device module in its own `worker_threads.Worker` — the isolation this project is built around. `--no-workerThread` (or `--workerThread false`) selects single-thread mode, which is for debugging modules: no module sandbox, and startup logs a warning saying so. |
| `--bindAddr` | `127.0.0.1` | Address to bind the HTTP server to. Remote clients need it set (e.g. `0.0.0.0`); it was the first non-internal IPv4 address before 8.0.0. |
| `--port` | `9527` | HTTP port. |
| `--stdio` | off | Serve MCP over stdin and stdout instead of HTTP: newline-delimited JSON-RPC, one response line per request, batches and notifications as over HTTP. The log goes to stderr, and nothing but JSON-RPC is written to stdout. No port is opened, and `--port` with `--stdio` is refused (exit 2). The key is the process's own, from the single-identity profile, or `COUNTINGHOUSE_API_KEY`, and is never printed. When stdin closes, the calls in flight drain (up to `--requestTimeout`) and the process exits 0, or 1 if the drain ran out. Clients start it through `countinghouse-stdio` (`bin/countinghouse-stdio.js`), a pure JavaScript entry. `bin/countinghouse` is a shell script that pipes the log through bunyan, so it is not for stdio. |
| `--usageDir` | `<storePath>/usage` under `--store local`; unset under `--store redis` | Where usage records are appended: `<dir>/<YYYY-MM-DD>/<pid>-<startMs>.jsonl`, one JSON object per line, one file per process per day. Each record holds counts, tool, server and pack names, the credential variable's name and the opaque caller id, never a credential value or any content. Under `--store local` every launcher that shares a `--storePath` writes to one usage directory, so the report covers every agent on the machine. Under `--store redis` it is explicit-only, and unset nothing is written. The counters, the receipt and `countinghouse_usage_report`'s memory source work either way. `countinghouse-usage --usageDir <dir> [--since <day|ISO time|30m|24h|7d>] [--groupBy tool|server|pack|module] [--json|--csv]` prints the report of the files for the operator's shell. |
| `--loadModule <path>` | — | Load a local device module at startup; repeat for multiple modules. |
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
| `--directPeerChannelsMaxConcurrency` | `16` | Backpressure cap (in-flight calls per channel) for the direct-peer-channels path (the default path). |
| `--mcpToolCallCost <n>` | `0` | Cost recorded via `MeteringProvider.recordCall` for every MCP `tools/call`. A finite number `>= 0`; anything else exits with status 2. |
| `--remoteCredentials <file>` | none: no credential is read | Which environment variables may be sent to which remote MCP server: JSON `{"<origin>": ["VAR", ...]}`, where an origin is scheme, host and port, matched exactly. A module's `countinghouse.remotes` names the variable it would like; a credential is sent only where this file allows that variable for the declared URL's origin. A file that is not this shape exits with status 2. See [`module-development.md`](module-development.md#calling-a-remote-mcp-server). |
| `--remoteTimeout <seconds>` | `60` | One deadline for a remote MCP call, connecting included. A positive number; anything else exits with status 2. |
| `--remoteOriginMap <origin>=<target>` | none | **Acceptance runs only.** Sends the calls of every remote declared at `<origin>` (an https origin, compared as the runtime normalises a declared one) to `<target>`, which must be `http://127.0.0.1:<port>` or `http://[::1]:<port>` (a port from 1 to 65535): a local stand-in. Only the transport moves. The declaration, the `--remoteCredentials` allowance, the variable and the receipt's `servers` stay the real ones. The map is checked whole and fixed at start, never changed after. While it is in effect, a remote whose origin it does not cover is disabled (`REMOTE_CREDENTIAL_NOT_ALLOWED`, "not covered by --remoteOriginMap; acceptance runs contact mapped origins only") and never contacted. A mapped call is not metered; every usage record of one carries `mapped: true`. The usage report and its aggregate count such calls in no group or total: they are in a `standIn` section of their own (`serverCalls`, `bytesIn`, `linesIn`, `servers`). A tool call's structured receipt (`_meta['countinghouse/receipt']`) lists the stand-in's servers under `standIn`, and its sentence says `<server> (acceptance stand-in)`. Errors from a stand-in name it beside the declared origin. A target on the Redis endpoint's port is refused at start (under `--store local` there is no Redis endpoint). It is honoured only with `COUNTINGHOUSE_ACCEPTANCE=1` in the server's own environment, which no module sees; without it, or with a malformed map, the start exits with status 2. Each mapping is logged at start. Repeat the option for another origin, one mapping each. |
| `--remoteMaxBytes <n>` | `16777216` | Largest answer a remote MCP server may send, cut off as it streams (`REMOTE_RESULT_TOO_LARGE`). A positive number; anything else exits with status 2. |
| `--validatorWorkers <n>` | one per spare CPU, 2 to 4 | Validator workers that check every module call's input and output (worker mode), off the main thread and out of the module's reach. A positive integer; anything else exits with status 2. |
| `--validationTimeoutMs <n>` | `1000` | How long one validation may take, from when it is queued (queue wait plus run); past it the call is refused `VALIDATION_TIMEOUT`, a queued one is dropped unsent, and a running one's validator is replaced. A module whose own outputs or compiles miss it 3 times in 5 minutes is refused `VALIDATION_QUARANTINED` until an operator loads it again (a slow input is not held against it). A positive number; anything else exits with status 2. |
| `--validationCompileMs <n>` | `10000` | How long compiling a module's schemas may take: every action at load (past it the load is refused, `MODULE_ASSEMBLY_FAIL` stage `schemaCompile`), and an action again in a validator that replaced one. A positive number; anything else exits with status 2. |
| `--maxOutputBytes <n>` | `8388608` | The largest output a module's call may return, a hop's result to another module included, measured in its own worker before it is posted; past it the call is refused `OUTPUT_TOO_LARGE`. A positive integer, at most `268435456` (256 MiB); anything else exits with status 2. A validator worker's heap is four times this cap plus 64 MB, never under 256 MB. Over about 48 MiB, raise `--validationTimeoutMs` too: a result is unpacked and checked within it. |
| `--apiKeyRateLimit <n>` | unlimited | Per-apiKey calls/second cap. |
| `--globalRateLimit <n>` | unlimited | Combined calls/second cap across every caller. |
| `--requestTimeout <seconds>` | `30` | Per-call timeout before a device is considered unresponsive. |
| `--jobTimeout <seconds>` | `3600` | How long a job (a task, an HTTP `add-job`, a scheduler run) may run when it sets no timeout of its own; `0` for none; at most about 24 days (a larger value, or a job's own larger `opts.timeout`, is taken as that). A job's own `opts.timeout` wins. Like the other numeric flags, a value that is not a number of seconds (`-1`, `1h`) falls back to the default rather than stopping the server. |
| `--deviceConfigPath <path>` | `./config/devices` | Directory of per-module device config files (one `<moduleName>.json` each). |
| `--moduleSandbox off\|audit\|enforce` | `audit` (worker mode); `off` in single-thread mode | Module sandbox mode: `off` is no lockdown, limits or policy; `audit` logs violations and lets them through; `enforce` blocks them. Resource limits apply in `audit` too. Explicit `audit` or `enforce` without `--workerThread` is a startup error. See [Security model](security-model.md). |
| `--modulePolicy <file>` | none | JSON file of operator ceilings and per-module entries that narrow what each module's `countinghouse.permissions` declaration grants. Re-read when a module restarts. See [Declaring permissions](module-development.md#declaring-permissions). |
| `--moduleDataPath <dir>` | `$HOME/.countinghouse/module_data` | Where each module's private data lives: `<dir>/<package name>/data` (its `/data`, kept) and `.../tmp` (its `/tmp`, emptied when its worker starts), created with mode `0700`. Must be writable by the service user. Unload, restart and reload never delete it; `POST /uninstall-module` does. See [Files and paths](module-development.md#files-and-paths). |
| `--allowedOrigins <list>` | none | Comma-separated browser origins (e.g. `https://app.example`) allowed cross-origin access (CORS). Every route refuses (403) a request whose `Origin` is not listed; MCP clients and other clients outside a browser send no `Origin` and are unaffected. |
| `--maxRequestBody <MB>` | `8` | Largest JSON, XML or form request body, on every route; larger ones are answered 413. Bodies are read before the caller's key is checked, so keep this small. |
| `--maxBsonRequestBody <MB>` | `64` | Largest BSON body, read only on `POST /devices/:deviceID/invoke-action` (`add-job` takes JSON only); larger ones are answered 413. |
| `--moduleMessageRate <n>` | `2000` | Messages per second a module's worker may send to the main thread (Redis commands included); beyond it, calls fail with `RATE_LIMITED`. |
| `--hardened` | off | Re-launch the server under Node's permission model (needs `--workerThread`). Not supported for pnpm installs until [nodejs/node#66812](https://github.com/nodejs/node/issues/66812) is fixed (see [Security model](security-model.md)). Exits with status 2 before relaunching if Node would refuse one of its granted directories (paths whose names extend each other), naming them. Every module must live under `--modulePath`, symlinks resolved, on load, reload and restart alike (`MODULE_PATH_OUTSIDE_ROOT`). Adds `--allow-addons` for SQLite auth or when no `--loadModule` is given, which leaves native code in the main thread outside the permission model. `--authoringTools` adds `--allow-child-process`, which lets the whole process start children outside the permission model. On Node 26 and later it passes `--allow-net` (experimental in Node 26), so the network is unrestricted under `--hardened` on every supported Node, until the network broker. |
| `--locale <locale>` | `en-US` | Error message locale (`zh-CN` also available). |

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
| `POST /mcp` | MCP (JSON-RPC 2.0, stateless Streamable HTTP) | `initialize`, `tools/list`, `tools/call`, and the Tasks extension (`tasks/get`/`tasks/result`/`tasks/list`/`tasks/cancel`) — the primary interface. |
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
  to pick up a new one.

**`POST /restart-module`** takes `{name, path, version}`; `path` and `version`
may be left out to restart the module from where it was last loaded, which
is how a suspended module is brought back. A `path` that does not exist is
refused with `INVALID_MODULE_PATH` before anything is unloaded.

**`POST /uninstall-module`** takes `{name, keepData}` and answers
`{uninstalled: true, name, dataDeleted, registryEntryRemoved}`. It removes
the module's registry entry (when the server uses the registry, that is when
no `--loadModule` is given), then deletes `<moduleDataPath>/<name>` unless
`keepData` is `true`, never following links. It never removes the module's
code under `--modulePath`. Errors:

| Code | When |
|---|---|
| `MODULE_NAME_INVALID` | `name` is not a valid npm package name |
| `MODULE_LOADED` | the module is loaded, restarting or suspended: unload it first |
| `REMOVE_MODULE_INFO_FAIL` | the registry entry could not be removed; nothing was deleted |
| `MODULE_DATA_NOT_DIRECTORY` | the data directory is a link or a file; it is left alone, remove it by hand |

Every device-scoped route above (everything under `/devices/:deviceID/...`)
goes through the same `AuthProvider` check `tools/call` does. For exactly
which guarantee (auth, schema validation, metering, rate limiting,
timeout, error shape) applies on which entry path — HTTP, MCP sync, MCP
task-augmented, and both direct-peer-channel modes —
see [`cross-cutting-matrix.md`](cross-cutting-matrix.md), kept
current as a living inventory rather than a point-in-time snapshot.

