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

## Unknown arguments are rejected, not ignored

An action's argument object may contain only the two reserved argument names,
`input` and `output`, plus the keys the framework injects itself (`ctx`,
`httpHeaders`, `jobID`). Anything else fails validation, naming the offending
key, in whichever direction it appeared.

There was no decision behind the alternative, which is why this one is written
down. Before 5.0.0, `validateActionCall` walked every key in the argument
object and read `argList[key].relatedStateVariable` — so an unrecognised key
dereferenced `undefined` and threw a `TypeError` out of a function whose
callers do not catch it on the input path. Rewriting the function for the new
spec format quietly turned that into the opposite behaviour: unknown keys were
skipped. Both are accidents of how the loop happened to be written, and the
second is the more dangerous, because it is silent — a module returning
`{output: {...}, surprise: ...}` had the stray value travel back to its caller
unvalidated.

Rejecting is the right default for a schema-validating boundary:

1. **The spec is the contract.** A key the spec does not declare has no schema,
   so passing it through means shipping unvalidated data to whoever called the
   tool — exactly what this layer exists to prevent.
2. **A stray key is usually a typo.** `{ouptut: ...}` silently ignored looks
   to the module author like the framework losing their return value. Named
   and refused, it takes seconds to find.
3. **It is a closed vocabulary, and a small one.** Two argument names, three
   framework keys. Not a schema-evolution mechanism where unknown-field
   tolerance would buy forward compatibility.

The alternative considered was letting an action opt into extra keys by
declaring `additionalProperties` in its own JSON Schema. Rejected: the stray
keys in question are *siblings* of `input`/`output`, not properties inside
them, so a schema on the input document cannot describe them — the schema
would have to be for the argument envelope, which is framework-owned and not
something a module gets to redefine. An action that genuinely needs to carry
more data can put it inside `input`, where it has a schema like everything
else.

Cost, stated: a caller that was passing extra keys and getting away with it now
gets a 500. Nothing in this repo did, and the pre-5.0.0 behaviour for that same
caller was a `TypeError`, so this breaks nothing that previously worked.
Tests: `test/validation/01` (both directions, at the unit level) and
`test/validation/02` (a real module returning a stray key, end to end,
including that the server survives it).

## Module shape 6.0.0: handlers by default, discovery when you need it

Writing a module that exposes one `echo` tool used to cost about thirty-five
lines before any of them did anything. An `index.js` that inherits
`EventEmitter`, listens for `discover`, and immediately emits `deviceonline`
with a new device — no actual discovery, just the handshake. A `device.js` that
imports each handler by full path and then registers it with a `setAction` call
repeating the full service URN. A `_getDeviceRootSchema` that reads
`schema.json` by hand.

The cost is not the line count, it is that the same facts are written three
times. `api.json` already declares which services and actions exist. The
`com-<reverse-domain>-<service>-<action>.js` filename convention encodes it
again. `device.js` repeats it a third time. Three copies with no mechanism
keeping them in step, so any one of them can drift, and the contract
(`api.json`) and the implementation (the handler) are tangled together in the
same file rather than being separable.

So 6.0.0 makes a module its handlers:

```js
module.exports = {
  echoService: {
    echo: async (input, ctx) => ({output: input})
  }
};
```

Top-level keys are service *short* names; `api.json` remains the only place a
full URN appears. Actions are matched to it by name. `schema.json` is read by
the framework. Authors who prefer a file per action drop `device.js` and use
`handlers/<serviceShortName>/<actionName>.js` instead — the same map, assembled
from the filesystem.

**Discovery stays, as an opt-in.** A module that exports a class or an
EventEmitter still takes the existing dynamic path, with `discover`,
`deviceonline` and `deviceoffline` behaving exactly as before. This is not
politeness toward old code; the capability is real and a handler map cannot
express it. A module that exposes one device per configured database
connection genuinely does not know its device count until it reads that
configuration, and a module whose backing resource disappears genuinely needs
to withdraw that device and leave its siblings alone. What was wrong was not
that discovery existed, it was that a module with nothing to discover still had
to perform the ceremony. Now the framework synthesizes that shim, which also
means the runtime grew no second path to maintain: assembly ends by handing the
existing pipeline the same EventEmitter it always got.

Assembly is strict in both directions, and this is the part worth defending.
Convention-based wiring is exactly the kind of mechanism that fails silently —
a renamed service, a mistyped action, and the tool simply is not there. This
project has already shipped that failure once and fixed it (a module with an
illegal spec used to vanish with nothing at error level; see
`test/module-loading/03-legacy-spec-not-silent.js`). So: an action declared in
`api.json` with no handler is a startup error, a handler that `api.json` does
not declare is a startup error, an unresolvable service short name is a startup
error, and a short name that two URNs both claim is reported as ambiguous
rather than resolved to whichever was enumerated last. Every mismatch in a
module is collected and reported together, each naming the module, the stage,
the offending name, and the fix.

Costs, stated plainly. Short names must be unique within a module, which the
full URN did not require — hence the explicit ambiguity error rather than a
silent pick. And a handler map is one device, described statically; anything
else is the dynamic path by definition, so the choice of shape is a real
decision an author makes rather than a default they can drift away from without
noticing.

One existing behaviour this did *not* change, noted because it surprises:
`deviceoffline` marks a device `online = false` but does not unlist it, so an
offline device still appears in `tools/list` and fails at call time with
`DEVICE_OFFLINE`. Tests: `test/module-loading/04` (validation rules, unit
level), `05` (assembly and every mismatch, end to end), `06` (both paths in one
server, including the first test in this repo to exercise `deviceoffline` at
all).

## Handler failure is classified by the error, not by how it arrived

6.0.0 lets a handler be written either way:

```js
async (input, ctx) => ({output})          // return, or throw
(input, ctx, callback) => callback(...)   // deprecated, removed in 7.0.0
```

Which style a handler uses is decided by what it *returns* — a thenable is
awaited, anything else waits for the callback. The previous test was
`action.invoke.constructor.name === 'AsyncFunction'`, which is a question about
how the function was declared rather than how it behaves, and it was wrong in
the worst available way: an ordinary function returning a promise
(`() => someAsyncHelper()`, the shape any handler takes the moment it is
refactored) has `constructor.name === 'Function'`, so it was sent down the
callback branch, where nothing ever called back. The call hung until the 30s
device timeout rather than failing.

The harder question was what a failure should look like. The goal was for
`callback(err)`, `throw` and a rejected promise to produce one response. They
now do — for every error the runtime can classify:

| how the handler failed | response |
| --- | --- |
| `callback(new DeviceError(C))` | `C` |
| `throw new DeviceError(C)` | `C` |
| `callback(new Error('boom'))` | `DEVICE_INVOKE_FAIL` |
| `throw new Error('boom')` | `DEVICE_INVOKE_EXCEPTION` |

The first pair is what was actually broken. A rejection was flattened to
`DEVICE_INVOKE_EXCEPTION` unconditionally, discarding the code, so an async
handler had no way to return a typed error at all. Nothing caught it because
no bundled module throws one.

The last two rows are a deliberate deviation from "all three identical", and
the reason is that the two are not the same event. `callback(err)` is a handler
*reporting* a failure it anticipated; a throw is a handler *crashing*. Both
codes are already load-bearing: `test/direct-peer-channels/02` reads
`DEVICE_INVOKE_FAIL` to tell a re-established channel from a broken one, and
`DEVICE_INVOKE_EXCEPTION` arrives with the thrown value's stack attached as the
fault. Collapsing them would have meant picking one and deleting the other
distinction — and either choice changes a client-visible code that existing
tests pin from both directions.

So the rule is: classify by the error's *type*, not by the delivery mechanism.
A typed error (`DeviceError`/`CHError`) means "I anticipated this" and keeps its
code however it arrives. An untyped error means the runtime is guessing, and
the only honest evidence left is how it got there. This is the one case where
an async handler is genuinely less expressive than a callback one — `throw` is
its only exit, so it cannot say "reported, not crashed" about an untyped error.
A handler that wants that distinction should throw a `DeviceError`, which is
what it should be doing anyway.

Output validation was unified along the way: the async branch had its own copy
that turned any validation failure into `DEVICE_INVOKE_EXCEPTION`, losing the
validator's own code. Both styles now report what the validator said.

`platformMetering` needed no change and no new shape. It reaches a composing
module as the third argument of `ServiceClient.invoke`'s callback, not through
the action's return value, so the `{output}` contract was never at risk of
having to carry it — see `docs/composite-tools.md`'s "billing authority".

Tests: `test/module-loading/08-error-semantics.js` asserts every cell of the
table above, including that the two typed-error styles produce byte-identical
responses, and that a plain function returning a promise now completes instead
of hanging.

## CHDevice stays prototype-based: class methods are not enumerable

6.0.0 converted the whole repo to ES6 — `const`/`let`, arrow callbacks,
template literals — with one part of that pass deliberately left undone.
`Foo.prototype.bar = function` was *not* converted to `class` syntax anywhere,
and `lib/` still carries 213 prototype assignments across 25 files.

The blocker is `CHUtil.inherits`, the helper every device module calls to
inherit from `CHDevice`:

```js
inherits: function(constructor, superConstructor) {
  util.inherits(constructor, superConstructor);

  // prevent child override
  if (superConstructor === CHDevice) {
    for (var i in superConstructor.prototype) {
      constructor.prototype[i] = superConstructor.prototype[i];
    }
  }
}
```

That `for...in` copies `CHDevice`'s prototype members back over anything the
module defined, so a module cannot replace a framework method. Class methods
are non-enumerable, so the loop would stop seeing them. Measured rather than
reasoned about:

```
prototype style, for..in over the prototype:  20 keys  (foo, bar + 18 inherited EventEmitter members)
class style,     for..in over the prototype:  18 keys  (only the inherited members; foo and bar are gone)
```

The failure mode is what makes this a blocker rather than a chore. The loop
would not throw and would not iterate zero times — it would keep finding the 18
EventEmitter members and silently stop covering exactly the 11 methods that
matter: `setAction`, `initServices`, `getDeviceSpec`, `connect`, `disconnect`,
`getHWAddress`, `deviceControl`, `updateDeviceSpec`,
`getDeviceRootSchema`, `destroyCdifDevice`,
`resolveSchemaFromPath`. A module
could then override `setAction` or `deviceControl`, which it cannot today, and
no test would notice. All five bundled modules go through this helper.

Rewriting the guard is not a one-line substitution either.
`Object.getOwnPropertyNames(CHDevice.prototype)` is the obvious replacement,
but it is not equivalent: the current `for...in` also walks the inherited chain
and therefore copies EventEmitter's own methods onto the child, and dropping
that is a behavioural change in its own right.

So the conversion is deferred, not abandoned, and deliberately so: 6.0.0's
step B replaces this inheritance path for static modules entirely — a handler
map never calls `CHUtil.inherits` — so the question of what the guard should
become is better answered once the dynamic path is the only caller left.
Converting it first would have meant rewriting a mechanism that was about to
change shape, in the most fragile files in the tree.

Two other candidate hazards were checked and cleared: `.super_` is referenced
nowhere, and every `for (const x in this.…)` walks a data property
(`this.modules`, `this.deviceMap`, `this.pending`), not a prototype.
