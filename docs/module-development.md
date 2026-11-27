# Module development

A device module is an npm package that countinghouse loads and exposes as one
or more MCP tools. This document is the full reference; [`README.md`](../README.md#writing-one)
has the short version.

## Directory layout

```
my-module/
├── package.json   # name and version
├── api.json       # device/service/action metadata -- the single declaration
├── schema.json    # JSON Schema 2020-12 input/output/fault per action
└── handlers/
    └── <serviceShortName>/
        └── <actionName>.js     # one handler per action
```

That is the whole module, and the only format: the framework assembles the
device from `api.json`, reads `schema.json` itself, and matches handlers by
name. A module has no main entry. One with a main entry (`package.json`
`"main"`, or an `index.js`) and no `handlers/` directory is refused before any
of its code runs, with `MODULE_LAYOUT_UNSUPPORTED`; one that has both loads
from `handlers/`, and its main entry is never run. See
[`design-decisions.md`](design-decisions.md#module-shape-600-handlers-by-default-discovery-when-you-need-it)
for why the old boilerplate went away.

A handler is a function of `(input, ctx)`:

```js
// handlers/greetService/hello.js
module.exports = async (input, ctx) => ({
  output: {text: `hello ${input.name}`}
});
```

`input` is the validated input object. `ctx` carries the caller, this device's
identity, and the helpers a handler needs — see [`ctx`](#ctx) below.

Code that several handlers share goes in an ordinary file of the module that
the handlers require (`require('../../lib/shared.js')`); it runs when a handler
file is first required, never as a main entry.

The directories under `handlers/` are service **short** names — the part after
`:serviceID:` in the URN. `api.json` remains the only place the full URN
appears.

**Mismatches are startup errors, not silent omissions.** An action declared in
`api.json` with no handler, a handler `api.json` does not declare, a service
short name that does not resolve, or one that two URNs both claim: each fails
the module at load with a message naming the module, the stage, the offending
name and the fix. A module never half-loads.

## `ctx`

| field | what it is |
| --- | --- |
| `ctx.caller` | `{id, isAdmin}` — the caller: `id` is an opaque id (`u_` and 22 characters), the same for that user everywhere on this server, never a key or a user name. For a hop's callee, the identity the hop authorized as (the calling module's binding) |
| `ctx.device` | `{deviceID, friendlyName}` — this device |
| `ctx.serviceID`, `ctx.actionName` | the action being served |
| `ctx.settings` | your module's settings for this call: frozen, no prototype, an unset setting absent ([Module settings](#module-settings)) |
| `ctx.settingRequired(name)` | return (or throw) it when the call needs a setting the user has not set: the client is told, in the runtime's words, to ask the user to set it in their own terminal (on a hosted runtime: that its operator sets it) ([A missing setting](#a-missing-setting)) |
| `ctx.log(entry)` | device log, already bound to this device |
| `ctx.serviceClient(opts, cb)` | call another module by deviceID, as `ctx.call` authorizes (no `as`) — see below |
| `ctx.call(address, input, opts)` | call another module by name — see below |
| `ctx.job` | `{id, progress(n), info(cb)}`. Inside a task: the job's id; `progress(n)` (0–100) updates the job; `info` reads it. Outside a task: `id` is `null`; `progress(n)` (0–100) is the call's own progress, sent to a client that asked for it (at most one every 250 ms, the latest winning, none after the answer; a composite's parts' reports are dropped); `info` calls back with an error. Ask `ctx.job.id == null`, not `ctx.job == null`, to tell a call that is not a task |
| `ctx.redis` | your module's own key-value space, in node_redis v3's callback style: Redis db 5 under `--store redis`, a local store with the same commands and answers under `--store local`. Every key you name is your module's alone: the runtime stores it as `m:<module name, URI-encoded>:<key>`, by the name it loaded your module under, so another module's `get('x')` never sees your `x`, and you never see the runtime's own keys. You write and read the key as you named it. The commands are `del`, `get`, `hdel`, `hget`, `hgetall`, `hmget`, `hmset` (fields as pairs or one `{field: value}` object), `hset`, `llen`, `lpush`, `lrange`, `ltrim`, `mget`, `pexpire`, `rpush`, `set`, `zadd`, `zrange` and `zrem`; there is no `multi`/`exec` |
| `ctx.recordUsage(tool, cost, cb)` | app-layer bookkeeping; never touches balance; answers `{id, tool, cost, ts}` |
| `ctx.usage()` | a promise of the current tools/call's counts so far, read-only: `{calls, bytesIn, tokensInEst, servers: {name: calls}, sentence}`, plus `standIn: [names]` when an acceptance stand-in answered (`--remoteOriginMap`). They are the call's remote server calls, its parts' included, and the bytes of text those calls returned; `tokensInEst` is bytes/4, an estimate; `sentence` is the first half of the runtime's receipt sentence, word for word (`read 3.1 MB in 14 calls to github`, or `no server was called`). The call's own output is measured when it returns, so it is not counted here. `null` when the call is not a counted one (not a tools/call, or one that has already answered). In a worker the query carries the call's token and is refused `CALL_TOKEN_INVALID` without it (a direct peer channel's call has none, and a call's token ends when it answers). Never a key, an id or a caller. A scenario writes its receipt sentence from it |
| `ctx.ask(name, values)` | a promise of the user's answer to one of this action's declared questions: the form's content, or `null` when the user declined — see [Asking the user](#asking-the-user-ctxask) |
| `ctx.httpHeaders` | request headers, when the call arrived over HTTP, minus `X-CH-Key`, `X-App-Key` and `Authorization` |

A module is never handed an API key or a user name (R2-1): not in `ctx`,
not in its hops, its job info or its environment. Its hops are authorized as
the identity the operator binds to it (`runsModules`) and billed to the
caller, by a per-call token the runtime keeps out of the module's reach. The
global `CHUtil` a module sees has no `dm` or `ci`; `CHUtil.createServiceClient`
takes no `appKey` in a worker.

`ctx` replaces the device instance that used to be bound as `this`. That is a
narrowing on purpose: handlers used to be able to reach `setAction`,
`deviceControl` and the rest of the framework's own surface. They no longer
can.

## Asking the user: `ctx.ask`

A handler may ask its user one of the questions its action declares:

```js
module.exports = async (input, ctx) => {
  const answer = await ctx.ask('overwrite', {id: input.id});
  if (answer == null || answer.replace !== true) return {output: {saved: false}};
  // ... save it
};
```

The question is declared in `api.json`, never written by the handler:

```json
"questions": {"overwrite": {"message": "Replace the saved note {id}?", "schema": "/notesService/saveNote/questions/overwrite"}}
```

`values` fills the message's `{name}` placeholders with strings (cut to 200
characters), numbers and booleans. The user reads
`<module name>: <the message>`, and answers a form made from the
schema (see [`api.json`](#apijson) for what a form may hold). The name is
the module whose tool the user called: your own, or, when your action is a
part reached through a scenario's `ctx.call`, the scenario's. A part is
never named to the client; the runtime's log and usage record name it.

**The handler runs again.** MCP is stateless here, so the first time
`ctx.ask` has no answer it rejects with `ASK_PENDING`, which ends your
handler; the client shows the form, and when the user answers the call is
made again and your handler runs **from the top**, where `ctx.ask` returns
the answer at once. So:

- **Ask first, act after.** Whatever your handler did before the ask is
  done again on the second run, and costs again:
  - **Every hop made before the ask is made again, and billed again.** A
    handler that calls three parts and then asks pays for six part calls
    when the user answers. The call itself is billed once, when it
    completes.
  - **A non-idempotent action before an ask happens twice**: a message is
    sent twice, a record written twice, a card charged twice. If the user
    declines, the first one has still happened.
  - `countinghouse-validate` cannot see either: whether a handler acts
    before it asks is in its code. The usage record of a pass that asked
    shows its round, so an operator can see a module that asks late.
- **Let `ASK_PENDING` pass.** Do not catch it. If you do and return a
  result, that result is the call's answer and the question is dropped.
  This holds through composition too: a part's question rejects the
  calling handler's `ctx.call` with `ASK_PENDING`, and the caller should
  let it pass; on the retry both run again and the part's `ctx.ask` gets
  its answer.
- **A part asks only its own action's questions.** Which module and action
  ask is the runtime's to know, never the message's. A call has one set of
  rounds, whoever in its chain asks: one question a round, three rounds of
  one question, eight in all.
- **An answer is for the exact text asked.** `ctx.ask('overwrite', {id: 'a'})`
  and `ctx.ask('overwrite', {id: 'b'})` are two questions, and each needs
  its own answer.
- **`ASK_UNAVAILABLE` means there is no one to ask**, and you may catch it
  to fall back: the client offered no form, the call came by HTTP
  `invoke-action`, it runs as a task whose request declared no form
  elicitation or while too many tasks already wait on questions, the
  operator turned questions off (`--moduleQuestions off`), the outer call
  (when your action is a part) has no one to ask for any of these reasons,
  three rounds brought no valid answer, or the call has had eight rounds in
  all already (every question's together). A part reached in single-thread
  mode (`--no-workerThread`) has no one to ask either. In a task, a
  question whose form can't be shown, or that finds no room among the
  tasks waiting on questions, is a round like one asked, and the task runs
  again at once, its `ctx.ask` then `ASK_UNAVAILABLE` for that question --
  so a task that asks under a new key each time stops within its eight
  rounds. Those passes run within the task's time limit (its own timeout,
  else `--jobTimeout`), counted from the first of them; past it the task
  fails `JOB_TIMEOUT`.
- **Keep a question's values the same on every run.** A time or a counter
  in `values` makes a new question each time, and the answer the user gave
  is for the old one.
- **A retry that is refused after the user answered asks again.** The
  answer's state is used up when the retry is taken; if the call is then
  refused before your handler runs (a rate limit, say), the next call
  starts from the question.
- **`ASK_NOT_DECLARED`** is your own mistake: no such question on this
  action, or a value that is missing or is not a string, a number or a
  boolean.
- **An answer is not proof of a person.** A client may answer a form
  however it likes, so an answer must never unlock what the caller could
  not do without it.

The answer is the form's content and nothing else: no client name, no
session, no user.

## Failing a call

Return `ctx.error(code, message?, details?, options?)`:

```js
module.exports = async (input, ctx) => {
  if (typeof input.text !== 'string') return ctx.error('INPUT_REJECTED', 'text must be a string', null, {kind: 'caller'});
  return {output: {text: input.text.toUpperCase()}};
};
```

An error is your module's fault by default. When the caller is at fault
instead (input your schema could not rule out, a row that doesn't exist),
pass `{kind: 'caller'}` as the fourth argument: the error's `kind` is then
`'caller'`, and the usage report counts it as `CALLER_ERROR`, the caller's,
not `MODULE_ERROR`. Only `'caller'` and `'module'` are taken; anything else
is ignored, and a module never says an error is the runtime's. The answer
names the kind: over HTTP a caller-kind error answers `400` and a module
error `500`, each body `{code, message, kind}`; over MCP the tool's error
result carries `countinghouse/kind` in its `_meta`, beside
`countinghouse/code`. A caller-kind error is not retried in a
task: the same input fails the same way. When your module calls another
one, a caller-kind error it gets back is your module's (you were its
caller); if your caller is at fault, say so with your own `ctx.error`.

The code is your module's own: an `UPPER_SNAKE_CASE` name for what went
wrong (`INPUT_REJECTED` for input your schema can't rule out,
`REPO_TOO_LARGE`, …). Give your codes your module's own prefix, its short
name (`WEATHER_RATE_LIMITED`, not `RATE_LIMITED`), so they never collide
with the runtime's catalogue, now or in a later release. The runtime's
codes (its error catalogue) are the runtime's, and a module never answers
with them. `ctx.error` with one still returns your module's error, but
where your handler's answer leaves it the runtime answers the runtime's
`MODULE_CODE_RESERVED` instead, and so it does for an error whose code is
set to one afterwards. The log says why, once per module and code, naming
your module. `MODULE_CODE_RESERVED` is the runtime's (`origin: 'runtime'`, kind
`module`): it says a module broke this rule. A setting your module cannot do without is
`ctx.settingRequired(name)`, never `ctx.error('SETTING_REQUIRED')`. The caller gets your code and
the message `CODE: message`, in worker and single-thread mode alike. So
does a module that calls yours with `ctx.call`: it gets your error whole
(code, message and details, as a copy: never your `cause` or your object),
in either mode.

When you call another module, its rejection's `origin` says whose error it
is: `'runtime'` for the runtime's (`MODULE_RELOADING`, `PEER_GONE`, a
`CTX_CALL_…` refusal), `'module'` for the callee's own. A callee cannot answer
with a catalogue code (it is refused, as above), but check
`err.origin === 'runtime'` before acting on a runtime code (retrying on
`MODULE_RELOADING`, say), not the code alone.

Under `--moduleSandbox enforce`, `origin` can be trusted: only an error
the runtime itself issued is `'runtime'`. However a
module builds its error (setting `origin` on it, or constructing one
through its constructor), it answers as the module's own,
`origin: 'module'`, and one whose code spells a catalogue name answers
`MODULE_CODE_RESERVED`. A runtime error you were given (a callee's
`MODULE_RELOADING`, a `CTX_CALL_…` refusal, a `ctx.serviceClient`
refusal) and pass on stays the runtime's, with the code it was issued
with and the message it reached you with (in worker mode a runtime
error's message is the catalogue's text, without the detail single-thread
mode keeps): changing them on it changes nothing, so to answer with your
own code, return `ctx.error(...)` (with the runtime's error as its
`cause` if you want to keep it). Any sandbox mode freezes the error class
in the module's worker and keeps the runtime's way of issuing errors out
of the module's reach; only `enforce` also blocks a module from requiring
countinghouse's own files. `audit`, the worker default, records such a
require but allows it, and single-thread mode and `--moduleSandbox off`
have no sandbox ([security model](security-model.md)): there a module can
forge this as it can do anything else.

Returning the error is the preferred form. Throwing it
(`throw ctx.error(…)`), from an async function or a plain one, or passing it
to a callback gives the same answer. A helper that has no `ctx` can throw a
plain `Error` that carries your code instead:
`Object.assign(new Error('path must be a string'), {code: 'INPUT_REJECTED'})`.
Its code counts as yours when it looks like one (`/^[A-Z][A-Z0-9_]{2,}$/`)
and is not a system error's (one with `errno` or `syscall`, such as
`ENOENT`) or someone else's: Node's own (`ERR_…`, `MODULE_NOT_FOUND`,
`ABORT_ERR`, and the HTTP parser's `HPE_…`), any errno name even without
`errno` (`ECONNRESET`, `ETIMEDOUT`, …, as a network failure carries),
undici's (`UND_ERR_…`, from `fetch`), and the certificate-verification codes
Node gives a TLS error (`CERT_HAS_EXPIRED`, `INVALID_CA`,
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, …: an exact list of 28, in
`lib/countinghouse-error.js`, so your own `UNABLE_TO_PARSE` is still yours).
Those are crashes,
answered as `DEVICE_INVOKE_EXCEPTION` with the original in the fault, so an
operator can tell a failure you didn't handle from one you meant. To raise
such a code on purpose, use `ctx.error`. Only an `Error` counts: a thrown
plain object (even one with a `code`), `null`, or a rejection with nothing
is a crash too, and a callback handler's `callback({code: …})` is an
untyped failure (`DEVICE_INVOKE_FAIL`).

Catch your dependencies' errors and wrap them with `ctx.error`. A
dependency's own coded `Error` that you let escape (`SQLITE_BUSY`,
`ER_DUP_ENTRY`) looks like a module code, so it is answered as yours, with
its code; `countinghouse-validate` can't warn about it, since it sees your
source, not the codes your dependencies throw.

To wrap an underlying error, pass it as `details.cause`:
`ctx.error('INNER_CALL_FAILED', `${label}: ${e.message}`, {cause: e})`. The
cause stays on the error and is never sent to the caller. A runtime error you
rethrow unchanged (from `ctx.call`, say) keeps its own code.

Anything else you throw becomes `DEVICE_INVOKE_EXCEPTION` (the runtime reads a
bare `throw` as "this handler crashed"), and an untyped `callback(err)`
becomes `DEVICE_INVOKE_FAIL`. See
[`design-decisions.md`](design-decisions.md#handler-failure-is-classified-by-the-error-not-by-how-it-arrived).
The pre-8.0 error globals are gone
([upgrading-to-8.md](upgrading-to-8.md)).

## Retired: main entries and dynamic discovery

Before 8.0, a module could also be a main entry: a `device.js` exporting a
handler map, or an `index.js` exporting a class or EventEmitter that decided
at runtime how many devices to expose (`discover`, `deviceonline`,
`deviceoffline`). Both are retired. Such a module is refused at load, by
`countinghouse-validate` (stage `layout`) and by the runtime, with
`MODULE_LAYOUT_UNSUPPORTED`, which names the file that made it a main entry.
For a `device.js` handler map, move each entry into its own
`handlers/<service>/<action>.js` (`module.exports = <the entry's function>`);
for a 5.x module (a `CHDevice` with `setAction`),
`npx countinghouse-migrate-module ./my-module` converts it to `handlers/`. A module is one device, described by its `api.json`; a module
that needs several devices is several modules.

## `api.json`

Declares one `friendlyName` and one or more services (each keyed by a
`urn:...:serviceID:...`). Each service has an `actionList` **array**, and each
action carries its own `name`, a human-readable `description` (**required**;
it is what an LLM sees as the MCP tool's description, and an action without
one is skipped), and up to three schema pointers into `schema.json`:

```json
"serviceList": {
  "urn:example-com:serviceID:echoService": {
    "actionList": [
      {
        "name": "echo",
        "description": "Echoes the input object back, unmodified.",
        "input":  {"schema": "/echoService/echo/input"},
        "output": {"schema": "/echoService/echo/output"},
        "fault":  {"schema": "/fault/echoService/echo/fault"}
      }
    ]
  }
}
```

`input`, `output` and `fault` are each optional; an action that declares no
`input` takes none, and one that declares no `output` is not validated on the
way back. Action names must be unique within a service.

The spec is validated against the framework's own JSON Schema 2020-12
meta-schema at load time. Required fields it is easy to forget:
`device.modelDescription`, and each action's `name`. Anything the meta-schema
does not know at the top level, in `serviceList` or in an action is
**rejected**, not ignored — so a stale field left over from an older format
shows up as a load error rather than silently doing nothing. Directly under
`device`, unknown fields are accepted; the retired CDIF-era `rateLimit` and
`price` are among them, and `countinghouse-validate` warns about each.

An action may also carry `title`, `annotations`, `icons`, `longRunning`,
`questions` and `resource`, and the device a `promptList`: what the MCP
layer serves to a client beyond a tool's name, description and schemas
([every declaration, at a glance](#declarations-at-a-glance)). Each is
checked by the meta-schema and at load (stage `declarations`):

- a `resource`'s `uriTemplate` is a relative path of literals and `{name}`
  variables, at most 8 and at most one to a segment (`notes/{id}`,
  `files/{name}.json`); each variable is a string property of the action's
  input, and every required input is a variable. No two resources of a
  module may match the same URI: `notes/{id}` and `notes/all` do;
- a prompt's arguments are an object schema of string properties, at most
  16, and every `{{name}}` in its messages is one of them. Other text in
  double braces is sent as written, with a warning from
  `countinghouse-validate`;
- a string here may be declared through a `$ref` (a variable's property, a
  prompt's argument); a question's form may not, it is flat;
- a question's schema is a flat form: at most 8 properties, each a string,
  number, integer, boolean or an enum of strings. It is shown to the user as
  you declare it, so it holds only what a form field takes (`title`,
  `description`, `default`; a string's `minLength`, `maxLength` and
  `format`; a number's `minimum` and `maximum`; an enum's `enum` and
  `enumNames`), within bounds (a title of 128 characters, a description of
  500, 64 enum values of 256), and no text in it, the question's message
  included, carries a control or bidi character. A form never asks for a
  password, a token, a key or a card number (`countinghouse-validate` warns
  about a property that reads like one);
- an action named as a `completion` takes `{argument, value, context}` and
  gives `{values: string[]}`;
- an icon is a file inside your module, a PNG, JPEG or WebP of at most
  16 KiB, named by its path from the module's root. Never a URL, and never
  SVG.

A tool's `title`, `annotations` and `icons` are served on `tools/list`
(each only when the action declares it). The hints in `annotations`
(`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) are
your claims: the runtime enforces none of them, and a client or an install
review may show them. Icons are read and checked when the module loads: a
missing, oversized or SVG icon refuses the load (stage `icons`), and a reload
to such a version leaves the loaded one serving. Each is sent inline as a
`data:` URI from what the load read; nothing is read at list time.

An action that declares a `resource` is served on `resources/list` (a
`uriTemplate` with no variable) or `resources/templates/list` (one with
variables), as `countinghouse://m/<module>/<path>`, where `<module>` is your
module's name as tool names spell it. It is not also a tool: declare a
second action over the same function if you want both. `resources/read`
runs your action exactly as a `tools/call` does, with the URI's variables as
its input (validated against your input schema, rate limited, billed as
that action): a string output is the resource's text (your output schema's
`contentMediaType`, else the declared `mimeType`, else `text/plain`), a
binary string output its blob, anything else its JSON. A variable is
percent-decoded as UTF-8; a value with a control character, a `/` or a
`\`, or that is exactly `.` or `..`, never reaches you, but anything else
is yours to guard, as any input is. Two things to keep it that way:

- The variable reaches you decoded exactly once. Never decode it again:
  `%252E%252E` arrives as `%2E%2E`, and a second decode makes it `..`.
- Don't normalise it (NFKC, NFKD) before you use it as a path or a key.
  Compatibility forms pass the checks above as the characters they are
  (two U+FF0E fullwidth full stops are not `..`), and NFKC turns
  them back into `..` and `/`.

If two of the modules a runtime lists have names that spell the same
`<module>` (`twin-a` and `twin_a`), neither one's resources are served, and
the operator is warned; rename one.

A client can subscribe to your resources' URIs on its `subscriptions/listen`
stream. You have no API to say your data changed: your resource's
`changesWith` says which of your module's actions may change it
(`"changesWith": ["notesService.save", "notesService.remove"]`). After a call
to one of them succeeds, by any path (a `tools/call`, an `invoke-action`, a
hop from another module, a job), every subscription of the calling key that
names a URI of that resource is sent `notifications/resources/updated`,
once per URI within a quarter second. It is coarse on purpose: it says only
"read again", whatever the call changed. A call that fails, or is refused
before your handler runs, sends nothing. On a shared runtime, a module that
keeps its state per session tells only the calling session's subscriptions.
A resource's `changesWith` may not name its own read action (the load is
refused): every read would announce a change, and a client that reads again
on each would loop.

An action that declares `longRunning: true` runs as a task for a 2026-07-28
client that declares the `io.modelcontextprotocol/tasks` extension (with
`--workerThread`): the call is answered at once with a `taskId`, and the
client polls `tasks/get` for the result your action returns. Anyone else's
call to it runs inline, as any action's does. Your handler is the same
either way. While it runs, `ctx.job.progress(n)` (1–100) is the task's
`statusMessage` on `tasks/get`, as `"NN%"`, rounded. A progress of 0 shows
none, since every task starts at 0. A task that failed without an answer
shows its code (`JOB_TIMEOUT` when it ran past `--jobTimeout`), never your
handler's text.

A task may ask, as a call does (see [Asking the user](#asking-the-user-ctxask)), when the request
that made it declared form elicitation: the pass that asks ends, the task
reads `input_required` with the form, and once the client answers it with
`tasks/update` your handler runs again from the top under the same
`taskId`, where `ctx.ask` returns the answer. The same rules hold: ask
first, act after; three rounds of a question, eight in all. The pass that
asks is not billed and spends none of the task's attempts. A question waits
at most an hour; after that the task fails (`ASK_EXPIRED`) and nothing
more of it runs. At most 64 of a key's tasks wait on a question at once
(10,000 in all); past that, `ctx.ask` is `ASK_UNAVAILABLE` at once. While
it waits its `statusMessage` is `waiting for an answer`, and a client that
listens for the task is told each change as for a working one: waiting,
working again once answered, then its end (or `ASK_EXPIRED` when the hour
is up).

Text you declare for the client (titles, descriptions, a prompt's messages, a
question's message) reaches it with any hidden character as a space: a
control, bidi, zero-width, tag, variation-selector or filler character
(see [the security model](security-model.md)). A prompt's message keeps its
line breaks and tabs, and an emoji keeps its joiner and VS-16. A completion
candidate (an `enum` or `examples` value, or one your completion action
answers) with a hidden character is not offered.

A device's `promptList` is served on `prompts/list` and `prompts/get`: each
prompt is listed as `<module>_<name>` (a scenario's under its bare name), to
the keys that may reach the module, with its `title`, `description` and
`icons` and the arguments its schema declares (name, description, whether
required). `prompts/get` runs none of your code: it checks the arguments
against that schema, replaces each `{{name}}` once with the argument's value
(an absent optional one is the empty string; substituted text is never
scanned again) and returns your messages, at most 64 KiB in all. When an
argument fails its `pattern`, the refusal quotes its `description`, if it has
one, as your words: say the form there.

`completion/complete` offers values for a prompt's argument, or for a
resource template's variable (`ref/resource`, the template as listed): the
argument's schema's `enum`, then its `examples` (a template's: the input
property behind the variable), matched to what the user has typed. A
prompt or a resource may instead name an action of your module to answer:
`"completion": {"<argument>": "<service>.<action>"}`. That action is called
with `{argument, value, context}` (`context.arguments`: the other
arguments' values so far, strings only) and answers `{values: string[]}`;
at most 100 values of at most 256 characters are kept. It runs as a call of
that action (authorized, rate limited, your input and output schemas
checked), but it is not billed and is not listed as a tool; it is counted
in usage as `completion/complete`. Keep it cheap: a client may ask on every
keystroke. If it fails, answers no values, or takes more than 2 seconds,
the schema's candidates are offered instead, and a run past 2 seconds is
cancelled as a cancelled call is (what it asks afterwards is refused).

Specs written for 4.x (`argumentList` + `serviceStateTable`) do not load. The
error says so and names the converter:
`npx countinghouse-migrate-spec ./my-module`. See
[`MIGRATION.md`](../MIGRATION.md).

### Declarations at a glance

Every key an action, its `resource` and a prompt may carry, with where the
meta-schema ([`spec/schema.json`](../spec/schema.json)) defines it. Two
prefixes keep the pointers short:

- `ACTION` is
  `#/properties/device/properties/serviceList/patternProperties/^urn:[\S]{1,64}:serviceID:[\S]{1,64}$/properties/actionList/items`
- `PROMPT` is `#/properties/device/properties/promptList/items`

An action, a resource and a prompt refuse any other key.

| Declaration | In `spec/schema.json` | What it is |
|---|---|---|
| `name` | `ACTION/properties/name` | Required. The action's name, unique within its service. |
| `description` | `ACTION/properties/description` | What a client, and an LLM, reads as the tool's description. An action without one is skipped. |
| `input` | `ACTION/properties/input` | `{schema}`: a pointer into your `schema.json`. Without it, the action takes no input. |
| `output` | `ACTION/properties/output` | `{schema}`. Without it, the result is not validated on the way back. |
| `fault` | `ACTION/properties/fault` | `{schema}`: the shape of what a failure of this action carries ([Failing a call](#failing-a-call)), of any root type. It describes; no fault is checked against it. |
| `title` | `ACTION/properties/title` | The tool's title, served on `tools/list`. |
| `annotations` | `ACTION/properties/annotations` | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`: your claims, served on `tools/list`, enforced by nothing. |
| `icons` | `ACTION/properties/icons` | At most 4 files inside your module (PNG, JPEG or WebP, at most 16 KiB each), read at load and served inline. |
| `longRunning` | `ACTION/properties/longRunning` | Runs as a task for a client that declares the tasks extension (with `--workerThread`). Every other caller runs it inline. |
| `questions` | `ACTION/properties/questions` | At most 4 named questions your handler may ask with `ctx.ask`, each a message and a flat form ([Asking the user](#asking-the-user-ctxask)). |
| `resource` | `ACTION/properties/resource` | The action is a resource, read by its URI, and is not listed as a tool. |
| `resource.uriTemplate` | `ACTION/properties/resource/properties/uriTemplate` | Required. A relative path of literals and `{name}` variables, each one a string property of the input. |
| `resource.name` | `ACTION/properties/resource/properties/name` | Required. The resource's name, as `resources/list` shows it. |
| `resource.title` | `ACTION/properties/resource/properties/title` | Its title. |
| `resource.description` | `ACTION/properties/resource/properties/description` | Its description. |
| `resource.mimeType` | `ACTION/properties/resource/properties/mimeType` | What a string output is served as, when the output schema's `contentMediaType` does not say. |
| `resource.changesWith` | `ACTION/properties/resource/properties/changesWith` | Up to 32 actions of this module (`<service>.<action>`) whose success tells subscribers to read again. Never its own read action. |
| `resource.icons` | `ACTION/properties/resource/properties/icons` | As an action's `icons`. |
| `resource.completion` | `ACTION/properties/resource/properties/completion` | Per variable, the action of this module that offers values for it. |
| `promptList` | `#/properties/device/properties/promptList` | On the device: at most 32 prompts, served on `prompts/list` and `prompts/get`. |
| `prompt.name` | `PROMPT/properties/name` | Required. Listed as `<module>_<name>`, or a scenario's under the bare name. |
| `prompt.title` | `PROMPT/properties/title` | Its title. |
| `prompt.description` | `PROMPT/properties/description` | Its description. |
| `prompt.icons` | `PROMPT/properties/icons` | As an action's `icons`. |
| `prompt.arguments` | `PROMPT/properties/arguments` | `{schema}`: an object schema of at most 16 string properties. |
| `prompt.messages` | `PROMPT/properties/messages` | Required. 1 to 8 `{role, text}` messages, `role` being `user` or `assistant`, with `{{name}}` placeholders. |
| `prompt.completion` | `PROMPT/properties/completion` | Per argument, the action of this module that offers values for it. |

The declarations in your `package.json`'s `countinghouse` object are listed
under [`package.json`: the `countinghouse` keys](#packagejson-the-countinghouse-keys).

## `schema.json`

Supplies the JSON Schema 2020-12 documents the action's `input`/`output`/`fault`
pointers resolve to. This is what becomes each MCP tool's
`inputSchema`/`outputSchema`.

Every call's input and output is validated in one of the server's
validator workers, which all modules share:
- your schemas are compiled at load, every action, within
  `--validationCompileMs` (10 s by default), or the load is refused
  (`MODULE_ASSEMBLY_FAIL`, stage `schemaCompile`);
- a validation has a deadline (`--validationTimeoutMs`, 1000 ms by default),
  past which the call is refused `VALIDATION_TIMEOUT`;
- three such refusals of your own outputs (or compiles) in five minutes
  quarantine your module, `VALIDATION_QUARANTINED`, until it is loaded again;
- an output over `--maxOutputBytes` (16 MiB by default) is refused
  `OUTPUT_TOO_LARGE`, and so is a `ctx.call` input over it, `INPUT_TOO_LARGE`,
  on the main-thread-routed path. A hop's input is sent as bytes: a value
  structured clone cannot carry, or a `SharedArrayBuffer`, fails the
  `ctx.call` in your own worker.
  Any other message your worker sends the runtime (a log line, a
  `ctx.redis` command) over the output cap plus 64 KiB is refused
  `MESSAGE_TOO_LARGE` before it leaves the worker. A file write is split
  for you, so it has no such limit.
- an output is JSON: one holding a Buffer, a typed array or a DataView is
  refused `OUTPUT_NOT_JSON` in your worker, naming the field (a bare
  `ArrayBuffer` is only caught by a typed field's check, and is sent as `{}`
  otherwise). Binary data goes in a field declared
  `{"type": "string", "contentEncoding": "base64", "contentMediaType": "image/png"}`
  (your type in place of `image/png`), as `buf.toString('base64')`. Such a
  field is checked for canonical base64 (the standard alphabet, padded, no
  whitespace), in an input as in an output. Declare an output's binary
  field inline, under `properties` or an array's `items`, at most 8 levels
  down and 16 to an action, with a media type of the form `type/subtype`.
  One anywhere else (under `oneOf` or the like) is refused at load, at stage
  `declarations` (below), and so is a `$ref` under an output that leads to
  one, also to one declared inline elsewhere: `schema.json` is dereferenced
  before the fields are mapped, so the `$ref` would be a second field. An MCP client gets an
  `image/*` or `audio/*` value as a block of its own
  (`{type: "image" | "audio", data, mimeType}`), after the text block, in
  schema order; in `structuredContent` and the text the value is a
  reference, `{mimeType, bytes, block}` (`bytes` its decoded size, `block`
  its index in `content`), and `tools/list` advertises that shape for the
  field. A result can carry at most 16 such values (an array counts each
  item), else `TOO_MANY_BINARY_VALUES`. Another media type is still sent as
  its base64 string for now. `ctx.call` and HTTP `invoke-action` always get
  the base64 string itself.
- what you write with `process.stdout.write` and `process.stderr.write`
  reaches the operator's log line by line, prefixed with your module's name: each line
  cut at 8 KiB, control characters other than tab removed (and the line
  separators and bidi controls), and under audit and enforce at most
  256 KiB a minute per stream of what is written, each line counted with
  its prefix and newline; past that it is dropped and counted. `console`
  and `fs.writeSync(1, ...)` or `fs.writeSync(2, ...)` reach it only when the
  runtime runs with `--debug`: otherwise your worker's `console` methods do
  nothing and those writes are dropped. (`ctx.log(entry)` goes to the
  device log in the runtime's store, not to this log.) The streams are the
  runtime's: assigning `process.stdout` throws (`TypeError`) in strict mode.
  Use the log for diagnostics, not for data.

Keep patterns simple, schemas small, and outputs modest: return a reference
(a path in your data namespace) to anything large. A `schema.json` that is plainly unsafe is refused at load
(`MODULE_ASSEMBLY_FAIL`, stage `schemaSafety`, naming the schema path):

- `schema.json` larger than 1 MB (checked before it is parsed);
- a regular expression (`pattern`, a `patternProperties` key, a
  `propertyNames` pattern) longer than 1000 characters, or one that can
  backtrack catastrophically: a repetition inside a repeated group, such as
  `^(a+)+$` or `(\d+)*`, or a repeated group whose alternatives start alike,
  such as `^(ab|ac)+$`. Write `^a+$`, `^\d+(?:,\d+)?$` with a bounded group,
  or `^(a[bc])+$`, instead;
- a schema that comes to more than 100,000 nodes once its `$ref`s are
  expanded, or actions whose schemas come to that many together;
- a `$ref` that refers to itself, or one that names no place in
  `schema.json` (only `#/...` JSON pointers are followed);
- a schema nested too deeply to check.

`countinghouse-validate` runs this same check, in the load's own order and
words (stage `schemaSafety`, code `MODULE_ASSEMBLY_FAIL`), so you meet it
before an operator's load does. Its problems at the stages `declarations`
and `readRootSchema` carry that code too: each is one the load refuses the
module for.

What your module declares is checked at load as well, where the meta-schema
cannot say it (`MODULE_ASSEMBLY_FAIL`, stage `declarations`, naming the
action):

- a binary output field that is not under `properties` or `items` (above);
- `x-mcp-header` anywhere in an input schema. MCP 2026-07-28 lets a property
  mirror itself into an HTTP header; this runtime does not serve that yet, so
  a schema may not carry the keyword;
- the rules of the fields [`api.json`](#apijson) takes for MCP clients.

The load stops at the first such problem. `countinghouse-validate` prints
them all.

## `package.json`: the `countinghouse` keys

What your module declares outside its spec goes in one object in its
`package.json`, `"countinghouse": {...}`. The runtime reads these keys and
ignores any other one.

| Key | Value | What it is |
|---|---|---|
| `calls` | `["<module>/<service>.<action>", ...]` | The actions of other modules this one may `ctx.call`. An address that is not here is refused ([Calling other modules](#calling-other-modules)). A scenario's parts are the modules it names. |
| `permissions` | `{fs, net, env, limits}` | What its worker may reach under the sandbox: paths, hosts, environment variables, and memory, blocking and disk limits ([Declaring permissions](#declaring-permissions)). |
| `remotes` | `[{name, transport, url, headers, credential}]` | The remote MCP server it calls, one per module in this version ([Calling a remote MCP server](#calling-a-remote-mcp-server)). |
| `role` | `"scenario"` or `"part"` | A scenario is listed and loads its parts. A part loaded by a scenario is not listed ([Roles](module-authoring.md#roles-scenarios-and-parts)). Any other value counts as no role. In the single-identity profile (`--stdio`, the shared runtime) only scenarios are listed; on a hosted server a module with no role is listed as any module is. |
| `settings` | `{"<name>": {type, values, min, max, maxLength, format, default, required, confirm, title, description}}` | The settings a user may choose for your module, such as units or a default repository ([Module settings](#module-settings)). An invalid declaration refuses the load (`SETTINGS_DECLARATION_INVALID`). |
| `state` | `"shared"` (the default) or `"per-session"` | Whether the module keeps state per user session. `per-session` gives it, on the shared runtime, a worker, `ctx.redis` keys and `/data` and `/tmp` of its own per session (see [Modules that keep state per session](#modules-that-keep-state-per-session)). It is refused on the HTTP hosting profile (`MODULE_NEEDS_SESSIONS`); under `--stdio`, one session, it runs as a shared module. Any other value refuses the load (`MODULE_STATE_INVALID`); a reload that changes it is refused (`MODULE_STATE_CHANGED`). |

## Module settings

A module can declare settings that a user chooses: units, a default
repository, a page size. Declare them in `package.json`, beside `calls` and
`permissions`:

> Module settings run only with worker threads (the default). In
> single-thread mode (`--no-workerThread`) a module that declares settings is
> not loaded (`SETTINGS_NEED_WORKER_THREADS`: "<package> declares settings,
> which run only with worker threads (--workerThread); this version was not
> loaded"), and a reload to a version that declares them is refused, the
> loaded version serving on. A
> module that declares none loads in either mode.

```json
"countinghouse": {
  "settings": {
    "units":       {"type": "enum", "values": ["metric", "imperial"], "default": "metric",
                    "title": "Units", "description": "Units used in forecasts."},
    "defaultRepo": {"type": "string", "format": "repo", "title": "Default repository",
                    "description": "owner/name used when a call names no repository."},
    "maxResults":  {"type": "integer", "min": 1, "max": 100, "default": 20,
                    "title": "Results per call"},
    "shareStats":  {"type": "boolean", "default": false, "confirm": true,
                    "title": "Send anonymous usage statistics"}
  }
}
```

The vocabulary is small and closed. It is not JSON Schema.

| Field | Rules |
|---|---|
| the name (the key) | `[a-z][a-zA-Z0-9_]{0,63}`, with no dot, and not the name of an `Object.prototype` member (`constructor`, `toString`, ...). At most 32 settings. |
| `type` | `string`, `integer`, `number`, `boolean` or `enum`. |
| `values` | For an `enum` only: 1 to 64 distinct strings, each 1 to 64 characters of letters, digits, space and `_.:/@+-`. |
| `min`, `max` | For an `integer` or a `number`: finite bounds (whole numbers for an `integer`). |
| `maxLength` | For a `string`: 1 to 1024 characters (256 by default), counted in code points. |
| `format` | For a `string`, optional: `slug`, `repo` (`owner/name`, GitHub's grammar), `email`, `hostname` or `url` (https only, no user info, kept in canonical form). There is no `pattern` and no `path`. |
| `default` | Optional; it must be a valid value. A setting with no default and no value is **unset**, and so is an empty string. |
| `required` | `true`: a call while the setting is unset fails before your handler runs. |
| `confirm` | `true`: a change in conversation needs the user's own confirmation. Mark a setting that sends data somewhere, costs money, or acts for the user. Every `string` setting needs it anyway. While no client is on countinghouse's tested list for that confirmation, such a setting is set at a terminal only (unless the operator sets a fixed value for it). |
| `title`, `description` | Shown to the user and the agent: at most 64 and 512 characters. |

- **The declaration is at most 16 KiB**, and a module that declares settings
  has an npm package name.
- **A value with a hidden character is refused**, never cleaned.
- **A `hostname` or `url` value must be inside your module's granted
  `permissions.net`**, as the operator's policy narrowed it, or it is
  refused as out of bounds. A default outside it is treated as unset, with
  a warning at load.
- **Settings are not secrets.** A value can be shown and set in
  conversation. A key goes in a credential, never a setting.
  `countinghouse-validate` warns on a name or title that looks like one
  (`password`, `token`, `secret`, `apiKey`, `credential`).
- **The values your module gets** are its defaults, then the values the
  user stored, then any the operator fixes. A stored value your loaded
  version does not accept (a removed setting, a narrowed enum, a tighter
  bound) is not applied: the default applies, the log says so once per load
  (naming the setting, never the value), and the stored value comes back
  with a version that accepts it.
- **The declaration is pinned when an operator loads your module**, as
  `calls` is: a module that rewrites its `package.json` and restarts under
  supervision keeps the declaration it was loaded with.

### How a user sets them

- **At a terminal:** `ch-local settings set <package>.<setting> <value>`.
- **In conversation:** the built-in `countinghouse_settings` lists a loaded
  module's settings (`get`, at most 64 a call, with a cursor; a part's are
  never listed), and changes one by its name, `module.<package>.<setting>`
  (`set`).
  - An `enum`, `integer`, `number` or `boolean` setting changes on request.
  - A `string` setting, and any you mark `confirm: true`, needs the user's
    own confirmation: a form for a tested client, else the terminal command.
  - The operator's ceiling can fix a value or allow the terminal only.
  - A change applies to every session of the user, from the next call; each
    session that has your module in view is told what changed.

### Reading them: `ctx.settings`

```js
module.exports = async function forecast(input, ctx) {
  const units = ctx.settings.units;                       // 'imperial'
  const repo  = input.repo || ctx.settings.defaultRepo;
  if (repo == null) return ctx.settingRequired('defaultRepo');
  // ...
};
```

- `ctx.settings` holds the values for this call: the defaults, then the
  user's (or the operator's) values, then any value the operator's ceiling
  fixes. It is frozen and has no prototype. An unset setting is absent.
- A change applies from the next call: a call in flight keeps the values it
  started with.
- A task keeps the values of its first run for its life, so an answer to
  `ctx.ask` is never run under other settings than it was asked under.
- Every path gets them: a client's call, a call from another module, a
  task's run, a per-session worker, and a direct peer channel.

### A missing setting

- **Declared `required`.** A call to your module while the setting is unset
  fails before your handler runs, with `SETTING_REQUIRED`, and is not billed.
  The check covers every module the call can reach through its declared
  calls, so a part's missing setting fails the outer call too. The client is
  told which setting (`_meta["countinghouse/missingSettings"]`) and to ask
  the user to run the command that sets it in their own terminal, which asks
  for the value (on a hosted runtime: that its operator sets it); for a
  part's, only that a module the tool calls needs a
  setting made at a terminal (a part's settings are never named to a
  client).
- **Needed only as a fallback** (most settings are a default for an input,
  such as `repo`): don't mark it `required`, since a call that names the
  value itself would then be refused. When neither the input nor the
  setting gives a value, `return ctx.settingRequired('defaultRepo')`. The
  runtime answers the same `SETTING_REQUIRED`, in its own words, when the
  setting is declared by your module and unset in the values the call ran
  with; any other claim is answered as a fault of your module
  (`DEVICE_INVOKE_EXCEPTION`). The call ran, so it is metered as a call
  whose handler returned an error.

`countinghouse-validate` checks the declaration, by position and field, and
prints how each setting is changed in conversation (on request, or only with
the user's confirmation), so you see what your users will be asked. The load
makes the same checks; an invalid declaration refuses it
(`SETTINGS_DECLARATION_INVALID`).

## Loading your module

At startup:

```sh
node ./framework.js --workerThread --loadModule ./path/to/my-module
```

Into a running server (requires an **admin** apiKey — see
[`authentication.md`](authentication.md#admin-keys)):

```sh
curl -X POST http://127.0.0.1:9527/load-module \
  -H 'Content-Type: application/json' -H 'X-CH-Key: <your-admin-key>' \
  -d '{"path":"./path/to/my-module","name":"my-module","version":"1.0.0"}'
```

You do **not** need `--debug` for either. `--debug` disables authentication
for the whole server; it is not how you get access to an endpoint.

### What your module's worker loads

Under `--workerThread` your module runs in a worker of its own
(`lib/lean-worker.js`). The main thread reads your `api.json` and
`schema.json` itself, before the worker starts; the worker only requires
your handler files, each once, and answers the calls the main thread sends
it. Your device is what the main thread read from `api.json`. Nothing your
code does in the worker can change it, add a device or rename one.

The worker loads as little of the runtime as it can. `CHUtil` is a facade:
each helper (`CHUtil.request`, `createServiceClient`, `deviceLog`, and the
rest) loads its implementation the first time it is called, so a module
that uses none never pays for them. `ctx` works the same way: `ctx.call`,
`ctx.log` and `ctx.redis` load what they need on first use. `CHUtil` has no
`dm` or `ci`. Those were the runtime's own objects, never part of the
module API.

### A require or import that can't be resolved, under `enforce`

Under `--moduleSandbox enforce` a bare name (`require('dep/sub')`,
`import('dep')`) or a `#` import that your code can't resolve gets one
answer, whatever Node's resolver would have said:

- a `require` gets `MODULE_NOT_FOUND`, an `import` `ERR_MODULE_NOT_FOUND`;
- the message is "Cannot find module '<name>' (countinghouse module
  sandbox)";
- a `require`'s error has a `requireStack` of `/app/...` names only (your
  own file where the refusal knows it), never a host path.

Node looks a bare name up in the `node_modules` above your module too, so
any other answer would tell your code what exists outside it. The cost is
that an error from one of your own dependencies, such as an `exports` map
that doesn't list the subpath (`ERR_PACKAGE_PATH_NOT_EXPORTED`) or a broken
`package.json`, reads as not found there. Check the dependency under
`--moduleSandbox audit` or `off`, where Node's own error is kept. Code that
falls back on `MODULE_NOT_FOUND` for an optional dependency works as
before.

Under `enforce` no `package.json` in your module -- its own, a nested
one, one in its `node_modules` -- may have a `"main"` that leads outside
your module's directory or names the directory itself: the load is
refused ("... 's "main" leads outside the module"), and under `audit` it
is reported. Node picks a `"main"` past every check the sandbox makes, so
where it led would otherwise tell your code whether a host file exists.
Keep `"main"` inside your module, naming a file.

Under `enforce` a `package.json` anywhere in your module is also refused at
load (and reported under `audit`) when any of these holds:

- it isn't valid UTF-8;
- it writes `"imports"`, `"exports"`, `"name"`, `"main"` or `"type"` twice,
  or writes one of those keys with an escape (`"\u0069mports"`);
- it writes the value of `"name"`, `"main"` or `"type"` with a backslash
  escape.

The sandbox and Node read a `package.json` with different parsers, and
these are the places they can disagree.

Under `enforce`, `module.findPackageJSON` takes its specifier and base as
strings. A `URL` object answers `undefined`, so pass `url.href`.

On Node below 24.15, under `enforce`, a `#` name resolved with
`require.resolve` (or `createRequire().resolve`) uses the CommonJS
conditions Node brought with the first `require` in your module's worker
(Node's own, `--conditions` and all); only before any `require` has run
there would it use Node's default list. A plain `require` always uses its
own, as on 24.15 and later.

### Libraries that work with module paths, or hook module loading

- `resolve-from`, `import-fresh` and the like, which resolve from your
  module's own `__dirname`: on Linux and macOS they work in every mode,
  single-thread included -- your module's directory is `/app/...`, and it
  reaches Node's resolver in its host form, inside your module only. On
  Windows they work too: in a worker your module's `__dirname` is
  `<V>:\app\...`, and every path the runtime hands back (`fs.realpathSync`,
  `fs.mkdtempSync`, directory entries, glob, errors' `path`) is in that
  spelling; in single-thread mode it is its host path.
- Node's own `Module._resolveFilename` called with a relative request, and
  `module.findPackageJSON`, from one of your files: work in every mode, on
  Windows workers too. Under `enforce` the `module` your code gets has no
  `findPackageJSON`. Give `findPackageJSON` your paths as strings (pass
  `url.href` for a `URL`): under `off` and `audit`, and in single-thread
  mode, a `URL` object is handed to Node unmapped. Under `off` and
  `audit`, a direct call made from your module's own paths -- a parent or
  base built from `__filename` or `__dirname`, as `resolve-from` and
  `import-fresh` build one (`/app/...`, or `<V>:\app\...` on Windows) --
  answers only inside your module: anything it would find outside is not
  found, and any error it raises is a plain not-found (`MODULE_NOT_FOUND`,
  or `undefined` from `findPackageJSON`) naming the request as you gave
  it. A plain `require` keeps Node's own error kinds there.
- `Module._resolveFilename` called directly with an absolute `/app/...`
  request (`importFresh(path.join(__dirname, 'x'))`, say) isn't mapped in a
  worker on Node 24.15 and later: pass a relative request, or require it
  normally (below Node 24.15 it is, on Linux and macOS). In single-thread
  mode it is found: on Linux and macOS mapped through your module's
  directory; on Windows `__dirname` is a host path to begin with.
- `require-in-the-middle` (APM agents' module hooks): throws at
  `new Hook()` under `audit` and `enforce`; a module can't hook the
  runtime's module loading.
- `module-alias`: no alias takes in a worker (it does in single-thread
  mode); use relative requires.

Under `enforce` your module's directory may not hold a link to a
directory: the load is refused ("holds a directory link at ..."), and
under `audit` it is reported. Node's ES resolver reads a package's
`"main"` against a link's own path, past every check the sandbox makes,
so a linked package could tell your code whether a host file exists. A
pnpm or workspace layout links packages in: use a flat install (`npm
install`), or run that module under `audit` or `off`. A link to a file
(`node_modules/.bin`) is fine.

Under `enforce` Node's warnings about a `"main"` (`DEP0128`, `DEP0151`)
aren't emitted to your module, and any other warning names your files by
their `/app/...` paths. `process.emitWarning` can still be assigned, and
what you assign is what a warning reaches, but it can't be redefined with
`Object.defineProperty`.

Under `enforce` the process-wide switches Node reads while it resolves are
held. `process.emitWarning` can be assigned a function, or `null` to turn
off every warning in your module's worker, Node's own included, but not
redefined. `Error.stackTraceLimit`,
`process.noDeprecation`, `process.throwDeprecation` and
`process.traceDeprecation` can be assigned but not redefined or deleted.
`process.env` and `process.send` can't be replaced (the keys of
`process.env` can still be set; `process.send` stays `undefined`, though
`'send' in process` is `true`, so test for an IPC channel with
`typeof process.send === 'function'`): in strict code the assignment throws a
`TypeError`, and otherwise it doesn't take.

## Files and paths

Since 8.0.0 a module in worker mode (the default) sees its own file
namespace, the same in every `--moduleSandbox` mode:

| Path your code uses | What it is | Access |
|---|---|---|
| `/app` | your module's install directory | read-only under `enforce` (`EROFS`) and `audit` (`EACCES`); under `off` writes reach the install directory |
| `/data` | your module's private data directory | read-write, counted against your disk limits, kept across restarts |
| `/tmp` | your module's private temp directory | read-write, counted against your disk limits, **emptied every time your worker starts** |
| each path you declared in `fs` | the same path on the host | `r` or `rw`, as the operator approved |

`__dirname` and `__filename` are under `/app` (`/app/handlers/...`),
`process.cwd()` is `/app`, and `os.tmpdir()` is `/tmp`. Paths in results and
errors are virtual too. Use `require` and relative paths as usual; build file
paths from `__dirname` (or `import.meta.dirname`) rather than from a host path
you know. Paths inside a module use `/` on every OS. On Linux and macOS a `\`
is part of a file name; on Windows it is a separator, the same as `/`.

**Write under `/data` or `/tmp`.** Writing next to your code under `/app` is
refused under `enforce` (`EROFS`). `/data` is for what must survive a
restart; `/tmp` starts empty each time (one the runtime didn't make, an
operator's say, is never emptied; the operator is told). On the host they are
`<moduleDataPath>/<your package name>/data` and `.../tmp`; the operator sets
`--moduleDataPath` (default `$HOME/.countinghouse/module_data`). Unloading,
restarting and reloading never delete them; an operator's
`POST /uninstall-module` does, unless told to keep them.

**Anything else, declare.** A path outside your namespace is answered
`ENOENT` under `enforce` (and logged on the host). Under `audit` a read of
it reaches the host and is logged, but a write is refused (`EACCES`), and so
is every access to a protected path (countinghouse's own files and
directories, ch-local's home; see the [security model](security-model.md));
under `off` it reaches the host. Declare each outside path in `fs` (see
[Declaring permissions](#declaring-permissions)) and the operator approves
it.

**Disk limits.** `/data` and `/tmp` together count against `diskMb` (default
ceiling 1024) and `diskEntries` (files and directories, default ceiling
100 000). Over either, a write fails with `ENOSPC` under `enforce`; under
`audit` crossing a threshold is logged. Declared paths are not counted.
Start-up time grows with the number of entries in `/data` and `/tmp`: your
worker's start walks them, about 70-145 µs per entry on the maintainer's VM
(715 ms for 10 000 entries at `dab69d0`, 1.1-1.5 s at `cd411ee` on a slower
disk; so 7-15 s near the 100 000 default). The walk is asynchronous and does
not block the server.

**Links.** In every mode a hard link works only within one writable root, and
a symbolic link only with a relative target that stays inside its root
(absolute targets are `EPERM`). `chmod` drops setuid, setgid and sticky bits.
A `rename` across roots (`/tmp` to `/data`, say) answers `EXDEV`, so copy
fallbacks such as `fs-extra`'s `move` work.

**What works differently.**

- Every `fs` call is a message to the main thread, synchronous calls
  included. Fewer, larger operations cost less: `readFile`, `writeFile` and
  `appendFile` are one call each. On a 2-CPU machine, 250 rounds of a 4 KB
  write, read, stat and unlink took about 1.2 s under `off` and 1.9 s under
  `enforce`, against about 30 ms with no broker (measured at `9246db1`; see
  [the benchmarks](benchmarks/sandbox-part2.md)).
- Descriptors your code gets from `fs.open` are numbers from `0x10000000`
  up, not small integers. `fs.writeSync(1, ...)` and `fs.writeSync(2, ...)`
  go to your module's console when the runtime runs with `--debug`, and are
  dropped otherwise (`pino` and `sonic-boom` work either way, without
  output); `process.stdout.write` reaches the log in both.
- `fs.watch`, `fs.watchFile` and `fs.promises.watch` are not available
  (`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`).
- HTTP/2 `respondWithFile` is not available: read the file with `fs` and
  stream it.
- A worker's `process.env` holds only the variables you declared (see
  below), so code that read undeclared variables sees them missing. Don't
  declare a proxy variable (`HTTPS_PROXY`, `NO_PROXY` ...): under `enforce`
  `CHUtil.request` never goes through a proxy (the lockdown sets
  `proxy: null`), and in every mode the declaration lets your module read
  the operator's proxy URL, which may hold credentials.

**Single-thread mode** (`--no-workerThread`) is for debugging modules and
has no sandbox. Modules still see `/app`, `/data` and `/tmp` through `fs`,
`fs/promises`, `os` and `CHUtil.loadFile`, but only as a translation, with no
checks, quota or link rules. The differences from worker mode:

- `process.cwd()` is the server's real working directory.
- Stack frames, `module.filename`, `require.cache` keys and `require.resolve`
  results are host paths, and so is `import.meta.dirname` in ES modules.
- Paths given to anything other than `fs`, `fs/promises`, `os` and
  `CHUtil.loadFile` are not translated, except that on Linux and macOS a
  `/app` path your module resolves from (`createRequire`, `require.resolve`'s
  parent, an absolute request, a `module.findPackageJSON` base) is mapped
  through your module's own directory, each answer a host path. On Windows
  single-thread mode gives your module no virtual directory: its
  `__dirname` is its host path, and Node resolves from it as it is.
- countinghouse itself, or its module path, installed under a real `/app`
  (a container's working directory, say) isn't supported in single-thread
  mode: the real paths there can't be told apart from your module's
  `/app`. Use worker mode there.
- A module can require countinghouse's own dependencies through `NODE_PATH`.

Upgrading a module or a deployment from 7.x: see
[`upgrading-to-8.md`](upgrading-to-8.md).

## Modules that keep state per session

By default a module runs in **one worker, shared by every session** of the
runtime that hosts it: what it keeps in memory, in `ctx.redis` and in `/data`
is the same for every user. That is right for almost every module. Declare
otherwise only if your module keeps per-user state, in memory or in storage,
that must not be shared:

```json
{
  "name": "my-notes",
  "version": "1.0.0",
  "countinghouse": {"state": "per-session"}
}
```

The value is `"shared"` (the default) or `"per-session"`; anything else
refuses the load (`MODULE_STATE_INVALID`). It's read from your
`package.json` when the operator loads the module, and kept with it: a
reload or restart that changes it is refused (`MODULE_STATE_CHANGED`).
Unload first, then load.

**What you get, on the shared runtime** (one runtime serving several of a
user's client sessions, `--sessionSocket`):

- **A worker per session that uses the module.** It starts on that
  session's first call into the module: a direct call, a hop from another
  module (`ctx.call`) made in that session's call, or a task the session
  created. It stops when the session ends. Listing the module's tools,
  prompts and resources needs no worker.
- **Its own storage per session:** its own `ctx.redis` keys, `/data` and
  `/tmp`. Write the module as if it had one user. It never sees a session id
  (not in its options, environment, `ctx`, paths or error texts), and it
  can't reach another session's worker or storage.
- **Hops into it go through the main thread.** Each hop is routed to the
  calling session's worker by its own call's token, never over a direct
  peer channel. That costs one main-thread round trip per hop into a
  per-session module (see [the security model](security-model.md#modules-that-keep-state-per-session)
  for why).

**Limits.**

- `--maxSessionWorkers` (default 16) caps the per-session workers **in
  all**, across every per-session module and every session. It's the one
  bound on their memory: about 15 MB once plus about 24 MB per per-session
  worker (resident memory, measured on Node 24 with a small module; a
  heavier module adds its own heap), so the default cap of 16 is about
  400 MB at most, above the shared workers
  ([benchmarks](benchmarks/lean-worker.md)). Only the operator sets it, from
  the terminal. A session can't change it.
- At the cap, the least recently used worker that is idle (no call in flight,
  and no call token issued to it still live) gives up its slot, and its
  session is told on its next result of the module: `<module>'s in-memory
  state was reset; its files were kept`. A worker is never stopped mid-call.
- When every slot is busy, the call is refused `SESSION_WORKERS_BUSY`
  (retryable). Nothing is queued.
- A worker that crashes frees its slot at once. Its session's next call
  starts a fresh one and is told the same. Three exits within ten minutes
  suspend the module for that session alone (`MODULE_SESSION_PAUSED`,
  retryable), until the
  ten minutes pass, the module is reloaded, or the session ends. Other
  sessions' workers aren't affected.

**Lifetime of the storage.**

- It's kept while the session can come back: across a detach within the
  reconnect window, and across a runtime restart that restores the session.
- It's removed when the session ends for good: it leaves (`bye`), its
  reconnect window passes, or a resume never settles. That happens after
  the session's workers have stopped. It's kept across a runtime restart
  that restores and resumes the session. If the module is being reloaded at
  that moment, or was reloaded as a shared module, its storage for that
  session is removed at the runtime's next start instead.
- When the runtime starts, once it accepts connections, it removes in the
  background the storage of every session it neither restored nor has open.
  If it restored none (the daemon died) and there was storage to remove,
  only the next session to connect is told that per-session module state
  was reset. A swept session's user reconnects as a new session, which the
  runtime can't link to the old one.
- A reload stops every session's worker. Their storage is kept, and the
  next calls run the new code. An uninstall removes every session's storage
  with the module's own.

**Where it runs.** A per-session module needs the shared runtime's sessions:
on the HTTP hosting profile its load is refused (`MODULE_NEEDS_SESSIONS`).
Under `--stdio` there is one session, so it runs in its one worker on the
module's usual paths (`<name>/data`, `m:<name>:`), as a shared module does.

## Declaring permissions

Under `--workerThread`, each module runs inside the module sandbox
([`security-model.md`](security-model.md) says what that does and does not
guarantee). A module that stays inside its own directory needs to declare
nothing. One that needs more declares it in `package.json`, beside
`countinghouse.calls`:

```json
"countinghouse": {
  "calls": ["…"],
  "permissions": {
    "fs":     [ { "path": "/var/log/app", "access": "r" } ],
    "net":    [ { "host": "api.example.com", "ports": [443] } ],
    "env":    [ "WEATHER_API_KEY" ],
    "limits": { "heapMb": 128, "externalMb": 128, "maxBlockMs": 5000, "diskMb": 200 }
  }
}
```

| Field | Rules |
|---|---|
| `fs` | Paths outside the module only. Absolute, normalized, no `..`. `access` is `r` or `rw`. `/`, `/app`, `/data`, `/tmp` and anything under them are reserved and cannot be declared. |
| `net` | `host` is a hostname or a `*.`-prefixed wildcard (one leading label only); `ports` is optional, integers 1-65535. |
| `env` | Environment variable names (`[A-Z_][A-Z0-9_]*`). |
| `limits` | What the module asks for; all optional: `heapMb` (JS heap), `externalMb` (Buffers and typed arrays), `maxBlockMs` (how long the event loop may be blocked), `diskMb` and `diskEntries` (`/data` and `/tmp` together). The operator's ceiling applies; the default ceilings are 256, 256, 10000, 1024 and 100000. |

A declaration is a request. The operator's `--modulePolicy` file can grant it
as declared or narrow it, never widen it. Under `--moduleSandbox enforce` a
module that declares `fs`, `net` or `env` gets none of them until the
operator adds an entry for it: no access outside its own directory, and no
environment variables at all. Under `audit` the declaration is granted.
`fs`, `env` and `limits` take effect now. `net` is validated and logged, and
takes effect when the network brokers ship, so declare it now and expect to
need it. Targets of `CHUtil.request` are already checked
against the effective `net` entries: under `audit` a disallowed target is
logged and the request still goes ahead; only `enforce` refuses it. Under
`enforce`, `CHUtil.request` also accepts only the ordinary request options (`method`,
`headers`, `body`, `json`, `qs`, `timeout`, ... but not `baseUrl`, `proxy`,
`agent`, `har` and similar) and checks every redirect.

A refused `CHUtil.request` answers with a stand-in for postman-request's
`Request`, never `undefined`. Its methods send nothing but return what a
`Request`'s would: `pipe(dest)` returns `dest`, `form()` a FormData,
`form(fields)` and the builders the request, and `write` true. `abort()`
sets `_aborted` and emits `'abort'`.
The refusal (`ERR_ACCESS_DENIED`) goes to your callback and to the
request's `'error'` listeners, including one you add later. With neither,
nothing is emitted, so a stream you piped it into is never ended. Listen
for `'error'` when you stream. After `abort()`, nothing is delivered. A
`URL` object given as `uri` leaves the stand-in's `uri` null. A string
gives its parts, as an informational approximation of postman-request's
own (`url.parse`'s fields), not an exact copy: `slashes` is always true,
`auth` stays percent-encoded, `href` is the string as given, and a
backslash form (`http:\\host:8080/`) has the port URL reads, where
`url.parse` reads none.

Under `audit` a request goes ahead whatever its target, and what is reported
is what is sent, as under `enforce`. The target is read once (an object
`uri` by its `href`, never by its own host fields), and what is handed on is
its normalised href. A target that can't be read or parsed is reported
invalid, and nothing is sent.

**Self-contained.** Every dependency of your module, followed through the
whole tree, must be installed inside the module's own directory. Install
with `npm install --prefix <module>` (or run `npm install` inside it), and
ship that `node_modules`. A dependency that resolves outside the module is
a problem `countinghouse-validate` reports and `enforce` refuses to load.
Under `enforce` the module's worker can `require` built-ins and files under
its own directory, nothing else (not countinghouse's `lib/`, not global
folders, not other modules); under `audit` such a `require` works and is
logged.

**No native addons.** A `.node` file, a `binding.gyp`, or `"gypfile": true`
anywhere in the tree is refused under `enforce`, and loading native code at
run time throws under `enforce` (under `audit` it works and is logged). Use a pure-JavaScript replacement: `bcryptjs` is the usual
one for `bcrypt`. Dependencies with `preinstall`, `install` or `postinstall`
scripts are reported as warnings by `countinghouse-validate`.

**Environment variables.** The worker's `process.env` holds only the names
you declared in `env` and the operator approved. The value comes from the
operator's policy entry if it sets one, otherwise from the server's own
environment; a name with neither is absent. Read them with
`process.env.NAME` as usual.

**Blocked built-ins.** `child_process`, `cluster`, `worker_threads`,
`inspector` (and `inspector/promises`), `wasi`, `v8`, `repl`,
`trace_events`, `node:sqlite`, `node:test` and `node:sea`, and any built-in newer than Node 24.21 (Node 26's `node:ffi` among them), are
unavailable:
`require` of them fails with `MODULE_NOT_FOUND` under `enforce` (under
`audit` it works and is logged). `module` is reduced to `builtinModules`,
`isBuiltin` and a `createRequire` limited to your directory.
OpenSSL engines (`crypto.setEngine`, `privateKeyEngine`, `clientCertEngine`)
count as native code. `process.dlopen`, `process.binding`, `process.kill`, `process.abort`,
`process.chdir` and the `process.set*id` family throw under `enforce`; under
`audit` they work and are logged, so `process.kill` can still signal the
server. `process.exit` works in both and ends only your module. `net`,
`http` and similar still work in this release, and the first use of each is
logged; `fs` goes through the file broker ([Files and paths](#files-and-paths)).

**Limits, restart and suspend.** A module that exceeds its heap limit, its
external memory limit, or blocks its event loop longer than `maxBlockMs` is
terminated, as is one whose worker exits or errors (an uncaught exception
is caught and logged, and does not end the worker). Then:

- Calls in flight fail at once with **`MODULE_RESTARTING`** and the reason.
- The module is restarted after 1 s, then 2 s (the 3rd exit within 10
  minutes suspends it instead, see below). Calls
  meanwhile get `MODULE_RESTARTING` with the time of the next attempt. Your
  tools stay in `tools/list`; callers should retry after the time given.
- When the operator reloads your module (load it again,
  `POST /reload-module`, `POST /restart-module`), calls in flight fail at
  once with **`MODULE_RELOADING`**, and calls that arrive before its devices
  are back get it too; a queued or scheduled job waits for the new worker
  (up to 30 s) and runs on it. When it is unloaded, or its new code fails to
  load, calls in flight and after get **`MODULE_UNLOADED`**, and jobs for it
  fail without retrying. Operator actions on your module take effect in
  order, the latest winning: a reload superseded by a later load, reload
  or unload before its worker is up ends that worker, and the operator who
  asked for it gets **`MODULE_LOAD_SUPERSEDED`**; an unload arriving then
  leaves the module unloaded, and the jobs waiting for it fail
  `MODULE_UNLOADED` at once.
- After 3 exits in 10 minutes the module is suspended and calls get
  **`MODULE_SUSPENDED`** with the last reason, until an operator runs
  `POST /restart-module`. A restart that the sandbox refuses (because the
  module's `package.json` or the policy changed, under `enforce`) suspends
  it at once.

Your module also sends at most `--moduleMessageRate` messages per second
(default 2000) to the main thread, and Redis commands count; beyond that
calls fail with `RATE_LIMITED`. Cache what you can.

Check a module with `countinghouse-validate` before loading it: it reports
permission syntax, dependencies outside the module, native code and install
scripts.

## Calling other modules

### `ctx.call` — by name (the default)

```js
const data = await ctx.call('repo-scan/scanService.scan', input);
const {data, platformMetering} = await ctx.call('repo-scan/scanService.scan', input, {detail: true});
```

The address form is `<module>/<service>.<action>`:

- `<module>` — the target's `friendlyName` (its `api.json`'s
  `device.friendlyName`), not `package.json`'s `name`.
- `<service>` — the **service label**: the raw last segment of the service's
  URN (`urn:...:serviceID:scanService` → `scanService`), not a made-up short
  name.
- `<action>` — the action's `name`, exactly as declared in `api.json`.

Exactly one `/` and one `.` are allowed, and none of the three parts may
themselves contain either character — `repo-scan/scanService.scan` is valid,
`repo.scan/scanService.scan` is not. This is deliberately **not** the MCP tool
name (`repo_scan_scanservice_scan`): tool names are deduped with a `_2` suffix
on collision, in an order that depends on module load order, so a hardcoded
tool name cannot survive another module being loaded first.

**Declare what you call, in your own `package.json`** — not `api.json`, whose
format did not change:

```json
{
  "countinghouse": {
    "calls": [
      "repo-scan/scanService.scan",
      "secret-detect/detectService.detect"
    ]
  }
}
```

**Bind the identity your hops run as, in the auth config — not in the
module.** Your module's inner calls are made with an internal key that the
operator sets up. Each entry in the auth config is one key: the entry's name
is the key itself.

A complete config for the `repo-review` composite (examples/repo-review) has
two entries, one for the person calling and one for the module's inner calls:

```json
{
  "<the caller's key>": {
    "userName": "demo",
    "devices": ["<deviceID of repo-review>"]
  },
  "<an internal key that is not its user name>": {
    "userName": "repo-review-internal",
    "devices": ["<deviceID of repo-scan>", "<deviceID of secret-detect>"],
    "runsModules": ["repo-review"]
  }
}
```

**The key idea: the internal entry's two fields answer two different
questions.**

- **`devices` is what the key may call.** It lists the tools this key is
  allowed to reach: here, repo-scan and secret-detect.
- **`runsModules` is who uses the key.** It lists the modules whose inner
  calls are made with this key: here, repo-review. This is the only link
  from a module to its key; without it, `ctx.call` refuses with
  `CTX_CALL_UNBOUND`.

Read it as: *`demo` may call repo-review; repo-review makes its inner calls
with the internal key; that key may call repo-scan and secret-detect.* When
`demo` calls repo-review:

1. The call is allowed because repo-review is in `demo`'s `devices`. `demo`
   needs no access to repo-scan or secret-detect.
2. repo-review's handler calls `ctx.call('repo-scan/scanService.scan', …)`.
   The runtime finds the entry whose `runsModules` lists repo-review and
   checks the call against that entry's `devices`. It passes.
3. The hop is billed to `demo`, not to the internal key (see below).

Each inner call needs both halves: the address in your `package.json`'s
`countinghouse.calls` (the author's declaration) and the target in the bound
key's `devices` (the operator's grant). Either one missing fails the module
when it loads, with a message naming the address and the file to fix.

**When the modules you call make calls of their own**, each of them gets its
own internal entry the same way, with its own `runsModules` and only the
`devices` it calls. A module that calls nothing needs no entry. One entry may
list several modules in `runsModules`, but a module may be listed by only one
entry (a second claim is refused as a conflict). Separate entries keep each
module limited to the calls the operator granted it, so a module update that
declares a new call gets nothing until the operator grants it. Don't grant a
set of modules that lets them call each other in a loop: no hop-depth limit
ends one, only the call timeouts.

Give an internal key a value that differs from its `userName`: user names are
shown to callers (a composite's bill, `check_balance`), so a key that doubles
as one is handed to every caller. The file provider warns at startup when it
sees one.

That split is deliberate: which identity a module runs as is the operator's
decision, not the author's, so the same module can be deployed twice under
two different identities with two different grants. A handler never names
its own identity — it just calls `ctx.call`.

As with `ctx.serviceClient`, **authorization and billing are two different
identities**: the hop is authorized as the bound identity above, but billed
to `ctx.caller` — the real outer caller — so per-hop cost lands on whoever
actually called your tool, not on the module.

**Only the key the call came in with is billed.** That is the key the
client authenticated with, over any route (an HTTP request, an MCP client,
or a job, whose run is billed to the key that added it). It pays for the
call itself and for every inner hop the call causes, however deep the
chain. No other key is charged: an internal key only authorizes, so it
needs no balance. The auth config has no billing field; who pays is a fixed
rule of the runtime, not something an entry can change or redirect.

**Everything is verified at load time, not at first call.** For modules
present at startup, every address in `countinghouse.calls` is resolved
against the target's real spec, the identity is bound via `runsModules`, a
duplicate binding is refused, and the bound identity's grant to each target
is checked. A typo, a missing binding, or a missing grant fails the module
at startup with a message naming the module, the address, and the file to
fix — it does not wait until the first call to surface.

Load time is still where you want to find a broken chain, because only the
load-time error can name the module, the address and the file to fix. But a
runtime refusal is no longer anonymous: **each `ctx.call` guard rejects with
a typed code that reaches an MCP client intact.** A failed `tools/call`
comes back `isError: true` with `_meta["countinghouse/code"]` set to one of
(before 8.0.0 it was `structuredContent.code`; an error result now carries no
`structuredContent`, because MCP clients validate it against the tool's output
schema even on errors):

| `code` | what it means |
| --- | --- |
| `CTX_CALL_NOT_READY` | composition verification has not finished for this module yet — retry; this does *not* mean the config is wrong |
| `CTX_CALL_UNBOUND` | verification finished and bound nothing: the address is missing from `countinghouse.calls`, or no identity's `runsModules` lists this module (both are required) |
| `CTX_CALL_UNDECLARED` | an identity is bound, but this address is not in `countinghouse.calls` |
| `CTX_CALL_BAD_ADDRESS` | the address is not of the form `<module>/<service>.<action>` |
| `CTX_CALL_UNRESOLVED` | the address does not resolve against the target module's spec |

A callee that genuinely threw still reports `DEVICE_INVOKE_EXCEPTION` —
telling a misconfigured chain apart from a failing one is the whole point of
the codes. Because they come from the error catalogue (`lib/error-catalogue.js`), each code's
message text is actionable on its own.

What still does not cross the MCP boundary is a runtime error's per-call
**detail**. Under `--workerThread`, the main thread rebuilds a runtime error
from a worker's reply by its `code` alone
(`CountinghouseError.fromReply`), so a client sees the code's generic
message, not "… for address `x/y.z`". The full text survives in
single-thread mode and over REST `/devices/:id/invoke-action`. A module's own
error (`ctx.error`) is different: every reply between threads carries it
whole, so its code and message reach the client in either mode, and a
composing module's `ctx.call` gets its details too. The callee's structured `.fault`
reaches neither.

**A short startup window remains, and it is waited out.** A device appears in
`tools/list` before composition verification has finished — that
verification is asynchronous and runs after all modules are discovered. A
call to it in that window is held until its verification is decided, and a
`ctx.call` waits for it too, each for at most 25 s and 2 s inside the
request's own timer. Past that, the call is refused with
`CTX_CALL_NOT_READY`, whose message says to retry. Treat that code as
retryable and every other `CTX_CALL_*` code as a configuration bug. The
code says the call to the module that is not ready was not run. A held call
is never sent until its module's verdict is decided, but the same code also
reaches a client through a composing module that passes on its own
`ctx.call`'s refusal, maybe after doing work of its own: such a module
should say so in its answer.

A module that fails its verification at startup is removed and never
listed: a call held for it is answered as a call to any tool the caller
can't use (on MCP, `unknown tool: <name>`, the same answer for every
reason; on the REST routes, the route's one answer for a device the caller
can't use, `MODULE_NOT_LISTED` (404); `DEVICE_NOT_FOUND` for a task's run). A
module loaded later that fails its verification keeps serving its own
actions, unbound: a call held for it goes on, and its `ctx.call` is refused.
A module that ends while a call to it is held (an unload, a crash, a
restart) answers that call at once, and the call is never sent. Over MCP,
the answer is the one a new call to the tool would get at that moment: gone,
the same `unknown tool` answer; restarting, `MODULE_RESTARTING`, retryable.
On the REST routes, a held call that ends gone gets the route's one answer
for a device the caller can't use, `MODULE_NOT_LISTED` (404). When a
new version serves the tool after a retry (the module reloaded, in place or
not), the held call gets `CTX_CALL_NOT_READY` and the client's retry is
served. A module turned off or hidden while a call to it is held never runs
that call: it gets the same `unknown tool` answer a new call gets. A held
call whose client cancelled it, or whose request timer ran out, is never
sent either.
`examples/repo-review/token-comparison.js` waits for the server's "all
module discovered" log line plus a settle buffer to stay out of the window
entirely — see its comment on `waitForAllModulesDiscovered` for the full
timeline.

Composition verification also runs for modules loaded at runtime, including
into an instance started with no `--loadModule` flags at all — the
`--authoringTools` setup recommended above. A bare instance completes
discovery vacuously at startup, and each later `countinghouse_load_module`
re-runs verification for what was just loaded, so a module authored and
loaded entirely at runtime can `ctx.call` normally.

This was not always true: `allmodulediscovered` used to be gated on a
startup module count that a bare instance never reached, so verification
never ran there and every `ctx.call` was refused against a perfectly correct
auth config. `test/composition/08-bare-server-discovery.js` guards both
halves — that a bare instance reaches discovery completion, and that a
composing module loaded into one at runtime can actually call through.

### `ctx.serviceClient` — addressing a device by ID

`ctx.call` resolves a declared address by name. `ctx.serviceClient` reaches a
target by `deviceID` (computed offline or looked up yourself, with no name
resolution), for the same declared targets:

```js
ctx.serviceClient({deviceID, serviceID}, (err, client) => {
  client.invoke({actionName: 'echo', input: {...}}, (err, data, platformMetering) => { ... });
});
```

It authorizes exactly as `ctx.call` does: as the one identity the operator
bound to your module (`runsModules`, by its package.json name), which must be
granted the target device, and only to targets your module declared in
`countinghouse.calls`. The hop is **billed** to `ctx.caller`, so per-hop cost
lands on whoever called your tool rather than on your module. A module never
names the identity: `as` is refused since R2-1 with "identities come from the
operator's runsModules binding; remove `as`", and a module with no binding
gets `CTX_CALL_UNBOUND`. A module that needs two identities is two modules.

`pre-installed-packages/composite-demo` stays on `ctx.serviceClient`
deliberately, so both paths keep a live example and test coverage; see
[`composite-tools.md`](composite-tools.md#every-composing-module-needs-its-internal-identity-granted).

## Calling a remote MCP server

A module can call one remote MCP server, the user's own GitHub for
example, without ever holding the user's credential. The runtime's main
thread connects to the server, adds the credential the operator allowed,
and hands the module the server's answer.

Declare it in `package.json`. The shortest declaration:

```json
"countinghouse": {
  "remotes": [
    {"name": "github", "url": "https://api.githubcopilot.com/mcp/", "credential": "GITHUB_TOKEN"}
  ]
}
```

`"credential": "GITHUB_TOKEN"` means `{"env": "GITHUB_TOKEN"}`, with the
header `Authorization` and the scheme `Bearer`; `transport` defaults to
`"streamable-http"`. The load keeps the expanded form, and
`countinghouse-validate` prints it for every remote, with where its
credential goes:

```
remote github: {"name":"github","transport":"streamable-http","url":"https://api.githubcopilot.com/mcp/","credential":{"env":"GITHUB_TOKEN","header":"Authorization","scheme":"Bearer"}}
  sends the credential GITHUB_TOKEN to https://api.githubcopilot.com as "Authorization: Bearer <value>"
```

The full form:

```json
"countinghouse": {
  "remotes": [
    {
      "name": "github",
      "transport": "streamable-http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {"X-MCP-Toolsets": "actions,repos"},
      "credential": {"env": "COUNTINGHOUSE_GITHUB_TOKEN",
                     "header": "Authorization", "scheme": "Bearer"}
    }
  ]
}
```

- `name`: lower-case letters, digits and `-`, starting with a letter. It
  is the name in the address below.
- `transport` (optional): `"streamable-http"`, the only one and the default.
- `url`: `https:`, with no user info and no fragment. `http:` is accepted
  only for a loopback host under `--debug`, for local testing. A loopback
  or private address, or the Redis endpoint, is refused.
- `headers` (optional): static, non-secret headers, sent as written on
  every request. A secret goes only through `credential`. The
  credential's header, hop-by-hop headers and the headers the transport
  sets itself (`Host`, `Content-Type`, `Accept`, `Mcp-Session-Id` and the
  like) are refused.
- `credential` (optional): a variable name (the short form), or an
  object: the environment variable to read (`env`; a credential is one
  variable, and a `fallbackEnv` is refused), the header (default
  `Authorization`) and the scheme (default `Bearer`;
  `""` sends the bare value). It is a request, not a grant: the
  operator's `--remoteCredentials` file decides where it may go. Under a
  version 2 file a key is bound to one module, one variable and one
  origin: another module that declares the same variable gets nothing, and
  a version of this module that sends it to another origin, or asks for it
  under another name, gets nothing until it is bound again
  (`REMOTE_CREDENTIAL_NOT_ALLOWED`, saying which).
- The remotes are part of the module's pin: a supervised restart uses the
  remotes the last load, reload or restart took, never a `package.json`
  changed since.

One remote per module in this version. `countinghouse-validate` reports a
declaration problem by position and field, and the load refuses the
module with `REMOTE_DECLARATION_INVALID`.

Call it from a handler:

```js
const result = await ctx.call('remote:github/actions_list', {method: 'list_workflow_runs', owner, repo});
// result: {content: [{type: 'text', text}], isError?, structuredContent?}
```

The result is the MCP `CallToolResult` as the server sent it, with nothing
parsed and nothing stripped. A tool's own error (`isError: true`) is a
result, so the module can read its text. Only a failure to get an answer
rejects, with a code:

| Code | When | Retryable |
|---|---|---|
| `REMOTE_UNREACHABLE` | DNS, connection or TLS failure, a redirect to another origin (refused; one within the same origin is followed, at most 5), a 502 or 503, or the module was reloaded during the call | yes |
| `REMOTE_TIMEOUT` | no answer within `--remoteTimeout`, or a 504 | yes |
| `REMOTE_AUTH_FAILED` | the server answered 401 or 403; the message names the variable, never its value | no |
| `REMOTE_PROTOCOL` | an answer that is not valid MCP | no |
| `REMOTE_RESULT_TOO_LARGE` | an answer over `--remoteMaxBytes` | no |
| `REMOTE_ADDRESS_REFUSED` | the host resolves to a loopback, private or Redis-endpoint address | no |
| `REMOTE_UNDECLARED` | the module declares no remote by that name | no |
| `REMOTE_ARGS_INVALID` | not an address `remote:<name>/<tool>`, or the arguments are not a plain JSON object | no |
| `REMOTE_CREDENTIAL_NOT_ALLOWED` | the operator's file does not allow the variable for this origin (version 1), or binds no key to this module for this origin and variable (version 2); the remote is disabled | no |
| `REMOTE_CREDENTIAL_MISSING` | the variable is allowed but was not set when the module loaded | no |

A remote needs no `net` permission: the connection is the main thread's,
and the module never sees the credential, the socket or any header. Each
call is metered to the outer caller as an inner hop, and counted in the
usage records and the receipt under the outer `tools/call`
([`module-authoring.md`](module-authoring.md#the-receipt-and-the-usage-report)).
Make it before your handler answers: once a part has answered, the call is
no longer its own, and a remote call made then is refused
`USAGE_CALL_FOREIGN`. The server's tools/list is taken at load and recorded with a hash in the log. It
refuses nothing in this version: a tool missing from it is called all the
same.

## Troubleshooting: my module doesn't appear in `tools/list`

Work down this list in order. Every case below now logs an explicit error —
**check the server log first**, it very likely already names the cause.

### 1. The log says `MODULE_LAYOUT_UNSUPPORTED`

```
my-module: a module is api.json, schema.json and handlers/<service>/<action>.js; this one has package.json "main": "device.js" and no handlers/ directory. See docs/module-development.md.
```

The module has a main entry (`package.json` `"main"`, or an `index.js`) and no
`handlers/` directory: the retired format (see
[Retired: main entries and dynamic discovery](#retired-main-entries-and-dynamic-discovery)).
None of its code was run. Move each action into
`handlers/<service>/<action>.js` and remove the main entry (for a 5.x
module, `npx countinghouse-migrate-module ./my-module` does it).

### 2. The log says `DEVICE_SPEC_VALIDATION_FAIL`

```
Device spec validation failed: my-module stage=validateDeviceSpec -- 2 schema error(s):
  /device must have required property 'modelDescription' | /device/serviceList/urn:.../actionList/0 must have required property 'name'
```

Your `api.json` doesn't satisfy the meta-schema. Each error gives the JSON
pointer (`instancePath`) into your spec and what is wrong there, and **all**
errors are reported, so you can fix the spec in one pass. Common causes:
missing `device.modelDescription`, an action without a `name`, an
`actionList` that is still an object rather than an array.

### 3. The log says `MODULE_NO_DEVICE_ONLINE`

The device assembled from your `api.json` failed its interface check: an
earlier error on the device was recorded, and the message quotes it.

### 4. The log says `MODULE_ASSEMBLY_FAIL` with `stage=schemaSafety`

Your `schema.json` is one the validators will not compile: too large, a
pattern that can backtrack catastrophically, or `$ref`s that expand too far,
refer to themselves or name no place in the file. The message names the
schema path; see [`schema.json`](#schemajson) for the limits. A call refused
`VALIDATION_TIMEOUT` was not validated in time, or its validator stopped: a
schema that passed these checks but still takes too long to compile or to
validate a value, or a machine too busy to run the check. If checking a
module's output, or compiling its schemas, does not finish three times in five
minutes (a validator that ends while compiling them for a call counts too), its
calls are refused with `VALIDATION_QUARANTINED`; a wait in the queue, an input's
check and a call that waits for a compile don't count by themselves.

### 4b. The log says `MODULE_ASSEMBLY_FAIL` with `stage=declarations`

Something your module declares breaks a rule a schema cannot express: a
binary output field under `oneOf` or behind a `$ref`, `x-mcp-header` in an
input schema, a resource whose variable is no input property, a prompt whose
`{{name}}` is no argument. The message names the action (or the prompt) and
says what to change. The load stops at the first one; run
`npx countinghouse-validate ./my-module` to see every one, with the warnings.

### 5. The log says `LOAD_MODULE_FAIL`

A handler file threw while being required — a syntax error, a missing
`require`, a bad path in `CHUtil.loadFile`. The message names the handler
file (`handlers/<service>/<action>.js`) and its error; the worker is ended
and the module is not loaded.

### 6. The log says `MODULE_LOAD_TIMEOUT`

Your module did not finish loading within the operator's
`--moduleLoadTimeout` (120 s by default), and its worker was ended. Something
your module runs while it is required never returns: a busy loop, an
`Atomics.wait`, a synchronous read that never ends. Do that work in an action,
or start it asynchronously after load.

### 7. No error at all, and the module is listed as loaded

Then the device did come online, and the problem is downstream:

- **An action is missing from `tools/list` while others from the same module
  appear** → that action has no `description` in `api.json`. Actions without
  one are skipped deliberately (`description` is what an LLM reads), and this
  is logged at info level: `action ... has no description, skipping`.
- **The whole module's tools are missing for one apiKey but present for
  another** → `tools/list` is filtered per apiKey. That key isn't granted the
  device. See [`authentication.md`](authentication.md).
- **Nothing is missing, but the schemas look empty** (`{"type":"object",
  "properties":{}}`) → the schema fetch failed and fell back to a permissive
  default. Server-side validation still enforces the real schema, so calls
  with wrong arguments are still rejected; but the LLM is flying blind. Check
  that `schema.json` resolves and each action's `input`/`output`/`fault`
  pointers are right.

### Verifying a module without starting a server

```sh
npx countinghouse-validate ./my-module
```

Checks `api.json`, `schema.json` and the handler map against each other, what
the module declares for MCP clients (stage `declarations`) and its icon
files, and prints every problem it finds, each naming the stage and the way
out. Exit
codes: `0` clean, `1` problems found, `2` the path could not be read. No
Redis and no server required.

`countinghouse-validate` is the way to check a module: it reports every
problem in one pass. A running framework never loads a module that fails a
check (8.0.0 removed `--verifyModule`, which made it continue past one); start
it with `--loadModule ./path/to/my-module` to see the module load, and read
the log's stage when it is refused.

### Letting an agent write the module

Full reference for the authoring toolchain — the four tools, the loop, the
security boundary and its known limits — is in
[`module-authoring.md`](module-authoring.md).

Start the runtime with `--authoringTools` and an admin key, and a coding
agent can validate a design, write the module, validate it, load it and call
it without a human editing JSON. The four tools are
`countinghouse_validate_plan`, `countinghouse_validate_module`,
`countinghouse_load_module` and `countinghouse_call_tool`; they are admin-only
and absent from `tools/list` unless the flag is set. Keep the default worker
mode: `countinghouse_load_module` runs a module's main entry in the runtime,
and worker mode is what turns a crash or `process.exit()` there into a
reported failure. Under `--no-workerThread` the same crash takes the whole
server down.

The repo ships the skill that drives them at
`.claude/skills/countinghouse-module/SKILL.md`.

## The callback form (deprecated, removed in 7.0.0)

Before 6.0.0 a handler took a Node-style callback. That form still works, and
every 5.x handler keeps running unchanged:

```js
module.exports = (input, ctx, callback) => callback(null, {output: {...}});
```

**It is deprecated and will be removed in 7.0.0.** Write new handlers as
`async (input, ctx)`; the migrator converts old ones for you
(`npx countinghouse-migrate-module ./my-module`).

Which form you are using is decided by what the handler *returns* — a thenable
is awaited, anything else waits for the callback — so both can coexist in one
module while you migrate.

One difference worth knowing while both forms are in play: an *untyped* error
resolves differently by route. `callback(new Error('boom'))` becomes
`DEVICE_INVOKE_FAIL` ("I am reporting a failure"), while `throw new
Error('boom')` becomes `DEVICE_INVOKE_EXCEPTION` ("I crashed"). A module's
own error (`ctx.error`) keeps its code either way, which is the reason to use
one.
