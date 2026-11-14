# Lean worker: the measurement

What `perf/lean-worker-perf.js` measures against the lean worker spec's targets
(docs/superpowers/specs/2026-11-13-lean-worker-design.md), and the numbers so
far. The "after" tables come with lean worker step 5, once steps 3 and 4 are
on master.

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
  that fit's intercept above the 0-module RSS. It has its own line beside
  "pack ready", with no target of its own.

The numbers below are from `scripts/run-in-docker.js` (Node 24, 2 CPUs,
`--moduleSandbox audit`), each run behind a gate: no other container, at
least 2.5 GB available, and the machine at least 90% idle over 5 s.

## The method change (2026-11-14)

Until 2026-11-14 the per-worker slope was fitted through **every** row,
including the 0-module one. Since #166 the validator pool's threads (2 to 4
validators and a spare; 3 threads on 2 CPUs) start with the first module,
about 74 MB at once. A slope through the 0-module row counted that one-time
cost as part of every worker's: on master `c407bfc0` it read 48.1 MB per
worker where the workers' own cost is 42.8 MB.

So the slope is now fitted over 1..N workers, and the one-time cost is
reported on its own. The old number is still printed
(`addedRssPerWorkerThroughZeroMb`), and both are given below for every point
measured before the change, so no target reads as relaxed after the fact.
The 20 MB target applies to the 1..N slope.

Per thread (a local measurement: each thread's V8 heap from
`Worker.getHeapStatistics()`, same ladder, 2 CPUs), the pool's share is:

| | module workers, per worker | validators (3 threads), per module | validators at 1 module |
|---|---|---|---|
| 2c68b6de (before #166) | 34.7 MB | none | none |
| c407bfc0 (master) | 35.3 MB | 3.2 MB | 68.8 MB |
| #177's tip (a6e1679a) | 14.5 MB | 3.3 MB | 68.8 MB |

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
| f3f875e (#166) | attribution 1 | 7652 ms | 584 ms | 42.0 MB | 73.4 MB | 47.2 MB |
| f3f875e (#166) | attribution 2 | 10852 ms | 811 ms | 42.1 MB | 74.5 MB | 47.3 MB |
| c6e5447 (train 1) | attribution 1 | 7682 ms | 591 ms | 42.1 MB | 73.8 MB | 47.3 MB |
| c6e5447 (train 1) | attribution 2 * | 8493 ms | 646 ms | 42.1 MB | 73.4 MB | 47.3 MB |
| 546cda0a (#184) | attribution 1 | 8284 ms | 581 ms | 41.7 MB | 76.3 MB | 47.1 MB |
| 546cda0a (#184) | attribution 2 | 7671 ms | 539 ms | 42.4 MB | 74.4 MB | 47.6 MB |
| c407bfc0 (#190) | final "before" | 12322 ms | 904 ms | 42.8 MB | 72.0 MB | 47.9 MB |
| c407bfc0 (#190) | attribution 2 | 8004 ms | 619 ms | 42.8 MB | 74.9 MB | 48.1 MB |

\* overlapped another process's server start; its RSS agrees with attribution 1.

Each row is `--runs 3`. The final "before" for step 5 will be re-run with
`--runs 5` or more, in several sessions, at the "after" stage.
