# Changelog

Notable changes per release. Releases before 6.1.0 carry their notes in
their annotated git tag (`git show v6.0.0`); this file starts the in-repo
record and 6.0.0 is summarized below as the baseline.

This project follows [semantic versioning](https://semver.org/), where the
public surface is the CLI flags, the MCP contract, the module format, and
the auth config.

## 7.0.0 (unreleased)

### Security — the authenticated read paths are now rate limited

- **`GET /balance`, the `countinghouse_check_balance` MCP tool, and
  `tasks/get` / `tasks/result` / `tasks/list` / `tasks/cancel` now enforce
  `--apiKeyRateLimit`.** All five were authenticated but unlimited: each was
  one Redis round trip that an authenticated caller could poll as fast as it
  liked. This closes the last open item from the pre-release audit's security
  findings.
- **`POST /devices/:deviceID/add-job` is now limited too, closing a real
  bypass.** MCP task creation is deliberately limited at creation time
  (unbounded queue growth being the resource protected), but `add-job`
  creates the same jobs over HTTP and was not limited at all — so the MCP
  limit could be sidestepped by choosing the other door. The three HTTP job
  *read* routes (`get-job`, `get-job-history`, `remove-job`) are gated as
  well; `docs/cross-cutting-matrix.md` had asserted a limit for all four that
  the route stack never actually applied.
- **Reads share the existing per-apiKey budget** rather than getting a flag
  of their own. A client that polls `tasks/get` while a task runs draws down
  the same allowance its tool calls use. No new CLI flag.
- **New error code `RATE_LIMIT_EXCEEDED`** (both locales). HTTP denials
  answer **429**, not the 500 the pre-existing limiters produce via
  `lib/session.js`; `invoke-action`'s existing 500 is unchanged. MCP denials
  keep each surface's existing shape — a tool error for
  `countinghouse_check_balance`, a JSON-RPC error for `tasks/*`.
- **Unchanged: the limiter still fails open** — flag unset, no metering
  provider, unresolved key, or Redis down all pass the request through, as
  every pre-existing rate-limit call site already did.
- Not covered, deliberately: both direct-peer-channel paths (unchanged
  decision) and `tools/list`.
- Test: `test/auth/15-read-path-rate-limits.js`.
### Fixed — an unresolvable tool schema is no longer a silent downgrade

- **A declared schema pointer that fails to resolve is now logged at error
  level**, naming the tool, which schema (input vs output), the pointer, the
  concrete reason, and the consequence. `resolveSchemas`
  (`lib/mcp/tool-registry.js`) previously dropped the error on both branches
  and advertised `{type: 'object', properties: {}}` — "any object is fine" —
  in place of the real schema, so a client would send what that permits and
  the call would then fail server-side in `validateActionCall`, with nothing
  upstream to explain it. New error code `TOOL_SCHEMA_RESOLVE_FAIL`.
- **Behavior is otherwise unchanged**: the tool is still advertised, still
  with the permissive default schema. Omitting it instead would move the
  `tools/list` surface, and is deliberately out of scope here.
- Worth knowing if you relied on `--debug` to surface this: there was an
  incidental error log on this path from `lib/session.js`, but it fires only
  under `--debug` and names neither the tool nor which schema. A normal
  (non-`--debug`) run produced **no** error records at all for a dangling
  pointer.
- "No schema declared" stays silent — that is legitimate and common.
- Test: `test/module-loading/10-schema-pointer-not-silent.js`.

### Removed — the IoT-era HTTP surface

- **The dead entry paths are gone**: `/devices/:deviceID/connect` and
  `/disconnect` (both called a `CdifInterface` method that was never
  defined, so every POST threw `TypeError`), `/discover` and
  `/stop-discover` (mounted only under `allowDiscover`, which
  `cli-options.js` hardcoded to `false`), and
  `/devices/:deviceID/presentation` (dead twice over — nothing emitted the
  event that mounts it, and the mount handler called an undefined method).
  Breaking on paper; no behavior change in fact.
- **The vestigial flag-gated surface is gone**, and this one *is* a
  behavior change: the OpenStack simulation (`--simOpenStackAPI`) and
  `/load-profile` (`--loadProfile`), together with both flags. The
  OpenStack routes were mounted with **no authentication at all** and
  hardcoded a single 2015 vendor target; `/load-profile` was the only
  reader of the `loadLevel` counter, which goes with it. **Unknown flags
  are ignored**, so a startup script still passing either one boots
  normally and simply gets no route.
- **`device_access_token` plumbing removed.** `ensureDeviceState` took the
  token and never read it, `lib/device-auth.js` was imported by nothing,
  and `/connect` — which would have issued one — is removed above. A
  client still sending the field is unaffected: it was already ignored.
- **Error codes removed** (both locales): `PRESENTATION_NOT_SUPPORTED`,
  `GET_DEVICE_ROOTURL_FAIL`, `PARSE_DEVICE_ROOTURL_FAIL`.
- **Capability genuinely lost:** the OpenStack-shaped simulation shim.
  Nothing else here worked.
- **Not removed, deliberately:** `/devices/:deviceID/package-info`,
  `/download-package`, `/verify-module` and `/get-module-device-list`.
  They are untested and undocumented, but they are also the only existing
  bones of the publish/listing story, so they wait on that design rather
  than being pre-decided here.
- **New guard:** `test/module-loading/11-route-inventory.js` diffs the
  mounted routes against `test/fixtures/route-inventory.json`, so a new
  entry path fails the suite until it is declared and given its
  cross-cutting-matrix row.
- Tests: `test/auth/16-removed-iot-routes.js`,
  `test/module-loading/11-route-inventory.js`.

### Removed — the dead device-callback entry path

- **`/callbacks/:deviceID/*` is gone**, together with
  `CdifInterface.invokeDeviceCallbacks`, `DeviceManager.onInvokeDeviceCallback`,
  `CHDevice.invokeDeviceCallback`, the `invoke-device-callback` worker message,
  and the `DEVICE_CALLBACK_NOT_AVAILABLE` / `DEVICE_INVOKE_CALLBACK_FAIL` error
  codes. This is a breaking change to the HTTP surface and to `CHDevice`, which
  is why it lands in a major — but nothing functional is lost. The chain ended
  at `this._deviceCallbackHandler`, **a property nothing in the repo ever
  assigned**, so every request that reached the route came back
  `DEVICE_CALLBACK_NOT_AVAILABLE`. It was dead code in the same sense as the
  event subsystem removed in 5.0.0: the front door worked, the delivery never
  did.
- The route was also mounted with no authentication at all ("callback don't do
  user auth"), reachable whenever the server was. It was flagged in the
  pre-release audit as needing review before any public deployment; the review
  concluded there was nothing there to secure.
- A CDIF-era inbound webhook has no MCP equivalent, and since 5.0.0 removed
  event delivery there is no path from an inbound request to a connected
  client. Reinstating inbound webhooks means supplying both halves.
- Test: `test/auth/14-removed-callback-routes.js`.

### Removed — the OAuth device path

- **`/callback_url` is gone**, together with `lib/oauth/`, the `oauth` npm
  dependency, `CHDevice.setOAuthAccessToken`, `CHDevice.oauthTokenValidate`,
  the `oauth_version` branch in `DeviceManager.onDeviceOnline`, and the
  `CANNOT_SET_OAUTH_ACCESS_TOKEN_INVALID_INTERFACE` /
  `OAUTH_ACCESS_TOKEN_NOT_AVAILABLE` error codes. Nothing regresses, because
  none of it was reachable: `lib/routes/oauth-callback.js` called
  `cdifInterface.setDeviceOAuthAccessToken(...)`, **a method never defined on
  `CdifInterface`**, so every GET threw `TypeError` and answered 500. It also
  read `req.session`, which only `routes/user.js` and `routes/admin-only.js`
  ever set, and neither was mounted on that path. Nothing outside
  `lib/oauth/oauth.js` itself ever set `oauth_version`, and
  `oauthTokenValidate` had no callers at all.
- **What this does remove is a module's ability to hold a third-party API's
  OAuth token.** MCP's authorization framework covers client→server — which is
  what AuthProvider and `X-CH-Key` already do — and deliberately leaves
  server→third-party credentials to the implementation. That gap is now
  unfilled rather than filled-but-broken, and wants its own design when a
  module actually needs it.
- A module's *own* redirect flow is untouched: `connectionState:
  'redirecting'` is driven by a module's `_connect` returning a `redirectObj`
  and never depended on any of the above.

## 6.1.0

Two new subsystems, both additive: a toolchain for authoring modules, and an
API for modules to call each other by name. `api.json`, `schema.json` and the
MCP contract are unchanged — `tools/list` remains byte-identical to the golden
sample, asserted on every commit.

### Added — composition: modules call each other by name

- **`ctx.call(address, input, opts)`**. A handler reaches another module as
  `<module>/<service>.<action>` — `repo-scan/scanService.scan` — instead of a
  pasted deviceID UUID, a service URN and a hand-built client. `opts.detail`
  returns `{data, platformMetering}` where the plain form returns `data`.
- **`countinghouse.calls` in `package.json`** declares every address a module
  is allowed to call. An address outside the declared set is refused.
- **`runsModules` in the auth config** binds the identity a module's hops are
  *authorized* as. Which identity a module runs as is the operator's decision,
  not the author's, so the same module can be deployed twice under two
  identities. Both auth backends implement it (`identityForModule` on the file
  and sqlite providers).
- **Everything is verified at load time, not at first call.** Every declared
  address is resolved against the target's real spec, the identity is bound, a
  duplicate binding is refused, and the bound identity's grant to each target
  is checked. A typo fails the module at startup with a message naming the
  module, the address and the file to fix.
- Authorization and billing stay two different identities: a hop is authorized
  as the bound identity and billed to `ctx.caller`, the real outer caller, so
  per-hop cost lands on whoever made the outer call.
- `ctx.serviceClient` remains the escape hatch for a per-call identity override
  or a module that legitimately needs two identities.

### Added — the module-authoring toolchain

- **`--authoringTools`** (default off) exposes four MCP tools behind a second,
  independent admin-key gate: `countinghouse_validate_plan`,
  `countinghouse_validate_module`, `countinghouse_load_module` and
  `countinghouse_call_tool`. Default-off matters because `load_module` plus
  `call_tool` is arbitrary code execution with a friendly name. With the flag
  off the tools are byte-identical to tools that do not exist — same envelope,
  same error code, produced by the same line of code as a genuinely unknown
  tool.
- **`countinghouse-validate`**, a new bin: the same validation oracle from a
  shell, no server required. `--json` emits a machine-readable result.
- `countinghouse_validate_module` runs the module under test in a **spawned
  child process**, so a crash or a `process.exit()` in caller-supplied code
  kills the child rather than the gateway, and a re-validated module is never
  served from a stale `require` cache.
- The `countinghouse-module` skill ships in-repo (`.claude/skills/`), so
  pointing a coding agent at a clone is enough.

### Fixed

- **`ctx.call` refusals now carry typed error codes** — `CTX_CALL_NOT_READY`,
  `CTX_CALL_UNBOUND`, `CTX_CALL_UNDECLARED`, `CTX_CALL_BAD_ADDRESS`,
  `CTX_CALL_UNRESOLVED` — reaching an MCP client in `structuredContent.code`.
  They previously collapsed into the generic `DEVICE_INVOKE_EXCEPTION`, making
  a misconfigured chain indistinguishable from a callee that genuinely crashed.
- **The startup window identifies itself.** Composition verification is
  asynchronous and runs after discovery, while a device is already listed and
  serving. A call landing in that window is now refused with
  `CTX_CALL_NOT_READY` ("retry") instead of being blamed on an auth config that
  was already correct.
- **A bare instance completes discovery.** `allmodulediscovered` was gated on a
  startup module count an instance with no `--loadModule` flags never reached,
  so composition verification never ran there and every runtime-loaded module's
  `ctx.call` was refused. This was exactly the `--authoringTools` workflow,
  which is designed to start with no modules.
- **A deviceID already registered by a different module is refused** rather
  than silently taking over the existing registration.
- Re-verification after a runtime module load no longer purges devices that are
  already online and serving; it only clears their composition binding.
- `errCode` now rides the main-thread-routed reply envelope, so an inner hop's
  error code survives the worker boundary on the default path as it already did
  under `--directPeerChannels`.
- The heap-stat timer is installed once per process instead of once per
  discovery event.
- Authoring fixes: a module's own load-time stdout no longer shadows the CLI's
  `--json` line, `load_module`'s wait on a hanging module is bounded, and
  `validate_plan` resolves `plan.calls` against live specs and catches
  duplicates.

### Changed

- `spec/schema.json` relaxes a device's `modelDescription` to 4096 characters,
  matching what an action's `description` already allowed.

### Docs

- `examples/repo-review` — a composite tool that reads a repository and never
  returns the source it read — with `npm run demo:repo-review` to start it in
  one command.
- The README leads with composition; reference material moved into `docs/`.
- All three benchmarks re-measured, with every citing document updated.

## 6.0.0

A breaking release for module authors; `api.json`, `schema.json` and the MCP
contract were unchanged. A module became its handlers — `index.js` and
`device.js` are gone, handlers are `async (input, ctx) => ({output})`, and the
framework assembles the device from `api.json`. See
[`MIGRATION.md`](MIGRATION.md) for the conversion, `git show v6.0.0` for the
full notes, and `npx countinghouse-migrate-module` for the automated path.
