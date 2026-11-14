# Packs in place, and a bounded settings tool (first release, part 2)

Status: approved by the reviewer, 2026-11-14, with the decisions at the end folded in. Implementer C.

## Intent

The maintainer (2026-11-13) asked for two things for the first release:

- **Packs in place.** A pack installed, updated or removed with `ch-local`
  reaches the agent's running session without the client restarting its MCP
  server.
- **A settings tool for agents without a shell** (Claude Desktop, ChatGPT):
  the user changes a setting by asking the agent. `docs/roadmap.md` already
  describes it ("Changing runtime limits by asking the agent", #134).

Upgrades must be **"easy, opt-in automatic, never silent"**.

The roadmap's `--maxResultBytes` and `RESULT_TOO_LARGE` became
`--maxOutputBytes` and `OUTPUT_TOO_LARGE` in lean worker step 2 (#166, the
reviewer's ruling of 2026-11-13). This document uses those names.

**Out of scope here: loosening a guarding setting** (raising a cap,
weakening the sandbox, turning automatic upgrades on). That is part 3,
which the reviewer is designing. It needs a confirmation the agent cannot
give itself. This tool only reads settings, sets ones that guard nothing,
and tightens guarding ones.

## What exists today

- **Packs are fixed when `start` begins.** `ch-local start --stdio` spawns
  the runtime with one `--loadModule` per installed pack whose credential is
  present. It writes that start's remote credentials and device configs in
  `<home>/run/<host>-<pid>-<random>`. `add-pack`, `remove-pack`, `upgrade`
  and `rollback` change the home, but a running start does not notice until
  the client restarts it.
- **The runtime can already change its tools while it runs.**
  - Under `--stdio`, tools/list waits for the startup modules. After the
    client's first list, a real change to its tools sends one
    `notifications/tools/list_changed`, once the tool set has settled for
    250 ms (#145).
  - The module manager loads, reloads and unloads modules
    (`loadModuleFromPath`, `reloadModule`, `unloadModuleExternal`), with the
    same checks as at start: the spec on the main thread, validation in
    validators, the sandbox.
  - `countinghouse_load_module` exposes loading to an admin when the
    authoring tools are on.
- **Packs and the runtime share one directory.** Every pack and the
  runtime are installed together in `<home>/app/node_modules`. An install
  builds `<home>/app.new`, swaps the whole directory in by rename, and moves
  the old one to `<home>/previous/app` for `rollback`. A running start loads
  its packs by path from `<home>/app/node_modules`, so a swap under it would
  mix versions on any later load.
- **One settings file already exists.** `<home>/settings.json` holds
  `autoUpgrade` (`ch-local upgrade --auto on|off`, off by default).
  `ch-local upgrade` shows installed and available versions and asks once.

## Design

### 1. A pack change reaches a running start

**Watching.** Each running `start` watches `<home>/packs.json`, which
`ch-local` writes atomically, with `fs.watch` and a 2 s poll as a fallback.
On a change, it compares the new pack set against what its runtime loaded:

- a pack added;
- a pack removed;
- a pack whose version changed: an upgrade or a rollback.

**A private control channel.** stdin and stdout are the client's MCP
channel, so `start` speaks to its runtime over a separate channel. It
spawns the runtime with an IPC fd (`stdio: [..., 'ipc']`). The runtime
honours the channel only with `--controlChannel ipc`, which only the
single-identity profile passes, and accepts exactly three messages:

| Message | What the runtime does |
|---|---|
| `load {name, path, deviceConfig, remotes}` | Loads the module with the same checks as at start, and registers its remotes from the credentials file `start` wrote for it in its run directory. |
| `unload {name}` | `unloadModuleExternal`. Calls in flight are answered with the code that says why (`WORKER_ENDED`-style), as a supervised restart answers them today. |
| `reload {name, path}` | The new version is loaded beside the old one. New calls go to the new version once it is ready, and the old one is unloaded when its calls in flight finish, bounded by `--requestTimeout` (decided). |

Module code must never reach this channel: modules run in workers, and the
channel exists only on the runtime's main process. A test pins that.

**Announcing the change.** Each change ends with the #145 announcement,
`list_changed` once the tool set settles, so the client lists again and
sees the new tools. It also gets a notice (below, "Never silent").

**Credentials.** A pack whose credential is missing is not loaded, and
`start` says why on stderr and in `ch-local status`, as at start today.
When the credential appears, it loads on the next change or start.

**Several clients.** Each client runs its own `start`. Each `start`
applies the change to its own runtime independently, with no coordination.

**Files on disk: a versioned layout first.** The layout is flat today
(above), so the versioned layout and its garbage collection come before
`reload`, in scope for this part. Each pack version gets a directory of its
own: `<home>/packs/<name>/<version>/`, holding that pack's scenario and
parts. `start` loads packs from there. The runtime (countinghouse and the
launcher) stays in `<home>/app`; a runtime upgrade still applies at the
next start, and its notice says so.

**Garbage collection.** A running start keeps using the files of the
version it loaded. Each run directory records the pack versions its runtime
loaded, and a run directory whose process has ended is ignored. `ch-local`
removes a version only when no live start uses it and it is neither the
current version nor the one `rollback` would return to. The collection runs
after every install, upgrade, removal and rollback.

### 2. Upgrades: easy, opt-in automatic, never silent

- **Easy.** `ch-local upgrade` stays one command that asks once. With
  packs in place it no longer needs a client restart.
- **Opt-in automatic.** `autoUpgrade` stays off by default. When it is on,
  `start` itself checks the registry in the background, at most once a day,
  with no separate scheduler (decided). It
  installs new versions through the same code as `ch-local upgrade` and
  applies them in place (section 1). Turning it on loosens a guard (new
  code runs with the user's keys), so the settings tool cannot turn it on
  (section 3); the CLI and part 3 can.
- **Never silent.** Every pack change applied to a running session, by
  hand or automatically, is said in all three of these places, each once
  per change (decided):
  1. an MCP `notifications/message` (level `notice`), for example "ci-failure-triage
     upgraded 0.3.0 → 0.4.0";
  2. a one-line text block on the next result of a tool of that pack,
     beside the receipt. This one is always visible, whatever the client
     shows;
  3. the change history `ch-local status` prints and the settings tool's
     `get` returns (the last 50 changes, with times).

  A failed automatic upgrade is said the same way, and the old version
  stays.

### 3. The settings tool

**Name.** `countinghouse_settings`.

**Where it is listed.** Only in the single-identity profile. It is never
listed over HTTP or in a multi-tenant runtime. It is callable only by the
admin identity, which in the single-identity profile is the one local
user, and never through `ctx.call`, a hop or a task. Built-ins are not
addressable by module code; a test pins that.

**Input.** One of:
- `{action: 'get'}`;
- `{action: 'set', name, value}`.

**`get` answers** `{settings: [...], history: [...]}`. Each setting is
`{name, value, default, bounds, guarding, applies}`:
- `bounds` is `{min, max}` or `{enum}`;
- `applies` is `'now'` or `'next start'`.

`history` lists the last 50 changes, each with its time, name, old and new
values, and who made it: `cli`, `settings tool` or `auto-upgrade`.

**`set` answers** `{name, old, new, applies}`, or refuses with a code:

| Code | When |
|---|---|
| `SETTING_UNKNOWN` | The name is not in the allowlist. |
| `SETTING_OUT_OF_BOUNDS` | The value is outside the setting's bounds; the answer carries the bounds. |
| `SETTING_LOOSENS_A_GUARD` | The change would loosen a guarding setting. The text tells the agent the user can make the change with the `ch-local` command (for an agent with a shell), or through part 3's confirmation. The value is never changed. |

The error texts, with fields `{name}`, `{value}` and `{bounds}` (the zh
texts are the reviewer's, 2026-11-14):

| Code | en | zh |
|---|---|---|
| `SETTING_UNKNOWN` | There is no setting named {name}; the settings that can be changed are in get's answer. | 没有名为 {name} 的设置；可以修改的设置见 get 的结果。 |
| `SETTING_OUT_OF_BOUNDS` | The value {value} for {name} is outside the allowed range ({bounds}); nothing was changed. | {name} 的值 {value} 超出了允许的范围（{bounds}），未作修改。 |
| `SETTING_LOOSENS_A_GUARD` | Changing {name} to {value} would loosen a guarding setting, which this tool cannot do; nothing was changed. The user can change it with the ch-local command in a terminal, or through a request the user confirms in person. | 把 {name} 改为 {value} 会放宽一项防护设置，这个工具不能这样改，设置未作修改。用户可以在终端里用 ch-local 命令自己修改，或通过需要用户亲自确认的方式修改。 |

**The allowlist for the first release.** Bounds are fixed in code.

| Setting | Values | Guarding | This tool may | Applies |
|---|---|---|---|---|
| `locale` | `en`, `zh` | no | set | now |
| `maxOutputBytes` | 1 MiB – 256 MiB | yes | lower only | now (the next call) |
| `requestTimeout` | 5 s – 120 s | yes | lower only | now (the next call) |
| `moduleSandbox` | `enforce`, `audit` | yes | `audit` → `enforce` only | next start |
| `autoUpgrade` | on, off | yes | turn off only | now |
| `upgradeCheck` | `daily`, `weekly`, `never` | no | set | now |
| `pack.<name>` | on, off | yes | turn off only (a tightening); turning on is a loosening, part 3 | now (unloaded in place, section 1) |

**Storage.** Values live in `<home>/settings.json`, written atomically
with a `version` field. `start` reads the file at start. A setting that
applies now is also sent to the running runtime over the control channel
as `set {name, value}`, which the runtime accepts only for names whose
`applies` is `now`.

**Never settable by a module**, and never above the hard bounds. The
client's tool-approval prompt is the user's consent for what this tool
may do. A prompt injected through a tool result can at most tighten a
setting or change a neutral one, in a request the user sees. Every set is
written to stderr and to the history.

## Security and privacy

- The control channel exists only between a `start` and the runtime it
  spawned.
- The settings tool cannot loosen a guard, cannot be reached by module
  code, and every change it makes is recorded.
- An injected request can still tighten settings, for example lower
  `maxOutputBytes` until tools fail. The user sees it in the client's
  approval prompt, in the notice and in the history, and can undo it with
  the CLI.
- Nothing new leaves the machine, except the update check when the user
  has opted into automatic upgrades. That check is the call `ch-local
  upgrade` already makes.
- No key, token or credential value is ever shown by `get` or written to
  the history.

## Tests and acceptance (named here; the plan writes them)

- The versioned layout: packs install into `<home>/packs/<name>/<version>/`.
  A version a live start uses, the current one and the rollback target are
  never collected; any other is collected after an install, upgrade,
  removal or rollback.
- A pack added while a session runs appears after one `list_changed`, with
  no restart. A removed pack's tools disappear the same way. An upgraded
  pack answers from the new version, and a call in flight on the old one
  finishes.
- Two starts both apply a change; files of a version a live start uses are
  never removed.
- A missing credential: the pack is not loaded, and `status` says why.
- Never silent: each change yields the notification, the one-line notice
  on the pack's next result, and a history entry, including for a failed
  automatic upgrade.
- The settings tool:
  - each allowlisted setting is set within its bounds;
  - out-of-bounds values and unknown names are refused;
  - every loosening is refused `SETTING_LOOSENS_A_GUARD` and changes
    nothing, turning a pack on included;
  - turning a pack off unloads it in place and announces it;
  - it is not listed over HTTP;
  - it cannot be reached by `ctx.call` or a hop;
  - a value that applies now is used by the next call.
- Module code cannot reach the control channel.

## Decisions (the reviewer, 2026-11-14)

1. **Versioned directories.** Checked: the layout is flat (one
   `<home>/app/node_modules`, swapped whole). So the versioned layout
   (`<home>/packs/<name>/<version>/`) and garbage collection of the versions
   no live start uses are in scope, before `reload` (section 1).
2. **In-flight calls on an upgrade** finish on the old version, bounded by
   `--requestTimeout`.
3. **"Never silent"** uses both channels and the history: an MCP
   `notifications/message` for clients that show it, and the one-line block
   on the pack's next result, which is always visible. Each once per
   change.
4. **The automatic check** runs inside `start`, at most daily. There is no
   separate scheduler.
5. **The classification** stands: `requestTimeout` is guarding and
   `upgradeCheck` is neutral. Turning a pack off is added as a tightening
   this tool may do; turning one on is a loosening, part 3. Security
   notes that an injected request can still tighten settings.
6. **zh texts** are the reviewer's. The fields are `{name}`, `{value}`
   and `{bounds}` in both languages (the error-text table, section 3).
7. **An operator ceiling** is later: see part 3.
