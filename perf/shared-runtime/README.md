# A shared runtime against separate ones

`measure.js` measures N MCP client sessions two ways:

- **separate:** each session runs its own runtime, the command `ch-local start --stdio` builds (`bin/countinghouse-stdio.js --workerThread --store local --moduleSandbox enforce …`, the pack loaded). All N share one store, as ch-local's sessions share its home.
- **shared:** one countinghouse on loopback HTTP (`framework.js --bindAddr 127.0.0.1 --authProvider file`), with one API key per session.

For N = 1, 3, 6 and 10 it reports:
- the layout's total RSS (every process's VmRSS: N runtimes, or 1 server), when ready, after the first calls and after the warm calls;
- per-session first-call and warm-call latency (the median and max over sessions);
- startup, from spawn to `countinghouse ready`;
- identity: each session's own `countinghouse_usage_report`. In the shared layout there is also an admin's report, grouped by opaque caller id.

All N sessions start together. Each makes one call of the pack's `ci_failure_triage`, five more, then its own usage report. Results were first reported for Validation 1 (2026-11-14).

## The workload: pack 1, offline, through a stand-in

`ci_failure_triage` reaches GitHub through a remote MCP server (`ctx.call('remote:github/…')` in ch-access-github). `make-standin.js` builds a copy of an installed pack in which ch-access-github keeps its name, `api.json` and `schema.json`, but its four actions answer canned results (one failed run, one failed job, a 200-line log, the run's commit) and it declares no remote. Every call then runs the scenario's 11 hops between the pack's real modules, offline.

What the stand-in leaves out, which real use pays:
- the GitHub round trips;
- the runtime's remote path: the main thread's outbound MCP call, its credential injection, and its response cap.

The pack itself is not in this repository. The generator reads an installed one:

```
node perf/shared-runtime/make-standin.js <installed pack>/node_modules/@countinghouse perf/apps/standin
```

Use pack 1 0.4.0 or later. 0.1.0's scenario output fails its own schema (`coverage.historyRebuilt`).

## No `--debug`

`--debug` would allow a loopback stub as the GitHub remote, since the runtime refuses loopback and private remotes otherwise (lib/remote/declaration.js). But `--debug` also bypasses the auth provider: every request becomes one `debug` session (lib/user-auth.js), and tools/list skips per-key filtering. That would make the identity check meaningless and skip the auth work real use pays on every call. Neither layout uses it.

## Keys

The shared layout's keys (`session-<i>-<random hex>`, an admin, and the pack's internal identity) are made at run time with `crypto.randomBytes`. They are written only to a temporary auth file (mode 0600) that is deleted after the configuration, and no output carries one. None is in this repository.

## Memory guard

A separate layout is N whole runtimes. A configuration that would not fit (N × one runtime's measured RSS, plus 10% and 400 MB) is skipped, and its row says so, because a run that swaps measures the swap. Extrapolate such rows from the measured ones, since RSS is a sum of whole processes, and label them as extrapolated.

## Running it

Like the lean worker harness, in Docker behind an idle gate:

```
echo '["--pack","perf/apps/standin/node_modules/@countinghouse/ch-pack-ci-failure-triage","--runs","3"]' > perf/shared-runtime/measure.args.json
node scripts/run-in-docker.js perf/shared-runtime/measure.js
```

Other options:
- `--runtime <dir>`: another countinghouse, for example an installed 7.1.2;
- `--sessions 1,3,6,10`;
- `--layouts separate,shared`;
- `--withParts`: load the scenario's parts too in the shared layout, for runtimes such as 7.1.2 that don't expand a pack in multi-key mode;
- `--json <file>`.
