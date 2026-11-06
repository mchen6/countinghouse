# log-triage

Four async functions, one per tool of the log-triage server. Each takes one
input object and returns a promise of the tool's result.

| Function | File | Input type | Output type |
|---|---|---|---|
| `list(input)` | `./list.js` | `ListInput` | not declared |
| `read(input)` | `./read.js` | `ReadInput` | not declared |
| `redact(input)` | `./redact.js` | `RedactInput` | not declared |
| `cluster(input)` | `./cluster.js` | `ClusterInput` | not declared |

The types are in [`types.d.ts`](types.d.ts). Each function's JSDoc in its own
file has the tool's description. Import a function with
`const {list} = require('./servers/log-triage/list.js')`.
