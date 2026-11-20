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
- License: Apache-2.0 everywhere (done).
- Origin stays visible: the README credits the 2015 CDIF lineage. Branding
  noise (the old names, the private registry, customer dirs) was removed,
  not history.
- A device ID is derived from the module's name by one function,
  `deviceIDForName` in `lib/call-address.js`. Changing that derivation
  reassigns every device ID (grants and stored logs keyed by ID stop
  matching); never compute or hard-code an ID anywhere else.
- The old sqlite3-based module manager is merged as `lib/device-db.js`,
  with no private-registry dependency.
- Target: Node >= 22.16 (24.15+ for multi-tenant hosting; below 24.15 the
  resolve shim covers require.resolve), JSON Schema 2020-12 (ajv 8), MCP spec 2026-07-28
  (stateless Streamable HTTP; do NOT implement legacy HTTP+SSE).
- No one uses a released version yet: design the target shape. No
  compatibility shims or migrations for old shapes, and remove a flag that
  does nothing rather than documenting it as "no effect".

## Working style
- Small commits, one task per commit. Before each, run the test files the
  change touches, one file at a time (docs/testing.md); the full suite is
  CI's job, and PR CI is the gate. Don't skip the pre-commit hook.
- Never delete adaptive-test/, perf/, spec/ — benchmarks are assets.
- All new docs and code comments in English.
- Never tag a release or publish to npm; the maintainer gates releases.
  A change to `.github/workflows/` needs the maintainer's explicit yes.
- Never force-push. Update a pushed branch by merging master into it. Open
  each PR against master, not stacked on another PR: build ahead locally,
  then merge master in once the base lands.
- Run `/code-review medium` on a change before its PR, and say so in the PR
  body. A follow-up you defer goes in the PR body's follow-up list or an
  issue, never only in a conversation.
- A failing test first, then the fix ("red first"): show the new test
  failing without the change.
- Before stating a fact about the repo in a spec, plan or PR, check the
  source that decides it: `git ls-files` for "tracked", `package.json` for
  a dependency, the route's own handler for what a route does. Read the
  code before reasoning about what a module can see or reach.

## Running tests locally
- Wrap every run in `timeout` (e.g. `timeout 900`). A test waiting on a
  missing dependency can hang for hours.
- One server-starting file: `node test/helpers/run-local.js <file>` gives it
  a private Redis on a random port and a moved port base; or use
  `scripts/run-in-docker.js` (docs/testing.md).
- In a git worktree, install `node_modules` (`npm ci`, or a real copy with
  `cp -a`) before running anything; a symlinked `node_modules` breaks some
  sandbox and fs-broker tests. Build file lists inside the worktree (a
  glob otherwise expands in another checkout), and don't run tests from a
  checkout under /tmp (sandboxed modules see a virtual /tmp). Don't use
  `git stash` in a worktree: the stash list and the rerere cache are shared
  by every worktree.
- Stop processes by PID, never `pkill -f` (it matches your own shell). Start
  a one-off server in the same command that stops it (`timeout` or a
  `trap`). Never pipe a server-starting script into `head`: SIGPIPE skips
  its cleanup, and the leaked server takes other runs' BullMQ jobs.
- sqlite3 is built for one Node version: after switching Node, run
  `npm rebuild sqlite3` (a mismatch segfaults; mocha exits 139, silently).
- A change to the sandbox or module resolution: also run the touched files
  on the floor Node (`run-in-docker.js --node 22`); below 24.15 the resolve
  shim takes a different path.
- Timing benchmarks run unattended on a quiet machine (an idle gate, e.g.
  vmstat idle >= 90%); memory measurements gate on free memory instead.
  Report the median and range, never a mean.

## Writing tests
- CI runs each entry of `test/folders.json` in ONE mocha process, and one
  entry spans many folders, so state leaks across files and folders. Set
  process-wide state (a lib's `configure()`, options, stubs, identity) in
  `before()` and restore it in `after()`, never at load time. To reproduce
  a CI-only failure, run the earlier file plus the failing file together.
  A new test folder needs its line in `test/folders.json`, or nothing runs
  it. A new file takes the next number free across master and open PRs.
- Ports come from `testPort()` and Redis from `redisUrlFor()`
  (`test/helpers/test-env.js`): never a literal 6379, db 11 or a bare
  `createClient()`. A new port gets its row in `test/ports.md`.
- A server a test starts is stopped on every path, a failed ready-wait
  included (spawn it detached and kill the process group, as
  `test/helpers/sandbox-server.js` does). Temp trees come from
  `test/helpers/test-tmp.js` (`forFile`) and are removed even on failure.
- Never `assert.strictEqual`/`deepStrictEqual` on large objects (validator
  pools, workers, sessions): a failing diff of the whole graph can take
  gigabytes and stall the runner. Compare identities with `assert.ok(a === b)`.
- No realistic secret literals (tokens, PEM keys, `user:pass@` URLs, a
  `password: <value>` pair): build them at run time. Test hosts and emails
  use `.invalid`. Scanners flag the rest, and history is public.
- Assert the field that proves the path ran (control answers are
  `{ok, code}`); never a fallback that passes when the path didn't run.
  Don't depend on wall-clock timing: inject a clock, or wait with a bound
  on something observable.
- Sandbox behaviour is asserted under both modes: enforce refuses, audit
  loads and reports.
- Before changing a file, list or message shape a test pins, grep `test/`
  for its name and run that test. Pins include `test/folders.json`,
  `BOOLEAN_FLAGS`, the goldens in `test/mcp-contract/*.golden.json`,
  `test/validation/04-error-catalogue.js` (every raised code has an entry),
  `test/sandbox/43-lean-worker-files.js`, sandbox 66/67's reviewed
  in-function `require` counts and sandbox 64's files. Some fixtures run
  only inside a bundle: grep `test/` for "part of test/test" before
  changing one. Move a golden only on purpose, in its own commit.
- Async metering is fire-and-forget (the outer invoke-action charge, the API
  log): read a settled value, never poll until the expected one appears.

## Runtime code rules
- Worker files listed in `test/sandbox/64-token-path-guard.js` follow the
  lexical rules in that file's header (no live array methods, `for...of`,
  spread or in-function `require` where module code could have replaced an
  intrinsic); read it before editing one.
- A lib loaded lazily inside a module worker can't `require('worker_threads')`
  (the lockdown refuses it); test worker paths under
  `--moduleSandbox enforce`.
- Never add fields to a cross-worker reply's `data`; pass an extra
  callback argument.
- Decide path confinement on the kernel's real path
  (`fs.realpathSync.native`), never JS `realpathSync`.
- Windows: convert paths at one Windows-only boundary, pinned by a test that
  runs on all three OSes. Never loosen a check or widen a grant to make
  Windows pass.
- A raw API key never goes into a file, log, Map key or long-lived
  structure: key by its fingerprint (`lib/key-fingerprint.js`). Errors and
  logs name which value is at fault, never its content.
- A PR whose base is behind master and that touches the sandbox, the
  lockdown or the gateway: merge master in and let CI run (or run its key
  tests on the merged tree). Green on an older base has broken master
  before.
- Master's own CI runs a per-commit golden walk that PR CI doesn't; check
  master's run after a merge.

## Invariants (security model)
- Fail closed: what the runtime doesn't understand, or a check it can't
  make (a timeout, a store down), is refused with one uniform answer,
  never "not seen" or "unlimited". One exception: an unmeasurable SHARED
  quota is marked unknown and measured again, not pinned at its limit
  (that would deny every session).
- Who is calling, and from which module, comes from the main thread's own
  records (the call token's entry, `hostModuleName` set at spawn), never
  from what a worker announces. Permission decisions stay on main.
- A caller gets the same answer for every tool it can't use, whatever the
  reason (no probing which modules exist).
- A crash in a module ends only that worker, never the runtime.
- A session reaches only its own per-session workers; hops into them go
  through main, routed by each call's token.
- A forged or stale call token never runs a handler, even with Redis down
  (the check's ~1 ms per call is an accepted cost).
- An environment variable may only add refusals; anything that loosens or
  grants is an explicit operator flag. A loosening never outlives the
  session that made it. A tightening (turning a module off, lowering a cap)
  is never refused.
- A call that isn't billed still counts against the per-key rate limit,
  and a cancel never loses billing.
- Text a module supplies is cut and cleaned at egress (module-text); values
  a client sends back are never changed. HTTP routes answer only from what
  tools/list advertises.
- Under `--moduleSandbox enforce` a module must not learn whether a file
  outside its root exists; at open time the kernel never follows a link the
  file broker's check didn't approve.
- The runtime deletes only directories it made (an ownership marker
  before every recursive delete).
- The runtime never fetches code over the network.
