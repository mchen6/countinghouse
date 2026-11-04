Machine: 2 x Intel(R) Core(TM) i7-6600U CPU @ 2.60GHz, 7.2 GB, Node v24.21.0, linux 7.0.0-38-generic
Runs: 3, each in a fresh process. Cells are the median across runs, [min–max] across runs.
Module sandbox: off (--moduleSandbox off)
Requests per cell: 150. Server flags beyond the defaults: --mcpToolCallCost 1.

### Module sandbox: off (--moduleSandbox off)

| Payload | Concurrency | Direct peer channel p50 | Direct peer channel p99 | Direct peer channel req/s |
|---|---|---|---|---|
| 1KB | 1 | 1.39ms [1.28ms–1.57ms] | 4.02ms [3.69ms–4.11ms] | 178 [160–188] |
| 1KB | 16 | 7.26ms [6.54ms–10.85ms] | 21.36ms [19.08ms–38.89ms] | 395 [301–435] |
| 1KB | 64 | 30.73ms [23.12ms–44.45ms] | 58.10ms [43.13ms–92.09ms] | 429 [334–485] |
| 100KB | 1 | 1.41ms [1.39ms–1.60ms] | 11.95ms [9.44ms–20.02ms] | 192 [149–199] |
| 100KB | 16 | 9.27ms [7.51ms–11.90ms] | 19.54ms [19.04ms–28.90ms] | 540 [380–577] |
| 100KB | 64 | 31.27ms [23.42ms–58.33ms] | 54.15ms [46.75ms–73.15ms] | 694 [664–732] |
| 1MB | 1 | 4.55ms [4.53ms–5.41ms] | 13.38ms [12.27ms–14.10ms] | 130 [113–132] |
| 1MB | 16 | 45.52ms [44.17ms–51.48ms] | 101.59ms [76.64ms–122.79ms] | 188 [183–196] |
| 1MB | 64 | 192.03ms [136.31ms–256.81ms] | 309.04ms [249.87ms–431.38ms] | 203 [160–209] |

*Noise floor: the largest spread of any single configuration across the 3 runs, as (max - min) / median: p50 112% (Direct peer channel 100KB/c=64); p99 93% (Direct peer channel 1KB/c=16); throughput 37% (Direct peer channel 100KB/c=16).*

Errors: none. Sandbox log: 0 violations, 0 would-be-refused under enforce, 0 restarts, 0 suspensions.

### Module sandbox: audit (--moduleSandbox audit)

| Payload | Concurrency | Direct peer channel p50 | Direct peer channel p99 | Direct peer channel req/s |
|---|---|---|---|---|
| 1KB | 1 | 1.46ms [1.43ms–1.86ms] | 3.91ms [3.84ms–5.02ms] | 194 [163–195] |
| 1KB | 16 | 10.71ms [10.30ms–12.65ms] | 27.56ms [24.25ms–30.50ms] | 405 [361–421] |
| 1KB | 64 | 44.57ms [23.02ms–73.69ms] | 79.87ms [36.19ms–110.65ms] | 638 [446–685] |
| 100KB | 1 | 1.36ms [1.35ms–1.41ms] | 6.49ms [3.44ms–9.12ms] | 228 [221–230] |
| 100KB | 16 | 10.26ms [9.91ms–10.95ms] | 32.67ms [17.68ms–36.61ms] | 519 [460–617] |
| 100KB | 64 | 49.29ms [15.80ms–54.28ms] | 73.90ms [37.56ms–96.19ms] | 691 [633–893] |
| 1MB | 1 | 4.83ms [4.71ms–4.86ms] | 14.60ms [13.44ms–18.02ms] | 124 [122–125] |
| 1MB | 16 | 49.33ms [46.62ms–62.25ms] | 100.89ms [88.94ms–117.46ms] | 169 [160–171] |
| 1MB | 64 | 205.31ms [184.31ms–220.64ms] | 347.68ms [289.97ms–367.51ms] | 174 [173–185] |

*Noise floor: the largest spread of any single configuration across the 3 runs, as (max - min) / median: p50 114% (Direct peer channel 1KB/c=64); p99 93% (Direct peer channel 1KB/c=64); throughput 38% (Direct peer channel 100KB/c=64).*

Errors: none. Sandbox log: 0 violations, 0 would-be-refused under enforce, 0 restarts, 0 suspensions.

### Module sandbox: enforce (--moduleSandbox enforce)

| Payload | Concurrency | Direct peer channel p50 | Direct peer channel p99 | Direct peer channel req/s |
|---|---|---|---|---|
| 1KB | 1 | 1.49ms [1.35ms–1.61ms] | 6.35ms [2.63ms–7.08ms] | 191 [164–229] |
| 1KB | 16 | 10.27ms [8.40ms–10.77ms] | 21.57ms [21.38ms–24.81ms] | 503 [404–515] |
| 1KB | 64 | 34.65ms [30.91ms–47.83ms] | 77.30ms [58.04ms–92.43ms] | 534 [390–641] |
| 100KB | 1 | 1.41ms [1.33ms–1.55ms] | 6.36ms [5.93ms–9.75ms] | 212 [194–226] |
| 100KB | 16 | 8.53ms [7.94ms–10.23ms] | 24.09ms [18.36ms–25.11ms] | 564 [545–638] |
| 100KB | 64 | 41.99ms [29.21ms–48.87ms] | 57.87ms [57.34ms–61.41ms] | 704 [685–711] |
| 1MB | 1 | 5.43ms [4.92ms–5.43ms] | 15.08ms [15.00ms–15.28ms] | 115 [113–124] |
| 1MB | 16 | 54.67ms [50.24ms–61.46ms] | 120.21ms [114.16ms–135.85ms] | 150 [149–167] |
| 1MB | 64 | 178.09ms [161.90ms–233.68ms] | 304.60ms [303.69ms–370.45ms] | 205 [190–210] |

*Noise floor: the largest spread of any single configuration across the 3 runs, as (max - min) / median: p50 49% (Direct peer channel 1KB/c=64); p99 70% (Direct peer channel 1KB/c=1); throughput 47% (Direct peer channel 1KB/c=64).*

Errors: none. Sandbox log: 0 violations, 0 would-be-refused under enforce, 0 restarts, 0 suspensions.

**Direct peer channel, audit vs. off, p50** (positive = audit slower): 1KB/c=1 +5% (within noise), 1KB/c=16 +47% (within noise), 1KB/c=64 +45% (within noise), 100KB/c=1 -3% (within noise), 100KB/c=16 +11% (within noise), 100KB/c=64 +58% (within noise), 1MB/c=1 +6% (within noise), 1MB/c=16 +8% (within noise), 1MB/c=64 +7% (within noise). Cells where audit is more than 10% slower with non-overlapping ranges: 0.

**Direct peer channel, audit vs. off, throughput** (positive = audit slower): 1KB/c=1 -8% (within noise), 1KB/c=16 -3% (within noise), 1KB/c=64 -33% (within noise), 100KB/c=1 -16% (faster), 100KB/c=16 +4% (within noise), 100KB/c=64 +0% (within noise), 1MB/c=1 +5% (within noise), 1MB/c=16 +11% (slower), 1MB/c=64 +17% (within noise). Cells where audit is more than 10% slower with non-overlapping ranges: 1.

**Direct peer channel, enforce vs. off, p50** (positive = enforce slower): 1KB/c=1 +7% (within noise), 1KB/c=16 +41% (within noise), 1KB/c=64 +13% (within noise), 100KB/c=1 -0% (within noise), 100KB/c=16 -8% (within noise), 100KB/c=64 +34% (within noise), 1MB/c=1 +19% (within noise), 1MB/c=16 +20% (within noise), 1MB/c=64 -7% (within noise). Cells where enforce is more than 10% slower with non-overlapping ranges: 0.

**Direct peer channel, enforce vs. off, throughput** (positive = enforce slower): 1KB/c=1 -7% (within noise), 1KB/c=16 -22% (within noise), 1KB/c=64 -20% (within noise), 100KB/c=1 -10% (within noise), 100KB/c=16 -4% (within noise), 100KB/c=64 -1% (within noise), 1MB/c=1 +13% (within noise), 1MB/c=16 +25% (slower), 1MB/c=64 -1% (within noise). Cells where enforce is more than 10% slower with non-overlapping ranges: 1.
