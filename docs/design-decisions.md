# Design decisions

This document collects the durable technical rationale behind a handful of
architecture decisions that don't fit naturally inside
[`security-model.md`](security-model.md), [`composite-tools.md`](composite-tools.md),
or [`direct-peer-channels.md`](direct-peer-channels.md) — the *why*, not the
*what*, for choices that would otherwise only live in commit messages.

## AuthProvider: three pluggable backends, one narrow interface

`AuthProvider` (`lib/auth/provider.js`) answers exactly one question: *can
this apiKey call this deviceID?* It deliberately does **not** know about
balance, rate limits, or per-action pricing — those are `MeteringProvider`'s
job (see the "Billing authority" section below). Keeping the interface this
narrow means a deployment can swap *who's allowed to call what* independently
of *how much it costs them*, and a new backend only has to implement two
methods (`authenticate`, `listDevices`) to be usable everywhere `userAuth`
is checked.

Three built-in implementations ship, chosen with `--authProvider file|sqlite|couchdb`
(see [`authentication.md`](authentication.md) for usage):

- **`FileAuthProvider`** (default) — a flat JSON file, zero external
  dependencies, and a zero-config first run: no `auth.json` yet means a
  demo key gets generated and printed automatically. This is the
  quickstart-friendly default specifically so a fresh checkout is
  immediately usable without standing up anything first.
- **`SqliteAuthProvider`** — same zero-external-service property as the
  file backend, but a real db file instead of hand-edited JSON, useful once
  there are more keys than are comfortable to maintain by hand. Managed via
  a small CLI (`bin/countinghouse-auth-sqlite.js`) against the db file
  directly, not an HTTP admin endpoint — an endpoint for managing *who can
  authenticate* would itself need authenticating, a circularity this
  doesn't need.
- **`CouchDBAuthProvider`** — for an existing CouchDB-backed deployment.
  `nano` is required lazily, only when this provider is actually selected,
  so it never has to be installed for the other two backends.

## Billing authority: platform metering is the only thing that deducts balance

Cross-worker calls (module A invoking module B's action) can be metered in
two conceptually different places: the calling module can meter itself
explicitly, or the platform can meter the call automatically at the point
where it crosses from one worker to another. Early on, only the second
existed on the opt-in `--directPeerChannels` path — the main-thread-routed
(default) path had no automatic metering, so `composite-demo` (see
[`composite-tools.md`](composite-tools.md)) metered itself explicitly to
produce its per-hop bill.

That combination double-billed the moment both mechanisms covered the same
call: turning `--directPeerChannels` on made a 2-hop composite call deduct
3× the per-hop cost instead of 2×, because the module's own explicit call
and the platform's new automatic charge both fired for the same hop.

**The fix establishes one rule: platform automatic metering is the sole,
unconditional billing authority for every cross-worker call, on both
routing paths.** The module-facing API that used to touch balance
(`CHUtil.recordCall`) was removed entirely and replaced with
`CHUtil.recordUsage` — pure application-layer bookkeeping that never
touches balance. A module literally cannot double-bill itself through that
API anymore, because the API it would use to try no longer has that power.
The real, authoritative billing result is threaded back to the calling
module as a third, additive callback argument
(`function(err, data, platformMetering) {...}`) — deliberately never merged
into `data` itself, since some modules pass `data` straight through as
their own action's return value, and an injected field there would fail
that pass-through's own output schema validation.

See [`composite-tools.md`](composite-tools.md#in-composition-metering) for
the full mechanism and [`cross-cutting-matrix.md`](cross-cutting-matrix.md)
for exactly which guarantee applies on which entry path.

## Direct peer channels: five decisions (D1–D5)

[`direct-peer-channels.md`](direct-peer-channels.md) covers what
`--directPeerChannels` does and its benchmark results. The five design
decisions below are the ones the implementation was built against and is
not expected to deviate from without deliberately revisiting them.

- **D1 — port topology: lazy, per-pair brokering.** Ports are not
  pre-wired between every worker at startup (that's O(n²) and can't handle
  modules loaded later). The first time worker A calls a device hosted by
  worker B, the main thread brokers a `MessageChannel` for that pair on
  demand; the port is cached and reused for later calls to the same
  worker, including calls to a *different* device it hosts.
- **D2 — wire protocol: reuse the existing request/response pattern, new
  instance.** The direct channel reuses the same msgID/msgQueue
  correlation style `WorkerMessage` already uses for the main-thread-routed
  path, but as an independent `PeerChannel` instance with its own ID
  space, so the two paths never share timeout or queue state.
- **D3 — security model: possession of the port is authorization.**
  Authorization is checked once, at brokering time (before a port is
  granted), not on every call that crosses it afterward. This is a
  deliberate trade — per-call authorization would reintroduce a main-thread
  round trip for every call, defeating the point of the direct path — not
  an oversight. Revocation happens through invalidation (D4): a port that
  should no longer work is closed, not left valid but unchecked.

  **A port is possession of a *worker*, not of a device.** This follows
  from D1 (ports are keyed by worker pair and reused for every device that
  worker hosts) and is spelled out here because "possession of the port =
  authorization" only bounds risk once you know what a port is possession
  of. The callee does not retain which deviceID its port was granted for —
  `DeviceManager.prototype.onPeerChannelOpen` drops `msg.targetDeviceID`
  and dispatches whatever `request.deviceID` arrives — so one granted port
  authorizes calls to every device on that callee worker. Going through
  `ServiceClient` still re-brokers (and so re-checks `userAuth`) for each
  new deviceID, because the caller-side map is keyed by device; but module
  code can reach the port directly and skip that. The blast radius is
  bounded to co-hosted devices — a deviceID the callee doesn't host fails
  its own `deviceMap` lookup — and sits inside the trust boundary
  [`security-model.md`](security-model.md) already draws: AuthProvider
  constrains which apiKey may invoke which device, not what a loaded
  module's own code can do. Tightening it would mean either passing the
  granted deviceID set to the callee and filtering there (cheap, no
  main-thread round trip, but the set has to be kept in sync on every
  subsequent grant) or one port per device (simple, but gives up D1's
  reuse). Neither is done today; the constraint is documented rather than
  assumed away. See [`cross-cutting-matrix.md`](cross-cutting-matrix.md)'s
  `--directPeerChannels` row for the same fact stated per-concern.
- **D4 — lifecycle: ports are invalidated on reload, unload, and crash.**
  This is treated as the most important of the five, because silent
  staleness is worse than a fast, explicit error. Two independent
  mechanisms cover it: the main thread broadcasts invalidation to affected
  peers when it observes a worker exit/reload/unload, *and* each
  `PeerChannel` independently watches its own port's native `close` event
  — so invalidation doesn't depend on the broadcast's timing or on the
  main thread being the one to notice first.
- **D5 — metering must not create a blind spot.** The direct path bypasses
  the main thread for data, but not for billing: every call is still
  metered, via a synchronous request/reply back to the main thread (not
  fire-and-forget) so the callee only replies to the original caller once
  billing has actually landed. See "Billing authority" above for how this
  combines with the main-thread-routed path's own metering to avoid
  double-charging.

## Every entry path gets a row before it ships

[`cross-cutting-matrix.md`](cross-cutting-matrix.md) exists because the same
bug shape kept recurring: a new way into the system was added, and one or
more cross-cutting concerns — authorization, ownership, metering, rate
limiting — silently didn't apply to it, because those concerns live as calls
scattered across the code rather than as one gate every entry path is forced
through.

A 2026-08-11 pre-release review made that shape recur for the **fourth**
time, and the recurrence is the interesting part: the matrix was accurate
about every path it listed. What it didn't do was list every path. `tasks/get`,
`tasks/result`, `tasks/list`, `tasks/cancel`, `GET /balance`, the four HTTP
job routes and the seven admin routes had never been enumerated, and four
serious defects were sitting on exactly those unlisted paths — including MCP
task methods that took no apiKey parameter at all, letting an anonymous
caller read, enumerate and delete any tenant's tasks.

**The rule: a change that adds or exposes an entry path is not complete
until that path has a row in the matrix, with every cell filled in as either
an implementation location or an explicit "exempt, because …".** Two
corollaries, both learned from this round:

- **A missing row is worse than a blank cell**, because a blank cell is
  visible in a table you are already reading and a missing row is not. When
  reviewing the matrix, check it against the actual route/method dispatch
  tables (`lib/route-manager.js`, `lib/mcp/gateway.js`'s `handle` switch)
  rather than reading only what the document already contains.
- **"Exempt" must name a reason, and the reason must be about the path, not
  about effort.** "No metering because reading a balance isn't a billable
  call" is an exemption; "no metering here yet" is a blank cell wearing a
  disguise.

The cheapest available check for the specific failure this rule addresses:
a handler that cannot see the caller's identity cannot be enforcing
anything. All four unauthenticated task methods shared one visible symptom —
no `appKey` in their signature. When adding a handler, ask what identity it
receives before asking what it does with it.

## MCP protocol version: negotiate, don't hardcode

This implementation targets the 2026-07-28 MCP specification revision
(stateless Streamable HTTP). At the time it was built, some ecosystem
tooling (SDKs, Inspector) still reported an earlier `LATEST_PROTOCOL_VERSION`
in their own metadata — expected lag between a spec ratifying and every
client library catching up, not a sign the target version was wrong.

Rather than hardcode a version and risk rejecting clients running slightly
behind (or ahead of) the ecosystem's rollout, `initialize` echoes back
whatever protocol version the connecting client requests, falling back to
2026-07-28 only when the client doesn't specify one. This costs nothing:
none of this server's request/response shapes (`tools/list`, `tools/call`,
the Tasks extension) actually branch on protocol version, so there is no
real compatibility matrix to maintain — just a version string that gets
echoed back either way.

## Spec format 5.0.0: an action holds its own schemas

The device spec inherited UPnP's action shape by way of CDIF 3.x. An action
listed argument *names*; each argument named a variable in a
`serviceStateTable`; that variable held the pointer to the actual JSON Schema.
Answering "what does this tool take?" meant three hops through two objects.

The indirection is load-bearing in UPnP, where state variables genuinely are
device state that actions read and write, and where several actions share one
variable. Here they were neither: the state values stopped being reachable
when `/get-state` was removed, every variable was consumed by exactly one
argument of exactly one action, and `--allowSimpleType`'s removal had already
made every argument an object with a schema. What remained was a level of
naming that carried no information — `A_ARG_TYPE_echo_Input` exists only to be
looked up.

So 5.0.0 flattens it: `input`, `output` and `fault` sit directly on the
action, each holding the same `{"schema": "<pointer>"}` object `fault` already
used, and `actionList` becomes an array whose elements carry their own `name`.
The pointers, the `schema.json` layout and the dereference machinery are
unchanged — only who holds the pointer moved.

Two reasons, in order of weight:

1. **Reading cost, for humans and for models.** A module spec is increasingly
   read by an LLM being asked to write or modify a module. Every indirection
   is a place to lose the thread or to invent a plausible-looking state
   variable name that doesn't resolve. The flat form can be read top to bottom.
2. **One fewer thing to keep consistent.** The old form could be internally
   wrong in ways the meta-schema could not catch — an argument naming a
   variable that isn't in the table, a table entry no argument references.
   Those were runtime cross-checks in `validateDeviceSpec`. They are now
   unrepresentable.

What did *not* change is the MCP contract: converting a module produces
byte-identical `tools/list` output, asserted in `test/mcp-contract/` against a
golden sample captured before the conversion. The spec format describes tools;
it is not part of what a client sees. That property is what made the change
safe to make at all, and it is the reason the assertion exists rather than a
note claiming as much.

The cost, stated plainly: `actionList` as an array cannot express name
uniqueness in JSON Schema, so that became a runtime check
(`validateDeviceSpec`), trading a guarantee the format used to give for free.
The array was still worth it — it mirrors MCP's own tools array, and it makes
action order explicit rather than a property of object key ordering.

`serviceList` deliberately stayed an object keyed by service URN. Unlike
`actionList` it has no MCP counterpart to mirror (MCP has no notion of a
service; it only contributes a slug to the tool name), and the URN is a lookup
key on every invoke, in the routes, in job control, and in the peer channels.
Symmetry there would have bought nothing and cost a scan on a hot path.
