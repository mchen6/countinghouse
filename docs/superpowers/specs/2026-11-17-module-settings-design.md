# Module settings: declared by the module, changed by the user (release 1)

Status: draft for review, 2026-11-17; the maintainer answered the two open questions the same day. Reviewer session.
Scope: countinghouse (declaration, delivery to the module, the settings tool)
and ch-local (the terminal command, the file).

## Intent

A module written by one person and installed by another needs a few plain,
non-secret options per user: a default repository, a region, units, a team
name. Today a user cannot set them without editing a file: `ch-local
settings` covers the runtime and packs, not modules, and a module's only
inputs are operator-approved environment variables (`--modulePolicy`),
its data folder, and `ctx.ask` at call time.

The maintainer (2026-11-17) wants, for release 1:

- the **module** declares its settings; the **user** never edits a file;
- the user changes a setting in one of two ways: **one fixed command** at a
  terminal, or **in conversation**, in plain words, through the agent;
- a change applies **on the fly**, to a module that is already loaded;
- a change is **persisted**, so a reload, a restart or the next start reads
  the new value.

## What it is not

- **Not secrets.** A credential never goes through settings. It stays in
  the credentials store (`ch-local credentials`), bound to the module that
  declared it (the pack-2 credentials work).
- **Not grants.** No setting widens a module's sandbox. Hosts, file paths,
  environment variables and limits stay the operator's grants
  (`--modulePolicy`, the ceiling). A setting can only steer what the module
  does with what it is already allowed. So a prompt injected into a tool
  result that talks the agent into changing a setting gains the module no
  reach.
- **Not per caller on an HTTP multi-tenant server**, in release 1. There the
  values are the server's (one set per module), changed by the operator with
  the same command against that server's home. Per-key settings are a later
  design if a customer needs them.

## 1. The declaration (the module's author)

In the module's `package.json`, beside `calls` and `permissions`:

```json
"countinghouse": {
  "settings": {
    "units":       {"type": "enum", "values": ["metric", "imperial"], "default": "metric",
                    "title": "Units", "description": "Units used in forecasts."},
    "defaultRepo": {"type": "string", "maxLength": 140, "pattern": "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
                    "required": true, "title": "Default repository",
                    "description": "owner/name used when a call names no repository."},
    "maxResults":  {"type": "integer", "min": 1, "max": 100, "default": 20,
                    "title": "Results per call"},
    "shareStats":  {"type": "boolean", "default": false, "confirm": true,
                    "title": "Send anonymous usage statistics",
                    "description": "Sends counts to the module author's endpoint (declared in permissions.net)."}
  }
}
```

A small closed vocabulary, not general JSON Schema, so it is easy to check,
show and explain, and gives nothing to hide text in:

| Field | Rules |
|---|---|
| name (the key) | `[a-z][a-zA-Z0-9_]{0,63}`, no dots. At most 32 settings per module. |
| `type` | `string`, `integer`, `number`, `boolean`, `enum`. |
| `values` | `enum` only: 1–64 strings, each 1–64 characters of `[A-Za-z0-9 _.:/@+-]`. |
| `min`, `max` | `integer`, `number`: finite bounds. |
| `maxLength` | `string`: 1–1024 (default 256). |
| `pattern` | `string` only, optional: an ECMAScript pattern compiled without the `u` flag, at most 256 characters, checked at load for catastrophic backtracking by the existing schema-safety check. |
| `default` | optional; must itself be valid. A setting with no default and no stored value is **unset**. |
| `required` | `true`: a call while it is unset fails `SETTING_REQUIRED` (section 5). |
| `confirm` | `true`: a change made in conversation needs the user's own confirmation (section 3). The author marks a setting that sends data somewhere, costs money, or acts on the user's behalf. |
| `title`, `description` | text shown to the user and the agent; `title` ≤ 64, `description` ≤ 512 characters. Cleaned of hidden characters at egress like every declared text (client-text). |

`countinghouse-validate` and the load check the declaration. A bad one
refuses the module with `SETTINGS_DECLARATION_INVALID`, by position and field.
The validator also warns on a setting whose name or title looks like a
secret (`password`, `token`, `secret`, `apiKey`, `credential`): that belongs
in the credentials store.

Total size of a module's declaration: at most 16 KiB.

## 2. Where values live (persisted)

In ch-local's `<home>/settings.json`, the same file, lock and history as
every other setting, with the module's name in the setting's name:

```json
{"version": 1, "values": {
  "requestTimeout": 30000,
  "pack.ci-failure-triage": true,
  "module.weather-tool.units": "imperial",
  "module.@acme/repo-helper.defaultRepo": "acme/api"
}}
```

- The name is `module.<package name>.<setting>`. A setting name has no dot,
  so the last dot splits it, whatever the package name holds.
- A value equal to the declared default is removed rather than stored, so a
  module's new default applies to users who never changed it.
- Older ch-local and countinghouse versions ignore an unknown name with a
  warning (the file's existing rule), so the file stays shared across
  versions.
- Every change appends its history line first (`setting`, `old`, `new`,
  `by`, and `scope` for an all-sessions change), as today. A change is never
  made if its line cannot be written.
- The settings belong to the **module**, not the pack: a module that is a
  part of two packs has one set of values.

**Reload, restart and the next start** read the stored values when the
module loads, so a persisted change survives all three. A stored value that
the module's new version no longer accepts (a removed setting, a narrowed
enum, a tighter bound) is not applied: the module gets its default (or
unset), a warning is logged once per load, and one history line records
`{"setting", "change": "no longer valid for <version>", "kept": <old>}`. The
stored value stays in the file until the user changes or resets it, so a
downgrade gets it back.

## 3. Changing a value

### At a terminal: one fixed command (ch-local)

```
ch-local settings modules                       # every loaded module's settings: name, title, value, allowed values
ch-local settings modules weather-tool          # one module, with descriptions
ch-local settings set weather-tool.units imperial
ch-local settings reset weather-tool.units      # back to the default
ch-local settings reset weather-tool            # every setting of that module
```

- `module.` may be left out on the command line; the stored name keeps it.
- The value is parsed by the declared type and checked against the
  declaration. A refusal says why and lists what is allowed
  (`units is metric or imperial`).
- A `confirm: true` setting asks at the terminal
  (`Change shareStats for weather-tool from false to true? [y/N]`), the same
  rule as loosening today: no `--yes`, refused without a TTY.
- The change is applied **live** (section 4), then persisted under the lock.

### In conversation: the `countinghouse_settings` tool

The tool gains module settings beside the runtime's own:

- **reading**: `get` lists, for each loaded module that declares settings,
  each setting's name, title, description, type, allowed values, default and
  current value (and whether it is overridden in this session). This is what
  lets the agent map "use imperial units for the weather tool" onto
  `module.weather-tool.units`.
- **changing**: `set` with the setting's name and value. A plain setting is
  changed on request, as tightening is today. A `confirm: true` setting goes
  through the existing confirmation form, which the agent cannot answer for
  itself (part 3's rules: elicitation where the client supports it, the
  per-user form window, the latch on repeated declines; a client with no form
  support is told to use the terminal command).
- **scope**: on a shared runtime, a change made in conversation applies to
  **this session** by default (the per-session layer B2 built), and is
  replayed after a runtime restart like other per-session overrides.
  `scope: "all-sessions"` changes the stored value for everyone and always
  needs confirmation, as an all-sessions change does today. On a runtime of
  its own (one session), a change is the stored value.
- A **module never changes its own settings**: the settings tool is a
  built-in served to the client, not a module a hop can address, and must
  stay unreachable from module code (a test pins it); `ctx.settings` is
  read-only.

### The operator's ceiling

The existing ceiling file gains an optional `"moduleSettings"` map:
`{"<module>.<setting>": {"fixed": <value>}}`. A fixed setting is applied
whatever `settings.json` or a session says, and every change to it is
refused with `SETTING_FORBIDDEN_BY_CEILING`. This lets an organisation pin, for
example, `shareStats` to `false`. Nothing else in the ceiling changes.

## 4. How the module reads them, live

`ctx.settings` is a frozen, null-prototype object of the effective values
for this call: the declared defaults, then the stored values, then this
session's overrides. An unset setting is absent.

```js
module.exports = async function forecast(input, ctx) {
  const units = ctx.settings.units;           // 'imperial'
  const repo  = input.repo || ctx.settings.defaultRepo;
};
```

- **A change applies from the next call.** A call in flight keeps the
  values it started with (one snapshot per call), so a handler never sees
  a value change under it.
- **No restart**: the runtime keeps each module's effective values on the
  main thread. ch-local's `set` sends the change over the existing control
  channel (`set` with a `module.*` name), which validates it against the
  module's declaration, applies it, and answers; ch-local then persists it.
  If the runtime refuses, nothing is persisted. If the runtime is not
  running, the value is only persisted and is read at the next load.
- **Delivery to the worker** keeps the call path cheap (the latency gate):
  the main thread numbers each module's effective settings with a version.
  The invoke message carries only the version; a worker that has not seen
  that version gets the values once, in the same message, and keeps them.
  A per-session override is a different version, so sessions never see
  each other's overrides. A module with no declared settings carries
  nothing.
- **In a task** (M15), each pass reads the settings current at the start of
  that pass.

## 5. A missing required setting

A call to a module with an unset `required` setting fails before the
handler runs with `SETTING_REQUIRED`, not billed, and the message names the
setting and both ways to set it:

> weather-tool needs a setting before it can run: defaultRepo (Default
> repository: owner/name used when a call names no repository). Set it with
> `ch-local settings set weather-tool.defaultRepo <owner/name>`, or ask me to
> set it.

The agent can then offer to set it, which is what makes a freshly installed
module easy to start with. The error's `_meta` carries the setting names
(`missingSettings`) so a client can act on them.

## 6. Safety

- Values are data the module reads, never instructions to the runtime: they
  do not reach the sandbox, the policy, the ceiling, routing or billing.
- Every value is checked against the declaration on the main thread, on
  every path (terminal, control channel, tool, file read at load). The file
  is never trusted: an invalid stored value is not applied (section 2).
- Text shown to the agent (titles, descriptions, enum members, string
  values echoed back) passes the egress cleaning (client-text).
- Size: a module's effective values are at most 32 KiB, so delivery stays
  within the message envelope by a wide margin.
- Every change, refusal and confirmation is in `history.jsonl`, with the
  session that made it.
- No new file is readable by modules: `settings.json` stays in the
  always-denied ch-local home.

## 7. Errors

New codes:

| Code | When | Retry |
|---|---|---|
| `SETTINGS_DECLARATION_INVALID` | the module's `settings` declaration is malformed (load refuses the module) | no |
| `SETTING_REQUIRED` | a call to a module with a required setting unset | after setting it |

Existing codes, reused with module settings:

| Code | When |
|---|---|
| `SETTING_UNKNOWN` | a change names a module or setting that is not declared (or not loaded) |
| `SETTING_OUT_OF_BOUNDS` | a change's value does not fit the declaration; the message lists what fits |
| `SETTING_FORBIDDEN_BY_CEILING` | the operator's ceiling fixes the setting |
| `SETTING_NEEDS_CONFIRMATION`, `SETTING_CLIENT_NOT_CONFIRMED`, `SETTING_DECLINED_THIS_SESSION`, `SETTING_LOCKED_THIS_SESSION`, `SETTING_CONFIRMATION_*` | a `confirm: true` change, as for a loosening today |
| `SETTING_CHANGED_MEANWHILE` | the value changed between the question and the answer |

## 8. Tests (each red before its change)

- Declaration: every field's bounds; a bad declaration refused at load and
  by `countinghouse-validate`; the secret-name warning; hidden characters in
  `title`/`description` cleaned at egress, in enum members refused.
- Persistence: a terminal `set`, then reload, restart, and a fresh start, all
  read the new value; a default value is removed from the file; a value the
  new version rejects falls back with one warning and one history line, and
  comes back after a downgrade.
- Live: a `set` while a call is in flight leaves that call on the old value
  and the next call on the new one; a runtime refusal persists nothing; a
  stopped runtime persists only.
- Conversation: plain `set` on request; `confirm: true` through the form,
  declined, unanswered and the latch; all-sessions needs confirmation; this
  session's override invisible to another session, and replayed after a
  restart; the settings tool unreachable from module code.
- Ceiling: a fixed setting applied over the file and a session, and every
  change refused.
- `SETTING_REQUIRED`: not billed, names the setting and both ways, carries
  `missingSettings`.
- Delivery: the invoke message carries a version only after the first call
  (a size assertion), so the warm call path stays within the latency gate.

## 9. Work and estimate

| PR | Repo | What | Estimate |
|---|---|---|---|
| 1 | countinghouse | declaration (load, validate, error codes), effective values on main with versions, `ctx.settings` delivery, `SETTING_REQUIRED`, control-channel `set`/`get` for `module.*` | ~2 d |
| 2 | countinghouse | the settings tool's module kind: read, set, confirm, per-session scope, ceiling `moduleSettings`; docs (module-development, security-model, CLI) | ~1.5 d |
| 3 | ch-local | `ch-local settings modules/set/reset` for `module.*`, the allowlist sync, the ceiling reader, docs | ~1.5 d |

About 5 days in all, after the sandbox release blockers (F4-9, F4-1/#194).
PR 3 needs PR 1's control-channel messages (the shared wire vectors gain the
`module.*` set/get cases, so both repos test against one file).

## The maintainer's answers (2026-11-17)

1. **`ch-local settings modules` lists installed modules that are not
   loaded too**, read from their `package.json` declaration, so a user can
   set values before first use. Values set this way are checked against that
   declaration and persisted; they are read when the module loads.
2. **Per-caller settings on an HTTP multi-tenant server: later**, on customer
   demand. Release 1 keeps one set of values per module on such a server.

## Revision 2: after the design review (2026-11-17)

A security design review (Fable) found five blocking issues in revision 1.
The maintainer approved the three user-facing changes below the same day.
**Where this section and the sections above disagree, this section holds.**

### Three changes the maintainer approved

1. **No per-session module settings in release 1.** There is one set of
   values per user (per home). A change made in one agent session applies to
   every session of that user, and every other session is told (a notice on
   that module's next result there). The per-session layer stays a wire
   contract for caps and packs only, so `session-settings`, ch-local's
   `session-table` (`KINDS`), the restore rows and the replay rule are
   untouched. (Revision 1's per-session default, its replay and its
   all-sessions confirmation are withdrawn.)
2. **The runtime, not the author, decides what needs confirmation.** In
   conversation:
   - `enum`, `integer`, `number` and `boolean` settings change on request,
     unless the author marked them `confirm: true` or the ceiling says
     otherwise (below);
   - **every `string`** setting, and every value of a `format` that names a
     place (`hostname`, `url`, `path`), **always** needs the user's own
     confirmation, whatever the declaration says. An open value can be a
     destination (`defaultRepo` sending writes to someone else's repository),
     and "gains no reach" holds for hosts, not for destinations;
   - a `hostname` or `url` value must be inside the module's granted `net`
     entries, and a `path` inside its granted `fs` entries, on every path
     (terminal, tool, file read at load). Outside them it is refused
     (`SETTING_OUT_OF_BOUNDS`, saying it is outside what the operator
     granted).
3. **A multi-tenant HTTP server reads an operator file.** `--settingsFile`
   stays single-identity only. A server outside that profile takes
   `--moduleSettings <file>` (`{"<package>": {"<setting>": value}}`), read
   at each module load and reload, checked the same way, never written by
   the runtime, and refused to modules like the policy file. No tool and no
   command there in release 1.

### The other fixes

**Vocabulary (B1).** `pattern` is removed from release 1: an author's
regular expression would run on the main thread, and a declared default
alone could hang the runtime. In its place, runtime-owned `format`s with
fixed, linear checkers: `slug` (`[a-z0-9][a-z0-9-]{0,63}`), `repo`
(`owner/name`, GitHub's grammar), `email`, `hostname`, `url` (https only)
and `path` (absolute, normalised). `maxLength` counts characters (code
points). An empty string is unset (so it fails `required`). A value holding
a hidden character (client-text's `hasHidden`) is refused, never cleaned. A
setting named like an `Object.prototype` member (`constructor`, `toString`,
`__proto__`, …) is refused at load.

**No shell text in hints (B2).** A module that declares settings must have
an npm-grammar package name (the load refuses it otherwise). Every hint the
runtime gives (`SETTING_REQUIRED`, a confirmation that ends at the terminal,
`SETTING_TERMINAL_ONLY_SHARED`) names the setting but **never carries a
value**: `ch-local settings set weather-tool.defaultRepo`, and the command
prompts for the value at the terminal (`ch-local settings set <name>
<value>` also still works when typed by hand).

**The confirmation form (B3).** No agent or author text is offered as the
runtime's words, as part 3's `FORM_TEXT` requires. The runtime writes the
sentence: the package and its version, the setting's key, the old and new
values in quotes (each cut to 200 characters, with "(cut)"), and the
author's `title` labelled as the module's own words. The ceiling gains, per
setting: `{"fixed": v}`, `{"confirm": true}` and `{"conversation": false}`
(terminal only). A `fixed` value the declaration rejects makes that module
refuse to load, with the ceiling's reason. An untrusted ceiling refuses
every conversational module-setting change, as it refuses loosenings today.

**Explicit values are kept (B3).** A value the user set is stored even when
it equals today's default, so an upgrade that changes the default never
overrides an explicit choice. `reset` removes the stored value, so the
default then applies.

**The declaration is pinned (B3).** The `settings` declaration joins
`calls` in the manifest pins taken at load (lib/manifest-pins.js): a module
cannot rewrite its `package.json` and restart under supervision to drop
`confirm` or flip a default. A reload or upgrade takes the new pins, as for
`calls`.

**Persist, then apply (B5).** There is no control channel from the CLI;
revision 1's "the runtime refuses, nothing is persisted" is withdrawn. The
order is the existing one for settings:
1. ch-local validates the value with the **installed runtime's own reader**
   (as it reads the ceiling), refusing before anything is written;
2. it persists under the lock, history line first;
3. the running start or daemon tells its runtime to re-read `module.*`
   (the existing in-place apply path); the runtime checks again, and a
   refusal there is a notice plus a `not applied` history line.
A conversational change runs the same steps from the runtime's side (write
under the lock, then apply).

**ch-local keeps names it does not know.** `setSetting` must preserve every
`module.*` (and any unknown) name when it rewrites the file, or an older
ch-local would delete them; a bare `ch-local settings reset` resets the
runtime's settings and leaves `module.*` alone (`reset <module>` resets
one module). The outside-edits check learns the `module.*` rules.

**Parts and listing.** `get` lists only modules the session can see (its
listed modules and its packs' scenarios), and says which tool each setting
affects. An unlisted part's settings are never named to the client: they
are set at the terminal only. Result size: at most 64 settings shown per
call, with a cursor.

**`SETTING_REQUIRED` across hops.** It is checked for the whole declared
call graph before the outer call runs (not billed), so a scenario never
swallows a part's missing setting. The message reads: "… needs a setting:
defaultRepo (Default repository). Ask the user for the value (do not
guess), then set it, or run `ch-local settings set
weather-tool.defaultRepo`."

**Delivery, every path.** The versioned snapshot is attached on: a client
call, a routed hop, a direct peer channel's announcement, a job run, single
thread mode, and per-session workers; a worker's cache keeps the last 4
versions per module.

**Tasks.** A task reads the values current at its **first** pass and keeps
them for its life, so an answer to `ctx.ask` is never run under different
settings than it was asked under.

**History and logs.** Values over 64 characters are written cut, with a
SHA-256 of the whole (users paste tokens by mistake).

**pack 1's existing input.** `ch-local start` writes `{defaultRepo}` to
`<deviceConfigPath>/<package>.json` today (lib/start.js). Release 1
migrates it: ci-failure-triage declares `defaultRepo`, start moves an
existing value into `module.ci-failure-triage.defaultRepo` once, and the
device-config write is removed.

**More tests.** A declared default that would be slow under a pattern (now
refused at load); a hint built from a hostile name and value; setting names
`constructor`/`toString`; `ctx.settings` immutable across calls; a
re-pinned declaration across a supervised restart; a `url` outside the
grants refused on every path; another session's notice; an upgrade that
changes a default leaves an explicit value; the ceiling's three per-setting
rules; `--moduleSettings` on an HTTP server; the pack-1 migration.

### Work and estimate (replaces section 9)

| PR | Repo | What | Estimate |
|---|---|---|---|
| 1 | countinghouse | declaration (vocabulary, formats, pins, load checks), effective values on main, versioned delivery on every path, `SETTING_REQUIRED` with the call graph, `--moduleSettings` | ~3 d |
| 2 | countinghouse | the settings tool's module kind (listing, the runtime's confirmation rule, the form, notices, ceiling rules), the re-read on apply, docs | ~2.5 d |
| 3 | ch-local | `ch-local settings modules/set/reset` for `module.*` (prompted values, validation by the installed reader, keeping unknown names), the outside-edits rules, pack 1's `defaultRepo` migration, docs | ~2.5 d |

About **8–9 days**, after the sandbox release blockers.
