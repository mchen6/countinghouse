Machine: 2 x Intel(R) Core(TM) i7-6600U CPU @ 2.60GHz, 7.2 GB, Node v24.21.0, linux 7.0.0-38-generic
Runs: 3, each in a fresh process. Cells are the median across runs, [min–max] across runs.
Module sandbox: n/a (no countinghouse server involved)
Round trips per cell: 300.

| Payload | `JSON.stringify` p50 | Structured clone p50 | Transfer list p50 |
|---|---|---|---|
| 1KB | 0.241 [0.123–0.253] ms | **0.0509 [0.0487–0.0534] ms** | 0.278 [0.109–0.283] ms |
| 100KB | 0.726 [0.693–0.764] ms | **0.245 [0.240–0.259] ms** | 0.863 [0.854–0.931] ms |
| 1MB | 10.9 [10.8–12.4] ms | **3.31 [3.29–3.45] ms** | 11.3 [10.8–11.5] ms |

*Noise floor: the largest spread of any single configuration across the 3 runs is 62% (transfer list at 1KB), as (max - min) / median.*

Lowest median per payload size: 1KB=structuredClone, 100KB=structuredClone, 1MB=structuredClone. Structured clone against `JSON.stringify`: 1KB faster, 100KB faster, 1MB faster. Structured clone is faster than `JSON.stringify` at every size tested, with non-overlapping ranges. Ratio of medians (`JSON.stringify` / structured clone) ranges from 2.97× (at 100KB) to 4.73× (at 1KB).
