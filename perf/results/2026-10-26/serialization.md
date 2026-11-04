Machine: 2 x Intel(R) Core(TM) i7-6600U CPU @ 2.60GHz, 7.2 GB, Node v24.21.0, linux 7.0.0-38-generic
Runs: 3, each in a fresh process. Cells are the median across runs, [min–max] across runs.
Module sandbox: n/a (no countinghouse server involved)
Round trips per cell: 300.

| Payload | `JSON.stringify` p50 | Structured clone p50 | Transfer list p50 |
|---|---|---|---|
| 1KB | 0.24ms [0.12ms–0.25ms] | **0.05ms [0.05ms–0.05ms]** | 0.28ms [0.11ms–0.28ms] |
| 100KB | 0.73ms [0.69ms–0.76ms] | **0.24ms [0.24ms–0.26ms]** | 0.86ms [0.85ms–0.93ms] |
| 1MB | 10.88ms [10.78ms–12.40ms] | **3.31ms [3.29ms–3.45ms]** | 11.31ms [10.79ms–11.55ms] |

*Noise floor: the largest spread of any single configuration across the 3 runs is 62% (transfer list at 1KB), as (max - min) / median.*

Lowest median per payload size: 1KB=structuredClone, 100KB=structuredClone, 1MB=structuredClone. Structured clone against `JSON.stringify`: 1KB faster, 100KB faster, 1MB faster. Structured clone is faster than `JSON.stringify` at every size tested, with non-overlapping ranges. Ratio of medians (`JSON.stringify` / structured clone) ranges from 2.97× (at 100KB) to 4.73× (at 1KB).
