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
  "your-api-key": {"userName": "you", "devices": ["*"]}
}
```

`devices` may list specific deviceIDs, or the literal string `"*"` for
every device.

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
comfortable to maintain by hand. Reuses the `sqlite3` dependency this
repo already has for other things; no new install required.

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
  "devices": [{"deviceID": "some-device-id"}]
}
```

`devices` may also contain `{"deviceID": "*"}` for wildcard access — an
addition on top of the original schema, kept for consistency with the
other two backends. `balance` is read by this provider's underlying
document but not part of `authenticate()`'s result; balance and pricing
are `MeteringProvider`'s domain, not `AuthProvider`'s.

## Choosing a backend

Start with `file` — it's the default for a reason, and covers everything
from local evaluation through a handful of hand-managed production keys.
Move to `sqlite` once editing JSON by hand for every new key stops
scaling. Use `couchdb` only if you already operate a CouchDB instance for
this deployment; it doesn't offer anything the other two don't, aside
from fitting into an existing CouchDB-centric setup.
