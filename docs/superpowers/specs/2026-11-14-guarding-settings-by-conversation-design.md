# Guarding settings by conversation (first release, part 3)

Status: draft for the maintainer's review. Reviewer session, 2026-11-14.
Builds on part 2 (`2026-11-14-packs-in-place-and-settings-tool-design.md`,
#168): the `countinghouse_settings` tool, its allowlist and bounds, the
control channel, and the change history.

## Intent

The maintainer (2026-11-13) wants every runtime setting change made in
conversation with the agent, guarding ones included, in the first release.
For guarding settings, the rule is: **tighten on request; loosen only with a
confirmation the agent cannot give itself; a module never changes a setting;
an operator ceiling bounds everything.**

A guarding setting is one whose loosening lets more data, code or cost
through:
- the output cap;
- the request timeout;
- the sandbox mode;
- automatic upgrades;
- a pack turned on.

Part 2's tool already reads every setting and tightens guarding ones. Part
3 adds loosening.

## Threat model

- **A prompt injected through a tool result**, say a CI log or an issue
  body, asks the agent to raise a cap or weaken the sandbox. The agent
  follows it.
  - The client's tool-approval prompt is weak consent here. Users approve
    tools once ("always allow"), and the agent words the request.
  - So the approval prompt alone must never loosen a guard.
- **A module** tries to call the settings tool, or the control channel.
  Part 2 already rules this out: built-ins aren't addressable by module
  code, and the channel exists only between `start` and its runtime.
- **Out of scope:** an agent with a shell that can edit
  `<home>/settings.json` directly. It acts with the user's own file
  permissions. countinghouse can't stop that, and doesn't pretend to. What
  it can do is never offer a loosening path itself that bypasses the user,
  and say every change (history plus notice) so an edit made behind its
  back is visible at the next start.

## Design

### 1. Loosening needs a confirmation the model never sees or fills in

The settings tool's `set` with a loosening value no longer only refuses. It
**stages** the change and asks the user through a channel the model is not
part of.

**MCP elicitation, the primary path.** When the client advertised the
`elicitation` capability at initialize, the runtime sends
`elicitation/create` to the client:
- The message text is built **by the runtime from the staged change**,
  never from agent-supplied text, so an injected request can't word the
  dialog. For example: "Raise the output cap from 8 MiB to 64 MiB for
  this machine? Results up to 64 MiB will reach the agent."
- The form has one boolean, `approve`.
- The client shows it to the user and returns the answer to the server.
  The model does not author the answer.

The change is applied only on `action: "accept"` with `approve: true`. It is
valid once, for that exact name and value, within 120 s; otherwise it is
dropped. Decline, cancel and timeout all change nothing, and the tool
answers `SETTING_NOT_CONFIRMED`.

**The CLI, everywhere else.** When the client has no elicitation, the tool
answers `SETTING_NEEDS_CONFIRMATION` with the exact command for the user to
run, e.g. `ch-local settings set maxOutputBytes 64MiB`. The command asks for
confirmation on a TTY.
- An agent with a shell could run it. In that client, though, the command
  goes through the client's own command-approval prompt, which shows the
  literal command to the user. That is the client's consent model, and the
  maintainer already accepted it for shell agents.
- An agent without a shell can only show the user the command.

**Never by the approval prompt alone,** and never by a module.

### 2. What may be loosened, and how far

| Setting | Loosening | By elicitation | By CLI |
|---|---|---|---|
| `maxOutputBytes` | raise, up to the ceiling | yes | yes |
| `requestTimeout` | raise, up to the ceiling | yes | yes |
| `moduleSandbox` | `enforce` → `audit` (next start) | yes | yes |
| `moduleSandbox` | → `off` | **no** | yes, with a warning |
| `autoUpgrade` | turn on | yes | yes |
| a pack | turn on | yes | yes |

`off` is never offered by conversation: it removes every guard, and the
consent for it should be typed.

### 3. The operator ceiling

- A machine-wide file, owned by an administrator and not writable by the
  user:
  - `/etc/countinghouse/ceiling.json` on Linux and macOS;
  - `%ProgramData%\countinghouse\ceiling.json` on Windows.
- It lowers the hard bounds per setting, and can forbid a loosening
  outright (e.g. `"moduleSandbox": {"min": "enforce"}`).
- `start` reads it at start. Every bound in part 2's `get` reflects it.
- A value past the ceiling is refused `SETTING_ABOVE_CEILING` by every
  path, the CLI included.
- The file is optional. Without it, the hard bounds in code apply.
- The multi-tenant runtime is unchanged: its operator's flags are the
  ceiling, and the settings tool isn't listed there.

### 4. Never silent

Every loosening, by either path, appears in three places, as in part 2:
- the change history, recording who confirmed it: `elicitation` or `cli`;
- an MCP `notifications/message`;
- the one-line notice on the next result of a tool it affects.

A staged change that wasn't confirmed is recorded too, as "asked, not
confirmed", so a user can see that something tried.

## Tests

- **A loosening through the tool:**
  - with elicitation: approve applies it, and decline, cancel and timeout
    change nothing;
  - without elicitation: the answer names the command, and nothing changes.
- **The dialog text:** it comes from the staged change only. Agent-supplied
  text in the request never appears in it.
- **The staged change:**
  - it is single-use: the same approval can't apply a second change;
  - a different value needs a new confirmation;
  - it expires after 120 s.
- **The ceiling:**
  - it binds every path;
  - a missing file means the hard bounds apply;
  - a file the user can write is refused, with a warning.
- **Other refusals and records:**
  - `off` is refused by the tool;
  - a module can reach neither path;
  - the history and the notice record each loosening, and each request that
    wasn't confirmed.

## Open questions for the maintainer

1. **Clients with neither a shell nor elicitation** (to check: which of
   Claude Desktop, ChatGPT, Cursor and VS Code advertise elicitation). Two
   options:
   - offer only the "run this command" answer; the user then needs a
     terminal on the machine;
   - add a local confirmation page: `start` opens a one-time
     `http://127.0.0.1:<port>/<random>` in the user's browser.

   **Recommendation:** the command only, for the first release. A local
   page is more code at a boundary, and other local software can reach it
   too.
2. **Loosening the sandbox by conversation** (`enforce` → `audit`). Allow it
   with elicitation, as proposed, or make it CLI-only like `off`?
   **Recommendation:** allow it with elicitation. Audit still refuses the
   always-denied set and records everything.
3. **The ceiling file's location and ownership** on each OS: as above?

New codes, all with en and zh texts:
- `SETTING_NEEDS_CONFIRMATION`;
- `SETTING_NOT_CONFIRMED`;
- `SETTING_ABOVE_CEILING`.
