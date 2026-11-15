# Shared runtime B1: sessions on the main thread. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** DRAFT. Written before C1, so the "Consumes from C1" lines below are assumptions, to be fixed against C1's real interfaces before any code.

**Goal:** Every call the shared runtime serves knows its session, on the main thread only: in its call token (with its cap and timeout), in the jobs it creates, and in its usage records. Each session has its own clientInfo and notices. A session's default repository fills a client's direct call only. Modules see nothing of sessions.

**Architecture:**
- A session is C1's per-connection object.
- B1 adds a main-thread `lib/sessions.js`, which holds each session's per-session state: its id, its clientInfo, its notice queue and log level, its repo slug and its tokens.
- Each MCP request is handled with a context naming its session. The context flows through the gateway into `lib/session.js`, the call's object, and from there into call tokens, jobs and usage records.
- B1 builds on #233's per-call values (`lib/call-limits.js`): a token entry already carries an override or null. B1 adds the session beside it.

**Tech stack:** Node ≥ 22.16, mocha; the shared runtime's session listener (C1).

**Spec:** `docs/superpowers/specs/2026-11-15-shared-runtime-design.md` (#236), sections 2–5, and its plan's B1.

## Global constraints

- **The session never reaches a worker** (§2). Nothing session-shaped goes into an invoke message, a token sent to a worker, a ctx or a device config.
- **A module sees one caller id** for the machine's user (R2-1's `ctx.caller.id`), whatever the session.
- **Session ids are opaque:** random, 128 bits, hex, and never derived from a key, a user name, a pid or a path. A usage record or a history line carries the id, never anything else about the session.
- **No API key, user name or secret** in a log line, error text, usage record, or anything a module receives.
- **locale stays global** (§3).
- **A session that ends leaves nothing behind:** its notice queue, clientInfo and the index of its tokens are dropped at once. Its jobs keep running, as B1's task 4 says.

## Review focus

1. **A hop from session A's call must carry A's session,** not "the last session". Session state that is module-global would leak one session's identity into another's hop.
2. **A notice for one session must never reach another.** Today `lib/notices.js` has one queue, drained by any tool result. A per-session notice taken by another session's call would tell one session about another.
3. **A session that ends mid-call:** its in-flight calls finish (their tokens stay valid), but no new call is accepted for it. Its late notices are dropped, not delivered elsewhere.
4. **The session default fills only a client's direct call,** never a hop and never a job. A slug that isn't `owner/name` is not filled. A value the caller gave is never replaced.
5. **The usage record's session field:** an old reader of the records must still read them, so the field is additive.

---

### Task 1: the session registry's main-thread side (`lib/sessions.js`)

**Files:**
- Create: `lib/sessions.js`
- Modify: `lib/mcp/client-info.js` (from one record per process to one per session)
- Test: `test/stdio/30-sessions.js`

**Interfaces:**
- **Consumes from C1 (to confirm):**
  - a session object `s` with `s.id`;
  - `s.client`, the latest `client` frame's fields: `conditions`, `repo`, `token`;
  - an `end` event;
  - and the per-session stdio handler C1 builds, which calls the gateway with `(message, ctx)`.
- **Produces:**
  - `sessions.open(s)` and `sessions.close(id)`;
  - `sessions.get(id)`, which returns `{id, clientInfo, repo, notices, logLevel, tokens: Set}`, or null;
  - `sessions.contextOf(id, params)`, which returns `{clientInfo, capabilities, session: id}`: P2's contextOf, per session;
  - `clientInfo.record(id, info)`, the first `initialize` of each session.
- `--stdio` mode has one session, with a random id, opened at start: today's behaviour.

- [ ] **Step 1: Write the failing tests.**
  - Two sessions each record their own first `initialize`; a second `initialize` on one changes nothing.
  - `contextOf` for each returns its own clientInfo and id.
  - After `close(id)`, `get(id)` is null and its notices are gone.
  - The ids are 32 hex characters, and differ.
  - Stdio mode has exactly one session.
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement. P2's `lib/mcp/client-info.js` keeps its exports and becomes a thin layer over the current session (stdio mode).
- [ ] **Step 4:** Run them, plus stdio 18–21; they pass.
- [ ] **Step 5:** Commit.

### Task 2: the session on each call, and in its token

**Files:**
- Modify: `lib/mcp/gateway.js` (the context's session onto the call)
- Modify: `lib/user-auth.js` and `lib/session.js` (`Session.sessionId`)
- Modify: `lib/call-tokens.js` (`issue({..., session})`; an index from session id to its tokens)
- Modify: `lib/device-manager.js` and `lib/peer-channel-broker.js` (a child token takes its parent's session)
- Test: `test/sandbox/55-sessions-on-calls.js`

**Interfaces:**
- `Session.sessionId`: an opaque id, or null for a call from no session (HTTP, a job).
- `callTokens.issue({..., session = null})`: a child takes its parent's session; given one that differs from its parent's, it throws (a hop never changes session).
- `callTokens.ofSession(id)` returns a Set of live tokens.

- [ ] **Step 1: Write the failing tests.**
  - On a routed and on a peer server, with two sessions, a module records `ctx.caller.id` for a call from each session: the same id.
  - A hop on session A's call has a token whose session is A. A hop issued with session B on A's parent throws.
  - The invoke message to the worker has no session field, nor does the token the worker holds (a check on the message's keys).
  - **#233's values, per session:** session A with an override (set as the preload does) and session B without one. A's hop is held to A's cap, and B's hop to the default.
- [ ] **Steps 2–5:** run (they fail), implement, run them plus composition 18 and 20 and sandbox 54 (they pass), commit.

### Task 3: jobs and usage records

**Files:**
- Modify: the job path in `lib/job-control-common.js` and `lib/device-manager.js` (a job records the session that created it)
- Modify: `lib/usage/index.js` (a `session` field on records)
- Test: `test/usage/20-session-records.js`

**Interfaces:**
- A job's stored data gets `session`, its creator's id or null. The job's call token takes it.
- Usage records get `session: id | null`, additive: readers that don't know the field ignore it.

- [ ] **Step 1: Write the failing tests.**
  - Records of calls from two sessions carry their own ids.
  - A record carries no other session data.
  - `lib/usage/read.js` and the report still read a record without the field.
  - A job's hops carry its creator's session.
- [ ] **Steps 2–5:** as above, plus usage 10 and 14.

### Task 4: a job outlives its session's loosenings

**Files:**
- Modify: `lib/sessions.js`, at `close` (rewrite the limits of the session's live tokens and their children)
- Test: `test/sandbox/55-sessions-on-calls.js` (+ cases)

**Interfaces:**
- At `close(id)`, every live token of that session is rewritten to `callLimits.tighter(itsOverride, defaults now)`, field by field. That's §2 as revised (C's #236): a job keeps the tighter of the session's last value and the default. So a loosening ends, and a tightening stays.
- The token's session stays: the job is still that session's.

- [ ] **Step 1: Write the failing tests.**
  - A job of a session that loosened `maxOutputBytes` takes the default for its next hop once the session ends.
  - A job of a session that tightened keeps the tighter value.
  - A call in flight when its session ends finishes under its values.
- [ ] **Steps 2–5:** as above.

### Task 5: per-session notices

**Files:**
- Modify: `lib/notices.js` (queues and level keyed by session; a global notice is copied into every open session's queue; a session's queue is dropped at close)
- Modify: `lib/usage/receipt.js` (takes the calling session's queue only)
- Modify: `lib/route-manager.js` and C1's handler (the notifier is per session)
- Test: `test/stdio/31-session-notices.js`

**Interfaces:**
- `notices.add(module, text, {session = null})`: null is global, copied to every open session.
- `notices.take(module, session)`.
- `notices.setLevel(level, session)`.

- [ ] **Step 1: Write the failing tests.**
  - A per-session notice reaches its session only, on its next result and as its `notifications/message`.
  - A global notice reaches every open session once.
  - A session's `logging/setLevel` changes only its own level.
  - A queue is gone after its session closes.
  - A session opened after a global notice doesn't get it.
- [ ] **Steps 2–5:** as above, plus stdio 13 (the change notices) and the P2 notices (stdio 20h).

### Task 6: the session default repository (`sessionDefaults`)

**Files:**
- Modify: `lib/module-manager.js` (read `countinghouse.sessionDefaults` from the reviewed manifest, a map of input field to default name; only `repo` is known)
- Modify: `lib/mcp/gateway.js` (fill before the input schema check, on a client's direct `tools/call` only)
- Test: `test/sandbox/56-session-defaults.js`, with a fixture pack whose manifest declares `{"repo": "repo"}`

**Interfaces:**
- The session's `repo` comes from C1's `client` frame. It's filled only when the session has one matching `^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$`, and the direct call's arguments lack the field.
- Never on a hop, a job, or `countinghouse_call_tool`'s inner call. That inner call is the model's, not the client's own direct call (the reviewer, 2026-11-15).

- [ ] **Step 1: Write the failing tests.**
  - A direct call that omits `repo` gets the session's slug, and the module sees an ordinary input.
  - A call that gives `repo` keeps it.
  - A hop that omits it isn't filled.
  - A slug of `../x`, `a/b/c`, an empty string or one over 201 characters isn't filled.
  - A pack without the declaration isn't filled.
  - The filled value fails the input schema like any input if the schema refuses it.
- [ ] **Steps 2–5:** as above.

## Decided (the reviewer, 2026-11-15)

- **C1's interface** is assumed as above: a session object `{id, client, 'end'}`, and the gateway called with `(message, ctx)`. It has been sent to C to confirm or correct in C1's first PR, so both sides agree before either codes against it. No code here until C1's interfaces exist.
- **`countinghouse_call_tool`'s inner call is not a direct call:** no session default fills there.
- **HTTP stays out of shared mode.** In shared mode the runtime serves only the shim's session listener, with no HTTP listener. The hosted HTTP mode stays as today: each key is its own principal, with no session (`Session.sessionId` null, the global values).
