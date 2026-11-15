# The shared runtime's latency gate

Matt's gate (2026-11-15), for a warm `tools/call` measured end to end through the real Rust shim, on an idle machine with 4 or more cores:

- **1 session:** a shared call is at most 2 ms slower than a separate server.
- **2+ sessions:** a shared call is no slower than separate servers.

## One command

From a countinghouse checkout with its dependencies installed (`npm ci`):

```
node perf/latency-gate/gate.js --ch-local <path to a ch-local checkout>
```

That builds ch-shim with cargo (ch-local pins its toolchain), runs 5 alternating rounds of 300 calls per session at N=1 and N=2, prints each round and the verdict, and exits 0 on PASS and 1 on FAIL. Options:
- `--shim <binary>` uses an already-built ch-shim;
- `--sessions 1,2,3`, `--rounds`, `--calls`;
- `--json <file>` writes the result.

It runs on Linux and macOS. The shared runtime doesn't run on Windows yet.

## What it compares

- **Separate (A):** N copies of `plain-server.js`, the MCP SDK's own stdio server, with the same tool, work and output. Each session talks to its own server.
- **Shared (S):** one countinghouse runtime on `--sessionSocket` in a private home, started as `ch-local daemon` starts it (`--workerThread --store local --moduleSandbox enforce --controlChannel ipc`). The `perf-time` module is loaded as a scenario, and `daemon.json` is written once the runtime listens. Each session is a client running `ch-shim --home <home>`, which attaches to the runtime and proves its secret.

Each session makes 30 warm-up calls, then the timed calls, all N sessions at once. A and S alternate, `--rounds` times per N. A round's figure is the median over all its sessions' timed calls; the result is the median of the rounds.

## Where it runs

- **Locally:** the command above.
- **On a GitHub-hosted 4-core runner:** `.github/workflows/latency-gate.yml`, started by hand only. It has read-only permissions and no secrets. Each gate run is a separate job on its own runner, and every job uploads its `gate.json`.
