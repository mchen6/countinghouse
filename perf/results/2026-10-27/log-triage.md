Machine: 2 x Intel(R) Core(TM) i7-6600U CPU @ 2.60GHz, 7.2 GB, Node v24.21.0, linux 7.0.0-38-generic
Runs: 3, each in a fresh process. Cells are the median across runs, [min–max] across runs.
Module sandbox: audit (default)
Repetitions: 25 per cell after 5 warm-up calls, per run. Times in ms: median across runs of each run's median, [min–max] of those medians.
Matrix: full. Servers: --workerThread, non-debug, --mcpToolCallCost 1.

## Module sandbox: audit (default)

Errors: none. Sandbox log: 0 violations, 0 would-be-refused under enforce, 0 restarts, 0 suspensions.

### Latency against files read (400 lines per file, the first N files of a directory of 32)

| files | hops | direct | main-thread-routed | in-process | in-process, sequential | runtime adds, direct | runtime adds, main-thread-routed |
|---|---|---|---|---|---|---|---|
| 1 | 4 | 19.9 [18.6–21.7] | 21.7 [18.6–26.7] | 6.51 [5.50–7.12] | 6.09 [5.43–7.12] | 13.1 [12.8–15.2] | 14.5 [13.1–20.2] |
| 2 | 6 | 23.1 [21.0–25.1] | 22.6 [21.5–24.1] | 9.19 [7.89–10.1] | 10.5 [8.09–10.9] | 15.2 [10.9–15.9] | 14.1 [12.3–14.7] |
| 4 | 10 | 28.4 [28.4–29.6] | 31.0 [28.9–31.9] | 14.8 [14.7–17.7] | 17.9 [17.3–19.4] | 13.6 [11.9–13.7] | 14.2 [14.1–16.3] |
| 8 | 18 | 38.4 [37.8–38.8] | 40.6 [39.2–44.5] | 21.7 [20.9–21.9] | 29.3 [29.2–29.7] | 16.5 [16.1–17.9] | 19.7 [17.5–22.6] |
| 16 | 34 | 58.9 [56.7–59.8] | 59.2 [59.0–63.0] | 36.2 [34.8–36.8] | 48.1 [45.4–50.1] | 22.8 [19.9–25.0] | 24.2 [22.4–26.8] |
| 32 | 66 | 98.5 [97.4–102] | 102 [101–104] | 66.7 [66.6–66.8] | 92.9 [87.9–95.2] | 31.8 [30.5–35.8] | 35.2 [33.8–37.7] |

*Noise floor: the largest spread of any single configuration across the 3 runs is 37% (main-thread-routed 1 file), as (max - min) / median.*

**Per file, direct**: from 1 file to 32, the composite goes from 19.9 [18.6–21.7] ms to 98.5 [97.4–102] ms, 2.54 [2.54–2.60] ms for each further file ((32-file median - 1-file median) / 31, per run). A least-squares line through all 6 file counts fits with r² 0.999 [0.998–0.999].

**Per file, main-thread-routed**: from 1 file to 32, the composite goes from 21.7 [18.6–26.7] ms to 102 [101–104] ms, 2.54 [2.42–2.77] ms for each further file ((32-file median - 1-file median) / 31, per run). A least-squares line through all 6 file counts fits with r² 0.997 [0.993–1.000].

**Bill**: charged per composite call at 1, 2, 4, 8, 16, 32 files: 4, 6, 10, 18, 34, 66 (each further file adds 2).

**Fixed part, direct**: the runtime adds 13.1 [12.8–15.2] ms at 1 file, 15.2 [10.9–15.9] ms at 2 files, 13.6 [11.9–13.7] ms at 4 files (hops 4, 6, 10); per run, the smallest of these is 11.9 [10.9–13.1] ms and the largest 15.2 [13.6–15.9] ms.

**Fixed part, main-thread-routed**: the runtime adds 14.5 [13.1–20.2] ms at 1 file, 14.1 [12.3–14.7] ms at 2 files, 14.2 [14.1–16.3] ms at 4 files (hops 4, 6, 10); per run, the smallest of these is 14.1 [12.3–14.2] ms and the largest 16.3 [14.5–20.2] ms.

**Per hop at 400 lines, direct**: at 32 files the runtime adds 31.8 [30.5–35.8] ms over 66 hops, 0.48 [0.46–0.54] ms per hop.

**Per hop at 400 lines, main-thread-routed**: at 32 files the runtime adds 35.2 [33.8–37.7] ms over 66 hops, 0.53 [0.51–0.57] ms per hop.

### Latency against file size (8 files, 18 hops, a directory of 8 files)

| lines per file | logs in total | direct | main-thread-routed | in-process | in-process, sequential | runtime adds, direct | runtime adds, main-thread-routed | runtime's share, direct | runtime's share, main-thread-routed |
|---|---|---|---|---|---|---|---|---|---|
| 100 | 0.06 MB | 19.1 [18.6–20.0] | 23.1 [20.7–24.6] | 6.59 [6.47–6.64] | 11.7 [10.4–13.7] | 12.5 [12.1–13.5] | 16.6 [14.1–18.0] | 65% [65%–68%] | 72% [68%–73%] |
| 400 | 0.26 MB | 32.1 [31.5–33.0] | 37.5 [34.7–38.4] | 17.6 [16.5–18.1] | 23.6 [23.0–25.4] | 15.0 [13.9–15.6] | 20.3 [17.1–21.0] | 45% [44%–49%] | 53% [49%–56%] |
| 1600 | 1.04 MB | 81.8 [81.5–83.6] | 88.3 [85.6–89.2] | 61.8 [61.6–62.2] | 69.1 [68.5–69.9] | 19.9 [19.6–21.8] | 26.5 [24.0–27.0] | 24% [24%–26%] | 30% [28%–30%] |
| 6400 | 4.17 MB | 311 [299–336] | 312 [310–316] | 245 [244–245] | 255 [252–260] | 66.4 [54.0–91.5] | 67.0 [65.3–71.4] | 21% [18%–27%] | 21% [21%–23%] |

*Noise floor: the largest spread of any single configuration across the 3 runs is 17% (main-thread-routed 100 lines), as (max - min) / median.*

**Runtime's share of the call, direct**: 65% [65%–68%] at 100 lines, 45% [44%–49%] at 400 lines, 24% [24%–26%] at 1600 lines, 21% [18%–27%] at 6400 lines; the handlers' own work is 35% [32%–35%], 55% [51%–56%], 76% [74%–76%], 79% [73%–82%] respectively.

**Per hop by file size, direct**: the runtime adds 0.69 [0.67–0.75] ms at 100, 0.83 [0.77–0.86] ms at 400, 1.11 [1.09–1.21] ms at 1600, 3.69 [3.00–5.08] ms at 6400 lines per file.

**Runtime's share of the call, main-thread-routed**: 72% [68%–73%] at 100 lines, 53% [49%–56%] at 400 lines, 30% [28%–30%] at 1600 lines, 21% [21%–23%] at 6400 lines; the handlers' own work is 28% [27%–32%], 47% [44%–51%], 70% [70%–72%], 79% [77%–79%] respectively.

**Per hop by file size, main-thread-routed**: the runtime adds 0.92 [0.78–1.00] ms at 100, 1.13 [0.95–1.16] ms at 400, 1.47 [1.33–1.50] ms at 1600, 3.72 [3.63–3.96] ms at 6400 lines per file.

**Same baseline cell, measured twice per run**: 8 of the 32 files, 400 lines, came out at 21.7 [20.9–21.9] ms in the files sweep and 21.5 [21.2–22.2] ms when measured again at the end of the baseline phase; within each run the two differ by 3% [2%–6%].

**Concurrent against sequential baseline** (8 files): 6.59 [6.47–6.64] against 11.7 [10.4–13.7] ms at 100 lines (concurrent lower), 17.6 [16.5–18.1] against 23.6 [23.0–25.4] ms at 400 lines (concurrent lower), 61.8 [61.6–62.2] against 69.1 [68.5–69.9] ms at 1600 lines (concurrent lower), 245 [244–245] against 255 [252–260] ms at 6400 lines (concurrent lower). Runtime adds and shares above use the concurrent one.


### Direct against routed

| case | direct | routed | direct is lower by | verdict |
|---|---|---|---|---|
| 1 file, 400 lines | 19.9 [18.6–21.7] | 21.7 [18.6–26.7] | 8% | within noise |
| 2 files, 400 lines | 23.1 [21.0–25.1] | 22.6 [21.5–24.1] | -2% | within noise |
| 4 files, 400 lines | 28.4 [28.4–29.6] | 31.0 [28.9–31.9] | 8% | within noise |
| 8 files, 400 lines | 38.4 [37.8–38.8] | 40.6 [39.2–44.5] | 5% | direct lower |
| 16 files, 400 lines | 58.9 [56.7–59.8] | 59.2 [59.0–63.0] | 0% | within noise |
| 32 files, 400 lines | 98.5 [97.4–102] | 102 [101–104] | 3% | within noise |
| 8 files, 100 lines | 19.1 [18.6–20.0] | 23.1 [20.7–24.6] | 17% | direct lower |
| 8 files, 1600 lines | 81.8 [81.5–83.6] | 88.3 [85.6–89.2] | 7% | direct lower |
| 8 files, 6400 lines | 311 [299–336] | 312 [310–316] | 0% | within noise |
| 8 files, 400 lines (size sweep) | 32.1 [31.5–33.0] | 37.5 [34.7–38.4] | 14% | direct lower |

**Direct against routed**: the direct path is lower in 4 of 10 cases by 5% to 17% of the routed median (8 files, 400 lines; 8 files, 100 lines; 8 files, 1600 lines; 8 files, 400 lines (size sweep)); routed is lower in 0; 6 are within noise (1 file, 400 lines; 2 files, 400 lines; 4 files, 400 lines; 16 files, 400 lines; 32 files, 400 lines; 8 files, 6400 lines).

### One composite call against the same hops made by the client (8 files of 400 lines)

| | tool calls | latency, direct server | latency, main-thread-routed server | bytes sent | bytes received |
|---|---|---|---|---|---|
| composite | 1 | 35.7 [33.0–37.6] | 38.0 [37.8–38.1] | 167 | 14436 |
| client-orchestrated | 18 | 95.7 [95.1–108] | 87.1 [83.1–102] | 549495 | 1119438 |

*Noise floor: the largest spread of any single configuration across the 3 runs is 22% (client main-thread-routed), as (max - min) / median.*

**Composite against client, direct server**: one composite call takes 35.7 [33.0–37.6] ms against 95.7 [95.1–108] ms for the 18 client calls, lower; the client takes 2.90× [2.53×–3.03×] as long, per run.

**Composite against client, main-thread-routed server**: one composite call takes 38.0 [37.8–38.1] ms against 87.1 [83.1–102] ms for the 18 client calls, lower; the client takes 2.28× [2.19×–2.69×] as long, per run.

**Bytes on the wire**: the composite moves 14603 bytes (14.6 KB) and the client-orchestrated version 1668933 bytes (1.67 MB), 114 times as much. Identical in every run and on both paths.


## Where the work itself goes (in-process, no runtime)

Each cell is the median run of that case, then the median across runs.

| files | lines per file | total | list | read | redact | cluster |
|---|---|---|---|---|---|---|
| 1 | 400 | 6.09 [5.43–7.12] | 3.16 [2.76–4.32] | 0.67 [0.55–0.82] | 1.50 [1.42–1.76] | 0.54 [0.47–0.57] |
| 2 | 400 | 10.5 [8.09–10.9] | 4.88 [3.01–5.74] | 1.77 [1.00–1.84] | 2.78 [2.42–2.95] | 1.02 [0.86–1.09] |
| 4 | 400 | 17.9 [17.3–19.4] | 5.79 [4.78–7.13] | 4.21 [3.34–4.67] | 5.04 [4.89–8.13] | 1.75 [1.63–3.00] |
| 8 | 400 | 29.3 [29.2–29.7] | 6.89 [6.83–6.99] | 8.33 [8.29–8.49] | 10.3 [9.75–10.6] | 3.65 [3.38–4.37] |
| 16 | 400 | 48.1 [45.4–50.1] | 5.73 [3.32–7.02] | 11.7 [8.81–14.2] | 21.5 [20.5–24.6] | 8.33 [8.14–8.90] |
| 32 | 400 | 92.9 [87.9–95.2] | 6.06 [5.47–7.52] | 29.0 [22.5–34.1] | 40.3 [40.3–41.8] | 16.1 [14.3–17.1] |
| 8 | 100 | 11.7 [10.4–13.7] | 1.45 [1.20–1.93] | 6.60 [5.40–8.10] | 2.79 [2.79–2.86] | 0.84 [0.82–0.85] |
| 8 | 1600 | 69.1 [68.5–69.9] | 1.68 [1.58–1.78] | 11.0 [10.7–11.6] | 40.6 [39.8–41.1] | 15.4 [15.1–16.8] |
| 8 | 6400 | 255 [252–260] | 1.32 [1.02–7.50] | 23.2 [21.7–23.4] | 165 [163–170] | 63.3 [53.6–68.4] |

**Stage shares** (of the four stages' sum, cases with 8 or more files, median across runs): redact 24% to 65%, cluster 7% to 25%, read 9% to 57%.

