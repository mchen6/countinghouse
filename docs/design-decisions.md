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
