# Cross-cutting concern coverage matrix

Sprint 3/4 found the same shape of bug three times in a row: a new entry
path was added, and one or more cross-cutting concerns (authorization,
metering, rate limiting) silently didn't apply to it, because those
concerns live as calls scattered across the code rather than as a single
gate every entry path is forced through. This document is the fix for
*that* pattern, not for any individual bug: it is a live inventory of
which entry path gets which guarantee, kept honest, so a gap is visible
in a table instead of discovered by an incident.

**Rule going forward: any PR that adds a new entry path must update this
table before merging.** A blank cell is not an acceptable final state —
it must be filled in as either an implementation location or an explicit
"exempt" with a reason.

Verified by reading the actual code paths on 2026-08-09, not by
recalling how the system is supposed to work. File/line references are
called out so the claims here can be checked and re-checked as the code
changes.

## The matrix

| Entry path | userAuth (device ownership) | Schema validation | recordCall | rateLimit | Timeout | Error shape |
|---|---|---|---|---|---|---|
| **HTTP `POST /devices/:deviceID/invoke-action`** | ✅ `lib/routes/user.js` → `user-auth.js`, mounted ahead of the route (`lib/route-manager.js`) | ✅ `Service.prototype.invoke` → `validateActionCall` (`lib/service.js`) — the shared dispatch point every path below also funnels through | ✅ `Session.prototype.updateRedisUserRecord` (`lib/session.js`), fires after every call | ✅ `CdifInterface.prototype.invokeDeviceAction`: global limiter (main thread only) + per-apiKey `this.rateLimit()` (`lib/countinghouse-interface.js`) | ✅ `Session`'s own timer, `options.requestTimeout` (default 30000ms) | `{topic, code, message[, fault]}` JSON body (`lib/session.js:81,105,107`) — `code` is the locale-independent field added in Sprint 4 |
| **MCP `tools/call` (synchronous)** | ✅ same `userAuth` call, invoked directly in `lib/mcp/gateway.js:143` | ✅ same shared path — goes through `cdifInterface.invokeDeviceAction` exactly like HTTP | ✅ explicit call in `gateway.js:150`, cost = `options.mcpToolCallCost`, fire-and-forget | ✅ same `invokeDeviceAction` gate as HTTP (this call is *inside* `invokeDeviceAction`, not a separate check) | ✅ same `Session` timer as HTTP (this path constructs and uses a `Session` too) | `toolCallResult()` (`gateway.js:83`) — includes `err.code` (when present) as `structuredContent.code`, fixed 2026-08-09, see Findings |
| **MCP `tools/call` (task-augmented, `params.task`)** | ✅ fixed 2026-08-09 — `createTaskForToolCall` (`gateway.js:164`) now calls `userAuth` before task creation, same gate and same `JSONRPC_INTERNAL_ERROR` failure shape as the synchronous path; the resulting `session` is discarded (job execution stays on its separate `JobControl.addJob`/`invokeJobs` path, which still takes no appKey) — this is purely an authorization check, not a rewire of execution. Regression test: `test/unit/test031.js` | ✅ same shared `validateActionCall` path (execution still runs through the normal action dispatch, only the surrounding gate is skipped) | ✅ `job-control.js:84-88`, fires after job completion using `jobData.apiKey` stashed at creation time | ✅ but only checked once, at task *creation* (`gateway.js:193-200`), not re-checked at execution — a deliberate choice (queue growth is the actual resource being protected), documented in-code | ✅ bullmq `job.opts.timeout`, reimplemented via `setTimeout` (`job-control.js:59-68`, needed because bullmq dropped bull's built-in job timeout) | Same `toolCallResult()` as sync path — `structuredContent.code` fix applies here too, via a second fix: `job-control.js`'s worker now encodes `"CODE: message"` into the rejected error before bullmq flattens it to `job.failedReason` (a plain string that drops any custom property otherwise), and `handleTasksResult` decodes it back out. Regression test: `test/unit/test032.js` |
| **Event channel (`socket.io` `subscribe`/`disconnect`, `lib/socket-server.js`)** | ❌ **none.** No appKey/key of any kind is read from the socket connection or the `subscribe` payload — marked `//TODO: add user key support` in the code itself (`socket-server.js:38,65`) | ⚠️ unclear/likely none — `subscribe` goes through `CdifInterface.prototype.eventSubscribe` → `DeviceManager.prototype.onEventSubscribe`, a separate code path from `Service.prototype.invoke` that was not traced to a schema check | ❌ none. No `recordCall` anywhere on this path | ❌ none. `eventSubscribe`/`eventUnsubscribe` on `CdifInterface` call `deviceManager.emit(...)` directly, bypassing both the global and per-apiKey limiter machinery in `invokeDeviceAction` | ❌ no timeout observed on subscribe itself (long-lived by nature) | `{topic, code, message}` emitted back over the socket as an `'error'` event (`socket-server.js:43`) — shape matches HTTP, `code` preserved |
| **Direct peer channel** (worker `message channel`, e.g. `ServiceClient.invoke` with `isRemoteThread: true` — the mechanism `composite-demo` uses to call other modules in-process) | ⚠️ **checked once, on the main thread, before routing** — `DeviceManager.prototype.sendInvokeActionMessageToWorker` (`lib/device-manager.js:361`) calls `userAuth` before dispatching to the callee's worker. But the callee worker's own re-entry point (`invoke-action` case in `lib/sandbox.js:68-79`) calls `ci.invokeDeviceAction(...)` with a **plain callback function as the `session` argument**, not a `Session` object — see rateLimit finding below, same root cause also means no *second* userAuth check happens worker-side (by construction there's only ever one) | ✅ same shared `validateActionCall` — the callee's action still executes through the normal per-worker dispatch, indistinguishable from a locally-triggered call | ❌ **not automatic.** No `recordCall` fires anywhere in the routing path itself. `composite-demo`'s billing (see `docs/composite-tools.md`) exists only because the *calling module's own handler* explicitly invokes `CHUtil.recordCall` per hop — this is module-level discipline, not a platform guarantee. A module that composes other modules without doing this gets metered $0 for the inner calls | ❌ **not enforced**, for a specific, verified reason: the callee-side re-entry (`sandbox.js:68-79`) passes a bare function as `invokeDeviceAction`'s `session` parameter. `checkApiKeyRateLimit` in `countinghouse-interface.js` reads `session.appKey`, which is `undefined` on a plain function, so the `if (session.appKey == null) return doInvoke();` early-return fires unconditionally — the rate-limit check is skipped, not merely absent. The main-thread global limiter is also inapplicable here since the callee-side call runs with `isMainThread === false`. Net effect: an internal hop is **never** rate-limited, regardless of `--apiKeyRateLimit` | ✅ `session.setDeviceTimer(calleeWM, ...)` set on the main thread before dispatch (`device-manager.js:364`), same underlying mechanism as HTTP/MCP | Raw `DeviceError`/Error object returned via a Node-style `(err, data)` callback to the calling module's own code (`ServiceClient.invoke`, `lib/service-client.js:57-72`) — `err.code` survives the worker boundary (Sprint 4's `worker-message.js` fix). Not an HTTP/MCP envelope; shaping for any external caller is entirely up to the calling module |

## Findings from building this table

Two gaps were found while filling this table in, neither previously
known. Both are now **fixed and covered by regression tests**, recorded
here for the history and because the table's own change-control rule
requires every claim to stay checkable against the code:

1. **MCP task-augmented `tools/call` never checked device ownership.**
   Any caller with *any* apiKey — not necessarily one authorized for the
   target device — could task-augment a call and have it execute, because
   neither task creation (`gateway.js`'s `createTaskForToolCall`) nor task
   execution (`job-control.js` → `onInvokeJobs`) called `userAuth`. The
   synchronous `tools/call` path never had this gap. This was the more
   serious of the two findings — an authorization bypass, not a UX rough
   edge. **Fix**: `createTaskForToolCall` now calls `userAuth` first — the
   same gate, at the same point (task creation) `rateLimit` was already
   fixed to check in an earlier Sprint, and the same `JSONRPC_INTERNAL_ERROR`
   failure shape the synchronous path already used — before checking
   `rateLimit` and creating the job; the resulting `session` is discarded
   since job execution doesn't need it. **Test**: `test/unit/test031.js`
   asserts a task-augmented call with an unauthorized apiKey is rejected
   without creating a task, and that one with an authorized apiKey still
   succeeds (skipped in single-thread mode, where tasks aren't supported
   at all and the request never reaches this gate in the first place).
2. **MCP `tools/call` responses (`toolCallResult`) dropped `err.code`.**
   Sprint 4 added a locale-independent `code` field to `CHError`/
   `DeviceError` specifically so callers don't have to pattern-match
   translated message text. HTTP `invoke-action` responses include it;
   MCP tool-call error responses (both sync and task-augmented, since
   both go through the same `toolCallResult()`) only serialized
   `err.message` into `content[0].text`. **Fix**: `toolCallResult()` now
   adds `structuredContent: {code: err.code}` to the error branch whenever
   `err.code` is present (plain `Error`s raised for request-validation
   failures in `gateway.js` itself have no `.code` and are unaffected).
   This alone was enough for the synchronous path, but testing the
   task-augmented path surfaced a **second, deeper cause of the same
   symptom**: bullmq's `Worker` only ever persists a failed job's reason
   as a plain string (`job.failedReason = err.message`), so any custom
   property on the rejected error — including `code` — was already gone
   before `toolCallResult` ever ran, regardless of the first fix.
   Addressed with a small, self-contained encode/decode: `job-control.js`'s
   worker now rejects with `"CODE: message"` when the original error has a
   `code` (every `CHError`/`DeviceError` code is an `UPPER_SNAKE_CASE`
   identifier a real message would not otherwise start with), and
   `handleTasksResult` decodes that prefix back into `err.code` before
   calling `toolCallResult`. **Test**: `test/unit/test032.js` asserts
   `structuredContent.code === 'INPUT_DATA_VALIDATION_FAIL'` for both the
   synchronous path and, when tasks are supported, the task-augmented path
   via `tasks/result` (polls until the task completes).

   Running `test032.js` inside the full suite (after 30+ other tests had
   already put real load on the same redis/bullmq instance) then surfaced
   a **third, unrelated, pre-existing race**, confirmed via bullmq's own
   source (`Job.prototype.getState()` is a separate redis read from the
   `jobQueue.getJob(id)` fetch that produced the `job` instance in the
   first place, and never refreshes that instance's fields): if a job
   transitions to a terminal state in the gap between those two reads,
   `JobControl.getJob`'s `job.failedReason`/`job.returnvalue` can still
   reflect the pre-transition (empty) snapshot even though `state`
   correctly reports the job as done — visible as `tasks/result` returning
   the generic `"task failed"` fallback text instead of the real reason.
   This isn't specific to the `code` fix above; it would just as easily
   have returned an empty `failedReason` string before this Sprint too,
   it simply had no test tight enough to notice. **Fix**: `getJob` now
   re-fetches the job once `state` resolves to `'completed'`/`'failed'`,
   so the returned fields reflect the same settled data the state itself
   does. Verified with a 40-concurrent-failing-task stress script (not
   part of the committed test suite, since it's a load-shaped
   confirmation rather than a deterministic unit assertion) — 40/40
   correctly returned `structuredContent.code`, 0/40 hit the generic
   fallback, after the fix; the race was only ever seen intermittently
   under real load (the full test suite), not reliably reproducible in
   isolation, which is exactly why it needed a stress run rather than a
   single-shot check to confirm.

## Decision: should the direct peer channel be rate-limited?

**Decision: not for this Sprint; revisit once composition has more than
one demo consumer.** Reasoning:

- The channel is currently only exercised by `composite-demo`, a module
  whose author (the platform operator, in this repo) controls both the
  calling and called code. There is no third-party-authored composing
  module yet, so there is no actual untrusted caller able to exploit the
  missing limit today.
- Rate-limiting this path correctly requires deciding *whose* budget an
  internal hop counts against — the outer MCP caller's apiKey (which,
  per `docs/composite-tools.md`'s documented simplification, isn't even
  threaded down to inner hops yet), the composing module's own fixed
  identity, or a per-hop-target limit independent of caller. That's a
  real design question, not a one-line fix, and shouldn't be decided
  as a side effect of filling in this table.
- The absence of a limit here is exactly why this table exists: the gap
  is now visible and load-bearing on this decision, not silently
  assumed away. When a real (non-demo, third-party-authored) composing
  module is built, rate-limiting the direct peer channel — most likely
  by threading the real caller's apiKey through `ServiceClient` and
  reusing the existing per-apiKey limiter — becomes a hard prerequisite,
  not a nice-to-have.
