# Cross-cutting concern coverage matrix

Sprint 3/4 found the same shape of bug three times in a row: a new entry
path was added, and one or more cross-cutting concerns (authorization,
metering, rate limiting) silently didn't apply to it, because those
concerns live as calls scattered across the code rather than as a single
gate every entry path is forced through. This document is the fix for
*that* pattern, not for any individual bug: it is a live inventory of
which entry path gets which guarantee, kept honest, so a gap is visible
in a table instead of discovered by an incident.

**Rule going forward: any PR that adds a new entry path must add its row to
this table before merging.** A blank cell is not an acceptable final state —
it must be filled in as either an implementation location or an explicit
"exempt" with a reason.

**And a missing row is worse than a blank cell.** A 2026-08-11 pre-release
review found four serious defects — including an unauthenticated
cross-tenant read of task output — on entry paths that had no row here at
all. The rule above was being read as "keep the existing rows accurate",
which it was; what it did not do was force anyone to notice that `tasks/*`,
`/balance`, the HTTP job routes, and the admin routes had never been
enumerated. That is the fourth occurrence of this document's founding bug
shape. See [`design-decisions.md`](design-decisions.md#every-entry-path-gets-a-row-before-it-ships)
for the rule that now backs this, and the "Rows added 2026-08-11" section
below for what was missing.

Verified by reading the actual code paths on 2026-08-09, not by
recalling how the system is supposed to work. File/line references are
called out so the claims here can be checked and re-checked as the code
changes.

## The matrix

| Entry path | userAuth (device ownership) | Schema validation | recordCall | rateLimit | Timeout | Error shape |
|---|---|---|---|---|---|---|
| **HTTP `POST /devices/:deviceID/invoke-action`** | ✅ `lib/routes/user.js` → `user-auth.js`, mounted ahead of the route (`lib/route-manager.js`) | ✅ `Service.prototype.invoke` → `validateActionCall` (`lib/service.js`) — the shared dispatch point every path below also funnels through | ✅ `Session.prototype.recordMeteredCall` (`lib/session.js`), fired from `response()` on success, opted in per request by `lib/routes/invoke-action.js` setting `session.meteredTool`. **This cell used to name `Session.prototype.updateRedisUserRecord`, which had already been retired by the AuthProvider refactor and never replaced** — so between that refactor and 2026-08-11 this path recorded nothing at all, and this table asserted otherwise. Verified with `--mcpToolCallCost 1`: one MCP `tools/call` moved the balance by 1, five successful HTTP `invoke-action` calls moved it by 0. Now uses the same `CdifInterface.prototype.recordCall`, the same `options.mcpToolCallCost`, and the same `encodeLegacyTool(deviceID, serviceID, actionName)` metering identity every other entry path uses, so the same action billed over HTTP and over MCP produces one shared record rather than two parallel ones. Test: `test/auth/09-http-invoke-action-metering.js` | ✅ `CdifInterface.prototype.invokeDeviceAction`: global limiter (main thread only) + per-apiKey `this.rateLimit()` (`lib/countinghouse-interface.js`) | ✅ `Session`'s own timer, `options.requestTimeout` (default 30000ms) | `{topic, code, message[, fault]}` JSON body (`lib/session.js:81,105,107`) — `code` is the locale-independent field added in Sprint 4 |
| **MCP `tools/call` (synchronous)** | ✅ same `userAuth` call, invoked directly in `lib/mcp/gateway.js:143` | ✅ same shared path — goes through `cdifInterface.invokeDeviceAction` exactly like HTTP | ✅ explicit call in `gateway.js` (`handleToolsCall`), cost = `options.mcpToolCallCost`, fire-and-forget, recorded under `encodeLegacyTool(deviceID, serviceID, actionName)` rather than the MCP tool name so HTTP/MCP/cross-worker all share one metering identity | ✅ same `invokeDeviceAction` gate as HTTP (this call is *inside* `invokeDeviceAction`, not a separate check) | ✅ same `Session` timer as HTTP (this path constructs and uses a `Session` too) | `toolCallResult()` (`gateway.js:83`) — includes `err.code` (when present) as `structuredContent.code`, fixed 2026-08-09, see Findings |
| **MCP `tools/call` (task-augmented, `params.task`)** | ✅ fixed 2026-08-09 — `createTaskForToolCall` (`gateway.js:164`) now calls `userAuth` before task creation, same gate and same `JSONRPC_INTERNAL_ERROR` failure shape as the synchronous path; the resulting `session` is discarded (job execution stays on its separate `JobControl.addJob`/`invokeJobs` path, which still takes no appKey) — this is purely an authorization check, not a rewire of execution. Regression test: `test/unit/test031.js` | ✅ same shared `validateActionCall` path (execution still runs through the normal action dispatch, only the surrounding gate is skipped) | ✅ `job-control.js`'s `initJobProcess` worker callback, fires after job completion using `jobData.apiKey` — which is now taken from the authenticated `authCtx` at creation time, never from caller-supplied `jobOpts` (see S2 in the findings below) | ✅ but only checked once, at task *creation* (`gateway.js:193-200`), not re-checked at execution — a deliberate choice (queue growth is the actual resource being protected), documented in-code | ✅ bullmq `job.opts.timeout`, reimplemented via `setTimeout` (`job-control.js:59-68`, needed because bullmq dropped bull's built-in job timeout) | Same `toolCallResult()` as sync path — `structuredContent.code` fix applies here too, via a second fix: `job-control.js`'s worker now encodes `"CODE: message"` into the rejected error before bullmq flattens it to `job.failedReason` (a plain string that drops any custom property otherwise), and `handleTasksResult` decodes it back out. Regression test: `test/unit/test032.js` |
| **Event channel (`socket.io` `subscribe`/`disconnect`, `lib/socket-server.js`)** | ➖ **removed in 5.0.0** — the whole event-delivery subsystem (`--sioServer`, `--wsServer`, `lib/socket-server.js`, `lib/ws-server.js`, `lib/subscriber.js`, `lib/ws-subscriber.js`, the `event-sub`/`event-unsub`/`wss` routes and `test/socket-server/`) was deleted, together with the `--apiCache` response cache it was gated on (`Service.prototype.subscribeEvent` refused any subscription unless `--apiCache` was on *and* the action declared `apiCache`). It was removed as dead code, not as a working feature: a successful `subscribe` registered no listener and `Subscriber.prototype.publish` was never called from anywhere, so an event was never actually delivered to a subscriber. The auth story described in this row was real and did work — it is kept here so that whoever reinstates event delivery knows what the bar was. | ➖ | ➖ | ➖ | ➖ | ➖ |
| **Direct peer channel — main-thread-routed** (`ServiceClient.invoke` with `isRemoteThread: true`, `--directPeerChannels` **off**, the default — the mechanism `composite-demo` uses to call other modules in-process) | ⚠️ **checked once, on the main thread, before routing** — `DeviceManager.prototype.sendInvokeActionMessageToWorker` (`lib/device-manager.js:361`) calls `userAuth` before dispatching to the callee's worker. But the callee worker's own re-entry point (`invoke-action` case in `lib/sandbox.js:68-79`) calls `ci.invokeDeviceAction(...)` with a **plain callback function as the `session` argument**, not a `Session` object — see rateLimit finding below, same root cause also means no *second* userAuth check happens worker-side (by construction there's only ever one) | ✅ same shared `validateActionCall` — the callee's action still executes through the normal per-worker dispatch, indistinguishable from a locally-triggered call | ✅ **automatic (D5, extended here), platform-level.** `DeviceManager.prototype.sendInvokeActionMessageToWorker` (`lib/device-manager.js`) calls `CHUtil.ci.recordCall(...)` directly on the main thread right after the callee replies and before relaying the reply to the caller — same `MeteringProvider.recordCall` every other entry path uses. The result is threaded back to the calling module as a 3rd, additive `platformMetering` argument on `ServiceClient.invoke()`'s callback (`function(err, data, platformMetering)`), deliberately never merged into `data` itself (`data` is the callee action's own already-validated output; some modules pass it straight through as their own return value, so an injected field there fails that pass-through's own schema validation — found the hard way, see `docs/composite-tools.md`'s "billing authority" principle). This closes the gap this cell used to document: a module that composes other modules without metering itself now still gets billed correctly, on this path exactly like the row below. `CHUtil.recordCall` (module-facing) no longer exists — replaced by `CHUtil.recordUsage`, app-layer bookkeeping only, no balance effect. Test: `test/direct-peer-channels/06-no-double-billing.js` (flag off case). **Verified, explicit behavior when the caller's identity can't be resolved** (e.g. a module built via `CHUtil.createServiceClient({..., ctx: someSession})` where `someSession.appKey` is `null`/`undefined` — every bundled example module hardcodes a real `appKey` instead, so this is a *reachable but currently unexercised* path, not a hypothetical): `RedisMeteringProvider.prototype.recordCall`'s own `if (apiKey == null) return callback(new Error('apiKey is required'))` guard fires, `sendInvokeActionMessageToWorker` catches that error, logs it server-side (`LOG.E`), and still completes the call — `platformMetering` on the caller's 3rd callback argument comes back `null`, and **no apiKey's balance is touched anywhere**, not even a placeholder/`"undefined"` key. Confirmed empirically (scratch fixture with a `ctx`-based, appKey-less `ServiceClient`, `--mcpToolCallCost 1`, both flag states): call succeeds, `"apiKey is required"` appears in the server log, balance unchanged. **Fixed in 6.0.0.** This used to read: an internal hop whose identity can't be resolved is metered for free, indefinitely, with no caller-visible signal — a real, if narrow, monetization gap. Such a hop is now refused with `HOP_IDENTITY_UNRESOLVED` rather than served: the check sits before `recordCall`, not on its error, because a `recordCall` failure can also mean Redis is down and this codebase deliberately fails *open* on infrastructure. Unresolvable identity is not infrastructure failure — it is a call nobody can be charged for. Note the identity being checked is now `billingKey`, which since 6.0.0 may differ from the `appKey` userAuth ran on (see `docs/composite-tools.md`). Test: `test/auth/13-ctx-billing-identity.js` | ❌ **not enforced**, for a specific, verified reason: the callee-side re-entry (`sandbox.js:68-79`) passes a bare function as `invokeDeviceAction`'s `session` parameter. `checkApiKeyRateLimit` in `countinghouse-interface.js` reads `session.appKey`, which is `undefined` on a plain function, so the `if (session.appKey == null) return doInvoke();` early-return fires unconditionally — the rate-limit check is skipped, not merely absent. The main-thread global limiter is also inapplicable here since the callee-side call runs with `isMainThread === false`. Net effect: an internal hop is **never** rate-limited, regardless of `--apiKeyRateLimit` | ✅ `session.setDeviceTimer(calleeWM, ...)` set on the main thread before dispatch (`device-manager.js:364`), same underlying mechanism as HTTP/MCP | Raw `DeviceError`/Error object returned via a Node-style `(err, data)` callback to the calling module's own code (`ServiceClient.invoke`, `lib/service-client.js:57-72`) — `err.code` survives the worker boundary (Sprint 4's `worker-message.js` fix). Not an HTTP/MCP envelope; shaping for any external caller is entirely up to the calling module |
| **Direct peer channel — `--directPeerChannels`** (opt-in, off by default; `ServiceClient.invoke` with `isRemoteThread: true` when the flag is on — same call sites as the row above, different code path. See `docs/design-decisions.md#direct-peer-channels-five-decisions-d1d5`/`docs/direct-peer-channels.md`) | ⚠️ **checked at brokering time, not per call — and the credential it issues is scoped to a *worker*, not to a device** (D3). `PeerChannelBroker.prototype.handleRequest` (`lib/peer-channel-broker.js`) runs the *same* `userAuth` device-ownership check the row above uses, but before granting a port rather than before every routed call. Test: `test/direct-peer-channels/03-grant-time-auth.js` (unauthorized module's brokering request denied, fast, `SYSTEM_ERROR_UNKNOWN_USER`). **Corrected 2026-08-11 — this cell previously claimed "a second device hosted by an *already-connected* worker still gets its own fresh `userAuth` check". That is true of the brokering path but not of the port, and the distinction matters:** `DeviceManager.prototype.invokeActionViaPeerChannel` keys `peerDeviceWorkerMap` by deviceID, so reaching a *new* deviceID through `ServiceClient` does re-broker and does re-run `userAuth` — but the broker hands back a port keyed by worker pair (`callerWorkerId:calleeWorkerId`), and the callee never retains which deviceID that port was granted for: `DeviceManager.prototype.onPeerChannelOpen` reads only `msg.callerWorkerId`/`msg.appKey`/`msg.port` and drops `msg.targetDeviceID`, then its `onInvoke` calls `invokeDeviceAction(request.deviceID, ...)` with whatever deviceID arrives over the wire. **So possession of one port is authorization for every device that callee worker hosts**, and module code can exercise that directly (`CHUtil.dm` is set in `lib/countinghouse-interface.js`'s constructor and `CHUtil` is a module-visible global, so `CHUtil.dm.peerChannels[workerId].invoke(anyDeviceID, ...)` is reachable) rather than only through `ServiceClient`. This is a consequence of D3's deliberate trade, not a defect on top of it — it is written down here because "possession of the port = authorization" only bounds risk once you also know *what a port is possession of*. Bounded to co-hosted devices: a deviceID the callee worker doesn't host fails in its own `deviceMap` lookup, so this never crosses a worker boundary. Consistent with `docs/security-model.md`'s scope — AuthProvider constrains which apiKey may invoke which device, not what a loaded module's own code can do | ✅ same shared `validateActionCall` — the callee's `onInvoke` handler (`DeviceManager.prototype.onPeerChannelOpen`) calls `CHUtil.ci.invokeDeviceAction(...)`, the same entry point `sandbox.js`'s pre-existing `invoke-action` case uses | ✅ **automatic (D5), platform-level, same guarantee as the row above.** `DeviceManager.prototype.onPeerChannelOpen`'s `onInvoke` closure (`lib/device-manager.js`) times every incoming call, then makes a *synchronous request/reply* to the main thread (`sendPeerMeteringRequestToParent`/`sendPeerMeteringReplyToChild`, `lib/worker-message.js` — not fire-and-forget anymore) so the callee only replies to the caller once billing is confirmed; `PeerChannelBroker.prototype.handleMeteringRequest` (`lib/peer-channel-broker.js`) consumes the request and calls `CHUtil.ci.recordCall(callerModule, tool, options.mcpToolCallCost, ...)` — the exact same `MeteringProvider.recordCall` every other entry path uses. The result rides back as a 3rd, additive `platformMetering` argument on `ServiceClient.invoke()`'s callback, same as the row above (never merged into `data`). Test: `test/direct-peer-channels/04-metering.js` (a single hop bills exactly once, asserted via balance delta with a nonzero `--mcpToolCallCost`). **Fixed: no longer double-bills.** Previously, a module that also metered itself explicitly (like `composite-demo`) got billed twice once this flag was on — its own `CHUtil.recordCall` *and* this automatic charge both fired for the same hop (observed: 3× cost for a 2-hop call, not 2×). Fixed by making platform metering the sole, unconditional billing authority on *both* paths (this row and the one above) and removing the module-facing `CHUtil.recordCall` entirely (replaced by `CHUtil.recordUsage`, app-layer bookkeeping only, no balance effect) — a module can no longer double-bill itself through that API even if it tries. Test: `test/direct-peer-channels/06-no-double-billing.js` (both flag states; asserts a 2-hop composite call deducts exactly 2× cost and `bill` still shows 2 independent records). **Same unresolvable-identity behavior as the row above, verified on this path too**: `PeerChannelBroker.prototype.handleMeteringRequest` guards `CHUtil.ci == null` but not `data.callerModule == null` — an appKey-less `ServiceClient` still reaches `CHUtil.ci.recordCall(undefined, ...)`, which errors with `"apiKey is required"`, gets logged (`LOG.E`) and replied back as an error on the `peer-metering-reply` wire message; `onPeerChannelOpen`'s `onInvoke` catches that (`if (meteringErr != null) LOG.E(meteringErr)`) and still replies to the caller with `platformMetering: null` — call succeeds, no balance touched, **also fixed in 6.0.0**, same rule and same reasoning as the main-thread-routed row above (`HOP_IDENTITY_UNRESOLVED`, checked before the metering request); on this path `billingKey` travels per call on the peer-channel request rather than being taken from the grant, because D1 keys a port by worker pair and one port carries calls made for many different outer callers | ❌ **not enforced**, same conclusion as the row above but for a different, specific reason: nothing in `lib/peer-channel.js`/`lib/peer-channel-broker.js` calls `rateLimit` anywhere, at either brokering or per-call time. Unlike the main-thread-routed row, this isn't a passed-a-plain-function accident — the direct-channel path was built specifically to avoid touching the main thread per call, and `rateLimit`'s existing implementation is main-thread/Redis-backed, so enforcing it per call here would reintroduce the very main-thread round trip this feature exists to eliminate. Matches this table's own already-recorded decision (below) not to rate-limit the direct peer channel this Sprint | ✅ two independent timeouts: `PeerChannel.prototype.invoke`'s own per-call timer (`lib/peer-channel.js`, `options.requestTimeout`, no main-thread fallback exists on this path so a hung callee must be caught locally) *and* fast failure via D4 invalidation (`PEER_GONE`) if the port dies mid-call instead of silently hanging until that timer fires — see `test/direct-peer-channels/02-invalidation-on-restart.js`, which specifically asserts race calls resolve in `<5s`, not near the 30s worst case | Raw `DeviceError`/Error via a Node-style `(err, data)` callback, same shape as the row above (`err.code` reconstructed from the wire message in `PeerChannel.prototype._handleReply`) — new codes specific to this path: `PEER_GONE`, `PEER_CHANNEL_TIMEOUT`, `PEER_SELF_TARGET`, `PEER_NO_HANDLER` (all in `lib/error-info.*.json`, both locales) |

### Rows added 2026-08-11 (previously missing entirely)

An independent pre-release review found that this table had rows for the
entry paths someone remembered to add, not for every entry path that exists.
Four of the six most serious findings were on paths with **no row at all** —
a blank cell is visible, a missing row is not. These are those rows.

| Entry path | userAuth / ownership | Schema validation | recordCall | rateLimit | Timeout | Error shape |
|---|---|---|---|---|---|---|
| **MCP `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel`** | ✅ **fixed 2026-08-11 — previously none at all.** These four took no `appKey` parameter, so there was nothing in scope to check: an anonymous caller could read any tenant's task output, enumerate every task, and delete tasks it didn't create (verified live, not inferred). Now `resolveCallerIdentity` (`lib/mcp/gateway.js`) resolves the key through the same `doUserAuth`/AuthProvider path every other entry path uses, and `lib/job-control.js` enforces per-job ownership: the creator's authenticated apiKey, `isAdmin` may cross tenants, `tasks/list` filters to the caller's own. Unknown/absent key ⇒ refused. A job with no recorded owner is admin-only. Test: `test/auth/07-task-ownership.js` | ➖ exempt — these methods read and cancel existing tasks; they carry no action payload to validate. The underlying action's input was validated at `tools/call` time | ➖ exempt — reading or cancelling a task is not itself a billable action. The task's own execution is metered on the task-augmented `tools/call` row above | ❌ none. Not currently limited; these are cheap Redis reads, but a per-apiKey limit here would be consistent with the rest of the table. Recorded, not fixed | ➖ exempt — no device call is made | JSON-RPC error object (HTTP 200 per JSON-RPC 2.0 framing), same shape `tools/call`'s own `userAuth` failure already used. `tasks/get`/`result` deliberately return the *same* `unknown task` message for "doesn't exist" and "isn't yours", so taskIds can't be enumerated by probing |
| **HTTP `POST /devices/:deviceID/{get,remove}-job`, `get-job-history`** | ✅ **fixed 2026-08-11 — two layers.** `lib/routes/user.js`'s per-request `userAuth` (device access) as before, plus the same per-job ownership check `tasks/*` uses, applied in `lib/job-control.js` rather than at either front door — gating only the MCP gateway would have left these three as the bypass. Closes this route's own long-standing in-code TODO ("arbitrary user can remove someone else's jobs"). **Known narrowing**: removing a repeatable job *scheduler* (`isRepeat: true`) now requires admin — bullmq's scheduler record carries no owner field to match against, so an unattributable delete is restricted to the operator rather than left open. Per-scheduler ownership would need its own persisted record; deliberately not decided here. Test: `test/auth/07-task-ownership.js` | ➖ exempt — same reason as the MCP row above | ➖ exempt for the read routes. `add-job` is metered on job completion (`job-control.js`), billed to the authenticated creator | ✅ inherited from `lib/routes/user.js` → the standard route stack; the job's *execution* additionally passes through `invokeDeviceAction`'s limiters | ➖ exempt — no synchronous device call | `{topic, code, message}` JSON body via `Session.prototype.callbackWithoutTimer`, `code` = `JOB_ACCESS_DENIED` for a non-owner |
| **HTTP `POST /devices/:deviceID/add-job`** | ✅ `lib/routes/user.js` → `user-auth.js`, same as every other device-scoped route. **Fixed 2026-08-11**: the job's owner/billing subject is now the authenticated caller, passed out-of-band as `authCtx`; previously it was read from the request body's `opts.apiKey`, letting any valid key bill and impersonate any other (verified: alice's request moved mallory's balance). The route additionally whitelists the scheduling fields it accepts. Test: `test/auth/08-job-billing-identity.js` | ✅ at execution time, via the same shared `validateActionCall` | ✅ on job completion (`job-control.js`'s `initJobProcess`), against `jobData.apiKey` — now necessarily the authenticated creator | ✅ route stack | ✅ bullmq `job.opts.timeout`, reimplemented via `setTimeout` | `{topic, code, message}` JSON body |
| **HTTP `GET /balance`** and the **`countinghouse_check_balance` MCP tool** | ✅ **fixed 2026-08-11 — previously none.** Both handed the raw header value to `MeteringProvider.checkBalance` without consulting AuthProvider, so any invented string got `200 {"balance": 0}` — an unauthenticated balance oracle. Both now go through `doUserAuth` with `deviceID: null` (a balance belongs to an apiKey, not a device) and read back the *authenticated session's* appKey, so a caller can only ever ask about itself. Test: `test/auth/10-balance-auth.js` | ➖ exempt — no action payload | ➖ exempt — reading a balance is not a billable call | ❌ none. An authenticated caller can still poll this as fast as it likes; each request is one Redis round trip. Recorded, not fixed | ➖ exempt | HTTP: `403 {topic, code, message}` with `code: SYSTEM_ERROR_UNKNOWN_USER`. MCP: `toolCallResult()`'s error branch, no balance value present anywhere in the body |
| **HTTP module-lifecycle routes** (`/load-module`, `/unload-module`, `/restart-module`, `/verify-module`, `/reload-module`, `/shutdown`, `GET /get-module-device-list`) | ✅ `lib/routes/admin-only.js`, mounted ahead of each route in `lib/route-manager.js`. Requires `isAdmin` on the resolved session — a *separate* capability from device access, so a `devices: ['*']` key is still refused. Previously mounted only under `--debug`/`--verifyModule`; now always mounted and gated per request. Tests: `test/auth/06-admin-gating.js`, `test/auth/11-admin-module-lifecycle.js` | ➖ exempt — no device action; these take a module path/name | ➖ exempt — operator actions, not tenant calls | ❌ none. Deliberate: these are operator endpoints, and rate-limiting an operator out of `/shutdown` during an incident is the wrong failure mode | ➖ exempt | `403 {topic, code, message}` with `code: ADMIN_REQUIRED` (or `SYSTEM_ERROR_UNKNOWN_USER` for a key AuthProvider doesn't know) |
| **HTTP `/callbacks/:deviceID`, OpenStack simulation routes** | ➖ **exempt, deliberately and by design** — both are mounted ahead of `lib/routes/user.js` in `lib/route-manager.js` and the code says so at each mount point ("callback don't do user auth", "openstack api simulation don't do user auth"). `/callbacks` receives inbound calls from third-party services that have no countinghouse apiKey to present; the OpenStack routes exist only under `--simOpenStackAPI`. (`/devices/:deviceID/wss` was listed here too until 5.0.0 removed it with the rest of the event subsystem — see the event-channel row.) Listed here so their exemption is a recorded decision rather than an omission — **and flagged: `/callbacks` is genuinely unauthenticated and reachable whenever the server is, which deserves its own review before any public deployment** | ⚠️ not traced | ❌ none | ❌ none | varies | varies |

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
