# Putting the model in the loop: what a composite MCP tool costs in tokens

*[countinghouse](https://github.com/mchen6/countinghouse): a runtime where MCP tools call other MCP tools. Apache-2.0. A companion to [One call instead of eighteen](https://mchen6.github.io/countinghouse/performance/). That post measured latency and bytes with a script as the client. This one puts a model in the loop and measures what you pay for.*

The latency post ended on a caveat: bytes on the wire are not tokens in a
context window. So I ran the same task with a model as the client and
counted tokens, dollars, and where the data went.

Every number here comes from `perf/token-cost-compare.js` driving `claude -p`
(Claude Code 2.1.318, `claude-sonnet-5-5` in every run) at commit `622438f`,
three runs per cell. A cell is the median of its runs, and the range in
brackets is the lowest and highest of them. **A difference counts only when
the two ranges don't overlap**, and "within noise" otherwise. The script
prints every comparison word from those numbers. The full write-up is
[docs/benchmarks/token-cost.md](https://github.com/mchen6/countinghouse/blob/master/docs/benchmarks/token-cost.md),
and all 46 transcripts are in the repo
([report](https://github.com/mchen6/countinghouse/blob/master/perf/results/2026-11-05/token/report.md)).

## The task, four ways

[`examples/log-triage`](https://github.com/mchen6/countinghouse/tree/master/examples/log-triage)
triages a directory of logs: count the warnings and errors, cluster similar
messages, and redact personal data before clustering. The model got the same
prompt every time, and one of four setups:

- **leaf chaining**: the four inner tools (`list`, `read`, `redact`,
  `cluster`) as MCP tools, chained by the model;
- **composite**: one tool that does all of it inside the runtime;
- **code mode, typed**: no MCP tools; a generated Node library over the four
  inner tools, with types for inputs and outputs, which the model scripts
  against (the approach Anthropic describes as "code execution with MCP");
- **code mode, untyped**: the same library with output types removed, like an
  MCP server that publishes no `outputSchema`.

The logs are synthetic: seeded templates with fake personal data planted in
them (test card numbers, `example.com` addresses, documentation-range IPs).
They were generated inside a container with a seed nobody recorded, so the
model could reach them only through the tools.

## Privacy first

Of the 10 planted values, how many reached the model's context:

| | in the model's context | in its final answer |
|---|---|---|
| leaf chaining | all 10, in every run | in 2 of 3 runs at 8 files × 400 lines |
| composite | none, in every run | none |
| code mode, typed | none, in 12 of 12 runs | none |
| code mode, untyped | in 6 of 9 runs (3 of 3 at each of the two larger sizes; at 2 × 100 the lines it sampled held none) | in 1 of 3 runs at 8 × 400 |

Leaf chaining has to pass every raw line through the model, because `read`
returns raw lines and `redact` needs them back. That's the design, not a
mistake by the model. The composite never returns raw lines. Typed code mode
kept them inside its scripts too.

The untyped variant is the interesting one. Without output types, the model
learned each result's shape by printing it: `Object.keys(r)` and a slice of
a `read()` result, raw lines included, in 9 of 9 runs. In one run it also
guessed a field that doesn't exist. The same model with the types never did
either.

## Cost

Median cost per run in USD (all valid runs):

| | 2 files × 100 lines | 8 × 100 | 8 × 400 |
|---|---|---|---|
| composite | 0.024 [0.023–0.024] | 0.026 [0.026–0.027] | 0.026 [0.026–0.027] |
| code mode, typed | 0.042 [0.040–0.045] | 0.041 [0.040–0.042] | 0.039 [0.038–0.041] |
| code mode, untyped | 0.046 [0.037–0.056] | 0.044 [0.038–0.046] | 0.045 [0.044–0.092] |
| leaf chaining | 0.140 [0.140–0.151] | 0.523 [0.519–0.532] | 2.124 [0.649–2.132] |

Leaf chaining costs 5.95×, 19.77× and 81.06× the composite at the three
sizes, and the gap grows with the data. The composite stays flat.

Typed code mode is close to the composite: 1.77×, 1.54× and 1.47× its cost,
also flat. I don't want to overstate the composite here. The ranges don't
overlap, so the difference is real, but it's a factor of 1.5–1.8, not
6–81: code mode with good types gets most of the way. Untyped code mode is
within noise of typed at the two smaller sizes, and 1.18× at 8 × 400, where
the ranges don't overlap.

Where leaf chaining's money goes, using per-token prices I **inferred** from
the runs' own cost totals (an exact fit, not a published price list): at
8 × 400, the median run's $2.12 is $1.13 output, $0.77 cache writes and
$0.22 cache reads.
97% of its output tokens are in the responses that call `redact` or
`cluster`, which is the model typing the log lines back out as tool
arguments, about 217 KB per run. The fixed cost of a turn is small: a
"Reply with OK." run in the composite's configuration costs $0.009.

## What this doesn't show

Each of these would flatter the result if I left it out:

- **One model, one task, synthetic logs, three runs per cell.** A different
  model, a task with less data movement, or real logs could all move these
  numbers.
- **The prices are inferred**, from what the runs reported they cost.
- **I tuned code mode's setup and nothing else.** With the user prompt
  alone, the model never found the library. Code mode got a short
  appended system prompt, iterated three times on small checks. The leaf
  and composite prompts were never tuned. All three versions are in the
  write-up.
- **One leaf-chaining run quit early.** At 8 × 400, one run stopped after a
  single file, saying it wanted "to stay inside the $5 budget": the safety
  cap I set per run was visible to the model. That run is in the
  "all valid runs" table and sets its lower bound. Without it the median is
  $2.128 and the ratio 81.23×. No verdict changes.
- **A later batch and an outlier.** Untyped code mode at 2 × 100 and 8 × 400
  ran after the main matrix, under different prompt-cache conditions, with
  fresh typed runs alongside as a check (they matched the matrix). One of
  those runs costs $0.092 and sets that cell's upper range, not its median.
- **Measured before a protocol fix.** At `622438f`, countinghouse wrapped
  tool results one level too deep (`{"output": …}`), which the official MCP
  SDK client rejects and Claude Code doesn't check. I counted what it cost
  in these runs: at most 0.07% of any group's tokens, and nothing in code
  mode. None of the conclusions depend on it, because the code-mode wrappers
  stripped it; with the fix, the advertised types now match the results
  directly. The fix has since landed.

## Reproduce it

Everything is in the repo: `perf/token-cost-compare.js` (run, report and
scrub subcommands), `perf/gen-code-mode-wrappers.js` (the code-mode library,
generated from the live `tools/list`), and the container setup used,
under `perf/results/2026-11-05/token/setup/`. You need Docker, Claude Code,
and about $10 for the full matrix. The method, the isolation and every
caveat are in
[docs/benchmarks/token-cost.md](https://github.com/mchen6/countinghouse/blob/master/docs/benchmarks/token-cost.md).
