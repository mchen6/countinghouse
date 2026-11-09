# R2-1: no raw keys in modules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The runtime never hands a module an API key, an internal identity's key or a user name; a module's worker can't name an identity, a billing subject or an undeclared target on any hop.

**Architecture:** A main-side identity service (secret, `id`, index, lookup) comes first. Then the always-denied set and the trimming of what workers receive. Then per-call tokens bound to their worker, carried on every hop path, with the peer path metering before it serves. Then declared-call enforcement on main. Last, the old fields and `as` are removed and the examples migrated. Each commit leaves the suite green, with old and new side by side until the last one removes the old.

**Tech Stack:** Node ≥ 24.15, CommonJS, mocha, supertest, bullmq 6, redis, sqlite3 (optional), the official MCP SDK in contract tests.

**Spec:** `docs/superpowers/specs/2026-11-07-r2-1-no-raw-keys-in-modules-design.md` (approved rev 4 as amended: EACCES, plus outside-path resolution under audit).

## Global Constraints

- `id = "u_" + base64url(HMAC-SHA256(secret, "id:" + entry.id))` when the entry has `id`, else `HMAC-SHA256(secret, "key:" + apiKey)`, truncated to 22 characters.
- The secret: 32 random bytes at `<moduleDataPath>/.identity-secret` (0600; refused if group- or world-readable or a link), or `COUNTINGHOUSE_IDENTITY_SECRET`.
- Entry `id`: a string, 1–128 printable characters, unique; a duplicate is refused naming entry positions, never keys (file: exit 2 at startup; sqlite and CouchDB: the write fails).
- `ctx.caller = {id, isAdmin}`, with nothing else, at the end of the series.
- New codes in both locales: `CALL_TOKEN_INVALID`, `IDENTITY_NOT_FOUND`.
- The always-denied set is refused with `EACCES` in `audit` and `enforce`, recorded as a denial, and untouched in `off`.
- A token is 128 random bits, bound to its worker. Its one foreign use is as the billing subject of a peer-channel metering request from that channel's callee, for an invoke on that channel.
- The peer path meters before it serves. The token check fails closed always; only the balance deduction may fail open with Redis down.
- Every commit: RED test first, `npm test` green on the exact tree, the diff sha recorded before and after, explicit `git add` paths, and the reviewer's OK before the next commit on top.

## Review Focus

1. **A module holds two ctx's at once** (two concurrent calls) and uses call B's token for call A's hop. Expected: allowed (the documented residual), billed to B's caller. Test in Task 3 Step 1 (c): billing goes to the token's caller, never to a third party.
2. **A peer callee keeps the caller's token** and uses it for its own hop. Expected: `CALL_TOKEN_INVALID` (foreign). Test in Task 3 Step 1 (b).
3. **The auth file rewritten in place** (same path, new inode) after startup, then read by a module via a symlink. Expected: still `EACCES`, since identity is re-taken on an inode change. Test in Task 2.
4. **A job queued before the upgrade** (data has `apiKey`, no `ownerId`), run after it. Expected: it runs, bills and stamps as before. Test in Task 4.
5. **`id` rotation without the field.** Expected: a new id, and the old scheduler isn't found under the new id. Expected: documented, and the owner can still remove it (fallback). Test in Task 1/Task 4.

## Pre-work, outside this plan (lands first)

- **Auth reload** (`POST /reload-auth` plus an authoring tool), its own small commit, user-approved scope. R2-1 Task 1 then hooks "rebuild the identity index on reload" onto it.

## File Structure

- Create `lib/identity.js`: the secret, `idFor(entry, apiKey)`, the index, `lookup(id)`, `rebuild(provider)`.
- Modify `lib/auth/provider.js`, `file-provider.js`, `sqlite-provider.js`, `lib/couchdb-adapter/couchdb-auth-provider.js`: the entry `id` field, uniqueness, and an `entries()` enumeration for the index.
- Create `lib/routes/identity-lookup.js`. Modify `lib/route-manager.js`, `lib/mcp/gateway.js` and `lib/mcp/tool-registry.js` (`countinghouse_lookup_identity`).
- Create `lib/call-tokens.js`: issue, resolve, chain, bind-to-worker, drop on answer or worker end.
- Modify `lib/fs-broker/broker.js` (the always-denied check in `place()`), `lib/fs-broker/index.js` (the denied set), `lib/module-permissions.js` (the env prefix), `lib/module-lockdown.js` (the Redis endpoint wrapper), `lib/cli-options.js` (`getOptions` for workers without `redisUrl`).
- Modify `lib/handler-ctx.js`, `lib/service-client.js`, `lib/countinghouse-util.js`, `lib/device-manager.js`, `lib/peer-channel.js`, `lib/peer-channel-broker.js`, `lib/worker-message.js`, `lib/sandbox.js`, `lib/job-control.js`, `lib/routes/invoke-action.js`, `lib/key-fingerprint.js`.
- Examples: `pre-installed-packages/{composite-demo,perf-caller-demo,echo-device-client-module}`, `examples/{log-triage,repo-review}`.
- Docs: `docs/module-development.md`, `docs/security-model.md`, `docs/upgrading-to-8.md`, `docs/cli-and-api-reference.md`, `CHANGELOG.md`.
- Gate test: `test/fixtures/key-dump` (a module that dumps everything it can reach) and `test/auth/30-no-keys-reach-modules.js`.

---

### Task 0: Gate test, written first (RED until Task 5)

**Files:** Create `test/fixtures/key-dump/` (handler-map module with actions `dump`, `hopAs`, `serviceClientAs`, `rawHop`) and `test/auth/30-no-keys-reach-modules.js`, marked `describe.skip` until Task 5 flips it on, so the suite stays green.

- [ ] **Step 1:** `dump` returns JSON of everything reachable: `ctx` (all own and inherited enumerable keys, recursively, functions by name), `args` minus input, `httpHeaders`, the result of `ctx.job && ctx.job.info()`, the result of `ctx.recordUsage`, `process.env`, the `peer-channel-open` payload it receives as a callee (captured through a test hook in `lib/sandbox.js`), and `CHUtil` options as the worker sees them. *(As built — ruling: no test hook; the dump walks everything module code can reach from `ctx`, the job info, the `recordUsage` result, `globalThis`, and the exports of every `require.cache` entry (module code shares the worker's realm and require.cache) — data descriptors, Map/Set, WeakRef, byte buffers — and reports hits by path, skipped getters by name, and its caps.)*
- [ ] **Step 2:** `test/auth/30` (not under --debug; keys `alice-key-<random>` and `bob-key-<random>`, userNames `alice-<hex>` and `bob-<hex>` (ruling: bare names match unrelated strings in the walk)) asserts, over MCP, HTTP invoke-action (with `X-CH-Key`), a task, and a peer hop into `key-dump`: the dump's JSON contains neither key, nor `alice`, nor `bob`, nor any `redis://` string, and the options the worker received have no `redisUrl` key at all (asserting on the options object rather than a password, so the test needs no Redis with requirepass); `ctx.caller` deep-equals `{id: /^u_[A-Za-z0-9_-]{22}$/, isAdmin: false}`.
- [ ] **Step 3:** Run it without `.skip` once on the base: RED (lists the leaked values). Record the output in the ledger, then commit it with `.skip` as the first R2-1 commit (test-only).

### Task 1: The identity service

**Files:** Create `lib/identity.js`, `lib/routes/identity-lookup.js`, `test/auth/31-identity.js`. Modify the providers, `lib/route-manager.js`, `lib/mcp/gateway.js`, `lib/mcp/tool-registry.js`, the error catalogues, and `bin/countinghouse-auth-sqlite.js` (`set-id <apiKey> <id>`).

**Interfaces:**
- Produces: `identity.init(options) → Promise<void>` (loads or creates the secret); `identity.idFor({id?}, apiKey) → string`; `identity.rebuild(provider) → Promise<void>`; `identity.lookup(id) → {apiKey, userName, isAdmin} | null` (main thread only; throws if called in a worker); `provider.entries(cb(err, [{apiKey, userName, isAdmin, id?}]))`.

- [ ] **Step 1 (RED):** `test/auth/31`:
  - (a) `idFor` is the same for the same key, differs between keys, has 22 characters after `u_`, and changes with the secret;
  - (b) an entry with `id: "alice"` keeps its id when its key changes; one without changes;
  - (c) `id` equal to another entry's key doesn't yield that entry's id (domain separation);
  - (d) a file config with a duplicate `id` exits 2 with "entries 2 and 5 share id", and the stderr contains no key;
  - (e) the secret file is created 0600; a 0644 one refuses startup; a symlinked one refuses startup; `COUNTINGHOUSE_IDENTITY_SECRET` overrides;
  - (f) `POST /identity-lookup {id}` as admin returns `{id, userName, isAdmin}`, as non-admin 403, an unknown id `IDENTITY_NOT_FOUND`, never a key in any body;
  - (g) the same through `countinghouse_lookup_identity` under `--authoringTools`;
  - (h) sqlite: `set-id` stores it; a duplicate fails; an existing db without the column is migrated on open;
  - (i) after `POST /reload-auth` adds an entry, its id resolves (the index is rebuilt).
- [ ] **Step 2:** Run: `npx mocha --exit test/auth/31-identity.js`. Expected: FAIL, "Cannot find module '../../lib/identity'".
- [ ] **Step 3:** Implement. The index is a `Map` rebuilt from `provider.entries` at startup and on reload. sqlite and CouchDB: `lookup` misses refill from the provider, then cache (never a per-call scan). Nothing else uses `id` yet.
- [ ] **Step 4:** The test passes; `npm test` is green. Commit: `feat(identity): an opaque per-user id, its secret, and the operator's lookup`.

### Task 2: The always-denied set, and what workers receive

**Files:** Modify `lib/fs-broker/index.js` (`deniedPaths(options)`: the `--authConfigPath` file, plus `-wal`, `-shm` and `-journal`, and `<moduleDataPath>/.identity-secret`), `lib/fs-broker/broker.js` (`place()`), `lib/module-permissions.js` (`resolveEnv`), `lib/module-lockdown.js`, `lib/cli-options.js` (`getOptionsForWorker()`), `lib/module-manager.js` (`sendSetOptionsMessage` uses it). Test `test/sandbox/27-always-denied.js`.

- [ ] **Step 1 (RED):** under `audit` and under `enforce`, a fixture module:
  - reads the auth config directly, via a symlink in `/tmp`, via `../` from `/data`, and via a hard link (created by the test in a declared `rw` dir), and gets `EACCES` each time;
  - does the same for the sqlite db and its `-wal`, and for the identity secret;
  - after the test rewrites the auth file in place (new inode), still gets `EACCES` through the symlink;
  - with a denial line in the log for each attempt;
  - declaring `env: ["COUNTINGHOUSE_API_KEY"]` doesn't receive it (`process.env.COUNTINGHOUSE_API_KEY === undefined`), and `countinghouse-validate` reports the declaration;
  - gets `EACCES` from `net.connect(<redis port>)`, `tls.connect`, `new net.Socket().connect`, and `http.request({socketPath})` when `--redisUrl` is a unix socket;
  - finds no `redisUrl` in the options its worker received (read through the test hook);
  - under `off`, the file reads succeed (asserting the table).
- [ ] **Step 2:** Run it. Expected: FAIL, with the first read returning the file's contents.
- [ ] **Step 3:** Implement. In `place()`, for an outside path in audit, `realpath` then `lstat` (cost: one realpath plus one lstat per OUTSIDE access under audit only; inside accesses unchanged). Compare `(dev, ino)` with the denied set, re-taking a denied path's `(dev, ino)` when its `lstat` ino differs from the cached one. Match not-yet-existing denied paths by realpath. `resolveEnv` drops any `COUNTINGHOUSE_` name. The lockdown wraps `net.connect`, `tls.connect`, `net.Socket.prototype.connect` and `http(s).request` socketPath with the Redis endpoint as an in-worker check (comment: not a boundary until parts 3 and 4).
- [ ] **Step 4:** Green; `npm test` green. Commit: `fix(sandbox): the auth config, the identity secret, COUNTINGHOUSE_* and Redis are always denied to modules`.

### Task 3: Tokens, side by side with the old fields

**Files:** Create `lib/call-tokens.js`. Modify `lib/device-manager.js` (issue at each dispatch: `invokeAction` worker branch, `invokeJobs`, and `sendInvokeActionMessageToWorker` for the callee; resolve in the `invokeforeignaction`, `querydevice` and `getjobinfo` handlers), `lib/peer-channel-broker.js` (`handleRequest`, `handleMeteringRequest`), `lib/peer-channel.js` (callee: meter before serve; caller: send the token, not `billingKey`), `lib/handler-ctx.js` (`ctx` holds the token in a closure, not on a property), `lib/service-client.js` and `lib/worker-message.js` (hop messages carry `token`), `lib/module-manager.js` (drop a worker's tokens on its exit, beside D1's `endWith`), `lib/job-control.js` (`ownerId` in job data; read either). Test `test/composition/17-call-tokens.js`.

**Interfaces:**
- Produces: `callTokens.issue({billingKey, identityKey, module, workerId, deviceID, parent?}) → token`; `callTokens.resolve(token, {workerId, peerCalleeOf?}) → entry | null`; `callTokens.dropFor(workerId)`; `callTokens.drop(token)`.

- [ ] **Step 1 (RED):** with direct channels on and off:
  - (a) a hop message carrying another tenant's key in `appKey`/`billingKey` bills the token's caller, not that key;
  - (b) a made-up, expired or other-worker token gets `CALL_TOKEN_INVALID`, no handler runs and nothing is billed (Review Focus 2: a peer callee reusing the caller's token for its own hop is refused);
  - (c) Review Focus 1: two concurrent calls, a hop with B's token bills B's caller;
  - (d) peer path: an invalid token runs no callee handler (the callee's call counter stays 0), and with Redis stopped a VALID token still serves (balance fail-open), an invalid one doesn't;
  - (e) Review Focus 4: a job created with `apiKey`-only data runs, bills and stamps; a new job stores `ownerId` and no `apiKey`;
  - (f) a scheduler created under the old sha256 prefix is listed and removable by its owner;
  - (g) a typed missing-device code reaches an authorized composite through the device query (`MODULE_UNLOADED`, not `DEVICE_INVOKE_EXCEPTION`);
  - (h) a job whose owner was removed fails `SYSTEM_ERROR_UNKNOWN_USER`, attemptsMade 1.
- [ ] **Step 2:** Run. Expected: FAIL at (a), billed to the stated key.
- [ ] **Step 3:** Implement. Hops carry `token`; main resolves it and takes the billing subject from it, ignoring `billingKey`. **`as` side by side:** until Task 5, when a hop names `as` (the bundled demos' `composite-demo-internal`, `aabbcc`, `perf-caller-demo-internal`; auth 12 and the composition tests rely on them), main resolves that key into the hop's `identityKey` at hop time, still worker-claimed exactly as today, marked in the code with `// removed in Task 5 (R2-1)`. Otherwise the identity is the module's `runsModules` binding. So no hop changes authorization in this task, and the suite stays green. Add `SYSTEM_ERROR_UNKNOWN_USER` to `NOT_RETRIED`. Run `node perf/direct-peer-channels-perf.js` before and after this task, three runs each, medians in the commit message. Metering before serve puts a main round trip in series before each peer invoke's handler, which is the expected cost of "an invalid token runs no handler". If it regresses beyond noise, do NOT switch to metering in parallel (that would run handlers for invalid tokens, against the spec). Stop and report the numbers to the reviewer; the user decides between the latency and the guarantee. Also in this task: `schedulerId` becomes `<id>:<name>` (lib/job-control.js), with the old sha256-prefixed id as a fallback in lookup and remove.
- [ ] **Step 3b (announce and match, user-approved):** for each peer invoke the CALLER worker sends main a non-blocking `{channel, invokeId, token}` announcement. Main accepts a callee's metering request only if it matches an unmatched announcement for that channel and invokeId, each matched at most once. An unmatched metering request is held up to `PEER_ANNOUNCE_WAIT_MS = 1000` for its announcement, then refused (fail closed; meter-before-serve, so no handler runs). Tests in this task: a metering request with no announcement → not billed, not served; an announcement arriving late but inside the bound → billed and served; a duplicate metering request for one announcement → the second refused. The perf measurement in Step 3 covers it (one extra one-way message per invoke).
- [ ] **Step 4:** Green; `npm test` green. Commit: `feat(calls): per-call tokens on every hop; the peer path meters before it serves`.

### Task 4: Declared calls, enforced on the main thread

**Files:** Modify `lib/device-manager.js` (the `invokeforeignaction` handler checks the target against the caller worker's module's resolved composition set), `lib/peer-channel-broker.js` (`handleRequest` checks it before `grant`; grants keyed by identity id), `lib/peer-channel.js` (callee checks the invoked device against the channel's grants). Test `test/composition/18-declared-calls-enforced.js`.

- [ ] **Step 1 (RED):** a module that declares only `a/svc.x` calls `b/svc.y` through `ctx.serviceClient` by raw deviceID and through a hand-built hop message, on both paths, and gets `CTX_CALL_UNDECLARED`, with nothing billed and no handler run in `b`. A declared call still works.
- [ ] **Step 2:** Run. Expected: FAIL; the undeclared call succeeds.
- [ ] **Step 3:** Implement, deriving the module from the WorkerMessage the request arrived on, never from the message. In the same commit (user-approved): (a) add `countinghouse.calls` declarations to `pre-installed-packages/{composite-demo,perf-caller-demo,echo-device-client-module}/package.json` (they declare none today, so enforcement would break them before Task 5); their `as` constants still go in Task 5; (b) a guard refusing, at load, a second module in a worker (the peer-path argument rests on one module per worker), with a test that tries it and gets refused.
- [ ] **Step 4:** Green; `npm test` green. Commit: `fix(composition): a module can call only what it declared, whatever API it uses`.

### Task 5: Remove the old fields; migrate the examples; docs

**Files:** `lib/handler-ctx.js` (`callerIdentityOf` → `{id, isAdmin}`; `serviceClient` refuses `as`), `lib/countinghouse-util.js` (`createServiceClient` refuses `appKey`; `recordUsage` returns `{id, …}`; the `--verifyModule` portal branch is removed, as CDIF-era), `lib/device-manager.js` (`sendSetCompositionMessage` without `identity`), `lib/peer-channel-broker.js` (`peer-channel-open` without `appKey`), `lib/routes/invoke-action.js` (strip `x-ch-key`, `x-app-key` and `authorization` from `httpHeaders`), `lib/worker-message.js` and `lib/service-client.js` (drop `appKey`/`billingKey` from hop messages), `lib/key-fingerprint.js` (→ `id`), the examples and their verify scripts, and the docs (spec "Compatibility and upgrade"). Tests: flip `test/auth/30` on; update tests that read `ctx.caller.apiKey`/`userName` or pass `as`.

- [ ] **Step 1 (RED):** remove `.skip` from `test/auth/30`. Expected: FAIL, leaking the keys and user names (as Task 0 recorded).
- [ ] **Step 2:** Implement the removals. `as` gets the migration error "identities come from the operator's runsModules binding; remove `as`".
- [ ] **Step 3:** Examples: drop the `as` constants. The bills use `billedTo: ctx.caller.id`. Re-run `examples/repo-review/verify-identity-passthrough.js`, `examples/log-triage/verify-cost-bound.js`, and `npm run demo:repo-review` with the README curl.
- [ ] **Step 3b (additions):** hide `CHUtil.dm` and `CHUtil.ci` from module code (CHUtil's documented methods close over them; tidying, not protection, since require.cache still reaches the runtime), named in the CHANGELOG as breaking for any undocumented use; `SYSTEM_ERROR_UNKNOWN_USER` names no key at all, not even a fingerprint (file, sqlite and CouchDB providers, user-auth.js), with a case that a near-miss key (one character off a real one) leaves no 6-character piece of either in the answer or the log.
- [ ] **Step 4:** Docs: module-development's `ctx` table (`ctx.caller = {id, isAdmin}`); security-model (the mode table, the residual, Redis auth guidance, and replacing "the main thread trusts them" with the token text); upgrading-to-8 (before and after; add `id` before rotating keys; the secret file; in 8.0 a third-party module's undeclared inner calls are refused); the cli reference (`COUNTINGHOUSE_IDENTITY_SECRET`); the CHANGELOG.
- [ ] **Step 5:** Single-thread mode (spec section 8): a case in `test/single-thread/` asserts the same `ctx.caller` shape, `as` refused, and declared calls enforced on a hop.
- [ ] **Step 6:** `test/auth/30` green; `npm test` green. Commit: `feat!: modules receive no API key and no user name (R2-1)`.

### Task 6: The gate

- [ ] Run the full suite on 24.15.0, 24 (CI's) and 24.21.0 (the VM default) on the final tree.
- [ ] Run `node perf/direct-peer-channels-perf.js` (and `perf/peer-channel-serialization-perf.js`), before (8a338d2) and after (the final commit), medians of three runs each.
- [ ] Send the whole range to the reviewer for the security pass.
- [ ] Only then ask the user whether to push R2-1 to master.
