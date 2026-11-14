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

## Proposal 4: the main thread's profile, and one change it suggested

`perf/fs-broker-profile.js` runs R (3 × 250 rounds), S and W under `enforce`
with the server's main thread under `--cpu-prof`. Of 42.9 s profiled, the
main thread was idle 55.5%. Where the rest went (self time):

| Share | What |
|---|---|
| ~15% | the fs bindings the broker's checks and operations call (`lstat` 4.3%, `realpath` 3.0%, `fstat` 2.9%, `close` 2.2%, the write 1.7%, `stat` 1.2%, `open` 1.1%, `readlink` 1.1%, `ftruncate` 0.9%) |
| 7.2% | the garbage collector |
| 5.0% | (program) |
| 2.6% | `lib/fs-broker/server.js`, nearly all `reply` (`postMessage` and its structured clone) |
| 1.4% | `lib/fs-broker/broker.js` |
| 1.4% | `node:internal/fs/promises` |

The hand-offs, not the broker's JavaScript, are where the main thread
works: proposals 1, 3 and 5 are aimed there. No read in these workloads is
64 KB or more, so transferring large results would move nothing here.

The JavaScript the profile did show was the bridge's own per-request
allocations: a timer, a timeout promise, `Promise.race` and `finally` for
each request. The candidate (branch `b-fsb-p4-sweep`, `9066c5a`) checks every
pending request's deadline with one sweep instead. Measured against
`d5191d2` in three alternating sessions; `perf/fs-broker-workloads.js` now
also records the CPU time of the server's main thread over each call, which
the machine's other load moves far less than wall-clock:

| | before | after |
|---|---|---|
| R, `enforce`: main-thread CPU (sessions' medians) | 820, 690, 750 ms | 750, 780, 730 ms |
| S, `enforce`: main-thread CPU | 1 520, 1 460, 1 700 ms | 1 430, 1 600, 1 620 ms |
| W, `enforce`: main-thread CPU | 580, 540, 560 ms | 590, 630, 560 ms |
| R, `enforce` (wall, `perf/fs-broker-io-perf.js`) | 1 779, 1 289, 2 543 ms | 2 286, 1 426, 1 313 ms |
| R, 10 modules, `enforce` (all 10) | 1 250, 1 280, 1 373 ms | 895, 1 076, 1 082 ms |
| S, `off` (wall) | 1 802, 1 877, 1 939 ms | 1 420, 2 323, 2 487 ms |

The main thread's CPU did not move, so the change saves no measurable work.
R with 10 modules ran faster beyond its spread while S under `off` ran slower
in the median (with a wide spread after). That is a mixed result: by the
spec's rule it goes to the user with both numbers, and the recommendation is
**not to keep it** (no work saved, one workload possibly slower).

## Proposal 3: compound ops -- the trace finds nothing to fold

The spec takes the candidates from a trace of the bridge calls
(`perf/fs-broker-trace.js`: a preload in the server records each call the
broker serves). Under `enforce`:

| Workload | Bridge calls | By op | Same-path sequences |
|---|---|---|---|
| L: a reload of the module that requires 300 packages | 11 | `readFile` 4, `exists` 3, `stat` 2, `readdir` 2 | `stat` → `readdir` 2 |
| W: one walk of 3 000 files | 3 061 | `stat` 3 030, `readdir` 31 | `stat` → `readdir` 30 |
| seeding the tree (`mkdir -p`, 50 small files) | 56 | `writeFile` 50, `mkdir` 5, `rm` 1 | none |
| S: 100 writes to one descriptor | 102 | `write` 100, `open` 1, `close` 1 | `write` → `write` 99 |

- The dependency loader's reads do not go through the broker: the patch
  serves them from the loader's grants. L's time is the worker's start and
  the loader's own work, not bridge calls.
- `mkdir -p`, `writeFile`, `readFile`, `exists` and `rm` are already one
  brokered call each.
- W's and S's sequences are the module's own calls, one after another (a
  `stat` per entry, a `write` per write). Folding them would mean the worker
  answering a later call from an earlier one (prefetched stats, batched
  writes): a change of what the module sees, not a compound op, which the
  spec does not allow. S is proposal 1's.
- The one multi-call sequence the patch issues itself is `fs.cp`/`cpSync`:
  per file `lstat`, `exists`, `unlink` when the target exists, and
  `copyFile` (3-4 calls); per directory `lstat`, `mkdir` and `readdir`. A
  compound `cp` would have to carry every per-entry check (the namespace,
  read-only roots, the quota, the link rules, the always-denied set) into
  one broker op. Module code rarely copies trees, so this is not
  recommended unless a module needs it.

So proposal 3 adds no op: there is nothing in the workloads to fold.

## Where the five proposals ended (2026-11-14)

| Proposal | Result |
|---|---|
| 2: no readlink for an existing file in `/data`/`/tmp` | **Dropped.** One pool job fewer per `enforce` round (26 → 25); no wall-clock gain beyond the sessions' spread, and it would add a residual against the host. Code and tests on `b-fsb-p2`. |
| 4: profile the main thread, fix what it shows | **Waiting on the user.** The profile: fs bindings about 15% of the main thread, GC 7%, the broker's own JavaScript under 4%. Its one candidate (one deadline sweep instead of a timer per request, `b-fsb-p4-sweep`) saves no main-thread CPU and gave mixed wall-clock results; recommended not kept. |
| 3: compound ops | **Nothing to fold.** The trace shows the loader's reads bypass the broker, the common calls are already single ops, and the rest are the module's own call sequences. No op added; a compound `cp` only if a module needs one. |
| 1: direct I/O on verified descriptors, with write leases | **Deferred until after the first release.** With the broker's own JavaScript under 4% of the main thread, the remaining cost is the hand-offs themselves; proposal 1 is the one change aimed there, but it is large and opens a security boundary (the worker holding real descriptors). |
| 5: file threads | Not started: it follows proposal 1 in the landing order. |
