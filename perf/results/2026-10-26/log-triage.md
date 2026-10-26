Machine: 2 x Intel(R) Core(TM) i7-6600U CPU @ 2.60GHz, 7.2 GB, Node v24.21.0, linux 7.0.0-38-generic
Runs: 3, each in a fresh process. Cells are the median across runs, [min–max] across runs.
Module sandbox: audit (default)
Repetitions: 25 per cell after 5 warm-up calls, per run. Times in ms: median across runs of each run's median, [min–max] of those medians.
Matrix: full. Servers: --workerThread, non-debug, --mcpToolCallCost 1.

## Module sandbox: audit (default)

Errors: none. Sandbox log: 0 violations, 0 would-be-refused under enforce, 0 restarts, 0 suspensions.

### Latency against files read (400 lines per file)

| files | hops | direct | main-thread-routed | in-process | runtime adds, direct | runtime adds, main-thread-routed |
|---|---|---|---|---|---|---|
| 1 | 4 | 19.3 [18.7–22.2] | 20.6 [19.9–21.5] | 7.04 [4.54–8.07] | 14.7 [10.6–15.2] | 12.8 [12.5–17.0] |
| 2 | 6 | 24.2 [23.6–28.3] | 26.4 [24.2–27.1] | 7.97 [6.12–11.6] | 18.1 [12.0–20.3] | 16.3 [15.5–20.3] |
| 4 | 10 | 28.5 [27.5–33.9] | 33.7 [29.2–35.2] | 13.2 [12.9–14.6] | 15.6 [12.9–20.6] | 20.5 [16.3–20.6] |
| 8 | 18 | 41.4 [41.0–41.7] | 43.9 [43.7–47.1] | 25.3 [24.2–30.7] | 16.1 [10.3–17.5] | 18.4 [13.2–22.8] |
| 16 | 34 | 66.1 [61.3–67.8] | 67.4 [64.8–68.0] | 43.5 [39.7–44.1] | 22.5 [21.5–23.7] | 23.4 [21.2–28.2] |
| 32 | 66 | 107 [104–110] | 118 [114–118] | 86.4 [81.7–93.4] | 20.7 [10.5–28.2] | 31.7 [20.2–36.8] |

*Noise floor: the largest spread of any single configuration across the 3 runs is 68% (in-process 2 files), as (max - min) / median.*

**Per file, direct**: from 1 file to 32, the composite goes from 19.3 [18.7–22.2] ms to 107 [104–110] ms, 2.74 [2.73–2.94] ms for each further file ((32-file median - 1-file median) / 31, per run). A least-squares line through all 6 file counts fits with r² 0.995 [0.995–0.997].

**Per file, main-thread-routed**: from 1 file to 32, the composite goes from 20.6 [19.9–21.5] ms to 118 [114–118] ms, 3.16 [2.97–3.17] ms for each further file ((32-file median - 1-file median) / 31, per run). A least-squares line through all 6 file counts fits with r² 0.997 [0.995–0.999].

**Bill**: charged per composite call at 1, 2, 4, 8, 16, 32 files: 4, 6, 10, 18, 34, 66 (each further file adds 2).

**Fixed part, direct**: the runtime adds 14.7 [10.6–15.2] ms at 1 file, 18.1 [12.0–20.3] ms at 2 files, 15.6 [12.9–20.6] ms at 4 files (hops 4, 6, 10); per run, the smallest of these is 12.9 [10.6–14.7] ms and the largest 20.3 [15.6–20.6] ms.

**Fixed part, main-thread-routed**: the runtime adds 12.8 [12.5–17.0] ms at 1 file, 16.3 [15.5–20.3] ms at 2 files, 20.5 [16.3–20.6] ms at 4 files (hops 4, 6, 10); per run, the smallest of these is 12.8 [12.5–17.0] ms and the largest 20.5 [16.3–20.6] ms.

**Per hop at 400 lines, direct**: at 32 files the runtime adds 20.7 [10.5–28.2] ms over 66 hops, 0.31 [0.16–0.43] ms per hop.

**Per hop at 400 lines, main-thread-routed**: at 32 files the runtime adds 31.7 [20.2–36.8] ms over 66 hops, 0.48 [0.31–0.56] ms per hop.

### Latency against file size (8 files, 18 hops)

| lines per file | logs in total | direct | main-thread-routed | in-process | runtime adds, direct | runtime adds, main-thread-routed | runtime's share, direct | runtime's share, main-thread-routed |
|---|---|---|---|---|---|---|---|---|
| 100 | 0.06 MB | 19.8 [18.1–20.0] | 21.4 [21.2–22.3] | 12.3 [11.7–13.8] | 6.42 [6.17–7.49] | 8.85 [8.47–9.66] | 35% [31%–38%] | 42% [38%–45%] |
| 400 | 0.26 MB | 35.7 [34.5–36.0] | 39.0 [36.0–40.2] | 20.5 [20.2–21.4] | 15.4 [13.1–15.5] | 18.5 [14.6–20.0] | 43% [38%–43%] | 47% [41%–50%] |
| 1600 | 1.04 MB | 88.7 [86.8–88.7] | 96.0 [94.6–97.3] | 72.5 [69.1–74.5] | 14.3 [14.3–19.6] | 22.1 [21.6–28.2] | 16% [16%–22%] | 23% [22%–29%] |
| 6400 | 4.17 MB | 317 [312–327] | 344 [340–352] | 268 [263–268] | 53.5 [44.5–58.4] | 76.3 [71.7–88.5] | 17% [14%–18%] | 22% [21%–25%] |

*Noise floor: the largest spread of any single configuration across the 3 runs is 17% (in-process 100 lines), as (max - min) / median.*

**Runtime's share of the call, direct**: 35% [31%–38%] at 100 lines, 43% [38%–43%] at 400 lines, 16% [16%–22%] at 1600 lines, 17% [14%–18%] at 6400 lines; the handlers' own work is 65% [62%–69%], 57% [57%–62%], 84% [78%–84%], 83% [82%–86%] respectively.

**Per hop by file size, direct**: the runtime adds 0.36 [0.34–0.42] ms at 100, 0.86 [0.73–0.86] ms at 400, 0.79 [0.79–1.09] ms at 1600, 2.97 [2.47–3.25] ms at 6400 lines per file.

**Runtime's share of the call, main-thread-routed**: 42% [38%–45%] at 100 lines, 47% [41%–50%] at 400 lines, 23% [22%–29%] at 1600 lines, 22% [21%–25%] at 6400 lines; the handlers' own work is 58% [55%–62%], 53% [50%–59%], 77% [71%–78%], 78% [75%–79%] respectively.

**Per hop by file size, main-thread-routed**: the runtime adds 0.49 [0.47–0.54] ms at 100, 1.03 [0.81–1.11] ms at 400, 1.23 [1.20–1.56] ms at 1600, 4.24 [3.98–4.92] ms at 6400 lines per file.

**Same baseline, measured twice per run**: the in-process baseline for 8 files of 400 lines is 25.3 [24.2–30.7] ms in the files sweep and 20.5 [20.2–21.4] ms in the size sweep; within each run the two differ by 18% [18%–52%].

### Direct against routed

| case | direct | routed | direct is lower by | verdict |
|---|---|---|---|---|
| 1 file, 400 lines | 19.3 [18.7–22.2] | 20.6 [19.9–21.5] | 6% | within noise |
| 2 files, 400 lines | 24.2 [23.6–28.3] | 26.4 [24.2–27.1] | 8% | within noise |
| 4 files, 400 lines | 28.5 [27.5–33.9] | 33.7 [29.2–35.2] | 15% | within noise |
| 8 files, 400 lines | 41.4 [41.0–41.7] | 43.9 [43.7–47.1] | 6% | direct lower |
| 16 files, 400 lines | 66.1 [61.3–67.8] | 67.4 [64.8–68.0] | 2% | within noise |
| 32 files, 400 lines | 107 [104–110] | 118 [114–118] | 9% | direct lower |
| 8 files, 100 lines | 19.8 [18.1–20.0] | 21.4 [21.2–22.3] | 7% | direct lower |
| 8 files, 1600 lines | 88.7 [86.8–88.7] | 96.0 [94.6–97.3] | 8% | direct lower |
| 8 files, 6400 lines | 317 [312–327] | 344 [340–352] | 8% | direct lower |
| 8 files, 400 lines (size sweep) | 35.7 [34.5–36.0] | 39.0 [36.0–40.2] | 9% | within noise |

**Direct against routed**: the direct path is lower in 5 of 10 cases by 6% to 9% of the routed median (8 files, 400 lines; 32 files, 400 lines; 8 files, 100 lines; 8 files, 1600 lines; 8 files, 6400 lines); routed is lower in 0; 5 are within noise (1 file, 400 lines; 2 files, 400 lines; 4 files, 400 lines; 16 files, 400 lines; 8 files, 400 lines (size sweep)).

### One composite call against the same hops made by the client (8 files of 400 lines)

| | tool calls | latency, direct server | latency, main-thread-routed server | bytes sent | bytes received |
|---|---|---|---|---|---|
| composite | 1 | 38.5 [37.2–42.8] | 40.0 [38.1–42.3] | 167 | 14436 |
| client-orchestrated | 18 | 113 [108–114] | 99.9 [97.1–105] | 549495 | 1119438 |

*Noise floor: the largest spread of any single configuration across the 3 runs is 15% (composite direct), as (max - min) / median.*

**Composite against client, direct server**: one composite call takes 38.5 [37.2–42.8] ms against 113 [108–114] ms for the 18 client calls, lower; the client takes 2.81× [2.67×–3.04×] as long, per run.

**Composite against client, main-thread-routed server**: one composite call takes 40.0 [38.1–42.3] ms against 99.9 [97.1–105] ms for the 18 client calls, lower; the client takes 2.48× [2.43×–2.62×] as long, per run.

**Bytes on the wire**: the composite moves 14603 bytes (14.6 KB) and the client-orchestrated version 1668933 bytes (1.67 MB), 114 times as much. Identical in every run and on both paths.


## Where the work itself goes (in-process, no runtime)

Each cell is the median run of that case, then the median across runs.

| files | lines per file | total | list | read | redact | cluster |
|---|---|---|---|---|---|---|
| 1 | 400 | 7.04 [4.54–8.07] | 4.40 [2.13–5.05] | 0.60 [0.42–1.00] | 1.45 [1.43–1.48] | 0.54 [0.53–0.55] |
| 2 | 400 | 7.97 [6.12–11.6] | 3.13 [2.20–5.95] | 1.03 [0.69–1.60] | 2.43 [2.38–2.91] | 1.08 [0.83–1.31] |
| 4 | 400 | 13.2 [12.9–14.6] | 3.03 [1.96–3.32] | 2.12 [1.59–2.29] | 5.53 [5.48–8.92] | 2.08 [2.03–2.21] |
| 8 | 400 | 25.3 [24.2–30.7] | 4.91 [4.02–7.11] | 6.17 [6.17–8.71] | 10.6 [10.1–10.7] | 4.04 [3.19–4.12] |
| 16 | 400 | 43.5 [39.7–44.1] | 4.02 [3.93–4.33] | 9.11 [8.31–11.3] | 21.5 [20.8–22.0] | 6.74 [6.45–8.22] |
| 32 | 400 | 86.4 [81.7–93.4] | 3.38 [2.01–3.48] | 16.4 [15.6–18.8] | 49.5 [45.3–57.8] | 16.1 [14.0–17.4] |
| 8 | 100 | 12.3 [11.7–13.8] | 1.53 [1.47–1.97] | 7.07 [6.77–8.32] | 2.67 [2.61–2.79] | 0.82 [0.81–0.89] |
| 8 | 1600 | 72.5 [69.1–74.5] | 0.95 [0.93–1.17] | 8.43 [7.54–8.96] | 46.9 [46.2–48.2] | 14.2 [14.0–18.0] |
| 8 | 6400 | 268 [263–268] | 1.99 [1.39–2.03] | 28.1 [25.1–31.9] | 172 [169–176] | 62.9 [55.1–66.8] |

**Stage shares** (of the four stages' sum, cases with 8 or more files, median across runs): redact 22% to 67%, cluster 7% to 24%, read 11% to 58%.

