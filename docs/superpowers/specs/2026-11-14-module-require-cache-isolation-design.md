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
  `module.parent` for the "am I the main module" idiom gets `undefined`,
  which most read as "not main". `createRequire` inside the root keeps
  working.
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
  Nothing breaks for modules.
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
