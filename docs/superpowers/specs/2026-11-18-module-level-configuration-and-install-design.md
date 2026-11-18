# Module-level configuration and install (release 1)

Status: draft for review, 2026-11-18. A security review follows the design
review.
Scope: countinghouse (declarations, the settings tool, credentials on the
remotes path, loading in place, the session layer), ch-local (settings,
credentials, the module store, install, upgrade, start) and the pack
repositories (pack 1's modules).
Read at countinghouse `origin/master` 116503b0 and ch-local `origin/main`
f7b1cd3. File and line references are to those commits.

This is one design for three pieces of work that share most of their code:
module settings, per-module credentials, and "a pack is only an install
bundle". It replaces:

- `2026-11-17-module-settings-design.md` (revisions 1 to 3). Its rules are
  carried here in one piece, in their revision-3 state, in section 4.
  Section 4.8 lists what the newer decisions change.
- What earlier designs say about a pack as a unit the runtime or the settings
  know: `pack.<name>` and loading by pack
  (`2026-11-14-packs-in-place-and-settings-tool-design.md`), a session's own
  packs (`2026-11-15-shared-runtime-design.md`, B3), the per-pack credential
  gate (`2026-11-11-local-mode-design.md`), and the process-wide
  `--remoteCredentials` allowance (`2026-11-11-rc1-min-remote-mcp-design.md`).

Where this document and those disagree, this one holds.

## 1. Intent

The maintainer decided the following on 2026-11-17 and 2026-11-18. This
design implements the decisions and does not reopen them.

1. **A pack is only an install bundle**: a named list of related modules
   that are installed together. After install, the runtime and ch-local deal
   in modules. A pack has no settings, no credentials and no on/off switch.
2. **All configuration lives on the module**: its settings, its credential,
   and whether it is on.
3. **Module settings** as the 2026-11-17 design's revision 3: declared by the
   module, changed by the user at a terminal or in conversation, applied live,
   persisted, one set of values per user.
4. **Credentials are per module and entered at a terminal only**:
   `ch-local credentials add <module>`, or standard input. The offer to use
   the GitHub CLI's login stays, behind a yes ("use your gh login's token for
   `<module>`? [y/N]"). A key never goes through conversation or the settings
   tool. The runtime attaches it on the existing remotes path, bound
   module → origin → variable. There is no consent screen in release 1. A new
   version of a module that declares a different origin or variable gets no
   key until `credentials add` is run again. The declaration gets a short
   form.
5. **On and off is global for the user.** The per-session pack on/off that
   has been on master since the shared runtime's B3 is dropped for release 1.
6. **The operator's ceiling names modules only.**
7. **The runtime loads, unloads and reloads modules.** A part that is not
   listed is loaded while an enabled module needs it.
8. **ch-local keeps a module store keyed by name and version.** Installing a
   pack skips the modules already installed. When an update would move a
   module that other installed modules call across a major version, ch-local
   asks [y/N], naming those modules; the default is No, and without a
   terminal or in an automatic upgrade the answer is No and the user is told.
   A minor or patch update installs without asking. After a yes every module
   still loads; ch-local warns and says how to go back. Removing the pack
   that brought the update puts the module back to its previous version,
   unless a pack installed later relied on the newer one. Settings are kept
   across both; a value the older version does not declare stays stored and
   unused. There are no declared version ranges (`requires`) in release 1.
9. **Pack 1's modules are configured as a third party's would be.** No
   path exists for them that another author could not use.
10. **Wording**: nothing outward calls a pack a unit that runs.

## 2. Terms

| Term | Meaning |
|---|---|
| module | One npm package the runtime loads: `package.json` with a `countinghouse` block, `api.json`, handlers. Its identity everywhere in this design is its **package name** (`@countinghouse/ch-access-github`). |
| top-level module | A module whose `countinghouse.role` is `scenario` or absent. It is loaded for its own sake and its tools are listed. |
| part | A module whose `countinghouse.role` is `part`. It is loaded only while a loaded top-level module's call graph needs it, and its tools are not listed (`lib/module-roles.js`). |
| closure | A scenario and, recursively, every module named before the slash in its `countinghouse.calls` and in its parts'. A module with no role is its own closure: its calls are not followed (`closureOf`, `lib/module-roles.js:106`, as today). |
| pack | A name in ch-local's release pins for a list of modules. An install-time convenience and nothing else. |
| module store | `<home>/module-store`: every installed module version, each in a directory of its own. |
| active version | The one version of a module that ch-local gives the runtime. A runtime holds one version of a module, as today. |
| available | A module that may be loaded: installed, in the running release, allowed by the ceiling, turned on, its credential usable, and every module it calls available (section 5.2). |
| short name | A package name without its scope (`ch-access-github`). ch-local's commands accept it when exactly one installed module has it. Stored names and the runtime's messages always use the full name. |

## 3. Not in scope (release 1)

- A module turned on or off, or a module setting, for one session only.
- A consent screen for credentials, and a consents file.
- Declared version ranges between modules (`countinghouse.requires`), and
  refusing a load because a called module's version is not the one the caller
  was written for. The per-hop schema check still applies: a real interface
  mismatch is an error at the call.
- A credential attached to a plain HTTP request (a REST API that is not an
  MCP server). The remotes path is the only one that carries a key.
- The network broker. A module can still open outbound connections of its
  own; `docs/security-model.md` says so, and this design does not change it.
- Installing a module that the running ch-local release does not pin. The
  store, the record and the update rule are written for packs from more than
  one source, but in release 1 every pack comes from the release's pins.
- More than one loaded version of a module.
- Per-caller settings, the settings tool and the settings command on a
  multi-tenant HTTP server (section 4.7 is what such a server gets).
- The `path` format and author-supplied patterns for settings (as the
  2026-11-17 design's revisions 2 and 3 decided).
- OAuth and refresh-token grants for a remote's credential.

## 4. Module settings

This section is the 2026-11-17 design in one piece. An implementer does not
need the older document.

### 4.1 The declaration (the module's author)

In the module's `package.json`, beside `calls` and `permissions`:

```json
"countinghouse": {
  "settings": {
    "units":       {"type": "enum", "values": ["metric", "imperial"], "default": "metric",
                    "title": "Units", "description": "Units used in forecasts."},
    "defaultRepo": {"type": "string", "format": "repo", "title": "Default repository",
                    "description": "owner/name used when a call names no repository."},
    "maxResults":  {"type": "integer", "min": 1, "max": 100, "default": 20,
                    "title": "Results per call"},
    "shareStats":  {"type": "boolean", "default": false, "confirm": true,
                    "title": "Send anonymous usage statistics",
                    "description": "Sends counts to the module author's endpoint (declared in permissions.net)."}
  }
}
```

A small closed vocabulary, not general JSON Schema:

| Field | Rules |
|---|---|
| name (the key) | `[a-z][a-zA-Z0-9_]{0,63}`, no dots. Not the name of an `Object.prototype` member (`constructor`, `toString`, `__proto__`, …). At most 32 settings per module. |
| `type` | `string`, `integer`, `number`, `boolean`, `enum`. |
| `values` | `enum` only: 1 to 64 strings, each 1 to 64 characters of `[A-Za-z0-9 _.:/@+-]`. |
| `min`, `max` | `integer`, `number`: finite bounds. |
| `maxLength` | `string`: 1 to 1024 code points (default 256). |
| `format` | `string` only, optional. One of the runtime's own checkers, each linear: `slug` (`[a-z0-9][a-z0-9-]{0,63}`), `repo` (`owner/name`, GitHub's grammar), `email`, `hostname`, `url` (parsed with WHATWG URL, https only, no user info, stored in canonical form). There is no `pattern` and no `path` in release 1. |
| `default` | Optional; must itself be valid. A setting with no default and no stored value is **unset**. An empty string is unset. |
| `required` | `true`: a call while it is unset fails `SETTING_REQUIRED` before the handler runs (section 4.6). |
| `confirm` | `true`: the author marks a setting that sends data somewhere, costs money, or acts on the user's behalf. The runtime adds its own rule on top (section 4.4). |
| `title`, `description` | Shown to the user and the agent; `title` at most 64, `description` at most 512 characters; cleaned of hidden characters at egress like every declared text. |

Rules around it:

- The whole declaration is at most 16 KiB; a module's effective values are at
  most 32 KiB.
- A module that declares settings must have an npm-grammar package name.
- A value that holds a hidden character is refused, never cleaned.
- A `hostname` or `url` value must be inside the module's granted `net`
  entries, on every path (terminal, tool, file read at load). Outside them it
  is `SETTING_OUT_OF_BOUNDS`, saying it is outside what the operator granted.
  A declared default outside a grant the operator narrowed is treated as
  unset, with a load warning; it does not refuse the load.
- `countinghouse-validate` and the load check the declaration. A bad one
  refuses the module with `SETTINGS_DECLARATION_INVALID`, by position and
  field. The validator warns on a name or title that looks like a secret
  (`password`, `token`, `secret`, `apiKey`, `credential`), warns when a part
  declares a `required` setting, and prints each setting's confirmation rule
  (on request, confirm, terminal only) so an author sees what a user will be
  asked.
- The declaration joins `calls` in the manifest pins taken at load
  (`lib/manifest-pins.js`), so a module cannot rewrite its `package.json` and
  restart under supervision to drop `confirm` or flip a default. A reload or
  an upgrade takes the new pins. Under audit the pin holds until the next
  start, as for `calls`; `docs/security-model.md` says so.
- Each format checker has a 1024-character worst-case timing test.

### 4.2 Where values live

In ch-local's `<home>/settings.json`, the same file, lock and history as
every other setting:

```json
{"version": 1, "values": {
  "requestTimeout": 30000,
  "enabled.@countinghouse/ch-pack-ci-failure-triage": false,
  "module.weather-tool.units": "imperial",
  "module.@acme/repo-helper.defaultRepo": "acme/api"
}}
```

- A module setting's name is `module.<package name>.<setting>`. A setting
  name has no dot, so the last dot splits it, whatever the package name
  holds.
- There is one set of values per user (per home). They belong to the module:
  a part that two packs list has one set.
- A value the user set is stored even when it equals today's default, so an
  upgrade that changes the default never overrides an explicit choice.
  `reset` removes the stored value, and the default then applies.
- A stored value that the module's loaded version does not accept (a removed
  setting, a narrowed enum, a tighter bound, or a setting only a newer version
  declares) is not applied. The module gets its default, or unset; a warning
  is logged once per load, and one history line records
  `{"setting", "change": "no longer valid for <version>", "kept": <old>}`.
  The value stays in the file until the user changes or resets it, so moving
  to a version that accepts it brings it back. This is the rule that keeps a
  module's settings across an update and across a rollback (section 9.5).
- Every change appends its history line first (`setting`, `old`, `new`,
  `by`). A change is never made if its line cannot be written. A value over
  64 characters is written cut, with a SHA-256 of the whole.
- Both writers keep names they do not know. Today ch-local's `setSetting`
  rewrites the file from the names it knows (`lib/settings.js`), and
  `resetSettings` removes the file; both change (section 13.2).

### 4.3 Changing a value at a terminal (ch-local)

```
ch-local settings modules                    # every installed module's settings: name, title, value, allowed values
ch-local settings modules weather-tool       # one module, with descriptions
ch-local settings set weather-tool.units imperial
ch-local settings set weather-tool.defaultRepo        # no value: prompts for it
ch-local settings reset weather-tool.units   # back to the default
ch-local settings reset weather-tool         # every setting of that module
```

- `module.` may be left out, and a short name may stand for the package
  name. The stored name is always `module.<package name>.<setting>`.
- `settings modules` lists installed modules that are not loaded too, read
  from the active version's `package.json` in the module store, so a user can
  set values before first use.
- The value is parsed by the declared type and checked with the **installed
  runtime's own reader** (as ch-local reads the ceiling), before anything is
  written. A refusal says why and lists what is allowed
  (`units is metric or imperial`).
- A `confirm: true` setting asks at the terminal
  (`Change shareStats for weather-tool from false to true? [y/N]`): no
  `--yes`, refused without a terminal, as a loosening is today
  (`lib/cli-change.js`).
- Order: validate, then persist under the settings lock (history line
  first), then apply. The running start or daemon sees the file change and
  sends its runtime `{type: 'reread', what: 'module-settings'}` on the control
  channel (section 7.3). The runtime reads the `module.*` values again,
  checks each, and applies them; a refusal there is a notice plus a
  `not applied` history line. With no runtime running, the value is read at
  the next load.
- A bare `ch-local settings reset` resets the runtime's settings and each
  `enabled.*` entry (asking first when that turns a module on, as it asks
  today for a pack) and leaves `module.*` alone.
- The outside-edits check learns the `module.*` and `enabled.*` rules, and
  compares a cut value by its SHA-256.

### 4.4 Changing a value in conversation (`countinghouse_settings`)

- **Reading.** `get` lists, for each loaded top-level module that declares
  settings, each setting's name, title, description, type, allowed values,
  default and current value, and which tool it affects. At most 64 settings
  per call, with a cursor. A part's settings are never named to the client;
  they are set at the terminal.
- **Changing.** `set` with the setting's name and value.
  - `enum`, `integer`, `number` and `boolean` settings change on request,
    unless the author marked them `confirm: true` or the ceiling says
    otherwise (section 8).
  - Every `string` setting, with or without a `format`, always needs the
    user's own confirmation. An open value can be a destination.
  - A change that needs confirmation goes through the existing confirmation
    form (elicitation for a tested client, the per-user window, the latch on
    repeated declines). The form's sentence is the runtime's: the package and
    its version, the setting's key, the old and new values in quotes (each cut
    to 200 characters, with "(cut)"), and the author's `title` labelled as the
    module's own words. No agent or author text is offered as the runtime's.
  - The list of tested clients is empty at release, so in practice a change
    that needs confirmation ends at the terminal, and the hint says so:
    "this change needs your confirmation; run
    `ch-local settings set <module>.<setting>` at a terminal".
  - Every hint the runtime gives names the setting and **never carries a
    value**.
- **Who it applies to.** Every session of the user. Each other session is
  told once, by a notice on that module's next result there. A shared
  runtime's `scope` argument is not needed for a module setting; given as
  `all-sessions` it means the same.
- **Budget.** On-request changes count against the session's existing
  budget of 32 recorded changes.
- **Order.** As at the terminal: the tool writes under the lock (history
  first), then the runtime applies.
- A module never changes its own settings. The settings tool is a built-in
  served to the client, not a module a hop can address, and stays unreachable
  from module code (a test pins it). `ctx.settings` is read-only.

All module-setting forms are one confirmation kind, `module` (section 5.4
lists the kinds).

### 4.5 How the module reads them

`ctx.settings` is a frozen, null-prototype object of the effective values
for this call: the declared defaults, then the stored values, then the
ceiling's fixed values. An unset setting is absent.

```js
module.exports = async function forecast(input, ctx) {
  const units = ctx.settings.units;                       // 'imperial'
  const repo  = input.repo || ctx.settings.defaultRepo;
  if (repo == null) return ctx.settingRequired('defaultRepo');   // section 4.6
};
```

- A change applies from the next call. A call in flight keeps the values it
  started with.
- The main thread keeps each module's effective values and numbers them with
  a version. The invoke message carries only the version; a worker that has
  not seen that version gets the values once, in the same message, and keeps
  the last 4 versions per module. A module with no declared settings carries
  nothing.
- The snapshot is attached on every path: a client call, a routed hop, a job
  run, single-thread mode, per-session workers. On a direct peer channel it
  rides the main thread's metering reply to the callee, never the caller's
  announcement.
- A task reads the values current at its first pass and keeps them for its
  life (held on the main thread), so an answer to `ctx.ask` is never run
  under other settings than it was asked under. A repeating schedule reads
  the current values at each run.

### 4.6 A missing setting

**Declared `required`.** A call to a module with an unset `required` setting
fails before the handler runs with `SETTING_REQUIRED`, not billed. It is
checked for the whole declared call graph before the outer call runs, so a
top-level module never swallows a part's missing setting. The message:

> weather-tool needs a setting: defaultRepo (Default repository). Ask the
> user for the value (do not guess), then set it, or run
> `ch-local settings set weather-tool.defaultRepo`.

The error's `_meta` carries the setting names (`missingSettings`). For a
part, whose settings are never named to the client, the message says only
that a module this tool calls needs a setting made at the terminal: "run
`ch-local settings modules <the top-level module>`".

**Needed only as a fallback.** Most settings are a default for an input
(`repo`, `region`). Such a setting cannot be `required`, because the
pre-handler check would refuse a call that names the value itself. For
these, the handler returns `ctx.settingRequired('<name>')`:

- It answers the same `SETTING_REQUIRED`, in the runtime's words, with
  `missingSettings`.
- The main thread builds the message from its own pinned declaration. It
  accepts the claim only when the named setting is declared by that module
  and is unset in the snapshot the call ran with. Any other claim is answered
  as a module fault (`DEVICE_INVOKE_EXCEPTION`), so a module cannot use it to
  put text in the runtime's voice.
- The call ran, so it is metered as any call whose handler returned an error.

This function is the one addition to the 2026-11-17 design. It exists so
that pack 1 needs no special case (section 4.8, item 3).

### 4.7 A multi-tenant HTTP server

`--settingsFile` stays single-identity only. A server outside that profile
takes `--moduleSettings <file>` (`{"<package>": {"<setting>": value}}`), read
at each module load and reload, checked the same way, never written by the
runtime, and refused to modules like the policy file. A required setting the
file leaves unset refuses that module's load with an operator-facing reason;
tenants never see a ch-local hint. There is no tool and no command there in
release 1.

### 4.8 What differs from the 2026-11-17 design's revision 3

1. `pack.<name>` is gone. On and off is `enabled.<package name>` (section 5).
2. The settings tool lists each loaded top-level module, not "the session's
   listed modules and its packs' scenarios": no session has a view of its own.
3. Revision 3's item 1 is reversed. ch-local's start no longer derives
   `defaultRepo` from the working directory and no longer writes a device
   config (`lib/start.js:523`). ci-failure-triage declares `defaultRepo`
   (format `repo`), takes the repository from the call's input first, falls
   back to the setting, and returns `ctx.settingRequired('defaultRepo')` with
   neither. Its tool description tells the agent to pass the repository of
   the project it is working in.
4. The per-session layer is a wire contract for the two caps only. Pack rows
   are removed from it (section 5.4).
5. The confirmation kinds become `maxOutputBytes`, `requestTimeout`,
   `enabled`, `module`. Revision 3 added `module`; this design also replaces
   `pack` with `enabled`, in the same change.
6. "An untrusted ceiling loads no pack" reads "no module".
7. A credential is no longer "the pack-2 credentials work": it is section 6.
8. `ctx.settingRequired` (section 4.6).

## 5. On and off

### 5.1 The setting

`enabled.<package name>` in `settings.json`: a boolean, default on.

- Grammar: `^enabled\.((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)$`,
  the package name at most 214 characters. It replaces `PACK` and
  `PACK_ENTRY` in countinghouse `lib/settings-tool.js:57-62` and ch-local
  `lib/settings.js:52-54`, with the same entry: on/off, default on, guarding,
  applies now, and "off" is the tighter value.
- It exists for every installed module, parts included. A part's entry is
  set at a terminal only and is never named to a client.
- It is a name of its own, not `module.<package>.enabled`, for two reasons.
  A package name may hold dots, so `module.a.b` could not be told apart from
  module `a`'s setting `b`. And the two follow different rules: on/off is a
  guarding setting bound by the ceiling's allowlist and confirmed as a
  loosening; a module setting is data the module reads.

### 5.2 What loads

ch-local decides what the runtime loads, at start and while it runs. One
rule, applied per module:

A module is **available** when all of these hold. The first that fails is
the reason given to the user.

1. Its active version is in the module store.
2. The running release lists it (it is not withdrawn; section 9.7).
3. The operator's ceiling allows it (section 8).
4. `enabled.<module>` is not off.
5. Each credential it declares has a usable stored binding (section 6.7).
6. Every module in its closure is available.

Then:

- Every available top-level module is loaded, and its tools are listed.
- A part is loaded exactly while some loaded module's closure holds it.
  Nothing else loads a part, and a part no loaded module needs is unloaded.
- A module that is not available is not loaded. Each session is told once,
  in words the agent can pass on whole, with the command that fixes it
  (section 11).

A top-level module that another top-level module also calls is loaded once
and stays listed while it is itself available. Turned off, it is not
available, so the module that calls it is not loaded either, and the user is
told which and why. This is the fail-closed reading of "off": nothing of a
module the user turned off runs.

### 5.3 Changing it

**At a terminal:** `ch-local settings set enabled.<module> on|off`.

- Off is a tightening: made at once.
- On is a loosening: bound by the ceiling's `modules` list, and asked at the
  terminal ("Loosen enabled.weather-tool from off to on? … [y/N]"), with no
  `--yes`, refused without a terminal. This is `lib/cli-change.js` as it is.

**In conversation** (`countinghouse_settings`):

- `get` lists one `enabled.<module>` row for each installed top-level
  module: value, default, whether it is loaded, its version, and its listed
  tools. The tool reads the installed modules from ch-local's record beside
  the settings file (section 9.2), as it reads `packs.json` for a pack's
  version today (`packVersion`, `lib/settings-tool.js:367`).
- `set … off` is made on request: written to `settings.json` under the lock
  (history first). ch-local's running start or daemon sees the change and
  unloads the module; every session of the user is told.
- `set … on` needs the user's confirmation, like any loosening that
  conversation may ask for. The form (kind `enabled`) is the runtime's
  sentence:

  > en: Turn on {module} {version} in countinghouse for all your sessions? It
  > stays on, now and after a restart, until it is turned off.
  >
  > zh: 要在 countinghouse 中为你的所有会话启用模块 {module}（{version}）吗？
  > 启用后一直有效，重启后仍然有效，直到被关闭。

  After a yes the tool writes `enabled.<module>: true` under the lock, with
  the version confirmed in the history line. If the installed version is no
  longer the one the form named, nothing is written
  (`SETTING_CHANGED_MEANWHILE`). ch-local then loads the module and tells
  the sessions the result ("weather-tool turned on 1.2.0", or why it could
  not be loaded).
- The ceiling binds it as it binds any conversational loosening: a module
  not on its list is `SETTING_FORBIDDEN_BY_CEILING`, and a ceiling that says
  `"conversation": false`, or that cannot be trusted, means no form.
- With no tested client (the state at release), `set … on` answers
  `SETTING_NEEDS_CONFIRMATION` with the terminal command.
- A part's name answers `SETTING_UNKNOWN`, as a name that does not exist.

There is no "on for this start only" and no "on for this session only". The
runtime's `load-pack` and `unload-pack` asks to ch-local, `packsThisStart`,
and ch-local's `thisStart`, `confirmed`, `loadPack` and `unloadPack`
(`lib/in-place.js:76-78, 358-434`) are removed: a confirmed "on" is a stored
value, and the load follows from the file, on the same path as a terminal
change.

### 5.4 What goes with per-session on/off

On master a shared runtime's session can list or hide a pack for itself
(`lib/session-packs.js`, B3). All of it goes:

| Area | Today | After |
|---|---|---|
| `lib/session-packs.js` | Which packs each session lists; per-pack sets, joins, last-out unload, `loadFor`. | Deleted. Replaced by the small global set of section 5.5. |
| `lib/session-settings.js` | Overrides for the two caps and for `pack.<n>` (`PACK`, `packOverridesOf`, `dropPack`, `packOnAllowed`, the pack branch of `effective` and `isLoosening`). | The two caps only. |
| `lib/session-state.js`, `lib/session-transport/restore.js` | A session's exported state and the daemon's restore rows carry pack overrides (`{name: 'pack.<n>', value, version}`) and the kind `pack`. | Override rows are caps only; a row naming `pack.*` is refused like any unknown name. Kinds are `maxOutputBytes`, `requestTimeout`, `enabled`, `module`. The override's key set stays `{name, value, loosening, over, version}` with `version` always null, so the row shape on the wire does not change. |
| `lib/settings-confirm.js` | `kindOf`: every `pack.<n>` is the kind `pack`; `KINDS` (line 58). | `enabled.*` is the kind `enabled`, `module.*` the kind `module`. `lockAll` covers all four. |
| `lib/sessions.js`, `lib/job-sessions.js` | A session's end keeps its turned-off packs for its jobs (`packsOffOf`, `sessionEnded({packsOff})`, `packsOffFor`). | Removed. A job runs against what is loaded when it runs. |
| `lib/settings-tool.js` | `setForSession` and the session confirm path take `pack.<n>` (lines 880, 920-924, 1149-1226); `get` adds a session's own pack rows (660-662). | `enabled.*` is never a session's own. In a shared runtime it is handled as an all-sessions change (`setForAll`'s path: no form for off, the form for on). |
| `lib/pack-control.js` | `pack` and `global` on load and reload; the audience of a notice; `set pack.<n> true`. | Section 7.3. A notice about a module goes to every open session. |
| ch-local `lib/session-table.js` | `KINDS` and `PACK` override rows; `seed` drops a pack turned on. | The new kinds; no pack rows (migration: section 10). |
| The ~15 readers of a session's view | `filterTargetsBySession`, `sessionLists` (`lib/mcp/tool-registry.js:687-692`), `lib/mcp/gateway.js:1419`, `lib/mcp/prompts.js:47-56`, `lib/mcp/resources.js:96-99`, `lib/mcp/subscriptions.js`, `lib/device-manager.js:518, 599, 1878, 1891, 2152`, `lib/peer-channel-broker.js:243, 307, 412, 663`, `lib/module-manager.js:1852` (`sessionViewChanged`), `lib/route-manager.js:156, 343-373`. | Each asks the global set of section 5.5 instead, with no session argument. `sessionViewChanged` stops a per-session worker of a hidden module for every session. |

### 5.5 A module that is going on or off is hidden

Without a session view, a module is visible exactly while it is loaded. Two
windows need a guard, and today's session view provides it (a pack loading,
unloading, or one whose unload failed is listed to no one):

- **While a top-level module and its parts load.** The top-level module
  registers first; listed at once, its tool could be called before its parts
  are there.
- **From the start of an unload, and after one that failed.** A module the
  user turned off must not be callable because its worker is slow to end.

`lib/module-visibility.js` (new, main thread only) holds one set of module
names that are hidden:

```
hide(names)          // the modules a load newly brings in; the modules an unload takes away
show(names)          // when that load has completed
gone(names)          // when that unload has completed; a failed one stays hidden
listsModule(name) / listsDevice(deviceID) / none() / onChange(fn)
```

A hidden module is in no tools, prompts or resources list, and a call, a
hop, a direct peer channel or a job run that reaches it is refused
`MODULE_NOT_LISTED`. `none()` is true when the set is empty, which is the
case on every call's path outside a load or unload, so the check costs one
boolean, as `sessionPacks.none()` does today. A part stays unlisted by
`mm.unlisted`, as today; a hop to an unlisted part is allowed, a hop to a
hidden one is not.

A module is **listed** while it is loaded as a top-level module in its own
right. One that is loaded only because another module calls it is unlisted.
`mm.unlisted` is recomputed from the load records on every load and unload
(today it is set only for the modules a load newly brings in).

## 6. Credentials

### 6.1 The declaration (the module's author)

A module declares its remote MCP server in `countinghouse.remotes`, as today
(`lib/remote/declaration.js`). Two things are added:

- `transport` defaults to `"streamable-http"` (today it is required and must
  be that value, line 185).
- `credential` may be a string. `"credential": "GITHUB_TOKEN"` means
  `{"env": "GITHUB_TOKEN", "header": "Authorization", "scheme": "Bearer"}`.
  The object form stays, with `header` and `scheme` defaulting as today.

The shortest declaration:

```json
"countinghouse": {
  "remotes": [
    {"name": "github", "url": "https://api.githubcopilot.com/mcp/", "credential": "GITHUB_TOKEN"}
  ]
}
```

The load keeps the expanded form; nothing downstream sees the short one.
`countinghouse-validate` prints the expanded form for every remote, and what
it means:

```
remote github: {"name":"github","transport":"streamable-http","url":"https://api.githubcopilot.com/mcp/","credential":{"env":"GITHUB_TOKEN","header":"Authorization","scheme":"Bearer"}}
  sends the credential GITHUB_TOKEN to https://api.githubcopilot.com as "Authorization: Bearer <value>"
```

When the declaration is wrong, the problem's fix line shows the short form
filled in with what the author wrote (the name and URL, when they parsed).
The validator's plain output is asserted byte for byte by its tests
(`bin/countinghouse-validate.js`), so the new lines and the new `remotes`
field of `--json` come with those tests updated.

A credential's identity is (module, variable). Its destination is the
origin of that module's declared URL. One remote per module stays the limit
in release 1, so a module has at most one credential.

### 6.2 Entering one (ch-local)

```
ch-local credentials add <module>      # at a terminal, or the value on standard input
ch-local credentials list
ch-local credentials remove <module>
```

`add`, at a terminal:

```
$ ch-local credentials add ch-access-github
ch-access-github 0.2.0 declares one credential:
  GITHUB_TOKEN, sent to https://api.githubcopilot.com (its remote "github")
Use your gh login's token for ch-access-github? [y/N] n
GITHUB_TOKEN for ch-access-github (input hidden):
stored for ch-access-github: GITHUB_TOKEN, sent to https://api.githubcopilot.com; readable by this user only
```

- The module must be installed and must declare a credential. `add` reads
  the declaration from the active version in the module store, shows the
  variable and the origin, and only then asks for the value. What the user
  sees before typing is where the key will go.
- **The gh offer.** Asked only at a terminal, only when gh has a login, and
  only when the declared origin is one of GitHub's own API origins
  (section 6.8). The default is No. A yes stores no value: the binding
  records the source `gh`, and each start asks `gh auth token` and holds the
  token in memory, as today (`lib/github-token.js` `ghToken`).
- **The typed value** is read with nothing echoed (`lib/hidden-input.js`).
- **Standard input.** When standard input is not a terminal, `add` reads the
  value from it: one line, at most 4096 bytes, the line ending removed. There
  is no gh offer and no question on this path.
  `gh auth token | ch-local credentials add ch-access-github` works, and so
  does a CI job that pipes a secret. (Today a pipe is refused,
  `lib/credentials-command.js:87`; the decision changes that.) A value is
  still never taken from an argument or from the environment.
- A value is 8 to 4096 visible ASCII characters with no space
  (`[\x21-\x7e]`), so that it is a safe header value. Today's grammar,
  letters, digits and `_` (`lib/credential-store.js:39`), fits GitHub's
  tokens only.
- The value is never printed, logged or recorded. An argument that is not an
  installed module's name is never shown back (a token typed in its place
  would be printed), as today.
- The same checks of the store's directory and file run before anything is
  typed.
- `add` for a module that already has a binding replaces it. When the stored
  binding is for another origin or variable, `add` says so before it asks
  ("the stored credential for ch-access-github is for
  https://api.githubcopilot.com; this version sends it to
  https://api.example.com"). The value is always entered again, or the gh
  offer answered again; a stored value is never moved to a new destination
  by itself.
- `list` shows, per binding: the module, the variable, the origin, the
  source (`stored` or `gh login`), and whether the installed version still
  declares that destination. Never a value.
- `remove <module>` removes the module's bindings.
- `add` and `remove` ask a running daemon to restart its runtime (it drains
  first), and say that a session on a runtime of its own takes the change at
  its next start. This is today's behaviour.
- Each is one history line: `{by: 'credentials', module, variable, origin,
  source, change: 'added' | 'replaced' | 'removed'}`.

At the end of `install` and `add-pack`, for each installed module that
declares a credential and has no usable binding: at a terminal ch-local runs
the same `add` conversation for it (the gh offer first where it applies, and
an empty answer skips it); without a terminal it prints
"`<module>` needs a credential: run `ch-local credentials add <module>`".

### 6.3 The store

`<home>/credentials/credentials.json`, with the directory and file checks it
has today (`lib/credential-store.js`: this user's alone, never repaired,
written through an exclusive temporary file):

```json
{"v": 2,
 "modules": {
   "@countinghouse/ch-access-github": {
     "GITHUB_TOKEN": {"origin": "https://api.githubcopilot.com", "source": "gh"}
   },
   "@acme/tracker-access": {
     "TRACKER_KEY": {"origin": "https://api.tracker.example", "source": "stored", "value": "…"}
   }
 }}
```

- Keys: the module's package name, then the variable.
- An entry is exactly `{origin, source: "gh"}` or
  `{origin, source: "stored", value}`. `origin` is an https origin, as the
  runtime reads a declaration's.
- At most 64 entries in all; the file is at most 512 KiB (today 64 KiB,
  for shorter values).
- A file that is not of this form is refused, naming the entry and never a
  value.

The entry is the binding: this value, for this module's credential of this
name, to this origin. Nothing else in ch-local says where a key may go.

### 6.4 What a start gives its runtime

For each module the start will load that declares a credential
(section 6.7 has decided it is usable):

1. The value: the stored one, or for `gh` the answer of
   `gh auth token --hostname github.com`, asked once per start, in the home,
   with gh's own token variables removed from its environment, as today.
2. A slot: an environment variable named by ch-local (`CH_CREDENTIAL_1`,
   `CH_CREDENTIAL_2`, …) in the runtime's environment, holding the value. No
   value is written to disk by a start.
3. A line in the remote credentials file, in the start's run directory:

```json
{"version": 2,
 "modules": {
   "@countinghouse/ch-access-github": {
     "https://api.githubcopilot.com": {"GITHUB_TOKEN": "CH_CREDENTIAL_1"}
   }
 }}
```

Read: for the module `@countinghouse/ch-access-github`, to the origin
`https://api.githubcopilot.com`, the credential it calls `GITHUB_TOKEN` is in
the environment variable `CH_CREDENTIAL_1`.

The slots exist because two modules may declare the same variable name and
hold different values; the process environment has one value per name.

A module loaded in place (section 7) gets the same: its line in a file named
in the load message, and its slot. The runtime's environment is fixed when
it starts, so a module whose value was not given at the start cannot be
loaded with its key in place. ch-local then says
"`<module>` needs a credential the running runtime was not started with;
restart your client to load it", as it does today for a pack
(`lib/in-place.js:98`), and the daemon's shared runtime is restarted by
`credentials add` itself.

Under an acceptance run's origin map (`CH_LOCAL_REMOTE_MAP`), only a value
that is an acceptance token (`chacc_…`) is given, as today.

### 6.5 The runtime's side

`--remoteCredentials <file>` takes two forms (`lib/remote/credentials.js`
`loadAllowance`):

- **Version 2** (above): `{"version": 2, "modules": {"<package>": {"<origin>":
  {"<VARIABLE>": "<ENVIRONMENT NAME>"}}}}`. A list of variables
  (`["GITHUB_TOKEN"]`) is accepted in place of the inner object and means
  each is read from the environment variable of the same name, which is what
  an operator of an HTTP server writes by hand. Package names follow npm's
  grammar; an origin is checked as today (scheme, host and port, https, or
  http to loopback); both names match the variable grammar. Anything else
  refuses the file.
- **Version 1** (today's `{"<origin>": ["VARIABLE", …]}`) keeps its meaning:
  process-wide, read from the variable of that name, not bound to a module.
  It remains for an operator's own server. ch-local never writes it.

What changes in the runtime:

- The allowance is kept **per module**: `Map(module → Map(origin →
  Map(variable → environment name)))`. It replaces `packRemotes`
  (`lib/module-manager.js:668`, per module and per pack, merged). It is set
  from the start's file and, for a module loaded or reloaded in place, from
  the file its message names; a module's entry is removed when the module is
  unloaded.
- `register` (`lib/remote/index.js:82`) resolves a module's credential
  against that module's own entry: the declared variable (then
  `fallbackEnv`) must be named there for the declared origin, and the value
  is read from the environment name beside it. Under a version 1 file every
  module gets the process's allowance, as today.
- Everything else on the remotes path is as it is: the value is read and
  attached on the main thread, to the exact origin, on a client of the
  runtime's own with no proxy and no cross-origin redirect; a module's worker
  never sees it.
- A module's remotes are read from disk again at every spawn (the manifest
  pin covers `calls` only). So the check is made again at a supervised
  restart: a module that rewrote its own declaration gets nothing for the new
  destination.
- `credentialVariables` (`lib/route-manager.js:70`), which decides the names
  a shared runtime will compare a session's credential against, reads the
  version 1 allowance only. Under a version 2 file there is no name a
  session's environment can supply (section 6.9), so every name counts as
  one the runtime lacks.

A remote whose credential cannot be resolved is disabled, with one of:

| Case | Code | Message (fields filled by the runtime) |
|---|---|---|
| The file names the module, but for another origin or variable | `REMOTE_CREDENTIAL_NOT_ALLOWED` | "{module} {version} sends its credential {variable} somewhere new ({origin}); it gets no key until that is allowed" + the hint |
| The file does not name the module | `REMOTE_CREDENTIAL_NOT_ALLOWED` | "no credential is bound to {module} for {origin}" + the hint |
| Allowed, and the environment name holds nothing | `REMOTE_CREDENTIAL_MISSING` | as today |

The hint is ": run `ch-local credentials add {module}` at a terminal" on a
runtime started by ch-local (single identity, with a control channel), and
": the operator binds it in the --remoteCredentials file" otherwise. A
tenant of an HTTP server never sees a ch-local command.

On a runtime with a control channel, a module whose remote is disabled is
not loaded: the load is refused with that code (today's rule for a module a
pack loads in place, `lib/module-manager.js:694`). On an operator's server
the module loads and the remote answers the code at each call, as today.

### 6.6 A new origin or a new variable

The supply-chain guard, with no hand-written list: **a stored key is used
only for the module, the variable and the origin it was entered for.**

- A new version of a module that declares another origin, or another
  variable, has no usable binding. ch-local does not load it (section 6.7)
  and tells the user: "ch-access-github 0.3.0 sends its credential somewhere
  new (https://api.example.com; the stored one is for
  https://api.githubcopilot.com). It gets no key, and is not loaded, until
  you run `ch-local credentials add ch-access-github` again".
- Running `add` again is the user's yes: it shows the new destination and
  takes the value again (section 6.2).
- Nothing else re-binds. An upgrade's yes does not. An automatic upgrade
  does not. A setting does not. Conversation cannot.
- The runtime enforces the same rule by itself (section 6.5), from the file
  ch-local wrote out of the store, so the guard does not depend on ch-local
  having noticed the change.
- An automatic upgrade does not take a release that changes where an
  installed module's credential goes: it is announced and left to
  `ch-local upgrade`, as a release that adds an origin is today
  (`additions`, `lib/release-pins.js:140`; section 9.3 keeps the data it
  reads). `ch-local upgrade` shows the change before its question.

### 6.7 The gate (ch-local)

Per module, replacing the per-pack gate (`loadablePacks`,
`lib/packs.js:92`; `lib/start.js:460-474`). A module's credential is
**usable** when the store holds a binding for (module, the declared
variable) whose origin is the declared origin, and, for the source `gh`,
gh gave a token at this start. Otherwise the module is not available
(section 5.2), with one of these reasons:

| State | Told |
|---|---|
| No binding | "not loading {module}: it needs a credential ({variable}, sent to {origin}): run `ch-local credentials add {module}`" |
| A binding for another origin or variable | the sentence of section 6.6 |
| Source `gh`, and gh gave no token | "not loading {module}: your gh login gave no token ({why}): run `gh auth login`, or `ch-local credentials add {module}`" |
| The store fails its checks | "not loading {module}: the stored credentials are not used ({problem})" |

A module that calls it is not loaded either, and says which module and why
("not loading ch-pack-ci-failure-triage: it calls ch-access-github, which
needs a credential: run `ch-local credentials add ch-access-github`").
With nothing loadable the runtime still starts and serves its own tools, as
today.

### 6.8 Which origins get the gh offer

The gh login is a GitHub credential. Offering it for any origin a module
declares would hand the user's GitHub token to that origin on a reflexive
"y". So the offer is made only for GitHub's own API origins, a fixed list in
ch-local:

```
https://api.githubcopilot.com
https://api.github.com
```

This is not a list of where credentials may go. Any module may declare any
https origin, and the user may enter a key for it. The list only decides
when ch-local offers the gh login instead of asking for a value, and the
question still names the module and the origin.

### 6.9 What goes

- The built-in credential name `github` and its two variables (`NAMES`,
  `COVERS`, `lib/credentials-command.js:26-29`), and `--module`.
- ch-local's hand-written origin list: `allowedOrigins` in
  `lib/release-pins.json`, `ALLOWED_ORIGINS` (`lib/allowlist.js`),
  `credentialUnion` (`lib/packs.js:76`), `GITHUB_VARIABLES` and
  `chooseCredentials` (`lib/start.js:41, 227`), and the start's refusal
  "a pack would send a credential somewhere not allowed" (line 504): the
  per-module binding replaces them.
- Each pack's `credentials` list in the release pins. Section 9.3 has what
  the pins carry instead.
- The automatic gh lookup with no question (`chooseGitHubToken`'s third
  step). gh's token is used only for a binding whose source is `gh`.
- **A credential taken from a client's environment** (today the first and
  the last choice for the GitHub token: `COUNTINGHOUSE_GITHUB_TOKEN`, then
  `GITHUB_TOKEN`; and any pack credential a client's environment sets). An
  environment variable cannot be bound to a module: with the origin list
  gone, any module that declared `GITHUB_TOKEN` and its own URL would receive
  the user's exported token. The decisions say a key is entered at a
  terminal or on standard input, and name no environment route, so this
  design removes it. It is open question 1 (section 17), because it removes
  a documented path. What removing it touches:
  - `lib/start.js:364-403` and `lib/github-token.js` `chooseGitHubToken`;
  - `lib/conditions-command.js`: `chosenToken` and `chosenCredentials` go;
    the line it prints always has `"token": null` and no `credentials`. The
    shim, the frames and the runtime's comparison stay as they are, and
    simply never find a difference, so every session can share;
  - `lib/snippets.js` (the variables a Codex entry forwards) and the install
    documents;
  - the shared vectors' `githubTokenPrecedence` cases.

## 7. Loading modules in place

### 7.1 The unit and its record

`lib/packs-in-place.js` becomes `lib/modules-in-place.js`. Most of it stays:
the same checks as at start, one operation at a time, drain then switch, a
reload that switches all of its modules or none, records made at load and
never re-read from disk for an unload.

- The unit a request names is a **top-level module**. Today it is "a
  scenario and its parts, named by the scenario's package name", so for a
  scenario nothing changes; a module with no role is a unit of one.
- The record, per loaded top-level module: `{dir, modules: Map(name →
  {path, version}), tools, prompts}` in `mm.loadedUnits` (today
  `mm.packsInPlace`, which also holds `pack` and `allowance`; both go). It is
  seeded from what the runtime was started with (`mm.startPlan`), as today.
- **Ref-counting** is what `heldElsewhere` already does: a part is unloaded
  when no remaining record holds it, and a load skips a part that is loaded.
- **One version**: a load whose closure holds a part that is loaded at
  another version is refused `PART_VERSION_CONFLICT`, as today. ch-local
  never asks for that (it gives one active version per module); the check is
  the backstop.
- The modules a load newly brings in are hidden until the load has
  completed, and the modules an unload takes away (those no other record
  holds) are hidden from its start (section 5.5). A part that another loaded
  module holds is never hidden by someone else's load or unload. A module a
  reload switches is not hidden: calls to it wait for the new version, as
  today. `loading()` and `loaded_()` call `hide`, `show` and `gone` where
  they call `sessionPacks.packChanged` today.
- The name grammar (`PACK_NAME`, line 57) becomes npm's package grammar.

### 7.2 Where a module's directory comes from

Today a part is found from the scenario's own directory, on Node's search
path (`resolvePart`, `lib/module-roles.js:44`), because a pack's modules
share one `node_modules`. In the module store every version has a directory
of its own, so ch-local says where each module is.

- `--modulesRoot <dir>` replaces `--packsRoot`: every module a start or a
  control request names must lie, by real path, inside it, with no link
  leading out (`insideRoots` and `linkOut`, unchanged). ch-local passes
  `<home>/module-store`.
- At start: `--loadModule <dir>` for each top-level module, as today, and
  `--partDir <dir>` (new, repeatable) for each part's directory.
- In a control request: `dirs`, the directory of each module of the closure.
- `expandLoadList` and `closureOf` take the given directories and resolve a
  called module among them first, by the module's own `api.json` friendly
  name, as `resolvePart` matches today. The runtime reads each directory's
  own `package.json`; a name in the request that is not the package's is
  refused. Two given directories that hold the same module are refused.
- Node's search path from the caller's directory stays as the fallback, for a
  developer who loads a checkout with `--loadModule`. ch-local never relies
  on it.
- A called module that is found nowhere is `PART_MISSING`, as today.

### 7.3 Control messages

ch-local to the runtime, on the control channel (`lib/control-channel.js`;
`lib/pack-control.js` becomes `lib/module-control.js`):

```
{id, type: 'load',   name: '<top-level package>', dirs: {'<package>': '<absolute dir>', …},
                     remoteCredentials?: '<absolute file>', notice?: '<text>'}
{id, type: 'reload', names: ['<top-level package>', …], dirs: {…},
                     remoteCredentials?: '<absolute file>', notice?: '<text>'}
{id, type: 'unload', name: '<top-level package>', notice?: '<text>'}
{id, type: 'reread', what: 'module-settings'}
{id, type: 'notice', module: '<package>' | null, text: '<text>'}
{id, type: 'set', name, value}                       // the runtime's own settings, as today
```

Replies are as today: `{id, ok: true, tools: […]}` for load, reload and
unload; `{id, ok: false, code, message}` otherwise.

- **load**: loads the modules of the closure that are not loaded, the
  top-level module listed, the others unlisted. Refused when the name is
  loaded already, when a directory is outside `--modulesRoot`, on
  `PART_MISSING`, `PART_VERSION_CONFLICT`, a tool or prompt name already
  taken, or when the ceiling does not allow a module of the closure
  (section 8). A failure part-way unloads what the request loaded.
- **reload**: brings the named loaded top-level modules, and their closures,
  to the directories given. It is today's `reloadPack`, over the union of
  the named modules' closures instead of one pack's:
  - a module at the same version stays as it is;
  - a module at another version is drained, then switched;
  - a module the new closures add is loaded; one they no longer hold, and no
    other record holds, is unloaded after every switch has succeeded;
  - all or none: a failure switches back what was switched and unloads what
    was added (`CONTROL_PACK_UNCERTAIN`, renamed `CONTROL_MODULE_UNCERTAIN`,
    when that fails too);
  - **a part changes version only when every loaded top-level module that
    holds it is named in the same request.** Otherwise the request is refused
    `PART_VERSION_CONFLICT`. This is what lets a module two packs list move
    to another version in place, which today's per-pack reload cannot do
    (it is refused, and ch-local falls back to a reinstall).
- **unload**: unloads the named top-level module and each of its modules no
  other record holds. Never refused by the ceiling.
- **reread**: the runtime reads the `module.*` values of `--settingsFile`
  again, checks each against its module's declaration and the ceiling, and
  applies them. The reply lists what was refused: `{applied: <count>,
  refused: [{name, code}]}`.
- **notice**: said once to every open session, on the next result of that
  module's tools (or of any tool, for `null` or a module no longer loaded).

Removed:

- `scenario`, `pack` and `global` on load and reload, and the rule that a
  shared runtime sets a pack's "global" value from the message.
- `set pack.<n> true`.
- The runtime's asks `load-pack` and `unload-pack`. `may-elicit` stays.

`TYPES` (`lib/control-channel.js:21`) gains `reread`. Operations stay
serialised on the channel's one chain.

### 7.4 What a session is told

Every change to what is loaded is said, as today (`lib/notices.js`):

- loaded, reloaded (with the versions), unloaded, turned on, turned off: the
  text ch-local sends with the request;
- on a shared runtime, to every open session, once. There is no audience to
  work out. A session that opens later is not told about earlier changes;
- a module's settings changed by another session (section 4.4).

### 7.5 The shared wire vectors

`docs/superpowers/specs/shared-runtime-wire/vectors.json` (and
`make-vectors.js`, which generates it) change in these places:

| Entry | Change |
|---|---|
| `packMessages` | Replaced by `moduleMessages`: the shapes of section 7.3, a package-name pattern, accepted cases (a load, a reload of two names that share a part, an unload, a reread, a notice with and without a module) and refused ones (no `dirs`, a directory that is not absolute, a name that is not a package name, `names` empty, a leftover `pack` or `global` field). |
| `restoreRows` | Kinds are `maxOutputBytes`, `requestTimeout`, `enabled`, `module`. The accepted rows that carry a `pack.*` override or the kind `pack` move to the refused list. |
| `control.record`, `control.replay` | Unchanged (a session's replay holds the two caps only, `lib/sessions.js:104`). |
| `githubTokenPrecedence` | Rewritten for section 6: the stored binding and the gh source only. If open question 1 keeps the environment route, the cases stay and gain the binding. |
| `credentialMac`, `credentialsMalformed`, `control.clientCredentials`, `ownRuntimeToken`, `ownRuntimeCredential` | Unchanged: the frames stay valid; ch-local stops sending the fields. |

The contract number stays 2: no frame between the shim and the runtime
changes. ch-local's copies (`shim/tests/vectors/contract-2.json`,
`test/vectors/*.json`) are refreshed in the ch-local change that follows
each edit; the shim's code does not change.

## 8. The operator's ceiling

The file (`lib/settings-ceiling.js`), after this design:

```json
{"version": 1,
 "maxOutputBytes": 33554432,
 "requestTimeout": 60000,
 "forbid": ["moduleSandbox"],
 "conversation": true,
 "modules": ["@countinghouse/ch-pack-ci-failure-triage", "@countinghouse/ch-access-github"],
 "moduleSettings": {
   "@acme/weather-tool.shareStats": {"fixed": false},
   "@acme/weather-tool.units": {"confirm": true},
   "@acme/repo-helper.defaultRepo": {"conversation": false}
 }}
```

- **`modules`** replaces `packs`. When present, only the modules it names
  ever load, whatever `settings.json` says. It names every module, parts
  included, by package name. Absent, no module is restricted.
  - A module not on the list is not available (section 5.2), and neither is
    a module that calls it.
  - `install` and `add-pack` check every module of the pack before anything
    is fetched. One missing refuses the pack whole and names the modules:
    "the pack "ci-failure-triage" is not allowed on this machine: its modules
    ch-step-redact, ch-step-report are not on the operator's list; nothing
    was installed".
  - In place, the runtime checks every module of a load's or reload's closure
    by its package name, read from the directory it loads
    (`ceilingRefusal`; `chLocalPackOf`, which read the pack from the path,
    goes). A module not listed is `SETTING_FORBIDDEN_BY_CEILING`, naming
    `enabled.<module>`.
- **`packs` is no longer a key.** A ceiling that still holds it is not
  trusted, as any unknown key makes it today, with the problem text
  "it holds "packs", which is no longer read: list each module under
  "modules"". Under a ceiling that is not trusted no module loads, which is
  today's rule for packs. An operator must rewrite the file; the upgrade
  notes say so.
- **`moduleSettings`** (from the 2026-11-17 design): per
  `<package>.<setting>`, one of `{"fixed": <value>}` (applied whatever the
  file says; every change refused `SETTING_FORBIDDEN_BY_CEILING`),
  `{"confirm": true}` (a conversational change needs confirmation), or
  `{"conversation": false}` (terminal only). The key `"conversation": false`
  directly under `moduleSettings` makes every module setting terminal-only.
  A `fixed` value the declaration rejects makes that module refuse to load,
  with the ceiling's reason.
- A ceiling that cannot be trusted refuses every conversational loosening
  and every conversational module-setting change, and loads no module.
- ch-local reads the file with the installed runtime's own reader
  (`ceilingFor`, `lib/ceiling.js`), unchanged. `packAllowed`, `packRefusal`
  and `notAllowed` become their module forms.
- A multi-tenant HTTP server has no ceiling; its operator chooses the
  modules with `--loadModule`.

## 9. Install (ch-local)

The commands keep their names. `install --pack`, `add-pack` and
`remove-pack` act on a pack, because a pack is what a user installs.
Everything they write is about modules.

### 9.1 The module store

```
<home>/module-store/
  @countinghouse/
    ch-access-github/
      0.1.0/            the package's files, as unpacked
      0.1.0.json        {"name", "version", "integrity", "placedAt"}
      0.2.0/
      0.2.0.json
  weather-tool/
    1.2.0/
    1.2.0.json
```

- One directory per module version; a scoped name is two directories. It
  replaces `<home>/packs/<pack>/<key>/node_modules/…` (`lib/pack-dir.js`),
  where each pack version has a copy of every part.
- A module's package has no npm dependencies, as today
  (`lib/unpack.js` `checkManifest`), so a version directory is complete by
  itself.
- **Placing** a version: its tarball's bytes, already checked against the
  pin, are unpacked into `<version>.new-<random>` beside it; the manifest is
  checked (the pinned name and version, no dependencies); the directory is
  renamed into place; then the marker `<version>.json` is written. A version
  directory with no marker is incomplete: never loaded, and collected.
- **Skipping**: a version that is there, with a marker whose integrity is
  the pin's, is not fetched and not unpacked again. This is "a module already
  installed is not installed again".
- A marker with another integrity can only come from a development install
  (`--unreleased-pins`, where one version may be built twice). The version is
  replaced when no running start uses it, and refused otherwise
  ("`<module>` `<version>` is installed with other contents and a running
  client uses it; stop it and run this again").
- The name is not `<home>/modules`: that is the runtime's `--modulePath`.
- The store is inside ch-local's home, which the file broker denies to every
  module; a module reads its own directory only, as with the pack trees
  today.

### 9.2 The record

`<home>/modules.json` replaces `<home>/packs.json` (`lib/record.js`):

```json
{
  "v": 2,
  "runtime": {"versions": {"@countinghouse/ch-local": "0.9.0", "countinghouse": "8.0.0"}},
  "release": {"version": "0.9.0", "security": null},
  "unreleased": false,
  "packs": {
    "ci-failure-triage": {
      "installedUnder": "0.9.0",
      "modules": {
        "@countinghouse/ch-pack-ci-failure-triage": "0.5.0",
        "@countinghouse/ch-access-github": "0.2.0",
        "@countinghouse/ch-step-redact": "0.2.0"
      }
    }
  },
  "modules": {
    "@countinghouse/ch-pack-ci-failure-triage": {"version": "0.5.0", "role": "scenario"},
    "@countinghouse/ch-access-github": {"version": "0.2.0", "role": "part"},
    "@countinghouse/ch-step-redact": {"version": "0.2.0", "role": "part"}
  },
  "held": {},
  "shim": {"package": "@countinghouse/ch-shim-linux-x64", "version": "0.9.0"},
  "at": "2026-12-01T10:00:00.000Z"
}
```

- **`packs.<pack>.modules.<module>`** is the version of that module that was
  in effect when the pack was installed or last updated. It is the pack's
  own pinned version, or a newer installed one the pack accepted
  (section 9.4). Another pack's install never changes it.
- **`modules.<module>.version`** is the **active version**: the highest of
  the versions the installed packs record for it. `role` is that version's
  `countinghouse.role` (`scenario`, `part`, or `null`). This map is derived;
  ch-local writes it so that readers need no version arithmetic (the
  runtime's settings tool reads a module's version and role from it), and
  the reader refuses a record whose `modules` is not what its `packs` give.
- One rule gives both the update and the way back: **a module's active
  version is the highest that any installed pack was installed with.**
  Installing a pack can raise it. Removing a pack lowers it again, unless
  another pack was installed with the higher version.
- `held`: packs that a release rollback's restored release does not have,
  as today (`{modules, installedUnder}`): recorded, named by `status`, never
  loaded, removed by `remove-pack`. The marks `withdrawn` and `relisted` go
  (section 9.7).
- Names and versions are checked as today (they become directory names).
- The file name changes so that no older reader takes the new shape for its
  own (section 10).

### 9.3 The release pins

`lib/release-pins.json`, version 2 (`lib/release-pins.js`):

```json
{"v": 2,
 "release": {"security": null},
 "self": {"…": "as today"}, "shim": {"…": "as today"}, "runtime": {"…": "as today"},
 "packs": {
   "ci-failure-triage": {"modules": ["@countinghouse/ch-pack-ci-failure-triage",
                                     "@countinghouse/ch-access-github", "…"]}
 },
 "modules": {
   "@countinghouse/ch-access-github": {"credentials": [
     {"variable": "GITHUB_TOKEN", "origin": "https://api.githubcopilot.com"}]},
   "@countinghouse/ch-step-redact": {"credentials": []}
 },
 "pins": {"…": "as today: one version, integrity and build identity per package"}}
```

- `packs.<pack>.modules` replaces `packages`. Its order means nothing any
  more: a module's role comes from its own manifest, not from being first.
- Each pack's `credentials` and the top-level `allowedOrigins` are gone.
- `modules.<package>.credentials` is what each package's own
  `countinghouse.remotes` declares, written by the release step that writes
  the pins, never by hand, with one entry for every package of every pack.
  It is **not** a list of where a key may go; the store's binding is that
  (section 6.6). It exists so that a release can be described before it is
  installed: `additions` reads it to say "ch-access-github sends
  GITHUB_TOKEN to a new origin", and an automatic upgrade holds back on it.
  `install` refuses a package whose manifest declares anything other than
  what the pins say, so what was shown is what is installed.
- `additions(now, next, installed)` reports, for the installed packs and
  modules: a module added to an installed pack, and a credential destination
  that is new or changed for an installed module.
- `identityChanges` is unchanged apart from the key names.
- This is a breaking change of the pins' format: a ch-local that reads
  version 1 refuses version 2. It is acceptable only because no release has
  been published (the pins at `origin/main` are empty). After the first
  release the format must only grow in ways an older reader accepts, or the
  upgrade path breaks; that constraint is for a later design.

### 9.4 `install` and `add-pack`

For each module of the pack, with `p` the pack's pinned version and `a` the
module's active version in the home:

| Case | What happens |
|---|---|
| Not installed | `p` is placed. |
| `a` equals `p` | Skipped. |
| `a` is newer than `p`, with no breaking change between them | Skipped. The pack is recorded with `a`. |
| `a` is older than `p`, with no breaking change between them | `p` is placed and becomes active, without asking. Said: "updated `<module>` `a` -> `p`; `<callers>` use it too". |
| `a` is older than `p`, across a breaking change, and no installed module calls it | As the row above. |
| `a` is older than `p`, across a breaking change, and installed modules call it | **Question A.** |
| `a` is newer than `p`, across a breaking change | **Question B.** |

"A breaking change between two versions" is semver's: their major versions
differ. Whether a 0.x minor counts, as it does for ch-local's own upgrade
(`breaking`, `lib/npm-upgrade.js`), is open question 3; this design assumes
it does.

"Installed modules that call it" are read from the installed modules'
`countinghouse.calls`, the names before the slash, matched by friendly name
as the runtime matches them. Modules that this same operation brings to the
version its pins give them are named as such.

**Question A** (the update):

```
ch-access-github 1.4.0 -> 2.0.0 is a major version: it may change how it works.
These installed modules call it:
  ch-pack-ci-failure-triage 0.4.1 (pack ci-failure-triage)
Update ch-access-github anyway? [y/N]
```

**Question B** (the pack is older than what is installed):

```
ch-access-github 2.0.0 is installed, a newer major version than the pack "weekly-report" was released with (1.4.0).
These modules of the pack call it and may not work with it:
  ch-pack-weekly-report 0.3.0
Install the pack anyway? [y/N]
```

Rules for both:

- The default is No. Only `y` or `yes` is a yes.
- Asked at a terminal only. Without one: "this install updates
  ch-access-github across a major version, which is confirmed at a terminal:
  run it in one; nothing was installed" (exit 2). There is no `--yes`.
- Every question of an operation is asked before anything is written. Any No
  ends the operation: "nothing was installed".
- After a yes the operation goes ahead, and **every module still loads**:
  ch-local does not hold a module back because of a version. It says what it
  did and how to go back:

  ```
  updated ch-access-github 1.4.0 -> 2.0.0
  ch-pack-ci-failure-triage 0.4.1 was written for 1.x and still loads; if it stops working,
  `ch-local remove-pack weekly-report` puts ch-access-github back to 1.4.0
  ```

  After an `install` or an `upgrade` of a whole release the last line names
  `ch-local rollback` instead.
- The history gets one line for the answer (`{by: 'cli', module, from, to,
  callers, answer}`).

Then, as today: the record is written, what no record or running start
needs is collected, the credential conversation of section 6.2 runs, and a
running start applies the change in place (section 9.8).

`install --pack <name>` installs this release's runtime, adds the pack, and
brings every pack already in the home to this release's pins, by the same
table. It no longer drops the other packs (`lib/install.js:388`).
`add-pack` still needs the installed runtime to be this release's.

In release 1 every pack comes from one ch-local release, which pins one
version of each module. So in a released install the two questions and the
"updated without asking" rows arise only at an upgrade (section 9.6), and
the versions packs record never differ. They do differ between development
installs (`--unreleased-pins`), which is how the tests reach every row, and
they will between packs from different sources later. The mechanism is built
now because the decisions ask for it.

### 9.5 `remove-pack`, and the way back

`remove-pack <name>` removes the pack from the record. Then, for each module
the pack recorded:

- **No other installed pack records it**: it leaves the record. Its files go
  once no running start uses them and no rollback can need them
  (section 9.10).
- **Another pack records it at the same or a higher version**: nothing
  changes.
- **The remaining packs record only lower versions**: the active version
  goes back to the highest of those. This is the rollback: "put back
  ch-access-github 2.0.0 -> 1.4.0 (it was updated when weekly-report was
  installed)".
- **A pack installed later was installed with the newer version**: it
  recorded that version, so the module stays, and remove-pack says why:
  "ch-access-github stays at 2.0.0: the pack monthly-report was installed
  with it".

The last two are one computation (section 9.2's rule); no history of
updates is kept.

What is kept:

- **Settings.** `module.<module>.*` and `enabled.<module>` are not touched by
  an update, a rollback or a removal. Under the older version, a value for a
  setting it does not declare stays stored and unused, and comes back with
  the newer version (section 4.2).
- **The stored credential.** remove-pack says "the credential stored for
  `<module>` is kept: `ch-local credentials remove <module>` removes it"
  when it removes a module that has one. After a rollback to a version that
  declares another destination, the module is not loaded until
  `credentials add` is run (section 6.6).
- **The previous version's files**, while any installed pack, a held pack,
  the release rollback's record or a running start names them.

A running start applies the change in place: one reload naming every loaded
top-level module that holds the module whose version moved (section 7.3).

### 9.6 `upgrade`, the automatic upgrade, and the release rollback

**`ch-local upgrade`** moves the runtime and every installed module to the
new release's pins in one operation. The refusal of a home with more than
one pack goes (`lib/upgrade.js:77`).

- The preview lists, beside what it lists today: each installed module whose
  version changes; each that crosses a breaking change, marked, with the
  installed modules that call it; each credential destination that changes
  (section 6.6); each module the release adds to an installed pack; each
  installed module the release no longer lists (section 9.7).
- Its one question, "Upgrade to `<version>`? (yes/no)", is the yes for all
  of it, at a terminal only, as today. A module crossing a breaking change is
  part of what that question covers; no second question is asked, because a
  No to one module in the middle of a release would leave the modules of one
  release out of step with each other.
- `upgrade` hands its yes to the install it runs, which then asks nothing.
  An `install` run by hand asks its own questions (section 9.4), and a No
  there installs nothing.
- After the install: "upgraded ch-local `a` -> `b`; `ch-local rollback`
  undoes it", and for each module that crossed a breaking change, the line
  naming it and its callers.

**The automatic upgrade** (`lib/auto-apply.js`) never answers a question.
Beside what holds it back today (another major or a 0.x minor of ch-local
itself, an identity change, an addition, the 72-hour wait), it announces
and leaves to `ch-local upgrade` a release that:

- moves a module that installed modules call across a breaking change ("…is
  available, but it updates ch-access-github across a major version, which
  ch-pack-ci-failure-triage calls: run ch-local upgrade to see it and
  install");
- changes where an installed module's credential goes;
- adds a module to an installed pack (today's "a package in `<pack>`").

All three are decided from the new release's pins and the home's own
record and manifests, before anything is fetched. The refusal of a home with
more than one pack goes (`lib/auto-apply.js:82`).

**`ch-local rollback`** (to the release the last install replaced) keeps its
mechanism: the app and the record are swapped with the kept ones, journalled
(`lib/rollback.js`). The kept record is `<home>/previous/modules.json`. A
pack only the newer release's record has becomes `held`. The module store
keeps every version either record names. Settings and credentials are not
touched, as today.

### 9.7 Withdrawn modules

Today a pack that the running release does not list is not started, and an
upgrade moves it to `held` with a mark (`lib/packs.js` "Withdrawn packs",
`lib/install.js` `carriedHeld`). With the pack gone as a unit, the rule is
per module and needs no mark:

- **A module is withdrawn when no pack of the running release lists it.** It
  is not available (section 5.2): never loaded, and neither is a module that
  calls it. Nothing of it is removed.
- Each start tells each session once: "module `<m>` was withdrawn in this
  release and was not started; `ch-local remove-pack <pack>` removes it",
  naming each installed pack that records it. A start that was serving it
  when the upgrade came unloads it and says "…is no longer served".
- `status` and an upgrade's preview say the same.
- An upgrade leaves a withdrawn module's entry and files as they are. A
  release that lists it again pins it, so the upgrade to that release brings
  it to the pin and it loads again. That upgrade counts the module as an
  addition, so it is shown and is never taken automatically.
- A development install (`unreleased: true`) is exempt, as today.

Whether withdrawal should be by module is open question 2: it follows from
the decisions, but it was asked and not answered.

### 9.8 `start`, and the running applier

**At start** (`lib/start.js`), in today's order:

1. The record is read under the home's lock, and `run.json` is written
   naming every active module version, so that nothing this start may load
   is collected (`loaded: {"<module>": "<version>"}`; today
   `{"<pack>": "<key>"}`).
2. The settings and the ceiling are read and checked as today.
3. Availability is worked out for every installed module (section 5.2).
   Each module that is not available is said once, with its reason.
4. Credentials are resolved for the modules that will load (section 6.4).
5. The runtime is started with `--loadModule <dir>` for each available
   top-level module, `--partDir <dir>` for each part one of them needs,
   `--modulesRoot <home>/module-store`, `--remoteCredentials <file>`, and
   the rest as today. `--deviceConfigPath` still names the start's own empty
   directory, so that the runtime never reads a device config from the
   client's working directory; nothing is written into it.
6. `PATH_OPTIONS` (line 253), which a shared runtime's start checks against
   the home, takes `--modulesRoot` and `--partDir` in place of `--packsRoot`.

**While it runs** (`lib/in-place.js`), on a change of `modules.json` or
`settings.json`:

1. Work out the wanted set again: each available top-level module, its
   closure, and each module's active version.
2. Compare with what is loaded:
   - a loaded top-level module no longer wanted: `unload`, with its reason
     as the notice ("turned off", "removed", "withdrawn", "its credential…");
   - a module whose active version changed: one `reload` naming every loaded
     top-level module that holds it, plus any top-level module whose own
     version changed in the same step;
   - a wanted top-level module not loaded: `load`.
3. Unloads first, then reloads, then loads; one request at a time; each with
   its notice and its history line, as today.
4. A change against another runtime version than the one this start spawned
   waits for the next start, as today.
5. A changed `module.*` value: `reread` (section 4.3).

The applier loses `thisStart`, `confirmed`, `loadPack`, `unloadPack` and the
"now global" step (section 5.3).

### 9.9 `status`

By module, then the packs as what they are:

```
ch-local 0.9.0, countinghouse 8.0.0
modules:
  ch-pack-ci-failure-triage 0.5.0   on; tools: ci_failure_triage
  ch-access-github 0.2.0            part; credential GITHUB_TOKEN -> https://api.githubcopilot.com (gh login)
  ch-step-redact 0.2.0              part
  weather-tool 1.2.0                not loaded: turned off (`ch-local settings set enabled.weather-tool on`)
packs:
  ci-failure-triage                 9 modules
```

A module that would not load says why, with the same sentence a start tells
a session (section 11).

### 9.10 Collection

`lib/gc.js` collects module versions instead of pack trees. A version in
the store is kept while any of these names it:

- an installed pack or a held pack in the record (every version a pack
  records, not only the active one: the lower ones are what `remove-pack`
  goes back to);
- the release rollback's kept record;
- a running start's `run.json`, by the liveness rules of today (its process
  or its runtime's on this machine, its heartbeat on another).

Everything else under the store, staging leftovers and versions without a
marker included, is renamed aside and deleted, under the home's lock, as
today.

## 10. Migration

No release has been published, so the homes to migrate are development and
test homes. Every step is one-way, and each fails closed.

| From | To | When and how |
|---|---|---|
| `<home>/packs.json` | `<home>/modules.json` | By `install` and `upgrade`, in the operation that installs a ch-local of this design. Each recorded pack becomes a pack entry with its packages as modules; `credentials` is dropped; a held pack marked `withdrawn` or `relisted` becomes an ordinary pack entry (section 9.7 decides whether its modules load); a pack held after a rollback stays held. `packs.json` is removed once `modules.json` is written. A `start`, `add-pack`, `remove-pack` or `status` that finds `packs.json` and no `modules.json` says "this home was made by an earlier ch-local; run `ch-local install` again", as `lib/record.js` already says for the format before it. |
| `<home>/packs/<pack>/<key>/…` trees | `<home>/module-store` | The same install places every module in the store from its pinned tarball. The old trees are not converted. They are collected once no running start names them (a start from before has the old `run.json` shape, which collection still reads) and they are not the rollback target. |
| `<home>/previous/packs.json` (the release rollback's kept record, old format) | none | `ch-local rollback` refuses it: "the kept release predates the module store, so it could not return you here; install it again instead". This is the wording and the rule rollback already has for a kept release from before rollback existed. |
| `pack.<name>` in `settings.json` | `enabled.<package>` | The install or upgrade that migrates the record rewrites each `pack.<name>` as `enabled.<the pack's scenario module>` in the same operation, under the settings lock, with a history line `{by: 'migration', setting, was}`. Until then, and for one left over (a file edited by hand), ch-local's reader takes `pack.<name>` for that entry, so a pack the user turned off never loads. A `pack.<name>` whose pack the home does not have is kept as an unknown name. The runtime's settings tool keeps a `pack.*` name as an unknown one. |
| `<home>/credentials/credentials.json` version 1 (`{values: {VARIABLE: {value, module}}}`) | version 2 | Read-time: an entry reads as a binding for its recorded module, to `https://api.githubcopilot.com` (the only origin ch-local ever sent it to), under whichever of `COUNTINGHOUSE_GITHUB_TOKEN` and `GITHUB_TOKEN` (the two names that origin was allowed) the installed module declares; source `stored`. The first `credentials add` or `remove` rewrites the file as version 2. |
| A session's pack rows (the daemon's table, a restore) | none | The new daemon's `seed` (the handoff from the daemon it replaces) drops `pack.*` overrides and the kind `pack` from each row and marks the session to be told once: "tools are turned on and off for all your sessions now; `<module>` is on. Turn it off with `enabled.<module>`". The new runtime refuses a restore that still carries one (`CONTROL_BAD_RESTORE`), after which the table starts over and each session's shim replays its tightened caps, as today. |
| The ceiling's `"packs"` | `"modules"` | Not migrated: the operator rewrites the file. Until then it is not trusted and no module loads (section 8). |
| `lib/release-pins.json` version 1 | version 2 | Not migrated: no release carries version 1 pins with content. |
| `{defaultRepo}` in a start's device config | `module.<scenario>.defaultRepo` | Nothing is stored today (it is derived at each start), so there is nothing to move. |
| Usage records' `pack` field | `scenario` | The reader accepts both. |
| A stored GitHub token in a client's configuration (`COUNTINGHOUSE_GITHUB_TOKEN`) | the store | Not moved by ch-local (it does not read client configurations for secrets). A start that sees the variable set says once: "COUNTINGHOUSE_GITHUB_TOKEN in this client's environment is no longer read: run `ch-local credentials add <module>`" (if open question 1 is answered as recommended). |

Between the two repositories: ch-local and countinghouse are installed as a
pinned pair, and a running start applies nothing in place against another
runtime version. During development the two default branches meet in
ch-local's acceptance run, so each cross-repository step keeps the old form
readable until its counterpart has merged (section 16).

## 11. Failure modes and what the user is told

Every line a start tells a session is plain text the agent can pass on
whole, names a module and a command, and never names a path or a value.

| Situation | Where | Said |
|---|---|---|
| A module is turned off | start, applier, status | "not loading `<m>`: it is turned off (`ch-local settings set enabled.<m> on`)" |
| The ceiling's list leaves a module out | start, applier, install | "not loading `<m>`: this machine's operator ceiling does not list it" |
| The ceiling cannot be trusted | start, applier | "not loading any module: the operator's ceiling file `<file>` cannot be trusted (`<problem>`)" |
| A module is withdrawn | start, applier, status, upgrade | section 9.7 |
| No credential, another destination, gh gave none, the store fails | start, applier, status | section 6.7 |
| A module calls one that is not available | start, applier, status | "not loading `<m>`: it calls `<n>`, which `<n's reason>`" |
| A module's files are missing from the store | start | "not loading `<m>`: its files are missing; run `ch-local install` again" |
| Nothing is loadable | start | "no module is loaded this start; only ch-local's own tools (settings, the usage report) are served" |
| A module needs a key the running runtime was not started with | applier | "`<m>` needs a credential the running runtime was not started with; restart your client to load it" |
| A load, reload or unload is refused by the runtime | applier | "`<notice>`: not applied in place (`<code>`); restart your client to apply it" (today's line) |
| An unload fails | runtime | The module stays hidden (section 5.5); logged; the applier says the line above |
| Question A or B with no terminal, or answered No | install, add-pack | section 9.4 |
| An automatic upgrade is held back | start's announcement | section 9.6 |
| A pack holds a module the ceiling does not list | install, add-pack | section 8 |
| A stored value the loaded version does not accept | load | one warning in the log, one history line; the default applies (section 4.2) |
| `SETTING_REQUIRED` | a call | section 4.6 |
| A setting change that needs confirmation, with no tested client | `countinghouse_settings` | `SETTING_NEEDS_CONFIRMATION` and the terminal command, with no value in it |
| `enabled.<part>` or a part's setting named in conversation | `countinghouse_settings` | `SETTING_UNKNOWN` |
| A remote's key cannot be attached | a call, or the load under ch-local | section 6.5 |
| `credentials add` for a module that is not installed, or declares no credential | terminal | "that is not an installed module that declares a credential; `ch-local credentials list` and `ch-local status` show them. Nothing was changed." (the argument is not shown back) |
| A short name that two installed modules share | any command | "more than one installed module is named `<short>`: `<full names>`; give the full name" |
| A home from before this design | start, add-pack, remove-pack, status | section 10 |

Error catalogue texts that change (`lib/error-catalogue.js:275-295`; the zh
texts are drafts for the reviewer):

| Code | en | zh |
|---|---|---|
| `MODULE_NOT_LISTED` | This tool is not listed here: its module is a part that other modules call, or is turned off | 此工具未列出：它所在的模块是供其他模块调用的组件，或已被关闭 |
| `PART_MISSING` | A module this one calls is not installed or not available, so it was not loaded | 此模块调用的某个模块未安装或不可用，因此未加载 |
| `TOOL_NAME_TAKEN` | A module's tool name is already taken by another tool, so the module was not loaded | 该模块的工具名已被其他工具占用，因此未加载该模块 |
| `PROMPT_NAME_TAKEN` | A module's prompt name is already taken by another prompt, so the module was not loaded | 该模块的提示名已被其他提示占用，因此未加载该模块 |
| `REMOTE_CREDENTIAL_NOT_ALLOWED` | section 6.5's two sentences | 同上，另拟 |

New codes: `SETTINGS_DECLARATION_INVALID`, `SETTING_REQUIRED` (from the
2026-11-17 design). `CONTROL_PACK_UNCERTAIN` and `CONTROL_PACK_NOT_ALLOWED`
are control-channel codes, never a client's; they are renamed with
`MODULE` in place of `PACK`.

## 12. Safety

What must hold, and where it is enforced.

1. **A module never receives a key.** The value is read and attached on the
   runtime's main thread only (`lib/remote/`), as today. Nothing in this
   design gives a value to a worker: settings are not secrets, and the
   declaration vocabulary has no secret type; the validator warns on a
   setting that looks like one. Values are never written to the settings
   file, the history, a notice, a log or a run directory.
2. **A key goes only where the user entered it for.** The binding is
   (module, variable, origin), made at a terminal or on standard input.
   ch-local writes the runtime's file from the store, and the runtime checks
   the module's current declaration against it at every spawn. No other list
   exists that could be widened by mistake.
3. **A new origin or variable gets no key.** A compromised release cannot
   redirect a stored key: its new destination has no binding. Only
   `credentials add`, run by the user, makes one, and it shows the
   destination before it asks. An upgrade's yes, an automatic upgrade, a
   setting and conversation cannot.
4. **The gh login is offered only for GitHub's own origins**, and never
   used without a yes for that module.
5. **No setting widens the sandbox.** A module setting is data the module
   reads; it reaches no policy, permission, ceiling, route or price. A
   `hostname` or `url` value must already be inside the module's granted
   `net`. `enabled.<module>` turns on only what is installed, in the running
   release, and on the ceiling's list.
6. **Conversation cannot loosen by itself.** Turning a module on, and every
   string setting, needs the user's own confirmation, on a client tested to
   show it to a person, or else a terminal. A credential has no
   conversational path at all. The settings tool is not reachable from module
   code. Text in a form is the runtime's; hints carry no values; package
   names in hints are npm-grammar names.
7. **An automatic upgrade never says yes.** It does not answer question A
   or B, does not take a release that moves a called module across a breaking
   change, changes a credential's destination, adds a module, changes an
   identity, or is a major of ch-local; and it never binds a credential.
8. **Fail closed.** A ceiling that is not trusted loads no module. A
   settings file that is not valid stops the start. A credentials store that
   fails its checks is not used. A module that is going on or off is hidden.
   A module no pack of the release lists does not load. A `pack.<name>: false`
   left from before keeps its module off. A restore the runtime cannot check
   is refused whole.
9. **What is installed is what was pinned.** Tarballs are checked against
   their pins and provenance before anything is written, as today; a store
   version is reused only with the pin's integrity; a module directory must
   lie inside `--modulesRoot` by real path with no link out; a package's
   declared credentials must be what the pins said.
10. **Files modules cannot read**: the whole ch-local home (settings, the
    record, the credentials, the store but for a module's own directory, the
    run directories), as today. `--moduleSettings` is refused to modules like
    the policy file.
11. **Every change is recorded** in `history.jsonl` first: a setting, an
    on/off, a credential added or removed (never its value), an answer to
    question A or B, a module loaded, reloaded or unloaded.

Limits that this design does not change, stated so that no document claims
more:

- Another program running as the user can read the stored credentials and
  the runtime's environment, as it can read gh's own token.
- A module can still open outbound connections of its own until the network
  broker exists. The key does not reach the module, but data a remote gave
  it can be sent on.
- A version 1 `--remoteCredentials` file on an operator's server is not
  bound to a module.
- Under `--moduleSandbox audit` a module can rewrite its own `package.json`;
  the settings pin holds until the next start, and the credential check is
  made against the store's binding in either mode.

## 13. Code areas that change

### 13.1 countinghouse

| File | What changes |
|---|---|
| `lib/settings-tool.js` | `PACK`, `PACK_NAME`, `PACK_ENTRY`, `entryOf` (57-62): the `enabled.*` grammar and entry; `entryOf` also answers `module.*` from the module's declaration. `conversationMayAsk` (150) and `CEILING_KIND` (200) take `enabled.*`. `ceilingRefusal` (303) reads the ceiling's `modules`. `FORM_TEXT` (321): the `pack` and `session.pack` sentences go; the `enabled` sentence (section 5.3) and the module-setting sentence (section 4.4) come, en and zh. `packsThisStart`, the pack branch of `effectiveOf` (360), `packUnloaded` (476): removed. `packVersion` (367): a module's version and role from `modules.json`. `applyConfirmed` (415): the `load-pack` and `unload-pack` asks go; a confirmed "on" is written to the file. `get` (656): one `enabled` row per installed top-level module, and the module settings with a cursor. `set` (685): `enabled.*` and `module.*`, keeping unknown names on every write. `setForSession` (877) and the session branch of `confirm` (1523): the two caps only. `setForAll` (1249): also `enabled.*` and `module.*`. `applyThisStart` (1471), `formOrRefusal` (1491): no pack case. `applyControlSet` (1755): unchanged for the runtime's own settings; the new `reread` handler sits beside it. The tool's description and input schema (1793). |
| `lib/settings-confirm.js` | `kindOf` (50) and `KINDS` (58): `enabled` and `module` in place of `pack`. |
| `lib/settings-ceiling.js` | `KEYS` (37): `modules` and `moduleSettings` in place of `packs`; their checks; the problem text for a leftover `packs`. |
| `lib/module-settings.js` (new) | The declaration's vocabulary and checks, the format checkers, effective values and their versions, the stored-value check, `--moduleSettings`. |
| `lib/manifest-pins.js` | The settings declaration joins the pin. |
| `lib/lean-worker.js`, the invoke message, `lib/device-manager.js`, `lib/peer-channel-broker.js`, the task and job paths | `ctx.settings` delivery on every path (section 4.5); `ctx.settingRequired`; the pre-handler `SETTING_REQUIRED` check over the call graph. |
| `lib/session-packs.js` | Deleted. |
| `lib/module-visibility.js` (new) | Section 5.5. |
| `lib/session-settings.js` | `PACK` (50), `globalPack`, the pack branches of `set`, `effective` and `isLoosening`, `dropPack` (413), `packOnAllowed` (222), `packOverridesOf` (430): removed. |
| `lib/session-state.js` | `KINDS` (134), the pack override rows (150, 281, 330), the restored pack "on" (370-400): removed; kinds as section 5.4. |
| `lib/session-transport/restore.js` | `KINDS`, `PACK`, `overrideProblem`: caps only; the new kinds. |
| `lib/sessions.js`, `lib/job-sessions.js` | `packsOffOf`, `sessionEnded`'s `packsOff`, `packsOffFor`, `sessionPacks.forget` (sessions.js 55-70; job-sessions.js 88-95): removed. |
| `lib/packs-in-place.js` → `lib/modules-in-place.js` | Section 7.1 and 7.3: `readRequest` (`dirs`, `names`, no `scenario`), `ceilingRefusal` by module, the records without `pack` and `allowance`, `heldElsewhere` over a set of excepted names, `planFor` over several named modules, `reloadPack` generalised, `addAllowance` and `removeAllowance` replaced by the per-module allowance, `chLocalPackOf`, `packNameOf`, `packRecords`, `loadedVersionOf` removed. |
| `lib/pack-control.js` → `lib/module-control.js` | Section 7.3: no `pack`, `global`, audience or `set pack.<n>`; a notice to every session. |
| `lib/control-channel.js` | `TYPES` (21) gains `reread`. |
| `lib/route-manager.js` | `credentialVariables` (70); the control channel's handlers; `configureSessionPacks` (343) and its call (469) go, the visibility set's `onChange` takes the subscriptions' hook (156). |
| `lib/module-roles.js` | `resolvePart`, `closureOf`, `expandLoadList` take the given directories (section 7.2); `refusedWhy`'s wording. |
| `lib/module-manager.js` | `unlisted` recomputed from the records (83, 416); `packRemotes`, `START_ALLOWANCE`, `mergedAllowance`, `registerRemotes` (668-704): the per-module allowance; `sessionViewChanged` (1852) reads the visibility set; `startPlan` seeds `loadedUnits`. |
| `lib/cli-options.js`, `framework.js` | `--modulesRoot` in place of `--packsRoot` (222-227), `--partDir`, `--moduleSettings`; their checks. `lib/fs-broker/index.js` `protectedPaths` and `lib/hardened-launch.js` learn `--moduleSettings`. |
| `lib/remote/declaration.js` | The default `transport` (185) and the string `credential` (`parseCredential`, 115). |
| `lib/remote/credentials.js` | `loadAllowance` (18): version 2 beside version 1; `resolveCredential` (44): the module's own entry and its environment name. |
| `lib/remote/index.js` | `register` (82): the allowance by module; the two `NOT_ALLOWED` cases and the hint. |
| `lib/module-validator.js`, `bin/countinghouse-validate.js` | The settings declaration's problems and warnings, each setting's confirmation rule, the expanded remote. |
| The readers of a session's view | Section 5.4's last row: `lib/mcp/tool-registry.js`, `gateway.js`, `prompts.js`, `resources.js`, `subscriptions.js`, `lib/device-manager.js`, `lib/peer-channel-broker.js`, `lib/job-control-common.js` (its comment on runs into a pack). |
| `lib/notices.js`, `lib/usage/receipt.js` | Wording only (a module, not a pack). |
| `lib/error-catalogue.js` | Section 11: four texts, two new codes, the credential code's fields. |
| `lib/usage/*` | The record field and the report's grouping `pack` become `scenario` (`index.js` `beginCall`, `task.js:41`, `aggregate.js`, `format.js`, `report.js` `GROUP_BY`, the CSV headers). The reader accepts a record that still says `pack`. |
| `docs/superpowers/specs/shared-runtime-wire/vectors.json`, `make-vectors.js` | Section 7.5. |

Tests that pin these files by name or by list (the option lists, the
folder list in `test/folders.json`, the port table in `test/ports.md`, the
validator's byte-for-byte output) change with them. Search the tests for a
file's or a flag's name before changing it.

### 13.2 ch-local

| File | What changes |
|---|---|
| `lib/settings.js` | `PACK`, `packEntry`, `entryOf` (52-54): `enabled.*`, and `module.*` checked with the installed runtime's reader. `readSettings`: unknown names are kept apart, not dropped. `setSetting` and `resetSettings`: every name the file holds that this ch-local does not write is preserved; a bare reset leaves `module.*`. `listSettings`: modules, not packs. The read-time `pack.*` mapping (section 10). |
| `lib/settings-command.js` | `settings modules`, `set <module>.<setting>` with a prompted value, `reset <module>[.<setting>]`, short names. |
| `lib/outside-edits.js` | The `module.*` and `enabled.*` rules; a cut value compared by its hash. |
| `lib/ceiling.js` | `packAllowed`, `packRefusal`, `notAllowed`, `packName`: by module, over every module of a pack at install. |
| `lib/session-table.js` | `KINDS`, `PACK`, `overrideOk`: caps only, the new kinds; `seed` strips pack rows and marks the session (section 10). |
| `lib/credential-store.js` | Version 2 (section 6.3), the wider value grammar, the version 1 reading. |
| `lib/credentials-command.js` | Section 6.2: `<module>`, the declaration shown, the gh offer, standard input, `list`, `remove`. |
| `lib/github-token.js` | `ghToken` stays. `chooseGitHubToken` goes. |
| `lib/module-credentials.js` (new) | For a set of modules: each one's usable binding or its reason, the values, the slots, the version 2 file's content (sections 6.4 and 6.7). start and the applier call it at one place each. |
| `lib/conditions-command.js` | `chosenToken`, `chosenCredentials` go; `token` is always null and `credentials` absent (open question 1). |
| `lib/snippets.js`, `lib/uninstall.js` | No credential variable is forwarded by a client entry; uninstall names the stored credentials by module, and its list of the home's own names gains `modules.json` and `module-store`. |
| `lib/release-pins.json`, `lib/release-pins.js`, `lib/allowlist.js`, `lib/pins.js` | Section 9.3. `ALLOWED_ORIGINS` goes. |
| `lib/record.js` | Section 9.2, and reading the old file only to migrate it. |
| `lib/home.js` | `layout`: `moduleStore`, `record` (`modules.json`), `previousRecord`. |
| `lib/pack-dir.js` → `lib/module-store.js` | Section 9.1: place, skip, the marker. |
| `lib/unpack.js` | `unpackInto` places one package into a version directory; `checkManifest` also checks the declared credentials against the pins. |
| `lib/install.js` | `install`, `installLocked`: every installed pack kept and brought to the pins; the table and questions of section 9.4; `carriedHeld` and the `runtimeOnly` path's withdrawn marks go; `credentialLines` becomes the credential conversation; the migration. |
| `lib/packs-command.js` | `addPack` (the shared-module path, 66-79, becomes section 9.4), `removePack` (section 9.5), `status` (section 9.9). |
| `lib/packs.js` | `installedPacks` becomes the installed modules and their closures; `declaredRemotes` per module; `credentialUnion`, `loadablePacks` go; the withdrawn lines by module; availability (section 5.2) lives here or in a file beside it. |
| `lib/start.js` | Section 9.8, and what section 6.9 removes: `GITHUB_VARIABLES` (41), `chooseCredentials` (227), the token block (364-403), the pack filters and the credential gate (456-474), `credentialUnion` and its refusal (497-505), the device-config write (523-531), `--loadModule` per pack (581), `--packsRoot` (594), the `load-pack` and `unload-pack` handlers (679-680), `PATH_OPTIONS` (253). |
| `lib/in-place.js` | Section 9.8: the wanted set, unload/reload/load by module, `reread`; `thisStart`, `confirmed`, `loadPack`, `unloadPack`, the "now global" step, `credentialsFor`'s origin list and device config removed. |
| `lib/control.js` | `teller`: a notice names a module, not a pack. |
| `lib/upgrade.js`, `lib/auto-apply.js`, `lib/npm-upgrade.js` | Section 9.6: every pack, the preview, what holds an automatic upgrade back; the `several-packs` refusals go. |
| `lib/rollback.js` | The record's new shape and name; `held` by pack; the refusal of an old-format kept record. |
| `lib/gc.js` | Section 9.10; both `run.json` shapes. |
| `scripts/acceptance.js`, `scripts/shared-acceptance.js`, `scripts/dogfood.js` | Credentials through `credentials add` on standard input; the store's layout; module names in what they assert. |
| `bin/ch-local.js` | The usage text and the argument checks for `credentials` and `settings`. |
| `shim/tests/vectors/contract-2.json`, `test/vectors/*.json` | Refreshed copies (section 7.5). |
| `clients/claude-code/skills/ci-failure-triage/SKILL.md` | How the token is given. |

### 13.3 The pack repositories

| Repository | What changes |
|---|---|
| ch-pack-ci-failure-triage | `package.json`: `countinghouse.settings.defaultRepo` (`string`, format `repo`). `lib/repo.js` and the handler: the input's `repo`, else `ctx.settings.defaultRepo`, else `ctx.settingRequired('defaultRepo')`; `DeviceConfig` is no longer read. `api.json`: the tool's description tells the agent to pass the repository of the project it is working in. Tests, README. |
| ch-access-github | `package.json`: the short remote form, `"credential": "GITHUB_TOKEN"`. README: `ch-local credentials add ch-access-github`. Its version changes, and the migration of section 10 covers the stored token. |
| The seven ch-step-* modules | Nothing, unless one gains a setting. They are the check that a part needs no configuration to be installed and loaded. |
| ch-packs | `docs/superpowers/specs/2026-11-11-client-packs-design.md`, `docs/publishing.md`, the README: a pack is an install list; a module's configuration is its own; the release step writes `modules.<package>.credentials` into the pins. |

## 14. Tests

Each is written first and seen to fail before the change that makes it
pass. Local runs follow the repository's rule (one file at a time, the
suite lock, a private Redis); the full matrices are CI's.

**Settings (section 4).**
- Declaration: every field's bounds; a bad declaration refused at load and
  by the validator, by position; the secret-name warning; a part's
  `required` warning; each format's accept and refuse cases and its
  1024-character timing bound; names `constructor` and `toString`; hidden
  characters cleaned in a title and refused in a value.
- Persistence: a terminal `set`, then a reload, a restart and a fresh start
  all read the value; an explicit value equal to the default is kept; an
  upgrade that changes a default leaves an explicit value; a value the new
  version rejects falls back with one warning and one history line and
  comes back with a version that accepts it; a `url` outside the grants
  refused on every path.
- ch-local keeps names it does not know, on `set` and on a bare `reset`.
- Live: a `set` while a call is in flight leaves that call on the old value
  and the next on the new; `ctx.settings` is frozen; a task keeps its first
  pass's values.
- Delivery: the invoke message carries only a version after the first call
  (a size assertion); a routed hop, a direct peer call, a job run, a
  per-session worker and single-thread mode each see the values.
- Conversation: a plain setting on request; a string, a `confirm: true` and
  a ceiling `confirm` through the form, declined, unanswered, the latch; the
  hint with no value; a hint built from a hostile package name; the other
  session's notice; the budget of 32; the settings tool unreachable from
  module code; a part's setting answers `SETTING_UNKNOWN`.
- `SETTING_REQUIRED`: before the handler, not billed, over the call graph,
  with `missingSettings`; the part's wording; `ctx.settingRequired` for a
  declared unset setting, and refused as a module fault for an undeclared
  one and for one that is set.
- The ceiling's three per-setting rules and the global one; a `fixed` value
  the declaration rejects.
- `--moduleSettings` on a server outside the single-identity profile: read
  at load and reload, a required one unset refuses the load, the file denied
  to modules.
- The declaration re-pinned across a supervised restart.

**On and off (section 5).**
- `enabled.<module>` off at a terminal unloads the module in place and each
  open session is told once; on again asks, refuses without a terminal, and
  loads.
- In conversation: off on request, written to the file, the history line
  naming the session; on answers `SETTING_NEEDS_CONFIRMATION` with no tested
  client, and with a tested one shows the form naming the module and
  version, writes on a yes, and refuses on a version changed meanwhile.
- A shared runtime: one session's off applies to every session; no session
  can hold a module on or off for itself (a `set` with a session scope is an
  all-sessions change); a restore row with a `pack.*` override or the kind
  `pack` is refused; the shared vectors' rows.
- Availability: each of the six reasons, and the "it calls … which …"
  sentence for a module two levels up.
- A part that is turned off at a terminal: every module that calls it is not
  loaded, and says so.
- Visibility: a tool is not listed and not callable while its module's
  parts are still loading; a module whose unload fails stays unlisted and
  refuses a call, a hop, a peer channel and a job run; `none()` is true
  outside those windows (the call path reads one boolean).
- `mm.unlisted` after loading and unloading a module that is both loaded
  for itself and called by another.

**Credentials (section 6).**
- The declaration: the short form and the default transport parse to the
  expanded form; the validator prints it; a wrong form's fix line.
- The runtime: a version 2 file binds a key to one module, so a second
  module that declares the same variable and origin gets nothing; a module
  that declares another origin, or another variable, gets nothing, with each
  of the two messages; two modules with one variable name and two values
  each send their own; a supervised restart after the module rewrote its
  declaration gets nothing; under a control channel the load is refused; a
  version 1 file behaves as today; a malformed version 2 file refuses the
  start.
- ch-local `credentials`: `add` shows the origin before it asks; hidden
  input; standard input (one line, a long one refused, an empty one
  refused); a value never appears in output, history or a log (searched
  for); the gh offer only for the listed origins, only at a terminal, only
  with a login, default No; a binding for another destination is said, and
  the value is asked again; `list` and `remove`; an argument that is no
  module's name is not echoed.
- The gate: each row of section 6.7, and the module that calls it.
- An upgrade that changes a module's origin: the preview says it; the
  automatic upgrade does not take it; after a manual upgrade the module is
  not loaded and the sentence is told; `credentials add` brings it back.
- No value is in the run directory; the slots are in the runtime's
  environment and in no worker's (asserted from inside a module under
  enforce and under audit).
- The version 1 store read as section 10 says.
- No environment route (open question 1): a `GITHUB_TOKEN` in the client's
  environment is sent nowhere; the conditions line has `token: null`.

**Loading in place (section 7).**
- load, reload, unload by module through the control channel, with `dirs`;
  a directory outside `--modulesRoot`, a link out, a name that is not the
  package's, two directories for one module: each refused.
- A part two loaded modules hold: a reload naming both switches it once; a
  reload naming one is refused `PART_VERSION_CONFLICT`; a failure part-way
  puts both back.
- Ref-counting: unloading one of two modules that share a part keeps the
  part; unloading the second unloads it.
- The ceiling's `modules` at a load in place: a closure with one module not
  listed is refused, naming it.
- `reread`: a changed `module.*` value applies; an invalid one is in the
  reply's `refused`, with a notice and a history line.
- The shared vectors' `moduleMessages`, on both sides.

**Install (section 9).**
- The store: place, the marker, a version with no marker never loaded and
  collected, a second install of the same version neither fetches nor
  unpacks (asserted on the fetch and on the directory's times).
- Each row of section 9.4's table, with pins files that differ.
- Question A and B: the text names the module, both versions and the
  callers; default No; no terminal refuses with exit 2; a No changes
  nothing on disk; a yes updates, every module loads, and the two lines are
  printed.
- remove-pack: a module only it lists leaves; the active version goes back;
  it stays when a later pack was installed with it, and the line says which;
  the settings file is byte for byte the same before and after; a value the
  older version does not declare is unused under it and used again after
  the update is repeated.
- upgrade with two and three packs; the automatic upgrade for each of its
  three new reasons to hold back, and with none of them it installs.
- Withdrawn: a module no pack of the release lists is not started, and is
  said; a module that calls it is not started; a release that lists it again
  shows it as an addition.
- Release rollback with the new record; a kept record in the old format
  refused.
- Migration: a home with `packs.json`, pack trees, `pack.x: false` and a
  version 1 credential, upgraded: the pack that was off stays off at every
  step, the token still works, the old trees go once no start uses them.
- Collection: every version a pack records is kept; one that nothing names
  goes; a running start's versions stay.
- The pins: version 2 parses; a package whose manifest declares another
  destination than the pins say is refused at install; `additions`.

**End to end** (ch-local's acceptance, CI only): pack 1 installed, the
credential entered on standard input, `defaultRepo` set in conversation,
one triage call, the module turned off and on, an upgrade in place.

## 15. Documents to update

countinghouse:

- `docs/module-development.md`: "Module settings" (new: the declaration,
  `ctx.settings`, `ctx.settingRequired`, where authors should put a setting);
  "Calling a remote MCP server" (the short form, the per-module binding).
- `docs/module-authoring.md`: the validator's new output.
- `docs/security-model.md`: credentials (bound per module; version 2; the
  limits of section 12), the settings pin under audit, the ceiling's
  `modules` and `moduleSettings`, every "pack" that means a running unit.
- `docs/cli-and-api-reference.md`: `--modulesRoot`, `--partDir`,
  `--moduleSettings`, `--remoteCredentials` version 2, the settings tool,
  the usage report's `scenario`.
- `docs/deployment.md`: an operator's `--remoteCredentials` and
  `--moduleSettings`.
- `docs/upgrading-to-8.md`, `CHANGELOG.md`: the ceiling's `packs` to
  `modules`; `--packsRoot`; the usage record's field.
- `docs/roadmap.md`: per-session on/off, declared version ranges, the
  credential on a plain HTTP request, and the network broker as later work.
- `docs/development/elicitation-hand-test.md`: the `enabled` and `module`
  forms.
- Status lines on the four designs this one replaces in part, pointing here.

ch-local:

- `README.md`: packs as install lists, modules as what runs; `status`;
  `credentials add <module>`; `settings modules`; the questions at install;
  the way back.
- `docs/install/README.md` and the five client pages: how the GitHub token
  is given (the stored binding or the gh login; no variable in a client's
  configuration).
- `docs/development/settings.md`: the names `enabled.*` and `module.*`, the
  rule that both writers keep unknown names, `reread`.
- `docs/development/auto-upgrade.md`: the pins' version 2, what holds an
  automatic upgrade back.
- `docs/development/acceptance.md`, `dogfood.md`, `release-checklist.md`.

Pack repositories: section 13.3.

Wording, everywhere: "pack" for what is installed; "module" for what is
loaded, configured, turned on or off, given a key, allowed by the ceiling,
or withdrawn; "top-level module" and "part" where the difference matters.
No text says a pack runs, loads, is on, or has a credential.

## 16. PR plan and estimate

Two implementers, A and B, in parallel. Each line is one PR, with its tests
and its documents; the estimate is developer-days to a reviewable PR.

| PR | Who | Repository | What | Needs | Days |
|---|---|---|---|---|---|
| M1 | B | countinghouse | Settings core: the declaration, effective values, `ctx.settings` on every path, `SETTING_REQUIRED` and `ctx.settingRequired`, the pin, `--moduleSettings`, the validator | – | 3.5 |
| M2 | B | countinghouse | The settings tool's module settings: `module.*` read, set and confirmed, the kind `module`, `reread`; the ceiling reader's `modules` and `moduleSettings` keys; the vectors' kinds | M1 | 3 |
| M3 | A | countinghouse | Credentials: `--remoteCredentials` version 2, the per-module allowance, the short declaration, the validator's output | – | 2 |
| M4 | A | countinghouse | Modules in place: `modules-in-place`, `module-control`, `--modulesRoot`, `--partDir`, the multi-name reload, the visibility set in the loaders, the vectors' `moduleMessages` | M3 | 3 |
| L1 | A | ch-local | The module store, the record, collection, `install`, `add-pack`, `remove-pack`, `status`, the migration; `start` and the applier read the new record and pass `--modulesRoot` and `--partDir`, still deciding pack by pack | M4 | 4 |
| L2 | A | ch-local | `start` and the applier decide by module: availability and its reasons, on and off by module, the multi-name reload, the device-config write removed | L1, L5 | 3 |
| L5 | B | ch-local | Credentials: the store's version 2, the command, the gh offer, `module-credentials`, the pins' version 2, what section 6.9 removes | M3 | 2.5 |
| L3 | B | ch-local | Settings: `settings modules`, `module.*` and `enabled.*` (a stored `pack.*` still read, section 10), unknown names kept, outside edits, the ceiling by module, the session table's kinds | M1, M2 | 3 |
| M5 | B | countinghouse | `pack.*` becomes `enabled.*` in the settings tool, with the kind `enabled`; per-session packs removed: `session-packs` deleted, the session layer and its readers, the vectors' restore rows | M2, M4, L2, L3 | 3.5 |
| L4 | A | ch-local | `upgrade`, the automatic upgrade and `rollback` over every pack; the questions; what holds an automatic upgrade back | L1, L5 | 3.5 |
| P1 | B | ch-pack-ci-failure-triage | `defaultRepo` as a setting | M1, L2, L3 | 0.5 |
| P2 | B | ch-access-github, ch-packs | The short form; the documents | M3, L5 | 0.5 |
| M6 | B | countinghouse | The old forms removed (below), the catalogue's texts, the usage report's `scenario`, the documents | all | 1.5 |
| L6 | A | ch-local | The README, the install pages, the development documents, the acceptance scripts' last changes | all | 1.5 |

Order: A does M3, M4, L1, L2, L4, L6. B does M1, M2, L5, L3, M5, P1, P2,
M6. A is not blocked by B until L2, which needs L5 (B's third PR, due
about when A reaches it).

**Across the two repositories.** ch-local's acceptance run builds
countinghouse's default branch and the pack repositories' default branches,
so a change on one side alone breaks it. Two rules keep it whole:

- A countinghouse PR that changes something ch-local sends or reads keeps
  the old form working beside the new one. M2: the ceiling reader takes
  `modules` and still takes `packs`. M3: version 1 of the credentials file
  stays in any case. M4: the `scenario`, `pack` and `global` fields and
  `--packsRoot` are still read. The ch-local PR that follows moves to the
  new form, and M6 removes the old ones.
- The names in `settings.json` are read and written by both sides, so they
  move in this order: L3 makes ch-local write `enabled.*` and read both
  names (which the migration needs in any case); until M5 the runtime's
  settings tool still writes `pack.<name>`, which ch-local then reads as the
  module's entry. M5 moves the tool to `enabled.*` and removes a session's
  own packs in one step, and merges only after L2 and L3. ch-local's
  session table takes both sets of kinds from L3 until L6.

The shared vectors change in M2 (kinds), M4 (`moduleMessages`) and M5
(restore rows). Each ch-local PR that follows refreshes its copies, which
runs the shim's workflow without changing the shim.

**Estimate.** About 35 developer-days (16.5 in countinghouse, 17.5 in
ch-local, 1 in the pack repositories): about 17 to 18 working days for each
of two implementers, before review rounds.

The earlier estimate for the program was about 25 days. Read against the
code, these parts are larger:

| Part | Earlier | Here | Why |
|---|---|---|---|
| Settings | 9.5 | 10 | `ctx.settingRequired`, and pack 1's `defaultRepo` moved to a setting. |
| Credentials, with the per-module gate | 4 | 5 | ch-local's side is not one command: the store's format, the gate in `start` and in the applier, the pins, and the environment route's removal touch about ten files and the acceptance scripts. |
| Load, unload, reload by module | 3 | 6 | A module two packs list cannot change version in place today; the multi-name reload and the part directories are new. ch-local's applier (438 lines) and its tests (907 lines, 212 mentions of a pack) are rewritten, not renamed. |
| Per-session packs removed | 2.5 | 3.5 | Eight test files exist only for them (about 2,000 lines), and the session-state and restore tests (about 1,000 more) carry pack rows. |
| Module on/off and the ceiling's list | 1.5 | 1.5 | Inside M2, M5 and L3. |
| The store, install, upgrade, rollback | 6.5 | 7.5 | The record, the trees and collection change together; six commands and about 2,900 lines of tests read them. |
| Wording and documents | 1 | 3 | ch-local's README, six install pages and five development documents; countinghouse's security model, reference and module guides; the catalogue in two languages. |
| Bridges between the repositories | – | 1 | Above. |
| Overlap already counted | −3 | −2.5 | |

## 17. The maintainer's answers (2026-11-18)

All three open questions were answered as recommended:
1. **No credential from a client's environment.** Keys come only from
   `ch-local credentials add <module>` (typed, from standard input, or from
   the gh login after a yes). The `COUNTINGHOUSE_GITHUB_TOKEN` /
   `GITHUB_TOKEN` client source is removed; headless and CI setups pipe the
   key on standard input. The docs say so.
2. **Withdrawal is per module.** A module that no pack of the running
   release lists is not started, and the user is told; nothing is deleted,
   and it comes back with an upgrade that lists it again.
3. **A 0.x minor counts as breaking.** For the update question, `0.3 -> 0.4`
   is treated like a major bump (ch-local's own rule), so it asks, and
   automatic upgrades hold back on it.

## 18. Choices made here that the review should check

These are within the decisions, but each is a choice.

1. **`enabled.<package>`**, a name of its own, not `module.<package>.enabled`
   (section 5.1).
2. **A part has an `enabled` entry**, terminal only, and a module that is
   off makes the modules that call it unavailable (section 5.2). The
   narrower choice is on/off for top-level modules only.
3. **A module whose key is not usable is not loaded under ch-local**, for a
   missing key and for a changed destination alike. The earlier note had the
   changed-destination case load, with its remote answering
   `REMOTE_CREDENTIAL_NOT_ALLOWED` at the call. That is still what the
   runtime does by itself (an operator's server, a supervised restart). One
   rule for ch-local is simpler, and a version that changed where its key
   goes does not run until the user has looked.
4. **`ctx.settingRequired`** (section 4.6): one function beyond the
   2026-11-17 design. Without it, a module with a fallback setting writes
   its own error text and command.
5. **The gh offer's two origins** (section 6.8): a fixed list in ch-local,
   for the offer only.
6. **Values in environment slots, bindings in the file** (section 6.4): no
   value on disk from a start, and two modules may use one variable name.
   The price is that a key added later needs a restart, as today.
7. **The pins still describe each module's credentials**
   (section 9.3), as derived data, so that a release can be described
   before it is installed. The guard itself is the store.
8. **`upgrade`'s one question covers a module that crosses a breaking
   change, and the automatic upgrade holds back on it** (section 9.6). The
   looser reading asks only when a caller is left on other pins, which in
   release 1 never happens at an upgrade.
9. **The record's rule**: a module's active version is the highest any
   installed pack was installed with (section 9.2). It gives the update, the
   way back and the "a later pack relied on it" guard with no history of
   updates.
10. **The withdrawn and relisted marks go** (section 9.7); a withdrawn
    module comes back by the upgrade that lists it again, with no
    `add-pack`.
11. **The hidden set** (section 5.5) keeps the guard the session view gave.
    Removing it too would be less code and would leave a module callable
    while it unloads.
12. **A session can turn a module off for every session, on request**
    (section 5.3). It is a tightening, recorded and told, and undone at a
    terminal; an all-sessions cap can already be lowered this way. An agent
    under a prompt injection could use it to take the user's tools away.
13. **Version 1 of `--remoteCredentials` stays** for an operator's server,
    unbound (section 6.5).
14. **No migration of the release rollback's kept record** from the old
    format (section 10).
15. **The usage record's `pack` becomes `scenario`** (section 13.1).
