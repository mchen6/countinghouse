# Recorded round trip: Claude Code calling `repo_review`

A real MCP client, one `tools/call`, captured verbatim. Kept as evidence for
the claims in [`README.md`](README.md) — particularly that the source code the
review is derived from does not appear in the response.

Recorded 2026-08-17 on countinghouse 6.0.0, Node v20.20.2, Linux. The server
ran **without `--debug`**, multi-tenant, so the identity and authorization
behaviour shown here is the real one and not the bypass.

The call passes an explicit `exclude` that extends repo-scan's defaults with
`.claude/**`. That is worth reading as part of the demo rather than as
housekeeping: **repo-scan walks the filesystem and does not read
`.gitignore`**, so by default it also reads untracked local files — editor
state, agent config, anything a real credential scanner would skip because it
is not in the repository. On the machine this was recorded on, the default
scan duly reported a finding in a local agent config file that has nothing to
do with this repository. That is the documented boundary in
[`README.md`](README.md#honest-boundaries) showing up in practice, and
narrowing the scan to repository source is the right response to it.

## Setup

```sh
# auth.json: the caller is granted the composite device ONLY.
# The composing module's identity is granted the three inner devices.
{
  "reviewer-demo-key":      {"userName": "reviewer",             "devices": ["51b0d6ac-7a77-5083-8476-26a9be96a101"]},
  "repo-review-internal":   {"userName": "repo-review-internal", "devices": ["1359302a-e4fe-5c14-853b-f83638e8ca01",
                                                                            "7d4e06e9-0742-556b-a7f2-a32aee36e2e7",
                                                                            "01919ef1-dd71-5d42-99ce-98decb9a2408"]}
}
```

```sh
node ./framework.js --workerThread --bindAddr 127.0.0.1 --mcpToolCallCost 1 \
  --loadModule ./examples/repo-review/repo-scan \
  --loadModule ./examples/repo-review/secret-detect \
  --loadModule ./examples/repo-review/dep-audit \
  --loadModule ./examples/repo-review/repo-review

claude mcp add --scope local --transport http countinghouse-demo \
  http://127.0.0.1:9527/mcp --header "X-CH-Key: reviewer-demo-key"
```

```
$ claude mcp list
countinghouse-demo: http://127.0.0.1:9527/mcp (HTTP) - ✔ Connected
```

## 1. What the client discovers

`tools/list` for `reviewer-demo-key` returns **one** device tool. All four
modules are loaded; three of them are invisible to this key because it has no
grant to their devices, and `tools/list` filters per API key.

```json
{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
```

```json
{
  "tools": [
    {"name": "countinghouse_check_balance", "...": "platform tool, always present"},
    {"name": "repo_review_reviewservice_review", "...": "the composite"}
  ]
}
```

Its `outputSchema` (5,644 bytes, elided here — see
[`repo-review/schema.json`](repo-review/schema.json)) carries the structural
guarantee in its own description:

> The structural guarantee this demo is about lives here rather than in the
> handler: there is no property anywhere in this document capable of holding a
> source file. Every string is length-capped, every array is maxItems-capped,
> and additionalProperties is false at every level, so the response has a
> ceiling the runtime enforces on the way out -- independently of whether the
> handler behaves.

Inside the Claude Code session, the tool surfaces as
`mcp__countinghouse-demo__repo_review_reviewservice_review`.

## 2. Request

Every parameter has a default and the default target is the repository the
server is hosted in, so the only argument given is the `exclude` list
described above.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "repo_review_reviewservice_review",
    "arguments": {
      "exclude": ["node_modules/**", ".git/**", ".claude/**", "build/**", "dist/**",
                  "coverage/**", "**/*.min.js", "**/*.map", "pre-installed-packages/*.tgz"]
    }
  }
}
```

Request body: **257 bytes.**

## 3. Response

**10,478 bytes** on the wire. The MCP envelope carries the payload twice —
`content[0].text` is the same 4,954 bytes as `structuredContent`, serialized as
a string for clients that only read `content`. The `structuredContent` half,
verbatim and complete:

```json
{
  "output": {
    "findings": {
      "summary": "Reviewed 325 files (2072066 bytes) under /home/mchen6/mcp-runtime/cdif.code. Credential scan: 13 finding(s) (13 medium), all excerpts masked; detection is demo-grade regex matching, so treat hits as leads and a clean result as inconclusive. Dependencies: 46 declared, 46 not pinned to an exact version, 0 using a specifier that bypasses registry version resolution; lockfile package-lock.json resolves 979 packages. No network access was used, so this says nothing about known vulnerabilities.",
      "scanned": {
        "root": "/home/mchen6/mcp-runtime/cdif.code",
        "fileCount": 325,
        "byteCount": 2072066,
        "truncated": false,
        "truncationReason": null
      },
      "secrets": {
        "findingCount": 13,
        "reported": 13,
        "truncated": false,
        "byType": {
          "generic-credential-assignment": 9,
          "basic-auth-in-url": 4
        },
        "bySeverity": {
          "medium": 13
        },
        "items": [
          {
            "file": "test/direct-peer-channels/06-no-double-billing.js",
            "line": 25,
            "type": "generic-credential-assignment",
            "severity": "medium",
            "redacted": "API_KEY = 'com***(23 chars)'"
          },
          {
            "file": "test/auth/02-file-provider-unit.js",
            "line": 81,
            "type": "generic-credential-assignment",
            "severity": "medium",
            "redacted": "API_KEY = 'env***(12 chars)'"
          },
          {
            "file": "test/auth/02-file-provider-unit.js",
            "line": 130,
            "type": "generic-credential-assignment",
            "severity": "medium",
            "redacted": "API_KEY = 'env***(12 chars)'"
          },
          {
            "file": "test/auth/04-couchdb-provider.js",
            "line": 16,
            "type": "basic-auth-in-url",
            "severity": "medium",
            "redacted": "http://admin:***(8 chars)@127.0.0.1:5984"
          },
          {
            "file": "test/auth/10-balance-auth.js",
            "line": 12,
            "type": "generic-credential-assignment",
            "severity": "medium",
            "redacted": "apiKey\":\"tot***(19 chars)\""
          },
          {
            "file": "lib/cli-options.js",
            "line": 38,
            "type": "basic-auth-in-url",
            "severity": "medium",
            "redacted": "http://admin:***(8 chars)@127.0.0.1:5984"
          },
          {
            "file": "lib/error-info.zh-CN.json",
            "line": 30,
            "type": "generic-credential-assignment",
            "severity": "medium",
            "redacted": "TOKEN\": \"非法访***(9 chars)\""
          },
          {
            "file": "lib/error-info.zh-CN.json",
            "line": 31,
            "type": "generic-credential-assignment",
            "severity": "medium",
            "redacted": "TOKEN\": \"无法校***(11 chars)\""
          },
          {
            "file": "lib/error-info.zh-CN.json",
            "line": 42,
            "type": "generic-credential-assignment",
            "severity": "medium",
            "redacted": "TOKEN\": \"无法生***(11 chars)\""
          },
          {
            "file": "lib/couchdb-adapter/couchdb-auth-provider.js",
            "line": 47,
            "type": "basic-auth-in-url",
            "severity": "medium",
            "redacted": "http://admin:***(8 chars)@127.0.0.1:5984"
          },
          {
            "file": "lib/couchdb-adapter/init-db.js",
            "line": 50,
            "type": "basic-auth-in-url",
            "severity": "medium",
            "redacted": "http://admin:***(8 chars)@127.0.0.1:5984"
          },
          {
            "file": "examples/repo-review/token-comparison.js",
            "line": 65,
            "type": "generic-credential-assignment",
            "severity": "medium",
            "redacted": "API_KEY = 'tok***(21 chars)'"
          },
          {
            "file": "example/publish-api.js",
            "line": 44,
            "type": "generic-credential-assignment",
            "severity": "medium",
            "redacted": "password: '***(8 chars)'"
          }
        ],
        "disclaimer": "Demo-grade regex detection: no entropy analysis, no git history, no liveness check, no allowlist. Expect false positives (fixtures, docs) and false negatives (unknown formats). Not a substitute for gitleaks or trufflehog."
      },
      "dependencies": {
        "analyzed": true,
        "packageName": "countinghouse",
        "packageVersion": "6.0.0",
        "counts": {
          "dependencies": 31,
          "devDependencies": 14,
          "peerDependencies": 0,
          "optionalDependencies": 1,
          "total": 46
        },
        "unpinnedCount": 46,
        "unpinnedByKind": {
          "caret": 46
        },
        "suspicious": [],
        "lockfile": {
          "present": true,
          "name": "package-lock.json",
          "format": "npm-json",
          "lockfileVersion": 3,
          "resolvedPackages": 979,
          "missingFromLockCount": 0
        },
        "notes": [
          "No network access: this is a manifest hygiene check, not a vulnerability scan. It knows nothing about CVEs or advisories."
        ]
      }
    },
    "bill": [
      {
        "hop": 1,
        "tool": "repo-scan/scan",
        "charged": 1,
        "balance": -9,
        "billedTo": "reviewer-demo-key",
        "authorizedAs": "repo-review-internal",
        "wallMs": 194
      },
      {
        "hop": 2,
        "tool": "secret-detect/detect",
        "charged": 1,
        "balance": -10,
        "billedTo": "reviewer-demo-key",
        "authorizedAs": "repo-review-internal",
        "wallMs": 137
      },
      {
        "hop": 3,
        "tool": "dep-audit/audit",
        "charged": 1,
        "balance": -11,
        "billedTo": "reviewer-demo-key",
        "authorizedAs": "repo-review-internal",
        "wallMs": 26
      }
    ],
    "dataFlow": {
      "sourceBytesRead": 2072066,
      "inProcessBytes": 4995458,
      "returnedBytes": 4057,
      "reductionFactor": 1231.3,
      "hops": [
        {
          "tool": "repo-scan/scan",
          "inputBytes": 145,
          "outputBytes": 2254198
        },
        {
          "tool": "secret-detect/detect",
          "inputBytes": 2254083,
          "outputBytes": 2430
        },
        {
          "tool": "dep-audit/audit",
          "inputBytes": 480417,
          "outputBytes": 4185
        }
      ],
      "measurement": "inProcessBytes is the JSON byte length of every hop payload, both directions, summed. The hops actually travel as structured clones over a worker MessagePort, not as JSON, so this is a stable measure of payload size and not of transport cost. returnedBytes is the JSON byte length of this response's findings and bill; it excludes this dataFlow block itself (a further ~800 bytes), because a figure that counted itself could not be computed. For end-to-end wire bytes measured from outside the server, run examples/repo-review/token-comparison.js."
    }
  }
}
```

## 4. What the model did with it

The same call, driven through a headless Claude Code session
(`claude -p ... --output-format stream-json`), so the client-side view is
recorded too. Three turns, 20.4s wall including model time, one tool call.

```
[0] system/init   mcp: countinghouse-demo:connected
                  tools: mcp__countinghouse-demo__repo_review_reviewservice_review
[5] TOOL_USE      mcp__countinghouse-demo__repo_review_reviewservice_review
[6] TOOL_RESULT   4953 bytes
[13] result/success  turns=3  duration=20370ms
```

Its unprompted summary, quoted in full because the last two paragraphs are the
point:

> `repo_review` scanned **325 files / 2,072,066 bytes** under
> `/home/mchen6/mcp-runtime/cdif.code` (not truncated). The credential scan
> returned **13 findings, all severity medium** — 9
> `generic-credential-assignment` and 4 `basic-auth-in-url` — every one masked
> (e.g. `API_KEY = 'com***(23 chars)'`,
> `http://admin:***(8 chars)@127.0.0.1:5984`), located in test fixtures,
> `lib/cli-options.js`, the couchdb adapter, `lib/error-info.zh-CN.json`
> (Chinese error strings matching on the word TOKEN), and two examples.
> Dependencies: **46 declared** (31 runtime, 14 dev, 0 peer, 1 optional), **all
> 46 unpinned** via caret ranges, **0 suspicious** specifiers, with
> `package-lock.json` (lockfileVersion 3) resolving **979 packages** and
> nothing missing from the lock. The bill has **three hops —
> `repo-scan/scan`, `secret-detect/detect`, `dep-audit/audit` — 1 unit each**,
> all **billed to `reviewer-demo-key`** while authorized as
> `repo-review-internal`, taking the balance from −13 to **−15**. dataFlow:
> **2,072,066 source bytes read, 4,995,502 in-process bytes across hops, 4,058
> bytes returned — a reduction factor of 1231**.
>
> **No source code appeared in the response** — only masked fragments with file
> and line, counts, and the aggregate report.
>
> Two limits the tool asks to pass on: detection is demo-grade regex (no
> entropy analysis, no git history, no allowlist), so the hits are leads
> needing human confirmation and a clean result would not be proof of
> cleanliness; and the dependency audit is offline manifest hygiene only,
> saying nothing about CVEs.

It carried both disclaimers forward without being asked to. That is the
`description` fields in `api.json` doing the job they exist for — they are
written for a model to read, and this is the check that they land.

It also read the findings correctly as mostly false positives — test fixtures
and Chinese error strings that happen to contain the word TOKEN — which is the
behaviour the "treat hits as leads" disclaimer is trying to produce.

The model's per-hop figures differ from section 3's by a few bytes because it
made its own call rather than replaying the captured one; the balance runs
−13 to −15 rather than −9 to −11 for the same reason. Everything structural
is identical.

## 5. What the record shows

- **One call, 10,478 bytes.** The same review composed client-side moves
  4.59 MB into context across three calls — see
  [`token-comparison.js`](token-comparison.js) and the table in
  [`README.md`](README.md#token-comparison).
- **4,995,458 bytes moved between the three modules; 4,057 came back.** The
  2.07 MB of source that `repo-scan` read reached `secret-detect` and
  `dep-audit` and went no further.
- **No source text in the response.** Every excerpt is a masked credential
  match capped at 120 characters by the output schema. The longest free-text
  field in the whole payload is the `summary`.
- **Three hops, three independent charges, all to `reviewer-demo-key`** — the
  outer caller — while every hop was *authorized* as `repo-review-internal`.
  The caller has no grant to any of the three inner devices and never needed
  one. Balance steps −9, −10, −11 across the hops (the key had prior usage
  from earlier runs; a fresh identity starts at 0).
- **The caller could not have made these three calls itself.** `tools/list`
  showed it one tool.

## 6. Reproducing this

Findings drift with the contents of the directory scanned, and without the
`.claude/**` exclusion above `repo-scan` also reads untracked local files, so
counts will not match exactly. The structural facts — one call, no source in
the response, three hops billed to the caller — do reproduce.

```sh
node examples/repo-review/verify-identity-passthrough.js   # the identity/billing assertions
node examples/repo-review/token-comparison.js              # the byte comparison
```
