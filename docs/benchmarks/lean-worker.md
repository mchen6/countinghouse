# Lean worker: the measurement

What `perf/lean-worker-perf.js` measures against the lean worker spec's targets
(docs/superpowers/specs/2026-11-13-lean-worker-design.md), and the numbers:
the "before" points measured while it was built, and step 5's before and
after, below.

## Method

The harness starts `framework.js --workerThread --store local` with one
`--loadModule` per module, `--runs N` times per configuration, and reads only
the server's own log lines and `/proc`, so the same script measures code from
before and after the lean worker. The configurations are a ladder: 0, 1, 3
and 5 of pack 1's parts, then pack 1 itself (`ch-pack-ci-failure-triage`, 9
workers), and pack 1 single-threaded for reference.

- **pack ready:** spawn to `countinghouse ready`, pack 1 (target: at most 5 s).
- **worker boot:** per module, `file broker: <name> spawn walk` to
  `module: <name>@<version> loaded`; the median over the modules and runs
  (target: at most 200 ms).
- **added RSS per worker:** the least-squares slope of the server's VmRSS
  over the configurations with **1..N workers** (target: at most 20 MB).
- **fixed RSS:** what the first worker brings once, beyond its own share:
  that fit's intercept above the RSS of the configuration with no module. It
  is printed on its own `fixed:` line after the `targets:` line, and has no
  target of its own. Before #166 it is within the noise (2.7 to 10.3 MB
  below); a value near 0, or slightly negative, means no one-time cost.

**Which pack 1.** The numbers measured so far loaded pack 1 0.1.0 (its
scenario and parts from a local tarball install). That version's scenario
emits `coverage.historyRebuilt`, which its own output schema forbids, so a
call of it fails `OUTPUT_DATA_VALIDATION_FAIL` whenever its history is
rebuilt (a first call, for one); the harness only loads the pack and never
calls it, so its numbers stand. Step 5's "after" run is given pack 1 0.4.0
(the version ch-local installs) by its `--pack`, and one run is given 0.5.0,
the version the first release pins; the harness itself takes whatever
`--pack` names, so the run's table states the version.
perf/shared-runtime/measure.js, which calls the pack, refuses anything
older than 0.4.0.

The numbers below are from `scripts/run-in-docker.js` (Node 24, 2 CPUs,
`--moduleSandbox audit`). Each run was started by a wrapper of the
measurer's, not by the tooling: only with no other container, at least
2.5 GB available, and the machine at least 90% idle over 5 s. Neither the
harness nor `run-in-docker.js` checks this.

## The method change (2026-11-14)

Until 2026-11-14 the per-worker slope was fitted through **every** row,
including the 0-module one. Since #166 the validator pool's threads (2 to 4
validators and a spare; 3 threads on 2 CPUs) start with the first module,
about 74 MB at once. A slope through the 0-module row counted that one-time
cost as part of every worker's: on master `c407bfc0` it read 48.1 MB per
worker where the workers' own cost is 42.8 MB.

So the slope is now fitted over 1..N workers, and the one-time cost is
reported on its own. The 20 MB target applies to the 1..N slope.

`addedRssPerWorkerMb` in the harness's JSON changed meaning with this: it
was the slope through the 0-module row until 2026-11-14, and is the 1..N
slope since. The old number is under `addedRssPerWorkerThroughZeroMb`, the
result's `rssMethod` says which method made it, and both numbers are given
below for every point measured before the change, so no target reads as
relaxed after the fact.

Per thread (a local measurement: each thread's V8 heap from
`Worker.getHeapStatistics()`, same ladder, 2 CPUs), the pool's share is:

| | module workers, per worker | validators (3 threads), per module | validators at 1 module |
|---|---|---|---|
| 2c68b6de (before #166) | 34.7 MB | none | none |
| c407bfc0 (#190 merged) | 35.3 MB | 3.2 MB | 68.8 MB |
| a6e1679a (#177, lean worker step 3, unmerged then) | 14.5 MB | 3.3 MB | 68.8 MB |

The validators' 3.2 MB per module is real per-module cost: every validator
warm-compiles every module's actions at load. It stays in the 1..N slope.

## Numbers measured so far

pack ready and worker boot vary between sessions by more than they vary
between these commits (2c68b6de: 6.17, 8.91 and 6.99 s); only RSS is stable
enough to compare across commits.

| point | when | pack ready | worker boot | RSS per worker, 1..N | fixed RSS | RSS per worker, through 0 (old) |
|---|---|---|---|---|---|---|
| 7.1.2 (tarball) | 2026-11-14 | 19643 ms | 1424 ms | 57.5 MB | 10.3 MB | 58.3 MB |
| 2c68b6de | 2026-11-14, first | 6173 ms | 674 ms | 38.5 MB | 2.7 MB | 38.7 MB |
| 2c68b6de | 2026-11-14, attribution 1 | 8906 ms | 824 ms | 37.9 MB | 3.8 MB | 38.2 MB |
| 2c68b6de | 2026-11-14, attribution 2 | 6985 ms | 631 ms | 38.3 MB | 2.7 MB | 38.5 MB |
| f3f875e0 (#166) | attribution 1 | 7652 ms | 584 ms | 42.0 MB | 73.4 MB | 47.2 MB |
| f3f875e0 (#166) | attribution 2 | 10852 ms | 811 ms | 42.1 MB | 74.5 MB | 47.3 MB |
| c6e54476 (train 1) | attribution 1 | 7682 ms | 591 ms | 42.1 MB | 73.8 MB | 47.3 MB |
| c6e54476 (train 1) | attribution 2 * | 8493 ms | 646 ms | 42.1 MB | 73.4 MB | 47.3 MB |
| 546cda0a (#184) | attribution 1 | 8284 ms | 581 ms | 41.7 MB | 76.3 MB | 47.1 MB |
| 546cda0a (#184) | attribution 2 | 7671 ms | 539 ms | 42.4 MB | 74.4 MB | 47.6 MB |
| c407bfc0 (#190) | final "before" | 12322 ms | 904 ms | 42.8 MB | 72.0 MB | 47.9 MB |
| c407bfc0 (#190) | attribution 2 | 8004 ms | 619 ms | 42.8 MB | 74.9 MB | 48.1 MB |

\* overlapped another process's server start; its RSS agrees with attribution 1.

Each row is `--runs 3`. Step 5's "before" below was run once, with
`--runs 5`, in one session: not in several, as planned.

## Step 5: before and after (2026-11-20)

`--runs 5`, in `scripts/run-in-docker.js` (Node 24, the VM's 2 CPUs), one
step at a time, each in one session. The measurer's local copy of
`run-in-docker.js` added a 2 GB, no-swap memory cap to the container; the
committed script adds none. The gate was stricter than above: no other
container, at least 3 GB available, and 30 s at least 90% idle. Each step
was also watched while it ran: a step was aborted if processes outside its
container used more than 2.5 CPU-seconds in any 10 s.
- **before** and **after (0.4.0):** each aborted once and run again; the
  kept runs peaked at 1.85 and 1.93.
- **after, pack 1 0.5.0:** kept, with a caveat. Its windows peaked at 1.93
  until the last one, which read 2.52 as the run finished, and the watcher
  fired. Its figures are within the others' range, but it did not meet the
  watcher's limit.

These steps were quieter than the earlier points, but each configuration
was measured in one session, so the session-to-session spread above (6.2 to
12.3 s for one commit) is not shown to have shrunk.

| | before (c407bfc0, pack 1 0.4.0) | after (285a31a4, pack 1 0.4.0) | after, pack 1 0.5.0 |
|---|---|---|---|
| **pack ready** (target ≤ 5000 ms) | 7220 ms | **4064 ms** | 4466 ms |
| **worker boot, median** (target ≤ 200 ms) | 554 ms | **214 ms** | 250 ms |
| of it, the spawn walk | 20 ms | 11 ms | 11 ms |
| **added RSS per worker, 1..N** (target ≤ 20 MB) | 43.4 MB | **21.3 MB** | 21.3 MB |
| fixed RSS (the first worker's, once) | 70.3 MB | 103.8 MB | 102.1 MB |
| RSS through 0 (old method) | 48.3 MB | 28.6 MB | 28.5 MB |
| pack: RSS | 565.3 MB | 398.1 MB | 395.4 MB |
| pack, single-threaded: ready, RSS | 1092 ms, 118.3 MB | 1175 ms, 121.4 MB | 1143 ms, 121.6 MB |

The ladder, after (285a31a4, pack 1 0.4.0):

| configuration | workers | ready | RSS | worker boot |
|---|---|---|---|---|
| 0 modules | 0 | 790 ms | 101.7 MB | |
| 1 module | 1 | 1964 ms | 227.9 MB | 331 ms |
| 3 modules | 3 | 2477 ms | 269.2 MB | 218 ms |
| 5 modules | 5 | 3018 ms | 310 MB | 213 ms |
| pack 1 | 9 | 4064 ms | 398.1 MB | 214 ms |

- **The lean worker:** pack ready takes 44% less time (7.2 → 4.1 s), the
  worker boot median 61% less (554 → 214 ms), and the added RSS per worker
  is halved (43.4 → 21.3 MB). The RSS figures are stable across sessions;
  the time figures are one session each.
- **Pack 1 0.5.0 against 0.4.0:** 4466 against 4064 ms ready, and 250
  against 214 ms boot, one run each. That difference is within the
  session-to-session spread, so no difference between the versions is
  established. Memory is the same.
- **Within target:** pack ready.
- **Over target:**
  - the worker boot median, 214–250 ms against 200 ms;
  - the added RSS per worker, 21.3 MB against 20 MB.

  The spawn walk is 11 ms of the boot. The rest is the worker's own start:
  a new isolate, the runtime files it loads, and the lockdown. Which of
  these to cut first is not measured yet; a profile of one worker's boot
  would say. The likely levers are a compile cache for the files a worker
  loads, fewer of them at boot, and a cheaper lockdown.
- **The fixed RSS rose** (70 → 104 MB), while the per-worker slope halved:
  more of the cost is now paid once, with the first worker, and less per
  worker. It is not broken down here. At pack 1's 9 workers the total is
  still 167 MB lower (565 → 398 MB).

## Per-session workers (shared runtime R1)

What one idle per-session lean worker adds to the shared runtime, measured
by `perf/session-worker-rss.js`. A per-session worker is a worker_thread in
the runtime's process, so its cost is the process's VmRSS and Pss after N
sessions' first calls started N workers, minus before: the same N sessions
open and the module listed, but no worker. Each reading is taken at steady
state (RSS moved under 1% over 6 one-second samples). Every N is measured in
a fresh runtime (`--workerThread --store local --sessionSocket`, as ch-local's
daemon starts it, default sandbox) with `test/fixtures/per-session-module`
loaded, 3 times, with at least 3 GB of memory available.

2026-11-17, master `6814ad06`, Node 24.21.0, 2 CPUs (load average 1.6–3.3):

| N workers | added RSS (median of 3) | per worker | range per worker | threads added |
|---|---|---|---|---|
| 1 | 39.4 MB | 39.4 MB | 38.1–40.5 MB | 17 |
| 4 | 108.7 MB | 27.2 MB | 27.1–29.5 MB | 20 |
| 8 | 208.9 MB | 26.1 MB | 25.8–26.6 MB | 24 |

- **The fit:** the least-squares fit over the 9 runs gives **24.3 MB per worker, plus about 14.8 MB once**, with the first worker. The first worker adds 17 threads and each later one adds 1, so the first also starts shared machinery. The bound is therefore about 14.8 MB + 24.3 MB × workers. At the default `--maxSessionWorkers 16` that is about 404 MB, on top of the runtime's own ≈190 MB.
- **PSS equals RSS** to within 0.01 MB in every run: the workers are threads of one process, so nothing is shared with another process.
- **The earlier "14.5 MB" was not RSS.** It is the #177 row of the per-thread table above, a V8 heap size per thread, not what a worker adds to the process.

**Caveats:**
- These figures are for Node 24.21. RSS differs between Node majors (CI runs 22, 24 and 26), so re-measure on the release's Node.
- The fixture is a small module: a few handlers using fs and `ctx.redis`. A heavier module adds its own heap and code on top.
