# Local mode (LM1): one process, no Redis, stdio, scenario loading, usage records

Status: draft for review (2026-11-11, reviewer session, for implementer B).
Target: 8.0.0 (unreleased). Consumed by the client-pack launcher (a separate
product built on the runtime). Decisions by the maintainer on 2026-11-11 are
marked "(maintainer)".

## Intent

A developer installs a launcher into the agent they use, and a client starts
the runtime as a child process. That machine has Node and nothing else: no
Redis, no second process, often no permission to install one. Today the
runtime needs Redis for metering, rate limiting, the module-facing
`ctx.redis` store, the job queue behind `/add-job` and MCP tasks, and the
retired API log. Local mode replaces Redis with a store suitable for a
client machine (maintainer: "remove Redis and replace it with something
suitable for the client environment"), speaks MCP over stdio, loads one
scenario with the parts it declares, counts what crosses its boundaries,
and writes those counts where a report can read them. Hosted operators keep
Redis, unchanged.

## Goals

- `countinghouse --store local --stdio --loadModule <scenario>` runs with
  no service besides Node, on Linux, macOS and Windows.
- Nothing an operator runs today changes: `--store redis` is the default and
  behaves as now.
- Only scenario modules are listed; their declared parts load with them and
  stay unlisted.
- Every server call an access module makes and every result a scenario
  returns is counted at the runtime's boundary, exactly, and recorded
  durably.
- No telemetry, no network call of the runtime's own.

## Non-goals

- A second metering backend for hosting (Redis stays).
- Persistence of jobs across restarts in local mode (documented).
- The OAuth front and the HTTP remotes (RC1's).
- Changing the module format.

## Design

### 1. The store: `--store redis|local`

A new option. `redis` (default): exactly today, `--redisUrl` as before.
`local`: no Redis client is created anywhere in the process; every use of
Redis in the runtime goes to a local store instead. `--redisUrl` with
`--store local` is a startup error (exit 2, "choose one"). The local store
lives under `--storePath` (default `<moduleDataPath>/../store/`, so the
launcher's home holds it), as plain files written by temp-file-and-rename,
pure JavaScript, no native module.

What the runtime keeps in Redis today, and what replaces each in `local`:

| Use today | File / module | Replacement in `local` |
|---|---|---|
| Metering: balances, free-call counts, `recordCall`, `checkBalance`, `rateLimit` | `lib/metering/redis-provider.js` (`MeteringProvider` interface: three methods) | `lib/metering/local-provider.js`: the same interface over an in-memory map, persisted to `<storePath>/metering.json` on change (debounced, atomic). `recordCall` counts; `checkBalance` and `rateLimit` never refuse unless `--meter` is given (section 4): one user has no balance to run out of and no neighbour to be limited for. With `--meter`, the semantics are today's: the demo key unlimited, a configured key's balance decrementing, per-key sliding windows in memory. |
| Module store `ctx.redis` (db 5, 23 allowed commands, `lib/redis-api.js`) | `lib/redis-api.js`, `lib/supported-redis-commands.json` | `lib/local-kv.js`: the same 23 commands over an in-memory map with Redis semantics for strings, hashes, lists, sets, expiry (the subset the allowlist names), persisted to `<storePath>/kv.json` on a timer and at shutdown. Modules see no difference in the API. |
| Jobs: `/add-job`, job processor, schedulers, MCP `tasks/*` | `lib/job-control.js` (BullMQ Queue, Worker, QueueEvents) | `lib/job-control-local.js`: the same surface `job-control.js` exposes to the rest of the runtime (add, get, result, list, cancel, schedulers, the completion hook), run in-process by one worker loop with the same per-job timeout; state in memory, results kept until read or for `--jobResultTtl`; not persisted across restarts, said in the docs and in `tasks/get` for a job from a previous process ("not found"). |
| API log to Redis (`--apiMonitor`) | `lib/session.js`, `lib/logger-stream-redis.js` | Already retired by the logger work; in `local` it is simply absent. |
| The always-denied Redis endpoint for modules (R2-1) | `lib/module-sandbox-config.js` `deniedEndpoints` | No endpoint to deny; the list is empty in `local`. |
| `lib/redis-resilient.js`, `countinghouse-interface.js` db 9, `countinghouse-util.js` db 10 | internal clients | Not created in `local`; the code that used them calls the local provider / kv instead through one selection point: `lib/store.js` `createStore(options) -> {metering, kv, jobs}` returning either the Redis-backed objects or the local ones, so no other file branches on the mode. |

The selection point is the design's one structural change: today each file
creates its own client; after LM1 each takes what `createStore` gives it.
The Redis implementations are moved behind that interface unchanged.

### 2. stdio transport: `--stdio`

The gateway's JSON-RPC dispatcher (`lib/mcp/gateway.js` `handle(req,
cdifInterface, appKey, callback)`) is transport-independent; the HTTP route
layer parses bodies, handles batches and writes responses. `--stdio` adds a
second route layer: newline-delimited JSON-RPC on stdin, responses on stdout,
one line each, batches handled as the HTTP layer does (one `handle` per
entry), notifications answered with nothing. The key is the one `--stdio`
implies: the process's own in-memory key (section 4) or
`COUNTINGHOUSE_API_KEY`, so no client header is needed; the launcher is the
only client. `--stdio` and
`--port` are exclusive. All logging goes to stderr (stdout is the transport;
the logger already separates them, this verifies it). The process exits when
stdin closes, after draining in-flight calls (bounded by the device timeout).

### 3. Scenario loading: roles, parts, listing

`package.json` `countinghouse.role`: `"scenario"` or `"part"`; absent means
listed, as every module is today. `--loadModule <dir>` loads the module; when
it is a scenario, the loader also loads every module named in its
`countinghouse.calls` (the module name before the slash), resolved from the
scenario's `node_modules` (by `require.resolve('<name>/package.json', {paths:
[dir]})`), recursively for parts that declare calls, each once, with
`listed: false` for parts. The device manager keeps `listed` per module;
`lib/mcp/tool-registry.js` `buildToolTargets` skips unlisted modules, and the
gateway refuses a `tools/call` or an `invoke-action` for an unlisted module
from outside the process with `MODULE_NOT_LISTED` (the in-process hop path is
unaffected). A module loaded with `--loadModule` whose role is `part` is
loaded listed: `false` only when a scenario pulled it in; loaded directly it
behaves as today (listed), so parts can be exercised alone in tests.

The auth binding: in `--store local` without `--authConfigPath`, the runtime
generates the key and, for each loaded scenario, a `runsModules` binding for
it and its parts under one local identity, all in memory (section 4), so
`ctx.call` is authorised without the user editing anything. With
`--authConfigPath`, the file is honoured as today and never changed.

Missing part or credential: the scenario is not loaded, the log names the
part or the variable, and the scenario's tools are absent. Other modules
load normally.

### 4. One user: the single-identity profile (maintainer, 2026-11-11)

A client machine has one user, who uses every tool the process hosts. The
multi-tenant code path stays: the same access check, the same per-key tool
listing, the same metering interface, the same opaque caller id, so a module
behaves identically here and on a hosted runtime, and there is one auth path
to secure, not two. What changes is what that path is fed and what it
writes:

- **No auth file.** `--store local --stdio` without `--authConfigPath`
  keeps the generated key and the scenario bindings in memory, per process.
  Nothing is written, nothing is left on disk for a module to read, nothing
  for the user to edit. The demo-key file of today's zero-config start is
  not written in this profile.
- **No balance gate.** The local metering provider records every call for
  the usage records and the receipt but never refuses one for balance or
  rate. `--meter` restores today's balances and limits for an operator
  testing a hosted configuration locally.
- **A stable caller id.** `ctx.caller.id` is derived as R2-1 says, from an
  identity secret kept per install at `<storePath>/.identity-secret` (mode
  0600, outside every module's namespace), so a module's per-user data
  survives restarts and the id is the same across the user's packs. The
  in-memory key changes per process; the id does not, because the secret
  and the fixed source string `local` are its inputs, not the key.
- **Only the pack's tools and the usage report are listed.** In this profile
  `tools/list` holds the scenario's tools and `countinghouse_usage_report`;
  `countinghouse_check_balance` (no balance exists), the admin lookup and
  the authoring tools are not listed and answer `MODULE_NOT_LISTED`-style
  refusals if called by name. To the agent the launcher's runtime is one
  server with the pack's tool and the report.
- **No tenant vocabulary reaches the user.** Over `--stdio`, no log line,
  error text or tool result mentions a key, a balance, a free-call count or
  a rate limit: the user set none. The error catalogue's balance and
  rate-limit codes cannot be produced in this profile, so nothing is
  reworded; the start-up banner and the per-call log lines name the pack
  and the tool only.

Hosting is untouched: `--store redis` has no profile, and an operator who
runs `--store local --port` with an auth file gets today's multi-key
behaviour over HTTP with a local store.

### 5. Boundary counters and usage records

Two counting points, both on the main thread:

- **In**: recorded by the remote client (RC1, built by A after this spec)
  through `lib/usage.js` `recordIn(call, {server, tool, bytes, lines, ms,
  outcome, credential})`; this spec builds `lib/usage.js`, the `Out` hook,
  the files and the receipt, tested with a stub remote that calls
  `recordIn`; RC1 wires the real client to it. For every call to a declared server:
  bytes of the result's text content (UTF-8), lines (newline-separated,
  JSON included), the server name, the tool, the duration, the outcome, the
  name of the environment variable the credential came from.
- **Out**: in the gateway, for every `tools/call` result of a listed module:
  bytes and lines of the text content after the module's output validation,
  per tool.

Records are appended, one JSON object per line, to
`<usageDir>/<YYYY-MM-DD>/<pid>-<startMs>.jsonl` (`--usageDir`, default
`<storePath>/usage/`), written as they happen with `fs.appendFileSync` on an
open descriptor; a crash loses at most the line being written. Fields:
`{t, call, pack, tool, server, bytesIn, linesIn, bytesOut, linesOut, ms,
outcome, credential}`; a server call has `server` and the `In` fields; a
tool result has `tool` and the `Out` fields; `pack` is the scenario's
friendlyName; `call` is a per-process counter that ties the `In` records of
one `tools/call` to its `Out` record. There is no session field: MCP
2026-07-28 is stateless and the runtime issues no session id; the file
name (`<pid>-<startMs>`) identifies the process, which over stdio is the
client session. No value of any credential, no content, ever.

**`countinghouse_usage_report`, a built-in tool (maintainer, 2026-11-11: "default
installed with countinghouse and reachable from the agent, so the user can
get token usage and the traffic of each module in real time, aligned with
countinghouse's metering").** The usage report is the runtime's own tool,
not a module: it lives beside `countinghouse_check_balance` in
`lib/mcp/tool-registry.js`, is listed to every key in every mode, needs no
install and no declaration, and reads what only the runtime can read
safely: the current process's counters (section 5's `In` and `Out`,
in memory, so a call made a second ago is already counted), the usage
files under `--usageDir` when there are any, and the metering provider's
per-key counts in `--store redis`. Input: `{since?: <ISO date or
duration>, groupBy?: "tool" | "server" | "pack" | "module"}`. Output
(schema-closed): per group, `calls`, `serverCalls`, `bytesIn`, `linesIn`,
`bytesOut`, `linesOut`, `tokensInEst`, `tokensOutEst` (estimated from
bytes, the method named in a `method` field), the window, and `source:
["memory", "files", "metering"]` saying where the numbers came from; never
a credential value, never content. **Scoping:** a key sees its own calls;
an admin key sees every key, grouped by the opaque caller id, never by
user name or key (R2-1). The same report is a CLI subcommand,
`countinghouse-usage`, for the operator's shell. The aggregation and
formatting code is the one `ch-report` was built with (its lib/aggregate.js,
format.js, read.js and the usage-fixture writer), moved into `lib/usage/`
of the runtime with its tests; **`ch-report` as a separate package is
retired** (maintainer, 2026-11-11: under the client-pack deployment the
runtime's own tool is what the agent reaches, so a second reader on the
same machine has no job): its repository is archived once this tool is
merged, and the npm name is not published. Consequently there is no
`/usage` root and no `reads: ["usage"]` declaration for modules: no
third-party module reads the records, and the `countinghouse_usage_report` tool the
packs list is this one, not a module (ch-packs plan Tasks 10 and 13 change
accordingly).

**The receipt**: for every `tools/call` on a scenario tool, the gateway sums
the `In` records made during that call (the remote client tags each with
the call id) and appends to the result `receipt: {calls, linesIn, bytesIn,
linesOut, bytesOut, servers: [name]}` and one sentence in the text content:
`read 48,210 lines (3.1 MB) in 14 calls to github; 35 lines (2.4 KB) reached
the model.` (several servers: `… in 14 calls to github and 2 to linear …`).
The word "saved" never appears; the scenario's own `coverage` field carries
pack-specific units. The receipt is added by the runtime; a module cannot
set it (an output field named `receipt` is refused by the output validation
with `RECEIPT_RESERVED`). In `--store redis` the counters and the receipt
run the same way; the usage files are written only when `--usageDir` is
given (hosting operators opt in).

### 6. Node floor

Local mode's floor is the runtime's: 22.16 with the resolve shim (its own
spec, `2026-11-11-node-floor-shim-design.md`), to be merged first.

### 7. What stays the same

Worker mode, the sandbox (`enforce` for every pack module), the fs broker,
the always-denied set (minus the Redis endpoint in `local`), the error
codes, the MCP surface for listed modules, `countinghouse-validate`.

## Security and privacy

- `--store local` opens no socket of its own; `--stdio` opens none at all.
- The local store's files hold counters and the modules' own `ctx.redis`
  data (balances only under `--meter`): nothing the runtime did not already
  hold in Redis. The usage files hold counts and names, never content or
  credential values.
- The store path sits outside every module's namespace (the broker's rule
  for the launcher's home applies: `<moduleDataPath>/../`).
- In the single-identity profile no auth file exists, so the always-denied
  set has one file fewer to guard; the identity secret under `<storePath>`
  stays in it.
- The key is never printed, logged or written when `--stdio` is the
  transport; it exists only in the process's memory.

## Tests (the plan writes them; the spec names what must hold)

- The three `MeteringProvider` methods on the local provider: the Redis
  provider's existing tests run against both through the interface.
- `ctx.redis` over `local-kv`: the 23 commands' semantics against fixtures
  recorded from Redis.
- Jobs in local mode: add, progress, result, cancel, timeout, a scheduler;
  `tasks/*` over stdio.
- stdio: initialize, tools/list, tools/call, a batch, a notification, stdin
  close drains and exits 0; stdout holds only JSON-RPC lines while the
  logger writes to stderr.
- Loading: a scenario with two parts lists one tool; a part loaded alone is
  listed; a scenario with a missing part does not load and names it; a
  direct `tools/call` to a part is refused `MODULE_NOT_LISTED`.
- Counters: a scenario making N remote calls produces N `In` records and one
  `Out` record with exact byte and line counts matching the fixtures, and a
  receipt sentence matching the regex; a module output with a `receipt`
  field is refused.
- `countinghouse_usage_report`: listed to a plain key in `--store local` and in `--store
  redis` with no option; a call made in the same process is in the next
  report (memory source); records from an earlier process are in it (files
  source); a plain key's report holds only its own calls while an admin
  key's holds every caller grouped by opaque id, with no user name or key
  anywhere in the output; the token columns carry `method`; the output
  validates against its closed schema; `countinghouse-usage` prints the
  same numbers for the same window.
- Single-identity profile: a `--store local --stdio` start without
  `--authConfigPath` writes no auth file and no key anywhere under
  `<storePath>` or `<moduleDataPath>`; a scenario tool called more times
  than any free-call count is never refused; with `--meter` and a configured
  key, the balance decrements as on Redis; `ctx.caller.id` is identical
  across two process starts and differs after the identity secret is
  replaced; the stderr output and every error text produced over stdio by
  the profile's own refusals (missing part, missing credential,
  `MODULE_NOT_LISTED`, output validation) contain none of the words key,
  balance, free call, rate limit.
- The whole suite on `--store redis` unchanged (no behaviour change).
- CI: a local-mode smoke test (stdio, one scenario, no Redis service) on
  ubuntu, macos and windows runners; the Redis-backed suites stay on Linux.

## Sequencing and ownership (maintainer, 2026-11-11 evening: "distribute work evenly among the three workers")

Three implementers build LM1 in parallel, split by the files each owns so
their PRs rarely meet; each writes the plan for its own part from this
spec, one PR per step, CI as the gate, the reviewer merging.

- **B (store and identity):** the store selection point with the Redis
  implementations behind it (no behaviour change, whole suite green) →
  local metering provider with `--meter` → local kv → the single-identity
  auth binding in memory (section 4's key and `runsModules`, the identity
  secret under `<storePath>`) → local job runner. Files: `lib/store.js`,
  `lib/metering/`, `lib/local-kv.js`, `lib/redis-api.js`, `lib/job-control*.js`,
  `lib/auth/`.
- **C (transport, loading, usage):** the `--stdio` route layer over the
  gateway's `handle()` → roles, scenario and part loading, `MODULE_NOT_LISTED`,
  the profile's tool listing (section 4) → boundary counters, usage files,
  the receipt, `countinghouse_usage_report` and `countinghouse-usage`
  (`lib/usage/`, from ch-report's code) → Windows gap catalogue with issue
  #40. Files: `lib/mcp/stdio.js` (new), `lib/mcp/tool-registry.js`,
  `lib/mcp/gateway.js` (receipt and the Out counter only), `lib/usage/`
  (new), the loader paths in `lib/module-manager.js` and
  `lib/device-manager.js`, `bin/countinghouse-usage.js`.
- **A (remote client and the floor):** RC1-min first (its own spec), which
  calls `lib/usage.js` `recordIn` through the interface C builds (a stub
  until then) → the Node floor shim (its own spec; the resolve-hook work
  sits in the sandbox A already owns) → multi-server and HTTP remotes.
  Files: `lib/remote/` (new), `lib/handler-ctx.js` (the `remote:` route),
  `lib/module-lockdown.js`, `lib/node-version.js`, the resolve shim.

Interfaces between them, fixed here so no one waits: `createStore(options)
-> {metering, kv, jobs}` (B) consumed by C's counters only through the
metering provider's `recordCall`; `usage.recordIn(call, {...})` and
`usage.recordOut(...)` (C) called by A's client and the gateway; the
single-identity key (B) read by C's stdio layer through the existing
options object, never a new global. Docs (README, CLI reference,
security-model's `local` column, deployment.md) close each part, written
by its owner.

## Left to the builder

- The debounce and flush intervals for the local store's files.
- The exact in-memory structures for the kv commands.
- Whether `tasks/*` in local mode share the job runner's worker loop or get
  a second one (one is enough).
