# Module sandbox part 2: what the file broker costs

Measured 2026-10-17 at `dab69d0` on the maintainer's development VM: **1 CPU**, Node
v24.21.0, `UV_THREADPOOL_SIZE` 16 (countinghouse's default). On one CPU every
hop between the module's worker, the main thread and libuv's thread pool is a
full context switch, so these are close to a worst case; a multi-core host
should do better, and was not measured. The VM is noisy: medians are over 5
runs (10 for spawn time) and the spreads are wide. Treat these as orders of
magnitude on this machine, and measure your own.

The broker was optimised after these measurements (plan 5 Task 4b: A
`b977146`, B `60ca7e8`, C `9246db1`). By then the VM had 2 CPUs, so
[After the optimisations](#after-the-optimisations) measures both the
before and the after commit again, on 2 CPUs. The sections up to there
are the original 1-CPU measurements at `dab69d0`.

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

## After the optimisations

Measured 2026-11-04 on the same VM, now **2 CPUs**, Node v24.21.0,
`UV_THREADPOOL_SIZE` 16. Three optimisations (plan 5 Task 4b):

- **A** (`b977146`): under `--moduleSandbox off` the broker makes no host
  checks, because `off` decides nothing about files. The link rules, `EXDEV`,
  `EBUSY` on roots and the special-file check still run.
- **B** (`60ca7e8`): `writeFile` and `appendFile` on a path are one brokered
  call, not open + write + close. The quota, the post-open verify and the
  special-file check all still apply.
- **C** (`9246db1`): each broker caches directory real paths. Every mutating
  operation clears the cache, entries expire after 1000 ms, and at most 1024
  are kept. Only directories are cached, and under `enforce` every opened
  descriptor is still verified without the cache.

Pool jobs and bridge calls per benchmark round (`perf/fs-broker-ops-count.js`;
counts, so the CPU count does not matter):

| Mode | pool jobs, `dab69d0` | pool jobs, `9246db1` | bridge calls |
|---|---|---|---|
| `off` | 21 | 12 | 6 → 4 |
| `audit` | 25 | 22 | 6 → 4 |
| `enforce` | 29 | 26 | 6 → 4 |

File I/O, 250 rounds (`perf/fs-broker-io-perf.js 250`). The two commits were
run three times each, alternating. The table shows the middle of the three
sessions' medians, each over 5 runs, with the range of those three medians:

| Mode | before (`dab69d0`) | after (`9246db1`) | change |
|---|---|---|---|
| `--no-workerThread` (no broker) | 31 ms (26-49) | 29 ms (29-82) | none (no broker) |
| worker, `--moduleSandbox off` | 1 713 ms (1 652-2 070) | 1 232 ms (1 178-1 446) | about -28% |
| worker, `--moduleSandbox enforce` | 2 261 ms (2 201-2 438) | 1 919 ms (1 824-2 266) | about -15% |
| `enforce`, 10 modules at once, 25 rounds each | 1 164 ms (942-1 232) | 1 105 ms (989-1 460) | within noise |

`off` gains the most, from A. `enforce` keeps its post-open verification
(an `fstat` and a `readlink` per open), which is the security check and was
left alone. Brokered file I/O still costs tens of times the direct path on
this machine. In the 10-module case the two commits' ranges overlap: any
saving there is smaller than this VM's noise. The cause was not
investigated.

## Spawn time

Measured at `dab69d0`, 1 CPU (A-C do not touch the spawn path). On 2 CPUs
the same restart round trip takes about 1.6 s, and a restart is faster than
in 7.1.2: see [Restarts against 7.x](#restarts-against-7x).

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

### Restarts against 7.x

Measured 2026-11-04 on the same VM after its upgrade (2 CPUs, Node v24.21.0).
`perf/spawn-time-perf.js` at `cd411ee`, three sessions of 10 runs: the
`fs-probe` restart round trip took a median of 1 606, 1 588 and 1 670 ms
(1 392-1 968 overall), and the 10 000-file walk 1 431, 1 453 and 1 139 ms
(852-1 972). The walk code is unchanged since `dab69d0`; this machine's disk
is slower since the upgrade, so the walk is about 115-145 µs per entry here.

For a 7.x baseline, the same small module (`test/fixtures/handler-map-module`,
unchanged between the two) was restarted with `POST /restart-module` until a
`tools/call` succeeded again, in worker mode, three alternating sessions of
10 runs:

| | middle of the three sessions' medians | range of those medians |
|---|---|---|
| 7.1.2 (`fddac24`) | 4 244 ms | 4 018-4 304 |
| 8.0.0 (`cd411ee`) | 1 294 ms | 1 088-1 316 |

A restart in 8.0.0 is faster than in 7.1.2. The broker's share of a start
(`createForWorker`, about 6 ms here, plus the walk of `/data` and `/tmp`) is
small unless a module keeps many files. The likely cause of 7.1.2's extra
time: it waited a fixed 3 s at unload before terminating the old worker
(`lib/module-manager.js` at `fddac24`), and 8.0.0 waits for the worker's
acknowledgement instead. That matches most of the difference; it was not
measured separately.

## What this means

- Modules that do occasional file I/O (configuration, a cache file, logs)
  will not notice. Modules that do thousands of small synchronous file
  operations per request will be markedly slower in worker mode than in
  7.x's single-thread mode.
- `--no-workerThread` keeps the direct path, but has no sandbox and is meant
  for debugging only.
- Fewer, larger operations cost less: `readFile`, and since `60ca7e8`
  `writeFile` and `appendFile`, are one brokered call each, and each call's
  checks are paid once.
