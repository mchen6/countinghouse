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
they are re-benchmarked on the current Node target (see the plan doc). This
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

Each inner hop is metered independently. After each `ServiceClient.invoke`
call succeeds, the handler
(`pre-installed-packages/composite-demo/com-countinghouse-compositeService-run.js`)
calls `CHUtil.recordCall(apiKey, tool, cost, callback)` — the same
`MeteringProvider.recordCall` used everywhere else in the platform
(HTTP `invoke-action`, MCP `tools/call`) — once per hop, with a label
identifying which module and action was called. The resulting `charged`
and `balance` are appended to the `bill` array that becomes part of the
tool's own MCP-visible output, so a caller can see exactly which inner
modules were invoked and what each hop cost, without needing separate
observability tooling.

This required one platform-level fix: `CdifInterface` previously only
constructed a working `meteringProvider` in the main thread
(`isMainThread === true`), so `CHUtil.recordCall` failed inside every
device module's own worker. `lib/countinghouse-interface.js` now
constructs the provider unconditionally, and `CHUtil.recordCall`
(`lib/countinghouse-util.js`) is a thin passthrough to
`CdifInterface.prototype.recordCall`. This is a real fix, not scoped to
the demo — any module can now call `CHUtil.recordCall` from inside its own
worker.

A metering failure on one hop does not fail the whole composite call: the
inner action has already succeeded by the time `recordCall` runs, so a
gap is recorded in the bill (`charged`/`balance` set to `null`) rather than
returning an error for what the caller experiences as a successful
request.

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
  (`composite-demo-internal`) for every inner `ServiceClient` and every
  `recordCall`, so all composite-demo billing shows up under one key
  regardless of who actually called the tool. A real implementation would
  need to pass the calling MCP client's apiKey (or a derived, scoped
  credential) down through the `ServiceClient` chain, and decide how
  `checkBalance`/`rateLimit` should apply at each layer — checked once at
  the outer call, or independently at every hop.
- **Per-hop cost is hardcoded** (`HOP_COST = 1` in
  `com-countinghouse-compositeService-run.js`), not looked up from each
  target module's own declared pricing.
- **`recordCall` runs a Redis connection per worker thread**, now that
  `CdifInterface` builds a `meteringProvider` unconditionally. An
  alternative would route metering calls through the existing worker→main
  message channel the way `lib/redis-api.js` proxies raw Redis commands,
  avoiding N extra Redis connections for N worker threads. Not built here;
  flagged as a follow-up if per-worker Redis connections become a real
  constraint.
- **Metering coverage on the cross-worker call path itself is not
  centralized — unless `--directPeerChannels` is on.** By default, the
  platform does not automatically meter every cross-worker `ServiceClient`
  call — only calls where the calling module's own handler explicitly
  invokes `CHUtil.recordCall`, as composite-demo does. See
  `docs/cross-cutting-matrix.md` for the full picture of which entry paths
  get which cross-cutting guarantees today. `docs/direct-peer-channels.md`'s
  D5 changes this specifically for the opt-in `--directPeerChannels` path:
  every hop over a direct peer channel is now metered automatically by the
  platform (`lib/peer-channel-broker.js`'s `handleMetering`), independent
  of whether the calling module also meters itself.
- **Running composite-demo with `--directPeerChannels` on double-bills
  each hop.** Found while implementing D5: composite-demo's own explicit
  `CHUtil.recordCall` calls (above) and the platform's new automatic
  per-hop metering both fire for the same hop when the flag is on —
  `composite-demo-internal`'s balance was observed dropping by 3× the
  per-hop cost for a 2-hop call, not 2×. Not fixed here: the correct fix
  needs a real design decision (an opt-out for modules that already meter
  themselves, or some other dedup mechanism), not a one-line patch to this
  demo. composite-demo's own `bill` output is unaffected and still
  correctly shows exactly one entry per hop (composite-demo doesn't know
  about the extra platform-level charge) — this only affects the
  underlying balance, not the acceptance-bar-relevant bill shape. See
  `docs/cross-cutting-matrix.md`'s direct-peer-channel row and
  `docs/direct-peer-channels.md` for the verification that found this.

## Files

- `pre-installed-packages/transform-demo/` — minimal second module
  (`uppercase` action), exists only so composite-demo has two distinct
  inner modules to chain, rather than calling echo-device-module twice.
- `pre-installed-packages/composite-demo/` — the composite tool itself.
- `lib/countinghouse-interface.js`, `lib/countinghouse-util.js` — the
  `meteringProvider`/`CHUtil.recordCall` fix described above.
