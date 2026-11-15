# Security model

This document describes the isolation and trust model countinghouse actually
implements today — not the isolation model a multi-tenant runtime would
ideally have. Where the two diverge, we say so plainly. An overstated
isolation claim is a worse security posture than an honestly-scoped one:
it invites integrations that assume guarantees the runtime doesn't provide.

## Threat model

countinghouse runs third-party npm packages ("device modules") as tools
callable by MCP clients and agents. The runtime treats these modules as
**semi-trusted, not sandboxed-for-arbitrary-code**: each module executes
with the privileges of the Node.js process's OS user, narrowed by an
in-process sandbox that is a strong barrier, not a hard boundary (see
below). There is no attempt to run modules from parties the platform
operator hasn't reviewed.

Since 8.0.0 each module runs inside its own `worker_threads.Worker` by
default (`lib/lean-worker.js`, spawned from `lib/module-manager.js`'s
`loadModuleByWorker`). `--no-workerThread` runs modules in the main thread
instead; that mode is for debugging modules and has no sandbox at all
([single-thread mode](#single-thread-mode-has-no-sandbox)). A worker gives:

- **An independent V8 heap and execution context.** A module's global
  variables, prototypes, and in-memory state are isolated from the main
  thread and from other modules' workers. A crash or infinite loop inside
  one module's worker does not directly corrupt another worker's heap.
- **A message-passing boundary.** Modules only reach the rest of the
  platform (device state, other devices, Redis, job control, files) through
  messages to the main thread: the `WorkerMessage` protocol
  (`lib/worker-message.js`) and the file bridge (`lib/fs-broker/`), with a
  fixed set of commands, not shared memory or arbitrary main-thread object
  references.
- **A device the worker cannot state.** The worker loads only the module's
  handler files and a small part of the runtime (the dispatcher, `ctx`, and
  a `CHUtil` facade whose helpers load on first use). A module's device is
  registered from the main thread's own reading of its `api.json` once the
  worker has loaded. The worker announces nothing, so module code cannot add,
  change or rename a device. `test/sandbox/43-lean-worker-files.js` lists
  every runtime file a worker may load.
- **Crash containment at the worker level.** `module-manager.js` listens for
  `worker.on('error', ...)` and `worker.on('exit', ...)` and unloads the
  corresponding module rather than letting a worker's end take down the
  whole process. Under `--moduleSandbox audit` and `enforce` the module is
  then restarted with backoff, or suspended after repeated exits; with
  `off` it stays down.

### What the module sandbox adds, and what it does not stop

The module sandbox is delivered in four parts. Part 1 (foundation, design in
[`superpowers/specs/2026-10-15-module-sandbox-foundation-design.md`](superpowers/specs/2026-10-15-module-sandbox-foundation-design.md))
and part 2 (file broker and virtual paths, design in
[`superpowers/specs/2026-10-17-module-sandbox-fs-broker-design.md`](superpowers/specs/2026-10-17-module-sandbox-fs-broker-design.md))
are what this document describes. They add layers on top of the worker
boundary, enforced **inside the same process as the code they restrict**:

> It is a strong barrier against accidents, buggy or exploited
> dependencies, and ordinary malware. It is not a hard boundary against code
> written specifically to defeat it.

One overlooked internal API, or one V8 bug, gets past the in-process layers.
Each layer below says what it stops and what it does not.

**Modes.** `--moduleSandbox off|audit|enforce`, default `audit`. The sandbox
needs worker mode; without it the mode is `off`. countinghouse 8 needs Node
22.16 or later. Below 24.15 a compatibility shim routes `require.resolve`
through the sandbox's hooks (`lib/resolve-shim.js`); multi-tenant hosting of
third-party modules should run 24.15 or later, where Node's own hook covers
it.

| | `off` | `audit` (default) | `enforce` |
|---|---|---|---|
| Virtual paths, file broker, bridge | yes | yes | yes |
| Link rules, main-thread protection | yes | yes | yes |
| Reads outside the namespace | pass through | pass through, logged | refused |
| Writes outside the module's own area (outside the namespace, `/app`, `r` paths) | pass through | refused (`EACCES`), recorded | refused |
| Disk quota | not counted | logged | enforced |
| Lockdown, resource limits, clean environment | no | yes | yes |

**On Windows** a module's files carry a drive (#195): the module sees them,
its current directory and its stack frames as `<V>:\app\...`, V a drive
letter the host does not have, picked once per process, because Node there
loads a file only by a URL with a drive (`file:///<V>:/app/...`). The
runtime names them `/app/...`, and the file broker maps `<V>:\app`,
`<V>:\data` and `<V>:\tmp` to `/app`, `/data` and `/tmp`, so every rule
above applies on Windows as it does elsewhere. With no free drive letter,
`--moduleSandbox enforce` refuses to start on Windows, saying so.

**On Windows, a module's declared host paths are not available yet**
([#204](https://github.com/mchen6/countinghouse/issues/204)): a declared
root is a host path, which there carries a drive, and the broker takes every
drive-qualified path as outside the namespace. Under `enforce` such a path is
refused (ENOENT): it fails closed. The module gets its own `/data` and
`/tmp`.

**Under `audit` a module changes nothing outside its own area** (Matt,
2026-11-15). Its own area for writes is its `/data`, its `/tmp` and what it
declared `rw`. Every write-class operation aimed anywhere else is refused
`EACCES` and recorded as a denial: an open for writing, a create or truncate,
`writeFile`, `appendFile`, `mkdir`, `rmdir`, `rm`, `unlink`, `rename` or
`link` with either end outside (a hard link's source included), a symlink
made outside, `chmod`, `chown`, `utimes`, `truncate`, and `copyFile` or `cp`
to an outside destination; writes to `/app` and to a path declared `r` too.
A symlink made inside the namespace that points outside it is refused
`EPERM`, in every mode, as before.

**Only `enforce` hides files.** Under `audit` and `off` reads outside a
module's namespace pass through to the host, except the always-denied set
and the protected paths above: under `audit` a module can read any other
file the OS user can -- the operator's project directory, the current
directory, `~/.npmrc`, `~/.ssh` -- and each read is logged. So don't run
untrusted packs under `audit` on a machine that holds secrets: use
`enforce`. In `audit` every check runs, a violation is logged once per
(module, rule, target), and a read goes ahead. In
`enforce` a violation is blocked with the error Node itself would throw
(`ENOENT`, `EROFS`, `ENOSPC`, `ERR_ACCESS_DENIED`, `MODULE_NOT_FOUND`) and
logged. Resource limits apply in `audit` as well, because logging a runaway
allocation does not stop it. `off` still runs the broker: modules see the
same virtual paths in every mode, and every file call is a hop to the main
thread ([measured cost](benchmarks/sandbox-part2.md)).

**1. Worker lockdown** (`lib/module-lockdown.js`, run once per worker before
any module code). Stops:

- native code: `process.dlopen`, the `.node` loader, `process.binding`,
  `process._linkedBinding`, and OpenSSL engines (`crypto.setEngine`, the TLS
  options `privateKeyEngine` and `clientCertEngine`);
- process controls: `process.kill`, `abort`, `chdir`, `setuid`/`setgid` and
  the like (`process.exit` stays; it ends only that module's worker);
- `require` of anything but built-ins and files inside the module's own
  directory (`MODULE_NOT_FOUND` otherwise);
- every built-in not on a written-out allowlist (Node 24.21's built-ins,
  less `child_process`, `cluster`, `worker_threads`, `inspector`, `v8`,
  `wasi`, `sqlite` (its `loadExtension` loads native code), `test` (its
  `run()` starts unsandboxed child processes), `sea`, `repl` and
  `trace_events`; Node 26's `ffi`, which calls native code, is not on it
  either; nor are Node's TLS internals `_tls_wrap` and `_tls_common` (a
  module needs `tls`), nor `_stream_wrap` on Node 24, whose
  `JSStreamSocket` extends the real `net.Socket` (Node 26 has removed
  it)), through `require`, `import()` and
  `process.getBuiltinModule` alike, so a built-in a later Node adds is
  refused until it has been reviewed; `module` is replaced by a reduced
  version (`builtinModules`, `isBuiltin`, a `createRequire` that stays inside
  the module's directory); `module.registerHooks`/`register` are locked so no
  later hook can run ahead of the boundary;
- other routes to files: `module.enableCompileCache`, `process.report`'s
  file output and `process.setSourceMapsEnabled` are locked;
  `process.loadEnvFile` goes through the file broker;
- adopting a descriptor (`net.Socket({fd})` or `net.Socket(fd)`,
  `net.connect({fd})` and `net.createConnection({fd})`, which an `http`
  request given an `fd` reaches through the agent (`https` goes through
  `tls.connect`, which reads no `fd`), `server.listen({fd})`, `tty`'s
  streams and the like, which in testing let a worker take over the main
  server's connections): refused under `enforce`, logged under `audit`.
  The `prototype.constructor` of `net.Socket` and of `tty`'s streams is the
  guard as well, not the real constructor behind it, and so is the
  constructor `tls.TLSSocket` and `tty`'s streams extend; a real
  `net.Socket` reached another way (Node's internal `JSStreamSocket`)
  builds only a TCP or Pipe handle from a descriptor, whose `open(fd)` is
  guarded (below). Each entry
  point copies its options once, by their own enumerable properties as
  Node's `Socket` constructor reads them (an inherited option is dropped),
  and checks the copy, so a getter cannot show the check one value and Node
  another; an array other than Node's own normalised arguments is read, as
  Node reads it, by its own properties. Behind them, `open(fd)`
  on the TCP, Pipe and UDP handle prototypes is locked in every mode. Under
  `--hardened`, where `process.binding` is refused, the prototypes are taken
  from instances the lockdown builds and destroys before module code runs.
  If one cannot be taken, the module does not start under `enforce`, and
  `audit` logs it. A handle *object* given to `net.Socket` is not adoption:
  a handle a module can build is guarded at its `open(fd)`, and the handle
  Node's own TLS machinery hands in (`tls.connect`, `https`, `fetch`) is over
  a socket the module was allowed to open, so TLS client connections work
  under `enforce` as under `audit`, `--hardened` included. `server.listen`
  stays strict and refuses a handle as well (a TCP, Pipe or UDP handle,
  the kinds whose `open(fd)` is guarded; Node's `listen` takes a TCP handle
  as one and reads another's descriptor): a module has no need to listen
  on one;
- the Redis endpoint (R2-1, part 2: `--redisUrl`'s host and port): refused
  with `EACCES` in `audit` and `enforce`, under its configured host in every
  spelling of that address (`10.5` for `10.0.0.5`, and its IPv4-mapped and
  IPv4-compatible forms), an empty host (Node's `localhost`), any 127/8,
  `0.0.0.0`, `::1` or `::` literal in every form the resolver accepts
  (`127.1`, `2130706433`, IPv4-mapped or -compatible), a port in any string
  form Node reads as a number (`'0x18eb'`), and the loopback names
  (`localhost`, any name under `.localhost`, `localhost.localdomain`,
  `localhost4`, `localhost6`, `localhost4.localdomain4`,
  `localhost6.localdomain6`, `ip6-localhost`, `ip6-loopback`). A
  Unix-socket Redis is refused under every spelling of its path (`..`,
  `//`, relative). A host given by a name is refused by that name, and by
  every address the main thread resolves it to (the system resolver and DNS
  together, before the first module loads and every 5 minutes; an address
  once denied stays denied, and a running worker is told each new one), at
  the socket's own handle, which decides on the address Node actually
  connects to, on functions taken before any module code ran (#206, #207).
  That address check is what holds. The check by name runs in the module's
  own realm: it, too, calls only functions it took at load and reads no
  value through a module's accessor or conversion, but code that shares a
  realm can always be attacked by what it has not thought of, so it is a
  first line, not the one relied on. This is an in-worker check, not a
  boundary: a name that reaches loopback only through `/etc/hosts` or DNS,
  a `lookup` function the module passes, another address of the same
  machine (a LAN IP), an address of the Redis host name that no resolution
  has returned yet (a round-robin name with more addresses than an answer
  lists, a name that moved, or one that did not resolve at start until the
  next refresh reaches the worker), and a symlink or hard link to the
  socket are not denied until the network broker (parts 3 and 4);
- `CHUtil.loadFile` outside the module's own directory.

Each override is non-writable and non-configurable. `net`, `http` and the
like stay usable until parts 3 and 4; the first `require` of each is logged
(as "uses") so operators learn which modules will need permissions.

**2. The file broker and the virtual namespace** (`lib/fs-broker/`). Before
any countinghouse or dependency code loads, the first statements of
`lib/lean-worker.js` replace every method of the worker's `fs`, `fs/promises`
and `FileHandle.prototype` with locked versions that send each call to the
main thread. There one broker per module checks it and runs it with Node's
async `fs`. Synchronous calls wait on shared memory; the main thread never
blocks. The list fails closed: a key a later Node adds throws until it has
been reviewed. Watching (`fs.watch`, `watchFile`, `promises.watch`) answers
`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.

A module sees its own namespace, in every mode:

| Virtual path | Host path | Access |
|---|---|---|
| `/app` | the module's install directory | read-only: `EROFS` under `enforce`, `EACCES` under `audit` |
| `/data` | `<moduleDataPath>/<name>/data` | read-write, quota, kept across restarts |
| `/tmp` | `<moduleDataPath>/<name>/tmp` | read-write, quota, emptied when the worker starts |
| each declared path, e.g. `/var/log/app` | the same host path | `r` or `rw` as the operator's policy narrows it; no quota |

`<name>` is the package.json name the main thread verified. A load whose
request name differs from it is refused in every mode
(`MODULE_NAME_MISMATCH`), so code cannot be loaded under another module's
name to get its policy entry and data. `__filename`, `__dirname`,
`require.resolve`, `require.cache` keys, `import.meta`, stack frames,
`process.cwd()` (`/app`) and `os.tmpdir()` (`/tmp`) are virtual, and so are
paths in results and errors. Ancestors of a root (`/`, `/var`) answer as
read-only directories that list only the way to the root. A declared path
can never cover countinghouse's own directories (the install directory,
`--modulePath`, `--moduleDataPath`, the auth and device-config paths, the
policy file) or an ancestor of one: such a declaration is refused in every
mode and logged at spawn.

Beyond declarations, every path in those directories -- every module's code
(`--modulePath` and each `--loadModule` directory) and data
(`--moduleDataPath`, also while a module is being validated), the local
store, the auth and device configuration, the policy file -- and in
ch-local's home (the
directory of `--settingsFile`: its settings, the daemon's session secret
under `run/`, the launcher, the pack records) is refused to a module's reads
and writes under `audit` and `enforce` (`EACCES`, recorded), however it is
named: directly, through `..`, a symlink or a hard link to the settings
files. The one exception is the module's own `/app`, `/data` and `/tmp`, by
their real paths at spawn. A listing never shows them, and neither they nor
any directory above them can be renamed or removed. The install directory is
the exception: it is countinghouse's public code and stays readable under
`audit`, except its top-level dot entries (`.git`, `.env*`, `.npmrc`,
`.claude`, any other) and a top-level `auth.json`, which are refused to reads
and writes under `audit` and `enforce` as the rest is. Keep no other
secrets in it.

For each call the broker translates the virtual path, decides by mode, then
checks the host: the real location must lie inside its root, compared with
roots resolved at spawn. Under `enforce` every opened descriptor is then
verified (its device and inode, and on Linux `/proc/self/fd`) against that location,
so a path swapped for a symlink between the check and the open is closed and
answered `ENOENT`. Mutating calls take a per-module lock exclusively and
every other call shares it, so a module cannot race its own checks. The
broker caches directory real paths for up to 1 s; every mutating call
clears the cache first, and opened descriptors are still verified without
it.

In every mode: `link()` works only within one writable root; `symlink()`
takes only a relative target with no `..` segment, and only when the target
really leads inside its root, following any link on the way (an absolute
target, a `..`, or a target that leads outside is `EPERM`); `chmod` strips
setuid, setgid and sticky bits; a cross-root
`rename` answers `EXDEV`. Under `enforce` a module whose `/data` or `/tmp`
holds a symlink with an absolute target, or a hard link to a file that also
has a name outside its `/data` and `/tmp`, does not start until the operator
removes it (the log names the entries). The disk quota (`diskMb`, `diskEntries`, one pool for
`/data` and `/tmp`) answers `ENOSPC` under `enforce`.

The main thread is protected in every mode: the thread pool is raised to 16
unless the operator set `UV_THREADPOOL_SIZE`, brokered operations in flight
are capped globally and scheduled round-robin across workers, each worker
has a queue of 4096 (`EMFILE` past it) and at most 256 descriptors, and a
transfer is at most 16 MB, with `readFile` served in chunks. A brokered call
that takes over 30 s answers `ETIMEDOUT`.

**3. The bounded loader** (`lib/fs-broker/identity.js`). Node's loader reads
files through the same `fs`, so the loader hooks decide that traffic. Module
code resolves to virtual `file:///app/...` URLs. Before the worker's
`set-options`, while only countinghouse's own boot runs, it reads only its
code roots; anything else it touches is answered `ENOENT` and logged once as
countinghouse's own, in every mode. From `set-options` on, every resolve is
bounded, whoever the parent is: module
code reaches only its own root, and countinghouse's code reaches only its own
code roots plus the module root. That closes `module.parent.require`,
`require.cache[...].require`, `Module._load`, and the `vm.Script` dynamic
`import()` referrer as routes to files, which part 1 left open. The original
`fs` is used only for the loader's lookups under those roots and for the one
file being loaded; everything else goes to the broker with the module's
rights. Under `enforce` the loader's own lookups (`Module._stat`,
`package.json` reads) answer "missing" outside those roots too.

countinghouse's code roots are its own entries and the package directory of
each package in its dependency closure, found the way Node finds them, so an
npm install that hoists them into the project's `node_modules` works. A
dependency installed as a symlink (pnpm, a linked `node_modules`) is a root
under both the name Node looks it up by and its real path. They are never a
whole `node_modules`: modules are npm packages too, and may sit beside
countinghouse's dependencies. A module root is subtracted from the list.

countinghouse installed under `/app` is refused at startup under
`--workerThread` (exit 2). Precisely, code countinghouse itself loaded may
not live under `/app`: Node keys loaded code by path, so it would share
entries with modules' `/app` files, and a module could be handed
countinghouse's own module objects. Modules and data under `/app` are fine.

**4. Declared permissions and the operator policy.** A module declares
`countinghouse.permissions` (`fs`, `net`, `env`, `limits`) in its
`package.json`; the operator's `--modulePolicy` file can only narrow that,
never widen it (a wider entry is reported and ignored). `fs` (outside paths,
`r` or `rw` each), `env` and `limits` take effect; so does the host check on
`CHUtil.request` described below. The rest of
`net` is parsed, validated and logged as effective permissions, and takes
effect when parts 3 (HTTP broker) and 4 (TCP/TLS relay) ship.

**5. Load-time checks and the validator** (`lib/module-tree-check.js`,
`countinghouse-validate`). A module must be self-contained (every dependency,
through the whole tree, resolves inside the module's directory), must not
contain native code (`.node`, `binding.gyp`, `"gypfile": true`), and must
have valid permissions; install scripts are warned about. In `enforce` a
failing module is refused with `MODULE_SANDBOX_REFUSED`; in `audit` the
failures are logged and the module loads. This is a structural check of
what is on disk at load time, not a review of what the code does.

**6. Resource limits, restart and suspend.** `heapMb` (V8 `resourceLimits`,
with a 64 MB young generation and a 4 MB stack beside it), `externalMb` (the
main thread polls the worker's external memory and terminates it over the
limit) and `maxBlockMs` (the main thread pings the worker and terminates it
if a ping goes unanswered for that long), checked every second or twice per
`maxBlockMs` if that is shorter, each with a 256 / 256 / 10000 default
ceiling. Time a worker spends waiting on a brokered file call does not count
as blocked. A worker-to-main message rate limit (`--moduleMessageRate`,
default 2000/s) answers excess messages with `RATE_LIMITED` instead of
killing the worker; file traffic has its own budget (layer 2). Every message
a worker sends the main thread, the file bridge's included, crosses as an
envelope of serialized bytes whose length the main thread reads before it
decodes anything: over `--maxOutputBytes` plus 64 KiB (16 MiB plus 64 KiB on
the file bridge) it is refused in the worker (`MESSAGE_TOO_LARGE`, or
`EINVAL` for a file call), and under audit and enforce the lockdown pins the
worker's ports, so module code that patches `MessagePort.prototype` is never
handed one. A message that is not an envelope, or one over the cap, is a
tampered worker's: the main thread ends the worker (a bridge call is
answered `EINVAL` and reported, and the worker is ended too). Module code
gets no port by any other route either: the runtime's port callbacks run in
a scope of their own (`lib/port-scope.js`), and the lockdown leaves ports
out of `process._getActiveHandles()` and `_getActiveRequests()`,
`async_hooks.executionAsyncResource()` and an async hook's `init`, and pins
Node's own stdio port as well. What remains rests on those: Node decodes a
posted message on receipt and, when a worker ends, every message it had
queued, so a worker that did hold a port could have any number of messages
decoded (20 of 5 MB each, all decoded after `terminate()`, measured on Node
24.21; removing the listeners or closing the main side's port does not stop
it), and that serialized data lies outside the worker's heap limits. Under
`off` there is no lockdown and the bound is cooperative only; a direct peer
channel between two workers is not enveloped. A worker that ends
unexpectedly is restarted after 1 s, then 2 s, and suspended on the 3rd exit
within 10 minutes (the code caps the delay at 60 s, which the current
threshold never reaches); calls get `MODULE_RESTARTING` or
`MODULE_SUSPENDED` while the tools stay listed. A deliberate reload or
unload fails its calls in flight with `MODULE_RELOADING` or
`MODULE_UNLOADED`. Why a device is missing is told only to a caller that
passes the access check for it, so a key without access cannot learn whether
a device was ever hosted. When a worker ends, its file operations in flight
answer `EIO` and its descriptors close; a per-name lifecycle lock makes the
next start (and an uninstall) wait for them. This bounds memory, blocking,
disk use and crash loops. It does not bound CPU use that yields to the event
loop, or network traffic.

A module's stdout and stderr are bounded the same way. Under audit and
enforce the lockdown gives module code runtime-owned streams for
`process.stdout`, `process.stderr` and `process.stdin` (fixed getters),
points `console` and `process._rawDebug` at them, and Node's own stdio
streams, which hold its port to the main thread, are never handed out
(assigning `process.stdout` is refused: a `TypeError` in strict mode, a
no-op otherwise). What a module writes crosses as messages, as lines: each
stream has 256 KiB a minute of what is written, each line charged its
`<module>: ` prefix, its bytes and its newline (counted in the worker; the
main thread counts again, with twice that as a backstop, since the two
sides' windows do not line up), past which lines are dropped, output that
could not be sent is counted with them, and one line a minute says how much
(`<module>: N bytes of stdout dropped`); each line is cut at 8 KiB, stripped
of control characters other than tab, the line separators and the bidi
controls, and written prefixed with the module's name, to stderr under
`--stdio` (stdout is the MCP channel there). The worker's own log
(countinghouse's code in the worker) crosses as records under a budget of
its own, 1 MiB a minute, each record charged 256 bytes plus its fields, each
field cut at 8 KiB and cleaned the same way and the module named by the main
thread, in every mode. Under `off` a module's output goes to the process's
streams as before, unbounded.

**Uninstall.** `POST /uninstall-module {name, keepData}` (admin key) removes
the registry entry and deletes `<moduleDataPath>/<name>` unless `keepData`,
never following links. It refuses while the module is loaded, restarting or
suspended, and never removes the module's code under `--modulePath`.
Unload, restart and reload never delete data.

**7. `--hardened`.** Re-launches the server under Node's permission model
(`--permission`) with read access to the install directory, `--modulePath`,
`--moduleDataPath` and the configured config files, and write access to
`--modulePath`, `--moduleDataPath` (and the SQLite auth directory). This
applies to the whole process, **main thread included**, so it limits what
any module can reach on the host even under `audit`, but cannot separate a
module from countinghouse's own data in the directories the process may
read. Every module must live under `--modulePath`. Node 24 has no network
permission; Node 26 has one, and `--hardened` passes `--allow-net` there
(experimental in Node 26), so on every supported Node the network is
unrestricted under `--hardened` until the network broker, and outbound
network is left to the OS. A systemd unit example is in
[the example below](#hardening-with-systemd).

### The local store (`--store local`)

`--store local` keeps what the runtime held in Redis in files under
`--storePath` (default `<moduleDataPath>/../store`, outside every module's
namespace) and in memory, and opens no socket of its own. The directory is
the owner's only (0700) and each file too (0600); every write is a temp
file renamed into place under `<storePath>/.lock`, merged by key, so
several processes may share the store. No file under it holds an API key:
metering without `--meter` records calls in memory only, and with
`--meter` `metering.json` keeps each key's balance and free calls under
the key's fingerprint (a full, domain-separated sha256). The seeding
command, `countinghouse-meter`, reads the key from
`COUNTINGHOUSE_SEED_KEY`, never from its arguments, and prints only the
fingerprint.

In the single-identity profile (`--store local --stdio` without
`--authConfigPath` or `--authProvider`) no auth file exists. The one key is
made at start, read-only, and no file holds it: the runtime never prints,
logs or writes it, keeps it out of the options a worker receives, and
leaves it out of every answer the auth provider gives, a refusal of another
key included. Module code never sees it: since R2-1 a module gets the
caller as its opaque id (`ctx.caller = {id, isAdmin}`), and a composing
module's binding stays on the main thread. Every loaded module runs as that
identity, which is not admin. The runtime's caller id for it comes from the
identity secret, `<storePath>/.identity-secret` (0600, in the always-denied
set; the store directory is a path no module may declare), and the fixed
source `local`, so it survives a restart while the key changes per
process. A multi-tenant `--store local` server keeps its secret under
`<moduleDataPath>`, so moving to the local store changes no user's id.

### The operator's ceiling (guarding settings)

An operator can bound what anyone on the machine may loosen, through a
conversation or the `ch-local` command, with an optional, machine-wide file:
`/etc/countinghouse/ceiling.json` on Linux and macOS,
`%ProgramData%\countinghouse\ceiling.json` on Windows.

```json
{"version": 1, "maxOutputBytes": 16777216, "requestTimeout": 60000,
 "forbid": ["moduleSandbox", "autoUpgrade"], "packs": ["ci-failure-triage"],
 "conversation": false}
```

Every key but `version` is optional: `maxOutputBytes` and `requestTimeout`
lower the hard bounds (`requestTimeout` in whole seconds, as milliseconds:
the runtime takes seconds, so any other value fails closed); `forbid`
refuses loosening the sandbox or turning automatic upgrades on; `packs` is
the operator's allowlist of packs: when present, only those packs ever
load, at start, in place and on install, whatever `settings.json` or the
history say, and installing another is refused; `"conversation": false` refuses every
loosening asked for in conversation, so no dialog is ever shown and each
ends at the terminal command (below). A value above it is
`SETTING_ABOVE_CEILING`, a loosening it forbids `SETTING_FORBIDDEN_BY_CEILING`.
Tightening is never refused by it. It is read once per process, and again
when the file changes.

It is trusted only when an ordinary user cannot have written it: on Linux and
macOS the file is not a symbolic link, and it and every directory up to `/`
(by real path) are owned by root and not writable by group or others; on
Windows the directory and the file are owned by, and writable only by,
Administrators, SYSTEM or TrustedInstaller (by SID), and ProgramData is
the system's known folder, not the caller's `%ProgramData%`. A directory
made under ProgramData inherits a write right for Users, so the operator
removes it (`icacls "%ProgramData%\countinghouse" /inheritance:r /grant
Administrators:F SYSTEM:F Users:RX`). Both must stay readable by every user
(`0755` and `0644` on Linux and macOS). A file that exists and fails any
check, or holds anything else, **fails closed**: every loosening is refused
(`SETTING_CEILING_UNTRUSTED`), naming the file and why; so does a
`countinghouse` directory an ordinary user could have made, even with no
file in it. No directory and no file: the hard bounds apply. On Windows the
ACL is read by the PowerShell in the Windows directory, started by its full
path with a minimal environment. Not checked, because each needs root or an
administrator to set: macOS extended ACLs (`chmod +a`). A Windows
conditional access rule, which the ACL's rules do not list, fails closed.

On Windows, `--hardened` cannot verify the ceiling, so no loosening is
allowed: the permission model refuses the PowerShell the ACL check needs, the
ceiling reads as one that cannot be trusted, and it fails closed. (The
identity secret is checked by the `--hardened` parent before it relaunches
under the permission model; the child takes that same file only, unchanged.)

Two limits. `<home>/history.jsonl` is a record for the user, not a security
boundary: the user can write it, so nothing the ceiling enforces rests on
it. And ch-local reads the ceiling with the runtime installed under its
home (`app/node_modules/countinghouse`): whoever can replace that code is
beyond any ceiling, as they are beyond the runtime itself.

### Confirming a loosening in the client's dialog

A loosening asked for in conversation could come from a prompt injected
through a tool's result, not from the user. So `countinghouse_settings`
never applies one on the model's word. A raised `maxOutputBytes` or
`requestTimeout`, or a pack turned on, is either confirmed by the user in
their client's own dialog (an MCP elicitation form) or refused with the
`ch-local` command the user runs at a terminal. Loosening the sandbox or
turning on automatic upgrades is terminal only.

A dialog is shown only when all of these hold:

- **A tested client.** The client's name and version are inside a range on
  the tested-client list (`lib/elicitation-clients.json`). A range names
  exactly the versions tested, with no open range, so a new version gets no
  dialog until it is re-tested. The list ships empty: until the
  maintainer's hand test before release
  ([`docs/development/elicitation-hand-test.md`](development/elicitation-hand-test.md))
  adds the first range, no client sees a dialog. After that, the automated
  re-test of each new Claude Code version (not built yet) will open the pull
  request that adds its range.
- **The request declares form elicitation.** The capability is read from
  the request itself, never inferred from earlier ones.
- **Nothing in the client's own configuration could answer the dialog.**
  Before every dialog the runtime asks ch-local, which scans the client's
  configuration (ch-local's `docs/development/settings.md`). Any
  Elicitation or ElicitationResult hook in any scope, whatever its matcher,
  means no dialog. So do a plugin a project brings, an installed plugin's
  hook, a flag on the client's command line not known to be safe, and an
  environment variable naming a plugin or settings source the scan does not
  read. Anything it cannot read also means no dialog. A hook seen once holds
  for the whole start, and the scan runs again before every form. No answer
  from ch-local within 5 s is no.
- **The operator's ceiling allows it,** and does not set
  `"conversation": false`.
- **Not declined or ignored.** A decline (a cancel counts as one) stops
  dialogs for that setting until the next start, every pack counting as
  one setting. So do two dialogs left unanswered. A start shows at most
  three dialogs.

The dialog has one checkbox and no default. Its text is built from the
change alone, naming the current value (and a pack's version, from
`packs.json`); no text from the model appears in it. The model's arguments
cannot carry the answer: `requestState` and the user's answer are read only
from the request's own parameters. `requestState` carries only a random
nonce and an HMAC, under a key held in memory for this start, binding the
MCP session and the exact change; it is single use and expires after
120 s. Only an explicit accept applies the change. The client's conditions,
the current value, the ceiling and the decline lock are all checked again
first, the history line is written before the change, and `settings.json` is
never written: the change ends when the client restarts countinghouse. What
was applied, or could not be, is told to the user as a notice (on the next
result of any tool, and as an MCP `notifications/message`).

What this does not cover:

- **MCP does not promise that a person answers the dialog.** The
  specification lets a client answer an elicitation as it likes. The tested
  list and the configuration scan narrow that to clients and set-ups where
  a person has been seen to answer it; they do not make it a guarantee.
- **A client that lies about its name.** The list bounds honest, untested
  clients, not spoofers. A script that starts its own runtime and answers
  its own dialog loosens only that runtime: "this start" is one runtime
  process.
- **The interactive-session check** (`CLAUDE_CODE_ENTRYPOINT=cli` and
  `CLAUDECODE=1`) stops honest unattended hosts only: a session nested under
  a shell inherits them.
- **Sources the scan does not know.** The scan follows the known parsing and
  sources of the Claude Code version tested. What a later version adds is
  covered by the exact-version list and the automated re-test's diff of its
  configuration surface, not by the scan itself. Hooks in a skill's,
  subagent's or command's front matter are found by a plain-text scan
  (any mention of the events, or anything that could spell one without the
  plain word, means no dialog), not by parsing.
- **The user's full fix** is Claude Code's managed setting
  `allowManagedHooksOnly`, which stops hooks outside managed settings from
  loading at all. The scan does not rely on it: a project hook still means
  no dialog.

### What this explicitly does NOT provide (accepted gaps and limits)

The following are known, accepted, and not hidden by the layers above.
The sandbox isolates modules from each other and from tenants' data inside
one process; it does not isolate countinghouse from the host. Run it as an
unprivileged user in a container with limits and the default seccomp
profile: [deployment.md](deployment.md) gives the posture, a reference setup,
and the short list of what the in-process sandbox cannot give.

- **A module is handed no API key and no user name (R2-1).** `ctx.caller` is
  `{id, isAdmin}`, an opaque id (an HMAC of the key, or of the entry's `id`
  field, under a server secret) and the admin flag; `httpHeaders` lose
  `X-CH-Key`, `X-App-Key` and `Authorization`; a module's hops, device
  queries, peer invokes and remote calls carry a per-call token the main
  thread issued for the call, bound to the worker, never a key; the
  composition binding stays on the main thread. What remains is what the
  module sandbox modes already say: under `audit` and `off` a module can
  read files and environment outside its namespace (the always-denied set
  is refused under `audit`), and module code can reach the runtime's
  objects in its own worker (next item) -- which since R2-1 hold no key.
  The residual: a module holding two calls at once can bill one call's hop
  to the other call's caller (both are its callers); it cannot name a third
  party.
- **Module code can reach countinghouse's objects.** Part 2 closes the file
  routes through countinghouse's loader (layer 3), not the objects
  themselves: through `require.cache`, `CHUtil` and the like, module code can
  still use modules countinghouse loaded before the lockdown, and read
  countinghouse's own code files. `CHUtil` and everything else loaded before
  lockdown stay part of the review checklist for every change to
  `lib/countinghouse-util.js`. postman-request, behind `CHUtil.request` and
  a remote service client, loads on its first use instead
  (`lib/lazy-require.js`), after module code has run, so a module can plant
  `require.cache` entries for it in its own worker first. That reaches only calls made in that worker, which carry the
  keys the module itself passes; the library is loaded once and kept, so
  nothing planted after its first use is read.
- **Module code can talk to the main thread as if it were countinghouse.**
  The worker's own channel to the main thread is reachable from module code
  (through `require.cache`, `CHUtil.redis.clientInstance`; the global
  `CHUtil` no longer carries `ci` or `dm`, which is tidying, not a
  boundary), so a module can send any worker message itself. (A
  worker holds no metering provider, so these objects give no handle on the
  balance ledger.) The main
  thread therefore bounds those messages on its own side:
  `--moduleMessageRate` applies to all of them except two, each bounded
  differently. Violation reports are capped at 100 per worker. A
  `peer-self-invalidate` is acted on at most once per event-loop turn. A
  refused `peer-channel-request` is answered with a `RATE_LIMITED` deny.
  The file broker gives every request the module's rights, whoever sends it,
  so this does not reach files. Nor does it reach identity or billing
  (R2-1): the main thread authorizes and bills every hop, device query,
  peer invoke and remote call by the call's token, which names who pays
  and which binding authorizes, never by anything the message states, and
  refuses a target outside the module's declared calls
  (`CTX_CALL_UNDECLARED`) whatever route the module took.
- **A module's messages to the main thread are bounded, with a residual
  (#170, #186, #190).** Every worker-to-main message is sent as bounded,
  transferred bytes, the main thread reads its length before decoding, and a
  worker whose message is not an envelope or is over the cap is ended; the
  module's console output and its worker's log are capped. Under audit and
  enforce module code is never handed a port to the main thread. What
  remains: Node decodes a posted message on receipt, so a worker that did
  hold a port could have every message it queued decoded, even after it is
  ended; under `off` the bound is cooperative only.
- **No network permission is enforced yet.** A module can open outbound
  connections with `net`/`http`/`https`/`fetch` until parts 3 and 4,
  including to Unix-socket paths (`net.connect(path)`,
  `http.request({socketPath})`), which the file namespace does not cover.
- **The `CHUtil.request` host check is not the network boundary.** The check
  on `CHUtil.request` governs only that
  convenience route. Code running in the module's worker can also interfere
  with objects in that same worker, including the wrappers themselves. The
  network boundary is part 3's main-thread broker, not this check. Under
  `enforce`, `CHUtil.request` accepts only an allowlist of options and
  refuses `baseUrl`, `proxy`, `har` and the like, so that the host checked is
  the host contacted; redirects are checked hop by hop.
- **Under `audit` and `off`, nothing outside the namespace is hidden.** A
  module may read outside paths (under `audit` it may not write them), the
  loader's lookups answer truthfully, and a module may learn whether a host
  path exists, and its type. Under `enforce` those lookups answer missing.
- **Host processes can race the checks.** A process outside countinghouse
  writing inside a module's data directory or a declared path at the same
  moment can swap a path between the broker's check and the operation. Under
  `enforce` an open that lands outside is caught by the verification after
  open; a `stat` or other non-opening call can see the swapped target. The
  broker caches directory real paths for up to 1 s, so a host process's
  change, or another module's change in a shared `rw` directory, can go
  unseen for that long; under `enforce` every open is still verified. The
  other module cannot make a link that leads outside the root (the link
  rules: no `..`, so a link leads only into its own directory, however that
  directory is later renamed), so a stale entry cannot either. A link a host
  process made, or one made before 8.0.0, is not covered by that.
- **Host paths leak in one place.** For a CommonJS file imported directly by
  an ES module, Node 24 gives `__filename` and stack frames the host path.
- **Descriptor and handle adoption is refused only under `enforce`.**
- **HTTP/2 `respondWithFile` is not available** to modules in any mode: it
  hands the descriptor to native code, which cannot read a brokered one. Read
  the file with `fs` and stream it.
- **Module-facing descriptor numbers are `0x10000000 + n`,** not small
  integers, so a brokered descriptor cannot be mistaken for a real one.
- **The quota is approximate in the safe direction.** Concurrent writes that
  extend one file can each count the growth, so a module can be refused
  before it is really over.
- **A stuck host operation delays a restart by at most 35 s.** After that
  the next start goes ahead and logs what was still running; a late write
  can land in the fresh `/tmp`, or leave the quota count a little off.
- **The worker's environment holds only approved variables** (in `audit`
  and `enforce`). That includes no `NODE_PATH`, so a module cannot reach
  countinghouse's `lib/` by bare name. Under `enforce` `/proc/self/environ`
  is outside the namespace too; under `audit` and `off` a module can still
  read the process's whole environment there, unless `--hardened` is on.
- **`--hardened` limits.** Node's permission model follows symlinks, so a
  symlink inside `--modulePath` that points elsewhere is readable, and write
  access covers all of `--modulePath` and `--moduleDataPath` (including other
  modules' directories and the module registry database). `--allow-addons`
  is added for the SQLite auth provider, or whenever no `--loadModule` is
  given (the module registry database uses `sqlite3`); it puts native code in
  the **main thread** outside the permission model. It does not cover
  Node 26's `node:ffi`: under `--permission`, `ffi.dlopen` needs its own
  `--allow-ffi`, which `--hardened` never passes, so on Node 26 FFI is refused
  by the permission model for the whole process, beneath the built-in
  allowlist that already refuses `node:ffi` to module code (checked on
  26.13.0: `ERR_ACCESS_DENIED`, `permission: 'FFI'`, with or without
  `--allow-addons`). `--allow-child-process`
  is added when `--authoringTools` is on (`countinghouse_validate_module`
  runs the module in a child process), which lets the whole process start
  children outside the permission model. `--allow-worker` is always added,
  and Node documents that as weakening the model. Node's permission model
  also has a bug ([nodejs/node#66812](https://github.com/nodejs/node/issues/66812),
  Node 20-26): operations on a granted directory are refused when another
  grant extends its name (`/x/countinghouse` beside `/x/countinghouse_data`,
  `redis` beside `redis-commands`), and from Node 24.22 a synchronous
  `realpath` is refused too, a form found after the issue was filed.
  countinghouse resolves its own granted directories in the unrestricted
  parent before relaunching and hands the results to the server, so its
  startup is not refused; the grants are the same. Before relaunching it
  also checks, under the real grants, any granted directory it did not
  resolve, and if Node would refuse it, exits with status 2 naming the
  overlapping paths. **`--hardened` does not support pnpm installs** until
  the bug is fixed: Node's own module loader resolves pnpm's dependency
  links, whose names extend each other, and is refused. npm installs and a
  symlinked `node_modules` work under `--hardened`, and pnpm installs work
  without it.
- **Resource limits can misfire.** When the main thread's own check runs
  late (a long synchronous task, or a paused VM), it restarts the clock
  instead of blaming the worker. A main thread that is busy without
  stalling, with a backlog of messages ahead of the reply, can still make a
  healthy worker look blocked under a small `maxBlockMs`, and it is then
  terminated and restarted.
- **Uncaught exceptions in a worker do not end it.** `lib/lean-worker.js` catches
  and logs them, as it always has. The restart policy applies to workers
  that actually end: `process.exit`, the heap limit, kills by the external
  memory or blocked-loop limits, and worker errors.
- **A restart refused under `enforce` suspends the module at once.** If
  `package.json` or the policy changed so that the module no longer passes
  (for example it gained a native dependency), the restart is refused with
  `MODULE_SANDBOX_REFUSED` and the module is suspended without retries. An
  operator `POST /restart-module` tries again.
- <a id="single-thread-mode-has-no-sandbox"></a>**Single-thread mode has no
  sandbox.** Under `--no-workerThread` modules run in the main thread with
  the process's full privileges. They still see `/app`, `/data` and `/tmp`
  through `fs`, `fs/promises` and `os`, but that only translates paths: no
  checks, quota or link rules, and a module can require countinghouse's own
  dependencies through `NODE_PATH`. Nothing the main thread keeps from
  modules is kept from them there: a call's `Session`, including the
  shared runtime's session id on it, its call tokens and every other main-
  thread state are in reach. It is for debugging modules
  ([differences](module-development.md)).
- **No OS-level isolation.** `worker_threads` share the same process, same
  OS user and same network stack as the main thread. Outside `--hardened`
  the main thread can open any file the OS user can.
- **Native code in the main thread is outside all of this.** The lockdown
  stops module code from loading native addons; the server's own addons
  (`sqlite3`, when used) are not constrained.
- **Everything runs in the same process as the code it restricts.** A bug in V8, in Node's loader hooks, or
  an internal API this work overlooked gets past it. Operators who run code
  from parties they have not reviewed need a process, container or VM
  boundary on top (see the comparison below).
- **No code-signing or provenance check.** See `countinghouse_validate_module`
  below: "validate" means structural conformance, not authorship or
  integrity attestation.

### Remote MCP servers: a module cannot choose where a credential goes

A module may declare one remote MCP server (`countinghouse.remotes`) and
call it with `ctx.call('remote:<name>/<tool>', args)`. The connection is
the main thread's, not the module's (spec:
`docs/superpowers/specs/2026-11-11-rc1-min-remote-mcp-design.md`):

- **The credential stays on the main thread.** It is read from the
  environment at load, held in the client's request headers, and never
  put in a worker message, the worker's environment, a log line, an error
  message or a result. `COUNTINGHOUSE_*` variables are still never handed
  to a worker; a remote's credential may be one of them, because only the
  main thread reads it.
- **The threat it answers.** A declaration is the module author's, and the
  token is the user's. If the declaration alone decided what is read, any
  installed module could name `GITHUB_TOKEN` and a `url` of its own, and
  the runtime would send the user's token there: exfiltration by
  declaration, with no code. So the operator's `--remoteCredentials` file
  says which variables may go to which origin (scheme, host and port,
  matched exactly), and a credential is sent only where the declared URL's
  origin is allowed that variable. A variable the file does not allow
  there is not read, and the remote is not contacted at
  all (`REMOTE_CREDENTIAL_NOT_ALLOWED`). Without the option no credential
  is ever read. The client packs' `ch-local install` writes the file from
  its allowlist, so for the single local user the user is the operator.
- **What a remote can reach.**
  - https only (http only to a loopback host under `--debug`, for tests);
  - redirects refused, never followed, so a credential never goes to a
    second location;
  - outside `--debug`, a URL whose host is a loopback or non-public
    address is refused at load: private, link-local, CGNAT, multicast and
    reserved ranges, and IPv6 forms that carry such an IPv4 address;
  - the same rule is applied by the client's own lookup to every address
    a name resolves to, before the socket opens
    (`REMOTE_ADDRESS_REFUSED`);
  - the Redis endpoint is refused always, by host, by the addresses its
    host resolves to, and as loopback on its port;
  - an answer is cut off at `--remoteMaxBytes` as it streams, and one
    deadline (`--remoteTimeout`) covers connecting and calling.
  - `--remoteOriginMap`, for acceptance runs, moves a declared origin's
    transport (credential included) to a loopback stand-in. It needs
    `COUNTINGHOUSE_ACCEPTANCE=1` in the server's environment at start: the
    map is checked whole and fixed there, once, in lib/remote/origin-map.js's
    closure, never on the shared options object, so no option, setOptions()
    call or later environment change turns it on or off (in single-thread
    mode a module has this process's full privileges anyway), and no
    worker-thread module sees the variable. While it is in effect, a remote
    it does not cover is disabled and never contacted. It accepts only
    `http://127.0.0.1:<port>` or `http://[::1]:<port>` as a target, never
    the Redis endpoint's port, and logs each mapping at start. The
    declared path is set on the target, never read as another host. A
    mapped call is not metered and its usage records are marked; the usage
    report and its aggregate count it in no group or total, only in their
    `standIn` section, and its receipt lists the stand-in's servers under
    `standIn` and says so in its sentence, so acceptance data is never
    taken for a real measurement.
- **Not provided.** A remote's answer is the remote's data: the module
  treats it as untrusted input, as it would any answer. (A remote call is
  billed by the call's token, as every hop is since R2-1.)

## Current mitigations inventory

These are real, and worth being specific about rather than waving at
"we have security measures". The sandbox layers above come first in effect;
these are the checks that predate them and still apply:

- **Module structural verification** (`countinghouse_validate_module`, an
  MCP tool gated on `--authoringTools` plus an admin key,
  `lib/mcp/gateway.js`; the check itself runs via `bin/countinghouse-validate.js`
  in a disposable child process, `lib/module-validator.js`). Before a module
  is loaded, its `api.json`, `schema.json`, and handler map are extracted
  and cross-checked against each other and against the framework's own
  JSON Schema 2020-12 meta-schema (`lib/validator.js`, via `ajv`) for
  structural conformance — well-formed service/action lists, unique action
  names, resolvable schema pointers, handlers that actually exist for every
  declared action — and every problem found is reported, not just the
  first. **Doing this requires actually running the module's own code.**
  `resolveHandlerMap` (in `lib/module-validator.js`) calls `require()` on
  every handler file — there is no way to resolve the handler map without
  loading the JS that defines it. A module's main entry, if it has one, is
  never run (`lib/module-layout.js`, the one module format). Under `--moduleSandbox audit` and `enforce` that `require()`
  runs in a module worker set up exactly as a load of that module would be
  (its policy, declared environment, limits, `--hardened` root, file
  namespace and lockdown), which is then discarded: it gets no main-thread
  services (any other message is refused and logged), its data directory is
  a throwaway under `<moduleDataPath>/.validate`, and at most two run at once
  (`lib/module-manager.js` `validateModuleSandboxed`). Under `off`, where a
  worker would get the server's whole environment, and in single-thread
  mode, it runs in a disposable child process given only `PATH`, `HOME` and
  `NODE_PATH`. Until 8.0.0 it always ran in a child process with the
  server's whole environment and no sandbox, which was weaker than a load.
  A hang, a crash or a `process.exit()` ends only that worker or child. The
  tool is gated behind `--authoringTools` plus an admin key, like every
  authoring tool. **The result describes a module; it is not a check a
  hostile module cannot fool:** the module runs beside the validator and
  could report its own result, so nothing gates on it (load does not run
  the validator).
  **None of this makes it a security scan, though.** It does not audit or
  review the module's code for malicious behavior, does not check its
  `node_modules` dependency tree for known vulnerabilities, and does not
  verify a signature or checksum against a trusted publisher. Running the
  code is a side effect of resolving the handler map, not a review of what
  that code does — a structurally valid `api.json` next to arbitrary,
  actively malicious JS passes this check exactly as cleanly as an honest
  module would. (This mechanism superseded the earlier HTTP-based
  module-verification route, removed in the marketplace-backend cleanup;
  see `docs/superpowers/specs/2026-09-04-marketplace-backend-design.md`.)
- **Schema validation at the invocation boundary**
  (`Service.prototype.validateActionCall`, `lib/service.js`, backed by
  `lib/validator.js`'s `ajv` 2020-12 compiler). Every `tools/call` /
  `invoke-action` request is validated against the action's declared
  `inputSchema` before the device module's handler runs, and the module's
  return value is validated against `outputSchema` before it's returned to
  the caller. This bounds the *shape* of data reaching a module's code and
  the *shape* of what a module can claim to return — it does not sandbox
  what the module's handler does internally with valid input.
  In worker mode, both checks run in a validator worker
  (`lib/validator-pool.js`) for every call the main thread sends to a
  module's worker (a client's call, a job's run, a hop routed through the
  main thread). That is neither the main thread nor the module's own worker,
  and no module code runs there.

  **A call over a direct peer channel** (the hosting default;
  `--no-directPeerChannels` routes every hop through the main thread
  instead) is checked by the main thread as well, since lean worker step 4.
  - The calling module's worker announces the call's target and its input,
    as bytes, to the main thread, which holds them. The port between the
    two workers carries only the call's id, so the called module can't
    restate the target or swap the input.
  - The input is capped by `--maxOutputBytes` and checked against the
    callee's input schema in a validator worker before any handler runs. A
    callee whose spec the main thread doesn't hold is refused.
  - The callee's result or error comes back as bytes with its bill request.
    It is capped, checked against the callee's output schema, and only then
    billed and delivered to the caller by the main thread. A result posted
    on the port is dropped and reported as a sandbox violation.
  - The pool's bounds below apply as for a routed call: the deadline, the
    caller throttle, and strikes against the callee for its own output.
  - Announced input waiting for its match is bounded per calling worker
    and in total, so one caller can't fill the main thread's memory or
    refuse another caller's calls.

  The main thread never compiles or walks a module's schema, because no
  check made beforehand bounds JSON Schema validation: some patterns
  backtrack for seconds, some small schemas compile for seconds. The
  validators are bounded instead:
  - their resource limits;
  - a deadline per request from when it is queued (`--validationTimeoutMs`),
    past which the call is refused `VALIDATION_TIMEOUT`, a queued request
    dropped unsent and a running one's validator replaced;
  - one queue per module, round-robin, with a module holding at most all but
    one ready validator, and one validation in flight per caller across the
    pool, so no tenant's flood delays another's checks;
  - a slow input held against its caller (by the R2-1 caller id, never a
    key): it replaces its validator and nothing else, and a caller whose
    inputs keep stalling is refused `VALIDATION_CALLER_THROTTLED` for a
    while on that module, alone. A flood from many keys is for the per-key
    rate limits;
  - a compile budget (`--validationCompileMs`), checked at load;
  - a quarantine (`VALIDATION_QUARANTINED`) for a module whose own outputs or
    compiles keep missing the deadline (a slow input does not count: any
    caller could send one to quarantine a module for every tenant);
  - an output cap (`--maxOutputBytes`, at most 256 MiB), checked on the main
    thread from the reply's own bytes (every call whose spec it holds
    answers in bytes, a failed call's error and payload included); the
    module's worker checks first only to answer early;
  - a hop's result crosses the main thread as `v8.serialize` bytes,
    transferred, never deserialised there. It is checked in a validator
    against the callee's output schema and decoded only by the calling
    worker, so the caller decodes only bytes a validator passed (a module
    can forge bytes through its own worker's send path; they are refused or
    checked like any others).

  A `schema.json` that is plainly unsafe is also refused at load as a
  courtesy, checked in a validator (`lib/schema-safety.js`). It refuses:
  - a `schema.json` over 1 MB;
  - a pattern over 1000 characters, with a repetition inside a repeated
    group, or with alternatives that start alike inside one;
  - over 100,000 nodes with its `$ref`s expanded;
  - a `$ref` cycle, or a `$ref` that names no place.

  It runs under the same `--validationCompileMs` budget as the compile.
- **`ctx.redis`: a command allowlist and a namespace per module.**
  - Modules use Redis only through a wrapper that exposes the 19 commands on
    the allowlist (`lib/supported-redis-commands.json`, intersected in
    `lib/redis-api.js` as `ALLOWED_COMMANDS`). These are data commands such
    as `get`, `set`, `hget`, `hset`, `lpush` and `zadd`.
  - `multi` and `exec` are not on it (#164): under `--store redis`,
    node_redis's `multi` runs any command name queued in it. Nor are the
    commands that affect the whole instance or read across keyspaces:
    `flushall`, `flushdb`, `config`, `keys`, `client`, `monitor`,
    `shutdown`, and Lua via `eval`/`evalscript`.
  - Every key a module names is stored under its namespace: `m:`, then the
    module's name URI-encoded, then `:` (#164, `lib/redis-namespace.js`). That's the name the main thread loaded the
    module under, never one its worker states. So a module can't read,
    overwrite or delete another module's keys or the runtime's own
    (`jobinfo:*`).
  - Each allowed command's key positions are in a table; a command whose
    keys can't be placed is refused. Single-thread mode and `--store local`
    namespace the same way.
  - What this doesn't stop: a module that opens its own Redis connection
    with the `redis` package and connection details of its own. Under
    `audit` and `enforce` the lockdown refuses the configured Redis
    endpoint in every spelling (layer 1 above), except by the routes listed
    there. Under `off` nothing does.
- **Per-apiKey device authorization** (`AuthProvider`, `lib/auth/` — see
  [`design-decisions.md`](design-decisions.md#authprovider-three-pluggable-backends-one-narrow-interface)
  for why it's split into three backends, and
  [`authentication.md`](authentication.md) for how to configure each one).
  Every entry path in `docs/cross-cutting-matrix.md`'s table
  that checks `userAuth` denies a caller that isn't explicitly granted
  the target `deviceID` (`USER_HAS_NO_DEVICE`), via one of three pluggable
  backends: `FileAuthProvider` (default, a JSON file), `SqliteAuthProvider`,
  or `CouchDBAuthProvider` (needs a real CouchDB instance, `nano` no
  longer a hard dependency). This is caller-identity authorization, not
  module sandboxing — it constrains which apiKey can invoke which device's
  actions, not what a loaded module's own code can do once its handler
  runs (that's the worker-thread boundary described above). Four things
  worth being explicit about, in the spirit of this document's own rule
  against overstating guarantees:
  - **Bodies are read before this check, except BSON.** JSON and XML bodies
    are parsed on every route before any key is checked, so an
    unauthenticated client can still make the server read up to
    `--maxRequestBody` (8 MB) per request. A BSON body (up to
    `--maxBsonRequestBody`, 64 MB, on `invoke-action` only)
    is read only after the key and its grant for the URL's device pass
    (`lib/route-manager.js`, `validateUser.beforeBody` in
    `lib/routes/user.js`); keyless `--debug`, loopback-only, admits every
    caller, so there it is read. A refused body is discarded unread; a client that
    keeps sending it is cut off by the server's default request timeout
    (300 s).
  - **Between modules, the check runs when a channel opens, not on every
    hop.** Since 7.1.0 a module calling another module's device does so over
    a direct peer channel by default. `userAuth` runs once, at brokering
    time; the channel it grants then serves only the devices granted on it:
    the main thread refuses a call naming any other device, or one the
    channel's callee doesn't host (`PEER_NOT_GRANTED`).
    A grant revoked while the server runs closes the channel on the
    broker's next re-check (`--peerChannelAuthRecheckSeconds`, 5 by
    default), so a revoked module identity can keep reaching a device for up
    to that long. `--no-directPeerChannels` restores the per-hop check on
    the main thread, with no such window.
    See [`direct-peer-channels.md`](direct-peer-channels.md) and D3 in
    [`design-decisions.md`](design-decisions.md#direct-peer-channels-five-decisions-d1d5).
  - **`FileAuthProvider`'s zero-config first run generates and prints a
    wildcard-access demo key** if no `auth.json` exists yet, specifically
    so a fresh checkout is immediately usable. This is meant for local
    development and evaluation, not left running in a real deployment —
    treat an auto-generated `demo-*` key the same as any other credential
    that shouldn't ship to production, and replace it (or configure a real
    `auth.json`/`COUNTINGHOUSE_API_KEY`) before exposing the server beyond
    localhost.
  - **An internal cross-worker call whose caller identity can't be
    resolved is metered for free rather than denied** (see
    `docs/cross-cutting-matrix.md`'s two "Direct peer channel" rows) — this
    is a `MeteringProvider`-side gap (billing, not authorization: the call
    itself still only succeeds if the resolvable identity, when there is
    one, is separately authorized), found and documented, not fixed, since
    the correct behavior (deny vs. bill a fallback identity vs. the
    current silent skip) is a real design decision, not implied by
    anything already decided.

### Hardening with systemd

Node 24 has no network permission, and on Node 26 `--hardened` passes
`--allow-net`, so under `--hardened` outbound network is left to the OS. A unit along these lines (adjust paths, addresses and
ports) gives the process a read-only file system apart from its module and
module-data directories, no new privileges, a private `/tmp`, a memory ceiling, and a
network filter. The filter (`IPAddressDeny`/`IPAddressAllow`) applies to
packets in both directions for the whole service, not only outbound
connections: remote MCP clients reaching the listen port are dropped unless
their networks are allowed, and a local DNS resolver must be allowed if
hostnames are used anywhere (Redis URL, module hosts):

```ini
[Service]
ExecStart=/usr/bin/node /opt/countinghouse/framework.js --workerThread --hardened --moduleSandbox enforce --modulePolicy /etc/countinghouse/policy.json --modulePath /var/lib/countinghouse/modules --moduleDataPath /var/lib/countinghouse/module_data --authConfigPath /var/lib/countinghouse/auth/auth.json
WorkingDirectory=/var/lib/countinghouse
User=countinghouse
ProtectSystem=strict
ReadWritePaths=/var/lib/countinghouse/modules /var/lib/countinghouse/module_data /var/lib/countinghouse/auth
NoNewPrivileges=yes
PrivateTmp=yes
MemoryMax=2G
IPAddressDeny=any
# Redis, and loopback clients
IPAddressAllow=127.0.0.1
# Networks your MCP clients connect from
#IPAddressAllow=10.0.0.0/8
# Local DNS resolver (systemd-resolved)
#IPAddressAllow=127.0.0.53
# CouchDB and operator-approved module hosts, by address
#IPAddressAllow=192.0.2.10
```

The server binds `127.0.0.1` unless `--bindAddr` is given; for remote MCP
clients add, for example, `--bindAddr 0.0.0.0` to `ExecStart`, and give
`--debugKey` with `--debug` (without it, `--debug` refuses any address but
loopback). `IPAddressAllow` takes addresses and networks, not host names, so the hosts
modules are approved to call have to be listed by address. `--modulePath`,
`--moduleDataPath` and `--authConfigPath` point into the three
`ReadWritePaths`: their defaults (`$HOME/countinghouse_modules`,
`$HOME/.countinghouse/module_data`, `./auth.json`) are read-only under
`ProtectSystem=strict`; modules write their `/data` and `/tmp` under
`--moduleDataPath`, and the file auth provider writes `auth.json` with a
demo key on first run. All three directories must exist and belong to the
service user. `PrivateTmp=yes` does not affect modules' `/tmp`, which lives
under `--moduleDataPath`.

## Honest comparison

| Approach | Isolation strength | Density / cold start | Operational cost |
|---|---|---|---|
| **worker_threads** (current, with the module sandbox) | Separate V8 heap + execution context; in-process lockdown, permissions, a brokered per-module file namespace and limits on top; shared OS process, and shared network until parts 3-4 | Very high density (threads, not processes); near-zero cold start | Minimal — no extra infra |
| Linux containers (Docker/OCI, no extra sandboxing) | Separate filesystem/network namespace, cgroup resource limits; shared host kernel | High density; cold start ~100ms–1s | Moderate — container orchestration |
| gVisor (or similar user-space kernel) | Syscalls intercepted/emulated by a sandboxed kernel; strong defense against kernel-exploit-based escape | Medium density; cold start adds tens of ms over a bare container | Moderate-high — gVisor runtime + monitoring |
| Micro-VMs (Firecracker, etc.) | Full hardware-virtualized isolation; separate kernel per tenant | Lower density than containers; cold start ~100ms+ (improving) | High — VM-level infra, harder multi-tenant bin-packing |
| V8 isolates (Cloudflare Workers / `workerd`) | Separate V8 isolate per tenant, similar boundary to `worker_threads` but combined with a locked-down, purpose-built runtime (no `fs`, no arbitrary native addons, curated globals) | Extremely high density; sub-millisecond cold start | Requires a custom, restricted runtime — not "just run npm packages" |

`worker_threads` sits at the weak end of this table on isolation strength,
and its main advantage — density and cold-start — is exactly the same
advantage the V8-isolate row gets *plus* a far smaller attack surface,
because `workerd`-style runtimes deliberately don't expose `fs`, unrestricted
native addons, or a real `process` global. countinghouse's isolation model
is closer to "same process, separate heap" than to any of the harder
options in this table — it should not be described as comparable to gVisor
or micro-VM isolation.

## Positioning

**"Worker-thread isolation + module review (structural verification, plus
operator review)" fits a
semi-trusted, operator-vetted third-party module model** — modules are
vetted by the platform operator (structural verification, and in practice,
human review) before being loaded, not open to anonymous, unreviewed code
execution. It does **not** provide hard isolation equivalent to containers,
gVisor, or micro-VMs, and should not be marketed as such. The honest pitch
is: this is a reasonable, low-overhead boundary for modules from developers
the operator has a relationship with and has reviewed, not a boundary
suitable for running arbitrary, adversarial, unreviewed code from the open
internet. (countinghouse itself runs no marketplace — modules are
distributed over npm — so "marketplace" described the trust posture, not a
feature of this project; see
`docs/superpowers/specs/2026-09-04-marketplace-backend-design.md` for why
the framing changed.)

## Roadmap

The module sandbox is delivered in four parts. **Parts 1 (foundation) and 2
(file broker and virtual paths, 8.0.0) are what this document describes.**
The rest is not implemented:

- **Part 3: HTTP(S) broker.** `fetch`, `http` and `https` through the main
  thread, DNS done by the broker, the destination checked after resolution,
  private ranges and localhost denied unless approved, request quotas. This
  is what makes the declared `net` permissions take effect.
- **Part 4: raw TCP/TLS relay.** `net` and `tls` through the main thread;
  UDP stays denied.

Beyond the programme, as before: a **hybrid mode** with an opt-in process- or
container-per-module mode for modules the operator wants stronger isolation
for, at the cost of density and cold-start, or a container or microVM shell
around the whole process. The sandbox does not replace either; it is the
in-process layer that remains useful under both.
