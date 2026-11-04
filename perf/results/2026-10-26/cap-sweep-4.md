Machine: 2 x Intel(R) Core(TM) i7-6600U CPU @ 2.60GHz, 7.2 GB, Node v24.21.0, linux 7.0.0-38-generic
Runs: 3, each in a fresh process. Cells are the median across runs, [min–max] across runs.
Module sandbox: audit (default)
Requests per cell: 150. Server flags beyond the defaults: --directPeerChannelsMaxConcurrency 4.

### Module sandbox: audit (default)

| Payload | Concurrency | Direct peer channel p50 | Direct peer channel p99 | Direct peer channel req/s |
|---|---|---|---|---|
| 1MB | 64 | 395.00ms [332.72ms–404.52ms] | 525.67ms [486.33ms–632.53ms] | 115 [102–116] |

*Noise floor: the largest spread of any single configuration across the 3 runs, as (max - min) / median: p50 18% (Direct peer channel 1MB/c=64); p99 28% (Direct peer channel 1MB/c=64); throughput 13% (Direct peer channel 1MB/c=64).*

Errors: none. Sandbox log: 0 violations, 0 would-be-refused under enforce, 0 restarts, 0 suspensions.
