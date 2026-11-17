# Shared runtime B3: per-session packs. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** revision 2, after implementer B's review (#298) and the reviewer's rulings on it. Written against master at 11c57088 and checked by B against 3f1fd23e (#287, #294 and #296 have merged since; #300, B2's Task 6, is open). Tasks 5 and 6 build on the contract in "For C". Task 8 must not merge before B5's Task 1 and #300. Task 9 needs #300.

**Goal:** In shared mode a pack turned on in conversation is loaded once and listed only to the sessions that turned it on. A pack turned off in conversation is hidden from that session only. A tool, a hop's callee or a device that a session doesn't list is answered exactly as an unknown one, byte for byte. `tools/list` and `list_changed` are per session. The session is checked at every hop, routed and over a direct peer channel. The input a hop holds on the main thread is shared out per session.

**Architecture:**
- The stored override in `lib/session-settings.js` is the one record of "this session has this pack on" (it already takes `pack.<n>` with a version). Its `globalPack` is `() => null` on master; B3 wires it.
- A new main-thread `lib/session-packs.js` holds, per pack, whether it is global and the set of sessions that have it on. **Membership follows the stored override:** it hears `sessionSettings.onChange(id)` and puts that session in a pack's set exactly when its stored override is on. Nothing else joins or leaves. It answers "does this session list this pack, this module, this device" from memory.
- The listing is filtered after #274's global tool table (`lib/mcp/tool-registry.js` `buildToolTargets`), on a copy. `tools/call` looks its target up in the global table and then asks the same question.
- A hop asks it on the main thread from its call token's session: in `lib/device-manager.js` (the routed hop, the device query, a job's run) and in `lib/peer-channel-broker.js` (the channel request, the announcement, the match).
- In shared mode the settings tool takes `pack.<n>` as the session's override. Turning one on needs the session's form; the pack is loaded through ch-local's daemon only when it isn't loaded already.
- ch-local says whether a load is for everyone (`global`, on the message; the runtime never infers it), and its notices about a pack go to the sessions that list the pack.

**Tech stack:** Node ≥ 22.16, mocha. C1's session object and B1's `lib/sessions.js`. The control channel's `ask` (`load-pack`, `unload-pack`).

**Spec:** `docs/superpowers/specs/2026-11-15-shared-runtime-design.md` (#236), sections 3, 4, 9 and 11 (answer 1), its Appendix, and its plan's B3. The B1 and B2 plans beside this one have the session interfaces.

**Names.** A pack's name is ch-local's (`ci-failure-triage`): the `<n>` of the setting `pack.<n>`, and the first directory of its scenario below `--packsRoot` (`lib/packs-in-place.js` `chLocalPackOf`). The runtime's record of a pack (`packsOf(mm)`) is keyed by its scenario's package name and lists its modules.

## Global constraints

- **The session never reaches a worker** (B1). Nothing here sends a session id, a pack's visibility or a "hidden" mark to a worker, in a message, a token or an error. A message to a worker about a callee the session doesn't list is the same bytes as one about a device never hosted.
- **Not listed is unknown, byte for byte** (§4, §11 answer 1).
  - A tool: the JSON-RPC error `tools/call` gives a name that was never registered (-32602, `unknown tool: <name>`), from the same line of code.
  - A hop's callee, and a queried device: `DEVICE_NOT_FOUND` with no ID, as `missingDeviceErrorForHop` gives a device never hosted, and after the access check as there.
  - Never `MODULE_NOT_LISTED`, `MODULE_RESTARTING`, `MODULE_RELOADING`, `MODULE_SUSPENDED`, `MODULE_UNLOADED` or `PEER_NOT_GRANTED`: each would say the module exists.
- **A module is listed to a session when any pack that owns it is.** A part two packs share is one module at one version (`PART_VERSION_CONFLICT` otherwise), so a session that lists either pack may reach it. A module no pack owns (loaded another way at start) is listed to all.
- **Outside shared mode nothing changes.** Under `--stdio`, over HTTP and with `runtime: own`, `sessions.shared()` is false and every question here answers "listed" without looking. The `tools/list` golden and the error-shape golden don't move, and `packsThisStart` and the per-start form stay as they are.
- **#274's table holds only global state.** A session's view is applied after it, on a copy, and the session never goes into its key or its inputs (`test/module-loading/30-call-path-caches.js` holds this).
- **Nothing new on a call's path:** no `require()` (use `lib/require-once.js`, #278), no file read, no ceiling read, no regular expression. With no session set and no pack override anywhere, the check is one boolean.
- **Conversation never writes `settings.json`** (§3). A pack set in a session is an override. Only the history is written, and its line names the session opaquely.
- **In shared mode `pack.<n>` joins the two caps as what a session may set,** by pattern. Every other setting stays `SETTING_TERMINAL_ONLY_SHARED`. A pack is never set for all sessions from conversation (B2's Task 5b).
- **A refusal names nothing of another session:** no other pack, no session id, no count of sessions.
- **Fail closed.** A pack still loaded that no session lists and that isn't global (an unload that failed) is hidden from every session.
- The form's text for a pack says "for this session", in `en` and `zh`. It gets its own review round, with B2's.
- No API key, user name or secret in a log line, error text, history line or anything a module receives.
- **Running tests.** One file at a time. A file that starts a server runs through `node test/helpers/run-local.js <file>`, under the suite lock; a server-free one with `npx mocha --exit <file>`. Where a command below guesses wrong about an existing file, that file's header decides. No full suite locally: the PR's CI matrix is the gate.

## Review focus

1. **A hop from B's call into a pack only A turned on.** It is reachable: `closureOf` (`lib/module-roles.js`) doesn't walk through a module with no role, so a role-less part of a pack B lists can declare a call into A's pack. It is also reachable over a peer channel already open (a channel is per worker pair, and one worker serves every session), from a job's run, and from a device query. Each must answer as a device never hosted, run no handler and bill nothing (Task 4). And on master a peer-channel deny fails every call queued for the device, whichever session each is from: a deny must fail only the denied session's calls (Task 3b).
2. **Answers that say "it exists".** Three checks come before any session check on master: `target.unlisted` in `handleToolsCall` (`MODULE_NOT_LISTED`), `target.replacing` in the broker's `handleRequest` (`MODULE_RELOADING`), and the supervisor's state in `missingDeviceError` (`MODULE_RESTARTING`). The session check goes before each (Tasks 3 and 4).
3. **A stale view.** The per-session answer is cached. It must be dropped on: a session's stored override changing by any road (`set`, `clear`, `ceilingSeen`, `dropPack`), a pack loaded, reloaded (a reload can add a part) or unloaded, a pack becoming global, and a session's end. The same events move the session in or out of the pack's set, since membership follows the override. A stale entry is either a leak or a tool that wrongly vanishes (Tasks 1 and 2).
4. **B told about A's pack some other way.** On master the daemon's `load` notice is added for every session (`lib/route-manager.js:233`). The others: a `notice` with no module, a `list_changed` to B when only A's list changed, a load refused "already the tool of <A's pack>" (the fixed text hides which pack; that some pack is loaded stays visible, a residual the reviewer accepted: it is the same user's), a `get` row, and a usage report row naming A's tool, which is why Task 8 waits for B5's Task 1 (Tasks 5, 6 and 8).
5. **The session set under races, and the terminal's off.** A terminal `pack off` arrives as `unload`: it must end every session's own "on", keep every session's own "off", and tell every session that listed the pack, with the audience taken before anything is cleared (Task 6). Two sessions confirming one pack while it loads (one load, both in or neither); the last session leaving while another's confirmation is in flight (no unload under a session that just joined); a session ending mid-load; ch-local unloading a pack sessions are in; an unload that fails; a pack turned on under a ceiling that then stops allowing it, which `ceilingSeen` must drop for good, and the session must leave the set with it; and what changed during the 45 s a load may take: the session ended, its client said no, a lock fell on it, the ceiling moved, its own override changed (Tasks 1, 2 and 8).

---

### Task 1: which packs a session lists (`lib/session-packs.js`)

**Files:**
- Create: `lib/session-packs.js`
- Test: `test/sessions/13-session-packs.js` (server-free)

**Interfaces:**
- Consumes, through `configure({records, moduleOf, overridesOf, onOverrideChange, openSessions, shared})`:
  - `records()` → the pack records (`lib/packs-in-place.js` `packsOf(mm)`: scenario name → `{scenario, modules: Map}`) and each one's pack name;
  - `moduleOf(deviceID)` → the name of the module that hosts the device, or that last hosted it (`deviceMap[id].hostModuleName`, else the supervisor's or the ended-state record's module name), or null;
  - `overridesOf(session)` → that session's stored pack overrides, pack → true or false (Task 2's `packOverridesOf`);
  - `onOverrideChange(fn)` → `sessionSettings.onChange`;
  - `openSessions()` → the ids of the sessions open now;
  - `shared()` → `lib/sessions.js` `shared()`.
- **Membership follows the stored override.** On every `onOverrideChange(id)` the store reconciles that session: it is in a pack's set exactly when its stored override for that pack is on. There is no `join` or `leave` for other files to call. So a ceiling that drops an override (Task 2), `sessionSettings.clear` (#296), a `set` to off and `dropPack` each make the session leave, in this one place.
- Produces:
  - `setGlobal(pack, on)` and `isGlobal(pack)`;
  - `lists(session, pack)` → boolean: the session's stored override when it has one, else `isGlobal(pack)`. A session of null lists the global packs only;
  - `listsModule(session, moduleName)` and `listsDevice(session, deviceID)` → boolean (the rule in Global constraints). A device whose module is not known is listed: it is no pack's;
  - `listsDeviceFor({packsOff}, deviceID)` → boolean, for a run whose session has ended (Task 4): the global packs, minus the packs in `packsOff`, and no this-session pack;
  - `packsOffOf(session)` → the packs the session has turned off (a copy), read at its end for its jobs;
  - `none()` → true while no pack has a session set and no session has a pack override;
  - `audienceOf(pack)` → a Set of the ids of the sessions that list the pack now (a copy): for a global pack, every open session without its own "off"; otherwise its set;
  - `forget(session)`, called once, by `lib/sessions.js` `close` (`sessionSettings.forget` calls no listener);
  - `packChanged(pack)`, called by the load and reload handlers, and `packGone(pack)`, called by the unload handler: the pack is no longer global and its set is empty;
  - `onEmpty(fn)`, called with a pack whose set has just become empty while it isn't global (Task 8 asks the unload);
  - `onChange(fn)`, called with a session id, or null when every session's view may have changed.
- Outside shared mode `lists`, `listsModule`, `listsDevice` and `listsDeviceFor` return true and `none()` true, whatever was configured.

- [ ] **Step 1: Write the failing tests** (`describe('sessions 13: which packs a session lists')`).
  - A's stored override on, B with none: A lists the pack, its scenario and its part; B lists none of the three.
  - A part owned by A's pack and by a global pack is listed to B.
  - An off override hides a global pack from that session only.
  - Each way an override goes makes the session leave the set: `set` to off, `clear`, a ceiling seen without the pack, `dropPack`. `onEmpty` is called once when the last one leaves a pack that isn't global, and never for a global pack.
  - `forget(A)` takes A out of every set and calls `onEmpty` for each pack it emptied.
  - A module no pack owns is listed to both, and so is a device whose module isn't known.
  - A session of null lists only the global packs.
  - `listsDeviceFor({packsOff: ['ci']}, …)` lists a global pack's device, not `ci`'s, and not a this-session pack's.
  - The cached view is dropped by each of review focus 3's events. After a reload adds a part, B doesn't list the new part.
  - `none()` is true before any override and false after one.
  - With `shared()` false every question answers true.
  - `audienceOf` for A's pack is A's set. For a global pack it is every open session but the one that turned it off.
- [ ] **Step 2:** Run `npx mocha --exit test/sessions/13-session-packs.js`. It fails: `Cannot find module '../../lib/session-packs'`.
- [ ] **Step 3:** Implement. Keep one cached Set of hidden module names per session, built on first use and dropped by `onChange`.
- [ ] **Step 4:** Run the same command; it passes.
- [ ] **Step 5:** Commit.

**Size:** 1 day. **Needs:** nothing.

### Task 2: pack overrides under the ceiling (`lib/session-settings.js`)

**Files:**
- Modify: `lib/session-settings.js`
- Test: `test/sessions/14-pack-overrides.js` (server-free), plus sessions 06

**Interfaces:**
- `globalPack` defaults to `(name) => sessionPacks.isGlobal(<n>)`, where it is `() => null` today.
- `ceilingSeen(c)` also drops every stored `pack.<n>` override whose value is true and that `c` no longer allows (a trusted ceiling: an allowlist that leaves the pack out, or conversation off). A ceiling that can't be trusted drops nothing (the reviewer's ruling (4) on #340): while it lasts, `packOnAllowed` is false, so every surface (listing, tools/call, prompts/get, completion, later resources/read) counts the "on" as off, through `lib/session-packs.js`'s view, keyed by `ceilingKey()`. Fail closed on exposure, without losing state. It calls `onChange` for each session, and returns nothing new. Today it clamps cap loosenings only, and `effective` hides a disallowed pack at read time while the store keeps `true`, so a ceiling lowered and raised again would bring the pack back with no new confirmation.
- `dropPack(name)` → the ids whose "on" override was dropped: ch-local unloaded the pack (a terminal off included, Task 6). A session's own "off" stays.
- `packOverridesOf(id)` → a Map of pack → true or false, for Task 1. (Not `packsOf`: that is `lib/packs-in-place.js`'s name for another thing. #300's export reads `overridesOf` and needs nothing new.)
- Every path that changes or drops a stored pack override calls `onChange(id)`: `set`, `clear` (#296), `ceilingSeen` and `dropPack`. `forget` calls none; `lib/sessions.js` `close` tells Task 1's store itself.

- [ ] **Step 1: Write the failing tests.**
  - A has `pack.ci` on under a ceiling that allows it. A ceiling seen without `ci` drops A's override and calls `onChange(A)`.
  - The ceiling raised again: A's effective value stays the global one (the reviewer's note).
  - An off override is never dropped by a ceiling.
  - A ceiling that is stale (undefined) drops nothing.
  - `dropPack` drops the "on" overrides of that pack only, calls `onChange` for each, and leaves every "off" override.
  - With Task 1's store listening: after the ceiling drops A's override, A is in no set and `onEmpty` was called for the pack.
  - `clear(A, 'pack.ci')` calls `onChange(A)`.
  - With no override, `effective(A, 'pack.ci')` follows `sessionPacks.isGlobal`.
- [ ] **Steps 2–5:** run `npx mocha --exit test/sessions/14-pack-overrides.js` (it fails), implement, run it and `npx mocha --exit test/sessions/06-session-settings.js` (they pass), commit.

**Size:** 0.5 day. **Needs:** Task 1.

### Task 3: `tools/list` and `tools/call` read the session

**Files:**
- Modify: `lib/mcp/tool-registry.js` (`filterTargetsBySession`; `buildToolList` takes `{session}`)
- Modify: `lib/mcp/gateway.js` (`handleToolsList` takes `opts`; `handleToolsCall`'s lookup; the dispatch line for `tools/list`)
- Test: `test/sessions/15-pack-listing.js` (server-free), plus `test/module-loading/30-call-path-caches.js`

**Interfaces:**
- `toolRegistry.filterTargetsBySession(targets, sessionId)` → the same object when `sessionPacks.none()`, else a new object without the targets whose `deviceID` the session doesn't list. It runs after `buildToolTargets` and never changes the cached table.
- `toolRegistry.buildToolList(cdifInterface, appKey, callback, {session = null} = {})`.
- `handleToolsList(req, cdifInterface, appKey, callback, opts)` reads the session with `sessionIdOf(opts)`, as `handleToolsCall` does. The subscriptions hub already lists with `{session: s}` (`lib/route-manager.js:76`–80), so its fingerprints become per session with no change there.
- In `handleToolsCall`, after `buildToolTargets(…, {includeUnlisted: true})[name]` and **before** the `target.unlisted` check: a target whose device the session doesn't list is treated as `target == null`, so the existing line answers `unknown tool: <name>`. A task-augmented call takes the same lookup.

- [ ] **Step 1: Write the failing tests.**
  - A's `tools/list` has the pack's tool and B's doesn't. Nothing else in B's list differs from its list before the pack was loaded, compared as serialized text.
  - B's `tools/call` of the tool, then the pack unloaded, then the same request again: the two responses are equal as serialized text.
  - B calling the pack's unlisted part by name gets `unknown tool`, and A gets `MODULE_NOT_LISTED` as today (review focus 2).
  - B's legacy `params.task` call of the tool gets `unknown tool`, and no job is added.
  - A global pack B turned off: gone from B's list and unknown to B's call; A's list and call unchanged.
  - `buildToolTargets(cdif)` returns the identical frozen object before and after both sessions list, and `filterTargetsBySession` returns its input while `none()` is true.
  - With `shared()` false, `handleToolsList`'s answer for the golden's module set equals `test/mcp-contract/tools-list.golden.json` (the fixed expected value, not a second run of the same code).
- [ ] **Step 2:** Run `npx mocha --exit test/sessions/15-pack-listing.js`; it fails (B's list has the tool).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it, then `npx mocha --exit test/module-loading/30-call-path-caches.js` and `npx mocha --exit test/module-loading/31-require-once.js`; they pass.
- [ ] **Step 5:** Commit, holding the suite lock (the pre-commit hook runs the `tools/list` golden, which must not move).

**Size:** 1 day. **Needs:** Task 1.

### Task 3b: a peer-channel deny fails only the denied session's calls

**Files:**
- Modify: `lib/peer-worker.js`: `onPeerChannelDeny`
- Modify: `lib/peer-channel-broker.js`: `handleRequest`'s denies
- Test: `test/sessions/16-pack-hops.js` (its first cases; server-free, the worker's peer methods and the broker with stand-in workers)

**Interfaces:**
- **On master** a channel request carries the first queued call's token, and a deny fails every call queued for that device (`flushPendingPeerInvokes`), except for `CALL_TOKEN_INVALID`, which fails the head call and asks again with the next one's token. The queue holds calls of several sessions. Once a deny can depend on the token's session (Task 4), B's deny would fail A's call.
- **The rule.** A deny that depends on the requesting call is for that call only. The broker marks it `headOnly: true`; `onPeerChannelDeny` fails the head call and asks again with the next queued call's token, as it does for `CALL_TOKEN_INVALID`. So each queued call is judged by its own token, a denied session's calls are each denied, and another session's are granted.
- `headOnly` is on **every** `DEVICE_NOT_FOUND` deny, for a device never hosted too, so the message is the same bytes whether the callee is hidden or absent. It names no session, and the worker learns none.
- **The cost, stated.** A device never hosted, with N calls queued for it, now takes N requests and N access checks where it took one. The worker's queue has no cap of its own on master (`lib/peer-worker.js:45`); N is bounded by the calls in flight into that worker, and each request is one worker message under `--moduleMessageRate`. A module that queues calls to a device never hosted pays that, and no more.
- A deny for any other reason (an access error, `PEER_SELF_TARGET`, `MODULE_RELOADING` for a target the session lists) fails every queued call, as today: those are the same for every session of the one user.

- [ ] **Step 1: Write the failing tests.**
  - With calls queued B1, A1, B2 for a device only A lists (Task 1's store, filled by the test): B1 and B2 fail `DEVICE_NOT_FOUND`, A1 is granted and served, and A1's result is A1's own.
  - With three calls queued for a device never hosted: three denies, each with `headOnly: true`, and three equal errors.
  - The two kinds of deny are equal as serialized messages, once the device's name is substituted.
  - A `CALL_TOKEN_INVALID` deny behaves as on master, and so does an access error (every queued call fails).
  - No deny names a session.
- [ ] **Steps 2–5:** run `npx mocha --exit test/sessions/16-pack-hops.js` (it fails: A1 fails with B1's deny), implement, run it and `node test/helpers/run-local.js test/composition/18-call-tokens.js` (they pass), commit.

**Size:** 0.5 day. **Needs:** Task 1.

### Task 4: the session check at every hop

**Files:**
- Modify: `lib/device-manager.js`: `sendInvokeActionMessageToWorker`, `queryDeviceForChild`, `invokeJobs`
- Modify: `lib/peer-channel-broker.js`: `handleRequest`, `handleAnnouncement`, `serveMatched`
- Modify: `lib/job-sessions.js` and `lib/sessions.js` `close` (an ended session's hidden packs, for its jobs)
- Test: `test/sessions/16-pack-hops.js` (server-free: the broker and the device manager with stand-in workers, as sessions 07 does)
- Test: `test/session-runtime/03-session-pack-hops-spawned.js` (a spawned runtime on `--sessionSocket`, two sessions through the test's shim; no port)
- Fixtures, written by the test into its home: a global pack `front` (a scenario with one tool, `relay`, and a role-less part `relay-core` that declares calls on `back`'s `echo` and on a module `ghost` that is never installed), and a pack `back` (a scenario whose `echo` counts its runs). `relay` returns the caught error's own fields as JSON.

**Interfaces:**
- Consumes: `callTokens` entries' `session` (B1), and `sessionPacks.listsDevice(session, deviceID)`.
- **The routed hop.** After `declaredTarget` and before the `deviceMap` lookup, a callee the token's session doesn't list takes the missing-device branch: the access check first, then `new CountinghouseError('DEVICE_NOT_FOUND')`, never `missingDeviceError`'s other states. It is asked again after the access check's round trip, where "the callee as it stands now" is read.
- **The device query** answers a device the session doesn't list as it answers one never hosted, after its access check.
- **The peer channel request.** A target the session doesn't list is treated as not hosted, before the `target.replacing` check: the access check, then a deny with `DEVICE_NOT_FOUND`, for that call only (Task 3b's `headOnly`).
- **The announcement and the match.** A channel already open is shared by every session, so the invoke is what's checked. `handleAnnouncement` refuses a target the announcing token's session doesn't list with `DEVICE_NOT_FOUND` (no ID), after `declaredTarget`. `serveMatched` asks again and refuses the callee's metering request, so no handler runs.
- **A job's run.** `invokeJobs` refuses a device its run's session doesn't list as a missing device, and the job is not retried.
- **An unloaded module.** In shared mode a hop to a module that was unloaded is answered `DEVICE_NOT_FOUND`, never `MODULE_UNLOADED`, for every session. Once a pack is unloaded its session set is gone, and the old answer would tell B that A's pack had been on.
- **An ended session's job** lists the global packs, minus the packs its session had turned off, and none of its this-session packs. `lib/sessions.js` `close` reads `sessionPacks.packsOffOf(id)` before it forgets the session, and `job-sessions.sessionEnded(id, limits, {packsOff})` keeps the set with the session's last caps, for as long as it keeps those (#251). `forRun` hands it back, and a run of an ended session asks `sessionPacks.listsDeviceFor({packsOff}, deviceID)`.

- [ ] **Step 1: Write the failing tests.**
  - Spawned, routed, then again with `--directPeerChannels`:
    - A's `relay` to `back` returns the echo.
    - B's `relay` to `back` and B's `relay` to `ghost` return the same error fields, equal as serialized text.
    - With direct channels, this holds before any channel exists and after A's call has opened one.
    - `back`'s run count, read by A, counts A's calls only, and there is no usage record for B's hop.
  - `back` global and turned off by B: the same four assertions.
  - `back` restarting (its worker killed): B gets `DEVICE_NOT_FOUND`, not `MODULE_RESTARTING` (review focus 2).
  - After A leaves and `back` is unloaded: B's `relay` to `back` still equals its `relay` to `ghost`.
  - Server-free:
    - a request for a hidden target that is `replacing` is denied `DEVICE_NOT_FOUND`, and the deny has `headOnly: true`, as a never-hosted target's has;
    - a device query for a hidden device equals one for a device never hosted;
    - an announcement on an open channel from B's token is refused and holds no bytes;
    - a match whose session left the pack since the announcement runs no handler.
  - A job A made: after A turns the pack off, its next run fails as a missing device, once. After A ends, a job of A's hops into no this-session pack of A's, and still not into a pack A had turned off.
  - No message posted to a worker in any of these names a session (the probe preload, `test/fixtures/session-probe-preload.js`).
- [ ] **Step 2:** Run `npx mocha --exit test/sessions/16-pack-hops.js`, then `node test/helpers/run-local.js test/session-runtime/03-session-pack-hops-spawned.js` under the suite lock. They fail: B's hop returns the echo.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both again, then one file at a time: `node test/helpers/run-local.js test/composition/18-call-tokens.js`, `…/test/composition/21-declared-calls-enforced.js`, `npx mocha --exit test/module-loading/32-hop-path-requires.js`, `npx mocha --exit test/sessions/04-job-sessions.js`. They pass.
- [ ] **Step 5:** Commit.

**Size:** 2.5 days (four hop paths, routed and direct, the restart states, jobs, and a spawned file with fixtures; B's estimate). **Needs:** Tasks 1 and 3b. Do it before or after Task 7, not beside it: both change `lib/peer-channel-broker.js`.

### Task 5: `list_changed` per session

**Files:**
- Modify: `lib/mcp/subscriptions.js` (`changed({session})`)
- Modify: `lib/route-manager.js` (`sessionPacks.onChange` → the hub)
- Test: `test/sessions/17-pack-list-changed.js` (server-free, on `createHub`)

**Interfaces:**
- `hub.changed({session = null} = {})`: with a session, the settle round lists again only that session's listeners; with none, everyone's, as today. Several calls within the settle window make one round, and one call with no session makes that round list everyone.
- `sessionPacks.onChange((session) => hub.changed({session}))`. A pack loaded or unloaded still reaches the hub through the device manager's `toolschanged`.
- The round lists tools only. M17 extends it to named lists (resources, prompts), each with its own fingerprint; Task 5 doesn't.
- A legacy session on a shared runtime is not sent `list_changed` unasked, as on master: `serverCapabilities` declares `listChanged` there only for a modern listen.

- [ ] **Step 1: Write the failing tests.**
  - A's override for a loaded pack goes on: A's listener gets one `list_changed` with its own subscription id, and B's gets none.
  - B turns a global pack off: only B's listener is told.
  - A pack loaded for A through the device manager's event: B is listed again and not told (its fingerprint is unchanged).
  - A session-only change lists once, for that session: `listTools` is called for A and not for B.
  - A global load tells both.
- [ ] **Steps 2–5:** run `npx mocha --exit test/sessions/17-pack-list-changed.js` (it fails), implement, run it and `npx mocha --exit test/mcp-contract/09-subscriptions.js` (they pass), commit under the suite lock.

**Size:** 0.5 day. **Needs:** Tasks 1 and 3.

### Task 6: ch-local's pack messages: who a load is for, and who is told

**Files:**
- Modify: `lib/route-manager.js` `startControlChannel`: the `load`, `reload` and `unload` handlers (`inPlace`'s notice is line 233 on master), the `notice` handler, and a `set` of `pack.<n>` to true
- Modify: `lib/settings-tool.js` `packUnloaded` (in shared mode, to Task 2's `dropPack`)
- Test: `test/sessions/18-pack-notices.js` (server-free), and one case added to Task 4's spawned file

**Interfaces** (the contract with ch-local is in "For C"; the reviewer ruled on both questions, 2026-11-15):
- **`load` and `reload` carry `pack: <n>` and `global: true | false`.** The runtime sets `sessionPacks.setGlobal(pack, global)` from the message and never infers it from who is waiting. So the terminal turning a pack on while A's `load-pack` is in flight arrives as one `load` with `global: true`, and a runtime restart can't turn A's pack into everyone's. In shared mode a `load` or `reload` about a pack without a boolean `global` is refused (`CONTROL_FAILED`); under `--stdio` the field is not read.
- **`set pack.<n> true`** is the one case with no load: the terminal turned on, for everyone, a pack already loaded for a session. It makes the pack global. **There is no `set pack.<n> false`:** it is refused as an unknown control set.
- **A terminal off always ends in `unload {pack}`, which does all of it,** in this order:
  1. the audience is taken: `sessionPacks.audienceOf(pack)`, the sessions that list it now;
  2. the unload runs (`packs-in-place.unloadPack`);
  3. `sessionPacks.packGone(pack)`: not global, its set empty;
  4. `sessionSettings.dropPack(name)`: every session's own "on" ends (the reviewer's earlier ruling: the operator's off is a tightening for all, and it clears loosenings, as a terminal tightening of a cap does, §3). A session's own "off" stays, so the pack stays hidden from it if the terminal turns it on again;
  5. each session of step 1's audience is told once, alone: the unload's `notice` text when it has one, else "the <n> tools were turned off". A session whose own "on" was dropped is told "your this-session pack <n> ended: it was turned off".

  The same handler serves the unload the runtime asked for itself (Task 8, the last session left: the audience is then empty) and one the ceiling caused.
- **A notice about a pack** (`load`'s, `reload`'s, and a `notice` message with `pack`) is added once for each session of `audienceOf(pack)`, with `{session, sessionOnly: true}`. A `notice` with no `pack` goes to everyone, as today.
- A session that wants a pack back after the terminal's off asks again, with a form (Task 8).

- [ ] **Step 1: Write the failing tests.**
  - `load {pack, global: false}` while A's `load-pack` waits: the pack isn't global. `load {pack, global: true}` while A's `load-pack` waits: it is global, and B lists it.
  - `load {pack, global: false}` with no session waiting (a restart's reload): not global, and no session lists it.
  - In shared mode a `load` about a pack with no `global` is refused and loads nothing.
  - For each of `load` with a notice, `reload` with a notice and `notice` with `pack`, about A's this-session pack: A's queue gets the text once and B's stays empty. About a global pack B turned off: A is told and B isn't.
  - `unload` of a global pack with A's own "on", B's own "off" and C with no override: A and C are each told once, and B isn't; A's override is gone and B's "off" is still stored; no session lists the pack; A's and C's listeners get `list_changed` (Task 5), and B's doesn't.
  - Then `load {global: true}` again: A and C list it by the global value, B still doesn't.
  - `unload` of a pack only A and B had on: both are told, both overrides are gone.
  - `set pack.ci true` makes a pack that only A listed listed to B, and tells B's listener. `set pack.ci false` is refused and changes nothing.
  - Under `--stdio` the handlers behave as on master: the expected notices and replies are written out in the test.
- [ ] **Steps 2–5:** run `npx mocha --exit test/sessions/18-pack-notices.js` (it fails), implement, run it, `npx mocha --exit test/sessions/08-notices.js` and `npx mocha --exit test/stdio/12-control-channel-unit.js` (they pass), commit.

**Size:** 0.5 day. **Needs:** Tasks 1, 2 and 5.

### Task 7: a hop's held input is shared out per session

**Files:**
- Modify: `lib/peer-channel-broker.js`: the shares in `handleAnnouncement` and `forgetAnnounced`; `releaseEnded`, `mayReleaseAll` and `mayReleaseOwn`
- Modify: `lib/session-settings.js` (`largest(name)`)
- Test: `test/sessions/19-held-input-shares.js` (server-free), plus composition 18

**Interfaces:**
- **On master (after #294)** a caller worker has three things of its own: a share of the held bytes (`announcedByWorker`: two hops at the cap, at least 16 MiB), a share of the held count (`announcedCountByWorker`, `ANNOUNCED_PER_WORKER_MAX`, 256), and `mayReleaseOwn`'s idle hold-off. On a shared runtime one worker serves every session, so one session's unmatched announcements, by bytes or by count, refuse another's direct hops.
- **In shared mode all three are keyed by the announcing token's session,** across caller workers. An entry with no session keeps its worker's. The per-worker shares and hold-off are not applied to an entry that has a session.
  - bytes: `max(16 MiB, 2 × callLimits.of(tokenEntry).maxOutputBytes)`, that session's own cap;
  - count: `ANNOUNCED_PER_WORKER_MAX`, per session;
  - `mayReleaseOwn` and `mayReleaseAll`: each session's own bound.
- The total becomes `max(128 MiB, 8 × the largest active cap)`, where the largest active cap is the greater of the default and `sessionSettings.largest('maxOutputBytes')`. This is §3's table row for the held-byte shares, which B2's plan didn't carry.
- `sessionSettings.largest(name)` returns a number kept up to date on every change of an override (`set`, `clear`, `ceilingSeen`, `dropLooser`, `forget`). It is never a scan of the sessions at an announcement.
- `releaseEnded` takes the share's key, so a full share releases its own session's ended hops.
- Outside shared mode the keys are the caller worker and the sizes are as on master.
- The two byte floors (16 MiB and 128 MiB) and the count share are the broker's constructor options, so the test holds kilobytes and a handful of entries. It allocates no input near the real sizes.

- [ ] **Step 1: Write the failing tests.**
  - Session A fills its byte share from worker W. A's next announcement is `RATE_LIMITED`, and B's from the same W is accepted.
  - Session A reaches its count share from W with small inputs. A's next is refused, and B's from W is accepted (#294's share, per session).
  - A's announcements from two caller workers count against one share, bytes and count.
  - A's share follows A's own cap: with A's cap four times B's, A holds two inputs at its cap, and B holds two at its own and is refused its third.
  - The total follows the largest active cap: with A's cap raised, an input over the floor total is held, and it is refused once A's override is dropped. `largest` is right after each of the five changes, with no session scanned at an announcement (a counter on the store's iteration stays at zero).
  - An ended call's bytes and count leave its session's share at the next refusal. A's hold-off doesn't delay B's release.
  - With `shared()` false, the per-worker numbers of composition 18 hold, written out in the test.
- [ ] **Steps 2–5:** run `npx mocha --exit test/sessions/19-held-input-shares.js` (it fails), implement, run it and `node test/helpers/run-local.js test/composition/18-call-tokens.js` (they pass), commit.

**Size:** 1.5 days. **Needs:** nothing in this plan.

### Task 8: packs turned on and off in conversation (the guard lifted)

This is the task that makes session sets reachable in production. Until it merges, only tests fill them.

**Files:**
- Modify: `lib/settings-tool.js`: `setForSession`, `formForSession` and `confirmForSession` take `pack.<n>`; `FORM_TEXT.*.session.pack` in `en` and `zh`; `get`'s `pack.<n>` rows show the session's value
- Modify: `lib/mcp/gateway.js`: `sessionMaySet` is the two caps or a `pack.<n>` name
- Modify: `lib/session-packs.js`: one chain per pack (`onPack(pack, fn)`), `loadFor(session, pack, version, {ask})`, and the `onEmpty` listener that asks the unload
- Modify: `lib/sessions.js` `close`: `sessionPacks.forget(id)`
- Test: `test/sessions/22-pack-settings.js` (server-free, a stand-in for the control channel's `ask`; 20 and 21 are B5's), and cases added to `test/session-runtime/01-spawned.js`, where the test answers `load-pack` as ch-local's daemon does

**Interfaces:**
- **Membership is never set here.** Turning a pack on or off is `sessionSettings.set` (or the override going); Task 1's store hears it and moves the session. So a `set` that throws leaves nothing behind.
- **Off** (the session's value is on): a tightening, so no form. The override becomes `false`. The session's calls in flight finish; their next hop into the pack is refused (Task 4).
- **On** (the session's value is off: a pack it hid, or one the terminal's off ended, included): a loosening, so the session's form, whose text names the pack, its version from `packs.json` and "for this session".
  - The MAC is as on master: it covers the nonce, the session, the name and the value (`macOf`). The version is not in it. It is held in the staged change, server-side and single, and read from there at the accept, which is as strong. Putting it in the MAC would move bytes that M12 (#295) pins in stdio 19.
- **On accept,** on the pack's chain:
  1. the ceiling is checked;
  2. a pack already loaded is taken only if its loaded version is the staged one; otherwise `SETTING_NOT_APPLIED`;
  3. a pack not loaded is loaded once: `{type: 'load-pack', name, version}`, 45 s. A second session confirming meanwhile waits on the same request. On a refusal or no answer nothing is kept, with today's undo for `CONTROL_NO_ANSWER`;
  4. **after the wait, everything is checked again, with no wait between the check and the override** (#296 and #300 found each of these): the session is live; no lock or latch fell on it meanwhile (`settings-confirm.lockChangesOf`, #300); the ceiling still allows the pack; the session's own override for the pack is what it was before the wait; the loaded version is the staged one;
  5. then `sessionSettings.set(session, 'pack.<n>', true, {loosening: true, version})`.

  If step 4 or 5 fails, nothing is applied, the history says why, and the pack is unloaded if that leaves its set empty and it isn't global.
- **The unload.** `sessionPacks.onEmpty(pack)` puts `{type: 'unload-pack', name}` on the pack's chain. On the chain it first looks again: a session that joined meanwhile, or a pack made global, cancels it. So no unload is asked under a session that has just joined.
- An `unload-pack` that fails is logged; the pack stays loaded and listed to no one. Once the daemon is gone (the runtime's stop: `Registry.close()` ends every session only on that path), no `unload-pack` is asked.
- A refusal caused by another pack (`PART_VERSION_CONFLICT`, a tool name taken) is answered `SETTING_NOT_APPLIED` with one fixed problem text when the asker doesn't list that pack.
- Each change writes one history line, `{at, by, setting, old, new, change: 'this session', session}`, counts toward `MAX_SESSION_CHANGES`, and is told to that session alone (`notices.add(module, text, {session, sessionOnly: true})`).
- Decline locks, forms left and the per-user window use the kind `pack`, as B2's Task 5 built them.

- [ ] **Step 1: Write the failing tests.**
  - A turns `pack.ci` on: a form saying "for this session" in both languages. After the accept: exactly one `load-pack`; A lists the tool and B doesn't; `settings.json`'s bytes and mtime are unchanged; the history line has A's id; B's `get` shows the pack off and no line of A's.
  - The `requestState`'s MAC for a pack equals the one master's `macOf` gives for the same nonce, session, name and value. A retry whose pack is now installed at another version is refused from the staged change.
  - B turns it on too: its own form, no second `load-pack`, and both list it.
  - A ends: no `unload-pack`. B turns it off: one `unload-pack`, and no form.
  - B turns a global pack off: no form, hidden from B, A unchanged, no `unload-pack`, the file unchanged. B turning it on again needs a form; a decline keeps it hidden and counts in the window.
  - A and B accept within one load: one `load-pack`; a failure leaves neither with it.
  - A's override goes off while B's accept is in flight: B ends up listing a loaded pack, and no unload was asked.
  - During A's load, each in its own case: A ends; A's client sends a frame that says no; a lock falls on the kind `pack` for A; the ceiling stops allowing the pack; A's own override for the pack changes. Each time nothing is applied, A doesn't list the pack, the history line says which, and one `unload-pack` follows the load.
  - `sessionSettings.set` throwing at step 5 (A already has 64 overrides) leaves A in no set, and the pack is unloaded.
  - A taking a pack loaded at another version is refused, and the text names no session.
  - A load refused over a pack A doesn't list has the fixed text.
  - After the terminal's off (Task 6's `unload`), A's next `set pack.ci on` gets a form, not a "no change".
  - After the daemon has gone, a set that empties asks no `unload-pack`.
  - `locale`, `moduleSandbox` and `scope: 'all-sessions'` with a pack stay refused, with the file unchanged.
  - A session whose `askConditions` isn't `ok` and `yes`, or that is latched, gets no form.
- [ ] **Step 2:** Run `npx mocha --exit test/sessions/22-pack-settings.js`; it fails with `SETTING_TERMINAL_ONLY_SHARED`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it; then one at a time `npx mocha --exit test/sessions/09-tightenings.js`, `…/10-confirmations.js`, `…/test/stdio/14-settings-tool.js`, `…/test/stdio/19-settings-confirm.js` (M12's pinned bytes), `…/test/stdio/20-settings-elicitation.js`, and `node test/helpers/run-local.js test/session-runtime/01-spawned.js` under the suite lock. They pass.
- [ ] **Step 5:** Commit.

**Size:** 2.5 days (the settings tool, the races, two languages and spawned cases; B's estimate). **Needs:** Tasks 1–6, B5's Task 1, and #300 on master (`lockChangesOf`).

### Task 9: a restored session's packs

**Files:**
- Modify: #300's restore (`restoreInto`, B2's Task 6): a restored `pack.<n>` "on" goes through its loosening path
- Modify: `lib/session-packs.js`: Task 8's `loadFor`, used by that path
- Test: cases added to B2's `test/sessions/11-session-state.js`

**Interfaces:**
- **A restored pack "on" is a loosening, and is restored as #300 restores a cap loosening:** only when the session's client says `ok` and `yes` now (§11 answer 4: may-elicit is checked again), and with the re-check after the waits. There is no separate `adopt` that could skip the client.
- On that path, for a pack: the version must be the one loaded, or the one a `load-pack` loads (`loadFor`); the ceiling must allow the pack; and after every wait Task 8's step 4 is run again before `sessionSettings.set`.
- Anything else drops the override. The session is told with #300's text, "your this-session change of pack.<n> was reset after a runtime restart", and "ask again" is added only for a session that can ask: it has a form left and the kind `pack` isn't locked for it.
- A restored "off" needs no check: it is applied as stored.
- The daemon doesn't load a this-session pack again at a restart ("For C"): this path's `load-pack` does, once the session has resumed and passed.

- [ ] **Step 1: Write the failing tests.**
  - A restored "on" at the loaded version, with the client saying `ok` and `yes`: the pack is listed to that session only.
  - The same with the client saying no, saying nothing, or `failed`: dropped, and told with #300's text.
  - One at another version, or under a ceiling that no longer allows the pack: dropped and told.
  - The client says no while the `load-pack` waits: dropped, and the pack is unloaded.
  - "ask again" is in the text for a session with a form left, and not for one whose kind `pack` is locked.
  - A restored "off" hides a global pack.
  - A row for a session that never resumes takes no pack and asks no load.
- [ ] **Steps 2–5:** run `npx mocha --exit test/sessions/11-session-state.js` (it fails), implement, run it (it passes), commit.

**Size:** 0.5 day. **Needs:** Task 8, and #300.

## Sizes and order

Sizes are implementer B's, from the review (#298).

| Task | Days | Needs |
|---|---|---|
| 1. `lib/session-packs.js` | 1 | – |
| 2. Pack overrides under the ceiling | 0.5 | 1 |
| 3. `tools/list` and `tools/call` | 1 | 1 |
| 3b. A peer-channel deny for one call only | 0.5 | 1 |
| 4. The session check at every hop | 2.5 | 1, 3b |
| 5. `list_changed` per session | 0.5 | 1, 3 |
| 6. ch-local's pack messages | 0.5 | 1, 2, 5, "For C" |
| 7. Held hop input per session | 1.5 | – |
| 8. Packs in conversation, the guard lifted | 2.5 | 1–6, B5's Task 1, #300 |
| 9. A restored session's packs | 0.5 | 8, #300 |
| **Total** | **11** | |

- **Build order** (B's, one implementer, interleaved with M13; the B5 tasks are the plan beside this one):
  1. B5 Tasks 0 and 1;
  2. B3 Tasks 1, 2 and 3;
  3. B5 Tasks 2 and 4;
  4. B3 Tasks 3b, 4 and 7;
  5. B3 Tasks 5 and 6;
  6. B5 Task 3;
  7. B3 Tasks 8 and 9.
- **What could run beside what,** with a second implementer: Task 7 beside anything but Tasks 3b and 4 (all three change `lib/peer-channel-broker.js`); Tasks 3 and 3b beside each other after Task 1; all of B5 beside Tasks 1–7.
- Each task is its own PR. A PR that touches a hop, the gateway's lookup or the settings tool is a trust-boundary PR.

## For C

The contract with ch-local's daemon that Tasks 6, 8 and 9 build on. The reviewer ruled on the first two (2026-11-15). On ch-local's main (e916acd) the applier's `loadPack` tells its notice with no pack, and its text says "for this start".

1. **`load` and `reload` carry `pack: <n>` and `global: true | false`.** `global` is true when the terminal's settings have the pack on for everyone, false when the daemon loads it only because a session asked (`load-pack`). The runtime never infers it. A terminal "on" that arrives while a session's `load-pack` is in flight is one `load` with `global: true`.
2. **There is no `set pack.<n> false`.** A terminal off always ends in `unload {pack}`, also when sessions have the pack on: the runtime ends every session's own "on" and tells each session that listed the pack. Only `{type: 'set', name: 'pack.<n>', value: true}` remains, for the terminal turning on, for everyone, a pack that is already loaded for a session (no load follows).
3. **`unload` and a `notice` about a pack carry `pack: <n>`,** so the runtime can tell the sessions that list it and no others. A `notice` with no `pack` is told to every session.
4. **The daemon answers `load-pack {name, version}` and `unload-pack {name}`** as ch-local start does. It need tell no notice for a `load-pack` it answers: the runtime tells the asking session itself. If it does tell one, the text says "for this session", not "for this start".
5. **At a runtime restart the daemon starts the runtime with the global packs only.** It doesn't load a this-session pack again: the runtime asks `load-pack` once the session has resumed and its restored "on" has passed its checks (Task 9).
6. The runtime asks no `unload-pack` once the daemon is gone.

## What M17 builds on

M17 (`docs/superpowers/specs/2026-11-15-mcp-completeness-design.md`, section 10) lists resources and prompts per session. It calls:

- `sessionPacks.listsDevice(sessionId, deviceID)` and `sessionPacks.listsModule(sessionId, moduleName)`: the one question for a resource, a template or a prompt of a module. `resources/read` of `countinghouse://m/<module>/…` and `prompts/get` ask it before anything else, and answer a module the session doesn't list as their own unknown.
- `toolRegistry.filterTargetsBySession(targets, sessionId)`: it filters any map whose values carry a `deviceID`, so the three new lists reuse it after their own global, cached tables. A cursor is then a position in the filtered list.
- `sessionIdOf(opts)` in the gateway, exported for the new handlers.
- `hub.changed({session})` and `sessionPacks.onChange`. Task 5's round lists tools only. M17 extends the hub to take more than one named list function, each with its own fingerprint per listener; the per-session trigger is then the same call.
- A read in a per-session module's worker (§4a) is R1's, not B3's.

## Decided, and what is left open

- **Decided (the reviewer, 2026-11-15): a terminal `pack off` ends every session's own "on",** as a terminal tightening of a cap drops looser overrides (§3). It arrives as `unload`, which does all of it (Task 6). §4's "unloaded once that set is empty and the global settings don't list it" then describes a pack no terminal turned off: a this-session pack whose sessions have left. The spec's §4 should say so.
- **Decided: `global` is on the daemon's message, and there is no `set pack.<n> false`** ("For C").
- **Decided, a residual accepted: a load refused because of another session's pack** tells the asker that something else is loaded. The fixed text hides which pack, and the sessions are one user's. It goes into `docs/security-model.md` with section 9's residuals (C6).
- **Decided: a deny fails only the denied session's queued calls** (Task 3b).
- **Decided: membership follows the stored override** (Task 1), from B's review.
- **Open: an ended session's job and the packs its session turned off.** §2's rule ("never its tightenings") is written for the caps. Task 4 applies it to packs as well.
- **Residual:** a hop into a pack the session doesn't list and a hop to a device never hosted may differ in time, since a channel may already be open. The module sees the same error either way.
