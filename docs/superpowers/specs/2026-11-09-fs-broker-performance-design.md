# File broker performance: five proposals

Status: Approved by the user 2026-11-10 (design only; implementation after
R2-1 Task 2 is on master; section 10 decisions taken with the measurements).
Written 2026-11-09 by implementer B with the reviewer (countinghouse-a5), who
holds the user's decisions. Each call that is the reviewer's or mine, not the
user's, is marked. Section 10 lists what the user is asked to confirm.

## 1. Why

A module's file call under the sandbox goes from its worker to the main
thread's file broker and back. The bridge itself is cheap (about 0.1 ms a
round trip, plan 2b). The cost is the main thread's async `fs`: every check
and every operation is a job on libuv's thread pool, and every job is a
hand-off from the main thread to a pool thread and back.

At `9246db1` (docs/benchmarks/sandbox-part2.md, "After the optimisations",
2 CPUs), one benchmark round (write 4 KB, read it back, stat, unlink) is 4
bridge calls and 26 pool jobs under `enforce`, 12 under `off`, against about
9 for the operations themselves. 250 rounds take 1 919 ms under `enforce` and
1 232 ms under `off`, against 29 ms with no broker.

The user chose all five proposals below (2026-11-04), each to be measured on
its own.

## 2. What "it worked" means

**The user's criterion:** "measure each one, report how much they gain,
recommend which to keep", before sandbox part 3. No target number was set.
If the user wants one, they set it after reading the re-baseline (section 3).

**The reviewer's yardstick** (the reviewer's, not the user's): the overhead
is hand-offs, so the pool jobs per round should come down toward the
operation count, and the `enforce`/`off` gap should close toward what the
checks genuinely cost (a stat or two per open).

Every proposal is reported on four workloads:

| Workload | What it stands for | Proposals expected to move it |
|---|---|---|
| R: the 4-op round (`perf/fs-broker-io-perf.js`, `perf/fs-broker-ops-count.js`) | the existing benchmark; path calls only | 2, 3, 4, 5 (not 1: it makes no descriptor calls) |
| S: many small writes to one descriptor (a stream or a logger, e.g. 10 000 × 100-byte appends) | logging, streaming output | 1 |
| L: a dependency-heavy `require` at load (a module with a large `node_modules`) | start-up time | 2, 3, 5 |
| W: a repo walk (readdir + stat over a few thousand files) | the repo-review example's shape | 3, 5 |

S, L and W need new scripts in `perf/` (the builder decides how). Each
reports bridge calls, pool jobs and wall-clock medians under `off` and
`enforce`, plus the 10-module case for R.

## 3. Shared rules for every proposal

- **When:** implementation starts once R2-1 Task 2 (the always-denied set,
  in `place()`/`verifyOpened`) is on master (the reviewer's call). Task 2 is
  security work and small, and it touches the code proposals 2 and 5
  change. This spec is written against Task 2's design: the always-denied
  check runs on the main thread, in the broker, before an operation and
  again on the opened descriptor's dev/ino.
- **Re-baseline first,** on master at that point: `off`, `enforce` and the
  no-broker reference, on the same day on the same VM. Don't reuse the
  `9246db1` or `cd411ee` numbers. FB1–FB3 and R2-1 Task 2 added work, and
  the VM's disk got slower after its upgrade.
- **One commit per proposal,** each with before-and-after numbers on R, S, L
  and W, and the 10-module case for R. Runs are unattended, on an idle
  machine, under the suite lock, never while another suite runs.
- **Nothing weakens `enforce`.** The security tests stay green, and each
  proposal adds tests for the rule it touches. The one residual a proposal
  adds is named in its section (proposal 2, against the host only).
- **Keep or revert** (the reviewer's rule): a proposal is kept if, on at
  least one workload it targets, its gain exceeds the spread of the three
  alternating sessions' medians (sandbox-part2.md's method), AND no other
  workload regresses by more than that spread. Otherwise it is reverted,
  with its numbers recorded. A proposal that speeds one workload and slows
  another goes to the user with both numbers. The implementer doesn't judge
  it.
- **Variants:** proposals 1 and 5 each have measured variants. The work
  carries on with the better one, and the user chooses in the final report.
  The exception: when a security trade decides between variants (1-full vs
  reads-only, 5-B vs 5-A), the work stops and asks the user, through the
  reviewer, before building on it.
- **Landing order:** 2 → 4 → 3 → 1 → 5. Cheap and local first, the largest
  structural change last. Each is measured on top of the ones kept before it.
- **The final report** is one table of what each proposal gained on each
  workload, and a recommendation of which to keep.

## 4. Proposal 2: one readlink fewer per enforce open, in /data and /tmp

Today (`lib/fs-broker/broker.js` `verifyOpened`), under `enforce`, after
every open:

1. `ident.dev/ino` known (the name existed when checked): `fh.stat()` must
   give the same dev/ino.
2. `ident.parent` known (a name being created): the parent's realpath now
   must equal the one checked.
3. `ident == null` (FB2: the parent was missing at the check): the parent's
   realpath now must be in the root the path names, and an lstat of the
   name must give the opened file's dev/ino.

Then, on Linux, in all three cases, `readlink(/proc/self/fd/N)` must be in a
root, and for a write-open in the decided root.

**The change:** skip the readlink in case 1, for opens under `/data` and
`/tmp` only. Keep it for cases 2 and 3 everywhere, and for every open on a
declared path.

**Why only there** (my call, accepted by the reviewer): case 1's dev/ino
comes from the parent's cached real path (up to 1 s old) plus an lstat that
follows links in the middle of the path. In a shared declared `rw`
directory, another module can rename a host-made link that points outside
onto a directory name this broker has cached, because rename doesn't check
link targets. The lstat and the open then reach the same outside inode,
dev/ino match, and the readlink is the only guard left. Under `/data` and
`/tmp`, only this module can change the tree (each of its own exclusive
operations clears its cache) and a host process can too. The sandbox
doesn't defend against a host process.

**The residual this adds, against the host only:** under `/data` and
`/tmp`, within the 1 s cache window, a host process's change can steer an
open of an existing file outside unverified. docs/security-model.md's
host-race entry currently says "under `enforce` every open is still
verified". It is rewritten in the same commit to say exactly this.

Saves one pool job per `enforce` open of an existing file in `/data` and
`/tmp`.

**Tests:**
- The swap-race tests in `test/fs-broker/03-broker.js` (an existing file
  swapped for a symlink; a create whose parent is swapped toward a
  read-only root) and `21-verify-unresolved-parent.js` (FB2) still refuse.
- New: the shared-`rw` rename case above (two brokers on one declared `rw`
  directory; one renames an outside-pointing link onto the other's cached
  directory name; the other's open below it is refused), next to 03's
  swap races.
- New: an open of an existing file in `/data` makes no readlink, and one in
  a declared path still does (counted by the ops-count hook).

## 5. Proposal 4: profile the main thread, transfer large buffers

Run `--cpu-prof` on the main thread during `perf/fs-broker-io-perf.js`
(`off` and `enforce`) and during workloads S and W. Look at the RwLock, the
scheduler, promise chains and structured clone. Where a result buffer is
large and its ArrayBuffer isn't pooled (reads of 64 KB and up,
`readFile`), transfer it instead of copying. Fix what the profile shows, one
measured change at a time. The profile itself (top functions, self time)
goes in the report.

Anything that touches a check (the lock, the order of the checks) is out of
scope here and would need its own section.

## 6. Proposal 1: direct I/O on descriptors the broker verified

### 6.1 The change

Worker threads share the process's descriptor table. Once the broker has
opened (and, under `enforce`, verified) a file, the worker patch can call
the original `fs` read and write on the real descriptor itself, with no
bridge call.

- **Worker mode only.** The single-thread facade (no broker) is unchanged.
- **Modes** (my call): all three broker modes. Under `audit`, leases settle
  but never refuse; under `off`, there is no quota and no lease. `enforce`
  ending up faster than `off` is acceptable.
- The broker's open reply carries the real descriptor too. Module code still
  sees only `0x10000000 + n`, and adoption of any real descriptor number
  stays refused by the patched `fs`, as today. The real number is not a
  secret (it crosses the bridge in the open reply); it is kept off
  reachable objects as hygiene, not as the guard (section 6.4).
- **Direct:** `read`, `write`, `readv`/`writev`, positional reads and
  writes, `fstat`, and FileHandle's equivalents.
- **Still brokered:** `open`, `close` (so the table, settlement and the
  descriptor record stay main's), `ftruncate`, `fchmod`/`fchown`, `fsync`,
  and every call on a descriptor opened on a declared path (it may be a
  network mount). `readFile` and `writeFile` on a path stay one brokered
  call (plan 5 Task 4b B).
- **Sync and async.** Direct sync calls block only the module's own worker,
  which asked for a sync call. Direct callback and promise calls would run
  on libuv's process-wide pool and bypass FsScheduler's global in-flight cap
  and per-worker round-robin, which the broker spec promises "in every
  mode". Two variants are measured (the reviewer's recommendation; the
  promise's change is the user's decision, section 10):
  - **(b) a per-worker cap:** the patch allows at most C direct async
    operations in flight per worker (start with 4) and queues the rest. The
    global bound becomes workers × C.
  - **(d) a shared global counter:** a SharedArrayBuffer with Atomics,
    handed to each worker at spawn and shared with the scheduler, so the
    scheduler's global cap holds without a bridge hop. Per-worker fairness
    is approximated by a per-worker share of it (at most K/N each).
  Whichever lands, the broker spec's scheduler paragraph is amended in the
  same commit.
- **Descriptor reuse** (the reviewer's finding). Direct async operations run
  on libuv from the worker while `close` is brokered through main. If main
  closed the real descriptor while a direct operation on it was still
  queued, the kernel could hand that number to the next open, and the queued
  write would land on a different file, possibly another module's. So:
  - **(a)** the patch keeps a per-descriptor count of direct operations in
    flight and sends `close` only when it reaches zero. A close requested
    earlier waits, as libuv's own `fs.close` after pending operations does.
  - **(b)** at worker end, main settles and closes leased descriptors only
    after `worker.terminate()` has resolved (D1 already waits for it).
    That's safe because a terminated worker's queued libuv requests are
    cancelled with its loop, and requests already running complete before
    `terminate()` resolves. Don't reorder it.
  - Test: a close racing a large direct write never corrupts a second file
    opened right after it.

### 6.2 The write quota: leases

Writes in `/data` and `/tmp` count against the module's quota
(`lib/fs-broker/quota.js`).

- The worker asks main for a lease on a descriptor: min(1 MB, the quota
  left). Main reserves it at once, so lease bytes count as used and ENOSPC
  stays exact: a write past the lease asks for another, and the next lease
  is refused when the quota is spent.
- What is charged is growth in `st_size`, not blocks. A sparse `pwrite` far
  past the end is over-charged, which is the safe direction (as today).
- **Settlement** happens at close, at each lease renewal and at worker end.
  Main `fstat`s the real descriptor (it shares it), charges size growth since
  the last settlement, and returns the unused part of the lease. The quota
  is therefore main-observed, not worker-reported.
- **Per inode, not per descriptor** (the reviewer's finding). Two descriptors
  on one file, or two leases, would both see the same growth at `fstat`, so
  per-descriptor settlement double-charges. The broker keeps the
  last-settled size per (dev, ino) and charges growth against that.
  Brokered operations that change a size (`ftruncate`, `truncate`, `unlink`,
  `rename` over a file) settle first and then act, so a truncate's freed
  bytes and a later regrowth are each charged once.
- **The lease invariant.** A direct write is issued only if the lease covers
  its full extent, computed before the write and pessimistically. An append,
  or a write past the last known size, consumes its whole length. An
  overwrite within the known size consumes nothing. The known size comes
  from the last `fstat` and only shrinks on settlement. Settlement by
  `fstat` is the truth, and it returns over-consumption.
- **Consequence, documented in the quota docs in the same commit:** ENOSPC
  is never late, but it may come early by the outstanding leases (writable
  descriptors × lease size). The lease is already min(1 MB, the quota
  left), and unused lease comes back at settlement, so the early margin
  shrinks as the quota does.
- **Lease messages carry the virtual descriptor,** never the real one,
  because the worker's send path is reachable from module code.
- **A worker that ends mid-lease** (crash, limit, unload) is settled during
  D1's drain (`lib/module-lifecycle.js`). The broker `fstat`s each leased
  descriptor before `closeAll` closes it, then releases the leases.

### 6.3 The descriptor record, and audit after proposal 1

P2 (roadmap-p1-p2.md) puts I/O audit records through the main-thread
broker. Denials and outside-namespace accesses are recorded in full, and
routine allowed access is summarised. P2 comes after this work, so
proposal 1 builds no audit sink (my call). It keeps what P2 will need on
the broker's descriptor record:

- the open-time identity: module, virtual path, real dev/ino, decision;
- write bytes, main-observed (the size at open against `fstat` at each
  settlement and at close), with the worker's write count alongside;
- read count and bytes, reported by the worker at close (and at worker end,
  best effort), marked `worker-asserted`.

The provenance rule is the reviewer's call, for the user to confirm: a
module misreporting reads of a file it was allowed to read gains nothing,
since it could read the whole file anyway. Denials and outside-namespace
accesses stay main-observed in full, because they can only happen at open or
on the brokered path. Every summary is attributable to a main-verified open.

### 6.4 Containment: what makes direct I/O safe

Raw reads and writes on a real descriptor need the original `fs`. Today the
worker patch keeps the originals in its closure (`origFs`), the grant
controller is not exported, the originals module is frozen, and
`process.binding` is locked. That containment is what already stops a module
from reading any descriptor in the process (main's auth database, the Redis
socket, other modules' files), since descriptors are shared, small
integers.

**The requirement** (made precise by the reviewer): the original `fs`
functions and the lease state are unreachable from module code; they live
only in the patch's closure. Real descriptor numbers are not secrets
(adoption of any real number is refused by the patched `fs`, and the open
reply carries the number over the bridge); they are kept off reachable
objects as hygiene only. If the requirement holds, a module can't write past
its lease, because every direct write goes through the patch's lease check.

**The bridge transport.** `workerData.fsBridge` (its ports) is read by
`lib/sandbox.js:16` and is not deleted from `workerData` after install.
Under `enforce`, module code can't reach it: `worker_threads` is refused,
both by a direct `require` and through a countinghouse Module's `require`
taken from `require.cache` (`test/auth/44-cache-require-builtins.js`, run on
`0dc18ac`: both routes give `MODULE_NOT_FOUND`). Under `audit`, builtins are
allowed and logged, so a direct `require('worker_threads')` does reach it.
With it, a module could read open replies and send requests as its worker.
That grants only its own broker rights, and main never trusts
worker-reported lease data (settlement is main's `fstat`), so the quota
doesn't depend on it. **Hygiene requirement:** `sandbox.js` deletes
`fsBridge` from `workerData` once the client holds it, with a test. It
narrows `audit`'s allow-and-log reach at no cost (the reviewer's call).

**Reads-only (iii)** is still measured, as a variant for the gain
comparison: if reads-only takes most of the gain, the user may prefer it.

### 6.5 Tests

- Reads and writes on a brokered descriptor make no bridge call (counted).
- ENOSPC is enforced through leases, including a write past the lease and a
  write when no further lease fits; under `audit` the same writes succeed
  and are reported.
- The quota is correct after a worker is killed mid-lease (the quota equals
  the file sizes on disk).
- **Containment:** a reachable-graph walk from module code finds none of
  the original `fs` functions and not the lease state object. It reuses
  `test/fixtures/key-dump`'s `scan.js`: roots `globalThis` plus every
  `require.cache` entry's exports; needles the `origFs` function identities
  and the lease state. Adoption of a real descriptor number is refused.
- After install, `workerData.fsBridge` is gone (section 6.4).
- A close racing a large direct write never corrupts a second file opened
  right after (section 6.1, descriptor reuse).
- Two descriptors on one file are charged the file's growth once; a
  truncate and a regrowth are each charged once (section 6.2).
- Lease request and settlement messages carry only virtual descriptors.
- Variant (b): at most C direct async operations per worker in flight.
  Variant (d): the global count never exceeds the scheduler's cap.
- The descriptor record carries the open-time identity, the main-observed
  write bytes, and the `worker-asserted` marking on reads.

## 7. Proposal 3: more compound broker ops

`writeFile`/`appendFile` are already one brokered call. Add more where real
code repeats a sequence: `mkdir -p` checked in one walk, `exists`,
`stat`-then-`readFile`, and what the dependency loader does for one
`require` (workload L). Pick them from what the benchmark and common
packages actually do; a trace of the bridge calls during workloads L and W
is the input. Each compound op keeps every check its parts would make,
inside the broker. No compound op may skip a check one of its parts would
have run.

Tests: for each compound op, the same refusals as its parts (outside,
read-only, quota, special files, the symlink rule, the always-denied set),
and a count showing fewer bridge calls.

## 8. Proposal 5: file threads (separable; the user approves or drops it)

This section can be approved or dropped on its own. Proposals 1 to 4 stand
without it. Proposal 5 may be built and measured before the amendment
below is approved (the user decided to try it). Keeping it needs the
amendment.

### 8.1 The amendment to the broker design

Today the main thread is the single point of contact for module files, and
libuv's pool does the I/O. Proposal 5 adds a small pool of
countinghouse-owned file threads making **synchronous** calls, so fast
metadata work skips the libuv hand-off. If kept, this amends
docs/superpowers/specs/2026-10-17-module-sandbox-fs-broker-design.md:

- **Main stays the authority.** It decides each module's namespace and
  policy, keeps the always-denied check (R2-1 Task 2), and never blocks.
- **The pool:** 2 to 4 threads with one shared queue. Start with 2; measure
  1, 10 and more modules at once, and add threads until it stops helping.
- **What goes there:** only fast metadata work, synchronously: `realpath`,
  `lstat`/`stat`, `open` (O_NONBLOCK, as today), `fstat`, `readdir`, and the
  syscalls the checks need. Large reads and writes, `fsync`, `copyFile`, and
  anything on a declared path (it may be a network mount) stay on libuv's
  async pool.
- **Watchdog:** a file thread past a deadline gets no more work and is
  replaced, as with the 30 s broker deadline (`lib/fs-broker/server.js`);
  its in-flight operations fail with a code.
- **With proposal 1,** most bulk data never reaches the file threads.

### 8.2 Variant A (the baseline): file threads decide nothing

File threads run syscalls and return raw results (a real path, dev/ino, a
stat, an opened descriptor). Main makes every decision. The open sequence
keeps today's shape:

1. file thread: realpath / lstat of the path;
2. main: decides (namespace, mode, the always-denied set, the quota
   reservation);
3. file thread: opens (without O_TRUNC, as today) and fstats;
4. main: verifies dev/ino, the always-denied set included, then truncates if
   asked (through a file thread) and hands the descriptor to the worker.

The extra hop between main and a file thread is a postMessage between
threads, not a libuv pool job, so variant A can still win: what proposal 5
removes is the pool hand-off.

**The crash rule holds as the user set it** (roadmap-p1-p2.md, P1 decision
5): an uncaught exception in a file thread logs the full stack and ends only
that thread; its in-flight file operations fail promptly with a code (as D1
does for module workers); the pool starts a replacement; the server keeps
running. It is valid because in variant A no file thread makes a permission
decision.

### 8.3 Variant B (measured, for the user to choose): file threads apply the policy

Main gives each file thread, at spawn and on every change, the namespace and
the always-denied identities. The thread runs the checks itself and opens in
one hop. Main still verifies dev/ino on the opened descriptor, the
always-denied set included, before handing it over, so the always-denied
check stays on main in both variants.

- B weakens no trust boundary: file threads are countinghouse code, trusted
  like main, and module code never reaches them.
- B changes the failure model. A file thread that crashes mid-decision can
  leave an operation half-decided, so the crash rule would need rewording.
  The rule as written covers only threads that make no decisions. If the
  numbers favour B, the work stops and the rewording goes to the user with
  them (section 3, "Variants").

### 8.4 Logging from file threads

As P1 decision 7 for module workers: a file thread sends structured records
to main over its message channel, main is the single writer, and main adds
the attribution (which file thread, on whose behalf) from the channel the
record arrived on, never from fields the thread sends. A crash record is
sent best effort, and main's Worker 'error' event copy is the guaranteed
one. Until the P1 logger lands, file threads use the path module workers
use today, and they move with it when P1 lands.

### 8.5 Tests

- The security tests in `test/fs-broker` and `test/sandbox` pass with file
  threads on, unchanged.
- A file thread killed mid-operation: its in-flight operations fail with the
  chosen code, the next call succeeds on a replacement thread, the server
  keeps running, and the stack is logged.
- A file thread stuck past the deadline is replaced, and its operation fails
  with the code.
- The always-denied set is refused under `audit` and `enforce` in both
  variants, including an `O_TRUNC` open of the auth config under `audit`
  (refused before the file is touched).

## 9. Not in scope

- Network I/O (sandbox parts 3 and 4).
- P2's audit sink and records (section 6.3 keeps only what P2 will need).
- A main-side timer bounding lease overshoot (section 6.4).

## 10. For the user to confirm

1. Proposal 2's residual against the host (section 4), and the rewritten
   security-model.md sentence.
2. Section 6.1: direct async I/O changes the broker spec's "in every mode"
   scheduler promise. Variant (b) or (d), decided with the numbers.
3. Section 6.3: the descriptor record's provenance rule (the reviewer's
   call).
4. Section 6.4: containment instead of a lease-overshoot bound (the
   reviewer's call); and full direct I/O or reads-only, decided with the
   numbers.
5. Section 8: keep or drop proposal 5's amendment; variant A or B, decided
   with the numbers; if B, the crash rule's rewording.
6. Whether to set a target number once the re-baseline is in.

## 11. Left to the builder

- How the S, L and W workloads are scripted.
- What proposal 4 fixes, from the profile.
- Which compound ops proposal 3 adds, from the bridge-call traces.
- The lease size if 1 MB measures badly; the renewal protocol's message
  shapes (virtual descriptors only).
- C and K for the async variants, from the measurements.
- The classification of the remaining descriptor calls (`fdatasync`,
  `futimes`, `fchmod` and the rest) as direct or brokered.
  `test/fs-broker/07`'s completeness check forces every one to be
  classified.
- The crash code for file threads: an existing one, or a new one in
  `lib/error-info.*.json` (both locales).
- The number of file threads (2 to 4, from the measurements).
