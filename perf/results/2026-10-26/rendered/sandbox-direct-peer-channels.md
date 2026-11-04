Machine: 2 x Intel(R) Core(TM) i7-6600U CPU @ 2.60GHz, 7.2 GB, Node v24.21.0, linux 7.0.0-38-generic
Runs: 3, each in a fresh process. Cells are the median across runs, [min–max] across runs.
Module sandbox: off (--moduleSandbox off)
Requests per cell: 150. Server flags beyond the defaults: --mcpToolCallCost 1.

### Module sandbox: off (--moduleSandbox off)

| Payload | Concurrency | Direct peer channel p50 | Direct peer channel p99 | Direct peer channel req/s |
|---|---|---|---|---|
| 1KB | 1 | 1.39 [1.28–1.57] ms | 4.02 [3.69–4.11] ms | 178 [160–188] |
| 1KB | 16 | 7.26 [6.54–10.9] ms | 21.4 [19.1–38.9] ms | 395 [301–435] |
| 1KB | 64 | 30.7 [23.1–44.4] ms | 58.1 [43.1–92.1] ms | 429 [334–485] |
| 100KB | 1 | 1.41 [1.39–1.60] ms | 12.0 [9.44–20.0] ms | 192 [149–199] |
| 100KB | 16 | 9.27 [7.51–11.9] ms | 19.5 [19.0–28.9] ms | 540 [380–577] |
| 100KB | 64 | 31.3 [23.4–58.3] ms | 54.2 [46.8–73.2] ms | 694 [664–732] |
| 1MB | 1 | 4.55 [4.53–5.41] ms | 13.4 [12.3–14.1] ms | 130 [113–132] |
| 1MB | 16 | 45.5 [44.2–51.5] ms | 102 [76.6–123] ms | 188 [183–196] |
| 1MB | 64 | 192 [136–257] ms | 309 [250–431] ms | 203 [160–209] |

*Noise floor: the largest spread of any single configuration across the 3 runs, as (max - min) / median: p50 112% (Direct peer channel 100KB/c=64); p99 93% (Direct peer channel 1KB/c=16); throughput 37% (Direct peer channel 100KB/c=16).*

Errors: none. Sandbox log: 0 violations, 0 would-be-refused under enforce, 0 restarts, 0 suspensions.

### Module sandbox: audit (--moduleSandbox audit)

| Payload | Concurrency | Direct peer channel p50 | Direct peer channel p99 | Direct peer channel req/s |
|---|---|---|---|---|
| 1KB | 1 | 1.46 [1.43–1.86] ms | 3.91 [3.84–5.02] ms | 194 [163–195] |
| 1KB | 16 | 10.7 [10.3–12.6] ms | 27.6 [24.3–30.5] ms | 405 [361–421] |
| 1KB | 64 | 44.6 [23.0–73.7] ms | 79.9 [36.2–111] ms | 638 [446–685] |
| 100KB | 1 | 1.36 [1.35–1.41] ms | 6.49 [3.44–9.12] ms | 228 [221–230] |
| 100KB | 16 | 10.3 [9.91–11.0] ms | 32.7 [17.7–36.6] ms | 519 [460–617] |
| 100KB | 64 | 49.3 [15.8–54.3] ms | 73.9 [37.6–96.2] ms | 691 [633–893] |
| 1MB | 1 | 4.83 [4.71–4.86] ms | 14.6 [13.4–18.0] ms | 124 [122–125] |
| 1MB | 16 | 49.3 [46.6–62.2] ms | 101 [88.9–117] ms | 169 [160–171] |
| 1MB | 64 | 205 [184–221] ms | 348 [290–368] ms | 174 [173–185] |

*Noise floor: the largest spread of any single configuration across the 3 runs, as (max - min) / median: p50 114% (Direct peer channel 1KB/c=64); p99 93% (Direct peer channel 1KB/c=64); throughput 38% (Direct peer channel 100KB/c=64).*

Errors: none. Sandbox log: 0 violations, 0 would-be-refused under enforce, 0 restarts, 0 suspensions.

### Module sandbox: enforce (--moduleSandbox enforce)

| Payload | Concurrency | Direct peer channel p50 | Direct peer channel p99 | Direct peer channel req/s |
|---|---|---|---|---|
| 1KB | 1 | 1.49 [1.35–1.61] ms | 6.35 [2.63–7.08] ms | 191 [164–229] |
| 1KB | 16 | 10.3 [8.40–10.8] ms | 21.6 [21.4–24.8] ms | 503 [404–515] |
| 1KB | 64 | 34.6 [30.9–47.8] ms | 77.3 [58.0–92.4] ms | 534 [390–641] |
| 100KB | 1 | 1.41 [1.33–1.55] ms | 6.36 [5.93–9.75] ms | 212 [194–226] |
| 100KB | 16 | 8.53 [7.94–10.2] ms | 24.1 [18.4–25.1] ms | 564 [545–638] |
| 100KB | 64 | 42.0 [29.2–48.9] ms | 57.9 [57.3–61.4] ms | 704 [685–711] |
| 1MB | 1 | 5.43 [4.92–5.43] ms | 15.1 [15.0–15.3] ms | 115 [113–124] |
| 1MB | 16 | 54.7 [50.2–61.5] ms | 120 [114–136] ms | 150 [149–167] |
| 1MB | 64 | 178 [162–234] ms | 305 [304–370] ms | 205 [190–210] |

*Noise floor: the largest spread of any single configuration across the 3 runs, as (max - min) / median: p50 49% (Direct peer channel 1KB/c=64); p99 70% (Direct peer channel 1KB/c=1); throughput 47% (Direct peer channel 1KB/c=64).*

Errors: none. Sandbox log: 0 violations, 0 would-be-refused under enforce, 0 restarts, 0 suspensions.

**Direct peer channel, audit vs. off, p50** (positive = audit slower): 1KB/c=1 +5% (within noise), 1KB/c=16 +47% (within noise), 1KB/c=64 +45% (within noise), 100KB/c=1 -3% (within noise), 100KB/c=16 +11% (within noise), 100KB/c=64 +58% (within noise), 1MB/c=1 +6% (within noise), 1MB/c=16 +8% (within noise), 1MB/c=64 +7% (within noise). Cells where audit is more than 10% slower with non-overlapping ranges: 0.

**Direct peer channel, audit vs. off, throughput** (positive = audit slower): 1KB/c=1 -8% (within noise), 1KB/c=16 -3% (within noise), 1KB/c=64 -33% (within noise), 100KB/c=1 -16% (faster), 100KB/c=16 +4% (within noise), 100KB/c=64 +0% (within noise), 1MB/c=1 +5% (within noise), 1MB/c=16 +11% (slower), 1MB/c=64 +17% (within noise). Cells where audit is more than 10% slower with non-overlapping ranges: 1.

**Direct peer channel, enforce vs. off, p50** (positive = enforce slower): 1KB/c=1 +7% (within noise), 1KB/c=16 +41% (within noise), 1KB/c=64 +13% (within noise), 100KB/c=1 -0% (within noise), 100KB/c=16 -8% (within noise), 100KB/c=64 +34% (within noise), 1MB/c=1 +19% (within noise), 1MB/c=16 +20% (within noise), 1MB/c=64 -7% (within noise). Cells where enforce is more than 10% slower with non-overlapping ranges: 0.

**Direct peer channel, enforce vs. off, throughput** (positive = enforce slower): 1KB/c=1 -7% (within noise), 1KB/c=16 -22% (within noise), 1KB/c=64 -20% (within noise), 100KB/c=1 -10% (within noise), 100KB/c=16 -4% (within noise), 100KB/c=64 -1% (within noise), 1MB/c=1 +13% (within noise), 1MB/c=16 +25% (slower), 1MB/c=64 -1% (within noise). Cells where enforce is more than 10% slower with non-overlapping ranges: 1.
