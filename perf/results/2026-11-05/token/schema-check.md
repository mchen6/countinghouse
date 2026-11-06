| tool | schema | path | type | required | constraints | additionalProperties |
|---|---|---|---|---|---|---|
| countinghouse_check_balance | input | `$` | object | - |  | undefined |
| countinghouse_check_balance | output | `$` | object | - |  | undefined |
| countinghouse_check_balance | output | `$.apiKey` | string | no |  |  |
| countinghouse_check_balance | output | `$.balance` | number|null | no |  |  |
| log_read_readservice_list | input | `$` | object | - |  | false |
| log_read_readservice_list | input | `$.dir` | string | no | minLength=1, maxLength=4096 |  |
| log_read_readservice_list | output | `$` | object | - |  | false |
| log_read_readservice_list | output | `$.dir` | string | yes |  |  |
| log_read_readservice_list | output | `$.files` | array | yes | maxItems=256 |  |
| log_read_readservice_list | output | `$.files[]` | object | - |  | false |
| log_read_readservice_list | output | `$.files[].name` | string | yes |  |  |
| log_read_readservice_list | output | `$.files[].bytes` | integer | yes |  |  |
| log_read_readservice_read | input | `$` | object | - |  | false |
| log_read_readservice_read | input | `$.dir` | string | no | minLength=1, maxLength=4096 |  |
| log_read_readservice_read | input | `$.name` | string | yes | minLength=1, maxLength=255 |  |
| log_read_readservice_read | input | `$.maxBytes` | integer | no | minimum=1, maximum=16777216 |  |
| log_read_readservice_read | output | `$` | object | - |  | false |
| log_read_readservice_read | output | `$.name` | string | yes |  |  |
| log_read_readservice_read | output | `$.bytes` | integer | yes |  |  |
| log_read_readservice_read | output | `$.lineCount` | integer | yes |  |  |
| log_read_readservice_read | output | `$.truncated` | boolean | yes |  |  |
| log_read_readservice_read | output | `$.lines` | array | yes |  |  |
| log_read_readservice_read | output | `$.lines[]` | string | - |  |  |
| pii_redact_redactservice_redact | input | `$` | object | - |  | false |
| pii_redact_redactservice_redact | input | `$.lines` | array | yes |  |  |
| pii_redact_redactservice_redact | input | `$.lines[]` | string | - |  |  |
| pii_redact_redactservice_redact | output | `$` | object | - |  | false |
| pii_redact_redactservice_redact | output | `$.lines` | array | yes |  |  |
| pii_redact_redactservice_redact | output | `$.lines[]` | string | - |  |  |
| pii_redact_redactservice_redact | output | `$.counts` | object | yes |  | false |
| pii_redact_redactservice_redact | output | `$.counts.email` | integer | yes |  |  |
| pii_redact_redactservice_redact | output | `$.counts.ipv4` | integer | yes |  |  |
| pii_redact_redactservice_redact | output | `$.counts.phone` | integer | yes |  |  |
| pii_redact_redactservice_redact | output | `$.counts.card` | integer | yes |  |  |
| pii_redact_redactservice_redact | output | `$.counts.bearerToken` | integer | yes |  |  |
| error_cluster_clusterservice_cluster | input | `$` | object | - |  | false |
| error_cluster_clusterservice_cluster | input | `$.lines` | array | yes |  |  |
| error_cluster_clusterservice_cluster | input | `$.lines[]` | string | - |  |  |
| error_cluster_clusterservice_cluster | input | `$.topClusters` | integer | no | minimum=1, maximum=50 |  |
| error_cluster_clusterservice_cluster | output | `$` | object | - |  | false |
| error_cluster_clusterservice_cluster | output | `$.lineCount` | integer | yes |  |  |
| error_cluster_clusterservice_cluster | output | `$.unparsed` | integer | yes |  |  |
| error_cluster_clusterservice_cluster | output | `$.byLevel` | object | yes |  | false |
| error_cluster_clusterservice_cluster | output | `$.byLevel.DEBUG` | integer | yes |  |  |
| error_cluster_clusterservice_cluster | output | `$.byLevel.INFO` | integer | yes |  |  |
| error_cluster_clusterservice_cluster | output | `$.byLevel.WARN` | integer | yes |  |  |
| error_cluster_clusterservice_cluster | output | `$.byLevel.ERROR` | integer | yes |  |  |
| error_cluster_clusterservice_cluster | output | `$.clusterCount` | integer | yes |  |  |
| error_cluster_clusterservice_cluster | output | `$.clusters` | array | yes | maxItems=50 |  |
| error_cluster_clusterservice_cluster | output | `$.clusters[]` | object | - |  | false |
| error_cluster_clusterservice_cluster | output | `$.clusters[].template` | string | yes | maxLength=160 |  |
| error_cluster_clusterservice_cluster | output | `$.clusters[].level` | string | yes | enum=["WARN","ERROR"] |  |
| error_cluster_clusterservice_cluster | output | `$.clusters[].count` | integer | yes |  |  |
| error_cluster_clusterservice_cluster | output | `$.clusters[].firstSeen` | string | yes | maxLength=40 |  |
| error_cluster_clusterservice_cluster | output | `$.clusters[].lastSeen` | string | yes | maxLength=40 |  |
| error_cluster_clusterservice_cluster | output | `$.clusters[].sample` | string | yes | maxLength=160 |  |
| log_triage_triageservice_triage | input | `$` | object | - |  | false |
| log_triage_triageservice_triage | input | `$.dir` | string | no | minLength=1, maxLength=4096 |  |
| log_triage_triageservice_triage | input | `$.maxFiles` | integer | no | minimum=1, maximum=32 |  |
| log_triage_triageservice_triage | input | `$.maxBytesPerFile` | integer | no | minimum=1, maximum=16777216 |  |
| log_triage_triageservice_triage | input | `$.topClusters` | integer | no | minimum=1, maximum=50 |  |
| log_triage_triageservice_triage | output | `$` | object | - |  | false |
| log_triage_triageservice_triage | output | `$.findings` | object | yes |  | false |
| log_triage_triageservice_triage | output | `$.findings.summary` | string | yes | maxLength=1000 |  |
| log_triage_triageservice_triage | output | `$.findings.files` | object | yes |  | false |
| log_triage_triageservice_triage | output | `$.findings.files.dir` | string | yes | maxLength=4096 |  |
| log_triage_triageservice_triage | output | `$.findings.files.read` | array | yes | maxItems=32 |  |
| log_triage_triageservice_triage | output | `$.findings.files.read[]` | object | - |  | false |
| log_triage_triageservice_triage | output | `$.findings.files.read[].name` | string | yes | maxLength=255 |  |
| log_triage_triageservice_triage | output | `$.findings.files.read[].bytes` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.findings.files.read[].lineCount` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.findings.files.read[].truncated` | boolean | yes |  |  |
| log_triage_triageservice_triage | output | `$.findings.files.skipped` | array | yes | maxItems=256 |  |
| log_triage_triageservice_triage | output | `$.findings.files.skipped[]` | string | - | maxLength=255 |  |
| log_triage_triageservice_triage | output | `$.findings.pii` | object | yes |  | false |
| log_triage_triageservice_triage | output | `$.findings.pii.email` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.findings.pii.ipv4` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.findings.pii.phone` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.findings.pii.card` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.findings.pii.bearerToken` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.findings.pii.total` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.findings.levels` | object | yes |  | false |
| log_triage_triageservice_triage | output | `$.findings.levels.DEBUG` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.findings.levels.INFO` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.findings.levels.WARN` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.findings.levels.ERROR` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.findings.levels.unparsed` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.findings.clusters` | array | yes | maxItems=50 |  |
| log_triage_triageservice_triage | output | `$.findings.clusters[]` | object | - |  | false |
| log_triage_triageservice_triage | output | `$.findings.clusters[].template` | string | yes | maxLength=160 |  |
| log_triage_triageservice_triage | output | `$.findings.clusters[].level` | string | yes | enum=["WARN","ERROR"] |  |
| log_triage_triageservice_triage | output | `$.findings.clusters[].count` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.findings.clusters[].firstSeen` | string | yes | maxLength=40 |  |
| log_triage_triageservice_triage | output | `$.findings.clusters[].lastSeen` | string | yes | maxLength=40 |  |
| log_triage_triageservice_triage | output | `$.findings.clusters[].sample` | string | yes | maxLength=160 |  |
| log_triage_triageservice_triage | output | `$.bill` | array | yes | maxItems=66 |  |
| log_triage_triageservice_triage | output | `$.bill[]` | object | - |  | false |
| log_triage_triageservice_triage | output | `$.bill[].hop` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.bill[].tool` | string | yes | maxLength=64 |  |
| log_triage_triageservice_triage | output | `$.bill[].file` | string|null | yes | maxLength=255 |  |
| log_triage_triageservice_triage | output | `$.bill[].charged` | number|null | yes |  |  |
| log_triage_triageservice_triage | output | `$.bill[].balance` | number|null | yes |  |  |
| log_triage_triageservice_triage | output | `$.bill[].billedTo` | string|null | yes | maxLength=128 |  |
| log_triage_triageservice_triage | output | `$.bill[].authorizedAs` | string|null | yes | maxLength=128 |  |
| log_triage_triageservice_triage | output | `$.cost` | object | yes |  | false |
| log_triage_triageservice_triage | output | `$.cost.filesRead` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.cost.hops` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.cost.charged` | number | yes |  |  |
| log_triage_triageservice_triage | output | `$.cost.maxFiles` | integer | yes |  |  |
| log_triage_triageservice_triage | output | `$.cost.worstCaseHops` | integer | yes |  |  |

Problems (6):
- countinghouse_check_balance input $: object has no "required" list
- countinghouse_check_balance input $: additionalProperties is undefined, not false
- countinghouse_check_balance output $: object has no "required" list
- countinghouse_check_balance output $: additionalProperties is undefined, not false
- log_read_readservice_list input $: object has no "required" list
- log_triage_triageservice_triage input $: object has no "required" list

Stops (0):
