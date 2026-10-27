# log-triage re-measurement, 2026-10-27

Why this exists: the 2026-10-26 log-triage run
([`../2026-10-26/log-triage.md`](../2026-10-26/log-triage.md)) compared the
composite against an in-process baseline that ran the handlers one file after
another, while the composite runs each file's read -> redact chain
concurrently. On one CPU the two schedules cost about the same; on two they do
not, so that baseline ran high and "runtime adds" and the runtime's share came
out low, most at small inputs.

- `baseline-diag.js`, `baseline-diag.jsonl`, `gate-baseline-diag.vmstat`: the
  check that found it. The same four handlers on 8 files, sequential and
  concurrent, interleaved rep by rep, 25 reps after 5 warm-ups, three fresh
  processes on both CPUs and three pinned to one (`taskset -c 0`). Run as
  `node baseline-diag.js <repo> 25`, at commit `38a0685`.
- `log-triage.md`, `log-triage.json`, `log-triage.stderr`, `progress.txt`,
  `gate-log-triage.vmstat`: `perf/log-triage-perf.js --reps 25 --runs 3` at
  commit `0ec55b8`, whose baseline is scheduled like the composite (the
  sequential one is still timed and shown beside it). Same machine as
  2026-10-26: 2 vCPU VMware guest, Intel Core i7-6600U @ 2.60 GHz, Node
  v24.21.0, module sandbox `audit` (default), behind a 90% idle gate.
