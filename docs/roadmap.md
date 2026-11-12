# Roadmap

Work agreed for after the first release (countinghouse 8.0 and the first
client pack). Each item gets its own design before it is built.

## Network and file traffic in the usage records

**Why.** The person reading usage numbers wants to check that a module stays
within bounds: which hosts it contacted, which files it touched, and how
much. On a client machine that is the user, checking privacy; on a hosted
runtime it is the operator, spotting a module that misbehaves or costs too
much. So the records gain each module's file and network traffic, in both
deployments, through the same usage files and `countinghouse_usage_report`
that LM1 adds.

**What can be measured, and how far it can be trusted** (investigated
2026-11-13 against master):

- **Files: measurable in every mode, by the main thread.** Every file call a
  module makes goes to its broker on the main thread under `off`, `audit` and
  `enforce` alike (docs/security-model.md, "The file broker and the virtual
  namespace"), so counts taken there cannot be hidden by the module. The
  broker can count operations and bytes read and written, split into the
  module's own namespace, outside paths it declared, and other outside
  paths, plus refusals. Not counted: the bounded loader's reads of the
  module's own code (lib/fs-broker/identity.js serves those directly).
- **Network: only the main-thread routes today.** Calls to remote MCP
  servers (RC1-min) and `ctx.redis` already pass through the main thread and
  can be measured exactly; remote calls are already usage records. A
  module's own sockets (`net`, `http`, `fetch`) are seen only by in-worker
  wrappers, which code in the worker can get around (docs/security-model.md,
  "No network permission is enforced yet"). Trustworthy counts for those
  arrive with sandbox parts 3 and 4, the main-thread network broker. Until
  then, any count of them must be labelled as reported by the worker, not
  measured.

**Constraints for the design.**

- No content and no credential value, ever, as for all usage records. Hosts
  appear as host and port; file locations as one of the three categories
  above, or the declared grant they fall under, not as full paths.
- Attribution to a call is exact when the module's worker runs one call at a
  time; with concurrent calls in one worker it is per worker, the same limit
  the usage ownership check states.
- Outside access and refusals are also what the audit work (P2, after the
  logger) records in full. The two are built on one path, not two.
