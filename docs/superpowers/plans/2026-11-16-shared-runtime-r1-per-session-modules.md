# Shared runtime R1: per-session modules. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** revision 2, APPROVED by the Reviewer (#349) with rulings D1–D3 as proposed, plus conditions D2(a)/(b) and three additions (marked "Reviewer, #349" below). Written against master at 7d8af977. Build order: Tasks 1–3, then M16's plan while CI runs, then Tasks 4–7.

**Goal:** A module that declares `"countinghouse": {"state": "per-session"}` gets, on the shared runtime, a worker of its own per session, and its store and files partitioned by session. Those partitions live as long as the session (they survive a runtime restart that restores it). Everything else stays as it is: shared modules, `--stdio`, and every listing and golden.

**Architecture:**
- **The declaration** is read on the main thread from the pinned `package.json` (`lib/manifest-pins.js`), as `countinghouse.calls` is.
- **A per-session module is loaded without a worker.** At its load the main thread builds its spec (`lib/module-spec.js`, in a validator, as today) and registers a **listing record** in `deviceMap`: spec, `packageInfo`, `hostModuleName`, `perSession: true`, no worker. The listing readers (`lib/mcp/tool-registry.js`, `prompts.js`, `gateway.js`) need nothing else, so listings and goldens don't move.
- **A new main-thread `lib/session-workers.js`** holds the per-session workers, keyed by (module name, session id). They're spawned through `ModuleManager.spawnModuleWorker` with a `session` option that only the main thread sees.
- **Every dispatch site resolves the worker through one function**, `DeviceManager.prototype.workerFor(deviceID, sessionId, cb)`, before it sends anything: the call path, the routed hop, the device query, a job's run, and the peer broker. A shared module's entry answers itself, as today.
- **A new `lib/session-partition.js`** owns the partitions' names, creation, removal and the sweep. Store keys go under `ms:<encoded name>:<session id>:`. Files go under `<moduleDataPath>/<name>/sessions/<session id>/{data,tmp}`.
- **The registry says why a session ended** (`bye`, `window`, `closed`). A partition is removed on the first two, never on `closed`.

**Tech stack:** Node ≥ 22.16, mocha. C1's session transport (`lib/session-transport/*`), B1's `lib/sessions.js`, the fs broker (`lib/fs-broker`), `lib/redis-namespace.js`.

**Spec:** `docs/superpowers/specs/2026-11-15-shared-runtime-design.md` (#236), §4a (all of it), §6 (the restored ids, the sweep's place), §9 residual 5, and its plan's R1.

## Decisions (ruled on #349: all three as proposed)

- **D1. The pin (spec correction).** §4a says the field is "pinned with the manifest like `role` and `sessionDefaults` (`manifestPins`)", and "a reload that changes it is refused like any other pinned field". On master, **`manifestPins` pins `countinghouse.calls` only** (its header says so). `role` isn't pinned, `sessionDefaults` exists nowhere in `lib/`, and no reload is refused for a manifest change. **Proposal:** `manifestPins` also keeps `countinghouse.state` (the operator's load takes the file; a supervised restart keeps the pin, as for `calls`). `reloadModule` refuses a load whose state differs from the loaded one, with a new code `MODULE_STATE_CHANGED` ("unload it first"), because a running module's workers and partitions can't change shape in place. `role` stays as it is (out of scope). **Ruled:** yes, and §4a's text is corrected in this PR so the spec matches the source.
- **D2. The listing record.** A per-session module has no worker until a session calls it, so its `deviceMap` entry is the main thread's spec record, not a `WorkerMessage`. **Every site that sends to `deviceMap[id]` must go through `workerFor`.** On master there are 18 `deviceMap[` sites in `device-manager.js`, 5 in `peer-channel-broker.js` and 2 in `route-manager.js`; Task 5 lists each one and what it does. The alternative, a router object that impersonates a `WorkerMessage`, hides an async spawn behind sync-looking sends, so it's rejected. **Ruled:** yes, with two conditions. (a) In shared mode a per-session module reached at a dispatch site with no session id fails CLOSED: `DEVICE_NOT_FOUND`, the same bytes as an unknown device, never "use any worker". (b) Task 5's PR lists every converted site (18 + 5 + 2), and a test shows a per-session module is reached by the right session's worker through each of the call, the routed hop, the query, the job run and the peer broker.
- **D3. Daemon-death notice.** §4a: after a daemon death "each reconnecting session is told 'per-session state was reset', as §6 tells loosenings". I'll hook the same place §6's loosening reset uses (`lib/session-state.js` and the restore's `reset` rows). If that path only covers restored sessions, a daemon death (nothing restored) needs a runtime-wide "reset at start" flag that the next new session's first result carries. Proposal: that flag, set when the sweep removed anything and no row was restored. **Ruled:** yes, both. The wording goes to the Reviewer with the en/zh review.

## Global constraints

- **No session id reaches a module** (§4a): not in `options`, `workerData`, env, argv, an error's text, a log line the module sees, or a job's data. `hostSession` is a main-thread field on the `WorkerMessage`, like `hostModuleName`.
- **Outside the shared runtime nothing changes.** Under `--stdio` a per-session module runs in its one worker on today's paths (`<name>/{data,tmp}`, `m:<name>:`) whatever it declares. On the HTTP profile its load is refused with `MODULE_NEEDS_SESSIONS`, naming the module.
- **Not reachable is unknown** (B3's rule): a call with no session, a token or peer channel past its session's end, and a job whose session ended are answered as a device never hosted (`missingDeviceErrorForHop`: `DEVICE_NOT_FOUND`, no ID). Never a code that says the module exists.
- **Prefixes never nest:** `ms:<enc(name)>:<sid>:` and `m:<enc(name)>:` each keep their trailing colon, and `<sid>` is exactly 32 lowercase hex characters (`lib/session-transport/restore.js` `SESSION_ID`). A purge of `ms:foo:` can't reach `ms:foobar:`, and nothing in `ms:` can be named from `m:`.
- **Data paths:** `<moduleDataPath>/<name>/sessions/<sid>/{data,tmp}`, made 0700 by `lib/module-data.js`. The worker sees `/data` and `/tmp` as today. The broker maps them on the main thread, and the scrub strips the session root from paths and error texts.
- **Lifetime:** removed on the session's `bye` or window expiry only, never on `Registry.close()`. The restored ids keep their partitions; the sweep (before the listener accepts) removes partitions whose id wasn't restored.
- **Limits:** `--maxSessionWorkers` (default 16, operator only; a session can't raise it). At the cap, the least recently used session worker with no call in flight gives up its slot, and its session is told "<module>'s in-memory state was reset; its files were kept". If none can, the call is refused `SESSION_WORKERS_BUSY` (retryable). Nothing is queued. The fs quota counts all of a module's partitions together.
- **The cap never kills mid-call** (Reviewer, #349). LRU eviction takes only a worker with no call in flight and no live token issued to it (a hop's, a job's, a peer channel's). When every slot is busy, the call is `SESSION_WORKERS_BUSY` (retryable). Tested in Task 4.
- **The memory cost is stated, and the cap is the operator's** (Reviewer, #349). The docs state the per-session cost as one lean worker (~14.5 MB measured on #177) × `--maxSessionWorkers` (16 by default: ~232 MB at the cap) above today's shared workers. The cap is a CLI flag only: never a setting a session can change in conversation, and not in the settings tool's allowlist.
- **B3's session packs** (Reviewer, #349). A per-session module inside a this-session pack: its workers and partitions follow the pack's session membership (`lib/session-packs.js`). A pack turned off or unloaded for a session stops that session's worker of it (its partition is kept until the session ends, as a crash's is). The hook is agreed with B. B3's Task 9 restore of packs and this plan's sweep keep the order: `_restore`, then B3's pack restore, then the sweep, then `listener.listen()`.
- **No idle stop.** A session worker stops only at its session's end, at the cap, on its module's reload or unload, or by crashing.
- New error codes (`MODULE_NEEDS_SESSIONS`, `MODULE_STATE_INVALID`, `MODULE_STATE_CHANGED`, `SESSION_WORKERS_BUSY`) go into `lib/error-catalogue.js` with `en` and `zh` texts, and get their own wording review.
- **Running tests:** one file at a time, under the suite lock, each in the 2 GB no-swap cap with MemAvailable ≥ 3 GB (the user's rule). Server files go through `node test/helpers/run-local.js`. No folder runs locally: the PR's CI is the gate. The memory baseline (§4a "to be measured") is a CI-only perf run, a register row, not part of these tasks.

## Review focus

1. **A shared module holding two sessions' calls** (§9 residual 5): a hop it makes must land in the worker of the session whose token it used, never the other's, including over a peer channel opened earlier under the other session's call (Task 5's hop-isolation case).
2. **A crash of one session's worker:** the supervisor is keyed by module name (`this.supervisor.clear(name)`). A crash must restart (or end) only that (module, session) worker, never the listing record or another session's worker (Task 4's crash case).
3. **Reload or unload of a per-session module:** every session's worker stops. The next call spawns one on the new code (reload) or is unknown (unload). Partitions are kept on reload and removed on uninstall, whose purge must cover `ms:<name>:` as well as `m:<name>:` (Task 3 and Task 4).
4. **A session ending while its worker has a call in flight:** the call ends as a cancelled one does today (billed for what ran). The worker stops after it, and the partition is removed after the worker has stopped, never under it (Task 6).
5. **The sweep and a resume racing:** the sweep runs before the listener accepts, so no resume can arrive mid-sweep. A restored session that resumes after the sweep finds its partition (Task 6's restart case).

---

### Task 1: The declaration, its pin, and where it applies

**Files:**
- Create: `lib/module-state.js`
- Modify: `lib/manifest-pins.js` (keep `countinghouse.state` with the calls), `lib/module-manager.js` (`loadModuleFromPath`, `reloadModule`, `spawnModuleWorker`), `lib/error-catalogue.js`
- Test: `test/module-loading/36-per-session-declaration.js` (spawned server, `testPort`)

**Interfaces:**
- Produces: `stateOf(pkg) -> 'shared' | 'per-session'`, which throws `CountinghouseError('MODULE_STATE_INVALID', name, value)` for anything else; `perSessionModule(mm, name) -> boolean` (from the pin); `ModuleManager.prototype.isPerSession(name)`.

- [ ] Write the failing tests: `"state": "per-session"` loads on the shared runtime and is listed as before (tools/list unchanged); `"state": "wobbly"` refuses the load naming `wobbly`; on the HTTP profile a per-session module's load is `MODULE_NEEDS_SESSIONS` naming the module; under `--stdio` it loads and runs on `<name>/data` and `m:<name>:`; a reload that flips `shared` ↔ `per-session` is `MODULE_STATE_CHANGED` and the loaded one keeps serving.
- [ ] Run them: FAIL.
- [ ] Implement `stateOf`, the pin and the three load-site checks. "Shared runtime" is `options.sessionSocket != null`, "stdio" is `options.stdio === true`, anything else is the HTTP profile.
- [ ] Run: PASS. Commit.

### Task 2: The registry says why a session ended

**Files:**
- Modify: `lib/session-transport/registry.js` (`_end(reason)`, `_forget(s, reason)`, `close()`, the `bye` and window callers), `lib/sessions.js` (passes it on)
- Test: `test/session-transport/10-end-reasons.js` (server-free, the registry with a fake connection)

**Interfaces:**
- Produces: `session.emit('end', reason)` and `registry.emit('gone', id, reason)`, with `reason ∈ {'bye', 'window', 'closed'}` (a restored session never resumed ends `'window'`). Existing listeners that ignore the argument are unaffected.

- [ ] Failing test: `bye` gives `'bye'`, a detach past `reconnectWindowMs` gives `'window'`, a restored row never resumed gives `'window'`, and `close()` gives `'closed'` for every session.
- [ ] Implement. Run: PASS, and `test/session-transport/*` one file at a time still green. Commit.

### Task 3: Partitions: names, creation, removal and the sweep

**Files:**
- Create: `lib/session-partition.js`
- Modify: `lib/module-data.js` (`sessionDirsFor(dataRoot, name, sid)`, `ensureSessionDirs`), `lib/redis-namespace.js` (`sessionPrefixFor(name, sid)`; `unprefixError` takes either prefix), `lib/module-manager.js` `uninstallModule` (purges `ms:<enc(name)>:` too, and `<name>/sessions/`)
- Test: `test/local-kv/05-session-partition.js` (server-free, the local kv and a temp data root)

**Interfaces:**
- Produces:
  - `sessionPrefixFor(name, sid) -> 'ms:' + encodeURIComponent(name) + ':' + sid + ':'`, or null for a bad name or an id that isn't 32 hex characters;
  - `partition.ensure(name, sid) -> Promise<{data, tmp}>`;
  - `partition.remove(name, sid) -> Promise<{keys, dirs}>`;
  - `partition.list() -> Promise<[{name, sid}]>` (the dirs under every `<name>/sessions/`, plus the `ms:` keys by SCAN, or `deletePrefix` on the local kv);
  - `partition.sweep(keepIds: Set) -> Promise<{removed: [{name, sid}]}>`.

- [ ] Failing tests:
  - two sessions' prefixes and dirs are distinct, and a third id's purge removes only its own;
  - `ms:foo:` never matches `ms:foobar:`, and a name with `:` is encoded;
  - an id that isn't 32 hex is refused (null);
  - `remove` deletes keys and dirs, and is idempotent;
  - `sweep(keep)` removes exactly the partitions not in `keep`;
  - `uninstallModule` removes `m:` and every `ms:` of the module;
  - `unprefixError` strips a session prefix.
- [ ] Implement. Run: PASS (and `test/local-kv/03`, `04`: the existing namespace and purge pins). Commit.

### Task 4: Session workers: spawn, cap, crash, reload

**Files:**
- Create: `lib/session-workers.js`
- Modify:
  - `lib/module-manager.js`: `spawnModuleWorker(..., {session})`. The broker is built with the session's dirs (`createForWorker`'s data root from Task 3), `wm.hostSession = sid` is set main-side only, and the worker is NOT made `this.modules[name]`.
  - `lib/device-manager.js`: `registerFromSpec` keeps a session worker's device off `deviceMap`; the `rediscommand` handler uses `sessionPrefixFor(name, wm.hostSession)` when set.
  - `lib/cli-options.js`: `--maxSessionWorkers`, default 16, min 1.
  - the supervisor's key: (name, session) for a session worker.
- Test: `test/session-runtime/03-per-session-workers.js` (spawned shared runtime; two sessions through `test/session-transport/helpers/shim`), plus fixture `test/fixtures/per-session-module` (it writes to `ctx.redis` and `/data`, and dumps `process.env`, `process.argv`, `workerData` keys and its options to `/data/seen.json`)

**Interfaces:**
- Consumes: Task 1's `isPerSession`, Task 3's `ensure`.
- Produces:
  - `sessionWorkers.get(name, sid, cb(err, wm))`: spawns on the first call; at the cap it evicts the LRU idle worker (with the announcement) or fails `SESSION_WORKERS_BUSY`;
  - `stop(name, sid, why)`, `stopSession(sid)`, `stopModule(name)`;
  - `inFlight(wm)` (count, from the existing in-flight registry);
  - `size()`.

- [ ] Failing tests:
  - two sessions calling the per-session fixture see their own counter in `ctx.redis` and their own file in `/data`, while a shared fixture sees one of each;
  - `seen.json` contains no session id (all 64 characters of both ids grep'd);
  - with `--maxSessionWorkers 1`, session B's call evicts A's idle worker, and A's next result carries "per-session-module's in-memory state was reset; its files were kept" with A's file still there;
  - with A's call held in flight, B's call is `SESSION_WORKERS_BUSY`;
  - killing A's worker restarts only A's (B's counter is intact, the listing unchanged);
  - a reload stops both, and the next calls run the new code with the files kept;
  - **never mid-call** (Reviewer, #349): with `--maxSessionWorkers 1`, A's worker holding a live hop token (a call in flight in the shared caller) isn't evicted for B, and B gets `SESSION_WORKERS_BUSY`;
  - **B3:** turning off a this-session pack that holds the per-session fixture stops that session's worker of it, and the other session's runs on.
- [ ] Implement. Run: PASS. Commit.

### Task 5: Routing every dispatch through `workerFor`

**Files:**
- Modify: `lib/device-manager.js`, `lib/peer-channel-broker.js`, `lib/route-manager.js` (each `deviceMap[` site in a dispatch path; the listing readers stay as they are)
- Test: `test/session-runtime/04-per-session-routing.js` (spawned), plus `test/fixtures/per-session-caller` (a shared module that hops into the per-session one, and opens a peer channel to it)

**Interfaces:**
- Consumes: Task 4's `get`.
- Produces: `DeviceManager.prototype.workerFor(deviceID, sessionId, cb(err, wm))`. A shared entry answers with itself synchronously. A per-session entry answers with `sessionWorkers.get(...)`. With `sessionId == null`, or an ended session, it answers `missingDeviceErrorForHop(deviceID)`.

- [ ] List each `deviceMap[` site in the PR body with its decision: dispatch → `workerFor`, listing → unchanged.
- [ ] Failing tests:
  - the call path, the routed hop (the token entry's `session`), the device query (the claim's token), a job's run (`lib/job-sessions.js` `forRun`) and a peer channel each reach the calling session's worker;
  - **hop isolation:** the shared caller serving A and B at once hops under A's token and lands in A's worker, even over a channel B's call opened;
  - a hop token or a job of a session that has ended answers `DEVICE_NOT_FOUND` with no ID, runs nothing and bills nothing;
  - the job isn't retried.
- [ ] Implement. Run: PASS, plus `test/composition/18`, `test/direct-peer-channels/*`, `test/mcp-contract/01` and `02` (the routing and golden pins), one file at a time. Commit.

### Task 6: Lifetime, the sweep and the announcements

**Files:**
- Modify:
  - `lib/sessions.js`: on `'gone'` with `bye` or `window`, `stopSession(sid)` and then `partition.remove` for each per-session module; on `closed`, stop only;
  - `lib/route-manager.js` `startSessions`: after `registry._restore(...)` and before `listener.listen()`, `await partition.sweep(new Set(restored ids))`;
  - D3's reset notice.
- Test: `test/session-runtime/05-per-session-lifetime.js` (spawned; restarts the runtime with a restore control message, as `test/session-transport/07-resume-restore.js` does)

**Interfaces:**
- Consumes: Task 2's reasons, Task 3's `remove` and `sweep`, Task 4's `stopSession`.

- [ ] Failing tests:
  - `bye` removes that session's keys and dirs, and the other session's stay;
  - the window's expiry removes them;
  - `close()` (a runtime stop) removes none;
  - a restart with A restored and B not keeps A's partition and sweeps B's, and A's resumed call sees its file;
  - a restart with nothing restored sweeps all, and the next session's first result says "per-session state was reset";
  - a session ending with a call in flight: the call ends as a cancel does, and the partition is removed only after the worker stopped.
- [ ] Implement. Run: PASS. Commit.

### Task 7: Docs

- [ ] Update `docs/module-development.md` (the declaration, what a module sees: nothing new; files and store per session; no idle stop; the cap and its memory cost, ~14.5 MB × the cap, operator-only), `docs/cli-and-api-reference.md` (`--maxSessionWorkers`), `docs/security-model.md` (§9 residual 5 with state; the partitions' lifetime). One commit, in the same PR as Task 6.

## Out of scope

- R2, ch-local's install review line ("keeps state per session"), which comes after R1.
- The baseline RSS of one idle lean worker per extra session worker: a CI-only perf run, already a register row of A's.
- `role` pinning (D1).
