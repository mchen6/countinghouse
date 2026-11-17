# The official MCP 2026-07-28 schemas (test fixtures)

The JSON Schemas the 2026-07-28 conformance tests validate every response
and notification against (`test/mcp-contract/35-modern-schema-conformance.js`).
They are test fixtures only: nothing at runtime loads them.

| Directory | Repository | Path | Commit |
|---|---|---|---|
| `2026-07-28/` | [modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol) | `schema/2026-07-28/schema.json` | `ac00313ff7f5e9f47b0e0d1ebdf9c0ad6411380b` (2026-11-16) |
| `ext-tasks-2026-07-28/` | [modelcontextprotocol/ext-tasks](https://github.com/modelcontextprotocol/ext-tasks) | `schema/2026-07-28/schema.json` | `0d0a6bd4c258b35caa3c810a1dd506cf105b1501` (2026-08-24) |

Each directory holds its repository's `LICENSE`, verbatim, at that commit.
Neither repository has a `NOTICE` file. The core repository is moving from
MIT to Apache-2.0 (its `LICENSE` explains which contributions are which);
ext-tasks is Apache-2.0.

SHA-256: core `907dcebce6aaeb16c21421ffef8c207093d88b9442fee340658a99cacb06b551`,
tasks `bf30afb7ac251e3e22c037b7a685f60ef6603031b5484c0d08b1fa0bbe86d460`.

## Refreshing

Pick the new commits, then fetch the four files at them and update the table
and the hashes above:

```sh
C=<core commit>; T=<ext-tasks commit>; D=test/fixtures/mcp-schema
raw() { gh api -H "Accept: application/vnd.github.raw" "repos/$1/contents/$2?ref=$3"; }
raw modelcontextprotocol/modelcontextprotocol schema/2026-07-28/schema.json "$C" > "$D/2026-07-28/schema.json"
raw modelcontextprotocol/modelcontextprotocol LICENSE "$C" > "$D/2026-07-28/LICENSE"
raw modelcontextprotocol/ext-tasks schema/2026-07-28/schema.json "$T" > "$D/ext-tasks-2026-07-28/schema.json"
raw modelcontextprotocol/ext-tasks LICENSE "$T" > "$D/ext-tasks-2026-07-28/LICENSE"
sha256sum "$D"/*/schema.json
```

Check each repository for a `NOTICE` file at the new commit too, and copy it
beside its schema if there is one (Apache-2.0 section 4(d)).
