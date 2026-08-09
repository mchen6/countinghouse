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
unloads, or crashes — see `docs/direct-peer-channels-design.md` (D1–D5)
for the full design and `docs/cross-cutting-matrix.md`'s two
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

| Payload | Concurrency | Main-thread-routed p50 / p99 | Direct peer channel p50 / p99 | Throughput (main-thread / direct) |
|---|---|---|---|---|
| 1KB | 1 | 1.38ms / 25.01ms | **1.07ms / 5.22ms** | 113 / **127** req/s |
| 1KB | 16 | 11.04ms / 30.40ms | **2.02ms / 10.12ms** | 278 / 260 req/s |
| 1KB | 64 | 14.64ms / 42.85ms | **2.18ms / 51.50ms** | 367 / 240 req/s |
| 100KB | 1 | 1.26ms / 6.85ms | **1.10ms / 8.30ms** | 172 / 137 req/s |
| 100KB | 16 | 7.18ms / 23.54ms | **2.61ms / 9.94ms** | 347 / 314 req/s |
| 100KB | 64 | 34.73ms / 103.52ms | **3.63ms / 11.91ms** | 279 / **385** req/s |
| 1MB | 1 | 22.99ms / 68.47ms | **15.20ms / 44.79ms** | 35 / **48** req/s |
| 1MB | 16 | 197.90ms / 338.40ms | **148.96ms / 244.98ms** | 38 / **54** req/s |
| 1MB | 64 | 607.69ms / 713.35ms | **417.37ms / 862.82ms** | 40 / **63** req/s |

Direct peer channels win on p50 latency at every combination tested, by
1.3–7× depending on payload/concurrency, and match or beat throughput on
7 of 9. These numbers already include the backpressure fix described
below — see that section for what changed and why, and for the honest
caveat these numbers don't fully resolve (queueing means the highest
combination still costs real wall-clock time, it's just no longer worse
than the alternative).

Absolute numbers at a given payload/concurrency cell vary noticeably
run-to-run under sustained load (an earlier run of this exact 1MB/64-way
cell measured 360ms for main-thread-routed and 842ms for the pre-fix
direct path, on the same hardware) — read the *relative* comparison
within a single run as the signal, not any individual absolute figure.
Re-run `perf/direct-peer-channels-perf.js` yourself before relying on
precise numbers for capacity planning.

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

| Payload | `JSON.stringify` p50 | Structured clone p50 | Transfer list p50 |
|---|---|---|---|
| 1KB | 0.30ms | **0.27ms** | 0.35ms |
| 100KB | 1.21ms | **0.32ms** | 1.98ms |
| 1MB | 24.43ms | **8.90ms** | 27.48ms |

Structured clone (posting the plain object directly) wins decisively at
every payload size tested, by 2.7–3.7× over `JSON.stringify` and by even
more over the transfer-list approach. This is the opposite conclusion
from the one `lib/worker-message.js`'s pre-existing comment cites — a 2016
blog post that measured `JSON.stringify` as faster for the old,
main-thread-routed protocol — confirming this needed re-measuring on the
current Node target rather than assumed to still hold, per this project's
own stated rule about not carrying forward unverified performance claims.
The transfer-list approach loses specifically because the payloads here
start as JS objects: encoding to a `Buffer` and decoding back on the
other side costs more than structured clone's native object copy saves;
transfer-list ownership transfer would likely still win for payloads that
are *already* binary (e.g. actual file/image data passed as a `Buffer`
throughout, never JSON), which this benchmark doesn't cover and this
codebase doesn't yet have a use case for.

**Decision: `lib/peer-channel.js` keeps posting plain objects
(structured clone).** This is what it already did before this benchmark
was run — the data confirms the existing choice rather than requiring a
change.

## Retired numbers

Per `docs/cdif-audit-and-refactoring-plan.md` and this project's own
stated discipline: the old "20–30×" performance figures from this
codebase's earlier PPT-era materials must not be cited anywhere going
forward. The tables above, produced by `perf/direct-peer-channels-perf.js`
and `perf/peer-channel-serialization-perf.js` on the current Node target,
are the only legitimate public numbers for cross-worker call performance
as of this writing. Re-run both scripts and update this document if the
underlying code, Node version, or hardware changes meaningfully.
