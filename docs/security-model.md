# Security model

This document describes the isolation and trust model countinghouse actually
implements today — not the isolation model a multi-tenant runtime would
ideally have. Where the two diverge, we say so plainly. An overstated
isolation claim is a worse security posture than an honestly-scoped one:
it invites integrations that assume guarantees the runtime doesn't provide.

## Threat model

countinghouse runs third-party npm packages ("device modules") as tools
callable by MCP clients and agents. The runtime treats these modules as
**semi-trusted, not sandboxed-for-arbitrary-code**: each module executes
with the privileges of the Node.js process's OS user, narrowed by an
in-process sandbox that is a strong barrier, not a hard boundary (see
below). With `--moduleSandbox off` there is no narrowing at all. There is no
attempt to run modules from parties the platform operator hasn't reviewed.

Each module runs inside its own `worker_threads.Worker` (`lib/sandbox.js`,
spawned from `lib/module-manager.js`'s `loadModuleByWorker`). This gives:

- **An independent V8 heap and execution context.** A module's global
  variables, prototypes, and in-memory state are isolated from the main
  thread and from other modules' workers. A crash or infinite loop inside
  one module's worker does not directly corrupt another worker's heap.
- **A message-passing boundary.** Modules only reach the rest of the
  platform (device state, other devices, Redis, job control) through the
  `WorkerMessage` protocol (`lib/worker-message.js`) — structured
  `postMessage` calls with a fixed set of commands, not shared memory or
  arbitrary main-thread object references.
- **Crash containment at the worker level.** `module-manager.js` listens for
  `worker.on('error', ...)` and `worker.on('exit', ...)` and unloads the
  corresponding module rather than letting a worker's end take down the
  whole process. Under `--moduleSandbox audit` and `enforce` the module is
  then restarted with backoff, or suspended after repeated exits; with
  `off` it stays down.

### What the module sandbox adds, and what it does not stop

Since the module sandbox (part 1 of 4, design in
[`superpowers/specs/2026-10-15-module-sandbox-foundation-design.md`](superpowers/specs/2026-10-15-module-sandbox-foundation-design.md))
there are layers on top of the worker boundary. They are enforced **inside
the same process as the code they restrict**:

> It is a strong barrier against accidents, buggy or exploited
> dependencies, and ordinary malware. It is not a hard boundary against code
> written specifically to defeat it.

One overlooked internal API, or one V8 bug, gets past the in-process layers.
Each layer below says what it stops and what it does not.

**Modes.** `--moduleSandbox off|audit|enforce` (default `audit` under
`--workerThread`; `off` without it, since the sandbox needs worker mode).
`off` is today's behaviour. In `audit` every check runs, a violation is
logged once per (module, rule, target) and the operation goes ahead. In
`enforce` a violation is blocked with the error Node itself would throw
(`ERR_ACCESS_DENIED`, `MODULE_NOT_FOUND`) and logged. Resource limits apply
in `audit` as well, because logging a runaway allocation does not stop it.

**1. Worker lockdown** (`lib/module-lockdown.js`, run once per worker before
any module code). Stops:

- native code: `process.dlopen`, the `.node` loader, `process.binding`,
  `process._linkedBinding`;
- process controls: `process.kill`, `abort`, `chdir`, `setuid`/`setgid` and
  the like (`process.exit` stays; it ends only that module's worker);
- `require` of anything but built-ins and files inside the module's own
  directory (`MODULE_NOT_FOUND` otherwise);
- the built-ins `child_process`, `cluster`, `worker_threads`, `inspector`,
  `wasi` and `v8`; `module` is replaced by a reduced version
  (`builtinModules`, `isBuiltin`, a `createRequire` that stays inside the
  module's directory); `module.registerHooks`/`register` are locked so no
  later hook can run ahead of the boundary;
- `CHUtil.loadFile` outside the module's own directory.

Each override is non-writable and non-configurable. `fs`, `net`, `http` and
the like stay usable until parts 2 and 3; the first `require` of each is
logged (as "uses") in both modes so operators learn which modules will need
permissions.

**2. Declared permissions and the operator policy.** A module declares
`countinghouse.permissions` (`fs`, `net`, `env`, `limits`) in its
`package.json`; the operator's `--modulePolicy` file can only narrow that,
never widen it (a wider entry is reported and ignored). **In part 1 only
`env` and `limits` have an effect on a module's own code**, plus the host
check on `CHUtil.request` and `CHUtil.createSOAPClient` described below. `fs`
and the rest of `net` are parsed, validated and logged as effective
permissions, and take effect when parts 2 (file broker) and 3 (HTTP broker)
ship. Until then a module can still `require('fs')` and read what the
process user can read.

**3. Load-time checks and the validator** (`lib/module-tree-check.js`,
`countinghouse-validate`). A module must be self-contained (every dependency,
through the whole tree, resolves inside the module's directory), must not
contain native code (`.node`, `binding.gyp`, `"gypfile": true`), and must
have valid permissions; install scripts are warned about. In `enforce` a
failing module is refused with `MODULE_SANDBOX_REFUSED`; in `audit` the
failures are logged and the module loads. This is a structural check of
what is on disk at load time, not a review of what the code does.

**4. Resource limits, restart and suspend.** `heapMb` (V8
`resourceLimits`), `externalMb` (the main thread polls the worker's
external memory every second and terminates it over the limit) and
`maxBlockMs` (the main thread pings the worker every second and terminates it
if there is no reply for that long), each with a 256 / 256 / 10000 default
ceiling. A worker-to-main message rate limit (`--moduleMessageRate`, default
2000/s) answers excess messages with `RATE_LIMITED` instead of killing the
worker. A worker that ends unexpectedly is restarted with backoff (1 s,
doubling, capped at 60 s) and suspended after 3 exits in 10 minutes; calls get
`MODULE_RESTARTING` or `MODULE_SUSPENDED` while the tools stay listed. This
bounds memory, blocking and crash loops. It does not bound CPU use that
yields to the event loop, disk, or network traffic.

**5. `--hardened`.** Re-launches the server under Node's permission model
(`--permission`) with read access to the install directory, `--modulePath`
and the configured config files, and write access to `--modulePath` (and the
SQLite auth directory). This applies to the whole process, **main thread
included**, so it limits what any module can reach on the host (for example
`/proc/self/environ` and `/proc/self/mem`) but cannot separate a module from
countinghouse's own data in the directories it may read. Every module must
live under `--modulePath`. Node 24 has no network permission, so outbound
network is left to the OS; a systemd unit example is in
[the example below](#hardening-with-systemd).

### What this explicitly does NOT provide (accepted gaps and limits)

The following are known, accepted in part 1, and not hidden by the layers
above.

- **Module code can borrow countinghouse's already-loaded modules.**
  Through `require.cache`, `module.constructor.createRequire`, or a
  `vm.Script` given a countinghouse filename together with dynamic
  `import()`, module code can obtain modules countinghouse loaded before the
  lockdown, and through them reach files outside the module's root. The
  `require` boundary stops the ordinary routes, not these. Part 2's
  virtualization of `require` and the file system revisits it. Until then the
  `CHUtil` surface and everything else loaded before lockdown are part of the
  review checklist for every change to `lib/countinghouse-util.js`.
- **The `CHUtil.request` host check is not the network boundary.** The check
  on `CHUtil.request` (and `CHUtil.createSOAPClient`) governs only that
  convenience route. In part 1 a module can still use Node's `http` or `net`
  directly; that is only logged as "uses". Code running in the module's
  worker can also interfere with objects in that same worker, including the
  wrappers themselves. The network boundary is part 3's main-thread broker,
  not this check. Under `enforce`, `CHUtil.request` accepts only an allowlist
  of options and refuses `baseUrl`, `proxy`, `har` and the like, so that the
  host checked is the host contacted; redirects are checked hop by hop.
- **No file or network permission is enforced in part 1.** See layer 2.
  A module can read and write what the process user can, and open outbound
  connections with `net`/`http`/`https`/`fetch`, until parts 2 and 3.
- **The module worker's environment holds only approved variables.** That
  includes no `NODE_PATH`, so a module cannot reach countinghouse's `lib/` by
  bare name. This replaces the old situation where every secret in the
  server's environment was visible to every module; it is a property of how
  the worker is created, so it applies in `audit` as well as `enforce` and is
  absent only under `--moduleSandbox off`.
- **`--hardened` limits.** Node's permission model follows symlinks, so a
  symlink inside `--modulePath` that points elsewhere is readable, and write
  access covers all of `--modulePath` (including other modules' directories
  and the module registry database). `--allow-addons` is added for the SQLite
  auth provider, or whenever no `--loadModule` is given (the module registry
  database uses `sqlite3`); it puts native code in the **main thread**
  outside the permission model. `--allow-worker` is always added, and Node
  documents that as weakening the model. `--permission` needs Node >= 22.13
  or >= 23.5.
- **Resource limits can misfire.** A main thread stalled longer than
  `maxBlockMs` (a long synchronous task, or a paused VM) can make a healthy
  worker look blocked, and it is then terminated and restarted.
- **Uncaught exceptions in a worker do not end it.** `lib/sandbox.js` catches
  and logs them, as it always has. The restart policy applies to workers
  that actually end: `process.exit`, the heap limit, kills by the external
  memory or blocked-loop limits, and worker errors.
- **A restart refused under `enforce` suspends the module at once.** If
  `package.json` or the policy changed so that the module no longer passes
  (for example it gained a native dependency), the restart is refused with
  `MODULE_SANDBOX_REFUSED` and the module is suspended without retries. An
  operator `POST /restart-module` tries again.
- **No OS-level isolation.** `worker_threads` share the same process, same
  OS user and same network stack as the main thread. Outside `--hardened`
  nothing limits which files the process may open.
- **Native code in the main thread is outside all of this.** The lockdown
  stops module code from loading native addons; the server's own addons
  (`sqlite3`, when used) are not constrained.
- **Everything runs in the same process as the code it restricts.** A bug in V8, in Node's loader hooks, or
  an internal API this work overlooked gets past it. Operators who run code
  from parties they have not reviewed need a process, container or VM
  boundary on top (see the comparison below).
- **No code-signing or provenance check.** See `countinghouse_validate_module`
  below: "validate" means structural conformance, not authorship or
  integrity attestation.

## Current mitigations inventory

These are real, and worth being specific about rather than waving at
"we have security measures". The sandbox layers above come first in effect;
these are the checks that predate them and still apply:

- **Module structural verification** (`countinghouse_validate_module`, an
  MCP tool gated on `--authoringTools` plus an admin key,
  `lib/mcp/gateway.js`; the check itself runs via `bin/countinghouse-validate.js`
  in a disposable child process, `lib/module-validator.js`). Before a module
  is loaded, its `api.json`, `schema.json`, and handler map are extracted
  and cross-checked against each other and against the framework's own
  JSON Schema 2020-12 meta-schema (`lib/validator.js`, via `ajv`) for
  structural conformance — well-formed service/action lists, unique action
  names, resolvable schema pointers, handlers that actually exist for every
  declared action — and every problem found is reported, not just the
  first. **Doing this requires actually running the module's own code.**
  `loadExported` (`lib/module-validator.js:61`) calls `require()` on the
  module's main entry, and `resolveHandlerMap`
  (`lib/module-validator.js:180`) calls `require()` on every handler file —
  there is no way to resolve the handler map without loading the JS that
  defines it. That `require()` happens inside a disposable,
  timeout-bounded child process (`execFile` with `VALIDATE_CHILD_TIMEOUT_MS`,
  `lib/mcp/gateway.js`), not the long-lived gateway process, so a hang, a
  crash, or a `process.exit()` during that load only takes down the one-off
  child, not the server answering every other tenant's requests at the same
  time. The tool itself is gated behind `--authoringTools` plus an admin
  key, the same gate every other authoring tool uses. That exposure is also
  not new relative to what an admin can already do: `countinghouse_load_module`,
  reachable by the identical admin-gated population, `require()`s a module's
  code directly into the live gateway process with no child-process
  isolation at all — its own `LOAD_MODULE_TIMEOUT_MS` only bounds how long
  the tool call waits for a callback, it does not stop a synchronous hang
  inside that `require()` from blocking the process itself.
  `countinghouse_validate_module`'s child-process boundary is strictly
  safer than that, not a new hole opened next to an otherwise-clean tool.
  **None of this makes it a security scan, though.** It does not audit or
  review the module's code for malicious behavior, does not check its
  `node_modules` dependency tree for known vulnerabilities, and does not
  verify a signature or checksum against a trusted publisher. Running the
  code is a side effect of resolving the handler map, not a review of what
  that code does — a structurally valid `api.json` next to arbitrary,
  actively malicious JS passes this check exactly as cleanly as an honest
  module would. (This mechanism superseded the earlier HTTP-based
  module-verification route, removed in the marketplace-backend cleanup;
  see `docs/superpowers/specs/2026-09-04-marketplace-backend-design.md`.)
- **Schema validation at the invocation boundary**
  (`Service.prototype.validateActionCall`, `lib/service.js`, backed by
  `lib/validator.js`'s `ajv` 2020-12 compiler). Every `tools/call` /
  `invoke-action` request is validated against the action's declared
  `inputSchema` before the device module's handler runs, and the module's
  return value is validated against `outputSchema` before it's returned to
  the caller. This bounds the *shape* of data reaching a module's code and
  the *shape* of what a module can claim to return — it does not sandbox
  what the module's handler does internally with valid input.
- **Redis command allowlist** (`lib/supported-redis-commands.json`,
  enforced in `lib/redis-api.js` via `_.intersection(redisCommands.list,
  supportedCommands)`). Modules access Redis only through a wrapper that
  dynamically exposes exactly the commands on this list —
  `get`/`set`/`hget`/`hset`/`lpush`/`zadd`/`multi`/`exec` and similar data
  commands. Administrative and introspection commands that would let a
  module affect the whole Redis instance or other tenants' keyspaces —
  `flushall`, `flushdb`, `config`, `keys`, `client`, `monitor`, `shutdown`,
  and Lua execution via `eval`/`evalscript` — are absent from the list and
  therefore uncallable through this path. (A module could still reach Redis
  directly if it required the `redis` package itself and supplied its own
  connection details — this allowlist constrains the *platform-provided*
  Redis handle, not arbitrary module code.)
- **Per-apiKey device authorization** (`AuthProvider`, `lib/auth/` — see
  [`design-decisions.md`](design-decisions.md#authprovider-three-pluggable-backends-one-narrow-interface)
  for why it's split into three backends, and
  [`authentication.md`](authentication.md) for how to configure each one).
  Every entry path in `docs/cross-cutting-matrix.md`'s table
  that checks `userAuth` denies a caller that isn't explicitly granted
  the target `deviceID` (`USER_HAS_NO_DEVICE`), via one of three pluggable
  backends: `FileAuthProvider` (default, a JSON file), `SqliteAuthProvider`,
  or `CouchDBAuthProvider` (needs a real CouchDB instance, `nano` no
  longer a hard dependency). This is caller-identity authorization, not
  module sandboxing — it constrains which apiKey can invoke which device's
  actions, not what a loaded module's own code can do once its handler
  runs (that's the worker-thread boundary described above). Three things
  worth being explicit about, in the spirit of this document's own rule
  against overstating guarantees:
  - **Between modules, the check runs when a channel opens, not on every
    hop.** Since 7.1.0 a module calling another module's device does so over
    a direct peer channel by default. `userAuth` runs once, at brokering
    time; the channel it grants then reaches every device the callee worker
    hosts. A grant revoked while the server runs closes the channel on the
    broker's next re-check (`--peerChannelAuthRecheckSeconds`, 5 by
    default), so a revoked module identity can keep reaching a device for up
    to that long. `--no-directPeerChannels` restores the per-hop check on
    the main thread, with no such window.
    See [`direct-peer-channels.md`](direct-peer-channels.md) and D3 in
    [`design-decisions.md`](design-decisions.md#direct-peer-channels-five-decisions-d1d5).
  - **`FileAuthProvider`'s zero-config first run generates and prints a
    wildcard-access demo key** if no `auth.json` exists yet, specifically
    so a fresh checkout is immediately usable. This is meant for local
    development and evaluation, not left running in a real deployment —
    treat an auto-generated `demo-*` key the same as any other credential
    that shouldn't ship to production, and replace it (or configure a real
    `auth.json`/`COUNTINGHOUSE_API_KEY`) before exposing the server beyond
    localhost.
  - **An internal cross-worker call whose caller identity can't be
    resolved is metered for free rather than denied** (see
    `docs/cross-cutting-matrix.md`'s two "Direct peer channel" rows) — this
    is a `MeteringProvider`-side gap (billing, not authorization: the call
    itself still only succeeds if the resolvable identity, when there is
    one, is separately authorized), found and documented, not fixed, since
    the correct behavior (deny vs. bill a fallback identity vs. the
    current silent skip) is a real design decision, not implied by
    anything already decided.

### Hardening with systemd

Node 24 has no network permission, so under `--hardened` outbound network is
left to the OS. A unit along these lines (adjust paths, addresses and
ports) gives the process a read-only file system apart from its module
directory, no new privileges, a private `/tmp`, a memory ceiling, and
outbound traffic only to the addresses you list:

```ini
[Service]
ExecStart=/usr/bin/node /opt/countinghouse/framework.js --workerThread --hardened --moduleSandbox enforce --modulePolicy /etc/countinghouse/policy.json
User=countinghouse
ProtectSystem=strict
ReadWritePaths=/var/lib/countinghouse/modules /var/lib/countinghouse/auth
NoNewPrivileges=yes
PrivateTmp=yes
MemoryMax=2G
IPAddressDeny=any
IPAddressAllow=127.0.0.1 # Redis; add CouchDB and operator-approved hosts
```

`IPAddressAllow` takes addresses and networks, not host names, so the hosts
modules are approved to call have to be listed by address.

## Honest comparison

| Approach | Isolation strength | Density / cold start | Operational cost |
|---|---|---|---|
| **worker_threads** (current, with the module sandbox) | Separate V8 heap + execution context; in-process lockdown, permissions and limits on top; shared OS process, filesystem and network until parts 2-3 | Very high density (threads, not processes); near-zero cold start | Minimal — no extra infra |
| Linux containers (Docker/OCI, no extra sandboxing) | Separate filesystem/network namespace, cgroup resource limits; shared host kernel | High density; cold start ~100ms–1s | Moderate — container orchestration |
| gVisor (or similar user-space kernel) | Syscalls intercepted/emulated by a sandboxed kernel; strong defense against kernel-exploit-based escape | Medium density; cold start adds tens of ms over a bare container | Moderate-high — gVisor runtime + monitoring |
| Micro-VMs (Firecracker, etc.) | Full hardware-virtualized isolation; separate kernel per tenant | Lower density than containers; cold start ~100ms+ (improving) | High — VM-level infra, harder multi-tenant bin-packing |
| V8 isolates (Cloudflare Workers / `workerd`) | Separate V8 isolate per tenant, similar boundary to `worker_threads` but combined with a locked-down, purpose-built runtime (no `fs`, no arbitrary native addons, curated globals) | Extremely high density; sub-millisecond cold start | Requires a custom, restricted runtime — not "just run npm packages" |

`worker_threads` sits at the weak end of this table on isolation strength,
and its main advantage — density and cold-start — is exactly the same
advantage the V8-isolate row gets *plus* a far smaller attack surface,
because `workerd`-style runtimes deliberately don't expose `fs`, unrestricted
native addons, or a real `process` global. countinghouse's isolation model
is closer to "same process, separate heap" than to any of the harder
options in this table — it should not be described as comparable to gVisor
or micro-VM isolation.

## Positioning

**"Worker-thread isolation + module review (verify/publish)" fits a
semi-trusted, operator-vetted third-party module model** — modules are
vetted by the platform operator (structural verification, and in practice,
human review) before being loaded, not open to anonymous, unreviewed code
execution. It does **not** provide hard isolation equivalent to containers,
gVisor, or micro-VMs, and should not be marketed as such. The honest pitch
is: this is a reasonable, low-overhead boundary for modules from developers
the operator has a relationship with and has reviewed, not a boundary
suitable for running arbitrary, adversarial, unreviewed code from the open
internet. (countinghouse itself runs no marketplace — modules are
distributed over npm — so "marketplace" described the trust posture, not a
feature of this project; see
`docs/superpowers/specs/2026-09-04-marketplace-backend-design.md` for why
the framing changed.)

## Roadmap

The module sandbox is delivered in four parts; the design is
[`superpowers/specs/2026-10-15-module-sandbox-foundation-design.md`](superpowers/specs/2026-10-15-module-sandbox-foundation-design.md).
**Part 1 (foundation) is what this document describes.** The rest is not
implemented:

- **Part 2: file broker and virtual root.** `fs` and `fs/promises` routed
  through the main thread; a per-module virtual root (`/app`, `/data`,
  `/tmp`, declared mounts) with `__dirname` and `require` virtualized;
  out-of-root access answers `ENOENT` and is logged on the host; file
  quotas; an explicit uninstall that deletes the module's private data. This
  is what makes the declared `fs` permissions take effect and is expected to
  close the `require.cache` / `createRequire` routes described above.
- **Part 3: HTTP(S) broker.** `fetch`, `http` and `https` through the main
  thread, DNS done by the broker, the destination checked after resolution,
  private ranges and localhost denied unless approved, request quotas. This
  is what makes the declared `net` permissions take effect.
- **Part 4: raw TCP/TLS relay.** `net` and `tls` through the main thread;
  UDP stays denied.

Beyond the programme, as before: a **hybrid mode** with an opt-in process- or
container-per-module mode for modules the operator wants stronger isolation
for, at the cost of density and cold-start, or a container or microVM shell
around the whole process. The sandbox does not replace either; it is the
in-process layer that remains useful under both.
