# repo-review — a composite tool that never returns the source it read

Four modules. One tool. A repository review where the code being reviewed is
read, analysed, and thrown away without ever reaching the caller.

This is the flagship worked example for countinghouse's composite tools. The
two-module [`composite-demo`](../../docs/composite-tools.md) shows the
mechanism; this one shows why you would want it, on a workload where the
intermediate data is genuinely large.

## What the demo demonstrates

Two claims, and they carry equal weight — the second is the one that survives
a handler being rewritten badly:

1. **The bytes.** Composed in the client, this review moves **4.58 MB** into
   the caller's context across three tool calls. Composed in the runtime, it
   moves **11.0 KB** in one call — a **427× reduction**, all of it source code
   that stayed on the server. Measured, not asserted: see
   [Token comparison](#token-comparison).

2. **The schema.** `repo-review`'s output schema has no field capable of
   holding a source file. Every string is `maxLength`-capped (the widest is a
   120-character masked excerpt), every array is `maxItems`-capped, and
   `additionalProperties` is `false` at every level. The runtime validates
   output on the way out, so this is not a promise the handler makes — it is a
   shape the response is checked against. A handler that tried to append file
   contents would fail validation rather than leak.

Plus the thing composite tools have always done here: **per-hop billing under
the real caller's identity.** Three inner hops, three independent metering
records, all charged to whoever called the outer tool — while being
*authorized* as the composing module, so the caller needs no grant to any inner
module. See [Identity and billing](#identity-and-billing-across-four-hops).

## The four modules

| Module | Tool name | Role |
|---|---|---|
| [`repo-scan`](repo-scan/) | `repo_scan_scanservice_scan` | Walks a directory and returns the **full text** of every matching file. Deliberately the bulk-data leaf. |
| [`secret-detect`](secret-detect/) | `secret_detect_detectservice_detect` | Regex credential detection over content it is handed. Pure function, no disk access. Returns masked excerpts only. |
| [`dep-audit`](dep-audit/) | `dep_audit_auditservice_audit` | Static parse of `package.json` + lockfile text. Offline. Pure function. |
| [`repo-review`](repo-review/) | `repo_review_reviewservice_review` | The composite. Calls the other three in-process and returns `{findings, bill, dataFlow}`. |

Only `repo-review` is meant to be reachable from outside. The other three are
its ingredients — see [Exposing only the composite](#exposing-only-the-composite).

Exactly one module touches the disk. `repo-scan` reads `package.json` and the
lockfile as part of the same walk, and `repo-review` hands their text to
`dep-audit`, so the two analysis modules stay pure functions of their input and
the composite never reads a file itself.

All four use the 6.0.0 module shape: no `index.js`, no `device.js`, one
`async (input, ctx)` handler per file under `handlers/<service>/<action>.js`,
with `api.json` and `schema.json` as the only contract.

## Running it

### Zero-config: the byte comparison

Needs a running Redis (metering) and nothing else. The script starts its own
server on port 9595, loads all four modules, runs both conditions, and prints
a generated report:

```sh
node examples/repo-review/token-comparison.js
```

It scans this repository by default, so there is nothing to configure.

### Calling the tool yourself

One command. The script loads all four modules and points
`--authConfigPath` at [`auth.json`](auth.json) in this directory, so it never
touches -- or needs -- an `auth.json` in the repository root:

```sh
npm run demo:repo-review
```

That file grants `demo-key` the composite module only, and the composing
module's internal identity (`repo-review-internal`) the three inner modules.
Call it with the demo key:

```sh
curl -s -X POST http://127.0.0.1:9527/mcp -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "X-CH-Key: demo-key" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"repo_review_reviewservice_review","arguments":{}}}'
```

`demo-key` is a demo credential committed on purpose, usable only against a
server you started yourself on `127.0.0.1`. Replace it with a real key --
edit that file, or set `COUNTINGHOUSE_API_KEY`, which is honoured in addition
to whatever the file contains -- before exposing this to anything.

`--mcpToolCallCost` defaults to `0`; the script sets it to `1`, or the `bill`
would be all zeroes. The four device IDs in `auth.json` are deterministic
(`UUIDv5` of a fixed namespace and each module's `api.json` `friendlyName`), so
they are the same on every machine, which is what lets that file be committed
at all. Balances live in Redis keyed by API key and survive a restart, so only
your first run bills `demo-key` from `0` down to `-3`.

As an MCP client, point Claude Code at it:

```sh
claude mcp add --transport http countinghouse http://127.0.0.1:9527/mcp \
  --header "X-CH-Key: demo-key"
```

then ask it to review the repository. A full recorded round trip, request and
response, is in [`recorded-round-trip.md`](recorded-round-trip.md).

### Exposing only the composite

Give the caller's key a grant to the composite device *only*:

```json
{
  "your-api-key": {"userName": "you", "devices": ["51b0d6ac-7a77-5083-8476-26a9be96a101"]}
}
```

`tools/list` filters per API key, so that caller sees exactly one tool. The
three inner modules are loaded and callable by `repo-review`, and invisible to
everyone else. `examples/repo-review/verify-identity-passthrough.js` asserts
this, among other things:

```sh
node examples/repo-review/verify-identity-passthrough.js
```

## Expected output

```json
{
  "findings": {
    "summary": "Reviewed 325 files (2072066 bytes) under /path/to/countinghouse. Credential scan: 13 finding(s) (13 medium), all excerpts masked; detection is demo-grade regex matching, so treat hits as leads and a clean result as inconclusive. Dependencies: 46 declared, 46 not pinned to an exact version, 0 using a specifier that bypasses registry version resolution; lockfile package-lock.json resolves 979 packages. No network access was used, so this says nothing about known vulnerabilities.",
    "scanned": {"root": "...", "fileCount": 325, "byteCount": 2072066, "truncated": false, "truncationReason": null},
    "secrets": {
      "findingCount": 13,
      "reported": 13,
      "byType": {"generic-credential-assignment": 9, "basic-auth-in-url": 4},
      "bySeverity": {"medium": 13},
      "items": [
        {"file": "lib/cli-options.js", "line": 38, "type": "basic-auth-in-url",
         "severity": "medium", "redacted": "http://admin:***(8 chars)@127.0.0.1:5984"}
      ],
      "disclaimer": "Demo-grade regex detection: no entropy analysis, no git history, ..."
    },
    "dependencies": {
      "analyzed": true, "packageName": "countinghouse", "packageVersion": "6.0.0",
      "counts": {"dependencies": 31, "devDependencies": 14, "peerDependencies": 0, "optionalDependencies": 1, "total": 46},
      "unpinnedCount": 46, "unpinnedByKind": {"caret": 46}, "suspicious": [],
      "lockfile": {"present": true, "name": "package-lock.json", "format": "npm-json",
                   "lockfileVersion": 3, "resolvedPackages": 979, "missingFromLockCount": 0},
      "notes": ["No network access: this is a manifest hygiene check, not a vulnerability scan. ..."]
    }
  },
  "bill": [
    {"hop": 1, "tool": "repo-scan/scan",       "charged": 1, "balance": -81, "billedTo": "your-key", "authorizedAs": "repo-review-internal", "wallMs": 58},
    {"hop": 2, "tool": "secret-detect/detect", "charged": 1, "balance": -82, "billedTo": "your-key", "authorizedAs": "repo-review-internal", "wallMs": 68},
    {"hop": 3, "tool": "dep-audit/audit",      "charged": 1, "balance": -83, "billedTo": "your-key", "authorizedAs": "repo-review-internal", "wallMs": 9}
  ],
  "dataFlow": {
    "sourceBytesRead": 2072066,
    "inProcessBytes": 4995458,
    "returnedBytes": 4057,
    "reductionFactor": 1231.3,
    "hops": [
      {"tool": "repo-scan/scan",       "inputBytes": 145,     "outputBytes": 2254198},
      {"tool": "secret-detect/detect", "inputBytes": 2254083, "outputBytes": 2430},
      {"tool": "dep-audit/audit",      "inputBytes": 480417,  "outputBytes": 4185}
    ],
    "measurement": "..."
  }
}
```

Exact counts vary with the contents of the directory you point it at, and even
on this repository they drift as the repository changes. The numbers above are
the run archived in [`recorded-round-trip.md`](recorded-round-trip.md), which
narrows the scan to repository source; the benchmark block further down uses
repo-scan's defaults and so reads a few more files, which is why its counts
differ slightly.

Read `dataFlow` as: **five megabytes moved between the modules, four kilobytes
came back.** `inProcessBytes` is the JSON byte length of every hop payload in
both directions; the hops actually travel as structured clones over a worker
`MessagePort`, so treat it as a measure of payload size, not of transport cost.
`returnedBytes` covers `findings` and `bill` and deliberately excludes the
`dataFlow` block itself, because a byte count that included itself could not be
computed. For end-to-end wire bytes measured from outside the server, use the
comparison script — that is the authoritative number.

## Token comparison

`token-comparison.js` runs the same review twice against the same server, with
the same four modules and the same work: **(a)** three separate tool calls,
with every intermediate result returned to the client and handed back down —
what an MCP client with three independent servers has to do — and **(b)** one
call to the composite.

The report below is copy-pasted from a real run. The script generates its own
summary from the measured numbers; nothing in this section is hand-written, and
nothing here may be edited by hand — re-run the script and paste again.

```
| | (a) three separate tools | (b) one composite tool | ratio |
|---|---|---|---|
| MCP tool calls | 3 | 1 | 3× |
| Response bytes (into model context) | 4.58 MB | 11.0 KB | **427×** |
| Estimated response tokens | ~1.20M | ~2.8k | 427× |
| Request bytes (out of model context) | 2.61 MB | 115 B | 23794× |
| Total bytes across the MCP boundary | 7.19 MB | 11.1 KB | 663× |
| End-to-end wall time (p50) | 414 ms | 206 ms | 2.01× |
| Samples | 5 | 5 | |

| Condition | Tool call | Request | Response |
|---|---|---|---|
| (a) | `repo_scan_scanservice_scan` | 109 B | 4.57 MB |
| (a) | `secret_detect_detectservice_detect` | 2.15 MB | 5.8 KB |
| (a) | `dep_audit_auditservice_audit` | 469.3 KB | 9.0 KB |
| (b) | `repo_review_reviewservice_review` | 115 B | 11.0 KB |

**Same work, checked rather than assumed**: both conditions reported 326 files / 2073177 bytes scanned, 15 credential finding(s) and 46 declared dependencies. The two work descriptors are identical.

**Context cost**: the client received 4.58 MB across 3 calls in (a) and 11.0 KB in one call in (b) -- 427× less. That is 4796423 bytes, an estimated ~1.20M tokens, that never entered a model context. The source code is the whole of the difference: it was read and analysed in both conditions, and only in (b) did it stay inside the server.

**Latency**: (b) took 206ms at p50 against (a)'s 414ms (2.01×). Both numbers are dominated by the tools' own work -- reading and regex-scanning 1.98 MB of source -- not by the transport, and (b) additionally pays for serializing every hop payload to build its dataFlow report. Treat the byte column as the result of this benchmark and the latency column as context for it.

**What (a) is charitable about**: its 2.61 MB of request body is this script copying an object in memory. A model client would have to emit those bytes as tool-call arguments, token by token, before the second and third calls could happen at all.
```

Tokens are **estimated at 4 bytes each**, not counted — there is no tokenizer
in the script. The estimate exists to make the byte counts legible; the ratio
the comparison rests on does not depend on the divisor.

Note that MCP responses carry their payload twice, once as `structuredContent`
and once serialized into `content[0].text`. Both conditions pay that, so it
cancels out of the ratio, but it inflates both absolute figures by roughly 2×.

## Identity and billing across four hops

`repo-review` builds its clients per call from `ctx`:

```js
ctx.serviceClient({deviceID, serviceID, as: 'repo-review-internal'}, cb)
```

Two identities, kept apart on purpose. The hop is **authorized** as `as` — the
composing module's own identity — so a caller granted only the composite device
can still trigger three inner calls it has no grant for. The hop is **billed**
to `ctx.caller`, the authenticated outer caller, so cost lands on whoever
actually made the request. Full rationale:
[`docs/composite-tools.md`](../../docs/composite-tools.md).

This demo exists partly to check that the behaviour holds one level deeper than
the two-hop case that established it. It does.
`verify-identity-passthrough.js` runs non-`--debug` and multi-tenant — the only
mode where the split is observable — and asserts that the caller sees exactly
one tool, that all three hops succeed without a caller grant, that `billedTo`
is the real caller on hop 3 exactly as on hop 1, that per-hop balances step by
exactly one charge each, that the caller pays 4 (outer call plus three hops),
and that the module identity pays **0**:

```
[1] tools/list for the caller: ["repo_review_reviewservice_review"]
[3] all 3 inner hops succeeded with no caller grant to the inner devices.
    hop 1 repo-scan/scan         charged=1 balance=-1 billedTo=caller-… authorizedAs=repo-review-internal
    hop 2 secret-detect/detect   charged=1 balance=-2 billedTo=caller-… authorizedAs=repo-review-internal
    hop 3 dep-audit/audit        charged=1 balance=-3 billedTo=caller-… authorizedAs=repo-review-internal
[4] caller paid 4 (outer call + 3 hops), module identity paid 0
```

## Honest boundaries

**`secret-detect` is demo-grade and is not a credential scanner.** It is about
twenty regular expressions. It has no entropy analysis, does not walk git
history, does not verify that a matched credential is live, and has no
allowlist or baseline. Use **gitleaks** or **trufflehog** for anything real —
they do all of the above, and this module deliberately does not try to. Two
consequences worth internalising before reading any output:

- **False positives are routine.** On this repository it flags
  `lib/error-info.zh-CN.json`'s `"...TOKEN": "<Chinese error message>"` as a
  credential assignment, and CouchDB's documented default
  `http://admin:12345678@127.0.0.1:5984` in three places. Both are correct
  pattern matches and neither is a leak.
- **A clean result proves nothing.** Any credential format outside the pattern
  list is invisible to it, and a base64 blob or a high-entropy string with no
  telltale prefix will not be found.

**`dep-audit` is not `npm audit`.** It never touches the network, so it has no
advisory database and cannot tell you whether a dependency is vulnerable. It
reports manifest hygiene: how many dependencies, which are unpinned, which use
specifiers that bypass registry version resolution.

**`repo-scan` does not read `.gitignore`.** It walks the filesystem, so it sees
untracked local files — editor state, local config, anything a real secret
scanner would skip because it is not in the repository. That is a real
difference from gitleaks, and on a developer machine it is the most likely
source of a surprising finding.

**Composition is in-process only.** All of this works because the four modules
are loaded into one countinghouse runtime and reach each other over the worker
message channel. Two modules on two different servers cannot compose this way,
and nothing here changes that. This is a platform capability, not an MCP
protocol extension — MCP has no notion of tool-to-tool calls, and none of this
touches JSON-RPC framing or the `tools/list`/`tools/call` contract.

**The comparison is between architectures, not implementations.**
Condition (a) is not a slow or badly written MCP server; it is the same server,
the same modules, and the same work, differing only in where composition
happens.

## Compared to code execution

The obvious alternative is code mode: give the model a sandbox, let it call
tools from a script it writes, and have the script return only a summary.
Being clear about this, because the comparison is often made unfairly —

**Code execution keeps source out of the context too.** A script that reads
files, greps them, and prints a count returns a count. The bytes never reach
the model. Any claim that composite tools are the only way to avoid pulling
data through a context window is wrong, and this demo does not make it.

Three differences that are actually real:

**1. Cross-process RPC versus in-process structured clone.** A code-mode script
typically reaches its tools over a process or network boundary — each call
serializes, crosses, and deserializes. Here the hops are `postMessage`
structured clones between worker threads in one process. That is genuinely
cheaper per hop, and it is also the difference that matters least: **what share
of total time it accounts for depends entirely on how long the tools themselves
take.** In this demo the tools do real work — reading and regex-scanning two
megabytes — and the transport is a small part of a ~200ms call. For a tool that
takes a second, it would be noise. `perf/cross-process-comparison.js` measures
the per-hop difference directly and prints, from its own numbers, the tool
execution time above which the difference falls under 10% of a hop. Do not
reach for this argument first.

**2. A generated script versus a published contract.** This is the difference
that matters. In code mode, the composition is a script the model wrote for
this request. It probably does not return the source — but "it did not this
time" and "it cannot" are different claims, and only the first is available.
The script is new every time, and what it returns is a property of that
particular generation.

`repo-review` is a published tool with a declared output schema. There is no
field in it that can hold a source file: every string is length-capped, every
array is bounded, `additionalProperties` is `false` throughout, and the runtime
validates the output before it leaves. The guarantee is a property of the
contract, checked by the platform, identical on every call — reviewable once,
by a human, rather than re-established per request. It is the difference
between *this run happened not to leak* and *there is nowhere for it to go*.

**3. It works for clients that cannot execute code.** Code mode needs a
sandbox: a runtime, an isolation boundary, and a client that offers one. A
composite tool is an ordinary MCP tool. Any client that can call
`tools/call` — including one with no code-execution capability at all, and
including a plain `curl` — gets the same one-call, bounded-response behaviour.
The capability lives on the server, so it does not have to exist on the client.

Two arguments this section deliberately does *not* make: that code mode costs
more because it involves the model (in an interactive session the model is
already in the loop, so that is not a cost difference), and that code mode
cannot achieve the byte reduction (it can).

The honest summary: for a one-off exploration by a capable client, code
execution is a fine answer and often a better one. For a composition you want
to publish, meter, authorize, and rely on — where the point is that *every*
caller gets the bounded response, not just the ones whose generated script
happened to be careful — a declared tool is the thing that holds.

## Files

```
examples/repo-review/
├── README.md                          this file
├── token-comparison.js                (a) vs (b), generated report
├── verify-identity-passthrough.js     4-hop identity/billing check, non---debug
├── recorded-round-trip.md             a real MCP client's request and response
├── repo-scan/                         reads files, returns full text
├── secret-detect/                     regex credential detection, masked output
├── dep-audit/                         offline manifest + lockfile analysis
└── repo-review/                       the composite; the only tool to expose
```

Each module is `package.json` + `api.json` + `schema.json` +
`handlers/<service>/<action>.js`, and nothing else.
