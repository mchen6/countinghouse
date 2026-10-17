# Module sandbox, part 1 — foundation

The first of four sub-projects that harden how countinghouse runs module code,
inside the architecture it already has. Opt-in enforcement, default audit, so
a minor release.

Verified against `fix/loadfile-without-rewire` at `22c19d2` on 2026-10-15,
which this design builds on (see [Prerequisites](#prerequisites)). Every claim
below names the file that backs it — re-check rather than believe, the tree
moves.

## The problem

`docs/security-model.md` is honest about it: modules run in
`worker_threads.Worker`s (`lib/module-manager.js`, `spawnModuleWorker`), which
separate JS heaps and nothing else. A module, or any npm package it depends
on, can read and write any file the server can, open any connection
(including to the server's own Redis), load native code, kill the whole
process, and allocate memory without limit. Measured on Node v24.21 from
inside a module's worker during the design discussion:

| From a module's worker | Today |
|---|---|
| Read the server's secrets from `/proc/self/environ` | readable |
| Open `/proc/self/mem` | openable |
| Raw TCP connect to Redis on localhost | connects |
| `process.binding('fs')` | works, bypassing anything layered on `fs` |
| `process.kill(process.pid, 'SIGKILL')` | kills the whole server |
| Allocate `Buffer`s past a heap cap | not limited (measured 108 MB under a 32 MB cap) |

## Constraints the design keeps

These were decided before the design and are not up for trade:

1. **One process, `worker_threads`, direct peer channels unchanged.** They are
   where countinghouse's performance comes from. No cordons, no per-module
   processes.
2. **Modules stay standard npm packages.** No new module format, no build
   step, no code changes required of authors for code that stays within its
   permissions.
3. **The main thread is the single point of contact** for files and network,
   the way `sendRedisCommandToParent` (`lib/redis-api.js`,
   `lib/worker-message.js`) already makes it the single point of contact for
   Redis.

## What this can and cannot promise

Stated once, here, and repeated in `docs/security-model.md`:

- **It is a strong barrier** against accidents, buggy or exploited
  dependencies, and ordinary malware: the module's code runs with no native
  code, no process control, no route to countinghouse's internals, bounded
  memory and bounded blocking, and — once parts 2 and 3 land — no file or
  network access except through the main thread.
- **It is not a hard boundary** against code written specifically to defeat
  it. Everything here is enforced in the same process as the code it
  restricts. One overlooked internal API, or one V8 bug, gets past the
  in-process layer; the `--hardened` backstop ([below](#5-the---hardened-launch-mode))
  limits what the whole process can then reach, but it applies to the main
  thread too, so it cannot separate a module from countinghouse's own data.

## The whole programme

| Part | Contents | Status |
|---|---|---|
| **1. Foundation** (this spec) | Permission declaration and operator policy; validator checks; worker lockdown; resource limits with restart and suspend; `--moduleSandbox off\|audit\|enforce`; `--hardened` | this spec |
| 2. File broker and virtual root | `fs`/`fs/promises` routed through the main thread; per-module virtual root (`/app`, `/data`, `/tmp`, declared mounts) with `__dirname` and `require` virtualized; out-of-root access answers `ENOENT` and is logged on the host; file quotas; explicit uninstall that deletes the module's private data unless told to keep it | later spec |
| 3. HTTP(S) broker | `fetch`, `http`, `https` through the main thread; DNS done by the broker; destination checked after resolution, private ranges and localhost denied unless approved; request quotas | later spec |
| 4. Raw TCP/TLS relay | `net`, `tls` through the main thread; UDP stays denied | later spec |

Decisions already made for parts 2–4, recorded so this spec's formats leave
room for them: outside paths are declared `r` or `rw` per path; modules must be
self-contained (their whole dependency tree inside their own directory); a
spike on Node v24.21 showed `module.registerHooks` can give module code
virtual `__dirname`, `__filename`, `require.resolve` and stack traces.

**Separately, not in this spec:** making `--workerThread` the default. The
sandbox needs worker mode; the default flip is its own change.

## Prerequisites

`fix/loadfile-without-rewire` (`22c19d2`), unmerged at the time of writing:

- A reload is a restart in a new worker (`ModuleManager.prototype.
  loadModuleByWorker`), so lockdown runs once per worker and is never undone
  by an in-place reload.
- `CHUtil.loadFile` is a plain `require()` (`lib/countinghouse-util.js`), so
  it goes through the loader hooks this spec adds. rewire read and compiled
  files itself and would have bypassed them, and its `__set__` used `eval`.
- A worker's late `exit` event no longer unloads a newer worker under the same
  name — the restart policy below depends on that.

---

## 1. Modes and where the sandbox applies

New flag **`--moduleSandbox off|audit|enforce`**, default **`audit`**.

| Mode | Behaviour |
|---|---|
| `off` | Today's behaviour: no lockdown, no limits, no policy. Logged once at startup as a warning. |
| `audit` | Every check runs; a violation is logged (module, rule, detail — e.g. `log-read require child_process`) and the operation goes ahead. |
| `enforce` | A violation is blocked. The blocked call throws the error type Node itself would throw (`ERR_ACCESS_DENIED`, `MODULE_NOT_FOUND`), and the host logs it. |

- **Resource limits ([section 4](#4-resource-limits-restart-and-suspend)) apply
  in `audit` too.** Logging a runaway allocation does not stop it.
- **Audit log lines are de-duplicated** per (module, rule, target), so a module
  that calls something a thousand times logs it once. A per-module violation
  counter is kept for the admin status view.
- **The sandbox needs worker mode.** `--workerThread` is off by default
  (`docs/cli-and-api-reference.md`). Without it:
  - the default `audit` downgrades to `off` with a startup warning, so
    existing single-thread setups keep starting;
  - an explicit `--moduleSandbox audit` or `enforce` is a startup error.
- **Not affected:** direct peer channels, the Redis path, `ctx.call` and
  billing. Part 1 adds no hop to any existing call path.

## 2. Permission declaration, operator policy, validator

### What a module declares

In `package.json`, beside the existing `countinghouse.calls`
(`lib/module-validator.js`, `callsProblems`):

```json
"countinghouse": {
  "calls": ["…"],
  "permissions": {
    "fs":     [ { "path": "/var/log/app", "access": "r" } ],
    "net":    [ { "host": "api.example.com", "ports": [443] } ],
    "env":    [ "WEATHER_API_KEY" ],
    "limits": { "heapMb": 128, "externalMb": 128, "maxBlockMs": 5000 }
  }
}
```

| Field | Rules |
|---|---|
| `fs` | Outside paths only. Absolute, normalized, no `..`. `access` is `r` or `rw`. `/app`, `/data`, `/tmp` and anything under them are reserved for part 2's virtual root and cannot be declared. |
| `net` | `host` is a hostname or `*.`-prefixed wildcard (one leading label only); `ports` optional, integers 1–65535. Covers HTTP(S) in part 3; a later `"protocols": ["tcp"]` opts into part 4's relay. IP literals are allowed only as exact hosts. |
| `env` | Environment variable names (`[A-Z_][A-Z0-9_]*`). |
| `limits` | What the module asks for; all optional. |

No `permissions` key means: nothing outside its own root, no env vars, default
limits.

**What part 1 enforces from this:** syntax (validator and load time), `env`,
`limits`, and the `net` check on `CHUtil.request` / `CHUtil.createSOAPClient`
(section 3, item 5). `fs` and the rest of `net` are parsed, validated, and
logged as effective permissions, and take effect when parts 2 and 3 ship.

### What the operator narrows

New flag **`--modulePolicy <file>`**, JSON keyed by package name:

```json
{
  "limits": { "heapMb": 256, "externalMb": 256, "maxBlockMs": 10000 },
  "modules": {
    "log-read": {
      "fs": [ { "path": "/var/log/app", "access": "r" } ]
    },
    "weather": {
      "approve": "as-declared",
      "env": { "WEATHER_API_KEY": "…" }
    }
  }
}
```

- **Narrowing only.** Effective permissions are the declaration intersected
  with the operator entry:
  - an operator `fs` entry must equal or sit inside a declared path, with the
    same or less access (`r` ≤ `rw`);
  - an operator `net` entry must name a declared host (or a host matched by a
    declared wildcard), with the same or fewer ports;
  - effective limits are the smaller of the module's request and the
    operator's ceiling (top-level `limits`, then the per-module entry);
  - an operator entry wider than the declaration is reported at startup and
    ignored — never granted.
- **`"approve": "as-declared"`** grants the declaration unchanged.
- **No entry for a module that declares outside access** (`fs` or `net`):
  `audit` grants the declaration; `enforce` grants only the module's own root
  until the operator adds an entry. A module that declares nothing outside
  needs no entry in either mode.
- **Env values.** A declared and approved name gets its value from the policy
  file's per-module `env` if set there, otherwise from the server's own
  environment, otherwise it is absent. Undeclared names are never passed.
- **Startup log:** one line per module with its effective permissions, so the
  operator has one place to see what every module may do.
- `--modulePolicy` is re-read on module restart, so an edit takes effect by
  restarting the module, not the server.

### Validator checks

In `countinghouse-validate` (`bin/countinghouse-validate.js`,
`lib/module-validator.js`), and repeated at load time:

1. **Permissions syntax**, by the rules above.
2. **Self-contained:** every dependency named in `dependencies`, followed
   through the whole tree, resolves to a directory inside the module's own
   directory.
3. **No native code:** no `.node` file, no `binding.gyp`, no
   `"gypfile": true` anywhere in the tree.
4. **Install scripts** (`preinstall`, `install`, `postinstall` in any
   `package.json` in the tree) are reported as a warning, not an error —
   groundwork for admission work later.

The validator advises; the load-time check decides. In `enforce` a module
failing 1–3 is refused with `MODULE_SANDBOX_REFUSED` and the reasons; in
`audit` the failures are logged and the module loads.

## 3. Worker lockdown

**When it runs.** `lib/sandbox.js` loads countinghouse's own worker code first,
as today; that code keeps its own references to the real `fs`, `net` and the
rest. A new `lib/module-lockdown.js` then runs once, on the `set-options`
message, before the first `load-module` message — no module code runs before
it.

**What it does:**

1. **No native code.** `process.dlopen` and the `.node` loader
   (`Module._extensions['.node']`) throw. `process.binding` and
   `process._linkedBinding` throw.
2. **Process controls.** `process.kill`, `process.abort`, `process.chdir`,
   `process.setuid`, `setgid`, `seteuid`, `setegid`, `setgroups`,
   `initgroups` throw. `process.umask` is already a stub (`lib/sandbox.js`).
   `process.exit` stays allowed: in a worker it ends only that module, which
   then goes through the crash path in section 4.
3. **The `require` boundary.** A `module.registerHooks` resolve hook allows
   Node built-ins (subject to item 4) and files inside the module's own
   directory. Everything else — `NODE_PATH` (which `bin/countinghouse` sets
   to countinghouse's `lib/`), global folders, other modules — gets
   `MODULE_NOT_FOUND`, logged on the host.
4. **Built-ins blocked or reduced.** Enforced as an allowlist written out from
   Node 24.21's built-ins less the blocked ones below, so a built-in a later
   Node adds is refused until reviewed (amended after review, 2026-10-17):

   | Module | Why | Treatment |
   |---|---|---|
   | `child_process`, `cluster` | new processes outside every check | blocked |
   | `worker_threads` | `parentPort` lets a module send raw broker messages as if it were countinghouse's worker code | blocked |
   | `inspector`, `wasi` | debugger access; a second runtime | blocked |
   | `v8` | `setFlagsFromString` can switch protections off | blocked |
   | `sqlite` | `loadExtension` loads native code | blocked |
   | `test`, `test/reporters` | `run()` starts child processes outside every check | blocked |
   | `sea` | no use in a module | blocked |
   | `crypto`, `tls` | OpenSSL engines (`setEngine`, `privateKeyEngine`, `clientCertEngine`) load native code | engine loading blocked |
   | `module` | `Module._load`, `_extensions`, `registerHooks` bypass the boundary | reduced: `builtinModules`, `isBuiltin`, and a `createRequire` that stays inside the boundary |

   `fs`, `net`, `http` and the like stay usable until parts 2 and 3. The first
   `require` of each by each module is logged in both modes, so the operator
   learns which modules will need `fs`/`net` permissions before those parts
   ship.
5. **CHUtil's own routes out.** `CHUtil` is a global in every worker
   (`lib/sandbox.js`), and three of its members would bypass the lockdown:
   - `CHUtil.loadFile(path)` — same check as `require`: the module's own tree
     only.
   - `CHUtil.request` (postman-request) and `CHUtil.createSOAPClient` — the
     target URL's hostname and port are checked against the module's
     effective `net` permissions. Part 3 adds the check after DNS resolution.
6. **Clean environment.** The worker is created with `env` holding only the
   approved names (section 2). `process.env` in the worker is that object.
7. **Freeze.** Each override is defined non-writable and non-configurable;
   the reduced built-ins are frozen. Module code cannot put the originals
   back.

**Audit vs enforce.** In `audit` each override logs and calls through. In
`enforce` it throws.

**Known gap, accepted.** A module that obtains an object countinghouse loaded
before lockdown can reach the originals through it. The `CHUtil` surface is
therefore part of the review checklist for every change to
`lib/countinghouse-util.js`, and `docs/security-model.md` says so.

## 4. Resource limits, restart and suspend

### Limits that end the worker

| Limit | Mechanism | Default ceiling |
|---|---|---|
| `heapMb` — JS heap | `resourceLimits.maxOldGenerationSizeMb` on the Worker; V8 ends the worker itself | 256 |
| `externalMb` — `Buffer`s, typed arrays | main thread polls `worker.getHeapStatistics()` every second and terminates a worker whose `external_memory` exceeds the limit (verified available on Node v24.21) | 256 |
| `maxBlockMs` — blocked event loop | main thread pings each worker every second; no reply for `maxBlockMs` means the worker is stuck in synchronous code, and it is terminated (`terminate()` works mid-loop) | 10000 |

The existing per-call timeout (`DEVICE_NOT_RESPONDING`, `--requestTimeout`)
is unchanged: it answers a slow caller and kills nothing.

### Limit that rejects without killing

**Worker → main message rate:** a token bucket per worker, default 2000
messages/second, `--moduleMessageRate <n>`. Excess messages are answered in
the worker with `RATE_LIMITED`. Redis commands travel this channel, so a
high-throughput module may need more.

### After any unexpected worker exit

Limit kills and crashes (uncaught exception, `process.exit()`, a worker
`error` event) follow one policy:

1. **Calls in flight** to the module fail at once with `MODULE_RESTARTING`
   and the reason (`heap limit`, `external memory limit`, `blocked event
   loop`, `crash: <message>`), instead of waiting for the call timeout.
2. **Restart with backoff:** 1 s, 2 s, 4 s, doubling, capped at 60 s. During
   the wait, calls get `MODULE_RESTARTING` with the time of the next attempt.
   Tools stay in `tools/list`: countinghouse sends no `tools/list_changed`
   notification, and a tool that appears and vanishes confuses clients more
   than one that answers with a clear code.
3. **Suspend after 3 exits in 10 minutes.** Tools stay listed; calls get
   `MODULE_SUSPENDED` with the last reason. The host logs an error with the
   module, its exit history and the reasons. An operator `POST
   /restart-module` or a load clears the suspension and the counter.
4. **The counter resets** after 10 minutes without an exit.

Deliberate exits do not count: an operator unload, restart or reload, and a
server shutdown.

**Behaviour change:** today a crashed module is unloaded and stays down
(`spawnModuleWorker`'s `exit` handler). Under `audit` and `enforce` it now
restarts. `off` keeps today's behaviour.

### Status

The main thread keeps one record per module: `running | restarting |
suspended`, the last reason, the exit history in the current window, the next
restart time, and the audit violation counter. It is added to the existing
admin route `GET /get-module-device-list` (`lib/routes/
get-module-device-list.js`) under a `sandbox` key.

## 5. The `--hardened` launch mode

Node's permission model (`--permission`) blocked `/proc/self/mem` and
`/proc/self/environ` in the design-time test. It must be given when Node
starts, so **`--hardened`** makes the entry point (`framework.js`) re-launch
itself under it:

- If `--hardened` is set and `process.permission` is absent, `framework.js`
  computes the flags below, spawns `process.execPath` with them and the same
  arguments, forwards signals and stdio, and exits with the child's code.
  Under the permission model, `process.permission` is present and startup
  continues normally.
- **Read:** countinghouse's install directory; `--modulePath` (default
  `~/countinghouse_modules`, `lib/cli-options.js`); `--authConfigPath`;
  `--deviceConfigPath`; `--modulePolicy`.
- **Write:** the `--modulePath` directory (it holds
  `countinghouse-modules.db`, `lib/device-db.js`) and the directory of the
  SQLite auth file when `--authProvider sqlite`.
- **`--allow-worker`** always (modules run in Workers; Node warns that it
  weakens the model, and the docs say why it is needed). **`--allow-addons`**
  only with `--authProvider sqlite` (the `sqlite3` addon), and the docs note
  that native code in the main thread is outside the permission model.
  **`--allow-child-process`** only with `--authoringTools`
  (`countinghouse_validate_module` runs the module in a child process,
  `lib/mcp/gateway.js`).
- **Every module must live under `--modulePath`.** A `--loadModule` path or a
  `load_module` / `/load-module` path outside it is refused with
  `MODULE_PATH_OUTSIDE_ROOT`. This also stops loading code from arbitrary
  paths at run time.
- `--hardened` requires worker mode, like the sandbox.
- Node 24 has no network permission, so outbound network is left to the OS:
  the docs ship a **systemd unit example** — `ProtectSystem=strict`,
  `ReadWritePaths` for the write paths above, `NoNewPrivileges`,
  `PrivateTmp`, `MemoryMax`, and `IPAddressAllow` limited to Redis, CouchDB
  and operator-approved hosts.

## Error codes

New entries in `lib/error-info.en-US.json` and `lib/error-info.zh-CN.json`,
each head text saying what to do on its own (the worker hop keeps only the
code, `lib/handler-ctx.js`):

| Code | Meaning |
|---|---|
| `MODULE_SANDBOX_REFUSED` | the module failed a load-time check in `enforce` (permissions syntax, not self-contained, native code) |
| `MODULE_RESTARTING` | the module's worker exited and is restarting; retry after the given time |
| `MODULE_SUSPENDED` | the module exceeded the restart limit; an operator must restart it |
| `RATE_LIMITED` | (worker-side) too many messages to the main thread |
| `MODULE_PATH_OUTSIDE_ROOT` | `--hardened`: the module path is not under `--modulePath` |

## New CLI flags

| Flag | Default | Section |
|---|---|---|
| `--moduleSandbox off\|audit\|enforce` | `audit` (`off` without `--workerThread`) | 1 |
| `--modulePolicy <file>` | none | 2 |
| `--moduleMessageRate <n>` | 2000 | 4 |
| `--hardened` | off | 5 |

## Docs

- `docs/security-model.md` — rewritten around this design: the layers, what
  each stops, the "strong barrier, not a hard boundary" statement, the
  accepted gaps.
- `docs/module-development.md` — declaring permissions, the self-contained
  rule, no native addons, env vars, limits, what `MODULE_RESTARTING` and
  `MODULE_SUSPENDED` mean.
- `docs/cli-and-api-reference.md` — the new flags and the `sandbox` status
  key.
- `CHANGELOG.md` — including the crash-restart behaviour change.

## Testing

| Area | What the tests prove |
|---|---|
| Lockdown | Each blocked route in `enforce` fails with Node's own error type and a host log line; in `audit` it works and logs once. Routes: `process.dlopen`, `process.binding`, `process.kill`, `child_process`, `worker_threads`, `v8`, `module` internals, a `NODE_PATH` require of a countinghouse internal, `CHUtil.loadFile` outside the module, `CHUtil.request` to an undeclared host. |
| Validator | Permission syntax cases; a dependency outside the tree; a `.node` file; an install-script warning. |
| Policy | Narrowing; a wider operator entry ignored and reported; `enforce` without an entry; `audit` granting the declaration; `approve: as-declared`; the startup effective-permissions line; policy re-read on restart. |
| Env | Only declared, approved names are visible; policy value beats server env. |
| Limits | Heap, external memory, blocked loop, message rate; in-flight calls get `MODULE_RESTARTING`; backoff timing; suspend on the third exit; counter reset; a crash takes the same path; operator restart clears a suspension; deliberate exits do not count; the `sandbox` status key. |
| `--hardened` | Starts under the permission model; a module cannot read `/proc/self/environ` or `/proc/self/mem`; a module path outside `--modulePath` is refused; authoring tools and SQLite auth still work with their flags. |
| `off` | Startup warning; no check runs; crash behaviour as today. |
| No regressions | The existing suite runs under the default `audit`; the direct-peer-channel tests and the `test6`/`test7` benchmarks show no slowdown. |

Ports: the next free range above the suite's current maximum (`9602`–`9604`
are taken by `test/module-loading/12-reload-fresh-code.js`).

## Out of scope

- Brokering `fs` and network (parts 2–4), module data directories and
  uninstall (part 2).
- Making `--workerThread` the default (separate change).
- Install-time admission: digest pinning, provenance, AI review (an earlier,
  separate discussion).
- Module configuration from a store an operator can edit at run time, as
  CEAMS did with CouchDB (`lib/device-config.js` now reads files). To be
  revisited after this part, so env values and `DeviceConfig` end up as one
  configuration story.
