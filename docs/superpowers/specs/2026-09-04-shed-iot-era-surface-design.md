# Shedding the IoT-era HTTP surface

Roadmap item #4 / Track A3. Breaking, so it lands in the open 7.0.0 window.

Verified against `master` at `fa888b2` on 2026-09-04. Every claim below names
the file that backs it — re-check rather than believe, the tree moves.

## The problem

The runtime still mounts the entry paths of a 2015 IoT device gateway. Two
separate costs:

1. **Most of them do not work.** Five are dead in the same way `/callbacks`
   and `/callback_url` were dead when 7.0.0 removed them: they call a method
   nothing defines, or they are gated on a flag hardcoded to `false`.
2. **Every surviving route is a permanent obligation.** It owes a
   `docs/cross-cutting-matrix.md` row, an auth story, and a metering story,
   forever. `/callbacks` stayed unauthenticated for years precisely because
   nobody had enumerated the routes, and the matrix documents that same bug
   shape recurring four times.

The second cost is the stronger reason to act, and it is not paid off by
removal alone — a smaller surface that is still unenumerated grows back. So
this item ships a guard as well as a deletion.

## Scope

**In:** entry paths, the CLI flags that exist only to mount them, the inert
`device_access_token` plumbing, and a route-inventory guard.

**Out, deliberately:**

- **`lib/device-manager.js`'s size** (1488 lines). The roadmap bundled it with
  this item, but they are independent: the discovery machinery is load-bearing
  (see below), so route removal deletes ~0 lines from that file. Splitting it
  is a non-breaking internal refactor that does not need the 7.0.0 window.
- **The package/marketplace routes** — `/devices/:deviceID/package-info`,
  `/download-package`, `/verify-module`, `/get-module-device-list`. They have
  zero literal test or doc hits and look like removal candidates, but the
  roadmap names exactly these as "the bones exist" for item #2 (B1, deciding
  what "marketplace backend" means). Removing them here would pre-decide an
  architectural question B1 exists to answer. **Handed to B1 as explicitly
  undecided.**

## What is dead, and how it is known

### Group 1 — provably dead

| Path | Why it cannot work |
|---|---|
| `/devices/:deviceID/connect` | `lib/routes/connect.js:20` calls `cdifInterface.connectDevice`, **defined nowhere in the repo** → `TypeError` on every request. It also references `CHError` twice without importing it — its only `require` is `express` — so its own validation branches throw `ReferenceError` |
| `/devices/:deviceID/disconnect` | `lib/routes/disconnect.js:12` calls `cdifInterface.disconnectDevice`, likewise never defined |
| `/discover`, `/stop-discover`, and the `app.use('/', user)` mount beside them | All three sit inside `if (options.allowDiscover)` (`lib/route-manager.js:113`), and `lib/cli-options.js:7` sets `this.allowDiscover = false` unconditionally, with the comment *"disable allowDiscover flag because it is broken under worker thread mode"*. Never mounted |
| `/devices/:deviceID/presentation` | Dead twice over. `RouteManager.mountDevicePresentationPage` runs only on the `presentation` event, and `deviceManager` never emits it — the only emit is `CdifInterface`'s own re-emit (`lib/countinghouse-interface.js:203`) of an event it subscribes to at line 88 and nothing raises. And if it did run, `lib/route-manager.js:137` calls `this.cdifInterface.getDeviceRootUrl`, **not defined on `CdifInterface`** |

None has a literal test or doc reference. The two `/connect` hits in
`test/unit/test001.js:83,91` are both commented out.

### Group 2 — reachable, but vestigial

- **OpenStack simulation**, `/v2/:tenantID/servers` and
  `/v2/:tenantID/servers/:serverID` (`lib/routes/openstack/`), behind
  `--simOpenStackAPI`. `createServer.js` hardcodes a single 2015 China Mobile
  target — deviceID `46932cf8-…`, a Chinese `serviceID` and `actionName`. It
  is mounted **with no authentication**, and the code says so at the mount
  point (`lib/route-manager.js:93`, *"openstack api simulation don't do user
  auth"*). That is the same unauthenticated-and-reachable shape that put
  `/callbacks` on the pre-release audit's list; it is one CLI flag away from
  live.
- **`/load-profile`**, behind `--loadProfile`. `CdifInterface.getServerLoadLevel`
  (`lib/countinghouse-interface.js:207`) returns `lastMinuteLoadLevel` and
  ignores its `interval` argument.

### Group 3 — inert `device_access_token` plumbing

`DeviceManager.prototype.ensureDeviceState(deviceID, token, callback)`
(`lib/device-manager.js:1209`) **never reads `token`** — it checks the device
exists and is online, nothing more. The parameter is threaded in from
`invoke-action`, `get-spec` and `schema`, which read `req.body.device_access_token`.
`lib/device-auth.js` — the jwt/`device-db` implementation that would have
issued such a token — **is required by no file in the repo.**

`connect`, the route that would have issued the token, is in group 1.

## What must NOT be removed

Recorded because the obvious reading is wrong and a future reader will
re-derive it otherwise:

- **`CdifInterface.discoverAll` / `stopDiscoverAll`, and
  `DeviceManager.onDiscoverAll` / `onStopDiscoverAll` all stay.** They are not
  reachable only from the dead `/discover` routes — `lib/sandbox.js:119,123`
  calls both inside the worker's `discover-device` handler, which is on the
  normal module-load path in `--workerThread` mode. Only the HTTP routes go.
- **`CdifInterface.getDiscoveredDeviceList` stays** — `lib/routes/device-list.js:18`
  uses it for the `--debug` branch of the live `/device-list` route.
- **`options.verifyModule` stays.** It no longer gates any mount, but it still
  drives fall-through and reporting behavior inside `device-manager.js` and
  `countinghouse-util.js`.

## Design

### 1. Removal, in four commits

Each is independently mergeable and green on its own.

**Commit 1 — the dead entry paths.** Routes `connect`, `disconnect`,
`discover`, `stop-discover`; `lib/routes/connect.js`, `disconnect.js`,
`discover.js`, `stop-discover.js`; the `presentation` router,
`RouteManager.mountDevicePresentationPage`, and the `presentation` event wiring
in `countinghouse-interface.js`; `CHDevice.getDeviceRootUrl` and the
`devicePresentation` spec field it reads; the `allowDiscover` field in
`cli-options.js` and its three branches (`route-manager.js:113`,
`module-manager.js:71,77`). **No client-visible behavior changes** — every one
of these throws or never mounts today.

Note `module-manager.js:77`'s `if (options.allowDiscover === false)` wraps the
live discovery branches; removing the constant means unwrapping that block,
not deleting its body.

**Commit 2 — the vestigial surface.** `lib/routes/openstack/` and both mounts;
`RouteManager.installOpenStackRoutes`; `lib/routes/load-profile.js` and its
mount; `CdifInterface.getServerLoadLevel`, the `loadLevel` counter, its
initialization (`countinghouse-interface.js:37`) and its four increment sites
(lines 102, 108, 163, 177); the `--simOpenStackAPI` and `--loadProfile` flags
in `cli-options.js` including their entries in the options dump. **This one
does change behavior** for anyone who set either flag.

`/load-profile` and the `loadLevel` accounting go together: the route is the
only reader, so keeping the counter would leave it dead.

**Commit 3 — the inert token plumbing.** `lib/device-auth.js`; the `token`
parameter of `ensureDeviceState` and its six call sites
(`device-manager.js:1284,1293,1342,1369,1450,1463` — only 1293, 1342 and
1369 pass a token at all; the other three already pass `null`); the
`device_access_token` reads in `invoke-action.js:42`, `get-spec.js:10`,
`schema.js:10` and the `token` argument threaded from them through
`CdifInterface` and `DeviceManager`. Invisible to clients: a token sent today
is already ignored.

**Commit 4 — the guard.** Below.

### 2. The route-inventory guard

A test boots a `RouteManager` on a free port, walks the live Express stack, and
diffs the sorted mount paths against a checked-in golden file. Adding a route
fails the test until the golden file is updated — which is the point: the
author is made to look at the row they are adding.

Introspecting the **running app** rather than parsing `route-manager.js` source
means a mount added anywhere, by any mechanism, is still caught.

Mechanism, verified working against the installed express 4.22.2: recursively
walk `app._router.stack`; for each layer, decode `layer.regexp.source` back to a
path, substituting `layer.keys[i].name` for each `(?:/([^/]+?))` capture group;
recurse into layers whose `name === 'router'`; skip the `fast_slash` layers that
represent `use('/')`. A prototype produced exactly:

```
/devices/:deviceID/connect
/devices/:deviceID/schema
/mcp
/v2/:tenantID/servers
```

**Note:** `app.router` (no underscore) is a throwing deprecation getter in
express 4 — the guard must use `app._router`, and should assert it exists so an
express upgrade fails loudly rather than silently reporting an empty inventory.

The golden file lives at `test/fixtures/route-inventory.json`. The failure
message names `docs/cross-cutting-matrix.md` and tells the author to add the
row for their new path, since the row — not the golden file — is the actual
obligation.

This mirrors the existing golden `tools/list` contract already enforced by the
pre-commit hook, so it is an extension of a proven local pattern rather than a
new idea.

### 3. Documentation

- `docs/cross-cutting-matrix.md`: the OpenStack row (line 60) becomes a
  `➖ removed in 7.0.0` row in the exact style of the `/callbacks` row at line
  58 — stating that it was removed as an unauthenticated simulation shim, not
  as a working feature. Rows for the group-1 paths likewise. **Rows are
  rewritten, never deleted**: the matrix's own rule is that a missing row is
  worse than a blank cell, and the 5.0.0 event-channel row is the precedent for
  keeping a removed path's history visible.
- `CHANGELOG.md`: a `### Removed` section under `## 7.0.0 (unreleased)`,
  naming each path, why it could not work, and what capability (if any) is
  genuinely lost.
- The `--simOpenStackAPI` / `--loadProfile` removals are CLI-flag changes, and
  CLI flags are inside the CHANGELOG's stated definition of the public surface.
  They are the reason commit 2 needs the major.

## Capability genuinely lost

Only one: an operator can no longer run the OpenStack-shaped simulation shim.
Nothing else here worked. Following the precedent set by the OAuth removal,
this is recorded as a visibly empty gap rather than left apparently filled.

The `devicePresentation` spec field becomes meaningless and is removed with its
reader; no bundled module, example, test or doc sets it.

## Testing

- **`test/auth/16-removed-iot-routes.js`** — modeled directly on the existing
  `test/auth/14-removed-callback-routes.js`. Asserts 404 for every removed
  path, including the two flag-gated ones **with their flags set**, which is
  the case that would otherwise regress silently.
- **`test/module-loading/11-route-inventory.js`** — the guard, plus a
  negative case: mounting an extra route makes it fail, so the test is proven
  not to be vacuous.
- Full suite green before each commit: test1–test6 plus the globbed suites,
  skipping `test7.js` (a benchmark). Current baseline is 433 passing, 3
  pending, 0 failing.
- The pre-commit hook must stay green — it lints and asserts `tools/list` is
  byte-identical to the golden sample. None of these routes contributes a
  tool, so the MCP surface must not move.

## Files

Removed: `lib/routes/connect.js`, `disconnect.js`, `discover.js`,
`stop-discover.js`, `load-profile.js`, `lib/routes/openstack/createServer.js`,
`deleteServer.js`, `lib/device-auth.js`.

Modified: `lib/route-manager.js`, `lib/cli-options.js`,
`lib/countinghouse-interface.js`, `lib/module-manager.js`,
`lib/device-manager.js`, `lib/countinghouse-device.js`,
`lib/routes/invoke-action.js`, `get-spec.js`, `schema.js`,
`docs/cross-cutting-matrix.md`, `CHANGELOG.md`.

Added: `test/auth/16-removed-iot-routes.js`,
`test/module-loading/11-route-inventory.js`,
`test/fixtures/route-inventory.json`.

## Open question, deferred to B1

Whether `/devices/:deviceID/package-info`, `/download-package`,
`/verify-module` and `/get-module-device-list` survive at all. They are
untested and undocumented, and are also the only existing bones of the
publish/listing story. A3 leaves them mounted and unchanged; B1 decides.
