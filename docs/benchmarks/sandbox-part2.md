# Module sandbox part 2: what the file broker costs

Measured 2026-10-17 on the maintainer's development VM: **1 CPU**, Node
v24.21.0, `UV_THREADPOOL_SIZE` 16 (countinghouse's default). On one CPU every
hop between the module's worker, the main thread and libuv's thread pool is a
full context switch, so these are close to a worst case; a multi-core host
should do better, and was not measured. The VM is noisy: medians are over 5
runs (10 for spawn time) and the spreads are wide. Treat these as orders of
magnitude on this machine, and measure your own.

Scripts: `perf/fs-broker-io-perf.js`, `perf/fs-broker-ops-count.js`,
`perf/spawn-time-perf.js`.

## File I/O

One module doing 250 rounds of: write 4 KB, read it back, stat it, unlink it,
in `/data` (`fs-probe`'s `ioBench` action; synchronous `fs` calls). The time is
measured inside the handler.

| Mode | median | min | max | per round |
|---|---|---|---|---|
| `--no-workerThread` (no broker) | 74 ms | 67 | 147 | 0.3 ms |
| worker, `--moduleSandbox off` | 3 753 ms | 1 523 | 4 793 | ~15 ms |
| worker, `--moduleSandbox enforce` | 2 402 ms | 1 656 | 3 608 | ~10 ms |
| `enforce`, 10 modules at once, 25 rounds each | 1 185 ms (all 10) | 1 112 | 1 640 | ~4.7 ms |

On this machine brokered file I/O costs roughly **30-50 times** the direct
path per operation (the `off` and `enforce` spreads overlap: the difference
between them here is noise). Concurrency helps: ten modules sharing the broker
finish the same total work in a third of one module's time, because the
thread pool and the main thread overlap their work.

The 10-module case runs each module at a tenth of the rounds (the same total
work) and with `--requestTimeout 300000`: at 1000 rounds each, the calls ran
past the default 30 s request timeout on one CPU. That is the request
timeout, not a broker failure. The single-module cases also run with the
longer timeout, because `enforce` at 1000 rounds passed 30 s too.

## Where the time goes

Each brokered call crosses to the main thread and back (about 0.1 ms in
plan 2b's spike), and the main thread does the work asynchronously, each
filesystem call being a job on libuv's thread pool. One round of the benchmark
is 6 bridge calls (`writeFileSync` is open + write + close) and this many pool
jobs:

| Mode | pool jobs per round | of which the operations themselves |
|---|---|---|
| `off` | 21 | ~9 |
| `audit` | 25 | ~9 |
| `enforce` | 29 | ~9 |

The rest are the path checks (a `realpath` and a `stat` of each path before
the operation, and under `enforce` an `fstat` and a `readlink` of
`/proc/self/fd` after each open) and the quota's `fstat` before each write.
They are what keeps a module inside its namespace when a host process swaps a
path; under `off` they decide nothing.

## Spawn time

| Step | median | min | max |
|---|---|---|---|
| countinghouse's code roots (dependency closure, 299 package directories) | 79 ms | 24 | 136 |
| spawn walk, empty `/data` | 0.3 ms | 0.2 | 2.3 |
| spawn walk, 10 000 files in `/data` | 715 ms | 496 | 1 719 |
| `createForWorker` (directories, walk, roots, namespace) | 51 ms | 28 | 74 |
| `POST /restart-module` until the module answers | 5 963 ms | 2 370 | 19 477 |

The code roots are now computed once per process (they were the largest
fixed cost). The spawn walk grows with the number of entries in a module's
`/data` and `/tmp`, about 70 µs per entry here: a module near the default
`diskEntries` limit (100 000) adds about 7 s to each start and restart. The
walk is asynchronous and does not block the main thread.

## What this means

- Modules that do occasional file I/O (configuration, a cache file, logs)
  will not notice. Modules that do thousands of small synchronous file
  operations per request will be markedly slower in worker mode than in
  7.x's single-thread mode.
- `--no-workerThread` keeps the direct path, but has no sandbox and is meant
  for debugging only.
- Fewer, larger operations cost less: `readFile` is one brokered call, and
  each call's checks are paid once.
