# Shared runtime B5: session-scoped views. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** revision 2, after implementer B's review (#298) and the reviewer's rulings on it. Written against master at 11c57088 and checked by B against 3f1fd23e (#287, #294 and #296 have merged since). It needs nothing of B3. B3's Task 8 waits for this plan's Task 1 (its Steps 1–5; the description's commit may follow).

**Goal:** In shared mode each session sees its own tasks, its own usage and its own settings history, and nothing of another session's. Another session's task is answered exactly as an unknown one. A session's tasks are cancelled when it ends. The legacy `tasks/*` methods, refused on a shared runtime today, are served there again. The terminal still shows everything.

**Architecture:**
- One rule, in a new main-thread `lib/session-scope.js`: what a request's session may see of a thing a session owns. Tasks and the usage report use it, and so will M17's stored results.
- **Tasks.** A shared runtime runs on the local store (`framework.js` refuses `--sessionSocket` otherwise), so its jobs are the local runner's (`lib/job-control-local.js`). There a job keeps its creator's session for as long as its record lives, and gets a random id. `getJob`, `removeJob` and `listJobs` answer by key and session.
- **The usage report.** A record already carries its session (B1's Task 3). The report takes a session and builds every section from that session's records only.
- **The settings history.** `readHistory` already hides lines that name another session (B2's Task 4). What is left: its look-back, and a check that every line a session writes names it.

**Tech stack:** Node ≥ 22.16, mocha. B1's `lib/sessions.js`, the gateway's `sessionIdOf(opts)`.

**Spec:** `docs/superpowers/specs/2026-11-15-shared-runtime-design.md` (#236), section 2 ("What else is per session", finding 5), section 9, its Appendix, and its plan's B5. The notes for B5 at the end of the B2 plan are where Task 2 starts.

## Global constraints

- **Another session's task is an unknown task,** byte for byte (§2): the same JSON-RPC error `tasks/get`, `tasks/result` and `tasks/cancel` give an id that was never issued, with no extra step on the way to it. It is absent from `tasks/list`.
- **The session comes from the connection** (`sessionIdOf(opts)`), never from `params`, `arguments` or `_meta`.
- **In shared mode the session is checked whoever asks.** An identity that is an admin, or any identity under `--debug`, sees no other session's task or usage. Only the runtime's own `INTERNAL` context sees every job.
- **A thing with no session is seen by no session** in shared mode: a null owner never matches a null scope.
- **Outside shared mode nothing changes.** Under `--stdio`, over HTTP and with `runtime: own`: job ids count up from 1, a job is its owner key's, the report is the caller's, and `get` reads the whole history. The CLI report (`bin/countinghouse-usage.js`) shows every session.
- **The tool surface moves in one place, on purpose:** `countinghouse_usage_report`'s description, so that it is true on a shared runtime (the reviewer's ruling). That is one commit of its own, which changes the description and the golden's entry for that one tool and nothing else, and the PR names the change. No name, input schema or output schema changes, and nothing of `countinghouse_settings`.
- **The session never reaches a worker** (B1), and a job's session is never in its data, its history or the store (the reviewer's ruling on B1's Task 3). It stays in the main thread's memory.
- **A session id is shown to no one:** not in a task, a report, a `get` answer or an error text.
- No API key, user name or secret in a log line, error text, history line or anything a module receives.
- **Running tests.** One file at a time. A file that starts a server runs through `node test/helpers/run-local.js <file>`, under the suite lock; a server-free one with `npx mocha --exit <file>`. Where a command below guesses wrong about an existing file, that file's header decides. No full suite locally: the PR's CI matrix is the gate.

## Review focus

1. **Another session's task, reached by id.** The local runner's ids count up from 1 (`String(nextId++)`), so today any session could name another's. The random id and the session check must both be in before the guard on `tasks/*` is lifted, in one PR. `tasks/cancel` reads the job and then removes it: both steps are checked.
2. **A finished task's owner.** `lib/job-sessions.js` forgets a one-off job's session at its last run (`lib/job-control-local.js:301`), because it exists for a run's caps. A view built on that map would show every finished task to every session, since all sessions share one key. The owner session must live as long as the job's record.
3. **Every section of the usage report.** Groups, days, the kept-out totals, the profiling (errors by code, server calls per call), the stand-in section and `source` are built from one filtered list. A section computed from the unfiltered pool names another session's tools. The cheap text match on a line is not the filter; the parsed record's `session` is. Memory and files are both filtered.
4. **The history's look-back.** `readHistory` reads the file's last 64 KiB and then drops other sessions' lines. Each session writes at most `MAX_SESSION_CHANGES` (32) changes, but with up to 256 sessions, other sessions' lines can push a session's own, and the global ones, out of that window. Also: a line with no `session` is shown to everyone, so a session's writer that forgets the field leaks it. (A change for all sessions is already shown to every session, by #296.)
5. **Ends and resumes.** An ended session's tasks must not become visible to a new session, and must not run on unread: they are cancelled at the session's end, and what ran is billed once (Task 4). A detach cancels nothing, and a resumed session, which keeps its id, sees its own again. A job from no session stays invisible to all.

---

### Task 0: the scope rule (`lib/session-scope.js`)

**Files:**
- Create: `lib/session-scope.js`
- Modify: `lib/mcp/gateway.js` (export `sessionIdOf`; `scopeOf(opts)`)
- Test: `test/sessions/20-session-scope.js` (server-free)

**Interfaces:**
- `scope.of(sessionId)` → a frozen `{shared, session}`: `shared` is `lib/sessions.js` `shared()`, and `session` the id or null.
- `scope.sees(scope, ownerSession)` → boolean. Outside shared mode: true (the owner key decides, as today). In shared mode: true only when `scope.session` is a string and equals `ownerSession`.
- `scope.INTERNAL`: a scope that sees everything, for the runtime's own work.
- The gateway's `scopeOf(opts)` is `scope.of(sessionIdOf(opts))`. A request whose `sessionIdOf` is undefined (an ended session, or none in shared mode) is refused before any view is built, as `handleToolsCall` refuses it.

- [ ] **Step 1: Write the failing tests.**
  - Outside shared mode `sees` is true for any owner.
  - In shared mode: A sees A's; A doesn't see B's; no scope sees a null owner, a null scope included; `INTERNAL` sees all.
  - The scope is frozen.
- [ ] **Steps 2–5:** run `npx mocha --exit test/sessions/20-session-scope.js` (it fails: no such module), implement, run it (it passes), commit.

**Size:** 0.25 day. **Needs:** nothing.

### Task 1: the usage report per session

**Files:**
- Modify: `lib/usage/report.js` (`buildReport` takes `session`)
- Modify: `lib/usage/read.js` (`streamUsage` takes `session`)
- Modify: `lib/mcp/gateway.js` (the report's call passes the request's session)
- Test: `test/usage/21-session-report.js` (server-free: records in memory and in files), plus usage 03, 13 and 20

**Interfaces:**
- `usageReport(args, {caller, isAdmin, session = undefined}, where)`. `undefined`: today's report, unchanged (`--stdio`, HTTP, the CLI). A string: only records whose `session` is that string, applied after the caller rule and whatever `isAdmin` says.
- `streamUsage(dir, {…, session})`: a line without the text `"session":"<id>"` is skipped before it is parsed, and every kept record is checked again after parsing, as the caller filter does.
- The gateway passes `session: sessions.shared() ? sessionId : undefined`. In shared mode `sessionIdOf` has already refused a request with no live session.
- A record with no `session` field (a call from before the shared runtime, or a job that outlived a restart) is in no session's report. The terminal shows it.
- The report's shape is unchanged.
- **The description** (`lib/mcp/tool-registry.js`, `PLATFORM_TOOLS`) is one text for every mode, so it must be true in each. After "from this process and earlier ones." it gains: "On a shared runtime, the calls of this session only." The reviewer checks the wording with the PR.

- [ ] **Step 1: Write the failing tests.**
  - With records of A and B in memory and in files: A's report counts A's calls only, and its text, serialized whole, has none of B's tool, pack, module or server names and no error code only B met. This holds for each `groupBy`, and for the day rows, the kept-out totals and the profiling.
  - A server-call record with no result yet is its session's.
  - A record with no session is in neither report.
  - A line whose tool name contains the text `"session":"<A's id>"` and whose own session is B's is not in A's report.
  - `isAdmin: true` with a session is still that session's report.
  - With `session` undefined, the report for the test's fixed records has the expected rows and totals written out in the test, admin and plain: the numbers `test/usage/03-report.js` already expects for the same fixture, not a second run of the same code.
  - Neither report contains a session id.
- [ ] **Step 2:** Run `npx mocha --exit test/usage/21-session-report.js`; it fails (A's report has B's tool).
- [ ] **Step 3:** Implement: one `own` predicate for caller and session, used by the memory filter and handed to `streamUsage`.
- [ ] **Step 4:** Run it, then one at a time `npx mocha --exit test/usage/03-report.js`, `…/13-report-part-a.js`, `…/20-session-records.js`; they pass.
- [ ] **Step 5:** Commit under the suite lock. The golden has not moved yet.
- [ ] **Step 6: The description, in its own commit.** Change the text; regenerate `test/mcp-contract/tools-list.golden.json` with `test/mcp-contract/capture-tools-list.js`; check that the golden's diff is that one tool's `description` and nothing else (`git diff --stat` shows the one file, and the diff one line). If `test/mcp-contract/02-approved-tool-changes.js` compares descriptions, list the change there with its reason. Run `node test/helpers/run-local.js test/mcp-contract/01-tools-list-unchanged.js` and `npx mocha --exit test/mcp-contract/02-approved-tool-changes.js`; they pass. Commit under the suite lock, with a message that says the golden moved and why. The PR's body names the change.

**Size:** 1.25 days. **Needs:** Task 0.

### Task 2: tasks by key and session

**Files:**
- Modify: `lib/job-control-local.js`: a caller's minted id, or a random one in shared mode; `job.session`; the scope in `getJob`, `removeJob` and `listJobs`
- Modify: `lib/job-control-common.js`: `seesJob(authCtx, ownerSession)`
- Modify: `lib/mcp/gateway.js`: the four `tasks/*` handlers take `opts` and put the session in their `authCtx`; the refusal for a shared runtime's session (`lib/mcp/gateway.js:1431` at 3f1fd23e) is removed
- Test: `test/sessions/21-session-tasks.js` (server-free: the local runner and `gateway.handle` with two sessions, as sessions 05 does)
- Test: `test/session-runtime/04-session-tasks-spawned.js` (a spawned runtime on `--sessionSocket`, two legacy sessions through the test's shim; no port), and `test/session-runtime/01-spawned.js`'s "no tasks" assertion, which this task reverses

**Interfaces:**
- **The id.** `enqueue` takes it in this order:
  1. **a caller-minted id,** when `addJob` is given one (`jobOpts.jobId`), in any mode. It must match `/^[A-Za-z0-9_-]{22,64}$/` (at least 128 bits as base64url or hex), and an id a job already has is refused (`ADD_JOB_ERROR`), nothing replaced. This is for M15, which mints 128 random bits at the gateway, so M15 changes nothing in the runner. Only the gateway sets it: the legacy `params.task` path and the HTTP job route never pass a client's value through, and a test holds that;
  2. in shared mode, with none given: `s-` and 32 hex characters (`crypto.randomBytes(16)`);
  3. otherwise `String(nextId++)`, as today.

  `lib/job-control.js:333` gives 24 hex to a BullMQ job made in a session; a shared runtime never uses that runner.
- **The owner session.** `job.session` on the runner's in-memory job: the creator's `authCtx.session`, or null. It is not in `job.data`, and `jobRecord` copies named fields, so no record carries it. It lives until the job's record is dropped (removal, the result's TTL, `close`). `lib/job-sessions.js` is unchanged: it still ends at the job's last run.
- **The check.** `common.seesJob(authCtx, ownerSession)` is `scope.sees(scope.of(authCtx.session), ownerSession)`, and true for `INTERNAL`. In shared mode it is asked before `ownsJob`, and `isAdmin` doesn't pass it.
  - `getJob` and `removeJob` (with `isRepeat` false): a job the caller's session doesn't see answers with the error an id not in the map gets (`GET_JOB_ERROR` or `REMOVE_JOB_ERROR`, `unknown job`), never `JOB_ACCESS_DENIED`.
  - `listJobs` keeps only jobs the session sees, then applies `LIST_MAX`.
- (Dropped in review: `JobControl.sessionOf(id)` had no caller. M15's tombstone takes the canceller's session from its `authCtx`, and keeps only its SHA-256.)
- **The gateway.** Each handler's `authCtx` is `{appKey, isAdmin, session: sessionIdOf(opts)}`, as `createTaskForToolCall`'s already is. A request whose `sessionIdOf` is undefined is answered as an unknown task (`tasks/list`: an empty list).
- A modern request's `tasks/*` stays an unknown method (`REMOVED_IN_MODERN`) until M15.
- A session's end cancels its tasks (Task 4). Until that task is in, an ended session's jobs run on and are seen by no one.

- [ ] **Step 1: Write the failing tests.**
  - Server-free:
    - A's task id matches `/^s-[0-9a-f]{32}$/`, and two ids differ. Outside shared mode the first id is `'1'`.
    - A job added with a minted id of 22 base64url characters has that id, in shared mode and outside it. A second job with the same id is refused and the first is unchanged. An id of 21 characters, one with a `/`, and one of 65 are refused. A minted id is scoped by session like any other.
    - A legacy `tools/call` whose `params.task` or arguments carry `jobId` gets the runner's own id, not the client's.
    - A's `tasks/get`, `tasks/result` and `tasks/cancel` work on A's task.
    - B's three requests naming A's id each equal, as serialized text, B's request naming a well-formed id that was never issued, once the id is substituted. A's task is still there afterwards, and not cancelled.
    - B's `tasks/list` is empty while A's has the task.
    - After the task completes, B still gets unknown (review focus 2).
    - With `isAdmin: true` in B's context, B still gets unknown.
    - After A ends, a new session C gets unknown for A's id.
    - A job added with `INTERNAL` is in no session's list, and `INTERNAL` lists every job.
    - No task, list or error text contains a session id, and `jobRecord` has no `session` key.
    - Outside shared mode `getJob` answers `JOB_ACCESS_DENIED` to another key, as today.
  - Spawned: A and B initialize; A calls a tool with `params.task`, polls `tasks/get` to `completed` and reads `tasks/result`; B's `tasks/get`, `tasks/result` and `tasks/cancel` with A's id are `unknown task`, and B's `tasks/list` is empty.
- [ ] **Step 2:** Run `npx mocha --exit test/sessions/21-session-tasks.js`, then `node test/helpers/run-local.js test/session-runtime/04-session-tasks-spawned.js` under the suite lock. They fail: the id is `'1'`, and the gateway answers "not served on a shared runtime yet".
- [ ] **Step 3:** Implement, the id and the check first, the gateway's refusal removed last.
- [ ] **Step 4:** Run both again, then one at a time `npx mocha --exit test/sessions/04-job-sessions.js`, `…/05-local-runner.js`, `…/test/usage/06-task.js`, and `node test/helpers/run-local.js test/session-runtime/01-spawned.js`. They pass.
- [ ] **Step 5:** Commit.

**Size:** 2.25 days. **Needs:** Task 0.

### Task 3: the settings history: what is left

**Files:**
- Modify: `lib/settings-tool.js`: `readHistory`'s look-back; `appendLine` and the other writers in a session's path
- Test: `test/sessions/23-session-history.js` (server-free), plus sessions 09 and stdio 14

**Interfaces:**
- **What master already does** (B2's Task 4): `readHistory(file, session)` drops a line whose `session` is another's, and never shows the field. `get` passes its session.
- **The look-back.** `readHistory` reads back in 64 KiB steps until it has `HISTORY_SHOWN` lines the session may see, or reaches the file's start, or has read 1 MiB. Under `--stdio` (no filtering) the first step already holds them, so its answer is unchanged.
- **Every line a session writes names it.** In a session's path (`ctx.shared`), `appendLine`, `recordAsked`, `writeCounts`, `recordUnanswered` and `recordReplayed` refuse to write a line with no `session`. B3's pack lines go through the same writers.
- **Lines for everyone are master's already** (#296): a line whose `change` starts with `all sessions` (it writes `'all sessions'` and `'all sessions, until the runtime restarts'`) is shown to every session without its `session` field. This task leaves that rule as it is; the look-back must keep it (sessions 12 has the case).
- The terminal's view of the history is ch-local's and shows every line.

- [ ] **Step 1: Write the failing tests.**
  - With three lines of B's, then 400 lines of A's (over 64 KiB), then one global line: B's `get` shows its three lines and the global one, and none of A's.
  - A's `get` shows its last 50.
  - A file over 1 MiB of A's lines after B's: B's `get` returns what the bound found, and returns.
  - Each session path that writes (a tightening, a refused loosening, a form that expired, a decline, a replay, the counts at a session's end) leaves a line with that session's id in the file; none is shown to the other session; no `get` answer contains a session id.
  - A writer called in a session's path with no session throws and writes nothing.
  - After 400 lines of A's, an earlier line of A's with `change: 'all sessions, until the runtime restarts'` is still shown to B, without `session`.
  - Under `--stdio`, `get`'s history for the test's fixed file is the expected list of lines written out in the test.
- [ ] **Steps 2–5:** run `npx mocha --exit test/sessions/23-session-history.js` (it fails: B's lines are missing), implement, run it, `npx mocha --exit test/sessions/09-tightenings.js` and `npx mocha --exit test/stdio/14-settings-tool.js` (they pass), commit.

**Size:** 0.5 day. **Needs:** nothing in this plan.

### Task 4: an ended session's tasks are cancelled

The reviewer's ruling (2026-11-15): nothing runs on that no one can read. When the registry says a session is gone, its tasks are cancelled, and what already ran is billed.

**Files:**
- Modify: `lib/job-control-local.js`: `cancelSession(session)`
- Modify: `lib/sessions.js` `close` (calls it)
- Test: `test/sessions/24-session-tasks-end.js` (server-free), and one case added to `test/session-runtime/04-session-tasks-spawned.js`

**Interfaces:**
- **When.** At the session's `'end'`: its `bye`, or its reconnect window expiring. A detach cancels nothing, and a session that resumes within its window keeps its tasks. `Registry.close()` (the runtime stopping) emits the same `'end'`; the local runner's jobs end with the runtime anyway.
- `JobControl.cancelSession(session)` → `{removed, finishing}` (counts), for every job whose `job.session` is that session:
  - waiting or delayed: removed, as `removeJob` removes one. It never runs and costs nothing;
  - active: marked cancelled. A run in a worker isn't interrupted (as `tasks/cancel`, it is cooperative): it finishes, is billed and recorded in usage under the session's id, as any run is. It is not retried, and its record and result are dropped when it finishes;
  - finished: its record and result are dropped now, not at the result's TTL.
- A scheduler whose session it is (none can be made over MCP today) is stopped the same way.
- The run that is finishing is still bounded by the ended session's last caps (B1's Task 4, #251), and its hops by B3's Task 4.
- A job from no session is untouched. Outside shared mode `close` is never reached for `--stdio`'s one session while the runtime serves, and nothing changes.

- [ ] **Step 1: Write the failing tests.**
  - A has one delayed task, one active and one completed. A ends:
    - the delayed one never runs, and no usage record or charge is made for it;
    - the active one's handler finishes, its usage record carries A's id, it is charged once, it is not retried after a failure, and its record is gone once it finishes;
    - the completed one's record is gone at once.
  - After that, `INTERNAL`'s `listJobs` has none of A's, and `job-sessions` holds no entry of A's once the active run has finished.
  - B's tasks are untouched by A's end.
  - A detached and then resumed keeps all three, and reads the completed one's result.
  - A session C opened after A's end gets `unknown task` for each of A's ids.
  - Spawned: A makes a long task and its shim says `bye`; the runtime's job count for A falls to zero once the run ends, and B's task completes.
- [ ] **Steps 2–5:** run `npx mocha --exit test/sessions/24-session-tasks-end.js` (it fails: the delayed task runs), implement, run it, `npx mocha --exit test/sessions/04-job-sessions.js`, `npx mocha --exit test/sessions/21-session-tasks.js` and `node test/helpers/run-local.js test/session-runtime/04-session-tasks-spawned.js` under the suite lock (they pass), commit.

**Size:** 0.75 day. **Needs:** Task 2.

## Sizes and order

| Task | Days | Needs |
|---|---|---|
| 0. `lib/session-scope.js` | 0.25 | – |
| 1. The usage report per session, and its description | 1.25 | 0 |
| 2. Tasks by key and session | 2.25 | 0 |
| 3. The settings history: what is left | 0.5 | – |
| 4. An ended session's tasks are cancelled | 0.75 | 2 |
| **Total** | **5** | |

- **Build order** (B's, one implementer, interleaved with M13; the B3 tasks are the plan beside this one):
  1. B5 Tasks 0 and 1;
  2. B3 Tasks 1, 2 and 3;
  3. B5 Tasks 2 and 4;
  4. B3 Tasks 3b, 4 and 7;
  5. B3 Tasks 5 and 6;
  6. B5 Task 3;
  7. B3 Tasks 8 and 9.
- **What could run beside what,** with a second implementer: Tasks 1, 2 and 3 beside each other once Task 0 is in (Tasks 1 and 2 both touch `lib/mcp/gateway.js`, in different handlers); all of this plan beside B3's Tasks 1–7. B3's Task 8 waits for Task 1, since until then a session's usage report would name another session's pack and tools. M17 waits for both plans.
- Each task is its own PR. Task 2 is a trust-boundary PR.

## What M17 builds on

M17 (`docs/superpowers/specs/2026-11-15-mcp-completeness-design.md`, sections 9 and 10) scopes modern tasks and stored results by session. It calls:

- `scope.of(sessionId)` and `scope.sees(scope, ownerSession)`: the one check for a task, a cancelled task's tombstone and a stored result (`record.session`). A miss is the caller's own "not found".
- `sessionIdOf(opts)` and `scopeOf(opts)`, exported by the gateway, for `tasks/get`, `tasks/update`, `tasks/cancel` and `resources/read`.
- `JobControl.getJob(authCtx, id, cb)`, `removeJob` and `listJobs`, with `authCtx.session` set: the session check is inside the runner, so M15's handlers get it by passing the session. A job's owner session is read main-side as `job.session` and is never sent anywhere; a tombstone keeps the canceller's session only as its SHA-256 (`lib/task-tombstones.js` `sessionKey`).
- The id: M15 mints its own and passes it as `jobOpts.jobId`, which Task 2's runner takes (shape checked, a duplicate refused). With none given, a shared runtime's `s-` id is already unguessable.
- Not here: a session's stored results end with the session but survive a runtime restart. `Registry.close()` emits the same `'end'` as a `bye` (`lib/session-transport/registry.js:251`), so `lib/sessions.js` can't tell the two apart today. M17, or R1 for §4a's partitions, needs that told apart; tasks don't, since the local runner's jobs don't survive a restart.

## Decided, and what is left open

- **Decided (the reviewer, 2026-11-15): the usage report's description is made true on a shared runtime,** and the golden moves for that one tool, in its own commit (Task 1, Step 6). Calls made before the shared runtime carry no session and are in no session's report; the terminal shows them.
- **Decided: an ended session's tasks are cancelled** when the registry says the session is gone, billed for what ran (Task 4). §2's "a job outlives its session's loosenings" then covers only a run already in a worker when the session ends.
- **The id's length.** The MCP completeness spec (section 9) says a session's job "already gets" 128 random bits. `lib/job-control.js:333` gives 96 (`randomBytes(12)`), and only on the BullMQ runner, which a shared runtime never uses. Task 2 gives 128 on the local runner. The spec's sentence should point there.
- **Decided, from B's review:** the runner takes a caller-minted id (Task 2), and Task 3 no longer covers the all-sessions line, which #296 shipped.
- **The terminal's report by session.** `countinghouse-usage` shows every session's records but can't group by session. Not needed for release 1; a `--groupBy session` would be a later change.
