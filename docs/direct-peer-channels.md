# Direct peer channels

This document describes the `--directPeerChannels` opt-in path: worker
threads that need to call each other's devices connect directly over a
`MessageChannel` port pair instead of routing every call through the main
thread. It also carries the benchmark numbers that justify building it —
the only public performance numbers this project should cite for
cross-worker calls going forward (see "Retired numbers" at the end).

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
| 1KB | 1 | 1.04ms / 7.80ms | 0.74ms / 3.95ms | 148 / 162 req/s |
| 1KB | 16 | 7.07ms / 20.89ms | 1.61ms / 6.62ms | 352 / 300 req/s |
| 1KB | 64 | 13.59ms / 38.70ms | 1.62ms / 9.42ms | 386 / 276 req/s |
| 100KB | 1 | 1.14ms / 8.28ms | 0.98ms / 9.06ms | 185 / 175 req/s |
| 100KB | 16 | 9.76ms / 23.41ms | 2.91ms / 10.27ms | 199 / 391 req/s |
| 100KB | 64 | 18.97ms / 55.82ms | 2.45ms / 14.13ms | 289 / 387 req/s |
| 1MB | 1 | 20.42ms / 53.81ms | 13.16ms / 44.56ms | 37 / 54 req/s |
| 1MB | 16 | 185.80ms / 261.98ms | 122.59ms / 185.65ms | 47 / 64 req/s |
| 1MB | 64 | 412.44ms / 521.17ms | 335.82ms / 726.45ms | 52 / 76 req/s |

**p50**: direct peer channels are faster than main-thread-routed in 9 of 9
cells, ranging from 1.16× (at 100KB/c=1) to 8.38× (at 1KB/c=64).

**Throughput**: direct peer channels win on 6 of 9 cells (1024/c=1,
102400/c=16, 102400/c=64, 1048576/c=1, 1048576/c=16, 1048576/c=64);
main-thread-routed wins on the remaining 3 (1024/c=16, 1024/c=64,
102400/c=1).

**p99**: direct peer channels are lower in 7 of 9 cells; higher (worse) in
2: 100KB/c=1 (8.28ms main vs. 9.06ms direct), 1MB/c=64 (521.17ms main vs.
726.45ms direct).

These numbers already include the backpressure fix described below — see
that section for what changed and why. Absolute numbers at a given
payload/concurrency cell vary noticeably run-to-run under sustained load —
a different run of this exact script, also post-fix, measured 417ms
(direct) vs. 608ms (main-thread-routed) at 1MB/c=64, both different from
the 336ms/412ms shown in the table above. Read the *relative* comparison
within a single run as the signal (direct has never lost the 1MB/c=64
cell's p50 across any post-fix run so far), not any individual absolute
figure. Re-run `perf/direct-peer-channels-perf.js` yourself — it will
print its own fresh summary — before relying on precise numbers for
capacity planning.

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
| 1KB | 0.27ms | **0.22ms** | 0.27ms |
| 100KB | 0.95ms | **0.36ms** | 1.61ms |
| 1MB | 23.65ms | **9.02ms** | 27.09ms |

Fastest strategy per payload size: 1KB=structuredClone, 100KB=structuredClone,
1MB=structuredClone. Structured clone wins at every size tested.
Structured clone vs. `JSON.stringify` ratio ranges from 1.22× (at 1KB) to
2.62× (at 1MB).

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
| 1KB | 1 | 0.228ms / 1.462ms | 0.366ms / 2.019ms | 0.890ms / 5.498ms | 0.228ms / 0.366ms / 0.890ms | 3296 / 2344 / 764 | 0.15s / 0.21s / 0.61s | 60MB / 89MB / 103MB | 500 |
| 1KB | 10 | 2.527ms / 6.564ms | 3.132ms / 9.652ms | 6.431ms / 17.166ms | 0.253ms / 0.313ms / 0.643ms | 3562 / 2835 / 1384 | 1.07s / 1.38s / 3.04s | 73MB / 101MB / 110MB | 400 |
| 1KB | 100 | 26.545ms / 46.832ms | 26.956ms / 57.129ms | 63.598ms / 88.287ms | 0.265ms / 0.270ms / 0.636ms | 3658 / 3363 / 1533 | 1.06s / 1.18s / 2.58s | 76MB / 105MB / 109MB | 40 |
| 64KB | 1 | 0.280ms / 2.556ms | 1.240ms / 4.067ms | 2.159ms / 5.742ms | 0.280ms / 1.240ms / 2.159ms | 2418 / 686 / 421 | 0.19s / 0.72s / 1.19s | 75MB / 106MB / 114MB | 500 |
| 64KB | 10 | 3.875ms / 15.988ms | 15.395ms / 53.820ms | 19.959ms / 39.169ms | 0.388ms / 1.539ms / 1.996ms | 2277 / 557 / 475 | 0.37s / 1.45s / 2.14s | 80MB / 112MB / 120MB | 100 |
| 64KB | 100 | 37.001ms / 66.654ms | 136.075ms / 169.094ms | 191.558ms / 250.722ms | 0.370ms / 1.361ms / 1.916ms | 2499 / 733 / 541 | 0.74s / 2.66s / 3.71s | 82MB / 116MB / 129MB | 20 |
| 1MB | 1 | 8.934ms / 16.498ms | 88.839ms / 231.273ms | 39.398ms / 69.441ms | 8.934ms / 88.839ms / 39.398ms | 108 / 11 / 24 | 1.88s / 17.49s / 7.98s | 89MB / 191MB / 195MB | 200 |
| 1MB | 10 | 97.178ms / 116.457ms | 883.946ms / 1245.203ms | 402.654ms / 569.131ms | 9.718ms / 88.395ms / 40.265ms | 103 / 11 / 24 | 1.89s / 17.02s / 7.82s | 106MB / 181MB / 195MB | 20 |
| 1MB | 100 | 970.954ms / 1122.555ms | 8932.021ms / 9848.791ms | 3592.677ms / 4166.861ms | 9.710ms / 89.320ms / 35.927ms | 102 / 11 / 28 | 19.55s / 169.14s / 71.73s | 105MB / 194MB / 204MB | 20 |

**vs. MCP stdio subprocess**: the direct peer channel has a lower p50 in 9 of 9 cells, from 1.02× (at 1KB/100hop) to 9.94× (at 1MB/1hop).

**vs. localhost HTTP**: lower p50 in 9 of 9 cells, from 2.40× (at 1KB/100hop) to 7.72× (at 64KB/1hop).

**Scale of the difference**: the largest per-hop saving measured here is 30.548ms (best case for the direct channel, across every cell). A tool whose own execution takes more than ~305ms per call would see even that saving as under 10% of the hop, and proportionally less the slower it gets. This benchmark measures transport, not tools.

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
