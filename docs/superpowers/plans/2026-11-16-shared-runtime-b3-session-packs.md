# Shared runtime B3: per-session packs. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** draft for the reviewer; no code until it is reviewed. It builds on B1 and on B2 Tasks 1–5, all on master (read at 11c57088). Task 6 needs C's agreement on one field of ch-local's control messages. Task 8 must not merge before B5's Task 1 (the usage report per session). Task 9 needs B2's Task 6, which is not on master yet.

**Goal:** In shared mode a pack turned on in conversation is loaded once and listed only to the sessions that turned it on. A pack turned off in conversation is hidden from that session only. A tool, a hop's callee or a device that a session doesn't list is answered exactly as an unknown one, byte for byte. `tools/list` and `list_changed` are per session. The session is checked at every hop, routed and over a direct peer channel. The input a hop holds on the main thread is shared out per session.

**Architecture:**
- A new main-thread `lib/session-packs.js` holds, per pack, whether it is global and the set of sessions that turned it on. It answers "does this session list this pack, this module, this device" from memory.
- The override itself stays in `lib/session-settings.js`, which already takes `pack.<n>` with a version. Its `globalPack` is `() => null` on master; B3 wires it.
- The listing is filtered after #274's global tool table (`lib/mcp/tool-registry.js` `buildToolTargets`), on a copy. `tools/call` looks its target up in the global table and then asks the same question.
- A hop asks it on the main thread from its call token's session: in `lib/device-manager.js` (the routed hop, the device query, a job's run) and in `lib/peer-channel-broker.js` (the channel request, the announcement, the match).
- In shared mode the settings tool takes `pack.<n>` as the session's override. Turning one on needs the session's form; the pack is loaded through ch-local's daemon only when it isn't loaded already.
- ch-local's notices about a pack go to the pack's audience: every session for a global pack, its session set otherwise.

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

1. **A hop from B's call into a pack only A turned on.** It is reachable: `closureOf` (`lib/module-roles.js`) doesn't walk through a module with no role, so a role-less part of a pack B lists can declare a call into A's pack. It is also reachable over a peer channel already open (a channel is per worker pair, and one worker serves every session), from a job's run, and from a device query. Each must answer as a device never hosted, run no handler and bill nothing (Task 4).
2. **Answers that say "it exists".** Three checks come before any session check on master: `target.unlisted` in `handleToolsCall` (`MODULE_NOT_LISTED`), `target.replacing` in the broker's `handleRequest` (`MODULE_RELOADING`), and the supervisor's state in `missingDeviceError` (`MODULE_RESTARTING`). The session check goes before each (Tasks 3 and 4).
3. **A stale view.** The per-session answer is cached. It must be dropped on: a session's override changing, `ceilingSeen` dropping one, a pack loaded, reloaded (a reload can add a part) or unloaded, a session joining or leaving a set, and a session's end. A stale entry is either a leak or a tool that wrongly vanishes (Tasks 1 and 2).
4. **B told about A's pack some other way.** On master the daemon's `load` notice is added for every session (`lib/route-manager.js:233`). The others: a `notice` with no module, a `list_changed` to B when only A's list changed, a load refused "already the tool of <A's pack>", a `get` row, and a usage report row naming A's tool, which is why Task 8 waits for B5's Task 1 (Tasks 5, 6 and 8).
5. **The session set under races.** Two sessions confirming one pack while it loads (one load, both in or neither); the last session leaving while another's confirmation is in flight (no unload under a session that just joined); a session ending mid-load; ch-local unloading a pack sessions are in; an unload that fails; a pack turned on under a ceiling that then stops allowing it, which `ceilingSeen` must drop for good (Tasks 2 and 8).

---

### Task 1: which packs a session lists (`lib/session-packs.js`)

**Files:**
- Create: `lib/session-packs.js`
- Test: `test/sessions/13-session-packs.js` (server-free)

**Interfaces:**
- Consumes, through `configure({records, moduleOf, overrideOf, shared, allows})`:
  - `records()` → the pack records (`packsOf(mm)`: scenario name → `{scenario, modules: Map}`) and each one's pack name;
  - `moduleOf(deviceID)` → the name of the module that hosts the device, or that last hosted it (`deviceMap[id].hostModuleName`, else the supervisor's or the ended-state record's module name), or null;
  - `overrideOf(session, pack)` → true, false or undefined, from `lib/session-settings.js`;
  - `shared()` → `lib/sessions.js` `shared()`.
- Produces:
  - `setGlobal(pack, on)` and `isGlobal(pack)`;
  - `join(session, pack)`, `leave(session, pack)` → `{empty}` (no session left and not global), and `forget(session)` → the packs it left empty;
  - `lists(session, pack)` → boolean. With an override: false for off; for on, true only while the session is in the pack's set. Without one: `isGlobal(pack)`. A session of null, or one that has ended, lists the global packs only;
  - `listsModule(session, moduleName)` and `listsDevice(session, deviceID)` → boolean (the rule in Global constraints). A device whose module is not known is listed: it is no pack's;
  - `none()` → true while no pack has a session set and no session has a pack override;
  - `audienceOf(pack)` → null (every session) or a Set of session ids (a copy);
  - `packChanged(pack)`, called by the load, reload and unload handlers, and `packGone(pack)` → the ids that were in its set;
  - `onChange(fn)`, called with a session id, or null when every session's view may have changed.
- Outside shared mode `lists`, `listsModule` and `listsDevice` return true and `none()` true, whatever was configured.

- [ ] **Step 1: Write the failing tests** (`describe('sessions 13: which packs a session lists')`).
  - A joined, B not: A lists the pack, its scenario and its part; B lists none of the three.
  - A part owned by A's pack and by a global pack is listed to B.
  - An off override hides a global pack from that session only.
  - An on override without membership of the set lists nothing.
  - A module no pack owns is listed to both, and so is a device whose module isn't known.
  - A session of null and an ended session list only the global packs.
  - `leave` answers `{empty: true}` only for the last session of a pack that isn't global. `forget` returns the packs it emptied.
  - The cached view is dropped by each of review focus 3's events. After a reload adds a part, B doesn't list the new part.
  - `none()` is true before any join and false after one.
  - With `shared()` false every question answers true.
  - `audienceOf` is null for a global pack, and A's set for A's pack.
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
- `ceilingSeen(c)` also drops every stored `pack.<n>` override whose value is true and that `c` no longer allows (an allowlist that leaves the pack out, conversation off, or a ceiling that can't be trusted). It calls `onChange` for each session, and returns nothing new. Today it clamps cap loosenings only, and `effective` hides a disallowed pack at read time while the store keeps `true`, so a ceiling lowered and raised again would bring the pack back with no new confirmation.
- `dropPack(name)` → the ids whose override (on or off) was dropped: ch-local unloaded the pack.
- `packsOf(id)` → `[{name, value, version}]`, for Task 1's `overrideOf` and for B2 Task 6's export.

- [ ] **Step 1: Write the failing tests.**
  - A has `pack.ci` on under a ceiling that allows it. A ceiling seen without `ci` drops A's override and calls `onChange(A)`.
  - The ceiling raised again: A's effective value stays the global one (the reviewer's note).
  - An off override is never dropped by a ceiling.
  - A ceiling that is stale (undefined) drops nothing.
  - `dropPack` drops on and off overrides of that pack only.
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
- `handleToolsList(req, cdifInterface, appKey, callback, opts)` reads the session with `sessionIdOf(opts)`, as `handleToolsCall` does. The subscriptions hub already lists with `{session: s}` (`lib/route-manager.js:76`), so its fingerprints become per session with no change there.
- In `handleToolsCall`, after `buildToolTargets(…, {includeUnlisted: true})[name]` and **before** the `target.unlisted` check: a target whose device the session doesn't list is treated as `target == null`, so the existing line answers `unknown tool: <name>`. A task-augmented call takes the same lookup.

- [ ] **Step 1: Write the failing tests.**
  - A's `tools/list` has the pack's tool and B's doesn't. Nothing else in B's list differs from its list before the pack was loaded, compared as serialized text.
  - B's `tools/call` of the tool, then the pack unloaded, then the same request again: the two responses are equal as serialized text.
  - B calling the pack's unlisted part by name gets `unknown tool`, and A gets `MODULE_NOT_LISTED` as today (review focus 2).
  - B's legacy `params.task` call of the tool gets `unknown tool`, and no job is added.
  - A global pack B turned off: gone from B's list and unknown to B's call; A's list and call unchanged.
  - `buildToolTargets(cdif)` returns the identical frozen object before and after both sessions list, and `filterTargetsBySession` returns its input while `none()` is true.
  - With `shared()` false, `handleToolsList` answers as on master (deep-equal).
- [ ] **Step 2:** Run `npx mocha --exit test/sessions/15-pack-listing.js`; it fails (B's list has the tool).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it, then `npx mocha --exit test/module-loading/30-call-path-caches.js` and `npx mocha --exit test/module-loading/31-require-once.js`; they pass.
- [ ] **Step 5:** Commit, holding the suite lock (the pre-commit hook runs the `tools/list` golden, which must not move).

**Size:** 1 day. **Needs:** Task 1.

### Task 4: the session check at every hop

**Files:**
- Modify: `lib/device-manager.js`: `sendInvokeActionMessageToWorker`, `queryDeviceForChild`, `invokeJobs`
- Modify: `lib/peer-channel-broker.js`: `handleRequest`, `handleAnnouncement`, `serveMatched`
- Modify: `lib/peer-worker.js`: `onPeerChannelDeny`
- Modify: `lib/job-sessions.js` and `lib/sessions.js` `close` (an ended session's hidden packs, for its jobs)
- Test: `test/sessions/16-pack-hops.js` (server-free: the broker and the device manager with stand-in workers, as sessions 07 does)
- Test: `test/session-runtime/03-session-pack-hops-spawned.js` (a spawned runtime on `--sessionSocket`, two sessions through the test's shim; no port)
- Fixtures, written by the test into its home: a global pack `front` (a scenario with one tool, `relay`, and a role-less part `relay-core` that declares calls on `back`'s `echo` and on a module `ghost` that is never installed), and a pack `back` (a scenario whose `echo` counts its runs). `relay` returns the caught error's own fields as JSON.

**Interfaces:**
- Consumes: `callTokens` entries' `session` (B1), and `sessionPacks.listsDevice(session, deviceID)`.
- **The routed hop.** After `declaredTarget` and before the `deviceMap` lookup, a callee the token's session doesn't list takes the missing-device branch: the access check first, then `new CountinghouseError('DEVICE_NOT_FOUND')`, never `missingDeviceError`'s other states. It is asked again after the access check's round trip, where "the callee as it stands now" is read.
- **The device query** answers a device the session doesn't list as it answers one never hosted, after its access check.
- **The peer channel request.** A target the session doesn't list is treated as not hosted, before the `target.replacing` check: the access check, then a deny with `DEVICE_NOT_FOUND`.
- **Every `DEVICE_NOT_FOUND` deny is for the head call only,** hidden or not: the deny carries `headOnly: true`, and `onPeerChannelDeny` fails the first queued call and asks again with the next one's token, as it does today for `CALL_TOKEN_INVALID`. Today a deny fails every call queued for that device, and the queue holds calls of several sessions, so B's deny would fail A's call. The flag is on both kinds of deny, so the worker's message is the same bytes either way.
- **The announcement and the match.** A channel already open is shared by every session, so the invoke is what's checked. `handleAnnouncement` refuses a target the announcing token's session doesn't list with `DEVICE_NOT_FOUND` (no ID), after `declaredTarget`. `serveMatched` asks again and refuses the callee's metering request, so no handler runs.
- **A job's run.** `invokeJobs` refuses a device its run's session doesn't list as a missing device, and the job is not retried.
- **An unloaded module.** In shared mode a hop to a module that was unloaded is answered `DEVICE_NOT_FOUND`, never `MODULE_UNLOADED`, for every session. Once a pack is unloaded its session set is gone, and the old answer would tell B that A's pack had been on.
- **An ended session's job** lists the global packs, minus the packs its session had turned off, and none of its this-session packs. `job-sessions.sessionEnded(id, limits, {packsOff})` keeps the set with the session's last caps, for as long as it keeps those (#251).

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
    - with B's and A's calls queued for one device, B's deny fails B's call only and A's is granted;
    - a device query for a hidden device equals one for a device never hosted;
    - an announcement on an open channel from B's token is refused and holds no bytes;
    - a match whose session left the pack since the announcement runs no handler.
  - A job A made: after A turns the pack off, its next run fails as a missing device, once. After A ends, a job of A's hops into no this-session pack of A's, and still not into a pack A had turned off.
  - No message posted to a worker in any of these names a session (the probe preload, `test/fixtures/session-probe-preload.js`).
- [ ] **Step 2:** Run `npx mocha --exit test/sessions/16-pack-hops.js`, then `node test/helpers/run-local.js test/session-runtime/03-session-pack-hops-spawned.js` under the suite lock. They fail: B's hop returns the echo.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both again, then one file at a time: `node test/helpers/run-local.js test/composition/18-call-tokens.js`, `…/test/composition/21-declared-calls-enforced.js`, `npx mocha --exit test/module-loading/32-hop-path-requires.js`, `npx mocha --exit test/sessions/04-job-sessions.js`. They pass.
- [ ] **Step 5:** Commit.

**Size:** 2 days. **Needs:** Task 1. Do it before or after Task 7, not beside it: both change `lib/peer-channel-broker.js`.

### Task 5: `list_changed` per session

**Files:**
- Modify: `lib/mcp/subscriptions.js` (`changed({session})`)
- Modify: `lib/route-manager.js` (`sessionPacks.onChange` → the hub)
- Test: `test/sessions/17-pack-list-changed.js` (server-free, on `createHub`)

**Interfaces:**
- `hub.changed({session = null} = {})`: with a session, the settle round lists again only that session's listeners; with none, everyone's, as today. Several calls within the settle window make one round, and one call with no session makes that round list everyone.
- `sessionPacks.onChange((session) => hub.changed({session}))`. A pack loaded or unloaded still reaches the hub through the device manager's `toolschanged`.
- A legacy session on a shared runtime is not sent `list_changed` unasked, as on master: `serverCapabilities` declares `listChanged` there only for a modern listen.

- [ ] **Step 1: Write the failing tests.**
  - A joins a loaded pack: A's listener gets one `list_changed` with its own subscription id, and B's gets none.
  - B turns a global pack off: only B's listener is told.
  - A pack loaded for A through the device manager's event: B is listed again and not told (its fingerprint is unchanged).
  - A session-only change lists once, for that session: `listTools` is called for A and not for B.
  - A global load tells both.
- [ ] **Steps 2–5:** run `npx mocha --exit test/sessions/17-pack-list-changed.js` (it fails), implement, run it and `npx mocha --exit test/mcp-contract/09-subscriptions.js` (they pass), commit under the suite lock.

**Size:** 0.5 day. **Needs:** Tasks 1 and 3.

### Task 6: ch-local's pack notices go to the pack's audience

**Files:**
- Modify: `lib/route-manager.js` `startControlChannel`: `inPlace`'s notice (line 233 on master), the `notice` handler, the `unload` handler, and a `set` of `pack.<n>`
- Modify: `lib/settings-tool.js` `packUnloaded` (in shared mode, to Task 2's `dropPack`)
- Test: `test/sessions/18-pack-notices.js` (server-free), and one case added to Task 4's spawned file

**Interfaces:**
- Consumes from ch-local, to be agreed with C: every `load`, `reload`, `unload` and `notice` message about a pack carries `pack: <n>`; and `{type: 'set', name: 'pack.<n>', value}` when the terminal turns a pack on or off for everyone. On ch-local's main (e916acd) the applier's `loadPack` tells its notice with no pack, and its text says "for this start".
- A notice with a `pack` is added once for each session of `sessionPacks.audienceOf(pack)`, with `{session, sessionOnly: true}`, or for everyone when the audience is null. A notice with no `pack` goes to everyone, as today.
- `load` for a pack with no session waiting on it (Task 8's in-flight map), and `set pack.<n> true`, make it global; `set pack.<n> false` makes it not global. `unload` calls `sessionPacks.packGone` and `sessionSettings.dropPack`, and tells each session that had it on: "the <n> tools were turned off".

- [ ] **Step 1: Write the failing tests.**
  - For each of `load` with a notice, `reload` with a notice, `unload` with a notice, and `notice` with a null module, about A's this-session pack: A's queue gets the text once and B's stays empty.
  - The same four about a global pack reach both.
  - `unload` of a pack A and B are in: both are told, both overrides are gone, and neither lists it.
  - `set pack.ci true` makes a pack that only A listed listed to B, and tells B's listener (through Task 5).
  - Under `--stdio` the handlers behave as on master.
- [ ] **Steps 2–5:** run `npx mocha --exit test/sessions/18-pack-notices.js` (it fails), implement, run it, `npx mocha --exit test/sessions/08-notices.js` and `npx mocha --exit test/stdio/12-control-channel-unit.js` (they pass), commit.

**Size:** 0.5 day. **Needs:** Tasks 1 and 2, and C's yes on the `pack` field.

### Task 7: a hop's held input is shared out per session

**Files:**
- Modify: `lib/peer-channel-broker.js` (the shares in `handleAnnouncement`, `forgetAnnounced`, `releaseEnded`, `mayReleaseAll`)
- Modify: `lib/session-settings.js` (`largest(name)`)
- Test: `test/sessions/19-held-input-shares.js` (server-free), plus composition 18

**Interfaces:**
- Today the share is per caller worker (`announcedByWorker`: two hops at the cap, at least 16 MiB). On a shared runtime one worker serves every session, so one session's unmatched announcements can refuse another's direct hops.
- In shared mode the share's key is the announcing token's session, across caller workers, and its size is `max(16 MiB, 2 × callLimits.of(tokenEntry).maxOutputBytes)`: that session's own cap. An entry with no session keeps its worker's share. The per-worker share is not applied to an entry that has a session.
- The total becomes `max(128 MiB, 8 × the largest active cap)`, where the largest active cap is the greater of the default and `sessionSettings.largest('maxOutputBytes')`. This is §3's table row for the held-byte shares, which B2's plan didn't carry.
- `releaseEnded` and `mayReleaseAll` take the share's key, so a full share releases its own session's ended hops, and the release-all bound is each session's own.
- Outside shared mode the key is the caller worker and the sizes are as on master.
- The two floors (16 MiB and 128 MiB) are the broker's constructor options, so the test holds kilobytes. It allocates no input near the real sizes.

- [ ] **Step 1: Write the failing tests.**
  - Session A fills its share from worker W. A's next announcement is `RATE_LIMITED`, and B's from the same W is accepted.
  - A's announcements from two caller workers count against one share.
  - A's share follows A's own cap: with A's cap four times B's, A holds two inputs at its cap, and B holds two at its own and is refused its third.
  - The total follows the largest active cap: with A's cap raised, an input over the floor total is held, and it is refused once A's override is dropped.
  - An ended call's bytes leave its session's share at the next refusal.
  - With `shared()` false, the per-worker numbers of composition 18 hold.
- [ ] **Steps 2–5:** run `npx mocha --exit test/sessions/19-held-input-shares.js` (it fails), implement, run it and `node test/helpers/run-local.js test/composition/18-call-tokens.js` (they pass), commit.

**Size:** 1 day. **Needs:** nothing in this plan.

### Task 8: packs turned on and off in conversation (the guard lifted)

This is the task that makes session sets reachable in production. Until it merges, only tests fill them.

**Files:**
- Modify: `lib/settings-tool.js`: `setForSession`, `formForSession` and `confirmForSession` take `pack.<n>`; `FORM_TEXT.*.session.pack` in `en` and `zh`; `get`'s `pack.<n>` rows show the session's value
- Modify: `lib/mcp/gateway.js`: `sessionMaySet` is the two caps or a `pack.<n>` name
- Modify: `lib/session-packs.js`: `turnOn(session, pack, version, {ask})` and `turnOff(session, pack, {ask})`
- Modify: `lib/sessions.js` `close`: `sessionPacks.forget(id)`, then an `unload-pack` for each pack it emptied
- Test: `test/sessions/22-pack-settings.js` (server-free, a stand-in for the control channel's `ask`; 20 and 21 are B5's), and cases added to `test/session-runtime/01-spawned.js`, where the test answers `load-pack` as ch-local's daemon does

**Interfaces:**
- **Off** (the session's value is on): a tightening, so no form. The override is `false`, the session leaves the pack's set, and the last session to leave a pack that isn't global asks `{type: 'unload-pack', name}`. The session's calls in flight finish; their next hop into the pack is refused (Task 4).
- **On** (the session's value is off, a pack it hid included): a loosening, so the session's form, whose text names the pack, its version from `packs.json` and "for this session". The MAC binds session, name, value and version, as today's staged change does. On accept:
  - the ceiling is checked again;
  - a pack already loaded is joined only if its loaded version is the form's; otherwise `SETTING_NOT_APPLIED`;
  - a pack not loaded is loaded once: `{type: 'load-pack', name, version}`, 45 s, with the asking session recorded as waiting so that Task 6 reads the `load` as a session's. A second session confirming meanwhile waits on the same request. On a refusal or no answer nothing is kept, with today's undo for `CONTROL_NO_ANSWER`;
  - then `join`, then `sessionSettings.set(session, 'pack.<n>', true, {loosening: true, version})`.
- A session that ended while it waited joins nothing, and the pack is unloaded if that left it empty.
- A leave and a join of one pack run one after the other, on one chain per pack, so no unload is asked under a session that has just joined.
- An `unload-pack` that fails is logged; the pack stays loaded and listed to no one.
- A refusal caused by another pack (`PART_VERSION_CONFLICT`, a tool name taken) is answered `SETTING_NOT_APPLIED` with one fixed problem text when the asker doesn't list that pack.
- Each change writes one history line, `{at, by, setting, old, new, change: 'this session', session}`, counts toward `MAX_SESSION_CHANGES`, and is told to that session alone (`notices.add(module, text, {session, sessionOnly: true})`).
- Decline locks, forms left and the per-user window use the kind `pack`, as B2's Task 5 built them.

- [ ] **Step 1: Write the failing tests.**
  - A turns `pack.ci` on: a form saying "for this session" in both languages. After the accept: exactly one `load-pack`; A lists the tool and B doesn't; `settings.json`'s bytes and mtime are unchanged; the history line has A's id; B's `get` shows the pack off and no line of A's.
  - B turns it on too: its own form, no second `load-pack`, and both list it.
  - A ends: no `unload-pack`. B turns it off: one `unload-pack`, and no form.
  - B turns a global pack off: no form, hidden from B, A unchanged, no `unload-pack`, the file unchanged. B turning it on again needs a form; a decline keeps it hidden and counts in the window.
  - A and B accept within one load: one `load-pack`; a failure leaves neither with it.
  - A leaves while B's accept is in flight: B ends up listing a loaded pack.
  - A ends mid-load: an `unload-pack` follows the load.
  - A joining a pack loaded at another version is refused, and the text names no session.
  - A load refused over a pack A doesn't list has the fixed text.
  - `locale`, `moduleSandbox` and `scope: 'all-sessions'` with a pack stay refused, with the file unchanged.
  - A session whose `askConditions` isn't `ok` and `yes`, or that is latched, gets no form.
- [ ] **Step 2:** Run `npx mocha --exit test/sessions/22-pack-settings.js`; it fails with `SETTING_TERMINAL_ONLY_SHARED`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it; then one at a time `npx mocha --exit test/sessions/09-tightenings.js`, `…/10-confirmations.js`, `…/test/stdio/14-settings-tool.js`, `…/test/stdio/20-settings-elicitation.js`, and `node test/helpers/run-local.js test/session-runtime/01-spawned.js` under the suite lock. They pass.
- [ ] **Step 5:** Commit.

**Size:** 2 days. **Needs:** Tasks 1–6, and B5's Task 1 on master.

### Task 9: a restored session's packs

**Files:**
- Modify: `lib/session-packs.js` (`adopt`)
- Modify: `lib/session-state.js` (B2's Task 6: its import calls `adopt`)
- Test: cases added to B2's `test/sessions/11-session-state.js`

**Interfaces:**
- `sessionPacks.adopt(session, pack, version, {ask})` → a Promise of true or false. For a restored `pack.<n>` override that is on: it joins a pack loaded at that version; it asks `load-pack` for one not loaded; and it answers false when the version differs, the ceiling refuses, or the load fails. The import then drops the override and tells the session "your this-session pack <n> was reset after a runtime restart; ask again" (§6, §11 answer 4).
- A restored off override needs no check: it is applied as stored.

- [ ] **Step 1: Write the failing tests.** A restored on override at the loaded version lists the pack to that session only. One at another version is dropped and announced. A restored off override hides a global pack. A row for a session that never resumes joins nothing.
- [ ] **Steps 2–5:** run `npx mocha --exit test/sessions/11-session-state.js` (it fails), implement, run it (it passes), commit.

**Size:** 0.5 day. **Needs:** Task 8, and B2's Task 6.

## Sizes and order

| Task | Days | Needs |
|---|---|---|
| 1. `lib/session-packs.js` | 1 | – |
| 2. Pack overrides under the ceiling | 0.5 | 1 |
| 3. `tools/list` and `tools/call` | 1 | 1 |
| 4. The session check at every hop | 2 | 1 |
| 5. `list_changed` per session | 0.5 | 1, 3 |
| 6. Notices to the pack's audience | 0.5 | 1, 2, C's yes |
| 7. Held hop input per session | 1 | – |
| 8. Packs in conversation, the guard lifted | 2 | 1–6, B5's Task 1 |
| 9. A restored session's packs | 0.5 | 8, B2's Task 6 |
| **Total** | **9** | |

- **In parallel:** Task 7 with anything but Task 4. After Tasks 1 and 2: Tasks 3, 4 and 6 beside each other, then 5. Two implementers finish in about 6 days; one, 9.
- **Beside B5:** all of B5 can run beside Tasks 1–7. Only Task 8 waits for B5's Task 1.
- Each task is its own PR. A PR that touches a hop, the gateway's lookup or the settings tool is a trust-boundary PR.

## What M17 builds on

M17 (`docs/superpowers/specs/2026-11-15-mcp-completeness-design.md`, section 10) lists resources and prompts per session. It calls:

- `sessionPacks.listsDevice(sessionId, deviceID)` and `sessionPacks.listsModule(sessionId, moduleName)`: the one question for a resource, a template or a prompt of a module. `resources/read` of `countinghouse://m/<module>/…` and `prompts/get` ask it before anything else, and answer a module the session doesn't list as their own unknown.
- `toolRegistry.filterTargetsBySession(targets, sessionId)`: it filters any map whose values carry a `deviceID`, so the three new lists reuse it after their own global, cached tables. A cursor is then a position in the filtered list.
- `sessionIdOf(opts)` in the gateway, exported for the new handlers.
- `hub.changed({session})` and `sessionPacks.onChange`: the new `list_changed` filters use the same round, each with its own fingerprint.
- A read in a per-session module's worker (§4a) is R1's, not B3's.

## Open, for the reviewer and the maintainer

- **A terminal `pack off` while sessions have the pack on.** §3 says a terminal tightening of a cap drops every looser override. §4 says a pack is unloaded "once that set is empty and the global settings don't list it", so a session's own "on" outlives the terminal's off. This plan follows §4. If the terminal's off should end every session's on, Task 6's `set pack.<n> false` also calls `dropPack`.
- **A load refused because of another session's pack** tells the asker that something else is loaded, whatever the text says. The fixed text hides which pack. The spec doesn't cover it.
- **An ended session's job and the packs its session turned off.** §2's rule ("never its tightenings") is written for the caps. Task 4 applies it to packs as well.
- **With C:** the `pack` field on the daemon's four messages, `set pack.<n>`, and ch-local's notice text ("for this start" becomes "for this session"; in shared mode the runtime tells the session itself, so the daemon's notice for a `load-pack` it answers can be dropped).
- **Residual:** a hop into a pack the session doesn't list and a hop to a device never hosted may differ in time, since a channel may already be open. The module sees the same error either way.
