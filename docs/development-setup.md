# Development setup

What a fresh checkout needs to build, run and verify countinghouse, and the
handful of things that fail quietly if you skip them.

## Prerequisites

- **Node >= 20** (`package.json`'s `engines`). Development has been on 20.20.2.
- **Redis** reachable at `redis://127.0.0.1:6379`. Most of the suite needs it —
  metering, rate limiting and the job queue all use it. Check with
  `redis-cli ping`, expecting `PONG`. The runtime uses several numbered
  databases on that instance (5, 7, 9, 10, 11), so give it one that is not
  shared with something else you care about.
- A toolchain able to build native addons, for `sqlite3` (the optional
  SQLite `AuthProvider`). If it fails to build, the runtime still works —
  `lib/optional-sqlite3.js` degrades deliberately — but the SQLite provider
  and its tests will not.

```bash
git clone https://github.com/mchen6/countinghouse.git
cd countinghouse
npm install
```

## Enable the git hooks — this one is easy to miss

The pre-commit hook is tracked at `.githooks/pre-commit`, but git finds it
through `core.hooksPath`, which is **local repository config and is not
cloned**. After cloning, run:

```bash
git config core.hooksPath .githooks
```

Without it the hook is silently absent. It does two things worth having:

- `eslint .` over the tree.
- Asserts `tools/list` is **byte-identical** to a golden sample. This is the
  MCP surface contract; if a change moves it, that is either a deliberate
  breaking change or a bug, and the hook makes you decide which.

## Running the tests

`npm test` runs everything, but its last segment is `test/test7.js`, a
**benchmark** rather than a correctness test — it is slow and its numbers
depend on the machine. For ordinary verification, run the first ten segments:

```bash
npx mocha ./test/test1.js
npx mocha ./test/test2.js
npx mocha ./test/test3.js
npx mocha ./test/test4.js
npx mocha --exit ./test/test5.js
npx mocha ./test/auth/*.js ./test/device-config/*.js ./test/module-loading/*.js \
          ./test/spec-format/*.js ./test/mcp-contract/*.js ./test/validation/*.js \
          ./test/module-authoring/*.js
npx mocha --exit ./test/composition/*.js
npx mocha ./test/test8.js
npm run test:peer-standalone
npx mocha ./test/test6.js
```

Expected on a healthy checkout as of 7.0.0: **452 passing, 3 pending, 0
failing**. The whole run takes roughly 25 minutes, most of it in the auth and
composition segments, which start real server processes and wait for them.

Two useful subsets:

```bash
npm run lint     # eslint only
npm run golden   # the tools/list contract only — fast
```

### What the 3 pending tests are

All three are in `test/auth/04-couchdb-provider.js`. They skip because the
CouchDB `AuthProvider` needs the `nano` package, which **is not a declared
dependency** — `lib/couchdb-adapter/` requires it lazily, inside functions, so
the rest of the runtime is unaffected and the tests skip rather than fail.
This is a known defect, not a configuration step you are missing: the CouchDB
provider cannot work in a clean install until `nano` is declared. The file
and SQLite providers are unaffected.

### Two tests that flake under load

Both pass reliably on their own and fail occasionally when several heavy
segments run back to back:

- `test/auth/12-composing-module-identities.js` — fails with `unknown tool: …`
- `test/module-loading/02-sqlite3-unavailable.js` — fails on a metering
  balance mismatch

They are environmental, not signal. If you hit one, make sure no `framework.js`
processes are left running, consider `redis-cli flushall`, and re-run that
segment alone before believing it.

## Guards that will fail on you, on purpose

Two tests exist to stop a class of bug this codebase kept repeating. Both
failing is usually correct behaviour, not breakage:

- **`test/module-loading/11-route-inventory.js`** enumerates every mounted
  HTTP path and diffs it against `test/fixtures/route-inventory.json`. Add or
  remove a route and this fails until you regenerate the golden:

  ```bash
  node ./test/fixtures/route-inventory.js > ./test/fixtures/route-inventory.json
  ```

  Regenerating is the second step, not the first. The point of the failure is
  to make you add the new path's row to
  [`cross-cutting-matrix.md`](cross-cutting-matrix.md) — which guarantees it
  gets auth, metering and rate-limit answers — before you wave it through.

- **The golden `tools/list` check** (`npm run golden`, and the pre-commit
  hook). Fails whenever the MCP tool surface changes.

## Where the reasoning lives

- [`CHANGELOG.md`](../CHANGELOG.md) — what changed per release, and why.
- [`docs/design-decisions.md`](design-decisions.md) — the durable technical
  decisions and what they cost.
- [`docs/cross-cutting-matrix.md`](cross-cutting-matrix.md) — which entry path
  gets which guarantee. **Any change adding an entry path adds its row here.**
- [`docs/security-model.md`](security-model.md) — what the isolation boundary
  is and, more importantly, what it is not.
- `docs/superpowers/specs/` — design documents for individual pieces of work,
  each recording the alternatives considered and what the decision forecloses.
