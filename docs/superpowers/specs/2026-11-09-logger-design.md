# Logging and errors: structured records, one writer, structured errors

Status: Approved by the user 2026-11-10 (design only; landing per §9: step 1
may start now, step 2 after R2-1 Task 4, step 3 after R2-1). Amended
2026-11-10 during step 1 (d2): §5.1's plain-Error rule (its list of
foreign codes widened after review), `details.cause` and the worker
crossing, composition hops included; §5.2's client shapes (the user: no client shape is
preserved); §5.6, a fault that fails its schema is delivered and logged (the
user). Amended 2026-11-10 during step 1: §5.1's ctx.error paragraph (the user: a handler
may return its error; how a module error renders) and §5.3's statuses line. Written 2026-11-09 by implementer B with the reviewer
(countinghouse-a5), who holds the user's decisions. The user's decisions are
roadmap-p1-p2.md, P1, items 1–11 (cited as "item N"). Calls that are the
reviewer's or mine are marked. Section 12 lists what the user is asked to
confirm.

## 1. Why

This month's work kept asking the logs questions they couldn't answer
(the reviewer's record, with what got in the way):

1. Two implementers' servers shared one Redis, and a job ran on the wrong one.
   Only timestamps told whose process wrote a line.
2. A CI failure in a 25-minute log: mocha text with server lines interleaved,
   no structure. The first real error was found by grepping for "failing" and
   reading backwards.
3. A test counted live workers by counting "spawn walk" against "settled"
   lines: wording, which item 10 bans, because no field or route said it.
4. An API key in a log line (54a43c5), and a whole config file quoted in an
   error (3d96287): no redaction, no size bound.
5. Every `LOG` call threw before `createLogger` ran (composition/05).
6. Suite logs ran to tens of MB: one sandbox audit line per file access.
7. A broker timeout under load said "ETIMEDOUT" with no duration or limit;
   either would have said "load" at once.
8. During the reload fixes, callers saw `DEVICE_NOT_FOUND` while the log said
   nothing about which lifecycle step the module was in.

And the errors behind the lines are no better (the user: "inherited from
cdif, not satisfied"; facts at `491064a`, `lib/countinghouse-error.js`):
`CHError.prototype = new Error`, so `err.stack` is the load-time stack of the
prototype; there is no `name`; `CHError` and `DeviceError` differ only by
`topic`; the message is built at construction by concatenating the arguments
into the current locale's string, so structure is lost and a key can ride in
as an argument (`user-auth.js:61` passes the appKey to
`SYSTEM_ERROR_UNKNOWN_USER`); the catalogue is two JSON files (123 codes each)
kept in sync by hand, and a missing locale falls back to **zh-CN**; 154
`new CHError`, 60 `new DeviceError` and 118 plain `new Error` sites in `lib/`
leave callers unable to classify an error; job-control encodes "CODE:
message" into a string because bullmq persists only the message.

## 2. The readers, and what "it worked" means

Three readers matter equally (item 1):

- **The developer:** readable output, a level to turn up or down, quiet tests.
- **The operator:** searchable fields: module, tool, tenant, call/job id, and
  which process.
- **The module author:** `ctx.log` output that is visible and attributed.

"It worked" means each of the eight moments above is answered by a field or
an event, without reading wording.

**What must never happen** (in order; 1–5 are the user's, through the
reviewer; 6 and 7 are the reviewer's inference from the user's priorities, not
the user's words):

1. A key, a secret or a user name where it shouldn't be, in any log line,
   error text, or anything a module receives. Absolute. The design keeps them
   out of `msg` and `details` by construction; redaction is a backstop.
2. Losing the stack of an uncaught exception.
3. A module's bug taking the server down.
4. Anything a client sees changing by accident: error codes, HTTP statuses,
   MCP `_meta` codes, the tools/list surface.
5. Dropping Chinese: zh-CN messages stay; en-US is the default and the
   fallback.
6. Logging that costs performance on the hot path.
7. Module authors who can't find their logs, and a pretty mode that isn't
   readable.

## 3. The record

One JSON object per line (the record shape is the reviewer-accepted proposal
of mine):

| Field | Meaning |
|---|---|
| `t` | time, ISO 8601 with milliseconds |
| `level` | `error`, `warn`, `info` or `debug` |
| `event` | a dotted name from the registry (Appendix A), e.g. `worker.spawn`, `module.reload.step`, `broker.deadline`, `job.failed`. The stable thing tests and operators match on. |
| `msg` | a short en-US sentence for people |
| `instance` | `host:pid:bootid` (bootid: 6 random hex chars per process start), so two servers on one Redis are told apart (moment 1) |
| `thread` | `main`, `worker:<id>` or `file:<n>` |
| `source` | `main`, `file` or `worker`, set by main: who wrote the record. A main-source record is what main itself observed or decided; a file-source record comes from a countinghouse file thread (speed-up proposal 5), which is countinghouse code and trusted like main; a worker-source record is what a module worker sent (section 6.1). In single-thread mode module code runs on main and can write main-source records; documented, as that mode has no sandbox. |
| `module` | `name@version`, when the record concerns one |
| `tool`, `call`, `job` | the tool name, a per-call id, a job id, when known |
| `caller` | the tenant: R2-1's opaque id, from `identity.idForKey(session.appKey)` (main only; this series lands after R2-1 Task 1, section 9). The user name is an admin lookup away (`identity.lookup`), never in the record (the reviewer's call: logs are not where names live). Never a key. |
| `durationMs`, `limitMs` | where a deadline or a duration is involved (moment 7) |
| `err` | a serialised error (section 5): `{code, kind, message, details, cause, stack}`; a Node fs error keeps its own `code` (`ENOENT`…) |
| `worker` | the fields a worker sent, nested and marked worker-asserted (item 7) |

- **Bounded.** A record is at most 8 KB. A longer value is cut with
  `…(N bytes)`. `err.details` is cut field by field; `code` and `kind` are
  never cut.
- **No secrets, in three layers** (the reviewer's correction: keys in
  auth.json are free-form, `aabbcc`, `alice-key-<hex>`, `demo`, so there is no
  "key shape" to detect):
  1. **By construction, the guarantee.** `msg` is a fixed sentence per event
     plus formatted fields; nothing interpolates a key. `details` takes only
     field names from an allowlist (section 5.1).
  2. **The field-name backstop.** Values of known secret field names
     (`apiKey`, `appKey`, `key`, `secret`, `token`, `password`,
     `authorization`, `cookie`) are replaced with `[redacted]` wherever they
     appear.
  3. **An exact-match pass, on warn and error records only.** Main compares
     every string value against the keys it knows and replaces a match with
     `[redacted]`. The file provider knows all of them; sqlite and CouchDB
     know the ones seen since start, cached. Info records skip this pass for
     the hot-path budget. That's safe because an info record's `msg` and
     `details` can't carry a key by construction (layer 1).
  The required "no key in any record of a full run" test (section 7) is what
  proves layer 1.
- **Levels and format.** `--logLevel error|warn|info|debug` (default info).
  `--logFormat json|pretty`: pretty when stdout is a TTY, json otherwise.
  `--logStream`, which does nothing today, becomes a deprecated alias that
  warns once.

**Pretty mode** (one line per record; colour only on a TTY):

```
22:14:05.103 INFO  worker.spawn        echo-device@1.0.0  worker:3  spawn walk done in 41 ms
22:14:05.420 INFO  module.reload.step  echo-device@1.0.0  step=discovery  (1/3)
22:14:07.988 WARN  broker.deadline     repo-review@2.1.0  worker:5  stat /data/x  1 2004 ms of 30 000 ms
22:14:08.001 ERROR job.failed          composite-demo@1.0.0  job=118  DEVICE_NOT_FOUND  (caller u_7f3a…)
                   at DeviceManager.ensureDeviceState (lib/device-manager.js:312:15)
                   at …
22:14:09.330 INFO  module.log          log-triage@1.0.0  [warn] "3 files skipped: unreadable"
```

## 4. Destinations

The reviewer's call, unless the user overrules it:

- **stdout, always:** one ordered stream, with errors on the same stream as
  everything else, not split to stderr. That is what journald, `docker logs`
  and Kubernetes collect. In pretty mode on a TTY it is still stdout.
- **`--logFile <path>`, optional:** for the single-box or edge operator with
  none of those collectors. The file is opened in append mode with mode
  0600, and reopened on SIGHUP, so logrotate works. It never holds anything
  the stdout stream wouldn't (the same records, the same redaction).
- **No syslog in the first version.** An operator who wants it pipes stdout
  or uses the collector.

## 5. Errors (steps 1 and 3 of the series)

The reviewer's suggestions, for the user to confirm (section 12).

### 5.1 One error class, and no other

`class CountinghouseError extends Error`, in `lib/countinghouse-error.js`.
**`CHError` and `DeviceError` are dropped entirely** (the user: there are no
module authors yet, so no backward compatibility is owed). No aliases, and no
globals: `lib/sandbox.js` and `framework.js` stop installing them, which is
also lockdown hygiene. The class has:

- `name` (`'CountinghouseError'`), a real stack (`Error.captureStackTrace`);
- `code`: a catalogue key;
- `message`: free text, optional;
- `details`: a structured object whose field names are on an allowlist
  (`module`, `tool`, `deviceID`, `serviceID`, `actionName`, `jobID`, `path`
  (virtual), `hostPath` (operator-kind errors only), `limit`, `elapsedMs`,
  `field`, `expected`, `got`, …; the list lives with the catalogue). Never a
  key: a key is not an allowed field, and the redaction pass runs on
  `details` too;
- the standard `cause`;
- two axes, **neither chosen at the throw site**:
  - `kind` (`caller` | `module` | `operator` | `runtime`: who should act)
    comes from the catalogue entry for the code, with the HTTP status and the
    MCP code;
  - `origin` (`runtime` | `module`: who threw it) is set at the boundary
    where the error leaves a module (`err.origin`; a log record's top-level
    `source` says who wrote the record, section 3).
  **Every code a module raises is the module's** (the user's decision:
  modules define only their own codes and never raise countinghouse's
  predefined ones). It has `kind: 'module'` and no runtime semantics, even
  when it equals a catalogue name (5.3);
- `retryable`, from the catalogue entry.

**Module-facing API.** `ctx.error(code, message?, details?)` returns an
instance with `origin: 'module'`, whose code is one of the module's own; it
never throws. A handler hands it back in any of three equivalent ways (the
user prefers the first): **returning it** as the handler's result, from a
plain function or an async one (`return ctx.error('REPO_TOO_LARGE', …)`);
throwing or rejecting with it; or `callback(err)`. All three give the same
answer, with the module's code. Only a `CountinghouseError` counts: a
returned plain object that looks like an error is a result. A module error
renders `CODE: message` (the bare code when there is no message): a
module's code has no catalogue text, and rendering it the old way would
drop the module's message. A
plain `Error` whose `.code` is a module's code is accepted the same way, so
authors who prefer plain errors (or a helper without `ctx`) can use them: the
code counts when it matches `/^[A-Z][A-Z0-9_]{2,}$/` and is neither a system
error's (the error has `errno` or `syscall`) nor someone else's, a named
list (`CountinghouseError.isForeignCode`, which `countinghouse-validate`
will read too, step 1 (e)): Node's own (the `ERR_` prefix,
`MODULE_NOT_FOUND`, `ABORT_ERR`, and llhttp's `HPE_` prefix); every errno
name (`os.constants.errno`: a network failure such as Node's 'socket hang
up' carries `ECONNRESET` with no `errno`); undici's `UND_ERR_` prefix; and
the X509 verify codes Node puts on a TLS error, as an exact list
(`CountinghouseError.X509_VERIFY_CODES`: the 27 OpenSSL names Node v24's
`lib/_tls_wrap.js` lists and `src/crypto/crypto_common.cc` maps, plus
`HOSTNAME_MISMATCH`), not prefixes, so a module's own `UNABLE_TO_PARSE`
stays its own; test/validation/05 pins it, to re-check when the Node floor
moves (amended 2026-11-10, the reviewer: the
crash-versus-rejection signal is worth more than a module's freedom to
name its own code `ECONNRESET`; a module raises such a code with
`ctx.error`, and step 1's validator warning makes the cost visible); anything else is
untyped (`DEVICE_INVOKE_FAIL` reported, `DEVICE_INVOKE_EXCEPTION` thrown, a
synchronous throw counted as a throw). `details.cause` is reserved for the
underlying error; it is kept off every serialised form. A module's error
crosses the worker reply whole (code, message, details), so worker mode
answers it as single-thread mode does (step 1 (d2)). A runtime error a module
rethrows unchanged (from `ctx.call`, say) passes through and keeps
`origin: 'runtime'`; one it wraps with `ctx.error` is the module's, with the
original in `cause`. Rendering to the caller stays as today (the code's text, then ": ",
then the message) until each area's edge-rendering commit (section 9,
step 3). A module's `details` is module-authored content: it's marked
module-asserted in records and goes through the redaction pass like
everything else.

**Pre-8.0 modules.** `countinghouse-validate` reports a module that
references `DeviceError` or `CHError` as pre-8.0: an error, naming the fix
(`ctx.error(code, message)`). The upgrade guide shows the before and after.

### 5.2 Rendering at the edge

A message is rendered where it leaves: the HTTP or MCP response, or a log
line. It's built from the code and the details through the catalogue. A
response, a module's `err.message` and a rebuilt `failedReason` use the
server's `--locale`, as today (no request locale exists); a log record's
`msg` is en-US, and the record keeps `code` and `details` structured, so a
reader can render it in any locale. Nothing is rendered at construction.

#### Client shapes

*Amended 2026-11-10 (the user: "there is no user yet, go ahead, no need to
preserve the current client response shape"; the direction approved, the
details for the user's glance).* These are the targets the edge-rendering
commits (section 9, step 3) build; until then the answers are what the
error-shape golden (`test/mcp-contract/error-shape.golden.json`) records.
Step 1 (d2) already dropped `topic` from every answer, so an HTTP error
body is `{code, message, fault?}` in the meantime.

- **HTTP error body:** `{code, kind, origin, message, details?, fault?}`,
  with the status from the catalogue entry (the table below). A module's
  own error (origin `module`) is 500, with the module's code.
- **MCP `tools/call` error:** an `isError` result, as today, with
  `_meta["countinghouse/code"]`, `_meta["countinghouse/kind"]`,
  `_meta["countinghouse/origin"]` and `_meta["countinghouse/fault"]`, and
  the text content `CODE: message`.
- **JSON-RPC errors on the auth path:** `-32603` and `-32602` stay, with
  `data: {code, kind}` added.
- **Job failures** (`tasks/get`'s `statusMessage`, the job routes): the same
  `{code, kind, origin, message}` object, not a `"CODE: message"` string.
  (Until then a module error's `statusMessage` reads `CODE: CODE: message`:
  the job worker prefixes the code to a message that already starts with it.)

The catalogue's `httpStatus` and `mcpCode` columns get these values in the
same commits (they record today's behaviour until then, and
test/mcp-contract/07 checks the golden against them). The mapping, by kind
first, then the named exceptions; the per-code choices marked (B) are the
implementer's, for review:

| status | codes |
| --- | --- |
| 400 | caller-kind bad input: `ARGUMENTS_INVALID`, `INPUT_DATA_VALIDATION_FAIL`, `INPUT_NOT_FOUND`, `INVALID_BSON_REQUEST`, `INVALID_JSON_POINTER`, `INVALID_REDIRECT_URL`, `INVALID_MODULE_PATH`, `DEVICE_ID_INVALID_OR_NULL`, `MODULE_NAME_INVALID`, `MODULE_NAME_MISMATCH`; and the route manager's `REQUEST_INVALID` |
| 401 | no key or an unknown key: `SYSTEM_ERROR_UNKNOWN_USER` |
| 403 | a known caller without the right: `ADMIN_REQUIRED`, `DENY_DEVICE_ACCESS`, `USER_HAS_NO_DEVICE`, `PEER_NOT_GRANTED`, `JOB_ACCESS_DENIED`; and `HOST_NOT_ALLOWED` |
| 404 | a missing device or tool: `DEVICE_NOT_FOUND`, `SERVICE_NOT_FOUND`, `ACTION_NOT_FOUND`, `SERVICEID_NOT_AVAILABLE`, `ACTIONNAME_NOT_AVAILABLE` (B), `IDENTITY_NOT_FOUND` (B) |
| 413 | `REQUEST_TOO_LARGE` (as today) |
| 429 | `RATE_LIMIT_EXCEEDED` |
| 503 | operator-kind outages: `SYSTEM_ERROR_USERDB_NA`, `MODULE_SUSPENDED`, `MODULE_UNLOADED` (B); and the retryable runtime codes, which are transient by definition (B): `DEVICE_IN_ACTION`, `DEVICE_NOT_CONNECTED`, `DEVICE_OFFLINE`, `DEVICE_NOT_RESPONDING`, `REDIS_CLIENT_ERROR`, `PEER_GONE`, `PEER_CHANNEL_TIMEOUT`, `CTX_CALL_NOT_READY`, `MODULE_RESTARTING`, `MODULE_RELOADING` |
| 500 | everything else: every module-kind code (the runtime's codes for a module's fault, `DEVICE_INVOKE_EXCEPTION` and `RATE_LIMITED` among them), the remaining runtime-kind and operator-kind codes, and every module's own code |

`mcpCode` stays `null` for every code answered as a tool result (all of
them on `tools/call` today). It is `-32603` for the codes the auth path
answers as a JSON-RPC error (`SYSTEM_ERROR_UNKNOWN_USER`,
`USER_HAS_NO_DEVICE`, `SYSTEM_ERROR_USERDB_NA`), and an unknown tool keeps
`-32602`; that answer has no catalogue code yet, and the MCP commit adds
one (`TOOL_NOT_FOUND`, kind caller, 404) so `data.code` can name it (B).
`REQUEST_INVALID`, `REQUEST_TOO_LARGE` and `HOST_NOT_ALLOWED`, which the
route manager answers today without a catalogue entry, join the catalogue
in the HTTP commit.

### 5.3 One catalogue

One table replaces `error-info.en-US.json` and `error-info.zh-CN.json`:
code → `{en, zh, kind, retryable, httpStatus, mcpCode}`. Until step 3
renders from it, `httpStatus` and `mcpCode` record today's behaviour, which
the request's path chooses, not the code: every error on the device routes
answers 500 and a few routes answer their own (403, 429); an MCP tool's
error is a tool result, so `mcpCode` is null, and the JSON-RPC codes stay
chosen by the path (an auth failure on `tools/call` is `-32603`, without the
code). Moving caller-kind codes to 4xx, and giving MCP clients the code of
an auth failure, are possible later changes for the user, not this series.
The catalogue is
runtime-only: modules never raise its codes. The default locale is
en-US, and a missing locale or a missing translation falls back to en-US,
fixing today's zh-CN fallback. A test, like sandbox/05's built-in check,
proves that every code thrown in `lib/` exists in the table and every entry
is used. It covers `lib/` only, since a module's codes are its own (section
5.1).

**Modules and the catalogue** (the user's decision; the user asked where a
module author finds the predefined codes). Modules define only their own
codes and never raise the catalogue's. The rule, stated in
docs/module-development.md:

- A module's codes are its own UPPER_SNAKE_CASE strings, documented in the
  module's README as part of its contract, and passed to callers unchanged.
- Every module-origin error has `kind: 'module'`.
- A module code that equals a catalogue name is still the module's (kind
  module, no runtime semantics). `countinghouse-validate` warns about the
  collision, so the author picks another name.
- **Input validation is the runtime's job.** `ARGUMENTS_INVALID` stays
  runtime-only: the runtime validates input against the action's schema
  before the handler runs. A handler that rejects input on grounds the
  schema can't express uses its own code (for example `INPUT_REJECTED`).
  The bundled modules and examples that raise `ARGUMENTS_INVALID` themselves
  today move to their own code in step 1, and the countinghouse-module
  skill's example changes with them.

**`docs/errors.md` is generated from the catalogue** by a script in `bin/`,
with a test that fails when the committed doc is stale. It lists every code
with its kind, HTTP status, MCP code and English text, for operators and
clients. docs/module-development.md links to it, and states the module rule
above. Implementer A's `IDENTITY_NOT_FOUND` (R2-1) is added by A; this
series adds its codes elsewhere in the table, and the second to land
rebases.

### 5.4 Crossing boundaries

- **Worker → main:** an error travels as an explicit shape,
  `{code, message, details, stack}`, and main sets `origin` (`module` when a
  module's handler threw it or returned it, `runtime` otherwise) and `kind`
  (from the catalogue, or `module` for a code it doesn't know) as it
  rehydrates it into a
  `CountinghouseError` on main; `postMessage` drops class identity. Following
  the rule recorded for this codebase ("never add fields to a cross-worker
  reply's `data`; use an extra callback argument"), the error rides in its own
  field of the message, never inside `data`.
- **bullmq:** a failed job's stored `failedReason` becomes JSON
  `{code, details}` instead of "CODE: message", and `job-control` parses both
  forms while jobs written by an older version may still be queued. Clients
  already see `failedReason` (the HTTP job routes, `job-control.js`, and MCP
  `tasks/get`'s `statusMessage`, `gateway.js`). Every client-facing reader
  rebuilds today's "CODE: message" from the JSON, so the bytes stay
  identical. The same holds for the job `stacktrace` the HTTP job routes
  return (`job-control.js`), whose first line today is
  `Error: CODE: message`: it is rebuilt the same way. A failure without a code
  (a timeout's plain `Error`, a module's `new Error('boom')`, bullmq's own
  stall reasons) is stored as `{code: null, message}`. That's the same text
  Redis holds today, so nothing new is exposed. Only someone reading bullmq's
  Redis directly sees the new form.
- **HTTP and MCP:** the error shapes get a `toJSON`. **Client-visible bytes
  stay identical** throughout the series (what-must-never-happen 4), in step 1
  trivially and in each step-3 commit that moves rendering to the edge: the same codes, HTTP
  statuses and `_meta["countinghouse/code"]`, proven by the existing contract
  and error-shape tests and the golden tools/list. Any deliberate change is
  listed separately for approval, never folded in.
- **The one approved exception** (what-must-never-happen 1 outranks 4; the
  user's standing rule "no key, user name or secret in any log line, error
  text, or anything a module receives"): `SYSTEM_ERROR_UNKNOWN_USER` stops
  naming the key (`user-auth.js:61`, `auth/file-provider.js:202`,
  `sqlite-provider.js:69/73`, the couchdb provider; `session.js:142` sends the
  message to the client), and `MODULE_INSTALL_FAIL` stops carrying a stack.
  This lands in **R2-1 Task 5** (implementer A), with a near-miss test, not
  in this series. No second implementation.

### 5.5 Logging an error

`log.error(event, {err})` serialises `code`, `kind`, `details`, the `cause`
chain (to depth 5) and the stack, redacted and bounded.

### 5.6 Module faults (amended 2026-11-10: the user's decision on a fault that fails its schema)

The question, from the user: does a tool call's error conform to the
action's `fault` schema? Today it doesn't, at three levels (at `491064a`):

- `fault` is a per-action pointer into `schema.json` (spec/schema.json;
  docs/module-development.md, the action's `fault`).
- It's **never validated**: `lib/service.js` passes a handler's
  `output.fault` through, under a TODO "validate the content of fault object
  according to its optional fault definition".
- It's **never delivered**: `toolCallResult` (`lib/mcp/gateway.js`) drops
  the data on error, so a fault never reaches an MCP client, and
  docs/module-development.md records that a callee's structured `.fault`
  reaches neither MCP nor worker-mode REST.

The design:

- **For an error with `origin: 'module'`, `details` is the fault.** When the
  action declares a `fault` schema, `details` is validated against it at the
  edge (service.js's TODO, done with the same ajv instance as input
  validation).
- **A fault that fails its own schema is still delivered** (the user,
  2026-11-10: "the error schema validation doesn't have to be strict: if a
  tool defines its error schema in schema.json and the runtime's validation
  fails against it, the fault should still be presented to the client").
  The caller gets the fault as the module gave it, through the 8 KB bound
  and the redaction pass like any `details`; nothing is substituted or
  dropped. The mismatch is recorded as `fault.invalid {module, tool, errors}`
  at warn (kind module), so the author sees it in the logs and the readback.
  There is no client-facing code for it: the catalogue gains no
  `FAULT_INVALID`.
- **No `fault` schema declared:** `details` is free-form, bounded by the
  8 KB rule, redacted, and module-asserted.
- **Runtime-origin errors** keep §5.1's allowlisted `details`; the fault
  schema never applies to them.
- **Delivery:**
  - MCP `tools/call`, and `tasks/result` the same:
    `_meta["countinghouse/fault"]` on the error result, next to
    `_meta["countinghouse/code"]`. Not in `structuredContent`, for the reason
    `gateway.js` already gives for the code: SDK clients validate
    `structuredContent` against the tool's output schema even on an error
    result.
  - REST `invoke-action`: the `fault` field, as single-thread mode returns it
    today, in worker mode too.
  - Across a composition hop: `.fault` on the error the composing module
    receives (docs/composite-tools.md), in worker mode too. That closes the
    gap docs/module-development.md records.
- **The tools/list surface is unchanged:** MCP has no error-schema field, so
  nothing new is advertised, and the golden stays byte-identical.
- **When it lands:** with the edge rendering of the paths it touches
  (section 9, step 3: the MCP and HTTP area, and lifecycle for the hop). It
  changes what a client sees on a module error that carries a fault, so it is
  one of the deliberate changes listed for approval (section 12).

## 6. The logger (steps 2 and 3)

### 6.1 One writer

- **Main writes every record** (item 7). Module workers and file threads send
  structured records over their existing message channel. Main adds
  `module`, `thread`, `instance` and `source: 'worker'` from the channel the
  record arrived on, never from fields the sender supplies; the sender's own
  fields go under `worker` and are marked worker-asserted.
- **Two sources.** Module code can reach its worker's message channel
  (`CHUtil.dm`, a documented gap), and countinghouse's own code in the worker
  (`service.js`, `device-manager.js`, module-lockdown's violation reports) sends
  on it too. So main can't tell them apart, and a worker-source record proves
  only which worker sent it. A worker-sent record's `event` must be on a
  short worker allowlist (`module.log`, `sandbox.violation`, `service.*`, and
  the worker's best-effort `worker.uncaught`); anything else is recorded as
  `worker.unknown_event` with the claimed name inside `worker`.
  Main-observed events (`worker.exit`, the `worker.uncaught` copy from the
  Worker `'error'` event, broker denials decided on main) are main-source.
  Tests match `{event, source}`. P2 relies on main-source records only.
- **Worker budget** (the numbers are mine): each worker has a token bucket of
  200 records/s with a burst of 1 000, and a separate 20/s reserved for
  error-level records, so a flood can't hide the error that explains it.
  Overflow is dropped and summarised once per 10 s as
  `log.dropped {module, counts: {error, warn, info, debug}}`. Log records are
  exempt from `--moduleMessageRate`, which they would otherwise use up
  (item 7).
- **No dependency** (item 6): about 150 lines in-house. JSON lines, levels,
  `child(fields)`, redaction, pretty mode, a buffer before init. pino was
  rejected: 11 runtime dependencies, and its transports run on thread-stream,
  a worker thread, which module-lockdown.js deliberately keeps away from
  modules.

### 6.2 Before init

A call before `createLogger` goes into a small buffer (1 000 records), which
is flushed at init. If the process exits first, the buffer goes to stderr as
JSON. **Logging never throws.**

### 6.3 Uncaught exceptions (items 2–5)

- **In a module worker** (item 3): the worker's handler sends its record
  best-effort (source worker) and the worker ends. Main logs the copy it
  receives from the Worker `'error'` event (source main); that is the
  guaranteed one, the one the docs tell operators to trust, and it must carry
  the stack. A test proves it survives on Node 24 and on Node 26. The supervisor
  restarts the worker; with the sandbox off the module stays
  `MODULE_UNLOADED` (documented). Exits that bypass in-worker handlers
  (`process.exit`, `ERR_WORKER_OUT_OF_MEMORY`, a limit kill through
  `terminate()`, a native crash) are logged by main with the reason it has.
- **On main** (item 4): one record is written synchronously
  (`fs.writeSync` to the stream's descriptor; if that write fails, the same
  record goes to stderr, so it can't fail silently), then the process exits
  70 (EX_SOFTWARE). There is no drain: after an uncaught exception the state
  is unknown. Unhandled rejections are treated the same (items 3 and 4).
- **What callers see when main exits:** an in-flight HTTP or MCP request has
  its connection closed without a response. Workers and file threads end
  with the process. A running bullmq job is left locked, and after the
  restart bullmq's stalled-job check hands it to the new server once the
  lock expires, so **a job can run twice after a crash.** Charging it once is
  M11's per-attempt idempotent billing (R2-1 Task 3, implementer A). M11 is a
  prerequisite of "billed once", not of shipping this: exit 70 ships in step 2,
  and until M11 lands the docs say that a crash can double-bill a running job.
- **Single-thread mode** (`--no-workerThread`): modules run on main, so a
  throw from a module's detached callback is main's uncaught exception and
  ends the process. Accepted for a mode that has no sandbox, and documented:
  "a module's crash ends the process; use worker mode in production".
- **The line between the two** (what-must-never-happen 3): a worker's throw
  is never main's. A main-side handler for a worker's message that throws
  *is* main's bug, and ends the process; so every main-side handler for
  worker messages validates its input before acting on it. A test proves
  that a module whose handler throws, and one whose top-level code throws,
  leave the server answering.
- **The risk this adds, and its audit** (the reviewer's). Today main logs an
  uncaught exception and carries on (`framework.js:25-30`). After this, any
  `'error'` event without a listener on main, or any stray unhandled
  rejection in a dependency, ends the server. So step 2 includes an audit of
  every emitter on main that can emit `'error'`: the five Redis clients,
  bullmq's Queue, Worker and QueueEvents, the HTTP server(s), Worker objects
  and MessagePorts. Each gets a listener that logs. A required test proves
  that Redis going down and coming back does not end the process
  (`test/auth/42-redis-down-answers.js` is most of it).
- **Restart policy** (documented): systemd `Restart=on-failure` with
  `RestartSec=2`; Docker `--restart unless-stopped`; Kubernetes
  `restartPolicy: Always` (the Deployment default).
- **File threads** (item 5; the file-broker spec §8.4): an uncaught exception
  in a file thread logs the full stack and ends only that thread; its
  in-flight file operations fail with a code; the pool restarts it.

### 6.4 Readback (item 8, and the user's question: how does an operator see errors without a collector?)

- `ctx.log(entry)` keeps its call shape. Entries become `module.log` records,
  attributed by main, at info by default, with `ctx.log.warn` and
  `ctx.log.error`. The worker sends the call id from the handler's `ctx` with
  each entry. Main checks that the call is one it dispatched to that worker
  and still in flight, and attaches that call's `call` and `caller` from its
  own dispatch record; otherwise the entry carries neither. The attribution is
  marked worker-asserted (P2: call attribution is worker-asserted when a
  worker has several calls in flight), and operators can filter a module's
  logs by tenant.
- **Two bounded in-memory rings on main**, with the same mechanism:
  - **(a) per module:** its `module.log` entries **plus** every runtime
    record that carries that `module` (lifecycle events, denials, unbilled
    calls), so a module's whole story is in one place. The most recent 1 000
    records, capped at 256 KB. Cleared on unload, and kept across a
    supervisor restart of the worker.
  - **(b) global:** every record at warn and above, plus `server.start`. The
    most recent 2 000 records or 1 MB, whichever comes first.
- **One route,** `GET /admin/logs?module=&level=&event=&since=&limit=`,
  behind the existing admin-only gate (under keyless `--debug` that gate
  makes everyone an admin, which is documented). `limit` is at most 1 000,
  newest last. It returns the same redacted records stdout gets, never more:
  with `module`, from ring (a); without it, from ring (b). The authoring tool
  **`countinghouse_logs`** has the same filters (it replaces the working name
  `countinghouse_module_logs`). Never readable by tenants: one module's logs
  can hold another tenant's data.
- **Documented plainly:** "the recent trouble, bounded, lost on restart; not
  a log store: use stdout or `--logFile` and a collector for retention."
- The redis `devicelog:<id>` / `devicelogtimestamp:<id>` lists are retired,
  with a CHANGELOG note.
- Module `console` output stays silenced outside `--debug`.
- Where authors find their logs: on their own dev server, in the terminal
  (pretty mode, labelled with the module); on someone else's server, in the
  operator's collector filtered by `module`, and through `GET /admin/logs`.

### 6.5 Noisy sources (moment 6)

Today the broker (`broker.js` `report`) and module-lockdown already
de-duplicate violations by rule and target and stop after 100 per worker
with one `suppressed` line, and allowed accesses aren't logged at all. P1
keeps that as it is. A per-access summary would need a counter on every
broker operation, a hot-path cost, so it moves to P2. P1's first commit
**measures what actually dominates the suite logs** before anything is
designed for it.

### 6.6 Cost (what-must-never-happen 6)

The budget is under 5 µs of main-thread time per info record at json,
including the readback rings' share (an array push and a size counter per
record kept), and nothing below the level threshold is built at all: callers pass fields, and
the record is formatted only if its level is enabled. It's measured with
`perf/fs-broker-io-perf.js` (and the log-heavy workload of the file-broker
spec's S) before and after the logger core lands, unattended, under the
perf-hygiene rules. A regression beyond the run-to-run spread goes to the
user.

## 7. Tests

- Tests start servers with `--logFormat json` and assert on parsed records
  through one helper: `events(server.output, {event, module, …})`. They don't
  assert on wording (item 10). The events they use are in the registry.
- Under the suite the default level is warn, so suite logs shrink. A test that
  asserts on lifecycle events (for example sandbox/33's worker count) passes
  `--logLevel info`.
- A unit-test sink, `logger.capture(fn)`, returns the records written while
  `fn` runs.
- Required tests:
  - no key ever appears in a record (a key-dump style scan over every record
    of a full test run);
  - the main and worker uncaught-exception paths keep the stack, on 24 and 26;
  - Redis going down and coming back doesn't end the process;
  - a crashing module leaves the server up;
  - the catalogue coverage test;
  - client shapes byte-identical through part 1 (existing tests plus the
    golden);
  - the budget's `log.dropped` counts;
  - `ctx.error(code, message, details)` and a plain `Error` with a `.code`
    thrown by a module both reach the caller as today, with `origin: 'module'`;
  - `countinghouse-validate` reports a module that references `DeviceError`
    or `CHError` as pre-8.0, naming the fix;
  - a module code that equals a catalogue name reaches the caller as the
    module's (kind module), and `countinghouse-validate` warns about the
    collision;
  - a runtime error a module rethrows unchanged keeps `origin: 'runtime'`, and
    one wrapped with `ctx.error` is the module's, with the original in
    `cause`;
  - `docs/errors.md` matches what the generator would write (the staleness
    test);
  - after step 1's codemod, the existing error-shape tests and the golden pass
    unchanged;
  - module faults (5.6): a fault that matches its schema arrives in all three
    places (MCP `_meta`, REST `fault`, the hop's `.fault`); one that doesn't is
    delivered as the module gave it and logged as `fault.invalid`; with no
    schema declared it arrives free-form within the bound; the golden tools/list is unchanged;
  - the readback rings keep to their bounds, `GET /admin/logs` filters by
    module, level, event and since, and refuses a non-admin;
  - `--logFile` reopening on SIGHUP;
  - before-init buffering;
  - the 8 KB bound and the per-field cut of `details`.

## 8. Retired

- `--apiMonitor` and its redis per-call lists keyed by the raw appKey
  (item 9; session.js:196-222).
- The redis devicelog lists (item 8).
- `CHError` and `DeviceError`, classes and globals (in step 1, section 5.1).
- `--logStream` (after one release as a warning alias).
- The two `error-info.*.json` files (replaced by the catalogue).

## 9. Landing plan (the reviewer's call)

One spec, landing so that no step is a big bang:

1. **Error core, as soon as this spec is approved,** in parallel with R2-1:
   - the class (5.1) in `lib/countinghouse-error.js`, and the catalogue
     module with its coverage test (5.3), replacing the two
     `error-info.*.json` files, with the generated `docs/errors.md` and its
     staleness test;
   - **one codemod commit** that renames all 214 `new CHError` /
     `new DeviceError` sites in `lib/` to `new CountinghouseError`. The
     constructor signature is kept (a code, then positional arguments), and
     rendering stays at construction, as today, so behaviour is
     byte-identical, and the existing tests prove it. No edge renderer
     changes in this step;
   - `lib/sandbox.js` and `framework.js` stop installing the globals;
   - the bundled modules (`pre-installed-packages/`), the examples
     (log-triage, repo-review), the test fixtures, docs/module-development.md
     and the countinghouse-module skill (`.claude/skills/countinghouse-module/`)
     move to `ctx.error` (41 module-side sites at `491064a`), and those that
     raise `ARGUMENTS_INVALID` themselves move to one consistent code of their
     own, `INPUT_REJECTED` (section 12, item 1). The golden tools/list stays
     byte-identical;
   - `countinghouse-validate` reports a module that references `DeviceError`
     or `CHError` as pre-8.0;
   - the upgrade guide's before/after. Codes R2-1 adds (`IDENTITY_NOT_FOUND`,
   `CALL_TOKEN_INVALID`; `MODULE_LOAD_SUPERSEDED` is already in) go into the
   table by whoever lands second.
2. **Logger core, once R2-1 Task 4 is on master.** It needs
   `identity.idForKey` (Task 1), and it changes `lib/sandbox.js`,
   `lib/worker-message.js` and framework.js's startup, which R2-1 Tasks 3–4
   rewrite (tokens, one binding per worker); running both at once would make
   every commit collide. The step brings the logger, the sinks, main as
   single writer, the budget, redaction, the test sink, before-init
   buffering, and uncaught-exception handling (section 6). Existing `LOG.*`
   calls keep working through a compatibility surface that maps them to
   records with a generic event (`legacy.<level>`). It also includes the
   `'error'`-listener audit (section 6.3). **Before it lands, one full suite
   run with the exit behaviour on**: any exit that run causes is a bug, fixed
   before landing.
3. **Migration by area, after all of R2-1** (Task 6 done), one commit per
   area: lifecycle, devices, jobs, MCP and HTTP, peer, startup, util, the
   broker, and auth last. The broker area's commit waits for the file-broker
   speed-up proposals that are kept, since they change the same files. In
   each commit:
   - that area's `LOG` calls become registry events with fields
     (Appendix B);
   - its plain `new Error` sites are classified and converted (Appendix C);
   - **rendering at the edge (5.2, 5.4) moves in** for the paths that area
     owns: the HTTP and MCP responses in the MCP and HTTP area, bullmq's
     `failedReason` and `stacktrace` in the jobs area, worker messages in
     lifecycle;
   - its tests move from wording to fields.
   A converted site keeps the code and text a caller sees today
   (what-must-never-happen 4). An operator-kind error that shows a host path
   today (the broker's spawn and load errors, through `module-manager.js`)
   keeps it in `details.hostPath`, an allowlist entry for operator-kind
   errors only. Any change to what a caller sees is listed for approval, not
   made in the area commit. Each commit is reviewable on its own, and the
   suite stays green throughout.
4. **Retirements, at the end** (section 8; the error classes went in
   step 1), and a lint or test that `lib/` throws only `CountinghouseError`s
   with catalogue codes, Node-shaped errors returned to module code
   (Appendix C's "node"), or documented internal errors.

**R2-1's interface** (implementer A): `lib/identity.js`, main only, gives
`identity.idForKey(apiKey)`, sync after `identity.init`. Task 1 itself
switches every `keyFingerprint` line (`lib/key-fingerprint.js`) to the id,
so the migration leaves those lines to Task 1 and uses `idForKey` for new
records. Task 3 adds `ctx.caller.id` on the worker side. **Files step 1
stays away from** while R2-1 is open (A's list; steps 2–3 come after R2-1
anyway): `lib/identity.js`, `lib/key-fingerprint.js`, `lib/auth/*`,
`lib/couchdb-adapter/couchdb-auth-provider.js`,
`lib/routes/identity-lookup.js`, `bin/countinghouse-auth-sqlite.js`, the
`schedulerId` block in `lib/job-control.js`, the lookup-tool entries in
`lib/mcp/tool-registry.js` and `gateway.js`, and framework.js's startup block
where `identity.init` goes.

The appendices' line numbers are references at `491064a`. The `file:<n>`
thread, `source: file` and the file-thread crash handling are conditional on
the file-broker spec's proposal 5 being kept.

## 10. Docs and CHANGELOG

- A new `docs/errors.md`, generated from the catalogue (5.3): every code, its
  kind, HTTP status, MCP code and English text, for operators and clients.
- A new `docs/logging.md`: the record, the event registry, levels, formats,
  destinations, `--logFile` and logrotate, the restart policy, where module
  authors find their logs, and the admin readback.
- `docs/cli-and-api-reference.md`: `--logLevel`, `--logFormat`, `--logFile`,
  `--logStream` (deprecated), `--apiMonitor` (removed), `GET /admin/logs` and
  `countinghouse_logs`.
- `docs/module-development.md` and the countinghouse-module skill:
  `ctx.error`, the codes rule (a module's codes are its own; it never raises
  the catalogue's), rethrow versus wrap, a link to docs/errors.md, `ctx.log`,
  `ctx.log.warn`/`.error`, and the readback.
- `docs/security-model.md`: no keys in logs (by construction and by
  redaction), the log file's mode, and the readback's admin gate.
- `docs/upgrading-to-8.md` and the CHANGELOG: `DeviceError`/`CHError` →
  `ctx.error` with a before/after, the retirements, the new flags,
  the stored bullmq `failedReason` format (only for someone reading bullmq's
  Redis directly; clients see the same text), the exit-70 behaviour with the
  restart policy and the double-billing window until M11, and single-thread
  mode's crash behaviour.

## 11. Not in scope

- P2's usage and I/O audit records (built on this logger later).
- Shipping logs anywhere but stdout and a file.
- Changing any client-visible error shape, except the two listed for
  approval: the key and stack exception that lands in R2-1 Task 5 (5.4), and
  module faults (5.6). Any other change is proposed separately.

## 12. For the user to confirm

1. Section 5: one error class, `CountinghouseError`, with `kind` from the
   catalogue and `origin` from the boundary; `CHError`/`DeviceError` dropped
   (the user's decision, recorded); `ctx.error` for modules; rendering at the
   edge; one catalogue table; the boundary shapes; client bytes identical,
   with the one exception that lands in R2-1 Task 5; modules define only their
   own codes and never raise the catalogue's (the user's decision, recorded;
   `ARGUMENTS_INVALID` stays the runtime's); the generated docs/errors.md
   (5.3). As a consequence, the bundled and example tools that raise
   `ARGUMENTS_INVALID` themselves (about 29 sites in 12 modules at
   `e69fdb8`) move to their own code, `INPUT_REJECTED`, used consistently so
   the examples teach one habit: a deliberate client-visible change for those
   tools only, with tools/list untouched. The composition and example tests
   move with them.
2. Section 4: stdout plus `--logFile`, and no syslog.
3. Section 3: `caller` carries R2-1's opaque id, and the name only by admin
   lookup.
4. Section 6.3: exit 70 without a drain, the double-billing window until M11
   lands, and single-thread mode's crash ending the process.
5. Section 6.1: two record sources (`source`), with a worker event allowlist.
6. Section 6.4: the two readback rings (per module 1 000 records / 256 KB;
   global warn-and-above 2 000 records / 1 MB), `GET /admin/logs` and
   `countinghouse_logs`.
7. Section 5.6 (decided by the user 2026-11-10): module faults validated
   against the action's `fault` schema and delivered to MCP
   (`_meta["countinghouse/fault"]`), REST and composition hops, worker mode
   included. A fault that fails its schema is still delivered as given, and
   the mismatch is logged (`fault.invalid`, warn), not answered with a code.
   A deliberate client-visible change: a module error that carries a fault
   now shows it.
8. Section 9: the landing plan and its order against R2-1 and the speed-ups
   (step 1 as soon as approved; step 2 after R2-1 Task 4; step 3 after all of
   R2-1; the broker area after the kept speed-ups),
   including step 2's `'error'`-listener audit with its two tests (Redis down
   and back doesn't end the process; a full suite run with the exit behaviour
   on before landing), and the events that keep billing and access decisions
   visible (`metering.unbilled`, `auth.refused`, `job.late_answer`,
   `job.unauthorized`, Appendix A).

## 13. Left to the builder

- The final event names in each area's commit (they go in the registry).
- The `details` field allowlist, beyond the starting list in 5.1.
- The secret-shaped-value pattern for the redaction pass.
- The bucket numbers, if measurement says otherwise (and the ring size).
- How the compatibility surface maps each legacy call.
- The per-site categories marked "cat?" in Appendix C.

## Appendix A. The event registry (the starting set)

Each name is the contract tests and operators match on. Adding one is a
documented change: a line here and in docs/logging.md.

| Event | Level | Fields | Replaces / answers |
|---|---|---|---|
| `server.start` | info | instance, version, node, mode flags | the "start with options" line |
| `server.uncaught` | error | err | item 4 |
| `worker.spawn` | info | module, thread, durationMs | moment 3; module-manager.js:879 |
| `worker.settled` | info | module, thread | moment 3 |
| `worker.exit` | info / warn / error | module, thread, code, reason | module-manager.js:955, :961 |
| `worker.uncaught` | error | module, thread, err | item 3; sandbox.js:35 |
| `module.load` / `module.unload` | info | module, devices | |
| `module.reload.step` | info | module, step, of | moment 8 |
| `module.discovery.bound` | warn | module, limitMs | module-manager.js:159 |
| `module.suspended` | warn | module, reason | module-manager.js:66, :70, :946 |
| `module.restart.failed` | error | module, err | module-manager.js:63 |
| `module.log` | from the entry | module, entry | ctx.log (item 8) |
| `broker.deadline` | warn | module, op, path (virtual), durationMs, limitMs | moment 7 |
| `sandbox.denied` | warn | module, op, target, rule; source main (the broker decides) | P2's full denials |
| `sandbox.violation` | warn | module, rule, target; source worker (module-lockdown reports it) | the in-worker lockdown lines |
| `worker.unknown_event` | warn | module, worker.event (the claimed name); source worker | section 6.1 |
| `job.failed` | warn | module, job, err | |
| `auth.reload` / `auth.reload.refused` | info / warn | path, entries | file-provider.js:142 |
| `log.dropped` | warn | module, counts | the budget |
| `metering.unbilled` | warn | module, tool, caller, reason; the first per (reason) individually, then a summary per 60 s with counts by reason and module | every call served without a charge: M5's Redis outage, R2-1 Task 3's balance-step deadline, a missing provider. Billing decisions are never invisible, and an outage can't flood the log. |
| `auth.refused` | warn | code, route (HTTP or MCP); the first per (code) individually, then a summary per 60 s with counts by code and route | access decisions are never invisible. Never a key, nothing derived from one, and no remote IP (no new privacy decision). |
| `job.late_answer` | warn | module, job | B7+B8's dropped answer after a job's timeout |
| `job.unauthorized` | warn | module, job, code | M3's run-time authorization refusal |
| `fault.invalid` | warn | module, tool, errors (the schema validation errors) | 5.6: a module's fault that fails its own `fault` schema |
| `legacy.<level>` | as named | msg | the compatibility surface, until migration |

(Appendices B and C follow: every LOG call site and every plain `new Error`
site at `491064a`, by area.)

## Appendix B. Every LOG call site at `491064a`, with its proposed level

Default levels follow the current method (`LOG.E` → error, `LOG.I` → info, `LOG.W` → warn, `LOG.DE` → error with the device). The event name is chosen in the area's migration commit and added to the registry (Appendix A). The 19 `LOG.E(new Error(...))` sites are reclassified individually (marked **R**), because most of them are not errors.

| Area | Site | Now | Proposed |
|---|---|---|---|
| lifecycle | `lib/module-manager.js:58` | LOG.I | info |
| lifecycle | `lib/module-manager.js:63` | LOG.E(new Error) | **R** error: `module.restart.failed` |
| lifecycle | `lib/module-manager.js:66` | LOG.E(new Error) | **R** warn: `module.suspended {reason: sandbox_refusal}` |
| lifecycle | `lib/module-manager.js:70` | LOG.E(new Error) | **R** warn: `module.suspended {reason: repeated_exits}` |
| lifecycle | `lib/module-manager.js:73` | LOG.I | info |
| lifecycle | `lib/module-manager.js:118` | LOG.I | info |
| lifecycle | `lib/module-manager.js:159` | LOG.E(new Error) | **R** warn: `module.discovery.bound {limitMs}` |
| lifecycle | `lib/module-manager.js:191` | LOG.I | info |
| lifecycle | `lib/module-manager.js:217` | LOG.I | info |
| lifecycle | `lib/module-manager.js:228` | LOG.I | info |
| lifecycle | `lib/module-manager.js:278` | LOG.E | error |
| lifecycle | `lib/module-manager.js:292` | LOG.E | error |
| lifecycle | `lib/module-manager.js:304` | LOG.E | error |
| lifecycle | `lib/module-manager.js:316` | LOG.E | error |
| lifecycle | `lib/module-manager.js:319` | LOG.E | error |
| lifecycle | `lib/module-manager.js:356` | LOG.I | info |
| lifecycle | `lib/module-manager.js:363` | LOG.I | info |
| lifecycle | `lib/module-manager.js:366` | LOG.E | error |
| lifecycle | `lib/module-manager.js:373` | LOG.I | info |
| lifecycle | `lib/module-manager.js:391` | LOG.E | error |
| lifecycle | `lib/module-manager.js:402` | LOG.I | info |
| lifecycle | `lib/module-manager.js:413` | LOG.E | error |
| lifecycle | `lib/module-manager.js:420` | LOG.I | info |
| lifecycle | `lib/module-manager.js:523` | LOG.E | error |
| lifecycle | `lib/module-manager.js:561` | LOG.E | error |
| lifecycle | `lib/module-manager.js:584` | LOG.E | error |
| lifecycle | `lib/module-manager.js:596` | LOG.E | error |
| lifecycle | `lib/module-manager.js:686` | LOG.E(new Error) | **R** warn: `validate.cleanup_failed` |
| lifecycle | `lib/module-manager.js:732` | LOG.E(new Error) | **R** info: `worker.* (the validate worker's lifecycle lines)` |
| lifecycle | `lib/module-manager.js:740` | LOG.E(new Error) | **R** warn: `validate.cleanup_failed` |
| lifecycle | `lib/module-manager.js:751` | LOG.I | info |
| lifecycle | `lib/module-manager.js:761` | LOG.I | info |
| lifecycle | `lib/module-manager.js:858` | LOG.I | info |
| lifecycle | `lib/module-manager.js:862` | LOG.E | error |
| lifecycle | `lib/module-manager.js:865` | LOG.I | info |
| lifecycle | `lib/module-manager.js:867` | LOG.I | info |
| lifecycle | `lib/module-manager.js:879` | LOG.E(new Error) | **R** info: `worker.* (spawn walk, settled: moment 3)` |
| lifecycle | `lib/module-manager.js:892` | LOG.I | info |
| lifecycle | `lib/module-manager.js:896` | LOG.I | info |
| lifecycle | `lib/module-manager.js:898` | LOG.I | info |
| lifecycle | `lib/module-manager.js:946` | LOG.E(new Error) | **R** warn: `module.suspended {reason: repeated_exits}` |
| lifecycle | `lib/module-manager.js:949` | LOG.I | info |
| lifecycle | `lib/module-manager.js:955` | LOG.E(new Error) | **R** error: `worker.exit {reason: error} (carries err)` |
| lifecycle | `lib/module-manager.js:961` | LOG.E(new Error) | **R** info / warn: `worker.exit {code} (warn if code != 0)` |
| lifecycle | `lib/module-manager.js:998` | LOG.E | error |
| lifecycle | `lib/module-manager.js:1041` | LOG.I | info |
| lifecycle | `lib/module-manager.js:1044` | LOG.I | info |
| lifecycle | `lib/module-manager.js:1059` | LOG.E | error |
| lifecycle | `lib/module-manager.js:1163` | LOG.E | error |
| lifecycle | `lib/sandbox.js:35` | LOG.E(new Error) | **R** error: `worker.uncaught (P1 item 3: also ends the worker)` |
| lifecycle | `lib/sandbox.js:91` | LOG.I | info |
| lifecycle | `lib/sandbox.js:158` | LOG.E | error |
| devices | `lib/countinghouse-device.js:48` | LOG.DE | error (module.error, carries the device) |
| devices | `lib/countinghouse-device.js:56` | LOG.DE | error (module.error, carries the device) |
| devices | `lib/countinghouse-device.js:57` | LOG.DE | error (module.error, carries the device) |
| devices | `lib/countinghouse-device.js:58` | LOG.DE | error (module.error, carries the device) |
| devices | `lib/countinghouse-device.js:60` | LOG.DE | error (module.error, carries the device) |
| devices | `lib/countinghouse-device.js:65` | LOG.DE | error (module.error, carries the device) |
| devices | `lib/countinghouse-device.js:121` | LOG.DE | error (module.error, carries the device) |
| devices | `lib/countinghouse-device.js:145` | LOG.DE | error (module.error, carries the device) |
| devices | `lib/countinghouse-device.js:158` | LOG.DE | error (module.error, carries the device) |
| devices | `lib/countinghouse-device.js:168` | LOG.DE | error (module.error, carries the device) |
| devices | `lib/device-manager.js:45` | LOG.E | error |
| devices | `lib/device-manager.js:118` | LOG.E | error |
| devices | `lib/device-manager.js:141` | LOG.E | error |
| devices | `lib/device-manager.js:142` | LOG.DE | error (module.error, carries the device) |
| devices | `lib/device-manager.js:146` | LOG.DE | error (module.error, carries the device) |
| devices | `lib/device-manager.js:154` | LOG.DE | error (module.error, carries the device) |
| devices | `lib/device-manager.js:160` | LOG.DE | error (module.error, carries the device) |
| devices | `lib/device-manager.js:173` | LOG.I | info |
| devices | `lib/device-manager.js:397` | LOG.E | error |
| devices | `lib/device-manager.js:445` | LOG.I | info |
| devices | `lib/device-manager.js:452` | LOG.E | error |
| devices | `lib/device-manager.js:495` | LOG.I | info |
| devices | `lib/device-manager.js:675` | LOG.E | error |
| devices | `lib/device-manager.js:685` | LOG.DE | error (module.error, carries the device) |
| devices | `lib/device-manager.js:695` | LOG.I | info |
| devices | `lib/device-manager.js:774` | LOG.I | info |
| devices | `lib/device-manager.js:776` | LOG.I | info |
| devices | `lib/device-manager.js:797` | LOG.E | error |
| devices | `lib/device-manager.js:808` | LOG.E | error |
| devices | `lib/device-manager.js:850` | LOG.E | error |
| devices | `lib/device-manager.js:1046` | LOG.I | info |
| devices | `lib/device-manager.js:1084` | LOG.I | info |
| devices | `lib/device-manager.js:1486` | LOG.DE | error (module.error, carries the device) |
| devices | `lib/device-manager.js:1569` | LOG.I | info |
| jobs | `lib/job-control.js:134` | LOG.E(new Error) | **R** error: `jobs.redis_url_invalid` |
| jobs | `lib/job-control.js:146` | LOG.E(new Error) | **R** error: `jobs.queue_missing` |
| jobs | `lib/job-control.js:195` | LOG.I | info |
| jobs | `lib/job-control.js:232` | LOG.E | error |
| jobs | `lib/job-control.js:243` | LOG.E | error |
| jobs | `lib/job-control.js:269` | LOG.E | error |
| jobs | `lib/job-control.js:567` | LOG.E | error |
| jobs | `lib/job-control.js:583` | LOG.I | info |
| jobs | `lib/job-control.js:593` | LOG.I | info |
| jobs | `lib/job-control.js:603` | LOG.I | info |
| jobs | `lib/job-control.js:615` | LOG.I | info |
| jobs | `lib/job-control.js:621` | LOG.I | info |
| jobs | `lib/job-control.js:632` | LOG.I | info |
| auth+metering | `lib/auth/file-provider.js:71` | LOG.E(new Error) | **R** error: `auth.config.read_failed` |
| auth+metering | `lib/auth/file-provider.js:79` | LOG.E(new Error) | **R** error: `auth.config.invalid` |
| auth+metering | `lib/auth/file-provider.js:98` | LOG.W | warn |
| auth+metering | `lib/auth/file-provider.js:101` | LOG.W | warn |
| auth+metering | `lib/auth/file-provider.js:142` | LOG.E(new Error) | **R** warn: `auth.reload.refused (keeps the current config)` |
| auth+metering | `lib/auth/file-provider.js:162` | LOG.E(new Error) | **R** error: `auth.config.demo_write_failed` |
| auth+metering | `lib/auth/sqlite-provider.js:60` | LOG.E(new Error) | **R** error: `auth.sqlite.migrate_failed` |
| auth+metering | `lib/countinghouse-interface.js:31` | LOG.I | info |
| auth+metering | `lib/countinghouse-interface.js:40` | LOG.E | error |
| auth+metering | `lib/session.js:19` | LOG.E | error |
| auth+metering | `lib/session.js:138` | LOG.E | error |
| auth+metering | `lib/session.js:182` | LOG.E | error |
| auth+metering | `lib/session.js:184` | LOG.E | error |
| auth+metering | `lib/session.js:224` | LOG.E | error |
| MCP+HTTP | `lib/mcp/gateway.js:742` | LOG.E | error |
| MCP+HTTP | `lib/mcp/tool-registry.js:265` | LOG.I | info |
| MCP+HTTP | `lib/mcp/tool-registry.js:347` | LOG.E | error |
| MCP+HTTP | `lib/route-manager.js:150` | LOG.E | error |
| MCP+HTTP | `lib/route-manager.js:164` | LOG.I | info |
| peer | `lib/peer-channel-broker.js:198` | LOG.E | error |
| peer | `lib/peer-channel-broker.js:246` | LOG.I | info |
| util | `lib/countinghouse-util.js:29` | LOG.E | error |
| util | `lib/countinghouse-util.js:287` | LOG.I | info |
| util | `lib/countinghouse-util.js:313` | LOG.E | error |
| util | `lib/countinghouse-util.js:319` | LOG.E | error |
| util | `lib/countinghouse-util.js:381` | LOG.E | error |
| util | `lib/service.js:54` | LOG.DE | error (module.error, carries the device) |

## Appendix C. Every plain `new Error` site in `lib/` at `491064a`

Category, proposed (the area's commit confirms each): **node** = a Node-shaped error returned to module code through the patched `fs` or the loader (`ENOENT`, `MODULE_NOT_FOUND`…); it stays a Node error with its `code`. **cat** = reaches a caller or a log; it becomes a `CountinghouseError` with a catalogue code. **int** = a programmer error or an invariant that never reaches a caller; it may stay a plain `Error`, and is logged with its stack if it ever escapes. Where the snippet doesn't settle it, the category is "cat?" and the commit decides.

| Area | Site | Snippet | Category |
|---|---|---|---|
| lifecycle | `lib/module-data.js:27` | ``module name ${JSON.stringify(name)} cannot be used as a data director` | cat? |
| lifecycle | `lib/module-lockdown.js:65` | ``${what} is not allowed for module ${moduleName} ${SANDBOX_TAG}`);` | cat? |
| lifecycle | `lib/module-lockdown.js:71` | ``Cannot find module '${specifier}' ${SANDBOX_TAG}`);` | cat? |
| lifecycle | `lib/module-manager.js:63` | ``module sandbox: ${name} restart failed: ${err.message}`));` | cat? |
| lifecycle | `lib/module-manager.js:66` | ``module sandbox: ${name} suspended: the sandbox refuses it -- POST /re` | cat? |
| lifecycle | `lib/module-manager.js:70` | ``module sandbox: ${name} suspended after repeated exits: ${` | cat? |
| lifecycle | `lib/module-manager.js:103` | `'unknown module name'), null);` | cat? |
| lifecycle | `lib/module-manager.js:159` | ``module: ${name}: discovery did not finish within ${DISCOVERY_BOUND_MS` | cat? |
| lifecycle | `lib/module-manager.js:686` | ``validate: could not clear ${root}: ${e.message}`));` | cat? |
| lifecycle | `lib/module-manager.js:694` | ``${resolved} is not a directory`));` | cat? |
| lifecycle | `lib/module-manager.js:732` | `line))})` | cat? |
| lifecycle | `lib/module-manager.js:740` | ``validate: could not remove ${tmpRoot}: ${e.message}`)); }` | cat? |
| lifecycle | `lib/module-manager.js:879` | `line)), onSettled: () => LOG.I(`file broker: ${name} settled`)});` | cat? |
| lifecycle | `lib/module-manager.js:946` | ``module sandbox: ${name} suspended after repeated exits: ${` | cat? |
| lifecycle | `lib/module-manager.js:955` | ``worker exit on error: ${err.message}`));` | cat? |
| lifecycle | `lib/module-manager.js:961` | ``worker exit with code: ${exitCode}`));` | cat? |
| lifecycle | `lib/module-manager.js:1011` | `'module sandbox: restart superseded by an operator action'));` | cat? |
| lifecycle | `lib/module-manager.js:1034` | `'module sandbox: spawn superseded by a later operator action'), {super` | cat? |
| lifecycle | `lib/module-manager.js:1037` | `'module sandbox: restart superseded by an operator action'), {supersed` | cat? |
| lifecycle | `lib/module-manager.js:1052` | `e.message), {startFailed: true});` | cat? |
| lifecycle | `lib/module-policy.js:13` | ``--modulePolicy: ${where} ${message}`);` | cat? |
| lifecycle | `lib/module-policy.js:44` | ``--modulePolicy: cannot read ${file}: ${reason}`);` | cat? |
| lifecycle | `lib/module-validator.js:136` | ``${resolved} is not a directory`));` | cat? |
| lifecycle | `lib/sandbox.js:35` | ``Uncaught exception in worker thread: ${e.stack}`));` | cat? |
| lifecycle | `lib/sandbox.js:124` | `msg.errMsg \|\| 'refused by the main thread');` | cat? |
| lifecycle | `lib/sandbox.js:136` | `'too many messages to the main thread (--moduleMessageRate)');` | cat? |
| lifecycle | `lib/sandbox.js:196` | `'Invoke fail');` | cat? |
| lifecycle | `lib/sandbox.js:234` | `msg.errMsg), null);` | cat? |
| lifecycle | `lib/sandbox.js:260` | `msg.errMsg);` | cat? |
| lifecycle | `lib/sandbox.js:278` | `msg.errMsg));` | cat? |
| lifecycle | `lib/sandbox.js:295` | `msg.errMsg), null);` | cat? |
| lifecycle | `lib/sandbox.js:312` | `msg.errMsg), null);` | cat? |
| lifecycle | `lib/sandbox.js:358` | `msg.errMsg), null);` | cat? |
| devices | `lib/device-config.js:43` | ``${configPath} is not valid JSON${jsonSyntaxWhere(e, raw)}`));` | cat? |
| devices | `lib/device-db.js:13` | `'setting incorrect module name'), null);` | cat? |
| devices | `lib/device-db.js:24` | `'getting incorrect module name'), null);` | cat? |
| devices | `lib/device-db.js:34` | `'remove incorrect module name'), null);` | cat? |
| devices | `lib/device-manager.js:101` | `'illegal deviceID'));` | cat? |
| devices | `lib/device-manager.js:105` | `'unknown device'));` | cat? |
| devices | `lib/worker-message.js:250` | `msg.errMsg);` | cat? |
| jobs | `lib/job-control.js:134` | ``redis URL parse fail, check redisUrl option: ${err.message}`));` | cat? |
| jobs | `lib/job-control.js:146` | `'Invalid job queue'));` | cat? |
| jobs | `lib/job-control.js:155` | `'received null job in processor'));` | cat? |
| jobs | `lib/job-control.js:160` | `'job input data not available'));` | cat? |
| jobs | `lib/job-control.js:190` | ``Promise timed out after ${timeoutMs} milliseconds`));` | cat? |
| jobs | `lib/job-control.js:214` | `failMessage));` | cat? |
| jobs | `lib/job-control.js:267` | `failMessage));` | cat? |
| broker | `lib/fs-broker/client.js:9` | `e.message);` | node |
| broker | `lib/fs-broker/client.js:15` | ``EIO: i/o error, ${op} (the file broker did not answer)`);` | node |
| broker | `lib/fs-broker/errors.js:16` | ``${code}: ${TEXT[code] \|\| code.toLowerCase()}, ${syscall}${where}`);` | node |
| broker | `lib/fs-broker/errors.js:42` | `scrub(e.message, placed, dest, namespace));` | node |
| broker | `lib/fs-broker/identity.js:139` | ``Cannot find module '${specifier}' (countinghouse module sandbox)`);` | node |
| broker | `lib/fs-broker/identity.js:161` | `underVrootMessage(clash));` | cat (reaches the operator at spawn or load) |
| broker | `lib/fs-broker/index.js:63` | ``cannot create the module data directory ${where}: ${e.message} -- set` | cat (reaches the operator at spawn or load) |
| broker | `lib/fs-broker/index.js:76` | `text), {code: 'MODULE_SANDBOX_REFUSED'});` | cat (reaches the operator at spawn or load) |
| broker | `lib/fs-broker/namespace.js:73` | `'namespace used before prepare()');` | node |
| broker | `lib/fs-broker/patch.js:37` | ``${what} is not available to modules (countinghouse module sandbox)`);` | node |
| broker | `lib/fs-broker/patch.js:111` | `message);` | node |
| broker | `lib/fs-broker/patch.js:172` | ``ENOENT: no such file or directory, ${key.replace(/Sync$/, '')} '${sho` | node |
| broker | `lib/fs-broker/patch.js:702` | `'The lchmod() method is not implemented'); e.code = 'ERR_METHOD_NOT_IM` | node |
| broker | `lib/fs-broker/spawn-walk.js:11` | ``${dir} is not a directory (a link or a file); refusing to empty or me` | cat (reaches the operator at spawn or load) |
| auth+metering | `lib/auth/file-provider.js:71` | ``FileAuthProvider: failed to read ${this.configPath}: ${e.message}`));` | cat? |
| auth+metering | `lib/auth/file-provider.js:79` | ``FileAuthProvider: ${this.configPath} is not valid JSON${jsonSyntaxWhe` | cat? |
| auth+metering | `lib/auth/file-provider.js:112` | `message), {code: 'AUTH_RELOAD_INVALID'});` | cat? |
| auth+metering | `lib/auth/file-provider.js:142` | ``FileAuthProvider: reload refused, keeping the current config: ${e.mes` | cat? |
| auth+metering | `lib/auth/file-provider.js:162` | ``FileAuthProvider: failed to write demo config to ${this.configPath}:` | cat? |
| auth+metering | `lib/auth/provider.js:34` | `'AuthProvider.authenticate must be implemented by a subclass');` | int |
| auth+metering | `lib/auth/provider.js:45` | `'AuthProvider.listDevices must be implemented by a subclass');` | int |
| auth+metering | `lib/auth/provider.js:62` | `'AuthProvider.identityForModule must be implemented by a subclass');` | int |
| auth+metering | `lib/auth/sqlite-provider.js:60` | ``SqliteAuthProvider: failed to migrate admin column: ${err.message}`))` | cat? |
| auth+metering | `lib/metering/provider.js:18` | `'MeteringProvider.recordCall must be implemented by a subclass');` | int |
| auth+metering | `lib/metering/provider.js:26` | `'MeteringProvider.checkBalance must be implemented by a subclass');` | int |
| auth+metering | `lib/metering/provider.js:32` | `'MeteringProvider.rateLimit must be implemented by a subclass');` | int |
| auth+metering | `lib/metering/redis-provider.js:105` | `'apiKey is required'));` | cat? |
| auth+metering | `lib/metering/redis-provider.js:125` | `'apiKey is required'));` | cat? |
| auth+metering | `lib/redis-resilient.js:74` | ``rate-limit check got no answer from Redis in ${ms} ms`);` | cat? |
| auth+metering | `lib/session.js:86` | `err.message), null);` | cat? |
| MCP+HTTP | `lib/handler-ctx.js:134` | `'ctx.serviceClient: `as` is required -- it is the identity the ' +` | cat? |
| MCP+HTTP | `lib/mcp/gateway.js:427` | `parsed.error));` | cat? |
| MCP+HTTP | `lib/mcp/gateway.js:457` | `'authoring tools require an admin key');` | cat? |
| MCP+HTTP | `lib/mcp/gateway.js:478` | `'arguments.path must be a non-empty string'))));` | int |
| MCP+HTTP | `lib/mcp/gateway.js:493` | `'arguments.path and arguments.name are required'))));` | cat? |
| MCP+HTTP | `lib/mcp/gateway.js:510` | `` | cat? |
| MCP+HTTP | `lib/mcp/gateway.js:580` | `'arguments.name must be a non-empty string'))));` | int |
| MCP+HTTP | `lib/mcp/gateway.js:583` | `'countinghouse_call_tool cannot invoke an authoring tool'))));` | cat? |
| MCP+HTTP | `lib/mcp/gateway.js:606` | `innerResp.error.message);` | cat? |
| MCP+HTTP | `lib/mcp/gateway.js:620` | ``unknown authoring tool: ${name}`))));` | cat? |
| MCP+HTTP | `lib/mcp/gateway.js:786` | `'rate limit exceeded'))));` | cat? |
| MCP+HTTP | `lib/mcp/gateway.js:944` | `codeMatch != null ? failedReason.slice(codeMatch[0].length) : failedRe` | cat? |
| MCP+HTTP | `lib/mcp/tool-registry.js:221` | ``tool-registry.js: AUTHORING_TOOLS entry '${tool.name}' is not reserve` | cat? |
| MCP+HTTP | `lib/routes/get-device-package-info.js:17` | `'null package info'));` | cat? |
| peer | `lib/peer-channel.js:204` | `msg.errMsg);` | cat? |
| peer | `lib/service-client.js:41` | `'opts must be object'));` | int |
| peer | `lib/service-client.js:42` | `'must specify actionName'));` | int |
| peer | `lib/service-client.js:43` | `'actionName must be string'));` | int |
| peer | `lib/service-client.js:44` | `'must specify input argument'));` | int |
| peer | `lib/service-client.js:67` | `body.message), null);` | cat? |
| util | `lib/couchdb-adapter/couchdb-auth-provider.js:35` | `'CouchDBAuthProvider requires the "nano" package, which is not install` | cat? |
| util | `lib/countinghouse-error.js:77` | `err.message);` | cat? |
| util | `lib/countinghouse-util.js:79` | `'invalid device base url'));` | cat? |
| util | `lib/countinghouse-util.js:80` | `'must specify input argument'));` | int |
| util | `lib/countinghouse-util.js:102` | `body.message), null);` | cat? |
| util | `lib/countinghouse-util.js:118` | `'must specify appKey or ctx object'), null);` | int |
| util | `lib/countinghouse-util.js:119` | `'must specify deviceID and serviceID'), null);` | int |
| util | `lib/countinghouse-util.js:149` | `info.message), null); // user not found or other error from device-lis` | cat? |
| util | `lib/countinghouse-util.js:173` | `spec.message), null);` | cat? |
| util | `lib/countinghouse-util.js:238` | `'must specify deviceID'), null);` | int |
| util | `lib/countinghouse-util.js:241` | `'ctx.call needs a local runtime -- it is not available ' +` | cat? |
| util | `lib/countinghouse-util.js:247` | `err.message), null);` | cat? |
| util | `lib/countinghouse-util.js:348` | `'this should be called from main thread'));` | cat? |
| util | `lib/countinghouse-util.js:372` | `'cannot work in main thread and single-thread mode'));` | cat? |
| util | `lib/countinghouse-util.js:374` | ``invalid jobID: ${jobID}. must be string or number type`));` | int |
| util | `lib/countinghouse-util.js:386` | `'unknown worker thread'));` | cat? |
| util | `lib/optional-sqlite3.js:75` | `explain(e, what, alternative));` | cat? |
| util | `lib/query-device.js:19` | `error.message), null);` | cat? |
| util | `lib/validator.js:122` | ``this api.json is in the pre-5.0.0 spec format (found ${legacy` | cat? |
| util | `lib/validator.js:145` | `errorMessage);` | cat? |
| util | `lib/validator.js:164` | ``duplicate action name. Service: ${serviceID}, action: ${actionName}`)` | cat? |

## Appendix D. The console.* calls at `491064a` (24, comments excluded)

These bypass the logger today. Each becomes a record in its area's commit, except framework.js's pre-init usage and exit-2 messages, which stay on stderr: they are the CLI's own answer, written before the logger exists or instead of starting.

| Site | Call |
|---|---|
| `framework.js:13` | `console.error(nodeVersion.message(process.version));…` |
| `framework.js:21` | `console.error('no thread flag given (pass --workerThread or --no-workerThread)');…` |
| `framework.js:26` | `console.error('Error: ' + e.stack);…` |
| `framework.js:30` | `console.warn(e.stack);…` |
| `framework.js:38` | `console.error('--debugKey needs a value (--debugKey <key>)');…` |
| `framework.js:45` | `console.error('--mcpToolCallCost must be a finite number >= 0 (got ' +…` |
| `framework.js:51` | `console.error('--debug without --debugKey accepts every request as an admin, so it binds o…` |
| `framework.js:60` | `console.error('--hardened needs --workerThread: module workers are what it protects the pr…` |
| `framework.js:67` | `console.error('--hardened: cannot create the module folder ' + options.modulePath + ' or t…` |
| `framework.js:87` | `console.error(hardenedLaunch.refusalMessage(probe, hardenedLaunch.grantOverlaps(hardenedFl…` |
| `framework.js:103` | `console.error('--moduleSandbox must be one of off, audit, enforce (got "' + options.module…` |
| `framework.js:107` | `console.error('--moduleSandbox ' + options.moduleSandbox + ' needs --workerThread: the san…` |
| `framework.js:132` | `console.error(identity.underVrootMessage(vrootClash));…` |
| `framework.js:143` | `console.error(e.message);…` |
| `lib/auth/file-provider.js:165` | `console.log(`\n` +` |
| `lib/couchdb-adapter/init-db.js:45` | `console.error('This script requires the "nano" package, which is not installed. Run: npm i…` |
| `lib/couchdb-adapter/init-db.js:94` | `console.error(`failed to create _users db: ${err.message}`);` |
| `lib/couchdb-adapter/init-db.js:108` | `console.error(`failed to write _design/user: ${insertErr.message}`);` |
| `lib/couchdb-adapter/init-db.js:111` | `console.log(`ok: _users db ready, _design/user/byAppKeyWithBasicInfo view installed at ${opts.dbUrl}`);` |
| `lib/countinghouse-util.js:304` | `if (options.debug === true) return console.log(data);…` |
| `lib/countinghouse-util.js:336` | `if (options.debug === true) return console.log(data);…` |
| `lib/hardened-launch.js:200` | `console.error(`--hardened: could not start the server under --permission: ${e.message}`);` |
| `lib/logger-stream-redis.js:22` | `return console.error('Must pass a Redis client');…` |
| `lib/logger-stream-redis.js:117` | `console.error(`Unknown Redis stream type: "${type}". Must be "channel" or "list" or "set".`);` |
