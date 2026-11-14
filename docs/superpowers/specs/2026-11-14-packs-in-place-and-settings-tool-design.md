# Packs in place, and a bounded settings tool (first release, part 2)

Status: draft for review. Implementer C, 2026-11-14.

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
| `reload {name, path}` | The new version is loaded beside the old one. New calls go to the new version once it is ready, and the old one is unloaded when its calls in flight finish, bounded by `--requestTimeout`. |

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

**Files on disk.** A running start keeps using the files of the version it
loaded. So `ch-local` must keep each pack version in a directory of its own
and remove an old one only when no live `start` still uses it. Each run
directory records what it loaded; a run directory whose process has ended
is ignored. (Open question 1: today's `app/node_modules` may be flat.)

### 2. Upgrades: easy, opt-in automatic, never silent

- **Easy.** `ch-local upgrade` stays one command that asks once. With
  packs in place it no longer needs a client restart.
- **Opt-in automatic.** `autoUpgrade` stays off by default. When it is on,
  `start` checks the registry in the background, at most once a day. It
  installs new versions through the same code as `ch-local upgrade` and
  applies them in place (section 1). Turning it on loosens a guard (new
  code runs with the user's keys), so the settings tool cannot turn it on
  (section 3); the CLI and part 3 can.
- **Never silent.** Every pack change applied to a running session, by
  hand or automatically, is said in three places:
  1. an MCP `notifications/message` (level `notice`), for example "ci-failure-triage
     upgraded 0.3.0 → 0.4.0";
  2. a one-line text block on the next result of a tool of that pack,
     beside the receipt;
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

**The allowlist for the first release.** Bounds are fixed in code.

| Setting | Values | Guarding | This tool may | Applies |
|---|---|---|---|---|
| `locale` | `en`, `zh` | no | set | now |
| `maxOutputBytes` | 1 MiB – 256 MiB | yes | lower only | now (the next call) |
| `requestTimeout` | 5 s – 120 s | yes | lower only | now (the next call) |
| `moduleSandbox` | `enforce`, `audit` | yes | `audit` → `enforce` only | next start |
| `autoUpgrade` | on, off | yes | turn off only | now |
| `upgradeCheck` | `daily`, `weekly`, `never` | no | set | now |

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
- Nothing new leaves the machine, except the update check when the user
  has opted into automatic upgrades. That check is the call `ch-local
  upgrade` already makes.
- No key, token or credential value is ever shown by `get` or written to
  the history.

## Tests and acceptance (named here; the plan writes them)

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
    nothing;
  - it is not listed over HTTP;
  - it cannot be reached by `ctx.call` or a hop;
  - a value that applies now is used by the next call.
- Module code cannot reach the control channel.

## Open questions

1. **Versioned pack directories.** Does `ch-local`'s layout keep two
   versions of a pack side by side today? If `app/node_modules` is flat,
   it needs a versioned layout and a garbage collector before `reload` is
   safe.
2. **In-flight calls on an upgrade.** Should they finish on the old
   version (as proposed), or be answered at once so the switch is
   immediate?
3. **The "never silent" channels.** Are `notifications/message` (which
   some clients may not show) and a text block on the pack's next result
   both wanted, or one of them?
4. **The automatic check.** Should it run inside `start`, at most daily,
   or as a separate scheduled `ch-local` command?
5. **What counts as guarding.** Are `requestTimeout` and `upgradeCheck`
   classified rightly? Is turning a pack off a setting this tool should
   offer, as a tightening?
6. **zh texts.** `SETTING_UNKNOWN`, `SETTING_OUT_OF_BOUNDS` and
   `SETTING_LOOSENS_A_GUARD` need the reviewer's zh texts.
7. **An operator ceiling.** A machine-wide bound below the hard bounds,
   for a shared machine. Now, or later?
