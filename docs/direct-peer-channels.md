# Direct peer channels

This document describes the direct-peer-channel path: worker threads that
need to call each other's devices connect directly over a `MessageChannel`
port pair instead of routing every call through the main thread. It is the
default since 7.1.0 and was opt-in (`--directPeerChannels`) before;
`--no-directPeerChannels` restores main-thread routing. It also carries the benchmark numbers that justify building it —
the only public performance numbers this project should cite for
cross-worker calls going forward (see "Retired numbers" at the end).

All three benchmark tables below were re-measured together on 2026-10-26, on
a 2-vCPU VMware guest (Intel Core i7-6600U @ 2.60 GHz, 7.2 GB), Node v24.21.0, at commit `3d9599d`, otherwise idle, with three independent runs per script (`--runs 3`).
Raw output: [`perf/results/2026-10-26/`](https://github.com/mchen6/countinghouse/blob/master/perf/results/2026-10-26/README.md).

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

On the direct path, the first time worker A calls a device
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
shape, timeout behavior — is unchanged either way; the flag only changes
which internal path a cross-worker call takes.

### What the default means for an operator

Making this path the default (7.1.0) is a trade, not a free speed-up, and
the two paths do not check the same things at the same moments:

- **Authorization is checked when a channel opens, not on every hop.** On
  the main-thread-routed path each hop passes `userAuth` before it is
  routed. Here the same check runs once, at brokering time, and the channel
  it grants is good for every device the callee worker hosts (D3).
- **A grant revoked while the server runs closes the channel within
  seconds, not on the next hop.** Nothing tells the server about a
  revocation (the sqlite CLI writes the db file from another process), so
  the broker re-runs the authorization check for every grant behind an open
  channel on a timer, `--peerChannelAuthRecheckSeconds`, 5 by default. On a
  denial, or when the AuthProvider cannot be reached, it closes the channel
  on both workers; the caller's next hop is brokered again and refused with
  the ordinary authorization error, and calls in flight when the channel
  closes fail with `PEER_GONE`. A revoked module identity can therefore keep
  reaching a device for up to one interval; on the main-thread-routed path
  the revocation applies to the very next hop. Restoring the grant needs no
  restart. `0` turns the re-check off, and an open channel then outlives a
  revocation until its worker restarts. With the file AuthProvider none of
  this can arise, because the auth file is read once at startup. Test:
  `test/auth/19-peer-channel-revocation.js`, against sqlite and its real
  CLI.
- **Module code can see four more error codes:** `PEER_GONE`,
  `PEER_CHANNEL_TIMEOUT`, `PEER_SELF_TARGET`, `PEER_NO_HANDLER`.
- **Billing is identical on both paths**, and per-hop rate limiting is
  enforced on neither; see `docs/cross-cutting-matrix.md`.

An operator who needs per-hop authorization, or revocation with no window
at all, should run with `--no-directPeerChannels`. The benchmark sections
below say how little that costs for most workloads.

## Benchmark: main-thread-routed vs. direct peer channel

Produced by `perf/direct-peer-channels-perf.js --runs 3` on a 2-vCPU VMware guest (Intel Core i7-6600U @ 2.60 GHz, 7.2 GB), Node v24.21.0, at commit `3d9599d`,
module sandbox `audit` (the default). Two purpose-built
fixture modules (`pre-installed-packages/perf-caller-demo`,
`perf-callee-demo`) round-trip a payload of a given size through
`ServiceClient.invoke()`; "hop latency" below is measured server-side
around just that call (excludes HTTP/session overhead on either side of
it), and throughput is measured client-side across the full HTTP round
trip (that overhead is identical in both conditions, so it doesn't distort
the comparison). 150 requests per cell. Each of the three runs is a fresh
process with a fresh server per condition; every cell is the median of the
three runs' values, with the [min–max] range across runs.

Every number below, and every comparative statement about it, is
copy-pasted verbatim from that run of `perf/direct-peer-channels-perf.js`
(which computes the comparison itself — see that file's header comment for
why hand-written summaries are not allowed here anymore: an earlier
version of this section claimed "1.3–7×" and "match or beat throughput on
7 of 9", and both were wrong against the very table they described). A cell
counts as faster or slower only when the two ranges across runs do not
overlap; otherwise it is within noise, whatever the medians say.

| Payload | Concurrency | Main-thread-routed p50 | Main-thread-routed p99 | Main-thread-routed req/s | Direct peer channel p50 | Direct peer channel p99 | Direct peer channel req/s |
|---|---|---|---|---|---|---|---|
| 1KB | 1 | 1.41ms [1.40ms–1.46ms] | 4.40ms [3.80ms–5.11ms] | 169 [168–171] | 1.38ms [1.38ms–1.40ms] | 5.04ms [3.10ms–5.43ms] | 204 [181–204] |
| 1KB | 16 | 9.54ms [8.37ms–12.81ms] | 24.71ms [21.30ms–27.16ms] | 409 [398–413] | 9.50ms [9.06ms–11.58ms] | 28.18ms [20.21ms–39.61ms] | 469 [402–476] |
| 1KB | 64 | 39.22ms [27.60ms–51.69ms] | 68.78ms [50.52ms–77.58ms] | 476 [463–517] | 45.94ms [27.07ms–48.68ms] | 69.99ms [54.91ms–96.15ms] | 620 [498–644] |
| 100KB | 1 | 1.53ms [1.45ms–1.53ms] | 6.98ms [5.27ms–8.20ms] | 202 [193–219] | 1.49ms [1.34ms–1.55ms] | 5.80ms [4.09ms–8.84ms] | 203 [196–223] |
| 100KB | 16 | 10.81ms [10.41ms–11.27ms] | 22.46ms [22.46ms–33.71ms] | 502 [426–575] | 10.22ms [8.97ms–10.26ms] | 25.05ms [17.69ms–30.64ms] | 543 [445–591] |
| 100KB | 64 | 32.24ms [28.08ms–33.54ms] | 43.28ms [42.88ms–53.20ms] | 636 [573–773] | 43.03ms [36.25ms–60.40ms] | 67.28ms [63.97ms–119.76ms] | 704 [543–789] |
| 1MB | 1 | 7.60ms [7.56ms–7.89ms] | 17.07ms [16.20ms–18.10ms] | 93 [91–94] | 5.06ms [5.06ms–5.14ms] | 14.84ms [13.00ms–15.12ms] | 121 [118–122] |
| 1MB | 16 | 77.08ms [61.61ms–80.88ms] | 125.39ms [114.85ms–150.78ms] | 123 [123–138] | 59.11ms [58.92ms–60.11ms] | 115.45ms [110.28ms–140.13ms] | 156 [146–160] |
| 1MB | 64 | 302.64ms [298.51ms–335.13ms] | 361.29ms [360.23ms–373.46ms] | 130 [122–131] | 234.89ms [213.57ms–253.16ms] | 379.78ms [358.01ms–401.81ms] | 190 [178–195] |

*Noise floor: the largest spread of any single configuration across the 3 runs, as (max - min) / median: p50 61% (Main-thread-routed 1KB/c=64); p99 83% (Direct peer channel 100KB/c=64); throughput 35% (Direct peer channel 100KB/c=64).*

Errors: none. Sandbox log: 0 violations, 0 would-be-refused under enforce, 0 restarts, 0 suspensions.

**p50**: direct peer channels are lower than main-thread-routed in 4 of 9 cells, higher in 1 (100KB/c=64 (32.24ms [28.08ms–33.54ms] vs. 43.03ms [36.25ms–60.40ms]), main vs. direct), and within noise in 4; ratio of medians from 0.75× (at 100KB/c=64) to 1.50× (at 1MB/c=1).

**Throughput**: direct peer channels are higher in 4 of 9 cells, lower in 0, and within noise in 5; ratio of medians from 1.00× (at 100KB/c=1) to 1.47× (at 1MB/c=64).

**p99**: direct peer channels are lower in 1 of 9 cells, higher (worse) in 1 (100KB/c=64 (43.28ms [42.88ms–53.20ms] vs. 67.28ms [63.97ms–119.76ms]), main vs. direct), and within noise in 7.

These numbers already include the backpressure fix described below — see
that section for what changed and why.

**Read the noise floor before the medians.** It is the largest spread of any
single configuration across the three runs, printed by the script under the
table. Mid-concurrency cells move the most from run to run, which is why the
summary only calls a difference when the ranges separate. A comparison of two
single runs cannot resolve differences of that size; re-run
`perf/direct-peer-channels-perf.js --runs 3` yourself — it prints its own
fresh summary — before relying on precise numbers for capacity planning.

## Backpressure

*The figures in this section are historical and were not re-measured on
2026-10-26. They were taken on 2026-08-09 (commit `be666df`); the document
did not record the machine at the time. The closest record is the
2026-08-18 re-measurement, on the 2-core reference machine with Node
20.20.2.*

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

Table and summary below are copy-pasted verbatim from a `--runs 3` run of
`perf/peer-channel-serialization-perf.js` on a 2-vCPU VMware guest (Intel Core i7-6600U @ 2.60 GHz, 7.2 GB), Node v24.21.0, at commit `3d9599d` (no countinghouse
server involved, so no sandbox mode), which computes the summary
itself (see that file's header comment: an earlier hand-written "2.7–3.7×"
claim here silently ignored the 1KB row, which only ever showed a much
smaller ratio). A bold cell is the lowest median whose range clears both
others.

| Payload | `JSON.stringify` p50 | Structured clone p50 | Transfer list p50 |
|---|---|---|---|
| 1KB | 0.24ms [0.12ms–0.25ms] | **0.05ms [0.05ms–0.05ms]** | 0.28ms [0.11ms–0.28ms] |
| 100KB | 0.73ms [0.69ms–0.76ms] | **0.24ms [0.24ms–0.26ms]** | 0.86ms [0.85ms–0.93ms] |
| 1MB | 10.88ms [10.78ms–12.40ms] | **3.31ms [3.29ms–3.45ms]** | 11.31ms [10.79ms–11.55ms] |

*Noise floor: the largest spread of any single configuration across the 3 runs is 62% (transfer list at 1KB), as (max - min) / median.*

Lowest median per payload size: 1KB=structuredClone, 100KB=structuredClone, 1MB=structuredClone. Structured clone against `JSON.stringify`: 1KB faster, 100KB faster, 1MB faster. Structured clone is faster than `JSON.stringify` at every size tested, with non-overlapping ranges. Ratio of medians (`JSON.stringify` / structured clone) ranges from 2.97× (at 100KB) to 4.73× (at 1KB).

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

Measured with `--runs 3` on a 2-vCPU VMware guest (Intel Core i7-6600U @ 2.60 GHz, 7.2 GB), Node v24.21.0, at commit `3d9599d`; no countinghouse server is involved, so
no sandbox mode. Cells are the median across the three runs with the
[min–max] range.

| Payload | Hops | Direct peer channel<br>p50 / p99 | MCP stdio subprocess<br>p50 / p99 | localhost HTTP<br>p50 / p99 | Per-hop p50<br>(peer / stdio / http) | Hops/s<br>(peer / stdio / http) | CPU<br>(peer / stdio / http) | Peak RSS<br>(peer / stdio / http) | n |
|---|---|---|---|---|---|---|---|---|---|
| 1KB | 1 | 0.254ms [0.224ms–0.260ms] / 1.093ms [0.862ms–1.401ms] | 0.286ms [0.248ms–0.287ms] / 1.099ms [0.916ms–1.443ms] | 0.746ms [0.659ms–0.785ms] / 2.437ms [2.317ms–3.114ms] | 0.254ms [0.224ms–0.260ms] / 0.286ms [0.248ms–0.287ms] / 0.746ms [0.659ms–0.785ms] | 3702 [3564–4642] / 3247 [3217–3977] / 1160 [1112–1286] | 0.11s [0.10s–0.13s] / 0.17s [0.15s–0.19s] / 0.51s [0.45s–0.53s] | 79MB [78MB–79MB] / 121MB [121MB–121MB] / 133MB [133MB–134MB] | 500 |
| 1KB | 10 | 2.266ms [2.265ms–2.360ms] / 4.285ms [3.499ms–4.465ms] | 2.452ms [0.975ms–2.474ms] / 4.421ms [4.318ms–4.936ms] | 4.965ms [4.910ms–5.783ms] / 14.318ms [12.218ms–15.003ms] | 0.227ms [0.226ms–0.236ms] / 0.245ms [0.098ms–0.247ms] / 0.497ms [0.491ms–0.578ms] | 4731 [4471–4901] / 4722 [4622–7120] / 1942 [1713–1998] | 0.67s [0.65s–0.73s] / 0.82s [0.57s–0.84s] / 2.22s [2.16s–2.52s] | 93MB [92MB–93MB] / 140MB [139MB–140MB] / 155MB [155MB–157MB] | 400 |
| 1KB | 100 | 23.505ms [23.469ms–23.655ms] / 28.486ms [25.865ms–29.164ms] | 25.463ms [25.175ms–25.861ms] / 30.291ms [30.015ms–32.043ms] | 55.754ms [49.625ms–58.954ms] / 81.095ms [72.952ms–84.151ms] | 0.235ms [0.235ms–0.237ms] / 0.255ms [0.252ms–0.259ms] / 0.558ms [0.496ms–0.590ms] | 4600 [4308–4771] / 4437 [4257–4461] / 1909 [1693–2203] | 0.70s [0.67s–0.73s] / 0.90s [0.85s–0.93s] / 2.17s [1.93s–2.50s] | 97MB [97MB–98MB] / 145MB [144MB–145MB] / 158MB [154MB–160MB] | 40 |
| 64KB | 1 | 0.269ms [0.186ms–0.283ms] / 0.982ms [0.933ms–1.333ms] | 0.763ms [0.763ms–0.869ms] / 2.540ms [2.217ms–2.711ms] | 1.565ms [1.552ms–1.565ms] / 3.939ms [3.801ms–4.178ms] | 0.269ms [0.186ms–0.283ms] / 0.763ms [0.763ms–0.869ms] / 1.565ms [1.552ms–1.565ms] | 3407 [3371–4751] / 1104 [990–1137] / 578 [570–583] | 0.12s [0.10s–0.14s] / 0.47s [0.46s–0.55s] / 0.98s [0.96s–0.98s] | 99MB [98MB–100MB] / 152MB [152MB–153MB] / 158MB [157MB–159MB] | 500 |
| 64KB | 10 | 2.785ms [2.750ms–2.854ms] / 7.191ms [7.082ms–13.084ms] | 8.231ms [8.193ms–8.300ms] / 14.479ms [14.009ms–14.839ms] | 15.172ms [13.656ms–15.181ms] / 32.671ms [31.056ms–43.798ms] | 0.278ms [0.275ms–0.285ms] / 0.823ms [0.819ms–0.830ms] / 1.517ms [1.366ms–1.518ms] | 3334 [3284–3388] / 1165 [1156–1192] / 650 [625–706] | 0.26s [0.24s–0.32s] / 0.88s [0.86s–0.89s] / 1.72s [1.56s–1.80s] | 102MB [102MB–102MB] / 154MB [153MB–155MB] / 174MB [172MB–175MB] | 100 |
| 64KB | 100 | 27.744ms [25.743ms–27.770ms] / 34.543ms [33.342ms–38.095ms] | 82.639ms [80.507ms–99.081ms] / 103.503ms [99.872ms–136.046ms] | 137.238ms [134.025ms–138.485ms] / 174.055ms [163.382ms–179.323ms] | 0.277ms [0.257ms–0.278ms] / 0.826ms [0.805ms–0.991ms] / 1.372ms [1.340ms–1.385ms] | 3660 [3469–3733] / 1171 [1001–1199] / 739 [715–745] | 0.49s [0.44s–0.55s] / 1.74s [1.69s–2.20s] / 3.06s [3.01s–3.16s] | 103MB [102MB–106MB] / 159MB [159MB–162MB] / 176MB [176MB–177MB] | 20 |
| 1MB | 1 | 3.299ms [3.234ms–4.090ms] / 6.634ms [5.128ms–6.949ms] | 44.159ms [43.284ms–46.009ms] / 78.641ms [65.748ms–83.981ms] | 16.031ms [15.646ms–16.435ms] / 31.674ms [29.453ms–34.244ms] | 3.299ms [3.234ms–4.090ms] / 44.159ms [43.284ms–46.009ms] / 16.031ms [15.646ms–16.435ms] | 302 [244–304] / 22 [21–22] / 58 [57–60] | 0.66s [0.64s–0.82s] / 9.47s [9.23s–9.97s] / 3.72s [3.64s–3.76s] | 117MB [116MB–118MB] / 309MB [297MB–314MB] / 363MB [349MB–372MB] | 200 |
| 1MB | 10 | 32.888ms [32.300ms–35.767ms] / 37.066ms [35.392ms–51.429ms] | 444.756ms [437.288ms–444.800ms] / 503.175ms [498.497ms–542.324ms] | 171.778ms [168.951ms–176.529ms] / 213.789ms [213.415ms–214.305ms] | 3.289ms [3.230ms–3.577ms] / 44.476ms [43.729ms–44.480ms] / 17.178ms [16.895ms–17.653ms] | 301 [270–311] / 22 [22–23] / 57 [57–59] | 0.65s [0.64s–0.74s] / 9.29s [9.17s–9.31s] / 3.76s [3.68s–3.82s] | 205MB [203MB–217MB] / 369MB [341MB–385MB] / 367MB [346MB–390MB] | 20 |
| 1MB | 100 | 400.062ms [384.664ms–404.653ms] / 429.991ms [416.500ms–430.400ms] | 4391.429ms [4377.082ms–4500.000ms] / 4606.405ms [4575.215ms–6577.966ms] | 1590.522ms [1589.754ms–1592.194ms] / 1775.662ms [1752.674ms–1871.945ms] | 4.001ms [3.847ms–4.047ms] / 43.914ms [43.771ms–45.000ms] / 15.905ms [15.898ms–15.922ms] | 257 [257–264] / 23 [21–23] / 62 [62–62] | 7.72s [7.54s–7.76s] / 91.52s [90.78s–98.18s] / 34.62s [34.28s–34.63s] | 205MB [202MB–217MB] / 390MB [342MB–406MB] / 420MB [415MB–422MB] | 20 |

*Noise floor: the largest spread of any single configuration across the 3 runs is 61% (stdio 1KB/10hop p50), as (max - min) / median.*

**vs. MCP stdio subprocess**: the direct peer channel has a lower p50 in 7 of 9 cells, a higher one in 0, and is within noise in 2 (1KB/1hop: 0.254ms [0.224ms–0.260ms] vs. 0.286ms [0.248ms–0.287ms] per hop, 1KB/10hop: 0.227ms [0.226ms–0.236ms] vs. 0.245ms [0.098ms–0.247ms] per hop); ratio of medians from 1.08× (at 1KB/10hop) to 13.52× (at 1MB/10hop).

**vs. localhost HTTP**: the direct peer channel has a lower p50 in 9 of 9 cells, a higher one in 0, and is within noise in 0; ratio of medians from 2.19× (at 1KB/10hop) to 5.82× (at 64KB/1hop).

**Scale of the difference**: the largest per-hop saving measured here is 13.889ms [13.665ms–14.076ms] across the 3 runs (best case for the direct channel, across every cell; at 1MB/10hop). A tool whose own execution takes more than ~139ms [137ms–141ms] per call would see even that saving as under 10% of the hop, and proportionally less the slower it gets. This benchmark measures transport, not tools.

### What this does and does not justify

The summary above gives the cell counts. The margin grows with payload size
-- which is what you would expect, since the direct peer channel is the only one
of the three that does not serialize the payload to a byte stream and push it
through a kernel boundary. At 1KB the gap against stdio is within noise at
1 and 10 hops, the two cells the summary names; at 1MB it is not.

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

### Replaced on 2026-10-26

The tables and summaries below were the published figures until 2026-10-26.
They were replaced because every script now runs three independent times and
reports ranges, and because the code (the module sandbox, default `audit`),
the Node version and the machine all changed since they were taken. They are
kept, unedited, so that older citations can be checked.

#### Cross-worker micro-benchmark, 2026-08-18, Node 20.20.2, 2-core reference machine, single run

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

#### Message serialization, 2026-08-18, Node 20.20.2, 2-core reference machine, single run

| Payload | `JSON.stringify` p50 | Structured clone p50 | Transfer list p50 |
|---|---|---|---|
| 1KB | 0.31ms | **0.20ms** | 0.29ms |
| 100KB | 0.92ms | **0.31ms** | 1.19ms |
| 1MB | 22.50ms | **8.11ms** | 24.82ms |

Fastest strategy per payload size: 1KB=structuredClone, 100KB=structuredClone, 1MB=structuredClone. Structured clone wins at every size tested. Structured clone vs. `JSON.stringify` ratio ranges from 1.49× (at 1KB) to 3.01× (at 100KB).

#### Transport overhead, 2026-08-18, Node 20.20.2, 2-core reference machine, single run

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

#### log-triage, 2026-10-26: withdrawn

The 2026-10-26 log-triage run
([`perf/results/2026-10-26/log-triage.md`](https://github.com/mchen6/countinghouse/blob/master/perf/results/2026-10-26/log-triage.md))
measured "runtime adds" against an in-process baseline that ran the handlers
one file after another, while the composite runs each file's chain
concurrently; on two CPUs that baseline ran high and the runtime's share came
out low. Its log-triage figures were replaced on 2026-10-27 by a run with a
baseline scheduled like the composite
([`perf/results/2026-10-27/`](https://github.com/mchen6/countinghouse/blob/master/perf/results/2026-10-27/README.md)).
The raw output stays in the repository; its tables are not repeated here.

#### log-triage, 2026-10-07, one vCPU, Node 24.21.0, countinghouse 7.1.0 (`cb68765`)

From `docs/log-triage-performance.md` as it stood before 2026-10-26: one run
of `perf/log-triage-perf.js --reps 25`, each cell the median of 25 calls
(min–max of those calls). The launch posts under `docs/` quoted these.

#### Latency follows the number of files, linearly

400 lines per file. Times in ms, median (min–max).

| files | hops | direct | routed | in-process |
|---|---|---|---|---|
| 1 | 4 | 24.4 (14.0–45.6) | 19.0 (15.3–38.8) | 6.0 |
| 2 | 6 | 27.8 (18.5–153) | 34.3 (19.3–103) | 9.8 |
| 4 | 10 | 27.8 (22.6–44.6) | 38.3 (25.8–54.7) | 15.7 |
| 8 | 18 | 48.0 (40.1–114) | 63.2 (47.8–109) | 30.7 |
| 16 | 34 | 78.9 (64.7–107) | 92.7 (70.7–160) | 59.0 |
| 32 | 66 | 157 (137–203) | 178 (150–221) | 97.1 |

From 1 file to 32, the composite goes from about 24 ms to about 157 ms on the
direct path: roughly 4.3 ms for each further file, which is two more hops and
one more file's work. On the routed path it is roughly 5.1 ms per file. The
bill grows the same way, by 2 per file, so latency and cost move together and
`maxFiles` bounds both.

#### With larger files, the work dominates

8 files, 18 hops. Times in ms, median (min–max).

| lines per file | direct | routed | in-process | runtime adds, direct | runtime adds, routed |
|---|---|---|---|---|---|
| 100 | 21.9 (17.0–31.6) | 24.9 (18.7–75.5) | 6.5 | 15.4 | 18.4 |
| 400 | 44.0 (33.5–56.8) | 52.6 (39.7–84.3) | 22.5 | 21.5 | 30.0 |
| 1,600 | 125 (110–184) | 142 (128–169) | 88.6 | 36.3 | 53.4 |
| 6,400 | 437 (393–501) | 514 (437–577) | 357 | 79.7 | 157 |

At 100 lines per file the runtime is most of the call: 15 of 22 ms. At 6,400
lines per file (about 4 MB of logs in total) the handlers' own work is 357 of
437 ms, about 82%, and the runtime's share has fallen to 18%.

What the runtime adds is not constant. It grows with payload, from about 15
ms to about 80 ms on the direct path, because every `read` result and every
`redact` input and output is a batch of lines crossing a worker boundary.

#### Direct against routed

The direct path is the faster one wherever the difference is larger than the
noise:

| case | direct | routed | direct is lower by |
|---|---|---|---|
| 8 files, 400 lines | 48.0 | 63.2 | 24% |
| 32 files, 400 lines | 157 | 178 | 12% |
| 8 files, 6,400 lines | 437 | 514 | 15% |
| 1 file, 400 lines | 24.4 | 19.0 | within noise |

The gap is clearest in what the runtime adds with large payloads: 80 ms
direct against 157 ms routed at 6,400 lines per file. That fits
[`direct-peer-channels.md`](direct-peer-channels.md), which says the direct
path matters most for composition-heavy calls with large payloads, and it is
the same trade-off described there: the direct path checks authorization when
a channel opens, not on every hop.

#### One composite call against the same hops made by the client

8 files of 400 lines, 18 tool calls for the client. Times in ms, median
(min–max); bytes are JSON request and response bodies.

| | tool calls | latency, direct server | latency, routed server | bytes sent | bytes received |
|---|---|---|---|---|---|
| composite | 1 | 45.6 (34.7–73.4) | 50.6 (35.7–73.1) | 167 | 14,436 |
| client-orchestrated | 18 | 109 (86.1–226) | 96.7 (78.6–167) | 549,495 | 1,119,438 |

The composite is about twice as fast, and it moves about 14.6 KB where the
client-orchestrated version moves about 1.67 MB, roughly 114 times as much.
The difference is the raw lines: the client has to receive every file from
`read` and send it back to `redact`, then send all the masked lines to
`cluster`.

Three things this comparison does not show. The client here is on the same
machine as the server, so network latency, which would widen the gap, is
absent. The client-orchestrated calls are sequential, as a model issuing tool
calls would make them. And the hop path makes no difference to the client
rows, since a client calling leaf tools directly makes no inner hops; the two
latency columns differ only by noise.
