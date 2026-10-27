Machine: 2 x Intel(R) Core(TM) i7-6600U CPU @ 2.60GHz, 7.2 GB, Node v24.21.0, linux 7.0.0-38-generic
Runs: 5, each in a fresh process. Cells are the median across runs, [min–max] across runs.
Module sandbox: off (--moduleSandbox off)
Requests per cell: 150. Server flags beyond the defaults: --mcpToolCallCost 1.

### Module sandbox: off (--moduleSandbox off)

| Payload | Concurrency | Direct peer channel p50 | Direct peer channel p99 | Direct peer channel req/s |
|---|---|---|---|---|
| 1MB | 16 | 60.36ms [56.20ms–63.39ms] | 118.17ms [104.27ms–159.93ms] | 132 [122–146] |

*Noise floor: the largest spread of any single configuration across the 5 runs, as (max - min) / median: p50 12% (Direct peer channel 1MB/c=16); p99 47% (Direct peer channel 1MB/c=16); throughput 19% (Direct peer channel 1MB/c=16).*

Errors: none. Sandbox log: 0 violations, 0 would-be-refused under enforce, 0 restarts, 0 suspensions.

### Module sandbox: audit (--moduleSandbox audit)

| Payload | Concurrency | Direct peer channel p50 | Direct peer channel p99 | Direct peer channel req/s |
|---|---|---|---|---|
| 1MB | 16 | 65.26ms [61.07ms–92.68ms] | 137.00ms [128.95ms–151.78ms] | 123 [116–137] |

*Noise floor: the largest spread of any single configuration across the 5 runs, as (max - min) / median: p50 48% (Direct peer channel 1MB/c=16); p99 17% (Direct peer channel 1MB/c=16); throughput 17% (Direct peer channel 1MB/c=16).*

Errors: none. Sandbox log: 0 violations, 0 would-be-refused under enforce, 0 restarts, 0 suspensions.

**Direct peer channel, audit vs. off, p50** (positive = audit slower): 1MB/c=16 +8% (within noise). Cells where audit is more than 10% slower with non-overlapping ranges: 0.

**Direct peer channel, audit vs. off, throughput** (positive = audit slower): 1MB/c=16 +7% (within noise). Cells where audit is more than 10% slower with non-overlapping ranges: 0.
