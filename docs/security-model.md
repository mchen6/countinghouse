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

**Boundary checks run on intrinsics captured before module code loads.**
Module code shares the worker's realm with the checks that bound it, and can
replace a method of `String`, `Array`, `Set`, `Map`, `RegExp` or
`Function`, or a property of a shared built-in module. So every check
the worker's boundary relies on (which built-in may load, whether a file
is inside the module's root, by `require`, `CHUtil.loadFile` or the reduced
`module.createRequire`, whether an fs call goes to the file broker or a
granted original, whether a host is granted) calls only functions taken
when its file loaded, before any module code: never a method looked up when
the check runs. What those checks keep (the file broker's grants, a
filtered list) is written by definition, never by assignment, which would
run a setter a module put on `Array.prototype` or `Object.prototype` with
the runtime's own list or object as `this`; the exports such a check
consults are frozen or read once at load. That holds for the lockdown
(`lib/module-lockdown.js`), the file broker's worker side and its loader
hook (`lib/fs-broker`) and the resolve shim. A grant is for reading only: a
granted `openSync` opens read-only, a granted `readFileSync` reads with
options of the runtime's own, and a descriptor a grant opened is only
stat'ed, read and closed (any other call on it is the broker's, which answers
`EBADF`). A guard hands a call on to the original it wraps
through a `Reflect.apply` taken at load, never the original's own `call` or
`apply`, which a module could have replaced to receive it. Live lists a check
consults (the allowed built-ins, the loopback names) are private to their
file, exported only as frozen copies. The intrinsics themselves are not
frozen (that breaks common packages). What Node's own loader reads from
objects a module can reach is fixed at the lockdown instead, in audit and
enforce: every function of the `path`, `path.posix`, `path.win32` and `url`
exports, `URL.prototype`'s accessors and methods, and `module.isBuiltin`
are non-writable and non-configurable, so a module cannot show the loader
or a check one path and have another one used. So are a port's
methods and its event targets' (`MessagePort.prototype`, the
`NodeEventTarget` behind it and `EventTarget.prototype`): Node's own set-up
of a port that reaches a worker after module code has loaded (a peer
channel's) calls `this.on`, so a replaced method would be handed the port
before the runtime holds it. The keys Node assigns on a port it sets up
(`kEvents`, `kHandlers`, the listener limits, `kCurrentlyReceivingPorts`)
have accessors of their own on those prototypes that make the value the
port's own, so a setter module code puts on `Object.prototype` for one is
never reached. A module that patches `path`, `url`, `URL`,
`EventTarget`, `NodeEventTarget` or `MessagePort` runs only under `off`.
Since the inherited properties are non-writable, an assignment on an
instance (`target.addEventListener = fn`) throws in strict code; accessors
(`port.onmessage = fn`), subclasses and `Object.defineProperty` on an
instance still work. These are fixed under `audit` as under `enforce`:
audit reports a module's other attempts and allows them, but a patch to
one of these simply fails, with nothing reported.

A worker loads everything its calls go through at boot, before module
code: call limits, a hop's input, peer channels, the service client, the
device query and `countinghouse-util` (attached to the worker then). A
`require` on a call path after that would return whatever module code had
put in `require.cache`, so there is none. Since #194's PR 2 module code
doesn't reach those files through `require.cache` at all (the runtime's
modules are sealed away at the lockdown, below); their exports and their
classes' prototypes are fixed at boot as well, so module code that is handed
one can replace nothing the runtime calls.
A call's token, the queues of calls waiting for a peer channel and the
callbacks waiting for replies are kept in containers written as own
properties and walked by index, with intrinsics taken at boot, so a method
or setter module code puts on a shared prototype is never handed one.
What the runtime still loads on first use carries no call's token: a
library for the module's own requests, the logger, live settings and the
Redis bridge, which is handed only its own send.

Known limits of this rule:
- **A module in the same realm can still post a message through
  worker-message's module-level post, and the main thread must refuse what
  it did not ask for.** Module code no longer reaches
  `lib/worker-message.js` through `require.cache` (#194's PR 2), and it
  cannot change the runtime's instance or its prototype; the main thread
  still refuses what it did not ask for, should a module find another way
  to post on the worker's port (a `WorkerMessage` of its own would).
  So a module can send a request the main thread does not serve for it (a
  validation's worker is refused every one, by name: test/sandbox/21) and a
  reply to an id it guesses, as bytes it made by hand (refused, or checked
  by a validator before any caller decodes them: test/sandbox/42). Nothing
  the main thread acts on is taken on the message's word.
- **`CHUtil.request`'s redirects** are followed inside postman-request,
  whose redirect handling looks methods up when it runs: the lockdown's
  `followRedirect` check runs on its own captured functions, but what
  postman-request hands it can be shaped by a module. This is moot while
  raw `http`, `https` and `net` stay allowed under enforce (until sandbox
  parts 3 and 4): when network enforcement comes, the wrapper follows each
  redirect itself (`followRedirect: false`) and checks every hop.
- **`CHUtil.loadFile`** derives its path through the file broker's identity
  functions (`resolveModulePath`, `specifierFor`), whose module object is
  reachable through the require cache until the runtime's own loads move
  off it (#194).

**Modes.** `--moduleSandbox off|audit|enforce`, default `audit`. The sandbox
needs worker mode; without it the mode is `off`. countinghouse 8 needs Node
22.16 or later. Below 24.15 a compatibility shim routes `require.resolve`
through the sandbox's hooks (`lib/resolve-shim.js`); multi-tenant hosting of
third-party modules should run 24.15 or later, where Node's own hook covers
it. Below 24.15, a `#` name resolved under `enforce` by `require.resolve`
or a direct `Module._resolveFilename` takes the CommonJS conditions Node's
hooks brought with the worker's first `require` (Node's own, flags and
all); only before any `require` has run in the worker does it take Node's
default list (`require`, `node`, `node-addons`, `module-sync`). A plain
`require` always resolves with its own.

| | `off` | `audit` (default) | `enforce` |
|---|---|---|---|
| Virtual paths, file broker, bridge | yes | yes | yes |
| Link rules, main-thread protection | yes | yes | yes |
| Reads outside the namespace | pass through | pass through, logged | refused |
| Writes outside the module's own area (outside the namespace, `/app`, `r` paths) | pass through | refused (`EACCES`), recorded | refused |
| Disk quota | not counted | logged | enforced |
| Lockdown, resource limits, clean environment | no | yes | yes |
| Processes, threads and native code (`child_process`, `worker_threads`, `process.dlopen`, `process.binding`) | allowed | allowed, reported | refused |

Under `off` and `audit`, Node's resolver internals and their host paths
are module code's to see, as before: `Module._findPath` and
`_resolveLookupPaths` (which a module may replace), a readable
`Module._pathCache`, a direct call made from inside a module's own
patched internal, and the warnings Node's resolver gives (DEP0166, a
deprecated double slash or segment, names the package.json's host path). What a direct resolution made from the module's own
virtual paths (a parent or base built from `__filename` or `__dirname`)
answers or throws holds no host path there: an answer outside the module
is not found, and any error is a plain not-found. Which calls are mapped
is `lib/fs-broker/identity.js`'s `parentMapped` and `hostOf`.

Under `enforce`, the runtime's own files are named by virtual names in
what module code reads by default: a stack formatted by the runtime's
default formatter (`e.stack`, `Error.captureStackTrace`; Node's own errors
keep their `name [code]: message` header) names the runtime's frames
`countinghouse:/lib/...` (a hoisted dependency's
`countinghouse:/node_modules/<@scope/name>/...`; a linked install's files
too), and `util.getCallSites()` names them so.
`module.constructor.globalPaths` is an empty array (`_initPaths()` does
nothing), and `process.argv` and `process.execArgv` are copies without
host paths -- `['node', 'countinghouse:/lib/lean-worker.js']`, and no
`--allow-fs-*` grant. A warning Node's own resolution step would give is
not given to module code. Each of these stays an ordinary value module code
may change, as on master.
Known limits: `Error.prepareStackTrace` is an ordinary property set to the
runtime's formatter; a module that assigns or defines its own -- in its own
realm, a `vm` realm, or on a `globalThis.Error` it replaced -- gets V8's
frames as on master: the runtime's file paths, never a receiver or a
function of the runtime's (its files are strict mode); and its function
also formats the runtime's own errors read in its worker, as on master.
`process.execPath` (and `process.argv0`) can name the Node binary's install
path (e.g. under the user's home with nvm); Node's own spawns read it.
Under `--enable-source-maps` (or `process.setSourceMapsEnabled`), the
runtime's formatter applies no source map. On Windows a stack or a message
spells the runtime's files `countinghouse:\lib\x.js` (a file URL's form,
and `process.argv`, with `/`). `util.getCallSite` (Node 22's deprecated
alias) gives no deprecation warning, and `util.getCallSites(200)` gives at
most 199 frames.

**On Windows** a module's files carry a drive (#195): the module sees them,
its current directory and its stack frames as `<V>:\app\...`, V a drive
letter the host does not have, picked once per process, because Node there
loads a file only by a URL with a drive (`file:///<V>:/app/...`). The
runtime names them `/app/...`, and the file broker maps `<V>:\app`,
`<V>:\data` and `<V>:\tmp` to `/app`, `/data` and `/tmp`, so every rule
above applies on Windows as it does elsewhere. With no free drive letter,
`--moduleSandbox enforce` refuses to start on Windows, saying so.

**On Windows, a module's declared host paths are limited**
([#204](https://github.com/mchen6/countinghouse/issues/204)). A declaration
is POSIX-absolute (`countinghouse.permissions.fs`, lib/module-permissions.js),
so on Windows `/srv/x` names that path on the runtime's current drive
(`C:\srv\x`), and that is the root granted. A path on another drive can't
be declared. A drive-qualified path a module gives is outside the namespace,
refused (ENOENT) under `enforce`: it fails closed. The module always has its
own `/data` and `/tmp`.

**Other Windows limits** (from running every sandbox and file-broker test on
a Windows runner, each failure given its cause):

- **`--hardened` loads no module in a Windows worker yet.** Every module
  load there fails with Node's "Access to this API has been restricted",
  a read the permission model refuses (which read is not pinned yet). It
  fails closed. ch-local doesn't pass `--hardened`.
- **The Redis store is untested on Windows.** CI's Windows runners have no
  Redis, so the tests that use it run on Linux only. On Windows, ch-local
  runs the local store (`--store local`), which is tested there.
- **Names Win32 reads specially.** Node's fs gives Windows an absolute path in
  its namespaced form (`\\?\`) for the calls checked on a Windows runner
  (open, read, write), where Win32's name rules don't apply: a module's
  `/data/COM1` or `/data/NUL.txt` is an ordinary file, not a device, and
  `/data/note.` is a file of its own, not `note`. A name with a `:` in a
  segment of the module's own `/app`, `/data` or `/tmp` names an NTFS stream
  (`note:alt`, `note::$DATA`): under `enforce` it answers ENOENT, as if
  nothing were there, since a stream's bytes escape the disk quota's count
  at a spawn; `audit` reports it and lets it through. The broker's checks of a protected file at each
  operation compare a Windows name with its case folded and its `:stream`
  suffix and trailing dots and spaces stripped (lib/fs-broker/denied.js), or
  compare the file itself. The namespace's start-time check that a declared
  root doesn't overlap a protected path compares case-sensitively past the
  drive letter; a root it misses is still refused at each operation.
- **A link a module makes inside its roots** is refused on Windows when a
  segment of its target is one Win32's path rules would read as other than
  its text: trailing dots or spaces, or a device name. Followed through
  Node's namespaced paths, a target is taken as written (checked on a
  Windows runner), so this refusal is a belt.
- **An exclusive create** (`open` with `wx`, `copyFile` with
  `COPYFILE_EXCL`) through a link that was dangling when the broker checked
  it answers EEXIST on Windows before any open, as POSIX's kernel answers it,
  under `audit` and `enforce` (`off` decides nothing about files). A link a
  host process puts there after the check is the host race described below.
- **CI's Windows legs** run the stdio and local-store suites. The sandbox and
  file-broker suites run on Windows only when the Windows subset workflow is
  dispatched by hand with them: no pull request or merge runs them there.

**A hard link through a symbolic link (macOS, and possibly Windows).** The
broker judges a hard link's source by its path as named. On Linux `link`
does not follow a symbolic link in its source. On macOS it does, and
Windows documents the same. So a symbolic link the operator places inside a
module's writable folder, pointing at a file outside it on the same volume,
lets that module make a hard link to that file and then read and write it
as a file of its own. The always-denied files (the identity secret, the
auth config) are still refused by file identity. Don't place symbolic
links to files outside a module's folder in its writable folders. The fix
comes in 1.1.

**Under `audit` a module changes nothing outside its own area through
`fs`** (maintainer's decision, 2026-11-15). Its own area for writes is its `/data`, its `/tmp` and what it
declared `rw`. Every write-class operation aimed anywhere else is refused
`EACCES` and recorded as a denial: an open for writing, a create or truncate,
`writeFile`, `appendFile`, `mkdir`, `rmdir`, `rm`, `unlink`, `rename` or
`link` with either end outside (its source judged by the path as named; see
the limit on hard links through a symbolic link, above), a symlink made
outside, `chmod`, `chown`, `utimes`, `truncate`, and `copyFile` or `cp`
to an outside destination; writes to `/app` and to a path declared `r` too.
A symlink made inside the namespace that points outside it is refused
`EPERM`, in every mode, as before.

**`audit` does not confine a module.** It holds a module's `fs` and loader
traffic only. What `enforce` refuses beyond them, the lockdown reports under `audit`
and then allows: `child_process` and the other blocked built-ins,
`worker_threads`, `process.dlopen` and native addons, and `process.binding`.
Through them a module can start a process or a thread the sandbox does not
hold, or run native code, and so read the always-denied files and the
protected paths, or change anything the OS user can. Only `enforce` confines
a module, and `enforce` too is a sandbox, not a security boundary: a module
that escapes it runs with the runtime's rights. The runtime's own default is `--moduleSandbox audit`. ch-local
starts packs under `enforce` by default: there `audit` is a loosening the
user confirms, which an operator's ceiling can forbid and an own module
refuses, and on Windows it falls back to `audit` only where `enforce` is
not available.

**Only `enforce` hides files.** Under `audit` and `off` reads outside a
module's namespace pass through to the host, except the always-denied set
and the protected paths above: under `audit` a module can read any other
file the OS user can -- the operator's project directory, the current
directory, `~/.npmrc`, `~/.ssh` -- and each read is logged (the first 100
distinct reports per worker start; then one line says the rest were
suppressed). So don't run
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
  later hook can run ahead of the boundary; and `Module._load`, which module
  code reaches as `module.constructor._load`, forwards only its request,
  parent and isMain, so its internal fourth argument (which skips the
  resolve hooks, or hands over a resolution or source) never skips them.
  Under `enforce` it takes only a string request and never makes a main
  module; it, `Module._resolveFilename`, `Module.prototype.load` and the
  extension handlers are locked, and the extensions table takes no new
  extension. Under `audit` none of them, and none of the statics locked at
  the seal, can be replaced either, as Node hands the loader's the
  runtime's own modules: an assignment is reported and the runtime's value
  kept, and a redefinition (`Object.defineProperty`,
  `Object.defineProperties`, `Reflect.defineProperty`) is reported and
  fails as Node's own would. The extensions table takes no new extension in
  either mode; a key added, redefined or removed is reported and refused
  (the locked `.node` handler included). `Reflect.deleteProperty` of
  anything held is reported under `audit`. What `audit` can't see, though
  it is refused all the same: an assignment to `Module.prototype` (a
  function's own `prototype`, which can't be made an accessor), the
  `delete` operator on a held property, a redefinition through another
  realm's `Object.defineProperty` (one a `vm` context gives), and one made
  through a Proxy that module code wraps around a held object. Nor, with
  Node's `--experimental-vm-modules` (a development-only flag, which a
  worker inherits), does `audit` cover `vm`'s module classes: under
  `enforce` they are deleted from module code's `vm`, while under `audit`
  their construction through `vm` is said but other routes to them, and
  the code caches they take, are not.
  The other routes
  into what the runtime loads are closed by #194: the runtime loads nothing
  after the lockdown (its PR 1), and at the lockdown its modules are sealed
  away (its PR 2): every `require.cache` entry of a file outside the
  module's root is moved out of the cache, in place, and `Module._cache`
  locked, so `require.cache` (module code's, and `module.constructor._cache`,
  which is the same object) holds the module's own files only, and
  `util.inspect`, which reads past any view, names no runtime file; each
  runtime `Module`'s parent and children are emptied and there is no main
  module; the loader's other statics are locked in both modes
  (`_pathCache` a view that lists nothing and keeps only the module's
  own files, the
  resolver's helpers, `Module.prototype.require` and `_compile`,
  `Module.prototype`, and the extensions table, which takes no new key);
  a load with one of the runtime's own Modules as its parent is refused
  under `enforce` and said in both modes (the net); and after the lockdown
  every resolution is module code's, and none is granted countinghouse's
  code roots. Under `enforce` what exists in the runtime's tree is then no
  answer module code gets through `require`, `require.resolve` or the
  loader's helpers (a parent outside the module's root is refused before
  Node reads anything for it); `import()` through Node's ES module
  resolver can still tell whether such a path exists, which is closed in a
  later change. Under `audit` a require of one is reported, and the
  loader's helpers called directly answer truthfully, unreported, as every
  lookup does under `audit` (test/sandbox/68);
- what that costs loader-related libraries a module depends on, measured
  by test/sandbox/69 (each used as its dependents use it, pinned in the
  repo's devDependencies), in single-thread mode and in a worker under each
  `--moduleSandbox`:

  | Library, as used | single-thread | `off` | `audit` | `enforce` |
  | --- | --- | --- | --- | --- |
  | `source-map-support`, `install()` | works | works | works | works |
  | `source-map-support`, `install({hookRequire: true})` | works | works | no hook (reported) | throws |
  | `require-in-the-middle`, a `Hook` | works | works | throws | throws |
  | `resolve-from`, from `__dirname` | works | works | works | works |
  | `import-fresh`, a relative name | works | works | works | works |
  | `import-fresh` or `resolve-from`, an absolute path from `__dirname` | works | works below Node 24.15 (Linux, macOS) | works below Node 24.15 (Linux, macOS) | works below Node 24.15 (Linux, macOS) |
  | `module.findPackageJSON` from `__filename` | works | works | works | not in the reduced `module` |
  | `module-alias`, `addAlias` | works | no alias | no alias | throws |
  | `process.emitWarning = fn` | works | works | works | works |
  | `process.emitWarning = null` | throws on the next call | throws on the next call | throws on the next call | warnings off |
  | `Object.defineProperty(process, 'emitWarning', ...)` | works | works | works | throws |
  | `Error.stackTraceLimit = n` | works | works | works | works |
  | `Object.defineProperty(Error, 'stackTraceLimit', ...)`, or on `process.noDeprecation` and its two siblings | works | works | works | throws |
  | `process.env = {...}`, `process.send = fn` | works | works | works | doesn't take (a TypeError in strict code) |

  Why:
  - a module's own directory is virtual (`/app/...`) in every mode on
    Linux and macOS, single-thread included, and in a Windows worker
    (`<V>:\app\...`); in single-thread mode on Windows it is its host
    path. A parent a library makes from it (as
    `resolve-from` and `import-fresh` do) reaches Node's resolver in its
    host form, confined to the module's root: in a worker by the file
    broker's mapping, which answers a module file by its virtual name, and
    answers every path it hands back -- `realpath`'s, `mkdtemp`'s and
    `mkdir`'s, `readlink`'s, a directory entry's, glob's, `cp`'s filter
    arguments, an error's path -- in the module's own spelling (on Windows
    `<V>:\app\...`; only the namespace's own paths, never a host one); in
    single-thread mode by the facade, through the root of the module that
    called, answering the host path (development mode, no isolation; on
    Windows, where a single-thread module's directory is its host path,
    Node resolves from it as it is).
    Under `enforce` the reduced `module` gives them `_nodeModulePaths` and
    `_resolveFilename`, confined to the root, with every refusal `enforce`
    has and never a host path;
  - in a worker a module's requires are resolved by the file broker with
    Node's own resolver, so `module-alias`'s replaced `_resolveFilename` is
    never asked: use relative requires instead;
  - under `audit` the loader's statics and `process.getBuiltinModule` are
    held, so a replacement is reported and never takes;
  - under `enforce` the reduced `module` has no prototype or other statics
    to replace.

  So a dependency that hooks the loader (`hookRequire`,
  `require-in-the-middle`) needs `--moduleSandbox off` or single-thread
  mode;
- other routes to files: `module.enableCompileCache`, `process.report`'s
  file output and `process.setSourceMapsEnabled` are locked;
  `process.loadEnvFile` goes through the file broker. Of `process.report`'s
  settings, `compact`, `excludeNetwork` and `excludeEnv` are the worker's
  own values, which a module may read and set (a boolean, as Node checks)
  and which never reach the process's (the worker's real `excludeEnv` and
  `excludeNetwork` are on from its start, so a report it writes under
  `audit` holds no environment; such a report is in the process's
  `compact`, not the module's); every other one (`directory`, `filename`,
  `signal`, the `reportOn*` triggers, and any a later Node adds) is locked;
- `process.report.getReport()`, in every mode: Node builds a report from the
  process, not the worker, so it would hold the server's own environment and
  command line (its database and Redis passwords, its debug key, any token
  in its environment) whatever env the worker was given. A module is served
  only what an allowlist keeps: of the header, the runtime's versions, word
  size, arch, platform, glibc and OS name; the JavaScript heap, resource use
  and limits; and of the shared objects only libc's and the dynamic loader's
  names, which native-addon loaders (detect-libc) read to pick a binary. The
  environment, command line, working directory, host, network, OS release,
  version, machine and CPUs, the libuv handles, worker reports, both stacks,
  and any field a later Node adds are left out;
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
| `/tmp` | `<moduleDataPath>/<name>/tmp` | read-write, quota, emptied when the worker starts (only one the runtime made: "Only what the runtime made is deleted") |
| each declared path, e.g. `/var/log/app` | the same host path | `r` or `rw` as the operator's policy narrows it; no quota |

`<name>` is the package.json name the main thread verified. A load whose
request name differs from it is refused in every mode
(`MODULE_NAME_MISMATCH`), so code cannot be loaded under another module's
name to get its policy entry and data. `__filename`, `__dirname`,
`require.resolve`, `require.cache` keys, `import.meta`, a module's own stack
frames, `process.cwd()` (`/app`) and `os.tmpdir()` (`/tmp`) are virtual, and
so are paths in results and errors. Frames of the runtime's own files in a
stack module code can read can still name the install directory (being
fixed). Under `enforce`, ancestors of a root (`/`, `/var`) answer as
read-only directories that list only the way to the root; under `audit` and
`off` they are the host's (`readdir('/')` lists the host's root), except
one in a protected path, which is refused under `audit`. A declared path
can never cover countinghouse's own directories (the install directory,
`--modulePath`, `--moduleDataPath`, the auth and device-config paths, the
policy file, the `--remoteCredentials` file) or an ancestor of one: such a declaration is refused in every
mode and logged at spawn.

Nor can a writable declared path hold a name on a path countinghouse runs
through:

- the install, as it is run (by a spelling that is not its real path, through
  a symlink or a junction, only with `--preserve-symlinks`);
- the file it was started from, as the command named it (npm's `bin` link, a
  `current` link; the `countinghouse` launcher tells the runtime how it was
  started);
- every configured path: `--modulePath`, `--moduleDataPath`, the settings
  home, the local store, the auth and device configuration, the policy file;
- every module root (`--modulePath`, each `--loadModule`): its links and the
  directories a link's target leaves with `..` only. A module may still be
  given a writable path above another module's code; the broker refuses
  writes in that code and renames of it and of the directories above it.

Whoever can replace a link on such a path, or a directory one of their
targets passes through, chooses what the next start runs, or where it keeps
its modules and data. So a declaration with `rw` access is refused when it
is the directory of such a name or a directory above it, however the
declaration spells it; a read-only one is kept. Under `--hardened` the names
are found before the server restricts itself; a server put under Node's
permission model another way (`node --permission` by hand) cannot look for
them, and refuses to start. Two things this does not see: a Linux bind mount
of a directory that holds such a link (the mount is another name for it that
no path comparison shows; the protected directories above share this), and a
Windows mount point given by volume GUID.

Beyond declarations, every path in those directories -- every module's code
(`--modulePath` and each `--loadModule` directory) and data
(`--moduleDataPath`, also while a module is being validated), the local
store, the auth and device configuration, the policy file, the
`--remoteCredentials` file (which says where each credential may be sent) -- and in
ch-local's home (the
directory of `--settingsFile`: its settings, the daemon's session secret
under `run/`, the launcher, the pack records) is refused to a module's reads
and writes through `fs` and the loader under `audit` and `enforce`
(`EACCES`, recorded; under `audit`, not to a process or thread the module
starts, above), however it is named: directly, through `..`, a symlink or a hard link to the settings
files. The policy file and the `--remoteCredentials` file are refused by
their paths, not by identity as the settings files and the auth
configuration are: a hard link to one of them, under a name outside these
directories, is another path and is not refused. A module cannot make one
(a `link` with either end outside its roots is refused, and under
`enforce` a module whose `/data` or `/tmp` holds one does not start); the
limit is a link that an operator, or other software on the machine, left
where a module may read. A pack loaded in place may come with a credentials
file of its own, read when the pack is loaded (`lib/modules-in-place.js`):
that file is no option of the runtime's, so it is not a protected path by
itself; ch-local writes it under `run/` in its home, which is protected as
a whole. The one exception is the module's own `/app`, `/data` and `/tmp`, by
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

The main thread's file work is bounded in every mode: the thread pool is
raised to 16 unless the operator set `UV_THREADPOOL_SIZE` (the runtime sets
the variable as it starts; on Windows libuv may not see that, so set it in
the environment there), brokered operations in flight are capped globally
and scheduled round-robin across workers, each worker has a queue of 4096
calls (`EMFILE` past it) and at most 256 descriptors, and a transfer is at
most 16 MB, with `readFile` served in chunks. Calls waiting on a lock are
not counted in that queue, and there is no budget on the bytes queued (a
fix in 1.1). A brokered call
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
`package.json` reads) answer "missing" outside those roots too, Node's own
walk included: the two are installed through Node's own setters, the only
way its walk calls them (before, they answered only a module's direct
calls, and a package's `"main"` leading outside could tell module code
whether a host file existed).

Under `enforce` the sandbox resolves `#` imports, a bare `import` and
`findPackageJSON` inside the module root itself, and reads each
`package.json` with `JSON.parse`, while Node's own reader is a different
parser. So that the two can't read a package differently, the load is
refused (and under `audit` reported) when any `package.json` in the module
has any of these:

- bytes that aren't valid UTF-8 (a `'utf8'` read turns them into U+FFFD,
  where Node's reader throws);
- a top-level `"imports"`, `"exports"`, `"name"`, `"main"` or `"type"` key
  written twice (`JSON.parse` keeps the last copy, Node's reader may keep
  another) or written with an escape (`"\u0069mports"`, which Node's reader
  doesn't take as `"imports"`);
- a backslash escape in the string value of `"name"`, `"main"` or `"type"`,
  which Node's reader decodes itself.

Node hands `"exports"` and `"imports"` back as raw text, which `JSON.parse`
reads as the sandbox does, so what is nested in them is read alike. Known
and left open, as not reaching resolution: other places the two parsers
may differ outside those fields, such as a number too large to hold, or
nesting deep enough to exhaust one of them.

After the seal, `module.findPackageJSON` takes a primitive string only.
Any object, a `URL` included, answers `undefined`, because reading a
`URL`'s `href` runs its `searchParams.toString`, which module code can
replace, and Node takes an object by its own `toString`.

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
failures are logged and the module loads. `enforce` also refuses a module
whose directory holds a link to a directory, a link that does not resolve
or a `package.json` that is a link, and one with a `package.json` whose
`"main"` leads outside the module's directory or names the directory itself
([module development](module-development.md)); `audit` reports them. This is a structural check of
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
handed one. Under `audit`, though, `require('worker_threads')` is allowed
(and reported), and it hands module code `parentPort` and the file bridge's
ports in `workerData`: what follows holds under `enforce`. A message that is not an envelope, or one over the cap, is a
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

A module's stdout and stderr are bounded the same way. Unless the runtime
runs with `--debug`, a module's worker makes every `console` method do
nothing and drops `fs.writeSync` to descriptors 1 and 2, in every mode,
before module code loads: what reaches the log is what a module writes with
`process.stdout.write` and `process.stderr.write`. Under audit and
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

**Only what the runtime made is deleted.** Every recursive delete the
runtime does is limited to directories it made:
- `/tmp` emptied at a spawn (a worker, a session's worker, single-thread
  mode);
- a module's data removed by an uninstall;
- a session's partition removed at its end or by the start's sweep.

When it creates a module's or a session's `data` and `tmp`, it records each
directory's identity (device, inode and birth time) in an owner-only marker,
`.countinghouse-owned`, in the directory holding them: `<name>/`, or
`<name>/sessions/<id>/`. No worker sees that directory. Before deleting, the
directory as it is now must be the one recorded. A directory the runtime did
not make, or one swapped in since (another at the same path, an inode number
reused included), is never emptied or removed; it is kept and said once. The
module's root and a session's root are never removed recursively, only by
`rmdir` once empty.

A marker is read, and a directory judged its own, only through real
directories from `--moduleDataPath` down. A `<name>/` or `@scope` that is a
link leads to another module's marker, which vouches for nothing there, so
**a module's data directory can't be a symlink**. To put it on other
storage, use a bind mount, or link `--moduleDataPath` itself. An uninstall
refuses a module whose `<name>/` is reached through a link
(`MODULE_DATA_NOT_DIRECTORY`). A `.countinghouse-owned-probe-*` directory
in a module's `data` or `tmp` is the runtime's, briefly: it checks there
whether the file system keeps real birth times.

A directory made before this rule, by an earlier version, is adopted in any
of these:
- its module's first spawn;
- a session worker's spawn;
- a load in single-thread mode;
- an uninstall;
- a session's end;
- the start's sweep.

Adoption happens only when:
- it is at the path the runtime would have made it, with no link from
  `--moduleDataPath` down to it;
- the overlap judgement found no module's code inside it or around it: the
  file broker's own at a spawn, elsewhere the same question asked of every
  module root the runtime knows, each `--loadModule` directory and the
  `--modulePath` folders.

A directory whose marker names another, changed since, is never adopted
again: a mismatch is the sign that something other than the runtime changed
it. When the runtime removes a directory, it rewrites the marker without
that directory's entry. A birth time recorded on a host that can read them
is never set aside for device and inode alone. A directory that can't be
checked that way is kept, said with the same recovery: stop the runtime and
delete the marker.

Nothing about a package name or a file layout is read to decide. The
throwaway `<moduleDataPath>/.validate` of a validation is not under this
rule: the runtime makes it fresh, under a dot name no module's name can
take.

A directory the runtime made that holds module code it knows is kept too,
since a module may have been loaded from inside another's `/data`. That
covers a module root it knows, a `--loadModule` directory, or a
`--modulePath` folder inside it.

The marker names directories by their identity, so a copy names nothing.
After `--moduleDataPath` is moved or restored (`rsync -a`, `cp -a`), or on a
file system whose device numbers change across reboots, every directory
there is kept and said. To have them adopted again, under the same
conditions as an earlier version's, delete the `.countinghouse-owned`
files with the runtime stopped.

**7. `--hardened`.** Re-launches the server under Node's permission model
(`--permission`) with read access to the install directory, `--modulePath`,
`--moduleDataPath` and the configured config files, and write access to
`--modulePath`, `--moduleDataPath`, `--storePath` under `--store local` (read
too), and the SQLite auth directory. This
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
the key's fingerprint (a full, domain-separated sha256). The Redis store's
ledger does the same: one hash per key, named by that fingerprint, so its
records hold no key. The seeding
command, `countinghouse-meter` (`--storePath <dir>` for the local store,
`--store redis` for Redis's), reads the key from `COUNTINGHOUSE_SEED_KEY`,
never from its arguments, and prints only the fingerprint. No metering
answer carries the key: `GET /balance` answers the balance alone.

The store's files are written back every 5 seconds, and at a clean stop. So
a runtime killed without one (SIGKILL, a power loss) can lose up to the
last 5 seconds of `ctx.redis` writes, per-session or not. Redis has its own
persistence settings.

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
set with the server id beside it, `.server-id`, which names the runtime's job
queue; the store directory is a path no module may declare), and the fixed
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
 "forbid": ["moduleSandbox", "autoUpgrade"],
 "modules": ["@countinghouse/ch-pack-ci-failure-triage", "@countinghouse/ch-access-github"],
 "conversation": false}
```

Every key but `version` is optional: `maxOutputBytes` and `requestTimeout`
lower the hard bounds (`requestTimeout` in whole seconds, as milliseconds:
the runtime takes seconds, so any other value fails closed); `forbid`
refuses loosening the sandbox or turning automatic upgrades on; `modules`
is the operator's list of modules by package name, parts included: when
present, only those ever load, at start, in place and on install, whatever
`settings.json` or the history say, and installing another is refused (a
ceiling that still holds `packs`, the list before it, is not trusted: it
says to list each module under `modules`); `"conversation": false` refuses every
loosening asked for in conversation, so no dialog is ever shown and each
ends at the terminal command (below). A value above it is
`SETTING_ABOVE_CEILING`, a loosening it forbids `SETTING_FORBIDDEN_BY_CEILING`.
A tightening of the value the runtime runs with is never refused by it. A
change that only lowers a stored value, and is still above both the ceiling
and what the runtime runs with, is refused (`SETTING_ABOVE_CEILING`): it
would put a value above the ceiling in `settings.json` for the next start.
For the two caps the settings tool reports, and judges a change against,
what the runtime runs with (with nothing stored, what it started with: the
ceiling may have bounded the start), not the stored default. For
`moduleSandbox` it reports the mode this runtime runs, from its start (`off`
where it runs without workers), with the stored value beside it as `stored`
where the two differ. What it
writes to `settings.json` without the user's confirmation never exceeds
what the file yields already (its stored value, else the default), and is
above the ceiling only when it lowers what the file yields: a
runtime started above the default by a flag cannot have conversation raise
the file toward its start value. A lower value than what runs that may not
be written applies to this start only, and is recorded as that. It is read once
per process, and again when the file changes.

`moduleSettings` binds the settings modules declare, per
`"<package>.<setting>"` (the last dot splits them):

```json
"moduleSettings": {
  "@acme/weather-tool.shareStats": {"fixed": false},
  "@acme/weather-tool.units": {"confirm": true},
  "@acme/repo-helper.defaultRepo": {"conversation": false}
}
```

- `{"fixed": <value>}` applies that value whatever `settings.json` says. A
  value the module's declaration rejects, or a setting it doesn't declare (a
  typo, or a version that renamed it), refuses the module's load, naming the
  entry.
- `{"confirm": true}` and `{"conversation": false}` are rules for a change
  in conversation. They bind once the settings tool changes module settings
  (its `module.*` names): the first needs the user's confirmation, the
  second allows the terminal only.
  `"conversation": false` directly under `moduleSettings` makes every module
  setting terminal-only.

Any other shape fails closed, as any key a reader doesn't know does: an
older runtime or `ch-local` never reads this key as no restriction. Where
the ceiling binds (the single-identity profile with a settings file), it is
read again at each load of a module that declares settings and at each
`reread`, and watched while the runtime has a control channel: a change
re-reads every module's settings, so a fixed value binds without `ch-local`.
A ceiling that cannot be trusted refuses such a load; a supervised restart
keeps the values the module ran with. A supervised restart the ceiling's
`fixed` refuses (a value the module rejects, or a setting it doesn't
declare) is suspended at once with the ceiling's reason, not retried: the
next load, once the ceiling is updated, proceeds.

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
identity secret, and the server id beside it, are checked by the
`--hardened` parent before it relaunches under the permission model; the
child takes those same files only, unchanged.)

In a shared runtime, every call of a session is held to the tighter of the
runtime's default and the ceiling, whether or not the session set a value of
its own, and also under a ceiling that turns conversation off or forbids
changing the setting. ch-local's `start` clamps the defaults it passes to the
ceiling; a runtime started another way, with a default above it, still
doesn't serve above it.

A session's per-call checks don't read the ceiling each time:
`lib/session-settings.js` takes its last read again for up to 1 s, on a
monotonic clock. A ceiling the settings tool re-reads replaces it at once.

The shared runtime reads the ceiling when it starts serving sessions, and
checks it again on a timer:

- **every 10 s on Linux and macOS**, where the check is a stat of the file
  and of each directory above it, and the file is read again only when one
  of them changed;
- **every 5 minutes on Windows**, where a read spawns PowerShell (a Windows
  read is taken as current for a little under those 5 minutes, so every
  check reads the file again).

So a ceiling lowered on disk bounds a session's calls within about 10 s on
Linux and macOS and within about 5 minutes on Windows, without anyone calling
the settings tool. Until it is read again the calls are held to the
operator's previous ceiling: never beyond it, and never to the runtime's
default alone.

A `--stdio` runtime does not read the ceiling when it starts or watch it:
its calls are bounded by the ceiling only once the settings tool or a control
message from ch-local has read it. Under ch-local that changes nothing, since
`start` has already clamped the flags it passes. The ceiling is a rule for a
runtime ch-local installed and starts; a `--stdio` runtime started by hand
with flags above it is not held to it before that first read.

Two limits. `<home>/history.jsonl` is a record for the user, not a security
boundary: the user can write it, so nothing the ceiling enforces rests on
it. And ch-local reads the ceiling with the runtime installed under its
home (`app/node_modules/countinghouse`): whoever can replace that code is
beyond any ceiling, as they are beyond the runtime itself.

### Confirming a loosening in the client's dialog

In this release no client is on the tested-client list, so no dialog is
shown: a loosening asked for in conversation is refused with the `ch-local`
command the user runs at a terminal, and a raised `maxOutputBytes` or
`requestTimeout` above what the runtime started with takes effect when it
next starts. The rest of this section describes the dialog as it is built;
it is not shown while no client is on the list.

A loosening asked for in conversation could come from a prompt injected
through a tool's result, not from the user. So `countinghouse_settings`
never applies one on the model's word. A raised `maxOutputBytes` or
`requestTimeout`, or a module turned on (`enabled.<module>`), is either
confirmed by the user in their client's own dialog (an MCP elicitation
form) or refused with the `ch-local` command the user runs at a terminal.
A module turned on is written to the settings file for every session of
the user, with the version the dialog named, and ch-local loads it; a
module turned off is made on request, every session told what went with
it and the command that turns it back on. Loosening the sandbox or
turning on automatic upgrades is terminal only.

A dialog is shown only when all of these hold:

- **A tested client.** The client's name and version are inside a range on
  the tested-client list (`lib/elicitation-clients.json`). A range names
  exactly the versions tested, with no open range, so a new version gets no
  dialog until it is re-tested. The list ships empty, so no client is shown a
  dialog in this version. A maintainer's hand test
  ([`docs/development/elicitation-hand-test.md`](development/elicitation-hand-test.md))
  adds the first range. After that, the automated re-test of each new Claude
  Code version (not built yet) will open the pull request that adds its range.
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
change, naming the current value (and a module's version, from ch-local's
`modules.json`). For a runtime setting no text from the model appears in
it. A module setting's dialog quotes the old value and the value asked for,
which is the model's, each cut to 200 characters, and the module's own
title for the setting, labelled as the module's own words. The model's arguments
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

In a shared runtime (one runtime serving several of a user's client
sessions) all of this is each session's own, for the two caps:

- **The change.** A confirmed raise of `maxOutputBytes` or `requestTimeout`
  is that session's override, for its calls only, until the session ends.
  It is judged against the value the session runs with. A session's own
  lowering is undone in conversation without a dialog, up to and never
  above what a session with no value of its own runs at (the value for all
  sessions, under the ceiling), which only the user or operator set at a
  terminal or confirmed. The ceiling's rules still apply to the undo: one
  that forbids the setting, or turns conversation off, refuses it, and so
  does a kind held in the session (a dialog declined, two left unanswered, or
  one still open when the session's dialogs were locked), or one locked
  across the user's sessions. Past a session's 32 recorded changes, each
  further undo is still told but only counted in history, and a hard crash
  can lose that count. The options every session shares, and `settings.json`, are not touched; every history line
  names the session, and only that session reads it. A session may also
  turn a module on or off (`enabled.*`) and change a module's settings
  (`module.*`), under the same rules as a single-user runtime: those are
  written to `settings.json` and apply to every session of the user. Every
  other setting is changed from a terminal.
- **The dialog.** Each session has its own pending change, nonce, decline
  locks and three dialogs. The key is one for the runtime and the session's
  id, which comes from its connection and not from the request, is in the
  HMAC: a state staged in one session confirms nothing in another. The
  dialog says the change is for this session only.
- **The client's conditions are the session's.** They are asked of that
  session's own shim, before the dialog and again before the change is
  applied; nothing process-wide is asked. Any frame from a session's client
  that says its configuration could answer a dialog locks every setting for
  that session's life, even when a later answer says otherwise (a hook the
  client has loaded can be deleted from disk and still answer). The lock is
  on dialogs. A session's own lowering shows none when it is undone, so it
  can still be undone. After a runtime restart a lock's cause isn't known, so
  with a client on the tested list, or a list that can't be read whole, any
  lock kept from before it holds the undo. With none, no dialog is shown that
  could be declined, and such a lock doesn't hold it; nor does a decline made
  under a later version that had one, after going back from it. Nothing is
  raised above the value for all sessions by either. Every frame is seen as it
  arrives, also one that answers late or that nobody asked for. While no client
  is on the tested list no dialog is shown to anyone, so a latched session gets
  the answer every session gets, the terminal command
  (`SETTING_NEEDS_CONFIRMATION`); one resumed after a runtime restart is told
  `SETTING_LOCKED_THIS_SESSION` until its client again reports that its
  configuration could answer a dialog by itself. With one listed, or a list
  that can't be read whole, a latched session is told
  `SETTING_CLIENT_NOT_CONFIRMED`, never that the user declined, with why its
  client said so when the client line gives it (contract 2's conditionsWhy: a
  reason from a closed set and a place under the home as "~/...", checked
  again by the runtime, so no user name and no path outside the home reaches
  the agent), and the terminal command. A session locked by a decline, or by
  two dialogs left unanswered, is told
  `SETTING_DECLINED_THIS_SESSION`. A confirmed raise of
  the output cap waits for the validators to grow; the session, its lock,
  the ceiling and its value are checked again after that wait, and a change
  made meanwhile wins.
- **One window for the user, across sessions.** Per setting (every pack
  counting as one), three dialogs declined or left unanswered within 30
  minutes stop that setting's dialogs in every session for the next 30. A
  dialog open in any session counts toward the three, so an injected
  prompt cannot spread dialogs over sessions; an accept that arrives once
  the setting has locked is refused. A dialog counts as unanswered when its
  own 120 s pass, or when its session ends, or when its session asks for
  another (the second such dialog of a setting locks it for the session,
  and no third is shown). An answer that comes after the 120 s is told the
  dialog expired. Each one is told to ch-local's daemon (the setting and a
  time, nothing else), which keeps it to hand back to a restarted runtime.
  A lock runs 30 minutes from its third event, so a restarted runtime
  needs the last 60 minutes of them to rebuild one still running (below).

**A change for all sessions.** In one session the user may ask to change
one of the two caps for every session; the model's call then says
`scope: "all-sessions"`. It is a global change, as one made at a terminal
is:

- it is judged against the default in force, never the asking session's own
  value;
- it is written to `settings.json` and applied at once to every session, as
  a terminal tightening is: a session's confirmed loosening above the new
  value is dropped and that session told; a session's own tightening is
  never dropped (it is held to the default while the default is lower,
  and is in force again if the default rises);
- the other sessions are told the setting was changed from another session;
  the history line names the asking session and, unlike a session's own
  lines, is every session's to read (no session's id is ever shown). A
  request for all sessions that was not made is the asking session's line,
  and says what it was for;
- past the asking session's 32 recorded changes, a tightening for all
  sessions still applies at once to every session, but is not written to
  `settings.json`: its history is one line and a count written later, and a
  file ahead of the history would read as an edit made outside the tools.
  It lasts until the runtime restarts, and the answer and its history line
  say so. A tightening the user wants kept is made at a terminal. Past the
  budget, taking back a raise stored for the next start changes nothing now
  and is answered the same way: the stored raise still applies at the next
  start.

A tightening needs no dialog. A loosening always needs one: the asking
session's own (it spends one of that session's three and counts in the
user's window), whose text names all sessions and says the change holds
after a restart. Its state confirms that change only: a dialog that said
"this session" confirms nothing for all sessions, and the other way round.
It is held to the operator's ceiling as any loosening is. For a raised
output cap the validators grow first, which changes nothing; then, under
one lock and with no wait in it, everything is checked as it is then (the
session, its lock, the ceiling, the default in force, the file as the
dialog saw it), the file is written, and the value is put in force. So a
change that cannot be stored is not in force, and a terminal change made
meanwhile is never written over. The session that asked gets the value
too: its own lower value for that setting goes, and it is told; another
session's own tighter value stays. What is written without a dialog never
raises what the file yields (a runtime started above it by a flag, or a
tighter value stored for the next start): such a value holds for every
session until the runtime restarts. Besides `enabled.*` and `module.*`
(above), every other setting stays the terminal's.

**Across a runtime restart.** The runtime keeps nothing of a session on
disk. After every change it tells ch-local's daemon the session's whole
state, which is its own values, its locks, its dialogs left and the kinds
of which it has left one dialog unanswered (two of a kind lock that kind):
no key, no user's name, no nonce, no pending dialog. A dialog open at a
restart is lost: its state was under a key the new runtime does not have.
It is counted for its session as one left unanswered, since a dialog open
when the state is told is told as that (as a lock, when it is the second
of its kind), and an answer corrects it. So a restart hands a session no
dialog back. It is not counted in the user's window, which counts across
sessions: after a restart with a dialog open that count is one short. The
daemon keeps the
table in memory and hands it to the next runtime before that one listens.
Its shape is checked by the daemon when it is told and twice by the
runtime when it comes back (the restore, then each row at its session's
resume), and what it says is taken only this far:

- a session's row waits for the session: its shim resumes it by a token
  only it holds, and a row whose session never comes back is dropped;
- its locks and dialogs left are restored as they were, which can only
  make it tighter than a new session;
- a tightening applies only if it is at least as tight as today's default
  and the ceiling; one above today's default is not applied, and the
  session is told;
- a value the row calls a confirmed loosening, and that is above today's
  default, applies only if the session's own client says now that nothing
  in its configuration could answer a dialog, the ceiling allows it (it is
  held to the ceiling), and the default has not been lowered under the one
  it was confirmed over; the validators grow first for a raised output cap,
  and anything the session changed, or any lock or latch that fell on it,
  while that was checked wins. Otherwise it is reset and the session is
  told. One at or under today's default (confirmed over the session's own
  lower value) is restored as the tightening it now is, with no client
  asked: reset, it would leave the session looser than before the restart.
  A restored value is recorded in the history as restored;
- what was declined before the restart loads into the user's window, so a
  lock still running holds. A list that cannot be taken, a list longer than
  the window holds, or no table at all (the daemon's did not arrive in
  time) locks every setting's dialogs for 30 minutes: what cannot be shown
  was declined is taken as declined. An empty table, which the daemon
  sends at a runtime's first start, locks nothing.

The row's word that a loosening was confirmed is the daemon's: no dialog
is shown again for it. So whoever can speak as the daemon on the runtime's
control channel can raise a session's cap as far as the ceiling, with that
session's client agreeing, and no dialog. The channel is the pipe from the
process that started the runtime, which is ch-local, the user's own; a
module has no way to it.

A `--stdio` runtime has the one store and the one start it always had, and
is outside the window.

### Declared text, as it reaches the client

What a module declares and a client shows or a model reads is cleaned as it
leaves, never refused or changed at load. That covers a tool's title and
description, a prompt's title, description, arguments' descriptions and
messages, a resource's and a template's title and description, and a
question's dialog. Each hidden character becomes a space, so no two words
are joined by what was hidden between them. These are characters a model
reads and a person doesn't see: controls, line separators, bidi controls,
zero-width characters, tags, variation selectors and fillers. They form
countinghouse's one class, `lib/conditions-why.json`'s `hiddenClass`, the
same one ch-local checks.
- A prompt's message keeps its `\n` and `\t`.
- An emoji keeps its joiner (U+200D between two pictographic characters)
  and its VS-16 (right after one).
- A resource's name is an identifier, by the meta-schema.
- A completion candidate is a value the client sends back, so one with a
  hidden character is left out rather than changed.
- A prompt's arguments are the client's own, and go into its messages as
  the client sent them.

### A module's question to the user (`ctx.ask`)

A module's handler may put a question to the user of an MCP client
(`ctx.ask`; an MCP elicitation, answered on a retry of the call). What
bounds it:

- **The module does not write what the user reads.** A question is
  declared in the module's `api.json` (a message and a form) and is
  checked at load. The handler gives a question's name and the values of
  its message's placeholders; the main thread composes the dialog,
  `<module name>: <message>`, with each value cut to 200 characters and
  cleaned of control and bidi characters. So the sentence was there to
  review at install, and the user sees which module is asking.
- **A module asks only its own questions.** The worker sends
  `{token, name, values}`. The asking module, service and action are the
  call token's, written by the main thread when it sent the call, never
  the message's.
- **The form and the answer are checked off the main thread**, in a
  validator worker, against the module's own schema. An answer holds the
  form's own properties and no other. The module gets the answer's content
  and nothing else: no client name, no session, no user.
- **Only the main thread says "input required".** The call is answered
  with a question only from the main thread's own record that the handler
  asked one. Nothing a module returns or throws can produce that answer.
- **The retry's `requestState`** is the client's to send, so the
  attacker's to write. It is `v2.<sealed payload>.<mac>`: an HMAC-SHA256
  under a key derived from the identity secret, over the sealed payload and
  the call it is good for (the caller's opaque id, the session, the method,
  the tool and a hash of the arguments). It lasts five minutes and is used
  once. **The payload is sealed:** AES-256-GCM under a key derived from the
  MAC key, a key of its own for each state (a fresh salt), checked by the
  MAC before it is opened. It holds a nonce, the expiry, the question's key
  (which names the question and the module that asked, an unlisted part
  included), the round and the earlier rounds' answers. It is padded to a
  length set by the answers alone, which the client already has, so its
  length says nothing of who asked. A `v1` state, whose payload was in the
  clear, is refused.
- **One refusal.** A state that is not this call's, has expired or was
  already used gets one answer with one text (`ASK_STATE_INVALID`); which
  it was is in the runtime's own log line only. A store that cannot say
  whether a state was used is a different, retryable refusal
  (`ASK_STATE_UNCHECKED`): nothing runs, and it is never taken for a
  replay or for a first use. A store that timed out may still have
  recorded the state as used; the same retry is then refused, and the
  caller calls again to be asked again.
- **Single use rests on the store.** A used state's nonce is kept until a
  minute past its expiry: in Redis db 14 under `--store redis` (a
  `SET NX` with an expiry), in `<storePath>/used-nonces.json` under
  `--store local`, so a restart inside those minutes still refuses it.
  For Redis this needs what the rest of the runtime's data needs: **db 14
  must not evict** (`maxmemory-policy noeviction`, or no `maxmemory`),
  and a Redis restarted without persistence forgets the nonces of the last
  six minutes, which makes a state from those minutes usable once more by
  whoever holds it and the caller's key. Run Redis with AOF or RDB
  persistence if that matters to you.
- **A call is asked at most eight rounds in all**, any mix of questions,
  and three at most of one question; one that three rounds left
  unanswered stays so for the call. The call's round count rides in the
  state with what the call has settled, so a module cannot ask a user
  without end by changing its question's text: each new text is a new
  question in its first round, and the call's count is what stops it. A
  pass that ends on a question is not billed, which is why the count is
  the call's and not only the question's.
- **A state is used up when its retry is taken**, before the call's own
  checks: a retry that is then refused (a rate limit, a busy worker) has
  spent the user's answer, and the next call asks again. Single use is
  put before that convenience.
- **Under `--stdio` a restart ends every dialog.** Its one session's id is
  made at each start, and a state is bound to its session. A shared
  runtime's session keeps its id across a restart, and HTTP has none, so
  there a state from before a restart is still good, once.
- **An answer is not proof of a person.** A client may answer a form by
  itself. A module's question loosens nothing in the runtime, so the
  tested-client list that guards the runtime's own confirmations
  (above) is not applied; a module must never treat an answer as
  authorization for what the caller's key could not do without it.
- **`--moduleQuestions off`** turns every module's question off: each
  `ctx.ask` is then `ASK_UNAVAILABLE`. So is one from a legacy client, a
  request that declares no form elicitation (a task's: the request that
  made it), HTTP `invoke-action`, and so is a part's under any of these.
- **A part asks only its own action's questions, and only the outer
  call's user (M14).** Who asks is the hop's token entry (its device and
  action, written by the main thread when it issued the hop) and the
  asking worker's own module, never the message. The call's one ask state
  stays on the outer call's token, so its round limits hold for the whole
  chain. The state names who asked, under its MAC, and the retry's answer
  is checked against that asker's own form, looked up afresh: an asker
  that is gone, or no longer declares the question, gets no answer. The
  dialog carries the listed module's name; an unlisted part is never
  named to the client, only in the runtime's own log and usage record.
  So a scenario vouches for its parts' declared questions: when you review
  a scenario, review its parts' `questions` too, since the user reads each
  under the scenario's name.
- **A call cancelled while its form is made gets no state.** None is
  minted, so none can be presented later.
- **A task's question is held on the server (M22).** A task has no
  requestState: its pending question, its answers and its rounds are a
  record in the store's kv (`task-ask:<taskId>`), outside every module's
  namespace, so no module's `ctx.redis` reads or writes it; no worker sees
  it. The record keeps the task's owner and its session's hash, never the
  session's id. `tasks/update` finds the task as `tasks/get` does (the
  caller's own, in its session: anyone else's is the one unknown-task
  error), and the record's own session is checked again. Answers come only
  from a request that declares form elicitation, as only such a poll is
  handed the form: a `tasks/update` with `inputResponses` from any other
  is refused `-32021` before the task is looked up, so the refusal says
  nothing of one. Outside shared
  mode the owner key decides, so a key that may read another owner's task
  (an admin, as M15 rules for `tasks/get` and `tasks/cancel`) may also
  answer its question. Only the waiting
  question's key is read; its answer is taken once (a compare-and-set, a
  script on Redis), checked against the asker's own form, and the handler
  runs again under the same `taskId`. A cancel removes the job and the
  record together, and a cancel racing the answer wins: the run again is
  never started, or, already running, it goes to its end unread. A
  question waits at most an hour (the task then fails `ASK_EXPIRED`), and
  at most 64 of a key's tasks (10,000 in all) wait at once, so the records
  a client can make are bounded.

### Completion actions

Completion actions run module code per request: they are rate-limited (the
per-key limit every request counts against) but not billed, so a module's
completion action should be cheap. Each is authorized as a call of its
action, runs in the caller's session's worker for a per-session module,
answers within 2 seconds or is cancelled as a cancelled call is, and has
its values bounded (100 of 256 characters). A prompt or template the caller
is not listed is answered as an unknown one.

### Change notices on a listen (`subscriptions/listen`)

A listen is opened by a key (on a shared runtime, by a session), counted
against that key's or session's limit, and sent only what it agreed to.
Each list it follows is the list its own key and session are shown, so a
notice never tells a caller about a module it cannot reach. A
`resources/updated` notice goes only to the subscriptions of the key whose
call succeeded: a module that keeps data per caller would otherwise tell one
tenant when another was active. Each subscription's URIs are resolved in its
own view (its key and session), and on a shared runtime a per-session module's change reaches only the calling
session. A URI the caller can't read is left out of what is agreed, so a
listen can't be used to learn that another tenant's resource exists. A call
is announced where it is recorded, on the main thread, by every entry path;
module code in a worker can't record one. A call with no key (`--debug`
without `--debugKey`) is not recorded, and announces nothing.

What a listen costs is bounded. Calls are held for a quarter second in a
batch of their own key and session, each with its own timer, so a notice's
timing says nothing about another key's or session's calls; a batch holds
each call once and never starts a round while its last one runs. An HTTP
listen whose client leaves more than 1 MiB unread is closed, which cancels
it and frees its slot, so a client that never reads holds nothing of a
key's notices. The runtime's own reads of a listener's lists never spend
its rate limit.

A 2026-07-28 client that declares the tasks extension can name its tasks on
a listen (`notifications.taskIds`, at most 64). Each id is agreed only if
`tasks/get` would answer it for that caller right then: the same lookup, by
key and, on a shared runtime, by session. Any other id is left out of the
acknowledgement without an error. That covers another caller's task, an
unknown id, a malformed id, a legacy task and an expired one, and they
can't be told apart, so a listen can't be used to learn that another
tenant's task exists. A change is announced by its id alone. Every
`notifications/tasks` is built by that same lookup again when it is sent,
with the caller's key resolved again, and it is the task exactly as
`tasks/get` would answer it. A task the caller can no longer read (its job
gone, its session ended, or no longer an admin's) is dropped silently. A
listen whose key no longer resolves (revoked) ends, with an error. A working task's notices are coalesced to at most one a second
per listener and task, a flood of changes costs one lookup at a time, and a
closed listen frees its timers.

### What the MCP layer serves, and its bounds (MCP completeness)

The 2026-07-28 surfaces (stored results, module resources, prompts,
completion, questions, listens, tasks, cancelling) are a layer over the
schema contract. They add no way for module code to learn who is calling,
and every one is bounded.

- **Identity never reaches a module.** A resource read and a completion
  action get the same `ctx.caller` as a call, `{id, isAdmin}`: the opaque
  id, never the key or the user's name. `ctx.ask` returns the answer's
  content only. No URI, cursor, progress token, task id, session id or
  `requestState` is passed to a worker; each is resolved on the main
  thread. Error texts and log lines name the module and the action, never
  a key or a user name. An icon is inlined at load, so a client never
  fetches a module author's URL.
- **Stored results** (a value past the inline budget, linked as
  `countinghouse://r/<id>`). The id is 256 random bits, and every read
  checks the owner and the session as well, so knowing a URI isn't enough
  to read it. One answer serves an unknown, an expired and another
  caller's result alike. The files are owner-only, in a directory of the
  runtime's, never under a module's data path, so no module reaches them
  through the file broker.
- **Module resource URIs** (`countinghouse://m/<module>/<path>`) are parsed
  by one strict function. Anything that doesn't match a loaded template
  exactly is "not found". A variable holds no raw `/`, and is decoded
  strictly. The decoded value is only ever an input to the action,
  validated by its schema; the runtime never uses it as a path, a key or a
  log field. A module that reads files from a variable must guard it, as
  for any input. No other scheme is read, and the runtime never fetches a
  URL.
- **Prompt text** is declared and reviewed. An argument is substituted
  once, as text, and bounded.
- **A tool the caller can't see** gets one answer on `tools/call`, decided
  before anything module-specific, so no probe tells what is installed. No
  key, or a key the auth layer does not know: its auth refusal, decided
  first, the same for every name -- a module's tool, an unlisted part's,
  one never registered, and the runtime's own `countinghouse_*` tools,
  enabled or not. A known key: a name never registered, a tool outside its
  grants (an unlisted part's too) and one hidden while its module goes on
  or off all answer `unknown tool: <name>; countinghouse_overview shows what is installed here and which tools you can use`, byte for byte, and so does a
  runtime tool not listed to it: an authoring tool for a key that is no
  admin's (whatever `--authoringTools` says), and in the single-identity
  profile the built-ins it hides (outside it, `countinghouse_settings`). A
  key granted an unlisted part still learns it is not listed. The grant set that chooses
  the answer is kept per known key (by a SHA-256 digest of the key, never
  the key) for at most 5 s; authorisation is still `userAuth`'s read on
  every call, so within those 5 s a revoked grant's tool gets the auth
  refusal (which tells it from a name never registered), and a new grant's
  answers "unknown tool". A reload of the auth config ends that window at
  once for the file provider; the sqlite provider has no change signal, so
  for it the 5 s is the bound. The CouchDB provider keeps its own cache of
  the users it has looked up (at most 4096, the least recently used
  dropped), which never expires on its own: a change made in CouchDB is seen
  after `POST /reload-auth`, which empties it, or a restart. The cost: a key not in
  the cache -- never seen, pushed out past the 1024, or after a reload
  cleared every key -- is resolved before its grants are read, so an
  unknown key costs one provider read and a valid key's first call one
  serial read more; a key in the cache whose 5 s have lapsed has both read
  side by side, and a fresh one neither. Whether the key is an admin's is
  kept with it the same way, to choose an answer only: for up to 5 s a
  just-promoted admin is answered "unknown tool" for an authoring tool,
  and a just-demoted one costs one fresh read before the same answer (an
  admin's call is always read fresh before it runs).

**Bounds.** Each is enforced on the main thread, and each has a test that
fails if it is removed:

| Surface | Bound | Pinned by |
|---|---|---|
| A list page | `--listPageSize` items (250; 10 to 1000); a cursor of at most 512 bytes | mcp-contract 21, 20 |
| Declarations per module | 32 prompts; 8 messages of at most 8 KiB each; 16 arguments; 4 questions per action; 16 binary fields per action; 4 icons of at most 16 KiB; `api.json` at most 256 KB | module-authoring 06, module-loading 23 |
| A result's binary values | at most 16; inline up to `--inlineContentBytes` (1 MiB), linked past it | validation 18, mcp-contract 15 and 03, store 08 |
| The result store | per owner 128 MiB under Redis, 256 MiB under the local store (`--resourceQuotaBytes`) and 1024 items; `--resourceStoreBytes` in all; `--resourceRetention` | store 07, 08 |
| A resource URI | at most 2048 bytes; at most 8 variables | mcp-contract 25, module-authoring 06 |
| A listen | 64 URIs and 64 task ids; 8 listens per key, 2 per session, 512 in all; an HTTP listen closed past 1 MiB unread; a working task's notices at most one a second | stdio 32, mcp-contract 09, 37 |
| Completion | 100 values of at most 256 characters; a completion action answers within 2 s or is cancelled; the per-key rate limit | mcp-contract 30, stdio 33 |
| A prompt's answer | at most 64 KiB, measured before it is built and again as sent | mcp-contract 24 |
| A question | a dialog of 1000 characters; 8 form properties; 8 rounds per call, 3 per question; a `requestState` of at most 16 KiB; answers of at most 8 KiB | questions 01, 05, module-authoring 06, mcp-contract 10 |
| A task's question | at most 64 of an owner's tasks waiting, 10,000 in all; a wait of an hour, then `ASK_EXPIRED` | questions 08 |
| Progress | 4 a second and 240 per call | mcp-contract 10 (progress) |
| Cancellation | a request of the caller's own connection or session only; an unknown id ignored; no answer and no error text | mcp-contract 18, 19 |
| Every read, get, completion and task method | the per-key rate limit, once the key resolves and before any lookup (on Redis, also counted in memory, so Redis going down gives no key a fresh allowance; that count is per process: N runtimes on one Redis allow up to N times the limit during an outage); answered as every limiter (429, `Retry-After`; on `/mcp` the JSON-RPC error -32000 with the code in its data, 200 inside a batch) | auth 15, mcp-contract 24, 26, 30, 09, 43 |
| `tools/call` | the per-key rate limit (and `--globalRateLimit`) on the call's run, after its one answer for a tool the caller can't see is decided; a key that does not resolve is limited per address before its resolution (below) | auth 15 (a built-in), mcp-contract 37 (a task); auth 54 the order |
| A key that does not resolve | `--unauthRateLimit` (30) lookups per client address (IPv6 by its /64) per minute, counted per lookup (a batch's each) and while in flight, kept unless the key resolved; ten times that per wider prefix (IPv6 /48, IPv4 /24), a hundred times that across the process, all three always; only the request's own lookups, while it is answered and of a key it carried; then 429 `UNAUTH_RATE_LIMITED` with `Retry-After`, before any auth lookup, the same answer whatever the key and whatever is named (within a request already under way: that error, no lookup; on `/mcp` -32000 with the code in data); 10,000 addresses kept, the least recently counted out first | auth 59 |
| The grant sets `tools/call` is answered by | a known key's only, kept by a digest of the key; at most 5 s old, refreshed by every list's read, all cleared by an auth reload; 1024 keys, the one written longest ago out first; a failed read never kept | mcp-contract 40, auth 54 |

**Requests whose key doesn't resolve.** Without a limit, a loop of requests
with made-up keys cost one auth-provider lookup each, and nothing slowed it:
the per-key and global limits only begin once a key resolves. Now every
HTTP request carries its client's address (the socket's, or, behind a proxy
named with `--trustProxy`, the client `X-Forwarded-For` names; every
spelling of one address -- case, the IPv4-mapped forms, brackets, a port, a
zone -- is one client) to the one place a key is looked up (`/device-list`
resolves its key there too). Each lookup takes a place in the address's
budget while it is in flight, so requests sent at once cannot all pass
before any is counted, and keeps it unless the key resolved (a known key,
with the device or without it); anything else counts, a provider's failure
or a code the runtime doesn't know included. Past `--unauthRateLimit` a
minute, that address is answered 429 before anything is done for it, and a
lookup a request under way would make (the next message of a legacy batch)
is not made; every route answers it alike (429, `Retry-After`, the code; on
`/mcp` the JSON-RPC error -32000 with the code in its data).

Only the request's own lookups count against its address: those it makes
until its answer is sent -- or, when the connection closes first (a client
that drops it mid-batch), for one more minute -- of a key it carried, or
with no key when the route read none. A job a request queues runs outside
it. A module's worker or a
validator started while a request is served is started outside it, and a
change notice's re-listing for another subscriber is another key's; neither
is counted against, or refused for, the request that happened to start it.

Three limits apply to every lookup at once, with no switch between them:
the address (an IPv6 /64, an IPv4 address) at `--unauthRateLimit`; its
wider prefix (an IPv6 /48, an IPv4 /24) at ten times that; and the process
at a hundred times that. A spray over many addresses of one network is held
by the prefix limit, and a spray over many networks by the process limit, so
however many addresses a client cycles through, and however the table of
windows (10,000 of each, kept for memory only) pushes old ones out, the
lookups it costs stay bounded. A key that resolved in the last ten minutes
passes all three. The accepted cost: under a spray wide enough to fill the
process limit, a client whose key has not resolved in the last ten minutes
-- a new one, or every one after a restart -- waits until it ebbs.

`--trustProxy` belongs only behind a proxy you control: otherwise
`X-Forwarded-For` is the client's to forge, and each forged value would get
its own budget. A hop count is right only when it is the real number of
proxies (one more, and the client's own entry is believed); more than 10
hops is refused, and so is any list whose ranges together cover more than
an IPv4 /8 or an IPv6 /32 of public addresses, however spelled (an
IPv4-mapped form, several narrower ranges). The private ranges, by
Express's names (`loopback`, `linklocal`, `uniquelocal`) or as ranges inside
them (`10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`), are not counted: no client
on the internet has a socket address in them.

A key that resolved in the last ten minutes, from any address (its digest
is kept, never the key), still passes, so a user behind a shared address is
not shut out by another's bad requests, and it is still looked up as any
key is; a key refused since (revoked) leaves the set at once, though not
for a provider that failed to answer. A valid key not resolved in the last
ten minutes is counted like any other while its lookup is in flight, so
more than the budget's worth of its requests at once from one address, or
its first request from an address others have put over budget, waits too.
API keys are
high-entropy: this bounds the provider's load, it is not brute-force
protection, and it is not what keeps a key from being guessed. In memory,
per process: several runtimes each allow their own budget. `--stdio` and
`--sessionSocket` are local and authenticated, and are not limited.

A module resource read takes its token from the call path, after the
listing lookup that finds its action: a probe of a URI that reads nothing
is limited too, and no module code runs before the limit.

**What is recorded, and what is not yet.** There is no audit log in this
release; it comes with the planned audit work (structured records,
bounded retention, an administrator's readback). Until then, these events
are a usage record or a log line, and none carries a key, a user's name,
a module's text or an answer:
- a call's result (`ok`, `error` with its catalogued code, `cancelled` --
  a task's pass whose end is being recorded when the in-memory job runner
  closes counts as cancelled too, unless its question was already written,
  when it is recorded as asked; a pass the closing runner interrupts
  inside the module's code is not recorded yet -- a later fix),
  with what was stored past the inline budget counted in its bytes;
- a stored result refused (`RESULT_STORE_FULL`), and a stored result read;
- a module resource read, recorded under its action's tool;
- a question asked (its module, action, question name and round); a retry's
  answer refused (`ASK_STATE_INVALID` or `ASK_STATE_UNCHECKED`, the log
  line naming why: expired, used, and so on);
- a task's question asked; a task's pass that ended on a question no form
  could be shown for (outcome `unavailable`: a pass, run again, never a
  call, counted in the usage report's `unavailable`; so is one whose
  question found no room among the tasks waiting on questions); and a task
  cancelled while a pass of it ran (one cancelled between two passes runs
  nothing more and records nothing more: its passes are recorded).

These events are **not recorded in this release**:
- a stored result's id and size per item, a read of one refused or
  cancelled, and one expired;
- a module resource read that found nothing, or was limited (and a read is
  not marked apart from a call of its action);
- a question answered, declined or left unanswered for three rounds (a
  task's question too), and, for a retry refused, its module, action,
  question and round; a task's question expired, or answered under a key
  that is no longer waiting;
- a task created, cancelled before it ran (2026-07-28 or legacy), or
  expired;
- how far a cancelled call had run (only its time and bytes);
- a list cursor refused.

### Modules loaded in place, by module (ch-local's control channel)

ch-local loads, reloads and unloads modules while the runtime serves
(`lib/modules-in-place.js`; #413 section 7). In the module form a message
names a top-level module by its package name and gives `dirs`, the
directory of each module of its closure:

- **Only the module store.** Every directory a message gives, and every
  `--loadModule` and `--partDir` directory of a start given `--modulesRoot`,
  must lie inside `--modulesRoot` by real path, with no link leading out
  anywhere in it, and hold the package its key names. A module calls its
  parts only among the directories given: there is no `node_modules`
  search, so a package planted in `~/node_modules`, or beside a module, with
  a part's friendly name is never loaded as that part (`PART_MISSING`).
- **Hidden while it changes.** What a load newly brings in is in no list
  and reached by no call, hop, direct peer channel or job run until every
  module of it is up; what an unload takes away is hidden from its start.
  A module whose unload fails (still in the module map) stays hidden until
  the runtime ends, and a load whose closure holds it is refused
  (`lib/module-visibility.js`).
- **The ceiling by module.** A trusted ceiling's `modules` list must name
  every module of a closure, parts included (`SETTING_FORBIDDEN_BY_CEILING`
  for one it leaves out). A ceiling that still holds `packs` is not trusted,
  so it refuses every load (fail closed).
- **Credentials by repetition only.** A load's `credentials` may only
  repeat a binding the start's `--remoteCredentials` file fixed (the same
  slot for the same module, origin and variable): a message can never bind
  a key anew.
- **A module the runtime gives up on.** On a runtime with a control
  channel, a module the supervisor would suspend (three exits within ten
  minutes, or a restart the sandbox refuses) has every unit that holds it
  unloaded by the runtime itself, on the channel's own chain; only once
  nothing of it is left is ch-local told `module-stopped`, so ch-local and
  the runtime never disagree about what is loaded. A top-level module the
  start refused is told the same way, with `when: "start"`. Without a
  control channel a suspended module stays suspended and listed until
  `POST /restart-module`.
- **Settings re-read, never an unload.** `{type: "reread", what:
  "module-settings"}` reads the `module.*` values of `--settingsFile` again,
  under the ceiling as it is now, for every loaded module that declares
  settings (`lib/settings-reread.js`). A module with any value refused (or
  a `fixed` value its declaration rejects, or a ceiling that cannot be
  trusted) keeps **all** of its old values; the others apply, each with a
  new version its next call carries. The reply is `{applied, refused:
  [{name, code}]}`; each refusal is a notice to the sessions that have the
  module in view (a part is said as "a part of" its top-level module, and
  the ceiling's file problem goes to the operator's log only) and, for a
  value, a `not applied` history line, never the value (the ceiling's, when
  its fixed value is what refused). A value that already was not applied,
  unchanged, holds nothing back, and one refused is said once. A setting
  change never unloads a module: one left with a required setting unset
  stays loaded, and its calls answer `SETTING_REQUIRED`.

The pack form (`scenario`, `pack`, `global`, a pack's own credentials file)
is gone: a message carrying any of its fields is refused, and so is
`--packsRoot` at the start.

### Modules that keep state per session

On the shared runtime, a module that declares
`"countinghouse": {"state": "per-session"}` runs in one worker per session
that uses it, with that session's own `ctx.redis` keys, `/data` and `/tmp`
([module development](module-development.md#modules-that-keep-state-per-session)).
What keeps one session out of another's:

- **The worker is never the caller's choice.** Every call carries a call
  token the runtime issues and binds to the session it was made in. A
  direct call, a hop (`ctx.call`) or a task run reaches the worker of the
  session its token names, which the main thread looks up for each call. A
  session, or a module acting for it, reaches only its own session's
  worker and storage. A call whose session has ended reaches none: it is
  answered as a device that was never hosted, and nothing runs.
- **Never over a direct peer channel, under any profile.** Hops into a
  per-session module always go through the main thread, routed by each
  call's own token, and the runtime never opens a direct channel to one.
  A caller's peer channels are keyed by the device they lead to, not by
  session (a module never sees a session id), so a channel opened for one
  session's call would carry another session's later hop into the first
  session's worker. The broker answers a request for one with "route
  through the main thread"; and were a channel to a session's worker ever
  to exist, an invoke on it by another session's call is refused. On the
  shared runtime peer channels are off anyway (it is the single-identity
  profile), but the guarantee doesn't rest on that.
- **No session id reaches the module**: not in its options, environment,
  `ctx`, paths (its `/data` is mapped on the main thread) or error texts.
- **Shared modules are trusted with every session's data.** A shared module
  is reached by every session by design. While it serves two sessions'
  calls at once it holds both tokens, so it could hop into either session's
  per-session worker. Only load as shared a module you would trust with
  all of the user's sessions. That is the case already: on the shared
  runtime every session is the same user.
- **The memory bound is the operator's.** `--maxSessionWorkers` (default
  16, in all) is a terminal flag only, not a setting a session can change.
  It bounds their memory at about 15 MB once plus about 24 MB per
  per-session worker (measured, Node 24, a small module; a heavier module
  adds its own heap): the default cap is about 400 MB at most
  ([benchmarks](benchmarks/lean-worker.md)).
  At the cap only an idle worker is retired, never one with a call still
  within its timeout. A call past its timeout and a 5-second margin has
  been answered (its own timeout did that) and no longer counts, so a
  handler that never answers can't hold a slot for good: its worker may be
  retired mid-handler. A session that can't get a worker is refused
  `SESSION_WORKERS_BUSY`; nothing is queued.
  Residual: a task whose handler never answers holds its slot until the
  task's timeout: its own, when it was added with one, or else
  `--jobTimeout` (1 hour by default; an operator who sets 0 has chosen no
  bound). The timeout counted is the one at the send:
  a session that tightens its timeout during a call, or cancels it, frees
  the slot only at the original timeout (a follow-up after R1).
- **Storage ends with the session.** A session's partitions are removed
  when it ends for good (it leaves, its reconnect window passes, or a resume
  never settles), after its workers stop; and at a start, once the runtime
  listens, in the background, for every session neither restored nor open.
  What a session's partitions held leaves its module's shared disk quota
  with them: the session's own share, exactly. Removal never follows a link out of the module's data
  directory, and a partition that can't be removed doesn't stop the runtime
  from starting.

### What this explicitly does NOT provide (accepted gaps and limits)

The following are known, accepted, and not hidden by the layers above.
The sandbox isolates modules from each other and from tenants' data inside
one process; it does not isolate countinghouse from the host. Run it as an
unprivileged user in a container with limits and the default seccomp
profile: [deployment.md](deployment.md) gives the posture, a reference setup,
and the short list of what the in-process sandbox cannot give.

- **API keys are held in the clear by the auth stores and in the main
  thread's memory.** The auth stores keep keys as they are: `auth.json`, the
  sqlite database and the CouchDB documents. So protect them as secrets. The
  runtime enforces what it can check on the files it reads: it reads
  `auth.json` only when the file is its own user's, a regular file under one
  name, never a link, and owner-only (mode `0600`; on Windows an ACL that
  lets only that user read it). The sqlite database is checked the same way
  before it is opened, together with its side files (`-journal`, `-wal`,
  `-shm`) and, on Linux and macOS, its directory and every directory above
  it, which no other user may write in: SQLite plays back a journal it finds
  there. On Windows its folder is not checked. The runtime creates both stores so.
  Anything else refuses the start, naming the fix. Under `--hardened` on
  Windows the sqlite store is refused at every start, as its ACL can't be
  checked there. A reload of an `auth.json` that is this user's own but
  others may read, or whose ACL can't be checked, applies only what
  tightens. CouchDB is a remote store, and its access control is
  its operator's; the CouchDB provider keeps a cache of looked-up users in
  memory, keyed by the key's meterId, never the key. In memory, the
  main thread holds raw keys for as long as it needs them:
  - for the process's life: the loaded auth config, the identity index (to
    re-check and bill a queued job's owner), `COUNTINGHOUSE_API_KEY`, and the
    single-identity profile's own key;
  - while a composing module is loaded: its bound composition identity;
  - until a call answers, at most an hour: the call token's entry on the main
    thread, which holds the call's billing and identity keys (the token a
    worker holds is only a handle);
  - until a hop is billed or forgotten, at most 4096 per channel: a peer
    channel's unbilled hops;
  - for a running job: its owner's key, found again from the owner's id;
  - and for a request: that request's key, an open subscription's among them.

  None of these reaches a module in a worker (the default), a log, Redis or a
  job's stored data. In single-thread mode a module runs in the main thread
  beside them, with no sandbox
  ([Single-thread mode has no sandbox](#single-thread-mode-has-no-sandbox)).
  Keeping keys only as keyed hashes in the stores and only as handles in
  memory is planned after release 1.
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
- **Module code can reach countinghouse's objects it is handed.** Part 2
  closes the file routes through countinghouse's loader (layer 3), and
  #194's PR 2 the module objects (`require.cache` holds the module's own
  files only): through `CHUtil` and what the runtime hands it, module code
  can still use objects countinghouse made before the lockdown. `CHUtil` and everything else loaded before
  lockdown stay part of the review checklist for every change to
  `lib/countinghouse-util.js`. Nothing of the runtime's own loads or
  resolves after the lockdown (#194's PR 1): what it used to load on first
  use (the worker logger, redis-api, bind-address, the live options, the
  file broker's built-ins, the validator's files in a validation worker) is
  loaded at a worker's boot, so a `require.cache` entry or a relative
  resolution module code plants has no runtime load to reach.
  test/sandbox/66 records every runtime `_load`, `_resolveFilename`,
  `createRequire` and `getBuiltinModule` after the lockdown on each of
  those paths, and test/sandbox/67 pins the boot closure, dependencies
  included, against a `require` inside a function. postman-request, behind
  `CHUtil.request` and a remote service client, is loaded at set-options,
  before the lockdown, when the module declares `net`, in both modes. A
  module with no `net` under `enforce` has every request refused before
  the library is reached. Under `audit` such a request is allowed and
  reported, and postman-request then loads after the lockdown (the net
  says so), so a module can plant `require.cache` entries for it first:
  audit isn't a boundary,
  and the request carries only the options the module itself passes, so
  the late load exposes nothing it didn't already hold (preloading it on
  every audit worker would cost about 240 files at each boot).
  bcrypt-pbkdf, which sshpk requires on the first encrypted OpenSSH key
  (the `httpSignature` option), is warmed with postman-request, so that
  require is a hit in Node's cache however the option arrives. The options
  are put together as postman-request does (a second options argument
  included): enforce hands on only their checked own keys, with no
  prototype; audit hands on postman-request's own copy (own and inherited
  keys, each read once) and reports over that same copy. A module file the
  runtime loads (a handler, `CHUtil.loadFile`) has the module's own anchor
  as parent, a `Module` whose file is inside the module root, never a
  runtime `Module` (and never null, which would read as a main module).
  Everything a call's token goes through is loaded at a worker's boot, and
  its exports and classes' prototypes are fixed there (above), so what
  module code reaches this way it can read, not change.
- **A module can obtain a peer port transferred into its worker.** Node
  writes the array of ports a message transferred natively, index by index,
  before any JavaScript runs, so a setter module code puts on an index of
  `Array.prototype` or `Object.prototype` is handed a peer channel's port
  as it arrives. This gives it nothing beyond posting on its own end of the
  channel: tokens, targets and input never cross the port (they go to the
  main thread in the caller's announcement), and each invoke is checked
  against the main thread's announcement before it is served, so a forged
  or replayed invoke is refused unserved (test/sandbox/63). An index
  accessor on `Array.prototype` would close it at the cost of every array's
  holes and V8's fast path in the module's worker, which is worse.
- **`BroadcastChannel` reaches past the envelope under `audit`.** The
  global lets module code in two workers send each other messages directly,
  unmetered and outside the main thread's bounds. Under `enforce` it is gone
  from module code's realm (and `worker_threads`, its other route, is a
  refused built-in); under `audit` it stays, and its first construction is
  reported (#194's PR 2, test/sandbox/68).
- **Module code can talk to the main thread as if it were countinghouse.**
  The worker's own channel to the main thread is reachable from module code
  (through `CHUtil.redis.clientInstance`; the global
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
  module's console output and its worker's log are capped. Under `enforce`
  module code is never handed a port to the main thread; under `audit`,
  `require('worker_threads')` hands it `parentPort` and the file bridge's
  ports. What
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
  An open whose parent directory did not exist when the broker checked it,
  and appeared before the open, is decided on where it really landed; under
  `enforce` a name there that is a link is refused outright, wherever it
  leads, and reported as `link-appeared` (not as an escape): such a link
  appeared in the race itself, and nothing legitimate needs one there.
  A name that is a link to nothing when the broker checks it is refused
  under `enforce` before the open (reported as `link-dangling`): opening it
  would follow it wherever it leads, outside the namespace, or to a file a
  host process points it at in between, before anything could judge that.
  Writes through a dangling link are refused under `audit` and `enforce`
  alike (reported as `link-dangling`; `audit` previews `enforce`, and no
  write under it leaves the module's own area); a read finds nothing, as
  before. A module that wants a file there writes the target, or makes
  its link again. Where the broker saw no link at a name -- nothing there,
  or a plain file -- the open passes `O_NOFOLLOW`, so a link a host process
  puts there in between is never followed: the open fails, nothing is
  created, and it is reported as `link-appeared`. Where it reached a file
  through a link, the open goes to that file's real path, never through
  the link again; and where it saw a file, the open never creates one, so
  a parent or a link changed in between makes nothing anywhere. Windows has no
  `O_NOFOLLOW`: there the checks after the open stand alone, refusing the
  descriptor, and a file such an open created where the link led can stay.
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
  The quota counts by the root a path names; a link a module makes between
  its own declared roots can move bytes between their counts, never past an
  uncounted root's existing freedom.
- **A stuck host operation delays a restart by at most 35 s.** After that
  the next start goes ahead and logs what was still running; a late write
  can land in the fresh `/tmp`, or leave the quota count a little off.
- **The worker's environment holds only approved variables** (in `audit`
  and `enforce`). That includes no `NODE_PATH`, so a module cannot reach
  countinghouse's `lib/` by bare name. Under `enforce` `/proc/self/environ`
  is outside the namespace too; under `audit` and `off` a module can still
  read the process's whole environment there, unless `--hardened` is on.
- **HTTP proxies are not supported in this release.** A remote MCP server
  is reached with the runtime's own agent, which reads no proxy variable
  (`lib/remote/fetch.js`). Under `enforce` the lockdown sets `proxy: null`
  on a module's `CHUtil.request` (`lib/module-lockdown.js`), so its calls
  go direct whatever it declares. Under `audit` and `off` the request is
  handed on as the module made it, so a module given a proxy variable it
  declared (`HTTPS_PROXY`, `NO_PROXY` ...) does go through that proxy. In
  every mode a declared proxy variable's value is readable by the module,
  credentials in the URL included: don't approve one. A network that
  reaches the internet only through an HTTP proxy is not supported yet;
  proxy support held by the runtime, out of every module's reach, is
  planned.
- **`--hardened` limits.** Node's permission model follows symlinks, so a
  symlink inside `--modulePath` that points elsewhere is readable, and write
  access covers all of `--modulePath` and `--moduleDataPath` (including other
  modules' directories and the module registry database). `--allow-addons`
  is added only for the SQLite auth provider, or for `--moduleRegistry` with
  no `--loadModule` (the module registry database uses `sqlite3`); a start
  with neither gets no native addons at all. It puts native code in
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
  ([differences](module-development.md)). Module settings run only with
  worker threads: there a module that declares settings is refused at its
  load and at a reload (`SETTINGS_NEED_WORKER_THREADS`), so no settings
  state, and no ceiling's fixed value, ever has to be kept in the main
  thread a module shares.
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
  main thread reads it. One limit: a remote that echoes a credential back
  with extra whitespace can get it into the local log line; the fix comes
  in 1.1.
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
- **Bound to one module (version 2 of the file, #413 section 6.5).** A key
  is bound to (module, variable, origin) and read from a slot,
  `COUNTINGHOUSE_CREDENTIAL_<n>`: a prefix the runtime never hands to a
  worker, and the only names the file accepts, so it cannot send the
  identity secret or any other variable of the runtime's environment
  anywhere. The start's file fixes each slot for the life of the process;
  a later entry may only repeat one. Another module that declares the same
  variable and origin gets nothing, and so does a version of the bound
  module that sends it to another origin or under another name.
- **Never in a worker's environment** (under `--moduleSandbox audit` and
  `enforce`; with the sandbox off, or in single-thread mode, a module shares
  the runtime's environment and this does not hold). A variable a
  credentials allowance in force reads -- version 1's listed names; version
  2's slots and every variable name the file binds, since the operator's
  own variable of that name may still be exported -- is never copied from
  the runtime's environment into a worker, even when a module declares it
  in `permissions.env` (before, under audit, a declared `GITHUB_TOKEN` was
  handed over). Only a value the operator's
  `--modulePolicy` sets for that module under that name is given: it is the
  operator's own value, not the runtime's credential. The names are those
  in force at the spawn; a runtime with a control channel takes only a
  version 2 file, so the names are fixed for its life.
- **Pinned.** A module's remotes join its manifest pin: a supervised
  restart uses the remotes the last operator action took, and a
  `package.json` rewritten since (under audit, by a route the file broker
  does not see) changes nothing until an operator's reload; each
  difference is logged as an error, saying each remote's name, origin and
  variable only (never a URL's user info, path or query, nor a header).
- **What a remote can reach.**
  - https only (http only to a loopback host under `--debug`, for tests);
  - a redirect followed only within the same origin (the exact scheme,
    host and port; at most 5, its Authorization kept), never to another
    origin, so a credential never goes to another origin;
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
  billed by the call's token, as every hop is since R2-1. A remote call
  aborted because its call was cancelled never answers, so it is not
  billed; see the next section.)

### Cancelling a call in flight

A client can cancel a call while it runs (MCP completeness section 13): on
HTTP a 2026-07-28 request's POST closing before its answer, on stdio and a
shared runtime's session `notifications/cancelled` by request id. A legacy
HTTP request's disconnect changes nothing.

- **Who can cancel what.** A cancel names a request of its own transport
  scope only: stdio's one connection, or one session. One session can never
  cancel another's call, even with the same id. An unknown id costs one map
  lookup and is ignored.
- **What stops** (with `--workerThread`, the default; in single-thread
  mode, which carries no call tokens, a cancel only suppresses the answer).
  The call's token is dropped at once, and with it every hop's under it. A new hop, device query, remote call or channel open is
  then refused `CALL_TOKEN_INVALID`, in whatever worker makes it. No worker
  is interrupted, and no answer is written. A remote call already running
  for the call is aborted: it rejects at once, and the remote server is
  sent `notifications/cancelled`.
- **A billed call runs only while its charge can be recorded.** A
  tools/call (not a completion's action), an invoke-action, a job's run and
  a hop each ask, before they run, whether their charge can be recorded; a
  ledger that can't record it -- Redis unreachable, or a charge it just
  failed; a local ledger whose write just failed -- refuses them retryably
  (`LEDGER_UNREACHABLE`, `LEDGER_UNWRITABLE`). A refused call is not counted
  by the per-key limiter. A charge that fails after its call ran is lost,
  logged by the key's fingerprint, the tool and the amount, and the ledger
  is marked: the next billed call is refused until a probe, at most one a
  second, finds it recording again.
- **The bill is what ran.** Each path captures its billing key when the
  work starts, never by resolving the token again when it bills:
  - a routed hop at its start;
  - a peer invoke in the broker's unbilled entry, taken at the match, which
    outlives the token;
  - a remote call at its token's resolve.

  So work already running when the call is cancelled is billed once, and a
  client can't cancel just before it ends to get it free. A hop or invoke
  not yet started is refused, so it never runs and isn't billed. A remote
  call aborted by the cancel never answers, so it isn't billed; the remote
  server's own quota is the user's, and the abort stops it being spent.
  The outer call is billed only if its handler returned a success, as
  always: a handler that ran to its end after the cancel is billed, and one
  stopped by a refused hop is not. Its usage record is written once, with
  outcome `cancelled`. The client's slot is freed at the cancel. A stdio
  server's exit at the end of its input, and a session's drain, wait for a
  cancelled call still running, up to the request timeout, so they never
  lose that bill; `SIGTERM` and `/shutdown` exit at once, and may lose
  the bill of a cancelled call still running then. A task-augmented call cancelled before its task's id
  was sent has its job removed if it hasn't started; one a worker has
  already started runs to its end and is billed, its result unread.

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
  the target `deviceID` (`USER_HAS_NO_DEVICE`; a REST device route answers
  it as it answers a device that isn't there or isn't listed, one
  `MODULE_NOT_LISTED` 404, so no caller can probe which modules exist), via
  one of three pluggable
  backends: `FileAuthProvider` (default, a JSON file), `SqliteAuthProvider`,
  or `CouchDBAuthProvider` (needs a real CouchDB instance, `nano` no
  longer a hard dependency). This is caller-identity authorization, not
  module sandboxing — it constrains which apiKey can invoke which device's
  actions, not what a loaded module's own code can do once its handler
  runs (that's the worker-thread boundary described above). Four things
  worth being explicit about, in the spirit of this document's own rule
  against overstating guarantees:
  - **Bodies are read before this check.** JSON and XML bodies are parsed
    on every route before any key is checked, so an unauthenticated client
    can still make the server read up to `--maxRequestBody` (8 MB) per
    request. A body that says it is BSON (`application/bson`) is answered
    415 on every route and never parsed or kept (`lib/route-manager.js`):
    BSON was retired in 8.0.0. A refused body is discarded as it arrives; a client that
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
  - **`FileAuthProvider`'s zero-config first run generates a
    wildcard-access demo key** if no `auth.json` exists yet, writes it
    owner-only and prints the file's path, never the key, specifically
    so a fresh checkout is immediately usable. This is meant for local
    development and evaluation, not left running in a real deployment —
    treat an auto-generated `demo-*` key the same as any other credential
    that shouldn't ship to production, and replace it (or configure a real
    `auth.json`/`COUNTINGHOUSE_API_KEY`) before exposing the server beyond
    localhost.
  - **An internal cross-worker call always has a billing identity.** A hop
    bills the identity of the call token it runs under, and no token is
    issued without one (`lib/call-tokens.js`), so no hop runs for free for
    want of one (see `docs/cross-cutting-matrix.md`'s two "Direct peer
    channel" rows). A remote call with none is refused
    (`HOP_IDENTITY_UNRESOLVED`).

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
# a stop's SIGTERM ends the runtime with status 143 (its exit work done): a clean stop
SuccessExitStatus=143
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
  is what makes the declared `net` permissions take effect. `CHUtil.request`
  then follows each redirect itself (`followRedirect: false`) and checks
  every hop, rather than relying on postman-request's redirect handling
  (see "Boundary checks run on intrinsics captured before module code
  loads").
- **Part 4: raw TCP/TLS relay.** `net` and `tls` through the main thread;
  UDP stays denied.

Beyond the programme, as before: a **hybrid mode** with an opt-in process- or
container-per-module mode for modules the operator wants stronger isolation
for, at the cost of density and cold-start, or a container or microVM shell
around the whole process. The sandbox does not replace either; it is the
in-process layer that remains useful under both.
