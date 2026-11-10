# R2-1: modules never see an API key or who the user is

Status: draft for review (2026-11-07). Target: 8.0.0, which is unreleased.

## Intent

countinghouse runs third-party modules, reviewed by the operator and
distributed over npm. Today every module receives its caller's **raw API
key** (`ctx.caller.apiKey`), its user name, and, through composition, the
raw keys of the internal identities it runs inner hops as. A module that
holds a key can act as that tenant: call any tool the key is granted, spend
its balance, read its jobs. A module that holds a user name learns who is
calling. R2-1 removes both. The user's rule, in their words: *a third-party
module author should know nothing about the identity of the user.*

The main thread keeps doing what it does today: it authenticates the key,
checks access, bills the call. Only what crosses into a module's worker
changes, along with how a worker asks the main thread for an inner hop, so
that a worker can no longer **claim** an identity. It can only use the one
the main thread gave its call.

## Decisions (the user's, 2026-11-07)

Decisions 1–6 were given in the brainstorm; 7 and 8, and the delegation,
in answers to the reviewer.

1. `ctx.caller` becomes `{id, isAdmin}`. No `apiKey`, no `userName`.
2. `isAdmin` stays as it is (the caller's admin flag), so a module can still
   gate admin-only actions inside a tool.
3. `id` is an opaque per-user id: stable for a user, **the same for a user
   across all modules**, and not reversible to the key or the user name.
4. The operator can map an `id` back to the user name (admin only).
5. The main thread enforces each module's declared calls
   (`countinghouse.calls`) on every inner hop. The declaration becomes a hard
   limit, whatever API the module uses.
6. A clean break in 8.0, with no transition release that still hands out
   keys. `as` is refused with a clear error. The bundled examples are
   migrated in the same change, and `docs/upgrading-to-8.md` shows the
   before and after.
7. Under `--moduleSandbox audit`, a small **always-denied** set applies
   even though audit otherwise only logs (see "What each sandbox mode
   guarantees"). `enforce` refuses it explicitly too; `off` decides nothing.
8. The id comes from an **optional stable field**: an auth entry may carry
   `id`, which is used as the HMAC input instead of the key, so rotating
   that user's key keeps their id. Without it, the key is the input.

## Goals

- The runtime never **hands** a module a tenant's API key, an internal
  identity's key, or a user name: not in `ctx`, request headers, job data,
  return values, peer-channel messages or anything else it gives the
  module. Whether a module can **take** one some other way depends on the
  sandbox mode (see "What each sandbox mode guarantees" below).
- No module can make an inner hop that is billed to, or authorized as,
  anyone other than what the main thread bound to the call it is serving.
- No module can call a tool it did not declare in `countinghouse.calls`.
- Module authors keep everything they legitimately need: per-user data
  (through `id`), admin gating (through `isAdmin`), composition (through
  `ctx.call`, and `ctx.serviceClient` without `as`), job progress and info.
- Operators can still tell who did what: a log line, a bill or a module's
  per-user data can be traced from `id` to a user name.

## What each sandbox mode guarantees

R2-1 removes keys from what the runtime hands a module. A module that can
read files or the environment could still find keys there: the auth
config, the sqlite auth database, the identity secret file, or
`COUNTINGHOUSE_API_KEY` / `COUNTINGHOUSE_IDENTITY_SECRET` in the server's
environment. So the guarantee depends on the mode:

| Mode | What R2-1 guarantees |
|---|---|
| `enforce` | Nothing handed over; the always-denied set below is refused; files and env outside the module's namespace are refused unless declared and approved. **Not the network:** until sandbox parts 3 and 4 move networking to the main thread, no network permission is enforced in any mode (docs/security-model.md, "No network permission is enforced yet"), so the Redis denial below is an in-worker check, not a boundary. |
| `audit` | Nothing handed over, and the always-denied set below is refused. Other reads outside the namespace are allowed and logged, as audit does today. |
| `off` | Nothing handed over, and nothing else: "off decides nothing", so the always-denied set is not enforced either. A module can read the auth config and the server environment. |

**The always-denied set** (refused in `audit` and `enforce`):

- **Files:**
  - the file at `--authConfigPath`. That's the JSON auth config under
    `--authProvider file`, and the database under `--authProvider sqlite`,
    together with its `-wal`, `-shm` and `-journal` side files;
  - the identity secret, `<moduleDataPath>/.identity-secret`.

  Refused as `EACCES` and recorded as a denial in full (P2's audit rule:
  denials are recorded in full, routine access summarised). `EACCES` rather
  than the `ENOENT` enforce gives an ordinary outside path
  (lib/fs-broker/broker.js `place()`), because these files' existence is no
  secret and "denied" is the honest answer. The broker identifies these
  files by device and inode, taken when the server starts and re-taken when
  a path's inode changes (a provider rewriting its file). It compares them
  with the device and inode of whatever a module's path resolves to. Under
  `audit`, an outside path is passed through today without the broker's
  realpath and identity checks, so the plan adds that resolution for
  outside paths (realpath, then lstat) before the comparison. So a symlink, a `../` path or a hard
  link to one of them is refused like the file itself. A file not yet
  created when the server starts (the secret on a first start, a sqlite
  side file) is matched by its realpath until it exists, then by device and
  inode.
- **Redis**, the other place keys live. Metering balances are named by the
  raw key (db 12), pre-upgrade job data holds it (db 11), and so do
  `--apiMonitor`'s lists until the logger work retires them. A module
  reaches Redis three ways:
  - `ctx.redis`, the runtime's route. Its commands go through the main
    thread, to db 5 only, with an allowlist of 23 commands that includes no
    `keys`, `scan` or `select` (lib/redis-api.js,
    lib/supported-redis-commands.json), so it can't reach those databases.
    It's unchanged.
  - Its own connection: `net.connect`, `tls.connect`, a raw
    `net.Socket().connect`, or `http.request({socketPath})`. R2-1 adds the
    Redis endpoint to the always-denied set: the host and port from
    `--redisUrl`, and its unix socket path if `--redisUrl` names one. It's
    refused with `EACCES` in audit and enforce, and
    recorded as a denial, by the same in-worker lockdown that already wraps
    `CHUtil.request` (lib/module-lockdown.js, where `WATCHED` reports first
    use of `net` and the CHUtil host check calls `hostAllowed`). This is an
    in-worker check: code in the worker can interfere with the wrappers, as
    docs/security-model.md already says of the `CHUtil.request` check. The
    boundary is parts 3 and 4.
  - **The worker's own metering client (M6, found in review; fixed before
    R2-1 resumes).**
    Every worker builds its own metering provider today, with a Redis
    client on the balance ledger (lib/countinghouse-interface.js, built per
    worker by lib/sandbox.js and reachable as `CHUtil.ci` or through
    `require.cache`). Module code can call its `recordCall` with any key, or
    write the balance hashes through its client directly. So until that fix
    lands, a module *can* reach the key-named data. Nothing in a worker has
    needed it since D5, so the fix builds the provider on the main thread
    only, and gives workers a stub that refuses. R2-1 assumes that fix: after
    it, a worker holds no Redis client at all.
  - So R2-1 also: (a) stops sending `redisUrl` to workers -- and `dbUrl`
    with it: no connection string of any backend (Task 2 ruling, agreed in
    review 2026-11-10; a CouchDB password travels in `dbUrl` the same way). It's in
    `getOptions()` today, a worker opens no Redis connection of its own
    once M6 lands, and a `--redisUrl` with a password would hand that password to every module.
    (b) Tells operators, in docs/security-model.md and the upgrade guide,
    to put Redis behind a password or ACL, which is the control that holds
    until the network broker ships.
- **Environment:** every variable whose name starts with `COUNTINGHOUSE_` is
  left out of a worker's environment, even when the module declares it in
  its permissions. Today the secrets among them are `COUNTINGHOUSE_API_KEY`
  and `COUNTINGHOUSE_IDENTITY_SECRET`; the rest (`COUNTINGHOUSE_OWN`,
  `COUNTINGHOUSE_HARDENED_REALPATHS`, the `COUNTINGHOUSE_TEST_*` variables)
  are internal and no module needs them. A declaration naming one is
  reported by `countinghouse-validate` and logged as a denial at load.
  Excluding the whole prefix, not a list of two, is my call: a future
  secret variable is covered without anyone remembering to add it.

The upgrade notes and docs/security-model.md state this table.

## Non-goals

- A redesign of metering or per-call usage history. That's P2, built on the
  logger redesign. Balances stay keyed as they are today.
- Hiding *that* a call happened, or its input, from the module serving it.
- Per-action grants in the auth config. The user preferred keeping
  `isAdmin` in modules.
- Changing what an MCP client or HTTP caller sees, apart from what the
  bundled examples' bills print.
- Fixing the MCP task `ttl` mapping (`jobToTask` maps `opts.timeout` to an
  MCP retention field). It's noted for the MCP backlog.

## Anti-goals

- A key, or anything that can be turned back into one, reaching a module by
  a new route, for example an "opaque" id that is an unsalted hash of the
  key (guessable for short keys), or a token a module could reuse after its
  call ended.
- A design where a worker states its identity and the main thread believes
  it. Today's hop messages carry `appKey`/`billingKey` chosen by the worker.
  That trust is what goes.
- Breaking the direct-peer-channel path's main property: an invoke between
  two workers does not wait for the main thread per call (D1/D2,
  docs/direct-peer-channels-design.md). Billing already goes to main per
  hop; authorization must not add a main round trip to every invoke.

## Design

### 1. The opaque id

- `id = "u_" + base64url(HMAC-SHA256(secret, source))`, truncated to 22
  characters (132 bits). The same for a user everywhere on this server.
- **The source** (decision 8) is the auth entry's optional `id` field when
  present, else the API key. The field is HMAC'd like the key, so a module
  only ever sees `u_…`, never the raw field. Domain-separated
  (`"id:" + field` vs `"key:" + apiKey`), so an `id` value that happens to
  equal some other user's key can't produce that user's id.
  - Constraints: a string of 1–128 printable characters, unique across all
    entries. A duplicate is refused at load with an error naming the entry
    positions, never a key. In the file provider that fails startup (exit
    2); in sqlite and CouchDB it fails the write that would create the
    duplicate.
  - sqlite: a new nullable `id` column on the users table, unique where not
    null, added by a migration the provider runs on open. Existing
    databases get the column empty, so every user falls back to their key,
    as before. `bin/countinghouse-auth-sqlite.js` gets a way to set it.
  - CouchDB: an optional `id` field on the user document, with uniqueness
    checked by the provider on write. Migration notes in the upgrade guide.
  - With no `id`, rotating a user's key changes their id, which orphans
    their per-user module data and their schedulers. The upgrade notes tell
    operators to add `id` to an entry **before** rotating its key.
- **The secret** is generated on first start (32 random bytes) and kept in
  `<moduleDataPath>/.identity-secret` (mode 0600, refused if group- or
  world-readable, never followed through a link). That path can't fall
  inside any module's broker namespace: namespaces are
  `<moduleDataPath>/<module name>/`, and npm package names can't start with
  `.`. The operator can supply
  one instead with `COUNTINGHOUSE_IDENTITY_SECRET`. Changing the secret
  changes every id, so a module's per-user data would be orphaned. The
  upgrade notes and the CLI reference say so.
- A main-side **identity index** maps `id → {apiKey, userName, isAdmin}`. It
  is built from the AuthProvider: the file provider computes it when it
  loads; the sqlite and CouchDB providers compute it per lookup and cache it
  (an id is computed from a key, never the reverse, so a lookup by id needs
  a provider-side scan or a stored column. The plan picks one per provider,
  without changing the auth config format). The lookup runs on the billing
  hot path (job completion, metering a peer hop by token), so it must be
  cached, never a per-call scan. The index never leaves the main thread.
- `--debug`: the debug key gets an id like any key.
- Everything that today derives a tenant tag from the key moves to `id`:
  - `schedulerId` (now an unsalted sha256 prefix). It becomes `<id>:<name>`.
    Schedulers stored under the old prefix are still found and removed by
    their owner, through a fallback lookup, so nothing an operator set up is
    orphaned by the upgrade.
  - `lib/key-fingerprint.js` (`key sha256:<8 hex>` in log lines). Log lines
    name the tenant by `id`. This is the switch its comment anticipates.

### 2. What a module's worker receives

| Today | After R2-1 |
|---|---|
| `ctx.caller = {apiKey, userName, isAdmin}` | `ctx.caller = {id, isAdmin}` |
| the composing identity's key, relayed by `sendSetCompositionMessage({identity})` | nothing. Main keeps the binding, and the worker gets only "composition is settled" plus the declared addresses |
| `httpHeaders` with `X-CH-Key` / `X-App-Key` / `Authorization` (HTTP `invoke-action`) | the same headers minus those three (and any other header the auth gate reads) |
| `ctx.recordUsage` returns `{apiKey, tool, cost, ts}` | returns `{id, tool, cost, ts}` |
| `peer-channel-open` to the callee worker carries the caller's `appKey` | carries no key (see 4) |
| `ctx.job.info` | unchanged: it already strips `apiKey` (`forWorker`) |

A per-call **token** (3) is the only new value that reaches the worker. It
identifies the call to the main thread, and is useless outside it.

### 3. Per-call tokens: the worker never names an identity

- When the main thread dispatches a call to a worker (a synchronous call, a
  job, or a hop it routes), it creates a token: 128 random bits, kept
  main-side as `token → {billing: <caller key>, identity: <module's
  runsModules key or null>, module: <name>, deviceID, expires}`. It sends
  the token with the call's args, and `ctx` carries it internally, out of
  the module's reach (not on any property `ctx` exposes).
- Every inner hop the worker asks for (`ctx.call`, `ctx.serviceClient`, a
  routed `invokeforeignaction`, a peer-channel open, a metering request)
  sends the token instead of `appKey`/`billingKey`. The main thread resolves
  the token, bills `billing`, authorizes as `identity`, and refuses an
  unknown, expired or foreign token (new code `CALL_TOKEN_INVALID`).
- **A token is bound to the worker it was issued to.** Main derives a hop's
  module from the WorkerMessage the request arrived on, never from the
  token or the message, and refuses a token whose worker is not that one.
  There is exactly one other place main accepts it: as the billing subject
  of a metering request sent by the *callee* of a direct peer channel whose
  caller is that token's worker, for an invoke on that channel. Anywhere
  else, a token is **foreign** and refused. So a callee that keeps the
  caller's token it received on a peer invoke can't use it for hops of its
  own.
- **The peer path meters before it serves.** Today the callee runs the
  action and then sends the metering request, and metering errors fail open
  (`PeerChannel.finishMeteredHop`: everything but `RATE_LIMITED` is
  served). After R2-1 the callee meters first, and runs no handler unless
  that succeeds, in two steps:
  1. **The token check** is main-side and in memory, so it never depends on
     Redis. It always fails closed: an unknown, expired or foreign token is
     `CALL_TOKEN_INVALID`, and no handler runs, even with Redis down.
  2. **The balance deduction** is the only step that may fail open when the
     metering backend (Redis) is unreachable, as today. That's documented as
     the one case a hop runs unbilled.
- The token lives as long as the call it was issued for: dropped when the
  call answers or its worker ends (D1's drain), and bounded by the call's
  timeout as a backstop. A hop's own token chains to its outer call, so a
  3-hop composite bills the original caller at every hop, as today.
- The global `CHUtil.createServiceClient` a module can also reach takes an
  `appKey`/`ctx` today. After R2-1 a worker's hop carries the call's token
  and nothing else, so a key passed there is refused the same way as `as`;
  it can't name an identity. The `--debug --verifyModule` branch that
  queries a central portal over HTTP with the key is CDIF-era. The plan
  either drops it or has it run main-side with the module's binding; it
  never sends a key from a worker.
- `ctx.serviceClient(opts)` no longer takes `as`: it authorizes as the
  module's own binding, like `ctx.call`. Passing `as` is refused with an
  error naming the fix: "identities come from the operator's runsModules
  binding; remove `as`". A module with no binding gets `CTX_CALL_UNBOUND`,
  as `ctx.call` does today.

### 4. Declared calls, enforced on the main thread

The premise that makes the peer path sound: one module per worker, and
every hop authorizes as that module's `runsModules` binding (no `as`, no
authorization as the caller's key). So a channel's identity is fixed per
caller worker, the broker sets it main-side at open, and the callee's check
that the invoked device is in the channel's grants is enough.

- Main already resolves a module's `countinghouse.calls` at load
  (composition verification). On every hop it checks the target (deviceID,
  serviceID, action) against the declaring module's resolved set, whatever
  API the module used, and refuses with `CTX_CALL_UNDECLARED`, the code
  `ctx.call` uses today.
- **Direct peer channels.** The broker already authorizes a channel once per
  `(identity, device)` (D3). It now also checks the declared set before
  opening, and the grant it records is keyed by the module's identity id,
  not a key. The callee worker checks each incoming invoke against the
  grants recorded for its channel, so no main round trip is added per
  invoke. Per-hop billing already goes to main (the metering request), and
  that request now carries the token, so a peer invoke can't be billed to
  anyone but the call's caller.
- The identity-less device query a worker makes to build a client
  (`queryDeviceForChild`) carries the token too, so a missing device can be
  answered with its typed reason to an authorized composite
  (`MODULE_UNLOADED` etc. instead of `DEVICE_INVOKE_EXCEPTION`), as the R2-1
  note from the reload work asks. Without a valid token it keeps today's
  generic answer.

### 5. Server-side storage

- **Job data** stores the owner's `id`, not the key. Ownership checks
  compare ids. The completion hook (stamping the output-schema hash) and
  billing at completion resolve the key through the identity index. Jobs
  stored before the upgrade with `apiKey` keep working: read either field,
  write only `id`.
- `--apiMonitor`'s Redis key names (raw key in the name) are left to the
  logger redesign, which retires the flag (already decided). R2-1 doesn't
  touch them.

### 6. The operator's lookup

- `POST /identity-lookup {id}` (admin only, like the other admin routes) and
  a matching authoring tool, `countinghouse_lookup_identity` (behind
  `--authoringTools`, admin only). Both return `{id, userName, isAdmin}` for
  an id this server issued, and `IDENTITY_NOT_FOUND` otherwise. Never the
  key.

### 7. The bundled examples

- `pre-installed-packages/composite-demo`, `perf-caller-demo`,
  `echo-device-client-module`, `examples/log-triage` and
  `examples/repo-review` drop their hardcoded `as` keys and rely on the
  `runsModules` binding the operator gives their internal identity (their
  `auth.json` files already declare it).
- Their bills print `billedTo: ctx.caller.id` instead of the user name, and
  keep `authorizedAs` as the internal identity's *label*. The verify scripts
  are updated to match.

### 8. Single-thread mode

There's no worker boundary in single-thread mode (no `--workerThread`):
module code runs on the main thread, and the docs already say that mode
gives no isolation. `ctx` has the same shape there (`{id, isAdmin}`, no key,
no user name, `as` refused, declared calls enforced on hops), so a module
behaves the same in both modes. Tokens aren't needed for the guarantee
there, but the plan may use the same code path for simplicity.

### 9. New codes

`CALL_TOKEN_INVALID` (a hop with an unknown, expired or foreign token) and
`IDENTITY_NOT_FOUND` (the lookup), in both locales of the error catalogue.
`CTX_CALL_UNDECLARED` and `CTX_CALL_UNBOUND` keep their meaning, and are now
also returned on paths other than `ctx.call`.

### 10. What stays open (the residual)

Tokens close the half where a worker states who to bill and who it is.
Declared-call enforcement closes the half where it states an undeclared
target. What can't be closed at this layer:

- **A module can use the authority of any call it is currently serving**,
  since it holds every in-flight `ctx`. While call A is open, its code can
  make hops billed to A's caller for work it does on behalf of call B. The
  hop is still limited to the module's own binding and declared calls, and
  still billed to a real caller of that module.
- **A module's worker runtime is fully readable and writable by the
  module.** Module code shares its worker's realm and `require.cache`
  (lib/fs-broker/identity.js: the runtime's own files are keyed by host
  path), so it can enumerate the cache, take any runtime module's exports,
  and read or replace their state and functions: the device manager's
  methods, the WorkerMessage send path, the peer channel's checks. Hiding
  `CHUtil.dm` and `CHUtil.ci` (Task 5) is tidying, not protection.
  Consequences:
  - **No key and no user name may remain anywhere in worker-side runtime
    state**: channel records, composition bindings, client caches and their
    cache keys, options. test/auth/30 walks `ctx`, `globalThis` and every
    `require.cache` entry's exports to enforce that.
  - A module that hooks its worker's send path can read the tokens of every
    call in flight in that worker. That's inside the first point (it
    already holds those `ctx`'s), and a token is bound to its worker, so a
    peer callee that reads a caller's token still can't use it.
  - **Worker-side checks are only as good as the worker.** A callee module
    can disable its own grant check, which only exposes itself. It can also
    skip metering-before-serve, serving calls into itself unbilled: a
    module can make itself free to call. That's a billing-integrity
    residual for the operator. The real fix is metering issued by the main
    thread when it brokers the channel, or per-invoke accounting on main: a
    follow-up, not R2-1.
  - Everything that protects **other** tenants and modules (whom a hop
    bills, which identity it authorizes as, which targets it may reach) is
    decided on the main thread, so it holds, including against phantom
    billing (below).
  - Isolating the runtime from module code (freezing `require.cache`,
    running module code in a separate context) is a possible later sandbox
    item, not R2-1.

This is documented in docs/security-model.md as the residual, alongside
"the operator reviews the module".

### 10b. Peer invokes are announced and matched

Main doesn't see peer invokes, so a malicious callee could send extra
metering requests citing a caller's token "for an invoke on that channel",
and bill the caller's tenant for hops that never happened. So:

- For each peer invoke, the **caller** worker sends main a non-blocking
  announcement `{channel, invokeId, token}`.
- Main accepts a callee's metering request only if it matches an unmatched
  announcement for that channel and invokeId. Each announcement is matched
  at most once.
- The two arrive on different ports with no ordering, so main holds an
  unmatched metering request for up to `PEER_ANNOUNCE_WAIT_MS = 1000` for
  its announcement, then refuses it (fail closed; the peer path meters
  before it serves, so no handler runs).
- A caller that suppresses its announcements gets its own calls refused,
  which fails safe.
- The cost is one extra one-way message per peer invoke, with no added
  serial latency except when the metering request wins the race.

### 11. Jobs whose owner is gone

A job whose owner is no longer in the auth config (removed, or a key rotated
on an entry without `id`) before it runs or bills fails `SYSTEM_ERROR_UNKNOWN_USER` when it comes to
run, and is not retried (it joins `NOT_RETRIED`).

## Compatibility and upgrade

- Breaking for module authors: `ctx.caller.apiKey` and `ctx.caller.userName`
  are gone; `as` is refused; `httpHeaders` lose the auth headers;
  `recordUsage` returns `id`. `docs/upgrading-to-8.md` gets a section with
  the before and after of each, and the CHANGELOG lists it under Changed
  (breaking).
- Not breaking for operators: auth config files, keys, grants and
  `runsModules` keep their format. New: the identity secret file (generated
  on its own), the optional `COUNTINGHOUSE_IDENTITY_SECRET`, and the lookup
  route and tool.
- Not breaking for MCP clients or HTTP callers, except the examples'
  `billedTo` value.

## How we'll know it works

- A test module that dumps everything it can reach (`ctx`, `args`, headers,
  `ctx.job.info()`, the result of `recordUsage`, the peer-channel open it
  receives, its process env) finds no key and no user name, in worker mode,
  and in single-thread mode where that applies.
- A module that sends its own hop message naming another key, or an
  undeclared target, or a stale or foreign token, is refused on both hop
  paths, and nothing is billed.
- A module calling `ctx.serviceClient` by raw deviceID to an undeclared tool
  is refused (`CTX_CALL_UNDECLARED`), and with `as` it gets the migration
  error.
- `id` is the same for a user across two modules, differs between users,
  survives a restart (same secret), and changes when the secret changes;
  `POST /identity-lookup` maps it to the user name for an admin and refuses
  others.
- Schedulers created before the upgrade are still listed and removable by
  their owner.
- Under `audit` and `enforce`, a module reading the auth config (directly,
  through a symlink, a `../` path or a hard link), the sqlite database or
  its side files, or the identity secret gets `EACCES`, and a denial is
  recorded. A module declaring `COUNTINGHOUSE_API_KEY` in its env
  permissions doesn't get it. Under `off`, none of this applies (asserted,
  so the table stays true).
- An entry with `id` keeps its `u_…` id across a key rotation. One without
  `id` gets a new one. Two entries with the same `id` are refused at load
  with their positions named and no key printed. An `id` equal to another
  user's key doesn't give that user's id.
- The direct-peer-channel path adds no main round trip per invoke (the
  existing peer benchmarks don't regress beyond noise).
- The full suite, the MCP contract tests and the bundled examples' verify
  scripts pass.

## Left to the builder (the plan decides)

- How each AuthProvider answers `id → user` (index on load, cache, or a
  stored column), without changing the auth config format.
- Where the token travels inside `ctx` so module code can't read it (a
  closure, a non-enumerable symbol property, or main-side keying by message
  id).
- The order of commits, so that each one leaves the suite green: the id and
  index first, then tokens, then enforcement, then removing the old fields.
- Exact error texts, in both locales.
