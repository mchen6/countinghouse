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

That is the whole module. There is no `index.js` and no `device.js`: since
6.0.0 the framework assembles the device from `api.json`, reads `schema.json`
itself, and matches handlers by name. See
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

If you would rather keep everything in one file, export the same thing as a
map from `device.js` instead of using the `handlers/` tree:

```js
// device.js -- an alternative to handlers/, not an addition
module.exports = {
  greetService: {                                    // service SHORT name
    hello: async (input, ctx) => ({output: {text: `hello ${input.name}`}})
  }
};
```

Top-level keys are service **short** names — the part after `:serviceID:` in
the URN. `api.json` remains the only place the full URN appears.

**Mismatches are startup errors, not silent omissions.** An action declared in
`api.json` with no handler, a handler `api.json` does not declare, a service
short name that does not resolve, or one that two URNs both claim: each fails
the module at load with a message naming the module, the stage, the offending
name and the fix. A module never half-loads.

## `ctx`

| field | what it is |
| --- | --- |
| `ctx.caller` | `{apiKey, userName, isAdmin}` — the authenticated caller |
| `ctx.device` | `{deviceID, friendlyName}` — this device |
| `ctx.serviceID`, `ctx.actionName` | the action being served |
| `ctx.log(entry)` | device log, already bound to this device |
| `ctx.serviceClient(opts, cb)` | call another module — see below |
| `ctx.job` | `{id, progress(n), info(cb)}` inside a task, otherwise `null` |
| `ctx.redis` | the shared Redis client |
| `ctx.recordUsage(tool, cost, cb)` | app-layer bookkeeping; never touches balance |
| `ctx.httpHeaders` | request headers, when the call arrived over HTTP |

`ctx` replaces the device instance that used to be bound as `this`. That is a
narrowing on purpose: handlers used to be able to reach `setAction`,
`deviceControl` and the rest of the framework's own surface. They no longer
can.

## Failing a call

Throw a `DeviceError`:

```js
module.exports = async (input, ctx) => {
  if (typeof input.text !== 'string') throw new DeviceError('ARGUMENTS_INVALID');
  return {output: {text: input.text.toUpperCase()}};
};
```

A typed error (`DeviceError`/`CHError`) keeps its own code. An untyped error
that you throw becomes `DEVICE_INVOKE_EXCEPTION` — the runtime reads a bare
`throw` as "this handler crashed", which is why an anticipated failure should
carry a `DeviceError`. See
[`design-decisions.md`](design-decisions.md#handler-failure-is-classified-by-the-error-not-by-how-it-arrived).

## Dynamic discovery: when one module has many devices

Everything above describes a module that is one device, described statically.
If your module decides at runtime how many devices to expose — one per
configured database connection, say — or needs to withdraw one when its
backing resource disappears, export a class or EventEmitter instead of a
handler map and the 5.x discovery path applies unchanged:

```js
// index.js -- still supported, and still the right answer for this case
function DeviceModule() {
  this.on('discover',     this.discoverDevices.bind(this));
  this.on('stopdiscover', this.stopDiscoverDevices.bind(this));
}
util.inherits(DeviceModule, events.EventEmitter);

DeviceModule.prototype.discoverDevices = function() {
  for (const conn of readConfig()) this.emit('deviceonline', new Device(conn), this);
};
```

`discover`, `deviceonline` and `deviceoffline` behave exactly as they did.
Note that `deviceoffline` marks a device offline rather than unlisting it: it
stays in `tools/list` and fails at call time with `DEVICE_OFFLINE`.

The framework chooses between the two shapes by what your module exports — a
plain object is a handler map, anything else takes the discovery path.

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
does not know is **rejected**, not ignored — so a stale field left over from
an older format shows up as a load error rather than silently doing nothing.

Specs written for 4.x (`argumentList` + `serviceStateTable`) do not load. The
error says so and names the converter:
`npx countinghouse-migrate-spec ./my-module`. See
[`MIGRATION.md`](../MIGRATION.md).

## `schema.json`

Supplies the JSON Schema 2020-12 documents the action's `input`/`output`/`fault`
pointers resolve to. This is what becomes each MCP tool's
`inputSchema`/`outputSchema`.

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

## Calling other modules

Use `ctx.serviceClient`, which keeps two identities apart:

```js
ctx.serviceClient({deviceID, serviceID, as: 'my-module-internal'}, (err, client) => {
  client.invoke({actionName: 'echo', input: {...}}, (err, data, platformMetering) => { ... });
});
```

`as` is the identity the inner hop is **authorized** as — your module's own,
which must be granted access to the target device or every inner call fails.
The hop is **billed** to `ctx.caller`, so per-hop cost lands on whoever called
your tool rather than on your module. See
[`composite-tools.md`](composite-tools.md#every-composing-module-needs-its-internal-identity-granted).

## Troubleshooting: my module doesn't appear in `tools/list`

Work down this list in order. Every case below now logs an explicit error —
**check the server log first**, it very likely already names the cause.

### 1. The log says `MODULE_NOT_DISCOVERABLE`

```
Device module is not discoverable: my-module its main entry point registers no
"discover" listener, so it can never emit "deviceonline" ...
```

This applies to the dynamic-discovery shape only. Your `package.json`'s `main`
points at the device instead of the module that announces it. A handler-map
module cannot hit this — the framework supplies the discovery shim itself.
This is the most common failure by a wide margin: the module loads without
error, reports success, and then nothing else ever happens, because nothing is
listening for the `discover` request.

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

The device object failed its interface check — usually it isn't a `CHDevice`
(check that `device.js` calls `CHDevice.call(this, spec)` and
`CHUtil.inherits(Device, CHDevice)`), or an earlier error on the device was
recorded and the message will quote it.

### 4. The log says `LOAD_MODULE_FAIL`

Your module threw while being constructed — a syntax error, a missing
`require`, a bad path in `CHUtil.loadFile`. The stack is in the log.

### 5. No error at all, and the module is listed as loaded

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

Checks `api.json`, `schema.json` and the handler map against each other and
prints every problem it finds, each naming the stage and the way out. Exit
codes: `0` clean, `1` problems found, `2` the path could not be read. No
Redis and no server required.

`--verifyModule` remains available for checking a module in the context of a
running framework: it makes the framework continue past validation failures
and report everything it finds, rather than stopping at the first one.

```sh
node ./framework.js --verifyModule --loadModule ./path/to/my-module
```

### Letting an agent write the module

Full reference for the authoring toolchain — the four tools, the loop, the
security boundary and its known limits — is in
[`module-authoring.md`](module-authoring.md).

Start the runtime with `--authoringTools` and an admin key, and a coding
agent can validate a design, write the module, validate it, load it and call
it without a human editing JSON. The four tools are
`countinghouse_validate_plan`, `countinghouse_validate_module`,
`countinghouse_load_module` and `countinghouse_call_tool`; they are admin-only
and absent from `tools/list` unless the flag is set. Also start it with
`--workerThread`: `countinghouse_load_module` runs a module's main entry
directly in the runtime, and `--workerThread` is what turns a crash or
`process.exit()` there into a reported failure instead of taking the whole
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
Error('boom')` becomes `DEVICE_INVOKE_EXCEPTION` ("I crashed"). A typed
`DeviceError` keeps its own code either way, which is the reason to use one.
