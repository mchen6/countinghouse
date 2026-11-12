# RC1-min: one remote MCP server per module, called from the main thread

Status: brainstorm round 1 decided by the reviewer, 2026-11-11; this is the spec PR for round 2. Owner: implementer A. Follows
L1 (#44). Consumed by the first pack (`@countinghouse/ch-access-github`,
whose `lib/remote.js` already relies on the interface in section 4).

## Intent

An access module has to call the user's own services (GitHub first) with
the user's credential. The module must never hold that credential. Today a
module could only do this by being handed a token, or by opening its own
connection to the service. That means granting it `net` and giving it the
token in its environment, both of which the sandbox exists to prevent.

RC1-min moves the connection to the main thread. A module declares the one
remote MCP server it talks to. The runtime connects to it, injects the
credential, lists the server's tools at load and records the list. The
module calls a tool with `ctx.call('remote:<name>/<tool>', args)` and gets
back what the server answered. The token stays in the main thread's memory.
It never reaches a worker, a log, a usage record or a result.

## Goals

- One remote per module, declared in `package.json`; the transport is MCP
  streamable HTTP.
- A static bearer credential, read by the main thread from an environment
  variable the declaration names, used only when the operator has allowed
  that variable for that server's origin (section 3).
- `ctx.call('remote:<name>/<tool>', args)` from a module's handler, run on
  the main thread, metered as an inner hop and counted for LM1's usage
  records.
- The remote's tools/list, taken at load and recorded (a hash in the log
  and the permission report); it refuses nothing in RC1-min.
- Transport and protocol failures as catalogue codes; a tool's own error as
  a result.

## Non-goals (out of RC1-min, each a later step)

- Several remotes per module, and HTTP (REST) remotes with `ctx.fetch`.
  Those are the next steps in A's queue.
- Retries of a failed call, a circuit breaker, and any handling of
  tools/list drift (the later RC1 step).
- The registry's enable path, and any UI for credentials.
- OAuth: the refresh-token grant comes later. The credential shape leaves
  room for it (section 2), but nothing of it is built.
- stdio remotes (a local MCP server process). Streamable HTTP only.

## 1. The declaration

`package.json` `countinghouse.remotes` is an array. RC1-min accepts at
most one entry. As the first pack writes it:

```json
"countinghouse": {
  "role": "part",
  "remotes": [
    {
      "name": "github",
      "transport": "streamable-http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {"X-MCP-Toolsets": "actions,repos"},
      "credential": {"env": "COUNTINGHOUSE_GITHUB_TOKEN", "fallbackEnv": "GITHUB_TOKEN",
                     "header": "Authorization", "scheme": "Bearer"}
    }
  ]
}
```

**Reviewer decision, 2026-11-11:** the array with `name` replaces the
11-10 `{alias: {...}}` map, "because it is what the first pack already
declares and tests, a list keeps declaration order (useful for the
permission report and for load-time refusals that name a position), and
`ctx.call('remote:<name>/<tool>')` reads the same either way". Duplicate
names are refused at load.

Fields:

- `name`: `^[a-z][a-z0-9-]{0,31}$`, unique in the array. It is the
  `<name>` in `remote:<name>/<tool>`.
- `transport`: `"streamable-http"`, the only value.
- `url`: absolute, `https:`, no user info, no fragment. `http:` is
  accepted only for a loopback host when the server runs with `--debug`
  (the tests' local server). It is not a module-chosen way past TLS in
  production. Outside `--debug`, a URL whose host is a loopback or private
  address, or whose host and port are the configured Redis endpoint, is
  refused (reviewer, 2026-11-11: a later flag may open local remotes
  deliberately, not now).
- `headers` (optional): a flat map of static, non-secret header names to
  literal string values, sent on every request to that remote (**reviewer
  decision, 2026-11-11**). Values are taken as written, with no
  environment or template expansion. The credential block is the only
  route to a secret header.
- `credential` (optional; without it the remote is called with no
  credential):
  - `env`: the variable the main thread reads;
  - `fallbackEnv` (optional): read when `env` is unset or empty;
  - `header` (default `Authorization`);
  - `scheme` (default `Bearer`): the value sent is `<scheme> <token>`, or
    the bare token when `scheme` is `""`.

Refused at load, each with `REMOTE_DECLARATION_INVALID` and the
declaration's position and field in the message (the module does not load,
as for a bad `countinghouse.calls`):

- not an array;
- more than one entry in RC1-min;
- an unknown field;
- a bad `name`, a duplicate `name`, or an unknown `transport`;
- a `url` that is not absolute https (or the debug loopback exception), or
  that carries user info;
- a header name that is not an RFC 9110 token, or a value that is not a
  string or carries CR, LF or NUL;
- a `headers` entry naming the credential's header (case-insensitive;
  `Authorization` by default, even with no credential block);
- a `headers` entry naming a hop-by-hop header (`Connection`, `Keep-Alive`,
  `Proxy-Authenticate`, `Proxy-Authorization`, `TE`, `Trailer`,
  `Transfer-Encoding`, `Upgrade`, and any name a `Connection` value would
  list);
- a `headers` entry naming one of the headers the transport sets itself
  (`Host`, `Content-Length`, `Content-Type`, `Accept`, `Mcp-Session-Id`,
  `MCP-Protocol-Version`, `Cookie`);
- a `credential` with a `grant` field (section 2).

## 2. Room for the refresh-token grant

`credential` is an object, so a later grant is a new field and the bearer
form stays as it is. The next form will be `credential: {grant:
"refresh-token", ...}`; a `credential` with a `grant` field is refused with
`REMOTE_DECLARATION_INVALID` until that step lands (reviewer, 2026-11-11). RC1-min's code reads the credential through one function,
`resolveCredential(decl, env, allow) -> {header, value, source} | {missing}`,
so the grant replaces its body and nothing else.

## 3. Whose credential, and who allows it

**Reviewer decision, 2026-11-11, the design's most important line:** a
module cannot choose where a credential goes.

The declaration is written by the module's author, and the token belongs
to the user. If a declaration's `credential.env` alone decided what the
runtime reads, any installed module could name `COUNTINGHOUSE_GITHUB_TOKEN`
or `GITHUB_TOKEN` and a `url` of its own, and the runtime would send the
user's token there. That is exfiltration by declaration, with no code
needed. So the operator allows each variable for a server origin, and the
runtime sends a credential only where that allowance matches.

- `--remoteCredentials <file>`, JSON: `{"<origin>": ["ENV", ...]}`, for
  example `{"https://api.githubcopilot.com": ["COUNTINGHOUSE_GITHUB_TOKEN",
  "GITHUB_TOKEN"]}`. An origin is scheme, host and port, matched exactly,
  with no wildcards. It is `https:` (plain `http:` is accepted only for a
  loopback origin under `--debug`). A file that is not this shape stops
  the server at start, as a bad auth config does.
- A declared variable (`env`, then `fallbackEnv`) is read only when the
  file allows it for the origin of the declared `url`. Otherwise:
  - the module loads with that remote disabled;
  - the load writes one log line naming the variable and the origin,
    never a value;
  - every call to the remote rejects with `REMOTE_CREDENTIAL_NOT_ALLOWED`.
- Without the option, no credential is read. A declaration with no
  `credential` block works either way.
- The permission report lists each remote as `sends <ENV> to <origin>`
  (or `sends no credential to <origin>`), with the hash of its recorded
  tools/list.
- In the single-identity profile, the user is the operator.
  `ch-local install` writes `<home>/remote-credentials.json` from its
  allowlist, which holds each pack's declared origins and variables, and
  `start` passes it to the runtime (the client-packs plan, implementer C).
  A hosting operator writes the file by hand.

## 4. The call

```js
const result = await ctx.call('remote:github/actions_list', {method: 'list_workflow_runs', owner, repo});
```

**Reviewer decision, 2026-11-11:** `ctx.call('remote:<name>/<tool>',
args)` resolves with the raw MCP `CallToolResult` as the server sent it,
`{content, isError?, structuredContent?}`, with nothing parsed and nothing
stripped. A tool error (`isError: true`) is a result, not a rejection,
because the composing module needs the text: the first pack reads GitHub's
"410 Gone" from it. Only transport and protocol failures reject, with
runtime codes. The runtime counts bytes and lines of the text content on
the way through (section 6) and does nothing else to the result.

The path:

1. `handler-ctx.js`'s `call` recognises the `remote:` prefix before the
   composition checks. `countinghouse.calls` and `runsModules` are not
   consulted: a remote is not a device, and no identity is authorized for
   it.
2. In worker mode the worker sends one message to its parent, carrying the
   remote's name, the tool, the arguments, the billing identity the
   existing ctx.call path sends (`caller.apiKey`; see Security), and the
   outer call's id when there is one (section 6). In single-thread mode the
   same function is called directly.
3. The main thread resolves the remote by the module that owns the worker
   the message came from, never by a module name inside the message. A
   module can reach only its own declaration.
4. The checks, in order:
   - a name the module did not declare: `REMOTE_UNDECLARED`;
   - a credential that is not allowed, or allowed but unset:
     `REMOTE_CREDENTIAL_NOT_ALLOWED` or `REMOTE_CREDENTIAL_MISSING`;
   - `args` that are not a plain JSON object: `REMOTE_ARGS_INVALID`.
   A tool absent from the recorded tools/list is called all the same
   (section 5).
   The arguments are not validated against the tool's `inputSchema`; the
   server does that, and its answer is a result.
5. `tools/call` goes out over the client, with a timeout of
   `--remoteTimeout` seconds (default 60). The result is checked against
   the SDK's `CallToolResultSchema` and returned as received.
6. The inner hop is metered: `recordCall(billingKey, 'remote:<name>/<tool>',
   mcpToolCallCost)`, after the answer, as `DeviceManager` meters a device
   hop. A null billing identity is refused before the call with the
   existing `HOP_IDENTITY_UNRESOLVED`. The billing identity is
   worker-stated, as on the existing `ctx.call` path, until R2-1 Tasks 3–5
   (reviewer, 2026-11-11).

Rejections, all new catalogue codes of kind `runtime` and not retryable
unless stated:

- `REMOTE_UNREACHABLE`: DNS, connect or TLS failure, or a redirect, which
  is refused and never followed (`redirect: 'error'`; a credential never
  follows a redirect). Retryable.
- `REMOTE_TIMEOUT`: past `--remoteTimeout`. Retryable.
- `REMOTE_AUTH_FAILED`: HTTP 401 or 403 from the server. The message names
  the variable the credential came from, never its value.
- `REMOTE_PROTOCOL`: a non-2xx status other than 401 or 403, a body that
  is not JSON-RPC, a JSON-RPC error, or a result that fails
  `CallToolResultSchema`.
- `REMOTE_RESULT_TOO_LARGE`: a result over `--remoteMaxBytes` (default
  16 MiB), read as a stream and cut off at the limit, so a server cannot
  fill the main thread's memory.
- `REMOTE_UNDECLARED`, `REMOTE_ARGS_INVALID`, `REMOTE_CREDENTIAL_MISSING`,
  `REMOTE_CREDENTIAL_NOT_ALLOWED`: kind `module`, since they describe the
  module's own mistake or its setup.

## 5. tools/list at load

When a module with a remote loads, the main thread connects and lists the
server's tools, following `nextCursor` to the end. It records the list for
the life of the process, as `{name, inputSchema}` per tool, with a SHA-256
over its canonical JSON. The load log line carries the number of tools and
the hash, and the permission report carries the hash. In RC1-min the
recorded list refuses nothing: not the load, not a call, and not a tool
missing from it. Drift handling is the later RC1 step, which this record
is for (reviewer, 2026-11-11).

A listing that fails is logged with its code, and the module loads anyway
(a laptop can start offline). The first call to that remote makes one
listing attempt before it goes out. That is not a retry of the call. Its
failure is logged, and the call proceeds. A missing or disallowed
credential is logged at load by variable name; the listing still runs
without the credential, and a server that needs one answers 401, logged as
`REMOTE_AUTH_FAILED`.

## 6. Counting: LM1's `usage.recordIn`

For every remote call, success or failure, the client calls
`usage.recordIn(call, {server, module, tool, bytes, lines, ms, outcome,
credential})`. The recorder is `require('./usage/runtime').usage()` (C's
`lib/usage/`); `recordIn` is skipped when the call id is null. The fields:

- `bytes`: UTF-8 bytes of the result's text content;
- `lines`: the newline-separated lines of that text, JSON included;
- `outcome`: `ok`, `isError`, or the rejection code;
- `credential`: the name of the variable used, or null;
- `module`: the calling module's friendlyName (the report groups by it).

This is LM1 section 5's interface, built by implementer C in `lib/usage/`.
Until it lands, `lib/remote/` takes the recorder by injection, with a
no-op default. RC1-min's tests assert the calls through an injected
recorder, so nothing waits on C.

`call` ties a `tools/call`'s server records to its result. **Reviewer
decision, 2026-11-11, the propagation rule:**

- The gateway mints the id per `tools/call`, from a per-process counter
  whose start C's `lib/usage/` defines.
- It travels in the invoke args under the framework-injected key
  `usageCall` (an integer, or absent or null), set by the gateway from
  `usage().beginCall({pack, tool, caller})`. `ctx` carries it in
  `buildCtx`'s closure, unexposed to the module.
- It propagates unchanged across every inner hop: composite to part, part
  to part, part to remote. Every `In` record made during one `tools/call`
  carries the same id.
- The `remote:` message sends it back to the main thread. It is null when
  absent (a REST `/invoke-action` call or a job).

RC1-min carries the id on the `remote:` route and on the existing
`ctx.call` hop. C's counters depend on that.

## 7. Files

- New `lib/remote/`:
  - `declaration.js`: parse and validate section 1, and
    `resolveCredential`;
  - `client.js`: one SDK `Client` with `StreamableHTTPClientTransport` per
    loaded module's remote, and the listing;
  - `index.js`: the registry keyed by module, and `callRemote(module,
    name, tool, args, meta)`.
- `lib/handler-ctx.js`: the `remote:` route.
- `lib/worker-message.js` and the parent's message switch in
  `lib/module-manager.js`: one message type and its handler. Both are
  shared files, so the change is kept to the one message, and C is told.
- `lib/error-catalogue.js`: the codes above.
- `lib/cli-options.js`: `--remoteCredentials`, `--remoteTimeout`,
  `--remoteMaxBytes`.
- The permission report (`sends <ENV> to <origin>`, the tools/list hash).
- Docs:
  - `docs/security-model.md`: the credential path; the threat (a module
    cannot choose where a credential goes) and the allowance that answers
    it; what a remote can reach;
  - `docs/composite-tools.md`: the `remote:` address and the call-id rule;
  - the CLI reference;
  - CHANGELOG.

## Security

- A module cannot choose where a credential goes: the credential is read
  by the main thread only, after the operator's allowance check in section
  3. It is held in the client's request headers, and it
  never goes into a worker message, the worker's environment, a log line,
  an error message, a usage record or a result. A test dumps all of these
  for a call that used a known token and finds no trace of it.
- `COUNTINGHOUSE_*` variables are already never handed to a worker (R2-1).
  A remote's credential variable may still be one of them, because only
  the main thread reads it.
- The connection is the main thread's, so the module's `net` permissions
  and the worker lockdown do not apply to it. The declaration's `url` is
  what limits it:
  - https only;
  - redirects refused;
  - outside `--debug`, a URL at the configured Redis endpoint or at a
    loopback or private address is refused at load
    (`REMOTE_DECLARATION_INVALID`), so a declaration cannot point the main
    thread at its own Redis or the operator's internal network. This is a
    check on the URL's literal host, the same spelling-based kind as L1's
    in-worker Redis denial. A name that resolves to a private address is
    caught by the client's lookup when the plan's step lands: the client's
    own fetch connects through an agent whose `lookup` refuses a loopback,
    private or Redis-endpoint address before the socket opens.
- Billing identity: the worker states it, as the existing `ctx.call` path
  does today. R2-1's per-call token (Tasks 3–5) closes that for both paths
  together.
- A result is passed to the module as received. It is the remote's data,
  and the module treats it as untrusted input, as it would any answer.

## Tests (the plan writes them; the spec names what must hold)

- Declaration: each refusal in section 1 refuses the load with its
  position; the first pack's declaration is accepted as written.
- Credential:
  - used only when allowed for the exact origin (another port, or `http:`
    for an `https:` allowance, is not allowed);
  - `fallbackEnv` read when `env` is empty;
  - not allowed → the remote disabled, one load line, and
    `REMOTE_CREDENTIAL_NOT_ALLOWED`; the variable's value appears nowhere
    (logs, worker messages, results, usage records);
  - a malformed `--remoteCredentials` file stops the start.
- A local streamable-HTTP MCP test server (the SDK's server, on a fixed
  test port, `--debug` loopback) that records the headers it receives and
  serves a text tool, an `isError` tool, a structured tool, and a large
  tool:
  - the headers arrive as declared, with the credential;
  - each result arrives unchanged in the module;
  - `isError` resolves rather than rejects;
  - the large tool gives `REMOTE_RESULT_TOO_LARGE`.
- Failures: server down, `REMOTE_UNREACHABLE`; a 401, `REMOTE_AUTH_FAILED`;
  a slow tool, `REMOTE_TIMEOUT`; a garbage body, `REMOTE_PROTOCOL`; a
  redirect, `REMOTE_UNREACHABLE`, with the redirect target receiving
  nothing.
- tools/list:
  - the hash is in the load log and the permission report;
  - a tool missing from the list is called all the same;
  - a listing that failed at load is tried once at the first call, and
    the call proceeds whatever it gives;
  - pagination is followed.
- Call id: one `tools/call` through a composite, a part and its remote
  gives `In` records that all carry the same id.
- Worker mode and single-thread mode give the same results; a module
  cannot reach another module's remote by naming it.
- Metering: one `recordCall` per call, with the outer caller's billing
  identity; `HOP_IDENTITY_UNRESOLVED` without one.
- Counting: `recordIn` gets the documented fields and no content.

## Left to the builder

- Whether the client connects at load or at first call after the listing
  (the listing connects anyway).
- The SDK client's name and version strings in `initialize`.
- Where in `lib/remote/` the size cut-off lives (a wrapped `fetch` is the
  obvious place).

## Decided in brainstorm round 1 (reviewer, 2026-11-11)

1. The operator's allowance by origin (section 3), required.
2. The protocol version: negotiate what the pinned SDK speaks (1.32.2,
   up to 2025-11-25); an SDK upgrade is not a precondition. The packs
   spec's 2026-07-28 is countinghouse's own server's version, not a
   requirement on remotes. If GitHub's server needs a newer version, the
   SDK is upgraded in its own PR when the first live call shows it.
3. Accepted as proposed:
   - the transport's own headers are refused in `headers`;
   - `--remoteMaxBytes` (16 MiB, streamed);
   - redirects are refused;
   - private, loopback and Redis URLs are refused outside `--debug`;
   - `grant` is refused until the grant step.
   Added: tools/list is recorded and refuses nothing in RC1-min.
4. The call id's propagation rule (section 6).
