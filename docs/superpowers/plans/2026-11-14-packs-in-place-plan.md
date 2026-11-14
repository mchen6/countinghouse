# Packs in Place and the Settings Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pack installed, upgraded, rolled back, turned off or removed reaches a running session without a restart, and the change is never silent. Agents without a shell get `countinghouse_settings`, which reads every setting and changes only neutral ones, or tightens guarding ones, within fixed bounds.

**Architecture:** Two PRs.
- **countinghouse (PR A)** gains:
  - an IPC control channel that only `ch-local start` holds;
  - in-place module load, unload and side-by-side reload, under the same checks as at start;
  - the change notices;
  - `countinghouse_settings`.
- **ch-local (PR B)** gains:
  - a versioned pack layout with garbage collection;
  - a `start` that watches the home and drives its runtime over the channel;
  - the daily opt-in automatic upgrade;
  - `ch-local settings` for a terminal user.

PR B depends on PR A's channel. Each PR is its own branch, reviewed separately.

**Tech Stack:** Node 24 (`child_process` IPC, `fs.watch`), the countinghouse module manager and MCP gateway, ch-local's `node:test` suite.

**Spec:** `docs/superpowers/specs/2026-11-14-packs-in-place-and-settings-tool-design.md` (countinghouse #168, approved with decisions 1–7).

## Global Constraints

- English only. The zh texts are the reviewer's, verbatim:
  - `SETTING_UNKNOWN`: 没有名为 {name} 的设置；可以修改的设置见 get 的结果。
  - `SETTING_OUT_OF_BOUNDS`: {name} 的值 {value} 超出了允许的范围（{bounds}），未作修改。
  - `SETTING_LOOSENS_A_GUARD`: 把 {name} 改为 {value} 会放宽一项防护设置，这个工具不能这样改，设置未作修改。用户可以在终端里用 ch-local 命令自己修改，或通过需要用户亲自确认的方式修改。
- No secret in any file, log, notice or history entry. A credential appears only by its variable's name.
- Tests never declare a real remote origin and make no live network call. The registry for automatic upgrades is a local stand-in.
- countinghouse:
  - server tests run through `node scripts/run-in-docker.js`, one container at a time; only lint and server-free single files run locally;
  - the tools/list golden moves only where `countinghouse_settings` is listed (the single-identity profile), and is regenerated in that commit.
- The control channel and `countinghouse_settings` exist only in the single-identity profile (`ch-local start --stdio`). Never over HTTP, never multi-tenant.
- Bounds are fixed in code: `maxOutputBytes` 1 MiB – 256 MiB; `requestTimeout` 5000 – 120000 ms.

## Review Focus

1. **A reload while calls are in flight on the old version, and the old version never drains:** the old version ends at `--requestTimeout`, its calls are answered with a code, and the new version serves every call that started after the switch. Pinned in Task A3.
2. **Two packs sharing one part** (pins give it one version), one of them removed: the part stays loaded for the other, and its tools stay listed. Pinned in Tasks A1 and A3.
3. **A `packs.json` written while `start` is applying the previous change:** changes are applied one at a time in order, and the last state wins. Nothing is half-applied. Pinned in Task B3.
4. **A settings value that applies now, set while a call is running:** the running call keeps its value, and the next call uses the new one. Pinned in Task A5.
5. **A run directory left by a crashed start:** its versions are not held for ever. A dead pid frees them, and a live pid on another host is kept until its run directory's age passes a day. Pinned in Task B2.

---

## PR A — countinghouse

### Task A1: The same part from two packs loads once

**Files:**
- Modify: `lib/module-roles.js` (`expandLoadList`)
- Test: `test/module-loading/27-shared-parts.js` (server-free; fixture trees in a temp directory)

**Interfaces:**
- Produces: `expandLoadList(dirs)` returns each module once, keyed by name.
  - The same name and version from two directories: the first directory is kept, and the later one is recorded in `m.alsoFrom`.
  - The same name at two versions: the later one is refused with `{code: 'PART_VERSION_CONFLICT', name, versions}`, logged, and that scenario is not loaded.
  - It also returns `owners: Map<moduleName, Set<scenarioName>>`, used by Task A3's unload.

- [ ] Test: two scenarios whose trees each hold `ch-step-redact@0.2.0` → one load entry, and both scenarios load. `@0.2.0` against `@0.3.0` → the second scenario is refused, and the log names both versions.
- [ ] Run it: FAIL (today the part is listed twice).
- [ ] Implement.
- [ ] Run it: PASS. Also run module-loading 21 and 23 in Docker.
- [ ] Commit: `feat(roles): a part two scenarios share is loaded once; two versions of one part are refused`

### Task A2: The control channel

**Files:**
- Create: `lib/control-channel.js`
- Modify: `bin/countinghouse-stdio.js` (start the channel when `--controlChannel ipc`); `lib/cli-options.js` (`controlChannel`: `'ipc'` or null; refused unless `singleIdentity`)
- Test: `test/stdio/05-control-channel.js` (spawns the stdio runtime with an IPC fd; Docker)

**Interfaces:**
- Produces: messages over `process.on('message')` / `process.send`:
  - **request:** `{id, type: 'load' | 'unload' | 'reload' | 'set', ...}`
    - `load {name, scenario, remoteCredentials, deviceConfigDir, notice}`: `name` is the pack name; `scenario` and `remoteCredentials` are absolute paths.
    - `unload {name, notice}`
    - `reload {name, scenario, remoteCredentials, deviceConfigDir, notice}`
    - `set {name, value}`
  - **reply:** `{id, ok: true, tools: [names]}` or `{id, ok: false, code, message}`.
  - Requests are applied one at a time, in order.
- Produces: `controlChannel.start(moduleManager, gateway)`, which returns `{stop()}`.
- Module code cannot reach it: workers have no `process.send`, and the channel object lives only in the main thread's closure.

- [ ] Test:
  - an unknown `type` → `{ok: false, code: 'CONTROL_UNKNOWN'}`;
  - `--controlChannel ipc` without single-identity → exit 2, naming the flag;
  - a module calling `process.send` in its worker (under audit) sends nothing the runtime acts on.
- [ ] Run it: FAIL.
- [ ] Implement the channel with a serial queue and the reply shape. `load`, `unload`, `reload` and `set` answer `CONTROL_NOT_READY` until Tasks A3 and A5.
- [ ] Run it: PASS.
- [ ] Commit: `feat(stdio): a control channel only ch-local start holds (part 2)`

### Task A3: Load, unload and reload in place

**Files:**
- Modify: `lib/module-manager.js`: a new `loadPackInPlace`, `unloadPackInPlace` and `reloadPackInPlace`, each `(msg) -> Promise<{tools}>`. Reload runs side by side: spawn the new workers, switch `deviceMap` when they are ready, and end the old workers when their pending calls answer or at `options.requestTimeout`.
- Modify: `lib/remote/index.js` (register a pack's remotes from its own credentials file).
- Modify: `lib/control-channel.js` (wire `load`, `unload` and `reload`).
- Test: `test/stdio/06-packs-in-place.js` (Docker; fixture packs: a scenario with two parts, and a second scenario sharing one part)

**Interfaces:**
- Consumes: `expandLoadList`'s `owners` (Task A1). Unloading a pack unloads its scenario and every part no other loaded scenario owns.
- Produces: every applied request ends with the #145 `list_changed`, sent once the tool set settles.

- [ ] Test:
  - `load` → after one `list_changed`, the pack's tool is listed and answers;
  - `unload` → its tool is gone, and the shared part's tools remain for the other pack (Review Focus 2);
  - `reload` to a new version while a slow call runs on the old one → the slow call answers from the old version, and a call after the switch answers from the new one;
  - an old version that never drains is ended at `--requestTimeout`, and its call answers `WORKER_ENDED` (Review Focus 1);
  - a `load` whose credential file lacks the pack's variable → `{ok: false, code: 'REMOTE_CREDENTIAL_MISSING'}`, and nothing is listed.
- [ ] Run it: FAIL.
- [ ] Implement.
- [ ] Run it: PASS. Also run the composition, module-loading and stdio folders in Docker.
- [ ] Commit: `feat(modules): packs loaded, unloaded and reloaded in place, side by side (part 2)`

### Task A4: Never silent — the notices

**Files:**
- Modify: `lib/mcp/gateway.js` (a pending notice per pack); `bin/countinghouse-stdio.js` (`notifications/message`; declare `capabilities.logging`)
- Test: `test/stdio/07-change-notices.js` (Docker)

**Interfaces:**
- Consumes: `notice`, a string of at most 200 characters, from `load`, `unload` and `reload`. ch-local writes it, for example `ci-failure-triage upgraded 0.3.0 → 0.4.0`.
- Produces, once per change:
  - one `notifications/message` `{level: 'notice', logger: 'countinghouse', data: notice}`;
  - one text block `notice` on the next result of a tool of that pack, after the receipt. For an unload, the notice goes into the next result of any tool.

- [ ] Test:
  - each kind of change yields exactly one notification and one block;
  - a second call of the pack's tool carries no block;
  - a notice over 200 characters is cut.
- [ ] Run it: FAIL.
- [ ] Implement.
- [ ] Run it: PASS.
- [ ] Commit: `feat(stdio): every pack change is announced once, as a notification and on the pack's next result (part 2)`

### Task A5: `countinghouse_settings`

**Files:**
- Create: `lib/settings-tool.js` (the allowlist, the bounds, the classification, and the read and write of the settings file)
- Modify:
  - `lib/mcp/tool-registry.js`: list the tool only when `singleIdentity`;
  - `lib/mcp/gateway.js`: dispatch, admin only, never via `ctx.call` or a hop;
  - `lib/cli-options.js`: `--settingsFile <path>`;
  - `lib/error-catalogue.js`: the three codes, with en texts as in the spec's section 3 table and the reviewer's zh texts;
  - `lib/control-channel.js`: `set` applies a value that applies now;
  - the golden.
- Test:
  - `test/settings/01-settings-tool.js`, server-free, for the rules;
  - `test/stdio/08-settings-tool.js`, in Docker, end to end.

**Interfaces:**
- Produces: `ALLOWLIST`, as in the spec's table, plus `pack.<name>` (on/off). Each entry is `{name, bounds, guarding, applies, tighten(old, new) -> boolean}`.
- Produces: `get()`, which returns `{settings: [...], history: [...]}`, and `set(name, value, by)`, which returns `{name, old, new, applies}` or throws a `CountinghouseError` with the code and the fields `{name, value, bounds}`.
- The settings file is `{version: 1, values: {...}, history: [{at, name, old, new, by}]}`. The history keeps the last 50 entries. It is written atomically, and is the same file ch-local reads (Task B4).
- A value that applies now is put into `options` for the next call: a running call keeps its value (Review Focus 4). `pack.<name>` off unloads in place (Task A3) and announces it (Task A4).

- [ ] Test:
  - every allowlisted setting is set within its bounds;
  - out-of-bounds values → `SETTING_OUT_OF_BOUNDS`, in en and zh;
  - an unknown name → `SETTING_UNKNOWN`;
  - every loosening, turning a pack on included → `SETTING_LOOSENS_A_GUARD`, and the file is unchanged;
  - the tool is not listed over HTTP;
  - `ctx.call('countinghouse_settings')` from a module is refused;
  - a call running during a set keeps its old `requestTimeout`.
- [ ] Run it: FAIL.
- [ ] Implement.
- [ ] Run it: PASS. Regenerate the single-identity golden.
- [ ] Commit: `feat(settings): countinghouse_settings, bounded, never loosening a guard (part 2)`

## PR B — ch-local

### Task B1: A versioned pack layout

**Files:**
- Modify: `lib/home.js` (`packsDir: <home>/packs`); `lib/install.js`, `lib/packs-command.js`, `lib/upgrade.js` and `lib/rollback.js`, which unpack a pack's packages into `<home>/packs/<name>/<version>/node_modules`, where `<version>` is the scenario's version; `lib/packs.js` and `lib/start.js`, which load from there.
- The runtime and the launcher stay in `<home>/app`.
- Migration: the first install, upgrade or add-pack after this change moves each pack out of a flat `app/node_modules`. Until then `start` loads from the flat layout as before.
- Test: `test/layout.test.js`, plus updates to `install.test.js`, `packs-command.test.js`, `rollback.test.js` and `start.test.js`.

**Interfaces:**
- Produces: `packDir(where, name, version)` and `installedPacks(...)[i].dir`, the absolute scenario directory that `start` loads.

- [ ] Test:
  - an install puts each pack under its version directory, and `start` passes those directories as `--loadModule`;
  - a flat home still starts;
  - one install migrates it;
  - rollback returns to the previous version directory.
- [ ] Run it: FAIL.
- [ ] Implement.
- [ ] Run it: PASS (`npm test`, ch-local's whole suite, which is server-free).
- [ ] Commit: `feat(layout): each pack version in a directory of its own (part 2)`

### Task B2: Garbage collection of versions no live start uses

**Files:**
- Create: `lib/gc.js`
- Modify: `lib/start.js`: the run directory records `{host, pid, startedAt, loaded: {pack: version}}` in `run.json`, rewritten on every applied change.
- Call the collection after install, upgrade, add-pack, remove-pack and rollback.
- Test: `test/gc.test.js`

**Interfaces:**
- Produces: `collect(where, {alive, hostname, now}) -> {removed: [dir], kept: [{dir, why}]}`. A version is kept when it is any of:
  - current;
  - the rollback target;
  - loaded by a run directory whose pid is alive on this host;
  - loaded by a run directory from another host that is under a day old.
- Never anything else (Review Focus 5).

- [ ] Test: each kept reason; a dead pid frees its versions; another host's day-old run directory frees them; the current and rollback versions are never removed.
- [ ] Run it: FAIL.
- [ ] Implement.
- [ ] Run it: PASS.
- [ ] Commit: `feat(gc): pack versions no live start uses are removed (part 2)`

### Task B3: `start` watches the home and drives its runtime

**Files:**
- Modify: `lib/start.js`:
  - spawn the runtime with `stdio: ['pipe', 'pipe', 'pipe', 'ipc']`, `--controlChannel ipc` and `--settingsFile <home>/settings.json`;
  - watch `packs.json` and `settings.json` with `fs.watch` and a 2 s poll;
  - diff the pack set and `pack.<name>` settings against `run.json`'s `loaded`;
  - send `load`, `unload` or `reload` with the credential file written for that pack, and a notice;
  - append to the history; update `run.json`.
- Create: `lib/control.js`, the request and reply client with a serial queue.
- Test: `test/start-in-place.test.js` (a fake runtime child that records the channel's requests)

**Interfaces:**
- Consumes: PR A's message shapes (Task A2), and `packDir` (Task B1).
- Notices are written here:
  - `<pack> added <version>`;
  - `<pack> removed`;
  - `<pack> upgraded <old> → <new>`;
  - `<pack> rolled back <old> → <new>`;
  - `<pack> turned off`;
  - `<pack> not loaded: <VARIABLE> is not set`.

- [ ] Test:
  - add, remove, upgrade, rollback and turning a pack off each yield exactly one request with its notice, and one history entry;
  - two writes of `packs.json` in quick succession are applied in order, and the second is the state that ends up loaded (Review Focus 3);
  - a reply `{ok: false}` is recorded in the history and on stderr, and `run.json` is unchanged.
- [ ] Run it: FAIL.
- [ ] Implement.
- [ ] Run it: PASS.
- [ ] Commit: `feat(start): pack changes reach the running runtime, announced (part 2)`

### Task B4: Settings for a terminal user, and the daily automatic upgrade

**Files:**
- Create: `lib/settings.js` (reads and writes `settings.json` v1, migrating today's `{autoUpgrade}`); `ch-local settings [get | set <name> <value>]` in `bin/ch-local.js`. The CLI may loosen: it is the user at a terminal, and every change is recorded in the history (`by: 'cli'`).
- Modify:
  - `lib/upgrade.js`: `--auto` writes through `lib/settings.js`;
  - `lib/start.js`: when `autoUpgrade` is on and `upgradeCheck` is not `never`, check at most once a day (or week), stamping `lastCheck` in the settings file. Install through `upgrade`'s own code without asking, and the watcher applies it in place. A failure is announced as `<pack> automatic upgrade failed: <reason>`, and the old version stays.
- Test: `test/settings.test.js`, `test/auto-upgrade.test.js` (the registry is a local stand-in on 127.0.0.1)

- [ ] Test:
  - `settings set maxOutputBytes 64MiB` is accepted from the CLI, recorded with `by: 'cli'`, and applied now through the watcher;
  - out-of-bounds values are refused in the CLI too;
  - the automatic check runs at most once per day across restarts, and never when `autoUpgrade` is off;
  - a failed upgrade keeps the old version and announces the failure.
- [ ] Run it: FAIL.
- [ ] Implement.
- [ ] Run it: PASS (`npm test`).
- [ ] Commit: `feat(settings): ch-local settings, and the opt-in daily automatic upgrade (part 2)`

## After the tasks

- `/code-review medium` on each PR, with the fixes made test-first.
- PR A first, as a draft with CI as the gate. Docker runs only the folders it touches.
- PR B is stacked on A's channel: its tests use a fake runtime, so it can be reviewed in parallel.
- An end-to-end acceptance with the dogfood home, once both are merged:
  - add a second pack while Claude Code is connected;
  - upgrade pack 1;
  - turn a pack off through the settings tool;
  - see each notice once.
