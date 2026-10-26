# Re-measurement, 2026-10-26

Raw output of every perf script run behind the numbers in
`docs/direct-peer-channels.md`, `docs/log-triage-performance.md` and the
posts under `docs/`. Each `<step>.md` is the script's stdout exactly as
printed, `<step>.json` the raw per-run results (`--json`), `<step>.stderr`
its progress output.

- Commit measured: `3d9599d` (master `8114890` plus the sandbox-native fixture
  fix and the `--runs` script changes; no runtime code differs from master).
- Machine: 2 vCPU VMware guest, Intel Core i7-6600U @ 2.60 GHz, 7.2 GB,
  Node v24.21.0, Linux 7.0, Redis 8.0.5. No containers on the machine.
- Module sandbox: the server default (`audit`) unless a table says
  otherwise.
- Every script ran with `--runs 3` (log-triage also `--reps 25`): three
  independent runs, each in a fresh process with fresh servers.

## Conditions

Before each step, `vmstat 1 31` had to show a mean idle of at least 90%
(`gate-<step>.vmstat`; all passed at 96–98%). The progress logs record,
for each step, how many CPU seconds the desktop session (the Claude Code
session that launched the runs, its terminal and gnome-shell) used while
the step ran; it was about 1% of one core throughout.

`progress-first-run-kept.txt` covers the three steps kept from a first pass
(`direct-peer-channels`, `serialization`, `cap-sweep-4`), during which the
launching session was idle. The other steps of that pass overlapped with
activity in the launching session, were discarded and re-run; their re-runs
are in `progress.txt`, which also carries the interference figures. The
first pass predates the interference logging.

## Files

| step | what |
|---|---|
| `direct-peer-channels` | 9-cell routed vs. direct micro-benchmark, default config |
| `serialization` | `JSON.stringify` vs. structured clone vs. transfer list |
| `cross-process` | direct peer channel vs. stdio vs. localhost HTTP, break-even |
| `log-triage` | full log-triage matrix, both paths |
| `cap-sweep-{4,8,16,32}` | `--directPeerChannelsMaxConcurrency` at 1MB/c=64, direct path only |
| `sandbox-direct-peer-channels` | 9 cells, direct path, `--moduleSandbox off/audit/enforce`, `--mcpToolCallCost 1` |
| `sandbox-log-triage` | log-triage headline (8 files x 400 lines, direct), the three sandbox modes |
| `recheck-1MB-c16` | `--runs 5` of the one sandbox cell that crossed the 10% line in `sandbox-direct-peer-channels` |

`examples/repo-review/token-comparison.js` was not re-run: on this commit it
cannot start its composite under `--debug` (no auth identity lists
`repo-review` in `runsModules`), so the repo-review byte figures were left as
they were.
