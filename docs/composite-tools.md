# Composite tools

This document describes `pre-installed-packages/composite-demo`, a demo
module that chains two other modules' actions together inside a single
`tools/call`, and shows how metering attributes revenue across the chain.

## What this is

**countinghouse makes hosted tools composable.** A device module can call
another device module's action directly, in-process, over the existing
worker `message channel` — the same mechanism `ServiceClient` already uses
for any cross-module call (see `docs/security-model.md`'s description of
the `WorkerMessage` protocol). Intermediate results never leave the
process: they don't go over HTTP, and they never enter the calling MCP
client's model context. From the outside, an MCP client sees one
`tools/call` request and one response.

This is **not** an MCP protocol extension. MCP itself has no notion of
tool-to-tool calls; nothing here changes JSON-RPC framing, the
`tools/list`/`tools/call` contract, or anything a client-side MCP library
needs to know about. Composition is entirely a platform-side capability:
one device module's action handler, running inside its own worker, invokes
another module's action the same way any other in-process caller would,
via `CHUtil.createServiceClient(...)`.

Do not describe this feature as "we extended MCP." It is a capability of
the hosting platform, exposed to MCP clients as an ordinary tool that
happens to do more work per call.

Old performance numbers ("20-30x") describing this codebase's prior
worker-thread architecture must not be cited here or anywhere else until
they are re-benchmarked on the current Node target (see
[`direct-peer-channels.md`](direct-peer-channels.md#retired-numbers)). This
document makes no performance claims.

## How composite-demo works

`composite-demo` exposes one tool, `compositeService/run`, that:

1. Takes `{text: string}`.
2. Calls `transform-demo`'s `uppercase` action on `text`, via a
   `ServiceClient` created at module-init time
   (`pre-installed-packages/composite-demo/device.js`).
3. Feeds the uppercased result into `echo-device-module`'s `echo` action,
   via a second `ServiceClient`, to demonstrate a second independent hop.
4. Returns `{finalText, bill}`, where `bill` is an array with one entry per
   inner hop.

Both inner calls are ordinary cross-worker invocations: composite-demo's
worker sends an `invokeforeignaction`-style message to the main thread,
which routes it to the target module's worker and relays the reply back —
exactly the mechanism any two modules already use to call each other today.
Nothing about the routing path was changed for this feature.

Target modules are addressed by their deterministic `deviceID`
(`UUID.v5` of a fixed namespace and the target module's `api.json`
`friendlyName`), computed offline and hardcoded in `device.js`, the same
pattern used by `echo-device-client-module`. No runtime discovery is
needed to call a known module.

## In-composition metering

**Billing authority principle**: platform automatic metering is the sole
thing that ever deducts balance for a cross-worker call — on *both* the
main-thread-routed path (`DeviceManager.prototype.sendInvokeActionMessageToWorker`)
and the opt-in `--directPeerChannels` path
(`PeerChannelBroker.prototype.handleMeteringRequest`), unconditionally.
Every module composing other modules' actions (like this one) gets billing
for free, automatically, once per hop, without calling anything itself —
and *cannot* double-bill a hop by also metering it, because the module-facing
API for that (`CHUtil.recordUsage`, see below) no longer touches balance at
all.

Each inner hop is still metered independently, but the metering now
originates from the platform, not from composite-demo's own handler. The
real `{apiKey, tool, charged, balance}` result is threaded back to the
calling module as a 3rd, additive argument on `ServiceClient.invoke()`'s
callback — `function(err, data, platformMetering) {...}` — deliberately
*never* merged into `data` itself: `data` is the hop's own action output,
and some modules (e.g. `echo-device-client-module`) pass it straight
through as their own action's return value, so an extra field injected
into it would fail that pass-through's own output schema validation. The
handler
(`pre-installed-packages/composite-demo/com-countinghouse-compositeService-run.js`)
reads `platformMetering.charged`/`.balance` off that 3rd argument to build
the `bill` array that becomes part of the tool's own MCP-visible output,
so a caller can see exactly which inner modules were invoked and what each
hop cost, without needing separate observability tooling.

Separately, composite-demo also calls `CHUtil.recordUsage(apiKey, tool,
cost, callback)` per hop — purely as its own app-layer audit trail. This
is *not* what produces `bill`'s numbers and has no effect on balance (see
`lib/countinghouse-util.js`'s own comment on `recordUsage`); a module that
doesn't want its own bookkeeping trail can skip calling it entirely and
still bill correctly, since the platform's own metering is unconditional.

A metering failure on one hop does not fail the whole composite call: the
inner action has already succeeded by the time the platform's metering
runs, so a gap is recorded in the bill (`charged`/`balance` set to `null`)
rather than returning an error for what the caller experiences as a
successful request.

### Example

```
$ curl -s -X POST http://127.0.0.1:18200/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"composite_demo_compositeservice_run",
        "arguments":{"text":"hello from the composite demo"}}}'
```

returns a `bill` with two independent entries, one per inner module:

```json
{
  "finalText": "HELLO FROM THE COMPOSITE DEMO",
  "bill": [
    {"hop": 1, "tool": "transform-demo/uppercase", "charged": 1, "balance": -1},
    {"hop": 2, "tool": "echo-device-module/echo", "charged": 1, "balance": -2}
  ]
}
```

## Known simplifications (demo scope, not hidden)

This demo cuts several corners deliberately, so that the mechanism is easy
to read. A production composition feature would need to address these:

- **The outer caller's real API key is not threaded through to inner
  hops.** `composite-demo` uses a fixed internal identity
  (`composite-demo-internal`) for every inner `ServiceClient`, so all
  composite-demo billing shows up under one key regardless of who actually
  called the tool. A real implementation would need to pass the calling
  MCP client's apiKey (or a derived, scoped credential) down through the
  `ServiceClient` chain, and decide how `checkBalance`/`rateLimit` should
  apply at each layer — checked once at the outer call, or independently
  at every hop. `CHUtil.createServiceClient`'s `ctx` option already exists
  for exactly this (a module can pass along the current caller's session
  instead of a fixed `appKey`), but nothing here uses it yet, and it comes
  with a sharp edge if it's wired up carelessly: if the passed-through
  session's own `appKey` is itself unresolved (`null`/`undefined`), the
  platform's automatic metering silently no-ops for that hop rather than
  failing the call — see `docs/cross-cutting-matrix.md`'s two "Direct peer
  channel" rows for the verified, empirically-confirmed behavior. Worth
  deciding deliberately (reject the call vs. bill a fallback identity vs.
  keep the current silent-skip) before this `ctx` path is actually used
  anywhere, rather than inheriting whatever the guard already does today.
- **Per-hop cost is hardcoded** (`HOP_COST = 1` in
  `com-countinghouse-compositeService-run.js`), not looked up from each
  target module's own declared pricing.
- **Metering runs a Redis connection per worker thread**, now that
  `CdifInterface` builds a `meteringProvider` unconditionally. An
  alternative would route metering calls through the existing worker→main
  message channel the way `lib/redis-api.js` proxies raw Redis commands,
  avoiding N extra Redis connections for N worker threads. Not built here;
  flagged as a follow-up if per-worker Redis connections become a real
  constraint.
- **Fixed: metering coverage on the cross-worker call path is now
  centralized on both paths, and composite-demo no longer double-bills.**
  Originally, only the opt-in `--directPeerChannels` path metered a
  cross-worker call automatically; the main-thread-routed (default) path
  didn't, so composite-demo metered itself explicitly via
  `CHUtil.recordCall`. Once `--directPeerChannels`'s automatic metering
  was added (D5), turning the flag on made composite-demo double-bill
  every hop — its own `recordCall` and the platform's new automatic
  metering both fired for the same call, dropping
  `composite-demo-internal`'s balance by 3× the per-hop cost for a 2-hop
  call, not 2×. The real fix (see the "billing authority" principle
  above): platform automatic metering was extended to the
  main-thread-routed path too, so it is unconditionally the *only* thing
  that ever deducts balance on *either* path; the module-facing
  `CHUtil.recordCall` was removed and replaced with `CHUtil.recordUsage`,
  which is app-layer bookkeeping only and never touches balance, so a
  module literally cannot double-bill itself through that API anymore.
  `test/direct-peer-channels/06-no-double-billing.js` asserts a 2-hop
  composite call deducts exactly 2× cost (not 3×) and `bill` still shows
  2 independent records, in both flag states. See
  `docs/cross-cutting-matrix.md`'s direct-peer-channel rows for the
  updated per-path guarantee.

## Files

- `pre-installed-packages/transform-demo/` — minimal second module
  (`uppercase` action), exists only so composite-demo has two distinct
  inner modules to chain, rather than calling echo-device-module twice.
- `pre-installed-packages/composite-demo/` — the composite tool itself.
- `lib/countinghouse-interface.js` — the `meteringProvider` per-worker-thread
  construction fix.
- `lib/countinghouse-util.js` — `CHUtil.recordUsage` (app-layer bookkeeping,
  no balance effect; replaces the removed `CHUtil.recordCall`).
- `lib/device-manager.js`, `lib/peer-channel-broker.js`,
  `lib/peer-channel.js`, `lib/session.js`, `lib/worker-message.js`,
  `lib/sandbox.js` — automatic platform metering on both cross-worker call
  paths (the "billing authority" principle above) and the `platformMetering`
  3rd callback argument that carries it back to a calling module without
  touching `data`.
- `test/direct-peer-channels/06-no-double-billing.js` — the double-billing
  regression test, both flag states.
