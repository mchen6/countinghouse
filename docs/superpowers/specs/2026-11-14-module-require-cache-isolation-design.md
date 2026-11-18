# Module code and runtime-privileged `require()` (#194)

Status: a design for the boundary review. Author: implementer C, 2026-11-14,
against master 7625973c. No code yet.

## The problem, as master has it

The lockdown's resolve hook (`lib/module-lockdown.js`, `fromModule`) treats
a require as module code when its parent's file is inside the module root,
and as the runtime's otherwise. The runtime's requires are unrestricted.
Every way module code can reach a runtime `Module` object therefore gives it
a runtime-privileged `require`:

- **`require.cache`.** It is `Module._cache`, the whole cache. Calling
  `require.cache['…/lib/x.js'].require(…)` loads anything the runtime could,
  and `.exports` hands over runtime objects without loading anything.
- **`module.parent`.** A handler file is required by the runtime's
  dispatcher, so the handler's `module.parent` is a runtime `Module`. The
  issue doesn't list this route, and it needs no cache at all.
- **`module.constructor`.** Every module file's own `module` is an instance
  of the real `Module`, so `module.constructor._load(id, runtimeModule)`,
  `._cache` and `.createRequire(runtimePath)` are all reachable. So is
  `require.main`. Refusing the `module` built-in alone closes none of this.
- **The `module` built-in.** Under `enforce` it is a reduced stand-in
  (`builtinModules`, `isBuiltin`, a `createRequire` held inside the root).
  Under `audit` the real one is served.

Built-ins blocked for every caller (`child_process`, `worker_threads`) stay
refused whatever the parent. Under `off` nothing is guaranteed, as for
everything else.

## Options

**A. A filtered, read-only `require.cache` for module files.** Module code
sees only cache entries inside its own root; writes throw. Implemented by
locking `Module.prototype._compile`: for a file inside the root, a
one-line prelude (no newline, so line numbers stay) sets
`require.cache` to the view on that file's own `require` function.

- **Closes:** the cache route, both a runtime `require` and runtime
  `.exports`.
- **Breaks:** packages that delete cache entries to reload
  (`clear-module`, `decache`, `import-fresh`, and test mocks such as
  `proxyquire` and `mock-require`). A module clearing its own files can be
  allowed: deleting an entry inside the root.
- **Cost:** a Proxy hop only when module code reads the cache; a column
  shift on line 1 in stack traces.
- **Holds under:** `audit` and `enforce`. No legitimate module needs the
  runtime's entries, so `audit` can hide them as well.

**B. Refuse `module` internals to module code.** Serve the reduced `module`
under `audit` as well as `enforce`, and give each module file a `module`
whose `constructor` is that reduced stand-in (an own property set by A's
prelude). Its `require.main` and `module.parent` become `undefined`.

- **Closes:** `_load`, `_cache`, `createRequire` outside the root, and the
  `parent`/`main` routes.
- **Breaks:** packages that patch the loader: `source-map-support`,
  `pirates`, `module-alias`, `ts-node`, `esm`, `require-in-the-middle`
  (`Module._extensions`, `_resolveFilename`, `_load`). Code reading
  `module.parent` for the "am I the main module" idiom must not get
  `undefined`, which `if (!module.parent)` reads as "main" (Fable's
  re-probe of #406 found dependencies running their stand-alone branch):
  #406 gives a required file a data-only stand-in instead. `createRequire`
  inside the root keeps working.
- **Cost:** none at run time.
- **Holds under:** both modes, but under `audit` it is a behaviour change,
  not a log. It should land with a CHANGELOG line and a log of each refused
  internal (a Proxy on the stand-in).

**C. Cut the module graph.** Clear `children` on runtime `Module` objects,
and set `module.parent` to `undefined` for module files (A's prelude).

- **Closes:** the graph route; it adds to B, it doesn't replace it.
- **Breaks:** nothing a module relies on: `children` is informational, and
  `parent` has been deprecated since Node 14.
- **Cost:** negligible.
- **Holds under:** both modes.

**D. Privilege by capability, not by parent (the root fix).** After the
lockdown, the resolve hook no longer trusts `parentURL` for privilege:
every require is module code unless the runtime's own late loader asks.
That loader is `lib/lazy-require.js`, which sets a closure flag
synchronously around its call; the flag is never on any object module code
can reach.

- **Closes:** every route at once (cache, parent, `constructor._load`,
  `createRequire`, a future one nobody has found), because none of them
  carries the flag. A leaked runtime `Module` gives no privilege.
- **Breaks:** runtime code that requires inline after the lockdown
  (`require('./hop-input')` inside a worker-side function and the like).
  Each one moves to `lazy-require`, or is loaded before the lockdown. A run
  under `enforce` names any that are missed, so the suite finds them.
  Nothing breaks for modules. One on the list: `lib/handler-ctx.js`'s
  remote path requires `./chutil-facade` and `./remote` at call time. Even
  a cached require goes through Node's resolve, which builds a `URL`, so
  module code that breaks `URL` in its realm (a getter on
  `Object.prototype`) makes `ctx.call('remote:…')` throw. That fails
  closed (no call goes out), but the load belongs before the lockdown.
  The intrinsics hardening (part 3, round 2) loads the worker's call path
  at boot (call limits, hop input, peer channels, the service client, the
  device query, countinghouse-util attached then). What still loads on
  first use in a worker, and so takes whatever module code put in
  `require.cache`: `lazy-require`'s libraries (postman-request for the
  module's own `CHUtil.request`), the logger (its lines), `settings-tool`
  on live options (the worker's own copy of the options), `redis-api` (handed
  only its own Redis send) and `module-validator` (a validation worker,
  discarded after). None carries a call's token; each goes on this list.
- **Cost:** a one-time review of worker-side inline requires, about a few
  dozen. No cost per call.
- **Holds under:** `enforce` refuses, as the require boundary does today;
  `audit` logs "would be refused" and allows, as for every other require
  rule.
- **Doesn't close:** read access to runtime `.exports` already loaded.
  Those objects are reachable without any `require`, so D needs A and C
  beside it.

**E. The network broker (sandbox parts 3–4).** It makes the
postman-request route moot for the network: a request from any library
goes through the broker. It does nothing for runtime internals (`dm`,
`ci`, `workerMessage`) or for allowed built-ins as "runtime".

**Residuals found here.** Only 7 of `lib/`'s 87 files are strict mode.
From a handler a sloppy runtime function called, `handler.caller` and
V8's CallSite API (`Error.prepareStackTrace`, `getFunction()`) can hand
module code runtime function objects. Making the worker-side runtime
files `'use strict'` closes that, and is cheap; it belongs with D.

## Recommendation

**D plus A and C, then B.**
- D removes the privilege itself, whatever route a runtime object leaks
  through.
- A and C remove the reachable runtime objects (`.exports`, `parent`).
- B removes the last handle on the real `Module` class.
- Strict mode for the worker-side runtime files goes with D.

Order of landing:
1. D with strict mode. It has no module-facing change, and the suite under
   `enforce` finds the runtime's late requires.
2. A and C. Their only module-facing change is the hidden runtime entries,
   in both modes.
3. B. It is the one with real npm breakage, so it lands with a CHANGELOG
   entry and audit logging of refused internals, after a check of the
   packs' dependency trees.

## Tests that would prove it

Probes, as the reviewer's were: a fixture module running each route, under
`enforce` and under `audit`.

- `Object.keys(require.cache)` holds only files under `/app`; a write and a
  delete of a runtime entry throw. **(A)**
- `module.parent`, `require.main` and `module.constructor._load` are
  `undefined` or the stand-in. `module.constructor.createRequire('/…/lib/x.js')`
  is refused under `enforce` and logged under `audit`. **(B, C)**
- **(D)** With a runtime `Module` handed to the module on purpose, through
  a test-only global in a fixture build:
  - its `.require('postman-request')` and `.require('../lib/peer-worker')`
    are refused under `enforce` and logged under `audit`;
  - `lazy-require`'s first load of postman-request under `enforce` still
    works (test/sandbox/40's case);
  - the whole suite passes under `--moduleSandbox enforce` (D's
    regression net).
- `handler.caller` from a handler is `null` (strict mode), and no CallSite
  `getFunction()` returns a runtime function.
- A compatibility table, run in CI under `audit` and `enforce`:
  `resolve-from`, `import-fresh`, `source-map-support`, `module-alias` and
  `require-in-the-middle`, each loaded by a fixture module, with the
  expected outcome per option, so B's breakage is documented, not
  discovered.
- Under `off`, the probes show the old behaviour, unchanged and
  documented.

## Revision 2: the build plan (implementer B, 2026-11-17)

Status: for the reviewer's high review before any code. The maintainer (11-15): fix
before release 1. Part (3) of the register row, sloppy-mode `fn.caller`, is
done: strict mode across `lib/`, #322. This revision settles (1) and (2):
which of A–D to build, and how.

### Checked on Node 24.21 (a probe, kept in the PR's test)

- `require()` and `Module.prototype.require` both go through the current
  value of `Module._load` (`wrapModuleLoad`). So one wrapper sees every
  CommonJS load with its parent object. The resolve hook sees only
  `parentURL`.
- A required file's `module.parent` is its requirer, `module.constructor`
  is the real `Module`, `require.cache === Module._cache`, and `require.main`
  and `process.mainModule` name the process's main file (in a worker, the
  runtime's).
- A forged `new module.constructor('<a runtime path>')`, given `filename`
  and `paths`, can `require`. So does `Module._load(x, {filename: '<a
  runtime path>'})`. Any check that reads a parent's path is spoofable, as
  the issue says.

### Why D, and not a check of the parent

Between the 11-16 ruling and this note I weighed a variant of D: "a
runtime caller is a parent in a private WeakSet of genuine runtime Module
objects", in place of C's closure flag. It is not spoofable by a forged
parent, but **a genuine runtime Module that leaks by a route nobody has
found still carries the privilege**. C's D gives a leaked runtime Module
nothing. **So I recommend D as C wrote it, which supersedes the "genuine
Modules" idea recorded in principle on 11-16.** A and C (hide what can
leak) and S below (lock the loader's statics) stay as defence in depth,
not as the boundary.

### What gets built

1. **D: privilege by capability.** `lib/runtime-require.js` takes its own
   `require` before the lockdown and exports `runtimeRequire(specifier)`.
   That sets a closure flag (a depth counter), synchronously, around the
   call. After the lockdown the resolve hook treats a require as the
   runtime's **only** while the counter is above zero. The hook's
   `fromModule(parentURL)` path check stays as a second condition: a flagged
   require whose parent is inside the module's root is still module code.
   `lib/lazy-require.js` uses it.
   - The worker-side runtime's inline requires after the lockdown move to
     it. There are about 50 in `lean-worker`, `lean-dispatcher`,
     `handler-ctx`, `countinghouse-util`, `peer-worker`, `worker-message`,
     the logger, `call-limits`, `hop-input` and the broker. A run of the
     suite under `--moduleSandbox enforce` names any that are missed (the
     regression net). Requires made before the lockdown are unaffected.
   - Under audit: a require that would be refused is logged and allowed,
     as for every other require rule.
2. **A: a filtered, read-only `require.cache` for module files.** Built as
   C describes, by `Module.prototype._compile` (locked) giving each file
   under the root a `require.cache` view of the entries under the root.
   Deleting an entry inside the root is allowed (`import-fresh` on a
   module's own files); writing or deleting a runtime entry throws, and is
   logged under audit. Both modes.
3. **C: the graph.** A handler file's `module.parent` is `undefined`, set
   by A's prelude. `require.main` and `process.mainModule` are `undefined`
   in the worker after the lockdown. A runtime Module's `children` is
   emptied at the lockdown. Both modes.
4. **S (narrower than C's B): the loader's statics locked, not the
   `module` built-in replaced.** Non-writable and non-configurable after
   the lockdown:
   - on `Module`: `_load`, `_resolveFilename`, `_cache`, `_extensions`
     (frozen), `_pathCache`, `wrap`, `wrapper`, `_findPath`,
     `_nodeModulePaths`, `_initPaths`;
   - on `Module.prototype`: `require`, `load`, `_compile`.

   This stops module code from hooking the runtime's own later loads. With
   D in place, reading `Module._load` gives nothing, so the reduced built-in
   stays enforce-only, as today.

### For your ruling: S under audit

Today, under audit, `Module._resolveFilename` is left writable on purpose
("so a dependency that patches it works alike"). S locks it in both modes,
so a dependency that patches the loader (`module-alias`, `pirates`,
`source-map-support`'s hook, `require-in-the-middle`) stops working under
audit as well as enforce.
- (a) Lock it in both modes. Such a module runs under `off`, and its
  docs say so. A dependency patching `_extensions['.js']` could otherwise
  run on the runtime's own later loads under audit. **I recommend (a).**
- (b) Lock it only under enforce. D still holds under audit, because a
  patched loader cannot set the flag. The cost is that audit lets a module
  rewrite what the runtime's own later loads resolve to.

C's compatibility table goes in with S, run in CI under audit and enforce,
so the breakage is documented, not discovered. It also gets a row for
`EventTarget`, `NodeEventTarget` and `MessagePort` (their prototypes fixed
at the lockdown by the intrinsics hardening, part 3): a module cannot
replace their methods, and an instance assignment such as
`target.addEventListener = fn` throws in strict code; accessors
(`port.onmessage = fn`), subclasses and `Object.defineProperty` on an
instance still work. And a row for `BroadcastChannel`: the global lets
module code in two workers talk to each other past the envelope, unmetered
(the reviewer's PR-c review). Proposed: refused to module code under
`enforce` (the global removed or locked before module code), reported
under `audit`.

### Tests (each fails on master first; a fixture module per route, under audit and enforce)

1. D: with a runtime Module handed over on purpose (a test-only global in a
   fixture build), its `.require('postman-request')` and
   `.require('<lib>/peer-worker')` are refused (enforce) or logged (audit).
   The same holds for a forged `new module.constructor('<runtime path>')`
   and for `Module._load(x, {filename: '<runtime path>'})`.
2. A: `Object.keys(require.cache)` lists only files under `/app`; a write
   to or a delete of a runtime entry throws.
3. C: `module.parent`, `require.main` and `process.mainModule` are
   `undefined`.
4. S: assigning `Module._load`, `_extensions['.js']` or
   `prototype.require` throws, and the loader is unchanged afterwards.
5. The runtime still works under enforce:
   - sandbox 40 (lazy libraries) and 43 (the lean worker's file list);
   - composition 02 (hops), peer channels, ctx.ask, settings live-options;
   - a module that requires its own dependencies and relative files;
   - a dependency that compiles a string with `new Module()`.
6. A runtime singleton is loaded once: its identity holds across a lazy
   load after the lockdown.

### Estimate

About 4 days:
- D with the inline-require move and the enforce suite run: 1.5 d;
- A and C: 1 d;
- S and its compatibility table: 0.5 d;
- tests in both modes, the Windows legs and a cold-load perf check: 1 d.

Then the PRs, in C's landing order: D first (no change a module can see),
then A+C, then S.

## Revision 3: P, on master with the worker hardening (implementer C, 2026-11-17)

Status: for the reviewer's deep review before code. P was approved on
11-16 and supersedes Revision 2's D (kept above as history). This revision
restates P against master 2873195d, which now has the worker hardening
(PR-c, #370), the lean worker started by its real path (#384) and
per-session dispatch (#367). It also gives the measured list of what the
runtime still loads after the lockdown.

### P in one paragraph

After a worker's lockdown, Node's shared CommonJS loader serves module
code only. The resolve hooks treat every request as the module's. There is
no "the runtime is asking now" state: module code can run inside any
runtime code (a getter, a replaced builtin), so an ambient flag would be
its as well, which is why D's closure flag was dropped. `Module._cache`, as
module code sees it (`require.cache`, `module.constructor._cache`), holds
only files under the module's root. The runtime's own loads after the
lockdown go through `lib/runtime-require.js` `load(callerModule, spec)`,
which:
- resolves with `Module._resolveFilename` as taken before the lockdown, so
  no hook runs;
- returns a file loaded before the lockdown from the real cache, as frozen
  in content then, so a runtime singleton stays one;
- loads anything else into a private `Map`, with `_extensions` and
  `_compile` as taken before the lockdown;
- serves only a genuine caller: a runtime `Module` that was in the real
  cache when the lockdown took it, or one this loader made (a `WeakSet`).

A file it loads gets its own `require`, which comes back to `load`. It
never loads a file under the module's root.

So a runtime `Module` that module code reaches (through `require.cache`,
`module.parent`, `children`, a stack) gives nothing. Its `.require` is the
shared loader's, which serves module code; its `load` capability needs a
genuine caller module, and only the runtime holds those. This is (1).
`module.constructor` statics (`_load`, `_resolveFilename`, `_cache`,
`_extensions`, `wrap`, `_findPath`, `prototype.require`/`load`/`_compile`)
are locked non-writable in audit and enforce alike (S, ruling (a)), and
`_cache` is the filtered view (A). Reading them gives module code the
shared loader, which serves it as module code. This is (2).

### What the runtime still loads after the lockdown (measured)

Traced on 2873195d by recording every `Module._load` in a `Worker`, path
by path. Note: the lockdown installs on `set-options`, before
`load-module`, so all of a module's load runs after it. Sixteen entry
sites:

| site | what | when | P's handling |
|---|---|---|---|
| logger (lean-worker 55/57/58; handler-answer 13; countinghouse-error 423; lazy-require from peer-worker 13 and countinghouse-util 34, **every first `recordUsage`**) | `./logger` → bunyan (~32 files, optional requires in try/catch) + `worker-logger` | first log line | **private loader** (bunyan stays off the lean boot: sandbox 43's "no logger"), or a bunyan-free worker logger (worker-logger only builds a record to `sendLog`). **For your ruling.** |
| chutil-facade 74 (lazy-require) | `postman-request` (242 files) | first `CHUtil.request` / `invokeAction` | **private loader**, its built-ins through it as allowed |
| lean-worker 355 | `./module-validator` (~190 files, ajv) | `validate-module` (that worker is discarded) | **private loader**, or preloaded at boot only in a validation worker (a `workerData` flag) |
| lean-worker 185 | `./redis-api` | first `CHUtil.redis` | to boot, after dropping its unused `LOG`/`stringHash` and the one lodash call |
| lean-worker 294 | `./settings-tool` (its whole closure) | `live-options` | to boot: `applyLiveOptions` moves to a small file of its own (it needs nothing else) |
| countinghouse-util 58 | `./bind-address` | first `getHostIp()` | to boot (one file; add it to sandbox 43's list) |
| countinghouse-util 88 | `./single-thread-facade` | first `loadFile` | not loaded in a worker at all (never active there) |
| countinghouse-util 87/90; handler-map 79; logger 10 | re-requires of files already loaded | each call | hoisted to top-level constants |
| fs-broker/patch 627/628/855/109 | `readline`, `stream`, `util`, `url` | a module's `readLines`, `readableWebStream`, `loadEnvFile`; Windows virtual drive | taken at patch install |

Not reached, kept on the list: call-limits 69 (it needs `outputCeiling`
undefined, which `getOptionsForWorker` never sends) and peer-worker 335
(short-circuited). Everything else in the lib is main-thread only.

So **three** families need the private loader (the logger unless replaced,
postman-request, the validator); the rest move to boot or stop
re-requiring.

### The net that finds what this list missed

Guard (a) from the 11-16 approval: after the lockdown, a runtime file
reaching the shared loader (an unconverted `require`) is refused by it as
module code, and reported once by a distinctive line naming the file. A CI
check runs sandbox, module-loading and mcp-contract under audit and fails
on that line. With P, a miss is a refusal (fail closed), never a silent
privilege.

### How the new pieces meet the hardening already merged

- **PR-c's `fixOwn`** fixes the runtime files' exports and prototypes at
  boot. `runtime-require.js` is required before the lockdown and fixed the
  same way; its `_resolveFilename`, `_extensions` and `_compile` are taken
  at its load.
- **#384:** the lean worker starts by its real path, so the real cache's
  keys for runtime files have one spelling. The genuine set is seeded from
  those, and `load` resolves to the same spelling.
- **#367's main-routed peer state** lives in the registered peer maps,
  untouched by this.
- **The fs broker** grants code roots by real path; the private loader
  reads runtime files through the original `fs` (the broker's own route,
  as the runtime's boot loads do now).

### Checks carried from the approval (11-16)

1. Capture the `.js`/`.json`/`.node` handlers and `_compile` at the
   lockdown (done in the WIP).
2. Third-party late deps that touch the loader: postman-request loads
   nothing while it runs (traced), and bunyan's optional requires are in
   try/catch (dtrace-provider's binding probes fail and are caught). The
   validator path loads json-schema-ref-parser, js-yaml and ajv at its
   load only.
3. Refusals by the shared loader name the request, never a runtime path
   (no user name in a path reaches a module).
4. Module reload and worker replacement re-establish all of it; the window
   tests run again after a reload.
5. Residuals in security-model.md.

### Tests (each fails on master first, under audit and enforce)

1. (1): a runtime `Module` from `require.cache` (and through
   `module.parent`, `children` and a forged `new module.constructor`): its
   `.require('postman-request')`, `.require('<lib>/peer-worker')` and
   `Module._load(x, {filename: '<runtime path>'})` are refused (enforce) or
   logged (audit).
2. (2): `Module._load`, `_extensions['.js']` and `prototype.require` cannot
   be replaced, and the loader is unchanged afterwards;
   `module.constructor._cache` lists only `/app` files.
3. The window tests: an `Object.prototype` getter, `Error.prepareStackTrace`,
   a thenable / `Symbol.toPrimitive` / `toJSON`, a forged parent with
   `Module.prototype` in its chain, each in place while the runtime's late
   loads run (a log line, the first request, redis, live options): never a
   privileged load.
4. Each of the 16 sites still works under enforce, after the lockdown: a
   first log, first request, first redis, live options, getHostIp,
   loadFile, readLines, validate-module, with sandbox 43's lists updated
   for what moves to boot.
5. A runtime singleton is one after a lazy load (identity across the
   private loader).
6. Interop under audit and enforce: `import()` of the module's own CJS,
   `require(esm)` of its own `.mjs`, `createRequire(__filename)`,
   `require.resolve` paths, JSON.

### Residuals (to security-model.md)

- Under `off`: unchanged, no guarantee.
- Single-thread mode: unchanged (no lockdown; the runtime and the module
  share one loader by design).
- A loader-patching dependency (module-alias, pirates, source-map-support's
  hook, require-in-the-middle) needs `off`, since S locks the statics in
  both audit and enforce; documented with the compatibility table.

### The worker-sandbox pass's findings in this scope (F4-1, F4-7, F4-8)

**F4-1 (HIGH, a release blocker): the load hook reads any host file.**
`lib/fs-broker/identity.js`'s `load` hook, for a `file:` URL that isn't
virtual, takes `grant.reading(p)` for whatever `p` is and calls
`nextLoad`, so Node's read goes to the original `fs`, past the broker.
The bound exists only in `resolve`. Two routes reach it:
- (a) `require.extensions['.js']({_compile(src) {...}}, '/any/host/file')`,
  or `.json`: Node's handler runs the load hooks with that path. The
  lockdown fixes only the `.node` handler.
- (b) The resolve hook calls `createRequire(hostParent).resolve(s)`. Node
  sets `require.resolve = resolve` by assignment, so an accessor that
  module code puts on `Function.prototype.resolve` swallows the assignment
  and answers the read: the module chooses `hostResolved`. `bound()` is
  lexical, so `<moduleRoot>/x/../../../etc/f.json` passes it, and
  `pathToFileHref` then normalises it.

The fix, independent of P and first in the PR order (below):
1. **`load` grants only what the runtime may read for itself:** a file
   under countinghouse's code roots, an entry in `lasting` (a CommonJS
   file reached by `import`, already granted in `resolve`), or a
   `.node` file under the module's root. Anything else gets no grant, so
   Node's read reaches the broker with the module's own rights (refused
   under enforce outside its grants, reported under audit).
2. **`resolve` stops reading `.resolve` from a function module code can
   reach through a prototype:** it calls `Module._resolveFilename` as
   captured before the lockdown, with a parent made from `hostParent`.
   Only a string result is taken. `bound()` checks `path.resolve(host)`,
   never the lexical form, and so does `packageType()`.
3. **Under P:** module files' `require.extensions` is the same object as
   `Module._extensions`, locked with the statics (S), and the `.js`/`.json`
   handlers then run through the bounded load hook, so calling them
   reads nothing the module's own `fs` couldn't.

**F4-7 (low): `vm` code caches.** `vm.Script` and `compileFunction`
accept `cachedData`, and V8 doesn't verify a code cache against its
source. Under enforce the lockdown's `vm` for module code drops
`cachedData` and `produceCachedData` (a module compiles from source;
nothing is lost but speed).

**F4-8 (low): host paths sent to every worker.** `getOptionsForWorker`
(cli-options.js) sends `modulePath`, `moduleDataPath`, `authConfigPath`,
`remoteCredentials` and `sessionDir`, and module code reads them through
the `cli-options` export. A worker gets only the fields it reads, listed
in one place, and a test fails when a host path appears in a worker's
options.

**Tests, red first on master, enforce and audit:**
- F4-1 (a): a module calls `require.extensions['.js']` (and `.json`) with a
  fake module whose `_compile` keeps the source, on a host file outside its
  grants: no source (enforce: refused; audit: reported).
- F4-1 (b): a module puts a `resolve` accessor on `Function.prototype`, then
  requires something, so the resolve hook gets the module's chosen
  `<moduleRoot>/x/../../../<host file>`: refused, and the accessor never
  decides a resolution.
- F4-1: `<moduleRoot>/x/../../../<host file>` is refused by `bound()` as
  resolved, not as written.
- F4-7: a module's `vm.Script` given `cachedData` runs from its source;
  `cachedDataRejected` is reported.
- F4-8: a worker's options hold no host path of the operator's.

(F4-5 and F4-6, the fs patch's call-time `route.fd` and a sweep for `fs`
functions a newer Node adds, come after #194, as the register has them.)

### For your ruling

- **The logger:** the private loader (bunyan behind it, 32 files on the
  first log), or a bunyan-free worker logger (it only builds a record and
  sends it with `sendLog`, so the main thread's bunyan writes it). I
  recommend the bunyan-free worker logger: it removes the commonest late
  load (the first `recordUsage` logs), and the private loader then serves
  only postman-request and the validator.
- **The validator worker:** the private loader, or preloaded at boot when
  `workerData.validateOnly`. I recommend the preload: that worker exists
  only to validate, and is discarded.

### PRs and estimate

0. **F4-1 first, on its own** (a release blocker, independent of P):
   the load hook's grant limited, the resolve hook's captured
   `_resolveFilename` and resolved bound, with both routes' tests. About
   0.5 d. F4-7 and F4-8 ride with it if small, or with PR 1.
1. The hoists and boot moves (redis-api, live options, bind-address,
   re-requires, patch built-ins), plus the bunyan-free worker logger if
   ruled: no behaviour change a module can see. About 0.5 d.
2. P proper: `runtime-require.js` with the genuine set; the hook serving
   module code only; A (the cache view), C (the graph), S (the statics);
   postman-request and the validator through it; guard (a) and its CI
   check. About 2 d.
3. The window and interop tests in both modes, the compatibility table,
   docs and the security-model residuals, and the Windows legs. About 1 d.

Deep review on each.

## Revision 4: the reviewer's design review of Revision 3 (implementer C, 2026-11-17)

Status: for the reviewer's approval before code. Revision 3 stands except
where this changes it. The review confirmed F4-1's diagnosis and fix 1
(route-independent, PR 0 first), the fit with #370, and every line
reference against master.

### The invariant

**`load` and every private `require` are unreachable from module code.**
Revision 3 kept the private `require` out of module code's data paths
(the cache, the graph, the statics). Function-object paths reach it too.
In a sloppy frame, `getter.caller` gives the calling function and its
`.arguments` (for the CommonJS wrapper, `arguments[1]` is that file's
`require`); a `CallSite`'s `getFunction()` does the same. #322 doesn't
stop either for a sloppy frame. So:

- **No third-party sloppy code is loaded after the lockdown** (ruling 1).
  A file's CommonJS wrapper runs only while that file loads, so a sloppy
  file loaded at boot has finished its wrapper before any module code
  exists. Its later functions hold no loader. The `require` they closed
  over at boot is the shared loader's, which serves module code only after
  the lockdown.
- **The private loader serves only countinghouse's own lib files**, which
  are all strict (no `.caller`/`.arguments`, no sloppy `getFunction()`).
  It refuses anything under `node_modules` after the lockdown, which the
  net reports (below). The private loader is kept for a missed runtime
  first-load of our own files. That is fail-safe, and by the list below
  it should load nothing.
- **The logger becomes the bunyan-free worker logger.** It is loaded at
  boot and fixed by `fixOwn`. Its record shape is unchanged
  (`level`/`msg`/`e`/`de`/`lost`), sent with `sendLog` so the main thread's
  bunyan writes it. `LOG.logger` is assigned after boot (countinghouse-util),
  so the worker's `LOG` forwards to the worker logger by one captured
  function, never by a later lookup. bunyan never loads in a worker.
- **postman-request is preloaded at boot when the module declares `net`.**
  Without `net`, the facade's `request` (chutil-facade.js:73, wrapped by
  the lockdown) and `invokeAction` must refuse before `lazy('postman-request')`
  runs. PR 1 checks the order on both paths and moves the refusal ahead
  of the load where it isn't. A test pins that a module without `net`
  loads nothing on either path. Traced: postman-request loads nothing
  while it runs.
- **The validator worker preloads its closure when `workerData.validateOnly`**
  (module-manager.js:961, ruling 3). module-validator.js's call-time
  requires are hoisted: 30, 52, 114, 212 (→ declarations 371), 233 (→
  identity 63), and handler-map-module.js 30 and 129. Line 31's require of
  the module's own file stays.

So after the lockdown, the runtime loads nothing third-party and, by the
list, nothing of its own either.

### The resolver statics (ruling 2)

Every resolver static is locked non-writable, non-configurable, in audit
**and** enforce:
- `_pathCache`, frozen to a private copy, so its entries can't be planted
  or changed. Node's loader then works from a fresh empty object of its
  own, as the private loader does.
- `_nodeModulePaths`, `_initPaths`, `_stat`, `_readPackage`,
  `findPackageJSON`, `_resolveLookupPaths`.
- Revision 2's list: `_load`, `_resolveFilename`, `_cache`, `_extensions`
  and each handler, `wrap`/`wrapper`, `_findPath`, `prototype.require`,
  `load` and `_compile`.

identity.js:477 locks some of these under enforce only today; that goes.
The private loader checks its own result, as `path.resolve`d, against
countinghouse's code roots, and refuses anything under the module's root.

### F4-1 fix 2, stated exactly (ruling 4)

`resolve` calls **Node's original `Module._resolveFilename`, captured at
boot**. It doesn't call the <24.15 shim's wrapper (resolve-shim.js:157)
or identity's enforce wrapper (:506). `bound()` then becomes the only
boundary on this path, and the `reachesLib`/`uses` reports those wrappers
made are lost here. That is accepted: `bound()` refuses what they reported.
The URL returned (identity.js:437) is built from the same normalised path
`bound()` checked, never from the request.

`bound()`'s `!fromModule` branch and identity's enforce `allowed()` are
closed too. Module code can't resolve or stat a runtime path through
either. The runtime's own resolutions go through the private loader.

### The net (ruling 5)

It fires on **a runtime parent AND a target outside the module root**, after
the lockdown, which begins at lean-worker.js:268 (identity in
`beforeLock`, after the hooks register). It doesn't fire on legitimate
runtime loads of module files (lean-dispatcher.js:36,
countinghouse-util.js:90, module-validator.js:31) or on the forged-parent
fixtures (a forged parent is module code and gets module code's answer).
It is refused under enforce and logged once with a distinctive line under
both modes. **A test in the existing suite checks it** (an unconverted
`require` from a runtime file: the refusal and the line asserted). No new
CI workflow step.

### A and C, specified (ruling 6)

**A is a Proxy installed as `Module._cache`** before the lockdown, over the
real cache, which the runtime keeps by a private reference. Node's loader
reads `Module._cache` too, and after the lockdown it serves module code
only, so one view serves both: `get`/`has`/`ownKeys`/
`getOwnPropertyDescriptor` show only entries under the module's root. A
`set` under the root goes to the real cache; a `delete` is allowed only for
entries under the root. The other choice, a `_compile` prelude giving each
module file its own `require.cache`, leaves `module.constructor._cache`
unfiltered, so it is not taken. Because `_cache` is locked (S), the view
can't be replaced.

**Under audit, an out-of-root load is allowed and reported**, and its
`Module` is stored in a **private per-module cache** (a `Map` the Proxy's
`set` routes it to). Later requires of it are served from there and
reported once, never reloaded each time, never thrown, and never visible
through `require.cache`.

**C:** the module's entry is loaded with a null parent, so no runtime
`Module` gets it as a child and its `module.parent` is undefined.
`require.main` and `process.mainModule` are `undefined` in the worker
(deleted, then defined as non-configurable `undefined` before the
lockdown). The tests assert all three, as Revision 2 did.

### Files loaded before the lockdown (ruling 8)

`load` returns the **exports captured at the lockdown** (a `Map` from
filename to exports, filled once), never `cached.exports` read at call time.
A module can't replace a runtime file's `module.exports` through anything
anyway (A hides the entry), and this stops a later swap at the source.

### `load` everywhere (minor)

- Main thread: not installed; the runtime uses Node's loader as now.
- Single-thread (`--no-workerThread`): not installed (no lockdown; the
  runtime and module share one loader by design; residual stated).
- `off`: not installed.
- Before the lockdown in a worker: `load` is plain `require` (boot loads
  are made there). It refuses only once the lockdown has run.
- A private load is in no `require.cache`, and `require.resolve` in a file it
  loaded resolves through `load`'s own resolution (captured
  `_resolveFilename`, the result checked as above).

The private loader reads files with the original `fs` captured at boot,
which is the route the boot loads use. The broker's grant isn't involved
(Revision 3 said both; this is the one).

### BroadcastChannel (ruling 7: included)

Under enforce the global is removed from module code's realm before the
lockdown (`delete globalThis.BroadcastChannel`, and `worker_threads`'
export through the module's `require` replaced by a stub that throws
`MODULE_NOT_PERMITTED`). Under audit it stays, and its first construction
is reported. Test: two module workers under enforce can't construct one
(both routes); under audit, one message passes and a report line appears.
security-model.md's "planned" line becomes the shipped behaviour.

### The others (minors, accepted)

- **F4-7** covers `vm.Script`, `vm.compileFunction` and `runInContext`/
  `runInNewContext`/`runInThisContext`. The original `Script` can't be
  reached through a subclass's prototype (`class X extends vm.Script` gets
  the wrapper; the original's constructor is unreachable). Under audit:
  `cachedData` is still dropped, so the behaviour is the same and reported.
- **F4-8**: an exact key allowlist test for a worker's options;
  `deviceConfigPath`, `usageDir` and `sessionSocket` leave the list too.
- **Boot-moved files go into `fixOwn`.**
- **The table** gains the worker logger (a first load until it moves to
  boot) and the single-thread facade (specified above). The count is about
  21 sites, not 16.
- **Test 4** (each late-load site works under enforce) can't be red on
  master. It is a regression guard, run under audit too.

### Tests, revised (ruling 9)

1. **P alone**, with Revision 2's test-only handle (a runtime `Module`
   handed over by a test global in a fixture build), so P is proved
   without A or C: its `.require`, `Module._load(x, {filename: runtime})`
   and `new Module().load(hostFile)` are refused (enforce) or reported
   (audit).
2. A and C: `module.constructor._cache` and `require.cache` list only
   module-root files; `module.parent`, `require.main` and
   `process.mainModule` are `undefined`; audit's out-of-root load is served
   from the private cache, reported once.
3. S: each locked static, in both modes, can't be replaced (`_pathCache`
   contents too), and the loader is unchanged after the attempts.
4. **The window tests probe function objects**: an `Object.prototype`
   getter, `Error.prepareStackTrace`, a thenable, `Symbol.toPrimitive`,
   `toJSON`, each reading `.caller`, `.caller.arguments` and every
   `CallSite`'s `getFunction()` while the runtime's late paths run (a log
   line, the first request, redis, live options). None returns a loader or
   a private `require`.
5. **The net fires**: an unconverted runtime `require` of a file outside the
   module root is refused under enforce, and its line is logged in both.
6. **F4-1 under audit**: the read returns the source **and** is reported
   (Revision 3 said refused; under audit it is allowed and reported).
7. Each late-load site still works (regression guard, not red on master).
8. Interop in both modes: `import()` of the module's own CJS,
   `require(esm)`, `createRequire(__filename)`, `require.resolve`, JSON.
9. BroadcastChannel, F4-7 and F4-8 as above.

The window and interop tests land **with PR 2**, not PR 3.

### PRs and estimate, revised

0. **F4-1** (fix 1, the load hook's grant, and fix 2 as stated above, with
   both routes' tests, and audit's expectation). About 0.5 d.
1. **No sloppy code after the lockdown:** the worker logger, postman-request
   preloaded on `net`, the validator closure preloaded on `validateOnly`,
   the hoists and boot moves, all into `fixOwn`. No behaviour a module can
   see. About 1 d.
2. **P with A, C, S and the net:** `runtime-require.js`, the Proxy cache
   view with audit's private cache, the graph, every static locked, the
   resolver checks, BroadcastChannel, and tests 1 to 6 and 8. About 3 d.
3. **The rest:** F4-7, F4-8, the compatibility table, docs, the
   security-model residuals, and the Windows legs. About 1 d.

About 5.5 d in all. The extra time over Revision 3 comes from rulings 1–3,
which turn three private-loader families into boot work, and from the
function-object window tests. Deep review on each.

## Revision 5: the second design review's rulings (implementer C, 2026-11-17)

Status: for the reviewer's approval before PR 0. A second review of
Revision 4 found three blocking issues. B1 was an escape open on master
and ships first as PR 00 (`Module._load`'s internal argument). B2 and B3
change the design as ruled below. Revision 4 stands where this doesn't
change it.

### PR 00 (B1, shipped first)

`Module._load(request, parent, isMain, internalOptions)` skips the resolve
hooks when `internalOptions.shouldSkipModuleHooks` is set. From Node 24.21
it also honours a `resolved` resolution and `source` to compile. The
built-in gate and the file broker's bound both live in the resolve hook,
so a module could load the real `child_process` under enforce, and audit
reported nothing. In both modes the lockdown now replaces `_load` with a
wrapper that forwards exactly `(request, parent, isMain)`, and locks it.
Node's own callers that pass the argument (an imported CommonJS file, from
the ESM translators) then run the hooks again. The file broker's lasting
branch answers them (fs-broker 12's esm-probe case). The tests (sandbox 05)
run all three forms under both modes on every Node line in CI. Only the
first form is red on master below Node 24.21, since older lines ignore
`resolved` and `source`.

### No private first-loads (B2's ruling)

`Module.wrap` and `Module.wrapper` are non-configurable accessors, so they
can't be locked. A `_compile` captured earlier still wraps source with
whatever `Module.wrap` holds when it runs. So a private loader that
compiles anything after the lockdown would hand its `require` and `Module`
to module code that set `Module.wrap` during the window.

**Ruling: after the lockdown, `load` compiles nothing.** It returns only
exports captured at the lockdown (a `Map` from filename to exports, filled
once). Anything else is refused, in both modes, with the net's line. There
is no private compile path. So:

- **Revision 4's 21-site list becomes a must-preload list.** Everything the
  runtime needs after the lockdown is loaded before it:
  - the worker logger (bunyan-free);
  - redis-api;
  - the live-options file;
  - bind-address;
  - the patch's built-ins;
  - postman-request, when the module declares `net`, in both modes
    (revised by Revision 6's item 11: no longer always under audit);
  - the validator closure (on `validateOnly`);
  - each re-require, hoisted;
  - `reachesLib`'s lookup (below).
- **No runtime resolution after the lockdown at all.** Every runtime
  `require` after it is either a captured export (served by `load` from the
  map) or refused. So the captured `_resolveFilename` is used only for
  module requests (F4-1's fix 2). There it still calls identity's `_findPath`
  enforce wrapper (loader.js:1557). That wrapper's `allowed()` drops the code
  roots for those requests (Revision 4, closed with `bound()`'s
  `!fromModule` branch), which is right, since no runtime request is
  resolved that way any more. A test pins it: after the lockdown, under
  both modes, the runtime makes no `Module._load` with a runtime parent
  while each late path runs (a log line, the first request, redis, live
  options, `getHostIp`, `loadFile`, `readLines`, validate-module). It is
  recorded by a test-only probe installed before the lockdown.
- **`reachesLib`** (module-lockdown.js:189, called at :1230) is a runtime
  `require.resolve` after the lockdown. It becomes a lookup in a set of
  lib file names listed at boot, with no resolution.
- **Identity tags a lib-reaching not-found itself** (from PR 0's run):
  identity's resolve hook runs ahead of the lockdown's. Since F4-1's fix 2,
  the lockdown's catch never sees a module request's not-found, so under
  enforce identity tags it (the sandbox's refusal, with `reachesLib`). Under
  audit an untagged not-found stays, as Node words it.

### `_pathCache` (B3's ruling)

A frozen `_pathCache` breaks the next resolution, because Node writes to
it. **It becomes a locked Proxy that reads as empty and drops every
write.** Resolution then does its full lookup each time, which is the cost
of a planted entry being impossible. The test plants an entry before and
after the lockdown, then resolves: the planted path is never used.

### The rest of the review (accepted)

1. The three runtime loads of module files (lean-dispatcher.js:36,
   countinghouse-util.js:90, module-validator.js:31) get a null parent
   (revised by Revision 6's item 8: the module's own anchor).
   Every runtime `Module` gets `parent` undefined and empty `children`. The
   test checks `module.parent` at all three sites.
2. The cache Proxy (A) has every trap: `get`, `set`, `has`, `deleteProperty`,
   `ownKeys`, `getOwnPropertyDescriptor`, `defineProperty` (which wrote
   through), `getPrototypeOf`, `setPrototypeOf`, `isExtensible` and
   `preventExtensions`. Each is tested.
3. ~~Under audit, postman-request is always preloaded (audit allows a request
   enforce would refuse, so it's always reachable there).~~ Revised by
   Revision 6's item 11: preloaded only when the module declares `net`, in
   both modes.
4. A genuine-parent out-of-root load is refused under audit too: audit's
   private cache (Revision 4, A) holds only module-root files, and there is
   no out-of-root runtime load to serve under B2.
5. `reachesLib` is on the must-preload list (above).
6. `_stat` and `_readPackage` are locked by value (a non-writable data
   property), since a setter would still hook a lock by accessor.
   `_resolveLookupPaths`' wrapper filters for any parent, not only virtual
   ones (identity.js:537).
7. F4-1's fix 2 builds its parent from own data properties only (a
   null-prototype object literal), so a `Module.prototype.filename`
   accessor can't steer it. PR 0 already does this; a test pins it.
8. The dead code-root grant in `load` goes in PR 2. Under B2 no runtime
   file is read after the lockdown.

### Tests added (to Revision 4's)

- B1's three forms on every CI Node line, under both modes (PR 00).
- `Module.wrap` set during the window, then each late path run: no
  `require` or `Module` reaches module code (there is no compile after the
  lockdown).
- A planted `_pathCache` entry is never used.
- `_stat` checked by behaviour: replacing it is refused, and a stat of a
  runtime path from module code answers missing.
- `defineProperty` on the cache view is refused or lands in the view, never
  in the real cache.
- `module.parent` at the three runtime-load sites.
- An all-strict pin: every file under `lib/` starts with `'use strict'`
  (no sloppy runtime frame).
- A request with no `net` under audit: allowed, and reported as a `net`
  report; postman-request loads then, after the lockdown (Revision 6's
  item 11).

### PRs and estimate, revised

00. B1, `Module._load`. About 0.3 d, in review.
0. F4-1, plus identity tagging lib-reaching not-founds and the
   own-data-parent pin. About 0.5 d.
1. The must-preload list: the worker logger, postman-request, the
   validator closure, redis-api, live options, bind-address, the
   built-ins, the hoists, `reachesLib`'s set, and null parents at the three
   sites, each into `fixOwn`. About 1.5 d.
2. P: `load` serving only captured exports; A with every trap; C; S with
   `_pathCache` as the empty Proxy and `_stat`/`_readPackage` by value; the
   net and its test; BroadcastChannel; the window and interop tests,
   `Module.wrap` included. About 2.5 d (smaller than Revision 4's 3 d: no
   private compile path).
3. F4-7, F4-8, the compatibility table, docs, the residuals, and the
   Windows legs. About 1 d.

About 5.8 d in all, with PR 00.

## Revision 6: the third design review's rulings (implementer C, 2026-11-17)

Status: for the reviewer's approval before PR 0. Fable's re-review of
Revision 5 and #406 (probes on Node 22.16 to 26.13) closed B1 and B3, and
closes B2 with blocking 2 below. It found two new blocking issues, both in
pieces Revision 4 carried. Revision 5 stands where this doesn't change it.

### Blocking 1: A is not a Proxy (ruling)

`util.inspect`, an allowed built-in, reads a Proxy's target past every
trap. So `util.inspect(require.cache)` prints the runtime's file names, and
an `inspect.custom` on `Object.prototype` is called with each genuine
runtime `Module` as `this`, which yields every runtime export, `load`
included. A runtime file's own `require.cache` would also have stayed the
real cache.

**Ruling: no Proxy.** At the lockdown, every entry for a file outside the
module's root is **moved** into the private `Map` (`load`'s captured
exports, Revision 5) and **deleted from the real cache object in place**.
`Module._cache` is then locked (non-writable, non-configurable), still
the same object. After that the real cache holds module files only. Every
`require.cache` (module code's, and a runtime file's own) is that object,
so there is nothing for a view to hide and no target for `inspect` to
read. A runtime file needing another after the lockdown gets it from
`load` (the `Map`), never from the cache.

Consequences:
- Node's loader still writes module files into the real cache, which is
  module code's to read anyway.
- A runtime `require` after the lockdown that isn't converted finds nothing
  in the cache, so Node would load a second copy. The net refuses it
  first (Revision 5: no runtime resolution after the lockdown), in both
  modes.
- Revision 5's item 2 (every trap on the cache Proxy) and item 5 (traps
  never answering false) are moot for A. Item 5 still holds for
  `_pathCache`'s Proxy (below).

Tests: the inspect route (`util.inspect(require.cache)`, and an
`inspect.custom` getter on `Object.prototype` while a runtime path runs)
shows no runtime file or `Module`. A runtime `require` function handed to
module code (not only a `Module`) loads nothing: it is the shared loader's,
which serves module code only.

### Blocking 2: Node's relative-resolve cache (in #406)

`Module._load` answers from a cache keyed by `${parent.path}\0${request}`
before any hook. A check of the caller's parent couldn't be made sound:
Node reads its `id`, `path`, `filename`, `paths` and an internal URL symbol
at different moments, through prototypes module code can reach (three
reviews of #406). So #406 never hands Node the caller's parent.

**#406 shipped without a shadow.** Through several review rounds #406
carried a shadow parent against this route: Node given a frozen stand-in
built from the caller's filename alone, plus a data-only `module.parent`.
The reviewer ruled it out. It protected only the runtime's lazy loads
after the lockdown, while the same outcome stays one assignment away
through a planted `require.cache` entry, which #406 can't close. It also
changed `module.parent`, `paths` and `children` for every module, even
under audit. **PR 1 makes it unnecessary:** with no runtime load after the
lockdown, a poisoned key has no victim. #406 is B1 (the three-argument
`_load`, string-only, `isMain` refused under enforce) plus the holds that
change nothing a module sees (`Module.prototype.load`, the extension
handlers, the extensions table closed under enforce and watched under
audit).

**Where Revision 5's item 4 lives.** It is a genuine-parent out-of-root
load refused under audit. That belongs in #406's `_load` wrapper (the hook
sees a URL, never the parent). PR 2 **adds** the genuine set (the runtime's
Modules, taken at the lockdown) and checks it there: a genuine runtime
parent passed from module code is refused by the net.

### The rest of the review (rulings and accepted items)

3. **The must-preload list grows.**
   - On the validator path, always reached: module-layout.js:16 and
     schema-safety.js:30.
   - Also: declared-icons.js:45, and declarations.js:200 and :465
     (client-text).
   - sshpk's ssh-private.js:70/191 lazily requires bcrypt-pbkdf on the first
     encrypted OpenSSH key, reached through the allowed `httpSignature`
     request option. ~~Ruling: the `httpSignature` option is refused in
     release 1, in both modes.~~ **Revised (#425's review): bcrypt-pbkdf is
     preloaded with postman-request** (along postman-request ->
     http-signature -> sshpk), so sshpk's require on an encrypted key is a
     hit in Node's cache whatever route the option takes (a prototype, a
     second argument, the Request's own `.httpSignature()`); the refusal is
     dropped, and nothing changes for a module.
4. **The "no runtime resolution" test** records `_load`,
   `_resolveFilename`, `createRequire` and `getBuiltinModule` (a runtime
   parent or caller, after the lockdown, while each late path runs). Also:
   - a static pin, run in CI: no nested `require(` or `import(` (inside a
     function) in the worker's and validator's closures, **the dependency
     closure included** (tough-cookie's utilHelper.js:4 lazily requires
     `util`; psl did not parse and needs the pin's parser to cope), except
     the listed `isMainThread` sites; a dependency bump that adds one fails
     it;
   - a check that the test-only recording probe is absent in a normal
     start.
5. **`_pathCache` stays a locked Proxy that reads as empty and drops
   writes.** Its traps never answer false to Node: a refused `set` or
   `deleteProperty` would make the loader throw, so they answer true and
   do nothing.
6. **`load` maps a specifier to a file by path arithmetic against the
   `Map`'s keys** (relative to the caller's own file, then the listed bare
   names), never through the captured `_resolveFilename`.
7. **Identity's any-parent filter on `_resolveLookupPaths`** keeps the
   module root's host `node_modules` paths (F4-1's fix 2 resolves a module
   request with a host parent). `grant.resolving` drops the code roots for
   non-module parents (identity.js around 403).
8. ~~A null parent gives `module.parent === null`.~~ **Revised (#425's
   review): a module-side anchor.** A null parent makes
   `if (!module.parent) main()` (the CLI idiom) run a module's entry-point
   code inside the worker on every load. The three runtime loads of module
   files have the module's own anchor as parent instead: one `Module` per
   module root, made on its first load, its file inside the root
   (`/app/.countinghouse-entry`, no file on disk). Its `require` is the
   module's own, so it hands module code nothing new. A test loads a
   handler and a `loadFile` file that throw when `!module.parent`, and
   checks that the parent's filename is inside the module root.
9. **F4-1's not-found** names only the request (PR 0 already throws its
   own error, with no require stack and no host parent). A test asserts the
   message and `requireStack`.
10. **#406's comment** now says every load it makes runs the hooks, apart
    from what Node answers from its own caches; blocking 2's check covers
    the one that mattered.
11. **Revision 5's item 3 is revised: postman-request is preloaded only
    when the module declares `net`, under audit and enforce alike.**
    Preloading it on every audit worker costs about 240 files at boot (PR
    1's measure on sandbox 43). A no-net module's request under audit loads
    it after the lockdown instead. Audit isn't a boundary: the request
    itself is reported (a `net` report naming its target), and it carries
    only the module's own options, so the late load exposes nothing the
    module didn't already hold. Under enforce a no-net request is refused
    before the load.

### Audit under S, and what S names (the fourth review's rulings)

- Revision 4's "lock in both modes" stands for every loader static
  **except** those #406 deliberately leaves, under audit, as accessors that
  report a replacement (`_load`, `_resolveFilename`, `Module.prototype.load`,
  the extension handlers). Until PR 1, audit is not a boundary for these
  (documented in security-model.md). After PR 1 there is no runtime lazy
  require for a replaced `Module.prototype.require` or `_load` to intercept,
  so under audit a replacement affects only the module's own loads, and the
  net's guarantee holds.
- S names, besides Revision 4's list: the `prototype` property of `Module`
  (writable on a function), and new keys of `Module._extensions` (#406 makes
  the table non-extensible under enforce).
- Test 4 (the window) adds an accessor on both prototypes (`Module.prototype`
  and `Object.prototype`) for each own symbol of a Module (Node's URL symbol
  among them).
- Planted `require.cache` entries and an accessor for Node's URL symbol are
  closed only by PR 1 (no runtime lazy load to poison) plus the net ahead
  of Node's cache (PR 2): S alone does not close them (#406 has no shadow).

### PRs and estimate, revised

00. #406: `_load` with three arguments (string-only, `isMain` refused
    under enforce), the reduced module for imports, and the holds and
    their audit accessors, with the extensions table closed. No shadow:
    PR 1 makes it unnecessary.
0. F4-1, with identity tagging lib-reaching not-founds, the own-data
   parent, and item 9's test. About 0.5 d.
1. The must-preload list (Revision 5's, plus item 3; postman-request on
   `net` only, item 11), bcrypt-pbkdf with it (item 3, revised), the
   module's anchor as parent at the three sites (item 8, revised), and item
   4's static pin. About 2 d.
2. P: the cache entries moved and the property locked (no Proxy); `load`
   serving only the `Map` by path arithmetic; C; S with `_pathCache` as
   the empty Proxy; the genuine set, added to #406's wrapper and checked
   there, with the net (by the parent object) and
   its tests; item 7; BroadcastChannel; the window, inspect and interop
   tests. About 2.5 d.
3. F4-7, F4-8, the compatibility table, docs, residuals, the Windows legs.
   About 1 d.

About 6.5 d from here (Fable says 7–8 d; the rulings remove the Proxy and
the private compile path, which is where most of the difference lies).
