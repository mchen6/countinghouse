Machine: 2 x Intel(R) Core(TM) i7-6600U CPU @ 2.60GHz, 7.2 GB, Node v24.21.0, linux 7.0.0-38-generic
Runs: 3, each in a fresh process. Cells are the median across runs, [min–max] across runs.
Module sandbox: audit (default)
Requests per cell: 150. Server flags beyond the defaults: none.

### Module sandbox: audit (default)

| Payload | Concurrency | Main-thread-routed p50 | Main-thread-routed p99 | Main-thread-routed req/s | Direct peer channel p50 | Direct peer channel p99 | Direct peer channel req/s |
|---|---|---|---|---|---|---|---|
| 1KB | 1 | 1.41ms [1.40ms–1.46ms] | 4.40ms [3.80ms–5.11ms] | 169 [168–171] | 1.38ms [1.38ms–1.40ms] | 5.04ms [3.10ms–5.43ms] | 204 [181–204] |
| 1KB | 16 | 9.54ms [8.37ms–12.81ms] | 24.71ms [21.30ms–27.16ms] | 409 [398–413] | 9.50ms [9.06ms–11.58ms] | 28.18ms [20.21ms–39.61ms] | 469 [402–476] |
| 1KB | 64 | 39.22ms [27.60ms–51.69ms] | 68.78ms [50.52ms–77.58ms] | 476 [463–517] | 45.94ms [27.07ms–48.68ms] | 69.99ms [54.91ms–96.15ms] | 620 [498–644] |
| 100KB | 1 | 1.53ms [1.45ms–1.53ms] | 6.98ms [5.27ms–8.20ms] | 202 [193–219] | 1.49ms [1.34ms–1.55ms] | 5.80ms [4.09ms–8.84ms] | 203 [196–223] |
| 100KB | 16 | 10.81ms [10.41ms–11.27ms] | 22.46ms [22.46ms–33.71ms] | 502 [426–575] | 10.22ms [8.97ms–10.26ms] | 25.05ms [17.69ms–30.64ms] | 543 [445–591] |
| 100KB | 64 | 32.24ms [28.08ms–33.54ms] | 43.28ms [42.88ms–53.20ms] | 636 [573–773] | 43.03ms [36.25ms–60.40ms] | 67.28ms [63.97ms–119.76ms] | 704 [543–789] |
| 1MB | 1 | 7.60ms [7.56ms–7.89ms] | 17.07ms [16.20ms–18.10ms] | 93 [91–94] | 5.06ms [5.06ms–5.14ms] | 14.84ms [13.00ms–15.12ms] | 121 [118–122] |
| 1MB | 16 | 77.08ms [61.61ms–80.88ms] | 125.39ms [114.85ms–150.78ms] | 123 [123–138] | 59.11ms [58.92ms–60.11ms] | 115.45ms [110.28ms–140.13ms] | 156 [146–160] |
| 1MB | 64 | 302.64ms [298.51ms–335.13ms] | 361.29ms [360.23ms–373.46ms] | 130 [122–131] | 234.89ms [213.57ms–253.16ms] | 379.78ms [358.01ms–401.81ms] | 190 [178–195] |

*Noise floor: the largest spread of any single configuration across the 3 runs, as (max - min) / median: p50 61% (Main-thread-routed 1KB/c=64); p99 83% (Direct peer channel 100KB/c=64); throughput 35% (Direct peer channel 100KB/c=64).*

Errors: none. Sandbox log: 0 violations, 0 would-be-refused under enforce, 0 restarts, 0 suspensions.

**p50**: direct peer channels are lower than main-thread-routed in 4 of 9 cells, higher in 1 (100KB/c=64 (32.24ms [28.08ms–33.54ms] vs. 43.03ms [36.25ms–60.40ms]), main vs. direct), and within noise in 4; ratio of medians from 0.75× (at 100KB/c=64) to 1.50× (at 1MB/c=1).

**Throughput**: direct peer channels are higher in 4 of 9 cells, lower in 0, and within noise in 5; ratio of medians from 1.00× (at 100KB/c=1) to 1.47× (at 1MB/c=64).

**p99**: direct peer channels are lower in 1 of 9 cells, higher (worse) in 1 (100KB/c=64 (43.28ms [42.88ms–53.20ms] vs. 67.28ms [63.97ms–119.76ms]), main vs. direct), and within noise in 7.
