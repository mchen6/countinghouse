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
with the full privileges of the Node.js process's OS user. There is no
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
  corresponding module rather than letting an uncaught exception take down
  the whole process.

### What this explicitly does NOT provide

- **No OS-level isolation.** `worker_threads` share the same process, same
  OS user, same filesystem view, and same network stack as the main thread.
  A module can `require('fs')` and read/write anything the process user can
  reach, `require('net')`/`require('http')`/`fetch` and make arbitrary
  outbound connections, and `require('child_process')` and spawn processes.
  None of this is blocked. There is no `--experimental-permission` model or
  equivalent applied to worker threads.
- **No native-module-escape protection.** A module can `require()` any
  native addon (`.node` file) available in `node_modules`. Native code runs
  with full process privileges and is not constrained by the V8
  isolate boundary that separates JS heaps — a native addon can access
  process memory directly. `verify-module` (see below) does not inspect or
  restrict native dependencies.
- **`process` is fully reachable.** Nothing strips or proxies the `process`
  global inside a worker. A module can call `process.exit()` (killing its
  own worker, a self-inflicted denial of service, not a platform compromise
  by itself), read `process.env` (any secrets passed via environment
  variables are visible to every loaded module), and inspect
  `process.versions`/`process.platform`/etc. for fingerprinting.
- **No resource quotas.** `new Worker(__dirname + '/sandbox.js')`
  (`lib/module-manager.js`) is called with no `resourceLimits` option. A
  module can allocate memory or burn CPU without any per-worker cap; on this
  point `worker_threads` provides no more containment than spawning an
  unbounded loop on the main thread would. There is no cooperative
  preemption either — a synchronous CPU-bound loop in one worker's action
  handler blocks that worker's own event loop for other pending
  callbacks/messages until it returns (it does not block the main thread or
  other workers' event loops, since each worker has its own).
- **No code-signing or provenance check.** See `verify-module` below —
  "verify" here means structural conformance, not authorship or integrity
  attestation.

## Current mitigations inventory

These are real, and worth being specific about rather than waving at
"we have security measures":

- **Module structural verification** (`lib/routes/verify-module.js` →
  `ModuleManager.prototype.verifyModule`, `lib/module-manager.js`). Before a
  module is installed, its `package.json`, `api.json`, and `schema.json` are
  extracted and parsed, and the API spec is checked against the framework's
  own JSON Schema 2020-12 meta-schema (`lib/validator.js`, via `ajv`) for
  structural conformance — well-formed service/action lists, valid
  `serviceStateTable` references, resolvable schema pointers. **This is not
  a security scan.** It does not inspect the module's actual JS source, does
  not check its `node_modules` dependency tree for known vulnerabilities,
  and does not verify a signature or checksum against a trusted publisher.
  A structurally valid `api.json` sitting next to arbitrary, unreviewed JS
  is exactly what this check would accept.
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

## Honest comparison

| Approach | Isolation strength | Density / cold start | Operational cost |
|---|---|---|---|
| **worker_threads** (current) | Separate V8 heap + execution context; shared OS process, filesystem, network, `process` | Very high density (threads, not processes); near-zero cold start | Minimal — no extra infra |
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
semi-trusted marketplace model** — modules are vetted by the platform
operator (structural verification, and in practice, human review) before
being listed, not open to anonymous, unreviewed code execution. It does
**not** provide hard isolation equivalent to containers, gVisor, or
micro-VMs, and should not be marketed as such. The honest pitch is: this is
a reasonable, low-overhead boundary for a curated marketplace of modules
from developers the platform has a relationship with, not a boundary
suitable for running arbitrary, adversarial, unreviewed code from the open
internet.

## Roadmap

None of the following are implemented today; they're the concrete next
steps to move past "shared process" isolation without adopting a full
container/VM model:

- **Per-worker resource limits.** `new Worker(...)` accepts a
  `resourceLimits` option (`maxOldGenerationSizeMb`,
  `maxYoungGenerationSizeMb`, `codeRangeSizeMb`, `stackSizeMb`) that is
  currently unused. Setting these would at least bound memory runaway per
  module and turn an unbounded OOM risk into a per-worker crash the existing
  `worker.on('exit', ...)` handler already cleans up.
- **seccomp/landlock, or a container shell around the whole process.**
  Neither restricts what one worker can do relative to another (they share
  a process), but either would meaningfully shrink what *any* module can
  reach on the host — e.g., landlock-restricting filesystem access to only
  the paths a module legitimately needs, or running the whole countinghouse
  process inside a locked-down container as a floor under the current
  worker-thread model rather than a replacement for it.
- **A hybrid mode**: worker_threads for trusted/first-party modules (where
  the current low-overhead model is the right tradeoff), with an opt-in
  process- or container-per-module mode for modules the operator wants
  stronger isolation for, at the cost of density and cold-start.
