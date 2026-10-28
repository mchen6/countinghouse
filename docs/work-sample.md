# How I build with AI: a countinghouse work sample

Miaobo (Matt) Chen · [github.com/mchen6/countinghouse](https://github.com/mchen6/countinghouse) · Apache-2.0

countinghouse is an open-source runtime where MCP tools call other MCP tools in-process, with per-key access control and metering. It began as CDIF, a multi-tenant Node.js runtime I designed in 2015. In 2026 I rebuilt it for the Model Context Protocol with AI.

**How the work is split:** I set the architecture and make the decisions. Claude Code writes the code. A separate Claude session with no prior context reviews it.

## 1. Something I built with AI, and what it changed

countinghouse hosts MCP tool servers for many tenants. A chain of tool calls runs in-process and is published as one versioned, schema-checked tool, so intermediate results stay out of the model's context.

- **Shipped.** Published on npm under Apache-2.0, with a public launch post.
- **Simpler to build on.** A one-tool module went from 36 lines in 3 files to 6 lines in 1.
- **Less data to the model.** In the repo's benchmarks, one composite call sends the model over 100× fewer bytes than the same steps called one by one. Conditions and scripts are in the README.
- **A clear product call.** I scoped it as a runtime, not a marketplace, and wrote that decision into the project's instructions.

## 2. A process I improved with AI

**The workflow:** I write the spec and plan. Claude Code implements. A fresh session reviews. I decide. Lessons from each round go back into the instructions that every new session starts from.

| Before | After |
|---|---|
| The author's own tests were the only check. | A blank-context review comes before release. The first one found 10 issues, 4 critical or high, in code whose tests all passed. All were fixed before that version reached npm. |
| Plans went straight to code. | Plans are reviewed and revised before any code. |
| The MCP contract check ran inside a test suite of about 25 minutes. | The contract check runs on every commit, in about 10 seconds. |

## 3. When AI output was wrong

- **What went wrong.** A new feature passed all its tests, yet any caller could read or delete another tenant's tasks.
- **Why the tests missed it.** Every test ran in debug mode, where every key is an admin. The tests shared the code's blind spot.
- **How it was caught.** A blank-context review session ran a real multi-tenant server and tried one tenant against another.
- **Guardrails added.** The gap was fixed before release, with multi-tenant tests. No entry path now ships without a declared access rule, and a test fails when a route is undeclared.

The same lesson led to scripts that write their own benchmark summaries, and billing tests that require exact counts instead of minimums.

## 4. Three rules for a PM team working with AI agents

1. **Verify with fresh eyes.** No AI output ships on one session's word. A second session with no prior context reviews it, and a person makes the call. *Why: the author's tests share the author's blind spots.*
2. **Spec first, small pieces.** Write the spec and plan before work starts, clear enough for an agent to execute and a reviewer to check. Split the work into small tasks with acceptance criteria. *Why: a reviewer can only check work against a stated goal.*
3. **Turn every miss into a rule.** Record what failed and what worked in the instructions and checklists that the next session starts from. *Why: a fresh session only knows what is written down.*

Each rule came out of this project. The blank-context review caught the tenant gap. The sandbox plans were reviewed and revised before any code. After the runtime-not-marketplace decision, the project instructions were updated so later sessions would not build toward the old goal.
