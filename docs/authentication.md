# Authentication

Every request carries an API key (`X-CH-Key` header for HTTP and MCP
alike), and `AuthProvider` decides which devices that key can see and
call. There are three built-in backends, selected with
`--authProvider file|sqlite|couchdb` (default `file`). See
[`design-decisions.md`](design-decisions.md#authprovider-three-pluggable-backends-one-narrow-interface)
for why the interface is scoped this narrowly and why three backends
exist at all.

`--debug` (used by this repo's own test suite) bypasses `AuthProvider`
entirely — every apiKey is accepted. That's for local iteration only, not
for anything reachable beyond localhost.

## `file` (default)

A flat JSON file, `auth.json` in the working directory by default
(`--authConfigPath` to point elsewhere):

```json
{
  "your-api-key":   {"userName": "you",      "devices": ["*"]},
  "your-admin-key": {"userName": "operator", "devices": ["*"], "admin": true}
}
```

`devices` may list specific deviceIDs, or the literal string `"*"` for
every device.

`admin` is optional and defaults to `false`. It is a **separate capability
from `devices`** — see [Admin keys](#admin-keys) below. A key can have
`devices: ["*"]` and still not be admin (that is exactly what the
auto-generated demo key is), or be admin without any device grants.

**Zero-config first run**: if `auth.json` doesn't exist yet, a demo key
with wildcard access is generated, written to `auth.json` (so it survives
a restart), and printed once:

```
============================================================
countinghouse: no /path/to/countinghouse/auth.json found.
Generated a demo API key with access to every device --
replace it before any real deployment:

  X-CH-Key: demo-a1b2c3d4e5f6...

Edit /path/to/countinghouse/auth.json to add real keys, or set
COUNTINGHOUSE_API_KEY for single-key mode instead.
============================================================
```

An *existing* `auth.json` — even an empty `{}` — is never overwritten;
that's treated as a deliberate "no one is authorized yet" state, not a
first-run gap to paper over.

**`COUNTINGHOUSE_API_KEY`**: for deployments where writing a file is
friction (a container, say), set this environment variable instead. That
key gets wildcard access without `auth.json` needing to exist at all, and
works independently of (and in addition to) whatever the file contains.

**Security boundary**: the auto-generated demo key is for local
development and evaluation only — it grants wildcard access to every
device, with no expiry and no way to distinguish it from a real key once
issued. Replace it (edit `auth.json`, or set `COUNTINGHOUSE_API_KEY`)
before anything reachable outside localhost. See
[`security-model.md`](security-model.md) for the full threat model this
sits inside.

## `sqlite`

Same zero-external-service property as `file`, but a real db file instead
of hand-edited JSON — useful once there are more keys than are
comfortable to maintain by hand.

> **Platform limitation — this backend needs a working `sqlite3` native
> module, and that is not available everywhere.**
>
> `sqlite3` is an **optionalDependency**. It ships a prebuilt native binding
> linked against **glibc 2.38**, so on a host with an older glibc (Ubuntu
> 22.04 LTS ships 2.35) the package installs successfully and then fails to
> *load*, with `ERR_DLOPEN_FAILED`. Marking it optional is therefore
> necessary but not sufficient: npm only skips a dependency that fails to
> install, and this one installs fine.
>
> Selecting `--authProvider sqlite` on such a host fails at startup with an
> explicit message naming the cause, this system's glibc version, and both
> ways forward:
>
> ```
> --authProvider sqlite requires the optional "sqlite3" package, which is
> installed but cannot be loaded on this host.
>   Cause:   sqlite3 ships a prebuilt native binding that requires glibc >= 2.38;
>            this system has glibc 2.35.
>   Fix (a): rebuild sqlite3 from source against this system's glibc:
>              npm install sqlite3 --build-from-source
>            (needs a C++ toolchain: build-essential and python3)
>   Fix (b): use --authProvider file (the default), which needs no native
>            modules at all
> ```
>
> **Nothing else is affected.** The `file` and `couchdb` backends, the MCP
> gateway, metering, rate limiting and the module-lifecycle routes all work
> normally without `sqlite3` — the documented `--loadModule` startup path
> never touches the module registry DB (the only other thing that uses it).
> Covered by `test/module-loading/02-sqlite3-unavailable.js`, which runs the
> whole file-backend flow with `sqlite3` made unloadable.

The CLI below has the same requirement, and reports the same diagnosis.

Start the server with `--authProvider sqlite` (`--authConfigPath` sets the
db file path, default `./auth.sqlite3`), then manage users with the
bundled CLI (it operates on the db file directly, not through the running
server):

```sh
node bin/countinghouse-auth-sqlite.js add-user my-api-key alice
node bin/countinghouse-auth-sqlite.js grant my-api-key '*'
node bin/countinghouse-auth-sqlite.js list
# my-api-key (alice): *

node bin/countinghouse-auth-sqlite.js revoke my-api-key '*'
node bin/countinghouse-auth-sqlite.js grant my-api-key some-specific-device-id
node bin/countinghouse-auth-sqlite.js remove-user my-api-key

# admin rights (see "Admin keys" below) -- independent of device grants
node bin/countinghouse-auth-sqlite.js set-admin my-api-key true
node bin/countinghouse-auth-sqlite.js list
# my-api-key (alice, admin): some-specific-device-id
node bin/countinghouse-auth-sqlite.js set-admin my-api-key false
```

Pass `--dbPath <path>` before the subcommand if not using the default
location. `grant`/`revoke` take a deviceID or the literal `'*'` for
wildcard access, matching `file`'s convention.

There's deliberately no HTTP endpoint for managing keys — an endpoint for
"who's allowed to authenticate" would itself need authenticating, which is
circular complexity this doesn't need.

## `couchdb`

For an existing CouchDB-backed deployment. Needs the optional `nano`
package, not installed by default:

```sh
npm install nano
```

Without it, starting with `--authProvider couchdb` fails fast with:

```
CouchDBAuthProvider requires the "nano" package, which is not installed. Run: npm install nano
```

On a fresh CouchDB instance, set up the `_users` db and the design
document this provider queries:

```sh
node lib/couchdb-adapter/init-db.js --dbUrl http://admin:password@127.0.0.1:5984
```

(safe to re-run — it updates the design document in place rather than
failing on a conflict). Start the server with `--authProvider couchdb
--dbUrl <same url>`.

User documents look like:

```json
{
  "type": "user",
  "appKey": "your-api-key",
  "userName": "you",
  "balance": 0,
  "devices": [{"deviceID": "some-device-id"}],
  "admin": false
}
```

`devices` may also contain `{"deviceID": "*"}` for wildcard access — an
addition on top of the original schema, kept for consistency with the
other two backends. `balance` is read by this provider's underlying
document but not part of `authenticate()`'s result; balance and pricing
are `MeteringProvider`'s domain, not `AuthProvider`'s.

## Admin keys

Device access answers *"which tools may this key call?"*. It says nothing
about *"may this key change what the server is running?"* — that is a second,
independent capability, `admin`.

**These endpoints require an admin key**, and reject everything else with
`403 ADMIN_REQUIRED` (`lib/routes/admin-only.js`):

| Endpoint | What it does |
|---|---|
| `POST /load-module` | Load a module from a filesystem path into the running server |
| `POST /unload-module` | Unload a loaded module |
| `POST /restart-module` | Restart a loaded module's worker |
| `POST /reload-module` | Reload a module in place |
| `POST /shutdown` | Stop the server process |
| `POST /get-module-device-list` | List the devices a named module provides |

Treat an admin key as an operator credential, not a tenant credential:
`/load-module` takes a filesystem path and runs whatever module is there,
with the full privileges of the server process (see
[`security-model.md`](security-model.md)). It is not something to hand to a
tenant so they can install their own tools.

How to grant it:

```jsonc
// file backend -- auth.json
{"your-admin-key": {"userName": "operator", "devices": ["*"], "admin": true}}
```

```sh
# sqlite backend
node bin/countinghouse-auth-sqlite.js add-user your-admin-key operator
node bin/countinghouse-auth-sqlite.js set-admin your-admin-key true
```

```sh
# COUNTINGHOUSE_API_KEY is admin as well as wildcard-device -- it is the
# single-shared-key mode, so it has to be usable end to end on its own.
COUNTINGHOUSE_API_KEY=... node ./framework.js ...
```

For `couchdb`, set `"admin": true` on the user document (the design document
emits it, see `lib/couchdb-adapter/init-db.js`).

**Two things worth knowing before you go looking for why a call is 403:**

- **The auto-generated demo key is *not* admin.** It gets
  `{"userName": "demo", "devices": ["*"]}` — wildcard device access, no admin
  rights. A fresh checkout can call every tool immediately, but cannot
  `/load-module`. Add `"admin": true` to it in `auth.json` (and restart —
  `auth.json` is read once at startup) if you want that from the demo key.
- **`--debug` bypasses this, along with everything else.** Under `--debug`
  every key resolves to an admin session, which is why the repo's own test
  suite can call these endpoints freely. That is a property of `--debug`, not
  a way to configure admin access. **Normal use does not need `--debug`** —
  including hot-loading modules, which is what an admin key is for. See
  [`cli-and-api-reference.md`](cli-and-api-reference.md).

## Choosing a backend

Start with `file` — it's the default for a reason, and covers everything
from local evaluation through a handful of hand-managed production keys.
Move to `sqlite` once editing JSON by hand for every new key stops
scaling. Use `couchdb` only if you already operate a CouchDB instance for
this deployment; it doesn't offer anything the other two don't, aside
from fitting into an existing CouchDB-centric setup.
