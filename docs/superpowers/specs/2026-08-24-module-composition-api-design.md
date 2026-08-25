# Module composition API — `ctx.call`

A module calls another module by name instead of by hardcoded UUID.

Status: design approved in brainstorming, not implemented.
Branch: `feat/module-composition-api`, off `feat/module-authoring-toolchain`.

## The problem

For `repo-review` to call `repo-scan` today, its handler must contain this
(`examples/repo-review/repo-review/handlers/reviewService/review.js:13-24`):

```js
const SCAN_DEVICE_ID = '1359302a-e4fe-5c14-853b-f83638e8ca01';
const SCAN_SERVICE   = 'urn:countinghouse-com:serviceID:scanService';
const AS_IDENTITY    = 'repo-review-internal';

function clientFor(ctx, deviceID, serviceID) { /* promise wrapper */ }
function rawInvoke(client, actionName, input) { /* promise wrapper */ }
```

Three constant blocks and two helper functions before a line of logic. The
runtime's headline claim is that MCP tools call other tools; this is the call
site a reader judges that claim by.

Target:

```js
const data = await ctx.call('repo-scan/scanService.scan', opts);
```

## Scope

In: the address format, `ctx.call`, the dependency declaration, the identity
binding, load-time verification, and converting `repo-review`.

Out, deliberately:

- **Installing tool dependencies** — deferred to spec 2 (workspace-based module
  installation). This spec's `calls` declaration is the input that spec needs.
- **Generating auth grants** from the declaration. Operators still edit auth
  config themselves.
- **Per-call `as` override** and multiple identities per module. A module that
  needs either can still use `ctx.serviceClient` directly.
- **Chain-level deadline**, `ctx.callSettled`, retry policy. See Known
  limitations.

## Prerequisite: duplicate deviceID silently overwrites

`deviceID` is UUID v5 of `friendlyName` (`lib/countinghouse-device.js:32`), so
two modules that pick the same `friendlyName` produce the same deviceID. Both
registration paths mishandle that, differently:

- **Worker mode** (`lib/device-manager.js:464`) is a bare
  `this.deviceMap[deviceID] = wm`. No check at all; the second module silently
  replaces the first.
- **Single-thread mode** (`lib/device-manager.js:168-173`) has a guard, and it
  is inverted:

  ```js
  if (this.deviceMap[uuid] != null) {
    if (this.deviceMap[uuid].module === moduleInstance) {
      LOG.DE(cdifDevice, new CHError('DEVICE_OBJECT_CONFLICT'));
      if (options.verifyModule !== true) return;
    }
  }
  ```

  It refuses when the existing device came from the **same** module instance —
  blocking a module from re-registering its own device — and falls straight
  through to `this.deviceMap[uuid] = cdifDevice` when a **different** module
  claims an existing deviceID, which is the case that actually matters.

`DEVICE_OBJECT_CONFLICT` is raised in that one place and asserted by no test,
so its semantics can be corrected rather than preserved.

**The rule after the fix**, both paths: a deviceID already registered by a
*different* module (compared by `modulePath`) is refused, with an error naming
both modules and the shared `friendlyName`. Re-registration by the same module
is allowed and replaces the entry, because module reload depends on it.

This is a latent bug today, independent of composition. It becomes load-bearing
here: every address resolves through `friendlyName`, so silent shadowing would
make `ctx.call` reach a different module than the author named.

**Fixed first, as its own commit, before any composition work.** A second
device claiming an existing deviceID is refused with an error naming both
modules and the shared `friendlyName`.

## Design

### 1. Address format

```
repo-scan/scanService.scan
<friendlyName>/<serviceLabel>.<actionName>
```

Exactly one `/` and one `.`, and none of the three parts may contain either.
A `friendlyName` or action name containing a delimiter is a declaration error
with an explicit message, not an escape syntax.

**Not the MCP tool name** (`repo_scan_scan`). Rejected because:

- `dedupeName` (`lib/mcp/tool-registry.js:194`) appends `_2` on collision, and
  which module gets the bare name depends on `for (const deviceID in specs)`
  insertion order — i.e. module load order. Not stable enough to hardcode.
- `slugify` (`lib/mcp/tool-name.js`) is lossy: `repo-scan`, `repo.scan` and
  `Repo Scan` all become `repo_scan`.
- Actions without a `description` are skipped from `tools/list` entirely
  (`tool-registry.js:236-240`), so the addressable set would be smaller than
  the callable set, for a reason unrelated to composition.

Cost accepted: authors see two naming forms — `repo_scan_scan` in `tools/list`,
`repo-scan/scanService.scan` in a declaration. The compact form is built from
strings the author typed into `api.json`, so it is predictable rather than
assigned.

### 2. Resolution

Four steps, in `lib/call-address.js` (new) plus one existing message round trip:

1. **Parse** the address into `{device, service, action}`. Pure.
2. **Device → deviceID**: `UUID.v5(url, 'https://registry.apemesh.com/packages/' + device)`.
   Pure.
3. **Service label → URN**: one `querydevice` message returns the target's full
   spec; match the single `serviceList` key whose `serviceLabel(urn)` equals
   `slugify(service)`. Zero or two matches is an error naming the candidates.
4. **Action check**: the action exists in that service's `actionList`; the error
   lists what does exist.

Resolved targets are cached per module after first resolution.

Step 3 needs the target's spec, so resolution is not a pure function end to end
— the URN vendor segment varies across modules already in this repo
(`urn:countinghouse-com:`, `urn:countinghouse-test:`, `urn:example-com:`), so a
short label cannot be expanded by string rules alone.

**Load order is already handled.** `DeviceManager.prototype.queryDeviceForChild`
(`lib/device-manager.js:1165-1183`) queues the reply in `notifyDeviceLoad` when
the target has not loaded yet, and only errors once `allDevicesLoaded === true`.
A composing module may therefore name a target that loads after it.

`ctx.call` then delegates to the existing `ctx.serviceClient({deviceID,
serviceID, as})` and wraps the callback.

**Signature:**

```js
ctx.call(address, input)                  // resolves to `data`
ctx.call(address, input, {detail: true})  // resolves to {data, platformMetering}
```

The plain form resolves to `data` alone, because that is the shape almost every
call site wants. `platformMetering` is the third, additive argument on a
cross-worker invoke reply and must never be merged into `data`
(`docs/composite-tools.md` explains why that separation is load-bearing), so
reaching it requires the explicit `detail` form. `repo-review` uses it — it
builds a per-hop `bill` array from exactly that value.

### 3. Where the chain is declared — the module's `package.json`

```json
{
  "name": "repo-review",
  "version": "1.0.0",
  "dependencies": {},
  "countinghouse": {
    "calls": [
      "repo-scan/scanService.scan",
      "secret-detect/detectService.detect",
      "dep-audit/auditService.audit"
    ]
  }
}
```

Namespaced key, following the `eslintConfig` / `jest` / `browserslist`
convention. Not inside `dependencies` — npm would try to install those as
packages. (Spec 2 will use `dependencies` for exactly that purpose; the two
fields stay distinct: `dependencies` names packages, `calls` names capabilities.)

`package.json` is already parsed at module load (`lib/module-manager.js:372`)
and threaded through `deviceonline` (`:409`, `:516`), so this costs no new file
I/O, and the serverless CLI validator already reads the same file.

**`api.json` and `spec/schema.json` are not touched.** The device spec format
does not change at all. Composition is how a module is wired, not what it
publishes — which is also why `npm run golden` cannot move.

### 4. Where the identity is declared — auth config

`as` is a deployment decision, not a module-authoring one. Baking it into a
module would mean the same module could not be deployed under a different
identity without editing it.

The identity already exists as an auth.json entry with its own grants. What is
added is the binding:

```json
{
  "demo-key": {
    "userName": "demo",
    "devices": ["51b0d6ac-7a77-5083-8476-26a9be96a101"]
  },
  "repo-review-internal": {
    "userName": "repo-review-internal",
    "devices": ["1359302a-...", "7d4e06e9-...", "01919ef1-..."],
    "runsModules": ["repo-review"]
  }
}
```

Optional field on the identity's own record. The top-level shape is unchanged,
so every existing auth.json stays valid and there is nothing to migrate.

**Keyed by `friendlyName`**, not `package.json`'s `name`. auth.json's `devices`
arrays are deviceIDs and deviceID derives from `friendlyName`, so the auth file
stays in one namespace. Both names are available at `deviceonline`; if they
disagree while a binding exists, that is a load-time error.

`AuthProvider` (`lib/auth/provider.js`) gains one method,
`identityForModule(friendlyName, callback)`:

- `FileAuthProvider` answers from the config it already loads at construction.
- `SqliteAuthProvider` gains one additive table alongside `users` and
  `user_devices`. `_ensureSchema` (`lib/auth/sqlite-provider.js:43-47`) is
  already `CREATE TABLE IF NOT EXISTS`-based and idempotent against an existing
  database.

### 5. What the runtime does at load

Once discovery completes, for each module declaring `countinghouse.calls`:

1. **Resolve every declared address** (section 2). A typo becomes a startup
   error naming the module, the file and the address — not a runtime failure
   the first time that branch is hit.
2. **Resolve the identity** via `identityForModule`. No binding → refuse,
   naming the module and the file to edit. This is the deployment mistake the
   author/operator split makes possible, so it gets the clearest message in the
   feature.
3. **Reject ambiguity**: two identities listing the same module in `runsModules`
   → refuse, naming both. Silently picking one would make authorization and
   billing depend on object key order.
4. **Grant check**: the resolved identity must have a grant to each resolved
   target. Read-only, one `authenticate()` call each. Today this surfaces as an
   authorization failure mid-call.

### 6. Failure semantics

**A rejected `ctx.call` cannot hang.** `lib/service.js:292-303` settles a
handler's returned promise on both outcomes with a `settled` guard; a rejection
becomes `DEVICE_INVOKE_EXCEPTION` immediately. The callback style is the one
with the swallowed-exception hazard this repo has been burned by; the promise
path is not. `ctx.call` being promise-based is a safety property, not only
ergonomics.

**Rejections** are `Error`s carrying `.code`, in two families:

- *Author errors* — undeclared address, unparseable address, unknown device,
  ambiguous service label, no such action. Also checked at load, so the runtime
  check is a backstop.
- *Hop errors* — the callee's failure, with its structured fault attached as
  `.fault` rather than flattened into a message string, so a composing module
  can map it into its own declared fault schema. On the error object only,
  never merged into `data`.

  **Fault propagation is not uniform today and must be pinned, not assumed.**
  `ServiceClient.invoke`'s remote branch calls back
  `new Error(body.message), null` (`lib/service-client.js:66`) — the fault is
  gone. The main-thread-routed branch does pass `data` alongside the error
  (`lib/device-manager.js:606`), and the `--directPeerChannels` branch is
  supposed to be externally identical to it
  (`docs/direct-peer-channels-design.md` section 3). Implementation must verify
  all three rather than trust that claim. The rule where a path genuinely
  cannot supply one: `.fault` is `null`. `ctx.call` never invents fault content
  to paper over a path that dropped it, and `04-failure-and-billing.js` asserts
  the resulting behaviour on both cross-worker paths.

**No rollback.** Hop 1's side effects stand when hop 2 fails. `ctx.call`
guarantees prompt, typed delivery; propagate-or-degrade is the composing
module's decision in its own `try`/`catch`.

**Billing is already correct and is not touched:**

- A failed hop is not billed — `lib/device-manager.js:606` returns before
  `recordCall` at `:633`.
- Hops that already succeeded are billed. A 3-hop chain failing at hop 2 charges
  the caller for hop 1.
- The outer call is not billed when the composite returns an error —
  `lib/session.js:150-152`, matching the MCP path's `isError !== true` guard.

### 7. Backward compatibility

`ctx.serviceClient` is unchanged. A module with no `countinghouse.calls` behaves
exactly as today. `composite-demo` deliberately stays on `ctx.serviceClient` so
both paths keep test coverage and the docs have a live example of each.

## Known limitations

**No chain-level deadline.** `requestTimeout` defaults to 30000ms
(`lib/cli-options.js:89`) and is both the per-hop timeout and the outer session
timeout. Three hops of 15 seconds each blow the outer timeout while no
individual hop times out, and the caller gets `DEVICE_NOT_RESPONDING` with no
indication which hop was slow. A shared budget is separate work. Cheap
mitigation included here: name the resolved address of the hop in flight when a
composite times out.

**Delimiters constrain names.** A `friendlyName` containing `/` or `.`, or an
action name containing `.`, cannot be addressed.

## Files

- **new** `lib/call-address.js` — parse, and derive the device UUID. No
  requires, same discipline as `lib/mcp/tool-name.js`, so the serverless CLI
  validator can use it without opening a Redis socket.
- `lib/countinghouse-device.js` — the UUID derivation **moves into**
  `call-address.js` and is called from here. The seed string
  `https://registry.apemesh.com/packages/${friendlyName}` carries a comment
  saying the `apemesh` seed is deliberate and changing it reassigns every
  existing device's ID; re-typing that template in a second file is a drift
  hazard where every address would silently resolve to a nonexistent device.
- `lib/handler-ctx.js` — add `ctx.call`.
- `lib/device-manager.js` — the duplicate-deviceID fix (separate commit), and
  load-time verification.
- `lib/auth/provider.js`, `lib/auth/file-provider.js`,
  `lib/auth/sqlite-provider.js` — `identityForModule`.
- `lib/plan-validator.js`, `lib/module-validator.js` — chain checking in
  `validate_plan`, `calls` syntax checking in the CLI.
- `examples/repo-review/` — `repo-review/package.json` gains
  `countinghouse.calls`; `auth.json` gains `runsModules`; the handler is
  converted.
- `package.json` — add `./test/composition/*.js` to the `test` script.
- `docs/composite-tools.md`, `docs/module-authoring.md`,
  `docs/module-development.md`.

## Testing

New `test/composition/`, ports **9556–9558**. Occupied elsewhere in `test/`:
9000, 9527, 9530–9531, 9541–9546, 9550–9554, 9571–9575, 9584, 9586, 9590–9591,
9593, 9595, 9811.

1. `01-call-address.js` — pure, no server, no Redis: parsing, every rejection
   case, and the assertion that `call-address.js` and `countinghouse-device.js`
   derive identical UUIDs for the same name.
2. `02-ctx-call.js` — a real two-hop call through `ctx.call`. Port 9556.
3. `03-declaration.js` — an undeclared address is refused at call; a typo'd
   declared address fails at **load** with a message naming module and address.
   Port 9557.
4. `04-failure-and-billing.js` — hop 2 fails: hop 1 billed, hop 2 not, outer
   not. Port 9558. Balances read with the settle-then-assert pattern
   (`settledBalance` in `test/direct-peer-channels/06-no-double-billing.js`) —
   the outer charge is fire-and-forget, so reading straight out of the invoke
   callback races.
5. `05-module-identity.js` — `identityForModule` on both providers, plus the
   no-binding and two-bindings cases. Must probe sqlite3 in a **child process**
   the way `test/auth/03-sqlite-provider-unit.js` does: a mismatched native
   binding segfaults the whole run with zero output rather than throwing, which
   would present as a mystery suite failure.
6. Duplicate-deviceID: two modules sharing a `friendlyName` are refused with
   both named. Belongs with the prerequisite commit.

At least two of these written **A/B** — failing against today's code and passing
after — not only passing after.

**Must not move:**

- `npm run golden` — unchanged by construction, since nothing it reads is
  touched. If it moves, the design leaked into the published surface.
- `test/auth/13-ctx-billing-identity.js` — passes untouched. It exercises
  `ctx.serviceClient` with split authorization/billing identities and is the
  proof the old API is genuinely unchanged.

## Sequence

1. Duplicate-deviceID overwrite fix (own commit).
2. `lib/call-address.js` + the derivation move, with `01-call-address.js`.
3. `identityForModule` across the three provider files, with
   `05-module-identity.js`.
4. `ctx.call` in `handler-ctx.js`, with `02-ctx-call.js`.
5. Load-time verification in `device-manager.js`, with `03-declaration.js`.
6. `04-failure-and-billing.js`.
7. Convert `repo-review`; re-measure the README's 428× figure and confirm it is
   unchanged.
8. `validate_plan` / CLI checking.
9. Docs.
