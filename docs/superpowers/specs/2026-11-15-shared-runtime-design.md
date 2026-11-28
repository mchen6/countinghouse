# One shared runtime per user, many client sessions

Status: revision 5, FROZEN (contract 2). Revision 3 was READY after the security review. Revision 4 followed the maintainer's decision (2026-11-15): the shim is a small native program, written in Rust by implementer A, and this document fixes its wire contract so the two sides can be built and tested apart (section 1, and the vectors in `shared-runtime-wire/`). Revision 5 makes the contract review's seven edits. No code yet.
Author: implementer C, 2026-11-15, against countinghouse master 842c5525 and ch-local main.
It spans countinghouse (the runtime: sessions, per-session settings, the session transport) and ch-local (the daemon, the shim, the lifecycle).

## Why

Today every client session (each Claude Code window, each Cursor workspace) launches its own `ch-local start --stdio`. Each of those spawns its own runtime, with its own module workers and validators. Ten sessions are ten runtimes, at roughly 350–430 MB each, mostly the same modules loaded ten times over.

The maintainer wants one runtime per user in release 1, shared by every session. To make that work, this design settles:
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
- Hosting third-party servers in release 1 (maintainer's decision).
- Remote clients. The transport is local only, and section 1 says how a remote attempt fails.

## The shape

```
 client A ──stdio── ch-shim ─┐
 client B ──stdio── ch-shim ─┼─ session socket ─ runtime ── workers, validators
 client C ──stdio── ch-shim ─┘   (owner-only,       │
                                  mutual auth)  IPC control channel
                                                    │
                                              ch-local daemon
                                              (owns the runtime and holds the
                                               session table: packs in place,
                                               settings watcher, ceiling, history)
```

- **`ch-shim`, the shim: a native program (Rust, built by A), not Node.** It's what a client's config launches. It only:
  - relays the client's stdio to the runtime's session socket, byte for byte;
  - makes the handshake, and reconnects when the runtime goes away;
  - records its session's tightenings, which it treats as opaque, and replays them after a daemon death;
  - starts the daemon when none is running.

  It doesn't reimplement the Claude Code client checks. Once per connection it runs `node ch-local conditions --for <client pid> --home <home>` as a short-lived child, and carries the child's verdict over its own connection (the `client` control frame, section 1). It knows nothing of settings, packs or MCP beyond a line's `id` and `method`.
- **A platform with no shim binary** runs the per-session mode (`runtime: own`), and says so (section 10). There is no Node shim.
- **`ch-local daemon`.** It's started by the first shim and owns the runtime, as `ch-local start` does today. It holds:
  - the IPC control channel, the in-place pack applier, the settings watcher and the history;
  - **the session table**, in memory (section 6).

  It is not a system service: no launchd, systemd or Windows service.
- **The runtime** listens on the session socket. Each authenticated connection is one session.

The runtime, not the daemon, takes the session connections. That saves a copy of every byte through a second process, and keeps the per-session MCP state (initialize, list_changed, the dialog) in the process that has it. **So the wire contract in section 1 is between the shim and the runtime's session listener** (C1, in countinghouse). The daemon meets the shim only through files: `daemon.json`, `start.lock` and the secret.

## 1. The session transport

### Where it listens

**Linux and macOS: a Unix socket in `<home>/run/daemon/`.**
- That directory is created 0700 and checked at each runtime start: owned by the user, not a symlink, mode 0700. A wrong owner or mode refuses to start.
- **The shim makes the same checks** on the directory, `daemon.json` and the secret file before it trusts any of them.
- Unix socket paths are limited to 108 bytes on Linux and 104 on macOS. The runtime refuses a path over the limit.
- When `<home>` is too long, it uses `$TMPDIR/ch-<uid>/` instead, created and checked the same way. The chosen path is recorded in `daemon.json`, which is itself under `<home>/run/daemon/`.

**Windows: a named pipe, `\\.\pipe\countinghouse-<32 hex>`, its name random per runtime start** (16 random bytes). It's recorded in `daemon.json`, which is owner-only through `lib/win-acl.js`. The shim checks that DACL before it trusts the name. A predictable name would let another user hold it, so the runtime never starts; a random one can't be guessed in advance. What Node gives us, verified rather than remembered:
- **libuv's bind** (`src/win/pipe.c`, at v1.52.1, which Node 24.21 bundles) creates the first instance with `FILE_FLAG_FIRST_PIPE_INSTANCE`. If any process already holds the name, the bind fails with `ERROR_ACCESS_DENIED`, which libuv reports as `EADDRINUSE`.
- **libuv passes `NULL` security attributes.** Microsoft's CreateNamedPipe documentation says the default descriptor "grant[s] full control to the LocalSystem account, administrators, and the creator owner" and "read access to members of the Everyone group and the anonymous account".
- **Creating a further instance** of a live pipe needs `FILE_CREATE_PIPE_INSTANCE`, which read access doesn't include. So another user can't add an instance beside ours while the runtime holds the name.
- **Remote clients are accepted by default** (`PIPE_ACCEPT_REMOTE_CLIENTS` is 0), subject to that DACL. libuv doesn't set `PIPE_REJECT_REMOTE_CLIENTS`.

What follows from those facts:
- **The gap is a restart.** A fixed name could be taken between one runtime's exit and the next one's bind. With a random name per start, there's nothing to take in advance.
- **A bind failure is fatal** for that runtime start. The runtime exits, saying the name is taken, and never serves under a name it doesn't hold. The daemon's next start picks a new random name.
- **The shim authenticates the server** (below), so a squatter, local or remote, can't complete a handshake.
- **A read-only client gets no bytes at all.** The client speaks first (HELLO), and only the owner, Administrators and SYSTEM can write to the pipe. So a client opened with read access alone can never send a HELLO, and never sees a PROVE.
- **Node can't set the pipe's descriptor or reject remote clients** (libuv passes `NULL` attributes and no `PIPE_REJECT_REMOTE_CLIENTS`). The maintainer's decision: no native helper, which would break the runtime's pure-JS install. The guard is the random 128-bit name per start, `FILE_FLAG_FIRST_PIPE_INSTANCE`, the mutual HMAC handshake and the shim's owner-SID check. The residual is section 9's item 6.

### The wire contract

This is the interface between A's Rust shim and the runtime's session listener (C1). Each side is built and tested against it alone. Both run the conformance vectors in [`shared-runtime-wire/vectors.json`](shared-runtime-wire/vectors.json), made by `make-vectors.js` beside it. A change to the contract bumps `contract` in that file and HELLO's `protocol`.

**Frames.** Every frame is:
- one **kind** byte, an ASCII letter;
- a **length**, 4 bytes, unsigned, big-endian: the payload's length;
- the **payload**.

| Kind | Name | Direction | Payload | Cap |
|---|---|---|---|---|
| `H` | HELLO | shim → runtime | JSON `{protocol: 1, nc}` | 507 (the whole frame within the 512 bytes read before HELLO) |
| `P` | PROVE | runtime → shim | JSON `{ns, ms}` | 4096 |
| `A` | AUTH | shim → runtime | JSON `{mc, resume?}` | 4096 |
| `W` | WELCOME | runtime → shim | JSON `{session, resumeToken, runtimeVersion, maxToRuntime, maxToShim}` | 4096 |
| `R` | REFUSED | runtime → shim | JSON `{code, message}` | 4096 |
| `M` | message | both | a 2-byte big-endian header length, the header JSON object (none when 0), then one line's bytes | the whole payload: WELCOME's `maxToRuntime` or `maxToShim` |
| `C` | control | both | JSON `{op, …}` | 65536 |

- **Receiving.** A receiver reads the 5-byte head, checks the length against the kind's cap *before* reading the payload, and closes on an over-cap length or an unknown kind.
- **JSON** is compact UTF-8. Receivers parse it and never compare its bytes. Binary values (`nc`, `ns`, `ms`, `mc`, a token's MAC) are standard padded base64 of the raw bytes.
- **Order.** HELLO, PROVE, AUTH, then WELCOME or REFUSED. Then `M` and `C` frames in any order. An `M` or `C` before WELCOME closes the connection. So does a second HELLO or AUTH.

**The secret.**
- It's 32 random bytes, new at each runtime start. The runtime writes it to `<home>/run/daemon/secret` before the socket listens: 0600 on POSIX, and on Windows an owner-only DACL through `lib/win-acl.js` (#201).
- The file holds 64 lowercase hex characters, optionally followed by one newline.
- Before trusting the directory, `daemon.json`, `shim.json` or the secret, the shim checks each one.
  - **POSIX.** It must be owned by the user's uid and not be a symlink (checked with `lstat`, then the file opened with `O_NOFOLLOW`). The directory must be mode 0700 and the files 0600, with no other bits.
  - **Windows: the rule of countinghouse's `lib/win-acl.js` `privateProblem`, exactly.** Read the owner and the DACL by SID:
    - the ACL must be readable, and every ACE a plain allow or deny. Any other ACE type (an object, callback, audit or unrecognised ACE), or an ACE that can't be read, fails;
    - the owner must be the user's SID, `S-1-5-18` (SYSTEM) or `S-1-5-32-544` (Administrators);
    - deny ACEs, and inherit-only ACEs, are skipped;
    - every allow ACE whose SID is not one of those three may grant nothing beyond `SYNCHRONIZE` (0x100000), `READ_CONTROL` (0x20000) and `FILE_READ_ATTRIBUTES` (0x80);
    - anything the shim can't read fails closed.
  - A check that fails stops the attach, naming what and why. The vectors give the cases.

**The handshake: each side proves the secret, and the secret is never sent.**
1. **HELLO** `{protocol: 1, nc}`, where `nc` is 32 random bytes.
2. **PROVE** `{ns, ms}`, where `ns` is 32 random bytes and `ms = HMAC-SHA256(secret, "ch-server" ‖ p ‖ nc ‖ ns)`. The labels are their ASCII bytes, `p` is the HELLO's `protocol` as one byte, and `nc` and `ns` are their raw 32 bytes. So a MAC made for one protocol is never accepted for another.
3. **The shim checks `ms`** in constant time. On a mismatch it closes and sends nothing more on that connection. A runtime that restarted between the shim's read of the secret and its connect has a new secret, so this can be a race, not an impostor. The shim re-reads `daemon.json` and the secret (with their checks) and tries again, within the 20 s of retries below. It relays no client byte until a PROVE checks.
4. **AUTH** `{mc, resume?}`, where `mc = HMAC-SHA256(secret, "ch-client" ‖ p ‖ ns ‖ nc)` and `resume` is the last WELCOME's `resumeToken`, if the shim has one.
5. **The runtime checks `mc`** in constant time, then answers WELCOME, or REFUSED and closes.

A HELLO whose `protocol` the runtime doesn't speak gets REFUSED `{code: "PROTOCOL", supported: [1]}`.

**REFUSED codes:**

| Code | When | The shim then |
|---|---|---|
| `BAD_PROOF` | `mc` didn't match | re-reads `daemon.json` and the secret and retries within the 20 s (a restart race); after that, says the runtime refused it |
| `PROTOCOL` | unsupported `protocol` | stops; says the shim and the runtime are different releases |

**Before a PROVE checks, the shim trusts nothing from the runtime.** The only frame it accepts in place of PROVE is REFUSED with code `PROTOCOL`. It shows fixed text of its own for it ("this shim and the runtime are different releases") and never the frame's `message`, since an unproven peer could be anyone. Any other frame, or any other code, before a checked PROVE is treated as a wrong `ms`: re-read the files and retry.
| `RESUME_REFUSED` | the token is unknown or used, or its session is still connected | opens a new session (AUTH without `resume`, on a new connection) and replays its records |
| `BUSY` | the session limit is reached | retries with jitter, then gives up as below |
| `SHUTTING_DOWN` | the runtime is draining | retries with jitter |

**The pre-auth stage has its own bounds.** On Windows any local user, or a remote one over SMB, can list the pipe's name and open an instance of it. With read access alone it can't write a HELLO, so it gets no bytes at all, but it holds a pre-auth slot until the 2 s deadline.
- At most 64 connections may be unauthenticated at once. When a 65th arrives, the oldest one already refused whose REFUSED is written out is evicted, else the **oldest whose bytes none have been read**; if none is either, the **new** connection is refused (closed at once). One whose bytes the runtime has read, as a real shim's handshake's are, is never evicted, and silent openers can't hold the pool. (A connection whose HELLO is written but not yet read counts as silent for that moment.)
- Each has 2 s to complete AUTH. At most 512 bytes are read from a connection before its HELLO is complete.

**The shim retries with jitter.** After a failure before WELCOME (refused or evicted -- a real shim's connection whose HELLO isn't read yet can be evicted as silent --, timed out, `BUSY` or `SHUTTING_DOWN`), it retries after 100 ms to 2 s, randomised, for up to 20 s in all.

**If it still can't attach,** the shim says so plainly and never hangs:
- it writes the reason on stderr;
- it answers each client request as it arrives with JSON-RPC error -32603, `countinghouse could not reach its shared runtime (<reason>); try again, or set runtime: own`;
- it keeps trying to attach in the background.

**The hello carries nothing about the client:** no pid, no environment, no paths, since paths carry the user's name.

**Messages (`M`).**
- **What the cap bounds.** The cap is on the whole `M` payload: the 2 header-length bytes, the header and the line.
  - `maxToRuntime` is the runtime's `--maxRequestBody` plus 4096.
  - `maxToShim` is twice the largest output cap a session can have (the ceiling's `maxOutputBytes`, or 256 MiB without one) plus 1 MiB. It's a **hard frame limit**: a receiver closes the connection on an `M` over it.
  - **The runtime never writes an `M` over `maxToShim`.** The output cap counts the result's serialized bytes, not its JSON: a control character becomes 6 bytes, and the output appears twice (as `content` text and as `structuredContent`). So the size of a line can't be bounded from the cap in advance. If a line would be over `maxToShim`, the runtime writes this instead, with that `seq`:

    ```json
    {"jsonrpc":"2.0","id":<id>,"error":{"code":-32603,"message":"the answer is larger than this connection carries","data":{"countinghouse/code":"OUTPUT_TOO_LARGE","retryable":false}}}
    ```
  - The shim streams an `M` payload to stdout as it reads it. It never has to hold one whole, with one exception: the answer to its own replayed `initialize` (section 6), which it holds whole, at most 64 KiB, to read the lists it declares, and then drops.
- **A malformed `M` closes the connection:**
  - a payload under 2 bytes;
  - a header length greater than the payload's remaining bytes;
  - a header that isn't a JSON object;
  - a header field of the wrong type.
- **Client to runtime.** The shim reads the client's stdin as lines. It splits only on the byte 0x0a, which JSON text never carries unescaped, and bounds each line by `--maxRequestBody` (`maxToRuntime` − 4096).
  - **A line over that bound** can't be read whole, so it has no id the shim could know. The shim discards it to its newline and never forwards it. It answers the client itself, with exactly this, `<limit>` being the bound in bytes (vector `tooLongLineAnswer`):

    ```json
    {"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"the request is larger than countinghouse accepts (<limit> bytes)"}}
    ```
  - It parses each line only enough to tell what it is.
  - **A request** is an object with an `id` member and a `method` member of any type (a `method` that isn't a string is still a request: the runtime answers it with an error, and the shim must have given it a seq). Member names are compared after JSON unescaping, so `"i\u0064"` is `id`. It gets a header `{"seq": n}`. `n` is the shim's own counter, from 1, below 2^53. It counts for the shim process's whole life and **never restarts on a reconnect or a resume**. So a reply left over from an earlier connection can't carry the `seq` of a newer request. The shim keeps `n`, the id's original bytes and the method.
  - **A batch** (an array) gets `{"seq": n}` too, and the shim keeps the original bytes of each member's id.
  - **A response** (an object with an `id` member and no `method` member) gets no header, and nothing is kept for it: it never gets a `seq`, an in-flight entry or a crash answer. In 2026-07-28 the runtime sends the client no requests (elicitation rides in the tool result, and the client answers with a retried `tools/call`), so a response is forwarded and the runtime ignores it.
  - **A notification**, or a line that isn't JSON (to the shim's parser, including invalid UTF-8 and a lone surrogate escape it refuses), gets no header (header length 0).
- **The runtime never runs a call the shim didn't number.** The two parsers may disagree about a line at the edges, so the runtime takes these rules, whatever the shim did:
  - It decodes each `M` payload's line as UTF-8 **fatally**, never replacing bytes. Invalid UTF-8 is answered with a parse error (-32700, id null) and nothing runs.
  - A line that `JSON.parse` doesn't accept is answered with a parse error, as stdio does today.
  - **A line that parses to an object with an `id` member but came without a `seq`** is never dispatched. The runtime answers it with -32600, "the line was not framed as a request", carrying the line's id, and with no header. The shim writes that to the client as an unmatched reply. A call can then never run without the `seq` a crash answer needs.
  - The same holds for a batch without a `seq`. A response, an object with an `id` and no `method`, is ignored.
  - The line's **original bytes** follow, unchanged and without the newline. The shim keeps a legacy `initialize` line for replay.
- **Runtime to client.** The answer to a request or a batch has the header `{"seq": n}`, the `n` it came with. A notification, or a message the runtime sends of its own, has no header.
  - The shim writes the bytes after the header, then one newline. It never parses a result body, which can be up to 256 MiB.
  - **Ids are matched by `seq`, never by comparing ids.** So `7`, `7.0`, `1e2` and integers past 2^53 need no rule here. The reply's own `id` is what the runtime writes, as stdio does today.
  - **A reply whose `seq` the shim doesn't hold** (already answered, or sent to an earlier connection) is written to the client anyway, and nothing is recorded. Since `seq` never repeats in a shim's life, it never clears a newer request. The exception is the shim's own initialize replay, whose answer it drops (after reading it, section 6).
- **So a client can't produce a `C` frame,** and traffic stays byte-exact: nothing is re-stringified or parsed twice.

**Control (`C`).** An unknown `op` is ignored, so either side can add one within a contract version.

| `op` | Direction | Fields | Meaning |
|---|---|---|---|
| `client` | shim → runtime | `seq`? (the `conditions?` it answers); `status`: `"ok"` or `"failed"`; and when ok: `conditions` (`"yes"` or `"no"`), `repo` (`"owner/name"` or null), `token` (base64 MAC, or null when the environment chooses none), and optionally `credentials` (an object of a pack credential's variable name to its base64 MAC); when failed: `why` | The child's line (section 5). Sent right after WELCOME (the connection's first frame), after each reconnect, and in answer to each `conditions?`. With records held the order is `client`, then `settled`, then `replay`. |
| `conditions?` | runtime → shim | `seq` | Run the child again and answer with `client` carrying this `seq`. The runtime sends it before each form and again at the confirmation. It waits **12 s**, longer than the shim's 10 s for the child, so a slow Windows ancestry read still answers. No answer by then counts as `"no"`: no form. |
| `settled` | runtime → shim | | The first `client` frame is accepted. The shim forwards client lines from here. |
| `replay` | shim → runtime | `entries`: array | After `settled`, on every connection while the shim holds records (a new session, or a resumed one, which may not have read the replay sent before its loss): the records the shim kept, as it received them. The shim sends it before any client line it held. A replay before the first `client` frame closes the connection unsettled; once settled, the runtime takes one replay per connection, whenever it comes. |
| `bye` | shim → runtime | | The client's stdin ended. The runtime ends the session. |
| `record` | runtime → shim | `entry`: an opaque JSON value | Keep this for replay. At most 64 entries and 16 KiB in all; the oldest goes first. |
| `forget` | runtime → shim | | Drop every record (a terminal change ended them all). |
| `cancelled` | runtime → shim | `seq`: the request's | The client cancelled that call, which will have no answer: forget its seq, so no crash answer is made for it, and a close waiting on it ends once nothing is left (MCP completeness section 13). Optional: an older shim ignores it, as it ignores any op it doesn't know. |
| `drain` | runtime → shim | | Forward no new request; relay answers until the runtime closes, then reconnect. |
| `own-runtime` | runtime → shim | `reason`: `"token"`, `"credential"` or `"conditions-failed"` | This session can't be shared. The runtime closes; the shim runs the per-session mode (section 5). |

**Holding until settled.** After WELCOME the shim sends its first `client` frame and forwards no client line until `settled` arrives. Lines read meanwhile are held, as during a drain. An `own-runtime` instead hands the held lines to the per-session runtime. So no call runs on the shared runtime before the session's token is known to match.

**What the shim keeps:** its resume token, its records, its in-flight ids, and a legacy `initialize` line. All of it is in memory, and none of it is ever written to disk.

**The crash answer.** If the connection is lost without `drain`, the shim answers each request it relayed and never saw answered, with the id's original bytes in place of `<id>`. A batch is answered with an array of these, one per member that has an id:

```json
{"jsonrpc":"2.0","id":<id>,"error":{"code":-32603,"message":"countinghouse's runtime restarted before answering; the call may have run","data":{"countinghouse/code":"RUNTIME_RESTARTED","retryable":true,"mayHaveRun":true}}}
```

During a drain, a request the client sends is held and forwarded after the reconnect. At most 64 are held, up to `maxToRuntime` in all. Past that, a request is answered with this, exactly, since it never reached the runtime:

```json
{"jsonrpc":"2.0","id":<id>,"error":{"code":-32603,"message":"countinghouse's runtime restarted before this was sent; the call did not run","data":{"countinghouse/code":"RUNTIME_RESTARTED","retryable":true,"mayHaveRun":false}}}
```

**The conformance vectors** (`vectors.json`, contract 2) fix, from given inputs:
- the secret file's form;
- `ms` and `mc`;
- every handshake frame's bytes;
- the token MAC;
- the `M` encodings: a request and a batch with their `seq`, the reply, a notification, and malformed payloads;
- every control frame, including a failed `client`;
- every REFUSED code;
- the lock's content and its host string;
- the secret file's accepted and refused forms;
- the crash answer.

They also name the behaviour each side must show, with the cases the tests must cover:
- a wrong `ms`;
- an over-cap or unknown frame;
- too many bytes before HELLO;
- a wrong AUTH;
- a resume of a live session;
- an `M` before WELCOME;
- a newline inside a string.

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
- **The usage report** (`countinghouse_usage_report`) shows only the calling session's records. There is no conversational way to see other sessions. The terminal (`ch-local usage`) shows all of the user's sessions.
- **The settings tool's `get`** shows the global values and history, plus *this* session's overrides and history lines. Another session's history lines are left out.
- **A job outlives its session's loosenings, never its tightenings.** The main thread indexes token entries by session. When a session ends, it rewrites the limits of that session's live tokens and their children. For every later step of a job still running (the next hop's cap and timeout), each value becomes the tighter of the session's last effective value and the global default. So a loosening ends with its session. A session's tightening stays with its jobs, since raising them to the default would loosen them.

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
- **"At once" includes calls already in flight.** A call reads its cap and timeout when it starts, and the main thread holds them for its life (#233). So at each check the main thread takes the tighter of the call's start value and the session's current effective value:
  - the reply cap is checked at reply time;
  - the timeout is re-armed when the tightening is applied, measured from the call's start.

  That's one lookup per reply.
- A terminal loosening doesn't touch session overrides. A session that tightened stays tighter.
- The ceiling is checked again at every apply. A loosening in conversation still needs part 3's confirmation, in that session's own dialog.
- **What counts as a loosening is judged against the session's current effective value,** not the global default. So a form is needed both to raise a session-tightened value back toward the default, and to un-hide a pack the session turned off. Only a change that is tighter than the session's current value needs none.

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
- **It isn't lowered in release 1.** #222's resize only grows. Once raised, the pool keeps the larger heap until the runtime restarts. A shrink would need its own operation, with the same rule as growing: a slot is replaced only when no call in flight needs the larger heap. It's listed as later work, not assumed.
- A residual: a session can raise its own cap up to the ceiling and so enlarge the shared validators. The ceiling bounds it.

**Validator fairness, per session** (finding 6). Today `PER_CALLER_IN_FLIGHT = 1` and the stall throttle (`CALLER_STALLS = 3` per window) are keyed by caller. With one caller id for all sessions, ten sessions would share one validation slot, and one session's stalls would throttle a module for all.
- Main-side, the pool keys both by caller *and* session: one in flight per session, and stalls counted per session.
- On top of that it keeps a per-user bound: at most 4 in flight across all of a user's sessions, and a user-wide stall count of 6 per window. So a user can't open sessions to multiply their share.
- The keys stay main-side; the validators see none of this.

**The confirmation state.**
- **Per session:** the staged change, its nonce, the decline lock per kind, and the forms shown.
- **Per user** (per runtime, held by the daemon so it survives a runtime restart): 3 declines *or expiries* per kind within 30 minutes stop forms of that kind for the next 30 minutes, across every session (§11 answer 2). That stops a prompt injection from fanning out across a user's sessions.
  - **How it reaches the daemon.** The runtime sends each decline or expiry to the daemon over the IPC control channel: the kind and the time, nothing else.
  - The daemon keeps the last 30 minutes of them per kind, in memory, with the session table, and hands them back with the table to a restarted runtime.
  - A per-session decline lock is the runtime's and ends with it. The per-user count doesn't.
- The nonce MAC key stays per runtime, and the MAC payload binds the session id.
- The form's text changes from "until your client restarts countinghouse" to "for this session" (finding 9). That changes P2's `FORM_TEXT` and its zh strings, so they need a new review round (B, in B2).

**Every change is announced.**
- A per-session change goes to its session: `notifications/message`, the one-line notice on its next result, and the history (naming the session opaquely).
- A global change goes to every session the same way, and so does a dropped override (above).
- The notice queue, the notifier and `logging/setLevel`'s level are per session. A global notice is copied into each session's queue, within notices' per-module bound. A session's queue is dropped when the session ends, so a session that never calls a tool holds its copies no longer than its life.

## 4. Packs

- **A pack turned on from the terminal** is global: loaded once, listed to every session.
- **A pack turned on in conversation** is loaded once, shared, and listed only to the session that turned it on.
  - The runtime keeps, per such pack, the set of sessions that list it.
  - It's unloaded once that set is empty and the global settings don't list it.
- **A pack turned off in conversation** is hidden from that session only (a session override). It stays loaded and listed for the others.
- **A tool not listed to a session is answered exactly as an unknown tool,** byte for byte (§11 answer 1). A distinct code would reveal another session's packs.
- **The session is checked at every hop, not only at the client's call.** A call's token entry carries its session (section 2). At each hop, routed and over a direct peer channel alike, the main thread refuses a callee whose pack the call's session doesn't list:
  - another session's this-session pack;
  - a pack this session turned off.

  The refusal is byte-identical to an unknown device's. Without this, a module visible to session B that calls into a pack only A turned on would reach that pack on B's call: a loosening B never confirmed. And a pack B hid would still be reachable from B's calls.
- **tools/list and list_changed are per session.** Each session's listed fingerprint is its own, and a change that affects one session's list notifies only that session.

## 4a. Modules with per-session state (the maintainer's rule 3)

> Documented for authors in [module development, "Modules that keep state per session"](../../module-development.md#modules-that-keep-state-per-session) and for operators in [the security model](../../security-model.md#modules-that-keep-state-per-session). As built (R1, plan docs/superpowers/plans/2026-11-16-shared-runtime-r1-per-session-modules.md): hops into a per-session module always take the main-thread route, never a direct peer channel.

Modules are shared by default: one worker per module, as today. A module that **declares** per-session state gets a worker of its own per session, and its store and files partitioned by session.

- **The declaration.** In the module's `package.json`: `"countinghouse": {"state": "per-session"}`. Absent, or `"shared"`, means shared. Any other value refuses the load, naming it.
  - It sits beside `role` in the manifest, so it's reviewed with it. The main thread pins it at the operator's load, as it pins `countinghouse.calls` (`lib/manifest-pins.js`; on master that pinned only `calls`, and `role` isn't pinned; `sessionDefaults` (section 5) isn't built yet). A reload that changes it is refused with `MODULE_STATE_CHANGED` ("unload it first"): a running module's workers and partitions can't change shape in place (R1's plan, D1).
  - `ch-local`'s install review shows it: "keeps state per session".
- **Where it applies.**
  - **The shared runtime:** as below.
  - **`--stdio` (one session):** unchanged. There's no session id and no partition. The module runs in its one worker on today's paths (`<name>/{data,tmp}`, `m:<name>:`), whatever it declares.
  - **The HTTP hosting profile:** has no sessions, and serves many users, so "shared" would mean shared across users. A per-session module's load is **refused** there with `MODULE_NEEDS_SESSIONS`, naming the module.
- **The worker pool.** A per-session module's workers are keyed by (module name, session id), where today's are keyed by module name.
  - A worker starts on the session's first call into the module, a routed hop included.
  - **When it stops (the maintainer's decision).** A stop drops the module's in-memory state, so a session's worker stops only:
    - at the session's end (its `bye`, or its reconnect window expiring); or
    - when the cap needs its slot (below). That session is then told "this module's in-memory state was reset; its files were kept".

    There's no idle stop: a worker isn't stopped for being idle.
  - Module code, the sandbox, the validators and the generation rule (`nextGeneration`) are the module's, shared by its session workers. Only the worker and the partition are per session.
- **Hops and peers.** A hop is served by the worker of the call's own session, which the main thread knows from the call's token entry (section 2).
  - A per-session module is never reached outside a session: a call with no session is refused like an unknown device.
  - A peer channel or a hop token that outlives its session is refused the same way.
  - A shared module serving two sessions holds both sessions' tokens, and can hop into either session's worker. That's section 9's residual 5, which covers state too (below).
- **Jobs.** A per-session module's job carries its session, from the main thread; the module is never shown it. A job whose session has ended is refused like an unknown device, and isn't retried.
- **What the module sees: nothing new.** No session id reaches it: not in `options`, `workerData`, its environment, its argv, an error's text or a job's data. Isolation comes from the worker and the partition, so it learns nothing about the user, or about other sessions, that it couldn't learn before.
- **The partition.**
  - **Store:** keys under their own prefix, `ms:<name>:<session id>:`, never inside the shared module's `m:<name>:`. `<name>` is URI-encoded as `prefixFor` encodes it, and each prefix keeps its trailing colon, so a purge of `ms:foo:` can't reach `ms:foobar:`. So `redis-namespace.js`'s rule that no prefix starts another holds, and a `--stdio` run of the same module can't reach a session's keys. A purge of the module covers both prefixes. `unprefixError` strips the session prefix as it strips `m:<name>:`.
  - **Files (the maintainer's decision):** the partition covers `/data` as well as the store, with the same lifetime (below).
    - the path is `<moduleDataPath>/<name>/sessions/<session id>/{data,tmp}`, made 0700 by `lib/module-data.js`;
    - the fs broker maps the worker's `/data` and `/tmp` there on the main thread, and the fs scrub strips that root from paths and error texts;
    - the worker is given the root `moduleDataPath`, as today, never the session path.
  - **Lifetime.**
    - A session's partition, store and files alike, survives a runtime restart while the session resumes. It's removed only on the session's `bye`, or when its reconnect window expires. It's never removed on `Registry.close()` (a runtime stopping), which ends sessions without their leaving.
    - A restarted runtime keeps the sessions' ids (**the restored ids**): a restored row's `session` is the old id, and the registry rebuilds each restored session with it, unconnected, with its resume hash (section 6). A rebuilt session's reconnect window **starts at the restore**, so a shim that never comes back has its session, and its partition, removed once that window expires, not at the next restart.
    - **The sweep:** before the listener accepts, the runtime lists the partitions present (directories and `ms:` keys) and removes those whose ids weren't restored.
    - After a daemon death, nothing is restored, so the sweep removes every partition. Each reconnecting session is told "per-session state was reset", as §6 tells loosenings.
- **The limits.**
  - At most `maxSessionWorkers` per-session workers in all (default 16). At the cap, the least recently used worker of a session with no call in flight gives up its slot (announced, as above). If none can, the call is refused with `SESSION_WORKERS_BUSY` (retryable). Nothing is queued.
  - The listener's `maxSessions` (256) bounds the partitions, not the workers.
  - **The fs quota** applies across all of a module's partitions together, not to each one, so a module can't multiply its disk by its sessions.
- **The memory cost.** Each live session worker costs one lean worker's resident baseline: **to be measured** (a register row for A: one idle lean worker's RSS per extra worker, on the release's Node and platforms, with a small module loaded). So the cap bounds it at 16 times that, above today's shared workers. The cap is the operator's to lower, never a client's to raise.
- **Tests** (R1):
  - two sessions calling one per-session module see separate store keys and separate `/data`, and a shared module sees one;
  - a hop runs in the calling session's worker, and a token past its session's end is refused;
  - a restart with a restored table keeps those partitions and sweeps the rest;
  - `close()` removes none, and the window's expiry removes that session's;
  - the cap's slot hand-over is announced, and the cap refuses `SESSION_WORKERS_BUSY` when no slot can be freed;
  - `--stdio` keeps today's paths, and the HTTP profile refuses the load;
  - no session id reaches the module (options, workerData, env, argv, error texts, job data).

## 5. The daemon, the control channel and per-client inputs

- **The control channel** stays one IPC channel between the daemon and the runtime: one per runtime, and so one per user. ch-local's requests arrive on it as now. A request about one session names it.
- **The client's own inputs come from one short-lived child, `node ch-local conditions --for <client pid> --home <home>`,** which the shim runs once per connection.
  - Both arguments are required. `--home` is the shim's own absolute home, so the child never guesses it from the client's environment; a missing or relative one is refused (exit 2, no line), which the shim counts as failed.
  - The child reads the secret exactly as the shim does (section 1's checks), and runs `gh` with its working directory set to the home, never the client's.
  - It runs in the shim's working directory, which is the client's. Its environment is the client's, minus every variable whose name starts with `NODE_` or `npm_config_`, so nothing acts in Node before ch-local's own code. The conditions check reads the client's environment as data (`lib/client-conditions.js`), and the variables it reads are none of those.
  - It prints one JSON line and exits:
    - `status`: `"ok"`;
    - `conditions`: `"yes"` or `"no"`, from the existing check of *this* client: the process `<client pid>` (the shim's parent), the environment and the project directory;
    - `repo`: the cwd's git remote as an `owner/name` slug, or null;
    - `token`: the keyed hash (below) of the token this environment *chooses*, or null when it chooses none;
    - `credentials`, when any: for each other pack credential this environment chooses (named only by the installed packs' declarations, never by the environment), its keyed hash, by variable name.
  - `node` and the `ch-local` entry are the absolute paths that `ch-local install` writes to `<home>/shim.json` (section 6, "The shim's home and `shim.json`").
  - **A failure is never "no token".** The shim waits 10 s for the line. If the child exits non-zero, times out, or prints anything but one valid line, the shim sends `client` with `status: "failed"` and `why`.
    - **For the first `client` frame**, the runtime answers `own-runtime` (`"conditions-failed"`). The session can't be shown to share the daemon's token, so it doesn't share. The per-session runtime says why.
    - **For a `conditions?`**, a failure counts as `"no"` for that form.
  - **The `client` frame is the child's line, spliced in.** The child's one JSON object (`status`, `conditions`, `repo`, `token`, `why`) is spliced into `{"op": "client"}`, with `"seq": n` added only when it answers a `conditions?` (vector `clientFromChildLine`). Anything but exactly one valid JSON object line becomes `{"op": "client", "status": "failed", "why": "…"}` (vector `clientFromBadChildLine`). So does a line naming its own `op` or `seq`, which would make duplicate keys once spliced. The shim keeps the child's bytes as they are after `{"op":"client",` (and `"seq":n,` when answering), never re-serialized.
  - So the shim carries the child's verdict as it is. So the client checks stay in one place, in Node, and the Rust shim never reads a client's environment for meaning.
- **may-elicit is that verdict, asked fresh.** Part 3 P2 checks the conditions again before each form and again at the confirmation. So the runtime sends `conditions?` each time, and the shim reruns the child.
  - **The timeouts:** the shim gives the child 10 s, and the runtime waits 12 s for the answer. The child's Windows ancestry read, through PowerShell, takes 1 to 10 s; that's why P2's 5 s `ask` wait doesn't apply here. No answer within 12 s, or a failed one, is no: no form.
  - **The latch is the runtime's, per session.** The child lives a second and can't hold it.
- **The daemon's environment and working directory are fixed** (finding 3):
  - its env is fixed: a PATH resolved and recorded by `ch-local install` (never the arriving shim's), the home, and the GitHub token by today's precedence. That's `COUNTINGHOUSE_GITHUB_TOKEN` from ch-local's own settings environment, else `gh auth token`, else `GITHUB_TOKEN`, held in memory only;
  - its cwd is `<home>`;
  - nothing from any client's environment reaches it.
- **A shim launched with inputs the shared runtime can't honour per session runs the per-session mode instead:** it execs `<node> <chLocal> start --stdio --own-runtime --home <home> <its arguments>`, from `shim.json`, and says so on stderr and in the first result's notice. `--home` is the shim's own (absolute; `start` refuses a relative or missing one with exit 2), and it overrides `COUNTINGHOUSE_HOME`, so a client's environment can't pick another home. ch-local's options come before the pass-through flags, and neither reaches the runtime. A pass-through flag it sees in its own arguments, before attaching; a token, when the runtime sends `own-runtime`. Those inputs are:
  - a pass-through runtime flag (`--moduleSandbox`, `--maxOutputBytes`, `--requestTimeout`, `--locale` or any other `start` passes through);
  - a pack credential the client's environment *chooses* that the daemon's runtime doesn't hold the same (its runtime holds only what an allowance names: `--remoteCredentials`, or a pack loaded in place). The runtime sends `own-runtime` (`"credential"`). A `credentials` key that isn't an object of at most 32 entries, each an environment variable's name and the standard base64 of 32 bytes, is `own-runtime` (`"conditions-failed"`), never a share;
  - a token the client's environment *chooses* under today's precedence, which differs from the daemon's. That's a `COUNTINGHOUSE_GITHUB_TOKEN`, or a `GITHUB_TOKEN` when `gh` has none. A shell-wide `GITHUB_TOKEN` beside a working `gh` login chooses nothing, so it doesn't push a session to its own runtime.

    Tokens are compared by a keyed hash and never sent. The child computes `HMAC-SHA256(secret, "ch-token" ‖ token)` (it can read the secret, as the user), and the shim carries it in the `client` frame. A pack credential is compared the same way, as `HMAC-SHA256(secret, "ch-cred" ‖ name ‖ 0x00 ‖ value)`. The runtime compares it in constant time with the same keyed hash of the daemon's token. Neither token crosses the socket. On a difference the runtime sends `own-runtime` and closes.

  Otherwise one session's `--moduleSandbox audit` would put every session in audit, and one client's token would be silently replaced or shared.
- **`defaultRepo` becomes a per-session input default. There's no new module API.**
  - Today `start` reads the git remote of its cwd and writes `{defaultRepo}` into the pack's device config: one value for the runtime, so every session would act on the first session's repository.
  - In shared mode, the `conditions` child reads the cwd's remote, and the shim carries just the `owner/name` slug in the `client` frame. It's a repository name, not a path.
  - A pack declares which input a session default fills, in its reviewed manifest: `countinghouse.sessionDefaults` in package.json, for example `{"repo": "repo"}`.
  - The main thread fills that input **only when a client's direct call omits it**, and **never on a hop**. It checks the slug against the `owner/name` pattern before filling. It fills before the input schema check, so the value is validated like any input.
  - The module sees an ordinary input, never knows it was filled, and an input the caller gave is never overridden. Pack 1 only adds the declaration. Device config no longer carries `defaultRepo`.

## 6. Lifecycle

### Where session state lives: in memory, never on disk (finding 1)

**The daemon holds the session table, in memory only.** For each session it holds:
- its session id, the registry's 32 hex characters, which a restarted runtime keeps (the restored ids: below, and §4a);
- the hash of its current resume token;
- its overrides: loosenings and tightenings;
- its this-session packs, and its packs turned off;
- its decline locks, and the forms it has left;
- the kinds of which it has left one form unanswered (`unanswered`, since #308). Two of a kind lock that kind, so without it a restart would hand a form back.
  - It is in a state only when there is one; a state with none is exactly `{overrides, locks, formsLeft}`.
  - A form open when the state is told counts, so a kind with one unanswered and another open is told as locked. An answer's tell corrects it.
  - A kind is in `locks` or in `unanswered`, never both, and `unanswered` is there only with a form spent (`formsLeft` under 3).
  - **The pairing (the reviewer, 2026-11-15):** the runtime may tell `unanswered`, and a daemon must accept it. A daemon that does not (ch-local before 54858ea) drops the session's whole row when told it. No ch-local has been released without it, so there is no marker and no gate: the first release ships both.

Nothing of a session is ever written to a file.

**A runtime restart (the daemon lives on)** keeps every session:
- The daemon hands the table to the new runtime over the IPC control channel before that runtime accepts connections.
- Each shim reconnects and resumes, with its overrides, packs and locks as they were.
- Restored loosenings need no fresh confirmation (§11 answer 4). Each is re-checked against the ceiling, and a this-session pack is restored only if its version still matches the one its form named.
- The conditions are asked again (`conditions?`) before the next form, as before every form.
- The restore is announced: "restored after a runtime restart".

**A daemon death** loses the table:
- Each session's **loosenings are gone**, and the reconnect announces it: "your this-session loosenings were reset; ask again".
- Its **tightenings are kept by the shim.** For each tightening its session makes, the runtime sends `record` with an opaque entry. The shim keeps the entries and sends them back in `replay` once a connection is `settled`, on every connection while it holds any, before any client line it held. A value already in effect is skipped, so a replay to a session that has it changes nothing.
- The runtime applies a replayed value only if it is **at least as tight** as both the global default and the ceiling. So a forged replay can only tighten. No file is involved, so nothing a same-user process could plant becomes a loosening.

**The resume token is single-use and rotated:**
- Each `WELCOME` gives a new one, and the old one is void.
- A resume is refused while the session still has a live connection, so a copied token can't take over a live session.
- The daemon stores only a hash of the current token: **plain SHA-256**, as 64 lowercase hex characters, in memory only.
  - **Why no key is needed.** The token is 256 random bits (`crypto.randomBytes(32)`), so a preimage of its hash is infeasible. No HMAC key has to outlive a runtime. The new runtime looks a presented token up by its SHA-256, a map lookup, which is fine for the hash of a 256-bit secret.
  - **Told before it's sent.** The runtime tells the daemon `{type: 'session-resume', session, hash}` for each new token *before* it writes the `WELCOME` carrying it. The tell and the socket write go out on separate descriptors, though. If the runtime is SIGKILLed while the IPC pipe is backed up, the daemon can miss the newest hash while the shim has the token. The shim's resume is then `RESUME_REFUSED`, and it fails closed: it opens a new session and replays only its tightenings. A session's end is told as `{type: 'session-gone', session}`.
  - **One hash, one session.** A restore with two rows sharing a hash is refused, and a session's end removes its hash only if that hash is still its own.
  - **Handed back on a restart.** Each restored row is `{session, resume, state}`: `resume` is that hash, beside B's state and never inside it. The runtime validates it as exactly 64 lowercase hex characters, then waits for the session's resume within the reconnect window.
  - **A hash alone resumes nothing.** The shim authenticates with the new runtime's secret (HELLO, PROVE, AUTH) before its RESUME, and the first resume rotates the token again.

### The shim's home and `shim.json`

- **The home comes from one argument.** `ch-local install` writes the client config as `<absolute shim path> --home <absolute home>`. The shim takes its home only from `--home`, never from the environment, so a client's environment can't point it at another home. Pass-through runtime flags, if any, come after it (section 5's per-session rule).
- **`<home>/shim.json`**, 0600, is trust-checked exactly as the secret is (section 1): `lstat`, open with `O_NOFOLLOW`, `fstat`, then the owner and the mode; on Windows, the `privateProblem` rule. Its form:

  ```json
  {"node": "<absolute path to node>", "chLocal": "<absolute path to ch-local's entry .js>", "env": {"PATH": "…", "HOME": "…"}}
  ```

  - `node` and `chLocal` must be absolute paths. Anything else is refused.
  - `env` may hold only the allowlist in step 4 below, with string values:
    - `PATH`;
    - `HOME` (on Windows `USERPROFILE`);
    - `LANG`, if set at install;
    - on POSIX `TMPDIR`;
    - on Windows `SystemRoot`, `TEMP`, `TMP`, `APPDATA` and `LOCALAPPDATA`.

    **Any other key is refused**: the attach stops, naming it. It is never dropped silently.
  - The shim runs `<node> <chLocal> daemon --home <home>` and `<node> <chLocal> conditions --for <pid> --home <home>` from it.

  The vectors give accepted and refused forms (`shimJson`).

### Starting

1. A shim makes the directory and ownership checks (section 1). Then it reads `<home>/run/daemon/daemon.json`: `{pid, socket, runtimeVersion, daemonVersion, started}`. `socket` is the Unix socket path or the Windows pipe name.
   - **`socket` may be null.** The daemon clears it when a runtime ends (a crash or an upgrade) and writes the successor's once that one listens, so nothing probes a name that's free for anyone to take.
   - **A shim treats a null `socket` as not yet ready**, and retries within its 20 s, as for a `daemon.json` mid-write: it's malformed for now, never a stop (the shim's `config.rs` and `attach.rs`).
2. If the pid is alive and the handshake completes, it's attached.
3. Otherwise it takes `<home>/run/daemon/start.lock`, and checks again under the lock. **The lock is ch-local's `lib/lock.js` protocol, exactly**, so the Rust shim and Node take one lock and never two daemons start:
   - **The content.** The holder is `{"pid": <int>, "host": <string>, "at": <ISO-8601 UTC time>}` and a newline. `host` is the host name, plus on Linux `#` and the target of `/proc/self/ns/pid` (`pid:[…]`), so two containers sharing a host name don't take each other's live lock for dead.
   - **Created whole.** The content is written to `<lock>.<pid>.<random hex>.tmp`, hard-linked to the lock's name (`link`; on Windows `CreateHardLinkW`), then the temporary file is removed. A link that fails with "exists" means another holds it. So a lock is never seen empty, and an empty or unreadable lock is never taken for stale.
   - **The heartbeat.** While held, the holder sets the lock's mtime to now every 15 s.
   - **Gone.** A holder is gone when its `host` is this host and its pid is dead (`kill(pid, 0)` fails with anything but `EPERM`; on Windows `OpenProcess` fails), or when the lock's mtime is more than 2 minutes old on any host.
   - **Taking a gone holder's lock.**
     1. Create `<lock>.break` exclusively, holding the pid.
     2. If that exists already, and is more than 10 s old, remove it and try again later. Otherwise wait.
     3. Read the lock again. Remove it only if it is still the same holder: `pid`, `host` and `at` all equal.
     4. Remove `.break`.
   - **Releasing.** The holder removes the lock only if it still holds its own `{pid, host, at}`.
   - **Waiting** for a live holder: poll every 200 ms, within the shim's 20 s.
4. Still nothing, so it spawns `<node> <chLocal> daemon --home <home>`, from `shim.json`, with its working directory the home too, detached, then **releases the lock at once**. The daemon refuses to start if `--home` and its working directory disagree:
   - on Windows, `DETACHED_PROCESS | CREATE_NO_WINDOW`;
   - on POSIX, in a new process group (`process_group(0)`), with stdio on null.

   The daemon ignores `SIGHUP` from its first line, so it outlives the shim's parent ending.
   - **The shim clears the environment** and passes only `shim.json`'s `env`, which `ch-local install` resolved and recorded:
     - `PATH`;
     - `HOME` (on Windows `USERPROFILE`);
     - `LANG`, if set at install;
     - on POSIX `TMPDIR`;
     - on Windows `SystemRoot`, `TEMP`, `TMP`, `APPDATA` and `LOCALAPPDATA`.

     Nothing comes from the client's environment, `NODE_OPTIONS` least of all, since it would act before any of ch-local's code, in every session's runtime.
   - **Its working directory is `<home>`.** The daemon reads the GitHub token itself (section 5).
5. **The daemon takes `start.lock` itself, as its first act** (behind the shim's release), and checks `daemon.json` again under it.
   - A live daemon in it means this daemon exits at once.
   - Otherwise it spawns the runtime with `--sessionSocket` and the control channel, writes `daemon.json` once the socket listens, then releases the lock.

   Only a holder releases its own lock (`lib/lock.js`), so the shim and the daemon each hold it in turn.
6. The shim waits up to 20 s for a handshake to succeed.
7. **The cost of the gap.** A second shim that gets the lock between the first shim's release and the daemon's take finds no `daemon.json`, and spawns a second daemon. That daemon waits for the lock, finds the first one's `daemon.json` and exits. The only cost is a wasted spawn; two daemons never both run.

### Idle stop, and the race with an arriving shim

- After the last session leaves, the daemon waits `daemonIdleMinutes` (default 10).
- Then it takes `start.lock`, checks under it that there's still no session and no handshake in progress, removes `daemon.json`, stops the runtime, releases the lock and exits.
- A shim arriving during the wait cancels the stop by connecting.
- A shim arriving during the stop blocks on the lock. Once it gets the lock it finds no `daemon.json`, and starts a new daemon.

### Upgrade

`ch-local upgrade` (or the daily automatic upgrade) installs the new version, then appends an `upgrade` request to `<home>/run/daemon/requests` (owner-only), which the daemon watches as it watches the home.

**When the runtime changed**, the daemon:
1. stops accepting handshakes;
2. sends every shim `drain` (section 1);
3. waits for in-flight calls, up to `--requestTimeout`;
4. stops the old runtime;
5. starts the new one and hands it the session table.

**When the daemon itself changed** (ch-local upgraded), the daemon re-execs, carrying the session table over a pipe to its new instance:
1. it drains as above;
2. it starts the new daemon with the table on that pipe, under `start.lock`;
3. it exits once the new daemon has written `daemon.json`.

**The handoff never carries a loosening.** Any process of this user can stop the daemon, or outwait it, and start `ch-local daemon --handoff` with a pipe of its own. A restored loosening needs no fresh confirmation (§11 answer 4). So, under the rule that nothing a same-user process could plant becomes a loosening:
- the new daemon keeps, from the handoff, only each session's tightenings, its packs turned off, its decline locks and the forms it has left;
- it drops every confirmed loosening, and every pack turned on in conversation;
- each session that lost one is told, as after a daemon death: "your this-session loosenings were reset; ask again".

A ch-local upgrade is therefore a daemon death for loosenings, and only a runtime upgrade (the daemon living on) keeps them.

The handoff goes on the new daemon's fd 3, as a 4-byte length and `{v: 1, sessions, declines}`. It's never in argv or the environment, and the secret is never in it. If the handoff fails, the new daemon starts empty: loosenings are reset, announced, and tightenings come back from the shims.

### Reconnecting (finding 8)

**On `drain`:**
- The shim forwards no new requests, and holds them (section 1).
- It keeps relaying answers to its in-flight requests until the runtime closes the connection. The runtime finishes them and meters them, as usual.
- Then it reconnects.

**On a connection lost without `drain`** (a crash), the shim sends the crash answer (section 1) for each request it relayed and never saw answered. The call may have run before the crash, so the client is told it might have. A `subscriptions/listen` request (#231) is answered the same way, and the client re-issues it, as the spec has it ("the client re-issues the request").

**Then, in both cases**, the shim:
1. reattaches, starting the daemon if needed;
2. resumes with its resume token, or, on `RESUME_REFUSED`, opens a new session;
3. sends the `client` frame again, from a fresh run of the `conditions` child, and, while it holds records, once `settled` comes, sends `replay` before any client line it held (a resumed session too: one lost after its settle may never have read the replay);
4. on a legacy session only (the client sent `initialize`), when it replays that line: sends the client `notifications/tools/list_changed`, then replays the line with the id `"ch-shim-replay-<n>"` and sends `notifications/initialized`. The replay's answer is dropped (the client already has one), but read first, at most 64 KiB: for each of `prompts` and `resources` whose `result.capabilities.<list>.listChanged` is `true`, the client is sent `notifications/prompts/list_changed` or `notifications/resources/list_changed`. (A 2025-11-25 client is told when its prompts and resources lists change, as its tools; a runtime that doesn't declare it is told nothing more for them.) An answer past that size, one that doesn't parse, an error answer, or one without an object `result` or without the field tells nothing more, silently; nothing is told once the session has closed or been handed on; an answer cut short ends the connection, as any cut message does;
5. on a modern session, sends nothing of its own. The client's listen stream ended, and the client opens it again.

### Crash of the runtime or the daemon

- **The runtime:** the daemon restarts it once immediately, then backs off at 1 s, 5 s and 30 s. It hands the table over each time. After 5 failures in 10 minutes it stops restarting: it writes `failed.json` (below), removes `daemon.json`, and exits.
- **The daemon:** the next shim to reconnect finds the pid dead, and starts a new daemon under the lock.

### `failed.json`: falling back without a loop

A daemon that gave up says so in `<home>/run/daemon/failed.json`, so the shims fall back to the per-session mode instead of starting daemon after daemon.

- **Written** by the daemon as `daemon.json` is: 0600, through an exclusive temporary file, `fchmod`, then a rename. Exactly:

  ```json
  {"v": 1, "at": <epoch ms>, "exit": <integer or null>, "signal": <"SIG…" or null>, "reason": "restarts-exhausted" | "never-listened"}
  ```

  - `v` is exactly 1; `at` is a positive safe integer; `exit` is a safe integer or null; `signal` matches `^SIG[A-Z0-9]+$` or is null; `reason` is one of the two strings.
  - The key set is exact: none extra, none missing, none twice. It holds no path, environment or stderr text.
- **Read** by the shim with `daemon.json`'s trust checks (the 0700 directory, 0600, the euid's, no links, at most 512 bytes; on Windows the owner and DACL equivalents). It's read at two points: after the `daemon.json` check fails, and again under the start lock, immediately before a spawn. So a daemon that gives up between the two never gets a fresh daemon started behind it.
- **Fresh** means `now − 600 000 ≤ at ≤ now + 60 000` (ms). A fresh, valid file means no daemon is spawned, and the session runs its own runtime. Anything else (stale, from the future, unreadable or invalid) is ignored, and the shim goes on as before.
- **Cleared** by the next daemon whose runtime listens. So the shared mode comes back after 10 minutes, or as soon as a new daemon succeeds.
- **The fallback at startup:** before the shim has read anything from stdin, it runs `start --stdio --own-runtime --home <home> <its arguments>` with the shim's stdin, waits, and exits with its code. That's today's pass-through path (on Windows, a spawn, since there's no exec). It says on stderr only: `the shared runtime failed (<reason>); this session runs its own`, with `reason` the enum alone.
- **The fallback mid-session:** a session that was live loses the daemon, reattaches, and finds a fresh `failed.json`. Its in-flight requests already had their crash answers (section 1).
  - **Never looser.** A session's tightenings live only in the runtime's memory and the shim's records, never in `settings.json`. A per-session runtime starts at the file's values and takes no `replay` (it speaks MCP on stdio, with no `C` frames). So **a shim holding any record refuses the mid-session fallback**:
    - it answers each held request, and each later one, with `sessionCantFallBackAnswer` (exact apart from the id);
    - it says on stderr: `the shared runtime failed (<reason>), and this session's tightened settings can't move to a runtime of its own: restart the session`;
    - then it exits non-zero.
  - **With no record**, the per-session runtime it starts has never seen this client's `initialize`, so the shim:
    1. replays its recorded `initialize` line, then `notifications/initialized`, and drops that `initialize`'s answer, since the client already has one. Once that answer comes with an object `result`, the client is sent `notifications/tools/list_changed`, and `notifications/prompts/list_changed` and `notifications/resources/list_changed` for each list whose `result.capabilities.<list>.listChanged` is `true` (its lists may be others than the shared runtime's); the answer is looked for among at most 64 lines of the runtime's output, each held only up to 1 MiB;
    2. then sends the lines it held, then relays stdin as it comes.

    The per-session runtime needs nothing new. The replay, and dropping its answer, are the shim's.
- **Vectors** (`failedJson` and `sessionCantFallBackAnswer` in `shared-runtime-wire/make-vectors.js`): valid at both edges (`at` = now − 600 000 and now + 60 000); stale (now − 600 001); future (now + 60 001); an extra key; a missing key; `at` as a string; `at` as a float; `signal` `"KILL"` without `SIG`; a duplicate key. Plus the cases: a mid-session fallback with a record is refused; one without replays `initialize` first.

## 7. Windows and macOS

**Windows.**
- The named pipe and its facts as in section 1, the secret's DACL through `lib/win-acl.js`, and a fatal bind failure.
- The daemon runs detached and hidden: no Windows service, no Task Scheduler.
- The `conditions` child uses the existing PowerShell ancestry reader. The shim passes it its parent's pid.

**macOS.** The 104-byte socket path limit and the `$TMPDIR` fallback. No launchd agent: the shim starts the daemon. Release 1 ships the shim unsigned (signing comes in a later release), as `shim.yml` and ch-local's README say; macOS notarization and Windows signing come in a later point release. The managed preferences and plist sources in the client conditions are unchanged.

**Linux.** As described. `XDG_RUNTIME_DIR` isn't required.

## 8. The shim's cost

A few MB per shim, measured later. A measures the Rust shim's memory. The Node relay measured for revision 3 used 13 MB PSS each. The `conditions` child is Node, but it runs for about a second per connection and exits.

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
- It can't change another session's settings.
- **A global change from conversation is explicit, confirmed, and low-stakes only** (the maintainer's decision):
  - in one session the user asks for a low-stakes setting to change for all sessions;
  - after the confirmation it becomes a global change, and every session gets a notice of it;
  - a heavy setting changes only from the terminal, as before.

  B builds it in B2.
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
   - The `conditions` child runs as the user, from the paths in `shim.json`.
   - A same-user process that can rewrite `shim.json` can already change ch-local itself, so this adds nothing.
5. **A module holding two sessions' calls at once** (it serves both) holds two hop tokens, and can make a hop with either, so with the other session's cap or timeout, and into the other session's worker of a per-session module (§4a), so with its state. The values stay within the ceiling, and a module already sees all of one user's data. A token or peer channel that outlives its session is refused like an unknown device.
6. **On Windows, another user (local, or remote over SMB) can delay attaches, never break a handshake under way. Availability only.**
   - **What it can do:** list the pipe's name, and open read-only instances. A read-only instance can't write, so it sends no bytes: past 64, the oldest such one is evicted for a new connection, and read-only openers never hold the pool. A user who can write can send a few bytes and so hold a slot up to its 2 s deadline; with all 64 held that way, a new connection is refused, so such a flood can delay a real shim's attach (the shim retries with jitter, for up to 20 s), and one kept up for longer keeps a new shim out meanwhile. No flood breaks a handshake under way.
   - **What it can't do:**
     - send a byte: the client speaks first, and only the owner, Administrators and SYSTEM can write, so it never even sees a `PROVE`;
     - create an instance: that needs `FILE_CREATE_PIPE_INSTANCE`, which read access doesn't include;
     - take the name ahead: it's 128 random bits, new at each start, and `FILE_FLAG_FIRST_PIPE_INSTANCE` makes a held name fail our bind rather than share it;
     - read or forge a session.
   - **Why it stands:** Node can't set the pipe's descriptor or `PIPE_REJECT_REMOTE_CLIENTS`, and the maintainer's decision is no native helper (it would break the runtime's pure-JS install).
7. **On Windows, the daemon inherits any inheritable handle the client leaked into the shim.**
   - The shim makes its own three standard handles non-inheritable before it spawns the daemon, and refuses to spawn if that fails.
   - Rust's `std` `CreateProcessW` passes `bInheritHandles = TRUE` and offers no `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, so closing the rest needs a hand-written `CreateProcessW`. That's post-release.
   - It's accepted for release 1 because Node module code can't use a raw inherited `HANDLE` value the way it can a POSIX descriptor number.
   - On POSIX there's no such residual: the shim marks every descriptor from 3 up `FD_CLOEXEC` at startup, and refuses to start a daemon if it can't.
8. **On Windows, the daemon's readiness probe uses Node's connect.**
   - **What's checked otherwise:** a `daemon.json` read from disk may be stale, so its pipe goes through PowerShell, as the shim opens one: Identification only, the pipe's owner this user, SYSTEM or Administrators, then the PROVE.
   - **What isn't:** the probe of the daemon's own new runtime, after that runtime has told the daemon it listens, uses Node's `net.createConnection`. That allows impersonation and checks no owner.
   - **Why that's narrow:** the name is fresh and random, and a bind by anyone else first would have failed our runtime's bind. So the only gap is that runtime dying within the probe's ~100 ms after its tell, and another user binding the freed name inside that window.
   - **Accepted:** rather than a PowerShell run (1 to 10 s) at every runtime restart.
9. **A restored row's claim of a confirmed loosening is the daemon's word.**
   - No dialog is shown again for it (§6, §11 answer 4). So whoever can speak as the daemon on the runtime's control channel can raise a session's cap as far as the ceiling, with that session's client agreeing (`conditions?`), and no dialog.
   - The channel is the pipe from the process that started the runtime, which is ch-local, the user's own. A module has no way to it.
   - **What still bounds it:** the ceiling, the session's own client's answer now, and a default lowered since (the row's `over`, which is the row's claim too). A row can't lock less than a missing table does: a runtime that gets no table locks every setting's dialogs.

## 10. Migration and the per-session mode

- **`ch-shim` is the new client entry,** where a binary exists for the platform: Linux, macOS and Windows, each x64 and arm64 (the maintainer's six targets). Client snippets and `ch-local install` write it, with `<home>/shim.json`.
- **No binary for the platform:** `ch-local install` writes `ch-local start --stdio` and says the platform runs one runtime per session. There is no Node shim.
- **Existing configs keep working.** A client config that launches `ch-local start --stdio` execs the shim when one is installed, and otherwise runs today's per-session runtime, saying so. So no user has to edit a client config.
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
| the usage report; the settings tool's `get` history | per caller; whole history | the session's own (the terminal shows all); globals plus the session's own lines |
| `lib/settings-tool.js` UNCONFIRMED counts | per start, per history file | per user (follows the file) |
| ceiling cache | machine-wide | unchanged |
| live modules, captureAtStart | one module set | unchanged; calls carry their session |
| `lib/notices.js` pending, notifier, minimum | one each | per session; global notices copied to each |
| `lib/route-manager.js` startStdio: appKey, the listed fingerprint, the ready gate | one per process | appKey per runtime; fingerprint and list_changed per session; the ready gate per runtime |
| `lib/mcp/stdio.js` transport | one | one per session connection |
| `lib/control-channel.js` current | one | one per runtime; session requests name the session; may-elicit goes to the shim |
| call tokens | the caller's identity and billing | plus the session, its cap and its timeout |
| ch-local `client-conditions.js` | start's parent, one latch, start's env | in the `conditions` child the shim runs per connection; the verdict per session |
| ch-local `in-place.js` | one applier per start | in the daemon, per runtime; this-session packs and notes per session |
| ch-local `start.js`: env, token, defaultRepo, run dir | one start, its env and cwd | the daemon's fixed env (an install-resolved PATH) and cwd; defaultRepo as a per-session input default, declared by the pack, for direct calls only; a shim with its own flags or chosen token runs its own runtime |
| ch-local `history.jsonl` | by start | per user; lines about a session name it opaquely |

## The plan

**C** takes the daemon, the shim, the lifecycle and the transport. **B** takes the session layers, after part 3 P2. Each task is test-first, with its own PR.

**C1. Runtime: the session transport** (countinghouse).
- `--sessionSocket <path>` with `--controlChannel ipc`. It makes the runtime single-identity without `--stdio`: today `singleIdentity` requires `--stdio` (`lib/cli-options.js`), and `startStdio` exits when its input ends. In session mode, stdin's end doesn't stop it.
- It covers: the directory checks, the secret, the HMAC handshake, the framing, the pre-auth cap, the control ops, and the session registry, exactly as section 1's contract.
- It runs `shared-runtime-wire/vectors.json`, moved to `test/fixtures/` with the code. A's shim runs the same file.
- Each authenticated connection is served by the stdio MCP handler (`lib/mcp/stdio.js`), one instance per session.
- Tests (Docker):
  - a wrong MAC either way, no hello, or a too-long frame are refused;
  - a 65th unauthenticated connection evicts the oldest silent one, or is refused when every one has sent bytes; one silent past 2 s is closed;
  - a reply's id travels in the frame header;
  - two sessions get their own initialize and list;
  - a `C` frame can't come from client bytes;
  - traffic is byte-exact;
  - a long socket path is refused.

**C2. Windows and macOS transport** (countinghouse).
- The random pipe name in owner-only `daemon.json`, the fatal bind, the secret's DACL, and the macOS fallback.
- Tests: the Windows CI subset (a second bind is `EADDRINUSE`, and the runtime exits), plus the path limit, server-free.

**C3. `ch-local daemon`** (ch-local).
- The lock, `daemon.json`, the fixed env and cwd, the in-place applier and watcher, and the in-memory session table with its handoff to a restarted runtime.
- The idle stop with its race, the restart backoff, the upgrade requests, and the re-exec handoff.
- Tests (node:test, stub runtime):
  - two shims start one daemon, and a second daemon exits;
  - the daemon outlives its launching shim's parent ending (SIGHUP ignored, its own process group);
  - a `shim.json` with a key outside the allowlist, a relative path, or a non-string value is refused, naming it;
  - an arrival during the idle stop gets a new daemon;
  - the upgrade drain;
  - the handoff keeps overrides, and the sessions' ids;
  - the backoff.

**C4. The shim's Node side** (ch-local). The Rust shim itself is A's: relay, handshake, reconnect and replay, against section 1 and the vectors.
- `ch-local conditions --for <pid> --home <home>`: the one JSON line (verdict, slug, token MAC).
- `<home>/shim.json` at install.
- `ch-local start --stdio` execs the shim when installed, and otherwise runs the per-session mode, saying so.
- Tests:
  - the child's line for a yes, a no and a failure;
  - the token MAC matches the vectors;
  - a `start --stdio` with no binary says so and runs its own runtime.

**C5. Per-client inputs** (ch-local, finding 3).
- A shim with pass-through flags or a differing token runs `--own-runtime`, and says so.
- `runtime: own`.
- Tests: `--moduleSandbox audit` doesn't reach the shared runtime, and a differing token runs its own runtime.

**R1. Per-session modules** (countinghouse, §4a; needs the restored ids of §6 and B2):
- the manifest field and its pin, and the HTTP refusal;
- the pool keyed by session, and the hop and job checks;
- the `ms:` prefix and its purge, and the fs partition;
- the lifetime, the sweep and the announcements;
- the cap and `SESSION_WORKERS_BUSY`.
The tests are §4a's. The owner is assigned by the Reviewer.

**R2. The install review line** (ch-local; after R1): "keeps state per session".

**C6. Docs and migration.** The README, the client snippets and `ch-local install`; `docs/security-model.md` (section 9's residuals); `docs/upgrading-to-8.md`.

**B1. Sessions on the main thread** (needs C1's registry).
- The session on each call, and in call tokens (with the cap and timeout) and jobs, through to usage.
- Per-session clientInfo and notices.
- Tests:
  - a module sees one caller id from two sessions;
  - a hop takes its token's values;
  - a job takes the defaults once its session ends;
  - a declared session default fills a missing input on a direct call only, never on a hop, and a slug outside `owner/name` isn't filled.

**B2. Per-session settings** (needs B1).
- Overrides for every conversational change, and conversation never writing `settings.json`. A terminal tightening drops looser overrides, announced.
- Per-call application by section 3's table. Validators sized for the largest active cap.
- The confirmations split, with the per-user count in the daemon. The form text.
- Tests:
  - one session's raise doesn't change another's calls;
  - a conversational tightening or `pack off` changes only its session;
  - a terminal tightening ends a looser override;
  - a call in flight when the default is tightened gets the tighter cap at its reply, and a re-armed timeout;
  - a job of a session that tightened keeps the tighter value after the session ends, and one that loosened takes the default;
  - raising a session-tightened value back toward the default, or un-hiding a pack, needs a form;
  - a self-answering session loosens only itself;
  - 3 declines across sessions lock that kind;
  - a hop token carries its session's values.

**B3. Per-session packs** (needs B1). This-session packs with session sets, `pack off` per session, an unknown tool for an unlisted one (byte-identical), per-session tools/list and list_changed, and the session check at every hop.
- Tests:
  - from session B, a hop (routed, and over a peer channel) into a pack only A turned on, or one B turned off, is answered byte-identically to an unknown device;
  - the same hop on A's call succeeds.

**B4. The dialog through the shim** (needs C4 and B2). may-elicit from the `client` frame, the per-session latch, the restore checks (ceiling, may-elicit, the pack's version).

**B5. Session-scoped views** (finding 5). Tasks by key and session (another session's task is unknown), the usage report and the settings history per session.

**B6. Validator fairness** (finding 6). In flight and stalls by caller and session, with per-user bounds. Tests: ten sessions each get a slot, within the user's bound; one session's stalls don't throttle another's.

**Order.**
- First, #231 (`subscriptions/listen` on both transports, about 2.5 days).
- Then C1. A builds the shim against section 1 and the vectors, in parallel.
- Then C3 and C4, then C5, then C2.
- B1 follows C1. Then B2, B3, B5 and B6. Then B4 after C4. C6 is last.

**Estimate.** C: about 2.5 weeks after #231 (C1 4 days, C3 4, C4 2, C5 1, C2 2, C6 1). B: about 2 weeks after part 3 P2. A: the shim, A's estimate.
