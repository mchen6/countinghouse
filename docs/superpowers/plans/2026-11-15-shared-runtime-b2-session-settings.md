# Shared runtime B2: per-session settings. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** for review. It builds on B1 (#246, #247, Task 3) and C1 part 2 (#248). The outline is approved by the reviewer, and the runtime⇄daemon messages (Task 6) are agreed with C (2026-11-15).

**Goal:** In shared mode, every change made in conversation is the session's own override. Nothing a session does reaches another session, or `settings.json`. A terminal tightening binds every session at once, calls in flight included. The confirmation state is per session, with a per-user decline count that a prompt injection can't fan out past. Notices and `logging/setLevel` are per session. This lifts C's #248 guard on settings sets, confirmation retries and `logging/setLevel`.

**Architecture:**
- A new main-thread `lib/session-settings.js` holds each session's overrides (caps and packs) and works out its effective values against the ceiling and the global defaults. `lib/sessions.js` drops a session's overrides at its end, after handing its last caps to `lib/job-sessions.js` (B1 Task 3).
- The settings tool, given a session, records an override instead of writing the file.
- `lib/call-limits.js` takes the tighter of a call's own values and its session's current values at every check.
- `lib/settings-confirm.js` gets one `Confirmations` per session, plus a per-user window.
- `lib/notices.js` gets one queue and one level per session.

**Tech stack:** Node ≥ 22.16, mocha. C1's session object (`s.notify`, `s.record`, `s.forget`, `'replay'`).

**Spec:** `docs/superpowers/specs/2026-11-15-shared-runtime-design.md` (#236), §3 ("Settings: three layers", "The confirmation state", "Every change is announced") and §6 ("Where session state lives"), with its plan's B2. B1's plan, `docs/superpowers/plans/2026-11-15-shared-runtime-b1-sessions.md`, has the session interfaces.

## Global constraints

- **Conversation never writes `settings.json` in shared mode.** The settings tool records a session override and writes only the history, which names the session opaquely (§3).
- **`locale` stays global and terminal-only:** a conversational `set locale` answers that it's set with `ch-local settings set locale` (§3).
- **Effective value for a call:** with a session override, the tighter of the ceiling and the override; otherwise the tighter of the ceiling and the global default (§3).
- **What counts as a loosening is judged against the session's current effective value,** not the global default. A form is needed both to raise a session-tightened value back toward the default and to un-hide a pack the session turned off (§3).
- **A terminal tightening binds every session:** a session override looser than the new default G is dropped at once, and that session is told "your this-session loosening of `maxOutputBytes` ended: the default was lowered to G". An override tighter than G is kept. A terminal loosening doesn't touch overrides (§3).
- **"At once" includes calls already in flight:** the reply cap is checked at reply time, and the timeout is re-armed when the tightening is applied, measured from the call's start (§3).
- **Per session:** the staged change, its nonce, the decline lock per kind, and the forms shown (§3). **Per user:** 3 declines *or expiries* per kind within 30 minutes stop forms of that kind for the next 30 minutes, across every session. The runtime sends each one to the daemon (the kind and the time, nothing else), and the daemon hands them back to a restarted runtime (§3).
- **The nonce MAC key stays per runtime, and the MAC payload binds the session id** (§3; P2's payload already carries it).
- **Nothing of a session is written to a file,** except the history line and the usage record, which carry its opaque id only (§6, B1's global constraints).
- **A replayed tightening (`'replay'`) applies only if it is at least as tight as both the global default and the ceiling** (§6).
- The form says "for this session", not "until your client restarts countinghouse", in both `en` and `zh` (§3, finding 9). This text needs its own review round.
- No API key, user name or secret in a log line, error text, history line or anything a module receives.

## Review focus

1. **A terminal tightening while a session's call is in flight:** the call's reply is held to the new, tighter cap, and its timer fires at the new timeout measured from its start (Task 3).
2. **A session ends with a form staged:** a retry naming that session's `requestState` from any other session fails `SETTING_CONFIRMATION_INVALID`, and the per-user count isn't reduced by the session's end (Task 4).
3. **Declines spread across sessions:** 3 declines of one kind across 3 sessions within 30 minutes lock that kind for every session, a new one included. A fourth session gets no form (Task 4).
4. **A forged or stale replay entry:** one looser than the default or the ceiling, malformed, for an unknown setting, or for `locale` is ignored, and the session runs as if it weren't there (Task 2).
5. **The ceiling is lowered under an existing override:** the session's effective value follows the ceiling at the next check, without a new form, and its loosening isn't kept above it (Task 1).

---

### Task 1: the per-session override store (`lib/session-settings.js`)

**Files:**
- Create: `lib/session-settings.js`
- Modify: `lib/sessions.js` (`close`: hand the session's caps to `lib/job-sessions.js`, then drop its overrides; `state.limits` from Task 1 of B1 becomes `sessionSettings.limitsOf(id)`)
- Test: `test/sessions/06-session-settings.js`

**Interfaces:**
- Consumes: `lib/sessions.js` `get(id)`, its end via `close(id)`; `lib/settings-ceiling.js` through settings-tool's `cachedCeiling`; `lib/call-limits.js` `check`, `defaults`.
- Produces:
  - `set(id, name, value)` → `{old, new}`, for `maxOutputBytes`, `requestTimeout` and `pack.<name>`; it throws for any other name (`locale` included);
  - `effective(id, name)`: the session's effective value. For a cap, `min(ceiling, override ?? default)`. For a pack, the override, else the global value;
  - `limitsOf(id)`: `{maxOutputBytes, requestTimeout}` frozen when the session has a cap override, else null. Each field is `min(ceiling, override ?? default)` at the time of the call;
  - `dropLooser(name, newDefault)` → the ids whose override of `name` was looser than `newDefault` and is now dropped;
  - `forget(id)`;
  - `isLoosening(id, name, value)`: looser than the session's current effective value.

- [ ] **Step 1: Write the failing tests.**
  - Two sessions: A sets `maxOutputBytes` to 9000 and B nothing. `effective(A)` is 9000 and `effective(B)` is the default, and `limitsOf(B)` is null.
  - A tightening to 300: `isLoosening(A, 'maxOutputBytes', 1000)` is true when the default is 1000 (review focus: raising back toward the default needs a form).
  - The ceiling lowered to 5000 under A's 9000: `effective(A)` is 5000 at the next call, with no `set` (review focus 5).
  - `dropLooser('maxOutputBytes', 2000)` returns `[A]` for A at 9000, keeps a session at 300, and `effective(A)` is then 2000.
  - `set(A, 'locale', 'zh-CN')` throws `SETTING_TERMINAL_ONLY_SHARED`, naming `ch-local settings set locale`.
  - After A's end, `effective(A)` is the default, and `lib/job-sessions.js` got A's last caps (B1 Task 3's ended run).
- [ ] **Step 2:** Run it; it fails.
- [ ] **Step 3:** Implement. It's a `Map(id → Map(name → value))`, main thread only. The ceiling is read through the same `cachedCeiling` the settings tool uses, and a ceiling that isn't trusted bounds every cap at its default.
- [ ] **Step 4:** Run it plus sessions 01 and 04; they pass.
- [ ] **Step 5:** Commit.

### Task 2: the settings tool in shared mode writes an override, never the file

**Files:**
- Modify: `lib/settings-tool.js`
  - `set(name, value, by, ctx)` and `confirm(...)`: with `ctx.sessionShared === true`, apply to `session-settings`;
  - the history line gets `session` (the opaque id);
  - `get()` shows the session's effective values;
  - `refuseSharedSet` stays for `pack.*` only, until B3.
- Modify: `lib/mcp/gateway.js` (the settings branch: drop C's guard for caps; pass `sessionShared` in the ctx)
- Modify: `lib/sessions.js` (on a tightening, `s.record({name, value})`; at `'replay'`, apply each entry only if at least as tight as both the global default and the ceiling)
- Test: `test/sessions/07-settings-in-session.js`, and `test/stdio/` 14 and 20 unchanged (stdio isn't shared)

**Interfaces:**
- Consumes: Task 1; C1's `s.record(entry)`, `s.forget()` and `'replay' (entries)`.
- Produces:
  - in the settings tool's answer, `applies: 'this session'` for a shared session's change;
  - the history line `{at, by, setting, old, new, change: 'this session', session: <id>}`.

- [ ] **Step 1: Write the failing tests.** Driven through `gateway.handle(…, {session: s})` with two real sessions over C1's listener and test shim (B1's sessions 01 does the same).
  - Session A's tightening of `maxOutputBytes` changes A's `effective` only. B's calls see the default, `settings.json` isn't written (its mtime and bytes are unchanged), and the history has a line naming A's id.
  - A's raise needs a form in A only. After A confirms, B's `effective` is unchanged.
  - A's `pack.<name> off` is still refused `SETTING_TERMINAL_ONLY_SHARED` (B3 lifts it).
  - `set locale` from a session is refused with the terminal command.
  - A tightening sends `record({name, value})` on A's connection (the shim sees the control frame).
  - `'replay'` with `{maxOutputBytes: 300}` applies when the default is 1000; with 5000, a malformed entry, an unknown name or `locale`, nothing applies (review focus 4).
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement. The `set` path's file write, `options` tightening and `applyChange` are skipped when `ctx.sessionShared`; the form and its retry are unchanged (Task 4 splits their state).
- [ ] **Step 4:** Run them, plus stdio 14 and 18–21 and sessions 01–05; they pass.
- [ ] **Step 5:** Commit.

### Task 3: per-call application, in flight included

**Files:**
- Modify: `lib/mcp/gateway.js`: a direct call sets `Session.limits` to `sessionSettings.limitsOf(sessionId)` before its token is issued; null stays null.
- Modify: `lib/call-limits.js`: `of(holder)` takes, field by field, the tighter of the holder's own values and its session's current ones. The session is `holder.sessionId` (a `Session`) or `holder.session` (a token entry), and its current values are `limitsOf`, else the defaults.
- Modify: `lib/session.js`: an index of in-flight `Session`s by session id, and `rearm()`, which re-arms a call's timer at `start + of(this).requestTimeout`.
- Modify: `lib/job-sessions.js`: `forRun` for a live session returns `sessionSettings.limitsOf(session)`.
- Modify: `lib/validator-pool.js`: grows its heap when a session's effective `maxOutputBytes` needs more, through #222's resize. It never shrinks in release 1.
- Modify: `lib/settings-tool.js` `applyControlSet`: after a terminal tightening, `dropLooser` runs, then `rearm` for every in-flight call, and each dropped session is told the §3 sentence (through Task 5's per-session notices).
- Test: `test/sessions/08-per-call.js` (server-free), and `test/sandbox/57-session-caps.js`, a spawned server on port 9793 in B's block, registered in `test/ports.md`.

**Interfaces:**
- Consumes: Task 1's `limitsOf` and `dropLooser`.
- Produces: `Session.rearm()`; `callLimits.of` semantics as above, and B1's `bound: 'defaults'` still applies after them.

- [ ] **Step 1: Write the failing tests.**
  - One session's raise doesn't change another's calls: A's call is held to 9000 and B's to the default.
  - A hop token carries its session's values.
  - A call in flight when the default is tightened gets the tighter cap at its reply, and its timer fires at the new timeout from its start (review focus 1, spawned, with a slow callee).
  - A job of a session that tightened keeps the tighter value after the session ends, and one that loosened takes the default (B1 Task 3's case, now through `limitsOf`).
  - The validators grow for a session's 9000 cap, and don't shrink when the session ends.
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them, plus sandbox 54, composition 18 and sessions 03–05; they pass.
- [ ] **Step 5:** Commit.

### Task 4: the confirmations, per session, and the per-user count

**Files:**
- Modify: `lib/settings-confirm.js`:
  - `confirmations(session)` returns that session's `Confirmations`, made on first use. The `--stdio` session's is today's one;
  - a `UserWindow` holds the declines and expiries per kind (3 within 30 minutes lock the kind for 30 minutes);
  - `forget(session)` drops a session's store at its end, and the window is unaffected.
- Modify: `lib/settings-tool.js`: every `confirmations()` call passes `ctx.session`; the decline lock reads both the session's and the user's.
- Modify: `FORM_TEXT` (`en` and `zh`): "for this session".
- Modify: `lib/sessions.js`: `close` calls `settingsConfirm.forget(id)`.
- Modify: `lib/mcp/gateway.js`: drop C's guard on the confirmation retry.
- Test: `test/sessions/09-confirmations.js`, and stdio 19 and 20 (the stdio session's single store, as before).

**Interfaces:**
- Consumes: from C, to agree (open question 1): the daemon control channel's `{op: 'decline', kind, at}` from the runtime, and the list of the last 30 minutes' `{kind, at}`, handed over before a restarted runtime accepts connections.
- Produces: `confirmations(session)`, `forget(session)`, `userWindow.locked(kind)`, `userWindow.load(list)`.

- [ ] **Step 1: Write the failing tests.**
  - A form staged in A, retried from B with A's `requestState`, fails `SETTING_CONFIRMATION_INVALID`. After A ends, the same retry still fails (review focus 2).
  - A decline in A locks the kind in A only.
  - 3 declines of `maxOutputBytes` across A, B and C within 30 minutes lock it for D, a session opened after them (review focus 3). After 30 minutes (an injected clock), D gets a form.
  - Each decline or expiry sends `{op: 'decline', kind, at}` and nothing else (no session, no value).
  - A runtime started with a handed-over list of 3 declines refuses the form.
  - The form's text says "for this session" in both languages.
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them, plus stdio 18–21 and sessions 07; they pass.
- [ ] **Step 5:** Commit.

### Task 5: notices and `logging/setLevel` per session (B1 Task 5)

**Files:**
- Modify: `lib/notices.js`:
  - `add(module, text, {session = null})`: null is global and is copied into every open session's queue, within `PER_MODULE_MAX`;
  - `take(module, session)` and `setLevel(level, session)`;
  - `forget(session)`;
  - a session's notifier is its `s.notify`, and `--stdio`'s is today's.
- Modify: `lib/usage/receipt.js` and the result path in `lib/mcp/gateway.js`: take the calling session's queue only.
- Modify: `lib/mcp/gateway.js`: drop C's guard on `logging/setLevel`, setting the session's level.
- Modify: `lib/sessions.js`: `close` calls `notices.forget(id)`.
- Test: `test/sessions/10-notices.js`, and stdio 13 and 20 (the change notices and P2's).

**Interfaces:**
- Consumes: C1's `s.notify(obj)` (dropped while detached; the queue keeps the notice for the next result).
- Produces: `add(module, text, {session})`, `take(module, session)`, `setLevel(level, session)`, `forget(session)`.

- [ ] **Step 1: Write the failing tests.**
  - A per-session notice reaches its session only, on its next result and as its `notifications/message`.
  - A global notice reaches every open session once.
  - A session's `logging/setLevel` changes only its own level.
  - A queue is gone after its session closes, and a session opened after a global notice doesn't get it.
  - Task 3's dropped-override sentence reaches the dropped session only.
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them, plus stdio 13 and 20, and sessions 07 and 08; they pass.
- [ ] **Step 5:** Commit.

### Task 6: a session's state across a runtime restart (the runtime's side)

The reviewer split it (2026-11-15). B2 owns the runtime's export and import. C3 owns the daemon's in-memory table and the IPC transport. The message shape below is agreed with C. Tasks 1–5 don't depend on it.

**Files:**
- Create: `lib/session-state.js` (export and import)
- Modify: `lib/session-settings.js`, `lib/settings-confirm.js` and `lib/sessions.js` (a change calls `sessionState.changed(id)`)
- Test: `test/sessions/11-session-state.js`

**Interfaces** (agreed with C; every message is JSON on C's control channel, and none carries a secret):
- Runtime → daemon:
  - `{op: 'session-state', session, state}`: a full snapshot after every change to a session's state. `state` is:
    - `overrides`: `[{name, value, loosening, version}]`. `name` is a cap or `pack.<n>`; `loosening` is true for a confirmed loosening; `version` is the pack version its form named, else null;
    - `locks`: the session's decline locks;
    - `formsLeft`: the forms it has left.
  - `{op: 'session-gone', session}` at its end.
  - `{op: 'decline', kind, at}` for each decline or expiry, the per-user count (Task 4).
- Daemon → runtime, once, right after the control channel is up and before `--sessionSocket`'s listener listens: `{op: 'restore', sessions: [{session, state}], declines: [{kind, at}]}`. The daemon always sends it right after spawning the runtime, with empty `sessions` and `declines` when it is fresh, so a normal start never waits. A 3 s timeout is only a safety net: when it fires, the runtime starts with an empty table and logs a warning (the reviewer, 2026-11-15). The registry's resume-token hashes stay C's.
- The daemon's bounds (C3): at most the listener's `maxSessions` (256) rows, and 64 KiB per state; an oversized state is dropped with a log line. So an export stays small: overrides by name, at most one per setting.
- `at` is epoch ms (one machine, one clock).
- Produces:
  - `sessions.importTable({sessions, declines})`, which C3's `startSessions` calls on `'restore'` before `listen()`, as it calls `sessions.attach`. A restored row waits for its session's `'session'` event, after its resume, and is dropped if none comes within the reconnect window;
  - `sessionState.exportOf(id)` → `state`.

- [ ] **Step 1: Write the failing tests.**
  - An export holds the session's overrides, locks and forms left, and no key, user name, nonce or MAC key.
  - On import:
    - a `loosening: false` value applies only if at least as tight as the default and the ceiling;
    - a `loosening: true` value is held until the session's client frame settles after its resume, then applies only if the ceiling allows it and may-elicit passes for that client. Otherwise it's dropped, and the session is told "your this-session loosening of `<name>` was reset after a runtime restart; ask again";
    - a pack override whose version doesn't match the installed one is dropped and announced;
    - the declines load into Task 4's window, and a restored kind with 3 declines is still locked;
    - a session the registry no longer has (its window expired before the restart) is ignored, and so is a row that never resumes within the reconnect window;
    - an export of a session with every override set is under 64 KiB;
    - an empty `restore` starts the listener at once, and no `restore` within 3 s starts it with an empty table and one warning line.
  - The restore is announced to each restored session: "restored after a runtime restart".
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement against the agreed shape. Until C3's transport exists, a test double stands in for the channel.
- [ ] **Step 4:** Run them, plus sessions 06–10; they pass.
- [ ] **Step 5:** Commit.

## Decided

- **The decline count and the session table go to the daemon over C's control channel,** in Task 6's messages (the reviewer, 2026-11-15). B2 owns the runtime side and C3 the daemon side.
- **Per-session packs stay refused in conversation until B3**, which makes `tools/list`, `list_changed` and the hop check honour them. B2 records and exports pack overrides only where B3 needs them.
