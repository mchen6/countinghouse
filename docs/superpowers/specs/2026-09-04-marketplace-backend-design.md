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
of produced by a workflow — the error text for `USER_HAS_NO_DEVICE` used to
read "please add it from the app marketplace" until this branch corrected
it. What did not survive: storage, browse, and the request/approve workflow.

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
out. It would contradict the project's own honest security positioning. It is
the main reason D4 leaves obtaining code entirely to the operator.

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

### D4 — One install path: the operator installs, the runtime never fetches

The operator runs `npm install <pkg> --registry <theirs>` into the module
directory (`options.modulePath`, default `~/countinghouse_modules`), then
loads it. **countinghouse never touches the network to obtain code.**

This keeps fetch-then-execute — the classic supply-chain hole — out of the
server entirely, which matters because `countinghouse_load_module` already
`require()`s a caller-supplied path unsandboxed in the main gateway process.
Adding a network fetch immediately upstream of that would compound the one
genuinely dangerous thing the runtime already does.

**Remote install was designed and deliberately not built.** A
`countinghouse_install_module` tool taking `{name, version}` — gated behind
an off-by-default flag, an explicitly configured registry, and mandatory
validation — was specified and then retired before implementation. The
reasoning: it is ergonomic surface, not capability. Everything it would do,
the operator can already do with `npm install` followed by the existing
`countinghouse_load_module`, using tools they already trust and already
have. The gated version would have added a fetch-then-execute path, three
new configuration knobs, and its own security-gating tests, to save one
shell command that the operator running third-party code should arguably be
typing deliberately anyway.

If it is ever wanted, the constraints it needs are recorded above and should
be reinstated together: off by default, registry explicitly configured with
no implicit fallback, and validation mandatory on that path specifically —
because it is the path where countinghouse itself fetched the code.

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

### 2. One validator

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

### 3. Removals

- `/verify-module` and `ModuleManager.prototype.verifyModule` — superseded
  (§2).
- `/devices/:deviceID/download-package`, `CdifInterface.getDevicePackageModulePath`,
  `DeviceManager.onGetDevicePackageModulePath` and the
  `getdevicepackagemodulepath` event — it packaged a loaded module for
  someone to download, which was CEAMS's download step. Under D3 npm serves
  packages; nothing consumes this.
- ~~`example/publish-api.js`~~ — **not removed, and nothing to remove.**
  Written into this spec in error: the file is *not tracked*. Commit
  `182db48` (2026-08-17) added `example/` to `.gitignore` and untracked the
  whole directory, deliberately leaving the files on disk. So the 2015
  `nano`/CouchDB publish path already sits outside what this repo ships, and
  deleting it would produce no diff while destroying maintainer-local
  material. Corrected 2026-09-04 after the error was caught mid-implementation.
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
- **The runtime never fetches code over the network** (D4). Obtaining a module
  is the operator's action, taken with their own tooling. Reinstating remote
  install means reinstating all three of D4's constraints together.

## Testing

- **Removed routes 404**, in the established shape of
  `test/auth/14-removed-callback-routes.js` and
  `test/auth/16-removed-iot-routes.js` — including a guard case proving the
  server is up, so a 404 cannot pass for the wrong reason.
- **The surviving routes still work**: `/get-module-device-list` returns a
  loaded module's device list, and `/devices/:deviceID/package-info` returns
  `{name, version}`. Neither has ever had a test; removing their neighbours
  is the right moment to add one, and without it their matrix rows would
  assert behavior nothing checks.
- **The route-inventory guard will fail until the golden is regenerated** —
  `test/module-loading/11-route-inventory.js`. That is the guard working as
  intended, and this is its first real exercise since it shipped.
- **No new tests for gating or registries**: D4 builds nothing that needs
  them.

## Files

Modified: `lib/route-manager.js`, `lib/module-manager.js`,
`lib/countinghouse-interface.js`, `lib/device-manager.js`,
`lib/cli-options.js`, `server.json`, `package.json`,
`docs/cross-cutting-matrix.md`, `docs/security-model.md`, `CHANGELOG.md`,
`test/fixtures/route-inventory.json`.

Removed: `lib/routes/verify-module.js`,
`lib/routes/download-device-package.js`. (`example/publish-api.js` is untracked —
see Removals.)

Added: a regression/coverage test for the removed and surviving package
routes.

## What #3 inherits

A defined counterparty (the operator's own users), a live prepaid provider
(`RedisMeteringProvider`), and one open question: how a balance gets topped
up, and whether `x402-provider.js` becomes real or is retired. #3 is
unblocked by this spec and is substantially smaller than it appeared while
the marketplace question was open.
