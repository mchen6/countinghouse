# Project Context

countinghouse is a self-hosted, multi-tenant MCP tool runtime, refactored
and rebranded from a Node.js API hosting framework. It hosts third-party
modules distributed over npm, under operator review, and its own
contributions are validation against the runtime's contract and metered,
per-key access control.

**It is not a marketplace, and must not describe itself as one.** It builds
no publish, storage or browse machinery — npm is the marketplace, and the
runtime never fetches code over the network. That was decided in 7.0.0;
the reasoning, and what it forecloses (module authors are not paid through
countinghouse), is in
docs/superpowers/specs/2026-09-04-marketplace-backend-design.md.

## Authoritative plan
The original sprint-by-sprint working plan
(docs/cdif-audit-and-refactoring-plan.md) was an internal, Chinese-language
working document — it has been removed from the repo and exists only in
the maintainer's local backup, not in git. docs/design-decisions.md
carries forward the technical rationale from it that has lasting public
value (AuthProvider backend choices, the billing-authority principle,
direct-peer-channels D1–D5, MCP protocol version strategy). For current
project status, read the codebase and git history directly rather than
assuming a plan doc exists.

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
