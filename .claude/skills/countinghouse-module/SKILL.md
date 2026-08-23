---
name: countinghouse-module
description: Use when writing a new countinghouse module, or when a user asks for a tool to be hosted on a countinghouse runtime. Covers decomposing a requirement into services and actions, the module file layout, and the validate/load/call loop.
---

# Writing a countinghouse module

A countinghouse module is a directory the runtime loads and exposes as one or
more MCP tools. Your job is to turn a user's requirement into that directory,
with the user approving the design before code exists.

## Decide what it may return, before what it does

The output schema is the guarantee. A tool whose output schema is
`{type: 'object'}` promises nothing; a tool whose output schema has fields for
findings and counts and no field that can hold a file cannot leak a file, no
matter what its handler does or what a model asks it to do.

So the first question is not "what does this tool do" but **"what is this tool
allowed to return?"** Ask the user. If they say "summarize our logs", ask
whether the summary may quote raw log lines. Their answer is a schema
constraint, and encoding it is most of the value they came for.

## Decomposing a requirement

- **One action is one schema-typed operation.** If describing it needs the word
  "and", consider two actions.
- **A service groups related actions** on one device. Most modules need exactly
  one service; reach for a second only when the two groups would sensibly be
  used independently.
- **A chain belongs in a composite action**, not in the model. If the user's
  request is "read X, then check Y, then report" and the intermediate data is
  large or sensitive, that is one action calling others via `ctx.serviceClient`
  — not three tools the model has to join. See `docs/composite-tools.md`.
- **Name for a reader who has never seen it.** The action `description` is what
  an LLM reads to decide whether to call it, and an action with no description
  is skipped entirely when `tools/list` is built.

## Show the split before writing files

Present the proposed device, services, actions and — most importantly — what
each action may return. Wait for the user. This is where a wrong assumption is
cheap; after four files exist it is not.

Then call `countinghouse_validate_plan` to check names, duplicates, missing
descriptions and collisions with tools already on the runtime.

## The layout

```
my-module/
├── package.json   # name and version
├── api.json       # device, services, actions, schema pointers
├── schema.json    # JSON Schema 2020-12 documents
└── handlers/
    └── greetService/      # service SHORT name (after ":serviceID:")
        └── hello.js       # one file per action
```

A handler is `async (input, ctx)`; `input` is already validated.

```js
module.exports = async (input, ctx) => ({output: {text: `hello ${input.name}`}});
```

Full reference: `docs/module-development.md`.

## The loop

1. `countinghouse_validate_plan` — before any file exists.
2. Write `package.json`, `api.json`, `schema.json`, `handlers/`.
3. `countinghouse_validate_module` — repeat until `ok: true`. It returns
   *every* problem, each naming the stage and the fix; do not fix them one per
   run.
4. `countinghouse_load_module` — note the `toolNames` it returns.
5. `countinghouse_call_tool` with one of those names, and real arguments.
6. Show the user the call and its output.

Without a running server, `npx countinghouse-validate ./my-module` is the same
check from a shell (exit 0 clean, 1 problems, 2 unusable path).

The authoring tools need the runtime started with `--authoringTools` and an
admin key. If they are missing from `tools/list`, that is why.

## When it does not appear in tools/list

`docs/module-development.md` has the full checklist. The five that account for
almost everything:

1. `MODULE_NOT_DISCOVERABLE` — `package.json` `main` points at the wrong file.
2. `DEVICE_SPEC_VALIDATION_FAIL` — `api.json` fails the meta-schema; the error
   names the instance path.
3. `MODULE_NO_DEVICE_ONLINE` — a dynamic-discovery module that never emitted
   `deviceonline`.
4. `LOAD_MODULE_FAIL` — the module threw while loading.
5. Loaded but absent — an action with no `description` is skipped, and
   `tools/list` is filtered per apiKey.
