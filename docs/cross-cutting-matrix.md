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
| **Event channel (`socket.io` `subscribe`/`disconnect`, `lib/socket-server.js`)** | ✅ two layers, same `doUserAuth`/AuthProvider every HTTP/MCP path uses: a handshake-time identity check (`io.use()`, apiKey read from `socket.handshake.auth.apiKey`) rejects an unknown/missing key before the socket connects at all, then a per-`subscribe` device-access check (`deviceID` from the payload) mirrors `lib/routes/user.js`'s per-request check — a valid-but-unscoped key can connect but gets `USER_HAS_NO_DEVICE` on `subscribe`. Tests: `test/socket-server/01-subscribe-auth.js`. | ⚠️ unclear/likely none — `subscribe` goes through `CdifInterface.prototype.eventSubscribe` → `DeviceManager.prototype.onEventSubscribe`, a separate code path from `Service.prototype.invoke` that was not traced to a schema check | ❌ none. No `recordCall` anywhere on this path | ❌ none. `eventSubscribe`/`eventUnsubscribe` on `CdifInterface` call `deviceManager.emit(...)` directly, bypassing both the global and per-apiKey limiter machinery in `invokeDeviceAction` | ❌ no timeout observed on subscribe itself (long-lived by nature) | `{topic, code, message}` emitted back over the socket as an `'error'` event (subscribe-time failures) or via `connect_error`'s `.data` (handshake-time failures) — shape matches HTTP, `code` preserved |
| **Direct peer channel — main-thread-routed** (`ServiceClient.invoke` with `isRemoteThread: true`, `--directPeerChannels` **off**, the default — the mechanism `composite-demo` uses to call other modules in-process) | ⚠️ **checked once, on the main thread, before routing** — `DeviceManager.prototype.sendInvokeActionMessageToWorker` (`lib/device-manager.js:361`) calls `userAuth` before dispatching to the callee's worker. But the callee worker's own re-entry point (`invoke-action` case in `lib/sandbox.js:68-79`) calls `ci.invokeDeviceAction(...)` with a **plain callback function as the `session` argument**, not a `Session` object — see rateLimit finding below, same root cause also means no *second* userAuth check happens worker-side (by construction there's only ever one) | ✅ same shared `validateActionCall` — the callee's action still executes through the normal per-worker dispatch, indistinguishable from a locally-triggered call | ✅ **automatic (D5, extended here), platform-level.** `DeviceManager.prototype.sendInvokeActionMessageToWorker` (`lib/device-manager.js`) calls `CHUtil.ci.recordCall(...)` directly on the main thread right after the callee replies and before relaying the reply to the caller — same `MeteringProvider.recordCall` every other entry path uses. The result is threaded back to the calling module as a 3rd, additive `platformMetering` argument on `ServiceClient.invoke()`'s callback (`function(err, data, platformMetering)`), deliberately never merged into `data` itself (`data` is the callee action's own already-validated output; some modules pass it straight through as their own return value, so an injected field there fails that pass-through's own schema validation — found the hard way, see `docs/composite-tools.md`'s "billing authority" principle). This closes the gap this cell used to document: a module that composes other modules without metering itself now still gets billed correctly, on this path exactly like the row below. `CHUtil.recordCall` (module-facing) no longer exists — replaced by `CHUtil.recordUsage`, app-layer bookkeeping only, no balance effect. Test: `test/direct-peer-channels/06-no-double-billing.js` (flag off case). **Verified, explicit behavior when the caller's identity can't be resolved** (e.g. a module built via `CHUtil.createServiceClient({..., ctx: someSession})` where `someSession.appKey` is `null`/`undefined` — every bundled example module hardcodes a real `appKey` instead, so this is a *reachable but currently unexercised* path, not a hypothetical): `RedisMeteringProvider.prototype.recordCall`'s own `if (apiKey == null) return callback(new Error('apiKey is required'))` guard fires, `sendInvokeActionMessageToWorker` catches that error, logs it server-side (`LOG.E`), and still completes the call — `platformMetering` on the caller's 3rd callback argument comes back `null`, and **no apiKey's balance is touched anywhere**, not even a placeholder/`"undefined"` key. Confirmed empirically (scratch fixture with a `ctx`-based, appKey-less `ServiceClient`, `--mcpToolCallCost 1`, both flag states): call succeeds, `"apiKey is required"` appears in the server log, balance unchanged. Net effect: **an internal hop whose identity can't be resolved is metered for free, indefinitely, with no caller-visible signal** — this is a real, if narrow, monetization gap (not a crash or hang), not fixed here since the behavior itself wasn't judged wrong, only previously undocumented | ❌ **not enforced**, for a specific, verified reason: the callee-side re-entry (`sandbox.js:68-79`) passes a bare function as `invokeDeviceAction`'s `session` parameter. `checkApiKeyRateLimit` in `countinghouse-interface.js` reads `session.appKey`, which is `undefined` on a plain function, so the `if (session.appKey == null) return doInvoke();` early-return fires unconditionally — the rate-limit check is skipped, not merely absent. The main-thread global limiter is also inapplicable here since the callee-side call runs with `isMainThread === false`. Net effect: an internal hop is **never** rate-limited, regardless of `--apiKeyRateLimit` | ✅ `session.setDeviceTimer(calleeWM, ...)` set on the main thread before dispatch (`device-manager.js:364`), same underlying mechanism as HTTP/MCP | Raw `DeviceError`/Error object returned via a Node-style `(err, data)` callback to the calling module's own code (`ServiceClient.invoke`, `lib/service-client.js:57-72`) — `err.code` survives the worker boundary (Sprint 4's `worker-message.js` fix). Not an HTTP/MCP envelope; shaping for any external caller is entirely up to the calling module |
| **Direct peer channel — `--directPeerChannels`** (opt-in, off by default; `ServiceClient.invoke` with `isRemoteThread: true` when the flag is on — same call sites as the row above, different code path. See `docs/design-decisions.md#direct-peer-channels-five-decisions-d1d5`/`docs/direct-peer-channels.md`) | ✅ **checked once per (callerWorkerId, targetDeviceID), at brokering time, not per call** (D3) — `PeerChannelBroker.prototype.handleRequest` (`lib/peer-channel-broker.js`) runs the *same* `userAuth` device-ownership check the row above uses, but before granting a port rather than before every routed call. Once granted, the port itself is the ongoing credential — "possession of the port = authorization" is a deliberate model, documented in `lib/peer-channel-broker.js`'s header comment, not an oversight: a second device hosted by an *already-connected* worker still gets its own fresh `userAuth` check (see `PeerChannelBroker.prototype.grant`'s "already connected" branch), but a call to a device that already has a live port never re-checks. Test: `test/direct-peer-channels/03-grant-time-auth.js` (unauthorized module's brokering request denied, fast, `SYSTEM_ERROR_UNKNOWN_USER`) | ✅ same shared `validateActionCall` — the callee's `onInvoke` handler (`DeviceManager.prototype.onPeerChannelOpen`) calls `CHUtil.ci.invokeDeviceAction(...)`, the same entry point `sandbox.js`'s pre-existing `invoke-action` case uses | ✅ **automatic (D5), platform-level, same guarantee as the row above.** `DeviceManager.prototype.onPeerChannelOpen`'s `onInvoke` closure (`lib/device-manager.js`) times every incoming call, then makes a *synchronous request/reply* to the main thread (`sendPeerMeteringRequestToParent`/`sendPeerMeteringReplyToChild`, `lib/worker-message.js` — not fire-and-forget anymore) so the callee only replies to the caller once billing is confirmed; `PeerChannelBroker.prototype.handleMeteringRequest` (`lib/peer-channel-broker.js`) consumes the request and calls `CHUtil.ci.recordCall(callerModule, tool, options.mcpToolCallCost, ...)` — the exact same `MeteringProvider.recordCall` every other entry path uses. The result rides back as a 3rd, additive `platformMetering` argument on `ServiceClient.invoke()`'s callback, same as the row above (never merged into `data`). Test: `test/direct-peer-channels/04-metering.js` (a single hop bills exactly once, asserted via balance delta with a nonzero `--mcpToolCallCost`). **Fixed: no longer double-bills.** Previously, a module that also metered itself explicitly (like `composite-demo`) got billed twice once this flag was on — its own `CHUtil.recordCall` *and* this automatic charge both fired for the same hop (observed: 3× cost for a 2-hop call, not 2×). Fixed by making platform metering the sole, unconditional billing authority on *both* paths (this row and the one above) and removing the module-facing `CHUtil.recordCall` entirely (replaced by `CHUtil.recordUsage`, app-layer bookkeeping only, no balance effect) — a module can no longer double-bill itself through that API even if it tries. Test: `test/direct-peer-channels/06-no-double-billing.js` (both flag states; asserts a 2-hop composite call deducts exactly 2× cost and `bill` still shows 2 independent records). **Same unresolvable-identity behavior as the row above, verified on this path too**: `PeerChannelBroker.prototype.handleMeteringRequest` guards `CHUtil.ci == null` but not `data.callerModule == null` — an appKey-less `ServiceClient` still reaches `CHUtil.ci.recordCall(undefined, ...)`, which errors with `"apiKey is required"`, gets logged (`LOG.E`) and replied back as an error on the `peer-metering-reply` wire message; `onPeerChannelOpen`'s `onInvoke` catches that (`if (meteringErr != null) LOG.E(meteringErr)`) and still replies to the caller with `platformMetering: null` — call succeeds, no balance touched, same free-metering gap as the main-thread-routed row | ❌ **not enforced**, same conclusion as the row above but for a different, specific reason: nothing in `lib/peer-channel.js`/`lib/peer-channel-broker.js` calls `rateLimit` anywhere, at either brokering or per-call time. Unlike the main-thread-routed row, this isn't a passed-a-plain-function accident — the direct-channel path was built specifically to avoid touching the main thread per call, and `rateLimit`'s existing implementation is main-thread/Redis-backed, so enforcing it per call here would reintroduce the very main-thread round trip this feature exists to eliminate. Matches this table's own already-recorded decision (below) not to rate-limit the direct peer channel this Sprint | ✅ two independent timeouts: `PeerChannel.prototype.invoke`'s own per-call timer (`lib/peer-channel.js`, `options.requestTimeout`, no main-thread fallback exists on this path so a hung callee must be caught locally) *and* fast failure via D4 invalidation (`PEER_GONE`) if the port dies mid-call instead of silently hanging until that timer fires — see `test/direct-peer-channels/02-invalidation-on-restart.js`, which specifically asserts race calls resolve in `<5s`, not near the 30s worst case | Raw `DeviceError`/Error via a Node-style `(err, data)` callback, same shape as the row above (`err.code` reconstructed from the wire message in `PeerChannel.prototype._handleReply`) — new codes specific to this path: `PEER_GONE`, `PEER_CHANNEL_TIMEOUT`, `PEER_SELF_TARGET`, `PEER_NO_HANDLER` (all in `lib/error-info.*.json`, both locales) |

**Update (2026-08-09): every `userAuth` cell above now means "via `AuthProvider`."**
`lib/user-auth.js`'s non-debug branch used to run inline
Redis-cache-then-CouchDB logic; it now delegates entirely to the
configured `AuthProvider` (`lib/auth/`, default `FileAuthProvider` —
`SqliteAuthProvider` and `CouchDBAuthProvider` are the other two built-in
options, `--authProvider file|sqlite|couchdb`). This is a single, global
change to what `userAuth` does *internally* — every cell's description of
*where/when* the check happens (which file, which point in the request
lifecycle, once-at-brokering vs. once-per-call, etc.) is unchanged and
still accurate; only the backend answering "is this apiKey allowed to do
X" changed. `--debug` mode's own separate fast-path (unaffected by any of
this) is still what every existing test in this repo runs under; the new
non-debug behavior is covered by `test/auth/*.js`
(see [`design-decisions.md`](design-decisions.md#authprovider-three-pluggable-backends-one-narrow-interface)
for the backend design rationale — building the AuthProvider abstraction
also turned up two real, previously undocumented findings: the
unresolvable-identity metering gap already recorded in the two "Direct
peer channel" rows' `recordCall` cells above, and a missing `err.code` on
HTTP's own auth-failure response, fixed alongside this refactor since no
prior test had ever exercised that branch).

## MCP `tools/list` visibility (not previously tracked as its own concern)

`lib/mcp/tool-registry.js`'s `tools/list` handler used to always list
every loaded device's tools, regardless of the calling apiKey — an
unauthorized caller couldn't *invoke* a tool it didn't own (the `userAuth`
row above still denied that at `tools/call` time), but it could always
*see* it, with a schema that silently degraded to a default/unresolved
shape for a device it couldn't access rather than being omitted. Fixed
2026-08-09, alongside the AuthProvider refactor: `buildToolList` now
calls `filterTargetsByAuth`, which asks the configured `AuthProvider`'s
`listDevices(apiKey, ...)` for the caller's authorized device set (a `'*'`
entry means every currently-loaded device) and drops any tool whose
`deviceID` isn't in it, before schema resolution ever runs. The static
platform tool (`countinghouse_check_balance`) isn't device-derived and is
always listed, same as before. Under `--debug` mode this filtering is
skipped entirely, matching every other entry path's "no per-device
enforcement in debug mode" model — an anonymous or unauthorized caller in
non-debug mode now sees only the platform tool, nothing device-derived.
Test: `test/auth/01-file-provider-tools-list-filtering.js` (a wildcard
key sees every device tool, a device-scoped key sees only its own, an
unknown/anonymous caller sees none — and a `tools/call` for a tool
filtered out of the list is independently denied too, not just hidden
from discovery).

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

**Update (docs/design-decisions.md's D1-D5 implementation):**
this decision was written when "the direct peer channel" meant only the
pre-existing main-thread-routed `isRemoteThread` path (now the table's
first "Direct peer channel" row). Building the actual `--directPeerChannels`
opt-in path (D1-D5, second row) didn't reopen this decision — it was
implemented exactly as decided here, still unrated-limited, for the same
reasoning, which if anything is *stronger* for the new path specifically
(see that row's rateLimit cell: enforcing it per call there would
reintroduce the main-thread round trip the whole feature exists to
eliminate). Still no third-party composing module exists as of this
update.
