# Direct peer channels

This document describes the `--directPeerChannels` opt-in path: worker
threads that need to call each other's devices connect directly over a
`MessageChannel` port pair instead of routing every call through the main
thread. It also carries the benchmark numbers that justify building it —
the only public performance numbers this project should cite for
cross-worker calls going forward (see "Retired numbers" at the end).

All three benchmark tables below were re-measured together on 2026-08-18,
Node 20.20.2, on the 2-core reference machine, otherwise idle.

## The problem

Every device module runs in its own `worker_threads.Worker`
(`docs/security-model.md` covers why). When one module calls another's
action — `ServiceClient.invoke()`, the mechanism `docs/composite-tools.md`'s
composite-demo uses — the call does not go directly from worker A to
worker B. It goes A → main thread → B → main thread → A: four
`postMessage` hops, two of them through the main thread's own event loop.
Every cross-module call in the system serializes through that one thread,
regardless of how many workers are actually running.

## The fix

With `--directPeerChannels` on, the first time worker A calls a device
hosted by worker B, the main thread still brokers the connection — it
resolves which worker hosts the target device, checks that A's module is
authorized to call it, and hands each side one end of a new
`MessageChannel`. Every call after that goes directly between A and B: two
`postMessage` hops, zero main-thread involvement. The port is cached and
reused for later calls to the same worker (even for a different device
hosted there), and invalidated automatically if that worker reloads,
unloads, or crashes — see [`design-decisions.md`](design-decisions.md#direct-peer-channels-five-decisions-d1d5)
(D1–D5) for the full design and `docs/cross-cutting-matrix.md`'s two
"Direct peer channel" rows for exactly which cross-cutting guarantees
(authorization, metering, rate limiting, timeouts) apply on this path
versus the main-thread-routed one.

`ServiceClient.invoke()`'s external contract — callback signature, error
shape, timeout behavior — is unchanged either way. `--directPeerChannels`
is off by default; turning it on only changes which internal path a
cross-worker call takes.

## Benchmark: main-thread-routed vs. direct peer channel

Produced by `perf/direct-peer-channels-perf.js`, run on this repo's
current Node target (see `package.json`'s `engines.node`). Two purpose-built
fixture modules (`pre-installed-packages/perf-caller-demo`,
`perf-callee-demo`) round-trip a payload of a given size through
`ServiceClient.invoke()`; "hop latency" below is measured server-side
around just that call (excludes HTTP/session overhead on either side of
it), and throughput is measured client-side across the full HTTP round
trip (that overhead is identical in both conditions, so it doesn't distort
the comparison). 150 requests per cell, both conditions run against a
fresh server.

Every number below, and every comparative statement about it, is
copy-pasted verbatim from a single run of `perf/direct-peer-channels-perf.js`
(which computes the comparison itself — see that file's header comment for
why hand-written summaries are not allowed here anymore: an earlier
version of this section claimed "1.3–7×" and "match or beat throughput on
7 of 9", and both were wrong against the very table they described).

| Payload | Concurrency | Main-thread-routed p50 / p99 | Direct peer channel p50 / p99 | Throughput (main-thread / direct) |
|---|---|---|---|---|
| 1KB | 1 | 3.00ms / 7.29ms | 2.81ms / 16.12ms | 122 / 134 req/s |
| 1KB | 16 | 21.68ms / 40.51ms | 21.42ms / 35.92ms | 266 / 287 req/s |
| 1KB | 64 | 40.64ms / 73.55ms | 35.36ms / 81.04ms | 278 / 312 req/s |
| 100KB | 1 | 3.00ms / 9.79ms | 3.00ms / 12.49ms | 128 / 138 req/s |
| 100KB | 16 | 19.69ms / 36.23ms | 19.06ms / 35.17ms | 289 / 322 req/s |
| 100KB | 64 | 87.88ms / 116.07ms | 86.18ms / 150.31ms | 276 / 371 req/s |
| 1MB | 1 | 18.23ms / 37.23ms | 11.95ms / 27.34ms | 42 / 59 req/s |
| 1MB | 16 | 171.12ms / 274.84ms | 117.42ms / 191.33ms | 58 / 75 req/s |
| 1MB | 64 | 539.16ms / 804.18ms | 305.77ms / 626.33ms | 61 / 85 req/s |

**p50**: direct peer channels are faster than main-thread-routed in 8 of 9 cells, ranging from 1.00× (at 100KB/c=1) to 1.76× (at 1MB/c=64).

**Throughput**: direct peer channels win on 9 of 9 cells (1024/c=1, 1024/c=16, 1024/c=64, 102400/c=1, 102400/c=16, 102400/c=64, 1048576/c=1, 1048576/c=16, 1048576/c=64).

**p99**: direct peer channels are lower in 5 of 9 cells; higher (worse) in 4: 1KB/c=1 (7.29ms main vs. 16.12ms direct), 1KB/c=64 (73.55ms main vs. 81.04ms direct), 100KB/c=1 (9.79ms main vs. 12.49ms direct), 100KB/c=64 (116.07ms main vs. 150.31ms direct).

These numbers already include the backpressure fix described below — see
that section for what changed and why.

**Run-to-run variance is large in the mid-concurrency cells, and it is worth
knowing which rows to trust.** Running this script three times against
*identical* code on the 6.0.0 reference machine (2 cores, otherwise idle) gave
a main-thread p50 spread of 3–6% at c=1 and at 1MB/c=64, but 33% at 1KB/c=64,
43% at 100KB/c=16 and 175% at 100KB/c=64. So a single run cannot resolve a 10%
difference in those cells, and neither can a comparison of two single runs.
Read the *relative* comparison within one run as the signal, and treat any
absolute mid-concurrency figure as indicative only.

A worked example from 6.0.0's own release measurements, because it shows the
effect at a cell you would otherwise trust: at 100KB/c=1 the main-thread p50
read 3.10ms in 6.0.0's release table and 3.40ms on a re-run of the *same commit* —
+10%, from nothing but background load (the reference machine has 2 cores; the
re-run had a CouchDB, a MongoDB and an Appsmith container running alongside).
That cell is one of the *stable* ones: three runs of identical code on the idle
machine spread only 5%. So a 10% swing there is load, not code — and a
before/after comparison of two single runs, one taken on a busy machine, can
manufacture a regression that does not exist. It did during this release, until
the same-code control run was added. Re-run
`perf/direct-peer-channels-perf.js` yourself — it prints its own fresh
summary — before relying on precise numbers for capacity planning.

## Backpressure

The first version of this benchmark (before the fix described here) found
a real regression: at 1MB payloads under 64-way concurrency specifically,
direct peer channels were *slower* than main-thread-routed (842ms p50 vs.
360ms). Root cause: both paths ultimately funnel through the same two
worker threads (one caller, one callee) — the only difference is whether
the main thread is also in the loop. The main-thread hop is itself a
bottleneck, but that bottleneck incidentally throttled how much work
could pile up waiting at the callee's single-threaded event loop.
Direct peer channels had no such throttle: every `ServiceClient.invoke()`
call fired a `postMessage` immediately, structured-clone cost and all,
regardless of how many were already in flight on that channel.

**Fix**: `lib/peer-channel.js` now caps how many invokes a channel will
have in flight at once — on *both* ends. Capping only the callee's
dispatch (`onInvoke`) was tried first and didn't help: `postMessage`'s
structured-clone cost for a large payload is paid at *send* time, so an
uncapped caller was still firing (and paying for) every concurrent
`invoke()` call before any callee-side cap could matter. The real fix
queues on both sides — outgoing `invoke()` calls once too many are
already in flight, and incoming `peer-invoke` dispatch to `onInvoke` the
same way — draining each queue as in-flight calls complete.

Controlled by `--directPeerChannelsMaxConcurrency` (default **16**).
Tuned empirically at the regressing 1MB/64-way cell, not guessed:

| Cap | p50 | p99 |
|---|---|---|
| uncapped (pre-fix) | 688ms | 930ms |
| 4 | 437ms | 1190ms |
| 8 | 460ms | 936ms |
| 16 | 464ms | 1056ms |
| 32 | 567ms | 997ms |

4, 8, and 16 land in the same range (a real, roughly 1.5× improvement
over uncapped); 32 trends back toward uncapped. 16 was chosen as the
default over a lower cap like 4 specifically to avoid needlessly
serializing calls at payload sizes where concurrency was never a problem
in the first place (1KB/100KB throughput at concurrency 16–64 was already
excellent uncapped) — a fixed call-count cap is a blunt instrument that
can't distinguish "many small calls" from "many large calls," so this
picks a value that helps the large-payload case without meaningfully
constraining the common case. `test/direct-peer-channels/05-backpressure.js`
covers correctness (a burst well above a low cap all complete correctly,
none dropped by the queue) — that test is not a performance assertion,
this document is.

**Still a known limitation, smaller than before but real**: the cap is a
fixed call count, not payload-size-aware or adaptive. A deployment
expecting sustained, very-large-payload, high-concurrency traffic on a
single worker pair should tune `--directPeerChannelsMaxConcurrency` for
its own payload sizes rather than assume the default is optimal, and a
genuinely size-aware or adaptive throttle (e.g. capping total bytes
in flight, not call count) would likely do better than a fixed cap —
not built here, flagged as a further follow-up.

## Benchmark: message serialization strategy (D2)

`perf/peer-channel-serialization-perf.js` compares three ways to move a
payload across a `MessagePort`, independent of the rest of the server:
`JSON.stringify` to a string, posting the raw object (relying on
structured clone), and encoding into a `Buffer`/`ArrayBuffer` transferred
via the `postMessage` transfer list (zero-copy ownership transfer). 300
round trips per cell.

Table and summary below are copy-pasted verbatim from a single run of
`perf/peer-channel-serialization-perf.js`, which computes the summary
itself (see that file's header comment: an earlier hand-written "2.7–3.7×"
claim here silently ignored the 1KB row, which only ever showed a much
smaller ratio).

| Payload | `JSON.stringify` p50 | Structured clone p50 | Transfer list p50 |
|---|---|---|---|
| 1KB | 0.31ms | **0.20ms** | 0.29ms |
| 100KB | 0.92ms | **0.31ms** | 1.19ms |
| 1MB | 22.50ms | **8.11ms** | 24.82ms |

Fastest strategy per payload size: 1KB=structuredClone, 100KB=structuredClone, 1MB=structuredClone. Structured clone wins at every size tested. Structured clone vs. `JSON.stringify` ratio ranges from 1.49× (at 1KB) to 3.01× (at 100KB).

This is the opposite conclusion from the one `lib/worker-message.js`'s
pre-existing comment cites — a 2016 blog post that measured
`JSON.stringify` as faster for the old, main-thread-routed protocol —
confirming this needed re-measuring on the current Node target rather
than assumed to still hold, per this project's own stated rule about not
carrying forward unverified performance claims. The transfer-list
approach loses specifically because the payloads here start as JS
objects: encoding to a `Buffer` and decoding back on the other side costs
more than structured clone's native object copy saves; transfer-list
ownership transfer would likely still win for payloads that are *already*
binary (e.g. actual file/image data passed as a `Buffer` throughout,
never JSON), which this benchmark doesn't cover and this codebase doesn't
yet have a use case for.

**Decision: `lib/peer-channel.js` keeps posting plain objects
(structured clone).** This is what it already did before this benchmark
was run — the data confirms the existing choice rather than requiring a
change.

## Benchmark: transport overhead vs. other tool-to-tool mechanisms

The tables above compare countinghouse's two *internal* routing paths against
each other. This one asks a different question: how much does the transport
choice cost at all, compared with the two mechanisms an MCP deployment would
otherwise use to get from one tool to another -- a stdio subprocess, and
localhost HTTP.

Produced by `perf/cross-process-comparison.js` (see that file's header for the
full methodology). Same discipline as the tables above: the summary below is
generated by the script from the numbers it measured, and nothing in this
section is hand-computed.

**Read the scope before the numbers:**

- **This measures the transport, not an MCP implementation.** Every peer in
  all three conditions does the same nothing -- parse, echo the payload,
  serialize. No tool work, no schema validation, no auth, no metering.
- **Condition (b) is not a real MCP server.** It is a bare
  newline-delimited JSON-RPC 2.0 echo over stdin/stdout -- the framing MCP's
  stdio transport uses -- with no `initialize` handshake, no capability
  negotiation and no `tools/list`. A real MCP server does strictly more per
  call, so this is the *best case* for stdio, not a typical one.
- **A "chain of N hops" is N sequential round trips through one peer**, not a
  pipeline through N distinct peers -- that isolates per-hop transport cost
  instead of measuring process startup N times.
- Conditions (b) and (c) each run their peer in a separate **process**;
  condition (a) runs both ends as **worker threads** in one process, over the
  real `lib/peer-channel.js`. That process/thread difference is the thing
  being measured, not an artifact of the harness.
- CPU and peak RSS are summed across every process involved in a condition,
  read from `/proc`. Peer startup is excluded from all three conditions: each
  one warms up before sampling begins.

| Payload | Hops | Direct peer channel<br>p50 / p99 | MCP stdio subprocess<br>p50 / p99 | localhost HTTP<br>p50 / p99 | Per-hop p50<br>(peer / stdio / http) | Hops/s<br>(peer / stdio / http) | CPU<br>(peer / stdio / http) | Peak RSS<br>(peer / stdio / http) | n |
|---|---|---|---|---|---|---|---|---|---|
| 1KB | 1 | 0.341ms / 1.058ms | 0.363ms / 1.312ms | 0.733ms / 3.367ms | 0.341ms / 0.363ms / 0.733ms | 2654 / 2368 / 1069 | 0.17s / 0.23s / 0.56s | 59MB / 88MB / 101MB | 500 |
| 1KB | 10 | 2.846ms / 5.887ms | 3.282ms / 6.764ms | 6.264ms / 15.022ms | 0.285ms / 0.328ms / 0.626ms | 3347 / 2827 / 1456 | 1.12s / 1.49s / 3.08s | 72MB / 101MB / 107MB | 400 |
| 1KB | 100 | 28.428ms / 70.105ms | 33.377ms / 50.111ms | 69.648ms / 177.247ms | 0.284ms / 0.334ms / 0.696ms | 3436 / 2961 / 1348 | 1.13s / 1.37s / 2.94s | 75MB / 103MB / 107MB | 40 |
| 64KB | 1 | 0.371ms / 1.861ms | 1.316ms / 6.176ms | 2.083ms / 11.273ms | 0.371ms / 1.316ms / 2.083ms | 2158 / 580 / 358 | 0.23s / 0.92s / 1.54s | 75MB / 104MB / 114MB | 500 |
| 64KB | 10 | 4.065ms / 14.600ms | 13.063ms / 25.913ms | 19.853ms / 37.398ms | 0.407ms / 1.306ms / 1.985ms | 2091 / 734 / 483 | 0.42s / 1.50s / 2.35s | 81MB / 110MB / 119MB | 100 |
| 64KB | 100 | 43.076ms / 62.142ms | 127.590ms / 164.524ms | 178.073ms / 260.603ms | 0.431ms / 1.276ms / 1.781ms | 2274 / 751 / 563 | 0.82s / 2.87s / 3.95s | 82MB / 110MB / 127MB | 20 |
| 1MB | 1 | 9.124ms / 25.746ms | 86.092ms / 124.117ms | 38.762ms / 62.200ms | 9.124ms / 86.092ms / 38.762ms | 107 / 11 / 25 | 2.00s / 18.12s / 8.35s | 88MB / 166MB / 195MB | 200 |
| 1MB | 10 | 87.253ms / 120.025ms | 882.280ms / 928.512ms | 394.905ms / 501.599ms | 8.725ms / 88.228ms / 39.491ms | 112 / 11 / 25 | 1.90s / 18.05s / 8.47s | 113MB / 178MB / 190MB | 20 |
| 1MB | 100 | 939.081ms / 1206.357ms | 8339.424ms / 9330.792ms | 3661.641ms / 3771.925ms | 9.391ms / 83.394ms / 36.616ms | 103 / 12 / 27 | 21.00s / 172.63s / 76.44s | 125MB / 185MB / 200MB | 20 |

**vs. MCP stdio subprocess**: the direct peer channel has a lower p50 in 9 of 9 cells, from 1.06× (at 1KB/1hop) to 10.11× (at 1MB/10hop).

**vs. localhost HTTP**: lower p50 in 9 of 9 cells, from 2.15× (at 1KB/1hop) to 5.61× (at 64KB/1hop).

**Scale of the difference**: the largest per-hop saving measured here is 30.765ms (best case for the direct channel, across every cell). A tool whose own execution takes more than ~308ms per call would see even that saving as under 10% of the hop, and proportionally less the slower it gets. This benchmark measures transport, not tools.

### What this does and does not justify

The direct peer channel has the lower p50 in every cell, and the margin grows
with payload size -- which is what you would expect, since it is the only one
of the three that does not serialize the payload to a byte stream and push it
through a kernel boundary. At 1KB the gap against stdio nearly closes; at 1MB
it does not.

**But the margin only matters when it is a meaningful share of the call.**
The break-even figure in the summary above is computed by the script from its
own measurements, not asserted here: once a tool's own execution time passes
it, that time dominates and the transport difference disappears into the
noise. Most real tools -- anything that hits a database, an API, a model, or
the disk -- are far past it.

So the honest reading of this table is narrow. **Composition-heavy workloads
with large payloads and fast tools** are where the transport choice shows up
at all. A chain of slow tools will not notice the difference, and nothing
here argues that it should.

## Retired numbers

Per this project's own stated discipline: the old "20–30×" performance figures from this
codebase's earlier PPT-era materials must not be cited anywhere going
forward. The tables above, produced by `perf/direct-peer-channels-perf.js`,
`perf/peer-channel-serialization-perf.js` and
`perf/cross-process-comparison.js` on the current Node target, are the only
legitimate public numbers for cross-worker call performance as of this
writing. Re-run all three scripts and update this document if the underlying
code, Node version, or hardware changes meaningfully.

The same rule covers the comparison prose beside each table: every summary
in this document is emitted by the script that measured it, copy-pasted from
a real run. None of it is hand-computed, and none of it may be edited by
hand -- a hand-written summary drifted from the table beside it once
already, which is why the scripts generate their own.
