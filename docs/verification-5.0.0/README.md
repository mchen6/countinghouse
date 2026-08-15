# `docs/verification-5.0.0/`

Verification evidence for the 5.0.0 device-spec-format refactor, produced
2026-08-14/15. Kept as a record of what was actually checked, and how, so the
claims in the commit messages can be re-tested rather than taken on faith.

| File | What it is |
|---|---|
| `report.md` | The report. Start here. Provenance of the golden sample, before/after spec, phase 0 confirmations, the new load-failure test, clean-room run, full test run, and a list of where the work exceeded its brief. |
| `logs/npm-test-full.log` | Full `npm test` including test7, 20:37–20:52. 227 passing, 3 pending, 0 failing, exit 0. The authoritative run. |
| `logs/npm-test-first-run-superseded.log` | The earlier full run (20:09–20:24). **Superseded** — its `mcp-contract` portion was answered by a leaked server. Kept only because `report.md` §0 refers to it. |
| `logs/clean-room.log` | `npm pack` → install into an empty tree → README quickstart → 4.x module refused → converted → reloaded. |
| `logs/tools-list-regenerated-from-6f948fc.json` | The MCP `tools/list` surface re-derived from the pre-migration commit in a separate worktree. Byte-identical (sha256 `a5eb06de…`) to `test/mcp-contract/tools-list.golden.json` and to the post-migration capture. |

This directory is documentation of a one-time verification, not a test fixture:
nothing in `test/` reads it. The live assertion is
`test/mcp-contract/01-tools-list-unchanged.js`, which compares against
`test/mcp-contract/tools-list.golden.json`.
