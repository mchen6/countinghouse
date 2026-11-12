# LM1, part C: stdio, scenario loading, usage records, the Windows gaps

**Spec:** `docs/superpowers/specs/2026-11-11-local-mode-design.md` (PR #39,
738964c), "Sequencing and ownership", part C. Its sections 2, 3, 4 (the
profile's tool listing) and 5 are what this plan implements. Where it is
silent, this plan rules and says so.

**Rule for every step:** one PR on `master`, a failing test first, `npm
test` of the folders touched, lint and the golden check through
`git -c core.hooksPath=.githooks commit`, CI on ubuntu, macOS and Windows as
the gate, small commits, English comments. Files outside the part's list
(spec, "Files") are not touched; where a step needs a line in another
owner's file, the PR says so and the owner is asked first.

## Interfaces this part offers and consumes

- **Offers:** `lib/usage/index.js`, used by A's remote client and by the gateway:
  - `usage.beginCall({pack, tool}) -> call`: a per-process counter.
  - `usage.recordIn(call, {server, tool, bytes, lines, ms, outcome, credential})`.
  - `usage.recordOut(call, {tool, bytes, lines, ms, outcome}) -> receipt`.
  - `usage.totals(call) -> receipt`.
- **Offers:** the call id reaches a handler as `ctx.usageCall`, and A's
  `remote:` route reads it there to pass to `recordIn`. That is one line in
  A's `lib/handler-ctx.js`, to be agreed with A in step 3. Until then, A's
  stub calls `recordIn` with the id it is given.
- **Consumes:** B's `createStore(options) -> {metering, kv, jobs}`, only
  through `metering.recordCall` (step 3).
- **Consumes:** B's single-identity key, read through the options object
  (step 1: `options.apiKey` when B sets it; `COUNTINGHOUSE_API_KEY` meanwhile).

## Step 1: `--stdio` (PR 1)

**Files:**
- `lib/mcp/stdio.js` (new);
- `framework.js`, `lib/route-manager.js` and `lib/cli-options.js`: one branch
  each, to start the stdio route instead of `listen` (to be agreed, since
  they are shared);
- `lib/logger.js`: its two `process.stdout` streams become `process.stderr`
  under `--stdio`;
- `bin/countinghouse-stdio.js` (new): a pure JavaScript entry, with no shell and
  no bunyan pipe, that runs `framework.js` in this process with `--stdio`. The
  launcher runs it (reviewer, 2026-11-11: no shell script anywhere on the
  client path). It gets a `package.json` bin entry.
- `test/stdio/*.js` (new);
- `package.json` test script.

**The layer:** `serveStdio({input, output, handle, appKey, drainMs, log}) ->
{done: Promise<code>}`. Pure over two streams, so it is tested without a
server.
- One request per line. An empty line is ignored. A line that is not JSON
  gets the parse error with id null.
- A batch is an array, answered as the HTTP layer answers it: one `handle`
  per entry, in order, with notifications dropped. An all-notification
  batch gets no line, and an empty array is an invalid request.
- Requests run concurrently. Responses are written as they finish, one JSON
  line each, and never interleaved: one `write` per response.
- When stdin ends, no new request is read, and in-flight calls drain for up
  to `drainMs` (the device timeout). Then the layer resolves 0, or 1 when the
  drain timed out.

**Startup** (`framework.js`):
- `--stdio` with `--port` is exit 2, "choose one".
- `--stdio` sends the logger to stderr before the first log line. The shell
  `bin/countinghouse`, which pipes into bunyan, is not for `--stdio`: the
  entry is `bin/countinghouse-stdio.js`, and the docs say so.
- The key, as the spec says: `options.apiKey` (B's in-memory key) or
  `COUNTINGHOUSE_API_KEY`. It is never printed.

**Tests:**
- Unit: `initialize`, `tools/list`, `tools/call` against a fake `handle`;
  a batch; a notification; a parse error; concurrent calls answered as they
  finish; stdin close drains and resolves 0; a drain timeout resolves 1.
- Spawned: `node framework.js --stdio --workerThread --loadModule <fixture>`
  with no Redis service. stdout holds only JSON-RPC lines, stderr has the
  logs, closing stdin exits 0, and `--stdio --port 1` exits 2.
- CI: the spawned test runs on all three OSes. Windows stays
  `continue-on-error` while issue #40 stands (step 4).

## Step 2: roles, scenario and part loading, the profile's listing (PR 2)

**Files:**
- `lib/module-manager.js` and `lib/device-manager.js`: the loader paths;
- `lib/mcp/tool-registry.js`;
- `lib/mcp/gateway.js`: the refusal only;
- `lib/error-catalogue.js`: `MODULE_NOT_LISTED`, `RECEIPT_RESERVED` (step 3)
  and `PART_MISSING`;
- `test/module-loading/roles-*.js`.

**Loading:**
- `countinghouse.role` is `scenario` or `part`; an absent role means listed.
- Loading a scenario loads every module named before the slash in its
  `countinghouse.calls`, resolved by `require.resolve('<name>/package.json',
  {paths: [dir]})`. This recurses, each module once (cycles included).
- The parts get `listed: false`. A part loaded directly is listed.
- A missing part leaves the scenario unloaded. The log names the part
  (`PART_MISSING`), and other modules load normally.
- The device manager keeps `listed` per module.

**Naming (reviewer, 2026-11-11):**
- A module with role `scenario` lists each action under its bare, slugified
  action name (`ci_failure_triage`).
- That name is refused at load when it collides with another listed tool or a
  runtime built-in. The scenario does not load, and the log names both.
- Parts and listed non-scenario modules keep today's long form,
  `<deviceSlug>_<service>_<action>`, so the golden is unchanged.

**Listing:**
- `buildToolTargets` skips unlisted modules.
- The gateway refuses `tools/call`, and `invoke-action` from outside the
  process, for an unlisted module with `MODULE_NOT_LISTED`. The in-process
  `ctx.call` hop is unaffected.

**The profile's listing** (spec §4, when B's single-identity profile is
active, read from the options object):
- `tools/list` holds the scenario tools and `countinghouse_usage_report`
  (step 3).
- `countinghouse_check_balance`, the admin lookup and the authoring tools are
  not listed, and called by name they answer `MODULE_NOT_LISTED`.
- Until B lands the profile flag, this is tested with the flag set directly.

**Tests:**
- A scenario with two parts lists one tool.
- A part loaded alone is listed.
- A missing part: the scenario doesn't load, and the log names the part.
- A direct `tools/call` to a part is refused with `MODULE_NOT_LISTED`.
- A cycle loads each module once.
- The profile's listing.
- A scenario's tool is listed under its bare name, and a collision with a
  listed tool or a built-in refuses the scenario.
- The golden is unchanged: no role means today's behaviour.

## Step 3: boundary counters, usage files, the receipt, the report (PR 3; it may split as 3a/3b)

**Files:**
- `lib/usage/` (new): `index.js` (counters, the API above), `files.js` (the
  `.jsonl` writer), `read.js`, `aggregate.js` and `format.js` (from
  mchen6/ch-report, with their tests), `report.js` (the built-in tool's
  handler);
- `lib/mcp/gateway.js`: `beginCall`/`recordOut` around `tools/call` on a
  listed module, the receipt and `RECEIPT_RESERVED`;
- `lib/mcp/tool-registry.js`: `countinghouse_usage_report` beside
  `countinghouse_check_balance`;
- `bin/countinghouse-usage.js` (new) and its `package.json` bin entry;
- `lib/cli-options.js`: `--usageDir`;
- `test/usage/*.js`.

**Counting:**
- *Out*: bytes and lines (UTF-8, newline-separated) of the text content
  after output validation.
- *In*: recorded by A's client; here, a stub remote calls `recordIn`.

**Files:** `<usageDir>/<YYYY-MM-DD>/<pid>-<startMs>.jsonl`, through
`appendFileSync` on an open descriptor. Each line is `{t, call, pack, tool,
server, bytesIn, linesIn, bytesOut, linesOut, ms, outcome, credential}`;
never a value, never content. `--usageDir` defaults to `<storePath>/usage/`
in `--store local`; under `--store redis` nothing is written unless it is
given.

**The receipt:**
- For a scenario's `tools/call`, the result gains `receipt: {calls, linesIn,
  bytesIn, linesOut, bytesOut, servers}` and one sentence in the text
  content. The sentence names each server; no "saved".
- A module output field named `receipt` is refused with `RECEIPT_RESERVED`.
- *Ruling:* the receipt is added to the structured result after output
  validation, so a module's closed schema doesn't have to allow it.

**`countinghouse_usage_report`:**
- Input `{since?, groupBy?: tool|server|pack|module}`.
- Output is closed:
  - per group: `calls`, `serverCalls`, `bytesIn`, `linesIn`, `bytesOut`,
    `linesOut`, `tokensInEst` and `tokensOutEst` (bytes/4, with `method`);
  - the window;
  - `source: ["memory", "files", "metering"]`.
- Scoping: a key sees its own calls. An admin key sees every caller, grouped
  by the opaque caller id. Each record carries `caller`: R2-1's `u_…` id, or in
  the single-identity profile the one local id, never a key or a name
  (reviewer, 2026-11-11, added to the spec's field list).
- `countinghouse-usage [--since] [--groupBy] [--json|--csv] [--usageDir]`
  prints the same numbers from the files.

**Tests:**
- A scenario making N stub remote calls gives N In records and one Out
  record, with exact counts, a receipt sentence matching the regex, and a
  `receipt` output field refused.
- Report: listed to a plain key in both stores; a call in the same process
  is in the next report; an earlier process's file is in it; plain against
  admin scoping, with no key or name in the output; `method` present; the
  output validates; the CLI prints the same numbers.
- ch-report's tests: aggregation, the truncated last line, CSV, and no
  "saved".

## Step 4: the Windows gap catalogue and issue #40 (PR 4)

**Files:**
- `docs/windows.md` (new): every place the runtime or its tests assume
  POSIX, each with its status;
- the fix for #40 if the cause is in this part's files; otherwise the cause,
  with a minimal reproduction, handed to its owner;
- `.github/workflows/ci.yml`: the local-mode smoke on `windows-latest`
  without `continue-on-error`, once it passes.

**Method:**
- Run the step 1 spawned test on the Windows runner with the runtime's own
  diagnostics.
- Bisect the module-online path: worker start, sandbox policy, fs broker
  paths, module data dir.
- Catalogue what is found.

There is no Windows machine here, so CI is the only Windows evidence, and
the catalogue says which entries were seen there.

## Decided by the reviewer (2026-11-11)

1. The `--stdio` branches in `framework.js`, `lib/route-manager.js`,
   `lib/cli-options.js` and `lib/logger.js` are C's to make, each a small
   branch on `options.stdio`.
2. The one line in `lib/handler-ctx.js` for `ctx.usageCall` is C's; A rebases.
3. Usage records gain `caller`, the opaque id.
4. `bin/countinghouse-stdio.js` is the launcher's entry (step 1).
5. Scenarios are listed under the bare action name, with collisions refused
   (step 2).
6. The aggregation comes from mchen6/ch-report's main, with its tests, and
   the report scopes by `caller` (step 3).
