# Project Context

This is a Node.js API hosting framework being refactored and rebranded
(new name TBD) as: a multi-tenant runtime + monetization/marketplace
backend for MCP tools.

## Authoritative plan
docs/cdif-audit-and-refactoring-plan.md — follow its Sprint order.
Do not skip P0 items.

## Key decisions already made
- License: Apache-2.0 everywhere ("APEMESH standard license" in
  package.json was a typo — fix it).
- Keep origin visible: README will credit the 2015 CDIF lineage.
  Remove branding noise (apemesh, private registry, customer dirs),
  not history.
- @apemesh/cdif-device-db: personal code (sqlite3-based module manager),
  decision made — merge into this repo under lib/device-db/ (or similar),
  rename, drop the private registry dependency entirely.
- Target: Node >= 20, JSON Schema 2020-12 (ajv 8), MCP spec 2026-07-28
  (stateless Streamable HTTP; do NOT implement legacy HTTP+SSE).

## Working style
- Small commits, one task per commit, run `npm test` before each.
- Never delete adaptive-test/, perf/, spec/ — benchmarks are assets.
- All new docs and code comments in English.
