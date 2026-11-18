# Module-level configuration and install (release 1)

Status: revision 2, 2026-11-18, after the security review of revision 1
(the section below says what changed).
Scope: countinghouse (declarations, the settings tool, credentials on the
remotes path, loading in place, the session layer), ch-local (settings,
credentials, the module store, install, upgrade, start) and the pack
repositories (pack 1's modules).
Read at countinghouse `origin/master` 8552c7d2 and ch-local `origin/main`
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

## Revision 2 (after the security review, 2026-11-18)

A security review of revision 1 found five blocking problems, and the
maintainer made two decisions the same day. All of it is folded into the
sections below, which are the design; this section only says what moved.
The maintainer's answers to revision 1's three open questions are in
section 17.

**The maintainer's two decisions**

1. **Release pins decide.** In a released install every module runs at the
   version the running release pins, up or down: a release can move a module
   back. Upgrades, automatic ones included, install the release's tested set
   without asking. The breaking-version question (a major, or a 0.x minor,
   of a module that other installed modules call) is asked only between
   packs that come from different pins: a development install today, a pack
   from another source later. This replaces revision 1's "a module's active
   version is the highest any installed pack was installed with" for every
   module the running release lists; that rule remains only between packs
   from different pins (sections 5.2, 9.2, 9.4 to 9.6).
2. **Three implementers.** C joins A and B after its sandbox work, about
   twelve working days in. Section 16 is reworked for three, with the order
   problems below fixed.

**The five blocking findings**

| | Finding | Fix | Where |
|---|---|---|---|
| B1 | A credential slot was an ordinary environment variable. A module that declared the slot's name in `permissions.env` would be handed it (`resolveEnv` keeps only `COUNTINGHOUSE_*` from workers, `lib/module-permissions.js:229-241`; under audit a declared name needs no policy, lines 192-198). And the version 2 file could name any environment variable of the runtime, its identity secret included. | Slots are `COUNTINGHOUSE_CREDENTIAL_<n>`. Version 2 has one form and accepts only that pattern. `resolveEnv` also denies every name a credentials allowance reads from. | 6.4, 6.5 |
| B2 | Which version of a module runs, under revision 1's "the highest version any installed pack was installed with". | Replaced by decision 1: the pins decide, and a module that is not at the release's pin is not loaded. | 5.2, 9.2 |
| B3 | A key piped on standard input was bound to whatever origin the installed version declared, and replaced a binding for another origin with nobody looking. | The standard-input path needs `--to <origin>` equal to the declared origin, and never replaces a binding for another origin. Section 12 says plainly that an agent's shell is not "conversation". | 6.2, 12 |
| B4 | A slot was a bare number, a key added or changed later could not be told from the one the runtime started with, and a module turned on later needed a restart. | A slot is (module, variable, origin, source, value digest) and is used only on an exact match with the store as it is now. The applier watches the store and unloads a module whose binding was removed or changed. Every installed module with a usable binding gets a slot at start. | 6.4, 9.8 |
| B5 | The PR order broke between the repositories in four places (a shared runtime refuses a load with no `pack` and `global`; the ceiling's pack was read from the first directory under the root; the settings tool read `packs.json` after ch-local renamed it; ch-local's `set` erased the `module.*` values the runtime had written). | M4 takes a module-form message as global, checks the ceiling by package name and reads both record files; the unknown-names fix is a first, small ch-local PR. | 16 |

**Also adopted from the review**

- A reload loads what it adds before it switches anything, and switches a
  called module before the module that calls it (7.3).
- One reload per step, naming every loaded top-level module whose closure
  changed (7.3, 9.8).
- With `--modulesRoot`, a module is found only among the directories given:
  no search of `node_modules` directories up to the home. The root and link
  checks cover the whole start plan (7.2).
- The hidden set: a failed unload is defined by the module map, and a load
  whose closure holds a module that is still hidden is refused (5.5).
- Migration: the daemon's handoff maps the kind `pack` to `enabled`; a
  leftover `pack.<name>: false` beside `enabled.<module>: true` means off
  (10).
- `additions` also reports a new caller of a module that holds a key, and a
  `confirm` setting that lost its mark or changed its default (9.3).
- Remotes join the manifest pin; a binding covers the whole origin;
  `fallbackEnv` is not read under version 2 and then leaves the vocabulary;
  a version 1 file is refused on a runtime with a control channel; a module
  loaded in place gets its allowance in the message, not in a file (6.1,
  6.5, 7.3).
- The runtime tells ch-local when it stops a module by itself, so `status`
  does not say a stopped module is running (7.3, 9.9).

**Choices changed** (section 18): a part has no on/off of its own; the gh
offer is for `https://api.githubcopilot.com` only; turning a module off from
conversation stays, counted in the session's budget of changes, with the
undo command, the modules that go with it, and "until a terminal" in what is
said.

**The estimate** is about 51 developer-days, not 35 (section 16).

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
   `ch-local credentials add <module>`, typed, or piped on standard input
   with the destination named (`--to <origin>`). The offer to use
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
   pack skips the modules already installed. **A release's pins decide the
   versions**: in a released install each module runs at the version the
   running release pins, whether that moves it up or back, and upgrades
   install the release's tested set without asking. Between packs that come
   from different pins, an update that would move a module that other
   installed modules call across a breaking version (a major, or a 0.x
   minor) asks [y/N], naming those modules. The default is No; without a
   terminal the answer is No and the user is told; any other update installs
   without asking. After a yes every module still loads; ch-local warns and
   says how to go back. Removing the pack that brought the update puts the
   module back to its previous version, unless a pack installed later relied
   on the newer one. Settings are kept across both; a value the older version
   does not declare stays stored and unused. There are no declared version
   ranges (`requires`) in release 1.
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
| pins | The versions a pack is installed from: a ch-local release's, or, in a development install, a pins file's (`--unreleased-pins`). |
| active version | The one version of a module that ch-local gives the runtime: the running release's pin (section 9.2). A runtime holds one version of a module, as today. |
| available | A module that may be loaded: installed, at the version the running release pins, allowed by the ceiling, turned on, its credential usable, and every module it calls available (section 5.2). |
| short name | A package name without its scope (`ch-access-github`). ch-local's commands accept it when exactly one installed module has it. Stored names and the runtime's messages always use the full name. |

## 3. Not in scope (release 1)

- A module turned on or off, or a module setting, for one session only.
- An on/off switch for a part.
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
  store, the record and the update question are written for packs from more
  than one source, but in release 1 every pack comes from the release's
  pins, and only a development install can hold packs from different pins.
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

`enabled.<package name>` in `settings.json`: a boolean, default on, for a
**top-level module**.

- Grammar: `^enabled\.((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)$`,
  the package name at most 214 characters. It replaces `PACK` and
  `PACK_ENTRY` in countinghouse `lib/settings-tool.js:57-62` and ch-local
  `lib/settings.js:52-54`, with the same entry: on/off, default on, guarding,
  applies now, and "off" is the tighter value.
- **A part has no switch of its own.** It runs exactly while a loaded module
  needs it. `ch-local settings set enabled.<part> …` is refused, and says
  what to do: "ch-access-github is a part: it runs while a module that calls
  it is on (ch-pack-ci-failure-triage). Turn that module off instead." An
  `enabled.<part>` entry found in the file (an edit by hand) is ignored with
  a warning. In conversation a part's name answers `SETTING_UNKNOWN`.
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
2. The running release lists it, **at that version** (sections 9.2 and
   9.7). A module the release does not list is withdrawn. A module whose
   installed version is not the release's pin is not loaded either: the
   pins decide, and a version the release moved away from does not run. (A
   development install is exempt, as it is from the withdrawn rule today.)
3. The operator's ceiling allows it (section 8).
4. For a top-level module: `enabled.<module>` is not off.
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
module the user turned off runs, and what is said when it is turned off
names the modules that go with it (section 5.3).

### 5.3 Changing it

**At a terminal:** `ch-local settings set enabled.<module> on|off`.

- Off is a tightening: made at once. ch-local names the modules that call
  it, which are unloaded with it.
- On is a loosening: bound by the ceiling's `modules` list, and asked at the
  terminal ("Loosen enabled.weather-tool from off to on? … [y/N]"), with no
  `--yes`, refused without a terminal. This is `lib/cli-change.js` as it is.
- A part's name is refused (section 5.1).

**In conversation** (`countinghouse_settings`):

- `get` lists one `enabled.<module>` row for each installed top-level
  module: value, default, whether it is loaded, its version, and its listed
  tools. The tool reads the installed modules from ch-local's record beside
  the settings file (section 9.2), as it reads `packs.json` for a pack's
  version today (`packVersion`, `lib/settings-tool.js:367`).
- `set … off` is made on request. It is a tightening, and it applies to
  every session of the user, so four things hold:
  - It is written to `settings.json` under the lock, history line first,
    naming the session that asked. ch-local's running start or daemon sees
    the change and unloads the module.
  - It counts against the budget of 32 changes a session may record
    (`MAX_SESSION_CHANGES`, `lib/settings-tool.js:84`). Past the budget the
    change is the terminal's, as for any other setting.
  - The answer to the agent, and the notice every session gets, say what
    went with it, how to undo it, and that the undo is not the agent's:

    > weather-tool is turned off for all your sessions. trip-planner calls
    > it, so trip-planner is off too. They stay off until weather-tool is
    > turned on at a terminal: `ch-local settings set enabled.weather-tool on`.

  - Turning it back on from conversation is a loosening (next item). With
    no tested client, that ends at the terminal.
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
| The ~15 readers of a session's view | `filterTargetsBySession`, `sessionLists` (`lib/mcp/tool-registry.js:687-692`), `lib/mcp/gateway.js:1461`, `lib/mcp/prompts.js:47-56`, `lib/mcp/resources.js:96-99`, `lib/mcp/subscriptions.js`, `lib/device-manager.js:562, 643, 1994, 2007, 2268`, `lib/peer-channel-broker.js:243, 307, 412, 663`, `lib/module-manager.js:1879` (`sessionViewChanged`), `lib/route-manager.js:156, 343-373`. | Each asks the global set of section 5.5 instead, with no session argument. `sessionViewChanged` stops a per-session worker of a hidden module for every session. |

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

- A hidden module is in no tools, prompts or resources list, and a call, a
  hop, a direct peer channel or a job run that reaches it is refused
  `MODULE_NOT_LISTED`.
- `none()` is true when the set is empty, which is the case on every call's
  path outside a load or unload, so the check costs one boolean, as
  `sessionPacks.none()` does today.
- A part stays unlisted by `mm.unlisted`, as today; a hop to an unlisted
  part is allowed, a hop to a hidden one is not.
- **When an unload has completed** is read from the module map, not from
  the unload's answer. A module is gone when it is out of `mm.modules` and
  nothing of it can come back: no supervisor record, no spawn under way.
  That is what `unloadOne` already ensures for a module that was restarting
  after a crash, or suspended, when its pack went
  (`lib/packs-in-place.js:253-267`), and that case is carried over with its
  tests. A module that is still in the module map after its unload, or
  whose unload answered an error while it was loaded, **failed to unload**:
  it stays hidden until the runtime ends.
- **A load or a reload whose closure holds a module that is still hidden is
  refused** (`CONTROL_FAILED`: "`<module>` is still being unloaded; restart
  your client"). A later request never brings a module that failed to
  unload back into view.

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

Three rules about what a declaration is:

- **A credential's identity is (module, variable).** Its destination is the
  origin of that module's declared URL. One remote per module stays the
  limit in release 1, so a module has at most one credential.
- **`fallbackEnv` goes.** Under a version 2 credentials file (section 6.5)
  the credential is the `env` variable alone, and `fallbackEnv` is never
  read. It is still read under a version 1 file until the declaration stops
  accepting it, in the cleanup PR, after ch-access-github has moved to the
  short form (section 16).
- **The remotes join the manifest pin** (`lib/manifest-pins.js`, which
  covers `calls` today and, with section 4.1, the settings). Today a
  module's remotes are read from disk again at every spawn, a supervised
  restart's included. With the pin, a supervised restart keeps the remotes
  an operator's load took; a module that rewrote its own `package.json`
  under audit gets the pinned declaration, and each difference is logged as
  an error, as an added call is. A load, a reload or an upgrade takes the
  new pin.

### 6.2 Entering one (ch-local)

```
ch-local credentials add <module>                    # at a terminal
ch-local credentials add <module> --to <origin>      # the value on standard input
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
  only when the declared origin is exactly `https://api.githubcopilot.com`
  (section 6.8). The default is No. A yes stores no value: the binding
  records the source `gh`, and each start asks `gh auth token` and holds the
  token in memory, as today (`lib/github-token.js` `ghToken`).
- **The typed value** is read with nothing echoed (`lib/hidden-input.js`).
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

`add` with the value on **standard input** (when standard input is not a
terminal). Nobody is looking at a prompt on this path, so the caller states
the destination and ch-local checks it:

- `--to <origin>` is required, and must equal the origin the installed
  version declares. Without it: "a key on standard input needs
  `--to <origin>`: the address it is for (`ch-local credentials list` shows
  what `<module>` declares). Nothing was stored." With another origin:
  "`<module>` `<version>` sends its credential to `<declared origin>`, not
  the address given. Nothing was stored." A script written when the module
  sent its key to one origin therefore stops, instead of binding the key to
  wherever a later version sends it.
- **It never replaces a binding for another origin or variable.** When the
  store holds one, the standard-input path refuses: "the credential stored
  for `<module>` is for `<old origin>`, and this version sends it to
  `<new origin>`: run `ch-local credentials add <module>` at a terminal to
  allow that. Nothing was changed." Replacing a binding for the same
  destination (a rotated key) is allowed.
- The value is one line, at most 4096 bytes, the line ending removed. There
  is no gh offer and no question.
- `gh auth token | ch-local credentials add ch-access-github --to https://api.githubcopilot.com`
  works, and so does a CI job that pipes a secret. (Today a pipe is refused,
  `lib/credentials-command.js:87`; the decision changes that.) A value is
  never taken from an argument or from the environment.

The rest:

- `list` shows, per binding: the module, the variable, the origin, the
  source (`stored` or `gh login`), and whether the installed version still
  declares that destination. Never a value. For an installed module with no
  binding it shows what the module declares, so that `--to` can be written.
- `remove <module>` removes the module's bindings.
- `add` and `remove` ask a running daemon to restart its runtime (it drains
  first), and say what a session on a runtime of its own will see
  (section 6.4: a changed or removed key unloads the module there at once; a
  new one is taken at that client's next start). The restart request is
  today's behaviour.
- Each is one history line: `{by: 'credentials', module, variable, origin,
  source, how: 'terminal' | 'stdin', change: 'added' | 'replaced' |
  'removed'}`.

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

**A binding covers the whole origin.** It is to a scheme, host and port,
not to a URL. A later version of the module may change the path, the
remote's name, its headers, or the header and scheme the key rides in, and
keep the key; only the variable and the origin are compared. A user who
enters a key for an origin trusts every path on it.

### 6.4 What a start gives its runtime

**Slots.** A value reaches the runtime in its environment, in a variable
named `COUNTINGHOUSE_CREDENTIAL_<n>` (n from 1). The prefix matters: the
runtime never hands a `COUNTINGHOUSE_*` variable to a module's worker,
whatever the module declares and whatever the policy grants
(`lib/module-permissions.js:229-241`). No value is written to disk by a
start. The slots exist because two modules may declare the same variable
name and hold different values; the process environment has one value per
name.

At start, ch-local reads the store once and gives a slot to **every
installed module that has a usable binding** (section 6.7), whether or not
that module is loaded at this start. A module turned on later then loads in
place with its key, with no restart.

For each slot:

1. The value: the stored one, or for `gh` the answer of
   `gh auth token --hostname github.com`, asked once per start, in the home,
   with gh's own token variables removed from its environment, as today.
2. Its identity, kept in the start's memory: **(module, variable, origin,
   source, digest)**, the digest being the SHA-256 of the value. It is never
   written anywhere.
3. A line in the remote credentials file, in the start's run directory:

```json
{"version": 2,
 "modules": {
   "@countinghouse/ch-access-github": {
     "https://api.githubcopilot.com": {"GITHUB_TOKEN": "COUNTINGHOUSE_CREDENTIAL_1"}
   }
 }}
```

Read: for the module `@countinghouse/ch-access-github`, to the origin
`https://api.githubcopilot.com`, the credential it calls `GITHUB_TOKEN` is in
the environment variable `COUNTINGHOUSE_CREDENTIAL_1`.

**A slot is used only on an exact match with the store as it is now.**
Before the applier loads or reloads a module in place, it reads the store
again and compares the module's binding with its slot's identity, all five
parts (for the source `gh`: the four that the store holds). On a match the
module's allowance, naming that slot, goes in the load message
(section 7.3). With no slot, or a slot that no longer matches (a key added,
replaced or re-bound since this runtime started), the module is not loaded,
and ch-local says "`<module>` has a credential the running runtime was not
started with; restart your client to load it". A slot is never given to
another module, another variable or another origin.

**The applier watches the store** (`<home>/credentials/credentials.json`,
beside the record and the settings it watches today). When a loaded
module's binding has been removed, or no longer matches its slot, the
module is unloaded, with the modules that call it, and the sessions are
told: "ch-access-github's credential was removed (or changed); it is
unloaded here until this client restarts". An unload needs no key, so a
removed key stops being used at once, in every running client. The daemon's
shared runtime is also restarted by `credentials add` and `remove`
themselves, as today.

Under an acceptance run's origin map (`CH_LOCAL_REMOTE_MAP`), only a value
that is an acceptance token (`chacc_…`) is given a slot, as today.

### 6.5 The runtime's side

`--remoteCredentials <file>` (`lib/remote/credentials.js` `loadAllowance`):

- **Version 2** has one form:
  `{"version": 2, "modules": {"<package>": {"<origin>": {"<VARIABLE>":
  "COUNTINGHOUSE_CREDENTIAL_<n>"}}}}`. The environment name must match
  `^COUNTINGHOUSE_CREDENTIAL_[1-9][0-9]{0,3}$`, and nothing else is
  accepted, so the file cannot make the runtime send any other variable of
  its environment (its identity secret, say) to an origin. Package names
  follow npm's grammar; an origin is checked as today (scheme, host and
  port; https, or http to loopback); the variable matches the variable
  grammar. Anything else refuses the file. An operator of an HTTP server
  writes the same form and sets `COUNTINGHOUSE_CREDENTIAL_1`, … in the
  server's environment.
- **Version 1** (today's `{"<origin>": ["VARIABLE", …]}`) keeps its meaning
  on an operator's own server: process-wide, read from the variable of that
  name, not bound to a module. **On a runtime with a control channel it is
  refused** (from the cleanup PR on; until ch-local writes version 2 the
  runtime must still take what ch-local sends, section 16).

What changes in the runtime:

- The allowance is kept **per module**: `Map(module → Map(origin →
  Map(variable → environment name)))`. It replaces `packRemotes`
  (`lib/module-manager.js:688`, per module and per pack, merged). It is set
  from the start's file and, for a module loaded or reloaded in place, from
  the `credentials` object in its message (section 7.3: the same shape as
  the file's `modules`, checked the same way; no second file). A module's
  entry is removed when the module is unloaded. A slot belongs, in the
  runtime too, to the first (module, variable, origin) it was named for: a
  later message that names it for anything else is refused.
- `register` (`lib/remote/index.js:82`) resolves a module's credential
  against that module's own entry: the declared variable must be named
  there for the declared origin, and the value is read from the environment
  name beside it. Under a version 1 file every module gets the process's
  allowance, as today.
- **`resolveEnv` denies every name an allowance reads from.** Beside
  `COUNTINGHOUSE_*`, a worker is never given an environment variable that a
  credentials allowance in force reads a value from: under version 1 the
  listed variable names (today a module that declares `GITHUB_TOKEN` in
  `permissions.env` is handed the operator's token under audit); under
  version 2 the slots, which the prefix covers already.
  `lib/module-sandbox-config.js:201` passes the names;
  `deniedEnvNames` notes each one that was declared and denied.
- Everything else on the remotes path is as it is: the value is read and
  attached on the main thread, to the exact origin, on a client of the
  runtime's own with no proxy and no cross-origin redirect; a module's worker
  never sees it.
- With the remotes pinned (section 6.1), a supervised restart resolves the
  pinned declaration against the module's allowance, so it gets the same
  answer as the load did.
- `credentialVariables` (`lib/route-manager.js:70`), which decides the names
  a shared runtime will compare a session's credential against, reads the
  version 1 allowance only. Under version 2 there is no name a session's
  environment can supply (section 6.9), so every name counts as one the
  runtime lacks.

A remote whose credential cannot be resolved is disabled, with one of:

| Case | Code | Message (fields filled by the runtime) |
|---|---|---|
| The allowance names the module, but for another origin or variable | `REMOTE_CREDENTIAL_NOT_ALLOWED` | "{module} {version} sends its credential {variable} somewhere new ({origin}); it gets no key until that is allowed" + the hint |
| The allowance does not name the module | `REMOTE_CREDENTIAL_NOT_ALLOWED` | "no credential is bound to {module} for {origin}" + the hint |
| Allowed, and the slot holds nothing | `REMOTE_CREDENTIAL_MISSING` | as today |

The hint is ": run `ch-local credentials add {module}` at a terminal" on a
runtime started by ch-local (single identity, with a control channel), and
": the operator binds it in the --remoteCredentials file" otherwise. A
tenant of an HTTP server never sees a ch-local command.

On a runtime with a control channel, a module whose remote is disabled is
not loaded: the load is refused with that code (today's rule for a module a
pack loads in place, `lib/module-manager.js:714`). On an operator's server
the module loads and the remote answers the code at each call, as today.

If a supervised restart is refused on a runtime with a control channel
(the slot is empty, or the module's allowance has gone), the module is no
longer running while the home says it should be. The runtime tells ch-local
(`module-stopped`, section 7.3), which takes it out of what it holds as
loaded, tells the sessions, and shows it in `status` (section 9.9).

### 6.6 A new origin or a new variable

The supply-chain guard, with no hand-written list: **a stored key is used
only for the module, the variable and the origin it was entered for.**

- A new version of a module that declares another origin, or another
  variable, has no usable binding. ch-local does not load it (section 6.7)
  and tells the user: "ch-access-github 0.3.0 sends its credential somewhere
  new (https://api.example.com; the stored one is for
  https://api.githubcopilot.com). It gets no key, and is not loaded, until
  you run `ch-local credentials add ch-access-github` again".
- Running `add` again **at a terminal** is the user's yes: it shows the new
  destination and takes the value again (section 6.2). The standard-input
  path cannot do it.
- Nothing else re-binds. An upgrade's yes does not. An automatic upgrade
  does not. A setting does not. Conversation cannot.
- The runtime enforces the same rule by itself (section 6.5), from the
  allowance ch-local wrote out of the store, so the guard does not depend on
  ch-local having noticed the change.
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
| A binding the running runtime was not started with | the sentence of section 6.4 |

A module that calls it is not loaded either, and says which module and why
("not loading ch-pack-ci-failure-triage: it calls ch-access-github, which
needs a credential: run `ch-local credentials add ch-access-github`").
With nothing loadable the runtime still starts and serves its own tools, as
today.

### 6.8 Which origin gets the gh offer

The gh login is a GitHub credential. Offering it for any origin a module
declares would hand the user's GitHub token to that origin on a reflexive
"y". So the offer is made for one origin only, fixed in ch-local:

```
https://api.githubcopilot.com
```

- The comparison is of the whole origin, as the runtime parses the declared
  URL: scheme, host and port. A look-alike host
  (`api.githubcopilot.com.example`, `api-githubcopilot.com`), another port,
  or `http` gets no offer.
- This is not a list of where credentials may go. Any module may declare any
  https origin, and the user may enter a key for it. The origin only decides
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
  the user's exported token. The maintainer confirmed its removal
  (section 17). What that touches:
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
- A load or a reload whose closure holds a module that is still hidden from
  a failed unload is refused (section 5.5).
- The name grammar (`PACK_NAME`, line 57) becomes npm's package grammar.

### 7.2 Where a module's directory comes from

Today a part is found from the scenario's own directory, on Node's search
path (`resolvePart`, `lib/module-roles.js:44`), because a pack's modules
share one `node_modules`. That search looks in a `node_modules` directory
beside every ancestor of the scenario (`nodeModulesFrom`, line 57), so from
a directory under the user's home it reaches `~/node_modules`, and a
package planted there with the right friendly name would be loaded as the
part. In the module store every version has a directory of its own, so
ch-local says where each module is, and the search goes.

- `--modulesRoot <dir>` replaces `--packsRoot`. ch-local passes
  `<home>/module-store`.
- At start: `--loadModule <dir>` for each top-level module, as today, and
  `--partDir <dir>` (new, repeatable) for each part's directory.
- In a control request: `dirs`, the directory of each module of the closure.
- **With `--modulesRoot`, a called module is looked for only among the
  directories given**, by the module's own `api.json` friendly name, as
  `resolvePart` matches today. There is no fallback to any `node_modules`
  directory. One that is not among them is `PART_MISSING`.
- **The root and link checks cover the whole start plan.** Every directory
  the start loads, top-level or part, must lie inside `--modulesRoot` by
  real path, with no link leading out (`insideRoots` and `linkOut`, which
  today run only for a pack loaded in place, `planFor`). A directory that
  fails is not loaded, and neither is a top-level module whose closure holds
  it; the runtime logs why and tells ch-local (`module-stopped`,
  section 7.3). A control request's directories are checked the same way, as
  today.
- The runtime reads each directory's own `package.json`; a name in a
  request that is not the package's is refused. Two given directories that
  hold the same module are refused.
- Without `--modulesRoot` (a developer loading a checkout, an operator's
  server), today's lookup is unchanged.

### 7.3 Control messages

ch-local to the runtime, on the control channel (`lib/control-channel.js`;
`lib/pack-control.js` becomes `lib/module-control.js`):

```
{id, type: 'load',   name: '<top-level package>', dirs: {'<package>': '<absolute dir>', …},
                     credentials?: {'<package>': {'<origin>': {'<VARIABLE>': 'COUNTINGHOUSE_CREDENTIAL_<n>'}}},
                     notice?: '<text>'}
{id, type: 'reload', names: ['<top-level package>', …], dirs: {…}, credentials?: {…}, notice?: '<text>'}
{id, type: 'unload', name: '<top-level package>', notice?: '<text>'}
{id, type: 'reread', what: 'module-settings'}
{id, type: 'notice', module: '<package>' | null, text: '<text>'}
{id, type: 'set', name, value}                       // the runtime's own settings, as today
```

Replies are as today: `{id, ok: true, tools: […]}` for load, reload and
unload; `{id, ok: false, code, message}` otherwise.

The runtime to ch-local, unasked (no id, as the session table's tells):

```
{type: 'module-stopped', name: '<package>', code: '<code>', when: 'start' | 'restart'}
```

- **load**: loads the modules of the closure that are not loaded, the
  top-level module listed, the others unlisted. Refused when the name is
  loaded already, when a directory is outside `--modulesRoot` or has a link
  out, on `PART_MISSING`, `PART_VERSION_CONFLICT`, a tool or prompt name
  already taken, a module of the closure still hidden from a failed unload,
  or when the ceiling does not allow a module of the closure (section 8). A
  failure part-way unloads what the request loaded.
- **`credentials`** on a load or reload is the allowance of the modules in
  `dirs` that have a key: the same shape as the `modules` object of the
  version 2 file, checked the same way (section 6.5). It replaces the
  per-pack credentials file a load names today (`remoteCredentials`,
  `lib/packs-in-place.js:122`). The slot it names must exist in the
  runtime's environment from its start.
- **reload**: brings the named loaded top-level modules, and their closures,
  to the directories given. It is today's `reloadPack`, over the union of
  the named modules' closures instead of one pack's, in this order:
  1. The plan is made and checked whole. Any problem refuses the request
     with nothing changed.
  2. **What the new closures add is loaded first** (hidden, section 5.5).
     Today a reload walks its modules in closure order, the scenario first,
     so a scenario's new version could be serving before a part it newly
     calls was loaded.
  3. Each module at another version is drained, then switched, **a called
     module before the module that calls it**. A module at the same version
     stays as it is.
  4. What the new closures no longer hold, and no other record holds, is
     unloaded.
  - All or none: a failure switches back what was switched and unloads what
    was added (`CONTROL_PACK_UNCERTAIN`, renamed `CONTROL_MODULE_UNCERTAIN`,
    when that fails too).
  - **A module changes version only when every loaded top-level module that
    holds it is named in the same request.** Otherwise the request is
    refused `PART_VERSION_CONFLICT`. This is what lets a module two packs
    list move to another version in place, which today's per-pack reload
    cannot do (it is refused, and ch-local falls back to a reinstall).
  - ch-local sends **one reload per step**, naming every loaded top-level
    module whose closure changed in that step: a member's version, or its
    membership. Two parts that changed, held by different sets of modules,
    still make one request, naming the union of their holders.
- **unload**: unloads the named top-level module and each of its modules no
  other record holds. Never refused by the ceiling. Its completion is read
  from the module map (section 5.5).
- **reread**: the runtime reads the `module.*` values of `--settingsFile`
  again, checks each against its module's declaration and the ceiling, and
  applies them. The reply lists what was refused: `{applied: <count>,
  refused: [{name, code}]}`.
- **notice**: said once to every open session, on the next result of that
  module's tools (or of any tool, for `null` or a module no longer loaded).
- **module-stopped**: the runtime says that a module the home wants loaded
  is not running by the runtime's own doing: a top-level module of the
  start plan it refused (`when: 'start'`, with the load's code), or one whose
  supervised restart was refused or gave up (`when: 'restart'`). ch-local
  takes it out of what it holds as loaded, tells the sessions, records it in
  the history and in its `run.json`, and `status` shows it (section 9.9).
  Without it ch-local would go on saying a stopped module is on.

Removed:

- `scenario`, `pack` and `global` on load and reload, the rule that a
  shared runtime sets a pack's "global" value from the message, and
  `remoteCredentials`.
- `set pack.<n> true`.
- The runtime's asks `load-pack` and `unload-pack`. `may-elicit` stays.

`TYPES` (`lib/control-channel.js:21`) gains `reread`. Operations stay
serialised on the channel's one chain.

**While the session view still exists** (until PR M5, section 16), a shared
runtime takes a module-form load or reload as **global**: it records the
unit in the session view under its package name and sets it global, so
every session lists it. Today a shared runtime refuses a load that has no
`pack` and no boolean `global` (`packOf`, `lib/pack-control.js:48-52`), and
reads the ceiling's pack from the first directory below the root
(`chLocalPackOf`, `lib/packs-in-place.js:137`), which in the module store
would be `@countinghouse`. A module-form message is never judged by either:
it is checked against the ceiling by each module's package name.

### 7.4 What a session is told

Every change to what is loaded is said, as today (`lib/notices.js`):

- loaded, reloaded (with the versions), unloaded, turned on, turned off: the
  text ch-local sends with the request;
- on a shared runtime, to every open session, once. There is no audience to
  work out. A session that opens later is not told about earlier changes;
- a module's settings changed by another session (section 4.4);
- a module the runtime stopped by itself (`module-stopped`).

### 7.5 The shared wire vectors

`docs/superpowers/specs/shared-runtime-wire/vectors.json` (and
`make-vectors.js`, which generates it) change in these places:

| Entry | Change |
|---|---|
| `packMessages` | Replaced by `moduleMessages`: the shapes of section 7.3, a package-name pattern, the slot pattern, accepted cases (a load with and without `credentials`, a reload of two names that share a part, a reload of three names over two shared parts, an unload, a reread, a notice with and without a module, a `module-stopped`) and refused ones (no `dirs`, a directory that is not absolute, a name that is not a package name, `names` empty, a `credentials` environment name that is not a slot, a leftover `pack`, `global` or `remoteCredentials` field once the old form is removed). |
| `restoreRows` | Kinds are `maxOutputBytes`, `requestTimeout`, `enabled`, `module`. The accepted rows that carry a `pack.*` override or the kind `pack` move to the refused list. |
| `control.record`, `control.replay` | Unchanged (a session's replay holds the two caps only, `lib/sessions.js:114`). |
| `githubTokenPrecedence` | Rewritten for section 6: the stored binding and the gh source only. |
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

### 9.2 The record, and which version is active

`<home>/modules.json` replaces `<home>/packs.json` (`lib/record.js`):

```json
{
  "v": 2,
  "runtime": {"versions": {"@countinghouse/ch-local": "0.9.0", "countinghouse": "8.0.0"}},
  "release": {"version": "0.9.0", "security": null},
  "unreleased": false,
  "packs": {
    "ci-failure-triage": {
      "from": {"release": "0.9.0"},
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

- **`packs.<pack>.from`** says which pins the pack was installed from:
  `{"release": "<ch-local version>"}`, or, for a development install,
  `{"unreleased": "<the first 16 hex digits of the pins file's SHA-256>"}`.
- **`packs.<pack>.modules.<module>`** is the version of that module the pack
  was installed with.
- **`modules.<module>`** is derived from `packs`: the highest version any
  installed pack records for the module (in a released home, the one they
  all record), and that version's `countinghouse.role` (`scenario`, `part`,
  or `null`). ch-local writes it so that readers need no version arithmetic
  (the runtime's settings tool reads a module's version and role from it),
  and the reader refuses a record whose `modules` is not what its `packs`
  give.

**Which version is active:**

1. **In a released home the pins decide.** For a module the running release
   lists, the active version is the release's pin, and the record must agree
   with it. Every operation under a
   release (`install`, `add-pack`, `upgrade`) writes that release's pins into
   every pack it touches, and `install` and `upgrade` touch every installed
   pack, so in a released home the packs' recorded versions and the pins
   agree. When a release pins a lower version than the one installed, the
   module moves back: a release can withdraw a version by pinning the one
   before it. A module whose recorded version is not the pin (a record
   edited by hand, an operation that was cut short) is not available
   (section 5.2, rule 2): "not loading `<m>`: `<version>` is installed and
   this release pins `<pin>`; run `ch-local install` again".
2. **Between packs from different pins** the active version is the highest
   that any installed pack was installed with. This happens when the home
   is a development one (`unreleased: true`: packs installed from different
   pins files), and will happen when a pack can come from another source.
   Installing a pack can raise a module's version (section 9.4 asks first
   when that is a breaking change). Removing that pack lowers it again,
   unless another pack was installed with the higher version (section 9.5).

A module the running release does not list is withdrawn (section 9.7).

Other fields:

- `held`: packs that a release rollback's restored release does not have,
  as today (`{from, modules}`): recorded, named by `status`, never loaded,
  removed by `remove-pack`. The marks `withdrawn` and `relisted` go
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
   "@countinghouse/ch-pack-ci-failure-triage": {
     "credentials": [],
     "calls": ["@countinghouse/ch-access-github", "@countinghouse/ch-step-redact", "…"],
     "confirmSettings": {}},
   "@countinghouse/ch-access-github": {
     "credentials": [{"variable": "GITHUB_TOKEN", "origin": "https://api.githubcopilot.com"}],
     "calls": [],
     "confirmSettings": {}}
 },
 "pins": {"…": "as today: one version, integrity and build identity per package"}}
```

- `packs.<pack>.modules` replaces `packages`. Its order means nothing any
  more: a module's role comes from its own manifest, not from being first.
- Each pack's `credentials` and the top-level `allowedOrigins` are gone.
- `modules.<package>` **describes** each package of each pack, from the
  package's own manifest: the credentials its remotes declare, the modules
  it calls (as package names), and each setting it marks `confirm: true`
  with that setting's default. The release step that writes the pins writes
  it; nobody writes it by hand.
- It is **not** a list of what is allowed. The store's binding says where a
  key may go (section 6.6), and the runtime checks calls and settings from
  the manifests it loads. The description exists so that a release can be
  compared with the one installed before anything is fetched. `install`
  refuses a package whose manifest differs from its description, so what was
  shown is what is installed.
- `additions(now, next, installed)` reports, for the installed packs and
  modules:
  - a module added to an installed pack;
  - a credential destination that is new or changed for an installed
    module;
  - **a new caller of a module that holds a key**: a module of an installed
    pack that newly calls a module with a credential, whether the caller is
    new or its `calls` grew. More code can now ask for calls made with the
    user's key;
  - **a `confirm` setting that lost its mark, or whose default changed.**
    The author had said this setting needs the user's own yes; a release
    that drops the mark or flips the default changes it without one.

  Each of these is shown by `ch-local upgrade` before its question, and
  holds an automatic upgrade back (section 9.6).
- `identityChanges` is unchanged apart from the key names.
- This is a breaking change of the pins' format: a ch-local that reads
  version 1 refuses version 2. It is acceptable only because no release has
  been published (the pins at `origin/main` are empty). After the first
  release the format must only grow in ways an older reader accepts, or the
  upgrade path breaks; that constraint is for a later design.

### 9.4 `install` and `add-pack`

**In a released home** there is nothing to decide per module. The pack's
modules are installed at the release's pins:

- a module that is not installed is placed;
- a module that is installed at the pin is skipped ("it shares
  ch-access-github with the packs already installed");
- there is no third case, because every installed module the release lists
  is at its pin (section 9.2).

`install --pack <name>` installs this release's runtime, adds the pack, and
brings every pack already in the home to this release's pins, **up or down,
without a question**: the release is a tested set. It no longer drops the
other packs (`lib/install.js:388`). `add-pack` still needs the installed
runtime to be this release's.

**Between packs from different pins** (the home is a development one, or
the pack being added comes from other pins than the installed ones), each
module of the pack is taken by this table, with `p` the pack's pinned
version and `a` the module's active version in the home:

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
differ, or both are 0.x and their minor versions differ (for 0.0.x, their
patch versions), which is the rule ch-local's own upgrade has (`breaking`,
`lib/npm-upgrade.js`). It is applied here and nowhere else: a released
upgrade never asks (section 9.6).

"Installed modules that call it" are read from the installed modules'
`countinghouse.calls`, the names before the slash, matched by friendly name
as the runtime matches them.

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

- The history gets one line for the answer (`{by: 'cli', module, from, to,
  callers, answer}`).

In release 1 only a development install (`--unreleased-pins`) reaches this
table: every released pack comes from the one release, and its pins. The
tests reach every row that way. The mechanism is built now because the
decisions ask for it, and it is what a pack from another source will meet.

Then, on both paths, as today: the record is written, what no record or
running start needs is collected, the credential conversation of
section 6.2 runs, and a running start applies the change in place
(section 9.8).

### 9.5 `remove-pack`, and the way back

`remove-pack <name>` removes the pack from the record. Then, for each module
the pack recorded:

- **No other installed pack records it**: it leaves the record. Its files go
  once no running start uses them and no rollback can need them
  (section 9.10).
- **In a released home, another installed pack records it**: nothing
  changes. Its version is the release's pin, with or without this pack.
- **Between packs from different pins**, the active version is worked out
  again (section 9.2, rule 2):
  - the remaining packs record only lower versions: the module goes back to
    the highest of those. This is the rollback the maintainer asked for:
    "put back ch-access-github 2.0.0 -> 1.4.0 (it was updated when
    weekly-report was installed)";
  - a pack installed later was installed with the newer version: it
    recorded that version, so the module stays, and remove-pack says why:
    "ch-access-github stays at 2.0.0: the pack monthly-report was installed
    with it".

  Both are one computation; no history of updates is kept.

What is kept:

- **Settings.** `module.<module>.*` and `enabled.<module>` are not touched by
  an update, a rollback, a release that moves a module back, or a removal.
  Under the older version, a value for a setting it does not declare stays
  stored and unused, and comes back with the newer version (section 4.2).
- **The stored credential.** remove-pack says "the credential stored for
  `<module>` is kept: `ch-local credentials remove <module>` removes it"
  when it removes a module that has one. After a move to a version that
  declares another destination, the module is not loaded until
  `credentials add` is run at a terminal (section 6.6).
- **The previous version's files**, while any installed pack, a held pack,
  the release rollback's record or a running start names them.

A running start applies the change in place: one reload naming every loaded
top-level module whose closure changed (section 7.3).

### 9.6 `upgrade`, the automatic upgrade, and the release rollback

**A release is a tested set, and is installed as one.** `ch-local upgrade`
moves the runtime and every installed module to the new release's pins in
one operation, whichever way each version moves. No module's version is
asked about: not a major, not a 0.x minor, not a version that goes back.
The refusal of a home with more than one pack goes (`lib/upgrade.js:77`).

- The preview lists, beside what it lists today: each installed module
  whose version changes, saying so when it moves back; what `additions`
  reports (section 9.3); each installed module the release no longer lists
  (section 9.7).
- Its one question, "Upgrade to `<version>`? (yes/no)", at a terminal only,
  is the one it asks today for any upgrade.
- After the install: "upgraded ch-local `a` -> `b`; `ch-local rollback`
  undoes it".

**The automatic upgrade** (`lib/auto-apply.js`) installs the release's set
the same way, after its 72-hour wait, and never answers a question. Beside
what holds it back today (another major or a 0.x minor of ch-local itself,
an identity change, the wait), it announces and leaves to `ch-local upgrade`
a release for which `additions` reports anything:

- a module added to an installed pack (today's "a package in `<pack>`");
- a credential destination that is new or changed;
- a new caller of a module that holds a key;
- a `confirm` setting that lost its mark or changed its default.

A module's version moving, forward or back, does not hold it back. All of
this is decided from the new release's pins and the home's own record,
before anything is fetched. The refusal of a home with more than one pack
goes (`lib/auto-apply.js:82`).

**`ch-local rollback`** (to the release the last install replaced) keeps its
mechanism: the app and the record are swapped with the kept ones, journalled
(`lib/rollback.js`). The kept record is `<home>/previous/modules.json`. A
pack only the newer release's record has becomes `held`. The module store
keeps every version either record names. Settings and credentials are not
touched, as today. After it, the running release is the older one, and its
pins decide.

### 9.7 Withdrawn modules

Today a pack that the running release does not list is not started, and an
upgrade moves it to `held` with a mark (`lib/packs.js` "Withdrawn packs",
`lib/install.js` `carriedHeld`). With the pack gone as a unit, the rule is
per module and needs no mark. The maintainer confirmed it (section 17).

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
- **A module dropped from one pack but still listed by another pack of the
  release is not withdrawn.** It stays installed, at the release's pin, and
  loads as before, whether or not the pack that now lists it is installed:
  the release still ships it. It stays recorded under the pack that brought
  it, and `remove-pack` of that pack removes it if no other installed pack
  records it. The upgrade's preview says "ch-step-redact is no longer part
  of the pack ci-failure-triage in this release; it stays installed".
- A development install (`unreleased: true`) is exempt, as today.

### 9.8 `start`, and the running applier

**At start** (`lib/start.js`), in today's order:

1. The record is read under the home's lock, and `run.json` is written
   naming every active module version, so that nothing this start may load
   is collected (`loaded: {"<module>": "<version>"}`; today
   `{"<pack>": "<key>"}`).
2. The settings and the ceiling are read and checked as today.
3. Availability is worked out for every installed module (section 5.2),
   the version against the release's pin included. Each module that is not
   available is said once, with its reason.
4. Credentials: a slot for every installed module with a usable binding,
   loaded now or not (section 6.4).
5. The runtime is started with `--loadModule <dir>` for each available
   top-level module, `--partDir <dir>` for each part one of them needs,
   `--modulesRoot <home>/module-store`, `--remoteCredentials <file>`, and
   the rest as today. `--deviceConfigPath` still names the start's own empty
   directory, so that the runtime never reads a device config from the
   client's working directory; nothing is written into it.
6. `PATH_OPTIONS` (line 253), which a shared runtime's start checks against
   the home, takes `--modulesRoot` and `--partDir` in place of `--packsRoot`.

**While it runs** (`lib/in-place.js`), on a change of `modules.json`,
`settings.json` or the credential store:

1. Work out the wanted set again: each available top-level module, its
   closure, and each module's active version. A module whose binding no
   longer matches its slot is not available here (section 6.4).
2. Compare with what is loaded, and apply in three steps, one request at a
   time, each with its notice and its history line, as today:
   - **unloads**: each loaded top-level module that is no longer wanted,
     with its reason as the notice ("turned off", "removed", "withdrawn",
     "its credential was removed");
   - **one reload**, naming every loaded top-level module whose closure
     changed: a member at another version, a member added or gone
     (section 7.3);
   - **loads**: each wanted top-level module that is not loaded, with its
     allowance when its slot matches.
3. A change against another runtime version than the one this start spawned
   waits for the next start, as today.
4. A changed `module.*` value: `reread` (section 4.3).
5. A `module-stopped` from the runtime: the module is taken out of what the
   start holds as loaded and out of `run.json`'s `loaded`, recorded there as
   `stopped: {"<module>": "<code>"}`, said to the sessions and written to
   the history.

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
  tracker-access 0.4.0              on; stopped in a running client (REMOTE_CREDENTIAL_NOT_ALLOWED): restart that client
packs:
  ci-failure-triage                 9 modules
```

- A module that would not load says why, with the same sentence a start
  tells a session (section 11).
- `status` reads the home, and also the `run.json` of each start that is
  alive (as collection does). A module that a running runtime stopped by
  itself (`module-stopped`, section 7.3) is shown as stopped there, with the
  code, so `status` never reports a module as running in a client where it
  is not.

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
| `<home>/packs.json` | `<home>/modules.json` | By `install` and `upgrade`, in the operation that installs a ch-local of this design. Each recorded pack becomes a pack entry with its packages as modules and `from` set to the release being installed (that install brings every module to its pins); `credentials` is dropped; a held pack marked `withdrawn` or `relisted` becomes an ordinary pack entry (section 9.7 decides whether its modules load); a pack held after a rollback stays held. `packs.json` is removed once `modules.json` is written. A `start`, `add-pack`, `remove-pack` or `status` that finds `packs.json` and no `modules.json` says "this home was made by an earlier ch-local; run `ch-local install` again", as `lib/record.js` already says for the format before it. |
| `<home>/packs/<pack>/<key>/…` trees | `<home>/module-store` | The same install places every module in the store from its pinned tarball. The old trees are not converted. They are collected once no running start names them (a start from before has the old `run.json` shape, which collection still reads) and they are not the rollback target. |
| `<home>/previous/packs.json` (the release rollback's kept record, old format) | none | `ch-local rollback` refuses it: "the kept release predates the module store, so it could not return you here; install it again instead". This is the wording and the rule rollback already has for a kept release from before rollback existed. |
| `pack.<name>` in `settings.json` | `enabled.<package>` | The install or upgrade that migrates the record rewrites each `pack.<name>` as `enabled.<the pack's scenario module>` in the same operation, under the settings lock, with a history line `{by: 'migration', setting, was}`. Until then, and for one left over (a file edited by hand), ch-local's reader takes `pack.<name>` for that entry. **Off wins**: with a leftover `pack.<name>: false` beside `enabled.<module>: true`, the module is off. A terminal `ch-local settings set enabled.<module> on` (asked and confirmed as any loosening) removes the leftover in the same write, so the "on" then holds. A `pack.<name>` whose pack the home does not have is kept as an unknown name. The runtime's settings tool keeps a `pack.*` name as an unknown one. |
| `<home>/credentials/credentials.json` version 1 (`{values: {VARIABLE: {value, module}}}`) | version 2 | Read-time: an entry reads as a binding for its recorded module, to `https://api.githubcopilot.com` (the only origin ch-local ever sent it to), under whichever of `COUNTINGHOUSE_GITHUB_TOKEN` and `GITHUB_TOKEN` (the two names that origin was allowed) the installed module declares; source `stored`. The first `credentials add` or `remove` rewrites the file as version 2. |
| A session's pack rows and the kind `pack` (the daemon's table, a restore) | the kind `enabled`; no pack rows | The new daemon's `seed` (the handoff from the daemon it replaces) **maps the kind `pack` to `enabled`** wherever it appears: in a row's `locks` and `unanswered`, and in the declines. A user who declined a form three times stays locked out of the form that replaces it. It drops each `pack.*` override, and marks the session to be told once: "tools are turned on and off for all your sessions now; `<module>` is on. Turn it off with `enabled.<module>`". The new runtime refuses a restore that still carries a `pack.*` row or the kind `pack` (`CONTROL_BAD_RESTORE`), after which the table starts over, every kind is locked for a window (today's rule for a restore that cannot be read), and each session's shim replays its tightened caps. |
| The ceiling's `"packs"` | `"modules"` | Not migrated: the operator rewrites the file. Until then it is not trusted and no module loads (section 8). |
| A version 1 `--remoteCredentials` file from ch-local | version 2 | Nothing to migrate: the file is written at each start. From the cleanup PR on, a runtime with a control channel refuses version 1 (section 6.5). |
| `lib/release-pins.json` version 1 | version 2 | Not migrated: no release carries version 1 pins with content. |
| `{defaultRepo}` in a start's device config | `module.<scenario>.defaultRepo` | Nothing is stored today (it is derived at each start), so there is nothing to move. |
| Usage records' `pack` field | `scenario` | The reader accepts both. |
| A GitHub token in a client's configuration (`COUNTINGHOUSE_GITHUB_TOKEN`) | the store | Not moved by ch-local (it does not read client configurations for secrets). A start that sees the variable set says once: "COUNTINGHOUSE_GITHUB_TOKEN in this client's environment is no longer read: run `ch-local credentials add <module>`". |

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
| A module is not at the version the release pins | start, applier, status | "not loading `<m>`: `<version>` is installed and this release pins `<pin>`; run `ch-local install` again" |
| No credential, another destination, gh gave none, the store fails | start, applier, status | section 6.7 |
| A module calls one that is not available | start, applier, status | "not loading `<m>`: it calls `<n>`, which `<n's reason>`" |
| A module's files are missing from the store | start | "not loading `<m>`: its files are missing; run `ch-local install` again" |
| Nothing is loadable | start | "no module is loaded this start; only ch-local's own tools (settings, the usage report) are served" |
| A module's key was added, replaced or re-bound since this runtime started | applier | "`<m>` has a credential the running runtime was not started with; restart your client to load it" |
| A loaded module's key was removed or changed | applier | "`<m>`'s credential was removed (or changed); it is unloaded here until this client restarts" |
| The runtime stopped a module by itself | applier, status | "`<m>` stopped (`<code>`); restart your client", and `status`'s line (section 9.9) |
| A module is turned off from conversation | every session's notice | section 5.3: what went with it, the undo command, "until … at a terminal" |
| `enabled.<part>` at a terminal | `settings set` | section 5.1 |
| A key on standard input without `--to`, with another origin, or over a binding for another destination | `credentials add` | section 6.2 |
| A load whose closure holds a module that failed to unload | applier | "`<m>` is still being unloaded; restart your client" |
| A load, reload or unload is refused by the runtime | applier | "`<notice>`: not applied in place (`<code>`); restart your client to apply it" (today's line) |
| An unload fails | runtime | The module stays hidden (section 5.5); logged; the applier says the line above |
| Question A or B with no terminal, or answered No (between packs from different pins only) | install, add-pack | section 9.4 |
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
   runtime's main thread only (`lib/remote/`), as today. It sits in the
   runtime's environment under `COUNTINGHOUSE_CREDENTIAL_<n>`, a name no
   worker is ever given, whatever a module declares in `permissions.env` and
   whatever the policy or audit mode grants; and `resolveEnv` denies every
   other name a credentials allowance reads from (section 6.5). The version 2
   file can name only such a slot, so it cannot be made to send another
   variable of the runtime. Settings are not secrets, and the declaration
   vocabulary has no secret type; the validator warns on a setting that
   looks like one. Values are never written to the settings file, the
   history, a notice, a log or a run directory.
2. **A key goes only where the user entered it for.** The binding is
   (module, variable, origin). ch-local writes the runtime's allowance from
   the store, and the runtime checks the module's pinned declaration against
   it. A slot is used only on an exact match of module, variable, origin,
   source and value with the store as it is now, so a key is never given to
   another module, never used after it was removed or replaced, and never
   re-used for another destination (section 6.4).
3. **A new origin or variable gets no key.** A compromised release cannot
   redirect a stored key: its new destination has no binding. Only
   `credentials add` at a terminal makes one, and it shows the destination
   before it asks. An upgrade's yes, an automatic upgrade, a setting,
   conversation and the standard-input path cannot.
4. **The gh login is offered for one origin**, compared whole, and never
   used without a yes for that module.
5. **The release's pins decide what runs.** A module that is not at the
   version the running release pins is not loaded, so a release that moves a
   module back takes effect on every home that installs it, and no earlier
   install can keep a newer or an older version running.
6. **No setting widens the sandbox.** A module setting is data the module
   reads; it reaches no policy, permission, ceiling, route or price. A
   `hostname` or `url` value must already be inside the module's granted
   `net`. `enabled.<module>` turns on only what is installed, at the
   release's pin, and on the ceiling's list.
7. **Conversation cannot loosen by itself.** Turning a module on, and every
   string setting, needs the user's own confirmation, on a client tested to
   show it to a person, or else a terminal. A credential has no
   conversational path at all. The settings tool is not reachable from module
   code. Text in a form is the runtime's; hints carry no values; package
   names in hints are npm-grammar names.
8. **An agent with a shell is not "conversation", and is not stopped by
   it.** "Conversation" in this design means the `countinghouse_settings`
   tool. An agent whose client lets it run commands can run `ch-local`
   itself. What stands there is different, and is stated so that nothing
   claims more:
   - A loosening (`enabled.<module> on`, a raised cap, a `confirm` setting)
     and the questions of section 9.4 are asked at a terminal, with no
     `--yes`, and refused without one. That stops a command run without a
     terminal; it does not stop an agent that has a terminal.
   - `credentials add` on standard input takes a key the caller already
     holds. It can only store it for the destination the installed module
     declares, named in `--to`; it cannot replace a binding for another
     destination; it cannot read a stored key back. So it cannot move the
     user's stored key anywhere.
   - `credentials remove`, turning a module off, and a tightened cap are
     tightenings, made on request by anyone who can run the command.
   - Beyond that, the user's consent to what an agent's shell runs is the
     client's own command-approval prompt, as
     `2026-11-14-guarding-settings-by-conversation-design.md` already says
     for settings. ch-local records every change in the history, which the
     agent's tool cannot edit.
9. **An automatic upgrade never says yes.** It installs a release's tested
   set only when nothing needs the user: it does not take a release that
   changes a credential's destination, adds a module, adds a caller of a
   module that holds a key, drops a `confirm` mark or changes such a
   setting's default, changes an identity, or is a major of ch-local; and it
   never binds a credential.
10. **Fail closed.** A ceiling that is not trusted loads no module. A
    settings file that is not valid stops the start. A credentials store
    that fails its checks is not used. A module that is going on or off is
    hidden, one that failed to unload stays hidden, and nothing loads it
    again. A module no pack of the release lists, or one at another version
    than the pin, does not load. A `pack.<name>: false` left from before
    keeps its module off, even beside an `enabled` entry that says on. A
    restore the runtime cannot check is refused whole.
11. **What is installed is what was pinned.** Tarballs are checked against
    their pins and provenance before anything is written, as today; a store
    version is reused only with the pin's integrity; a package's manifest
    must match the pins' description of it. With `--modulesRoot` a module is
    loaded only from a directory ch-local named, inside the root by real
    path, with no link out, at start as in place; nothing is found by
    searching `node_modules` directories.
12. **A module's own declaration is pinned.** Its calls, its settings and
    its remotes are taken at an operator's load and kept across a supervised
    restart, so a module that rewrites its `package.json` gains no call, no
    dropped confirmation and no new destination.
13. **Files modules cannot read**: the whole ch-local home (settings, the
    record, the credentials, the store but for a module's own directory, the
    run directories), as today. `--moduleSettings` is refused to modules like
    the policy file.
14. **Every change is recorded** in `history.jsonl` first: a setting, an
    on/off (with the session that asked), a credential added, replaced or
    removed (never its value, and whether at a terminal or on standard
    input), an answer to question A or B, a module loaded, reloaded,
    unloaded or stopped.

Limits that this design does not change, stated so that no document claims
more:

- Another program running as the user can read the stored credentials and
  the runtime's environment, as it can read gh's own token.
- A module can still open outbound connections of its own until the network
  broker exists. The key does not reach the module, but data a remote gave
  it can be sent on.
- A module that is allowed to call a module with a key can have calls made
  with that key, within what the keyed module's tools do. `calls` bounds who
  that is, and a release that adds such a caller is shown and never taken
  automatically.
- A binding is to an origin: every path on it.
- A version 1 `--remoteCredentials` file on an operator's server is not
  bound to a module.
- Under `--moduleSandbox audit` a module can rewrite its own `package.json`;
  the pins hold until the next operator's load, and each difference is
  logged.
- A session can turn a module off for every session of the user. It is
  recorded, said to every session with the way to undo it, and counted in
  that session's budget of changes.

## 13. Code areas that change

### 13.1 countinghouse

| File | What changes |
|---|---|
| `lib/settings-tool.js` | `PACK`, `PACK_NAME`, `PACK_ENTRY`, `entryOf` (57-62): the `enabled.*` grammar and entry; `entryOf` also answers `module.*` from the module's declaration. `conversationMayAsk` (150) and `CEILING_KIND` (200) take `enabled.*`. `ceilingRefusal` (303) reads the ceiling's `modules`. `FORM_TEXT` (321): the `pack` and `session.pack` sentences go; the `enabled` sentence (section 5.3) and the module-setting sentence (section 4.4) come, en and zh. `packsThisStart`, the pack branch of `effectiveOf` (360), `packUnloaded` (476): removed. `packVersion` (367): a module's version and role from `modules.json`; until the cleanup PR it reads `packs.json` when `modules.json` is not there, because ch-local renames the record before the tool's pack code goes. `MAX_SESSION_CHANGES` (84): an `enabled` off counts on a runtime with one session too. `applyConfirmed` (415): the `load-pack` and `unload-pack` asks go; a confirmed "on" is written to the file. `get` (656): one `enabled` row per installed top-level module, and the module settings with a cursor. `set` (685): `enabled.*` and `module.*`, keeping unknown names on every write. `setForSession` (877) and the session branch of `confirm` (1523): the two caps only. `setForAll` (1249): also `enabled.*` and `module.*`. `applyThisStart` (1471), `formOrRefusal` (1491): no pack case. `applyControlSet` (1755): unchanged for the runtime's own settings; the new `reread` handler sits beside it. The tool's description and input schema (1793). |
| `lib/settings-confirm.js` | `kindOf` (50) and `KINDS` (58): `enabled` and `module` in place of `pack`. |
| `lib/settings-ceiling.js` | `KEYS` (37): `modules` and `moduleSettings` in place of `packs`; their checks; the problem text for a leftover `packs`. |
| `lib/module-settings.js` (new) | The declaration's vocabulary and checks, the format checkers, effective values and their versions, the stored-value check, `--moduleSettings`. |
| `lib/manifest-pins.js` | The settings declaration and the remotes join the pin (sections 4.1 and 6.1); a difference at a supervised restart is logged, as an added call is. |
| `lib/lean-worker.js`, the invoke message, `lib/device-manager.js`, `lib/peer-channel-broker.js`, the task and job paths | `ctx.settings` delivery on every path (section 4.5); `ctx.settingRequired`; the pre-handler `SETTING_REQUIRED` check over the call graph. |
| `lib/session-packs.js` | Deleted. |
| `lib/module-visibility.js` (new) | Section 5.5. |
| `lib/session-settings.js` | `PACK` (50), `globalPack`, the pack branches of `set`, `effective` and `isLoosening`, `dropPack` (413), `packOnAllowed` (222), `packOverridesOf` (430): removed. |
| `lib/session-state.js` | `KINDS` (134), the pack override rows (150, 281, 330), the restored pack "on" (370-400): removed; kinds as section 5.4. |
| `lib/session-transport/restore.js` | `KINDS`, `PACK`, `overrideProblem`: caps only; the new kinds. |
| `lib/sessions.js`, `lib/job-sessions.js` | `packsOffOf`, `sessionEnded`'s `packsOff`, `packsOffFor`, `sessionPacks.forget` (sessions.js 65-80; job-sessions.js 88-95): removed. |
| `lib/packs-in-place.js` → `lib/modules-in-place.js` | Sections 7.1 to 7.3: `readRequest` (`dirs`, `names`, `credentials`; no `scenario`, no `remoteCredentials` file, line 122), `ceilingRefusal` by each module's package name, the records without `pack` and `allowance`, `heldElsewhere` over a set of excepted names, `planFor` (211) over several named modules and over the start plan, `reloadPack` generalised with additions first and callees before callers, the refusal of a still-hidden module, `unloadOne`'s result read from the module map, `addAllowance` and `removeAllowance` replaced by the per-module allowance, `chLocalPackOf`, `packNameOf`, `packRecords`, `loadedVersionOf` removed. While `lib/session-packs.js` exists, a module-form request is recorded there as global. |
| `lib/pack-control.js` → `lib/module-control.js` | Section 7.3: no `pack`, `global`, audience or `set pack.<n>`; a notice to every session. `packOf` (48) no longer refuses a shared runtime's module-form load. |
| `lib/control-channel.js` | `TYPES` (21) gains `reread`; `tell` carries `module-stopped`. |
| `lib/route-manager.js` | `credentialVariables` (70); the control channel's handlers; `configureSessionPacks` (343) and its call (469) go, the visibility set's `onChange` takes the subscriptions' hook (156). |
| `lib/module-roles.js` | `resolvePart` (44), `closureOf`, `expandLoadList` take the given directories; with `--modulesRoot` there is no search (`nodeModulesFrom`, 57, is not used); `refusedWhy`'s wording (section 7.2). |
| `lib/module-manager.js` | `unlisted` recomputed from the records (97, 436); `packRemotes`, `START_ALLOWANCE`, `mergedAllowance`, `registerRemotes` (688-724): the per-module allowance; `sessionViewChanged` (1879) reads the visibility set; `startPlan` (415-420) is checked against `--modulesRoot` and seeds `loadedUnits`; a refused start-plan module and a refused or abandoned supervised restart are told to ch-local (`module-stopped`). |
| `lib/cli-options.js`, `framework.js` | `--modulesRoot` in place of `--packsRoot` (222-227), `--partDir`, `--moduleSettings`; their checks. `lib/fs-broker/index.js` `protectedPaths` and `lib/hardened-launch.js` learn `--moduleSettings`. |
| `lib/remote/declaration.js` | The default `transport` (185) and the string `credential` (`parseCredential`, 115); `fallbackEnv` leaves `CREDENTIAL_FIELDS` in the cleanup PR. |
| `lib/remote/credentials.js` | `loadAllowance` (18): version 2 in its one form, the slot pattern; version 1 refused on a runtime with a control channel (cleanup PR). `resolveCredential` (44): the module's own entry and its slot. The set of names any allowance reads from, for `resolveEnv`. |
| `lib/module-permissions.js`, `lib/module-sandbox-config.js` | `resolveEnv` (module-permissions.js 235) and `deniedEnvNames` (231) also deny every name a credentials allowance reads from; `module-sandbox-config.js:201` passes them and notes each denied name. |
| `lib/remote/index.js` | `register` (82): the allowance by module, the pinned remotes at a supervised restart, the two `NOT_ALLOWED` cases and the hint. |
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
| `lib/settings.js` | **First, as its own PR (L0):** `setSetting` (166) writes only the names it knows, and `resetSettings` (192) removes the file, so today a terminal change erases every `module.*` value the runtime's tool wrote. Both keep every name they do not write; a bare reset leaves `module.*`. Then: `PACK`, `packEntry`, `entryOf` (52-54): `enabled.*` for top-level modules (a part's name refused, section 5.1), and `module.*` checked with the installed runtime's reader. `readSettings` (70): unknown names are kept apart, not dropped. `listSettings`: modules, not packs. The `pack.*` mapping, with off winning and a terminal "on" removing the leftover (section 10). |
| `lib/settings-command.js` | `settings modules`, `set <module>.<setting>` with a prompted value, `reset <module>[.<setting>]`, short names. |
| `lib/outside-edits.js` | The `module.*` and `enabled.*` rules; a cut value compared by its hash. |
| `lib/ceiling.js` | `packAllowed`, `packRefusal`, `notAllowed`, `packName`: by module, over every module of a pack at install. |
| `lib/session-table.js` | `KINDS`, `PACK`, `overrideOk`: caps only, the new kinds; `seed` maps the kind `pack` to `enabled` in locks, unanswered and declines, drops pack overrides and marks the session (section 10). |
| `lib/credential-store.js` | Version 2 (section 6.3), the wider value grammar, the version 1 reading. |
| `lib/credentials-command.js` | Section 6.2: `<module>`, the declaration shown, the gh offer for the one origin, `--to` and the standard-input rules, `list`, `remove`. |
| `lib/github-token.js` | `ghToken` stays. `chooseGitHubToken` goes. |
| `lib/module-credentials.js` (new) | For the installed modules: each one's usable binding or its reason, the values, the slots and their identities, the version 2 file's content, the allowance for a load message, and whether a slot still matches the store (sections 6.4 and 6.7). start and the applier call it at one place each. |
| `lib/conditions-command.js` | `chosenToken`, `chosenCredentials` go; `token` is always null and `credentials` absent (section 6.9). |
| `lib/snippets.js`, `lib/uninstall.js` | No credential variable is forwarded by a client entry; uninstall names the stored credentials by module, and its list of the home's own names gains `modules.json` and `module-store`. |
| `lib/release-pins.json`, `lib/release-pins.js`, `lib/allowlist.js`, `lib/pins.js` | Section 9.3: `packs.<pack>.modules`, the `modules` description (credentials, calls, confirm settings), `additions` (140) with its two new reports. `ALLOWED_ORIGINS` goes. The release step that writes the pins writes the description. |
| `lib/record.js` | Section 9.2: the shape, `from`, the active-version rule and the check of the derived `modules`; reading the old file only to migrate it. |
| `lib/home.js` | `layout`: `moduleStore`, `record` (`modules.json`), `previousRecord`. |
| `lib/pack-dir.js` → `lib/module-store.js` | Section 9.1: place, skip, the marker. |
| `lib/unpack.js` | `unpackInto` places one package into a version directory; `checkManifest` also checks the declared credentials against the pins. |
| `lib/install.js` | `install`, `installLocked`: every installed pack kept and brought to the release's pins, up or down, with no question; between packs from different pins, the table and questions of section 9.4; a package's manifest checked against the pins' description; `carriedHeld` and the `runtimeOnly` path's withdrawn marks go; `credentialLines` becomes the credential conversation; the migration. |
| `lib/packs-command.js` | `addPack` (the shared-module path, 66-79, becomes section 9.4), `removePack` (section 9.5), `status` (section 9.9, reading each live start's `run.json` for stopped modules). |
| `lib/packs.js` | `installedPacks` becomes the installed modules and their closures; `declaredRemotes` per module; `credentialUnion`, `loadablePacks` go; the withdrawn lines by module; availability (section 5.2) lives here or in a file beside it. |
| `lib/start.js` | Section 9.8, and what section 6.9 removes: `GITHUB_VARIABLES` (41), `chooseCredentials` (227), the token block (364-403), the pack filters and the credential gate (456-474), `credentialUnion` and its refusal (497-505), the device-config write (523-531), `--loadModule` per pack (581), `--packsRoot` (594), the `load-pack` and `unload-pack` handlers (679-680), `PATH_OPTIONS` (253). The watch (681) takes `modules.json`, `settings.json` and the credential store. `run.json` gains `stopped`. |
| `lib/in-place.js` | Section 9.8: the wanted set; unloads, one reload per step, loads; the slot match before a load; the unload of a module whose binding went; `reread`; `module-stopped`. `thisStart`, `confirmed`, `loadPack`, `unloadPack`, the "now global" step, `credentialsFor`'s origin list, its per-pack file and its device config are removed. |
| `lib/control.js` | `teller`: a notice names a module, not a pack. |
| `lib/upgrade.js`, `lib/auto-apply.js`, `lib/npm-upgrade.js` | Section 9.6: every pack, the release's set installed with no version question, the preview (a version that moves back said so), `additions` as what holds an automatic upgrade back; the `several-packs` refusals go (upgrade.js 77, auto-apply.js 82). |
| `lib/rollback.js` | The record's new shape and name; `held` by pack; the refusal of an old-format kept record. |
| `lib/gc.js` | Section 9.10; both `run.json` shapes. |
| `scripts/acceptance.js`, `scripts/shared-acceptance.js`, `scripts/dogfood.js` | Credentials through `credentials add` on standard input; the store's layout; module names in what they assert. |
| `bin/ch-local.js` | The usage text and the argument checks for `credentials` and `settings`. |
| `shim/tests/vectors/contract-2.json`, `test/vectors/*.json` | Refreshed copies (section 7.5). |
| `clients/claude-code/skills/ci-failure-triage/SKILL.md` | How the token is given. |

### 13.3 The pack repositories

| Repository | What changes |
|---|---|
| ch-pack-ci-failure-triage | `package.json`: `countinghouse.settings.defaultRepo` (`string`, format `repo`). `lib/repo.js` and the handler: the input's `repo`, else `ctx.settings.defaultRepo`, else `ctx.settingRequired('defaultRepo')`; `DeviceConfig` is read last until ch-local's start stops writing it (section 16, rule 6), and then no longer. `api.json`: the tool's description tells the agent to pass the repository of the project it is working in. Tests, README. |
| ch-access-github | `package.json`: the short remote form, `"credential": "GITHUB_TOKEN"`, with no `fallbackEnv`. README: `ch-local credentials add ch-access-github`. Its version changes, and the migration of section 10 covers the stored token. |
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
  naming the session; the answer and every session's notice name the modules
  that went with it, the undo command, and "at a terminal"; the 33rd change
  of a session is refused as the terminal's. On answers
  `SETTING_NEEDS_CONFIRMATION` with no tested client, and with a tested one
  shows the form naming the module and version, writes on a yes, and refuses
  on a version changed meanwhile.
- A shared runtime: one session's off applies to every session; no session
  can hold a module on or off for itself (a `set` with a session scope is an
  all-sessions change); a restore row with a `pack.*` override or the kind
  `pack` is refused; the shared vectors' rows.
- Availability: each of the six reasons, and the "it calls … which …"
  sentence for a module two levels up. A module whose recorded version is
  not the release's pin is not loaded, and says so.
- A part: `enabled.<part>` is refused at a terminal, naming the modules that
  call it; one written into the file by hand is ignored with a warning and
  the part still loads; in conversation it answers `SETTING_UNKNOWN`.
- A top-level module that another calls, turned off: the caller is not
  loaded, and both are named.
- Visibility: a tool is not listed and not callable while its module's
  parts are still loading; a module whose unload fails (it is still in the
  module map) stays unlisted and refuses a call, a hop, a peer channel and a
  job run; a later load whose closure holds it is refused; `none()` is true
  outside those windows (the call path reads one boolean).
- Carried over from the pack form: a module that is restarting after a
  crash, or suspended, when it is unloaded does not come back by its
  restart, listed or unlisted (`test/session-runtime/08`,
  `test/sessions/19`'s restart cases, in module form).
- `mm.unlisted` after loading and unloading a module that is both loaded
  for itself and called by another.
- Migration of kinds: a handoff with the kind `pack` in locks, unanswered
  and declines comes out as `enabled`, and the lock still holds; a leftover
  `pack.x: false` beside `enabled.<its module>: true` keeps the module off;
  a terminal "on" removes the leftover and the module then loads.

**Credentials (section 6).**
- The declaration: the short form and the default transport parse to the
  expanded form; the validator prints it; a wrong form's fix line.
- **The probe (B1).** A module declares `COUNTINGHOUSE_CREDENTIAL_1` in
  `permissions.env`, and a second declares the variable a version 1
  allowance reads (`GITHUB_TOKEN`). Under audit with no policy, under
  enforce with `approve: as-declared`, and with the name granted in the
  policy's `env`, neither worker's environment holds the value, and the
  denial is noted at the spawn. A version 2 file whose environment name is
  `COUNTINGHOUSE_IDENTITY_SECRET`, `PATH`, or a slot written with another
  pattern refuses the start.
- The runtime: a version 2 allowance binds a key to one module, so a second
  module that declares the same variable and origin gets nothing; a module
  that declares another origin, or another variable, gets nothing, with each
  of the two messages; two modules with one variable name and two values
  each send their own; a slot named for one module and then, in a later
  message, for another is refused; a version 1 file on a runtime with a
  control channel refuses the start, and on an operator's server behaves as
  today; a malformed version 2 file refuses the start.
- The pin: a module that rewrites its remote's URL under audit and restarts
  under supervision runs with the pinned remote, the key goes only to the
  bound origin, and the difference is logged.
- **A supervised restart that is refused on a runtime with a control
  channel** (its slot emptied): the runtime tells `module-stopped`, the
  sessions are told, and `status` shows the module as stopped in that
  client, not as running.
- ch-local `credentials`: `add` shows the origin before it asks; hidden
  input; a value never appears in output, history or a log (searched for);
  a binding for another destination is said, and the value is asked again;
  `list` and `remove`; an argument that is no module's name is not echoed.
- **Standard input (B3).** Without `--to`: refused. With `--to` another
  origin than the declared one: refused. After an upgrade that changed the
  module's origin: `--to <old origin>` is refused (not what is declared),
  and `--to <new origin>` is refused too while the store holds the binding
  for the old one, naming the terminal. A rotated key for the same
  destination is stored. A long line and an empty one are refused.
- **The gh offer.** Made for `https://api.githubcopilot.com`; not made for
  `https://api.githubcopilot.com.example`, `https://api-githubcopilot.com`,
  `https://api.githubcopilot.com:8443`, `http://api.githubcopilot.com`, or
  `https://api.github.com`; only at a terminal, only with a login, default
  No.
- The gate: each row of section 6.7, and the module that calls it.
- **Slots (B4).** A module that is off at start has a slot, and loads in
  place with its key when turned on, with no restart. `credentials add`
  with another value while the module is loaded: it is unloaded in that
  client, and is not loaded again there until the client restarts.
  `credentials remove`: it is unloaded at once, and the stand-in for its
  origin sees no further request. A key added for a module that had none at
  start: "restart your client". The digest is in no file.
- An upgrade that changes a module's origin: the preview says it; the
  automatic upgrade does not take it; after a manual upgrade the module is
  not loaded and the sentence is told; `credentials add` at a terminal
  brings it back.
- No value is in the run directory or in any control message.
- The version 1 store read as section 10 says.
- No environment route: a `GITHUB_TOKEN` in the client's environment is
  sent nowhere; the conditions line has `token: null`.

**Loading in place (section 7).**
- load, reload, unload by module through the control channel, with `dirs`;
  a directory outside `--modulesRoot`, a link out, a name that is not the
  package's, two directories for one module: each refused.
- **The start plan**: a `--loadModule` or `--partDir` directory outside
  `--modulesRoot`, or with a link out, is not loaded, its top-level module
  is not loaded, and `module-stopped` is told.
- **A planted part.** With `--modulesRoot`, a package in `~/node_modules`
  (and in a `node_modules` beside the store) whose friendly name is a
  called part's is not found: the load answers `PART_MISSING`. Without
  `--modulesRoot` today's lookup still finds a sibling.
- A part two loaded modules hold: a reload naming both switches it once; a
  reload naming one is refused `PART_VERSION_CONFLICT`; a failure part-way
  puts both back.
- **Two shared parts with different holders** (X held by S1 and S2, Y held
  by S2 and S3, both changed): one reload naming S1, S2 and S3 switches
  both; ch-local sends exactly one.
- **A reload that adds a part, under load.** While calls to the scenario
  run in a loop, a reload to a version that calls a new part completes with
  no call answered `CTX_CALL_UNRESOLVED`: the part is loaded before the
  scenario switches. A called module is switched before its caller.
- Ref-counting: unloading one of two modules that share a part keeps the
  part; unloading the second unloads it.
- The ceiling's `modules` at a load in place: a closure with one module not
  listed is refused, naming it.
- **A module-form message on a shared runtime while the session view still
  exists** (before M5): accepted without `pack` or `global`, listed to every
  session, and checked against the ceiling by package name, with the store
  path's first directory (`@countinghouse`) playing no part.
- `credentials` in a load message: taken as the module's allowance; one
  with an environment name that is not a slot is refused.
- `reread`: a changed `module.*` value applies; an invalid one is in the
  reply's `refused`, with a notice and a history line.
- The shared vectors' `moduleMessages`, on both sides.

**Install (section 9).**
- The store: place, the marker, a version with no marker never loaded and
  collected, a second install of the same version neither fetches nor
  unpacks (asserted on the fetch and on the directory's times).
- **The pins decide.** In a released home `add-pack` asks nothing and
  places only what is missing. An upgrade to a release that raises a called
  module across a major, and one that raises a 0.x minor, install with no
  question beyond the upgrade's own.
- **A lowered pin.** An upgrade to a release that pins a lower version of a
  module than the one installed moves it back, in place, with the notice
  "rolled back"; its settings are untouched; a value only the newer version
  declared is unused. A home whose record names another version than the
  pin does not load that module and says to run `install` again.
- Between packs from different pins (development pins files): each row of
  section 9.4's table. Question A and B: the text names the module, both
  versions and the callers; default No; no terminal refuses with exit 2; a
  No changes nothing on disk; a yes updates, every module loads, and the two
  lines are printed.
- remove-pack: a module only it lists leaves; in a released home a shared
  module is unchanged; between different pins the active version goes back,
  and stays when a later pack was installed with it, the line saying which;
  the settings file is byte for byte the same before and after.
- upgrade with two and three packs. The automatic upgrade installs a
  release whose only changes are versions, whichever way they move; it holds
  back, with its announcement, for each of: a module added to an installed
  pack, a credential destination changed, a new caller of a module that
  holds a key, a `confirm` mark dropped, a `confirm` setting's default
  changed.
- Withdrawn: a module no pack of the release lists is not started, and is
  said; a module that calls it is not started; a release that lists it again
  shows it as an addition. A module dropped from one installed pack and
  still listed by another stays installed and loaded, and the preview says
  so.
- Release rollback with the new record; a kept record in the old format
  refused.
- Migration: a home with `packs.json`, pack trees, `pack.x: false` and a
  version 1 credential, upgraded: the pack that was off stays off at every
  step, the token still works, the old trees go once no start uses them.
- Collection: every version a pack records is kept; one that nothing names
  goes; a running start's versions stay.
- The pins: version 2 parses; a package whose manifest differs from the
  pins' description (a credential destination, a call, a `confirm` setting)
  is refused at install; `additions` for each of its reports.
- **First PR (L0):** with `module.x.y` in the settings file, a
  `ch-local settings set requestTimeout 20s` and a bare `reset` both leave
  it there.

**End to end** (ch-local's acceptance, CI only): pack 1 installed, the
credential entered on standard input with `--to`, `defaultRepo` set in
conversation, one triage call, the module turned off and on with no
restart, the credential removed and the module seen to stop, an upgrade in
place.

## 15. Documents to update

countinghouse:

- `docs/module-development.md`: "Module settings" (new: the declaration,
  `ctx.settings`, `ctx.settingRequired`, where authors should put a setting);
  "Calling a remote MCP server" (the short form, the per-module binding).
- `docs/module-authoring.md`: the validator's new output.
- `docs/security-model.md`: credentials (bound per module; version 2 and
  its slots, which no worker is given; the pinned remotes; the limits of
  section 12), what an agent's shell can and cannot do (section 12, item 8),
  the release's pins deciding what runs, the settings pin under audit, the
  ceiling's `modules` and `moduleSettings`, every "pack" that means a
  running unit.
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

- `README.md`: packs as install lists, modules as what runs; a release's
  pins as the versions that run; `status`; `credentials add <module>` and
  `--to` for a piped key; `settings modules`; what a removed or changed key
  does to a running client.
- `docs/install/README.md` and the five client pages: how the GitHub token
  is given (the stored binding or the gh login; no variable in a client's
  configuration).
- `docs/development/settings.md`: the names `enabled.*` and `module.*`, the
  rule that both writers keep unknown names, `reread`.
- `docs/development/auto-upgrade.md`: the pins' version 2 and its
  description of each module, the release as a tested set (no question
  about a module's version, a pin that moves back), what holds an automatic
  upgrade back.
- `docs/development/acceptance.md`, `dogfood.md`, `release-checklist.md`.

Pack repositories: section 13.3.

Wording, everywhere: "pack" for what is installed; "module" for what is
loaded, configured, turned on or off, given a key, allowed by the ceiling,
or withdrawn; "top-level module" and "part" where the difference matters.
No text says a pack runs, loads, is on, or has a credential.

## 16. PR plan and estimate

Three implementers. A and B start on day 1; C joins on about day 13, after
its sandbox work. Days are working days counted from the program's start
(2026-11-18 as day 1 if A's and B's queues are clear; otherwise everything
of theirs shifts by what they still hold). Each line is one PR, with its
tests and its documents; the estimate is developer-days to a reviewable PR.

| PR | Who | Repository | What | Needs | Days |
|---|---|---|---|---|---|
| L0 | A | ch-local | `settings set` and `settings reset` keep every name they do not write (`lib/settings.js:166, 192`) | – | 0.5 |
| M1 | B | countinghouse | Settings core: the declaration, effective values, `ctx.settings` on every path, `SETTING_REQUIRED` and `ctx.settingRequired`, the pin, `--moduleSettings`, the validator | – | 5 |
| M2 | B | countinghouse | The settings tool's module settings: `module.*` read, set and confirmed, the kind `module`, `reread`; the ceiling reader's `modules` and `moduleSettings` keys; the vectors' kinds | M1; merges after L0 | 3.5 |
| M3 | A | countinghouse | Credentials: version 2 with the slot pattern, the per-module allowance, `resolveEnv`'s denial, the remotes in the pin, the short declaration, the validator's output | – | 3.5 |
| M4 | A | countinghouse | Modules in place: `modules-in-place`, `module-control`, `--modulesRoot` and `--partDir` with no search and the start plan checked, the multi-name reload in its order, `credentials` in the message, the visibility set, `module-stopped`, the vectors' `moduleMessages`; and the bridges below | M3 | 5 |
| L5 | B | ch-local | Credentials: the store's version 2, the command with `--to`, the gh offer, `module-credentials` with the slots and their identities, the pins' version 2 and the release step that writes it, what section 6.9 removes | M3 | 4.5 |
| L1a | A | ch-local | The module store, the record with `from` and the active-version rule, collection, the migration, `install` (the pins decide); `start` and the applier read the new record and pass `--modulesRoot` and `--partDir`, still deciding pack by pack | M4 | 4 |
| L3 | C | ch-local | Settings: `settings modules`, `module.*` and `enabled.*` for top-level modules (a stored `pack.*` still read, off winning), outside edits, the ceiling by module, the session table's kinds and the handoff's mapping | L0, M1, M2 | 3 |
| P1 | C | ch-pack-ci-failure-triage | `defaultRepo` as a setting: the input, then the setting, then (until L2 has merged) the device config | M1 | 0.5 |
| P2 | C | ch-access-github, ch-packs | The short form; the documents | M3, L5 | 0.5 |
| L2 | A | ch-local | `start` and the applier decide by module: availability with the version check, on and off, slots matched against the store, the store watched, one reload per step, `module-stopped`, the device-config write removed | L1a, L5 | 4 |
| M5 | B | countinghouse | `pack.*` becomes `enabled.*` in the settings tool, with the kind `enabled` and the budget; per-session packs removed: `session-packs` deleted, the session layer and its readers, the vectors' restore rows | M2, M4; merges after L2 and L3 | 5.5 |
| L4 | C | ch-local | `upgrade`, the automatic upgrade and `rollback` over every pack: the release's set with no version question, the preview, `additions`' two new reports | L1a, L5 | 4.5 |
| L1b | A | ch-local | `add-pack`, `remove-pack` and `status` by module; between packs from different pins, the table, the two questions and the way back | L1a, L2 | 3 |
| M6 | B | countinghouse | The old forms removed (below), the catalogue's texts, the usage report's `scenario`, the documents | M5, L2, L5, P2 | 2 |
| L6 | A | ch-local | The README, the install pages, the development documents, the acceptance scripts' last changes, the session table's old kinds removed | all | 2 |

**Who does what, and when.**

| | Order | Busy until about |
|---|---|---|
| A | L0, M3, M4, L1a, L2, L1b, L6 | day 22 |
| B | M1, M2, L5, M5, M6 | day 21 |
| C (from day 13) | L3, P1, P2, L4 | day 22 |

- B starts M5 on day 13 and has it ready about day 18; it merges once L2
  (about day 17) and L3 (about day 16) are in.
- The longest chain is A's: M3, M4, L1a, L2. Nothing of B's or C's waits on
  it before day 13.
- L5 and L1a both change `lib/start.js` and are due the same day. L5 keeps
  its change there to one call into `lib/module-credentials.js` and merges
  first.
- All sixteen PRs are ready for review by about **day 22** (about
  2026-12-17 on five-day weeks from 2026-11-18), before review rounds and
  the acceptance run.

**Across the two repositories.** ch-local's acceptance run builds
countinghouse's default branch and the pack repositories' default branches,
so a change on one side alone breaks it. The order above holds because of
these rules, each of which answers one of the review's order problems:

1. **L0 merges before M2.** Until L0, a `ch-local settings set` rewrites the
   settings file from the names it knows, and would erase every `module.*`
   value the runtime's tool had written.
2. **M3 still takes a version 1 credentials file on a runtime with a control
   channel**, because ch-local writes version 1 until L5. M6 refuses it.
3. **M4 takes both forms of a load, reload and unload**, and reads
   `--packsRoot` and `--modulesRoot`. For a module-form message, while the
   session view still exists:
   - a shared runtime does not refuse it for having no `pack` and no boolean
     `global` (today's `packOf`); it records the unit in the session view
     under its package name, as global, so every session lists it;
   - the ceiling is checked by each module's package name against `modules`,
     never by the first directory below the root (which in the store is
     `@countinghouse`); an old-form message keeps today's check against
     `packs`.
4. **M4 makes the settings tool read `modules.json`, and `packs.json` when
   that is not there**, because L1a renames the record before M5 removes the
   tool's pack code.
5. **The names in `settings.json`** are read and written by both sides, so
   they move in this order: L3 makes ch-local write `enabled.*` and read
   both names (which the migration needs in any case); until M5 the
   runtime's tool still writes `pack.<name>`, which ch-local reads as the
   module's entry. M5 moves the tool to `enabled.*` and removes a session's
   own packs in one step, and merges only after L2 (the applier no longer
   answers `load-pack`) and L3. ch-local's session table takes both sets of
   kinds from L3 until L6.
6. **P1 merges before L2**: the scenario reads the device config last until
   the start stops writing it; that read is removed with L6.
7. **M6 removes what the bridges kept**: the old message fields and
   `remoteCredentials`, `--packsRoot`, the ceiling's `packs`, version 1 on a
   runtime with a control channel, `fallbackEnv`, and the reading of
   `packs.json`.

The shared vectors change in M2 (kinds), M4 (`moduleMessages`) and M5
(restore rows). Each ch-local PR that follows refreshes its copies, which
runs the shim's workflow without changing the shim.

**Estimate.** About **51 developer-days**: 24.5 in countinghouse, 25.5 in
ch-local, 1 in the pack repositories.

Revision 1 said 35. The review counted about 50, from the number of test
files that exercise a pack (33 in countinghouse, 57 in ch-local) and its own
reading of the larger PRs. This count agrees with it. Where the 16 days
come from:

| Part | Revision 1 | Now | Why |
|---|---|---|---|
| M1 settings core | 3.5 | 5 | Delivery on six paths each needs its own test under the latency gate; the pin, `--moduleSettings` and `ctx.settingRequired` are each a small feature. |
| M2 settings tool | 3 | 3.5 | |
| M3 credentials, runtime | 2 | 3.5 | The slot pattern, `resolveEnv`'s denial and its probe, the remotes in the pin. |
| M4 modules in place | 3 | 5 | The start plan's checks, the reload's order, the hidden set's new rules, `module-stopped`, and three bridges. |
| M5 enabled and the session layer | 3.5 | 5.5 | Eight test files exist only for per-session packs and more carry pack rows; the settings tool has about seventy lines that mention a pack. |
| M6 cleanup | 1.5 | 2 | More bridges to remove. |
| L0 | – | 0.5 | New. |
| L1 store, record, install (L1a + L1b) | 4 | 7 | The record, the trees, collection and five commands change together, with about 1,250 lines of tests; two version rules instead of one. |
| L2 start and applier | 3 | 4 | Slots and their match, the store watched, `module-stopped`. |
| L3 settings, ch-local | 3 | 3 | L0 took a part; the handoff's mapping and "off wins" added one. |
| L4 upgrades | 3.5 | 4.5 | No questions to build, but `additions` grows and the pins describe every module; five test files, about 1,800 lines. |
| L5 credentials, ch-local | 2.5 | 4.5 | `--to` and its refusals, the slots' identities, the pins' version 2 and the release step, about ten files for the environment route. |
| L6 documents | 1.5 | 2 | |
| P1, P2 | 1 | 1 | |

## 17. The maintainer's answers (2026-11-18)

Revision 1 asked three questions. All three were answered as recommended,
and two decisions followed the security review.

1. **No credential from a client's environment.** Keys come only from
   `ch-local credentials add <module>` (typed, from standard input with
   `--to`, or from the gh login after a yes). The
   `COUNTINGHOUSE_GITHUB_TOKEN` / `GITHUB_TOKEN` client source is removed;
   headless and CI setups pipe the key on standard input. The docs say so.
2. **Withdrawal is per module.** A module that no pack of the running
   release lists is not started, and the user is told; nothing is deleted,
   and it comes back with an upgrade that lists it again. A module that one
   installed pack no longer lists, but another pack of the release still
   does, is not withdrawn: it stays installed at the release's pin and loads
   as before (section 9.7).
3. **A 0.x minor counts as breaking, where the question is asked.** For the
   update question, `0.3 -> 0.4` is treated like a major bump (ch-local's
   own rule). After decision 4 the question is asked only between packs
   from different pins, so that is the only place this applies: a released
   upgrade, automatic or not, installs a 0.x minor of a called module with
   the rest of the release and does not hold back on it.
4. **Release pins decide** (after the review). In a released install each
   module runs at the version the running release pins, up or down. A
   release's set is installed as tested, without a question about any
   module's version. The breaking-version question remains only between
   packs from different pins (sections 9.2 to 9.6).
5. **Three implementers** (after the review). C joins A and B after its
   sandbox work (section 16).

## 18. Choices made here that the review should check

These are within the decisions, but each is a choice. The security review
of revision 1 looked at the first fifteen; what it changed is marked.

1. **`enabled.<package>`**, a name of its own, not `module.<package>.enabled`
   (section 5.1).
2. **On and off is for top-level modules only** (changed by the review: a
   part had an entry of its own in revision 1). A top-level module that is
   off still makes the modules that call it unavailable, and what is said
   when it is turned off names them (sections 5.1 to 5.3).
3. **A module whose key is not usable is not loaded under ch-local**, for a
   missing key and for a changed destination alike. The runtime by itself
   (an operator's server) loads the module and answers
   `REMOTE_CREDENTIAL_NOT_ALLOWED` at the call.
4. **`ctx.settingRequired`** (section 4.6): one function beyond the
   2026-11-17 design.
5. **The gh offer is for `https://api.githubcopilot.com` only** (changed by
   the review: revision 1 also listed `https://api.github.com`), compared as
   a whole origin (section 6.8).
6. **Values in `COUNTINGHOUSE_CREDENTIAL_<n>` slots, bindings in the file or
   the message** (changed by the review: the name, the slot's identity, a
   slot for every installed module with a usable binding). No value on disk
   from a start. A module turned on later needs no restart; a key added or
   changed later does, and a changed or removed one unloads its module at
   once (section 6.4).
7. **Version 2 of the credentials file has one form** (new). Revision 1 let
   an operator list variable names to be read from the environment under
   the same names. An operator now sets `COUNTINGHOUSE_CREDENTIAL_<n>` too,
   so that no file can name another variable of the runtime.
8. **The pins describe each module** (its credentials, its calls, its
   `confirm` settings) as derived data, so that a release can be compared
   before it is installed. The guards themselves are the store and the
   runtime (section 9.3).
9. **The record's two rules** (replaced by the maintainer's decision): the
   release's pin in a released home; the highest version any pack was
   installed with only between packs from different pins (section 9.2).
10. **The withdrawn and relisted marks go** (section 9.7); a withdrawn
    module comes back by the upgrade that lists it again, with no
    `add-pack`.
11. **The hidden set** (section 5.5), with a failed unload read from the
    module map and never loaded again (added by the review).
12. **A session can turn a module off for every session, on request**
    (accepted by the review, with conditions that are now in section 5.3:
    counted in the session's budget of changes; the undo command, the
    modules that go with it, and "until a terminal" in what is said).
13. **Version 1 of `--remoteCredentials` stays on an operator's server
    only**, unbound; a runtime with a control channel refuses it (changed
    by the review).
14. **No migration of the release rollback's kept record** from the old
    format (section 10).
15. **The usage record's `pack` becomes `scenario`** (section 13.1).
16. **`module-stopped`** (new): the runtime tells ch-local when it stops a
    module by itself, and `status` reads each live start's `run.json`. It
    is new machinery, there so that `status` is true (sections 7.3, 9.9).
17. **A reload loads its additions first and switches a called module
    before its caller** (new; the review offered this or holding every
    switched module's gate to the end). It adds no waiting; between two
    switches an old caller can still reach a new callee, where the per-hop
    schema check is the guard.
18. **A slot is tied, in the runtime too, to the first (module, variable,
    origin) it was named for** (new, section 6.5), so a wrong message from
    ch-local cannot hand one module's key to another.
