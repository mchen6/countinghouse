# The elicitation hand test

A loosening asked for in conversation (a raised `maxOutputBytes` or
`requestTimeout`, a pack turned on) can be confirmed by the user in their
client's own dialog: an MCP elicitation, answered for this start only. MCP
does not promise that a person answers an elicitation, so the runtime shows
one only to a client on its tested-client list (`lib/elicitation-clients.json`),
at a version inside a range that passed this test, and only when ch-local
finds nothing in that client's own configuration that could answer it
(`lib/client-conditions.js` in ch-local). Every other case gets the terminal
command instead.

The list ships empty: until this test passes, no client is shown a dialog.

## How a version gets onto the list

- **Once, before release, by hand.** The maintainer runs the checklist
  below on the current Claude Code, and the first range is added with the
  results recorded here.
- **Each new version after that, automatically.** The automated re-test
  plants a hook at every location ch-local's scan knows
  (`lib/client-conditions-fixtures.js` in ch-local: `LOCATIONS` and
  `plant()`), checks that the scan finds each, and diffs the new version's
  configuration surface against the last approved one. When it passes, it
  opens the pull request that adds the version's range. Nothing is added
  by hand per version.
- **Exact ranges.** A range `{from, before}` names exactly the versions
  tested (`from` inclusive, `before` exclusive). There is no open range, so
  a new version gets no dialog until it is re-tested.

## The checklist

Run it in Claude Code's CLI, in a project directory, with countinghouse
installed through ch-local and a pack installed. Record each item as pass or
fail, with the date and the client version.

### The dialog

1. A loosening asked for in conversation shows a dialog with the server's
   name and the runtime's text, and the model can neither see its field nor
   fill it.
2. Nothing answers it on its own: wait 60 s.
3. Decline and cancel both leave the setting unchanged, and asking again
   gives `SETTING_DECLINED_THIS_START`.
4. Accept applies the change, and it is gone after the client restarts.

### What turns the dialog off (each must give the terminal command, no dialog)

5. A project hook:
   `{"hooks": {"Elicitation": [{"matcher": "", "hooks": [{"type": "command", "command": "echo accept"}]}]}}`
   in `.claude/settings.json`.
6. A project `enabledPlugins` entry.
7. A headless run (`claude -p`).
8. A `--plugin-dir` given as a relative path. (A plugin developer uses the
   terminal command.)
9. A flag the scan does not list as safe, such as `--dangerously-skip-permissions`
   or `--permission-mode bypassPermissions`. Record whether bypassing
   permissions changes how an elicitation is answered; if it does not,
   `--permission-mode` can go back on the safe list.

### What to record

10. The `clientInfo` name and version Claude Code sends (the runtime logs
    them at debug level), from the CLI and, if available, from an Agent SDK
    host.
11. ch-local start's `cwd`, and whether `CLAUDE_PROJECT_DIR` is set, for a
    project-directory session.
12. `CLAUDE_CODE_ENTRYPOINT` and `CLAUDECODE` for the CLI, for `claude -p`
    and for an Agent SDK host.
13. Every flag on the command line of an everyday session. Each must be on
    ch-local's safe list (`SAFE_FLAGS`), or the session gets no dialog.
14. Whether Claude Code applies a hook edited from outside during a session.
15. Whether Claude Code reads hooks from:
    - the Windows policy registry key (`HKLM` or `HKCU`
      `\SOFTWARE\Policies\ClaudeCode`). ch-local treats its presence as
      unreadable; if Claude Code never reads hooks there, that check can go;
    - the macOS managed-preferences profile
      (`/Library/Managed Preferences/com.anthropic.claudecode.plist`);
    - `C:\ProgramData\ClaudeCode\managed-settings.json`;
    - under WSL, `/mnt/c/Program Files/ClaudeCode/managed-settings.json`.
      This and the WSL registry query by `reg.exe` have no automated test.

### Time of check

16. A hook written by a background job after ch-local's start scan: no
    dialog (ch-local scans again before every form).
17. A hook deleted before asking: no dialog (a hook seen once holds for the
    whole start).
18. ch-local killed and the client reconnected: a new runtime refuses the
    old `requestState`, and nothing applies.

## Results

None yet.
