# Module authoring toolchain — design

*2026-08-22. Status: approved design, not yet implemented.*

## Problem

countinghouse only pays off if tools live on it, and today getting a tool
onto it means hand-writing `api.json`, `schema.json` and a handler tree,
then booting the whole framework — Redis included — to find out whether the
three agree with each other. That loop is slow for a human and worse for an
agent, which is increasingly who writes this code.

The goal is that a user describes what they want in natural language to a
coding agent, and a working, validated, loaded countinghouse module comes
out the other side, with the user reviewing the design before any code
exists.

## The division of labour

The tempting design is a tool that takes a natural-language requirement and
returns a module. It is the wrong one. Such a tool needs a model behind it —
its own credentials, its own prompt, its own bill — while the thing calling
it is already a model, one that has the user's codebase, the conversation,
and everything they said five minutes ago. The result would be a smaller,
blinder model reasoning invisibly inside a tool call.

**The agent thinks; countinghouse supplies ground truth the agent cannot
derive.** Decomposing a requirement into services and actions happens in the
agent's conversation with the user, where the user can correct it. What
countinghouse contributes is knowledge (a skill) and checks (tools that
answer precisely and cheaply).

## Non-goals

- **No scaffolding generator or template engine.** Writing files is what
  agents are good at; generation is not the bottleneck.
- **No derived/single-file module format**, and **no TypeScript authoring
  support**. Both are worth doing and both are out of scope here.
- **No `unload`/`restart` wrappers.** The admin HTTP surface already has
  them.
- **No remote/multi-tenant authoring.** See "Security boundary".

## Components

### 1. `lib/module-validator.js` — the oracle, unwrapped

The checks that matter already exist and are already the right shape.
`lib/handler-map.js`'s `validateHandlerMap` collects *every* problem rather
than throwing on the first, and each message names the module, the stage,
the offending name, what was found instead, and the way out. Spec and schema
validation exist alongside it.

What does not exist is a way to run them without booting the framework:
`framework.js` initialises Redis at startup (`framework.js:80`), so today
verifying a module means standing up the runtime.

The gap is narrower than it looks. `validateHandlerMap(spec, handlerMap,
moduleName)` is already a pure function, and `lib/handler-map-module.js`
already carries `readJSON`, `readRootSchema` and `resolveHandlerMap` — every
piece needed to turn a directory into a spec and a handler map. What is
missing is a path through them that stops before `buildDeviceClass`, since
constructing the device is what drags in the worker and the running
runtime.

This component extracts them into one function over a module directory,
returning structured results rather than log lines:

```js
validateModule('/path/to/my-module', (err, result) => { /* ... */ });

// result:
{
  ok: false,
  problems: [
    {
      stage:   'assembleHandlerMap',
      module:  'my-module',
      message: 'handler map declares service "greet", which is not in api.json. ...',
      fix:     'Top-level keys are service short names, not the full URN.'
    }
  ]
}
```

Messages stay byte-identical to today's; this adds structure around them, it
does not reword them.

**Known wrinkle:** validating the handler map requires `require`-ing the
author's handler files, which executes their top-level code. That is
acceptable for a local authoring flow over code the user is writing anyway,
and is one of the reasons this surface must not become remotely reachable.

### 2. `bin/countinghouse-validate.js <module-path>`

A thin CLI over the same function, for humans, for CI, and for agents that
can run a shell but have no server up. Exits non-zero when `ok` is false and
prints one problem per line.

### 3. Four platform MCP tools

Exposed via the existing `PLATFORM_TOOLS` mechanism in
`lib/mcp/tool-registry.js:29`, which already reserves platform names so no
device tool can collide with them.

| Tool | Input | Returns |
|---|---|---|
| `countinghouse_validate_plan` | A proposed `{device, services:[{name, actions:[{name, description, input, output}]}]}` | Problem list: illegal names, short-name/URN collisions, collisions with tools already on this runtime, malformed schemas |
| `countinghouse_validate_module` | `{path}` | The `validateModule` result above |
| `countinghouse_load_module` | `{path}` | `{loaded, deviceIDs, toolNames}` — **including the tool names now callable** |
| `countinghouse_call_tool` | `{name, arguments}` | The same result shape `tools/call` produces |

`validate_plan` runs before any file exists, so the user has a readable
design to approve and the agent gets a cheap early failure. It is the most
speculative of the four — an agent could instead write files and call
`validate_module` — and is the first thing to cut if the loop proves it
redundant in practice.

`load_module` returning `toolNames` and `call_tool` existing at all are both
answers to the refresh question below.

### 4. The skill: `.claude/skills/countinghouse-module/SKILL.md`

Ships in this repo, so pointing a coding agent at a clone is enough; nothing
to install separately. It carries:

- **The decomposition rubric** — one action is one schema-typed operation;
  services group related actions; when a chain should be a composite rather
  than one action.
- **The rule that matters most** — decide what a tool is *allowed to return*
  before writing what it does. The output schema is the guarantee (see
  [`../../index.md`](../../index.md)); a tool with a permissive output schema
  has nothing to offer.
- **The loop** — propose the split, show the user, `validate_plan`, write
  files, `validate_module` until clean, `load_module`, `call_tool`, report.
- **The five known failure modes**, carried over from
  [`../../module-development.md`](../../module-development.md)'s
  troubleshooting section.

## The `tools/list` refresh question

**The server is already correct.** `buildToolList` recomputes from live
device specs on every request (`lib/mcp/tool-registry.js:181`), with no
caching, so a module loaded through `/load-module` appears the next time any
client calls `tools/list`.

What is missing is the notification. `capabilities.tools` is `{}`
(`lib/mcp/gateway.js:74`) — no `listChanged` — and no
`notifications/tools/list_changed` is ever emitted. A client that cached its
tool list at session start therefore will not know to re-ask, and the agent
that just created a tool may not see it.

**Decision: do not add the notification. Make the loop not need it.**
`load_module` returns the tool names it just made callable, and `call_tool`
invokes them by name through a path the agent controls.

*Rejected alternative:* advertise `listChanged: true` and implement the
`GET /mcp` SSE stream for server-initiated messages. This is part of current
Streamable HTTP and is **not** the legacy HTTP+SSE transport this project
rules out — but it requires the server to track live client connections,
giving up the statelessness the transport was chosen for. Advertising the
capability without being able to deliver on it would be a false capability,
so this is all-or-nothing and the cost is not worth it for an authoring
convenience.

## Security boundary

All four tools are **admin-gated and off unless `--authoringTools` is
passed.** Admin-gating alone is insufficient: `load_module` plus `call_tool`
is an arbitrary-code-execution path with a friendly name, and it must not be
one flag-flip away on a deployment that merely happens to have an admin key
configured. Default-off means a production instance never exposes it by
accident.

This is a **local development flow** — an agent holding an admin key against
a runtime the user started themselves. It is explicitly not a multi-tenant
feature, which also means it is unblocked by the parked isolation work: the
threat model here is "the user's own agent writing the user's own code",
not untrusted third-party modules.

## Effect on the golden `tools/list` surface

**None, by construction.** `test/mcp-contract/capture-tools-list.js` spawns
the server with `--debug` and a fixed module list, and never passes
`--authoringTools`. Since the authoring tools are default-off, the captured
surface is byte-identical with or without this feature, and the golden sample
does not need regenerating.

This is worth an explicit test rather than a happy assumption: a case
asserting that none of the four tools appear in `tools/list` without the
flag, which doubles as the regression guard if someone later makes them
default-on.

## Testing

- **Validator unit tests.** Feed `validateModule` deliberately broken
  modules — service short name not in `api.json`, ambiguous short name,
  handler for an undeclared action, declared action with no handler,
  unresolvable schema pointer — and assert the full problem list, not just
  that it failed. One case per failure mode already named in
  `validateHandlerMap`.
- **CLI test.** Exit code and output format for one clean and one broken
  module.
- **Platform tool tests.** Each of the four: admin-gated, absent without
  `--authoringTools`, and correct on the happy path.
- **End-to-end.** Walk `validate_plan` → write files → `validate_module` →
  `load_module` → `call_tool`, asserting the tool that comes back is the one
  that was planned.
- **Golden update**, as its own commit.

## Files touched

| Path | Change |
|---|---|
| `lib/module-validator.js` | New — the extracted oracle |
| `lib/handler-map-module.js` | Expose a directory -> `{spec, handlerMap}` path that stops short of building the device class |
| `lib/mcp/tool-registry.js` | Four entries in `PLATFORM_TOOLS`/`PLATFORM_TOOL_NAMES` |
| `lib/mcp/gateway.js` | Dispatch for the four, admin + flag gating |
| `lib/cli-options.js` | `--authoringTools`, default off |
| `bin/countinghouse-validate.js` | New CLI |
| `.claude/skills/countinghouse-module/SKILL.md` | New skill |
| `test/mcp-contract/` | Golden regeneration |
| `test/module-authoring/` | New test directory per the plan above |
| `docs/module-development.md` | Link the skill and the validator |
| `README.md` | The authoring loop, in the status section |

## Open question, deferred deliberately

Whether `validate_plan` survives contact with real use. Ship it, watch
whether the agent actually calls it or goes straight to writing files, and
remove it if it is dead weight.
