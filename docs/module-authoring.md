# Module authoring

**Describe what you want to a coding agent; get a validated, loaded, callable
countinghouse module back — with the design approved before any file exists.**

Authoring a module means making `api.json`, `schema.json` and a `handlers/`
tree agree with each other. Getting that wrong used to be quiet: the module
loaded, nothing appeared in `tools/list`, and the log said nothing useful.
Finding out took a running framework, which took Redis.

This toolchain removes both problems. Validation runs standalone in
milliseconds, and the four MCP tools below let an agent drive the whole loop
without a human editing JSON.

## The division of labour

The tempting design is a tool that reads a natural-language requirement and
returns a module. It is the wrong one: such a tool needs a model behind it,
while the thing calling it *is already a model* — one holding the user's
codebase and the conversation. You would be putting a smaller, blinder model
inside a tool call, where nobody can see its reasoning.

**The agent thinks; countinghouse supplies ground truth the agent cannot
derive.** Decomposing a requirement into services and actions happens in the
agent's conversation with the user, where the user can correct it. What this
toolchain contributes is knowledge (a skill) and checks (tools that answer
precisely and cheaply).

## From a shell

```sh
npx countinghouse-validate ./my-module
```

Checks `api.json`, `schema.json` and the handler map against each other, and
prints **every** problem it finds — each naming the stage, what was found, and
the way out — rather than stopping at the first. No Redis, no server.

Exit codes are the contract: `0` clean, `1` problems found, `2` path unusable.
`--json` emits the result as one JSON document for machine consumers.

`--verifyModule` still exists for checking a module inside a running
framework; it needs Redis and a booted server, which is why the CLI leads.

## From an agent

Start the runtime with `--authoringTools` and call it with an admin key. Four
tools appear:

| Tool | Purpose |
|---|---|
| `countinghouse_validate_plan` | Check a proposed device/services/actions split **before any file exists** — names, duplicates, missing descriptions, collisions with tools already on this runtime, and an optional `calls` array (see [Composing](#composing-countinghousecalls) below). Returns the tool names the plan would produce. |
| `countinghouse_validate_module` | The CLI's check over MCP. Returns `{ok, module, problems}`. |
| `countinghouse_load_module` | Load a module from a local path into the running runtime. Returns the tool names it made callable, plus `discoveryComplete`. |
| `countinghouse_call_tool` | Invoke a tool by name — so a just-loaded module can be called without waiting for the client to refresh its tool list. |

### The loop

1. Propose the split, **show the user, wait** — this is where a wrong
   assumption is cheap.
2. `countinghouse_validate_plan`.
3. Write `package.json`, `api.json`, `schema.json`, `handlers/`.
4. `countinghouse_validate_module`, until `ok: true`. It returns every problem
   at once; do not fix them one per run.
5. `countinghouse_load_module`. If `discoveryComplete` is `false`, `toolNames`
   may be incomplete and the call is worth retrying.
6. `countinghouse_call_tool` with one of those names, and real arguments.
7. Show the user the call and its output.

The skill that drives this ships in the repo at
[`.claude/skills/countinghouse-module/SKILL.md`](../.claude/skills/countinghouse-module/SKILL.md),
so pointing a coding agent at a clone is enough — nothing to install.

Its first rule is the one worth repeating here: **decide what a tool is
allowed to return before deciding what it does.** The output schema is the
guarantee. A tool whose schema has no field that can hold a file cannot leak
a file, whatever its handler does or a model asks of it.

## Composing: `countinghouse.calls`

A module that needs to call another module by name declares what it may call
in **its own `package.json`**, not `api.json` — the device spec format did
not change for this at all:

```json
{
  "countinghouse": {
    "calls": ["repo-scan/scanService.scan", "secret-detect/detectService.detect"]
  }
}
```

Each entry is an address, `<module>/<service>.<action>` — the target's
`friendlyName`, the raw last segment of its service URN, and its action
name. Not the target's MCP tool name (`repo_scan_scanservice_scan`): that's
deduped and load-order-dependent, so it cannot be hardcoded reliably. The
handler then calls it with `ctx.call('repo-scan/scanService.scan', input)` —
see [`module-development.md`](module-development.md#calling-other-modules) for
the full mechanism.

**The identity is not yours to declare.** A module says what it calls; it
never says who it calls as. Which auth identity a module's inner hops are
authorized as is bound separately, after the module is written, by the
operator listing the module's `friendlyName` in that identity's
`runsModules` entry in the auth config. That split is deliberate: the same
module can be deployed twice, under two different identities with two
different grants, without editing it.

**Both validators know about `calls`, at different depths.** They cannot
substitute for each other:

- `countinghouse_validate_plan` accepts an optional `calls` array in the same
  shape, checked against whatever targets are already loaded on this
  runtime — useful for approving a chain's shape before any file exists.
- `countinghouse_validate_module` (and the CLI it wraps) checks `package.json`'s
  real `countinghouse.calls` for shape and duplicates, with no server needed
  — but it cannot know whether a named module, service or action actually
  exists, only that the address is well-formed.
- **Neither one binds the identity or confirms the grant.** That check —
  along with confirming the target actually exists — happens only when the
  module is loaded into a running runtime (`DeviceManager`'s composition
  verification, which runs once discovery finishes). A module can validate
  clean and still fail at load time if no identity's `runsModules` claims it,
  or if the bound identity lacks a grant to a declared target. Load it (step
  5 of the loop) and check the server log before declaring the chain done.

## Why `tools/list` does not update by itself

The server is already correct — `tools/list` is recomputed from live device
specs on every request, so a loaded module appears on the next call. What is
missing is the `notifications/tools/list_changed` push, and sending one would
require a server→client channel that stateless Streamable HTTP does not have.
Advertising the capability without being able to deliver it would be a lie in
`capabilities`.

So the loop routes around it: `load_module` returns the names it made
callable, and `call_tool` invokes them.

## Security boundary

**Two independent gates: `--authoringTools` (default off) AND an admin key.**
Neither alone is sufficient, and the flag is checked before any identity work,
so admin-ness cannot substitute for it.

Default-off matters because `load_module` plus `call_tool` is arbitrary code
execution with a friendly name. It must not be one flag-flip away on a
deployment that merely happens to have an admin key configured.

With the flag off, these tools are **byte-identical to tools that do not
exist** — same JSON-RPC envelope, same error code — so a caller cannot detect
that the feature is present. That property is structural: the disabled
response is produced by the same line of code as a genuinely unknown tool, not
by a second call site kept in sync by hand.

`countinghouse_validate_module` runs the module under test in a **spawned
child process**, so a crash or a `process.exit()` in caller-supplied code
kills the child, not the gateway — and a re-validated module is never served
from a stale `require` cache.

**This is a local development flow**: an agent holding an admin key against a
runtime the user started. It is not a multi-tenant feature.

## Known limits

- **`load_module` loads into the runtime and cannot be isolated.** A module
  whose entry calls `process.exit()` will take the server down when running
  without `--workerThread`. **Use `--workerThread` when authoring** — the
  worker dies instead, and the call returns a reported failure after a bounded
  15s wait. Running `validate_module` first (step 4) catches this case anyway.
- **`discoveryComplete: false`** means the post-load discovery wait ran out;
  `toolNames` may be incomplete. Retry rather than treating it as final.
- **`validate_plan` is deliberately provisional.** It catches a subset of what
  `validate_module` catches, earlier. If agents skip it and go straight to
  writing files, it should be deleted rather than defended.

## Reference

- [`module-development.md`](module-development.md) — the module format itself
- [`composite-tools.md`](composite-tools.md) — modules that call other modules
- [`cli-and-api-reference.md`](cli-and-api-reference.md) — flags and endpoints
- [`security-model.md`](security-model.md) — what worker isolation does and does not provide
