# Shared runtime B2: per-session settings. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** revision 2, after #252's review (findings 1–10). It builds on B1 (#246, #247, #251) and C1 part 2 (#248). The runtime⇄daemon messages (Task 6) are agreed with C (2026-11-15).

**Goal:** In shared mode, every change made in conversation is the session's own override. Nothing a session does reaches another session, `settings.json`, or the options every session shares. A terminal tightening binds every session at once, calls in flight included. The confirmation state is per session, with a per-user window that a prompt injection can't fan out past. Notices and `logging/setLevel` are per session. This lifts C's #248 guard on cap sets, confirmation retries and `logging/setLevel`, and only those.

**Architecture:**
- A new main-thread `lib/session-settings.js` holds each session's overrides and works out its effective values against the ceiling and the global defaults.
- `lib/call-limits.js` takes the tighter of a call's own values and its session's current values at every check. Each holder carries its session main-side.
- `lib/notices.js` gets a queue and a level per session.
- In shared mode the settings tool applies a change to the session's overrides, never through the file, `options`, `atStart` or the live options broadcast.
- `lib/settings-confirm.js` gets one `Confirmations` per session, plus a per-user window.
- Whether a session may be shown a form is that session's own answer. In shared mode nothing calls the process-wide may-elicit: ch-local's start answers it `{mayElicit: false, why: 'a shared runtime asks each session'}` (C, #32).

**Tech stack:** Node ≥ 22.16, mocha. C1's session object (`s.notify`, `s.askConditions`, `s.record`, `s.forget`, `'replay'`).

**Spec:** `docs/superpowers/specs/2026-11-15-shared-runtime-design.md` (#236), §3 and §6, with its plan's B2. B1's plan, `docs/superpowers/plans/2026-11-15-shared-runtime-b1-sessions.md`, has the session interfaces. Line references below are master's `lib/settings-tool.js`.

## Global constraints

- **Conversation never writes `settings.json` in shared mode,** and never changes `options`, `atStart` or the live options broadcast. The settings tool records a session override and writes only the history, which names the session opaquely (§3).
- **In shared mode only the two caps are lifted from C's guard,** by name: `maxOutputBytes` and `requestTimeout`. Every other setting stays refused (`SETTING_TERMINAL_ONLY_SHARED`):
  - `moduleSandbox`, `autoUpgrade` and `upgradeCheck`, whose `set` writes the file;
  - `locale`, which is global (§3);
  - `pack.*`, which B3 lifts.
- **Effective value for a call:** with a session override, the tighter of the ceiling and the override; otherwise the tighter of the ceiling and the global default (§3).
- **What counts as a loosening is judged against the session's current effective value** (§3).
- **A terminal tightening binds every session:** a session override looser than the new default G is dropped at once, and that session is told "your this-session loosening of `maxOutputBytes` ended: the default was lowered to G". An override tighter than G is kept (§3).
- **"At once" includes calls in flight:** the reply cap is checked at reply time, and the timeout is re-armed from the call's start (§3).
- **May-elicit is the session's own:** `clientMayElicit` for the request's client, plus that session's `s.askConditions()` (null or `status: 'failed'` means no). It's asked at the form, at the confirmation and at a restore (finding 1).
- **Per session:** the staged change, its nonce, the decline lock per kind, and the forms shown. **Per user:** 3 declines or expiries per kind within 30 minutes stop forms of that kind for the next 30 minutes, across every session, and a form pending anywhere counts toward the 3 (§3, finding 7).
- **The nonce MAC key stays per runtime, and the MAC payload binds the session id,** which comes from the connection (§3).
- **Nothing of a session is written to a file** except the history line and the usage record, which carry its opaque id only (§6).
- **A replayed or restored tightening applies only if it's at least as tight as both the global default and the ceiling,** checked as `set` checks a value (§6, finding 10).
- **Modules never reach `settings.json` or `history.jsonl`:** both join the always-denied set, under `audit` and `enforce` (the reviewer's check).
- The form says "for this session", in both `en` and `zh` (§3, finding 9). This text gets its own review round.
- No API key, user name or secret in a log line, error text, history line or anything a module receives.

## Review focus

1. **A terminal tightening while a session's call is in flight:** the call's reply, a hop's reply and a peer result are held to the new cap, and the timer fires at the new timeout from the call's start (Task 2).
2. **A session ends with a form staged:** a retry naming its `requestState` from any session fails, and the pending form counts as an expiry in the per-user window (Task 5).
3. **Forms spread across sessions:** with 2 declines in the window, a third session's form can't be staged while another is pending, and an accept that arrives once the kind has locked is refused (Task 5).
4. **A forged or stale replay entry** (looser, malformed, `'300'` as a string, an unknown name, `locale`) is ignored, and a session's live tightening survives the shim's 64-entry eviction (Task 4).
5. **A ceiling lowered and raised again under an override:** the session doesn't return to its old, looser value (Task 1).

---

### Task 0: `settings.json` and the history in the always-denied set

**Files:**
- Modify: `lib/fs-broker/denied.js` and `lib/fs-broker/index.js`: `deniedSet()` adds `--settingsFile` and the `history.jsonl` beside it, when `--settingsFile` is given. They're main files, so a hard link or a rename is refused as for the auth configuration.
- Test: `test/fs-broker/` (the next number): a module whose declared directory contains both files gets EACCES reading and writing each, directly, through `..`, a symlink and a hard link, under `audit` and `enforce`.

- [ ] **Steps 1–5:** write the tests (they fail), implement, run them plus the fs-broker folder (they pass), commit.

### Task 1: the per-session override store (`lib/session-settings.js`)

**Files:**
- Create: `lib/session-settings.js`
- Test: `test/sessions/06-session-settings.js`

**Interfaces:**
- Consumes: `configure({ceiling, defaultOf, globalPack, isLive})`. Defaults: the settings tool's cached ceiling with `cacheOnly` (never a file read on a call's path), the options, and `lib/sessions.js` `get`.
- Produces:
  - `set(id, name, value)` → `{old, new}`. It refuses an id that isn't live, `locale` and any name other than the caps and `pack.*`. It stores the value clamped to the ceiling at that moment (finding 9);
  - `effective(id, name)` and `isLoosening(id, name, value)`;
  - `limitsOf(id)` → frozen `{maxOutputBytes, requestTimeout}`, or null when the session has no cap override;
  - `dropLooser(name, newDefault)` → the ids it dropped;
  - `forget(id)`;
  - `onChange(fn)`, called with `id` after every change, `dropLooser` included (Task 6's export).

- [ ] **Step 1: Write the failing tests.**
  - A's override is its own, and B has no limits.
  - A loosening is judged against A's current value.
  - A ceiling that's lowered bounds the override at once.
  - A ceiling lowered and then raised again doesn't bring back A's 9000 (review focus 5).
  - An untrusted or unknown ceiling keeps every cap at the default or tighter.
  - `dropLooser` drops only the looser overrides and calls `onChange` for each.
  - `set` refuses an id that isn't live, `locale`, and a bad value.
- [ ] **Steps 2–5:** run (they fail), implement, run them (they pass), commit.

### Task 2: per-call application, in flight included

**Files:**
- Modify: `lib/mcp/gateway.js`: a direct call sets `Session.limits = sessionSettings.limitsOf(sessionId)`; null stays null.
- Modify: `lib/call-limits.js`: `of(holder, session = holder.sessionId ?? holder.session ?? null)` takes, field by field, the tighter of the holder's own values and the session's current ones. The session's current values are `limitsOf`, else the defaults.
- Modify: the holders with no session of their own pass it main-side (finding 5): `sendCounted`'s reply cap (`of({limits: override}, session)`), `TOKEN_TTL_MS`, the peer broker's announced entries (from the announcing token entry's session) and `lib/job-sessions.js` `forRun` for a live session. The invoke message carries none.
- Modify: `lib/session.js`: an index of in-flight `Session`s by session id, and `rearm()`, which re-arms at `start + of(this).requestTimeout`. It runs after a terminal tightening and after a session's own tightening.
- Modify: `lib/validator-pool.js`: it grows its heap for a session's effective cap, through #222's resize, and never shrinks in release 1.
- Modify: `lib/settings-tool.js` `applyControlSet`: after a terminal tightening, `dropLooser` runs, then `rearm` for every in-flight call, then Task 3's notice to each dropped session.
- Test: `test/sessions/07-per-call.js` (server-free), and `test/sandbox/57-session-caps.js`, a spawned server on port 9793 in B's block, registered in `test/ports.md`.

- [ ] **Step 1: Write the failing tests.**
  - A's call is held to 9000 and B's to the default.
  - A hop's reply and a peer channel's result are held to the session's current cap, after a terminal tightening mid-call (review focus 1).
  - A call's timer fires at the tighter timeout from its start, after a terminal tightening and after the session's own tightening.
  - A job of a live session takes `limitsOf`, and one of an ended session is bounded as in #251.
  - The validators grow for a 9000 cap and don't shrink.
- [ ] **Steps 2–5:** run (they fail), implement, run them plus sandbox 54, composition 18 and sessions 03–05 (they pass), commit.

### Task 3: notices and `logging/setLevel` per session (B1's Task 5)

**Files:**
- Modify: `lib/notices.js`:
  - `add(module, text, {session = null})`: null is global and is copied into every open session's queue, within `PER_MODULE_MAX`;
  - `take(module, session)`, `setLevel(level, session)` and `forget(session)`;
  - a session's notifier is its `s.notify`, and `--stdio`'s is today's.
- Modify: `lib/usage/receipt.js` and the gateway's result path: take the calling session's queue only.
- Modify: `lib/mcp/gateway.js`: drop C's guard on `logging/setLevel`.
- Modify: `lib/settings-tool.js`: every `notices.add` it makes for a session's change names that session. `tellUser` (:701) is global only for a terminal change.
- Modify: `lib/sessions.js`: `close` calls `notices.forget(id)`.
- Test: `test/sessions/08-notices.js`, plus stdio 13 and 20.

- [ ] **Step 1: Write the failing tests.**
  - A per-session notice reaches its session only, on its next result and as its `notifications/message`.
  - A global notice reaches each open session once.
  - A session's level is its own.
  - A queue is gone after its session closes, and a session opened after a global notice doesn't get it.
  - Task 2's dropped-override sentence reaches the dropped session only.
- [ ] **Steps 2–5:** run (they fail), implement, run them plus stdio 13 and 20 (they pass), commit.

### Task 4: tightenings in conversation (no form yet)

**Files:**
- Modify: `lib/settings-tool.js`:
  - `set(name, value, by, ctx)` with `ctx.shared === true` and a cap name: a change no looser than `effective(session)` goes to `sessionSettings.set`. That means no file, no `options`, no `atStart`, no broadcast and no `applyConfirmed`. It writes a history line `{at, by, setting, old, new, change: 'this session', session}`;
  - a loosening stays refused, with `SETTING_TERMINAL_ONLY_SHARED`, until Task 5;
  - `get()` in shared mode shows the session's effective values, and only the history lines with no session or with this session's id (finding 8).
- Modify: `lib/mcp/gateway.js`: C's guard is lifted for the two caps by name. Every other name stays refused (finding 2).
- Modify: `lib/sessions.js`:
  - after each change of a session's tightenings, `s.forget()` and then one `s.record(snapshot)` carrying every tightening of that session, so the shim's eviction can never drop a live one (finding 10);
  - at `'replay'`, each entry is checked as `set` checks a value (positive integers, not strings) and applied only if at least as tight as the default and the ceiling.
- Test: `test/sessions/09-tightenings.js`, with two real sessions through `gateway.handle(…, {session: s})` over C1's listener and shim.

- [ ] **Step 1: Write the failing tests.**
  - A tightens `maxOutputBytes`. Only A's calls change, `settings.json`'s bytes and mtime are unchanged, and `options`, `atStart` and the live options are untouched.
  - A's loosening is refused. So are `moduleSandbox`, `autoUpgrade`, `upgradeCheck`, `locale` and `pack.ci`, with the file's bytes unchanged (finding 2).
  - A's `get` returns no line with B's id (finding 8).
  - A's record is one snapshot of all its tightenings.
  - `'replay'` applies `{maxOutputBytes: 300}` and ignores `'300'`, `5000` (looser), an unknown name and `locale` (review focus 4).
- [ ] **Steps 2–5:** run (they fail), implement, run them plus stdio 14 and 18–21 (they pass), commit.

### Task 5: the form and its retry, per session

**Files:**
- Modify: `lib/settings-confirm.js`:
  - `confirmations(session)`: one store per session, the `--stdio` session's being today's one. `forget(session)` at its end counts a pending form as an expiry;
  - a `UserWindow` per kind: declines and expiries within 30 minutes. Expiries are counted on a timer, at each form's own deadline, not at a later ask;
  - `stage` is refused when declines + expiries + forms pending anywhere reach 3, and an accept is refused once the kind has locked (finding 7);
  - the window starts locked for 30 minutes when no `restore` came within the 3 s safety net (Task 6).
- Modify: `lib/settings-tool.js` in shared mode (finding 4):
  - a cap loosening is judged against `effective(session)`, and `staged.old` and `CHANGED_MEANWHILE` use it;
  - an accepted change goes to `sessionSettings.set`, never `applyConfirmed`;
  - may-elicit is `clientMayElicit` plus `sessions.askConditions(session)`, at the form and again at the confirmation (finding 1). The process-wide `defaultMayElicit` is never called in shared mode.
- Modify: `lib/sessions.js`: `askConditions(id)` → the session's `s.askConditions()`, or null.
- Modify: `FORM_TEXT` (`en` and `zh`): "for this session".
- Modify: `lib/mcp/gateway.js`: drop C's guard on the confirmation retry, for the caps only.
- Test: `test/sessions/10-confirmations.js`, with real sessions through C1's listener and shim, plus stdio 19 and 20.

**Interfaces:**
- Produces: `confirmations(session)`, `forget(session)`, `userWindow.locked(kind)`, `userWindow.load(list)`, and `{type: 'decline', kind, at}` sent to the daemon for each decline or expiry (Task 6's messages).

- [ ] **Step 1: Write the failing tests.**
  - A at 300, asking 1000, gets a form. After A accepts, A's effective value is 1000, B's is unchanged, and `options`, `atStart` and the live options are unchanged.
  - A form staged in A, retried from B with A's `requestState`, fails. After A ends, its pending form counts as an expiry (review focus 2).
  - A's form doesn't replace B's.
  - With 2 declines in the window and a form pending in B, a third session gets no form, and B's accept after the kind locks is refused (review focus 3).
  - A session whose `askConditions` answers null or `failed` gets no form, at the form and at the confirmation.
  - The form's text says "for this session" in both languages.
- [ ] **Steps 2–5:** run (they fail), implement, run them plus stdio 18–21 and sessions 09 (they pass), commit.

### Task 6: a session's state across a runtime restart (the runtime's side)

The reviewer split it (2026-11-15): B2 owns the runtime's export and import, C3 the daemon's in-memory table and the IPC transport. The messages are agreed with C.

**Files:**
- Create: `lib/session-state.js` (export and import)
- Modify: `lib/sessions.js` (`importTable`), and `lib/session-settings.js` and `lib/settings-confirm.js` (a change calls the export, through `onChange`)
- Test: `test/sessions/11-session-state.js`

**Interfaces** (agreed with C; JSON on C's control channel, routed by `type`; no message carries a secret):
- Runtime → daemon, through C's control-channel `tell()` (C's c3-runtime branch, on #249; `tell()` refuses an `id`):
  - `{type: 'session-state', session, state}`: a full snapshot after every change, `dropLooser` included (finding 6). `session` matches `/^[A-Za-z0-9_-]{1,64}$/`, and `state` is at most 64 KiB as JSON; the daemon drops a larger row rather than keep a stale one. `state` is:
    - `overrides`: an array of at most 64 entries, at most one per `name`, each exactly `{name, value, loosening, over, version}`:
      - `name`: `'maxOutputBytes'`, `'requestTimeout'` or `'pack.<n>'` (`/^pack\.[a-z0-9][a-z0-9-]{0,63}$/`);
      - `value`: a positive integer for a cap, a boolean for a pack;
      - `loosening`: a boolean;
      - `over`: for a cap loosening, the global default it was confirmed over (a positive integer); otherwise null;
      - `version`: for a pack, the plain version its form named; otherwise null;
    - `locks`: the session's decline locks, an array of distinct kinds from `'maxOutputBytes'`, `'requestTimeout'` and `'pack'`;
    - `formsLeft`: an integer from 0 to 3.

    The state is an object with exactly these three keys. The runtime validates a restored one as strictly as C's #255 does, and drops a row that fails.
  - `{type: 'session-gone', session}` and `{type: 'decline', kind, at}`. `kind` is a non-empty string of at most 64 characters, and the daemon keeps each one 30 minutes.
- Daemon → runtime, a request answering the runtime's `ready`: `{id, type: 'restore', sessions: [{session, resume, state}], declines: [{kind, at}]}`.
  - `resume` is the session's resume-token hash (64 hex characters, SHA-256), the registry's own data, which C carries in the daemon's row beside B's `state`, so sessions survive a runtime restart (§6; the reviewer, 2026-11-15). B's `state` never holds it.
  - The runtime answers `{id, ok: true, sessions: n}`, or `ok: false` with `CONTROL_RESTORE_DONE` for a second or late one.
  - The daemon always sends it, once, right after spawning the runtime (empty when fresh), and from IPC only; it's never taken from a session's wire.
  - A 3 s timeout is a safety net: when it fires, the runtime starts with an empty table, the per-user window locked (Task 5) and one warning line.
  - The daemon keeps at most 256 rows and 64 KiB per state. `at` is epoch ms.
- Produces: `sessions.importTable({sessions, declines})`, which C3's `startSessions` calls before `listen()`. A restored row waits for its session's `'session'` event after the resume, and is dropped if none comes within the reconnect window.

- [ ] **Step 1: Write the failing tests.**
  - An export holds overrides, locks and forms left, and no key, user name, nonce or MAC key. It's under 64 KiB with every override set.
  - On import:
    - a tightening applies only if at least as tight as today's default and the ceiling, checked as `set` checks a value;
    - a loosening waits for the session's client frame, then applies only if the ceiling allows it, may-elicit passes for that session, and today's default isn't tighter than its `over` (finding 6). Otherwise it's dropped, and the session is told "your this-session loosening of `<name>` was reset after a runtime restart; ask again";
    - a pack override whose version doesn't match is dropped and announced;
    - the declines load into the window;
    - a row for a session the registry doesn't have, or one that never resumes, is ignored;
    - a second `'restore'` is refused `CONTROL_RESTORE_DONE`, and changes nothing;
    - a state with a key other than the three, an override outside its shape, a duplicate name or more than 64 entries drops that row.
  - An empty `restore` starts the listener at once. No `restore` within 3 s starts it with an empty table, the window locked and one warning.
  - Each restored session is told "restored after a runtime restart".
- [ ] **Steps 2–5:** run (they fail), implement against a test double for C3's channel, run them plus sessions 06–10 (they pass), commit.

## Decided

- **The decline count and the session table go to the daemon over C's control channel,** in Task 6's messages (the reviewer, 2026-11-15). B2 owns the runtime side, C3 the daemon side.
- **Only the two caps are lifted in shared mode;** pack sets wait for B3, and the other settings stay terminal-only (finding 2).
- **Holds, from #252's review:** the MAC binds the session id taken from the connection. A replaced daemon is residual 1, given the ceiling re-check on import.

## Notes for B5 (from #251's review)

- `tasks/get`, `tasks/result` and `tasks/cancel` (`lib/mcp/gateway.js`) match on owner only. B5 must match on session too, and the local runner's sequential job ids must become random there.
- A job run's token is filed under its session in `bySession` (`lib/call-tokens.js`). A session-end token sweep (Task 4 of B1's plan) must spare job runs, which are bounded by the ended session's override instead (#251).
