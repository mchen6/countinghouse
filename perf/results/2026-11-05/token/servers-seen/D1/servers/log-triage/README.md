# log-triage

Four async functions, one per tool of the log-triage server. Each takes one
input object and returns a promise of the tool's result.

| Function | File | Input type | Output type |
|---|---|---|---|
| `list(input)` | `./list.js` | `ListInput` | `ListOutput` |
| `read(input)` | `./read.js` | `ReadInput` | `ReadOutput` |
| `redact(input)` | `./redact.js` | `RedactInput` | `RedactOutput` |
| `cluster(input)` | `./cluster.js` | `ClusterInput` | `ClusterOutput` |

The types are in [`types.d.ts`](types.d.ts). Each function's JSDoc in its own
file has the tool's description. Import a function with
`const {list} = require('./servers/log-triage/list.js')`.
