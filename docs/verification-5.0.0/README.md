# `docs/verification-5.0.0/`

Verification evidence for the 5.0.0 device-spec-format refactor, produced
2026-08-14/15. Kept as a record of what was actually checked, and how, so the
claims in the commit messages can be re-tested rather than taken on faith.

| File | In git | What it is |
|---|---|---|
| `report.md` | yes | The report. Start here. Provenance of the golden sample, before/after spec, phase 0 confirmations, the new load-failure test, clean-room run, full test run, and a list of where the work exceeded its brief. |
| `logs/tools-list-regenerated-from-6f948fc.json` | yes | The MCP `tools/list` surface re-derived from the pre-migration commit in a separate worktree. Byte-identical (sha256 `a5eb06de…`) to `test/mcp-contract/tools-list.golden.json` and to the post-migration capture. |
| `logs/npm-test-full.log` | no | Full `npm test` including test7. 227 passing, 3 pending, 0 failing, exit 0. The authoritative run for the report. |
| `logs/npm-test-first-run-superseded.log` | no | An earlier full run. **Superseded** — its `mcp-contract` portion was answered by a leaked server. Kept only because `report.md` §0 refers to it. |
| `logs/clean-room.log` | no | `npm pack` → install into an empty tree → README quickstart → 4.x module refused → converted → reloaded. |
| `logs/clean-room-release.log` | no | The same run repeated on `master` as the release gate, plus a step exercising the new unknown-argument rejection through the installed package. |

**The `.log` files are local only.** The repo ignores `*.log*` globally, so they
are not committed; they exist in a working copy of this directory and are cited
by `report.md` for anyone who has them. Every number quoted from them is also
quoted inline in `report.md`, so the report stands on its own.

A copy of the maintainer's local `SPEC-REFACTOR-HANDOFF.md` was committed here
by mistake and removed again in a later commit; the `.gitignore` rules for
those documents are no longer path-anchored, so a stray copy at any depth is
ignored rather than silently tracked.

This directory is documentation of a one-time verification, not a test fixture:
nothing in `test/` reads it. The live assertion is
`test/mcp-contract/01-tools-list-unchanged.js`, which compares against
`test/mcp-contract/tools-list.golden.json`.
