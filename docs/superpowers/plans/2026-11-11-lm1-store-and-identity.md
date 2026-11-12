# LM1, part B (store and identity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `--store local` runs the runtime with no Redis: one selection point (`createStore`) behind which the Redis implementations sit unchanged, plus local metering, a local `ctx.redis` store, the single-identity auth binding and a local job runner.

**Architecture:** `lib/store.js` is the only place that decides the mode; every file that holds a Redis client today takes its object from `getStore()` instead. Local implementations keep state in memory and persist it as JSON under `--storePath` by temp-file-and-rename. The single-identity profile is a fourth auth provider that holds one key in memory.

**Tech Stack:** Node 22.16+ (CommonJS), mocha, the existing `redis` v3 client and BullMQ (Redis mode only); no new dependency, no native module.

**Spec:** `docs/superpowers/specs/2026-11-11-local-mode-design.md` (branch `spec-local-mode-and-floor`, at 15937c8), sections 1 and 4, "Security and privacy", "Tests", "Sequencing and ownership" (B's part).

## Global Constraints

- `--store redis|local`; `redis` is the default and "behaves as now".
- `--store local`: "no Redis client is created anywhere in the process".
- `--redisUrl` with `--store local` is "a startup error (exit 2, "choose one")".
- `--storePath` default `<moduleDataPath>/../store/`; files are "plain files written by temp-file-and-rename, pure JavaScript, no native module".
- Interface (fixed by the spec): `createStore(options) -> {metering, kv, jobs}`; C's counters use metering only through `recordCall`.
- `options.singleIdentity` is true when `--store local --stdio` runs without `--authConfigPath` (spec section 4; reviewer's ruling 2); `options.apiKey` then holds the in-memory key, which C's stdio layer and tool listing read.
- The key "is never printed, logged or written when `--stdio` is the transport"; the profile writes no auth file and no key anywhere under `<storePath>` or `<moduleDataPath>`.
- The caller id's inputs in the profile are the identity secret at `<storePath>/.identity-secret` (mode 0600) and the fixed source `local`.
- Files B owns: `lib/store.js`, `lib/metering/`, `lib/local-kv.js`, `lib/redis-api.js`, `lib/job-control*.js`, `lib/auth/`. Edits outside them (the consumers in Task 1, `lib/identity.js`, `lib/cli-options.js`) are one-line takes of the store's objects and are named in the PR body.
- Process (maintainer, 2026-11-11): single-file RED/GREEN and lint locally; the pre-commit hook runs; no folder runs; the PR's CI is the gate. One PR per step (PR B1..B5 below).

## Review Focus

1. Several runtime processes on one `--storePath`: a developer with two agent terminals and an editor open has three launchers on one home (reviewer's ruling, 2026-11-11, from the packs design). None of them refuses to start, and none clobbers another's data. Task 3 handles each persisted write the same way:
   - it takes `<storePath>/.lock` (pid and startMs; a stale lock is taken over);
   - it re-reads the file and applies this process's dirty keys over it;
   - it writes temp-and-rename and releases the lock.
   The last write per key wins, and no file is replaced whole. Test: two child processes writing disjoint keys to one store end with both sets on disk.
2. A truncated or hand-edited `metering.json`/`kv.json`: start must not crash or run on half the data unseen. Task 3 moves the bad file aside to `<name>.corrupt-<ms>`, logs that it did, and starts empty.
3. SIGTERM, SIGINT and stdin close: the debounced writes are flushed before exit. Task 3 tests flush-on-exit.
4. `ctx.redis` type errors and edge arguments (WRONGTYPE, negative and huge `pexpire`, `lrange` with negative indexes, `ltrim` past the end): the answers match Redis's, error text included. Task 6's differential test covers them against a live Redis in CI.
5. A key or a balance word reaching the user in the profile: start-up output, the auth refusals and `MODULE_NOT_LISTED` over the profile carry none of key, balance, free call, rate limit. Task 7 asserts it on the captured log and on every refusal text its provider can produce. C's stdio PR asserts it on stderr.

---

## PR B1: the store selection point (no behaviour change)

### Task 1: `lib/store.js` and its consumers

**Files:**
- Create: `lib/store.js`
- Modify: `lib/countinghouse-interface.js` (metering, the db 9 global limiter), `lib/redis-api.js` (db 5 client), `lib/countinghouse-util.js` (db 10 device log), `lib/session.js` (the API-monitor client), `lib/job-control.js` (connection only)
- Test: `test/store/01-selection.js`, `test/store/02-one-selection-point.js`

**Interfaces:**
- Produces: `createStore(options) -> {metering, kv, jobs, deviceLog, globalLimiter, apiLog}` and `getStore() -> the same object for the process` (memoised; created on first use, on the main thread only, never at `require` time).
  - `metering`: a `MeteringProvider` (`recordCall`, `checkBalance`, `rateLimit`).
  - `kv`: the object `redis-api.js`'s `RedisClient` wraps today (node_redis-compatible callbacks for the allowed commands).
  - `jobs`: the `job-control` module surface (`initJobProcess, setCompletionHook, addJob, getJob, getJobHistory, removeJob, listJobs, updateJobProgress, publicRecord, INTERNAL, authorizeRun`).
  - `deviceLog(deviceID, data, timestamp, callback)`, `globalLimiter` (the `rateLimiter` shape, or `null` without `--globalRateLimit`), `apiLog` (the session's client, or `null`).
  - The extra keys beyond the spec's three are internal; C uses `metering.recordCall` only.

- [ ] **Step 1: Write the failing tests.**
  - `01-selection`:
    - with `{store: 'redis'}`, `getStore()` returns the same object twice;
    - `metering instanceof RedisMeteringProvider`;
    - `jobs === require('../../lib/job-control')`;
    - the clients use dbs 0 (metering), 5 (kv), 10 (device log), 9 (global limiter) and 0 (API log), counted at `redis.createClient`; BullMQ's db 11 is unchanged in job-control.
    - The test closes the clients it caused.
  - `02-one-selection-point`, a static scan of `lib/**/*.js`: `require('redis')`, `require('bullmq')` and `createClient(` appear only in `lib/store.js`, `lib/redis-resilient.js`, `lib/metering/redis-provider.js`, `lib/job-control.js`, `lib/redis-api.js` and `lib/logger-stream-redis.js`. No top-level statement in `countinghouse-util.js`, `session.js`, `redis-api.js` or `countinghouse-interface.js` creates a client: assert by requiring each in a child process and checking that `redis.createClient` was not called (a stub installed in `require.cache` first).
- [ ] **Step 2: Run them; expect FAIL** (`Cannot find module '../../lib/store'`; the child process sees `createClient` called at load by countinghouse-util and session).
- [ ] **Step 3: Implement `lib/store.js` and move each client's creation into it unchanged** (same URL, db, options and error handlers). Each consumer calls `getStore().<part>` where it used its client. `redis-api.js` keeps `RedisClient` and takes `getStore().kv` as the main-thread client.
- [ ] **Step 4: Run the two files, then `test/auth/09-http-invoke-action-metering.js` and `test/validation/05-module-error.js` as single files; expect PASS.**
- [ ] **Step 5: Commit (hook runs), push, open PR B1.** The body states "no behaviour change; the whole suite is CI's".

## PR B2: options, the file store, local metering

### Task 2: options

**Files:** Modify `lib/cli-options.js`, `framework.js` (the startup checks). Test: `test/store/03-options.js`.

**Interfaces:** Produces `options.store` (`'redis'|'local'`), `options.storePath` (absolute), `options.meter` (boolean), `options.redisUrlExplicit` (boolean).

- [ ] **Step 1: Failing tests.**
  - the defaults: `store === 'redis'`; `storePath === path.resolve(moduleDataPath, '..', 'store')`; `meter === false`;
  - `--store local --redisUrl redis://x` exits 2 with stderr containing `choose one`;
  - `--store nonsense` exits 2;
  - `--store local` exits 2 with `--store local is not complete in this build` until PR B5 removes that check (Task 9).
- [ ] **Step 2: Run; FAIL. Step 3: Implement. Step 4: Run; PASS.**

### Task 3: `lib/store/json-file.js`, the persisted map

**Files:** Create `lib/store/json-file.js`. Test: `test/store/04-json-file.js`.

**Interfaces:**
- `openJsonFile(file, {debounceMs = 500, lockPath})` returns `{data, set(key, value), delete(key), flush(), close()}`.
  - `data` is the parsed object, or `{}`. It is loaded once at start, and again only after a lock conflict.
  - `set` and `delete` mark a top-level key dirty and schedule a debounced write.
  - `flush()` writes now, synchronously, under the store lock:
    - read the file again;
    - apply the dirty keys over it (deletions included);
    - write `<file>.tmp-<pid>`, `fsync`, `rename`;
    - clear the dirty set and release the lock.
    The last write per key wins (Review Focus 1).
  - On start, a file that does not parse is renamed `<file>.corrupt-<Date.now()>` and a log line says so (Review Focus 2).
- `withStoreLock(storePath, fn)` creates `<storePath>/.lock` exclusively with `{pid, startMs}`.
  - It retries every 10 ms for up to 2 s.
  - A lock whose pid is not alive is taken over.
  - It then runs `fn` and removes the lock.
  - A lock still held after 2 s fails the flush with a logged error. The dirty keys stay dirty and are retried at the next flush.
- `flushAllOnExit()`: registers once for `exit`, `SIGINT`, `SIGTERM` and calls every open file's `flush()` (Review Focus 3).

- [ ] **Step 1: Failing tests:**
  - a round trip;
  - debounce: 3 `changed()` calls within 500 ms give one write;
  - no `.tmp-` file is left behind;
  - a corrupt file is moved aside and the store starts empty;
  - two child processes on one store, each setting 200 disjoint keys with flushes interleaved, end with all 400 keys on disk;
  - a key set by both ends with the later flush's value;
  - a stale lock is taken over;
  - a held lock delays a flush, which succeeds once it is released;
  - a child process killed with SIGTERM after `changed()` leaves the new data on disk.
- [ ] **Step 2–4: Run FAIL; implement with `fs` only; run PASS.**

### Task 4: `lib/metering/local-provider.js`

**Files:** Create `lib/metering/local-provider.js`; modify `lib/metering/index.js`, `lib/store.js`. Test: `test/metering/01-provider-contract.js`, `test/metering/02-local-provider.js`.

**Interfaces:**
- `LocalMeteringProvider({storePath, meter, rateLimitMaxPerInterval, rateLimitIntervalMs})` implements the three `MeteringProvider` methods. It persists to `<storePath>/metering.json` through Task 3.
- Without `meter`:
  - `recordCall` → `{charged: 0, balance: null}`, counting `calls[apiKey][tool]`;
  - `checkBalance` → `{apiKey, balance: null}`;
  - `rateLimit` → `{limited: false}`.
- With `meter`: the Redis provider's semantics. Free calls (`toolPriceRecord[tool].count`) are spent first, then the balance is decremented by `cost`. The demo key is unlimited as on Redis. Rate limiting is a per-key sliding window in memory with the same interval and maximum.
- `createStore` gives `globalLimiter` a local in-memory sliding window in local mode.

- [ ] **Step 1: Failing tests.**
  - `01-provider-contract` runs one table of cases against both providers through the interface. The Redis provider uses a test db (13) and the case is skipped when no Redis answers (CI has one). The local provider uses `meter: true` and a tmp `storePath`.
    - a key with 2 free calls and balance 10, cost 3: calls 1 and 2 charge 0 and calls 3 and 4 charge 3, giving balance 4;
    - `checkBalance` matches;
    - with max 2 per 1000 ms, the third call within the window is `{limited: true}`;
    - `checkBalance(null)` gives the same error code as the Redis provider.
  - `02-local-provider`:
    - without `meter`, 1000 calls are never refused and are counted;
    - `metering.json` survives a new provider on the same path;
    - no file under `storePath` contains the API key in clear: keys are stored by `keyFingerprint`, so the file holds no key.
- [ ] **Step 2–4: FAIL; implement; PASS.**
- [ ] **Step 5: Docs:** `docs/cli-reference` (`--store`, `--storePath`, `--meter`) and the security-model `local` column for metering. Add a row to the spec's table in section 1 (reviewer's ruling 3): "Device log (`lpush devicelog:<id>`, db 10, `lib/countinghouse-util.js`) | in `local`, memory only, the last 1000 entries per device, not persisted". Commit; push; PR B2.

## PR B3: local kv

### Task 5: the allowed command set, named once

**Files:** Modify `lib/redis-api.js`. Test: `test/local-kv/00-allowed.js`.

**Interfaces:** `redis-api.js` exports `ALLOWED_COMMANDS`, the frozen sorted array it computes today (`_.intersection(redisCommands.list, supportedCommands)`). The json file lists 23 entries with `zrange` twice and `zlen`, which is not a Redis command, so the live set is smaller and this test pins it.

- [ ] **Step 1:** Failing test: `ALLOWED_COMMANDS` deep-equals the literal sorted list, written into the test after reading it once from today's code. **Steps 2–4:** FAIL; export it; PASS.

### Task 6: `lib/local-kv.js`

**Files:** Create `lib/local-kv.js`; modify `lib/store.js` (`kv` and `deviceLog` in local mode). Test: `test/local-kv/01-semantics.js` (no Redis), `test/local-kv/02-differential.js` (CI, needs Redis db 13).

**Interfaces:**
- `LocalKv({storePath})`: one method per `ALLOWED_COMMANDS` name, node_redis v3 callback style `(…args, callback(err, reply))`. Replies are as node_redis gives them (strings, `null`, arrays, integers). `multi()` returns a batch whose `exec(cb)` applies its commands in order and returns their replies.
- Types: strings, hashes, lists, sorted sets. A command on the wrong type answers Redis's `WRONGTYPE Operation against a key holding the wrong kind of value`.
- `pexpire` expiry is lazy on read, plus a sweep before each write. State persists to `<storePath>/kv.json` through Task 3, every 5 s and at exit.
- `deviceLog` in local mode keeps the last 1000 entries per device in memory, not persisted (the reviewer accepted this; the spec row is added in B2).

- [ ] **Step 1: Failing tests.**
  - `01-semantics` covers each allowed command once:
    - expiry with a fake clock;
    - WRONGTYPE;
    - `lrange` with negative indexes;
    - `ltrim` past the end;
    - `multi` with `exec`;
    - persistence across a new `LocalKv` on the same path.
  - `02-differential` runs one script of about 60 commands, each case in Review Focus 4 included, against `redis.createClient({db: 13})` (flushed first) and against `LocalKv`, and asserts identical replies and error texts. It is skipped when Redis is absent. This replaces the spec's "fixtures recorded from Redis", because recording would be a local capture, which the process rule forbids; the differential test runs in CI, where Redis exists.
- [ ] **Step 2–4: FAIL; implement; PASS (01 locally; 02 in CI).**
- [ ] **Step 5:** Docs: module-development's `ctx.redis` paragraph (same API in local). Commit; PR B3.

## PR B4: the single-identity profile

### Task 7: `lib/auth/memory-provider.js` and the profile

**Files:**
- Create: `lib/auth/memory-provider.js`.
- Modify: `lib/auth/index.js` (selection), `lib/cli-options.js` (`singleIdentity`, `apiKey`), `lib/identity.js` (the secret's directory), `lib/module-sandbox-config.js` (the secret stays always-denied at its new path).
- Test: `test/auth/50-single-identity.js`.

**Interfaces:**
- `options.singleIdentity === (options.store === 'local' && options.stdio === true && options.authConfigPath == null)`.
  - `options.stdio` is C's option. Until C's flag exists, the test sets it on the options object.
- In the profile, `options.apiKey` is `local-` + 32 hex characters from `crypto.randomBytes(16)`, created at startup in memory only.
- `MemoryAuthProvider({apiKey})` implements `AuthProvider`:
  - `authenticate` passes `apiKey` for every device, service and action, and refuses any other key exactly as FileAuthProvider refuses an unknown one;
  - `listDevices` gives every loaded device;
  - `identityForModule(friendlyName)` gives the one identity for every loaded module. One user uses every tool (spec section 4); `ctx.call` still needs the module's `countinghouse.calls` declaration;
  - `reload` is a no-op.
- Its one entry is `{userName: 'local', id: 'local', devices: ['*']}`, so `identity.idFor` uses the source `id:local` and `ctx.caller.id` does not depend on the key.
- `identity.initSync` uses `options.storePath` instead of `moduleDataPath` when `options.store === 'local'`.
- FileAuthProvider's zero-config demo key (`lib/auth/file-provider.js:187`: it writes `auth.json` and prints the key to stderr) never runs in the profile, because the profile never constructs a FileAuthProvider.
- `--store local --port` without an auth file keeps today's zero-config behaviour: the operator needs a key to send.

- [ ] **Step 1: Failing tests**, in-process with tmp `storePath`/`moduleDataPath` and `LOG` captured:
  - `singleIdentity` is true only for local, stdio and no auth path;
  - the profile's startup creates no `auth.json` and no file containing the key under either path. The key comes from `options.apiKey` in-process, so no test hook exposes it;
  - no captured log line contains the key;
  - `authenticate` with the key passes, and with any other key is refused with FileAuthProvider's code;
  - `identityForModule` gives the identity for any loaded module;
  - `ctx.caller.id` for the key is identical across two `identity.initSync` runs on the same `storePath`, and differs after `.identity-secret` is replaced;
  - the secret's path is in the always-denied set (`module-sandbox-config`);
  - the refusal texts the provider produces contain none of `key`, `balance`, `free call`, `rate limit` (case-insensitive, word-bounded; Review Focus 5);
  - with `store: 'local', meter: true` and a fixture auth file, the FileAuthProvider is used and the balance decrements (Task 4's provider).
  - C's stdio PR adds the end-to-end version: a stdio start with the same assertions on stderr and the store directory.
- [ ] **Step 2–4: FAIL; implement; PASS.**
- [ ] **Step 5:** Docs: README (local mode, one user), security-model (the profile: no auth file, where the secret lives). Commit; PR B4.

## PR B5: the local job runner, and `--store local` on

### Task 8: `lib/job-control-local.js`

**Files:** Create `lib/job-control-local.js`; modify `lib/store.js`. Test: `test/jobs-local/01-runner.js`.

**Interfaces:**
- The same surface as `job-control.js` (Task 1's `jobs` list) with the same argument orders and callbacks: same ownership checks (`ownsJob`, `INTERNAL`), same completion hook, same `publicRecord` shape.
- One in-process worker loop with the same per-job timeout. State lives in memory. A result is kept until it is read, or for `--jobResultTtl`. Schedulers run on `setInterval` with the same id scheme.
- An id from an earlier process answers not found, as `getJob` does for an unknown id.

- [ ] **Step 1: Failing tests** (driven through the surface with a stub `cdifInterface` that answers after a delay):
  - add, then progress, then the result;
  - cancel before the run and during it;
  - timeout gives the same error code as BullMQ's path;
  - a scheduler fires twice in 2.5 s at a 1 s interval;
  - another owner's `getJob` is refused as in `job-control.js`;
  - an id from a fresh runner is not found.
- [ ] **Step 2–4: FAIL; implement; PASS.**

### Task 9: `--store local` is complete

**Files:** Modify `framework.js` (remove Task 2's not-complete check), `lib/module-sandbox-config.js` (`deniedEndpoints` is empty in local), `.github/workflows/ci.yml` (a `local-smoke` job on ubuntu, macos and windows with no Redis service). Test: `test/store/05-local-smoke.js`.

- [ ] **Step 1: Failing test.** Start with `--store local --port <p> --loadModule test/fixtures/<a small module>` and assert:
  - `tools/list` works;
  - `tools/call` works;
  - a `ctx.redis` set and get round-trips;
  - a task via `tasks/*` completes;
  - `redis.createClient` is never called (a `--require` preload in the child process fails the run if it is);
  - the process exits 0 on SIGTERM with `kv.json` flushed;
  - `getStore().apiLog` is `null` (the retired API log is absent).
  C extends the job to `--stdio`.
- [ ] **Step 2–4: FAIL (the not-complete exit); implement; PASS.**
- [ ] **Step 5:** Docs: `docs/deployment.md` (local mode: no Redis, what is not persisted: jobs), CHANGELOG. Commit; PR B5.

## Rulings (reviewer, 2026-11-11)

1. Several processes on one `--storePath`: none refuses; each persisted write is locked, re-read and key-merged (Task 3, Review Focus 1).
2. `singleIdentity` is `--store local --stdio` without `--authConfigPath` (spec section 4); over `--port`, a generated auth.json is the rule.
3. The device log in local mode is memory-only, capped at 1000 per device; the spec gets the row in B2.
