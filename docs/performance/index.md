# One call instead of eighteen: what a composite MCP tool costs

*[countinghouse](https://github.com/mchen6/countinghouse) — a runtime where MCP tools call other MCP tools. Apache-2.0. A follow-up to [We built MCP's tool architecture in 2015 — by accident](https://mchen6.github.io/countinghouse/), but it stands on its own.*

The first post argued that MCP tools should be able to call each other inside one runtime, and showed what a single hop costs at the transport level. This one measures something closer to what you'd actually run: a composite tool doing real work end to end, against the same work orchestrated by a client one tool call at a time.

Every number here comes from `perf/log-triage-perf.js` and `perf/direct-peer-channels-perf.js`, run against countinghouse 7.1.0. Every comparison sentence in the underlying documents is printed by the script that measured it.

## The headline, and its caveats

[`examples/log-triage`](https://github.com/mchen6/countinghouse/tree/master/examples/log-triage) triages a directory of logs. For N files it lists the directory, reads and redacts each file, and clusters the warnings and errors: 2N + 2 inner hops, published to the outside as a single tool. With 8 files of 400 lines:

| | tool calls | latency (median) | bytes on the wire |
|---|---|---|---|
| one composite call | 1 | 45.6 ms | 14.6 KB |
| a client making the same hops | 18 | 109 ms | 1.67 MB |

About twice as fast, and about 114 times less data crossing the client–server boundary. The difference is the raw log lines. A client orchestrating the chain has to receive every file from `read` and send it back to `redact`, then send every masked line on to `cluster`. The composite keeps all of that inside the runtime and returns counts plus a bounded set of clusters.

Three things this table does not show, and each of them would flatter it if I let them. The client ran on the same machine as the server, so there is no network between them; real network latency would widen the gap only on the client-orchestrated side. The 18 client calls are issued back to back by a script, not by a model, so there is no inference time between them; a model deciding each next call would add seconds, not milliseconds. And bytes on the wire are not tokens in a context window. I'm reporting what I measured, not what it would cost you in any particular model.

## The machine, because it matters

One virtual CPU (an Intel i7-6600U at 2.6 GHz) in a VMware guest, running Node 24.21. The client, the server's main thread, four module workers and Redis all share that one core. Each cell is the median of 25 calls after 5 warm-ups, and the noise is large. The same in-process baseline, measured twice in the same run, came out at 30.7 ms and 22.5 ms. The configuration in the headline table (8 files, 400 lines, direct path) shows up as 44.0, 45.6 and 48.0 ms in three different tables of that one run. **Treat any difference under about 30% as no difference.** The absolute times are small-machine times. The shapes and the ratios are the result.

A single core also means this run says nothing about parallelism. The composite runs its per-file chains concurrently, but on one core they cannot actually overlap. Measuring that needs a multi-core machine, and I'm not claiming it.

## Where the time goes

Call the same four handlers as plain functions in one process (no runtime, no workers, no HTTP, no metering) and subtract that from the composite's time. What's left is what the runtime adds, and it comes in two parts.

The first is fixed: roughly 12 to 18 ms per call, visible at 1 to 4 files, where it barely moves as the hop count changes. That is HTTP, the outer call's authorization and metering, and the response.

The second is per hop: roughly 1 ms at 400 lines per file (0.9 ms on the direct path, 1.2 ms when routed through the main thread). It grows with payload. At 6,400 lines per file it is 4.4 ms direct and 8.7 ms routed, because every `read` result and every `redact` input and output is a batch of lines crossing a worker boundary.

Whether any of that matters depends entirely on how much work each hop does:

| lines per file (8 files) | total, direct | handlers alone | runtime's share |
|---|---|---|---|
| 100 | 21.9 ms | 6.5 ms | ~70% |
| 400 | 44.0 ms | 22.5 ms | ~49% |
| 1,600 | 125 ms | 88.6 ms | ~29% |
| 6,400 | 437 ms | 357 ms | ~18% |

For small inputs, **most of what you pay for is the runtime, not the work.** I'd rather you read that here than find it out later. At 400 lines per file the two are roughly even. By 6,400 the handlers are 82% of the call. If your tools are thin wrappers around fast in-memory functions, the fixed per-call overhead dominates. If they do real work, it fades.

## Latency and the bill move together

From 1 file to 32, the composite goes from about 24 ms to 157 ms on the direct path, roughly 4.3 ms per additional file, which is two more hops plus one more file's work. The bill grows the same way: every inner hop is metered, so each additional file adds two charges. The tool takes a `maxFiles` argument, and because cost and latency are both linear in the number of files, that one argument caps both. The caller knows the worst-case bill and the worst-case wait before making the call.

That is what per-hop metering is for here. The cost follows the data, and the caller sets the ceiling in advance.

## The direct path, and what it trades

Since 7.1.0, calls between module workers go over a direct `MessageChannel` that the main thread brokers once, instead of being routed through the main thread on every hop. On this workload the direct path is faster wherever the difference clears the noise:

| case | direct | routed | |
|---|---|---|---|
| 8 files × 400 lines | 48.0 ms | 63.2 ms | 24% lower |
| 32 files × 400 lines | 157 ms | 178 ms | 12% lower |
| 8 files × 6,400 lines | 437 ms | 514 ms | 15% lower |
| 1 file × 400 lines | 24.4 ms | 19.0 ms | within noise |

In isolation, with a fixture that does nothing but round-trip a payload, the direct path wins throughput in all nine payload/concurrency cells and median latency in eight. But the margin is 1.00× to 1.76×, and its p99 is worse in four of the nine ([full nine-cell table](https://github.com/mchen6/countinghouse/blob/master/docs/direct-peer-channels.md#benchmark-main-thread-routed-vs-direct-peer-channel)). That's a modest result, and it's the one I'm reporting. (The version I'm not reporting is below.)

The trade isn't only about speed. On the routed path, every hop passes the authorization check. On the direct path the check runs once, when the channel opens, and a revoked grant reaches an open channel through a timed re-check: within 5 seconds by default (`--peerChannelAuthRecheckSeconds`), not on the next hop. The routed path is still there, behind `--no-directPeerChannels`, for anyone who needs a revocation to apply on the very next call.

## Against a process boundary

The first post covered this, so briefly. Per hop, an in-process call costs about the same as a bare stdio JSON-RPC echo at 1 KB (0.34 ms against 0.36 ms) and far less at 1 MB (9.1 ms against 86 ms over stdio and 39 ms over localhost HTTP). The benchmark computes its own break-even: the largest per-hop saving it measured was 31 ms, so a tool that spends more than about 310 ms per call would see even that as under 10%. [The full table and its caveats.](https://github.com/mchen6/countinghouse/blob/master/docs/direct-peer-channels.md#benchmark-transport-overhead-vs-other-tool-to-tool-mechanisms)

The log-triage comparison above is the more useful number, because it measures a whole runtime doing real work rather than an echo.

## Three things that went wrong

**Removing a bottleneck made it slower.** The main-thread hop had been a known bottleneck for years; building the direct path was overdue. The first direct-channel benchmark, at 1 MB under 64-way concurrency, measured 842 ms against the routed path's 360 ms. The main-thread hop had been a bottleneck, and that bottleneck had been quietly throttling how much work piled up at the callee's single-threaded event loop. Removing it removed the throttle. My first fix capped concurrency on the callee side and did nothing: structured-clone cost is paid when a message is sent, so an uncapped caller had already paid for every concurrent call before the callee's cap could matter. The fix that worked queues on both ends. The default cap of 16 was chosen by measuring 4, 8, 16 and 32 at the cell that regressed. It is still a call count rather than a byte budget, which is the obvious next improvement and isn't built.

**A ten-year-old comment had gone stale.** The worker message code carried a note citing a 2016 post that measured `JSON.stringify` beating structured clone for passing objects between threads. On the current Node it's the opposite at every payload size tested: structured clone is faster by 1.49× at 1 KB and 3.01× at 100 KB. The note was likely right when it was written in 2016; the engine changed underneath it. The code already did what is now the faster thing, and re-measuring is how I found out the reason had expired.

**A re-run shrank my own claim.** An earlier run of the direct-versus-routed fixture reported median wins of 1.16× to 8.38× in all nine cells. Re-run on an idle machine, it came back at 1.00× to 1.76×, in eight of nine, with p99 worse in four. Those are the numbers above. Before that, a hand-written summary in the same document had claimed "1.3–7×" and didn't match the table printed right next to it. Every comparison sentence in the performance documents is now generated by the script that took the measurement; none of them is typed by hand.

## What isn't measured

Concurrent callers, and throughput or tail latency under load. Any benefit from running per-file chains in parallel, which needs more than one core. A network between client and server. The sqlite and CouchDB auth backends; these runs used the file provider. And the module sandbox now in development (worker lockdown, resource limits and a per-worker message-rate limit), which landed after these numbers were taken and will be measured before it ships.

## The honest summary

If your tools do a lot of work per call, the runtime's overhead is a rounding error, and the case for composition is about where the data goes, not about speed. If your tools are thin and your payloads are small, the runtime is most of the call. The shape where composition wins on time is the middle and up: many hops, payloads that aren't trivial, and work that's real but not slow. There, on this machine, keeping the hops inside one runtime halved the latency and cut the traffic on the wire by two orders of magnitude, before any network or model time is counted.

Reproduce it with `node perf/log-triage-perf.js --reps 25`. Your machine will give different absolute numbers and, I expect, the same shapes. If it doesn't, I'd like to hear about it.
