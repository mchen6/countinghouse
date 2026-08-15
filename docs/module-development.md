# Module development

A device module is an npm package that countinghouse loads and exposes as one
or more MCP tools. This document is the full reference; [`README.md`](../README.md#module-development)
has the short version.

## Directory layout

```
my-module/
├── package.json   # name, version, and "main": "index.js"
├── index.js       # the device MODULE -- what the framework loads and talks to
├── device.js      # the device itself: wires api.json + schema.json + handlers
├── api.json       # device/service/action metadata
├── schema.json    # JSON Schema 2020-12 input/output/fault per action
└── com-<ns>-<service>-<action>.js   # one handler per action (a convention, not a rule)
```

**`index.js` is not optional, and it is not the same thing as `device.js`.**
This is the single most common way a new module fails, so it is worth being
explicit about: the framework loads your package's `main` entry and treats
that object as a *device module* — something that answers a `discover` request
by announcing one or more devices. It does **not** treat it as a device.

```js
// index.js -- the device MODULE
var util   = require('util');
var events = require('events');

var Device = CHUtil.loadFile(__dirname + '/device.js');

function DeviceModule() {
  this.on('discover',     this.discoverDevices.bind(this));
  this.on('stopdiscover', this.stopDiscoverDevices.bind(this));
}

util.inherits(DeviceModule, events.EventEmitter);

DeviceModule.prototype.discoverDevices = function() {
  this.emit('deviceonline', new Device(), this);   // <-- this is what makes your tool appear
};

DeviceModule.prototype.stopDiscoverDevices = function() {
};

module.exports = DeviceModule;
```

Every bundled module in `pre-installed-packages/` has exactly this file, byte
for byte apart from the `require` path. Copy it.

The indirection exists because one module may announce several devices (and
may discover them at runtime rather than at load). If your module only ever
has one device, `index.js` is pure boilerplate — but it is *required*
boilerplate, because `discover` → `deviceonline` is the only handshake by
which a device ever enters the runtime.

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

## `device.js`

Loads one handler function per action (via `CHUtil.loadFile`) and registers it
with `this.setAction(serviceID, actionName, handlerFn)`. Handlers are plain
Node functions, callback-style (`function(args, callback)`) or `async`, that
return `{output: {...}}` or call back with an error.

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

A module that calls another module's action does so under some apiKey, and
that apiKey goes through the same `AuthProvider` check any external caller
would — so it must be granted access first, or every inner call fails. See
[`composite-tools.md`](composite-tools.md#every-composing-module-needs-its-internal-identity-granted).

## Troubleshooting: my module doesn't appear in `tools/list`

Work down this list in order. Every case below now logs an explicit error —
**check the server log first**, it very likely already names the cause.

### 1. The log says `MODULE_NOT_DISCOVERABLE`

```
Device module is not discoverable: my-module its main entry point registers no
"discover" listener, so it can never emit "deviceonline" ...
```

Your `package.json`'s `main` points at `device.js` instead of `index.js`, or
you have no `index.js` at all. See [Directory layout](#directory-layout) above.
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

### Verifying a spec without starting a server

`--verifyModule` makes the framework continue past validation failures and
report everything it finds, rather than stopping at the first one:

```sh
node ./framework.js --verifyModule --loadModule ./path/to/my-module
```
