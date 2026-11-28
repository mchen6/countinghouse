# Changelog

Notable changes per release. Releases before 6.1.0 carry their notes in
their annotated git tag (`git show v6.0.0`); this file starts the in-repo
record and 6.0.0 is summarized below as the baseline.

This project follows [semantic versioning](https://semver.org/), where the
public surface is the CLI flags, the MCP contract, the module format, and
the auth config.

## 8.0.0

- A pause of the main thread no longer counts as a validator's stall: a check that was answered meanwhile passes, with no strike against its module.
- A call whose validator stopped or missed its deadline is refused, even when no validator can be started in its place; before, such a call could wait for its own time limit instead.
- A call that reaches a runtime while it is still starting, before its module's composition check is decided (a shared runtime lists a module while its parts still load), is now held until the check is decided, for at most 25 s and 2 s inside its request timer, then sent with the module's verdict. It used to be sent at once and fail with `DEVICE_INVOKE_EXCEPTION` once its handler's `ctx.call` ran; a task created in that window failed the same way. Past the bound it answers `CTX_CALL_NOT_READY` (retryable), never sent. A held call whose module fails its check, ends, or is turned off meanwhile is never sent: over MCP it gets the answer a new call would get then, and on the REST routes the route's one answer for a device the caller can't use (`MODULE_NOT_LISTED`, 404). A cancelled or timed-out held call is never sent either.
- `CTX_CALL_NOT_READY` now reads "Not ready yet: the runtime is still checking a module this call needs, so the call to it was not run; retry in a few seconds."
- The answer to a tool a caller can't use now ends "; countinghouse_overview shows what is installed here and which tools you can use", the same words for every caller (the code, -32602, is unchanged).
- In a shared runtime, a session's tightening of a cap for all sessions past its 32 recorded changes still applies at once to every session, but is no longer written to `settings.json`: it lasts until the runtime restarts, and the answer's `applies` and its history line say `all sessions, until the runtime restarts`. Past the budget, taking back a raise stored for the next start changes nothing now and is answered the same way, since the stored raise still applies at the next start. Its history was one line and a count written later, so the stored value was ahead of the history, and ch-local's next start reported the runtime's own change as one made outside. A tightening made at a terminal is stored as before.
- The runtime, its shipped packages and its docs are in English only. `--locale` and the `locale` setting are removed: passing `--locale` has no effect, and every message is in English. `echo-device-client-module`'s service and action are now `x` and `API`; its tool name is unchanged.
- A shared runtime's 2025-11-25 session now hears `notifications/tools/list_changed`, as a `--stdio` client does: declared on its `initialize`, and sent once it has listed, whenever the tool set changes (it may leave that session's list the same, which costs one re-list). Claude Code (2.1.330) falls back to 2025-11-25 when its 3 s `server/discover` probe times out. A slow cold start of the shared runtime does that; a fast one doesn't. A session on 2025-11-25 never heard a tool added or removed.
- A 2025-11-25 client of a `--stdio` runtime or of a shared runtime's session is now told `notifications/prompts/list_changed` and `notifications/resources/list_changed` too, declared on its `initialize` (`capabilities.prompts.listChanged`, `capabilities.resources.listChanged`): once it has listed its prompts or its resources, when that list changes. Before, a cold start's client listed its prompts before the packs had loaded, so the packs' prompts never reached its menu. A client that goes on in 2026-07-28 after its initialize is told none of these unasked, its tools' included.
- In a shared runtime, a notice told to every session (a module that stopped, a module's settings changed, a start-time warning) now also reaches a session that joins later, with a later tool result: the runtime keeps this run's newest 5 of each kind, up to 64 kinds, from the last 24 hours (a module loaded again clears its own), each led by "Earlier, before this session joined (<time>):", or after a runtime restart "After a runtime restart, before this session resumed (<time>):". When kept notices had to be let go, one line says how many earlier notices are not shown. Before, a session that joined later never heard them.
- `countinghouse_usage_report` in a session's own runtime (ch-local's per-session profile) covers that session's calls since its runtime started, not every earlier session's: as on the shared runtime, each session's usage is its own. `countinghouse-usage --usageDir <dir>` still covers every session that writes there.
- `countinghouse_overview` names each local store file that is corrupt and that this runtime holds no copy of, in a new `store` field, with what is refused and, under ch-local, the command that says what to do. It is shown only to an admin or in the user's own runtime, and `metering.json` only with `--meter`.
- A call that fails as a crash or an untyped failure (`DEVICE_INVOKE_EXCEPTION`, `DEVICE_INVOKE_FAIL`) after the runtime refused one of its calls to another module or a remote service now says so in one more sentence, with that refusal's code (a refusal about another module's state, such as one that was unloaded, reads DEVICE_NOT_FOUND; the runtime's log keeps the exact code): "Before it failed, the runtime refused its call to another module: DEVICE_NOT_FOUND." It never names the other module and never repeats the module's own text. It also covers a refusal further down, of a call made by a module it called, even if that module still answered; such a refusal reads DEVICE_NOT_FOUND (the runtime's log keeps the exact code). A later call by the failing module that the runtime lets through clears it, so the sentence names the most recent refusal before the failure; when calls run at the same time, it names one of their refusals. A task run (a task-augmented `tools/call` or a job) adds the same sentence.
- A call that fails as a crash, an untyped failure or a runtime error is now logged at error level without `--debug`, one line each: "a call failed: <module>/<action>: <code> (the module crashed | the module failed | a runtime error)", ending with the runtime's refusal before it when there was one. At most 5 lines per tool in 10 minutes, then one line saying how many more were left out since when. A module's own error answers are not logged, nor any input or module text. Task runs are logged the same way.
- A runtime that met a Redis that was closing as it first connected could spin its main thread at full CPU and stop answering; it now fails the commands it had queued and keeps answering.
- A store write now writes the whole new content before it replaces the file, so a full disk never truncates a store file: the file keeps what it held; a change to settings or stored data is written once a write can, and a usage charge that can't be written is reported as failed.


### Changed — a billed call runs only while its charge can be recorded

- A billed call (a tools/call other than a completion's action, an
  invoke-action, a job's run, a hop) is refused retryably before it runs
  while its charge can't be recorded: `LEDGER_UNREACHABLE` (Redis can't be
  reached, or just failed a charge) and `LEDGER_UNWRITABLE` (a local
  ledger's write just failed). Over MCP a refused tools/call is a tool error
  result carrying the code; an HTTP answer is 503 with Retry-After 5 s;
  either way the text ends "retry shortly". Before, with Redis down a billed call ran and was never
  charged. An unbilled call is limited in memory and served, as before.
- One key whose own usage record can't be charged (of the wrong type, a
  free-call record that isn't JSON, or a balance that isn't a number Redis
  can add to) has its billed calls refused with
  `LEDGER_RECORD_INVALID` (not retryable) until the operator repairs it;
  other keys are served. The log names the record by the key's
  fingerprint.
- `GET /balance` with Redis unreachable answers `LEDGER_UNREACHABLE`, never
  the Redis client's own error.
- A charge lost after its call ran is logged by the key's fingerprint, the
  tool and the amount; the ledger is marked and the next billed call is
  refused until a probe (at most one a second) finds it recording again.
  The metering client's commands have a 3 s deadline.
### Changed — a module's name maps to one data folder on every system

A module whose name has a part that ends in a dot or a space ("my-tool."), has
"~" followed by a digit (an 8.3 short name's form, "abcdef~1"), or is a
Windows device name (con, prn, aux, nul, com0–com9, lpt0–lpt9, with or
without an extension: "nul.txt") is refused at load (`MODULE_NAME_INVALID`)
on every system, Windows or not. Windows would put each one in another
module's data folder, or in no folder at all. `validate_module` reports such a
name before the load does. A hosted runtime that loaded a module with such a
name now refuses it: rename the package.

### Changed — one answer for every limit on `/mcp`

A key over its rate limit on `/mcp` (outside `tools/call`) was answered
`-32603 "rate limit exceeded"` with HTTP 200 and no `Retry-After`. It is now
answered as the limit on keys that don't resolve already was: the JSON-RPC
error -32000, the catalogue's message, and `countinghouse/code`, `kind` and
`retryAfter` in its data. A single request's answer is HTTP 429 with
`Retry-After`, or 503 when the runtime itself is at its limit
(`RUNTIME_BUSY`: a module resource read at `--globalRateLimit`) or has as
many subscriptions open as it allows (the new code `SUBSCRIPTIONS_FULL`,
retried once one closes). A legacy batch stays 200, with
`Retry-After` the longest hint. `subscriptions/listen` over a key's or a
session's open subscriptions is the new code `TOO_MANY_SUBSCRIPTIONS` (429).
`tools/call` still answers a limit as a tool error result. A client that read
a limit by `-32603` or its message reads `countinghouse/code` instead.
### Added — authoring your own modules under `ch-local`

In the single-identity profile with `--settingsFile` (`ch-local start`), the local user gets three authoring tools, with no admin key and no `--authoringTools`:

- **`countinghouse_validate_plan`** works as it does for an admin.
- **`countinghouse_validate_module`** checks a folder **without running its code**:
  - it refuses a folder inside the `ch-local` home, `--modulePath`, `--moduleDataPath` or the store, or holding one of them, or reached through a link (`OWN_MODULE_PATH_REFUSED`);
  - it walks the folder first, reading no file: a link, a file with a second name, anything that is neither a file nor a folder (a FIFO, a socket, a device), more than 20,000 entries or more than 16 MiB, and **nothing in it is read**;
  - otherwise each file it reads is opened without following a link and without blocking, and read only if it is a regular file under one name, within a bound;
  - the handler files are checked against `api.json` by name alone;
  - a file that fails to read or parse is named, never quoted;
  - it also reports what `ch-local add-module` will refuse: a module that isn't a scenario, and npm dependencies or `node_modules`.
- **`countinghouse_load_module`** never loads here. It answers `OWN_MODULE_NEEDS_TERMINAL`, naming the command the user runs in their own terminal (`ch-local add-module "<folder>"`). Adding a module is the user's own act.

The overview lists the user's own modules, from `ch-local`'s `own.json`, after the packs, each marked `own: true`, with `tree`: the start of its files' hash as `ch-local add-module` printed it (of the copy loaded, or for one not loaded, of the one last added). The held-back file takes five own-module reasons:
- `changed`: its files changed since the user added it;
- `gone`: its copy is not there at all;
- `sandbox`: the sandbox is not enforced;
- `collision`: another module uses its name, named in `via`;
- `refused`: this release's runtime refuses to load it, with its `code`.

Each has its own `next` line, and `changed`, `gone` and `refused` are given only to an own module. The rest of own-module hosting (add-module, loading the confirmed copy, credentials) is `ch-local`'s.

### Added — the server's instructions, and `countinghouse_overview`

A first-run user's agent can now learn what countinghouse is and what is
installed. `initialize` and `server/discover` carry one fixed paragraph of
`instructions`, the same for every caller. The new platform tool
`countinghouse_overview`, listed to every caller, answers what is
installed here: each pack's state (ready, off or not loaded), what it does,
its tools and example requests, and what is still missing, such as a
credential the user adds in their own terminal, with the command. It shows
only what the caller can already use, writes nothing and takes no
arguments. Its answer is data, sent as JSON text and as `structuredContent`,
at most 8 KiB the two together; what a module wrote (its description and
example requests) stands only under each pack's `byTheModule`, each one
line, cleaned. Under `ch-local` it reads the install record and the new
`--heldBackFile` (set by `ch-local`). tools/list gains the tool.

### Added — requests whose API key doesn't resolve are limited per address

An unauthenticated loop cost one auth-provider lookup per request, with
nothing in its way. Now at most `--unauthRateLimit` (30) lookups of keys
that don't resolve a minute per client address (IPv6 by its /64; each
counted while in flight, a legacy batch's each; ten times that per IPv6
/48 or IPv4 /24, a hundred times that across the process) are made; past
any of them the address is answered 429
`UNAUTH_RATE_LIMITED` with `Retry-After`, before any lookup, the same answer
whatever was wrong with the key and whatever was named. `/device-list` now
resolves its key first (an unknown key still lists nothing). A key that resolved
lately still passes, until it is refused. Only a request's own lookups
count against its address (a worker it happened to start does not).
`--trustProxy` names the proxies whose `X-Forwarded-For` is
believed (none by default: only behind a proxy you control; at most an
IPv4 /8 and an IPv6 /32 together). HTTP only.
### Fixed — a call still running at a stop is recorded, cancelled

A clean stop left the usage record of every call still running begun and
never ended: the local job runner dropped its pass's call on close, the
BullMQ runner had no close at all, and SIGTERM ended the process before any
exit handler ran. Now the job runners end their running passes, and then
every call still open, a tools/call not yet answered included, is recorded
as a cancelled call (nothing sent, the time it had run), in one synchronous
sequence at exit that runs before the local store's last write. SIGTERM
ends the process through it, with status 143; SIGINT's status is unchanged
(0).
### Fixed — a module setting's own words are cleaned before a client sees them

`countinghouse_settings get` returned a module setting's title and
description (`byTheModule`) as the author wrote them, and the confirmation
form quoted the title the same way; nothing on the way out cleaned them.
Both now go through the module-text rule: a hidden character becomes a
space, a title is one line of at most 64 characters, a description at most
512, its line breaks kept.

### Fixed — each runtime's job queue is its own

Every runtime opened its BullMQ job queue under one prefix, `{cdifJob}`, so
two runtimes on one Redis took each other's jobs (a job for a module only
one of them loaded ran on the other and failed). The prefix is now the
server's own, `{chj-<server id>}`: a random 16-hex id made at its first
start and kept beside its data (`<moduleDataPath>/.server-id`, or
`<storePath>/` in the single-identity profile; mode 0600, one name only,
checked as the identity secret is, and in the always-denied set). The same
across restarts and a rotated identity secret; another for a server with its
own data directory. A runtime claims its id on Redis before it takes a job:
a start that finds the id held by another live runtime (two runtimes on one
data directory, or a directory copied with its `.server-id`) is refused,
exit 2, saying so, before it serves; one whose holder has ended, or stops
renewing for a heartbeat, is taken over. A `--stdio` runtime is one
session: its queue is its process's own (`{chj-<server id>-<8 hex>}`), and
it makes no claim, so several on one data directory run side by side,
keeps no job history (nothing could read it), and its finished jobs are
removed three hours after they finish. A server's job history is its
own too, under `jobinfo:{chj-<server id>}:<name>`. Jobs and schedulers left under
`{cdifJob}`, and the history kept under the old unscoped `jobinfo:<name>`
keys, are not moved or read: a start counts them read-only, says how many in
one line, once, and leaves them. Old job history is not carried over.
### Fixed — one shared-runtime session's stalling inputs no longer throttle the others

The validator pool holds an input's stalls against its caller, and after
three in five minutes refuses that caller's calls to the module
(`VALIDATION_CALLER_THROTTLED`). In a shared runtime every session is the
one local user's, one caller id, so one session's stalling inputs throttled
every session. There the caller is now the caller and its session (calls,
routed and direct hops, job runs, `prompts/get`): each session has its own
three stalls, its own validation in flight, and its entries go when it
ends. Over HTTP and `--stdio` it is the caller id, as before (a client
choosing new session ids cannot slip its own throttle).

### Changed — every device ID: countinghouse's own namespace

A device's ID was a UUID v5 of `https://registry.apemesh.com/packages/<friendlyName>`,
a seed under another project's registry. It is now a UUID v5 of the
`friendlyName` in countinghouse's own namespace, fixed for good
(`lib/call-address.js` `CH_DEVICE_NS`), so every ID changed. Grants that
list specific device IDs must be regenerated, in an auth file, sqlite or
CouchDB (`'*'` grants are unaffected); a start logs, once per module, an
auth-file or sqlite grant that still names a loaded module's pre-8.0 ID,
with the new one (again after an auth reload; CouchDB's are not checked).
What is kept under a device ID is orphaned: device logs, and the
metering's per-tool records and a CouchDB user's `priceRecord` (free calls
left on them are lost unless rewritten under the new IDs). Pending jobs and
repeatable schedulers made before the upgrade name the old IDs: remove them
and add them again. Module code that declares its calls names them, never
an ID (composite-demo, perf-caller-demo and a test fixture now ctx.call by
name). The examples' `auth.json` files are regenerated, and the tests,
scripts and examples compute IDs with `deviceIDForName`.

### Changed — the usage report counts a cancelled call apart: `profile.cancelled`

A call cancelled while it ran (M19) was counted among the report's errors.
It is no error: `countinghouse_usage_report` (and `countinghouse-usage`)
now count such calls in `profile.cancelled`, and leave them, and the
server calls the cancel aborted (`CALL_TOKEN_INVALID`), out of
`profile.errors`. A task cancelled with `tasks/cancel` while its run ran
is such a call: its run's record says `cancelled`, whatever the run's end.
### Changed — `tools/call` answers a tool outside the key's grants as an unknown tool

A known key's `tools/call` of a tool outside its grants (an unlisted part's
too) now answers `-32602 unknown tool: <name>`, as a name never registered
does, instead of `-32603` with the no-access text: one answer for every tool
a caller can't see, so a call no longer tells what is installed; so is a
runtime tool not listed to the key (an authoring tool for a non-admin key,
which answered `ADMIN_REQUIRED`; the single-identity profile's hidden
built-ins, which answered `MODULE_NOT_LISTED`). No key and
an unknown key keep their auth refusal, now the same for every name,
the runtime's own `countinghouse_*` tools included.

### Removed — the pack form, `--packsRoot`, a ceiling's `packs`, `fallbackEnv`

Module-level configuration's cleanup (#413 rev 3, section 16, rule 7):
- ch-local's control messages are the module form only. A message carrying
  `scenario`, `pack`, `global` or `remoteCredentials` is refused, and
  `--packsRoot` stops the start (exit 2); ch-local passes `--modulesRoot`.
- The ceiling's `packs` is no longer a key: a ceiling that still holds it is
  not trusted, saying to list each module under `modules`.
- A runtime with `--controlChannel` takes only a version 2
  `--remoteCredentials` file.
- A remote's `fallbackEnv` is refused: a credential is one variable.
- The settings tool no longer reads `packs.json`: with no `modules.json`,
  nothing is installed.
- Usage records and the report say `scenario` for the call's top-level
  module (`groupBy: "scenario"`); a record that says `pack` is still read.
- The catalogue's texts name a module, never a pack.

### Changed — `--settingsFile` outside the single-identity profile stops the start

- **`--settingsFile` is refused (exit 2) outside the single-identity
  profile**, as `--controlChannel` and `--sessionSocket` are:
  `countinghouse_settings` is served only there (ch-local start). Given on a
  hosted server, or with `--authConfigPath` or `--authProvider`, it used to be
  accepted and half-applied: the tool was not served, yet a size cap's error
  told the agent to raise the cap with it. ch-local passes it only in that
  profile.

### Fixed — modules load on Windows when the install is run by an 8.3 short name

An install run by a short-name spelling (`C:\Users\RUNNER~1\...`, as
under GitHub's Windows runner's temporary directory), with no
`--preserve-symlinks`, listed none of its modules under the sandbox: each
failed with `Cannot find module '/app/handlers/...'`. A module's worker
loaded the runtime's files by the short spelling until its file broker was
installed and by the long one after, so one of them was loaded twice. The
worker is now started by its real path, and each file is loaded once.

### Fixed — the settings ceiling is found on Windows with no SystemDrive in the environment

A runtime started with no `SystemDrive` in its environment (ch-local's
daemon is) could not find ProgramData. Every setting that loosens a default
was then refused with `SETTING_CEILING_UNTRUSTED`. The lookup now sets
`SystemDrive` itself, from the system's Windows directory, before asking for
the folder.

### Removed — flags that did nothing, or let a failing module load

- **`--verifyModule`** is gone. With it, the loader carried on past a
  module's failed interface check, `DEVICE_SPEC_VALIDATION_FAIL`,
  `INVALID_MODULE_INSTANCE` and even `DEVICE_OBJECT_CONFLICT`, and
  registered the device anyway. A module that fails a check is now refused
  whatever the options (`test/module-loading/37`). `countinghouse-validate`
  is the way to check a module.
- **`--apiMonitor`** is gone, with the Redis client it opened: it wrote a
  per-call API log that nothing read.
- **`--centralPortalUrl`**, **`--wetty`** and **`--validateData`** are gone:
  nothing read them.
- **`--logStream`** is gone: it chose between the logger's two
  configurations, which had become one (the log goes to the same place with
  it or without).
- **`--heapDump`** stays (a dev aid), and no longer throws every minute when
  Node runs without `--expose-gc`: it says once that it needs it
  (`bin/countinghouse` and `npm run start-heap-dump` pass it) and does
  nothing.

### Added — the shared runtime: one runtime for a user's client sessions (#245–#371)

- **`--sessionSocket <path>`** serves MCP sessions on a Unix socket, or on
  Windows a named pipe with `--sessionDir` (#245, #248, #275). It is
  `ch-local daemon`'s, one runtime per user, which each client session
  reaches through ch-local's native shim. It needs `--store local`,
  `--controlChannel ipc` and the single-identity profile.
- **Each session is its own:**
  - its `server/discover` and `subscriptions/listen` (#249);
  - its settings within the operator's ceiling, a loosening confirmed in
    its own form (B2: #268, #271, #292, #296);
  - its packs (B3: #340, #341, #359);
  - its tasks, which another session cannot see and which its end cancels
    (B5: #334, #366, #371);
  - its usage in the report and its settings history (#352, #360).
- **A session resumes across a runtime restart** with its state (#262, #300,
  #308). A drain lets calls in flight answer before the runtime stops (#255,
  #267).

### Added — modules that keep state per session (R1, #350–#356)

- **`"countinghouse": {"state": "per-session"}`** in a module's
  `package.json` gives it, on the shared runtime, a worker of its own per
  session, started on that session's first call, with its own `ctx.redis`
  keys, `/data` and `/tmp`, removed when the session ends (#350, #351, #353,
  #356).
  - A hosted server refuses such a module (`MODULE_NEEDS_SESSIONS`); under
    `--stdio` it runs as a shared one.
  - Any other value refuses the load (`MODULE_STATE_INVALID`), and a reload
    that changes it is refused (`MODULE_STATE_CHANGED`).
- **`--maxSessionWorkers`** (16 by default) caps how many such workers run
  at once, in all. At the cap the least recently used idle one gives up its
  slot, and with none idle a call is `SESSION_WORKERS_BUSY`. Each costs
  about 24 MB, plus about 15 MB once: about 400 MB at the default cap
  ([measured](docs/benchmarks/lean-worker.md#per-session-workers-shared-runtime-r1),
  #377).

### Changed — a job past its timeout fails `JOB_TIMEOUT` (#375)

- A job run past its own `opts.timeout`, else `--jobTimeout`, fails with
  the catalogued `JOB_TIMEOUT` (retryable, HTTP 504), not a library's text,
  in both job runners. An answer that comes later is dropped. A 2026-07-28
  task that times out is `failed` with that code.

### Added — the tasks extension for 2026-07-28 clients (MCP completeness, M15, #329)

- **A call to an action that declares `longRunning`**, from a client that
  declares `io.modelcontextprotocol/tasks`, is answered at once with a task
  (with `--workerThread`). The client polls `tasks/get`, and may
  `tasks/update` and `tasks/cancel`. Anyone else's call runs inline.
- **A request to those methods without the extension is `-32021`.** Over
  HTTP they, `tools/call`, `resources/read` and `prompts/get` carry an
  `Mcp-Name` header that must agree with the body. A task is its caller's,
  and on a shared runtime its session's. Another's, an unknown id or a
  legacy task is one `-32602` that echoes no id. Legacy-era tasks are
  unchanged.

### Added — prompts (MCP completeness, M10, #321)

- **A device's `promptList`** is served on `prompts/list` and `prompts/get`,
  as `<module>_<name>` (a scenario's under the bare name), to the keys that
  may reach the module. `prompts/get` runs no module code: it checks the
  arguments against the prompt's schema, puts each `{{name}}` in once and
  returns the messages, at most 64 KiB.

### Added — module resources (MCP completeness, M7, #327)

- **An action may be declared a resource** (`resource` in `api.json`), not
  a tool. It is listed on `resources/list` (no variables) or
  `resources/templates/list`, as `countinghouse://m/<module>/<path>`, to the
  keys that may reach its module. `resources/read` runs the action as a
  `tools/call` would: authorized, validated, rate limited and billed, with
  the URI's variables as its input, decoded once. A value with a control
  character, a `/` or a `\`, or that is exactly `.` or `..`, never reaches
  the module.

### Added — a tool's title, annotations and icons (MCP completeness, M2, #319)

- **`tools/list` carries an action's `title`, `annotations` and `icons`**
  when it declares them. The hints are the author's claims; the runtime
  enforces none. Icons, files in the module (PNG, JPEG or WebP, at most
  16 KiB, never SVG or a URL), are read at load and sent inline as `data:`
  URIs. A missing or bad one refuses the load (stage `icons`).

### Added — `tools/list` in pages (MCP completeness, M1, #317)

- **A list longer than `--listPageSize`** (250 by default, 10 to 1000) is
  answered in pages, each but the last with a `nextCursor`. The resource,
  template and prompt lists page the same way. A client can't choose the
  size. A modern list result carries `ttlMs` and `cacheScope` (#379).

### Added — cancelling a call in flight (MCP completeness, M19, #314, #316)

- **A 2026-07-28 request over HTTP is cancelled** when its POST closes
  before the answer. On stdio and a shared runtime's session,
  `notifications/cancelled` cancels a call of the same connection or
  session. A cancelled call writes no answer. A composite stops at its next
  hop, and a remote call made for it is aborted. Work already running
  finishes, its result discarded, and is billed. With `--workerThread`; in
  single-thread mode a cancel only suppresses the answer.

### Changed — output schemas of any JSON value (MCP completeness, M20, #304)

- **A 2026-07-28 `tools/list` advertises an output schema of any root
  type**, and a modern result carries the output, whatever its type, as
  `structuredContent`. A module's output may be any JSON value its schema
  allows, `null` included (before, anything but an object was refused). A
  legacy request is unchanged.

### Added — progress (MCP completeness, M9, #303; M21, #306)

- **A `tools/call` with a `progressToken`** gets `notifications/progress` as
  its hops and remote calls run, at most every 250 ms, before the answer,
  on HTTP (the POST becomes an SSE stream when the first one is due), stdio
  and a session.
- **Breaking: `ctx.job` is never `null`.** Outside a task it is
  `{id: null, progress(n), info(cb)}`: `progress(n)` (0 to 100) is the
  call's own progress, sent with `total: 100`. A module that asked
  `ctx.job == null` asks `ctx.job.id == null`.

### Added — stored results and resource links (MCP completeness, M5, #299; M6, #313)

- **A result's binary values past `--inlineContentBytes`** (1 MiB of decoded
  bytes per result, in schema order) are stored and sent as `resource_link`s.
  `resources/read` returns them to the caller who made the call, in the same
  session, for `--resourceRetention` (24 h).
- **The store is bounded:** `--resourceStoreBytes` in all, and per caller
  `--resourceQuotaBytes` and `--resourceQuotaItems`. A result that would pass
  a limit is refused `RESULT_STORE_FULL`, with nothing stored. It lives in
  Redis db 13, or local files under `<storePath>/resources/`.
  `--resourceReadCost` meters a read. Stored results are never listed.

### Changed — binary values: base64 asserted, and sent as blocks (MCP completeness, M3, #293; M4, #297)

- **Breaking: `contentEncoding: "base64"` is an assertion**, on input and
  output: canonical RFC 4648 base64, or `INPUT_DATA_VALIDATION_FAIL` /
  `OUTPUT_DATA_VALIDATION_FAIL` naming the field.
- **Breaking: a Buffer, typed array or DataView in an output is refused**,
  `OUTPUT_NOT_JSON`, in the module's worker (it was mangled).
- **An `image/*` or `audio/*` base64 field is sent as its own content
  block**, and any other media type as a `resource` block. Each is referenced
  in `structuredContent` as the advertised `outputSchema` says.

### Added — resource and prompt change notices on a listen (MCP completeness, M8)

- **`subscriptions/listen` agrees to `resourcesListChanged`,
  `promptsListChanged` and `resourceSubscriptions`**, on HTTP (the SSE
  stream), stdio and a shared runtime's session, beside `toolsListChanged`.
  A settled change that moves the resources (or templates) or the prompts a
  listener is shown sends one `notifications/resources/list_changed` or
  `notifications/prompts/list_changed`; a reload that lists the same says
  nothing. `server/discover` declares `resources: {listChanged: true,
  subscribe: true}` and `prompts: {listChanged: true}` where a listen is
  served.
- **`resourceSubscriptions`**: of the URIs asked, the acknowledgement agrees
  to those the caller can read (a module resource its key, and its session,
  are listed), in order, at most 64, each at most 2048 bytes; the rest are
  left out. After a call to an action a subscribed resource names in
  `changesWith` succeeds, by any entry path, each of the calling key's
  subscriptions naming one of its URIs is sent
  `notifications/resources/updated`, once per URI per quarter second. On a
  shared runtime a per-session module's change reaches only the calling
  session. A call with no key (`--debug` without `--debugKey`) is not
  recorded, so it announces nothing. An HTTP listen whose client leaves
  more than 1 MiB unread is closed (the listen is cancelled). A resource's
  `changesWith` naming its own read action refuses the load.

Upgrading from 7.x: [`docs/upgrading-to-8.md`](docs/upgrading-to-8.md)
groups everything below by what an operator has to do. Measured cost of the
file broker on the maintainer's 2-CPU VM (at `9246db1`): 250 rounds of a 4 KB
write, read, stat and unlink take about 30 ms with no broker, 1.2 s under
`--moduleSandbox off` and 1.9 s under `enforce`; a module restart takes about
1.3 s (at `cd411ee`), against about 4.2 s on 7.1.2
([benchmarks](docs/benchmarks/sandbox-part2.md)).

### Changed — declared text reaches the client with no hidden characters (MCP completeness, M18)

What a module declares for the client is cleaned as it leaves: a tool's
title and description, a prompt's title, description, arguments'
descriptions and messages, a resource's title and description, and a
question's dialog. Each hidden character (a control, line separator, bidi
control, zero-width character, tag, variation selector or filler) becomes a
space. A prompt's message keeps its line breaks and tabs, and an emoji
keeps its joiner and VS-16. A completion candidate with a hidden character
is no longer offered. Nothing is refused or changed at load.

### Added — completion for resource templates, and completion actions (MCP completeness, M11)

- **`completion/complete` takes `ref/resource`**: one of the caller's listed
  resource templates, by its URI template; the variable's candidates are
  the input property's `enum`, then its `examples`, derived at load and
  matched as a prompt argument's are.
- **A prompt or a resource may name a completion action**
  (`"completion": {"<argument>": "<service>.<action>"}`): called with
  `{argument, value, context}`, it answers `{values: string[]}` (100 kept,
  of at most 256 characters). It runs as a call of that action, authorized
  and rate limited, is not billed and is recorded in usage as
  `completion/complete`; it is not listed as a tool. If it fails, answers
  no values or takes more than 2 s, the schema's candidates are offered,
  and a run past 2 s is cancelled as a cancelled call is.

### Fixed — a 2026-07-28 task's status mirrors the inline answer

- **A task whose module was unloaded, reloaded or suspended while it ran**
  is now `completed`, its result the isError result the same `tools/call`
  gets inline, with the code in `_meta["countinghouse/code"]`
  (`MODULE_UNLOADED`, `MODULE_RELOADING`, `MODULE_SUSPENDED`). It was
  `failed`. The tasks extension uses `failed` only for a request that fails
  with a JSON-RPC error, and a tool result with `isError` is `completed`
  (`tasks.md` l.157-158, l.835-837). A task is still `failed`, with its
  JSON-RPC `error`, when its run left no answer: the runner's
  `--jobTimeout`, or the owner's access refused when the run starts.
  Legacy-era tasks are unchanged.

### Changed — the module sandbox's checks run on intrinsics captured at load; `path`, `url` and `URL` are fixed

- **The lockdown's checks** (the allowed built-ins, a path given to
  `CHUtil.loadFile` or the reduced `module.createRequire`, a granted host
  for `CHUtil.request`) call only functions taken before module code loads,
  and each guard hands a call on through a `Reflect.apply` taken then; so
  do the file broker's routing, grants and loader hook, and the resolve
  shim. The allowed built-ins and
  the loopback names are no longer exported as live sets
  (`ALLOWED_BUILTIN_IDS`, a frozen array, takes the place of the first).
- **A module can no longer patch `EventTarget`, `NodeEventTarget` or
  `MessagePort`** under audit or enforce: their methods are fixed at the
  lockdown, as `path`'s and `url`'s are. A peer channel's port is set up
  by Node with them after module code has loaded. An assignment on an
  instance (`target.addEventListener = fn`) now throws in strict code;
  accessors such as `port.onmessage`, subclasses and
  `Object.defineProperty` on an instance still work, and so do
  `AbortController` and `AbortSignal`. The runtime's own port use (replies,
  stdio, peer channels) goes through methods taken at a worker's boot. The
  keys Node assigns on a port it sets up (`kEvents`, `kHandlers` and the
  rest) are made the port's own without reaching `Object.prototype`, and
  `util.inspect` of a port still works.
- **What a worker's calls go through is loaded at its boot**, before module
  code, and fixed there: the call path's files (call limits, a hop's
  input, peer channels, the service client, the device query and
  `countinghouse-util`, attached to the worker then) are no longer loaded
  on first use, so what module code puts in `require.cache` changes
  nothing the runtime uses, and their exports and classes' prototypes are
  non-writable. A call's token, its queues and its replies are kept in
  containers written as own properties and walked by index, with
  intrinsics taken at boot. About 8 ms more per worker boot.
- **A module can no longer patch `path`, `url` or `URL`** under audit or
  enforce: the functions of the `path`, `path.posix`, `path.win32` and `url`
  exports, `URL.prototype`'s accessors and methods, and `module.isBuiltin`
  are non-writable and non-configurable from the lockdown on. A module that
  patches them runs under `--moduleSandbox off`.

### Added — what a module declares for MCP clients is checked (MCP completeness, M0)

- **`api.json` takes the fields the MCP layer serves**: an action's `title`,
  `annotations`, `icons`, `longRunning`, `questions` and `resource`, and the
  device's `promptList`. The meta-schema holds each one's shape and bounds,
  and an action stays closed to anything else. Each field is served as its
  part of the layer is released.
- **The rules a schema cannot express are checked at load**, in a
  validator, before any of the module's code runs: `MODULE_ASSEMBLY_FAIL` at
  stage `declarations`, for the first problem. `countinghouse-validate`
  reports every problem and warning, and checks the module's icon files.
- **Two things a module could carry before are now refused at load:** a
  binary output field that is not under `properties` or an array's `items`
  (it was served as a plain string), and `x-mcp-header` anywhere in an input
  schema (the server's side of it is not built).

### Added — a task may ask its user a module's question (MCP completeness, M22)

A long-running action run as a 2026-07-28 task may now use `ctx.ask`, when
the request that made the task declared form elicitation. The pass that
asks ends; the task reads `input_required`, with the form in
`inputRequests` and the status message "waiting for an answer"; the client
answers with `tasks/update`, and the handler runs again under the same
`taskId`. The question is held on the server, outside every module's
reach, never in a requestState. The pass that asks is not billed and
spends no attempt. A question waits at most an hour, then the task fails
with the new code `ASK_EXPIRED`; at most 64 of a key's tasks (10,000 in
all) wait on a question at once, past which `ctx.ask` is
`ASK_UNAVAILABLE`.

### Added — a module may ask its user a declared question: `ctx.ask` (MCP completeness, M13)

- **`ctx.ask(name, values)`** puts one of the action's declared questions
  (`api.json`'s `questions`) to the user of a 2026-07-28 client that
  declares form elicitation, and resolves with the form's content, or
  `null` for a decline. The runtime composes what the user reads,
  `<module name>: <message>`.
- **The handler runs again.** With no answer yet `ctx.ask` rejects
  `ASK_PENDING`, the call is answered with the question (an
  `InputRequiredResult`), and the client's retry runs the handler from the
  top. Module authors: ask first, act after
  ([module development](docs/module-development.md#asking-the-user-ctxask)).
- **The retry's `requestState`** is bound to the caller, the session, the
  tool and the arguments, lasts five minutes and is used once, also across
  a restart. New error codes: `ASK_PENDING`, `ASK_UNAVAILABLE`,
  `ASK_NOT_DECLARED`, `ASK_STATE_INVALID`, `ASK_STATE_UNCHECKED`.
- **A call is asked at most eight rounds in all**, three at most of one
  question; after that `ctx.ask` is `ASK_UNAVAILABLE`.
- **`--moduleQuestions off`** turns every module's question off. Under
  `--store redis` the used states' nonces are in Redis db 14, which must
  not evict.
- **A part may ask too (M14).** A module reached through a scenario's
  `ctx.call`, routed or over a direct peer channel, asks the outer call's
  user one of its own action's declared questions. The dialog carries the
  called, listed module's name, never the part's; the usage record
  (`askedBy`) and the runtime's log name the part. The call's rounds are
  the chain's: one question a round, eight in all. The part's
  `ASK_PENDING` rejects the caller's `ctx.call`; a caller that catches it
  and returns a result keeps that result, and the question is dropped.
  In single-thread mode a part has no one to ask.
- **A call that can end on a question** (its own action declares one, or
  one it can reach through declared calls does) refuses `requestState` or
  `inputResponses` in its arguments.
- **A call cancelled while its form is made** is asked nothing: no state
  is made for it, and its record says `cancelled`.

### Changed — a latched session is told why, never that the user declined

- **`SETTING_CLIENT_NOT_CONFIRMED`** (new): a loosening asked in a shared
  runtime's session whose client said its configuration could answer a
  dialog by itself. It says why, as the client line gives it (a reason such
  as "project plugin or marketplace" and a place under the home as
  "~/..."), or "this client could not be confirmed". It was
  `SETTING_DECLINED_THIS_SESSION`, whose text read as if the user had
  declined. While the tested list, read whole, has no client, so that no session
  can be shown a dialog, such a session gets the answer every session gets
  (`SETTING_NEEDS_CONFIRMATION`, with the terminal command), and a lock kept
  across a runtime restart doesn't hold the undo of a session's own lowering.
- **`SETTING_DECLINED_THIS_SESSION`** is a decline's, or two dialogs left
  unanswered: its text no longer speaks of the client's configuration.
- **A session's own lowering is undone in conversation**, with no dialog, up to
  the value for all sessions, also where its client locked its dialogs.
  `SETTING_SESSION_OWN_VALUE_HELD` (new) says what holds it: the user's own
  lock, the ceiling, a lock kept across a restart or one across the user's
  sessions. A loosening in a session whose lock was kept across a restart is
  told `SETTING_LOCKED_THIS_SESSION`.

### Changed — `countinghouse-validate` fails a `schema.json` the load refuses as unsafe

- **A module that passed validate and was then refused at load now fails
  validate too.** `countinghouse-validate` (and the
  `countinghouse_validate_module` tool) runs the load's own schema safety
  check, in the load's order and words: a problem at stage `schemaSafety`,
  code `MODULE_ASSEMBLY_FAIL`, for a `schema.json` over 1 MB, a pattern
  that can backtrack catastrophically or is over 1000 characters, more than
  100,000 schema nodes with `$ref`s expanded, a `$ref` to itself or to no
  place, or a schema nested too deeply to check. Such a schema is not
  walked for its declarations: one problem says why.
- **Validate's problems at the stages `declarations` and `readRootSchema`
  carry `code: "MODULE_ASSEMBLY_FAIL"`**, as the load refuses the module
  with it.
- **The schema path in a `schemaSafety` refusal is cut to 512 characters
  and carries no control character**, at load and in validate: it is made
  of the module's own property names.

### Removed — BSON request bodies

- **An `application/bson` body is no longer taken**, on any route: it is
  answered 415 (`REQUEST_UNSUPPORTED_MEDIA_TYPE`), and not parsed or kept
  (it is discarded as it arrives). MCP is
  JSON only, and `POST /devices/:deviceID/invoke-action`, from the CDIF-era
  HTTP API, was the last route that decoded BSON. Send JSON, with binary
  data as base64.
- **`--maxBsonRequestBody` is gone** (it bounded those bodies, and existed
  only in this release's development). Given, it is ignored, as any flag
  the runtime does not know is.
- The `bson` package is no longer a dependency, and `INVALID_BSON_REQUEST`
  is no longer an error code.

### Added — MCP 2026-07-28 discovery and versioning; `initialize` is the legacy path (#229)

- **`server/discover`**, which 2026-07-28 requires of every server, on HTTP and
  stdio: `supportedVersions` (`["2026-07-28"]`), the capabilities, and
  `_meta["io.modelcontextprotocol/serverInfo"]`. A client that probes with it
  used to get -32601, and by the spec's rule fell back to the legacy handshake.
- **A modern request is checked.** It is one whose `_meta` carries the
  revision's `protocolVersion` or `clientCapabilities`. It must carry both
  (-32602), and name a version served (-32022, with `data: {supported,
  requested}`). Over HTTP it must also match its `MCP-Protocol-Version`,
  `Mcp-Method` and `Mcp-Name` headers (-32020). Each of these is HTTP 400.
  Its result carries `resultType: "complete"`. An unknown method is HTTP 404,
  and a modern request in a batch is refused.
- **`initialize` is unchanged** and selects legacy semantics: results stay
  exactly as before. A legacy session gets no confirmation form for a
  loosening (`InputRequiredResult` is the 2026-07-28 mechanism). It is told
  to run the terminal command.

### Changed — a call over a direct peer channel is checked by the main thread (lean worker step 4, #202)

- **The caller states the call; the callee can't restate it.** The calling
  module's worker announces each peer invoke's target (device, service,
  action) and its input, as bytes, to the main thread, which holds them. The
  port between the two workers carries the invoke's id alone. The callee
  learns the target and the checked input only from the main thread.
- **Input, before any handler runs:** checked at the announcement (strings
  within bounds, an action the caller declared, a device the channel's
  callee hosts: otherwise `CTX_CALL_UNDECLARED` or `PEER_NOT_GRANTED`),
  capped by `--maxOutputBytes` (`INPUT_TOO_LARGE`), then validated against
  the callee's input schema in a validator worker, as a routed hop's is. A
  callee whose spec the main thread doesn't hold is refused: nothing passes
  unchecked.
- **Output, before it reaches the caller:** the callee sends its result or
  error as bytes with its bill request. The main thread caps it
  (`OUTPUT_TOO_LARGE`), validates it against the callee's output schema
  (`OUTPUT_DATA_VALIDATION_FAIL`), bills only a result that passes, and
  delivers it. A result a callee posts on the port is dropped and reported
  as a sandbox violation (`peer-forged-reply`).
- **The pool's bounds apply to peer calls too:** the deadline, the caller
  throttle and strikes against the callee for its own output.
- **Bounded held input:** each calling worker holds at most two hops at the
  cap (at least 16 MiB) of announced input awaiting a match, and all
  callers at most eight (at least 128 MiB); past that, an invoke is refused
  `RATE_LIMITED`. A caller's announcements are released when the call ends
  or its deadline passes. Invoke ids are integers in range.
- **No added round trip:** the input rides the existing announcement and
  match, and the result rides the existing bill request.

### Changed — modules run in lean workers; the main thread registers their devices

- Every module now runs in `lib/lean-worker.js`,
  which loads the module's handler files and little of the runtime: no
  device manager or discovery in the worker, and a `CHUtil` facade whose
  helpers load on first use. The main thread registers a module's device
  from its own reading of `api.json` once the worker has loaded, so a worker
  no longer announces its device. A handler file that throws while it is
  required fails the load with `LOAD_MODULE_FAIL` naming the file. Under
  `--moduleSandbox off`, a module that blocks right after loading is no
  longer ended by the old discovery bound (as with any blocking handler,
  `off` bounds nothing; `audit` and `enforce` have the block watchdog).

### Added — guarding settings by conversation, part 3

- `countinghouse_settings` answers a raised cap or timeout, or a pack
  turned on, with `SETTING_NEEDS_CONFIRMATION`, naming the `ch-local`
  command the user runs to allow it; loosening the sandbox or automatic
  upgrades is terminal only (`SETTING_LOOSENS_A_GUARD`, naming the command).
  Requests not made are recorded in the history, once per kind per start.
- The operator's ceiling (`/etc/countinghouse/ceiling.json`,
  `%ProgramData%\countinghouse\ceiling.json`): lowers the hard bounds or
  forbids a loosening; a file an ordinary user could have written fails
  closed (docs/security-model.md).
- A loosening asked for in conversation can be confirmed by the user in
  their client's own dialog (an MCP elicitation form), for this start only:
  `settings.json` is never written, and the change ends when the client
  restarts countinghouse. A dialog is shown only to a client inside a tested
  version range (`lib/elicitation-clients.json`, shipped empty until
  the maintainer's hand test adds the first range), on a request that declares form
  elicitation, and when ch-local finds nothing in the client's own
  configuration that could answer it. Otherwise the terminal command is
  given, as before. New codes: `SETTING_CONFIRMATION_INVALID`,
  `SETTING_CONFIRMATION_EXPIRED`, `SETTING_CONFIRMATION_USED`,
  `SETTING_DECLINED_THIS_START`, `SETTING_CHANGED_MEANWHILE`,
  `SETTING_CEILING_CHANGED_MEANWHILE`, `SETTING_NOT_APPLIED`
  (docs/security-model.md, "Confirming a loosening in the client's dialog").
- A confirmed `maxOutputBytes` raise resizes the validators first
  (`ValidatorPool.resize`: one slot at a time, the spare first, checks
  answering throughout), then applies; a pack turned on is loaded by
  ch-local at the version the dialog showed. What was applied, or could not
  be, is told to the user as a notice.

### Added — packs in place, runtime side: a control channel, change notices and `countinghouse_settings` (#183)

For ch-local's single-identity runtime (`--store local --stdio`, no auth
configuration). None of it is available to a hosted server.

- **`--controlChannel ipc`:** a channel that only `ch-local start` holds,
  over the IPC descriptor of the process that spawned the runtime.
  - Requests are applied one at a time, in order, each answered by its id.
    `notice {module, text}` and `set {name, value}` are served. `load`,
    `unload` and `reload` follow with the rest of part 2.
  - Refused at start (exit 2) for any other value, outside the
    single-identity profile, without an IPC descriptor, or with
    `--hardened`.
- **Change notices:** a pack change ch-local applies is said once as an MCP
  `notifications/message` (level `notice`), and once as a one-line text
  block on the pack's next result, tasks included.
  - Over stdio the server declares the `logging` capability and answers
    `logging/setLevel`; a level above `notice` stops the notifications, not
    the result line.
  - A notice and its pack name are cleaned of control characters and line
    separators, and bounded. Past 20 pending, the newest are kept and the
    rest counted in one line.
- **`--settingsFile <path>`** (ch-local's `<home>/settings.json`) lists
  **`countinghouse_settings`**, to the one local user only, never through
  `ctx.call`. `get` returns each setting's value, default, bounds, whether
  it guards, when it applies, and the last 50 entries of its history, without ch-local's
  host or pid. `set` changes one setting within its bounds and never
  loosens a guarding one:
  - `SETTING_UNKNOWN`, `SETTING_OUT_OF_BOUNDS` and `SETTING_LOOSENS_A_GUARD`
    (the user loosens with the `ch-local` command).
  - It follows ch-local's protocol: a lock file created whole
    (`settings.lock`), the change appended to `history.jsonl` before the
    file is replaced, and every change logged on stderr. That adds
    `SETTINGS_BUSY`, `SETTINGS_FILE_INVALID` and `SETTING_NOT_RECORDED`.
- **A live `set`** over the control channel applies `locale`,
  `maxOutputBytes` and `requestTimeout` from the next call, and reaches
  every running module worker. A value above what the runtime started with
  applies at the next start, since the validators' heap is sized at start.
  A running call keeps its timer.

### Fixed — `countinghouse-auth-sqlite` and `countinghouse-meter` are installed as commands

- They were in `bin/` but missing from `package.json` `"bin"`, so a package
  install put no such command on the PATH, though the docs name them as
  commands (`countinghouse-auth-sqlite bind-module`,
  `countinghouse-meter set`). Before this, run them as
  `node <install>/bin/<name>.js`.

### Fixed — a worker's durations equal the main thread's (#188, #112)

- A module worker's `jobTimeout` and `jobResultTtl` were 1000 times the main
  thread's: the worker read the main thread's milliseconds as seconds again.
  Its `requestTimeout` was right only through a workaround,
  `requestTimeoutMs`.
- A worker now sets the main thread's options with
  `options.setResolvedOptions(o)`, which keeps durations in milliseconds.
  `setOptions` converts the CLI's seconds once. `requestTimeoutMs` is
  retired: ctx.call's verdict wait and a direct peer channel hop's timeout
  read `requestTimeout`.
- `--requestTimeout`, `--jobTimeout` and `--jobResultTtl` with no number
  (`--no-requestTimeout`, a bare flag, a repeated one) give the default,
  as before. Every value is capped at setTimeout's largest delay
  (2147483647 ms), past which Node fires at once.

### Changed — a routed hop's input crosses the main thread as bytes (#185)

- A `ctx.call` routed through the main thread (`--no-directPeerChannels`)
  sends its input as `v8.serialize` bytes, transferred: the main thread
  checks it in a validator and hands the checked bytes to the called module,
  never deserialising or cloning it. On 1 MB hops the main thread's CPU per
  hop fell from 5.3–6.0 ms to 2.6–3.9 ms (the PR has the table).
- **`INPUT_TOO_LARGE`** (new): a hop's input over `--maxOutputBytes`, the
  one cap, is refused on the main thread before any check or handler runs.
- A hop's input that structured clone cannot carry, or a
  `SharedArrayBuffer` (which a hop used to share between two modules'
  workers), now fails the `ctx.call` in the calling worker.

### Added — a bound on a module's load, in every sandbox mode (#144)

- **`--moduleLoadTimeout <seconds>`** (default 120): a module's worker that
  has not answered its load in time is ended, and the load fails
  `MODULE_LOAD_TIMEOUT`. Requiring a module's files is synchronous, so one
  that blocks while it is required never answers; under `audit` and
  `enforce` the block watchdog already ended it, but under
  `--moduleSandbox off` nothing did and the worker stayed.

### Added — `--moduleSandbox enforce` on Windows (#195)

- A module's files carry a drive on Windows: they are `<V>:\app\...` to
  the module (its `__filename`, `__dirname`, current directory and stack
  frames), V a drive letter the host does not have, picked once per
  process, so Node there can load them as `file:///<V>:/app/...`. The
  runtime keeps naming them `/app/...` and the file broker maps `<V>:\app`
  back to `/app`; enforce keeps a module to its own files on Windows as it
  does elsewhere. The identity loader's checks of countinghouse's code
  roots follow the host's path rules (backslash on Windows), and taking
  module roots out of them folds case there. Off Windows nothing changes.

### Changed — a module's output and its worker's log, bounded

- **Under audit and enforce a module's stdout and stderr are runtime-owned
  streams**: Node's own, which hold its port to the main thread, are never
  handed to module code. Output reaches the log line by line, prefixed with
  the module's name, each line cut at 8 KiB and stripped of control
  characters but tab, at most 256 KiB a minute per stream (then dropped,
  with one line a minute saying how much); to stderr under `--stdio`.
- **A worker's own log crosses as records** (1 MiB a minute, fields cut at
  8 KiB, the module named by the main thread), so a module flooding its
  output cannot crowd them out. Each record now carries `module`.

### Added — a bound on what a module's worker sends the main thread (#170)

- **Every message from a module's worker to the main thread is an envelope of
  serialized bytes**, its length read before anything is decoded. Over
  `--maxOutputBytes` plus 64 KiB it is refused in the worker,
  `MESSAGE_TOO_LARGE` (the file bridge: 16 MiB plus 64 KiB, `EINVAL`; a
  file write is split as before). Under `audit` and `enforce` the lockdown
  pins the worker's ports, so module code that patches
  `MessagePort.prototype` is never handed one; a worker whose message is not
  an envelope, or is over the cap, is ended. Cost: about 20 µs of main-thread
  CPU per message (a `ctx.redis` command is one).

### Changed — `ctx.redis` is per module (#164, breaking)

- **Each key a module names is stored under `m:<module name, URI-encoded>:`**, the name
  the main thread loaded the module under (never one its worker states), so
  one module cannot read, overwrite or delete another's keys, nor the
  runtime's own. Every allowed command has its key positions in a table
  (`lib/redis-namespace.js`); a command whose keys cannot be placed is
  refused. `multi` and `exec` are gone from `ctx.redis`: under
  `--store redis` node_redis's multi runs any command name queued in it.
  Single-thread mode's `ctx.redis` is namespaced the same way.
- **`POST /uninstall-module` deletes the module's `ctx.redis` keys** with its
  data (unless `keepData`), so a later module of the same name inherits none;
  the answer gains `keysDeleted`. A reload or an upgrade keeps them.
- **`POST /uninstall-module` checks everything before it removes anything**,
  then deletes the keys, then the registry entry, then the data directory. A
  store that can't be reached now keeps the registry entry and the data
  (`MODULE_KEYS_NOT_PURGED`, naming the store's error code; a retry deletes
  what is left). A data directory the uninstall couldn't read or write in
  (its permissions, a link that loops) is refused first with the new
  `MODULE_DATA_UNREADABLE`, with nothing removed. A failed registry removal (`REMOVE_MODULE_INFO_FAIL`) now
  says the keys may already be deleted.
- An uninstall that fails at its last step, removing the module's data
  directory (a full or read-only disk, its permissions), now answers
  `MODULE_DATA_NOT_REMOVED`, naming the directory and the error code; the
  directory is kept, perhaps only in part, and uninstalling again finishes
  it. Before, it gave an uncatalogued error and left the data without a
  registry entry.

### Added — `ctx.usage()`: the current call's counts so far

- `ctx.usage()` resolves with the current tools/call's counts so far,
  read-only: `{calls, bytesIn, tokensInEst, servers, sentence}`
  (and `standIn` when a stand-in answered). `sentence` is the first half of
  the receipt's sentence, word for word. Every remote server call made under
  the call is counted, its parts' included. The call's own output is not
  counted, since it is measured when the call returns. A scenario writes its
  receipt sentence from these counts, so the sentence reaches the model in
  its summary. It is `null` outside a counted call, and never carries a key,
  an id or a caller.
- A worker's query is checked on the main thread. The call's token is
  checked first, always: it must be one issued to that worker (else
  `CALL_TOKEN_INVALID`). Then anything but an open call that worker was
  given answers `null` alike, so a module cannot tell another worker's
  open call from a finished one.

### Changed — modules receive no API key and no user name (R2-1, breaking)

- `ctx.caller` is `{id, isAdmin}` (an opaque id, `u_` and 22 characters);
  `ctx.recordUsage` answers `{id, tool, cost, ts}`; `ctx.httpHeaders` drop
  `X-CH-Key`, `X-App-Key` and `Authorization`.
- `ctx.serviceClient` refuses `as` and authorizes as the module's binding,
  like `ctx.call`; `CHUtil.createServiceClient` refuses an `appKey` in a
  worker. The CDIF-era `--debug --verifyModule` portal branch, which sent a
  key over HTTP, is gone.
- No hop message, peer invoke or device query carries a key: the main thread
  authorizes and bills each by the call's token. The worker's composition
  says only that the module is bound. A hop callee's `ctx.caller` is the
  hop identity's `{id, isAdmin}`.
- The global `CHUtil` has no `dm` or `ci` (undocumented, breaking for any
  use); a worker's options carry no `redisUrl`.
- Another module announcing a reloading or restarting module's device ID is
  refused (`DEVICE_OBJECT_CONFLICT`); the device query runs the access check
  for a present device too.
- `MODULE_INSTALL_FAIL` is gone with the unreachable install path that
  raised it (with a stack in its message).

### Changed — a composing module is bound by its module name; its hops and queries reach only what it declared (breaking)

- `runsModules` (and sqlite's `module_identities`) names the module the
  server loaded, by its package.json `name`, not a device's `friendlyName`,
  which a module states for itself: a module could claim another module's
  identity by naming that module's device. One identity runs a module, all
  its devices. The bundled `echo-device-client-module` is bound as
  `echo-device-client-module` now.
- A module's device query answers only for a device it declared calls on;
  any other device, present or not, is `CTX_CALL_UNDECLARED`, and before its
  composition verdict `CTX_CALL_NOT_READY`.
- In worker mode a hop's callee gets no key and no caller identity in its
  `ctx` (the interim `args.ctx` of #130 is gone): its work bills by the
  hop's token. A hop carries only its input, usage call and token to the
  callee, whatever else the calling module put in it. (Single-thread mode,
  which isolates nothing, changes with the rest of `ctx` in R2-1's
  module-facing release.)
- `countinghouse-auth-sqlite bind-module <apiKey> <moduleName>` and
  `unbind-module <moduleName>`; `list` shows each identity's modules (#147).

### Removed — SOAP support: `CHUtil.createSOAPClient` (breaking)

- **`CHUtil.createSOAPClient` is gone**, with the `soap` dependency and its
  lockdown host check (maintainer's decision, 2026-11-13). Nothing in the
  repository, the bundled modules or the packs used it. A module that still needs SOAP
  depends on a SOAP library itself and declares its hosts under
  `countinghouse.permissions.net`. The ONVIF WSDL files under `spec/tools`
  stay, as data.
- **`CHUtil.request` loads postman-request on its first call**, as does a
  remote service client on its first post, instead of in every module
  worker's boot. The first such call in a worker costs about 200-350 ms,
  once. In docker, pack 1's median worker boot went from 1,004 to 802 ms.

### Added — local mode: `--store local`, no Redis (LM1, part B)

- **`--store redis|local`** (default `redis`, unchanged). `local` keeps
  metering, a module's `ctx.redis` data and jobs in files under
  `--storePath` (default `<moduleDataPath>/../store`) and in memory, with
  no Redis client and no queue service; several processes may share one
  store (locked, merged by key). `--redisUrl` with `--store local` exits
  with status 2.
- **Metering:** without `--meter` every call is recorded and none refused
  for balance or rate; with `--meter`, Redis's semantics, balances in
  `metering.json` under each key's fingerprint (never the key);
  `countinghouse-meter set` seeds one, the key read from
  `COUNTINGHOUSE_SEED_KEY` only.
- **`ctx.redis`:** the same 19 commands (21 before #164 removed `multi`
  and `exec`), with Redis's answers and errors.
- **Jobs and MCP tasks:** an in-process runner with job-control's surface;
  not kept across restarts; `--jobResultTtl <seconds>` (default 3600).
- **The single-identity profile** (`--store local --stdio` without
  `--authConfigPath`): one key made at start and written nowhere, no auth
  file, a caller id from `<storePath>/.identity-secret` that survives
  restarts.
- **On Windows:** the store's lock waits while another process is deleting
  it (Windows refuses opens of a file being deleted with EPERM), and a lock
  still refused when the two-second wait ends fails with EPERM and its
  path. A kill there ends the process with no handler run, so the writes
  since the last scheduled one are lost (up to about half a second of
  metering, five seconds of `ctx.redis` data); a clean stop (stdin
  closing, Ctrl-C) writes them.


### Removed — CDIF-style modules: one module format (breaking)

- **A module is `api.json`, `schema.json` and `handlers/<service>/<action>.js`**
  (lean worker, step 1; maintainer's decision, 2026-11-13). A module with a
  main entry (`package.json` `"main"`, or an `index.js`) and no `handlers/`
  directory is
  refused before any of its code runs, at every way in (start, load, reload,
  restart) and by `countinghouse-validate` (stage `layout`), with the new code
  `MODULE_LAYOUT_UNSUPPORTED`, whose text names the file. That retires a
  `device.js` exporting a handler map and an `index.js` class or EventEmitter
  doing its own discovery (`discover`, `deviceonline`, `deviceoffline`). With
  a `handlers/` directory, a main entry is never run, by the runtime or the
  validator (whose `loadModuleEntry` stage is gone).
- **`MODULE_NOT_DISCOVERABLE` is gone**: only the retired shape could raise it.
- `npx countinghouse-migrate-module ./my-module` converts a 5.x module (a
  `CHDevice` with `setAction`); a `device.js` handler map is converted by
  moving each entry into its own handler file.
- `CountinghouseError.withFields(code, fields, ...args)`: a catalogue text's
  `{placeholders}` filled in for the locale.

### Security — a module's input and output are checked in validator workers, out of its reach

- **Every call the main thread sends to a module's worker** (an MCP
  `tools/call`, an HTTP `invoke-action`, a job's run, a hop routed through
  the main thread) is validated (lean worker, step 1(b)). The input is
  checked before the call is sent, so a bad input never reaches the worker,
  and the output on the reply.
- **Where:** in a validator worker (`lib/validator-pool.js`), neither on the
  main thread nor in the module's own worker. No module code runs there.
- **How:** the main thread reads the module's `api.json` and `schema.json`
  before its worker starts (`lib/module-spec.js`) and keeps only structural
  facts: names, the spec text, a hash. The validator compiles the schemas
  lazily with the same `Service` code a worker uses, so every refusal keeps
  its code, text and fault. The module's worker skips its own validation for
  those calls.
- **Why:** the checks ran in the module's own worker, where its code could
  reach them. Under the default sandbox (`audit`) and with none, the
  runtime's `Service` and validator are in the worker's `require.cache`, and
  a module could replace them and return an output its schema refuses
  (`test/sandbox/41`). They could not move to the shared main thread: no
  check made beforehand bounds JSON Schema validation of a module's schema.
  Some patterns take seconds (`^(\w|a)+$`), a 700-byte `anyOf` schema takes
  seconds to compile, and so does `uniqueItems` over 20000 items.
- **`--validatorWorkers <n>`** (default one per spare CPU, 2 to 4) sets the pool's size, each worker
  with resource limits.
- **`--validationTimeoutMs <n>`** (default 1000) is one validation's
  deadline, counted from when it is queued (queue wait plus run). Past it the
  call is refused `VALIDATION_TIMEOUT` (naming the module, the action and the
  side, never a value). A request still queued is dropped, never validated
  nor sent on, and a running one has its validator replaced (at once; only
  workers that keep ending before they are ready back off).
- **Fair between tenants:** one queue per module, served round-robin, and a
  module holds at most all but one READY validator, so another module's
  check takes milliseconds during one module's flood. One caller has one
  validation in flight across the pool, so one key's flood cannot hold it.
- **A slow input is held against its caller, not the module:** it replaces
  its validator and nothing else. A caller whose inputs to a module miss the
  deadline 3 times in 5 minutes has its own calls to that module refused
  `VALIDATION_CALLER_THROTTLED` for a minute; no one else's are, and it
  never takes the last free validator meanwhile. A flood from many keys (a
  distributed one) is for the per-key rate limits, not the pool.
- **`--validationCompileMs <n>`** (default 10000): a module's schemas are
  compiled per action, from one dereference of its document, at load. Past
  the budget the load is refused (`MODULE_ASSEMBLY_FAIL`, stage
  `schemaCompile`). Every new validator compiles every known module, and
  runs each compiled check once, before it takes a call. A call never waits
  past its own deadline: if its action is still compiling it is refused
  `VALIDATION_TIMEOUT` with no strike, and the compile goes on in the
  background.
- **A quarantine:** a module whose own outputs or compiles miss their
  deadline 3 times in 5 minutes is refused `VALIDATION_QUARANTINED`, by
  name, until an operator loads it again. A slow input is not held against
  the module: any caller can send one.
- **`--maxOutputBytes <n>`** (default 16 MiB, at most 256 MiB): a module's
  output, a hop's result to another module included, is measured in its own
  worker before it is posted, and refused `OUTPUT_TOO_LARGE` (naming the
  module and the action) past it.
- **A hop's result crosses the main thread as bytes it never unpacks**
  (lean worker step 2). The callee's worker posts its result as
  `v8.serialize` bytes, transferred, not copied. The main thread refuses
  them `OUTPUT_TOO_LARGE` from their length alone over `--maxOutputBytes`.
  It then has them checked against the callee's output schema in a
  validator worker, and transfers them on to the calling worker, which
  decodes them. A large result between modules no longer stalls the main
  thread for every tenant. Bytes a module forges through its worker are
  refused or checked like any others: a caller only ever decodes bytes a
  validator passed, within the cap. Bytes reach only a request that asked
  for them, and a hop's reply that is not bytes is refused.
- **Every module output is capped by its bytes on the main thread** (the
  review of #165). Every call whose spec the main thread holds answers in
  bytes: a client's, a job's and a hop's, and a failed call's error and
  payload too. The main thread refuses them `OUTPUT_TOO_LARGE` from their
  own length, so a getter, a patched `byteLength`, a huge fault or message
  cannot get a result or an error past the cap. Not yet bounded: a module
  that patches its worker's `MessagePort` can attach extra fields to a
  reply, which the main thread deserialises on receipt, before any length
  check. That is the general module-to-main channel, with no byte bound yet
  (#170). A client's or a
  job's result is unpacked on the main thread once a validator passed it; a
  plain reply where bytes were asked for is refused. A Buffer crosses
  as a Uint8Array, as structured clone gives it, using V8's own serializer.
  A validator's heap follows the cap: four times it plus 64 MB, never under
  256 MB. Final results (an MCP tools/call, an HTTP invoke-action answer, a
  job's result) are unpacked on the main thread as before.
- **Measured** (2 CPUs): 0.17 ms p50 a call for its two checks, 0.53 ms with
  a 100 KB output.
- **A worker's device is registered only if it announces exactly that spec,**
  with schema.json unchanged by hash, and it is listed as the main thread's
  copy. Any other is neither registered nor listed, and the mismatch is
  logged.
- **A service or action named like an `Object.prototype` member**
  (`constructor`, `__proto__`, `toString`...) is the module's own or not
  found, in every mode: an undeclared one is answered `SERVICE_NOT_FOUND` or
  `ACTION_NOT_FOUND`, and a declared one works. A device's services and
  actions were plain objects, so such a name found the prototype's member.
  An undeclared one answered `ACTION_NOT_IMPLEMENTED` or crashed, and a
  declared one's handler was set on `Object.prototype`'s function.
- **Unchanged here:** single-thread mode validates in-process as before. (A
  call over a direct peer channel was still validated in the called worker
  at this point. Lean worker step 4 moved it to the main thread: see its
  entry above.)
- **A courtesy refusal at load** (`MODULE_ASSEMBLY_FAIL`, stage
  `schemaSafety`, naming the module and the schema path, never the pattern),
  run in a validator in worker mode (`lib/schema-safety.js`); a check that
  fails to run refuses the module too. It refuses:
  - a schema.json over 1 MB;
  - a regular expression (`pattern`, a `patternProperties` key, a
    `propertyNames` pattern) over 1000 characters, or with a repetition
    inside a repeated group (`^(a+)+$`) or alternatives that start alike in
    one (`(a|aa)+`);
  - a document over 100,000 nodes with its `$ref`s and `$dynamicRef`s
    expanded (measured without expanding it), a `$ref` cycle, and a `$ref`
    that names no place in schema.json.

  A refused reload leaves the loaded version serving.
- **One answer changes:** a result that cannot cross between threads (a
  function or a Symbol inside a module's output) is answered
  `DEVICE_INVOKE_EXCEPTION` ("the result could not be sent between
  threads"), where the worker's own check used to refuse it first with
  `OUTPUT_DATA_VALIDATION_FAIL`.

### Fixed — on Windows, a module worker never started (#40)

- On Windows every module's start stopped after "file broker: <module>
  spawn walk", with no error, under every `--moduleSandbox` mode, so no
  module was ever listed. Making a module's data directories, the server
  chmod'ed each one `mkdir` had created, walking up from the deepest to
  `mkdir`'s answer and comparing the two as strings. On Windows `mkdir`
  answers in Node's namespaced form (`\\?\C:\...`), so they never met, and
  the walk passed the drive's root and went on forever.
- The walk is gone. `mkdir` already makes every directory at most 0700 (a
  umask can only clear bits), and a module's own `data` and `tmp` are now
  set to 0700 on every start, by their paths, never through a symbolic
  link. A `data` or `tmp` left with other modes is made 0700 at the
  module's next start; the directories above them (`--moduleDataPath`) are
  left as they are.
- On Linux and macOS the walk's two strings always came from the same path
  (the data path is resolved before `mkdir` sees it), so no shipped
  configuration there was affected.

### Added — a remote MCP server per module, called from the main thread (RC1-min)

- A module declares one remote MCP server in `package.json`
  `countinghouse.remotes` (`name`, `transport: "streamable-http"`, an https
  `url`, static `headers`, a `credential` naming an environment variable)
  and calls it with `ctx.call('remote:<name>/<tool>', args)`. The result is
  the server's `CallToolResult` as sent; a tool's `isError` is a result.
  Transport and protocol failures reject with `REMOTE_*` codes.
- The main thread holds the connection and the credential: the module needs
  no `net` permission and never sees the token. A credential is sent only
  where the operator's new `--remoteCredentials <file>` allows that
  variable for the declared URL's exact origin, so a module cannot choose
  where a credential goes.
- `--remoteTimeout` (default 60 s, one deadline for connecting and calling)
  and `--remoteMaxBytes` (default 16 MiB, an answer cut off as it streams).
  A redirect is followed only within the declared URL's origin (at most 5,
  its Authorization kept) and refused to another, and a loopback, private
  or Redis-endpoint address is refused by URL at load and by resolved address before the socket
  opens.
- Each remote call is metered to the outer caller as an inner hop. The
  server's tools/list is recorded at load with a hash in the log; it
  refuses nothing yet.
- `countinghouse-validate` reports declaration problems; a bad declaration
  refuses the load (`REMOTE_DECLARATION_INVALID`).
- Under `--hardened`, the `--remoteCredentials` file is among what the
  server may read (the file alone); before, a server given one under
  `--hardened` exited 2, unable to read it.
- Each remote call is a usage record under the `tools/call` it was made
  for, so the receipt and `countinghouse_usage_report` count it as a
  server call: the remote's name, the tool, the text content's
  bytes (other blocks are passed on, not counted), the time, the outcome
  (`ok`, `isError` or the rejection's code) and the credential's variable
  name. No content and no credential value is recorded. The call id rides
  routed hops; a direct peer channel does not carry it, so when hosting
  (peer channels on) a part's server calls are missing from the outer
  receipt. In the single-identity profile peer channels are off.

### Fixed — under `enforce`, TLS client connections were refused since the sandbox lockdown

- A module under `--moduleSandbox enforce` could make no TLS connection at
  all (`tls.connect`, `https.request`, `fetch` over https): a `TLSSocket`
  hands `net.Socket` the handle Node just made, and the lockdown's
  descriptor backstop read a handle object as adoption. For `net.Socket`,
  adoption is now a descriptor number, as the `fd` option or as Node's
  bare-number form `new net.Socket(fd)`. A handle object is not adoption,
  because a handle a module can build is guarded at its `open(fd)` (below).
  TLS works under `enforce` as under `audit`, `--hardened` included.
- `tls.connect(port, {host})` and `tls.connect(port, host, {host})` were
  read without their options object, so the default Redis denial refused
  them as `localhost`, and `tls.connect` over a given `socket` was read as
  a connection to its `host` and `port`. `tls.connect` has no check of its
  own now: it dials through `Socket#connect`, whose check sees the options
  as tls merged them. A refused connect on a socket the module already has
  connected, over TCP or a pipe, leaves that connection as it was.
  `server.listen` refused an options object with a null prototype or a
  class's as a handle; a handle is now one of the kinds whose `open(fd)` is
  guarded (TCP, Pipe, UDP), and under `audit` it is reported and passed on
  as given.

### Added — usage records, the receipt and `countinghouse_usage_report` (local mode, part C)

- Every `tools/call` on a listed module is counted at the runtime's
  boundary: each call to a declared server (bytes read) and the tool's own
  text result (bytes out). A task-augmented call is counted the same way,
  under its own call id.
- A scenario's successful result carries a receipt:
  `_meta['countinghouse/receipt']` = `{calls, bytesIn, bytesOut, servers}`,
  and a second text block with its sentence. `structuredContent` is the
  module's output exactly as validated.
  `tasks/result` carries the same receipt.
- A scenario's output may not have a top-level `receipt` field
  (`RECEIPT_RESERVED`): there the name is the runtime's. Any other module's
  `receipt` field (a payments receipt, say) passes through untouched, with
  no runtime receipt added.
- `countinghouse_usage_report`, listed to every key, reports the counts by
  tool, server, pack or module: a key sees its own calls, an admin every
  caller by opaque id.
- `--usageDir <dir>` appends the records as daily JSON Lines files (counts,
  names, the credential variable's name and the opaque caller id; never a
  credential value or content), and `countinghouse-usage --usageDir <dir>`
  prints the report in the operator's shell (`--since`, `--groupBy`,
  `--json`, `--csv`). Under `--store local` it defaults to
  `<storePath>/usage`, so every launcher sharing a store writes to one
  directory; under `--store redis` it is explicit-only, and unset nothing is
  written.

### Added — scenarios and parts (local mode, part C)

- `package.json` `countinghouse.role` is `"scenario"` or `"part"`; a module
  with no role is listed as before.
- `--loadModule <scenario>` also loads the parts its `countinghouse.calls`
  names, found from the scenario's directory under their bare names or any
  npm scope; parts that call parts load the same way, each once, at startup.
- A part a scenario loaded is not listed: a `tools/call` or `invoke-action`
  from outside answers `MODULE_NOT_LISTED`, and its scenario's `ctx.call`
  reaches it as before. A scenario's actions are listed under their bare
  names (`ci_failure_triage`).
- A scenario is not loaded when a part is missing (`PART_MISSING`) or a bare
  name is already a listed tool's, a built-in's or an earlier scenario's
  (`TOOL_NAME_TAKEN`); the log says which.

### Added — `--stdio`: MCP over stdin and stdout (local mode, part C)

- `--stdio` serves MCP as newline-delimited JSON-RPC on stdin and stdout,
  with the log on stderr and no port (`--port` with it exits 2). A desktop
  MCP client starts it through `countinghouse-stdio`
  (`bin/countinghouse-stdio.js`), a pure JavaScript entry. When stdin
  closes, the calls in flight drain (up to `--requestTimeout`) and the
  process exits 0, or 1 if the drain ran out. A notification is never
  answered.
- CI runs the stdio tests on Linux, macOS and Windows, with no Redis.
  Windows does not gate a merge yet: the runtime does not bring a module
  online there (issue #40).

### Security — descriptor adoption closed on routes the lockdown missed

- On Node 24.0, `http.Agent.prototype.createConnection` is
  `net.createConnection` itself, taken when `http` loads (22 and 24.14
  give the agent a function of its own that looks `net` up at each call).
  The lockdown wraps `net.connect` and `net.createConnection`, so on 24.0
  an `http` request given an `fd` reached the unwrapped function and was
  not refused at its entry, under `--hardened` included; only the
  `open(fd)` backstop stood. Where the agent holds that original, it is
  replaced by the guarded one as well. Found by the new Node floor CI legs.
- `net.connect({fd})` and `net.createConnection({fd})`, and through them
  an `http` request given an `fd`, adopted the descriptor in every mode.
  They build Node's internal `Socket`, which the `net.Socket` guard never
  saw. Without `--hardened` the native `open(fd)` backstop still
  caught them. Under `--hardened` nothing did, so a module could take the
  main server's listening socket. They are now checked at their entry.
- `tty.ReadStream` and `tty.WriteStream` took a descriptor in every mode
  through their `prototype.constructor`, which was the real constructor
  behind the guard (the guard is a Proxy, whose prototype is its
  target's). tty builds its handle from the descriptor with no `open(fd)`,
  so no backstop saw it, and a module could write to a connection another
  owner held in the process, the main thread's Redis connection included.
  `prototype.constructor` of each is now the guard, and so is
  `net.Socket`'s, and so is the constructor `tls.TLSSocket` and `tty`'s
  streams extend (`Object.getPrototypeOf(tty.WriteStream)`). A real
  `net.Socket` reached another way (Node's internal `JSStreamSocket`
  extends it too) builds only a TCP or Pipe handle from a descriptor, and
  that handle's `open(fd)` is guarded (below).
- Under `--hardened`, `open(fd)` on a TCP, Pipe or UDP handle a module built
  from an instance's constructor was not guarded before this release, since
  the backstop's prototypes came from `process.binding`, which the
  permission model refuses. The lockdown now takes them from instances it
  builds and destroys before module code runs. If it cannot take one, a
  module does not start under `enforce`, and `audit` logs it.
- Each guarded entry point copies its options once, by their own
  enumerable properties as Node's `Socket` constructor reads them, and
  checks the copy, so a getter cannot answer the check `undefined` and Node
  a descriptor number. An inherited or non-enumerable option is dropped. An
  array other than Node's own normalised `[options, cb]` is read as Node
  reads it, by its own properties, so an array with an `fd` property is
  adoption as well.
- The Redis denial now covers every loopback literal (all of 127/8,
  `0.0.0.0`, `::1` and `::`, in the forms the resolver accepts, such as
  `127.1`, and IPv4-mapped or -compatible) and the loopback names
  (Debian's and RHEL and Fedora's: `localhost4`, `localhost6`,
  `localhost4.localdomain4`, `localhost6.localdomain6`), not six
  spellings, as well as an empty host (Node connects to `localhost`),
  every spelling of a configured address (`10.5` for `10.0.0.5`, and its
  IPv4-mapped and IPv4-compatible forms), every spelling of a socket path
  (`..`, `//`, relative), and a port in any string form Node reads as a
  number (`socket.connect('0x18eb', host)` took it for a pipe path).
- `_tls_wrap` and `_tls_common` are refused to modules. They were on the
  allowlist, though a module needs `tls`, not Node's TLS internals behind
  it. A module (or a dependency) that requires them directly now fails to
  load. Use `tls`. So is `_stream_wrap` (deprecated, DEP0125): its
  `JSStreamSocket` extends the real `net.Socket`, so
  `Object.getPrototypeOf(require('_stream_wrap'))` was a constructor past
  the guard. Use `stream.Duplex`. (Node 26 has removed `_stream_wrap`;
  there `require` answers `MODULE_NOT_FOUND`.)

### Added — `ctx.error`: a handler's own error, which it may simply return

- `ctx.error(code, message?, details?)` returns the module's own error
  (it never throws). A handler hands it back by returning it, from a plain
  function or an async one (`return ctx.error('REPO_TOO_LARGE', 'over 2 GB')`),
  or by throwing it, or with `callback(err)`: the same answer, carrying the
  module's code. It answers `REPO_TOO_LARGE: over 2 GB` (the code, then the
  message). Only such an error counts: a returned plain object that looks
  like one is a result.
- `details.cause` is reserved for the underlying error
  (`ctx.error('INNER_CALL_FAILED', `${label}: ${e.message}`, {cause: e})`):
  it is kept on the error and off every serialised form, so it never reaches
  the caller.
- A helper with no `ctx` may throw a plain `Error` carrying the module's
  code instead. Its `.code` counts as the module's when it looks like one
  (`/^[A-Z][A-Z0-9_]{2,}$/`) and is not a system error's (`errno`/`syscall`)
  or someone else's: Node's own (`ERR_…`, `MODULE_NOT_FOUND`, `ABORT_ERR`),
  any errno name (`ECONNRESET` from a dropped socket has no `errno`),
  undici's `UND_ERR_…`, the HTTP parser's `HPE_…`, or one of the 28
  certificate-verification codes Node gives a TLS error (`CERT_HAS_EXPIRED`,
  `INVALID_CA`, …; an exact list, `CountinghouseError.X509_VERIFY_CODES`).
  Anything else is untyped, as before: a crash, `DEVICE_INVOKE_EXCEPTION`.

### Changed — breaking: a module's errors are its own, and no `topic`

- **`DeviceError` and `CHError` are gone**, classes and module-facing
  globals alike: a module that names them fails at call time. Use
  `ctx.error` ([upgrading-to-8.md](docs/upgrading-to-8.md)). A module raises
  only its own codes: the bundled modules and examples now answer
  `INPUT_REJECTED` where they raised `ARGUMENTS_INVALID`, and
  `INNER_CALL_FAILED` (the original as the cause) where they raised
  `DEVICE_ACTION_CALL_FAIL`.
- **Only the runtime issues runtime errors.** An error a module answers
  with is the module's (`origin: 'module'`, no runtime kind, retry or
  status), however it was built, even when its code spells a catalogue
  name; only an error the runtime itself issued to the module (a hop's
  `MODULE_RELOADING`, a `CTX_CALL_…` or `ctx.serviceClient` refusal),
  passed on, stays the runtime's, with the code it was issued with. Any
  sandbox mode freezes the error class in the worker and removes the
  runtime's issuing function from what a module can reach; only `enforce`
  also blocks a require of countinghouse's own files (`audit` records it),
  and single-thread mode has no sandbox.
- **No `topic` in any answer.** An HTTP error body is
  `{code, message, fault?}`; `kind` and `origin` join it with the client
  shapes (logger-design spec §5.2, "Client shapes").
- **Worker mode answers a module's error as single-thread mode does**: the
  worker reply carries its code, message and details, where it used to keep
  only the code (`SHAPE_REJECTED` instead of `SHAPE_REJECTED: shape probe`).
  So do the composition hops (the main thread's reply to a composing worker,
  and a direct peer channel's): a callee module's error reaches the composing
  module's `ctx.call` as it would in single-thread mode, so a callee's code
  that is also a catalogue name stays the callee's rather than turning into
  a runtime error, and one of its own codes arrives with its message and
  details too. So a composite that lets a callee's own error escape answers
  its caller with that code (it used to be `DEVICE_INVOKE_EXCEPTION`, the
  7.x hop rule); the code is the module's, not the runtime's, in every
  mode. A runtime error is still rebuilt from its code alone. Details
  that don't survive JSON (a BigInt, a cycle) arrive as
  `{_details: 'unserialisable'}`, with a warn line, instead of vanishing.
- Only an `Error` is typed by its code: a thrown plain object with a code,
  `throw null`, or `Promise.reject()` is a crash (`DEVICE_INVOKE_EXCEPTION`),
  answered at once with the catalogue's text alone (so is a thrown value
  whose properties throw when read, and an `Error` with no message or a
  blank one; no runtime message ends in a dangling `: ` any more). A
  message that cannot be rendered (circular, or with a throwing `toJSON`)
  reads `[unrenderable value]` instead of leaving the call unanswered, a
  function reads `[function]` (never its source, `ctx.error`'s message
  included, where an object message now reads as JSON, not
  `[object Object]`), and a fault keeps every field it can read, each as
  text. The two before used to
  leave the call unanswered until the device timeout. A callback handler's
  `callback({code: …})` with a plain object is untyped too
  (`DEVICE_INVOKE_FAIL`; it used to keep its code).
- A module's details are a plain object; anything else (an array, a Map, a
  class instance) is `{}`, in every mode. A composing module's `ctx.call`
  gets a copy of a callee's error (never its `cause` or its object), in
  single-thread mode as over a thread reply; its `origin` tells a runtime
  code from a callee's own code of the same name.
- A composition hop to a device never hosted here rejects with
  `DEVICE_NOT_FOUND` on the main-thread path too (it had no code), with the
  same text as over a direct peer channel (no device ID), still only after
  the access check.
- A synchronous throw from a plain (non-async) handler is classified like a
  rejection: `throw ctx.error(…)` keeps its code (it used to be
  `DEVICE_INVOKE_EXCEPTION` whatever was thrown); an untyped throw is still
  `DEVICE_INVOKE_EXCEPTION`.
- Until the worker-side refusals raise the runtime's own error class
  (ledgered as L2), a sandbox refusal a handler lets escape
  (`MODULE_SANDBOX_REFUSED`, `RATE_LIMITED`) reads as a module-kind error
  with the refusal's code: more informative than the
  `DEVICE_INVOKE_EXCEPTION` it was, and harmless.
- Known until the client shapes: a module error's task `statusMessage`
  reads `CODE: CODE: message` (the job worker prefixes the code to a message
  that already starts with it).

### Changed — one error class inside the runtime

- Every error the runtime constructs is a `CountinghouseError`
  (`lib/countinghouse-error.js`); `lib/error-info.*.json` are replaced by
  `lib/error-catalogue.js`, with a name, a real stack, and kind, retryable,
  httpStatus and mcpCode from the catalogue. The error-shape golden
  (`test/mcp-contract/07`) records every answer, and changes only on
  purpose, with the changed answers listed.

### Removed — 23 error codes nothing raised

- The error catalogue (`lib/error-catalogue.js`, which replaces
  `lib/error-info.*.json`) does not carry over codes the runtime never
  raised: `LOAD_MODULE_FILE_FAIL`, `INVALID_ACCESS_TOKEN`,
  `CANNOT_VERIFY_ACCESS_TOKEN`, `DEVICE_ID_GENERATION_FAIL`,
  `INVALID_DEVICE_ID`, `MODULE_IN_DISCOVERING`,
  `CANNOT_GENERATE_ACCESS_TOKEN`, `MODULE_INFO_CONTAINS_PUBLISHCONFIG`,
  `MODULE_PATH_CHMOD_FAIL`, `USERNAME_INVALID`, `PASSWORD_INVALID`,
  `MISSING_INPUT_ARGUMENT`, `DATA_VALIDATION_FAIL`,
  `NOT_ENOUGH_USER_BALANCE`, `SYSTEM_ERROR_NETWORK_ERROR`,
  `SYSTEM_ERROR_DATA_PARSE_ERROR`, `SYSTEM_ERROR_SMSTMPLDB_NA`,
  `SYSTEM_ERROR_USER_UNAUTHORIZED`, `INVALID_BALANCE_FORMAT`,
  `NO_PRICE_RECORD`, `USER_DEVICE_RECORD_FORMAT_INVALID`, `API_ERROR`,
  `DATA_ERROR`. A module that raised one of them gets the code as its
  message instead of the old text; a module's codes are its own (see the
  logger-and-errors spec).

### Fixed — an unknown `--locale` falls back to en-US

- Error messages for a `--locale` with no catalogue text are in en-US, the
  default; they used to fall back to zh-CN.

### Docs — deployment posture

- [`docs/deployment.md`](docs/deployment.md): the module sandbox isolates
  modules from each other and from tenants' data inside one process; it does
  not isolate countinghouse from the host. It gives the posture (an
  unprivileged user, a container with memory and CPU limits, the default
  seccomp profile, Redis reachable from countinghouse only, the auth config
  as a secret, an ingress in front), a reference Docker Compose and
  Kubernetes outline, and what the in-process sandbox does not give.
  Linked from security-model.md, the README and docs/index.md.
- `docs/superpowers/notes/2026-11-10-multi-language-modules-brainstorm.md`:
  notes on modules in other languages, containers and Kubernetes. Notes, not
  a spec: nothing in them is decided.

### Removed — the device fields `rateLimit` and `price` (breaking)

- `api.json`'s device-level `rateLimit` and `price` are CDIF-era and
  retired. `price` was read by nothing; `rateLimit` was read only by a
  per-device limiter on Redis db 9, which is removed with it, so **a
  device's `rateLimit` is no longer enforced**. Use `--apiKeyRateLimit` and
  `--globalRateLimit`; jobs are bounded by the add-job limits. Both fields
  are gone from `spec/schema.json`; a spec that still carries one loads and
  validates (`device` isn't closed), and `countinghouse-validate` warns about
  each. `bin/countinghouse-migrate-spec.js` removes them, while converting an
  old spec and from one already in the 5.0.0 format.

### Added — Node 26 in CI

- CI now tests the newest 26.x as well as 24.15.0 and the newest 24.x (and,
  since the floor moved to 22.16, 22.16.0 and a sandbox-floor job on 22,
  24.0.0 and 24.14; see "8.0.0 platform" below). A new
  push to a pull request cancels that PR's superseded CI run; runs on master
  are never cancelled.
- **Security, Node 26 only:** Node 26 adds `fs.openAsBlobSync`, which the
  worker's file patch did not cover, so on Node 26 module code could read a
  host path through it under every `--moduleSandbox` mode, a gap that
  existed before this release. It is now brokered like `fs.openAsBlob`, and
  installed only where Node has it.
- `--hardened` on Node 26: Node 26's permission model adds a network
  permission, and without it the relaunched server could neither listen nor
  reach Redis. `--hardened` now passes `--allow-net` where Node has the flag
  (Node prints an ExperimentalWarning for it), so the network stays
  unrestricted under `--hardened`, as on Node 24, until the network broker.
- Node 26's new built-in `node:ffi` (native calls from JavaScript) is
  refused to module code. It already was before anyone read it: the
  built-in allowlist is written out, so a built-in a later Node adds is
  refused by default, which is the design working as intended. It is now
  listed explicitly among the refused built-ins. Under `--hardened`, Node's
  permission model refuses FFI as well (`--allow-ffi` is never passed;
  `--allow-addons` does not cover it).
- npm 11.20 (bundled with Node 26) warns that `sqlite3`'s install script is
  not yet covered by `allowScripts`; see
  [`docs/authentication.md`](docs/authentication.md) for what to do if a
  fresh install leaves the SQLite provider without its binding.

### Changed — what a module is always denied (R2-1, part 2)

- Under `--moduleSandbox audit` and `enforce` a module cannot read the
  **auth configuration** (`--authConfigPath`: the JSON file, or the sqlite
  database with its `-wal`, `-shm` and `-journal` side files) or the
  **identity secret** (`<moduleDataPath>/.identity-secret`), however it
  names them -- directly, through a symlink or `..`, or through a hard link
  in a declared directory: `EACCES`, and a `file denied` line in the log.
  Audit used to pass such reads through. `off` decides nothing, as before.
- **`COUNTINGHOUSE_*`** never reaches a worker's environment, declared or
  not; the load logs the denial and `countinghouse-validate` warns about
  the declaration.
- A worker's options carry **no `redisUrl` and no `dbUrl`** (a password in
  either would have reached every module), and a module's own connection to
  the **Redis endpoint** (`net.connect`, `tls.connect`, a raw `Socket`,
  `http.request` over its socket path) is refused with `EACCES` in audit and
  enforce -- an in-worker check until the network broker ships.

### Added — an opaque per-user id, its secret, and the operator's lookup (R2-1, part 1)

- Every user has an **opaque id**, `u_` and 22 characters, the same across
  every module on this server: an HMAC of the auth entry's optional stable
  `id` field, else of its API key, under a server secret. It is what modules
  will see as `ctx.caller.id` (later parts of R2-1); today it names the
  tenant in log lines (in place of `key sha256:…`) and scopes repeatable job
  schedulers (`<id>:<name>`; schedulers stored under the old prefix are
  still found and removed by their owner).
- **The stable `id` field** (file provider: `"id"` on the entry; sqlite:
  `countinghouse-auth-sqlite.js set-id <apiKey> <id>`, a new nullable
  column added on open; CouchDB: an `id` field on the user document, read
  as the view's 5th value once `init-db` is re-run): 1 to 128 printable
  characters, unique. With it, rotating a user's key keeps their id, and so
  their per-user module data and schedulers; without it, the id changes
  with the key. Two file entries sharing an id refuse startup (exit 2,
  "entries 2 and 5 share id", never a key) and refuse a reload.
- **The secret**: 32 random bytes, kept as 64 hex characters in
  `<moduleDataPath>/.identity-secret` (0600, written atomically, never read
  through a link, refused if group- or world-readable), or supplied as
  `COUNTINGHOUSE_IDENTITY_SECRET` in the same form. Generated on first start
  only when neither exists; a variable in another form, or a file and a
  variable that differ, refuse startup with exit 2 and never echo a value.
  Changing the secret changes every id.
- **The operator's lookup**: `POST /identity-lookup {id}` and the authoring
  tool `countinghouse_lookup_identity`, admin only, answer
  `{id, userName, isAdmin}` for an id this server issued and
  `IDENTITY_NOT_FOUND` otherwise, never the key. The index behind them is
  built before the server listens and rebuilt on every `POST /reload-auth`.
- **An unusable `--moduleDataPath` now refuses startup** (exit 2, naming the
  path and what to do): the secret lives there, so a server without a
  usable data directory has no identity. It used to fail each module load
  instead.

### Fixed — with Redis down, calls answer, and billing resumes when it is back

- node_redis queued commands while disconnected, so with Redis down a
  call under `--apiKeyRateLimit` (or to a device with a `rateLimit`) hung
  until Redis returned instead of failing open, and a charge issued in the
  outage landed on whatever balance Redis held when it came back. After an
  hour of failed reconnects the client also stopped for good, and metering
  never resumed. The metering and rate-limit clients now wait only for
  their first connect (at most 2 s; a server started with Redis down still
  answers), then fail a command at once while disconnected, reconnect with
  at most 1 s between attempts for as long as it takes, and each rate-limit
  check has a 500 ms deadline. During an outage a billed call is refused
  before it runs (`LEDGER_UNREACHABLE`, retryable), and a call that costs
  nothing is served.

### Fixed — `--hardened` refuses `--modulePath X` beside `--moduleDataPath X_data` clearly

- With a module folder whose name the data directory extends, the
  relaunched server died at start with "cannot access module folder:
  Access to this API has been restricted", naming nothing: Node's
  permission model refuses creating and checking a granted directory that
  another grant's name extends (nodejs/node#66812), on every 24.x. The
  start-up check now makes those calls too, so such a layout exits with
  status 2 before relaunching, naming both paths and saying to rename one,
  as the `--hardened` reference already promised. The module folder is now
  created before that check, as the server would create it anyway.

### Fixed — `--mcpToolCallCost` takes only a finite number >= 0

- The flag was read with `parseFloat` and never checked: a negative cost
  credited every caller on every call, `NaN` or `Infinity` made each charge
  fail and the call was served free, and `1abc` became `1`. Anything but a
  finite number `>= 0` (including no value) now exits with status 2 before
  the server starts, naming the flag.

### Security — module workers hold no metering provider

- Every module worker built its own metering provider on Redis db 0, the
  balance ledger, and module code reaches its worker's countinghouse
  objects (`CHUtil.ci`): a module could call
  `CHUtil.ci.recordCall(anyKey, tool, -100)` to credit a key, or a
  positive cost to debit anyone. Metering already runs on the main thread
  only, so workers now build none; `recordCall` and `checkBalance` from
  module code answer `SYSTEM_ERROR` and the ledger is untouched. This
  closes countinghouse's own handle on the ledger, not the network: until
  sandbox parts 3 and 4 a module can still open connections of its own.

### Security — sandbox decisions use the kernel's real path

- Node's JS `fs.realpathSync` resolves a link pair such as `x -> "."`,
  `y -> "x/.."` to `x`'s directory; the kernel, and the native form, to
  its parent. The module tree check, the module root, the `--hardened`
  real paths and code roots, and a module worker's `fs.realpathSync` under
  the loader's grant all used the JS form, so they could decide on a place
  other than the one the kernel opens. They now use the native form. A
  module whose code tree holds such a link is refused under `enforce`
  (`MODULE_SANDBOX_REFUSED`, naming the link) and logged under `audit`,
  which now also reports a `require` through it. Before, the module
  loaded, and a `require` through the link failed (the loader looked
  inside the module); it did not load the file outside.
- `--hardened`'s start-up grant probe checks the native form, the one
  countinghouse calls; on Node 24 it is refused for a granted directory
  whose name another grant extends (nodejs/node#66812) on 24.21 as well.

### Security — an open whose folder appeared mid-check is verified

- Under `enforce`, the broker skipped its check after an open when the
  file's parent directory was missing at the moment it checked the path:
  that open had nothing to compare against. A host process creating the
  parent in between, as a link to elsewhere, could steer the open outside
  the module's namespace or a write-open into a read-only root. The
  broker now checks where such a descriptor really landed (the parent's
  real path now, in the root the path names; the name there is the
  opened file) and closes it with `ENOENT` otherwise.

### Security — a module's symlink is decided by where it really leads

- `symlink()` in `/data`, `/tmp` or a declared `rw` path checked the
  target's text only, so `x -> "."` followed by `y -> "x/.."` was accepted
  and `y` led to the directory above the root for anyone following it (a
  host tool, the runtime, another module sharing the path); the module's own
  later use was already refused. The target is now walked on the host from
  the real path of the link's directory, following links on the way, and
  must land in the link's root. It may also hold no `..` segment: a `..`
  that stays inside today can lead out once the module renames a directory
  above it. Breaking for a module that makes links such as `../f`: they
  answer `EPERM` in every `--moduleSandbox` mode.

### Security — what one add-job may ask for is bounded

- A job's runs are not rate limited, only creating it is, so one
  rate-limited `add-job` with `repeat.every: 1` and no limit, or with
  `attempts: 1e9`, was unbounded work billed to its owner. Now
  `repeat.every` must be a whole number of at least 1000 ms (a cron
  pattern's finest step is already a second), `attempts` a whole number
  from 1 to 10, and `repeat.limit`, when given, a whole number of at least
  1; anything else is refused with `ADD_JOB_ERROR` and no job is created.
  Breaking for a caller that repeats more often than once a second or asks
  for more than 10 attempts. The cross-cutting matrix no longer implies
  that a job's runs share the per-key rate limit.

### Security — a job is authorized when it runs

- A job was authorized only when it was added. A queued, delayed, retried
  or scheduled job kept running, and billing its owner's key, after the
  key lost the grant for that device or action or was removed from the
  auth config, and its owner could no longer even cancel it. Now the
  owner's key is checked again before every run, as a synchronous call
  is. A refused run fails for good (not retried, not billed), with
  `USER_HAS_NO_DEVICE` or `SYSTEM_ERROR_UNKNOWN_USER` and never the key in
  the failure, and a refused scheduler is removed. An unreachable auth
  backend (`SYSTEM_ERROR_USERDB_NA`) is retried like any other failure. A
  revocation reaches jobs as it reaches calls: at once for sqlite, after
  `POST /reload-auth` for the file and CouchDB providers.
- The check has a deadline of 10 s: an auth backend that accepts the
  lookup and never answers fails the run `SYSTEM_ERROR_USERDB_NA`, which is
  retried, instead of holding it with no bound.

### Docs — what log-triage costs in model tokens

- [`docs/benchmarks/token-cost.md`](docs/benchmarks/token-cost.md): the same
  triage task through `claude -p`, four ways (the model chaining the leaf
  tools, one composite call, and code mode with and without output types),
  46 runs at `622438f`. Scripts in `perf/token-cost-compare.js` and
  `perf/gen-code-mode-wrappers.js`, results in
  `perf/results/2026-11-05/token/`.

### Fixed — work in flight when a module's worker ends

- **Calls and jobs a worker still owed an answer fail at once, with why.**
  Before, only a crash the supervisor restarts did this. A reload, an
  unload, a failed reload, or any crash under `--moduleSandbox off` left
  synchronous calls waiting for the 30 s `--requestTimeout`
  (`DEVICE_NOT_RESPONDING`) and running jobs active forever. Now every
  worker end answers them: `MODULE_RELOADING` when a new worker replaces
  it, `MODULE_UNLOADED` for an unload or a crash with no supervisor (the
  module stays down), `MODULE_RESTARTING` for a supervised crash, as
  before. A reply the worker posted before it handled the unload is still
  the real answer.
- **A device a worker announces once its unload has begun is not
  registered**, nor one from a worker that has ended or been replaced. It
  used to undo what the unload recorded, so the device then answered
  `DEVICE_NOT_FOUND` instead of `MODULE_UNLOADED`.
- **A direct peer channel is granted only to a callee that is still there.**
  The broker checks the caller's access asynchronously, and a callee that
  ended or began unloading meanwhile still got the channel. A port sent to
  a worker that has already exited never closes, so the caller kept a dead
  channel and every call over it waited out the peer timeout. Now such a
  callee is answered as a missing device (`MODULE_RELOADING`,
  `MODULE_UNLOADED`, ...), one replaced by a reload is granted on its new
  worker, and a caller that ended meanwhile is sent nothing.
- **A request for a module that is gone says why.** After an unload, a
  failed reload, or a crash with no supervisor, a request for one of its
  devices is `MODULE_UNLOADED`; during a reload, until its devices are
  back, `MODULE_RELOADING`, and during a supervisor restart
  `MODULE_RESTARTING` until they are back (not only until the restarted
  worker is running). `DEVICE_NOT_FOUND` is left for a device never
  hosted. The reason is given only after the caller's access check (HTTP,
  composition hops, a job's owner); a caller without access gets
  `USER_HAS_NO_DEVICE` whatever the reason. This also closes an older gap
  where a composition hop answered a missing device before checking
  access. An MCP `tools/call` for an unloaded module's tool is still an
  unknown tool: it is not listed.
- **A reload refused for an invalid version string ends the module's
  worker** under `--workerThread`, as an unload does. Before, the worker
  kept running, unreachable, its devices answered `DEVICE_NOT_FOUND`, and
  uninstall was refused `MODULE_LOADED`.
- **A queued or scheduled job waits through its module's reload** or a
  supervisor restart, up to 30 s, and runs on the new worker. If the
  module ends up unloaded or suspended, the job fails with that code and
  is not retried; if the wait runs out, it fails `MODULE_RELOADING` or
  `MODULE_RESTARTING`, which bullmq retries when `attempts > 1`. A
  synchronous call in the same gap still fails at once. A waiting job
  holds one of the job worker's 1024 concurrency slots.
- **A job's answer after its timeout is dropped.** Once a job's timeout
  (its own, or `--jobTimeout`) has failed it, an answer that still arrives
  from the worker is not billed, the completion hook does not stamp the
  job, and nothing is written over a retry's data; before, such an answer
  was billed and stamped as a completion. A retry running while the first
  attempt's handler is still going owns the job in the worker on its own:
  its progress reports are accepted after that handler returns (they were
  refused, the first return having erased the job's in-flight entry).
- **Jobs failed `MODULE_UNLOADED` or `MODULE_SUSPENDED` are not retried**,
  whatever their `attempts`: the module is gone until an operator acts.
- **A supervised module whose restarted worker crashes before its devices
  are back keeps them**: its tools stay listed while it restarts and once
  it is suspended, and after the third exit its devices answer
  `MODULE_SUSPENDED` (they answered `MODULE_RESTARTING`, with the tools
  gone).
- **A reloaded worker whose discovery does not finish within 15 s is
  unloaded** (logged as an error naming the module), in every sandbox
  mode: its devices are `MODULE_UNLOADED`, the supervisor does not restart
  it, and the worker is terminated. Before, with the sandbox off, a module
  that blocked its worker in discovery left it spinning for good.
- **A reload that reaches a worker still blocked in discovery stays a
  reload**: the old worker's 15 s bound no longer fires during the
  reload's 3 s unload window, where it turned the reload's devices
  `MODULE_UNLOADED` (and failed the jobs waiting for them for good).
- **Operator actions on one module take effect in order, the latest
  winning.** A load, reload or restart that arrives while an earlier
  reload's worker is still coming up supersedes it: that worker ends and
  the earlier caller gets `MODULE_LOAD_SUPERSEDED` (new code). An unload
  arriving then cancels the reload and leaves the module unloaded; it used
  to be refused ("unknown module") and then undone when the reload's
  worker came up. The devices stay `MODULE_RELOADING` until the new worker
  is up, so a job that comes due meanwhile waits and runs; before, the
  second reload's start terminated the first one's loading worker, which
  settled the devices to `MODULE_UNLOADED` and failed the waiting jobs for
  good.
- `countinghouse_validate_module` answers only after its throwaway worker
  and directory are gone, so a validation sent the moment another answers
  is no longer refused as busy.
- Single-thread mode is unaffected (no workers, no job processor); an
  unload there still answers `DEVICE_NOT_FOUND`.

### Changed — a composite sees an inner tool's error code only if it is a runtime code

- Superseded within this release by "a module's errors are its own" above:
  a callee module's own code now reaches the composite, and its caller, as
  the module's; a runtime code is still rebuilt from its code alone. This
  entry is kept as the step between.
- On a composition hop (`ctx.call`, `ctx.serviceClient`), an inner
  failure keeps its code up to the composite's caller only if the code is
  one of the runtime's own (`lib/error-info.en-US.json`); any other code is
  reported as a callee failure, `DEVICE_INVOKE_EXCEPTION`. Before, it
  depended on the path: over a direct peer channel (the default) any code
  passed, so an inner module could pass off an invented code as a runtime
  condition; without peer channels every code was flattened. A callee can
  still raise any runtime code, as it could as a tool of its own.

### Added — reload the auth configuration without a restart

- `POST /reload-auth` (admin key) and the authoring tool
  `countinghouse_reload_auth` re-read the auth configuration: the file
  provider re-reads and checks its file, swapping it in only if it passes
  (otherwise `AUTH_RELOAD_INVALID`, naming the entry by position, and the
  configuration in use stays); CouchDB empties its cache; sqlite already
  reads live. The answer is `{ok, entries, changed}`, never keys. A changed
  `runsModules` binding applies to modules loaded or reloaded afterwards.

### Added — `--jobTimeout`

- `--jobTimeout <seconds>` (default `3600`, `0` for none) bounds a job that
  sets no timeout of its own, so a handler that never answers cannot hold
  a job worker slot forever. A job's own `opts.timeout` wins. Either is
  capped at about 24 days (setTimeout's maximum); a larger value used to
  fail the job at once. It is applied
  when the job runs, so it also bounds jobs queued before the upgrade and
  jobs a scheduler makes from a template stored earlier. Like the other
  numeric flags, a value that is not a number of seconds falls back to the
  default.

### Security — no API key in a log line

- Two server log lines printed a tenant's raw API key: a peer channel
  closed because a grant was revoked, and every module call to
  `ctx.recordUsage`. Both now name the tenant by a short fingerprint
  (`key sha256:<first 8 hex>`), enough to tell tenants apart in a log, not
  to recover the key.

### Fixed — the repo-review example reads only the directory it is given

- **repo-scan's default root comes from the operator's device config**
  (`defaultRoot` in `<--deviceConfigPath>/repo-scan.json`). It used to climb
  five levels up from its handler's `__dirname`, which since sandbox part 2
  is virtual (`/app/handlers/scanService`), so the climb landed on `/`: a
  `repo_review` call with no `path` walked the host's filesystem (allowed
  and logged under `audit`) until the request timed out, which is why
  `examples/repo-review/verify-identity-passthrough.js` failed with "Device
  is not responding".
- **With no `path` and no configured default, the call is refused** with
  `ARGUMENTS_INVALID`, and a filesystem root is refused as `path` or as the
  default. The root check is a tripwire; confining reads is `enforce` with
  a declared fs permission.
- `npm run demo:repo-review` writes that config for the checkout (in
  `examples/repo-review/config/`, git-ignored) and passes
  `--deviceConfigPath`, so the demo still runs with no arguments. The verify
  script and `token-comparison.js` pass `path` explicitly.

### Security — review round R1

- **Request bodies are bounded.** JSON and XML bodies are limited to
  `--maxRequestBody` MB (default 8) on every route. They were 1 GB, read
  before any key was checked, so a few concurrent large posts from an
  unauthenticated client could exhaust the server's memory. An oversized
  body is answered 413. (BSON bodies, which this round first bounded and
  read only for a caller who may use the device, are no longer taken at
  all: see "Removed — BSON request bodies" above.)
- **The server binds `127.0.0.1` by default.** Without `--bindAddr` it used
  to bind the first non-internal IPv4 address. Give `--bindAddr` (for
  example `0.0.0.0`) for remote clients.
- **`--debug` without `--debugKey` starts only on a loopback address**
  (exit 2 otherwise): it accepts every request as an admin, `load_module`
  included.
- **A bare `--debugKey` (no value) refuses to start** (exit 2). It used to
  start with a key no request could match.
- **`text/plain` bodies are no longer parsed as JSON:** a cross-site
  `text/plain` POST needs no CORS preflight, so a web page could drive a
  `--debug` server. Send `application/json`.
- **Form bodies are no longer parsed** (nothing read them), for the same
  reason: a cross-site form post could feed `/load-module` its path.
- **API keys that name `Object.prototype` members no longer authenticate.**
  The file provider looked keys up in a plain object, so `constructor`,
  `__proto__`, `toString` and the like authenticated as a tenant with no
  devices; the CouchDB provider's cache had the same flaw. The environment
  key and `--debugKey` are compared in constant time.
- **The main thread checks a worker's Redis command name.** Module code can
  post a `rediscommand` message itself, and the main thread called whatever
  op it named on the shared client, so an op such as `constructor` or
  `__proto__` could replace or poison that client for every module. Ops
  outside Redis's command list are now refused.
- **`countinghouse_validate_module` runs the module sandboxed.** It requires
  the module's code to resolve the handler map, and ran it in a child
  process with the server's whole environment (API keys included) and no
  sandbox, even under `enforce` and `--hardened`. Under `audit` and
  `enforce` it now runs in a module worker set up as a load of that module
  would be, given no main-thread services and discarded afterwards, at
  most two at a time; under `off` and single-thread mode, in a child with a
  clean environment. The result describes the module; it is not a check a
  hostile module cannot fool.
- **A direct peer channel serves only the devices granted on it.** The
  broker checks one (key, device) per grant, but the callee served any
  device its worker hosts, and module code can post on its own end of a
  channel. Now the callee keeps the set the broker granted (a later grant
  reaches it before the caller is told), and refuses any other device with
  `PEER_NOT_GRANTED`.
- **A module reaches only the jobs it is running.** `CHUtil.jobInfo` and
  `CHUtil.jobProgress` took any job id, and the main thread answered with
  full internal access, so a module could read every tenant's jobs, their
  API keys included, and change their progress. A worker now reads and
  updates only the jobs it is executing, and the job it gets back carries
  neither the creator's API key nor the queue's options.
- **Repeatable job schedulers are per owner.** A scheduler's id was the
  caller's raw `opts.name` in one shared queue, and bullmq replaces a
  scheduler on upsert, so another tenant posting the same name took over
  the first tenant's scheduler (its later runs owned and billed to the
  second). Ids are now scoped to a hash of the owner's key, and an owner
  removes its own scheduler (removing one used to require an admin key).
  Schedulers created before 8.0.0 keep their bare-name ids and keep
  running; an admin removes them by name.
- **Browser origins are checked.** Every route refuses (403) a request whose
  `Origin` is not in `--allowedOrigins` (none by default), as MCP's
  Streamable HTTP transport requires for `/mcp`; and under `--debug` without
  `--debugKey`, a request whose `Host` is not this loopback server is
  refused, which stops DNS rebinding. CORS headers are sent only for
  `--allowedOrigins`; every origin used to be allowed.

### Changed — MCP results conform to their advertised schemas (breaking for MCP clients)

- **`structuredContent` is the tool's output itself.** It used to be the
  handler's `{output: …}`, one level above the advertised `outputSchema`, so
  the official MCP SDK client rejected every module tool with `-32602
  Structured content does not match the tool's output schema` (Claude Code
  does not validate, which is why it never showed). The text block is the
  same object serialized. A synchronous call is shaped with the output
  schema in effect when it started, even if the module reloads before it
  answers. tasks/result follows the module as loaded when it is read: a completed task is stamped with a hash of the output schema its
  result was produced under, and goes text only once the advertised schema
  is a different one (even if the old result would validate against it). No
  module schema is compiled on the main thread for it.
- **Tools without a declared output schema advertise none** and return text
  only. The bundled modules all declare one; their `tools/list` is
  unchanged.
- **Error codes are in `_meta["countinghouse/code"]`**, and error results
  carry no `structuredContent`, because clients validate it against the
  output schema even on errors.
- **`countinghouse_call_tool` advertises no output schema.**
- **`countinghouse_check_balance` returns `{userName, balance}`**, no longer
  the caller's raw API key, which reached model context and logs. A user
  name equal to the key (the file provider's fallback for an entry without
  `userName`) is returned as `null`; under `--debug` it is `debug`.
- ctx.call and HTTP `invoke-action` keep `{output: …}`.
- **The composite examples' internal keys differ from their user names.**
  In `examples/log-triage/auth.json` and `examples/repo-review/auth.json`
  the internal identity's key was its user name, which every bill prints as
  `authorizedAs`, so every caller received a working key (log-triage's reads
  unmasked logs). The keys are now `…-internal-demo-key-not-secret`; the
  user names, `runsModules` and handlers are unchanged.
- **The file auth provider warns at startup** about an entry whose key equals
  its `userName`, or that has no `userName` (the key is then used as the user
  name). It names the entry by position, never prints a key, and starts
  anyway.
- New contract test `test/mcp-contract/03-sdk-client-conformance.js` drives
  `@modelcontextprotocol/sdk` 1.32.2 (exact-pinned devDependency) against
  every bundled and example module; `04-output-shape-after-reload.js` covers
  a reload that changes a schema.

### Changed — 8.0.0 platform

- **Node 22.16 or later is required** (the first 22 with
  `module.registerHooks`). Startup exits with status 2 on an older Node.
  Below 24.15 `module.registerHooks` does not hook `require.resolve` or
  `createRequire().resolve`, so a compatibility shim (`lib/resolve-shim.js`)
  routes them through the sandbox's hooks as 24.15 does; multi-tenant hosting
  of third-party modules should run 24.15 or later, where Node's own hook
  covers it. The floor rises to 24 when Node 22 reaches end of life, on
  2027-04-30. Under enforce, `require.resolve.paths()` from module code no
  longer lists Node's global lookup directory, a host path, on any version.
- **`--workerThread` is on by default.** Pass `--no-workerThread` (or
  `--workerThread false`) for single-thread mode, now meant only for
  debugging modules; startup logs a warning saying so. Worker mode also
  starts, by default, what it always started:
  - the BullMQ job worker on Redis, so the job routes (`POST /add-job`,
    `/get-job`, `/get-job-history`, `/remove-job`) and MCP task-augmented
    `tools/call` are available on a plain start, where they used to refuse;
    pass `--no-workerThread` if you do not want them;
  - modules in worker threads, so direct peer channels are used;
  - the module sandbox in its default `audit` mode (see below).
- **A load must use the module's package.json name** (`MODULE_NAME_MISMATCH`
  otherwise), in every mode, single-thread included; `POST /load-module`
  may omit `name` and then uses it. The module sandbox's policy is looked
  up by that name. Before upgrading, check registry entries, `load_module`
  calls and composite `runsModules` bindings for names that differ from the
  module's package.json. A module that fails to load at startup is now
  logged with the reason.
- **The job worker needs Redis 5.0 or later** (BullMQ; 6.2 recommended). On
  an older Redis, which 7.x ran on as long as jobs were not used, a plain
  start now logs BullMQ's version error and jobs do not run.
- `UV_THREADPOOL_SIZE` defaults to 16 (set it yourself to override).
- **Every module now needs a writable `--moduleDataPath`**, in every mode:
  the default is `$HOME/.countinghouse/module_data`, so where `$HOME` is
  read-only (systemd `ProtectHome` or `ProtectSystem=strict`, a read-only
  container root) set `--moduleDataPath` to a writable directory before
  upgrading, or modules fail to load with `cannot create the module data
  directory`.
- **Modules see their own directory as `/app`**, in every mode under
  `--workerThread`: `__dirname`, `__filename`, `require.resolve`,
  `import.meta`, stack traces, `process.cwd()` (`/app`) and `os.tmpdir()`
  (`/tmp`). A module that builds paths from `__dirname` keeps working; one
  that logs or compares host paths sees `/app/...` instead.
- **countinghouse must not be installed under `/app`** under
  `--workerThread`: startup exits with status 2 if its real install path is
  there, because modules see their own files at `/app` and Node keys loaded
  code by path. Install it elsewhere (for example `/opt/countinghouse`) or
  run with `--no-workerThread`. Modules and data under `/app` are fine.
- A module's device config (`--deviceConfigPath`) is read by the main
  thread and handed to the worker.
- HTTP/2 `respondWithFile` is not available to modules (see Known issues).
- Anything a module left in `/tmp` is gone after a restart.

### Removed — the CDIF-era Docker image

- **`docker/countinghouse/` is gone.** Its Dockerfile built a CDIF image
  (Ubuntu 16.04, Node 12, countinghouse 3.0.21 with code-server) and does not
  run this release: it predates the Node 24.15 floor, and under the new
  `127.0.0.1` default bind nothing outside the container could reach the
  server. It is retired for now rather than updated. A container for 8.x
  must pass `--bindAddr 0.0.0.0`.

### Added — module sandbox, part 2

- **File access from module workers goes through the main thread**, in every
  `--moduleSandbox` mode under `--workerThread`: `fs` is patched before any
  module code loads, and a per-worker broker answers every call. Each module
  gets private `/data` and `/tmp` directories under the new
  **`--moduleDataPath`** (default `$HOME/.countinghouse/module_data`); `/tmp`
  is the module's own, no longer the host's. Under `enforce`, paths outside
  the namespace are `ENOENT`, `/app` and read-only declared paths are
  `EROFS`, and the link rules apply in every mode.
- **The loader is bounded**: from the moment a worker is set up, the loader
  and countinghouse's own worker code reach only the module's directory and
  countinghouse's code (`lib/`, `node_modules/`, `package.json`,
  `spec/schema.json`); `module.parent.require`, `require.cache[...].require`,
  `Module._load` and similar routes cannot read anything else. Refused under
  `enforce`, logged under `audit`.
- **Other routes to files and descriptors**, refused under `enforce` and
  logged under `audit`: adopting a descriptor or handle
  (`new net.Socket({fd})`, `server.listen({fd})` or `listen(handle)` on any
  `net`, `http`, `https`, `http2` or `tls` server, `dgram` `bind({fd})`,
  `tty` streams, HTTP/2 `respondWithFD`), diagnostic report writes, the
  compile cache, and source maps. `repl` and `trace_events` leave the
  built-in allowlist. `process.loadEnvFile` reads through the broker, in
  every mode.

- **A disk quota for each module's `/data` and `/tmp`** (one pool):
  `diskMb` (default 1024) and `diskEntries` (default 100000), declared in
  the module's `limits` and narrowed by `--modulePolicy` like the other
  limits. Under `enforce` a write past it is `ENOSPC`; under `audit` it is
  allowed and logged at 75 % and 100 %; under `off` it is not counted.
- **`/tmp` is emptied whenever a module's worker starts**, never through a
  link. Under `enforce`, a module whose data holds a symlink with an
  absolute target, or a hard link whose other name is outside its data,
  does not start until the operator removes it (the log names the entries
  and says how). Restarts, reloads and uninstalls of one module are
  serialised, and a new worker starts only once the old one's file
  operations have finished (at most 35 s).
- **`POST /uninstall-module {name, keepData}`** (admin key) deletes a
  module's data and its registry entry, never its code. It is refused while
  the module is loaded, restarting or suspended (`MODULE_LOADED`); unload it
  first.

### Known issues — 8.0.0

- HTTP/2 `respondWithFile` is not available to modules
  (`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`): it hands the file's descriptor to
  native code, which cannot read a brokered one. Read the file with `fs` and
  stream it yourself.
- The `__filename` and stack frames of a CommonJS file that an ES module
  imports directly show its host path, not `/app/...` (a Node 24 limit);
  what that file requires is virtual again.
- `--hardened` does not support pnpm installs of countinghouse: Node's
  permission model refuses a granted symlink when another grant extends its
  name (`redis` beside `redis-commands`), a form of
  [nodejs/node#66812](https://github.com/nodejs/node/issues/66812), and
  Node's own module loader resolves pnpm's links. npm installs work, and
  pnpm installs work without `--hardened`.
- From Node 24.22 that bug also refuses a synchronous `realpath` of such a
  directory. `--hardened` resolves countinghouse's own granted directories
  before relaunching, so the server starts; any other granted directory Node
  would refuse (an overlap among the paths you configured) stops startup
  with status 2 and a message naming the paths.

### Added — module sandbox, part 1

- **`--moduleSandbox off|audit|enforce`** (default `audit` under
  `--workerThread`, `off` otherwise). In each module's worker: no native
  code, no process controls, `require` limited to built-ins and the module's
  own directory, built-ins limited to an allowlist (no `child_process`,
  `cluster`, `worker_threads`, `inspector`, `wasi`, `v8`, `node:sqlite`,
  `node:test`, or anything newer than Node 24.21), no OpenSSL engines. `audit` logs violations; `enforce` blocks them.
- **Declared permissions** (`countinghouse.permissions` in a module's
  `package.json`) narrowed by an operator **`--modulePolicy`** file. `env`
  and limits apply now; `fs` and `net` take effect with parts 2 and 3.
  Targets of `CHUtil.request` and `CHUtil.createSOAPClient` are checked
  against the effective `net` entries: under `audit` a disallowed target is
  logged and the request goes ahead; only `enforce` refuses it, and then
  `CHUtil.request` accepts only an allowlist of options.
- **Resource limits**: JS heap, memory outside the heap, a blocked event
  loop (`heapMb`, `externalMb`, `maxBlockMs`), and a worker message rate
  (`--moduleMessageRate`).
- **`--hardened`**: re-launches under Node's permission
  model; every module must live under `--modulePath`.
- `countinghouse-validate` reports dependencies outside the module, native
  code, and (as warnings) install scripts.
- A `sandbox` status key on `POST /get-module-device-list`, and the error
  codes `MODULE_SANDBOX_REFUSED`, `MODULE_RESTARTING`, `MODULE_SUSPENDED`,
  `RATE_LIMITED` and `MODULE_PATH_OUTSIDE_ROOT`.
- Known gaps, documented in `docs/security-model.md`: module code can still
  reach countinghouse's loaded modules through `require.cache`,
  `createRequire`, and a `vm.Script` with dynamic `import()`; it can send
  the main thread any worker message, so the main thread trusts the caller
  and billing key a cross-module call states (as before), and bounds those
  messages on its own side; `fs` and network are not yet brokered, so `CHUtil.request`'s
  host check is not a network boundary, and a module can read files the
  process can read, `/proc/self/environ` included, unless `--hardened` is
  on; `--hardened` follows symlinks and needs `--allow-addons` for SQLite
  auth. This is a strong barrier, not a hard boundary against code written
  to defeat it.

### Changed — what the default `audit` mode does to existing modules

These apply under `--workerThread` unless
`--moduleSandbox off` is given.

- **A module worker's `process.env` holds only the variables the module
  declares** (`countinghouse.permissions.env`), with values from the policy
  file or the server's environment. A module that read other variables, or
  relied on `NODE_PATH`, sees them unset. This keeps secrets out of
  `process.env`, not out of reach: see the known gaps above.
- **Resource limits can end a worker**: over 256 MB of JS heap or of
  external memory, or an event loop blocked for 10 s, by default (the
  module may ask for less; the operator's policy sets the ceiling). More
  than 2000 messages a second to the main thread are refused with
  `RATE_LIMITED`.
- **A module whose worker ends now restarts**: after 1 s, then 2 s,
  and suspended on the 3rd exit within 10 minutes. Calls
  meanwhile get `MODULE_RESTARTING` or `MODULE_SUSPENDED` and the tools stay
  listed. `--moduleSandbox off` keeps the old behaviour, where a crashed
  module stays down. Uncaught exceptions are still caught inside the worker
  and do not end it.
- **Violations are logged**, once per module, rule and target, and each
  module's effective permissions are logged when its worker starts.

### Fixed — a worker that ends while loading

- **A load fails when the module's worker ends before the module has
  loaded**, with the exit reason, instead of never answering. This applies
  under `--moduleSandbox off` too.

### Fixed — a reload runs the module's current code

- **Under `--workerThread`, reloading a module restarts it in a new worker.**
  Loading an already-loaded module (`POST /load-module`,
  `countinghouse_load_module`) used to re-evaluate it inside the same worker,
  where everything its files `require()`d still came from that worker's
  require cache: after editing a helper and reloading, the handler was new
  and the helper was old. A new worker starts with an empty cache, fresh
  globals, and none of the old code's timers or sockets.
- **`POST /reload-module` no longer runs module code in the main thread**
  under `--workerThread`; it restarts the module's worker too.
- **Single-thread mode:** a reload drops the module directory's files from
  the require cache first, so it also runs the current code.
- **Unloading waits for the worker's acknowledgement** instead of a fixed 3
  seconds, which remains the upper bound for a worker that never answers.

### Changed — `CHUtil.loadFile` is a plain `require()`

- **The `rewire` dependency is removed.** `CHUtil.loadFile(path)` now
  returns the same object on repeated calls instead of compiling a new copy
  each time. Existing calls need no change.
- **Release-mode console silencing covers the whole worker.** Without
  `--debug`, module console output was dropped per file by rewire, so a
  module's dependencies kept printing; now the worker's `console` is
  silenced before any module code loads. In single-thread mode module
  console output is no longer silenced, since that mode is for local
  development.
- Test: `test/module-loading/12-reload-fresh-code.js`.

### Docs — every performance number re-measured on 2 vCPUs

- All benchmark figures in `docs/direct-peer-channels.md`,
  `docs/log-triage-performance.md`, both posts under `docs/`, `README.md` and
  `examples/log-triage/README.md` were re-measured on 2026-10-26 on a 2-vCPU
  machine (Node v24.21.0, module sandbox `audit`), three independent runs per
  script. Raw output is in `perf/results/2026-10-26/`; the replaced tables
  are kept under "Retired numbers" in `docs/direct-peer-channels.md`.
- `examples/repo-review/token-comparison.js` runs again (it had failed since
  composition binding started requiring a `runsModules` identity, which its
  `--debug` server lacked; it now loads the demo's `auth.json`). Re-run on
  2026-10-26: 6.08 MB against 10.7 KB, 579× (previously 470×; the repository
  it scans has grown).
- log-triage's in-process baseline now schedules the handlers the way the
  composite does, each file's read and redact chain concurrently; it had run
  them one file after another, which on two CPUs made it run high. With it,
  re-measured on 2026-10-27 (`perf/results/2026-10-27/`), the runtime is most
  of the call for small inputs, 65% at 100 lines per file on the direct path,
  as on one vCPU. A 2026-10-26 docs update that said the opposite is
  withdrawn.
- `perf/`: the four benchmark scripts take `--runs N`, report each cell as
  the median and range across fresh-process runs, count a difference only
  when the ranges do not overlap, and print each table's noise floor and the
  module sandbox mode it ran under.
- Test fixture: `test/fixtures/sandbox-native/build/Release/fake.node` is now
  committed; `build/` in `.gitignore` had kept it out, so sandbox 04 failed on
  a clean checkout.

## 7.1.2

### Security — `package-info` is rate limited

- **`GET /devices/:deviceID/package-info` now enforces `--apiKeyRateLimit`.**
  The 7.0.0 read-path work gated `/balance`, `tasks/*` and the job routes and
  left this one out; `docs/cross-cutting-matrix.md` recorded the cell as
  empty. It shares the per-apiKey budget the other reads and tool calls draw
  on, and a denial answers HTTP **429** with `code: RATE_LIMIT_EXCEEDED`.
- **No change unless `--apiKeyRateLimit` is set.** The limiter still fails
  open, as at every other call site.
- Test: `test/auth/15-read-path-rate-limits.js`.

## 7.1.1

Two leftovers from the PM2 era are removed, and the log-triage example gets
a performance report.

**If a supervisor waits for this server's `ready` process message, read
"Removed" before upgrading**: that message is gone, and the
`countinghouse ready` log line added in 7.1.0 is what to wait for. By this
file's own definition a removed CLI flag is a breaking change. It ships as a
patch because `--withPM2` was never documented, a command line that still
passes it starts unchanged, and nothing in the project consumed what it
produced; the same goes for the IPC listener removed with it.

### Removed

- **`--withPM2`.** The flag dated from when this server ran under PM2 as
  CDIF. It made the server send its parent process a `ready` message at
  startup and a heap-statistics message every ten seconds; nothing in the
  project reads either. Both are gone, with the collection that fed the
  second (a ten-second timer per worker under `--apiMonitor`). The flag was
  never in the CLI reference. A command line that still passes it starts as
  before, since unknown flags are ignored, but **a supervisor waiting for
  the `ready` message will no longer receive one**: wait for the
  `countinghouse ready` log line instead.
- **Module control over the parent-process IPC channel.** `lib/monitor.js`
  listened for messages from the process that started the server and
  loaded, unloaded or restarted a module on request. It was another PM2-era
  path, never gated by `--withPM2`, never documented, and absent from
  `docs/cross-cutting-matrix.md`. Use the admin-gated HTTP module-lifecycle
  routes or `countinghouse_load_module`.

### Added

- `docs/log-triage-performance.md` and `perf/log-triage-perf.js` — how the
  log-triage composite's latency follows its input on both hop paths, what
  the runtime adds over the same work done in one process, and one composite
  call against the same hops made by a client. Measured on a one-CPU VM and
  framed accordingly.

### Tests

- No fixed startup wait of four seconds or more remains in the suite or the
  example scripts. The waits after a run-time module load now follow the
  ready line too, and the cluster-mode tests wait on it in place of the
  removed `ready` message.

## 7.1.0

A second composite example, direct peer channels as the default hop path,
and two billing fixes found while building the example.

**One change alters what an unchanged command line does:** module-to-module
hops now take the direct path, which checks authorization when a channel
opens instead of on every hop. Read "Changed" below before upgrading;
`--no-directPeerChannels` keeps the 7.0.0 behaviour. Operators who run
composites should also read "Fixed": both bugs were present in 7.0.0.

### Added

- `examples/log-triage` — a second composite example, whose bill follows its
  input. It triages a directory of logs with one `list` hop, a concurrent
  read-then-redact chain per file and one `cluster` hop: `2N + 2` metered hops
  for `N` files, capped by the caller's `maxFiles`. `npm run demo:log-triage`
  starts it; `examples/log-triage/verify-cost-bound.js` asserts the bill on
  both hop paths, and the suite runs that script.

- **The server logs `countinghouse ready` when it can serve.** The line is
  written once every preloaded module is discovered and every composing
  module's verdict has been delivered to its worker, which is the point from
  which `ctx.call` stops answering `CTX_CALL_NOT_READY`; it is written again
  after each later discovery pass, such as a module loaded at run time. "all
  module discovered" is logged earlier and was never that signal. A deploy
  script can wait on the new line; the test suite and the example verify
  scripts now do, in place of fixed startup sleeps.

### Changed — direct peer channels are the default

- **Module-to-module hops now go worker-to-worker directly unless
  `--no-directPeerChannels` is passed.** `--directPeerChannels` was opt-in
  through 7.0.0; it is still accepted and now changes nothing. An unchanged
  command line therefore takes a different hop path after upgrading.
  `ServiceClient.invoke()` and `ctx.call` keep the same signature, error
  shape and timeout behaviour, and billing is identical on both paths, but
  two things differ and an operator should choose knowingly:
  - **Authorization between modules is checked when a channel opens, not on
    every hop**, and a channel is good for every device its callee worker
    hosts. A grant revoked while the server runs (possible with the sqlite
    and CouchDB AuthProviders, not with the default file one) closes the
    channel on the broker's next re-check, every
    `--peerChannelAuthRecheckSeconds` (new, 5 by default; `0` turns it off),
    so a revoked module identity can keep reaching a device for up to that
    long. On the main-thread-routed path it applies to the next hop.
  - **Module code can receive four more error codes:** `PEER_GONE`,
    `PEER_CHANNEL_TIMEOUT`, `PEER_SELF_TARGET`, `PEER_NO_HANDLER`.

  Pass `--no-directPeerChannels` to keep the 7.0.0 behaviour. See
  `docs/direct-peer-channels.md`, "What the default means for an operator".

### Fixed — two ways a composite's hops were billed wrongly

Both were found by running `ctx.call` hops concurrently, which no composite in
the tree did.

- **Overlapping charges overwrote each other.** `recordCall` read the balance
  and wrote it back as two Redis round trips, so calls that overlapped all
  read the same balance and all wrote the same result: ten concurrent hops at
  cost 1 moved the caller's balance by 2. The same race let a free-call quota
  of 5 serve 20 overlapping calls. The deduction is now a single atomic step.
  This applied to every charge on one key, not only to hops — any two calls
  metered at the same moment could lose one.
- **`--directPeerChannels` billed the composing module, not the caller.** The
  peer-invoke message was built without the billing identity, so the callee
  fell back to the identity the channel was granted under. Hops made through
  `ctx.call` or `ctx.serviceClient` were charged to the module's own identity
  and the caller paid only for the outer call. The default, main-thread-routed
  path was not affected.

An operator who ran composites with `--directPeerChannels` will find those
hops on the module identity's balance rather than on callers'.

## 7.0.0

The "deployable and defensible" release. It closes the last open item from
the pre-release security audit, removes the entry paths inherited from the
2015 IoT device gateway this project grew out of, and settles what
countinghouse actually is.

Most of it is subtraction. Four HTTP entry paths and a whole OAuth subsystem
are gone, and **every one of them was already broken** — each called a method
that was never defined, or sat behind a flag hardcoded to `false`. The
breaking changes to the HTTP surface therefore remove almost no working
behavior; what they remove is the appearance of it. Two guards now keep that
from recurring: a route inventory that fails the suite until a new entry path
is declared, and an error log where an unresolvable tool schema used to be
downgraded in silence.

**Not in this release, and originally planned for it:** real payment
settlement, and a second composite example. The 7.0.0 scope was first drawn
around six items; four are here. Settlement lands on the module format and
the auth config, both inside this file's definition of the public surface, so
it is expected to need its own major. That is a deliberate re-scope, not an
oversight — the alternative was holding these security fixes behind an
open-ended payments design.

### Security — the authenticated read paths are now rate limited

- **`GET /balance`, the `countinghouse_check_balance` MCP tool, and
  `tasks/get` / `tasks/result` / `tasks/list` / `tasks/cancel` now enforce
  `--apiKeyRateLimit`.** All five were authenticated but unlimited: each was
  one Redis round trip that an authenticated caller could poll as fast as it
  liked. This closes the last open item from the pre-release audit's security
  findings.
- **`POST /devices/:deviceID/add-job` is now limited too, closing a real
  bypass.** MCP task creation is deliberately limited at creation time
  (unbounded queue growth being the resource protected), but `add-job`
  creates the same jobs over HTTP and was not limited at all — so the MCP
  limit could be sidestepped by choosing the other door. The three HTTP job
  *read* routes (`get-job`, `get-job-history`, `remove-job`) are gated as
  well; `docs/cross-cutting-matrix.md` had asserted a limit for all four that
  the route stack never actually applied.
- **Reads share the existing per-apiKey budget** rather than getting a flag
  of their own. A client that polls `tasks/get` while a task runs draws down
  the same allowance its tool calls use. No new CLI flag.
- **New error code `RATE_LIMIT_EXCEEDED`** (both locales). HTTP denials
  answer **429**, not the 500 the pre-existing limiters produce via
  `lib/session.js`; `invoke-action`'s existing 500 is unchanged. MCP denials
  keep each surface's existing shape — a tool error for
  `countinghouse_check_balance`, a JSON-RPC error for `tasks/*`.
- **Unchanged: the limiter still fails open** — flag unset, no metering
  provider, unresolved key, or Redis down all pass the request through, as
  every pre-existing rate-limit call site already did.
- Not covered, deliberately: both direct-peer-channel paths (unchanged
  decision) and `tools/list`.
- Test: `test/auth/15-read-path-rate-limits.js`.
### Fixed — an unresolvable tool schema is no longer a silent downgrade

- **A declared schema pointer that fails to resolve is now logged at error
  level**, naming the tool, which schema (input vs output), the pointer, the
  concrete reason, and the consequence. `resolveSchemas`
  (`lib/mcp/tool-registry.js`) previously dropped the error on both branches
  and advertised `{type: 'object', properties: {}}` — "any object is fine" —
  in place of the real schema, so a client would send what that permits and
  the call would then fail server-side in `validateActionCall`, with nothing
  upstream to explain it. New error code `TOOL_SCHEMA_RESOLVE_FAIL`.
- **Behavior is otherwise unchanged**: the tool is still advertised, still
  with the permissive default schema. Omitting it instead would move the
  `tools/list` surface, and is deliberately out of scope here.
- Worth knowing if you relied on `--debug` to surface this: there was an
  incidental error log on this path from `lib/session.js`, but it fires only
  under `--debug` and names neither the tool nor which schema. A normal
  (non-`--debug`) run produced **no** error records at all for a dangling
  pointer.
- "No schema declared" stays silent — that is legitimate and common.
- Test: `test/module-loading/10-schema-pointer-not-silent.js`.

### Removed — the IoT-era HTTP surface

- **The dead entry paths are gone**: `/devices/:deviceID/connect` and
  `/disconnect` (both called a `CdifInterface` method that was never
  defined, so every POST threw `TypeError`), `/discover` and
  `/stop-discover` (mounted only under `allowDiscover`, which
  `cli-options.js` hardcoded to `false`), and
  `/devices/:deviceID/presentation` (dead twice over — nothing emitted the
  event that mounts it, and the mount handler called an undefined method).
  Breaking on paper; no behavior change in fact.
- **The vestigial flag-gated surface is gone**, and this one *is* a
  behavior change: the OpenStack simulation (`--simOpenStackAPI`) and
  `/load-profile` (`--loadProfile`), together with both flags. The
  OpenStack routes were mounted with **no authentication at all** and
  hardcoded a single 2015 vendor target; `/load-profile` was the only
  reader of the `loadLevel` counter, which goes with it. **Unknown flags
  are ignored**, so a startup script still passing either one boots
  normally and simply gets no route.
- **`device_access_token` plumbing removed.** `ensureDeviceState` took the
  token and never read it, `lib/device-auth.js` was imported by nothing,
  and `/connect` — which would have issued one — is removed above. A
  client still sending the field is unaffected: it was already ignored.
- **Error codes removed** (both locales): `PRESENTATION_NOT_SUPPORTED`,
  `GET_DEVICE_ROOTURL_FAIL`, `PARSE_DEVICE_ROOTURL_FAIL`.
- **Capability genuinely lost:** the OpenStack-shaped simulation shim.
  Nothing else here worked.
- **Not removed, deliberately:** `/devices/:deviceID/package-info`,
  `/download-package`, `/verify-module` and `/get-module-device-list`.
  They are untested and undocumented, but they are also the only existing
  bones of the publish/listing story, so they wait on that design rather
  than being pre-decided here.
- **New guard:** `test/module-loading/11-route-inventory.js` diffs the
  mounted routes against `test/fixtures/route-inventory.json`, so a new
  entry path fails the suite until it is declared and given its
  cross-cutting-matrix row.
- **The `start-allow-discover` npm script is gone**, along with the
  `--allowDiscover` flag it passed — the flag was removed earlier in this
  section, leaving the script to boot an ordinary server under a name that
  promised discovery it no longer performed.
- **`devicePresentation` is gone from the device spec schema.** Its only
  reader, `CHDevice.prototype.getDeviceRootUrl`, was deleted with the dead
  entry paths above; the field was already inert — the route that would
  have reached it never worked, so nothing read it.
- Tests: `test/auth/16-removed-iot-routes.js`,
  `test/module-loading/11-route-inventory.js`.

### Removed — the dead device-callback entry path

- **`/callbacks/:deviceID/*` is gone**, together with
  `CdifInterface.invokeDeviceCallbacks`, `DeviceManager.onInvokeDeviceCallback`,
  `CHDevice.invokeDeviceCallback`, the `invoke-device-callback` worker message,
  and the `DEVICE_CALLBACK_NOT_AVAILABLE` / `DEVICE_INVOKE_CALLBACK_FAIL` error
  codes. This is a breaking change to the HTTP surface and to `CHDevice`, which
  is why it lands in a major — but nothing functional is lost. The chain ended
  at `this._deviceCallbackHandler`, **a property nothing in the repo ever
  assigned**, so every request that reached the route came back
  `DEVICE_CALLBACK_NOT_AVAILABLE`. It was dead code in the same sense as the
  event subsystem removed in 5.0.0: the front door worked, the delivery never
  did.
- The route was also mounted with no authentication at all ("callback don't do
  user auth"), reachable whenever the server was. It was flagged in the
  pre-release audit as needing review before any public deployment; the review
  concluded there was nothing there to secure.
- A CDIF-era inbound webhook has no MCP equivalent, and since 5.0.0 removed
  event delivery there is no path from an inbound request to a connected
  client. Reinstating inbound webhooks means supplying both halves.
- Test: `test/auth/14-removed-callback-routes.js`.

### Removed — the OAuth device path

- **`/callback_url` is gone**, together with `lib/oauth/`, the `oauth` npm
  dependency, `CHDevice.setOAuthAccessToken`, `CHDevice.oauthTokenValidate`,
  the `oauth_version` branch in `DeviceManager.onDeviceOnline`, and the
  `CANNOT_SET_OAUTH_ACCESS_TOKEN_INVALID_INTERFACE` /
  `OAUTH_ACCESS_TOKEN_NOT_AVAILABLE` error codes. Nothing regresses, because
  none of it was reachable: `lib/routes/oauth-callback.js` called
  `cdifInterface.setDeviceOAuthAccessToken(...)`, **a method never defined on
  `CdifInterface`**, so every GET threw `TypeError` and answered 500. It also
  read `req.session`, which only `routes/user.js` and `routes/admin-only.js`
  ever set, and neither was mounted on that path. Nothing outside
  `lib/oauth/oauth.js` itself ever set `oauth_version`, and
  `oauthTokenValidate` had no callers at all.
- **What this does remove is a module's ability to hold a third-party API's
  OAuth token.** MCP's authorization framework covers client→server — which is
  what AuthProvider and `X-CH-Key` already do — and deliberately leaves
  server→third-party credentials to the implementation. That gap is now
  unfilled rather than filled-but-broken, and wants its own design when a
  module actually needs it.
- A module's *own* redirect flow is untouched: `connectionState:
  'redirecting'` is driven by a module's `_connect` returning a `redirectObj`
  and never depended on any of the above.

### Changed — countinghouse is a runtime, not a marketplace

- **The project description is corrected** in `server.json` and
  `package.json`. It claimed to be a "monetization/marketplace backend";
  it is a multi-tenant runtime for MCP tools with metering and per-key
  access control. The marketplace half never existed in this repo.
- **Modules are distributed over npm**, to whichever npm-compatible
  registry an operator configures. countinghouse builds no publish,
  storage or browse machinery: `npm publish` is the publish story, and
  the operator installs with the tooling they already have. **The runtime
  never fetches code over the network.**
- **Removed with no replacement**: `POST /verify-module` and its tarball
  verifier (superseded by `countinghouse_validate_module`, which runs in a
  child process, cross-checks the handler map, and reports every problem);
  `GET /devices/:deviceID/download-package` and its chain (npm serves
  packages now); and `--regUrl`, the old private registry default. Six
  error codes and two dependencies (`tar`, `npm-registry-client`) went with
  them. (The 2015 CouchDB publish script needed no removal — `example/` has
  been untracked since 182db48.)
- **Kept**: `/get-module-device-list` and `/devices/:deviceID/package-info`,
  which now have tests and cross-cutting-matrix rows for the first time.
- **`USER_HAS_NO_DEVICE`'s message no longer sends users to a marketplace
  that doesn't exist.** It now says the apiKey lacks access and points at
  the operator's auth config, the last user-visible instance of the claim
  this section fixes.
- **Consequence for payments**: settlement is between an operator and
  their own users. Module authors are not paid through countinghouse, and
  there is no revenue share, payout or escrow.
- Background and the full reasoning:
  `docs/superpowers/specs/2026-09-04-marketplace-backend-design.md`.

## 6.1.0

Two new subsystems, both additive: a toolchain for authoring modules, and an
API for modules to call each other by name. `api.json`, `schema.json` and the
MCP contract are unchanged — `tools/list` remains byte-identical to the golden
sample, asserted on every commit.

### Added — composition: modules call each other by name

- **`ctx.call(address, input, opts)`**. A handler reaches another module as
  `<module>/<service>.<action>` — `repo-scan/scanService.scan` — instead of a
  pasted deviceID UUID, a service URN and a hand-built client. `opts.detail`
  returns `{data, platformMetering}` where the plain form returns `data`.
- **`countinghouse.calls` in `package.json`** declares every address a module
  is allowed to call. An address outside the declared set is refused.
- **`runsModules` in the auth config** binds the identity a module's hops are
  *authorized* as. Which identity a module runs as is the operator's decision,
  not the author's, so the same module can be deployed twice under two
  identities. Both auth backends implement it (`identityForModule` on the file
  and sqlite providers).
- **Everything is verified at load time, not at first call.** Every declared
  address is resolved against the target's real spec, the identity is bound, a
  duplicate binding is refused, and the bound identity's grant to each target
  is checked. A typo fails the module at startup with a message naming the
  module, the address and the file to fix.
- Authorization and billing stay two different identities: a hop is authorized
  as the bound identity and billed to `ctx.caller`, the real outer caller, so
  per-hop cost lands on whoever made the outer call.
- `ctx.serviceClient` remains the escape hatch for a per-call identity override
  or a module that legitimately needs two identities.

### Added — the module-authoring toolchain

- **`--authoringTools`** (default off) exposes four MCP tools behind a second,
  independent admin-key gate: `countinghouse_validate_plan`,
  `countinghouse_validate_module`, `countinghouse_load_module` and
  `countinghouse_call_tool`. Default-off matters because `load_module` plus
  `call_tool` is arbitrary code execution with a friendly name. With the flag
  off the tools are byte-identical to tools that do not exist — same envelope,
  same error code, produced by the same line of code as a genuinely unknown
  tool.
- **`countinghouse-validate`**, a new bin: the same validation oracle from a
  shell, no server required. `--json` emits a machine-readable result.
- `countinghouse_validate_module` runs the module under test in a **spawned
  child process**, so a crash or a `process.exit()` in caller-supplied code
  kills the child rather than the gateway, and a re-validated module is never
  served from a stale `require` cache.
- The `countinghouse-module` skill ships in-repo (`.claude/skills/`), so
  pointing a coding agent at a clone is enough.

### Fixed

- **`ctx.call` refusals now carry typed error codes** — `CTX_CALL_NOT_READY`,
  `CTX_CALL_UNBOUND`, `CTX_CALL_UNDECLARED`, `CTX_CALL_BAD_ADDRESS`,
  `CTX_CALL_UNRESOLVED` — reaching an MCP client in `structuredContent.code`.
  They previously collapsed into the generic `DEVICE_INVOKE_EXCEPTION`, making
  a misconfigured chain indistinguishable from a callee that genuinely crashed.
- **The startup window identifies itself.** Composition verification is
  asynchronous and runs after discovery, while a device is already listed and
  serving. A call landing in that window is now refused with
  `CTX_CALL_NOT_READY` ("retry") instead of being blamed on an auth config that
  was already correct.
- **A bare instance completes discovery.** `allmodulediscovered` was gated on a
  startup module count an instance with no `--loadModule` flags never reached,
  so composition verification never ran there and every runtime-loaded module's
  `ctx.call` was refused. This was exactly the `--authoringTools` workflow,
  which is designed to start with no modules.
- **A deviceID already registered by a different module is refused** rather
  than silently taking over the existing registration.
- Re-verification after a runtime module load no longer purges devices that are
  already online and serving; it only clears their composition binding.
- `errCode` now rides the main-thread-routed reply envelope, so an inner hop's
  error code survives the worker boundary on the default path as it already did
  under `--directPeerChannels`.
- The heap-stat timer is installed once per process instead of once per
  discovery event.
- Authoring fixes: a module's own load-time stdout no longer shadows the CLI's
  `--json` line, `load_module`'s wait on a hanging module is bounded, and
  `validate_plan` resolves `plan.calls` against live specs and catches
  duplicates.

### Changed

- `spec/schema.json` relaxes a device's `modelDescription` to 4096 characters,
  matching what an action's `description` already allowed.

### Docs

- `examples/repo-review` — a composite tool that reads a repository and never
  returns the source it read — with `npm run demo:repo-review` to start it in
  one command.
- The README leads with composition; reference material moved into `docs/`.
- All three benchmarks re-measured, with every citing document updated.

## 6.0.0

A breaking release for module authors; `api.json`, `schema.json` and the MCP
contract were unchanged. A module became its handlers — `index.js` and
`device.js` are gone, handlers are `async (input, ctx) => ({output})`, and the
framework assembles the device from `api.json`. See
[`MIGRATION.md`](MIGRATION.md) for the conversion, `git show v6.0.0` for the
full notes, and `npx countinghouse-migrate-module` for the automated path.
