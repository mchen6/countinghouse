Machine: 2 x Intel(R) Core(TM) i7-6600U CPU @ 2.60GHz, 7.2 GB, Node v24.21.0, linux 7.0.0-38-generic
Runs: 3, each in a fresh process. Cells are the median across runs, [min–max] across runs.
Module sandbox: audit (default)
Requests per cell: 150. Server flags beyond the defaults: none.

### Module sandbox: audit (default)

| Payload | Concurrency | Main-thread-routed p50 | Main-thread-routed p99 | Main-thread-routed req/s | Direct peer channel p50 | Direct peer channel p99 | Direct peer channel req/s |
|---|---|---|---|---|---|---|---|
| 1KB | 1 | 1.41 [1.40–1.46] ms | 4.40 [3.80–5.11] ms | 169 [168–171] | 1.38 [1.38–1.40] ms | 5.04 [3.10–5.43] ms | 204 [181–204] |
| 1KB | 16 | 9.54 [8.37–12.8] ms | 24.7 [21.3–27.2] ms | 409 [398–413] | 9.50 [9.06–11.6] ms | 28.2 [20.2–39.6] ms | 469 [402–476] |
| 1KB | 64 | 39.2 [27.6–51.7] ms | 68.8 [50.5–77.6] ms | 476 [463–517] | 45.9 [27.1–48.7] ms | 70.0 [54.9–96.2] ms | 620 [498–644] |
| 100KB | 1 | 1.53 [1.45–1.53] ms | 6.98 [5.27–8.20] ms | 202 [193–219] | 1.49 [1.34–1.55] ms | 5.80 [4.09–8.84] ms | 203 [196–223] |
| 100KB | 16 | 10.8 [10.4–11.3] ms | 22.5 [22.5–33.7] ms | 502 [426–575] | 10.2 [8.97–10.3] ms | 25.0 [17.7–30.6] ms | 543 [445–591] |
| 100KB | 64 | 32.2 [28.1–33.5] ms | 43.3 [42.9–53.2] ms | 636 [573–773] | 43.0 [36.3–60.4] ms | 67.3 [64.0–120] ms | 704 [543–789] |
| 1MB | 1 | 7.60 [7.56–7.89] ms | 17.1 [16.2–18.1] ms | 93 [91–94] | 5.06 [5.06–5.14] ms | 14.8 [13.0–15.1] ms | 121 [118–122] |
| 1MB | 16 | 77.1 [61.6–80.9] ms | 125 [115–151] ms | 123 [123–138] | 59.1 [58.9–60.1] ms | 115 [110–140] ms | 156 [146–160] |
| 1MB | 64 | 303 [299–335] ms | 361 [360–373] ms | 130 [122–131] | 235 [214–253] ms | 380 [358–402] ms | 190 [178–195] |

*Noise floor: the largest spread of any single configuration across the 3 runs, as (max - min) / median: p50 61% (Main-thread-routed 1KB/c=64); p99 83% (Direct peer channel 100KB/c=64); throughput 35% (Direct peer channel 100KB/c=64).*

Errors: none. Sandbox log: 0 violations, 0 would-be-refused under enforce, 0 restarts, 0 suspensions.

**p50**: direct peer channels are lower than main-thread-routed in 4 of 9 cells, higher in 1 (100KB/c=64 (32.2 [28.1–33.5] ms vs. 43.0 [36.3–60.4] ms), main vs. direct), and within noise in 4; ratio of medians from 0.749× (at 100KB/c=64) to 1.50× (at 1MB/c=1).

**Throughput**: direct peer channels are higher in 4 of 9 cells, lower in 0, and within noise in 5; ratio of medians from 1.00× (at 100KB/c=1) to 1.47× (at 1MB/c=64).

**p99**: direct peer channels are lower in 1 of 9 cells, higher (worse) in 1 (100KB/c=64 (43.3 [42.9–53.2] ms vs. 67.3 [64.0–120] ms), main vs. direct), and within noise in 7.
