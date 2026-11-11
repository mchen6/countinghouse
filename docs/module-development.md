# Module development

A device module is an npm package that countinghouse loads and exposes as one
or more MCP tools. This document is the full reference; [`README.md`](../README.md#writing-one)
has the short version.

## Directory layout

```
my-module/
├── package.json   # name and version
├── api.json       # device/service/action metadata -- the single declaration
├── schema.json    # JSON Schema 2020-12 input/output/fault per action
└── handlers/
    └── <serviceShortName>/
        └── <actionName>.js     # one handler per action
```

That is the whole module. There is no `index.js` and no `device.js`: since
6.0.0 the framework assembles the device from `api.json`, reads `schema.json`
itself, and matches handlers by name. See
[`design-decisions.md`](design-decisions.md#module-shape-600-handlers-by-default-discovery-when-you-need-it)
for why the old boilerplate went away.

A handler is a function of `(input, ctx)`:

```js
// handlers/greetService/hello.js
module.exports = async (input, ctx) => ({
  output: {text: `hello ${input.name}`}
});
```

`input` is the validated input object. `ctx` carries the caller, this device's
identity, and the helpers a handler needs — see [`ctx`](#ctx) below.

If you would rather keep everything in one file, export the same thing as a
map from `device.js` instead of using the `handlers/` tree:

```js
// device.js -- an alternative to handlers/, not an addition
module.exports = {
  greetService: {                                    // service SHORT name
    hello: async (input, ctx) => ({output: {text: `hello ${input.name}`}})
  }
};
```

Top-level keys are service **short** names — the part after `:serviceID:` in
the URN. `api.json` remains the only place the full URN appears.

**Mismatches are startup errors, not silent omissions.** An action declared in
`api.json` with no handler, a handler `api.json` does not declare, a service
short name that does not resolve, or one that two URNs both claim: each fails
the module at load with a message naming the module, the stage, the offending
name and the fix. A module never half-loads.

## `ctx`

| field | what it is |
| --- | --- |
| `ctx.caller` | `{apiKey, userName, isAdmin}` — the authenticated caller |
| `ctx.device` | `{deviceID, friendlyName}` — this device |
| `ctx.serviceID`, `ctx.actionName` | the action being served |
| `ctx.log(entry)` | device log, already bound to this device |
| `ctx.serviceClient(opts, cb)` | call another module by deviceID — see below |
| `ctx.call(address, input, opts)` | call another module by name — see below |
| `ctx.job` | `{id, progress(n), info(cb)}` inside a task, otherwise `null` |
| `ctx.redis` | the shared Redis client |
| `ctx.recordUsage(tool, cost, cb)` | app-layer bookkeeping; never touches balance |
| `ctx.httpHeaders` | request headers, when the call arrived over HTTP |

`ctx` replaces the device instance that used to be bound as `this`. That is a
narrowing on purpose: handlers used to be able to reach `setAction`,
`deviceControl` and the rest of the framework's own surface. They no longer
can.

## Failing a call

Return `ctx.error(code, message?, details?)`:

```js
module.exports = async (input, ctx) => {
  if (typeof input.text !== 'string') return ctx.error('INPUT_REJECTED', 'text must be a string');
  return {output: {text: input.text.toUpperCase()}};
};
```

The code is your module's own: an `UPPER_SNAKE_CASE` name for what went
wrong (`INPUT_REJECTED` for input your schema can't rule out,
`REPO_TOO_LARGE`, …). The runtime's codes (its error catalogue) are the
runtime's, and a module never raises them. The caller gets your code and
the message `CODE: message`, in worker and single-thread mode alike. So
does a module that calls yours with `ctx.call`: it gets your error whole
(code, message and details), in either mode.

Returning the error is the preferred form. Throwing it
(`throw ctx.error(…)`), from an async function or a plain one, or passing it
to a callback gives the same answer. A helper that has no `ctx` can throw a
plain `Error` that carries your code instead:
`Object.assign(new Error('path must be a string'), {code: 'INPUT_REJECTED'})`.
Its code counts as yours when it looks like one (`/^[A-Z][A-Z0-9_]{2,}$/`)
and is not a system error's (one with `errno` or `syscall`, such as
`ENOENT`) or someone else's: Node's own (`ERR_…`, `MODULE_NOT_FOUND`,
`ABORT_ERR`, and the HTTP parser's `HPE_…`), any errno name even without
`errno` (`ECONNRESET`, `ETIMEDOUT`, …, as a network failure carries),
undici's (`UND_ERR_…`, from `fetch`), and the certificate-verification codes
Node gives a TLS error (`CERT_HAS_EXPIRED`, `INVALID_CA`,
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, …: an exact list of 28, in
`lib/countinghouse-error.js`, so your own `UNABLE_TO_PARSE` is still yours).
Those are crashes,
answered as `DEVICE_INVOKE_EXCEPTION` with the original in the fault, so an
operator can tell a failure you didn't handle from one you meant. To raise
such a code on purpose, use `ctx.error`. Only an `Error` counts: a thrown
plain object (even one with a `code`), `null`, or a rejection with nothing
is a crash too.

Catch your dependencies' errors and wrap them with `ctx.error`. A
dependency's own coded `Error` that you let escape (`SQLITE_BUSY`,
`ER_DUP_ENTRY`) looks like a module code, so it is answered as yours, with
its code; `countinghouse-validate` can't warn about it, since it sees your
source, not the codes your dependencies throw.

To wrap an underlying error, pass it as `details.cause`:
`ctx.error('INNER_CALL_FAILED', `${label}: ${e.message}`, {cause: e})`. The
cause stays on the error and is never sent to the caller. A runtime error you
rethrow unchanged (from `ctx.call`, say) keeps its own code.

Anything else you throw becomes `DEVICE_INVOKE_EXCEPTION` (the runtime reads a
bare `throw` as "this handler crashed"), and an untyped `callback(err)`
becomes `DEVICE_INVOKE_FAIL`. See
[`design-decisions.md`](design-decisions.md#handler-failure-is-classified-by-the-error-not-by-how-it-arrived).
The pre-8.0 error globals are gone
([upgrading-to-8.md](upgrading-to-8.md)).

## Dynamic discovery: when one module has many devices

Everything above describes a module that is one device, described statically.
If your module decides at runtime how many devices to expose — one per
configured database connection, say — or needs to withdraw one when its
backing resource disappears, export a class or EventEmitter instead of a
handler map and the 5.x discovery path applies unchanged:

```js
// index.js -- still supported, and still the right answer for this case
function DeviceModule() {
  this.on('discover',     this.discoverDevices.bind(this));
  this.on('stopdiscover', this.stopDiscoverDevices.bind(this));
}
util.inherits(DeviceModule, events.EventEmitter);

DeviceModule.prototype.discoverDevices = function() {
  for (const conn of readConfig()) this.emit('deviceonline', new Device(conn), this);
};
```

`discover`, `deviceonline` and `deviceoffline` behave exactly as they did.
Note that `deviceoffline` marks a device offline rather than unlisting it: it
stays in `tools/list` and fails at call time with `DEVICE_OFFLINE`.

The framework chooses between the two shapes by what your module exports — a
plain object is a handler map, anything else takes the discovery path.

## `api.json`

Declares one `friendlyName` and one or more services (each keyed by a
`urn:...:serviceID:...`). Each service has an `actionList` **array**, and each
action carries its own `name`, a human-readable `description` (**required**;
it is what an LLM sees as the MCP tool's description, and an action without
one is skipped), and up to three schema pointers into `schema.json`:

```json
"serviceList": {
  "urn:example-com:serviceID:echoService": {
    "actionList": [
      {
        "name": "echo",
        "description": "Echoes the input object back, unmodified.",
        "input":  {"schema": "/echoService/echo/input"},
        "output": {"schema": "/echoService/echo/output"},
        "fault":  {"schema": "/fault/echoService/echo/fault"}
      }
    ]
  }
}
```

`input`, `output` and `fault` are each optional; an action that declares no
`input` takes none, and one that declares no `output` is not validated on the
way back. Action names must be unique within a service.

The spec is validated against the framework's own JSON Schema 2020-12
meta-schema at load time. Required fields it is easy to forget:
`device.modelDescription`, and each action's `name`. Anything the meta-schema
does not know at the top level, in `serviceList` or in an action is
**rejected**, not ignored — so a stale field left over from an older format
shows up as a load error rather than silently doing nothing. Directly under
`device`, unknown fields are accepted; the retired CDIF-era `rateLimit` and
`price` are among them, and `countinghouse-validate` warns about each.

Specs written for 4.x (`argumentList` + `serviceStateTable`) do not load. The
error says so and names the converter:
`npx countinghouse-migrate-spec ./my-module`. See
[`MIGRATION.md`](../MIGRATION.md).

## `schema.json`

Supplies the JSON Schema 2020-12 documents the action's `input`/`output`/`fault`
pointers resolve to. This is what becomes each MCP tool's
`inputSchema`/`outputSchema`.

## Loading your module

At startup:

```sh
node ./framework.js --workerThread --loadModule ./path/to/my-module
```

Into a running server (requires an **admin** apiKey — see
[`authentication.md`](authentication.md#admin-keys)):

```sh
curl -X POST http://127.0.0.1:9527/load-module \
  -H 'Content-Type: application/json' -H 'X-CH-Key: <your-admin-key>' \
  -d '{"path":"./path/to/my-module","name":"my-module","version":"1.0.0"}'
```

You do **not** need `--debug` for either. `--debug` disables authentication
for the whole server; it is not how you get access to an endpoint.

## Files and paths

Since 8.0.0 a module in worker mode (the default) sees its own file
namespace, the same in every `--moduleSandbox` mode:

| Path your code uses | What it is | Access |
|---|---|---|
| `/app` | your module's install directory | read-only under `enforce`; writes are logged under `audit` |
| `/data` | your module's private data directory | read-write, counted against your disk limits, kept across restarts |
| `/tmp` | your module's private temp directory | read-write, counted against your disk limits, **emptied every time your worker starts** |
| each path you declared in `fs` | the same path on the host | `r` or `rw`, as the operator approved |

`__dirname` and `__filename` are under `/app` (`/app/handlers/...`),
`process.cwd()` is `/app`, and `os.tmpdir()` is `/tmp`. Paths in results and
errors are virtual too. Use `require` and relative paths as usual; build file
paths from `__dirname` (or `import.meta.dirname`) rather than from a host path
you know.

**Write under `/data` or `/tmp`.** Writing next to your code under `/app` is
refused under `enforce` (`EROFS`). `/data` is for what must survive a
restart; `/tmp` starts empty each time. On the host they are
`<moduleDataPath>/<your package name>/data` and `.../tmp`; the operator sets
`--moduleDataPath` (default `$HOME/.countinghouse/module_data`). Unloading,
restarting and reloading never delete them; an operator's
`POST /uninstall-module` does, unless told to keep them.

**Anything else, declare.** A path outside your namespace is answered
`ENOENT` under `enforce` (and logged on the host); under `audit` and `off` it
reaches the host and is logged. Declare each outside path in `fs` (see
[Declaring permissions](#declaring-permissions)) and the operator approves
it.

**Disk limits.** `/data` and `/tmp` together count against `diskMb` (default
ceiling 1024) and `diskEntries` (files and directories, default ceiling
100 000). Over either, a write fails with `ENOSPC` under `enforce`; under
`audit` crossing a threshold is logged. Declared paths are not counted.
Start-up time grows with the number of entries in `/data` and `/tmp`: your
worker's start walks them, about 70-145 µs per entry on the maintainer's VM
(715 ms for 10 000 entries at `dab69d0`, 1.1-1.5 s at `cd411ee` on a slower
disk; so 7-15 s near the 100 000 default). The walk is asynchronous and does
not block the server.

**Links.** In every mode a hard link works only within one writable root, and
a symbolic link only with a relative target that stays inside its root
(absolute targets are `EPERM`). `chmod` drops setuid, setgid and sticky bits.
A `rename` across roots (`/tmp` to `/data`, say) answers `EXDEV`, so copy
fallbacks such as `fs-extra`'s `move` work.

**What works differently.**

- Every `fs` call is a message to the main thread, synchronous calls
  included. Fewer, larger operations cost less: `readFile`, `writeFile` and
  `appendFile` are one call each. On a 2-CPU machine, 250 rounds of a 4 KB
  write, read, stat and unlink took about 1.2 s under `off` and 1.9 s under
  `enforce`, against about 30 ms with no broker (measured at `9246db1`; see
  [the benchmarks](benchmarks/sandbox-part2.md)).
- Descriptors your code gets from `fs.open` are numbers from `0x10000000`
  up, not small integers. `fs.writeSync(1, ...)` and `fs.writeSync(2, ...)`
  still go to your module's console (`pino` and `sonic-boom` work).
- `fs.watch`, `fs.watchFile` and `fs.promises.watch` are not available
  (`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`).
- HTTP/2 `respondWithFile` is not available: read the file with `fs` and
  stream it.
- A worker's `process.env` holds only the variables you declared (see
  below), so code that read undeclared variables sees them missing.

**Single-thread mode** (`--no-workerThread`) is for debugging modules and
has no sandbox. Modules still see `/app`, `/data` and `/tmp` through `fs`,
`fs/promises`, `os` and `CHUtil.loadFile`, but only as a translation, with no
checks, quota or link rules. The differences from worker mode:

- `process.cwd()` is the server's real working directory.
- Stack frames, `module.filename`, `require.cache` keys and `require.resolve`
  results are host paths, and so is `import.meta.dirname` in ES modules.
- Paths given to anything other than `fs`, `fs/promises`, `os` and
  `CHUtil.loadFile` are not translated.
- `createRequire` with a virtual (`/app`) path fails with `MODULE_NOT_FOUND`;
  use `require`, or `createRequire(import.meta.url)` in ES modules.
- A module can require countinghouse's own dependencies through `NODE_PATH`.

Upgrading a module or a deployment from 7.x: see
[`upgrading-to-8.md`](upgrading-to-8.md).

## Declaring permissions

Under `--workerThread`, each module runs inside the module sandbox
([`security-model.md`](security-model.md) says what that does and does not
guarantee). A module that stays inside its own directory needs to declare
nothing. One that needs more declares it in `package.json`, beside
`countinghouse.calls`:

```json
"countinghouse": {
  "calls": ["…"],
  "permissions": {
    "fs":     [ { "path": "/var/log/app", "access": "r" } ],
    "net":    [ { "host": "api.example.com", "ports": [443] } ],
    "env":    [ "WEATHER_API_KEY" ],
    "limits": { "heapMb": 128, "externalMb": 128, "maxBlockMs": 5000, "diskMb": 200 }
  }
}
```

| Field | Rules |
|---|---|
| `fs` | Paths outside the module only. Absolute, normalized, no `..`. `access` is `r` or `rw`. `/`, `/app`, `/data`, `/tmp` and anything under them are reserved and cannot be declared. |
| `net` | `host` is a hostname or a `*.`-prefixed wildcard (one leading label only); `ports` is optional, integers 1-65535. |
| `env` | Environment variable names (`[A-Z_][A-Z0-9_]*`). |
| `limits` | What the module asks for; all optional: `heapMb` (JS heap), `externalMb` (Buffers and typed arrays), `maxBlockMs` (how long the event loop may be blocked), `diskMb` and `diskEntries` (`/data` and `/tmp` together). The operator's ceiling applies; the default ceilings are 256, 256, 10000, 1024 and 100000. |

A declaration is a request. The operator's `--modulePolicy` file can grant it
as declared or narrow it, never widen it. Under `--moduleSandbox enforce` a
module that declares `fs`, `net` or `env` gets none of them until the
operator adds an entry for it: no access outside its own directory, and no
environment variables at all. Under `audit` the declaration is granted.
`fs`, `env` and `limits` take effect now. `net` is validated and logged, and
takes effect when the network brokers ship, so declare it now and expect to
need it. Targets of `CHUtil.request` and `CHUtil.createSOAPClient` are already checked
against the effective `net` entries: under `audit` a disallowed target is
logged and the request still goes ahead; only `enforce` refuses it. Under
`enforce`, `CHUtil.request` also accepts only the ordinary request options (`method`,
`headers`, `body`, `json`, `qs`, `timeout`, ... but not `baseUrl`, `proxy`,
`agent`, `har` and similar) and checks every redirect.

**Self-contained.** Every dependency of your module, followed through the
whole tree, must be installed inside the module's own directory. Install
with `npm install --prefix <module>` (or run `npm install` inside it), and
ship that `node_modules`. A dependency that resolves outside the module is
a problem `countinghouse-validate` reports and `enforce` refuses to load.
Under `enforce` the module's worker can `require` built-ins and files under
its own directory, nothing else (not countinghouse's `lib/`, not global
folders, not other modules); under `audit` such a `require` works and is
logged.

**No native addons.** A `.node` file, a `binding.gyp`, or `"gypfile": true`
anywhere in the tree is refused under `enforce`, and loading native code at
run time throws under `enforce` (under `audit` it works and is logged). Use a pure-JavaScript replacement: `bcryptjs` is the usual
one for `bcrypt`. Dependencies with `preinstall`, `install` or `postinstall`
scripts are reported as warnings by `countinghouse-validate`.

**Environment variables.** The worker's `process.env` holds only the names
you declared in `env` and the operator approved. The value comes from the
operator's policy entry if it sets one, otherwise from the server's own
environment; a name with neither is absent. Read them with
`process.env.NAME` as usual.

**Blocked built-ins.** `child_process`, `cluster`, `worker_threads`,
`inspector` (and `inspector/promises`), `wasi`, `v8`, `repl`,
`trace_events`, `node:sqlite`, `node:test` and `node:sea`, and any built-in newer than Node 24.21 (Node 26's `node:ffi` among them), are
unavailable:
`require` of them fails with `MODULE_NOT_FOUND` under `enforce` (under
`audit` it works and is logged). `module` is reduced to `builtinModules`,
`isBuiltin` and a `createRequire` limited to your directory.
OpenSSL engines (`crypto.setEngine`, `privateKeyEngine`, `clientCertEngine`)
count as native code. `process.dlopen`, `process.binding`, `process.kill`, `process.abort`,
`process.chdir` and the `process.set*id` family throw under `enforce`; under
`audit` they work and are logged, so `process.kill` can still signal the
server. `process.exit` works in both and ends only your module. `net`,
`http` and similar still work in this release, and the first use of each is
logged; `fs` goes through the file broker ([Files and paths](#files-and-paths)).

**Limits, restart and suspend.** A module that exceeds its heap limit, its
external memory limit, or blocks its event loop longer than `maxBlockMs` is
terminated, as is one whose worker exits or errors (an uncaught exception
is caught and logged, and does not end the worker). Then:

- Calls in flight fail at once with **`MODULE_RESTARTING`** and the reason.
- The module is restarted after 1 s, then 2 s (the 3rd exit within 10
  minutes suspends it instead, see below). Calls
  meanwhile get `MODULE_RESTARTING` with the time of the next attempt. Your
  tools stay in `tools/list`; callers should retry after the time given.
- When the operator reloads your module (load it again,
  `POST /reload-module`, `POST /restart-module`), calls in flight fail at
  once with **`MODULE_RELOADING`**, and calls that arrive before its devices
  are back get it too; a queued or scheduled job waits for the new worker
  (up to 30 s) and runs on it. When it is unloaded, or its new code fails to
  load, calls in flight and after get **`MODULE_UNLOADED`**, and jobs for it
  fail without retrying. Operator actions on your module take effect in
  order, the latest winning: a reload superseded by a later load, reload
  or unload before its worker is up ends that worker, and the operator who
  asked for it gets **`MODULE_LOAD_SUPERSEDED`**; an unload arriving then
  leaves the module unloaded, and the jobs waiting for it fail
  `MODULE_UNLOADED` at once.
- After 3 exits in 10 minutes the module is suspended and calls get
  **`MODULE_SUSPENDED`** with the last reason, until an operator runs
  `POST /restart-module`. A restart that the sandbox refuses (because the
  module's `package.json` or the policy changed, under `enforce`) suspends
  it at once.

Your module also sends at most `--moduleMessageRate` messages per second
(default 2000) to the main thread, and Redis commands count; beyond that
calls fail with `RATE_LIMITED`. Cache what you can.

Check a module with `countinghouse-validate` before loading it: it reports
permission syntax, dependencies outside the module, native code and install
scripts.

## Calling other modules

### `ctx.call` — by name (the default)

```js
const data = await ctx.call('repo-scan/scanService.scan', input);
const {data, platformMetering} = await ctx.call('repo-scan/scanService.scan', input, {detail: true});
```

The address form is `<module>/<service>.<action>`:

- `<module>` — the target's `friendlyName` (its `api.json`'s
  `device.friendlyName`), not `package.json`'s `name`.
- `<service>` — the **service label**: the raw last segment of the service's
  URN (`urn:...:serviceID:scanService` → `scanService`), not a made-up short
  name.
- `<action>` — the action's `name`, exactly as declared in `api.json`.

Exactly one `/` and one `.` are allowed, and none of the three parts may
themselves contain either character — `repo-scan/scanService.scan` is valid,
`repo.scan/scanService.scan` is not. This is deliberately **not** the MCP tool
name (`repo_scan_scanservice_scan`): tool names are deduped with a `_2` suffix
on collision, in an order that depends on module load order, so a hardcoded
tool name cannot survive another module being loaded first.

**Declare what you call, in your own `package.json`** — not `api.json`, whose
format did not change:

```json
{
  "countinghouse": {
    "calls": [
      "repo-scan/scanService.scan",
      "secret-detect/detectService.detect"
    ]
  }
}
```

**Bind the identity your hops run as, in the auth config — not in the
module.** An operator lists this module's `friendlyName` in the
`runsModules` array of whichever auth identity should authorize its inner
hops:

```json
{
  "<a key that is not its user name>": {
    "userName": "repo-review-internal",
    "devices": ["<deviceID of repo-scan>", "<deviceID of secret-detect>"],
    "runsModules": ["repo-review"]
  }
}
```

Give the identity a key that differs from its `userName`: user names are shown
to callers (a composite's bill, `check_balance`), so a key that doubles as one
is handed to every caller. The file provider warns at startup when it sees
one.

That split is deliberate: which identity a module runs as is the operator's
decision, not the author's, so the same module can be deployed twice under
two different identities with two different grants. A handler never names
its own identity — it just calls `ctx.call`.

As with `ctx.serviceClient`, **authorization and billing are two different
identities**: the hop is authorized as the bound identity above, but billed
to `ctx.caller` — the real outer caller — so per-hop cost lands on whoever
actually called your tool, not on the module.

**Everything is verified at load time, not at first call.** For modules
present at startup, every address in `countinghouse.calls` is resolved
against the target's real spec, the identity is bound via `runsModules`, a
duplicate binding is refused, and the bound identity's grant to each target
is checked. A typo, a missing binding, or a missing grant fails the module
at startup with a message naming the module, the address, and the file to
fix — it does not wait until the first call to surface.

Load time is still where you want to find a broken chain, because only the
load-time error can name the module, the address and the file to fix. But a
runtime refusal is no longer anonymous: **each `ctx.call` guard rejects with
a typed code that reaches an MCP client intact.** A failed `tools/call`
comes back `isError: true` with `_meta["countinghouse/code"]` set to one of
(before 8.0.0 it was `structuredContent.code`; an error result now carries no
`structuredContent`, because MCP clients validate it against the tool's output
schema even on errors):

| `code` | what it means |
| --- | --- |
| `CTX_CALL_NOT_READY` | composition verification has not finished for this module yet — retry; this does *not* mean the config is wrong |
| `CTX_CALL_UNBOUND` | verification finished and bound nothing: the address is missing from `countinghouse.calls`, or no identity's `runsModules` lists this module (both are required) |
| `CTX_CALL_UNDECLARED` | an identity is bound, but this address is not in `countinghouse.calls` |
| `CTX_CALL_BAD_ADDRESS` | the address is not of the form `<module>/<service>.<action>` |
| `CTX_CALL_UNRESOLVED` | the address does not resolve against the target module's spec |

A callee that genuinely threw still reports `DEVICE_INVOKE_EXCEPTION` —
telling a misconfigured chain apart from a failing one is the whole point of
the codes. Because they come from the error catalogue (`lib/error-catalogue.js`), each code's
message text is actionable on its own.

What still does not cross the MCP boundary is a runtime error's per-call
**detail**. Under `--workerThread`, the main thread rebuilds a runtime error
from a worker's reply by its `code` alone
(`CountinghouseError.fromReply`), so a client sees the code's generic
message, not "… for address `x/y.z`". The full text survives in
single-thread mode and over REST `/devices/:id/invoke-action`. A module's own
error (`ctx.error`) is different: every reply between threads carries it
whole, so its code and message reach the client in either mode, and a
composing module's `ctx.call` gets its details too. The callee's structured `.fault`
reaches neither.

**A short startup window remains, but it now says so.** A device appears in
`tools/list` and can serve its own actions before composition verification
has finished — that verification is asynchronous and runs after all modules
are discovered. A call landing in that window is refused with
`CTX_CALL_NOT_READY`, whose message says to retry, rather than being blamed
on an auth config that is in fact correct. Treat that code as retryable and
every other `CTX_CALL_*` code as a configuration bug.
`examples/repo-review/token-comparison.js` waits for the server's "all
module discovered" log line plus a settle buffer to stay out of the window
entirely — see its comment on `waitForAllModulesDiscovered` for the full
timeline.

Composition verification also runs for modules loaded at runtime, including
into an instance started with no `--loadModule` flags at all — the
`--authoringTools` setup recommended above. A bare instance completes
discovery vacuously at startup, and each later `countinghouse_load_module`
re-runs verification for what was just loaded, so a module authored and
loaded entirely at runtime can `ctx.call` normally.

This was not always true: `allmodulediscovered` used to be gated on a
startup module count that a bare instance never reached, so verification
never ran there and every `ctx.call` was refused against a perfectly correct
auth config. `test/composition/08-bare-server-discovery.js` guards both
halves — that a bare instance reaches discovery completion, and that a
composing module loaded into one at runtime can actually call through.

### `ctx.serviceClient` — the escape hatch

`ctx.call` intentionally does not cover every case. Use `ctx.serviceClient`
directly when you need:

- **A per-call identity override** — `ctx.call` always authorizes as the one
  identity bound to this module via `runsModules`; `ctx.serviceClient` lets
  you pick `as` per call.
- **A module needing two identities** — `ctx.call`'s load-time verification
  binds exactly one identity per module (a second `runsModules` claim on the
  same `friendlyName` is refused as a conflict); a module that legitimately
  needs to act as two different identities for different targets still
  needs `ctx.serviceClient`.

```js
ctx.serviceClient({deviceID, serviceID, as: 'my-module-internal'}, (err, client) => {
  client.invoke({actionName: 'echo', input: {...}}, (err, data, platformMetering) => { ... });
});
```

`as` is the identity the inner hop is **authorized** as — your module's own,
which must be granted access to the target device or every inner call fails.
The hop is **billed** to `ctx.caller`, same as `ctx.call`, so per-hop cost
lands on whoever called your tool rather than on your module. Unlike
`ctx.call`, the target here is addressed by `deviceID`, computed offline or
looked up yourself — there is no name resolution.

`pre-installed-packages/composite-demo` stays on `ctx.serviceClient`
deliberately, so both paths keep a live example and test coverage; see
[`composite-tools.md`](composite-tools.md#every-composing-module-needs-its-internal-identity-granted).

## Troubleshooting: my module doesn't appear in `tools/list`

Work down this list in order. Every case below now logs an explicit error —
**check the server log first**, it very likely already names the cause.

### 1. The log says `MODULE_NOT_DISCOVERABLE`

```
Device module is not discoverable: my-module its main entry point registers no
"discover" listener, so it can never emit "deviceonline" ...
```

This applies to the dynamic-discovery shape only. Your `package.json`'s `main`
points at the device instead of the module that announces it. A handler-map
module cannot hit this — the framework supplies the discovery shim itself.
This is the most common failure by a wide margin: the module loads without
error, reports success, and then nothing else ever happens, because nothing is
listening for the `discover` request.

### 2. The log says `DEVICE_SPEC_VALIDATION_FAIL`

```
Device spec validation failed: my-module stage=validateDeviceSpec -- 2 schema error(s):
  /device must have required property 'modelDescription' | /device/serviceList/urn:.../actionList/0 must have required property 'name'
```

Your `api.json` doesn't satisfy the meta-schema. Each error gives the JSON
pointer (`instancePath`) into your spec and what is wrong there, and **all**
errors are reported, so you can fix the spec in one pass. Common causes:
missing `device.modelDescription`, an action without a `name`, an
`actionList` that is still an object rather than an array.

### 3. The log says `MODULE_NO_DEVICE_ONLINE`

The device object failed its interface check — usually it isn't a `CHDevice`
(check that `device.js` calls `CHDevice.call(this, spec)` and
`CHUtil.inherits(Device, CHDevice)`), or an earlier error on the device was
recorded and the message will quote it.

### 4. The log says `LOAD_MODULE_FAIL`

Your module threw while being constructed — a syntax error, a missing
`require`, a bad path in `CHUtil.loadFile`. The stack is in the log.

### 5. No error at all, and the module is listed as loaded

Then the device did come online, and the problem is downstream:

- **An action is missing from `tools/list` while others from the same module
  appear** → that action has no `description` in `api.json`. Actions without
  one are skipped deliberately (`description` is what an LLM reads), and this
  is logged at info level: `action ... has no description, skipping`.
- **The whole module's tools are missing for one apiKey but present for
  another** → `tools/list` is filtered per apiKey. That key isn't granted the
  device. See [`authentication.md`](authentication.md).
- **Nothing is missing, but the schemas look empty** (`{"type":"object",
  "properties":{}}`) → the schema fetch failed and fell back to a permissive
  default. Server-side validation still enforces the real schema, so calls
  with wrong arguments are still rejected; but the LLM is flying blind. Check
  that `schema.json` resolves and each action's `input`/`output`/`fault`
  pointers are right.

### Verifying a module without starting a server

```sh
npx countinghouse-validate ./my-module
```

Checks `api.json`, `schema.json` and the handler map against each other and
prints every problem it finds, each naming the stage and the way out. Exit
codes: `0` clean, `1` problems found, `2` the path could not be read. No
Redis and no server required.

`--verifyModule` remains available for checking a module in the context of a
running framework: it makes the framework continue past validation failures
and report everything it finds, rather than stopping at the first one.

```sh
node ./framework.js --verifyModule --loadModule ./path/to/my-module
```

### Letting an agent write the module

Full reference for the authoring toolchain — the four tools, the loop, the
security boundary and its known limits — is in
[`module-authoring.md`](module-authoring.md).

Start the runtime with `--authoringTools` and an admin key, and a coding
agent can validate a design, write the module, validate it, load it and call
it without a human editing JSON. The four tools are
`countinghouse_validate_plan`, `countinghouse_validate_module`,
`countinghouse_load_module` and `countinghouse_call_tool`; they are admin-only
and absent from `tools/list` unless the flag is set. Keep the default worker
mode: `countinghouse_load_module` runs a module's main entry in the runtime,
and worker mode is what turns a crash or `process.exit()` there into a
reported failure. Under `--no-workerThread` the same crash takes the whole
server down.

The repo ships the skill that drives them at
`.claude/skills/countinghouse-module/SKILL.md`.

## The callback form (deprecated, removed in 7.0.0)

Before 6.0.0 a handler took a Node-style callback. That form still works, and
every 5.x handler keeps running unchanged:

```js
module.exports = (input, ctx, callback) => callback(null, {output: {...}});
```

**It is deprecated and will be removed in 7.0.0.** Write new handlers as
`async (input, ctx)`; the migrator converts old ones for you
(`npx countinghouse-migrate-module ./my-module`).

Which form you are using is decided by what the handler *returns* — a thenable
is awaited, anything else waits for the callback — so both can coexist in one
module while you migrate.

One difference worth knowing while both forms are in play: an *untyped* error
resolves differently by route. `callback(new Error('boom'))` becomes
`DEVICE_INVOKE_FAIL` ("I am reporting a failure"), while `throw new
Error('boom')` becomes `DEVICE_INVOKE_EXCEPTION` ("I crashed"). A module's
own error (`ctx.error`) keeps its code either way, which is the reason to use
one.
