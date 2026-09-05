# What "marketplace backend" means

Roadmap item #2 / Track B1. The decision this item exists to make, plus the
work that follows from it. Unblocks #3.

Verified against `master` at `e22f83e` on 2026-09-04. Every claim names the
file that backs it — re-check rather than believe.

## The question

`server.json:4` and `package.json:4` both describe this project as a
"Multi-tenant runtime and monetization/marketplace backend for MCP tools."
The runtime half is real. The marketplace half has never existed in this
repo, and the code that gestured at it — `example/publish-api.js`, a
`nano`/CouchDB script with a hardcoded tarball path — is 2015-era.

The pre-release audit recorded this as the largest gap between what the
project claims and what it is. #3 (real payment settlement) was blocked
behind it, because you cannot design settlement without knowing who is
settling with whom.

## Background: what the marketplace routes were actually for

Supplied by the maintainer on 2026-09-04. **This is not recoverable from the
repo** — the other system is gone.

**CEAMS** was an all-in-one platform for API package development,
verification, download and publishing, with a marketplace feature. **CDIF
(now countinghouse) was its verification and runtime half.** An author built
a package in CEAMS; CEAMS called CDIF's `/verify-module` — whose body still
carries `apiDesignID`, a CEAMS concept and the clearest surviving proof of
the coupling — then `/get-module-device-list` to learn what the verified
package exposed. CEAMS published it to CouchDB-backed storage and listed it
on its website. Other users browsed, applied for access, the author
approved, and approved users could then invoke that package's APIs.

**CEAMS is retired.** This is a clean-slate decision, not an integration.

What survived in countinghouse: the *verify* end and the *enforcement* end.
An AuthProvider entry's per-apiKey `devices: [...]` list is exactly the
"author approved this user for this package" state, just hand-edited instead
of produced by a workflow — the error text for `USER_HAS_NO_DEVICE` still
reads "please add it from the app marketplace". What did not survive:
storage, browse, and the request/approve workflow.

## The answer

**countinghouse is a self-hosted, multi-tenant MCP runtime that hosts
third-party npm-distributed modules under operator review. It is not a
marketplace, and stops claiming to be one.**

Its contributions are the two things only it can do: **validation** of a
module against the runtime's own contract, and **metered,
access-controlled hosting**. Distribution, storage, cataloguing and
discovery are npm's job.

Five decisions produced that answer.

### D1 — Tenancy: self-hosted per operator

Each operator runs their own countinghouse for their own tools and their own
users. Not one central deployment that authors publish into.

**Consequence:** package storage, browse, and the author↔consumer
request/approve workflow are all out of scope permanently, not deferred.
Access control is operator↔their own users, which the AuthProvider already
does.

### D2 — Module origin: third-party, operator-vetted

Operators install modules written by others, having vetted them.

This is not a new position — `docs/security-model.md` already commits to it:
"worker-thread isolation + module review (verify/publish) fits a
**semi-trusted marketplace model** — modules are vetted by the platform
operator ... not open to anonymous, unreviewed code execution," and
explicitly not a boundary for "arbitrary, adversarial, unreviewed code from
the open internet," because the isolation is "same process, separate heap."

**Consequence:** a frictionless install-anything-from-anywhere flow is ruled
out. It would contradict the project's own honest security positioning. This
is why remote install is opt-in and gated (D4).

### D3 — Distribution: npm, registry-agnostic

Modules are ordinary npm packages. `npm publish` is the publish story; the
registry is whichever npm-compatible registry the operator configures —
npmjs.com, a private Verdaccio, GitHub Packages, Artifactory. countinghouse
builds no publish, storage or browse machinery.

This matches the artifact shape the code already expects. Every module is a
`package.json` + `api.json` + `schema.json`, and
`ModuleManager.prototype.verifyModule` (`lib/module-manager.js:633`) reads a
**gzipped tarball** — it unzips, untars, and parses exactly those three
files. That is the npm artifact.
`pre-installed-packages/cdif-load-test-0.0.4.tgz` is one.

It also matches an existing decision: `CLAUDE.md` already says to drop the
private registry dependency entirely. `--regUrl`, defaulting to
`http://127.0.0.1:8037/` (the old kappa registry), is that dependency's last
trace.

**Not the MCP registry.** `server.json` targets the MCP registry schema
(`2025-09-29`), and that is correct — but it lists **countinghouse itself**
as an MCP server. A module hosted *inside* countinghouse is not separately an
MCP server. The MCP registry answers "how do I find countinghouse," not "how
do I find a module for it." Conflating the two is a category error this
design explicitly avoids.

### D4 — Two install paths, one default

**Default, and the documented path:** the operator runs
`npm install <pkg> --registry <theirs>` into the module directory
(`options.modulePath`, default `~/countinghouse_modules`), then validates and
loads. **The runtime never touches the network.** This keeps
fetch-then-execute — the classic supply-chain hole — out of the server
entirely, which matters because `countinghouse_load_module` already
`require()`s a caller-supplied path unsandboxed in the main gateway process.

**Opt-in:** a new `countinghouse_install_module` tool does name → live tool
in one call, behind three constraints:

1. **New flag `--allowRemoteInstall`, off by default.** Gated exactly like
   the existing authoring tools (`lib/mcp/gateway.js`): with the flag off the
   tool answers **identically to an unknown tool**, so its existence is not
   an oracle; an authenticated non-admin caller gets `ADMIN_REQUIRED`.
2. **Validation is mandatory on this path**, not advisory. Any problem the
   validator reports refuses the load. The operator path may skip validation;
   this one may not, because it is the path where countinghouse itself
   fetched the code.
3. **The registry must be explicitly configured** — a new `--moduleRegistry
   <url>`. Flag on with no registry set refuses. There is deliberately no
   implicit default, so no operator silently installs from wherever npm
   happens to point.

### D5 — Payments (#3) reframed: the operator bills their own users

Self-hosting means there is no author↔operator commercial relationship, so
**module authors cannot be paid through countinghouse.** No revenue share, no
payouts, no escrow.

#3 therefore shrinks to: how does a user's prepaid balance get topped up, and
what settles it. `RedisMeteringProvider` (`lib/metering/redis-provider.js`)
already implements the prepaid balance and is the live provider.
`lib/metering/x402-provider.js` — whose own header says it is "NOT a working
payment integration" — is left in place; whether it stays is #3's call, not
this spec's.

The billing-authority principle is unaffected: platform metering remains the
only thing that deducts balance (`docs/design-decisions.md`).

## Design

### 1. Positioning, corrected

`server.json:4` and `package.json:4` change from "Multi-tenant runtime and
monetization/marketplace backend for MCP tools" to a description matching
D1–D3: a multi-tenant runtime for MCP tools, with metering and access
control. `package.json:46`'s `marketplace` keyword goes.

`docs/security-model.md`'s "Positioning" section keeps its semi-trusted
framing — D2 confirms it rather than changing it — but its phrase
"marketplace model" is clarified to mean operator-vetted third-party
modules, not a marketplace this project operates.

### 2. `countinghouse_install_module`

Input `{name: string, version?: string}`. Registry comes from
`--moduleRegistry`, never from the caller — a caller-supplied registry would
let an admin-keyed request pull from anywhere, defeating D4.3.

Sequence: resolve the target directory under `options.modulePath` → fetch via
npm into it → run the validator (§3) → on a clean result, load through the
existing `countinghouse_load_module` path → record provenance (§4) → return
the loaded tool names, reusing `countinghouse_load_module`'s existing output
shape including `discoveryComplete`.

Any validator problem aborts before load, and the tool returns the validator's
full problem list — every problem, each naming its stage and the way out,
which is what that validator already produces.

**Which npm binary.** `bin/countinghouse-validate.js` is already invoked via
`process.execPath` rather than PATH, with an in-code comment explaining that
the child must run under the exact Node binary already running the gateway.
The same care applies here: resolve npm as
`path.join(path.dirname(process.execPath), 'npm')`, fall back to `npm` on
PATH only if that does not exist, and **log the resolved path** at install
time so which npm ran is a recorded fact rather than an inference.

### 3. One validator

Everything consolidates on `lib/module-validator.js`, reached through
`bin/countinghouse-validate.js --json` in a child process — the shape
`countinghouse_validate_module` already uses.

`ModuleManager.prototype.verifyModule` and its route are removed as
superseded. The modern validator is strictly better on every axis: it runs
caller-supplied code in a **child process** rather than in-process, it
cross-checks `api.json`, `schema.json` **and the handler map** against each
other rather than only parsing three files, and it reports **every** problem
rather than the first. The tarball input existed because CEAMS uploaded a
`.tgz`; under D3 npm does the untarring, so directory-based validation is the
correct shape.

**Trap, stated because the names collide.** `verifyModule` is two unrelated
things. The **method** `ModuleManager.prototype.verifyModule` has exactly one
caller — `lib/routes/verify-module.js:15` — and goes with the route. The
**flag** `options.verifyModule` is a different thing entirely and **stays**:
it drives fall-through behavior at `lib/device-manager.js:142,162,166,183`
and gates `--debug --verifyModule` reporting at
`lib/countinghouse-util.js:174,283`. Removing the flag would break module
verification behavior that has nothing to do with the route.

### 4. Provenance

An operator running third-party code must be able to answer "what am I
running, and where did it come from?" Each loaded module records: `name`,
`version`, `source` (an absolute local path, or the registry URL it was
fetched from), and whether it was validated at load.

`/devices/:deviceID/package-info` today returns only `{name, version}`
(`lib/routes/get-device-package-info.js`). It is extended to carry the
provenance record — which turns one of the four routes A3 deliberately
deferred into a route with a real job.

### 5. Removals

- `/verify-module` and `ModuleManager.prototype.verifyModule` — superseded
  (§3).
- `/devices/:deviceID/download-package`, `CdifInterface.getDevicePackageModulePath`,
  `DeviceManager.onGetDevicePackageModulePath` and the
  `getdevicepackagemodulepath` event — it packaged a loaded module for
  someone to download, which was CEAMS's download step. Under D3 npm serves
  packages; nothing consumes this.
- `example/publish-api.js` — the `nano`/CouchDB publish remnant, with a
  hardcoded `/home/mchen6/tmp/...` path.
- `--regUrl` — the private-registry default (D3).

**`/get-module-device-list` stays.** It answers "what does module X expose"
for a module loaded at any earlier time, which `countinghouse_load_module`'s
return value cannot — that only reports the module it just loaded.

Both surviving routes get the `docs/cross-cutting-matrix.md` rows they have
never had, closing part of the gap the A3 work recorded in that file's
"Relationship to route-inventory.json" paragraph.

## What this forecloses

Recorded so it is a decision rather than an omission:

- **Module authors cannot be paid through countinghouse** (D5).
- **There is no package discovery inside countinghouse.** An operator finds
  modules the way they find any npm package.
- **There is no author↔consumer approval workflow.** The AuthProvider's
  `devices: [...]` list remains operator-managed configuration.
- **Anonymous, unreviewed module execution stays unsupported** (D2). Changing
  that requires the isolation hardening in `docs/security-model.md`'s roadmap
  first, not a new install path.

## Testing

- **Gating**: `--allowRemoteInstall` off ⇒ `countinghouse_install_module`
  answers exactly like an unknown tool, including for an unresolvable
  identity; flag on + authenticated non-admin ⇒ `ADMIN_REQUIRED`. Mirrors
  `test/auth/06-admin-gating.js` and the authoring-tool tests.
- **Registry required**: flag on, `--moduleRegistry` unset ⇒ install refuses
  with a distinct code, and nothing is fetched.
- **Validation is a gate**: installing a package with a known defect (a
  fixture with a dangling schema pointer or an undeclared handler) must fail
  and must leave nothing loaded — asserted by `tools/list` being unchanged
  afterwards, not merely by the tool's return value.
- **Provenance**: a module installed remotely reports its registry as
  `source`; one loaded from a path reports that path.
- **Removed routes 404**, in the shape of `test/auth/16-removed-iot-routes.js`.
- **The route-inventory guard will fail until the golden is regenerated** —
  `test/module-loading/11-route-inventory.js`. That is the guard working as
  intended, and this is its first real exercise.

## Files

Added: `lib/routes/` — none (the install path is an MCP tool, not an HTTP
route); the tool definition in `lib/mcp/tool-registry.js` and its handler in
`lib/mcp/gateway.js`; a provenance record in `lib/module-manager.js`.

Modified: `lib/mcp/tool-registry.js`, `lib/mcp/gateway.js`,
`lib/cli-options.js`, `lib/module-manager.js`, `lib/route-manager.js`,
`lib/routes/get-device-package-info.js`, `lib/countinghouse-interface.js`,
`lib/device-manager.js`, `server.json`, `package.json`,
`docs/cross-cutting-matrix.md`, `docs/security-model.md`, `CHANGELOG.md`,
`test/fixtures/route-inventory.json`.

Removed: `lib/routes/verify-module.js`,
`lib/routes/download-device-package.js`, `example/publish-api.js`.

## What #3 inherits

A defined counterparty (the operator's own users), a live prepaid provider
(`RedisMeteringProvider`), and one open question: how a balance gets topped
up, and whether `x402-provider.js` becomes real or is retired. #3 is
unblocked by this spec and is substantially smaller than it appeared while
the marketplace question was open.
