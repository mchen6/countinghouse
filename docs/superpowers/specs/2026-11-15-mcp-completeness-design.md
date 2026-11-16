# MCP 2026-07-28 completeness: a thin layer over the module contract

Status: approved by the maintainer, 2026-11-15 (see "The maintainer's decisions"). Revision 2, 2026-11-15, against countinghouse master af9487a4. Revision 2 applies the reviewer's amendments: cancelling a call (section 13) and output schemas of any JSON value (section 14) move in, `x-mcp-header` is refused by validate, the result store's default under Redis is smaller, a handler's own progress is reported, and the breakdown is re-totalled. No code yet.
It covers countinghouse (the gateway, the validator, the store) and, for section 10 only, ch-local (the shim relay and the acceptance tests).
Issues: #239 (tasks extension), #232 (closed: what release 1 did before this), #231 (subscriptions/listen), #229 (eras).

## Intent

A countinghouse module is JSON in, JSON out, checked against its schemas. Today the gateway turns that into one MCP shape only: a text block, plus `structuredContent` when the action has an object output schema. The rest of MCP 2026-07-28 is missing: binary content, resource links, resources, tool metadata, pagination, progress, prompts, completion, elicitation from a module, tasks for modern clients, cancelling a call in flight, and structured output that isn't an object.

The maintainer's decision is that all of it ships in release 1, and that none of it becomes a protocol API for modules. A module keeps declaring things, in standard JSON Schema 2020-12 keywords and in `api.json`. The gateway derives every MCP feature from the declaration. One `ctx` call is added, for asking the user a question, because a question can't be derived from an output.

## Goals

- Every gap listed below is closed for 2026-07-28 clients on HTTP, `--stdio` and the shared runtime.
- A module that declares nothing new behaves, and is listed, exactly as today. `tools/list` for today's modules is byte-identical.
- The output schema stays the guarantee. A module's output is validated against the module's own schema before the gateway reshapes anything, and a binary field is checked as binary.
- Access control and metering hold on every new path: each list is filtered per key, and each read or call is authorized, rate limited and recorded.
- `ctx.call` composition and HTTP `invoke-action` keep `{output}` unchanged.
- No key, user name or secret reaches a module, a log line, an error text, a URI or a cursor.

## Non-goals

- **Sampling and roots are not built.** Both are deprecated in 2026-07-28. Roots would hand a module `/home/<user>` paths, against the rule that a third-party module author knows nothing about the identity of the user. Sampling spends the user's model on a module's behalf. The gateway never puts `sampling/createMessage` or `roots/list` in an `inputRequests`.
- **URL-mode elicitation.** A third-party module never sends the user to a URL. Only form mode is offered.
- **BSON.** It's being retired separately (`application/bson` gets 415). Binary travels as base64, as MCP has it.
- **A new module API for progress, resources, prompts, tasks or cancellation.** Each is derived (sections 3, 6, 7, 9, 13). A handler's progress uses the call it already has, `ctx.job.progress` (section 6).
- **Prompts whose messages come from module code**, and prompt messages with image or resource content. Release 1's prompts are declared text (section 7).
- **A question asked from inside a task,** unless the maintainer takes open question 5. Without it, `ctx.ask` in a task run answers `ASK_UNAVAILABLE` (section 8).
- **Resource change notices across keys.** An update is announced to the caller's own subscriptions only (section 3).
- **Legacy `resources/subscribe` and `resources/unsubscribe`.** 2026-07-28 removed them, and the legacy era never had them here.
- **The legacy HTTP+SSE transport** (a GET stream). Unchanged: 405.

## Anti-goals

- No protocol vocabulary in a handler. A handler never builds a content block, a resource, a task or a progress notification, and never sees a cursor, a progress token or a `requestState`.
- No second validation path. Nothing the gateway sends as `structuredContent` or as a block skips the validator.
- No state the transport would need to be sticky for. A retry, a page or a read may land on any runtime process that shares the store and the identity secret.
- No media type, URI, annotation or dialog text chosen by a module at call time. Each is fixed in the module's reviewed files. A dialog's text is the declared sentence with bounded values filled in (section 8).
- No silent degradation. A declaration the gateway can't honour is a `countinghouse-validate` problem and a refused load, never a field quietly treated as a plain string.

## What master does today

Verified on origin/master af9487a4 with `git show`, not the working tree.

| Fact | Where |
|---|---|
| A module result is one text block; with an object output schema it's also `structuredContent`. No other block type exists. | `lib/mcp/gateway.js:272-282` |
| An output schema is advertised only when it resolves to `type: "object"`; the code's own comment gives the reason as the rule of the revisions it was written for. Every bundled action's output schema is an object: the 23 tools of the golden list, the 9 of `examples/`, the 5 of `perf/`. | `lib/mcp/tool-registry.js:464-471`, `:496-504` |
| `tools/list` returns every tool in one answer, with `name`, `description`, `inputSchema` and `outputSchema` only. It reads no cursor. | `lib/mcp/tool-registry.js:602-627`, `lib/mcp/gateway.js:246-262` |
| Lists are filtered per key by the auth provider's devices, and by listing rules (parts, the single-identity profile). | `lib/mcp/tool-registry.js:575-591`, `:270-278` |
| An action object in `api.json` is closed (`additionalProperties: false`): `name`, `description`, `input`, `output`, `fault`. | `spec/schema.json:125-190` |
| `contentEncoding` and `contentMediaType` are accepted and assert nothing (ajv's metadata vocabulary). No bundled schema uses them. | `lib/validator.js:2-5`, `node_modules/ajv/dist/vocabularies/metadata.js` |
| A worker's output crosses as V8-serialized bytes. A Buffer arrives as a `Uint8Array`, which `JSON.stringify` writes as `{"0":1,"1":2,…}`. In single-thread mode a Buffer is written as `{"type":"Buffer","data":[…]}`. Where the schema types the field as a string, validation already refuses both. | `lib/serialized-result.js:10-13`, `lib/device-manager.js:1456-1462` |
| The output cap is measured on the serialized output, first in the worker, then on the main thread, which is the guarantee. The default is 16 MiB. | `lib/lean-worker.js:344-366`, `lib/device-manager.js:1437-1444`, `lib/cli-options.js:292` |
| Output validation runs in a validator worker on the bytes; the main thread compiles no module schema. | `lib/device-manager.js:1456`, `lib/mcp/gateway.js:1220-1226` |
| A call is billed on success under `encodeLegacyTool(deviceID, serviceID, actionName)`, the same record on every entry path. | `lib/mcp/gateway.js:1023-1037` |
| Modern results get `resultType`; `tools/list` gets `ttlMs: 0` and `cacheScope: "private"`. | `lib/mcp/gateway.js:1348-1357` |
| `subscriptions/listen` is served on HTTP (SSE on the POST), stdio and the session transport. It agrees to `toolsListChanged` only. Limits: 8 per key, 2 per session, 512 in all. | `lib/mcp/gateway.js:172-220`, `lib/mcp/subscriptions.js:17-23`, `lib/routes/mcp.js:42-69`, `lib/route-manager.js:374-378`, `:565-566` |
| The settings tool is the only user of `input_required`. Its `requestState` is a nonce and an HMAC under a per-start key, bound to session, setting and value, with a 120 s life and single use enforced server-side. It is read from `params`, never from `arguments`. | `lib/settings-confirm.js:23-133`, `lib/mcp/gateway.js:812-855` |
| The elicitation capability is read per request: `{}` or a `form` key. | `lib/elicitation-clients.js:77-81`, `lib/sessions.js:107-120` |
| A call token lives as long as its call, is bound to one worker, and has a 1 h backstop. A hop's token chains to its outer call's. | `lib/call-tokens.js:13-25`, `:40`, `:49-78` |
| `ctx.caller` is `{id, isAdmin}` with an opaque id. `ctx.job` is null outside a task; inside one, `ctx.job.progress(0..100)` reaches `JobControl.updateJobProgress`. Nothing reads that progress back for a client. | `lib/handler-ctx.js:44-50`, `:185-190`, `lib/countinghouse-util.js:302-315`, `lib/device-manager.js:314-317`, `lib/job-control.js:512-518`, `:571-575` |
| Legacy tasks: `params.task` makes a job; `tasks/get`, `result`, `list`, `cancel` map onto job control; only under `--workerThread`. Task ids are the job runner's own: the local runner's count up from 1, and the Redis runner keeps BullMQ's own ids, except for a job made in a shared runtime's session, which already gets a random one (`s-` and 24 hex). For a modern request `params.task` is ignored, `tasks/*` is unknown, and discover advertises none. On a shared runtime `tasks/*` is refused. | `lib/mcp/gateway.js:57-59`, `:136-145`, `:962-966`, `:1045-1312`, `:1321-1322`, `:1397-1401`, `lib/job-control-local.js:53`, `lib/job-control.js:326-335` |
| The store decides where state lives: Redis by default, files and memory under `--store local`. The local kv is one JSON file written whole every 5 s. | `lib/store.js:58-140`, `lib/local-kv.js:11-16`, `:28` |
| The opaque caller id is `u_` plus an HMAC under the identity secret, which is a file or an environment variable, stable across restarts. | `lib/identity.js:1-19` |
| On the shared runtime the shim relays bytes. An answer carries its request's `seq`; a notification is a headerless frame (`s.notify`) the shim writes as it comes. The runtime sends the client no requests. | `docs/superpowers/specs/2026-11-15-shared-runtime-design.md` section 1, `lib/session-transport/session-listens.js:1-6` |
| `notifications/cancelled` is honoured for a listen only, not for a call in flight. The HTTP route doesn't watch a POST for its client leaving, except on a listen's stream. | `lib/route-manager.js:364-365`, `:546`, `lib/routes/mcp.js:50-57` |
| A call's token is dropped when the call answers or its timeout passes, and dropping it drops every hop's token under it. A hop, a device query, a remote call or a peer invoke that cites a dropped token is refused `CALL_TOKEN_INVALID`. | `lib/device-manager.js:1350-1355`, `:1596-1599`, `lib/call-tokens.js:100-120` |
| A call's usage record counts its text blocks only. | `lib/usage/receipt.js:38-41` |

## The layer at a glance

Everything new a module can declare. Each field is optional, and a module without it is unchanged.

| The module declares | Where | The gateway derives |
|---|---|---|
| `contentEncoding: "base64"` with `contentMediaType` on an output field | `schema.json` | an image, audio or resource block; a resource link past the threshold (sections 1, 2) |
| `resource: {uriTemplate, …}` on an action | `api.json` | `resources/list`, `resources/templates/list`, `resources/read`, change notices (section 3) |
| `title`, `annotations`, `icons` on an action | `api.json` | the same fields on the tool (section 4) |
| `promptList` on the device | `api.json` | `prompts/list`, `prompts/get`, `completion/complete` (section 7) |
| `enum` and `examples` on an argument's schema | `schema.json` | completion values (section 7) |
| `questions` on an action, and `ctx.ask(name, values)` in its handler | `api.json`, handler | `input_required` with a form (section 8) |
| `longRunning: true` on an action | `api.json` | a task, for a client that declares the tasks extension (section 9) |
| an output schema of any JSON type | `schema.json` | `outputSchema` and `structuredContent` for it, for a modern request (section 14) |
| nothing new: `ctx.job.progress(n)`, the call a task's handler already has | handler | the handler's own progress on the call's stream (section 6) |
| nothing | | pagination, hop progress and cancellation (sections 5, 6, 13) |

**Which era gets what.** The plain request and response features (blocks, links, resources, prompts, completion, tool metadata, pagination) are served to legacy (`initialize`) and modern requests alike, as `tools/list` and `tools/call` are today. Progress is sent to any request that carries a progress token. `input_required`, the tasks extension, non-object structured output and cancel-by-disconnect are modern only; legacy tasks stay as they are.

```json
{ "name": "render", "description": "Renders a chart of the given series.",
  "title": "Render chart",
  "annotations": {"readOnlyHint": true, "openWorldHint": false},
  "icons": [{"file": "icons/chart.png", "sizes": ["48x48"]}],
  "longRunning": true,
  "questions": {"overwrite": {"message": "Replace the saved chart {name}?", "schema": "/chartService/render/questions/overwrite"}},
  "input": {"schema": "/chartService/render/input"},
  "output": {"schema": "/chartService/render/output"} }
```

## 1. Content blocks from the output schema

**The declaration.** An output field is binary when its schema is `{"type": "string", "contentEncoding": "base64", "contentMediaType": "<type>/<subtype>"}`. Both keywords are 2020-12's. The media type is fixed in the schema, so a module can't choose it per call.

**Where a binary field may sit.** The gateway finds binary fields by walking the output schema from its root through `properties` and array `items` only, at most 8 levels deep. A binary declaration anywhere else (under `oneOf`, `anyOf`, `allOf`, `if`, `patternProperties`, `additionalProperties`, or with a union type) is a `countinghouse-validate` problem and a refused load. The walk never follows `$ref` (the reviewer's ruling in M3, 2026-11-15): a binary declaration reached only through a `$ref` counts as anywhere else, refused the same way, with a message saying to declare the field inline under `properties` or `items`. So the map is deterministic and needs no resolver. At most 16 binary fields may be declared per action, and one result may hold at most 16 binary values (an array counts each item); more is refused with `TOO_MANY_BINARY_VALUES`.

**Validation still holds, and gains one check.**
- The module's output is validated against the module's own schema, where it is today and before the gateway reshapes anything.
- `contentEncoding: "base64"` becomes an assertion in countinghouse's validator: the value must be canonical RFC 4648 base64 (the standard alphabet, padded, no whitespace). It applies to inputs too, so a client's binary argument is checked the same way. It runs in the validator worker, so it holds on every path: `tools/call`, a hop, `invoke-action`, a job.
- The gateway doesn't sniff the bytes. The media type is the module's reviewed claim, and a client treats a block as untrusted content, as the spec asks.

**What the client gets.** With an object output schema, in this order:
1. A text block: the JSON of `structuredContent` (below), as today.
2. One block per binary value, in schema order:
   - `image/*` becomes `{type: "image", data, mimeType}`;
   - `audio/*` becomes `{type: "audio", data, mimeType}`;
   - anything else becomes `{type: "resource", resource: {uri, mimeType, blob}}`, and its bytes are stored so the `uri` can be read (section 2);
   - a value past the inline threshold becomes a `resource_link` instead (section 2).
3. The receipt sentence and notices, appended as today.

**`structuredContent`.** Sending the bytes there as well would triple them on the wire (text block, `structuredContent`, block). So the gateway substitutes each binary value with a fixed reference object, and advertises that shape:

```json
{"type": "object", "additionalProperties": false, "required": ["mimeType", "bytes"],
 "properties": {"mimeType": {"type": "string"}, "bytes": {"type": "integer", "minimum": 0},
                "block": {"type": "integer", "minimum": 0}, "uri": {"type": "string"}}}
```

- `block` is the index into `content` of an inline block; `uri` is set for a stored value. `bytes` is the decoded length.
- The advertised `outputSchema` is the module's schema with each binary field's subschema replaced by that shape, keeping the field's `title` and `description`. `tools/list` and `tools/call` derive it from one function (today's `resolveOutputSchema`), and the task result's schema hash is taken over it.
- `structuredContent` conforms to the advertised schema by construction. A contract test checks it with ajv for each fixture, and the SDK conformance test (`test/mcp-contract/03`) checks it from the client's side.
- No bundled module uses the keywords, so the golden list doesn't move.

**A whole output that is binary.** An action whose output schema is itself a binary string follows the same rule once section 14 lifts the object-only limit: its advertised `outputSchema` is the reference shape, `structuredContent` is the one reference, and the block follows the text block. For a legacy request, which gets no `outputSchema` for a non-object schema, the answer is the one block and no text block.

**Where the bytes count.** The cap counts the module's output as the module returned it, base64 included, in its worker and again on the main thread, as today. A binary field so costs four thirds of its size. Nothing is stored or inlined from an output that failed the cap or the validator. The reshaped result is never larger than today's would have been for the same output, so the shared runtime's frame bound holds unchanged. The usage record gains the inline and the linked byte counts beside its text bytes.

**A Buffer is not JSON.** Today a Buffer in an output is silently mangled, differently in each mode (the table above). From now on an output holding a Buffer, a typed array or an ArrayBuffer is refused with `OUTPUT_NOT_JSON`, naming the field and saying to return `buf.toString('base64')` in a declared binary field. The friendly check is in the module's worker, where the serializer can be made to flag a view as it meets one (to confirm in M3), so a call with none pays nothing. The validator's type check remains the guarantee for a typed field.

Encoding a Buffer for the author was considered and rejected: the output would grow by a third after the worker's cap check, the validator would have to re-serialize it, and one field would have two forms across `ctx.call`.

**Unchanged:** `ctx.call` and `invoke-action` return `{output}` with the base64 string in place. No block, no link and no substitution happens there.

## 2. Resource links

**The threshold.** `--inlineContentBytes`, default 1 MiB of decoded bytes, is a budget per result. Binary values are taken in schema order; each one that fits the remaining budget is inlined, and the rest are stored and linked. `0` links everything. It's an operator option, not a session setting.

Why 1 MiB:
- an inline block enters the client's model context on every call, and a link is fetched only when wanted;
- screenshots and charts, which are tens to hundreds of kilobytes, stay inline, so image tools work with clients that don't follow links;
- a result line stays near 1.4 MB at most beyond its JSON, far under every transport bound.

**The link.** `{type: "resource_link", uri, name, description, mimeType}`: `name` is the field's property name, `description` the field schema's, `mimeType` the declared one. The reference object in `structuredContent` carries the same `uri`.

**The URI is `countinghouse://r/<id>`**, where `<id>` is 32 random bytes in base64url. It names nothing: no key, user, session, module, tool or time. The `r` segment is the runtime's, and module resources use `m` (section 3), so the two never collide.

**The stored resource.** `{id, owner, session, mimeType, bytes, sha256, createdAt, expiresAt, source: {module, tool, field}}` and the bytes. `owner` is the opaque caller id (`u_…`), never the key. `session` is the shared runtime's session id, or null.

**Where it lives: a new part of the store, `blobs`** (`lib/store.js`), with two implementations, as every other part has.
- **`--store redis`:** a metadata hash and a binary string per resource, in a database of their own, each with the retention as its expiry. Redis, because an HTTP deployment can run more than one runtime against one Redis, and a read must work on whichever process receives it.
- **`--store local`:** two files per resource under `<storePath>/resources/`, owner-only (0700 and 0600; `lib/win-acl.js` on Windows), swept at start and every 10 minutes. Files, because the local kv is one JSON file rewritten whole every 5 s, which megabytes of base64 would make unusable. Files also survive a runtime restart, which a resumed session on the shared runtime needs.

**Access.** A read is served only when the caller's id equals `owner`, and, where the record has a session, the request's session is that one. An admin key gets no wider access: the content is a tenant's result, and an operator who needs it has the store. An unknown, expired or foreign URI is answered identically: -32602, "Resource not found", never an empty `contents`.

**Retention.** `--resourceRetention`, default 24 h, from 1 minute to 7 days. A session's stored results also end with the session (its `bye`, or its reconnect window expiring), as its partition does. Stored results are immutable. They never appear in `resources/list`, which the spec allows.

**Limits.**
- One stored value is bounded by the output cap (three quarters of it, decoded).
- Across all owners: `--resourceStoreBytes`. Its default follows the store:
  - **512 MiB under `--store redis`.** An operator's Redis is shared memory: it also holds metering, jobs and the modules' own keys, and an eviction or an out-of-memory there hurts all of them. A 4 GiB default would surprise an operator who never asked for a result store.
  - **4 GiB under `--store local`,** where the bytes are files on the user's own disk.
- Per owner: `--resourceQuotaBytes`, default 128 MiB under Redis and 256 MiB for local files, and `--resourceQuotaItems`, default 1024. So one caller can't fill the store alone under either default.
- The start line logs the effective limits, and the store's use is in the usage report for an admin.
- Past a limit, the call is refused with `RESULT_STORE_FULL`, naming the limit. Nothing is evicted early, since a link promises its retention.

**Reading.** `resources/read` returns `{contents: [{uri, mimeType, blob}]}`; a `text/*` type whose bytes are valid UTF-8 is returned as `text`. The answer carries `ttlMs` (the time left before expiry) and `cacheScope: "private"`. Each read is rate limited per key, written to the usage records with its bytes, and recorded with the metering provider at `--resourceReadCost`, default 0 (open question 3).

**Tasks.** A task's result is reshaped once, when the job completes, and the stored URIs are kept with the job, so polling never stores the bytes again.

## 3. Module resources

**The declaration.** An action marked as a resource:

```json
{ "name": "readNote", "description": "One note, as Markdown.",
  "resource": {"uriTemplate": "notes/{id}", "name": "note", "title": "Note", "mimeType": "text/markdown",
               "changesWith": ["notesService.save", "notesService.remove"]},
  "input": {"schema": "/notesService/readNote/input"},
  "output": {"schema": "/notesService/readNote/output"} }
```

- **`uriTemplate`** is a relative path in RFC 6570 level 1: literals and `{name}` only, at most 256 characters and 8 variables. The gateway forms the full URI: `countinghouse://m/<module>/<path>`, where `<module>` is the module's slug as tool names use it. A module never writes a scheme or an authority.
- **Each variable** is a property of the action's input schema, of type string. Validate checks that they match, both ways for required properties.
- **A template without variables** is a static resource, listed by `resources/list`. One with variables is listed by `resources/templates/list` with its `uriTemplate`. `name`, `title`, `description` (the action's when absent), `mimeType` and `icons` pass through.
- **A resource action is not also a tool.** Resources are picked by the application and tools by the model, and listing one action twice would spend the model's context on it. An author who wants both declares two actions over one function. `ctx.call` and `invoke-action` still reach the action.

**Reading.**
1. The URI is parsed strictly: the scheme, `m`, a loaded module's slug, then a path matched against that module's templates. A variable matches unreserved characters and percent-escapes only, so it never spans a `/`. It's percent-decoded as UTF-8, fatally; a NUL or another control character is refused.
2. The variables become the action's input, which is validated against its input schema like any call's.
3. The call is authorized for the key, rate limited, run, and its output validated, exactly as a `tools/call` on that action.
4. The output becomes one entry in `contents`, under the URI that was asked for:
   - a string output becomes `text`, with the schema's `contentMediaType`, else the declared `mimeType`, else `text/plain`;
   - a binary string output (section 1's declaration) becomes `blob` with its media type;
   - any other output becomes `text` holding its JSON, as `application/json`.
5. A handler's error becomes -32603 with `countinghouse/code` in `data`. A URI that matches nothing, a module that isn't loaded, a device the key isn't granted and a module not listed to the caller are all the same -32602 "Resource not found".

**Metering.** A read runs the action, so it's recorded as that action's call, at the tool-call cost, under the same metering identity a `tools/call` would use (open question 3).

**Per-key filtering.** Both lists use the tool list's rules: the key's devices, then the listing rules. In the single-identity profile only a scenario's resources are listed.

**Change notices,** on `subscriptions/listen`:
- **`resourcesListChanged`.** The hub keeps a fingerprint of each listener's resource lists, as it does for tools, and sends `notifications/resources/list_changed` when a settled change moves it.
- **`resourceSubscriptions`** (URIs). The gateway can't know when a module's data changed, and a module has no API to say so. So the declaration says it: `changesWith` names the actions of the same module whose success may change this resource. After such a call succeeds, each subscription that names a URI of that resource gets `notifications/resources/updated`, coalesced per URI over the hub's 250 ms settle. It's coarse, which is fine: the notice only says "read again".
- **Scope.** An update goes only to subscriptions of the key that made the changing call. A module that keeps data per caller would otherwise tell one tenant when another was active.
- **Bounds.** At most 64 URIs per listen, each at most 2048 bytes. A URI the caller couldn't read is left out of the acknowledged filter, which is what the spec gives an unsupported entry.
- Discover declares `resources: {listChanged: true, subscribe: true}` where the transport serves a listen stream, else `resources: {}`.

**Caching hints** on the lists and on a module read: `ttlMs: 0`, `cacheScope: "private"`, as `tools/list` has.

## 4. Tool metadata

- **`title`:** a string of 1 to 128 characters.
- **`annotations`:** an object closed to `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`, each a boolean. They're the author's claims. The runtime enforces none of them, and ch-local's install review should show them.
- **`icons`:** at most 4 entries of `{file, sizes?}`. `file` is a path inside the module, to a PNG, JPEG or WebP of at most 16 KiB, read at load. The gateway sends `{src: "data:<type>;base64,…", mimeType, sizes}`.
  - A module never gives an icon URL. A client that fetched one would tell the module's author the user's address, against the identity rule.
  - SVG is refused, since it can carry script.
- **The same fields** apply to a resource (its `icons`) and a prompt (`title`, `icons`).

**Validation.**
- `spec/schema.json` gains every field in this document, each with its bounds, and the action object stays closed. The device object gains `promptList`.
- `countinghouse-validate` adds:
  - icon files exist, are of an allowed type and are within the size bound;
  - `readOnlyHint: true` with `destructiveHint: true` is a warning;
  - section 1's binary rules, section 3's template and variable rules, section 7's prompt rules, section 8's question rules;
  - `longRunning` on a resource action is a problem;
  - `x-mcp-header` anywhere in an input schema is a problem, and the load refuses it too. 2026-07-28 lets a property mirror itself into an HTTP header, with rules a client must enforce. Nothing here designs the server's side, so the keyword is refused until it is, rather than advertised unchecked.
- The load makes the same checks, and is the one that decides.

**The golden rule.**
- A field appears on a tool only when the action declares it.
- New keys are appended after the existing ones (`name`, `description`, `inputSchema`, `outputSchema`, then `title`, `annotations`, `icons`), so an existing tool's bytes don't move.
- `test/mcp-contract/01` and its golden file must pass unchanged, and no task in this spec regenerates the golden.
- A second golden covers a fixture module that declares everything.

## 5. Pagination

For `tools/list`, `prompts/list`, `resources/list` and `resources/templates/list`, in both eras.

- **Order.** Today's order, which is already deterministic: the platform tools, then each listed device's actions in spec order. It isn't re-sorted, so a list that fits one page is byte-identical to today's.
- **Page size.** `--listPageSize`, default 250 items, from 10 to 1000. The bundled modules list 23 tools, so nothing existing gains a `nextCursor`. A client can't choose the size, as MCP has it.
- **The cursor** is opaque: base64url of a small versioned JSON naming the list kind and the last item's name (for a resource, its URI). It's at most 512 bytes.
  - It's a keyset, not an offset. Packs change in place, and an offset would skip or repeat items silently. A keyset resumes after an item that is still there.
  - It isn't signed. The server derives and filters the caller's own list again on every page and uses the cursor only as a position in it. A forged cursor can name only an item in the caller's own list. A name that isn't there, another list's cursor and a malformed one all get the same -32602, so it's no oracle. Per the MRTR page's own rule for client-held state, integrity protection is needed only when tampering can do worse than fail the request.
  - An anchor that has gone (its module unloaded between pages) is -32602, and the client lists again; `list_changed` has told it to.
- **`nextCursor`** is omitted on the last page.
- **Cost.** A page resolves schemas for its own items only. Today every `tools/list` resolves all of them.

## 6. Progress

Sent only when the request's `params._meta.progressToken` is a string or an integer.

**Sources, with no new module API.**
- **Composite hops.** The main thread already bills each hop and each remote call to the outer call, on both paths: where it forwards a routed hop, and where the broker matches a direct peer invoke's metering request (`lib/peer-channel-broker.js`). Each hop billed under the outer call is a tick: `progress` is the count so far, with no `total`. No `message` is sent, so an unlisted part is never named to the client.
- **The handler's own progress: `ctx.job.progress(n)`, now outside a task too.** It's the call a task's handler already has, with the same argument (0 to 100). Outside a task it's reported as `notifications/progress` with `progress: n` and `total: 100`, on the call's stream.
  - **What changes for authors.** `ctx.job` is no longer null outside a task: it's `{id: null, progress(n), info(cb)}`, and `info` calls back with an error there. A handler that asked "am I a task?" with `ctx.job == null` asks `ctx.job.id == null` instead. `docs/module-development.md` and three test fixtures (`job-snoop`, `key-dump`, `worker-end`) read it the old way and change with it. There are no module authors yet, so nothing else does.
  - **Only the outer handler's reports are sent.** A part's percentage says nothing about the whole call, so a report made under a hop's token is dropped. The main thread decides this from the token, as it resolves everything else.
  - **One increasing sequence.** Hop ticks and the handler's values share the stream, and a value at or below the last one sent is dropped. Once the outer handler has reported, hop ticks stop for that call. A handler's reports after hop ticks are offset by them: `progress` is the tick count plus n and `total` is the tick count plus 100, so a 25% report after 30 ticks is sent as 55 of 130 rather than dropped (the reviewer's ruling on #306). With no ticks before it, a report is n of 100.
  - Without a progress token, over `invoke-action`, and for a legacy HTTP request, the call does nothing, as it does today outside a task.
- **A task's progress.** Inside a task, `ctx.job.progress(n)` is surfaced as the task's `statusMessage` (section 9), not as `notifications/progress`: once the call has answered with the task, its stream is closed, and progress "MUST stop after completion".

**Delivery: on the call's own stream.**
- **HTTP.** The POST's response becomes an SSE stream lazily, when the first notification is due. A call that finishes first is answered as plain JSON, byte for byte as today. The route's stream opener for listens is reused. The final event is the JSON-RPC response, and the stream ends.
- **stdio.** A line before the answer's line (`served.notify`).
- **The shared runtime.** A headerless frame before the answer's frame (section 10).

**Rules.**
- `progress` strictly increases; a value that doesn't is dropped.
- At most one notification per 250 ms per call, the latest value winning, and at most 240 per call.
- Nothing is sent after the answer, an `input_required` result included.
- A token is taken from `params._meta` only, never from `arguments`.
- A client that has gone ends the notifications; the call itself finishes as today.

## 7. Prompts and completion

**The declaration,** on the device:

```json
"promptList": [
  { "name": "triage", "title": "Triage a failing run", "description": "Asks for a triage of one CI run.",
    "arguments": {"schema": "/prompts/triage/arguments"},
    "messages": [{"role": "user", "text": "Triage run {{run}} of {{repo}}. Start with ci_failure_triage."}],
    "completion": {"repo": "triageService.completeRepo"} } ]
```

- **At most 32 prompts per module.** A name is 1 to 64 characters of `[A-Za-z0-9_.-]`. It's listed as `<module>_<name>`, and a scenario's under its bare name, as tools are.
- **`arguments`** points to an object schema in `schema.json` whose properties are all strings, at most 16 of them. `prompts/list` derives each argument's `name`, `description` and `required` from it.
- **`messages`** are declared text: at most 8, each with a role of `user` or `assistant` and at most 8 KiB of text.

**Why a template and not an action's output.**
- It's the thinnest: `prompts/get` runs no module code, so it needs no worker, no billing and no timeout.
- A prompt goes straight into the user's model. Text that the operator reviewed at install is the safe default; text a module computes per call would be an injection channel.
- An action-backed prompt can be added later behind its own declaration.

**`prompts/get`.**
1. The prompt is found in the caller's own filtered list. Otherwise it's -32602, the same as for an unknown name.
2. `arguments` is validated against the schema. A failure, a missing required argument included, is -32602.
3. Each `{{name}}` is replaced by that argument's value, once; substituted text is never scanned again. An absent optional argument is the empty string. The result is at most 64 KiB, else -32602.
4. The answer is `{description, messages: [{role, content: {type: "text", text}}]}`. It's rate limited and counted in the usage records, and not billed.

`prompts/get` never answers `input_required`, since no handler runs.

**Completion.** Discover declares `completions: {}`.
- **`ref/prompt`:** the named argument's schema gives the candidates: its `enum`, then its `examples`.
- **`ref/resource`:** the `uri` must be one of the caller's listed templates, and the candidates come from the input schema property behind the variable.
- **Matching.** Candidates that start with `argument.value`, case-insensitively, come first; then those that contain it. At most 100 are returned, with `total` and `hasMore`.
- **An optional completion action.** `completion: {"<argument>": "<service>.<action>"}`, on a prompt or a resource, names an action of the same module.
  - Its input is `{argument, value, context}`, and its output `{values: string[]}`. Both shapes are fixed, and validate checks the action's schemas against them.
  - It's authorized and rate limited as a call, and held to a 2 s timeout.
  - Its values are bounded: 100 values of 256 characters.
  - If it fails, the schema's candidates are used.
  - A completion action is not listed as a tool.
- **Per key.** A ref the caller isn't listed gets -32602, the same as for an unknown one, so completion can't be used to discover another tenant's prompts.
- **Rate.** Completion is limited per key like any request, and a completion action counts against the same limit.

**`promptsListChanged`** is served by the hub like the other two lists. Discover declares `prompts: {listChanged: true}` where a listen stream is served.

## 8. Module elicitation

**The one `ctx` addition:**

```js
const answer = await ctx.ask('overwrite', {name: input.name});
// the validated content object, or null when the user declined or dismissed
```

It's unavoidable because a question arises in the middle of a handler, from what the handler has found; no output schema can express it.

**Questions are declared, not composed** (open question 2). The action's `questions` in `api.json` gives each question a `message` and a pointer to its schema.
- **The schema** is within MCP's form subset: a flat object of string, number, integer, boolean and enum properties, at most 8.
- **The message** is at most 500 characters, with `{name}` placeholders. `ctx.ask` supplies the values: strings (cut to 200 characters and cleaned of control and bidi characters, as output lines are), numbers and booleans.
- **The runtime composes the dialog:** `<module name>: <message>`, at most 1000 characters. So the sentence a user reads was reviewed at install, and the user sees which third-party module is asking.
- **Limits.** At most 4 questions per action. Validate warns when a property's name or title reads like a credential (password, token, key, secret, card): the spec forbids asking for one in a form.

**How a handler waits across a stateless transport: it runs again.**
1. On the first pass `ctx.ask` has no answer. The main thread records the pending question on the outer call and rejects `ctx.ask` with `ASK_PENDING`, which ends the handler.
2. The gateway answers `input_required`, with one `elicitation/create` form in `inputRequests` and a `requestState`.
3. The client retries the same call with `inputResponses` and the state.
4. The gateway verifies them and runs the handler again from the top. This time `ctx.ask` returns the answer at once.

The contract for authors is one line: **ask first, act after.** Stated plainly, because it costs money and can do damage:
- **Every hop made before the ask is made again on the retry, and billed again.** A handler that calls three parts and then asks pays for six part calls when the user answers. The outer call is billed once, when it completes.
- **A non-idempotent action before an ask happens twice.** A handler that sends a message, writes a record or charges a card and then asks does it once on the first pass and again on the retry. If the user declines, the first one has still happened.
- **`countinghouse-validate` can't detect either.** Whether a handler acts before it asks is a property of its code, which validate doesn't analyse. So the rule is carried by text, in three places that M14 writes: `docs/module-development.md`, `docs/module-authoring.md`, and the countinghouse-module skill (`.claude/skills/countinghouse-module/SKILL.md`), which is what an agent writing a module reads.
- The usage record of a call that asked shows its rounds, so an operator can see a module that asks late.

**Why not keep the handler suspended.** A suspended handler would need all of this:
- a worker's closure held for minutes per pending dialog, with a per-key bound to stop it being a memory attack;
- the call's token to outlive its call, against the rule that it lives as long as its call (`lib/call-tokens.js`);
- the request timer stopped and restarted;
- the retry to reach the same process, and that process not to restart or reload the module meanwhile.

MCP's own description of MRTR is that the retry "does not need any information beyond what is directly present in the retry request". Running again needs no state between the two requests.

**`requestState`.** It's attacker-controlled. Its form is `v1.<payload>.<mac>`.
- **The payload** is base64url JSON:
  - a 16-byte nonce;
  - an expiry, 5 minutes out;
  - the pending question's key;
  - the round;
  - the answers given in earlier rounds, at most 8 KiB.
- **The MAC** is HMAC-SHA256 over a JSON array of:
  - a version label;
  - the payload;
  - the caller's opaque id;
  - the session id, or empty;
  - the method;
  - the tool name;
  - the SHA-256 of the call's arguments in canonical JSON (`lib/mcp/output-schema-hash.js` has the canonical form).

  These are the three bindings the MRTR page asks for: principal, expiry and originating request.
- **The key** is derived from the identity secret with HKDF and a label of its own. So any process that shares the store and the secret can verify a state, and a restart doesn't strand a dialog.
- **Single use** is enforced server-side: the nonce is remembered until its expiry, in the store (Redis `SET NX` with an expiry; memory under `--store local`). Without it, an agent could replay a user's "yes" to a later identical call.
- **Reuse.** The nonce-and-HMAC mechanics move out of `lib/settings-confirm.js` into a shared helper that both use: the canonical-string comparison in constant time, the expiry handling, the used-nonce memory. The settings dialog keeps its own server-held staging, its per-start key and its decline locks, and its behaviour doesn't change; its tests are the guard.
- As for the settings tool, `requestState` and `inputResponses` are read from `params` only. A call whose `arguments` carry either is refused.

**The answer.**
- An `accept` whose `content` validates against the question's schema is the answer. It's validated in the validator pool, since it's a module's schema.
- A `decline` or a `cancel` is `null`.
- A missing or invalid answer gets the same question again, as the spec asks. After 3 rounds `ctx.ask` rejects with `ASK_UNAVAILABLE`.
- The module receives the content object and nothing else: no action, no client name, no session.

**A question's key** is a hash of the module, the action, the question's name and the composed message. An answer applies only to a question with the same text. A handler that asks "Delete A?" and then "Delete B?" gets two dialogs, never one answer used twice.

**When there's no one to ask,** `ctx.ask` rejects with `ASK_UNAVAILABLE`, which a module may catch to fall back. That happens when:
- the request doesn't declare form elicitation in its own `_meta` (the spec: never an input request the client didn't declare);
- the request is a legacy one;
- the call came by HTTP `invoke-action` or `add-job`;
- the handler is running as a task (open question 5);
- the operator set `--moduleQuestions off`.

The tested-client allowlist isn't applied: it guards the runtime's own loosenings, and a module's question loosens nothing.

**Over composition: the question bubbles to the outer client.**
- `ctx.ask` in a worker is a message to the main thread carrying the call's token and the question's name and values.
- The main thread finds the asking module and action from the token entry, never from the message. So a module can ask only its own declared questions.
- It follows the token chain to the outer call, where the answers and the pending question are held for that run only.
- The inner handler ends with `ASK_PENDING`, which rejects the outer handler's `ctx.call`. An outer handler should let it propagate.
- If the outer handler catches it and returns a result, the result stands and the question is dropped.
- On the retry the outer handler runs again and calls the part again, and the part's `ctx.ask` finds its answer.

**An answer is not proof of a person.** A client may answer a form however it likes. So an answer never authorizes anything the caller's key couldn't do without it, and the module docs say so.

## 9. Tasks for 2026-07-28 clients (#239)

The legacy era is unchanged: `params.task`, the four legacy methods, their ids and their capability.

**Which calls become tasks** (open question 1). A modern `tools/call` is answered with a task when all three hold:
- the action declares `longRunning: true`;
- the request's `_meta` capabilities declare `extensions["io.modelcontextprotocol/tasks"]`;
- the runtime can run jobs (`--workerThread`, as `tasksSupported()` has it).

Otherwise the call runs inline, as today, under the request timeout. A legacy `params.task` on a modern request stays ignored. The client never chooses.

**Discover** advertises `capabilities.extensions["io.modelcontextprotocol/tasks"]: {}` when the runtime can run jobs.

**Creating.**
- The gateway authorizes and rate limits as the legacy path does, then adds the job with an id it mints: 128 random bits, the way a shared runtime's session job already gets a random id (`lib/job-control.js:326-335`). The runner's own ids count up, and the extension requires an unguessable `taskId`. The legacy path keeps the runner's ids.
- The answer is sent once the job exists: `{resultType: "task", taskId, status: "working", createdAt, lastUpdatedAt, ttlMs, pollIntervalMs: 2000}`.
- `ttlMs` is the job timeout plus the result's retention under `--store local`. It's null under Redis, where a finished job is kept.

**The methods,** each authorized by owner key, and by session on the shared runtime. Another caller's task and an unknown one are the same -32602.

| Method | Answer |
|---|---|
| `tasks/get` | The task. `completed` inlines `result`: the CallToolResult a synchronous call would have returned, an `isError` result included, built by the code `tasks/result` uses today, with section 1's blocks and the schema-hash rule. `failed` inlines `error`, for a run that left no result: a timeout, a stall, a lost worker. |
| `tasks/update` | An empty acknowledgement. No task is ever `input_required` in release 1, so every key is "not outstanding" and ignored. |
| `tasks/cancel` | An empty acknowledgement. The job is removed, as the legacy cancel does. It's cooperative: a run already in a worker isn't interrupted. |
| `tasks/result`, `tasks/list` | Unknown methods to a modern request, as today. |

- **The capability gate.** A `tasks/*` request that doesn't declare the extension gets -32021, with the extension under `data.requiredCapabilities`.
- **On HTTP,** `Mcp-Name` is the `taskId` for the three methods (`lib/mcp/era.js` `NAMED`).
- **Statuses.** Waiting, delayed and active map to `working`. A finished job maps to `completed`, or to `failed` by the rule above. A cancel removes the job, so the gateway keeps a small tombstone in the store until the task's `ttlMs` (an hour when that's null), and `tasks/get` answers `cancelled` from it, not "unknown".
- **`statusMessage`** carries the job's last `ctx.job.progress` value as `NN%`. For a failed task it's the failure's code, never module text.
- **`notifications/tasks`** on a listen stream that names `taskIds` the caller owns. It's a separate, cuttable task (M16); polling is the default the extension defines.
- **Results** are reshaped once, at completion (section 2).

## 10. The shared runtime and ch-shim

Read against `2026-11-15-shared-runtime-design.md`.

**The shim: one small, optional addition (section 13's `cancelled` control op), and the wire contract stays at 2.** The relay treats lines as opaque.
- **Progress** is a notification: a headerless frame, which the shim writes as it arrives, before the answer's frame.
- **`input_required`** is an ordinary answer on its `seq`. The retry is a new request with a new `seq`. The runtime still sends the client no requests.
- **A resource read** is an answer within the existing frame bound, since a stored value is within the output cap.
- **New listen filters** ride the stream the shim already relays. After a crash the client re-issues its listen, as now.
- **A call in flight when the runtime restarts** gets the crash answer whether or not it was sending progress.

- **A cancelled call** has no answer, which would leave its `seq` in the shim's in-flight table. The runtime sends the control op `cancelled` with that `seq`, and the shim forgets the entry. The contract already says an unknown op is ignored, so an older shim keeps the entry until its connection ends and then writes a crash answer the client ignores. Nothing breaks either way.

One acceptance test in ch-local proves it through the real shim: progress frames interleaved before an answer, an `input_required` round trip, a paged list, and a cancelled call that leaves no in-flight entry.

**The session layers** are where the work is.

| Feature | On the shared runtime |
|---|---|
| The three new lists, and their `list_changed` | Per session, like `tools/list`: a pack one session turned on lists its resources and prompts to that session only. A resource or prompt not listed to a session is answered as unknown, byte for byte. |
| Cursors | A position in the session's own list. Nothing in them is a session id. |
| Stored results | The record carries the session (since M6: the call's session at store time, and `resources/read` checks the request's). Another session of the same user is answered "not found". They end with the session, and survive a runtime restart while it resumes. They live in the local store's files. M17 also removes a call's stored values when its answer could not be delivered (the session ended before it, or the answer was too large for the connection), so undelivered values don't hold the owner's quota until their retention (the review of #313). |
| Module resources of a per-session module (§4a) | Read in the calling session's worker, by the call's token entry, as a hop is. |
| `ctx.ask` | The `requestState` MAC binds the session id. A restored session keeps its id, so a dialog open across a restart still verifies within its 5 minutes. |
| Tasks | By key and session (the shared-runtime plan's B5). Until B5 lands, modern `tasks/*` stays refused there, as the legacy methods are today. |
| Progress | The session's connection. A session that detaches gets none; the call finishes. |
| Cancellation | `notifications/cancelled` names a request of the same session only; another session's id is unknown to it. |
| Validator load | The base64 assertion and the answer validation run in the shared pool, under its per-session fairness. |

**`--stdio`** is one session: every rule above with one id, as today.

## 11. Security

**Identity never reaches a module.** Nothing here adds to what a handler sees.
- A resource read and a completion action get the same `ctx.caller` as a call.
- `ctx.ask` returns the content object only.
- No URI, cursor, progress token, task id, session id or `requestState` is ever passed to a worker. Each is resolved on the main thread.
- New error texts and log lines name the module and the action, never a key or a user name.
- An icon is inlined, so a client never fetches a module author's URL.

**Stored results.**
- **Access.** Unguessable URIs (256 bits) and an owner check and a session check on every read. The URI is a name, not a bearer token: knowing it isn't enough.
- **One answer** for unknown, expired and foreign.
- **Files.** Owner-only, in a directory of the runtime's, never under a module's data path. No module can reach them through the fs broker.

**`requestState`.** Integrity-protected, bound to principal, session, method, tool and arguments, 5 minutes, single use (section 8). A state that fails any check is refused with one code, whatever failed.

**URI injection.**
- A module URI is parsed by one strict function. Anything that doesn't match a loaded template exactly is "not found".
- A variable can't contain a raw `/`, and decoding is strict.
- The decoded value is only ever an input to the action, validated by its schema. The gateway never uses it as a path, a key or a log field.
- A module author who reads files from a variable must guard it themselves, as for any input; the docs say so.
- `countinghouse://r/` and `countinghouse://m/` are the only forms read. Any other scheme is "not found", and the runtime never fetches a URL.

**Dialogs.** Form mode only. The text is the declared sentence with bounded, cleaned values, prefixed with the module's name. At most 3 rounds per call. Rate limited per key.

**Prompt text** is declared and reviewed. An argument is substituted once, as text, and bounded.

**Bounds on every new surface.**

| Surface | Bound |
|---|---|
| A list page | `--listPageSize` items (250); a cursor of 512 bytes |
| Declarations per module | 32 prompts; 8 messages of 8 KiB; 16 arguments; 4 questions per action; 16 binary fields per action; 4 icons of 16 KiB; within `api.json`'s existing 256 KB |
| A result's binary values | 16; an inline budget of `--inlineContentBytes` |
| The result store | per owner 256 MiB and 1024 items; `--resourceStoreBytes` in all; `--resourceRetention` |
| A resource URI | 2048 bytes; 8 variables |
| A resource subscription | 64 URIs per listen, within the hub's existing listener limits |
| Completion | 100 values of 256 characters; a 2 s action timeout; the per-key rate limit |
| A prompt answer | 64 KiB |
| A dialog | 1000 characters; 8 properties; 3 rounds; a state of 16 KiB at most |
| Progress | 4 a second and 240 per call |
| Cancellation | a request of the caller's own connection or session only; an unknown id is ignored; no answer and no error text |
| Every read, get, completion and task method | the per-key rate limit, before any work |

**Audit records.** There's no audit log on master yet; it's the logger roadmap's next phase. Until it lands, each of these is a usage record or an info line. They're listed here so that phase can take them over. None carries a key, a user name, a module's text or an answer's content.
- a result stored (id hash, owner id, bytes, module, tool), read, refused or expired;
- a module resource read (module, action, outcome);
- a question asked, answered, declined, expired or replayed (module, action, question name, round);
- a task created, cancelled or expired;
- a call cancelled (module, tool, how far it had run);
- a `requestState` refused, and a cursor refused.

## 12. Task breakdown

Each task is one PR with its tests and docs, and each estimate includes one review round. Days are implementer-days.

| Id | Task | Days | Needs |
|---|---|---|---|
| M0 | The meta-schema (`spec/schema.json`) and the `countinghouse-validate` checks for every declaration here, with `x-mcp-header` refused; a fixture module that declares everything | 2 | |
| M1 | Pagination: the cursor and page helper, on `tools/list`; a page resolves its own schemas only | 1.5 | |
| M2 | Tool metadata on `tools/list`: `title`, `annotations`, icons inlined; the second golden | 1.5 | M0 |
| M3 | Binary fields in the validator: the base64 assertion (input and output), the binary-field map, `OUTPUT_NOT_JSON` | 2 | |
| M4 | Content blocks: the advertised-schema transform, the blocks, the references, usage counts, the task result path | 2.5 | M3 |
| M5 | The store's `blobs` part, Redis and local: quotas, retention, sweep | 2.5 | |
| M6 | Resource links: the threshold, storing at result time, `resources/read` for stored results, access, metering | 2 | M4, M5 |
| M7 | Module resources: the registry, both lists, the read into an action, filtering, the URI parser | 3 | M0, M1 |
| M8 | The hub: `resourcesListChanged`, `promptsListChanged`, `resourceSubscriptions` with `changesWith`, on all three transports | 2 | M7, M10 |
| M9 | Progress: the per-call notifier, hop ticks, lazy SSE on the POST, stdio, the session transport, the rate limit | 2.5 | |
| M10 | Prompts: the registry, `prompts/list`, `prompts/get`, filtering | 2 | M0, M1 |
| M11 | Completion: from the schema, for prompts and templates (1.5); the completion action (1) | 2.5 | M7, M10 |
| M12 | The request-state helper out of `settings-confirm.js`; the derived key; the used-nonce store | 1.5 | |
| M13 | `ctx.ask`: declarations, the ask message, the pending question on the outer call, `input_required`, the retry's checks, answer validation, single-thread mode | 4 | M0, M12 |
| M14 | `ctx.ask` over composition: routed hops and direct peer channels; the limits; "ask first, act after" in the author docs and the countinghouse-module skill | 1.5 | M13 |
| M15 | The tasks extension: negotiation, `longRunning`, minted ids, `tasks/get`, `update`, `cancel`, discover, -32021, `Mcp-Name` | 3 | M0 |
| M16 | `notifications/tasks` on a listen; `statusMessage` from job progress | 1 | M15 |
| M17 | The shared runtime: session scope for stored results, lists and tasks; the ch-local acceptance test through the shim | 2 | M6, M9, M13, M15, and the shared-runtime plan's B3 and B5 |
| M18 | The conformance sweep (`test/mcp-contract/03` for each feature), the docs (module authoring, security model, CLI reference, upgrading), and the fixes from the final security pass | 3 | all |
| M19 | Cancelling a call in flight (section 13): the in-flight registry, `notifications/cancelled` on stdio and the session transport, the POST's disconnect on HTTP, the token drop, the remote call's abort, the shim's `cancelled` op | 1.5 | M9 |
| M20 | Output schemas of any JSON value (section 14): the registry's rule by era, `structuredContent` for any value, the text block's rule, the golden unchanged | 1 | M4 |
| M21 | A handler's own progress (section 6): `ctx.job` outside a task, the worker's message, the outer-call rule, the three fixtures and the doc row | 0.5 | M9 |
| *M22* | *Only if open question 5 is taken: a question from inside a task. Not in the totals below.* | *3.5* | *M13, M15* |

**Total: 45 implementer-days** in 22 PRs (M0 to M21). With M22 it's 48.5.

**The critical path is unchanged: M0 → M13 → M14 → M17 → M18, 12.5 days.** M12 runs beside M0. The next longest chain is M3 → M4 → M6 → M17 → M18, at 11.5. The three new tasks hang off M4 and M9 and are on neither.

**The split,** by what each implementer already owns:

| Implementer | Tasks | Days | With M22 |
|---|---|---|---|
| A (the shim, latency) | M3, M4, M5, M6, M9, M21, M17 | 14 | 15.5 (takes M19) |
| B (sessions, the settings dialog) | M12, M13, M14, M15, M16, M2, M20, half of M18 | 15 | 17 (takes M22, gives M2 to C) |
| C (the registry and lists) | M0, M1, M7, M10, M8, M11, M19, half of M18 | 16 | 16 (takes M2, gives M19 to A) |

A writes the shim's `cancelled` op for M19 whoever holds the task; it's a quarter of a day of it.

- **What can start on day one, together:** M0 (C), M12 (B), M3 (A). M1, M5 and M9 need nothing either.
- **What must not overlap:** M0 lands before any task that edits `spec/schema.json`. M4, M20, M7 and M15 all touch the result-building code in `lib/mcp/gateway.js` and the registry's schema rule, so they merge in that order. M9, M21 and M19 all touch the routes' stream handling, and merge in that order.
- **Review load:** 22 PRs. Five are on a trust boundary and need the deeper review: M6, M7, M13, M15, M19.
- **Outside this spec:** M17 waits on the shared-runtime plan's B3 and B5. If they're late, M17 is late, and nothing else is.

**Elapsed time.**

| Assumption | Elapsed, start to the last merge |
|---|---|
| All three implementers on nothing else | 16 working days: the largest load before M18 is 14.5, and M18's last part follows the last feature |
| **Each also carries their existing release-1 work at about half time** | **32 working days, about 6.5 weeks** |
| The same, with M22 | 34 working days, about 7 weeks |

**The slip of the release candidate, honestly.** It's not the 1 to 2 weeks that was allowed for.
- This is 45 implementer-days of new work on three people whose release-1 queues were already sized to the planned date. That's 15 days each. However it's interleaved with the existing work, the candidate moves by about **3 weeks** (16 working days), or 3.5 with M22.
- The half-time figure above is the other way of reading the same thing: if this work starts now beside the existing work, its last PR merges about 6.5 weeks from now, and the candidate can't be cut before then.
- Neither figure includes a second review round on the trust-boundary PRs, or a slip of B3 and B5 under M17. Either would add to it.

**To hold the slip to 2 weeks, 15 days must go** (45 down to 30, 10 each). In the order I'd cut, each moving to first after release 1:

| Step | Cut | Days | Running total | Slip then |
|---|---|---|---|---|
| 1 | The trims: M16 (`notifications/tasks`; polling still works), the completion action in M11, `resourceSubscriptions` in M8 (`list_changed` still works), icons in M2, M14 (a part's `ctx.ask` then answers `ASK_UNAVAILABLE`) | 5 | 40 | about 2.7 weeks |
| 2 | The tasks extension: M15, and its half day of M17. It was after release 1 until this spec (#239), and legacy tasks still work | 3.5 | 36.5 | about 2.5 weeks |
| 3 | Prompts and completion: M10, the rest of M11, `promptsListChanged` in M8 | 4 | 32.5 | about 2.2 weeks |
| 4 | M19 and M20: cancelling a call, and non-object structured output | 2.5 | 30 | 2 weeks |

- **What a 2-week slip still ships:** content blocks, resource links, module resources with `list_changed`, tool titles and annotations, pagination, progress from hops and from a handler, and `ctx.ask` for a listed tool.
- **What it doesn't:** steps 2 to 4 are whole gaps left open, against "fill all gaps". Step 1 alone leaves no gap fully open, and saves a third of a week.
- **The other lever isn't mine to pull:** moving 15 implementer-days of other release-1 work behind the candidate would hold 2 weeks with nothing here cut.

## 13. Cancelling a call in flight

Read on the 2026-07-28 cancellation page: how a client cancels depends on the transport.

- **Streamable HTTP:** "Closing the SSE response stream is the cancellation signal. The server MUST treat a client disconnect as cancellation of that request. No `notifications/cancelled` message is required or expected."
- **stdio:** "The client MUST send a `notifications/cancelled` notification referencing the request ID."
- A server "SHOULD" stop processing, free what the request held, and send no response. It "MAY" ignore a notice for an unknown request or one already completed.

**What counts as the signal here.**

| Transport | Signal | Scope of the request id |
|---|---|---|
| HTTP, a modern request | the POST's connection closing before its answer is written, whether the response had become an SSE stream (section 6) or was still to be plain JSON | none needed: the connection is the request |
| stdio | `notifications/cancelled` with `params.requestId` | the process's one connection |
| The shared runtime | the same notification, relayed by the shim as any notification is | the session: a session can name only its own requests |
| HTTP, a legacy request | nothing: unchanged, the call runs to its end | The disconnect rule is this revision's, and a stateless server can't match a legacy notice on a second POST to a call on the first. |

A notice for an unknown id, a finished request or a request of another kind is ignored, without an answer, as the spec has it. `initialize` and `server/discover` are never cancelled. A listen's cancel is unchanged.

**What can be cancelled:** a `tools/call`, a `resources/read` and a completion action, since each runs module code. The settings tool and the usage report are quick and run to their end.

**How a call stops: cooperatively, with no new module API.** JavaScript in a worker can't be interrupted, and a handler gets no abort signal.
1. The gateway keeps each cancellable request while it runs: per transport scope, its id and a cancel function. The entry goes when the call answers.
2. On the signal, the call's token is dropped at once, exactly as its timeout drops it. That drops every hop's token under it.
3. From then on, the handler's next hop, device query, remote call or peer invoke is refused `CALL_TOKEN_INVALID`, in whichever worker it's made. A handler that doesn't catch it ends there.
4. A remote call the main thread is making for that call is aborted, so the user's quota on the remote server stops being spent.
5. A hop already running in a part's worker isn't interrupted. It ends at its own next hop, or finishes, and its reply is discarded.
6. A handler that makes no hops runs to its end. Its result is discarded.
7. No response is written. On the shared runtime the shim is told to forget the request (section 10).

**The bill is what ran.** Cancelling never changes the billing rule; it only changes what runs.
- Each hop that completed was billed when it completed, and stays billed.
- The outer call is billed only if its handler returned a success, as today. A handler stopped by a refused hop returned an error, so it isn't billed.
- A handler that ran to its end after the cancel did its work, and is billed, though nobody reads the result. So a client can't dodge a bill by leaving just before the answer, and a module is never paid for work it didn't finish.
- The usage record is written with outcome `cancelled` and what ran before it.

**Bounds.** The registry holds only calls in flight, which the rate limit and the request timeout already bound. A cancel costs one map lookup, and a flood of notices for unknown ids costs that and nothing more.

**Not covered.**
- A call that became a task is cancelled with `tasks/cancel` (section 9). If the client leaves before the task's answer is written, the job is removed, since the client never learned its id.
- A call waiting in `input_required` isn't in flight: there's nothing to cancel, and its state expires.
- A prompt and a list finish too quickly to matter and aren't registered.

**Tests.** On each transport: a cancelled composite stops at its next hop and bills the hops that ran; a cancelled leaf handler finishes and is billed; an unknown id is ignored; one session can't cancel another's request; a disconnect after the answer changes nothing; a legacy HTTP disconnect changes nothing.

## 14. Output schemas of any JSON value

2026-07-28 says `structuredContent` "can be any JSON value (object, array, string, number, boolean, or null) that conforms to the tool's `outputSchema`", and shows a tool whose `outputSchema` is an array. The registry advertises an output schema only when it's an object, so an action whose output is an array or a string answers in text only.

**The rule, by era.**
- **A modern request:** any output schema that resolves is advertised as `outputSchema`, and a result carries the validated output as `structuredContent`, whatever its JSON type.
- **A legacy request:** unchanged. The object-only rule is the earlier revisions', as the registry's comment records, and a legacy SDK client may reject a non-object `structuredContent`. So a legacy `tools/list` omits the `outputSchema` of a non-object schema and its result stays text only, exactly as today.

`tools/list` and `tools/call` keep deriving the answer from one function, which now takes the era.

**The text block.**
- For a string output it's the string itself, as it is today for a tool with no schema. JSON quoting would only make it worse for a model to read.
- For every other type it's the JSON of the output, as it is today for an object.

**The golden doesn't move, and no bundled tool's `tools/list` bytes move.** I checked every bundled action's output schema on master: the 21 module tools of the golden list (the other 2 are platform tools with fixed object schemas), the 9 tools of `examples/log-triage` and `examples/repo-review`, and the 5 of `perf/`. Each one's root type is `object`. So there's no open question here.

**What does move:** a test fixture under `test/` with a non-object output schema, read by a modern request. M20 lists them and updates their assertions; none is a bundled tool.

**With section 1.** A whole output that is a binary string becomes a reference under this rule, for a modern request. M20 merges after M4 for that reason.

**Tasks.** A task result's schema hash is taken over the schema as advertised to the era that reads it, so the stamp carries the era.

## The maintainer's decisions (2026-11-15)

The draft's five open questions were answered by the maintainer on 2026-11-15:

1. **Which calls become tasks:** the action declares `longRunning: true`, as recommended.
2. **Module questions** are declared in `api.json` and called as `ctx.ask(name, values)`, as recommended.
3. **Cost:** a module resource read is billed as a call of its action; a completion action is counted and rate limited, and free; a stored-result read is free by default, with an operator price (`--resourceReadCost`), as recommended.
4. **Progress from one long handler** is in release 1 (M21), as recommended.
5. **A question from inside a task** is in release 1 (M22, 3.5 days).

**The date.** The whole spec is built for release 1, M22 included (48.5 implementer-days). The maintainer accepted the release candidate's slip of about three and a half weeks over taking any cut; the cut list above stays as the order to use if the date must move again.

## Spec details not yet verified

Read for this draft, on modelcontextprotocol.io: the 2026-07-28 pages for tools, resources, prompts, completion, elicitation, progress, subscriptions, MRTR and cancellation, and the tasks extension's overview. Not read, and to be checked before the task that depends on each:

- **The pagination and caching pages.** The cursor and `ttlMs` rules here are from the task brief and from the list examples on the pages above. (M1)
- **Whether `Icon.src` may be a `data:` URI in this revision.** The tools page shows only an `https` example. If it may not, icons need another design, or are cut. (M2)
- **The ext-tasks specification itself** (`specification/2026-07-28/tasks.md` in the ext-tasks repository). Section 9 follows #239's quotations from it and the overview page: the `notifications.taskIds` filter key, -32021 and its `data`, and `Mcp-Name` for task methods are from #239 alone. (M15, M16)
- **The transport page's rule for answering a request as SSE when the client's `Accept` allows only JSON,** and anything it adds to the cancellation page about a disconnect on a response that was never a stream. Section 13 takes the cancellation page's "a client disconnect" to cover both. (M9, M19)
- **What a legacy client's SDK does with a non-object `structuredContent`.** Section 14 keeps legacy requests on today's rule so that it doesn't matter. (M20)
