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
- Target: Node >= 22.16 (24.15+ for multi-tenant hosting; below 24.15 the
  resolve shim covers require.resolve), JSON Schema 2020-12 (ajv 8), MCP spec 2026-07-28
  (stateless Streamable HTTP; do NOT implement legacy HTTP+SSE).

## Working style
- Small commits, one task per commit. Before each, run the test files the
  change touches, one file at a time (docs/testing.md); the full suite is
  CI's job, and PR CI is the gate.
- Never delete adaptive-test/, perf/, spec/ — benchmarks are assets.
- All new docs and code comments in English.
- Never tag a release or publish to npm; the maintainer gates releases.
  A change to `.github/workflows/` needs the maintainer's explicit yes.
- Run `/code-review medium` on a change before its PR, and say so in the PR
  body. A follow-up you defer goes in the PR body's follow-up list or an
  issue, never only in a conversation.
- A failing test first, then the fix ("red first"): show the new test
  failing without the change.

## Running tests locally
- Wrap every run in `timeout` (e.g. `timeout 900`). A test waiting on a
  missing dependency can hang for hours.
- In a git worktree, link or install `node_modules` before running
  anything, and build file lists inside the worktree (a glob otherwise
  expands in another checkout). Don't use `git stash` in a worktree: the
  stash list and the rerere cache are shared by every worktree.
- Server-starting tests: move them aside with `CH_TEST_PORT_BASE` and a
  private Redis (`CH_TEST_REDIS_URL`, a random port), or use
  `scripts/run-in-docker.js`. Never pipe a server-starting script into
  `head`: SIGPIPE skips its cleanup, and the leaked server takes other
  runs' BullMQ jobs.
- Benchmarks run unattended on a quiet machine (an idle gate, e.g. vmstat
  idle >= 90%), and report the median and range, never a mean.

## Writing tests
- CI runs each folder in ONE mocha process. Reset any process-wide state a
  file sets (a lib's `configure()`, stubs, options, identity) in `after()`.
  To reproduce a CI-only failure, run the earlier file plus the failing
  file together, not the whole folder.
- Never `assert.strictEqual`/`deepStrictEqual` on large objects (validator
  pools, workers, sessions): a failing diff of the whole graph can take
  gigabytes and stall the runner. Compare identities with `assert.ok(a === b)`.
- No realistic secret literals (tokens, PEM keys) anywhere in the repo:
  generate them at test time. Scanners flag them, and history is public.
- Assert the field that proves the path ran (control answers are
  `{ok, code}`); never a fallback that passes when the path didn't run.
- Before changing a file or list a test pins, grep `test/` for its name and
  run that test: `test/folders.json`, `BOOLEAN_FLAGS`, the tools/list
  golden (`test/mcp-contract/tools-list.golden.json`), the error-shape
  golden, sandbox 66/67's reviewed in-function `require` counts, and
  sandbox 64's token-path files. Move a golden only on purpose, in its own
  commit.
- Async metering is fire-and-forget (the outer invoke-action charge, the API
  log): read a settled value, never poll until the expected one appears.

## Runtime code rules
- Worker files listed in `test/sandbox/64-token-path-guard.js` may not use
  live array methods, `new Set([...])`, `for...of` or an in-function
  `require` (module code can replace those intrinsics); check its list
  before editing one.
- A lib loaded lazily inside a module worker can't `require('worker_threads')`
  (the lockdown refuses it); test worker paths under
  `--moduleSandbox enforce`.
- Never add fields to a cross-worker reply's `data`; pass an extra
  callback argument.
- A PR whose base is behind master and that touches the sandbox, the
  lockdown or the gateway: merge master in and let CI run (or run its key
  tests on the merged tree). Green on an older base has broken master
  before.
- Master's own CI runs a per-commit golden walk that PR CI doesn't; check
  master's run after a merge.

## Invariants (security model)
- Fail closed: what the runtime doesn't understand is refused, with one
  uniform answer.
- A caller gets the same answer for every tool it can't use, whatever the
  reason (no probing which modules exist).
- A tightening (turning a module off, lowering a cap) is never refused.
- Under `--moduleSandbox enforce` a module can't learn whether a file
  outside its root exists; at open time the kernel never follows a link the
  file broker's check didn't approve.
- The runtime deletes only directories it made (an ownership marker
  before every recursive delete).
- The runtime never fetches code over the network.
