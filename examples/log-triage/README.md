# log-triage — a composite tool whose bill follows its input

Four modules. One tool. A directory of logs triaged in a single call, where
the number of metered hops depends on how many files there are — and the
caller decides the most it can cost before making the call.

[`repo-review`](../repo-review/README.md) is the flagship composite: three
hops, every time, on a workload where the intermediate data is large. This is
the other shape. Read that one for the byte arithmetic and the comparison with
code execution; read this one for what a composite's bill looks like when the
data decides it.

## What the demo demonstrates

1. **The bill follows the data, and the caller bounds it.** For `N` log files
   the composite makes `2N + 2` inner hops — one to list the directory, a read
   and a redact per file, one to cluster — and each is metered. With the outer
   call that is `2N + 3` charged to the caller. `maxFiles` (default 8) caps
   `N`, so the worst case, `2 × maxFiles + 3`, is known before the call.
   Files past the cap are not read and are named in the response. Checked on
   both hop paths: see [Verifying the bill](#verifying-the-bill).

2. **Raw log lines stay in the runtime.** Lines are read, masked and clustered
   in-process. The response carries counts and one masked sample per cluster,
   and the output schema has no field that could hold a line: every output
   string is either `maxLength`-capped or a fixed enum (the cluster `level`),
   every array has a `maxItems`, and `additionalProperties` is `false`
   throughout. The widest field that carries text from a log line is a
   cluster's masked `template` or `sample`, capped at 160 characters; the
   cluster `firstSeen` and `lastSeen` timestamps, also taken from log lines,
   are capped at 40.

## The four modules

| Module | Tool name | Role |
|---|---|---|
| [`log-read`](log-read/) | `log_read_readservice_list`, `log_read_readservice_read` | Lists the `*.log` files in one directory; returns one file's raw lines. The only module that touches the disk. |
| [`pii-redact`](pii-redact/) | `pii_redact_redactservice_redact` | Replaces e-mail addresses, IPv4 addresses, phone numbers, card-like digit runs and bearer tokens with tags. Pure function. |
| [`error-cluster`](error-cluster/) | `error_cluster_clusterservice_cluster` | Groups `WARN` and `ERROR` lines that differ only in numbers and identifiers. Pure function. |
| [`log-triage`](log-triage/) | `log_triage_triageservice_triage` | The composite, and the only tool meant to be reachable from outside. |

## Running it

Needs a running Redis.

```sh
npm run demo:log-triage
```

That first writes eight sample log files to `examples/log-triage/sample-logs/`
([`generate-logs.js`](generate-logs.js): seeded, so the files are byte-identical
on every machine, and git-ignored), then starts the server with
[`auth.json`](auth.json). Call it with the demo key:

```sh
curl -s -X POST http://127.0.0.1:9527/mcp -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "X-CH-Key: demo-key" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"log_triage_triageservice_triage","arguments":{"maxFiles":2}}}'
```

`demo-key` is a demo credential committed on purpose, usable only against a
server you started yourself on `127.0.0.1`. It is granted the composite and
nothing else; the three inner modules are granted to `log-triage-internal`,
the identity the composite's hops are authorized as.

Every planted value in the sample logs is fake by construction: `example.com`
addresses, the `203.0.113.0/24` documentation range, `555` phone numbers, the
standard test card number.

## Expected output

`maxFiles: 2` over the eight sample files — six hops, six files skipped:

```json
{
    "findings": {
        "summary": "Read 2 of 8 log file(s) under /path/to/countinghouse/examples/log-triage/sample-logs (6 skipped by maxFiles=2): 800 lines, 133 ERROR and 171 WARN, 0 unparsed. The 304 warning and error lines fall into 12 cluster(s); the 10 largest are listed. Masked 264 personal-data value(s) before clustering; masking is demo-grade regex matching, so a zero count is not evidence the logs hold none. This call made 6 internal hop(s) against a worst case of 6.",
        "files": {
            "dir": "/path/to/countinghouse/examples/log-triage/sample-logs",
            "read": [
                {
                    "name": "app-01.log",
                    "bytes": 33835,
                    "lineCount": 400,
                    "truncated": false
                },
                {
                    "name": "app-02.log",
                    "bytes": 34053,
                    "lineCount": 400,
                    "truncated": false
                }
            ],
            "skipped": [
                "app-03.log",
                "app-04.log",
                "app-05.log",
                "app-06.log",
                "app-07.log",
                "app-08.log"
            ]
        },
        "pii": {
            "total": 264,
            "email": 105,
            "ipv4": 94,
            "phone": 26,
            "card": 24,
            "bearerToken": 15
        },
        "levels": {
            "DEBUG": 135,
            "INFO": 361,
            "WARN": 171,
            "ERROR": 133,
            "unparsed": 0
        },
        "clusters": [
            {
                "template": "slow query took #ms table=orders",
                "level": "WARN",
                "count": 44,
                "firstSeen": "2026-09-01T00:04:08.098Z",
                "lastSeen": "2026-09-02T01:07:33.892Z",
                "sample": "slow query took 1820ms table=orders"
            },
            {
                "template": "upstream timeout after #ms calling inventory-service request=#",
                "level": "ERROR",
                "count": 37,
                "firstSeen": "2026-09-01T00:02:03.733Z",
                "lastSeen": "2026-09-02T00:56:20.692Z",
                "sample": "upstream timeout after 28214ms calling inventory-service request=10d4e8eb-2af2-f261-65a8-81cd424e42a8"
            },
            {
                "template": "connection pool exhausted, # requests waiting",
                "level": "WARN",
                "count": 31,
                "firstSeen": "2026-09-01T00:02:33.632Z",
                "lastSeen": "2026-09-02T00:58:14.002Z",
                "sample": "connection pool exhausted, 11 requests waiting"
            },
            {
                "template": "disk usage at #% on /var/data",
                "level": "WARN",
                "count": 29,
                "firstSeen": "2026-09-01T00:00:58.894Z",
                "lastSeen": "2026-09-02T00:58:39.533Z",
                "sample": "disk usage at 91% on /var/data"
            },
            {
                "template": "rate limit near threshold for client <ipv#>",
                "level": "WARN",
                "count": 27,
                "firstSeen": "2026-09-01T00:01:45.351Z",
                "lastSeen": "2026-09-02T01:00:50.975Z",
                "sample": "rate limit near threshold for client <ipv4>"
            },
            {
                "template": "payment declined for card <card> order=#",
                "level": "ERROR",
                "count": 24,
                "firstSeen": "2026-09-01T00:03:31.970Z",
                "lastSeen": "2026-09-02T01:06:29.585Z",
                "sample": "payment declined for card <card> order=31907"
            },
            {
                "template": "deprecated endpoint /api/v#/orders called by client #",
                "level": "WARN",
                "count": 22,
                "firstSeen": "2026-09-01T00:04:09.548Z",
                "lastSeen": "2026-09-02T00:59:52.069Z",
                "sample": "deprecated endpoint /api/v1/orders called by client 227"
            },
            {
                "template": "database connection lost to db-#.internal retry=#",
                "level": "ERROR",
                "count": 21,
                "firstSeen": "2026-09-01T00:04:34.709Z",
                "lastSeen": "2026-09-02T01:05:15.739Z",
                "sample": "database connection lost to db-1.internal retry=1"
            },
            {
                "template": "failed to send receipt to <email>: mailbox unavailable",
                "level": "ERROR",
                "count": 20,
                "firstSeen": "2026-09-01T00:06:57.625Z",
                "lastSeen": "2026-09-02T01:02:56.724Z",
                "sample": "failed to send receipt to <email>: mailbox unavailable"
            },
            {
                "template": "job # exceeded max attempts, moved to dead letter queue",
                "level": "ERROR",
                "count": 20,
                "firstSeen": "2026-09-01T00:00:40.475Z",
                "lastSeen": "2026-09-02T00:57:19.359Z",
                "sample": "job 772632716c43 exceeded max attempts, moved to dead letter queue"
            }
        ]
    },
    "bill": [
        {
            "hop": 1,
            "tool": "log-read/list",
            "file": null,
            "charged": 1,
            "balance": -1,
            "billedTo": "demo-key",
            "authorizedAs": "log-triage-internal"
        },
        {
            "hop": 2,
            "tool": "log-read/read",
            "file": "app-01.log",
            "charged": 1,
            "balance": -2,
            "billedTo": "demo-key",
            "authorizedAs": "log-triage-internal"
        },
        {
            "hop": 3,
            "tool": "pii-redact/redact",
            "file": "app-01.log",
            "charged": 1,
            "balance": -4,
            "billedTo": "demo-key",
            "authorizedAs": "log-triage-internal"
        },
        {
            "hop": 4,
            "tool": "log-read/read",
            "file": "app-02.log",
            "charged": 1,
            "balance": -3,
            "billedTo": "demo-key",
            "authorizedAs": "log-triage-internal"
        },
        {
            "hop": 5,
            "tool": "pii-redact/redact",
            "file": "app-02.log",
            "charged": 1,
            "balance": -5,
            "billedTo": "demo-key",
            "authorizedAs": "log-triage-internal"
        },
        {
            "hop": 6,
            "tool": "error-cluster/cluster",
            "file": null,
            "charged": 1,
            "balance": -6,
            "billedTo": "demo-key",
            "authorizedAs": "log-triage-internal"
        }
    ],
    "cost": {
        "filesRead": 2,
        "hops": 6,
        "charged": 6,
        "maxFiles": 2,
        "worstCaseHops": 6
    }
}
```

Read `bill` with one thing in mind: it is ordered by position — list, then
read and redact for each file in name order, then cluster — not by when each
hop finished. The per-file chains run concurrently, so `balance` is each hop's
own running balance and does not step down evenly through the list. `cost`
is the part to read for totals.

## Verifying the bill

```sh
node examples/log-triage/verify-cost-bound.js
```

The script starts its own non-`--debug`, multi-tenant server, once on the
default hop path and once with `--directPeerChannels`, and asserts for each:
the caller sees exactly one tool; for `maxFiles` of 1, 3, 8 and 32 over eight
files the hop count is `2N + 2`, every hop is charged once and billed to the
caller, and the caller's balance moved by exactly `2N + 3` while the module
identity's did not move; an empty directory costs one hop; and no planted
value appears anywhere in a response.

Copy-pasted from a real run:

```
=== main-thread-routed (port 9596) ===
[1] tools/list for the caller: ["log_triage_triageservice_triage"]
[2] maxFiles=1  files read=1 skipped=7 hops=4 caller paid=5 module identity paid=0
[2] maxFiles=3  files read=3 skipped=5 hops=8 caller paid=9 module identity paid=0
[2] maxFiles=8  files read=8 skipped=0 hops=18 caller paid=19 module identity paid=0
[2] maxFiles=32 files read=8 skipped=0 hops=18 caller paid=19 module identity paid=0
[3] empty directory: hops=1 caller paid=2

=== directPeerChannels (port 9597) ===
[1] tools/list for the caller: ["log_triage_triageservice_triage"]
[2] maxFiles=1  files read=1 skipped=7 hops=4 caller paid=5 module identity paid=0
[2] maxFiles=3  files read=3 skipped=5 hops=8 caller paid=9 module identity paid=0
[2] maxFiles=8  files read=8 skipped=0 hops=18 caller paid=19 module identity paid=0
[2] maxFiles=32 files read=8 skipped=0 hops=18 caller paid=19 module identity paid=0
[3] empty directory: hops=1 caller paid=2

RESULT: on both hop paths the caller paid 2N + 3 for N files, the cap held, the module identity paid nothing, and no planted value was returned.
```

The suite runs the same script (`test/composition/10-log-triage-example.js`).

## Honest boundaries

**`pii-redact` is demo-grade and is not a PII scanner.** It is five regular
expressions. It knows nothing about names, postal addresses or national
identifiers, and any format outside those five patterns passes through
untouched — into the cluster samples, and so into the response. A zero count
proves nothing. It also over-matches: any run of 13 or more digits is masked
as a card number.

**The cap is the caller's, not the platform's.** `maxFiles` bounds the bill
because the composite honours it. The platform itself applies its balance
check and rate limit at the outer call only, not per hop
([`docs/composite-tools.md`](../../docs/composite-tools.md)), so a caller with
almost no balance can still trigger every hop of one call.

**A failed call is still charged for the hops that ran.** If any hop fails the
whole call fails, with no partial result. Metering has already happened for
the hops that completed, and because the per-file chains are concurrent, hops
in other chains may complete — and be charged — after the first failure.

**Concurrency helps the reads more than the masking.** Each module runs in one
worker thread. The `read` hops overlap because they wait on I/O; the `redact`
hops are CPU-bound work in a single worker and run roughly one after another.

**`log-read` reads the directory it is given.** A file name is confined to
that directory — no path separators, no symbolic links — but `dir` itself is
the caller's choice. A real deployment would restrict it to an allowlist.

**Composition is in-process only**, as for every composite here: the four
modules must be loaded into the same runtime.

## Files

```
examples/log-triage/
├── README.md              this file
├── auth.json              demo-key and the module identity
├── generate-logs.js       seeded sample logs with planted fake PII
├── verify-cost-bound.js   the bill, asserted on both hop paths
├── log-read/              lists and reads log files
├── pii-redact/            masks personal data
├── error-cluster/         groups warnings and errors
└── log-triage/            the composite; the only tool to expose
```
