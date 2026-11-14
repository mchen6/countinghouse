# Guarding settings by conversation (first release, part 3)

Status: draft for the maintainer's review, rev 2 (2026-11-14), after a
security review against the MCP 2026-07-28 specification. Reviewer session.
Builds on part 2 (#168): the `countinghouse_settings` tool, its allowlist and
bounds, the control channel, the change history.

## Intent

The maintainer (2026-11-13) wants every runtime setting change made in
conversation with the agent in the first release, guarding ones included,
under four rules:
- tighten on request;
- loosen only with a confirmation the agent cannot give itself;
- a module never changes a setting;
- an operator ceiling bounds everything.

A guarding setting is one whose loosening lets more data, code or cost
through: the output cap, the request timeout, the sandbox mode, automatic
upgrades, and a pack turned on. Part 2 already reads all settings and
tightens guarding ones. Part 3 adds loosening.

## Threat model and what the protocol does not promise

**The main threat** is a prompt injected through a tool result, a CI log say,
that makes the agent ask to raise a cap or weaken the sandbox. The client's
tool-approval prompt is weak consent: users "always allow" a tool, and the
agent words the request.

**MCP elicitation is not proof of a human.** The specification leaves the
interaction model to the client:
- user approval controls are a SHOULD;
- nothing forbids a host that answers automatically, or lets the model fill
  the form;
- Claude Code's `Elicitation` hook, for one, can accept with content and
  show no dialog.

Since 2026-07-28, a server asks through an `InputRequiredResult`, and the
client retries `tools/call` with `inputResponses` and a `requestState` that
the server must treat as attacker-controlled
(<https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation>,
<https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr>).

**Out of scope:** an agent with a shell that edits `<home>/settings.json`
itself, with the user's own permissions. We can't stop that. We make it
visible (section 5).

## Design

### 1. Which loosenings conversation may make at all

| Setting | Loosening | In conversation | By CLI only |
|---|---|---|---|
| `maxOutputBytes` | raise, up to the ceiling | yes, **this start only** | persistent |
| `requestTimeout` | raise, up to the ceiling | yes, **this start only** | persistent |
| a pack | turn on | yes, **this start only** | persistent |
| `moduleSandbox` | `enforce` → `audit` | **no** | yes |
| `autoUpgrade` | turn on | **no** | yes |
| `moduleSandbox` | → `off` | **no** | **no** (ch-local keeps refusing `off`) |

A loosening made in conversation lasts until the next `start`; to keep it,
the user runs the CLI. Standing, code-execution-class loosenings (the sandbox
and automatic upgrades) are never made in conversation.

### 2. The confirmation

When the agent asks the settings tool to loosen something allowed in
section 1:

- **The client is trusted for elicitation.** That is, it's on a
  **tested-client allowlist**: a `clientInfo` name and version range that we
  have tested to show a human dialog with no automatic answer. And its
  request declares the elicitation capability. In that case the tool
  answers with an `InputRequiredResult`:
  - a form with a single boolean, `approve`, and no default;
  - the message is **built by the runtime from the staged change**: the
    setting's current value, the new value and what it means. For a pack,
    its name and version come from `packs.json`. Agent-supplied text never
    appears.
- **Otherwise,** the tool answers `SETTING_NEEDS_CONFIRMATION`. The text is
  addressed to the user, not the agent: "To allow this, run
  `ch-local settings set maxOutputBytes 64MiB` in a terminal yourself." The
  setting is unchanged.

**Staging rules.**
- One pending change per `start`. A new request replaces the old one, which
  is recorded as not confirmed.
- The pending change is held server-side under a random nonce. `requestState`
  carries only the nonce, HMAC'd with the start's own key.
- On the retry, the nonce must match, be unused and be younger than 120 s.
  The retry's name and value must equal the staged ones.
- At apply time, the current value and the ceiling are checked again.
- Single use is enforced server-side. A retry that never comes simply
  expires.
- **Prompt fatigue:**
  - after a decline, conversation can't loosen that setting again until the
    next `start`;
  - repeated requests that weren't confirmed are recorded as one entry with
    a count, so they can't push older history out.

### 3. The CLI path, stated honestly

- `ch-local settings set` asks for confirmation on a TTY, and has no
  `--yes`. That stops accidents, not an agent: an agent with a shell can
  fake a TTY.
- For an agent with a shell, the consent is the client's own
  command-approval prompt. It has the same weakness as tool approval.
- That is the line we draw. The user's own terminal is the user's. Making
  every CLI loosening visible (section 5) is what we can add.

### 4. The operator ceiling, failing closed

**The file** is optional and machine-wide:
- `/etc/countinghouse/ceiling.json` on Linux and macOS;
- `%ProgramData%\countinghouse\ceiling.json` on Windows.

**What it can do:**
- lower the hard bounds per setting;
- forbid a loosening outright;
- forbid conversational loosening entirely (`"conversation": false`).

**How it's checked:**
- **Linux and macOS:** resolve the real path first (macOS's `/etc` is a
  symlink). Every path component must be owned by root and not writable
  by group or others. Open the file with `O_NOFOLLOW`, then `fstat` it.
- **Windows:** check the owner and DACL of the directory and the file;
  only Administrators or SYSTEM may write either.
- **No file** means the hard bounds apply.
- **A file that exists but fails any check fails closed.** Every loosening
  is refused (`SETTING_CEILING_UNTRUSTED`), and so is every start whose flags
  or settings loosen past the hard bounds.

**It binds every path:** conversation, the CLI, values already in
`settings.json` (clamped at start, and said), and `start` flags such as
`--moduleSandbox audit`, which `start` passes through today.

### 5. Never silent

- **Every loosening, and every request that wasn't confirmed,** is recorded
  in the history, with how it was confirmed: `elicitation (client X)` or
  `cli`.
- **Notices.** A loosening is also said in:
  - an MCP `notifications/message`;
  - the one-line notice on the next result of an affected tool;
  - stderr.
- **Edits made outside the tools.** Each `start` compares `settings.json`
  with the last value the history recorded. Any setting changed outside the
  tools is reported, the same three ways and in the history, as "changed
  outside ch-local". The notices reach the user through the model, so the
  history and stderr are the record that the model can't edit.

## Tests

- **Elicitation:**
  - an allowlisted client with the capability: approve applies the change
    for this start only, and decline, cancel and expiry change nothing;
  - a client that isn't allowlisted, or has no capability: the answer
    names the command, and nothing changes;
  - the dialog text comes from the staged change only.
- **The nonce:**
  - a forged or replayed `requestState` is refused;
  - a retry whose name or value differs is refused;
  - a second staging replaces the first;
  - the ceiling is checked again at apply.
- **Prompt fatigue:** a decline locks that setting for the start, and
  repeated requests are coalesced in the history.
- **The table:** sandbox and `autoUpgrade` loosenings are refused in
  conversation, and `off` is refused everywhere.
- **The ceiling:**
  - on each OS, an untrusted file fails closed: a user-writable parent, a
    symlinked file, the wrong owner;
  - values in `settings.json` and `start` flags are clamped;
  - `"conversation": false` blocks every conversational loosening.
- **Outside edits:** `settings.json` edited directly is reported at the
  next start.
- **Modules:** a module can reach no path.

## Open questions for the maintainer

1. **Which clients may confirm by elicitation?**
   - A tested allowlist, as proposed: safer, and we keep a list, starting
     with the clients we've tested.
   - Or any client that declares the capability: simpler, but an
     auto-answering host turns an injected request into a yes.

   Recommendation: the allowlist.
2. **How long does a conversational loosening last?** "This start only", as
   proposed, or kept as the CLI's are? Recommendation: this start only.
3. **Clients with neither a shell nor a trusted elicitation:** the user runs
   the command in a terminal, as proposed. The alternative is a one-time
   local confirmation page that `start` opens in the browser. Other local
   software could reach that page too. Recommendation: the command only, for
   the first release.

New codes, with en and zh texts:
- `SETTING_NEEDS_CONFIRMATION`;
- `SETTING_NOT_CONFIRMED`;
- `SETTING_ABOVE_CEILING`;
- `SETTING_CEILING_UNTRUSTED`.
