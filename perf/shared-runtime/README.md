# A shared runtime against separate ones

`measure.js` measures N MCP client sessions two ways:

- **separate:** each session runs its own runtime, the command `ch-local start --stdio` builds (`bin/countinghouse-stdio.js --workerThread --store local --moduleSandbox enforce …`, the pack loaded). All N share one store, as ch-local's sessions share its home. The store is prepared first by one runtime, so it already holds its identity secret, as ch-local's home does.
- **shared:** one countinghouse on loopback HTTP (`framework.js --bindAddr 127.0.0.1 --authProvider file`), with one API key per session.

For N = 1, 3, 6 and 10 it reports:
- the layout's total RSS (every process's VmRSS: N runtimes, or 1 server), when ready, after the first calls and after the warm calls;
- per-session first-call and warm-call latency (the median and max over sessions);
- startup, from spawn to `countinghouse ready`;
- identity: each session's own `countinghouse_usage_report`. In the shared layout there is also an admin's report, grouped by opaque caller id.

All N sessions start together. Each makes one call of the pack's `ci_failure_triage`, five more, then its own usage report. A process that is gone when its RSS is read fails the row; it is never counted as 0 MB. Results were first reported for Validation 1 (2026-11-14).

## The workload: pack 1 and a stub of GitHub's MCP server

`ci_failure_triage` reaches GitHub through a remote MCP server (`remote:github/…` in ch-access-github, declared at `https://api.githubcopilot.com/mcp/`). The measurement starts `github-stub.js`, the SDK's own server on loopback. It answers the tools ch-access-github calls with canned bodies in GitHub's shapes: one failed run, one failed job, a 200-line log, the run's commit. Each runtime is started with:

- `--remoteOriginMap https://api.githubcopilot.com=http://127.0.0.1:<stub port>`, which the runtime honours only with `COUNTINGHOUSE_ACCEPTANCE=1` (lib/remote/origin-map.js);
- a token made at run time, in the variable the remote declares (`COUNTINGHOUSE_GITHUB_TOKEN`), and allowed for that origin in `--remoteCredentials`.

So every call runs the pack's real modules, all 11 hops, and the runtime's remote path: the main thread's outbound MCP call, its credential injection and its response cap. It runs offline, with no `--debug`. What it leaves out is the round trip to GitHub itself.

The pack is not in this repository. It lives in its own repository and is installed by ch-local. Give `--pack` an installed pack 1, release 0.4.0 or later; the tool refuses anything older, or a prerelease, because 0.1.0's scenario output fails its own schema (`coverage.historyRebuilt`). Copy the pack under `perf/apps/` first, so the measurement never runs from an install that something else is using; don't commit that copy (see Running it).

The stub counts every call that doesn't carry the run's token. The result's `remote` line gives that count, which should be 0: the credential injection is checked, not assumed. The runtime must have `--remoteOriginMap` (countinghouse after 2026-11-12). Validation 1's 7.1.2 reference rows were measured with an earlier stand-in for ch-access-github, with canned handlers and no remote. They don't include the remote path.

## No `--debug`

`--debug` bypasses the auth provider: every request becomes one `debug` session (lib/user-auth.js), and tools/list skips per-key filtering. That would make the identity check meaningless and skip the auth work real use pays on every call. Neither layout uses it; `--remoteOriginMap` is how the remote reaches the stub.

## Keys and the token

The shared layout's keys (`session-<i>-<random hex>`, an admin, and the pack's internal identity), and the remote's token, are made at run time with `crypto.randomBytes`.
- The keys are written only to a temporary auth file (mode 0600), deleted after each configuration.
- The token is only in the runtimes' environment.
- No output carries either, and none is in this repository.

## Memory guard

A separate layout is N whole runtimes. A configuration that would not fit is skipped, and its row says so, because a run that swaps measures the swap. The estimate is N × one runtime's RSS from the first separate configuration measured, plus 10% and 400 MB. Sessions run in ascending order, so the smallest N gives the estimate. Extrapolate a skipped row from the measured ones, since RSS is a sum of whole processes, and label it as extrapolated.

## Running it

Like the lean worker harness, in Docker behind an idle gate:

```
echo '["--pack","perf/apps/<installed pack 1>/node_modules/@countinghouse/ch-pack-ci-failure-triage","--runs","3"]' > perf/shared-runtime/measure.args.json
node scripts/run-in-docker.js perf/shared-runtime/measure.js
```

Leave `perf/apps/` and `measure.args.json` uncommitted. They are deliberately not in .gitignore, because `run-in-docker.js` copies only files git doesn't ignore.

Other options:
- `--runtime <dir>`: another countinghouse;
- `--sessions 1,3,6,10`;
- `--layouts separate,shared`;
- `--withParts`: load the scenario's parts too in the shared layout, for a runtime that doesn't expand a pack in multi-key mode;
- `--json <file>`.

The shared layout's port comes from `test/helpers/test-env.js`: `testPort(9751)` is 9751, unless `CH_TEST_PORT_BASE` is set, in which case it is the first port of that block (the base, then the base plus one, and so on, in the order ports are asked for). The stub listens on a port the OS picks.
