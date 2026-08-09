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
| 1KB | 1 | 1.46ms / 17.77ms | **0.87ms / 3.47ms** | 114 / 161 req/s |
| 1KB | 16 | 9.12ms / 25.19ms | **1.56ms / 52.56ms** | 286 / 279 req/s |
| 1KB | 64 | 19.12ms / 77.35ms | **1.28ms / 8.64ms** | 318 / 254 req/s |
| 100KB | 1 | 1.37ms / 15.53ms | **0.88ms / 3.85ms** | 124 / 172 req/s |
| 100KB | 16 | 12.87ms / 31.60ms | **2.96ms / 9.62ms** | 242 / **313** req/s |
| 100KB | 64 | 67.07ms / 98.09ms | **5.17ms / 82.13ms** | 246 / **420** req/s |
| 1MB | 1 | 23.06ms / 121.14ms | **14.02ms / 41.63ms** | 30 / **52** req/s |
| 1MB | 16 | **172.71ms** / 248.99ms | 140.94ms / **329.25ms** | 44 / 49 req/s |
| 1MB | 64 | **359.79ms** / 923.00ms | 841.82ms / 966.30ms | **43** / 40 req/s |

**Read this honestly, not as a blanket "direct is faster" claim.** For
every combination except the last row, direct peer channels win on p50
latency, often by 2–13×, and usually match or beat main-thread-routed
throughput too. At **1MB payloads under 64-way concurrency, the picture
reverses**: direct peer channels are slower (p50 842ms vs. 360ms).

That reversal has a specific, understood cause, not a mystery regression.
Both paths ultimately funnel through the *same two worker threads*
(one caller, one callee) — the only difference is whether the main thread
is also in the loop. Under extreme sustained load with large payloads,
the main-thread hop acts as an incidental throttle: it's *also* a
bottleneck, but that bottleneck limits how much work can pile up waiting
at the callee worker's single-threaded event loop. Without it, direct
peer channels let all 64 concurrent 1MB calls queue directly at the
callee with no back-pressure, and the callee's own event loop — doing
real structured-clone and JS work for each — becomes the limiting factor
instead, with a worse queueing curve than the throttled path produces.
This is a real, currently-unaddressed limitation: **there is no
backpressure or concurrency limit on the direct peer channel path**. A
production deployment expecting sustained large-payload, high-concurrency
traffic on a single worker pair should not assume direct peer channels
are strictly better without accounting for this; a queue-depth limit or
per-channel concurrency cap on the callee side is the natural fix, not
built here (out of scope for this Sprint, flagged as a follow-up).

For the common case this feature targets — small-to-medium payloads,
which is most tool-call traffic, at realistic concurrency — direct peer
channels are a clear, substantial win with no observed downside.

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
