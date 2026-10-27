# One call instead of eighteen: what a composite MCP tool costs

*[countinghouse](https://github.com/mchen6/countinghouse) — a runtime where MCP tools call other MCP tools. Apache-2.0. A follow-up to [We built MCP's tool architecture in 2015 — by accident](https://mchen6.github.io/countinghouse/), but it stands on its own.*

*Updated 2026-10-26: all numbers re-measured on a 2-vCPU machine at commit 3d9599d; the original figures are in [docs/direct-peer-channels.md#retired-numbers](https://github.com/mchen6/countinghouse/blob/master/docs/direct-peer-channels.md#retired-numbers). Updated again 2026-10-27: the log-triage figures re-measured at commit 0ec55b8, with an in-process baseline scheduled the way the composite is; that withdraws a correction the 2026-10-26 update had made (see "Where the time goes").*

The first post argued that MCP tools should be able to call each other inside one runtime, and showed what a single hop costs at the transport level. This one measures something closer to what you'd actually run: a composite tool doing real work end to end, against the same work orchestrated by a client one tool call at a time.

Every number here comes from `perf/log-triage-perf.js`, `perf/direct-peer-channels-perf.js`, `perf/cross-process-comparison.js` and `perf/peer-channel-serialization-perf.js`, run at commit `3d9599d` (the log-triage figures at `0ec55b8`) with the module sandbox in its default mode (`audit`), three independent runs each. A cell is the median of the three runs, and the range in brackets is the lowest and highest of them. Every comparison sentence in the underlying documents is printed by the script that measured it, and the raw output is in the repo ([2026-10-26](https://github.com/mchen6/countinghouse/blob/master/perf/results/2026-10-26/README.md), [2026-10-27](https://github.com/mchen6/countinghouse/blob/master/perf/results/2026-10-27/README.md)).

## The headline, and its caveats

[`examples/log-triage`](https://github.com/mchen6/countinghouse/tree/master/examples/log-triage) triages a directory of logs. For N files it lists the directory, reads and redacts each file, and clusters the warnings and errors: 2N + 2 inner hops, published to the outside as a single tool. With 8 files of 400 lines:

| | tool calls | latency (ms) | bytes on the wire |
|---|---|---|---|
| one composite call | 1 | 35.7 [33.0–37.6] | 14.6 KB |
| a client making the same hops | 18 | 95.7 [95.1–108] | 1.67 MB |

The client takes 2.90× [2.53×–3.03×] as long, per run, and moves 114 times as much data across the client–server boundary. The difference is the raw log lines. A client orchestrating the chain has to receive every file from `read` and send it back to `redact`, then send every masked line on to `cluster`. The composite keeps all of that inside the runtime and returns counts plus a bounded set of clusters.

Three things this table does not show, and each of them would flatter it if I let them. The client ran on the same machine as the server, so there is no network between them; real network latency would widen the gap only on the client-orchestrated side. The 18 client calls are issued back to back by a script, not by a model, so there is no inference time between them; a model deciding each next call would add seconds, not milliseconds. And bytes on the wire are not tokens in a context window. I'm reporting what I measured, not what it would cost you in any particular model.

## The machine, because it matters

Two virtual CPUs (an Intel i7-6600U at 2.6 GHz) in a VMware guest, running Node 24.21. The client, the server's main thread, four module workers and Redis all share those two cores. Within each run, each cell is the median of 25 calls after 5 warm-ups, and each of the three runs starts from a fresh process with fresh servers. The noise is still large. The same in-process baseline cell, measured twice per run, came out at 21.7 [20.9–21.9] ms and 21.5 [21.2–22.2] ms. The call in the headline table (8 of 32 files, 400 lines, direct path) shows up as 38.4 [37.8–38.8] and 35.7 [33.0–37.6] ms in two tables of the same runs, measured at different points in the run, after the server had served 90 and 300 calls. **A difference counts only when the two ranges don't overlap.** The absolute times are small-machine times. The shapes and the ratios are the result.

Two cores shared by all of those processes is not a parallelism test either. The composite runs its per-file chains concurrently, but this run cannot separate what that buys from everything else competing for the same cores, and I'm not claiming it.

## Where the time goes

Call the same four handlers as plain functions in one process (no runtime, no workers, no HTTP, no metering), with the per-file chains concurrent as the composite runs them, and subtract that from the composite's time. What's left is what the runtime adds, and it comes in two parts.

The first is fixed, visible at 1 to 4 files: per run, the smallest of those is 11.9 [10.9–13.1] ms and the largest 15.2 [13.6–15.9] ms. That is HTTP, the outer call's authorization and metering, and the response.

The second is per hop: 0.48 [0.46–0.54] ms at 400 lines per file on the direct path, and 0.53 [0.51–0.57] ms when routed through the main thread. It grows with payload. At 6,400 lines per file it is 3.69 [3.00–5.08] ms direct and 3.72 [3.63–3.96] ms routed, because every `read` result and every `redact` input and output is a batch of lines crossing a worker boundary.

Whether any of that matters depends on how much work each hop does:

| lines per file (8 files) | total, direct (ms) | handlers alone (ms) | runtime's share |
|---|---|---|---|
| 100 | 19.1 [18.6–20.0] | 6.59 [6.47–6.64] | 65% [65%–68%] |
| 400 | 32.1 [31.5–33.0] | 17.6 [16.5–18.1] | 45% [44%–49%] |
| 1,600 | 81.8 [81.5–83.6] | 61.8 [61.6–62.2] | 24% [24%–26%] |
| 6,400 | 311 [299–336] | 245 [244–245] | 21% [18%–27%] |

For small inputs, **most of what you pay for is the runtime, not the work.** That was true on one vCPU and it is true on two: at 100 lines per file the runtime's share is 65% [65%–68%]. I'd rather you read that here than find it out later. The 2026-10-26 update of this post said the opposite, that the work was most of the call at every size; that came from an in-process baseline that read the files one after another while the composite reads them concurrently, which on two CPUs made the baseline run high. It has been withdrawn. By 6,400 lines per file the runtime's share is 21% [18%–27%]. If your tools are thin wrappers around fast in-memory functions, the fixed per-call overhead dominates. If they do real work, it fades.

## Latency and the bill move together

From 1 file to 32, the composite goes from 19.9 [18.6–21.7] ms to 98.5 [97.4–102] ms on the direct path, 2.54 [2.54–2.60] ms for each further file, which is two more hops plus one more file's work. The bill grows the same way: every inner hop is metered, so each additional file adds two charges. The tool takes a `maxFiles` argument, and because cost and latency are both linear in the number of files, that one argument caps both. The caller knows the worst-case bill and the worst-case wait before making the call.

That is what per-hop metering is for here. The cost follows the data, and the caller sets the ceiling in advance.

## The direct path, and what it trades

Since 7.1.0, calls between module workers go over a direct `MessageChannel` that the main thread brokers once, instead of being routed through the main thread on every hop. On this workload the direct path is lower in 4 of 10 cases by 5% to 17% of the routed median; routed is lower in none, and the other six are within noise. Four of them:

| case | direct (ms) | routed (ms) | |
|---|---|---|---|
| 8 files × 400 lines | 38.4 [37.8–38.8] | 40.6 [39.2–44.5] | 5% lower |
| 8 files × 100 lines | 19.1 [18.6–20.0] | 23.1 [20.7–24.6] | 17% lower |
| 8 files × 1,600 lines | 81.8 [81.5–83.6] | 88.3 [85.6–89.2] | 7% lower |
| 32 files × 400 lines | 98.5 [97.4–102] | 102 [101–104] | within noise |

In isolation, with a fixture that does nothing but round-trip a payload, the direct path's throughput is higher in 4 of the nine payload/concurrency cells, lower in none, and within noise in 5. Its median latency is lower in 4, higher in 1 (100KB at concurrency 64), and within noise in 4; the ratio of medians runs from 0.75× to 1.50×. Its p99 is higher in 1 of the nine ([full nine-cell table](https://github.com/mchen6/countinghouse/blob/master/docs/direct-peer-channels.md#benchmark-main-thread-routed-vs-direct-peer-channel)). That's a modest result, and it's the one I'm reporting. (The version I'm not reporting is below.)

The trade isn't only about speed. On the routed path, every hop passes the authorization check. On the direct path the check runs once, when the channel opens, and a revoked grant reaches an open channel through a timed re-check: within 5 seconds by default (`--peerChannelAuthRecheckSeconds`), not on the next hop. The routed path is still there, behind `--no-directPeerChannels`, for anyone who needs a revocation to apply on the very next call.

## Against a process boundary

The first post covered this, so briefly. Per hop, an in-process call costs about the same as a bare stdio JSON-RPC echo at 1 KB (0.254 ms against 0.286 ms, within noise) and far less at 1 MB (3.299 ms against 44.159 ms over stdio and 16.031 ms over localhost HTTP). The benchmark computes its own break-even: the largest per-hop saving it measured was 13.889 ms [13.665ms–14.076ms], so a tool that spends more than about 139 ms per call would see even that as under 10%. [The full table and its caveats.](https://github.com/mchen6/countinghouse/blob/master/docs/direct-peer-channels.md#benchmark-transport-overhead-vs-other-tool-to-tool-mechanisms)

The log-triage comparison above is the more useful number, because it measures a whole runtime doing real work rather than an echo.

## Three things that went wrong

**Removing a bottleneck made it slower.** The main-thread hop had been a known bottleneck for years; building the direct path was overdue. The first direct-channel benchmark, at 1 MB under 64-way concurrency, measured 842 ms against the routed path's 360 ms. The main-thread hop had been a bottleneck, and that bottleneck had been quietly throttling how much work piled up at the callee's single-threaded event loop. Removing it removed the throttle. My first fix capped concurrency on the callee side and did nothing: structured-clone cost is paid when a message is sent, so an uncapped caller had already paid for every concurrent call before the callee's cap could matter. The fix that worked queues on both ends. The default cap of 16 was chosen by measuring 4, 8, 16 and 32 at the cell that regressed. It is still a call count rather than a byte budget, which is the obvious next improvement and isn't built.

**A ten-year-old comment had gone stale.** The worker message code carried a note citing a 2016 post that measured `JSON.stringify` beating structured clone for passing objects between threads. On the current Node it's the opposite at every payload size tested: structured clone is faster by 2.97× to 4.73×. The note was likely right when it was written in 2016; the engine changed underneath it. The code already did what is now the faster thing, and re-measuring is how I found out the reason had expired.

**A re-run shrank my own claim.** An earlier run of the direct-versus-routed fixture reported median wins of 1.16× to 8.38× in all nine cells. Re-run on an idle machine, it came back at 1.00× to 1.76×, in eight of nine, with p99 worse in four. Those were the numbers in the first version of this post; three runs with ranges have since shrunk them again. Before that, a hand-written summary in the same document had claimed "1.3–7×" and didn't match the table printed right next to it. Every comparison sentence in the performance documents is now generated by the script that took the measurement; none of them is typed by hand.

## What isn't measured

Concurrent callers, and throughput or tail latency under load. Any benefit from running per-file chains in parallel, which two shared cores cannot isolate. A network between client and server. The sqlite and CouchDB auth backends; these runs used the file provider.

The module sandbox (worker lockdown, resource limits and a per-worker message-rate limit) is now measured, in a separate 2026-10-26 run that measures only the headline call (`--matrix headline`): each server is fresh and serves 5 warm-up calls before the 25 measured ones, where the headline table above measures the same call after its server has already served 300. Those absolute times are not comparable with the table above; the comparison between sandbox modes, all measured the same way in that run, is. With metering on, the headline call took 45.2 [43.8–48.1] ms with the sandbox off, 46.4 [45.8–48.4] ms under `audit` (+3%, within noise) and 47.3 [46.9–50.8] ms under `enforce` (+5%, within noise). On the micro-benchmark, no cell's median latency under `audit` was more than 10% slower than with the sandbox off with non-overlapping ranges. One cell's throughput was, once (1MB at concurrency 16, +11%); a five-run recheck of that cell came back at +7%, within noise.

## The honest summary

If your tools do a lot of work per call, the runtime's overhead is a rounding error, and the case for composition is about where the data goes, not about speed. If your tools are thin and your payloads are small, the runtime is most of the call. The shape where composition wins on time is the middle and up: many hops, payloads that aren't trivial, and work that's real but not slow. There, on this machine, the client making the same hops took 2.90× as long and moved 114 times the bytes, before any network or model time is counted.

Reproduce it with `node perf/log-triage-perf.js --reps 25 --runs 3`. Your machine will give different absolute numbers and, I expect, the same shapes. If it doesn't, I'd like to hear about it.
