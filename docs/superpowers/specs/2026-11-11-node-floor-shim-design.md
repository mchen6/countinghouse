# Node floor: 22.16 with a resolve shim

Status: draft for review (2026-11-11, reviewer session, for implementer B).
Target: 8.0.0 (unreleased). Decided by the maintainer on 2026-11-11 with the
conditions in "Conditions" below.

## Intent

countinghouse 8 requires Node 24.15. The reason is one gap: before 24.15,
`module.registerHooks` resolve hooks are not consulted by `require.resolve`
and `createRequire().resolve`, so under the sandbox's virtual paths a
module's `require.resolve` fails, and, worse, bypasses the lockdown's require
boundary and the broker's path mapping. Many developers run Node 22 (an LTS
until 2027-04-30). This design lowers the floor to 22.16, the first 22 with
`registerHooks`, by closing that one gap with a shim, without weakening the
sandbox.

## Findings (2026-11-11, replicated on this machine)

| Node | `require()` through the hook | `require.resolve` / `createRequire().resolve` through the hook |
|---|---|---|
| 22.23.4 | yes | **no** (MODULE_NOT_FOUND on a virtual path) |
| 24.14.1 | yes | **no** |
| 24.15.0 | yes | yes |
| 24.22.2 | yes | yes |

The resolve hook's `context` (`parentURL`, `conditions`) is identical across
the four versions for a CommonJS `require()` from a file. Everything else
the runtime uses from Node 24 exists on 22.23: `module.registerHooks`,
`process.getBuiltinModule`, `--permission`, `Worker.getHeapStatistics`,
`process.loadEnvFile`; no newer syntax is used.

The sandbox test folder on 22.23.4 with the floor lowered and no shim: 323
passing, 2 pending, 5 failing: `05` (the lockdown's `reachesLib` uses
`require.resolve` on a virtual path), `09` (the hardened probe's
`require.resolve('./read')`), `10` (the floor test itself), and two in `21`
(the sandboxed validator: `/app/package.json` and `/app/api.json` read as
ENOENT, which sits in the broker's virtual-path handling, built on the same
hooks; probably the same cause, not proven). The maintainer's condition:
the floor drops only if the shim makes all five pass.

## Why this is a security matter, not only a feature

On an older Node a module's `require.resolve(x)` reaches Node's resolver
with the module's virtual parent path, skipping `lib/module-lockdown.js`'s
resolve hook (the require boundary: outside-namespace requires are refused
and recorded) and `lib/fs-broker/identity.js`'s hook (virtual-to-host
mapping). Today the result is a failure, not a leak; but a resolver reached
without the boundary is a probe (does this host path exist?) with no
violation recorded. So a lower floor without the shim weakens the sandbox,
and the shim is part of the boundary.

## Design

### 1. Where the shim sits

`require.resolve` and `createRequire(...).resolve` both call
`Module._resolveFilename(request, parent, isMain, options)` directly (Node's
`makeRequireFunction`), while `require()` goes through `Module._load`, where
Node runs the registered resolve hooks (`resolveForCJSWithHooks`) and then
`_resolveFilename` as the default resolver. The shim wraps
`Module._resolveFilename` in the worker, under the lockdown's own control,
on Node below 24.15 only:

- A call that arrives while the hook chain is already resolving (Node's
  `_load` path, or a `nextResolve` inside our hooks) is passed to the
  original resolver unchanged. The two hooks set a re-entrancy marker around
  their `nextResolve` calls (`identity.js` already keeps `inner` for its own
  re-entrant resolve; the lockdown gets the same), and the wrapper checks
  it.
- A call that arrives outside the chain, from a parent whose `filename` is
  module code (under the virtual root, `fromModule(parent)` as the lockdown
  already decides), is a `require.resolve` from module code: the wrapper
  runs the same chain by hand, identity hook first, then the lockdown hook,
  then the original resolver, with `context = {parentURL:
  pathToFileURL(parent.filename).href, conditions: ['require', 'node',
  'node-addons', 'module-sync']}` (the context Node passes, verified
  identical on 22 and 24), and returns the host path the chain yields, or
  throws what it throws.
- As 24.15 does: every `_resolveFilename` call outside a running chain goes
  through the hooks, whoever the caller (reviewer, 2026-11-11, on implementer
  B's measurement on 22.23, 24.14, 24.15 and 26.13: from 24.15 Node runs them
  for every `require.resolve` and `createRequire().resolve`). The lockdown's
  own `reachesLib` and the validator's `require.resolve` run from
  countinghouse code and need the identity hook's mapping, which is the case
  the failing tests exercise.

The chain is exposed by the two hook modules as a function the wrapper can
call: `identity.js` exports `resolveForModule(specifier, context, next)` and
`module-lockdown.js` keeps its hook function in a variable it hands the
wrapper, so no logic is duplicated: the hooks registered with
`Module.registerHooks` and the functions the wrapper calls are the same
objects.

### 2. Version gate

`lib/node-version.js`: `MIN = '22.16.0'`; a second export `NEEDS_RESOLVE_SHIM
= !supported('24.15.0')` (true below 24.15). The wrapper is installed only
when it is true, in `module-lockdown.js` after its own `registerHooks`, before
`registerHooks` is locked. On 24.15+ nothing changes.

### 3. What the shim must not allow

The same reachability as the native hook: a module must not be able to reach
the unwrapped resolver. Adversarial tests (the maintainer's condition),
under `enforce`, each expecting the boundary's violation and no host path:

- `require.resolve('/etc/passwd')`, `require.resolve('../../lib/sandbox')`
  and `require.resolve.paths(x)` from module code;
- `require('module').createRequire(__filename).resolve(x)` (the reduced
  `module` under enforce; and under audit the real one);
- `process.getBuiltinModule('module').createRequire(...)`;
- a `require` captured before lockdown (the fixture keeps a reference from
  its top level and uses it in a handler);
- `module.constructor._resolveFilename(...)` called directly from module code
  (the wrapper is the installed function, and `lock()` protects the
  property as the lockdown locks the others);
- the identity probe (`where`): `require.resolve('./read')` and
  `createRequire(`${__dirname}/`).resolve('./read')` return the virtual
  path on 22 as on 24.

Plus a reviewer bypass attempt before merge (the reviewer session).

### 4. CI

The sandbox tests run on `22.16.0`, the newest 22, `24.0.0`, `24.14.x` and
`24.15.0`, besides the newest 24 and 26 the matrix already has. The golden
job stays on 24.

### 5. Documentation

- README and `docs/security-model.md`: "Node 22.16 or later. Below 24.15 a
  compatibility shim routes `require.resolve` through the sandbox's hooks;
  multi-tenant hosting of third-party modules should run 24.15 or later,
  where Node's own hook covers it." CHANGELOG and `docs/upgrading-to-8.md`
  likewise.
- A dated note in `lib/node-version.js` and CHANGELOG: raise the floor to 24
  when Node 22 reaches end of life, 2027-04-30.

## Conditions (the maintainer, 2026-11-11)

1. The shim makes all five Node 22 failures pass, the validator case
   included; if the validator case survives the shim, the floor question
   returns to the maintainer.
2. Adversarial tests as in section 3 and a reviewer bypass attempt.
3. CI as in section 4.
4. Documentation as in section 5.

## Non-goals

- Changing anything on 24.15+.
- Supporting Node 20 or 22 below 22.16.

## Left to the builder

- The exact re-entrancy marker and how `identity.js` and
  `module-lockdown.js` hand their hook functions to the wrapper.
- Whether `createRequire().resolve.paths` is wrapped or refused (either is
  acceptable; refused is simpler and must be recorded as a violation).
