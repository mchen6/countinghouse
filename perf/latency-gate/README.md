# The shared runtime's latency gate

Matt's gate (2026-11-15), for a warm `tools/call` measured end to end through the real Rust shim, on an idle machine with 4 or more cores:

- **1 session:** a shared call is at most 2 ms slower than a separate server.
- **2+ sessions:** a shared call is no slower than separate servers.

## One command

From a countinghouse checkout with its dependencies installed (`npm ci`):

```
node perf/latency-gate/gate.js --ch-local <path to a ch-local checkout>
```

That builds ch-shim with cargo (ch-local pins its toolchain), runs the closed load shape (5 alternating rounds of 300 back-to-back calls per session at N=1, 2 and 4), prints each round and the verdict, and exits 0 on PASS, 1 on FAIL and 2 when the harness itself fails or an option is invalid. Options:
- `--mode open` runs the realistic rate instead: 60 calls per session, each after a gap drawn from 1–5 s by a seeded RNG (`--seed`), at N=2, 3 and 10, with the median and p95 reported. This takes about 3 minutes per layout and session count.
- `--shim <binary>` uses an already-built ch-shim.
- `--sessions 1,2,4`, `--rounds`, `--calls` override the mode's defaults. They are checked as small positive integers.
- `--json <file>` writes the result.

It runs on Linux and macOS. The shared runtime doesn't run on Windows yet.

## What it compares

- **Separate (A):** N copies of `plain-server.js`, the MCP SDK's own stdio server, with the same tool, work and output. Each session talks to its own server.
- **Shared (S):** one countinghouse runtime on `--sessionSocket` in a private home, started as `ch-local daemon` starts it (`--workerThread --store local --moduleSandbox enforce --controlChannel ipc`). The `perf-time` module is loaded as a scenario, and `daemon.json` is written once the runtime listens. Each session is a client running `ch-shim --home <home>`, which attaches to the runtime and proves its secret.

Each session makes 30 warm-up calls, then the timed calls, all N sessions at once:
- closed: the calls go back to back;
- open: each call comes after a seeded 1–5 s gap, and separate and shared get the same schedule.

A and S alternate, `--rounds` times per N. A round's figures are the median and p95 over all its sessions' timed calls. The result is the median of the rounds, and the verdict uses the medians.

## Where it runs

- **Locally:** the command above.
- **On a GitHub-hosted 4-core runner:** `.github/workflows/latency-gate.yml`, started by hand only (`gh workflow run latency-gate.yml -f runs=3`, from the default branch). It has read-only permissions and no secrets, and its actions are pinned by SHA. Each gate run is a separate job on its own runner, running the modes asked for; every job uploads its `gate-closed.json` and `gate-open.json`. Open mode's seed is the run's number.
