# Migration notes

## Versioning: why the first real release is 4.0.0

`countinghouse` is not a new package that happens to share code with something
older — it is the continuation of **CDIF 3.x** (`@apemesh/cdif`), renamed. The
version number carries that lineage forward rather than restarting it, so
`4.0.0` reads the way a major bump should: same project, breaking changes
since 3.x.

Those breaking changes, all documented below:

- **The module-facing global API was renamed twice**, `CdifUtil`/`CdifDevice`/
  `CdifError` -> `McpForgeUtil`/... -> `CHUtil`/`CHDevice`/`CHError`. A 3.x
  device module referencing the old names does not run unchanged.
- **`CHUtil.recordCall` was removed** and replaced by `CHUtil.recordUsage`,
  which is app-layer bookkeeping and never touches balance. Balance is now
  deducted exactly once per cross-worker call by the platform itself (the
  "billing authority" rule — see
  [`docs/design-decisions.md`](docs/design-decisions.md)). A module that
  metered itself under 3.x was double-billing and must drop that call.
- **The authorization model was rebuilt around `AuthProvider`**
  (`--authProvider file|sqlite|couchdb`), replacing the inline
  Redis-cache-then-CouchDB logic. Deployments that relied on the old CouchDB
  user schema keep working via the `couchdb` backend, but the default is now
  a flat `auth.json` and a separate `admin` capability gates the
  module-lifecycle endpoints. See
  [`docs/authentication.md`](docs/authentication.md).
- **The metering identity is unified on
  `encodeLegacyTool(deviceID, serviceID, actionName)`** across every entry
  path. Per-tool pricing or free-call quotas keyed by the old MCP tool name
  (`toolPriceRecord`) must be re-keyed.
- **The HTTP header is `X-CH-Key`** (was `X-Apemesh-Key`, then
  `X-MCPForge-Key`).

**About `countinghouse@0.0.1` on npm**: that was a name-reservation
placeholder published before any of this existed. It contains no usable
release and nothing upgrades from it. `4.0.0` is the first real published
version of this package.

**4.0.1 supersedes 4.0.0.** 4.0.0 shipped with `sqlite3` already optional,
but its failure message did not explain *why* the optional backend was
unavailable, and the limitation was undocumented. 4.0.1 adds the diagnosis
(the prebuilt binding needs glibc >= 2.38; the message reports the host's
actual version and both ways forward) and documents it in
[`docs/authentication.md`](docs/authentication.md#sqlite) and README. No API
changes -- if 4.0.0 works for you, 4.0.1 changes nothing but the error text
you see when it doesn't.

---

This project has been rebranded twice: `@apemesh/cdif` -> `mcpforge` -> `countinghouse`
(final name). Project history and origin are preserved (see README); these notes list
what changed on the public API surface for anyone integrating against the framework or
writing device modules, in chronological order.

## apemesh/cdif -> mcpforge

## Package and CLI

- npm package name: `@apemesh/cdif` -> `mcpforge`.
- CLI executable: `cdif` -> `mcpforge` (`bin/cdif` -> `bin/mcpforge`).
- `license` field corrected from the non-standard `"APEMESH standard license"`
  string to `"Apache-2.0"`, matching the repository's `LICENSE` file (Apache 2.0).
  This was a pre-existing typo, not a change of license terms.
- The `@apemesh/cdif-device-db` private-registry dependency was merged in-tree at
  `lib/device-db.js`. No private registry access is required to install anymore.

## Global API surface (breaking)

Device modules access framework helpers via globals injected by the sandbox. These
were renamed:

| Old | New |
|---|---|
| `global.CdifUtil` | `global.McpForgeUtil` |
| `global.CdifDevice` | `global.McpForgeDevice` |
| `global.CdifError` | `global.McpForgeError` |
| `global.DeviceError` | unchanged |

Device modules that reference `CdifUtil`, `CdifDevice`, or `CdifError` by name
(e.g. `CdifUtil.loadFile(...)`) need to update those references.

## HTTP header

- `X-Apemesh-Key` -> `X-MCPForge-Key`.

## Bundled example device modules

- The bundled `echo-device-module` and `echo-device-client-module` URN namespace
  changed: `urn:apemesh-com:serviceID:*` -> `urn:mcpforge-com:serviceID:*`. This
  only affects the framework's own example/test modules — URNs are chosen by each
  device module's author and are not enforced or parsed by the framework itself,
  so third-party device modules using any other namespace are unaffected.

## Not changed

- Device UUID generation (`lib/mcpforge-device.js`, `UUID.v5` namespace seed) was
  deliberately left as `https://registry.apemesh.com/packages/...`. This string is
  never dereferenced as a real URL — it is only a stable hash seed for deriving a
  device's persistent UUID from its `friendlyName`. Changing it would silently
  reassign the UUID of every existing device on upgrade, which is a far more
  disruptive break than the renames above, for no functional or user-visible
  benefit. It stays as-is intentionally.
- `error-info.zh-CN.json` (localized error messages) is kept, `zh-CN` is still
  available via `--locale zh-CN`. The default flipped to `en-US` afterward
  (commit `c95384b`); `error-info.en-US.json` has since reached full parity
  with `error-info.zh-CN.json` (same key set, currently 118 each).

## mcpforge -> countinghouse

`mcpforge` conflicted with an existing GitHub project/npm package, so the project
was renamed again to its final name, **countinghouse**, before any public release.

### Package and CLI

- npm package name: `mcpforge` -> `countinghouse`.
- CLI executable: `mcpforge` -> `countinghouse` (`bin/mcpforge` -> `bin/countinghouse`),
  with a short alias `cth` registered alongside it (both point at the same script).

### Global API surface (breaking)

The globals injected by the sandbox for device modules now use a short `CH` prefix
instead of the full `McpForge` prefix:

| mcpforge-era | countinghouse (current) |
|---|---|
| `global.McpForgeUtil` | `global.CHUtil` |
| `global.McpForgeDevice` | `global.CHDevice` |
| `global.McpForgeError` | `global.CHError` |
| `global.DeviceError` | unchanged |

(Combined with the previous rename: `CdifUtil` -> `McpForgeUtil` -> `CHUtil`, and
likewise for `CdifDevice`/`CdifError`.)

### HTTP header

- `X-MCPForge-Key` -> `X-CH-Key`.

### Bundled example device modules

- URN namespace: `urn:mcpforge-com:serviceID:*` -> `urn:countinghouse-com:serviceID:*`
  (framework's own example/test modules only, same caveat as the previous rename).

### Not changed (same reasoning as before)

- Device UUID generation (`lib/countinghouse-device.js`, `UUID.v5` namespace seed)
  is still `https://registry.apemesh.com/packages/...` — untouched by either rename,
  intentionally, to avoid reassigning every existing device's persistent UUID.
