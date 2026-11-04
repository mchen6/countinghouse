Machine: 2 x Intel(R) Core(TM) i7-6600U CPU @ 2.60GHz, 7.2 GB, Node v24.21.0, linux 7.0.0-38-generic
Runs: 3, each in a fresh process. Cells are the median across runs, [min–max] across runs.
Module sandbox: off (--moduleSandbox off)
Repetitions: 25 per cell after 5 warm-up calls, per run. Times in ms: median across runs of each run's median, [min–max] of those medians.
Matrix: headline. Servers: --workerThread, non-debug, --mcpToolCallCost 1.

## Module sandbox: off (--moduleSandbox off)

Errors: none. Sandbox log: 0 violations, 0 would-be-refused under enforce, 0 restarts, 0 suspensions.

### Headline: one composite call, 8 files of 400 lines

| path | composite | in-process | charged per call |
|---|---|---|---|
| direct | 45.2 [43.8–48.1] ms | 21.5 [20.1–25.1] ms | 18 |

*Noise floor: the largest spread of any single configuration across the 3 runs is 10% (direct), as (max - min) / median.*

## Module sandbox: audit (--moduleSandbox audit)

Errors: none. Sandbox log: 0 violations, 0 would-be-refused under enforce, 0 restarts, 0 suspensions.

### Headline: one composite call, 8 files of 400 lines

| path | composite | in-process | charged per call |
|---|---|---|---|
| direct | 46.4 [45.8–48.4] ms | 21.5 [20.1–25.1] ms | 18 |

*Noise floor: the largest spread of any single configuration across the 3 runs is 6% (direct), as (max - min) / median.*

## Module sandbox: enforce (--moduleSandbox enforce)

Errors: none. Sandbox log: 0 violations, 0 would-be-refused under enforce, 0 restarts, 0 suspensions.

### Headline: one composite call, 8 files of 400 lines

| path | composite | in-process | charged per call |
|---|---|---|---|
| direct | 47.3 [46.9–50.8] ms | 21.5 [20.1–25.1] ms | 18 |

*Noise floor: the largest spread of any single configuration across the 3 runs is 8% (direct), as (max - min) / median.*

## Sandbox modes compared

**direct, audit against off** (composite, 8 files of 400 lines): 46.4 [45.8–48.4] ms against 45.2 [43.8–48.1] ms, +3% (within noise). More than 10% slower with non-overlapping ranges: no.

**direct, enforce against off** (composite, 8 files of 400 lines): 47.3 [46.9–50.8] ms against 45.2 [43.8–48.1] ms, +5% (within noise). More than 10% slower with non-overlapping ranges: no.

