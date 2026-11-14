# Lean worker: one module per worker, without a runtime per worker

Status: approved direction (2026-11-13); in the first release. The maintainer decided, 2026-11-13: "CDIF style modules should be retired". Steps 1 and 2
start now; steps 3-5 wait for R2-1 (no raw keys in modules), since both
change the worker's message handling and handler-ctx.

## Intent

The maintainer, 2026-11-12: "I know the issue that worker thread startup time
is long from CDIF era ... please use your best effort and think deeply to
solve this issue. Also, I think worker thread mode will consume a lot of
memory. Single thread module load is very fast, but crash in one module would
affect the whole system which is hard to accept."

So the goal is single-thread-like start-up time and memory while keeping one
module per worker thread, which is what isolates a crash, an out-of-memory
condition or an endless loop to one module.

## What was measured (implementer A, 2026-11-13, Docker on 2 CPUs, pack 1)

| | Today |
|---|---|
| Main thread with no modules (RSS) | 118 MB |
| Each added module worker (RSS) | about 58-62 MB; its V8 heap is 31 MB used, 62 MB allocated |
| Pack 1, 9 workers | 645 MB |
| Pack 1 in single-thread mode | 131 MB |
| Files a worker requires at boot | 565, about 1.57 s |
| Of which: sandbox prelude | 6 files, about 13 ms |
| Of which: the invoke path (handler-ctx, service, validator...) | 7 files, about 270 ms, most of it ajv compiling the device root schema |
| Of which: everything else | 556 files (43 countinghouse, 513 dependencies), about 1.3 s; axios alone 223 ms, through countinghouse-util's tree |

The cause is in lib/sandbox.js: every worker boots a whole runtime (the
module manager, countinghouse-interface and its device manager,
countinghouse-util, countinghouse-device with ajv and json-schema-ref-parser,
redis-api) to host one module. A handler-map module, which is every pack
module and the modern module format, uses about eleven of those files.

Validation, measured with the runtime's own validator on pack 1's real
payloads and on synthetic ones:

| Payload | Validate on main (median, p99) | structuredClone of the same payload | Worker round trip |
|---|---|---|---|
| A whole pack 1 call (every input and output) | about 0.06-0.08 ms in total | | |
| 100 KB | 0.017 ms, 0.24 ms | 0.40 ms | 1.1 ms |
| 1 MB | 0.26 ms, 2.7 ms | 5.4 ms | 12.6 ms |
| 22.7 MB | 5.2 ms, 7.9 ms | 303 ms | 1.22 s |

Validation costs 1/20 to 1/60 of the copy every call already pays to cross
from a worker to the main thread.

## Goals

- A handler-map module's worker boots in a small fraction of today's 1.6 s
  and costs a small fraction of today's ~60 MB. Targets for acceptance, on the
  same Docker setup: worker boot median at most 200 ms; added RSS per worker
  at most 20 MB; pack 1 ready in at most 5 s.
- One module per worker, as today. A crash, an out-of-memory condition, an
  endless loop or `process.exit` in a module still ends only its own worker,
  and the supervisor restarts it as today.
- Input and output validation of a module's actions moves out of the
  module's own worker into code the module cannot reach.
- No change to the handler-map module format, the MCP surface, the error
  shapes, metering, the receipt, or what a module can do through `ctx` and
  `CHUtil`.
- CDIF-style modules are retired (the maintainer's decision, 2026-11-13): a
  device class built on CHDevice, dynamic discovery and device events are no
  longer supported. Every module is a handler-map module, so every worker is
  a lean worker and the closed-output-schema guarantee covers every module.

## Non-goals

- Keeping CDIF-style modules working. They are retired, not migrated: there
  are no outside module authors yet, and every bundled example and pack
  module is already a handler-map module (only test fixtures use device.js).
- Several modules in one worker. It would save more memory, but every module
  has its own virtual identity (`/app`), its own file namespace and its own
  lockdown, and sharing a worker would weaken the isolation the maintainer
  wants. Rejected.
- A V8 compile cache (measured at 35-140 ms per worker, deferred in #123 for
  its trust surface).
- A separate validation thread. Measured: it would add a copy and a round
  trip that cost far more than the validation itself (1.2 s against 5 ms at
  23 MB). Rejected.

## Anti-goals

- A lean worker that is easier to escape, or a module that can influence the
  validation of its own output.
- A main thread that blocks: no unbounded work per call. The result size cap
  below bounds validation and the copy together.
- Two diverging implementations of the module API: `ctx` and `CHUtil` behave
  the same in a lean worker and in single-thread mode.

## Design

### 1. One kind of worker; CDIF-style modules refused

With CDIF-style modules retired, the main thread decides from static facts
whether a module can load at all (it never runs module code). A module loads
when it declares a role (`countinghouse.role` is `"scenario"` or `"part"` in
package.json, as every pack module does) or has a `handlers/` directory, and
has no main entry that exports something else. Anything else, a CDIF-style
module included, is refused at load with an error that names the
handler-map format and links module-development.md, on every path (startup,
the load route, the authoring tools, countinghouse-validate).

Every module then runs in a lean worker (lib/lean-worker.js). Single-thread
mode is unchanged apart from refusing the same modules. Today's full worker
boot (lib/sandbox.js's runtime-per-worker) and the code only it needs
(dynamic discovery, device events, the discovery hold, CHDevice for modules)
are removed in the same change, along with their test fixtures
(test/fixtures/*/device.js) and the tests that exercise them, each replaced
by a refusal test.

### 2. What a lean worker loads

Only:

- the sandbox prelude, first and unchanged: resolve-shim, the file broker's
  identity, patch and client, and at set-options the lockdown and
  loopback-names;
- the message channel to the main thread (lib/worker-message.js and
  countinghouse-error);
- a small dispatcher: it requires the module's handler files (lib/handler-map.js
  today, without the CdifDevice dependency that lib/handler-map-module.js has)
  and runs a handler for each invoke it receives;
- lib/handler-ctx.js, with countinghouse-util replaced by a facade (below);
- call-address and the remote client's worker side (remote calls already run
  on the main thread).

Not loaded: the module manager, countinghouse-interface and its device manager,
countinghouse-device, lib/service.js, lib/validator.js and ajv,
json-schema-ref-parser, redis-api, postman-request, axios and the rest
of countinghouse-util's dependency tree.

The builder writes a test that lists every file a lean worker has required
after its first invoke, and fails if anything outside an allowed list appears.
That test is what keeps the worker lean as the code changes.

### 3. CHUtil and ctx in a lean worker

`CHUtil` stays a global with the same methods. In a lean worker it is a facade
whose helpers load their implementation on first use, the way #126 already
made `CHUtil.request` lazy (SOAP support was removed then, Matt, 2026-11-13). A module that never uses a
helper never loads its library. The lockdown's host check wraps the facade's
methods, so it applies on the first call too.

`ctx` is built by handler-ctx exactly as today: `ctx.call`, `ctx.remote...`,
`ctx.redis` (a message to the main thread), job progress, `recordUsage`.

*Amended (the high review of #177):* every outbound request the
implementation makes, `CHUtil.invokeAction`'s included, goes through the
facade's `request` as the lockdown wrapped it. The facade has no `dm` or `ci`,
and a service client it hands out holds no reference to the runtime. The
implementation keeps the worker's state internal: its `dm` and `ci` read as
undefined in a worker, and it is attached to the worker once, by the facade's
closure.

What remains, stated as a residual: module code shares its worker's realm.
Through `require.cache` it reaches the exports of every runtime file the
worker has loaded: postman-request, `countinghouse-util`'s helpers, and the
peer channel and handler code. Through the global `MessagePort` prototype it
sees the messages the runtime sends and can send its own. None of these hand
it a key, a user name or another module's state, and the main thread checks
every message it receives (tokens, declarations, grants, the sending worker's
own devices) as if the worker were hostile. A boundary against a module that
goes around the facade is the main thread's checks and, under `enforce`, the
lockdown, not the facade.

### 4. The module's spec on the main thread; its validation in validator workers

Revised on #152 (the reviewer, 2026-11-13). The first version validated on
the main thread. The high review showed that JSON Schema validation of a
module-authored schema cannot be bounded by checks made beforehand:
- patterns that pass any static check still take seconds (`^(\w|a)+$`, 62 s;
  `^\d*\d*\d*\d*$`, 14 s; `\s+$` on 50 KB, 4 s);
- a 1.2 KB `anyOf` schema compiles for 5.9 s;
- `uniqueItems` over 20000 items takes 24 s.

On the shared main thread, each of these stalls every module and session. So
validation runs in neither the main thread nor the module's own worker, but in
a validator worker.

Today the worker reads api.json and schema.json, builds the device and its
services, compiles one validator per action, and sends the spec to the main
thread when the device comes online.

In the lean design, per module load and before the worker starts:

- **The main thread** reads api.json and schema.json from the module's
  directory. It keeps only what is cheap and structural: the device ID, the
  spec as text, its services' and actions' own names, and a hash of
  schema.json. It never compiles or walks a schema.
- **The validator pool** (`lib/validator-pool.js`) gets the two files as
  text. That is a few workers, `--validatorWorkers` (default 2), each with
  resource limits. A validator builds the module's services with the
  runtime's own Service code and compiles them under an ajv instance of the
  module's own, lazily, on the module's first check. No module code ever runs
  there, so a module cannot switch its validation off (the finding of
  `test/sandbox/41`: in its own worker, under the default sandbox, it can).
- **The device** is registered from the main thread's spec, so tools/list,
  the gateway and routing see exactly what they see today. A worker's
  announcement must match that spec (and the schema.json hash).
- **The worker** is told only which handler file serves which action
  (possible because a lean module's handlers are one file per action under
  `handlers/`).

Step 1 of the sequence does this while modules still run on today's workers.
Those workers skip their own validation for a call the main thread sends.

On every call routed through the main thread (an MCP tools/call, an HTTP
invoke-action, a job's run, a hop routed through the main thread):

1. **Structural checks on the main thread:** the service, the action, an
   input at all.
2. **The input is validated in a validator.** A failure answers exactly as
   today's in-worker failure does (same code, same text, same shape), and the
   module's worker never sees the call.
3. **The worker** runs the handler and returns its output.
4. **The output** has its size checked on the main thread (section 5), is
   validated in a validator, and is answered as today.

The value validated is the structured clone posted to the validator: exactly
what the module's worker receives.

**Bounds** (as the reviewer corrected them on #152, 2026-11-13):
- **The deadline:** each validator request has one, `--validationTimeoutMs`
  (default 1000), counted from when it is queued: queue wait plus run. Past
  it the call is refused `VALIDATION_TIMEOUT` (naming the module, the action
  and the side, never a key or a value), and it is logged. A request still
  queued is dropped, never validated nor sent on to the module. A running one
  has its validator replaced (a crash or its memory limit too), with a
  growing backoff when replacements keep coming.
- **Fairness between tenants:** one queue per module, served round-robin
  across modules. A module holds at most all but one of the validators, even
  when no other module is waiting, so another module always finds one free.
- **Compiling:** per action, from one dereference of the module's document,
  under its own budget, `--validationCompileMs` (default 10000). Every action
  is compiled at load (warm), and past the budget the load is refused
  (`MODULE_ASSEMBLY_FAIL`, stage `schemaCompile`), so an operator sees it at
  load and not as call timeouts. A validator that replaced one compiles an
  action again before its check, under the same budget; the check's deadline
  resumes after.
- **The circuit breaker:** only a module's own output's timeout or its
  compile's counts against it. An input's does not, since any caller can
  send a slow input, and neither does a wait in the queue. 3 strikes in 5
  minutes quarantine the module by name: `VALIDATION_QUARANTINED` until an
  operator loads it again (a supervisor's restart does not clear it).
- **The output's size:** `--maxOutputBytes` (default 8 MiB), measured in the
  module's own worker before it posts its reply; past it the call is refused
  `OUTPUT_TOO_LARGE` (naming the module and the action). Step 2's buffers
  make that the main thread's guarantee too.
- **The load-time courtesy check:** `lib/schema-safety.js` refuses at load,
  `MODULE_ASSEMBLY_FAIL` stage `schemaSafety`, a schema.json over 1 MB, a
  pattern over 1000 characters or of star height above 1, and a document
  over 100000 nodes with its `$ref`s and `$dynamicRef`s expanded. It runs in
  a validator, and one that fails to run refuses the module. It is a
  courtesy; the validator's deadline is the boundary.

**Measured** on the maintainer's 2-CPU VM, through the real pool: one
call's input and output checks (two round trips) cost 0.17 ms p50 and
0.47 ms p90 with a small output, and 0.53 ms p50 with a 100 KB output. These
replace the in-worker validation the module's worker no longer does.

This is the change that matters for security as well as speed: today the
output check that makes a closed output schema a guarantee runs in the
module's own worker, where code in the module can interfere with it. In a
validator the module cannot reach it, and the main thread never runs a
module's schema.

### 5. Results: what the main thread unpacks, and the cap on it

Today a worker's reply crosses with a plain postMessage, which rebuilds the
whole object on the main thread before any code there can look at it, and
nothing caps its size (unpacking 23 MB took 303 ms in the measurement).

The maintainer asked (2026-11-13) that a size cap not become a hard limit on
what modules can pass to each other. So the design separates two kinds of
result (the reviewer's call, refining the first draft):

- **A hop's result, passed from one module to another,** crosses as a buffer
  made with `v8.serialize` and transferred, not copied. The main thread
  routes it without deserialising it: it reads only the buffer's length (for
  the receipt and usage records) and transfers it on to the calling module's
  worker, which deserialises it and validates it against the called action's
  output schema with standalone validation code (as on the peer path,
  section 6). The calling module is the one that consumes it, so the check
  protects the right party, and the main thread's event loop never pays for
  the size. Its only limit is memory: `--maxHopResultBytes`, default
  256 MiB, configurable.
- **A final result, leaving the runtime** (an MCP tools/call result, an HTTP
  invoke-action answer, a job's stored result), is deserialised on the main
  thread, which needs the object to answer the client, and validated in a
  validator worker (section 4).
  Its cap is `--maxResultBytes`, default 16 MiB, configurable by the
  operator. A result for a model is far smaller in practice: 16 MiB is
  millions of tokens, well past any model's context, so the default never
  binds a tool whose answer a model can actually read.

Over either cap, the main thread answers RESULT_TOO_LARGE (a new code, with
the size and the cap in its text) from the buffer's length alone, never
deserialising it. The worker also checks before sending, to give the error
early, but only the main thread's check is the guarantee. Single-thread mode
has no cross-thread copy and is not capped. A module that needs to hand a
client something larger than any sensible cap (a file, a dataset) returns a
reference to it (a path in its data namespace, a URL), which is the right
shape for large data anyway.

### 6. Direct peer channels

A hop over a direct peer channel goes from the calling module's worker to the
called module's worker without passing the main thread (the hosting default;
the client profile turns peer channels off). Its input still has to be
validated before the called handler runs, because handlers rely on validated
input, and its output is checked for the caller's sake.

The main thread generates standalone validation code for a module's actions
(ajv's standalone code generation, from the validators it compiled in
section 4) and gives it to a worker only when that worker first takes part in
a peer channel:

- the called module's worker validates the incoming input with its own
  actions' code before the handler runs;
- the calling module's worker validates the output it receives with the
  called action's output code.

No ajv library is loaded in any worker; the generated code is a few small
functions. The trust reasoning: a module that interferes with the code in its
own worker can only harm itself here (its own input check, or its own check
of what it received). What reaches an MCP client or an HTTP caller is always
validated in a validator worker, out of every module's reach, because a
scenario's result always returns through the main thread.

### 7. The worker side of hops, after R2-1

`ctx.call`, `ctx.serviceClient`, `ctx.log` and both ends of a peer channel
reach DeviceManager and countinghouse-util in a worker today (ServiceClient,
QueryDevice, CHUtil.dm.workerMessage, CHUtil.ci.invokeDeviceAction,
invokeActionViaPeerChannel, onPeerChannelOpen). R2-1 (Tasks 3-5) rewrites
exactly this path: per-call tokens on every hop, the peer path metering
before it serves, and Task 5's step 3b hides CHUtil.dm and CHUtil.ci from
module code. So the lean worker's hop client is extracted after R2-1, from
the shape R2-1 leaves: one worker-side module for hops and peer channels,
the only implementation. A lean worker provides no CHUtil.dm, CHUtil.ci or
global CHDevice; R2-1 already removes the first two from module reach, and a
handler-map module has no device class.

### 8. What does not change

- One module per worker, the supervisor, restarts, backoff, suspension,
  resource limits, the file broker, virtual paths, the lockdown and its
  modes, `--hardened`.
- The MCP surface (the golden tools/list sample does not move), the error
  shapes (mcp-contract 07's golden), metering, receipts, usage records.
- Single-thread mode, apart from refusing CDIF-style modules.

## Security and privacy

- The output-schema guarantee moves to code the module cannot reach: a
  strengthening.
- The lean worker loads less of the runtime into the module's reach, so less
  of countinghouse's code can be inspected or tampered with from module code.
- R2-1's per-call tokens are unaffected in kind: the lean worker carries them
  where handler-ctx does today.
- The standalone validation code given to a peer-channel worker is generated
  by the main thread from the module's own schema; it gives the module nothing
  it did not already have (its own schema).

## Tests and acceptance (the plan writes them; this names what must hold)

- The allowed-files test in section 2.
- Crash isolation unchanged: a module that throws at load, throws in a
  handler, exhausts its heap, loops forever, or calls `process.exit` ends only
  its own lean worker; the others keep answering; the supervisor restarts it.
- Validation in validator workers: a bad input never reaches the worker; a
  bad output is refused with today's code and text; a module that tampers
  with globals in its worker cannot make an invalid output pass; a
  validation that takes too long is refused within the deadline while the
  main thread keeps answering, and a module that keeps causing it is
  quarantined.
- Result size caps: a final result over --maxResultBytes and a hop result
  over --maxHopResultBytes are refused with RESULT_TOO_LARGE without the main
  thread deserialising them; one just under each cap passes; a hop result
  larger than --maxResultBytes reaches the calling module intact, and the
  main thread's time on it does not grow with its size.
- Peer channels: invalid input over a peer channel is refused before the
  called handler runs; an invalid output is refused to the caller.
- The golden tools/list sample and mcp-contract 07's error golden do not move.
- Every existing test folder passes with lean workers in use.
- Measured on the same Docker setup as above, with the method A used: worker
  boot median at most 200 ms, added RSS per worker at most 20 MB, pack 1 ready
  in at most 5 s. Reported in the PR with the before and after numbers.
- Windows, macOS and Linux, as the CI matrix runs today.

## Sequencing and ownership

Steps 1 and 2 touch neither handler-ctx's hops nor the peer path and can be
planned now. Steps 3-5 are planned only after R2-1 merges (A's Tasks 3-6,
expected about Nov 17), against the code R2-1 leaves, not against its spec.
#126 (lazy request; SOAP removed) is assumed merged before step 3. Owners: C takes
steps 1 and 2 now; steps 3-5 go to whichever of B and C is free when R2-1
merges (B's Windows work comes first); A answers questions about the sandbox
prelude and the hop path. Each step a separate PR with the
reviewer's high review:

1. The main-side spec, and validation of routed calls in validator workers
   (section 4, as revised on #152), with today's workers otherwise unchanged
   (they skip their own validation). This step alone moves the guarantee out
   of the module's reach, and off the main thread. CDIF-style modules are
   refused from this step on.
2. Results as transferred buffers: hop results routed undeserialised and
   validated in the calling worker, final results capped on the main thread.
3. The lean worker entry and the CHUtil facade for every module, with the
   allowed-files test; today's runtime-per-worker boot, dynamic discovery and
   device events removed.
4. Peer-channel validation with standalone code.
5. The measurement against the targets, with A's measurement method
   committed as a script under perf/ first, so the before and after numbers
   come from the same harness.

## Decisions for the maintainer

Decided, 2026-11-13: CDIF-style modules are retired, not kept on a second
kind of worker.

Decided, 2026-11-13: the lean worker is in the first release (the
maintainer: "I hope lean worker feature is in the first release"). So steps 1
and 2 start now, before R2-1 merges, and steps 3-5 follow R2-1 directly.
Result caps: 16 MiB for a final result leaving the runtime, 256 MiB for a
hop result between modules, both configurable (section 5).

## Left to the builder

- The exact module layout of the lean dispatcher, and how handler-map.js is
  split from handler-map-module.js's CdifDevice dependency.
- How the main thread hands the handler map to the worker (a message after
  start, or workerData).
- The wording of RESULT_TOO_LARGE in the error catalogue (English, plus the
  catalogue's other required texts).
