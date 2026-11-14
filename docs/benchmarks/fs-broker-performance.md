# File broker performance: the re-baseline and each proposal

The measurements the broker performance spec asks for
([docs/superpowers/specs/2026-11-09-fs-broker-performance-design.md](../superpowers/specs/2026-11-09-fs-broker-performance-design.md),
sections 2 and 3): four workloads, each under `--no-workerThread` (no
broker), `--moduleSandbox off` and `enforce`, then each proposal against
the commit before it.

**Setup.** The maintainer's development VM: 2 CPUs, Node v24.21.0,
`UV_THREADPOOL_SIZE` 16 (countinghouse's default), 2026-11-13/14. Each
session ran unattended under the suite lock, once the machine was at least
60% idle, but other sessions shared the VM and the spreads are wide. A
before/after comparison alternates three sessions of each. Scripts:
`perf/fs-broker-io-perf.js` (R, 250 rounds, and the 10-module case),
`perf/fs-broker-workloads.js` (S, W, L, and `--count`),
`perf/fs-broker-ops-count.js` (R's counts).

| Workload | What it is |
|---|---|
| R | 250 rounds of: write 4 KB, read it back, stat it, unlink it, in `/data` |
| S | 10 000 writes of 100 bytes to one descriptor |
| W | readdir and stat over 3 000 files in 30 directories |
| L | a `POST /reload-module` round trip for a module that requires 300 packages (3 files each) at load |

## Re-baseline (`7155f8a`, master `af0db6e` plus the workload scripts)

Medians of 5 runs after a warm-up, in three sessions (the range is the three
sessions' medians):

| Workload | no broker | `off` | `enforce` |
|---|---|---|---|
| R | 28–38 ms | 1 060–1 073 ms | 1 490–1 841 ms |
| R, 10 modules at once (25 rounds each, all 10) | | | 1 154–1 405 ms |
| S | 34–77 ms | 1 720–2 339 ms | 1 868–4 104 ms |
| W | 32–97 ms | 574–774 ms | 1 314–1 835 ms |
| L | 1 202–1 410 ms | 1 797–2 436 ms | 1 714–6 256 ms |

Machine-independent counts, per operation:

| | `off` | `audit` | `enforce` |
|---|---|---|---|
| R: pool jobs per round (4 bridge calls) | 12 | 22 | 26 |
| S: pool jobs per write (1.02 bridge calls) | 1.04 | 2.07 | 2.09 |
| W: pool jobs per entry (1.12 bridge calls) | 1.12 | 2.24 | 2.24 |

Under `audit` and `enforce` every write on a descriptor costs an `fh.stat`
besides the write (the quota's size check), and every walked entry an
`lstat` besides its `stat`: the two hand-offs proposals 1 and 3 aim at.

## Proposal 2: no readlink for an existing file opened in /data or /tmp

`8618fb8` against `7155f8a`, three alternating sessions each:

| | before | after |
|---|---|---|
| R, `enforce`: pool jobs per round | 26 | 25 |
| R, `enforce` (sessions' medians) | 1 418, 2 002, 2 844 ms | 1 510, 1 663, 1 506 ms |
| R, `off` | 898, 971, 1 648 ms | 891, 1 081, 2 720 ms |
| R, 10 modules, `enforce` | 871, 931, 1 472 ms | 1 095, 1 144, 1 389 ms |
| S, `enforce` | 2 616, 3 769, 4 209 ms | 2 700, 2 768, 3 596 ms |
| W, `enforce` | 1 238, 1 384, 1 960 ms | 1 029, 1 252, 1 437 ms |
| L, `enforce` | 1 807, 2 510, 4 950 ms | 1 729, 2 111, 2 644 ms |

It saves the one pool job it should (the readlink of the round's
`readFile`), about 4% of the round's 26. On wall clock no gain exceeds the
spread of the sessions' medians, and the 10-module case moved the other
way, within its spread. By the spec's rule (a gain larger than the spread on
a workload it targets) it is **not kept**: it also adds a residual against
the host (an open of an existing file in `/data` or `/tmp` verified by its
dev/ino alone). Its commit and tests stay on branch `b-fsb-p2` for the final
report.
