# One shared runtime per user, many client sessions

Status: a design for the security review, revision 2. This revision folds in the first review (READY WITH CHANGES: findings 1–9 and the answers to section 11). No code yet.
Author: implementer C, 2026-11-15, against countinghouse master 842c5525 and ch-local main.
It spans countinghouse (the runtime: sessions, per-session settings, the session transport) and ch-local (the daemon, the shim, the lifecycle).

## Why

Today every client session (each Claude Code window, each Cursor workspace) launches its own `ch-local start --stdio`. Each of those spawns its own runtime, with its own module workers and validators. Ten sessions are ten runtimes, at roughly 350–430 MB each, mostly the same modules loaded ten times over.

Matt wants one runtime per user in release 1, shared by every session. To make that work, this design settles:
- what a session is once it's no longer a process;
- whose settings a session may change;
- how a session reaches the runtime, and how it knows it reached the real one;
- what happens when the runtime stops.

## Goals

- One runtime per OS user and ch-local home, shared by all of that user's client sessions on the machine.
- Every client keeps launching a stdio server, so no client changes. Elicitation, the settings tool, list_changed and notices keep working, per session.
- No secret in any client's configuration.
- Part 3's guarantees still hold:
  - a session that answers its own dialog loosens only its own calls;
  - nothing in conversation changes another session;
  - the operator ceiling binds everything.
- Never silent: each change is announced to the sessions it affects.

## Non-goals

- More than one OS user per runtime. Multi-user stays the HTTP hosting profile, with API keys.
- Hosting third-party servers in release 1 (Matt).
- Remote clients. The transport is local only, and section 1 says how a remote attempt fails.

## The shape

```
 client A ──stdio── ch-local connect ─┐
 client B ──stdio── ch-local connect ─┼─ session socket ─ runtime ── workers, validators
 client C ──stdio── ch-local connect ─┘   (owner-only,       │
                                           mutual auth)  IPC control channel
                                                             │
                                                       ch-local daemon
                                                       (owns the runtime and holds the
                                                        session table: packs in place,
                                                        settings watcher, ceiling, history)
```

- **`ch-local connect`, the shim.** It's what a client's config launches. It:
  - relays the client's stdio to the runtime's session socket;
  - answers the client-conditions check (its parent is the client);
  - holds its own session's tightenings;
  - reconnects when the runtime goes away.
- **`ch-local daemon`.** It's started by the first shim and owns the runtime, as `ch-local start` does today. It holds:
  - the IPC control channel, the in-place pack applier, the settings watcher and the history;
  - **the session table**, in memory (section 6).

  It is not a system service: no launchd, systemd or Windows service.
- **The runtime** listens on the session socket. Each authenticated connection is one session.

The runtime, not the daemon, takes the session connections. That saves a copy of every byte through a second process, and keeps the per-session MCP state (initialize, list_changed, the dialog) in the process that has it.

## 1. The session transport

### Where it listens

**Linux and macOS: a Unix socket in `<home>/run/daemon/`.**
- That directory is created 0700 and checked at each runtime start: owned by the user, not a symlink, mode 0700. A wrong owner or mode refuses to start.
- **The shim makes the same checks** on the directory, `daemon.json` and the secret file before it trusts any of them.
- Unix socket paths are limited to 108 bytes on Linux and 104 on macOS. The runtime refuses a path over the limit.
- When `<home>` is too long, it uses `$TMPDIR/ch-<uid>/` instead, created and checked the same way. The chosen path is recorded in `daemon.json`, which is itself under `<home>/run/daemon/`.

**Windows: a named pipe, `\\.\pipe\countinghouse-<16 hex>`.** The hex comes from a hash of the user's SID and the home path. What Node gives us, verified rather than remembered:
- **libuv's bind** (`src/win/pipe.c`, at v1.52.1, which Node 24.21 bundles) creates the first instance with `FILE_FLAG_FIRST_PIPE_INSTANCE`. If any process already holds the name, the bind fails with `ERROR_ACCESS_DENIED`, which libuv reports as `EADDRINUSE`.
- **libuv passes `NULL` security attributes.** Microsoft's CreateNamedPipe documentation says the default descriptor "grant[s] full control to the LocalSystem account, administrators, and the creator owner" and "read access to members of the Everyone group and the anonymous account".
- **Creating a further instance** of a live pipe needs `FILE_CREATE_PIPE_INSTANCE`, which read access doesn't include. So another user can't add an instance beside ours while the runtime holds the name.
- **Remote clients are accepted by default** (`PIPE_ACCEPT_REMOTE_CLIENTS` is 0), subject to that DACL. libuv doesn't set `PIPE_REJECT_REMOTE_CLIENTS`.

What follows from those facts:
- **The gap is a restart.** Between one runtime's exit and the next one's bind, another local user could take the name and serve a fake runtime to this user's shims.
- **A bind failure is fatal.** The runtime exits, saying the name is taken, and never falls back to another name.
- **The shim authenticates the server** (below), so a squatter, local or remote, can't complete a handshake. A remote attacker (Everyone and anonymous have read access) likewise can't open a session without the secret.

### Mutual authentication: the secret is never sent

- **The secret.** It's 32 random bytes, new each time the runtime starts. It's written to `<home>/run/daemon/secret` before the socket listens: 0600 on POSIX, and on Windows an owner-only DACL through `lib/win-acl.js` (#201).
- **The handshake.** It's challenge–response in both directions, using HMAC-SHA256 under the secret, with labels so no MAC can be replayed in the other direction:
  1. **Shim → runtime:** `HELLO {protocol: 1, nc}`, where `nc` is a 32-byte random challenge.
  2. **Runtime → shim:** `PROVE {ns, ms}`, where `ns` is a 32-byte random challenge and `ms = HMAC(secret, "ch-server" ‖ nc ‖ ns)`.
  3. **The shim checks `ms`** in constant time. On a mismatch it closes the connection and sends nothing more: the server isn't ours.
  4. **Shim → runtime:** `AUTH {mc, resume?}`, where `mc = HMAC(secret, "ch-client" ‖ ns ‖ nc)`.
  5. **The runtime checks `mc`** in constant time. It answers `WELCOME {session, resumeToken, runtimeVersion}` or `REFUSED {code}`.
- **Before the handshake completes:**
  - the shim relays no client byte;
  - the runtime sends nothing but `PROVE` and serves nothing.
- **Unauthenticated connections are capped:** at most 8 at once, each closed if it hasn't authenticated within 5 seconds. This replaces an accept throttle, so a flood of half-open connections can't starve real shims.
- **The hello carries nothing about the client:** no pid, no environment, no paths, since paths carry the user's name. The client conditions are evaluated in the shim (section 5).

### Framing: kind and length, then raw bytes

Every frame is one kind byte, a 4-byte big-endian length, then the payload's raw bytes:

| Kind | Direction | Payload |
|---|---|---|
| `H`, `P`, `A`, `W`, `R` | handshake (HELLO, PROVE, AUTH, WELCOME, REFUSED) | JSON |
| `M` | both | one MCP message, the exact bytes of one line of the client's stdio, without its newline |
| `C` | both | session control, JSON: runtime → shim `may-elicit?`, `drain`, `tightenings?`; shim → runtime `may-elicit`, `tightenings`, `bye` |

- The shim never parses the client's MCP. It splits the client's stdin on newlines and sends each line as one `M` frame. On the way back, it writes each `M` payload followed by a newline.
  - So a client can't produce a `C` frame. The kind comes from the shim, never from the bytes.
  - Nothing is parsed and re-stringified, so traffic stays byte-exact, and a 256 MiB result isn't copied twice.
- **Length caps:**
  - client to runtime: `--maxRequestBody`, as stdio enforces today;
  - runtime to client: the session's effective output cap plus the envelope;
  - `C` frames: 64 KiB.

  An over-length frame closes the connection.

## 2. Identity: one user, many sessions

R2-1 made `ctx.caller.id` *the user*, so a module's per-user data stays together. All of one person's sessions are that one user. So:

- **Modules see one caller id** for the machine's user, as the single-identity profile gives today. No module learns there are sessions.
- **The session lives on the main thread only.**
  - Each MCP request carries its session from its connection.
  - A hop takes its session, its cap and its timeout from its **call token's entry**, where the main thread stores them when it issues the token. A job takes them from the call that created it.
  - The session never goes to a worker. What differs per session (the output cap and the request timeout) travels with each call (section 3).
- **Usage** records each call's session id, opaquely: never the user's name, never a key.

**What else is per session** (review finding 5):
- **Tasks.** `tasks/list`, `tasks/get`, `tasks/result` and `tasks/cancel` are keyed by owner key today (`lib/mcp/gateway.js`), so with one key every session would see and cancel every other session's tasks. A task now records its session too, and a session sees and acts on its own tasks only. Another session's task looks exactly like an unknown task.
- **The usage report** (`countinghouse_usage_report`) shows the calling session's records by default. The terminal (`ch-local usage`) shows all of the user's sessions.
- **The settings tool's `get`** shows the global values and history, plus *this* session's overrides and history lines. Another session's history lines are left out.
- **A job outlives its session's loosenings.** When a session ends, its jobs still running take the global defaults for every later step: the next hop's cap and timeout, from a refreshed token entry. A job never keeps a loosening after its session is gone.

## 3. Settings: three layers

| Layer | Who changes it | Scope | Lasts |
|---|---|---|---|
| The operator ceiling (`ceiling.json`) | the operator | everything | as the file says |
| Global defaults (`<home>/settings.json`) | **the terminal only** (`ch-local settings set`) | every session | until changed |
| Per-session overrides | **every change made in conversation**: the settings tool's confirmed loosenings, *and* its tightenings and `pack.<name> off` | that session's calls only | that session's life |

**Conversation never writes `settings.json` in shared mode** (review finding 4).
- Today a conversational tightening, or `pack off`, writes the file (`lib/settings-tool.js`, the `set` path that writes and then tightens `options` at once). One session would then tighten or unload for every session.
- In shared mode the settings tool records a session override instead, and writes only the history.
- `locale` stays global and terminal-only (finding 9): a conversational `set locale` answers that it's set with `ch-local settings set locale`.

**The effective value for a call** (`maxOutputBytes`, `requestTimeout`):

- **A session override exists** for the setting: effective = the tighter of the ceiling and the override.
- **Otherwise:** effective = the tighter of the ceiling and the global default.
- **A terminal tightening binds every session** (finding 4). When the global default is tightened to G, every session override looser than G is dropped at once. Those sessions then run at G, and each is told: "your this-session loosening of `maxOutputBytes` ended: the default was lowered to G". An override tighter than G is kept.
- A terminal loosening doesn't touch session overrides. A session that tightened stays tighter.
- The ceiling is checked again at every apply. A loosening in conversation still needs part 3's confirmation, in that session's own dialog.

**Exactly where each per-call value applies.** Each line below reads `options.*` today. Each becomes the call's effective value; a hop, a peer invoke and a job take theirs as above.

| Value | Read today at | Becomes |
|---|---|---|
| `requestTimeout` | `lib/timer.js` (the call's own timer, main thread) | the call's effective timeout |
| | `lib/device-manager.js` hop `dropAfter`, and its token TTL | the token entry's timeout |
| | `lib/device-manager.js` reload wait (`REPLACE_SPAWN_BOUND_MS` plus the timeout) | the waiting call's timeout |
| | `lib/peer-channel-broker.js` `callerTimeoutMs` and `tokenTtlMs` | the announcing call's token entry |
| | `lib/peer-worker.js` caller's per-invoke timer, and `lib/handler-ctx.js` (in the worker) | the deadline handed to the worker with the call |
| | `lib/packs-in-place.js` drain bound, and `lib/route-manager.js` the stdio `drainMs` | per runtime: the global default (they bound the runtime's own drains, not one call) |
| `maxOutputBytes` | `lib/device-manager.js` reply cap, and `hop-input.sizeRefusal` for a hop's input | the call's (or token entry's) effective cap |
| | `lib/lean-worker.js` the callee's own check before posting (in the worker) | the cap handed to the worker with the call |
| | `lib/peer-channel-broker.js` input and output caps | the announcing call's token entry |
| | `lib/peer-channel-broker.js` held-byte shares, `lib/worker-message.js` envelope cap, `lib/validator-pool.js` heap | per runtime, sized to the largest active cap (they bound buffers, not one call) |
| `locale` | `lib/countinghouse-error.js` (an error's text is rendered at construction, in every thread), and `lib/settings-tool.js` `formFor` | **global**: per runtime, changed from the terminal only |

**Validators sized for the largest active cap.**
- The pool's heap limit is shared. It's raised when a session's effective cap needs more than the current size (a graceful replace, as #165's resize does).
- It's lowered lazily, once the last session needing it ends.
- A residual: a session can raise its own cap up to the ceiling and so enlarge the shared validators. The ceiling bounds it.

**Validator fairness, per session** (finding 6). Today `PER_CALLER_IN_FLIGHT = 1` and the stall throttle (`CALLER_STALLS = 3` per window) are keyed by caller. With one caller id for all sessions, ten sessions would share one validation slot, and one session's stalls would throttle a module for all.
- Main-side, the pool keys both by caller *and* session: one in flight per session, and stalls counted per session.
- On top of that it keeps a per-user bound: at most 4 in flight across all of a user's sessions, and a user-wide stall count of 6 per window. So a user can't open sessions to multiply their share.
- The keys stay main-side; the validators see none of this.

**The confirmation state.**
- **Per session:** the staged change, its nonce, the decline lock per kind, and the forms shown.
- **Per user** (per runtime, held by the daemon so it survives a runtime restart): 3 declines *or expiries* per kind within 30 minutes stop forms of that kind for the next 30 minutes, across every session (§11 answer 2). That stops a prompt injection from fanning out across a user's sessions.
- The nonce MAC key stays per runtime, and the MAC payload binds the session id.
- The form's text changes from "until your client restarts countinghouse" to "for this session" (finding 9).

**Every change is announced.**
- A per-session change goes to its session: `notifications/message`, the one-line notice on its next result, and the history (naming the session opaquely).
- A global change goes to every session the same way, and so does a dropped override (above).
- The notice queue, the notifier and `logging/setLevel`'s level are per session. A global notice is copied into each session's queue.

## 4. Packs

- **A pack turned on from the terminal** is global: loaded once, listed to every session.
- **A pack turned on in conversation** is loaded once, shared, and listed only to the session that turned it on.
  - The runtime keeps, per such pack, the set of sessions that list it.
  - It's unloaded once that set is empty and the global settings don't list it.
- **A pack turned off in conversation** is hidden from that session only (a session override). It stays loaded and listed for the others.
- **A tool not listed to a session is answered exactly as an unknown tool,** byte for byte (§11 answer 1). A distinct code would reveal another session's packs.
- **tools/list and list_changed are per session.** Each session's listed fingerprint is its own, and a change that affects one session's list notifies only that session.

## 5. The daemon, the control channel and per-client inputs

- **The control channel** stays one IPC channel between the daemon and the runtime: one per runtime, and so one per user. ch-local's requests arrive on it as now. A request about one session names it.
- **may-elicit is answered by the shim.**
  - The client-conditions check (`lib/client-conditions.js`) must read *this session's* client: the shim's parent, its environment, its project directory.
  - So the runtime asks the session's own shim over `C` (`may-elicit?`), and the shim answers yes or no from its own check. The hello carries no paths, and neither does the answer.
  - The latch is per session. A shim that doesn't answer within its wait counts as no.
- **The daemon's environment and working directory are fixed** (finding 3):
  - its env is ch-local's own (the PATH it starts with, plus the GitHub token from `gh auth token`, held in memory);
  - its cwd is `<home>`;
  - nothing from any client's environment reaches it.
- **A shim launched with inputs the shared runtime can't honour per session runs as its own runtime** (`--own-runtime`, today's path), and says so on stderr and in the first result's notice. Those inputs are:
  - a pass-through runtime flag (`--moduleSandbox`, `--maxOutputBytes`, `--requestTimeout`, `--locale` or any other `start` passes through);
  - a `COUNTINGHOUSE_GITHUB_TOKEN` or `GITHUB_TOKEN` in its environment that differs from the daemon's.

  Otherwise one session's `--moduleSandbox audit` would put every session in audit, and one client's token would be silently replaced or shared.
- **`defaultRepo` becomes per session.**
  - Today `start` reads the git remote of its cwd and writes `{defaultRepo}` into the pack's device config: one value for the runtime, so every session would act on the first session's repository.
  - In shared mode, the shim reads its own cwd's remote and sends just the `owner/name` slug in a `C` frame after the handshake. It's a repository name, not a path.
  - The main thread hands it to the module with each call of that session, as `ctx.defaults.repo`, beside the device config, which no longer carries it.
  - A module reading device config's `defaultRepo` gets `ctx.defaults.repo` first. This is one small module-facing addition, and pack 1 is changed to read it.

## 6. Lifecycle

### Where session state lives: in memory, never on disk (finding 1)

**The daemon holds the session table, in memory only.** For each session it holds:
- the hash of its current resume token;
- its overrides: loosenings and tightenings;
- its this-session packs, and its packs turned off;
- its decline locks, and the forms it has left.

Nothing of a session is ever written to a file.

**A runtime restart (the daemon lives on)** keeps every session:
- The daemon hands the table to the new runtime over the IPC control channel before that runtime accepts connections.
- Each shim reconnects and resumes, with its overrides, packs and locks as they were.
- Restored loosenings need no fresh confirmation (§11 answer 4). Each is re-checked against the ceiling, and a this-session pack is restored only if its version still matches the one its form named.
- may-elicit is asked again before the next dialog.
- The restore is announced: "restored after a runtime restart".

**A daemon death** loses the table:
- Each session's **loosenings are gone**, and the reconnect announces it: "your this-session loosenings were reset; ask again".
- Its **tightenings are kept by the shim.** The shim records each tightening its session makes (the runtime tells it over `C`), and replays them to the new daemon after the handshake.
- The runtime applies a replayed value only if it is **at least as tight** as both the global default and the ceiling. So a forged replay can only tighten. No file is involved, so nothing a same-user process could plant becomes a loosening.

**The resume token is single-use and rotated:**
- Each `WELCOME` gives a new one, and the old one is void.
- A resume is refused while the session still has a live connection, so a copied token can't take over a live session.
- The daemon stores only a hash of the current token.

### Starting

1. A shim makes the directory and ownership checks (section 1). Then it reads `<home>/run/daemon/daemon.json`: `{pid, socket, runtimeVersion, daemonVersion, started}`.
2. If the pid is alive and the handshake completes, it's attached.
3. Otherwise it takes `<home>/run/daemon/start.lock` (ch-local's `lib/lock.js`, 30 s), and checks again under the lock.
4. Still nothing, so it spawns `ch-local daemon` detached: hidden on Windows (`windowsHide`), with its own process group and no console.
5. The daemon spawns the runtime with `--sessionSocket` and the control channel. It writes `daemon.json` once the socket listens, then releases the lock.
6. The shim waits up to 20 s for a handshake to succeed.
7. A second daemon that finds a live one in `daemon.json` exits at once.

### Idle stop, and the race with an arriving shim

- After the last session leaves, the daemon waits `daemonIdleMinutes` (default 10).
- Then it takes `start.lock`, checks under it that there's still no session and no handshake in progress, removes `daemon.json`, stops the runtime, releases the lock and exits.
- A shim arriving during the wait cancels the stop by connecting.
- A shim arriving during the stop blocks on the lock. Once it gets the lock it finds no `daemon.json`, and starts a new daemon.

### Upgrade

`ch-local upgrade` (or the daily automatic upgrade) installs the new version, then appends an `upgrade` request to `<home>/run/daemon/requests` (owner-only), which the daemon watches as it watches the home.

**When the runtime changed**, the daemon:
1. stops accepting handshakes;
2. sends every shim `C: drain`;
3. waits for in-flight calls, up to `--requestTimeout`;
4. stops the old runtime;
5. starts the new one and hands it the session table.

**When the daemon itself changed** (ch-local upgraded), the daemon re-execs, carrying the session table over a pipe to its new instance:
1. it drains as above;
2. it starts the new daemon with the table on that pipe, under `start.lock`;
3. it exits once the new daemon has written `daemon.json`.

If the handoff fails, the new daemon starts empty: loosenings are reset, announced, and tightenings come back from the shims.

### Reconnecting (finding 8)

**On `drain`:**
- The shim forwards no new requests.
- It keeps relaying answers to its in-flight requests until the runtime closes the connection. The runtime finishes them and meters them, as usual.
- Then it reconnects.

**On a connection lost without `drain`** (a crash), the shim answers each request it relayed and never saw answered with a JSON-RPC error: `data['countinghouse/code'] = 'RUNTIME_RESTARTED'`, `retryable: true`, and `mayHaveRun: true`. The call may have run before the crash, so the client is told it might have.

**Then, in both cases**, the shim:
1. reattaches, starting the daemon if needed;
2. resumes with its resume token (or replays its tightenings to a new daemon);
3. replays the client's `initialize`, keeping the answer to itself (the client already has one), then `notifications/initialized`;
4. sends the client `notifications/tools/list_changed`.

### Crash of the runtime or the daemon

- **The runtime:** the daemon restarts it once immediately, then backs off at 1 s, 5 s and 30 s. After 5 failures in 10 minutes it stops and logs why. It hands the table over each time.
- **The daemon:** the next shim to reconnect finds the pid dead, and starts a new daemon under the lock.

## 7. Windows and macOS

**Windows.**
- The named pipe and its facts as in section 1, the secret's DACL through `lib/win-acl.js`, and a fatal bind failure.
- The daemon runs detached and hidden: no Windows service, no Task Scheduler.
- The shim's client-conditions check uses the existing PowerShell ancestry reader.

**macOS.** The 104-byte socket path limit and the `$TMPDIR` fallback. No launchd agent: the shim starts the daemon. The managed preferences and plist sources in the client conditions are unchanged.

**Linux.** As described. `XDG_RUNTIME_DIR` isn't required.

## 8. The shim's cost

Measured on the dev VM with Node 24, using a minimal relay (connect, pipe stdin to the socket and back): **46 MB RSS but 13 MB PSS each**, five running at once, since they share Node's code pages.
- The heap is about 5 MB; the rest is Node itself. Small-heap flags don't change it.
- Loading the client-conditions scanner adds about 1 MB.

So ten sessions cost about 130 MB PSS for shims, beside one runtime. The shim loads only the relay, the lock, the HMAC, the client conditions and the git-remote read.

## 9. Threat model and residuals

**Who could attach:**
- *Another OS user, local or remote over SMB:*
  - can't read the secret (owner-only, on all three OSes), so can't produce `mc`;
  - can't add an instance to a live pipe (no `FILE_CREATE_PIPE_INSTANCE`);
  - can't pass as the server (no `ms`).
- *A squatter in a restart gap (Windows):* the runtime's bind then fails fatally, and the shims refuse a server that can't prove the secret.
- *Root or an administrator:* can read the user's files. Out of scope, as today.
- *Any process of the same user, including the AI through a shell:* can read the secret and attach. **The same as today**, where it can start its own runtime.

**What a session can do to others:**
- It can't change another session's settings, or any global setting from conversation.
- A self-answering fake session loosens only its own calls. A terminal tightening ends its loosening, as it does any session's.
- It can't see another session's notices, staged confirmations, this-session packs, tasks, usage records or settings history.
- It can't use another session's tools: they look like unknown tools.
- It shares what one user always shares: module data (one caller id) and global packs.

**Fan-out:** the per-user decline count stops a prompt injection from wearing the dialog down across sessions.

**Resources:** one in flight per session, with a per-user bound; stalls are counted per session and per user. A session's raised cap enlarges the shared validators, within the ceiling.

**Residuals to state in `docs/security-model.md`:**
1. Same-user processes can attach, as today.
2. One session's heavy use slows the others, within the per-user bounds.
3. A daemon death resets loosenings, announced, and fails in-flight calls (retryable, may have run).
4. The secret is only as strong as the user's file permissions.
5. **A module holding two sessions' calls at once** (it serves both) holds two hop tokens, and can make a hop with either, so with the other session's cap or timeout. The values stay within the ceiling, and a module already sees all of one user's data.
6. On Windows, the pipe accepts read-only opens from Everyone and anonymous, local or remote. Before the handshake completes, they get nothing but `PROVE` (a random challenge and a MAC), and they can't authenticate.

## 10. Migration and the per-session mode

- **`ch-local connect` is the new client entry.** Client snippets and `ch-local install` write it.
- **Existing configs keep working.** A client config that launches `ch-local start --stdio` runs the shim in shared mode, so no user has to edit a client config.
- **`runtime: own` stays through release 1** (§11 answer 3). It's set with the terminal command, or per launch with `--own-runtime`, and gives today's behaviour exactly. It's also finding 3's fallback for a shim with flags or a token of its own.
- **The default is shared,** for new installs and upgrades. Sessions still running under the old mode keep their runtime until they end. The next session to start finds no daemon and starts one.

## 11. Answers from the first review

1. **A tool not listed to a session:** answered as an unknown tool, byte-identical.
2. **Fatigue:** per session as now, plus per user: 3 declines or expiries per kind in 30 minutes, held by the daemon.
3. **`runtime: own`:** kept through release 1.
4. **Restored loosenings after a runtime restart:** no fresh confirmation, given the in-memory handoff, with the ceiling and may-elicit checked again and a pack's version matching its form's.

## Appendix: what assumes one start is one session today

B's read (countinghouse at b-part3-p2-t5, ch-local at b-part3-p2-loadpack), and what each becomes. A runtime is one user's, so "per runtime" means per user.

| Where | Today | Becomes |
|---|---|---|
| `lib/mcp/client-info.js` | the first `initialize`'s clientInfo, one session id per process | per session |
| `lib/settings-confirm.js` confirmations | one staged change, used nonces, fatigue locks, forms, MAC key per process | staged change, decline locks and forms per session; the per-user decline count in the daemon; the MAC key per runtime (it binds the session) |
| `lib/settings-tool.js` packsThisStart, effectiveOf | per start | per session |
| `lib/settings-tool.js` atStart | start values; a confirmed raise lifts them | start values per runtime; a confirmed raise is a session override, never a lift |
| the settings tool's `set` writing `settings.json` for tightenings and `pack off` | global | a session override; only the terminal writes the file |
| `options.maxOutputBytes`, `requestTimeout` mutated in place, broadcast | global | global defaults; per-session values per call, as in section 3's table; SETTING_CHANGED_MEANWHILE compares the session's effective value |
| `options.locale` | global | global, terminal-only |
| `lib/validator-pool.js` heap; PER_CALLER_IN_FLIGHT and the stall throttle by caller | one pool; per caller | one pool, sized to the largest active cap; in flight and stalls by caller and session, with per-user bounds |
| `lib/mcp/gateway.js` tasks by owner key | per key | by key and session |
| the usage report; the settings tool's `get` history | per caller; whole history | per session by default; globals plus the session's own lines |
| `lib/settings-tool.js` UNCONFIRMED counts | per start, per history file | per user (follows the file) |
| ceiling cache | machine-wide | unchanged |
| live modules, captureAtStart | one module set | unchanged; calls carry their session |
| `lib/notices.js` pending, notifier, minimum | one each | per session; global notices copied to each |
| `lib/route-manager.js` startStdio: appKey, the listed fingerprint, the ready gate | one per process | appKey per runtime; fingerprint and list_changed per session; the ready gate per runtime |
| `lib/mcp/stdio.js` transport | one | one per session connection |
| `lib/control-channel.js` current | one | one per runtime; session requests name the session; may-elicit goes to the shim |
| call tokens | the caller's identity and billing | plus the session, its cap and its timeout |
| ch-local `client-conditions.js` | start's parent, one latch, start's env | in the shim, per session |
| ch-local `in-place.js` | one applier per start | in the daemon, per runtime; this-session packs and notes per session |
| ch-local `start.js`: env, token, defaultRepo, run dir | one start, its env and cwd | the daemon's fixed env and cwd; defaultRepo per session as `ctx.defaults.repo`; a shim with its own flags or token runs its own runtime |
| ch-local `history.jsonl` | by start | per user; lines about a session name it opaquely |

## The plan (for after the re-check)

**C** takes the daemon, the shim, the lifecycle and the transport. **B** takes the session layers, after part 3 P2. Each task is test-first, with its own PR.

**C1. Runtime: the session transport** (countinghouse).
- `--sessionSocket <path>` with `--controlChannel ipc`. It makes the runtime single-identity without `--stdio`: today `singleIdentity` requires `--stdio` (`lib/cli-options.js`), and `startStdio` exits when its input ends. In session mode, stdin's end doesn't stop it.
- It covers: the directory checks, the secret, the HMAC handshake, the framing, the pre-auth cap, and the session registry.
- Each authenticated connection is served by the stdio MCP handler (`lib/mcp/stdio.js`), one instance per session.
- Tests (Docker):
  - a wrong MAC either way, no hello, a too-long frame, or a 9th unauthenticated connection are refused;
  - two sessions get their own initialize and list;
  - a `C` frame can't come from client bytes;
  - traffic is byte-exact;
  - a long socket path is refused.

**C2. Windows and macOS transport** (countinghouse).
- The pipe name, the fatal bind, the secret's DACL, and the macOS fallback.
- Tests: the Windows CI subset (a second bind is `EADDRINUSE`, and the runtime exits), plus the path limit, server-free.

**C3. `ch-local daemon`** (ch-local).
- The lock, `daemon.json`, the fixed env and cwd, the in-place applier and watcher, and the in-memory session table with its handoff to a restarted runtime.
- The idle stop with its race, the restart backoff, the upgrade requests, and the re-exec handoff.
- Tests (node:test, stub runtime):
  - two shims start one daemon, and a second daemon exits;
  - an arrival during the idle stop gets a new daemon;
  - the upgrade drain;
  - the handoff keeps overrides;
  - the backoff.

**C4. `ch-local connect`, the shim** (ch-local).
- The checks, attach or start, the handshake, the framing relay, may-elicit, the defaultRepo slug, the tightening record and replay, drain (wait for answers), crash (retryable, may have run), the initialize replay and list_changed.
- Tests:
  - byte-exact relay;
  - a fake server (wrong `ms`) gets no client byte;
  - drain waits;
  - a crash answers with mayHaveRun;
  - a replay only tightens.

  The shim's memory is measured in CI on Linux.

**C5. Per-client inputs** (ch-local, finding 3).
- A shim with pass-through flags or a differing token runs `--own-runtime`, and says so.
- `runtime: own`.
- Tests: `--moduleSandbox audit` doesn't reach the shared runtime, and a differing token runs its own runtime.

**C6. Docs and migration.** The README, the client snippets and `ch-local install`; `docs/security-model.md` (section 9's residuals); `docs/upgrading-to-8.md`.

**B1. Sessions on the main thread** (needs C1's registry).
- The session on each call, and in call tokens (with the cap and timeout) and jobs, through to usage.
- Per-session clientInfo and notices.
- Tests:
  - a module sees one caller id from two sessions;
  - a hop takes its token's values;
  - a job takes the defaults once its session ends.

**B2. Per-session settings** (needs B1).
- Overrides for every conversational change, and conversation never writing `settings.json`. A terminal tightening drops looser overrides, announced.
- Per-call application by section 3's table. Validators sized for the largest active cap.
- The confirmations split, with the per-user count in the daemon. The form text.
- Tests:
  - one session's raise doesn't change another's calls;
  - a conversational tightening or `pack off` changes only its session;
  - a terminal tightening ends a looser override;
  - a self-answering session loosens only itself;
  - 3 declines across sessions lock that kind;
  - a hop token carries its session's values.

**B3. Per-session packs** (needs B1). This-session packs with session sets, `pack off` per session, an unknown tool for an unlisted one (byte-identical), and per-session tools/list and list_changed.

**B4. The dialog through the shim** (needs C4 and B2). may-elicit over `C`, the per-session latch, the restore checks (ceiling, may-elicit, the pack's version).

**B5. Session-scoped views** (finding 5). Tasks by key and session (another session's task is unknown), the usage report and the settings history per session.

**B6. Validator fairness** (finding 6). In flight and stalls by caller and session, with per-user bounds. Tests: ten sessions each get a slot, within the user's bound; one session's stalls don't throttle another's.

**Order.**
- C1 comes first.
- Then C3 and C4 together (C4 against C1, C3 against a stub), then C5, then C2.
- B1 follows C1. Then B2, B3, B5 and B6. Then B4 after C4. C6 is last.

**Estimate.** C: about 2.5 weeks (C1 4 days, C3 4, C4 3, C5 1, C2 2, C6 1). B: about 2 weeks after part 3 P2.
