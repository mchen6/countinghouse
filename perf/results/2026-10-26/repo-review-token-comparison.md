
| | (a) three separate tools | (b) one composite tool | ratio |
|---|---|---|---|
| MCP tool calls | 3 | 1 | 3× |
| Response bytes (into model context) | 6.08 MB | 10.7 KB | **579×** |
| Estimated response tokens | ~1.59M | ~2.8k | 579× |
| Request bytes (out of model context) | 3.32 MB | 115 B | 30301× |
| Total bytes across the MCP boundary | 9.40 MB | 10.9 KB | 886× |
| End-to-end wall time (p50) | 301 ms | 172 ms | 1.75× |
| Samples | 5 | 5 | |

| Condition | Tool call | Request | Response |
|---|---|---|---|
| (a) | `repo_scan_scanservice_scan` | 109 B | 6.06 MB |
| (a) | `secret_detect_detectservice_detect` | 2.88 MB | 5.6 KB |
| (a) | `dep_audit_auditservice_audit` | 456.5 KB | 8.4 KB |
| (b) | `repo_review_reviewservice_review` | 115 B | 10.7 KB |

**Same work, checked rather than assumed**: both conditions reported 492 files / 2791701 bytes scanned, 14 credential finding(s) and 42 declared dependencies. The two work descriptors are identical.

**Context cost**: the client received 6.08 MB across 3 calls in (a) and 10.7 KB in one call in (b) -- 579× less. That is 6360705 bytes, an estimated ~1.59M tokens, that never entered a model context. The source code is the whole of the difference: it was read and analysed in both conditions, and only in (b) did it stay inside the server.

**Latency**: (b) took 172ms at p50 against (a)'s 301ms (1.75×). Both numbers are dominated by the tools' own work -- reading and regex-scanning 2.66 MB of source -- not by the transport, and (b) additionally pays for serializing every hop payload to build its dataFlow report. Treat the byte column as the result of this benchmark and the latency column as context for it.

**What (a) is charitable about**: its 3.32 MB of request body is this script copying an object in memory. A model client would have to emit those bytes as tool-call arguments, token by token, before the second and third calls could happen at all.

{
  "conditionA": {
    "samples": 5,
    "toolCalls": 3,
    "requestBytes": 3484578,
    "responseBytes": 6371712,
    "wallMsP50": 301,
    "work": {
      "files": 492,
      "bytes": 2791701,
      "secretFindings": 14,
      "deps": 42
    }
  },
  "conditionB": {
    "samples": 5,
    "toolCalls": 1,
    "requestBytes": 115,
    "responseBytes": 11007,
    "wallMsP50": 172,
    "work": {
      "files": 492,
      "bytes": 2791701,
      "secretFindings": 14,
      "deps": 42
    }
  },
  "lastRun": {
    "aCalls": [
      {
        "tool": "repo_scan_scanservice_scan",
        "requestBytes": 109,
        "responseBytes": 6357414
      },
      {
        "tool": "secret_detect_detectservice_detect",
        "requestBytes": 3017024,
        "responseBytes": 5719
      },
      {
        "tool": "dep_audit_auditservice_audit",
        "requestBytes": 467445,
        "responseBytes": 8579
      }
    ],
    "bCalls": [
      {
        "tool": "repo_review_reviewservice_review",
        "requestBytes": 115,
        "responseBytes": 11007
      }
    ],
    "dataFlow": {
      "sourceBytesRead": 2791701,
      "inProcessBytes": 6507801,
      "returnedBytes": 4312,
      "reductionFactor": 1509.2,
      "hops": [
        {
          "tool": "repo-scan/scan",
          "inputBytes": 2,
          "outputBytes": 3017026
        },
        {
          "tool": "secret-detect/detect",
          "inputBytes": 3016909,
          "outputBytes": 2654
        },
        {
          "tool": "dep-audit/audit",
          "inputBytes": 467336,
          "outputBytes": 3874
        }
      ],
      "measurement": "inProcessBytes is the JSON byte length of every hop payload, both directions, summed. The hops actually travel as structured clones over a worker MessagePort, not as JSON, so this is a stable measure of payload size and not of transport cost. returnedBytes is the JSON byte length of this response's findings and bill; it excludes this dataFlow block itself (a further ~800 bytes), because a figure that counted itself could not be computed. For end-to-end wire bytes measured from outside the server, run examples/repo-review/token-comparison.js."
    },
    "bill": [
      {
        "hop": 1,
        "tool": "repo-scan/scan",
        "charged": 1,
        "balance": -39,
        "billedTo": "token-comparison-demo",
        "authorizedAs": "repo-review-internal",
        "wallMs": 33
      },
      {
        "hop": 2,
        "tool": "secret-detect/detect",
        "charged": 1,
        "balance": -40,
        "billedTo": "token-comparison-demo",
        "authorizedAs": "repo-review-internal",
        "wallMs": 72
      },
      {
        "hop": 3,
        "tool": "dep-audit/audit",
        "charged": 1,
        "balance": -41,
        "billedTo": "token-comparison-demo",
        "authorizedAs": "repo-review-internal",
        "wallMs": 6
      }
    ]
  },
  "bytesPerTokenEstimate": 4
}
