# Migration notes: apemesh/cdif -> mcpforge

This project was rebranded from `@apemesh/cdif` to `mcpforge`. Project history and
origin are preserved (see README); this note lists what changed on the public API
surface for anyone integrating against the framework or writing device modules.

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
- `error-info.zh-CN.json` (localized error messages) is kept. The project still
  defaults to `zh-CN` locale; the English translation (`error-info.en-US.json`) is
  incomplete relative to it and was not adopted as the default in this pass.
