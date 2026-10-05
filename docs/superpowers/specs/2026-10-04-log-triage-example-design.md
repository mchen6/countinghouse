# log-triage — a second composite example, whose bill depends on its input

Roadmap item #6. Non-breaking, no platform code, a natural 7.1.0.

Verified against `master` at `2de730b` on 2026-10-04, plus the two billing
fixes on `fix/concurrent-hop-billing` that this example depends on (see
[Prerequisites](#prerequisites)). Every claim below names the file that backs
it — re-check rather than believe, the tree moves.

## The problem

The project's pitch rests on composite tools, and `examples/repo-review` is
the only worked example. A reader deciding whether composites apply to their
own work has one data point, and it is developer tooling.

It is also one *shape*. `repo-review` makes exactly three hops on every call
(`examples/repo-review/repo-review/package.json`, `countinghouse.calls`), so
its bill is a constant: 4, the outer call plus three hops. Nothing in the tree
shows a composite whose cost follows its input, which is the case an operator
pricing a tool actually has to reason about.

## What the example must show

One headline claim, and one supporting claim.

1. **Headline — data-dependent cost the caller can bound.** The number of
   inner hops grows with the number of log files read, each hop is metered,
   and the caller sets a cap (`maxFiles`) that fixes the worst-case bill before
   the call is made.
2. **Supporting — raw log lines do not leave the runtime.** Lines are read,
   masked and clustered in-process; the response carries cluster counts and
   masked samples. This is `repo-review`'s schema argument in an ops setting,
   so it is present but not the lead.

Success: a reader from an ops background finds a claim `repo-review` does not
make, backed by a script that measures it.

## Scope

**In:** four modules under `examples/log-triage/`, a seeded sample-log
generator, one verification script, one suite test that runs it, an
`auth.json`, a README, an npm script, and doc links.

**Out, deliberately:**

- **A byte-comparison script.** `examples/repo-review/token-comparison.js`
  already carries that claim; a second copy would be upkeep for no new
  evidence.
- **Per-hop balance checks or rate limits.** `docs/composite-tools.md` records
  that `checkBalance`/`rateLimit` apply at the outer call only. This example
  makes that gap more visible; closing it is platform work and belongs to
  roadmap #3's neighbourhood, not here. The README states the gap.
- **Per-module pricing.** Every hop costs `--mcpToolCallCost`, as everywhere
  else in the platform.
- **Partial results on hop failure.** See [Failure](#failure).

## Prerequisites

Two billing bugs were found while checking that `ctx.call` hops can run
concurrently. Both must be merged before this example, because its headline
claim is an exact bill produced by concurrent hops.

1. **Concurrent charges were lost.** `RedisMeteringProvider.prototype.recordCall`
   (`lib/metering/redis-provider.js`) read the balance and wrote it back as two
   round trips. Ten concurrent hops charged 2. Fixed by doing the decision in
   one Redis script; test `test/auth/18-concurrent-metering.js`.
2. **`--directPeerChannels` billed the module identity.**
   `PeerChannel.prototype._sendInvoke` (`lib/peer-channel.js`) posts the
   `peer-invoke` message without the `billingKey` that `invoke` was handed, so
   the callee falls back to the grant identity
   (`DeviceManager.prototype.onPeerChannelOpen`, `lib/device-manager.js`).
   Ten sequential hops charged the module 10 and the caller 0.

`ctx.call` concurrency itself needed no change: eight 300 ms hops started
with `Promise.all` completed in about 350 ms on both hop paths.

## Design

### Modules

All four use the 6.0.0 module shape `repo-review` uses: `package.json`,
`api.json`, `schema.json`, and one `async (input, ctx)` handler per file under
`handlers/<service>/<action>.js`. No npm dependencies.

| Module | Address | Role |
|---|---|---|
| `log-read` | `log-read/readService.list` | Lists the `*.log` files directly inside one directory: name and byte size, sorted by name. |
| `log-read` | `log-read/readService.read` | Returns one file's raw lines. The only action that reads file contents. |
| `pii-redact` | `pii-redact/redactService.redact` | Pure function. Lines in; the same lines with PII masked, plus a count per PII type. |
| `error-cluster` | `error-cluster/clusterService.cluster` | Pure function. Redacted lines in; clusters out. |
| `log-triage` | `log-triage/triageService.triage` | The composite. Exposed to callers as `log_triage_triageservice_triage`. |

Device IDs are deterministic (`lib/call-address.js`, `deviceIDForName`), which
is what lets `auth.json` be committed:

| Module | Device ID |
|---|---|
| `log-read` | `fd0eafbd-20da-53e6-9302-681687350a3b` |
| `pii-redact` | `b5048beb-2128-52c0-9cd4-42669f57090f` |
| `error-cluster` | `9f9aab37-b175-5286-81c3-68bdd24bd4f7` |
| `log-triage` | `dad07d2a-9d65-5ef5-af59-05c0160c5fdc` |

**`log-read`**

- `list` input: `{dir?}`. Default `dir` is `examples/log-triage/sample-logs`.
  Non-recursive. Output: `{dir, files: [{name, bytes}]}`, at most 256 entries.
- `read` input: `{dir?, name, maxBytes?}`. `name` must be a bare file name
  ending `.log` with no path separator; anything else is rejected, so `read`
  cannot be steered outside `dir`. `maxBytes` defaults to 1 MiB; a larger file
  is read up to the last complete line within the budget and reported
  `truncated: true`. Output: `{name, bytes, lineCount, truncated, lines}`.

**`pii-redact`**

- Input: `{lines}`. Output: `{lines, counts}`, where `counts` has one integer
  per type: `email`, `ipv4`, `phone`, `card`, `bearerToken`.
- Each match is replaced by a fixed tag (`<email>`, `<ipv4>`, `<phone>`,
  `<card>`, `<token>`). Tags, not partial masks: no character of a matched
  value survives.
- Demo-grade regular expressions, stated as such in the README, the same way
  `repo-review` disclaims `secret-detect`.

**`error-cluster`**

- Input: `{lines, topClusters?}` (default 10, maximum 50).
- A line is parsed as `<ISO timestamp> <LEVEL> <message>`; lines that do not
  parse are counted as `unparsed` and otherwise ignored. Only `WARN` and
  `ERROR` lines are clustered.
- The cluster key is the level plus the message with every run of digits,
  every hex string of 8 or more characters and every UUID replaced by `#`.
- Output: `{lineCount, unparsed, byLevel, clusterCount, clusters}`. Each
  cluster is `{template, level, count, firstSeen, lastSeen, sample}`, sorted
  by `count` descending then `template`; `template` and `sample` are capped
  at 160 characters.

**`log-triage`** (the composite)

- Input: `{dir?, maxFiles?, maxBytesPerFile?, topClusters?}`. `maxFiles`
  defaults to 8, maximum 32.
- `package.json` declares four addresses under `countinghouse.calls`: the two
  `log-read` actions, `redact` and `cluster`.

### Hops

For `N` files read:

1. `list` — once.
2. `read` then `redact` — once per file. The `N` read-then-redact chains run
   concurrently (`Promise.all`); within a chain the two hops are sequential.
3. `cluster` — once, over all redacted lines in file-name order.

**Inner hops = 2N + 2. Charged to the caller = 2N + 3**, including the outer
call, at `--mcpToolCallCost 1`.

`N = min(files in dir, maxFiles)`. Files beyond the cap are not read; they are
taken in name order, and the ones left out are returned as `skipped`. The
worst case is therefore known before the call: `2 × maxFiles + 3`.

A directory with no `.log` files makes one hop (`list`) and returns empty
findings; it is not an error.

What concurrency buys, stated honestly in the README: each module runs in one
worker thread, so the `read` hops overlap (I/O) but the `N` `redact` hops are
CPU-bound work in a single worker and run roughly one after another.

### Output

```
{
  findings: {
    summary,                      // one paragraph, <= 1000 chars
    files:    {read: [{name, bytes, lineCount, truncated}], skipped: [name], dir},
    pii:      {email, ipv4, phone, card, bearerToken, total},
    levels:   {DEBUG, INFO, WARN, ERROR, unparsed},
    clusters: [{template, level, count, firstSeen, lastSeen, sample}]
  },
  bill: [{hop, tool, file, charged, balance, billedTo, authorizedAs}],
  cost: {filesRead, hops, charged, maxFiles, worstCaseHops}
}
```

- `bill` has one record per inner hop, built from `platformMetering` exactly
  as `repo-review` does (`{detail: true}` on every `ctx.call`). `file` is the
  file name for `read`/`redact` hops and `null` for `list`/`cluster`.
- Hops complete in a nondeterministic order. `bill` is ordered by logical
  position (list; then read, redact per file in name order; then cluster) and
  `hop` numbers follow that order, so the response is stable across runs.
  Consequence: `balance` values are each hop's own running balance as metering
  reported it and are **not** monotonic down the list. The README says so.
- `cost.charged` is the sum of `bill[].charged`; `cost.hops` is `bill.length`;
  `cost.worstCaseHops` is `2 × maxFiles + 2`.
- The schema follows `repo-review`'s discipline: `additionalProperties: false`
  at every level, every string `maxLength`-capped, every array `maxItems`-capped
  (`bill` at 66, which is `2 × 32 + 2`). No field can hold a raw log line; the
  widest free-text field is a 160-character masked `sample`.

### Failure

If any hop rejects, the call fails with `DEVICE_ACTION_CALL_FAIL` naming the
hop, the way `repo-review`'s `hop()` helper does. Hops that completed before
the failure stay charged: metering is the platform's and has already run.
Because chains are concurrent, hops in other chains may complete after the
first rejection and are charged too. The README states this; the example does
not try to return a partial result.

### Sample data

`examples/log-triage/generate-logs.js` writes a deterministic set of log
files:

- `node generate-logs.js [--dir <path>] [--files <n>] [--lines <n>] [--seed <n>]`,
  defaults: `./sample-logs`, 8 files, 400 lines each, seed 1.
- A small seeded PRNG in the file itself (no dependency), so the same
  arguments always produce byte-identical files.
- Lines mix `INFO`/`DEBUG` noise with `WARN`/`ERROR` lines drawn from about a
  dozen templates with varying numbers and IDs, so clustering has something to
  group.
- A fixed list of planted fake PII values (addresses under `example.com`, IPs
  from the documentation range `203.0.113.0/24`, `555`-prefixed phone numbers,
  a test card number, a fake bearer token) is exported from the generator, so
  a checker can assert none of them appear in a response.

Generated files end in `.log`, which `.gitignore` already excludes (`*.log*`),
so sample data is never committed. `npm run demo:log-triage` runs the
generator before starting the server.

### Auth

`examples/log-triage/auth.json`, same form as `examples/repo-review/auth.json`:

- `demo-key` is granted the `log-triage` device only.
- `log-triage-internal` is granted the three inner devices and carries
  `"runsModules": ["log-triage"]`.

### Verification script

`examples/log-triage/verify-cost-bound.js`, modelled on
`examples/repo-review/verify-identity-passthrough.js`: non-`--debug`,
multi-tenant, its own temporary auth file and sample directory, exits non-zero
on the first failed assertion. It runs the whole sequence twice, once per hop
path (default on port 9596, `--directPeerChannels` on port 9597).

With 8 generated files, for each hop path:

1. `tools/list` for the caller shows exactly one tool.
2. For `maxFiles` = 1, 3 and 8: `cost.hops === 2N + 2`, `bill.length` matches,
   and every `bill[].billedTo` is the caller.
3. For each of those calls: the caller's settled balance moved by exactly
   `2N + 3`, and the module identity's by 0. Balances are read with the
   settle-then-read helper the existing tests use, never polled until an
   expected number appears.
4. `maxFiles = 3` over 8 files: `files.read` has 3 entries, `files.skipped`
   has 5, and the caller paid 9.
5. No planted PII value appears anywhere in the serialized response, and
   `findings.pii.total > 0`.
6. An empty directory: one hop, empty findings, caller paid 2.

### Suite coverage

`test/composition/10-log-triage-example.js` spawns the verify script and
asserts exit code 0, printing its output on failure. `repo-review` has no such
test; this one exists so the example cannot rot silently, and because it is
the only place in the suite that exercises concurrent `ctx.call` hops end to
end on both paths.

## Known limitations

- **Demo-grade detection.** `pii-redact` is a handful of regular expressions.
  It is not a PII scanner; a clean count proves nothing.
- **`checkBalance`/`rateLimit` are outer-call only.** A caller with a balance
  of 1 can still trigger 2N + 2 hops. The cap this example demonstrates is the
  caller's own `maxFiles`, not a platform-enforced budget.
- **`log-read` reads what it is pointed at.** `dir` is caller-supplied; on a
  real deployment that would need an allowlist. Stated in the README.
- **In-process only**, as for every composite here.

## Files

New:

- `examples/log-triage/README.md`
- `examples/log-triage/auth.json`
- `examples/log-triage/generate-logs.js`
- `examples/log-triage/verify-cost-bound.js`
- `examples/log-triage/{log-read,pii-redact,error-cluster,log-triage}/` —
  each `package.json`, `api.json`, `schema.json`, `handlers/…`
- `test/composition/10-log-triage-example.js` — runs the verify script
- `test/composition/11-log-triage-units.js` — the generator and the pure
  handlers

Changed:

- `package.json` — `demo:log-triage` script.
- `README.md`, `docs/index.md` — a pointer to the second example.
- `docs/composite-tools.md` — name `log-triage` as the concurrent-hop example.
- `CHANGELOG.md` — a 7.1.0 entry.

Not changed: anything under `lib/`. The golden `tools/list` sample is
unaffected, because examples are not loaded by default; so is
`test/fixtures/route-inventory.json`, because no HTTP mount is added.

## Testing

- The three pure handlers (`redact`, `cluster`, and `read`'s name validation
  and truncation) are plain functions of their input and get unit tests first,
  written before each handler: masking leaves no planted value, counts match,
  cluster keys merge lines that differ only in numbers and IDs, ordering is
  stable, `read` rejects `../x.log` and `a/b.log`.
- The generator: same seed gives byte-identical output; a different seed does
  not.
- The composite is covered end to end by the verify script through
  `test/composition/10-log-triage-example.js`.
- Full suite before each commit, per `CLAUDE.md`.

## Sequence

1. Merge the two prerequisite fixes.
2. `generate-logs.js` and its test.
3. `log-read`, `pii-redact`, `error-cluster`, each with unit tests.
4. `log-triage` composite, `auth.json`, `verify-cost-bound.js`, the suite test.
5. README, npm script, doc links, CHANGELOG.
