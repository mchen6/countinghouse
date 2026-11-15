# One shared runtime per user, many client sessions

Status: a design for the security review. No code yet.
Author: implementer C, 2026-11-15. Written against countinghouse master 842c5525 and ch-local main.
Spans countinghouse (the runtime: sessions, per-session settings, the session transport) and ch-local (the daemon, the shim, the lifecycle).

## Why

Today every client session (each Claude Code window, each Cursor workspace) launches its own `ch-local start --stdio`. Each of those spawns its own runtime, with its own module workers and validators.

Ten sessions are ten runtimes. The spike and A's measurements put one runtime with its workers at about 350–430 MB, so ten sessions cost several GB, mostly the same modules loaded ten times.

Matt wants one runtime per user in release 1, shared by every session. To make that work, this design settles:
- what a session is once it's no longer a process;
- whose settings a session may change;
- how a session reaches the runtime;
- what happens when that runtime stops.

## Goals

- One runtime per OS user and ch-local home, shared by all of that user's client sessions on the machine.
- Every client keeps launching a stdio server, so no client changes. Elicitation, the settings tool, list_changed and notices keep working, per session.
- No secret in any client's configuration.
- Part 3's guarantees still hold:
  - a session that answers its own dialog loosens only its own calls;
  - nothing loosens another session's limits from conversation;
  - the operator ceiling binds everything.
- Never silent: each change is announced to the sessions it affects.

## Non-goals

- More than one OS user per runtime. A shared runtime is one user's. Multi-user stays the HTTP hosting profile, with API keys.
- Hosting third-party servers in release 1 (Matt).
- Remote clients. The transport is local only.

## The shape

```
 client A ──stdio── ch-local connect ─┐
 client B ──stdio── ch-local connect ─┼─ session socket ─ runtime ── workers, validators
 client C ──stdio── ch-local connect ─┘   (owner-only)       │
                                                       IPC control channel
                                                             │
                                                       ch-local daemon
                                                       (owns the runtime: packs in place,
                                                        settings watcher, ceiling, history)
```

- **`ch-local connect`, the shim.** It's what a client's config launches. It relays the client's stdio to the runtime's session socket, runs the client-conditions check (its parent is the client), and reconnects if the runtime goes away.
- **`ch-local daemon`.** It's started by the first shim and owns the runtime, as `ch-local start` does today. It holds the IPC control channel, the in-place pack applier, the settings watcher and the history. It is not a system service: no launchd, systemd or Windows service.
- **The runtime** listens on the session socket. Each accepted connection is one session.

The runtime, not the daemon, takes the session connections. That saves a copy of every byte through a second process. It also keeps the per-session MCP state (initialize, list_changed, the dialog) in the process that has it. The daemon only learns which sessions exist.

## 1. The session transport

**Where it listens.**
- **Linux and macOS:** a Unix socket in `<home>/run/daemon/`.
  - That directory is created 0700 and checked at each start: owned by the user, not a symlink, mode 0700. A wrong owner or mode refuses to start.
  - Unix socket paths have a length limit (108 bytes on Linux, 104 on macOS). The runtime checks it and refuses a path over the limit; the spike hit this. Here it's `~/.countinghouse/run/daemon/rt.sock`.
  - When `<home>` is long, the runtime uses `$TMPDIR/ch-<uid>/` instead, created and checked the same way, as tmux does.
- **Windows:** a named pipe, `\\.\pipe\countinghouse-<16 hex>`. The hex comes from a hash of the user's SID and the home path, so another user's daemon or home never shares the name.
  - Node can't set a pipe's DACL. The default lets the creator, SYSTEM and administrators connect, and may let others open it read-only.
  - So the pipe alone isn't the boundary. The connect secret is (below).

**The connect secret.**
- A new random 32 bytes each time the runtime starts.
- Written to `<home>/run/daemon/secret` before the socket listens: 0600 on POSIX, and on Windows an owner-only DACL through `lib/win-acl.js` (#201's code).
- A connection's first frame must present it. A wrong one is compared in constant time and refused. A connection that sends nothing valid within 5 seconds is closed. Five failures in a minute from the endpoint slow the next accepts (1 s each), so no tight guessing loop is possible.
- **What this gives on all three OSes:** only a process that can read the user's own files can attach. That's the same user, or an administrator.

**Framing.** Newline-delimited JSON, one frame per line, three kinds:
- `{"hello": {secret, protocol: 1, resume?, client: {pid, env}}}`: shim to runtime, first and once. `env` is the few variables the client conditions need, such as `CLAUDE_PROJECT_DIR` and the entrypoint.
- `{"mcp": <a JSON-RPC message>}`: either way, exactly the client's MCP traffic.
- `{"ctl": {...}}`: either way, session control.
  - runtime to shim: `may-elicit?`, `drain`, `notice-copy`;
  - shim to runtime: `may-elicit` answers, `bye`.

The shim wraps every line it reads from the client in `mcp`, so a client (or anything able to steer one) can never produce a `ctl` frame. A frame over `--maxRequestBody` is refused, as stdio does today.

**The hello's answer:** `{"welcome": {session, resumeToken, runtime: {version}}}` or `{"refused": {code}}`. `session` is an opaque id the runtime mints (16 random bytes). `resumeToken` lets this shim reattach the same session after a restart (section 6).

## 2. Identity: one user, many sessions

R2-1 made `ctx.caller.id` *the user*, so a module's per-user data stays together. All of one person's sessions are that one user. So:
- **Modules see one caller id** for the machine's user, exactly as the single-identity profile gives today. No module learns there are sessions, or how many.
- **The session lives on the main thread only.**
  - Each MCP request carries its session from its connection, and the session reaches every place that needs it: per-session settings, per-session pack listing, per-session notices, per-session confirmations, usage records.
  - Hops inherit the session of the call they're part of, and so does a job created by a call.
  - The session never goes to a worker. The values that differ per session (the output cap and the request timeout) travel with each call (section 3).
- **Usage** records each call's session id, opaquely, so the receipts and the usage report can be read per session. A session id never carries the user's name, and never a key.

## 3. Settings: three layers

| Layer | Who changes it | Scope | Lasts |
|---|---|---|---|
| The operator ceiling (`ceiling.json`) | the operator | everything | as the file says |
| Global defaults (`<home>/settings.json`) | the terminal command (`ch-local settings set`), or the settings tool for neutral values and tightenings | every session | until changed |
| Per-session overrides | the settings tool, in conversation: a confirmed loosening, or any tightening, in that session | that session's calls only | that session's life |

- **Effective value** for a call = min(ceiling, session override if set, else global default), with "min" meaning the tighter. The ceiling is checked again at every apply. A loosening in conversation still needs part 3's confirmation, in that session's own dialog.
- **Applied per call, never broadcast.**
  - The main thread reads each call's effective `maxOutputBytes` and `requestTimeout` from its session: for the deadline, the output check and the hop caps.
  - It hands the cap to the worker with the call, so the callee's own pre-post check uses that call's value.
  - Today's `options.*` mutation and the `broadcastLiveOptions` copy to every worker stay for global defaults only. A per-session override never touches `options`.
- **Exactly where each per-call value applies.** Each line below reads `options.*` today. Each becomes the call's effective value: the session override if set, else the global default, bounded by the ceiling. A hop, a peer invoke and a job take the value of the outer call they're part of.

  | Value | Read today at | Becomes |
  |---|---|---|
  | `requestTimeout` | `lib/timer.js` (the call's own timer, main thread) | the call's effective timeout |
  | | `lib/device-manager.js` hop `dropAfter` (the routed hop's deadline, and its token TTL) | the outer call's timeout |
  | | `lib/device-manager.js` reload wait (`REPLACE_SPAWN_BOUND_MS` plus the timeout) | the waiting call's timeout |
  | | `lib/peer-channel-broker.js` `callerTimeoutMs` and `tokenTtlMs` | the announcing call's timeout, held with the announcement |
  | | `lib/peer-worker.js` caller's per-invoke timer, `lib/handler-ctx.js` (in the worker) | the deadline handed to the worker with the call |
  | `maxOutputBytes` | `lib/device-manager.js` reply cap, and `hop-input.sizeRefusal` for a hop's input | the call's effective cap |
  | | `lib/lean-worker.js` the callee's own check before posting (in the worker) | the cap handed to the worker with the call |
  | | `lib/peer-channel-broker.js` input and output caps, held-byte shares | the announcing call's cap; the shares stay per runtime, sized from the largest active cap |
  | | `lib/worker-message.js` message envelope cap, and `lib/validator-pool.js` heap | per runtime, sized to the largest active cap (they bound buffers, not one call) |
  | `locale` | `lib/countinghouse-error.js` rendering an error's text | the session's locale, applied where the gateway renders the answer for that session |

- **Validators sized for the largest active cap.**
  - The pool's heap limit is shared. It's raised when a session's effective cap needs more than the current size (a graceful replace, as #165's resize does), and lowered lazily once the last session needing it ends.
  - A residual: a session can raise its own cap up to the ceiling and so enlarge the shared validators. The ceiling bounds it.
- **"This start only" becomes "this session only".** That's everything part 3 scoped to a runtime start: a conversational loosening, a pack turned on in conversation, the decline lock.
- **The confirmation state splits:**
  - per session: the staged change, its nonce, the decline lock per kind, and the forms shown;
  - per user (that is, per runtime): a cap on forms across all sessions, a 30-minute decline count per kind, and the nonce MAC key. Three declines of one kind across any sessions stop forms of that kind until the daemon restarts.

  So a prompt injection can't fan out across a user's sessions to wear the dialog down. The MAC payload already binds the session id.
- **Every change is announced.**
  - A per-session change goes to its session: `notifications/message`, the one-line notice on its next result, and the history (naming the session opaquely).
  - A global change goes to every session the same way.
  - The notice queue, the notifier and `logging/setLevel`'s level become per session. A global notice is copied into each session's queue, so the first session to call no longer drains everyone's.

## 4. Packs

- **A pack turned on from the terminal** is global: loaded once, listed to every session.
- **A pack turned on in conversation** is loaded once, shared, and listed only to the session that turned it on.
  - The runtime keeps, per such pack, the set of sessions that list it. A session that ends is removed from the set.
  - The pack is unloaded once its set is empty and the global settings don't list it.
  - A tool listed to one session is refused to another (`TOOL_NOT_LISTED`), not just hidden from its list.
- **tools/list and list_changed are per session.** Each session's listed fingerprint is its own, and a change that affects only one session's list notifies only that session.

## 5. The control channel and the daemon

- The control channel stays a single IPC channel between the daemon and the runtime: one per runtime, and so one per user. ch-local's requests (load, unload, reload, set, notice) arrive on it as now.
- Requests about one session name it: a this-session pack, or a may-elicit answer when the daemon relays one.
- **may-elicit moves to the shim.**
  - The client-conditions check (`lib/client-conditions.js`) must read *this session's* client: the shim's parent, its environment, its project directory.
  - So the runtime asks the session's own shim (`ctl: may-elicit?`), and the shim answers from its own check.
  - The latch (a hook seen once holds) is per session. A shim that doesn't answer within its wait counts as no.
- The daemon holds the GitHub token (from `gh auth token`, in memory only), the run directory, the heartbeat and collection, as `start` does today. It's one per user, so one credential set.

## 6. Lifecycle

**Starting.**
1. A shim reads `<home>/run/daemon/daemon.json` (`{pid, socket, runtimeVersion, started}`).
2. If the pid is alive and a connection completes the hello, it's attached.
3. Otherwise it takes `<home>/run/daemon/start.lock` (ch-local's `lib/lock.js`, 30 s). Under the lock it checks again, then spawns `ch-local daemon` detached: on Windows hidden (`windowsHide`), with its own process group, and no console.
4. The daemon spawns the runtime and writes `daemon.json` once the socket listens.
5. The shim waits up to 20 s for a hello to succeed. Two shims arriving together start one daemon.

**Idle stop.** After the last session leaves, the daemon waits `daemonIdleMinutes` (default 10), then stops the runtime and exits. A shim arriving during the wait cancels the stop.

**Upgrade.** `ch-local upgrade` (or the daily automatic upgrade) installs the new version, then tells the daemon. The daemon:
1. stops accepting hellos;
2. sends every shim `ctl: drain`;
3. lets in-flight calls finish, up to `--requestTimeout`;
4. stops the old runtime;
5. starts the new one.

Each shim reconnects to the new runtime (below). A pack change that needs a runtime restart takes the same path.

**Reconnecting.** On EOF, a `drain`, or a hello refused because the runtime is new, the shim does four things:
1. It answers every request it had relayed and not seen answered with a JSON-RPC error that marks the call retryable: `data['countinghouse/code'] = 'RUNTIME_RESTARTED'`, `retryable: true`.
2. It reattaches, starting the daemon if needed, with its `resumeToken`.
3. It replays the client's `initialize`, keeping the answer to itself (the client already has one), then `notifications/initialized`.
4. It sends the client `notifications/tools/list_changed`, so the client lists again.

The client sees failed calls it can retry, never a broken MCP session.

**Per-session state across a restart.**
- A session's overrides and this-session packs are written to `<home>/run/daemon/sessions/<session>.json` (owner-only) whenever they change.
- On a resume with a matching token they're restored and announced ("restored after a runtime restart").
- Without a resume, a new session starts from the global defaults: tighter or looser than it had. That is announced too.
- The files are removed when a session says `bye`, and collected when their session is gone and older than a day.

**Crash of the daemon or the runtime.** If the runtime exits unexpectedly, the daemon restarts it once immediately, then backs off: 1 s, 5 s, 30 s, then stops after 5 failures in 10 minutes and logs why. The shims reconnect as above. If the daemon itself dies, the next shim reconnect finds the pid dead and starts a new one under the lock.

## 7. Windows and macOS

**Windows.**
- The named pipe as above.
- The secret's DACL comes from `lib/win-acl.js`.
- The daemon runs detached and hidden, with no Windows service and no Task Scheduler.
- `ch-local connect`'s parent-process check (the client conditions) uses the existing PowerShell ancestry reader.
- Long paths are fine for pipes.

**macOS.**
- The 104-byte socket path limit and the `$TMPDIR` fallback, as above.
- No launchd agent: the shim starts the daemon.
- The managed preferences and plist sources in the client conditions stay as they are.

**Linux.** As described. `XDG_RUNTIME_DIR` isn't required: `<home>/run/daemon` is used, so it behaves the same with or without a desktop session.

## 8. The shim's cost

Measured on the dev VM with Node 24, using a minimal relay (connect, pipe stdin to the socket and back): **46 MB RSS but 13 MB PSS each**, five running at once, since they share Node's code pages. The heap is about 5 MB; the rest is Node itself. A smaller heap flag doesn't change it. Loading the client-conditions scanner adds about 1 MB.

So ten sessions cost about 130 MB of PSS (about 460 MB of RSS) for shims, beside one runtime, against ten runtimes today. The shim keeps its requires minimal: the relay, the lock, the client conditions. ch-local's install and upgrade code isn't loaded.

## 9. Threat model and residuals

**Who could attach to the session socket:**
- *Another OS user:* blocked by the owner-only directory (POSIX) and by the connect secret's owner-only file (all three OSes). On Windows, the pipe's default DACL alone isn't relied on.
- *An administrator, or root:* can, as they can read the user's files today. Out of scope.
- *Any process running as the same user*, including the AI itself through a shell: can attach and make a session. **That is the same as today**, where such a process can start its own `ch-local start`.

**What a session can do to others:**
- It can't change another session's settings. Per-session overrides are its own; only the terminal changes the global defaults.
- A self-answering fake session (it attaches, presents its own client conditions, and accepts its own dialog) loosens only its own calls. That's part 3's residual, kept confined as it is today.
- It can't see another session's notices, staged confirmations, this-session packs or usage records. Those are keyed by session on the main thread.
- It does share what one user always shares: module data (same caller id) and global packs.

**Fan-out:** the per-user form cap and decline count stop a prompt injection from wearing the dialog down across sessions.

**Resource effects, bounded by the ceiling:**
- A session's raised cap enlarges the shared validators.
- A session can keep the runtime busy within the per-caller validator throttle and the message rate. With one caller id, those throttles are shared by all of the user's sessions, which is already today's per-user behaviour.

**Residuals to state in docs/security-model.md:**
1. Same-user processes can attach. That's unchanged.
2. One session's heavy use slows the others: one runtime.
3. A daemon restart drops in-flight calls (they're retryable) and, without a resume, a session's overrides (announced).
4. The connect secret is only as strong as the user's file permissions.

## 10. Migration and the per-session mode

- `ch-local connect` is the new client entry. Client snippets and `ch-local install` write it. Existing client configs that launch `ch-local start --stdio` keep working: in shared mode, `start --stdio` runs the shim. So no user has to edit a client config.
- **The per-session mode stays as an option for release 1:** the setting `runtime: own` (the terminal only), or `ch-local start --stdio --own-runtime`. It's today's behaviour exactly, with no daemon, for anyone who wants full isolation between sessions or hits a problem with the shared runtime. The docs say how to switch. Whether it stays after release 1 is a later decision.
- **The default:** shared, for new installs and for upgrades. An upgrade from today's mode needs nothing. The next client session to start finds no daemon and starts one. Sessions still running under the old mode keep their own runtime until they end.

## 11. Open points for the review

1. A tool listed only to another session: is `TOOL_NOT_LISTED` right, or should it look like an unknown tool?
2. The per-user fatigue numbers: 3 declines per kind per 30 minutes, and a total form cap.
3. Whether `runtime: own` stays after release 1.
4. Whether a resumed session's restored loosenings should need a fresh confirmation. I'd say no: they're the same session, and the restore is announced.

## Appendix: what assumes one start is one session today

B's read (countinghouse at b-part3-p2-t5, ch-local at b-part3-p2-loadpack), and what each becomes. "Per runtime" equals per user here, since a runtime is one user's.

| Where | Today | Becomes |
|---|---|---|
| `lib/mcp/client-info.js` | the first `initialize`'s clientInfo and one session id per process | per session, keyed by the connection's session |
| `lib/settings-confirm.js` confirmations | one staged change, used nonces, fatigue locks, forms, MAC key per process | staged change, decline locks and forms per session; form cap and decline count per user; MAC key per runtime (it binds the session) |
| `lib/settings-tool.js` packsThisStart, effectiveOf | per start | per session |
| `lib/settings-tool.js` atStart | start values; a confirmed raise lifts them | start values per runtime; a confirmed raise is a session override, never a lift |
| `options.maxOutputBytes`, `requestTimeout`, `locale` mutated in place, broadcast to workers | global | global defaults; per-session values applied per call and handed to the worker with it; SETTING_CHANGED_MEANWHILE compares the session's effective value |
| `lib/validator-pool.js` heap size | one pool | one pool, sized to the largest active cap |
| `lib/settings-tool.js` UNCONFIRMED counts | per start, per history file | per user (follows the file) |
| ceiling cache | machine-wide | unchanged |
| live modules, captureAtStart | one module set | unchanged; calls carry their session |
| `lib/notices.js` pending, notifier, minimum | one queue, one notifier, one level | per session; global notices copied to each |
| `lib/route-manager.js` startStdio: appKey, shown/listing fingerprint, the ready gate | one per process | appKey per runtime (one user); fingerprint and list_changed per session; the ready gate per runtime |
| `lib/mcp/stdio.js` transport | one | one per session connection |
| `lib/control-channel.js` current | one | one per runtime; session-specific requests name the session; may-elicit goes to the shim |
| the settings tool's file | one settings.json | one per user |
| rate limits per apiKey | per key | per user (one caller id) |
| ch-local `client-conditions.js` | ancestry read from start's parent, one latch per start, env from start | in the shim, per session, from the shim's parent and env |
| ch-local `in-place.js` | one applier per start | `loaded` and `applied` per runtime (in the daemon); this-session packs and notes per session |
| ch-local `start.js` | one start, one runtime, one env, one run dir | the daemon owns the runtime, the env and token, the run dir and collection; shims own none |
| ch-local `history.jsonl` | by start | per user; lines about a session name it opaquely |

## The plan (for after the review)

The tasks split as the reviewer proposed. **C** takes the daemon, the shim, the lifecycle and the transport. **B** takes the session layers, after part 3 P2. Each task is test-first, with its own PR.

**C1. Runtime: the session transport** (countinghouse).
- `--sessionSocket <path>` (single-identity profile only, beside `--controlChannel ipc`).
- It covers: the owner-only directory checks, the secret file, the framing and hello, the attempt throttle, and the session registry (open, close, opaque ids).
- Each connection is served by today's stdio MCP handler (`lib/mcp/stdio.js`), one instance per session, with its own notify and its own ready gate.
- Tests (Docker):
  - a wrong secret, no hello, or a too-long frame are refused;
  - two sessions each get their own initialize and list;
  - a `ctl` frame can't be produced from client input;
  - a long socket path is refused.

**C2. Windows and macOS transport** (countinghouse).
- The named pipe name, the secret's DACL through `lib/win-acl.js`, and the `$TMPDIR` fallback for long paths on macOS.
- Tests: the Windows CI subset, with the macOS path-limit case server-free.

**C3. `ch-local daemon`** (ch-local).
- The start lock, `daemon.json`, spawning the runtime with the session socket and the control channel, and moving start's in-place applier, watcher, run directory and token into it.
- It covers the idle stop, the restart-with-backoff, and the upgrade drain.
- Tests (node:test, with a stub runtime):
  - two shims start one daemon;
  - the idle stop happens, and an arrival cancels it;
  - the upgrade drain;
  - the crash backoff.

**C4. `ch-local connect`, the shim** (ch-local).
- Attach or start, the hello, the relay, the client conditions answering `may-elicit?`, and reconnect: in-flight calls answered retryable, the initialize replayed and kept to itself, then list_changed.
- `start --stdio` runs the shim in shared mode, and `--own-runtime` keeps today's path.
- Tests: the relay is byte-exact, and the reconnect replays initialize, against a stub runtime that restarts. The shim's memory is measured in CI on Linux.

**C5. Docs and migration.** The README, the client snippets and `ch-local install`; docs/security-model.md's residuals; docs/upgrading-to-8.md.

**B1. Sessions on the main thread** (countinghouse, needs C1's registry).
- A call carries its session from the gateway through device-manager, hops and jobs, to usage.
- clientInfo is per session; the notices are per session, with global copies.
- Modules keep one caller id. Tests: a module sees the same caller id from two sessions.

**B2. Per-session settings** (countinghouse, needs B1).
- Overrides per session. The cap and the timeout are applied per call and handed to the worker with each call (no broadcast). Validators are sized for the largest active cap.
- Confirmations split per session and per user, with the fan-out cap. SETTING_CHANGED_MEANWHILE uses the session's value.
- Tests:
  - one session's confirmed raise doesn't change another's calls;
  - a fake self-answering session loosens only itself;
  - three declines across sessions lock that kind.

**B3. Per-session pack listing** (countinghouse and ch-local, needs B1).
- This-session packs with per-pack session sets, unload at empty, per-session tools/list and list_changed, and `TOOL_NOT_LISTED`.

**B4. The dialog through the shim** (countinghouse and ch-local, needs C4 and B2). may-elicit over the session's `ctl`, the per-session latch, and the session-state files restored on resume.

**Order.** C1, then C3 and C4 together (C4 against C1, C3 against a stub), then C2. B1 after C1, then B2 and B3, then B4 after C4. C5 last.

**Estimate.** C: about 2 weeks (C1 4 days, C3 3, C4 3, C2 2, C5 1). B: about 1.5 weeks after part 3 P2.
