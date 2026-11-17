# MCP completeness M16: task notifications and a task's statusMessage. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** revision 2, APPROVED by the Reviewer (#354), with the rulings below: D1 yes, through tasks/get's own lookup; D2 yes, with send-time rechecks; D3 yes; D4 reversed (tasks run in the shared runtime by session, B5 Task 2). Written against master at 96e231ae. Order: Task 1 after #329 merges; Task 2 after B5 Task 2 (B, d8caa040, on #329) merges.

**Goal:** A 2026-07-28 task's `statusMessage` says how far it is (its last `ctx.job.progress` as `NN%`), or for a run that left no result its failure's code, never module text. A client that names its tasks on `subscriptions/listen` gets `notifications/tasks` (the full task, as `tasks/get` would return it) when one changes, so it needn't poll. Polling stays the default and works exactly as M15 left it.

**Architecture:**
- **`statusMessage`** is computed in M15's `modernTaskOf` from the job record: `job.progress` (a finite number, clamped to 0–100 and rounded) while `working`, and the failure's code for a `failed` run. Both runners already keep `job.progress` (`updateJobProgress`).
- **A main-thread event bus, `lib/task-events.js`,** keyed by the task's minted `t-` id (`TASK_ID`: the Redis runner's `QueueEvents` give only an id), is told by both job runners when a 2026-07-28 job changes (active, progress, completed, failed), and by the gateway's tasks/cancel (cancelled). In the Redis runner that's the `QueueEvents` handlers, including `'progress'`, which master ignores today. In the local runner it's its state changes and `updateJobProgress`.
- **The listen hub (`lib/mcp/subscriptions.js`) takes a fourth filter, `taskIds`.** A listener's agreed ids are a `Set`. On a task event the hub builds the task as `tasks/get` would (one function, shared with M15's handler), for each listener whose set holds that id. It writes `notifications/tasks`, coalesced per (listener, task), and drops the id once the task is terminal.

**Tech stack:** Node ≥ 22.16, mocha; BullMQ's `QueueEvents`; M15's `modernTaskOf`, `taskFailure`, `taskCallResult` and tombstones.

**Spec:** `docs/superpowers/specs/2026-11-15-mcp-completeness-design.md` §9 (`statusMessage`, `notifications/tasks`) and §6 (a task's progress is its `statusMessage`, never `notifications/progress`). The ext-tasks text (specification/2026-07-28/tasks.md, "Task Status Notifications", "Error Handling", "Security Considerations"; C's reading, 2026-11-16) gives the shapes below.

## What ext-tasks says (quoted from C's copy)

- **The filter is a list.** `params: {notifications: {taskIds?: string[]}}` on `subscriptions/listen`.
- **The ack** is `notifications/subscriptions/acknowledged`, with `params.notifications.taskIds` listing "the task IDs it has agreed to send task status notifications for, if any". The server may agree to fewer than asked.
- **A non-declaring client** asking for task notifications: "the server **MUST** return a JSON-RPC error", -32021 with `data.requiredCapabilities.extensions["io.modelcontextprotocol/tasks"] = {}`.
- **The params:** `TaskStatusNotificationParams = NotificationParams & Task`. "Each notification carries a complete `DetailedTask` for the current status, identical to what `tasks/get` would have returned at that moment": `completed` with `result`, `failed` with `error`.
- **When:** "Servers **MAY** push status updates". No trigger is named.
- **Never on the stream:** "`notifications/progress` and `notifications/message` notifications **MUST NOT** be sent on the `subscriptions/listen` stream for a task."
- **Auth binding:** "Servers MUST perform authentication and authorization checks on each task-related request". Task ids are bearer-grade, and there's no `tasks/list`, so another caller's tasks never correlate.

## Decisions for the Reviewer

- **D1. What's agreed.** Of the ids asked for, the ack lists exactly those that are the caller's own 2026-07-28 tasks right now. **Ruled:** decided by the SAME lookup `tasks/get` uses for this request, never a separate owner check. After B5 Task 2 that's `getJob`, with `seesJob` (the session scope) before `ownsJob`. So a session's listener can never agree to another session's task, and the two stay identical by construction. A tombstoned task of its own counts. Foreign, unknown, malformed, legacy and expired ids are left out, with no error and no difference between them (no existence leak, as `tasks/get`'s one -32602). At most `MAX_TASK_IDS` = 64 asked per listen: more is -32602 ("at most 64 task ids").
- **D2. When a notification is sent:** on a change to what `tasks/get` would return. That's `working` → its first progress, each later progress, and the terminal state (`completed`, `failed`, or `cancelled` by its owner's `tasks/cancel`). Progress is coalesced to at most one per (listener, task) every `TASK_NOTICE_MS` = 1000, always the latest. A terminal state is sent at once, exactly once, and the id then leaves the listener's set. A task already terminal when the listen opens is sent once, right after the ack (it saves a poll). **Ruled, also:** a listener's ids are re-checked at send time through the same lookup (a removed or no-longer-visible job leaves the set silently), and a closed listener frees its coalescing timers.
- **D3. statusMessage:**
  - `working`: `"NN%"` from a finite numeric `job.progress` (clamped 0–100, rounded); nothing for any other value (the spec's own words for progress, `ctx.job.progress(n)`).
  - `failed` (a run that left no answer): the failure's code, or `"failed"` when there's none (a job timeout's error has no code until JOB_TIMEOUT). Never module text. After #369 a module unloaded, reloaded or suspended under a run is `completed` with isError, as inline, so it has no `statusMessage`. What stays `failed` is the runner's timeout (`JOB_TIMEOUT`, since #375) and a refused auth re-check (its code, e.g. `SYSTEM_ERROR_UNKNOWN_USER`) (the Reviewer, 2026-11-17).
  - `completed` and `cancelled`: no `statusMessage`.
  - The legacy era's statusMessage stays as M15 left it.
- **D4. Shared runtime's sessions (REVERSED by the Reviewer):** B5 Task 2 removes M15's shared-runtime refusals and turns tasks on in the shared runtime, scoped by session. So M16 works there too: the listener's session is the request's session, and D1's shared lookup does the scoping.
- **Who extracts the builder (Reviewer, to avoid a collision in `tasks/get`):** B, in B5 Task 2 (branch `b-b5-session-tasks`; it opens after #329 merges). They stay in `lib/mcp/gateway.js`, because they need its internals, and are exported:
  - `findModernTask(authCtx, taskId) -> Promise<{taskId, record} | {taskId, tombstone} | null>`: tasks/get's own lookup (getJob, `seesJob`, `ownsJob`, plus the tombstone's owner and session). `null` is everything tasks/get answers -32602;
  - `detailedTask(found, cdifInterface, authCtx) -> Promise<DetailedTask>`: tasks/get's exact body (the cancelled view, or the view plus `result` or `error`);
  - `modernTaskView`, `cancelledTaskView` (used by `detailedTask`), and `withTaskSession(authCtx, opts)` (the request's session; a non-live one sees nothing).
  Modern tasks/get is `findModernTask`, then `detailedTask`, then the reply. M16 calls the same two and never touches tasks/get's handler.

## Global constraints

- **Identical to `tasks/get`.** The notification's task is built by `detailedTask`, the function `tasks/get` itself answers with (B5 Task 2). One code path, never two.
- **Owner-bound at send time too.** A listener receives an event only for an id in its agreed set, and its owner check is re-run when the task is built (the same `JobControl.getJob(authCtx, id)`), so a set built at listen can never leak.
- **Nothing new on a module's path.** The runners' hooks are a function call on the main thread; a module never sees a listener, a subscription id or another task.
- **On the stream, only:** `notifications/subscriptions/acknowledged` and `notifications/tasks` (plus the list types already served). Never `notifications/progress` or `notifications/message` for a task.
- **Limits:** the hub's existing per-key, per-session and total listener limits stay; at most 64 task ids per listener.
- **Running tests:** one file at a time, capped at 2 GB with no swap and MemAvailable ≥ 3 GB, under the suite lock. Server files go through `run-local`. No folder runs locally.

## Review focus

1. **Another caller's task id** in `taskIds`, on its own or beside the caller's own: it's never agreed, never notified, and the ack doesn't differ from one with an unknown id (Task 2).
2. **A task cancelled while running:** M15 keeps a lasting tombstone and the job runs on. The notification says `cancelled` once, and then nothing more when the run ends (the tombstone wins, as in `tasks/get`) (Task 2).
3. **A busy progress reporter** (`ctx.job.progress` in a tight loop): at most one notification a second per listener and task, always the latest value (Task 2's coalescing).
4. **A listener that disconnects with ids pending:** its timers are cleared and its set is dropped, so no write to a closed stream (Task 2).
5. **Redis and local runners differ:** the local runner has no `QueueEvents`. Both feed `task-events`, and the test runs the main case on each store (Task 1, Task 2).

---

### Task 1: statusMessage, and the task events

**Files:**
- Create: `lib/task-events.js`
- Modify:
  - `lib/mcp/gateway.js`: `modernTaskOf` (the one place the base view is built) gains `statusMessage` per D3;
  - `lib/job-control.js`: the `QueueEvents` `'active'`, `'progress'`, `'completed'` and `'failed'` handlers, and `removeJob`, emit for a job whose `data.era === 'modern'`;
  - `lib/job-control-local.js`: `run`'s active, `updateJobProgress`, `finish`, `failed`'s final, and `removeJob`.
- Test: `test/mcp-contract/27-tasks-modern.js` (statusMessage cases); `test/jobs-local/03-task-events.js` (server-free, local runner)

**Interfaces:**
- Produces: `taskEvents.on(fn(taskId, kind))` and `taskEvents.emit(taskId, kind)`, with `kind ∈ {'active', 'progress', 'completed', 'failed', 'cancelled', 'input_required'}`. `input_required` (added after #374, M22; the Reviewer, 2026-11-17): a pass that ended on its question, the local runner's hold and skip branches and the Redis runner's `completed` event when `job.data.asking` is set. The hub is unchanged: terminal is read from the view, so it is coalesced as `working` is and the id is kept. A question's wait ends unseen (tasks/get reads `ASK_EXPIRED` once the record's `expiresAt` has passed; no runner changes the job then), so task-events itself tells `failed` at that time: one unref'd timer per waiting task, cleared by any later kind for it. `cancelled` is the gateway's, told once tasks/cancel has written the tombstone; a runner's removal tells nothing (a listener's send-time lookup could otherwise find neither the job nor the tombstone).
- Consumes: nothing from B5 Task 2 yet; Task 2 does.

- [ ] Failing tests:
  - a task whose handler calls `ctx.job.progress(42.4)` reads `statusMessage: "42%"` on `tasks/get` while working, and nothing once completed;
  - a progress of `"half"` or `{}` gives no statusMessage;
  - a run past `--jobTimeout` reads failed with statusMessage `"failed"` (its error has no code); never module words. (A lost run's `MODULE_UNLOADED` case is dropped: after #369 that run is `completed` with isError.);
  - the local runner emits active, progress, completed and failed for a modern job (a removal: nothing; the gateway tells cancelled), and nothing for a legacy job.
- [ ] Implement. The fixture `m15-tasks` gains an action `progress` that reports 10, 50 and 90 a little apart, then answers.
- [ ] Run: PASS. Commit.

### Task 2: notifications/tasks on a listen stream

**Files:**
- Modify:
  - `lib/mcp/subscriptions.js`: a listener's `filter.taskIds` is a `Set`; `taskChanged(taskId, kind)` gives each listener holding the id, coalesced per D2, a built task; terminal ids leave the set; a closed listener clears its timers;
  - `lib/mcp/gateway.js` `handleListen`:
    - `taskIds` parsed: an array of strings, at most 64, else -32602;
    - the extension declared, else -32021 with `requiredCapabilities`;
    - the agreed ids (D1), with the owner check of `tasks/get`;
    - the ack's `notifications.taskIds`;
    - an already-terminal task sent right after the ack;
  - the hub is wired to `task-events` where the hub is made.
- Test: `test/mcp-contract/37-task-notifications.js` (spawned, `--workerThread --store local`, like 27; one case also on `--store redis` with run-local's private Redis). The SSE listen client comes from `test/mcp-contract/09-subscriptions.js`. Plus a shared-runtime case (D4 reversed): two sessions each listen for both sessions' task ids, and each is agreed and notified only its own.

**Interfaces:**
- Consumes: Task 1's `taskEvents`, and B5 Task 2's `findModernTask` (at listen, and again at each send) and `detailedTask` (each notification's params), with the authCtx from `withTaskSession`.

- [ ] Failing tests:
  - listen with `taskIds: [own, foreign, unknown, 'not-a-task']`: the ack lists only `own`, and a listen with `[foreign]` alone acks `[]`, the same as `[unknown]`;
  - the `progress` task notifies `working` with `"10%"`, then `"50%"` or `"90%"` (coalesced, the latest), then `completed` with a `result` deepEqual to `tasks/get`'s at that moment, and nothing after;
  - a failed run notifies `failed` with `error` and a code `statusMessage`;
  - an owner's `tasks/cancel` notifies `cancelled` once, and nothing when the run ends;
  - a task already completed at listen time is sent once after the ack;
  - no `notifications/progress` or `notifications/message` line ever appears on the stream;
  - `taskIds` without the extension declared is -32021 with `requiredCapabilities`;
  - 65 ids is -32602;
  - a disconnect with a coalescing timer pending writes nothing after;
  - a listen with `toolsListChanged` only is unchanged (09 stays green);
  - an id whose job is removed after the listen leaves the set without a write (the send-time recheck);
  - on the shared runtime, session A's listener is never agreed or notified session B's task.
- [ ] Implement. Run: PASS, plus mcp-contract 09, 27, stdio 23, session-transport 05. Commit.

### Task 3: Docs

- [ ] `docs/module-development.md`: `ctx.job.progress(n)` inside a task becomes its `statusMessage` (`NN%`) and reaches a client that listens for the task.
- [ ] `docs/cli-and-api-reference.md`: `subscriptions/listen` with `notifications.taskIds`, the ack, the limits. In Task 2's PR.

## Out of scope

- ~~`input_required` (M22, C's)~~: in scope since #374 merged (see Task 1's Produces); its `inputRequests` come in the same `modernTaskView`.
- Per-session tasks on the shared runtime (B5).
