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

Both inner calls are ordinary cross-worker invocations, through whichever
path `ServiceClient.invoke()` is currently configured to use. By default
that's the main-thread-routed path: composite-demo's worker sends an
`invokeforeignaction`-style message to the main thread, which routes it to
the target module's worker and relays the reply back — exactly the
mechanism any two modules already use to call each other today. With
`--directPeerChannels` on, the same calls instead go directly
worker-to-worker over a `MessageChannel`, bypassing the main thread
entirely — see [`direct-peer-channels.md`](direct-peer-channels.md) for
how that path works. Either way, composite-demo's own code is unchanged:
which path is taken is entirely `ServiceClient`'s concern, transparent to
the module calling it.

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
$ curl -s -X POST http://127.0.0.1:9527/mcp -H "Content-Type: application/json" \
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

## Every composing module needs its internal identity granted

A module that calls other modules does so as *some* apiKey, and that apiKey
goes through the same `AuthProvider` check any external caller would. So on
a real (non-`--debug`) server, a composing module does not work until its
internal identity is granted access to the modules it calls — otherwise
every inner hop fails with `USER_HAS_NO_DEVICE`, surfacing at the outer tool
as `DEVICE_ACTION_CALL_FAIL` (or, if the module passes the inner result
straight through, as `MISSING_OUTPUT_ARGUMENT`). This is `AuthProvider`
correctly refusing an identity it has never seen, not a bug in composition.

Every bundled module that composes has one, and **all of them need this**,
not just `composite-demo`:

| Module | Internal apiKey | Calls |
|---|---|---|
| `composite-demo` | `composite-demo-internal` | `transform-demo`, `echo-device-module` |
| `echo-device-client-module` | `aabbcc` | `echo-device-module` |
| `perf-caller-demo` | `perf-caller-demo-internal` | `perf-callee-demo` |

Grant whichever ones you load, before starting the server:

```sh
node -e "var f='auth.json',fs=require('fs');
  var c=JSON.parse(fs.readFileSync(f));
  ['composite-demo-internal','aabbcc','perf-caller-demo-internal'].forEach(function(k){
    c[k]={userName:k, devices:['*']};
  });
  fs.writeFileSync(f, JSON.stringify(c,null,2));"
```

`echo-device-client-module`'s key is the literal string `aabbcc` because it
predates this convention and doubles as the `--debugKey` this repo's test
suite runs with — under `--debug` the two have to match or the module's own
calls are refused. It is a test fixture, not a pattern to copy: a new module
should use a descriptive `<module-name>-internal` identity like the other
two, and no module should ship a guessable internal key to a real
deployment.

## Known simplifications (demo scope, not hidden)

This demo cuts several corners deliberately, so that the mechanism is easy
to read. A production composition feature would need to address these:

- **Resolved in 6.0.0 — the outer caller's real API key now reaches inner
  hops.** This used to read: `composite-demo` uses a fixed internal identity
  for every inner `ServiceClient`, so all composite billing showed up under
  one key regardless of who actually called the tool.

  What changed: authorization and billing became two identities instead of
  one. `ctx.serviceClient({deviceID, serviceID, as})` authorizes the hop as
  `as` — the composing module's own identity — and bills it to
  `ctx.caller`, the authenticated outer caller. `ServiceClient`,
  `CHUtil.createServiceClient` and both hop paths (main-thread-routed and
  `--directPeerChannels`) carry a `billingKey` alongside `appKey`; when it is
  absent it falls back to `appKey`, which is exactly the old one-key
  behaviour, so nothing existing changed shape.

  Keeping `as` explicit and required is deliberate. Threading the caller
  through *both* questions would have been the obvious reading of "pass the
  caller's apiKey down", and it would have broken encapsulation: every end
  user would suddenly need their own grant to every module a composing tool
  calls internally. Authorization stays with the module; only the bill moves.

  The sharp edge this entry used to warn about is closed rather than
  inherited. A hop whose billing identity cannot be resolved is now refused
  with `HOP_IDENTITY_UNRESOLVED`, on both paths, instead of being metered for
  free with no caller-visible signal. That check sits before `recordCall`, not
  on its error, because a `recordCall` failure can also mean Redis is down —
  and this codebase deliberately fails *open* on infrastructure. Unresolvable
  identity is not an infrastructure failure; it is a call nobody can be
  charged for.

  Test: `test/auth/13-ctx-billing-identity.js`, non-`--debug` and
  multi-tenant, where the caller is granted the composing device but *not* the
  inner one. It asserts the hop still succeeds, that `ctx.caller` is the real
  caller, and — the assertion that actually matters — that the module identity
  was billed nothing.

  Still open here: `checkBalance`/`rateLimit` are applied at the outer call,
  not independently per hop.
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
