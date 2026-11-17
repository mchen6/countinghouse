# The shared runtime's latency gate

The maintainer's gate (2026-11-15), for a warm `tools/call` measured end to end through the real Rust shim, on an idle machine with 4 or more cores:

- **1 session:** a shared call is at most 2 ms slower than a separate server.
- **2+ sessions:** at most 1.5 ms slower than separate servers. It was "no slower" until the maintainer reset it the same day, after the first 4-core run.

It holds for a shared module and for a per-session one alike (shared runtime R1).

## One command

From a countinghouse checkout with its dependencies installed (`npm ci`):

```
node perf/latency-gate/gate.js --ch-local <path to a ch-local checkout>
```

That builds ch-shim with cargo (ch-local pins its toolchain), runs the closed load shape (5 alternating rounds of 300 back-to-back calls per session at N=1, 2 and 4), prints each round and the verdict, and exits 0 on PASS, 1 on FAIL and 2 when the harness itself fails or an option is invalid. Options:
- `--mode open` runs the realistic rate instead: 60 calls per session, each after a gap drawn from 1–5 s by a seeded RNG (`--seed`), at N=2, 3 and 10, with the median, p90 and p95 reported. This takes about 3 minutes per layout and session count, so about 28 minutes for the three layouts at the three defaults.
- `--shim <binary>` uses an already-built ch-shim.
- `--sessions 1,2,4`, `--rounds`, `--calls` override the mode's defaults. They are checked as small positive integers.
- `--json <file>` writes the result.

It runs on Linux and macOS. The shared runtime doesn't run on Windows yet.

## What it compares

- **Separate (A):** N copies of `plain-server.js`, the MCP SDK's own stdio server, with the same tool, work and output. Each session talks to its own server.
- **Shared (S):** one countinghouse runtime on `--sessionSocket` in a private home, started as `ch-local daemon` starts it (`--workerThread --store local --moduleSandbox enforce --controlChannel ipc`). The `perf-time` module is loaded as a scenario, and `daemon.json` is written once the runtime listens. Each session is a client running `ch-shim --home <home>`, which attaches to the runtime and proves its secret.
- **Per-session (P):** the same runtime and shim, with a copy of `perf-time` that declares `"state": "per-session"`, generated in the run's home. Each session's calls go to that session's own worker. The worker spawns on the session's first warm-up call, so the timed calls are warm. A first call's cost isn't part of this gate.

Each session makes 30 warm-up calls, then the timed calls, all N sessions at once:
- closed: the calls go back to back;
- open: each call comes after a seeded 1–5 s gap, and every layout gets the same schedule.

A, S and P alternate, `--rounds` times per N. A round's figures are the median, p90 and p95 over all its sessions' timed calls. The result is the median of the rounds. The verdict uses the medians: S and P each against A, within the allowance for that N.

Each round records the 1-minute load average it started at, with the CPU model in the result's `machine`. A round that started above 1.0 is marked `loaded` in the JSON, not run again: much of that load is the harness's own previous round, which a 1-minute average still holds.

## Where it runs

- **Locally:** the command above.
- **On a GitHub-hosted 4-core runner:** `.github/workflows/latency-gate.yml`, started by hand only (`gh workflow run latency-gate.yml -f runs=3`, from the default branch). It has read-only permissions and no secrets, and its actions are pinned by SHA. Each gate run is a separate job on its own runner, running the modes asked for; every job uploads its `gate-closed.json` and `gate-open.json`. Open mode's seed is the run's number.
