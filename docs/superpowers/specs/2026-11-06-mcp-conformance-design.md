# MCP conformance and key exposure: design

Date: 2026-11-06. Base: `master` at `622438f`. Branch: `fix/mcp-conformance`.
Status: draft, for the reviewer and then the maintainer.

## Why

The token-cost measurement of 2026-11-05 (branch `perf/token-cost`) turned
up three problems. The maintainer decided on 2026-11-06 to fix all three:

1. **Module tool results do not conform to MCP.** A module handler returns
   `{output: <result>}`. The MCP adapter passes that whole object through as
   `structuredContent`, and as the JSON in `content[0].text`. Meanwhile
   `tools/list` advertises the schema of `<result>` alone, so every module
   tool's `structuredContent` sits one level above its `outputSchema`.
   - ajv reports `false` for all five log-triage tools; `structuredContent.output`
     reports `true`.
   - The official MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.2)
     rejects every one of them in `Client.callTool` with
     `-32602 Structured content does not match the tool's output schema`.
   - Claude Code, the only client the maintainer's users run today, does not
     validate the result, which is why nothing visibly broke.
2. **`countinghouse_check_balance` returns the caller's raw API key** in its
   result, so the key ends up in model context, transcripts and logs.
3. **Both composite examples hand every caller a working key.** In
   `examples/log-triage/auth.json` and `examples/repo-review/auth.json` the
   internal identity's API key is the same string as its `userName`
   (`log-triage-internal`, `repo-review-internal`). The composites print that
   name in every bill row as `authorizedAs`. Per log-triage's README, that
   key reads unmasked log lines directly, which bypasses the redaction the
   composite exists for. An operator who copies the pattern with a real
   secret leaks it to every caller.

Two kinds of success, both decided by the maintainer:

- A script using the official SDK client calls every tool, and every result
  passes the SDK's own output-schema check.
- Claude Code keeps working.

## Goals

- `tools/call`, `tasks/result` and `countinghouse_call_tool` return results
  that the official SDK client accepts for every bundled and example module.
- `tools/list` advertises only output schemas that results will actually
  conform to.
- No tool output contains a raw API key: not check_balance, not the example
  bills.
- An operator who configures a key equal to its own user name is warned at
  startup.

## Non-goals

- Changing module specs (`api.json`, `schema.json`) or the structure of any
  handler. This is the maintainer's constraint: the compatibility layer sits
  on top of the current implementation.
- Changing ctx.call or HTTP `invoke-action`. Both keep the module convention
  `{output: …}`; they are not MCP.
- Protocol-version negotiation. `initialize` echoes whatever version the
  client asks for, and serving older MCP eras properly is a separate, known
  item. This design only requires that the official SDK client, at its
  current version, gets through `initialize`, which it does today. (My call.)
- R2-1 (modules receiving raw keys in `ctx.caller`) has its own spec and is
  not touched here.
- HTTP `GET /balance` is not MCP and keeps its response. (My call; R2-1 can
  revisit it.)

## Anti-goals

- A layer that invents result shapes a module never declared, for example
  wrapping a string result as `{value: …}` to fit an advertised schema.
- Any change that breaks Claude Code's use of these tools.
- Silently changing the MCP contract without updating the golden snapshot,
  CHANGELOG and upgrade notes.

## The decided design

### 1. The MCP compatibility layer

All changes are in `lib/mcp/` (the gateway and tool registry). Nothing below
the adapter changes.

**tools/call results (success).** For a module tool, the adapter takes the
handler's return value `data`, which the runtime has already validated
(`lib/service.js:239-245`), and:

- if the action declares an output schema of type `object`:
  `structuredContent = data.output`, and `content = [{type: 'text', text: JSON.stringify(data.output)}]`;
- if the action declares no output schema, or one whose type is not
  `object`, or one whose pointer fails to resolve: no `structuredContent`,
  and `content` is the text form of `data.output`. A string is sent as-is;
  anything else is JSON. When `data.output` is `undefined` or `null`, content
  is a single empty text block, `[{type: 'text', text: ''}]`, rather than an
  empty array, because an empty array is untested with Claude Code. The
  manual Claude Code check calls one such tool. (The text rules are my
  call.)

The same rule applies on all three success paths:

- the synchronous `tools/call` (`lib/mcp/gateway.js:659-660`, `toolCallResult(err, data)`);
- `tasks/result` (`lib/mcp/gateway.js:860`, `record.job.returnvalue`);
- `countinghouse_call_tool`, which re-enters the synchronous path and so
  needs no separate change. Its own advertised `outputSchema` (currently
  `{type: 'object'}`) is dropped, because its result is whatever the inner
  tool returns (text-only for tools without a schema). (My call.)

Platform tools (`countinghouse_*`) already return bare results. They go
through the same success path unchanged, and the contract test (below)
checks that each conforms to its advertised schema.

**Error results** keep today's shape: `isError: true`, the message in the
text block, and `structuredContent: {code}` when there is a code. (My call;
MCP does not validate error results against `outputSchema`.)

**tools/list.** For a module tool, `outputSchema` is advertised only when the
action declares an output schema pointer that resolves to a schema of type
`object`. Otherwise the tool is listed without `outputSchema`, instead of
with today's default `{type: 'object', properties: {}}` (`DEFAULT_SCHEMA`,
`lib/mcp/tool-registry.js:290`). `inputSchema` keeps the default when none is
declared, because MCP requires an `inputSchema`. The maintainer decided this
and approved regenerating the golden file: 17 of the 22 tools in
`test/mcp-contract/tools-list.golden.json` lose their `outputSchema`.

**One lookup for every path.** Inside `lib/`, only `tool-registry.js`'s
`resolveSchemas` / `schemaPathFor` compute `outputSchema`. It is async and
takes `appKey`, because it loads `schema.json` through `cdifInterface`. Four
paths consume it:

- `tools/list`;
- the synchronous `tools/call`;
- `tasks/result`;
- `countinghouse_call_tool`, through the synchronous path.

The call paths must use the same function, with the same caller identity,
not a parallel synchronous copy, so `tools/list` and `tools/call` can never
disagree about a tool. The lookup must not cache across a module reload or
restart: right after a reload, `tools/call` uses the module's current schema.
Whether to cache within one module lifetime is left to the builder.

**tasks/result specifically.** It has no tool context today, only
`record.job.returnvalue`. The job, however, was created with
`target.deviceID`, `serviceID` and `actionName` (`JobControl.addJob`,
`lib/mcp/gateway.js:750`). So:

- the shape is resolved at result time, from those three, through the same
  lookup;
- if they no longer resolve, because the module was unloaded or the action
  removed, the result is text-only;
- a task created before a reload of its module gets the shape of the module
  as it is when the result is read;
- the failed-task path keeps the error shape.

### 2. check_balance

`countinghouse_check_balance` returns `{userName, balance}`. The output schema
becomes
`{type: 'object', properties: {userName: {type: ['string', 'null']}, balance: {type: ['number', 'null']}}, required: ['userName', 'balance'], additionalProperties: false}`,
which is my wording of the maintainer's decision.

`userName` comes from the resolved session, not from the metering provider.
One case needs care. The file auth provider defaults a missing `userName` to
the API key itself (`lib/auth/file-provider.js:125`). So a `userName` equal to
the caller's own key is returned as `null`, never echoed back. (My call;
otherwise the fix could be undone by configuration.) The golden file changes
for this tool's entry too.

### 3. Internal identity keys and the startup warning

- In both `examples/log-triage/auth.json` and `examples/repo-review/auth.json`,
  the internal identity's key changes to a string different from its
  `userName`, for example `log-triage-internal-demo-key-not-secret`; the
  builder picks the exact string. `userName` stays `log-triage-internal` /
  `repo-review-internal`, so the handlers' `AUTHORIZED_AS_LABEL`,
  `runsModules` and the bill stay as they are.
- Everything that presents the old string as a key follows the new one:
  README text, `verify-*` scripts, tests and recorded examples. A recorded
  transcript stays as captured, with a note, as was done before for
  repo-review.
- **Startup warning, file auth provider** (maintainer's decision). When the
  file provider loads a config, it logs one warning per entry whose key
  equals its own `userName`. The same warning covers an entry with no
  `userName`, because the provider then uses the key as the user name, and
  user names are shown in bills and in check_balance. The warning names the
  entry by its `userName` or by position, never by printing the key. It
  explains that user names are shown to callers, so a key must never double
  as one. It is a warning only: startup continues. The sqlite provider has no
  equivalent default, so it is out of scope. (Scope to the file provider and
  the no-`userName` case are my calls.)

## Size, and the breaking change

Size, stated so the decision is made with it in view:

- **Library code:** 3 files (`lib/mcp/gateway.js`, `lib/mcp/tool-registry.js`,
  `lib/auth/file-provider.js`).
- **Tests:** about 30 files, mostly mechanical: 23 existing tests change how
  they read results; the golden file and `02-approved-tool-changes.js`
  change; 3–4 test files are new (the contract test with its fixtures,
  check_balance, the warning, the reload cases).
- **Examples:** about 8 files: 2 `auth.json`, 2 READMEs, the 3 `verify-*` /
  `token-comparison` scripts, and the recorded round-trip note.
- **Perf scripts:** 2 (`perf/log-triage-perf.js`, `perf/fs-broker-io-perf.js`).
- **Docs:** 3 (`CHANGELOG.md`, `docs/upgrading-to-8.md`, `docs/composite-tools.md`).
- **Packaging:** `package.json` and `package-lock.json`, for the SDK
  devDependency.

In all, about 50 files, of which 3 are library code.

### What breaks, and where it is written down

These changes alter what MCP clients see:

- `structuredContent.output` becomes `structuredContent`;
- the text block loses its `{"output": …}` wrapper;
- 17 tools lose `outputSchema`;
- check_balance loses `apiKey` and gains `userName`.

8.0.0 is unreleased, so it is recorded in:

- `CHANGELOG.md` under "Unreleased", as a breaking change for MCP clients;
- `docs/upgrading-to-8.md`, as an entry telling MCP clients that read
  `.output` what to do;
- `docs/composite-tools.md:130-160`, whose example response and explanation
  are updated.

## Tests: what proves it

Each of the three fixes gets a failing test first, in the same commit as its
fix (the project's working style).

- **SDK contract test**, new under `test/mcp-contract/`:
  - starts a server with the bundled modules and both composite examples;
  - connects with the official SDK client (`@modelcontextprotocol/sdk`, added
    as an exact-pinned devDependency, 1.32.2 unless a newer release is chosen
    at implementation time);
  - calls `tools/list`, then `tools/call` on every listed tool with
    schema-valid arguments, and requires every success to be accepted by
    `Client.callTool`;
  - checks every `structuredContent` against the advertised `outputSchema`
    with ajv as well, so a failure names the field;
  - covers `tasks/result` for at least one tool with an output schema and one
    without;
  - must fail on `622438f`. That failure was already observed during the
    investigation, for all five log-triage tools.

  How the test chooses valid arguments per tool (fixtures per tool, or a
  table) is left to the builder.
- **tools/list golden** is regenerated with
  `node test/mcp-contract/capture-tools-list.js`. The diff must be exactly the
  17 dropped default output schemas plus the check_balance schema change.
- **`test/mcp-contract/02-approved-tool-changes.js`.** Its third test
  deep-equals every surviving tool's `outputSchema` against the 4.x snapshot,
  so it would fail on 18 tools. `tools-list.pre-5.0.0.json` is history and is
  NOT recaptured. Instead the test gets an `APPROVED_SCHEMA_CHANGES` table,
  keyed by tool name, each entry with its reason and exact new value: absent
  for the 17, the new schema for check_balance. The test asserts the delta is
  exactly that table, the same discipline as its existing
  `APPROVED_REMOVALS`.
- **Reload.** A module whose output schema changes is reloaded and then
  called: the result follows the new schema on both `tools/list` and
  `tools/call`. A second case does the same for a task created before the
  reload and read after it.
- **Errors on a tool with an outputSchema.** A contract-test case shows the
  SDK accepts an `isError: true` result that carries
  `structuredContent: {code}`.
- **Schema dialect.** countinghouse validates outputs with ajv 8 in JSON
  Schema 2020-12 mode. SDK 1.32.2 uses `require("ajv")` (ajv 8.20.0), whose
  default class is draft-07 in strict mode. A 2020-12-only keyword
  (`prefixItems`, `$defs`, `unevaluated*`) may therefore fail to compile in
  the SDK, or be rejected there, even after this fix. The contract test
  includes one fixture tool whose output schema uses `prefixItems` and
  records the outcome. If the SDK can't handle it, that is documented here
  and in `docs/upgrading-to-8.md` as a known client limitation; this fix does
  not widen to rewrite schemas. The leaf schemas advertised today carry no
  `$schema` keyword, so the meta-schema itself is not an issue. The SDK's ajv
  is also strict, so any unknown keyword in an advertised schema makes
  compilation throw. The contract test covers that for the bundled modules
  and examples; third-party module schemas with non-standard keywords will
  hit the same limitation, and the note says so.
- **check_balance**: a test that the result has exactly
  `{userName, balance}`, never contains the caller's key, and returns
  `userName: null` when the configured user name equals the key. Under
  `--debug`, keyless or with `--debugKey`, the session's user name is
  `'debug'` (`lib/user-auth.js:26`, `:37`), and the test covers both.
- **Startup warning**: a test that loading a config with a key equal to its
  `userName`, and one with no `userName`, each logs the warning and does not
  print the key.
- **Existing tests and scripts that read `.structuredContent.output`** (23
  test files, plus `test/composition/10` through
  `examples/log-triage/verify-cost-bound.js`, `examples/repo-review/token-comparison.js`,
  `examples/repo-review/verify-identity-passthrough.js`, `perf/log-triage-perf.js`
  and `perf/fs-broker-io-perf.js`) switch to reading `structuredContent`
  directly.
- **Claude Code check**, manual and not part of `npm test`: one
  `claude -p --model sonnet` run of the log-triage composite against a local
  server, recorded in the PR or commit description. Cost is about $0.03, and
  the maintainer is told before it runs.

## Order of work

One branch (`fix/mcp-conformance`, from master), three commits, one per fix:

1. the compatibility layer, with its SDK contract test, the golden
   regeneration, the existing tests updated, and the docs;
2. check_balance;
3. the example keys and the startup warning.

Every commit passes the full `npm test` first. Before the branch merges, the
full suite runs on Node 24.15.0, 24.22.2 and 24.21.0. The reviewer session
checks the plan and every commit. Merging and pushing are the maintainer's
call.

## Left to the builder

- Where in `lib/mcp/` the "declared output schema" lookup lives, as long as
  `tools/list` and `tools/call` share it.
- The exact example key strings, and the warning's wording within the rules
  above.
- How the contract test generates valid arguments.
- Whether the SDK version in the test is 1.32.2 or a newer release at
  implementation time. Pin it exactly either way.

## Related, not in scope

- `perf/token-cost` (unmerged) generates code-mode wrappers that unwrap
  `structuredContent.output` and throw when it is absent. If that branch is
  ever merged after this fix, the unwrap rule goes: the wrapper returns
  `structuredContent`.
- The repo-review README and recorded round-trip show the old shape. They are
  updated or annotated as part of fix 1.
