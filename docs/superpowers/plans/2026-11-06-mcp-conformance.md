# MCP Conformance and Key Exposure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every MCP tool result conform to its advertised output schema (the official SDK client accepts all of them). Make `countinghouse_check_balance` return `{userName, balance}`. Make the demo internal keys differ from their user names, and warn at startup when a key doubles as a user name.

**Architecture:** A thin layer in `lib/mcp/`. One shared, async resolver in `tool-registry.js` decides each module tool's advertised output schema, or none. `tools/list` and every success path in `gateway.js` (synchronous `tools/call`, `tasks/result`, and `countinghouse_call_tool` through the synchronous path) consume it. A new result builder unwraps the handler's `{output}`. Nothing below the adapter changes.

**Tech Stack:** Node ≥ 24.15, mocha, supertest, ajv 8 (2020-12), `@modelcontextprotocol/sdk` 1.32.2 (new devDependency, exact pin).

**Spec:** `docs/superpowers/specs/2026-11-06-mcp-conformance-design.md` (58f16a6).

## Global Constraints

- No change to any module `api.json` / `schema.json` in `examples/`, `pre-installed-packages/` or existing `test/fixtures/`, nor to the structure of any handler. New fixtures may be added.
- ctx.call and HTTP `invoke-action` keep `{output: …}`.
- Error results keep today's shape: `isError: true`, the text block, and `structuredContent: {code}` when there is a code.
- No raw API key in any tool output, log line or test output written by this work.
- Three commits on `fix/mcp-conformance`, one per task 1–3, each with its failing test first and the full `npm test` green before the commit (CLAUDE.md). Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01TQcu1dyQdj8GxTNsYkou9F`.
- The reviewer session checks each commit before the next task starts. Merge and push are the maintainer's call.

## Review Focus

1. A module tool with a declared object schema whose handler returns extra properties the schema forbids. The runtime already rejects these (`OUTPUT_DATA_VALIDATION_FAIL`), so the client must get an error result, never a nonconforming `structuredContent`. Pinned in Task 1, contract fixture `strict_out`.
2. A task whose stored result no longer matches the module's current schema (the module was reloaded with a different output). The result must go text-only, not ship a nonconforming `structuredContent`. Pinned in Task 1, reload test case 2.
3. A tool advertised without `outputSchema` whose handler returns an object. The client must get text JSON and no `structuredContent`, never a `structuredContent` the SDK would then require a schema for. Pinned in Task 1, contract fixture `no_schema_object`.
4. Per-call latency: the call path now resolves the schema once per call (one extra main↔worker round trip). Check that the `perf/log-triage-perf.js --matrix headline` composite latency moves by less than its run-to-run spread; report the before/after numbers in the Task 1 commit message.
5. Claude Code with a text-only result whose text is empty (a handler that returns no output). It must show the call as succeeded. Pinned by the manual Claude Code check in Task 4.

---

### Task 1: The MCP compatibility layer (commit 1)

**Files:**
- Modify: `lib/mcp/tool-registry.js` (around `resolveOneSchema` :331, `resolveSchemas` :344, `buildToolList` :387, `AUTHORING_TOOLS` call_tool entry, exports :413)
- Modify: `lib/mcp/gateway.js` (`toolCallResult` :149-171 stays the error builder; the success paths :659-660 and :860)
- Create: `test/fixtures/mcp-conformance-module/` (package.json, api.json, schema.json, handlers)
- Create: `test/fixtures/reload-output-schema/` (v1 files; the test writes v2 into a temp copy)
- Create: `test/mcp-contract/03-sdk-client-conformance.js`
- Create: `test/mcp-contract/04-output-shape-after-reload.js`
- Modify: `test/mcp-contract/tools-list.golden.json` (regenerated), `test/mcp-contract/02-approved-tool-changes.js`
- Modify: the 23 test files that read `.structuredContent.output`:
  - auth/12, 13, 24
  - composition/02, 04, 07, 08
  - device-config/02
  - direct-peer-channels/07
  - fs-broker/09, 12, 13, 14
  - module-loading/12, 14
  - sandbox/04, 05, 08, 09, 17, 20
  - single-thread/01, 02
- Modify: `examples/log-triage/verify-cost-bound.js`, `examples/repo-review/token-comparison.js`, `examples/repo-review/verify-identity-passthrough.js`, the repo-review README and recorded round-trip (annotate, don't re-record), `perf/log-triage-perf.js`, `perf/fs-broker-io-perf.js`
- Modify: `CHANGELOG.md` (Unreleased), `docs/upgrading-to-8.md`, `docs/composite-tools.md:130-160`
- Modify: `package.json`, `package-lock.json`

**Interfaces:**
- Produces, in `lib/mcp/tool-registry.js`:
  - `resolveOutputSchema(cdifInterface, appKey, target, callback(err, schemaOrNull))`. It returns the dereferenced schema when the action has an output pointer that resolves to a schema whose `type` is `'object'`, and `null` otherwise (no pointer; failed fetch, logged through the existing `logSchemaDowngrade`; non-object type). No cache, so it always reflects the loaded module.
  - `resolveOutputSchemaFor(cdifInterface, appKey, deviceID, serviceID, actionName, callback(err, schemaOrNull))`. It finds the target via `buildToolTargets` and returns `null` when none matches (unloaded module or removed action).
  - `buildToolList` omits the `outputSchema` key when `resolveOutputSchema` gives `null`; `inputSchema` keeps `DEFAULT_SCHEMA`.
  - The `countinghouse_call_tool` entry in `AUTHORING_TOOLS` has no `outputSchema`.
  - All of the above are exported.
- Produces, in `lib/mcp/gateway.js`: `moduleToolResult(data, outputSchema) -> {isError: false, content, structuredContent?}`:
  - with `outputSchema` non-null: `structuredContent = data.output` and `content = [{type: 'text', text: JSON.stringify(data.output)}]`;
  - otherwise no `structuredContent`, and `content` is `[{type: 'text', text}]` with `text` = `data.output` when it is a string, `''` when it is `undefined`/`null`, else `JSON.stringify(data.output)`.

- [ ] **Step 1: Add the SDK devDependency**

Run: `npm install --save-dev --save-exact @modelcontextprotocol/sdk@1.32.2`
Expected: `package.json` devDependencies gains `"@modelcontextprotocol/sdk": "1.32.2"`; `node -e "import('@modelcontextprotocol/sdk/client/index.js').then(()=>console.log('ok'))"` prints `ok`.

- [ ] **Step 2: Create the contract fixture module `test/fixtures/mcp-conformance-module`**

Device friendlyName `mcp-conformance`, one service `shapeService`. Each action has a description and is listed in `ARGS` (Step 3):

| action | output schema | handler returns |
|---|---|---|
| `object_out` | object `{text: string}`, required, `additionalProperties: false` | `{output: {text: 'ok'}}` |
| `no_schema_string` | none | `{output: 'plain text'}` |
| `no_schema_object` | none | `{output: {a: 1}}` |
| `no_schema_empty` | none | `{}` |
| `prefix_items_out` | object `{pair: {type: 'array', prefixItems: [{type: 'string'}, {type: 'integer'}]}}` | `{output: {pair: ['a', 1]}}` |
| `coded_error` | object `{text: string}` | throws `new DeviceError('DEVICE_INVOKE_FAIL', 'boom')` |
| `strict_out` | object `{text: string}`, `additionalProperties: false` | `{output: {text: 'x', extra: 1}}` |

- [ ] **Step 3: Write the failing contract test `test/mcp-contract/03-sdk-client-conformance.js`**

Server: `framework.js --workerThread --debug --bindAddr 127.0.0.1 --port <free port>`, plus `--loadModule` for every directory in `pre-installed-packages/`, the four `examples/log-triage/*` modules, the `examples/repo-review/*` modules and the new fixture, with `--moduleDataPath <tmp>`, after `node examples/log-triage/generate-logs.js --dir <tmp>/log-read/data/sample-logs --files 2 --lines 20` so log-read's tools have data. Wait with `test/helpers/wait-for-ready`. Client: the SDK's `Client` with `StreamableHTTPClientTransport` (header `X-CH-Key: k`), loaded with dynamic `import()`.

- `ARGS` is a table `toolName -> {args, expect: 'ok' | 'error'}` covering every tool `tools/list` returns. Expected errors include the echo `errorinfotestservice` tools, `coded_error` and `strict_out`; the timeout tools get `expect: 'error'` with the shortest timeout they accept.
- `it('every listed tool has an ARGS entry')`: `assert.deepStrictEqual(listed.filter(n => !(n in ARGS)), [])`.
- `it('ARGS has no stale entries')`: `assert.deepStrictEqual(Object.keys(ARGS).filter(n => !listed.includes(n)), [])`.
- The server runs without `--authoringTools` on purpose, so no load/validate tools are listed or called. Say so in a comment above `ARGS`.
- For each listed tool, `it('<tool> conforms')`:
  - `const r = await client.callTool({name, arguments: ARGS[name].args})` must not throw;
  - for `'ok'`: `r.isError` is falsy; if the tool lists an `outputSchema`, `r.structuredContent` is defined and ajv-2020 `validate(outputSchema, r.structuredContent)` is `true` (error text names the field); else `r.structuredContent === undefined` and `r.content[0].type === 'text'`;
  - for `'error'`: `r.isError === true`.
- Exact values:
  - `no_schema_string` → `r.content[0].text === 'plain text'`;
  - `no_schema_object` → `JSON.parse(r.content[0].text)` deep-equals `{a: 1}`;
  - `no_schema_empty` → `r.content` deep-equals `[{type: 'text', text: ''}]`;
  - `object_out` → `r.structuredContent` deep-equals `{text: 'ok'}` and `JSON.parse(r.content[0].text)` deep-equals the same;
  - `coded_error` → `r.structuredContent` deep-equals `{code: 'DEVICE_INVOKE_FAIL'}` and the SDK did not throw.
- `prefix_items_out`: assert that the SDK accepts it. If, after Step 6, the SDK still throws (compile or validation), change this one assertion to `assert.rejects(...)` with a comment naming the limitation, and add the limitation to the spec's dialect section and `docs/upgrading-to-8.md` in this commit.
- `describe('tasks/result')`, over raw JSON-RPC with supertest (the SDK has no task API to rely on), for `mcp_conformance_shapeservice_object_out` and `..._no_schema_string`:
  - create with `params.task: {}`, poll `tasks/get` until `completed`, read `tasks/result`;
  - parse it with the SDK's exported `CallToolResultSchema`;
  - assert the same shape rules as above.

Run: `node_modules/.bin/mocha --exit test/mcp-contract/03-sdk-client-conformance.js`
Expected: FAIL. Every module tool with a schema is rejected with `-32602 Structured content does not match the tool's output schema`, and the no-schema tools fail the "no structuredContent" assertion.

- [ ] **Step 4: Write the failing reload test `test/mcp-contract/04-output-shape-after-reload.js`**

Fixture `test/fixtures/reload-output-schema`: device `reload-output-schema`, action `greetService.hello`.
- v1: output `{text: string}`, handler `{output: {text: 'v1'}}`.
- The test copies the fixture to a temp dir.
- Server: `--workerThread --debug --authoringTools`. Load via `countinghouse_load_module` (the same pattern as `test/module-loading/12-reload-fresh-code.js:67`).
- v2: written by the test into the temp copy. Output `{upper: string}`, required, `additionalProperties: false`; handler `{output: {upper: 'V2'}}`. Then reload through `countinghouse_load_module` again and poll until the tool is back.
- `it('tools/list and tools/call follow the reloaded schema')`: after the v2 reload, the listed `outputSchema.properties` has `upper` and not `text`; `tools/call` gives `structuredContent` deep-equal to `{upper: 'V2'}`.
- `it('a task finished before the reload reads back text-only when its result no longer conforms')`:
  - on v1, create a task and wait for `completed`;
  - assert that `tasks/get` / the job record still carries `deviceID`, `serviceID` and `actionName`. The job data is read main-side (`addJob`, gateway.js:750; R3-1 strips only the worker's copy). This assertion makes a later change to job data fail loudly here, instead of silently going text-only;
  - reload to v2, then read `tasks/result`;
  - assert `structuredContent === undefined` and `JSON.parse(content[0].text)` deep-equals `{text: 'v1'}`.

Run: `node_modules/.bin/mocha --exit test/mcp-contract/04-output-shape-after-reload.js`
Expected: FAIL. `structuredContent` is `{output: {...}}`.

- [ ] **Step 5: Implement the resolver in `lib/mcp/tool-registry.js`**

- `resolveOutputSchema` and `resolveOutputSchemaFor`, with the signatures above.
- `resolveSchemas` uses `resolveOutputSchema` for the output side.
- `buildToolList` drops `outputSchema` when it is `null`.
- Remove `outputSchema` from the call_tool entry.
- Update the header comments that describe `DEFAULT_SCHEMA` as the output fallback.

- [ ] **Step 6: Use it on every success path in `lib/mcp/gateway.js`**

- **`moduleToolResult`**: implement it as specified above.
- **Synchronous `tools/call`**: in the `userAuth` callback at :659, on success call `toolRegistry.resolveOutputSchema(cdifInterface, appKey, target, …)`, then respond with `moduleToolResult(data, schema)`. Metering stays where it is and is unaffected by the resolution. A resolution error responds with `moduleToolResult(data, null)`, so a schema fetch problem never fails a call that succeeded.
- **`tasks/result`** (:860): call `resolveOutputSchemaFor(cdifInterface, authCtx.appKey, record.job.data.deviceID, record.job.data.serviceID, record.job.data.actionName, …)`. If the schema is non-null but the stored `returnvalue.output` fails validation against it, use `null`. Validate with the runtime's own instance, `require('../validator').getSchemaValidator().compile(schema)`: the same ajv 2020 class, formats and strictness that `validateActionCall` uses (`lib/service.js:51`), so "conforms" means the same in both places. Say so in a comment at the call site. The decision, not in the spec, is noted for the reviewer: "advertise only what results conform to" covers results stored before a reload. Then respond with `moduleToolResult(record.job.returnvalue, schema)`.
- **Unchanged**: the failed-task branch, `toolCallResult(err)` and the platform/authoring success paths, which already return bare results.

Run: `node_modules/.bin/mocha --exit test/mcp-contract/03-sdk-client-conformance.js test/mcp-contract/04-output-shape-after-reload.js`
Expected: PASS, apart from `prefix_items_out` if the SDK limitation applies (see Step 3).

- [ ] **Step 7: Regenerate the golden file and pin the delta**

Run: `node test/mcp-contract/capture-tools-list.js`, then `git diff --stat test/mcp-contract/tools-list.golden.json`.
Expected: the diff is exactly the removal of `"outputSchema": {"type": "object", "properties": {}}` from the 17 tools listed in the spec, and nothing else (check with `git diff` before going on).

In `02-approved-tool-changes.js`:
- add `APPROVED_SCHEMA_CHANGES = {<toolName>: {reason: 'module declares no output schema; MCP: no outputSchema, text-only result', outputSchema: undefined}, …}` for the 17;
- make the third test assert that each surviving tool's `outputSchema` equals PRE's, except the table entries, which must equal the table's value (`undefined` means the key is absent);
- assert that the table names only tools whose schema actually changed.

Run: `node_modules/.bin/mocha test/mcp-contract/01-tools-list-unchanged.js test/mcp-contract/02-approved-tool-changes.js`
Expected: PASS.

- [ ] **Step 8: Move existing readers off `.structuredContent.output`**

Rule, per call site:
- the tool has a declared object output schema → read `res.structuredContent`;
- otherwise → `JSON.parse(res.content[0].text)` (or the string itself).

Apply it to the 23 test files, the 3 example scripts and the 2 perf scripts listed under Files. In the repo-review README and recorded round-trip, put a note above the captured transcript: "captured before 8.0.0's MCP result change: `structuredContent` no longer has the `output` wrapper". Leave the capture itself as it was.

Run: `grep -rn "structuredContent\.output\|structuredContent != null ? .*\.output" test examples perf --include=*.js | grep -v perf/results`
Expected: no output.

- [ ] **Step 9: Docs**

- `CHANGELOG.md` Unreleased, under a "Breaking (MCP clients)" heading:
  - results drop the `{output}` wrapper in both `structuredContent` and the text block;
  - tools whose module declares no output schema no longer advertise one, and return text only;
  - `countinghouse_call_tool` no longer advertises an output schema.
- `docs/upgrading-to-8.md`: a section for MCP clients. Read `structuredContent` rather than `structuredContent.output`; expect no `outputSchema` (and text-only results) for tools without a declared schema; and, if Step 3 found it, the SDK dialect limitation.
- `docs/composite-tools.md:130-160`: the example response without the wrapper, and the paragraph explaining it.

- [ ] **Step 10: Full suite, then commit**

Run: `npm test`
Expected: all groups pass, 0 failing.

Latency check (Review Focus 4), following the perf hygiene rules:
- unattended, behind a `vmstat` idle gate, silent while it runs;
- at least 3 runs of `node perf/log-triage-perf.js --matrix headline` on `622438f` (a worktree) and 3 on this tree;
- report the medians and spread in the commit message.

If the extra round trip shows beyond the spread, cache the resolved schema per module lifetime, invalidated on load, reload, restart and unload (within the spec). Then extend `04-output-shape-after-reload.js` with a case proving the cache is dropped on reload, and re-measure.

Commit with explicit paths, never `-A`. Check `git status --short` first, and confirm that nothing untracked is swept in (scratch, `perf/results`, the plan file):

```bash
git add lib/mcp/gateway.js lib/mcp/tool-registry.js test/mcp-contract/03-sdk-client-conformance.js \
  test/mcp-contract/04-output-shape-after-reload.js test/mcp-contract/tools-list.golden.json \
  test/mcp-contract/02-approved-tool-changes.js test/fixtures/mcp-conformance-module test/fixtures/reload-output-schema \
  <the 23 test files> <the example, README and perf files edited in Step 8> \
  CHANGELOG.md docs/upgrading-to-8.md docs/composite-tools.md package.json package-lock.json
git status --short
git commit   # "feat(mcp): tool results conform to their advertised output schemas"
```

The same rule (explicit paths, `git status --short` before committing) applies to Tasks 2 and 3. This plan file goes in its own `docs(plan)` commit before Task 1 starts.

---

### Task 2: check_balance returns {userName, balance} (commit 2)

**Files:**
- Modify: `lib/mcp/gateway.js` (`resolveCallerIdentity` :66-71; the check_balance branch :607-626)
- Modify: `lib/mcp/tool-registry.js:36-42` (`PLATFORM_TOOLS`)
- Create: `test/auth/27-check-balance-no-key.js`
- Modify: `test/auth/10-balance-auth.js` (and any other test asserting `apiKey` in the check_balance result; grep `countinghouse_check_balance` in `test/`)
- Modify: `test/mcp-contract/tools-list.golden.json` (regenerated), `test/mcp-contract/02-approved-tool-changes.js`
- Modify: `CHANGELOG.md`, `docs/upgrading-to-8.md`

**Interfaces:**
- Consumes: Task 1's `APPROVED_SCHEMA_CHANGES`.
- Produces: `resolveCallerIdentity` callback gives `{appKey, isAdmin, userName}`, where `userName` is `session.username`. The check_balance result is `{userName: (userName === appKey ? null : userName) ?? null, balance}`.

- [ ] **Step 1: Write the failing test `test/auth/27-check-balance-no-key.js`**

Four servers, each `--no-workerThread` with `--authProvider file` and a temp auth file:
- `it('returns exactly userName and balance, and never the key')`: entry `{"k-alice-1": {userName: "alice", devices: []}}` gives `structuredContent` deep-equal to `{userName: 'alice', balance: <number|null>}`, and the raw response body does not contain `k-alice-1`.
- `it('returns userName null when the entry has no userName')`: entry `{"k-anon-2": {devices: []}}` gives `structuredContent.userName === null`, and the body does not contain `k-anon-2`.
- `it('returns debug under keyless --debug')` and `it('returns debug under --debugKey')`: `structuredContent.userName === 'debug'`.
- `it('conforms to its advertised schema')`: ajv validation of `structuredContent` against the listed `outputSchema` is `true`.

Run: `node_modules/.bin/mocha --exit test/auth/27-check-balance-no-key.js`
Expected: FAIL (the result has `apiKey`).

- [ ] **Step 2: Implement**

New `PLATFORM_TOOLS` output schema:

```js
{type: 'object', properties: {userName: {type: ['string', 'null']}, balance: {type: ['number', 'null']}},
 required: ['userName', 'balance'], additionalProperties: false}
```

The check_balance branch builds `{userName, balance: result.balance}` from `authCtx` and the metering result, and never spreads the metering result.

- [ ] **Step 3: Regenerate the golden file and add the table entry**

Run `node test/mcp-contract/capture-tools-list.js`. Expected: the diff touches only `countinghouse_check_balance`'s `outputSchema`. Add its `APPROVED_SCHEMA_CHANGES` entry (reason: `no raw API key in tool output; spec 2026-11-06`, value: the schema above). Fix `test/auth/10-balance-auth.js` where it asserts `apiKey`. Add CHANGELOG and upgrading lines: check_balance returns `{userName, balance}`.

- [ ] **Step 4: Full suite, then commit**

Run: `npm test`, expect 0 failing. Commit: `"fix(mcp): check_balance returns userName and balance, never the key"`.

---

### Task 3: Demo internal keys and the startup warning (commit 3)

**Files:**
- Modify: `examples/log-triage/auth.json`, `examples/repo-review/auth.json`
- Modify: every place that presents `log-triage-internal` / `repo-review-internal` as an `X-CH-Key` (grep both strings in `examples/`, `test/`, `docs/`, `perf/`; README sections, the `verify-*` scripts, tests), keeping them where they mean the user name, `AUTHORIZED_AS_LABEL` and `runsModules`
- Modify: `lib/auth/file-provider.js` (`_load` :59-82)
- Create: `test/auth/28-key-as-username-warning.js`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `FileAuthProvider.prototype._warnKeysAsNames(config)`, called at the end of `_load` after a successful parse, which logs through `LOG.W`.

- [ ] **Step 1: Write the failing test `test/auth/28-key-as-username-warning.js`**

Build a `FileAuthProvider` (`require('../../lib/auth/file-provider')`) on a temp config, with `LOG.W` stubbed to collect messages (restore it in `afterEach`):
- `it('warns once for a key equal to its userName, naming the userName and not the key')`: config `{"same-1": {userName: "same-1", devices: []}, "k-ok": {userName: "ok", devices: []}}` gives exactly 1 message containing `same-1` as the user name, `user name`, and the words `shown to callers`. Because key and userName are the same string here, the assertion that the key is not printed uses the second entry: no message contains `k-ok`.
- `it('warns for an entry without userName by position, without printing the key')`: config `{"k-secret-9": {devices: []}}` gives 1 message containing `entry #1`, and no message contains `k-secret-9`.
- `it('stays quiet for a clean config')`: `{"k1": {userName: "a"}}` gives 0 messages.

Run: `node_modules/.bin/mocha test/auth/28-key-as-username-warning.js`
Expected: FAIL (no warnings).

- [ ] **Step 2: Implement `_warnKeysAsNames`**

Message texts:
- for `userName === key`: `FileAuthProvider: the entry for user "<userName>" in <configPath> uses its API key as its user name. User names are shown to callers (bills, check_balance), so give it a userName different from its key.`
- for a missing `userName`: `FileAuthProvider: entry #<n> in <configPath> has no userName, so its API key would be used as its user name. User names are shown to callers (bills, check_balance); add a userName.`

`<n>` is the 1-based position in `Object.keys(config)`. Startup continues either way.

- [ ] **Step 3: Change the demo keys**

- `examples/log-triage/auth.json`: key `log-triage-internal` → `log-triage-internal-demo-key-not-secret`; `userName` stays `log-triage-internal`.
- `examples/repo-review/auth.json`: likewise, `repo-review-internal-demo-key-not-secret`.
- Update every use of the old strings as a key (the grep in Files). The README paragraphs on `log-triage-internal` (log-triage README:78-82) name the new key and say the user name is not the key.

Run: `node examples/log-triage/verify-cost-bound.js` and `node examples/repo-review/verify-identity-passthrough.js`
Expected: the first prints its `RESULT:` line. The second's known pre-existing "Device is not responding" failure (since f70e1c0) is unrelated; report it and don't fix it here.

Then start the log-triage demo once and check that the server log has no `FileAuthProvider:` warning.

- [ ] **Step 4: Full suite, then commit**

Run: `npm test`, expect 0 failing. Commit: `"fix(examples): internal demo keys differ from their user names; warn when a key doubles as one"`. Add a CHANGELOG line for each change.

---

### Task 4: Gate and the Claude Code check (no commit unless something is fixed)

- [ ] **Step 1: Full suite on the three Node versions**

Run `.superpowers/run-all-groups.sh <repo>` under Node 24.15.0, 24.22.2 and 24.21.0 (nvm). Expected: every group `exit=0` on each.

- [ ] **Step 2: Manual Claude Code check**

Tell the maintainer the cost (about $0.03) first. Start log-triage with `--loadModule test/fixtures/mcp-conformance-module` added, write an MCP config for it, then:

```
claude -p "Call log_triage_triageservice_triage with dir /data/sample-logs and maxFiles 2, then call mcp_conformance_shapeservice_no_schema_empty, and report both results." --model sonnet --strict-mcp-config --mcp-config <cfg> --output-format stream-json --verbose
```

Expected:
- the triage result is read from text without the `output` wrapper;
- the empty-output call is reported as succeeded, with no error;
- no `isError`.

Record the result in the hand-off to the reviewer.

- [ ] **Step 3: Hand to the reviewer**

The 3-version results and the Claude Code result go to the reviewer for the security pass. Merging is the maintainer's decision.
