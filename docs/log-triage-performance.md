# log-triage performance

How the [`examples/log-triage`](../examples/log-triage/README.md) composite
behaves as its input grows, what the runtime adds on top of the work itself,
and what the same hops cost when a client makes them one by one.

Every number here comes from one run of `perf/log-triage-perf.js` on
2026-10-07, against the server as released in 7.1.0 (`cb68765`). Reproduce
it with:

```sh
node perf/log-triage-perf.js --reps 25
```

## Read this first

- **The machine is small.** One virtual CPU (Intel Core i7-6600U, 2.60 GHz) in
  a VMware guest, 7.2 GB, Node v24.21.0, Linux 7.0. The client, the server's
  main thread, four module workers and Redis all share that one core. The
  absolute times are small-machine times; the shapes and ratios are the
  result.
- **Nothing here measures parallelism.** With one core, the composite's
  concurrent read-then-redact chains cannot run at the same time, so this run
  cannot say what concurrency buys. That needs a multi-core machine and is
  not claimed below.
- **One caller at a time.** Calls are made back to back, never overlapping.
  Throughput under concurrent callers was not measured.
- **Noise is around 30%.** Each cell is the median of 25 calls after 5
  warm-ups, shown with its min and max. The same in-process baseline
  (8 files of 400 lines) was measured twice in this run and came out at 30.7
  ms and 22.5 ms. Treat differences smaller than that as no difference.
- **Metering is on.** The servers run without `--debug`, with
  `--mcpToolCallCost 1`, so every hop pays its Redis round trip.

## What was measured

- **composite**: one `tools/call` to `log_triage_triageservice_triage`, timed
  at the client. For `N` files it makes `2N + 2` inner hops.
- **in-process**: the same four handlers called as plain functions in one Node
  process, one file after another. No runtime, no workers, no HTTP, no
  metering. This is the cost of the work itself.
- **runtime adds**: composite minus in-process. It covers HTTP, the outer
  call, hops between workers, schema validation on every hop, and metering.
- **client-orchestrated**: the same `2N + 2` tool calls made one at a time by
  an MCP client that holds the three leaf tools.

Both hop paths were measured: **direct** peer channels, the default since
7.1.0, and **routed** through the main thread (`--no-directPeerChannels`).

## Latency follows the number of files, linearly

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

## With larger files, the work dominates

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

## What the runtime adds per call and per hop

Two parts can be read off the first table (composite minus in-process, at 400
lines per file):

- **A fixed part of roughly 12 to 18 ms per call** on this machine, visible at
  1 to 4 files, where the direct path adds 12 to 18 ms regardless of the hop
  count. That is HTTP, the outer call's authorization and metering, and the
  response.
- **A per-hop part of roughly 1 ms.** At 32 files the direct path adds 60 ms
  over 66 hops, 0.9 ms per hop; the routed path adds 81 ms, 1.2 ms per hop.
  With 6,400-line files it rises to 4.4 ms per hop direct and 8.7 ms routed.

These are differences of two noisy medians, so the per-hop figures are
indicative, not precise.

## Direct against routed

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

## One composite call against the same hops made by the client

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

## Where the work itself goes

In-process, no runtime. Times in ms, from the median run of each case.

| files | lines per file | total | list | read | redact | cluster |
|---|---|---|---|---|---|---|
| 1 | 400 | 6.0 | 2.2 | 0.4 | 2.6 | 0.8 |
| 8 | 400 | 30.7 | 2.6 | 5.7 | 18.8 | 3.6 |
| 32 | 400 | 97.1 | 3.4 | 9.9 | 60.4 | 23.0 |
| 8 | 100 | 6.5 | 0.3 | 1.6 | 3.5 | 1.1 |
| 8 | 1,600 | 88.6 | 0.5 | 9.2 | 60.2 | 18.5 |
| 8 | 6,400 | 357 | 0.4 | 48.2 | 235 | 72.3 |

Masking is the expensive step: `redact` is 53 to 68% of the handlers' time
in every case with 8 or more files. It is five regular expressions applied
to every line. `cluster` is next at 12 to 24%, and reading the files is 10
to 25%.

This matters for anyone sizing a deployment. `pii-redact` runs in one worker,
so on a multi-core machine the masking of one call's files would still run
one file after another, and it is where a second call would queue. The
example's README says the same thing in words; this is the measurement behind
it.

## What an operator can take from this

- **Cost and latency are both linear in `maxFiles`**, so the cap that bounds
  the bill bounds the wait as well.
- **For small inputs the runtime is most of the latency; for large inputs the
  work is.** On this machine the two are about equal at 400 lines per file
  with 8 files (21.5 ms added against 22.5 ms of work).
- **Keeping the hops inside the runtime halves the latency and cuts wire
  traffic by two orders of magnitude** compared with a client making the same
  calls, before any network delay is counted.
- **The direct path is worth having for this workload**, by 12 to 24% where
  it is measurable, more as payloads grow.

## Not measured

- Concurrent callers, throughput and tail latency under load.
- Any benefit from running the per-file chains concurrently (needs more than
  one core).
- Memory use.
- A network between client and server.
- The CouchDB and sqlite AuthProviders; these runs use the file provider.
