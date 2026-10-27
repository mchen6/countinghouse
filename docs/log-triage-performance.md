# log-triage performance

How the [`examples/log-triage`](../examples/log-triage/README.md) composite
behaves as its input grows, what the runtime adds on top of the work itself,
and what the same hops cost when a client makes them one by one.

[Write-up: One call instead of eighteen — what a composite MCP tool costs](https://mchen6.github.io/countinghouse/performance/)

Every number and every comparison here comes from one invocation of
`perf/log-triage-perf.js` on 2026-10-27, at commit `0ec55b8`, with the module
sandbox in its default mode (`audit`), and is pasted from its output
unchanged. Raw output:
[`perf/results/2026-10-27/log-triage.md`](https://github.com/mchen6/countinghouse/blob/master/perf/results/2026-10-27/log-triage.md);
the tables here are that run rendered again from its saved results at three
significant figures
([`rendered/log-triage.md`](https://github.com/mchen6/countinghouse/blob/master/perf/results/2026-10-27/rendered/log-triage.md)),
with every verdict unchanged.

*A 2026-10-26 version of this document reported that the handlers' own work
was most of the call at every input size. That came from an in-process
baseline that read the files one after another while the composite reads them
concurrently; on two CPUs that baseline ran high. The baseline is now
scheduled like the composite, and that conclusion is withdrawn: the runtime is
most of the call for small inputs, as it was on one vCPU. The check that found
it is in
[`perf/results/2026-10-27/`](https://github.com/mchen6/countinghouse/blob/master/perf/results/2026-10-27/README.md).*
Reproduce it with:

```sh
node perf/log-triage-perf.js --reps 25 --runs 3
```

## Read this first

- **The machine is small.** Two virtual CPUs (Intel Core i7-6600U, 2.60 GHz)
  in a VMware guest, 7.2 GB, Node v24.21.0, Linux 7.0. The client, the
  server's main thread, four module workers and Redis all share those two
  cores. The absolute times are small-machine times; the shapes and ratios
  are the result.
- **Nothing here measures parallelism.** The composite's concurrent
  read-then-redact chains compete for the same two cores as everything else
  in the list above, so this run cannot say what concurrency buys. It is not
  claimed below.
- **One caller at a time.** Calls are made back to back, never overlapping.
  Throughput under concurrent callers was not measured.
- **Three runs, and ranges.** Each run is a fresh process with fresh servers.
  Within a run each cell is the median of 25 calls after 5 warm-ups; the
  tables show the median of the three runs' medians, with the [min–max] range
  of those medians. One side counts as faster only when the two ranges do not
  overlap. Each table's noise floor, the largest spread of any configuration
  across the runs, is printed under it.
- **Metering is on.** The servers run without `--debug`, with
  `--mcpToolCallCost 1`, so every hop pays its Redis round trip.

## What was measured

- **composite**: one `tools/call` to `log_triage_triageservice_triage`, timed
  at the client. For `N` files it makes `2N + 2` inner hops.
- **in-process**: the same four handlers called as plain functions in one Node
  process, scheduled the way the composite schedules them: list, then every
  file's read and redact chain concurrently, then cluster. No runtime, no
  workers, no HTTP, no metering. This is the cost of the work itself.
- **in-process, sequential**: the same handlers one file after another,
  timed alternately with the concurrent ones. Shown beside them, and the
  source of the per-stage table, where concurrent stages would overlap.
- **runtime adds**: composite minus in-process, within each run. It covers
  HTTP, the outer call, hops between workers, schema validation on every hop,
  and metering.
- **client-orchestrated**: the same `2N + 2` tool calls made one at a time by
  an MCP client that holds the three leaf tools.

Both hop paths were measured: **direct** peer channels, the default since
7.1.0, and **main-thread-routed** (`--no-directPeerChannels`).

## Latency follows the number of files, linearly

400 lines per file, the first N files of a directory of 32.

| files | hops | direct | main-thread-routed | in-process | in-process, sequential | runtime adds, direct | runtime adds, main-thread-routed |
|---|---|---|---|---|---|---|---|
| 1 | 4 | 19.9 [18.6–21.7] ms | 21.7 [18.6–26.7] ms | 6.51 [5.50–7.12] ms | 6.09 [5.43–7.12] ms | 13.1 [12.8–15.2] ms | 14.5 [13.1–20.2] ms |
| 2 | 6 | 23.1 [21.0–25.1] ms | 22.6 [21.5–24.1] ms | 9.19 [7.89–10.1] ms | 10.5 [8.09–10.9] ms | 15.2 [10.9–15.9] ms | 14.1 [12.3–14.7] ms |
| 4 | 10 | 28.4 [28.4–29.6] ms | 31.0 [28.9–31.9] ms | 14.8 [14.7–17.7] ms | 17.9 [17.3–19.4] ms | 13.6 [11.9–13.7] ms | 14.2 [14.1–16.3] ms |
| 8 | 18 | 38.4 [37.8–38.8] ms | 40.6 [39.2–44.5] ms | 21.7 [20.9–21.9] ms | 29.3 [29.2–29.7] ms | 16.5 [16.1–17.9] ms | 19.7 [17.5–22.6] ms |
| 16 | 34 | 58.9 [56.7–59.8] ms | 59.2 [59.0–63.0] ms | 36.2 [34.8–36.8] ms | 48.1 [45.4–50.1] ms | 22.8 [19.9–25.0] ms | 24.2 [22.4–26.8] ms |
| 32 | 66 | 98.5 [97.4–102] ms | 102 [101–104] ms | 66.7 [66.6–66.8] ms | 92.9 [87.9–95.2] ms | 31.8 [30.5–35.8] ms | 35.2 [33.8–37.7] ms |

*Noise floor: the largest spread of any single configuration across the 3 runs is 37% (main-thread-routed 1 file), as (max - min) / median.*

**Per file, direct**: from 1 file to 32, the composite goes from 19.9 [18.6–21.7] ms to 98.5 [97.4–102] ms, 2.54 [2.54–2.60] ms for each further file ((32-file median - 1-file median) / 31, per run). A least-squares line through all 6 file counts fits with r² 0.999 [0.998–0.999].

**Per file, main-thread-routed**: from 1 file to 32, the composite goes from 21.7 [18.6–26.7] ms to 102 [101–104] ms, 2.54 [2.42–2.77] ms for each further file ((32-file median - 1-file median) / 31, per run). A least-squares line through all 6 file counts fits with r² 0.997 [0.993–1.000].

**Bill**: charged per composite call at 1, 2, 4, 8, 16, 32 files: 4, 6, 10, 18, 34, 66 (each further file adds 2).

Latency and cost move together, so `maxFiles` bounds both.

## With larger files, the work dominates

8 files, 18 hops, a directory of 8 files.

| lines per file | logs in total | direct | main-thread-routed | in-process | in-process, sequential | runtime adds, direct | runtime adds, main-thread-routed | runtime's share, direct | runtime's share, main-thread-routed |
|---|---|---|---|---|---|---|---|---|---|
| 100 | 0.0647 MB | 19.1 [18.6–20.0] ms | 23.1 [20.7–24.6] ms | 6.59 [6.47–6.64] ms | 11.7 [10.4–13.7] ms | 12.5 [12.1–13.5] ms | 16.6 [14.1–18.0] ms | 65 [65–68]% | 72 [68–73]% |
| 400 | 0.261 MB | 32.1 [31.5–33.0] ms | 37.5 [34.7–38.4] ms | 17.6 [16.5–18.1] ms | 23.6 [23.0–25.4] ms | 15.0 [13.9–15.6] ms | 20.3 [17.1–21.0] ms | 45 [44–49]% | 53 [49–56]% |
| 1600 | 1.04 MB | 81.8 [81.5–83.6] ms | 88.3 [85.6–89.2] ms | 61.8 [61.6–62.2] ms | 69.1 [68.5–69.9] ms | 19.9 [19.6–21.8] ms | 26.5 [24.0–27.0] ms | 24 [24–26]% | 30 [28–30]% |
| 6400 | 4.17 MB | 311 [299–336] ms | 312 [310–316] ms | 245 [244–245] ms | 255 [252–260] ms | 66.4 [54.0–91.5] ms | 67.0 [65.3–71.4] ms | 21 [18–27]% | 21 [21–23]% |

*Noise floor: the largest spread of any single configuration across the 3 runs is 17% (main-thread-routed 100 lines), as (max - min) / median.*

**Runtime's share of the call, direct**: 65 [65–68]% at 100 lines, 45 [44–49]% at 400 lines, 24 [24–26]% at 1600 lines, 21 [18–27]% at 6400 lines; the handlers' own work is 35 [32–35]%, 55 [51–56]%, 76 [74–76]%, 79 [73–82]% respectively.

**Runtime's share of the call, main-thread-routed**: 72 [68–73]% at 100 lines, 53 [49–56]% at 400 lines, 30 [28–30]% at 1600 lines, 21 [21–23]% at 6400 lines; the handlers' own work is 28 [27–32]%, 47 [44–51]%, 70 [70–72]%, 79 [77–79]% respectively.

**Concurrent against sequential baseline** (8 files): 6.59 [6.47–6.64] ms against 11.7 [10.4–13.7] ms at 100 lines (concurrent lower), 17.6 [16.5–18.1] ms against 23.6 [23.0–25.4] ms at 400 lines (concurrent lower), 61.8 [61.6–62.2] ms against 69.1 [68.5–69.9] ms at 1600 lines (concurrent lower), 245 [244–245] ms against 255 [252–260] ms at 6400 lines (concurrent lower). Runtime adds and shares above use the concurrent one.

**Same baseline cell, measured twice per run**: 8 of the 32 files, 400 lines, came out at 21.7 [20.9–21.9] ms in the files sweep and 21.5 [21.2–22.2] ms when measured again at the end of the baseline phase; within each run the two differ by 3 [2–6]%.

## What the runtime adds per call and per hop

Two parts, read off the first table (composite minus in-process, at 400
lines per file), and per hop off the second:

**Fixed part, direct**: the runtime adds 13.1 [12.8–15.2] ms at 1 file, 15.2 [10.9–15.9] ms at 2 files, 13.6 [11.9–13.7] ms at 4 files (hops 4, 6, 10); per run, the smallest of these is 11.9 [10.9–13.1] ms and the largest 15.2 [13.6–15.9] ms.

**Fixed part, main-thread-routed**: the runtime adds 14.5 [13.1–20.2] ms at 1 file, 14.1 [12.3–14.7] ms at 2 files, 14.2 [14.1–16.3] ms at 4 files (hops 4, 6, 10); per run, the smallest of these is 14.1 [12.3–14.2] ms and the largest 16.3 [14.5–20.2] ms.

**Per hop at 400 lines, direct**: at 32 files the runtime adds 31.8 [30.5–35.8] ms over 66 hops, 0.482 [0.463–0.542] ms per hop.

**Per hop at 400 lines, main-thread-routed**: at 32 files the runtime adds 35.2 [33.8–37.7] ms over 66 hops, 0.534 [0.512–0.571] ms per hop.

**Per hop by file size, direct**: the runtime adds 0.692 [0.670–0.749] ms at 100, 0.831 [0.772–0.865] ms at 400, 1.11 [1.09–1.21] ms at 1600, 3.69 [3.00–5.08] ms at 6400 lines per file.

**Per hop by file size, main-thread-routed**: the runtime adds 0.925 [0.783–0.998] ms at 100, 1.13 [0.950–1.16] ms at 400, 1.47 [1.33–1.50] ms at 1600, 3.72 [3.63–3.96] ms at 6400 lines per file.

The fixed part is HTTP, the outer call's authorization and metering, and the
response. What the runtime adds grows with payload because every `read`
result and every `redact` input and output is a batch of lines crossing a
worker boundary. These are differences of two noisy medians, so the per-hop
figures are indicative, not precise.

## Direct against routed

| case | direct | routed | direct is lower by | verdict |
|---|---|---|---|---|
| 1 file, 400 lines | 19.9 [18.6–21.7] ms | 21.7 [18.6–26.7] ms | 8% | within noise |
| 2 files, 400 lines | 23.1 [21.0–25.1] ms | 22.6 [21.5–24.1] ms | -2% | within noise |
| 4 files, 400 lines | 28.4 [28.4–29.6] ms | 31.0 [28.9–31.9] ms | 8% | within noise |
| 8 files, 400 lines | 38.4 [37.8–38.8] ms | 40.6 [39.2–44.5] ms | 5% | direct lower |
| 16 files, 400 lines | 58.9 [56.7–59.8] ms | 59.2 [59.0–63.0] ms | 0% | within noise |
| 32 files, 400 lines | 98.5 [97.4–102] ms | 102 [101–104] ms | 3% | within noise |
| 8 files, 100 lines | 19.1 [18.6–20.0] ms | 23.1 [20.7–24.6] ms | 17% | direct lower |
| 8 files, 1600 lines | 81.8 [81.5–83.6] ms | 88.3 [85.6–89.2] ms | 7% | direct lower |
| 8 files, 6400 lines | 311 [299–336] ms | 312 [310–316] ms | 0% | within noise |
| 8 files, 400 lines (size sweep) | 32.1 [31.5–33.0] ms | 37.5 [34.7–38.4] ms | 14% | direct lower |

**Direct against routed**: the direct path is lower in 4 of 10 cases by 5% to 17% of the routed median (8 files, 400 lines; 8 files, 100 lines; 8 files, 1600 lines; 8 files, 400 lines (size sweep)); routed is lower in 0; 6 are within noise (1 file, 400 lines; 2 files, 400 lines; 4 files, 400 lines; 16 files, 400 lines; 32 files, 400 lines; 8 files, 6400 lines).

This fits [`direct-peer-channels.md`](direct-peer-channels.md), which says
the direct path matters most for composition-heavy calls with large payloads,
and it is the same trade-off described there: the direct path checks
authorization when a channel opens, not on every hop.

## One composite call against the same hops made by the client

8 files of 400 lines, 18 tool calls for the client. Bytes are JSON request
and response bodies.

| | tool calls | latency, direct server | latency, main-thread-routed server | bytes sent | bytes received |
|---|---|---|---|---|---|
| composite | 1 | 35.7 [33.0–37.6] ms | 38.0 [37.8–38.1] ms | 167 | 14436 |
| client-orchestrated | 18 | 95.7 [95.1–108] ms | 87.1 [83.1–102] ms | 549495 | 1119438 |

*Noise floor: the largest spread of any single configuration across the 3 runs is 22% (client main-thread-routed), as (max - min) / median.*

**Composite against client, direct server**: one composite call takes 35.7 [33.0–37.6] ms against 95.7 [95.1–108] ms for the 18 client calls, lower; the client takes 2.90 [2.53–3.03]× as long, per run.

**Composite against client, main-thread-routed server**: one composite call takes 38.0 [37.8–38.1] ms against 87.1 [83.1–102] ms for the 18 client calls, lower; the client takes 2.28 [2.19–2.69]× as long, per run.

**Bytes on the wire**: the composite moves 14603 bytes (14.6 KB) and the client-orchestrated version 1668933 bytes (1.67 MB), 114 times as much. Identical in every run and on both paths.

The difference is the raw lines: the client has to receive every file from
`read` and send it back to `redact`, then send all the masked lines to
`cluster`.

Three things this comparison does not show. The client here is on the same
machine as the server, so network latency, which would widen the gap, is
absent. The client-orchestrated calls are sequential, as a model issuing tool
calls would make them, with no inference time between them. And a client
calling leaf tools directly makes no inner hops, so the two client latency
columns are not a comparison of hop paths.

## Where the work itself goes

In-process, no runtime, one file after another.

| files | lines per file | total | list | read | redact | cluster |
|---|---|---|---|---|---|---|
| 1 | 400 | 6.09 [5.43–7.12] ms | 3.16 [2.76–4.32] ms | 0.675 [0.551–0.816] ms | 1.50 [1.42–1.76] ms | 0.539 [0.472–0.574] ms |
| 2 | 400 | 10.5 [8.09–10.9] ms | 4.88 [3.01–5.74] ms | 1.77 [0.996–1.84] ms | 2.78 [2.42–2.95] ms | 1.02 [0.860–1.09] ms |
| 4 | 400 | 17.9 [17.3–19.4] ms | 5.79 [4.78–7.13] ms | 4.21 [3.34–4.67] ms | 5.04 [4.89–8.13] ms | 1.75 [1.63–3.00] ms |
| 8 | 400 | 29.3 [29.2–29.7] ms | 6.89 [6.83–6.99] ms | 8.33 [8.29–8.49] ms | 10.3 [9.75–10.6] ms | 3.65 [3.38–4.37] ms |
| 16 | 400 | 48.1 [45.4–50.1] ms | 5.73 [3.32–7.02] ms | 11.7 [8.81–14.2] ms | 21.5 [20.5–24.6] ms | 8.33 [8.14–8.90] ms |
| 32 | 400 | 92.9 [87.9–95.2] ms | 6.06 [5.47–7.52] ms | 29.0 [22.5–34.1] ms | 40.3 [40.3–41.8] ms | 16.1 [14.3–17.1] ms |
| 8 | 100 | 11.7 [10.4–13.7] ms | 1.45 [1.20–1.93] ms | 6.60 [5.40–8.10] ms | 2.79 [2.79–2.86] ms | 0.835 [0.825–0.854] ms |
| 8 | 1600 | 69.1 [68.5–69.9] ms | 1.68 [1.58–1.78] ms | 11.0 [10.7–11.6] ms | 40.6 [39.8–41.1] ms | 15.4 [15.1–16.8] ms |
| 8 | 6400 | 255 [252–260] ms | 1.32 [1.02–7.50] ms | 23.2 [21.7–23.4] ms | 165 [163–170] ms | 63.3 [53.6–68.4] ms |

**Stage shares** (of the four stages' sum, cases with 8 or more files, median across runs): redact 24% to 65%, cluster 7% to 25%, read 9% to 57%.

Masking is five regular expressions applied to every line. `pii-redact` runs
in one worker, so on a multi-core machine the masking of one call's files
would still run one file after another, and it is where a second call would
queue. The example's README says the same thing in words; this is the
measurement behind it.

## What an operator can take from this

- **Cost and latency are both linear in `maxFiles`**, so the cap that bounds
  the bill bounds the wait as well (see the per-file fit above).
- **For small inputs the runtime is most of the latency; for large inputs
  the work is** (see the runtime's share above).
- **Keeping the hops inside the runtime is faster and moves far less data**
  than a client making the same calls, before any network delay is counted:
  see the composite-against-client lines above.
- **The direct path is worth having for this workload** where the difference
  clears the noise (see "Direct against routed").

## Not measured

- Concurrent callers, throughput and tail latency under load.
- Any benefit from running the per-file chains concurrently (two shared
  cores cannot isolate it).
- Memory use.
